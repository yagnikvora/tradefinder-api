// Factor 6 — Greeks. Whether the option leg is worth taking the view in.
//
// The brief asks for increasing delta, positive gamma and low theta risk. Two of those are
// direct readings off the chain. The third — "increasing" — is a rate of change, and Upstox
// publishes greeks only as of NOW. There is no historical-delta endpoint.
//
// So delta shift is computed two ways, and the better one is used when it exists:
//
//   MODELLED (always available)   Δdelta ≈ gamma × Δspot
//                                 This is not an approximation invented to fill a gap — it
//                                 is the definition of gamma. It is exact to first order,
//                                 and second-order error over a single session's move is
//                                 small enough to be irrelevant to a ranking.
//
//   MEASURED (after two passes)   this pass's ATM delta minus the last one's, from the
//                                 readings session-state.ts keeps. Strictly better once it
//                                 exists, because it includes the IV move and the day of
//                                 decay that the modelled figure ignores.
//
// `deltaBasis` in the payload says which was used, so nothing here is presented as measured
// when it was derived.
//
// GAMMA IS NORMALISED before it is scored. Raw gamma scales with 1/spot — a ₹200 stock's
// ATM gamma is an order of magnitude larger than a ₹4000 stock's for identical behaviour —
// so ranking on it would sort by share price. What is scored is `gamma × spot / 100`: the
// delta gained per one per cent move, which is comparable across the board.

import type { MomentumConfig } from '../types.js';
import type { ChainRow, StockChain } from '../data/option-chain.js';
import { atmRow } from '../data/option-chain.js';
import type { SymbolSessionState } from '../data/session-state.js';
import { clamp, curve, mix, outcome, squash, unavailable, type MixComponent } from './scoring.js';

/** Delta lives in [0, 1], so a shift can never leave [−1, +1]. */
const clampDelta = (v: number): number => clamp(v, -1, 1);

/** Said in the payload so no reading is presented as measured when it was derived. */
const DELTA_BASIS_NOTE: Record<DeltaBasis, string | undefined> = {
  measured: undefined,
  'chain-implied': 'delta shift read off the chain at yesterday’s moneyness; a directly measured figure needs two enrichment passes',
  modelled: 'delta shift derived as gamma × price move — first-order only, and the chain had no strike to interpolate against',
  unavailable: undefined,
};

export type DeltaBasis = 'measured' | 'chain-implied' | 'modelled' | 'unavailable';

/**
 * What the ATM strike's delta was at yesterday's close, read off today's chain.
 *
 * The chain is a delta-versus-strike curve at the current spot, and delta depends on
 * moneyness rather than on the strike outright. So the delta that strike K had when spot was
 * S₀ is approximately the delta that strike K·(S/S₀) has now — the same moneyness, a
 * different row of the same chain. Interpolating between the two listed strikes that
 * bracket it gives yesterday's delta with no history and no second request.
 *
 * This exists because `gamma × Δspot` is only first-order. On BAJFINANCE's +8.3% session it
 * returned a delta shift of +0.48, which is not a number delta can produce for an
 * already-ATM option: gamma itself falls away as the option moves in the money, and a
 * linearisation over a move that large ignores exactly that. Reading the curve instead of
 * its tangent costs nothing and does not have the failure mode.
 */
export function deltaAtPreviousSpot(chain: StockChain, spot: number, prevClose: number): number | null {
  if (!(spot > 0) || !(prevClose > 0) || chain.rows.length < 2) return null;

  const equivalentStrike = chain.atmStrike * (spot / prevClose);
  const quoted = chain.rows
    .filter((r) => r.call && Number.isFinite(r.call.delta) && r.call.delta !== 0)
    .map((r) => ({ strike: r.strike, delta: (r.call as { delta: number }).delta }))
    .sort((a, b) => a.strike - b.strike);
  if (quoted.length < 2) return null;

  // Outside the listed range there is nothing to interpolate between, and extrapolating a
  // delta curve past its last strike is how you get a delta above 1.
  if (equivalentStrike <= quoted[0].strike) return quoted[0].delta;
  if (equivalentStrike >= quoted[quoted.length - 1].strike) return quoted[quoted.length - 1].delta;

  for (let i = 1; i < quoted.length; i++) {
    const lo = quoted[i - 1];
    const hi = quoted[i];
    if (equivalentStrike <= hi.strike) {
      const span = hi.strike - lo.strike;
      const t = span > 0 ? (equivalentStrike - lo.strike) / span : 0;
      return lo.delta + t * (hi.delta - lo.delta);
    }
  }
  return null;
}

export interface GreeksReading {
  atmStrike: number | null;
  callDelta: number | null;
  putDelta: number | null;
  gamma: number | null;
  /** Delta gained per 1% move in the underlying — gamma, made comparable across prices. */
  gammaPer1Pct: number | null;
  theta: number | null;
  vega: number | null;
  /** Straddle premium: the ATM call plus the ATM put. */
  straddle: number | null;
  /** Daily theta as a percentage of that straddle. */
  thetaBurnPct: number | null;
  vegaPerIvPointPct: number | null;
  deltaShift: number | null;
  deltaBasis: DeltaBasis;
  /** OI-weighted net delta across the chain, in delta-units. Displayed, not scored. */
  netChainDelta: number | null;
  /** One-sigma move to expiry implied by the straddle, in rupees and percent. */
  expectedMove: { rupees: number; pct: number; days: number } | null;
  expiryDays: number | null;
}

const EMPTY: GreeksReading = {
  atmStrike: null, callDelta: null, putDelta: null, gamma: null, gammaPer1Pct: null,
  theta: null, vega: null, straddle: null, thetaBurnPct: null, vegaPerIvPointPct: null,
  deltaShift: null, deltaBasis: 'unavailable', netChainDelta: null, expectedMove: null, expiryDays: null,
};

/**
 * The straddle's one-sigma expected move to expiry.
 *
 * The desk rule of thumb — an ATM straddle prices roughly a one-standard-deviation move —
 * is `0.8 × straddle`, which is what this uses. It is quoted for position sizing, not
 * scored: a wide expected move is information, not evidence of momentum.
 */
export function expectedMoveFrom(straddle: number, spot: number, days: number) {
  if (!(straddle > 0) || !(spot > 0)) return null;
  const rupees = +(straddle * 0.8).toFixed(2);
  return { rupees, pct: +((rupees / spot) * 100).toFixed(2), days };
}

export function computeGreeks(
  chain: StockChain | null,
  spot: number,
  prevClose: number,
  sym: SymbolSessionState | undefined,
): GreeksReading {
  if (!chain) return { ...EMPTY };

  const row: ChainRow | null = atmRow(chain);
  if (!row?.call || !row.put) return { ...EMPTY, atmStrike: chain.atmStrike, expiryDays: chain.expiryDays };

  const { call, put } = row;
  // Call and put gamma at the same strike are equal under put-call parity; averaging the
  // two just smooths whatever rounding Upstox applied.
  const gamma = +(((call.gamma + put.gamma) / 2)).toFixed(6);
  const theta = +(Math.abs(call.theta) + Math.abs(put.theta)).toFixed(4);
  const vega = +((call.vega + put.vega)).toFixed(4);
  const straddle = +(call.ltp + put.ltp).toFixed(2);

  // Three ways to know how far delta has travelled today, best first.
  const spotMove = spot - prevClose;
  const previousDelta = deltaAtPreviousSpot(chain, spot, prevClose);
  const chainImplied = previousDelta === null ? null : +(call.delta - previousDelta).toFixed(4);
  // Clamped because delta itself lives in [0, 1], so a shift outside [−1, +1] is the
  // linearisation failing rather than a reading.
  const modelled = +clampDelta(gamma * spotMove).toFixed(4);
  const measured = sym?.lastAtmDelta ? +(call.delta - sym.lastAtmDelta.delta).toFixed(4) : null;

  // The measured figure is only better once it spans a real interval — two readings a few
  // seconds apart differ by rounding noise, and would rank stocks on that noise.
  const measurable = measured !== null && !!sym?.lastAtmDelta && Date.now() - sym.lastAtmDelta.at > 120_000;

  const deltaShift = measurable ? (measured as number) : chainImplied ?? modelled;
  const deltaBasis: DeltaBasis = measurable ? 'measured' : chainImplied !== null ? 'chain-implied' : 'modelled';

  let netChainDelta = 0;
  for (const r of chain.rows) {
    if (r.call) netChainDelta += r.call.oi * r.call.delta;
    if (r.put) netChainDelta += r.put.oi * r.put.delta;
  }

  return {
    atmStrike: chain.atmStrike,
    callDelta: +call.delta.toFixed(4),
    putDelta: +put.delta.toFixed(4),
    gamma,
    gammaPer1Pct: +(gamma * spot / 100).toFixed(5),
    theta,
    vega,
    straddle,
    thetaBurnPct: straddle > 0 ? +((theta / straddle) * 100).toFixed(2) : null,
    vegaPerIvPointPct: straddle > 0 ? +((vega / straddle) * 100).toFixed(2) : null,
    deltaShift,
    deltaBasis,
    netChainDelta: Math.round(netChainDelta),
    expectedMove: expectedMoveFrom(straddle, spot, chain.expiryDays),
    expiryDays: chain.expiryDays,
  };
}

export function greeksFactor(reading: GreeksReading, cfg: MomentumConfig) {
  const weight = cfg.weights.greeks;
  const t = cfg.thresholds.greeks;

  if (reading.gamma === null || reading.deltaShift === null)
    return unavailable('greeks', weight, 'no ATM option with both legs quoted');

  const components: MixComponent[] = [
    { key: 'delta', weight: t.mix.delta, score: curve(Math.abs(reading.deltaShift), t.deltaShift) },
    { key: 'gamma', weight: t.mix.gamma, score: reading.gammaPer1Pct === null ? null : curve(reading.gammaPer1Pct, t.gammaNotional) },
    { key: 'theta', weight: t.mix.theta, score: reading.thetaBurnPct === null ? null : curve(reading.thetaBurnPct, t.thetaBurnPct) },
  ];
  const m = mix(components);

  // Only the delta shift carries a direction — gamma and theta are position qualities, not
  // views. `fullScale` is the knot at which the delta curve reaches ~85.
  const fullScale = t.deltaShift[t.deltaShift.length - 2]?.at || 0.18;
  const bias = squash(reading.deltaShift, fullScale);

  const rising = reading.deltaShift > 0;
  const lowTheta = (reading.thetaBurnPct ?? 100) <= (t.thetaBurnPct[1]?.at ?? 1.5);

  return outcome({
    key: 'greeks',
    weight,
    score: m.score,
    bias,
    metrics: {
      atmStrike: reading.atmStrike,
      callDelta: reading.callDelta,
      putDelta: reading.putDelta,
      deltaShift: reading.deltaShift,
      deltaBasis: reading.deltaBasis,
      gamma: reading.gamma,
      gammaPer1Pct: reading.gammaPer1Pct,
      theta: reading.theta,
      thetaBurnPct: reading.thetaBurnPct,
      vega: reading.vega,
      vegaPerIvPointPct: reading.vegaPerIvPointPct,
      straddle: reading.straddle,
      netChainDelta: reading.netChainDelta,
      expectedMoveRupees: reading.expectedMove?.rupees ?? null,
      expectedMovePct: reading.expectedMove?.pct ?? null,
      expiryDays: reading.expiryDays,
    },
    reasons: [
      {
        ok: Math.abs(reading.deltaShift) >= (t.deltaShift[1]?.at ?? 0.03),
        text: `Delta ${rising ? 'increasing' : 'decreasing'} ${reading.deltaShift >= 0 ? '+' : ''}${reading.deltaShift.toFixed(3)} (${reading.deltaBasis})`,
      },
      {
        ok: (reading.gammaPer1Pct ?? 0) >= (t.gammaNotional[1]?.at ?? 0.02),
        text: `Gamma ${reading.gammaPer1Pct?.toFixed(3) ?? '—'} delta per 1% move`,
      },
      {
        ok: lowTheta,
        text: `Theta ${reading.thetaBurnPct?.toFixed(2) ?? '—'}%/day of the straddle${lowTheta ? ' — low decay risk' : ' — decay is heavy'}`,
      },
    ],
    note: DELTA_BASIS_NOTE[reading.deltaBasis],
  });
}
