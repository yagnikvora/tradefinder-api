// The cron jobs. Three of them, and the intervals are a rate-limit budget, not a taste.
//
//   SCAN        every `refresh.quoteMs` (default 15s), while the market is open.
//               Three quote requests plus up to `shortlistSize` chain requests, which the
//               enrichment cache collapses to roughly one chain pass per `refresh.enrichMs`.
//               The interval is 15s rather than 30s because the timing layer's resolution
//               IS the poll interval: a trigger cannot be reported sooner than the reading
//               that would have detected it. The chain tier is unaffected — its own TTL
//               still collapses enrichment to once a minute.
//
//   BASELINE    once a day at `refresh.baselineHourIst` (default 08:00 IST), before the
//               open. ~416 requests. Also runs on boot if the stored baseline is not
//               today's, because a scanner with no volume profile has no RVOL, which is the
//               heaviest factor in the model.
//
//   SEED        once per process per day, after the baseline. ~208 requests, and only for
//               symbols this process did not watch from the open — so a scanner that has been
//               up since 09:10 spends nothing, and one started at 13:00 (or at 21:00) rebuilds
//               the part of the session it missed from the exchange's own candles rather than
//               reporting the whole board as "warming up". See data/session-seed.ts.
//
//   FLUSH       the session state, on a slow tick, so a crash costs seconds of VWAP slope
//               rather than the morning's opening ranges.
//
// Scanning stops when the market closes. The numbers are frozen for the day, so continuing
// to poll would spend the request budget re-fetching a board that cannot change — and the
// first scan after the open needs that budget intact. One scan IS run after the close, so
// the final board of the day is the settled one and the IV history record is the close.

import { configRepository } from './config/config.repository.js';
import { runScan } from './engine/momentum.engine.js';
import { snapshotRepository } from './data/snapshot.repository.js';
import { ensureBaseline, getBaseline } from './data/baseline.js';
import { flushSessionState } from './data/session-state.js';
import { seedSession, seedStatus, type SeedOutcome } from './data/session-seed.js';
import { resetUniverse } from './data/universe.js';
import { istDay, istMinutes, marketOpen, SESSION_CLOSE_MIN } from './session.js';
import { tokenSet } from '../upstox.js';

/** How long after the close the final settling scan runs. */
const POST_CLOSE_MINUTES = 5;
const FLUSH_MS = 60_000;

let timers: NodeJS.Timeout[] = [];
let scanning = false;
let lastBaselineDay = '';
let lastSeedDay = '';
let lastPostCloseDay = '';
let lastError: { at: number; message: string } | null = null;
let lastScanAt = 0;

export interface SchedulerStatus {
  running: boolean;
  lastScanAt: number;
  lastError: { at: number; message: string } | null;
  baselineDay: string | null;
  baselineSymbols: number;
  tokenConfigured: boolean;
  seed: SeedOutcome;
}

/**
 * Run one scan and store it.
 *
 * Never throws: a scheduled job that rejects takes the timer down with it on some runtimes,
 * and a transient Upstox blip must not permanently stop the scanner. The error is recorded
 * so `/momentum/status` can report it, and the last good board stays served.
 */
export async function scanOnce(nowMs = Date.now()): Promise<void> {
  if (scanning) return; // a slow cycle must not overlap the next one and double the calls
  scanning = true;
  try {
    const cfg = await configRepository.get();
    const board = await runScan(cfg, nowMs);
    await snapshotRepository.save(board);
    lastScanAt = nowMs;
    lastError = null;
  } catch (e) {
    lastError = { at: nowMs, message: String((e as Error).message) };
  } finally {
    scanning = false;
  }
}

async function baselineTick(nowMs = Date.now()): Promise<void> {
  const cfg = await configRepository.get();
  const today = istDay(nowMs);
  if (lastBaselineDay === today) return;

  const stored = await getBaseline(nowMs);
  const dueByClock = istMinutes(nowMs) >= cfg.refresh.baselineHourIst * 60;
  const missing = !stored.baseline || stored.stale;
  if (!missing || !dueByClock) {
    // Already current for today: record it so the check is cheap for the rest of the day.
    if (!missing) lastBaselineDay = today;
    return;
  }

  lastBaselineDay = today; // set first, so a long build is not started twice
  try {
    // The expiry roll and any newly-listed F&O name land with the new day's master.
    resetUniverse();
    await ensureBaseline(
      { atrPeriod: cfg.thresholds.atrExpansion.period, trendLookback: cfg.thresholds.trendStructure.lookbackSessions },
      nowMs,
    );
  } catch (e) {
    lastBaselineDay = ''; // failed — let the next tick retry
    lastError = { at: nowMs, message: `baseline build failed: ${String((e as Error).message)}` };
  }
}

/**
 * Rebuild whatever of today's session this process did not watch.
 *
 * Runs after the baseline rather than beside it, and that ordering is load-bearing: the seed
 * scales its VWAP-side buffer and its pullback depth by ATR, and an ATR-less replay would
 * record crossings against a flat percentage band — giving a seeded board that disagrees with
 * a watched one on the single cleanest one-sidedness reading in the model.
 *
 * Once per process per day. There is no value in a second pass: symbols watched from the open
 * are skipped, and the ones that were seeded are being accumulated live from that point on.
 */
async function seedTick(nowMs = Date.now()): Promise<void> {
  if (process.env.MOMENTUM_SEED === 'off') return;
  if (!tokenSet()) return;

  const today = istDay(nowMs);
  if (lastSeedDay === today) return;
  if (istMinutes(nowMs) <= 0) return;

  lastSeedDay = today; // set first, so a slow seed is not started twice
  const out = await seedSession({}, nowMs);
  const failed = Object.keys(out.failures).length;
  if (out.seeded || failed)
    console.log(
      `[momentum] session seed: rebuilt ${out.seeded}, kept ${out.skipped} watched live, ` +
        `${out.empty} with no candles, ${failed} failed`,
    );
  // A seed that reached nothing is not today's seed. Clearing the stamp lets the next tick
  // retry, which is what recovers from booting into a spent candle quota.
  if (!out.seeded && failed) lastSeedDay = '';
}

async function scanTick(nowMs = Date.now()): Promise<void> {
  if (!tokenSet()) return;

  if (marketOpen(nowMs)) {
    await scanOnce(nowMs);
    return;
  }

  // One settling scan a few minutes after the close, so the day's final board — and the IV
  // history row built from it — reflects the closing print rather than 15:29.
  const today = istDay(nowMs);
  const minutes = istMinutes(nowMs);
  if (
    lastPostCloseDay !== today &&
    minutes >= SESSION_CLOSE_MIN + POST_CLOSE_MINUTES &&
    minutes < SESSION_CLOSE_MIN + 60
  ) {
    lastPostCloseDay = today;
    await scanOnce(nowMs);
  }
}

/** Start the jobs. Idempotent — calling twice does not double the timers. */
export async function startScheduler(): Promise<void> {
  if (timers.length) return;
  const cfg = await configRepository.get();

  // `unref` so these never hold the process open on their own: a CLI that imports this
  // module should still exit when its work is done.
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  // The seed chases the baseline rather than running on its own timer, because it needs that
  // baseline's ATRs to measure a replayed session the same way a watched one is measured. Both
  // are no-ops once they have run for the day, so the five-minute cadence is only a retry.
  const baselineThenSeed = (nowMs?: number) =>
    baselineTick(nowMs)
      .catch((e) => { lastError = { at: Date.now(), message: `baseline tick: ${String((e as Error).message)}` }; })
      .then(() => seedTick(nowMs))
      .catch((e) => { lastError = { at: Date.now(), message: `session seed: ${String((e as Error).message)}` }; });

  every(cfg.refresh.quoteMs, () => void scanTick());
  every(5 * 60_000, () => void baselineThenSeed());
  // Forced on this tick: the scan's own flush is throttled to keep a 2MB write off every
  // 15-second cycle, and this is the one that guarantees the morning reaches disk anyway.
  every(FLUSH_MS, () => void flushSessionState(true));

  // Kick both immediately rather than waiting a full interval for the first board.
  void baselineThenSeed();
  void scanTick();
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const b = await getBaseline();
  return {
    running: timers.length > 0,
    lastScanAt,
    lastError,
    baselineDay: b.baseline?.day ?? null,
    baselineSymbols: Object.keys(b.baseline?.symbols ?? {}).length,
    tokenConfigured: tokenSet(),
    // Surfaced because "no trend days today" and "this process never rebuilt the session"
    // produce an identical empty board and want opposite responses.
    seed: seedStatus(),
  };
}
