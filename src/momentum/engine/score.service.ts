// Turning twelve factor outcomes into one number, one direction and one sentence.
//
// The arithmetic, in order:
//
//   1. WEIGHTED MEAN OVER AVAILABLE WEIGHT, not over total weight. A stock outside the
//      enrichment shortlist has no option data, which is 25 of the 100 weight missing.
//      Dividing by 100 would score it 25 points lower than an identical stock that happened
//      to make the shortlist — a ranking artefact of the rate limiter. Dividing by the 75
//      that were computable makes the two comparable, and `coverage` reports the difference
//      so nobody mistakes a partial read for a complete one.
//
//   2. DIRECTION AS A WEIGHTED VOTE of the directional factors only. Magnitude-only factors
//      (volume, liquidity, volatility) abstain rather than voting zero, which would drag
//      every direction toward neutral in proportion to how much weight they carry.
//
//   3. COHERENCE PENALTY. |Σ bias·w| ÷ Σ |bias|·w is 1 when every factor points the same
//      way and 0 when they cancel exactly. A stock with 5x volume, price under a falling
//      VWAP and long unwinding scores loud on every individual factor and is not a momentum
//      trade; without this it would rank alongside a clean breakout.
//
//   4. CONFIDENCE FROM COVERAGE, gated on liquidity. A complete read on a stock you cannot
//      get size in is not a high-confidence trade.
//
// The explanation is generated from the same FactorOutcome objects the score is, so the ✓
// list cannot drift from the arithmetic — there is no second code path that decides what to
// say.

import type {
  ActivityLevel, Confidence, Direction, FactorOutcome, FactorReason, MomentumConfig, TradeType,
} from '../types.js';
import { DIRECTIONAL } from '../types.js';
import { clamp } from '../services/scoring.js';

export interface ScoreResult {
  score: number;
  rawScore: number;
  coverage: number;
  coherence: number;
  penalty: number;
  directionVector: number;
  direction: Direction;
  confidence: Confidence;
  tradeType: TradeType;
  reasons: FactorReason[];
}

export interface ScoreInputs {
  factors: FactorOutcome[];
  liquidityScore: number | null;
  config: MomentumConfig;
}

export function scoreRow({ factors, liquidityScore, config }: ScoreInputs): ScoreResult {
  const cfg = config;

  let weighted = 0;
  let usedWeight = 0;
  let totalWeight = 0;

  let dirNumerator = 0;
  let dirDenominator = 0;
  let absNumerator = 0;

  for (const f of factors) {
    totalWeight += f.weight;
    if (!f.available || f.score === null) continue;

    weighted += f.score * f.weight;
    usedWeight += f.weight;

    if (DIRECTIONAL[f.key]) {
      // Weighted by the factor's own strength as well as its configured weight: a
      // directional factor scoring 20 should not vote as loudly as one scoring 90.
      const strength = f.score / 100;
      const contribution = f.bias * f.weight * strength;
      dirNumerator += contribution;
      absNumerator += Math.abs(contribution);
      dirDenominator += f.weight * strength;
    }
  }

  const coverage = totalWeight > 0 ? usedWeight / totalWeight : 0;
  const rawScore = usedWeight > 0 ? weighted / usedWeight : 0;

  const directionVector = dirDenominator > 0 ? clamp(dirNumerator / dirDenominator, -1, 1) : 0;
  // 1 = unanimous, 0 = perfectly split. Undefined when nothing voted, in which case there
  // is no disagreement to penalise.
  const coherence = absNumerator > 0 ? Math.abs(dirNumerator) / absNumerator : 1;
  const penalty = cfg.scoring.coherence.enabled ? cfg.scoring.coherence.maxPenalty * (1 - coherence) : 0;

  const score = clamp(rawScore * (1 - penalty), 0, cfg.scoring.maxScore);

  const direction: Direction =
    directionVector > cfg.scoring.directionDeadband
      ? 'Bullish'
      : directionVector < -cfg.scoring.directionDeadband
        ? 'Bearish'
        : 'Neutral';

  const confidence = confidenceFrom(coverage, liquidityScore, cfg);
  const tradeType = tradeTypeFrom(score, direction, liquidityScore, cfg);

  return {
    score: +score.toFixed(1),
    rawScore: +rawScore.toFixed(1),
    coverage: +coverage.toFixed(3),
    coherence: +coherence.toFixed(3),
    penalty: +penalty.toFixed(3),
    directionVector: +directionVector.toFixed(3),
    direction,
    confidence,
    tradeType,
    reasons: explain(factors),
  };
}

export function confidenceFrom(coverage: number, liquidityScore: number | null, cfg: MomentumConfig): Confidence {
  const liquidEnough = (liquidityScore ?? 0) >= cfg.confidence.minLiquidityForHigh;
  if (coverage >= cfg.confidence.high && liquidEnough) return 'High';
  if (coverage >= cfg.confidence.medium) return 'Medium';
  return 'Low';
}

export function tradeTypeFrom(
  score: number,
  direction: Direction,
  liquidityScore: number | null,
  cfg: MomentumConfig,
): TradeType {
  // A momentum signal in something you cannot trade out of is not actionable, whatever it
  // scores. `Avoid` here means "not tradable", not "the model dislikes it".
  if ((liquidityScore ?? 0) < cfg.thresholds.liquidity.grade.average) return 'Avoid';
  if (direction === 'Bullish' && score >= cfg.output.buyScore) return 'Momentum Buy';
  if (direction === 'Bearish' && score >= cfg.output.sellScore) return 'Momentum Sell';
  return 'Avoid';
}

/**
 * The ✓/✗ list, ordered by how much each factor actually contributed.
 *
 * Ordered by weight × score rather than by weight alone: a 20-weight factor scoring 12 said
 * very little and should not head the explanation of a 90-scoring stock.
 */
export function explain(factors: FactorOutcome[]): FactorReason[] {
  return [...factors]
    .filter((f) => f.reasons.length)
    .sort((a, b) => (b.weight * ((b.score ?? 0) / 100)) - (a.weight * ((a.score ?? 0) / 100)))
    .flatMap((f) => f.reasons);
}

/**
 * Institutional activity — a separate read on whether the size looks like a desk.
 *
 * Not one of the twelve scored factors. It answers a different question: the score says
 * "is this moving", this says "is somebody big behind it". Four inputs, each already
 * computed elsewhere, mixed by configurable weights.
 */
export function institutionalActivity(
  inputs: {
    rvol: number | null;
    turnoverCr: number;
    avgDailyValueCr: number | null;
    optionValueCr: number | null;
    futuresOiChangePct: number | null;
  },
  cfg: MomentumConfig,
): { level: ActivityLevel; score: number } {
  const t = cfg.thresholds.institutional;

  const parts: Array<{ v: number; w: number }> = [];

  if (inputs.rvol !== null) parts.push({ v: clamp((inputs.rvol / 4) * 100, 0, 100), w: t.rvolWeight });

  // Turnover against the stock's own norm, so a ₹2000Cr day in RELIANCE does not outrank a
  // ₹200Cr day in a stock that normally trades ₹20Cr.
  if (inputs.avgDailyValueCr && inputs.avgDailyValueCr > 0)
    parts.push({ v: clamp((inputs.turnoverCr / inputs.avgDailyValueCr) * 100, 0, 100), w: t.turnoverWeight });

  if (inputs.optionValueCr !== null)
    parts.push({ v: clamp((Math.log10(1 + inputs.optionValueCr) / Math.log10(201)) * 100, 0, 100), w: t.optionWeight });

  if (inputs.futuresOiChangePct !== null)
    parts.push({ v: clamp((Math.abs(inputs.futuresOiChangePct) / 8) * 100, 0, 100), w: t.oiWeight });

  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const score = wSum > 0 ? +(parts.reduce((a, p) => a + p.v * p.w, 0) / wSum).toFixed(1) : 0;

  return {
    level: score >= t.high ? 'High' : score >= t.medium ? 'Medium' : 'Low',
    score,
  };
}
