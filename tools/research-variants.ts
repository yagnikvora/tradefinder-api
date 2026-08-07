// The configs `pullback-research.ts` compares.
//
// Kept in its own file so a sweep is one edit here and one command, and so the baseline is
// literally the shipped config rather than a hand-copied approximation of it.
//
// `off-*` variants DISABLE a shipped gate rather than tightening it. That direction matters: a
// gate that was added because a bucket looked good in a table has to be able to show that removing
// it costs something, or it is a curve fitted to a few hundred trades wearing a comment.

import type { PullbackConfig } from '../src/pullback/types.js';

export interface Variant {
  name: string;
  apply: (c: PullbackConfig) => PullbackConfig;
}

/** A number large enough that the gate it belongs to can never fire. */
const OFF = 999;

export const VARIANTS: Variant[] = [
  { name: 'baseline', apply: (c) => c },

  // What the module did before this pass.
  {
    name: 'off-all (as shipped before)',
    apply: (c) => {
      c.pullback.maxChaseR = OFF;
      c.pullback.maxGiveBackR = OFF;
      c.pullback.minEntryExtensionAtr = -OFF;
      c.pullback.maxEntryExtensionAtr = OFF;
      c.pullback.minHoldBars = 0;
      return c;
    },
  },
  {
    name: 'off-extension band',
    apply: (c) => {
      c.pullback.minEntryExtensionAtr = -OFF;
      c.pullback.maxEntryExtensionAtr = OFF;
      return c;
    },
  },
  { name: 'off-drift band', apply: (c) => { c.pullback.maxChaseR = OFF; c.pullback.maxGiveBackR = OFF; return c; } },
  { name: 'off-scaled hold', apply: (c) => { c.pullback.minHoldBars = 0; return c; } },

  { name: 'extension ≤ 0.6', apply: (c) => { c.pullback.maxEntryExtensionAtr = 0.6; return c; } },
  { name: 'extension ≤ 1.0', apply: (c) => { c.pullback.maxEntryExtensionAtr = 1; return c; } },
  { name: 'retracement ≥ 0.30', apply: (c) => { c.pullback.minRetracement = 0.3; return c; } },
  { name: 'hold ≥ 16 bars', apply: (c) => { c.pullback.minHoldBars = 16; return c; } },
];
