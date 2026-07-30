// Preflight: will NSE answer this machine?
//
// Run this on any host you're thinking of leaving the recorder on, BEFORE you rely on
// it. NSE is heavily bot-protected and refuses a lot of datacentre address space, so a
// VPS that looks fine can quietly get nothing but timeouts — which fills the PCR trend
// with gaps instead of failing loudly. A home connection almost always passes.
//
//   node tools/check-nse.mjs        (no dependencies, no build step — plain node)

const BASE = 'https://www.nseindia.com';
const TIMEOUT_MS = 10_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="149", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  Connection: 'keep-alive',
};

let cookie = '';

async function get(path, accept) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    headers: { ...HEADERS, Accept: accept, Referer: BASE + '/', cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { res, ms: Date.now() - t0 };
}

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => console.log(`  FAIL  ${m}`);

console.log(`\nChecking whether NSE answers this machine (${TIMEOUT_MS / 1000}s timeout per call)\n`);

let ok = true;

// 1. The handshake. NSE hands out cookies on the homepage and rejects API calls without them.
try {
  const { res, ms } = await get('/', 'text/html,application/xhtml+xml');
  const set = res.headers.getSetCookie?.() ?? [];
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  if (res.ok && cookie) pass(`handshake — ${res.status}, ${set.length} cookie(s), ${ms}ms`);
  else { fail(`handshake — ${res.status}, ${set.length} cookie(s), ${ms}ms`); ok = false; }
} catch (e) {
  fail(`handshake — ${e.name === 'TimeoutError' ? 'timed out (the usual sign of a blocked IP)' : e.message}`);
  ok = false;
}

// 2. The expiry list, then the chain itself — what the recorder actually calls.
let expiry = null;
if (ok) {
  try {
    const { res, ms } = await get('/api/option-chain-contract-info?symbol=NIFTY', 'application/json, text/plain, */*');
    const j = res.ok ? await res.json() : null;
    expiry = j?.expiryDates?.[0] ?? null;
    if (expiry) pass(`expiry list — ${res.status}, nearest ${expiry}, ${ms}ms`);
    else { fail(`expiry list — ${res.status}, ${ms}ms`); ok = false; }
  } catch (e) {
    fail(`expiry list — ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    ok = false;
  }
}

if (ok && expiry) {
  try {
    const { res, ms } = await get(
      `/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(expiry)}`,
      'application/json, text/plain, */*',
    );
    const j = res.ok ? await res.json() : null;
    const rows = j?.records?.data?.length ?? 0;
    if (rows > 10) pass(`option chain — ${res.status}, ${rows} strikes, spot ${j.records.underlyingValue}, ${ms}ms`);
    else { fail(`option chain — ${res.status}, ${rows} strikes, ${ms}ms`); ok = false; }
  } catch (e) {
    fail(`option chain — ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    ok = false;
  }
}

console.log(
  ok
    ? '\nThis machine can record. Leave the recorder running here.\n'
    : '\nNSE will not serve this machine — the recorder would only produce gaps.\n' +
      'Try a home/residential connection, or a different host, and run this again.\n',
);
process.exit(ok ? 0 : 1);
