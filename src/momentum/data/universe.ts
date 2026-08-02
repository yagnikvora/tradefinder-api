// What the scanner scans, and which instrument each factor reads.
//
// One stock needs THREE instruments to be scored, and confusing them is the easiest way to
// produce a plausible wrong number:
//
//   NSE_EQ|<isin>   the share.   Price, volume, VWAP, order book. `oi` is always 0.
//   NSE_FO|<token>  the future.  Open interest, and the price change OI is judged against.
//   NSE_INDEX|<..>  the sector.  Relative strength needs something to be relative TO.
//
// Sector membership is resolved from `sectors.ts` — the app's existing baskets — rather
// than from a second list, but the baskets and the tradable sector indices are not the same
// set, so the mapping below is explicit and the resolution is priority-ordered.

import { instruments, nearFuture, type FuturesContract } from '../../equity.js';
import { SECTOR_BASKETS } from '../../sectors.js';

/**
 * Basket name -> the NSE index that basket trades against.
 *
 * The broad-market baskets (NIFTY 50, SENSEX, NIFTY MID SELECT) are deliberately absent:
 * they are capitalisation buckets, not sectors, and scoring RELIANCE's "sector strength"
 * against the Nifty would just restate the relative-strength factor with a different name.
 * OTHERS has no index either — it is the catch-all — so its members score sector strength
 * as unavailable rather than against something arbitrary.
 */
export const SECTOR_INDEX: Record<string, string> = {
  METAL: 'NIFTY METAL',
  'PSU BANK': 'NIFTY PSU BANK',
  REALTY: 'NIFTY REALTY',
  ENERGY: 'NIFTY ENERGY',
  AUTO: 'NIFTY AUTO',
  IT: 'NIFTY IT',
  PHARMA: 'NIFTY PHARMA',
  'PVT BANK': 'NIFTY PVT BANK',
  BANK: 'BANKNIFTY',
  'FIN SERVICE': 'FINNIFTY',
  FMCG: 'NIFTY FMCG',
  CEMENT: 'NIFTY CEMENT',
};

/**
 * Which basket wins when a stock is in several.
 *
 * HDFCBANK sits in PVT BANK, BANK, FIN SERVICE, NIFTY 50 and SENSEX. The most specific
 * grouping is the informative one — "is it beating the private banks" says more than "is it
 * beating financial services" — so specific sectors resolve first and the broad ones last.
 */
const SECTOR_PRIORITY = [
  'IT', 'PHARMA', 'AUTO', 'METAL', 'REALTY', 'CEMENT', 'FMCG', 'ENERGY',
  'PSU BANK', 'PVT BANK', 'BANK', 'FIN SERVICE',
];

/** The market-wide references every row is scored against. */
export const NIFTY_INDEX = 'NIFTY';
export const NIFTY_FUTURES_UNDERLYING = 'NIFTY';
export const INDIA_VIX = 'INDIA VIX';

export interface UniverseMember {
  symbol: string;
  equityKey: string;
  future: FuturesContract | null;
  sector: string | null;
  sectorIndexName: string | null;
}

export interface Universe {
  members: UniverseMember[];
  bySymbol: Map<string, UniverseMember>;
  /** Sector index display name -> Upstox instrument key, for the ones that priced. */
  sectorIndexKeys: Map<string, string>;
  niftyKey: string;
  niftyFuture: FuturesContract | null;
  vixKey: string | null;
  builtAt: number;
}

const symbolToSector = (() => {
  const map = new Map<string, string>();
  for (const sector of SECTOR_PRIORITY) {
    for (const sym of SECTOR_BASKETS[sector] ?? []) if (!map.has(sym)) map.set(sym, sector);
  }
  return map;
})();

/** The sector a symbol is scored against, or null when it has no tradable sector index. */
export const sectorOf = (symbol: string): string | null => symbolToSector.get(symbol) ?? null;

let cached: Universe | null = null;
const DAY_MS = 24 * 60 * 60e3;

/**
 * Resolve every F&O stock to its three instruments.
 *
 * Built off the same instrument master the rest of the app uses, so it costs nothing beyond
 * the once-a-day download that already happens. A stock whose future cannot be resolved is
 * still scanned — it just scores the open-interest factor as unavailable — because dropping
 * it entirely would silently shrink the universe.
 */
export async function universe(nowMs = Date.now()): Promise<Universe> {
  if (cached && nowMs - cached.builtAt < DAY_MS) return cached;

  const master = await instruments();
  const members: UniverseMember[] = [];

  for (const symbol of master.fno) {
    const equityKey = master.equity[symbol];
    if (!equityKey) continue; // listed derivative, unlisted share — nothing to price
    const sector = sectorOf(symbol);
    members.push({
      symbol,
      equityKey,
      future: await nearFuture(symbol, nowMs),
      sector,
      sectorIndexName: sector ? SECTOR_INDEX[sector] ?? null : null,
    });
  }

  const sectorIndexKeys = new Map<string, string>();
  for (const name of new Set(Object.values(SECTOR_INDEX))) {
    const key = master.indices[name.toUpperCase()];
    if (key) sectorIndexKeys.set(name, key);
  }

  cached = {
    members,
    bySymbol: new Map(members.map((m) => [m.symbol, m])),
    sectorIndexKeys,
    niftyKey: master.indices[NIFTY_INDEX] ?? 'NSE_INDEX|Nifty 50',
    niftyFuture: await nearFuture(NIFTY_FUTURES_UNDERLYING, nowMs),
    vixKey: master.indices[INDIA_VIX] ?? null,
    builtAt: nowMs,
  };
  return cached;
}

/** Drop the cached resolution. Used by the daily job so an expiry roll takes effect. */
export const resetUniverse = (): void => {
  cached = null;
};
