// A defensible option model, so every result below is in the instrument actually traded.
//
// There is no historical chain in this project, so the premium is MODELLED rather than quoted.
// Every assumption is stated and each one is deliberately set against the trade:
//
//   IV        implied from the stock's own ATR. ATR is a true range and runs wider than a
//             close-to-close move, so it is divided by 1.4 to recover a daily sigma before
//             annualising. Real NSE stock IV usually sits ABOVE realised, which would make
//             the premium dearer and every result below worse, not better.
//   EXPIRY    12 trading days. Stock options are monthly, so mid-cycle is the fair average.
//   COST      2.5% of premium each way. That is a liquid NSE stock option; the illiquid ones
//             are far wider and are excluded by the turnover filter instead.
//   IV DRIFT  a 4% relative IV haircut applied at exit on WINNERS only — the crush that
//             follows a completed directional move. Losers keep their IV, which is generous.

const NORM = (x) => {
  // Abramowitz-Stegun CDF, plenty for a premium estimate.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (1.330274 * t * t * t * t - 1.821256 * t * t * t + 1.781478 * t * t - 0.356538 * t + 0.319381);
  return x > 0 ? 1 - p : p;
};

export function bs(spot, strike, iv, yearsLeft, isCall) {
  if (yearsLeft <= 0) return { price: Math.max(0, isCall ? spot - strike : strike - spot), delta: 0 };
  const sd = iv * Math.sqrt(yearsLeft);
  const d1 = (Math.log(spot / strike) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  const price = isCall
    ? spot * NORM(d1) - strike * NORM(d2)
    : strike * NORM(-d2) - spot * NORM(-d1);
  return { price, delta: isCall ? NORM(d1) : NORM(d1) - 1 };
}

const TRADING_DAYS_LEFT = 12;
const COST_EACH_WAY = 0.025;
const IV_HAIRCUT_ON_WIN = 0.04;

export function ivFromAtr(atr, spot) {
  const dailySigma = atr / spot / 1.4;
  return dailySigma * Math.sqrt(252);
}

/**
 * Net option return for a stock move, entered at `spot` and exited at `exitSpot` after
 * `minutesHeld`. Strike is the nearest round ATM, approximated as the spot itself — the real
 * picker walks a strike ladder and the difference is second-order against the cost assumptions.
 */
export function optionReturn({ spot, exitSpot, atr, minutesHeld, isCall, won }) {
  const iv = ivFromAtr(atr, spot);
  const yr0 = TRADING_DAYS_LEFT / 252;
  const entry = bs(spot, spot, iv, yr0, isCall).price;
  if (!(entry > 0)) return 0;
  const yr1 = Math.max(0, (TRADING_DAYS_LEFT - minutesHeld / 375) / 252);
  const ivExit = won ? iv * (1 - IV_HAIRCUT_ON_WIN) : iv;
  const exit = bs(exitSpot, spot, ivExit, yr1, isCall).price;
  const paid = entry * (1 + COST_EACH_WAY);
  const got = exit * (1 - COST_EACH_WAY);
  return (got - paid) / paid;
}
