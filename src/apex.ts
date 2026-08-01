// Option Apex service — the four money_flux endpoints the real page is built on.
//
//   get_running_expiry  {script}                -> [[epoch,"wk"],[epoch,"mo"]]
//   chart               {script,tf}             -> [[epoch,o,h,l,c], …]  index candles
//   op_histogram        {script,exp,tf}         -> money flux per bucket
//   op_dial             {script,exp}            -> the sentiment and PCR dials
//
// This module composes rather than computes: candles come from candles.ts, the flux
// arithmetic and the dials from flux.ts, and the option ladder both of those need from
// clock.ts — the same ladder Option Clock draws, fetched once and shared.

import { indexChart, type ChartData, type Timeframe } from './candles.js';
import { dials, histogram, type Dials, type Histogram } from './flux.js';
import { LADDER_SLOT_S, resolveExp, runningExpiry, SCRIPTS, sessionLadder } from './clock.js';
import { marketOpen, type Result } from './services.js';
import * as upstox from './upstox.js';

export { SCRIPTS, runningExpiry };
export type { Timeframe } from './candles.js';

/**
 * What Upstox says the index is worth, from the option chain.
 *
 * Used to check the candle series belongs to the index it claims to. Failure is not fatal:
 * the chart simply goes unverified rather than unavailable.
 */
async function chainSpot(script: string, exp?: string): Promise<number | undefined> {
  try {
    const iso = await resolveExp(script, exp);
    const chain = await upstox.optionChain(script, iso, marketOpen());
    return chain.data.spot > 0 ? chain.data.spot : undefined;
  } catch {
    return undefined;
  }
}

/** Index candles, checked against the spot reported on the option chain. */
export async function chart(script: string, tf: Timeframe, exp?: string): Promise<Result<ChartData>> {
  return indexChart(script, tf, await chainSpot(script, exp), marketOpen());
}

/** Money flux through the session, bucketed to `tf` minutes. */
export async function flux(
  script: string, exp: string | undefined, tf: Timeframe, day?: string,
): Promise<Result<Histogram>> {
  const ladder = await sessionLadder(script, exp, day);
  return histogram(ladder, expLabel(ladder.expiry), tf * 60, LADDER_SLOT_S);
}

/** The two gauges: option-flow sentiment, and PCR. */
export async function dial(
  script: string, exp?: string, day?: string, bucket = 15,
): Promise<Result<Dials>> {
  const open = marketOpen();
  const ladder = await sessionLadder(script, exp, day);

  // The ratio is required and comes from the whole chain; the intraday trend is a nicety
  // on an endpoint the Analytics Token may not be entitled to, so it is never allowed to
  // fail the panel.
  const [chain, trend] = await Promise.all([
    upstox.optionChain(script, ladder.expiry, open),
    upstox.pcrSeries(script, ladder.expiry, ladder.day, bucket, open),
  ]);

  return dials(ladder, {
    pcr: chain.data.pcr,
    putOi: chain.data.putOi,
    callOi: chain.data.callOi,
    spot: chain.data.spot,
    readings: trend.readings,
    bucketMinutes: trend.bucketMinutes,
    trendUnavailable: trend.unavailable,
  });
}

/** "2026-08-04" -> "04Aug26", the compact expiry the feed tags each bucket with. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function expLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}${MON[m - 1]}${String(y).slice(2)}`;
}
