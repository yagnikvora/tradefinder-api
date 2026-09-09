// Selling one position by hand, while the market is open.
//
// Every other exit in the journal is a rule firing — the target, the stop, the 15:15 square-off —
// and `journalTick` writes those on its own. This one happens because the operator decided it
// should, and that difference is the whole of what is pinned down here:
//
//   the price is the BID, not the last trade    an exit is a sale
//   the row is stamped manual AND edited        or `settleDay` re-grades it against +80/-50 and
//                                               the 11:00 exit becomes a 15:15 square-off
//   a stale feed is refused, not rounded down   an invented fill is indistinguishable from a
//                                               real one the moment it is written
//
// The last of those is the one most worth a test. Falling back to a mark from three hours ago
// produces a perfectly plausible row that never happened.

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { journalExitNow, setJournalRepository } from '../src/momentum/journal/journal.js';
import { FileJournalRepository } from '../src/momentum/journal/repository.js';
import { injectPatches, resetFeedStore } from '../src/feed/client.js';
import type { KeyValueStore } from '../src/momentum/store.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

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

const KEY = 'NSE_FO|54321';
const DAY = '2026-08-21';
const ID = `${DAY}:displacement:TESTCO`;
/** 2026-08-21, 11:00 IST — session minute 105. */
const NOW = Date.parse('2026-08-21T05:30:00Z');
const MINUTE = 105;

const trade = (over: Partial<JournalTrade> = {}): JournalTrade => ({
  id: ID,
  day: DAY,
  channel: 'displacement',
  symbol: 'TESTCO',
  direction: 1,
  contract: { label: '300 CE', strike: 300, type: 'CE', instrumentKey: KEY, expiry: '2026-08-25', lotSize: 500 },
  lots: 1,
  entry: { at: NOW - 3_600_000, minute: 45, premium: 10, spot: 300, source: 'auto' },
  exit: null, mark: null, mfePct: null, maePct: null, spreadPctAtEntry: 1.2,
  amountUsed: 5000, grossPnl: null, charges: null, netPnl: null, netPct: null,
  shadow: [], readings: {}, note: '', status: 'open',
  settled: false, edited: false, updatedAt: NOW - 3_600_000,
  ...over,
});

const seed = async (over: Partial<JournalTrade> = {}): Promise<FileJournalRepository> => {
  const repo = new FileJournalRepository(new MemoryStore());
  await repo.save([trade(over)]);
  setJournalRepository(repo);
  return repo;
};

/** A book with a bid, as it would arrive on the wire. */
const book = (bidP: number, askP: number, at = NOW): void =>
  injectPatches([{
    instrumentKey: KEY, isIndex: false, ltp: (bidP + askP) / 2,
    depth: [{ bidP, bidQ: 500, askP, askQ: 500 }],
  }], at);

beforeEach(() => resetFeedStore());
afterEach(() => setJournalRepository(null));

/* --------------------------------------------------------------------------- selling --- */

describe('journal · exit now', () => {
  it('sells at the bid, not at the last trade', async () => {
    await seed();
    book(14, 16);                     // the LTP here would be 15
    const t = (await journalExitNow(ID, NOW))!;

    assert.equal(t.exit?.premium, 14, 'the LTP is not a price anyone was bidding');
    assert.equal(t.exit?.reason, 'manual');
    assert.equal(t.exit?.source, 'manual');
    assert.equal(t.exit?.minute, MINUTE);
    assert.equal(t.status, 'closed');
  });

  it('falls back to the last trade when the book carries no bid', async () => {
    await seed();
    injectPatches([{ instrumentKey: KEY, isIndex: false, ltp: 12.5 }], NOW);
    const t = (await journalExitNow(ID, NOW))!;
    assert.equal(t.exit?.premium, 12.5);
  });

  it('locks the prices without hiding the row from settlement', async () => {
    await seed();
    book(14, 16);
    const t = (await journalExitNow(ID, NOW))!;
    // `edited` is the lock, and it is the whole lock: `settleDay` checks that flag and keeps its
    // hands off the prices, so a real 11:00 exit is never replaced by a modelled 15:15 square-off.
    assert.equal(t.edited, true, 'settleDay leaves the prices of edited rows alone');
    // `settled` is NOT a lock and must not be set here. It means the after-close pass has been
    // over this row, and claiming it early hid the trade from `settleDay` altogether — which cost
    // it the two things only that pass can give: its archived option path, which expires with the
    // series about four weeks later, and the 15:15 counterfactual the exit is judged against.
    assert.equal(t.settled, false, 'the after-close pass still owes this row a path and a dayEnd');
  });

  it('books the money, charges included', async () => {
    await seed();
    book(14, 16);
    const t = (await journalExitNow(ID, NOW))!;
    assert.equal(t.grossPnl, 2000, '(14 - 10) x 500');
    assert.equal(t.charges, 120);
    assert.equal(t.netPnl, 1880);
  });

  it('leaves a snapshot that reverts the row to open', async () => {
    await seed();
    book(14, 16);
    const t = (await journalExitNow(ID, NOW))!;
    assert.equal(t.original?.exit, null, 'there was no exit to go back to — reverting must reopen it');
    assert.equal(t.original?.entry.premium, 10);
  });

  it('persists through the repository rather than only in memory', async () => {
    const repo = await seed();
    book(14, 16);
    await journalExitNow(ID, NOW);
    assert.equal((await repo.one(ID))?.exit?.premium, 14);
  });
});

/* ----------------------------------------------------------------------- excursions --- */

describe('journal · exit now · excursions', () => {
  it('extends the best-seen when the exit is a new high', async () => {
    await seed({ mfePct: 0.10, mfeMinute: 60, maePct: -0.05, maeMinute: 50 });
    book(14, 16);                     // +40%, well past the recorded +10%
    const t = (await journalExitNow(ID, NOW))!;
    // A row that exits above its own "best it saw" reads as a broken record, not as rounding.
    assert.equal(t.mfePct, 0.4);
    assert.equal(t.mfeMinute, MINUTE);
    assert.equal(t.maePct, -0.05, 'the worst it saw did not move');
  });

  it('leaves the excursions alone when the exit is inside them', async () => {
    await seed({ mfePct: 0.60, mfeMinute: 60, maePct: -0.30, maeMinute: 50 });
    book(11, 12);                     // +10%
    const t = (await journalExitNow(ID, NOW))!;
    assert.equal(t.mfePct, 0.6);
    assert.equal(t.mfeMinute, 60);
    assert.equal(t.maePct, -0.3);
  });
});

/* ------------------------------------------------------------------------- refusals --- */

describe('journal · exit now · what it refuses', () => {
  it('answers null for an id it does not have', async () => {
    await seed();
    book(14, 16);
    assert.equal(await journalExitNow('2026-08-21:displacement:NOSUCH', NOW), null);
  });

  it('refuses a trade that is already closed', async () => {
    await seed({
      status: 'closed',
      exit: { at: NOW, minute: 80, premium: 18, spot: null, source: 'auto', reason: 'target' },
    });
    book(14, 16);
    await assert.rejects(() => journalExitNow(ID, NOW), /already closed/);
  });

  it('refuses a trade with no contract, rather than pricing nothing', async () => {
    await seed({ contract: null });
    await assert.rejects(() => journalExitNow(ID, NOW), /nothing to sell/);
  });

  it('refuses a feed with no price at all for the contract', async () => {
    await seed();
    await assert.rejects(() => journalExitNow(ID, NOW), /no price/);
  });

  it('refuses a print older than the freshness bound', async () => {
    await seed();
    // Three hours old. Selling at it would write a plausible fill that never existed.
    book(14, 16, NOW - 3 * 60 * 60 * 1000);
    await assert.rejects(() => journalExitNow(ID, NOW), /no price/);
  });

  it('accepts a print inside the bound', async () => {
    await seed();
    book(14, 16, NOW - 90_000);
    assert.equal((await journalExitNow(ID, NOW))?.exit?.premium, 14);
  });

  it('leaves the row untouched when it refuses', async () => {
    const repo = await seed();
    await assert.rejects(() => journalExitNow(ID, NOW));
    const t = (await repo.one(ID))!;
    assert.equal(t.status, 'open');
    assert.equal(t.exit, null);
    assert.equal(t.edited, false);
  });
});
