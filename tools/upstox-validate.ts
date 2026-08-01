// Upstox connectivity check.  Run: npm run check-upstox
//
// Answers the three things that actually go wrong, in order:
//   1. is a token present at all, and does Upstox accept it?
//   2. does it reach /v2/option/chain — the endpoint the PCR dial depends on?
//   3. does it reach /v2/market/pcr — the intraday trend, which is a bonus and which the
//      Analytics Token's published scope does not name?
//
// Also prints the ratio next to the spot Upstox reports, so a wrong instrument key shows
// up as an obviously wrong index level rather than as a plausible number.

import '../src/env.js';
import { INSTRUMENT_KEY, optionChain, pcrSeries, tokenSet } from '../src/upstox.js';
import { resolveExp, todayIST } from '../src/clock.js';

const money = (n: number) => n.toLocaleString('en-IN');

if (!tokenSet()) {
  console.error(
    '\n  UPSTOX_ACCESS_TOKEN is not set.\n\n' +
    '  Put your Upstox Analytics Token in api/.env:\n\n' +
    '      UPSTOX_ACCESS_TOKEN=<paste it here>\n\n' +
    '  Generate one at https://account.upstox.com/developer/apps\n' +
    '  -> Analytics tab -> Generate Token -> Confirm -> copy icon.\n' +
    '  Use the ANALYTICS token (valid 1 year), not the daily OAuth access token.\n',
  );
  process.exit(1);
}

let failed = 0;
let trendOk = 0;
const day = todayIST();

console.log(`\n  token present. Checking ${Object.keys(INSTRUMENT_KEY).length} indices for ${day}.\n`);

for (const script of Object.keys(INSTRUMENT_KEY)) {
  // The expiry comes from the same NSE list the rest of the page uses, so the ratio can
  // never describe a different contract than the ladder on screen.
  let iso: string;
  try {
    iso = await resolveExp(script);
  } catch (e) {
    console.log(`  ${script.padEnd(11)} SKIP  could not resolve an expiry: ${(e as Error).message}`);
    continue;
  }

  try {
    const { data } = await optionChain(script, iso);
    console.log(
      `  ${script.padEnd(11)} OK    exp ${iso}  spot ${data.spot}  ` +
      `PCR ${data.pcr.toFixed(3)}  put OI ${money(data.putOi)}  call OI ${money(data.callOi)}  ` +
      `${data.rows.length} strikes`,
    );
  } catch (e) {
    failed++;
    console.log(`  ${script.padEnd(11)} FAIL  ${(e as Error).message}`);
    continue;
  }

  const trend = await pcrSeries(script, iso, day, 15);
  if (trend.readings.length) {
    trendOk++;
    const first = trend.readings[0], last = trend.readings[trend.readings.length - 1];
    console.log(`  ${''.padEnd(11)} trend ${trend.readings.length} readings @${trend.bucketMinutes}m  ` +
      `${first.time} ${first.pcr} -> ${last.time} ${last.pcr}`);
  } else {
    console.log(`  ${''.padEnd(11)} trend none — ${trend.unavailable ?? 'Upstox served no readings for this day'}`);
  }
}

console.log(
  failed
    ? `\n  ${failed} index/indices FAILED — the PCR dial will report an error for those.\n`
    : '\n  All indices answered. The PCR and Sentiment dials will work.' +
      (trendOk
        ? '\n  The intraday PCR trend is available too.\n'
        : '\n  No intraday trend: this token is not entitled to /v2/market/pcr, or the day has no\n' +
          '  readings yet. The dial still works — only the sparkline under it is omitted.\n'),
);
process.exit(failed ? 1 : 0);
