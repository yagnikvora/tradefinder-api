// The orchestrator, and the rate-limit budget it is shaped by.
//
// Upstox allows 2000 requests per 30 minutes PER ENDPOINT per user. Everything about the shape
// of this file is that ceiling:
//
//   PASS 1 — every symbol, every scan, TWO requests total.
//     One batched quote call covers ~221 instruments: every stock's share, every index's near
//     future, the four index levels, the Nifty and the VIX. Those readings extend the bar
//     aggregators, and then every indicator, every trend read and every pullback read in the
//     module is computed from bars already in memory. No candle request. So the trend and the
//     pullback state are known for the WHOLE universe on every scan, which is the property that
//     matters most here: the stock about to give its third pullback of the day is not
//     necessarily a stock anything has noticed yet, and a shortlist chosen before the pullback
//     was measured would be a shortlist of yesterday's ideas.
//
//   PASS 2 — candidates only, at most two requests each.
//     A candidate is a row that FIRED or is worth watching. It gets its option chain (cached
//     for `refresh.enrichMs`) and a bar resync against the exchange's own 1-minute candles
//     (cached for `refresh.resyncMs`), and is then re-evaluated. At the default 25 candidates
//     that is ~750 chain requests and ~360 candle requests per 30 minutes — 37% and 18% of
//     their respective ceilings, with the quote endpoint sitting at 6%.
//
// WHY PASS 2 RE-EVALUATES INSTEAD OF PATCHING. The resync can CHANGE the answer: a poll-built
// bar has approximate extremes, so a pullback that looked one paisa short of the zone may have
// touched it, and a confirmation candle's wick may have been longer than the polling saw. Those
// feed the pattern classifier and the ATR, so the only correct thing to do with exact bars is
// run the strategy again on them. Patching the option onto a signal computed from synthetic
// bars would publish a plan whose stop was derived from a low that never happened.
//
// AND WHY THE RESYNC IS BOUNDED. It could be run on the whole universe for 215 candle requests a
// cycle, which is 12,900 per 30 minutes against a 2000 ceiling. It cannot. The compromise is
// that the SCAN is approximate and every SIGNAL is exact, and `PullbackRow.enriched` says which
// a given row is.

import { marketOpen, minuteOfSession, istDay } from '../../momentum/session.js';
import { cache } from '../../momentum/cache.js';
import { inBatches } from '../../momentum/data/candles.js';
import { stockChain, type StockChain } from '../../momentum/data/option-chain.js';
import { CANDLE_ENDPOINT } from '../../momentum/data/candles.js';
import { breakerState } from '../../momentum/data/throttle.js';
import {
  barsOf, catchUpToday, ensureSeed, frameStore, framesFor, loadSeed, observe, readFrame,
  readFrames, resync, type FrameSeries, type SymbolFrames,
} from '../data/frames.js';
import { snapshot, type Snapshot, type Tick } from '../data/quotes.js';
import { universe, type Member, type Universe } from '../data/universe.js';
import { signalRepository } from '../data/signal.repository.js';
import { readPullback } from './pullback.service.js';
import { evaluateSignal, worthWatching, type SignalResult } from './signal.service.js';
import { readTrend } from './trend.service.js';
import type {
  PullbackBoard, PullbackConfig, PullbackRow, Timeframe, TimeframeRead, TrendRead, PullbackRead,
} from '../types.js';

/** Concurrency for the chain and resync fetches. What `upstox.ts` measured safe for a ladder. */
const FETCH_BATCH = 8;

const chainKey = (symbol: string) => `pullback:chain:${symbol}`;

interface CachedChain {
  at: number;
  chain: StockChain | null;
  error?: string;
}

/* ------------------------------------------------------------------------- pass 1 --- */

interface Staged {
  member: Member;
  tick: Tick;
  frames: SymbolFrames;
  reads: Partial<Record<Timeframe, TimeframeRead>>;
  series: Partial<Record<Timeframe, FrameSeries>>;
  trends: Partial<Record<Timeframe, TrendRead>>;
  pullbacks: Partial<Record<Timeframe, PullbackRead>>;
  /** The best result across signal timeframes, and whether it cleared every gate. */
  best: SignalResult | null;
  spotAdjust: number;
}

/** Filters applied before any indicator work, so a penny stock cannot occupy a candidate slot. */
function passesFilter(tick: Tick, cfg: PullbackConfig): boolean {
  if (tick.ltp < cfg.universe.minPrice) return false;
  // Turnover is cumulative for the day, so this only bites once there has been some trade.
  // Before the open everything reads zero and filtering then would empty the board.
  if (tick.turnoverCr > 0 && tick.turnoverCr < cfg.universe.minTurnoverCr) return false;
  return true;
}

/**
 * Read one symbol on every signal timeframe and keep the best result.
 *
 * "Best" is the highest confidence among the timeframes that FIRED, and among the rest the
 * highest confidence at all — so a row with a live 5-minute signal is never displaced by a
 * better-scoring 15-minute watch candidate. Ranking fired above unfired rather than purely by
 * score is what keeps the signal list from being reordered by rows that are not signals.
 */
async function stageOne(
  member: Member,
  snap: Snapshot,
  cfg: PullbackConfig,
  chain: StockChain | null,
  nowMs: number,
): Promise<Staged | null> {
  const tick = snap.series.get(member.symbol);
  if (!tick || !passesFilter(tick, cfg)) return null;

  const f = framesFor(member.symbol, member.seriesKey, nowMs);
  const { reads, series } = readFrames(f, cfg);

  const spotTick = member.spotKey ? snap.spot.get(member.symbol) : undefined;
  const spotAdjust = spotTick && spotTick.ltp > 0 ? +(spotTick.ltp - tick.ltp).toFixed(2) : 0;

  const trends: Partial<Record<Timeframe, TrendRead>> = {};
  const pullbacks: Partial<Record<Timeframe, PullbackRead>> = {};
  let best: SignalResult | null = null;

  for (const tf of cfg.timeframes.signal) {
    const read = reads[tf];
    const s = series[tf];
    if (!read || !s) continue;

    const bars = barsOf(f, tf);
    const trend = readTrend({ read, bars, spreadBps: tick.hasBook ? tick.spreadBps : null, cfg });
    trends[tf] = trend;

    // The pullback is read in the trend's direction, or — when the trend was rejected — in the
    // direction the averages point anyway, so a vetoed row still produces a watch entry rather
    // than vanishing from the board entirely.
    const dir: 1 | -1 =
      trend.state === 'Bearish' ? -1
        : trend.state === 'Bullish' ? 1
          : (read.ema.ema9 ?? 0) >= (read.ema.ema20 ?? 0) ? 1 : -1;

    const pullback = readPullback({
      bars, series: s, timeframe: tf, direction: dir, avgVolume: read.avgVolume, cfg,
    });
    pullbacks[tf] = pullback;

    const result = evaluateSignal({
      symbol: member.symbol,
      timeframe: tf,
      bars,
      read,
      trend,
      pullback,
      frames: reads,
      price: tick.ltp,
      chain,
      spotAdjust,
      lotSize: member.lotSize,
      lastFiredAt: await signalRepository.lastFiredAt(member.symbol, tf),
      cfg,
      nowMs,
    });
    if (!result) continue;

    if (
      !best ||
      (result.fired && !best.fired) ||
      (result.fired === best.fired && result.signal.score.total > best.signal.score.total)
    )
      best = result;
  }

  return { member, tick, frames: f, reads, series, trends, pullbacks, best, spotAdjust };
}

/* --------------------------------------------------------------- candidate policy --- */

/**
 * Who gets an option chain and an exact-bar resync this scan.
 *
 * Fired rows first, unconditionally — those are about to be published as orders and must be
 * computed from exchange bars. Then the watch candidates by confidence, filling whatever is
 * left of `enrichLimit`. Anything below that stays on quote-tier data and says so.
 */
export function chooseCandidates(staged: Staged[], cfg: PullbackConfig): Staged[] {
  const limit = cfg.universe.enrichLimit;
  if (limit <= 0) return [];

  const fired = staged.filter((s) => s.best?.fired);
  const watching = staged
    .filter((s) => s.best && !s.best.fired && worthWatching(s.best, cfg))
    .sort((a, b) => (b.best?.signal.score.total ?? 0) - (a.best?.signal.score.total ?? 0));

  return [...fired, ...watching].slice(0, limit);
}

/* ------------------------------------------------------------------------- pass 2 --- */

/** Fetch (or reuse) one candidate's chain. Failures are cached, so a refusal is not retried. */
async function fetchChain(m: Member, cfg: PullbackConfig, nowMs: number): Promise<CachedChain> {
  const k = chainKey(m.symbol);
  const hit = await cache.get<CachedChain>(k);
  if (hit) return hit;

  let value: CachedChain;
  try {
    value = { at: nowMs, chain: await stockChain(m.symbol, m.optionKey, nowMs) };
  } catch (e) {
    value = { at: nowMs, chain: null, error: String((e as Error).message) };
  }
  await cache.set(k, value, cfg.refresh.enrichMs);
  return value;
}

/* ------------------------------------------------------------------------ assembly --- */

function dominant(trends: Partial<Record<Timeframe, TrendRead>>): PullbackRow['dominant'] {
  let best: PullbackRow['dominant'] = null;
  for (const tfStr of Object.keys(trends)) {
    const tf = Number(tfStr) as Timeframe;
    const t = trends[tf];
    if (!t) continue;
    // A real trend outranks a stronger-scoring rejected one: `strength` is reported even when a
    // gate failed (so the near misses are visible), and the "Strongest Trend" card must not put
    // a vetoed 82 above a clean 74.
    const better =
      !best ||
      (t.state !== 'None' && best.state === 'None') ||
      ((t.state !== 'None') === (best.state !== 'None') && t.strength > best.strength);
    if (better) best = { timeframe: tf, state: t.state, strength: t.strength };
  }
  return best;
}

/**
 * Flatten one timeframe's read into the compact form the board's columns use.
 *
 * The timeframe chosen is the one the row is PRESENTED by — the signal's, else the watch
 * candidate's, else the strongest trend's — so the 9 EMA in the table is the 9 EMA the signal was
 * computed from. Showing a fixed timeframe instead would put a 5-minute EMA next to a 15-minute
 * entry, which is the kind of mismatch nobody notices and everybody acts on.
 */
function readoutOf(s: Staged, tf: Timeframe | null): PullbackRow['readout'] {
  if (tf === null) return null;
  const r = s.reads[tf];
  if (!r) return null;
  return {
    timeframe: tf,
    ema9: r.ema.ema9,
    ema20: r.ema.ema20,
    ema50: r.ema.ema50,
    ema200: r.ema.ema200,
    vwap: r.vwap,
    atr: r.atr,
    adx: r.adx.adx,
    adxRising: r.adx.rising,
    participation: r.participation,
    volumeRatio: r.volumeRatio,
    vwapDistanceAtr: r.distance.vwapAtr,
    ema20DistanceAtr: r.distance.ema20Atr,
    ema9SlopeAtrPerBar: r.slope.ema9AtrPerBar,
    warming: r.warming,
  };
}

function buildRow(
  s: Staged,
  enriched: boolean,
  chainError: string | undefined,
  cfg: PullbackConfig,
): PullbackRow {
  const warnings: string[] = [];
  if (chainError) warnings.push(`no option chain this cycle: ${chainError}`);

  // Which timeframes are still warming is worth saying out loud. A 15-minute frame that cannot
  // be read looks identical on screen to a 15-minute frame with no setup, and the two are
  // opposite: the first is "come back later", the second is "there is nothing here".
  for (const tfStr of Object.keys(s.reads)) {
    const r = s.reads[Number(tfStr) as Timeframe];
    if (r?.warming && r.note) warnings.push(`${tfStr}m: ${r.note}`);
  }
  if (!s.frames.caughtUp)
    warnings.push("today's bars have not been fetched from the exchange yet — extremes are from the quote poll and run slightly narrow");

  const best = s.best;
  const fired = best?.fired ? best.signal : null;
  // `worthWatching` is applied HERE and not only when choosing candidates, which it originally
  // was — and the omission made the watchlist useless. Every row with a computable result became a
  // watch entry, so the board reported 197 of 209 symbols as "upcoming pullbacks", which is a
  // sentence with no information in it. The bar for the watchlist is a real trend, a retracement
  // that is at least on its way, and a score that would clear the signal floor if the pullback
  // completed: what it does NOT require is the confirmation candle, because that is the thing
  // being waited for.
  const watch = best && !best.fired && worthWatching(best, cfg) ? best.signal : null;
  const dom = dominant(s.trends);

  return {
    symbol: s.member.symbol,
    name: s.member.name,
    kind: s.member.kind,
    sector: s.member.sector,
    price: s.tick.ltp,
    prevClose: s.tick.prevClose,
    changePct: s.tick.changePct,
    volume: s.tick.volume,
    turnoverCr: s.tick.turnoverCr,
    spreadBps: s.tick.hasBook ? s.tick.spreadBps : null,
    readout: readoutOf(s, best?.signal.timeframe ?? dom?.timeframe ?? null),
    frames: s.reads,
    trends: s.trends,
    pullbacks: s.pullbacks,
    signal: fired,
    watch,
    dominant: dom,
    enriched,
    warnings,
  };
}

/* -------------------------------------------------------------------------- public --- */

/**
 * One full scan.
 *
 * Called by the scheduler on the scan interval and by the controller on a cache miss. Every
 * upstream call it makes is counted in the header comment; if you add one, update it.
 */
export async function runScan(cfg: PullbackConfig, nowMs = Date.now()): Promise<PullbackBoard> {
  const warnings: string[] = [];
  const uni: Universe = await universe(cfg.universe, nowMs);

  // The seed is the historical part of every frame and there is no scanner without it. It is
  // restored from disk first — that costs nothing — and only rebuilt when the disk copy is from
  // an earlier session, because a rebuild is ~215 candle requests and cannot run per scan.
  const store = frameStore(nowMs);
  if (!store.symbols.size) {
    const seedDay = await loadSeed(uni.members, nowMs);
    if (!seedDay) warnings.push('no EMA seed on disk yet — building it now; the board is dark until it lands');
  }

  const seeded = [...store.symbols.values()].filter((f) => f.seededThrough !== null).length;
  if (seeded < uni.members.length * 0.5) {
    void ensureSeed(uni.members, cfg, nowMs).catch(() => {});
    warnings.push(
      `the EMA seed covers ${seeded}/${uni.members.length} symbols — a 200-period EMA on 15 minutes spans eight ` +
      'sessions and cannot be computed from today, so those rows stay dark until the seed completes. ' +
      'POST /pullback/seed/rebuild, or wait for the scheduled build.',
    );
  }
  const seedFailures = Object.keys(store.seedFailures).length;
  if (seedFailures) warnings.push(`${seedFailures} symbols have no seed (Upstox would not serve their history).`);

  const snap = await snapshot(uni, nowMs);

  // Fold this reading into every aggregator BEFORE anything reads a frame, so a bar that just
  // closed is visible to this scan rather than to the next one. On a 3-minute timeframe at a
  // 30-second poll, deferring it would make every signal up to half a minute late — which is
  // most of the freshness the whole module is built to preserve.
  for (const m of uni.members) {
    const tick = snap.series.get(m.symbol);
    if (!tick) continue;
    observe(framesFor(m.symbol, m.seriesKey, nowMs), tick, snap.day, snap.minute, cfg.timeframes.computed);
  }

  // Today's exact bars, once. Also the restart path: the store holds no bars for today after a
  // boot, and re-fetching them is both cheaper and MORE accurate than having persisted the
  // poll-built ones would have been.
  const needCatchUp = [...store.symbols.values()].some((f) => !f.caughtUp && f.seededThrough !== null);
  if (needCatchUp && snap.minute > 0) {
    const cu = await catchUpToday(uni.members, cfg, nowMs);
    const missed = Object.keys(cu.failures).length;
    if (missed) warnings.push(`${missed} symbols' intraday candles could not be fetched — their bars are poll-built for now.`);
  }

  /* -------------------------------------------------------------------- pass one --- */

  const staged: Staged[] = [];
  for (const m of uni.members) {
    // The chain from a previous cycle, when one is still warm. Reading it here rather than only
    // in pass two means a row whose chain is cached gets its option on the FIRST pass, so a
    // signal is never published without a contract merely because its slot was taken.
    const cached = await cache.get<CachedChain>(chainKey(m.symbol));
    const s = await stageOne(m, snap, cfg, cached?.chain ?? null, nowMs);
    if (s) staged.push(s);
  }

  /* -------------------------------------------------------------------- pass two --- */

  const candidates = chooseCandidates(staged, cfg);
  const chainErrors = new Map<string, string>();
  const enrichedSet = new Set<string>();

  if (candidates.length) {
    const canResync = breakerState(CANDLE_ENDPOINT).open === false;

    await inBatches(candidates, FETCH_BATCH, async (s) => {
      const [chain] = await Promise.all([
        fetchChain(s.member, cfg, nowMs),
        // Exact bars, so the plan a signal publishes is not derived from a low the polling
        // invented. Skipped when the candle breaker is open — a resync is a nicety and the
        // seed is not, so it must never spend the budget the seed needs.
        canResync && nowMs - s.frames.resyncedAt > cfg.refresh.resyncMs
          ? resync(s.member, cfg, nowMs).catch(() => {})
          : Promise.resolve(),
      ]);
      if (chain.error) chainErrors.set(s.member.symbol, chain.error);
      enrichedSet.add(s.member.symbol);
    });

    // Re-run the strategy on the corrected bars with the chain in hand. Not a patch: the resync
    // can move an extreme, which moves the ATR, the zone, the pattern classification and the
    // stop — so anything short of re-evaluating would publish a plan built on the old numbers.
    for (let k = 0; k < staged.length; k++) {
      const s = staged[k];
      if (!enrichedSet.has(s.member.symbol)) continue;
      const chain = (await cache.get<CachedChain>(chainKey(s.member.symbol)))?.chain ?? null;
      const again = await stageOne(s.member, snap, cfg, chain, nowMs);
      if (again) staged[k] = again;
    }
  }

  /* -------------------------------------------------------------------- assembly --- */

  const rows = staged
    .map((s) => buildRow(s, enrichedSet.has(s.member.symbol), chainErrors.get(s.member.symbol), cfg))
    .filter((r) => (r.dominant?.strength ?? 0) >= cfg.output.minTrendStrength)
    .sort((a, b) => {
      // Fired signals first, then watch candidates, then everything else — each group by
      // confidence. The board is read top-down and the top has to be the actionable end of it.
      const rank = (r: PullbackRow): number => (r.signal ? 2 : r.watch ? 1 : 0);
      return (
        rank(b) - rank(a) ||
        (b.signal?.score.total ?? b.watch?.score.total ?? b.dominant?.strength ?? 0) -
        (a.signal?.score.total ?? a.watch?.score.total ?? a.dominant?.strength ?? 0)
      );
    });

  /* ----------------------------------------------------------------- log, settle --- */
  //
  // THIS STRATEGY NO LONGER RAISES ALERTS. The scan used to fan its confirmations, phase changes
  // and settled outcomes into `alerts/alert.engine.ts`, which pushed them to Telegram, Discord and
  // the webhook. That was removed on purpose: the EMA pullback board is something to READ, and its
  // events were not worth an interruption.
  //
  // The alert machinery itself is untouched and still wired up — the engine, both phone channels,
  // the dedupe, the trend gate, `GET /pullback/alerts` and `POST /pullback/alerts/test` all work
  // exactly as before. Nothing in this module feeds them any more, so the feed stays empty until
  // some other strategy calls `fromRows` / `fromSignal` / `fromOutcome`. Restoring the old
  // behaviour is re-adding those three calls below; nothing else was taken out.
  //
  // The signal LOG is not alerting and stays: `/pullback/history`, the win rate and the outcome
  // tracking on the board all read from it.

  const today = istDay(nowMs);

  for (const r of rows) {
    if (!r.signal) continue;

    // ONLY TODAY'S CONFIRMATIONS ARE LOGGED, and this gate is load-bearing rather than tidy. The
    // controller scans on a cache miss whatever the clock says, so a request at 00:36 IST — after
    // the day has rolled but before the session opens — evaluates the strategy against frames that
    // end at yesterday's 15:25 close. Every setup that was live at the close then reads as a fresh
    // signal and gets written into TODAY's log, so the board opens the morning claiming a dozen
    // signals it never gave and a win rate computed over trades nobody could have taken.
    //
    // The row still CARRIES the signal — the board is an honest snapshot of the last bars that
    // exist, and its age reads as "9h 10m ago", which says what it is. It just does not enter the
    // record.
    if (istDay(r.signal.firedAt) !== today) continue;

    const record = await signalRepository.record(r.signal, nowMs);
    // The row carries the tracked outcome rather than the freshly-constructed one, so a signal
    // whose target has already been hit does not render as though it were still open.
    r.signal.outcome = record.outcome;
  }

  // Targets and stops are still tracked on the live price — the board and the history need the
  // settled outcome. It just is not announced anywhere now.
  const prices = new Map<string, number>(rows.map((r) => [r.symbol, r.price]));
  await signalRepository.settle(prices, nowMs);

  const logged = await signalRepository.forDay(today);

  // Before the first bar of a session the frames end at the PREVIOUS session's close, so every
  // setup that was live at 15:30 still reads as one. That is a legitimate snapshot — it is the last
  // state that exists — but it is not today's, and the counters would otherwise imply it was:
  // "10 bullish signals" beside "0 fired today" is a contradiction a reader has to resolve from a
  // timestamp buried in a table cell.
  if (snap.minute === 0)
    warnings.push(
      'No bar has closed today yet, so every reading on this board is from the previous session\'s ' +
      'final bars. Setups shown as confirmed were confirmed at yesterday\'s close — their age says so, ' +
      'and none of them has been logged, because a confirmation from a session that has ended is ' +
      'not an entry.',
    );

  const breaker = breakerState(CANDLE_ENDPOINT);
  if (breaker.open)
    warnings.push(
      `the Upstox candle endpoint is rate limited for another ${Math.ceil(breaker.retryAfterMs / 1000)}s — ` +
      'bar resyncs are paused, so signal extremes are poll-built until it clears',
    );

  return {
    asOf: nowMs,
    configVersion: cfg.version,
    universeSize: uni.members.length,
    scanned: rows.length,
    enriched: enrichedSet.size,
    bullishSignals: rows.filter((r) => r.signal?.direction === 1).length,
    bearishSignals: rows.filter((r) => r.signal?.direction === -1).length,
    watching: rows.filter((r) => r.watch).length,
    firedToday: logged.length,
    market: {
      asOf: nowMs,
      marketOpen: marketOpen(nowMs),
      minuteOfSession: minuteOfSession(nowMs),
      nifty: snap.nifty
        ? {
            level: snap.nifty.ltp,
            changePct: snap.nifty.changePct,
            // The index itself publishes no VWAP, so this is only answerable when NIFTY is in
            // the scanned universe and its future has been read. Null, not false.
            aboveVwap: (() => {
              const f = snap.series.get('NIFTY');
              return f && f.vwap > 0 ? f.ltp > f.vwap : null;
            })(),
          }
        : null,
      indiaVix: snap.vix ? { level: snap.vix.ltp, changePct: snap.vix.changePct } : null,
      breadth: breadthOf(rows),
    },
    rows,
    warnings,
  };
}

/**
 * Advance/decline across the scanned universe.
 *
 * Computed from the rows this module already has rather than from a separate breadth service:
 * the universe here is not the same as the momentum module's — it carries four indices, which
 * are not constituents and must not be counted as advancing stocks — so borrowing that reading
 * would quietly shift the ratio.
 */
function breadthOf(rows: PullbackRow[]): PullbackBoard['market']['breadth'] {
  const stocks = rows.filter((r) => r.kind === 'stock');
  const withVwap = stocks.filter((r) => {
    const f = r.frames[5] ?? r.frames[3] ?? r.frames[15];
    return f?.vwap != null && f.close != null;
  });
  const above = withVwap.filter((r) => {
    const f = r.frames[5] ?? r.frames[3] ?? r.frames[15];
    return f && f.close !== null && f.vwap !== null && f.close > f.vwap;
  }).length;

  return {
    advances: stocks.filter((r) => r.changePct > 0).length,
    declines: stocks.filter((r) => r.changePct < 0).length,
    pctAboveVwap: withVwap.length ? +((above / withVwap.length) * 100).toFixed(1) : null,
  };
}

/** The chart series for one symbol and timeframe — what the detail page draws. */
export function chartSeries(symbol: string, seriesKey: string, tf: Timeframe, cfg: PullbackConfig, nowMs = Date.now()) {
  const f = framesFor(symbol, seriesKey, nowMs);
  const bars = barsOf(f, tf);
  const read = readFrame(f, tf, cfg);
  return { bars, read };
}
