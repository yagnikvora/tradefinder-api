// The home page's data, in one call.
//
// The page opens with a live ticker, four index cards and a market snapshot. Assembling
// that from the individual page endpoints would be five or six round trips before anything
// renders, so it is composed here instead.
//
// The equity quote batch already covers every index and every F&O stock (see equity.ts),
// so the ticker, the breadth count and the movers all come off ONE upstream request. Only
// the four sparklines add calls, and those are cached per index.
//
// Nothing here is invented. The ticker this replaced held ten hardcoded index levels that
// looked live and were not — the numbers below are the same ones the rest of the app draws.

import { allQuotes, fnoSymbols, type EquityQuote } from './equity.js';
import { HEADLINE_INDICES, MARQUEE } from './indices.js';
import { INSTRUMENT_KEY, sessionCandles } from './upstox.js';
import { marketOpen, type Result } from './services.js';

const IST_OFFSET_S = 330 * 60;
const dayOf = (epochS: number) => new Date((epochS + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);

export interface TickerRow {
  name: string;
  label: string;
  last: number;
  points: number;
  pct: number;
}

export interface HeadlineIndex extends TickerRow {
  open: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  /** Closes through the session, for a sparkline. Empty when candles aren't available. */
  spark: number[];
}

export interface MoverRow { Symbol: string; ltp: number; pChange: number; turnover: number }

export interface Overview {
  /** The trading day this describes, YYYY-MM-DD IST. */
  day: string;
  /** True while NSE is open, so the page can label itself honestly. */
  live: boolean;
  ticker: TickerRow[];
  headline: HeadlineIndex[];
  /** India VIX, pulled out because it reads as a level not a mover. */
  vix: TickerRow | null;
  breadth: { advances: number; declines: number; total: number };
  gainers: MoverRow[];
  losers: MoverRow[];
  /** Busiest by traded value — where the day's money actually went. */
  active: MoverRow[];
}

const row = (name: string, label: string, q: EquityQuote): TickerRow => ({
  name, label,
  last: q.ltp,
  points: +(q.ltp - q.prevClose).toFixed(2),
  pct: q.pChange,
});

const mover = (q: EquityQuote): MoverRow => ({
  Symbol: q.Symbol, ltp: q.ltp, pChange: q.pChange, turnover: q.turnover,
});

/**
 * A sparkline for one index: 15-minute closes through the session.
 *
 * Fifteen minutes gives ~25 points, which is the right density for a strip 120px wide —
 * one-minute candles would be 375 points rendering as noise. Failure is silent and yields
 * an empty array: a card without its sparkline is still a card, and the level and change
 * beside it came from the quote, not from here.
 */
async function spark(script: string, day: string, today: string): Promise<number[]> {
  try {
    const key = INSTRUMENT_KEY[script];
    if (!key) return [];
    const bars = await sessionCandles(key, day, today, 'minutes', 15);
    return bars.map((b) => b[4]);
  } catch {
    return [];
  }
}

/**
 * The most recent day that actually traded, and Nifty's bars for it.
 *
 * Walks back rather than assuming yesterday: the calendar day is a weekend or a holiday
 * often enough, and asking for candles on one answers 200 with an empty array — which
 * reads as "the market was flat" rather than "wrong day".
 */
async function lastSession(today: string): Promise<{ day: string; bars: number[] }> {
  const now = Math.floor(Date.now() / 1000);
  for (let back = 0; back < 8; back++) {
    const day = dayOf(now - back * 86400);
    const bars = await spark('NIFTY 50', day, today);
    if (bars.length) return { day, bars };
  }
  return { day: today, bars: [] };
}

export async function overview(): Promise<Result<Overview>> {
  const open = marketOpen();
  const quotes = await allQuotes(open);

  const ticker: TickerRow[] = [];
  let vix: TickerRow | null = null;
  for (const m of MARQUEE) {
    const q = quotes.get(m.name);
    if (!q) continue;
    const r = row(m.name, m.label, q);
    if (m.name === 'INDIA VIX') vix = r; else ticker.push(r);
  }
  if (!ticker.length) throw new Error('no index quotes available');

  // The session the numbers belong to, taken from the index's own candles rather than the
  // calendar — on a weekend or a holiday those disagree.
  const today = dayOf(Math.floor(Date.now() / 1000));
  const { day, bars: nifty } = await lastSession(today);

  const headline: HeadlineIndex[] = [];
  for (const name of HEADLINE_INDICES) {
    const q = quotes.get(name);
    const m = MARQUEE.find((x) => x.name === name);
    if (!q || !m) continue;
    headline.push({
      ...row(name, m.label, q),
      open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow, prevClose: q.prevClose,
      spark: name === 'NIFTY 50' && nifty.length ? nifty : await spark(name, day, today),
    });
  }

  // Breadth and movers over the F&O universe — the same set Market Pulse scans, so the
  // home page and that page can never disagree about who is up.
  const universe = new Set(await fnoSymbols());
  const stocks = [...quotes.values()].filter((q) => universe.has(q.Symbol));
  const advances = stocks.filter((q) => q.pChange > 0).length;
  const declines = stocks.filter((q) => q.pChange < 0).length;

  const byPct = [...stocks].sort((a, b) => b.pChange - a.pChange);

  return {
    source: 'upstox',
    data: {
      day,
      live: open,
      ticker,
      headline,
      vix,
      breadth: { advances, declines, total: stocks.length },
      gainers: byPct.slice(0, 6).map(mover),
      losers: byPct.slice(-6).reverse().map(mover),
      active: [...stocks].sort((a, b) => b.turnover - a.turnover).slice(0, 6).map(mover),
    },
  };
}
