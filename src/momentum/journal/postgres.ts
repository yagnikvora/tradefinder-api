// The journal in Postgres — one row per trade, which is what makes two machines share a record.
//
// WHY A ROW PER TRADE rather than the month document the file store keeps. A document has to be
// read, modified and written back, which raises the question of whose copy is newer every time two
// machines touch it — and answering that question needs a revision counter and the code to
// arbitrate it. A row keyed on the trade's own id needs none of that: `INSERT … ON CONFLICT (id)
// DO UPDATE` is the whole of it, and a bad write can damage one trade instead of a month.
//
// WHY JSONB AND NOT COLUMNS. The trade carries about thirty fields and will carry more. Promoting
// every one of them into a column means a migration each time the record learns something, and
// this is a personal trade log rather than a warehouse. So the whole record is JSONB and only the
// handful worth querying or summing — day, channel, symbol, the two money figures, the two flags —
// are promoted out and indexed. `schema.sql` in this module already anticipated the trade-off; it
// said `momentum_history` is "the one table that genuinely wants a database", and this is the same
// argument for the same reason.
//
// SERVERLESS COMPUTE SLEEPS. Neon suspends an idle branch and wakes it on the next connection,
// which shows up as a cold first query and, less obviously, as a pooled connection that was killed
// while nothing was using it. So the pool is small, its idle timeout is short, and every statement
// gets exactly one retry on the error classes that mean "the socket went away" rather than "your
// SQL is wrong". Retrying a syntax error forever is how a scanner spends an afternoon failing.

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { JournalChannel, JournalTrade } from './types.js';
import type { JournalRepository, JournalSyncStatus } from './repository.js';

export const databaseUrl = (): string | null => {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
};

/* ----------------------------------------------------------------------------- schema --- */

/**
 * Created on demand rather than by a migration step.
 *
 * There is no migration runner in this app and adding one for a single table would be more
 * machinery than it saves. `IF NOT EXISTS` throughout means this is safe to run on every boot and
 * safe to run from two machines at once.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS momentum_journal (
    id           TEXT         PRIMARY KEY,
    day          DATE         NOT NULL,
    channel      TEXT         NOT NULL,
    symbol       TEXT         NOT NULL,
    settled      BOOLEAN      NOT NULL DEFAULT false,
    edited       BOOLEAN      NOT NULL DEFAULT false,
    amount_used  NUMERIC,
    net_pnl      NUMERIC,
    trade        JSONB        NOT NULL,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS momentum_journal_day_idx ON momentum_journal (day DESC);
CREATE INDEX IF NOT EXISTS momentum_journal_day_channel_idx ON momentum_journal (day, channel);
CREATE INDEX IF NOT EXISTS momentum_journal_unsettled_idx ON momentum_journal (settled, day)
    WHERE settled = false;
`;

/* ------------------------------------------------------------------------- the driver --- */

/** The transport, narrowed to what this file uses, so a test can supply its own. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string, params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** "The socket went away", as opposed to "your SQL is wrong". Only these are worth retrying. */
const TRANSIENT = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01',    // admin_shutdown — what a suspended branch looks like from the client
  '57P03',    // cannot_connect_now — waking up
  '08006', '08003', '08000',
]);

const transient = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code !== undefined && TRANSIENT.has(code);
};

let pool: Pool | null = null;

/**
 * Strip `sslmode` from the connection string, because this file sets TLS explicitly below.
 *
 * Neon hands out URLs ending `?sslmode=require`, and `pg-connection-string` prints a paragraph of
 * deprecation warning about it on every boot — `require` is currently an alias for `verify-full`
 * and will stop being one. Rather than let a warning appear in the log every morning, or pin a
 * spelling that changes meaning in the next major version, the mode is removed here and the `ssl`
 * option is stated outright. Same behaviour, no ambiguity, no warning.
 *
 * `sslmode=disable` is honoured rather than stripped: someone who asked for no TLS meant it.
 */
function withoutSslMode(url: string): { url: string; disable: boolean } {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    if (mode === 'disable') return { url, disable: true };
    u.searchParams.delete('sslmode');
    return { url: u.toString(), disable: false };
  } catch {
    return { url, disable: /sslmode=disable/.test(url) };
  }
}

export function getPool(url = databaseUrl()): Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (pool) return pool;
  const conn = withoutSslMode(url);
  pool = new Pool({
    connectionString: conn.url,
    // Two is plenty: one long-running process making a handful of small statements a minute. A
    // large pool against a branch that suspends just means more dead sockets to discover.
    max: 2,
    idleTimeoutMillis: 10_000,
    // A cold start on a suspended branch is seconds, not milliseconds.
    connectionTimeoutMillis: 20_000,
    // Neon terminates unencrypted connections. Its certificates are publicly trusted, so this
    // verifies the chain properly rather than turning verification off.
    ssl: conn.disable ? undefined : { rejectUnauthorized: true },
  });
  // Without this an idle client killed by the far end raises an unhandled 'error' event and takes
  // the process with it — the scanner would die overnight for a reason nothing logged.
  pool.on('error', () => {});
  return pool;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end().catch(() => {});
}

/** One retry, and only for the errors that mean the connection rather than the statement. */
async function run<R extends QueryResultRow>(
  db: Queryable, sql: string, params?: unknown[],
): Promise<{ rows: R[]; rowCount: number | null }> {
  try {
    return await db.query<R>(sql, params);
  } catch (e) {
    if (!transient(e)) throw e;
    return db.query<R>(sql, params);
  }
}

/* --------------------------------------------------------------------- the repository --- */

interface Row extends QueryResultRow { trade: JournalTrade }

const toTrade = (r: Row): JournalTrade => r.trade;

export class PostgresJournalRepository implements JournalRepository {
  private ready: Promise<void> | null = null;
  private lastPushAt: number | null = null;
  private lastPullAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly db: Queryable = getPool()) {}

  /** Creates the table on first use. Memoised, so it is one statement per process. */
  private ensure(): Promise<void> {
    this.ready ??= run(this.db, SCHEMA).then(() => undefined);
    return this.ready.catch((e) => {
      // Cleared so a failure caused by a sleeping branch is retried rather than cached forever.
      this.ready = null;
      throw e;
    });
  }

  async range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]> {
    await this.ensure();
    const sql = channel
      ? 'SELECT trade FROM momentum_journal WHERE day BETWEEN $1 AND $2 AND channel = $3 ORDER BY day DESC, (trade->\'entry\'->>\'at\')::bigint ASC'
      : 'SELECT trade FROM momentum_journal WHERE day BETWEEN $1 AND $2 ORDER BY day DESC, (trade->\'entry\'->>\'at\')::bigint ASC';
    const params = channel ? [from, to, channel] : [from, to];
    const { rows } = await run<Row>(this.db, sql, params);
    this.lastPullAt = Date.now();
    this.lastError = null;
    return rows.map(toTrade);
  }

  /** No local half, so this is the same query. */
  mine(day: string): Promise<JournalTrade[]> {
    return this.range(day, day);
  }

  async existing(day: string): Promise<Set<string>> {
    await this.ensure();
    const { rows } = await run<{ id: string } & QueryResultRow>(
      this.db, 'SELECT id FROM momentum_journal WHERE day = $1', [day],
    );
    return new Set(rows.map((r) => r.id));
  }

  async unsettled(): Promise<JournalTrade[]> {
    await this.ensure();
    const { rows } = await run<Row>(
      this.db,
      'SELECT trade FROM momentum_journal WHERE settled = false ORDER BY day ASC',
    );
    return rows.map(toTrade);
  }

  async one(id: string): Promise<JournalTrade | null> {
    await this.ensure();
    const { rows } = await run<Row>(
      this.db, 'SELECT trade FROM momentum_journal WHERE id = $1', [id],
    );
    return rows.length ? toTrade(rows[0]) : null;
  }

  /**
   * Insert or replace, in one statement per batch.
   *
   * `unnest` rather than a row of placeholders per trade: a settlement pass can rewrite a whole
   * day at once, and a statement whose length grows with the batch is the kind of thing that works
   * until the morning it does not.
   */
  async save(trades: JournalTrade[]): Promise<void> {
    if (!trades.length) return;
    await this.ensure();
    const now = Date.now();
    for (const t of trades) t.updatedAt ||= now;
    await run(this.db, `
      INSERT INTO momentum_journal (id, day, channel, symbol, settled, edited, amount_used, net_pnl, trade, updated_at)
      SELECT * FROM unnest(
        $1::text[], $2::date[], $3::text[], $4::text[], $5::boolean[], $6::boolean[],
        $7::numeric[], $8::numeric[], $9::jsonb[], $10::timestamptz[]
      )
      ON CONFLICT (id) DO UPDATE SET
        day = EXCLUDED.day, channel = EXCLUDED.channel, symbol = EXCLUDED.symbol,
        settled = EXCLUDED.settled, edited = EXCLUDED.edited,
        amount_used = EXCLUDED.amount_used, net_pnl = EXCLUDED.net_pnl,
        trade = EXCLUDED.trade, updated_at = EXCLUDED.updated_at
    `, [
      trades.map((t) => t.id),
      trades.map((t) => t.day),
      trades.map((t) => t.channel),
      trades.map((t) => t.symbol),
      trades.map((t) => t.settled),
      trades.map((t) => t.edited),
      trades.map((t) => t.amountUsed),
      trades.map((t) => t.netPnl),
      trades.map((t) => JSON.stringify(t)),
      trades.map((t) => new Date(t.updatedAt ?? now).toISOString()),
    ]);
    this.lastPushAt = Date.now();
    this.lastError = null;
  }

  async status(): Promise<JournalSyncStatus> {
    return {
      mode: 'neon', remote: this.lastError ? 'degraded' : 'ok', pending: 0,
      lastPushAt: this.lastPushAt, lastPullAt: this.lastPullAt,
      lastError: this.lastError, servedFromLocal: false,
    };
  }

  async flush(): Promise<void> { /* writes are synchronous against the database */ }
  async reconcile(): Promise<number> { return 0; }
}

/**
 * Prove the whole path: connect, create the table, write a row, read it back, delete it.
 *
 * Exists because `npm run check-neon` has to answer "are my credentials right" without either the
 * operator or a log line ever handling the connection string. Returns the steps it got through so
 * a failure names the one that broke rather than reporting "database error".
 */
export async function probe(db: Queryable): Promise<{ step: string; ok: boolean; detail?: string }[]> {
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const mark = async (step: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      steps.push({ step, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      steps.push({ step, ok: false, detail: String((e as Error).message) });
      return false;
    }
  };

  if (!await mark('connect', async () => {
    const { rows } = await run<{ v: string } & QueryResultRow>(db, 'SELECT version() AS v');
    return rows[0]?.v?.split(',')[0] ?? '';
  })) return steps;

  if (!await mark('create table', async () => { await run(db, SCHEMA); })) return steps;

  const id = `__probe:${Date.now()}`;
  const repo = new PostgresJournalRepository(db);
  const fake: JournalTrade = {
    id, day: new Date().toISOString().slice(0, 10), channel: 'displacement',
    symbol: '__PROBE', direction: 1, contract: null, lots: 1,
    entry: { at: Date.now(), minute: 0, premium: 1, spot: 1, source: 'auto' },
    exit: null, mark: null, mfePct: null, maePct: null, spreadPctAtEntry: null,
    amountUsed: null, grossPnl: null, charges: null, netPnl: null, netPct: null,
    shadow: [], readings: {}, note: 'connectivity probe', status: 'open',
    settled: false, edited: false, updatedAt: Date.now(),
  };

  await mark('write a row', async () => { await repo.save([fake]); });
  await mark('read it back', async () => {
    const got = await repo.one(id);
    if (!got) throw new Error('the row was written but could not be read back');
    if (got.symbol !== '__PROBE') throw new Error('the row came back with the wrong contents');
    return 'round trip matched';
  });
  await mark('clean up', async () => {
    const { rowCount } = await run(db, 'DELETE FROM momentum_journal WHERE id = $1', [id]);
    return `${rowCount ?? 0} probe row removed`;
  });
  await mark('count what is stored', async () => {
    const { rows } = await run<{ n: string; lo: string | null; hi: string | null } & QueryResultRow>(
      db,
      'SELECT count(*)::text AS n, min(day)::text AS lo, max(day)::text AS hi FROM momentum_journal',
    );
    const r = rows[0];
    return Number(r?.n ?? 0) > 0 ? `${r.n} trades, ${r.lo} to ${r.hi}` : 'no trades yet';
  });
  return steps;
}

export type { PoolClient };
