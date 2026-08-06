// Stops and targets — the arithmetic that decides whether the setup is worth taking at all.
//
// THREE STOPS, AND THEY ARE NOT ALTERNATIVES. Each answers a different question and each is
// wrong on its own:
//
//   SWING  under the low the pullback actually made. The only stop that is invalidated by the
//          MARKET rather than by a formula: if price takes it out, the higher-low structure the
//          entire trade was built on is gone. Its weakness is that it can be absurdly far away
//          when the pullback was deep.
//   ATR    a fixed multiple of the bar's typical range. Always affordable, always the same
//          size, and completely indifferent to whether the level it lands on means anything —
//          it will happily sit in the middle of the pullback's own range.
//   EMA    beyond the 20 EMA, which is the level the trade thesis says price should hold. Sits
//          between the other two in both width and meaningfulness.
//
// The RECOMMENDED stop is the widest of the structural pair — swing and EMA — because a stop
// inside either of them will be taken out by a move that does not disprove the trade, and a
// stop that is taken out without disproving the trade is the most expensive kind there is. It
// then has to survive an affordability test: past `maxStopAtr` the trade being described is no
// longer the trade being signalled, and the ATR stop is substituted WITH THE SUBSTITUTION
// STATED. Silently narrowing the stop is what turns a 2R plan into a coin flip.
//
// FIVE TARGETS FOR THE SAME REASON, and the honest thing about targets is that only two of them
// are measurements. 1R and 2R are arithmetic on the stop. The prior swing high is a real level
// where real sellers are. The measured move projects the impulse from the pullback low, which
// is a convention rather than a law. The ATR target is a statement about the day's typical
// range. All five are reported, one is primary, and the reward:risk is quoted against the
// primary only — because a plan with five targets has no target.

import { clamp } from '../indicators/series.js';
import type { Bar } from '../indicators/series.js';
import { runningExtreme } from '../indicators/structure.js';
import type {
  PullbackConfig, PullbackRead, StopCandidate, StopPlan, TargetCandidate, TargetPlan,
  TimeframeRead,
} from '../types.js';

export interface RiskInput {
  bars: Bar[];
  read: TimeframeRead;
  pullback: PullbackRead;
  direction: 1 | -1;
  /** The confirmation bar's close. Every level is measured from here, not from the live price. */
  entry: number;
  cfg: PullbackConfig;
}

const pct = (from: number, to: number): number => (from > 0 ? +(((to - from) / from) * 100).toFixed(3) : 0);

/**
 * Build the three stops and pick one.
 *
 * `atr` is the timeframe's own ATR, which is the whole reason this is not a percentage model: a
 * stop 1.2 ATR below entry is the same statement about MARUTI and about NHPC, and 0.6% below
 * entry is two entirely different trades.
 */
export function buildStops(i: RiskInput): StopPlan | null {
  const { read, cfg, direction: dir, entry } = i;
  const atr = read.atr;
  if (!atr || !(atr > 0) || !(entry > 0)) return null;

  const r = cfg.risk;
  const buffer = r.stopBufferAtr * atr;
  const candidates: StopCandidate[] = [];

  const describe = (kind: StopCandidate['kind'], price: number, reason: string): StopCandidate | null => {
    // A "stop" on the wrong side of entry is not a stop. It happens when the pullback low sits
    // above the entry — a gap-up confirmation bar — and publishing it would invert the R
    // arithmetic and report a negative risk as a very good reward:risk.
    const distance = dir === 1 ? entry - price : price - entry;
    if (!(distance > 0)) return null;
    return {
      kind,
      price: +price.toFixed(2),
      distance: +distance.toFixed(2),
      distanceAtr: +(distance / atr).toFixed(3),
      distancePct: Math.abs(pct(entry, price)),
      reason,
    };
  };

  // The pullback's own extreme, or the running extreme of the last few bars when the pullback
  // detector had none. `structure.ts` explains why this is not a confirmed swing pivot: at the
  // moment a pullback confirms, its low is by construction two bars from being confirmable, and
  // the last CONFIRMED swing is a whole leg away.
  const lookback = Math.max(3, cfg.pullback.maxBarsInZone);
  const swingPrice = i.pullback.extreme
    ?? runningExtreme(i.bars, lookback, dir === 1 ? 'low' : 'high')?.price
    ?? null;
  if (swingPrice !== null) {
    const s = describe('swing', dir === 1 ? swingPrice - buffer : swingPrice + buffer,
      `${cfg.risk.stopBufferAtr} ATR beyond the pullback ${dir === 1 ? 'low' : 'high'} of ${swingPrice.toFixed(2)} — below this the higher-${dir === 1 ? 'low' : 'high'} structure is gone`);
    if (s) candidates.push(s);
  }

  const atrStop = describe('atr', dir === 1 ? entry - r.atrStopMultiple * atr : entry + r.atrStopMultiple * atr,
    `${r.atrStopMultiple} ATR from entry — affordable by construction, and indifferent to structure`);
  if (atrStop) candidates.push(atrStop);

  if (read.ema.ema20 !== null) {
    const e = describe('ema', dir === 1 ? read.ema.ema20 - buffer : read.ema.ema20 + buffer,
      `${cfg.risk.stopBufferAtr} ATR beyond the 20 EMA at ${read.ema.ema20.toFixed(2)} — the level the thesis says holds`);
    if (e) candidates.push(e);
  }

  if (!candidates.length) return null;

  /**
   * The order of preference, and it is NOT "the widest structural stop" — which is what this did
   * first, and it was wrong in a way that only showed up on live rows.
   *
   * The SWING stop is the thesis-invalidation level: below the pullback's low the higher-low
   * structure the entire trade rests on is gone, and there is nothing left to be right about. The
   * EMA stop is a proxy for the same idea and is sometimes much further away — on live 3-minute rows
   * it came out at 3.55 ATR where the swing sat at 3.42. Taking the wider of the two then meant the
   * EMA's distance decided affordability, tripped the ceiling, and discarded a perfectly good swing
   * stop in favour of an ATR stop sitting INSIDE the pullback's own range. That is the precise
   * failure the structural stop exists to prevent, arrived at by trying to be careful.
   *
   * So: the swing, then the EMA, then ATR — each subject to a USABLE BAND rather than only to a
   * ceiling. Both edges of that band are load-bearing and each was learnt from live rows. Too wide
   * and the trade being described is not the trade being signalled; too TIGHT and the stop sits
   * inside the noise of the bar it was drawn from — which happens whenever price is sitting exactly
   * at its retracement low, because the swing stop then degenerates to "entry minus the buffer" —
   * and it silently inflates every R on the row, because risk is the denominator.
   */
  const ordered = [
    candidates.find((c) => c.kind === 'swing'),
    candidates.find((c) => c.kind === 'ema'),
  ].filter((c): c is StopCandidate => !!c);

  const usable = ordered.find(
    (c) => c.distanceAtr >= cfg.risk.minStopAtr && c.distanceAtr <= cfg.risk.maxStopAtr,
  );
  if (usable) return { candidates, recommended: usable };

  const fallback = atrStop ?? candidates.reduce((a, b) => (b.distance < a.distance ? b : a));
  if (!ordered.length)
    return {
      candidates,
      recommended: fallback,
      warning: `no structural level is available — using the ${fallback.kind} stop, which is indifferent to structure.`,
    };

  const nearest = ordered.reduce((a, b) => (b.distance < a.distance ? b : a));
  const widest = ordered.reduce((a, b) => (b.distance > a.distance ? b : a));
  const tooTight = widest.distanceAtr < cfg.risk.minStopAtr;

  return {
    candidates,
    recommended: fallback,
    warning: tooTight
      ? `every structural stop here is closer than ${cfg.risk.minStopAtr} ATR (the widest is ` +
        `${widest.distanceAtr.toFixed(2)}) — price is sitting at its own retracement extreme, so the level is ` +
        `not yet a level. Using the ${fallback.kind} stop, which keeps the R arithmetic honest.`
      : `every structural stop here is wider than ${cfg.risk.maxStopAtr} ATR (the nearest is ` +
        `${nearest.distanceAtr.toFixed(2)}) — using the ${fallback.kind} stop instead. The structure is intact ` +
        `beyond ${widest.price.toFixed(2)}, so this stop can be taken out by a move that does not invalidate the setup.`,
  };
}

/**
 * Build the five targets and pick the primary.
 *
 * `priorHigh` is the level a real order book sits at and is the only target here that is not a
 * projection. It is also the one most often MISSING — early in a trend there is no prior swing
 * beyond the current extreme — and its absence is stated rather than substituted, so a plan
 * quoting a measured move is never mistaken for one quoting a level.
 */
export function buildTargets(i: RiskInput, stop: StopCandidate): TargetPlan | null {
  const { read, cfg, direction: dir, entry } = i;
  const atr = read.atr;
  if (!atr || !(atr > 0)) return null;

  const risk = stop.distance;
  if (!(risk > 0)) return null;

  const at = (price: number): { r: number; distancePct: number } => ({
    r: +(((dir === 1 ? price - entry : entry - price) / risk)).toFixed(2),
    distancePct: Math.abs(pct(entry, price)),
  });

  const mk = (kind: TargetCandidate['kind'], label: string, price: number, reason: string): TargetCandidate => ({
    kind, label, price: +price.toFixed(2), reason, ...at(price),
  });

  const candidates: TargetCandidate[] = [
    mk('1R', '1R', dir === 1 ? entry + risk : entry - risk, 'one multiple of the risk taken — the partial-exit level'),
    mk('2R', '2R', dir === 1 ? entry + 2 * risk : entry - 2 * risk, 'two multiples of the risk taken'),
    mk('atr', `${cfg.risk.atrTargetMultiple} ATR`,
      dir === 1 ? entry + cfg.risk.atrTargetMultiple * atr : entry - cfg.risk.atrTargetMultiple * atr,
      `${cfg.risk.atrTargetMultiple} ATR — what this instrument typically travels on this timeframe`),
  ];

  // The prior swing in the trend's direction, when there is one beyond the entry. A target
  // BEHIND the entry is not a target; that is the state early in a leg, and it is left out.
  const prior = dir === 1 ? i.pullback.impulse?.toPrice : i.pullback.impulse?.toPrice;
  if (prior !== undefined && (dir === 1 ? prior > entry : prior < entry))
    candidates.push(mk('priorHigh', dir === 1 ? 'Prior high' : 'Prior low', prior,
      `the ${dir === 1 ? 'high' : 'low'} of the impulse this is a pullback in — where the last sellers were`));

  // Measured move: the impulse's own size projected from the pullback's extreme. A convention,
  // and labelled as one.
  const imp = i.pullback.impulse;
  if (imp && i.pullback.extreme !== null) {
    const size = Math.abs(imp.toPrice - imp.fromPrice);
    const projected = dir === 1 ? i.pullback.extreme + size : i.pullback.extreme - size;
    if (dir === 1 ? projected > entry : projected < entry)
      candidates.push(mk('measuredMove', 'Measured move', projected,
        `the ${(size / atr).toFixed(2)} ATR impulse projected from the pullback ${dir === 1 ? 'low' : 'high'} — a convention, not a level`));
  }

  const wanted = cfg.risk.primaryTarget;
  const primary = candidates.find((c) => c.kind === wanted)
    // The configured primary may not exist on this row — there is often no prior high. Falling
    // back to 2R rather than to "whatever is nearest" keeps the reward:risk comparable across
    // the board, which is the only thing that makes the column sortable.
    ?? candidates.find((c) => c.kind === '2R')
    ?? candidates[0];

  /**
   * The room, measured against the trade's actual OBJECTIVE — the measured move, falling back to
   * the ATR target and then to the primary.
   *
   * TWO OTHER CANDIDATES WERE TRIED AND BOTH ARE WRONG, in ways worth recording because each looked
   * more principled than this one.
   *
   * The ATR TARGET — a fixed multiple of the signal timeframe's ATR — is systematically unfavourable
   * on short timeframes and generous on long ones. A 3-minute ATR is around 0.18% of price while a
   * healthy pullback is around 0.5%, so the retracement is three ATR deep by construction, and the
   * gate quietly became a filter against short timeframes rather than against poor risk/reward.
   *
   * The PRIOR HIGH — the extreme of the impulse being retraced — is a real level where real sellers
   * are, and it is still the wrong ruler, because it is an OBSTACLE and not the objective. A
   * continuation trade is a bet on a NEW extreme beyond it. When the confirmation bar closes just
   * under the old high the measure degenerates toward zero on a setup that is otherwise ideal:
   * measured on the test fixture it read 0.08R for a textbook entry.
   *
   * The measured move is the leg repeating from the pullback's own low, which is exactly the thesis
   * being taken. The question the gate then asks is the right one: the retracement created this much
   * risk, so is the leg repeating worth at least `minRewardRisk` times it?
   */
  const room =
    candidates.find((c) => c.kind === 'measuredMove')
    ?? candidates.find((c) => c.kind === 'atr')
    ?? primary;

  return {
    candidates: candidates.sort((a, b) => (dir === 1 ? a.price - b.price : b.price - a.price)),
    primary,
    rewardRisk: primary.r,
    roomR: room.r,
    trailing: trailingRule(i, atr),
  };
}

/**
 * The trailing rule, as a rule.
 *
 * A trailing stop is a FUNCTION of where price gets to, not a level, and printing today's value
 * of it as "the trailing stop" invites reading it as a resting order that will be there in
 * twenty minutes. Both halves are carried: the recipe, and what it evaluates to right now.
 *
 * The chandelier form (a multiple of ATR below the running extreme) is used when it is tighter
 * than the EMA, and the EMA when that is tighter — whichever is closer, because the point of a
 * trail is to give back as little as possible once the move has worked, and two rules that
 * disagree mean one of them is already loose.
 */
function trailingRule(i: RiskInput, atr: number): TargetPlan['trailing'] {
  const { direction: dir, cfg, bars } = i;
  const ema = cfg.risk.trailEma === 9 ? i.read.ema.ema9 : i.read.ema.ema20;
  const extreme = runningExtreme(bars, Math.max(5, cfg.pullback.maxBarsInZone * 2), dir === 1 ? 'high' : 'low');

  const chandelier = extreme
    ? dir === 1 ? extreme.price - cfg.risk.trailAtrMultiple * atr : extreme.price + cfg.risk.trailAtrMultiple * atr
    : null;

  if (chandelier !== null && ema !== null) {
    const tighter = dir === 1 ? Math.max(chandelier, ema) : Math.min(chandelier, ema);
    const kind: 'ema' | 'chandelier' = tighter === ema ? 'ema' : 'chandelier';
    return {
      kind,
      current: +tighter.toFixed(2),
      rule: kind === 'ema'
        ? `the ${cfg.risk.trailEma} EMA, which is currently the tighter of the two`
        : `${cfg.risk.trailAtrMultiple} ATR below the running ${dir === 1 ? 'high' : 'low'}, currently tighter than the ${cfg.risk.trailEma} EMA`,
    };
  }

  if (chandelier !== null)
    return {
      kind: 'chandelier',
      current: +chandelier.toFixed(2),
      rule: `${cfg.risk.trailAtrMultiple} ATR below the running ${dir === 1 ? 'high' : 'low'}`,
    };

  return {
    kind: 'ema',
    current: +(ema ?? i.entry).toFixed(2),
    rule: `the ${cfg.risk.trailEma} EMA`,
  };
}

/** The whole plan, or null when the row cannot support one. */
export function buildPlan(i: RiskInput): { stop: StopPlan; target: TargetPlan } | null {
  const stop = buildStops(i);
  if (!stop) return null;
  const target = buildTargets(i, stop.recommended);
  if (!target) return null;
  return { stop, target };
}

/** Realised R for a fill and an exit. Shared by the outcome tracker and the backtest. */
export const realisedR = (entry: number, exit: number, stop: number, direction: 1 | -1): number => {
  const risk = direction === 1 ? entry - stop : stop - entry;
  if (!(risk > 0)) return 0;
  return +(((direction === 1 ? exit - entry : entry - exit) / risk)).toFixed(3);
};

/** Clamp helper re-exported so callers have one import for the risk maths. */
export { clamp };
