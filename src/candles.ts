// Intraday index candles — the price chart Option Apex is built around.
//
// NSE has no usable public intraday feed for an INDEX. Its own chart endpoint,
// /api/chart-databyindex?index=NIFTY 50&indices=true, answers 200 with an empty
// grapthData and closePrice 0 — it serves equities, not indices — and the charting host
// its website draws from (charting.nseindia.com) is not publicly routable.
//
// Upstox does serve them, so that is where these come from. It is still verified rather
// than trusted: every series is cross-checked against the spot NSE itself reports on its
// option chain, and one that disagrees is refused rather than drawn. A price chart that
// silently belongs to a different instrument is the failure worth spending code on, and
// the check costs nothing because the option chain is being read anyway.
//
// Candles are aggregated here rather than requested per timeframe, so every timeframe
// comes off one cached minute series instead of one upstream call each.

import type { Result } from './services.js';
import * as upstox from './upstox.js';

/** [epoch seconds, open, high, low, close] — the shape the real money_flux/chart returns. */
export type Candle = [number, number, number, number, number];

/** Timeframes the page offers, in minutes. */
export const TIMEFRAMES = [1, 3, 5, 15, 30, 60] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const isTimeframe = (n: number): n is Timeframe => (TIMEFRAMES as readonly number[]).includes(n);

const IST_OFFSET_S = 330 * 60;

/** The IST calendar day an epoch falls in, YYYY-MM-DD. */
const dayOf = (epochS: number) => new Date((epochS + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);

/**
 * One-minute bars for the most recent session, oldest first.
 *
 * Deliberately the only network call in this module: everything else is arithmetic over
 * what this returns, so replacing the feed means replacing this function and nothing else.
 */
async function fetchMinuteBars(script: string): Promise<{ bars: Candle[]; last: number; prevClose: number | null }> {
  const key = upstox.INSTRUMENT_KEY[script];
  if (!key) throw new Error(`no Upstox instrument key mapped for "${script}"`);

  const today = dayOf(Math.floor(Date.now() / 1000));
  // Today's session if it has started, otherwise the last one that traded. Walking back
  // rather than assuming yesterday, so a long weekend or a run of holidays still finds a
  // session instead of drawing an empty chart.
  let bars: Candle[] = [];
  let day = today;
  for (let back = 0; back < 8 && !bars.length; back++) {
    day = dayOf(Math.floor(Date.now() / 1000) - back * 86400);
    const raw = await upstox.sessionCandles(key, day, today, 'minutes', 1);
    bars = raw.map((c) => [c[0], c[1], c[2], c[3], c[4]] as Candle);
  }
  if (bars.length < 2) throw new Error(`Upstox returned ${bars.length} usable bars for ${script}`);

  // The daily candle carries the official close, which the intraday series does not: the
  // last minute bar of the day ends a few minutes before the closing print.
  let last = bars[bars.length - 1][4];
  let prevClose: number | null = null;
  try {
    // A week back, so the previous session is in range across a weekend or a holiday run.
    const from = dayOf(Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000) - 10 * 86400);
    const daily = await upstox.dailyCandles(key, from, day);
    if (daily.length) {
      last = daily[daily.length - 1][4];
      // The close BEFORE this session — what "the index is up 117 points" is measured
      // against everywhere else on the page. The first candle's open is a different
      // baseline and would disagree with Index Mover by the size of the opening gap.
      if (daily.length > 1) prevClose = daily[daily.length - 2][4];
    }
  } catch { /* the intraday series alone is still a usable chart */ }

  return { bars, last, prevClose };
}

/**
 * Refuse a series that doesn't belong to the index it claims to.
 *
 * The mapping above is a table of strings, and a wrong entry produces a chart that looks
 * completely normal while showing another instrument — the one error here that a reader
 * cannot see. NSE independently reports the spot for every index on the option chain, so
 * the two are compared: a close that far off its own underlying is a mapping fault, not
 * market movement. The tolerance is wide enough to absorb a feed a few minutes behind
 * during a fast session and narrow enough that no two NSE indices could be confused.
 */
const SPOT_TOLERANCE = 0.02; // 2%

function verifySpot(script: string, close: number, nseSpot: number | undefined): void {
  if (!nseSpot || !Number.isFinite(nseSpot)) return; // nothing to check against
  const drift = Math.abs(close - nseSpot) / nseSpot;
  if (drift > SPOT_TOLERANCE)
    throw new Error(
      `quote feed for ${script} closed at ${close.toFixed(2)} but NSE reports ${nseSpot.toFixed(2)} ` +
      `(${(drift * 100).toFixed(1)}% apart) — refusing to chart a mismatched series`,
    );
}

/** Fold minute bars into `tf`-minute candles, aligned to the IST clock. */
function aggregate(bars: Candle[], tf: number): Candle[] {
  if (tf <= 1) return bars;
  const step = tf * 60;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let bucket = -1;

  for (const [ts, o, h, l, c] of bars) {
    // Bucket in IST, so a 15-minute candle starts at 09:15 and not at a UTC boundary
    // that falls mid-session.
    const b = Math.floor((ts + IST_OFFSET_S) / step) * step - IST_OFFSET_S;
    if (b !== bucket) {
      if (cur) out.push(cur);
      cur = [b, o, h, l, c];
      bucket = b;
    } else if (cur) {
      cur[2] = Math.max(cur[2], h);
      cur[3] = Math.min(cur[3], l);
      cur[4] = c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The minute series is one upstream call shared by every timeframe and every viewer.
// It only ever grows by a bar a minute, so re-fetching per request buys nothing.
const CACHE_TTL_OPEN = 30e3;
const CACHE_TTL_CLOSED = 10 * 60e3;
const cache = new Map<string, { at: number; bars: Candle[]; last: number; prevClose: number | null }>();

async function minuteBars(script: string, open: boolean): Promise<{ bars: Candle[]; last: number; prevClose: number | null }> {
  const hit = cache.get(script);
  const ttl = open ? CACHE_TTL_OPEN : CACHE_TTL_CLOSED;
  if (hit && Date.now() - hit.at < ttl) return hit;
  try {
    const fresh = await fetchMinuteBars(script);
    cache.set(script, { at: Date.now(), ...fresh });
    return fresh;
  } catch (e) {
    // Serve the last real series rather than an empty chart over one refused request —
    // the same reasoning as snapshot.ts. Only a cold cache is a failure.
    if (hit) return hit;
    throw e;
  }
}

export interface ChartData {
  script: string;
  tf: Timeframe;
  day: string;      // the IST trading day these candles describe
  candles: Candle[];
  last: number;     // latest traded level
  prevClose: number | null;
}

/**
 * Candles for an index at a timeframe, plus the levels the header reads from.
 *
 * `nseSpot` is what NSE says the index is worth right now (the option chain's
 * underlyingValue) — passed in so the series can be checked against it. Omit it and the
 * check is skipped; there's then nothing to verify against, not a silent pass.
 */
export async function indexChart(
  script: string, tf: Timeframe, nseSpot?: number, marketOpen = false,
): Promise<Result<ChartData>> {
  const { bars, last, prevClose } = await minuteBars(script, marketOpen);
  verifySpot(script, bars[bars.length - 1][4], nseSpot);

  const candles = aggregate(bars, tf);
  const day = dayOf(candles[candles.length - 1][0]);
  const today = dayOf(Math.floor(Date.now() / 1000));

  return {
    // A session that has already closed is real data that is no longer moving — the same
    // thing the rest of the app calls 'stale', and the badge says so.
    source: day === today && marketOpen ? 'nse' : 'stale',
    ...(day === today ? {} : { error: `showing the last completed session (${day})` }),
    data: { script, tf, day, candles, last, prevClose },
  };
}
