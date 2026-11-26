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

    const engine = ctx.createOscillator();
    engine.type = 'sine';
    engine.frequency.value = AUDIO.engine.idleHz;
    const harmonic = ctx.createOscillator();
    harmonic.type = 'triangle';
    harmonic.frequency.value = AUDIO.engine.idleHz * AUDIO.engine.harmonicRatio;
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = AUDIO.engine.harmonicGain;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engine.connect(engineGain);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(engineGain);
    engineGain.connect(master);

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
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windHighpass);
    windHighpass.connect(windLowpass);
    windLowpass.connect(windGain);
    windGain.connect(master);

    const warning = ctx.createOscillator();
    warning.type = 'sine';
    warning.frequency.value = AUDIO.stall.frequencyHz;
    const warble = ctx.createOscillator();
    warble.type = 'sine';
    warble.frequency.value = AUDIO.stall.warbleHz;
    const warbleDepth = ctx.createGain();
    warbleDepth.gain.value = AUDIO.stall.warbleDepthHz;
    const warningGain = ctx.createGain();
    warningGain.gain.value = 0;
    warble.connect(warbleDepth);
    warbleDepth.connect(warning.frequency);
    warning.connect(warningGain);
    warningGain.connect(master);

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

  function playVoice({ hz, endHz = hz, duration, attackSeconds, gain, at = 0, noiseHz = null }) {
    if (!canPlay()) return;
    // End times reclaim voices even when onended is delayed by a busy main thread.
    for (const voice of voices) {
      if (voice.end <= context.currentTime) releaseVoice(voice);
    }
    if (voices.size >= AUDIO.maxEffectVoices) return;
    const source = noiseHz === null ? context.createOscillator() : context.createBufferSource();
    const envelope = context.createGain();
    const start = context.currentTime + at;
    const end = start + duration;
    const nodes = [source, envelope];
    if (noiseHz === null) {
      source.type = 'sine';
      source.frequency.setValueAtTime(hz, start);
      source.frequency.exponentialRampToValueAtTime(endHz, end);
      source.connect(envelope);
    } else {
      source.buffer = graph.buffer;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = noiseHz;
      filter.Q.value = 0;
      source.connect(filter);
      filter.connect(envelope);
      nodes.push(filter);
    }
    envelope.gain.setValueAtTime(0, context.currentTime);
    envelope.gain.setValueAtTime(AUDIO.envelopeFloor, start);
    envelope.gain.linearRampToValueAtTime(gain, start + attackSeconds);
    envelope.gain.exponentialRampToValueAtTime(AUDIO.envelopeFloor, end);
    envelope.connect(graph.master);
    const voice = { source, nodes, end };
    voices.add(voice);
    source.onended = () => releaseVoice(voice);
    source.start(start);
    source.stop(end);
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

  return Object.freeze({
    unlock, update,
    ring: () => melody(AUDIO.ring),
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
