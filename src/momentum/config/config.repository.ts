// The momentum configuration, as a repository.
//
// Reads are hot — the engine asks for the config on every scored row — so the file is held
// in memory and only re-read when it changes on disk. Writes bump `version` and stamp
// `updatedAt`/`updatedBy`, which is what makes an admin edit auditable and lets a cached
// board tell whether it was scored under the current model.
//
// A saved config is MERGED over the defaults, not swapped for them. That matters when this
// module gains a factor: an operator who saved a config last month gets the new factor's
// defaults rather than a crash on an undefined threshold.

import type { FactorKey, Knot, MomentumConfig } from '../types.js';
import { FACTOR_KEYS } from '../types.js';
import { defaultConfig } from './defaults.js';
import { store, STORE_KEYS, type KeyValueStore } from '../store.js';

export interface ConfigRepository {
  get(): Promise<MomentumConfig>;
  save(patch: DeepPartial<MomentumConfig>, updatedBy: string): Promise<MomentumConfig>;
  reset(updatedBy: string): Promise<MomentumConfig>;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Recursive merge, with arrays replaced wholesale rather than merged element-wise.
 *
 * Knot lists are arrays and a caller sending a shorter curve means exactly that curve —
 * element-wise merging would leave the tail of the old one attached and produce a shape
 * nobody asked for.
 */
function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null || Array.isArray(base))
    return patch as T;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

export class StoredConfigRepository implements ConfigRepository {
  private cached: MomentumConfig | null = null;
  private loading: Promise<MomentumConfig> | null = null;

  constructor(private readonly kv: KeyValueStore = store) {}

  async get(): Promise<MomentumConfig> {
    if (this.cached) return this.cached;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const saved = await this.kv.read<DeepPartial<MomentumConfig>>(STORE_KEYS.config);
      const cfg = saved ? sanitise(merge(defaultConfig(), saved)) : defaultConfig();
      this.cached = cfg;
      return cfg;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async save(patch: DeepPartial<MomentumConfig>, updatedBy: string): Promise<MomentumConfig> {
    const current = await this.get();
    const next = sanitise(merge(current, patch));
    next.version = current.version + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy;
    await this.kv.write(STORE_KEYS.config, next);
    this.cached = next;
    return next;
  }

  async reset(updatedBy: string): Promise<MomentumConfig> {
    const next = defaultConfig();
    next.version = (this.cached?.version ?? 0) + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy;
    await this.kv.write(STORE_KEYS.config, next);
    this.cached = next;
    return next;
  }
}

/**
 * Repair anything a merge could have left unusable.
 *
 * The DTO validates the request; this validates the RESULT, which is not the same check —
 * a patch can be individually valid and still leave, say, every weight at zero. Curves are
 * sorted here rather than rejected because knot order is a presentation detail of the
 * request, not a meaningful part of the model.
 */
export function sanitise(cfg: MomentumConfig): MomentumConfig {
  for (const k of FACTOR_KEYS) {
    const w = cfg.weights[k as FactorKey];
    cfg.weights[k as FactorKey] = Number.isFinite(w) && w >= 0 ? w : 0;
  }
  // Every weight zero would divide by zero in the engine and publish a board of NaN.
  if (FACTOR_KEYS.every((k) => cfg.weights[k] === 0)) cfg.weights = defaultConfig().weights;

  sortKnotsDeep(cfg.thresholds as unknown as Record<string, unknown>);

  cfg.scoring.maxScore = clampNumber(cfg.scoring.maxScore, 1, 1000, 100);
  cfg.scoring.coherence.maxPenalty = clampNumber(cfg.scoring.coherence.maxPenalty, 0, 0.9, 0.25);
  cfg.scoring.directionDeadband = clampNumber(cfg.scoring.directionDeadband, 0, 1, 0.12);
  cfg.scoring.minCoverage = clampNumber(cfg.scoring.minCoverage, 0, 1, 0.35);
  cfg.confidence.high = clampNumber(cfg.confidence.high, 0, 1, 0.85);
  cfg.confidence.medium = clampNumber(cfg.confidence.medium, 0, cfg.confidence.high, 0.6);
  cfg.universe.shortlistSize = Math.round(clampNumber(cfg.universe.shortlistSize, 0, 208, 40));
  cfg.refresh.quoteMs = Math.round(clampNumber(cfg.refresh.quoteMs, 5_000, 600_000, 30_000));
  cfg.refresh.enrichMs = Math.round(clampNumber(cfg.refresh.enrichMs, 15_000, 900_000, 60_000));
  cfg.refresh.baselineHourIst = Math.round(clampNumber(cfg.refresh.baselineHourIst, 0, 23, 8));
  cfg.output.limit = Math.round(clampNumber(cfg.output.limit, 1, 500, 100));
  cfg.universe.exclude = (cfg.universe.exclude ?? []).map((s) => String(s).toUpperCase());

  sanitiseTiming(cfg);
  return cfg;
}

/**
 * The timing layer's own repair pass.
 *
 * These are the numbers that decide whether a signal is allowed to fire at all, so a
 * nonsense value here does not produce a wrong ranking — it produces a board that either
 * signals on everything or on nothing, and both look plausible from the outside. The
 * window ordering is enforced rather than clamped: a fast window longer than the slow one
 * would make acceleration measure a rate against itself and read as permanently zero.
 */
function sanitiseTiming(cfg: MomentumConfig): void {
  const p = cfg.thresholds.pulse;
  p.fastWindowMin = clampNumber(p.fastWindowMin, 0.5, 30, 3);
  p.slowWindowMin = clampNumber(p.slowWindowMin, p.fastWindowMin + 0.5, 60, 10);
  p.baseWindowMin = clampNumber(p.baseWindowMin, p.fastWindowMin + 0.5, 60, 15);
  p.minReadings = Math.round(clampNumber(p.minReadings, 2, 50, 3));
  p.legReversalAtr = clampNumber(p.legReversalAtr, 0.02, 2, 0.3);
  p.legReversalPctFloor = clampNumber(p.legReversalPctFloor, 0.02, 5, 0.35);
  p.compressionAtr = clampNumber(p.compressionAtr, 0.02, 2, 0.28);
  p.breakBufferAtr = clampNumber(p.breakBufferAtr, 0, 1, 0.08);
  p.fullScaleVelocityAtr = clampNumber(p.fullScaleVelocityAtr, 0.001, 1, 0.02);
  // An all-zero mix would divide by zero in `mix()` and take the factor dark.
  const mixTotal = p.mix.burst + p.mix.velocity + p.mix.efficiency;
  if (!(mixTotal > 0)) p.mix = { burst: 0.4, velocity: 0.4, efficiency: 0.2 };

  const s = cfg.signal;
  s.maxTriggerAgeMin = clampNumber(s.maxTriggerAgeMin, 0.5, 180, 12);
  s.minPulseScore = clampNumber(s.minPulseScore, 0, 100, 55);
  s.minBurstRvol = clampNumber(s.minBurstRvol, 0, 50, 1.6);
  s.cooldownMin = clampNumber(s.cooldownMin, 0, 375, 15);
  s.stallMinutes = clampNumber(s.stallMinutes, 0.5, 375, 8);
  s.extension.atrUsedMax = clampNumber(s.extension.atrUsedMax, 0.1, 5, 0.8);
  s.extension.vwapAtrMax = clampNumber(s.extension.vwapAtrMax, 0.1, 10, 1.4);
  s.extension.legMoveAtrMax = clampNumber(s.extension.legMoveAtrMax, 0.05, 5, 0.65);
  s.targetAtr = clampNumber(s.targetAtr, 0.05, 5, 0.45);
  s.stopAtr = clampNumber(s.stopAtr, 0.02, 5, 0.28);
  s.minRoomAtr = clampNumber(s.minRoomAtr, 0, 5, 0.25);
  s.targetOptionMovePct = clampNumber(s.targetOptionMovePct, 1, 1000, 35);
  s.pullback.minDepth = clampNumber(s.pullback.minDepth, 0, 0.95, 0.2);
  s.pullback.maxDepth = clampNumber(s.pullback.maxDepth, s.pullback.minDepth, 1, 0.55);
  s.enrichReservedSlots = Math.round(clampNumber(s.enrichReservedSlots, 0, 208, 12));

  const k = s.strike;
  k.itmSteps = Math.round(clampNumber(k.itmSteps, 0, 20, 1));
  k.otmSteps = Math.round(clampNumber(k.otmSteps, 0, 20, 3));
  // Floored well above zero on purpose: a delta of 0.02 is not a momentum trade in any
  // configuration, and letting an admin set it there would quietly turn the strike picker
  // into a lottery-ticket picker while every other number on the row stayed sensible.
  k.minDelta = clampNumber(k.minDelta, 0.05, 0.95, 0.25);
  k.minOi = Math.max(0, Math.round(clampNumber(k.minOi, 0, 1e9, 1000)));
  k.maxSpreadPct = clampNumber(k.maxSpreadPct, 0.1, 100, 3);
  k.maxThetaPctPerHour = clampNumber(k.maxThetaPctPerHour, 0.1, 100, 3);
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const isKnotList = (v: unknown): v is Knot[] =>
  Array.isArray(v) && v.length > 0 && v.every((k) => k && typeof k === 'object' && 'at' in k && 'score' in k);

function sortKnotsDeep(node: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(node)) {
    if (isKnotList(v)) {
      node[k] = [...v]
        .map((n) => ({ at: Number(n.at), score: Number(n.score) }))
        .filter((n) => Number.isFinite(n.at) && Number.isFinite(n.score))
        .sort((a, b) => a.at - b.at);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      sortKnotsDeep(v as Record<string, unknown>);
    }
  }
}

export const configRepository: ConfigRepository = new StoredConfigRepository();
