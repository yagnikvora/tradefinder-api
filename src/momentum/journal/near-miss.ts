// Archive the option path of a signal that QUALIFIED but was never taken.
//
// WHY. `momentum_candidate` records that RELIANCE met every gate at 09:31 and that the day's cap
// was already full, which is enough to ask "how often does the cap turn something away" but not
// "what would it have made". The second question needs the contract's own candles, and those are
// only fetchable while the series is unexpired — about four weeks. A near miss not archived inside
// that window can never be priced, in exactly the way the whole of July and August cannot.
//
// So this runs nightly, same day, and buys the option to answer a capacity question later.
//
// WHAT IT COSTS. Roughly a handful of symbols on the days the cap binds, two requests each — one
// chain to resolve the strike, one candle fetch. Against a ~200-request morning that is noise.
//
// WHAT IT IS NOT. It does not journal these as trades. They were never bought, no money moved, and
// putting them in the trade log would corrupt every win rate on the page. They are evidence, filed
// under `role = 'near-miss'` in the same archive the traded contracts use, and a study that wants
// them has to ask for them by name.

import { istDay } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { sessionCandles } from '../../upstox.js';
import { universe } from '../data/universe.js';
import { stockChain } from '../data/option-chain.js';
import { rule } from '../alerts/displacement.js';
import { databaseUrl, getPool, savePaths, type OptionPathRow } from './postgres.js';
import type { CandidateRow } from './postgres.js';
import type { ArchivedPath } from './journal.js';

/** `[minute, rvol, rangeAtr, moveAtr, offExtremeAtr, turnoverCr, ltp, direction]` */
type Tick = [number, number, number, number, number, number, number, 1 | -1];

/**
 * The first minute a symbol met EVERY gate, or null if it never did.
 *
 * The turnover gate is not re-checked: the log only ever contained symbols that already passed it,
 * so re-testing it here would silently drop everything if the threshold were ever raised.
 */
function firstQualifyingTick(ticks: Tick[], r: ReturnType<typeof rule>): Tick | null {
  for (const t of ticks) {
    const [, rvol, rangeAtr, moveAtr, offExtremeAtr] = t;
    if (rvol < r.minRvol || rvol > r.maxRvol) continue;
    if (rangeAtr < r.minRangeAtr) continue;
    if (moveAtr < r.minMoveAtr) continue;
    if (offExtremeAtr > r.maxOffExtremeAtr) continue;
    return t;
  }
  return null;
}

export interface NearMissResult {
  day: string;
  qualified: number;
  archived: number;
  skipped: number;
  failed: number;
}

/**
 * Archive paths for the day's unfired qualifiers.
 *
 * Idempotent: a symbol already in the local archive is skipped, so this is safe on a timer and
 * safe to re-run by hand.
 */
export async function archiveNearMisses(day: string, nowMs = Date.now()): Promise<NearMissResult> {
  const out: NearMissResult = { day, qualified: 0, archived: 0, skipped: 0, failed: 0 };

  const monthKey = `${STORE_KEYS.candidates}_${day.slice(0, 7)}`;
  const doc = await store.read<Record<string, CandidateRow[]>>(monthKey);
  const rows = doc?.[day];
  if (!rows?.length) return out;

  const r = rule();
  const wanted: Array<{ symbol: string; tick: Tick }> = [];
  for (const row of rows) {
    if (row.taken) continue;
    const tick = firstQualifyingTick(row.ticks as Tick[], r);
    if (tick) wanted.push({ symbol: row.symbol, tick });
  }
  out.qualified = wanted.length;
  if (!wanted.length) return out;

  const pathKey = `${STORE_KEYS.journalPaths}_${day.slice(0, 7)}`;
  const archive = (await store.read<Record<string, ArchivedPath>>(pathKey)) ?? {};
  const uni = await universe();
  const today = istDay(nowMs);
  const fresh: OptionPathRow[] = [];

  for (const { symbol, tick } of wanted) {
    // Same id shape as a journalled trade, with the channel marking what it is — so an archive
    // reader can tell a near miss from a trade without consulting the journal.
    const id = `${day}:displacement-nearmiss:${symbol}`;
    if (archive[id]) { out.skipped++; continue; }

    const member = uni.bySymbol.get(symbol);
    if (!member?.equityKey) { out.failed++; continue; }

    try {
      const [, , , , , , ltp, direction] = tick;
      const chain = await stockChain(symbol, member.equityKey, nowMs);
      const type: 'CE' | 'PE' = direction === 1 ? 'CE' : 'PE';
      // Nearest strike to where the stock actually was when it qualified, not to the current spot.
      const row = chain.rows.reduce<typeof chain.rows[number] | null>((best, x) => {
        const leg = type === 'CE' ? x.call : x.put;
        if (!leg?.instrumentKey) return best;
        return !best || Math.abs(x.strike - ltp) < Math.abs(best.strike - ltp) ? x : best;
      }, null);
      const leg = row && (type === 'CE' ? row.call : row.put);
      if (!row || !leg?.instrumentKey) { out.failed++; continue; }

      const raw = await sessionCandles(leg.instrumentKey, day, today, 'minutes', 1);
      const dayStart = Date.parse(`${day}T00:00:00Z`) + (9 * 60 + 15 - 330) * 60_000;
      const bars = raw
        .map((c) => [Math.round((c[0] * 1000 - dayStart) / 60_000), c[2], c[3], c[4]] as [number, number, number, number])
        .filter((b) => b[0] >= 0 && b[0] < 375)
        .sort((a, b) => a[0] - b[0]);
      if (!bars.length) { out.failed++; continue; }

      archive[id] = bars;
      fresh.push({
        day,
        instrumentKey: leg.instrumentKey,
        symbol,
        strike: row.strike,
        optType: type,
        expiry: chain.expiry,
        lotSize: null,
        role: 'near-miss',
        bars,
      });
      out.archived++;
    } catch {
      out.failed++;
    }
  }

  if (out.archived) {
    await store.write(pathKey, archive);
    if (databaseUrl()) await savePaths(getPool(), fresh).catch(() => 0);
  }
  return out;
}
