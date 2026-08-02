// The per-factor maths and the statistics the daily baseline is built from.
//
// These are the functions where a plausible-looking mistake produces a plausible-looking
// board: an ATR that ignores gaps, a mean where a median was needed, a delta shift that
// exceeds what delta can do. Each test below names the failure it is guarding against.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  beta, cumulativeProfile, median, medianProfile, percentileRank, realisedVolatility, wilderAtr,
} from '../src/momentum/data/baseline.js';
import { classifyBuildUp, maxPainStrike } from '../src/momentum/services/option-analytics.service.js';
import { deltaAtPreviousSpot, expectedMoveFrom } from '../src/momentum/services/greeks.service.js';
import { ivRankFrom } from '../src/momentum/services/iv.service.js';
import { spreadBps, gradeLiquidity } from '../src/momentum/services/liquidity.service.js';
import { gradeRvol, computeRvol } from '../src/momentum/services/rvol.service.js';
import { trueRange } from '../src/momentum/services/atr.service.js';
import { computeRelativeStrength } from '../src/momentum/services/relative-strength.service.js';
import { computeSector } from '../src/momentum/services/sector.service.js';
import { vwapSlopePctPerMin, intervalVwap } from '../src/momentum/data/session-state.js';
import { candleMinute, minuteOfSession, SESSION_MINUTES } from '../src/momentum/session.js';
import { noteRefusal, resetBreakers, throttledFor, assertNotThrottled } from '../src/momentum/data/throttle.js';
import { defaultConfig } from '../src/momentum/config/defaults.js';
import type { StockChain, ChainRow, ChainLeg } from '../src/momentum/data/option-chain.js';
import type { MomentumQuote } from '../src/momentum/data/quotes.js';
import type { SymbolBaseline } from '../src/momentum/data/baseline.js';

/* --------------------------------------------------------------------- helpers --- */

const leg = (over: Partial<ChainLeg> = {}): ChainLeg => ({
  instrumentKey: 'NSE_FO|1', ltp: 10, closePrice: 10, volume: 0, oi: 0, prevOi: 0,
  bid: 9.9, ask: 10.1, bidQty: 100, askQty: 100,
  delta: 0.5, gamma: 0.01, theta: -1, vega: 1, iv: 20, ...over,
});

const quote = (over: Partial<MomentumQuote> = {}): MomentumQuote => ({
  symbol: 'TEST', instrumentKey: 'NSE_EQ|X', ltp: 100, prevClose: 100, netChange: 0, changePct: 0,
  open: 100, high: 100, low: 100, volume: 0, vwap: 100, turnoverCr: 0,
  openInterest: 0, oiDayHigh: 0, oiDayLow: 0, totalBuyQty: 0, totalSellQty: 0,
  bid: 0, ask: 0, bidQty: 0, askQty: 0, bidOrders: 0, askOrders: 0,
  depthCr: 0, hasBook: false, at: 0, ...over,
});

/* --------------------------------------------------------------------- median --- */

describe('median', () => {
  it('is the middle of an odd list and the mean of the middle two of an even one', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it('does not reorder the caller’s array', () => {
    const input = [3, 1, 2];
    median(input);
    assert.deepEqual(input, [3, 1, 2]);
  });

  it('ignores an outlier the way a mean cannot', () => {
    // The reason the volume profile is a median: one results day at 8x normal volume must
    // not raise a stock's own benchmark for the next month.
    const normal = [100, 105, 98, 102, 101];
    const withSpike = [...normal, 800];
    assert.ok(Math.abs(median(withSpike) - median(normal)) < 5);
    const meanShift = withSpike.reduce((a, b) => a + b, 0) / withSpike.length
      - normal.reduce((a, b) => a + b, 0) / normal.length;
    assert.ok(meanShift > 100, 'a mean would have moved a long way');
  });

  it('returns 0 for an empty list rather than NaN', () => {
    assert.equal(median([]), 0);
  });
});

/* ------------------------------------------------------------------ wilderAtr --- */

describe('wilderAtr', () => {
  it('counts the gap, which a high−low average does not', () => {
    // Both series have identical intraday ranges. The second gaps 8 points every session.
    const flat = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
    const gapping = Array.from({ length: 20 }, (_, i) => ({
      high: 100 + i * 8 + 2, low: 100 + i * 8 - 2, close: 100 + i * 8,
    }));
    const atrFlat = wilderAtr(flat, 14);
    const atrGap = wilderAtr(gapping, 14);
    assert.ok(atrGap > atrFlat * 2, `gapping ATR ${atrGap} should dwarf flat ${atrFlat}`);
  });

  it('returns 0 rather than a partial average when there are too few bars', () => {
    assert.equal(wilderAtr([{ high: 1, low: 0, close: 0.5 }], 14), 0);
  });

  it('equals the true range on a constant series', () => {
    const bars = Array.from({ length: 30 }, () => ({ high: 105, low: 95, close: 100 }));
    assert.ok(Math.abs(wilderAtr(bars, 14) - 10) < 1e-9);
  });
});

describe('trueRange', () => {
  it('is high−low with no gap', () => {
    assert.equal(trueRange(105, 95, 100), 10);
  });

  it('takes the gap when the gap is bigger', () => {
    // Closed at 100, opened and traded 108–110: the move is 10, not 2.
    assert.equal(trueRange(110, 108, 100), 10);
  });
});

/* ------------------------------------------------------- realised volatility --- */

describe('realisedVolatility', () => {
  it('is zero for a flat series', () => {
    assert.equal(realisedVolatility([100, 100, 100, 100]), 0);
  });

  it('rises with dispersion', () => {
    const calm = [100, 100.1, 99.9, 100.2, 100.05, 99.95];
    const wild = [100, 108, 94, 110, 92, 105];
    assert.ok(realisedVolatility(wild) > realisedVolatility(calm) * 5);
  });

  it('is annualised — a 1% daily move is roughly 16% a year', () => {
    const alternating = Array.from({ length: 60 }, (_, i) => 100 * (i % 2 ? 1.01 : 1));
    const v = realisedVolatility(alternating);
    assert.ok(v > 10 && v < 25, `expected roughly 16%, got ${v}`);
  });

  it('returns 0 rather than NaN on a series too short to measure', () => {
    assert.equal(realisedVolatility([100]), 0);
    assert.equal(realisedVolatility([]), 0);
  });
});

/* ----------------------------------------------------------------------- beta --- */

describe('beta', () => {
  it('is 1 when the asset tracks the market exactly', () => {
    const market = Array.from({ length: 60 }, (_, i) => 100 * 1.001 ** i * (1 + 0.01 * Math.sin(i)));
    assert.ok(Math.abs((beta(market, market) as number) - 1) < 1e-6);
  });

  it('is 2 when the asset moves twice as far', () => {
    const market = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i * 1.7)));
    const levered = market.map((p) => 100 * (p / 100) ** 2);
    const b = beta(levered, market) as number;
    assert.ok(Math.abs(b - 2) < 0.05, `expected ~2, got ${b}`);
  });

  it('returns null rather than a meaningless figure on a short series', () => {
    assert.equal(beta([1, 2, 3], [1, 2, 3]), null);
  });
});

/* -------------------------------------------------------------- percentiles --- */

describe('percentileRank', () => {
  it('is the share of the series that sits below the value', () => {
    assert.equal(percentileRank(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 40);
    assert.equal(percentileRank(0, [1, 2, 3, 4]), 0);
    assert.equal(percentileRank(99, [1, 2, 3, 4]), 100);
  });

  it('returns null on a series too short to rank within', () => {
    assert.equal(percentileRank(5, [1]), null);
  });
});

describe('ivRankFrom', () => {
  it('is the position between the low and the high, which is NOT the percentile', () => {
    // The distinction that gets mixed up: eleven months at 18, one week at 60. A reading of
    // 20 is near the bottom of the RANGE but above most SESSIONS.
    const history = [...Array(240).fill(18), ...Array(5).fill(60)];
    const rank = ivRankFrom(20, history) as number;
    const pct = percentileRank(20, history) as number;
    assert.ok(rank < 10, `rank should be low, got ${rank}`);
    assert.ok(pct > 90, `percentile should be high, got ${pct}`);
  });

  it('returns null when the history never moved', () => {
    assert.equal(ivRankFrom(20, [20, 20, 20]), null);
  });
});

/* ------------------------------------------------------------ volume profile --- */

describe('cumulativeProfile', () => {
  const bar = (minute: number, volume: number) => ({
    stamp: '', day: '2026-07-31', minute, open: 1, high: 1, low: 1, close: 1, volume, openInterest: 0,
  });

  it('accumulates and is monotonic', () => {
    const p = cumulativeProfile([bar(0, 100), bar(1, 50), bar(2, 25)]);
    assert.equal(p[0], 100);
    assert.equal(p[1], 150);
    assert.equal(p[2], 175);
    for (let i = 1; i < p.length; i++) assert.ok(p[i] >= p[i - 1], `dipped at minute ${i}`);
  });

  it('forward-fills a minute with no print instead of dropping to zero', () => {
    // A hole in the denominator would make RVOL divide by nothing at that minute.
    const p = cumulativeProfile([bar(0, 100), bar(5, 50)]);
    assert.equal(p[3], 100);
    assert.equal(p[5], 150);
  });

  it('covers the whole session and ignores out-of-session prints', () => {
    const p = cumulativeProfile([bar(-5, 999), bar(0, 10), bar(9999, 999)]);
    assert.equal(p.length, SESSION_MINUTES + 1);
    assert.equal(p[SESSION_MINUTES], 10);
  });
});

describe('medianProfile', () => {
  it('takes the median at each minute independently', () => {
    const p = medianProfile([
      cumulativeProfile([{ stamp: '', day: 'd', minute: 0, open: 1, high: 1, low: 1, close: 1, volume: 10, openInterest: 0 }]),
      cumulativeProfile([{ stamp: '', day: 'd', minute: 0, open: 1, high: 1, low: 1, close: 1, volume: 20, openInterest: 0 }]),
      cumulativeProfile([{ stamp: '', day: 'd', minute: 0, open: 1, high: 1, low: 1, close: 1, volume: 300, openInterest: 0 }]),
    ]);
    assert.equal(p[0], 20, 'the 300-volume session must not drag the benchmark up');
  });

  it('returns a zeroed profile rather than throwing when there are no sessions', () => {
    const p = medianProfile([]);
    assert.equal(p.length, SESSION_MINUTES + 1);
    assert.equal(p[0], 0);
  });
});

/* ----------------------------------------------------------------------- RVOL --- */

describe('computeRvol', () => {
  const cfg = defaultConfig();
  const baseline = (profile: number[]): SymbolBaseline => ({
    symbol: 'TEST', profile, profileSessions: 20, avgDailyVolume: 1000, avgDailyValueCr: 10,
    atr: 1, atrPct: 1, atrPeriod: 14, hv20: 20, hv252: 20, hvRank: 50, beta: 1,
    priorHigh: 0, priorLow: 0, prevHigh: 0, prevLow: 0, prevClose: 100, prevFuturesOi: null, dailyBars: 100,
  });

  it('divides today’s cumulative volume by the profile at THIS minute', () => {
    const profile = new Array(SESSION_MINUTES + 1).fill(0).map((_, m) => m * 100);
    const r = computeRvol(quote({ volume: 4_800 }), baseline(profile), 10, cfg);
    assert.equal(r.rvol, 4.8, '4800 against a 1000 benchmark at minute 10');
    assert.equal(r.grade, 'Excellent');
  });

  it('is time-of-day aware — the same volume reads differently early and late', () => {
    const profile = new Array(SESSION_MINUTES + 1).fill(0).map((_, m) => m * 100);
    const early = computeRvol(quote({ volume: 10_000 }), baseline(profile), 10, cfg);
    const late = computeRvol(quote({ volume: 10_000 }), baseline(profile), 300, cfg);
    assert.ok((early.rvol as number) > (late.rvol as number));
  });

  it('is null before the session starts rather than infinite', () => {
    const r = computeRvol(quote({ volume: 100 }), baseline(new Array(SESSION_MINUTES + 1).fill(0)), 0, cfg);
    assert.equal(r.rvol, null);
    assert.equal(r.grade, null);
  });

  it('is null with no baseline rather than defaulting to 1', () => {
    const r = computeRvol(quote({ volume: 100 }), undefined, 100, cfg);
    assert.equal(r.rvol, null);
  });

  it('is null when the benchmark at this minute is zero', () => {
    const r = computeRvol(quote({ volume: 100 }), baseline(new Array(SESSION_MINUTES + 1).fill(0)), 100, cfg);
    assert.equal(r.rvol, null, 'dividing by zero would sort Infinity to the top of the board');
  });
});

describe('gradeRvol', () => {
  const t = defaultConfig().thresholds.rvol;
  it('uses the configured bands', () => {
    assert.equal(gradeRvol(4, t), 'Excellent');
    assert.equal(gradeRvol(3.5, t), 'Excellent');
    assert.equal(gradeRvol(2.5, t), 'Good');
    assert.equal(gradeRvol(1.6, t), 'Average');
    assert.equal(gradeRvol(1.0, t), 'Poor');
  });
});

/* ------------------------------------------------------------------ liquidity --- */

describe('spreadBps', () => {
  it('is the full touch as basis points of the mid', () => {
    assert.equal(spreadBps(99.95, 100.05), 10);
  });

  it('is null on a one-sided or crossed book', () => {
    assert.equal(spreadBps(0, 100), null, 'no bid is not a zero spread');
    assert.equal(spreadBps(100, 0), null);
    assert.equal(spreadBps(100.1, 100), null, 'a crossed book is bad data');
  });
});

describe('gradeLiquidity', () => {
  const g = defaultConfig().thresholds.liquidity.grade;
  it('uses the configured cut points', () => {
    assert.equal(gradeLiquidity(85, g), 'Excellent');
    assert.equal(gradeLiquidity(65, g), 'Good');
    assert.equal(gradeLiquidity(45, g), 'Average');
    assert.equal(gradeLiquidity(20, g), 'Poor');
  });
});

/* ---------------------------------------------------------- relative strength --- */

describe('computeRelativeStrength', () => {
  const cfg = defaultConfig();
  const withBeta = (b: number | null): SymbolBaseline => ({
    symbol: 'T', profile: [], profileSessions: 0, avgDailyVolume: 0, avgDailyValueCr: 0,
    atr: 0, atrPct: 0, atrPeriod: 14, hv20: 0, hv252: 0, hvRank: null, beta: b,
    priorHigh: 0, priorLow: 0, prevHigh: 0, prevLow: 0, prevClose: 0, prevFuturesOi: null, dailyBars: 0,
  });

  it('reports the brief’s plain definition', () => {
    // Nifty +0.5%, stock +2% -> +1.5pp.
    const r = computeRelativeStrength(2, 0.5, withBeta(1), cfg);
    assert.equal(r.relativeStrengthPct, 1.5);
  });

  it('scores on beta-adjusted alpha, which discounts the index’s own leverage', () => {
    // A 2.0-beta stock up 2% on a +1% day has done nothing of its own.
    const r = computeRelativeStrength(2, 1, withBeta(2), cfg);
    assert.equal(r.relativeStrengthPct, 1, 'the raw spread still says +1pp');
    assert.equal(r.alphaPct, 0, 'but the alpha is zero');
    assert.equal(r.usedPct, 0);
    assert.equal(r.usedBeta, true);
  });

  it('falls back to the raw spread when beta is unknown, and says so', () => {
    const r = computeRelativeStrength(2, 1, withBeta(null), cfg);
    assert.equal(r.usedBeta, false);
    assert.equal(r.usedPct, 1);
  });

  it('honours useBeta: false in config', () => {
    const raw = { ...cfg, thresholds: { ...cfg.thresholds, relativeStrength: { ...cfg.thresholds.relativeStrength, useBeta: false } } };
    const r = computeRelativeStrength(2, 1, withBeta(2), raw);
    assert.equal(r.usedBeta, false);
    assert.equal(r.usedPct, 1);
  });
});

/* -------------------------------------------------------------------- sector --- */

describe('computeSector', () => {
  it('rewards a rising stock in a leading sector', () => {
    const r = computeSector(3, 'IT', 'NIFTY IT', quote({ changePct: 1.5 }), 0.5);
    assert.ok(r);
    assert.equal(r.sectorVsNiftyPct, 1);
    assert.equal(r.stockVsSectorPct, 1.5);
    assert.ok(r.combinedPct > 0);
  });

  it('reads a FALLING stock in a falling sector as strong bearish confirmation', () => {
    // Signed into the stock's own direction, so short momentum scores as momentum.
    const r = computeSector(-3, 'IT', 'NIFTY IT', quote({ changePct: -1.5 }), -0.5);
    assert.ok(r);
    assert.ok(r.combinedPct < 0, 'the combined read must point bearish, not read as weakness');
  });

  it('is null when the stock has no tradable sector index', () => {
    assert.equal(computeSector(1, null, null, undefined, 0.5), null);
    assert.equal(computeSector(1, 'OTHERS', null, undefined, 0.5), null);
  });

  it('is null without a Nifty reference', () => {
    assert.equal(computeSector(1, 'IT', 'NIFTY IT', quote(), null), null);
  });
});

/* ------------------------------------------------------------------ build-up --- */

describe('classifyBuildUp', () => {
  it('maps the four quadrants of price and open interest', () => {
    assert.equal(classifyBuildUp(2, 5, 0.05), 'Long Build-up');
    assert.equal(classifyBuildUp(-2, 5, 0.05), 'Short Build-up');
    assert.equal(classifyBuildUp(2, -5, 0.05), 'Short Covering');
    assert.equal(classifyBuildUp(-2, -5, 0.05), 'Long Unwinding');
  });

  it('is Neutral inside the deadband on either axis', () => {
    assert.equal(classifyBuildUp(0.01, 5, 0.05), 'Neutral');
    assert.equal(classifyBuildUp(2, 0.01, 0.05), 'Neutral');
  });
});

describe('maxPainStrike', () => {
  it('finds the strike where the most option value expires worthless', () => {
    const rows: ChainRow[] = [
      { strike: 90, call: leg({ oi: 1000 }), put: leg({ oi: 100 }) },
      { strike: 100, call: leg({ oi: 500 }), put: leg({ oi: 500 }) },
      { strike: 110, call: leg({ oi: 100 }), put: leg({ oi: 1000 }) },
    ];
    const chain: StockChain = {
      symbol: 'T', underlyingKey: 'k', expiry: '2026-08-25', expiryDays: 20,
      spot: 100, atmStrike: 100, rows,
    };
    assert.equal(maxPainStrike(chain), 100);
  });

  it('is null on a chain too thin to have a minimum', () => {
    const chain: StockChain = {
      symbol: 'T', underlyingKey: 'k', expiry: 'e', expiryDays: 1, spot: 100, atmStrike: 100,
      rows: [{ strike: 100, call: leg(), put: leg() }],
    };
    assert.equal(maxPainStrike(chain), null);
  });
});

/* -------------------------------------------------------------------- greeks --- */

describe('deltaAtPreviousSpot', () => {
  // A realistic call-delta curve: deep ITM near 1, ATM near 0.5, OTM near 0.
  const chain = (spot: number, atm: number): StockChain => ({
    symbol: 'T', underlyingKey: 'k', expiry: '2026-08-25', expiryDays: 23, spot, atmStrike: atm,
    rows: [80, 90, 100, 110, 120].map((strike) => ({
      strike,
      call: leg({ delta: 1 / (1 + Math.exp((strike - spot) / 6)) }),
      put: leg({ delta: -0.5 }),
    })),
  });

  it('reads a lower delta at a lower previous spot', () => {
    // Spot 110 today, closed at 100 yesterday: the ATM strike was further out of the money
    // then, so its delta was lower.
    const c = chain(110, 110);
    const then = deltaAtPreviousSpot(c, 110, 100) as number;
    const now = (c.rows.find((r) => r.strike === 110)?.call as ChainLeg).delta;
    assert.ok(then < now, `expected yesterday's delta ${then} below today's ${now}`);
  });

  it('produces a shift inside the range delta can actually move', () => {
    // The bug this replaced: gamma × an 8% move returned a delta shift of +0.48, which an
    // already-ATM option cannot produce because gamma falls away as it goes in the money.
    const c = chain(110, 110);
    const then = deltaAtPreviousSpot(c, 110, 100) as number;
    const now = (c.rows.find((r) => r.strike === 110)?.call as ChainLeg).delta;
    const shift = now - then;
    assert.ok(shift > -1 && shift < 1, `delta shift ${shift} outside [-1, 1]`);
  });

  it('clamps to the listed range rather than extrapolating the curve', () => {
    const c = chain(110, 110);
    const far = deltaAtPreviousSpot(c, 110, 10);
    assert.ok(far !== null);
    assert.ok((far as number) >= 0 && (far as number) <= 1);
  });

  it('is null without a usable spot or previous close', () => {
    assert.equal(deltaAtPreviousSpot(chain(110, 110), 0, 100), null);
    assert.equal(deltaAtPreviousSpot(chain(110, 110), 110, 0), null);
  });

  it('returns today’s own delta when nothing moved', () => {
    const c = chain(100, 100);
    const then = deltaAtPreviousSpot(c, 100, 100) as number;
    const now = (c.rows.find((r) => r.strike === 100)?.call as ChainLeg).delta;
    assert.ok(Math.abs(then - now) < 1e-9);
  });
});

describe('expectedMoveFrom', () => {
  it('is 0.8 × the straddle, quoted in rupees and percent', () => {
    const m = expectedMoveFrom(50, 1000, 20);
    assert.ok(m);
    assert.equal(m.rupees, 40);
    assert.equal(m.pct, 4);
    assert.equal(m.days, 20);
  });

  it('is null without a priced straddle', () => {
    assert.equal(expectedMoveFrom(0, 1000, 20), null);
    assert.equal(expectedMoveFrom(50, 0, 20), null);
  });
});

/* ---------------------------------------------------------------- VWAP slope --- */

describe('vwapSlopePctPerMin', () => {
  const readings = (vwaps: number[], stepMs = 30_000) =>
    vwaps.map((vwap, i) => ({ at: 1_000_000 + i * stepMs, minute: i, vwap, volume: (i + 1) * 100, turnover: vwap * (i + 1) * 100, ltp: vwap }));

  it('is positive on a rising VWAP and negative on a falling one', () => {
    const up = vwapSlopePctPerMin({ readings: readings([100, 100.05, 100.1, 100.15, 100.2]), openingRange: null, lastAtmDelta: null, lastFuturesOi: null });
    const down = vwapSlopePctPerMin({ readings: readings([100, 99.95, 99.9, 99.85, 99.8]), openingRange: null, lastAtmDelta: null, lastFuturesOi: null });
    assert.ok((up as number) > 0);
    assert.ok((down as number) < 0);
  });

  it('is ~0 on a flat VWAP', () => {
    const flat = vwapSlopePctPerMin({ readings: readings([100, 100, 100, 100, 100]), openingRange: null, lastAtmDelta: null, lastFuturesOi: null });
    assert.equal(flat, 0);
  });

  it('is null until there is enough of a window to fit a line to', () => {
    assert.equal(vwapSlopePctPerMin({ readings: readings([100, 100.1]), openingRange: null, lastAtmDelta: null, lastFuturesOi: null }), null);
    // Three readings but only 20 seconds of span — a slope off that is noise.
    assert.equal(
      vwapSlopePctPerMin({ readings: readings([100, 100.1, 100.2], 10_000), openingRange: null, lastAtmDelta: null, lastFuturesOi: null }),
      null,
    );
    assert.equal(vwapSlopePctPerMin(undefined), null);
  });

  it('resists a single outlier better than a two-point slope would', () => {
    // Least squares over the window, not last-minus-first.
    const clean = readings([100, 100.1, 100.2, 100.3, 100.4]);
    const spiked = readings([100, 100.1, 100.2, 100.3, 100.34]);
    const a = vwapSlopePctPerMin({ readings: clean, openingRange: null, lastAtmDelta: null, lastFuturesOi: null }) as number;
    const b = vwapSlopePctPerMin({ readings: spiked, openingRange: null, lastAtmDelta: null, lastFuturesOi: null }) as number;
    assert.ok(Math.abs(a - b) < a * 0.25, 'one soft reading must not swing the slope');
  });
});

describe('intervalVwap', () => {
  it('is Δturnover ÷ Δvolume — the price of what actually traded in the window', () => {
    const readings = [
      { at: 0, minute: 0, vwap: 100, volume: 1000, turnover: 100_000, ltp: 100 },
      { at: 60_000, minute: 1, vwap: 101, volume: 2000, turnover: 204_000, ltp: 102 },
    ];
    // 104,000 rupees over 1,000 shares = 104, well above the 101 session VWAP.
    assert.equal(intervalVwap({ readings, openingRange: null, lastAtmDelta: null, lastFuturesOi: null }), 104);
  });

  it('is null when nothing traded in the window', () => {
    const readings = [
      { at: 0, minute: 0, vwap: 100, volume: 1000, turnover: 100_000, ltp: 100 },
      { at: 60_000, minute: 1, vwap: 100, volume: 1000, turnover: 100_000, ltp: 100 },
    ];
    assert.equal(intervalVwap({ readings, openingRange: null, lastAtmDelta: null, lastFuturesOi: null }), null);
  });
});

/* ------------------------------------------------------------------- session --- */

describe('session clock', () => {
  /** 2026-07-31 was a Friday. Times below are IST, expressed as UTC. */
  const istAt = (h: number, m: number) => Date.UTC(2026, 6, 31, h - 5, m - 30);

  it('counts minutes from 09:15 and clamps at both ends', () => {
    assert.equal(minuteOfSession(istAt(9, 15)), 0);
    assert.equal(minuteOfSession(istAt(9, 45)), 30);
    assert.equal(minuteOfSession(istAt(15, 30)), SESSION_MINUTES);
    assert.equal(minuteOfSession(istAt(8, 0)), 0, 'before the open is not negative');
    assert.equal(minuteOfSession(istAt(22, 0)), SESSION_MINUTES, 'after the close is a full session');
  });

  it('reads the minute off an Upstox stamp without a timezone round trip', () => {
    assert.equal(candleMinute('2026-07-31T09:15:00+05:30'), 0);
    assert.equal(candleMinute('2026-07-31T15:29:00+05:30'), 374);
    assert.equal(candleMinute('not a stamp'), -1);
  });
});

/* --------------------------------------------------------- rate-limit breaker --- */

describe('throttle breaker', () => {
  it('stays shut for a handful of refusals — a burst is worth retrying', () => {
    resetBreakers();
    for (let i = 0; i < 5; i++) noteRefusal('test');
    assert.equal(throttledFor('test'), 0);
    assertNotThrottled('test');
  });

  it('opens once refusals cluster, so a spent quota is not retried 600 times', () => {
    resetBreakers();
    for (let i = 0; i < 20; i++) noteRefusal('test');
    assert.ok(throttledFor('test') > 0);
    assert.throws(() => assertNotThrottled('test'), /rate limited/);
  });

  it('keeps one endpoint’s breaker away from another’s', () => {
    resetBreakers();
    for (let i = 0; i < 20; i++) noteRefusal('candles');
    assert.ok(throttledFor('candles') > 0);
    assert.equal(throttledFor('chain'), 0);
  });
});
