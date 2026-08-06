// Request validation. Hand-rolled, for the same reason `momentum/dto.ts` is: this app has two
// runtime dependencies and adding a schema library for one module's five endpoints is not a
// trade worth making.
//
// The config endpoint is the one that matters. It is an admin surface that rewrites a trading
// strategy, and a bad patch reaching the engine does not throw — it silently changes what the
// scanner means. So a patch is validated STRUCTURALLY here ("is this shape a config patch at
// all") and the RESULT is then repaired in `config.repository.ts`, which is a different check: a
// patch can be individually well-formed and still leave the ADX veto line above the ADX trend
// line, at which point every row simultaneously fails to trend and fails to be vetoed.
//
// Unknown top-level keys are REJECTED rather than ignored. A typo in an admin form that silently
// does nothing is worse than an error: the operator believes the change took effect, and the
// board they are looking at is not the one they configured.

import type { DeepPartial } from './config/config.repository.js';
import { TIMEFRAMES } from './types.js';
import type {
  AlertKind, ConfidenceBand, PullbackConfig, PullbackRow, Timeframe, TrendState,
} from './types.js';

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
  }
}

export const isValidationError = (e: unknown): e is ValidationError => e instanceof ValidationError;

/* ------------------------------------------------------------------- board query --- */

export interface BoardQuery {
  limit: number;
  /** Only rows with a fired signal. */
  signalsOnly: boolean;
  /** Only rows at or approaching the zone with no confirmation yet. */
  watchOnly: boolean;
  direction: TrendState | null;
  band: ConfidenceBand | null;
  timeframe: Timeframe | null;
  kind: 'stock' | 'index' | null;
  sector: string | null;
  minConfidence: number;
  minTrendStrength: number;
  /** Underlying spread ceiling in bps, on top of the config's own veto. */
  maxSpreadBps: number | null;
  /** Option liquidity floor, on top of the config's own. */
  minLiquidity: number;
  /** Session turnover floor, ₹ crore. */
  minTurnoverCr: number;
  search: string | null;
  sort: 'confidence' | 'trend' | 'rr' | 'symbol' | 'change';
  /** Include the per-timeframe indicator blocks. Heavy — off by default. */
  includeFrames: boolean;
}

const BANDS: ConfidenceBand[] = ['Weak', 'Medium', 'Strong', 'Excellent'];
const SORTS = ['confidence', 'trend', 'rr', 'symbol', 'change'] as const;
const ALERT_KINDS: AlertKind[] = ['freshPullback', 'trendResume', 'emaRejection', 'targetHit', 'stopHit'];

const asInt = (v: unknown, fallback: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const asNum = (v: unknown, fallback: number | null): number | null => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  const s = String(v ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};

const asBool = (v: unknown): boolean => v === true || v === 'true' || v === '1';

const asTimeframe = (v: unknown): Timeframe | null => {
  const n = Number(v);
  return TIMEFRAMES.includes(n as Timeframe) ? (n as Timeframe) : null;
};

export function parseBoardQuery(q: Record<string, unknown>, cfg: PullbackConfig): BoardQuery {
  return {
    limit: asInt(q.limit, cfg.output.limit, 1, 500),
    signalsOnly: asBool(q.signalsOnly),
    watchOnly: asBool(q.watchOnly),
    direction: oneOf(q.direction, ['Bullish', 'Bearish', 'None'] as const),
    band: oneOf(q.band, BANDS),
    timeframe: asTimeframe(q.timeframe),
    kind: oneOf(q.kind, ['stock', 'index'] as const),
    sector: q.sector ? String(q.sector).toUpperCase() : null,
    minConfidence: asInt(q.minConfidence, 0, 0, 100),
    minTrendStrength: asInt(q.minTrendStrength, cfg.output.minTrendStrength, 0, 100),
    maxSpreadBps: asNum(q.maxSpreadBps, null),
    minLiquidity: asInt(q.minLiquidity, 0, 0, 100),
    minTurnoverCr: asNum(q.minTurnoverCr, 0) ?? 0,
    search: q.search ? String(q.search).toUpperCase().trim() : null,
    sort: oneOf(q.sort, SORTS) ?? 'confidence',
    includeFrames: asBool(q.includeFrames),
  };
}

/** The confidence a row is filtered and sorted by: its signal's, else its watch candidate's. */
const confidenceOf = (r: PullbackRow): number => r.signal?.score.total ?? r.watch?.score.total ?? 0;

/**
 * Apply the filters.
 *
 * `timeframe` filters on the SIGNAL's timeframe when the row has one, and otherwise on whether
 * that timeframe is in a trend at all — so selecting "15 min" narrows the signal list to
 * 15-minute entries and the rest of the board to stocks trending on the 15-minute chart, which
 * is what a reader picking a timeframe means by it.
 */
export function applyFilters(rows: PullbackRow[], q: BoardQuery): PullbackRow[] {
  let out = rows;

  if (q.signalsOnly) out = out.filter((r) => r.signal !== null);
  if (q.watchOnly) out = out.filter((r) => r.signal === null && r.watch !== null);
  if (q.kind) out = out.filter((r) => r.kind === q.kind);
  if (q.sector) out = out.filter((r) => (r.sector ?? '').toUpperCase() === q.sector);
  if (q.band) out = out.filter((r) => (r.signal?.score.band ?? r.watch?.score.band) === q.band);
  if (q.minConfidence > 0) out = out.filter((r) => confidenceOf(r) >= q.minConfidence);
  if (q.minTrendStrength > 0) out = out.filter((r) => (r.dominant?.strength ?? 0) >= q.minTrendStrength);
  if (q.minTurnoverCr > 0) out = out.filter((r) => r.turnoverCr >= q.minTurnoverCr);

  if (q.direction) {
    const want = q.direction === 'Bullish' ? 1 : q.direction === 'Bearish' ? -1 : 0;
    out = out.filter((r) => {
      const d = r.signal?.direction ?? r.watch?.direction ?? null;
      if (want === 0) return d === null;
      return d === want;
    });
  }

  if (q.timeframe !== null) {
    const tf = q.timeframe;
    out = out.filter((r) => {
      const s = r.signal ?? r.watch;
      if (s) return s.timeframe === tf;
      return r.trends[tf]?.state !== 'None';
    });
  }

  // Only rows with an observed two-sided book are tested. Null is "not measurable", and filtering
  // it out would empty the board after hours rather than telling the reader the market is shut.
  if (q.maxSpreadBps !== null)
    out = out.filter((r) => r.spreadBps === null || r.spreadBps <= (q.maxSpreadBps as number));

  if (q.minLiquidity > 0)
    out = out.filter((r) => {
      const o = (r.signal ?? r.watch)?.option;
      return o ? o.liquidity.score >= q.minLiquidity : false;
    });

  if (q.search) {
    const s = q.search;
    out = out.filter((r) => r.symbol.includes(s) || (r.sector ?? '').includes(s) || (r.name ?? '').toUpperCase().includes(s));
  }

  return sortRows(out, q.sort);
}

function sortRows(rows: PullbackRow[], sort: BoardQuery['sort']): PullbackRow[] {
  const out = [...rows];
  // Fired signals always float above unfired rows whatever the sort key, because the board is
  // read top-down and the top has to be the actionable end of it. The chosen key orders WITHIN
  // each group rather than across them — a sort that buried a live entry under a watchlist row
  // with a higher reward:risk would be sorting the wrong thing.
  const rank = (r: PullbackRow): number => (r.signal ? 2 : r.watch ? 1 : 0);
  const key = (r: PullbackRow): number => {
    const s = r.signal ?? r.watch;
    switch (sort) {
      case 'trend': return r.dominant?.strength ?? 0;
      case 'rr': return s?.target.rewardRisk ?? 0;
      case 'change': return r.changePct;
      default: return confidenceOf(r);
    }
  };

  if (sort === 'symbol') out.sort((a, b) => rank(b) - rank(a) || a.symbol.localeCompare(b.symbol));
  else out.sort((a, b) => rank(b) - rank(a) || key(b) - key(a));
  return out;
}

/** Rows carry the whole per-timeframe indicator block; the list view does not need it. */
export const slim = (r: PullbackRow): Omit<PullbackRow, 'frames'> => {
  const { frames: _frames, ...rest } = r;
  return rest;
};

/* ---------------------------------------------------------------------- other DTOs --- */

/** NSE symbols carry `&` (GVT&D) and `-` (BAJAJ-AUTO), so both are allowed. */
export function parseSymbol(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new ValidationError(['symbol is required']);
  if (!/^[A-Z0-9&._-]{1,30}$/.test(s)) throw new ValidationError([`"${s}" is not a valid NSE symbol`]);
  return s;
}

export interface AlertQuery {
  since: number | undefined;
  kind: AlertKind | null;
  limit: number;
}

export const parseAlertQuery = (q: Record<string, unknown>): AlertQuery => ({
  since: q.since === undefined ? undefined : (asNum(q.since, 0) ?? 0),
  kind: oneOf(q.kind, ALERT_KINDS),
  limit: asInt(q.limit, 100, 1, 500),
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseBacktestRequest(body: unknown, cfg: PullbackConfig): {
  symbol: string; timeframe: Timeframe; from: string; to: string; exitOn: '1R' | '2R' | 'primary';
} {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const issues: string[] = [];

  let symbol = '';
  try { symbol = parseSymbol(b.symbol); } catch (e) { issues.push((e as ValidationError).issues[0]); }

  const timeframe = asTimeframe(b.timeframe) ?? cfg.timeframes.signal[0];
  if (b.timeframe !== undefined && asTimeframe(b.timeframe) === null)
    issues.push(`timeframe must be one of ${TIMEFRAMES.join(', ')}`);

  const from = String(b.from ?? '');
  const to = String(b.to ?? '');
  if (!ISO_DAY.test(from)) issues.push('from must be a YYYY-MM-DD date');
  if (!ISO_DAY.test(to)) issues.push('to must be a YYYY-MM-DD date');
  if (ISO_DAY.test(from) && ISO_DAY.test(to) && from > to) issues.push('from must not be after to');

  // Refused rather than silently truncated. A range this wide is many minutes of candle requests
  // and would spend the seed's budget; saying so is better than quietly backtesting a shorter
  // period than the one asked for and reporting statistics against the requested dates.
  if (ISO_DAY.test(from) && ISO_DAY.test(to)) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days > 180) issues.push('the range cannot exceed 180 days — each 28-day chunk is one upstream request');
  }

  const exitOn = oneOf(b.exitOn, ['1R', '2R', 'primary'] as const) ?? 'primary';

  if (issues.length) throw new ValidationError(issues);
  return { symbol, timeframe, from, to, exitOn };
}

/* -------------------------------------------------------------------- config patch --- */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const looksLikeKnotList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && isPlainObject(v[0]) && 'at' in (v[0] as object) && 'score' in (v[0] as object);

function checkKnots(path: string, v: unknown, issues: string[]): void {
  if (!Array.isArray(v) || !v.length) {
    issues.push(`${path} must be a non-empty array of {at, score}`);
    return;
  }
  v.forEach((k, idx) => {
    if (!isPlainObject(k) || !Number.isFinite(Number(k.at)) || !Number.isFinite(Number(k.score)))
      issues.push(`${path}[${idx}] must be {at: number, score: number}`);
    else if (Number(k.score) < 0 || Number(k.score) > 100)
      issues.push(`${path}[${idx}].score must be 0–100`);
  });
}

/** Every leaf must be a finite number, a boolean, a string, or a recognised array. */
function walk(node: Record<string, unknown>, path: string, issues: string[], depth = 0): void {
  if (depth > 4) {
    issues.push(`${path} is nested too deeply to be a config value`);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const at = `${path}.${k}`;
    if (Array.isArray(v)) {
      if (looksLikeKnotList(v)) checkKnots(at, v, issues);
      else if (k === 'exclude' || k === 'indices' || k === 'kinds' || k === 'computed' || k === 'signal' || k === 'context') {
        if (v.some((x) => typeof x !== 'string' && typeof x !== 'number'))
          issues.push(`${at} must be an array of strings or numbers`);
      } else issues.push(`${at} is an unexpected array`);
    } else if (isPlainObject(v)) {
      walk(v, at, issues, depth + 1);
    } else if (typeof v === 'boolean' || typeof v === 'string') {
      continue;
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push(`${at} must be a finite number, a boolean or a string`);
    }
  }
}

export function parseConfigPatch(body: unknown): DeepPartial<PullbackConfig> {
  if (!isPlainObject(body)) throw new ValidationError(['body must be a JSON object']);

  const issues: string[] = [];
  const allowed = new Set([
    'universe', 'timeframes', 'trend', 'pullback', 'score', 'risk', 'option', 'alerts',
    'refresh', 'output',
    // Accepted and ignored: an admin panel that GETs the config and PUTs it back should not be
    // rejected for echoing the fields the server owns.
    'version', 'updatedAt', 'updatedBy',
  ]);

  for (const key of Object.keys(body)) if (!allowed.has(key)) issues.push(`unknown field "${key}"`);

  for (const key of ['universe', 'timeframes', 'trend', 'pullback', 'score', 'risk', 'option', 'alerts', 'refresh', 'output']) {
    if (!(key in body)) continue;
    const v = body[key];
    if (!isPlainObject(v)) issues.push(`${key} must be an object`);
    else walk(v, key, issues);
  }

  if (isPlainObject(body.score) && isPlainObject(body.score.weights)) {
    const w = body.score.weights;
    const known = new Set(['trend', 'volume', 'vwap', 'ema', 'structure', 'adx']);
    let sum = 0;
    for (const [k, v] of Object.entries(w)) {
      if (!known.has(k)) { issues.push(`score.weights.${k} is not a component`); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) issues.push(`score.weights.${k} must be a number ≥ 0`);
      else sum += n;
    }
    // Weights need not total 100 — the scorer normalises — but all-zero is not a model.
    if (Object.keys(w).length === known.size && sum === 0) issues.push('score.weights cannot all be zero');
  }

  if (isPlainObject(body.refresh)) {
    const r = body.refresh;
    if ('scanMs' in r && Number(r.scanMs) < 10_000)
      issues.push('refresh.scanMs below 10000 would exceed the Upstox quote rate limit');
    // The scanner's resolution IS the poll interval. Said as an issue rather than silently
    // accepted, because a 3-minute signal timeframe polled every four minutes means every
    // confirmation is published at least a bar late — and late is the one thing this module
    // exists not to be.
    if ('scanMs' in r && Number(r.scanMs) > 120_000)
      issues.push('refresh.scanMs above 120000 leaves the shortest signal timeframe too few readings to be published on time');
  }

  if (isPlainObject(body.universe) && 'enrichLimit' in body.universe) {
    const n = Number(body.universe.enrichLimit);
    if (!Number.isFinite(n) || n < 0) issues.push('universe.enrichLimit must be ≥ 0');
    // Not an error — an operator may know what they are doing — but the cost is linear against a
    // hard ceiling, so the obviously unpayable is worth refusing.
    if (n > 60)
      issues.push('universe.enrichLimit above 60 would exceed the option-chain rate limit at the default scan interval');
  }

  if (isPlainObject(body.alerts) && 'webhookUrl' in body.alerts) {
    const u = String(body.alerts.webhookUrl ?? '');
    if (u && !/^https?:\/\//i.test(u)) issues.push('alerts.webhookUrl must be an http(s) URL, or empty to disable');
  }

  if (issues.length) throw new ValidationError(issues);

  // The server owns provenance; a client cannot set its own version or author.
  const { version: _v, updatedAt: _a, updatedBy: _b, ...patch } = body as Record<string, unknown>;
  return patch as DeepPartial<PullbackConfig>;
}
