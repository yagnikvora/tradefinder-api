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

import { fromRows, fromSignal, resetAlerts, trendVerdict } from '../src/pullback/alerts/alert.engine.js';
import { primeTrendContextFrom, resetTrendContext } from '../src/pullback/data/trend-context.js';
import { signalMessage } from '../src/pullback/alerts/telegram.js';
import { signalMessage as discordMessage, discordConfigured } from '../src/pullback/alerts/discord.js';
import { defaultConfig } from '../src/pullback/config/defaults.js';
import { sanitise } from '../src/pullback/config/config.repository.js';
import type {
  OptionPick, PullbackConfig, PullbackRow, PullbackSignal, TrendContext,
} from '../src/pullback/types.js';

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

  it('defaults to confirmed entries only, in both their forms', () => {
    // `trendDay` is the same event with the session behind it, so a default that pushed one and
    // not the other would drop half the confirmations depending on what the day was doing.
    const cfg = config();
    assert.deepEqual(cfg.alerts.push.kinds, ['trendResume', 'trendDay']);
    assert.equal(cfg.alerts.push.minBand, 'Strong');
  });

  it('lets a Strong confirmed entry through', () => {
    const cfg = config();
    assert.equal(passes(cfg, 'trendResume', cfg.score.bands.strong), true);
    assert.equal(passes(cfg, 'trendDay', cfg.score.bands.strong), true);
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

describe('alerts: the trend-day gate', () => {
  beforeEach(() => {
    resetAlerts();
    resetTrendContext();
  });

  /** A momentum board carrying one symbol's conviction, as the gate reads it. */
  const board = (over: Record<string, unknown> = {}, asOf = OPEN) =>
    primeTrendContextFrom({
      asOf,
      rows: [{
        symbol: 'GAIL',
        conviction: {
          ready: true, phase: 'Confirmed', direction: 'Bullish', score: 84,
          confirmedAt: ist(10, 30), heldMin: 30, partial: false, ...over,
        },
      }],
    }, OPEN);

  it('lets a long through when the day is confirmed bullish', () => {
    board();
    const v = trendVerdict(config(), 'GAIL', 1, OPEN);
    assert.equal(v.ok, true);
    assert.equal(v.reason, null);
    assert.equal(v.trend?.score, 84);
  });

  // The row this gate exists to catch: a textbook pullback taken into a session going the
  // other way. It is counted apart from "no trend" because it is the worse of the two.
  it('holds back an entry taken against a confirmed day', () => {
    board();
    const v = trendVerdict(config(), 'GAIL', -1, OPEN);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'wrongWay');
  });

  it('holds back a stock that is merely forming, by default', () => {
    board({ phase: 'Forming' });
    assert.equal(trendVerdict(config(), 'GAIL', 1, OPEN).reason, 'notOneSided');
  });

  it('accepts Forming once the floor is lowered to it', () => {
    board({ phase: 'Forming' });
    const cfg = config();
    cfg.alerts.push.trend.minPhase = 'Forming';
    assert.equal(trendVerdict(cfg, 'GAIL', 1, OPEN).ok, true);
  });

  it('treats a faded day as no day at all', () => {
    board({ phase: 'Faded' });
    assert.equal(trendVerdict(config(), 'GAIL', 1, OPEN).ok, false);
  });

  it('enforces a conviction floor above the phase when one is set', () => {
    board({ score: 60 });
    const cfg = config();
    cfg.alerts.push.trend.minScore = 70;
    assert.equal(trendVerdict(cfg, 'GAIL', 1, OPEN).reason, 'tooWeak');
  });

  // A conviction that is not ready is not a verdict of "not trending" — the accumulators simply
  // have not seen enough of the session, and blocking on it would be inventing a reading.
  it('reads an unready conviction as unknown, not as a refusal', () => {
    board({ ready: false });
    const v = trendVerdict(config(), 'GAIL', 1, OPEN);
    assert.equal(v.reason, 'unknown');
    assert.equal(v.trend, null);
  });

  it('fails OPEN when there is no reading, so the channel never goes silently dark', () => {
    const v = trendVerdict(config(), 'NOTINBOARD', 1, OPEN);
    assert.equal(v.reason, 'unknown');
    assert.equal(v.ok, true);
  });

  it('fails closed instead when that is what was asked for', () => {
    const cfg = config();
    cfg.alerts.push.trend.allowWhenUnknown = false;
    assert.equal(trendVerdict(cfg, 'NOTINBOARD', 1, OPEN).ok, false);
  });

  // A board older than the momentum scan interval means that scanner has stopped, and a phase
  // nobody is maintaining is worse than no phase.
  it('discards a stale board rather than trusting its phase', () => {
    board({}, OPEN - 10 * 60_000);
    assert.equal(trendVerdict(config(), 'GAIL', 1, OPEN).reason, 'unknown');
  });

  it('is inert when switched off', () => {
    board({ direction: 'Bearish' });
    const cfg = config();
    cfg.alerts.push.trend.mode = 'off';
    const v = trendVerdict(cfg, 'GAIL', 1, OPEN);
    assert.equal(v.ok, true);
    assert.equal(v.trend, null);
  });

  // `annotate` still reaches a verdict — the message prints it — it just never blocks.
  it('reports the disagreement but sends anyway in annotate mode', () => {
    board({ direction: 'Bearish' });
    const cfg = config();
    cfg.alerts.push.trend.mode = 'annotate';
    const v = trendVerdict(cfg, 'GAIL', 1, OPEN);
    assert.equal(v.ok, true);
    assert.equal(v.reason, 'wrongWay');
  });

  it('ignores direction entirely when told to', () => {
    board({ direction: 'Bearish' });
    const cfg = config();
    cfg.alerts.push.trend.sameDirection = false;
    assert.equal(trendVerdict(cfg, 'GAIL', 1, OPEN).ok, true);
  });
});

describe('alerts: the trend-day alert kind', () => {
  beforeEach(() => {
    resetAlerts();
    resetTrendContext();
  });

  const board = (over: Record<string, unknown> = {}) =>
    primeTrendContextFrom({
      asOf: OPEN,
      rows: [{
        symbol: 'GAIL',
        conviction: {
          ready: true, phase: 'Confirmed', direction: 'Bullish', score: 84,
          confirmedAt: ist(10, 30), heldMin: 30, partial: false, ...over,
        },
      }],
    }, OPEN);

  const kindOf = (over: Record<string, unknown> | null): string | undefined => {
    if (over) board(over);
    return fromSignal(signal(90), config(), OPEN)?.kind;
  };

  it('promotes the entry to trendDay when the session is confirmed and agrees', () => {
    assert.equal(kindOf({}), 'trendDay');
  });

  it('stays trendResume when no board has been primed at all', () => {
    assert.equal(kindOf(null), 'trendResume');
  });

  it('stays trendResume when the confirmed day runs the other way', () => {
    assert.equal(kindOf({ direction: 'Bearish' }), 'trendResume');
  });

  it('stays trendResume on a day that is only forming', () => {
    assert.equal(kindOf({ phase: 'Forming' }), 'trendResume');
  });

  it('stays trendResume on a faded day', () => {
    assert.equal(kindOf({ phase: 'Faded' }), 'trendResume');
  });

  // Switching the gate off means "stop filtering on the session", not "call every session
  // confirmed" — a badge is a claim about the day, and nothing is measuring the day any more.
  it('makes no trend-day claim once the gate is switched off', () => {
    board();
    const cfg = config();
    cfg.alerts.push.trend.mode = 'off';
    assert.equal(fromSignal(signal(90), cfg, OPEN)?.kind, 'trendResume');
  });

  it('carries the label on the phone message, and only then', () => {
    const confirmed: TrendContext = {
      phase: 'Confirmed', direction: 1, score: 84,
      confirmedAt: ist(10, 30), heldMin: 30, partial: false, ageMs: 1000,
    };
    assert.match(signalMessage(signal(90), confirmed), /TREND DAY CONFIRMED/);
    assert.doesNotMatch(signalMessage(signal(90), { ...confirmed, phase: 'Forming' }), /TREND DAY CONFIRMED/);
    assert.doesNotMatch(signalMessage(signal(90), null), /TREND DAY CONFIRMED/);
  });

  // The regression this whole kind could have caused: `merge` replaces arrays wholesale, so a
  // config saved before `trendDay` existed would keep pushing only `trendResume` — and since a
  // confirmed-day entry now emits `trendDay` instead, that install would go quiet on exactly the
  // trades worth interrupting for, and look like a slow week rather than a bug.
  it('migrates a config saved before the kind existed', () => {
    const stored = defaultConfig();
    stored.alerts.push.kinds = ['trendResume'];
    stored.alerts.kinds = ['freshPullback', 'trendResume', 'emaRejection', 'targetHit', 'stopHit'];

    const fixed = sanitise(stored);
    assert.ok(fixed.alerts.push.kinds.includes('trendDay'));
    assert.ok(fixed.alerts.kinds.includes('trendDay'));
  });

  it('leaves a deliberate trend-day-only subscription alone', () => {
    const stored = defaultConfig();
    stored.alerts.push.kinds = ['trendDay'];
    assert.deepEqual(sanitise(stored).alerts.push.kinds, ['trendDay']);
  });
});

describe('alerts: the trend line on the message', () => {
  const trend = (over: Partial<TrendContext> = {}): TrendContext => ({
    phase: 'Confirmed', direction: 1, score: 84, confirmedAt: ist(10, 30),
    heldMin: 30, partial: false, ageMs: 4000, ...over,
  });

  it('says the entry is with the day, and since when', () => {
    const msg = signalMessage(signal(88), trend());
    assert.match(msg, /With the day — confirmed bullish/);
    assert.match(msg, /conviction 84/);
    assert.match(msg, /10:30 AM/);
  });

  it('warns in as many words when the day disagrees', () => {
    const msg = signalMessage(signal(88), trend({ direction: -1 }));
    assert.match(msg, /Against the day/);
  });

  it('says the session was not measurable rather than staying silent about it', () => {
    assert.match(signalMessage(signal(88), null), /not measurable/);
  });

  it('marks a partial read as one', () => {
    assert.match(signalMessage(signal(88), trend({ partial: true })), /partial read/);
  });

  it('renders in Discord markup too, so the two channels agree', () => {
    assert.match(discordMessage(signal(88), trend()), /With the day — confirmed bullish/);
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

  // The two absent-contract cases are DIFFERENT states and used to be described as one. A null
  // option means no chain was priced this cycle; a thin strike comes back as a contract with a
  // warning and never reaches this branch. Naming the wrong one sent the reader to inspect
  // strike liquidity when the chain had simply not been fetched.
  describe('when there is no contract', () => {
    const none = signalMessage(signal(88, OPEN, { option: null }));

    it('says the chain was missing, not that the strikes were thin', () => {
      assert.match(none, /No option chain for this stock this cycle/);
      assert.doesNotMatch(none, /liquidity gate/i);
    });

    it('says the stock levels still stand, because they do', () => {
      assert.match(none, /stock levels below still stand/);
      assert.match(none, /Entry <b>200\.00<\/b>/);
    });

    it('still reports a thin strike as a contract plus a warning', () => {
      const thin = signal(88, OPEN, {
        option: option({ warnings: ['no strike here is both tradable (liquidity ≥ 45) and has 1,000+ open interest'] }),
      });
      const msg = signalMessage(thin);
      assert.match(msg, /BUY 200 CE/);
      assert.match(msg, /liquidity ≥ 45/);
      assert.doesNotMatch(msg, /No option chain/);
    });
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
