// Which contract to buy — the one output of this module that ends in an order.
//
// The option chain is fetched through `momentum/data/option-chain.ts`. That is a deliberate
// import rather than a copy: unlike the quote snapshot, which needed index futures and index
// spots the momentum universe does not carry, the chain fetcher contains no momentum domain
// logic at all — it is an underlying-agnostic wrapper over `/v2/option/chain` plus the
// expiry-selection rule (never the contract expiring today, because its open interest collapses
// into the next series through the session). Re-implementing 190 lines of that to avoid an
// import would give two places for the `prev_oi`-is-yesterday trap to be got wrong.
//
// WHY A DELTA BAND AND NOT A PAYOFF RANKING. Ranking strikes purely on net payoff at the target
// — which is what a momentum scalp should do — walks out to the cheapest contract on the sheet
// every single time, because a cheap enough option always shows the highest percentage. For a
// pullback entry that is the wrong answer twice over: the hold is one to two hours, so decay is
// charged rather than ignored, and a 0.12-delta contract stops tracking the underlying the plan
// was built on, so the stop that defines the trade no longer defines the position. The brief's
// bands — 0.30–0.45 for a pullback entry, 0.45–0.60 when joining a trend already in motion —
// are the range where the contract both moves with the stock and is worth the premium, and the
// payoff ranking is applied INSIDE the band rather than instead of it.
//
// WHY THE LIQUIDITY SCORE IS A SCORE. The brief lists "very low option liquidity" among the
// conditions that must suppress a signal, and no single reading captures it. A strike can carry
// 400,000 open interest and be quoted 4.00 × 5.20; another can be a paisa wide with nothing
// resting behind it. Both are untradable in different ways, so spread, open interest, traded
// volume and resting size are mixed — and the mix is what the veto is applied to.
//
// THE INDEX BASIS. For an index the plan is computed on the FUTURE (see `data/universe.ts` —
// the index publishes no volume, so there is no other way to have VWAP or a volume gate) while
// the option is struck on SPOT. Those differ by the basis, which is tens of points on BANKNIFTY.
// `spotAdjust` translates the plan's prices into the space the option actually references. A
// module that skipped that step would quote every index option's payoff against a price the
// option does not reference — and the error would be invisible, because the number would look
// entirely reasonable.

import { atmRow, type ChainLeg, type ChainRow, type StockChain } from '../../momentum/data/option-chain.js';
import { clamp, curve } from '../indicators/series.js';
import type {
  EntryKind, LiquidityScore, OptionPick, OptionSide, PullbackConfig,
} from '../types.js';

/** A trading day is 6.25 hours, which is what a daily theta has to be spread across. */
const SESSION_HOURS = 6.25;

const r2 = (v: number): number => +v.toFixed(2);

export interface OptionInput {
  chain: StockChain | null;
  direction: 1 | -1;
  entryKind: EntryKind;
  /** Entry and target in the SERIES instrument's price space (the future, for an index). */
  entry: number;
  target: number;
  /**
   * Added to a series price to get the equivalent spot price. Zero for a stock; the negative
   * of the futures basis for an index.
   */
  spotAdjust: number;
  lotSize: number | null;
  cfg: PullbackConfig;
}

/* ------------------------------------------------------------------- liquidity --- */

/**
 * How tradable one contract actually is, 0–100.
 *
 * Components that cannot be measured drop out of both the numerator and the normalising weight,
 * so a chain that quotes no size is scored on spread and open interest rather than being scored
 * as illiquid. The difference matters: outside market hours every leg quotes zero size, and a
 * scorer that read that as "no depth" would grade the entire chain Poor at 16:00.
 *
 * THE SPREAD IS BOTH A COMPONENT AND A CEILING, which is the one place this scorer is deliberately
 * not a weighted average. A contract quoted 16.00 × 24.00 with 400,000 open interest scores well
 * on three of the four readings and is not tradable at all: a 40%-wide book costs more to cross
 * than the entire 2R plan pays. A weighted mix cannot express that, because averaging is exactly
 * the wrong operation for a reading that makes the others irrelevant — so the spread score also
 * scales the total, halving it at the worst and leaving it alone at the best.
 */
export function scoreLiquidity(leg: ChainLeg, lotSize: number | null, cfg: PullbackConfig): LiquidityScore {
  const c = cfg.option.curves;
  const mix = cfg.option.liquidityMix;
  const reasons: string[] = [];

  const twoSided = leg.bid > 0 && leg.ask > 0 && leg.ask >= leg.bid;
  const mid = twoSided ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const spreadPct = twoSided && mid > 0 ? ((leg.ask - leg.bid) / mid) * 100 : null;

  const restingLots = lotSize && lotSize > 0 && leg.bidQty > 0 && leg.askQty > 0
    ? Math.min(leg.bidQty, leg.askQty) / lotSize
    : null;

  const components = {
    spread: spreadPct === null ? null : +curve(c.spreadPct, spreadPct).toFixed(1),
    openInterest: +curve(c.oi, leg.oi).toFixed(1),
    volume: +curve(c.volume, leg.volume).toFixed(1),
    depth: restingLots === null ? null : +curve(c.depthLots, restingLots).toFixed(1),
  };

  const parts: Array<{ v: number; w: number }> = [];
  if (components.spread !== null) parts.push({ v: components.spread, w: mix.spread });
  parts.push({ v: components.openInterest, w: mix.openInterest });
  parts.push({ v: components.volume, w: mix.volume });
  if (components.depth !== null) parts.push({ v: components.depth, w: mix.depth });

  const weight = parts.reduce((a, p) => a + p.w, 0);
  const weighted = weight > 0 ? parts.reduce((a, p) => a + p.v * p.w, 0) / weight : 0;
  // The ceiling. 0.5 at a hopeless spread, 1.0 at a tight one — so a wide book cannot be bought
  // out of by open interest, and a tight one is never penalised for the gate existing.
  const gate = components.spread === null ? 1 : 0.5 + 0.5 * (components.spread / 100);
  const score = +(weighted * gate).toFixed(1);

  if (spreadPct === null) reasons.push('one-sided book — spread not measurable');
  else {
    reasons.push(`${spreadPct.toFixed(1)}% bid-ask`);
    if (gate < 0.75) reasons.push(`the book is wide enough to cap this score at ${Math.round(gate * 100)}% of its other readings`);
  }
  reasons.push(`${leg.oi.toLocaleString('en-IN')} open interest`);
  reasons.push(leg.volume > 0 ? `${leg.volume.toLocaleString('en-IN')} traded today` : 'nothing traded today');
  if (restingLots !== null) reasons.push(`${restingLots.toFixed(1)} lots resting at the touch`);

  return {
    score,
    grade: score >= 80 ? 'Excellent' : score >= 62 ? 'Good' : score >= 45 ? 'Average' : 'Poor',
    components,
    reasons,
  };
}

/* ------------------------------------------------------------------ selection --- */

interface Scored {
  pick: OptionPick;
  /** Net gain at target after paying the ask and selling the bid. The ranking key. */
  netGainPct: number;
  inBand: boolean;
}

/** Index of the row nearest `spot`. The chain's own `atmStrike` may not be quoted. */
function atmIndex(rows: ChainRow[], spot: number): number {
  let best = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].strike - spot) < Math.abs(rows[best].strike - spot)) best = i;
  }
  return best;
}

function evaluate(
  row: ChainRow,
  side: OptionSide,
  stepsFromAtm: number,
  i: OptionInput,
  spot: number,
  targetSpot: number,
  band: { min: number; max: number },
): Scored | null {
  const leg: ChainLeg | null = side === 'CE' ? row.call : row.put;
  if (!leg || !(leg.ltp > 0) || !Number.isFinite(leg.delta) || leg.delta === 0) return null;

  const o = i.cfg.option;
  const delta = leg.delta;
  const gamma = Number.isFinite(leg.gamma) ? leg.gamma : 0;

  // What you pay and what you would get back, rather than the mid twice. A strike whose book is
  // 6% wide has to make 6% before it is level, and ranking on the mid hides that entirely.
  const twoSided = leg.bid > 0 && leg.ask > 0 && leg.ask >= leg.bid;
  const mid = twoSided ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const spreadPct = twoSided && mid > 0 ? r2(((leg.ask - leg.bid) / mid) * 100) : null;
  const halfSpread = twoSided ? (leg.ask - leg.bid) / 2 : 0;
  const entryCost = twoSided ? leg.ask : leg.ltp;
  if (!(entryCost > 0)) return null;

  // Second-order, not first. The strikes worth buying here are the ones whose delta is still
  // rising through the move, and a linearisation would understate exactly those.
  const move = targetSpot - spot;
  const premiumAtTarget = Math.max(0, leg.ltp + delta * move + 0.5 * gamma * move * move);
  const exitValue = Math.max(0, premiumAtTarget - halfSpread);
  const netGainPct = ((exitValue - entryCost) / entryCost) * 100;

  const thetaPctPerHour = leg.ltp > 0 && Number.isFinite(leg.theta)
    ? r2((Math.abs(leg.theta) / SESSION_HOURS / leg.ltp) * 100)
    : null;

  const liquidity = scoreLiquidity(leg, i.lotSize, i.cfg);

  const warnings: string[] = [];
  if (spreadPct !== null && spreadPct > o.maxSpreadPct)
    warnings.push(`bid-ask is ${spreadPct.toFixed(1)}% wide — the spread alone costs more than a 1R move pays`);
  if (leg.oi < o.minOi)
    warnings.push(`only ${leg.oi.toLocaleString('en-IN')} open interest — getting out may be slow`);
  if (leg.volume < o.minVolume)
    warnings.push(leg.volume > 0 ? `only ${leg.volume.toLocaleString('en-IN')} traded today` : 'nothing has traded in this strike today');
  if (thetaPctPerHour !== null && thetaPctPerHour > o.maxThetaPctPerHour)
    warnings.push(`decay is ${thetaPctPerHour.toFixed(1)}% of the premium an hour — too fast for a multi-hour hold`);
  if (liquidity.score < o.minLiquidityScore)
    warnings.push(`liquidity ${liquidity.score.toFixed(0)}/100 (${liquidity.grade}) is below the ${o.minLiquidityScore} floor`);

  const absDelta = Math.abs(delta);
  const moneyness: OptionPick['moneyness'] = stepsFromAtm === 0 ? 'ATM' : stepsFromAtm > 0 ? 'OTM' : 'ITM';

  const pick: OptionPick = {
    symbol: i.chain?.symbol ?? '',
    side,
    strike: row.strike,
    label: `${row.strike} ${side}`,
    instrumentKey: leg.instrumentKey,
    expiry: i.chain?.expiry ?? '',
    expiryDays: i.chain?.expiryDays ?? 0,
    moneyness,
    stepsFromAtm,

    premium: r2(leg.ltp),
    entryCost: r2(entryCost),
    bid: r2(leg.bid),
    ask: r2(leg.ask),
    spreadPct,

    delta: +delta.toFixed(4),
    gamma: Number.isFinite(leg.gamma) ? +leg.gamma.toFixed(6) : null,
    theta: Number.isFinite(leg.theta) ? r2(leg.theta) : null,
    thetaPctPerHour,
    vega: Number.isFinite(leg.vega) ? r2(leg.vega) : null,
    iv: Number.isFinite(leg.iv) && leg.iv > 0 ? r2(leg.iv) : null,
    oi: leg.oi,
    // Day-over-day, not intraday: Upstox's `prev_oi` on a chain leg is the previous session's
    // close and there is no intraday equivalent. Named so the timescale travels with the number.
    oiChange: leg.prevOi > 0 ? leg.oi - leg.prevOi : null,
    volume: leg.volume,

    lotSize: i.lotSize && i.lotSize > 0 ? i.lotSize : null,
    costPerLot: i.lotSize && i.lotSize > 0 ? Math.round(entryCost * i.lotSize) : null,
    premiumAtTarget: r2(premiumAtTarget),
    gainPctAtTarget: +netGainPct.toFixed(1),
    profitPerLot: i.lotSize && i.lotSize > 0 ? Math.round((exitValue - entryCost) * i.lotSize) : null,
    breakEven: r2(side === 'CE' ? row.strike + entryCost : row.strike - entryCost),

    liquidity,
    band: {
      min: band.min,
      max: band.max,
      reason: i.entryKind === 'pullback'
        ? 'a pullback entry is a one-to-two-hour hold with a defined stop — enough leverage to be worth the premium, enough delta to still track the stop'
        : 'joining a trend already in motion is a longer hold from a worse entry — this band buys delta rather than leverage',
    },
    reason: '',
    warnings,
  };

  return { pick, netGainPct, inBand: absDelta >= band.min && absDelta <= band.max };
}

/**
 * Pick the contract.
 *
 * Candidates are a window either side of the money. The band is applied as a FILTER first and
 * relaxed to a preference only if nothing on the chain sits inside it — which happens on thin
 * stock chains where the strike ladder is coarse, and where returning nothing would be a worse
 * answer than returning the nearest tradable contract with the mismatch stated on it.
 *
 * When nothing clears the floors at all, the nearest priced strike comes back WITH its warnings.
 * "Here is the contract and here is what is wrong with it" is useful; silence is
 * indistinguishable from the chain having failed to load.
 */
export function selectOption(i: OptionInput): OptionPick | null {
  const chain = i.chain;
  if (!chain || !chain.rows.length) return null;

  const o = i.cfg.option;
  const side: OptionSide = i.direction === 1 ? 'CE' : 'PE';

  // The chain's own spot when it published one, else the plan's entry translated into spot
  // space. The chain's is preferred because it is the price the greeks on it were computed from.
  const spot = chain.spot > 0 ? chain.spot : i.entry + i.spotAdjust;
  const targetSpot = i.target + i.spotAdjust;
  if (!(spot > 0)) return null;

  const band = i.entryKind === 'pullback' ? o.pullbackDelta : o.holdingDelta;
  const rows = chain.rows;
  const atm = atmIndex(rows, spot);
  // A call gets further out of the money as the strike rises; a put as it falls.
  const step = i.direction === 1 ? 1 : -1;

  const candidates: Scored[] = [];
  for (let s = -Math.abs(o.itmSteps); s <= Math.abs(o.otmSteps); s++) {
    const idx = atm + s * step;
    if (idx < 0 || idx >= rows.length) continue;
    const scored = evaluate(rows[idx], side, s, i, spot, targetSpot, band);
    if (scored) candidates.push(scored);
  }
  if (!candidates.length) return null;

  const clean = candidates.filter(
    (c) => c.pick.liquidity.score >= o.minLiquidityScore && c.pick.oi >= o.minOi && c.netGainPct > 0,
  );

  if (!clean.length) {
    const nearest = candidates.reduce((a, b) =>
      Math.abs(a.pick.stepsFromAtm) <= Math.abs(b.pick.stepsFromAtm) ? a : b);
    return {
      ...nearest.pick,
      reason: 'nearest strike to the money — nothing on this chain cleared the liquidity and open-interest floors',
      warnings: [
        ...nearest.pick.warnings,
        `no strike here is both tradable (liquidity ≥ ${o.minLiquidityScore}) and has ${o.minOi.toLocaleString('en-IN')}+ open interest`,
      ],
    };
  }

  const inBand = clean.filter((c) => c.inBand);
  const pool = inBand.length ? inBand : clean;

  const best = pool.reduce((a, b) => {
    if (b.netGainPct !== a.netGainPct) return b.netGainPct > a.netGainPct ? b : a;
    // Same payoff, take the more tradable book.
    return b.pick.liquidity.score > a.pick.liquidity.score ? b : a;
  });

  const alternatives = pool.length - 1;
  const banded = inBand.length > 0;

  return {
    ...best.pick,
    warnings: banded
      ? best.pick.warnings
      : [
          ...best.pick.warnings,
          `no strike on this chain sits in the ${band.min.toFixed(2)}–${band.max.toFixed(2)} delta band this hold wants — ` +
          `picked on payoff instead (delta ${Math.abs(best.pick.delta).toFixed(2)}), so watch the decay`,
        ],
    reason:
      `${best.pick.moneyness}${best.pick.stepsFromAtm !== 0 ? ` by ${Math.abs(best.pick.stepsFromAtm)} strike${Math.abs(best.pick.stepsFromAtm) > 1 ? 's' : ''}` : ''}` +
      (banded
        ? ` — best net payoff of ${alternatives + 1} strike${alternatives ? 's' : ''} inside the ${band.min.toFixed(2)}–${band.max.toFixed(2)} delta band`
        : ` — best net payoff of ${alternatives + 1} tradable strike${alternatives ? 's' : ''}`) +
      ` (delta ${Math.abs(best.pick.delta).toFixed(2)}, liquidity ${best.pick.liquidity.score.toFixed(0)}` +
      `${best.pick.spreadPct !== null ? `, ${best.pick.spreadPct.toFixed(1)}% spread` : ''})`,
  };
}

/**
 * The ATM implied volatility, for the row's context panel.
 *
 * Kept here rather than in a factor of its own because this module does not score volatility —
 * it reports it. A pullback entry with a defined stop and a two-hour horizon is not primarily an
 * IV trade, and pretending otherwise by weighting it into the confidence score would be scoring
 * something the strategy has no view on.
 */
export function atmIv(chain: StockChain | null): number | null {
  const row = chain ? atmRow(chain) : null;
  const ivs = [row?.call?.iv, row?.put?.iv].filter((v): v is number => typeof v === 'number' && v > 0);
  return ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(2) : null;
}

export { clamp };
