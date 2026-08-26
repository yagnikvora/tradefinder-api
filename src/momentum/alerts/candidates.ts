// The candidate log — what the displacement rule LOOKED AT each morning, not just what it took.
//
// WHY THIS EXISTS. The alert records the trades it fired; everything it considered and refused is
// discarded the instant the scan tick ends. That makes a whole class of question permanently
// unanswerable after the fact: raise `DISPLACEMENT_MIN_RVOL` to 8 and you cannot ask which of the
// last three months' signals would have survived, because the RVOL of the ones that did not fire
// was never written down. The same gap already cost this project an exit study — see
// `momentum_option_path` — and it is the same mistake in a different column.
//
// WHAT IS ACTUALLY PERISHABLE HERE, because it is not the obvious thing. Equity 1-minute bars stay
// fetchable from Upstox for months (verified back to 2026-03-10), so the price side of a signal can
// always be reconstructed. The BASELINE cannot: `atr`, `avgDailyValueCr` and the minute-by-minute
// volume profile are rebuilt every morning and overwritten, so an offline replay months later uses
// a baseline that never existed on the day — `tools/displacement-preview.ts` says as much in its
// own banner. The readings below embed the live baseline at the moment it was used, which is what
// makes this log the ground truth rather than a convenience.
//
// WHAT IT DELIBERATELY DOES NOT STORE. Every symbol at every minute would be 208 x 34 rows a
// session for a universe that is mostly nowhere near qualifying. Only symbols IN CONTENTION are
// kept — past the turnover gate and within reach of the RVOL floor (see `NEAR`) — which is the
// band any future threshold study would actually move a line through. A symbol at 0.4x RVOL tells
// you nothing you would ever ask about.
//
// IT MUST NEVER BREAK AN ALERT. Everything here is called after delivery, wrapped, and swallows its
// own errors. A log that can stop the phone ringing is worse than no log.

import { istDay } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { databaseUrl, getPool, saveCandidates, type CandidateRow } from '../journal/postgres.js';
import type { DisplacementInput } from './displacement.js';

/**
 * How far below the live RVOL floor a symbol is still worth recording.
 *
 * 0.7 rather than 1.0 so the log supports LOWERING the floor as well as raising it — a study that
 * can only ever tighten a threshold is half a study. Below that the sample is noise: a stock at
 * half the required participation is not a near miss, it is a different kind of day.
 */
const NEAR = 0.7;

/** `[minute, rvol, rangeAtr, moveAtr, offExtremeAtr, turnoverCr, ltp, direction]` */
export type CandidateTick = [number, number, number, number, number, number, number, 1 | -1];

interface DayLog {
  day: string;
  /** symbol -> the minutes it was in contention. */
  bySymbol: Map<string, CandidateTick[]>;
  taken: Map<string, number>;
  flushed: boolean;
}

let current: DayLog | null = null;

const round = (n: number, dp = 3): number => +n.toFixed(dp);

function forDay(day: string): DayLog {
  if (!current || current.day !== day) current = { day, bySymbol: new Map(), taken: new Map(), flushed: false };
  return current;
}

/**
 * Record one scan tick.
 *
 * The gate arithmetic here MIRRORS `selectDisplacement` rather than calling it, because the point
 * is to capture symbols that rule rejected — a function that returns only winners cannot report
 * the losers. The two must agree on how a reading is computed, so any change to a metric there
 * belongs here too; the shared expectation is pinned by a test.
 */
export function observeCandidates(
  inputs: DisplacementInput[],
  minute: number,
  rule: { fromMinute: number; toMinute: number; minRvol: number; maxRvol: number; minTurnoverCr: number },
  nowMs: number,
): void {
  try {
    if (minute < rule.fromMinute || minute > rule.toMinute) return;
    const log = forDay(istDay(nowMs));

    for (const i of inputs) {
      const { quote: q, atr, rvol } = i;
      if (atr === null || !(atr > 0) || rvol === null) continue;
      if (!(q.ltp > 0) || !(q.vwap > 0) || !(q.open > 0)) continue;
      if ((i.avgDailyValueCr ?? 0) < rule.minTurnoverCr) continue;
      // In contention: near the floor or above it, and not absurdly above the ceiling.
      if (rvol < rule.minRvol * NEAR || rvol > rule.maxRvol * 1.5) continue;

      const direction: 1 | -1 = q.ltp > q.vwap ? 1 : -1;
      const off = (direction === 1 ? q.high - q.ltp : q.ltp - q.low) / atr;
      const tick: CandidateTick = [
        minute,
        round(rvol, 2),
        round((q.high - q.low) / atr),
        round(((q.ltp - q.open) / atr) * direction),
        round(off),
        round(q.turnoverCr, 1),
        round(q.ltp, 2),
        direction,
      ];
      const arr = log.bySymbol.get(i.symbol);
      if (arr) arr.push(tick); else log.bySymbol.set(i.symbol, [tick]);
    }
  } catch { /* a log must not be able to fail a scan */ }
}

/** Note which symbols the channel actually announced, and when. */
export function markTaken(symbols: Array<{ symbol: string; minute: number }>, nowMs: number): void {
  try {
    const log = forDay(istDay(nowMs));
    for (const s of symbols) if (!log.taken.has(s.symbol)) log.taken.set(s.symbol, s.minute);
  } catch { /* as above */ }
}

/**
 * Write the day's log once the window has closed.
 *
 * Deliberately at the END rather than per tick: `taken` is not known until the window is over, and
 * a row that says "not taken" when the cap filled two minutes later would be a lie in the one
 * column a capacity study reads.
 */
export async function flushCandidates(nowMs: number, force = false): Promise<number> {
  try {
    const log = current;
    if (!log || log.flushed || !log.bySymbol.size) return 0;
    if (!force && log.day !== istDay(nowMs)) return 0;

    const rows: CandidateRow[] = [...log.bySymbol.entries()].map(([symbol, ticks]) => ({
      day: log.day,
      channel: 'displacement',
      symbol,
      taken: log.taken.has(symbol),
      takenMinute: log.taken.get(symbol) ?? null,
      firstMinute: ticks[0][0],
      lastMinute: ticks[ticks.length - 1][0],
      peakRvol: Math.max(...ticks.map((t) => t[1])),
      ticks,
    }));

    // Local disk first, same ordering and for the same reason as everything else here.
    const key = `${STORE_KEYS.candidates}_${log.day.slice(0, 7)}`;
    const doc = (await store.read<Record<string, CandidateRow[]>>(key)) ?? {};
    doc[log.day] = rows;
    await store.write(key, doc);

    if (databaseUrl()) await saveCandidates(getPool(), rows).catch(() => 0);
    log.flushed = true;
    return rows.length;
  } catch {
    return 0;
  }
}

/** Test seam, and what a restart mid-session needs so the day is not double-counted. */
export function resetCandidates(): void {
  current = null;
}

/**
 * Test seam. Overloaded so a test can ask for one symbol's ticks or for the whole symbol list,
 * without `candidateState` having to expose the log itself to the rest of the app.
 */
export function __ticksForTest(): string[];
export function __ticksForTest(symbol: string): CandidateTick[];
export function __ticksForTest(symbol?: string): string[] | CandidateTick[] {
  if (!current) return symbol === undefined ? [] : [];
  return symbol === undefined ? [...current.bySymbol.keys()] : (current.bySymbol.get(symbol) ?? []);
}

/** What the status endpoint reports. */
export function candidateState(): { day: string | null; symbols: number; taken: number; flushed: boolean } {
  return current
    ? { day: current.day, symbols: current.bySymbol.size, taken: current.taken.size, flushed: current.flushed }
    : { day: null, symbols: 0, taken: 0, flushed: false };
}
