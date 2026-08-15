// Historical daily baseline behind R.Factor.
//
// R.Factor compares a stock's move today against what is normal FOR THAT STOCK, so it
// needs a trailing history no live quote carries. This used to scrape NSE's daily Bhavcopy
// CSVs — one file per session, covering every symbol. Upstox inverts that: one request per
// symbol, covering every session. Slightly more requests, but no CSV parsing, no archive
// host, no 404-means-holiday guessing, and it comes off the same token as everything else.
//
// Both averages are computed here and cached to disk:
//   avgDailyRanges  — mean daily range as a % of the previous close. This is what R.Factor
//                     actually divides by; measured against tradefinder's published
//                     numbers, range predicts theirs far better than volume does
//                     (Spearman 0.80 vs 0.66), so R.Factor is a volatility multiple.
//   avgDailyVolumes — mean daily traded quantity. Kept for /health/volume and because the
//                     relative-volume reading is still worth having.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineSymbols, dailyBars } from './equity.js';
import { breakerState, CANDLE_ENDPOINT, throttledFor } from './momentum/data/throttle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Outside src so a rebuild won't wipe it.
const CACHE_FILE = path.join(__dirname, '..', '.cache', 'baseline.json');

// Trailing sessions for the average. 20 is the textbook window, but measured against
// tradefinder's published R.Factor the agreement climbs steadily with a longer baseline
// (Spearman 0.65 at 2 sessions → 0.80 at 20, still rising at the limit of the history we
// held) — their baseline is evidently deeper than a month, so we match it.
const WINDOW = Number(process.env.RVOL_WINDOW) || 50;
// Calendar days to request to collect WINDOW trading days, with room for holidays.
const LOOKBACK_DAYS = 100;
// Concurrent requests. Upstox allows 50/sec and 500/min per API; ten at a time finishes
// ~200 symbols in a couple of seconds and stays far inside both.
const BATCH = 10;
const REFRESH_MS = 12 * 60 * 60e3;
/**
 * How long a FAILED rebuild waits before it may be attempted again.
 *
 * This is the fix for the loop that starved the ATR baseline. On failure the old code kept the
 * disk copy — including its old timestamp — so `ensure()`'s "is it fresher than REFRESH_MS"
 * guard never held, and the very next caller started another 213-request rebuild. With the
 * dashboard polling Market Pulse every 15 seconds that was ~800 requests a minute against a
 * 2000-per-30-minute budget: it emptied the endpoint's quota in about two minutes and kept it
 * empty, which is why the 08:00 ATR build got a 429 on its first request every single morning.
 *
 * Thirty minutes is Upstox's own window, so a retry lands when there is actually budget for it.
 */
const RETRY_AFTER_FAILURE_MS = 30 * 60e3;

interface Cache {
  avg: Record<string, number>;       // mean daily volume (shares)
  avgRange: Record<string, number>;  // mean daily range (% of previous close)
  sessions: number;                  // deepest session count seen, for diagnostics
  at: number;
}

let mem: Cache | null = null;
let loading: Promise<void> | null = null;
/**
 * When the last rebuild failed, and why. Separate from `mem.at` — which is when the DATA was
 * built — because conflating the two is exactly what caused the loop: a failed run must not be
 * able to present stale data as freshly built, and must not be able to retry immediately either.
 */
let lastFailure: { at: number; reason: string } | null = null;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Mean daily range and volume for one symbol over the newest WINDOW sessions.
 *
 * Range is measured against the PREVIOUS session's close, which is what a gap makes
 * meaningful — a stock that opens 3% away and then trades a narrow band has moved, and
 * dividing by its own close would hide that. The first bar has no predecessor and is used
 * only as that reference.
 */
function summarise(bars: Awaited<ReturnType<typeof dailyBars>>) {
  const recent = bars.slice(-(WINDOW + 1));
  let rSum = 0, rCnt = 0, vSum = 0, vCnt = 0;
  for (let i = 1; i < recent.length; i++) {
    const [, , high, low, , volume] = recent[i];
    const prevClose = recent[i - 1][4];
    if (prevClose > 0 && high > 0 && low > 0) { rSum += ((high - low) / prevClose) * 100; rCnt++; }
    if (volume > 0) { vSum += volume; vCnt++; }
  }
  // A handful of sessions is not an average worth dividing by.
  return {
    range: rCnt >= 3 ? rSum / rCnt : 0,
    volume: vCnt >= 3 ? vSum / vCnt : 0,
    sessions: Math.max(rCnt, vCnt),
  };
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function rebuild(): Promise<void> {
  const disk = await fs.readFile(CACHE_FILE, 'utf8').then((t) => JSON.parse(t) as Cache).catch(() => null);
  if (disk && Date.now() - disk.at < REFRESH_MS) { mem = disk; return; }

  const to = iso(Date.now());
  const from = iso(Date.now() - LOOKBACK_DAYS * 86400e3);
  const symbols = await baselineSymbols();

  const avg: Record<string, number> = {};
  const avgRange: Record<string, number> = {};
  let deepest = 0;

  // Errors are COUNTED now rather than dropped on the floor. The old empty `catch` is why this
  // failure was invisible for so long: 213 symbols could all answer 429 and the only trace was
  // an R.Factor column quietly falling back to its per-symbol estimate.
  let refused = 0;
  let firstError = '';

  await inBatches(symbols, BATCH, async (sym) => {
    try {
      const bars = await dailyBars(sym, from, to);
      if (bars.length < 4) return;
      const { range, volume, sessions } = summarise(bars);
      if (range > 0) avgRange[sym] = range;
      if (volume > 0) avg[sym] = volume;
      if (sessions > deepest) deepest = sessions;
    } catch (e) {
      // One symbol Upstox won't serve costs that symbol its baseline, not the whole run.
      // rfac() in services.ts already falls back to a bounded estimate per symbol.
      const message = String((e as Error).message);
      const status = (e as { status?: number }).status ?? 0;
      if (status === 429 || message.includes('rate limited')) refused++;
      if (!firstError) firstError = `${sym}: ${message}`;
    }
  });

  // A run that priced almost nothing is a failure, not a baseline — keep whatever the disk
  // holds rather than overwriting it with an empty one.
  if (Object.keys(avgRange).length < symbols.length * 0.5) {
    const reason =
      `covered only ${Object.keys(avgRange).length}/${symbols.length} symbols` +
      (refused ? ` — ${refused} were rate limited by Upstox` : '') +
      (firstError ? ` (first error ${firstError})` : '');
    console.warn(`[volume] R.Factor baseline rebuild failed: ${reason}`);
    // Stamped so `ensure()` will not immediately try again. Keeping the disk copy is still the
    // right call for the DATA — a day-old average beats none — but it must not also reset the
    // retry clock, which is the bug that emptied the candle budget every morning.
    lastFailure = { at: Date.now(), reason };
    if (disk) { mem = disk; return; }
    throw new Error(`baseline ${reason}`);
  }
  if (refused)
    console.warn(`[volume] R.Factor baseline built, but ${refused} symbols were rate limited and have no average`);

  lastFailure = null; // a clean build clears the back-off
  const next: Cache = { avg, avgRange, sessions: deepest, at: Date.now() };
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true }).catch(() => {});
  await fs.writeFile(CACHE_FILE, JSON.stringify(next), 'utf8').catch(() => {});
  mem = next;
}

/**
 * Make sure a baseline is in memory, rebuilding at most twice a day.
 *
 * THREE GATES, and the last two are what stop this module starving the morning ATR build.
 * Every one of them exists because a Market Pulse request arrives every 15 seconds while the
 * dashboard is open, and each one used to be able to start a fresh 213-request rebuild.
 */
async function ensure(): Promise<void> {
  if (mem && Date.now() - mem.at < REFRESH_MS) return;

  // Back off after a failure. Without this, a failed rebuild kept the disk copy's OLD timestamp
  // and the guard above never held again, so every single caller started another full rebuild.
  if (lastFailure && Date.now() - lastFailure.at < RETRY_AFTER_FAILURE_MS) return;

  // Don't queue 213 requests behind an endpoint that has already said no. The morning ATR build
  // shares this budget and is the one with a deadline; a stale R.Factor average is a far cheaper
  // loss than an ATR baseline that cannot be built before the open.
  const throttled = throttledFor(CANDLE_ENDPOINT);
  if (throttled > 0) {
    lastFailure = { at: Date.now(), reason: `candle endpoint rate limited for another ${Math.ceil(throttled / 1000)}s` };
    return;
  }

  if (!loading) loading = rebuild().finally(() => { loading = null; });
  try { await loading; } catch { /* keep whatever we have; callers handle {} */ }
}

/** Reported on /health/volume, so a silently stale R.Factor baseline is diagnosable. */
export const volumeBaselineStatus = () => ({
  builtAt: mem ? new Date(mem.at).toISOString() : null,
  ageHours: mem ? +((Date.now() - mem.at) / 3600e3).toFixed(1) : null,
  symbols: mem ? Object.keys(mem.avgRange).length : 0,
  sessions: mem?.sessions ?? 0,
  lastFailure: lastFailure
    ? { at: new Date(lastFailure.at).toISOString(), reason: lastFailure.reason }
    : null,
  rateLimit: breakerState(CANDLE_ENDPOINT),
});

/**
 * SYMBOL → mean daily range as a % of the previous close. The baseline R.Factor divides by.
 * Built on first call, then at most twice a day. `{}` if Upstox can't be reached at all,
 * which makes rfac() fall back to its bounded per-symbol estimate.
 */
export async function avgDailyRanges(): Promise<Record<string, number>> {
  await ensure();
  return mem?.avgRange ?? {};
}

/** SYMBOL → mean daily traded quantity over the same window. */
export async function avgDailyVolumes(): Promise<Record<string, number>> {
  await ensure();
  return mem?.avg ?? {};
}

/** Sessions of history behind the averages (for /health/volume). */
// NOTE: historyDepth and avgDailyVolumes are reached through a dynamic import() in
// index.ts (/health/volume), so a grep for a static import of them finds nothing. They are
// used — don't delete them on the strength of a dead-code sweep.
export async function historyDepth(): Promise<number> {
  await ensure();
  return mem?.sessions ?? 0;
}
