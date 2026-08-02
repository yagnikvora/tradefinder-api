// Factor 4 — VWAP. Where price sits against the day's average, and which way that average
// is going.
//
// Position alone is half the read. Price 1% above a FALLING VWAP is a stock being sold into
// strength; price 0.3% above a rising one is a trend with the average following it up. The
// brief asks for both ("Price > VWAP", "VWAP Rising") and they are mixed by configurable
// weights here.
//
// Neither costs a request. The level is `average_price` in the Tier-A quote, which is the
// session VWAP (verified against candle-derived VWAP to 0.002% on three names). The slope
// is a least-squares fit over the readings `session-state.ts` has been keeping, which are
// the same 30-second polls that drive everything else.
//
// The slope needs about two minutes of polling before it means anything, so on a cold start
// the factor scores on distance alone and says the slope is warming up. That is a real
// state and is reported, not smoothed over with a zero.

import type { MomentumConfig } from '../types.js';
import type { MomentumQuote } from '../data/quotes.js';
import { intervalVwap, vwapSlopePctPerMin, type SymbolSessionState } from '../data/session-state.js';
import { curve, fmtPct, mix, outcome, squash, unavailable, type MixComponent } from './scoring.js';

export interface VwapReadingResult {
  vwap: number | null;
  distancePct: number | null;
  slopePctPerMin: number | null;
  /** VWAP of only the trades in the held window — "what the tape is paying right now". */
  intervalVwap: number | null;
  above: boolean | null;
  rising: boolean | null;
  /** True when position and slope point the same way. */
  aligned: boolean | null;
}

export function computeVwap(quote: MomentumQuote, sym: SymbolSessionState | undefined): VwapReadingResult {
  const vwap = quote.vwap > 0 ? quote.vwap : null;
  const distancePct = vwap ? +(((quote.ltp - vwap) / vwap) * 100).toFixed(3) : null;
  const slope = vwapSlopePctPerMin(sym);
  const above = distancePct === null ? null : distancePct > 0;
  const rising = slope === null ? null : slope > 0;

  return {
    vwap,
    distancePct,
    slopePctPerMin: slope,
    intervalVwap: intervalVwap(sym),
    above,
    rising,
    aligned: above === null || rising === null ? null : above === rising,
  };
}

export function vwapFactor(reading: VwapReadingResult, cfg: MomentumConfig) {
  const weight = cfg.weights.vwap;
  if (reading.vwap === null || reading.distancePct === null)
    return unavailable('vwap', weight, 'no session VWAP yet — nothing has traded');

  const t = cfg.thresholds.vwap;

  const components: MixComponent[] = [
    { key: 'distance', weight: t.mix.distance, score: curve(Math.abs(reading.distancePct), t.distancePct) },
    {
      key: 'slope',
      weight: t.mix.slope,
      score: reading.slopePctPerMin === null ? null : curve(Math.abs(reading.slopePctPerMin), t.slopePctPerMin),
    },
  ];
  const m = mix(components);

  // Position leads the direction; slope confirms or contradicts it. A stock over a falling
  // VWAP nets out near flat, which is exactly how it should read.
  const posBias = squash(reading.distancePct, t.fullScaleDistPct);
  const slopeBias = reading.slopePctPerMin === null ? 0 : squash(reading.slopePctPerMin, t.fullScaleSlope);
  const totalMix = t.mix.distance + t.mix.slope;
  const bias =
    reading.slopePctPerMin === null
      ? posBias
      : (posBias * t.mix.distance + slopeBias * t.mix.slope) / (totalMix || 1);

  const reasons = [
    {
      ok: !!reading.above,
      text: `Price ${reading.above ? 'above' : 'below'} VWAP by ${fmtPct(Math.abs(reading.distancePct))}`,
    },
  ];
  if (reading.rising !== null)
    reasons.push({
      ok: reading.aligned === true,
      text: `VWAP ${reading.rising ? 'rising' : 'falling'} (${(reading.slopePctPerMin ?? 0) >= 0 ? '+' : ''}${(reading.slopePctPerMin ?? 0).toFixed(4)}%/min)${
        reading.aligned === false ? ' — against the price position' : ''
      }`,
    });

  return outcome({
    key: 'vwap',
    weight,
    score: m.score,
    bias,
    metrics: {
      vwap: reading.vwap,
      distancePct: reading.distancePct,
      slopePctPerMin: reading.slopePctPerMin,
      intervalVwap: reading.intervalVwap,
      aboveVwap: reading.above,
      vwapRising: reading.rising,
      aligned: reading.aligned,
    },
    reasons,
    note: reading.slopePctPerMin === null ? 'VWAP slope warming up — needs ~2 minutes of polling' : undefined,
  });
}
