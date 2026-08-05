// The shipped momentum model — every weight, threshold and curve in one place.
//
// Nothing in this module branches on a literal. A threshold is a KNOT LIST: "an RVOL of 3.5
// scores 88, an RVOL of 6 scores 100, interpolate between". That is what makes the model
// editable from the admin panel rather than from a deploy — an analyst who wants "excellent"
// to start at 4x moves one number and the ranking changes, with no code path to re-test.
//
// The defaults below are the brief's own numbers where the brief gave them (RVOL 3.5 /
// 2.0 / 1.5, and the eleven weights), and conventional desk values elsewhere. They are a
// starting point to calibrate against your own fills, not a claim about what works.

import type { MomentumConfig } from '../types.js';

/**
 * Weights, totalling 100.
 *
 * The brief's original eleven were 20/15/10/10/10/10/5/5/5/5/5, and every one of them
 * measures the session CUMULATIVELY. That is why the board's best scores arrived after the
 * move: relative volume needs the volume to have traded, relative strength needs the change
 * to have happened, ATR expansion needs the range to have formed. A model built entirely
 * from those is a description of the last four hours, and an option bought on it pays for a
 * move that is already in the premium.
 *
 * `momentumPulse` is the correction, and it takes the largest single weight because it is
 * the only factor that measures the last few MINUTES. The cumulative factors were trimmed to
 * pay for it — relative volume most of all, since the pulse's interval burst does the same
 * job on the timescale that matters for an entry.
 *
 * `trendQuality` is the SECOND correction, and it addresses the opposite blind spot. The pulse
 * fixed "the board ranks finished moves highest"; it did nothing for "the board cannot see a
 * stock that has been walking one direction for five hours", because a grind produces no burst
 * and no velocity and therefore scores the pulse around 35. Between them the two cover the
 * only timescales an intraday option buyer trades on: the next few minutes, and the rest of
 * the day. It is weighted level with the pulse because on the stocks this scanner exists to
 * find, it is the more reliable of the two — a one-sidedness measured over four hours is a
 * far stronger statement than a velocity measured over three minutes, and it does not decay
 * between polls.
 *
 * The weight came out of `rvol` and `liquidity`. Relative volume was already double-counted
 * against the pulse's interval burst, and liquidity at 12 was doing more ranking work than a
 * gate deserves — it is a floor in `tradeTypeFrom` regardless of what it scores.
 */
export const DEFAULT_CONFIG: MomentumConfig = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'system:default',

  weights: {
    momentumPulse: 16,
    trendQuality: 16,
    rvol: 11,
    liquidity: 9,
    relativeStrength: 7,
    vwap: 9,
    optionFlow: 8,
    greeks: 8,
    impliedVolatility: 4,
    atrExpansion: 3,
    sectorStrength: 3,
    marketBreadth: 3,
    trendStructure: 3,
  },

  scoring: {
    maxScore: 100,
    // 0.25 means a perfectly split directional vote costs a quarter of the score. A stock
    // with 5x volume, price under a falling VWAP and long unwinding is loud, not strong;
    // without this it would rank alongside a clean breakout.
    coherence: { enabled: true, maxPenalty: 0.25 },
    directionDeadband: 0.12,
    minCoverage: 0.35,
  },

  confidence: {
    high: 0.85,
    medium: 0.6,
    // A thin book invalidates the rest of the read: you cannot get the size on that the
    // score implies, so it is never High however the factors line up.
    minLiquidityForHigh: 55,
  },

  thresholds: {
    // --- 1. Relative volume ------------------------------------------------------------
    // The brief's bands: >3.5 excellent, 2–3.5 good, <1.5 poor. Below 1.0 a stock is
    // trading UNDER its own norm, which is the opposite of a momentum candidate, so the
    // curve starts at zero rather than at some polite floor.
    rvol: {
      knots: [
        { at: 0.5, score: 0 },
        { at: 1.0, score: 15 },
        { at: 1.5, score: 35 },
        { at: 2.0, score: 60 },
        { at: 3.5, score: 88 },
        { at: 6.0, score: 100 },
      ],
      excellent: 3.5,
      good: 2.0,
      average: 1.5,
    },

    // --- 2. Liquidity ------------------------------------------------------------------
    // Four sub-scores, mixed. Spread and depth come off the live order book and are
    // therefore empty outside market hours; the mix reweights around whatever is present
    // rather than scoring a closed book as illiquid.
    liquidity: {
      mix: { averageDailyValue: 0.35, spread: 0.25, depth: 0.2, optionValue: 0.2 },
      averageDailyValueCr: [
        { at: 5, score: 0 },
        { at: 25, score: 30 },
        { at: 100, score: 60 },
        { at: 400, score: 85 },
        { at: 1500, score: 100 },
      ],
      // Basis points of the mid. Descending: tighter is better.
      spreadBps: [
        { at: 1, score: 100 },
        { at: 3, score: 85 },
        { at: 8, score: 60 },
        { at: 20, score: 30 },
        { at: 50, score: 0 },
      ],
      // ₹ crore resting in the top five levels, both sides.
      depthCr: [
        { at: 0.05, score: 0 },
        { at: 0.25, score: 40 },
        { at: 1, score: 70 },
        { at: 5, score: 95 },
        { at: 20, score: 100 },
      ],
      // ₹ crore of option premium traded today across the near-month chain.
      optionValueCr: [
        { at: 0.5, score: 0 },
        { at: 5, score: 35 },
        { at: 25, score: 65 },
        { at: 100, score: 90 },
        { at: 400, score: 100 },
      ],
      grade: { excellent: 80, good: 60, average: 40 },
    },

    // --- 3. Relative strength ----------------------------------------------------------
    // Stock return minus index return, in percentage points. 2.5pp of outperformance in a
    // session is a full-scale reading; beta-adjusting is on by default because a high-beta
    // name outrunning the index on a strong day is the index, not the stock.
    relativeStrength: {
      knots: [
        { at: 0, score: 0 },
        { at: 0.4, score: 20 },
        { at: 1.0, score: 50 },
        { at: 2.0, score: 80 },
        { at: 3.5, score: 100 },
      ],
      fullScalePct: 2.5,
      useBeta: true,
    },

    // --- 4. VWAP -----------------------------------------------------------------------
    // Distance from VWAP and the slope of VWAP itself. Slope matters more than it looks:
    // price 1% over a FALLING VWAP is a fade, price 0.3% over a rising one is a trend.
    vwap: {
      mix: { distance: 0.6, slope: 0.4 },
      distancePct: [
        { at: 0, score: 0 },
        { at: 0.15, score: 25 },
        { at: 0.5, score: 60 },
        { at: 1.2, score: 90 },
        { at: 2.5, score: 100 },
      ],
      // Percent per minute. VWAP is a cumulative average, so it moves slowly by design —
      // 0.02%/min sustained is a decisive drift.
      slopePctPerMin: [
        { at: 0, score: 0 },
        { at: 0.004, score: 30 },
        { at: 0.012, score: 65 },
        { at: 0.03, score: 90 },
        { at: 0.06, score: 100 },
      ],
      fullScaleDistPct: 1.2,
      fullScaleSlope: 0.02,
    },

    // --- 5. Option chain / OI build-up -------------------------------------------------
    // Futures open interest is the primary read because price-plus-OI on the future is the
    // textbook build-up definition and Upstox serves per-candle OI on it. The option chain
    // adds the call/put skew.
    optionFlow: {
      mix: { futuresOi: 0.6, optionOi: 0.4 },
      futuresOiChangePct: [
        { at: 0, score: 0 },
        { at: 1, score: 25 },
        { at: 3, score: 55 },
        { at: 7, score: 85 },
        { at: 15, score: 100 },
      ],
      // (put OI change − call OI change) as a % of total chain OI.
      optionOiSkewPct: [
        { at: 0, score: 0 },
        { at: 1, score: 30 },
        { at: 3, score: 65 },
        { at: 8, score: 90 },
        { at: 15, score: 100 },
      ],
      fullScaleOiPct: 7,
      // Covering and unwinding are positions being closed, not opened — real, but a weaker
      // statement about intent than fresh money, so they read at 0.6 of a build-up.
      buildUpBias: {
        'Long Build-up': 1,
        'Short Build-up': -1,
        'Short Covering': 0.6,
        'Long Unwinding': -0.6,
        Neutral: 0,
      },
    },

    // --- 6. Greeks ---------------------------------------------------------------------
    // Tradability of the option leg, which is what the brief's three asks amount to:
    // delta that is moving with the stock, gamma that keeps it moving, theta that isn't
    // eating the position while it works.
    greeks: {
      mix: { delta: 0.4, gamma: 0.35, theta: 0.25 },
      // |Δdelta| over the session, from gamma × the move. 0.15 is a meaningful re-rating.
      deltaShift: [
        { at: 0, score: 0 },
        { at: 0.03, score: 25 },
        { at: 0.08, score: 55 },
        { at: 0.18, score: 85 },
        { at: 0.35, score: 100 },
      ],
      // Gamma expressed as the delta gained per 1% move in the underlying.
      gammaNotional: [
        { at: 0, score: 0 },
        { at: 0.02, score: 30 },
        { at: 0.05, score: 60 },
        { at: 0.12, score: 90 },
        { at: 0.25, score: 100 },
      ],
      // Daily theta as a percentage of the ATM straddle premium. Descending — less is more.
      thetaBurnPct: [
        { at: 0.5, score: 100 },
        { at: 1.5, score: 80 },
        { at: 3, score: 55 },
        { at: 6, score: 25 },
        { at: 12, score: 0 },
      ],
    },

    // --- 7. Implied volatility ---------------------------------------------------------
    // Healthy, not extreme. IV in the floor means nobody expects a move; IV at the ceiling
    // means the move is already paid for and every option entry starts behind.
    impliedVolatility: {
      rank: [
        { at: 0, score: 20 },
        { at: 20, score: 60 },
        { at: 40, score: 95 },
        { at: 60, score: 100 },
        { at: 80, score: 65 },
        { at: 100, score: 25 },
      ],
      // IV ÷ 20-day realised volatility. Around 1.0–1.3 is normal; 2.0 is an event premium.
      premium: [
        { at: 0.6, score: 40 },
        { at: 0.9, score: 85 },
        { at: 1.2, score: 100 },
        { at: 1.8, score: 60 },
        { at: 3.0, score: 20 },
      ],
      minSessionsForIvRank: 20,
    },

    // --- 8. ATR expansion --------------------------------------------------------------
    atrExpansion: {
      knots: [
        { at: 0.6, score: 0 },
        { at: 1.0, score: 30 },
        { at: 1.4, score: 65 },
        { at: 2.0, score: 90 },
        { at: 3.5, score: 100 },
      ],
      period: 14,
    },

    // --- 9. Sector strength ------------------------------------------------------------
    sectorStrength: {
      knots: [
        { at: 0, score: 0 },
        { at: 0.3, score: 30 },
        { at: 0.8, score: 65 },
        { at: 1.6, score: 90 },
        { at: 3.0, score: 100 },
      ],
      fullScalePct: 1.5,
    },

    // --- 10. Market breadth ------------------------------------------------------------
    marketBreadth: {
      knots: [
        { at: 0, score: 0 },
        { at: 0.15, score: 35 },
        { at: 0.35, score: 70 },
        { at: 0.6, score: 95 },
        { at: 0.85, score: 100 },
      ],
      // A stock fighting the tape keeps 35% of the breadth score. Not zero — the strongest
      // momentum names do lead a turn — but it should not rank alongside one going with it.
      counterTrendFactor: 0.35,
    },

    // --- 11. Trend structure -----------------------------------------------------------
    trendStructure: {
      lookbackSessions: 20,
      openingRangeMinutes: 15,
      points: { higherHigh: 25, higherLow: 20, breakout: 30, openingRangeBreak: 15, aboveOpen: 10 },
    },

    // Institutional-activity label. Not a scored factor — a separate read on whether the
    // size behind the move looks like a desk or a crowd.
    institutional: {
      rvolWeight: 0.35,
      turnoverWeight: 0.25,
      optionWeight: 0.2,
      oiWeight: 0.2,
      high: 70,
      medium: 45,
    },

    // --- 12. Momentum pulse ------------------------------------------------------------
    // The only factor measured over minutes rather than over the session.
    //
    // Three windows. THREE MINUTES is the ignition read — long enough that one bad print
    // does not make a signal, short enough that a stock which started moving at 11:04 is on
    // the board at 11:07 rather than at 11:40. TEN gives it something to be compared
    // against, so a move that is decelerating can be told from one that is building.
    // FIFTEEN is where a pre-breakout base is looked for.
    //
    // Velocity is scored in ATR-per-minute rather than in percent, because 0.4% in three
    // minutes is a violent move in HDFCBANK and a rounding error in a 4%-ATR midcap, and a
    // percent threshold would fill the board with the same dozen high-beta names every day.
    pulse: {
      fastWindowMin: 3,
      slowWindowMin: 10,
      baseWindowMin: 15,
      minReadings: 3,
      // Burst leads: an ignition without volume behind it is a drift that will retrace, and
      // it is the reading that turns positive earliest.
      mix: { burst: 0.4, velocity: 0.4, efficiency: 0.2 },
      // Interval volume against the same interval's own norm. 3x in three minutes is a stock
      // that something has just happened to.
      burstRvol: [
        { at: 0.8, score: 0 },
        { at: 1.5, score: 30 },
        { at: 2.5, score: 60 },
        { at: 4.0, score: 85 },
        { at: 8.0, score: 100 },
      ],
      // Fraction of one full day's ATR travelled per minute. 0.02 sustained over three
      // minutes is 6% of a day's range — a real leg starting.
      velocityAtrPerMin: [
        { at: 0.002, score: 0 },
        { at: 0.008, score: 35 },
        { at: 0.02, score: 70 },
        { at: 0.045, score: 92 },
        { at: 0.09, score: 100 },
      ],
      // Directional persistence. This is the "one-directional" reading: 0.8 means eight of
      // every ten rupees of movement went the same way, which is what a tradable leg looks
      // like and what chop does not.
      efficiency: [
        { at: 0.2, score: 0 },
        { at: 0.45, score: 35 },
        { at: 0.65, score: 70 },
        { at: 0.85, score: 95 },
        { at: 1.0, score: 100 },
      ],
      legReversalAtr: 0.3,
      legReversalPctFloor: 0.35,
      compressionAtr: 0.28,
      // 8% of an ATR clear of the edge. Small enough to still be early, large enough that a
      // stock ticking sideways in a two-paise range is not breaking out of it every reading.
      breakBufferAtr: 0.08,
      fullScaleVelocityAtr: 0.02,
    },

    // --- 13. Trend quality / one-sidedness ---------------------------------------------
    // The session-scale read. See conviction.service.ts for why none of the other twelve
    // factors could answer "has this gone one way all day".
    conviction: {
      enabled: true,
      // Displacement carries the joint-largest share with adherence, because it is the only
      // one of the eight that is NECESSARY. The other seven describe how a stock got where it
      // went; without this one they happily describe a stock that went nowhere, and did — INFY
      // finished 2026-08-05 at +0.02% and scored 98 before this existed.
      mix: {
        displacement: 0.18,
        adherence: 0.17,
        crossings: 0.14,
        efficiency: 0.14,
        rangePosition: 0.11,
        pullback: 0.11,
        slope: 0.08,
        structure: 0.07,
      },

      // Net move from the open in ATR, signed with the trend. Zero-scored below 0.25 ATR: a
      // stock that has not moved a quarter of its own daily range is not trending, it is
      // open. Full scale at 1.6, which on a 2% ATR name is a 3.2% session.
      displacementAtr: [
        { at: 0.15, score: 0 },
        { at: 0.35, score: 25 },
        { at: 0.70, score: 60 },
        { at: 1.10, score: 85 },
        { at: 1.60, score: 100 },
      ],

      // Share of the session on one side of VWAP. Starts at 0.5 because that is the floor of
      // the measurement — a perfectly balanced day cannot read below it — so a curve starting
      // at 0 would give every stock on the board a free 40 points.
      adherence: [
        { at: 0.50, score: 0 },
        { at: 0.70, score: 25 },
        { at: 0.85, score: 60 },
        { at: 0.93, score: 85 },
        { at: 1.00, score: 100 },
      ],

      // Crossings, descending. The most discriminating curve in the file: two crossings in a
      // session is a trend that took one real breath, eight is a stock being fought over.
      crossings: [
        { at: 0, score: 100 },
        { at: 2, score: 82 },
        { at: 4, score: 55 },
        { at: 8, score: 22 },
        { at: 15, score: 0 },
      ],

      // Session efficiency. NOT the same scale as the pulse's three-minute efficiency: six
      // hours of 15-second sampling accumulates far more path, so 0.45 here is an exceptional
      // trend day where 0.45 over three minutes is unremarkable. Calibrating this against the
      // pulse curve is the most likely way to get this factor wrong.
      efficiency: [
        { at: 0.05, score: 0 },
        { at: 0.15, score: 30 },
        { at: 0.30, score: 65 },
        { at: 0.45, score: 88 },
        { at: 0.65, score: 100 },
      ],

      // Position in the day's range, oriented to the trend. A trend day closes near its
      // extreme; 0.5 is the middle of the range and says nothing either way.
      rangePosition: [
        { at: 0.30, score: 0 },
        { at: 0.50, score: 20 },
        { at: 0.70, score: 50 },
        { at: 0.85, score: 82 },
        { at: 0.95, score: 100 },
      ],

      // Deepest counter-trend excursion of the day, in ATR. Descending. Past ~0.8 ATR the
      // "trend" contained a move large enough that nobody was still holding through it.
      deepestPullbackAtr: [
        { at: 0.10, score: 100 },
        { at: 0.25, score: 85 },
        { at: 0.45, score: 58 },
        { at: 0.75, score: 28 },
        { at: 1.20, score: 0 },
      ],

      // Session VWAP slope, %/min, signed with the trend. VWAP is a cumulative average over
      // the whole session, so it moves an order of magnitude slower than price — 0.01%/min
      // sustained for four hours is a 2.4% drift in the average price paid, which is a lot.
      slopePctPerMin: [
        { at: -0.005, score: 0 },
        { at: 0, score: 20 },
        { at: 0.004, score: 50 },
        { at: 0.012, score: 82 },
        { at: 0.030, score: 100 },
      ],

      // Consecutive higher lows / lower highs across segments of the session.
      structure: [
        { at: 0, score: 0 },
        { at: 1, score: 35 },
        { at: 2, score: 60 },
        { at: 4, score: 88 },
        { at: 6, score: 100 },
      ],

      // 5% of an ATR. Below this price is AT its VWAP rather than on a side of it, and
      // counting those ticks as a side is what turns the crossing count into noise.
      vwapSideBufferAtr: 0.05,
      spineIntervalMin: 5,

      // The persistence machine. These are the numbers that decide whether the board is
      // stable, and they are about TIME, not strength.
      phase: {
        // 09:45. Half an hour is the least that can distinguish a trend from an opening drive,
        // and an opening drive that reverses at 09:50 is the most common shape on the tape.
        minMinutesForming: 30,
        // 10:30. By the second hour a genuine trend day has survived the first real test.
        minMinutesConfirmed: 75,
        formingScore: 55,
        confirmScore: 70,
        // Twenty minutes of sustained Forming before promotion. Without a hold requirement,
        // "confirmed" would mean nothing more than "crossed 70 once", which any stock does on
        // the way through.
        confirmHoldMin: 20,
        fadeScore: 50,
        // Ten minutes below the fade line before demotion. This is the anti-churn valve: a
        // confirmed trend day taking one deep breath is the most ordinary thing that happens
        // on a trend day, and demoting on it would fire the fade warning at the exact moment
        // the pullback entry is setting up.
        fadeHoldMin: 10,
        recoverMargin: 8,
        // A restart must observe this much of the session itself before making any claim.
        minObservedMin: 25,
        // Half an ATR of net displacement before any phase is offered, at any score. On the
        // 2026-08-05 sample this is what separates BOSCHLTD (+3.68%, 2.0 ATR), NHPC (−4.50%)
        // and SONACOMS (+3.53%) from INFY (+0.02%), ITC (−0.23%) and MARUTI (−0.26%), all
        // three of which were reaching Confirmed on shape alone.
        minDisplacementAtr: 0.5,
      },
    },
  },

  // The timing layer. See types.ts for what each state means.
  signal: {
    enabled: true,
    gateTradeType: true,
    // Twelve minutes is roughly how long a first leg runs in an F&O name before it either
    // extends into a trend or gives back. Past it, an entry at the trigger price is no
    // longer available and the trade being taken is a different one from the one signalled.
    maxTriggerAgeMin: 12,
    minPulseScore: 55,
    minBurstRvol: 1.6,
    cooldownMin: 15,
    stallMinutes: 8,
    // Past any of these, the day's move is mostly behind rather than ahead. `atrUsedMax` is
    // the important one: a stock that has already covered 80% of a normal day's range needs
    // an ABNORMAL day to pay a further leg, and that is a bet on the tail, not on momentum.
    extension: { atrUsedMax: 0.8, vwapAtrMax: 1.4, legMoveAtrMax: 0.65 },
    targetAtr: 0.45,
    stopAtr: 0.28,
    minRoomAtr: 0.25,
    requireAlignment: true,
    // The gain the plan is measured against. Raising it does not make trades better — it
    // makes the plan honest about how few setups can pay it. Reported, not enforced, unless
    // `requireOptionTarget` is turned on.
    targetOptionMovePct: 35,
    requireOptionTarget: false,
    pullback: { enabled: true, minDepth: 0.2, maxDepth: 0.55 },
    // Which contract to buy. One strike in, three out: in-the-money is carried because on a
    // late-in-the-day setup with little room left it is sometimes the only leg whose delta
    // still tracks, and three out is where the leverage stops being worth the book.
    //
    // `minDelta` is the load-bearing number. Ranking on payoff alone always walks out to the
    // cheapest strike, because a small enough premium makes any move look like a large
    // percentage. At 0.25 the option still moves with the stock; below it the position is a
    // bet on the tail rather than on the leg being signalled.
    strike: {
      itmSteps: 1,
      otmSteps: 3,
      minDelta: 0.25,
      minOi: 1000,
      maxSpreadPct: 3,
      maxThetaPctPerHour: 3,
    },
    enrichReservedSlots: 12,

    // The trend-day override. Every number here exists because a gate calibrated for an
    // ordinary session gives the wrong answer on a one-sided one, always in the same
    // direction: it calls the move spent, calls the volume unremarkable, and calls each
    // healthy pullback a reversal.
    trend: {
      enabled: true,
      // THE LOAD-BEARING SETTING. At 1.0 — the old, implicit behaviour — a confirmed trend day
      // trips `atrUsedMax` around mid-morning and can never be entered again. 2.6 is roughly
      // the 90th percentile of true-range expansion on NSE F&O trend days: enough that a
      // stock walking one way all afternoon is still tradable, not so much that a genuinely
      // exhausted move is waved through. Forming days get less because they have earned less.
      budgetMultiplier: { forming: 1.6, confirmed: 2.6 },
      // On a confirmed day the range and leg ceilings are retired outright rather than merely
      // widened — see types.ts. Measured against 2026-08-05: BOSCHLTD ran 2.65 ATR intraday
      // and NHPC 2.90, so no multiplier anyone would set as a default rescues them, and the
      // leg ceiling binds sooner still because on a one-sided day the leg is the whole day.
      retireRangeCeilings: true,
      // Forty minutes. A trend-day leg is a 30–90 minute hold, so an entry with less than this
      // left is buying decay and hoping — and the last half hour is where a one-sided day is
      // most likely to be unwound by people flattening rather than extended.
      minMinutesLeft: 40,
      // Forty-five minutes without a new session extreme and the trend day has stopped paying.
      // Measured on 2026-08-05: BOSCHLTD topped at 11:00 and every re-entry after ~12:00 was
      // bought into distribution while adherence and crossings still read perfect.
      maxMinutesSinceExtreme: 45,
      // A grind has no burst and little velocity — that is what makes it a grind. The ordinary
      // 55 silences exactly the stocks this layer exists to surface, so a confirmed day is
      // held to a floor that a steady one-directional drift can actually clear.
      minPulseScore: { forming: 45, confirmed: 32 },
      minBurstRvol: 0.9,
      // Measured in ATR back from the day's high (or low), not as a fraction of the zigzag
      // leg — see types.ts for why the leg is the wrong ruler. A dip of 0.15–0.55 ATR off the
      // session extreme is the shape of a trend-day breather; past 0.55 the trend is ending
      // rather than resting.
      pullbackAtr: { min: 0.15, max: 0.55 },
      // Price coming within a quarter ATR of VWAP qualifies whatever the leg depth says —
      // on a trend day VWAP is the level that actually gets bought, and the zigzag's idea of
      // a leg is often much shorter than the move a trader is sitting in.
      vwapTouchAtr: 0.25,
      // Twenty-five minutes. Sized so three to five re-entries a session are possible — which
      // is what a trend day actually offers — without the same pullback firing twice.
      reentryCooldownMin: 25,
      // A continuation leg is worth more than an ignition scalp, and the stop can be wider
      // because the trend structure, not a tick, is what invalidates it.
      targetAtr: 0.55,
      stopAtr: 0.32,
      // The delta band for a 30–90 minute hold. Ranking on raw payoff — what the strike
      // picker does otherwise — always walks out to the cheapest contract on the sheet, and
      // over four entries in a day that is four spreads paid for a leg whose delta stopped
      // tracking the stock the plan was built on.
      strike: { minDelta: 0.30, maxDelta: 0.50, maxThetaPctPerHour: 4 },
      warnOnFade: true,
    },
  },

  // How the board's own ordering is stabilised.
  ranking: {
    // Three minutes. The board was sorted on a score recomputed every fifteen seconds with an
    // 18-weight three-minute factor inside it, so rows moved dozens of places on a wobble and
    // the list could not be read at all — which is the "stocks keep changing position"
    // complaint. Smoothing the sort key costs a little responsiveness at the very top and buys
    // a list that stays still long enough to act on.
    smoothingHalfLifeMin: 3,
    // How much conviction pulls on the MAIN board's ordering. Deliberately modest: the main
    // board is still the ignition board, and the dedicated trend view ranks on conviction
    // outright. Set to 0 to keep the main list purely score-ordered.
    convictionWeight: 0.25,
  },

  universe: {
    // 40 chain calls a minute is ~1200 per 30 minutes against Upstox's 2000/30min ceiling
    // for that endpoint. Raising this raises the bill linearly — see scheduler.ts.
    shortlistSize: 40,
    minPrice: 20,
    minTurnoverCr: 5,
    exclude: [],
  },

  refresh: {
    // 15 seconds, not 30. The timing layer's resolution is its poll interval: a three-minute
    // ignition window sampled every 30s is six readings, and the trigger that fires on the
    // third of them is already 90 seconds late before the board is even built.
    //
    // The budget takes it. Three quote calls per cycle at 15s is 360 requests per 30
    // minutes against Upstox's 2000 ceiling for that endpoint — 18%, up from 9%. The option
    // chain is untouched: enrichment has its own 60s TTL, so chains are still fetched once a
    // minute however often the quotes are polled.
    quoteMs: 15_000,
    enrichMs: 60_000,
    baselineHourIst: 8,
  },

  output: {
    minScore: 0,
    buyScore: 65,
    sellScore: 65,
    limit: 100,
  },
};

/** A deep copy, so a caller mutating what it got cannot edit the shipped defaults. */
export const defaultConfig = (): MomentumConfig => structuredClone(DEFAULT_CONFIG);
