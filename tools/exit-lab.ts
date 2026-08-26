// Exit-rule laboratory. Re-grades every journalled trade on its OWN 1-minute option candles under
// a set of alternative exit rules, so the choice of exit is made on evidence rather than instinct.
//
//   npx tsx tools/exit-lab.ts              every rule, on every real trade in the journal
//   npx tsx tools/exit-lab.ts --detail     also print the per-trade table for the winning rule
//
// THE PROBLEM IT EXISTS TO ANSWER. Of 65 real trades, 54 never touched either band and were handed
// to the 15:15 square-off; 17 of them had been up 15% or more at some point and still closed red,
// which is −₹67,340 of realised loss on positions that were, at some moment, winners. The median
// trade peaks 115 minutes after entry and then gives back 18 points. A fixed +80/−50 pair cannot
// see any of that, because it only ever looks at two price levels and never at the path between.
//
// HOW EVERY RULE IS GRADED, identically:
//
//   ONE MINUTE BAR CANNOT SAY WHETHER ITS HIGH OR ITS LOW CAME FIRST. Every rule therefore
//   resolves an ambiguous bar as the STOP, exactly as `gradePath` does in the shipped journal.
//   This matters most for the trailing rules, which would otherwise appear to sell every peak.
//
//   A TRAILING LEVEL IS COMPUTED FROM THE PREVIOUS BAR'S PEAK, never the current one. Letting a
//   bar both set a new high and be stopped out on the trail derived from that same high is how a
//   backtest invents money: in the real session the trail had not moved yet when the low printed.
//
//   COSTS ARE THE SAME FOR ALL OF THEM — ₹120 a lot round trip, deducted once per position. The
//   scale-out variants pay it twice, because two exits are two brokerage events.
//
// WHAT IT STILL CANNOT SEE. Fills are candle prices, so an exit is assumed to happen AT the level
// touched. A real stop or trail slips, and slippage hurts the rules that trade more often — the
// trailing and scale-out families — more than it hurts the passive ones. Treat the gaps between
// the top few rules as noise, not as a ranking.

import '../src/env.js';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionCandles } from '../src/upstox.js';
import { istDay } from '../src/momentum/session.js';
import { journalConfig } from '../src/momentum/journal/journal.js';
import { closePool, databaseUrl, getPool } from '../src/momentum/journal/postgres.js';
import type { JournalTrade } from '../src/momentum/journal/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache', 'momentum');
const BARS_CACHE = path.join(here, '..', '.cache', 'exit-lab-bars.json');
const BATCH = 8;

interface Bar { minute: number; open: number; high: number; low: number; close: number }

/* ------------------------------------------------------------------------- the rules --- */

interface Rule {
  name: string;
  note: string;
  /** Take-profit as a fraction of premium. Null = no fixed target. */
  tp: number | null;
  /** Initial stop, as a positive fraction. */
  sl: number;
  /** Once the position has been up this much, the stop moves. Null = never moves. */
  armAt?: number;
  /** Where the stop moves to once armed: 'breakeven', or trail this many points below the peak. */
  trail?: number | 'breakeven';
  /** Minute of session to close anything still open. */
  lastMinute: number;
  /** Book HALF at `tp` and run the rest under the trail. Needs 2+ lots to be real. */
  scaleOut?: boolean;
}

const SQ = 360;      // 15:15
const RULES: Rule[] = [
  { name: '+80/-50  @15:15', note: 'SHIPPED — what runs today', tp: 0.80, sl: 0.50, lastMinute: SQ },
  { name: '+30/-50  @15:15', note: 'lower target, same stop', tp: 0.30, sl: 0.50, lastMinute: SQ },
  { name: '+50/-50  @15:15', note: 'middle target', tp: 0.50, sl: 0.50, lastMinute: SQ },
  { name: 'BE after +20%', note: 'stop to entry once up 20%', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 'breakeven', lastMinute: SQ },
  { name: 'BE after +25%', note: 'stop to entry once up 25%', tp: 0.80, sl: 0.50, armAt: 0.25, trail: 'breakeven', lastMinute: SQ },
  { name: 'trail 15 after +20%', note: 'give back at most 15 pts', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 0.15, lastMinute: SQ },
  { name: 'trail 20 after +25%', note: 'give back at most 20 pts', tp: 0.80, sl: 0.50, armAt: 0.25, trail: 0.20, lastMinute: SQ },
  { name: 'trail 25 after +30%', note: 'give back at most 25 pts', tp: 0.80, sl: 0.50, armAt: 0.30, trail: 0.25, lastMinute: SQ },
  { name: 'trail 20 after +20%', note: 'tighter arm, 20 pt leash', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 0.20, lastMinute: SQ },
  { name: '+30/-50  @14:00', note: 'lower target, earlier close', tp: 0.30, sl: 0.50, lastMinute: 285 },
  { name: '+80/-50  @14:00', note: 'same bands, earlier close', tp: 0.80, sl: 0.50, lastMinute: 285 },
  { name: '+80/-50  @12:00', note: 'close at midday', tp: 0.80, sl: 0.50, lastMinute: 165 },
  { name: 'half +30, trail 20', note: 'scale out — needs 2 lots', tp: 0.30, sl: 0.50, armAt: 0.20, trail: 0.20, lastMinute: SQ, scaleOut: true },
];

/* ------------------------------------------------------------------------ the grader --- */

interface Graded { pct: number; out: string; minute: number }

/**
 * Walk one option's session under one rule.
 *
 * Returns the return on premium, so the caller can multiply by whatever the position cost.
 */
function grade(bars: Bar[], paid: number, fromMinute: number, r: Rule): Graded {
  let peak = 0;                       // best return seen on a COMPLETED bar
  let booked = 0;                     // realised half, for scale-out
  let half = false;                   // has the first half been sold
  let lastClose = paid, lastMin = fromMinute;

  for (const b of bars) {
    if (b.minute <= fromMinute || b.minute > r.lastMinute) continue;
    const up = (b.high - paid) / paid;
    const down = (b.low - paid) / paid;

    // The stop in force for THIS bar, derived from the peak as it stood before this bar.
    let stop = -r.sl;
    if (r.armAt !== undefined && r.trail !== undefined && peak >= r.armAt) {
      stop = r.trail === 'breakeven' ? 0 : Math.max(-r.sl, peak - r.trail);
    }

    // Stop first: an ambiguous bar is always the stop.
    if (down <= stop) {
      const exit = half ? booked + 0.5 * stop : stop;
      return { pct: exit, out: half ? 'trail after half' : (stop >= 0 ? (stop > 0 ? 'trailed' : 'breakeven') : 'stop'), minute: b.minute };
    }
    if (r.tp !== null && up >= r.tp) {
      if (!r.scaleOut) return { pct: r.tp, out: 'target', minute: b.minute };
      if (!half) { half = true; booked = 0.5 * r.tp; }   // first half away, rest keeps running
    }

    if (up > peak) peak = up;
    lastClose = b.close; lastMin = b.minute;
  }

  const end = (lastClose - paid) / paid;
  return {
    pct: half ? booked + 0.5 * end : end,
    out: half ? 'half + close' : 'square-off',
    minute: lastMin,
  };
}

/* ------------------------------------------------------------------------ the loading --- */

async function loadTrades(): Promise<JournalTrade[]> {
  const out: JournalTrade[] = [];
  for (const f of (await fs.readdir(CACHE)).filter((x) => /^journal_\d{4}-\d{2}\.json$/.test(x))) {
    const doc = JSON.parse(await fs.readFile(path.join(CACHE, f), 'utf8')) as { trades: JournalTrade[] };
    out.push(...doc.trades);
  }
  return out
    .filter((t) => t.contract && t.entry.premium > 0 && t.exit?.reason !== 'untracked')
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.entry.at - b.entry.at));
}

/**
 * Archived paths for these trades, preferring the shared store over local disk.
 *
 * Neon first because it is the copy both machines see and the one that survives a reinstall; the
 * local month documents are the fallback when there is no database or it cannot be reached.
 */
async function readArchive(trades: JournalTrade[]): Promise<Map<string, Array<[number, number, number, number]>>> {
  const out = new Map<string, Array<[number, number, number, number]>>();
  const months = [...new Set(trades.map((t) => t.day.slice(0, 7)))];

  if (databaseUrl()) {
    try {
      const ids = trades.map((t) => t.id);
      const days = [...new Set(trades.map((t) => t.day))];
      const { rows } = await getPool().query<{ day: string; instrument_key: string; bars: Array<[number, number, number, number]> }>(
        `SELECT day::text AS day, instrument_key, bars FROM momentum_option_path
          WHERE day = ANY($1::date[]) AND role = 'traded'`,
        [days],
      );
      for (const r of rows) {
        const t = trades.find((x) => x.day === r.day && x.contract?.instrumentKey === r.instrument_key);
        if (t && ids.includes(t.id)) out.set(t.id, r.bars);
      }
    } catch { /* fall through to disk */ }
  }

  for (const m of months) {
    const file = path.join(CACHE, `journal_paths_${m}.json`);
    const doc = await fs.readFile(file, 'utf8')
      .then((t) => JSON.parse(t) as Record<string, Array<[number, number, number, number]>>)
      .catch(() => null);
    if (!doc) continue;
    for (const [id, bars] of Object.entries(doc)) if (!out.has(id)) out.set(id, bars);
  }
  return out;
}

/**
 * Candles for every trade, from the archive where possible and the network otherwise.
 *
 * Cached hard because these are expired contracts on finished sessions: the answer cannot change,
 * and re-fetching 65 contracts on every tweak to a rule wastes quota for no information.
 */
async function loadBars(trades: JournalTrade[]): Promise<Map<string, Bar[]>> {
  const cached = await fs.readFile(BARS_CACHE, 'utf8')
    .then((t) => new Map(Object.entries(JSON.parse(t) as Record<string, Bar[]>)))
    .catch(() => new Map<string, Bar[]>());

  // THE ARCHIVE FIRST, ALWAYS. Fetching is the fallback, not the source: Upstox rejects the
  // instrument key of any expired series outright, so for anything older than the current expiry
  // cycle the network has no answer and the archive is the only one there is. The first cut of
  // this tool fetched first and found candles for 4 of 65 trades.
  let fromArchive = 0;
  for (const [id, bars] of await readArchive(trades)) {
    const t = trades.find((x) => x.id === id);
    if (!t?.contract) continue;
    const key = `${t.day}:${t.contract.instrumentKey}`;
    if (cached.has(key)) continue;
    cached.set(key, bars.map(([minute, high, low, close]) => ({ minute, open: close, high, low, close })));
    fromArchive++;
  }
  if (fromArchive) console.log(`  ${fromArchive} paths read from the archive`);

  const today = istDay(Date.now());
  const todo = trades.filter((t) => !cached.has(`${t.day}:${t.contract!.instrumentKey}`));
  if (todo.length) {
    console.log(`  fetching candles for ${todo.length} contracts not in the archive…`);
    for (let i = 0; i < todo.length; i += BATCH) {
      await Promise.all(todo.slice(i, i + BATCH).map(async (t) => {
        const key = t.contract!.instrumentKey;
        const dayStart = Date.parse(`${t.day}T00:00:00Z`) + (9 * 60 + 15 - 330) * 60_000;
        try {
          const raw = await sessionCandles(key, t.day, today, 'minutes', 1);
          cached.set(`${t.day}:${key}`, raw
            .map((c) => ({
              minute: Math.round((c[0] * 1000 - dayStart) / 60_000),
              open: c[1], high: c[2], low: c[3], close: c[4],
            }))
            .filter((b) => b.minute >= 0 && b.minute < 375)
            .sort((a, b) => a.minute - b.minute));
        } catch {
          cached.set(`${t.day}:${key}`, []);
        }
      }));
      process.stdout.write(`\r  ${Math.min(i + BATCH, todo.length)}/${todo.length}   `);
    }
    console.log();
    await fs.writeFile(BARS_CACHE, JSON.stringify(Object.fromEntries(cached)), 'utf8');
  }
  return cached;
}

/* --------------------------------------------------------------------------- reporting --- */

const inr = (n: number): string => (n < 0 ? '-Rs ' : 'Rs ') + Math.round(Math.abs(n)).toLocaleString('en-IN');

async function main(): Promise<void> {
  const cfg = journalConfig();
  const trades = await loadTrades();
  const bars = await loadBars(trades);

  const usable = trades.filter((t) => (bars.get(`${t.day}:${t.contract!.instrumentKey}`) ?? []).length > 0);
  console.log(`\n  Exit lab — ${usable.length} of ${trades.length} trades have candles\n`);
  if (!usable.length) { console.error('  no candles could be fetched.\n'); return; }

  const results: Array<{ rule: Rule; net: number; wins: number; n: number; worst: number; best: number; maxDD: number; outs: Record<string, number> }> = [];

  for (const r of RULES) {
    let net = 0, wins = 0, worst = 0, best = 0;
    const outs: Record<string, number> = {};
    const byDay = new Map<string, number>();

    for (const t of usable) {
      const b = bars.get(`${t.day}:${t.contract!.instrumentKey}`)!;
      const g = grade(b, t.entry.premium, t.entry.minute, r);
      // Scale-out is two round trips, so it pays the charge twice.
      const charge = cfg.chargePerLot * t.lots * (r.scaleOut ? 2 : 1);
      const pnl = g.pct * (t.amountUsed ?? 0) - charge;
      net += pnl;
      if (pnl > 0) wins++;
      if (pnl < worst) worst = pnl;
      if (pnl > best) best = pnl;
      outs[g.out] = (outs[g.out] ?? 0) + 1;
      byDay.set(t.day, (byDay.get(t.day) ?? 0) + pnl);
    }

    let eq = 0, high = 0, maxDD = 0;
    for (const d of [...byDay.keys()].sort()) {
      eq += byDay.get(d)!;
      if (eq > high) high = eq;
      if (high - eq > maxDD) maxDD = high - eq;
    }
    results.push({ rule: r, net, wins, n: usable.length, worst, best, maxDD, outs });
  }

  const base = results[0].net;
  results.sort((a, b) => b.net - a.net);

  console.log('  rule                      net        vs shipped   win%    worst trade   max DD');
  console.log('  ' + '-'.repeat(86));
  for (const x of results) {
    const delta = x.net - base;
    console.log(
      `  ${x.rule.name.padEnd(22)} ${inr(x.net).padStart(11)}  ${(delta === 0 ? '—' : (delta > 0 ? '+' : '') + inr(delta)).padStart(11)}  ` +
      `${((100 * x.wins) / x.n).toFixed(1).padStart(5)}%  ${inr(x.worst).padStart(11)}  ${inr(-x.maxDD).padStart(11)}`,
    );
  }
  console.log('  ' + '-'.repeat(86));
  console.log(`  ${usable.length} trades · charges Rs ${cfg.chargePerLot}/lot (scale-out pays twice) · stop wins every ambiguous minute\n`);

  const top = results[0];
  console.log(`  Best: ${top.rule.name} — ${top.rule.note}`);
  console.log(`  exits: ${Object.entries(top.outs).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);

  if (process.argv.includes('--detail')) {
    console.log('  per-trade, best rule vs shipped:\n');
    console.log('   day         symbol        peak      shipped      best rule');
    for (const t of usable) {
      const b = bars.get(`${t.day}:${t.contract!.instrumentKey}`)!;
      const g0 = grade(b, t.entry.premium, t.entry.minute, RULES[0]);
      const g1 = grade(b, t.entry.premium, t.entry.minute, top.rule);
      const p0 = g0.pct * (t.amountUsed ?? 0) - cfg.chargePerLot * t.lots;
      const p1 = g1.pct * (t.amountUsed ?? 0) - cfg.chargePerLot * t.lots * (top.rule.scaleOut ? 2 : 1);
      console.log(`   ${t.day}  ${t.symbol.padEnd(12)} ${((100 * (t.mfePct ?? 0)).toFixed(0) + '%').padStart(5)}  ${inr(p0).padStart(11)}  ${inr(p1).padStart(11)}  ${p1 > p0 ? '+' : p1 < p0 ? '-' : '='}`);
    }
    console.log();
  }
}

main().then(() => closePool()).catch((e) => { console.error(e); process.exit(1); });
