// Send a demo trade alert to every configured phone channel.  Run: npm run demo-alert
//
//   npm run demo-alert              a CALL, a PUT, and a trend-day entry
//   npm run demo-alert -- call      just the long
//   npm run demo-alert -- put       just the short
//   npm run demo-alert -- trendday  just the trend-day-confirmed entry, with its label
//
// Exists because the real thing cannot be summoned: a live alert needs a Strong-or-better
// confirmed pullback during market hours, so without this there is no way to see what one looks
// like on your phone, check the formatting survived a change, or show somebody else what they
// have been added to — except by waiting for the market and hoping.
//
// It goes through the REAL senders and the REAL message builder, so what arrives is what a live
// alert will look like, down to the byte. What it deliberately does NOT go through is `emit()` —
// no market-hours gate, no dedupe, no confidence floor, and nothing is written to the alert ring.
// This is a plumbing and formatting check, not an alert.
//
// EVERY MESSAGE IS STAMPED AS A DEMO. Not decoration: the Telegram chat is very likely a group by
// now, and an unlabelled fake signal that reads exactly like a real one is something a person can
// trade. The banner is the difference between a demo and a fabricated trade instruction.

import '../src/env.js';
import type { PullbackSignal, TrendContext } from '../src/pullback/types.js';
import { sendTelegram, telegramConfigured, telegramStatus, signalMessage as tgMessage } from '../src/pullback/alerts/telegram.js';
import { sendDiscord, discordConfigured, discordStatus, signalMessage as dcMessage } from '../src/pullback/alerts/discord.js';

/** Today's date at an IST wall-clock time, so the "fired" stamp reads plausibly. */
const istToday = (hh: number, mm: number): number => {
  const now = new Date(Date.now() + 330 * 60_000);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm) - 330 * 60_000;
};

/** A long: buy a CALL. Numbers are realistic rather than round, because round numbers read as fake. */
const CALL = {
  symbol: 'TATAMOTORS', timeframe: 5, direction: 1, side: 'BUY', entryKind: 'pullback',
  firedAt: istToday(10, 45), entry: 742.30, price: 744.15, ageMin: 2, movedSincePct: 0.25,
  score: { total: 82, band: 'Strong', components: [], coverage: 1 },
  stop: { candidates: [], recommended: { kind: 'structure', price: 733.80, reason: 'below the pullback low' } },
  target: { candidates: [], primary: { kind: '2R', price: 759.30, r: 2 }, rewardRisk: 2 },
  option: {
    label: '740 CE', side: 'CE', strike: 740, expiry: '2026-08-27', expiryDays: 20,
    entryCost: 12.85, delta: 0.41, lotSize: 550, costPerLot: 7068,
    premiumAtTarget: 19.90, gainPctAtTarget: 55, profitPerLot: 3877, breakEven: 752.85,
    liquidity: { score: 84, grade: 'Excellent', components: {}, reasons: [] }, warnings: [],
  },
} as unknown as PullbackSignal;

/** A short: buy a PUT. Carries a liquidity warning, because that line is worth seeing at least once. */
const PUT = {
  symbol: 'INDUSINDBK', timeframe: 15, direction: -1, side: 'SELL', entryKind: 'pullback',
  firedAt: istToday(13, 15), entry: 968.40, price: 966.05, ageMin: 4, movedSincePct: 0.24,
  score: { total: 76, band: 'Strong', components: [], coverage: 1 },
  stop: { candidates: [], recommended: { kind: 'swing', price: 979.20, reason: 'above the pullback high' } },
  target: { candidates: [], primary: { kind: '2R', price: 946.80, r: 2 }, rewardRisk: 2 },
  option: {
    label: '970 PE', side: 'PE', strike: 970, expiry: '2026-08-27', expiryDays: 20,
    entryCost: 18.40, delta: -0.44, lotSize: 500, costPerLot: 9200,
    premiumAtTarget: 28.90, gainPctAtTarget: 57, profitPerLot: 5250, breakEven: 951.60,
    liquidity: { score: 66, grade: 'Good', components: {}, reasons: [] },
    warnings: ['the book is 1.10 wide — 6.0% of the premium'],
  },
} as unknown as PullbackSignal;

/**
 * A confirmed one-sided session, so the `trendDay` label renders.
 *
 * The other two demos pass no trend at all, which is the honest thing for them — a canned signal
 * has no live board behind it — and it is also why neither of them could ever show what the
 * trend-day badge looks like. This one carries a reading a real Confirmed row would have: a high
 * conviction, a confirmation time earlier in the session, and a fresh board age.
 */
const TREND_DAY_CONTEXT: TrendContext = {
  phase: 'Confirmed',
  direction: 1,
  score: 91,
  confirmedAt: istToday(9, 52),
  heldMin: 68,
  partial: false,
  ageMs: 12_000,
};

/** A long taken WITH a confirmed bullish trend day — the strictest thing the module emits. */
const TREND_DAY = {
  symbol: 'CGPOWER', timeframe: 5, direction: 1, side: 'BUY', entryKind: 'pullback',
  firedAt: istToday(11, 0), entry: 874.25, price: 875.10, ageMin: 1, movedSincePct: 0.10,
  score: { total: 93, band: 'Excellent', components: [], coverage: 1 },
  stop: { candidates: [], recommended: { kind: 'structure', price: 871.97, reason: 'below the pullback low' } },
  target: { candidates: [], primary: { kind: '2R', price: 878.81, r: 2 }, rewardRisk: 2 },
  option: {
    label: '900 CE', side: 'CE', strike: 900, expiry: '2026-08-27', expiryDays: 20,
    entryCost: 13.65, delta: 0.35, lotSize: 850, costPerLot: 11603,
    premiumAtTarget: 20.10, gainPctAtTarget: 47, profitPerLot: 5483, breakEven: 913.65,
    liquidity: { score: 79, grade: 'Good', components: {}, reasons: [] }, warnings: [],
  },
} as unknown as PullbackSignal;

const which = (process.argv[2] ?? '').toLowerCase();
const picked: Array<[string, PullbackSignal, TrendContext | null]> =
  which === 'call' ? [['CALL', CALL, null]]
    : which === 'put' ? [['PUT', PUT, null]]
      : which === 'trendday' || which === 'trend' ? [['TREND', TREND_DAY, TREND_DAY_CONTEXT]]
        : [['CALL', CALL, null], ['PUT', PUT, null], ['TREND', TREND_DAY, TREND_DAY_CONTEXT]];

if (!telegramConfigured() && !discordConfigured()) {
  console.error(
    '\n  No phone channel is configured.\n\n' +
    '  Put at least one of these in api/.env:\n\n' +
    '      PULLBACK_TELEGRAM_BOT_TOKEN=<from @BotFather>\n' +
    '      PULLBACK_TELEGRAM_CHAT_ID=<your chat or group id>\n' +
    '      PULLBACK_DISCORD_WEBHOOK_URL=<channel -> Integrations -> Webhooks>\n\n' +
    '  See the setup notes in api/.env.example.\n',
  );
  process.exit(1);
}

console.log(`\n  Telegram: ${telegramConfigured() ? 'configured' : 'not configured — skipping'}`);
console.log(`  Discord:  ${discordConfigured() ? 'configured' : 'not configured — skipping'}\n`);

const BANNER_TG = '🧪 <b>DEMO — not a live signal.</b> Sent by <code>npm run demo-alert</code>.\n\n';
const BANNER_DC = '🧪 **DEMO — not a live signal.** Sent by `npm run demo-alert`.\n\n';

let failed = 0;

for (const [label, signal, trend] of picked) {
  const results: string[] = [];

  if (telegramConfigured()) {
    const ok = await sendTelegram(BANNER_TG + tgMessage(signal, trend));
    results.push(`telegram ${ok ? 'sent' : `FAILED — ${telegramStatus().lastError ?? 'unknown'}`}`);
    if (!ok) failed++;
  }
  if (discordConfigured()) {
    // The direction only picks the embed's colour stripe: green for a long, red for a short.
    const ok = await sendDiscord(BANNER_DC + dcMessage(signal, trend), signal.direction);
    results.push(`discord ${ok ? 'sent' : `FAILED — ${discordStatus().lastError ?? 'unknown'}`}`);
    if (!ok) failed++;
  }

  console.log(`  ${label.padEnd(5)} ${signal.symbol.padEnd(12)} ${results.join('  ·  ')}`);
}

console.log(
  failed
    ? `\n  ${failed} send(s) failed — see the error above.\n`
    : '\n  Done. Check your phone.\n',
);
process.exit(failed ? 1 : 0);
