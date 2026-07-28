// Score our R.Factor against tradefinder's published one.
//
//   node tools/rfac-validate.mjs [captureFile] [YYYY-MM-DD]
//
// Truth comes from a logged-in capture of the live Sector Scope page, which prints
// (prev close, % change, R.Factor) per row — default ../../captures/sector-scope.txt,
// taken 2026-07-02 after the close. Our side is rebuilt from NSE bhavcopy out of the
// API's own volume cache, so this scores the shipped formula rather than a re-derivation
// of it: today's range over the trailing mean range, times RFACTOR_CALIBRATION.
//
// Both sides must describe the SAME instant. The capture is post-close and bhavcopy is a
// full session, so they line up; a mid-session capture would need the sessionFraction
// adjustment from services.ts applied first and is not comparable as-is.
//
// Re-run this whenever their numbers look off. If `calibrated` has drifted away from
// their median while `pearson` stays high, only RFACTOR_CALIBRATION needs moving; if
// pearson itself has fallen, the formula is what changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = process.argv[2] || path.join(__dirname, '..', '..', '..', 'captures', 'sector-scope.txt');
const DAY = process.argv[3] || '2026-07-02';
const CACHE = path.join(__dirname, '..', '.cache', 'volume-history.json');
const CALIBRATION = 1.33; // keep in step with RFACTOR_CALIBRATION in src/services.ts

// ---- their numbers ---------------------------------------------------------
// Rows render as SYMBOL followed by three numeric cells (prev close, %, R.Factor),
// separated by the empty cells of the icon columns.
const isSym = (s) => /^[A-Z][A-Z0-9&-]{1,14}$/.test(s);
const num = (s) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

function parseCapture(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!isSym(lines[i]) || out.has(lines[i])) continue;
    const vals = [];
    for (let j = i + 1; j < Math.min(i + 12, lines.length) && vals.length < 3; j++) {
      if (isSym(lines[j])) break;
      const n = num(lines[j]);
      if (n !== null) vals.push(n);
    }
    // 0.00 means their feed had no data for the symbol, not a genuine reading.
    if (vals.length === 3 && vals[2] > 0) out.set(lines[i], vals[2]);
  }
  return out;
}

// ---- stats -----------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pearson = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db);
};
const rank = (a) => {
  const order = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(a.length);
  order.forEach(([, i], k) => { out[i] = k; });
  return out;
};
const spearman = (a, b) => pearson(rank(a), rank(b));

// ---- our numbers -----------------------------------------------------------
const theirsBySym = parseCapture(CAPTURE);
const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const today = cache.days[DAY];
if (!today) {
  console.error(`no bhavcopy for ${DAY} in ${CACHE} — run the API once so it backfills, or pick a cached date`);
  process.exit(1);
}
const past = Object.keys(cache.days).filter((k) => k < DAY).sort();

const rows = [];
for (const [sym, theirs] of theirsBySym) {
  if (!today[sym]) continue;
  const hist = past.map((k) => cache.days[k]?.[sym]?.[1]).filter((x) => Number.isFinite(x) && x > 0);
  if (hist.length < 10) continue; // too little history for the baseline to mean anything
  const raw = today[sym][1] / mean(hist);
  rows.push({ sym, theirs, raw, calibrated: raw * CALIBRATION });
}

if (!rows.length) { console.error('no overlap between capture and cached bhavcopy'); process.exit(1); }

const theirs = rows.map((r) => r.theirs);
console.log(`capture ${path.basename(CAPTURE)} · session ${DAY} · ${rows.length} symbols · baseline ${past.length} sessions\n`);
console.log('variant'.padEnd(22), 'pearson  spearman  meanAbsDiff  median(ours vs theirs)');
for (const k of ['raw', 'calibrated']) {
  const ours = rows.map((r) => r[k]);
  console.log(
    k.padEnd(22),
    pearson(ours, theirs).toFixed(3).padStart(6),
    spearman(ours, theirs).toFixed(3).padStart(9),
    mean(rows.map((r) => Math.abs(r[k] - r.theirs))).toFixed(3).padStart(12),
    `${median(ours).toFixed(2)} vs ${median(theirs).toFixed(2)}`.padStart(23),
  );
}
console.log(`\nimplied calibration (median theirs/raw): ${median(rows.map((r) => r.theirs / r.raw)).toFixed(3)}`);
console.log('\nlargest gaps:');
for (const r of [...rows].sort((a, b) => Math.abs(b.calibrated - b.theirs) - Math.abs(a.calibrated - a.theirs)).slice(0, 10))
  console.log(' ', r.sym.padEnd(12), 'theirs', r.theirs.toFixed(2).padStart(6), ' ours', r.calibrated.toFixed(2).padStart(6));
