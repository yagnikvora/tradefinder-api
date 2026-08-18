// The conviction layer — the part that decides whether a stock is having a ONE-SIDED DAY.
//
// These tests guard a failure mode that is invisible on screen and expensive in the market:
// a shape that looks one-sided without the stock having gone anywhere. Every reading in
// `conviction.service.ts` except displacement describes HOW a stock got where it went, and
// each of them is at its most flattering on a stock that did not move at all — perfect VWAP
// adherence, no crossings, a tiny deepest-pullback (because there was nothing to pull back
// from). Measured against real data before the displacement gate existed, INFY closed
// 2026-08-05 at +0.02% and reached `Confirmed` with a peak conviction of 98.
//
// The other property pinned here is HYSTERESIS. A phase that promotes and demotes on the same
// reading produces a board that flickers, and a flickering trend-day list is worse than none:
// it invites entering the same name four times on what is really one signal. So promotion
// requires sustained evidence and demotion requires sustained failure, and both are asserted
// rather than trusted to the thresholds looking sensible.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeConviction, convictionFactor, convictionSummary, segmentStructure, spineVwapSlope,
} from '../src/momentum/services/conviction.service.js';
import { buildSignal } from '../src/momentum/engine/signal.service.js';
import { computePulse, pulseFactor } from '../src/momentum/services/pulse.service.js';
import { observe, type SessionState } from '../src/momentum/data/session-state.js';
import { defaultConfig } from '../src/momentum/config/defaults.js';
import { SESSION_MINUTES } from '../src/momentum/session.js';
import type { MomentumQuote } from '../src/momentum/data/quotes.js';
import type { SymbolBaseline } from '../src/momentum/data/baseline.js';
import type { ConvictionReading, MomentumConfig } from '../src/momentum/types.js';

/* --------------------------------------------------------------------- fixtures --- */

/** 11:30 IST — minute 135 of the session, comfortably past the confirmation window. */
const NOW = Date.UTC(2026, 6, 31, 6, 0);
const MINUTE = 60_000;
/** The series starts here so `fromMinute <= 5` and the read is not flagged partial. */
const START_MINUTE = 5;

/** ATR of ₹2 on a ₹100 stock — a 2% average day, ordinary for an F&O name. */
const baseline = (over: Partial<SymbolBaseline> = {}): SymbolBaseline => ({
  symbol: 'TEST',
  profile: Array.from({ length: SESSION_MINUTES + 1 }, (_, m) => m * 1000),
  profileSessions: 20, avgDailyVolume: 375_000, avgDailyValueCr: 37.5,
  atr: 2, atrPct: 2, atrPeriod: 14, hv20: 30, hv252: 28, hvRank: 50, beta: 1,
  priorHigh: 105, priorLow: 95, prevHigh: 101, prevLow: 99, prevClose: 100,
  prevFuturesOi: null, dailyBars: 200, ...over,
});

/**
 * A symbol the daily build never covered.
 *
 * Expressed as an ATR of zero rather than as an absent record because that is what the reading
 * layer actually tests — `baseline?.atr && baseline.atr > 0 ? baseline.atr : null` — so a symbol
 * missing from the map and a symbol whose ATR came back zero arrive at the same place, and this
 * spelling survives being passed through a parameter that has a default.
 */
const noAtr = (): SymbolBaseline => baseline({ atr: 0, atrPct: 0 });

interface Replay {
  final: ConvictionReading;
  series: ConvictionReading[];
  state: SessionState;
}

/**
 * Feed a per-minute price path through the real accumulators, one cycle at a time.
 *
 * Deliberately drives `observe()` rather than hand-building a `SessionShape`: the crossing
 * count and the VWAP-side buffer live in that function, and a fixture that constructs the
 * shape directly would test the scoring while assuming the measurement it depends on.
 *
 * The phase machine is stateful and advances once per call, so `computeConviction` is invoked
 * on every step. Calling it only at the end would leave every phase at `None` no matter what
 * the path did, and the test would pass by measuring nothing.
 */
function replay(
  prices: number[],
  vwapAt: (i: number, prices: number[]) => number,
  cfg: MomentumConfig = defaultConfig(),
  base: SymbolBaseline | undefined = baseline(),
): Replay {
  const state: SessionState = { day: '2026-07-31', symbols: {} };
  const series: ConvictionReading[] = [];
  const startAt = NOW - (prices.length - 1) * MINUTE;

  let high = -Infinity;
  let low = Infinity;

  for (let i = 0; i < prices.length; i++) {
    const at = startAt + i * MINUTE;
    const ltp = prices[i];
    high = Math.max(high, ltp);
    low = Math.min(low, ltp);

    const q: MomentumQuote = {
      symbol: 'TEST', instrumentKey: 'NSE_EQ|X', ltp, prevClose: 100,
      netChange: ltp - 100, changePct: ltp - 100, open: prices[0],
      high, low, volume: (i + 1) * 1000, vwap: vwapAt(i, prices),
      turnoverCr: 50, openInterest: 0, oiDayHigh: 0, oiDayLow: 0,
      totalBuyQty: 0, totalSellQty: 0, bid: ltp - 0.05, ask: ltp + 0.05,
      bidQty: 500, askQty: 500, bidOrders: 5, askOrders: 5, depthCr: 2, hasBook: true, at,
    };

    observe(state, q, cfg.thresholds.trendStructure.openingRangeMinutes, at, base ? base.atr * 0.3 : 0, {
      atr: base?.atr ?? 0,
      vwapSideBufferAtr: cfg.thresholds.conviction.vwapSideBufferAtr,
      spineIntervalMin: cfg.thresholds.conviction.spineIntervalMin,
    });

    series.push(computeConviction(state.symbols.TEST, base, cfg, at));
  }

  return { final: series[series.length - 1], series, state };
}

/** A path of `n` minutes ending at NOW, linear from `from` to `to`, with optional noise. */
function walk(from: number, to: number, n: number, wobble = 0): number[] {
  return Array.from({ length: n }, (_, i) => {
    const base = from + ((to - from) * i) / (n - 1);
    return +(base + (wobble ? (i % 2 === 0 ? wobble : -wobble) : 0)).toFixed(3);
  });
}

/** Minutes from START_MINUTE to 135 inclusive — the full fixture session. */
const FULL = 135 - START_MINUTE + 1;

/* ------------------------------------------------------------------- the sub-reads --- */

describe('spineVwapSlope', () => {
  const sample = (vwaps: number[]) =>
    vwaps.map((vwap, i) => ({ at: NOW + i * 5 * MINUTE, minute: i * 5, ltp: vwap, vwap, high: vwap, low: vwap }));

  it('is positive on a VWAP that keeps rising', () => {
    const s = spineVwapSlope(sample([100, 100.1, 100.2, 100.3, 100.4, 100.5]));
    assert.ok(s !== null && s > 0, 'a rising VWAP must slope up');
  });

  it('is negative on a falling one', () => {
    const s = spineVwapSlope(sample([100.5, 100.4, 100.3, 100.2, 100.1, 100]));
    assert.ok(s !== null && s < 0);
  });

  it('is null before there are enough samples to fit a line', () => {
    assert.equal(spineVwapSlope(sample([100, 100.1])), null);
  });
});

describe('segmentStructure', () => {
  const spine = (ltps: number[]) =>
    ltps.map((ltp, i) => ({ at: NOW + i * 5 * MINUTE, minute: i * 5, ltp, vwap: 100, high: ltp, low: ltp }));

  it('counts successive parts of the day making higher lows', () => {
    const rising = spine([100, 101, 100.5, 102, 101.5, 103, 102.5, 104, 103.5, 105, 104.5, 106]);
    const run = segmentStructure(rising, true);
    assert.ok(run !== null && run >= 2, `expected a run of rising segment lows, got ${run}`);
  });

  it('reports zero once the most recent segment breaks the run', () => {
    // Rising for most of the day and then a decisive break lower at the end.
    const broken = spine([100, 101, 102, 103, 104, 105, 106, 107, 99, 98, 97, 96]);
    assert.equal(segmentStructure(broken, true), 0);
  });

  it('is null before there is enough spine to segment', () => {
    assert.equal(segmentStructure(spine([100, 101, 102]), true), null);
  });
});

/* ------------------------------------------------------------------ the measurement --- */

describe('computeConviction', () => {
  it('scores a clean one-sided up day highly and calls it Bullish', () => {
    // Walks 100 → 103 with VWAP trailing below it the whole way.
    const prices = walk(100, 103, FULL, 0.02);
    const r = replay(prices, (i, p) => p[i] - 0.3).final;

    assert.equal(r.ready, true);
    assert.equal(r.direction, 'Bullish');
    assert.ok(r.score >= 70, `expected a strong conviction, got ${r.score}`);
    assert.ok((r.vwapAdherence ?? 0) >= 0.9, `adherence was ${r.vwapAdherence}`);
    assert.equal(r.vwapCrossings, 0);
    assert.ok((r.displacementAtr ?? 0) >= 1.4, `displacement was ${r.displacementAtr}`);
  });

  it('scores a chopping day low, and counts the crossings that make it one', () => {
    // Oscillates either side of a flat VWAP, ending where it started.
    const prices = Array.from({ length: FULL }, (_, i) => +(100 + Math.sin(i / 3) * 1.5).toFixed(3));
    const r = replay(prices, () => 100).final;

    assert.ok((r.vwapCrossings ?? 0) >= 8, `expected many crossings, got ${r.vwapCrossings}`);
    assert.ok(r.score < 50, `chop must not score as a trend day, got ${r.score}`);
    assert.equal(r.phase, 'None');
  });

  // THE REGRESSION TEST. Every shape reading is perfect here and the stock went nowhere.
  it('refuses a flat stock whose SHAPE is flawless — the INFY case', () => {
    // 100.00 → 100.04 over two hours, sitting clear of VWAP the whole way. Perfect adherence,
    // zero crossings, no meaningful pullback — and 0.02 ATR of travel.
    //
    // VWAP is held well below rather than just under price, because the side buffer
    // (`vwapSideBufferAtr`) means a stock pinned INSIDE 0.05 ATR of its VWAP has no side at
    // all and is excluded before scoring — a second, independent guard against this shape. The
    // point here is the case that gets past that one: clearly on a side, and going nowhere.
    const prices = walk(100, 100.04, FULL);
    const r = replay(prices, () => 99.5).final;

    assert.ok((r.vwapAdherence ?? 0) >= 0.99, 'the fixture must have flawless adherence');
    assert.equal(r.vwapCrossings, 0, 'the fixture must have no crossings');
    assert.ok(
      Math.abs(r.displacementAtr ?? 0) < 0.5,
      `the fixture must not have displaced, got ${r.displacementAtr}`,
    );

    assert.equal(
      r.phase,
      'None',
      `a stock that has not moved is not having a trend day whatever its shape scores (score ${r.score})`,
    );
  });

  it('cuts a gap-up-and-bleed, where the VWAP side and the move disagree', () => {
    // Opens high after a gap and falls all session, but the gap drags VWAP up so price stays
    // above it. Reads bullish on adherence alone and is the opposite of a call buy.
    const prices = walk(104, 101, FULL);
    const r = replay(prices, (i, p) => p[i] - 0.5).final;

    assert.ok((r.vwapAdherence ?? 0) >= 0.9, 'the fixture must sit above VWAP throughout');
    assert.ok(
      r.note?.includes('moving the other way'),
      `expected the disagreement to be stated, got: ${r.note}`,
    );
    assert.ok(r.score < 60, `a faded gap must not read as a strong trend day, got ${r.score}`);
  });

  it('reports a mid-day restart as partial rather than as a full-day read', () => {
    const cfg = defaultConfig();
    const prices = walk(100, 103, 40); // 40 minutes, ending at NOW — so it began at minute 96
    const r = replay(prices, (i, p) => p[i] - 0.3, cfg).final;

    assert.equal(r.partial, true);
    assert.ok(r.fromMinute > 5, `fromMinute was ${r.fromMinute}`);
    assert.ok(r.note?.includes('minute'), 'a partial read must say where the record starts');
  });

  it('votes directionally as a factor once the shape is measurable', () => {
    const cfg = defaultConfig();
    const up = replay(walk(100, 103, FULL, 0.02), (i, p) => p[i] - 0.3, cfg).final;
    const down = replay(walk(103, 100, FULL, 0.02), (i, p) => p[i] + 0.3, cfg).final;

    const fUp = convictionFactor(up, cfg);
    const fDown = convictionFactor(down, cfg);

    assert.equal(fUp.available, true);
    assert.equal(fUp.weight, cfg.weights.trendQuality);
    assert.ok((fUp.score ?? 0) >= 70, `expected a strong score, got ${fUp.score}`);
    assert.ok(fUp.bias > 0, 'a one-sided up day must vote bullish');
    assert.ok(fDown.bias < 0, 'a one-sided down day must vote bearish');
  });

  it('is unavailable as a factor before the shape means anything, not zero', () => {
    const cfg = defaultConfig();
    const r = replay([100, 100.1], (i, p) => p[i], cfg).final;
    const f = convictionFactor(r, cfg);

    assert.equal(f.available, false);
    assert.equal(f.score, null, 'an unmeasured factor must drop out of the weighting, not score 0');
    assert.ok(f.note && f.note.length > 0);
  });
});

/* --------------------------------------------------------------- the phase machine --- */

describe('trend phase machine', () => {
  it('promotes None → Forming → Confirmed, in that order, over time', () => {
    const prices = walk(100, 103, FULL, 0.02);
    const { series } = replay(prices, (i, p) => p[i] - 0.3);

    const firstForming = series.findIndex((r) => r.phase === 'Forming');
    const firstConfirmed = series.findIndex((r) => r.phase === 'Confirmed');

    assert.ok(firstForming > 0, 'the day must pass through Forming');
    assert.ok(firstConfirmed > firstForming, 'Confirmed must come after Forming, never instead of it');
    assert.equal(series[series.length - 1].phase, 'Confirmed');
  });

  it('records the conviction reading at the instant of confirmation', () => {
    const prices = walk(100, 103, FULL, 0.02);
    const { series } = replay(prices, (i, p) => p[i] - 0.3);

    const i = series.findIndex((r) => r.phase === 'Confirmed');
    assert.ok(i > 0, 'the fixture must reach Confirmed');

    const at = series[i].convictionAtConfirm;
    assert.ok(at !== null, 'a confirmed row must carry the score it was confirmed on');
    assert.ok(
      Math.abs(at - series[i].score) < 0.1,
      `recorded ${at} but the reading scored ${series[i].score}`,
    );

    // Null right up to the promotion — there is no call to describe before one is made.
    assert.ok(series.slice(0, i).every((r) => r.convictionAtConfirm === null));
  });

  // The one that would break if this were recomputed per cycle rather than captured once.
  // `setPhase` returns early when the phase is unchanged, so a row that stays Confirmed for
  // four hours keeps the score it was confirmed ON — not whatever it happens to read now.
  it('freezes that reading while the score keeps moving', () => {
    const prices = walk(100, 103, FULL, 0.02);
    const { series } = replay(prices, (i, p) => p[i] - 0.3);

    const i = series.findIndex((r) => r.phase === 'Confirmed');
    const at = series[i].convictionAtConfirm;
    const after = series.slice(i);

    assert.ok(after.every((r) => r.convictionAtConfirm === at), 'the confirmation score must not drift');
    // And it is a different fact from `peak`, which keeps climbing after the call.
    const last = series[series.length - 1];
    assert.ok(last.peak >= (at ?? 0), 'peak is the best of the day, so it cannot be below the call');
  });

  it('keeps the confirmation score after the row fades', () => {
    const cfg = defaultConfig();
    const prices = [...walk(100, 103, FULL - 30, 0.02), ...walk(103, 99.5, 30, 0.02)];
    const { series } = replay(prices, (i, p) => Math.max(...p.slice(0, i + 1)) + 0.1, cfg);

    const i = series.findIndex((r) => r.phase === 'Confirmed');
    if (i < 0) return; // this fixture is about the carry-over, not about forcing a confirmation
    const at = series[i].convictionAtConfirm;

    const faded = series.slice(i).filter((r) => r.phase === 'Faded');
    assert.ok(
      faded.every((r) => r.convictionAtConfirm === at),
      'once demoted, this and confirmedAt are the only record of when and how the day was called',
    );
  });

  // 2026-08-13. The process ran a window with no baseline at all, so every symbol's ATR was
  // absent and `displacementAtr` came back null. The gate read null as "nothing disqualifying
  // here" and let it through, the score fell back to the six shape components that need no ATR,
  // and seventeen stocks confirmed in a single tick on VWAP adherence alone — three of them
  // reading an identical 74. Every one of those alerts went out with no stop, no target, no
  // contract and no lot, because the same missing ATR stops `buildPlan` dead.
  //
  // The path below is the strongest trend day in this file. With a baseline it confirms; without
  // one it must not, because nothing here can tell the difference between this and INFY drifting
  // 0.02% while pinned to one side of its VWAP.
  it('offers no phase at all when there is no ATR to measure displacement against', () => {
    const prices = walk(100, 103, FULL, 0.02);
    const vwap = (i: number, p: number[]) => p[i] - 0.3;

    const withBaseline = replay(prices, vwap).series;
    assert.equal(withBaseline[withBaseline.length - 1].phase, 'Confirmed', 'the fixture must confirm normally');

    const { series } = replay(prices, vwap, defaultConfig(), noAtr());
    const final = series[series.length - 1];

    assert.equal(final.displacementAtr, null, 'no baseline means no displacement reading');
    assert.equal(final.deepestPullbackAtr, null, 'nor a pullback depth');
    assert.ok(
      series.every((r) => r.phase === 'None'),
      `no phase may be offered on an unmeasurable day, reached ${[...new Set(series.map((r) => r.phase))].join(', ')}`,
    );
  });

  // And the board has to say WHY it is silent. "Not one-sided" is a verdict about the day; this
  // day was never read at all, and the two want opposite responses from whoever is looking.
  it('names the missing baseline rather than calling the day not one-sided', () => {
    const { series } = replay(walk(100, 103, FULL, 0.02), (i, p) => p[i] - 0.3, defaultConfig(), noAtr());
    const summary = convictionSummary(series[series.length - 1]);

    assert.match(summary.summary, /No ATR baseline/);
    assert.equal(summary.summary.includes('Not one-sided'), false);
  });

  it('will not confirm before the configured minute of session, however good the shape', () => {
    const cfg = defaultConfig();
    const prices = walk(100, 103, FULL, 0.02);
    const { series } = replay(prices, (i, p) => p[i] - 0.3, cfg);

    // Each reading is one minute apart ending at minute 135, so the minute of a reading is
    // its index plus START_MINUTE.
    for (let i = 0; i < series.length; i++) {
      if (series[i].phase !== 'Confirmed') continue;
      assert.ok(
        i + START_MINUTE >= cfg.thresholds.conviction.phase.minMinutesConfirmed,
        `confirmed at minute ${i + START_MINUTE}, before the ${cfg.thresholds.conviction.phase.minMinutesConfirmed} floor`,
      );
      break;
    }
  });

  it('does not demote a confirmed day on one deep breath — the anti-churn valve', () => {
    const cfg = defaultConfig();
    // A clean trend, then a single sharp dip lasting well under `fadeHoldMin`, then resumption.
    const prices = [...walk(100, 103, FULL - 12, 0.02), 102.4, 101.9, 101.6, 102.1, 102.6, 103.0,
      103.1, 103.2, 103.3, 103.4, 103.5, 103.6];
    const { series } = replay(prices, (i, p) => Math.min(...p.slice(0, i + 1)) - 0.1, cfg);

    const confirmedAt = series.findIndex((r) => r.phase === 'Confirmed');
    assert.ok(confirmedAt > 0, 'the fixture must reach Confirmed first');

    const after = series.slice(confirmedAt);
    assert.ok(
      after.every((r) => r.phase === 'Confirmed'),
      'a brief dip inside fadeHoldMin must not demote a confirmed day',
    );
  });

  it('demotes to Faded when the shape fails for longer than fadeHoldMin', () => {
    const cfg = defaultConfig();
    // Trends up, then rolls over hard and stays rolled over for the rest of the session.
    const prices = [...walk(100, 103, FULL - 40, 0.02), ...walk(103, 99.5, 40)];
    const { series } = replay(prices, (i, p) => p[Math.max(0, i - 20)] - 0.1, cfg);

    assert.ok(series.some((r) => r.phase === 'Confirmed'), 'the fixture must reach Confirmed first');
    assert.ok(
      series.some((r) => r.phase === 'Faded'),
      'a trend day that comprehensively breaks must end up Faded',
    );
  });

  it('keeps the peak so a faded day can still say what it once was', () => {
    const cfg = defaultConfig();
    const prices = [...walk(100, 103, FULL - 40, 0.02), ...walk(103, 99.5, 40)];
    const { final } = replay(prices, (i, p) => p[Math.max(0, i - 20)] - 0.1, cfg);

    assert.ok(final.peak > final.score, `peak ${final.peak} should exceed the faded score ${final.score}`);
  });
});

/* ------------------------------------------------------- the extension consequences --- */

describe('trend-day extension budget', () => {
  /** Build a signal for the last reading of a replay. */
  function signalAt(r: Replay, cfg: MomentumConfig, prices: number[]) {
    const base = baseline();
    const sym = r.state.symbols.TEST;
    const ltp = prices[prices.length - 1];
    const q: MomentumQuote = {
      symbol: 'TEST', instrumentKey: 'NSE_EQ|X', ltp, prevClose: 100, netChange: ltp - 100,
      changePct: ltp - 100, open: prices[0], high: Math.max(...prices), low: Math.min(...prices),
      volume: prices.length * 1000, vwap: ltp - 0.3, turnoverCr: 50, openInterest: 0,
      oiDayHigh: 0, oiDayLow: 0, totalBuyQty: 0, totalSellQty: 0, bid: ltp - 0.05, ask: ltp + 0.05,
      bidQty: 500, askQty: 500, bidOrders: 5, askOrders: 5, depthCr: 2, hasBook: true, at: NOW,
    };
    const pulse = computePulse(q, sym, base, cfg, NOW);
    return buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: base,
      openingRange: sym?.openingRange ?? null, greeks: null, chain: null, lotSize: null,
      direction: 'Bullish', conviction: r.final, liquidityScore: 100, config: cfg, nowMs: NOW,
    });
  }

  it('withdraws the range ceiling on a confirmed day, so a 2+ ATR trend is not "spent"', () => {
    const cfg = defaultConfig();
    // 100 → 105 is 2.5 ATR of intraday range — comfortably past the ordinary 0.8 ceiling,
    // which is what marked BOSCHLTD and NHPC spent by mid-morning.
    const prices = walk(100, 105, FULL, 0.02);
    const r = replay(prices, (i, p) => p[i] - 0.3, cfg);

    assert.equal(r.final.phase, 'Confirmed', 'the fixture must be a confirmed trend day');

    const s = signalAt(r, cfg, prices);
    assert.ok(
      (s.extension.atrUsed ?? 0) > cfg.signal.extension.atrUsedMax,
      'the fixture must exceed the ordinary ceiling, or it proves nothing',
    );
    assert.notEqual(s.state, 'Extended', 'a confirmed trend day must not read as spent on range alone');
    assert.equal(s.extension.budgetMultiplier, cfg.signal.trend.budgetMultiplier.confirmed);
  });

  it('excludes the opening gap from the range budget — the NHPC case', () => {
    const cfg = defaultConfig();
    // Gaps a full ATR from the previous close and then barely moves. True range says the day
    // is spent; intraday range says nothing has happened yet, and the second is the one an
    // entry taken now has to compete with.
    const prices = walk(102, 102.2, FULL);
    const r = replay(prices, () => 102.05, cfg);
    const s = signalAt(r, cfg, prices);

    assert.ok(
      (s.extension.trueRangeAtrUsed ?? 0) > (s.extension.atrUsed ?? 0),
      'true range must exceed intraday range when the stock gapped',
    );
    assert.ok((s.extension.atrUsed ?? 1) < 0.3, `intraday range should be small, got ${s.extension.atrUsed}`);
  });

  it('leaves an ordinary session on the original ceilings', () => {
    const cfg = defaultConfig();
    const prices = Array.from({ length: FULL }, (_, i) => +(100 + Math.sin(i / 3) * 1.5).toFixed(3));
    const r = replay(prices, () => 100, cfg);

    assert.equal(r.final.phase, 'None', 'the fixture must not be a trend day');

    const s = signalAt(r, cfg, prices);
    assert.equal(s.extension.budgetMultiplier, 1, 'a non-trend day gets no concession');
    assert.equal(s.extension.atrUsedMax, cfg.signal.extension.atrUsedMax);
  });
});
