// The Postgres half of the journal store, against a fake transport.
//
// WHAT THIS CAN AND CANNOT PROVE. There is no database in this test run, so nothing here says the
// SQL is valid Postgres — `npm run check-neon` is what answers that, against the real connection,
// by running every statement this file sends. What IS worth pinning down without a server is the
// part that breaks silently: whether the parameter arrays line up with their placeholders.
//
// `save` sends ten parallel arrays into one `unnest`. If any of them is a different length from the
// others, Postgres does not error — `unnest` pads the short ones with NULLs, so a mismatch shows up
// as trades with a null day or a null symbol appearing in the record days later. A test that counts
// them is cheap and that failure is not.
//
// The retry rule is the other thing checked here: exactly one retry, and only for the error codes
// that mean the socket went away. Retrying a syntax error is how a scanner spends an afternoon
// failing at fifteen-second intervals.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { PostgresJournalRepository, SCHEMA, type Queryable } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

/* ------------------------------------------------------------------------ fixtures --- */

interface Call { sql: string; params: unknown[] }

class FakeDb implements Queryable {
  readonly calls: Call[] = [];
  /** Queued outcomes, oldest first. A string is thrown as an error code. */
  private script: Array<'ok' | string> = [];
  rowsFor: Record<string, unknown[]> = {};

  fail(...codes: string[]): this { this.script.push(...codes); return this; }

  async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[]; rowCount: number | null }> {
    this.calls.push({ sql, params });
    const next = this.script.shift();
    if (next && next !== 'ok') throw Object.assign(new Error(next), { code: next });
    const key = Object.keys(this.rowsFor).find((k) => sql.includes(k));
    const rows = (key ? this.rowsFor[key] : []) as R[];
    return { rows, rowCount: rows.length };
  }
}

const trade = (over: Partial<JournalTrade> = {}): JournalTrade => ({
  id: '2026-08-21:displacement:TESTCO',
  day: '2026-08-21',
  channel: 'displacement',
  symbol: 'TESTCO',
  direction: 1,
  contract: { label: '300 CE', strike: 300, type: 'CE', instrumentKey: 'NSE_FO|1', expiry: '2026-08-25', lotSize: 500 },
  lots: 1,
  entry: { at: 1_800_000_000_000, minute: 14, premium: 10, spot: 300, source: 'auto' },
  exit: null, mark: null, mfePct: null, maePct: null, spreadPctAtEntry: 1.2,
  amountUsed: 5000, grossPnl: null, charges: null, netPnl: null, netPct: null,
  shadow: [], readings: {}, note: '', status: 'open',
  settled: false, edited: false, updatedAt: 1_800_000_000_000,
  ...over,
});

/* ---------------------------------------------------------------------------- tests --- */

describe('journal postgres · the upsert', () => {
  it('sends ten parameter arrays of equal length, whatever the batch size', async () => {
    for (const n of [1, 2, 7]) {
      const db = new FakeDb();
      const repo = new PostgresJournalRepository(db);
      await repo.save(Array.from({ length: n }, (_, i) => trade({ id: `t${i}` })));
      const insert = db.calls.find((c) => c.sql.includes('INSERT INTO momentum_journal'))!;
      assert.ok(insert, 'an insert must be sent');
      assert.equal(insert.params.length, 10, 'ten arrays, one per column');
      for (const [i, p] of insert.params.entries()) {
        assert.ok(Array.isArray(p), `parameter ${i + 1} must be an array for unnest`);
        assert.equal((p as unknown[]).length, n, `parameter ${i + 1} is the wrong length`);
      }
    }
  });

  it('uses every placeholder it declares', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).save([trade()]);
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO momentum_journal'))!;
    for (let i = 1; i <= 10; i++) assert.ok(insert.sql.includes(`$${i}::`), `$${i} is not in the statement`);
    assert.ok(!insert.sql.includes('$11'), 'more placeholders than parameters');
  });

  it('is one statement per batch, not one per trade', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).save([trade({ id: 'a' }), trade({ id: 'b' }), trade({ id: 'c' })]);
    assert.equal(db.calls.filter((c) => c.sql.includes('INSERT INTO momentum_journal')).length, 1);
  });

  it('replaces rather than duplicating, on the trade id', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).save([trade()]);
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO momentum_journal'))!;
    assert.ok(insert.sql.includes('ON CONFLICT (id) DO UPDATE'), 'a re-save must overwrite the row');
    assert.ok(insert.sql.includes('trade = EXCLUDED.trade'));
    assert.ok(insert.sql.includes('settled = EXCLUDED.settled'));
  });

  it('sends the record as JSON text, and the promoted columns beside it', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).save([trade({ netPnl: -900, amountUsed: 5000 })]);
    const p = db.calls.find((c) => c.sql.includes('INSERT INTO momentum_journal'))!.params;
    assert.deepEqual(p[0], ['2026-08-21:displacement:TESTCO']);
    assert.deepEqual(p[1], ['2026-08-21']);
    assert.deepEqual(p[6], [5000]);
    assert.deepEqual(p[7], [-900]);
    const json = (p[8] as string[])[0];
    assert.equal(typeof json, 'string', 'jsonb takes text, not an object');
    assert.equal((JSON.parse(json) as JournalTrade).symbol, 'TESTCO');
  });

  it('stamps updatedAt when a trade arrives without one', async () => {
    const db = new FakeDb();
    const t = trade();
    (t as { updatedAt?: number }).updatedAt = 0;
    await new PostgresJournalRepository(db).save([t]);
    assert.ok(t.updatedAt > 0, 'reconcile compares on this field; it cannot be left unset');
  });

  it('does nothing at all for an empty batch', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).save([]);
    assert.equal(db.calls.length, 0, 'not even the schema statement');
  });
});

describe('journal postgres · the schema', () => {
  it('is created on first use and only once', async () => {
    const db = new FakeDb();
    const repo = new PostgresJournalRepository(db);
    await repo.range('2026-08-01', '2026-08-31');
    await repo.range('2026-08-01', '2026-08-31');
    await repo.one('x');
    assert.equal(db.calls.filter((c) => c.sql === SCHEMA).length, 1);
  });

  it('creates every table and index without dropping anything', () => {
    assert.ok(SCHEMA.includes('CREATE TABLE IF NOT EXISTS momentum_journal'));
    // The two archives. Neither absence is a cosmetic gap: an expired option series cannot be
    // re-fetched, and a candidate the rule refused is never written down anywhere else — so a day
    // missed by either table is a day no future study can ask a new question of.
    assert.ok(SCHEMA.includes('CREATE TABLE IF NOT EXISTS momentum_option_path'));
    assert.ok(SCHEMA.includes('CREATE TABLE IF NOT EXISTS momentum_candidate'));
    assert.equal((SCHEMA.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 7);
    // Two machines run this on boot against the same database, and it must be safe every time.
    assert.ok(!/DROP|TRUNCATE|DELETE/i.test(SCHEMA), 'the schema must never destroy data');
  });

  it('is retried if the first attempt failed, rather than cached as broken', async () => {
    const db = new FakeDb().fail('ECONNRESET', 'ECONNRESET');
    const repo = new PostgresJournalRepository(db);
    await assert.rejects(() => repo.range('2026-08-01', '2026-08-31'));
    // A sleeping branch must not leave the process convinced there is no table.
    await repo.range('2026-08-01', '2026-08-31');
    assert.ok(db.calls.filter((c) => c.sql === SCHEMA).length >= 2);
  });
});

describe('journal postgres · reads', () => {
  it('adds the channel filter only when one is asked for', async () => {
    const db = new FakeDb();
    const repo = new PostgresJournalRepository(db);
    await repo.range('2026-08-01', '2026-08-31');
    let q = db.calls.at(-1)!;
    assert.equal(q.params.length, 2);
    assert.ok(!q.sql.includes('channel ='));

    await repo.range('2026-08-01', '2026-08-31', 'ignition');
    q = db.calls.at(-1)!;
    assert.deepEqual(q.params, ['2026-08-01', '2026-08-31', 'ignition']);
    assert.ok(q.sql.includes('channel = $3'));
  });

  it('returns the stored record, not the row wrapper', async () => {
    const db = new FakeDb();
    db.rowsFor['SELECT trade FROM momentum_journal WHERE id'] = [{ trade: trade({ note: 'from the db' }) }];
    const got = await new PostgresJournalRepository(db).one('2026-08-21:displacement:TESTCO');
    assert.equal(got?.note, 'from the db');
  });

  it('asks only for unsettled rows when settling', async () => {
    const db = new FakeDb();
    await new PostgresJournalRepository(db).unsettled();
    assert.ok(db.calls.at(-1)!.sql.includes('settled = false'));
  });
});

describe('journal postgres · retries', () => {
  it('retries once when the socket went away', async () => {
    const db = new FakeDb().fail('ok', '57P01');   // schema ok, then the read fails once
    const repo = new PostgresJournalRepository(db);
    const rows = await repo.range('2026-08-01', '2026-08-31');
    assert.deepEqual(rows, []);
    const reads = db.calls.filter((c) => c.sql.includes('SELECT trade')).length;
    assert.equal(reads, 2, 'the failed read must be attempted once more');
  });

  it('does NOT retry a statement the database rejected', async () => {
    // 42601 is a syntax error. Retrying it forever is how a scanner burns an afternoon.
    const db = new FakeDb().fail('ok', '42601');
    const repo = new PostgresJournalRepository(db);
    await assert.rejects(() => repo.range('2026-08-01', '2026-08-31'), /42601/);
    assert.equal(db.calls.filter((c) => c.sql.includes('SELECT trade')).length, 1);
  });

  it('gives up after the one retry rather than looping', async () => {
    const db = new FakeDb().fail('ok', 'ECONNRESET', 'ECONNRESET');
    const repo = new PostgresJournalRepository(db);
    await assert.rejects(() => repo.range('2026-08-01', '2026-08-31'));
    assert.equal(db.calls.filter((c) => c.sql.includes('SELECT trade')).length, 2);
  });
});
