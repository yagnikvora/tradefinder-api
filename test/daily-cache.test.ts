// The daily-bar cache.
//
// What is pinned here is the part that can go silently wrong. A cache that misses a session
// leaves the ATR a day stale, which is invisible; a cache that merges across a corporate action
// computes the ATR half in old rupees and half in new, which is worse than invisible because the
// number still looks plausible. Both are checked below, along with the one case the whole thing
// exists for: a rebuild the same day making no request at all.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  barDay, lastPossibleSession, mergeBars, overlapAgrees,
} from '../src/momentum/data/daily-cache.js';
import type { DailyBar } from '../src/equity.js';

/** A daily bar for an IST date. Epoch seconds at 09:15 IST, which is where Upstox stamps them. */
const bar = (day: string, close: number, vol = 1000): DailyBar => [
  Math.floor(Date.parse(`${day}T09:15:00+05:30`) / 1000),
  close, close * 1.01, close * 0.99, close, vol,
];

const series = (days: string[], from = 100): DailyBar[] => days.map((d, i) => bar(d, from + i));

describe('daily-cache: which day a bar belongs to', () => {
  it('reads the IST day off the epoch, not the host timezone', () => {
    assert.equal(barDay(bar('2026-08-14', 100)), '2026-08-14');
  });
});

describe('daily-cache: the last session that could exist', () => {
  // Monday asks for Friday. This is the case that makes a weekend build pay off on Monday
  // morning: the cache already holds Friday, so no request is made at all.
  it('walks back over a weekend', () => {
    assert.equal(lastPossibleSession('2026-08-17'), '2026-08-14'); // Mon -> Fri
  });

  it('is simply yesterday mid-week', () => {
    assert.equal(lastPossibleSession('2026-08-14'), '2026-08-13'); // Fri -> Thu
  });

  it('answers Friday for both weekend days', () => {
    assert.equal(lastPossibleSession('2026-08-15'), '2026-08-14'); // Sat -> Fri
    assert.equal(lastPossibleSession('2026-08-16'), '2026-08-14'); // Sun -> Fri
  });

  // Holidays are deliberately not consulted, and the direction of that error is the point: a
  // holiday makes the REAL last session earlier than this answer, so the cache reads as behind
  // and refetches. The opposite mistake — skipping a session that did trade — cannot happen.
  it('errs toward refetching rather than toward skipping a session', () => {
    const answer = lastPossibleSession('2026-08-18');
    assert.equal(answer, '2026-08-17');
    assert.ok(answer >= '2026-08-17', 'must never point EARLIER than the true last session');
  });
});

describe('daily-cache: detecting a re-adjusted series', () => {
  it('agrees when the shared sessions match', () => {
    const cached = series(['2026-08-10', '2026-08-11', '2026-08-12']);
    const fresh = [...cached.slice(1), bar('2026-08-13', 103)];
    assert.equal(overlapAgrees(cached, fresh), true);
  });

  // THE ONE THAT MATTERS. A 1:2 split re-prices the entire history at the source. Appending the
  // new bars to the old ones would compute an ATR across the join — half of it in pre-split
  // rupees — and the resulting number is wrong in a way nothing downstream could detect.
  it('refuses a series whose history has been re-priced by a split', () => {
    const cached = series(['2026-08-10', '2026-08-11', '2026-08-12']);
    const halved = cached.slice(1).map((b) => [b[0], b[1] / 2, b[2] / 2, b[3] / 2, b[4] / 2, b[5]] as DailyBar);
    assert.equal(overlapAgrees(cached, [...halved, bar('2026-08-13', 51)]), false);
  });

  it('tolerates a paisa of float drift, which is not a corporate action', () => {
    const cached = series(['2026-08-10', '2026-08-11']);
    const nudged = cached.map((b) => [b[0], b[1], b[2] + 0.004, b[3], b[4], b[5]] as DailyBar);
    assert.equal(overlapAgrees(cached, nudged), true);
  });

  // No shared session means nothing was actually compared. Treating that as agreement would
  // merge across an unverified gap, which is the silent join this check exists to prevent.
  it('treats a gap with no overlap as disagreement', () => {
    const cached = series(['2026-08-03', '2026-08-04']);
    const fresh = series(['2026-08-20', '2026-08-21']);
    assert.equal(overlapAgrees(cached, fresh), false);
  });
});

describe('daily-cache: merging', () => {
  it('appends what is new and keeps the order oldest-first', () => {
    const cached = series(['2026-08-10', '2026-08-11']);
    const merged = mergeBars(cached, [bar('2026-08-12', 102)], '2026-01-01');
    assert.deepEqual(merged.map(barDay), ['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('lets a refetched session overwrite the one already held', () => {
    const cached = [bar('2026-08-10', 100)];
    const merged = mergeBars(cached, [bar('2026-08-10', 111)], '2026-01-01');
    assert.equal(merged.length, 1);
    assert.equal(merged[0][4], 111, 'the fresh close must win on a shared timestamp');
  });

  // Otherwise the series grows by one bar a day forever and the cache file with it.
  it('trims anything older than the lookback window', () => {
    const cached = series(['2026-01-05', '2026-08-10', '2026-08-11']);
    const merged = mergeBars(cached, [], '2026-08-01');
    assert.deepEqual(merged.map(barDay), ['2026-08-10', '2026-08-11']);
  });
});
