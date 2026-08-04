// npm run check-momentum — drive the whole scanner once and report what it could compute.
//
// This is the tool to run after changing a factor, a threshold or the funnel. It answers
// the three questions a momentum board can silently get wrong:
//
//   1. Which factors are actually available, universe-wide? A factor that is quietly
//      unavailable on every row is indistinguishable from a factor that is working, because
//      the score renormalises around it and still looks reasonable.
//   2. Does the score agree with its own explanation? The ✓ list and the arithmetic come
//      from the same objects, so a disagreement means a real bug.
//   3. What did it cost? Printed as a request count against the Upstox 30-minute ceiling.
//
// Safe to run any time. Outside market hours the order book is empty and the board says so
// rather than pretending — that is itself worth seeing.

import '../src/env.js';

import { configRepository } from '../src/momentum/config/config.repository.js';
import { runScan } from '../src/momentum/engine/momentum.engine.js';
import { ensureBaseline, getBaseline } from '../src/momentum/data/baseline.js';
import { CANDLE_ENDPOINT } from '../src/momentum/data/candles.js';
import { breakerState } from '../src/momentum/data/throttle.js';
import { universe } from '../src/momentum/data/universe.js';
import { marketOpen, istDay, minuteOfSession } from '../src/momentum/session.js';
import { FACTOR_KEYS, FACTOR_LABEL, type FactorKey } from '../src/momentum/types.js';
import { tokenSet } from '../src/upstox.js';

const hr = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n);

async function main() {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set — put your Analytics Token in api/.env');
    process.exit(1);
  }

  const t0 = Date.now();
  const cfg = await configRepository.get();

  hr('Configuration');
  console.log(`version ${cfg.version}, updated ${cfg.updatedAt} by ${cfg.updatedBy}`);
  console.log(
    'weights: ' +
      FACTOR_KEYS.map((k) => `${k}=${cfg.weights[k]}`).join('  ') +
      `  (total ${FACTOR_KEYS.reduce((a, k) => a + cfg.weights[k], 0)})`,
  );
  console.log(`shortlist ${cfg.universe.shortlistSize}, quote ${cfg.refresh.quoteMs}ms, enrich ${cfg.refresh.enrichMs}ms`);

  hr('Session');
  console.log(`IST day ${istDay()}, minute of session ${minuteOfSession()}/375, market ${marketOpen() ? 'OPEN' : 'CLOSED'}`);

  const uni = await universe();
  console.log(`universe: ${uni.members.length} F&O stocks`);
  console.log(`  with a near future:   ${uni.members.filter((m) => m.future).length}`);
  console.log(`  with a sector index:  ${uni.members.filter((m) => m.sectorIndexName).length}`);
  console.log(`  sector indices mapped: ${uni.sectorIndexKeys.size} -> ${[...uni.sectorIndexKeys.keys()].join(', ')}`);
  console.log(`  nifty ${uni.niftyKey}, nifty future ${uni.niftyFuture?.tradingSymbol ?? 'NONE'}, vix ${uni.vixKey ?? 'NONE'}`);

  hr('Baseline');
  const rl = breakerState(CANDLE_ENDPOINT);
  if (rl.open) console.log(`! candle endpoint circuit is OPEN for another ${Math.ceil(rl.retryAfterMs / 1000)}s`);

  let b = await getBaseline();
  // `--no-build` exists because a build is ~416 requests against a 2000-per-30-minute
  // ceiling. Two in a window exhausts it, and the second one comes back almost empty —
  // which is a worse outcome than scanning against yesterday's profile.
  const mayBuild = !process.argv.includes('--no-build');
  if ((!b.baseline || b.stale) && mayBuild) {
    console.log(`no baseline for ${istDay()} — building (~${uni.members.length * 2} requests, give it a minute)…`);
    try {
      await ensureBaseline({
        atrPeriod: cfg.thresholds.atrExpansion.period,
        trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
      });
    } catch (e) {
      console.log(`! build failed: ${String((e as Error).message)}`);
    }
    b = await getBaseline();
  } else if (!b.baseline) {
    console.log('no baseline and --no-build was passed');
  }

  const base = b.baseline;
  if (!base) {
    console.error(
      '\nNo baseline, so relative volume, ATR, beta and trend structure cannot be computed.\n' +
      'If the candle endpoint is rate limited, wait for the window to clear and re-run.',
    );
    process.exit(1);
  }
  const built = Object.values(base.symbols);
  console.log(`day ${base.day}${b.stale ? ' (STALE)' : ''}: ${built.length} symbols, ${Object.keys(base.failures).length} failures`);
  console.log(`  median profile sessions: ${median(built.map((s) => s.profileSessions))}`);
  console.log(`  with beta:               ${built.filter((s) => s.beta !== null).length}`);
  console.log(`  with ATR:                ${built.filter((s) => s.atr > 0).length}`);
  console.log(`  with prev futures OI:    ${built.filter((s) => s.prevFuturesOi !== null).length}`);
  console.log(`  with HV rank:            ${built.filter((s) => s.hvRank !== null).length}`);
  const sampleFailures = Object.entries(base.failures).slice(0, 5);
  if (sampleFailures.length) for (const [s, why] of sampleFailures) console.log(`  ! ${s}: ${why}`);

  hr('Scan');
  const scanStart = Date.now();
  const board = await runScan(cfg);
  console.log(`scored ${board.scored}/${board.universeSize} in ${Date.now() - scanStart}ms, shortlist ${board.shortlisted}`);
  console.log(
    `market: Nifty ${board.market.nifty?.level ?? '—'} (${board.market.nifty?.changePct ?? '—'}%), ` +
      `A/D ${board.market.breadth.advances}/${board.market.breadth.declines}, ` +
      `${board.market.breadth.pctAboveVwap ?? '—'}% above own VWAP, ` +
      `VIX ${board.market.indiaVix?.level ?? '—'}`,
  );
  if (board.market.nifty) console.log(`  Nifty-above-VWAP source: ${board.market.nifty.vwapSource}`);

  hr('Factor availability across the board');
  const total = board.rows.length;
  console.log(pad('factor', 30) + padL('weight', 7) + padL('available', 12) + padL('median score', 14));
  for (const key of FACTOR_KEYS) {
    const outs = board.rows.map((r) => r.factors.find((f) => f.key === key)).filter(Boolean);
    const ok = outs.filter((f) => f!.available);
    const scores = ok.map((f) => f!.score as number);
    console.log(
      pad(FACTOR_LABEL[key], 30) +
        padL(String(cfg.weights[key as FactorKey]), 7) +
        padL(`${ok.length}/${total}`, 12) +
        padL(scores.length ? median(scores).toFixed(1) : '—', 14),
    );
  }

  hr('Top 15');
  console.log(
    pad('#', 4) + pad('symbol', 14) + padL('score', 7) + padL('conf', 8) + pad('  direction', 12) +
    pad('trade', 16) + padL('rvol', 7) + padL('cov', 6) + pad('  build-up', 18) + pad('enrich', 9),
  );
  for (const r of board.rows.slice(0, 15)) {
    console.log(
      pad(String(r.rank), 4) +
        pad(r.symbol, 14) +
        padL(r.score.toFixed(1), 7) +
        padL(r.confidence, 8) +
        pad('  ' + r.direction, 12) +
        pad(r.tradeType, 16) +
        padL(r.rvol.value?.toFixed(2) ?? '—', 7) +
        padL((r.coverage * 100).toFixed(0) + '%', 6) +
        pad('  ' + (r.oiBuildUp ?? '—'), 18) +
        pad(r.enrichment, 9),
    );
  }

  hr('Timing layer — is the board early, or is it describing finished moves?');
  //
  // The single most useful line this tool prints. If almost every high-scoring row reads
  // `Extended`, the model is working exactly as designed and is telling you the truth: the
  // scan arrived after the moves. If nothing is `Igniting` all session, either the market is
  // genuinely flat or `signal.minPulseScore` / `minBurstRvol` are set above what this
  // universe actually produces, and they want lowering against real fills rather than taste.
  {
    const withSignal = board.rows.filter((r) => r.signal);
    const byState = new Map<string, number>();
    for (const r of withSignal) byState.set(r.signal!.state, (byState.get(r.signal!.state) ?? 0) + 1);

    console.log(
      'states: ' +
        [...byState.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}=${c}`).join('  ') +
        `  (${withSignal.length} rows carry a signal)`,
    );

    const warming = withSignal.filter((r) => !r.signal!.pulse.ready).length;
    if (warming)
      console.log(`  ! ${warming} rows have no pulse yet — the price ring needs ~${cfg.thresholds.pulse.fastWindowMin} minutes of polling after a restart`);

    // How the score and the timing read disagree. This is the whole point of the layer, and
    // if the two never disagree the layer is not doing anything.
    const strong = withSignal.filter((r) => r.score >= cfg.output.buyScore);
    const strongSpent = strong.filter((r) => r.signal!.state === 'Extended' || r.signal!.state === 'Reversing');
    console.log(
      `  of ${strong.length} rows scoring ${cfg.output.buyScore}+, ${strongSpent.length} are already spent or reversing` +
        (strong.length ? ` (${((strongSpent.length / strong.length) * 100).toFixed(0)}%)` : ''),
    );

    const entries = withSignal
      .filter((r) => r.signal!.action === 'Buy Call' || r.signal!.action === 'Buy Put')
      .sort((a, b) => b.signal!.entryQuality - a.signal!.entryQuality);

    console.log(`\nentrable right now: ${entries.length}`);
    if (entries.length) {
      console.log(
        pad('symbol', 12) + padL('entry', 6) + padL('score', 6) + pad('  state', 12) +
        pad('trigger', 20) + padL('age', 5) + padL('burst', 6) +
        pad('  contract', 15) + padL('cost', 8) + padL('lot ₹', 10) + padL('gain%', 7),
      );
      for (const r of entries.slice(0, 15)) {
        const s = r.signal!;
        const k = s.strike;
        console.log(
          pad(r.symbol, 12) +
            padL(String(s.entryQuality), 6) +
            padL(r.score.toFixed(1), 6) +
            pad('  ' + s.state, 12) +
            pad(s.trigger ? s.trigger.label : '—', 20) +
            padL(s.trigger ? `${s.trigger.ageMin.toFixed(0)}m` : '—', 5) +
            padL(s.pulse.burstRvol?.toFixed(1) ?? '—', 6) +
            pad('  ' + (k ? k.label + (k.warnings.length ? ' ⚠' : '') : '—'), 15) +
            padL(k ? k.entryCost.toFixed(2) : '—', 8) +
            padL(k?.costPerLot?.toLocaleString('en-IN') ?? '—', 10) +
            padL(k?.gainPctAtTarget?.toFixed(0) ?? s.plan?.optionMovePctAtTarget?.toFixed(0) ?? '—', 7),
        );
      }

      // The contract's own problems, spelled out. A strike nobody is quoting is the most
      // common reason a perfect-looking stock setup is not a trade, and a table cell cannot
      // carry that.
      const flagged = entries.filter((r) => (r.signal!.strike?.warnings.length ?? 0) > 0);
      if (flagged.length) {
        console.log('');
        for (const r of flagged.slice(0, 6)) {
          for (const w of r.signal!.strike!.warnings) console.log(`  ⚠ ${r.symbol} ${r.signal!.strike!.label}: ${w}`);
        }
      }

      const noStrike = entries.filter((r) => !r.signal!.strike).length;
      if (noStrike)
        console.log(`\n  ${noStrike} entrable rows have no contract named — they were not in the enrichment shortlist this cycle`);
    } else {
      console.log('  (none — every strong row has already moved, stalled or turned. That is a finding, not a bug.)');
    }

    // The shortlist reservation, checked rather than assumed: if no fresh signal ever gets
    // enriched, the reserved slots are not doing their job.
    const enrichedFresh = withSignal.filter((r) => r.signal!.state === 'Igniting' && r.enrichment === 'full').length;
    const totalFresh = withSignal.filter((r) => r.signal!.state === 'Igniting').length;
    console.log(`\nigniting rows with an option chain: ${enrichedFresh}/${totalFresh} (${cfg.signal.enrichReservedSlots} slots reserved for them)`);
  }

  hr('Explanation of the top row — the score and its ✓ list must agree');
  const top = board.rows[0];
  if (top) {
    console.log(`${top.symbol}  score ${top.score} (raw ${top.rawScore}, coverage ${(top.coverage * 100).toFixed(0)}%)`);
    console.log(`price ₹${top.price} (${top.changePct >= 0 ? '+' : ''}${top.changePct}%), ${top.direction}, ${top.confidence} confidence, ${top.tradeType}`);
    if (top.signal) {
      const s = top.signal;
      console.log(
        `timing: ${s.state} / ${s.action}, entry quality ${s.entryQuality}` +
          (s.trigger ? `, ${s.trigger.label} ${s.trigger.ageMin.toFixed(0)}m ago at ₹${s.trigger.price}` : ', no trigger') +
          (s.extension.atrUsed === null ? '' : `, ${(s.extension.atrUsed * 100).toFixed(0)}% of a normal day used`),
      );
      for (const b of s.blockers) console.log(`  blocked: ${b}`);
      if (s.strike)
        console.log(
          `contract: ${s.strike.label} @ ₹${s.strike.entryCost} (${s.strike.moneyness}, delta ${Math.abs(s.strike.delta).toFixed(2)}, ` +
            `${s.strike.spreadPct?.toFixed(1) ?? '—'}% spread)` +
            (s.strike.costPerLot ? ` — ₹${s.strike.costPerLot.toLocaleString('en-IN')} a lot` : '') +
            (s.strike.gainPctAtTarget !== null ? `, ${s.strike.gainPctAtTarget.toFixed(0)}% at target` : ''),
        );
    }
    console.log(`institutional activity: ${top.institutionalActivity}`);
    if (top.expectedMove) console.log(`expected move to expiry: ±₹${top.expectedMove.rupees} (${top.expectedMove.pct}%) over ${top.expectedMove.days}d`);
    console.log('');
    for (const rz of top.reasons) console.log(`  ${rz.ok ? '✓' : '✗'} ${rz.text}`);
    console.log('\n  factor arithmetic:');
    let check = 0;
    let usedW = 0;
    for (const f of top.factors) {
      const line = `    ${pad(f.label, 28)} ${padL(f.score === null ? 'n/a' : f.score.toFixed(1), 6)} × ${padL(String(f.weight), 3)}` +
        `  bias ${padL(f.bias.toFixed(2), 6)}${f.note ? `   (${f.note})` : ''}`;
      console.log(line);
      if (f.available && f.score !== null) { check += f.score * f.weight; usedW += f.weight; }
    }
    const recomputed = usedW > 0 ? check / usedW : 0;
    const drift = Math.abs(recomputed - top.rawScore);
    console.log(`\n    recomputed raw score ${recomputed.toFixed(2)} vs reported ${top.rawScore} -> ${drift < 0.15 ? 'AGREES' : `MISMATCH (${drift.toFixed(3)})`}`);
    if (drift >= 0.15) process.exitCode = 1;
  }

  if (board.warnings.length) {
    hr('Warnings');
    for (const w of board.warnings) console.log(`  ! ${w}`);
  }

  hr('Cost');
  console.log(`Upstox allows 2000 requests / 30 min PER ENDPOINT.`);
  console.log(`  quote endpoint:        3 per scan  -> ${Math.round((3 * 30 * 60_000) / cfg.refresh.quoteMs)} per 30 min at a ${cfg.refresh.quoteMs}ms cycle`);
  console.log(`  option-chain endpoint: ${board.shortlisted} per enrichment -> ${Math.round((board.shortlisted * 30 * 60_000) / cfg.refresh.enrichMs)} per 30 min at a ${cfg.refresh.enrichMs}ms cycle`);
  console.log(`  historical-candle:     ${uni.members.length * 2} once a day for the baseline`);
  console.log(`\ntotal wall time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
