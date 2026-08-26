// The trade journal — every alert this app sends, recorded as a position and settled at the
// close, so the day can be read at night instead of watched.
//
// WHY IT IS NOT A LOG FILE. An alert says "buy this contract"; a journal has to say what that
// instruction was actually worth. That needs three things a log cannot give you: the contract's
// price at the moment of the alert, its price path afterwards, and the exit rule applied to that
// path the same way the backtest applied it. All three are here.
//
// WHERE IT IS STORED is `./repository.ts`, and the short version is: local disk always, plus
// Postgres when `DATABASE_URL` is set, because the machine that records the day and the machine
// that reads it are not the same machine.
//
// HOW A TRADE GETS ITS PRICES, and why in this order:
//
//   ENTRY is the ASK at signal time, taken from the `StrikeChoice` the alert had already
//   resolved. Not the mid and not the last trade — the ask is what a buyer pays, and a journal
//   that marks entries at the mid reports an edge that half the spread already ate.
//
//   THE RUNNING MARK comes from the WebSocket feed. The option's own instrument key is
//   subscribed on the first tick after the alert, so watching a position through the day costs
//   no REST quota at all. This is the number the page shows while the market is open.
//
//   THE SETTLED EXIT comes from the contract's own 1-minute candles, fetched once after the
//   close. This is the authoritative record and it deliberately overwrites whatever the live
//   marks concluded, for two reasons. First, it is correct even if this process was asleep for
//   the afternoon — an uptime gap costs the day nothing. Second, a 15-second tick stream only
//   sees the prices it happens to sample, so it misses the low that would have stopped you out
//   and reports a better day than you had; the candle path sees the whole excursion.
//
//   WITHIN ONE CANDLE THE STOP WINS. A minute bar cannot say whether its high or its low came
//   first, and resolving that in the trade's favour is how a backtest invents an edge. Same
//   convention as `research/lab.mjs`, so the journal and the study can be compared.
//
// WHAT IT DOES NOT DO. It never places an order and never claims your fill was its fill. The
// entry and exit it records are the tradeable prices that existed; yours will differ, and
// `PATCH /momentum/journal/:id` exists so you can replace either with what you actually got.
// An edited trade is flagged and the page shows it as yours rather than the system's.

import { istDay, istMinutes, SESSION_CLOSE_MIN, SESSION_OPEN_MIN } from '../session.js';
import { feedTick, subscribeKeys } from '../../feed/client.js';
import { sessionCandles, type UpstoxCandle } from '../../upstox.js';
import {
  FileJournalRepository, MirrorJournalRepository,
  type JournalRepository, type JournalSyncStatus,
} from './repository.js';
import {
  databaseUrl, getPool, PostgresJournalRepository, savePaths, type OptionPathRow,
} from './postgres.js';
import { store, STORE_KEYS } from '../store.js';
import type {
  JournalChannel, JournalContract, JournalEntryInput, JournalShadow, JournalTrade,
} from './types.js';

export type {
  JournalChannel, JournalContract, JournalEntryInput, JournalFill, JournalShadow, JournalTrade,
} from './types.js';
export type { JournalSyncStatus } from './repository.js';

/* ---------------------------------------------------------------------------- config --- */

const num = (name: string, fallback: number, lo: number, hi: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= lo && raw <= hi ? raw : fallback;
};

/**
 * The exit the journal applies, and the alternatives it scores alongside it.
 *
 * The defaults are the pair the 36-session study settled on: a -50% stop with the position run
 * to +80% or to the square-off. They are deliberately NOT a 15%/30% pair — that combination was
 * measured at -2.9% of premium a trade, because 2.5% each way plus a day of decay is already
 * 8.5% of premium and a 15-point stop has only about 6.5 points of room left in it. The
 * `shadow` rules below re-score every trade under the tighter pairs anyway, so the page can
 * show what the alternative would have cost on the same prices rather than arguing about it.
 */
export const journalConfig = () => ({
  enabled: (process.env.JOURNAL ?? 'on').trim().toLowerCase() !== 'off',
  /** Take-profit and stop, as a percentage of what the contract cost. */
  tpPct: num('JOURNAL_TP_PCT', 80, 1, 1000) / 100,
  slPct: num('JOURNAL_SL_PCT', 50, 1, 99) / 100,
  /** Minute of session to square off anything still open. 360 = 15:15. */
  squareOffMin: num('JOURNAL_SQUARE_OFF_MIN', 360, 1, SESSION_CLOSE_MIN - SESSION_OPEN_MIN),
  /**
   * Round-trip charges per lot, in rupees: brokerage both ways plus STT, exchange transaction
   * charges, SEBI turnover fee, GST and stamp duty. One configurable number rather than a
   * modelled breakdown, because the breakdown differs by broker and the total is what lands in
   * the account. Set it to your own from a contract note.
   */
  chargePerLot: num('JOURNAL_CHARGE_PER_LOT', 120, 0, 100_000),
  /** Lots per position. One, until there is a reason for more. */
  lots: num('JOURNAL_LOTS', 1, 1, 1000),
  /** How far back the boot-time reconcile pushes local history the database has never seen. */
  backfillDays: num('JOURNAL_BACKFILL_DAYS', 120, 1, 3650),
});

/**
 * An exit rule the journal can grade a path under — the shipped one, or an alternative.
 *
 * `armAt`/`trail` are what make a rule PATH-DEPENDENT rather than two fixed price levels. They
 * exist because two fixed levels cannot express the thing the record actually shows going wrong:
 * a position that was up 25% at 11:00 and was handed to the square-off at a loss.
 */
export interface ExitRule {
  name: string;
  tp: number;
  sl: number;
  /** Once the position has been up this much, the stop moves. Omitted = it never moves. */
  armAt?: number;
  /** Where it moves to: 'breakeven', or this many points below the running peak. */
  trail?: number | 'breakeven';
}

/**
 * The alternatives every settled trade is re-scored under, on its own candles.
 *
 * WHY THE TRAILING ONES WERE ADDED (2026-08-27). Over the first 65 trades the record decomposes
 * into 5 trades that reached +80% and paid ₹78,723 — more than the whole book's profit — 54
 * square-offs worth ₹26,305, and 6 stops costing ₹47,449. Two conclusions follow and they pull in
 * opposite directions: the rare full winners ARE the edge, so no rule that caps the upside can be
 * adopted (+30/-50 and +60/-30 both score worse here on real paths); but 17 trades were up 15% or
 * more and still closed red, which is ₹67,340 of profit handed back to the clock.
 *
 * A trail is the only shape that can protect the second without capping the first. Whether it
 * actually does cannot be answered from the trades already recorded — reconstructing a trail from
 * a stored peak is look-ahead, because the real thing trails the RUNNING peak and would exit at
 * the first retrace from an intermediate high. So these are graded live, on real paths, and the
 * shipped exit stays where it is until they have enough trades to be worth reading.
 *
 * Arming levels are deliberately high. Of the 6 stops, 4 never got above +11%, so a low arm mostly
 * converts trades that were going to lose anyway while clipping the winners that carry the book.
 */
export const SHADOW: ExitRule[] = [
  { name: '+30/-15', tp: 0.30, sl: 0.15 },
  { name: '+30/-50', tp: 0.30, sl: 0.50 },
  { name: '+60/-30', tp: 0.60, sl: 0.30 },
  { name: 'BE@+20', tp: 0.80, sl: 0.50, armAt: 0.20, trail: 'breakeven' },
  { name: 'trail25@+40', tp: 0.80, sl: 0.50, armAt: 0.40, trail: 0.25 },
  { name: 'trail30@+50', tp: 0.80, sl: 0.50, armAt: 0.50, trail: 0.30 },
];

/* ------------------------------------------------------------------------- the store --- */

let repository: JournalRepository | null = null;

/**
 * Local disk, plus Postgres when a database is configured.
 *
 * Built lazily rather than at import: `DATABASE_URL` is loaded by `src/env.js`, and a module
 * evaluated before it would decide there was no database and cache that decision for the life of
 * the process.
 */
export function journalRepository(): JournalRepository {
  if (repository) return repository;
  const url = databaseUrl();
  const local = new FileJournalRepository();
  repository = url ? new MirrorJournalRepository(local, new PostgresJournalRepository()) : local;
  return repository;
}

/** Test seam, and how `check-neon` points a probe at its own connection. */
export function setJournalRepository(r: JournalRepository | null): void {
  repository = r;
}

/* ------------------------------------------------------------------------- the money --- */

/**
 * Fill in the rupee columns from whatever prices the trade currently has.
 *
 * Kept in one place and called from every mutation, so an edited fill and an auto one cannot end
 * up with the money computed two different ways.
 */
function price(t: JournalTrade): void {
  const cfg = journalConfig();
  const size = t.contract ? t.contract.lotSize * t.lots : 0;
  t.amountUsed = size > 0 ? +(t.entry.premium * size).toFixed(2) : null;
  t.updatedAt = Date.now();
  // An untracked exit means nobody could put a price on the contract. Grading that as a loss —
  // or charging brokerage on it — would be inventing both the fill and the fee.
  if (!t.exit || t.exit.reason === 'untracked' || !(size > 0)) {
    t.grossPnl = null; t.charges = null; t.netPnl = null; t.netPct = null;
    return;
  }
  t.grossPnl = +((t.exit.premium - t.entry.premium) * size).toFixed(2);
  t.charges = +(cfg.chargePerLot * t.lots).toFixed(2);
  t.netPnl = +(t.grossPnl - t.charges).toFixed(2);
  t.netPct = t.amountUsed ? +(t.netPnl / t.amountUsed).toFixed(4) : null;
}

/* ------------------------------------------------------------------------- recording --- */

/**
 * Journal a batch of alerts. Called by each channel immediately after it has resolved contracts
 * and delivered the message.
 *
 * Never throws. A journal that can break an alert is worse than no journal — the alert is the
 * thing that spends money and it must reach the phone whatever happens here.
 */
export async function recordEntries(
  channel: JournalChannel,
  rows: JournalEntryInput[],
  nowMs = Date.now(),
): Promise<void> {
  const cfg = journalConfig();
  if (!cfg.enabled || !rows.length) return;
  try {
    const repo = journalRepository();
    const day = istDay(nowMs);
    const seen = await repo.existing(day);
    const minute = Math.max(0, istMinutes(nowMs) - SESSION_OPEN_MIN);
    const fresh: JournalTrade[] = [];

    for (const r of rows) {
      const id = `${day}:${channel}:${r.symbol}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const lotSize = r.strike?.lotSize ?? r.lotSize ?? null;
      const contract: JournalContract | null = r.strike && lotSize
        ? {
          label: r.strike.label,
          strike: r.strike.strike,
          type: r.strike.type,
          instrumentKey: r.strike.instrumentKey,
          expiry: r.strike.expiry,
          lotSize,
        }
        : null;
      // The ask, not the mid — see the note at the top of this file. `entryCost` is already
      // the ask; `premium` is the last trade and is the fallback when the book was one-sided.
      const paid = r.strike ? (r.strike.entryCost > 0 ? r.strike.entryCost : r.strike.premium) : 0;
      const t: JournalTrade = {
        id, day, channel, symbol: r.symbol, direction: r.direction,
        contract, lots: cfg.lots,
        entry: { at: nowMs, minute: r.minute ?? minute, premium: +paid.toFixed(2), spot: r.spot, source: 'auto' },
        exit: null, mark: null, mfePct: null, maePct: null,
        spreadPctAtEntry: r.strike?.spreadPct ?? null,
        amountUsed: null, grossPnl: null, charges: null, netPnl: null, netPct: null,
        shadow: [],
        readings: r.readings ?? {},
        note: r.note ?? '',
        // A contract that could not be priced is recorded anyway — the signal happened, and a
        // journal that hides its unpriceable days overstates how tradeable the feed is.
        status: contract && paid > 0 ? 'open' : 'closed',
        settled: false,
        edited: false,
        updatedAt: nowMs,
      };
      if (t.status === 'closed') {
        t.exit = { at: nowMs, minute: t.entry.minute, premium: 0, spot: r.spot, source: 'auto', reason: 'untracked' };
        t.settled = true;
      }
      price(t);
      fresh.push(t);
    }
    if (!fresh.length) return;
    await repo.save(fresh);
    subscribeOpen(nowMs).catch(() => {});
  } catch {
    // Deliberately swallowed. See the doc comment.
  }
}

/* ---------------------------------------------------------------------- live marking --- */

/** Ask the feed for every open contract. Idempotent, so calling it every tick is free. */
async function subscribeOpen(nowMs: number): Promise<void> {
  const day = istDay(nowMs);
  const keys = (await journalRepository().mine(day))
    .filter((t) => t.status === 'open' && t.contract)
    .map((t) => t.contract!.instrumentKey);
  if (keys.length) subscribeKeys(keys);
}

/**
 * One pass over today's open positions: mark them, and close any that have hit a level.
 *
 * The exits found here are provisional — `settleDay` re-derives them from candles afterwards.
 * They exist so the page has something true to show at 11:00, not as the record.
 *
 * Reads the LOCAL copy on purpose. See `JournalRepository.mine`.
 */
export async function journalTick(nowMs = Date.now()): Promise<void> {
  const cfg = journalConfig();
  if (!cfg.enabled) return;
  const repo = journalRepository();
  await subscribeOpen(nowMs).catch(() => {});

  const day = istDay(nowMs);
  const minute = Math.max(0, istMinutes(nowMs) - SESSION_OPEN_MIN);
  const changed: JournalTrade[] = [];

  for (const t of await repo.mine(day)) {
    if (t.status !== 'open' || !t.contract) continue;
    const tick = feedTick(t.contract.instrumentKey);
    // The bid is what a seller gets. Falling back to the last trade is a small optimism and
    // only ever affects the live view — the settled record comes from candles.
    const best = tick?.depth?.[0];
    const out = best && best.bidP > 0 ? best.bidP : tick?.ltp ?? 0;
    if (out > 0) {
      const pct = (out - t.entry.premium) / t.entry.premium;
      t.mark = { at: nowMs, premium: +out.toFixed(2), pct: +pct.toFixed(4) };
      // The minute is recorded only when the extreme actually moves, so it always names the tick
      // that set it rather than the tick that last looked.
      if (t.mfePct === null || pct > t.mfePct) { t.mfePct = pct; t.mfeMinute = minute; }
      if (t.maePct === null || pct < t.maePct) { t.maePct = pct; t.maeMinute = minute; }
      t.updatedAt = nowMs;
      changed.push(t);

      // Stop checked before target: if this tick could be read either way, it is the stop.
      if (pct <= -cfg.slPct || pct >= cfg.tpPct) {
        t.exit = {
          at: nowMs, minute, premium: t.mark.premium, spot: null, source: 'auto',
          reason: pct <= -cfg.slPct ? 'stop' : 'target',
        };
        t.status = 'closed';
        price(t);
      }
    }
    if (t.status === 'open' && minute >= cfg.squareOffMin && t.mark) {
      t.exit = { at: nowMs, minute, premium: t.mark.premium, spot: null, source: 'auto', reason: 'square-off' };
      t.status = 'closed';
      price(t);
      if (!changed.includes(t)) changed.push(t);
    }
  }
  if (changed.length) await repo.save(changed);
  // Retry anything the database has not taken yet. Cheap, and a no-op when nothing is queued.
  await repo.flush().catch(() => {});
}

/* -------------------------------------------------------------------------- settling --- */

/**
 * Grade one premium path against a target and a stop.
 *
 * Exported because this function IS the journal's opinion — everything else is bookkeeping. The
 * convention it encodes is the one from `research/lab.mjs`: a minute bar cannot say whether its
 * high or its low came first, so a bar that touches both levels is resolved as the STOP. Grading
 * it the other way is how a record flatters itself.
 */
export function gradePath(
  bars: Array<{ minute: number; high: number; low: number; close: number }>,
  paid: number,
  fromMinute: number,
  tp: number,
  sl: number,
  lastMinute: number,
): {
  pct: number; out: 'target' | 'stop' | 'close'; minute: number;
  mfe: number; mae: number;
  /**
   * The minute each extreme was set, or null while that extreme is still 0.
   *
   * Null rather than the entry minute on purpose: `mfe` and `mae` both start at 0 and are only
   * ever moved by a bar that beat them, so a trade that never traded above its entry has an `mfe`
   * of exactly 0 that belongs to no minute at all. Reporting the entry minute there would invent a
   * moment when the position was at its best, which is the one thing this column must not do.
   */
  mfeMinute: number | null; maeMinute: number | null;
} {
  let mfe = 0, mae = 0, lastClose = paid, lastMin = fromMinute;
  let mfeMinute: number | null = null, maeMinute: number | null = null;
  for (const b of bars) {
    if (b.minute <= fromMinute || b.minute > lastMinute) continue;
    const down = (b.low - paid) / paid;
    const up = (b.high - paid) / paid;
    if (down < mae) { mae = down; maeMinute = b.minute; }
    if (up > mfe) { mfe = up; mfeMinute = b.minute; }
    lastClose = b.close; lastMin = b.minute;
    if (down <= -sl) return { pct: -sl, out: 'stop', minute: b.minute, mfe, mae, mfeMinute, maeMinute };
    if (up >= tp) return { pct: tp, out: 'target', minute: b.minute, mfe, mae, mfeMinute, maeMinute };
  }
  return { pct: (lastClose - paid) / paid, out: 'close', minute: lastMin, mfe, mae, mfeMinute, maeMinute };
}

/**
 * Grade a path under a rule whose stop can MOVE — a breakeven or a trailing exit.
 *
 * `gradePath` above stays as it is because it grades the shipped exit and the tests pin it; this
 * is the generalisation the shadow rules need, and it reduces to the same answer when a rule has
 * no `armAt`.
 *
 * TWO THINGS HERE ARE LOAD-BEARING AND MUST SURVIVE AN EDIT.
 *
 *   THE TRAIL IS COMPUTED FROM THE PREVIOUS BAR'S PEAK, never this bar's high. Letting one bar
 *   both set a new high and be stopped on the trail derived from that same high is how a
 *   backtest sells every top: in the real session the trail had not moved yet when the low
 *   printed. This single line is the difference between a believable result and a fantasy.
 *
 *   THE STOP IS STILL CHECKED BEFORE THE TARGET, so an ambiguous minute resolves against the
 *   trade, exactly as everywhere else in this file.
 */
export function gradeRule(
  bars: Array<{ minute: number; high: number; low: number; close: number }>,
  paid: number,
  fromMinute: number,
  rule: ExitRule,
  lastMinute: number,
): { pct: number; out: 'target' | 'stop' | 'close'; minute: number } {
  let peak = 0, lastClose = paid, lastMin = fromMinute;
  for (const b of bars) {
    if (b.minute <= fromMinute || b.minute > lastMinute) continue;
    const up = (b.high - paid) / paid;
    const down = (b.low - paid) / paid;

    let stop = -rule.sl;
    if (rule.armAt !== undefined && rule.trail !== undefined && peak >= rule.armAt) {
      stop = rule.trail === 'breakeven' ? 0 : Math.max(-rule.sl, peak - rule.trail);
    }

    if (down <= stop) return { pct: stop, out: 'stop', minute: b.minute };
    if (up >= rule.tp) return { pct: rule.tp, out: 'target', minute: b.minute };

    if (up > peak) peak = up;
    lastClose = b.close; lastMin = b.minute;
  }
  return { pct: (lastClose - paid) / paid, out: 'close', minute: lastMin };
}

/**
 * Upstox candles to the minute-of-session bars `gradePath` grades.
 *
 * EXTRACTED SO IT CAN BE TESTED, because the one line in it was wrong for the life of the module
 * and nothing caught it. `c[0]` is epoch SECONDS — `UpstoxCandle` documents that, and `isoToEpoch`
 * divides by 1000 — while `istMinutes` takes MILLISECONDS. Passing the raw value read a 2026
 * candle as 21 January 1970 and put every bar of every session at minute ~768. `gradePath` drops
 * anything past the square-off minute, so every bar was discarded and it returned its empty-path
 * answer: an exit equal to the entry, at the entry minute, with zero excursion. Every settled
 * trade therefore booked exactly minus the charges, and looked like a real flat day.
 *
 * It survived because the settlement path had never run on a real trade: the journal was empty
 * until a backfill filled it, and backfilled rows arrive already settled. The first live signal to
 * reach settlement (AUBANK, 2026-08-25) exposed it immediately.
 */
export function sessionBars(
  raw: UpstoxCandle[],
): Array<{ minute: number; high: number; low: number; close: number }> {
  return raw
    .map((c) => ({
      minute: Math.max(0, istMinutes(c[0] * 1000) - SESSION_OPEN_MIN),
      high: c[2], low: c[3], close: c[4],
    }))
    .sort((a, b) => a.minute - b.minute);
}

/** One archived contract path: `[minute, high, low, close]` per bar. */
export type ArchivedPath = Array<[number, number, number, number]>;

/**
 * Keep every settled contract's candle path, keyed by trade id.
 *
 * Stored through the same `store` the rest of the module uses, one document a month, so it lands
 * beside the journal and is copied with it. Never throws — an archive that can break settlement
 * would be trading the record for a research convenience.
 */
async function archivePaths(
  day: string,
  trades: JournalTrade[],
  fetched: Map<string, Array<{ minute: number; high: number; low: number; close: number }>>,
): Promise<void> {
  const compact = new Map<string, ArchivedPath>();
  for (const t of trades) {
    if (!t.contract) continue;
    const bars = fetched.get(t.contract.instrumentKey);
    if (!bars?.length || compact.has(t.id)) continue;
    compact.set(t.id, bars.map((b) => [b.minute, b.high, b.low, b.close] as [number, number, number, number]));
  }
  if (!compact.size) return;

  // Local disk FIRST, for the same reason the journal writes locally first: disk is milliseconds
  // and cannot be unreachable, and this is the copy that must exist before the key expires.
  const key = `${STORE_KEYS.journalPaths}_${day.slice(0, 7)}`;
  const doc = (await store.read<Record<string, ArchivedPath>>(key)) ?? {};
  let added = 0;
  for (const [id, bars] of compact) {
    if (doc[id]) continue;
    doc[id] = bars;
    added++;
  }
  if (added) await store.write(key, doc);

  // Then the shared store, best effort. A failure here is logged by the caller's catch and costs
  // nothing permanent — the local copy is already safe and `journal-archive-push` can retry it.
  if (!databaseUrl()) return;
  const rows: OptionPathRow[] = [];
  for (const t of trades) {
    const bars = compact.get(t.id);
    if (!bars || !t.contract) continue;
    rows.push({
      day: t.day,
      instrumentKey: t.contract.instrumentKey,
      symbol: t.symbol,
      strike: t.contract.strike ?? null,
      optType: t.contract.type ?? null,
      expiry: t.contract.expiry ?? null,
      lotSize: t.contract.lotSize ?? null,
      role: 'traded',
      bars,
    });
  }
  if (rows.length) await savePaths(getPool(), rows);
}

/**
 * Fetch each open contract's own candles and write the authoritative exit.
 *
 * Runs after the square-off minute, and on boot for any earlier day left unsettled — which is
 * what makes an overnight restart or a crashed afternoon cost the record nothing.
 */
export async function settleDay(day: string, nowMs = Date.now()): Promise<number> {
  const cfg = journalConfig();
  if (!cfg.enabled) return 0;
  const repo = journalRepository();
  const today = istDay(nowMs);
  const pending = (await repo.unsettled()).filter((t) => t.day === day && t.contract);
  if (!pending.length) return 0;

  // Fetched before any write: this is the slow part, and interleaving network waits with disk
  // writes would hold the write chain for as long as Upstox takes to answer.
  const fetched = new Map<string, Array<{ minute: number; high: number; low: number; close: number }>>();
  for (const t of pending) {
    const key = t.contract!.instrumentKey;
    if (fetched.has(key)) continue;
    try {
      fetched.set(key, sessionBars(await sessionCandles(key, day, today, 'minutes', 1)));
    } catch {
      fetched.set(key, []);
    }
  }

  // THE PATH IS ARCHIVED BEFORE ANYTHING IS GRADED, because it is perishable in a way nothing
  // else here is. Upstox answers `UDAPI100011 Invalid Instrument key` for a contract whose series
  // has expired — verified on 2026-08-27, when every July and August option in this journal became
  // unfetchable and an exit-rule study across 61 settled trades could no longer be run at all. The
  // trades survived; the evidence needed to ask a NEW question of them did not.
  //
  // Compact on purpose: [minute, high, low, close] per bar, which is everything `gradeRule` reads.
  await archivePaths(day, pending, fetched).catch(() => {});

  const done: JournalTrade[] = [];
  for (const t of pending) {
    // An edited trade is the operator's record of their own fill. Settlement must not
    // overwrite it — it would silently replace what they typed with what the market did.
    if (t.edited) { t.settled = true; t.updatedAt = nowMs; done.push(t); continue; }
    const bars = fetched.get(t.contract!.instrumentKey) ?? [];
    if (!bars.length) {
      // No candles for the contract. Keep whatever the live marks concluded rather than
      // inventing a price, and say so.
      if (!t.exit) {
        t.exit = {
          at: nowMs, minute: t.entry.minute, premium: t.entry.premium, spot: null,
          source: 'auto', reason: 'untracked',
        };
        t.note = [t.note, 'no candles for the contract; exit not priced'].filter(Boolean).join(' · ');
        t.status = 'closed';
      }
      t.settled = true; price(t); done.push(t);
      continue;
    }
    const r = gradePath(bars, t.entry.premium, t.entry.minute, cfg.tpPct, cfg.slPct, cfg.squareOffMin);
    t.exit = {
      at: nowMs, minute: r.minute, premium: +(t.entry.premium * (1 + r.pct)).toFixed(2),
      spot: null, source: 'auto',
      reason: r.out === 'close' ? 'square-off' : r.out,
    };
    t.mfePct = +r.mfe.toFixed(4);
    t.maePct = +r.mae.toFixed(4);
    t.mfeMinute = r.mfeMinute;
    t.maeMinute = r.maeMinute;
    t.shadow = SHADOW.map((s): JournalShadow => {
      const w = gradeRule(bars, t.entry.premium, t.entry.minute, s, cfg.squareOffMin);
      return { name: s.name, pct: +w.pct.toFixed(4), out: w.out, minute: w.minute };
    });
    t.status = 'closed';
    t.settled = true;
    price(t);
    done.push(t);
  }
  if (done.length) await repo.save(done);
  return done.length;
}

/**
 * Settle anything outstanding — today if the square-off has passed, and any earlier day still
 * open. Called from the scheduler; safe to call repeatedly.
 */
export async function journalSettleDue(nowMs = Date.now()): Promise<number> {
  const cfg = journalConfig();
  if (!cfg.enabled) return 0;
  const today = istDay(nowMs);
  const minute = istMinutes(nowMs) - SESSION_OPEN_MIN;
  const days = new Set((await journalRepository().unsettled()).map((t) => t.day));
  let n = 0;
  for (const day of [...days].sort()) {
    if (day === today && minute < cfg.squareOffMin) continue;
    n += await settleDay(day, nowMs);
  }
  return n;
}

/**
 * One-shot startup work: push local history the database has never seen.
 *
 * Called from the scheduler AND from the first journal request, so a process running without the
 * scheduler — `npm run viewer` on the reading machine — still reconciles.
 */
let booted = false;
export async function journalBoot(): Promise<number> {
  if (booted || !journalConfig().enabled) return 0;
  booted = true;
  try {
    return await journalRepository().reconcile(journalConfig().backfillDays);
  } catch {
    return 0;
  }
}

/** Test seam: forget that boot already ran. */
export function resetJournalBoot(): void {
  booted = false;
}

/* --------------------------------------------------------------------------- reading --- */

export interface JournalTotals {
  trades: number;
  closed: number;
  open: number;
  untracked: number;
  wins: number;
  losses: number;
  winRate: number | null;
  amountUsed: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  /** Net against the money actually deployed, which is the only return that means anything. */
  netPct: number | null;
  best: number | null;
  worst: number | null;
  byChannel: Array<{ channel: string; trades: number; wins: number; netPnl: number; winRate: number | null }>;
  shadow: Array<{ name: string; netPnl: number; wins: number; trades: number }>;
}

export interface JournalDay {
  day: string;
  trades: JournalTrade[];
  totals: JournalTotals;
}

function totals(trades: JournalTrade[]): JournalTotals {
  const cfg = journalConfig();
  const done = trades.filter((t) => t.netPnl !== null);
  const wins = done.filter((t) => (t.netPnl ?? 0) > 0).length;
  const sum = (f: (t: JournalTrade) => number | null) => +done.reduce((a, t) => a + (f(t) ?? 0), 0).toFixed(2);
  const used = +trades.reduce((a, t) => a + (t.amountUsed ?? 0), 0).toFixed(2);
  const net = sum((t) => t.netPnl);

  const channels = new Map<string, { trades: number; wins: number; netPnl: number }>();
  for (const t of trades) {
    const c = channels.get(t.channel) ?? { trades: 0, wins: 0, netPnl: 0 };
    c.trades++;
    if ((t.netPnl ?? 0) > 0) c.wins++;
    c.netPnl += t.netPnl ?? 0;
    channels.set(t.channel, c);
  }

  // What the alternative exits would have returned on the same prices. Only trades that were
  // actually settled carry shadows, so this compares like with like.
  const shadow = SHADOW.map((s) => {
    const rows = trades.filter((t) => t.shadow.some((x) => x.name === s.name) && t.amountUsed);
    let netPnl = 0, w = 0;
    for (const t of rows) {
      const sh = t.shadow.find((x) => x.name === s.name)!;
      const g = sh.pct * (t.amountUsed ?? 0) - cfg.chargePerLot * t.lots;
      netPnl += g;
      if (g > 0) w++;
    }
    return { name: s.name, netPnl: +netPnl.toFixed(2), wins: w, trades: rows.length };
  });

  return {
    trades: trades.length,
    closed: trades.filter((t) => t.status === 'closed').length,
    open: trades.filter((t) => t.status === 'open').length,
    untracked: trades.filter((t) => t.exit?.reason === 'untracked').length,
    wins, losses: done.length - wins,
    winRate: done.length ? +(wins / done.length).toFixed(4) : null,
    amountUsed: used,
    grossPnl: sum((t) => t.grossPnl),
    charges: sum((t) => t.charges),
    netPnl: net,
    netPct: used > 0 ? +(net / used).toFixed(4) : null,
    best: done.length ? Math.max(...done.map((t) => t.netPnl ?? 0)) : null,
    worst: done.length ? Math.min(...done.map((t) => t.netPnl ?? 0)) : null,
    byChannel: [...channels.entries()]
      .map(([channel, c]) => ({
        channel, trades: c.trades, wins: c.wins, netPnl: +c.netPnl.toFixed(2),
        winRate: c.trades ? +(c.wins / c.trades).toFixed(4) : null,
      }))
      .sort((a, b) => b.netPnl - a.netPnl),
    shadow,
  };
}

export interface JournalView {
  from: string;
  to: string;
  channel: string | null;
  days: JournalDay[];
  totals: JournalTotals;
  config: ReturnType<typeof journalConfig> & { shadow: typeof SHADOW };
  sync: JournalSyncStatus;
  /**
   * Weekdays in the range with no record at all.
   *
   * Named "no record" rather than "no signals" on purpose. A day the scanner was not running and
   * a day on which nothing qualified are indistinguishable in the data, and reading the first as
   * the second is how a gap in the record turns into a belief about the market.
   */
  emptyDays: number;
}

export async function journalRange(from: string, to: string, channel?: string | null): Promise<JournalView> {
  const repo = journalRepository();
  const all = await repo.range(from, to, (channel ?? null) as JournalChannel | null);
  const byDay = new Map<string, JournalTrade[]>();
  for (const t of all) {
    const a = byDay.get(t.day) ?? [];
    a.push(t); byDay.set(t.day, a);
  }
  const days: JournalDay[] = [...byDay.keys()].sort().reverse().map((day) => {
    const trades = byDay.get(day)!.sort((a, b) => a.entry.at - b.entry.at);
    return { day, trades, totals: totals(trades) };
  });
  return {
    from, to, channel: channel ?? null, days,
    totals: totals(all),
    config: { ...journalConfig(), shadow: SHADOW },
    sync: await repo.status(),
    emptyDays: Math.max(0, countSessionDays(from, to) - days.length),
  };
}

/** Calendar weekdays in the range. Holidays are not netted out; it is a rough "quiet" count. */
function countSessionDays(from: string, to: string): number {
  let n = 0;
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  for (let t = a; t <= b && n < 1000; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/* --------------------------------------------------------------------------- editing --- */

export interface JournalPatch {
  entryPremium?: number;
  exitPremium?: number;
  lots?: number;
  note?: string;
  /** Restore the prices settlement recorded, and let it own the row again. */
  reset?: boolean;
}

/**
 * Replace a trade's prices with the operator's own fill.
 *
 * Once edited, `settleDay` leaves the row alone — otherwise the next settlement pass would
 * quietly overwrite a real contract note with a modelled exit.
 */
export async function journalPatch(id: string, patch: JournalPatch): Promise<JournalTrade | null> {
  const repo = journalRepository();
  const t = await repo.one(id);
  if (!t) return null;

  if (patch.reset) {
    if (t.original) {
      t.entry = t.original.entry;
      t.exit = t.original.exit;
      t.status = t.exit ? 'closed' : 'open';
      delete t.original;
    }
    t.edited = false;
    // Left unsettled on purpose: the next settlement pass owns this row again, and for a past
    // day that pass runs within two minutes.
    t.settled = false;
    t.note = '';
  } else {
    // Snapshot before the first mutation, never after — a second edit must not overwrite the
    // only copy of what the market actually said.
    const wasEdited = t.edited;
    if (!wasEdited) t.original = { entry: { ...t.entry }, exit: t.exit ? { ...t.exit } : null };
    if (patch.entryPremium !== undefined) {
      t.entry.premium = +patch.entryPremium.toFixed(2);
      t.entry.source = 'manual';
      t.edited = true;
    }
    if (patch.exitPremium !== undefined) {
      t.exit = {
        at: Date.now(), minute: t.exit?.minute ?? t.entry.minute, premium: +patch.exitPremium.toFixed(2),
        spot: null, source: 'manual', reason: 'manual',
      };
      t.status = 'closed';
      t.settled = true;
      t.edited = true;
    }
    if (patch.lots !== undefined) { t.lots = Math.max(1, Math.round(patch.lots)); t.edited = true; }
    if (patch.note !== undefined) t.note = patch.note.slice(0, 500);
    // A note-only patch changed no price, so it must not leave a snapshot behind pretending it did.
    if (!t.edited && !wasEdited) delete t.original;
  }
  price(t);
  await repo.save([t]);
  return t;
}

/* ---------------------------------------------------------------------------- status --- */

export async function journalStatus(nowMs = Date.now()): Promise<Record<string, unknown>> {
  const cfg = journalConfig();
  const repo = journalRepository();
  const day = istDay(nowMs);
  const today = await repo.mine(day).catch(() => [] as JournalTrade[]);
  return {
    enabled: cfg.enabled,
    exit: `+${(100 * cfg.tpPct).toFixed(0)}% / -${(100 * cfg.slPct).toFixed(0)}%, square off at minute ${cfg.squareOffMin}`,
    chargePerLot: cfg.chargePerLot,
    lots: cfg.lots,
    today: {
      day,
      trades: today.length,
      open: today.filter((t) => t.status === 'open').length,
      unsettled: today.filter((t) => !t.settled).length,
    },
    // Where the record lives, and whether the far half of it is answering. `remote: 'degraded'`
    // with a non-zero `pending` is the state to act on — the day is safe on disk and is not
    // reaching the machine you read it on.
    sync: await repo.status(),
  };
}
