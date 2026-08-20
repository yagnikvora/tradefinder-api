// Post a backtest signal log to the Discord channel.
//
// The same webhook the live alerts use, so every message here is prefixed BACKTEST and carries
// the session date in its first line. A replayed signal that reads like a live one is the single
// worst thing this script could produce.

import '../src/env.js';
import { execFileSync } from 'node:child_process';
import { sendDiscord, discordConfigured, checkDiscord } from '../src/alerts/discord.js';

const DAYS = process.argv.slice(2);
if (!DAYS.length) { console.error('usage: to-discord.ts 2026-08-10 2026-08-11 ...'); process.exit(1); }

interface Sig {
  day: string; signalTime: string; entryTime: string; symbol: string; side: string;
  strike: number; entry: number; prevClose: number; open: number; vwap: number; atr: number;
  atrPct: number; rvol: number; rangeAtr: number; moveAtr: number; offAtr: number;
  half: string; full: string; stop: string;
  best: number; bestPct: number; bestAt: string; worst: number; worstPct: number;
  events: Array<{ at: string; what: string; px: number }>; ret: number;
}

const raw = execFileSync(process.execPath, ['research/emit-json.mjs', ...DAYS], {
  cwd: process.cwd(),
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const byDay: Record<string, Sig[]> = JSON.parse(raw);

const px = (v: number): string =>
  `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pc = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const dayLabel = (d: string): string =>
  new Date(`${d}T06:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function block(s: Sig): string {
  const arrow = s.side === 'CALL' ? '🟢' : '🔴';
  const out = [
    `${arrow} **${s.symbol}** — ${s.side === 'CALL' ? 'BUY CALL' : 'BUY PUT'} \`${s.strike} ${s.side === 'CALL' ? 'CE' : 'PE'}\` *(monthly)*`,
    `　signal **${s.signalTime}** · entry **${px(s.entry)}** at ${s.entryTime}`,
    `　why: RVOL **${s.rvol.toFixed(1)}×** · range **${s.rangeAtr.toFixed(2)} ATR** by ${s.signalTime} · **${s.moveAtr.toFixed(2)} ATR** from open ${px(s.open)} · ${s.offAtr.toFixed(2)} ATR off the ${s.side === 'CALL' ? 'high' : 'low'}`,
    `　prev close ${px(s.prevClose)} · VWAP ${px(s.vwap)} · ATR ${px(s.atr)} (${s.atrPct.toFixed(2)}%)`,
    `　levels: half out ~**${s.half}** · rest out ~**${s.full}** · stop ~**${s.stop}**`,
    `　path: best ${px(s.best)} at ${s.bestAt} (${pc(s.bestPct)}) · worst ${px(s.worst)} (${pc(s.worstPct)})`,
  ];
  for (const e of s.events) out.push(`　→ ${e.at}  ${e.what} — stock ${px(e.px)}`);
  out.push(`　**RESULT ${pc(s.ret)}** on the premium`);
  return out.join('\n');
}

async function main(): Promise<void> {
  if (!discordConfigured()) { console.error('DISCORD_WEBHOOK_URL is not set'); process.exit(1); }
  if (!(await checkDiscord())) { console.error('webhook unreachable'); process.exit(1); }

  const all = DAYS.flatMap((d) => byDay[d] ?? []);
  const wins = all.filter((s) => s.ret > 0).length;
  const total = all.reduce((a, s) => a + s.ret, 0);

  const header = [
    '📋 **BACKTEST — First-Hour Displacement rule**',
    `*Replayed, not live. Sessions ${dayLabel(DAYS[0])} to ${dayLabel(DAYS[DAYS.length - 1])}.*`,
    '',
    'Scan 09:27–10:00 · RVOL 5–50× · range ≥1.0 ATR · ≥0.5 ATR from open · ≤0.35 ATR off the extreme · turnover ≥₹100cr · max 4/day',
    'Buy ATM monthly. Half out at +30%, stop to breakeven, rest to +80% or 15:15. Hard stop −50%.',
    '',
    `**${all.length} signals over ${DAYS.length} sessions · ${wins} profitable (${Math.round((100 * wins) / all.length)}%) · total ${pc(total)} · average ${pc(total / all.length)}**`,
    '',
    '_Option prices are modelled, not quoted — check them against the real chain._',
  ].join('\n');

  const messages: Array<{ text: string; dir?: 1 | -1 }> = [{ text: header }];
  for (const d of DAYS) {
    const sigs = byDay[d] ?? [];
    if (!sigs.length) { messages.push({ text: `**${dayLabel(d)}** — no signal. Nothing cleared the rule.` }); continue; }
    const tot = sigs.reduce((a, s) => a + s.ret, 0);
    // One message per session. Split if a busy day overflows the embed budget.
    let buf = `**${dayLabel(d)}** — ${sigs.length} signal${sigs.length === 1 ? '' : 's'}, session total **${pc(tot)}**\n`;
    for (const s of sigs) {
      const b = `\n${block(s)}\n`;
      if (buf.length + b.length > 3800) { messages.push({ text: buf }); buf = `**${dayLabel(d)}** *(continued)*\n`; }
      buf += b;
    }
    messages.push({ text: buf, dir: tot >= 0 ? 1 : -1 });
  }

  let sent = 0;
  for (const m of messages) {
    const ok = await sendDiscord(m.text, m.dir);
    if (ok) sent++; else console.error('  a message was refused');
    await new Promise((r) => setTimeout(r, 1200));   // webhooks throttle at ~5 per 2s
  }
  console.log(`sent ${sent}/${messages.length} messages to Discord`);
}

main().catch((e) => { console.error(e); process.exit(1); });
