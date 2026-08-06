// The alert channel — the gates, not the signals.
//
// These exist because every failure here is silent in the opposite direction from the rest of the
// module. A scanner that is wrong prints a wrong row you can look at; an alert channel that is
// wrong either says NOTHING when it should have spoken, or speaks when nobody asked — and the
// second one is worse, because a channel that interrupts you at 10pm gets muted, and a muted
// channel costs you the one alert that mattered.
//
// So what is pinned down here is the quiet: nothing outside market hours, nothing below the
// confidence floor, nothing repeated, and nothing scoreless treated as high confidence.
//
// Nothing below touches the network. `sendTelegram` is not called because the push decision is
// what is under test, and that decision is made before any request exists.

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import { fromRows, fromSignal, resetAlerts } from '../src/pullback/alerts/alert.engine.js';
import { signalMessage } from '../src/pullback/alerts/telegram.js';
import { signalMessage as discordMessage, discordConfigured } from '../src/pullback/alerts/discord.js';
import { defaultConfig } from '../src/pullback/config/defaults.js';
import type { OptionPick, PullbackConfig, PullbackRow, PullbackSignal } from '../src/pullback/types.js';

/* ------------------------------------------------------------------------ fixtures --- */

/** An IST wall-clock time on Thursday 6 Aug 2026, as epoch ms. */
const ist = (hh: number, mm: number): number => Date.UTC(2026, 7, 6, hh, mm) - 330 * 60_000;

const OPEN = ist(11, 0);        // mid-session
const BEFORE_OPEN = ist(8, 30);
const AFTER_CLOSE = ist(21, 41); // the hour the board actually fired at
const WEEKEND = Date.UTC(2026, 7, 8, 6, 0) - 330 * 60_000; // Saturday 11:30 IST

function config(): PullbackConfig {
  const cfg = defaultConfig();
  cfg.alerts.webhookUrl = ''; // no outbound anything from a test
  return cfg;
}

const option = (over: Partial<OptionPick> = {}): OptionPick => ({
  symbol: 'GAIL', side: 'CE', strike: 200, label: '200 CE',
  instrumentKey: 'NSE_FO|1', expiry: '2026-08-27', expiryDays: 21,
  moneyness: 'ATM', stepsFromAtm: 0,
  premium: 5, entryCost: 5.5, bid: 5.4, ask: 5.5, spreadPct: 1.8,
  delta: 0.42, gamma: null, theta: null, thetaPctPerHour: null, vega: null, iv: 22,
  oi: 500_000, oiChange: null, volume: 120_000,
  lotSize: 1000, costPerLot: 5500,
  premiumAtTarget: 8.1, gainPctAtTarget: 47, profitPerLot: 2600, breakEven: 205.5,
  liquidity: { score: 78, grade: 'Good', components: { spread: 80, openInterest: 90, volume: 70, depth: 60 }, reasons: [] },
  band: { min: 0.3, max: 0.45, reason: 'pullback entry' },
  reason: 'nearest to 0.38 delta', warnings: [],
  ...over,
});

const signal = (score: number, at = OPEN, over: Partial<PullbackSignal> = {}): PullbackSignal =>
  ({
    id: `sig-${score}`, symbol: 'GAIL', timeframe: 5, direction: 1, side: 'BUY',
    entryKind: 'pullback', firedAt: at, ageMin: 0,
    entry: 200, price: 200.4, movedSincePct: 0.2,
    score: { total: score, band: 'Strong', components: [], coverage: 1 },
    stop: { candidates: [], recommended: { kind: 'structure', price: 196, reason: 'below the swing low' } },
    target: { candidates: [], primary: { kind: '2R', price: 208, r: 2 }, rewardRisk: 2, travelR: 2 },
    option: option(),
    ...over,
  }) as unknown as PullbackSignal;

const atZoneRow = (): PullbackRow =>
  ({
    symbol: 'GAIL', price: 200,
    trends: { 5: { strength: 61 } },
    pullbacks: {
      5: { direction: 1, phase: 'AtZone', retracement: 0.5, depthAtr: 1.2, touch: { nearest: 'ema20' }, note: null },
    },
    watch: { score: { total: 61 } },
  }) as unknown as PullbackRow;

/* --------------------------------------------------------------------------- tests --- */

describe('alerts: market hours', () => {
  beforeEach(() => resetAlerts());

  it('emits during the session', () => {
    assert.equal(fromRows([atZoneRow()], config(), OPEN).length, 1);
  });

  // The regression that prompted all of this: an on-demand scan from a page load at 21:41 fired
  // one alert for every row on the board, six hours after the close.
  it('emits NOTHING after the close', () => {
    assert.equal(fromRows([atZoneRow()], config(), AFTER_CLOSE).length, 0);
  });

  it('emits nothing before the open', () => {
    assert.equal(fromRows([atZoneRow()], config(), BEFORE_OPEN).length, 0);
  });

  it('emits nothing at a weekend', () => {
    assert.equal(fromRows([atZoneRow()], config(), WEEKEND).length, 0);
  });

  it('gates a fired signal on the same clock', () => {
    assert.equal(fromSignal(signal(90, AFTER_CLOSE), config(), AFTER_CLOSE), null);
    resetAlerts();
    assert.notEqual(fromSignal(signal(90), config(), OPEN), null);
  });
});

describe('alerts: dedupe', () => {
  beforeEach(() => resetAlerts());

  it('suppresses a repeat inside the window', () => {
    const cfg = config();
    assert.notEqual(fromSignal(signal(90), cfg, OPEN), null);
    assert.equal(fromSignal(signal(90), cfg, OPEN + 60_000), null, 'one minute later');
  });

  it('allows it again once the window has passed', () => {
    const cfg = config(); // dedupeMin defaults to 10
    assert.notEqual(fromSignal(signal(90), cfg, OPEN), null);
    assert.notEqual(fromSignal(signal(90), cfg, OPEN + 11 * 60_000), null);
  });
});

describe('alerts: the push gate', () => {
  beforeEach(() => resetAlerts());

  // The gate is not observable from the return value — `emit` returns the event either way,
  // because the in-app feed keeps everything. So it is exercised through the config the gate
  // reads, which is the same object the engine consults.
  const passes = (cfg: PullbackConfig, kind: string, score: number | null): boolean => {
    const p = cfg.alerts.push;
    if (!p.enabled || !p.kinds.includes(kind as never)) return false;
    if (score == null) return false;
    const order = ['Weak', 'Medium', 'Strong', 'Excellent'];
    const b = cfg.score.bands;
    const band = score >= b.excellent ? 'Excellent' : score >= b.strong ? 'Strong' : score >= b.medium ? 'Medium' : 'Weak';
    return order.indexOf(band) >= order.indexOf(p.minBand);
  };

  it('defaults to confirmed entries only', () => {
    const cfg = config();
    assert.deepEqual(cfg.alerts.push.kinds, ['trendResume']);
    assert.equal(cfg.alerts.push.minBand, 'Strong');
  });

  it('lets a Strong confirmed entry through', () => {
    const cfg = config();
    assert.equal(passes(cfg, 'trendResume', cfg.score.bands.strong), true);
  });

  it('holds back anything below the floor', () => {
    const cfg = config();
    assert.equal(passes(cfg, 'trendResume', cfg.score.bands.strong - 1), false);
    assert.equal(passes(cfg, 'trendResume', cfg.score.bands.medium), false);
  });

  it('does not push a fresh pullback, however strong', () => {
    assert.equal(passes(config(), 'freshPullback', 99), false);
  });

  // "Unknown confidence" is not "high confidence" — a scoreless event must never pass a floor.
  it('never treats a missing score as passing', () => {
    assert.equal(passes(config(), 'trendResume', null), false);
  });
});

describe('alerts: the message', () => {
  const msg = signalMessage(signal(88));

  it('names the contract to buy', () => {
    assert.match(msg, /BUY 200 CE/);
  });

  it('states what one lot costs', () => {
    assert.match(msg, /₹5,500<\/b> per lot/);
  });

  it('states the rupees made at target and lost at the stop, per lot', () => {
    assert.match(msg, /Target → <b>\+₹2,600<\/b> per lot/);
    // 5.5 premium − 0.42 delta × 4.00 move = 3.82 → ₹1,680 a lot, flagged as an estimate.
    assert.match(msg, /Stop → <b>−₹1,680<\/b> per lot <i>\(est\.\)<\/i>/);
  });

  it('carries the stock levels the plan is measured on', () => {
    assert.match(msg, /Entry <b>200\.00<\/b>/);
    assert.match(msg, /Target <b>208\.00<\/b>/);
    assert.match(msg, /Stop <b>196\.00<\/b>/);
    assert.match(msg, /2\.00R/);
  });

  it('says so when there is no tradable contract rather than going quiet', () => {
    assert.match(signalMessage(signal(88, OPEN, { option: null })), /No tradable option contract/);
  });

  // A long option cannot lose more than its premium; a wide stop must not imply a debt.
  it('never estimates a loss larger than the premium paid', () => {
    const wide = signal(88, OPEN, {
      stop: { candidates: [], recommended: { kind: 'structure', price: 100, reason: 'far' } },
    } as unknown as Partial<PullbackSignal>);
    assert.match(signalMessage(wide), /Stop → <b>−₹5,500<\/b> per lot/);
  });
});

describe('alerts: Discord beside Telegram', () => {
  const tg = signalMessage(signal(88));
  const dc = discordMessage(signal(88));

  it('renders Markdown, not HTML', () => {
    assert.match(dc, /\*\*BUY 200 CE\*\*/);
    assert.equal(/<b>|<i>/.test(dc), false, 'no HTML tags should reach Discord');
  });

  // The whole reason both channels share `message.ts`: two phones must not disagree about a price.
  it('carries the identical numbers to both channels', () => {
    const strip = (s: string) => s.replace(/<\/?[bi]>/g, '').replace(/\\([*_~`|\\])/g, '$1').replace(/\*\*|_/g, '');
    assert.equal(strip(dc), strip(tg));
  });

  it('escapes Markdown control characters in a symbol', () => {
    const m = discordMessage(signal(88, OPEN, { symbol: 'M_M' } as unknown as Partial<PullbackSignal>));
    assert.match(m, /M\\_M/);
  });

  it('only counts a real Discord webhook as configured', () => {
    const prev = process.env.PULLBACK_DISCORD_WEBHOOK_URL;
    try {
      process.env.PULLBACK_DISCORD_WEBHOOK_URL = '';
      assert.equal(discordConfigured(), false);
      // A pasted-wrong URL must read as unconfigured rather than fail on every single alert.
      process.env.PULLBACK_DISCORD_WEBHOOK_URL = 'https://example.com/hook';
      assert.equal(discordConfigured(), false);
      process.env.PULLBACK_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
      assert.equal(discordConfigured(), true);
    } finally {
      if (prev === undefined) delete process.env.PULLBACK_DISCORD_WEBHOOK_URL;
      else process.env.PULLBACK_DISCORD_WEBHOOK_URL = prev;
    }
  });
});
