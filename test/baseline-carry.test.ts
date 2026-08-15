// The baseline carry-forward — what a symbol keeps when today's build could not reach it.
//
// This exists because of a failure that ran for days without anyone being able to see it. Two
// modules spend the same `/v3/historical-candle` budget: the R.Factor rebuild in `volume.ts` and
// the morning ATR baseline. Until they shared a circuit breaker the R.Factor rebuild would empty
// the 30-minute quota, the ATR build would get a 429 on its first request, and every symbol it
// could not reach lost its ATR. The trend-day alert reads "no ATR" as "cannot be priced" and
// withholds the confirmation for the whole session — so a rate limit at 08:00 cost a whole day of
// alerts, silently.
//
// The rule under test is the compromise: a stale reading is better than no reading, but only up
// to a point, because the ATR travels with the PREVIOUS SESSION's high, low and close and those
// go genuinely wrong once a session has passed.
//
// Nothing here touches the network or the disk — `carryForward` takes the two maps it would
// otherwise have read, which is why it was separated from the build in the first place.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { carryForward, type Baseline, type SymbolBaseline } from '../src/momentum/data/baseline.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** A baseline reading with only the fields these tests reason about set to anything real. */
const reading = (symbol: string, atr: number, carriedFrom?: string): SymbolBaseline => ({
  symbol,
  profile: [],
  profileSessions: 20,
  avgDailyVolume: 1_000_000,
  avgDailyValueCr: 100,
  atr,
  atrPct: 1.5,
  atrPeriod: 14,
  hv20: 20,
  hv252: 25,
  hvRank: 50,
  beta: 1,
  priorHigh: 110,
  priorLow: 90,
  prevHigh: 105,
  prevLow: 95,
  prevClose: 100,
  prevFuturesOi: null,
  dailyBars: 400,
  ...(carriedFrom ? { carriedFrom } : {}),
});

const baseline = (day: string, symbols: SymbolBaseline[]): Baseline => ({
  day,
  builtAt: Date.parse(`${day}T02:30:00Z`),
  symbols: Object.fromEntries(symbols.map((s) => [s.symbol, s])),
  failures: {},
});

const TODAY = '2026-08-17';

/* --------------------------------------------------------------------------- tests --- */

describe('baseline carry-forward', () => {
  it('fills a symbol today could not reach, and marks where it came from', () => {
    const built: Record<string, SymbolBaseline> = { RELIANCE: reading('RELIANCE', 30) };
    const previous = baseline('2026-08-14', [reading('RELIANCE', 28), reading('NTPC', 6)]);

    const { carried, tooOld } = carryForward(built, previous, TODAY);

    assert.equal(carried, 1);
    assert.equal(tooOld, 0);
    assert.equal(built.NTPC.atr, 6, 'NTPC keeps an ATR instead of losing it to a 429');
    assert.equal(built.NTPC.carriedFrom, '2026-08-14');
  });

  it("never overwrites today's own build with an older reading", () => {
    const built: Record<string, SymbolBaseline> = { RELIANCE: reading('RELIANCE', 30) };
    const previous = baseline('2026-08-14', [reading('RELIANCE', 28)]);

    const { carried } = carryForward(built, previous, TODAY);

    assert.equal(carried, 0);
    assert.equal(built.RELIANCE.atr, 30, 'the fresh reading wins');
    assert.equal(built.RELIANCE.carriedFrom, undefined, 'and is not mislabelled as carried');
  });

  it('drops a reading too old for its previous-session levels to be trusted', () => {
    const built: Record<string, SymbolBaseline> = {};
    // Eleven days back — the ATR would still be defensible, but prevHigh/prevLow/prevClose are
    // eight sessions stale and trend structure would read higher highs that never happened.
    const previous = baseline('2026-08-06', [reading('NTPC', 6)]);

    const { carried, tooOld } = carryForward(built, previous, TODAY);

    assert.equal(carried, 0);
    assert.equal(tooOld, 1);
    assert.equal(built.NTPC, undefined, 'silence beats an invented level');
  });

  it('cannot launder its own age by being carried one day at a time', () => {
    const built: Record<string, SymbolBaseline> = {};
    // The baseline is yesterday's, but THIS reading inside it was already carried from long ago.
    // Restamping it on every carry would keep it alive forever, one day at a time.
    const previous = baseline('2026-08-16', [reading('NTPC', 6, '2026-08-01')]);

    const { carried, tooOld } = carryForward(built, previous, TODAY);

    assert.equal(carried, 0, 'the original build date is what counts, not the last hop');
    assert.equal(tooOld, 1);
  });

  it('keeps the original build date when a still-fresh reading is carried again', () => {
    const built: Record<string, SymbolBaseline> = {};
    const previous = baseline('2026-08-16', [reading('NTPC', 6, '2026-08-14')]);

    const { carried } = carryForward(built, previous, TODAY);

    assert.equal(carried, 1);
    assert.equal(built.NTPC.carriedFrom, '2026-08-14', 'not restamped to 2026-08-16');
  });

  it('is a no-op when there is no previous baseline at all', () => {
    const built: Record<string, SymbolBaseline> = { RELIANCE: reading('RELIANCE', 30) };

    const { carried, tooOld } = carryForward(built, null, TODAY);

    assert.equal(carried, 0);
    assert.equal(tooOld, 0);
    assert.deepEqual(Object.keys(built), ['RELIANCE']);
  });

  it('leaves the merged map at least as complete as the baseline it replaces', () => {
    // The property the coverage gate now relies on: every symbol in `previous` survives into the
    // merge, so writing the merged result can never lose ground on what was already there.
    const built: Record<string, SymbolBaseline> = { RELIANCE: reading('RELIANCE', 30) };
    const previous = baseline('2026-08-16', [
      reading('NTPC', 6), reading('OFSS', 90), reading('OIL', 4),
    ]);

    carryForward(built, previous, TODAY);

    for (const symbol of Object.keys(previous.symbols))
      assert.ok(built[symbol], `${symbol} survived the merge`);
    assert.ok(built.RELIANCE, "today's own build survived too");
  });
});
