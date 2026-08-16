// Tier C — everything that needs history, built once a day.
//
// This is the file that makes the scanner cheap at runtime. Four of the twelve factors are
// comparisons against a stock's own past, and every one of them is settled here before the
// market opens:
//
//   RVOL          needs "what had this stock normally traded by 11:07?" — a per-minute
//                 cumulative volume profile over the last ~20 sessions.
//   ATR expansion needs Wilder ATR(14) off daily bars.
//   IV rank       needs realised volatility to fall back on until an IV history exists.
//   Rel. strength needs beta, to tell a stock outrunning the index from a high-beta stock
//                 being dragged by it.
//
// The cost is one 1-minute-range request and one daily-range request per symbol — 416 calls
// for a 208-stock universe, run once. At runtime RVOL is then a division against a lookup:
// the live `volume` field in the Tier-A quote is already cumulative for the day, so the
// scanner never fetches an intraday candle for the whole universe at all.
//
// THE PROFILE IS A MEDIAN, NOT A MEAN. One result day with eight times normal volume drags
// a 20-day mean up by ~35% and quietly suppresses that stock's RVOL for a month. The median
// ignores it, which is the entire point of using a robust statistic for a baseline other
// numbers are divided by.

import {
  dailyBarsCached, emptyStats, loadDailyCache, saveDailyCache,
  type DailyCache, type DailyFetchStats,
} from './daily-cache.js';
import { store, STORE_KEYS } from '../store.js';
import { istDay, isoDaysBefore, SESSION_MINUTES } from '../session.js';
import { CANDLE_ENDPOINT, historical, inBatches, minuteHistoryByDay, minuteRangeStart, type Candle } from './candles.js';
import { throttledFor } from './throttle.js';
import { universe } from './universe.js';

/**
 * Symbols in flight at once.
 *
 * Each symbol is THREE requests (intraday history, daily bars, futures dailies), so this is
 * ~15 concurrent, not 5. Ten was measured too fast: the historical-candle endpoint answered
 * 429 for 18 of 208 symbols, and a symbol that loses its baseline loses RVOL — the heaviest
 * factor in the model — for the whole session. Five plus the retry in `candles.ts` covers
 * the universe cleanly.
 */
const BATCH = 5;
/** Daily-bar lookback for ATR, beta and realised volatility. */
const DAILY_LOOKBACK_DAYS = 400;
/** Sessions of intraday profile to keep. More is steadier; 20 is the desk convention. */
const PROFILE_SESSIONS = 20;
/** A profile built on fewer than this many sessions is not a baseline worth dividing by. */
const MIN_PROFILE_SESSIONS = 5;
const MIN_DAILY_BARS = 30;
/**
 * How stale a carried-forward reading may be before it is dropped instead.
 *
 * Seven calendar days is about five sessions. Past that the previous-session levels riding along
 * with the ATR are far enough from reality to mislead the trend-structure factor, and silence is
 * the better answer. See the carry-forward in `buildBaseline`.
 */
const MAX_CARRY_DAYS = 7;

export interface SymbolBaseline {
  symbol: string;
  /**
   * Median cumulative volume by minute of session, length SESSION_MINUTES + 1.
   * `profile[m]` is what this stock had normally traded by `m` minutes past 09:15.
   */
  profile: number[];
  /** Sessions the profile was built from. */
  profileSessions: number;
  /** Mean full-day volume over the same window. */
  avgDailyVolume: number;
  /** Mean daily traded value, ₹ crore — the liquidity factor's base. */
  avgDailyValueCr: number;
  /** Wilder ATR over `atrPeriod` daily bars, in rupees. */
  atr: number;
  atrPct: number;
  atrPeriod: number;
  /** Annualised close-to-close realised volatility, %, over 20 and 252 sessions. */
  hv20: number;
  hv252: number;
  /** Percentile of today's HV20 within the trailing HV20 series, 0–100. */
  hvRank: number | null;
  /** Beta against the Nifty over the daily window. */
  beta: number | null;
  /** Highest high and lowest low over the trend lookback, excluding today. */
  priorHigh: number;
  priorLow: number;
  /** Previous session's high, low and close — the higher-high / higher-low reference. */
  prevHigh: number;
  prevLow: number;
  prevClose: number;
  /** Previous session's closing open interest on the near future. Null when unresolved. */
  prevFuturesOi: number | null;
  dailyBars: number;
  /**
   * The day this reading was actually built, when it was carried over from an earlier baseline
   * rather than rebuilt today. Absent on a fresh reading.
   *
   * A symbol Upstox refuses today would otherwise lose its ATR outright, and the trend-day alert
   * withholds any confirmation it cannot price — so one rate-limited request at 08:00 costs that
   * stock its alerts for the whole session. A one- or two-day-old ATR is a far better answer: it
   * is the same trade the module already makes when it serves a wholly stale baseline rather
   * than none, applied per symbol instead of all-or-nothing.
   */
  carriedFrom?: string;
}

export interface Baseline {
  day: string;
  builtAt: number;
  symbols: Record<string, SymbolBaseline>;
  /** Symbols the build could not cover, with the reason. Surfaces as a board warning. */
  failures: Record<string, string>;
  /**
   * How many readings came from an earlier baseline because today's build could not reach them.
   *
   * Reported rather than inferred so "205 symbols" cannot quietly mean "40 built and 165 three
   * days old". Undefined on a baseline written before this field existed.
   */
  carried?: number;
}

/* ------------------------------------------------------------------------ maths --- */

/** Median of a numeric array. Sorts a copy — the caller's order is not ours to change. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Wilder's ATR — the average of TRUE range, which is not the average of high−low.
 *
 * True range takes the gap into account: a stock that closes at 100 and opens at 108 has
 * moved 8% before it trades a tick, and a high−low average would score that session as
 * quiet. For a scanner whose job is finding stocks that are moving, that is exactly
 * backwards, which is why this is computed here rather than reusing the mean daily range
 * `volume.ts` already keeps for R.Factor.
 */
export function wilderAtr(bars: Array<{ high: number; low: number; close: number }>, period: number): number {
  if (bars.length < period + 1) return 0;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)));
  }
  // Seed with a simple mean of the first `period`, then smooth. That is Wilder's original
  // recursion, and it differs from a rolling SMA of TR by enough to matter on a threshold.
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

/** Annualised close-to-close volatility, in percent. 252 trading days a year. */
export function realisedVolatility(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Ordinary least-squares beta of `asset` returns against `market` returns. */
export function beta(assetCloses: number[], marketCloses: number[]): number | null {
  const n = Math.min(assetCloses.length, marketCloses.length);
  if (n < 30) return null;
  const a: number[] = [];
  const m: number[] = [];
  for (let i = n - 1; i > 0; i--) {
    const pa = assetCloses[assetCloses.length - i - 1];
    const pm = marketCloses[marketCloses.length - i - 1];
    const ca = assetCloses[assetCloses.length - i];
    const cm = marketCloses[marketCloses.length - i];
    if (pa > 0 && pm > 0) {
      a.push(Math.log(ca / pa));
      m.push(Math.log(cm / pm));
    }
  }
  if (a.length < 30) return null;
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mm = m.reduce((x, y) => x + y, 0) / m.length;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (m[i] - mm);
    varM += (m[i] - mm) ** 2;
  }
  return varM > 0 ? +(cov / varM).toFixed(3) : null;
}

/**
 * The percentile rank of `value` within `series`, 0–100.
 *
 * "What fraction of the past sat below where we are now" — the standard reading of an IV or
 * HV percentile, and the one the UI labels as such.
 */
export function percentileRank(value: number, series: number[]): number | null {
  if (series.length < 2) return null;
  const below = series.filter((v) => v < value).length;
  return +((below / series.length) * 100).toFixed(1);
}

/**
 * Cumulative volume by minute, from one session's 1-minute bars.
 *
 * Forward-filled: a minute with no print carries the previous cumulative total rather than
 * dropping to zero, so a thin stock's profile is monotonic and the division that produces
 * RVOL cannot land on a hole.
 */
export function cumulativeProfile(bars: Candle[]): number[] {
  const out = new Array<number>(SESSION_MINUTES + 1).fill(0);
  const byMinute = new Map<number, number>();
  for (const b of bars) {
    if (b.minute < 0 || b.minute > SESSION_MINUTES) continue;
    byMinute.set(b.minute, (byMinute.get(b.minute) ?? 0) + b.volume);
  }
  let running = 0;
  for (let m = 0; m <= SESSION_MINUTES; m++) {
    running += byMinute.get(m) ?? 0;
    out[m] = running;
  }
  return out;
}

/** Element-wise median across sessions, giving the typical shape of a day. */
export function medianProfile(profiles: number[][]): number[] {
  const out = new Array<number>(SESSION_MINUTES + 1).fill(0);
  if (!profiles.length) return out;
  const column: number[] = new Array(profiles.length);
  for (let m = 0; m <= SESSION_MINUTES; m++) {
    for (let i = 0; i < profiles.length; i++) column[i] = profiles[i][m] ?? 0;
    out[m] = median(column);
  }
  return out;
}

/* ------------------------------------------------------------------------- build --- */

interface DailyBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function buildSymbol(
  symbol: string,
  equityKey: string,
  futuresKey: string | null,
  today: string,
  atrPeriod: number,
  trendLookback: number,
  niftyCloses: number[],
  daily2: { cache: DailyCache; stats: DailyFetchStats; full: boolean },
): Promise<SymbolBaseline> {
  const yesterday = isoDaysBefore(1, today);

  const [byDay, daily, futDaily] = await Promise.all([
    minuteHistoryByDay(equityKey, minuteRangeStart(yesterday), yesterday),
    // Through the cache. 270 of these ~271 bars were already on this disk; see daily-cache.ts
    // for exactly which calls this removes and which it does not.
    dailyBarsCached(
      symbol, isoDaysBefore(DAILY_LOOKBACK_DAYS, today), today,
      daily2.cache, daily2.stats, daily2.full,
    ),
    // Only the last few sessions: all this needs is the previous close's open interest, and
    // a 400-day futures history spans contracts that no longer exist.
    futuresKey ? historical(futuresKey, 'days', 1, isoDaysBefore(10, today), today) : Promise.resolve([]),
  ]);

  const sessions = [...byDay.keys()].sort().slice(-PROFILE_SESSIONS);
  const profiles = sessions.map((d) => cumulativeProfile(byDay.get(d) ?? []));
  const profile = medianProfile(profiles);

  const bars: DailyBar[] = daily.map(([, , high, low, close, volume]) => ({ high, low, close, volume }));
  const closes = bars.map((b) => b.close);

  const atr = wilderAtr(bars, atrPeriod);
  const prev = bars[bars.length - 1];
  // `dailyBars` includes today once the session has started, so the "previous" session is
  // the second-from-last bar on a trading day and the last one otherwise. Keyed off the
  // stamp rather than assumed, because assuming it is how a live board ends up comparing
  // today's high against itself and reporting a higher high for every stock on the list.
  const lastStamp = daily.length ? new Date(daily[daily.length - 1][0] * 1000).toISOString().slice(0, 10) : '';
  const todayIncluded = lastStamp === today;
  const priorBars = todayIncluded ? bars.slice(0, -1) : bars;
  const previous = priorBars[priorBars.length - 1] ?? prev;
  const window = priorBars.slice(-trendLookback);

  // HV20 through time, so today's realised vol has a distribution to be ranked within.
  const hv20Series: number[] = [];
  for (let i = 21; i <= closes.length; i++) hv20Series.push(realisedVolatility(closes.slice(i - 21, i)));
  const hv20 = hv20Series[hv20Series.length - 1] ?? 0;

  const fullDayVolumes = sessions.map((d) => (byDay.get(d) ?? []).reduce((a, c) => a + c.volume, 0)).filter((v) => v > 0);
  const avgDailyVolume = fullDayVolumes.length
    ? fullDayVolumes.reduce((a, b) => a + b, 0) / fullDayVolumes.length
    : bars.slice(-20).reduce((a, b) => a + b.volume, 0) / Math.max(1, Math.min(20, bars.length));

  return {
    symbol,
    profile,
    profileSessions: sessions.length,
    avgDailyVolume,
    avgDailyValueCr: +((avgDailyVolume * (previous?.close ?? 0)) / 1e7).toFixed(2),
    atr: +atr.toFixed(3),
    atrPct: previous?.close ? +((atr / previous.close) * 100).toFixed(3) : 0,
    atrPeriod,
    hv20: +hv20.toFixed(2),
    hv252: +realisedVolatility(closes.slice(-253)).toFixed(2),
    hvRank: percentileRank(hv20, hv20Series.slice(-252)),
    beta: beta(closes, niftyCloses),
    priorHigh: window.length ? Math.max(...window.map((b) => b.high)) : 0,
    priorLow: window.length ? Math.min(...window.map((b) => b.low)) : 0,
    prevHigh: previous?.high ?? 0,
    prevLow: previous?.low ?? 0,
    prevClose: previous?.close ?? 0,
    // The last DAILY futures candle before today; element 7 of an Upstox candle is open
    // interest, which is what makes an intraday build-up measurable at all.
    prevFuturesOi: (() => {
      const past = futDaily.filter((c) => c.day < today);
      return past.length ? past[past.length - 1].openInterest || null : null;
    })(),
    dailyBars: bars.length,
  };
}

/**
 * Fill the gaps in today's build from the previous baseline. Mutates `symbols` and reports what
 * it did — pure otherwise, so the whole rule is testable without a clock, a network or a disk.
 *
 * WHY THIS EXISTS. A partial build is the normal outcome; Upstox refuses a handful of symbols on
 * any given morning. Each of those used to lose its ATR outright, and the trend-day alert reads
 * "no ATR" as "cannot be priced" and withholds the confirmation for the whole session. On
 * 2026-08-15 that was 68 symbols of 208, every one a 429 rather than anything wrong with the
 * stock. A volume profile is a 20-session median and an ATR a 14-day average, so yesterday's
 * reading is a good answer where today has none.
 *
 * WHY IT IS BOUNDED. The same record also carries `prevClose`, `prevHigh` and `prevLow` — the
 * PREVIOUS SESSION's levels, which are simply wrong once a session has passed. Trend structure
 * compares today's high against `prevHigh`, so an old reading would report higher highs that
 * never happened. A few days of drift buys a real alert instead of silence; a fortnight of it
 * invents one, so anything past `MAX_CARRY_DAYS` is dropped rather than carried.
 *
 * `carriedFrom` is preserved rather than restamped, so a reading cannot launder its own age by
 * being carried forward one day at a time.
 */
export function carryForward(
  symbols: Record<string, SymbolBaseline>,
  previous: Baseline | null,
  today: string,
): { carried: number; tooOld: number } {
  let carried = 0;
  let tooOld = 0;
  if (!previous?.symbols) return { carried, tooOld };

  const oldest = isoDaysBefore(MAX_CARRY_DAYS, today);
  for (const [symbol, old] of Object.entries(previous.symbols)) {
    if (symbols[symbol]) continue; // today's own build wins, always
    const from = old.carriedFrom ?? previous.day;
    if (from < oldest) {
      tooOld++;
      continue;
    }
    symbols[symbol] = { ...old, carriedFrom: from };
    carried++;
  }
  return { carried, tooOld };
}

let memory: Baseline | null = null;
let building: Promise<Baseline> | null = null;

/**
 * Build (or rebuild) the baseline for today and persist it.
 *
 * Partial success is the normal outcome and is fine: a symbol Upstox will not serve loses
 * its own RVOL and ATR, not everyone else's. A build that covered almost nothing is a
 * failure though, and keeps whatever is on disk rather than overwriting a good baseline
 * with an empty one — the same rule `volume.ts` applies to the R.Factor baseline.
 */
export async function buildBaseline(
  opts: {
    atrPeriod: number;
    trendLookback: number;
    /**
     * Rebuild every symbol, including the ones already built today.
     *
     * Off by default — see the resume note below. Worth passing after a corporate action, or
     * when a reading is suspected wrong rather than merely missing.
     */
    full?: boolean;
  } = { atrPeriod: 14, trendLookback: 20 },
  nowMs = Date.now(),
): Promise<Baseline> {
  const today = istDay(nowMs);
  const uni = await universe(nowMs);

  const niftyDaily = await historical(uni.niftyKey, 'days', 1, isoDaysBefore(DAILY_LOOKBACK_DAYS, today), today);
  const niftyCloses = niftyDaily.map((c) => c.close);

  const symbols: Record<string, SymbolBaseline> = {};
  const failures: Record<string, string> = {};

  // RESUME WHERE THE LAST ATTEMPT DIED.
  //
  // The universe is walked in a fixed order, so a build that exhausts the request budget always
  // dies at the same place — and re-running it spent the whole budget AGAIN on the symbols it had
  // already done, then stopped at the same symbol. On 2026-08-16 that pinned coverage at 140 of
  // 208 with the missing 68 a perfect alphabetical tail from NTPC to ZYDUSLIFE: RELIANCE, SBIN,
  // TCS, TATASTEEL and POWERGRID among them. No number of retries could ever have reached them,
  // because every retry began at 360ONE.
  //
  // So a symbol already BUILT today is skipped and its reading kept. Retries become cumulative:
  // each pass spends its budget on ground the previous pass never covered, and two or three
  // passes finish a universe that one pass cannot.
  //
  // Only genuinely-built readings qualify. A carried-forward one is yesterday's, and the whole
  // point of the next attempt is to replace it with today's — skipping those would freeze the
  // carry in place until it aged out.
  // Loaded once and written once. Every symbol reads and updates the same object; 208 separate
  // writes of a multi-megabyte file would cost more than the requests this saves.
  const dailyCache = await loadDailyCache();
  const dailyStats = emptyStats();

  const previous = await store.read<Baseline>(STORE_KEYS.baseline);
  const resumable =
    !opts.full && previous?.day === today
      ? Object.entries(previous.symbols).filter(([, b]) => !b.carriedFrom)
      : [];
  for (const [symbol, b] of resumable) symbols[symbol] = b;
  if (resumable.length)
    console.log(
      `[momentum] baseline: resuming — ${resumable.length} symbols already built today are kept, ` +
        `${uni.members.length - resumable.length} to attempt`,
    );

  await inBatches(uni.members, BATCH, async (m) => {
    // Already have today's own reading for this one. Costs nothing and, more to the point,
    // leaves the budget for a symbol that has none.
    if (symbols[m.symbol]) return;

    // Once the breaker is open every remaining symbol would fail identically. Skipping
    // them keeps the build honest about why it stopped and, more to the point, stops it
    // spending the next window's budget too.
    if (throttledFor(CANDLE_ENDPOINT, Date.now()) > 0) {
      failures[m.symbol] = 'skipped — Upstox candle endpoint rate limited';
      return;
    }
    try {
      const b = await buildSymbol(
        m.symbol, m.equityKey, m.future?.instrumentKey ?? null,
        today, opts.atrPeriod, opts.trendLookback, niftyCloses,
        { cache: dailyCache, stats: dailyStats, full: !!opts.full },
      );
      if (b.profileSessions < MIN_PROFILE_SESSIONS && b.dailyBars < MIN_DAILY_BARS) {
        failures[m.symbol] = `only ${b.profileSessions} intraday sessions and ${b.dailyBars} daily bars`;
        return;
      }
      symbols[m.symbol] = b;
    } catch (e) {
      failures[m.symbol] = String((e as Error).message);
    }
  });

  // CARRY FORWARD WHAT TODAY COULD NOT REACH.
  //
  // A partial build is the normal outcome — Upstox refuses a handful of symbols on any given
  // morning — and until now each of those lost its ATR entirely, which the trend-day alert reads
  // as "cannot be priced" and withholds for the whole session. On 2026-08-15 that was 68 of 208
  // symbols, every one of them a 429 rather than anything wrong with the stock.
  //
  // A volume profile is a 20-session median and an ATR is a 14-day average; neither moves
  // meaningfully overnight, so yesterday's reading is a good answer where today has none. The
  // reading is tagged with the day it was built so nothing downstream has to guess, and the
  // symbol stays listed in `failures` because the build genuinely did fail for it.
  // Written once, after every symbol has had its turn. Persisted even when the build itself is
  // about to be refused: the bars fetched before the budget ran out are still bars, and throwing
  // them away would make the next attempt pay for them again — which is the exact waste this
  // cache exists to end.
  await saveDailyCache(dailyCache).catch(() => {});
  if (dailyStats.readjusted.length)
    console.warn(
      `[momentum] daily bars: ${dailyStats.readjusted.length} series refetched in full after a ` +
        `price re-adjustment (${dailyStats.readjusted.slice(0, 8).join(', ')}) — a split or a bonus issue.`,
    );
  console.log(
    `[momentum] daily bars: ${dailyStats.hits} from cache (no request), ` +
      `${dailyStats.deltas} topped up, ${dailyStats.fulls} fetched in full`,
  );

  // Counted before the carry, so "how much did THIS pass add" is answerable. On a resumed build
  // that is the only number worth watching: it says whether another pass is worth running, or
  // whether the budget is spent and the remainder has to wait for the window to roll.
  const gained = Object.keys(symbols).length - resumable.length;

  const { carried, tooOld } = carryForward(symbols, previous, today);
  if (tooOld)
    console.warn(
      `[momentum] baseline: dropped ${tooOld} readings older than ${MAX_CARRY_DAYS} days — ` +
        'their previous-session levels can no longer be trusted. Rebuild with a clean request budget.',
    );

  const built = Object.keys(symbols).length - carried;
  const next: Baseline = { day: today, builtAt: nowMs, symbols, failures, carried };
  const missing = uni.members.length - Object.keys(symbols).length;
  console.log(
    `[momentum] baseline: ${built}/${uni.members.length} built` +
      (resumable.length ? ` (${gained} new this pass, ${resumable.length} kept)` : '') +
      (carried ? `, ${carried} carried from ${previous?.day}` : '') +
      (missing
        ? ` — ${missing} still have no ATR; run POST /momentum/baseline/rebuild again to resume`
        : ' — full coverage'),
  );

  // THE COVERAGE GATE ONLY GUARDS THE CASE IT WAS WRITTEN FOR.
  //
  // It exists to stop a throttled fragment overwriting a good baseline. With the carry-forward
  // above that can no longer happen: every symbol in `previous` is also in `next`, either rebuilt
  // today or carried, so `next` is by construction never less complete than what it replaces.
  // Applying the old 50% floor here actively destroyed work — a build that reached 100 symbols
  // and carried 40 was discarded in favour of the 140 it had just merged from.
  //
  // What still has to be refused is a build that learned NOTHING, because writing that would
  // restamp yesterday's data with today's date and make a stale baseline read as current.
  if (built === 0 && previous) {
    memory = previous;
    return previous;
  }

  // No previous baseline to fall back on, and too little to be worth dividing by. This is the
  // genuine "nothing to serve" case and is still an error.
  if (!previous && built < uni.members.length * 0.5) {
    const throttled = throttledFor(CANDLE_ENDPOINT, Date.now());
    throw new Error(
      `momentum baseline covered only ${built}/${uni.members.length} symbols` +
      (throttled > 0
        ? ` — the Upstox candle endpoint is rate limited for another ${Math.ceil(throttled / 1000)}s. ` +
          'A full build is ~416 requests against a 2000-per-30-minute ceiling, so it can only run a few times an hour.'
        : ''),
    );
  }

  await store.write(STORE_KEYS.baseline, next);
  memory = next;
  return next;
}

/**
 * The baseline, from memory, then disk, then a fresh build.
 *
 * A baseline from an earlier session is used rather than rebuilt on demand: a 20-day median
 * volume profile does not meaningfully change overnight, and rebuilding it inside a request
 * would block the first board of the day behind 400 upstream calls. `stale` says how old it
 * is so the board can carry the warning.
 */
export async function getBaseline(nowMs = Date.now()): Promise<{ baseline: Baseline | null; stale: boolean }> {
  const today = istDay(nowMs);
  if (memory) return { baseline: memory, stale: memory.day !== today };

  const disk = await store.read<Baseline>(STORE_KEYS.baseline);
  if (disk) {
    memory = disk;
    return { baseline: disk, stale: disk.day !== today };
  }
  return { baseline: null, stale: true };
}

/** Kick a rebuild, collapsing concurrent callers onto one run. */
export function ensureBaseline(
  opts: { atrPeriod: number; trendLookback: number; full?: boolean },
  nowMs = Date.now(),
): Promise<Baseline> {
  if (!building) building = buildBaseline(opts, nowMs).finally(() => { building = null; });
  return building;
}
