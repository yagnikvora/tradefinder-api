// npm run check-pullback — drive the whole pullback scanner once and report what it could read.
//
// This is the tool to run after changing a gate, a threshold or the bar store. It answers the
// four questions a pullback board can silently get wrong:
//
//   1. IS THE SEED WARM, AND FOR WHICH TIMEFRAMES? A 200-period EMA on a 15-minute chart spans
//      eight sessions. A symbol whose seed is short has no long averages and no ADX, and the
//      score renormalises around them and still prints a reasonable-looking number.
//   2. WHICH GATE IS ACTUALLY REFUSING EVERYTHING? On a quiet day the board is empty, and a
//      strategy where one miscalibrated threshold refuses all 209 rows looks exactly the same.
//      The refusal histogram below is the difference.
//   3. ARE THE BARS EXACT OR POLL-BUILT? A poll-built bar has approximate extremes, and ATR,
//      ADX and every candle pattern read them.
//   4. WHAT DID IT COST? Printed as a request count against the Upstox 30-minute ceiling.
//
// Safe to run any time. Outside market hours the order book is empty and the board says so
// rather than pretending — that is itself worth seeing.

import '../src/env.js';

import { tokenSet } from '../src/upstox.js';
import { CANDLE_ENDPOINT } from '../src/momentum/data/candles.js';
import { breakerState } from '../src/momentum/data/throttle.js';
import { istDay, marketOpen, minuteOfSession } from '../src/momentum/session.js';
import { configRepository } from '../src/pullback/config/config.repository.js';
import { frameStore, loadSeed } from '../src/pullback/data/frames.js';
import { universe } from '../src/pullback/data/universe.js';
import { runScan } from '../src/pullback/engine/scanner.engine.js';
import { TIMEFRAME_LABEL, type PullbackRow, type Timeframe } from '../src/pullback/types.js';

const hr = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n);
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '—');

/**
 * Bucket a blocker into the gate that produced it.
 *
 * String matching, which is ugly and is the honest option: the blockers are written for a human
 * to read and are the only place the refusal reason exists. Extracting a machine-readable code
 * would mean maintaining the taxonomy twice, and the version that drifts would be this one.
 */
function gateOf(blocker: string): string {
  const b = blocker.toLowerCase();
  if (b.startsWith('trend:')) return `trend checklist: ${blocker.slice(7).split('—')[0].trim()}`;
  if (b.includes('flat')) return 'veto: flat average';
  if (b.includes('adx')) return 'veto: ADX below the range line';
  if (b.includes('consolidation')) return 'veto: consolidation';
  if (b.includes('wedged')) return 'veto: no-man\'s-land between VWAP and the 20 EMA';
  if (b.includes('tape is dead')) return 'veto: dead tape';
  if (b.includes('bps wide')) return 'veto: wide underlying book';
  if (b.includes('no confirmation candle yet')) return 'waiting: at the zone, no candle';
  if (b.includes('not at the zone')) return 'waiting: not at the zone';
  if (b.includes('pullback failed')) return 'pullback failed';
  if (b.includes('no pullback') || b.includes('no impulse') || b.includes('never got clear')) return 'no impulse leg';
  if (b.includes('room to the next real objective')) return 'reward:risk — too little room';
  if (b.includes('confidence')) return 'confidence below the floor';
  if (b.includes('measurable')) return 'coverage — something still warming';
  if (b.includes('liquidity')) return 'option liquidity';
  if (b.includes('cooldown')) return 'cooldown';
  if (b.includes('minutes of session left')) return 'no session left to hold it';
  return 'other';
}

async function main() {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set — put your Analytics Token in api/.env');
    process.exit(1);
  }

  const t0 = Date.now();
  const cfg = await configRepository.get();
  const uni = await universe(cfg.universe);

  hr('SESSION');
  console.log(`IST day        ${istDay()}`);
  console.log(`market         ${marketOpen() ? 'OPEN' : 'closed'} · minute ${minuteOfSession()} / 375`);
  console.log(`universe       ${uni.members.length} instruments (${uni.members.filter((m) => m.kind === 'index').length} indices)`);
  console.log(`config         v${cfg.version}, updated ${cfg.updatedAt}`);
  console.log(`timeframes     computed ${cfg.timeframes.computed.join('/')} · signalled ${cfg.timeframes.signal.join('/')} · context ${cfg.timeframes.context.join('/')}`);

  hr('SEED');
  const store = frameStore();
  if (!store.symbols.size) {
    const day = await loadSeed(uni.members);
    console.log(day ? `restored from disk, covering through ${day}` : 'NO SEED ON DISK — POST /pullback/seed/rebuild');
  }
  const seeded = [...store.symbols.values()].filter((f) => f.seededThrough !== null);
  console.log(`seeded         ${seeded.length}/${uni.members.length} (${pct(seeded.length, uni.members.length)})`);
  console.log(`failures       ${Object.keys(store.seedFailures).length}`);
  for (const [sym, why] of Object.entries(store.seedFailures).slice(0, 5)) console.log(`  ${pad(sym, 14)} ${why}`);

  hr('SCAN');
  const board = await runScan(cfg);
  const rows = board.rows;
  console.log(`scanned        ${board.scanned} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`signals        ${board.bullishSignals} bullish · ${board.bearishSignals} bearish`);
  console.log(`watching       ${board.watching}`);
  console.log(`enriched       ${board.enriched} (option chain + exact-bar resync)`);
  console.log(`logged today   ${board.firedToday}`);
  for (const w of board.warnings) console.log(`  ⚠ ${w}`);

  // Which timeframes are actually readable, per averaged coverage. A 200 EMA that is null on
  // every row is indistinguishable from one that is working, which is the point of this table.
  hr('WHAT COULD BE READ, BY TIMEFRAME');
  console.log(`${pad('timeframe', 12)}${padL('rows', 6)}${padL('warm', 6)}${padL('9', 6)}${padL('20', 6)}${padL('50', 6)}${padL('200', 6)}${padL('VWAP', 7)}${padL('ADX', 6)}${padL('struct', 8)}`);
  for (const tf of cfg.timeframes.computed) {
    const reads = rows.map((r) => r.frames[tf as Timeframe]).filter((x): x is NonNullable<typeof x> => !!x);
    if (!reads.length) { console.log(`${pad(TIMEFRAME_LABEL[tf], 12)}${padL('0', 6)}`); continue; }
    const n = reads.length;
    const has = (f: (r: (typeof reads)[number]) => boolean) => padL(pct(reads.filter(f).length, n), 6);
    console.log(
      pad(TIMEFRAME_LABEL[tf], 12) + padL(String(n), 6) +
      has((r) => !r.warming) +
      has((r) => r.ema.ema9 !== null) + has((r) => r.ema.ema20 !== null) +
      has((r) => r.ema.ema50 !== null) + has((r) => r.ema.ema200 !== null) +
      padL(pct(reads.filter((r) => r.vwap !== null).length, n), 7) +
      has((r) => r.adx.adx !== null) +
      padL(pct(reads.filter((r) => r.structure.steps > 0).length, n), 8),
    );
  }

  hr('BAR PROVENANCE');
  const exact = rows.filter((r) => r.enriched).length;
  console.log(`resynced       ${exact}/${rows.length} rows have exchange bars for today's session`);
  console.log(`poll-built     ${rows.length - exact} rows — their highs and lows come from the quote poll and run narrow`);
  console.log('               ATR, ADX and the candle patterns read those extremes; every EMA and VWAP does not.');

  // The histogram. On an empty board this is the only thing that says WHY, and a single gate
  // accounting for nearly every row is the signature of a miscalibrated threshold.
  //
  // Rows that carry a WATCH candidate are attributed to its first blocker. Rows that carry neither
  // a signal nor a watch are classified from their trends and pullbacks instead, because the board
  // deliberately drops a signal object that is not watch-worthy — and reporting all of those as
  // "no result" was this tool's own bug, which put 87% of the board in one meaningless bucket.
  hr('WHY ROWS DID NOT FIRE');
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);

  for (const r of rows) {
    if (r.signal) continue;

    const s = r.watch;
    if (s) {
      // The FIRST blocker only. A row typically has one thing missing, and counting them all would
      // weight the noisiest rows most.
      bump(s.blockers.length ? gateOf(s.blockers[0]) : 'unknown');
      continue;
    }

    const trends = cfg.timeframes.signal.map((tf) => r.trends[tf as Timeframe]).filter((t): t is NonNullable<typeof t> => !!t);
    const trending = trends.filter((t) => t.state !== 'None');
    if (!trends.length) { bump('below the bar: no timeframe could be read'); continue; }

    if (!trending.length) {
      const vetoed = trends.find((t) => t.vetoes.length);
      if (vetoed) { bump(gateOf(vetoed.vetoes[0])); continue; }
      const failed = trends.flatMap((t) => t.failed);
      bump(failed.length ? `trend checklist: ${failed[0].split('—')[0].trim()}` : 'below the bar: no trend');
      continue;
    }

    // A real trend on some timeframe, and still not watch-worthy — so the pullback is the reason.
    const phases = trending.map((t) => r.pullbacks[t.timeframe]?.phase ?? 'None');
    if (phases.includes('Failed')) bump('trending: pullback failed');
    else if (phases.includes('Impulse')) bump('trending: extended, no pullback yet');
    else if (phases.includes('PullingBack') || phases.includes('AtZone')) bump('at the zone but below the watch confidence bar');
    else bump('trending: no impulse leg to retrace');
  }

  for (const [gate, n] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`${padL(String(n), 5)}  ${padL(pct(n, rows.length), 5)}  ${gate}`);

  hr('TOP ROWS');
  const show = (r: PullbackRow) => {
    const s = r.signal ?? r.watch;
    const tag = r.signal ? 'SIGNAL' : r.watch ? 'watch ' : '      ';
    if (!s) return `${tag} ${pad(r.symbol, 13)} trend ${padL(String(r.dominant?.strength ?? 0), 3)} ${r.dominant?.state ?? '—'}`;
    return (
      `${tag} ${pad(r.symbol, 13)}${padL(`${s.timeframe}m`, 4)} ` +
      `${pad(s.pullback.phase, 12)} ${padL(s.score.total.toFixed(0), 3)} ${pad(s.score.band, 10)}` +
      `stop ${pad(s.stop.recommended.kind, 6)}${padL(s.stop.recommended.distancePct.toFixed(2) + '%', 7)}  ` +
      `room ${padL(s.target.roomR.toFixed(2) + 'R', 6)}  ` +
      (s.option
        ? `${pad(s.option.label, 12)} Δ${Math.abs(s.option.delta).toFixed(2)} liq ${s.option.liquidity.score.toFixed(0)}`
        : 'no chain')
    );
  };
  for (const r of rows.slice(0, 15)) console.log(show(r));

  hr('COST');
  const chains = board.enriched;
  console.log(`this scan      2 quote requests + ${chains} option chains + up to ${chains} candle resyncs`);
  console.log(`per 30 min     at ${(cfg.refresh.scanMs / 1000).toFixed(0)}s intervals: ~${Math.round((30 * 60_000) / cfg.refresh.scanMs) * 2} quote, ` +
    `~${Math.round(((30 * 60_000) / cfg.refresh.enrichMs) * chains)} chain, ~${Math.round(((30 * 60_000) / cfg.refresh.resyncMs) * chains)} candle`);
  console.log(`ceiling        2000 per 30 minutes, per endpoint, per user`);
  console.log(`seed           ~${uni.members.length} candle requests once a day, plus the same again for the catch-up`);
  const breaker = breakerState(CANDLE_ENDPOINT);
  console.log(`breaker        ${breaker.open ? `OPEN for another ${Math.ceil(breaker.retryAfterMs / 1000)}s` : 'shut'} (${breaker.refusals} recent refusals)`);

  console.log('');
}

main().catch((e) => {
  console.error(`\nfailed: ${String((e as Error).message)}\n`);
  process.exit(1);
});
