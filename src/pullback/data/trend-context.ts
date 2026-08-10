// What the momentum module's conviction layer says about a stock, for the alert gate.
//
// WHY THIS EXISTS. The pullback scanner finds a good STRUCTURE — an impulse, a retracement into
// the moving averages, a confirmation candle on volume. What it cannot see is whether the day
// that structure sits inside is going one way or chopping, because it only ever looks at bars
// on its own timeframe. The momentum module measures exactly that and nothing else useful to
// this one: VWAP adherence over the whole session, how many times price changed sides, and a
// phase machine with twenty minutes of hysteresis on each side of the decision.
//
// The observation this was built on: a pullback entry taken in the direction of a CONFIRMED
// one-sided day tends to keep going, and the same entry taken on a stock that has crossed VWAP
// nine times is the one that stops out. Those two are indistinguishable on the pullback
// scanner's own inputs and trivially distinguishable with one field from the other module.
//
// WHY IT READS THE BOARD RATHER THAN RECOMPUTING. `computeConviction` is available and cheap,
// but calling it ADVANCES the phase machine — it dates promotions and demotions from the
// timestamp it is handed. Driving that machine from a second scanner on a second interval would
// make the phase depend on how many things asked about it, and the Trend Day board and a phone
// alert could then disagree about when a day was confirmed. So this reads the finished board
// the momentum scan already published: no mutation, no upstream request, and the alert quotes
// exactly what the screen shows.
//
// WHY THE PHASE NAMES ARE COPIED INTO `types.ts` RATHER THAN IMPORTED. This module and the
// momentum module share infrastructure and no domain logic, on purpose — `src/index.ts` says so
// and it is what lets the two be deployed apart. One import of a snapshot repository is a seam;
// importing its type graph is a merge. The copy is four string literals, and the mapping below
// is the one place they have to agree.
//
// PRIMED ONCE PER SCAN, READ SYNCHRONOUSLY. The alert path is synchronous down to `emit`, and
// making it async to fetch a board would put a disk read inside a loop that runs per row per
// timeframe. So the scan primes this first and the gate reads a plain map.

import type { TrendContext } from '../types.js';
import { snapshotRepository } from '../../momentum/data/snapshot.repository.js';

let ctx = new Map<string, TrendContext>();
let primedAt = 0;
let boardAsOf = 0;
let unavailable: string | null = 'not primed yet';

const DIRECTION: Record<string, 1 | -1 | 0> = { Bullish: 1, Bearish: -1, Neutral: 0 };

/** The shape this reads off a momentum row. Structural, so the two type graphs stay apart. */
interface BoardLike {
  asOf: number;
  rows: Array<{
    symbol: string;
    conviction?: {
      ready: boolean;
      phase: string;
      direction: string;
      score: number;
      confirmedAt?: number | null;
      heldMin: number | null;
      partial: boolean;
    } | null;
  }>;
}

/**
 * Rebuild the map from a board. Pure, so a test can drive it without a repository.
 *
 * A row whose conviction is not `ready` is left OUT rather than stored as neutral: "the
 * accumulators have not seen enough of the session" and "this stock is not trending" are
 * different answers, and only the second one should hold an alert back.
 */
export function primeTrendContextFrom(board: BoardLike, nowMs = Date.now()): number {
  const next = new Map<string, TrendContext>();
  const ageMs = Math.max(0, nowMs - board.asOf);

  for (const row of board.rows) {
    const c = row.conviction;
    if (!c || !c.ready) continue;
    next.set(row.symbol, {
      phase: (c.phase as TrendContext['phase']) ?? 'None',
      direction: DIRECTION[c.direction] ?? 0,
      score: c.score,
      confirmedAt: c.confirmedAt ?? null,
      heldMin: c.heldMin,
      partial: c.partial,
      ageMs,
    });
  }

  ctx = next;
  primedAt = nowMs;
  boardAsOf = board.asOf;
  unavailable = next.size ? null : 'the momentum board carried no readable conviction';
  return next.size;
}

/**
 * Load the latest momentum board into the map. Never throws.
 *
 * A failure here must not be able to stop a scan or an alert: the gate treats an empty map as
 * "unknown", which by default lets the push through and says so on the message.
 */
export async function primeTrendContext(nowMs = Date.now()): Promise<void> {
  try {
    const last = await snapshotRepository.last();
    if (!last) {
      ctx = new Map();
      primedAt = nowMs;
      boardAsOf = 0;
      unavailable = 'no momentum board has been computed yet';
      return;
    }
    primeTrendContextFrom(last.board as unknown as BoardLike, nowMs);
  } catch (e) {
    ctx = new Map();
    primedAt = nowMs;
    unavailable = `momentum board unreadable: ${String((e as Error).message)}`;
  }
}

/**
 * This symbol's session reading, or null when there isn't a usable one.
 *
 * `maxAgeSec` guards the case the whole design depends on: alerts only fire during market hours,
 * when the momentum scan is running every fifteen seconds, so a board older than a couple of
 * minutes means that scanner has stopped — and a stale phase is worse than no phase, because it
 * would keep waving trades through on a session reading that is no longer being maintained.
 */
export function trendFor(symbol: string, maxAgeSec: number, nowMs = Date.now()): TrendContext | null {
  const hit = ctx.get(symbol);
  if (!hit) return null;
  const age = hit.ageMs + Math.max(0, nowMs - primedAt);
  if (maxAgeSec > 0 && age > maxAgeSec * 1000) return null;
  return { ...hit, ageMs: age };
}

/** For `/pullback/status`, so a gate that is quietly doing nothing is visible. */
export const trendContextStatus = () => ({
  symbols: ctx.size,
  primedAt,
  boardAsOf,
  unavailable,
});

/** Test seam, and what the day roll calls. */
export const resetTrendContext = (): void => {
  ctx = new Map();
  primedAt = 0;
  boardAsOf = 0;
  unavailable = 'not primed yet';
};
