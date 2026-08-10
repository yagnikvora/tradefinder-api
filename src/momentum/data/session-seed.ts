// Rebuilding today's session from the exchange, so the conviction layer stops depending on
// having been running.
//
// THE PROBLEM THIS FIXES. Everything in `session-state.ts` is accumulated by the 15-second
// poll, and the poll only runs while the market is open. So the Trend Day board — which is
// ranked on a measurement over the WHOLE session — was a function of process uptime rather
// than of the market: an instance started at 21:00 recorded one tick at `fromMinute: 375`,
// every row came back `ready: false`, and the board was empty. The same code on a machine
// that had been up since 09:10 showed a full board. Two screens, same day, same token,
// different answers, and no way to tell from either which one was wrong.
//
// THE FIX IS THE ONE THIS APP ALREADY MADE ONCE. The option pages used to need a five-minute
// recorder and no longer do, because Upstox serves per-contract open interest on historical
// candles (see the "No recorder" section of the README). The same argument applies here: a
// 1-minute candle series IS the price path, and every accumulator in `SessionShape` is a pure
// fold over that path. So today can be reconstructed rather than remembered.
//
// `tools/trend-replay.ts` already proved it — it replays a finished session through these
// exact functions to test the model offline. This module is that replay promoted from a
// research tool to a boot-time recovery path, and the tool now imports `replayQuotes` from
// here so the two can never drift apart.
//
// WHAT IT COSTS. One candle request per symbol, ~208 in total, batched eight at a time behind
// the same circuit breaker the baseline uses — about half of what the daily baseline build
// already spends. It runs once per process per day, and only for symbols that were not
// watched live, so a scanner that has been up since the open pays nothing.
//
// THREE APPROXIMATIONS, inherited from the replay and stated rather than buried:
//
//   VWAP      rebuilt as Σ(typical × volume) ÷ Σvolume with typical = (h+l+c)/3, because a
//             candle carries no traded VWAP. Upstox's live `average_price` is the exact one;
//             this is the standard reconstruction of it and drifts by single-digit basis
//             points on liquid names. Adherence, crossings and slope all inherit that.
//
//   SAMPLING  one reading per minute against four per minute live, so `travelled` — the
//             denominator of session efficiency — misses intra-minute reversals and the
//             efficiency of a seeded row reads slightly HIGH against a live-accumulated one.
//             It is the same bias for every seeded symbol, so the ranking between them holds.
//
//   NO BOOK   candles carry no depth, so nothing here fills the order-book fields. The
//             liquidity factor already reweights around a missing book rather than scoring it
//             as illiquid, and the live poll fills them within one cycle anyway.
//
// None of the three touches the reading the phase machine actually gates on — crossings,
// adherence and displacement are all robust to a coarser sample — which is why a seeded board
// and a watched one agree on which stocks had a one-sided day.

import { configRepository } from '../config/config.repository.js';
import { getBaseline, type SymbolBaseline } from './baseline.js';
import { CANDLE_ENDPOINT, inBatches, todaySession, type Candle } from './candles.js';
import { throttledFor } from './throttle.js';
import { universe } from './universe.js';
import { computeConviction } from '../services/conviction.service.js';
import { istDay, minuteOfSession } from '../session.js';
import { flushSessionState, observe, resetSymbolSession, sessionState } from './session-state.js';
import type { MomentumConfig } from '../types.js';
import type { MomentumQuote } from './quotes.js';

/** Same width as the option ladder and the pullback catch-up, so the process has one story. */
const SEED_BATCH = 8;

/**
 * A shape starting at or before this minute was watched from the open and is left alone.
 *
 * Live accumulation is strictly better than a replay — four samples a minute against one, and
 * a real traded VWAP rather than a reconstructed one — so the seed's job is to fill holes, not
 * to overwrite a good record with a coarser one.
 */
const WATCHED_FROM_MINUTE = 1;

export interface SeedOutcome {
  /** The IST day seeded, or null when nothing has run yet. */
  day: string | null;
  at: number;
  /** Symbols whose session was rebuilt from candles. */
  seeded: number;
  /** Symbols already watched live from the open, left untouched. */
  skipped: number;
  /** Symbols Upstox served nothing for — a holiday, a suspension, or a fresh listing. */
  empty: number;
  failures: Record<string, string>;
  running: boolean;
}

let last: SeedOutcome = { day: null, at: 0, seeded: 0, skipped: 0, empty: 0, failures: {}, running: false };
let inFlight: Promise<SeedOutcome> | null = null;

export const seedStatus = (): SeedOutcome => last;

/* --------------------------------------------------------------------- the quotes --- */

/**
 * Turn a candle series into the successive quote readings the poll would have produced.
 *
 * Everything the scanner reads off a quote is either in the candle (close, high, low, volume)
 * or accumulable from it (session high/low, cumulative volume, VWAP). The order-book fields
 * are left empty, which is the same state the live feed is in outside market hours.
 *
 * Note that `high`/`low` are the SESSION extremes to date rather than the bar's, because that
 * is what the quote carries and what `observe` records the opening range from.
 */
export function* replayQuotes(
  symbol: string,
  candles: Candle[],
  prevClose: number,
): Generator<{ quote: MomentumQuote; at: number }> {
  let cumVolume = 0;
  let cumTurnover = 0;
  let high = -Infinity;
  let low = Infinity;
  let open = 0;

  for (const c of candles) {
    if (c.minute < 0) continue;
    if (!open) open = c.open;

    const typical = (c.high + c.low + c.close) / 3;
    cumVolume += c.volume;
    cumTurnover += typical * c.volume;
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);

    const vwap = cumVolume > 0 ? cumTurnover / cumVolume : c.close;
    const at = Date.parse(c.stamp);

    yield {
      at,
      quote: {
        symbol,
        instrumentKey: '',
        ltp: c.close,
        prevClose,
        netChange: c.close - prevClose,
        changePct: prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0,
        open,
        high,
        low,
        volume: cumVolume,
        vwap,
        turnoverCr: cumTurnover / 1e7,
        openInterest: 0,
        oiDayHigh: 0,
        oiDayLow: 0,
        totalBuyQty: 0,
        totalSellQty: 0,
        bid: 0,
        ask: 0,
        bidQty: 0,
        askQty: 0,
        bidOrders: 0,
        askOrders: 0,
        depthCr: 0,
        hasBook: false,
        at,
      },
    };
  }
}

/* ----------------------------------------------------------------------- the seed --- */

/**
 * Replay one symbol's day into the session state.
 *
 * `computeConviction` is called per replayed minute and its return value discarded, which
 * looks wasteful and is the most important line in this file. The conviction READING is a pure
 * function and could be computed once at the end — but the phase machine inside it is not: it
 * dates `since`, `formingSince` and `belowSince` from the timestamp it is handed, and needs
 * `confirmHoldMin` of sustained evidence to promote. Fold only the shape and the board comes
 * up saying `None`, then `Forming`, and reaches `Confirmed` twenty minutes after the restart —
 * a stock that has been one-sided since 09:30 would read as a twenty-minute-old trend. Driving
 * the machine through the replay is what makes the board say "Confirmed, held 4h 20m" the
 * moment it comes up, which is the truth and the entire value of the `Held` column.
 */
function replaySymbol(
  state: Awaited<ReturnType<typeof sessionState>>,
  symbol: string,
  candles: Candle[],
  baseline: SymbolBaseline | undefined,
  cfg: MomentumConfig,
): void {
  resetSymbolSession(state, symbol);

  const p = cfg.thresholds.pulse;
  const conv = cfg.thresholds.conviction;
  const openingMinutes = cfg.thresholds.trendStructure.openingRangeMinutes;
  const atr = baseline?.atr && baseline.atr > 0 ? baseline.atr : 0;
  const prevClose = baseline?.prevClose ?? candles[0]?.open ?? 0;

  for (const { quote, at } of replayQuotes(symbol, candles, prevClose)) {
    const reversal = atr > 0 ? atr * p.legReversalAtr : quote.ltp * (p.legReversalPctFloor / 100);
    observe(state, quote, openingMinutes, at, reversal, {
      atr,
      vwapSideBufferAtr: conv.vwapSideBufferAtr,
      spineIntervalMin: conv.spineIntervalMin,
    });
    computeConviction(state.symbols[symbol], baseline, cfg, at);
  }
}

/**
 * Rebuild today's session for every symbol that was not watched live.
 *
 * Idempotent by construction: each symbol is reset before it is replayed, and a symbol already
 * holding a full-session record is skipped unless `force` says otherwise. Never throws — a
 * seed that fails is a board that is merely as empty as it would have been anyway, and taking
 * the process down over it would be strictly worse.
 */
export async function seedSession(
  opts: { force?: boolean } = {},
  nowMs = Date.now(),
): Promise<SeedOutcome> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<SeedOutcome> => {
    const day = istDay(nowMs);
    const result: SeedOutcome = {
      day, at: nowMs, seeded: 0, skipped: 0, empty: 0, failures: {}, running: true,
    };
    last = result;

    // Before the open there is no session to rebuild, and the intraday endpoint answers empty
    // for every symbol — 208 requests to learn nothing.
    if (minuteOfSession(nowMs) <= 0) {
      result.running = false;
      return result;
    }

    const cfg = await configRepository.get();
    const [uni, b, state] = await Promise.all([
      universe(nowMs),
      getBaseline(nowMs),
      sessionState(nowMs),
    ]);

    await inBatches(uni.members, SEED_BATCH, async (m) => {
      const existing = state.symbols[m.symbol]?.shape;
      if (!opts.force && existing && existing.fromMinute <= WATCHED_FROM_MINUTE) {
        result.skipped++;
        return;
      }
      // A spent candle quota is reported rather than retried into the ground — the breaker
      // already knows, and 200 doomed requests would delay the next baseline as well.
      if (throttledFor(CANDLE_ENDPOINT, Date.now()) > 0) {
        result.failures[m.symbol] = 'skipped — Upstox candle endpoint rate limited';
        return;
      }

      try {
        const candles = (await todaySession(m.equityKey, day, 1))
          .filter((c) => c.day === day && c.minute >= 0);
        if (!candles.length) {
          result.empty++;
          return;
        }
        replaySymbol(state, m.symbol, candles, b.baseline?.symbols[m.symbol], cfg);
        result.seeded++;
      } catch (e) {
        result.failures[m.symbol] = String((e as Error).message);
      }
    });

    // Forced: this is the write worth guaranteeing, since the alternative is spending the
    // whole 208 requests again on the next boot.
    await flushSessionState(true, Date.now());

    result.running = false;
    result.at = Date.now();
    return result;
  })().finally(() => { inFlight = null; });

  return inFlight;
}
