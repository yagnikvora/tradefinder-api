// The production baseline carries a symbol's readings forward when Upstox refuses it during the
// morning build — deliberate, and documented in baseline.ts as better than losing that stock's
// alerts for the day. What is NOT visible anywhere is how often it happens, or how stale the
// carried readings are, and every gate in the displacement rule is ATR-scaled.
//
// So: how many symbols in today's baseline are carried, how far back, and does a FRESH symbol's
// ATR agree with the study's?

import { readFileSync } from 'node:fs';
import { loadUniverse } from './lab.mjs';

const live = JSON.parse(readFileSync('.cache/momentum/baseline.json', 'utf8'));
const real = JSON.parse(readFileSync('research/data/daily-real.json', 'utf8')).symbols;
const U = loadUniverse();
const day = live.day;

const syms = Object.keys(live.symbols);
const carried = syms.filter((s) => live.symbols[s].carriedFrom);
console.log(`baseline day ${day}, built ${new Date(live.builtAt).toISOString()}`);
console.log(`${syms.length} symbols · ${carried.length} carried forward (${((100 * carried.length) / syms.length).toFixed(0)}%) · reported \`carried\` field: ${live.carried ?? 'absent'}\n`);

const ages = {};
for (const s of carried) {
  const from = live.symbols[s].carriedFrom;
  ages[from] = (ages[from] || 0) + 1;
}
console.log('carried from:');
for (const k of Object.keys(ages).sort()) console.log(`  ${k}  ${ages[k]} symbols`);

// How stale is a carried prevClose, in completed sessions?
const sessionsOf = (sym) => (real[sym] ?? []).map((b) => b[0]).filter((d) => d < day);
let staleBy = [];
for (const s of carried) {
  const days = sessionsOf(s);
  const pc = live.symbols[s].prevClose;
  const idx = (real[s] ?? []).findIndex((b) => b[0] < day && Math.abs(b[4] - pc) < 0.02);
  if (idx >= 0) {
    const matched = real[s][idx][0];
    staleBy.push({ sym: s, matched, behind: days.length - 1 - days.indexOf(matched) });
  }
}
staleBy.sort((a, b) => b.behind - a.behind);
if (staleBy.length) {
  const behind = staleBy.map((x) => x.behind);
  console.log(`\ncarried prevClose is behind the true previous session by:`);
  console.log(`  median ${behind[Math.floor(behind.length / 2)]} sessions, worst ${behind[0]} sessions`);
  for (const x of staleBy.slice(0, 5))
    console.log(`  ${x.sym.padEnd(12)} baseline's "previous close" is actually ${x.matched} — ${x.behind} sessions behind`);
}

// The decisive test: on FRESH symbols, does the study's ATR match production's?
const fresh = [], stale = [];
for (const [sym, r] of U.byDay.get(day) ?? []) {
  const b = live.symbols[sym];
  if (!b || !(b.atr > 0) || !(r.atr > 0)) continue;
  (b.carriedFrom ? stale : fresh).push(b.atr / r.atr);
}
const stats = (a, label) => {
  if (!a.length) { console.log(`  ${label}: none`); return; }
  a.sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const off = a.filter((v) => Math.abs(v - 1) > 0.02).length;
  console.log(`  ${label.padEnd(28)} n=${String(a.length).padStart(3)}  median ${a[Math.floor(a.length / 2)].toFixed(4)}  mean ${mean.toFixed(4)}  more than 2% out: ${((100 * off) / a.length).toFixed(0)}%`);
};
console.log('\nproduction ATR / study ATR');
stats(fresh, 'symbols built today');
stats(stale, 'symbols carried forward');
