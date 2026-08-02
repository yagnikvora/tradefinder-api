// Factor 5 — Option Chain / OI Build-up.
//
// The classification the brief asks for is a price-and-open-interest table, and it is
// defined on the FUTURE, not on the option chain:
//
//   price up,   OI up    Long Build-up      new longs, fresh money, the strongest read
//   price down, OI up    Short Build-up     new shorts, fresh money the other way
//   price up,   OI down  Short Covering     shorts closing — real, but buying that ends
//   price down, OI down  Long Unwinding     longs closing
//
// Reading it off the future is not a stylistic choice. An NSE_EQ quote answers `oi: 0` by
// definition — the share has no open interest — so the only place a stock's outstanding
// derivative position lives is its futures contract, which the Tier-A batch already prices
// (`oi`, `oi_day_high`, `oi_day_low`) at no extra cost.
//
// The option chain then adds the call/put SKEW, which is a different statement: puts being
// written faster than calls is bullish positioning even on a day the future is flat. The
// two are mixed by configurable weights.
//
// A TIMESCALE WARNING THAT IS EASY TO GET WRONG. The futures OI change is intraday —
// current OI against the previous session's close, which the daily baseline captured off
// the futures daily candle. The option OI change is day-over-day, because Upstox's
// `prev_oi` on a chain leg IS the previous session's close and there is no intraday
// equivalent. Both are reported under names that say which is which.

import type { MomentumConfig, OiBuildUp } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import type { StockChain } from '../data/option-chain.js';
import { curve, fmtPct, mix, outcome, signOf, squash, unavailable, type MixComponent } from './scoring.js';

export interface OptionFlowReading {
  buildUp: OiBuildUp | null;
  futuresOi: number | null;
  prevFuturesOi: number | null;
  futuresOiChangePct: number | null;
  futuresPriceChangePct: number | null;
  /** Intraday OI travel as a % of the day's opening OI — how much churn there has been. */
  futuresOiRangePct: number | null;

  callOi: number | null;
  putOi: number | null;
  callOiChange: number | null;
  putOiChange: number | null;
  /** (put OI change − call OI change) ÷ total chain OI, in percent. Positive is bullish. */
  optionOiSkewPct: number | null;
  pcrOi: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  optionValueCr: number | null;
  expiry: string | null;
  expiryDays: number | null;
}

export function classifyBuildUp(pricePct: number, oiPct: number, deadband: number): OiBuildUp {
  const p = signOf(pricePct, deadband);
  const o = signOf(oiPct, deadband);
  if (p === 0 || o === 0) return 'Neutral';
  if (p > 0 && o > 0) return 'Long Build-up';
  if (p < 0 && o > 0) return 'Short Build-up';
  if (p > 0 && o < 0) return 'Short Covering';
  return 'Long Unwinding';
}

/**
 * Max pain — the strike at which the most option value expires worthless.
 *
 * Total intrinsic value paid out to holders if the underlying settled at each strike; the
 * minimum is max pain. Included because it is the level desks quote, not because the model
 * scores on it.
 */
export function maxPainStrike(chain: StockChain): number | null {
  if (chain.rows.length < 3) return null;
  let best: { strike: number; pain: number } | null = null;
  for (const candidate of chain.rows) {
    let pain = 0;
    for (const r of chain.rows) {
      if (r.call) pain += Math.max(0, candidate.strike - r.strike) * r.call.oi;
      if (r.put) pain += Math.max(0, r.strike - candidate.strike) * r.put.oi;
    }
    if (!best || pain < best.pain) best = { strike: candidate.strike, pain };
  }
  return best?.strike ?? null;
}

export function computeOptionFlow(
  future: MomentumQuote | undefined,
  baseline: SymbolBaseline | undefined,
  chain: StockChain | null,
  deadbandPct = 0.05,
): OptionFlowReading {
  const reading: OptionFlowReading = {
    buildUp: null,
    futuresOi: null, prevFuturesOi: null, futuresOiChangePct: null,
    futuresPriceChangePct: null, futuresOiRangePct: null,
    callOi: null, putOi: null, callOiChange: null, putOiChange: null,
    optionOiSkewPct: null, pcrOi: null, pcrVolume: null, maxPain: null,
    optionValueCr: null, expiry: null, expiryDays: null,
  };

  // ---- futures side ----------------------------------------------------------------
  if (future && future.openInterest > 0) {
    reading.futuresOi = future.openInterest;
    reading.futuresPriceChangePct = future.changePct;
    // Prefer the baseline's previous CLOSING OI. `oi_day_low` is a live low, not an open,
    // and using it would report a build-up on any contract whose OI dipped this morning.
    const prev = baseline?.prevFuturesOi ?? null;
    reading.prevFuturesOi = prev;
    if (prev && prev > 0) {
      reading.futuresOiChangePct = +(((future.openInterest - prev) / prev) * 100).toFixed(3);
      reading.buildUp = classifyBuildUp(future.changePct, reading.futuresOiChangePct, deadbandPct);
    }
    if (future.oiDayHigh > 0 && future.oiDayLow > 0)
      reading.futuresOiRangePct = +(((future.oiDayHigh - future.oiDayLow) / future.oiDayLow) * 100).toFixed(3);
  }

  // ---- option-chain side -----------------------------------------------------------
  if (chain && chain.rows.length) {
    let callOi = 0, putOi = 0, callPrev = 0, putPrev = 0, callVol = 0, putVol = 0, valueRupees = 0;
    for (const r of chain.rows) {
      if (r.call) {
        callOi += r.call.oi; callPrev += r.call.prevOi; callVol += r.call.volume;
        valueRupees += r.call.volume * r.call.ltp;
      }
      if (r.put) {
        putOi += r.put.oi; putPrev += r.put.prevOi; putVol += r.put.volume;
        valueRupees += r.put.volume * r.put.ltp;
      }
    }

    const totalOi = callOi + putOi;
    reading.callOi = callOi;
    reading.putOi = putOi;
    reading.callOiChange = callOi - callPrev;
    reading.putOiChange = putOi - putPrev;
    reading.optionOiSkewPct = totalOi > 0
      ? +((((putOi - putPrev) - (callOi - callPrev)) / totalOi) * 100).toFixed(3)
      : null;
    reading.pcrOi = callOi > 0 ? +(putOi / callOi).toFixed(3) : null;
    reading.pcrVolume = callVol > 0 ? +(putVol / callVol).toFixed(3) : null;
    reading.maxPain = maxPainStrike(chain);
    // Upstox quotes option volume and OI in UNITS, not lots — verified in the existing
    // money-flux work — so volume × price is already rupees with no lot multiplier.
    reading.optionValueCr = +(valueRupees / 1e7).toFixed(2);
    reading.expiry = chain.expiry;
    reading.expiryDays = chain.expiryDays;
  }

  return reading;
}

export function optionFlowFactor(reading: OptionFlowReading, cfg: MomentumConfig) {
  const weight = cfg.weights.optionFlow;
  const t = cfg.thresholds.optionFlow;

  const hasFutures = reading.futuresOiChangePct !== null && reading.buildUp !== null;
  const hasChain = reading.optionOiSkewPct !== null;
  if (!hasFutures && !hasChain)
    return unavailable('optionFlow', weight, 'no futures open interest and no option chain for this symbol');

  const components: MixComponent[] = [
    {
      key: 'futuresOi',
      weight: t.mix.futuresOi,
      score: hasFutures ? curve(Math.abs(reading.futuresOiChangePct as number), t.futuresOiChangePct) : null,
    },
    {
      key: 'optionOi',
      weight: t.mix.optionOi,
      score: hasChain ? curve(Math.abs(reading.optionOiSkewPct as number), t.optionOiSkewPct) : null,
    },
  ];
  const m = mix(components);

  // Build-up class gives the direction; the size of the OI move gives the conviction.
  const buildUpBias = reading.buildUp ? t.buildUpBias[reading.buildUp] ?? 0 : 0;
  const futuresBias = hasFutures
    ? buildUpBias * Math.abs(squash(reading.futuresOiChangePct as number, t.fullScaleOiPct))
    : 0;
  const chainBias = hasChain ? squash(reading.optionOiSkewPct as number, t.fullScaleOiPct) : 0;
  const usedWeight = (hasFutures ? t.mix.futuresOi : 0) + (hasChain ? t.mix.optionOi : 0);
  const bias = usedWeight > 0
    ? (futuresBias * (hasFutures ? t.mix.futuresOi : 0) + chainBias * (hasChain ? t.mix.optionOi : 0)) / usedWeight
    : 0;

  const reasons = [];
  if (hasFutures)
    reasons.push({
      ok: reading.buildUp === 'Long Build-up' || reading.buildUp === 'Short Build-up',
      text: `${reading.buildUp} — futures OI ${fmtPct(reading.futuresOiChangePct as number)} on price ${fmtPct(reading.futuresPriceChangePct ?? 0)}`,
    });
  if (hasChain)
    reasons.push({
      ok: Math.abs(reading.optionOiSkewPct as number) >= (t.optionOiSkewPct[1]?.at ?? 1),
      text: `Option OI skew ${fmtPct(reading.optionOiSkewPct as number)} (${(reading.optionOiSkewPct as number) >= 0 ? 'put' : 'call'} writing), PCR ${reading.pcrOi?.toFixed(2) ?? '—'}`,
    });

  const notes: string[] = [];
  if (!hasFutures) notes.push('no futures OI — scored on the chain alone');
  if (!hasChain) notes.push('option chain needs the enrichment pass');

  return outcome({
    key: 'optionFlow',
    weight,
    score: m.score,
    bias,
    metrics: {
      buildUp: reading.buildUp,
      futuresOi: reading.futuresOi,
      prevFuturesOi: reading.prevFuturesOi,
      futuresOiChangePct_intraday: reading.futuresOiChangePct,
      futuresPriceChangePct: reading.futuresPriceChangePct,
      futuresOiRangePct: reading.futuresOiRangePct,
      callOi: reading.callOi,
      putOi: reading.putOi,
      callOiChange_dayOverDay: reading.callOiChange,
      putOiChange_dayOverDay: reading.putOiChange,
      optionOiSkewPct_dayOverDay: reading.optionOiSkewPct,
      pcrOi: reading.pcrOi,
      pcrVolume: reading.pcrVolume,
      maxPain: reading.maxPain,
      optionValueCr: reading.optionValueCr,
      expiry: reading.expiry,
      expiryDays: reading.expiryDays,
    },
    reasons,
    note: notes.length ? notes.join('; ') : undefined,
  });
}
