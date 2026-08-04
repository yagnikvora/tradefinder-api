// The admin surface. This is the one place an operator can break the scoring model from
// outside the codebase, so the tests are about what happens when they do.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { StoredConfigRepository, sanitise } from '../src/momentum/config/config.repository.js';
import { defaultConfig } from '../src/momentum/config/defaults.js';
import { parseConfigPatch, parseBoardQuery, parseSymbol, ValidationError } from '../src/momentum/dto.js';
import type { KeyValueStore } from '../src/momentum/store.js';
import { FACTOR_KEYS } from '../src/momentum/types.js';

/** An in-memory KeyValueStore, which is all the repository needs to be exercised. */
class FakeStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  async read<T>(key: string): Promise<T | null> { return (this.data.get(key) as T) ?? null; }
  async write<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async remove(key: string): Promise<void> { this.data.delete(key); }
}

/* -------------------------------------------------------------------- repository --- */

describe('config repository', () => {
  it('serves the defaults when nothing has been saved', async () => {
    const repo = new StoredConfigRepository(new FakeStore());
    const cfg = await repo.get();
    // Against the shipped model rather than a literal: the weights are a calibration and
    // are expected to be re-tuned, and a test that pins them re-fails on every re-tune
    // without ever having checked the thing it is named for.
    assert.equal(cfg.weights.rvol, defaultConfig().weights.rvol);
    assert.equal(cfg.version, 1);
  });

  it('bumps the version and stamps the author on save', async () => {
    const repo = new StoredConfigRepository(new FakeStore());
    const before = await repo.get();
    const after = await repo.save({ weights: { rvol: 30 } }, 'alice');
    assert.equal(after.version, before.version + 1);
    assert.equal(after.updatedBy, 'alice');
    assert.ok(Date.parse(after.updatedAt) > 0);
  });

  it('merges a patch over the defaults rather than replacing them', async () => {
    const repo = new StoredConfigRepository(new FakeStore());
    const saved = await repo.save({ weights: { rvol: 30 } }, 'alice');
    assert.equal(saved.weights.rvol, 30, 'the patched field changes');
    assert.equal(saved.weights.liquidity, defaultConfig().weights.liquidity, 'and every other field survives');
    assert.equal(saved.thresholds.rvol.excellent, 3.5);
  });

  it('gives a config saved before a new factor existed that factor’s defaults', async () => {
    // The upgrade case: a stored config from last month must not crash the engine on an
    // undefined threshold, it must inherit whatever the new release ships.
    const store = new FakeStore();
    await store.write('config', { weights: { rvol: 25 }, version: 7 });
    const repo = new StoredConfigRepository(store);
    const cfg = await repo.get();
    assert.equal(cfg.weights.rvol, 25);
    for (const k of FACTOR_KEYS) assert.equal(typeof cfg.weights[k], 'number');
    assert.ok(cfg.thresholds.greeks.mix.delta > 0);
  });

  it('replaces a knot list wholesale instead of merging it element-wise', async () => {
    // A shorter curve means exactly that curve. Merging would leave the old tail attached.
    const repo = new StoredConfigRepository(new FakeStore());
    const saved = await repo.save(
      { thresholds: { rvol: { knots: [{ at: 1, score: 0 }, { at: 5, score: 100 }] } } } as never,
      'alice',
    );
    assert.equal(saved.thresholds.rvol.knots.length, 2);
  });

  it('resets to the shipped model but keeps the version climbing', async () => {
    const repo = new StoredConfigRepository(new FakeStore());
    await repo.save({ weights: { rvol: 99 } }, 'alice');
    const reset = await repo.reset('bob');
    assert.equal(reset.weights.rvol, defaultConfig().weights.rvol);
    assert.ok(reset.version > 1);
    assert.equal(reset.updatedBy, 'bob');
  });

  it('persists across repository instances', async () => {
    const store = new FakeStore();
    await new StoredConfigRepository(store).save({ weights: { rvol: 42 } }, 'alice');
    assert.equal((await new StoredConfigRepository(store).get()).weights.rvol, 42);
  });
});

/* --------------------------------------------------------------------- sanitise --- */

describe('sanitise', () => {
  it('sorts knots ascending, because curve() relies on the order', () => {
    const cfg = defaultConfig();
    cfg.thresholds.rvol.knots = [{ at: 5, score: 100 }, { at: 1, score: 0 }, { at: 3, score: 60 }];
    const out = sanitise(cfg);
    assert.deepEqual(out.thresholds.rvol.knots.map((k) => k.at), [1, 3, 5]);
  });

  it('refuses an all-zero weight set — that is not a model', () => {
    const cfg = defaultConfig();
    for (const k of FACTOR_KEYS) cfg.weights[k] = 0;
    const out = sanitise(cfg);
    assert.equal(out.weights.rvol, defaultConfig().weights.rvol, 'falls back to the shipped weights');
  });

  it('turns a negative or non-finite weight into zero rather than propagating NaN', () => {
    const cfg = defaultConfig();
    cfg.weights.rvol = -5;
    cfg.weights.vwap = Number.NaN;
    const out = sanitise(cfg);
    assert.equal(out.weights.rvol, 0);
    assert.equal(out.weights.vwap, 0);
  });

  it('clamps the refresh intervals into the range the rate limit allows', () => {
    const cfg = defaultConfig();
    cfg.refresh.quoteMs = 100;
    cfg.refresh.enrichMs = 1;
    const out = sanitise(cfg);
    assert.ok(out.refresh.quoteMs >= 5000);
    assert.ok(out.refresh.enrichMs >= 15000);
  });

  it('caps the shortlist at the size of the F&O universe', () => {
    const cfg = defaultConfig();
    cfg.universe.shortlistSize = 9999;
    assert.ok(sanitise(cfg).universe.shortlistSize <= 208);
  });

  it('drops a malformed knot rather than letting it reach the curve', () => {
    const cfg = defaultConfig();
    cfg.thresholds.rvol.knots = [
      { at: 1, score: 0 },
      { at: Number.NaN, score: 50 },
      { at: 5, score: 100 },
    ];
    const out = sanitise(cfg);
    assert.equal(out.thresholds.rvol.knots.length, 2);
  });

  it('uppercases the exclusion list so a lowercase entry still excludes', () => {
    const cfg = defaultConfig();
    cfg.universe.exclude = ['idea', 'Yesbank'];
    assert.deepEqual(sanitise(cfg).universe.exclude, ['IDEA', 'YESBANK']);
  });
});

/* ---------------------------------------------------------------- DTO: config --- */

describe('parseConfigPatch', () => {
  it('accepts a partial patch', () => {
    const p = parseConfigPatch({ weights: { rvol: 25 } });
    assert.deepEqual(p, { weights: { rvol: 25 } });
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // A typo that silently does nothing is worse than an error: the operator believes the
    // change took effect and the ranking they are looking at is not the one they configured.
    assert.throws(() => parseConfigPatch({ wieghts: { rvol: 25 } }), ValidationError);
  });

  it('rejects a weight that is not a factor', () => {
    assert.throws(() => parseConfigPatch({ weights: { momentum: 10 } }), /not a factor/);
  });

  it('rejects a negative weight', () => {
    assert.throws(() => parseConfigPatch({ weights: { rvol: -1 } }), /≥ 0/);
  });

  it('rejects an all-zero weight set', () => {
    const zeroed = Object.fromEntries(FACTOR_KEYS.map((k) => [k, 0]));
    assert.throws(() => parseConfigPatch({ weights: zeroed }), /cannot all be zero/);
  });

  it('allows weights that do not total 100 — the engine normalises', () => {
    assert.doesNotThrow(() => parseConfigPatch({ weights: { rvol: 500 } }));
  });

  it('rejects a malformed knot list', () => {
    assert.throws(
      () => parseConfigPatch({ thresholds: { rvol: { knots: [{ at: 'soon', score: 10 }] } } }),
      /must be \{at: number, score: number\}/,
    );
    assert.throws(() => parseConfigPatch({ thresholds: { rvol: { knots: [] } } }), /at least one knot/);
    assert.throws(
      () => parseConfigPatch({ thresholds: { rvol: { knots: [{ at: 1, score: 500 }] } } }),
      /score must be 0–100/,
    );
  });

  it('accepts an unsorted knot list — the repository sorts it', () => {
    assert.doesNotThrow(() =>
      parseConfigPatch({ thresholds: { rvol: { knots: [{ at: 5, score: 100 }, { at: 1, score: 0 }] } } }),
    );
  });

  it('rejects a refresh interval that would breach the rate limit', () => {
    assert.throws(() => parseConfigPatch({ refresh: { quoteMs: 500 } }), /rate limit/);
    assert.throws(() => parseConfigPatch({ refresh: { enrichMs: 1000 } }), /rate limit/);
  });

  it('rejects a shortlist bigger than the universe', () => {
    assert.throws(() => parseConfigPatch({ universe: { shortlistSize: 5000 } }), /cannot exceed/);
  });

  it('rejects a coherence penalty of 1 or more — it would zero every split row', () => {
    assert.throws(() => parseConfigPatch({ scoring: { coherence: { maxPenalty: 1 } } }), /0 ≤ p < 1/);
    assert.doesNotThrow(() => parseConfigPatch({ scoring: { coherence: { maxPenalty: 0.5 } } }));
  });

  it('accepts a config echoed back from GET but ignores the server-owned provenance', () => {
    // An admin panel that reads the config and writes it back must not be rejected, and must
    // not be able to set its own version number.
    const patch = parseConfigPatch({ version: 99, updatedAt: 'whenever', updatedBy: 'me', weights: { rvol: 21 } });
    assert.equal('version' in patch, false);
    assert.equal('updatedBy' in patch, false);
    assert.equal(patch.weights?.rvol, 21);
  });

  it('rejects a non-object body', () => {
    assert.throws(() => parseConfigPatch('nope'), /must be a JSON object/);
    assert.throws(() => parseConfigPatch(null), /must be a JSON object/);
  });

  it('collects every issue rather than stopping at the first', () => {
    try {
      parseConfigPatch({ weights: { rvol: -1, nonsense: 5 }, refresh: { quoteMs: 1 } });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof ValidationError);
      assert.ok(e.issues.length >= 3, `expected several issues, got ${e.issues.length}`);
    }
  });
});

/* ----------------------------------------------------------------- DTO: query --- */

describe('parseBoardQuery', () => {
  const cfg = defaultConfig();

  it('falls back to the config when a parameter is absent', () => {
    const q = parseBoardQuery({}, cfg);
    assert.equal(q.limit, cfg.output.limit);
    assert.equal(q.direction, null);
    assert.equal(q.includeFactors, false);
  });

  it('clamps a limit rather than rejecting it', () => {
    assert.equal(parseBoardQuery({ limit: '99999' }, cfg).limit, 500);
    assert.equal(parseBoardQuery({ limit: '0' }, cfg).limit, 1);
    assert.equal(parseBoardQuery({ limit: 'abc' }, cfg).limit, cfg.output.limit);
  });

  it('ignores an enum value that is not one of the options', () => {
    assert.equal(parseBoardQuery({ direction: 'Sideways' }, cfg).direction, null);
    assert.equal(parseBoardQuery({ direction: 'Bullish' }, cfg).direction, 'Bullish');
  });

  it('uppercases the sector filter', () => {
    assert.equal(parseBoardQuery({ sector: 'it' }, cfg).sector, 'IT');
  });
});

describe('parseSymbol', () => {
  it('accepts the shapes NSE actually uses', () => {
    assert.equal(parseSymbol('reliance'), 'RELIANCE');
    assert.equal(parseSymbol('BAJAJ-AUTO'), 'BAJAJ-AUTO', 'hyphens are real symbols');
    assert.equal(parseSymbol('GVT&D'), 'GVT&D', 'so are ampersands');
    assert.equal(parseSymbol('M&M'), 'M&M');
  });

  it('rejects an empty or hostile symbol', () => {
    assert.throws(() => parseSymbol(''), ValidationError);
    assert.throws(() => parseSymbol('../../etc/passwd'), ValidationError);
    assert.throws(() => parseSymbol('A'.repeat(50)), ValidationError);
  });
});
