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

import { gradePath, journalConfig, SHADOW } from '../src/momentum/journal/journal.js';

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
