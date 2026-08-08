// The 1-minute bar archive — read, write, and the packing that makes it affordable.
//
// This is the store backtesting reads from, and the reason it exists is a rate limit rather
// than a preference: Upstox serves at most ~30 calendar days of 1-minute candles per request
// against a 2000-per-30-minute ceiling, so a year of history for a 212-symbol universe is not
// something you can fetch when you want it. It has to be ACCUMULATED — one session at a time,
// kept forever, and never asked for twice. A rolling cache like `pullback_seed` cannot do that
// by construction; it throws the window away every morning.
//
// THE SIZE ARGUMENT, because it decides the design. One row per BAR would be 212 symbols x
// 375 minutes x 250 sessions ≈ 20 million rows a year, about 1.8 GB with indexes — past the
// free tier of every hosted Postgres inside a quarter. One row per SYMBOL-DAY holding the
// session packed into 22 bytes a bar is ~8 KB a row before compression, ~53,000 rows a year,
// and lands near 150–250 MB a year once Postgres has TOASTed it. Same data, same queries,
// roughly an eighth of the space and four hundredths of the rows.
//
// Nothing is lost by packing. Every reader wants a contiguous range for one symbol — the
// backtest replays a session bar by bar, the seed loads the last fortnight — and not one of
// them filters on a bar's contents. There is no query being given up here.

import { query } from './pool.js';
import type { Bar } from '../pullback/indicators/series.js';

/** Bytes per packed bar. See `schema.sql` for the field layout. */
const STRIDE = 22;

/** 09:15 IST is 03:45 UTC. The archive stores minute-of-session and rebuilds `at` from it. */
const sessionOpenMs = (day: string): number => Date.parse(`${day}T03:45:00Z`);

/**
 * Pack one session's 1-minute bars.
 *
 * Bars outside the regular session are dropped rather than stored: `minute < 0` is a pre-open
 * or post-close print, every consumer already filters them, and an int16 minute cannot carry a
 * negative one without spending a sign bit on data nobody reads.
 */
export function pack(bars: Bar[]): Buffer {
  const usable = bars
    .filter((b) => b.minute >= 0 && Number.isFinite(b.open) && Number.isFinite(b.close))
    .sort((a, b) => a.minute - b.minute);

  const buf = Buffer.allocUnsafe(usable.length * STRIDE);
  usable.forEach((b, i) => {
    const o = i * STRIDE;
    buf.writeInt16LE(b.minute, o);
    // Rounded, not truncated. NSE ticks in 5-paise steps so the input is already exact to the
    // paisa; rounding is here so a float that arrived as 245.99999999997 stores as 24600 rather
    // than 24599, which over a session is the difference between a stop being touched and not.
    buf.writeInt32LE(Math.round(b.open * 100), o + 2);
    buf.writeInt32LE(Math.round(b.high * 100), o + 6);
    buf.writeInt32LE(Math.round(b.low * 100), o + 10);
    buf.writeInt32LE(Math.round(b.close * 100), o + 14);
    buf.writeInt32LE(Math.round(b.volume), o + 18);
  });
  return buf;
}

/**
 * Unpack one session, oldest first.
 *
 * `turnover` is recomputed rather than stored, and the formula is `fromCandle`'s exactly:
 * ((high + low + close) / 3) x volume. That is not an approximation of what was archived — it
 * IS what `fromCandle` produces for an exchange candle, so a bar that goes through the archive
 * and one that came straight off Upstox are identical objects. Poll-built bars carry a true
 * turnover from the cumulative counter and are never archived, which is why this holds.
 */
export function unpack(day: string, buf: Buffer): Bar[] {
  const open = sessionOpenMs(day);
  const out: Bar[] = [];
  for (let o = 0; o + STRIDE <= buf.length; o += STRIDE) {
    const minute = buf.readInt16LE(o);
    const high = buf.readInt32LE(o + 6) / 100;
    const low = buf.readInt32LE(o + 10) / 100;
    const close = buf.readInt32LE(o + 14) / 100;
    const volume = buf.readInt32LE(o + 18);
    out.push({
      at: open + minute * 60_000,
      day,
      minute,
      open: buf.readInt32LE(o + 2) / 100,
      high,
      low,
      close,
      volume,
      turnover: ((high + low + close) / 3) * volume,
    });
  }
  return out;
}

/* --------------------------------------------------------------------------- read --- */

/**
 * One symbol's 1-minute bars across a date range, oldest first.
 *
 * Returned as one flat array because that is what every caller wants — `resample()` and the
 * backtest replay both walk a continuous series and neither cares where a session ended.
 */
export async function readRange(symbol: string, from: string, to: string): Promise<Bar[]> {
  const rows = await query<{ day: string; bars: Buffer }>(
    `SELECT day::text AS day, bars
       FROM candle_archive
      WHERE symbol = $1 AND interval_min = 1 AND day BETWEEN $2::date AND $3::date
      ORDER BY day`,
    [symbol, from, to],
  );
  const out: Bar[] = [];
  for (const r of rows) out.push(...unpack(r.day.slice(0, 10), r.bars));
  return out;
}

/** Which sessions are already archived for a symbol, as a Set of YYYY-MM-DD. */
export async function archivedDays(symbol: string, from: string, to: string): Promise<Set<string>> {
  const rows = await query<{ day: string }>(
    `SELECT day::text AS day
       FROM candle_archive
      WHERE symbol = $1 AND interval_min = 1 AND day BETWEEN $2::date AND $3::date`,
    [symbol, from, to],
  );
  return new Set(rows.map((r) => r.day.slice(0, 10)));
}

/* -------------------------------------------------------------------------- write --- */

/**
 * Store a set of sessions for one symbol.
 *
 * `ON CONFLICT DO UPDATE` rather than DO NOTHING: re-archiving a day is how a session first
 * captured from the intraday endpoint gets replaced by the exchange's settled version, and
 * refusing the write would leave the approximate one in place forever.
 */
export async function writeDays(symbol: string, bySession: Map<string, Bar[]>): Promise<number> {
  const days = [...bySession.keys()].filter((d) => (bySession.get(d)?.length ?? 0) > 0);
  if (!days.length) return 0;

  // Parallel arrays through `unnest` — the parameter count stays at four however many sessions
  // are being written, so a 400-day backfill is one statement rather than 400.
  await query(
    `INSERT INTO candle_archive (symbol, day, interval_min, bars, bar_count)
     SELECT $1, d::date, 1, b, c
       FROM unnest($2::text[], $3::bytea[], $4::int[]) AS t(d, b, c)
     ON CONFLICT (symbol, day, interval_min) DO UPDATE
       SET bars = EXCLUDED.bars, bar_count = EXCLUDED.bar_count, archived_at = now()`,
    [
      symbol,
      days,
      days.map((d) => pack(bySession.get(d)!)),
      days.map((d) => bySession.get(d)!.filter((b) => b.minute >= 0).length),
    ],
  );
  return days.length;
}

/** Group a flat bar array by IST session — what `writeDays` takes. */
export function bySession(bars: Bar[]): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  for (const b of bars) {
    if (b.minute < 0) continue;
    let bucket = map.get(b.day);
    if (!bucket) map.set(b.day, (bucket = []));
    bucket.push(b);
  }
  return map;
}

/* -------------------------------------------------------------------------- stats --- */

export interface ArchiveStats {
  symbols: number;
  sessions: number;
  rows: number;
  bars: number;
  bytes: number;
  from: string | null;
  to: string | null;
}

/** What the archive holds, for the CLI and for deciding whether a backtest has the data. */
export async function stats(): Promise<ArchiveStats> {
  const [r] = await query<Record<string, string | null>>(
    `SELECT count(DISTINCT symbol)::text  AS symbols,
            count(DISTINCT day)::text     AS sessions,
            count(*)::text                AS rows,
            coalesce(sum(bar_count),0)::text AS bars,
            coalesce(sum(length(bars)),0)::text AS bytes,
            min(day)::text                AS from_day,
            max(day)::text                AS to_day
       FROM candle_archive`,
  );
  return {
    symbols: Number(r?.symbols ?? 0),
    sessions: Number(r?.sessions ?? 0),
    rows: Number(r?.rows ?? 0),
    bars: Number(r?.bars ?? 0),
    bytes: Number(r?.bytes ?? 0),
    from: r?.from_day ?? null,
    to: r?.to_day ?? null,
  };
}

/** On-disk size after TOAST compression — the number that matters against a storage quota. */
export async function storedSize(): Promise<string> {
  const [r] = await query<{ s: string }>(`SELECT pg_size_pretty(pg_total_relation_size('candle_archive')) AS s`);
  return r?.s ?? 'unknown';
}
