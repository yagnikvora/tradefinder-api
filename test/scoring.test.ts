// The scoring maths — the part of the module that must be right for the ranking to mean
// anything, and the part that has no network in it and so can be pinned down exactly.
//
// What is deliberately NOT tested here: whether Upstox answers, whether a chain parses,
// whether the funnel stays inside the rate limit. Those need the live API and are what
// `npm run check-momentum` is for. These are the arithmetic.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { curve, mix, squash, clamp } from '../src/momentum/services/scoring.js';
import { scoreRow, institutionalActivity, confidenceFrom, tradeTypeFrom, explain } from '../src/momentum/engine/score.service.js';
import { defaultConfig } from '../src/momentum/config/defaults.js';
import { FACTOR_KEYS, type FactorKey, type FactorOutcome } from '../src/momentum/types.js';

/* ---------------------------------------------------------------------- curve() --- */

describe('curve', () => {
  const rising = [
    { at: 0.5, score: 0 },
    { at: 1.0, score: 20 },
    { at: 2.0, score: 60 },
    { at: 4.0, score: 100 },
  ];

  it('returns the knot score exactly at a knot', () => {
    assert.equal(curve(1.0, rising), 20);
    assert.equal(curve(2.0, rising), 60);
  });

  it('interpolates linearly between knots', () => {
    // Halfway between (1.0, 20) and (2.0, 60).
    assert.equal(curve(1.5, rising), 40);
    // A quarter of the way between (2.0, 60) and (4.0, 100).
    assert.equal(curve(2.5, rising), 70);
  });

  it('clamps below the first knot and above the last', () => {
    assert.equal(curve(0, rising), 0);
    assert.equal(curve(-99, rising), 0);
    assert.equal(curve(4, rising), 100);
    assert.equal(curve(1000, rising), 100);
  });

  it('handles a falling curve — the shape the spread and theta thresholds use', () => {
    const falling = [
      { at: 1, score: 100 },
      { at: 10, score: 40 },
      { at: 50, score: 0 },
    ];
    assert.equal(curve(0.5, falling), 100, 'tighter than the first knot is still the best score');
    assert.equal(curve(1, falling), 100);
    assert.equal(curve(5.5, falling), 70);
    assert.equal(curve(100, falling), 0);
  });

  it('handles a humped curve — the shape IV rank uses', () => {
    const humped = [
      { at: 0, score: 20 },
      { at: 40, score: 95 },
      { at: 60, score: 100 },
      { at: 100, score: 25 },
    ];
    assert.equal(curve(0, humped), 20, 'a volatility floor is not a momentum setup');
    assert.equal(curve(50, humped), 97.5);
    assert.equal(curve(100, humped), 25, 'a volatility ceiling is not one either');
    assert.ok(curve(50, humped) > curve(0, humped));
    assert.ok(curve(50, humped) > curve(100, humped));
  });

  it('survives a malformed curve rather than throwing', () => {
    // An admin can save anything; a scoring function that throws takes the whole board down.
    assert.equal(curve(5, []), 0);
    assert.equal(curve(5, [{ at: 1, score: 42 }]), 42);
  });

  it('scores a non-finite reading 0, not 100', () => {
    // Infinity here means something divided by zero upstream. Treating it as "off the top of
    // the curve" would put a broken row at the top of a trading board, so a reading that is
    // not a number scores as no evidence rather than as maximal evidence.
    assert.equal(curve(Number.NaN, rising), 0);
    assert.equal(curve(Infinity, rising), 0);
    assert.equal(curve(-Infinity, rising), 0);
  });

  it('never leaves 0–100 even when a knot does', () => {
    const bad = [{ at: 0, score: -50 }, { at: 10, score: 500 }];
    assert.equal(curve(0, bad), 0);
    assert.equal(curve(10, bad), 100);
    const mid = curve(5, bad);
    assert.ok(mid >= 0 && mid <= 100, `expected 0–100, got ${mid}`);
  });
});

/* ------------------------------------------------------------------------ mix() --- */

describe('mix', () => {
  it('reweights around a missing component instead of scoring it zero', () => {
    // This is the behaviour that stops a closed order book making every stock illiquid.
    const withAll = mix([
      { key: 'a', weight: 0.5, score: 80 },
      { key: 'b', weight: 0.5, score: 40 },
    ]);
    assert.equal(withAll.score, 60);
    assert.equal(withAll.coverage, 1);

    const missingB = mix([
      { key: 'a', weight: 0.5, score: 80 },
      { key: 'b', weight: 0.5, score: null },
    ]);
    assert.equal(missingB.score, 80, 'the surviving component carries the mix at its own value');
    assert.equal(missingB.coverage, 0.5);
    assert.deepEqual(missingB.missing, ['b']);
  });

  it('returns null when nothing is computable', () => {
    const m = mix([{ key: 'a', weight: 1, score: null }]);
    assert.equal(m.score, null);
    assert.equal(m.coverage, 0);
  });

  it('respects unequal weights', () => {
    const m = mix([
      { key: 'a', weight: 3, score: 100 },
      { key: 'b', weight: 1, score: 0 },
    ]);
    assert.equal(m.score, 75);
  });
});

/* ----------------------------------------------------------------------- squash --- */

describe('squash', () => {
  it('is signed, bounded and monotonic', () => {
    assert.equal(squash(0, 2), 0);
    assert.ok(squash(1, 2) > 0);
    assert.ok(squash(-1, 2) < 0);
    // tanh saturates to exactly 1.0 in float64 well before x = 50, so this is ≤, not <.
    assert.ok(squash(100, 2) <= 1 && squash(100, 2) > 0.99);
    assert.ok(squash(-100, 2) >= -1 && squash(-100, 2) < -0.99);
    assert.ok(squash(2, 2) > squash(1, 2));
  });

  it('returns 0 rather than dividing by a zero full-scale', () => {
    assert.equal(squash(5, 0), 0);
  });
});

/* -------------------------------------------------------------------- scoreRow() --- */

/** A factor with everything defaulted, so each test states only what it is about. */
function factor(key: FactorKey, over: Partial<FactorOutcome> = {}): FactorOutcome {
  return {
    key,
    label: key,
    score: 50,
    bias: 0,
    weight: 10,
    available: true,
    metrics: {},
    reasons: [],
    ...over,
  };
}

describe('scoreRow', () => {
  const cfg = defaultConfig();

  it('is a weighted mean over AVAILABLE weight, not total weight', () => {
    // The whole point: a stock outside the enrichment shortlist must not be ranked lower
    // for it. Both rows below have the same evidence; one simply has less of it measured.
    const complete = scoreRow({
      factors: [factor('rvol', { score: 80, weight: 20 }), factor('liquidity', { score: 80, weight: 15 })],
      liquidityScore: 80,
      config: cfg,
    });
    const partial = scoreRow({
      factors: [
        factor('rvol', { score: 80, weight: 20 }),
        factor('liquidity', { score: 80, weight: 15 }),
        factor('greeks', { score: null, available: false, weight: 10 }),
      ],
      liquidityScore: 80,
      config: cfg,
    });

    assert.equal(complete.rawScore, 80);
    assert.equal(partial.rawScore, 80, 'the missing factor must not drag the score down');
    assert.ok(partial.coverage < complete.coverage, 'but it must show up as lower coverage');
  });

  it('reports coverage as the fraction of configured weight that was computable', () => {
    const r = scoreRow({
      factors: [
        factor('rvol', { weight: 20, score: 50 }),
        factor('greeks', { weight: 20, score: null, available: false }),
      ],
      liquidityScore: 90,
      config: cfg,
    });
    assert.equal(r.coverage, 0.5);
  });

  it('penalises directional disagreement', () => {
    // The case this exists for: loud on every factor, pointing in opposite directions.
    const agreeing = scoreRow({
      factors: [
        factor('vwap', { score: 90, bias: 1, weight: 10 }),
        factor('optionFlow', { score: 90, bias: 1, weight: 10 }),
      ],
      liquidityScore: 90,
      config: cfg,
    });
    const split = scoreRow({
      factors: [
        factor('vwap', { score: 90, bias: 1, weight: 10 }),
        factor('optionFlow', { score: 90, bias: -1, weight: 10 }),
      ],
      liquidityScore: 90,
      config: cfg,
    });

    assert.equal(agreeing.rawScore, split.rawScore, 'same factor scores');
    assert.equal(agreeing.coherence, 1);
    assert.equal(split.coherence, 0, 'exactly cancelling is zero coherence');
    assert.ok(split.score < agreeing.score, 'so the split row must score lower');
    assert.equal(split.penalty, cfg.scoring.coherence.maxPenalty);
    assert.equal(split.direction, 'Neutral');
  });

  it('can have the coherence penalty turned off from config', () => {
    const off = { ...cfg, scoring: { ...cfg.scoring, coherence: { enabled: false, maxPenalty: 0.25 } } };
    const r = scoreRow({
      factors: [
        factor('vwap', { score: 90, bias: 1 }),
        factor('optionFlow', { score: 90, bias: -1 }),
      ],
      liquidityScore: 90,
      config: off,
    });
    assert.equal(r.penalty, 0);
    assert.equal(r.score, r.rawScore);
  });

  it('lets magnitude-only factors abstain from the direction vote', () => {
    // RVOL carries the heaviest weight in the model. If it voted 0 rather than abstaining,
    // it would drag every direction toward Neutral in proportion to that weight.
    const r = scoreRow({
      factors: [
        factor('rvol', { score: 100, bias: 0, weight: 20 }),
        factor('vwap', { score: 80, bias: 1, weight: 10 }),
      ],
      liquidityScore: 90,
      config: cfg,
    });
    assert.equal(r.directionVector, 1, 'the only voter voted +1');
    assert.equal(r.direction, 'Bullish');
    assert.equal(r.coherence, 1);
  });

  it('weights the direction vote by factor strength, not just configured weight', () => {
    // A directional factor scoring 20 should not shout as loudly as one scoring 90.
    const r = scoreRow({
      factors: [
        factor('vwap', { score: 90, bias: 1, weight: 10 }),
        factor('sectorStrength', { score: 10, bias: -1, weight: 10 }),
      ],
      liquidityScore: 90,
      config: cfg,
    });
    assert.ok(r.directionVector > 0.5, `expected a clearly bullish vote, got ${r.directionVector}`);
    assert.equal(r.direction, 'Bullish');
  });

  it('reads a reading inside the deadband as Neutral', () => {
    const r = scoreRow({
      factors: [factor('vwap', { score: 80, bias: 0.05, weight: 10 })],
      liquidityScore: 90,
      config: cfg,
    });
    assert.ok(Math.abs(r.directionVector) < cfg.scoring.directionDeadband);
    assert.equal(r.direction, 'Neutral');
  });

  it('is symmetric — the same evidence inverted scores the same and points the other way', () => {
    const bull = scoreRow({
      factors: [factor('vwap', { score: 88, bias: 0.9 }), factor('optionFlow', { score: 76, bias: 0.7 })],
      liquidityScore: 90,
      config: cfg,
    });
    const bear = scoreRow({
      factors: [factor('vwap', { score: 88, bias: -0.9 }), factor('optionFlow', { score: 76, bias: -0.7 })],
      liquidityScore: 90,
      config: cfg,
    });
    assert.equal(bull.score, bear.score, 'short momentum is momentum');
    assert.equal(bull.direction, 'Bullish');
    assert.equal(bear.direction, 'Bearish');
  });

  it('never exceeds the configured maxScore', () => {
    const capped = { ...cfg, scoring: { ...cfg.scoring, maxScore: 50 } };
    const r = scoreRow({
      factors: [factor('rvol', { score: 100, weight: 20 })],
      liquidityScore: 90,
      config: capped,
    });
    assert.equal(r.score, 50);
  });

  it('scores zero rather than NaN when nothing is available', () => {
    const r = scoreRow({
      factors: [factor('rvol', { score: null, available: false })],
      liquidityScore: null,
      config: cfg,
    });
    assert.equal(r.score, 0);
    assert.equal(r.coverage, 0);
    assert.equal(r.confidence, 'Low');
    assert.equal(r.tradeType, 'Avoid');
  });
});

/* ---------------------------------------------------------------- confidence --- */

describe('confidenceFrom', () => {
  const cfg = defaultConfig();

  it('needs both coverage and liquidity for High', () => {
    assert.equal(confidenceFrom(1, 90, cfg), 'High');
    assert.equal(
      confidenceFrom(1, 10, cfg),
      'Medium',
      'a complete read on something you cannot trade out of is not high confidence',
    );
  });

  it('steps down with coverage', () => {
    assert.equal(confidenceFrom(0.7, 90, cfg), 'Medium');
    assert.equal(confidenceFrom(0.3, 90, cfg), 'Low');
  });

  it('treats a null liquidity score as unqualified for High', () => {
    assert.equal(confidenceFrom(1, null, cfg), 'Medium');
  });
});

/* ----------------------------------------------------------------- trade type --- */

describe('tradeTypeFrom', () => {
  const cfg = defaultConfig();

  it('maps a strong coherent direction to a side', () => {
    assert.equal(tradeTypeFrom(80, 'Bullish', 90, cfg), 'Momentum Buy');
    assert.equal(tradeTypeFrom(80, 'Bearish', 90, cfg), 'Momentum Sell');
  });

  it('avoids anything below the configured score', () => {
    assert.equal(tradeTypeFrom(40, 'Bullish', 90, cfg), 'Avoid');
  });

  it('avoids anything illiquid however it scores', () => {
    // "Avoid" here means not tradable, not "the model dislikes it".
    assert.equal(tradeTypeFrom(99, 'Bullish', 5, cfg), 'Avoid');
  });

  it('avoids a neutral direction', () => {
    assert.equal(tradeTypeFrom(99, 'Neutral', 90, cfg), 'Avoid');
  });

  it('honours a reconfigured buy threshold', () => {
    const strict = { ...cfg, output: { ...cfg.output, buyScore: 95 } };
    assert.equal(tradeTypeFrom(80, 'Bullish', 90, strict), 'Avoid');
    assert.equal(tradeTypeFrom(96, 'Bullish', 90, strict), 'Momentum Buy');
  });
});

/* -------------------------------------------------------------------- explain --- */

describe('explain', () => {
  it('leads with the factor that actually contributed most', () => {
    // Ordered by weight × score, not weight: a heavy factor that scored 5 said nothing.
    const reasons = explain([
      factor('rvol', { weight: 20, score: 5, reasons: [{ ok: false, text: 'quiet' }] }),
      factor('vwap', { weight: 10, score: 95, reasons: [{ ok: true, text: 'above a rising VWAP' }] }),
    ]);
    assert.equal(reasons[0].text, 'above a rising VWAP');
  });

  it('skips factors with nothing to say', () => {
    const reasons = explain([factor('rvol', { reasons: [] }), factor('vwap', { reasons: [{ ok: true, text: 'x' }] })]);
    assert.equal(reasons.length, 1);
  });
});

/* --------------------------------------------------- institutional activity --- */

describe('institutionalActivity', () => {
  const cfg = defaultConfig();

  it('reads heavy participation as institutional', () => {
    const a = institutionalActivity(
      { rvol: 5, turnoverCr: 900, avgDailyValueCr: 1000, optionValueCr: 200, futuresOiChangePct: 12 },
      cfg,
    );
    assert.equal(a.level, 'High');
  });

  it('reads a quiet tape as low', () => {
    const a = institutionalActivity(
      { rvol: 0.4, turnoverCr: 2, avgDailyValueCr: 400, optionValueCr: 0.2, futuresOiChangePct: 0.1 },
      cfg,
    );
    assert.equal(a.level, 'Low');
  });

  it('measures turnover against the stock’s own norm, not in absolute rupees', () => {
    // A ₹200Cr day in a stock that normally does ₹20Cr is the interesting one.
    const big = institutionalActivity(
      { rvol: null, turnoverCr: 2000, avgDailyValueCr: 20_000, optionValueCr: null, futuresOiChangePct: null },
      cfg,
    );
    const unusual = institutionalActivity(
      { rvol: null, turnoverCr: 200, avgDailyValueCr: 20, optionValueCr: null, futuresOiChangePct: null },
      cfg,
    );
    assert.ok(unusual.score > big.score);
  });

  it('copes with every input missing', () => {
    const a = institutionalActivity(
      { rvol: null, turnoverCr: 0, avgDailyValueCr: null, optionValueCr: null, futuresOiChangePct: null },
      cfg,
    );
    assert.equal(a.score, 0);
    assert.equal(a.level, 'Low');
  });
});

/* -------------------------------------------------------------------- config --- */

describe('default config', () => {
  it('defines a weight for every factor', () => {
    const cfg = defaultConfig();
    for (const k of FACTOR_KEYS) assert.equal(typeof cfg.weights[k], 'number', `missing weight for ${k}`);
  });

  it('ships the weights the brief specifies, totalling 100', () => {
    const cfg = defaultConfig();
    assert.equal(cfg.weights.rvol, 20);
    assert.equal(cfg.weights.liquidity, 15);
    assert.equal(FACTOR_KEYS.reduce((a, k) => a + cfg.weights[k], 0), 100);
  });

  it('hands out an independent copy, so a caller cannot edit the shipped defaults', () => {
    const a = defaultConfig();
    a.weights.rvol = 999;
    assert.equal(defaultConfig().weights.rvol, 20);
  });

  it('keeps every knot list sorted ascending — curve() relies on it', () => {
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        if (node.length && typeof node[0] === 'object' && node[0] !== null && 'at' in node[0]) {
          const ats = (node as Array<{ at: number }>).map((k) => k.at);
          assert.deepEqual(ats, [...ats].sort((x, y) => x - y), `${path} is not sorted`);
        }
        return;
      }
      if (node && typeof node === 'object')
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(defaultConfig().thresholds, 'thresholds');
  });
});

describe('clamp', () => {
  it('bounds on both sides', () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp(0.4, 0, 1), 0.4);
  });
});
