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
// So this writes it down. It is fed by the same 15-second quote poll everything else uses
// and costs no upstream call at all.
//
// THE RING IS ALSO THE TIMING LAYER'S ONLY INPUT. `pulse.service.ts` measures the last few
// minutes — velocity, interval volume, directional persistence, a pre-breakout base — and
// every one of those readings is a difference between two entries of this ring. That is what
// makes an early signal affordable across the whole 208-stock universe rather than for a
// shortlist: the poll that already happens is the intraday feed, so the ignition read costs
// nothing extra and is available on every stock, including the ones the score has not
// noticed yet.
//
// State is persisted after every update because the alternative is losing the morning to a
// restart: a process that comes up at 11:00 with no opening range cannot recover one from
// the quote feed, and would have that factor dark for the rest of the day. The ring is
// persisted for the same reason — a restart at 13:00 would otherwise have no price path and
// no leg, and the timing layer would sit at `ready: false` while the market moved.

import { store, STORE_KEYS } from '../store.js';
import { istDay, minuteOfSession } from '../session.js';
import type { MomentumQuote } from './quotes.js';
import type { TriggerKind } from '../types.js';

/**
 * ~25 minutes of 15-second polls.
 *
 * Sized off the longest window anything reads — `pulse.baseWindowMin` at 15 — plus enough
 * behind it to measure the base against what came before. Every reading is six numbers, so
 * the whole universe is ~200 symbols × 100 × 6, which serialises to a couple of megabytes
 * and is written at most once a cycle.
 */
const RING = 100;

/** A hard age cap as well as a count cap, so a slow poll cannot stretch the window silently. */
const MAX_READING_AGE_MS = 45 * 60_000;

export interface VwapReading {
  at: number;
  minute: number;
  vwap: number;
  volume: number;
  /** Cumulative rupee turnover, `vwap × volume`. Kept so interval VWAP is exact. */
  turnover: number;
  ltp: number;
  /** Session high and low as of this reading — how a new day extreme is dated. */
  high: number;
  low: number;
}

/**
 * The current directional swing, from an ATR-scaled zigzag.
 *
 * This is what lets the board answer "how long has this been going" without keeping a full
 * tick history. Price extends the leg while it makes new extremes and starts a new one when
 * it gives back `reversal` rupees, which is set from ATR so a 0.4% wobble ends a leg in
 * HDFCBANK and does not in a midcap that ranges 4% a day.
 *
 * The leg is the difference between "this stock is up 3%" and "this stock has been going up
 * for four minutes" — the second is a trade and the first is a fact about the past.
 */
export interface PriceLeg {
  direction: 1 | -1;
  startAt: number;
  startPrice: number;
  /** The furthest the leg has gone, and when. */
  extremeAt: number;
  extremePrice: number;
  /** The reversal distance in rupees this leg is being tracked with. */
  reversal: number;
}

/**
 * A trigger that has fired, kept so it has an AGE.
 *
 * Without this the board can only say "price is above the opening range", which is true for
 * the four hours after the break and says nothing about whether the break is new. What makes
 * a signal early is knowing it fired at 11:04, and that is only knowable by having recorded
 * it at 11:04.
 */
export interface FiredTrigger {
  kind: TriggerKind;
  direction: 1 | -1;
  at: number;
  price: number;
}

/** How many fired triggers are kept per symbol. Only the freshest is ever surfaced. */
const EVENT_RING = 8;

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
  /** The active directional swing. Null until price has moved enough to define one. */
  leg: PriceLeg | null;
  /** Triggers that have fired today, newest last. */
  events: FiredTrigger[];
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
  const sym = (s.symbols[symbol] ??= {
    readings: [], openingRange: null, lastAtmDelta: null, lastFuturesOi: null, leg: null, events: [],
  });
  // A state file written before the timing layer existed has neither field. Filled here
  // rather than at load, so one migration covers both the disk copy and anything a test
  // constructs by hand.
  sym.leg ??= null;
  sym.events ??= [];
  return sym;
}

/**
 * Fold one quote-tier reading into the session state.
 *
 * The opening range is captured continuously and frozen the moment the window closes. It is
 * taken from `ohlc.high`/`ohlc.low`, which are the session's extremes to date — so at any
 * point inside the first fifteen minutes they ARE the opening range so far, and at 09:30
 * they are the finished one.
 *
 * `reversalRupees` is the zigzag threshold for the leg tracker, passed in rather than derived
 * here because it comes from the ATR baseline, which this module deliberately does not know
 * about. Zero or absent means "no ATR for this symbol" and falls back to a percentage.
 */
export function observe(
  s: SessionState,
  q: MomentumQuote,
  openingMinutes: number,
  nowMs = Date.now(),
  reversalRupees = 0,
): void {
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
      high: q.high,
      low: q.low,
    });
    const cutoff = nowMs - MAX_READING_AGE_MS;
    while (sym.readings.length > 1 && sym.readings[0].at < cutoff) sym.readings.shift();
    if (sym.readings.length > RING) sym.readings.splice(0, sym.readings.length - RING);
    dirty = true;
  }

  trackLeg(sym, q.ltp, nowMs, reversalRupees);

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

/**
 * Advance the zigzag by one price.
 *
 * Extending an existing leg is free; ending one requires giving back the full reversal
 * distance from the extreme, which is what stops a leg being restarted by every tick against
 * it. The new leg starts AT THE OLD EXTREME, not at the current price — the turn happened up
 * there, and dating it from here would report every reversal as a few minutes younger and a
 * few rupees smaller than it was.
 */
function trackLeg(sym: SymbolSessionState, ltp: number, nowMs: number, reversalRupees: number): void {
  if (!(ltp > 0)) return;
  const reversal = reversalRupees > 0 ? reversalRupees : ltp * 0.0035;

  if (!sym.leg) {
    sym.leg = { direction: 1, startAt: nowMs, startPrice: ltp, extremeAt: nowMs, extremePrice: ltp, reversal };
    dirty = true;
    return;
  }

  const leg = sym.leg;
  leg.reversal = reversal;

  const extending = leg.direction === 1 ? ltp > leg.extremePrice : ltp < leg.extremePrice;
  if (extending) {
    leg.extremePrice = ltp;
    leg.extremeAt = nowMs;
    dirty = true;
    return;
  }

  const givenBack = leg.direction === 1 ? leg.extremePrice - ltp : ltp - leg.extremePrice;
  if (givenBack >= reversal) {
    sym.leg = {
      direction: leg.direction === 1 ? -1 : 1,
      startAt: leg.extremeAt,
      startPrice: leg.extremePrice,
      extremeAt: nowMs,
      extremePrice: ltp,
      reversal,
    };
    dirty = true;
  }
}

/**
 * Record that a trigger fired, unless the same one already fired inside the cooldown.
 *
 * Returns the live trigger either way, so the caller always has the FIRST firing's timestamp
 * and price rather than this cycle's. That is the whole point: a signal's age is measured
 * from when the move began, and re-stamping it every cycle would make every trigger
 * permanently fifteen seconds old and permanently "fresh".
 */
export function recordTrigger(
  sym: SymbolSessionState,
  kind: TriggerKind,
  direction: 1 | -1,
  price: number,
  nowMs: number,
  cooldownMs: number,
): FiredTrigger {
  sym.events ??= [];
  const existing = [...sym.events]
    .reverse()
    .find((e) => e.kind === kind && e.direction === direction && nowMs - e.at < cooldownMs);
  if (existing) return existing;

  const fired: FiredTrigger = { kind, direction, at: nowMs, price };
  sym.events.push(fired);
  if (sym.events.length > EVENT_RING) sym.events.splice(0, sym.events.length - EVENT_RING);
  dirty = true;
  return fired;
}

/** The most recent trigger, whatever kind. Null when nothing has fired today. */
export const lastTrigger = (sym: SymbolSessionState | undefined): FiredTrigger | null =>
  sym?.events?.length ? sym.events[sym.events.length - 1] : null;

/**
 * The reading closest to `msAgo` before now, or null when the ring does not reach back
 * that far. Closest rather than first-older-than, because at a 15-second poll the two
 * differ by up to a whole interval and every velocity would inherit that bias.
 */
export function readingAt(sym: SymbolSessionState | undefined, msAgo: number, nowMs: number): VwapReading | null {
  const r = sym?.readings ?? [];
  if (r.length < 2) return null;
  const target = nowMs - msAgo;
  if (r[0].at > target) return null; // the window predates the ring — do not pretend otherwise

  let best = r[0];
  for (const p of r) {
    if (Math.abs(p.at - target) < Math.abs(best.at - target)) best = p;
  }
  return best;
}

/** Every reading at or after `msAgo`. The slice the pulse windows are measured over. */
export function readingsSince(sym: SymbolSessionState | undefined, msAgo: number, nowMs: number): VwapReading[] {
  const from = nowMs - msAgo;
  return (sym?.readings ?? []).filter((p) => p.at >= from);
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

/**
 * The shortest gap between two writes.
 *
 * The ring grew from 30 readings to 100 when the timing layer started reading it, which took
 * the serialised state from a few hundred kilobytes to a couple of megabytes — and the scan
 * interval halved to 15 seconds at the same time. Writing all of it every cycle is ~2MB of
 * `JSON.stringify` plus a file replace eight times a minute, for state that is worth at most
 * a few seconds of warm-up on a restart.
 *
 * Thirty seconds is the trade: a crash costs at most that much of the price ring, which
 * refills within one pulse window, while the opening range and any fired trigger were
 * already written by an earlier flush.
 */
const MIN_FLUSH_MS = 30_000;
let lastFlushAt = 0;

/**
 * Persist, at most one write in flight and at most one per `MIN_FLUSH_MS`.
 *
 * Called after a full cycle, not per symbol. `force` is for the paths where losing the
 * write actually costs something — the end of a session, or a deliberate shutdown.
 */
export async function flushSessionState(force = false, nowMs = Date.now()): Promise<void> {
  if (!dirty || !state) return;
  if (flushing) return flushing;
  if (!force && nowMs - lastFlushAt < MIN_FLUSH_MS) return;

  dirty = false;
  lastFlushAt = nowMs;
  const payload = state;
  flushing = store.write(STORE_KEYS.session, payload).finally(() => { flushing = null; });
  return flushing;
}

/** Test seam — drops the in-memory copy so the next read comes off disk. */
export const resetSessionState = (): void => { state = null; dirty = false; lastFlushAt = 0; };
