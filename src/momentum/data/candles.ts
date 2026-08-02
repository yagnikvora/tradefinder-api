// Candle access for the momentum module.
//
// `upstox.ts` already has candle helpers, and they are the right ones for Option Clock — a
// single day, flipped oldest-first, with open interest as element 7. The momentum baseline
// needs something they don't do: a MULTI-DAY 1-minute range in one request, kept grouped by
// session, because that is how the relative-volume baseline is built.
//
// Two limits are load-bearing and were measured rather than assumed:
//
//   * A 1-minute range of 30 calendar days answers 200 with ~23 sessions. Forty-five days
//     answers 400. So one request per symbol IS the twenty-session baseline — the whole
//     thing is 208 calls a day, not 208 × 20.
//
//   * Upstox returns candles NEWEST FIRST. Every function here flips them, once, because a
//     silently reversed series produces a VWAP that walks backwards and an ATR that looks
//     fine.
//
// The endpoint split is the other trap. Today is served only by
// `/historical-candle/intraday/...` and past days only by `/historical-candle/...`; asking
// the wrong one answers 200 with an empty array, which reads as "nothing traded".

import { call } from '../../upstox.js';
import { candleDay, candleMinute } from '../session.js';
import { assertNotThrottled, noteRefusal, noteSuccess } from './throttle.js';

/** [ISO stamp with IST offset, open, high, low, close, volume, open interest]. */
export type RawCandle = [string, number, number, number, number, number, number];

export interface Candle {
  /** The original "2026-07-31T09:15:00+05:30". Kept so the IST day is readable off it. */
  stamp: string;
  day: string;
  /** 0 = the 09:15 bar. Negative for anything outside the regular session. */
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Real on futures and options; always 0 on an equity candle. */
  openInterest: number;
}

const MAX_MINUTE_RANGE_DAYS = 30;

function toCandle(c: RawCandle): Candle {
  return {
    stamp: c[0],
    day: candleDay(c[0]),
    minute: candleMinute(c[0]),
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5] ?? 0,
    openInterest: c[6] ?? 0,
  };
}

const oldestFirst = (rows: RawCandle[]): Candle[] =>
  rows.map(toCandle).sort((a, b) => a.stamp.localeCompare(b.stamp));

/** The breaker key. One budget per Upstox endpoint, so one breaker per endpoint. */
export const CANDLE_ENDPOINT = 'historical-candle';

/**
 * Retry a refused request, with backoff — and give up quickly when the quota is gone.
 *
 * A 429 has two quite different causes and they need opposite responses. A BURST refusal
 * clears in a few hundred milliseconds and retrying is right: the first baseline build lost
 * 18 of 208 symbols to that. A spent QUOTA does not clear for the rest of the window, and
 * retrying turns 208 doomed requests into 600. The circuit breaker in `throttle.ts` tells
 * the two apart by how many refusals cluster, so the retry below only ever pays for the
 * first kind.
 *
 * Only 429 and 5xx are retried. A 400 (a range Upstox will not serve) or a 404 is a
 * permanent answer, and retrying it just spends the budget confirming it.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let wait = 400;
  for (let i = 0; ; i++) {
    assertNotThrottled(CANDLE_ENDPOINT);
    try {
      const v = await fn();
      noteSuccess(CANDLE_ENDPOINT);
      return v;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 429) noteRefusal(CANDLE_ENDPOINT);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i >= attempts - 1) throw e;
      // Jittered, so a batch that was refused together does not retry together.
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait));
      wait *= 2;
    }
  }
}

async function fetchCandles(path: string): Promise<Candle[]> {
  const raw = await withRetry(() => call<{ candles?: RawCandle[] }>(path));
  return oldestFirst(raw?.candles ?? []);
}

/**
 * Historical candles over a range, oldest first.
 *
 * Note the URL order: Upstox takes `/{to}/{from}`, later date first. Reversing them answers
 * 200 with an empty array rather than an error.
 */
export function historical(
  instrumentKey: string,
  unit: 'minutes' | 'days',
  interval: number,
  from: string,
  to: string,
): Promise<Candle[]> {
  return fetchCandles(
    `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${to}/${from}`,
  );
}

/** Today's candles so far. Empty before the first bar lands, and on a non-trading day. */
export function intraday(instrumentKey: string, unit: 'minutes' | 'days', interval: number): Promise<Candle[]> {
  return fetchCandles(`/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`);
}

/**
 * Today's session, whichever endpoint actually has it.
 *
 * The intraday endpoint is authoritative during a live session but answers empty once the
 * day has rolled over, so a scanner started in the evening would see nothing. Falling back
 * to the historical endpoint for the same date recovers the completed session — and because
 * the fallback only runs when intraday is empty, it costs nothing on a normal day.
 */
export async function todaySession(instrumentKey: string, day: string, interval = 1): Promise<Candle[]> {
  const live = await intraday(instrumentKey, 'minutes', interval);
  if (live.length) return live;
  return historical(instrumentKey, 'minutes', interval, day, day).catch(() => []);
}

/**
 * Up to `MAX_MINUTE_RANGE_DAYS` of 1-minute bars, grouped by session, oldest session first.
 *
 * `to` is exclusive of today by convention — the baseline must not include the session it
 * is about to be compared against, or a heavy morning would raise its own benchmark and
 * RVOL would drift toward 1.0 exactly when it should be spiking.
 */
export async function minuteHistoryByDay(
  instrumentKey: string,
  from: string,
  to: string,
): Promise<Map<string, Candle[]>> {
  const rows = await historical(instrumentKey, 'minutes', 1, from, to);
  const byDay = new Map<string, Candle[]>();
  for (const c of rows) {
    if (c.minute < 0) continue; // pre-open / post-close prints are not part of the profile
    let bucket = byDay.get(c.day);
    if (!bucket) byDay.set(c.day, (bucket = []));
    bucket.push(c);
  }
  return byDay;
}

/** The widest 1-minute window Upstox will serve in one request, as a date. */
export const minuteRangeStart = (to: string): string =>
  new Date(Date.parse(`${to}T00:00:00Z`) - MAX_MINUTE_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10);

/**
 * Run `fn` over `items` `size` at a time.
 *
 * Upstox allows 50 requests/second and caps concurrency per token. Eight at a time is what
 * `upstox.ts` measured as safe for the option ladder and is reused here rather than
 * re-tuned, so the whole process has one concurrency story.
 */
export async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}
