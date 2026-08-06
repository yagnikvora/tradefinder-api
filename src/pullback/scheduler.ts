// The cron jobs. Three of them, and the intervals are a rate-limit budget, not a taste.
//
//   SCAN   every `refresh.scanMs` (default 30s), while the market is open. Two quote requests,
//          plus up to `enrichLimit` option chains and the same number of bar resyncs — both of
//          which their own caches collapse to roughly one pass per minute and per two minutes.
//
//          The interval is 30 seconds rather than a minute because the scanner's resolution IS
//          the poll interval: a 3-minute bar closing at 11:03:00 cannot be reported before the
//          reading that observes it, and a signal published a minute late has given away a
//          third of the freshness the whole module is built on.
//
//   SEED   once a day at `refresh.seedHourIst` (default 08:00 IST), before the open. ~215
//          requests. Also runs on boot when the stored seed is not from the previous session,
//          because a 200-period EMA on a 15-minute chart spans eight sessions and cannot be
//          computed from today — a scanner without the seed has no long averages at all.
//
//   FLUSH  the signal log, on a slow tick, so a crash costs at most a minute of outcome
//          tracking rather than the day's record of what fired.
//
// Scanning stops when the market closes. The bars are frozen for the day, so continuing to poll
// would spend budget re-reading a board that cannot change — and the first scan after the open
// needs that budget intact. ONE scan runs after the close, so the day's final board settles every
// open signal to `Expired` rather than leaving them Open into tomorrow.

import { tokenSet } from '../upstox.js';
import { istDay, istMinutes, marketOpen, SESSION_CLOSE_MIN } from '../momentum/session.js';
import { resetAlerts } from './alerts/alert.engine.js';
import { configRepository } from './config/config.repository.js';
import { buildSeed, frameStore, loadSeed } from './data/frames.js';
import { signalRepository } from './data/signal.repository.js';
import { snapshotRepository } from './data/snapshot.repository.js';
import { resetUniverse, universe } from './data/universe.js';
import { runScan } from './engine/scanner.engine.js';

/** How long after the close the final settling scan runs. */
const POST_CLOSE_MINUTES = 5;
const FLUSH_MS = 60_000;

let timers: NodeJS.Timeout[] = [];
let scanning = false;
let lastSeedDay = '';
let lastPostCloseDay = '';
let lastAlertResetDay = '';
let lastError: { at: number; message: string } | null = null;
let lastScanAt = 0;

export interface SchedulerStatus {
  running: boolean;
  lastScanAt: number;
  lastError: { at: number; message: string } | null;
  tokenConfigured: boolean;
}

/**
 * Run one scan and store it.
 *
 * Never throws. A scheduled job that rejects takes the timer down with it on some runtimes, and a
 * transient Upstox blip must not permanently stop the scanner. The error is recorded so
 * `/pullback/status` can report it, and the last good board stays served.
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

async function seedTick(nowMs = Date.now()): Promise<void> {
  if (!tokenSet()) return;
  const today = istDay(nowMs);
  if (lastSeedDay === today) return;

  const cfg = await configRepository.get();
  const uni = await universe(cfg.universe, nowMs);

  // Restore from disk first — it costs nothing and is usually enough. A seed built yesterday
  // evening covers every session up to and including yesterday, which is exactly what today
  // needs, so the rebuild below only runs when the stored copy is older than that.
  const store = frameStore(nowMs);
  if (!store.symbols.size) await loadSeed(uni.members, nowMs);

  const covered = [...store.symbols.values()].filter((f) => f.seededThrough !== null);
  const yesterdayCovered = covered.length >= uni.members.length * 0.8 && covered[0]?.seededThrough === lastTradingDayBefore(today);
  const dueByClock = istMinutes(nowMs) >= cfg.refresh.seedHourIst * 60;

  if (yesterdayCovered) {
    lastSeedDay = today; // current — make the check cheap for the rest of the day
    return;
  }
  if (!dueByClock && covered.length >= uni.members.length * 0.5) return;

  lastSeedDay = today; // set first, so a long build is not started twice
  try {
    // The expiry roll and any newly-listed F&O name land with the new day's master.
    resetUniverse();
    const fresh = await universe(cfg.universe, nowMs);
    const result = await buildSeed(fresh.members, cfg, nowMs);
    if (result.covered < fresh.members.length * 0.5) {
      lastSeedDay = ''; // let the next tick retry
      lastError = { at: nowMs, message: `EMA seed covered only ${result.covered}/${fresh.members.length} symbols` };
    }
  } catch (e) {
    lastSeedDay = '';
    lastError = { at: nowMs, message: `EMA seed build failed: ${String((e as Error).message)}` };
  }
}

/**
 * The previous calendar day, which is the seed's target.
 *
 * A calendar day rather than a trading day on purpose. `buildSeed` asks for a 20-day range and
 * takes whatever sessions Upstox serves inside it, so a Monday's seed correctly covers through
 * Friday — this comparison only has to answer "was this built for today", and a Monday seed
 * stamped with Sunday's date would fail the test and trigger one harmless extra rebuild, where a
 * trading calendar this module does not have would be a second source of truth about holidays.
 */
const lastTradingDayBefore = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

async function scanTick(nowMs = Date.now()): Promise<void> {
  if (!tokenSet()) return;

  // Yesterday's phase memory must not fire today's alerts: a row that ended yesterday `AtZone`
  // would otherwise look unchanged this morning and never produce a fresh-pullback alert, while a
  // row that ended `Resuming` would fire a rejection the moment today's first bar closed lower.
  const today = istDay(nowMs);
  if (lastAlertResetDay !== today) {
    lastAlertResetDay = today;
    resetAlerts();
  }

  if (marketOpen(nowMs)) {
    await scanOnce(nowMs);
    return;
  }

  // One settling scan a few minutes after the close, so every signal still open is moved to
  // `Expired` and the day's record is final rather than carrying phantom positions into tomorrow.
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

  // `unref` so these never hold the process open on their own: a CLI that imports this module
  // should still exit when its work is done.
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    timers.push(t);
  };

  every(cfg.refresh.scanMs, () => void scanTick());
  every(5 * 60_000, () => void seedTick());
  every(FLUSH_MS, () => void signalRepository.flush());

  // Kick both immediately rather than waiting a full interval for the first board. The seed goes
  // first and is awaited, because a scan that runs before it has nothing to compute.
  await seedTick().catch(() => {});
  void scanTick();
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

export const schedulerStatus = (): SchedulerStatus => ({
  running: timers.length > 0,
  lastScanAt,
  lastError,
  tokenConfigured: tokenSet(),
});
