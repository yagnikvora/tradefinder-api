// Momentum Scanner — the domain model.
//
// One rule runs through every type here: a number this app cannot MEASURE is `null`, never
// a stand-in. A momentum score is read as a trading signal, so a fabricated component is
// worse than a missing one — an absent factor is visible in the UI and drops out of the
// weighting, where an invented one silently moves the ranking. `available: false` plus a
// `note` saying why is the shape that carries that through the whole pipeline.

/** The twelve factors the score is built from. Order is the order the UI lists them. */
export type FactorKey =
  | 'momentumPulse'
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
  'momentumPulse', 'rvol', 'liquidity', 'relativeStrength', 'vwap', 'optionFlow', 'greeks',
  'impliedVolatility', 'atrExpansion', 'sectorStrength', 'marketBreadth', 'trendStructure',
];

export const FACTOR_LABEL: Record<FactorKey, string> = {
  momentumPulse: 'Momentum Pulse (last minutes)',
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

/* ------------------------------------------------------------------ timing layer --- */

/**
 * Where the stock is in its move RIGHT NOW, as opposed to how strong the day has been.
 *
 *   Igniting   the move is starting. A trigger fired within the last few minutes, volume is
 *              bursting against its own per-minute norm, and the range travelled so far is
 *              still small against ATR. This is the only state where a fresh option entry
 *              has the whole leg in front of it.
 *   Extending  the leg is real but no longer new. Entry is a pullback, not a chase.
 *   Extended   the move is largely spent — most of a day's ATR travelled, price far from
 *              VWAP. The score will be at its highest here and the trade is at its worst.
 *   Stalling   the leg is intact but has stopped making new extremes and volume has faded.
 *   Reversing  the last minutes point against the day's direction. A held position is wrong
 *              before the score notices.
 *   Quiet      nothing is happening on this timescale.
 */
export type SignalState = 'Igniting' | 'Extending' | 'Extended' | 'Stalling' | 'Reversing' | 'Quiet';

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
 */
export type TriggerKind =
  | 'baseBreak' | 'vwapReclaim' | 'vwapLoss' | 'orbBreak' | 'dayExtreme' | 'priorRange' | 'thrust';

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
 * already makes. No reading here looks further back than `pulse.slowWindowMin`.
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

/** How much of the day's normal movement is already used up. */
export interface Extension {
  /** Today's true range ÷ ATR. Above ~0.8 the day has already done its work. */
  atrUsed: number | null;
  /** |price − VWAP| ÷ ATR. How stretched from the day's mean the entry would be. */
  vwapAtr: number | null;
  /** The current leg's size ÷ ATR. */
  legMoveAtr: number | null;
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
      /** The comparison window behind it, for acceleration and efficiency. */
      slowWindowMin: number;
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
