# research/ — how the First-Hour Displacement rule was built

Everything here is offline. The data pulls are one-off; every rule test reads the local cache and
costs no Upstox quota.

## data

    fetch-minutes.ts 2026-07-20 2026-08-20    1-minute bars, one request per symbol (~23 sessions)
    fetch-more.ts 2026-06-22 2026-07-19       extend the window backwards (30 CALENDAR days max)
    fetch-today.ts 2026-08-20                 today only, via the intraday endpoint
    fetch-daily.ts 2026-03-01 2026-08-20      REAL daily bars — do not skip this, see below

`fetch-daily.ts` matters more than it looks. The first version of the study had no daily bars for
the most recent sessions and synthesised them from the 1-minute data. A synthesised close is the
15:29 minute close; the official one is the closing-auction print. That moved ATR by a median 1.3%
and up to 17% on individual names, and since every gate in the rule is ATR-scaled it was enough to
delete a signal from the holdout. With real bars the study's ATR matches production's to a median
of 1.0000 (`atr-verify.mjs`).

## the studies, in the order they were run

    study1/study2.mjs      which single readings shift P(target before stop) at all
    study3.mjs             six first-principles setups, graded on a target/stop grid
    option.mjs             the option model: BS, IV from ATR, 12 sessions out, 2.5% each way
    option-check.mjs       sanity-check it — break-even is +0.20 ATR, a flat stock costs 6.2%
    study5/study6.mjs      break vs pullback entry; the effect of hold time and strike
    study7.mjs             reversed: what did the biggest movers look like at 10:00
    study8.mjs             the base rate by decision minute — 09:25 is worth double 10:30
    search.mjs             9,504 rule/exit combinations, capped at 5.5 signals a day
    analyse.mjs            day-by-day, parameter neighbourhood, split-sample
    robust.mjs             fill delay, cost sensitivity, option-level exits
    refine.mjs             turnover floor, daily cap, the exit pair
    validate.mjs           the honest test: 19 sessions the rule was never fitted on
    rank.mjs / control.mjs THE CONTROL. Buying any liquid option at 09:46 returns −7.4% (t=−27)
    final-map.mjs          the parameter map scored against that control, split by period
    final.mjs              the shipped rule and its scale-out exit
    arrival-order.mjs      does live arrival order lose anything against ranking? No
    summary.mjs            the 35-session headline
    signals.mjs / signals4.mjs / emit-json.mjs / to-discord.ts   signal logs, per session
    why-lost.mjs           decomposition of a losing week
    holdcheck.mjs          does exiting earlier help? No
    atr-compare.mjs / baseline-freshness.mjs / atr-verify.mjs    the ATR and staleness audit

## the headline, so it is not remembered wrongly

98 signals over 35 sessions (3 Jul – 20 Aug 2026), 2.8 a day. 60% ended profitable, 43% reached
+30%, 10% reached +80%, 9% hit the −50% stop. Average +4.9% of premium against a −7.4% control.

**t = 1.57.** Not statistically significant. The profitable RATE is the stable half (61% on the
unfitted sessions, 59% on the fitted ones); the average return is not (+8.6% against +1.2%).
16 Jul and 14 Aug each went 0 for 4, and their mornings looked like 23 Jul, which went 4 for 4.

Option prices are MODELLED, not quoted — there is no historical chain in this project.
