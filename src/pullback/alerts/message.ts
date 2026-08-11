// What an alert SAYS, independent of what carries it.
//
// Split out when Discord was added beside Telegram, because the two channels differ in exactly one
// respect — Telegram renders a subset of HTML, Discord renders Markdown — and everything that
// actually matters is the same: which contract to buy, what a lot costs, what a lot makes or
// loses, and where the trade is wrong. Duplicating that per channel would guarantee they drift,
// and a phone alert that disagrees with the other phone alert is worse than either alone.
//
// So the content is written once against a `Markup` and each channel supplies its own. Adding a
// third channel is a `Markup` and a `send`, not another copy of the message.

import type { AlertEvent, OptionPick, PullbackSignal, TrendContext } from '../types.js';
import { TIMEFRAME_LABEL } from '../types.js';

/** The three things a channel has to answer about text. */
export interface Markup {
  bold(s: string): string;
  italic(s: string): string;
  /** Neutralise anything the channel would otherwise read as formatting. */
  escape(s: string): string;
}

/** Telegram's `parse_mode: HTML`. A stray `&` in a symbol would drop the whole message. */
export const HTML: Markup = {
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  escape: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

/** Discord's Markdown. Backslash-escaping is what Discord itself documents. */
export const MARKDOWN: Markup = {
  bold: (s) => `**${s}**`,
  italic: (s) => `_${s}_`,
  escape: (s) => s.replace(/([*_~`|\\])/g, '\\$1'),
};

const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;

const IST_OFFSET_MS = 330 * 60_000;

/** "09:15 AM" IST — matches what the web renders, so a message and the page agree. */
export function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours();
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What the option is worth if the stock reaches its stop, first-order in delta.
 *
 * The engine computes `premiumAtTarget` properly (second-order, in gamma) but has no equivalent
 * for the downside, so this is derived here and LABELLED as an estimate everywhere it is shown.
 * It is the honest shape of the risk — a long option cannot lose more than its premium, so the
 * estimate is floored at zero rather than allowed to imply a debt.
 */
function riskPerLot(signal: PullbackSignal, o: OptionPick): number | null {
  if (o.lotSize == null || o.costPerLot == null) return null;
  const move = Math.abs(signal.entry - signal.stop.recommended.price);
  const premiumAtStop = Math.max(0, o.entryCost - Math.abs(o.delta) * move);
  return Math.round((o.entryCost - premiumAtStop) * o.lotSize);
}

/**
 * The option block: the contract, what a lot costs, and what a lot makes or loses.
 *
 * THE ABSENT CASE IS NOT A LIQUIDITY FAILURE, and this used to say it was. `selectOption`
 * returns null in three situations and none of them is a thin strike: there was no chain for
 * this stock in the cycle, there was no usable spot, or nothing in the strike window came back
 * priced. A genuine liquidity failure takes the opposite path on purpose — the nearest strike
 * is returned WITH its warnings, because "here is the contract and here is what is wrong with
 * it" beats silence, so that case arrives as a contract and a caveat and never reaches here.
 *
 * The distinction is worth the words. The old wording sent a reader to check whether the
 * strikes were thin, when the chain had simply not been fetched — and it implied the setup was
 * untradable, when the stock levels below are computed from the stock and stand regardless.
 */
function optionLines(signal: PullbackSignal, m: Markup): string[] {
  const o = signal.option;
  if (!o)
    return [
      '',
      `⚠️ ${m.italic('No option chain for this stock this cycle — no contract priced.')}`,
      `    ${m.italic('The stock levels below still stand; pick the contract yourself.')}`,
    ];

  const out = [
    '',
    `🎟 ${m.bold(`BUY ${m.escape(o.label)}`)}  ${m.italic(`(${m.escape(o.expiry)}, ${o.expiryDays}d)`)}`,
    // The premium keeps its paise. Options are quoted to two decimals and rounding ₹5.50 to ₹6
    // is a 9% error on the thing being bought — the per-lot totals below round, because there a
    // rupee is noise.
    `    Premium ${m.bold(`₹${o.entryCost.toFixed(2)}`)} × ${o.lotSize ?? '?'} = ${m.bold(o.costPerLot == null ? '—' : inr(o.costPerLot))} per lot`,
  ];

  const reward = o.profitPerLot;
  const risk = riskPerLot(signal, o);
  if (reward != null)
    out.push(`    🎯 Target → ${m.bold(`+${inr(reward)}`)} per lot${o.gainPctAtTarget == null ? '' : ` (+${o.gainPctAtTarget.toFixed(0)}%)`}`);
  if (risk != null)
    out.push(`    🛑 Stop → ${m.bold(`−${inr(risk)}`)} per lot ${m.italic('(est.)')}`);

  out.push(`    Delta ${Math.abs(o.delta).toFixed(2)} · Liquidity ${o.liquidity.grade}${o.breakEven == null ? '' : ` · B/E ${o.breakEven.toFixed(2)}`}`);
  // The warnings are the reason a contract that passed the gate can still be a bad fill.
  for (const w of o.warnings.slice(0, 2)) out.push(`    ⚠️ ${m.escape(w)}`);
  return out;
}

/**
 * The session behind the setup, in one line.
 *
 * This is the context that decides whether the pullback is a pause or a failure, and it is the
 * only thing on the message the pullback scanner did not work out for itself. It is written
 * even when it disagrees or is missing: an alert that arrives with "the day is going the other
 * way" is a judgement the reader can make, and one that silently omits it is not.
 */
function trendLine(signal: PullbackSignal, trend: TrendContext | null, m: Markup): string[] {
  if (!trend)
    return ['', `📈 ${m.italic('Trend day: not measurable — no live session reading for this stock.')}`];

  const word = trend.direction === 1 ? 'bullish' : trend.direction === -1 ? 'bearish' : 'neutral';
  const agrees = trend.direction === signal.direction;

  if (trend.phase === 'Confirmed' && agrees)
    return ['', `📈 ${m.bold(`With the day — confirmed ${word}`)}, conviction ${trend.score.toFixed(0)}` +
      `${trend.confirmedAt ? ` since ${istClock(trend.confirmedAt)}` : ''}` +
      `${trend.partial ? m.italic(' (partial read)') : ''}`];

  if (trend.phase === 'Forming' && agrees)
    return ['', `📈 One-sided day ${m.bold('forming')} ${word}, conviction ${trend.score.toFixed(0)} — not confirmed yet.`];

  if (!agrees && trend.direction !== 0)
    return ['', `⚠️ ${m.bold(`Against the day`)} — the session is ${word} at conviction ${trend.score.toFixed(0)}.`];

  return ['', `📉 ${m.italic(`No one-sided day — conviction ${trend.score.toFixed(0)}, phase ${trend.phase.toLowerCase()}.`)}`];
}

/**
 * Whether this message carries the trend-day label, on the same test `alert.engine.ts` uses.
 *
 * Derived from the trend rather than passed in as a flag, so the badge and the `trendDay` alert
 * kind cannot come apart: both are "phase is Confirmed and the direction agrees", and a message
 * wearing the badge is by construction one the engine classified that way.
 */
export const isTrendDaySignal = (signal: PullbackSignal, trend: TrendContext | null): boolean =>
  !!trend && trend.phase === 'Confirmed' && trend.direction === signal.direction;

/**
 * The label, on its own line above everything.
 *
 * AT THE TOP AND NOT FOLDED INTO THE TREND LINE, deliberately. The session reading is already
 * written four lines down, and it is a sentence you have to read; this is a badge you can see
 * without reading, on a phone, from a notification preview that shows two lines. The whole value
 * of the distinction is that it is legible before the message is opened.
 */
const trendDayBadge = (signal: PullbackSignal, trend: TrendContext | null, m: Markup): string[] => {
  if (!isTrendDaySignal(signal, trend)) return [];
  const word = signal.direction === 1 ? 'bullish' : 'bearish';
  return [
    `🏆 ${m.bold('TREND DAY CONFIRMED')} · ${m.italic(`taken with a one-sided ${word} session`)}`,
    '',
  ];
};

/**
 * A fired signal as a message.
 *
 * Ordered as the decision is made: what it is, whether the day agrees, what to buy, what it
 * costs, where it goes, where you are wrong. The stock levels come after the option because the
 * option is what gets traded — the stock levels are what the stop and target are MEASURED on.
 */
export function buildSignalMessage(signal: PullbackSignal, m: Markup, trend: TrendContext | null = null): string {
  const dir = signal.direction === 1 ? '🟢 LONG' : '🔴 SHORT';
  const risk = Math.abs(signal.entry - signal.stop.recommended.price);

  return [
    ...trendDayBadge(signal, trend, m),
    `${dir}  ${m.bold(m.escape(signal.symbol))}  ·  ${signal.score.band} ${signal.score.total.toFixed(0)}/100`,
    m.italic(`${TIMEFRAME_LABEL[signal.timeframe]} pullback entry · fired ${istClock(signal.firedAt)}`),
    ...trendLine(signal, trend, m),
    ...optionLines(signal, m),
    '',
    `📊 ${m.bold(m.escape(signal.symbol))} levels`,
    `    Entry ${m.bold(signal.entry.toFixed(2))}  (now ${signal.price.toFixed(2)})`,
    `    Target ${m.bold(signal.target.primary.price.toFixed(2))}  ·  Stop ${m.bold(signal.stop.recommended.price.toFixed(2))}  (${risk.toFixed(2)} away)`,
    `    Reward:risk ${m.bold(`${signal.target.rewardRisk.toFixed(2)}R`)} · ${m.escape(signal.stop.recommended.kind)} stop`,
    ...(signal.stop.warning ? [`    ⚠️ ${m.escape(signal.stop.warning)}`] : []),
  ].join('\n');
}

/** A non-signal event, for when the push filter is widened to other kinds. */
export const buildEventMessage = (e: AlertEvent, m: Markup): string =>
  `${m.bold(m.escape(e.title))}\n${m.escape(e.detail)}`;
