/**
 * Valley Mail atmospheric weather system and wind simulation.
 * Pure logic and canvas rendering layer for rain, wind gusts, mist, and lighting.
 *
 * Exports:
 *   WEATHER_PRESETS — definitions for clear, breeze, storm, and dusk_mist weather.
 *   createWeatherSystem(presetId, seed) — constructs weather simulation state.
 *   stepWeather(weather, plane, dt) — updates crosswinds, gust timers, and rain particles.
 *   getWindDrift(weather, position) — calculates instantaneous wind vector { x, y, z }.
 *   drawWeatherLayer(ctx, weather, camera, palette) — renders rain, mist, and lightning.
 */
import { UNITS } from './config.js';

export const WEATHER_PRESETS = Object.freeze({
  clear: {
    id: 'clear',
    name: 'Clear Morning',
    windSpeedKnots: 2,
    windHeadingDegrees: 45,
    gustIntensity: 0.1,
    rainCount: 0,
    mistDensity: 0.05,
    lightning: false,
    skyTint: null,
  },
  breeze: {
    id: 'breeze',
    name: 'Valley Breeze',
    windSpeedKnots: 8,
    windHeadingDegrees: 90,
    gustIntensity: 0.35,
    rainCount: 0,
    mistDensity: 0.15,
    lightning: false,
    skyTint: null,
  },
  storm: {
    id: 'storm',
    name: 'Alpine Squall',
    windSpeedKnots: 18,
    windHeadingDegrees: 115,
    gustIntensity: 0.75,
    rainCount: 160,
    mistDensity: 0.45,
    lightning: true,
    skyTint: '#1c2234',
  },
  dusk_mist: {
    id: 'dusk_mist',
    name: 'Twilight Mist',
    windSpeedKnots: 4,
    windHeadingDegrees: 30,
    gustIntensity: 0.15,
    rainCount: 0,
    mistDensity: 0.35,
    lightning: false,
    skyTint: null,
  },
});

export function createWeatherSystem(presetId = 'clear', seed = 12345) {
  const preset = WEATHER_PRESETS[presetId] ?? WEATHER_PRESETS.clear;
  const rain = [];
  for (let i = 0; i < preset.rainCount; i++) {
    rain.push({
      x: ((seed * (i + 1) * 9301 + 49297) % 233280) / 233280 * 1280,
      y: ((seed * (i + 1) * 7829 + 1387) % 233280) / 233280 * 720,
      speed: 850 + ((i * 37) % 300),
      length: 18 + ((i * 13) % 16),
      alpha: 0.35 + ((i * 19) % 30) / 100,
    });
  }

  return {
    preset,
    windBaseKnots: preset.windSpeedKnots,
    windHeading: preset.windHeadingDegrees,
    gustStrength: 0,
    gustTimer: 0,
    gustInterval: 6.0,
    lightningTimer: preset.lightning ? 4.0 : -1,
    lightningFlash: 0,
    rainParticles: rain,
    elapsedSeconds: 0,
  };
}

export function getWindDrift(weather) {
  if (!weather || weather.windBaseKnots <= 0) return { x: 0, y: 0, z: 0 };
  const speedKnots = weather.windBaseKnots + weather.gustStrength;
  const speedMps = speedKnots * UNITS.knotsToMetersPerSecond;
  const rad = weather.windHeading * UNITS.degreesToRadians;
  return {
    x: Math.sin(rad) * speedMps,
    y: 0,
    z: Math.cos(rad) * speedMps,
  };
}

export function stepWeather(weather, plane, dt) {
  if (!weather || dt <= 0) return;
  weather.elapsedSeconds += dt;

  // Gust cycle
  weather.gustTimer += dt;
  if (weather.gustTimer >= weather.gustInterval) {
    weather.gustTimer = 0;
    weather.gustStrength = (Math.sin(weather.elapsedSeconds * 1.5) * 0.5 + 0.5) *
      weather.preset.windSpeedKnots * weather.preset.gustIntensity;
  }

  // Crosswind effect on aircraft heading drift
  if (plane && !plane.onGround && weather.windBaseKnots > 4) {
    const wind = getWindDrift(weather);
    const planeRad = plane.heading * UNITS.degreesToRadians;
    const crosswind = -Math.sin(planeRad) * wind.z + Math.cos(planeRad) * wind.x;
    const resistance = plane._windResistanceMult ?? 1.0;
    plane.position.x += crosswind * dt * 0.15 * resistance;
  }

  // Rain particle simulation
  for (const p of weather.rainParticles) {
    p.y += p.speed * dt;
    p.x += (weather.windBaseKnots * 4) * dt;
    if (p.y > 720) {
      p.y = -p.length;
      p.x = Math.random() * 1280;
    }
    if (p.x > 1280) p.x = 0;
  }

  // Lightning
  if (weather.lightningTimer >= 0) {
    weather.lightningTimer -= dt;
    if (weather.lightningTimer <= 0) {
      weather.lightningFlash = 0.85;
      weather.lightningTimer = 5.0 + Math.random() * 8.0;
    }
  }
  if (weather.lightningFlash > 0) {
    weather.lightningFlash = Math.max(0, weather.lightningFlash - dt * 2.5);
  }
}

export function drawWeatherLayer(ctx, weather, camera) {
  if (!weather) return;

  // Lightning sky flash
  if (weather.lightningFlash > 0) {
    ctx.save();
    ctx.globalAlpha = weather.lightningFlash * 0.45;
    ctx.fillStyle = '#eaf5ff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  // Rain streaks
  if (weather.rainParticles.length > 0) {
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(215, 230, 255, 0.45)';
    ctx.beginPath();
    const slant = (weather.windBaseKnots * 0.8);
    for (const p of weather.rainParticles) {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + slant, p.y + p.length);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Low mist band over the river
  if (weather.preset.mistDensity > 0.1) {
    ctx.save();
    const mistY = ctx.canvas.height * 0.46;
    const mistGrad = ctx.createLinearGradient(0, mistY - 35, 0, mistY + 60);
    mistGrad.addColorStop(0, 'rgba(205, 222, 225, 0)');
    mistGrad.addColorStop(0.5, `rgba(205, 225, 230, ${weather.preset.mistDensity * 0.45})`);
    mistGrad.addColorStop(1, 'rgba(205, 222, 225, 0)');
    ctx.fillStyle = mistGrad;
    ctx.fillRect(0, mistY - 35, ctx.canvas.width, 95);
    ctx.restore();
  }
}
