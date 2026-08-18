// Momentum Scanner — the domain model.
//
// One rule runs through every type here: a number this app cannot MEASURE is `null`, never
// a stand-in. A momentum score is read as a trading signal, so a fabricated component is
// worse than a missing one — an absent factor is visible in the UI and drops out of the
// weighting, where an invented one silently moves the ranking. `available: false` plus a
// `note` saying why is the shape that carries that through the whole pipeline.

/** The thirteen factors the score is built from. Order is the order the UI lists them. */
export type FactorKey =
  | 'momentumPulse'
  | 'trendQuality'
  | 'rvol'
  | 'liquidity'
  | 'relativeStrength'
  | 'vwap'
  | 'optionFlow'
  | 'greeks'
  | 'impliedVolatility'
  | 'atrExpansion'
  | 'sectorStrength'
  | 'marketBreadth'
  | 'trendStructure';

export const FACTOR_KEYS: FactorKey[] = [
  'momentumPulse', 'trendQuality', 'rvol', 'liquidity', 'relativeStrength', 'vwap', 'optionFlow',
  'greeks', 'impliedVolatility', 'atrExpansion', 'sectorStrength', 'marketBreadth', 'trendStructure',
];

export const FACTOR_LABEL: Record<FactorKey, string> = {
  momentumPulse: 'Momentum Pulse (last minutes)',
  trendQuality: 'Trend Quality (one-sidedness)',
  rvol: 'Relative Volume',
  liquidity: 'Liquidity',
  relativeStrength: 'Relative Strength',
  vwap: 'VWAP',
  optionFlow: 'Option Chain / OI Build-up',
  greeks: 'Greeks',
  impliedVolatility: 'Implied Volatility',
  atrExpansion: 'ATR Expansion',
  sectorStrength: 'Sector Strength',
  marketBreadth: 'Market Breadth',
  trendStructure: 'Trend Structure',
};

/**
 * Which factors carry a DIRECTION as well as a magnitude.
 *
 * The distinction is what lets one score serve both sides of the book: relative volume of
 * 4x is strong evidence of momentum but says nothing about which way, while price above a
 * rising VWAP says both. Magnitude-only factors contribute to the score and abstain from
 * the direction vote, so a heavily-traded stock going nowhere does not read as bullish.
 */
export const DIRECTIONAL: Record<FactorKey, boolean> = {
  momentumPulse: true,
  trendQuality: true,
  rvol: false,
  liquidity: false,
  relativeStrength: true,
  vwap: true,
  optionFlow: true,
  greeks: true,
  impliedVolatility: false,
  atrExpansion: false,
  sectorStrength: true,
  marketBreadth: true,
  trendStructure: true,
};

/* ------------------------------------------------------------------ factor output --- */

/** One line of the explainable-AI breakdown. `ok` decides the ✓ or the ✗. */
export interface FactorReason {
  ok: boolean;
  text: string;
}

export type MetricValue = number | string | boolean | null;

export interface FactorOutcome {
  key: FactorKey;
  label: string;
  /** 0–100 strength of the evidence, or null when the factor could not be computed. */
  score: number | null;
  /**
   * −1…+1. Positive is bullish. Always 0 for a magnitude-only factor, and 0 for a
   * directional one whose reading is genuinely flat.
   */
  bias: number;
  /** The configured weight, echoed so the UI can show the arithmetic. */
  weight: number;
  available: boolean;
  /** Why it is missing, or which sub-components were dropped. Shown verbatim in the UI. */
  note?: string;
  /** Every raw number behind the score — this is what the detail page renders. */
  metrics: Record<string, MetricValue>;
  reasons: FactorReason[];
}

/* -------------------------------------------------------------------- score output --- */

export type Confidence = 'High' | 'Medium' | 'Low';
export type Direction = 'Bullish' | 'Bearish' | 'Neutral';
/**
 * `Watch` is the state the board was missing.
 *
 * The eleven original factors all measure the day CUMULATIVELY — relative volume against the
 * whole session, price against the previous close, range against ATR — so they peak once the
 * move is finished. A row can therefore be a textbook momentum stock and a terrible entry at
 * the same time, and until this existed the board had no way to say so: it printed
 * "Momentum Buy" on a stock that had already travelled its whole day's range, and the option
 * bought against it paid for a move that had already happened.
 *
 * `Momentum Buy` / `Momentum Sell` now mean "strong AND still entrable". `Watch` means the
 * model likes the stock but the entry is gone or has not arrived — see `signal.blockers` for
 * which of the two.
 */
export type TradeType = 'Momentum Buy' | 'Momentum Sell' | 'Watch' | 'Avoid';
export type ActivityLevel = 'High' | 'Medium' | 'Low';
export type LiquidityGrade = 'Excellent' | 'Good' | 'Average' | 'Poor';
export type RvolGrade = 'Excellent' | 'Good' | 'Average' | 'Poor';

/**
 * Where a row's option-derived factors came from.
 *   'quote'   — quote-tier factors only; the row was not in the enrichment shortlist.
 *   'full'    — option chain, futures open interest and Greeks all present.
 *   'partial' — enrichment ran but one or more option calls failed for this symbol.
 */
export type EnrichmentLevel = 'quote' | 'partial' | 'full';

/* -------------------------------------------------------------- conviction layer --- */

/**
 * How far the trend-day classification has got.
 *
 *   None       not enough session has elapsed, or the shape is not one-sided at all.
 *   Forming    the shape looks one-sided but has not been one-sided for long enough to be
 *              trusted. Roughly the first hour. Tradable by someone who wants the whole move
 *              and accepts that a fair share of these decay into chop by noon.
 *   Confirmed  adherence, crossing count, path efficiency and pullback depth have all held
 *              for `confirmHoldMin`. This is the state BOSCHLTD-on-a-trend-day lives in from
 *              mid-morning to the close, and the one the re-entry trigger works inside.
 *   Faded      it WAS one-sided and has stopped being. Kept as a distinct state rather than
 *              dropped to None because a faded trend day is the single most dangerous row on
 *              the board — everyone holding it is holding it on a thesis that expired.
 */
export type TrendPhase = 'None' | 'Forming' | 'Confirmed' | 'Faded';

/**
 * The session-scale read: IS THIS STOCK GOING ONE WAY ALL DAY.
 *
 * WHY THIS EXISTS, and why the pulse could not do it.
 *
 * `momentumPulse` measures the last three minutes and `score.service.ts` measures the day's
 * cumulative magnitude. Neither measures the day's SHAPE, and shape is the whole difference
 * between the two stocks that matter here:
 *
 *   A  opens flat, grinds up 4% across five hours, never closes a 5-minute bar below VWAP,
 *      deepest pullback 0.3 ATR. Every retracement is an entry and the option pays all day.
 *   B  gaps up 4% at 09:20, then chops in a 1.5% band for five hours, crossing VWAP eleven
 *      times. Same change%, same RVOL, same ATR expansion, same relative strength.
 *
 * The twelve-factor score cannot tell them apart — and it ranks B HIGHER, because chop
 * generates the volume bursts and velocity spikes the pulse rewards. Worse, A trips the
 * extension ceiling by mid-morning (a genuine trend day expands true range well past one
 * ATR) and is refused an entry for the rest of the session, which is exactly the failure
 * that produced this module.
 *
 * Every reading below comes from accumulators folded into the existing 15-second quote poll,
 * so this costs no upstream request and is available on the whole universe.
 */
export interface ConvictionReading {
  /** False when the session is too young, or too little of it was observed, to judge. */
  ready: boolean;
  /** 0–100. How one-sided the session has been. The tab's ranking key. */
  score: number;
  phase: TrendPhase;
  direction: Direction;
  /** Minutes the current phase has held. The persistence that stops the board churning. */
  heldMin: number | null;
  /**
   * When this row was promoted to Confirmed today, as an epoch. Null if it never was.
   *
   * Not the same fact as `heldMin`, and kept alongside it rather than derived from it, for two
   * reasons. It is an ABSOLUTE time, so it can be read against the chart and against every
   * other row — "confirmed at 10:30" places the signal on the session in a way "held 4h" does
   * not. And it SURVIVES the fade: once a row demotes, `heldMin` restarts from the demotion
   * and the only remaining record of when the day was called is this field.
   */
  confirmedAt: number | null;
  /**
   * The conviction score at the instant of confirmation. Null if it never confirmed, and null
   * for a confirmation carried over from a state file written before this was recorded.
   *
   * The companion to `confirmedAt`, and the reason both are worth having: the time says WHEN
   * the day was called and this says HOW STRONGLY. Distinct from `peak`, which is the best the
   * row ever read and is normally reached long after the call — so a row confirmed at 83 that
   * peaked at 96 was an early call that paid, and one confirmed at 83 that peaked at 84 was
   * marginal the whole way.
   */
  convictionAtConfirm: number | null;
  /** Highest conviction reached today, so a faded row still says how good it once was. */
  peak: number;

  /**
   * Net displacement from the first observed price, in ATR, signed with the trend.
   *
   * THE NECESSARY CONDITION, and its absence made every other reading here worthless. Shape
   * without magnitude is not a trend day: a stock drifting 0.1% above its VWAP all session has
   * perfect adherence, zero crossings, high path efficiency, a range position near its high
   * and — worst of all — a tiny deepest-pullback, because it never moved far enough to pull
   * back. The pullback component actively REWARDS being dead.
   *
   * Measured on 2026-08-05 before this existed: INFY finished +0.02% on the day and scored a
   * peak conviction of 98, Confirmed. So did ITC at −0.23% and MARUTI at −0.26%. Eight of
   * twelve sampled stocks reached Confirmed, which is not a trend-day detector, it is a
   * detector of stocks that exist.
   */
  displacementAtr: number | null;
  /** Share of observed session on the dominant side of VWAP, 0.5…1. */
  vwapAdherence: number | null;
  /** How many times price has crossed VWAP today. A trend day does it 0–2 times. */
  vwapCrossings: number | null;
  /** |net move| ÷ total path travelled, over the whole session rather than three minutes. */
  sessionEfficiency: number | null;
  /** Where price sits in the day's range, oriented to the trend. 1 = at the running extreme. */
  rangePosition: number | null;
  /** The deepest counter-trend excursion of the day, in ATR. Trend days keep this under ~0.4. */
  deepestPullbackAtr: number | null;
  /** Session-scale VWAP slope, %/min, signed with the trend. */
  vwapSlopePctPerMin: number | null;
  /** Consecutive higher lows (up) or lower highs (down) on the 5-minute spine. */
  structureCount: number | null;
  /**
   * Minutes since the day's extreme was last extended IN THE TREND'S DIRECTION.
   *
   * Measured from the session accumulator rather than from the price ring, which only reaches
   * back 25 minutes and therefore cannot distinguish "no new high for half an hour" from "no
   * new high since 11:00". The distinction is the whole point: a one-sided day that has
   * stopped making new extremes has stopped being a continuation trade and started being
   * distribution, and it goes on looking identical on every other reading here — BOSCHLTD held
   * 100% VWAP adherence and zero crossings for three hours after it had finished going up.
   */
  minutesSinceExtreme: number | null;

  /** Minutes of session actually observed. Short after a mid-day restart. */
  observedMin: number;
  /** Minute of session the accumulation started — 0 on a clean open. */
  fromMinute: number;
  /** True when the accumulators missed the open, so every share below is a partial read. */
  partial: boolean;
  note?: string;
}

/** The slice of the reading that rides on a board row. */
export interface ConvictionSummary {
  ready: boolean;
  score: number;
  phase: TrendPhase;
  direction: Direction;
  heldMin: number | null;
  /** When the row was promoted to Confirmed today, epoch ms. Null if it never was. */
  confirmedAt: number | null;
  /** The conviction score at that instant — how strong the call was when it was made. */
  convictionAtConfirm: number | null;
  peak: number;
  vwapAdherence: number | null;
  vwapCrossings: number | null;
  sessionEfficiency: number | null;
  rangePosition: number | null;
  deepestPullbackAtr: number | null;
  partial: boolean;
  /** The one-line human read: "above VWAP all session, 1 crossing, deepest dip 0.24 ATR". */
  summary: string;
  note?: string;
}

/* ------------------------------------------------------------------ timing layer --- */

/**
 * Where the stock is in its move RIGHT NOW, as opposed to how strong the day has been.
 *
 *   Igniting   the move is starting. A trigger fired within the last few minutes, volume is
 *              bursting against its own per-minute norm, and the range travelled so far is
 *              still small against ATR. This is the only state where a fresh option entry
 *              has the whole leg in front of it.
 *   Trending   a Forming or Confirmed one-sided day, with the leg going the trend's way. The
 *              state the extension ceiling used to swallow: a stock that has travelled 1.6
 *              ATR is spent on a mean-reverting day and is merely HALFWAY on a trend day, and
 *              the difference between those two readings is what the conviction layer buys.
 *   Extending  the leg is real but no longer new. Entry is a pullback, not a chase.
 *   Extended   the move is largely spent — most of the day's budget travelled, price far from
 *              VWAP. The score will be at its highest here and the trade is at its worst.
 *   Stalling   the leg is intact but has stopped making new extremes and volume has faded.
 *   Reversing  the last minutes point against the day's direction. A held position is wrong
 *              before the score notices.
 *   Quiet      nothing is happening on this timescale.
 */
export type SignalState =
  | 'Igniting' | 'Trending' | 'Extending' | 'Extended' | 'Stalling' | 'Reversing' | 'Quiet';

/** What the timing layer says to do about it. Not advice — a label for the state above. */
export type SignalAction = 'Buy Call' | 'Buy Put' | 'Watch' | 'Stand Aside';

/**
 * What started the move. Ordered by how early it fires, earliest first.
 *
 *   baseBreak    price leaving a compressed range it had been holding. The earliest honest
 *                trigger there is — the move has by definition just begun.
 *   vwapReclaim  crossing back over the session VWAP on volume, the classic intraday turn.
 *   vwapLoss     the same, downward.
 *   orbBreak     leaving the 09:15–09:30 opening range.
 *   dayExtreme   a new session high or low after a stretch of not making one.
 *   priorRange   through the previous session's high/low or the 20-day extreme.
 *   thrust       no level involved — velocity and volume alone, which is what a news-driven
 *                move looks like before it has a structure to break.
 *   trendPullback  a retracement inside an established one-sided day that has finished
 *                retracing and turned back with the trend. The only trigger here that is
 *                MEANT to fire several times a session: on a trend day the tradable event is
 *                not the ignition — that was at 09:40 and is gone — it is each successive
 *                pullback, and a model that fires once a day on these stocks describes them
 *                instead of trading them.
 */
export type TriggerKind =
  | 'baseBreak' | 'vwapReclaim' | 'vwapLoss' | 'orbBreak' | 'dayExtreme' | 'priorRange'
  | 'thrust' | 'trendPullback';

export interface SignalTrigger {
  kind: TriggerKind;
  label: string;
  /** +1 long, −1 short. */
  direction: 1 | -1;
  /** Epoch ms the trigger FIRST fired — not when it was last seen to still be true. */
  at: number;
  /** The price when it fired. Every entry/stop/target is measured from here. */
  price: number;
  ageMin: number;
  /** How far the stock has already travelled since the trigger, signed with the direction. */
  movedSincePct: number;
}

/**
 * The micro-momentum measurement, all of it from the 15-second quote poll this module
 * already makes. No reading here looks further back than `pulse.baseWindowMin`.
 */
export interface PulseSummary {
  /** False when there are not yet enough readings to measure anything. */
  ready: boolean;
  /** 0–100 strength of the recent movement. Null when not ready. */
  score: number | null;
  /** Signed −1…+1. Which way the last minutes have gone. */
  bias: number;
  /** Percent moved over the fast window. */
  movePct: number | null;
  /** That move as a fraction of one ATR, per minute — comparable across the whole board. */
  velocityAtrPerMin: number | null;
  /**
   * Volume in the fast window against what this stock normally trades in the SAME window at
   * this time of day. Unlike day RVOL this spikes as the move starts, not after it.
   */
  burstRvol: number | null;
  /** |net move| ÷ Σ|leg moves| over the window. 1 is a straight line, 0.3 is chop. */
  efficiency: number | null;
  /** Fast-window velocity minus the velocity of the window before it, %/min. */
  acceleration: number | null;
  /** The current directional leg, from an ATR-scaled zigzag over the session. */
  legAgeMin: number | null;
  legMovePct: number | null;
  /** How far price has come back off the leg's extreme, as a fraction of the leg. */
  pullback: number | null;
  /** Minutes since the leg last made a new extreme. The stall detector. */
  minutesSinceExtreme: number | null;
  note?: string;
}

/**
 * How much of the day's movement budget is already used up.
 *
 * The BUDGET IS NOT FIXED, and assuming it was is what hid every trend day. `atrUsedMax` of
 * 0.8 is the right ceiling for an ordinary session — past it a mean-reverting day needs an
 * abnormal afternoon to pay another leg. A confirmed one-sided day routinely runs 1.5–2.5
 * ATR, so the same ceiling marks it spent by mid-morning and refuses every entry for the rest
 * of the session, which is precisely backwards: the stocks that trend hardest were the ones
 * disqualified soonest. `budgetMultiplier` is what the conviction layer earns.
 */
export interface Extension {
  /**
   * The reading the ceiling is applied to: today's INTRADAY range ÷ ATR, gap excluded.
   *
   * True range would include `|high − prevClose|`, which charges the opening gap against the
   * budget — so a stock that opened a full ATR from yesterday's close was marked spent before
   * a share traded, and refused for the whole session. The gap is real, and it is reported in
   * `gapAtr` rather than counted as travel a new position has to compete with.
   */
  atrUsed: number | null;
  /** Today's true range ÷ ATR, gap included. Carried for context, not gated on. */
  trueRangeAtrUsed: number | null;
  /** The opening gap in ATR, signed. */
  gapAtr: number | null;
  /** |price − VWAP| ÷ ATR. How stretched from the day's mean the entry would be. */
  vwapAtr: number | null;
  /** The current leg's size ÷ ATR. */
  legMoveAtr: number | null;
  /** What the configured ceilings were scaled by, from the trend phase. 1 on an ordinary day. */
  budgetMultiplier: number;
  /** The ceiling actually applied to `atrUsed`, after that scaling. */
  atrUsedMax: number;
  extended: boolean;
}

export type OptionType = 'CE' | 'PE';

/**
 * The contract to buy — the one output of this module that ends in an order.
 *
 * Chosen from the near-month chain by NET payoff at the plan's target: bought at the ask,
 * sold at the bid, so a strike whose book is wide is penalised by what that book will
 * actually cost. A hard delta floor sits under the ranking, because a cheap enough option
 * always shows the highest percentage and the ones below ~0.25 delta stop tracking the
 * underlying the plan is built on.
 */
export interface StrikeChoice {
  strike: number;
  type: OptionType;
  /** "2450 CE" — what to type into a terminal. */
  label: string;
  /** Upstox instrument key, for anything placing the order programmatically. */
  instrumentKey: string;
  expiry: string;
  expiryDays: number;
  /** Signed steps from the money, positive = further out of the money. */
  stepsFromAtm: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  /** Last traded premium. */
  premium: number;
  /** What it costs to get in — the ask, not the mid. */
  entryCost: number;
  bid: number;
  ask: number;
  /** Bid-ask as a percentage of the mid. Null when the book is one-sided. */
  spreadPct: number | null;
  delta: number;
  gamma: number | null;
  iv: number | null;
  /** Decay as a percentage of the premium per hour, from the chain's own theta. */
  thetaPctPerHour: number | null;
  oi: number;
  volume: number;
  lotSize: number | null;
  /** `entryCost × lotSize` — what one lot costs, in rupees. */
  costPerLot: number | null;
  /** Premium if the underlying reaches the plan's target, second-order in gamma. */
  premiumAtTarget: number | null;
  /** The gain that implies, NET of paying the ask and selling the bid. */
  gainPctAtTarget: number | null;
  /** That gain in rupees for one lot. */
  profitPerLot: number | null;
  /** Underlying price at which this contract breaks even at expiry. */
  breakEven: number | null;
  /** Why this strike and not its neighbours. */
  reason: string;
  /** Wide book, thin open interest, heavy decay — stated, never silently filtered. */
  warnings: string[];
}

/**
 * The arithmetic behind "can this actually pay 30–40% on the option".
 *
 * Stop and target are in the UNDERLYING, from ATR. `optionMovePctAtTarget` converts the
 * target into a premium move with the ATM delta and gamma actually quoted on the chain, so
 * the answer accounts for the option being cheap or expensive rather than assuming it.
 */
export interface SignalPlan {
  entry: number;
  stop: number;
  target: number;
  stopPct: number;
  targetPct: number;
  rewardRisk: number | null;
  /** Estimated option premium change if the target is reached, in percent. */
  optionMovePctAtTarget: number | null;
  /** How far the STOCK must move for the option to gain `signal.targetOptionMovePct`. */
  underlyingMovePctForTargetOption: number | null;
  /** Whether that move is still inside the room the model thinks is left. */
  meetsOptionTarget: boolean | null;
  /**
   * Where the option numbers came from.
   *   'strike'   the specific contract in `signal.strike`, net of its own spread.
   *   'chain'    ATM greeks only — the chain object was not in hand for this build.
   *   'atr-only' price plan only; no option data at all.
   */
  basis: 'strike' | 'chain' | 'atr-only';
}

export interface MomentumSignal {
  state: SignalState;
  action: SignalAction;
  /**
   * 0–100. What this row is worth AS AN ENTRY, which is a different question from the score.
   * Freshness, pulse strength, room left, alignment and liquidity — nothing cumulative.
   */
  entryQuality: number;
  /** 100 at the trigger, 0 at `signal.maxTriggerAgeMin`. Null when nothing has fired. */
  freshness: number | null;
  trigger: SignalTrigger | null;
  /** The direction of the last minutes, which can disagree with the day's direction. */
  microDirection: Direction;
  /** Whether it does agree. Null when either side is flat. */
  aligned: boolean | null;
  pulse: PulseSummary;
  extension: Extension;
  plan: SignalPlan | null;
  /**
   * Which contract to buy. Null when this row had no option chain this cycle — the shortlist
   * is finite, so most of the board carries a price plan and no strike.
   */
  strike: StrikeChoice | null;
  /**
   * Which kind of entry this row is offering, so the contract on it can be read correctly.
   *   'ignition'  a fresh break. Short hold, leverage is worth paying for.
   *   'pullback'  a retracement inside an ordinary established leg.
   *   'trend'     a retracement inside a confirmed one-sided day — the re-entry this module
   *               was rebuilt around. Expected hold 30–90 minutes, so the strike is picked in
   *               a delta band rather than on raw payoff.
   */
  entryKind: 'ignition' | 'pullback' | 'trend' | null;
  /** How many times a trend-day re-entry has fired on this stock today. */
  trendEntriesToday: number;
  reasons: FactorReason[];
  /** Every gate that failed, in words. Empty means the entry is clean. */
  blockers: string[];
}

export interface MomentumRow {
  rank: number;
  symbol: string;
  name?: string;
  sector: string | null;

  price: number;
  prevClose: number;
  changePct: number;
  /** Cumulative traded quantity for the session. */
  volume: number;
  /** ₹ crore traded today. */
  turnoverCr: number;

  /** 0…config.scoring.maxScore. */
  score: number;
  /** Weighted score BEFORE the coherence penalty — shown so the penalty is visible. */
  rawScore: number;
  /** Fraction of the total configured weight that was actually computable, 0…1. */
  coverage: number;
  confidence: Confidence;
  direction: Direction;
  tradeType: TradeType;
  institutionalActivity: ActivityLevel;

  /**
   * WHEN, as opposed to what. Null only when the timing layer is switched off in config.
   *
   * The score answers "is this stock moving with conviction today"; this answers "is there
   * still a move left to buy". A row can be 88 and `Extended`, which is precisely the row
   * that used to look like the best trade on the board and was the worst.
   */
  signal: MomentumSignal | null;

  /**
   * The session-scale one-sidedness read. Null only when the layer is switched off.
   *
   * Answers the question neither `score` nor `signal` could: "has this stock spent the whole
   * day going one way". A row can score 84, be `Extended`, and have a conviction of 11 — that
   * is a stock which gapped and chopped. And a row can score 61 with a conviction of 88, which
   * is the BOSCHLTD-grinding-all-day shape the old board could not see at all.
   */
  conviction: ConvictionSummary | null;

  /**
   * Why this row is where it is in the list, and how settled that position is.
   *
   * The board used to sort on a score recomputed every fifteen seconds with an 18-weight
   * three-minute factor inside it, so rows jumped dozens of places on a wobble and the list
   * was unreadable. `rankScore` is an exponentially smoothed score and is what the board is
   * actually ordered by; `heldMin` says how long the row has held its current direction.
   */
  stability: {
    /** The smoothed score the board is sorted by. */
    rankScore: number;
    /** Raw score minus smoothed — positive means it is moving up faster than the list shows. */
    drift: number;
    /** Minutes this row has held its current direction without flipping. */
    heldMin: number | null;
  };

  liquidity: { score: number | null; grade: LiquidityGrade | null };
  rvol: { value: number | null; grade: RvolGrade | null };
  vwap: { value: number | null; distancePct: number | null; rising: boolean | null };
  relativeStrengthPct: number | null;
  sectorStrengthPct: number | null;
  atrExpansion: number | null;
  oiBuildUp: OiBuildUp | null;
  /**
   * The open-interest headline figures.
   *
   * Note the two timescales, which are NOT interchangeable: the futures reading is intraday
   * (live OI against the previous session's close), while the chain's PCR and its OI changes
   * are day-over-day, because Upstox's `prev_oi` on a chain leg is the previous session's
   * close and there is no intraday equivalent. The field names carry the distinction.
   */
  oi: {
    futuresOi: number | null;
    futuresOiChangePctIntraday: number | null;
    pcrOi: number | null;
    pcrVolume: number | null;
    maxPain: number | null;
    optionValueCr: number | null;
    expiry: string | null;
  } | null;
  greeksSummary: { delta: number | null; deltaShift: number | null; gamma: number | null; thetaBurnPct: number | null } | null;
  ivSummary: { atmIv: number | null; ivRank: number | null; ivPercentile: number | null; basis: IvBasis } | null;
  /** One-sigma expected move to expiry, ₹ and %, from the ATM straddle. */
  expectedMove: { rupees: number; pct: number; days: number } | null;
  trend: { higherHigh: boolean; higherLow: boolean; breakout: 'up' | 'down' | null; orb: 'up' | 'down' | null } | null;

  enrichment: EnrichmentLevel;
  /** The ✓/✗ list. Ordered by factor weight, strongest first. */
  reasons: FactorReason[];
  factors: FactorOutcome[];
}

export type OiBuildUp = 'Long Build-up' | 'Short Build-up' | 'Short Covering' | 'Long Unwinding' | 'Neutral';

/** Which history the IV rank was computed from — see iv.service.ts for why this exists. */
export type IvBasis = 'iv-history' | 'hv-proxy' | 'unavailable';

export interface MarketContext {
  asOf: number;
  marketOpen: boolean;
  sessionFraction: number;
  minuteOfSession: number;
  nifty: { level: number; changePct: number; aboveVwap: boolean | null; vwapSource: string } | null;
  indiaVix: { level: number; changePct: number } | null;
  breadth: {
    advances: number;
    declines: number;
    unchanged: number;
    advanceDeclineRatio: number | null;
    pctAboveVwap: number | null;
    sectorsPositive: number;
    sectorsTracked: number;
    bias: number;
  };
}

export interface MomentumBoard {
  asOf: number;
  configVersion: number;
  universeSize: number;
  scored: number;
  shortlisted: number;
  /** Rows whose move is starting right now. */
  igniting: number;
  /** Rows the timing layer would take an entry in right now. */
  entrable: number;
  /** Confirmed one-sided days, and the ones still proving themselves. */
  trendConfirmed: number;
  trendForming: number;
  /** Trend days that have stopped being one-sided — the rows most dangerous to still hold. */
  trendFaded: number;
  market: MarketContext;
  rows: MomentumRow[];
  /** Anything degraded — a missing baseline, a refused endpoint, a warming IV history. */
  warnings: string[];
}

/* ------------------------------------------------------------------------- config --- */

/**
 * A point on a piecewise-linear scoring curve: "a reading of `at` scores `score`".
 *
 * Every threshold in this module is expressed as a list of these rather than an `if`, which
 * is what makes the model configurable end-to-end: an admin moving "excellent RVOL" from
 * 3.5 to 4.0 edits a number, not a branch. Knots must be sorted ascending by `at`; readings
 * below the first or above the last clamp to that end.
 */
export interface Knot {
  at: number;
  score: number;
}

export interface LiquidityMix {
  averageDailyValue: number;
  spread: number;
  depth: number;
  optionValue: number;
}

export interface GreeksMix {
  delta: number;
  gamma: number;
  theta: number;
}

export interface OptionFlowMix {
  futuresOi: number;
  optionOi: number;
}

export interface VwapMix {
  distance: number;
  slope: number;
}

export interface MomentumConfig {
  version: number;
  updatedAt: string;
  updatedBy: string;

  /** Relative weights. Need not sum to 100 — the engine normalises by available weight. */
  weights: Record<FactorKey, number>;

  scoring: {
    maxScore: number;
    /**
     * Disagreement penalty. When the directional factors point different ways the setup is
     * not a momentum trade however loud each individual factor is, so the total is cut by
     * up to `maxPenalty` (a fraction) in proportion to how split the vote is.
     */
    coherence: { enabled: boolean; maxPenalty: number };
    /** |direction vector| below this reads Neutral rather than Bullish/Bearish. */
    directionDeadband: number;
    /** A row with less than this fraction of its weight computable is not published. */
    minCoverage: number;
  };

  confidence: {
    /** Coverage fractions. */
    high: number;
    medium: number;
    /** A row below this liquidity score can never be High confidence. */
    minLiquidityForHigh: number;
  };

  thresholds: {
    rvol: { knots: Knot[]; excellent: number; good: number; average: number };
    liquidity: {
      mix: LiquidityMix;
      averageDailyValueCr: Knot[];
      spreadBps: Knot[];
      depthCr: Knot[];
      optionValueCr: Knot[];
      grade: { excellent: number; good: number; average: number };
    };
    relativeStrength: { knots: Knot[]; fullScalePct: number; useBeta: boolean };
    vwap: { mix: VwapMix; distancePct: Knot[]; slopePctPerMin: Knot[]; fullScaleDistPct: number; fullScaleSlope: number };
    optionFlow: {
      mix: OptionFlowMix;
      futuresOiChangePct: Knot[];
      optionOiSkewPct: Knot[];
      fullScaleOiPct: number;
      /** How much each build-up class is worth as a directional read, −1…+1. */
      buildUpBias: Record<OiBuildUp, number>;
    };
    greeks: { mix: GreeksMix; deltaShift: Knot[]; gammaNotional: Knot[]; thetaBurnPct: Knot[] };
    impliedVolatility: { rank: Knot[]; premium: Knot[]; minSessionsForIvRank: number };
    atrExpansion: { knots: Knot[]; period: number };
    sectorStrength: { knots: Knot[]; fullScalePct: number };
    marketBreadth: { knots: Knot[]; counterTrendFactor: number };
    trendStructure: {
      lookbackSessions: number;
      openingRangeMinutes: number;
      points: { higherHigh: number; higherLow: number; breakout: number; openingRangeBreak: number; aboveOpen: number };
    };
    institutional: { rvolWeight: number; turnoverWeight: number; optionWeight: number; oiWeight: number; high: number; medium: number };

    /** Factor 12 — the micro-momentum measurement. Windows are in minutes of session. */
    pulse: {
      /** The "right now" window. Everything the ignition read is built on. */
      fastWindowMin: number;
      /** How far back a pre-breakout base is looked for. */
      baseWindowMin: number;
      /** Fewer readings than this in the fast window and the pulse is `ready: false`. */
      minReadings: number;
      mix: { burst: number; velocity: number; efficiency: number };
      /** Interval volume ÷ the same interval's normal volume. */
      burstRvol: Knot[];
      /** Fraction of one ATR travelled per minute. 0.02 is a decisive drift. */
      velocityAtrPerMin: Knot[];
      /** Directional persistence, 0…1. */
      efficiency: Knot[];
      /** Zigzag reversal threshold, in ATR. Below this a wobble is not a new leg. */
      legReversalAtr: number;
      /** A floor for it, in percent, for symbols with no ATR baseline. */
      legReversalPctFloor: number;
      /** A base narrower than this × ATR counts as compressed and is worth breaking. */
      compressionAtr: number;
      /** How far past the base edge price must clear, in ATR, before it counts as broken. */
      breakBufferAtr: number;
      /** Full-scale for the pulse's directional bias, in ATR-per-minute. */
      fullScaleVelocityAtr: number;
    };

    /**
     * Factor 13 — the session-scale one-sidedness measurement.
     *
     * Where `pulse` asks "is it moving right now", this asks "has it been going ONE WAY all
     * day". Six readings, mixed, plus the phase machine that gives the answer persistence.
     */
    conviction: {
      enabled: boolean;
      /** How the six sub-readings are combined. Need not sum to 1 — `mix()` normalises. */
      mix: {
        displacement: number;
        adherence: number;
        crossings: number;
        efficiency: number;
        rangePosition: number;
        pullback: number;
        slope: number;
        structure: number;
      };
      /** Net move from the open in ATR, signed with the trend. The necessary condition. */
      displacementAtr: Knot[];
      /** Share of the observed session on the dominant side of VWAP, 0.5…1. */
      adherence: Knot[];
      /** VWAP crossings today. Descending — a trend day barely crosses at all. */
      crossings: Knot[];
      /**
       * |net| ÷ path over the WHOLE session. Much lower than the three-minute figure by
       * construction — a full day of 15-second sampling accumulates a lot of path — so the
       * curve tops out around 0.5 rather than near 1.
       */
      efficiency: Knot[];
      /** Where price sits in the day's range, oriented to the trend. */
      rangePosition: Knot[];
      /** Deepest counter-trend excursion of the day, in ATR. Descending. */
      deepestPullbackAtr: Knot[];
      /** Session-scale VWAP slope in %/min, signed with the trend. */
      slopePctPerMin: Knot[];
      /** Consecutive higher lows / lower highs on the spine. */
      structure: Knot[];
      /**
       * How far price must sit from VWAP before it counts as being on a side, in ATR.
       * Without it a stock pinned to its own VWAP registers dozens of crossings a session
       * from rounding, and the single best one-sidedness discriminator turns into noise.
       */
      vwapSideBufferAtr: number;
      /** How often the whole-session spine is sampled, in minutes. */
      spineIntervalMin: number;

      /** The phase machine. Every threshold here is about PERSISTENCE, not strength. */
      phase: {
        /** Minutes of session before a shape may be called Forming at all. */
        minMinutesForming: number;
        /** And before it may be Confirmed. */
        minMinutesConfirmed: number;
        /** Conviction needed to enter Forming. */
        formingScore: number;
        /** Conviction needed to enter Confirmed… */
        confirmScore: number;
        /** …and how long Forming must have held, with one direction, before it may. */
        confirmHoldMin: number;
        /** Below this a phase starts decaying toward Faded. */
        fadeScore: number;
        /**
         * How long conviction must stay under `fadeScore` before the demotion actually
         * happens. This is the anti-churn valve: without it a confirmed trend day demotes on
         * one deep breath and re-promotes ninety seconds later, and the board flickers.
         */
        fadeHoldMin: number;
        /** Extra conviction needed to climb back out of Faded, so it cannot oscillate. */
        recoverMargin: number;
        /** Minimum observed session, in minutes, before any phase is offered after a restart. */
        minObservedMin: number;
        /**
         * A hard floor on displacement, in ATR, below which NO phase is offered at any score.
         *
         * A floor rather than only a mix component, because the two failure modes are
         * different. Weighting displacement into the mix makes a dead stock score lower;
         * it does not stop a dead stock with otherwise flawless shape from out-scoring the
         * threshold anyway, which is exactly what INFY did at +0.02% on the day. Some
         * conditions are necessary rather than merely desirable, and a weighted average
         * cannot express that — only a gate can.
         */
        minDisplacementAtr: number;
      };
    };
  };

  /**
   * The timing layer. Not a scoring threshold — these decide whether a strong row is still
   * an ENTRY, which is the difference between the board describing a move and being early
   * enough to trade it.
   */
  signal: {
    enabled: boolean;
    /**
     * Whether a failed timing gate downgrades `Momentum Buy`/`Sell` to `Watch`. On by
     * default: a board that says Buy on a spent move is the failure this layer exists for.
     */
    gateTradeType: boolean;
    /** A trigger older than this is history, not a signal. */
    maxTriggerAgeMin: number;
    /** Below this the pulse is noise and no trigger is allowed to fire. */
    minPulseScore: number;
    /** A trigger with less interval volume than this is a drift, not an ignition. */
    minBurstRvol: number;
    /** How long the same trigger kind is suppressed after firing, so it fires once. */
    cooldownMin: number;
    /** No new extreme for this many minutes, with the leg intact, reads as Stalling. */
    stallMinutes: number;
    /** Past any of these the move is spent and the state is Extended. */
    extension: { atrUsedMax: number; vwapAtrMax: number; legMoveAtrMax: number };
    /** Target and stop distance from entry, in ATR. */
    targetAtr: number;
    stopAtr: number;
    /** Less headroom than this (in ATR) before the extension ceiling and there is no trade. */
    minRoomAtr: number;
    /** Whether the last minutes must agree with the day's direction. */
    requireAlignment: boolean;
    /** The option gain the plan is measured against, in percent. */
    targetOptionMovePct: number;
    /**
     * Whether failing to reach that gain REFUSES the entry rather than just costing it
     * quality. Off by default: how big the prize is and whether the entry is valid are
     * different questions, and conflating them hides good setups that happen to be modest.
     */
    requireOptionTarget: boolean;
    /** Entering an established leg on a retracement instead of at the trigger. */
    pullback: { enabled: boolean; minDepth: number; maxDepth: number };
    /** How the specific contract to buy is picked out of the chain. */
    strike: {
      /** Strikes to consider on the in-the-money side of the money. */
      itmSteps: number;
      /** And on the out-of-the-money side, where the leverage is. */
      otmSteps: number;
      /** Below this |delta| an option stops tracking the move the plan is built on. */
      minDelta: number;
      /** Contracts below this open interest are not reliably exitable. */
      minOi: number;
      /** Bid-ask above this share of the mid, in percent, is flagged on the choice. */
      maxSpreadPct: number;
      /** Hourly decay above this share of the premium, in percent, is flagged. */
      maxThetaPctPerHour: number;
    };
    /**
     * How many enrichment slots are reserved for the freshest signals rather than the
     * highest scores. Without this the option chain only ever reaches stocks that have
     * already moved — the shortlist is chosen by the same lagging number as the ranking.
     */
    enrichReservedSlots: number;

    /**
     * The trend-day override — how a confirmed one-sided day is allowed to differ.
     *
     * Every number here exists because a gate calibrated for an ordinary session gives the
     * WRONG answer on a trend day, in the same direction each time: it calls the move spent,
     * calls the volume unremarkable and calls each healthy pullback a reversal. Those are all
     * correct readings of a mean-reverting session and all three are wrong about BOSCHLTD
     * going one way for five hours.
     */
    trend: {
      enabled: boolean;
      /**
       * What the extension ceilings are multiplied by, per phase. The load-bearing setting in
       * this whole module: at 1.0 (the old behaviour) a confirmed trend day is `Extended` by
       * mid-morning and cannot be entered again all session.
       */
      budgetMultiplier: { forming: number; confirmed: number };
      /**
       * On a CONFIRMED one-sided day, stop gating on cumulative range and leg length at all.
       *
       * Scaling those ceilings was the first attempt and it does not survive contact with real
       * trend days: BOSCHLTD travelled 2.65 ATR and NHPC 2.90 ATR intraday on 2026-08-05, and
       * `legMoveAtrMax` binds even harder because on a one-sided day the leg IS the day. No
       * multiplier fixes that, because the premise is wrong — a long leg and a wide range are
       * the signature of the setup being looked for, not evidence that it is exhausted. Range
       * mean-reverts on an ordinary session, which is what the ceiling was built for, and on a
       * trend day it does not. That is the definition of a trend day.
       *
       * What still applies is DISTANCE FROM VWAP, which measures whether this particular entry
       * is a chase — a question that stays meaningful however far the day has travelled — plus
       * the trend-intact test and `minMinutesLeft` below. Turning this off restores pure
       * multiplier behaviour.
       */
      retireRangeCeilings: boolean;
      /**
       * Don't open a trend re-entry without this many minutes of session left.
       *
       * The real constraint on a continuation trade is not how far the day has come, it is how
       * long is left to hold it: a 30–90 minute leg entered at 15:05 has twenty-five minutes,
       * and the option's decay over that window is charged whether or not the move arrives.
       */
      minMinutesLeft: number;
      /**
       * Stop offering re-entries once the day's extreme is this old.
       *
       * The gate that `Trending` would otherwise swallow. `Stalling` exists to say "the leg has
       * stopped making progress", but a confirmed trend day outranks it in the state machine —
       * correctly, because a trend day pausing is not a trend day ending. What is NOT correct
       * is continuing to buy dips in something that has not made a new high for two hours: on
       * 2026-08-05 BOSCHLTD topped at 11:00 and then held 100% VWAP adherence and zero
       * crossings for the rest of the session, so every reading here stayed excellent while
       * the stock quietly distributed, and each re-entry bought a lower high.
       */
      maxMinutesSinceExtreme: number;
      /**
       * The pulse floor to apply on a trend day. A grind has no burst and little velocity —
       * that is what makes it a grind — so the ordinary 55 silences exactly the stocks this
       * layer exists to surface.
       */
      minPulseScore: { forming: number; confirmed: number };
      /** And the interval-volume floor, for the same reason. */
      minBurstRvol: number;
      /**
       * The retracement band a trend-day re-entry is taken in, measured in ATR FROM THE
       * SESSION EXTREME — not as a fraction of the zigzag leg.
       *
       * The leg is the wrong ruler here and using it was the first version's bug. A trend-day
       * dip deep enough to be worth entering is usually also deep enough to flip the zigzag,
       * at which point `pulse.pullback` starts describing the retracement's own leg and reads
       * near zero exactly when the pullback is at its most complete. Distance from the day's
       * high (or low) has no such discontinuity.
       */
      pullbackAtr: { min: number; max: number };
      /** A pullback reaching within this many ATR of VWAP also qualifies, whatever its depth. */
      vwapTouchAtr: number;
      /** How long before the same re-entry may fire again. Sized to allow 3–5 entries a day. */
      reentryCooldownMin: number;
      /** Target and stop for a trend-day continuation leg, in ATR. */
      targetAtr: number;
      stopAtr: number;
      /**
       * The delta band a trend-day contract is picked in.
       *
       * A pullback leg is a 30–90 minute hold, which is long enough that the cheapest strike's
       * decay matters and short enough that deep in-the-money is wasted capital. Ranking on
       * raw payoff — what `selectStrike` does otherwise — always walks out to the cheapest
       * contract on the sheet, and on a four-entry day that is four spreads paid for a leg
       * whose delta stopped tracking.
       */
      strike: { minDelta: number; maxDelta: number; maxThetaPctPerHour: number };
      /**
       * Whether a faded trend day is announced loudly. On by default: somebody is holding it.
       */
      warnOnFade: boolean;
    };
  };

  /** How the board's own ordering is stabilised. See `MomentumRow.stability`. */
  ranking: {
    /**
     * Half-life of the score smoothing, in minutes. The board is sorted on the smoothed
     * figure, not the raw one. At 0 the smoothing is off and the old churn returns.
     */
    smoothingHalfLifeMin: number;
    /** Weight given to conviction in the main board's ordering, 0…1. */
    convictionWeight: number;
  };

  universe: {
    /** How many rows get the expensive option-chain enrichment each cycle. */
    shortlistSize: number;
    /** Filters applied before scoring. */
    minPrice: number;
    minTurnoverCr: number;
    /** Symbols never scanned, whatever they score. */
    exclude: string[];
  };

  refresh: {
    quoteMs: number;
    enrichMs: number;
    /** IST hour at which the daily baseline rebuild runs. */
    baselineHourIst: number;
  };

  output: {
    /** Rows scoring below this are computed but not returned by GET /momentum. */
    minScore: number;
    /** Score at or above which a coherent bullish row becomes a Momentum Buy. */
    buyScore: number;
    /** Score at or above which a coherent bearish row becomes a Momentum Sell. */
    sellScore: number;
    limit: number;
  };
}

/* --------------------------------------------------------------- persisted records --- */

/** One symbol's end-of-day record. Builds the IV-rank history Upstox does not publish. */
export interface MomentumHistoryRecord {
  symbol: string;
  day: string;
  close: number;
  score: number;
  direction: Direction;
  rvol: number | null;
  atmIv: number | null;
  hv20: number | null;
  futuresOi: number | null;
}

/** A stored board, for the "last good" fallback and for intraday score history. */
export interface MomentumSnapshotRecord {
  asOf: number;
  board: MomentumBoard;
}
