// The pullback itself — the part that is not a crossover.
//
// The brief's sequence, in order, and each step is a separate measurement here because each
// one fails differently:
//
//   1. TREND UP                 `trend.service.ts` — already settled before this runs.
//   2. PRICE MOVES AWAY         an impulse leg that got at least `minImpulseAtr` clear of the
//                               EMA band. Without this there is nothing to pull back FROM,
//                               and every wobble around a rising average reads as a setup.
//   3. PRICE PULLS BACK         a measured retracement of that leg, inside a band. Under
//                               `minRetracement` nothing has happened; over `maxRetracement`
//                               the leg is being reversed rather than retraced.
//   4. TOUCHES 9 / 20 / VWAP    the zone. A BAND, not a line — see below.
//   5. BULLISH CANDLE           `indicators/patterns.ts`, on a closed bar.
//   6. VOLUME INCREASES         against that timeframe's own 20-bar mean.
//   7. SIGNAL                   `signal.service.ts` assembles it.
//
// WHY THE ZONE IS A BAND. Price does not touch a moving average to the paisa, and the three
// references the brief names are three different lines that are usually a few tenths of an ATR
// apart. Testing "did the low reach the 20 EMA" produces a scanner that misses the setup by
// four paise several times a day and fires on it once a week. The zone spans the outermost and
// innermost of {9 EMA, 20 EMA, VWAP} widened by `zoneToleranceAtr` either side, which is what
// the band looks like on the chart the trade is taken from.
//
// WHY THE RETRACEMENT IS MEASURED FROM THE LEG AND THE DEPTH FROM THE EXTREME. Two rulers,
// because they answer different questions and each is unreliable where the other is not.
// `retracement` is a fraction of the impulse and is what says whether the trend is intact —
// but it is undefined until there IS an impulse, and it swings wildly when the leg is short.
// `depthAtr` is distance from the session extreme in ATR and is always defined, which is what
// the risk model and the alerting read. Carrying only the first is how a pullback tracker ends
// up reporting a near-zero retracement at the exact moment the dip is at its deepest, because
// a dip large enough to be worth entering is often large enough to redefine the leg.

import { classify, bodyRatio, PATTERN_STRENGTH } from '../indicators/patterns.js';
import type { Bar } from '../indicators/series.js';
import type { FrameSeries } from '../data/frames.js';
import type {
  ConfirmationRead, PullbackConfig, PullbackPhase, PullbackRead, Timeframe, ZoneTouch,
} from '../types.js';
import { PATTERN_LABEL } from '../types.js';

export interface PullbackInput {
  bars: Bar[];
  series: FrameSeries;
  timeframe: Timeframe;
  direction: 1 | -1;
  /** The 20-bar mean volume from the frame read, so both agree on one denominator. */
  avgVolume: number | null;
  cfg: PullbackConfig;
}

interface Zone {
  top: number;
  bottom: number;
}

/**
 * The pullback zone at bar `i`.
 *
 * Null when fewer than two of the three references are warm — a "zone" defined by one average
 * is a line, and calling it a zone would let the tolerance do all the work.
 */
function zoneAt(s: FrameSeries, i: number, tolerance: number): Zone | null {
  const values = [s.ema9[i], s.ema20[i], s.vwap[i]].filter((v): v is number => v !== null && v > 0);
  if (values.length < 2) return null;
  return { top: Math.max(...values) + tolerance, bottom: Math.min(...values) - tolerance };
}

const empty = (timeframe: Timeframe, direction: 1 | -1 | 0, note: string): PullbackRead => ({
  timeframe,
  phase: 'None',
  direction,
  zone: null,
  touch: { ema9: false, ema20: false, vwap: false, nearest: null },
  barsInZone: null,
  impulse: null,
  retracement: null,
  extreme: null,
  depthAtr: null,
  confirmation: null,
  note,
});

/**
 * How far back an impulse leg is looked for.
 *
 * Derived from `maxBarsInZone` rather than configured separately, so an operator who decides
 * their universe needs a longer patience at the zone gets a proportionally longer memory for
 * the leg that zone belongs to. Two independent settings would drift apart, and the failure
 * would be silent: a scanner that waits ten bars at a zone belonging to a leg it has already
 * forgotten reports pullbacks with no impulse behind them.
 */
const impulseLookback = (cfg: PullbackConfig): number => Math.max(20, cfg.pullback.maxBarsInZone * 5);

export function readPullback(i: PullbackInput): PullbackRead {
  const { bars, series: s, cfg, direction: dir, timeframe } = i;
  const p = cfg.pullback;
  const n = bars.length;
  const lastIdx = n - 1;
  const atr = s.atr[lastIdx];

  if (n < 10 || !atr || !(atr > 0)) return empty(timeframe, dir, 'not enough bars, or ATR is not warm');

  const tolerance = p.zoneToleranceAtr * atr;
  const zone = zoneAt(s, lastIdx, tolerance);
  if (!zone) return empty(timeframe, dir, 'fewer than two of {9 EMA, 20 EMA, VWAP} are warm — no zone to define');

  const bull = dir === 1;
  const from = Math.max(0, n - impulseLookback(cfg));

  /* ------------------------------------------------------------------- the impulse --- */

  // The leg's extreme: the furthest price got in the trend's direction inside the window.
  let extremeIdx = from;
  for (let k = from; k < n; k++) {
    if (bull ? bars[k].high > bars[extremeIdx].high : bars[k].low < bars[extremeIdx].low) extremeIdx = k;
  }

  // And where it started: the counter-extreme BEFORE it. Searching only the prefix is what
  // makes this the leg rather than the whole window's range — a low made after the high
  // belongs to the retracement being measured, not to the impulse being retraced.
  let startIdx = from;
  for (let k = from; k <= extremeIdx; k++) {
    if (bull ? bars[k].low < bars[startIdx].low : bars[k].high > bars[startIdx].high) startIdx = k;
  }

  const fromPrice = bull ? bars[startIdx].low : bars[startIdx].high;
  const toPrice = bull ? bars[extremeIdx].high : bars[extremeIdx].low;
  const legSize = Math.abs(toPrice - fromPrice);

  if (extremeIdx <= startIdx || legSize < p.minImpulseAtr * atr)
    return {
      ...empty(timeframe, dir, `no impulse leg — the last ${impulseLookback(cfg)} bars span ${(legSize / atr).toFixed(2)} ATR, needs ${p.minImpulseAtr}`),
      zone,
    };

  // "Price moves away" measured against the ZONE, which is the brief's actual condition and a
  // stricter one than leg length. A stock can travel 2 ATR while never leaving the EMA band —
  // a grinding trend where the averages travel with it — and there is no pullback to take in
  // that, because price is already where a pullback would arrive.
  const zoneAtExtreme = zoneAt(s, extremeIdx, tolerance);
  const separation = zoneAtExtreme
    ? (bull ? toPrice - zoneAtExtreme.top : zoneAtExtreme.bottom - toPrice) / atr
    : null;
  if (separation !== null && separation < p.minImpulseAtr)
    return {
      ...empty(timeframe, dir, `price never got clear of the EMA band — ${separation.toFixed(2)} ATR at the extreme, needs ${p.minImpulseAtr}`),
      zone,
      impulse: { fromPrice, toPrice, fromAt: bars[startIdx].at, toAt: bars[extremeIdx].at, atr },
    };

  /* --------------------------------------------------------------- the retracement --- */

  let retraceExtreme = bull ? bars[extremeIdx].low : bars[extremeIdx].high;
  for (let k = extremeIdx; k < n; k++) {
    if (bull ? bars[k].low < retraceExtreme : bars[k].high > retraceExtreme)
      retraceExtreme = bull ? bars[k].low : bars[k].high;
  }
  const givenBack = Math.abs(toPrice - retraceExtreme);
  const retracement = +(givenBack / legSize).toFixed(3);
  const depthAtr = +(givenBack / atr).toFixed(3);

  /* --------------------------------------------------------------------- the touch --- */

  // The first bar at or after the extreme whose extreme reached into the zone AS IT WAS AT
  // THAT BAR. Using today's zone to test a bar from forty minutes ago would test against a
  // band that has since travelled — on a trending stock that is a fifth of an ATR a bar, and
  // it silently converts "price came back to the average" into "the average came up to price".
  let touchIdx: number | null = null;
  const touch: ZoneTouch = { ema9: false, ema20: false, vwap: false, nearest: null };

  for (let k = extremeIdx; k < n; k++) {
    const z = zoneAt(s, k, tolerance);
    if (!z) continue;
    const reached = bull ? bars[k].low <= z.top : bars[k].high >= z.bottom;
    if (!reached) continue;
    if (touchIdx === null) touchIdx = k;

    const price = bull ? bars[k].low : bars[k].high;
    const hit = (v: number | null): boolean =>
      v !== null && v > 0 && (bull ? price <= v + tolerance : price >= v - tolerance);
    if (hit(s.ema9[k])) touch.ema9 = true;
    if (hit(s.ema20[k])) touch.ema20 = true;
    if (hit(s.vwap[k])) touch.vwap = true;
  }

  if (touchIdx !== null) {
    // The headline average: the one the retracement extreme actually came closest to. Reported
    // rather than assumed to be the 20, because on a trend day VWAP is frequently the deepest
    // of the three and "pulled back to VWAP" is the more useful sentence.
    const candidates: Array<{ key: 'ema9' | 'ema20' | 'vwap'; v: number | null }> = [
      { key: 'ema9', v: s.ema9[lastIdx] }, { key: 'ema20', v: s.ema20[lastIdx] }, { key: 'vwap', v: s.vwap[lastIdx] },
    ];
    let best: { key: 'ema9' | 'ema20' | 'vwap'; d: number } | null = null;
    for (const c of candidates) {
      if (!touch[c.key] || c.v === null) continue;
      const d = Math.abs(retraceExtreme - c.v);
      if (!best || d < best.d) best = { key: c.key, d };
    }
    touch.nearest = best?.key ?? null;
  }

  const barsInZone = touchIdx === null ? null : n - touchIdx;

  /* ------------------------------------------------------------------- the verdict --- */

  const base = {
    timeframe,
    direction: dir,
    zone,
    touch,
    barsInZone,
    impulse: { fromPrice, toPrice, fromAt: bars[startIdx].at, toAt: bars[extremeIdx].at, atr },
    retracement,
    extreme: retraceExtreme,
    depthAtr,
  };

  const close = bars[lastIdx].close;
  const brokeThrough = bull
    ? close < zone.bottom - p.rejectionAtr * atr
    : close > zone.top + p.rejectionAtr * atr;

  // Failure first, because a failed pullback also satisfies "touched the zone" and would
  // otherwise be published as a live setup. The distinction matters more than any other in this
  // function: somebody who entered on the touch is now wrong, and this is the state that says so.
  if (retracement > p.maxRetracement || brokeThrough)
    return {
      ...base,
      phase: 'Failed',
      confirmation: null,
      note: brokeThrough
        ? `price closed ${p.rejectionAtr} ATR through the far side of the zone — this is a break, not a pullback`
        : `retraced ${(retracement * 100).toFixed(0)}% of the leg (limit ${(p.maxRetracement * 100).toFixed(0)}%) — the trend structure is gone`,
    };

  if (touchIdx === null)
    return {
      ...base,
      phase: retracement >= p.minRetracement ? 'PullingBack' : 'Impulse',
      confirmation: null,
      note: retracement >= p.minRetracement
        ? `retraced ${(retracement * 100).toFixed(0)}% but has not reached the zone yet`
        : `still extended — ${(retracement * 100).toFixed(0)}% given back`,
    };

  if (barsInZone !== null && barsInZone > p.maxBarsInZone)
    return {
      ...base,
      phase: 'Failed',
      confirmation: null,
      note: `${barsInZone} bars at the zone without a turn (limit ${p.maxBarsInZone}) — this has stopped being a pullback and become a range`,
    };

  if (retracement < p.minRetracement)
    return {
      ...base,
      phase: 'AtZone',
      confirmation: null,
      note: `touched the zone on only a ${(retracement * 100).toFixed(0)}% retracement — the averages caught up to price rather than price coming back`,
    };

  const confirmation = findConfirmation(i, touchIdx, atr);
  return {
    ...base,
    phase: confirmation ? 'Resuming' : 'AtZone',
    confirmation,
    note: confirmation
      ? undefined
      : `at the ${touch.nearest === 'vwap' ? 'VWAP' : touch.nearest === 'ema9' ? '9 EMA' : '20 EMA'}, waiting for a ${bull ? 'bullish' : 'bearish'} candle on volume`,
  };
}

/**
 * The volume expansion of bar `k`, against the `lookback` bars IMMEDIATELY BEFORE IT.
 *
 * The frame read's `avgVolume` is the mean of the window ending at the LAST bar, and using it for
 * a confirmation that is not the last bar is wrong in the one direction that matters. A
 * confirmation two bars back is then measured against a window that CONTAINS it, so the bar
 * inflates its own benchmark — which is exactly the trap `readFrame` documents and avoids for the
 * last bar and then reintroduces for every earlier one. A big turn two bars ago reads as 1.6x
 * where it was 2.1x, and `minConfirmationVolumeRatio` refuses it: the error suppresses the
 * strongest confirmations specifically, because the bigger the bar, the more it poisons its own
 * denominator.
 *
 * Falls back to the frame's figure only when there is not enough history before `k` to build a
 * window, which on a warm frame never happens.
 */
function volumeRatioAt(
  bars: Bar[],
  k: number,
  lookback: number,
  fallbackAvg: number | null,
): number | null {
  const from = k - Math.max(2, lookback);
  const window = from >= 0 ? bars.slice(from, k) : [];
  const avg = window.length
    ? window.reduce((a, b) => a + b.volume, 0) / window.length
    : (fallbackAvg ?? 0);
  return avg > 0 ? +(bars[k].volume / avg).toFixed(2) : null;
}

/**
 * The confirmation bar: the newest closed bar, within the age limit, that turns.
 *
 * Searched newest-first and returns the first match, so a setup that confirmed twice reports
 * the recent one. The age limit is what stops a confirmation from four bars ago being
 * published as a live entry — the whole value of the timestamp is that it is recent, and a
 * scanner that surfaces a twenty-minute-old turn as "just fired" is worse than one that says
 * nothing, because it is actively wrong about the only thing it exists to say.
 */
function findConfirmation(i: PullbackInput, touchIdx: number, atr: number): ConfirmationRead | null {
  const { bars, series: s, cfg, direction: dir } = i;
  const p = cfg.pullback;
  const n = bars.length;
  const oldest = Math.max(touchIdx, n - 1 - p.maxConfirmationAgeBars);

  for (let k = n - 1; k >= oldest; k--) {
    const pattern = classify(bars, k, dir, {
      minBodyRatio: p.minBodyRatio,
      wickMultiple: 2,
      strongBodyRatio: 0.7,
    });
    if (pattern === 'none') continue;

    const ratio = volumeRatioAt(bars, k, cfg.timeframes.volumeLookback, i.avgVolume);
    if (ratio !== null && ratio < p.minConfirmationVolumeRatio) continue;
    // A missing volume denominator is not a pass. Volume confirmation is one of the two halves
    // of the brief's entry rule, and letting a symbol with no volume history through would
    // quietly run half the strategy on whichever names happen to be newly listed.
    if (ratio === null) continue;

    const ema9 = s.ema9[k];
    const reclaimed = ema9 !== null && (dir === 1 ? bars[k].close > ema9 : bars[k].close < ema9);
    if (p.requireEma9Reclaim && !reclaimed) continue;

    const reasons = [
      `${PATTERN_LABEL[pattern]} (${Math.round(PATTERN_STRENGTH[pattern] * 100)}% pattern weight)`,
      `volume ${ratio.toFixed(2)}x its ${cfg.timeframes.volumeLookback}-bar average`,
    ];
    if (reclaimed) reasons.push('closed back past the 9 EMA');
    const barsAgo = n - 1 - k;
    if (barsAgo > 0) reasons.push(`${barsAgo} bar${barsAgo > 1 ? 's' : ''} ago`);

    return {
      pattern,
      at: bars[k].at,
      close: bars[k].close,
      high: bars[k].high,
      low: bars[k].low,
      bodyRatio: +bodyRatio(bars[k]).toFixed(3),
      volumeRatio: ratio,
      reclaimedEma9: reclaimed,
      barsAgo,
      reasons,
    };
  }

  return null;
}

/** How much evidence the confirmation carries, 0…1. Feeds the volume score component. */
export const confirmationStrength = (c: ConfirmationRead | null): number =>
  c ? PATTERN_STRENGTH[c.pattern] : 0;
