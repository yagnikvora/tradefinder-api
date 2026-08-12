// The session bells — the schedule, not the sentiment.
//
// What is worth pinning down here is everything that would embarrass the channel. A greeting is
// low-stakes when it is right and expensive when it is wrong: twenty good mornings in ten minutes
// gets the bot muted, and a muted bot is the failure this whole alert stack keeps trying to avoid.
//
// So the tests are about the quiet, again: exactly one of each per day, none at a weekend, none on
// a listed holiday, and none at 11:40 because the process happened to boot then.
//
// Nothing below touches the network or the disk — `dueBell` is pure and takes the state it would
// otherwise have read, which is why it is separated from the tick in the first place.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  dueBell, GRACE_MIN, quoteFor, renderBell, type BellState,
} from '../src/pullback/alerts/session-bell.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** An IST wall-clock time on Wednesday 12 Aug 2026, as epoch ms. */
const ist = (hh: number, mm: number): number => Date.UTC(2026, 7, 12, hh, mm) - 330 * 60_000;
/** The same clock time on Saturday 15 Aug 2026. */
const saturday = (hh: number, mm: number): number => Date.UTC(2026, 7, 15, hh, mm) - 330 * 60_000;

const FRESH: BellState = { openSentDay: null, closeSentDay: null };
const state = (over: Partial<BellState> = {}): BellState => ({ ...FRESH, ...over });

/**
 * Run `fn` with a holiday list in place, and put the environment back afterwards.
 *
 * The variable is read on every call rather than at import, which is what makes this possible —
 * and is itself worth having, since it means adding a holiday does not need a restart.
 */
function withHolidays<T>(list: string, fn: () => T): T {
  const before = process.env.MARKET_HOLIDAYS;
  process.env.MARKET_HOLIDAYS = list;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MARKET_HOLIDAYS;
    else process.env.MARKET_HOLIDAYS = before;
  }
}

/* --------------------------------------------------------------------------- tests --- */

describe('session bell: the schedule', () => {
  it('rings the open bell at 09:15', () => {
    assert.equal(dueBell(ist(9, 15), FRESH), 'open');
  });

  it('rings the close bell at 15:30', () => {
    assert.equal(dueBell(ist(15, 30), FRESH), 'close');
  });

  it('says nothing before the open', () => {
    assert.equal(dueBell(ist(9, 14), FRESH), null);
  });

  it('says nothing between the two bells', () => {
    assert.equal(dueBell(ist(12, 0), FRESH), null);
  });

  // The window is what makes a restart inside it safe. It is also what stops a process that was
  // down all morning from wishing you good morning over lunch.
  it('still rings inside the grace window', () => {
    assert.equal(dueBell(ist(9, 15 + GRACE_MIN - 1), FRESH), 'open');
  });

  it('has gone quiet once the window has passed', () => {
    assert.equal(dueBell(ist(9, 15 + GRACE_MIN), FRESH), null);
    assert.equal(dueBell(ist(11, 40), FRESH), null, 'a boot two hours late must not greet');
  });
});

describe('session bell: once a day', () => {
  // The regression this exists for: the tick runs every 30 seconds and the window is ten minutes,
  // so without the persisted record one open bell becomes twenty.
  it('does not repeat a bell already sent today', () => {
    assert.equal(dueBell(ist(9, 16), state({ openSentDay: '2026-08-12' })), null);
  });

  it('rings again the next day', () => {
    // Thursday, with Wednesday's record still on disk.
    const thursday = Date.UTC(2026, 7, 13, 9, 15) - 330 * 60_000;
    assert.equal(dueBell(thursday, state({ openSentDay: '2026-08-12' })), 'open');
  });

  it('sends the close bell even when the open bell already went', () => {
    assert.equal(dueBell(ist(15, 30), state({ openSentDay: '2026-08-12' })), 'close');
  });

  it('goes quiet once both have gone', () => {
    const both = state({ openSentDay: '2026-08-12', closeSentDay: '2026-08-12' });
    assert.equal(dueBell(ist(9, 16), both), null);
    assert.equal(dueBell(ist(15, 31), both), null);
  });
});

describe('session bell: days the market is shut', () => {
  it('says nothing at a weekend', () => {
    assert.equal(dueBell(saturday(9, 15), FRESH), null);
    assert.equal(dueBell(saturday(15, 30), FRESH), null);
  });

  // Weekday holidays are the one thing the session clock cannot work out for itself, so they come
  // from the environment. Read on every call, so setting one does not need a restart.
  it('says nothing on a listed holiday', () => {
    withHolidays('2026-08-12, 2026-10-02', () => {
      assert.equal(dueBell(ist(9, 15), FRESH), null);
      assert.equal(dueBell(ist(15, 30), FRESH), null);
    });
  });

  it('rings normally once the holiday list no longer names today', () => {
    withHolidays('2026-10-02', () => {
      assert.equal(dueBell(ist(9, 15), FRESH), 'open');
    });
  });
});

describe('session bell: the quote', () => {
  // The whole reason the pick is indexed rather than random: two identical good mornings in a row
  // reads as a stuck job, and `Math.random()` produces exactly that about a third of each week.
  it('gives consecutive days different quotes', () => {
    const days = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
    const seen = days.map((d) => quoteFor(d, 'open').text);
    assert.equal(new Set(seen).size, days.length);
  });

  it('gives the same day the same quote every time it is asked', () => {
    assert.equal(quoteFor('2026-08-12', 'open').text, quoteFor('2026-08-12', 'open').text);
  });

  it('draws the morning and the evening from different sets', () => {
    assert.notEqual(quoteFor('2026-08-12', 'open').text, quoteFor('2026-08-12', 'close').text);
  });

  it('cycles the whole list before repeating', () => {
    // 23 morning quotes, so a month of weekdays should not collide.
    const texts = new Set<string>();
    for (let i = 0; i < 23; i++) {
      const day = new Date(Date.UTC(2026, 7, 12) + i * 86_400_000).toISOString().slice(0, 10);
      texts.add(quoteFor(day, 'open').text);
    }
    assert.equal(texts.size, 23);
  });
});

describe('session bell: the message', () => {
  it('names the right day and time in the morning', () => {
    const msg = renderBell('open', true, ist(9, 15));
    assert.match(msg, /Wednesday, 12 August 2026/);
    assert.match(msg, /09:15 AM IST/);
    assert.match(msg, /GOOD MORNING/);
  });

  it('says the session is closed in the evening', () => {
    const msg = renderBell('close', true, ist(15, 30));
    assert.match(msg, /TRADING SESSION CLOSED/);
    assert.match(msg, /03:30 PM IST/);
  });

  // Telegram parses the message as HTML and drops the WHOLE message on a malformed tag, so the
  // only markup in it must be the markup this file put there.
  it('renders Telegram HTML with balanced tags and nothing else angled', () => {
    const msg = renderBell('open', true, ist(9, 15));
    assert.equal((msg.match(/<b>/g) ?? []).length, (msg.match(/<\/b>/g) ?? []).length);
    assert.equal((msg.match(/<i>/g) ?? []).length, (msg.match(/<\/i>/g) ?? []).length);
    assert.equal(msg.replace(/<\/?[bi]>/g, '').includes('<'), false);
  });

  it('renders Discord Markdown rather than HTML', () => {
    const msg = renderBell('close', false, ist(15, 30));
    assert.equal(msg.includes('<b>'), false);
    assert.match(msg, /\*\*TRADING SESSION CLOSED\*\*/);
  });
});

// "Back at 09:15 tomorrow" is wrong by two days every Friday and wrong again on the eve of every
// holiday, and a message casually wrong about the calendar is not one to trust about a price.
//
// August 2026 for reference: the 12th is a Wednesday, so 13 Thu, 14 Fri, 15 Sat, 16 Sun, 17 Mon.
describe('session bell: when the next session is', () => {
  const closingLine = (nowMs: number): string =>
    renderBell('close', true, nowMs).split('\n').at(-1) as string;

  it('says tomorrow on an ordinary weekday', () => {
    assert.match(closingLine(ist(15, 30)), /Back at 09:15 tomorrow\./);
  });

  it('says Monday on a Friday', () => {
    const friday = Date.UTC(2026, 7, 14, 15, 30) - 330 * 60_000;
    assert.match(closingLine(friday), /Back at 09:15 on Monday\./);
  });

  // The case this section was rewritten for: a holiday tomorrow means the next session is the day
  // after, and naming the weekday beats "the day after tomorrow".
  it('skips a holiday that falls tomorrow', () => {
    withHolidays('2026-08-13', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Friday\./);
    });
  });

  it('skips a holiday that bridges into the weekend', () => {
    // Thursday, with Friday shut — the next session is Monday, three days out.
    const thursday = Date.UTC(2026, 7, 13, 15, 30) - 330 * 60_000;
    withHolidays('2026-08-14', () => {
      assert.match(closingLine(thursday), /Back at 09:15 on Monday\./);
    });
  });

  it('skips a holiday on the Monday after a Friday close', () => {
    const friday = Date.UTC(2026, 7, 14, 15, 30) - 330 * 60_000;
    withHolidays('2026-08-17', () => {
      assert.match(closingLine(friday), /Back at 09:15 on Tuesday\./);
    });
  });

  it('skips a run of consecutive holidays', () => {
    withHolidays('2026-08-13,2026-08-14,2026-08-17', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Tuesday\./);
    });
  });

  // Past a week a weekday name is ambiguous — "on Friday" could be either of two Fridays — so the
  // full date is used instead.
  it('names the date when the market is shut for more than a week', () => {
    withHolidays('2026-08-13,2026-08-14,2026-08-17,2026-08-18,2026-08-19,2026-08-20', () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 on Friday, 21 August 2026\./);
    });
  });

  // A mis-pasted list must not spin the lookahead forever inside a timer.
  it('gives up gracefully rather than looping when nothing is open', () => {
    const shut = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 13) + i * 86_400_000).toISOString().slice(0, 10)).join(',');
    withHolidays(shut, () => {
      assert.match(closingLine(ist(15, 30)), /Back at 09:15 when the exchange reopens\./);
    });
  });
});

// The list itself, as shipped.
//
// This exists for next January. The calendar has to be re-pasted by hand every year — NSE
// publishes the coming one around December — and a typo in it fails in the quietest possible
// way: a malformed date simply never matches, so the bell rings on a holiday and nothing
// anywhere says why. Cheaper to catch here than to notice on Diwali.
//
// Deliberately checks the SHAPE and not the dates. Asserting 2026's sixteen would turn the
// annual refresh into a test edit, which is how a guard like this gets deleted.
describe('session bell: the shipped holiday list', () => {
  const example = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '.env.example');
  const dates = ((parseEnv(readFileSync(example, 'utf8')) as Record<string, string>).MARKET_HOLIDAYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  it('is actually parsed out of .env.example', () => {
    assert.ok(dates.length > 0, 'MARKET_HOLIDAYS is empty — a multi-line value will not parse');
  });

  it('is all well-formed YYYY-MM-DD', () => {
    for (const d of dates) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `${d} is not YYYY-MM-DD`);
      assert.ok(!Number.isNaN(Date.parse(`${d}T00:00:00Z`)), `${d} is not a real date`);
      // Catches the classic: a 13th month, or a 31st of a 30-day month, both of which parse in
      // some engines and silently never match a real day.
      assert.equal(new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10), d);
    }
  });

  it('lists no weekends, which the session clock already skips', () => {
    for (const d of dates) {
      const dow = new Date(Date.parse(`${d}T00:00:00Z`)).getUTCDay();
      assert.ok(dow !== 0 && dow !== 6, `${d} falls at a weekend and does not need listing`);
    }
  });

  it('lists nothing twice', () => {
    assert.equal(new Set(dates).size, dates.length);
  });
});
