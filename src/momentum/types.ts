// Momentum Scanner — the domain model.
//
// One rule runs through every type here: a number this app cannot MEASURE is `null`, never
// a stand-in. A momentum score is read as a trading signal, so a fabricated component is
// worse than a missing one — an absent factor is visible in the UI and drops out of the
// weighting, where an invented one silently moves the ranking. `available: false` plus a
// `note` saying why is the shape that carries that through the whole pipeline.

/** The eleven factors the score is built from. Order is the order the UI lists them. */
export type FactorKey =
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
  'rvol', 'liquidity', 'relativeStrength', 'vwap', 'optionFlow', 'greeks',
  'impliedVolatility', 'atrExpansion', 'sectorStrength', 'marketBreadth', 'trendStructure',
];

export const FACTOR_LABEL: Record<FactorKey, string> = {
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
export type TradeType = 'Momentum Buy' | 'Momentum Sell' | 'Avoid';
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
