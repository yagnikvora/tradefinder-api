// Which contract to actually buy.
//
// Everything else in this module answers questions about the STOCK. This answers the only
// question that ends in an order: given a direction and a price target, which strike, and
// what does it cost.
//
// WHY NOT JUST "BUY THE ATM"
//
// The plan's target is a fraction of an ATR — typically 0.4–0.6% of the underlying. Run that
// through three strikes of the same chain and they are not the same trade:
//
//   ATM      delta ~0.50, premium ~2% of spot   →  a 0.5% move pays ~13%
//   1 OTM    delta ~0.37, premium ~1.2%         →  the same move pays ~16%
//   3 OTM    delta ~0.15, premium ~0.4%         →  the same move pays ~19% on paper, and the
//                                                  spread is 8% wide, so it pays nothing
//
// The leverage keeps rising as you go out and the tradability collapses. The selection below
// resolves that by ranking on a NET figure: buy at the ask, sell at the bid, so a strike with
// a wide book is penalised by exactly the amount that book will cost — which is the whole
// difference between the third row above looking best and being unsellable.
//
// A HARD DELTA FLOOR sits underneath it. Below ~0.25 the option stops tracking the
// underlying: the move the plan is built on moves the premium less than the day's decay
// does, and the position becomes a bet on the tail rather than on the leg being signalled.
// Ranking alone would not catch that, because a cheap enough option always shows the highest
// percentage.
//
// SECOND-ORDER, NOT FIRST. The premium at target is `delta·ΔS + ½·gamma·ΔS²`, which matters
// here more than it does for the ATM read: the strikes worth buying are the ones whose delta
// is still rising through the move, and a linearisation would understate exactly those.
//
// WHAT IS NOT MODELLED, and is reported instead of guessed: the implied-volatility change
// over the hold, and time decay beyond the hourly figure carried on the choice. Both move
// real premiums and neither is forecastable from one chain snapshot.

import type { MomentumConfig, OptionType, StrikeChoice } from '../types.js';
import type { ChainLeg, ChainRow, StockChain } from '../data/option-chain.js';

const round = (v: number, d = 2): number => +v.toFixed(d);

/** A trading day is 6.25 hours, which is what a daily theta has to be spread across. */
const SESSION_HOURS = 6.25;

export interface StrikeInputs {
  chain: StockChain | null;
  /** +1 buys a call, −1 buys a put. */
  direction: 1 | -1;
  spot: number;
  /** The plan's target price for the UNDERLYING. */
  targetPrice: number;
  /** From the futures contract — NSE lists the same lot for options on that underlying. */
  lotSize: number | null;
  config: MomentumConfig;
}

interface Scored {
  choice: StrikeChoice;
  /** Net gain at target after paying the ask and selling the bid. The ranking key. */
  netGainPct: number;
}

/** Index of the row nearest the spot. The chain's own `atmStrike` may not be quoted. */
function atmIndex(rows: ChainRow[], spot: number): number {
  let best = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].strike - spot) < Math.abs(rows[best].strike - spot)) best = i;
  }
  return best;
}

function evaluate(
  row: ChainRow,
  type: OptionType,
  stepsFromAtm: number,
  i: StrikeInputs,
): Scored | null {
  const leg: ChainLeg | null = type === 'CE' ? row.call : row.put;
  if (!leg || !(leg.ltp > 0) || !Number.isFinite(leg.delta) || leg.delta === 0) return null;

  const t = i.config.signal.strike;
  const delta = leg.delta;
  const gamma = Number.isFinite(leg.gamma) ? leg.gamma : 0;

  // What you pay and what you would get back, rather than the mid twice. A strike whose book
  // is 6% wide has to make 6% before it is level, and ranking on the mid hides that entirely.
  const twoSided = leg.bid > 0 && leg.ask > 0 && leg.ask >= leg.bid;
  const mid = twoSided ? (leg.bid + leg.ask) / 2 : leg.ltp;
  const spreadPct = twoSided && mid > 0 ? round(((leg.ask - leg.bid) / mid) * 100, 2) : null;
  const halfSpread = twoSided ? (leg.ask - leg.bid) / 2 : 0;
  const entryCost = twoSided ? leg.ask : leg.ltp;
  if (!(entryCost > 0)) return null;

  const moveS = i.targetPrice - i.spot;
  const premiumAtTarget = Math.max(0, leg.ltp + delta * moveS + 0.5 * gamma * moveS * moveS);
  const exitValue = Math.max(0, premiumAtTarget - halfSpread);
  const netGainPct = ((exitValue - entryCost) / entryCost) * 100;

  const warnings: string[] = [];
  if (spreadPct !== null && spreadPct > t.maxSpreadPct)
    warnings.push(`bid-ask is ${spreadPct.toFixed(1)}% wide — the spread alone costs more than a small move pays`);
  if (leg.oi < t.minOi)
    warnings.push(`only ${leg.oi.toLocaleString('en-IN')} open interest — getting out may be slow`);
  if (leg.volume <= 0) warnings.push('nothing has traded in this strike today');

  const thetaPctPerHour =
    leg.ltp > 0 && Number.isFinite(leg.theta)
      ? round((Math.abs(leg.theta) / SESSION_HOURS / leg.ltp) * 100, 2)
      : null;
  if (thetaPctPerHour !== null && thetaPctPerHour > t.maxThetaPctPerHour)
    warnings.push(`decay is ${thetaPctPerHour.toFixed(1)}% of the premium an hour — this is not a position to sit in`);

  const moneyness: StrikeChoice['moneyness'] =
    stepsFromAtm === 0 ? 'ATM' : stepsFromAtm > 0 ? 'OTM' : 'ITM';

  const choice: StrikeChoice = {
    strike: row.strike,
    type,
    label: `${row.strike} ${type}`,
    instrumentKey: leg.instrumentKey,
    expiry: i.chain?.expiry ?? '',
    expiryDays: i.chain?.expiryDays ?? 0,
    stepsFromAtm,
    moneyness,
    premium: round(leg.ltp),
    entryCost: round(entryCost),
    bid: round(leg.bid),
    ask: round(leg.ask),
    spreadPct,
    delta: round(delta, 4),
    gamma: Number.isFinite(leg.gamma) ? round(leg.gamma, 6) : null,
    iv: Number.isFinite(leg.iv) && leg.iv > 0 ? round(leg.iv, 2) : null,
    thetaPctPerHour,
    oi: leg.oi,
    volume: leg.volume,
    lotSize: i.lotSize && i.lotSize > 0 ? i.lotSize : null,
    costPerLot: i.lotSize && i.lotSize > 0 ? Math.round(entryCost * i.lotSize) : null,
    premiumAtTarget: round(premiumAtTarget),
    gainPctAtTarget: round(netGainPct, 1),
    profitPerLot:
      i.lotSize && i.lotSize > 0 ? Math.round((exitValue - entryCost) * i.lotSize) : null,
    breakEven: round(type === 'CE' ? row.strike + entryCost : row.strike - entryCost),
    reason: '',
    warnings,
  };

  return { choice, netGainPct };
}

/**
 * Pick the contract.
 *
 * Candidates are a window either side of the money — a little in, further out — and the
 * winner is the highest NET gain at the plan's target among those whose delta still tracks
 * the underlying. Everything rejected is rejected for a stated reason, and if nothing clears
 * the floors the nearest priced strike is returned WITH its warnings rather than nothing at
 * all: "here is the contract and here is what is wrong with it" is useful, and silence is
 * indistinguishable from the chain having failed to load.
 */
export function selectStrike(i: StrikeInputs): StrikeChoice | null {
  if (!i.chain || !i.chain.rows.length || !(i.spot > 0)) return null;

  const t = i.config.signal.strike;
  const type: OptionType = i.direction === 1 ? 'CE' : 'PE';
  const rows = i.chain.rows;
  const atm = atmIndex(rows, i.spot);

  // A call gets more out of the money as the strike rises; a put as it falls. `step` turns
  // "one strike further out" into an index move for either.
  const step = i.direction === 1 ? 1 : -1;

  const candidates: Scored[] = [];
  for (let s = -Math.abs(t.itmSteps); s <= Math.abs(t.otmSteps); s++) {
    const idx = atm + s * step;
    if (idx < 0 || idx >= rows.length) continue;
    const scored = evaluate(rows[idx], type, s, i);
    if (scored) candidates.push(scored);
  }
  if (!candidates.length) return null;

  const tradable = candidates.filter(
    (c) => Math.abs(c.choice.delta) >= t.minDelta && c.choice.oi >= t.minOi && c.netGainPct > 0,
  );

  if (!tradable.length) {
    // Nothing clears the floors. Return the nearest priced strike and say so — this is the
    // normal state in an illiquid name, and the honest answer is "this one, but".
    const nearest = candidates.reduce((a, b) =>
      Math.abs(a.choice.stepsFromAtm) <= Math.abs(b.choice.stepsFromAtm) ? a : b,
    );
    return {
      ...nearest.choice,
      reason: 'nearest strike to the money — none of this chain cleared the delta and open-interest floors',
      warnings: [
        ...nearest.choice.warnings,
        `no strike here both tracks the underlying (|delta| ≥ ${t.minDelta}) and has ${t.minOi.toLocaleString('en-IN')}+ open interest`,
      ],
    };
  }

  const best = tradable.reduce((a, b) => {
    if (b.netGainPct !== a.netGainPct) return b.netGainPct > a.netGainPct ? b : a;
    // Same payoff, take the tighter book.
    return (b.choice.spreadPct ?? 99) < (a.choice.spreadPct ?? 99) ? b : a;
  });

  const alternatives = tradable.filter((c) => c !== best).length;
  return {
    ...best.choice,
    reason:
      `${best.choice.moneyness}${best.choice.stepsFromAtm !== 0 ? ` by ${Math.abs(best.choice.stepsFromAtm)} strike${Math.abs(best.choice.stepsFromAtm) > 1 ? 's' : ''}` : ''}` +
      ` — best net payoff at the target of ${alternatives + 1} tradable strikes` +
      ` (delta ${Math.abs(best.choice.delta).toFixed(2)}` +
      `${best.choice.spreadPct !== null ? `, ${best.choice.spreadPct.toFixed(1)}% spread` : ''})`,
  };
}
