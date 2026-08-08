// npm run db:migrate — apply the schema, then lift what is already on disk into it.
//
// Idempotent and safe to re-run. The schema is all `CREATE TABLE IF NOT EXISTS`, and every
// backfill is an upsert keyed the same way the live repositories key their writes, so running
// this twice inserts nothing the second time.
//
// THE BACKFILL IS THE POINT, not the schema. `momentum_history` is the IV series — one row per
// symbol per session, and Upstox publishes no historical IV at any tier, so those rows exist
// nowhere else in the world. Starting the database empty would throw away however many sessions
// the JSON file has already accumulated and restart the ~20-session warm-up that IV Rank needs
// before it means anything.
//
// Usage:
//   npm run db:migrate              apply schema + backfill
//   npm run db:migrate -- --schema  apply schema only
//   npm run db:migrate -- --verify  report row counts and exit

import '../src/env.js';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, dbEnabled, query, tx } from '../src/db/pool.js';
import type { MomentumHistoryRecord } from '../src/momentum/types.js';
import type { SignalRecord } from '../src/pullback/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache', 'momentum');
const SCHEMA = path.join(here, '..', 'src', 'db', 'schema.sql');

const has = (flag: string) => process.argv.includes(`--${flag}`);

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null; // absent is the normal case on a fresh clone
  }
};

async function applySchema(): Promise<void> {
  const sql = await readFile(SCHEMA, 'utf8');
  // One statement stream inside the file's own BEGIN/COMMIT. `pg` sends it as a simple query,
  // which allows multiple statements — this is why the schema is a file and not a template
  // literal split on semicolons, an approach that breaks the moment a comment contains one.
  await query(sql);
  console.log('schema applied');
}

async function backfillConfig(): Promise<void> {
  for (const [key, file] of [
    ['config', 'config.json'],
    ['pullback_config', 'pullback_config.json'],
  ] as const) {
    const doc = await readJson<{ version?: number; updatedBy?: string }>(path.join(CACHE, file));
    if (!doc) { console.log(`config ${key}: nothing on disk, skipped`); continue; }
    await query(
      `INSERT INTO app_config (key, version, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key, version) DO NOTHING`,
      [key, Number(doc.version) || 1, JSON.stringify(doc), doc.updatedBy ?? 'backfill'],
    );
    console.log(`config ${key}: version ${doc.version ?? 1} lifted`);
  }
}

async function backfillHistory(): Promise<void> {
  const file = await readJson<{ bySymbol: Record<string, Record<string, MomentumHistoryRecord>> }>(
    path.join(CACHE, 'history.json'),
  );
  if (!file?.bySymbol) { console.log('momentum history: nothing on disk, skipped'); return; }

  const rows: MomentumHistoryRecord[] = [];
  for (const days of Object.values(file.bySymbol)) for (const r of Object.values(days)) rows.push(r);
  if (!rows.length) { console.log('momentum history: file is empty, skipped'); return; }

  // Chunked because Postgres caps a statement at 65,535 parameters and this is 9 per row —
  // two years of a full universe would be ~108k rows and would blow straight through it.
  const CHUNK = 500;
  await tx(async (c) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((r, j) => {
        values.push(r.symbol, r.day, r.close, r.score, r.direction, r.rvol, r.atmIv, r.hv20, r.futuresOi);
        const b = j * 9;
        return `($${b + 1},$${b + 2}::date,$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
      });
      await c.query(
        `INSERT INTO momentum_history
           (symbol, day, close, score, direction, rvol, atm_iv, hv20, futures_oi)
         VALUES ${tuples.join(',')}
         ON CONFLICT (symbol, day) DO NOTHING`,
        values,
      );
    }
  });
  console.log(`momentum history: ${rows.length} rows lifted`);
}

async function backfillSignals(): Promise<void> {
  const file = await readJson<{ byDay: Record<string, Record<string, SignalRecord>> }>(
    path.join(CACHE, 'pullback_signals.json'),
  );
  if (!file?.byDay) { console.log('pullback signals: nothing on disk, skipped'); return; }

  const rows: SignalRecord[] = [];
  for (const bucket of Object.values(file.byDay)) rows.push(...Object.values(bucket));
  if (!rows.length) { console.log('pullback signals: file is empty, skipped'); return; }

  await tx(async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO pullback_signal
           (id, day, symbol, timeframe, direction, fired_at, entry, stop, target, score, band,
            entry_kind, option, outcome_state, max_favourable, max_adverse, realised_r, closed_at, note)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id, r.day, r.symbol, r.timeframe, r.direction, r.firedAt, r.entry, r.stop, r.target,
          r.score, r.band, r.entryKind, r.option ? JSON.stringify(r.option) : null,
          r.outcome.state, r.outcome.maxFavourable, r.outcome.maxAdverse,
          r.outcome.r, r.outcome.closedAt, r.outcome.note ?? null,
        ],
      );
    }
  });
  console.log(`pullback signals: ${rows.length} rows lifted`);
}

async function verify(): Promise<void> {
  for (const table of ['app_config', 'momentum_history', 'pullback_signal']) {
    const [row] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    console.log(`${table.padEnd(18)} ${row?.n ?? '?'} rows`);
  }
}

async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.error('DATABASE_URL is not set. Put your connection string in api/.env — see api/.env.example.');
    process.exitCode = 1;
    return;
  }

  if (has('verify')) { await verify(); return; }

  await applySchema();
  if (!has('schema')) {
    await backfillConfig();
    await backfillHistory();
    await backfillSignals();
  }
  await verify();
  console.log('\ndone — set DATABASE_URL in the API process and restart it.');
}

main()
  .catch((e: Error) => { console.error(`migration failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => void closeDb());
