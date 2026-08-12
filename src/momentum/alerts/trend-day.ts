// The Trend Day signal — one message the moment a stock's conviction is CONFIRMED.
//
// This is the alert the trend-day board could never be. The board is a state you look at; this is
// the event you cannot be looking at, because it happens at 10:30 while you are reading something
// else. `advanceTrend` in `data/session-state.ts` promotes a stock to `Confirmed` after 75 minutes
// of session, a conviction of 70 held for twenty, and half an ATR of actual displacement — and the
// instant that promotion lands is the one moment worth interrupting somebody for.
//
// FOUR THINGS DECIDE WHETHER THIS IS USABLE OR MUTED, and all four came out of the real board.
//
//   THE 10:30 STAMPEDE. `minMinutesConfirmed` is 75, so nothing may confirm before 10:30 and a
//   great many things confirm AT 10:30 — on 2026-08-12 seventeen stocks confirmed and eight of
//   them landed in the same fifteen-second tick. Eight notifications in one second is how a
//   channel gets muted, and a muted channel costs the one alert that mattered. So a tick's
//   confirmations are collected and sent as ONE message. Nothing is delayed and nothing is
//   dropped: a lone confirmation at 13:29 is still its own message, sent within fifteen seconds.
//
//   IT MUST NOT FIRE LATE. A confirmation is only announced while it is fresh — see
//   `MAX_CONFIRM_AGE_MS`. That is what makes the alert honest ("this just happened" rather than
//   "this happened at some point"), and it is also the restart guard: a process that boots at
//   14:00 finds seventeen rows already sitting at `Confirmed`, and without the freshness test it
//   would announce all seventeen as though the afternoon had just erupted.
//
//   IT MUST NOT FIRE TWICE. Confirmed is a STATE, not an edge — the row stays there for hours, and
//   the phase machine's hysteresis lets a day fade and re-confirm. So a symbol and direction is
//   announced once per day, recorded to the same disk store the baseline uses so a restart does
//   not re-announce.
//
//   THE PLAN HAS TO BE REAL. The message names a contract, a stop, a target and what one lot
//   costs, so those numbers are built by `buildTrendDayPlan` — the module's own plan builder,
//   pinned to trend mode — and never recomputed here. A second implementation of the strategy
//   living inside the alert is how the message and the board start disagreeing about a price.
//
// WHAT THE MESSAGE DOES NOT CLAIM. Confirmation is a statement about the DAY, not about this
// second's entry: by 10:30 the move is 75 minutes old and price is often extended. The module's
// own view is that the good trend-day entry is a retracement into the trend, so the message says
// how far off the day's extreme price currently is and lets that be read rather than implying the
// confirmation price is the entry.

import { istDay } from '../session.js';
import { store, STORE_KEYS } from '../store.js';
import { stockChain } from '../data/option-chain.js';
import { universe } from '../data/universe.js';
import { selectStrike } from '../services/strike.service.js';
import { latestTrendPlans, type TrendDayPlan } from '../engine/momentum.engine.js';
import type {
  ConvictionSummary, MomentumConfig, MomentumRow, SignalPlan, StrikeChoice,
} from '../types.js';
// Delivery and markup come from the platform-level alerts module at `src/alerts/`. They used to
// live inside the pullback scanner, which is why this note exists at all: when that scanner was
// removed they moved out, because a channel is delivery and not strategy code.
import { HTML, istClock, MARKDOWN, type Markup } from '../../alerts/markup.js';
import { discordConfigured, sendDiscord } from '../../alerts/discord.js';
import { sendTelegram, telegramConfigured } from '../../alerts/telegram.js';

/**
 * How fresh a confirmation has to be to be worth announcing.
 *
 * Ten minutes. Long enough to survive a slow tick, a restart or a scan that overran; short enough
 * that "just confirmed" is a true statement. Anything older is a fact about the board, which is
 * what the board is for.
 */
const MAX_CONFIRM_AGE_MS = 10 * 60_000;

/** Chains fetched per tick to price a contract for rows the shortlist missed. */
const MAX_CHAIN_FETCHES = 6;

/** Telegram rejects a message over 4096 characters, and a rejected batch is a silent miss. */
const MAX_MESSAGE_CHARS = 3600;

/* ------------------------------------------------------------------------ the gate --- */

const enabled = (): boolean => (process.env.TREND_DAY_ALERTS ?? '').trim().toLowerCase() !== 'off';

/**
 * The conviction floor, at confirmation.
 *
 * 65 by default. On the 2026-08-12 board that takes seventeen confirmations down to about seven —
 * the ones with genuine one-sidedness behind them — and drops the likes of a 47 that reached
 * `Confirmed` early and has been decaying inside the fade hysteresis ever since.
 */
const minConviction = (): number => {
  const raw = Number(process.env.TREND_DAY_ALERT_MIN_CONVICTION);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 65;
};

/* ----------------------------------------------------------------------- the state --- */

interface AlertState {
  day: string;
  /** `SYMBOL|1` / `SYMBOL|-1` for everything already announced today. */
  announced: string[];
}

const EMPTY: AlertState = { day: '', announced: [] };

const key = (symbol: string, dir: 1 | -1): string => `${symbol}|${dir}`;

/**
 * Today's record. A stored record from a previous day is discarded rather than migrated — the
 * whole point of it is "already announced TODAY", and yesterday's list would silence this morning.
 */
async function load(day: string): Promise<AlertState> {
  const saved = await store.read<AlertState>(STORE_KEYS.trendAlerts);
  return saved && saved.day === day ? { day, announced: saved.announced ?? [] } : { ...EMPTY, day };
}

/* ------------------------------------------------------------------- the selection --- */

export interface TrendDayAlert {
  symbol: string;
  direction: 1 | -1;
  price: number;
  changePct: number;
  conviction: ConvictionSummary;
  plan: SignalPlan | null;
  strike: StrikeChoice | null;
  /**
   * The "am I chasing" pair, both already on the row.
   *
   * `minutesSinceExtreme` is the direct answer: a stock that made a new low ninety seconds ago is
   * still extending, and buying it at the confirmation price is buying the spike. `atrUsed` is how
   * much of the day's expected range is already spent, which is the same question at day scale.
   *
   * The exact ATR-off-the-extreme figure the trend re-entry gate uses is computed inside
   * `signal.service.ts` and not carried on the row; plumbing it through the public row type to
   * decorate a message would be a wider change than the line is worth.
   */
  minutesSinceExtreme: number | null;
  atrUsed: number | null;
  lotSize: number | null;
}

/**
 * Which rows have just confirmed and clear the floor — pure, so the whole selection is testable
 * without a clock, a chain or a disk.
 */
export function newlyConfirmed(
  rows: MomentumRow[],
  announced: Set<string>,
  nowMs: number,
  floor: number,
): MomentumRow[] {
  return rows.filter((r) => {
    const c = r.conviction;
    if (!c || c.phase !== 'Confirmed' || c.confirmedAt === null) return false;
    if (c.direction !== 'Bullish' && c.direction !== 'Bearish') return false;
    // Freshness first — it is the test that makes this an event rather than a state, and the one
    // that stops a restart from announcing a whole afternoon at once.
    if (nowMs - c.confirmedAt > MAX_CONFIRM_AGE_MS) return false;
    if (c.score < floor) return false;
    return !announced.has(key(r.symbol, c.direction === 'Bullish' ? 1 : -1));
  });
}

/* -------------------------------------------------------------------- the contract --- */

/**
 * Price a contract for a row the enrichment shortlist did not reach.
 *
 * The shortlist is ranked by provisional score and entry quality, and a stock that has quietly
 * walked one direction since 09:30 is by construction not near the top of either — which is the
 * same blind spot the conviction layer itself was written to fix. Most confirmations therefore
 * arrive with no chain, and a trend-day alert with no contract is exactly the alert that was
 * asked not to be built.
 *
 * Bounded and fire-and-forget: at most `MAX_CHAIN_FETCHES` a tick, and a failure leaves the
 * contract null and the message still goes with the stock plan on it.
 */
async function priceContracts(alerts: TrendDayAlert[], cfg: MomentumConfig, nowMs: number): Promise<void> {
  const needing = alerts.filter((a) => !a.strike && a.plan).slice(0, MAX_CHAIN_FETCHES);
  if (!needing.length) return;

  // The chain is addressed by the underlying's instrument key, which the row does not carry. The
  // universe is memoised for the day, so this resolves without an upstream request — and it is
  // also where the lot size comes from, since NSE lists the same lot for that underlying's
  // options as for its future.
  const uni = await universe(nowMs);

  await Promise.all(
    needing.map(async (a) => {
      try {
        const member = uni.bySymbol.get(a.symbol);
        if (!member) return;
        a.lotSize ??= member.future?.lotSize ?? null;
        const chain = await stockChain(a.symbol, member.equityKey, nowMs);
        a.strike = selectStrike({
          chain,
          direction: a.direction,
          spot: a.price,
          targetPrice: a.plan!.target,
          lotSize: a.lotSize,
          // The same band `buildSignal` uses for a trend re-entry. A confirmed trend day is a
          // 30–90 minute hold, not a scalp, so the payoff ranking on its own would walk out to
          // the cheapest strike and buy something that stops tracking the stock the plan is on.
          preferDelta: { min: cfg.signal.trend.strike.minDelta, max: cfg.signal.trend.strike.maxDelta },
          maxThetaPctPerHour: cfg.signal.trend.strike.maxThetaPctPerHour,
          config: cfg,
        });
      } catch {
        // Left null. The alert is worth sending without a contract; it is not worth failing over.
      }
    }),
  );
}

/* ---------------------------------------------------------------------- the message --- */

/** Rupee totals, rounded — at a lot's scale a rupee is noise. */
const inr = (v: number): string => `₹${Math.round(v).toLocaleString('en-IN')}`;

/**
 * A share price, to the paise.
 *
 * Rounded, ₹1432.50 renders as ₹1,433 — a price the reader then cannot match against the entry on
 * the line below it, which is the sort of small discrepancy that makes someone re-check every other
 * number in the message.
 */
const px = (v: number): string => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A signed percentage with a real minus sign, so it matches the stop and target lines. */
const pct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;

const arrow = (d: 1 | -1): string => (d === 1 ? '🟢' : '🔴');
const word = (d: 1 | -1): string => (d === 1 ? 'BULLISH' : 'BEARISH');

/** One stock's block. */
function block(a: TrendDayAlert, m: Markup): string[] {
  const c = a.conviction;
  const out: string[] = [
    `${arrow(a.direction)} ${m.bold(m.escape(a.symbol))}  ${px(a.price)}  ${pct(a.changePct)}`,
  ];

  // The shape behind the verdict. Without it "conviction 73" is a number the reader has to trust;
  // with it, they can disagree — which is the whole reason the conviction layer reports its
  // sub-reads rather than just its score.
  const shape = [
    `conviction ${m.bold(c.score.toFixed(0))}`,
    c.vwapAdherence !== null ? `${(c.vwapAdherence * 100).toFixed(0)}% ${a.direction === 1 ? 'above' : 'below'} VWAP` : null,
    c.vwapCrossings !== null ? `${c.vwapCrossings} crossing${c.vwapCrossings === 1 ? '' : 's'}` : null,
    c.deepestPullbackAtr !== null ? `deepest dip ${c.deepestPullbackAtr.toFixed(2)} ATR` : null,
    c.heldMin !== null ? `held ${c.heldMin.toFixed(0)}m` : null,
  ].filter(Boolean).join(' · ');
  out.push(`    ${shape}`);

  if (a.plan) {
    const p = a.plan;
    out.push(
      `    Entry ${m.bold(p.entry.toFixed(2))} · Stop ${m.bold(p.stop.toFixed(2))} (${pct(-p.stopPct)})` +
      ` · Target ${m.bold(p.target.toFixed(2))} (${pct(p.targetPct)})` +
      (p.rewardRisk !== null ? ` · ${m.bold(`${p.rewardRisk.toFixed(2)}R`)}` : ''),
    );
  } else {
    // NAMED, NOT GUESSED AT. `buildPlan` declines for two reasons and they want opposite responses,
    // so the line says which:
    //
    //   no ATR      the daily baseline never covered this symbol — a build that ran out of request
    //               budget leaves exactly this hole, and it persists for the whole session.
    //               Fixable: POST /momentum/baseline/rebuild.
    //   no room     the day is `stale` in `trendContext`'s sense — still one-sided, but it stopped
    //               making new extremes, so the retired range ceilings come back and there is no
    //               budget left to size a target against. Not a fault; it is the model declining
    //               to hand a 2R target to something that has gone nowhere for hours.
    //
    // An earlier version blamed the baseline for both, which sent a reader to check a build that
    // was fine.
    out.push(
      a.atrUsed === null
        ? `    ${m.italic('No levels — this stock has no ATR in today\'s baseline, so no stop or target can be sized.')}`
        : `    ${m.italic('No levels — the day has stopped making new extremes, so the model will not size a target on it.')}`,
    );
  }

  if (a.strike) {
    const s = a.strike;
    out.push(
      `    🎟 ${m.bold(`BUY ${m.escape(s.label)}`)} ${m.italic(`(${m.escape(s.expiry)}, ${s.expiryDays}d)`)}` +
      ` — ${m.bold(`₹${s.entryCost.toFixed(2)}`)} × ${s.lotSize ?? '?'} = ${m.bold(s.costPerLot === null ? '—' : inr(s.costPerLot))} per lot`,
    );
    const legs = [
      s.profitPerLot !== null
        ? `🎯 Target → ${m.bold(`+${inr(s.profitPerLot)}`)}${s.gainPctAtTarget === null ? '' : ` (+${s.gainPctAtTarget.toFixed(0)}%)`}`
        : null,
      // The downside in rupees, first-order in delta. Labelled an estimate because it is one —
      // the chain prices the upside properly and has no equivalent for the stop.
      riskPerLot(a) !== null ? `🛑 Stop → ${m.bold(`−${inr(riskPerLot(a) as number)}`)} ${m.italic('(est.)')}` : null,
    ].filter(Boolean).join(' · ');
    if (legs) out.push(`       ${legs}`);
    out.push(
      `       Delta ${Math.abs(s.delta).toFixed(2)}` +
      (s.iv === null ? '' : ` · IV ${s.iv.toFixed(0)}`) +
      (s.spreadPct === null ? '' : ` · spread ${s.spreadPct.toFixed(1)}%`) +
      (s.breakEven === null ? '' : ` · B/E ${s.breakEven.toFixed(2)}`),
    );
    for (const w of s.warnings.slice(0, 2)) out.push(`       ⚠️ ${m.escape(w)}`);
  } else {
    out.push(`    ${m.italic('No option chain for this stock this cycle — pick the contract yourself.')}`);
  }

  // The honesty line. Confirmation is a claim about the DAY; it is not a claim that this second is
  // the entry, and by 10:30 the move is already 75 minutes old. This module's own view is that the
  // trend-day entry worth taking is a retracement into the trend, so a row still printing new
  // extremes is flagged as the chase it is rather than dressed up as a fresh signal.
  const context = [
    a.minutesSinceExtreme !== null
      ? a.minutesSinceExtreme < 3
        ? `still making new ${a.direction === 1 ? 'highs' : 'lows'}`
        : `${a.minutesSinceExtreme.toFixed(0)}m since the last extreme`
      : null,
    a.atrUsed !== null ? `${a.atrUsed.toFixed(2)} ATR of range used` : null,
  ].filter(Boolean).join(' · ');
  if (context)
    out.push(
      a.minutesSinceExtreme !== null && a.minutesSinceExtreme < 3
        ? `    ⚠️ ${m.italic(`${context} — this is the chase. The entry is the dip into it.`)}`
        : `    ${m.italic(context)}`,
    );

  if (a.conviction.partial)
    out.push(`    ⚠️ ${m.italic('Partial session record — this process did not watch the whole day.')}`);

  return out;
}

/** What one lot loses if the stop is reached, first-order in delta. */
function riskPerLot(a: TrendDayAlert): number | null {
  const s = a.strike;
  if (!s || !a.plan || s.lotSize === null) return null;
  const move = Math.abs(a.plan.entry - a.plan.stop);
  const premiumAtStop = Math.max(0, s.entryCost - Math.abs(s.delta) * move);
  return Math.round((s.entryCost - premiumAtStop) * s.lotSize);
}

/** The whole batch, in one channel's markup. */
export function buildMessage(alerts: TrendDayAlert[], m: Markup, nowMs: number): string {
  const one = alerts.length === 1;
  const head = one
    ? `${arrow(alerts[0].direction)} ${m.bold(`${m.escape(alerts[0].symbol)} — ${word(alerts[0].direction)} TREND DAY CONFIRMED`)}`
    : `🔔 ${m.bold(`${alerts.length} TREND DAYS CONFIRMED`)}`;

  const lines = [head, m.italic(`${istClock(nowMs)} IST · conviction is confirmed, held and one-sided`), ''];

  for (const a of alerts) {
    // Single-stock messages have already named the symbol and direction in the heading.
    lines.push(...(one ? block(a, m).slice(1) : block(a, m)), '');
  }

  lines.push(m.italic('Stops and targets are on the underlying. Nothing here is advice.'));

  const text = lines.join('\n');
  if (text.length <= MAX_MESSAGE_CHARS) return text;

  // Over the wire limit. Trimmed from the END so the strongest confirmations — the batch is
  // sorted by conviction — keep their full plan, rather than losing the whole message.
  const kept: TrendDayAlert[] = [];
  let size = head.length + 120;
  for (const a of alerts) {
    const chunk = block(a, m).join('\n').length + 1;
    if (size + chunk > MAX_MESSAGE_CHARS) break;
    kept.push(a);
    size += chunk;
  }
  const dropped = alerts.slice(kept.length);
  const tail = dropped.length
    ? [m.italic(`+ ${dropped.length} more: ${dropped.map((d) => m.escape(d.symbol)).join(', ')} — on the Trend Day board.`)]
    : [];
  return [
    head,
    m.italic(`${istClock(nowMs)} IST · conviction is confirmed, held and one-sided`),
    '',
    ...kept.flatMap((a) => [...block(a, m), '']),
    ...tail,
  ].join('\n');
}

/* ---------------------------------------------------------------------- the preview --- */

/**
 * A sample batch, for `GET /momentum/alerts/test`.
 *
 * Built from the REAL board — the highest-conviction rows on it, whatever phase they are in — so
 * the test proves the whole path rather than a hard-coded string: the channel, the markup, the
 * chain fetch and the strike selection all run exactly as they will at 10:30.
 *
 * The one thing it cannot reproduce out of hours is the plan. Entry, stop and target come off the
 * pulse's ATR, and the pulse is dark until the quote ring refills after the open — so an evening
 * preview shows real stocks with real conviction and no levels, and says so rather than inventing
 * them. If nothing on the board carries a conviction reading at all, the fallback below is used
 * instead, and it is deliberately named `SAMPLE`: a fabricated stop against a REAL symbol is a
 * number somebody could act on, and that is the one thing a preview must never produce.
 */
export async function previewAlerts(
  rows: MomentumRow[],
  cfg: MomentumConfig,
  nowMs: number,
  count = 1,
  /**
   * Skip the board and send the illustrative layout instead.
   *
   * Exists because the live preview is honestly incomplete out of hours — entry, stop and target
   * come off the pulse's ATR, which is dark until the quote ring refills after the open, so an
   * evening test shows real stocks with no levels and no contract. That proves the channel but not
   * the format, and the format is the half most worth checking before 10:30 arrives.
   */
  demo = false,
): Promise<{ alerts: TrendDayAlert[]; basis: string }> {
  if (demo) {
    const n = Math.max(1, Math.min(count, 8));
    return {
      // Varied per entry rather than the same block repeated. Three identical SAMPLEs prove the
      // heading and the stacking and nothing about how a batch READS — which is the whole reason
      // to preview a batch: whether eight of these are scannable or a wall.
      alerts: Array.from({ length: n }, (_, i) => illustrative(nowMs, i)),
      basis: `the illustrative layout, ${n} row${n === 1 ? '' : 's'} — invented numbers on symbols named SAMPLE, so nothing here is tradable`,
    };
  }

  const candidates = rows
    .filter((r) => r.conviction?.ready && r.conviction.direction !== 'Neutral')
    .sort((a, b) => (b.conviction?.score ?? 0) - (a.conviction?.score ?? 0))
    .slice(0, Math.max(1, Math.min(count, 8)));

  if (!candidates.length) return { alerts: [illustrative(nowMs)], basis: 'an illustrative example — the board carried no conviction reading' };

  // The SAME plans the live alert would use — see `latestTrendPlans`. Reading `row.signal.plan`
  // instead is what made the first version of this preview claim "no price plan" for stocks the
  // live path prices without trouble: `buildSignal` bails early with a null plan whenever the pulse
  // ring is not ready, and `buildTrendDayPlan` deliberately does not go through that gate.
  const plans = latestTrendPlans();

  const alerts: TrendDayAlert[] = candidates.map((r) => {
    const built = plans.get(r.symbol);
    return {
      symbol: r.symbol,
      direction: r.conviction!.direction === 'Bullish' ? 1 : -1,
      price: r.price,
      changePct: r.changePct,
      conviction: r.conviction as ConvictionSummary,
      plan: built?.plan ?? r.signal?.plan ?? null,
      strike: built?.strike ?? r.signal?.strike ?? null,
      minutesSinceExtreme: r.signal?.pulse?.minutesSinceExtreme ?? null,
      atrUsed: r.signal?.extension?.atrUsed ?? null,
      lotSize: built?.strike?.lotSize ?? r.signal?.strike?.lotSize ?? null,
    };
  });

  await priceContracts(alerts, cfg, nowMs);

  const withPlan = alerts.filter((a) => a.plan).length;
  const withStrike = alerts.filter((a) => a.strike).length;
  return {
    alerts,
    basis:
      `${alerts.length} live row${alerts.length === 1 ? '' : 's'} from the board ` +
      `(${candidates.map((r) => `${r.symbol} ${r.conviction!.phase.toLowerCase()} ${r.conviction!.score.toFixed(0)}`).join(', ')}) — ` +
      `${withPlan} with a price plan, ${withStrike} with a contract, ` +
      // The count is the diagnostic that separates "this stock cannot be priced" from "the scan
      // that filled this map never ran". Zero here with confirmed rows on the board means the
      // latter, and the two look identical on the phone.
      `${plans.size} trend plan${plans.size === 1 ? '' : 's'} held from the last scan`,
  };
}

/**
 * The variations a demo batch cycles through.
 *
 * Deliberately not eight clones. What a batch preview is FOR is judging whether a stampede of
 * confirmations is scannable on a phone, and that depends on the rows differing: two directions
 * mixed together, a four-digit price beside a three-digit one, a row with no contract, a row
 * carrying a liquidity warning, a row still making new extremes. Each of those renders a different
 * branch of `block()`, so a demo of eight exercises nearly the whole message.
 *
 * Every symbol is a `SAMPLE`, and that is not cosmetic: a fabricated stop against a REAL ticker is
 * a number somebody could act on, which is the one thing a preview must never produce.
 */
const DEMO_ROWS: ReadonlyArray<{
  suffix: string; dir: 1 | -1; price: number; chg: number; conv: number; held: number;
  adherence: number; crossings: number; dip: number; stopPct: number; targetPct: number;
  premium: number; lot: number; delta: number; iv: number; gain: number;
  mse: number; used: number; noChain?: boolean; warn?: string;
}> = [
  { suffix: '', dir: -1, price: 1432.5, chg: -2.84, conv: 73, held: 22, adherence: 0.96, crossings: 2, dip: 0.31, stopPct: 1.31, targetPct: 2.62, premium: 28.4, lot: 750, delta: -0.42, iv: 31, gain: 46, mse: 8, used: 1.42 },
  { suffix: '-B', dir: 1, price: 2412, chg: 1.82, conv: 71, held: 19, adherence: 0.91, crossings: 4, dip: 0.44, stopPct: 1.22, targetPct: 2.45, premium: 41.9, lot: 250, delta: 0.46, iv: 27, gain: 39, mse: 22, used: 0.98 },
  { suffix: '-C', dir: -1, price: 1084.2, chg: -3.34, conv: 69, held: 31, adherence: 0.94, crossings: 3, dip: 0.28, stopPct: 1.33, targetPct: 2.69, premium: 19.6, lot: 550, delta: -0.48, iv: 34, gain: 57, mse: 1, used: 1.61, warn: 'open interest is thin at this strike' },
  { suffix: '-D', dir: 1, price: 316.75, chg: 2.41, conv: 68, held: 26, adherence: 0.89, crossings: 5, dip: 0.39, stopPct: 1.44, targetPct: 2.88, premium: 6.85, lot: 3000, delta: 0.44, iv: 38, gain: 52, mse: 11, used: 1.15 },
  { suffix: '-E', dir: -1, price: 5010, chg: -1.96, conv: 67, held: 44, adherence: 0.93, crossings: 1, dip: 0.22, stopPct: 1.18, targetPct: 2.36, premium: 0, lot: 0, delta: 0, iv: 0, gain: 0, mse: 35, used: 1.28, noChain: true },
  { suffix: '-F', dir: 1, price: 9289, chg: 1.34, conv: 66, held: 17, adherence: 0.87, crossings: 6, dip: 0.47, stopPct: 1.09, targetPct: 2.18, premium: 118.5, lot: 75, delta: 0.41, iv: 24, gain: 33, mse: 2, used: 1.71 },
  { suffix: '-G', dir: -1, price: 275.8, chg: -2.18, conv: 66, held: 38, adherence: 0.92, crossings: 2, dip: 0.34, stopPct: 1.51, targetPct: 3.02, premium: 5.4, lot: 4000, delta: -0.45, iv: 41, gain: 61, mse: 16, used: 1.06 },
  { suffix: '-H', dir: 1, price: 2668, chg: 1.07, conv: 65, held: 21, adherence: 0.88, crossings: 4, dip: 0.42, stopPct: 1.27, targetPct: 2.54, premium: 52.3, lot: 200, delta: 0.43, iv: 29, gain: 41, mse: 27, used: 0.91 },
];

/** One illustrative row. `i` selects a variation so a batch does not repeat itself. */
function illustrative(nowMs: number, i = 0): TrendDayAlert {
  const d = DEMO_ROWS[i % DEMO_ROWS.length];
  const dirWord = d.dir === 1 ? 'Bullish' : 'Bearish';
  const stop = +(d.price * (1 - (d.dir * d.stopPct) / 100)).toFixed(2);
  const target = +(d.price * (1 + (d.dir * d.targetPct) / 100)).toFixed(2);
  const strikeAt = Math.round(d.price / 20) * 20;

  return {
    symbol: `SAMPLE${d.suffix}`,
    direction: d.dir,
    price: d.price,
    changePct: d.chg,
    conviction: {
      ready: true, score: d.conv, phase: 'Confirmed', direction: dirWord, heldMin: d.held,
      confirmedAt: nowMs, peak: d.conv + 2, vwapAdherence: d.adherence, vwapCrossings: d.crossings,
      sessionEfficiency: 0.51, rangePosition: 0.92, deepestPullbackAtr: d.dip,
      partial: false, summary: `Confirmed ${dirWord.toLowerCase()} trend day`,
    } as ConvictionSummary,
    plan: {
      entry: d.price, stop, target,
      stopPct: d.stopPct, targetPct: d.targetPct,
      rewardRisk: +(d.targetPct / d.stopPct).toFixed(2),
      optionMovePctAtTarget: d.gain, underlyingMovePctForTargetOption: d.targetPct,
      meetsOptionTarget: true, basis: d.noChain ? 'atr-only' : 'strike',
    } as SignalPlan,
    strike: d.noChain
      ? null
      : ({
          strike: strikeAt, type: d.dir === 1 ? 'CE' : 'PE',
          label: `${strikeAt} ${d.dir === 1 ? 'CE' : 'PE'}`, instrumentKey: 'SAMPLE',
          expiry: '2026-08-27', expiryDays: 15, stepsFromAtm: 0, moneyness: 'ATM',
          premium: d.premium, entryCost: d.premium, bid: +(d.premium * 0.99).toFixed(2),
          ask: d.premium, spreadPct: 1.1, delta: d.delta, gamma: 0.004, iv: d.iv,
          thetaPctPerHour: 1.2, oi: 120_000, volume: 40_000, lotSize: d.lot,
          costPerLot: Math.round(d.premium * d.lot),
          premiumAtTarget: +(d.premium * (1 + d.gain / 100)).toFixed(2),
          gainPctAtTarget: d.gain,
          profitPerLot: Math.round(d.premium * (d.gain / 100) * d.lot),
          breakEven: +(strikeAt + d.dir * d.premium).toFixed(2),
          reason: 'illustrative', warnings: d.warn ? [d.warn] : [],
        } as StrikeChoice),
    minutesSinceExtreme: d.mse,
    atrUsed: d.used,
    lotSize: d.noChain ? null : d.lot,
  };
}

/* ------------------------------------------------------------------------ the drive --- */

let lastSentAt: number | null = null;
let lastCount = 0;
let lastError: string | null = null;
let announcedToday = 0;

/**
 * Called once per scan with the finished board. Never throws — an alert channel must not be able
 * to fail the scan that produced it.
 *
 * Returns what was announced, for the tests and the tools.
 */
export async function onScan(
  rows: MomentumRow[],
  /**
   * The trend-mode plan per symbol, built by the engine from the same inputs the row's own signal
   * came from. See the note at its call site: the row's `signal.plan` is only in trend mode when
   * the state machine happens to be `Trending`, and a stock is usually `Quiet` at the moment its
   * conviction is confirmed.
   */
  trendPlans: Map<string, TrendDayPlan>,
  cfg: MomentumConfig,
  nowMs: number,
): Promise<TrendDayAlert[]> {
  if (!enabled()) return [];

  try {
    const day = istDay(nowMs);
    const state = await load(day);
    const announced = new Set(state.announced);

    const fresh = newlyConfirmed(rows, announced, nowMs, minConviction());
    if (!fresh.length) return [];

    const alerts: TrendDayAlert[] = fresh
      .map((r) => {
        const dir: 1 | -1 = r.conviction!.direction === 'Bullish' ? 1 : -1;
        const built = trendPlans.get(r.symbol);
        return {
          symbol: r.symbol,
          direction: dir,
          price: r.price,
          changePct: r.changePct,
          conviction: r.conviction as ConvictionSummary,
          // Trend-mode plan first — the VWAP stop is the one this signal is actually defended at.
          // The row's own plan is the fallback for the rare case where the trend build could not
          // produce one (no ATR baseline), which is also the case where it names no contract.
          plan: built?.plan ?? r.signal?.plan ?? null,
          strike: built?.strike ?? r.signal?.strike ?? null,
          minutesSinceExtreme: r.signal?.pulse?.minutesSinceExtreme ?? null,
          atrUsed: r.signal?.extension?.atrUsed ?? null,
          // The lot comes off the futures contract and is the same for that underlying's options,
          // so it is available even when the chain is not — which is what lets a contract be
          // priced for a row the shortlist skipped.
          lotSize: built?.strike?.lotSize ?? r.signal?.strike?.lotSize ?? null,
        };
      })
      // Strongest first, so a trimmed batch keeps the ones worth reading.
      .sort((a, b) => b.conviction.score - a.conviction.score);

    // Recorded BEFORE the send, exactly as the session bells do it: a channel slower than the
    // scan interval would otherwise be handed the same batch again on the next tick, and a
    // duplicate stampede is a worse failure than one batch lost to a channel that was down.
    state.announced = [...announced, ...alerts.map((a) => key(a.symbol, a.direction))];
    await store.write(STORE_KEYS.trendAlerts, state);
    announcedToday = state.announced.length;

    await priceContracts(alerts, cfg, nowMs);
    await deliver(alerts, nowMs);
    return alerts;
  } catch (e) {
    lastError = String((e as Error).message);
    return [];
  }
}

async function deliver(alerts: TrendDayAlert[], nowMs: number): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  if (telegramConfigured()) jobs.push(sendTelegram(buildMessage(alerts, HTML, nowMs)));
  if (discordConfigured()) jobs.push(sendDiscord(buildMessage(alerts, MARKDOWN, nowMs), alerts[0].direction));
  if (!jobs.length) {
    lastError = 'no phone channel is configured';
    return;
  }
  const results = await Promise.all(jobs);
  lastError = results.every(Boolean) ? null : 'a configured channel refused the message';
  lastSentAt = nowMs;
  lastCount = alerts.length;
}

/** Reported on `/momentum/status`. */
export const trendAlertStatus = () => ({
  enabled: enabled(),
  minConviction: minConviction(),
  maxConfirmAgeMin: MAX_CONFIRM_AGE_MS / 60_000,
  announcedToday,
  lastSentAt,
  lastCount,
  lastError,
});

/** Test seam. */
export const resetTrendAlerts = async (): Promise<void> => {
  lastSentAt = null;
  lastCount = 0;
  lastError = null;
  announcedToday = 0;
  await store.write(STORE_KEYS.trendAlerts, { ...EMPTY });
};
