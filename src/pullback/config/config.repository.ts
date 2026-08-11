// The pullback configuration, as a repository.
//
// Same shape and same reasoning as `momentum/config/config.repository.ts`: reads are hot, so
// the config is held in memory; writes bump `version` and stamp `updatedAt`/`updatedBy`, so a
// board can say which model it was scanned under; and a saved config is MERGED over the
// defaults rather than swapped for them, so a config saved before a new gate existed inherits
// that gate's default instead of crashing on an undefined threshold.
//
// The store is shared with the momentum module — `momentum/store.ts` is a driver, not that
// module's private state — under its own key, so the two modules' configs cannot collide.

import type {
  AlertKind, ConfidenceBand, PullbackConfig, Knot, Timeframe, TrendConfluence, TrendConfluenceMode,
} from '../types.js';
import { TIMEFRAMES } from '../types.js';

const ALERT_KINDS: AlertKind[] = [
  'freshPullback', 'trendResume', 'trendDay', 'emaRejection', 'targetHit', 'stopHit',
];
/**
 * Anyone subscribed to `trendResume` is subscribed to `trendDay`, whether they know it or not.
 *
 * THIS IS A MIGRATION, NOT A PREFERENCE, and without it adding the kind is a silent regression.
 * `merge` replaces arrays wholesale, so a config saved before `trendDay` existed keeps its old
 * `kinds` list forever — and since a confirmed-trend-day entry now emits `trendDay` INSTEAD of
 * `trendResume`, that stored list would filter out exactly the best signals the module produces.
 * The channel would not break; it would go quiet on precisely the trades worth interrupting for,
 * which is the failure mode nobody reports because it looks like a slow week.
 *
 * The reverse is deliberately not done: someone who has narrowed to `['trendDay']` has asked for
 * confirmed sessions only, and widening that back to `trendResume` would undo their choice.
 */
const withTrendDay = (kinds: AlertKind[]): AlertKind[] =>
  kinds.includes('trendResume') && !kinds.includes('trendDay') ? [...kinds, 'trendDay'] : kinds;

const BANDS: ConfidenceBand[] = ['Weak', 'Medium', 'Strong', 'Excellent'];
const TREND_MODES: TrendConfluenceMode[] = ['require', 'annotate', 'off'];
const DEFAULT_TREND_CONFLUENCE: TrendConfluence = {
  mode: 'require', minPhase: 'Confirmed', sameDirection: true,
  minScore: 0, allowWhenUnknown: true, maxBoardAgeSec: 120,
};
import { defaultConfig } from './defaults.js';
import { store, type KeyValueStore } from '../../momentum/store.js';

/** Keys this module owns inside the shared store. */
export const PULLBACK_KEYS = {
  config: 'pullback_config',
  seed: 'pullback_seed',
  signals: 'pullback_signals',
  snapshot: 'pullback_snapshot',
} as const;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U> ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface ConfigRepository {
  get(): Promise<PullbackConfig>;
  save(patch: DeepPartial<PullbackConfig>, updatedBy: string): Promise<PullbackConfig>;
  reset(updatedBy: string): Promise<PullbackConfig>;
}

/** Recursive merge. Arrays are replaced wholesale — a shorter knot list means that curve. */
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
  private cached: PullbackConfig | null = null;
  private loading: Promise<PullbackConfig> | null = null;

  constructor(private readonly kv: KeyValueStore = store) {}

  async get(): Promise<PullbackConfig> {
    if (this.cached) return this.cached;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const saved = await this.kv.read<DeepPartial<PullbackConfig>>(PULLBACK_KEYS.config);
      const cfg = saved ? sanitise(merge(defaultConfig(), saved)) : defaultConfig();
      this.cached = cfg;
      return cfg;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async save(patch: DeepPartial<PullbackConfig>, updatedBy: string): Promise<PullbackConfig> {
    const current = await this.get();
    const next = sanitise(merge(current, patch));
    next.version = current.version + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy;
    await this.kv.write(PULLBACK_KEYS.config, next);
    this.cached = next;
    return next;
  }

  async reset(updatedBy: string): Promise<PullbackConfig> {
    const next = defaultConfig();
    next.version = (this.cached?.version ?? 0) + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = updatedBy;
    await this.kv.write(PULLBACK_KEYS.config, next);
    this.cached = next;
    return next;
  }

  /** Test seam — drops the memoised copy so the next read comes off the store. */
  reset$(): void {
    this.cached = null;
  }
}

const clampNumber = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

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

const validTimeframes = (v: unknown, fallback: Timeframe[]): Timeframe[] => {
  const list = Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n): n is Timeframe => TIMEFRAMES.includes(n as Timeframe)))]
    : [];
  return list.length ? list.sort((a, b) => a - b) : fallback;
};

/**
 * Repair anything a merge could have left unusable.
 *
 * The DTO validates the REQUEST — is this shape a config patch — and this validates the
 * RESULT, which is a different check: a patch can be individually well-formed and still leave
 * the scanner unable to produce a signal, or able to produce nothing but signals. The
 * relationships enforced below are the ones where a wrong value does not throw, it just
 * quietly changes what the module means.
 */
export function sanitise(cfg: PullbackConfig): PullbackConfig {
  sortKnotsDeep(cfg.score.curves as unknown as Record<string, unknown>);
  sortKnotsDeep(cfg.option.curves as unknown as Record<string, unknown>);

  const t = cfg.timeframes;
  t.computed = validTimeframes(t.computed, [1, 3, 5, 15]);
  // A signal timeframe that is not computed would silently never fire — the frame it needs is
  // never built — so the two lists are reconciled rather than trusted.
  t.signal = validTimeframes(t.signal, [5]).filter((tf) => t.computed.includes(tf));
  if (!t.signal.length) t.signal = [...t.computed];
  t.context = validTimeframes(t.context, [5, 15]).filter((tf) => t.computed.includes(tf));
  t.minBars = Math.round(clampNumber(t.minBars, 10, 500, 30));
  t.volumeLookback = Math.round(clampNumber(t.volumeLookback, 5, 200, 20));

  const tr = cfg.trend;
  tr.adxVeto = clampNumber(tr.adxVeto, 0, 100, 20);
  // The trend line must sit at or above the veto line. Inverted, every stock would be
  // simultaneously "not trending enough to signal" and "trending enough not to be vetoed",
  // which produces a board of rows that pass every check and never fire.
  tr.adxTrend = clampNumber(tr.adxTrend, tr.adxVeto, 100, 25);
  tr.flatSlopeAtrPerBar = clampNumber(tr.flatSlopeAtrPerBar, 0, 2, 0.035);
  tr.minVolumeRatio = clampNumber(tr.minVolumeRatio, 0, 20, 1);
  tr.deadVolumeRatio = clampNumber(tr.deadVolumeRatio, 0, tr.minVolumeRatio, 0.5);
  tr.minStructureSteps = Math.round(clampNumber(tr.minStructureSteps, 0, 20, 2));
  tr.consolidation.bars = Math.round(clampNumber(tr.consolidation.bars, 3, 200, 10));
  tr.consolidation.maxRangeAtr = clampNumber(tr.consolidation.maxRangeAtr, 0, 20, 1.6);
  tr.noMansLandAtr = clampNumber(tr.noMansLandAtr, 0, 5, 0.33);
  tr.maxSpreadBps = clampNumber(tr.maxSpreadBps, 1, 1000, 25);

  const p = cfg.pullback;
  p.zoneToleranceAtr = clampNumber(p.zoneToleranceAtr, 0, 3, 0.2);
  p.minImpulseAtr = clampNumber(p.minImpulseAtr, 0.1, 20, 1);
  p.minRetracement = clampNumber(p.minRetracement, 0, 0.95, 0.2);
  p.maxRetracement = clampNumber(p.maxRetracement, p.minRetracement + 0.05, 1, 0.62);
  p.maxBarsInZone = Math.round(clampNumber(p.maxBarsInZone, 1, 100, 8));
  p.maxConfirmationAgeBars = Math.round(clampNumber(p.maxConfirmationAgeBars, 0, 20, 2));
  p.minBodyRatio = clampNumber(p.minBodyRatio, 0, 1, 0.45);
  p.minConfirmationVolumeRatio = clampNumber(p.minConfirmationVolumeRatio, 0, 20, 1.2);
  p.cooldownMin = clampNumber(p.cooldownMin, 0, 375, 20);
  p.minMinutesLeft = clampNumber(p.minMinutesLeft, 0, 375, 30);
  // Capped well under a session's worth of bars: at 25 bars a 15-minute signal would need 375
  // minutes of session left, which only the opening bar has, and the timeframe would go dark.
  p.minHoldBars = Math.round(clampNumber(p.minHoldBars, 0, 25, 12));
  p.rejectionAtr = clampNumber(p.rejectionAtr, 0.05, 5, 0.5);
  // Both edges of the entry-drift band, floored above zero. Zero on either side would refuse every
  // signal — the live price is never exactly the confirmation close — so "off" is a large number,
  // not a zero, and the clamp says so.
  p.maxChaseR = clampNumber(p.maxChaseR, 0.02, 20, 0.33);
  p.maxGiveBackR = clampNumber(p.maxGiveBackR, 0.02, 20, 0.5);
  // The entry-proximity band. The floor may be negative — an operator who wants entries taken
  // inside the zone is choosing a different trade, not a broken config — but the ceiling has to
  // sit above it or nothing can ever fire.
  p.minEntryExtensionAtr = clampNumber(p.minEntryExtensionAtr, -5, 5, 0);
  p.maxEntryExtensionAtr = clampNumber(p.maxEntryExtensionAtr, p.minEntryExtensionAtr + 0.05, 50, 1);

  const s = cfg.score;
  const wSum = Object.values(s.weights).reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  // All-zero weights would divide by zero in the scorer and publish a board of NaN.
  if (!(wSum > 0)) s.weights = { trend: 30, volume: 20, vwap: 15, ema: 15, structure: 10, adx: 10 };
  s.bands.medium = clampNumber(s.bands.medium, 0, 100, 55);
  s.bands.strong = clampNumber(s.bands.strong, s.bands.medium, 100, 70);
  s.bands.excellent = clampNumber(s.bands.excellent, s.bands.strong, 100, 85);
  s.minCoverage = clampNumber(s.minCoverage, 0, 1, 0.7);
  s.minToSignal = clampNumber(s.minToSignal, 0, 100, 55);
  s.alignmentBonus = clampNumber(s.alignmentBonus, 0, 50, 5);

  const r = cfg.risk;
  r.atrStopMultiple = clampNumber(r.atrStopMultiple, 0.1, 10, 1.2);
  r.stopBufferAtr = clampNumber(r.stopBufferAtr, 0, 3, 0.15);
  // Floored above zero deliberately. Setting it to zero restores the failure the floor exists for —
  // a stop 0.15 ATR from entry, and 56R of imaginary room behind it.
  r.minStopAtr = clampNumber(r.minStopAtr, 0.1, 5, 0.6);
  // The ATR stop is the fallback for both edges, so it has to sit inside the band itself.
  r.atrStopMultiple = Math.max(r.atrStopMultiple, r.minStopAtr);
  r.maxStopAtr = clampNumber(r.maxStopAtr, r.atrStopMultiple, 20, 3.5);
  r.atrTargetMultiple = clampNumber(r.atrTargetMultiple, 0.1, 20, 2);
  r.minRewardRisk = clampNumber(r.minRewardRisk, 0, 20, 1.5);
  r.trailAtrMultiple = clampNumber(r.trailAtrMultiple, 0.1, 20, 2);
  r.trailEma = r.trailEma === 9 ? 9 : 20;

  const o = cfg.option;
  o.pullbackDelta.min = clampNumber(o.pullbackDelta.min, 0.05, 0.95, 0.3);
  o.pullbackDelta.max = clampNumber(o.pullbackDelta.max, o.pullbackDelta.min, 1, 0.45);
  o.holdingDelta.min = clampNumber(o.holdingDelta.min, 0.05, 0.95, 0.45);
  o.holdingDelta.max = clampNumber(o.holdingDelta.max, o.holdingDelta.min, 1, 0.6);
  o.itmSteps = Math.round(clampNumber(o.itmSteps, 0, 20, 2));
  o.otmSteps = Math.round(clampNumber(o.otmSteps, 0, 20, 4));
  o.minOi = Math.max(0, Math.round(clampNumber(o.minOi, 0, 1e9, 1000)));
  o.minVolume = Math.max(0, Math.round(clampNumber(o.minVolume, 0, 1e9, 100)));
  o.maxSpreadPct = clampNumber(o.maxSpreadPct, 0.1, 100, 3);
  o.maxThetaPctPerHour = clampNumber(o.maxThetaPctPerHour, 0.1, 100, 4);
  o.minLiquidityScore = clampNumber(o.minLiquidityScore, 0, 100, 45);
  const mix = Object.values(o.liquidityMix).reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (!(mix > 0)) o.liquidityMix = { spread: 0.4, openInterest: 0.25, volume: 0.2, depth: 0.15 };

  // The in-app feed's kinds get the same treatment as the push list, and for the same reason —
  // a stored array predating `trendDay` would drop the event from the strip as well as the phone.
  const feedKinds = Array.isArray(cfg.alerts.kinds) ? cfg.alerts.kinds.filter((k) => ALERT_KINDS.includes(k)) : [];
  cfg.alerts.kinds = feedKinds.length ? [...new Set(withTrendDay(feedKinds))] : [...ALERT_KINDS];

  cfg.alerts.keep = Math.round(clampNumber(cfg.alerts.keep, 10, 5000, 300));
  cfg.alerts.dedupeMin = clampNumber(cfg.alerts.dedupeMin, 0, 375, 10);
  cfg.alerts.webhookUrl = String(cfg.alerts.webhookUrl ?? '').trim();

  // The push block, defensively: a config stored before this existed merges the defaults in, but a
  // hand-edited one can still arrive with `kinds: []` — which reads as "push is on" while being
  // incapable of ever sending, the most confusing of the possible wrong states.
  const push = cfg.alerts.push ?? { enabled: true, kinds: ['trendResume'], minBand: 'Strong' };
  const kinds = withTrendDay(Array.isArray(push.kinds) ? push.kinds.filter((k) => ALERT_KINDS.includes(k)) : []);
  // The trend gate, repaired the same way. An unrecognised mode falls back to `require` rather
  // than to `off`: a typo in the one field that decides whether a filter runs should not quietly
  // remove the filter, which is the failure that would be invisible until a week of bad alerts.
  const tc = push.trend ?? DEFAULT_TREND_CONFLUENCE;
  cfg.alerts.push = {
    enabled: !!push.enabled,
    kinds: kinds.length ? [...new Set(kinds)] : ['trendResume'],
    minBand: BANDS.includes(push.minBand) ? push.minBand : 'Strong',
    trend: {
      mode: TREND_MODES.includes(tc.mode) ? tc.mode : 'require',
      minPhase: tc.minPhase === 'Forming' ? 'Forming' : 'Confirmed',
      sameDirection: tc.sameDirection !== false,
      minScore: clampNumber(tc.minScore, 0, 100, 0),
      allowWhenUnknown: tc.allowWhenUnknown !== false,
      // Floored at one scan interval: anything shorter and every board is "stale" the moment it
      // is read, which would turn the gate into a permanent unknown.
      maxBoardAgeSec: clampNumber(tc.maxBoardAgeSec, 15, 3600, 120),
    },
  };

  // A scan faster than 10s would spend the quote budget confirming that a 3-minute bar has not
  // closed yet; slower than 5 minutes and a 3-minute signal is stale before it is published.
  cfg.refresh.scanMs = Math.round(clampNumber(cfg.refresh.scanMs, 10_000, 300_000, 30_000));
  cfg.refresh.enrichMs = Math.round(clampNumber(cfg.refresh.enrichMs, 15_000, 900_000, 60_000));
  cfg.refresh.resyncMs = Math.round(clampNumber(cfg.refresh.resyncMs, 30_000, 900_000, 120_000));
  cfg.refresh.seedHourIst = Math.round(clampNumber(cfg.refresh.seedHourIst, 0, 23, 8));

  cfg.universe.minPrice = clampNumber(cfg.universe.minPrice, 0, 1e6, 50);
  cfg.universe.minTurnoverCr = clampNumber(cfg.universe.minTurnoverCr, 0, 1e5, 5);
  cfg.universe.enrichLimit = Math.round(clampNumber(cfg.universe.enrichLimit, 0, 250, 25));
  cfg.universe.exclude = (cfg.universe.exclude ?? []).map((x) => String(x).toUpperCase());
  cfg.universe.indices = (cfg.universe.indices ?? []).map((x) => String(x).toUpperCase());

  cfg.output.limit = Math.round(clampNumber(cfg.output.limit, 1, 500, 100));
  cfg.output.minTrendStrength = clampNumber(cfg.output.minTrendStrength, 0, 100, 0);

  return cfg;
}

export const configRepository: ConfigRepository = new StoredConfigRepository();
