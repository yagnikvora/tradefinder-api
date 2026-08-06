// What the pullback scanner scans, and which instrument each reading comes off.
//
// The momentum module's universe is every F&O STOCK. This one adds the four index underlyings
// the brief names, and they need a different treatment that is worth being explicit about
// because getting it wrong produces numbers that look right.
//
// AN INDEX PUBLISHES NO VOLUME. `NSE_INDEX|Nifty 50` quotes a level and nothing else: volume
// is 0, `average_price` is 0, there is no book. Three of this module's gates — volume
// expansion, VWAP, and the bid-ask veto — are therefore uncomputable on the index itself, and
// two of the six score components with them. That is not a small degradation; it is most of
// the strategy.
//
// So an index is scanned through its NEAR-MONTH FUTURE. The future has real volume, a real
// session VWAP, a real book, and its 1-minute candles are the ones every index intraday
// trader is actually looking at when they draw a 9/20 EMA. The cost is the basis: futures
// trade a few points off spot and the offset drifts through the day. That is carried
// explicitly as `basis` rather than ignored, because the OPTION chain is struck on spot — so a
// target computed on the futures chart has to be translated before it can be turned into a
// premium, and a module that skipped that step would quote option payoffs against a price the
// option does not reference.
//
// A stock needs no such treatment: its equity quote carries volume, VWAP and depth, and its
// options are struck on the same instrument.

import { instruments, nearFuture, type FuturesContract } from '../../equity.js';
import { INSTRUMENT_KEY } from '../../upstox.js';
import { sectorOf } from '../../momentum/data/universe.js';
import type { InstrumentKind } from '../types.js';

/**
 * Config symbol -> the key `upstox.ts` maps to an `NSE_INDEX|…` instrument.
 *
 * Two lookups rather than one hard-coded map: the display names in Upstox's instrument master
 * are not the trading symbols (`NSE_INDEX|BANKNIFTY` is rejected where `NSE_INDEX|Nifty Bank`
 * is accepted), and the master is the thing that stays right when NSE renames an index.
 */
const INDEX_ALIAS: Record<string, string> = {
  NIFTY: 'NIFTY 50',
  NIFTY50: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  NIFTYBANK: 'NIFTY BANK',
  FINNIFTY: 'FINNIFTY',
  MIDCPNIFTY: 'MIDCPNIFTY',
};

/** Display names, so a row says NIFTY rather than "Nifty 50". */
const INDEX_LABEL: Record<string, string> = {
  NIFTY: 'Nifty 50',
  BANKNIFTY: 'Nifty Bank',
  FINNIFTY: 'Nifty Fin Service',
  MIDCPNIFTY: 'Nifty Midcap Select',
};

export interface Member {
  symbol: string;
  name: string | null;
  kind: InstrumentKind;
  sector: string | null;

  /**
   * The instrument the CANDLES and the quote come from — the share for a stock, the near
   * future for an index. Everything in `frames.ts` is built off this one key, so there is
   * exactly one answer to "which series is this EMA on".
   */
  seriesKey: string;
  /**
   * The instrument the OPTION CHAIN is struck on — the share for a stock, the index itself for
   * an index. Differs from `seriesKey` precisely when `kind === 'index'`.
   */
  optionKey: string;
  /** The index level, for indices. Quoted alongside so the basis is visible and checkable. */
  spotKey: string | null;
  future: FuturesContract | null;
  /** NSE's lot for this underlying. Options on it carry the same lot. */
  lotSize: number | null;
}

export interface Universe {
  members: Member[];
  bySymbol: Map<string, Member>;
  niftyKey: string;
  vixKey: string | null;
  builtAt: number;
}

const DAY_MS = 24 * 60 * 60e3;
let cached: Universe | null = null;

/**
 * Resolve every scanned symbol to its instruments.
 *
 * An index whose future cannot be resolved is DROPPED rather than scanned off the spot: the
 * whole reason the future is used is that the spot has no volume, and a NIFTY row silently
 * scored without the volume gate would be the one row on the board playing by different rules.
 * A stock whose future is missing is kept — it loses only its lot size, and its equity series
 * is complete.
 */
export async function universe(
  cfg: { indices: string[]; includeFnoStocks: boolean; exclude: string[] },
  nowMs = Date.now(),
): Promise<Universe> {
  if (cached && nowMs - cached.builtAt < DAY_MS) return cached;

  const master = await instruments();
  const exclude = new Set(cfg.exclude.map((s) => s.toUpperCase()));
  const members: Member[] = [];

  for (const raw of cfg.indices) {
    const symbol = raw.toUpperCase();
    if (exclude.has(symbol)) continue;
    const alias = INDEX_ALIAS[symbol] ?? symbol;
    const spotKey = INSTRUMENT_KEY[alias] ?? master.indices[alias.toUpperCase()] ?? null;
    const future = await nearFuture(symbol, nowMs);
    if (!spotKey || !future) continue;

    members.push({
      symbol,
      name: INDEX_LABEL[symbol] ?? alias,
      kind: 'index',
      sector: null,
      seriesKey: future.instrumentKey,
      optionKey: spotKey,
      spotKey,
      future,
      lotSize: future.lotSize || null,
    });
  }

  if (cfg.includeFnoStocks) {
    for (const symbol of master.fno) {
      if (exclude.has(symbol)) continue;
      const equityKey = master.equity[symbol];
      if (!equityKey) continue; // listed derivative, unlisted share — nothing to price
      const future = await nearFuture(symbol, nowMs);
      members.push({
        symbol,
        name: null,
        kind: 'stock',
        sector: sectorOf(symbol),
        seriesKey: equityKey,
        optionKey: equityKey,
        spotKey: null,
        future,
        lotSize: future?.lotSize || null,
      });
    }
  }

  cached = {
    members,
    bySymbol: new Map(members.map((m) => [m.symbol, m])),
    niftyKey: master.indices['NIFTY 50'] ?? 'NSE_INDEX|Nifty 50',
    vixKey: master.indices['INDIA VIX'] ?? null,
    builtAt: nowMs,
  };
  return cached;
}

/** Drop the cached resolution, so an expiry roll or a new F&O listing takes effect. */
export const resetUniverse = (): void => {
  cached = null;
};
