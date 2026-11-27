/**
 * Valley Mail aircraft progression and hangar upgrade system.
 * Pure logic and storage: persistent upgrades, credits balance, and sortie unlocks.
 *
 * Exports:
 *   UPGRADE_DEFINITIONS — table of aircraft modifications with stats and costs.
 *   PROGRESSION_STORAGE_KEY — localStorage key for progression persistence.
 *   createProgressionState() — returns default progression state.
 *   loadProgression(storageKey) — reads state from localStorage with fallback.
 *   saveProgression(state, storageKey) — serializes state to localStorage.
 *   purchaseUpgrade(state, upgradeId) — unlocks an upgrade if affordable.
 *   isUpgradeEquipped(state, upgradeId) — checks if an upgrade is active.
 *   applyProgressionToPlane(plane, state) — applies upgrade modifiers to aircraft.
 *   calculateSortieEarnings(scoreCard, sortie, streak) — calculates credit reward.
 *   unlockNextSortie(state, currentSortieId) — advances campaign progression.
 */
import { FUEL, DAMAGE, FLIGHT, SCORING } from './config.js';

export const PROGRESSION_STORAGE_KEY = 'valley-mail.progression.v1';

export const UPGRADE_DEFINITIONS = Object.freeze([
  {
    id: 'engine_tune',
    name: 'Supercharged Carburetor',
    category: 'Powertrain',
    cost: 1500,
    description: 'Increases engine power and cruise airspeed by 15 knots for tighter flight schedules.',
    stats: { speedKnotsBonus: 15, accelerationBonus: 8 },
  },
  {
    id: 'extended_tank',
    name: 'Auxiliary Fuel Tanks',
    category: 'Endurance',
    cost: 1200,
    description: 'Expands fuel capacity by 35% and reduces high-throttle consumption rate.',
    stats: { fuelCapacityMult: 1.35, burnRateMult: 0.88 },
  },
  {
    id: 'reinforced_airframe',
    name: 'Reinforced Bush Airframe',
    category: 'Durability',
    cost: 1800,
    description: 'Gusseted aluminum spars withstand rough backcountry landings and terrain scrapes.',
    stats: { hullBonus: 35, scrapeDamageMult: 0.60 },
  },
  {
    id: 'stol_flaps',
    name: 'High-Lift STOL Flaps',
    category: 'Aerodynamics',
    cost: 1400,
    description: 'Reduces stall speed by 8 knots and improves low-speed climb authority for canyon flying.',
    stats: { stallSpeedReductionKnots: 8, climbRateBonus: 2.5 },
  },
  {
    id: 'all_weather_avionics',
    name: 'All-Weather Gyroscope',
    category: 'Avionics',
    cost: 2000,
    description: 'Precision attitude gyro and heated pitot tube resist turbulence and crosswind drift.',
    stats: { windResistanceMult: 0.55, gyroPrecision: true },
  },
  {
    id: 'cargo_winch',
    name: 'Stabilized Cargo Winch',
    category: 'Equipment',
    cost: 1600,
    description: 'Aerodynamic parcel cradle increases delivery drop accuracy and awards +25% cargo bonus.',
    stats: { dropRadiusMult: 1.40, cargoScoreBonusMult: 1.25 },
  },
]);

export function createProgressionState() {
  return {
    credits: 0,
    unlockedSortieIds: [1],
    purchasedUpgrades: [],
    lifetimeStats: {
      sortiesFlown: 0,
      sortiesDelivered: 0,
      totalRingsThreaded: 0,
      totalParcelsDelivered: 0,
      bestStreak: 0,
    },
  };
}

export function loadProgression(storageKey = PROGRESSION_STORAGE_KEY) {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return createProgressionState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createProgressionState();
    return {
      credits: Math.max(0, Number(parsed.credits) || 0),
      unlockedSortieIds: Array.isArray(parsed.unlockedSortieIds) && parsed.unlockedSortieIds.length > 0
        ? parsed.unlockedSortieIds
        : [1],
      purchasedUpgrades: Array.isArray(parsed.purchasedUpgrades)
        ? parsed.purchasedUpgrades.filter(id => UPGRADE_DEFINITIONS.some(u => u.id === id))
        : [],
      lifetimeStats: {
        sortiesFlown: Number(parsed.lifetimeStats?.sortiesFlown) || 0,
        sortiesDelivered: Number(parsed.lifetimeStats?.sortiesDelivered) || 0,
        totalRingsThreaded: Number(parsed.lifetimeStats?.totalRingsThreaded) || 0,
        totalParcelsDelivered: Number(parsed.lifetimeStats?.totalParcelsDelivered) || 0,
        bestStreak: Number(parsed.lifetimeStats?.bestStreak) || 0,
      },
    };
  } catch {
    return createProgressionState();
  }
}

export function saveProgression(state, storageKey = PROGRESSION_STORAGE_KEY) {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function isUpgradeEquipped(state, upgradeId) {
  return state?.purchasedUpgrades?.includes(upgradeId) ?? false;
}

export function purchaseUpgrade(state, upgradeId) {
  const upgrade = UPGRADE_DEFINITIONS.find(u => u.id === upgradeId);
  if (!upgrade) return { success: false, reason: 'Unknown upgrade' };
  if (state.purchasedUpgrades.includes(upgradeId)) return { success: false, reason: 'Already purchased' };
  if (state.credits < upgrade.cost) return { success: false, reason: 'Insufficient credits' };

  state.credits -= upgrade.cost;
  state.purchasedUpgrades.push(upgradeId);
  saveProgression(state);
  return { success: true, upgrade };
}

export function applyProgressionToPlane(plane, state) {
  if (!plane || !state) return plane;

  if (isUpgradeEquipped(state, 'engine_tune')) {
    plane._maxSpeedKnots = FLIGHT.maxSpeedKnots + 15;
    plane._accelerationKnots = FLIGHT.accelerationKnotsPerSecond + 8;
  }
  if (isUpgradeEquipped(state, 'extended_tank')) {
    plane._fuelCapacity = FUEL.capacity * 1.35;
    plane.fuel = Math.min(plane.fuel * 1.35, plane._fuelCapacity);
  }
  if (isUpgradeEquipped(state, 'reinforced_airframe')) {
    plane._maxHull = DAMAGE.maxHull + 35;
    plane.hull = plane._maxHull;
  }
  if (isUpgradeEquipped(state, 'stol_flaps')) {
    plane._stallSpeedKnots = Math.max(25, FLIGHT.stallSpeedKnots - 8);
    plane._maxClimbRate = FLIGHT.maxClimbMetersPerSecond + 2.5;
  }
  if (isUpgradeEquipped(state, 'all_weather_avionics')) {
    plane._windResistanceMult = 0.55;
  }
  if (isUpgradeEquipped(state, 'cargo_winch')) {
    plane._cargoDropBonusMult = 1.25;
  }
  return plane;
}

export function calculateSortieEarnings(scoreCard, sortie, streak = 0) {
  if (!scoreCard) return 0;
  const outcome = String(scoreCard.outcome ?? '').toLowerCase();
  const delivered = outcome.includes('delivered') || outcome.includes('success');
  if (!delivered) return Math.min(200, Math.floor((scoreCard.totalScore ?? scoreCard.score ?? 0) / 20));

  const basePay = (sortie?.id ?? 1) === 'free' ? 300 : 800 + (Number(sortie?.id) || 1) * 200;
  const gradeBonus = scoreCard.grade === 'S' ? 800 : scoreCard.grade === 'A' ? 500 : scoreCard.grade === 'B' ? 300 : 100;
  const streakBonus = Math.min(1000, (streak || 0) * 150);
  const scoreShare = Math.floor((scoreCard.totalScore ?? scoreCard.score ?? 0) / 10);
  return basePay + gradeBonus + streakBonus + scoreShare;
}

export function unlockNextSortie(state, currentSortieId) {
  const currentNum = Number(currentSortieId);
  if (!Number.isFinite(currentNum)) return false;
  const nextId = currentNum + 1;
  if (!state.unlockedSortieIds.includes(nextId)) {
    state.unlockedSortieIds.push(nextId);
    saveProgression(state);
    return true;
  }
  return false;
}
