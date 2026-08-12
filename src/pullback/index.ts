// PullbackModule — the composition root.
//
// This is the only file the rest of the API imports. Everything inside `pullback/` is reached
// through it, so the module can be rewired — a Postgres repository, a Redis cache, a different
// scheduler, a different alert channel — without touching `src/index.ts`.
//
// The layering the brief asked for, and where each layer actually lives:
//
//   controller.ts                    the HTTP layer. Validation in, envelope out, nothing else.
//   dto.ts                           request parsing and the board's filters/sorts.
//   engine/scanner.engine.ts         the orchestrator — the only file that knows about tiers.
//   engine/trend.service.ts          "is this a trend"          — pure, no state, no clock.
//   engine/pullback.service.ts       "has it pulled back"       — pure.
//   engine/score.service.ts          the 100-point confidence   — pure.
//   engine/risk.service.ts           stops and targets          — pure.
//   engine/option.service.ts         which contract to buy      — pure.
//   engine/signal.service.ts         assembly, and the refusals — pure.
//   indicators/*.ts                  EMA, ATR, ADX, VWAP, swings, candles — all pure.
//   data/*.ts                        universe, quotes, bars, and the repositories.
//   backtest/backtest.engine.ts      the same services, walked over history.
//   alerts/alert.engine.ts           the five events, with dedupe. NOT FED BY THIS MODULE ANY
//                                    MORE — the scan no longer raises alerts. The engine, both
//                                    phone channels and the HTTP feed are intact and callable;
//                                    see the "log, settle" section of the scanner engine.
//   alerts/session-bell.ts           the 09:15 and 15:30 messages. A calendar event rather than a
//                                    strategy one, which is why it does not go through the engine.
//   config/*.ts                      every threshold, and the repair pass over a patch.
//
// THE PURITY IS THE POINT, not a stylistic preference. Every service above takes bars and a
// config and returns a reading. That is what lets the backtest exercise the live strategy rather
// than a copy of it (`backtest/backtest.engine.ts` explains why a copy is worse than no
// backtest), and it is what makes the whole strategy testable without a network, a clock or a
// token — see `test/pullback.test.ts`.
//
// The brief asked for a NestJS module. This codebase is Express, so what is provided is the same
// SHAPE — controller, services, repositories, DTOs, config, cron — wired by hand instead of by a
// DI container, exactly as the momentum module already does.

import type express from 'express';
import { pullbackRouter } from './controller.js';
import { startScheduler, stopScheduler } from './scheduler.js';

export interface PullbackModuleOptions {
  /** Where to mount. Defaults to /pullback. */
  path?: string;
  /**
   * Run the background jobs. Off in tests, and worth turning off on a second replica so two
   * processes do not both spend the same token's request budget on the same scan.
   */
  scheduler?: boolean;
}

/** Mount the module. Returns a teardown so a test can stop the timers. */
export function mountPullback(app: express.Application, opts: PullbackModuleOptions = {}): () => void {
  app.use(opts.path ?? '/pullback', pullbackRouter());
  if (opts.scheduler !== false) void startScheduler();
  return () => stopScheduler();
}

export { pullbackRouter } from './controller.js';
export { runScan, chooseCandidates, chartSeries } from './engine/scanner.engine.js';
export { readTrend, agrees } from './engine/trend.service.js';
export { readPullback } from './engine/pullback.service.js';
export { scoreSignal, alignedTimeframes } from './engine/score.service.js';
export { buildPlan, buildStops, buildTargets, realisedR } from './engine/risk.service.js';
export { selectOption, scoreLiquidity, atmIv } from './engine/option.service.js';
export { evaluateSignal, worthWatching } from './engine/signal.service.js';
export { backtest } from './backtest/backtest.engine.js';
export { alerts, alertStatus, resetAlerts } from './alerts/alert.engine.js';
export {
  dueBell, previewBell, renderBell, sessionBellStatus, sessionBellTick, resetSessionBell, type Bell,
} from './alerts/session-bell.js';
export {
  bestOf, fitness, parseBatch, quoteFor, quoteStatus, usable, type Quote,
} from './alerts/quotes.js';
export { configRepository, StoredConfigRepository, sanitise, PULLBACK_KEYS } from './config/config.repository.js';
export { defaultConfig, DEFAULT_CONFIG, DEFAULT_INDICES } from './config/defaults.js';
export { signalRepository, summarise } from './data/signal.repository.js';
export { snapshotRepository, ageLabel } from './data/snapshot.repository.js';
export { universe, resetUniverse } from './data/universe.js';
export {
  buildSeed, catchUpToday, computeSeries, ensureSeed, frameStore, framesFor, loadSeed, observe,
  readFrame, readFrames, readFromBars, resetFrames, resync, barsOf, MAX_BARS,
} from './data/frames.js';
export { startScheduler, stopScheduler, scanOnce, schedulerStatus } from './scheduler.js';
export * from './types.js';

