// npm run research-pullback — measure the pullback strategy over real history, and A/B it.
//
// The scanner's gates were chosen from the brief and from desk convention. This tool is what
// turns them into measured numbers: it fetches 1-minute candles ONCE per symbol, caches them on
// disk, and then replays `replay()` — the same functions the live scanner calls — over the
// identical bar array for as many configs as asked. Two configs compared this way differ only in
// the config; nothing else can move.
//
// The comparison that matters is not "did the win rate go up". A gate that refuses everything has
// a wonderful win rate over three trades. What is reported is TOTAL R and expectancy alongside the
// count, so a change that buys 4% of win rate by refusing half the sample shows up as the loss it
// is.
//
// Usage:
//   tsx tools/pullback-research.ts [--days 120] [--symbols 30] [--tf 3,5,15] [--variant name]

import '../src/env.js';

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { tokenSet } from '../src/upstox.js';
import { dbEnabled } from '../src/db/pool.js';
import { bySession, readRange, writeDays } from '../src/db/candle.archive.js';
import { historical } from '../src/momentum/data/candles.js';
import { isoDaysBefore, istDay, SESSION_MINUTES } from '../src/momentum/session.js';
import { configRepository } from '../src/pullback/config/config.repository.js';
import { universe } from '../src/pullback/data/universe.js';
import { replay } from '../src/pullback/backtest/backtest.engine.js';
import { fromCandle, type Bar } from '../src/pullback/indicators/series.js';
import type { BacktestTrade, PullbackConfig, Timeframe } from '../src/pullback/types.js';
import { VARIANTS } from './research-variants.js';

const CACHE_DIR = join(process.cwd(), '.cache', 'research');
const MAX_RANGE_DAYS = 28;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const pad = (s: string, n: number) => String(s).padEnd(n).slice(0, n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const hr = (t: string) => console.log(`\n${'─'.repeat(96)}\n${t}\n${'─'.repeat(96)}`);

/* ------------------------------------------------------------------------- candles --- */

/**
 * One symbol's 1-minute history: the archive first, then disk, then Upstox.
 *
 * THE ARCHIVE IS TRIED FIRST BECAUSE IT IS KEYED CORRECTLY. The disk cache below is keyed by
 * `SYMBOL_from_to.json` — the date RANGE the sweep happened to ask for — so changing `--days`
 * from 120 to 180 orphans every file and re-fetches history already paid for. The archive is
 * keyed by symbol and session, so the same change costs only the sessions genuinely missing.
 *
 * It also accumulates. A backtest window is limited by what has been archived rather than by
 * what Upstox will serve in one range, which is the whole point of `npm run db:archive`.
 */
async function oneMinute(
  symbol: string,
  key: string,
  from: string,
  to: string,
  cachedOnly: boolean,
): Promise<Bar[]> {
  if (dbEnabled()) {
    try {
      const held = await readRange(symbol, from, to);
      // A partial answer is not usable: a window with silent holes replays as a real sample and
      // reports a confident number from half the sessions. Anything short falls through to the
      // fetch below, which fills the archive on its way past.
      if (held.length >= MIN_BARS_FOR_RANGE(from, to)) return held;
    } catch (e) {
      console.error(`  ${symbol}: archive read failed (${(e as Error).message}) — falling back`);
    }
  }

  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${symbol}_${from}_${to}.json`);
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as Bar[];
  } catch {
    /* not cached */
  }
  // So a sweep can run against whatever is already on disk while a separate, patient fetch keeps
  // filling it. The two must not compete for the same Upstox window.
  if (cachedOnly) return [];

  const out: Bar[] = [];
  let cursor = from;
  let failed = false;
  while (cursor <= to) {
    const end = isoDaysBefore(-MAX_RANGE_DAYS, cursor);
    // A research fetch is not a live scan: it has all the time in the world and no user waiting,
    // so a spent quota is something to WAIT OUT rather than to skip. Skipping is what produced a
    // cache full of half-covered symbols on the first run, and a half-covered symbol is worse
    // than a missing one — it replays as a real sample with silent holes in it.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const candles = await historical(key, 'minutes', 1, cursor, end > to ? to : end);
        for (const c of candles) if (c.minute >= 0 && c.minute <= SESSION_MINUTES) out.push(fromCandle(c));
        break;
      } catch (e) {
        const msg = String((e as Error).message);
        const throttled = msg.includes('429') || msg.includes('rate limited');
        if (!throttled) { console.error(`  ${symbol} ${cursor}: ${msg}`); failed = true; break; }
        process.stdout.write(`  ${symbol} throttled, waiting 60s (attempt ${attempt + 1}/12)   \r`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
    if (failed) return [];
    cursor = isoDaysBefore(-(MAX_RANGE_DAYS + 1), cursor);
  }
  out.sort((a, b) => a.at - b.at);
  if (out.length) {
    await writeFile(file, JSON.stringify(out));
    // Into the archive too, keyed by session rather than by the range this sweep asked for, so
    // the next sweep with different `--days` does not pay for these bars again.
    if (dbEnabled()) {
      await writeDays(symbol, bySession(out)).catch((e: Error) =>
        console.error(`  ${symbol}: archive write failed (${e.message}) — disk cache still written`));
    }
  }
  return out;
}

/**
 * The floor for calling an archived range complete.
 *
 * Deliberately crude: roughly five trading days in seven, times a conservative 300 of the 375
 * session minutes, times a further 0.8 for exchange holidays. It is not trying to know the NSE
 * calendar — this module has no business owning a second source of truth about holidays — it is
 * only trying to tell "the archive has this window" from "the archive has a fortnight of it".
 */
const MIN_BARS_FOR_RANGE = (from: string, to: string): number => {
  const days = Math.max(1, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return Math.floor(days * (5 / 7) * 300 * 0.8);
};

/* --------------------------------------------------------------------------- stats --- */

interface Stats {
  count: number;
  wins: number;
  winRate: number | null;
  totalR: number;
  expectancy: number | null;
  profitFactor: number | null;
  maxDd: number;
  avgHold: number | null;
  stopped: number;
  targeted: number;
  timedOut: number;
}

function stats(trades: BacktestTrade[]): Stats {
  const wins = trades.filter((t) => t.r > 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    cum += t.r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return {
    count: trades.length,
    wins: wins.length,
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    totalR: +cum.toFixed(2),
    expectancy: trades.length ? +(cum / trades.length).toFixed(3) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    maxDd: +dd.toFixed(2),
    avgHold: trades.length ? Math.round(trades.reduce((a, t) => a + t.holdMin, 0) / trades.length) : null,
    stopped: trades.filter((t) => t.outcome === 'stop').length,
    targeted: trades.filter((t) => t.outcome === 'target').length,
    timedOut: trades.filter((t) => t.outcome === 'sessionEnd').length,
  };
}

const statLine = (label: string, s: Stats): string =>
  pad(label, 26) +
  padL(s.count, 6) +
  padL(s.winRate === null ? '—' : `${s.winRate}%`, 8) +
  padL(s.totalR.toFixed(1) + 'R', 9) +
  padL(s.expectancy === null ? '—' : s.expectancy.toFixed(3), 9) +
  padL(s.profitFactor === null ? '—' : s.profitFactor.toFixed(2), 7) +
  padL(s.maxDd.toFixed(1), 8) +
  padL(s.avgHold ?? '—', 7) +
  padL(`${s.targeted}/${s.stopped}/${s.timedOut}`, 14);

/**
 * The timestamp that splits every variant's trades into two halves of equal DURATION.
 *
 * Split on the calendar rather than on trade count: an equal-count split would put a quiet
 * stretch and a busy one either side of the line and compare two different amounts of market,
 * which is the thing an out-of-sample check is supposed to rule out. Null when there is nothing
 * to split.
 */
function baselineWindowMidpoint(results: Map<string, BacktestTrade[]>): number | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const trades of results.values()) {
    for (const t of trades) {
      if (t.entryAt < lo) lo = t.entryAt;
      if (t.entryAt > hi) hi = t.entryAt;
    }
  }
  return Number.isFinite(lo) && hi > lo ? lo + (hi - lo) / 2 : null;
}

const HEADER =
  pad('', 26) + padL('n', 6) + padL('win', 8) + padL('total', 9) + padL('exp/tr', 9) +
  padL('PF', 7) + padL('maxDD', 8) + padL('hold', 7) + padL('tgt/stp/eod', 14);

/* ---------------------------------------------------------------------------- main --- */

async function main(): Promise<void> {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set');
    process.exit(1);
  }

  const days = Number(arg('days', '120'));
  const wanted = Number(arg('symbols', '30'));
  const timeframes = arg('tf', '3,5,15').split(',').map(Number) as Timeframe[];
  const only = arg('variant', '');

  const to = isoDaysBefore(1, istDay());
  const from = isoDaysBefore(days, to);
  // The replay needs 320 bars of warm-up before the first tradable bar, so the fetch has to start
  // well before `from` — the same arithmetic `backtest.engine.ts` does internally, sized for the
  // LONGEST timeframe this module signals on rather than for the ones asked for today. Sizing it
  // per-request was the first version and it made the disk cache useless: `--tf 5` and `--tf 3,5,15`
  // computed different start dates, so the second run missed every file the first had written and
  // re-fetched 45 symbols to produce the same bars.
  const WIDEST_TIMEFRAME = 15;
  const fetchFrom = isoDaysBefore(Math.ceil((320 * WIDEST_TIMEFRAME) / SESSION_MINUTES) * 2 + 20, from);

  const base = await configRepository.get();
  const uni = await universe(base.universe);

  // The most liquid names, which is what the scanner's own universe filter is reaching for and
  // what keeps the sample from being dominated by stocks nobody can fill.
  const members = uni.members
    .filter((m) => m.kind === 'stock' || m.kind === 'index')
    .slice(0, wanted);

  hr('SAMPLE');
  console.log(`window         ${from} .. ${to} (${days} calendar days), fetched from ${fetchFrom}`);
  console.log(`symbols        ${members.length}`);
  console.log(`timeframes     ${timeframes.join(', ')}`);

  const series = new Map<string, Bar[]>();
  let fetched = 0;
  for (const m of members) {
    const bars = await oneMinute(m.symbol, m.seriesKey, fetchFrom, to, process.argv.includes('--cached-only'));
    if (bars.length < 2000) continue;
    series.set(m.symbol, bars);
    fetched++;
    if (fetched % 10 === 0) process.stdout.write(`  ${fetched}/${members.length}\r`);
  }
  console.log(`fetched        ${series.size} symbols with usable history`);

  const variants = only ? VARIANTS.filter((v) => v.name === only) : VARIANTS;

  const results = new Map<string, BacktestTrade[]>();

  for (const variant of variants) {
    const cfg: PullbackConfig = variant.apply(structuredClone(base));
    const all: BacktestTrade[] = [];

    for (const [symbol, minute] of series) {
      for (const tf of timeframes) {
        const r = replay(minute, { symbol, timeframe: tf, from, to, exitOn: 'primary' }, null, cfg);
        for (const t of r.trades) all.push({ ...t, symbol: `${symbol}:${tf}` });
      }
    }
    all.sort((a, b) => a.entryAt - b.entryAt);
    results.set(variant.name, all);
    process.stdout.write(`  replayed ${variant.name}: ${all.length} trades          \r`);
  }

  hr('VARIANTS');
  console.log(HEADER);
  for (const [name, trades] of results) console.log(statLine(name, stats(trades)));

  // THE ONLY REAL CHECK ON ANY OF THIS. Every threshold in the sweep was chosen by looking at the
  // whole window, so the whole window cannot then be used to judge it — a gate tuned on a sample
  // will always look good on that sample. Splitting by date is the cheapest honest test available
  // here: a change that is a real effect holds in both halves, and a change that is a curve fitted
  // to one market regime shows up as a sign flip.
  const midpoint = baselineWindowMidpoint(results);
  if (midpoint !== null) {
    hr('FIRST HALF vs SECOND HALF (the out-of-sample check)');
    console.log(pad('', 26) + padL('first half', 24) + padL('second half', 24));
    for (const [name, trades] of results) {
      const a = stats(trades.filter((t) => t.entryAt < midpoint));
      const b = stats(trades.filter((t) => t.entryAt >= midpoint));
      const cell = (s: Stats) => padL(`${s.totalR.toFixed(1)}R ${(s.expectancy ?? 0).toFixed(3)} n=${s.count}`, 24);
      console.log(pad(name, 26) + cell(a) + cell(b));
    }
  }

  // Per timeframe as well as in total, because the totals hide the most important thing this
  // sweep found: the gates do not behave the same way on 3, 5 and 15 minutes, and a config tuned
  // on the pooled number is tuned on an average of three different strategies.
  if (timeframes.length > 1) {
    hr('VARIANTS BY TIMEFRAME (total R · expectancy · n)');
    console.log(pad('', 26) + timeframes.map((tf) => padL(`${tf}m`, 22)).join(''));
    for (const [name, trades] of results) {
      const cells = timeframes.map((tf) => {
        const s = stats(trades.filter((t) => t.symbol.endsWith(`:${tf}`)));
        return padL(`${s.totalR.toFixed(1)}R ${(s.expectancy ?? 0).toFixed(3)} n=${s.count}`, 22);
      });
      console.log(pad(name, 26) + cells.join(''));
    }
  }

  // The score's own test, per variant. Total R says whether a config makes money; this says
  // whether its confidence number MEANS anything — and they are independent. A model whose
  // Excellent band underperforms its Strong band is sorting the board worst-first, which is the
  // one failure a scanner cannot have, because the top of the list is the only part anyone reads.
  hr('DOES THE SCORE RANK? (expectancy per band, higher band should be higher)');
  console.log(pad('', 26) + ['Excellent', 'Strong', 'Medium', 'Weak'].map((b) => padL(b, 17)).join(''));
  for (const [name, trades] of results) {
    const cells = (['Excellent', 'Strong', 'Medium', 'Weak'] as const).map((b) => {
      const inBand = trades.filter((t) => t.band === b);
      const s = stats(inBand);
      return padL(inBand.length ? `${s.expectancy?.toFixed(2)} (n=${inBand.length})` : '—', 17);
    });
    console.log(pad(name, 26) + cells.join(''));
  }

  const baseline = results.get('baseline') ?? [];

  hr('BASELINE BY TIMEFRAME');
  console.log(HEADER);
  for (const tf of timeframes)
    console.log(statLine(`${tf}m`, stats(baseline.filter((t) => t.symbol.endsWith(`:${tf}`)))));

  hr('BASELINE BY CONFIDENCE BAND');
  console.log(HEADER);
  for (const band of ['Excellent', 'Strong', 'Medium', 'Weak'])
    console.log(statLine(band, stats(baseline.filter((t) => t.band === band))));

  hr('BASELINE BY SCORE BUCKET');
  console.log(HEADER);
  for (const lo of [50, 55, 60, 65, 70, 75, 80, 85]) {
    const inBucket = baseline.filter((t) => t.score >= lo && t.score < lo + 5);
    if (inBucket.length) console.log(statLine(`${lo}–${lo + 4}`, stats(inBucket)));
  }

  hr('BASELINE BY MFE — HOW FAR DID PRICE ACTUALLY GO?');
  console.log(HEADER);
  for (const [label, lo, hi] of [
    ['never went 0.5R', -99, 0.5], ['0.5R – 1R', 0.5, 1], ['1R – 2R', 1, 2],
    ['2R – 3R', 2, 3], ['3R+', 3, 99],
  ] as Array<[string, number, number]>)
    console.log(statLine(label, stats(baseline.filter((t) => t.mfeR >= lo && t.mfeR < hi))));

  hr('BASELINE BY DIRECTION');
  console.log(HEADER);
  console.log(statLine('long', stats(baseline.filter((t) => t.direction === 1))));
  console.log(statLine('short', stats(baseline.filter((t) => t.direction === -1))));

  hr('BASELINE BY ENTRY HOUR (IST)');
  console.log(HEADER);
  const hourOf = (at: number): number => new Date(at + 330 * 60_000).getUTCHours();
  for (let h = 9; h <= 15; h++) {
    const inHour = baseline.filter((t) => hourOf(t.entryAt) === h);
    if (inHour.length) console.log(statLine(`${h}:00`, stats(inHour)));
  }

  /* ----------------------------------------------------------------- the readings --- */

  // Every gate in this module was chosen from the brief or from desk convention. These tables are
  // where one gets chosen from the record instead: a reading whose buckets separate cleanly and
  // monotonically is a gate worth having, and one whose buckets are noise is a threshold that
  // would be fitted rather than found.
  const numeric = (
    title: string,
    of: (t: BacktestTrade) => number | null | undefined,
    edges: number[],
  ): void => {
    hr(`BASELINE BY ${title}`);
    console.log(HEADER);
    const missing = baseline.filter((t) => of(t) === null || of(t) === undefined);
    for (let k = 0; k <= edges.length; k++) {
      const lo = k === 0 ? -Infinity : edges[k - 1];
      const hi = k === edges.length ? Infinity : edges[k];
      const inBucket = baseline.filter((t) => {
        const v = of(t);
        return v !== null && v !== undefined && v >= lo && v < hi;
      });
      if (!inBucket.length) continue;
      const label = k === 0 ? `< ${hi}` : k === edges.length ? `≥ ${lo}` : `${lo} – ${hi}`;
      console.log(statLine(label, stats(inBucket)));
    }
    if (missing.length) console.log(statLine('(not measurable)', stats(missing)));
  };

  const categorical = (title: string, of: (t: BacktestTrade) => string): void => {
    hr(`BASELINE BY ${title}`);
    console.log(HEADER);
    const keys = [...new Set(baseline.map(of))].sort();
    for (const k of keys) console.log(statLine(k, stats(baseline.filter((t) => of(t) === k))));
  };

  const d = (t: BacktestTrade) => t.diagnostics;

  numeric('ENTRY DRIFT (R past the confirmation close)', (t) => d(t)?.entryDriftR, [-0.25, 0, 0.15, 0.3, 0.5]);
  numeric('CONFIRMATION AGE (bars)', (t) => d(t)?.confirmationAgeBars, [1, 2, 3]);
  numeric('EXTENSION PAST THE ZONE (ATR)', (t) => d(t)?.extensionAtr, [0, 0.5, 1, 1.75, 3]);
  numeric('DISTANCE FROM VWAP (ATR, signed with the trade)', (t) => d(t)?.vwapAtr, [-1, 0, 1, 2.5, 5]);
  numeric('RETRACEMENT (fraction of the leg)', (t) => d(t)?.retracement, [0.3, 0.4, 0.5]);
  numeric('IMPULSE SIZE (ATR)', (t) => d(t)?.impulseAtr, [2, 3, 4.5, 7]);
  numeric('ADX', (t) => d(t)?.adx, [22, 26, 30, 38]);
  numeric('TREND STRENGTH', (t) => d(t)?.trendStrength, [60, 70, 80, 90]);
  numeric('ALIGNED HIGHER TIMEFRAMES', (t) => d(t)?.aligned, [1, 2]);
  numeric('STOP DISTANCE (ATR)', (t) => d(t)?.stopAtr, [0.9, 1.4, 2, 3]);
  numeric('STOP DISTANCE (% of price)', (t) => d(t)?.stopPct, [0.25, 0.4, 0.6, 1]);
  numeric('ATR AS % OF PRICE', (t) => d(t)?.atrPct, [0.12, 0.2, 0.3, 0.5]);
  numeric('CONFIRMATION VOLUME (x average)', (t) => d(t)?.confirmationVolumeRatio, [1.4, 1.8, 2.5]);
  numeric('ROOM TO THE OBJECTIVE (R)', (t) => d(t)?.roomR, [2, 3, 5, 9]);
  categorical('CONFIRMATION PATTERN', (t) => d(t)?.pattern ?? '—');
  categorical('STOP KIND', (t) => d(t)?.stopKind ?? '—');
  categorical('ADX DIRECTION', (t) => (d(t)?.adxRising === null || d(t)?.adxRising === undefined ? 'unknown' : d(t)!.adxRising ? 'rising' : 'falling'));

  console.log('');
}

main().catch((e) => {
  console.error(`\nfailed: ${String((e as Error).stack ?? (e as Error).message)}\n`);
  process.exit(1);
});
