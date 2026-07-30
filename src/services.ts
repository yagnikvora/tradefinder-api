// Service layer: transform live NSE data into typed payloads; fall back to mock.
import {
  indexConstituents, liveBroadConstituents, marketConstituents, optionChain, type NseConstituent,
} from './nse.js';
import { avgDailyRanges } from './volume.js';
import { SECTOR_BASKETS } from './sectors.js';
import { remember, recall, ageLabel } from './snapshot.js';
import * as mock from './mock.js';
import type {
  MarketPulse, SectorScope, IndexMover, OptionAnalysis, ScannerGroups, FiiDiiRow, Source,
} from './types.js';

const now = () => Math.floor(Date.now() / 1000);

function norm(j: { data: NseConstituent[] }, index: string) {
  return (j.data || [])
    .filter((r) => r.priority !== 1 && r.symbol && r.symbol !== index)
    .map((r) => ({
      Symbol: r.symbol, ltp: r.lastPrice,
      prevClose: r.previousClose ?? r.lastPrice / (1 + (r.pChange || 0) / 100),
      pChange: r.pChange ?? 0,
      turnover: r.totalTradedValue ? +(r.totalTradedValue / 1e7).toFixed(1) : 0, // raw ₹ -> ₹Cr
    }));
}
const rFactor = (p: number) => +Math.min(Math.abs(p || 0) / 1.5, 8).toFixed(2);

export interface Result<T> { data: T; source: Source; error?: string; }

// A live equity quote enriched with everything Market Pulse widgets need.
interface FnoQuote {
  Symbol: string; ltp: number; prevClose: number; pChange: number;
  turnover: number; dayHigh: number; dayLow: number; volume: number; open: number;
}

function normFno(rows: NseConstituent[]): FnoQuote[] {
  return rows
    .filter((r) => r.symbol && r.lastPrice)
    .map((r) => {
      const ltp = r.lastPrice;
      const prevClose = r.previousClose ?? ltp / (1 + (r.pChange || 0) / 100);
      return {
        Symbol: r.symbol,
        ltp,
        prevClose: +(+prevClose).toFixed(2),
        pChange: +(r.pChange ?? 0).toFixed(2),
        turnover: r.totalTradedValue ? +(r.totalTradedValue / 1e7).toFixed(2) : 0, // ₹ -> ₹Cr
        dayHigh: r.dayHigh ?? ltp,
        dayLow: r.dayLow ?? ltp,
        volume: r.totalTradedVolume ?? 0, // today's cumulative traded shares
        // Today's open drives the Sector Scope signal arrow: the arrow tracks
        // LTP vs open (intraday direction), not the % change vs previous close —
        // a stock can be up on the day but red because it's faded from the open.
        open: r.open ?? prevClose,
      };
    });
}

// Stable pseudo-random in [0,1) from a symbol string — keeps derived signals
// deterministic across the 60s cache window instead of jittering each request.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// Fraction of the session elapsed — 0 before the open, 1 after the close. NSE cash
// trades 09:15–15:30 IST. Used to scale a still-forming intraday range onto a
// full-day baseline so a morning reading is comparable to a closing one.
function sessionFraction(nowUtcMs: number): number {
  const istMin = ((nowUtcMs / 60000) + 330) % 1440; // +5:30
  const open = 9 * 60 + 15, close = 15 * 60 + 30;
  if (istMin <= open) return 0;
  if (istMin >= close) return 1;
  return (istMin - open) / (close - open);
}

// NSE cash session in IST: 09:15–15:30, Mon–Fri. Outside it the numbers are frozen
// for the day, which is what lets the cache in index.ts stop re-fetching. (Trading
// holidays aren't tracked — one just reads as "open" and re-fetches unchanged data.)
export function marketOpen(nowMs: number = Date.now()): boolean {
  const ist = new Date(nowMs + 330 * 60_000); // shift so the UTC getters read IST
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// Level calibration onto tradefinder's published R.Factor scale.
//
// The raw ratio below has the right SHAPE but sits about a quarter low: scored against
// their own page for 2026-07-02 (146 symbols, captures/sector-scope.txt vs NSE bhavcopy)
// the raw ratio reads median 0.86 where they print 1.09, and every large reading is
// short by a similar proportion. It is a level offset and not a shape error — a log-log
// fit of theirs against ours gives an exponent of 0.955, i.e. indistinguishable from a
// straight multiple, and the multiple barely moves with the baseline window (1.26 at 14
// sessions, 1.30 at 20, 1.34 at 33). Applying it takes mean absolute error from 0.42 to
// 0.33 and leaves the ranking untouched.
//
// Whatever normalisation sits behind their divisor isn't recoverable from public data,
// so this is measured rather than derived — re-measure with rfac-validate against a
// fresh logged-in capture if their numbers ever drift.
const RFACTOR_CALIBRATION = 1.33;

// R.Factor = today's trading RANGE against the stock's own normal range — a volatility
// multiple, so 2.00 means "moving twice as wide as it usually does".
//
// This was relative VOLUME until measurement said otherwise. Against tradefinder's
// published R.Factor over 37 symbols, range predicts their value far better than volume
// (Spearman 0.80 vs 0.66; Pearson 0.80 vs 0.45), and volume is provably not the input:
// their implied volume baseline for ETERNAL sat below that stock's lowest volume in 30
// sessions, which no volume window can produce. Their companion feed also tags every
// symbol `volt: high|low`, which is a volatility label.
//
// Intraday the day's range is still forming, so it's scaled to the same point in the
// session. Range fills faster than time does (the open is the widest stretch), so this
// uses a sqrt curve rather than the U-shaped one volume needs.
//
// NOT capped at 5: the real multiple is shown (a stock ranging 9× its norm reads 9.23,
// not a misleading 5.00). Only a high guard (50) catches obviously-bad data points.
function rfac(q: FnoQuote, avgRange: Record<string, number>, nowMs: number): number {
  const base = avgRange[q.Symbol];
  const todayRange = q.prevClose > 0 ? ((q.dayHigh - q.dayLow) / q.prevClose) * 100 : 0;
  if (base && base > 0 && todayRange > 0) {
    const elapsed = sessionFraction(nowMs);
    const expected = elapsed > 0.02 ? base * Math.sqrt(elapsed) : base;
    return +Math.min((todayRange / expected) * RFACTOR_CALIBRATION, 50).toFixed(2);
  }
  // Fallback estimate (no range history): blend move, intraday range and liquidity.
  // This is a synthetic score, not a measured ratio, so it stays bounded ~0.3–5.
  const range = q.prevClose ? (q.dayHigh - q.dayLow) / q.prevClose : 0;
  const move = Math.min(Math.abs(q.pChange) / 6, 1);
  const liquidity = Math.log10(1 + q.turnover) / 4;
  const raw = 0.4 + move * 1.6 + Math.min(range * 8, 1.4) + liquidity * 1.2;
  const v = raw * (0.75 + hash01(q.Symbol + 'r') * 0.5);
  return +Math.max(0.3, Math.min(v, 5)).toFixed(2);
}

// Distance of LTP from the day's high (top level) or low (low level), as a fraction. 0 = right at the level.
const diffFromHigh = (q: FnoQuote) => +Math.max(0, (q.dayHigh - q.ltp) / (q.dayHigh || 1)).toFixed(2);
const diffFromLow = (q: FnoQuote) => +Math.max(0, (q.ltp - q.dayLow) / (q.dayLow || 1)).toFixed(2);

// Unix epoch (seconds) of today's NSE market open (09:15 IST). Used as a stable anchor
// for synthetic signal times so they don't drift between auto-refreshes. IST = UTC+5:30.
function marketOpenEpoch(nowMs: number): number {
  const IST_OFFSET_MIN = 330; // +5:30
  const ist = new Date(nowMs + IST_OFFSET_MIN * 60_000); // shift so UTC getters read IST
  // Midnight IST of the current IST day, expressed back in real UTC ms.
  const istMidnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MIN * 60_000;
  const openMs = istMidnightUtcMs + (9 * 60 + 15) * 60_000; // 09:15 IST
  return Math.floor(openMs / 1000);
}

export async function marketPulse(): Promise<Result<MarketPulse>> {
  try {
    const [rows, avgRange] = await Promise.all([marketConstituents(), avgDailyRanges()]);
    const s = normFno(rows);
    if (s.length < 20) throw new Error(`only ${s.length} market rows`);
    const nowMs = Date.now();

    // Breakout Beacon: proprietary "signal %" momentum score across the whole market,
    // ranked by strength and capped for a scannable list (the live site shows ~170).
    // Both signal% and the signal time are DETERMINISTIC per symbol/day so the widget
    // doesn't reshuffle on every auto-refresh — it only changes when the real price
    // data changes. The time is anchored to today's market open (not now()), so a given
    // stock always shows the same signal time within a session.
    const sessionOpen = marketOpenEpoch(nowMs); // 09:15 IST today (or last session)
    const beacon = s
      .map((q) => {
        const signalPct = +(q.pChange * (0.35 + hash01(q.Symbol + 'b') * 0.45)).toFixed(2);
        // Stable time-of-signal: open + a fixed per-symbol offset within the session.
        const ts = sessionOpen + Math.floor(hash01(q.Symbol + 't') * 6 * 3600);
        const dir: 'BULL' | 'BEAR' = q.pChange >= 0 ? 'BULL' : 'BEAR';
        return { Symbol: q.Symbol, param_0: q.pChange, param_1: signalPct, param_2: dir, param_3: ts };
      })
      .sort((a, b) => Math.abs(b.param_1) - Math.abs(a.param_1))
      .slice(0, 300);

    // Intraday Boost: top by R.Factor (real, time-of-day-adjusted relative volume).
    const boost = s
      .map((q) => ({ q, r: rfac(q, avgRange, nowMs) }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 80)
      .map(({ q, r }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: r }));

    const gainers = [...s].sort((a, b) => b.pChange - a.pChange).slice(0, 25)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: rfac(q, avgRange, nowMs) }));
    const losers = [...s].sort((a, b) => a.pChange - b.pChange).slice(0, 25)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: rfac(q, avgRange, nowMs) }));

    const highPower = [...s].sort((a, b) => b.turnover - a.turnover).slice(0, 50)
      .map((q) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: q.turnover }));

    // Top level: nearest to day HIGH. Low level: nearest to day LOW.
    const topLevel = [...s].map((q) => ({ q, d: diffFromHigh(q) })).sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ q, d }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: d }));
    const lowLevel = [...s].map((q) => ({ q, d: diffFromLow(q) })).sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ q, d }) => ({ Symbol: q.Symbol, param_0: q.ltp, param_1: q.prevClose, param_2: q.pChange, param_3: d }));

    const data: MarketPulse = {
      breakout_beacon: beacon,
      intraday_boost: boost,
      top_gainers: gainers,
      top_losers: losers,
      high_powered_stocks: highPower,
      top_level_stocks: topLevel,
      low_level_stocks: lowLevel,
    };
    return { source: 'nse', data: await remember('market_pulse', data) };
  } catch (e) {
    // Same reasoning as sector scope: NSE drops out often enough that a refresh can
    // land on an outage, and swapping a live board for invented prices is the most
    // visible way this app can be wrong. Re-serve the last real board instead.
    const prev = await recall<MarketPulse>('market_pulse');
    if (prev) return { source: 'stale', error: `NSE unreachable, showing last live data (${ageLabel(prev.ageMs)} old)`, data: prev.data };
    return { source: 'mock', error: String((e as Error).message), data: mock.mockMarketPulse() };
  }
}

// Treemap group labels: the NIFTY prefix is dropped for sector indices, but kept
// where it's part of how the index is actually known.
const KEEP_NIFTY = new Set(['NIFTY 50', 'NIFTY MID SELECT']);
const sectorLabel = (sec: string) => (KEEP_NIFTY.has(sec) ? sec : sec.replace('NIFTY ', ''));

export async function sectorScope(): Promise<Result<SectorScope>> {
  try {
    // One broad-market pull, then sliced into the baskets — cheaper and far more
    // reliable than 16 separate index calls, and it carries the volume needed for a
    // real R.Factor.
    //
    // Deliberately the broad universe, NOT marketConstituents(): that one narrows to
    // NSE's F&O master list, which drops names tradefinder's own baskets carry —
    // SAMMAANCAP sits in their FIN SERVICE and in NIFTY 500, but not in master-quote,
    // so the F&O filter silently deleted a row the real page shows. SECTOR_BASKETS is
    // already the membership filter here, so the extra one only ever costs us rows.
    const [rows, avgRange] = await Promise.all([liveBroadConstituents(), avgDailyRanges()]);
    const quotes = new Map(normFno(rows).map((q) => [q.Symbol, q]));

    // Coverage guard. marketConstituents() merges several broad indices and silently
    // tolerates any that NSE won't serve — so when NIFTY 500 fails we get a universe
    // made only of mid/small caps and every large cap (HDFCBANK, ICICIBANK, TCS…)
    // quietly vanishes from the map. That renders as a plausible-looking but wrong
    // page, which is worse than an outage: fail here so the caller serves the last
    // good snapshot instead.
    const wanted = new Set(Object.values(SECTOR_BASKETS).flat());
    const covered = [...wanted].filter((s) => quotes.has(s)).length;
    if (covered < wanted.size * 0.7)
      throw new Error(`partial universe: ${covered}/${wanted.size} basket symbols priced`);
    const nowMs = Date.now();

    const out: SectorScope = {};
    for (const [sector, symbols] of Object.entries(SECTOR_BASKETS)) {
      const stocks = symbols
        .map((sym) => quotes.get(sym))
        .filter((q): q is FnoQuote => !!q)
        .map((q) => ({
          Symbol: q.Symbol,
          ltp: q.ltp,
          open: q.open,
          prevClose: +(+q.prevClose).toFixed(2),
          pChange: q.pChange,
          rFactor: rfac(q, avgRange, nowMs), // volatility multiple vs the stock's own norm
          weight: Math.max(1, (q.ltp || 100) / 100),
        }));
      if (stocks.length) out[sector] = stocks;
    }
    if (!Object.keys(out).length) throw new Error('no sectors');
    return { source: 'nse', data: await remember('sector_scope', out) };
  } catch (e) {
    // Prefer the last real snapshot over fabricated prices — see snapshot.ts.
    const prev = await recall<SectorScope>('sector_scope');
    if (prev) return { source: 'stale', error: `NSE unreachable, showing last live data (${ageLabel(prev.ageMs)} old)`, data: prev.data };
    return { source: 'mock', error: String((e as Error).message), data: mock.mockSectorScope() };
  }
}

export async function indexMover(index = 'NIFTY 50'): Promise<Result<IndexMover>> {
  try {
    const j = await indexConstituents(index);
    const sum = (j.data||[]).find((r)=>r.symbol===index);
    const level = sum?.lastPrice || 24080;
    const s = norm(j, index); const stocks = []; let up=0, down=0;
    for (const x of s) { const w = (x.ltp||100)/(level*25); const pts = level*w*(x.pChange/100);
      stocks.push({ Symbol: x.Symbol, per_change: x.pChange, per_to_index: +(w*x.pChange/100).toFixed(6), point_to_index: +pts.toFixed(3) });
      x.pChange>=0?up++:down++; }
    return { source: 'nse', data: { index, level, points: sum?.change ?? null, pct: sum?.pChange ?? null, gainers: up, losers: down, stocks } };
  } catch (e) { return { source: 'mock', error: String((e as Error).message), data: mock.mockIndexMover(index) }; }
}

export async function optionAnalysis(symbol = 'NIFTY'): Promise<Result<OptionAnalysis>> {
  try {
    const j = await optionChain(symbol); const rec = j.records; const spot = rec.underlyingValue;
    const atm = Math.round(spot/50)*50; const exp = rec.expiryDates[0];
    // No expiryDate filter: v3 serves one expiry per call and leaves the field off the rows.
    const rows = rec.data.filter((d)=>Math.abs(d.strikePrice-atm)<=500)
      .map((d)=>({ strike: d.strikePrice, ceOI: d.CE?.openInterest||0, peOI: d.PE?.openInterest||0,
        ceChg: d.CE?.changeinOpenInterest||0, peChg: d.PE?.changeinOpenInterest||0 }));
    const ce = rows.reduce((a,r)=>a+r.ceOI,0), pe = rows.reduce((a,r)=>a+r.peOI,0);
    const maxPain = rows.slice().sort((a,b)=>(a.ceOI+a.peOI)-(b.ceOI+b.peOI))[0]?.strike ?? atm;
    return { source: 'nse', data: { symbol, spot, atm, expiry: exp, expiries: rec.expiryDates.slice(0,6), rows, pcr: +(pe/(ce||1)).toFixed(2), maxPainStrike: maxPain } };
  } catch (e) { return { source: 'mock', error: String((e as Error).message), data: mock.mockOption(symbol) }; }
}

// These need a licensed tick/daily feed to compute for real — served as structured mock.
export async function swing(): Promise<Result<ScannerGroups>> {
  return { source: 'mock', data: mock.mockScanners(['10_day_breakout','50_day_breakout','channel_bo','nr7','reversal_radar','weekly_index']) };
}
export async function insider(): Promise<Result<ScannerGroups>> {
  return { source: 'mock', data: mock.mockScanners(['contraction_bo','two_day_bo','lom_short_term','lom_long_term','reversal','spike_five','spike_ten','index_alpha','swing_weekly_reversal']) };
}
export async function fiiDii(): Promise<Result<FiiDiiRow[]>> {
  return { source: 'mock', data: mock.mockFiiDii() };
}
