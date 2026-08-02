// The things that are only knowable by having been watching.
//
// Two factors need a reading from EARLIER TODAY, which no endpoint serves:
//
//   VWAP slope       Upstox gives the session VWAP as a level. Whether it is rising is the
//                    difference between a trend and a fade, and it is only visible across
//                    two readings.
//
//   Opening range    the 09:15–09:30 high and low. It exists in the 1-minute candles, but
//                    fetching them for 208 stocks every cycle is 208 requests the budget
//                    does not have — whereas `ohlc.high/low` in the Tier-A quote IS the
//                    opening range at 09:30, for free, if someone writes it down.
//
// So this writes it down. It is fed by the same 30-second quote poll everything else uses
// and costs no upstream call at all.
//
// State is persisted after every update because the alternative is losing the morning to a
// restart: a process that comes up at 11:00 with no opening range cannot recover one from
// the quote feed, and would have that factor dark for the rest of the day.

import { store, STORE_KEYS } from '../store.js';
import { istDay, minuteOfSession } from '../session.js';
import type { MomentumQuote } from './quotes.js';

/** ~15 minutes of 30-second polls. Enough to measure a slope, small enough to persist. */
const RING = 30;

export interface VwapReading {
  at: number;
  minute: number;
  vwap: number;
  volume: number;
  /** Cumulative rupee turnover, `vwap × volume`. Kept so interval VWAP is exact. */
  turnover: number;
  ltp: number;
}

export interface OpeningRange {
  high: number;
  low: number;
  /** True once the configured opening window has elapsed and the range is final. */
  complete: boolean;
  minutes: number;
}

export interface SymbolSessionState {
  readings: VwapReading[];
  openingRange: OpeningRange | null;
  /** ATM delta from the last enrichment pass, for a measured (not modelled) delta shift. */
  lastAtmDelta: { at: number; delta: number } | null;
  /** Futures open interest from the last enrichment pass. */
  lastFuturesOi: { at: number; oi: number } | null;
}

export interface SessionState {
  day: string;
  symbols: Record<string, SymbolSessionState>;
}

let state: SessionState | null = null;
let dirty = false;
let flushing: Promise<void> | null = null;

const empty = (day: string): SessionState => ({ day, symbols: {} });

async function load(day: string): Promise<SessionState> {
  if (state && state.day === day) return state;
  const disk = await store.read<SessionState>(STORE_KEYS.session);
  // A file from an earlier session is not state, it is yesterday: an opening range from
  // Friday applied to Monday would fire an ORB signal on every stock that gapped.
  state = disk && disk.day === day ? disk : empty(day);
  return state;
}

export async function sessionState(nowMs = Date.now()): Promise<SessionState> {
  return load(istDay(nowMs));
}

function forSymbol(s: SessionState, symbol: string): SymbolSessionState {
  return (s.symbols[symbol] ??= { readings: [], openingRange: null, lastAtmDelta: null, lastFuturesOi: null });
}

/**
 * Fold one quote-tier reading into the session state.
 *
 * The opening range is captured continuously and frozen the moment the window closes. It is
 * taken from `ohlc.high`/`ohlc.low`, which are the session's extremes to date — so at any
 * point inside the first fifteen minutes they ARE the opening range so far, and at 09:30
 * they are the finished one.
 */
export function observe(s: SessionState, q: MomentumQuote, openingMinutes: number, nowMs = Date.now()): void {
  const minute = minuteOfSession(nowMs);
  if (minute <= 0) return; // pre-open: nothing has traded, and ohlc is last session's shell

  const sym = forSymbol(s, q.symbol);

  const last = sym.readings[sym.readings.length - 1];
  // Skip a reading that carries no new trade — outside market hours the feed repeats the
  // closing print, and a flat tail would drag a real slope toward zero.
  if (!last || q.volume > last.volume || Math.abs(q.vwap - last.vwap) > 1e-9) {
    sym.readings.push({
      at: nowMs,
      minute,
      vwap: q.vwap,
      volume: q.volume,
      turnover: q.vwap * q.volume,
      ltp: q.ltp,
    });
    if (sym.readings.length > RING) sym.readings.splice(0, sym.readings.length - RING);
    dirty = true;
  }

  if (!sym.openingRange?.complete && q.high > 0 && q.low > 0) {
    sym.openingRange = {
      high: q.high,
      low: q.low,
      complete: minute >= openingMinutes,
      minutes: openingMinutes,
    };
    dirty = true;
  }
}

/** Record an enrichment-tier reading, so the next pass can measure what changed. */
export function observeEnrichment(
  s: SessionState,
  symbol: string,
  reading: { atmDelta?: number | null; futuresOi?: number | null },
  nowMs = Date.now(),
): void {
  const sym = forSymbol(s, symbol);
  if (reading.atmDelta != null && Number.isFinite(reading.atmDelta))
    sym.lastAtmDelta = { at: nowMs, delta: reading.atmDelta };
  if (reading.futuresOi != null && Number.isFinite(reading.futuresOi))
    sym.lastFuturesOi = { at: nowMs, oi: reading.futuresOi };
  dirty = true;
}

/**
 * VWAP slope in percent per minute, over the readings held.
 *
 * A least-squares fit rather than (last − first) / elapsed: VWAP ticks in small increments
 * and a two-point slope is dominated by whichever end happened to land on a tick boundary.
 * Returns null until there are enough readings spanning enough time to mean anything.
 */
export function vwapSlopePctPerMin(sym: SymbolSessionState | undefined, minReadings = 3, minSpanMin = 2): number | null {
  const r = sym?.readings ?? [];
  if (r.length < minReadings) return null;

  const span = (r[r.length - 1].at - r[0].at) / 60_000;
  if (span < minSpanMin) return null;

  const base = r[0].vwap;
  if (!(base > 0)) return null;

  const t0 = r[0].at;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of r) {
    const x = (p.at - t0) / 60_000;
    const y = ((p.vwap - base) / base) * 100;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = r.length;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return +(((n * sxy - sx * sy) / denom)).toFixed(5);
}

/**
 * VWAP of the trades since the oldest held reading.
 *
 * `Δturnover / Δvolume` — the average price of what actually traded in the window, which is
 * a cleaner "where is the money now" than the session VWAP that includes the open. Above
 * the session VWAP means the recent tape is paying up.
 */
export function intervalVwap(sym: SymbolSessionState | undefined): number | null {
  const r = sym?.readings ?? [];
  if (r.length < 2) return null;
  const dv = r[r.length - 1].volume - r[0].volume;
  const dt = r[r.length - 1].turnover - r[0].turnover;
  if (dv <= 0 || dt <= 0) return null;
  return +(dt / dv).toFixed(3);
}

/** Persist, at most one write in flight. Called after a full cycle, not per symbol. */
export async function flushSessionState(): Promise<void> {
  if (!dirty || !state) return;
  if (flushing) return flushing;
  dirty = false;
  const payload = state;
  flushing = store.write(STORE_KEYS.session, payload).finally(() => { flushing = null; });
  return flushing;
}

/** Test seam — drops the in-memory copy so the next read comes off disk. */
export const resetSessionState = (): void => { state = null; dirty = false; };
