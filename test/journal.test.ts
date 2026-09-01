// The trade journal — the grading convention and the money, not the disk.
//
// `gradePath` is the whole opinion of this module: everything else reads and writes JSON. What is
// pinned down here is every way a record could flatter itself — resolving a two-sided bar as the
// target, missing an excursion, scoring an alternative exit on a different path than the real one,
// or charging brokerage on a trade that was never priced.
//
// The first test is the one that matters. A minute bar that touches both the stop and the target
// is graded as the STOP, because the bar cannot say which came first and the other choice invents
// an edge that does not exist. That is the same convention `research/lab.mjs` uses, which is what
// makes the journal comparable to the study it came from.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  dayEndOf, gradePath, gradeRule, journalConfig, sessionBars, SHADOW,
} from '../src/momentum/journal/journal.js';
import type { UpstoxCandle } from '../src/upstox.js';

/** A minute bar on the option's own premium. */
const bar = (minute: number, low: number, high: number, close = (low + high) / 2) =>
  ({ minute, low, high, close });

const PAID = 20;
const FROM = 15;      // signalled at 09:30
const LAST = 360;     // squared off at 15:15

describe('journal · gradePath', () => {
  it('resolves a bar that touched both levels as the stop', () => {
    // 10 is −50%, 36 is +80%. One bar reaches both.
    const r = gradePath([bar(20, 10, 36, 30)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'stop');
    assert.equal(r.pct, -0.50);
    assert.equal(r.minute, 20);
  });

  it('takes the target when the stop was never touched', () => {
    const r = gradePath([bar(20, 19, 24), bar(40, 30, 37)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'target');
    assert.equal(r.pct, 0.80);
    assert.equal(r.minute, 40);
  });

  it('closes at the last bar inside the square-off when neither level was reached', () => {
    const r = gradePath([bar(20, 19, 24, 23), bar(100, 21, 26, 25)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'close');
    assert.equal(r.minute, 100);
    // 25 against 20 paid.
    assert.equal(+r.pct.toFixed(4), 0.25);
  });

  it('ignores bars at or before the entry minute — you cannot be stopped before you are in', () => {
    // A 9-rupee low at minute 10 would be a stop, but the entry is at minute 15.
    const r = gradePath([bar(10, 9, 9.5), bar(20, 21, 24, 23)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'close');
    assert.equal(r.mae, 0);
  });

  it('ignores bars after the square-off minute', () => {
    const r = gradePath([bar(100, 19, 24, 23), bar(370, 5, 40)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'close');
    assert.equal(r.minute, 100);
  });

  it('records the excursions it saw before exiting, and no further', () => {
    const r = gradePath(
      [bar(20, 17, 25), bar(30, 16, 34), bar(40, 10, 22), bar(50, 1, 60)],
      PAID, FROM, 0.80, 0.50, LAST,
    );
    assert.equal(r.out, 'stop');
    assert.equal(r.minute, 40);
    // Best was 34 (+70%), worst before the stop bar was 16 (−20%); the stop bar's own low is 10.
    assert.equal(+r.mfe.toFixed(4), 0.70);
    assert.equal(+r.mae.toFixed(4), -0.50);
    // The 60-rupee high on minute 50 is after the exit and must not appear.
    assert.ok(r.mfe < 2);
  });

  it('reports a flat path as zero rather than as missing', () => {
    const r = gradePath([bar(20, 20, 20, 20)], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'close');
    assert.equal(r.pct, 0);
  });

  it('returns no move when there are no usable bars at all', () => {
    const r = gradePath([], PAID, FROM, 0.80, 0.50, LAST);
    assert.equal(r.out, 'close');
    assert.equal(r.pct, 0);
    assert.equal(r.minute, FROM);
  });
});

describe('journal · the alternative exits', () => {
  // The path that made the 15%/30% pair a losing one: a dip that would have stopped a tight stop
  // out at minute 20, before the move that a wide one rode to the close.
  const path = [bar(20, 16.8, 21), bar(60, 18, 26), bar(200, 24, 33, 32)];

  it('scores each alternative on the SAME path, not on its own', () => {
    const results = SHADOW.map((s) => ({
      name: s.name,
      ...gradePath(path, PAID, FROM, s.tp, s.sl, LAST),
    }));
    const tight = results.find((r) => r.name === '+30/-15')!;
    const wide = results.find((r) => r.name === '+30/-50')!;

    // −15% of 20 is 17. The minute-20 bar dipped to 16.8, so the tight stop is hit.
    assert.equal(tight.out, 'stop');
    assert.equal(tight.pct, -0.15);
    // The same bar is nowhere near −50%, so the wide stop survives it and reaches +30% (26).
    assert.equal(wide.out, 'target');
    assert.equal(wide.pct, 0.30);
  });

  it('is beaten on this path by the exit the journal actually uses', () => {
    const cfg = journalConfig();
    const real = gradePath(path, PAID, FROM, cfg.tpPct, cfg.slPct, LAST);
    const tight = gradePath(path, PAID, FROM, 0.30, 0.15, LAST);
    assert.ok(real.pct > tight.pct, `${real.pct} should beat ${tight.pct}`);
  });
});

describe('journal · config', () => {
  it('defaults to the pair the study settled on', () => {
    const cfg = journalConfig();
    assert.equal(cfg.tpPct, 0.80);
    assert.equal(cfg.slPct, 0.50);
    assert.equal(cfg.squareOffMin, 360);
    assert.equal(cfg.lots, 1);
  });

  it('refuses a stop of 100% or more — it would mark a total loss as a normal exit', () => {
    const before = process.env.JOURNAL_SL_PCT;
    process.env.JOURNAL_SL_PCT = '100';
    try {
      assert.equal(journalConfig().slPct, 0.50, 'out-of-range value must fall back to the default');
    } finally {
      if (before === undefined) delete process.env.JOURNAL_SL_PCT;
      else process.env.JOURNAL_SL_PCT = before;
    }
  });

  it('is on unless explicitly switched off', () => {
    const before = process.env.JOURNAL;
    try {
      delete process.env.JOURNAL;
      assert.equal(journalConfig().enabled, true);
      process.env.JOURNAL = 'off';
      assert.equal(journalConfig().enabled, false);
      process.env.JOURNAL = 'OFF';
      assert.equal(journalConfig().enabled, false);
    } finally {
      if (before === undefined) delete process.env.JOURNAL;
      else process.env.JOURNAL = before;
    }
  });
});

describe('journal · sessionBars', () => {
  /** A candle exactly as `sessionCandles` returns one: element 0 is epoch SECONDS. */
  const candle = (iso: string, high: number, low: number, close: number): UpstoxCandle =>
    [Math.floor(Date.parse(iso) / 1000), close, high, low, close, 0, 0];

  it('reads the candle epoch as seconds, not milliseconds', () => {
    // The bug this pins: `istMinutes` takes milliseconds, so passing the raw epoch read a 2026
    // candle as January 1970 and put every bar at minute ~768 — past the square-off, so
    // `gradePath` discarded the entire session and booked a flat exit on every settled trade.
    const bars = sessionBars([
      candle('2026-08-25T09:15:00+05:30', 1, 1, 1),
      candle('2026-08-25T09:40:00+05:30', 1, 1, 1),
      candle('2026-08-25T15:15:00+05:30', 1, 1, 1),
    ]);
    assert.deepEqual(bars.map((b) => b.minute), [0, 25, 360]);
  });

  it('gives gradePath a path it can actually grade', () => {
    // Entered at 09:40 for 20; the contract doubles by 11:00. That is +100%, past the +80% target.
    const bars = sessionBars([
      candle('2026-08-25T09:40:00+05:30', 20, 20, 20),
      candle('2026-08-25T11:00:00+05:30', 40, 39, 40),
    ]);
    const r = gradePath(bars, 20, 25, 0.80, 0.50, 360);
    assert.equal(r.out, 'target');
    assert.equal(r.pct, 0.80);
    // Under the bug every bar was filtered out and this came back as a flat 'close' at minute 25.
    assert.notEqual(r.minute, 25);
  });

  it('sorts bars the API returned out of order', () => {
    const bars = sessionBars([
      candle('2026-08-25T11:00:00+05:30', 1, 1, 1),
      candle('2026-08-25T09:30:00+05:30', 1, 1, 1),
    ]);
    assert.deepEqual(bars.map((b) => b.minute), [15, 105]);
  });
});

// `gradeRule` grades the exits whose STOP MOVES — breakeven and trailing. It exists because a
// fixed pair cannot express the failure the record actually shows: a position up 25% at 11:00 that
// is handed to the square-off at a loss. The tests below pin the one detail that decides whether
// its answers are believable rather than fantasy — a trail must lag the peak by a bar.
describe('journal · gradeRule (moving stops)', () => {
  const RULE_TRAIL = { name: 't', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 0.15 } as const;
  const RULE_BE = { name: 'be', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 'breakeven' as const };

  it('does not trail from a peak set by the same bar', () => {
    // One bar runs to +40% and back to +10%. A trail of 15 points off THIS bar's own high would
    // exit at +25%; the real trail had not moved yet when the low printed, so it must not fire.
    const r = gradeRule([bar(20, PAID * 1.10, PAID * 1.40)], PAID, FROM, RULE_TRAIL, LAST);
    assert.equal(r.out, 'close', 'a bar must not be stopped on a trail derived from its own high');
  });

  it('trails from the previous bar peak once armed', () => {
    // Bar 20 peaks at +40%, so from bar 40 the trail sits at +25%. Bar 40 dips to +20%.
    const r = gradeRule(
      [bar(20, PAID * 1.30, PAID * 1.40), bar(40, PAID * 1.20, PAID * 1.35)],
      PAID, FROM, RULE_TRAIL, LAST,
    );
    assert.equal(r.out, 'stop');
    assert.ok(Math.abs(r.pct - 0.25) < 1e-9, `expected +25%, got ${r.pct}`);
  });

  it('leaves the stop alone until the arming level is reached', () => {
    // Peaks at +15%, never arms, then collapses to the original -50%.
    const r = gradeRule(
      [bar(20, PAID * 1.05, PAID * 1.15), bar(40, PAID * 0.40, PAID * 0.90)],
      PAID, FROM, RULE_TRAIL, LAST,
    );
    assert.equal(r.out, 'stop');
    assert.ok(Math.abs(r.pct + 0.50) < 1e-9, `expected the -50% stop, got ${r.pct}`);
  });

  it('a breakeven rule exits at entry, not at a profit', () => {
    const r = gradeRule(
      [bar(20, PAID * 1.20, PAID * 1.30), bar(40, PAID * 0.80, PAID * 1.10)],
      PAID, FROM, RULE_BE, LAST,
    );
    assert.equal(r.out, 'stop');
    assert.equal(r.pct, 0);
  });

  it('still resolves a two-sided bar as the stop', () => {
    const r = gradeRule([bar(20, PAID * 0.40, PAID * 1.90)], PAID, FROM,
      { name: 'x', tp: 0.80, sl: 0.50 }, LAST);
    assert.equal(r.out, 'stop');
  });

  it('reduces to gradePath when the rule has no moving stop', () => {
    const path = [bar(20, PAID * 0.90, PAID * 1.10), bar(40, PAID * 0.95, PAID * 1.30)];
    const plain = gradePath(path, PAID, FROM, 0.80, 0.50, LAST);
    const viaRule = gradeRule(path, PAID, FROM, { name: 'x', tp: 0.80, sl: 0.50 }, LAST);
    assert.equal(viaRule.out, plain.out);
    assert.ok(Math.abs(viaRule.pct - plain.pct) < 1e-9);
  });
});

// THE COUNTERFACTUAL THE EXIT RULES ARE JUDGED AGAINST. A row that banked +6% at 13:17 and one
// that banked +6% at 15:15 are the same result and a completely different decision; nothing else
// on the row separates them. MPHASIS on 2026-09-01 is the case: checkpointed out at 49.50 on a
// one-minute wick, then closed the session at 51.05.
describe('journal · the day-end counterfactual', () => {
  const SIZE = 275, LOTS = 1, CHARGE = journalConfig().chargePerLot;

  it('prices the close against the entry, charged like a real exit', () => {
    const d = dayEndOf([bar(100, 50, 52, 51), bar(359, 50, 52, 51.05)], 46.7, 75, SIZE, LOTS, LAST);
    assert.equal(d?.premium, 51.05);
    assert.equal(d?.pct, +((51.05 - 46.7) / 46.7).toFixed(4));
    assert.equal(d?.netPnl, +((51.05 - 46.7) * SIZE - CHARGE).toFixed(2));
  });

  // Option candles run past 15:15. Grading against a close nobody could have taken would make
  // every exit rule look worse than it was, which is the opposite of the point.
  it('takes the last bar at or before the square-off, not the last bar there is', () => {
    const d = dayEndOf([bar(359, 50, 52, 51), bar(375, 60, 62, 61)], 46.7, 75, SIZE, LOTS, LAST);
    assert.equal(d?.premium, 51);
  });

  it('ignores bars at or before the entry', () => {
    const d = dayEndOf([bar(10, 10, 12, 11)], 46.7, 75, SIZE, LOTS, LAST);
    assert.equal(d, null);
  });

  // Same refusal `price` makes: a contract nobody could size is not a trade to compare against.
  it('declines rather than inventing a number it cannot have', () => {
    assert.equal(dayEndOf([], 46.7, 75, SIZE, LOTS, LAST), null);
    assert.equal(dayEndOf([bar(359, 50, 52, 51)], 46.7, 75, 0, LOTS, LAST), null);
    assert.equal(dayEndOf([bar(359, 50, 52, 51)], 0, 75, SIZE, LOTS, LAST), null);
  });

  it('reports a loss when the close is under the entry', () => {
    const d = dayEndOf([bar(359, 30, 32, 31)], 46.7, 75, SIZE, LOTS, LAST);
    assert.equal(d!.netPnl < 0, true);
    assert.equal(d!.pct < 0, true);
  });
});
