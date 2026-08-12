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
//   THE QUOTE MUST ACTUALLY CHANGE. Picked by day index rather than at random, because random
//   repeats: over a five-day week `Math.random()` gives the same quote twice about a third of the
//   time, and two identical good mornings in a row reads as a stuck cron. Indexing by the day
//   guarantees the full list cycles before anything repeats, and makes the message reproducible
//   in a test.
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
import { sendTelegram, telegramConfigured } from './telegram.js';

export type Bell = 'open' | 'close';

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

interface Quote {
  text: string;
  /** Null for the ones that are trading-floor adages with no honest attribution. */
  by: string | null;
}

/**
 * The morning set — energetic, and about doing the work rather than about being rich.
 *
 * Chosen to say something a trader can act on in the next six hours. Motivational wallpaper
 * ("believe in yourself") is fine on a poster and useless at 09:15, so most of these are about
 * process: defend capital, wait for your setup, cut what is not working.
 */
const OPEN_QUOTES: Quote[] = [
  { text: 'Every battle is won before it is ever fought.', by: 'Sun Tzu' },
  { text: 'The most important rule of trading is to play great defence, not great offence.', by: 'Paul Tudor Jones' },
  { text: 'Markets are never wrong — opinions often are.', by: 'Jesse Livermore' },
  { text: 'The elements of good trading are cutting losses, cutting losses, and cutting losses.', by: 'Ed Seykota' },
  { text: 'Amateurs think about how much money they can make. Professionals think about how much they could lose.', by: 'Jack Schwager' },
  { text: 'Risk comes from not knowing what you are doing.', by: 'Warren Buffett' },
  { text: 'The stock market is a device for transferring money from the impatient to the patient.', by: 'Warren Buffett' },
  { text: 'The big money is not in the buying and the selling, but in the waiting.', by: 'Charlie Munger' },
  { text: 'In investing, what is comfortable is rarely profitable.', by: 'Robert Arnott' },
  { text: 'The four most dangerous words in investing are: this time it is different.', by: 'Sir John Templeton' },
  { text: 'Fortune favours the prepared mind.', by: 'Louis Pasteur' },
  { text: 'Discipline is the bridge between goals and accomplishment.', by: 'Jim Rohn' },
  { text: 'Learn to take losses. The most important thing is not letting your losses get out of hand.', by: 'Marty Schwartz' },
  { text: 'The goal of a successful trader is to make the best trades. Money is secondary.', by: 'Alexander Elder' },
  { text: 'Losers average losers.', by: 'Paul Tudor Jones' },
  { text: 'An investment in knowledge pays the best interest.', by: 'Benjamin Franklin' },
  { text: 'There is a time to go long, a time to go short, and a time to go fishing.', by: 'Jesse Livermore' },
  { text: 'Know what you own, and know why you own it.', by: 'Peter Lynch' },
  { text: 'The trend is your friend until the end when it bends.', by: 'Ed Seykota' },
  { text: 'Plan the trade. Trade the plan. Everything else is noise.', by: null },
  { text: 'You do not have to be in every move. You have to be right about the one you are in.', by: null },
  { text: 'The setup you skip costs you nothing. The one you force costs you the week.', by: null },
  { text: 'Patience is a position.', by: null },
];

/** The evening set — reflective, and about the review that makes tomorrow better. */
const CLOSE_QUOTES: Quote[] = [
  { text: 'It was never my thinking that made the big money for me. It always was my sitting.', by: 'Jesse Livermore' },
  { text: 'Win or lose, everybody gets what they want out of the market.', by: 'Ed Seykota' },
  { text: 'The best traders have no ego.', by: 'Tom Baldwin' },
  { text: 'I am always thinking about losing money, as opposed to making money.', by: 'Paul Tudor Jones' },
  { text: 'Do more of what works and less of what does not.', by: 'Steve Clark' },
  { text: 'The market will still be here tomorrow. Make sure you are too.', by: null },
  { text: 'A losing day you followed your plan on is a better day than a winning one you did not.', by: null },
  { text: 'Review the trades you did not take as carefully as the ones you did.', by: null },
  { text: 'Green or red, the screen goes dark at the same time. Log it and let it go.', by: null },
  { text: 'Tomorrow brings 375 fresh minutes. None of them care what today did.', by: null },
  { text: 'The edge is not in one day. It is in a thousand of them kept honestly.', by: null },
  { text: 'Count the process, not the P&L. The P&L is downstream.', by: null },
  { text: 'Rest is part of risk management.', by: null },
];

/**
 * Which quote today gets.
 *
 * Indexed on days-since-epoch so the choice is a pure function of the date: the same day always
 * produces the same quote, consecutive days never repeat, and the whole list cycles before
 * anything comes round again. The two lists are deliberately different lengths, so the morning
 * and evening pairings drift instead of locking into the same couple every three weeks.
 */
export function quoteFor(day: string, bell: Bell): Quote {
  const list = bell === 'open' ? OPEN_QUOTES : CLOSE_QUOTES;
  const index = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  // `% length` on a negative epoch would index out of the array; dates before 1970 are not a real
  // case here, but the guard costs nothing and an `undefined` quote would throw inside a timer.
  return list[((index % list.length) + list.length) % list.length];
}

const quoteBlock = (q: Quote, m: Markup, glyph: string): string[] => [
  `${glyph} ${m.italic(`"${m.escape(q.text)}"`)}`,
  ...(q.by ? [`     — ${m.escape(q.by)}`] : []),
];

/** The 09:15 message. */
export function openMessage(nowMs: number, m: Markup): string {
  return [
    `🔔 ${m.bold('GOOD MORNING — THE MARKET IS OPEN')}`,
    `${m.escape(istDate(nowMs))} · ${istClock(nowMs)} IST`,
    '',
    ...quoteBlock(quoteFor(istDay(nowMs), 'open'), m, '⚡'),
    '',
    `375 minutes on the clock. ${m.bold('Plan the trade, trade the plan.')}`,
    m.italic('Let the setup come to you. 🚀'),
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
export function closeMessage(nowMs: number, m: Markup): string {
  return [
    `🔕 ${m.bold('TRADING SESSION CLOSED')}`,
    `${m.escape(istDate(nowMs))} · ${istClock(nowMs)} IST`,
    '',
    'The bell has rung and the books are shut for the day.',
    '',
    ...quoteBlock(quoteFor(istDay(nowMs), 'close'), m, '🌙'),
    '',
    `${m.bold('Rest, review, reset.')} Back at 09:15 ${nextSession(nowMs)}.`,
  ].join('\n');
}

/**
 * A bell in whichever dialect the channel speaks.
 *
 * Takes the same `html: boolean` the controller's other renderers take, so `/pullback/alerts/test`
 * can preview a bell without the HTTP layer having to know that Telegram wants HTML and Discord
 * wants Markdown.
 */
export const renderBell = (bell: Bell, html: boolean, nowMs = Date.now()): string =>
  (bell === 'open' ? openMessage : closeMessage)(nowMs, html ? HTML : MARKDOWN);

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
}

const EMPTY: BellState = { openSentDay: null, closeSentDay: null };

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

const load = async (): Promise<BellState> =>
  (await store.read<BellState>(PULLBACK_KEYS.sessionBell)) ?? { ...EMPTY };

/**
 * Send one bell to every configured channel.
 *
 * Each channel is awaited only by its own promise — `sendTelegram` and `sendDiscord` already
 * swallow their failures and count them — so one dead channel cannot stop the other, exactly as
 * the strategy pushes behaved.
 */
async function deliver(bell: Bell, nowMs: number): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  if (telegramConfigured()) jobs.push(sendTelegram(renderBell(bell, true, nowMs)));
  if (discordConfigured()) jobs.push(sendDiscord(renderBell(bell, false, nowMs)));
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

    // Marked BEFORE the send, and that ordering is the whole dedupe. A channel that takes longer
    // than the tick interval would otherwise be sent to again on the next tick, and the failure
    // this protects against — twenty good mornings — is far worse than the one it accepts, which
    // is a bell lost to a channel that was down at exactly 09:15.
    const day = istDay(nowMs);
    if (bell === 'open') state.openSentDay = day;
    else state.closeSentDay = day;
    await store.write(PULLBACK_KEYS.sessionBell, state);

    await deliver(bell, nowMs);
    return bell;
  } catch (e) {
    lastError = String((e as Error).message);
    return null;
  } finally {
    sending = false;
  }
}

/** Reported on `/pullback/status`, so a bell that never rang is diagnosable. */
export const sessionBellStatus = async () => ({
  enabled: enabled(),
  holidays: holidays().size,
  lastSentAt,
  lastBell,
  lastError,
  ...(await load()),
});

/** Test seam. Clears both the in-process counters and the persisted "sent today" record. */
export const resetSessionBell = async (): Promise<void> => {
  lastSentAt = null;
  lastBell = null;
  lastError = null;
  await store.write(PULLBACK_KEYS.sessionBell, { ...EMPTY });
};
