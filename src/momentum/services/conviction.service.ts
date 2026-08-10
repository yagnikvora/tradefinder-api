// Factor 13 — Trend Quality. The only thing in this module measured over the WHOLE SESSION.
//
// WHY THIS EXISTS
//
// The scanner had two timescales and was missing the one that matters most to an option
// buyer. `score.service.ts` measures the day cumulatively — how big has today been — and
// `pulse.service.ts` measures the last three minutes — is it moving right now. Neither
// measures the day's SHAPE, and shape is the entire difference between these two stocks:
//
//   A  opens flat, grinds up 4% over five hours, never decisively loses VWAP, deepest dip
//      0.3 ATR. Every retracement is an entry; the same call option pays three times.
//   B  gaps up 4% at 09:20, then chops in a 1.5% band for five hours, crossing VWAP eleven
//      times. Identical change%, identical RVOL, identical ATR expansion, identical relative
//      strength, identical trend structure.
//
// The twelve-factor score cannot distinguish them. Worse, it ranks B HIGHER — chop is what
// generates the volume bursts and velocity spikes the momentum pulse rewards, while A's
// steady grind produces a burst RVOL near 1.0 and a velocity near zero, scoring the pulse
// around 35 against a `minPulseScore` of 55. So on stock A the timing layer is not merely
// wrong, it is SILENT: below that floor no trigger is permitted to fire at all.
//
// And then the extension ceiling finishes the job. A genuine one-sided day expands its true
// range to 1.5–2.5 ATR, so `atrUsed >= 0.8` somewhere around mid-morning, the state locks to
// `Extended`, `roomAtr` returns zero and `buildPlan` refuses to produce a plan for the rest of
// the session. The stocks that trend hardest were the ones disqualified soonest. That is the
// failure this module was written to fix.
//
// WHAT IS MEASURED, and why each one earns its place
//
//   ADHERENCE   share of the observed session spent on one side of VWAP. The definitional
//               reading: "one-sided" means exactly this.
//
//   CROSSINGS   how many times price changed sides. The best single discriminator in this
//               file, because unlike every magnitude reading it CANNOT BE FAKED BY A GAP. A
//               stock that gapped 4% and went nowhere has the same change%, RVOL and relative
//               strength as one that walked up 4% — and eleven crossings against one.
//
//   EFFICIENCY  |net| ÷ path over the whole session. The pulse's efficiency reading applied to
//               six hours instead of three minutes. Note the scale is genuinely different: a
//               full day of 15-second sampling accumulates a lot of path, so 0.45 here is an
//               excellent trend day where 0.45 in the pulse is mediocre chop. The curves are
//               calibrated separately for that reason and are not interchangeable.
//
//   RANGE POS   where price sits inside the day's range, oriented to the trend. A trend day
//               spends the afternoon pinned near its extreme; a chop day sits mid-range.
//
//   PULLBACK    the deepest counter-trend excursion of the day, in ATR. This is the one a
//               trader feels: a 4% gain through a 2.5% mid-session gut is not a position
//               anybody actually held, and every cumulative factor scores it identically to a
//               4% gain that never gave back more than half a percent.
//
//   SLOPE       the session-scale VWAP slope. VWAP is a cumulative average, so for it to keep
//               rising for five hours the tape has to keep paying up — it is very hard to
//               counterfeit and very slow to turn.
//
//   STRUCTURE   whether successive parts of the day keep making higher lows (or lower highs).
//
// Every one of these comes from accumulators folded into the 15-second quote poll that already
// happens, so the whole layer costs NO upstream request and is computed for all 208 stocks
// rather than for an enrichment shortlist — which is the point, since the stock that has been
// quietly trending all day is by construction not the one at the top of a momentum ranking.
//
// WHAT THIS CANNOT SEE. Accumulation starts when the process does. A scanner restarted at
// 13:00 has no record of the morning and cannot invent one, so `partial` is set, `fromMinute`
// says where the record begins, and the phase machine refuses to confirm anything until it has
// `minObservedMin` of its own observation. A partial read is reported as partial rather than
// quietly presented as a full day — a conviction of 90 measured over forty minutes is a
// different claim from one measured over five hours.

import type {
  ConvictionReading, ConvictionSummary, Direction, MomentumConfig,
} from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import { advanceTrend, type SessionShape, type SpineSample, type SymbolSessionState } from '../data/session-state.js';
import { minuteOfSession } from '../session.js';
import { clamp, curve, mix, outcome, unavailable, type MixComponent } from './scoring.js';

const round = (v: number, d = 3): number => +v.toFixed(d);

const EMPTY: ConvictionReading = {
  ready: false, score: 0, phase: 'None', direction: 'Neutral', heldMin: null, confirmedAt: null, peak: 0,
  displacementAtr: null,
  vwapAdherence: null, vwapCrossings: null, sessionEfficiency: null, rangePosition: null,
  deepestPullbackAtr: null, vwapSlopePctPerMin: null, structureCount: null,
  minutesSinceExtreme: null, observedMin: 0, fromMinute: 0, partial: false,
};

/* ------------------------------------------------------------------ the sub-reads --- */

/**
 * Session-scale VWAP slope, in percent per minute, by least squares over the spine.
 *
 * Deliberately not `(last − first) / elapsed`: VWAP moves in small increments and a two-point
 * slope over five hours is dominated by wherever the two endpoints happened to land. The fit
 * uses every sample, which is what makes a slope that has been positive all day distinguishable
 * from one that turned an hour ago.
 */
export function spineVwapSlope(spine: SpineSample[]): number | null {
  const pts = spine.filter((s) => s.vwap > 0);
  if (pts.length < 4) return null;

  const base = pts[0].vwap;
  if (!(base > 0)) return null;
  const t0 = pts[0].at;

  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.at - t0) / 60_000;
    const y = ((p.vwap - base) / base) * 100;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = pts.length;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return +((n * sxy - sx * sy) / denom).toFixed(5);
}

/**
 * How many successive stretches of the day kept making higher lows (or lower highs).
 *
 * PIVOT DETECTION IS NOT USED HERE, on purpose. A local-minimum scan over a 5-minute series
 * finds a dozen pivots in an afternoon of drift and the count says more about the sampling
 * than about the day. Splitting the session into equal segments and comparing their extremes
 * asks the question a trader actually asks — "is each part of the day holding above the last
 * one" — and degrades gracefully: at 10:00 there are three segments and it says so, rather
 * than reporting a confident structure read off six samples.
 *
 * Returns the run length ending at the most recent segment, so a day that made four higher
 * lows and then broke one reports 0 rather than 4.
 */
export function segmentStructure(spine: SpineSample[], up: boolean): number | null {
  const prices = spine.map((s) => s.ltp).filter((p) => p > 0);
  if (prices.length < 8) return null;

  const segments = clamp(Math.floor(prices.length / 4), 2, 8);
  const size = prices.length / segments;

  const extremes: number[] = [];
  for (let i = 0; i < segments; i++) {
    const slice = prices.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (!slice.length) continue;
    extremes.push(up ? Math.min(...slice) : Math.max(...slice));
  }
  if (extremes.length < 2) return null;

  let run = 0;
  for (let i = extremes.length - 1; i > 0; i--) {
    const better = up ? extremes[i] > extremes[i - 1] : extremes[i] < extremes[i - 1];
    if (!better) break;
    run++;
  }
  return run;
}

/**
 * Which way the session has been one-sided.
 *
 * The VWAP side is primary because it is what "one-sided" means, but it has to AGREE with the
 * net move from the first observed price. The two disagree on a real and important shape: a
 * stock that gapped up hard and bled all day sits above its VWAP (the gap dragged the average
 * up with it) while going down for five hours. Calling that bullish is what a purely
 * VWAP-based read would do, and it is exactly backwards for somebody buying a call.
 */
function directionOf(shape: SessionShape): { dir: 1 | -1 | null; agree: boolean } {
  const sided = shape.aboveVwapTicks + shape.belowVwapTicks;
  const sideDir: 1 | -1 | null =
    sided === 0 ? null : shape.aboveVwapTicks > shape.belowVwapTicks ? 1 : shape.aboveVwapTicks < shape.belowVwapTicks ? -1 : null;

  const net = shape.lastLtp - shape.firstLtp;
  const moveDir: 1 | -1 | null = net > 0 ? 1 : net < 0 ? -1 : null;

  if (sideDir === null) return { dir: moveDir, agree: false };
  if (moveDir === null) return { dir: sideDir, agree: false };
  return { dir: sideDir, agree: sideDir === moveDir };
}

/* -------------------------------------------------------------------- the reading --- */

export function computeConviction(
  sym: SymbolSessionState | undefined,
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
  nowMs: number,
): ConvictionReading {
  const c = cfg.thresholds.conviction;
  if (!c.enabled) return { ...EMPTY, note: 'conviction layer is switched off in config' };

  const shape = sym?.shape ?? null;
  if (!shape || shape.ticks < 4)
    return { ...EMPTY, note: 'session shape warming up — the accumulators need a few readings' };

  const minute = minuteOfSession(nowMs);
  const observedMin = round((shape.lastAt - shape.fromAt) / 60_000, 1);
  const partial = shape.fromMinute > 5;

  const atr = baseline?.atr && baseline.atr > 0 ? baseline.atr : null;
  const spine = sym?.spine ?? [];

  const { dir, agree } = directionOf(shape);
  const up = dir === 1;

  // ---- the eight sub-reads ----
  //
  // Displacement first, because it is the one the others are meaningless without: shape
  // describes HOW a stock got somewhere and says nothing about whether it went anywhere.
  const displacementAtr =
    atr && dir !== null ? round(((shape.lastLtp - shape.firstLtp) * dir) / atr) : null;

  const sided = shape.aboveVwapTicks + shape.belowVwapTicks;
  const vwapAdherence = sided > 0 ? round(Math.max(shape.aboveVwapTicks, shape.belowVwapTicks) / sided) : null;
  const vwapCrossings = shape.crossings;

  const sessionEfficiency =
    shape.travelled > 0 ? round(Math.abs(shape.lastLtp - shape.firstLtp) / shape.travelled) : null;

  const dayRange = shape.runHigh - shape.runLow;
  const rawPos = dayRange > 0 ? (shape.lastLtp - shape.runLow) / dayRange : null;
  const rangePosition = rawPos === null ? null : round(up ? rawPos : 1 - rawPos);

  const adverse = up ? shape.maxDropFromHigh : shape.maxRiseFromLow;
  const deepestPullbackAtr = atr ? round(adverse / atr) : null;

  const rawSlope = spineVwapSlope(spine);
  // Signed with the trend: a VWAP falling while the stock is one-sided UP is a contradiction,
  // and scoring |slope| would reward it as strongly as agreement.
  const vwapSlopePctPerMin = rawSlope === null || dir === null ? rawSlope : round(rawSlope * dir, 5);

  const structureCount = dir === null ? null : segmentStructure(spine, up);

  // From the session accumulator, so it spans the whole day rather than the ring's 25 minutes.
  const extremeAt = dir === null ? null : up ? shape.runHighAt : shape.runLowAt;
  const minutesSinceExtreme = extremeAt === null ? null : round((nowMs - extremeAt) / 60_000, 1);

  const components: MixComponent[] = [
    { key: 'displacement', weight: c.mix.displacement, score: displacementAtr === null ? null : curve(displacementAtr, c.displacementAtr) },
    { key: 'adherence', weight: c.mix.adherence, score: vwapAdherence === null ? null : curve(vwapAdherence, c.adherence) },
    { key: 'crossings', weight: c.mix.crossings, score: curve(vwapCrossings, c.crossings) },
    { key: 'efficiency', weight: c.mix.efficiency, score: sessionEfficiency === null ? null : curve(sessionEfficiency, c.efficiency) },
    { key: 'rangePosition', weight: c.mix.rangePosition, score: rangePosition === null ? null : curve(rangePosition, c.rangePosition) },
    { key: 'pullback', weight: c.mix.pullback, score: deepestPullbackAtr === null ? null : curve(deepestPullbackAtr, c.deepestPullbackAtr) },
    { key: 'slope', weight: c.mix.slope, score: vwapSlopePctPerMin === null ? null : curve(vwapSlopePctPerMin, c.slopePctPerMin) },
    { key: 'structure', weight: c.mix.structure, score: structureCount === null ? null : curve(structureCount, c.structure) },
  ];
  const m = mix(components);

  let score = m.score ?? 0;

  // The VWAP side and the net move disagreeing is the gap-up-and-bleed shape. It is not a
  // one-sided day in the sense anyone can trade, so it is cut hard rather than merely being
  // scored on its (genuinely high) adherence.
  if (!agree) score *= 0.45;

  // A partial record cannot make a full-day claim. The scale is the share of the session
  // actually seen, floored so a late restart still reports something rather than zero.
  if (partial) {
    const seen = clamp(observedMin / Math.max(1, minute), 0.4, 1);
    score *= seen;
  }

  score = +clamp(score, 0, 100).toFixed(1);

  // ---- the necessary condition ----
  //
  // A stock that has not gone anywhere is not having a trend day whatever its shape looks
  // like, and no weighted average can say that — a mix component only makes the score lower,
  // and "lower" was still 98 for INFY on a +0.02% session. So displacement is enforced as a
  // GATE on top of its weighting: below the floor the phase machine is told there is no
  // direction, which parks the row at `None` and keeps it out of every trend view, while the
  // score itself is left alone so the reason stays visible on the detail page rather than
  // being flattened to zero.
  const tooSmall =
    displacementAtr !== null && Math.abs(displacementAtr) < c.phase.minDisplacementAtr;
  const phaseDir = tooSmall ? null : dir;

  // ---- the phase machine ----
  const track = sym
    ? advanceTrend(sym, score, phaseDir, !tooSmall, minute, observedMin, c.phase, nowMs)
    : null;

  const direction: Direction = dir === null ? 'Neutral' : up ? 'Bullish' : 'Bearish';

  return {
    ready: true,
    score,
    phase: track?.phase ?? 'None',
    direction,
    heldMin: track ? round((nowMs - track.since) / 60_000, 1) : null,
    confirmedAt: track?.confirmedAt ?? null,
    peak: track?.peak ?? score,
    displacementAtr,
    vwapAdherence,
    vwapCrossings,
    sessionEfficiency,
    rangePosition,
    deepestPullbackAtr,
    vwapSlopePctPerMin,
    structureCount,
    minutesSinceExtreme,
    observedMin,
    fromMinute: shape.fromMinute,
    partial,
    note: partial
      ? `session shape recorded only from minute ${shape.fromMinute} — this is a ${observedMin.toFixed(0)}-minute read, not a full day`
      : !agree && dir !== null
        ? 'price is on one side of VWAP but moving the other way — a gap being faded, not a trend'
        : undefined,
  };
}

/* --------------------------------------------------------------------- the factor --- */

export function convictionFactor(reading: ConvictionReading, cfg: MomentumConfig) {
  const weight = cfg.weights.trendQuality;

  // Unavailable rather than zero before the shape means anything. Scoring an unknown as zero
  // would drag every row down through the first half hour and make the whole board look weak
  // at exactly the time of day it is most active.
  if (!reading.ready)
    return unavailable('trendQuality', weight, reading.note ?? 'session shape not measurable yet');

  const dir = reading.direction === 'Bullish' ? 1 : reading.direction === 'Bearish' ? -1 : 0;
  const bias = dir * clamp(reading.score / 100, 0, 1);

  const reasons = [];
  const side = reading.direction === 'Bullish' ? 'above' : 'below';

  if (reading.displacementAtr !== null)
    reasons.push({
      ok: Math.abs(reading.displacementAtr) >= cfg.thresholds.conviction.phase.minDisplacementAtr,
      text:
        Math.abs(reading.displacementAtr) >= cfg.thresholds.conviction.phase.minDisplacementAtr
          ? `Has actually travelled — ${Math.abs(reading.displacementAtr).toFixed(2)} ATR net from the open`
          : `Barely moved — ${Math.abs(reading.displacementAtr).toFixed(2)} ATR from the open, so the shape below describes a stock going nowhere`,
    });

  if (reading.vwapAdherence !== null)
    reasons.push({
      ok: reading.vwapAdherence >= 0.85,
      text:
        `${(reading.vwapAdherence * 100).toFixed(0)}% of the session spent ${side} VWAP` +
        (reading.vwapCrossings !== null
          ? `, crossing it ${reading.vwapCrossings} time${reading.vwapCrossings === 1 ? '' : 's'}`
          : ''),
    });

  if (reading.sessionEfficiency !== null)
    reasons.push({
      ok: reading.sessionEfficiency >= 0.3,
      text:
        reading.sessionEfficiency >= 0.3
          ? `Walking one way — ${(reading.sessionEfficiency * 100).toFixed(0)}% of the whole day's travel was net progress`
          : `Round-tripping — only ${(reading.sessionEfficiency * 100).toFixed(0)}% of the day's travel got anywhere`,
    });

  if (reading.deepestPullbackAtr !== null)
    reasons.push({
      ok: reading.deepestPullbackAtr <= 0.45,
      text: `Deepest counter-move all day was ${reading.deepestPullbackAtr.toFixed(2)} ATR`,
    });

  if (reading.rangePosition !== null)
    reasons.push({
      ok: reading.rangePosition >= 0.7,
      text: `Trading at ${(reading.rangePosition * 100).toFixed(0)}% of the day's range, measured from the wrong end`,
    });

  if (reading.phase !== 'None')
    reasons.push({
      ok: reading.phase === 'Confirmed' || reading.phase === 'Forming',
      text:
        reading.phase === 'Confirmed'
          ? `Confirmed one-sided day, held ${(reading.heldMin ?? 0).toFixed(0)}m`
          : reading.phase === 'Forming'
            ? `One-sided day forming — ${(reading.heldMin ?? 0).toFixed(0)}m so far, not yet confirmed`
            : `Was a one-sided day and has stopped being one (peaked at ${reading.peak.toFixed(0)})`,
    });

  return outcome({
    key: 'trendQuality',
    weight,
    score: reading.score,
    bias,
    metrics: {
      phase: reading.phase,
      heldMin: reading.heldMin,
      peak: reading.peak,
      displacementAtr: reading.displacementAtr,
      minutesSinceExtreme: reading.minutesSinceExtreme,
      vwapAdherence: reading.vwapAdherence,
      vwapCrossings: reading.vwapCrossings,
      sessionEfficiency: reading.sessionEfficiency,
      rangePosition: reading.rangePosition,
      deepestPullbackAtr: reading.deepestPullbackAtr,
      vwapSlopePctPerMin: reading.vwapSlopePctPerMin,
      structureCount: reading.structureCount,
      observedMin: reading.observedMin,
      partial: reading.partial,
    },
    reasons,
    note: reading.note ?? (missingNote(reading) || undefined),
  });
}

/** Which sub-reads were unmeasurable, for the factor's note. */
function missingNote(r: ConvictionReading): string {
  const missing: string[] = [];
  if (r.deepestPullbackAtr === null) missing.push('pullback depth (no ATR baseline)');
  if (r.structureCount === null) missing.push('structure');
  if (r.vwapSlopePctPerMin === null) missing.push('session VWAP slope');
  return missing.length ? `no ${missing.join(' or ')} — scored on what was measurable` : '';
}

/* -------------------------------------------------------------------- the summary --- */

/** The row-sized slice, with the one-line human read the board renders. */
export function convictionSummary(r: ConvictionReading): ConvictionSummary {
  return {
    ready: r.ready,
    score: r.score,
    phase: r.phase,
    direction: r.direction,
    heldMin: r.heldMin,
    confirmedAt: r.confirmedAt,
    peak: r.peak,
    vwapAdherence: r.vwapAdherence,
    vwapCrossings: r.vwapCrossings,
    sessionEfficiency: r.sessionEfficiency,
    rangePosition: r.rangePosition,
    deepestPullbackAtr: r.deepestPullbackAtr,
    partial: r.partial,
    summary: sentence(r),
    note: r.note,
  };
}

function sentence(r: ConvictionReading): string {
  if (!r.ready) return r.note ?? 'session shape not measurable yet';

  const side = r.direction === 'Bullish' ? 'above' : r.direction === 'Bearish' ? 'below' : 'either side of';
  const parts: string[] = [];

  if (r.vwapAdherence !== null) parts.push(`${(r.vwapAdherence * 100).toFixed(0)}% ${side} VWAP`);
  if (r.vwapCrossings !== null) parts.push(`${r.vwapCrossings} crossing${r.vwapCrossings === 1 ? '' : 's'}`);
  if (r.deepestPullbackAtr !== null) parts.push(`deepest dip ${r.deepestPullbackAtr.toFixed(2)} ATR`);

  const head =
    r.phase === 'Confirmed'
      ? `Confirmed ${r.direction.toLowerCase()} trend day`
      : r.phase === 'Forming'
        ? `${r.direction} trend day forming`
        : r.phase === 'Faded'
          ? `Faded trend day (peaked ${r.peak.toFixed(0)})`
          : 'Not one-sided';

  return parts.length ? `${head} — ${parts.join(', ')}` : head;
}
