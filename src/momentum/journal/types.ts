// The journal's shapes, in their own file so the repositories and the module that fills them can
// import them without importing each other.

import type { StrikeChoice } from '../types.js';

export type JournalChannel = 'displacement' | 'trend-day' | 'ignition';

export interface JournalContract {
  label: string;
  strike: number;
  type: string;
  instrumentKey: string;
  expiry: string;
  lotSize: number;
}

export interface JournalFill {
  /** Epoch ms. */
  at: number;
  /** Minute of session, 0 = 09:15. */
  minute: number;
  premium: number;
  /** Underlying price at that moment. Null when it was not available. */
  spot: number | null;
  source: 'auto' | 'manual';
}

export type ExitReason = 'target' | 'stop' | 'square-off' | 'manual' | 'untracked';

export interface JournalShadow {
  name: string;
  /** The return the alternative pair would have produced, as a fraction of premium. */
  pct: number;
  out: 'target' | 'stop' | 'close';
  minute: number | null;
}

export interface JournalTrade {
  /** Stable and derivable, so the same alert can never be journalled twice. */
  id: string;
  day: string;
  channel: JournalChannel;
  symbol: string;
  direction: 1 | -1;
  contract: JournalContract | null;
  lots: number;
  entry: JournalFill;
  exit: (JournalFill & { reason: ExitReason }) | null;
  /** Live premium while the market is open. Replaced by the settled exit afterwards. */
  mark: { at: number; premium: number; pct: number } | null;
  /** Best and worst excursion, as a fraction of the entry premium. */
  mfePct: number | null;
  maePct: number | null;
  /**
   * Minute of session each excursion was set, 0 = 09:15. Null when that extreme is still 0 — see
   * `gradePath`, which will not name a minute for an excursion that never happened.
   *
   * Optional because rows written before this field existed do not carry it, and a settled trade
   * is never re-graded: the page must render "—" for those rather than showing 09:15.
   */
  mfeMinute?: number | null;
  maeMinute?: number | null;
  /** Bid-ask at entry, as a percentage of the mid. The friction the charges figure excludes. */
  spreadPctAtEntry: number | null;
  amountUsed: number | null;
  grossPnl: number | null;
  charges: number | null;
  netPnl: number | null;
  /** Net as a fraction of the amount used. */
  netPct: number | null;
  shadow: JournalShadow[];
  /** The readings that fired the alert, so a trade can be explained months later. */
  readings: Record<string, number | null>;
  note: string;
  status: 'open' | 'closed';
  settled: boolean;
  edited: boolean;
  /**
   * When this row last changed, epoch ms.
   *
   * Load-bearing for the mirror rather than decoration: it is how a boot-time reconcile decides
   * whether the local copy or the database copy is the later one. A fill corrected at home last
   * night must not be overwritten by the office copy this morning.
   */
  updatedAt: number;
  /**
   * The prices this row had before anyone edited it, captured once on the first edit.
   *
   * Without it "revert to settled" cannot revert: settlement re-derives the EXIT from candles but
   * takes the entry premium as given, so a row edited and then reverted would keep the typed
   * entry and grade a fresh exit against it — a third set of numbers that was never true.
   */
  original?: { entry: JournalFill; exit: JournalTrade['exit'] };
}

export interface JournalEntryInput {
  symbol: string;
  direction: 1 | -1;
  /** Underlying price at signal time. */
  spot: number;
  minute: number;
  lotSize: number | null;
  strike: StrikeChoice | null;
  readings?: Record<string, number | null>;
  note?: string;
}
