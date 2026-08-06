// The confidence score — the brief's 100 points, and what each of them is measuring.
//
//   Trend strength   30   the checklist and the slope, on the signal timeframe, plus how many
//                         higher timeframes agree.
//   Volume           20   the confirmation bar's expansion against its own 20-bar mean, times
//                         how strong the candle itself was.
//   VWAP alignment   15   the right side of VWAP, how far from it the entry is, and whether
//                         VWAP is sloping with the trade.
//   EMA alignment    15   how separated 9 and 20 are, and how much of the 50/200 stack holds.
//   Structure        10   consecutive same-direction swing steps.
//   ADX              10   the level, with a bonus for rising.
//
// TWO THINGS ARE DELIBERATE AND BOTH GO AGAINST THE OBVIOUS DESIGN.
//
// NOTHING IS COUNTED TWICE. Every reading feeds exactly one component. It is very tempting to
// let ADX contribute to trend strength as well as to its own 10 points, and to let the VWAP
// distance feed both the VWAP component and the trend — and that is how a scoring model ends
// up with an effective weighting nobody can state. `trend.service.ts` therefore builds its
// strength from the checklist pass rate and the SLOPE only, and the ADX and VWAP readings it
// tested are scored here and only here.
//
// AN UNMEASURABLE COMPONENT SCORES NOTHING AND ALSO COSTS NOTHING. If ADX is still warming, its
// 10 points leave BOTH the numerator and the denominator, and `coverage` records that the total
// is out of 90 rather than 100. Awarding zero instead would make every symbol look weak for the
// first half hour after a deploy; awarding half would be an invention. The board shows coverage
// next to the score for exactly the same reason the momentum board does: a 78 measured on 70% of
// the model is a different claim from a 78 measured on all of it.
//
// CLOSER TO VWAP SCORES HIGHER, which reads backwards until you remember what is being scored.
// This is not "how strong is the move" — that is trend strength. This is "how good is this
// ENTRY", and an entry two ATR above VWAP is a chase however good the trend behind it looks:
// the stop has to go somewhere, and everywhere it can go is now a long way down.

import { clamp, curve } from '../indicators/series.js';
import { confirmationStrength } from './pullback.service.js';
import { agrees } from './trend.service.js';
import type {
  ConfidenceBand, PullbackConfig, PullbackRead, ScoreBreakdown, ScoreComponent, Timeframe,
  TimeframeRead, TrendRead,
} from '../types.js';

export interface ScoreInput {
  trend: TrendRead;
  pullback: PullbackRead;
  read: TimeframeRead;
  /** Every computed timeframe, for the alignment bonus. */
  frames: Partial<Record<Timeframe, TimeframeRead>>;
  direction: 1 | -1;
  cfg: PullbackConfig;
}

const band = (total: number, b: PullbackConfig['score']['bands']): ConfidenceBand =>
  total >= b.excellent ? 'Excellent' : total >= b.strong ? 'Strong' : total >= b.medium ? 'Medium' : 'Weak';

/** Which higher timeframes point the same way. Exported because the signal carries the list. */
export function alignedTimeframes(
  frames: Partial<Record<Timeframe, TimeframeRead>>,
  signalTf: Timeframe,
  direction: 1 | -1,
  context: Timeframe[],
): Timeframe[] {
  return context.filter((tf) => tf > signalTf && agrees(frames[tf], direction));
}

export function scoreSignal(i: ScoreInput): ScoreBreakdown {
  const { cfg, read, trend, pullback, direction } = i;
  const w = cfg.score.weights;
  const c = cfg.score.curves;
  const components: ScoreComponent[] = [];

  const push = (
    key: ScoreComponent['key'],
    label: string,
    max: number,
    fraction: number | null,
    reasons: string[],
  ): void => {
    components.push({
      key,
      label,
      max,
      available: fraction !== null,
      points: fraction === null ? 0 : +(clamp(fraction, 0, 1) * max).toFixed(2),
      reasons,
    });
  };

  /* ------------------------------------------------------------------ trend, 30 pts --- */

  const aligned = alignedTimeframes(i.frames, read.timeframe, direction, cfg.timeframes.context);
  // The bonus is expressed in POINTS of the trend component and then converted back to a
  // fraction, so it scales with the component's configured weight rather than being a flat
  // addition that would quietly become 20% of the score if someone reweighted trend down to 15.
  const bonus = Math.min(w.trend, aligned.length * cfg.score.alignmentBonus);
  const trendFraction = clamp((trend.strength / 100) * (1 - bonus / Math.max(1, w.trend)) + bonus / Math.max(1, w.trend), 0, 1);

  push('trend', 'Trend strength', w.trend, trendFraction, [
    `${trend.strength}/100 on the ${read.timeframe}m checklist and slope`,
    aligned.length
      ? `${aligned.map((tf) => `${tf}m`).join(' and ')} agree — +${bonus} of the trend allowance`
      : 'no higher timeframe confirms this direction',
    ...(trend.failed.length ? [`missing: ${trend.failed.length} required condition${trend.failed.length > 1 ? 's' : ''}`] : []),
  ]);

  /* ----------------------------------------------------------------- volume, 20 pts --- */

  // The confirmation bar's volume, not the last bar's. On a 15-minute chart those are often
  // the same bar and often not, and when they differ it is the confirmation that matters: the
  // question is whether buyers showed up ON THE TURN, and the bar after it is already the trade.
  const confVolume = pullback.confirmation?.volumeRatio ?? read.volumeRatio;
  const patternWeight = confirmationStrength(pullback.confirmation);
  if (confVolume === null) {
    push('volume', 'Volume expansion', w.volume, null, ['no volume history on this timeframe']);
  } else {
    const volScore = curve(c.volumeRatio, confVolume) / 100;
    // A confirmed turn on 2x volume is worth more than 2x volume with no turn. The pattern
    // weight is applied as a multiplier over a floor rather than as an addition, so a strong
    // candle cannot manufacture volume and heavy volume cannot manufacture a candle.
    const fraction = volScore * (pullback.confirmation ? 0.6 + 0.4 * patternWeight : 0.6);
    push('volume', 'Volume expansion', w.volume, fraction, [
      `${confVolume.toFixed(2)}x the ${cfg.timeframes.volumeLookback}-bar average`,
      pullback.confirmation
        ? `on a ${pullback.confirmation.pattern === 'none' ? 'candle' : pullback.confirmation.pattern} (${Math.round(patternWeight * 100)}% weight)`
        : 'no confirmation candle yet — volume alone is capped at 60%',
    ]);
  }

  /* ------------------------------------------------------------------- VWAP, 15 pts --- */

  const vwapDist = read.distance.vwapAtr;
  if (vwapDist === null || read.vwap === null) {
    push('vwap', 'VWAP alignment', w.vwap, null, ['no VWAP on this timeframe — the instrument publishes no volume']);
  } else {
    const rightSide = direction === 1 ? vwapDist > 0 : vwapDist < 0;
    const proximity = curve(c.vwapDistanceAtr, Math.abs(vwapDist)) / 100;
    const slope = read.slope.vwapAtrPerBar;
    const slopeAgrees = slope !== null && slope * direction > 0;
    // Being on the wrong side is not a small penalty — it contradicts one of the brief's
    // required conditions — so it caps the component at a quarter rather than shading it.
    const fraction = rightSide ? proximity * (slopeAgrees ? 1 : 0.75) : proximity * 0.25;
    push('vwap', 'VWAP alignment', w.vwap, fraction, [
      `${vwapDist >= 0 ? '+' : ''}${vwapDist.toFixed(2)} ATR from VWAP${rightSide ? '' : ' — the WRONG side for this direction'}`,
      slope === null ? 'VWAP slope not measurable' : slopeAgrees ? 'VWAP is sloping with the trade' : 'VWAP is sloping against the trade',
    ]);
  }

  /* -------------------------------------------------------------------- EMA, 15 pts --- */

  const { ema9, ema20, ema50, ema200 } = read.ema;
  if (ema9 === null || ema20 === null || !read.atr) {
    push('ema', 'EMA alignment', w.ema, null, ['the 9 or 20 EMA is still warming']);
  } else {
    const separation = Math.abs(ema9 - ema20) / read.atr;
    const sepScore = curve(c.emaSeparationAtr, separation) / 100;
    // How much of the deeper stack holds. Counted out of the averages that are WARM, so a
    // symbol whose 200 has not seeded is not penalised for the seed rather than for its chart.
    const deeper: boolean[] = [];
    if (ema50 !== null) deeper.push(direction === 1 ? ema20 > ema50 : ema20 < ema50);
    if (ema200 !== null && read.close !== null)
      deeper.push(direction === 1 ? read.close > ema200 : read.close < ema200);
    const stackFraction = deeper.length ? deeper.filter(Boolean).length / deeper.length : 0.5;

    push('ema', 'EMA alignment', w.ema, sepScore * 0.65 + stackFraction * 0.35, [
      `9/20 separated by ${separation.toFixed(2)} ATR${separation < 0.1 ? ' — this is close to a crossover, which is not the setup' : ''}`,
      deeper.length
        ? `${deeper.filter(Boolean).length}/${deeper.length} of the deeper stack (50, 200) holds`
        : 'the 50 and 200 are still warming — stack scored neutral',
    ]);
  }

  /* -------------------------------------------------------------- structure, 10 pts --- */

  const st = read.structure;
  if (st.note && st.steps === 0) {
    push('structure', 'Price structure', w.structure, null, [st.note]);
  } else {
    push('structure', 'Price structure', w.structure, curve(c.structureSteps, st.steps) / 100, [
      `${st.steps} consecutive same-direction swing step${st.steps === 1 ? '' : 's'}`,
      direction === 1
        ? `${st.higherHigh ? 'higher high' : 'no higher high'}, ${st.higherLow ? 'higher low' : 'no higher low'}`
        : `${st.lowerLow ? 'lower low' : 'no lower low'}, ${st.lowerHigh ? 'lower high' : 'no lower high'}`,
    ]);
  }

  /* -------------------------------------------------------------------- ADX, 10 pts --- */

  const adx = read.adx.adx;
  if (adx === null) {
    push('adx', 'ADX', w.adx, null, [`ADX needs about ${28} bars on ${read.timeframe}m and has ${read.bars}`]);
  } else {
    // Rising ADX is worth a fifth of the component. A falling 32 is a trend that has already
    // had its move — the DIs are converging — and a rising 27 is one still gaining
    // participants. The level alone cannot tell those apart, and the pullback is worth more in
    // the second.
    const fraction = (curve(c.adx, adx) / 100) * (read.adx.rising === true ? 1 : read.adx.rising === false ? 0.8 : 0.9);
    push('adx', 'ADX', w.adx, fraction, [
      `${adx.toFixed(1)}${adx >= cfg.trend.adxTrend ? ` — above the ${cfg.trend.adxTrend} trend line` : ` — below the ${cfg.trend.adxTrend} trend line`}`,
      read.adx.rising === null ? 'direction of ADX not measurable' : read.adx.rising ? 'rising' : 'falling',
    ]);
  }

  /* ------------------------------------------------------------------------ totals --- */

  const availableMax = components.filter((x) => x.available).reduce((a, x) => a + x.max, 0);
  const totalMax = components.reduce((a, x) => a + x.max, 0);
  const earned = components.reduce((a, x) => a + x.points, 0);

  return {
    // Normalised onto the configured total so the number is always out of the same 100,
    // whatever was measurable. Dividing by `availableMax` and reporting `coverage` separately
    // is the only honest way to do this: scaling by `totalMax` instead would make a row with
    // half its model dark permanently unable to exceed 50, which reads as a weak setup rather
    // than as an unmeasured one.
    total: availableMax > 0 ? +((earned / availableMax) * totalMax).toFixed(1) : 0,
    band: band(availableMax > 0 ? (earned / availableMax) * totalMax : 0, cfg.score.bands),
    components,
    coverage: totalMax > 0 ? +(availableMax / totalMax).toFixed(3) : 0,
  };
}
