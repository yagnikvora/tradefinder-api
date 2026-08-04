// The scoring primitives every factor service shares.
//
// There is exactly one way to turn a measurement into a 0–100 score in this module, and it
// is `curve()`. That is deliberate: twelve factors each rolling their own thresholds is how
// a scoring model becomes impossible to reason about, and how "configurable weights" turns
// out to mean "configurable weights and thirty hardcoded ifs".
//
// A curve is a list of knots — (reading, score) pairs — interpolated linearly and clamped
// at both ends. It handles the three shapes the model needs without a special case:
//
//   rising     RVOL: more is better.            [{0.5,0} … {6,100}]
//   falling    spread: less is better.          [{1,100} … {50,0}]
//   humped     IV rank: the middle is best.     [{0,20} {40,95} {60,100} {100,25}]
//
// Knots are always sorted ascending by `at` (the config repository guarantees it), and the
// direction of the score is whatever the knot list says. Nothing here needs to know which
// shape it was handed.

import type { FactorKey, FactorOutcome, FactorReason, Knot, MetricValue } from '../types.js';
import { FACTOR_LABEL } from '../types.js';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Squash any real number into −1…+1. Used wherever a bias needs a soft ceiling. */
export const squash = (v: number, fullScale: number): number =>
  fullScale > 0 ? Math.tanh(v / fullScale) : 0;

/**
 * Interpolate `value` through `knots` and clamp to 0…100.
 *
 * A single knot is a constant, an empty list is 0. Neither should happen — the config
 * sanitiser drops malformed curves — but a scoring function that throws would take the
 * whole board down over one bad admin edit.
 */
export function curve(value: number, knots: Knot[]): number {
  if (!knots.length) return 0;
  if (!Number.isFinite(value)) return 0;
  if (knots.length === 1) return clamp(knots[0].score, 0, 100);

  if (value <= knots[0].at) return clamp(knots[0].score, 0, 100);
  const last = knots[knots.length - 1];
  if (value >= last.at) return clamp(last.score, 0, 100);

  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    if (value <= b.at) {
      const span = b.at - a.at;
      const t = span > 0 ? (value - a.at) / span : 0;
      return clamp(a.score + t * (b.score - a.score), 0, 100);
    }
  }
  return clamp(last.score, 0, 100);
}

/** A weighted mean over the components that are present, with the rest reweighted away. */
export interface MixComponent {
  key: string;
  score: number | null;
  weight: number;
}

export interface MixResult {
  score: number | null;
  /** Fraction of the mix's weight that was computable, 0…1. */
  coverage: number;
  missing: string[];
}

export function mix(components: MixComponent[]): MixResult {
  let sum = 0;
  let used = 0;
  let total = 0;
  const missing: string[] = [];

  for (const c of components) {
    total += c.weight;
    if (c.score === null || !Number.isFinite(c.score)) {
      missing.push(c.key);
      continue;
    }
    sum += c.score * c.weight;
    used += c.weight;
  }

  return {
    score: used > 0 ? +(sum / used).toFixed(2) : null,
    coverage: total > 0 ? used / total : 0,
    missing,
  };
}

/** Build a FactorOutcome. Centralised so every factor reports the same shape. */
export function outcome(args: {
  key: FactorKey;
  weight: number;
  score: number | null;
  bias?: number;
  metrics?: Record<string, MetricValue>;
  reasons?: FactorReason[];
  note?: string;
}): FactorOutcome {
  const score = args.score === null || !Number.isFinite(args.score) ? null : +clamp(args.score, 0, 100).toFixed(2);
  return {
    key: args.key,
    label: FACTOR_LABEL[args.key],
    score,
    bias: score === null ? 0 : +clamp(args.bias ?? 0, -1, 1).toFixed(3),
    weight: args.weight,
    available: score !== null,
    note: args.note,
    metrics: args.metrics ?? {},
    reasons: args.reasons ?? [],
  };
}

/** A factor that could not be computed, with the reason attached rather than a zero. */
export const unavailable = (key: FactorKey, weight: number, note: string): FactorOutcome =>
  outcome({ key, weight, score: null, note, reasons: [{ ok: false, text: `${FACTOR_LABEL[key]}: ${note}` }] });

/** Sign with a dead zone, so a reading of −0.001% does not report as bearish. */
export const signOf = (v: number, deadband = 0): -1 | 0 | 1 =>
  v > deadband ? 1 : v < -deadband ? -1 : 0;

export const pct = (v: number, digits = 2): number => +v.toFixed(digits);

/** "4.8x", "+1.52%" — the shapes the reason strings use. */
export const fmtX = (v: number): string => `${v.toFixed(1)}x`;
export const fmtPct = (v: number, digits = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
