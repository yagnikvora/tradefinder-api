// Where the journal is stored, and what happens when half of it is unreachable.
//
// The behaviour worth pinning down is not "does it save" — it is what the mirror does on a bad
// day. A serverless database sleeps, an office network drops, and an alert fires at 09:30 whether
// or not either is true at that moment. So:
//
//   a failed push must not lose the trade          it is on local disk before the wire is touched
//   a failed push must be retried                  and the queue must survive a restart
//   a failed READ must not look like no trades     it falls back to local and says servedFromLocal
//   a pending trade must not be journalled twice   `existing` is the union of both sides
//   a reconcile must not overwrite a newer row     `updatedAt` decides, not "mine wins"
//
// Nothing here touches a network or a disk. The local half is the real FileJournalRepository
// running against an in-memory KeyValueStore, so the month-document layout is exercised for real;
// the remote half is a fake that can be told to fail.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  FileJournalRepository, MirrorJournalRepository,
  type JournalRepository, type JournalSyncStatus,
} from '../src/momentum/journal/repository.js';
import type { KeyValueStore } from '../src/momentum/store.js';
import type { JournalChannel, JournalTrade } from '../src/momentum/journal/types.js';

/* ------------------------------------------------------------------------ fixtures --- */

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async read<T>(key: string): Promise<T | null> {
    const raw = this.data.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async write<T>(key: string, value: T): Promise<void> { this.data.set(key, JSON.stringify(value)); }
  async remove(key: string): Promise<void> { this.data.delete(key); }
}

/** A remote that can be switched off, and that counts what it was asked to do. */
class FakeRemote implements JournalRepository {
  up = true;
  saves = 0;
  readonly rows = new Map<string, JournalTrade>();

  private guard(): void { if (!this.up) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); }

  async range(from: string, to: string, channel?: JournalChannel | null): Promise<JournalTrade[]> {
    this.guard();
    return [...this.rows.values()].filter((t) => t.day >= from && t.day <= to && (!channel || t.channel === channel));
  }
  async mine(day: string): Promise<JournalTrade[]> { return this.range(day, day); }
  async existing(day: string): Promise<Set<string>> {
    this.guard();
    return new Set([...this.rows.values()].filter((t) => t.day === day).map((t) => t.id));
  }
  async unsettled(): Promise<JournalTrade[]> { this.guard(); return [...this.rows.values()].filter((t) => !t.settled); }
  async one(id: string): Promise<JournalTrade | null> { this.guard(); return this.rows.get(id) ?? null; }
  async save(trades: JournalTrade[]): Promise<void> {
    this.guard();
    this.saves++;
    for (const t of trades) this.rows.set(t.id, JSON.parse(JSON.stringify(t)) as JournalTrade);
  }
  async status(): Promise<JournalSyncStatus> {
    return { mode: 'neon', remote: 'ok', pending: 0, lastPushAt: null, lastPullAt: null, lastError: null, servedFromLocal: false };
  }
  async flush(): Promise<void> {}
  async reconcile(): Promise<number> { return 0; }
}

/** Ids are always `<session day>:<channel>:<SYMBOL>` — several lookups derive the month from it. */
const DAY = '2026-08-21';
const ID = `${DAY}:displacement:TESTCO`;

const trade = (over: Partial<JournalTrade> = {}): JournalTrade => ({
  id: ID,
  day: DAY,
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

const build = () => {
  const disk = new MemoryStore();
  const queue = new MemoryStore();
  const local = new FileJournalRepository(disk);
  const remote = new FakeRemote();
  return { disk, queue, local, remote, mirror: new MirrorJournalRepository(local, remote, queue) };
};

/* ------------------------------------------------------------------------- the disk --- */

describe('journal store · the local half', () => {
  it('round-trips a trade through the month document', async () => {
    const { local } = build();
    await local.save([trade()]);
    const got = await local.one('2026-08-21:displacement:TESTCO');
    assert.equal(got?.symbol, 'TESTCO');
    assert.equal((await local.range('2026-08-01', '2026-08-31')).length, 1);
  });

  it('replaces a trade rather than appending a second copy', async () => {
    const { local } = build();
    await local.save([trade()]);
    await local.save([trade({ status: 'closed', settled: true, netPnl: 900 })]);
    const rows = await local.range('2026-08-01', '2026-08-31');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].netPnl, 900);
  });

  it('keeps months apart and spans a range across them', async () => {
    const { local } = build();
    await local.save([
      trade({ id: '2026-07-31:displacement:A', day: '2026-07-31' }),
      trade({ id: '2026-08-01:displacement:B', day: '2026-08-01' }),
      trade({ id: '2026-09-02:displacement:C', day: '2026-09-02' }),
    ]);
    assert.equal((await local.range('2026-07-01', '2026-09-30')).length, 3);
    assert.equal((await local.range('2026-08-01', '2026-08-31')).length, 1);
    assert.deepEqual([...await local.existing('2026-07-31')], ['2026-07-31:displacement:A']);
  });

  it('filters by channel', async () => {
    const { local } = build();
    await local.save([trade({ id: `${DAY}:displacement:A` }), trade({ id: `${DAY}:ignition:B`, channel: 'ignition' })]);
    assert.equal((await local.range('2026-08-01', '2026-08-31', 'ignition')).length, 1);
  });
});

/* ----------------------------------------------------------------------- the mirror --- */

describe('journal store · the mirror when the database is up', () => {
  it('writes to both halves', async () => {
    const { mirror, local, remote } = build();
    await mirror.save([trade()]);
    assert.ok(await local.one('2026-08-21:displacement:TESTCO'), 'local');
    assert.ok(await remote.one('2026-08-21:displacement:TESTCO'), 'remote');
    assert.equal((await mirror.status()).pending, 0);
  });

  it('reads the database, because that is the shared truth', async () => {
    const { mirror, local, remote } = build();
    await local.save([trade({ note: 'stale local copy' })]);
    await remote.save([trade({ note: 'what the other machine wrote' })]);
    const rows = await mirror.range('2026-08-01', '2026-08-31');
    assert.equal(rows[0].note, 'what the other machine wrote');
    assert.equal((await mirror.status()).servedFromLocal, false);
  });

  it('reads the LOCAL copy for the mark tick', async () => {
    // `mine` must never reach the database: it runs every 15 seconds all session, and routing it
    // over the wire would hold a serverless branch awake for readings already on disk.
    const { mirror, local, remote } = build();
    await local.save([trade({ note: 'mine' })]);
    remote.up = false;
    const rows = await mirror.mine('2026-08-21');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'mine');
  });
});

describe('journal store · the mirror when the database is down', () => {
  it('still records the trade, and queues the push', async () => {
    const { mirror, local, remote } = build();
    remote.up = false;
    await mirror.save([trade()]);
    assert.ok(await local.one('2026-08-21:displacement:TESTCO'), 'the trade must survive locally');
    const st = await mirror.status();
    assert.equal(st.pending, 1);
    assert.equal(st.remote, 'degraded');
  });

  it('pushes the queue once the database is back', async () => {
    const { mirror, remote } = build();
    remote.up = false;
    await mirror.save([trade()]);
    await mirror.flush();
    assert.equal((await mirror.status()).pending, 1, 'still queued while down');

    remote.up = true;
    await mirror.flush();
    assert.equal((await mirror.status()).pending, 0);
    assert.ok(await remote.one('2026-08-21:displacement:TESTCO'));
  });

  it('keeps the queue across a restart', async () => {
    const { disk, queue, local, remote } = build();
    const first = new MirrorJournalRepository(local, remote, queue);
    remote.up = false;
    await first.save([trade()]);

    // A new process, same disk and same queue file.
    const second = new MirrorJournalRepository(new FileJournalRepository(disk), remote, queue);
    assert.equal((await second.status()).pending, 1, 'the queue must be on disk, not in memory');
    remote.up = true;
    await second.flush();
    assert.equal((await second.status()).pending, 0);
  });

  it('falls back to local on a read AND says so', async () => {
    const { mirror, local, remote } = build();
    await local.save([trade()]);
    remote.up = false;
    const rows = await mirror.range('2026-08-01', '2026-08-31');
    assert.equal(rows.length, 1, 'an unreachable database must not read as an empty journal');
    assert.equal((await mirror.status()).servedFromLocal, true);
  });

  it('never journals the same alert twice while a push is queued', async () => {
    // The failure this prevents: the trade is on disk and not in the database, so asking only the
    // database would report it as new and the next scan tick would record a duplicate.
    const { mirror, remote } = build();
    remote.up = false;
    await mirror.save([trade()]);
    remote.up = true;
    const ids = await mirror.existing('2026-08-21');
    assert.ok(ids.has('2026-08-21:displacement:TESTCO'));
  });
});

describe('journal store · the union on read', () => {
  // The bug this covers showed up on screen rather than in a test: reading only the database meant
  // a trade recorded at 09:30 whose push had not landed was safe on disk and ABSENT from the page,
  // which reads as "no alert fired". That is the most misleading thing this module could say.
  it('shows a local trade the database has not got yet, with the store up', async () => {
    const { mirror, local, remote } = build();
    await remote.save([trade({ id: `${DAY}:displacement:PUSHED` })]);
    await local.save([trade({ id: `${DAY}:displacement:PUSHED` }), trade({ id: `${DAY}:displacement:QUEUED` })]);
    const ids = (await mirror.range('2026-08-01', '2026-08-31')).map((t) => t.id).sort();
    assert.deepEqual(ids, [`${DAY}:displacement:PUSHED`, `${DAY}:displacement:QUEUED`]);
    assert.equal((await mirror.status()).servedFromLocal, false, 'the store was reachable');
  });

  it('does not show the same trade twice', async () => {
    const { mirror, local, remote } = build();
    await remote.save([trade()]);
    await local.save([trade()]);
    assert.equal((await mirror.range('2026-08-01', '2026-08-31')).length, 1);
  });

  it('keeps the copy that changed last, whichever side it is on', async () => {
    const { mirror, local, remote } = build();
    await remote.save([trade({ id: ID, note: 'db is older', updatedAt: 1000 })]);
    await local.save([trade({ id: ID, note: 'local is newer', updatedAt: 2000 })]);
    assert.equal((await mirror.range('2026-08-01', '2026-08-31'))[0].note, 'local is newer');
    assert.equal((await mirror.one(ID))?.note, 'local is newer');

    await remote.save([trade({ id: ID, note: 'db is newer now', updatedAt: 3000 })]);
    assert.equal((await mirror.range('2026-08-01', '2026-08-31'))[0].note, 'db is newer now');
    assert.equal((await mirror.one(ID))?.note, 'db is newer now');
  });

  it('respects the channel filter on both sides', async () => {
    const { mirror, local, remote } = build();
    await remote.save([trade({ id: `${DAY}:displacement:A`, channel: 'displacement' })]);
    await local.save([trade({ id: `${DAY}:ignition:B`, channel: 'ignition' })]);
    assert.deepEqual((await mirror.range('2026-08-01', '2026-08-31', 'ignition')).map((t) => t.id), [`${DAY}:ignition:B`]);
  });
});

describe('journal store · reconcile', () => {
  it('pushes local history the database has never seen', async () => {
    const { mirror, local, remote } = build();
    const day = new Date().toISOString().slice(0, 10);
    await local.save([trade({ id: `${day}:displacement:X`, day }), trade({ id: `${day}:displacement:Y`, day })]);
    assert.equal(await mirror.reconcile(30), 2);
    assert.equal(remote.rows.size, 2);
  });

  it('does not overwrite a database row that is newer', async () => {
    // The case that matters: a fill corrected at home last night must survive the office booting
    // up this morning with an older copy on its disk.
    const { mirror, local, remote } = build();
    const day = new Date().toISOString().slice(0, 10);
    await local.save([trade({ id: `${day}:displacement:X`, day, note: 'office copy', updatedAt: 1000 })]);
    await remote.save([trade({ id: `${day}:displacement:X`, day, note: 'corrected at home', updatedAt: 2000 })]);
    const pushed = await mirror.reconcile(30);
    assert.equal(pushed, 0);
    assert.equal((await remote.one(`${day}:displacement:X`))?.note, 'corrected at home');
  });

  it('does push when the local copy is the newer one', async () => {
    const { mirror, local, remote } = build();
    const day = new Date().toISOString().slice(0, 10);
    await remote.save([trade({ id: `${day}:displacement:X`, day, note: 'old', updatedAt: 1000 })]);
    await local.save([trade({ id: `${day}:displacement:X`, day, note: 'new', updatedAt: 5000 })]);
    assert.equal(await mirror.reconcile(30), 1);
    assert.equal((await remote.one(`${day}:displacement:X`))?.note, 'new');
  });

  it('reports nothing rather than throwing when the database is unreachable', async () => {
    const { mirror, remote } = build();
    remote.up = false;
    assert.equal(await mirror.reconcile(30), 0);
    assert.equal((await mirror.status()).remote, 'degraded');
  });
});
