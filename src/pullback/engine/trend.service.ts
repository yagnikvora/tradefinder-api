// Is this timeframe in a trend worth pulling back INTO?
//
// This service answers only that. It never looks at where price is relative to the EMA band —
// that is `pullback.service.ts` — and it never scores anything the confidence model scores
// again. Keeping the two apart is what makes the module testable: a trend read is a pure
// function of one timeframe's indicators plus the underlying's book, with no state and no
// clock, so the same call that runs on live data runs unchanged inside the backtest.
//
// THE CHECKLIST AND THE VETO LIST ARE DIFFERENT THINGS, and the brief is right to separate
// them. A failed CHECK means "this is not a trend" — the 20 EMA is below the 50, price is
// under VWAP, there is no higher low. A VETO means "this may well be a trend and it is still
// not tradable": both averages are flat, ADX says the moves are not arriving in a direction,
// the last ten bars have spanned less than two ATR, price is wedged in the gap between VWAP
// and the 20 EMA where neither reference can define a stop. Merging them would make a
// chopping stock indistinguishable from a directionless one, and the difference is whether
// waiting for this name is worth anything.
//
// THE NO-MAN'S-LAND VETO is the one worth reading twice, because it is the least obvious and
// it removes the most bad fills. When VWAP and the 20 EMA converge — which they do constantly
// on a stock that has been trending and is now digesting — and price sits between them, there
// are two references disagreeing by less than the day's noise. An entry taken there has its
// stop inside the spread of the two lines it was drawn from, and gets taken out by an
// oscillation that has nothing to do with whether the thesis was right.

import { curve, clamp, type Bar } from '../indicators/series.js';
import { rangeAtr } from '../indicators/structure.js';
import type { Check, PullbackConfig, TimeframeRead, TrendRead, TrendState } from '../types.js';

export interface TrendInput {
  read: TimeframeRead;
  bars: Bar[];
  /** Underlying bid-ask in basis points. Null when the book is one-sided or absent. */
  spreadBps: number | null;
  cfg: PullbackConfig;
}

const n2 = (v: number | null | undefined, suffix = ''): string =>
  v == null || Number.isNaN(v) ? '—' : `${v.toFixed(2)}${suffix}`;

const n3 = (v: number | null | undefined, suffix = ''): string =>
  v == null || Number.isNaN(v) ? '—' : `${v.toFixed(3)}${suffix}`;

/**
 * Which way the averages point, before anything is tested.
 *
 * The 9-versus-20 relationship alone, deliberately. Everything else in the checklist is then a
 * TEST of that hypothesis rather than an input to it — which is what lets `failed` be read as
 * "here is what a bullish reading of this chart is missing" instead of as an unattributed list.
 * A tie (they are equal to floating-point precision, which happens on a dead stock) is not a
 * direction and returns 0.
 */
function hypothesis(read: TimeframeRead): 1 | -1 | 0 {
  const { ema9, ema20 } = read.ema;
  if (ema9 === null || ema20 === null) return 0;
  if (ema9 === ema20) return 0;
  return ema9 > ema20 ? 1 : -1;
}

/**
 * How hard the averages are moving, 0–100.
 *
 * Scaled so that `flatSlopeAtrPerBar` — the veto line — scores 0 and four times it scores 100.
 * Tying the scale to the veto threshold rather than to an independent constant means an
 * operator who decides this universe needs a stricter definition of "flat" moves both the gate
 * and the score with one edit, instead of moving the gate and silently leaving the score
 * calibrated against the old one.
 */
function slopeScore(read: TimeframeRead, direction: 1 | -1, flat: number): number | null {
  const s9 = read.slope.ema9AtrPerBar;
  const s20 = read.slope.ema20AtrPerBar;
  if (s9 === null && s20 === null) return null;

  const scale = Math.max(1e-6, flat * 4);
  const signed = (v: number | null): number => (v === null ? 0 : clamp((v * direction) / scale, 0, 1) * 100);
  // The 20 carries more weight than the 9: it is the average the pullback is measured to, and
  // a 9 that is steep on a flat 20 is a bounce inside a range, which is the exact shape this
  // module is built to refuse.
  const parts = [
    s9 !== null ? { v: signed(s9), w: 0.4 } : null,
    s20 !== null ? { v: signed(s20), w: 0.6 } : null,
  ].filter(Boolean) as Array<{ v: number; w: number }>;
  const w = parts.reduce((a, p) => a + p.w, 0);
  return w > 0 ? parts.reduce((a, p) => a + p.v * p.w, 0) / w : null;
}

/**
 * Read the trend on one timeframe.
 *
 * Every check carries the reading that decided it, formatted, because the interesting case is
 * always the near miss: ADX at 24.6 with everything else green is a different animal from four
 * failures, and a boolean cannot say which.
 */
export function readTrend(i: TrendInput): TrendRead {
  const { read, cfg } = i;
  const t = cfg.trend;
  const checks: Check[] = [];
  const vetoes: string[] = [];

  if (read.warming)
    return {
      timeframe: read.timeframe,
      state: 'None',
      strength: 0,
      checks,
      failed: [read.note ?? 'not enough bars'],
      vetoes: [],
    };

  const dir = hypothesis(read);
  if (dir === 0)
    return {
      timeframe: read.timeframe,
      state: 'None',
      strength: 0,
      checks,
      failed: ['the 9 and 20 EMA are on top of each other — there is no direction to test'],
      vetoes: [],
    };

  const bull = dir === 1;
  const { ema9, ema20, ema50, ema200 } = read.ema;
  const close = read.close;
  const vwap = read.vwap;
  const atr = read.atr;
  const st = read.structure;

  const add = (key: string, label: string, ok: boolean, required: boolean, value: string): void => {
    checks.push({ key, label, ok, required, value });
  };

  /* ------------------------------------------------------------------ the checklist --- */

  add('emaStack9v20', bull ? '9 EMA above 20 EMA' : '9 EMA below 20 EMA', true, true,
    `${n2(ema9)} vs ${n2(ema20)}`);

  const stack50 = ema20 !== null && ema50 !== null && (bull ? ema20 > ema50 : ema20 < ema50);
  add('emaStack20v50', bull ? '20 EMA above 50 EMA' : '20 EMA below 50 EMA',
    ema50 === null ? false : stack50, t.requireEma50Stack,
    ema50 === null ? 'not warm' : `${n2(ema20)} vs ${n2(ema50)}`);

  const stack200 = ema200 !== null && close !== null && (bull ? close > ema200 : close < ema200);
  add('ema200', bull ? 'Price above 200 EMA' : 'Price below 200 EMA',
    ema200 === null ? false : stack200, t.requireEma200Stack,
    ema200 === null ? 'not warm' : `${n2(close)} vs ${n2(ema200)}`);

  const vsVwap = close !== null && vwap !== null && (bull ? close > vwap : close < vwap);
  add('vwap', bull ? 'Price above VWAP' : 'Price below VWAP', vsVwap, true,
    vwap === null ? 'no VWAP' : `${n2(read.distance.vwapAtr, ' ATR')}`);

  const vsEma20 = close !== null && ema20 !== null && (bull ? close > ema20 : close < ema20);
  add('priceVsEma20', bull ? 'Price above 20 EMA' : 'Price below 20 EMA', vsEma20, true,
    n2(read.distance.ema20Atr, ' ATR'));

  const hh = bull ? st.higherHigh : st.lowerLow;
  const hl = bull ? st.higherLow : st.lowerHigh;
  add('higherHigh', bull ? 'Higher high' : 'Lower low', hh, true,
    st.lastSwingHigh && st.priorSwingHigh
      ? `${n2(bull ? st.lastSwingHigh.price : st.lastSwingLow?.price ?? null)} vs ${n2(bull ? st.priorSwingHigh.price : st.priorSwingLow?.price ?? null)}`
      : (st.note ?? 'no swing pair'));
  add('higherLow', bull ? 'Higher low' : 'Lower high', hl, true,
    st.lastSwingLow && st.priorSwingLow
      ? `${n2(bull ? st.lastSwingLow.price : st.lastSwingHigh?.price ?? null)} vs ${n2(bull ? st.priorSwingLow.price : st.priorSwingHigh?.price ?? null)}`
      : (st.note ?? 'no swing pair'));

  const adx = read.adx.adx;
  add('adx', `ADX above ${t.adxTrend}`, adx !== null && adx >= t.adxTrend, true,
    adx === null ? 'warming' : `${adx.toFixed(1)}${read.adx.rising === true ? ' rising' : read.adx.rising === false ? ' falling' : ''}`);

  // Participation, not the last bar's ratio. `TimeframeRead.participation` sets out why: a
  // single-bar test is a coin flip in general and reliably FALSE during a pullback, which would
  // disqualify every setup at the moment it became one.
  const part = read.participation;
  add('volume', 'Volume above average', part !== null && part >= t.minVolumeRatio, true,
    part === null ? 'not enough volume history' : `${part.toFixed(2)}x the previous window`);

  // The directional index has to agree with the EMA hypothesis. It usually does; when it does
  // not, the averages are stacked from an old move and the current bars are going the other
  // way — the single most reliable way to be long a stock that has already turned.
  const di = read.adx.plusDi !== null && read.adx.minusDi !== null
    ? (bull ? read.adx.plusDi > read.adx.minusDi : read.adx.minusDi > read.adx.plusDi)
    : false;
  add('di', bull ? '+DI above −DI' : '−DI above +DI', di, false,
    read.adx.plusDi === null ? 'warming' : `${n2(read.adx.plusDi)} / ${n2(read.adx.minusDi)}`);

  /* ----------------------------------------------------------------------- vetoes --- */

  const s9 = read.slope.ema9AtrPerBar;
  const s20 = read.slope.ema20AtrPerBar;
  if (s9 !== null && Math.abs(s9) < t.flatSlopeAtrPerBar)
    vetoes.push(`the 9 EMA is flat (${n3(s9, ' ATR/bar')}, needs ${t.flatSlopeAtrPerBar}) — a pullback to a flat average is a range`);
  if (s20 !== null && Math.abs(s20) < t.flatSlopeAtrPerBar)
    vetoes.push(`the 20 EMA is flat (${n3(s20, ' ATR/bar')}, needs ${t.flatSlopeAtrPerBar})`);

  if (adx !== null && adx < t.adxVeto)
    vetoes.push(`ADX ${adx.toFixed(1)} is below ${t.adxVeto} — the moves are not arriving in a direction`);

  const span = rangeAtr(i.bars, t.consolidation.bars, atr);
  if (span !== null && span < t.consolidation.maxRangeAtr)
    vetoes.push(
      `the last ${t.consolidation.bars} bars have spanned only ${span.toFixed(2)} ATR — this is consolidation, ` +
      'and every average inside it is inside the noise',
    );

  // The no-man's-land. Both conditions are needed: the two references must be CLOSE TOGETHER
  // and price must be BETWEEN them. Either alone is unremarkable — price crosses a converged
  // pair constantly on the way through, and a wide gap between them is just a trending stock.
  if (close !== null && vwap !== null && ema20 !== null && atr && atr > 0) {
    const gapAtr = Math.abs(vwap - ema20) / atr;
    const between = (close - vwap) * (close - ema20) < 0;
    if (between && gapAtr <= t.noMansLandAtr)
      vetoes.push(
        `price is wedged between VWAP and the 20 EMA, which are ${gapAtr.toFixed(2)} ATR apart — ` +
        'there is no reference here to put a stop behind',
      );
  }

  if (part !== null && part < t.deadVolumeRatio)
    vetoes.push(`volume is ${part.toFixed(2)}x what this stock was trading a window ago — the tape is dead`);

  // Only vetoes when a two-sided book was actually observed. Outside market hours the book is
  // empty for everything, and a spread veto that fired on all 215 rows at 16:00 would read as
  // "the whole market is illiquid" rather than as "the market is shut".
  if (i.spreadBps !== null && i.spreadBps > t.maxSpreadBps)
    vetoes.push(`the underlying is quoted ${i.spreadBps.toFixed(0)} bps wide (limit ${t.maxSpreadBps}) — the fill will cost more than the edge`);

  /* ---------------------------------------------------------------------- verdict --- */

  const required = checks.filter((c) => c.required);
  const failed = required.filter((c) => !c.ok);
  const passRate = required.length ? (required.length - failed.length) / required.length : 0;

  const slope = slopeScore(read, dir, t.flatSlopeAtrPerBar);
  // 60/40 between "does the checklist hold" and "how hard is it moving". A trend that ticks
  // every box while barely sloping is a stock that will still be here in an hour, and a steep
  // one with a hole in the checklist is a move without a foundation under it. Neither is a
  // 100, and the split is what says so.
  const strength = Math.round(passRate * 60 + (slope ?? 50) * 0.4);

  const state: TrendState = failed.length || vetoes.length ? 'None' : bull ? 'Bullish' : 'Bearish';

  return {
    timeframe: read.timeframe,
    state,
    // Strength is reported whatever the verdict. A row that failed on one check and scores 71
    // is what the "upcoming pullbacks" card is built from — surfacing it as 0 because a gate
    // failed would delete the entire near-miss population, which is the population worth
    // watching.
    strength: clamp(strength, 0, 100),
    checks,
    failed: failed.map((c) => `${c.label} — ${c.value}`),
    vetoes,
  };
}

/**
 * A trend read for the score's alignment bonus, which asks a laxer question.
 *
 * The higher timeframe does not have to be a tradable setup in its own right — it has to be
 * pointing the same way. A 15-minute chart with a perfect stack and a merely adequate ADX is
 * exactly the context that makes a 5-minute pullback worth taking, and testing it against the
 * full gate would refuse the alignment on a technicality about a timeframe nobody is entering.
 */
export function agrees(read: TimeframeRead | undefined, direction: 1 | -1): boolean {
  if (!read || read.warming) return false;
  const { ema9, ema20 } = read.ema;
  if (ema9 === null || ema20 === null || read.close === null) return false;
  const stacked = direction === 1 ? ema9 > ema20 : ema9 < ema20;
  const priced = direction === 1 ? read.close > ema20 : read.close < ema20;
  return stacked && priced;
}

/** Piecewise helper re-exported so the score service has one import for its curves. */
export { curve };
