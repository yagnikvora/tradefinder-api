// The timing layer — the part that decides whether a strong row is still an ENTRY.
//
// These tests exist because the failure they guard against is invisible on screen. A board
// that signals late looks exactly like a board that signals well: both print high scores on
// stocks that are genuinely moving. The difference only shows up in the fill, days later,
// which is far too slow a feedback loop to develop against. So the properties that make a
// signal early are pinned down here instead:
//
//   a trigger keeps the timestamp of its FIRST firing, so "fresh" cannot drift;
//   a spent move is refused however strong it scores;
//   the last few minutes outvote the day when they disagree;
//   the option arithmetic says what the stock must do, not what would be nice.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { computePulse, pulseFactor, efficiencyOf, intervalRvol } from '../src/momentum/services/pulse.service.js';
import { selectStrike } from '../src/momentum/services/strike.service.js';
import { buildSignal, gateTradeType } from '../src/momentum/engine/signal.service.js';
import { observe, recordTrigger, readingAt, type SessionState, type SymbolSessionState, type VwapReading }
  from '../src/momentum/data/session-state.js';
import { defaultConfig } from '../src/momentum/config/defaults.js';
import { SESSION_MINUTES } from '../src/momentum/session.js';
import type { MomentumQuote } from '../src/momentum/data/quotes.js';
import type { SymbolBaseline } from '../src/momentum/data/baseline.js';
import type { GreeksReading } from '../src/momentum/services/greeks.service.js';
import type { ChainLeg, StockChain } from '../src/momentum/data/option-chain.js';

/* --------------------------------------------------------------------- fixtures --- */

const NOW = Date.UTC(2026, 6, 31, 6, 0); // 11:30 IST, mid-session
const STEP = 15_000;
/** Volume this fixture's stock normally trades every minute. */
const NORMAL_PER_MIN = 1000;

const quote = (over: Partial<MomentumQuote> = {}): MomentumQuote => ({
  symbol: 'TEST', instrumentKey: 'NSE_EQ|X', ltp: 100, prevClose: 100, netChange: 0, changePct: 0,
  open: 100, high: 100, low: 100, volume: 0, vwap: 100, turnoverCr: 50,
  openInterest: 0, oiDayHigh: 0, oiDayLow: 0, totalBuyQty: 0, totalSellQty: 0,
  bid: 99.9, ask: 100.1, bidQty: 500, askQty: 500, bidOrders: 5, askOrders: 5,
  depthCr: 2, hasBook: true, at: NOW, ...over,
});

/** ATR of ₹2 on a ₹100 stock — a 2% average day, which is ordinary for an F&O name. */
const baseline = (over: Partial<SymbolBaseline> = {}): SymbolBaseline => ({
  symbol: 'TEST',
  profile: Array.from({ length: SESSION_MINUTES + 1 }, (_, m) => m * NORMAL_PER_MIN),
  profileSessions: 20, avgDailyVolume: 375_000, avgDailyValueCr: 37.5,
  atr: 2, atrPct: 2, atrPeriod: 14, hv20: 30, hv252: 28, hvRank: 50, beta: 1,
  priorHigh: 105, priorLow: 95, prevHigh: 101, prevLow: 99, prevClose: 100,
  prevFuturesOi: null, dailyBars: 200, ...over,
});

/**
 * A price ring ending at `endMs`.
 *
 * `prices` are oldest-first at 15-second steps, which is the poll interval the model runs at.
 * Volume accrues at `perMinute`, so the interval RVOL of a window is exactly
 * `perMinute ÷ NORMAL_PER_MIN` and a test can ask for a 4x burst by name.
 */
function ring(prices: number[], perMinute = NORMAL_PER_MIN, endMs = NOW): VwapReading[] {
  const start = endMs - (prices.length - 1) * STEP;
  return prices.map((ltp, i) => {
    const at = start + i * STEP;
    const minutesIn = (at - start) / 60_000;
    return {
      at,
      // 135 = minutes past 09:15 at 11:30.
      minute: 135 + Math.round((at - NOW) / 60_000),
      vwap: 100,
      volume: Math.round(minutesIn * perMinute),
      turnover: Math.round(minutesIn * perMinute) * 100,
      ltp,
      high: Math.max(...prices.slice(0, i + 1)),
      low: Math.min(...prices.slice(0, i + 1)),
    };
  });
}

/**
 * The cumulative volume the ring has reached — what the live quote would be carrying.
 *
 * The burst is `quote.volume − ring[t−3min].volume`, so a fixture whose quote and ring
 * disagree measures a burst that never happened.
 */
const ringVolume = (r: VwapReading[]): number => r[r.length - 1].volume;

/** Continue an existing ring by `minutes` of drift toward `to`, as a live poll would. */
function advance(sym: SymbolSessionState, minutes: number, to: number, perMinute = NORMAL_PER_MIN): number {
  const last = sym.readings[sym.readings.length - 1];
  const steps = (minutes * 60_000) / STEP;
  for (let i = 1; i <= steps; i++) {
    const at = last.at + i * STEP;
    const ltp = last.ltp + ((to - last.ltp) * i) / steps;
    const prev = sym.readings[sym.readings.length - 1];
    sym.readings.push({
      at,
      minute: 135 + Math.round((at - NOW) / 60_000),
      vwap: 100,
      volume: Math.round(prev.volume + (STEP / 60_000) * perMinute),
      turnover: 0,
      ltp,
      high: Math.max(prev.high, ltp),
      low: Math.min(prev.low, ltp),
    });
  }
  return last.at + steps * STEP;
}

const state = (readings: VwapReading[], over: Partial<SymbolSessionState> = {}): SymbolSessionState => ({
  readings, openingRange: null, lastAtmDelta: null, lastFuturesOi: null, leg: null, events: [], ...over,
});

/** n readings of a flat base, then a run into `to` over the last `fastMin` minutes. */
function basePlusRun(baseAt: number, to: number, baseMin = 12, fastMin = 3): number[] {
  const baseCount = (baseMin * 60_000) / STEP;
  const runCount = (fastMin * 60_000) / STEP;
  const out: number[] = [];
  // A base with a little wobble in it, so "compressed" is a measurement and not a constant.
  for (let i = 0; i <= baseCount; i++) out.push(baseAt + (i % 2 === 0 ? 0 : 0.05));
  for (let i = 1; i <= runCount; i++) out.push(baseAt + ((to - baseAt) * i) / runCount);
  return out;
}

/**
 * A near-month chain on a ₹100 stock, ~30% IV, 10 days out.
 *
 * The absolute bid-ask is ₹0.10 across every strike, which is what a real book looks like —
 * and is the whole reason the far strikes are bad trades: ₹0.10 on a ₹2 premium is 5%, and
 * on a ₹0.20 premium it is 50%.
 */
const cleg = (over: Partial<ChainLeg>): ChainLeg => ({
  instrumentKey: 'NSE_FO|X', ltp: 1, closePrice: 1, volume: 1000, oi: 5000, prevOi: 4000,
  bid: 0.95, ask: 1.05, bidQty: 100, askQty: 100,
  delta: 0.5, gamma: 0.04, theta: -0.1, vega: 0.05, iv: 30, ...over,
});

const chain = (over: Partial<StockChain> = {}): StockChain => ({
  symbol: 'TEST', underlyingKey: 'NSE_EQ|X', expiry: '2026-08-25', expiryDays: 10,
  spot: 100, atmStrike: 100,
  rows: [
    { strike: 95,
      call: cleg({ instrumentKey: 'CE95', ltp: 5.3, delta: 0.84, gamma: 0.026, bid: 5.25, ask: 5.35 }),
      put: cleg({ instrumentKey: 'PE95', ltp: 0.35, delta: -0.16, gamma: 0.026, bid: 0.3, ask: 0.4 }) },
    { strike: 97.5,
      call: cleg({ instrumentKey: 'CE975', ltp: 3.4, delta: 0.68, gamma: 0.038, bid: 3.35, ask: 3.45 }),
      put: cleg({ instrumentKey: 'PE975', ltp: 1.0, delta: -0.32, gamma: 0.038, bid: 0.95, ask: 1.05 }) },
    { strike: 100,
      call: cleg({ instrumentKey: 'CE100', ltp: 2.0, delta: 0.53, gamma: 0.045, bid: 1.95, ask: 2.05 }),
      put: cleg({ instrumentKey: 'PE100', ltp: 2.0, delta: -0.47, gamma: 0.045, bid: 1.95, ask: 2.05 }) },
    { strike: 102.5,
      call: cleg({ instrumentKey: 'CE1025', ltp: 1.05, delta: 0.36, gamma: 0.042, bid: 1.0, ask: 1.1 }),
      put: cleg({ instrumentKey: 'PE1025', ltp: 3.5, delta: -0.64, gamma: 0.042, bid: 3.45, ask: 3.55 }) },
    { strike: 105,
      call: cleg({ instrumentKey: 'CE105', ltp: 0.2, delta: 0.21, gamma: 0.03, theta: -0.04, bid: 0.15, ask: 0.25 }),
      put: cleg({ instrumentKey: 'PE105', ltp: 5.4, delta: -0.79, gamma: 0.03, bid: 5.35, ask: 5.45 }) },
    { strike: 107.5,
      call: cleg({ instrumentKey: 'CE1075', ltp: 0.1, delta: 0.11, gamma: 0.02, theta: -0.03, bid: 0.05, ask: 0.15 }),
      put: cleg({ instrumentKey: 'PE1075', ltp: 7.6, delta: -0.89, gamma: 0.02, bid: 7.55, ask: 7.65 }) },
  ],
  ...over,
});

const greeks = (over: Partial<GreeksReading> = {}): GreeksReading => ({
  atmStrike: 100, callDelta: 0.5, putDelta: -0.5, callLtp: 2, putLtp: 2,
  gamma: 0.04, gammaPer1Pct: 0.04, theta: 0.5, vega: 0.1, straddle: 4, thetaBurnPct: 12.5,
  vegaPerIvPointPct: 2.5, deltaShift: 0.05, deltaBasis: 'measured', netChainDelta: 0,
  expectedMove: null, expiryDays: 10, ...over,
});

/* ---------------------------------------------------------------------- pulse --- */

describe('efficiencyOf', () => {
  it('is 1 on a straight line — every step went the same way', () => {
    assert.equal(efficiencyOf([100, 100.2, 100.4, 100.6]), 1);
  });

  it('falls as the path doubles back, which is what chop is', () => {
    const choppy = efficiencyOf([100, 100.4, 100.1, 100.5, 100.2, 100.6]) as number;
    assert.ok(choppy < 0.4, `expected heavy chop to score low, got ${choppy}`);
    // Same net move, both ways: 0.6 up over a much longer path.
    assert.ok(choppy < (efficiencyOf([100, 100.2, 100.4, 100.6]) as number));
  });

  it('is null on a flat stock rather than a perfect 1', () => {
    // Nothing moved, so nothing moved *directionally* either. Scoring that as perfectly
    // efficient would make every dead stock look like a clean trend.
    assert.equal(efficiencyOf([100, 100, 100, 100]), null);
  });

  it('is null before there is a path to measure', () => {
    assert.equal(efficiencyOf([100, 100.5]), null);
  });
});

describe('intervalRvol', () => {
  const b = baseline();

  it('divides by what the stock normally trades BETWEEN those minutes, not by a day average', () => {
    // Minutes 135→138 normally trade 3,000. Ten thousand traded is 3.33x.
    assert.equal(intervalRvol(b, 135, 138, 10_000), 3.33);
  });

  it('reads the same burst identically at the open and at lunch', () => {
    // The profile is linear in this fixture, so a real 3x is 3x wherever it lands. Against a
    // flat per-minute average it would not be: the same volume at 09:20 and at 13:20 are
    // very different events, and a signal that cannot tell them apart fires all morning.
    assert.equal(intervalRvol(b, 5, 8, 9_000), intervalRvol(b, 300, 303, 9_000));
  });

  it('is null where the stock normally trades nothing — not Infinity', () => {
    const dead = baseline({ profile: new Array(SESSION_MINUTES + 1).fill(0) });
    assert.equal(intervalRvol(dead, 135, 138, 10_000), null);
  });

  it('is null without a baseline profile at all', () => {
    assert.equal(intervalRvol(undefined, 135, 138, 10_000), null);
  });
});

describe('computePulse', () => {
  const cfg = defaultConfig();

  it('is not ready until the ring reaches back across the fast window', () => {
    const p = computePulse(quote(), state(ring([100, 100.1, 100.2])), baseline(), cfg, NOW);
    assert.equal(p.ready, false);
    assert.match(p.note ?? '', /warming up/);
  });

  it('measures velocity in ATR per minute, so a heavy stock and a jumpy one compare', () => {
    const prices = basePlusRun(100, 100.9);
    const heavy = computePulse(quote({ ltp: 100.9 }), state(ring(prices)), baseline(), cfg, NOW);
    // Same 0.9% move on a stock that ranges 4% a day is half the event.
    const jumpy = computePulse(quote({ ltp: 100.9 }), state(ring(prices)), baseline({ atr: 4, atrPct: 4 }), cfg, NOW);

    assert.ok(heavy.velocityAtrPerMin !== null && jumpy.velocityAtrPerMin !== null);
    assert.ok((heavy.velocityAtrPerMin as number) > (jumpy.velocityAtrPerMin as number) * 1.9);
    assert.equal(heavy.movePct, jumpy.movePct, 'the raw percent move is of course identical');
  });

  it('finds a compressed base behind the run and reports it as being broken', () => {
    const p = computePulse(quote({ ltp: 100.9 }), state(ring(basePlusRun(100, 100.9))), baseline(), cfg, NOW);
    assert.ok(p.base, 'a base should have been found');
    assert.equal(p.base?.compressed, true, '0.05 of range on a ₹2 ATR is a coil');
    assert.equal(p.base?.breaking, 'up');
  });

  it('does not call a wide range a base', () => {
    // The 12 minutes before the run covered a full ATR, so leaving it is not a coil break.
    const wide = [...Array.from({ length: 49 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 2)), 101, 101.5, 102];
    const p = computePulse(quote({ ltp: 102 }), state(ring(wide)), baseline(), cfg, NOW);
    assert.equal(p.base?.compressed, false);
  });

  it('reports how much of a normal day is already spent', () => {
    const q = quote({ ltp: 103, high: 103, low: 99.9, prevClose: 100 });
    const p = computePulse(q, state(ring(basePlusRun(100, 103))), baseline(), cfg, NOW);
    // True range 3.1 against an ATR of 2.
    assert.equal(p.atrUsed, 1.55);
  });

  it('measures the burst against the profile, so it spikes as the move starts', () => {
    const at = (perMinute: number) => {
      const r = ring(basePlusRun(100, 100.9), perMinute);
      return computePulse(quote({ ltp: 100.9, volume: ringVolume(r) }), state(r), baseline(), cfg, NOW);
    };
    // The stock's own norm is NORMAL_PER_MIN, so these are 1x and 4x by construction.
    assert.equal(at(NORMAL_PER_MIN).burstRvol, 1);
    assert.equal(at(NORMAL_PER_MIN * 4).burstRvol, 4);
  });

  it('pauses instead of measuring a stretched window when the feed has stalled', () => {
    // The ring stops at NOW; the clock says eight minutes later. A three-minute velocity
    // read off that is an eleven-minute velocity wearing the wrong label.
    const p = computePulse(quote({ ltp: 100.9 }), state(ring(basePlusRun(100, 100.9))), baseline(), cfg, NOW + 8 * 60_000);
    assert.equal(p.ready, false);
    assert.match(p.note ?? '', /has not updated/);
  });

  it('survives a symbol with no ATR baseline instead of going dark', () => {
    const p = computePulse(quote({ ltp: 100.9 }), state(ring(basePlusRun(100, 100.9))), undefined, cfg, NOW);
    assert.equal(p.ready, true);
    assert.equal(p.velocityAtrPerMin, null, 'unscalable without ATR');
    assert.ok(p.efficiency !== null, 'but persistence still measures');
  });
});

describe('pulseFactor', () => {
  const cfg = defaultConfig();

  it('scores a clean, high-volume ignition near the top', () => {
    const p = computePulse(quote({ ltp: 100.9, volume: 200_000 }), state(ring(basePlusRun(100, 100.9), 4000)), baseline(), cfg, NOW);
    const f = pulseFactor(p, cfg);
    assert.ok((f.score as number) > 80, `expected a strong pulse, got ${f.score}`);
    assert.ok(f.bias > 0.5, 'and a bullish vote');
  });

  it('scales the vote by persistence — a choppy path is not a directional statement', () => {
    const clean = basePlusRun(100, 100.6);
    // Same start, same finish, four times the travel to get there.
    const choppy = [...clean.slice(0, 49), 100.5, 100.1, 100.55, 100.15, 100.6, 100.2, 100.65, 100.25, 100.6, 100.2, 100.6, 100.6];

    const a = pulseFactor(computePulse(quote({ ltp: 100.6 }), state(ring(clean)), baseline(), cfg, NOW), cfg);
    const b = pulseFactor(computePulse(quote({ ltp: 100.6 }), state(ring(choppy)), baseline(), cfg, NOW), cfg);
    assert.ok(b.bias < a.bias, `chop must vote more quietly: ${b.bias} vs ${a.bias}`);
    assert.ok((b.score as number) < (a.score as number));
  });

  it('is unavailable rather than zero while the ring is still filling', () => {
    const f = pulseFactor(computePulse(quote(), state(ring([100, 100.1])), baseline(), defaultConfig(), NOW), defaultConfig());
    assert.equal(f.available, false);
    assert.equal(f.score, null);
  });
});

/* -------------------------------------------------------------- the leg tracker --- */

describe('leg tracking', () => {
  const openingMinutes = 15;

  const feed = (prices: number[], reversal: number): SymbolSessionState => {
    const s: SessionState = { day: '2026-07-31', symbols: {} };
    prices.forEach((ltp, i) => {
      observe(s, quote({ ltp, high: Math.max(...prices.slice(0, i + 1)), low: Math.min(...prices.slice(0, i + 1)), volume: (i + 1) * 100 }),
        openingMinutes, NOW - (prices.length - 1 - i) * STEP, reversal);
    });
    return s.symbols.TEST;
  };

  it('extends a leg through new extremes rather than restarting it', () => {
    const sym = feed([100, 100.3, 100.6, 100.9], 0.6);
    assert.equal(sym.leg?.direction, 1);
    assert.equal(sym.leg?.startPrice, 100);
    assert.equal(sym.leg?.extremePrice, 100.9);
  });

  it('ignores a pullback smaller than the reversal distance', () => {
    // ₹0.4 back on a ₹0.6 threshold is a breather, not a turn.
    const sym = feed([100, 100.9, 100.5], 0.6);
    assert.equal(sym.leg?.direction, 1, 'still an up leg');
    assert.equal(sym.leg?.extremePrice, 100.9);
  });

  it('turns once the full reversal is given back, and dates the new leg from the extreme', () => {
    const sym = feed([100, 100.9, 100.2], 0.6);
    assert.equal(sym.leg?.direction, -1);
    // Not from ₹100.2 where the turn was CONFIRMED — the leg began at the high. Dating it
    // from confirmation would report every reversal as younger and smaller than it was.
    assert.equal(sym.leg?.startPrice, 100.9);
  });

  it('scales the threshold to the stock — the same wobble turns one leg and not another', () => {
    const tight = feed([100, 100.9, 100.5], 0.2);
    const loose = feed([100, 100.9, 100.5], 0.6);
    assert.equal(tight.leg?.direction, -1);
    assert.equal(loose.leg?.direction, 1);
  });
});

describe('recordTrigger', () => {
  it('keeps the first firing’s timestamp so a signal cannot stay permanently new', () => {
    const sym = state([]);
    const first = recordTrigger(sym, 'orbBreak', 1, 100, NOW, 15 * 60_000);
    const again = recordTrigger(sym, 'orbBreak', 1, 101, NOW + 4 * 60_000, 15 * 60_000);

    assert.equal(again.at, first.at, 'the age is measured from when the move began');
    assert.equal(again.price, 100, 'and so is the entry reference');
    assert.equal(sym.events.length, 1, 'one event, not one per cycle');
  });

  it('lets the same trigger fire again once the cooldown has passed', () => {
    const sym = state([]);
    recordTrigger(sym, 'orbBreak', 1, 100, NOW, 15 * 60_000);
    const later = recordTrigger(sym, 'orbBreak', 1, 104, NOW + 20 * 60_000, 15 * 60_000);
    assert.equal(later.price, 104);
    assert.equal(sym.events.length, 2);
  });

  it('treats the two directions as different events', () => {
    const sym = state([]);
    recordTrigger(sym, 'vwapReclaim', 1, 100, NOW, 15 * 60_000);
    recordTrigger(sym, 'vwapLoss', -1, 99, NOW + 60_000, 15 * 60_000);
    assert.equal(sym.events.length, 2);
  });
});

describe('readingAt', () => {
  it('refuses a window the ring does not reach back across', () => {
    // Three minutes of ring cannot answer "where was it ten minutes ago", and guessing would
    // silently shorten every velocity window on a freshly restarted process.
    assert.equal(readingAt(state(ring(basePlusRun(100, 100.5, 1, 2))), 10 * 60_000, NOW), null);
  });

  it('picks the closest reading, not the first one older than the target', () => {
    const sym = state(ring([100, 101, 102, 103, 104, 105]));
    const r = readingAt(sym, 45_000, NOW);
    assert.equal(r?.at, NOW - 45_000);
  });
});

/* --------------------------------------------------------------------- signals --- */

describe('buildSignal', () => {
  const cfg = defaultConfig();

  /** The setup this whole layer is built to find: a coil, a break, and volume behind it. */
  const igniting = () => {
    const readings = ring(basePlusRun(100, 100.9), NORMAL_PER_MIN * 4);
    const sym = state(readings, {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    return scene(sym, { ltp: 100.9, high: 100.9, low: 99.95, vwap: 100.2 }, NOW);
  };

  /** Build the inputs for whatever the ring and the quote currently say. */
  function scene(
    sym: SymbolSessionState,
    q: { ltp: number; high: number; low: number; vwap: number; prevClose?: number },
    nowMs: number,
  ) {
    const quoteNow = quote({ ...q, prevClose: q.prevClose ?? 100, volume: ringVolume(sym.readings) });
    const pulse = computePulse(quoteNow, sym, baseline(), cfg, nowMs);
    return {
      quote: quoteNow,
      pulse,
      pulseScore: pulseFactor(pulse, cfg).score,
      symState: sym,
      baseline: baseline(),
      openingRange: null,
      greeks: greeks(),
      direction: 'Bullish' as const,
      liquidityScore: 80,
      config: cfg,
      nowMs,
    };
  }

  it('calls a fresh break off a coil an entry, and names the trigger', () => {
    const s = buildSignal(igniting());
    assert.equal(s.state, 'Igniting');
    assert.equal(s.action, 'Buy Call');
    assert.equal(s.trigger?.kind, 'baseBreak');
    assert.deepEqual(s.blockers, []);
    assert.ok(s.entryQuality > 60, `expected a strong entry, got ${s.entryQuality}`);
  });

  it('ages the trigger instead of re-stamping it every cycle', () => {
    const first = igniting();
    const fired = buildSignal(first);
    assert.equal(fired.trigger?.ageMin, 0);

    // Six minutes on, still holding under the high it made — no new event to fire, and the
    // one that did fire is six minutes old. A board that re-stamped it here would report a
    // six-minute-old entry as brand new for as long as the stock stayed up.
    const later = advance(first.symState as SymbolSessionState, 6, 100.75, NORMAL_PER_MIN * 4);
    const s = buildSignal(scene(first.symState as SymbolSessionState, { ltp: 100.75, high: 100.9, low: 99.95, vwap: 100.3 }, later));

    assert.equal(s.trigger?.at, NOW, 'the event keeps its own timestamp');
    assert.equal(s.trigger?.ageMin, 6);
    assert.ok((s.freshness ?? 100) < 60, `freshness must decay, got ${s.freshness}`);
  });

  it('refuses the entry once the trigger is older than the model acts on', () => {
    const first = igniting();
    buildSignal(first);
    const sym = first.symState as SymbolSessionState;
    const late = advance(sym, cfg.signal.maxTriggerAgeMin + 3, 100.8, NORMAL_PER_MIN * 4);
    const s = buildSignal(scene(sym, { ltp: 100.8, high: 100.9, low: 99.95, vwap: 100.4 }, late));

    assert.notEqual(s.action, 'Buy Call');
    assert.ok(s.blockers.some((b) => /fired \d+ minutes ago/.test(b)), s.blockers.join(' | '));
  });

  it('treats a shallow retracement as a pullback entry, not as a reversal', () => {
    // The distinction that decides whether the layer is usable: every healthy leg breathes,
    // and calling each breather a reversal would refuse the better of the two entries.
    const readings = ring(basePlusRun(100, 100.9), NORMAL_PER_MIN * 4);
    const sym = state(readings, {
      leg: { direction: 1, startAt: NOW - 6 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    const at = advance(sym, 3, 100.6, NORMAL_PER_MIN * 3);
    const s = buildSignal(scene(sym, { ltp: 100.6, high: 100.9, low: 99.95, vwap: 100.2 }, at));

    assert.equal(s.state, 'Extending', `expected a pullback inside a live leg, got ${s.state}`);
    assert.ok((s.pulse.pullback ?? 0) > 0.2 && (s.pulse.pullback ?? 1) < 0.55);
    assert.equal(s.action, 'Buy Call', 'traded with the leg, not with the last three minutes');
  });

  it('REFUSES A SPENT MOVE however strong the day looks — the failure this layer exists for', () => {
    const prices = basePlusRun(100, 103.5);
    const sym = state(ring(prices, 4000), {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100, extremeAt: NOW, extremePrice: 103.5, reversal: 0.6 },
    });
    // Up 3.5% on a stock whose whole average day is 2%: violent, well supported, and over.
    const q = quote({ ltp: 103.5, high: 103.5, low: 99.9, prevClose: 100, volume: 400_000, vwap: 101.5 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);

    const s = buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: greeks(), direction: 'Bullish', liquidityScore: 90, config: cfg, nowMs: NOW,
    });

    assert.equal(s.state, 'Extended');
    assert.equal(s.action, 'Stand Aside');
    assert.ok((s.extension.atrUsed ?? 0) > cfg.signal.extension.atrUsedMax);
    assert.ok(s.blockers.some((b) => b.includes('spent')), s.blockers.join(' | '));
    assert.ok(s.entryQuality < 40, 'and it must not look like a good entry');
  });

  it('says Reversing when the last minutes contradict the day', () => {
    // The day is up — change from the previous close is positive and price is over VWAP —
    // but the last three minutes are down. The cumulative factors cannot see this at all.
    const prices = [...basePlusRun(100, 102, 12, 1), 101.6, 101.2, 100.8, 100.5, 100.2, 100, 99.8, 99.6, 99.5, 99.4, 99.3, 99.2];
    const sym = state(ring(prices, 4000), {
      leg: { direction: -1, startAt: NOW - 3 * 60_000, startPrice: 102, extremeAt: NOW, extremePrice: 99.2, reversal: 0.6 },
    });
    const q = quote({ ltp: 99.2, high: 102, low: 99.2, prevClose: 98, volume: 300_000, vwap: 100.5 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);

    const s = buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: greeks(), direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    });

    assert.equal(s.microDirection, 'Bearish');
    assert.equal(s.aligned, false);
    assert.equal(s.state, 'Reversing');
    assert.notEqual(s.action, 'Buy Call');
  });

  it('will not signal on a stock nobody can get out of', () => {
    const s = buildSignal({ ...igniting(), liquidityScore: 10 });
    assert.notEqual(s.action, 'Buy Call');
    assert.ok(s.blockers.some((b) => b.includes('thin')), s.blockers.join(' | '));
  });

  it('stands aside while the ring is still filling rather than guessing', () => {
    const sym = state(ring([100, 100.2, 100.4]));
    const q = quote({ ltp: 100.4 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);
    const s = buildSignal({
      quote: q, pulse, pulseScore: null, symState: sym, baseline: baseline(), openingRange: null,
      greeks: null, direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    });
    assert.equal(s.state, 'Quiet');
    assert.equal(s.action, 'Stand Aside');
    assert.equal(s.trigger, null);
  });
});

describe('the option plan', () => {
  const cfg = defaultConfig();

  const planFor = (g: GreeksReading | null) => {
    const prices = basePlusRun(100, 100.9);
    const sym = state(ring(prices, 4000), {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    const q = quote({ ltp: 100.9, high: 100.9, low: 99.95, prevClose: 100, volume: 200_000, vwap: 100.2 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);
    return buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: g, direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    }).plan;
  };

  it('prices the target in option terms using the delta and premium actually quoted', () => {
    const plan = planFor(greeks());
    assert.ok(plan);
    assert.equal(plan?.basis, 'chain');
    // ~₹0.7 of underlying at a delta over 0.5 against a ₹2 premium is a large percentage —
    // which is the leverage the whole exercise is about, and why entering late costs so much.
    assert.ok((plan?.optionMovePctAtTarget ?? 0) > 15, `got ${plan?.optionMovePctAtTarget}`);
  });

  it('says how far the stock must go for the option gain being targeted', () => {
    const plan = planFor(greeks());
    // 35% of a ₹2 premium is ₹0.70 of option, which at ~0.5 delta needs ~₹1.4 of stock.
    const needed = plan?.underlyingMovePctForTargetOption as number;
    assert.ok(needed > 1.0 && needed < 1.8, `expected ~1.4%, got ${needed}`);
  });

  it('is honest when the room left cannot pay that gain', () => {
    // An expensive option needs a bigger move for the same percentage, and the room the
    // model thinks is left does not grow to match.
    const plan = planFor(greeks({ callLtp: 12 }));
    assert.equal(plan?.meetsOptionTarget, false);
  });

  it('falls back to a price-only plan when the chain has not been fetched', () => {
    const plan = planFor(null);
    assert.equal(plan?.basis, 'atr-only');
    assert.equal(plan?.optionMovePctAtTarget, null);
    assert.ok((plan?.target ?? 0) > (plan?.entry ?? 0), 'the price plan still stands');
  });

  it('never targets past the room it says is left', () => {
    const plan = planFor(greeks());
    const room = cfg.signal.extension.atrUsedMax - 0.475; // true range 0.95 on a ₹2 ATR
    assert.ok((plan?.target ?? 0) - (plan?.entry ?? 0) <= room * 2 + 1e-9);
  });
});

/* ------------------------------------------------------------- which contract --- */

describe('selectStrike', () => {
  const cfg = defaultConfig();
  const LOT = 250;

  /** A 0.9% target on a ₹100 stock — the size of move this whole model is built around. */
  const pickCall = (over: Partial<StockChain> = {}, config = cfg) =>
    selectStrike({ chain: chain(over), direction: 1, spot: 100, targetPrice: 100.9, lotSize: LOT, config });

  it('buys a call to the upside and a put to the downside', () => {
    assert.equal(pickCall()?.type, 'CE');
    const put = selectStrike({ chain: chain(), direction: -1, spot: 100, targetPrice: 99.1, lotSize: LOT, config: cfg });
    assert.equal(put?.type, 'PE');
    assert.ok((put?.strike ?? 999) <= 100, 'a put is out of the money BELOW the spot');
  });

  it('takes the best net payoff at the target, not the nearest strike', () => {
    const c = pickCall();
    assert.equal(c?.strike, 102.5);
    assert.equal(c?.moneyness, 'OTM');
    assert.equal(c?.stepsFromAtm, 1);
    // ₹1.10 to ~₹1.24 net of the book — better than the ATM's ₹2.05 to ~₹2.45 in percentage
    // terms, which is the entire reason the picker exists.
    assert.ok((c?.gainPctAtTarget ?? 0) > 20, `expected >20%, got ${c?.gainPctAtTarget}`);
  });

  it('REFUSES to walk out to a strike that no longer tracks the stock', () => {
    // The 105 CE shows a bigger percentage on paper — ₹0.25 in, ~₹0.35 out — and a delta of
    // 0.21 means the move the plan is built on barely reaches it. Ranking on payoff alone
    // always ends at the cheapest strike on the board; the delta floor is what stops it.
    const c = pickCall();
    assert.notEqual(c?.strike, 105);
    assert.ok(Math.abs(c?.delta ?? 0) >= cfg.signal.strike.minDelta);

    // Proof that the floor is what did it, and not something else about that strike.
    const loose = defaultConfig();
    loose.signal.strike.minDelta = 0.15;
    assert.equal(pickCall({}, loose)?.strike, 105, 'with the floor lowered it wins on payoff');
  });

  it('demotes a strike whose book eats the move', () => {
    // Same 102.5 CE, same greeks, quoted 0.80 × 1.30 instead of 1.00 × 1.10. You now buy at
    // 1.30 and sell at the bid, so a move that "pays 22%" pays nothing at all.
    const wide = chain();
    wide.rows[3].call = cleg({ instrumentKey: 'CE1025', ltp: 1.05, delta: 0.36, gamma: 0.042, bid: 0.8, ask: 1.3 });
    const c = selectStrike({ chain: wide, direction: 1, spot: 100, targetPrice: 100.9, lotSize: LOT, config: cfg });
    assert.equal(c?.strike, 100, 'the ATM, whose book is tight, is now the better trade');
  });

  it('reports what it costs and where it breaks even, not just a percentage', () => {
    const c = pickCall();
    assert.equal(c?.label, '102.5 CE');
    assert.equal(c?.instrumentKey, 'CE1025');
    assert.equal(c?.entryCost, 1.1, 'the ask — what you actually pay, not the mid');
    assert.equal(c?.costPerLot, Math.round(1.1 * LOT));
    assert.equal(c?.breakEven, 103.6, 'strike + what you paid');
    assert.ok((c?.profitPerLot ?? 0) > 0);
    assert.equal(c?.expiryDays, 10);
  });

  it('names the contract anyway when nothing clears the floors, with the reason attached', () => {
    // A chain nobody is trading. Silence here is indistinguishable from the chain failing to
    // load, so it answers "this one, but —" instead.
    const dead = chain();
    for (const r of dead.rows) {
      if (r.call) r.call.oi = 0;
      if (r.put) r.put.oi = 0;
    }
    const c = selectStrike({ chain: dead, direction: 1, spot: 100, targetPrice: 100.9, lotSize: LOT, config: cfg });
    assert.equal(c?.strike, 100, 'falls back to the money');
    assert.match(c?.reason ?? '', /nearest strike/);
    assert.ok((c?.warnings.length ?? 0) > 0, 'and says what is wrong with it');
  });

  it('flags a thin or wide contract instead of quietly hiding it', () => {
    const thin = chain();
    thin.rows[3].call = cleg({ instrumentKey: 'CE1025', ltp: 1.05, delta: 0.36, gamma: 0.042, bid: 1.0, ask: 1.1, oi: 1200, volume: 0 });
    const c = selectStrike({ chain: thin, direction: 1, spot: 100, targetPrice: 100.9, lotSize: LOT, config: cfg });
    assert.equal(c?.strike, 102.5);
    assert.ok(c?.warnings.some((w) => /nothing has traded/.test(w)), c?.warnings.join(' | '));
  });

  it('is null without a chain — the row simply has no contract to name', () => {
    assert.equal(selectStrike({ chain: null, direction: 1, spot: 100, targetPrice: 100.9, lotSize: LOT, config: cfg }), null);
  });
});

describe('the signal carries the contract', () => {
  const cfg = defaultConfig();

  it('names a strike once the row has been enriched, and prices the plan off it', () => {
    const readings = ring(basePlusRun(100, 100.9), NORMAL_PER_MIN * 4);
    const sym = state(readings, {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    const q = quote({ ltp: 100.9, high: 100.9, low: 99.95, prevClose: 100, volume: readings[readings.length - 1].volume, vwap: 100.2 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);

    const s = buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: greeks(), chain: chain(), lotSize: 250,
      direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    });

    assert.ok(s.strike, 'an enriched row must name the contract to buy');
    assert.equal(s.strike?.type, 'CE');
    assert.equal(s.plan?.basis, 'strike', 'and the plan prices THAT contract, not a notional ATM one');
    assert.equal(s.plan?.optionMovePctAtTarget, s.strike?.gainPctAtTarget, 'one number, not two that can disagree');
    assert.ok(s.reasons.some((r) => r.text.startsWith('Buy ')), s.reasons.map((r) => r.text).join(' | '));
  });

  it('still carries a price plan with no strike when the row was never enriched', () => {
    const readings = ring(basePlusRun(100, 100.9), NORMAL_PER_MIN * 4);
    const sym = state(readings, {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    const q = quote({ ltp: 100.9, high: 100.9, low: 99.95, prevClose: 100, volume: readings[readings.length - 1].volume, vwap: 100.2 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);

    const s = buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: null, chain: null, lotSize: 250,
      direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    });

    assert.equal(s.strike, null);
    assert.equal(s.plan?.basis, 'atr-only');
    assert.ok((s.plan?.target ?? 0) > (s.plan?.entry ?? 0));
  });

  it('blocks the entry when the only tradable contract is quoted absurdly wide', () => {
    const readings = ring(basePlusRun(100, 100.9), NORMAL_PER_MIN * 4);
    const sym = state(readings, {
      leg: { direction: 1, startAt: NOW - 3 * 60_000, startPrice: 100.05, extremeAt: NOW, extremePrice: 100.9, reversal: 0.6 },
    });
    const q = quote({ ltp: 100.9, high: 100.9, low: 99.95, prevClose: 100, volume: readings[readings.length - 1].volume, vwap: 100.2 });
    const pulse = computePulse(q, sym, baseline(), cfg, NOW);

    // Every strike quoted a rupee wide on a two-rupee option. The stock setup is perfect and
    // there is still no trade here.
    const awful = chain();
    for (const r of awful.rows) {
      if (r.call) { r.call.bid = Math.max(0.05, r.call.ltp - 0.5); r.call.ask = r.call.ltp + 0.5; }
    }

    const s = buildSignal({
      quote: q, pulse, pulseScore: pulseFactor(pulse, cfg).score, symState: sym, baseline: baseline(),
      openingRange: null, greeks: greeks(), chain: awful, lotSize: 250,
      direction: 'Bullish', liquidityScore: 80, config: cfg, nowMs: NOW,
    });

    assert.notEqual(s.action, 'Buy Call');
    assert.ok(s.blockers.some((b) => /spread eats the trade/.test(b)), s.blockers.join(' | '));
  });
});

describe('gateTradeType', () => {
  const cfg = defaultConfig();
  const signalWith = (over: Record<string, unknown>) =>
    ({ state: 'Igniting', action: 'Buy Call', entryQuality: 70, freshness: 90, trigger: null,
       microDirection: 'Bullish', aligned: true, pulse: { ready: true } as never, extension: {} as never,
       plan: null, reasons: [], blockers: [], ...over } as never);

  it('lets a buy through when the timing layer agrees', () => {
    assert.equal(gateTradeType('Momentum Buy', signalWith({ action: 'Buy Call' }), cfg), 'Momentum Buy');
    assert.equal(gateTradeType('Momentum Sell', signalWith({ action: 'Buy Put' }), cfg), 'Momentum Sell');
  });

  it('downgrades a buy the timing layer will not stand behind — it does not delete it', () => {
    // Watch, not Avoid: the model still likes the stock and the reader should still see it.
    assert.equal(gateTradeType('Momentum Buy', signalWith({ action: 'Watch' }), cfg), 'Watch');
    assert.equal(gateTradeType('Momentum Buy', signalWith({ action: 'Stand Aside' }), cfg), 'Watch');
  });

  it('never promotes something the score itself refused', () => {
    assert.equal(gateTradeType('Avoid', signalWith({ action: 'Buy Call' }), cfg), 'Avoid');
  });

  it('is a no-op when the layer is switched off', () => {
    const off = defaultConfig();
    off.signal.gateTradeType = false;
    assert.equal(gateTradeType('Momentum Buy', signalWith({ action: 'Watch' }), off), 'Momentum Buy');
  });
});
