// The checkpoint: once a position has been up `armAt`, the stop moves once to `lock` and stays.
//
// This is the rule that replaced a bare +80/−50 on 2026-08-30, after all 78 journalled trades were
// re-graded on their own contracts' minute candles. What is pinned down here is the handful of
// behaviours that separate a checkpoint from the trailing stop it is easily mistaken for, and from
// the look-ahead version of itself that would score better and be wrong:
//
//   it does NOT follow the peak        a run to +60% then back to +20% is left alone
//   it arms on the PREVIOUS bar        a bar cannot both set the arming high and be stopped on it
//   an armed exit is a `checkpoint`    a protected gain must not be filed as a loss
//   off by default when unset          JOURNAL_ARM_AT_PCT=0 grades exactly as it did before
//
// The third matters beyond bookkeeping: `stop` and `checkpoint` mean opposite things about a
// trade, and the P&L attribution on the journal page reads the reason.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { gradePath, gradeRule } from '../src/momentum/journal/journal.js';

type Bar = { minute: number; high: number; low: number; close: number };

/** A bar whose high and low are both `at`, unless a range is given. */
const bar = (minute: number, high: number, low = high, close = low): Bar => ({ minute, high, low, close });

const PAID = 100;
const CP = { armAt: 0.24, lock: 0.02 };

describe('gradePath: the checkpoint', () => {
  it('leaves the trade alone until the arming level is reached', () => {
    // Never gets above +20%, so the checkpoint never arms and the original −50% stop is what holds.
    const bars = [bar(1, 118), bar(2, 120), bar(3, 105, 60), bar(4, 104)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'close');
    assert.ok(r.pct > -0.5, 'a dip to −40% must not close a trade that never armed');
  });

  it('moves the stop to the lock level once armed, and files it as a checkpoint', () => {
    const bars = [bar(1, 130), bar(2, 128), bar(3, 120, 101), bar(4, 118)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'checkpoint');
    assert.equal(r.pct, 0.02);
    assert.equal(r.minute, 3);
  });

  it('does NOT follow the peak — a deep pullback that stays above the lock is not cut', () => {
    // Runs to +60%, falls back to +20%, recovers. A trail would have sold the retrace.
    const bars = [bar(1, 160), bar(2, 140, 120), bar(3, 150), bar(4, 155, 150, 152)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'close');
    assert.ok(r.pct > 0.5, `expected the trade to run on, got ${r.pct}`);
  });

  it('arms on the peak BEFORE the bar, so one bar cannot both arm and trigger it', () => {
    // This single bar reaches +30% (which would arm) and also trades down to +1% (which would
    // trigger the armed stop). In the real session the stop had not moved yet, so the −50% stop
    // is what was in force and the trade survives.
    const bars = [bar(1, 130, 101, 110), bar(2, 112)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'close', 'a bar must not be stopped on a checkpoint it armed itself');
    assert.equal(r.minute, 2);
  });

  it('still resolves an ambiguous bar as the stop once genuinely armed', () => {
    // Bar 2 arms nothing new; bar 3 touches both the +80% target and the armed +2% stop.
    const bars = [bar(1, 130), bar(2, 128), bar(3, 185, 101)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'checkpoint', 'stop wins any minute that could have gone either way');
    assert.equal(r.pct, 0.02);
  });

  it('lets the target win when the bar never reaches the armed stop', () => {
    const bars = [bar(1, 130), bar(2, 185, 170)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'target');
    assert.equal(r.pct, 0.80);
  });

  it('grades identically to the old two-level rule when no checkpoint is passed', () => {
    const bars = [bar(1, 130), bar(2, 128), bar(3, 120, 101), bar(4, 118, 118, 118)];
    const withOut = gradePath(bars, PAID, 0, 0.80, 0.50, 360);
    assert.equal(withOut.out, 'close');
    assert.equal(+withOut.pct.toFixed(4), 0.18);
  });

  it('treats armAt of 0 as switched off', () => {
    const bars = [bar(1, 130), bar(2, 120, 101), bar(3, 118, 118, 118)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, { armAt: 0, lock: 0.02 });
    assert.equal(r.out, 'close', 'armAt 0 must not arm on the entry itself');
  });

  it('records the excursions whatever the checkpoint does', () => {
    const bars = [bar(1, 130, 95), bar(2, 140, 101)];
    const r = gradePath(bars, PAID, 0, 0.80, 0.50, 360, CP);
    assert.equal(r.out, 'checkpoint');
    assert.equal(+r.mae.toFixed(4), -0.05);
    assert.equal(r.maeMinute, 1);

    // The exit bar's HIGH still counts toward the excursion, even though the trade left on that
    // same bar's low. That is deliberate and predates the checkpoint: `mfePct` is "the best the
    // contract traded while this position was notionally open", inclusive of the closing bar, and
    // every archived row was written under that definition. The ARMING test is the one that must
    // not see it, and does not — it reads the peak as of the previous bar, which the
    // "arms on the peak BEFORE the bar" case above pins down.
    assert.equal(+r.mfe.toFixed(4), 0.40);
    assert.equal(r.mfeMinute, 2);
  });
});

describe('gradeRule: lock beside the existing trail', () => {
  it('parks the stop at a fixed level rather than trailing it', () => {
    const bars = [bar(1, 160), bar(2, 140, 103), bar(3, 150, 150, 150)];
    const locked = gradeRule(bars, PAID, 0, { name: 'lock', tp: 0.80, sl: 0.50, armAt: 0.24, lock: 0.02 }, 360);
    assert.equal(locked.out, 'close', 'a fixed +2% stop is nowhere near a pullback to +3%');

    const trailed = gradeRule(bars, PAID, 0, { name: 'trail', tp: 0.80, sl: 0.50, armAt: 0.24, trail: 0.15 }, 360);
    assert.equal(trailed.out, 'stop', 'a 15-point trail from +60% sells the same pullback');
  });

  it('prefers lock over trail when a rule carries both', () => {
    const bars = [bar(1, 160), bar(2, 140, 103), bar(3, 150, 150, 150)];
    const r = gradeRule(bars, PAID, 0, { name: 'both', tp: 0.80, sl: 0.50, armAt: 0.24, lock: 0.02, trail: 0.15 }, 360);
    assert.equal(r.out, 'close');
  });
});
