// A disk cache for the daily bars the baseline builds ATR, beta and HV from.
//
// WHAT IT SAVES, PRECISELY. The baseline asks Upstox for 400 calendar days of daily candles per
// symbol — about 270 bars — every time it runs. Of those 270, at most ONE is new since the last
// build, and on a retry within the same day none are. So the request was not merely large, it
// was almost entirely a re-download of bytes already on this disk.
//
// It does NOT save a request on the first build of an ordinary Tuesday. Fetching one new bar
// still costs one call, and the ceiling that hurts is requests-per-minute, not bytes. What it
// saves is every call where there is nothing to fetch at all, and those are the ones that were
// actually hurting:
//
//   A RETRY THE SAME DAY. The pattern that produced the 2026-08-16 mess — build, get throttled,
//   build again — re-downloaded 208 symbols of unchanged history on every attempt. Now the
//   second pass and every pass after it costs zero daily-bar requests, so a resumed build spends
//   its whole budget on the symbols that still have nothing.
//
//   THE FIRST BUILD AFTER A NON-TRADING DAY. Monday's 08:00 build wants sessions up to Friday,
//   and a weekend build already has them. Zero requests.
//
// CORPORATE ACTIONS ARE THE REASON THIS IS NOT A PLAIN APPEND. A split re-prices the whole
// history at the source, so a cached series and a fresh one would silently disagree and the ATR
// would be computed across the join — half of it in old rupees. Every delta fetch therefore
// re-reads a few sessions it already has and compares them. A mismatch throws the cached series
// away and refetches in full, which costs one extra request on the rare day a stock splits and
// is the only honest answer.

import { dailyBars, type DailyBar } from '../../equity.js';
import { istDay, istDow } from '../session.js';
import { store, STORE_KEYS } from '../store.js';

/** Bump when the shape changes, so an old file is discarded rather than misread. */
const VERSION = 1;

/**
 * Calendar days of already-held history re-fetched on every delta, to detect a re-adjustment.
 *
 * Seven covers a long weekend and still leaves overlapping sessions to compare. It costs nothing:
 * asking for seven days or for one is the same single request.
 */
const OVERLAP_DAYS = 7;

/**
 * Past this the delta is not worth attempting.
 *
 * A cache older than a month has missed enough sessions that the overlap window cannot bridge it,
 * and a full refetch is both simpler and no more expensive than discovering that the hard way.
 */
const MAX_STALE_DAYS = 30;

export interface CachedDaily {
  /** IST day of the newest bar held. Today's own bar is never cached — see `cacheable`. */
  to: string;
  bars: DailyBar[];
}

export interface DailyCache {
  v: number;
  symbols: Record<string, CachedDaily>;
}

const empty = (): DailyCache => ({ v: VERSION, symbols: {} });

/** The IST day a bar belongs to. Bars carry epoch SECONDS. */
export const barDay = (b: DailyBar): string => istDay(b[0] * 1000);

const isoDaysBefore = (days: number, from: string): string =>
  new Date(Date.parse(`${from}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/**
 * The most recent day the exchange could have produced a bar for, counting weekends only.
 *
 * Holidays are deliberately NOT consulted. Getting this wrong in one direction costs a pointless
 * request that returns nothing; getting it wrong in the other silently skips a session and leaves
 * the ATR a day stale. Ignoring holidays can only ever produce the first kind — a holiday makes
 * the real last session EARLIER than this answer, so the cache reads as behind and refetches.
 */
export function lastPossibleSession(today: string): string {
  let day = isoDaysBefore(1, today);
  for (let i = 0; i < 7; i++) {
    const dow = istDow(Date.parse(`${day}T06:00:00Z`));
    if (dow !== 0 && dow !== 6) return day;
    day = isoDaysBefore(1, day);
  }
  return day;
}

/**
 * Do the sessions the two series share agree?
 *
 * Compared on close, high and low rather than close alone: a bonus issue moves all of them, and a
 * series that agrees on three prices for several sessions has not been re-adjusted underneath us.
 *
 * No overlap at all counts as disagreement. That is not pedantry — it means the gap is wider than
 * the window, so nothing has been checked, and merging across an unverified gap is exactly the
 * silent join this function exists to prevent.
 */
export function overlapAgrees(cached: DailyBar[], fresh: DailyBar[]): boolean {
  const held = new Map(cached.map((b) => [b[0], b]));
  let compared = 0;
  for (const f of fresh) {
    const c = held.get(f[0]);
    if (!c) continue;
    compared++;
    // A paisa of float drift is not a corporate action; a split is a factor of two or more.
    for (const i of [2, 3, 4]) if (Math.abs(c[i] - f[i]) > Math.max(0.01, Math.abs(f[i]) * 0.001)) return false;
  }
  return compared > 0;
}

/** Union of the two series, fresh winning on a shared timestamp, oldest first, trimmed to `from`. */
export function mergeBars(cached: DailyBar[], fresh: DailyBar[], from: string): DailyBar[] {
  const byStamp = new Map(cached.map((b) => [b[0], b]));
  for (const f of fresh) byStamp.set(f[0], f);
  return [...byStamp.values()].sort((a, b) => a[0] - b[0]).filter((b) => barDay(b) >= from);
}

/**
 * The bars safe to keep.
 *
 * Today's bar is excluded, always. During a session it is a PARTIAL bar — the high, low and close
 * are whatever they were at the moment of the request — and freezing that into a cache would hand
 * tomorrow's ATR a day that never finished.
 */
const cacheable = (bars: DailyBar[], today: string): DailyBar[] => bars.filter((b) => barDay(b) < today);

/* ------------------------------------------------------------------------ the disk --- */

export async function loadDailyCache(): Promise<DailyCache> {
  const saved = await store.read<DailyCache>(STORE_KEYS.dailyBars);
  return saved && saved.v === VERSION && saved.symbols ? saved : empty();
}

export const saveDailyCache = (cache: DailyCache): Promise<void> => store.write(STORE_KEYS.dailyBars, cache);

/* ----------------------------------------------------------------------- the fetch --- */

export interface DailyFetchStats {
  /** Served entirely from disk — no request made. */
  hits: number;
  /** One request for the sessions since the cache was last topped up. */
  deltas: number;
  /** One request for the whole window: no cache, too stale, or a failed overlap check. */
  fulls: number;
  /** Series thrown away because the overlap disagreed. A corporate action, almost always. */
  readjusted: string[];
}

export const emptyStats = (): DailyFetchStats => ({ hits: 0, deltas: 0, fulls: 0, readjusted: [] });

/**
 * Daily bars for one symbol, from the cache where the cache is current.
 *
 * `cache` is mutated in place and written once by the caller — 208 symbols each writing their own
 * file would be 208 serialisations of a multi-megabyte object.
 */
export async function dailyBarsCached(
  symbol: string,
  from: string,
  to: string,
  cache: DailyCache,
  stats: DailyFetchStats,
  full = false,
): Promise<DailyBar[]> {
  const entry = full ? undefined : cache.symbols[symbol];

  const keep = (bars: DailyBar[]): DailyBar[] => {
    const safe = cacheable(bars, to);
    if (safe.length) cache.symbols[symbol] = { to: barDay(safe[safe.length - 1]), bars: safe };
    return bars;
  };

  // No usable cache, or one too far behind for the overlap window to bridge.
  if (!entry?.bars.length || entry.to < isoDaysBefore(MAX_STALE_DAYS, to)) {
    stats.fulls++;
    return keep(await dailyBars(symbol, from, to));
  }

  // ALREADY CURRENT — the whole point. Nothing has closed since this was written, so there is
  // nothing to ask for, and the request is not made at all.
  if (entry.to >= lastPossibleSession(to)) {
    stats.hits++;
    return entry.bars.filter((b) => barDay(b) >= from);
  }

  const fresh = await dailyBars(symbol, isoDaysBefore(OVERLAP_DAYS, entry.to), to);
  if (!fresh.length) {
    stats.hits++;
    return entry.bars.filter((b) => barDay(b) >= from);
  }

  if (!overlapAgrees(entry.bars, fresh)) {
    stats.readjusted.push(symbol);
    stats.fulls++;
    return keep(await dailyBars(symbol, from, to));
  }

  stats.deltas++;
  return keep(mergeBars(entry.bars, fresh, from));
}
