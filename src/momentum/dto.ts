// Request validation. Hand-rolled rather than reached for Zod, because this app has two
// runtime dependencies and adding a third for four endpoints is not a trade worth making.
//
// The config endpoint is the one that matters: it is an admin surface that rewrites the
// scoring model, and a bad patch reaching the engine produces a board full of NaN rather
// than an error anyone can act on. So a patch is validated STRUCTURALLY here — is this
// shape a config patch at all — and the result is then sanitised in the repository, which
// is a different check: a patch can be individually well-formed and still leave every
// weight at zero.

import type { DeepPartial } from './config/config.repository.js';
import type { FactorKey, MomentumConfig, MomentumRow, SignalAction, SignalState } from './types.js';
import { FACTOR_KEYS } from './types.js';

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
  }
}

export interface BoardQuery {
  limit: number;
  minScore: number;
  direction: 'Bullish' | 'Bearish' | 'Neutral' | null;
  tradeType: 'Momentum Buy' | 'Momentum Sell' | 'Watch' | 'Avoid' | null;
  confidence: 'High' | 'Medium' | 'Low' | null;
  sector: string | null;
  /** Include the full twelve-factor breakdown on every row. Heavy — off by default. */
  includeFactors: boolean;
  /** Timing-layer filters. `state`/`action` are exact; `minEntryQuality` is a floor. */
  state: SignalState | null;
  action: SignalAction | null;
  minEntryQuality: number;
  /** Only rows with a trigger inside `signal.maxTriggerAgeMin`. */
  freshOnly: boolean;
}

const SIGNAL_STATES = ['Igniting', 'Extending', 'Extended', 'Stalling', 'Reversing', 'Quiet'] as const;
const SIGNAL_ACTIONS = ['Buy Call', 'Buy Put', 'Watch', 'Stand Aside'] as const;

const asInt = (v: unknown, fallback: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  const s = String(v ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
};

const asBool = (v: unknown): boolean => v === true || v === 'true' || v === '1';

export function parseBoardQuery(q: Record<string, unknown>, cfg: MomentumConfig): BoardQuery {
  return {
    limit: asInt(q.limit, cfg.output.limit, 1, 500),
    minScore: asInt(q.minScore, cfg.output.minScore, 0, cfg.scoring.maxScore),
    direction: oneOf(q.direction, ['Bullish', 'Bearish', 'Neutral'] as const),
    tradeType: oneOf(q.tradeType, ['Momentum Buy', 'Momentum Sell', 'Watch', 'Avoid'] as const),
    confidence: oneOf(q.confidence, ['High', 'Medium', 'Low'] as const),
    sector: q.sector ? String(q.sector).toUpperCase() : null,
    includeFactors: asBool(q.includeFactors),
    state: oneOf(q.state, SIGNAL_STATES),
    action: oneOf(q.action, SIGNAL_ACTIONS),
    minEntryQuality: asInt(q.minEntryQuality, 0, 0, 100),
    freshOnly: asBool(q.freshOnly),
  };
}

/** Apply the timing-layer filters. Shared by the board and the signals feed. */
export function applySignalFilters(rows: MomentumRow[], q: BoardQuery, cfg: MomentumConfig): MomentumRow[] {
  let out = rows;
  if (q.state) out = out.filter((r) => r.signal?.state === q.state);
  if (q.action) out = out.filter((r) => r.signal?.action === q.action);
  if (q.minEntryQuality > 0) out = out.filter((r) => (r.signal?.entryQuality ?? 0) >= q.minEntryQuality);
  if (q.freshOnly)
    out = out.filter((r) => r.signal?.trigger != null && r.signal.trigger.ageMin <= cfg.signal.maxTriggerAgeMin);
  return out;
}

/** NSE symbols carry `&` (GVT&D) and `-` (BAJAJ-AUTO), so both are allowed. */
export function parseSymbol(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) throw new ValidationError(['symbol is required']);
  if (!/^[A-Z0-9&._-]{1,30}$/.test(s)) throw new ValidationError([`"${s}" is not a valid NSE symbol`]);
  return s;
}

/* ------------------------------------------------------------------ config patch --- */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKnots(path: string, v: unknown, issues: string[]): void {
  if (!Array.isArray(v)) {
    issues.push(`${path} must be an array of {at, score}`);
    return;
  }
  if (!v.length) {
    issues.push(`${path} must have at least one knot`);
    return;
  }
  v.forEach((k, i) => {
    if (!isPlainObject(k) || !Number.isFinite(Number(k.at)) || !Number.isFinite(Number(k.score)))
      issues.push(`${path}[${i}] must be {at: number, score: number}`);
    else if (Number(k.score) < 0 || Number(k.score) > 100)
      issues.push(`${path}[${i}].score must be 0–100`);
  });
}

/** A key whose value should be a knot list, wherever it appears in the thresholds tree. */
const looksLikeKnotList = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && isPlainObject(v[0]) && 'at' in (v[0] as object) && 'score' in (v[0] as object);

function walkThresholds(node: unknown, path: string, issues: string[]): void {
  if (!isPlainObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    const p = `${path}.${k}`;
    if (Array.isArray(v)) {
      if (looksLikeKnotList(v) || /knots|Bps|Cr|Pct|rank|premium|Notional|Shift$/i.test(k)) checkKnots(p, v, issues);
      else issues.push(`${p} is an unexpected array`);
    } else if (isPlainObject(v)) {
      walkThresholds(v, p, issues);
    } else if (typeof v === 'number' && !Number.isFinite(v)) {
      issues.push(`${p} must be a finite number`);
    } else if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
      issues.push(`${p} has an unsupported type`);
    }
  }
}

/**
 * Validate a PATCH — every field is optional, but any field present must be well-formed.
 *
 * Unknown top-level keys are rejected rather than ignored: a typo in an admin panel that
 * silently does nothing is worse than an error, because the operator believes the change
 * took effect and the ranking they are looking at is not the one they configured.
 */
export function parseConfigPatch(body: unknown): DeepPartial<MomentumConfig> {
  if (!isPlainObject(body)) throw new ValidationError(['body must be a JSON object']);

  const issues: string[] = [];
  const allowed = new Set([
    'weights', 'scoring', 'confidence', 'thresholds', 'universe', 'refresh', 'output', 'signal',
    // Accepted and ignored: an admin panel that GETs the config and PUTs it back should not
    // be rejected for echoing the fields the server owns.
    'version', 'updatedAt', 'updatedBy',
  ]);

  for (const key of Object.keys(body)) if (!allowed.has(key)) issues.push(`unknown field "${key}"`);

  if ('weights' in body) {
    const w = body.weights;
    if (!isPlainObject(w)) issues.push('weights must be an object');
    else {
      let sum = 0;
      for (const [k, v] of Object.entries(w)) {
        if (!FACTOR_KEYS.includes(k as FactorKey)) { issues.push(`weights.${k} is not a factor`); continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) issues.push(`weights.${k} must be a number ≥ 0`);
        else sum += n;
      }
      // Weights need not total 100 — the engine normalises — but all-zero is not a model.
      if (Object.keys(w).length === FACTOR_KEYS.length && sum === 0)
        issues.push('weights cannot all be zero');
    }
  }

  if ('thresholds' in body) walkThresholds(body.thresholds, 'thresholds', issues);

  if ('scoring' in body && isPlainObject(body.scoring)) {
    const s = body.scoring;
    if ('maxScore' in s && (Number(s.maxScore) <= 0 || !Number.isFinite(Number(s.maxScore))))
      issues.push('scoring.maxScore must be > 0');
    if (isPlainObject(s.coherence) && 'maxPenalty' in s.coherence) {
      const p = Number(s.coherence.maxPenalty);
      if (!Number.isFinite(p) || p < 0 || p >= 1) issues.push('scoring.coherence.maxPenalty must be 0 ≤ p < 1');
    }
  }

  if ('universe' in body && isPlainObject(body.universe)) {
    const u = body.universe;
    if ('exclude' in u && !Array.isArray(u.exclude)) issues.push('universe.exclude must be an array of symbols');
    if ('shortlistSize' in u) {
      const n = Number(u.shortlistSize);
      if (!Number.isFinite(n) || n < 0) issues.push('universe.shortlistSize must be ≥ 0');
      // Not an error — the operator may know what they are doing — but the cost is linear
      // and the ceiling is real, so it is worth refusing the obviously unpayable.
      if (n > 208) issues.push('universe.shortlistSize cannot exceed the 208-stock F&O universe');
    }
  }

  if ('refresh' in body && isPlainObject(body.refresh)) {
    const r = body.refresh;
    if ('quoteMs' in r && Number(r.quoteMs) < 5000)
      issues.push('refresh.quoteMs below 5000 would exceed the Upstox rate limit');
    if ('enrichMs' in r && Number(r.enrichMs) < 15000)
      issues.push('refresh.enrichMs below 15000 would exceed the Upstox option-chain rate limit');
    // The timing layer's resolution is the poll interval. Said as an issue rather than
    // silently accepted, because a 3-minute ignition window sampled every 2 minutes is two
    // readings and every trigger it fires is already most of a window late.
    if ('quoteMs' in r && Number(r.quoteMs) > 60_000)
      issues.push('refresh.quoteMs above 60000 leaves the timing layer too few readings to detect an entry');
  }

  if ('signal' in body) {
    const s = body.signal;
    if (!isPlainObject(s)) issues.push('signal must be an object');
    else {
      for (const [k, v] of Object.entries(s)) {
        if (isPlainObject(v)) {
          for (const [k2, v2] of Object.entries(v)) {
            if (typeof v2 !== 'number' || !Number.isFinite(v2))
              issues.push(`signal.${k}.${k2} must be a finite number`);
          }
        } else if (typeof v !== 'number' && typeof v !== 'boolean') {
          issues.push(`signal.${k} must be a number or a boolean`);
        } else if (typeof v === 'number' && !Number.isFinite(v)) {
          issues.push(`signal.${k} must be a finite number`);
        }
      }
    }
  }

  if (issues.length) throw new ValidationError(issues);

  // The server owns provenance; a client cannot set its own version or author.
  const { version: _v, updatedAt: _a, updatedBy: _b, ...patch } = body as Record<string, unknown>;
  return patch as DeepPartial<MomentumConfig>;
}

/** Re-exported for the controller's error mapping. */
export const isValidationError = (e: unknown): e is ValidationError => e instanceof ValidationError;
