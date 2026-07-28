// Deterministic mock data — identical shapes to live — so the app always runs.
import type {
  MarketPulse, SectorScope, IndexMover, OptionAnalysis, ScannerGroups, FiiDiiRow, Signal,
} from './types.js';
import { SECTOR_BASKETS } from './sectors.js';

// Broad Indian-market sample used when NSE is unreachable — spans large/mid/small caps
// so the mock fallback looks like the real universal universe, not just NIFTY 50.
const MARKET_SAMPLE = [
  'RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','BHARTIARTL','LT','ITC','AXISBANK',
  'KOTAKBANK','HINDUNILVR','BAJFINANCE','MARUTI','SUNPHARMA','TITAN','ONGC','NTPC','POWERGRID','WIPRO',
  'ADANIENT','ADANIPORTS','TATASTEEL','JSWSTEEL','COALINDIA','TATAMOTORS','M&M','HCLTECH','TECHM','ULTRACEMCO',
  'NESTLEIND','DRREDDY','CIPLA','GRASIM','EICHERMOT','HEROMOTOCO','BPCL','DIVISLAB','APOLLOHOSP','SBILIFE',
  'DLF','LODHA','GODREJPROP','OBEROIRLTY','PHOENIXLTD','PRESTIGE','BEL','HAL','BDL','MAZDOCK',
  'COCHINSHIP','RVNL','IRFC','RECLTD','PFC','PNB','CANBK','BANKBARODA','UNIONBANK','INDIANB',
  'IDFCFIRSTB','FEDERALBNK','AUBANK','RBLBANK','BANDHANBNK','CHOLAFIN','SHRIRAMFIN','MUTHOOTFIN','LICHSGFIN','PNBHOUSING',
  'ZOMATO','SWIGGY','NYKAA','PAYTM','POLICYBZR','DELHIVERY','IRCTC','INDHOTEL','JUBLFOOD','TRENT',
  'DMART','VBL','TATACONSUM','MARICO','GODREJCP','DABUR','COLPAL','UNITDSPR','PGHH','GILLETTE',
  'DIXON','KAYNES','AMBER','POLYCAB','KEI','HAVELLS','VOLTAS','BLUESTARCO','CROMPTON','WHIRLPOOL',
  'CGPOWER','POWERINDIA','SIEMENS','ABB','THERMAX','SUZLON','INOXWIND','WAAREEENER','PREMIERENE','IREDA',
  'TATAPOWER','JSWENERGY','NHPC','SJVN','ADANIGREEN','ADANIENSOL','ADANIPOWER','TORNTPOWER','CESC','GAIL',
  'PETRONET','IGL','MGL','GUJGASLTD','OIL','MRPL','HINDPETRO','CASTROLIND','GULFOILLUB','AEGISLOG',
  'VEDL','HINDALCO','NATIONALUM','HINDZINC','NMDC','SAIL','JINDALSTEL','APLAPOLLO','RATNAMANI','WELCORP',
  'AUROPHARMA','LUPIN','BIOCON','ALKEM','GLENMARK','ZYDUSLIFE','TORNTPHARM','MANKIND','LAURUSLABS','GLAND',
  'MAXHEALTH','FORTIS','NH','MEDANTA','ASTERDM','SYNGENE','METROPOLIS','LALPATHLAB','KIMS','RAINBOW',
  'PERSISTENT','COFORGE','MPHASIS','LTIM','LTTS','OFSS','KPITTECH','TATAELXSI','CYIENT','SONATSOFTW',
  'MOTHERSON','BOSCHLTD','BHARATFORG','EXIDEIND','UNOMINDA','ASHOKLEY','TVSMOTOR','BAJAJ-AUTO','ESCORTS','SONACOMS',
  'PIIND','SRF','DEEPAKNTR','AARTIIND','NAVINFLUOR','ATUL','TATACHEM','GNFC','COROMANDEL','CHAMBLFERT',
  'AMBUJACEM','SHREECEM','DALBHARAT','JKCEMENT','RAMCOCEM','ACC','INDIACEM','HEIDELBERG','NUVAMA','ANGELONE',
];
// Alias for the smaller mock functions (index mover / scanners) that just need a symbol pool.
const SYM = MARKET_SAMPLE;
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pct = () => +(rnd() * 8 - 3).toFixed(2);
const price = () => +(rnd() * 4000 + 100).toFixed(1);
const now = () => Math.floor(Date.now() / 1000);
const sig = (p: number): Signal => (p >= 0 ? 'BULL' : 'BEAR');
const dt = (h = 6) => new Date(Date.now() - Math.floor(rnd() * h * 3600e3)).toISOString().slice(0, 19).replace('T', ' ');

// A mock snapshot over a broad Indian-market sample, matching the live param_N schema.
export function mockMarketPulse(): MarketPulse {
  seed = 42; // reset so the same fallback snapshot is produced each call
  const rows = MARKET_SAMPLE.map((Symbol) => {
    const ltp = price();
    const p = pct();
    const prevClose = +(ltp / (1 + p / 100)).toFixed(2);
    const swing = Math.abs(p) / 100 + rnd() * 0.02 + 0.005;
    const dayHigh = +(Math.max(ltp, prevClose) * (1 + swing * rnd())).toFixed(2);
    const dayLow = +(Math.min(ltp, prevClose) * (1 - swing * rnd())).toFixed(2);
    const turnover = +(rnd() * 3500 + 20).toFixed(2);
    const rFactor = +Math.min(0.5 + Math.abs(p) / 2 + turnover / 2000, 5).toFixed(2);
    return { Symbol, ltp, prevClose, p, dayHigh, dayLow, turnover, rFactor };
  });

  return {
    breakout_beacon: rows
      .map((x) => ({ Symbol: x.Symbol, param_0: x.p, param_1: +(x.p * (0.35 + rnd() * 0.45)).toFixed(2), param_2: sig(x.p), param_3: now() - Math.floor(rnd() * 21600) }))
      .sort((a, b) => Math.abs(b.param_1) - Math.abs(a.param_1)),
    intraday_boost: [...rows].sort((a, b) => b.rFactor - a.rFactor).slice(0, 80)
      .map((x) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: x.rFactor })),
    top_gainers: [...rows].sort((a, b) => b.p - a.p).slice(0, 25)
      .map((x) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: x.rFactor })),
    top_losers: [...rows].sort((a, b) => a.p - b.p).slice(0, 25)
      .map((x) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: x.rFactor })),
    high_powered_stocks: [...rows].sort((a, b) => b.turnover - a.turnover).slice(0, 50)
      .map((x) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: x.turnover })),
    top_level_stocks: [...rows]
      .map((x) => ({ x, d: +Math.max(0, (x.dayHigh - x.ltp) / (x.dayHigh || 1)).toFixed(2) }))
      .sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ x, d }) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: d })),
    low_level_stocks: [...rows]
      .map((x) => ({ x, d: +Math.max(0, (x.ltp - x.dayLow) / (x.dayLow || 1)).toFixed(2) }))
      .sort((a, b) => a.d - b.d).slice(0, 25)
      .map(({ x, d }) => ({ Symbol: x.Symbol, param_0: x.ltp, param_1: x.prevClose, param_2: x.p, param_3: d })),
  };
}

export function mockSectorScope(): SectorScope {
  const out: SectorScope = {};
  // Same baskets the live path uses, so a mock day has the same shape and grouping.
  for (const [sec, list] of Object.entries(SECTOR_BASKETS))
    out[sec] = list.map((s) => { const ltp = price(); const p = pct();
      const prevClose = +(ltp/(1+p/100)).toFixed(1);
      // Open wanders either side of prev close so the signal arrow isn't just sign(%).
      return { Symbol: s, ltp, open: +(prevClose*(1+(rnd()-0.5)*0.02)).toFixed(2), prevClose, pChange: p,
        rFactor: +(rnd()*3+0.3).toFixed(2), weight: +(rnd()*9+1).toFixed(2) }; });
  return out;
}

export function mockIndexMover(index = 'NIFTY 50'): IndexMover {
  const level = 24080; const stocks = []; let up = 0, down = 0, tot = 0;
  for (const s of SYM) { const p = pct(); const w = rnd()*0.06; const pts = level*w*(p/100);
    tot += pts; p>=0?up++:down++;
    stocks.push({ Symbol: s, per_change: p, per_to_index: +(w*p/100).toFixed(6), point_to_index: +pts.toFixed(3) }); }
  return { index, level, points: +tot.toFixed(2), pct: +(tot/level*100).toFixed(2), gainers: up, losers: down, stocks };
}

export function mockOption(symbol = 'NIFTY'): OptionAnalysis {
  const spot = 24081; const atm = Math.round(spot/50)*50; const rows = [];
  for (let k = atm-500; k <= atm+500; k += 50) { const d = Math.abs(k-atm)/50;
    rows.push({ strike: k,
      ceOI: Math.round((k>=atm?120000:40000)*(1+rnd())/(1+d*0.2)), peOI: Math.round((k<=atm?120000:40000)*(1+rnd())/(1+d*0.2)),
      ceChg: Math.round((rnd()-0.5)*20000), peChg: Math.round((rnd()-0.5)*20000) }); }
  const pcr = rows.reduce((a,r)=>a+r.peOI,0)/rows.reduce((a,r)=>a+r.ceOI,0);
  const maxPain = rows.slice().sort((a,b)=>(a.ceOI+a.peOI)-(b.ceOI+b.peOI))[0].strike;
  return { symbol, spot, atm, expiry: '07-Jul-2026', expiries: ['07-Jul-2026','14-Jul-2026','31-Jul-2026'], rows, pcr: +pcr.toFixed(2), maxPainStrike: atm };
}

export function mockScanners(keys: string[]): ScannerGroups {
  const out: ScannerGroups = {};
  for (const k of keys) out[k] = SYM.slice(0, 12 + Math.floor(rnd()*8)).map((s) => { const p = pct();
    return { Symbol: s, pChange: p, price: price(), signal: sig(p), when: dt(), score: +(rnd()*4).toFixed(2) }; });
  return out;
}

export function mockFiiDii(): FiiDiiRow[] {
  const rows: FiiDiiRow[] = [];
  for (let i = 0; i < 20; i++) { const ts = now()-i*86400;
    const fb = +(10000+rnd()*15000).toFixed(2), fs = +(10000+rnd()*15000).toFixed(2);
    const db = +(10000+rnd()*10000).toFixed(2), ds = +(8000+rnd()*10000).toFixed(2);
    rows.push({ date: new Date(ts*1000).toISOString().slice(0,10), fiiBuy: fb, fiiSell: fs, fiiNet: +(fb-fs).toFixed(2),
      inMarket: +(fb+fs).toFixed(2), diiNet: +(db-ds).toFixed(2), diiBuy: db, diiSell: ds }); }
  return rows;
}
