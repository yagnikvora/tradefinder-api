// The engine. Two stages, because the rate limit only allows two stages.
//
// Upstox allows 2000 requests per 30 minutes PER API PER USER. Scoring 208 F&O stocks on
// every factor every 30 seconds would need 208 option-chain calls per cycle — 12,480 per
// 30 minutes against that endpoint, six times the ceiling. The scanner would work for four
// minutes and then be throttled off for the rest of the session.
//
// So:
//
//   STAGE 1 — every symbol, every cycle, THREE requests total.
//     One batched quote call covers 208 shares, 208 futures, the sector indices, the Nifty,
//     its future and the VIX. Eight of the eleven factors come out of that plus the daily
//     baseline: volume, liquidity, relative strength, VWAP, ATR, sector, breadth, trend.
//     Futures open interest rides along too, so the build-up classification is available
//     universe-wide even before enrichment.
//
//   STAGE 2 — the top N only, one request each.
//     Ranked by the stage-1 score, the shortlist gets its option chain: greeks, implied
//     volatility, call/put OI skew, option turnover. At the default 40 a minute that is
//     ~1200 per 30 minutes — 60% of the ceiling for that endpoint, with the quote endpoint
//     untouched at 3%.
//
// A row that did not make the shortlist is not penalised for it: the score is a weighted
// mean over AVAILABLE weight, and `enrichment: 'quote'` says which read it was. Enrichment
// results are cached for their own TTL and reused across stage-1 cycles, so a stock that
// drops out of the shortlist for one cycle keeps its option data until it goes stale.

import type {
  FactorOutcome, MomentumBoard, MomentumConfig, MomentumRow,
} from '../types.js';
import { marketOpen, minuteOfSession, sessionFraction, istDay } from '../session.js';
import { getBaseline, type SymbolBaseline } from '../data/baseline.js';
import { quoteSnapshot, type MomentumQuote, type QuoteSnapshot } from '../data/quotes.js';
import { stockChain, type StockChain } from '../data/option-chain.js';
import { inBatches } from '../data/candles.js';
import {
  flushSessionState, observe, observeEnrichment, sessionState,
  type SessionState, type SymbolSessionState,
} from '../data/session-state.js';
import { historyRepository } from '../data/history.repository.js';
import { universe, type UniverseMember } from '../data/universe.js';
import { computeRvol, rvolFactor } from '../services/rvol.service.js';
import { computeLiquidity, liquidityFactor } from '../services/liquidity.service.js';
import { computeRelativeStrength, relativeStrengthFactor } from '../services/relative-strength.service.js';
import { computeVwap, vwapFactor } from '../services/vwap.service.js';
import { computeAtr, atrFactor } from '../services/atr.service.js';
import { computeTrend, trendFactor } from '../services/trend.service.js';
import { computeSector, sectorFactor } from '../services/sector.service.js';
import { computeBreadth, breadthFactor, marketContext, type BreadthReading } from '../services/breadth.service.js';
import { computeOptionFlow, optionFlowFactor, type OptionFlowReading } from '../services/option-analytics.service.js';
import { computeGreeks, greeksFactor, type GreeksReading } from '../services/greeks.service.js';
import { computeIv, ivFactor, type IvReading } from '../services/iv.service.js';
import { institutionalActivity, scoreRow } from './score.service.js';
import { cache } from '../cache.js';

/** Concurrency for the chain fetches. Matches what upstox.ts measured safe for the ladder. */
const ENRICH_BATCH = 8;

/** Cached option enrichment for one symbol. */
interface Enrichment {
  at: number;
  chain: StockChain | null;
  error?: string;
}

const enrichKey = (symbol: string) => `momentum:enrich:${symbol}`;

/* --------------------------------------------------------------- stage 1: the board --- */

interface StageOne {
  member: UniverseMember;
  quote: MomentumQuote;
  future: MomentumQuote | undefined;
  baseline: SymbolBaseline | undefined;
  symState: SymbolSessionState | undefined;
  factors: FactorOutcome[];
  liquidityScore: number | null;
  rvol: number | null;
  optionFlow: OptionFlowReading;
  provisionalScore: number;
  metricsCarry: {
    vwap: ReturnType<typeof computeVwap>;
    trend: ReturnType<typeof computeTrend>;
    relStrength: ReturnType<typeof computeRelativeStrength> | null;
    sector: ReturnType<typeof computeSector>;
    atr: ReturnType<typeof computeAtr>;
    liquidity: ReturnType<typeof computeLiquidity>;
    rvolReading: ReturnType<typeof computeRvol>;
  };
}

/** Filters applied before any scoring, so a penny stock cannot occupy a shortlist slot. */
function passesUniverseFilter(q: MomentumQuote, cfg: MomentumConfig): boolean {
  if (cfg.universe.exclude.includes(q.symbol)) return false;
  if (q.ltp < cfg.universe.minPrice) return false;
  // Turnover is cumulative for the day, so this only bites once there has been some trade.
  // Before the open every stock reads zero, and filtering then would empty the board.
  if (q.turnoverCr > 0 && q.turnoverCr < cfg.universe.minTurnoverCr) return false;
  return true;
}

function stageOne(
  member: UniverseMember,
  snap: QuoteSnapshot,
  baseline: SymbolBaseline | undefined,
  state: SessionState,
  breadth: BreadthReading,
  cfg: MomentumConfig,
  nowMs: number,
): StageOne | null {
  const quote = snap.equity.get(member.symbol);
  if (!quote || !passesUniverseFilter(quote, cfg)) return null;

  const future = snap.futures.get(member.symbol);
  const symState = state.symbols[member.symbol];
  const minute = minuteOfSession(nowMs);
  const fraction = sessionFraction(nowMs);

  const rvolReading = computeRvol(quote, baseline, minute, cfg);
  const liquidityReading = computeLiquidity({ quote, baseline }, cfg);
  const relStrength = snap.nifty
    ? computeRelativeStrength(quote.changePct, snap.nifty.changePct, baseline, cfg)
    : null;
  const vwapReading = computeVwap(quote, symState);
  const atrReading = computeAtr(quote, baseline, fraction, cfg);
  const trendReading = computeTrend(quote, baseline, symState?.openingRange ?? null, cfg);
  const sectorReading = computeSector(
    quote.changePct,
    member.sector,
    member.sectorIndexName,
    member.sectorIndexName ? snap.sectors.get(member.sectorIndexName) : undefined,
    snap.nifty?.changePct ?? null,
  );
  // Futures OI is on the Tier-A quote, so the build-up class is known for the whole
  // universe. Only the chain half of this factor waits for enrichment.
  const optionFlow = computeOptionFlow(future, baseline, null);

  const factors: FactorOutcome[] = [
    rvolFactor(rvolReading, cfg),
    liquidityFactor(liquidityReading, cfg),
    relativeStrengthFactor(relStrength, cfg),
    vwapFactor(vwapReading, cfg),
    atrFactor(atrReading, cfg),
    sectorFactor(sectorReading, cfg),
    trendFactor(trendReading, cfg),
    optionFlowFactor(optionFlow, cfg),
  ];

  // Breadth needs the row's own direction, so it is scored after the others have voted.
  const provisionalDirection = directionOf(factors);
  factors.push(breadthFactor(breadth, provisionalDirection, cfg));

  const provisional = scoreRow({ factors, liquidityScore: liquidityReading.score, config: cfg });

  return {
    member,
    quote,
    future,
    baseline,
    symState,
    factors,
    liquidityScore: liquidityReading.score,
    rvol: rvolReading.rvol,
    optionFlow,
    provisionalScore: provisional.score,
    metricsCarry: {
      vwap: vwapReading,
      trend: trendReading,
      relStrength,
      sector: sectorReading,
      atr: atrReading,
      liquidity: liquidityReading,
      rvolReading,
    },
  };
}

/** The directional vote so far — used to score breadth before the full score exists. */
function directionOf(factors: FactorOutcome[]): number {
  let num = 0;
  let den = 0;
  for (const f of factors) {
    if (!f.available || f.score === null || f.bias === 0) continue;
    const strength = f.score / 100;
    num += f.bias * f.weight * strength;
    den += f.weight * strength;
  }
  return den > 0 ? num / den : 0;
}

/* ------------------------------------------------------------ stage 2: enrichment --- */

/**
 * Fetch (or reuse) the option chain for the shortlist.
 *
 * Failures are per-symbol and cached with the same TTL as successes. Without that, a stock
 * whose chain Upstox refuses would be retried on every cycle for the rest of the session,
 * burning requests against a call that has already said no — the same reasoning
 * `upstox.ts` applies to the PCR endpoint.
 */
async function enrich(shortlist: StageOne[], cfg: MomentumConfig, nowMs: number): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();

  await inBatches(shortlist, ENRICH_BATCH, async (row) => {
    const key = enrichKey(row.member.symbol);
    const hit = await cache.get<Enrichment>(key);
    if (hit) {
      out.set(row.member.symbol, hit);
      return;
    }
    let value: Enrichment;
    try {
      value = { at: nowMs, chain: await stockChain(row.member.symbol, row.member.equityKey, nowMs) };
    } catch (e) {
      value = { at: nowMs, chain: null, error: String((e as Error).message) };
    }
    await cache.set(key, value, cfg.refresh.enrichMs);
    out.set(row.member.symbol, value);
  });

  return out;
}

/* --------------------------------------------------------------------- assembly --- */

function buildRow(
  s: StageOne,
  enrichment: Enrichment | undefined,
  ivReading: IvReading | null,
  breadth: BreadthReading,
  cfg: MomentumConfig,
): MomentumRow {
  const chain = enrichment?.chain ?? null;
  const carry = s.metricsCarry;

  // Rebuild the option-dependent factors now the chain is in hand. The quote-tier factors
  // are reused as computed — recomputing them would be identical work.
  let factors = s.factors;
  let optionFlow = s.optionFlow;
  let greeks: GreeksReading | null = null;
  let liquidityScore = s.liquidityScore;

  if (chain) {
    optionFlow = computeOptionFlow(s.future, s.baseline, chain);
    greeks = computeGreeks(chain, s.quote.ltp, s.quote.prevClose, s.symState);

    // Option turnover is a liquidity input, so liquidity is re-mixed once it is known.
    const liq = computeLiquidity(
      { quote: s.quote, baseline: s.baseline, optionValueCr: optionFlow.optionValueCr },
      cfg,
    );
    liquidityScore = liq.score;

    const replacements = new Map<string, FactorOutcome>([
      ['optionFlow', optionFlowFactor(optionFlow, cfg)],
      ['liquidity', liquidityFactor(liq, cfg)],
      ['greeks', greeksFactor(greeks, cfg)],
    ]);
    if (ivReading) replacements.set('impliedVolatility', ivFactor(ivReading, cfg));

    factors = s.factors.map((f) => replacements.get(f.key) ?? f);
    for (const [key, f] of replacements) if (!factors.some((x) => x.key === key)) factors.push(f);
  }

  // Breadth is direction-dependent, so it is re-scored against the final factor set.
  const withoutBreadth = factors.filter((f) => f.key !== 'marketBreadth');
  factors = [...withoutBreadth, breadthFactor(breadth, directionOf(withoutBreadth), cfg)];

  const result = scoreRow({ factors, liquidityScore, config: cfg });

  const activity = institutionalActivity(
    {
      rvol: s.rvol,
      turnoverCr: s.quote.turnoverCr,
      avgDailyValueCr: s.baseline?.avgDailyValueCr ?? null,
      optionValueCr: optionFlow.optionValueCr,
      futuresOiChangePct: optionFlow.futuresOiChangePct,
    },
    cfg,
  );

  const enrichmentLevel = chain ? 'full' : enrichment?.error ? 'partial' : 'quote';

  return {
    rank: 0, // assigned after sorting
    symbol: s.member.symbol,
    sector: s.member.sector,
    price: s.quote.ltp,
    prevClose: s.quote.prevClose,
    changePct: s.quote.changePct,
    volume: s.quote.volume,
    turnoverCr: s.quote.turnoverCr,

    score: result.score,
    rawScore: result.rawScore,
    coverage: result.coverage,
    confidence: result.confidence,
    direction: result.direction,
    tradeType: result.tradeType,
    institutionalActivity: activity.level,

    liquidity: { score: liquidityScore, grade: carry.liquidity.grade },
    rvol: { value: s.rvol, grade: carry.rvolReading.grade },
    vwap: { value: carry.vwap.vwap, distancePct: carry.vwap.distancePct, rising: carry.vwap.rising },
    relativeStrengthPct: carry.relStrength?.relativeStrengthPct ?? null,
    sectorStrengthPct: carry.sector?.sectorVsNiftyPct ?? null,
    atrExpansion: carry.atr.expansion,
    oiBuildUp: optionFlow.buildUp,
    oi: {
      futuresOi: optionFlow.futuresOi,
      futuresOiChangePctIntraday: optionFlow.futuresOiChangePct,
      pcrOi: optionFlow.pcrOi,
      pcrVolume: optionFlow.pcrVolume,
      maxPain: optionFlow.maxPain,
      optionValueCr: optionFlow.optionValueCr,
      expiry: optionFlow.expiry,
    },
    greeksSummary: greeks
      ? {
          delta: greeks.callDelta,
          deltaShift: greeks.deltaShift,
          gamma: greeks.gammaPer1Pct,
          thetaBurnPct: greeks.thetaBurnPct,
        }
      : null,
    ivSummary: ivReading
      ? { atmIv: ivReading.atmIv, ivRank: ivReading.ivRank, ivPercentile: ivReading.ivPercentile, basis: ivReading.basis }
      : null,
    expectedMove: greeks?.expectedMove ?? null,
    trend: {
      higherHigh: carry.trend.higherHigh,
      higherLow: carry.trend.higherLow,
      breakout: carry.trend.breakout,
      orb: carry.trend.orb,
    },

    enrichment: enrichmentLevel,
    reasons: result.reasons,
    factors,
  };
}

/* ------------------------------------------------------------------------ public --- */

export interface EngineResult {
  board: MomentumBoard;
}

/**
 * One full scan.
 *
 * Called by the scheduler on the quote interval and by the controller on a cache miss.
 * Every upstream call it makes is counted in the header comment; if you add one, update it.
 */
export async function runScan(cfg: MomentumConfig, nowMs = Date.now()): Promise<MomentumBoard> {
  const warnings: string[] = [];

  const [uni, snap, baselineResult, state] = await Promise.all([
    universe(nowMs),
    quoteSnapshot(nowMs),
    getBaseline(nowMs),
    sessionState(nowMs),
  ]);

  const baseline = baselineResult.baseline;
  if (!baseline) {
    warnings.push(
      'No daily baseline yet — relative volume, ATR expansion, beta and trend structure are unavailable until it builds. ' +
      'POST /momentum/baseline/rebuild, or wait for the scheduled build.',
    );
  } else if (baselineResult.stale) {
    warnings.push(`Baseline is from ${baseline.day}, not ${istDay(nowMs)} — RVOL and ATR are measured against a stale profile.`);
  }
  const failedBaselines = Object.keys(baseline?.failures ?? {}).length;
  if (failedBaselines > 0) warnings.push(`${failedBaselines} symbols have no baseline (Upstox would not serve their history).`);

  // Fold this reading into the session state before anything reads it, so the VWAP slope
  // and opening range include the current tick.
  const openingMinutes = cfg.thresholds.trendStructure.openingRangeMinutes;
  for (const q of snap.equity.values()) observe(state, q, openingMinutes, nowMs);

  const breadth = computeBreadth(snap);

  // ---- stage 1 ----
  const staged: StageOne[] = [];
  for (const member of uni.members) {
    const s = stageOne(member, snap, baseline?.symbols[member.symbol], state, breadth, cfg, nowMs);
    if (s) staged.push(s);
  }

  // ---- stage 2 ----
  const shortlist = [...staged]
    .sort((a, b) => b.provisionalScore - a.provisionalScore)
    .slice(0, cfg.universe.shortlistSize);

  const enrichments = shortlist.length ? await enrich(shortlist, cfg, nowMs) : new Map<string, Enrichment>();
  const enrichFailures = [...enrichments.values()].filter((e) => e.error).length;
  if (enrichFailures) warnings.push(`${enrichFailures} of ${shortlist.length} shortlisted symbols had no option chain this cycle.`);

  // IV needs the recorded history, read once per shortlisted symbol.
  const ivReadings = new Map<string, IvReading>();
  for (const s of shortlist) {
    const e = enrichments.get(s.member.symbol);
    const history = await historyRepository.forSymbol(s.member.symbol);
    ivReadings.set(s.member.symbol, computeIv(e?.chain ?? null, s.baseline, history, cfg));
  }

  const rows = staged
    .map((s) => buildRow(s, enrichments.get(s.member.symbol), ivReadings.get(s.member.symbol) ?? null, breadth, cfg))
    .filter((r) => r.coverage >= cfg.scoring.minCoverage)
    .sort((a, b) => b.score - a.score);

  rows.forEach((r, i) => { r.rank = i + 1; });

  // Record what the enrichment pass learned, both for the next pass's measured delta shift
  // and for the IV history that IV Rank will eventually be built on.
  await persistSessionLearning(shortlist, enrichments, ivReadings, rows, nowMs);

  const open = marketOpen(nowMs);
  const ivWarming = [...ivReadings.values()].filter((r) => r.basis === 'hv-proxy').length;
  if (ivWarming)
    warnings.push(
      `IV Rank is standing in from realised volatility for ${ivWarming} symbols — Upstox publishes no IV history, ` +
      `so a true rank needs ${cfg.thresholds.impliedVolatility.minSessionsForIvRank} recorded sessions.`,
    );

  return {
    asOf: nowMs,
    configVersion: cfg.version,
    universeSize: uni.members.length,
    scored: rows.length,
    shortlisted: shortlist.length,
    market: marketContext(snap, breadth, open, sessionFraction(nowMs), minuteOfSession(nowMs)),
    rows,
    warnings,
  };
}

/**
 * Write what only this pass knows.
 *
 * The IV row is upserted per session, so re-running the scan through the day overwrites the
 * same record rather than appending — what the history needs is one representative reading
 * per session, and the last one of the day is the settled one.
 */
async function persistSessionLearning(
  shortlist: StageOne[],
  enrichments: Map<string, Enrichment>,
  ivReadings: Map<string, IvReading>,
  rows: MomentumRow[],
  nowMs: number,
): Promise<void> {
  const state = await sessionState(nowMs);
  const day = istDay(nowMs);
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  const records = [];
  for (const s of shortlist) {
    const chain = enrichments.get(s.member.symbol)?.chain ?? null;
    const iv = ivReadings.get(s.member.symbol);
    const greeks = chain ? computeGreeks(chain, s.quote.ltp, s.quote.prevClose, s.symState) : null;

    observeEnrichment(
      state,
      s.member.symbol,
      { atmDelta: greeks?.callDelta ?? null, futuresOi: s.future?.openInterest ?? null },
      nowMs,
    );

    const row = bySymbol.get(s.member.symbol);
    if (!row) continue;
    records.push({
      symbol: s.member.symbol,
      day,
      close: s.quote.ltp,
      score: row.score,
      direction: row.direction,
      rvol: s.rvol,
      atmIv: iv?.atmIv ?? null,
      hv20: s.baseline?.hv20 ?? null,
      futuresOi: s.future?.openInterest ?? null,
    });
  }

  await historyRepository.upsertMany(records);
  await flushSessionState();
}
