// Factor 1 — Relative Volume. The heaviest weight in the model, and the cheapest to compute.
//
//   RVOL = today's cumulative volume ÷ what this stock had normally traded by this minute
//
// The denominator is the part people get wrong. Comparing against *average daily* volume
// says every stock is quiet at 09:45 and busy at 15:25, which is a clock reading, not a
// signal. The baseline here is a median cumulative volume PROFILE — a curve through the
// session, built from the last twenty days of 1-minute bars — so 4.8x at 09:45 means the
// stock has already done 4.8 times what it usually does by 09:45.
//
// Both inputs are free at runtime: `volume` in the Tier-A quote is cumulative for the day,
// and the profile was built before the open. No request is made here.

import type { MomentumConfig, RvolGrade } from '../types.js';
import type { SymbolBaseline } from '../data/baseline.js';
import type { MomentumQuote } from '../data/quotes.js';
import { curve, fmtX, outcome, unavailable } from './scoring.js';

export interface RvolReading {
  rvol: number | null;
  grade: RvolGrade | null;
  expectedVolume: number | null;
  actualVolume: number;
  profileSessions: number;
}

export function gradeRvol(rvol: number, t: MomentumConfig['thresholds']['rvol']): RvolGrade {
  if (rvol >= t.excellent) return 'Excellent';
  if (rvol >= t.good) return 'Good';
  if (rvol >= t.average) return 'Average';
  return 'Poor';
}

export function computeRvol(
  quote: MomentumQuote,
  baseline: SymbolBaseline | undefined,
  minuteOfSession: number,
  cfg: MomentumConfig,
): RvolReading {
  const t = cfg.thresholds.rvol;
  const profile = baseline?.profile;

  if (!profile || !profile.length || minuteOfSession <= 0)
    return { rvol: null, grade: null, expectedVolume: null, actualVolume: quote.volume, profileSessions: baseline?.profileSessions ?? 0 };

  const idx = Math.min(minuteOfSession, profile.length - 1);
  const expected = profile[idx];
  // A stock whose median volume by this minute is zero has no benchmark — dividing would
  // report Infinity, which sorts to the top of the board and is meaningless there.
  if (!(expected > 0))
    return { rvol: null, grade: null, expectedVolume: expected ?? null, actualVolume: quote.volume, profileSessions: baseline.profileSessions };

  const rvol = +(quote.volume / expected).toFixed(2);
  return {
    rvol,
    grade: gradeRvol(rvol, t),
    expectedVolume: Math.round(expected),
    actualVolume: quote.volume,
    profileSessions: baseline.profileSessions,
  };
}

export function rvolFactor(reading: RvolReading, cfg: MomentumConfig) {
  const weight = cfg.weights.rvol;
  const t = cfg.thresholds.rvol;

  if (reading.rvol === null)
    return unavailable(
      'rvol',
      weight,
      reading.profileSessions === 0
        ? 'no volume-profile baseline for this symbol yet'
        : 'the session has not started, so there is nothing to compare',
    );

  const score = curve(reading.rvol, t.knots);

  return outcome({
    key: 'rvol',
    weight,
    score,
    // Volume confirms whatever direction exists; on its own it says nothing about which way.
    bias: 0,
    metrics: {
      rvol: reading.rvol,
      grade: reading.grade,
      expectedVolume: reading.expectedVolume,
      actualVolume: reading.actualVolume,
      baselineSessions: reading.profileSessions,
    },
    reasons: [
      {
        ok: reading.rvol >= t.good,
        text: `RVOL ${fmtX(reading.rvol)}${reading.rvol >= t.excellent ? ' — exceptional participation' : reading.rvol >= t.good ? '' : ' — below the participation this model looks for'}`,
      },
    ],
    note: reading.profileSessions < 10 ? `baseline is only ${reading.profileSessions} sessions deep` : undefined,
  });
}
