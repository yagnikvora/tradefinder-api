// npm run replay-trend -- BOSCHLTD NHPC SONACOMS [--day 2026-08-05]
//
// Replay a finished session through the conviction and timing layers, minute by minute, and
// print what the scanner WOULD have said at every point of it.
//
// WHY THIS EXISTS. The rest of this module can only be observed live, one cycle at a time,
// during the five and a half hours a week when it matters. That is a terrible way to find out
// whether a change to a scoring curve helps: by the time the answer arrives the market has
// moved on, nobody can re-run the same day, and the only evidence available is a memory of
// what the board looked like. This tool makes a session repeatable. Point it at the stocks
// that trended and read off, at 09:45 / 10:30 / 11:15, what the model thought at the time.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//
// It proves the shape logic: whether a genuinely one-sided day is classified as one, when the
// phase machine promotes it, how many re-entry triggers fire and where. Those are all pure
// functions of the price and volume path, and the path is exactly what a 1-minute candle
// series is.
//
// It does NOT prove the option side. There is no historical option chain here, so no strike is
// picked and no premium is quoted — the plan prints in the underlying only. A replayed entry
// that looks good in the stock can still be untradable in the contract, and only the live
// board knows that.
//
// THREE APPROXIMATIONS, stated rather than buried:
//
//   VWAP      rebuilt as Σ(typical × volume) ÷ Σvolume with typical = (h+l+c)/3. Upstox's live
//             `average_price` is the exact traded VWAP; this is the standard reconstruction of
//             it and drifts by single-digit basis points on liquid names. Every VWAP-derived
//             reading here — adherence, crossings, slope — inherits that.
//
//   SAMPLING  one reading per minute, against fifteen seconds live. So the pulse windows hold
//             a quarter of the readings they normally would, and `travelled` (the denominator
//             of session efficiency) is understated because intra-minute reversals are
//             invisible. Session efficiency therefore reads HIGH here relative to live. The
//             replay's job is to compare stocks against each other on the same footing, not to
//             reproduce a live number to the decimal.
//
//   NO BOOK   historical candles carry no depth, so liquidity is unscored and every gate that
//             depends on it is skipped rather than failed.

import '../src/env.js';

import { configRepository } from '../src/momentum/config/config.repository.js';
import { ensureBaseline, getBaseline, type SymbolBaseline } from '../src/momentum/data/baseline.js';
import { historical, inBatches, todaySession, type Candle } from '../src/momentum/data/candles.js';
import { universe } from '../src/momentum/data/universe.js';
// The candle-to-quote reconstruction now lives in the runtime, because the boot-time session
// seed does the same thing for the same reason. Imported rather than duplicated so a change to
// how a replayed session is built can never make the tool disagree with the live board.
import { replayQuotes } from '../src/momentum/data/session-seed.js';
import { computePulse, pulseFactor } from '../src/momentum/services/pulse.service.js';
import { computeConviction, convictionFactor } from '../src/momentum/services/conviction.service.js';
import { buildSignal } from '../src/momentum/engine/signal.service.js';
import { observe, type SessionState } from '../src/momentum/data/session-state.js';
import { istDay, minuteOfSession } from '../src/momentum/session.js';
import type { ConvictionReading, MomentumConfig, MomentumSignal } from '../src/momentum/types.js';
import { tokenSet } from '../src/upstox.js';

const hr = (t: string) => console.log(`\n${'─'.repeat(92)}\n${t}\n${'─'.repeat(92)}`);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n);
const clock = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);

/* ----------------------------------------------------------------------- the replay --- */

interface Snapshot {
  at: number;
  minute: number;
  ltp: number;
  vwap: number;
  conviction: ConvictionReading;
  signal: MomentumSignal;
  pulseScore: number | null;
  trendScore: number | null;
}

interface Entry {
  at: number;
  price: number;
  direction: 1 | -1;
  kind: string;
  state: string;
  entryQuality: number;
  target: number | null;
  stop: number | null;
  /** Filled in afterwards from the rest of the day — this is the whole point of a replay. */
  bestAfterPct: number | null;
  worstAfterPct: number | null;
  closeAfterPct: number | null;
  hitTarget: boolean | null;
  hitStopFirst: boolean | null;
}

function replaySymbol(
  symbol: string,
  candles: Candle[],
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
): { snapshots: Snapshot[]; entries: Entry[]; closes: Array<{ at: number; ltp: number }> } {
  const day = candles.length ? candles[0].day : istDay();
  const state: SessionState = { day, symbols: {} };
  const prevClose = baseline?.prevClose ?? candles[0]?.open ?? 0;

  const snapshots: Snapshot[] = [];
  const entries: Entry[] = [];
  const closes: Array<{ at: number; ltp: number }> = [];
  const seenTriggers = new Set<number>();

  const p = cfg.thresholds.pulse;
  const conv = cfg.thresholds.conviction;
  const atr = baseline?.atr ?? 0;

  for (const { quote, at } of replayQuotes(symbol, candles, prevClose)) {
    closes.push({ at, ltp: quote.ltp });

    const reversal = atr > 0 ? atr * p.legReversalAtr : quote.ltp * (p.legReversalPctFloor / 100);
    observe(state, quote, cfg.thresholds.trendStructure.openingRangeMinutes, at, reversal, {
      atr,
      vwapSideBufferAtr: conv.vwapSideBufferAtr,
      spineIntervalMin: conv.spineIntervalMin,
    });

    const symState = state.symbols[symbol];
    const pulse = computePulse(quote, symState, baseline, cfg, at);
    const conviction = computeConviction(symState, baseline, cfg, at);

    const pulseScore = pulseFactor(pulse, cfg).score;
    const trendScore = convictionFactor(conviction, cfg).score;

    // The day's direction, which the live engine gets from the full factor vote. Here it is
    // taken from the conviction read when there is one and from the change on the day
    // otherwise — the other eleven factors need a book, a chain and an index this replay does
    // not have, and inventing them would make the output look more authoritative than it is.
    const direction =
      conviction.ready && conviction.direction !== 'Neutral'
        ? conviction.direction
        : quote.changePct > 0.15
          ? 'Bullish'
          : quote.changePct < -0.15
            ? 'Bearish'
            : 'Neutral';

    const signal = buildSignal({
      quote,
      pulse,
      pulseScore,
      symState,
      baseline,
      openingRange: symState?.openingRange ?? null,
      greeks: null,
      chain: null,
      lotSize: null,
      direction,
      conviction,
      // No order book in a candle, so the liquidity gate is given a passing score rather than
      // a zero — failing every replayed entry on missing depth would hide the thing being
      // tested behind a data limitation.
      liquidityScore: 100,
      config: cfg,
      nowMs: at,
    });

    snapshots.push({
      at, minute: minuteOfSession(at), ltp: quote.ltp, vwap: quote.vwap,
      conviction, signal, pulseScore, trendScore,
    });

    // An entry is recorded once per distinct trigger firing, identified by its timestamp.
    if (
      (signal.action === 'Buy Call' || signal.action === 'Buy Put') &&
      signal.trigger &&
      !seenTriggers.has(signal.trigger.at)
    ) {
      seenTriggers.add(signal.trigger.at);
      entries.push({
        at,
        price: quote.ltp,
        direction: signal.action === 'Buy Call' ? 1 : -1,
        kind: signal.entryKind ?? signal.trigger.kind,
        state: signal.state,
        entryQuality: signal.entryQuality,
        target: signal.plan?.target ?? null,
        stop: signal.plan?.stop ?? null,
        bestAfterPct: null, worstAfterPct: null, closeAfterPct: null,
        hitTarget: null, hitStopFirst: null,
      });
    }
  }

  scoreEntries(entries, closes);
  return { snapshots, entries, closes };
}

/**
 * What each entry actually did, from the rest of the session.
 *
 * `hitStopFirst` is the one that matters and is the reason this walks the path forward rather
 * than comparing to the close: an entry that reached its target after first going through its
 * stop is a loss, and a report that only looked at the best price afterwards would score it a
 * win. Resolution is one minute, so a bar that spans both levels is counted as a stop —
 * the pessimistic reading, because within-bar order is unknowable here.
 */
function scoreEntries(entries: Entry[], closes: Array<{ at: number; ltp: number }>): void {
  for (const e of entries) {
    const after = closes.filter((c) => c.at > e.at);
    if (!after.length) continue;

    let best = e.price;
    let worst = e.price;
    let hitTarget = false;
    let hitStop = false;

    for (const c of after) {
      if (e.direction === 1) {
        best = Math.max(best, c.ltp);
        worst = Math.min(worst, c.ltp);
        if (e.stop !== null && c.ltp <= e.stop && !hitTarget) { hitStop = true; break; }
        if (e.target !== null && c.ltp >= e.target) { hitTarget = true; break; }
      } else {
        best = Math.min(best, c.ltp);
        worst = Math.max(worst, c.ltp);
        if (e.stop !== null && c.ltp >= e.stop && !hitTarget) { hitStop = true; break; }
        if (e.target !== null && c.ltp <= e.target) { hitTarget = true; break; }
      }
    }

    const pct = (v: number) => ((v - e.price) / e.price) * 100 * e.direction;
    e.bestAfterPct = +pct(best).toFixed(2);
    e.worstAfterPct = +pct(worst).toFixed(2);
    e.closeAfterPct = +pct(after[after.length - 1].ltp).toFixed(2);
    e.hitTarget = hitTarget;
    e.hitStopFirst = hitStop;
  }
}

/* ------------------------------------------------------------------------ printing --- */

function printSymbol(symbol: string, r: ReturnType<typeof replaySymbol>, cfg: MomentumConfig): void {
  const { snapshots, entries } = r;
  if (!snapshots.length) {
    console.log(`\n${symbol}: no candles for this day`);
    return;
  }

  const last = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const dayPct = ((last.ltp - first.ltp) / first.ltp) * 100;

  hr(`${symbol}   ${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}% on the day`);

  // The timeline. Every 30 minutes, which is enough to see a phase machine work and few
  // enough lines to read three stocks at once.
  console.log(
    pad('time', 7) + padL('ltp', 10) + padL('conv', 6) + pad('  phase', 12) +
    padL('adh', 6) + padL('xing', 5) + padL('eff', 6) + padL('dip', 6) +
    padL('intra', 7) + padL('true', 6) + padL('gap', 6) + padL('budget', 8) +
    pad('  state', 11) + pad('action', 12) + padL('pulse', 6),
  );

  let lastPrinted = -99;
  for (const s of snapshots) {
    const isMark = s.minute - lastPrinted >= 30;
    if (!isMark) continue;
    lastPrinted = s.minute;

    const c = s.conviction;
    const x = s.signal.extension;
    console.log(
      pad(clock(s.at), 7) +
        padL(s.ltp.toFixed(2), 10) +
        padL(c.ready ? c.score.toFixed(0) : '—', 6) +
        pad('  ' + c.phase, 12) +
        padL(c.vwapAdherence === null ? '—' : (c.vwapAdherence * 100).toFixed(0) + '%', 6) +
        padL(c.vwapCrossings === null ? '—' : String(c.vwapCrossings), 5) +
        padL(c.sessionEfficiency === null ? '—' : c.sessionEfficiency.toFixed(2), 6) +
        padL(c.deepestPullbackAtr === null ? '—' : c.deepestPullbackAtr.toFixed(2), 6) +
        padL(x.atrUsed === null ? '—' : x.atrUsed.toFixed(2), 7) +
        padL(x.trueRangeAtrUsed === null ? '—' : x.trueRangeAtrUsed.toFixed(2), 6) +
        padL(x.gapAtr === null ? '—' : x.gapAtr.toFixed(2), 6) +
        padL(x.atrUsedMax.toFixed(2), 8) +
        pad('  ' + s.signal.state, 11) +
        pad(s.signal.action, 12) +
        padL(s.pulseScore === null ? '—' : s.pulseScore.toFixed(0), 6),
    );
  }

  // THE COMPARISON THAT MATTERS. How much of the session the OLD ceiling would have refused,
  // against how much the conviction-scaled one does.
  const oldMax = cfg.signal.extension.atrUsedMax;
  const measurable = snapshots.filter((s) => s.signal.extension.atrUsed !== null);
  const spentOld = measurable.filter((s) => (s.signal.extension.atrUsed ?? 0) >= oldMax).length;
  const spentNew = measurable.filter((s) => s.signal.extension.extended).length;

  if (measurable.length) {
    console.log(
      `\n  extension ceiling: the old fixed ${oldMax} ATR would have read "spent" for ` +
        `${((spentOld / measurable.length) * 100).toFixed(0)}% of the session ` +
        `(${spentOld}/${measurable.length} minutes); the conviction-scaled budget reads spent for ` +
        `${((spentNew / measurable.length) * 100).toFixed(0)}%.`,
    );
  }

  const confirmedAt = snapshots.find((s) => s.conviction.phase === 'Confirmed');
  const formingAt = snapshots.find((s) => s.conviction.phase === 'Forming');
  console.log(
    `  phase: ${formingAt ? `Forming from ${clock(formingAt.at)}` : 'never Formed'}` +
      `, ${confirmedAt ? `Confirmed from ${clock(confirmedAt.at)}` : 'never Confirmed'}` +
      `, peak conviction ${Math.max(...snapshots.map((s) => s.conviction.score)).toFixed(0)}`,
  );

  // WHY IT SAID NOTHING. Without this a silent stock is indistinguishable from a broken
  // pipeline, and the two want opposite responses — one is the model working and the other is
  // a threshold set somewhere no real stock reaches.
  const counts = new Map<string, number>();
  for (const s of snapshots) {
    for (const b of s.signal.blockers) {
      // Collapse the numbers out so "pulse 41 is below 55" and "pulse 12 is below 55" are one
      // line rather than three hundred.
      const key = b.replace(/-?[\d.]+/g, '#').slice(0, 78);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (ranked.length) {
    console.log('\n  what stopped an entry, by how many minutes of the session it stopped one:');
    for (const [text, n] of ranked)
      console.log(`    ${padL(String(n), 4)}m  ${text}`);
  }

  // ---- the entries ----
  if (!entries.length) {
    console.log('\n  entries: NONE — the model would have said nothing tradable all day.');
    return;
  }

  console.log(`\n  entries: ${entries.length}`);
  console.log(
    '  ' + pad('time', 7) + pad('kind', 11) + pad('state', 11) + padL('price', 10) +
    padL('stop', 9) + padL('target', 9) + padL('EQ', 4) + padL('best', 8) + padL('worst', 8) +
    padL('close', 8) + '  result',
  );
  for (const e of entries) {
    const result = e.hitStopFirst ? 'STOPPED' : e.hitTarget ? 'target hit' : 'open at close';
    console.log(
      '  ' + pad(clock(e.at), 7) +
        pad(e.kind, 11) +
        pad(e.state, 11) +
        padL(e.price.toFixed(2), 10) +
        padL(e.stop?.toFixed(2) ?? '—', 9) +
        padL(e.target?.toFixed(2) ?? '—', 9) +
        padL(String(e.entryQuality), 4) +
        padL(e.bestAfterPct === null ? '—' : `${e.bestAfterPct >= 0 ? '+' : ''}${e.bestAfterPct}%`, 8) +
        padL(e.worstAfterPct === null ? '—' : `${e.worstAfterPct}%`, 8) +
        padL(e.closeAfterPct === null ? '—' : `${e.closeAfterPct >= 0 ? '+' : ''}${e.closeAfterPct}%`, 8) +
        '  ' + result,
    );
  }

  const won = entries.filter((e) => e.hitTarget).length;
  const lost = entries.filter((e) => e.hitStopFirst).length;
  const open = entries.length - won - lost;
  // Sum of what each entry returned IN THE STOCK, taking the stop when it was hit first and
  // the target when it was reached. Not a P&L — the option is where the leverage and the
  // spread live, and neither is knowable from a candle.
  const net = entries.reduce(
    (a, e) => a + (e.hitStopFirst ? (e.worstAfterPct ?? 0) : e.hitTarget ? (e.bestAfterPct ?? 0) : (e.closeAfterPct ?? 0)),
    0,
  );
  console.log(
    `  → ${won} reached target, ${lost} stopped, ${open} still open at the close; ` +
      `net ${net >= 0 ? '+' : ''}${net.toFixed(2)}% summed across entries, in the STOCK`,
  );
}

/* ------------------------------------------------------------------ the whole board --- */

/**
 * One line per stock, for replaying the universe rather than a handful of names.
 *
 * The per-symbol timeline above is the right output for three stocks and unreadable for two
 * hundred — it prints a dozen lines each. This keeps only what distinguishes one day from
 * another, so a finished session comes back as the board it WOULD have been, sorted the way the
 * Trend Day page sorts it.
 */
interface Summary {
  symbol: string;
  dayPct: number;
  peak: number;
  finalPhase: string;
  direction: string;
  formedAt: number | null;
  confirmedAt: number | null;
  entries: number;
  won: number;
  lost: number;
  netPct: number;
}

function summarise(symbol: string, r: ReturnType<typeof replaySymbol>): Summary | null {
  const { snapshots, entries } = r;
  if (!snapshots.length) return null;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const formed = snapshots.find((s) => s.conviction.phase === 'Forming');
  const confirmed = snapshots.find((s) => s.conviction.phase === 'Confirmed');

  return {
    symbol,
    dayPct: ((last.ltp - first.ltp) / first.ltp) * 100,
    peak: Math.max(...snapshots.map((s) => s.conviction.score)),
    finalPhase: last.conviction.phase,
    direction: last.conviction.direction,
    formedAt: formed?.at ?? null,
    confirmedAt: confirmed?.at ?? null,
    entries: entries.length,
    won: entries.filter((e) => e.hitTarget).length,
    lost: entries.filter((e) => e.hitStopFirst).length,
    netPct: entries.reduce(
      (a, e) => a + (e.hitStopFirst ? (e.worstAfterPct ?? 0) : e.hitTarget ? (e.bestAfterPct ?? 0) : (e.closeAfterPct ?? 0)),
      0,
    ),
  };
}

/**
 * Replay every stock in the F&O universe for one day.
 *
 * One candle request per symbol, eight at a time behind the same breaker the baseline uses —
 * the same ~208 requests the live scanner's boot seed spends, for a day of your choosing. Only
 * the summary of each replay is retained; the per-minute snapshots are dropped as each symbol
 * finishes, or two hundred sessions of them would sit in memory at once.
 */
async function replayAll(
  day: string,
  members: Array<{ symbol: string; equityKey: string }>,
  baseline: Awaited<ReturnType<typeof getBaseline>>['baseline'],
  cfg: MomentumConfig,
): Promise<{ rows: Summary[]; scanned: number; empty: number; failed: number }> {
  const rows: Summary[] = [];
  let scanned = 0;
  let empty = 0;
  let failed = 0;
  const isToday = day === istDay();

  await inBatches(members, 8, async (m) => {
    try {
      const candles = isToday
        ? await todaySession(m.equityKey, day, 1)
        : await historical(m.equityKey, 'minutes', 1, day, day);
      const forDay = candles.filter((c) => c.day === day);
      if (!forDay.length) {
        empty++;
        return;
      }
      const s = summarise(m.symbol, replaySymbol(m.symbol, forDay, baseline?.symbols[m.symbol], cfg));
      if (s) rows.push(s);
      scanned++;
      // A long run with no output looks like a hang, and this one takes a couple of minutes.
      if (scanned % 25 === 0) process.stderr.write(`  …${scanned} replayed\n`);
    } catch {
      failed++;
    }
  });

  return { rows, scanned, empty, failed };
}

function printBoard(day: string, out: Awaited<ReturnType<typeof replayAll>>, cfg: MomentumConfig): void {
  const phaseRank: Record<string, number> = { Confirmed: 3, Forming: 2, Faded: 1, None: 0 };
  const called = out.rows
    .filter((r) => r.peak >= cfg.thresholds.conviction.phase.formingScore && r.finalPhase !== 'None')
    .sort((a, b) => phaseRank[b.finalPhase] - phaseRank[a.finalPhase] || b.peak - a.peak);

  hr(`The board for ${day} — ${called.length} one-sided days out of ${out.scanned} stocks replayed`);

  // MOST OF THE UNIVERSE COMING BACK EMPTY IS AN UPSTREAM STATE, NOT A RESULT, and the two look
  // identical in a summary line. Upstox publishes a finished session into the historical endpoint
  // stock by stock over the hours after the close — measured at 00:05 IST, the previous session
  // was served for SBIN and not yet for PAYTM or RECLTD, while every day before it was complete.
  // Reporting "206 stocks had no candles" without saying that reads as a broken replay.
  if (out.empty > out.scanned) {
    console.log(
      `\n⚠️  ${out.empty} of ${out.empty + out.scanned} stocks returned no candles for ${day}.\n` +
      '    That is Upstox still publishing this session rather than a quiet market — a finished\n' +
      '    day lands in the historical endpoint stock by stock over the hours after the close.\n' +
      '    Replay it again later, or pick an earlier day, which will be complete.',
    );
    if (!called.length) return;
  }

  if (!called.length) {
    console.log('\nNothing held a one-sided shape on this day. On a rotational session that is the real answer.');
    return;
  }

  console.log(
    pad('stock', 13) + padL('day %', 8) + padL('peak', 6) + pad('  phase', 12) +
    pad('dir', 9) + pad('formed', 8) + pad('confirmed', 11) +
    padL('entries', 8) + padL('won', 5) + padL('lost', 6) + padL('net %', 9),
  );
  for (const r of called) {
    console.log(
      pad(r.symbol, 13) +
        padL(`${r.dayPct >= 0 ? '+' : ''}${r.dayPct.toFixed(2)}`, 8) +
        padL(r.peak.toFixed(0), 6) +
        pad('  ' + r.finalPhase, 12) +
        pad(r.direction, 9) +
        pad(r.formedAt ? clock(r.formedAt) : '—', 8) +
        pad(r.confirmedAt ? clock(r.confirmedAt) : '—', 11) +
        padL(String(r.entries), 8) +
        padL(String(r.won), 5) +
        padL(String(r.lost), 6) +
        padL(`${r.netPct >= 0 ? '+' : ''}${r.netPct.toFixed(2)}`, 9),
    );
  }

  const withEntries = called.filter((r) => r.entries > 0);
  const won = withEntries.reduce((a, r) => a + r.won, 0);
  const lost = withEntries.reduce((a, r) => a + r.lost, 0);
  const net = withEntries.reduce((a, r) => a + r.netPct, 0);
  console.log(
    `\n${called.filter((r) => r.finalPhase === 'Confirmed').length} confirmed · ` +
      `${called.filter((r) => r.finalPhase === 'Forming').length} forming · ` +
      `${called.filter((r) => r.finalPhase === 'Faded').length} faded` +
      (out.empty ? ` · ${out.empty} stocks had no candles` : '') +
      (out.failed ? ` · ${out.failed} failed` : ''),
  );
  console.log(
    `entries across those stocks: ${withEntries.reduce((a, r) => a + r.entries, 0)} — ` +
      `${won} reached target, ${lost} stopped, net ${net >= 0 ? '+' : ''}${net.toFixed(2)}% summed IN THE STOCK.`,
  );
  console.log(
    '\nThe ATR baseline used is TODAY\'s, not the one that existed on the replayed day — every\n' +
    'ATR-scaled reading (deepest dip, entry depth) carries that drift, which grows the further back\n' +
    'you go. The shape readings — adherence, crossings, efficiency — do not depend on it.',
  );
}

/* ---------------------------------------------------------------------------- main --- */

async function main() {
  if (!tokenSet()) {
    console.error('UPSTOX_ACCESS_TOKEN is not set — put your Analytics Token in api/.env');
    process.exit(1);
  }

  // BARE WORDS ARE ACCEPTED AS WELL AS FLAGS, because the flags do not survive npm.
  //
  // `npm run replay-trend -- --all --day 2026-08-11` runs `tsx trend-replay.ts 2026-08-11`:
  // npm's own option parser consumes `--all` (one of its config keys) and `--day` before the
  // script is reached, and only the bare date is passed through. The script then read that date
  // as a stock symbol and reported it was not in the F&O universe — a confusing answer to a
  // command that looked right.
  //
  // Rather than only documenting `npx tsx`, both spellings work: a positional YYYY-MM-DD is the
  // day, and a positional `all` is the universe. No stock is named either of those things.
  const args = process.argv.slice(2);
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  const dayIdx = args.indexOf('--day');
  const flagDay = dayIdx >= 0 ? args[dayIdx + 1] : undefined;
  // `dayIdx + 1` is 0 when there is no `--day`, which would silently eat the first symbol.
  const skip = dayIdx >= 0 ? dayIdx + 1 : -1;

  const bare = args.filter((a, i) => !a.startsWith('--') && i !== skip);
  const bareDay = bare.find((a) => ISO_DAY.test(a));
  const day = flagDay ?? bareDay ?? istDay();

  const all = args.includes('--all') || bare.some((a) => a.toLowerCase() === 'all');
  const symbols = bare
    .filter((a) => a !== bareDay && a.toLowerCase() !== 'all')
    .map((s) => s.toUpperCase());

  if (!symbols.length && !all) {
    console.error(
      'usage:\n' +
      '  npx tsx tools/trend-replay.ts BOSCHLTD NHPC [--day 2026-08-05]\n' +
      '  npx tsx tools/trend-replay.ts --all [--day 2026-08-05]      the whole F&O universe, one line each\n' +
      '\n' +
      '  npm run replay-trend -- all 2026-08-05                      same thing through npm, which\n' +
      '  npm run replay-trend -- BOSCHLTD 2026-08-05                 strips leading -- flags\n' +
      '\n' +
      'The day defaults to today (IST). Today is served straight from the intraday endpoint;\n' +
      'a past session only appears once Upstox has published it, which takes hours after the close.',
    );
    process.exit(1);
  }

  const cfg = await configRepository.get();
  const uni = await universe();

  hr('Replay');
  console.log(
    `day ${day}, ${all ? `the whole universe (${uni.members.length} stocks)` : `symbols ${symbols.join(', ')}`}, ` +
      `config version ${cfg.version}`,
  );
  console.log(
    `conviction: forming from minute ${cfg.thresholds.conviction.phase.minMinutesForming} at score ` +
      `${cfg.thresholds.conviction.phase.formingScore}, confirmed from minute ` +
      `${cfg.thresholds.conviction.phase.minMinutesConfirmed} at ${cfg.thresholds.conviction.phase.confirmScore} ` +
      `held ${cfg.thresholds.conviction.phase.confirmHoldMin}m`,
  );
  console.log(
    `budget multiplier: forming ×${cfg.signal.trend.budgetMultiplier.forming}, ` +
      `confirmed ×${cfg.signal.trend.budgetMultiplier.confirmed} on a base of ${cfg.signal.extension.atrUsedMax} ATR`,
  );

  let b = await getBaseline();
  if (!b.baseline) {
    console.log('\nno baseline — building it, this needs a couple of minutes…');
    await ensureBaseline({
      atrPeriod: cfg.thresholds.atrExpansion.period,
      trendLookback: cfg.thresholds.trendStructure.lookbackSessions,
    });
    b = await getBaseline();
  }
  const baseline = b.baseline;
  console.log(
    `baseline: ${baseline ? `${baseline.day}, ${Object.keys(baseline.symbols).length} symbols` : 'NONE — ATR-scaled readings will be unavailable'}`,
  );

  if (all) {
    console.log(`\nreplaying ${uni.members.length} stocks — one candle request each, eight at a time…`);
    printBoard(day, await replayAll(day, uni.members, baseline, cfg), cfg);
    return;
  }

  for (const symbol of symbols) {
    const member = uni.members.find((m) => m.symbol === symbol);
    if (!member) {
      console.log(`\n${symbol}: not in the F&O universe this scanner covers`);
      continue;
    }

    const sym = baseline?.symbols[symbol];
    if (!sym?.atr) console.log(`\n! ${symbol} has no ATR baseline — every ATR-scaled reading below will be blank`);

    // Today is only on the intraday endpoint and past days only on the historical one; asking
    // the wrong one answers 200 with an empty array, which reads as "nothing traded".
    const candles =
      day === istDay()
        ? await todaySession(member.equityKey, day, 1)
        : await historical(member.equityKey, 'minutes', 1, day, day);

    const forDay = candles.filter((c) => c.day === day);
    if (!forDay.length) {
      console.log(`\n${symbol}: Upstox served no 1-minute candles for ${day} (holiday, or the date is out of range)`);
      continue;
    }

    printSymbol(symbol, replaySymbol(symbol, forDay, sym, cfg), cfg);
  }

  hr('Reading this');
  console.log(
    'The `entries` table is the answer to "would the scanner have told me". Each row is a moment the\n' +
    'board would have shown Buy Call / Buy Put, and `best` / `worst` / `close` are what the STOCK did\n' +
    'afterwards — not the option, which needs a chain this replay does not have.\n\n' +
    'The extension line above it is the fix itself, measured: the share of the session the old fixed\n' +
    'ceiling would have called spent, against the conviction-scaled one. On a genuine trend day the\n' +
    'first number is large and the second is near zero, and the difference is every entry that used to\n' +
    'be refused.',
  );
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
