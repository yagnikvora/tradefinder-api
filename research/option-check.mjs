import { bs, ivFromAtr, optionReturn } from './option.mjs';
const spot = 400, atr = 8.8;                  // 2.2% ATR, a typical F&O name
const iv = ivFromAtr(atr, spot);
const p = bs(spot, spot, iv, 12 / 252, true);
console.log(`spot ${spot}  ATR ${atr} (${((100 * atr) / spot).toFixed(2)}%)  implied IV ${(100 * iv).toFixed(1)}%`);
console.log(`ATM call, 12 sessions out: premium ${p.price.toFixed(2)} = ${((100 * p.price) / spot).toFixed(2)}% of spot, delta ${p.delta.toFixed(2)}`);
console.log('\nnet option return after 2.5% each way, for a move held 120 minutes:');
for (const x of [-0.6, -0.5, -0.4, -0.3, 0, 0.3, 0.4, 0.5, 0.75, 1.0, 1.5]) {
  const r = optionReturn({ spot, exitSpot: spot + x * atr, atr, minutesHeld: 120, isCall: true, won: x > 0 });
  console.log(`  ${x >= 0 ? '+' : ''}${x.toFixed(2)} ATR (${(x * 100 * atr / spot).toFixed(2)}% of spot)  ->  ${(100 * r >= 0 ? '+' : '') + (100 * r).toFixed(1)}%`);
}
console.log('\nbreak-even underlying move:');
for (let x = 0; x < 0.4; x += 0.01) {
  const r = optionReturn({ spot, exitSpot: spot + x * atr, atr, minutesHeld: 120, isCall: true, won: true });
  if (r >= 0) { console.log(`  +${x.toFixed(2)} ATR = ${(x * 100 * atr / spot).toFixed(2)}% of the stock, just to get your money back`); break; }
}
