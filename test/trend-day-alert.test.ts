// The Trend Day confirmation alert — the selection and the message, not the delivery.
//
// Everything here is about the quiet, because every failure mode of this feature is a channel
// somebody mutes. `minMinutesConfirmed` is 75, so nothing confirms before 10:30 and a great many
// things confirm AT 10:30 — on the 2026-08-12 board seventeen stocks confirmed and eight of them
// landed in the same fifteen-second tick. Sent one per stock that is eight buzzes in one second,
// and the very next thing that happens is the bot going on mute.
//
// So what is pinned down is: one message per tick, nothing below the conviction floor, nothing
// twice, and nothing announced late — including the restart case, where a process booting at 14:00
// finds a whole afternoon already sitting at `Confirmed`.
//
// Nothing below touches the network, the disk or the clock. `newlyConfirmed` and `buildMessage` are
// pure, which is why they are separated from `onScan`.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildMessage, buildMessages, newlyConfirmed, type TrendDayAlert } from '../src/momentum/alerts/trend-day.js';
import { HTML, MARKDOWN } from '../src/alerts/markup.js';
import type { ConvictionSummary, MomentumRow, SignalPlan, StrikeChoice } from '../src/momentum/types.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** An IST wall-clock time on Wednesday 12 Aug 2026, as epoch ms. */
const ist = (hh: number, mm: number): number => Date.UTC(2026, 7, 12, hh, mm) - 330 * 60_000;
const CONFIRMED_AT = ist(10, 30);
const NOW = ist(10, 30);

const conviction = (over: Partial<ConvictionSummary> = {}): ConvictionSummary =>
  ({
    ready: true, score: 73, phase: 'Confirmed', direction: 'Bearish',
    heldMin: 22, confirmedAt: CONFIRMED_AT, peak: 75,
    vwapAdherence: 0.96, vwapCrossings: 2, sessionEfficiency: 0.51, rangePosition: 0.92,
    deepestPullbackAtr: 0.31, partial: false, summary: 'Confirmed bearish trend day',
    ...over,
  }) as ConvictionSummary;

const row = (symbol: string, over: Partial<ConvictionSummary> = {}): MomentumRow =>
  ({ symbol, price: 1432.5, changePct: -2.84, conviction: conviction(over), signal: null }) as unknown as MomentumRow;

const plan = (over: Partial<SignalPlan> = {}): SignalPlan =>
  ({
    entry: 1432.5, stop: 1451.2, target: 1395, stopPct: 1.31, targetPct: 2.62, rewardRisk: 2,
    optionMovePctAtTarget: 46, underlyingMovePctForTargetOption: 2.1, meetsOptionTarget: true,
    basis: 'strike', ...over,
  }) as SignalPlan;

const strike = (over: Partial<StrikeChoice> = {}): StrikeChoice =>
  ({
    strike: 1420, type: 'PE', label: '1420 PE', instrumentKey: 'NSE_FO|1',
    expiry: '2026-08-27', expiryDays: 15, stepsFromAtm: 0, moneyness: 'ATM',
    premium: 28.1, entryCost: 28.4, bid: 28.1, ask: 28.4, spreadPct: 1.1,
    delta: -0.42, gamma: 0.004, iv: 31, thetaPctPerHour: 1.2, oi: 120_000, volume: 40_000,
    lotSize: 750, costPerLot: 21_300, premiumAtTarget: 41.5, gainPctAtTarget: 46,
    profitPerLot: 9800, breakEven: 1391.6, reason: 'nearest to 0.45 delta', warnings: [],
    ...over,
  }) as StrikeChoice;

const alert = (over: Partial<TrendDayAlert> = {}): TrendDayAlert => ({
  symbol: 'KPITTECH', direction: -1, price: 1432.5, changePct: -2.84,
  conviction: conviction(), plan: plan(), strike: strike(),
  minutesSinceExtreme: 8, atrUsed: 1.4, lotSize: 750,
  ...over,
});

/* --------------------------------------------------------------------------- tests --- */

describe('trend-day alert: which rows are announced', () => {
  const none = new Set<string>();

  it('announces a fresh confirmation over the floor', () => {
    assert.equal(newlyConfirmed([row('KPITTECH')], none, NOW, 65).length, 1);
  });

  it('ignores anything not confirmed', () => {
    for (const phase of ['None', 'Forming', 'Faded'] as const)
      assert.equal(newlyConfirmed([row('X', { phase })], none, NOW, 65).length, 0, phase);
  });

  // The floor the board asked for. DIXON reached Confirmed early on 2026-08-12 and was sitting at
  // 47 hours later, held up only by the fade hysteresis — not a notification.
  it('drops a confirmation under the conviction floor', () => {
    assert.equal(newlyConfirmed([row('DIXON', { score: 47 })], none, NOW, 65).length, 0);
  });

  it('keeps one exactly on the floor', () => {
    assert.equal(newlyConfirmed([row('X', { score: 65 })], none, NOW, 65).length, 1);
  });

  it('ignores a neutral direction, which has no trade in it', () => {
    assert.equal(newlyConfirmed([row('X', { direction: 'Neutral' })], none, NOW, 65).length, 0);
  });

  // THE RESTART GUARD, and the reason freshness is tested before anything else. A process booting
  // at 14:00 finds every one of the day's confirmations still sitting at `Confirmed`; without this
  // it would announce all seventeen as though the afternoon had just erupted.
  it('says nothing about a confirmation that is no longer fresh', () => {
    assert.equal(newlyConfirmed([row('KPITTECH')], none, ist(14, 0), 65).length, 0);
  });

  it('still announces one inside the freshness window', () => {
    assert.equal(newlyConfirmed([row('KPITTECH')], none, ist(10, 39), 65).length, 1);
  });

  it('never announces the same symbol and direction twice', () => {
    assert.equal(newlyConfirmed([row('KPITTECH')], new Set(['KPITTECH|-1']), NOW, 65).length, 0);
  });

  // A day that flips side is a different day — the phase machine resets rather than decays — so
  // the other direction is a genuinely new event and is keyed separately.
  it('allows the other direction on a stock already announced', () => {
    const bull = row('KPITTECH', { direction: 'Bullish' });
    assert.equal(newlyConfirmed([bull], new Set(['KPITTECH|-1']), NOW, 65).length, 1);
  });

  it('ignores a row with no conviction reading at all', () => {
    assert.equal(newlyConfirmed([{ symbol: 'X', conviction: null } as unknown as MomentumRow], none, NOW, 65).length, 0);
  });
});

describe('trend-day alert: the message', () => {
  it('names the stock and the direction when only one confirmed', () => {
    const msg = buildMessage([alert()], HTML, NOW);
    assert.match(msg, /KPITTECH — BEARISH TREND DAY CONFIRMED/);
    assert.match(msg, /10:30 AM IST/);
  });

  // The whole point of batching: 8 confirmations at 10:30 must be ONE notification.
  it('collapses a whole tick into one message with a count', () => {
    const msg = buildMessage([alert(), alert({ symbol: 'MAXHEALTH' }), alert({ symbol: 'POLYCAB' })], HTML, NOW);
    assert.match(msg, /3 TREND DAYS CONFIRMED/);
    for (const s of ['KPITTECH', 'MAXHEALTH', 'POLYCAB']) assert.match(msg, new RegExp(s));
  });

  it('carries the shape behind the verdict, not just the score', () => {
    const msg = buildMessage([alert()], HTML, NOW);
    assert.match(msg, /conviction <b>73<\/b>/);
    assert.match(msg, /96% below VWAP/);
    assert.match(msg, /2 crossings/);
    assert.match(msg, /deepest dip 0\.31 ATR/);
  });

  it('carries the stop, the target and the reward-to-risk', () => {
    const msg = buildMessage([alert()], HTML, NOW);
    assert.match(msg, /Entry <b>1432\.50<\/b>/);
    assert.match(msg, /Stop <b>1451\.20<\/b>/);
    assert.match(msg, /Target <b>1395\.00<\/b>/);
    assert.match(msg, /<b>2\.00R<\/b>/);
  });

  // What was actually asked for: the contract, its price, the lot, and the rupees for one lot.
  it('carries the contract, the lot size and what one lot costs', () => {
    const msg = buildMessage([alert()], HTML, NOW);
    assert.match(msg, /BUY 1420 PE/);
    assert.match(msg, /₹28\.40<\/b> × 750/);
    assert.match(msg, /₹21,300<\/b> per lot/);
    assert.match(msg, /Target → <b>\+₹9,800<\/b>/);
    assert.match(msg, /Stop → <b>−₹[\d,]+<\/b>/);
  });

  it('says so plainly when there is no chain rather than dropping the alert', () => {
    const msg = buildMessage([alert({ strike: null })], HTML, NOW);
    assert.match(msg, /No option chain/);
    assert.match(msg, /KPITTECH/);
  });

  // `buildPlan` declines for two reasons that want opposite responses — a baseline hole you can
  // refill, and a day the model is deliberately refusing to size a target on. An earlier version
  // blamed the baseline for both, which sent a reader to check a build that was fine.
  it('names the missing ATR when the baseline never covered the stock', () => {
    const msg = buildMessage([alert({ plan: null, strike: null, atrUsed: null })], HTML, NOW);
    assert.match(msg, /no ATR in today's baseline/);
  });

  it('names the stalled day when the ATR is there but the model declined', () => {
    const msg = buildMessage([alert({ plan: null, strike: null, atrUsed: 1.4 })], HTML, NOW);
    assert.match(msg, /stopped making new extremes/);
    assert.equal(msg.includes('no ATR'), false);
  });

  // Confirmation is a claim about the DAY. A stock still printing new extremes at the moment it
  // confirms is a chase, and the message says which it is rather than implying an entry.
  it('flags a row still making new extremes as the chase', () => {
    assert.match(buildMessage([alert({ minutesSinceExtreme: 1 })], HTML, NOW), /this is the chase/);
  });

  it('reads as context, not a warning, once price has come off the extreme', () => {
    const msg = buildMessage([alert({ minutesSinceExtreme: 14 })], HTML, NOW);
    assert.match(msg, /14m since the last extreme/);
    assert.equal(msg.includes('this is the chase'), false);
  });

  it('says when the session record is only partial', () => {
    assert.match(buildMessage([alert({ conviction: conviction({ partial: true }) })], HTML, NOW), /Partial session record/);
  });

  // Telegram parses as HTML and drops the WHOLE message on a malformed tag, so a batch of eight
  // has to come out with balanced markup or none of it arrives.
  it('renders balanced Telegram HTML for a big batch', () => {
    const many = Array.from({ length: 8 }, (_, i) => alert({ symbol: `SYM${i}` }));
    const msg = buildMessage(many, HTML, NOW);
    for (const tag of ['b', 'i'])
      assert.equal(
        (msg.match(new RegExp(`<${tag}>`, 'g')) ?? []).length,
        (msg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
        `unbalanced <${tag}>`,
      );
  });

  // Over 4096 characters Telegram rejects the message outright, which would turn the busiest
  // moment of the day into complete silence.
  it('stays inside the wire limit when everything confirms at once', () => {
    const many = Array.from({ length: 40 }, (_, i) => alert({ symbol: `SYMBOL${i}` }));
    for (const page of buildMessages(many, HTML, NOW))
      assert.ok(page.length < 4096, `page was ${page.length} chars`);
  });

  it('keeps a batch that fits to a single message', () => {
    const pages = buildMessages([alert(), alert({ symbol: 'MAXHEALTH' })], HTML, NOW);
    assert.equal(pages.length, 1);
    // No part counter on a message that has no other part.
    assert.equal(pages[0].includes('(1/1)'), false);
  });

  // THE REGRESSION THIS FILE EXISTS FOR, second half. The batch used to be trimmed to one message
  // and everything past the budget lost its entry, stop, target, contract, lot and cost — it kept
  // only its name. Splitting is what makes "17 confirmed" mean seventeen tradable messages.
  it('splits an oversized batch rather than stripping its plans', () => {
    const many = Array.from({ length: 12 }, (_, i) => alert({ symbol: `SYMBOL${i}` }));
    const pages = buildMessages(many, HTML, NOW);
    assert.ok(pages.length > 1, 'expected more than one page');
    for (const s of many) assert.ok(pages.some((p) => p.includes(s.symbol)), `${s.symbol} was dropped`);
    // Every symbol that appears keeps the whole plan, not just its name.
    assert.equal(pages.join('').match(/Target <b>/g)?.length, 12);
  });

  it('numbers the parts so they read in order', () => {
    const many = Array.from({ length: 12 }, (_, i) => alert({ symbol: `SYMBOL${i}` }));
    const pages = buildMessages(many, HTML, NOW);
    pages.forEach((p, i) => assert.match(p, new RegExp(`\\(${i + 1}/${pages.length}\\)`)));
  });

  // The cap. Past three messages a stampede stops being informative and starts being a wall, so
  // the remainder is named — the old behaviour, now applied only where it is the lesser evil.
  it('caps the split and names whatever still did not fit', () => {
    const many = Array.from({ length: 40 }, (_, i) => alert({ symbol: `SYMBOL${i}` }));
    const pages = buildMessages(many, HTML, NOW);
    assert.equal(pages.length, 3);
    assert.match(pages[2], /more:/);
    // Only the last page carries the tail and the disclaimer.
    assert.equal(pages[0].includes('more:'), false);
  });

  // The lot comes off the futures contract, not the chain, so a cycle that could not price a
  // contract still knows it — and it is the one number a reader cannot work out in their head.
  it('still gives the lot size when there is no chain', () => {
    const msg = buildMessage([alert({ strike: null, lotSize: 750 })], HTML, NOW);
    assert.match(msg, /No option chain this cycle/);
    assert.match(msg, /Lot is 750/);
  });

  it('renders Discord Markdown rather than HTML', () => {
    const msg = buildMessage([alert()], MARKDOWN, NOW);
    assert.equal(msg.includes('<b>'), false);
    assert.match(msg, /\*\*BUY 1420 PE\*\*/);
  });

  it('escapes markup arriving in a symbol or a warning', () => {
    const msg = buildMessage([alert({ strike: strike({ warnings: ['spread & depth <thin>'] }) })], HTML, NOW);
    assert.match(msg, /spread &amp; depth &lt;thin&gt;/);
  });
});
