// The composition root for the database — the one file that decides what Postgres backs.
//
// Everything else in `db/` is a driver. This is the switch, and it is deliberately the only
// place a driver is chosen, so the answer to "what is stored where?" is one file rather than a
// grep across three modules.
//
// WHAT MOVES, and nothing else:
//
//   app_config       both configs. Small documents, versioned, read once and memoised.
//   momentum_history one row per symbol per session — the IV series nothing else can produce.
//   pullback_signal  the fired-signal log with its outcomes — the analytics table.
//
// WHAT DELIBERATELY STAYS ON DISK, because a database makes each of them worse:
//
//   pullback_seed    17.6 MB written once a day, read once at boot, always whole. As JSONB it
//                    is a 17 MB round trip; normalised it is ~271k rows that are only ever
//                    SELECTed in full. There is no query in it.
//   baseline         722 KB of per-symbol volume profiles — arrays consumed whole, same story.
//   instruments      a daily mirror of a static CDN asset.
//   snapshot(s)      REWRITTEN EVERY 15 AND 30 SECONDS. As inserts that is ~4 GB a day of
//                    TOASTed JSONB to store a board that is superseded seconds later and only
//                    ever read as "the last one". An atomic file rename already does this well.
//   last-good        the outage fallback, which is the one thing that must not depend on a
//                    second network service being up.
//
// FAILING SOFT IS THE POINT OF THE LAST LINE ABOVE. If the database cannot be reached at boot,
// this logs and leaves every file driver in place rather than throwing. A trading board that
// degrades to yesterday's storage is a working board; one that refuses to start because an
// analytics table is unreachable has turned a nice-to-have into an outage.

import { dbEnabled, verifyDb } from './pool.js';
import { PgKeyValueStore } from './kv.pg.js';
import { StoredConfigRepository as MomentumConfigRepo, useMomentumConfigRepository } from '../momentum/config/config.repository.js';
import { StoredConfigRepository as PullbackConfigRepo, usePullbackConfigRepository } from '../pullback/config/config.repository.js';
import { useHistoryRepository } from '../momentum/data/history.repository.js';
import { PgHistoryRepository } from '../momentum/data/history.repository.pg.js';
import { useSignalRepository } from '../pullback/data/signal.repository.js';
import { PgSignalRepository } from '../pullback/data/signal.repository.pg.js';

export interface DbStatus {
  configured: boolean;
  connected: boolean;
  version?: string;
  error?: string;
}

let status: DbStatus = { configured: false, connected: false };

/** What the database is doing, for `/health` and the two `/status` endpoints. */
export const dbStatus = (): DbStatus => status;

/**
 * Point the three queryable repositories at Postgres, if one is configured and reachable.
 *
 * Must be awaited BEFORE the modules are mounted: `mountMomentum` starts a scheduler that
 * reads the config immediately, and a swap that landed after that would leave the running
 * scheduler holding the file-backed config while everything else used the database.
 */
export async function connectDb(): Promise<DbStatus> {
  if (!dbEnabled()) {
    status = { configured: false, connected: false };
    return status;
  }

  const check = await verifyDb();
  if (!check.ok) {
    status = { configured: true, connected: false, error: check.error };
    console.error(
      `[db] DATABASE_URL is set but the database is not usable — continuing on the JSON file store.\n` +
      `     ${check.error}\n` +
      `     If this is a fresh database, run: npm run db:migrate`,
    );
    return status;
  }

  const kv = new PgKeyValueStore();
  useMomentumConfigRepository(new MomentumConfigRepo(kv));
  usePullbackConfigRepository(new PullbackConfigRepo(kv));
  useHistoryRepository(new PgHistoryRepository());
  useSignalRepository(new PgSignalRepository());

  status = { configured: true, connected: true, version: check.version };
  console.log(`[db] connected — config, momentum history and pullback signals are on Postgres (${check.version})`);
  return status;
}
