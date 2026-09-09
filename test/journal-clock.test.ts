// WHEN a trade happened, as distinct from when the process noticed.
//
// The journal has two writers and they know different things about time. `journalTick` runs
// inside the session and every event it records really is happening now. `settleDay` runs after
// the close — often hours after, and on a restart days after — and grades a path that is already
// over: it knows the MINUTE of an exit exactly and has no honest wall-clock stamp for it at all.
//
// Both used `Date.now()`. That is invisible on a machine that settles at 15:16, because a 15:15
// square-off filed at 15:16 looks right, and it stays invisible for every exit that happens to be
// a square-off. It stopped being invisible the evening a reverted row was re-settled after
// dinner and came back as a 10:26 PM exit with an eleven-hour holding period — and once that was
// looked at, a 12:05 checkpoint had been filed at 3:16 PM all along.
//
// The second half of the same confusion: `journalTick` derives a session minute from the current
// clock, and 22:30 is minute 795. Nothing bounded that, and the square-off arm fires on
// `minute >= squareOffMin`, which every minute of the evening satisfies. A row put back to open
// at night was squared off on the spot at minute 795, against a mark left over from the morning,
// before settlement ever got to price it from candles.

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { journalTick, setJournalRepository } from '../src/momentum/journal/journal.js';
import { FileJournalRepository } from '../src/momentum/journal/repository.js';
import { injectPatches, resetFeedStore } from '../src/feed/client.js';
import { istDay, istMinutes, sessionAt, SESSION_MINUTES, SESSION_OPEN_MIN } from '../src/momentum/session.js';
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
const DAY = '2026-09-09';
const ID = `${DAY}:displacement:TESTCO`;
/** 2026-09-09, 22:30 IST — long after the close, and "minute 795" by the old arithmetic. */
const NIGHT = Date.parse('2026-09-09T17:00:00Z');
/** The same day at 11:00 IST — session minute 105. */
const NOON = Date.parse('2026-09-09T05:30:00Z');

const trade = (over: Partial<JournalTrade> = {}): JournalTrade => ({
  id: ID,
  day: DAY,
  channel: 'displacement',
  symbol: 'TESTCO',
  direction: 1,
  contract: { label: '300 CE', strike: 300, type: 'CE', instrumentKey: KEY, expiry: '2026-09-29', lotSize: 500 },
  lots: 1,
  entry: { at: NOON - 3_600_000, minute: 45, premium: 10, spot: 300, source: 'auto' },
  exit: null,
  // The stale mark a hand-exited row still carries when a revert puts it back to open.
  mark: { at: NOON, premium: 16.2, pct: 0.62 },
  mfePct: 0.62, maePct: -0.1, spreadPctAtEntry: 1.2,
  amountUsed: 5000, grossPnl: null, charges: null, netPnl: null, netPct: null,
  shadow: [], readings: {}, note: '', status: 'open',
  settled: false, edited: false, updatedAt: NOON,
  ...over,
});

const seed = async (over: Partial<JournalTrade> = {}): Promise<FileJournalRepository> => {
  const repo = new FileJournalRepository(new MemoryStore());
  await repo.save([trade(over)]);
  setJournalRepository(repo);
  return repo;
};

beforeEach(() => resetFeedStore());
afterEach(() => setJournalRepository(null));

/* ------------------------------------------------------------------- session clock --- */

describe('sessionAt', () => {
  it('places minute 0 at the open and the square-off where the clock says', () => {
    assert.equal(new Date(sessionAt(DAY, 0)).toISOString(), '2026-09-09T03:45:00.000Z', '09:15 IST');
    assert.equal(new Date(sessionAt(DAY, 360)).toISOString(), '2026-09-09T09:45:00.000Z', '15:15 IST');
  });

  it('is the exact inverse of istMinutes, which is the property everything else leans on', () => {
    for (const minute of [0, 1, 105, 242, 360, SESSION_MINUTES]) {
      const at = sessionAt(DAY, minute);
      assert.equal(istMinutes(at) - SESSION_OPEN_MIN, minute, `minute ${minute} did not round-trip`);
      assert.equal(istDay(at), DAY, `minute ${minute} landed on the wrong day`);
    }
  });

  it('never lands on the neighbouring day, which is the whole risk of doing this in UTC', () => {
    // 09:15 IST is 03:45 UTC the SAME morning; the naive `Date.parse(day) + minute` is 5.5 hours
    // out and puts the early session on the previous evening.
    assert.equal(istDay(sessionAt(DAY, 0)), DAY);
    assert.equal(istDay(sessionAt(DAY, SESSION_MINUTES)), DAY);
  });
});

/* ---------------------------------------------------------------------- the marker --- */

describe('journalTick: outside the session', () => {
  it('does not square off an open row in the evening', async () => {
    const repo = await seed();
    await journalTick(NIGHT);

    const [t] = await repo.mine(DAY);
    assert.equal(t.status, 'open', 'the evening is not the square-off');
    assert.equal(t.exit, null, 'nothing at 22:30 can price a trade that ran this morning');
  });

  it('never writes a minute outside the session, however late it runs', async () => {
    const repo = await seed();
    await journalTick(NIGHT);

    const [t] = await repo.mine(DAY);
    // 795 is what `istMinutes(22:30) - SESSION_OPEN_MIN` produces, and it was being written
    // straight into the record as though the session ran to half past ten at night.
    assert.ok(
      t.exit === null || t.exit.minute <= SESSION_MINUTES,
      `exit minute ${t.exit?.minute} is not a minute of the trading day`,
    );
  });

  it('leaves the stale mark alone rather than settling against it', async () => {
    const repo = await seed();
    await journalTick(NIGHT);

    const [t] = await repo.mine(DAY);
    assert.equal(t.mark?.premium, 16.2, 'the morning mark is not an evening price');
    assert.equal(t.netPnl, null, 'nothing was booked, so nothing is priced');
  });
});

describe('journalTick: inside the session', () => {
  it('still squares off once the square-off minute has passed', async () => {
    // 15:20 IST — past the 15:15 square-off, still inside the session.
    const at = Date.parse('2026-09-09T09:50:00Z');
    const repo = await seed();
    injectPatches([{
      instrumentKey: KEY, isIndex: false, ltp: 16.2,
      depth: [{ bidP: 16, bidQ: 500, askP: 16.4, askQ: 500 }],
    }], at);
    await journalTick(at);

    const [t] = await repo.mine(DAY);
    assert.equal(t.status, 'closed');
    assert.equal(t.exit?.reason, 'square-off');
    // Stamped at the rule's own minute, not at the tick that noticed it had passed.
    assert.equal(t.exit?.minute, 360, 'the 15:15 square-off happened at 15:15');
    assert.equal(t.exit?.at, sessionAt(DAY, 360));
  });
});
