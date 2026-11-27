/**
 * Procedural WebAudio only; no files, fetches, timers, or audio at import time.
 * Exports createAudio({ eventTarget?, bindKeys? }?). Its API:
 * unlock() -> Promise<boolean>, update({ throttle, airspeedKnots, stalled?, active? }),
 * ring(), touchdown(severity=0.5), damage(severity=1), stall(active=true),
 * delivered(), mute(value?) -> muted boolean, isMuted(), isUnlocked(), dispose().
 * Severity and throttle are 0..1. update() caches state even before unlock;
 * active:false quiets flight loops for menus/pause. Early one-shots are discarded.
 * By default pointer/key gestures unlock audio and M toggles mute (repeat ignored).
 * Input's poll().mute is then informational: do not also toggle in the game loop.
 * Set bindKeys:false to own M handling; unlock still runs on gestures. Call
 * unlock() synchronously from a gesture if eventTarget is null. It reports failure
 * via false and the error getter, and retries on the next gesture. Every API is
 * safe before unlock, after dispose, or when WebAudio is unavailable.
 */
import { AUDIO, CONTROLS, FLIGHT } from './config.js';

const clamp01 = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Create a gain node with an initial value and optional connection. */
function createGainNode(ctx, initialGain, destination = null) {
  const node = ctx.createGain();
  node.gain.value = initialGain;
  if (destination) node.connect(destination);
  return node;
}

/** Create an oscillator node with a type, frequency and optional connection. */
function createOscillatorNode(ctx, type, frequency, destination = null) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = frequency;
  if (destination) osc.connect(destination);
  return osc;
}

/** Create an attack-decay gain envelope for a scheduled one-shot voice. */
function createVoiceEnvelope(ctx, { start, attackSeconds, end, peakGain, floorGain = AUDIO.envelopeFloor, destination = null }) {
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, ctx.currentTime);
  envelope.gain.setValueAtTime(floorGain, start);
  envelope.gain.linearRampToValueAtTime(peakGain, start + attackSeconds);
  envelope.gain.exponentialRampToValueAtTime(floorGain, end);
  if (destination) envelope.connect(destination);
  return envelope;
}

/** Build a pitch-ramped oscillator source connected to an envelope. */
function createTonedVoiceSource(ctx, { type = 'sine', hz, endHz = hz, start, end, destination }) {
  const source = ctx.createOscillator();
  source.type = type;
  source.frequency.setValueAtTime(hz, start);
  source.frequency.exponentialRampToValueAtTime(endHz, end);
  source.connect(destination);
  return { source, nodes: [source] };
}

/** Build a lowpass-filtered noise buffer source connected to an envelope. */
function createFilteredNoiseVoiceSource(ctx, buffer, { lowpassHz, destination }) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpassHz;
  filter.Q.value = 0;
  source.connect(filter);
  filter.connect(destination);
  return { source, nodes: [source, filter] };
}

export function createAudio({ eventTarget = globalThis.window, bindKeys = true } = {}) {
  let context = null;
  let graph = null;
  let muted = false;
  let disposed = false;
  let error = null;
  let flight = { throttle: 0, airspeedKnots: 0, stalled: false, active: false };
  const voices = new Set();

  function buildGraph(ctx) {
    const master = ctx.createGain();
    master.gain.value = muted ? 0 : AUDIO.masterVolume;
    const compressor = ctx.createDynamicsCompressor();
    const settings = AUDIO.compressor;
    compressor.threshold.value = settings.thresholdDb;
    compressor.knee.value = settings.kneeDb;
    compressor.ratio.value = settings.ratio;
    compressor.attack.value = settings.attackSeconds;
    compressor.release.value = settings.releaseSeconds;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(AUDIO.clipCurveSamples);
    for (let i = 0; i < curve.length; i++) {
      const x = 2 * i / (curve.length - 1) - 1;
      curve[i] = AUDIO.clipCeiling * Math.tanh(x / AUDIO.clipCeiling);
    }
    clip.curve = curve;
    clip.oversample = '2x';
    master.connect(compressor);
    compressor.connect(clip);
    clip.connect(ctx.destination);

    // Seeded texture is repeatable and generated once; never regenerate per frame.
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * AUDIO.noiseSeconds), ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    let seed = AUDIO.noiseSeed;
    let mean = 0;
    for (let i = 0; i < samples.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      samples[i] = (seed >>> 0) / 4294967296 * 2 - 1;
      mean += samples[i];
    }
    mean /= samples.length;
    for (let i = 0; i < samples.length; i++) samples[i] -= mean;

    const engineGain = createGainNode(ctx, 0, master);
    const harmonicGain = createGainNode(ctx, AUDIO.engine.harmonicGain, engineGain);
    const engine = createOscillatorNode(ctx, 'sine', AUDIO.engine.idleHz, engineGain);
    const harmonic = createOscillatorNode(ctx, 'triangle', AUDIO.engine.idleHz * AUDIO.engine.harmonicRatio, harmonicGain);

    const wind = ctx.createBufferSource();
    wind.buffer = buffer;
    wind.loop = true;
    const windHighpass = ctx.createBiquadFilter();
    windHighpass.type = 'highpass';
    windHighpass.frequency.value = AUDIO.wind.highpassHz;
    windHighpass.Q.value = 0;
    const windLowpass = ctx.createBiquadFilter();
    windLowpass.type = 'lowpass';
    windLowpass.frequency.value = AUDIO.wind.idleLowpassHz;
    windLowpass.Q.value = 0;
    const windGain = createGainNode(ctx, 0, master);
    wind.connect(windHighpass);
    windHighpass.connect(windLowpass);
    windLowpass.connect(windGain);

    const warningGain = createGainNode(ctx, 0, master);
    const warning = createOscillatorNode(ctx, 'sine', AUDIO.stall.frequencyHz, warningGain);
    const warbleDepth = createGainNode(ctx, AUDIO.stall.warbleDepthHz, warning.frequency);
    const warble = createOscillatorNode(ctx, 'sine', AUDIO.stall.warbleHz, warbleDepth);

    const sources = [engine, harmonic, wind, warning, warble];
    const nodes = [...sources, master, compressor, clip, harmonicGain, engineGain,
      windHighpass, windLowpass, windGain, warbleDepth, warningGain];
    const now = ctx.currentTime;
    for (const source of sources) source.start(now);
    return { master, buffer, engine, harmonic, engineGain, windLowpass, windGain,
      warningGain, sources, nodes };
  }

  function smooth(parameter, value, seconds = AUDIO.smoothingSeconds) {
    if (!context || context.state === 'closed') return;
    const now = context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const current = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(current, now);
    }
    parameter.setTargetAtTime(value, now, seconds);
  }

  function applyFlight() {
    if (!graph || disposed) return;
    const speed = clamp01(flight.airspeedKnots / FLIGHT.maxSpeedKnots);
    const power = flight.throttle;
    const hz = AUDIO.engine.idleHz + power * AUDIO.engine.throttleHz + speed * AUDIO.engine.speedHz;
    smooth(graph.engine.frequency, hz);
    smooth(graph.harmonic.frequency, hz * AUDIO.engine.harmonicRatio);
    smooth(graph.engineGain.gain, flight.active ?
      AUDIO.engine.idleGain + power * AUDIO.engine.throttleGain + speed * AUDIO.engine.speedGain : 0);
    smooth(graph.windLowpass.frequency, AUDIO.wind.idleLowpassHz + speed * AUDIO.wind.speedLowpassHz);
    smooth(graph.windGain.gain, flight.active ? speed * speed * AUDIO.wind.maxGain : 0);
    smooth(graph.warningGain.gain, flight.active && flight.stalled ? AUDIO.stall.gain : 0);
  }

  async function unlock() {
    if (disposed) return false;
    try {
      if (!context) {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) {
          error = 'WebAudio is unavailable in this browser.';
          return false;
        }
        // Both creation and resume happen before yielding the user's gesture.
        context = new Context({ latencyHint: 'interactive' });
        graph = buildGraph(context);
        applyFlight();
      }
      if (context.state !== 'running') await context.resume();
      error = context.state === 'running' ? null : 'Audio is suspended; another gesture will retry.';
      return context.state === 'running';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      // A partially built graph must not become the permanent silent "success".
      if (!graph && context) {
        const failed = context;
        context = null;
        try { await failed.close(); } catch { /* Already closed or unsupported. */ }
      }
      return false;
    }
  }

  function update({ throttle = 0, airspeedKnots = 0, stalled = false, active = true } = {}) {
    flight = {
      throttle: clamp01(throttle),
      airspeedKnots: Number.isFinite(airspeedKnots) ? Math.max(0, airspeedKnots) : 0,
      stalled: Boolean(stalled),
      active: Boolean(active),
    };
    applyFlight();
  }

  function canPlay() {
    return !disposed && !muted && graph && context?.state === 'running';
  }

  function releaseVoice(voice) {
    voices.delete(voice);
    for (const node of voice.nodes) node.disconnect();
  }

  function reclaimExpiredVoices() {
    // End times reclaim voices even when onended is delayed by a busy main thread.
    for (const voice of voices) {
      if (voice.end <= context.currentTime) releaseVoice(voice);
    }
  }

  function playVoice({ hz, endHz = hz, duration, attackSeconds, gain, at = 0, noiseHz = null }) {
    if (!canPlay()) return;
    reclaimExpiredVoices();
    if (voices.size >= AUDIO.maxEffectVoices) return;
    const start = context.currentTime + at;
    const end = start + duration;
    const envelope = createVoiceEnvelope(context, {
      start,
      attackSeconds,
      end,
      peakGain: gain,
      destination: graph.master,
    });
    const sound = noiseHz === null
      ? createTonedVoiceSource(context, { hz, endHz, start, end, destination: envelope })
      : createFilteredNoiseVoiceSource(context, graph.buffer, { lowpassHz: noiseHz, destination: envelope });
    const nodes = [...sound.nodes, envelope];
    const voice = { source: sound.source, nodes, end };
    voices.add(voice);
    sound.source.onended = () => releaseVoice(voice);
    sound.source.start(start);
    sound.source.stop(end);
  }

  function melody(cue) {
    if (!canPlay()) return;
    for (const note of cue.notes) {
      playVoice({ ...note, attackSeconds: cue.attackSeconds, gain: cue.gain });
    }
  }

  function impact(cue, severity) {
    const strength = clamp01(severity);
    if (!strength || !canPlay()) return;
    playVoice({ ...cue, noiseHz: null, gain: cue.gain * strength });
    playVoice({ ...cue, noiseHz: cue.noiseHz, gain: cue.noiseGain * strength });
  }

  function stall(active = true) {
    flight.stalled = Boolean(active);
    applyFlight();
  }

  function mute(value) {
    muted = typeof value === 'boolean' ? value : !muted;
    if (graph && !disposed) {
      smooth(graph.master.gain, muted ? 0 : AUDIO.masterVolume, AUDIO.muteFadeSeconds);
    }
    return muted;
  }

  function gesture() { void unlock(); }

  function keyDown(event) {
    if (event.repeat || event.isComposing || event.target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    if (bindKeys && CONTROLS.mute.includes(event.code)) {
      event.preventDefault();
      mute();
    }
    gesture();
  }

  eventTarget?.addEventListener('pointerdown', gesture);
  eventTarget?.addEventListener('keydown', keyDown);

  async function dispose() {
    if (disposed) return;
    disposed = true;
    eventTarget?.removeEventListener('pointerdown', gesture);
    eventTarget?.removeEventListener('keydown', keyDown);
    for (const voice of voices) {
      voice.source.onended = null;
      try { voice.source.stop(); } catch { /* It may already have ended. */ }
      releaseVoice(voice);
    }
    if (graph) {
      for (const source of graph.sources) {
        try { source.stop(); } catch { /* It may already have stopped. */ }
      }
      for (const node of graph.nodes) node.disconnect();
      graph = null;
    }
    if (context) {
      try { await context.close(); } catch { /* Already closed. */ }
      context = null;
    }
  }

  function comboChime(level = 1) {
    if (!canPlay()) return;
    const semitones = Math.min(12, (level - 1) * 2);
    const pitchFactor = 2 ** (semitones / 12);
    const notes = [
      { hz: 587.33 * pitchFactor, at: 0, duration: 0.18 },
      { hz: 880.00 * pitchFactor, at: 0.07, duration: 0.22 },
      { hz: 1174.66 * pitchFactor, at: 0.14, duration: 0.28 },
    ];
    for (const note of notes) {
      playVoice({ ...note, attackSeconds: 0.01, gain: 0.11 });
    }
  }

  function upgradePurchased() {
    if (!canPlay()) return;
    playVoice({ hz: 440, endHz: 660, at: 0, duration: 0.15, attackSeconds: 0.008, gain: 0.14 });
    playVoice({ hz: 880, at: 0.12, duration: 0.25, attackSeconds: 0.01, gain: 0.16 });
  }

  function thunderRumble() {
    if (!canPlay()) return;
    playVoice({ hz: 65, endHz: 32, duration: 1.4, attackSeconds: 0.05, gain: 0.16, noiseHz: 220 });
  }

  function windGust(intensity = 0.5) {
    if (!canPlay()) return;
    const gain = clamp01(intensity) * 0.12;
    playVoice({ hz: 120, endHz: 80, duration: 0.8, attackSeconds: 0.2, gain, noiseHz: 600 });
  }

  function gearToggle(down = true) {
    if (!canPlay()) return;
    playVoice({ hz: down ? 180 : 260, endHz: down ? 90 : 180, duration: 0.14, attackSeconds: 0.005, gain: 0.12, noiseHz: 400 });
  }

  return Object.freeze({
    unlock, update,
    ring: () => melody(AUDIO.ring),
    comboChime,
    upgradePurchased,
    thunderRumble,
    windGust,
    gearToggle,
    touchdown: (severity = 0.5) => impact(AUDIO.touchdown, severity),
    damage: (severity = 1) => impact(AUDIO.damage, severity),
    stall,
    delivered: () => melody(AUDIO.delivered),
    mute,
    isMuted: () => muted,
    isUnlocked: () => !disposed && context?.state === 'running',
    get error() { return error; },
    dispose,
  });
}
