// Factor 7 — Implied Volatility. IV Rank, IV Percentile, and what to do when neither exists.
//
// The brief asks for both. Upstox publishes IV as of NOW and nothing historical, so on day
// one of a deployment neither is computable — see `history.repository.ts` for why an IV
// history cannot be reconstructed from the API and is instead recorded going forward.
//
// This service therefore reports a BASIS with every reading:
//
//   'iv-history'  ≥ minSessions of recorded ATM IV. The real thing.
//   'hv-proxy'    realised-volatility rank from 252 daily candles, computed in the daily
//                 baseline. A different quantity, clearly labelled, available immediately.
//   'unavailable' neither. The factor drops out of the weighting.
//
// One reading needs no history at all and is always shown: the IV PREMIUM, `IV ÷ HV20`.
// Options priced above what the stock has actually been doing means the market is paying
// for a move; below means it is not. For an intraday momentum read that is arguably more
// use than a rank, and it is exact from today's data.
//
// The curve is HUMPED, not rising. Momentum wants IV in the healthy middle: at the floor
// nobody expects anything, and at the ceiling the move is already in the premium and every
// option entry starts behind. See `thresholds.impliedVolatility.rank` in the defaults.

import type { IvBasis, MomentumConfig } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumHistoryRecord } from '../types.js';
import type { StockChain } from '../data/option-chain.js';
import { atmRow } from '../data/option-chain.js';
import { percentileRank } from '../data/baseline.js';
import { curve, mix, outcome, unavailable, type MixComponent } from './scoring.js';

export interface IvReading {
  atmIv: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  basis: IvBasis;
  sessionsRecorded: number;
  sessionsRequired: number;
  hv20: number | null;
  hv252: number | null;
  hvRank: number | null;
  /** IV ÷ HV20. Above 1 means options are pricing more than the stock has been doing. */
  ivPremium: number | null;
}

/** ATM implied volatility, averaged across the two legs. Upstox quotes it in percent. */
export function atmImpliedVol(chain: StockChain | null): number | null {
  if (!chain) return null;
  const row = atmRow(chain);
  const ivs = [row?.call?.iv, row?.put?.iv].filter((v): v is number => typeof v === 'number' && v > 0);
  return ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(2) : null;
}

/**
 * IV Rank — where today sits between the low and the high of the window.
 *
 * Distinct from the percentile, which is the share of sessions that were LOWER. A stock
 * that spent eleven months at 18% and one week at 60% has an IV of 20% reading as rank 4
 * but percentile 85; quoting one as the other is a common and consequential mix-up, so both
 * are computed and both are returned.
 */
export function ivRankFrom(current: number, history: number[]): number | null {
  if (history.length < 2) return null;
  const lo = Math.min(...history);
  const hi = Math.max(...history);
  if (!(hi > lo)) return null;
  return +(((current - lo) / (hi - lo)) * 100).toFixed(1);
}

export function computeIv(
  chain: StockChain | null,
  baseline: SymbolBaseline | undefined,
  history: MomentumHistoryRecord[],
  cfg: MomentumConfig,
): IvReading {
  const atmIv = atmImpliedVol(chain);
  const minSessions = cfg.thresholds.impliedVolatility.minSessionsForIvRank;

  const ivSeries = history
    .map((r) => r.atmIv)
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .slice(-252);

  const hv20 = baseline?.hv20 ?? null;
  const hv252 = baseline?.hv252 ?? null;
  const hvRank = baseline?.hvRank ?? null;

  let ivRank: number | null = null;
  let ivPercentile: number | null = null;
  let basis: IvBasis = 'unavailable';

  if (atmIv !== null && ivSeries.length >= minSessions) {
    ivRank = ivRankFrom(atmIv, ivSeries);
    ivPercentile = percentileRank(atmIv, ivSeries);
    basis = 'iv-history';
  } else if (hvRank !== null) {
    // Not an IV rank. A realised-volatility rank standing in for one, and named as such
    // everywhere it surfaces.
    ivRank = hvRank;
    ivPercentile = hvRank;
    basis = 'hv-proxy';
  }

  return {
    atmIv,
    ivRank,
    ivPercentile,
    basis,
    sessionsRecorded: ivSeries.length,
    sessionsRequired: minSessions,
    hv20,
    hv252,
    hvRank,
    ivPremium: atmIv !== null && hv20 && hv20 > 0 ? +(atmIv / hv20).toFixed(2) : null,
  };
}

export function ivFactor(reading: IvReading, cfg: MomentumConfig) {
  const weight = cfg.weights.impliedVolatility;
  const t = cfg.thresholds.impliedVolatility;

  if (reading.ivRank === null && reading.ivPremium === null)
    return unavailable('impliedVolatility', weight, 'no ATM implied volatility and no volatility history');

  const components: MixComponent[] = [
    { key: 'rank', weight: 0.55, score: reading.ivRank === null ? null : curve(reading.ivRank, t.rank) },
    { key: 'premium', weight: 0.45, score: reading.ivPremium === null ? null : curve(reading.ivPremium, t.premium) },
  ];
  const m = mix(components);

  const healthy = (m.score ?? 0) >= 60;
  const basisLabel =
    reading.basis === 'iv-history'
      ? `IV rank ${reading.ivRank?.toFixed(0)} over ${reading.sessionsRecorded} recorded sessions`
      : reading.basis === 'hv-proxy'
        ? `HV rank ${reading.hvRank?.toFixed(0)} (realised-volatility proxy — IV history is ${reading.sessionsRecorded}/${reading.sessionsRequired} sessions)`
        : 'no volatility rank';

  return outcome({
    key: 'impliedVolatility',
    weight,
    score: m.score,
    // Volatility says how big, never which way.
    bias: 0,
    metrics: {
      atmIv: reading.atmIv,
      ivRank: reading.ivRank,
      ivPercentile: reading.ivPercentile,
      basis: reading.basis,
      sessionsRecorded: reading.sessionsRecorded,
      sessionsRequired: reading.sessionsRequired,
      hv20: reading.hv20,
      hv252: reading.hv252,
      hvRank: reading.hvRank,
      ivPremium: reading.ivPremium,
    },
    reasons: [
      {
        ok: healthy,
        text: `IV ${reading.atmIv?.toFixed(1) ?? '—'}%${reading.ivPremium ? ` (${reading.ivPremium.toFixed(2)}x realised)` : ''} — ${healthy ? 'healthy' : 'outside the healthy band'}. ${basisLabel}`,
      },
    ],
    note:
      reading.basis === 'hv-proxy'
        ? `IV rank is standing in from realised volatility — Upstox publishes no IV history, so a true rank needs ${reading.sessionsRequired} recorded sessions (have ${reading.sessionsRecorded})`
        : reading.basis === 'unavailable'
          ? 'no volatility history yet'
          : undefined,
  });
}
