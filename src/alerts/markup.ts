// What an alert SAYS, independent of what carries it.
//
// The two channels differ in exactly one respect — Telegram renders a subset of HTML, Discord
// renders Markdown — and everything that actually matters is the same: which contract to buy, what
// a lot costs, what a lot makes or loses, and where the trade is wrong. Duplicating that per
// channel would guarantee they drift, and a phone alert that disagrees with the other phone alert
// is worse than either alone.
//
// So content is written once against a `Markup` and each channel supplies its own. Adding a third
// channel is a `Markup` and a `send`, not another copy of the message.
//
// WHY THIS IS TOP-LEVEL. It began inside the pullback module, which was the first thing here to
// send anything. When that scanner was removed the channels and this markup had to survive it —
// they are not strategy code, they are delivery — so they live at `src/alerts/` and every producer
// imports them. The IST formatters live here rather than in `momentum/session.ts` because they
// are about how a MESSAGE reads, and the session module is about where in the trading day we are.

/** The four things a channel has to answer about text. */
export interface Markup {
  bold(s: string): string;
  italic(s: string): string;
  /** Neutralise anything the channel would otherwise read as formatting. */
  escape(s: string): string;
  /**
   * A labelled link.
   *
   * Here because an attribution that a licence REQUIRES cannot be left to whichever channel
   * happens to autolink a bare URL — ZenQuotes' free tier asks for a credit with a link back, and
   * both phones have to be able to render one.
   */
  link(text: string, url: string): string;
}

/** Telegram's `parse_mode: HTML`. A stray `&` in a symbol would drop the whole message. */
export const HTML: Markup = {
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  escape: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  link: (text, url) => `<a href="${url}">${text}</a>`,
};

/** Discord's Markdown. Backslash-escaping is what Discord itself documents. */
export const MARKDOWN: Markup = {
  bold: (s) => `**${s}**`,
  italic: (s) => `_${s}_`,
  escape: (s) => s.replace(/([*_~`|\\])/g, '\\$1'),
  link: (text, url) => `[${text}](${url})`,
};

const IST_OFFSET_MS = 330 * 60_000;

/** "09:15 AM" IST — matches what the web renders, so a message and the page agree. */
export function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours();
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "Wednesday, 12 August 2026" IST.
 *
 * Spelled out by hand rather than through `Intl`, for the same reason `istClock` shifts the epoch
 * instead of converting a Date: this file must render identically on a laptop in IST, a container
 * in UTC and a host with a trimmed ICU build. A greeting that names the wrong weekday is a small
 * error that destroys confidence in every number underneath it.
 */
export function istDate(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Monday" — the IST weekday on its own, for naming a day that is not today. */
export const istWeekday = (ms: number): string => WEEKDAYS[new Date(ms + IST_OFFSET_MS).getUTCDay()];

/** Rupee totals, rounded — at a lot's scale a rupee is noise. */
export const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;

/**
 * A share price, to the paise.
 *
 * Rounded, ₹1432.50 renders as ₹1,433 — a price the reader then cannot match against the entry on
 * the line below it, which is the sort of small discrepancy that makes someone re-check every other
 * number in the message.
 */
export const price = (v: number): string =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A signed percentage with a real minus sign, so it matches the stop and target lines. */
export const pct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
