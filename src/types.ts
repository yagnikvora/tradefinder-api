// Shared types mirroring the real tradefinder.in /api_be data model.
// See docs/04-COMPLETE-DATA-MODEL.md for the source-of-truth mapping.

export type Signal = 'BULL' | 'BEAR';
// Where a payload came from.
//   'nse'    — read live from NSE's public API
//   'upstox' — read live from Upstox's market API (Option Apex's PCR)
//   'stale'  — real data from an earlier successful fetch, re-served while the upstream is
//              unreachable. Real numbers, just not current — distinct from fabricated data.
//   'mock'   — deterministic demo data, invented
export type Source = 'nse' | 'upstox' | 'mock' | 'stale';

// ---- Market Pulse ----
// The real tradefinder API uses a flat param_N schema per row. The meaning of
// each param differs by widget (see marketPulse() in services.ts):
//   breakout_beacon:      param_0=%chg  param_1=signal%  param_2="BULL"/"BEAR"  param_3=epoch(s)
//   intraday_boost /      param_0=LTP   param_1=prevClose param_2=%chg          param_3=R.Factor
//     top_gainers/losers
//   high_powered_stocks:  param_0=LTP   param_1=prevClose param_2=%chg          param_3=turnover(₹Cr)
//   top_level/low_level:  param_0=LTP   param_1=prevClose param_2=%chg          param_3=diff (dist from day high/low)
export interface BeaconRow { Symbol: string; param_0: number; param_1: number; param_2: Signal; param_3: number; }
export interface ParamRow { Symbol: string; param_0: number; param_1: number; param_2: number; param_3: number; }
export interface MarketPulse {
  breakout_beacon: BeaconRow[];
  intraday_boost: ParamRow[];
  top_gainers: ParamRow[];
  top_losers: ParamRow[];
  high_powered_stocks: ParamRow[];
  top_level_stocks: ParamRow[];
  low_level_stocks: ParamRow[];
}

// ---- Sector Scope ----
export interface SectorStock { Symbol: string; ltp: number; open: number; prevClose: number; pChange: number; rFactor: number; weight: number; }
export type SectorScope = Record<string, SectorStock[]>;

// ---- Index point contribution ----
// The /index-mover page is gone; this is not. Option Apex embeds a point-contribution panel
// that reads the same endpoint, so the type, the service and the route all stay.
export interface MoverStock { Symbol: string; per_change: number; per_to_index: number; point_to_index: number; }
export interface IndexMover {
  index: string; level: number; points: number | null; pct: number | null;
  gainers: number; losers: number; stocks: MoverStock[];
}

// ---- Option Clock ----
// The feed is deliberately shaped exactly like the real one: a map of snapshot
// timestamp -> { "NFO:<underlying><expiry code><strike><CE|PE>": openInterest, atm }.
// CE legs are the bears, PE legs the bulls; the clock plots the change between two
// snapshots. See docs/04-COMPLETE-DATA-MODEL.md.
export type OiSnapshot = Record<string, number>;
export type OiSnapshots = Record<string, OiSnapshot>;
// [epoch(s) of expiry day at 15:30 IST, "wk" | "mo"]
export type RunningExpiry = [number, 'wk' | 'mo'];
// One reading of the PCR trend: [epoch(s), PCR, total put OI, total call OI]
export type PcrPoint = [number, number, number, number];

