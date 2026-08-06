// The EMA pullback strategy.
//
// These tests exist because the failures they guard against are invisible on screen. A scanner
// that fires on crossovers looks exactly like one that fires on pullbacks — both print green rows
// on stocks that are genuinely trending — and the difference only shows up in the fill, weeks
// later, which is far too slow a feedback loop to develop against.
//
// So the properties that make this a pullback scanner rather than a crossover scanner are pinned
// down here instead:
//
//   an EMA crossover with no established trend produces NOTHING;
//   a trend with no retracement produces nothing;
//   a retracement with no confirmation candle produces a WATCH and not a signal;
//   a confirmation on no volume produces nothing;
//   the vetoes from the brief fire on the shapes they are meant to catch;
//   the stop sits beyond the structure, not inside it;
//   the option comes from the configured delta band;
//   and the confidence score's 100 points are the brief's 100 points.
//
// Everything below runs without a network, a clock or a token, which is the payoff for every
// service in the module being a pure function of bars plus config.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adxLast, adxSeries } from '../src/pullback/indicators/adx.js';
import { atrSeries } from '../src/pullback/indicators/atr.js';
import { emaSeries, slopeAtrPerBar, vwapSeries } from '../src/pullback/indicators/ema.js';
import { classify, bodyRatio } from '../src/pullback/indicators/patterns.js';
import { pivots, rangeAtr, readStructure } from '../src/pullback/indicators/structure.js';
import { curve, resample, type Bar } from '../src/pullback/indicators/series.js';
import { computeSeries, readFromBars } from '../src/pullback/data/frames.js';
import { readTrend } from '../src/pullback/engine/trend.service.js';
import { readPullback } from '../src/pullback/engine/pullback.service.js';
import { scoreSignal } from '../src/pullback/engine/score.service.js';
import { buildPlan } from '../src/pullback/engine/risk.service.js';
import { selectOption, scoreLiquidity } from '../src/pullback/engine/option.service.js';
import { evaluateSignal, worthWatching } from '../src/pullback/engine/signal.service.js';
import { defaultConfig } from '../src/pullback/config/defaults.js';
import { sanitise } from '../src/pullback/config/config.repository.js';
import { SESSION_MINUTES } from '../src/momentum/session.js';
import type { ChainLeg, ChainRow, StockChain } from '../src/momentum/data/option-chain.js';
import type { PullbackConfig, Timeframe } from '../src/pullback/types.js';

/* -------------------------------------------------------------------- bar fixtures --- */

/** 09:15 IST on 2026-08-03, as epoch ms. The anchor every synthetic session starts from. */
const SESSION_START = Date.UTC(2026, 7, 3, 3, 45);
const DAY_MS = 86_400_000;
/** A 5-minute session is 75 bars: 09:15 to 15:30. */
const BARS_PER_SESSION = 75;

interface BarSpec {
  close: number;
  /** Half-range above the close and below the open. Small by default. */
  wick?: number;
  volume?: number;
  /** Force the open, for engulfing and hammer shapes. */
  open?: number;
  high?: number;
  low?: number;
}

/**
 * Turn a list of closes into 5-minute bars across as many sessions as they fill.
 *
 * Sessions matter: VWAP is session-anchored and resets at every day boundary, so a fixture that
 * put 375 bars in one "day" would have a VWAP hundreds of points below price and a pullback zone
 * wide enough to contain the whole fixture. Rolling the day every 75 bars is what makes the zone
 * behave the way it does on a real chart.
 */
function bars(specs: BarSpec[], tf: Timeframe = 5): Bar[] {
  const out: Bar[] = [];
  let prevClose = specs[0]?.close ?? 100;

  specs.forEach((s, i) => {
    const session = Math.floor(i / BARS_PER_SESSION);
    const idx = i % BARS_PER_SESSION;
    const dayMs = SESSION_START + session * DAY_MS;
    const at = dayMs + idx * tf * 60_000;
    const open = s.open ?? prevClose;
    const wick = s.wick ?? 0.05;
    const high = s.high ?? Math.max(open, s.close) + wick;
    const low = s.low ?? Math.min(open, s.close) - wick;
    const volume = s.volume ?? 1000;
    const typical = (high + low + s.close) / 3;

    out.push({
      at,
      day: new Date(dayMs + 330 * 60_000).toISOString().slice(0, 10),
      minute: idx * tf,
      open,
      high,
      low,
      close: s.close,
      volume,
      turnover: typical * volume,
    });
    prevClose = s.close;
  });

  return out;
}

const flat = (n: number, price: number, jitter = 0.4): BarSpec[] =>
  Array.from({ length: n }, (_, i) => ({ close: price + (i % 2 === 0 ? jitter : -jitter) }));

const ramp = (n: number, from: number, step: number, wick?: number): BarSpec[] =>
  Array.from({ length: n }, (_, i) => ({ close: from + step * (i + 1), wick }));

/**
 * A rising staircase — up-legs separated by shallow retracements.
 *
 * A straight ramp cannot be used for anything that reads structure, and the reason is worth
 * recording because it took a debugging session to see: a monotonic series has no fractal pivots
 * at all, so `readStructure` correctly reports "fewer than two confirmed swings" and every
 * higher-high / higher-low gate fails on the cleanest uptrend imaginable. Real trends are
 * staircases, and the fixture has to be one too.
 *
 * The extreme bar of each leg carries a WIDER WICK than its neighbours. Without it the bar
 * following a peak opens at the peak's close, so its high ties with the peak's high, and a
 * fractal test that requires strictly-lower neighbours finds nothing. Real bars gap; the wick is
 * the fixture's stand-in for that.
 */
function staircase(count: number, start: number, up: number, down: number, upBars = 5, downBars = 3): BarSpec[] {
  const out: BarSpec[] = [];
  let price = start;
  while (out.length < count) {
    for (let i = 0; i < upBars && out.length < count; i++) {
      price += up;
      out.push({ close: price, wick: i === upBars - 1 ? 0.25 : 0.05 });
    }
    for (let i = 0; i < downBars && out.length < count; i++) {
      price -= down;
      out.push({ close: price, wick: i === downBars - 1 ? 0.25 : 0.05 });
    }
  }
  return out;
}

/** Scale volume across a run of specs, so `participation` sees a genuinely expanding tape. */
const withVolume = (specs: BarSpec[], from: number, to: number): BarSpec[] =>
  specs.map((s, i) => ({ ...s, volume: Math.round(from + ((to - from) * i) / Math.max(1, specs.length - 1)) }));

/**
 * Change a finished bar's volume, keeping its turnover consistent.
 *
 * Mutating `volume` alone silently changes the VWAP: turnover is Σ(typical × volume) and VWAP is
 * turnover ÷ volume, so a bar with the original turnover and a tenth of the volume prices itself
 * ten times higher. That produced a fixture where reducing one bar's volume moved price below VWAP
 * and a volume test failed as a VWAP test.
 */
const revolume = (b: Bar, volume: number): Bar => ({
  ...b, volume, turnover: ((b.high + b.low + b.close) / 3) * volume,
});

const cfg = (over: (c: PullbackConfig) => void = () => {}): PullbackConfig => {
  const c = defaultConfig();
  over(c);
  return sanitise(c);
};

/* ------------------------------------------------------------------------ indicators --- */

describe('indicators', () => {
  it('seeds an EMA with the SMA of the first period, not with the first price', () => {
    // The convention every Indian charting platform uses. Seeding with price[0] converges to the
    // same place eventually and is dominated by one print for the first `period` bars — which on a
    // 200 EMA is 200 bars of a number that is mostly the opening tick.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const e = emaSeries(values, 5);

    assert.equal(e[3], null, 'no EMA before the seed');
    assert.equal(e[4], 3, 'the seed is the mean of the first five values');
    // Then the recursion: 6·(2/6) + 3·(4/6) = 4.
    assert.equal(e[5], 4);
  });

  it('has no EMA at all when there are fewer bars than the period', () => {
    // A cold average must be null, never the price. Returning the price would make "price above
    // the 200 EMA" true for every symbol on the first morning after a deploy.
    assert.deepEqual(emaSeries([1, 2, 3], 9), [null, null, null]);
  });

  it('computes ATR from TRUE range, so a gap counts', () => {
    // Fifteen flat bars of range 1, then a bar that gaps 10 and has a range of 1. A high−low
    // average would score that session as quiet; true range sees the 10.
    const specs: BarSpec[] = Array.from({ length: 16 }, () => ({ close: 100, open: 100, high: 100.5, low: 99.5 }));
    specs.push({ close: 110, open: 110, high: 110.5, low: 109.5 });
    const s = atrSeries(bars(specs), 14);
    const before = s[15] as number;
    const after = s[16] as number;
    assert.ok(after > before * 1.5, `ATR should jump on a gap: ${before} -> ${after}`);
  });

  it('anchors VWAP to the session and resets it at the day boundary', () => {
    // 75 bars at 100, then a new session that opens and trades at 200. A continuous VWAP would
    // still be near 100 on the first bar of day two; a session-anchored one is at 200.
    const specs: BarSpec[] = [
      ...Array.from({ length: BARS_PER_SESSION }, () => ({ close: 100, open: 100, high: 100, low: 100 })),
      ...Array.from({ length: 5 }, () => ({ close: 200, open: 200, high: 200, low: 200 })),
    ];
    const v = vwapSeries(bars(specs));
    assert.ok(Math.abs((v[BARS_PER_SESSION - 1] as number) - 100) < 0.01);
    assert.ok(Math.abs((v[BARS_PER_SESSION] as number) - 200) < 0.01, 'VWAP must reset with the session');
  });

  it('zeroes the smaller directional movement so an outside bar cannot lift both DIs', () => {
    const up = bars(ramp(60, 100, 0.5));
    const a = adxLast(up, 14);
    assert.ok(a.adx !== null && a.adx > 25, `a straight ramp should read as a trend, got ${a.adx}`);
    assert.ok((a.plusDi ?? 0) > (a.minusDi ?? 99), '+DI must dominate on a rising series');
  });

  it('has no ADX until roughly twice the period has elapsed', () => {
    // ADX is a Wilder smoothing OF DX, so it needs `period` bars of DX before it can be seeded.
    // Publishing a number sooner would put a warming indicator through a hard 25 threshold.
    const short = bars(ramp(20, 100, 0.5));
    assert.equal(adxLast(short, 14).adx, null);
    const long = bars(ramp(40, 100, 0.5));
    assert.ok(adxLast(long, 14).adx !== null);
  });

  it('measures slope in ATR per bar so one threshold works across the universe', () => {
    // The same 0.5%-per-bar drift on two instruments a hundred times apart in price must read the
    // same. The wick scales with the price too, or the fixture would be comparing a ₹0.05 tick
    // against a ₹0.05 tick on a ₹10,000 instrument and the ATRs would not be comparable either.
    const cheap = bars(ramp(40, 100, 0.5, 0.05));
    const rich = bars(ramp(40, 10_000, 50, 5));
    const cheapSlope = slopeAtrPerBar(emaSeries(cheap.map((b) => b.close), 9), atrSeries(cheap, 14).at(-1) ?? null, 5);
    const richSlope = slopeAtrPerBar(emaSeries(rich.map((b) => b.close), 9), atrSeries(rich, 14).at(-1) ?? null, 5);
    assert.ok(cheapSlope !== null && richSlope !== null);
    assert.ok(Math.abs(cheapSlope - richSlope) / cheapSlope < 0.15, `${cheapSlope} vs ${richSlope} should be comparable`);
  });

  it('buckets resampled bars on minute-of-session, so 3-minute bars align to 09:15', () => {
    const oneMin = bars(ramp(9, 100, 1), 1);
    const three = resample(oneMin, 3);
    assert.equal(three.length, 3);
    assert.deepEqual(three.map((b) => b.minute), [0, 3, 6]);
    // Open of the first sub-bar, close of the last, extremes and volume summed.
    assert.equal(three[0].open, oneMin[0].open);
    assert.equal(three[0].close, oneMin[2].close);
    assert.equal(three[0].volume, oneMin[0].volume + oneMin[1].volume + oneMin[2].volume);
  });

  it('never merges two sessions into one resampled bar', () => {
    // A bar spanning 15:29 to 09:15 would have the overnight gap inside it, print as a huge
    // range, and poison ATR for the next fourteen bars.
    const oneMin = bars([...flat(BARS_PER_SESSION, 100, 0), ...flat(3, 100, 0)], 1);
    const fifteen = resample(oneMin, 15);
    const days = new Set(fifteen.map((b) => b.day));
    assert.equal(days.size, 2);
    for (const b of fifteen) assert.ok(b.high - b.low < 5, 'no bar may straddle the close');
  });

  it('finds fractal pivots and reads a staircase as higher highs and higher lows', () => {
    const b = bars(staircase(60, 100, 0.4, 0.25));
    const p = pivots(b, 2);
    assert.ok(p.filter((x) => x.kind === 'high').length >= 2, 'a staircase must produce swing highs');
    assert.ok(p.filter((x) => x.kind === 'low').length >= 2, 'and swing lows');

    const st = readStructure(b, 1, 2);
    assert.ok(st.higherHigh, 'a stepping-up zigzag has a higher high');
    assert.ok(st.higherLow, 'and a higher low');
    assert.ok(st.steps >= 2, `steps should count the staircase, got ${st.steps}`);
  });

  it('finds no pivots at all in a monotonic ramp, and says so rather than guessing', () => {
    // Worth pinning down because it is counter-intuitive and it shaped the fixtures above: the
    // cleanest imaginable uptrend has no swing structure, so a higher-high gate reads as failing.
    // Real trends are staircases. A structure reader that invented pivots to avoid the awkward
    // answer would be reporting a sequence that is not on the chart.
    const st = readStructure(bars(ramp(60, 100, 0.4)), 1, 2);
    assert.equal(st.higherHigh, false);
    assert.ok((st.note ?? '').includes('confirmed swings'), st.note);
  });

  it('classifies a bullish engulfing bar and refuses a doji', () => {
    const b = bars([
      { close: 100, open: 100.6, high: 100.7, low: 99.9 }, // bearish
      { close: 101, open: 99.8, high: 101.1, low: 99.7 },  // engulfs it
    ]);
    assert.equal(classify(b, 1, 1), 'bullishEngulfing');

    const doji = bars([
      { close: 100, open: 100.6, high: 100.7, low: 99.9 },
      { close: 100.05, open: 100, high: 101, low: 99 },
    ]);
    assert.equal(classify(doji, 1, 1), 'none', 'a doji at the zone is the market failing to decide');
    assert.ok(bodyRatio(doji[1]) < 0.1);
  });

  it('finds a hammer even though its body is small', () => {
    // The whole point of the pattern is a long lower wick with a small body, so the body-ratio
    // floor that filters dojis must not also filter hammers.
    const b = bars([
      { close: 100, open: 100.5, high: 100.6, low: 99.8 },
      { close: 100.4, open: 100.2, high: 100.5, low: 98.5 },
    ]);
    assert.equal(classify(b, 1, 1), 'hammer');
  });

  it('interpolates a scoring curve and clamps both tails', () => {
    const knots = [{ at: 20, score: 0 }, { at: 30, score: 100 }];
    assert.equal(curve(knots, 10), 0);
    assert.equal(curve(knots, 25), 50);
    assert.equal(curve(knots, 40), 100);
  });
});

/* ---------------------------------------------------------------------- the fixtures --- */

/**
 * Four gentle sessions, then a base, then a sharp impulse — the shape a pullback happens in.
 *
 * Built as a function rather than a constant because several tests mutate the tail, and a shared
 * array would make them order-dependent.
 */
function trendingBars(): Bar[] {
  const history = staircase(BARS_PER_SESSION * 4, 100, 0.22, 0.16);
  const last = history[history.length - 1].close;
  return bars([
    ...withVolume(history, 800, 900),
    // The final session: a staircase that builds the swing sequence, then a clean drive that
    // leaves price clear of the EMA band — which is the "price moves away" step the pullback is
    // measured against. Volume expands through it, as it does on a real impulse.
    ...withVolume([...staircase(46, last, 0.24, 0.17), ...ramp(9, last + 46 * 0.05, 0.34)], 950, 1600),
  ]);
}

/**
 * Append a retracement that walks price down until it is inside the pullback zone.
 *
 * Driven by the zone's ACTUAL value at each step rather than by a hard-coded target, because the
 * averages move as the retracement prints — the 9 EMA falls toward price, so a fixed target
 * either overshoots into a break or never arrives. This is also the honest way to express what
 * the strategy is waiting for.
 */
function pullBackIntoZone(base: Bar[], c: PullbackConfig, maxBars = 12): Bar[] {
  const out = [...base];
  for (let i = 0; i < maxBars; i++) {
    const s = computeSeries(out);
    const last = out.length - 1;
    const atr = s.atr[last] ?? 0.5;
    const values = [s.ema9[last], s.ema20[last], s.vwap[last]].filter((v): v is number => v !== null);
    const zoneTop = Math.max(...values) + c.pullback.zoneToleranceAtr * atr;
    const price = out[last].close;
    if (price <= zoneTop) break;

    const next = Math.max(zoneTop - 0.05, price - Math.max(0.5, (price - zoneTop) / 2));
    const prev = out[last];
    const high = Math.max(price, next) + 0.08;
    const low = Math.min(price, next) - 0.08;
    const volume = 1200;
    out.push({
      at: prev.at + 5 * 60_000,
      day: prev.day,
      minute: prev.minute + 5,
      open: price,
      high,
      low,
      close: next,
      volume,
      turnover: ((high + low + next) / 3) * volume,
    });
  }
  return out;
}

/** A bullish engulfing bar on expanded volume, appended to whatever came before. */
function confirmBullish(base: Bar[], volumeRatio = 2.5): Bar[] {
  const prev = base[base.length - 1];
  const close = prev.open + Math.max(0.5, Math.abs(prev.open - prev.close) * 1.4);
  const avg = base.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
  const bar: Bar = {
    at: prev.at + 5 * 60_000,
    day: prev.day,
    minute: prev.minute + 5,
    open: prev.close - 0.05,
    high: close + 0.1,
    low: prev.close - 0.15,
    close,
    volume: Math.round(avg * volumeRatio),
    turnover: 0,
  };
  bar.turnover = ((bar.high + bar.low + bar.close) / 3) * bar.volume;
  return [...base, bar];
}

/* --------------------------------------------------------------------------- trend --- */

describe('trend gates', () => {
  it('reads a stacked, sloping, high-ADX series as a trend', () => {
    const c = cfg();
    const b = trendingBars();
    const read = readFromBars(b, 5, c);
    const t = readTrend({ read, bars: b, spreadBps: 8, cfg: c });

    assert.equal(t.state, 'Bullish', `expected Bullish, failed: ${t.failed.join('; ')} vetoes: ${t.vetoes.join('; ')}`);
    assert.ok(t.strength > 55, `strength ${t.strength}`);
    assert.equal(t.vetoes.length, 0);
  });

  it('vetoes a flat 20 EMA even when everything else lines up', () => {
    // The brief's "20 EMA flat" condition. A pullback to a flat average is a range, and every
    // other check on a dead sideways stock can still pass.
    const c = cfg();
    const b = bars([...ramp(200, 100, 0.05), ...flat(60, 110, 0.15)]);
    const read = readFromBars(b, 5, c);
    const t = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    assert.ok(t.vetoes.some((v) => v.includes('flat')), `expected a flat-EMA veto, got: ${t.vetoes.join('; ')}`);
    assert.equal(t.state, 'None');
  });

  it('vetoes a consolidating range on the span of the last ten bars', () => {
    const c = cfg();
    const b = bars([...ramp(200, 100, 0.2), ...flat(15, 140, 0.2)]);
    const read = readFromBars(b, 5, c);
    const t = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    assert.ok(
      t.vetoes.some((v) => v.includes('consolidation')),
      `expected a consolidation veto, got: ${t.vetoes.join('; ')}`,
    );
  });

  it('vetoes a wide underlying spread, and does not veto an absent book', () => {
    const c = cfg();
    const b = trendingBars();
    const read = readFromBars(b, 5, c);

    const wide = readTrend({ read, bars: b, spreadBps: 120, cfg: c });
    assert.ok(wide.vetoes.some((v) => v.includes('bps wide')));

    // Outside market hours every book is one-sided. A spread veto that fired on the whole board at
    // 16:00 would read as "the market is illiquid" rather than as "the market is shut".
    const closed = readTrend({ read, bars: b, spreadBps: null, cfg: c });
    assert.ok(!closed.vetoes.some((v) => v.includes('bps wide')));
  });

  it('vetoes a dead tape, and does not veto one quiet bar', () => {
    const c = cfg();
    const lookback = c.timeframes.volumeLookback;

    // A whole window trading a fraction of the previous window is a stock nobody is in.
    const dead = trendingBars();
    for (let i = dead.length - lookback; i < dead.length; i++) dead[i] = revolume(dead[i], 120);
    const deadTrend = readTrend({ read: readFromBars(dead, 5, c), bars: dead, spreadBps: 8, cfg: c });
    assert.ok(deadTrend.vetoes.some((v) => v.includes('tape is dead')), deadTrend.vetoes.join('; '));

    // But ONE quiet bar must not veto anything: volume drying up on the retracement is what a
    // healthy pullback looks like, and the gate that fired on it would refuse every setup at the
    // moment it became a setup.
    const quiet = trendingBars();
    quiet[quiet.length - 1] = revolume(quiet[quiet.length - 1], 120);
    const quietTrend = readTrend({ read: readFromBars(quiet, 5, c), bars: quiet, spreadBps: 8, cfg: c });
    assert.equal(quietTrend.state, 'Bullish', `one quiet bar must not disqualify: ${[...quietTrend.failed, ...quietTrend.vetoes].join('; ')}`);
  });

  it('reports strength even when a gate failed, so near misses stay visible', () => {
    // Surfacing a rejected row as strength 0 would delete the entire watch population, which is
    // the population worth watching.
    const c = cfg((x) => { x.trend.adxTrend = 95; });
    const b = trendingBars();
    const read = readFromBars(b, 5, c);
    const t = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    assert.equal(t.state, 'None');
    assert.ok(t.strength > 0, 'a near miss must still report its strength');
    assert.ok(t.failed.some((f) => f.startsWith('ADX')));
  });
});

/* ------------------------------------------------------------------------ pullback --- */

describe('pullback detection', () => {
  it('reads an extended trend as Impulse, not as a pullback', () => {
    const c = cfg();
    const b = trendingBars();
    const s = computeSeries(b);
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: s, timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    assert.ok(p.phase === 'Impulse' || p.phase === 'PullingBack', `got ${p.phase}: ${p.note}`);
    assert.equal(p.confirmation, null);
  });

  it('reads a retracement into the EMA band as AtZone with no confirmation', () => {
    const c = cfg();
    const b = pullBackIntoZone(trendingBars(), c);
    const s = computeSeries(b);
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: s, timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });

    assert.equal(p.phase, 'AtZone', `got ${p.phase}: ${p.note}`);
    assert.ok(p.touch.nearest !== null, 'something in the zone must have been touched');
    assert.ok(p.zone !== null);
    assert.ok((p.retracement ?? 0) >= c.pullback.minRetracement);
    assert.equal(p.confirmation, null, 'a touch alone is not a confirmation');
  });

  it('promotes to Resuming once a bullish candle prints on expanded volume', () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const s = computeSeries(b);
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: s, timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });

    assert.equal(p.phase, 'Resuming', `got ${p.phase}: ${p.note}`);
    assert.ok(p.confirmation !== null);
    assert.equal(p.confirmation?.barsAgo, 0);
    assert.ok((p.confirmation?.volumeRatio ?? 0) >= c.pullback.minConfirmationVolumeRatio);
  });

  it('refuses the same candle on ordinary volume — both halves of the entry rule are required', () => {
    // A reversal candle on no volume is a pause in the selling, not a resumption of the buying.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c), 0.9);
    const s = computeSeries(b);
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: s, timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });

    assert.equal(p.phase, 'AtZone');
    assert.equal(p.confirmation, null);
  });

  it('reads a break through the far side of the zone as Failed, not as a live setup', () => {
    // A failed pullback also satisfies "touched the zone", so publishing it as AtZone would show a
    // trade whose thesis has already expired as an entry.
    const c = cfg();
    const held = pullBackIntoZone(trendingBars(), c);
    const s = computeSeries(held);
    const last = held.length - 1;
    const atr = s.atr[last] ?? 0.5;
    const bottom = Math.min(s.ema9[last] ?? 0, s.ema20[last] ?? 0, s.vwap[last] ?? 0);
    const through = bottom - (c.pullback.rejectionAtr + 0.6) * atr;

    const broken = [...held, ...bars([{ close: through, open: held[last].close }]).map((x) => ({
      ...x, at: held[last].at + 5 * 60_000, day: held[last].day, minute: held[last].minute + 5,
    }))];

    const p = readPullback({
      bars: broken, series: computeSeries(broken), timeframe: 5, direction: 1,
      avgVolume: readFromBars(broken, 5, c).avgVolume, cfg: c,
    });
    assert.equal(p.phase, 'Failed', `got ${p.phase}: ${p.note}`);
  });

  it('requires price to have got clear of the EMA band before calling anything a pullback', () => {
    // A stock grinding up inside its own averages never leaves the band, so there is no pullback to
    // take: price is already where a retracement would arrive.
    const c = cfg();
    const b = bars(ramp(250, 100, 0.02));
    const p = readPullback({
      bars: b, series: computeSeries(b), timeframe: 5, direction: 1,
      avgVolume: readFromBars(b, 5, c).avgVolume, cfg: c,
    });
    assert.equal(p.phase, 'None');
    assert.ok(
      (p.note ?? '').includes('never got clear') || (p.note ?? '').includes('no impulse'),
      p.note,
    );
  });
});

/* --------------------------------------------------------------------------- score --- */

describe('confidence score', () => {
  it("totals the brief's 100 points and reports what was measurable", () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const trend = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });

    const s = scoreSignal({ trend, pullback: p, read, frames: { 5: read }, direction: 1, cfg: c });

    const maxima = Object.fromEntries(s.components.map((x) => [x.key, x.max]));
    assert.deepEqual(maxima, { trend: 30, volume: 20, vwap: 15, ema: 15, structure: 10, adx: 10 });
    assert.ok(s.total > 0 && s.total <= 100, `total ${s.total}`);
    assert.ok(s.coverage > 0 && s.coverage <= 1);
    assert.ok(['Weak', 'Medium', 'Strong', 'Excellent'].includes(s.band));
  });

  it('drops an unmeasurable component from BOTH the score and the denominator', () => {
    // Awarding zero would make every symbol look weak while an average warms; awarding half would
    // be an invention. Leaving it out and recording coverage is the only honest option.
    //
    // ADX is a Wilder smoothing OF DX, so it needs about 2 × period bars. Twenty-five is enough to
    // read the frame and not enough to have an ADX, which is exactly the state this tests.
    const c = cfg((x) => { x.timeframes.minBars = 20; });
    const short = bars(staircase(25, 100, 0.4, 0.25));
    const read = readFromBars(short, 5, c);
    const trend = readTrend({ read, bars: short, spreadBps: 8, cfg: c });
    const p = readPullback({ bars: short, series: computeSeries(short), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const s = scoreSignal({ trend, pullback: p, read, frames: { 5: read }, direction: 1, cfg: c });

    const adx = s.components.find((x) => x.key === 'adx');
    assert.equal(adx?.available, false);
    assert.equal(adx?.points, 0);
    assert.ok(s.coverage < 1, 'coverage must record the missing component');
  });

  it('scores an entry near VWAP above an identical one far from it', () => {
    // This reads backwards until you remember what is being scored: not how strong the move is —
    // that is trend strength — but how good this ENTRY is. Two ATR above VWAP is a chase.
    const c = cfg();
    const near = readFromBars(confirmBullish(pullBackIntoZone(trendingBars(), c)), 5, c);
    const far = readFromBars(trendingBars(), 5, c);

    const score = (read: typeof near, b: Bar[]) => {
      const trend = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
      const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
      return scoreSignal({ trend, pullback: p, read, frames: { 5: read }, direction: 1, cfg: c });
    };

    const nearScore = score(near, confirmBullish(pullBackIntoZone(trendingBars(), c)));
    const farScore = score(far, trendingBars());
    const nearVwap = nearScore.components.find((x) => x.key === 'vwap')?.points ?? 0;
    const farVwap = farScore.components.find((x) => x.key === 'vwap')?.points ?? 0;
    assert.ok(nearVwap > farVwap, `near ${nearVwap} should beat far ${farVwap}`);
  });
});

/* ---------------------------------------------------------------------------- risk --- */

describe('stops and targets', () => {
  it('prefers the swing stop, because that is the level the thesis dies at', () => {
    // Not "the widest structural stop", which is what this originally did. The swing low is where
    // the higher-low structure is gone; the EMA stop is a proxy that is sometimes far wider, and
    // letting IT decide affordability discarded a good swing stop in favour of an ATR stop sitting
    // inside the pullback's own range — the exact failure a structural stop exists to prevent.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;

    const plan = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: c });
    assert.ok(plan, 'a confirmed pullback must be able to produce a plan');

    const kinds = plan!.stop.candidates.map((x) => x.kind).sort();
    assert.deepEqual(kinds, ['atr', 'ema', 'swing']);
    assert.equal(plan!.stop.recommended.kind, 'swing');
    assert.ok(plan!.stop.recommended.price < entry, 'a long stop is below entry');
    // A stop inside the pullback's own low is taken out by a move that does not disprove the trade.
    if (p.extreme !== null)
      assert.ok(plan!.stop.recommended.price < p.extreme, 'the swing stop must clear the pullback low');
  });

  it('refuses a structural stop that is inside the noise, because R is the denominator', () => {
    // The failure this guards: when price sits exactly at its retracement low the swing stop
    // degenerates to "entry minus the buffer", and every R on the row inflates because risk is the
    // denominator. Measured on a live board before the floor existed, BRITANNIA showed a 0.02% stop
    // and 56.48R of room, and SHREECEM 0.04% and 62.44R.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;
    const atr = read.atr as number;

    // Pretend the retracement extreme is a hair below the entry — the degenerate case.
    const degenerate = { ...p, extreme: entry - 0.02 * atr };
    const plan = buildPlan({ bars: b, read, pullback: degenerate, direction: 1, entry, cfg: c })!;

    assert.notEqual(plan.stop.recommended.kind, 'swing', 'a 0.17 ATR swing stop is not a level');
    assert.ok(plan.stop.recommended.distanceAtr >= c.risk.minStopAtr, `stop is ${plan.stop.recommended.distanceAtr} ATR`);
    // And with the stop sane, the room reading is back in a believable range.
    assert.ok(plan.target.roomR < 20, `room was ${plan.target.roomR}R`);

    // With the 20 EMA also sitting on top of price, no structural level is usable and the fallback
    // says which edge of the band it failed — "too tight" and "too wide" are opposite problems.
    const flat = { ...read, ema: { ...read.ema, ema20: entry - 0.03 * atr } };
    const both = buildPlan({ bars: b, read: flat, pullback: degenerate, direction: 1, entry, cfg: c })!;
    assert.equal(both.stop.recommended.kind, 'atr');
    assert.ok(both.stop.warning?.includes('closer than'), both.stop.warning);
  });

  it('falls through swing → EMA → ATR as the affordability ceiling bites', () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;

    const base = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: c })!;
    const swingAtr = base.stop.candidates.find((x) => x.kind === 'swing')!.distanceAtr;
    const emaAtr = base.stop.candidates.find((x) => x.kind === 'ema')!.distanceAtr;

    // A ceiling under the swing but (where the fixture allows) over the EMA hands the trade to
    // whichever structural level still fits, rather than abandoning structure altogether.
    const tighter = cfg((x) => { x.risk.maxStopAtr = Math.max(x.risk.atrStopMultiple, swingAtr - 0.01); });
    const mid = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: tighter })!;
    assert.notEqual(mid.stop.recommended.kind, 'swing');
    if (emaAtr <= tighter.risk.maxStopAtr) assert.equal(mid.stop.recommended.kind, 'ema');
    else assert.equal(mid.stop.recommended.kind, 'atr');
  });

  it('falls back to the ATR stop when the structural one is unaffordable, and says so', () => {
    const c = cfg((x) => { x.risk.maxStopAtr = 0.3; });
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;

    const plan = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: c })!;
    assert.equal(plan.stop.recommended.kind, 'atr');
    assert.ok(plan.stop.warning?.includes('structural stop'), plan.stop.warning);
  });

  it('measures room against the objective, not against the stop — or the gate cannot fire', () => {
    // The bug this pins: with a `2R` primary target, `rewardRisk` is 2.00 on every row ever
    // produced, because the 2R target is DEFINED from the stop. A `minRewardRisk` of 1.5 compared
    // against it was arithmetic restating itself, and it read as a risk control. Measured on live
    // rows before the fix: 209 of 209 scanned symbols reported exactly 2.00.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;
    const plan = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: c })!;

    assert.equal(plan.target.rewardRisk, 2, 'a 2R primary is 2R by construction — that is the point');
    assert.notEqual(plan.target.roomR, plan.target.rewardRisk, 'room must be an independent measurement');

    // And it must be the measured move — the leg repeating — rather than the prior high, which is an
    // obstacle rather than the objective and degenerates toward zero when the confirmation bar
    // closes just under it.
    const measured = plan.target.candidates.find((t) => t.kind === "measuredMove");
    if (measured) assert.equal(plan.target.roomR, measured.r);
  });

  it('refuses a setup whose retracement was too deep to pay for its own stop', () => {
    // The same gate, made to bite: an impossible room requirement stands in for a retracement deep
    // enough that the leg repeating cannot cover the stop it created.
    const c = cfg((x) => { x.risk.minRewardRisk = 50; });
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const trend = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });

    const r = evaluateSignal({
      symbol: "TEST", timeframe: 5, bars: b, read, trend, pullback: p, frames: { 5: read },
      price: b[b.length - 1].close, chain: null, spotAdjust: 0, lotSize: 250,
      lastFiredAt: null, cfg: c, nowMs: b[b.length - 1].at,
    })!;

    assert.equal(r.fired, false);
    assert.ok(r.signal.blockers.some((x) => x.includes("room to the next real objective")), r.signal.blockers.join(" | "));
  });

  it('quotes reward:risk against ONE primary target', () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const read = readFromBars(b, 5, c);
    const p = readPullback({ bars: b, series: computeSeries(b), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c });
    const entry = p.confirmation?.close ?? read.close ?? 0;
    const plan = buildPlan({ bars: b, read, pullback: p, direction: 1, entry, cfg: c })!;

    assert.equal(plan.target.rewardRisk, plan.target.primary.r);
    const oneR = plan.target.candidates.find((x) => x.kind === '1R')!;
    const twoR = plan.target.candidates.find((x) => x.kind === '2R')!;
    assert.ok(Math.abs(oneR.r - 1) < 0.05, `1R should be 1R, got ${oneR.r}`);
    assert.ok(Math.abs(twoR.r - 2) < 0.05, `2R should be 2R, got ${twoR.r}`);
    assert.ok(plan.target.trailing.rule.length > 0);
  });
});

/* -------------------------------------------------------------------------- option --- */

const leg = (over: Partial<ChainLeg> = {}): ChainLeg => ({
  instrumentKey: 'NSE_FO|1', ltp: 20, closePrice: 19, volume: 5000, oi: 50_000, prevOi: 45_000,
  bid: 19.9, ask: 20.1, bidQty: 1500, askQty: 1500,
  delta: 0.5, gamma: 0.004, theta: -1.2, vega: 3, iv: 22, ...over,
});

/**
 * A ladder of ten strikes centred on `spot`, with deltas falling as they go out of the money.
 *
 * The ladder is generated FROM the spot rather than fixed at 1000, because `selectOption` resolves
 * the at-the-money row by proximity: a fixture whose strikes sit a hundred points from the price
 * would put the "ATM" at the end of the ladder and every delta band assertion would be testing an
 * accident of the fixture.
 */
function chain(spot = 1000): StockChain {
  const step = Math.max(0.5, +(spot * 0.02).toPrecision(2));
  const atm = Math.round(spot / step) * step;
  const rows: ChainRow[] = [];
  for (let k = -4; k <= 5; k++) {
    const strike = +(atm + k * step).toFixed(2);
    // A crude but monotonic delta ladder: 0.5 at the money, falling ~0.08 a strike.
    const callDelta = Math.max(0.05, Math.min(0.95, 0.5 - k * 0.08));
    const atmPremium = spot * 0.025;
    rows.push({
      strike,
      call: leg({
        instrumentKey: `NSE_FO|C${strike}`, delta: callDelta,
        ltp: Math.max(0.5, atmPremium - k * atmPremium * 0.16),
        bid: Math.max(0.4, atmPremium - k * atmPremium * 0.16 - 0.05),
        ask: Math.max(0.6, atmPremium - k * atmPremium * 0.16 + 0.05),
      }),
      put: leg({
        instrumentKey: `NSE_FO|P${strike}`, delta: -(1 - callDelta),
        ltp: Math.max(0.5, atmPremium * 0.8 + k * atmPremium * 0.16),
        bid: Math.max(0.4, atmPremium * 0.8 + k * atmPremium * 0.16 - 0.05),
        ask: Math.max(0.6, atmPremium * 0.8 + k * atmPremium * 0.16 + 0.05),
      }),
    });
  }
  return { symbol: 'TEST', underlyingKey: 'NSE_EQ|T', expiry: '2026-08-27', expiryDays: 21, spot, atmStrike: atm, rows };
}

describe('option selection', () => {
  it('picks a call inside the pullback delta band, not the cheapest strike on the sheet', () => {
    // Ranking purely on payoff always walks out to the cheapest contract, whose delta has stopped
    // tracking the stop the plan is built on.
    const c = cfg();
    const pick = selectOption({
      chain: chain(), direction: 1, entryKind: 'pullback', entry: 1000, target: 1020,
      spotAdjust: 0, lotSize: 250, cfg: c,
    });
    assert.ok(pick, 'a liquid chain must produce a pick');
    assert.equal(pick!.side, 'CE');
    const d = Math.abs(pick!.delta);
    assert.ok(
      d >= c.option.pullbackDelta.min && d <= c.option.pullbackDelta.max,
      `delta ${d} should be inside ${c.option.pullbackDelta.min}–${c.option.pullbackDelta.max}`,
    );
    assert.ok(pick!.costPerLot !== null && pick!.costPerLot > 0);
  });

  it('uses the higher band when the trend is being joined rather than pulled back into', () => {
    const c = cfg();
    const pick = selectOption({
      chain: chain(), direction: 1, entryKind: 'holding', entry: 1000, target: 1020,
      spotAdjust: 0, lotSize: 250, cfg: c,
    })!;
    const d = Math.abs(pick.delta);
    assert.ok(d >= c.option.holdingDelta.min && d <= c.option.holdingDelta.max, `delta ${d}`);
  });

  it('picks a put for a short and translates the index basis into spot space', () => {
    const c = cfg();
    // The plan is on the future at 995; spot is 1000, so `spotAdjust` is +5. A module that skipped
    // the translation would price the option's payoff against a level it does not reference.
    const pick = selectOption({
      chain: chain(1000), direction: -1, entryKind: 'pullback', entry: 995, target: 975,
      spotAdjust: 5, lotSize: 25, cfg: c,
    })!;
    assert.equal(pick.side, 'PE');
    assert.ok(pick.premiumAtTarget !== null && pick.premiumAtTarget > pick.premium, 'a put gains as spot falls');
  });

  it('scores a wide book as illiquid even with enormous open interest', () => {
    const c = cfg();
    const wide = scoreLiquidity(leg({ bid: 16, ask: 24, oi: 400_000 }), 250, c);
    const tight = scoreLiquidity(leg({ bid: 19.95, ask: 20.05, oi: 400_000 }), 250, c);
    assert.ok(wide.score < tight.score, `${wide.score} should be worse than ${tight.score}`);
    assert.ok(wide.score < c.option.minLiquidityScore, 'a 40%-wide book is not tradable');
  });

  it('returns the nearest strike WITH its warnings when nothing clears the floors', () => {
    // Silence is indistinguishable from the chain having failed to load. "Here is the contract and
    // here is what is wrong with it" is a useful answer.
    const c = cfg();
    const dead = chain();
    for (const row of dead.rows) {
      if (row.call) Object.assign(row.call, { oi: 5, volume: 0, bid: 1, ask: 9 });
    }
    const pick = selectOption({
      chain: dead, direction: 1, entryKind: 'pullback', entry: 1000, target: 1020,
      spotAdjust: 0, lotSize: 250, cfg: c,
    });
    assert.ok(pick);
    assert.ok(pick!.warnings.length > 0);
    assert.ok(pick!.reason.includes('nearest strike'));
  });
});

/* -------------------------------------------------------------------- the whole thing --- */

describe('signal assembly', () => {
  const evaluate = (b: Bar[], c: PullbackConfig, over: Partial<Parameters<typeof evaluateSignal>[0]> = {}) => {
    const read = readFromBars(b, 5, c);
    const trend = readTrend({ read, bars: b, spreadBps: 8, cfg: c });
    const direction: 1 | -1 = trend.state === 'Bearish' ? -1 : 1;
    const pullback = readPullback({
      bars: b, series: computeSeries(b), timeframe: 5, direction, avgVolume: read.avgVolume, cfg: c,
    });
    return evaluateSignal({
      symbol: 'TEST', timeframe: 5, bars: b, read, trend, pullback, frames: { 5: read },
      price: b[b.length - 1].close, chain: chain(b[b.length - 1].close), spotAdjust: 0,
      lotSize: 250, lastFiredAt: null, cfg: c, nowMs: b[b.length - 1].at + 30_000, ...over,
    });
  };

  it('fires on trend + pullback + candle + volume, and carries the whole plan', () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const r = evaluate(b, c);

    assert.ok(r, 'the fixture must produce a result');
    assert.deepEqual(r!.signal.blockers, [], `blocked by: ${r!.signal.blockers.join(' | ')}`);
    assert.equal(r!.fired, true);
    assert.equal(r!.signal.side, 'BUY');
    assert.equal(r!.signal.entryKind, 'pullback');
    assert.ok(r!.signal.option !== null, 'a fired signal on a liquid chain names a contract');
    assert.ok(r!.signal.target.rewardRisk >= c.risk.minRewardRisk);
    assert.ok(r!.signal.reasons.length >= 2);
    // The entry is the confirmation bar's close, not the live price — the plan has to be quoted
    // against the price it was defined at.
    assert.equal(r!.signal.entry, +(r!.signal.pullback.confirmation!.close).toFixed(2));
  });

  it('does NOT fire at an EMA crossover — a cross is not a pullback', () => {
    // The single most important negative test in this module. At a 9-over-20 cross the two averages
    // are BY DEFINITION equal, so price is inside the zone rather than pulled back to it: there is
    // no impulse to retrace and no distance for a stop to hide in. Whatever else is true of the
    // chart, that alone is why this scanner cannot fire there.
    const c = cfg();
    // A downtrend that turns: the 9 crosses back over the 20 somewhere in the recovery, which is
    // the textbook "golden cross" entry and the one this module refuses.
    const down = staircase(150, 130, -0.2, -0.13);
    const b = bars([...down, ...staircase(40, down[down.length - 1].close, 0.24, 0.16)]);
    const s = computeSeries(b);

    // The last bar at which the 9 was still at or below the 20 — the cross itself.
    let cross = -1;
    for (let i = b.length - 1; i > 40; i--) {
      const a = s.ema9[i];
      const d = s.ema20[i];
      if (a !== null && d !== null && a <= d) { cross = i; break; }
    }
    assert.ok(cross > 40, 'the fixture must contain a crossover to test');

    const window = b.slice(0, cross + 1);
    const p = readPullback({
      bars: window, series: computeSeries(window), timeframe: 5, direction: 1,
      avgVolume: readFromBars(window, 5, c).avgVolume, cfg: c,
    });
    assert.ok(p.phase !== 'Resuming', `a crossover bar must never be a confirmed pullback: ${p.phase}`);

    const r = evaluate(window, c);
    assert.ok(!r || !r.fired, `a crossover must not fire: ${r?.signal.blockers.join(' | ')}`);
  });

  it('produces no signal at all across a whole ranging session', () => {
    // The property that matters more than any single case: walked bar by bar over an oscillating
    // series, this scanner fires zero times. A crossover model would fire on every cycle.
    const c = cfg();
    const wave = bars(Array.from({ length: 260 }, (_, i) => ({
      close: +(100 + 2 * Math.sin(i / 9) + 0.35 * Math.sin(i / 2.3)).toFixed(2),
    })));

    let fired = 0;
    const why = new Set<string>();
    for (let i = 80; i < wave.length; i++) {
      const r = evaluate(wave.slice(0, i + 1), c);
      if (!r) continue;
      if (r.fired) fired++;
      else why.add(r.signal.blockers[0] ?? '');
    }
    assert.equal(fired, 0, `a range must produce no signals; refusals seen: ${[...why].join(' | ')}`);
    assert.ok(why.size > 0, 'and every refusal must be attributed to a named gate');
  });

  it('does not fire while the trend is still extended — a pullback is required', () => {
    const c = cfg();
    const r = evaluate(trendingBars(), c);
    assert.ok(r);
    assert.equal(r!.fired, false);
    assert.ok(r!.signal.blockers.some((x) => x.includes('not at the zone') || x.includes('no pullback')), r!.signal.blockers.join(' | '));
  });

  it('produces a WATCH row at the zone before the candle prints', () => {
    const c = cfg();
    const b = pullBackIntoZone(trendingBars(), c);
    const r = evaluate(b, c)!;
    assert.equal(r.fired, false);
    assert.ok(r.signal.blockers.some((x) => x.includes('no confirmation candle yet')), r.signal.blockers.join(' | '));
    assert.equal(worthWatching(r, c), true, 'this is exactly what the watchlist is for');
  });

  it('refuses an entry with no session left to hold it', () => {
    // A pullback entry is a 30-to-90-minute position. Taken at 15:25 it has five minutes, cannot
    // reach its target, and is closed into the auction's spread. Before this gate existed, a
    // 26-session replay of RELIANCE on the 5-minute chart produced seven trades, four of them entered
    // between 15:05 and 15:25, and those four accounted for the whole loss.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));

    // Re-stamp the tail onto the very end of the session, keeping the prices identical. `at` is what
    // the gate reads — `minuteOfSession` derives the session minute from the timestamp, not from the
    // fixture's own `minute` field — so both have to move together.
    const late = b.map((bar, k) => {
      if (k < b.length - 3) return bar;
      const minute = SESSION_MINUTES - 5 * (b.length - k);
      return { ...bar, minute, at: SESSION_START + 4 * DAY_MS + minute * 60_000 };
    });

    const read = readFromBars(late, 5, c);
    const trend = readTrend({ read, bars: late, spreadBps: 8, cfg: c });
    const p = readPullback({
      bars: late, series: computeSeries(late), timeframe: 5, direction: 1, avgVolume: read.avgVolume, cfg: c,
    });
    const r = evaluateSignal({
      symbol: "TEST", timeframe: 5, bars: late, read, trend, pullback: p, frames: { 5: read },
      price: late[late.length - 1].close, chain: null, spotAdjust: 0, lotSize: 250,
      lastFiredAt: null, cfg: c, nowMs: late[late.length - 1].at,
    })!;

    assert.equal(r.fired, false);
    assert.ok(r.signal.blockers.some((x) => x.includes("minutes of session left")), r.signal.blockers.join(" | "));
  });

  it('refuses a second signal on the same leg inside the cooldown', () => {
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const fresh = evaluate(b, c)!;
    const repeat = evaluate(b, c, { lastFiredAt: fresh.signal.firedAt - 60_000 })!;

    assert.equal(fresh.fired, true);
    assert.equal(repeat.fired, false);
    assert.ok(repeat.signal.blockers.some((x) => x.includes('cooldown')), repeat.signal.blockers.join(' | '));
  });

  it('refuses the signal outright when the only tradable contract is illiquid', () => {
    // The brief lists "very low option liquidity" among the suppressing conditions, and it is right
    // to: this module's output is an option order, and a book four rupees wide turns a 2R plan into
    // something else before the stock moves.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const dead = chain(b[b.length - 1].close);
    for (const row of dead.rows) if (row.call) Object.assign(row.call, { oi: 20, volume: 0, bid: 1, ask: 9 });

    const r = evaluate(b, c, { chain: dead })!;
    assert.equal(r.fired, false);
    assert.ok(r.signal.blockers.some((x) => x.includes('liquidity')), r.signal.blockers.join(' | '));
  });

  it('leaves the signal intact when the illiquidity veto is switched off', () => {
    const c = cfg((x) => { x.option.vetoSignalOnIlliquidOption = false; });
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const dead = chain(b[b.length - 1].close);
    for (const row of dead.rows) if (row.call) Object.assign(row.call, { oi: 20, volume: 0, bid: 1, ask: 9 });

    const r = evaluate(b, c, { chain: dead })!;
    assert.equal(r.fired, true, r.signal.blockers.join(' | '));
    assert.ok((r.signal.option?.warnings.length ?? 0) > 0, 'the contract must still carry its warnings');
  });

  it('has no signal without a chain, and still has a complete price plan', () => {
    // Most of the board is not enriched on any given cycle. A row without a contract is still a
    // tradable plan on the underlying, and must not be silently downgraded.
    const c = cfg();
    const b = confirmBullish(pullBackIntoZone(trendingBars(), c));
    const r = evaluate(b, c, { chain: null })!;
    assert.equal(r.fired, true, r.signal.blockers.join(' | '));
    assert.equal(r.signal.option, null);
    assert.ok(r.signal.stop.recommended.price > 0 && r.signal.target.primary.price > 0);
  });
});

/* -------------------------------------------------------------------------- config --- */

describe('config repair', () => {
  it('keeps the ADX trend line at or above the veto line', () => {
    // Inverted, every row would simultaneously fail to trend and fail to be vetoed — a board of
    // stocks that pass every check and never fire.
    const c = sanitise(Object.assign(defaultConfig(), { trend: { ...defaultConfig().trend, adxTrend: 10, adxVeto: 30 } }));
    assert.ok(c.trend.adxTrend >= c.trend.adxVeto);
  });

  it('drops a signal timeframe that is not computed', () => {
    // A signal timeframe with no frame behind it would silently never fire.
    const base = defaultConfig();
    const c = sanitise(Object.assign(base, {
      timeframes: { ...base.timeframes, computed: [5, 15] as Timeframe[], signal: [1, 3, 5] as Timeframe[] },
    }));
    assert.deepEqual(c.timeframes.signal, [5]);
  });

  it('restores the score weights when every one is zeroed', () => {
    const base = defaultConfig();
    const c = sanitise(Object.assign(base, {
      score: { ...base.score, weights: { trend: 0, volume: 0, vwap: 0, ema: 0, structure: 0, adx: 0 } },
    }));
    assert.equal(Object.values(c.score.weights).reduce((a, b) => a + b, 0), 100);
  });

  it('orders the confidence bands', () => {
    const base = defaultConfig();
    const c = sanitise(Object.assign(base, {
      score: { ...base.score, bands: { excellent: 20, strong: 60, medium: 90 } },
    }));
    assert.ok(c.score.bands.excellent >= c.score.bands.strong);
    assert.ok(c.score.bands.strong >= c.score.bands.medium);
  });

  it('sorts knot lists so a curve is monotonic in `at`', () => {
    const base = defaultConfig();
    const c = sanitise(Object.assign(base, {
      score: { ...base.score, curves: { ...base.score.curves, adx: [{ at: 40, score: 100 }, { at: 15, score: 0 }] } },
    }));
    assert.deepEqual(c.score.curves.adx.map((k) => k.at), [15, 40]);
  });
});

/* ------------------------------------------------------------------------- helpers --- */

describe('structure helpers', () => {
  it('measures the consolidation span over the window, not the mean bar range', () => {
    // A stock alternating ±1 ATR bars has a large mean range and no net span, and it is exactly the
    // tape that shreds a pullback entry. The span is what says "nothing is being decided here".
    const choppy = bars(Array.from({ length: 20 }, (_, i) => ({ close: 100 + (i % 2 ? 1 : -1), wick: 0.1 })));
    const atr = atrSeries(choppy, 14).at(-1) ?? 1;
    const span = rangeAtr(choppy, 10, atr);
    assert.ok(span !== null && span < 3, `an alternating tape should span little: ${span}`);
  });

  it('has no ADX series at all on a series too short to seed it twice', () => {
    const s = adxSeries(bars(ramp(10, 100, 1)), 14);
    assert.ok(s.adx.every((v) => v === null));
  });
});
