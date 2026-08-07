// The multi-timeframe bar store — and the reason this scanner is affordable at all.
//
// THE PROBLEM. The brief asks for 9/20/50/200 EMA, VWAP, ADX and swing structure on 1, 3, 5
// and 15 minutes, for every F&O stock and four indices. Fetched naively that is 215 symbols ×
// 4 timeframes = 860 candle requests per cycle against an endpoint that allows 2000 per THIRTY
// MINUTES. The scanner would work for about seventy seconds a day.
//
// Three observations collapse it to something payable:
//
//   1. ONE REQUEST IS ALL FOUR TIMEFRAMES. Upstox serves a 20-calendar-day range of 1-minute
//      candles in a single call — about fourteen sessions, 5,250 bars — and 3, 5 and 15 minute
//      bars are exact sums of those. There is no such thing as a "15-minute request".
//
//   2. ONE REQUEST IS ALSO THE WHOLE 200-BAR WARM-UP. A 200-period EMA on a 15-minute chart
//      spans 3,000 session-minutes, or eight trading days. It cannot be computed from today,
//      and it does not have to be recomputed after today: fourteen sessions of history built
//      once before the open covers every average on every timeframe with room to spare.
//
//   3. BARS CAN BE BUILT FROM THE QUOTE POLL. The scan already reads every instrument's price,
//      cumulative volume and cumulative turnover every thirty seconds. Bucketing those by
//      minute-of-session produces bars directly, at no upstream cost, for the entire universe.
//
// So there are three tiers, and each exists because the tier above it cannot do that job:
//
//   SEED     once a day, ~215 requests. History through yesterday, every timeframe.
//   CATCH-UP once a day (and after any restart), ~215 requests. Today's closed bars, exact.
//   LIVE     every scan, ZERO requests. The quote poll extends today's bars as they form.
//   RESYNC   a handful of requests a minute, candidates only. Replaces poll-built bars with
//            the exchange's own, so the bars a SIGNAL is computed from are exact even though
//            the bars the SCAN is computed from are approximate.
//
// WHAT A POLL-BUILT BAR GETS WRONG, stated plainly because it is the module's one real
// compromise: its close is exact (the last print observed) and its volume is exact at the poll
// boundaries (a delta of a cumulative counter), but its HIGH AND LOW are only as good as the
// sampling. A spike that began and ended between two polls was never seen. Every close-based
// reading here — all four EMAs, VWAP, the confirmation candle's body — is unaffected. ATR and
// ADX read the extremes and will run slightly narrow on a poll-built bar, which biases them
// toward NOT signalling. That is the right direction for the error to point, and the resync
// tier removes it for anything that is about to become a signal.

import { historical, todaySession, inBatches, CANDLE_ENDPOINT } from '../../momentum/data/candles.js';
import { throttledFor } from '../../momentum/data/throttle.js';
import { istDay, isoDaysBefore, minuteOfSession, SESSION_MINUTES } from '../../momentum/session.js';
import { store } from '../../momentum/store.js';
import { PULLBACK_KEYS } from '../config/config.repository.js';
import { adxLast } from '../indicators/adx.js';
import { atrSeries } from '../indicators/atr.js';
import { emaOfCloses, slopeAtrPerBar, vwapSeries } from '../indicators/ema.js';
import { readStructure } from '../indicators/structure.js';
import {
  fromCandle, mergeExact, newAggregator, observeBar, resample, trim,
  type Aggregator, type Bar, type Observation,
} from '../indicators/series.js';
import { TIMEFRAMES, type PullbackConfig, type Timeframe, type TimeframeRead } from '../types.js';
import type { Member } from './universe.js';
import type { Tick } from './quotes.js';

/**
 * Bars kept per timeframe.
 *
 * Sized off the longest thing that reads them: a 200-period EMA plus enough behind it for the
 * ADX seeding (2 × period) and the slope fit. On 15 minutes that is 320 bars = 4,800
 * session-minutes ≈ 12.8 sessions, which is what sets the seed window below.
 */
export const MAX_BARS = 320;

/** Calendar days of 1-minute history the seed asks for. ~14 sessions. */
const SEED_DAYS = 20;

/** Symbols in flight during a seed or catch-up. Matches what `baseline.ts` measured safe. */
const SEED_BATCH = 5;

/** Wilder periods. Both are the desk convention and neither is worth making configurable. */
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;

/** Bars the EMA slope is fitted over. Five is enough to be stable and short enough to be now. */
const SLOPE_LOOKBACK = 5;

export interface SymbolFrames {
  symbol: string;
  seriesKey: string;
  /** Closed bars per timeframe, oldest first. Never contains the bar still forming. */
  bars: Map<Timeframe, Bar[]>;
  agg: Map<Timeframe, Aggregator>;
  lastObs: Observation | null;
  /** The session these bars belong to. A mismatch means the whole store is yesterday's. */
  day: string;
  /** The last day the seed covers. Behind today means the seed is due a rebuild. */
  seededThrough: string | null;
  /** Whether today's closed bars have been fetched from the exchange at least once. */
  caughtUp: boolean;
  resyncedAt: number;
  note?: string;
}

export interface FrameStore {
  day: string;
  symbols: Map<string, SymbolFrames>;
  seedBuiltAt: number;
  /** Symbols the seed could not cover, with the reason. Surfaces as a board warning. */
  seedFailures: Record<string, string>;
}

let storeState: FrameStore | null = null;
let seeding: Promise<void> | null = null;

const emptyFrames = (symbol: string, seriesKey: string, day: string): SymbolFrames => ({
  symbol,
  seriesKey,
  bars: new Map(TIMEFRAMES.map((tf) => [tf, [] as Bar[]])),
  agg: new Map(TIMEFRAMES.map((tf) => [tf, newAggregator(tf)])),
  lastObs: null,
  day,
  seededThrough: null,
  caughtUp: false,
  resyncedAt: 0,
});

export function frameStore(nowMs = Date.now()): FrameStore {
  const day = istDay(nowMs);
  if (!storeState || storeState.day !== day) {
    // A store from an earlier session is not state, it is yesterday. Today's bars are dropped
    // outright; the historical part is restored by the seed, which by 08:00 includes the
    // session that has just ended.
    storeState = { day, symbols: new Map(), seedBuiltAt: 0, seedFailures: {} };
  }
  return storeState;
}

export function framesFor(symbol: string, seriesKey: string, nowMs = Date.now()): SymbolFrames {
  const s = frameStore(nowMs);
  let f = s.symbols.get(symbol);
  if (!f || f.seriesKey !== seriesKey) {
    // A changed series key means the futures contract rolled. The old contract's bars describe
    // a different instrument at a different price, and splicing them onto the new one would
    // print a gap the size of the basis as a genuine range expansion.
    f = emptyFrames(symbol, seriesKey, s.day);
    s.symbols.set(symbol, f);
  }
  return f;
}

/* --------------------------------------------------------------------- persistence --- */

/** [at, open, high, low, close, volume, turnover, synthetic]. */
type PackedBar = [number, number, number, number, number, number, number, number];

interface SeedFile {
  /** The last session the seed covers. */
  day: string;
  builtAt: number;
  /** symbol -> timeframe -> packed bars. */
  symbols: Record<string, Partial<Record<string, PackedBar[]>>>;
  failures: Record<string, string>;
}

const pack = (b: Bar): PackedBar => [b.at, b.open, b.high, b.low, b.close, b.volume, b.turnover, b.synthetic ? 1 : 0];

const unpack = (p: PackedBar): Bar => {
  const at = p[0];
  const d = new Date(at + 330 * 60_000);
  return {
    at,
    day: d.toISOString().slice(0, 10),
    minute: d.getUTCHours() * 60 + d.getUTCMinutes() - (9 * 60 + 15),
    open: p[1], high: p[2], low: p[3], close: p[4], volume: p[5], turnover: p[6],
    synthetic: p[7] === 1,
  };
};

/**
 * The seed is persisted; today is not.
 *
 * Written once a day, read once at boot. Today's bars are deliberately NOT persisted, and the
 * reasoning is worth stating because the obvious alternative is worse: a restart at 13:00 that
 * restored poll-built morning bars from disk would come back with APPROXIMATE highs and lows
 * for the whole session, where a restart that simply re-runs the catch-up comes back with the
 * exchange's own. The recovery costs one request per symbol and produces better data than was
 * lost, so there is nothing to save.
 */
async function writeSeed(day: string, s: FrameStore): Promise<void> {
  const symbols: SeedFile['symbols'] = {};
  for (const [symbol, f] of s.symbols) {
    const packed: Partial<Record<string, PackedBar[]>> = {};
    for (const [tf, bars] of f.bars) packed[String(tf)] = bars.map(pack);
    symbols[symbol] = packed;
  }
  await store.write<SeedFile>(PULLBACK_KEYS.seed, {
    day, builtAt: Date.now(), symbols, failures: s.seedFailures,
  });
}

/** Restore the seed from disk. Returns the day it covers, or null when there is none. */
export async function loadSeed(members: Member[], nowMs = Date.now()): Promise<string | null> {
  const file = await store.read<SeedFile>(PULLBACK_KEYS.seed);
  if (!file?.symbols) return null;

  const s = frameStore(nowMs);
  for (const m of members) {
    const packed = file.symbols[m.symbol];
    if (!packed) continue;
    const f = framesFor(m.symbol, m.seriesKey, nowMs);
    for (const tf of TIMEFRAMES) {
      const rows = packed[String(tf)];
      if (rows?.length) f.bars.set(tf, rows.map(unpack));
    }
    f.seededThrough = file.day;
  }
  s.seedBuiltAt = file.builtAt ?? 0;
  s.seedFailures = file.failures ?? {};
  return file.day;
}

/* --------------------------------------------------------------------------- seed --- */

/** Resample one 1-minute series into every timeframe and store it, trimmed. */
function install(f: SymbolFrames, oneMinute: Bar[], timeframes: Timeframe[]): void {
  for (const tf of timeframes) {
    const bars = tf === 1 ? oneMinute.filter((b) => b.minute >= 0) : resample(oneMinute, tf);
    f.bars.set(tf, trim(bars, MAX_BARS));
  }
}

/**
 * Build the historical part of every symbol's frames, through YESTERDAY.
 *
 * Deliberately exclusive of today, which is the same rule `momentum/data/baseline.ts` applies
 * to its volume profile and for a related reason: this array is what today's bars are appended
 * to, and a seed that already contained a partial today would have the morning's bars twice —
 * once from the historical endpoint and once from the catch-up — with the duplicates landing
 * inside the EMA recursion where they are invisible.
 *
 * Partial success is normal and fine. A symbol Upstox will not serve loses its own frames, not
 * everyone else's, and `seedFailures` says which and why.
 */
export async function buildSeed(
  members: Member[],
  cfg: PullbackConfig,
  nowMs = Date.now(),
): Promise<{ day: string; covered: number; throttled: number; failures: Record<string, string> }> {
  const today = istDay(nowMs);
  const yesterday = isoDaysBefore(1, today);
  const from = isoDaysBefore(SEED_DAYS, today);
  const s = frameStore(nowMs);
  const failures: Record<string, string> = {};
  let covered = 0;
  /**
   * Symbols this pass could not reach because the budget was gone, as opposed to because Upstox
   * will not serve them.
   *
   * The distinction is what lets the caller decide whether retrying is worth anything, and there is
   * no way to recover it from `failures` without matching on message text. A throttled symbol will
   * succeed in the next window; one with fourteen days and no candles will fail identically
   * forever, and a scheduler that cannot tell them apart either gives up with the board three
   * quarters lit or retries a permanent failure every five minutes for the rest of the session.
   */
  let throttled = 0;

  await inBatches(members, SEED_BATCH, async (m) => {
    /**
     * ALREADY DONE IS DONE, and without this the build cannot converge on a constrained budget.
     *
     * A seed is 212 requests against a 2000-per-30-minute ceiling shared with the resync tier and
     * with anything else reading candles. When the budget is tight the build gets part way — 105 of
     * 212 on the session this was written for — and stops. The retry five minutes later then
     * started again from the FIRST symbol, re-fetched the 105 it already had, and ran out at
     * roughly the same place. It repeated that indefinitely: a board permanently half dark, no
     * error anywhere, and a `covered` figure that looked like steady progress and was the same 105
     * symbols every time.
     *
     * Skipping what is already seeded through the target day turns that loop into a walk. The
     * second pass spends its budget on the symbols the first could not reach, and coverage
     * accumulates across as many windows as it needs.
     */
    const existing = s.symbols.get(m.symbol);
    if (existing && existing.seriesKey === m.seriesKey && existing.seededThrough === yesterday) {
      covered++;
      return;
    }

    // Once the breaker is open every remaining symbol would fail identically. Skipping them
    // keeps the build honest about why it stopped and stops it spending the next window's
    // budget too — the lesson `momentum/data/throttle.ts` was written for.
    if (throttledFor(CANDLE_ENDPOINT, Date.now()) > 0) {
      failures[m.symbol] = 'skipped — Upstox candle endpoint rate limited';
      throttled++;
      return;
    }
    try {
      const candles = await historical(m.seriesKey, 'minutes', 1, from, yesterday);
      const oneMinute = candles.filter((c) => c.minute >= 0 && c.minute <= SESSION_MINUTES).map(fromCandle);
      if (oneMinute.length < 200) {
        failures[m.symbol] = `only ${oneMinute.length} minute bars in ${SEED_DAYS} days`;
        return;
      }
      const f = framesFor(m.symbol, m.seriesKey, nowMs);
      install(f, oneMinute, cfg.timeframes.computed);
      f.seededThrough = yesterday;
      f.caughtUp = false;
      covered++;
    } catch (e) {
      const message = String((e as Error).message);
      failures[m.symbol] = message;
      if (message.includes('429') || message.includes('rate limited')) throttled++;
    }
  });

  s.seedFailures = failures;
  s.seedBuiltAt = nowMs;

  /**
   * PARTIAL PROGRESS IS PERSISTED, which is the opposite of what this did and the change follows
   * directly from the skip above.
   *
   * The old rule was "keep an older seed rather than overwrite it with a throttled fragment", at a
   * 50% bar. That was right when a rebuild started from scratch every time — a fragment really was
   * worth less than yesterday's complete seed. It is wrong now that coverage ACCUMULATES: the store
   * is a superset of whatever was loaded from disk for this day, so writing it back can only ever
   * add symbols, and refusing to write until 50% means a build that reaches 49% loses all of it to
   * the next restart and starts again from nothing. That is exactly the loop observed — 105 of 212,
   * repeatedly, for hours.
   *
   * The floor stays, at a quarter rather than a half, purely to stop a build that failed on its
   * first batch from replacing a good seed with a handful of symbols.
   */
  if (covered >= members.length * 0.25) await writeSeed(yesterday, s);

  return { day: yesterday, covered, throttled, failures };
}

/** Kick a seed build, collapsing concurrent callers onto one run. */
export function ensureSeed(members: Member[], cfg: PullbackConfig, nowMs = Date.now()): Promise<void> {
  if (!seeding) seeding = buildSeed(members, cfg, nowMs).then(() => {}).finally(() => { seeding = null; });
  return seeding;
}

/* ---------------------------------------------------------------------- catch-up --- */

/** A tf-bar opening at `minute` is closed once the session has passed its far edge. */
const isClosed = (minute: number, tf: number, now: number): boolean => minute + tf <= now;

/**
 * Fetch today's closed bars from the exchange and splice them in.
 *
 * Run once a day per symbol, and again after any restart. `mergeExact` means running it more
 * often is harmless — exchange bars overwrite poll-built ones for the same bucket — which is
 * exactly what the resync tier relies on.
 */
export async function catchUpToday(
  members: Member[],
  cfg: PullbackConfig,
  nowMs = Date.now(),
): Promise<{ covered: number; failures: Record<string, string> }> {
  const today = istDay(nowMs);
  const now = minuteOfSession(nowMs);
  const failures: Record<string, string> = {};
  let covered = 0;

  await inBatches(members, SEED_BATCH, async (m) => {
    if (throttledFor(CANDLE_ENDPOINT, Date.now()) > 0) {
      failures[m.symbol] = 'skipped — Upstox candle endpoint rate limited';
      return;
    }
    try {
      await applyExact(m, cfg, today, now, nowMs);
      covered++;
    } catch (e) {
      failures[m.symbol] = String((e as Error).message);
    }
  });

  return { covered, failures };
}

/**
 * Replace today's bars for one symbol with the exchange's own.
 *
 * Shared by the catch-up pass and the per-candidate resync, because they are the same
 * operation at different cadences — and having one implementation is what guarantees a
 * resynced row and a caught-up row are computed from identically-shaped data.
 */
async function applyExact(
  m: Member,
  cfg: PullbackConfig,
  today: string,
  nowMinute: number,
  nowMs: number,
): Promise<void> {
  const candles = await todaySession(m.seriesKey, today, 1);
  const oneMinute = candles
    .filter((c) => c.day === today && c.minute >= 0 && c.minute <= SESSION_MINUTES)
    .map(fromCandle);
  if (!oneMinute.length) return;

  const f = framesFor(m.symbol, m.seriesKey, nowMs);
  for (const tf of cfg.timeframes.computed) {
    const exact = (tf === 1 ? oneMinute : resample(oneMinute, tf)).filter((b) => isClosed(b.minute, tf, nowMinute));
    if (!exact.length) continue;
    const merged = mergeExact(f.bars.get(tf) ?? [], exact);
    f.bars.set(tf, trim(merged, MAX_BARS));
  }
  f.caughtUp = true;
  f.resyncedAt = nowMs;
}

/** Resync one symbol's bars from the exchange. The candidate tier. */
export async function resync(m: Member, cfg: PullbackConfig, nowMs = Date.now()): Promise<void> {
  await applyExact(m, cfg, istDay(nowMs), minuteOfSession(nowMs), nowMs);
}

/* -------------------------------------------------------------------------- live --- */

/**
 * Fold one quote reading into every timeframe.
 *
 * A bar is only appended once the observation crosses into the NEXT bucket, so `bars` never
 * contains a bar that is still forming and no indicator ever sees one. That single rule is
 * what keeps this scanner agreeing with the chart the trade is taken from: an EMA recomputed
 * on a partial 15-minute bar shows a trend appearing and vanishing inside one candle, and
 * every gate in the module would toggle with it.
 *
 * A closed bar is only kept when it is genuinely newer than what is already stored, so a poll
 * cannot overwrite an exact exchange bar the catch-up already installed.
 */
export function observe(f: SymbolFrames, tick: Tick, day: string, minute: number, timeframes: Timeframe[]): void {
  if (minute < 0 || !(tick.ltp > 0)) return;

  const obs: Observation = {
    at: tick.at || Date.now(),
    day,
    minute,
    price: tick.ltp,
    cumulativeVolume: tick.volume,
    cumulativeTurnover: tick.turnover,
  };

  for (const tf of timeframes) {
    const agg = f.agg.get(tf);
    if (!agg) continue;
    const closed = observeBar(agg, obs, f.lastObs);
    if (!closed) continue;

    const bars = f.bars.get(tf) ?? [];
    const tail = bars[bars.length - 1];
    if (!tail || closed.day > tail.day || (closed.day === tail.day && closed.minute > tail.minute)) {
      bars.push(closed);
      trim(bars, MAX_BARS);
      f.bars.set(tf, bars);
    }
  }

  f.lastObs = obs;
}

/* ------------------------------------------------------------------------- read --- */

/**
 * Every indicator that has a value AT EVERY BAR, computed once.
 *
 * The frame read only needs the last element of each; the pullback detector needs the whole
 * series, because it tests "did the low of the bar forty minutes ago reach the zone AS THAT
 * ZONE WAS AT THAT BAR" — and on a trending stock the band travels a fifth of an ATR a bar, so
 * testing a historical bar against today's zone silently converts "price came back to the
 * average" into "the average came up to price". Computing this once and handing it to both is
 * what keeps them from disagreeing.
 */
export interface FrameSeries {
  ema9: Array<number | null>;
  ema20: Array<number | null>;
  ema50: Array<number | null>;
  ema200: Array<number | null>;
  vwap: Array<number | null>;
  atr: Array<number | null>;
}

export function computeSeries(bars: Bar[]): FrameSeries {
  return {
    ema9: emaOfCloses(bars, 9),
    ema20: emaOfCloses(bars, 20),
    ema50: emaOfCloses(bars, 50),
    ema200: emaOfCloses(bars, 200),
    vwap: vwapSeries(bars),
    atr: atrSeries(bars, ATR_PERIOD),
  };
}

/**
 * Everything measurable on one timeframe.
 *
 * Recomputed from the bar array on every scan rather than carried incrementally. That is a
 * deliberate trade of a little CPU — ten passes over ~320 numbers, per timeframe, per symbol,
 * which is a few tens of milliseconds for the whole universe — for the elimination of an
 * entire class of bug: incremental indicator state drifts, and it drifts silently, and the
 * only symptom is a scanner that slowly stops agreeing with the chart over the course of a
 * session. Recomputation cannot drift.
 *
 * `series` is accepted rather than always computed so the caller can share one set with the
 * pullback detector; omitting it is correct and simply costs the six passes again.
 */
export function readFrame(
  f: SymbolFrames,
  tf: Timeframe,
  cfg: PullbackConfig,
  series?: FrameSeries,
): TimeframeRead {
  return readFromBars(f.bars.get(tf) ?? [], tf, cfg, f.agg.get(tf)?.forming ?? null, series);
}

/**
 * The same read, from a bare bar array.
 *
 * This is the seam the backtest runs through, and its existence is the whole reason the backtest
 * is worth anything: the replay walks a historical series bar by bar and calls THIS, so the
 * indicators, the trend gates, the pullback detector and the scorer it exercises are the same
 * code paths the live scanner exercises. A backtest that shared only formulas with the live
 * engine would be testing a second implementation of the strategy, and the discrepancies would
 * all land in the direction of the backtest looking better.
 */
export function readFromBars(
  bars: Bar[],
  tf: Timeframe,
  cfg: PullbackConfig,
  forming: Bar | null = null,
  series?: FrameSeries,
): TimeframeRead {
  const i = bars.length - 1;

  const base: TimeframeRead = {
    timeframe: tf,
    bars: bars.length,
    lastClosedAt: i >= 0 ? bars[i].at : null,
    forming,
    ema: { ema9: null, ema20: null, ema50: null, ema200: null },
    slope: { ema9AtrPerBar: null, ema20AtrPerBar: null, vwapAtrPerBar: null },
    vwap: null,
    atr: null,
    adx: { adx: null, plusDi: null, minusDi: null, rising: null },
    structure: {
      higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false, steps: 0,
      lastSwingHigh: null, lastSwingLow: null, priorSwingHigh: null, priorSwingLow: null,
    },
    avgVolume: null,
    volumeRatio: null,
    participation: null,
    close: i >= 0 ? bars[i].close : null,
    distance: { ema9Atr: null, ema20Atr: null, ema50Atr: null, vwapAtr: null },
    warming: bars.length < cfg.timeframes.minBars,
  };

  if (base.warming) {
    base.note = `${bars.length} closed bars — needs ${cfg.timeframes.minBars} before anything here is read`;
    return base;
  }

  const s = series ?? computeSeries(bars);
  const { ema9: e9, ema20: e20, ema50: e50, ema200: e200, vwap: vw, atr: atrs } = s;

  const atr = atrs[i];
  const close = bars[i].close;

  base.ema = { ema9: e9[i], ema20: e20[i], ema50: e50[i], ema200: e200[i] };
  base.vwap = vw[i];
  base.atr = atr === null ? null : +atr.toFixed(3);
  base.adx = adxLast(bars, ADX_PERIOD);

  base.slope = {
    ema9AtrPerBar: slopeAtrPerBar(e9, atr, SLOPE_LOOKBACK),
    ema20AtrPerBar: slopeAtrPerBar(e20, atr, SLOPE_LOOKBACK),
    vwapAtrPerBar: slopeAtrPerBar(vw, atr, SLOPE_LOOKBACK),
  };

  // The direction the structure is TESTED in comes from the EMA stack, not from the structure
  // itself. `structure.ts` explains why a reader that picks its own direction is a liability:
  // it will happily report a textbook downtrend structure on a row the rest of the model has
  // decided is bullish, and nothing then says which reading is the answer.
  const provisional: 1 | -1 = (e9[i] ?? 0) >= (e20[i] ?? 0) ? 1 : -1;
  base.structure = readStructure(bars, provisional);

  const lookback = cfg.timeframes.volumeLookback;
  // The confirmation's denominator EXCLUDES the bar being judged. Including it would let a huge
  // bar raise its own benchmark, and the expansion test would drift toward 1.0 exactly when it
  // should be spiking — the same trap `momentum/data/baseline.ts` documents for RVOL.
  const window = bars.slice(-Math.max(2, lookback + 1), -1);
  const avg = window.length ? window.reduce((a, b) => a + b.volume, 0) / window.length : 0;
  base.avgVolume = avg > 0 ? Math.round(avg) : null;
  base.volumeRatio = avg > 0 ? +(bars[i].volume / avg).toFixed(2) : null;

  // Participation: this window against the window before it. See `TimeframeRead.participation`
  // for why the trend gate reads this and not the single-bar ratio.
  if (bars.length >= lookback * 2) {
    const recent = bars.slice(-lookback);
    const prior = bars.slice(-lookback * 2, -lookback);
    const recentMean = recent.reduce((a, b) => a + b.volume, 0) / recent.length;
    const priorMean = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
    base.participation = priorMean > 0 ? +(recentMean / priorMean).toFixed(3) : null;
  }

  if (atr && atr > 0) {
    const d = (v: number | null): number | null => (v === null ? null : +((close - v) / atr).toFixed(3));
    base.distance = {
      ema9Atr: d(e9[i]),
      ema20Atr: d(e20[i]),
      ema50Atr: d(e50[i]),
      vwapAtr: d(vw[i]),
    };
  }

  // Which averages are still cold is a real and useful state, and it is not the same as the
  // timeframe being unreadable — a 15-minute frame with a warm 9/20/50 and a cold 200 can be
  // traded, it just cannot answer the regime question.
  const cold = [
    e9[i] === null && '9 EMA',
    e20[i] === null && '20 EMA',
    e50[i] === null && '50 EMA',
    e200[i] === null && '200 EMA',
    base.adx.adx === null && 'ADX',
  ].filter(Boolean) as string[];
  if (cold.length) base.note = `${cold.join(', ')} still warming on ${tf}m (${bars.length} bars)`;

  return base;
}

/**
 * Every computed timeframe for one symbol, with the series each was built from.
 *
 * The series come back rather than being discarded because the pullback detector needs them
 * and recomputing would double the work — but more importantly it would open the door to the
 * two disagreeing, which on a boundary bar is the difference between a signal and no signal.
 */
export function readFrames(
  f: SymbolFrames,
  cfg: PullbackConfig,
): { reads: Partial<Record<Timeframe, TimeframeRead>>; series: Partial<Record<Timeframe, FrameSeries>> } {
  const reads: Partial<Record<Timeframe, TimeframeRead>> = {};
  const series: Partial<Record<Timeframe, FrameSeries>> = {};
  for (const tf of cfg.timeframes.computed) {
    const bars = f.bars.get(tf) ?? [];
    const s = computeSeries(bars);
    series[tf] = s;
    reads[tf] = readFrame(f, tf, cfg, s);
  }
  return { reads, series };
}

/** The raw bars, for the chart endpoint and the backtest. */
export const barsOf = (f: SymbolFrames, tf: Timeframe): Bar[] => f.bars.get(tf) ?? [];

/** Test seam — drops everything so the next read rebuilds from the store. */
export const resetFrames = (): void => { storeState = null; seeding = null; };
