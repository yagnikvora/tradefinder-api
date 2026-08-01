// Money Flux — the money moving into and out of index options through the session.
//
// This used to be a recording. Each bucket is the change in open interest between two
// readings of the chain, and NSE only ever answers "right now", so the chain had to be
// taped every five minutes through the day — which meant a bucket nobody captured was
// gone for good, and the histogram was mostly gaps unless a recorder had been running.
//
// Upstox's candles carry open interest AND a close price per contract, for any past
// session, so both halves of the formula are simply fetched. The tape and the recorder
// are gone; the histogram is complete for any day.
//
// What a bucket measures
// ----------------------
//   flow_side = Σ over strikes of  (OI now − OI at the previous candle) × price now
//
// i.e. the rupees of NEW open interest written or closed since the last candle, marked at
// what the option is worth. Deliberately Σ(ΔOI × price) rather than Δ(Σ OI × price): the
// second moves when premiums reprice even if nobody traded, which is a mark-to-market
// swing rather than money flowing anywhere.
//
// NO lot-size multiplier, and that is not an oversight. Upstox reports open interest in
// UNITS where NSE reports it in CONTRACTS — measured against NSE for the same strike and
// expiry, Upstox's number is the lot size larger (24350CE: 4,128,150 against 61,412, a
// factor of ~65 with a lot of 65). The quantity is therefore already in the same units the
// price is quoted per, so ΔOI × price is rupees. Multiplying by the lot again inflated
// every figure ~65×.
//
//   flux = put flow − call flow
//
// Puts written are the bulls (support), calls written the bears (resistance) — the same
// convention the rest of the app reads OI by. Positive is green, negative red.

import type { Result } from './services.js';
import type { Ladder, PcrReading } from './upstox.js';

/** Everything the dials take from Upstox's chain: the ratio and the OI behind it. */
export interface PcrQuote {
  pcr: number;
  putOi: number;
  callOi: number;
  spot: number;
  readings: PcrReading[];
  bucketMinutes: number;
  /** Set when the intraday PCR trend couldn't be fetched. The ratio is still real. */
  trendUnavailable?: string;
}

const IST_OFFSET_S = 330 * 60;
const SESSION_S = 6 * 3600 + 15 * 60; // 09:15 to 15:30 IST

function dayOpenEpoch(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - IST_OFFSET_S + 9 * 3600 + 15 * 60;
}

/* -------------------------------------------------------------------- readings --- */

/** One bucket: [epoch(s), expiry, net flux ₹] — the real op_histogram's row shape. */
export type FluxPoint = [number, string, number];

export interface FluxReading { ts: number; ce: number; pe: number; }

export interface Histogram {
  /** The trading day these buckets describe. */
  day: string;
  /** Bucket width actually used, in seconds. */
  step: number;
  /** The candle resolution behind them — the finest a bucket can be. */
  slot: number;
  points: FluxPoint[];
  /** Session totals, in rupees. */
  ceFlow: number;
  peFlow: number;
  /** Buckets the session expects that the feed had no candles for. */
  missing: number;
}

/**
 * Turn a session's ladder into one flow reading per candle.
 *
 * The first candle of the day has nothing before it to be measured against and so carries
 * no flow — it is skipped rather than counted as though the whole of its open interest
 * were built in that minute.
 *
 * A strike whose leg didn't trade in a given candle simply has no entry for it; its last
 * known open interest is carried, so a quiet strike contributes zero flow instead of
 * appearing to unwind to nothing and back.
 */
export function readingsFromLadder(ladder: Ladder): FluxReading[] {
  const { times, strikes } = ladder;
  if (times.length < 2) return [];

  // Last known OI/price per leg, walked forward with the session.
  const held = strikes.map(() => ({ ceOi: NaN, peOi: NaN, cePx: 0, pePx: 0 }));
  const out: FluxReading[] = [];

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    let ce = 0, pe = 0;

    strikes.forEach((row, k) => {
      const h = held[k];
      const ceOi = row.ce.get(t), peOi = row.pe.get(t);
      const cePx = row.cePrice.get(t) ?? h.cePx, pePx = row.pePrice.get(t) ?? h.pePx;

      if (ceOi != null) {
        if (Number.isFinite(h.ceOi)) ce += (ceOi - h.ceOi) * cePx;
        h.ceOi = ceOi;
      }
      if (peOi != null) {
        if (Number.isFinite(h.peOi)) pe += (peOi - h.peOi) * pePx;
        h.peOi = peOi;
      }
      h.cePx = cePx;
      h.pePx = pePx;
    });

    // i === 0 establishes the baseline; there is no "since" for it yet.
    if (i > 0) out.push({ ts: t, ce: Math.round(ce), pe: Math.round(pe) });
  }
  return out;
}

/**
 * Fold readings into buckets. Pure, and separated from the feed so the arithmetic can be
 * exercised over a whole session without fetching one — see tools/flux-validate.ts.
 *
 * `step` is rounded to a whole number of candles and floored at one, because a bucket
 * finer than the candle resolution cannot be filled.
 */
export function bucketFlux(
  readings: FluxReading[], feedExp: string, step: number, day: string,
  slot: number, nowS = Math.floor(Date.now() / 1000),
): Omit<Histogram, 'slot'> {
  const width = Math.max(slot, Math.round(step / slot) * slot);
  const open = dayOpenEpoch(day);

  const buckets = new Map<number, number>();
  let ceFlow = 0, peFlow = 0;
  for (const r of readings) {
    ceFlow += r.ce;
    peFlow += r.pe;
    // Bucketed from the open rather than from the epoch, so a 15-minute bar starts at
    // 09:15 like the candles do.
    const b = open + Math.floor((r.ts - open) / width) * width;
    buckets.set(b, (buckets.get(b) ?? 0) + (r.pe - r.ce));
  }

  const points: FluxPoint[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, v]) => [ts, feedExp, Math.round(v)] as FluxPoint);

  // Measured against the part of the session that has actually elapsed — a bucket in the
  // future isn't missing.
  const elapsed = Math.min(nowS, open + SESSION_S) - open;
  const expected = Math.max(0, Math.ceil(elapsed / width));

  return {
    day, step: width, points,
    ceFlow: Math.round(ceFlow), peFlow: Math.round(peFlow),
    missing: Math.max(0, expected - points.length),
  };
}

/** The session's flux, bucketed to `step` seconds. */
export function histogram(
  ladder: Ladder, feedExp: string, step: number, slotSeconds: number,
): Result<Histogram> {
  const readings = readingsFromLadder(ladder);
  const data = { ...bucketFlux(readings, feedExp, step, ladder.day, slotSeconds), slot: slotSeconds };
  return {
    source: 'upstox',
    ...(data.points.length ? {} : { error: `Upstox served no option candles for ${ladder.day}` }),
    data,
  };
}

/* ----------------------------------------------------------------------- dials --- */

export interface Dials {
  /** Put OI ÷ call OI over the whole chain. Served by Upstox. */
  pcr: number;
  /** The day's PCR series from Upstox, at its bucket resolution. Empty if unavailable. */
  pcrSeries: Array<[number, number]>;
  /** Bucket width of `pcrSeries`, in minutes. */
  pcrBucketMinutes: number;
  /** Why there is no trend, when there isn't. The ratio itself is unaffected. */
  pcrTrendNote?: string;
  /** PCR mapped to the gauge's −1 (strong sell) … +1 (strong buy). */
  pcrScore: number;
  /** Option-flow sentiment on the same −1 … +1 scale. */
  sentiment: number;
  /** Net money flux for the session, in rupees. */
  netFlow: number;
  /** Money that moved either way — what netFlow is measured against. */
  grossFlow: number;
  bulls: number;
  bears: number;
  spot: number;
  /** When the newest reading was taken. */
  ts: number;
  day: string;
  /** How many flux readings the sentiment is built from. */
  buckets: number;
}

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

/**
 * PCR mapped onto the gauge.
 *
 * 1.0 is the neutral middle — as many puts open as calls. The ×1.5 puts a PCR of 1.67 at
 * full bullish and 0.33 at full bearish, which is about the range an index chain covers
 * in a session.
 */
export const pcrScore = (pcr: number) => clamp((pcr - 1) * 1.5);

/**
 * Sentiment: which way today's option money leaned, tempered by how the open interest is
 * stacked.
 *
 * The flow term is net ÷ gross, so it reads as "of all the money that moved today, this
 * much of it net went to the bulls" — already bounded, and unitless, so it compares across
 * indices whose rupee scales differ by an order of magnitude. The PCR term is the standing
 * position rather than today's movement, and is weighted lower because it is slower and
 * partly a function of the same OI the flow is measured from.
 *
 * A composite, and this app's own — tradefinder does not publish how theirs is derived.
 */
const FLOW_WEIGHT = 0.65;

export function dials(ladder: Ladder, quote: PcrQuote): Result<Dials> {
  const readings = readingsFromLadder(ladder);

  let net = 0, gross = 0;
  for (const r of readings) {
    net += r.pe - r.ce;
    gross += Math.abs(r.pe) + Math.abs(r.ce);
  }
  const flowScore = gross > 0 ? clamp(net / gross) : 0;
  const ps = pcrScore(quote.pcr);
  // With nothing measured there is no flow term to blend — the dial reads the standing
  // position alone rather than being dragged halfway to neutral by a zero meaning "unknown".
  const sentiment = readings.length ? clamp(FLOW_WEIGHT * flowScore + (1 - FLOW_WEIGHT) * ps) : ps;

  return {
    source: 'upstox',
    data: {
      pcr: quote.pcr,
      pcrSeries: quote.readings.map((r) => [r.ts, r.pcr] as [number, number]),
      pcrBucketMinutes: quote.bucketMinutes,
      ...(quote.readings.length
        ? {}
        : { pcrTrendNote: quote.trendUnavailable ?? 'Upstox served no intraday PCR readings for this day.' }),
      pcrScore: +ps.toFixed(3),
      sentiment: +sentiment.toFixed(3),
      netFlow: Math.round(net),
      grossFlow: Math.round(gross),
      bulls: quote.putOi,
      bears: quote.callOi,
      spot: quote.spot,
      ts: ladder.times[ladder.times.length - 1] ?? 0,
      day: ladder.day,
      buckets: readings.length,
    },
  };
}
