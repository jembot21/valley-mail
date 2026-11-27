/**
 * Valley Mail scoring rules, letter grade evaluation, and delivery combo streaks.
 * Pure logic: calculates score breakdown, combo multipliers, and mission performance grades.
 *
 * Exports:
 *   GRADE_TIERS — definition table for letter ranks S, A, B, C, D.
 *   COMBO_STREAK_TIERS — multiplier ladder for chained ring crossings.
 *   createComboTracker() — initializes live combo streak state.
 *   registerRingHit(tracker, ringIndex) — increments streak and returns multiplier.
 *   stepComboTracker(tracker, dt) — updates combo decay timer.
 *   calculateComboBonus(tracker, baseBonus) — calculates score with combo multiplier.
 *   evaluateRunGrade(run, plane, scoreCard) — computes final letter rank and performance review.
 *   formatGradeBadge(grade) — styling attributes for HUD and results display.
 */
import { SCORING } from './config.js';

export const GRADE_TIERS = Object.freeze([
  {
    grade: 'S',
    title: 'S-RANK ACE',
    color: '#ffd76c',
    minScore: 8000,
    requiresDelivered: true,
    maxHullDamage: 15,
    summary: 'Flawless navigation, pristine airframe, and butter-smooth landing.',
  },
  {
    grade: 'A',
    title: 'A-RANK PILOT',
    color: '#84e1b8',
    minScore: 6000,
    requiresDelivered: true,
    maxHullDamage: 30,
    summary: 'Superior valley airmanship and punctual mail arrival.',
  },
  {
    grade: 'B',
    title: 'B-RANK COURIER',
    color: '#7bc8e2',
    minScore: 4000,
    requiresDelivered: true,
    maxHullDamage: 55,
    summary: 'Reliable backcountry delivery within operating safety limits.',
  },
  {
    grade: 'C',
    title: 'C-RANK WINGMAN',
    color: '#e2ba7b',
    minScore: 2000,
    requiresDelivered: true,
    maxHullDamage: 85,
    summary: 'Rough approach or scraped landing gear, but mail delivered.',
  },
  {
    grade: 'D',
    title: 'D-RANK SURVIVOR',
    color: '#ff8a7a',
    minScore: 0,
    requiresDelivered: false,
    maxHullDamage: 100,
    summary: 'Hull compromised or forced emergency landing outside destination.',
  },
]);

export const COMBO_STREAK_TIERS = Object.freeze([
  { minStreak: 1, multiplier: 1.0, label: '1.0x' },
  { minStreak: 2, multiplier: 1.5, label: '1.5x' },
  { minStreak: 3, multiplier: 2.0, label: '2.0x' },
  { minStreak: 5, multiplier: 2.5, label: '2.5x' },
  { minStreak: 7, multiplier: 3.0, label: '3.0x MAX' },
]);

const COMBO_WINDOW_SECONDS = 18.0;

export function createComboTracker() {
  return {
    streak: 0,
    maxStreak: 0,
    multiplier: 1.0,
    timerSeconds: 0,
    windowSeconds: COMBO_WINDOW_SECONDS,
    totalComboPoints: 0,
  };
}

export function registerRingHit(tracker) {
  tracker.streak += 1;
  tracker.maxStreak = Math.max(tracker.maxStreak, tracker.streak);
  tracker.timerSeconds = tracker.windowSeconds;

  let tier = COMBO_STREAK_TIERS[0];
  for (const t of COMBO_STREAK_TIERS) {
    if (tracker.streak >= t.minStreak) tier = t;
  }
  tracker.multiplier = tier.multiplier;
  return tracker.multiplier;
}

export function stepComboTracker(tracker, dt) {
  if (tracker.timerSeconds > 0) {
    tracker.timerSeconds = Math.max(0, tracker.timerSeconds - dt);
    if (tracker.timerSeconds === 0) {
      tracker.streak = 0;
      tracker.multiplier = 1.0;
    }
  }
  return tracker;
}

export function calculateComboBonus(tracker, baseBonus = SCORING.ringBonus) {
  const points = Math.round(baseBonus * tracker.multiplier);
  tracker.totalComboPoints += points;
  return points;
}

export function evaluateRunGrade(run, plane, scoreCard) {
  const outcome = String(scoreCard?.outcome ?? '').toLowerCase();
  const delivered = outcome.includes('delivered') || outcome.includes('success');
  const totalScore = Number(scoreCard?.totalScore ?? scoreCard?.score ?? run?.score ?? 0);
  const damageTaken = Number(run?.damageTaken ?? Math.max(0, 100 - (plane?.hull ?? 100)));
  const landingGrade = String(plane?.landingGrade ?? '').toLowerCase();

  for (const tier of GRADE_TIERS) {
    if (tier.requiresDelivered && !delivered) continue;
    if (damageTaken > tier.maxHullDamage) continue;
    if (totalScore < tier.minScore) continue;
    if (tier.grade === 'S' && landingGrade.includes('rough')) continue;

    return {
      grade: tier.grade,
      title: tier.title,
      color: tier.color,
      summary: tier.summary,
      delivered,
      score: totalScore,
      damageTaken,
    };
  }

  const fallback = GRADE_TIERS[GRADE_TIERS.length - 1];
  return {
    grade: fallback.grade,
    title: fallback.title,
    color: fallback.color,
    summary: fallback.summary,
    delivered,
    score: totalScore,
    damageTaken,
  };
}

export function formatGradeBadge(grade) {
  const tier = GRADE_TIERS.find(t => t.grade === grade) ?? GRADE_TIERS[GRADE_TIERS.length - 1];
  return {
    grade: tier.grade,
    title: tier.title,
    color: tier.color,
  };
}
