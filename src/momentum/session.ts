// The IST trading session, as arithmetic.
//
// Every intraday factor in this module is a function of WHERE IN THE SESSION we are, not of
// wall-clock time: relative volume compares today's cumulative volume against what this
// stock had normally done by this same minute, and ATR expansion scales a still-forming
// range onto a full day. Getting the minute wrong shifts every one of those, so the session
// is resolved in one place, in IST, whatever timezone the host runs in.
//
// `services.ts` already has a `marketOpen()` and a `sessionFraction()`. This does not
// replace them — they serve the rest of the app and are re-exported below so there is one
// definition of "is the market open" in the process, not two that can drift.

export { marketOpen } from '../services.js';

const IST_OFFSET_MIN = 330;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
/** 09:15 to 15:29 inclusive is 375 one-minute bars, which is what Upstox returns. */
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;

/** The wall clock shifted so the UTC getters read IST. */
const ist = (nowMs: number) => new Date(nowMs + IST_OFFSET_MIN * 60_000);

/** Minutes past midnight, IST. */
export const istMinutes = (nowMs: number = Date.now()): number => {
  const d = ist(nowMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** Today in IST as YYYY-MM-DD. Not the host's date — at 03:00 IST those differ. */
export const istDay = (nowMs: number = Date.now()): string => ist(nowMs).toISOString().slice(0, 10);

/**
 * How far into the session we are, 0…375.
 *
 * Clamped at both ends: before the open it is 0 (which makes RVOL undefined rather than
 * infinite), and after the close it is the full session, so a post-close board reads as a
 * complete day rather than as one still in progress.
 */
export function minuteOfSession(nowMs: number = Date.now()): number {
  const m = istMinutes(nowMs);
  if (m <= SESSION_OPEN_MIN) return 0;
  if (m >= SESSION_CLOSE_MIN) return SESSION_MINUTES;
  return m - SESSION_OPEN_MIN;
}

/** The same thing as a fraction, 0…1. */
export const sessionFraction = (nowMs: number = Date.now()): number =>
  minuteOfSession(nowMs) / SESSION_MINUTES;

/**
 * Minute-of-session for an Upstox candle stamp.
 *
 * Upstox returns "2026-07-31T09:15:00+05:30" — already IST, with the offset attached. It is
 * read off the STRING rather than parsed into a Date and converted back, because that round
 * trip is the classic way an off-by-330-minutes creeps in on a host that isn't in IST.
 */
export function candleMinute(stamp: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(stamp);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]) - SESSION_OPEN_MIN;
}

/** The IST calendar day of an Upstox candle stamp. */
export const candleDay = (stamp: string): string => stamp.slice(0, 10);

/** YYYY-MM-DD `days` calendar days before `from`. */
export function isoDaysBefore(days: number, from: string | number = Date.now()): string {
  const base = typeof from === 'string' ? Date.parse(`${from}T00:00:00Z`) : from;
  return new Date(base - days * 86_400_000).toISOString().slice(0, 10);
}
