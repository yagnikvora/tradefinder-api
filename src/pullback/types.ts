// EMA Pullback Scanner — the domain model.
//
// The module exists to answer ONE question, and it is not the one an EMA crossover answers:
//
//   "This stock is already in a trend. It has just pulled back into the 9/20 EMA band and
//    turned. Is that turn worth buying?"
//
// A crossover is a state change and fires once, late, at the point of maximum ambiguity — the
// two averages are by definition equal, so the thing that decides the trade is the noise on
// top of them. A pullback entry is an EVENT inside an already-established trend: the direction
// was settled hours ago, the risk is defined by the swing the pullback just made, and the
// setup repeats three or four times a session on a stock that is genuinely trending. Those are
// different trades with different statistics, and nothing in this file computes a crossover.
//
// TWO RULES RUN THROUGH EVERY TYPE HERE, both inherited from `momentum/types.ts` because they
// were learnt the same way:
//
//   1. A number this module cannot MEASURE is `null`, never 0 and never a stand-in. An EMA
//      that has not warmed up is null; a slope with too few bars is null; an ADX before its
//      Wilder seeding is null. `available: false` plus a `note` saying why is the shape that
//      carries that through the whole pipeline, because a fabricated 0.00 slope reads as
//      "flat" — which is a real and different finding.
//
//   2. Every refusal is STATED. A setup that was rejected carries the gate that rejected it in
//      `blockers`, in words. A scanner that silently shows nothing is indistinguishable from a
//      scanner that is broken, and on a quiet afternoon the two look identical for hours.

import type { Bar } from './indicators/series.js';

export type { Bar } from './indicators/series.js';

/* ---------------------------------------------------------------------- timeframes --- */

/**
 * The four intraday timeframes, in minutes.
 *
 * All four align to 09:15 IST rather than to the wall clock hour, which is what every Indian
 * charting platform does and what the 15-minute opening bar (09:15–09:30) requires. Aligning
 * to :00 instead would put the session's first 15-minute bar at 09:15–09:30 only by accident
 * and would break every other one.
 */
export type Timeframe = 1 | 3 | 5 | 15;

export const TIMEFRAMES: Timeframe[] = [1, 3, 5, 15];

/**
 * The timeframe a detail page charts when the request does not name one.
 *
 * Five minutes rather than "whichever frame the signal fired on". That rule sounds right and
 * reads badly: the same symbol opened on a different chart from one visit to the next, so there
 * was no frame a reader could build a habit on, and a 15-minute chart is the wrong first look at
 * an intraday pullback anyway. The signal's own frame is still one click away in the switcher
 * and is labelled on the signal card, and the plan overlay — entry, stop, target — is drawn on
 * whatever frame is charted, so nothing is lost by defaulting.
 */
export const DEFAULT_CHART_TIMEFRAME: Timeframe = 5;

export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  1: '1 min',
  3: '3 min',
  5: '5 min',
  15: '15 min',
};

/* -------------------------------------------------------------------- indicators --- */

/** The four EMA periods the brief specifies, plus what they are for. */
export interface EmaSet {
  /** The trigger average. Price riding it is the definition of a strong trend. */
  ema9: number | null;
  /** The value average, and the deeper half of the pullback zone. */
  ema20: number | null;
  /** The trend filter. 20 above 50 is what makes the trend "established" rather than new. */
  ema50: number | null;
  /** The regime. Multi-session on a 15-minute chart, so it warms from the daily seed. */
  ema200: number | null;
}

/**
 * How fast an average is moving, in ATR PER BAR rather than in percent.
 *
 * The unit is the whole point. "The 9 EMA is rising 0.04% a bar" means something completely
 * different on a ₹95 stock that ranges 3% a day and on BAJFINANCE — the first is drifting and
 * the second is running. Dividing by that timeframe's own ATR makes "flat" one number across
 * a 215-symbol universe, which is what the flat-EMA veto needs in order to be a single
 * configurable threshold instead of a per-symbol table nobody would maintain.
 */
export interface SlopeSet {
  ema9AtrPerBar: number | null;
  ema20AtrPerBar: number | null;
  /** VWAP's own slope, same unit. A rising VWAP is the session agreeing with the trend. */
  vwapAtrPerBar: number | null;
}

/** Wilder's directional movement system. `adx` is null until it has been seeded twice over. */
export interface AdxRead {
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  /** ADX minus its own value `n` bars ago — whether the trend is strengthening or decaying. */
  rising: boolean | null;
}

/** One confirmed swing point from the fractal scan. */
export interface Pivot {
  /** Index into the timeframe's bar array. */
  index: number;
  /** Bar open time, epoch ms. */
  at: number;
  price: number;
  kind: 'high' | 'low';
}

/**
 * The price structure, as a sequence rather than as a pair of booleans.
 *
 * "Higher high" on its own is nearly content-free — a stock one tick above yesterday's high
 * has one. What the trend filter actually needs is whether the last TWO swing highs and the
 * last two swing lows both stepped the right way, which is the smallest window in which
 * "higher high AND higher low" is a statement about structure rather than about one print.
 */
export interface StructureRead {
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  /** Consecutive same-direction swing steps. 3+ is a staircase, 1 is a coincidence. */
  steps: number;
  lastSwingHigh: Pivot | null;
  lastSwingLow: Pivot | null;
  priorSwingHigh: Pivot | null;
  priorSwingLow: Pivot | null;
  /** Why structure could not be read — usually "not enough closed bars yet". */
  note?: string;
}

/** Which candlestick the confirmation bar actually is. Ordered strongest first. */
export type CandlePattern =
  | 'bullishEngulfing' | 'bearishEngulfing'
  | 'hammer' | 'shootingStar'
  | 'piercing' | 'darkCloud'
  | 'strongBody'
  | 'insideBarBreak'
  | 'none';

export const PATTERN_LABEL: Record<CandlePattern, string> = {
  bullishEngulfing: 'Bullish engulfing',
  bearishEngulfing: 'Bearish engulfing',
  hammer: 'Hammer',
  shootingStar: 'Shooting star',
  piercing: 'Piercing line',
  darkCloud: 'Dark cloud cover',
  strongBody: 'Strong directional candle',
  insideBarBreak: 'Inside-bar break',
  none: 'No reversal candle',
};

/* -------------------------------------------------------------- the timeframe read --- */

/**
 * Everything measured on ONE timeframe for one symbol.
 *
 * Held per timeframe rather than merged because the whole module turns on the timeframes
 * DISAGREEING: a 5-minute pullback inside a 15-minute uptrend is the setup, and a 5-minute
 * pullback against a 15-minute downtrend is the trap that looks identical on a 5-minute chart.
 * Flattening these into one blended read would delete exactly the distinction being traded.
 */
export interface TimeframeRead {
  timeframe: Timeframe;
  /** Closed bars available. Below `minBars` nothing here is trusted. */
  bars: number;
  /** The last CLOSED bar. Every indicator below is computed to this bar inclusive. */
  lastClosedAt: number | null;
  /**
   * The bar still forming, from the quote poll. Carried separately and never fed to an
   * indicator: a 15-minute EMA that repainted every fifteen seconds would show a trend
   * appearing and disappearing inside one bar, which is the classic way a live scanner
   * disagrees with the chart the trader is looking at.
   */
  forming: Bar | null;

  ema: EmaSet;
  slope: SlopeSet;
  /** Session-anchored VWAP as of the last closed bar. Null before the first trade. */
  vwap: number | null;
  atr: number | null;
  adx: AdxRead;
  structure: StructureRead;

  /** Mean volume per bar over `volumeLookback` bars on THIS timeframe, ending before the last. */
  avgVolume: number | null;
  /** Last closed bar's volume ÷ `avgVolume`. What the confirmation candle is judged on. */
  volumeRatio: number | null;
  /**
   * Mean volume of the last `volumeLookback` bars ÷ the mean of the `volumeLookback` before them.
   *
   * THE TREND'S volume condition, and it is deliberately not `volumeRatio`. "Is the last bar above
   * its own trailing mean" is close to a coin flip by construction — about half of all bars are,
   * whatever the stock is doing — and worse, it is systematically FALSE during a pullback, because
   * volume drying up on the retracement is what a healthy pullback looks like. Gating the trend on
   * it would disqualify every setup at the exact moment it became a setup.
   *
   * Comparing one window against the window before it asks the question a trader means by "volume
   * above average": is this stock trading more than it was. A three-bar lull inside a
   * twenty-bar window barely moves it, and a stock nobody is trading cannot fake it.
   */
  participation: number | null;

  /** Price as of the last closed bar. The reference every distance below is measured from. */
  close: number | null;
  /** Distance from each average, in ATR, signed. Positive = price above. */
  distance: {
    ema9Atr: number | null;
    ema20Atr: number | null;
    ema50Atr: number | null;
    vwapAtr: number | null;
  };

  /** True when this timeframe has too little history to be read at all. */
  warming: boolean;
  note?: string;
}

/* ------------------------------------------------------------------------- trend --- */

export type TrendState = 'Bullish' | 'Bearish' | 'None';

/** One line of the trend checklist. `required` distinguishes a gate from a nice-to-have. */
export interface Check {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  /** The reading that decided it, formatted for display. */
  value: string;
}

/**
 * Whether this timeframe is in a trend worth pulling back INTO.
 *
 * `state` is the answer; `checks` is the whole argument, kept because the interesting case is
 * always the near miss. A stock failing on ADX 23 and passing everything else is a different
 * animal from one failing on four conditions, and a boolean cannot say which.
 */
export interface TrendRead {
  timeframe: Timeframe;
  state: TrendState;
  /** 0–100. How convincingly the checklist passed — feeds the 30-point trend component. */
  strength: number;
  checks: Check[];
  /** Failed REQUIRED checks, in words. Empty when the trend is clean. */
  failed: string[];
  /**
   * The vetoes from the brief's "do not generate signals" list that fired.
   *
   * Deliberately separate from `failed`. A missing condition means "this is not a trend";
   * a veto means "this may well be a trend and it is still not tradable" — flat averages,
   * a range-bound tape, price stuck in the no-man's-land between VWAP and the EMAs. Merging
   * the two would make a chopping stock look like a trendless one, and the difference is
   * whether waiting is worth it.
   */
  vetoes: string[];
}

/* ---------------------------------------------------------------------- pullback --- */

/**
 * Where the retracement has got to.
 *
 *   None         no impulse leg worth pulling back from.
 *   Impulse      price is extended away from the EMA band — the leg being measured.
 *   PullingBack  price is retracing toward the zone but has not reached it.
 *   AtZone       price has touched the 9 EMA / 20 EMA / VWAP band. THE WATCH STATE.
 *   Resuming     the touch happened, a confirmation candle has printed, volume expanded.
 *                This is the only state that becomes a signal.
 *   Failed       the retracement went through the zone and kept going — the trend structure
 *                broke rather than paused. Kept as a state rather than dropped to None because
 *                a failed pullback is the single most useful warning this module produces:
 *                anybody who entered on the touch is now wrong and does not know it yet.
 */
export type PullbackPhase = 'None' | 'Impulse' | 'PullingBack' | 'AtZone' | 'Resuming' | 'Failed';

/** Which average price actually came back to. Several can be true at once. */
export interface ZoneTouch {
  ema9: boolean;
  ema20: boolean;
  vwap: boolean;
  /** The nearest one, for the headline. Null when nothing was touched. */
  nearest: 'ema9' | 'ema20' | 'vwap' | null;
}

export interface PullbackRead {
  timeframe: Timeframe;
  phase: PullbackPhase;
  direction: 1 | -1 | 0;

  /**
   * The pullback zone, in price. Bounded by the outermost and innermost of
   * {9 EMA, 20 EMA, VWAP} widened by `zoneToleranceAtr`.
   *
   * Drawn on the chart as a band, because that is what it is on the chart the trade is taken
   * from — a single "the 20 EMA" line implies a precision the entry does not have.
   */
  zone: { top: number; bottom: number } | null;
  touch: ZoneTouch;
  /** Bars since price entered the zone. Null when it has not. */
  barsInZone: number | null;

  /** The leg being retraced: from the swing that started it to the extreme it reached. */
  impulse: { fromPrice: number; toPrice: number; fromAt: number; toAt: number; atr: number } | null;
  /** How much of the impulse has been given back, 0…1+. Above 1 the leg is gone. */
  retracement: number | null;
  /** The deepest point of the retracement so far, in price. */
  extreme: number | null;
  /** That depth in ATR from the impulse extreme — the ruler that survives a zigzag flip. */
  depthAtr: number | null;

  /** Set once a confirmation candle prints. Null while the pullback is still going. */
  confirmation: ConfirmationRead | null;
  note?: string;
}

/**
 * The candle and the volume that turn a touch into an entry.
 *
 * Both halves are required and they fail for different reasons. A reversal candle on no
 * volume is a pause in the selling, not a resumption of the buying; expanding volume with no
 * candle is often the pullback ACCELERATING, which is the same reading with the opposite
 * meaning. Requiring both is what separates this from an EMA-touch alert.
 */
export interface ConfirmationRead {
  pattern: CandlePattern;
  /** The bar that confirmed. */
  at: number;
  close: number;
  high: number;
  low: number;
  /** Body as a share of the bar's range, 0…1. A doji is not a confirmation. */
  bodyRatio: number;
  /** Volume ÷ average volume on this timeframe. */
  volumeRatio: number | null;
  /** Whether the bar closed back on the trend side of the 9 EMA. */
  reclaimedEma9: boolean;
  /** How many bars ago it printed. 0 is the bar that just closed. */
  barsAgo: number;
  reasons: string[];
}

/* ------------------------------------------------------------------------- score --- */

export type ConfidenceBand = 'Weak' | 'Medium' | 'Strong' | 'Excellent';

/** One weighted component of the 100-point confidence score. */
export interface ScoreComponent {
  key: 'trend' | 'volume' | 'vwap' | 'ema' | 'structure' | 'adx';
  label: string;
  /** Points awarded. */
  points: number;
  /** Points available — the brief's 30/20/15/15/10/10, configurable. */
  max: number;
  /** Null when the component could not be measured; it then contributes nothing to either. */
  available: boolean;
  reasons: string[];
}

export interface ScoreBreakdown {
  /** 0–100, but only over the AVAILABLE maximum — see `coverage`. */
  total: number;
  band: ConfidenceBand;
  components: ScoreComponent[];
  /** Fraction of the 100 points that was measurable. A 78 at 70% coverage is not a 78. */
  coverage: number;
}

/* -------------------------------------------------------------------------- risk --- */

/** One candidate stop, with the reasoning that produced it. */
export interface StopCandidate {
  kind: 'swing' | 'atr' | 'ema';
  price: number;
  /** Distance from entry, in rupees and as a share of one ATR. */
  distance: number;
  distanceAtr: number;
  distancePct: number;
  reason: string;
}

export interface StopPlan {
  candidates: StopCandidate[];
  /** The one to use, and why this one. */
  recommended: StopCandidate;
  /** Stated when the structural stop had to be abandoned for being unaffordably wide. */
  warning?: string;
}

/** One candidate target. `r` is how many multiples of the recommended risk it sits at. */
export interface TargetCandidate {
  kind: '1R' | '2R' | 'priorHigh' | 'measuredMove' | 'atr';
  label: string;
  price: number;
  r: number;
  distancePct: number;
  reason: string;
}

export interface TargetPlan {
  candidates: TargetCandidate[];
  /** The primary target the reward:risk ratio is quoted against. */
  primary: TargetCandidate;
  rewardRisk: number;
  /**
   * How many multiples of the risk this instrument typically TRAVELS from here — the ATR target's
   * R, or the primary's when there is no ATR target.
   *
   * THE NUMBER THE REWARD:RISK GATE ACTUALLY READS, and it exists because `rewardRisk` cannot do
   * that job. With a `2R` primary target the reward:risk is 2.00 by construction on every row ever
   * produced, so a `minRewardRisk` of 1.5 compared against it is a gate that can never fire — it
   * looked like a risk control and was arithmetic restating itself. Measured on live rows before
   * this existed: 209 of 209 scanned symbols reported exactly 2.00.
   *
   * `roomR` asks the question the gate was meant to ask: the stop is this far away, so is a move of
   * the size this instrument normally makes worth at least `minRewardRisk` times it? On a deep
   * retracement the answer is no however good the trend looks, because the risk the structure
   * demands has grown faster than the reward the timeframe can pay.
   */
  roomR: number;
  /**
   * The trailing rule, expressed as a rule rather than as a price.
   *
   * A trailing stop is not a level, it is a function of where price gets to, and printing
   * today's value of it as "the trailing stop" invites reading it as a resting order. What is
   * carried is the recipe plus its value RIGHT NOW.
   */
  trailing: { rule: string; current: number; kind: 'ema' | 'chandelier' };
}

/* ---------------------------------------------------------------------- options --- */

export type OptionSide = 'CE' | 'PE';

/**
 * How tradable a contract actually is, 0–100.
 *
 * Separate from the choice itself because it is the number that vetoes. The brief's "very low
 * option liquidity" veto is this score under a floor, and it has to be a score rather than a
 * single reading: a strike can have enormous open interest and a book two rupees wide, or a
 * tight book with nothing behind it, and either one makes the option a worse instrument than
 * the stock for expressing the same view.
 */
export interface LiquidityScore {
  score: number;
  grade: 'Excellent' | 'Good' | 'Average' | 'Poor';
  components: { spread: number | null; openInterest: number | null; volume: number | null; depth: number | null };
  reasons: string[];
}

export interface OptionPick {
  symbol: string;
  side: OptionSide;
  strike: number;
  /** "2450 CE" — what gets typed into a terminal. */
  label: string;
  instrumentKey: string;
  expiry: string;
  expiryDays: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  stepsFromAtm: number;

  premium: number;
  /** The ask. What getting in costs, not the mid. */
  entryCost: number;
  bid: number;
  ask: number;
  spreadPct: number | null;

  delta: number;
  gamma: number | null;
  theta: number | null;
  /** Decay as a share of the premium per hour — the number that matters over a 30–90m hold. */
  thetaPctPerHour: number | null;
  vega: number | null;
  iv: number | null;
  oi: number;
  oiChange: number | null;
  volume: number;

  lotSize: number | null;
  costPerLot: number | null;
  /** Premium if the underlying reaches the primary target, second-order in gamma. */
  premiumAtTarget: number | null;
  /** That gain NET of paying the ask and selling the bid. */
  gainPctAtTarget: number | null;
  profitPerLot: number | null;
  breakEven: number | null;

  liquidity: LiquidityScore;
  /** Which delta band this was picked in, and why that band. */
  band: { min: number; max: number; reason: string };
  reason: string;
  warnings: string[];
}

/* ------------------------------------------------------------------------ signal --- */

/**
 * Which kind of entry this is, because it changes the option that should be bought.
 *
 *   pullback  the classic entry at the zone. Expected hold is one to two hours and the leg is
 *             ahead of the fill, so the brief's 0.30–0.45 delta band applies: enough leverage
 *             to be worth the premium, enough delta to still track the move.
 *   holding   a continuation taken while the trend is already extended and running — the
 *             stock never gave a proper pullback and is being joined late. The hold is longer
 *             and the entry is worse, so 0.45–0.60 buys delta instead of leverage.
 */
export type EntryKind = 'pullback' | 'holding';

export interface PullbackSignal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 1 | -1;
  side: 'BUY' | 'SELL';
  entryKind: EntryKind;

  /** When the confirmation bar closed — NOT when this scan noticed. The signal's age. */
  firedAt: number;
  ageMin: number;
  /** The confirmation bar's close. Every level below is measured from here. */
  entry: number;
  /** Where the stock is now, so a stale signal shows how far it has run without you. */
  price: number;
  /** Move since the fire, signed with the direction. */
  movedSincePct: number;

  score: ScoreBreakdown;
  stop: StopPlan;
  target: TargetPlan;
  option: OptionPick | null;

  trend: TrendRead;
  pullback: PullbackRead;
  /** Higher timeframes that agree. The alignment bonus is computed from this. */
  alignedWith: Timeframe[];

  /** The signal's own life, tracked through the session by the alert engine. */
  outcome: SignalOutcome;
  reasons: string[];
  /** Every gate that failed. Non-empty only on a `watch` row, never on a fired signal. */
  blockers: string[];
}

export type SignalOutcomeState = 'Open' | 'TargetHit' | 'StopHit' | 'Expired';

export interface SignalOutcome {
  state: SignalOutcomeState;
  /** Best price reached in the trade's favour since firing. */
  maxFavourable: number;
  /** Worst against. Together these are what the backtest's MAE/MFE are built from. */
  maxAdverse: number;
  /** Realised R at the point the outcome settled. Null while Open. */
  r: number | null;
  closedAt: number | null;
  note?: string;
}

/* --------------------------------------------------------------------- the board --- */

/** Whether a symbol is a stock or one of the four index underlyings. */
export type InstrumentKind = 'stock' | 'index';

/**
 * The numbers a board row displays, for ONE timeframe.
 *
 * A flattened copy of the interesting part of a `TimeframeRead`, and it exists for a payload reason
 * rather than a modelling one. The list view wants the 9 EMA, the 20 EMA, VWAP, ADX and the volume
 * reading in its columns; `frames` carries four full reads including swing pivots and the whole
 * checklist, which is roughly half a megabyte across a 215-row board — far too much to poll every
 * thirty seconds for thirteen numbers a row. `frames` is still there on the detail endpoint and
 * behind `?includeFrames=1`, where the caller has asked for the weight.
 */
export interface RowReadout {
  timeframe: Timeframe;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  vwap: number | null;
  atr: number | null;
  adx: number | null;
  adxRising: boolean | null;
  /** This window's mean volume ÷ the previous window's — the trend's volume condition. */
  participation: number | null;
  /** Last closed bar's volume ÷ its own trailing mean. */
  volumeRatio: number | null;
  vwapDistanceAtr: number | null;
  ema20DistanceAtr: number | null;
  ema9SlopeAtrPerBar: number | null;
  /** True when this timeframe has too little history for any of the above to be read. */
  warming: boolean;
}

/**
 * One scanned symbol.
 *
 * A row exists for every symbol in the universe that could be read, whether or not it has a
 * signal. That is deliberate: the "upcoming pullbacks" card is built from rows in `AtZone`
 * with no confirmation yet, and those only exist if the board carries the near misses.
 */
export interface PullbackRow {
  symbol: string;
  name: string | null;
  kind: InstrumentKind;
  sector: string | null;

  price: number;
  prevClose: number;
  changePct: number;
  volume: number;
  turnoverCr: number;
  /**
   * Bid-ask on the UNDERLYING as a share of the mid, in bps. The brief's "large bid ask
   * spread" veto reads this. Null outside market hours, when there is no two-sided book —
   * which is a real state, not a wide spread, and is not allowed to veto anything.
   */
  spreadBps: number | null;

  /**
   * The indicator values for the timeframe this row is PRESENTED by — its signal's, else its watch
   * candidate's, else its strongest trend's. Always present, and what the board's columns read.
   */
  readout: RowReadout | null;
  /** Every timeframe that could be computed, keyed by minutes. Dropped from the list view. */
  frames: Partial<Record<Timeframe, TimeframeRead>>;
  /** The trend read per signal-eligible timeframe. */
  trends: Partial<Record<Timeframe, TrendRead>>;
  /** The pullback read per signal-eligible timeframe. */
  pullbacks: Partial<Record<Timeframe, PullbackRead>>;

  /**
   * The best FIRED signal on this symbol right now, across timeframes. Null when nothing has
   * confirmed — which is the normal state for most of the board most of the day.
   */
  signal: PullbackSignal | null;
  /**
   * The best setup that is at the zone but has NOT confirmed. This is the watchlist entry,
   * and it is the one a trader actually acts on: by the time a confirmation prints, the alert
   * is already a minute old.
   */
  watch: PullbackSignal | null;

  /** The strongest trend across timeframes, for the "Strongest Trend" card and sorting. */
  dominant: { timeframe: Timeframe; state: TrendState; strength: number } | null;
  /** Whether the option chain was fetched for this row this cycle. */
  enriched: boolean;
  warnings: string[];
}

export interface PullbackMarket {
  asOf: number;
  marketOpen: boolean;
  minuteOfSession: number;
  nifty: { level: number; changePct: number; aboveVwap: boolean | null } | null;
  indiaVix: { level: number; changePct: number } | null;
  breadth: { advances: number; declines: number; pctAboveVwap: number | null };
}

export interface PullbackBoard {
  asOf: number;
  configVersion: number;
  universeSize: number;
  scanned: number;
  /** Symbols whose option chain was fetched. */
  enriched: number;

  bullishSignals: number;
  bearishSignals: number;
  watching: number;
  /** Signals that fired today, whatever their current state. The "Today's Signals" card. */
  firedToday: number;

  market: PullbackMarket;
  rows: PullbackRow[];
  /** Anything degraded — a warming seed, a throttled endpoint, a timeframe with no history. */
  warnings: string[];
}

/* ------------------------------------------------------------------------ alerts --- */

export type AlertKind = 'freshPullback' | 'trendResume' | 'emaRejection' | 'targetHit' | 'stopHit';

export const ALERT_LABEL: Record<AlertKind, string> = {
  freshPullback: 'Fresh pullback',
  trendResume: 'Trend resumed',
  emaRejection: 'EMA rejection',
  targetHit: 'Target hit',
  stopHit: 'Stop hit',
};

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  at: number;
  symbol: string;
  timeframe: Timeframe;
  direction: 1 | -1;
  price: number;
  /** The headline, already written. Clients render this verbatim. */
  title: string;
  detail: string;
  /** The signal this alert belongs to, when there is one. */
  signalId: string | null;
  score: number | null;
}

/* --------------------------------------------------------------------- backtest --- */

export interface BacktestRequest {
  symbol: string;
  timeframe: Timeframe;
  /** IST calendar days, inclusive. */
  from: string;
  to: string;
  /** Which target closes the trade. Defaults to the config's primary. */
  exitOn: '1R' | '2R' | 'primary';
}

export interface BacktestTrade {
  symbol: string;
  direction: 1 | -1;
  entryAt: number;
  entry: number;
  stop: number;
  target: number;
  exitAt: number;
  exit: number;
  /** Realised multiples of the risk taken. */
  r: number;
  /** Minutes held. */
  holdMin: number;
  outcome: 'target' | 'stop' | 'sessionEnd';
  score: number;
  band: ConfidenceBand;
  /** Best and worst excursion while open, in R. */
  mfeR: number;
  maeR: number;
}

export interface BacktestResult {
  request: BacktestRequest;
  sessions: number;
  trades: BacktestTrade[];
  stats: {
    count: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    averageR: number | null;
    /** Σ gains ÷ Σ losses. Null when there were no losses to divide by. */
    profitFactor: number | null;
    /** Deepest peak-to-trough of the cumulative-R equity curve, in R. */
    maxDrawdownR: number;
    averageHoldMin: number | null;
    expectancyR: number | null;
    bestR: number;
    worstR: number;
  };
  /** Cumulative R after each trade — the equity curve the drawdown is measured on. */
  equity: Array<{ at: number; r: number }>;
  /** Win rate split by confidence band, which is the only real test of the score. */
  byBand: Array<{ band: ConfidenceBand; count: number; winRatePct: number | null; averageR: number | null }>;
  warnings: string[];
}

/* ------------------------------------------------------------------------ config --- */

/** A point on a piecewise-linear scoring curve — same convention as `momentum/types.ts`. */
export interface Knot {
  at: number;
  score: number;
}

export interface PullbackConfig {
  version: number;
  updatedAt: string;
  updatedBy: string;

  universe: {
    /** The four index underlyings, always scanned. */
    indices: string[];
    /** Scan every F&O stock as well as the indices. */
    includeFnoStocks: boolean;
    minPrice: number;
    minTurnoverCr: number;
    exclude: string[];
    /** How many rows get the option chain each cycle. The rate-limit budget. */
    enrichLimit: number;
  };

  timeframes: {
    /** Computed and displayed. */
    computed: Timeframe[];
    /**
     * Allowed to produce a signal.
     *
     * 1-minute is deliberately absent by default. Every gate in this module — ADX above 25,
     * a two-swing structure, a volume expansion against a 20-bar mean — is measurable on a
     * 1-minute chart and means very little there: at that resolution the pullback and its
     * confirmation are frequently the same two ticks, and the setup fires twenty times a
     * session on a stock that has gone nowhere. It is computed because it is the timing
     * resolution a fill happens at, and it is not signalled on because it is not a signal.
     */
    signal: Timeframe[];
    /** Timeframes that must agree for the alignment bonus. */
    context: Timeframe[];
    /** Fewer closed bars than this on a timeframe and it reads `warming`. */
    minBars: number;
    /** Bars of volume history the per-bar average is taken over. */
    volumeLookback: number;
  };

  trend: {
    /** ADX at or above this is a trend. The brief's 25. */
    adxTrend: number;
    /** ADX below this is a veto whatever else passes. The brief's 20. */
    adxVeto: number;
    /** Slope below this (ATR per bar) reads as flat, and vetoes. */
    flatSlopeAtrPerBar: number;
    /** Last closed bar's volume ÷ 20-bar mean must clear this. */
    minVolumeRatio: number;
    /** A veto: volume this far below the mean is a dead tape. */
    deadVolumeRatio: number;
    /** Structure steps needed for the higher-high / higher-low check to pass. */
    minStructureSteps: number;
    /**
     * Range compression veto: the last `n` bars' total range, in ATR. Under this the stock is
     * consolidating and every average is inside the noise.
     */
    consolidation: { bars: number; maxRangeAtr: number };
    /**
     * The no-man's-land veto. When price sits between VWAP and the 20 EMA and both are within
     * this many ATR of each other, there is no side to be on: the two references that would
     * define the trade disagree by less than the spread, and an entry taken here is stopped
     * by noise before the thesis is tested.
     */
    noMansLandAtr: number;
    /** Underlying bid-ask above this, in bps, vetoes. Ignored when the book is one-sided. */
    maxSpreadBps: number;
    /** EMA50 must be the right side of EMA20 for the trend to be "established". */
    requireEma50Stack: boolean;
    /** And EMA200, for a regime filter. Off by default — it disqualifies day-one reversals. */
    requireEma200Stack: boolean;
  };

  pullback: {
    /** How far outside the outermost average the zone is widened, in ATR. */
    zoneToleranceAtr: number;
    /** Price must have been at least this far from the zone for a leg to count as an impulse. */
    minImpulseAtr: number;
    /** Retracement band. Outside it the move is either not a pullback or not a trend. */
    minRetracement: number;
    maxRetracement: number;
    /** Bars a touch stays "live" waiting for confirmation before the setup is abandoned. */
    maxBarsInZone: number;
    /** A confirmation older than this many bars is history, not a signal. */
    maxConfirmationAgeBars: number;
    /** Body ÷ range on the confirmation candle. Below this it is a doji, not a turn. */
    minBodyRatio: number;
    /** Confirmation volume ÷ average volume. */
    minConfirmationVolumeRatio: number;
    /** Whether the confirmation bar must close back past the 9 EMA. */
    requireEma9Reclaim: boolean;
    /** How long the same symbol/timeframe is suppressed after a signal, in minutes. */
    cooldownMin: number;
    /**
     * Don't signal without this many minutes of session left.
     *
     * The real constraint on a continuation entry is not how far the day has come, it is how long is
     * left to hold it. A pullback entry is a 30-to-90-minute position; taken at 15:25 it has five
     * minutes, cannot reach its target, and is closed into the closing auction's spread — and on the
     * option side the decay and the exit spread are charged in full whether or not the move arrives.
     *
     * This gate is not decoration. A 26-session replay of RELIANCE on the 5-minute chart before it
     * existed produced seven trades, four of them entered between 15:05 and 15:25, and those four
     * accounted for the entire loss.
     */
    minMinutesLeft: number;
    /**
     * A rejection is a touch that FAILED — price closed through the zone against the trend.
     * This many ATR beyond the zone counts as through rather than as noise.
     */
    rejectionAtr: number;
  };

  score: {
    /** The brief's 30/20/15/15/10/10. Need not total 100 — the engine normalises. */
    weights: { trend: number; volume: number; vwap: number; ema: number; structure: number; adx: number };
    bands: { excellent: number; strong: number; medium: number };
    /** A row with less than this fraction of the points measurable is not published. */
    minCoverage: number;
    /** Signals below this confidence are computed but not surfaced as signals. */
    minToSignal: number;
    /** Points added per aligned higher timeframe, inside the trend component. */
    alignmentBonus: number;
    curves: {
      adx: Knot[];
      volumeRatio: Knot[];
      /** |price − VWAP| in ATR. Close to VWAP scores well; far away is a chase. */
      vwapDistanceAtr: Knot[];
      /** EMA9−EMA20 separation in ATR. Wide is a strong stack; zero is a crossover. */
      emaSeparationAtr: Knot[];
      structureSteps: Knot[];
    };
  };

  risk: {
    /** Stop distance for the ATR stop, in ATR. */
    atrStopMultiple: number;
    /** Buffer beyond the swing / EMA, in ATR, so the stop is not ON the level. */
    stopBufferAtr: number;
    /**
     * The floor on a structural stop, in ATR, below which the ATR stop is used instead.
     *
     * A stop tighter than a fraction of one bar's range is inside the noise it was drawn from and
     * is taken out by the bar it was placed on. It also destroys every R figure on the row: risk is
     * the denominator, so a stop 0.15 ATR away turns a routine target into "56R of room" and the
     * reward:risk gate — which exists to refuse thin trades — waves it through.
     *
     * This is not hypothetical. On a live board before the floor existed, BRITANNIA showed a 0.02%
     * stop and 56.48R of room, and SHREECEM 0.04% and 62.44R. Both were rows where price sat exactly
     * at its retracement low, so the swing stop degenerated to "entry minus the buffer".
     */
    minStopAtr: number;
    /** A structural stop wider than this is unaffordable and the ATR stop is used instead. */
    maxStopAtr: number;
    /** ATR target multiple, for the ATR target candidate. */
    atrTargetMultiple: number;
    /** Which target the reward:risk is quoted against. */
    primaryTarget: '1R' | '2R' | 'priorHigh' | 'measuredMove' | 'atr';
    /** Below this reward:risk the setup is refused however well it scores. */
    minRewardRisk: number;
    /** Chandelier trail: ATR multiple below the running extreme. */
    trailAtrMultiple: number;
    /** Which average the EMA trail follows. */
    trailEma: 9 | 20;
  };

  option: {
    /** The brief's bands. */
    pullbackDelta: { min: number; max: number };
    holdingDelta: { min: number; max: number };
    /** Strikes considered either side of the money. */
    itmSteps: number;
    otmSteps: number;
    minOi: number;
    minVolume: number;
    maxSpreadPct: number;
    maxThetaPctPerHour: number;
    /** Liquidity score below this vetoes the option — the brief's low-liquidity gate. */
    minLiquidityScore: number;
    /** Whether a failed option-liquidity gate refuses the whole signal or just the contract. */
    vetoSignalOnIlliquidOption: boolean;
    liquidityMix: { spread: number; openInterest: number; volume: number; depth: number };
    curves: { spreadPct: Knot[]; oi: Knot[]; volume: Knot[]; depthLots: Knot[] };
  };

  alerts: {
    enabled: boolean;
    kinds: AlertKind[];
    /** Events kept in the ring. */
    keep: number;
    /** The same symbol/kind is not re-alerted inside this window. */
    dedupeMin: number;
    /** POSTed a JSON body per alert. Empty disables the webhook. */
    webhookUrl: string;
    /**
     * The PHONE channel, and deliberately a narrower gate than the feed above.
     *
     * The in-app strip wants everything — it is a log you choose to look at. A push notification
     * is an interruption you did not choose, and the two cannot share a threshold: a channel that
     * buzzes for every `Weak` near-miss gets muted within a day, and muting it costs the one
     * alert that mattered. So the feed keeps `kinds`, and only what passes BOTH filters here
     * reaches the phone.
     *
     * The credentials are NOT here. They live in the environment, because this whole object is
     * served by `GET /pullback/config` — a bot token in it would be readable by anything that can
     * reach the API.
     */
    push: {
      enabled: boolean;
      /** Which events are worth an interruption. Default is confirmed entries only. */
      kinds: AlertKind[];
      /** Confidence floor, read against `score.bands`. An event with no score never passes. */
      minBand: ConfidenceBand;
    };
  };

  refresh: {
    /** The scan interval. The quote poll's resolution is the scanner's resolution. */
    scanMs: number;
    /** How long an option chain is reused before it is re-fetched. */
    enrichMs: number;
    /** How long a candidate's exact intraday candles are reused. */
    resyncMs: number;
    /** IST hour the daily seed rebuild runs. */
    seedHourIst: number;
  };

  output: {
    limit: number;
    /** Rows below this trend strength are computed but not returned. */
    minTrendStrength: number;
  };
}

/* ------------------------------------------------------------- persisted records --- */

/** One fired signal, kept for the history table and the alert engine's outcome tracking. */
export interface SignalRecord {
  id: string;
  day: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 1 | -1;
  firedAt: number;
  entry: number;
  stop: number;
  target: number;
  score: number;
  band: ConfidenceBand;
  entryKind: EntryKind;
  option: { label: string; entryCost: number; delta: number } | null;
  outcome: SignalOutcome;
}
