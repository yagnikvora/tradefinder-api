// The shipped model.
//
// Every threshold in the pullback scanner lives here, and nothing anywhere else in the module
// contains a magic number. That is not a style preference: this is a strategy, and a strategy
// whose gates are buried in `if` statements cannot be tuned by the person who trades it,
// cannot be swept in a backtest, and cannot be explained to anyone. `PUT /pullback/config`
// edits this shape; the scanner and the backtest engine both read it.
//
// WHERE THE NUMBERS COME FROM. The ones the brief specifies are the brief's: ADX 25 to trend
// and 20 to veto, the 30/20/15/15/10/10 score split, the 0.30–0.45 and 0.45–0.60 delta bands.
// The rest are the conventional desk values for an NSE intraday chart, chosen so that the
// defaults describe a recognisable strategy rather than an unopinionated one — a scanner
// shipped with every gate wide open finds four hundred setups a day and is worth nothing.
//
// THE ATR-DENOMINATED ONES ARE THE ONES TO READ TWICE. `flatSlopeAtrPerBar: 0.035` means "the
// 9 EMA must be climbing at least 3.5% of one bar's typical range per bar". On a 5-minute
// chart that is a visible slope and not a steep one. Every distance in this module is in these
// units for the reason `ema.ts` sets out — it is the only way one threshold means the same
// thing on a ₹95 stock and a ₹39,000 one.

import type { PullbackConfig } from '../types.js';

/**
 * The four index underlyings the brief names.
 *
 * Carried as trading symbols and resolved to instrument keys at runtime through the same
 * instrument master everything else uses. Hand-mapping the keys here is what `upstox.ts` does
 * for Option Apex and it goes stale the moment NSE renames one — the master does not.
 */
export const DEFAULT_INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

export const DEFAULT_CONFIG: PullbackConfig = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedBy: 'system',

  universe: {
    indices: [...DEFAULT_INDICES],
    includeFnoStocks: true,
    // A ₹40 stock's tick is 2.5 basis points and its option chain is a formality. The floor is
    // about whether an option trade on it is expressible, not about the stock being bad.
    minPrice: 50,
    minTurnoverCr: 5,
    exclude: [],
    // The rate-limit budget, and the one number here that is about infrastructure rather than
    // about trading. One option chain per row; see `scanner.engine.ts` for the arithmetic.
    enrichLimit: 25,
  },

  timeframes: {
    computed: [1, 3, 5, 15],
    /**
     * ONE SIGNAL TIMEFRAME, and this is the setting that changed the module's results most.
     *
     * 1-minute is computed and not signalled on for the reason `types.ts` gives: every gate here is
     * measurable there and means very little. 3 and 15 were signalled on until a 45-symbol,
     * 120-session replay measured them separately, and both lose money under every configuration
     * tried — eight variants each, no sign flips:
     *
     *   3m    −0.03R a trade over 616 trades. The stops are a fifth of a percent wide, so
     *         brokerage, STT and one tick of slippage are a large fraction of R. The replay does
     *         not model those and it is STILL negative.
     *   15m   −0.20R a trade over 86. Not a bad setup — a mismatched clock. A 15-minute pullback
     *         takes about three hours to reach a 2R target, this module closes everything at the
     *         session end, and fifty-five percent of these exited there rather than at a level:
     *         six targets against sixty-seven timeouts.
     *   5m    +0.12R a trade, and +0.21R once the entry-proximity band is applied.
     *
     * Both are still COMPUTED, so both still appear on the board, still veto, and still feed the
     * alignment bonus as context. They are simply not entries. An operator who wants them back adds
     * them here, and should read `minHoldBars` first if the one being added is 15.
     */
    signal: [5],
    context: [5, 15],
    // Enough for a 20 EMA to be warm and for two swings to have confirmed. The 50 and 200 have
    // their own warmth checks — this is the floor below which the timeframe is not read at all.
    minBars: 30,
    volumeLookback: 20,
  },

  trend: {
    adxTrend: 25,
    adxVeto: 20,
    // 3.5% of one bar's ATR per bar. Below this the average is drawn flat on the chart, and
    // "price pulled back to a flat 20 EMA" is a description of a range.
    flatSlopeAtrPerBar: 0.035,
    minVolumeRatio: 1,
    deadVolumeRatio: 0.5,
    minStructureSteps: 2,
    // Ten bars spanning less than 1.6 ATR is a coil, not a trend. On a 5-minute chart that is
    // fifty minutes of the stock going nowhere.
    consolidation: { bars: 10, maxRangeAtr: 1.6 },
    // The no-man's-land. When VWAP and the 20 EMA are within a third of an ATR of each other
    // AND price is between them, there is no reference to trade against.
    noMansLandAtr: 0.33,
    // 25 bps on the underlying. Wider than that and the stock itself is telling you the tape
    // is thin, whatever its turnover says.
    maxSpreadBps: 25,
    requireEma50Stack: true,
    // Off by default, and the setting most worth understanding before turning on. A 200 EMA
    // filter is correct for continuation and wrong for the first strong trend day after a
    // multi-day decline — which is the highest-quality setup this scanner ever sees, and the
    // one this switch would refuse for the whole session.
    requireEma200Stack: false,
  },

  pullback: {
    // The zone is the EMA band widened by a fifth of an ATR either side. Price rarely touches
    // an average to the paisa, and a zone with no tolerance turns a scanner into a lottery.
    zoneToleranceAtr: 0.2,
    // The leg has to have been a leg. Under 1 ATR of separation from the band, "pullback" and
    // "noise" are the same event.
    minImpulseAtr: 1,
    minRetracement: 0.2,
    // Past ~62% the move is not retracing, it is reversing — and the stop implied by the
    // structure is now wider than the target the impulse can pay.
    maxRetracement: 0.62,
    maxBarsInZone: 8,
    // Two bars. A confirmation from twenty minutes ago on a 5-minute chart is a chart pattern,
    // not a signal — the whole value of the timestamp is that it is recent.
    maxConfirmationAgeBars: 2,
    minBodyRatio: 0.45,
    minConfirmationVolumeRatio: 1.2,
    requireEma9Reclaim: true,
    // Long enough that the same leg does not fire twice, short enough that a trend day's three
    // or four genuine pullbacks each get their own signal.
    cooldownMin: 20,
    // 30 minutes, which on a 375-minute session means nothing signals after 15:00. A pullback entry
    // is a 30-to-90-minute hold; less than half an hour of session left is not that trade.
    minMinutesLeft: 30,
    // Twelve bars of the signal timeframe: 36 minutes on a 3-minute chart, an hour on a 5, three
    // hours on a 15. Measured holds were 53 / 81 / 158 minutes, and the 15-minute figure is itself
    // truncated by the session ending on more than half of them.
    minHoldBars: 12,
    rejectionAtr: 0.5,
    // A third of the risk. Past that the published reward:risk is not the one on offer: entering
    // 0.33R late against an unchanged stop turns a 2R plan into 1.67R and the real risk into
    // 1.33R, which is the most a continuation entry can give away and still be the trade.
    maxChaseR: 0.33,
    // The entry-proximity band. Zero means "the confirmation must close clear of the zone"; one ATR
    // is as far past it as an entry can be and still be an entry rather than a chase. Both edges
    // were measured rather than chosen — see `PullbackConfig.pullback.minEntryExtensionAtr`.
    minEntryExtensionAtr: 0,
    maxEntryExtensionAtr: 0.8,
    // Half the risk back toward the stop. The turn has un-turned; what is left is a coin flip
    // with half a stop under it.
    maxGiveBackR: 0.5,
  },

  score: {
    weights: { trend: 30, volume: 20, vwap: 15, ema: 15, structure: 10, adx: 10 },
    bands: { excellent: 85, strong: 70, medium: 55 },
    minCoverage: 0.7,
    minToSignal: 55,
    alignmentBonus: 5,
    curves: {
      // ADX 20 is the veto line and scores nothing; 25 is a trend; 40+ is as good as this
      // reading gets — above ~50 ADX is usually describing a move that is about to end.
      adx: [{ at: 15, score: 0 }, { at: 20, score: 20 }, { at: 25, score: 55 }, { at: 32, score: 85 }, { at: 40, score: 100 }],
      volumeRatio: [{ at: 0.6, score: 0 }, { at: 1, score: 35 }, { at: 1.5, score: 70 }, { at: 2.5, score: 95 }, { at: 4, score: 100 }],
      // Descending on purpose. Entering AT VWAP is the whole idea; entering a long way above it is
      // a chase however good the trend looks.
      //
      // THE SCALE IS WIDER THAN IT LOOKS IT SHOULD BE, and the arithmetic is worth stating because
      // a tighter curve reads as more discerning and is in fact dead. On an intraday timeframe the
      // ATR of one bar is small — a 5-minute ATR is a few tenths of a percent — while the distance
      // between price and a session VWAP on a genuinely trending day is one to two percent. That
      // ratio is structural, not incidental: if a bar's true range is k times its net drift, then a
      // session that has trended for N bars ends roughly N/(2k) ATR from its own VWAP, which for a
      // half-session of trend is five to eight. A curve that reached zero at 3 ATR would score
      // every trending stock on the board at nought for VWAP alignment and the component would
      // stop discriminating between anything.
      vwapDistanceAtr: [
        { at: 0, score: 100 }, { at: 1, score: 90 }, { at: 2, score: 76 },
        { at: 4, score: 52 }, { at: 7, score: 24 }, { at: 12, score: 0 },
      ],
      // 9/20 separation. Zero is a crossover — the state this module exists NOT to trade.
      emaSeparationAtr: [{ at: 0, score: 0 }, { at: 0.15, score: 40 }, { at: 0.4, score: 80 }, { at: 0.8, score: 100 }],
      structureSteps: [{ at: 0, score: 0 }, { at: 1, score: 30 }, { at: 2, score: 65 }, { at: 3, score: 90 }, { at: 4, score: 100 }],
    },
  },

  risk: {
    atrStopMultiple: 1.2,
    stopBufferAtr: 0.15,
    /**
     * The floor on a structural stop. 0.6 ATR — a bit over half a bar's typical range.
     *
     * Anything tighter is inside the noise of the bar it was drawn from, and it silently inflates
     * every R on the row because risk is the denominator. See `PullbackConfig.risk.minStopAtr` for
     * the live rows that produced it.
     */
    minStopAtr: 0.6,
    /**
     * The ceiling on a STRUCTURAL stop, past which the ATR stop is substituted.
     *
     * 3.5, not the 2.5 this shipped with, and the correction came from live rows. A pullback on a
     * short timeframe routinely puts its low 3 to 4 ATR below the confirmation close — on BHEL at
     * ₹412 the swing stop was 3.42 ATR away and 0.51% away, which is an ordinary intraday stop —
     * while the substituted ATR stop was 0.18%, or 74 paise. At 2.5 the ceiling therefore fired on
     * almost every 3-minute setup and replaced a stop that meant something with one sitting inside
     * the pullback's own range, which is precisely the failure the structural stop exists to avoid.
     * The ceiling is meant to catch the absurd, not the ordinary.
     */
    maxStopAtr: 3.5,
    /**
     * The ATR target, and the number the reward:risk gate is really calibrated by.
     *
     * It stands for "what this instrument typically travels from here over the expected hold". A
     * pullback entry is a 30-to-90-minute position, which on the signal timeframe is ten to thirty
     * bars, and 2 ATR understates that badly enough to refuse setups with real room.
     */
    atrTargetMultiple: 3,
    primaryTarget: '2R',
    minRewardRisk: 1.5,
    trailAtrMultiple: 2,
    trailEma: 20,
  },

  option: {
    // The brief's bands, and they are the right shape: a pullback entry is a directional bet
    // with a defined stop and a one-to-two-hour hold, which is exactly where 0.30–0.45 pays
    // for itself. Joining an already-running trend is a worse entry with a longer hold, so it
    // buys delta instead of leverage.
    pullbackDelta: { min: 0.3, max: 0.45 },
    holdingDelta: { min: 0.45, max: 0.6 },
    itmSteps: 2,
    otmSteps: 4,
    minOi: 1000,
    minVolume: 100,
    maxSpreadPct: 3,
    maxThetaPctPerHour: 4,
    minLiquidityScore: 45,
    // On by default. The brief lists "very low option liquidity" among the conditions that must
    // suppress a signal, and it is right to: this scanner's output is an option order, and a
    // contract quoted 4.00 × 5.20 turns a 2R plan into a 1.2R one before the stock moves.
    vetoSignalOnIlliquidOption: true,
    liquidityMix: { spread: 0.4, openInterest: 0.25, volume: 0.2, depth: 0.15 },
    curves: {
      spreadPct: [{ at: 0.3, score: 100 }, { at: 1, score: 80 }, { at: 2, score: 55 }, { at: 4, score: 20 }, { at: 8, score: 0 }],
      oi: [{ at: 0, score: 0 }, { at: 1000, score: 30 }, { at: 10000, score: 70 }, { at: 50000, score: 95 }, { at: 200000, score: 100 }],
      volume: [{ at: 0, score: 0 }, { at: 100, score: 25 }, { at: 2000, score: 65 }, { at: 20000, score: 95 }, { at: 100000, score: 100 }],
      depthLots: [{ at: 0, score: 0 }, { at: 2, score: 35 }, { at: 10, score: 75 }, { at: 40, score: 100 }],
    },
  },

  alerts: {
    enabled: true,
    kinds: ['freshPullback', 'trendResume', 'emaRejection', 'targetHit', 'stopHit'],
    keep: 300,
    dedupeMin: 10,
    webhookUrl: '',
    // Confirmed entries only, Strong or better. `freshPullback` is the more USEFUL alert to watch
    // on screen — it is earlier — but it fires before the confirmation candle and a fair share of
    // them fail, which is the wrong trade for something that interrupts you. `trendResume` means
    // the turn actually printed on volume.
    push: {
      enabled: true,
      kinds: ['trendResume'],
      minBand: 'Strong',
      // The second gate, and the one that reads the DAY rather than the setup.
      //
      // A pullback entry is a bet that an interrupted move resumes. Whether it does depends
      // mostly on something this scanner cannot see from its own bars: if the session has been
      // one-sided since the open, the retracement is the day pausing; if price has crossed VWAP
      // nine times, the identical structure is chop, and the confirmation candle is the ninth
      // crossing rather than a resumption. The two produce the same score here and opposite
      // outcomes — which is the failure this gate exists for.
      //
      // `Confirmed` rather than `Forming`, because Forming is a claim that has not survived a
      // test yet: promotion needs twenty minutes of sustained one-sidedness, and the alert is
      // worth waiting for that. Direction has to agree, or the entry is being taken into the
      // session rather than with it.
      //
      // Unknown is allowed through on purpose — see `allowWhenUnknown` — so that turning the
      // momentum scheduler off degrades the alerts to their old behaviour rather than silencing
      // them. The message says when a push arrived that way.
      trend: {
        mode: 'require',
        minPhase: 'Confirmed',
        sameDirection: true,
        minScore: 0,
        allowWhenUnknown: true,
        maxBoardAgeSec: 120,
      },
    },
  },

  refresh: {
    // 30 seconds. The scanner's resolution is the poll's resolution, and the shortest signal
    // timeframe is 3 minutes — six polls a bar, which is enough to see a bar close promptly
    // without spending budget confirming that nothing changed.
    scanMs: 30_000,
    enrichMs: 60_000,
    resyncMs: 120_000,
    seedHourIst: 8,
  },

  output: {
    limit: 100,
    minTrendStrength: 0,
  },
};

/** A fresh, mutable copy. Callers patch what they get, so they must not share the constant. */
export const defaultConfig = (): PullbackConfig => structuredClone(DEFAULT_CONFIG);
