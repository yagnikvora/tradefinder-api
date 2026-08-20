// npx tsx tools/displacement-preview.ts 2026-08-20 [--send]
//
// Replay a finished session through the LIVE displacement alert and print what your phone would
// have received. The point is fidelity: `selectDisplacement` and `buildMessage` are imported from
// the shipped module rather than reimplemented, so if this disagrees with the research the shipped
// code is what is wrong.
//
// Quotes are rebuilt from cached 1-minute bars in `research/data/min/`, and the volume profile,
// ATR and average traded value come from the baseline on disk. Both are local, so this costs no
// Upstox quota and can be run repeatedly while tuning the environment knobs.
//
// `--send` posts the first signal to the configured channels, so the message format can be
// checked on the actual phone before a live morning depends on it.

import '../src/env.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { getBaseline } from '../src/momentum/data/baseline.js';
import { configRepository } from '../src/momentum/config/config.repository.js';
import { universe } from '../src/momentum/data/universe.js';
import {
  buildMessage, exits, rule, selectDisplacement,
  type DisplacementCandidate, type DisplacementInput,
} from '../src/momentum/alerts/displacement.js';
import { HTML, MARKDOWN } from '../src/alerts/markup.js';
import { sendTelegram, telegramConfigured } from '../src/alerts/telegram.js';
import { discordConfigured, sendDiscord } from '../src/alerts/discord.js';
import type { MomentumQuote } from '../src/momentum/data/quotes.js';

const MIN_DIR = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'research', 'data', 'min');
const clock = (m: number): string => {
  const t = 555 + m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

type Bar = [number, number, number, number, number, number];

/** Running per-minute state for one symbol: the fields the alert reads off a live quote. */
interface Series {
  ltp: Float64Array;
  high: Float64Array;
  low: Float64Array;
  vwap: Float64Array;
  volume: Float64Array;
  open: number;
}

function series(bars: Bar[]): Series | null {
  if (!bars.length) return null;
  const n = 376;
  const ltp = new Float64Array(n), high = new Float64Array(n), low = new Float64Array(n);
  const vwap = new Float64Array(n), volume = new Float64Array(n);
  const byMin = new Map(bars.map((b) => [b[0], b]));
  let pv = 0, cv = 0, hi = -Infinity, lo = Infinity, last: Bar | undefined;
  for (let m = 0; m < n; m++) {
    const b = byMin.get(m);
    if (b) {
      last = b;
      pv += ((b[2] + b[3] + b[4]) / 3) * b[5];
      cv += b[5];
      hi = Math.max(hi, b[2]);
      lo = Math.min(lo, b[3]);
    }
    if (!last) continue;
    ltp[m] = last[4];
    high[m] = hi;
    low[m] = lo;
    volume[m] = cv;
    vwap[m] = cv > 0 ? pv / cv : last[4];
  }
  return { ltp, high, low, vwap, volume, open: bars[0][1] };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!day) {
    console.error('usage: npx tsx tools/displacement-preview.ts 2026-08-20 [--send]');
    process.exit(1);
  }

  const cfg = await configRepository.get();
  const { baseline } = await getBaseline();
  if (!baseline) { console.error('no baseline on disk — run the morning build first'); process.exit(1); }
  const uni = await universe();
  const r = rule();
  const e = exits();

  console.log(`\nreplaying ${day} through the live displacement alert`);
  console.log(`baseline on disk is for ${baseline.day}${baseline.day === day ? '' : '  <-- NOT this session, ATR and volume profile will be off'}`);
  console.log(`window ${clock(r.fromMinute)}-${clock(r.toMinute)} · RVOL ${r.minRvol}-${r.maxRvol}x · range >= ${r.minRangeAtr} ATR · move >= ${r.minMoveAtr} ATR · within ${r.maxOffExtremeAtr} ATR of the extreme · turnover >= ${r.minTurnoverCr}cr · max ${r.maxPerDay}/day`);
  console.log(`exits +${100 * e.first}% / +${100 * e.second}% / −${100 * e.stop}%\n`);

  // Load every symbol's session once.
  const loaded = new Map<string, Series>();
  let missing = 0;
  for (const m of uni.members) {
    const path = join(MIN_DIR, `${m.symbol}.json`);
    if (!existsSync(path)) { missing++; continue; }
    const file = JSON.parse(readFileSync(path, 'utf8')) as { days: Record<string, Bar[]> };
    const bars = file.days[day];
    if (!bars || bars.length < 60) { missing++; continue; }
    const s = series(bars);
    if (s) loaded.set(m.symbol, s);
  }
  console.log(`${loaded.size} symbols loaded from the local cache${missing ? `, ${missing} without bars for this day` : ''}\n`);

  // Walk the window a minute at a time, exactly as a live scan would arrive at it.
  const announced = new Set<string>();
  const fired: Array<{ minute: number; candidate: DisplacementCandidate }> = [];
  for (let minute = r.fromMinute; minute <= r.toMinute && announced.size < r.maxPerDay; minute++) {
    const inputs: DisplacementInput[] = [];
    for (const [symbol, s] of loaded) {
      if (!s.ltp[minute]) continue;
      const b = baseline.symbols[symbol];
      const profile = b?.profile;
      const expected = profile && minute < profile.length ? profile[minute] : 0;
      const member = uni.bySymbol.get(symbol);
      const quote = {
        symbol,
        instrumentKey: member?.equityKey ?? '',
        ltp: s.ltp[minute],
        prevClose: b?.prevClose ?? 0,
        netChange: 0,
        changePct: b?.prevClose ? ((s.ltp[minute] - b.prevClose) / b.prevClose) * 100 : 0,
        open: s.open,
        high: s.high[minute],
        low: s.low[minute],
        volume: s.volume[minute],
        vwap: s.vwap[minute],
        turnoverCr: (s.vwap[minute] * s.volume[minute]) / 1e7,
        openInterest: 0, oiDayHigh: 0, oiDayLow: 0,
        totalBuyQty: 0, totalSellQty: 0,
        bid: 0, ask: 0, bidQty: 0, askQty: 0, bidOrders: 0, askOrders: 0,
        depthCr: 0, hasBook: false, at: 0,
      } as unknown as MomentumQuote;

      inputs.push({
        symbol,
        equityKey: member?.equityKey ?? '',
        quote,
        atr: b?.atr ?? null,
        avgDailyValueCr: b?.avgDailyValueCr ?? null,
        rvol: expected > 0 ? s.volume[minute] / expected : null,
        lotSize: member?.future?.lotSize ?? null,
      });
    }

    const picked = selectDisplacement(inputs, announced, minute, r).slice(0, r.maxPerDay - announced.size);
    for (const c of picked) {
      announced.add(c.symbol);
      // No chain for a past session, so the message renders its no-contract branch. That is the
      // same branch a live tick takes when the chain request fails, so it is worth seeing.
      fired.push({ minute, candidate: c });
      console.log(`${'─'.repeat(94)}`);
      console.log(`${clock(minute)}  ${c.symbol}  ${c.direction === 1 ? 'BUY CALL' : 'BUY PUT'}  entry ₹${c.entry.toFixed(2)}`);
      console.log(`   RVOL ${c.rvol.toFixed(1)}x · range ${c.rangeAtr} ATR · move ${c.moveAtr} ATR · ${c.offExtremeAtr} ATR off the ${c.direction === 1 ? 'high' : 'low'}`);
      console.log(`   ATR ₹${c.atr.toFixed(2)} · VWAP ₹${c.vwap.toFixed(2)} · open ₹${c.open.toFixed(2)} · turnover ₹${c.turnoverCr.toFixed(0)}cr`);
    }
  }

  console.log(`${'─'.repeat(94)}`);
  console.log(`\n${fired.length} signal${fired.length === 1 ? '' : 's'} for ${day}\n`);
  if (fired.length) {
    console.log('the message, as it would arrive:\n');
    console.log(
      buildMessage(fired[0].candidate, null, MARKDOWN, Date.now())
        .split('\n')
        .map((l: string) => `    ${l}`)
        .join('\n'),
    );
  }

  if (send && fired.length) {
    if (!telegramConfigured() && !discordConfigured()) { console.log('\nno channel configured, nothing sent'); return; }
    // Rendered separately per channel: the two markups differ, and a Discord embed carrying
    // Telegram's HTML is exactly the bug the `Markup` pair exists to prevent.
    const c = fired[0].candidate;
    const note = `PREVIEW — displacement alert format check, replaying ${day}. Not a live signal.`;
    if (discordConfigured())
      await sendDiscord(`🧪 *${note}*\n\n${buildMessage(c, null, MARKDOWN, Date.now())}`, c.direction);
    if (telegramConfigured())
      await sendTelegram(`🧪 <i>${note}</i>\n\n${buildMessage(c, null, HTML, Date.now())}`);
    console.log('\npreview sent to the configured channels');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
