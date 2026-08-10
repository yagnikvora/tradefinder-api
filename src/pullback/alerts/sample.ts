// A demonstration alert, built from the live board.
//
// `POST /pullback/alerts/test` proves the channel is wired up, and that is all it proves — it
// sends a sentence about the configuration. What it cannot show is the thing anyone actually
// wants to check before a session: whether the MESSAGE is right. Whether the contract line
// reads clearly on a phone, whether the per-lot figures are legible, and — since the trend gate
// went in — whether the session line says what was expected.
//
// So this builds a message that is structurally identical to a real one, from a real symbol on
// the current momentum board with its real conviction reading attached. It is labelled as a
// sample in its first line, because an alert that looks exactly like a trade and is not one is
// worse than no test at all.
//
// The levels are derived arithmetically from the stock's own price rather than being invented:
// a 1.5% stop and a 2R target are what the engine would produce for an ordinary setup, and
// numbers of a plausible SIZE are the point — a message that reads fine with ₹200 levels can
// still wrap badly at ₹39,000.

import type { PullbackSignal, TrendContext } from '../types.js';
import { snapshotRepository } from '../../momentum/data/snapshot.repository.js';
import { primeTrendContext, trendFor } from '../data/trend-context.js';

export interface SampleAlert {
  signal: PullbackSignal;
  trend: TrendContext | null;
  /** What the sample was built from, for the HTTP response. */
  basis: string;
}

/** A day old is fine for a demonstration; the live gate uses the configured seconds. */
const SAMPLE_MAX_AGE_SEC = 86_400;

/**
 * Build a sample from the best row on the board, or from nothing if there is no board.
 *
 * The fallback matters as much as the happy path: a clone with no Upstox token, or a first boot
 * before the first scan, must still be able to prove its phone channel — so a missing board
 * degrades to a canned example rather than a 500.
 */
export async function sampleAlert(nowMs = Date.now()): Promise<SampleAlert> {
  await primeTrendContext(nowMs);
  const last = await snapshotRepository.last();

  // The most one-sided confirmed name, so the trend line shows the case the gate was built for.
  const rows = last?.board.rows ?? [];
  const pick =
    rows.filter((r) => r.conviction?.phase === 'Confirmed')
      .sort((a, b) => (b.conviction?.score ?? 0) - (a.conviction?.score ?? 0))[0] ?? rows[0] ?? null;

  const trend = pick ? trendFor(pick.symbol, SAMPLE_MAX_AGE_SEC, nowMs) : null;
  const symbol = pick?.symbol ?? 'GAIL';
  const price = pick?.price && pick.price > 0 ? pick.price : 200;
  const direction: 1 | -1 = trend?.direction === -1 ? -1 : 1;

  const stop = direction === 1 ? price * 0.985 : price * 1.015;
  const risk = Math.abs(price - stop);
  const target = direction === 1 ? price + risk * 2 : price - risk * 2;

  const basis = pick
    ? `${symbol} from the current board${trend ? `, conviction ${trend.score.toFixed(0)} ${trend.phase.toLowerCase()}` : ', no live conviction reading'}`
    : 'a canned example — no momentum board has been computed yet';

  // Cast rather than fully constructed: the renderer reads a dozen fields of a type with about
  // sixty, and spelling out the rest would be inventing data the message never shows.
  const signal = {
    id: `sample-${nowMs}`,
    symbol,
    timeframe: 15,
    direction,
    side: 'BUY',
    entryKind: 'pullback',
    firedAt: nowMs,
    ageMin: 0,
    entry: price,
    price,
    movedSincePct: 0,
    score: { total: 82, band: 'Strong', components: [], coverage: 1 },
    stop: { candidates: [], recommended: { kind: 'structure', price: stop, reason: 'below the swing low' } },
    target: { candidates: [], primary: { kind: '2R', price: target, r: 2 }, rewardRisk: 2, travelR: 2 },
    // No option contract on a sample: quoting a strike and a premium that were never priced by
    // the chain is the one part of this message that could be mistaken for tradable.
    option: null,
  } as unknown as PullbackSignal;

  return { signal, trend, basis };
}
