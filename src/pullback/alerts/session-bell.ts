// The two session bells: good morning at 09:15, and stumps at 15:30.
//
// These are NOT strategy alerts and deliberately do not go through `alert.engine.ts`. That engine
// is about events the market produced — it dedupes on symbol and direction, scores them, and gates
// them behind the trend filter, none of which means anything for a greeting. These two are
// calendar events: the market opened, the market closed, and they fire whether or not a single
// setup printed all day.
//
// They live beside the channels because that is where delivery lives, and they reuse `message.ts`
// so the same words render as Telegram's HTML and as Discord's Markdown without being written
// twice.
//
// THREE THINGS ARE LOAD-BEARING HERE.
//
//   IT MUST NOT SEND TWICE. The tick runs every thirty seconds and the send window is ten minutes,
//   so the naive version delivers twenty good mornings. Worse, the obvious in-memory guard loses
//   its memory on a restart, and a deploy at 09:17 would greet you again. So "sent today" is
//   written to the same disk store the snapshots use, and it is written BEFORE the send rather
//   than after: a channel that hangs must not leave the flag unset for the next tick to act on.
//
//   IT MUST NOT SEND LATE. If the API is down at 09:15 and comes back at 11:40, there is no
//   greeting — the window has passed and "good morning, markets are open" two hours into the
//   session is worse than silence. The same window is what makes a restart inside it safe.
//
//   THE QUOTE MUST ACTUALLY CHANGE. It is fetched live per bell from ZenQuotes and chosen out of
//   a fifty-quote batch by fit — see `quotes.ts`, which owns the fetch, the filter and the offline
//   fallback. This file's share of that job is the MEMORY: the last `QUOTE_MEMORY` texts sent are
//   kept beside the sent-today record and passed back in, so the picker can rule them out. Without
//   it, fifty random draws from ten thousand quotes will eventually serve the same line twice, and
//   the day it does is the day the whole feature looks broken.
//
// HOLIDAYS. The session clock knows about weekends and nothing else — `marketOpen()` is weekday
// plus time — so on Republic Day this would wish you good morning at a shut exchange. There is no
// holiday calendar in this codebase and inventing one that silently goes stale is worse than not
// having it, so the dates come from the environment: `MARKET_HOLIDAYS=2026-01-26,2026-03-04`.
// Unset means weekends only, which is the honest default.

import { istDay, istMinutes, SESSION_CLOSE_MIN, SESSION_OPEN_MIN } from '../../momentum/session.js';
import { store } from '../../momentum/store.js';
import { PULLBACK_KEYS } from '../config/config.repository.js';
import { HTML, istClock, istDate, istWeekday, MARKDOWN, type Markup } from './message.js';
import { discordConfigured, sendDiscord } from './discord.js';
import { quoteFor, quoteStatus, ZENQUOTES_URL, type Quote } from './quotes.js';
import { sendTelegram, telegramConfigured } from './telegram.js';

export type Bell = 'open' | 'close';

/**
 * How many past quotes to remember, so none of them comes round again soon.
 *
 * Ninety is about four months of bells at two a day. Long enough that a repeat is not something a
 * reader could notice, short enough that the record stays a few kilobytes and the exclusion list
 * never starves a fifty-quote batch of candidates.
 */
export const QUOTE_MEMORY = 90;

/**
 * How long after the bell a message may still be sent.
 *
 * Ten minutes covers a restart, a slow boot and a host whose clock drifted a little, and stops
 * well short of the point where the greeting becomes a lie.
 */
export const GRACE_MIN = 10;

const IST_OFFSET_MS = 330 * 60_000;

/** The IST weekday, 0 = Sunday. */
const istDow = (nowMs: number): number => new Date(nowMs + IST_OFFSET_MS).getUTCDay();

/* ------------------------------------------------------------------------- the words --- */

const quoteBlock = (q: Quote, m: Markup, glyph: string): string[] => [
  `${glyph} ${m.italic(`"${m.escape(q.text)}"`)}`,
  ...(q.by ? [`     — ${m.escape(q.by)}`] : []),
];

/**
 * The credit, which is a LICENCE TERM rather than a nicety.
 *
 * ZenQuotes' free tier is conditioned on a visible attribution linking back to them. It is
 * rendered only when the quote actually came from them — the offline set is this codebase's own,
 * and crediting someone else for it would be its own kind of wrong.
 */
const credit = (q: Quote, m: Markup): string[] =>
  q.sourced ? ['', m.italic(`Quote via ${m.link('ZenQuotes', ZENQUOTES_URL)}`)] : [];

/** The 09:15 message. The quote is passed in because fetching it is async and this is not. */
export function openMessage(nowMs: number, m: Markup, quote: Quote): string {
  return [
    `🔔 ${m.bold('GOOD MORNING — THE MARKET IS OPEN')}`,
    `${m.escape(istDate(nowMs))} · ${istClock(nowMs)} IST`,
    '',
    ...quoteBlock(quote, m, '⚡'),
    '',
    `375 minutes on the clock. ${m.bold('Plan the trade, trade the plan.')}`,
    m.italic('Let the setup come to you. 🚀'),
    ...credit(quote, m),
  ].join('\n');
}

const DAY_MS = 86_400_000;

/**
 * How far ahead to look for the next open session.
 *
 * Two weeks is far more than the exchange has ever been shut for, and the bound is what stops a
 * mis-pasted holiday list — a stray `*`, a whole year of dates — from spinning this loop forever
 * inside a timer nobody is watching.
 */
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * The next day the market actually opens, or null if nothing within the horizon qualifies.
 *
 * Walks forward a day at a time rather than doing weekday arithmetic, because the two things it
 * has to skip do not follow a pattern: a weekend is regular, a holiday is not, and a holiday
 * sitting next to a weekend has to skip both. Adding whole days to the epoch is safe here — IST
 * has no daylight saving, so the wall clock cannot shift underneath the addition.
 */
function nextTradingDay(nowMs: number): number | null {
  for (let i = 1; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const t = nowMs + i * DAY_MS;
    const dow = istDow(t);
    if (dow === 0 || dow === 6) continue;
    if (holidays().has(istDay(t))) continue;
    return t;
  }
  return null;
}

/**
 * When the next bell is, in words.
 *
 * "Back at 09:15 tomorrow" is wrong by two days every Friday and wrong again on the eve of every
 * holiday, and a message casually wrong about the calendar is not one to trust about a price. So
 * it resolves the actual next session and names it:
 *
 *   the next weekday is open      "tomorrow"
 *   Friday, or tomorrow is shut   "on Monday" / "on Thursday" — the weekday alone is unambiguous
 *                                 inside a week and reads better than "the day after tomorrow"
 *   shut for a week or more       the full date, because by then a weekday name is ambiguous
 *
 * HOLIDAYS ONLY WORK IF `MARKET_HOLIDAYS` IS POPULATED. With it empty this still gets every
 * weekend right and will say "tomorrow" on the eve of Diwali, which is the same answer it gave
 * before — the list is the only thing in this codebase that knows the exchange calendar.
 */
function nextSession(nowMs: number): string {
  const next = nextTradingDay(nowMs);
  if (next === null) return 'when the exchange reopens';

  const gap = Math.round((next - nowMs) / DAY_MS);
  if (gap === 1) return 'tomorrow';
  if (gap < 7) return `on ${istWeekday(next)}`;
  return `on ${istDate(next)}`;
}

/** The 15:30 message. */
export function closeMessage(nowMs: number, m: Markup, quote: Quote): string {
  return [
    `🔕 ${m.bold('TRADING SESSION CLOSED')}`,
    `${m.escape(istDate(nowMs))} · ${istClock(nowMs)} IST`,
    '',
    'The bell has rung and the books are shut for the day.',
    '',
    ...quoteBlock(quote, m, '🌙'),
    '',
    `${m.bold('Rest, review, reset.')} Back at 09:15 ${nextSession(nowMs)}.`,
    ...credit(quote, m),
  ].join('\n');
}

/**
 * A bell in whichever dialect the channel speaks.
 *
 * Takes the same `html: boolean` the controller's other renderers take, so `/pullback/alerts/test`
 * can preview a bell without the HTTP layer having to know that Telegram wants HTML and Discord
 * wants Markdown. Synchronous and pure: the quote is handed in, which is what keeps the wording
 * testable without a network.
 */
export const renderBell = (bell: Bell, html: boolean, nowMs: number, quote: Quote): string =>
  (bell === 'open' ? openMessage : closeMessage)(nowMs, html ? HTML : MARKDOWN, quote);

/**
 * Both dialects of a bell, from ONE freshly fetched quote.
 *
 * One fetch and two renders rather than two of each, for two reasons that both bite: two fetches
 * would put a different quote on Telegram than on Discord for the same bell, and they would spend
 * two of the five requests ZenQuotes allows per thirty seconds on a single preview.
 *
 * It deliberately does NOT record the quote as sent. A preview that burned a line would mean
 * testing the message costs you tomorrow's, and the recency memory exists to serve the real bells.
 */
export async function previewBell(bell: Bell, nowMs = Date.now()): Promise<{ html: string; markdown: string }> {
  const quote = await quoteFor(bell, (await load()).recent);
  return {
    html: renderBell(bell, true, nowMs, quote),
    markdown: renderBell(bell, false, nowMs, quote),
  };
}

/* --------------------------------------------------------------------------- the gate --- */

/** `off` disables both bells. Anything else — including unset — leaves them on. */
const enabled = (): boolean => (process.env.SESSION_BELL ?? '').trim().toLowerCase() !== 'off';

let holidayRaw: string | null = null;
let holidaySet = new Set<string>();

/** Parsed once per distinct value of the variable, so the tick is not re-splitting a string. */
function holidays(): Set<string> {
  const raw = process.env.MARKET_HOLIDAYS ?? '';
  if (raw !== holidayRaw) {
    holidayRaw = raw;
    holidaySet = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return holidaySet;
}

export interface BellState {
  openSentDay: string | null;
  closeSentDay: string | null;
  /** The last `QUOTE_MEMORY` quotes sent, newest last. What stops one coming round again. */
  recent: string[];
}

const EMPTY: BellState = { openSentDay: null, closeSentDay: null, recent: [] };

/**
 * Which bell, if any, is due right now — pure, so the whole schedule is testable without a clock,
 * a network or a disk.
 */
export function dueBell(nowMs: number, state: BellState): Bell | null {
  const dow = istDow(nowMs);
  if (dow === 0 || dow === 6) return null;

  const day = istDay(nowMs);
  if (holidays().has(day)) return null;

  const mins = istMinutes(nowMs);
  if (state.openSentDay !== day && mins >= SESSION_OPEN_MIN && mins < SESSION_OPEN_MIN + GRACE_MIN) return 'open';
  if (state.closeSentDay !== day && mins >= SESSION_CLOSE_MIN && mins < SESSION_CLOSE_MIN + GRACE_MIN) return 'close';
  return null;
}

/* ---------------------------------------------------------------------- the delivery --- */

let sending = false;
let lastSentAt: number | null = null;
let lastBell: Bell | null = null;
let lastError: string | null = null;

/**
 * The stored record, defaulted field by field.
 *
 * Spread over `EMPTY` rather than returned as-is because a file written by an older build has no
 * `recent` key, and `undefined.length` inside the picker would take the bell down on the first
 * morning after a deploy.
 */
const load = async (): Promise<BellState> => {
  const saved = await store.read<Partial<BellState>>(PULLBACK_KEYS.sessionBell);
  return { ...EMPTY, ...saved, recent: saved?.recent ?? [] };
};

/**
 * Send one bell to every configured channel.
 *
 * Each channel is awaited only by its own promise — `sendTelegram` and `sendDiscord` already
 * swallow their failures and count them — so one dead channel cannot stop the other, exactly as
 * the strategy pushes behaved. Both render the SAME quote object, so the two phones can never
 * show different words on the same morning.
 */
async function deliver(bell: Bell, nowMs: number, quote: Quote): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  if (telegramConfigured()) jobs.push(sendTelegram(renderBell(bell, true, nowMs, quote)));
  if (discordConfigured()) jobs.push(sendDiscord(renderBell(bell, false, nowMs, quote)));
  if (!jobs.length) {
    lastError = 'no phone channel is configured';
    return;
  }
  const results = await Promise.all(jobs);
  lastError = results.every(Boolean) ? null : 'a configured channel refused the message';
  lastSentAt = nowMs;
  lastBell = bell;
}

/**
 * One tick. Called on the scheduler's own timer rather than folded into the scan, because the scan
 * returns early without an Upstox token and a good morning does not need one — an API running
 * purely to relay these should still ring the bell.
 *
 * Returns which bell was rung, for the test and for the tools.
 */
export async function sessionBellTick(nowMs = Date.now()): Promise<Bell | null> {
  if (!enabled() || sending) return null;
  sending = true;
  try {
    const state = await load();
    const bell = dueBell(nowMs, state);
    if (!bell) return null;

    // Fetched before the record is written, so a quote host that is down costs a fallback line
    // rather than the whole bell — `quoteFor` resolves either way and never throws.
    const quote = await quoteFor(bell, state.recent);

    // Marked BEFORE the send, and that ordering is the whole dedupe. A channel that takes longer
    // than the tick interval would otherwise be sent to again on the next tick, and the failure
    // this protects against — twenty good mornings — is far worse than the one it accepts, which
    // is a bell lost to a channel that was down at exactly 09:15.
    //
    // The quote joins the memory in the same write. It is recorded as SENT at the point it is
    // chosen rather than after delivery succeeds, for the same reason: a quote burned by a failed
    // send is a cheaper loss than one repeated because the write never happened.
    const day = istDay(nowMs);
    if (bell === 'open') state.openSentDay = day;
    else state.closeSentDay = day;
    state.recent = [...state.recent, quote.text].slice(-QUOTE_MEMORY);
    await store.write(PULLBACK_KEYS.sessionBell, state);

    await deliver(bell, nowMs, quote);
    return bell;
  } catch (e) {
    lastError = String((e as Error).message);
    return null;
  } finally {
    sending = false;
  }
}

/** Reported on `/pullback/status`, so a bell that never rang is diagnosable. */
export const sessionBellStatus = async () => {
  const { recent, ...state } = await load();
  return {
    enabled: enabled(),
    holidays: holidays().size,
    lastSentAt,
    lastBell,
    lastError,
    ...state,
    // The texts themselves would be ninety lines of JSON on a status endpoint nobody reads for
    // that. The COUNT is the diagnostic: stuck at zero means quotes are never being recorded.
    quotesRemembered: recent.length,
    quotes: quoteStatus(),
  };
};

/** Test seam. Clears both the in-process counters and the persisted "sent today" record. */
export const resetSessionBell = async (): Promise<void> => {
  lastSentAt = null;
  lastBell = null;
  lastError = null;
  await store.write(PULLBACK_KEYS.sessionBell, { ...EMPTY });
};
