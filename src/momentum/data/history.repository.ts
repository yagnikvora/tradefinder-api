// MomentumHistory — the daily record, and the only reason IV Rank can ever exist here.
//
// IV Rank and IV Percentile are "where does today's implied volatility sit in its own
// trailing range". Upstox publishes implied volatility as of NOW and has no historical-IV
// endpoint at any tier — the option chain carries `option_greeks.iv` for the current
// quote and that is all. There is no way to compute a one-year IV rank from the API today.
//
// The three responses to that, in order of honesty:
//
//   1. RECORD IT. One row per symbol per session, written from the enrichment pass. After
//      `minSessionsForIvRank` sessions the rank is real and is labelled `iv-history`. This
//      is the only path to a true IV rank and it starts the day the module is deployed.
//
//   2. FALL BACK TO REALISED VOLATILITY while that warms. HV rank over 252 daily candles is
//      computable immediately and answers a closely related question. Labelled `hv-proxy`
//      so nobody reads it as implied.
//
//   3. SAY SO. `basis: 'unavailable'` and the factor drops out of the weighting.
//
// What is NOT done is interpolating an IV history out of option prices on historical
// candles. It is possible — back-solve Black-Scholes per session on the then-ATM strike —
// but strikes and expiries roll, the reconstruction is only as good as the roll rules, and
// a fabricated IV history feeding a scored factor is exactly the failure this module is
// built to avoid.

import type { MomentumHistoryRecord } from '../types.js';
import { store, STORE_KEYS } from '../store.js';

/** Two years of sessions is enough for a 252-day rank with room to spare. */
const MAX_DAYS_PER_SYMBOL = 520;

export interface HistoryRepository {
  /** Every stored session for a symbol, oldest first. */
  forSymbol(symbol: string): Promise<MomentumHistoryRecord[]>;
  /** Insert or replace today's row. */
  upsert(record: MomentumHistoryRecord): Promise<void>;
  /** Insert or replace many rows at once, with one write. */
  upsertMany(records: MomentumHistoryRecord[]): Promise<void>;
  /** How many sessions of history exist for a symbol. */
  depth(symbol: string): Promise<number>;
}

interface HistoryFile {
  /** symbol -> day -> record. Keyed by day so a re-run of the same session replaces it. */
  bySymbol: Record<string, Record<string, MomentumHistoryRecord>>;
}

export class StoredHistoryRepository implements HistoryRepository {
  private mem: HistoryFile | null = null;
  private loading: Promise<HistoryFile> | null = null;
  private dirty = false;
  private flushing: Promise<void> | null = null;

  private async load(): Promise<HistoryFile> {
    if (this.mem) return this.mem;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.mem = (await store.read<HistoryFile>(STORE_KEYS.history)) ?? { bySymbol: {} };
      return this.mem;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async forSymbol(symbol: string): Promise<MomentumHistoryRecord[]> {
    const f = await this.load();
    const days = f.bySymbol[symbol];
    if (!days) return [];
    return Object.keys(days).sort().map((d) => days[d]);
  }

  async depth(symbol: string): Promise<number> {
    const f = await this.load();
    return Object.keys(f.bySymbol[symbol] ?? {}).length;
  }

  async upsert(record: MomentumHistoryRecord): Promise<void> {
    return this.upsertMany([record]);
  }

  async upsertMany(records: MomentumHistoryRecord[]): Promise<void> {
    if (!records.length) return;
    const f = await this.load();
    for (const r of records) {
      const days = (f.bySymbol[r.symbol] ??= {});
      days[r.day] = r;
      const keys = Object.keys(days).sort();
      // Trim from the front so the file cannot grow without bound over years of operation.
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DAYS_PER_SYMBOL))) delete days[k];
    }
    this.dirty = true;
    await this.flush();
  }

  /** One write per call at most; concurrent callers share the in-flight one. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.mem) return;
    if (this.flushing) return this.flushing;
    this.dirty = false;
    const payload = this.mem;
    this.flushing = store.write(STORE_KEYS.history, payload).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Test seam. */
  reset(): void {
    this.mem = null;
    this.dirty = false;
  }
}

export const historyRepository = new StoredHistoryRepository();
