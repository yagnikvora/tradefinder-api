// The backtest — the same strategy, walked over history.
//
// THE ONE PROPERTY THAT MATTERS. This file contains no strategy logic. It fetches candles, walks
// them, and calls `readFromBars`, `readTrend`, `readPullback`, `evaluateSignal`, `buildPlan` —
// the identical functions the live scanner calls, with the identical config. A backtest that
// reimplements the rules is testing a second strategy that resembles the first, and every
// discrepancy between them lands in the same direction: the replay looks better than the thing
// that trades. Sharing the code is the only defence against that, and it is why the services are
// pure functions of bars rather than methods on a scanner.
//
// THE WINDOW IS THE SAME 320 BARS THE LIVE STORE KEEPS, which is not an optimisation — it is a
// fidelity requirement. The live scanner holds a rolling 320-bar array and recomputes its EMAs
// from scratch on every scan, so its 200-period EMA is seeded from the SMA of the oldest 200 bars
// IN THAT WINDOW and the seed point slides forward with the session. A backtest that fed the
// whole history in at once would compute a differently-seeded 200 EMA and produce trades the
// live engine would never take.
//
// WHAT IS HONESTLY NOT MODELLED, listed because a backtest's credibility is entirely in what it
// admits:
//
//   THE OPTION. There is no historical option chain on this API — Upstox serves the chain as of
//   now and nothing else — so every trade below is measured in R ON THE UNDERLYING. Options
//   amplify both ends and add decay and volatility risk that R does not capture, so a 2R
//   underlying result is NOT a 2R option result. The live scanner's contract selection is the
//   part of this module that cannot be backtested here, and pretending otherwise by modelling a
//   premium off a Black-Scholes reconstruction would be inventing the most important number.
//
//   SLIPPAGE AND COSTS. Entry is the confirmation bar's close and exits are at the level. Real
//   fills are worse, brokerage and STT are real, and on a 1.5R plan they matter.
//
//   INTRABAR SEQUENCE. When one bar's range contains both the stop and the target there is no
//   way to know which came first, and it resolves as the STOP. That is the assumption that
//   cannot flatter the record, and it is the same rule the live outcome tracker uses.
//
//   SURVIVORSHIP. The universe is today's F&O list. A stock removed from the segment last month
//   is not in it, and its trades are not here.

import { historical } from '../../momentum/data/candles.js';
import { isoDaysBefore, SESSION_MINUTES } from '../../momentum/session.js';
import { MAX_BARS, computeSeries, readFromBars } from '../data/frames.js';
import { fromCandle, resample, type Bar } from '../indicators/series.js';
import { buildPlan, realisedR } from '../engine/risk.service.js';
import { readPullback } from '../engine/pullback.service.js';
import { evaluateSignal } from '../engine/signal.service.js';
import { readTrend } from '../engine/trend.service.js';
import type {
  BacktestRequest, BacktestResult, BacktestTrade, ConfidenceBand, PullbackConfig, Timeframe,
} from '../types.js';

/** Upstox serves at most a 30-day range of 1-minute candles per request. */
const MAX_RANGE_DAYS = 28;

/** Bars of history prepended before the first tradable bar, so the averages start warm. */
const WARMUP_BARS = MAX_BARS;

interface OpenTrade {
  direction: 1 | -1;
  entryAt: number;
  /** The IST session the entry belongs to. What the intraday close-out is tested against. */
  entryDay: string;
  entry: number;
  stop: number;
  target: number;
  score: number;
  band: ConfidenceBand;
  mfe: number;
  mae: number;
}

/**
 * Fetch the 1-minute series, in as many requests as the range needs.
 *
 * The warm-up is prepended by asking for extra calendar days BEFORE `from` rather than by
 * starting the walk late, so the first tradable session is evaluated with the same amount of
 * history behind it as the last one. Starting the walk on the requested date with cold averages
 * would silently exclude the first eight sessions of every backtest, and the exclusion would
 * look like "no setups that week".
 */
async function fetchSeries(
  instrumentKey: string,
  from: string,
  to: string,
  timeframe: Timeframe,
): Promise<{ bars: Bar[]; warnings: string[] }> {
  const warnings: string[] = [];
  // Enough calendar days to hold WARMUP_BARS of the requested timeframe, plus weekends.
  const warmupSessions = Math.ceil((WARMUP_BARS * timeframe) / SESSION_MINUTES) + 2;
  const start = isoDaysBefore(Math.ceil(warmupSessions * 1.5), from);

  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = start;
  while (cursor <= to) {
    const end = isoDaysBefore(-MAX_RANGE_DAYS, cursor);
    chunks.push({ from: cursor, to: end > to ? to : end });
    cursor = isoDaysBefore(-(MAX_RANGE_DAYS + 1), cursor);
  }

  const oneMinute: Bar[] = [];
  for (const c of chunks) {
    try {
      const candles = await historical(instrumentKey, 'minutes', 1, c.from, c.to);
      for (const k of candles) if (k.minute >= 0 && k.minute <= SESSION_MINUTES) oneMinute.push(fromCandle(k));
    } catch (e) {
      warnings.push(`${c.from}..${c.to} could not be fetched: ${String((e as Error).message)}`);
    }
  }

  oneMinute.sort((a, b) => a.at - b.at);
  return { bars: timeframe === 1 ? oneMinute : resample(oneMinute, timeframe), warnings };
}

/**
 * Replay the strategy.
 *
 * One position at a time, per the way the signal is meant to be used: the stop and the target are
 * defined by one pullback's structure, and stacking a second entry on top would be measuring a
 * different strategy from the one the scanner publishes.
 */
export async function backtest(
  req: BacktestRequest,
  instrumentKey: string,
  lotSize: number | null,
  cfg: PullbackConfig,
): Promise<BacktestResult> {
  const { bars, warnings } = await fetchSeries(instrumentKey, req.from, req.to, req.timeframe);

  if (bars.length < WARMUP_BARS / 2)
    return emptyResult(req, [
      ...warnings,
      `only ${bars.length} ${req.timeframe}-minute bars were served for this range — not enough to warm a 200-period average`,
    ]);

  const trades: BacktestTrade[] = [];
  const cooldownMs = cfg.pullback.cooldownMin * 60_000;
  let lastFiredAt: number | null = null;
  let open: OpenTrade | null = null;

  const firstTradable = bars.findIndex((b) => b.day >= req.from);
  const start = Math.max(WARMUP_BARS, firstTradable < 0 ? bars.length : firstTradable);
  const sessions = new Set(bars.slice(start).filter((b) => b.day <= req.to).map((b) => b.day));

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.day > req.to) break;

    /* ------------------------------------------------------------- manage the open --- */

    if (open) {
      // A bar from a LATER session closes the trade at the previous session's last bar, before any
      // of this bar's prices are looked at. The first version tested "is the next bar a new day"
      // against the bar being MANAGED, which meant a position opened on a session's final bar was
      // first managed on the following morning's opening bar and then ran on into that session —
      // one replayed trade came back with a 1,070-minute hold. An intraday strategy does not survive
      // the close, and attributing the next morning's gap to a signal that had nothing to say about
      // it is the single easiest way for a backtest to invent an edge.
      if (bar.day !== open.entryDay) {
        const previous = bars[i - 1];
        trades.push(close(open, previous, previous.close, 'sessionEnd'));
        open = null;
      }
    }

    if (open) {
      const favourable = open.direction === 1 ? bar.high : bar.low;
      const adverse = open.direction === 1 ? bar.low : bar.high;
      open.mfe = open.direction === 1 ? Math.max(open.mfe, favourable) : Math.min(open.mfe, favourable);
      open.mae = open.direction === 1 ? Math.min(open.mae, adverse) : Math.max(open.mae, adverse);

      const hitStop = open.direction === 1 ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTarget = open.direction === 1 ? bar.high >= open.target : bar.low <= open.target;
      // Stop first when both are inside one bar. There is no intrabar sequence in a candle, and
      // this is the assumption that cannot flatter the record.
      const exit = hitStop ? open.stop : hitTarget ? open.target : null;
      const lastOfSession = i + 1 >= bars.length || bars[i + 1].day !== bar.day;

      if (exit !== null || lastOfSession) {
        const price = exit ?? bar.close;
        trades.push(close(open, bar, price, exit === null ? 'sessionEnd' : hitStop ? 'stop' : 'target'));
        open = null;
      }
    }

    if (open) continue;

    /* ----------------------------------------------------------------- look for one --- */

    const window = bars.slice(Math.max(0, i - MAX_BARS + 1), i + 1);
    const series = computeSeries(window);
    const read = readFromBars(window, req.timeframe, cfg);
    if (read.warming) continue;

    // The book cannot be reconstructed from candles, so the bid-ask veto is not applied. Passing
    // null rather than a fabricated tight spread is the honest form: it says the gate did not
    // run, where a made-up 5 bps would say it ran and passed.
    const trend = readTrend({ read, bars: window, spreadBps: null, cfg });
    if (trend.state === 'None') continue;

    const direction: 1 | -1 = trend.state === 'Bullish' ? 1 : -1;
    const pullback = readPullback({
      bars: window, series, timeframe: req.timeframe, direction, avgVolume: read.avgVolume, cfg,
    });

    const result = evaluateSignal({
      symbol: req.symbol,
      timeframe: req.timeframe,
      bars: window,
      read,
      trend,
      pullback,
      // Only this timeframe is replayed, so no higher one can be aligned. That makes every score
      // here a LOWER bound on what the live scanner would have given the same setup — the
      // alignment bonus is simply never awarded — which is the safe direction for the difference.
      frames: { [req.timeframe]: read },
      price: bar.close,
      chain: null,
      spotAdjust: 0,
      lotSize,
      lastFiredAt,
      cfg,
      nowMs: bar.at,
    });

    if (!result?.fired) continue;

    const s = result.signal;
    if (lastFiredAt !== null && s.firedAt - lastFiredAt < cooldownMs) continue;

    const plan = buildPlan({ bars: window, read, pullback, direction, entry: s.entry, cfg });
    if (!plan) continue;

    lastFiredAt = s.firedAt;
    open = {
      direction,
      entryAt: bar.at,
      entryDay: bar.day,
      entry: s.entry,
      stop: plan.stop.recommended.price,
      target: plan.target.primary.price,
      score: s.score.total,
      band: s.score.band,
      mfe: s.entry,
      mae: s.entry,
    };
  }

  return summarise(req, trades, sessions.size, warnings);
}

function close(t: OpenTrade, bar: Bar, price: number, outcome: BacktestTrade['outcome']): BacktestTrade {
  const risk = t.direction === 1 ? t.entry - t.stop : t.stop - t.entry;
  return {
    symbol: '',
    direction: t.direction,
    entryAt: t.entryAt,
    entry: +t.entry.toFixed(2),
    stop: +t.stop.toFixed(2),
    target: +t.target.toFixed(2),
    exitAt: bar.at,
    exit: +price.toFixed(2),
    r: realisedR(t.entry, price, t.stop, t.direction),
    holdMin: Math.max(0, Math.round((bar.at - t.entryAt) / 60_000)),
    outcome,
    score: t.score,
    band: t.band,
    mfeR: risk > 0 ? +((t.direction === 1 ? t.mfe - t.entry : t.entry - t.mfe) / risk).toFixed(2) : 0,
    maeR: risk > 0 ? +((t.direction === 1 ? t.mae - t.entry : t.entry - t.mae) / risk).toFixed(2) : 0,
  };
}

const emptyResult = (req: BacktestRequest, warnings: string[]): BacktestResult => ({
  request: req,
  sessions: 0,
  trades: [],
  stats: {
    count: 0, wins: 0, losses: 0, winRatePct: null, averageR: null, profitFactor: null,
    maxDrawdownR: 0, averageHoldMin: null, expectancyR: null, bestR: 0, worstR: 0,
  },
  equity: [],
  byBand: [],
  warnings,
});

/**
 * The statistics.
 *
 * Every ratio is null rather than 0 when its denominator is empty. A profit factor of "0.00"
 * because nothing lost yet is a false statement about a strategy, and it is exactly the kind
 * that gets screenshotted — the same rule `signal.repository.ts` applies to the live win rate.
 *
 * `maxDrawdownR` is measured on the cumulative-R curve rather than on a rupee equity curve,
 * because position sizing is not part of this module: R is the unit the strategy is expressed in,
 * and converting to money would require inventing a risk-per-trade the user never specified.
 */
function summarise(
  req: BacktestRequest,
  trades: BacktestTrade[],
  sessions: number,
  warnings: string[],
): BacktestResult {
  for (const t of trades) t.symbol = req.symbol;

  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.r, 0));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity: BacktestResult['equity'] = [];
  for (const t of trades) {
    cumulative += t.r;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    equity.push({ at: t.exitAt, r: +cumulative.toFixed(3) });
  }

  const bands: ConfidenceBand[] = ['Excellent', 'Strong', 'Medium', 'Weak'];
  const byBand = bands.map((band) => {
    const inBand = trades.filter((t) => t.band === band);
    const bandWins = inBand.filter((t) => t.r > 0).length;
    return {
      band,
      count: inBand.length,
      winRatePct: inBand.length ? +((bandWins / inBand.length) * 100).toFixed(1) : null,
      averageR: inBand.length ? +(inBand.reduce((a, t) => a + t.r, 0) / inBand.length).toFixed(3) : null,
    };
  });

  if (trades.length && trades.length < 20)
    warnings.push(
      `${trades.length} trades is too few to draw a conclusion from — a win rate over this sample has a ` +
      'confidence interval wide enough to contain almost any hypothesis. Widen the date range or the universe.',
    );
  warnings.push(
    'Results are measured in R on the UNDERLYING. There is no historical option chain on this API, so the ' +
    'contract selection — decay, spread and the delta band — is not modelled here and a 2R stock move is not ' +
    'a 2R option result.',
  );

  return {
    request: req,
    sessions,
    trades,
    stats: {
      count: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
      averageR: trades.length ? +(trades.reduce((a, t) => a + t.r, 0) / trades.length).toFixed(3) : null,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null,
      maxDrawdownR: +maxDrawdown.toFixed(3),
      averageHoldMin: trades.length ? Math.round(trades.reduce((a, t) => a + t.holdMin, 0) / trades.length) : null,
      expectancyR: trades.length ? +(cumulative / trades.length).toFixed(3) : null,
      bestR: trades.length ? Math.max(...trades.map((t) => t.r)) : 0,
      worstR: trades.length ? Math.min(...trades.map((t) => t.r)) : 0,
    },
    equity,
    byBand,
    warnings,
  };
}
