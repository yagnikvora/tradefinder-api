// MomentumModule — the composition root.
//
// This is the only file the rest of the API imports. Everything inside `momentum/` is
// reached through it, so the module can be rewired — a Postgres repository, a Redis cache,
// a different scheduler — without touching `src/index.ts`.
//
// The brief asked for a NestJS module. This codebase is Express, so what is provided is the
// same SHAPE — controller, services, repositories, DTOs, config, cron — wired by hand
// instead of by a DI container. `mountMomentum(app)` is `MomentumModule`; the exports below
// are its providers.
//
//   controller.ts                 @Controller('momentum')
//   engine/momentum.engine.ts     the orchestrator
//   engine/score.service.ts       weighting, direction, confidence
//   services/*.service.ts         one per factor, each independently unit-testable
//   data/*.repository.ts          config, snapshot, history — interfaces, not classes
//   cache.ts                      the Redis-shaped cache interface
//   scheduler.ts                  @Cron

import type express from 'express';
import { momentumRouter } from './controller.js';
import { startScheduler, stopScheduler } from './scheduler.js';

export interface MomentumModuleOptions {
  /** Where to mount. Defaults to /momentum, which is what the brief specifies. */
  path?: string;
  /**
   * Run the background jobs. Off in tests, and worth turning off on a second replica so two
   * processes do not both spend the same token's request budget on the same scan.
   */
  scheduler?: boolean;
}

/** Mount the module. Returns a teardown so a test can stop the timers. */
export function mountMomentum(app: express.Application, opts: MomentumModuleOptions = {}): () => void {
  const path = opts.path ?? '/momentum';
  app.use(path, momentumRouter());

  if (opts.scheduler !== false) void startScheduler();
  return () => stopScheduler();
}

export { momentumRouter } from './controller.js';
export { runScan } from './engine/momentum.engine.js';
export { scoreRow, institutionalActivity } from './engine/score.service.js';
export { configRepository, StoredConfigRepository, sanitise } from './config/config.repository.js';
export { defaultConfig, DEFAULT_CONFIG } from './config/defaults.js';
export { historyRepository } from './data/history.repository.js';
export { snapshotRepository } from './data/snapshot.repository.js';
export { seedSession, seedStatus, replayQuotes } from './data/session-seed.js';
export { buildBaseline, getBaseline, ensureBaseline } from './data/baseline.js';
export { cache, MemoryCache, type MomentumCache } from './cache.js';
export { startScheduler, stopScheduler, scanOnce, schedulerStatus } from './scheduler.js';
export * from './types.js';
