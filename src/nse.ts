// NSE public-data client. NSE needs a browser-like session: hit the homepage
// first for cookies, then send cookies + realistic UA + Referer on API calls.
const BASE = 'https://www.nseindia.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

let cookie = '';
let cookieAt = 0;

// NSE doesn't always refuse politely — when it doesn't like a client it will often
// accept the socket and then never answer. Without a deadline that hangs the request
// forever, which defeats the mock fallback in services.ts (its catch never fires) and
// leaves the whole page spinning. Every call gets a hard timeout.
const TIMEOUT_MS = Number(process.env.NSE_TIMEOUT_MS) || 8000;

// Callers run in parallel, so without this every one of them would open its own
// handshake at cold start. NSE reads a burst of homepage hits as bot traffic and
// tarpits the lot, which is worse than useless — they all then time out together.
// One in-flight refresh is shared by everyone waiting on it.
let refreshing: Promise<void> | null = null;

// Headers a real Chrome tab sends. NSE inspects these; a bare UA gets you a 403
// or, more often, an accepted socket that never answers.
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="149", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Connection: 'keep-alive',
};

async function refreshCookie(force = false): Promise<void> {
  if (!force && cookie && Date.now() - cookieAt < 5 * 60 * 1000) return;
  if (refreshing) return refreshing; // piggyback on the handshake already running
  refreshing = (async () => {
    try {
      const res = await fetch(BASE + '/', {
        headers: { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const set = (res.headers as any).getSetCookie?.() ?? [];
      if (set.length) {
        cookie = set.map((c: string) => c.split(';')[0]).join('; ');
        cookieAt = Date.now();
      }
    } catch {
      // A failed handshake must not fail the request that asked for it. The homepage
      // is the first thing NSE tarpits, and rejecting here threw out of every nseGet
      // at once — one slow homepage hit took down the whole page. An expired cookie is
      // often still accepted, and if it isn't, the 401/403 replay below gets another go.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function get(path: string): Promise<Response> {
  return fetch(BASE + path, {
    headers: { ...BROWSER_HEADERS, Accept: 'application/json, text/plain, */*', Referer: BASE + '/', cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function nseGet<T = any>(path: string): Promise<T> {
  await refreshCookie();
  let res = await get(path);
  // A rejected session is usually recoverable: re-handshake once and replay, rather
  // than failing the whole page over an expired cookie.
  if (res.status === 401 || res.status === 403) {
    await refreshCookie(true);
    res = await get(path);
  }
  if (!res.ok) throw new Error(`NSE ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}


export interface NseConstituent {
  symbol: string; lastPrice: number; previousClose: number; pChange: number;
  totalTradedValue?: number; totalTradedVolume?: number; priority?: number; change?: number;
  dayHigh?: number; dayLow?: number; open?: number;
}
export interface NseIndexResp { data: NseConstituent[]; }

export function indexConstituents(index = 'NIFTY 50') {
  return nseGet<NseIndexResp>(`/api/equity-stock-indices?index=${encodeURIComponent(index)}`);
}

// ---------------------------------------------------------------------------
// Option-tradable (F&O) universe.
//
// Symbol universe  = the NSE stocks that have equity derivatives (futures &
//                    options). Sourced live from NSE's own master-quote endpoint,
//                    so it stays current as NSE adds/removes F&O names. Only these
//                    stocks can be option-traded — non-F&O equities are excluded.
// Live prices      = merged from the broad indices that carry these names (NIFTY
//                    500 covers essentially the entire F&O list; others widen it).
// ---------------------------------------------------------------------------

// NSE's authoritative list of underlyings that have stock options/futures.
// Returns just the ~210 F&O stock symbols (no index underlyings like NIFTY/BANKNIFTY).
const FNO_MASTER_URL = '/api/master-quote';

// Broad-market indices to pull live quotes from. NIFTY 500 alone covers almost the
// whole F&O list; the others fill any gaps. Any index NSE won't serve is skipped.
const BROAD_INDICES = [
  'NIFTY 500',            // reliable core — contains ~all F&O names
  'NIFTY TOTAL MARKET',   // widens coverage when served
  'NIFTY MIDSMALLCAP 400',
];

// Static fallback: the F&O stocks as of 2026-07 (used only if master-quote is
// unreachable). The live fetch keeps the real universe current.
const FNO_FALLBACK: string[] = [
  "360ONE", "ABB", "ABCAPITAL", "ADANIENSOL", "ADANIENT", "ADANIGREEN", "ADANIPORTS", "ADANIPOWER",
  "ALKEM", "AMBER", "AMBUJACEM", "ANGELONE", "APLAPOLLO", "APOLLOHOSP", "ASHOKLEY", "ASIANPAINT",
  "ASTRAL", "AUBANK", "AUROPHARMA", "AXISBANK", "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BANDHANBNK",
  "BANKBARODA", "BANKINDIA", "BDL", "BEL", "BHARATFORG", "BHARTIARTL", "BHEL", "BIOCON", "BLUESTARCO",
  "BOSCHLTD", "BSE", "CAMS", "CANBK", "CDSL", "CGPOWER", "CHOLAFIN", "CIPLA", "COALINDIA", "COFORGE",
  "CONCOR", "CROMPTON", "CUMMINSIND", "DABUR", "DALBHARAT", "DELHIVERY", "DIVISLAB", "DIXON", "DLF",
  "DMART", "DRREDDY", "EICHERMOT", "ETERNAL", "EXIDEIND", "FEDERALBNK", "FORTIS", "GAIL", "GLENMARK",
  "GMRAIRPORT", "GODREJCP", "GODREJPROP", "GRASIM", "HAL", "HCLTECH", "HDFCAMC", "HDFCBANK", "HDFCLIFE",
  "HEROMOTOCO", "HINDALCO", "HINDPETRO", "HINDUNILVR", "HINDZINC", "HUDCO", "ICICIBANK", "ICICIGI",
  "ICICIPRULI", "IDEA", "IDFCFIRSTB", "IEX", "IGL", "INDHOTEL", "INDIANB", "INDIGO", "INDUSINDBK",
  "INDUSTOWER", "INFY", "INOXWIND", "IOC", "IRCTC", "IREDA", "IRFC", "ITC", "JINDALSTEL", "JIOFIN",
  "JSWENERGY", "JSWSTEEL", "JUBLFOOD", "KALYANKJIL", "KAYNES", "KEI", "KFINTECH", "KOTAKBANK",
  "KPITTECH", "LAURUSLABS", "LICHSGFIN", "LICI", "LODHA", "LT", "LTF", "LTIM", "LUPIN", "M&M",
  "MANAPPURAM", "MANKIND", "MARICO", "MARUTI", "MAXHEALTH", "MAZDOCK", "MCX", "MFSL", "MOTHERSON",
  "MPHASIS", "MUTHOOTFIN", "NATIONALUM", "NAUKRI", "NBCC", "NCC", "NESTLEIND", "NHPC", "NMDC", "NTPC",
  "NUVAMA", "NYKAA", "OBEROIRLTY", "OFSS", "OIL", "ONGC", "PAGEIND", "PATANJALI", "PAYTM", "PERSISTENT",
  "PETRONET", "PFC", "PGEL", "PHOENIXLTD", "PIDILITIND", "PIIND", "PNB", "PNBHOUSING", "POLICYBZR",
  "POLYCAB", "POWERGRID", "PPLPHARMA", "PRESTIGE", "RBLBANK", "RECLTD", "RELIANCE", "RVNL", "SAIL",
  "SBICARD", "SBILIFE", "SBIN", "SHREECEM", "SHRIRAMFIN", "SIEMENS", "SOLARINDS", "SONACOMS", "SRF",
  "SUNPHARMA", "SUPREMEIND", "SUZLON", "SWIGGY", "TATACHEM", "TATACOMM", "TATACONSUM", "TATAELXSI",
  "TATAMOTORS", "TATAPOWER", "TATASTEEL", "TATATECH", "TCS", "TECHM", "TIINDIA", "TITAGARH", "TITAN",
  "TORNTPHARM", "TORNTPOWER", "TRENT", "TVSMOTOR", "ULTRACEMCO", "UNIONBANK", "UNITDSPR", "UNOMINDA",
  "UPL", "VBL", "VEDL", "VOLTAS", "WIPRO", "YESBANK", "ZYDUSLIFE",
];

// A day-cached list of option-tradable stock symbols.
let fnoCache: { symbols: string[]; at: number } | null = null;
const DAY = 24 * 60 * 60 * 1000;

// The list of NSE stocks that have options (F&O-enabled), fetched live from
// master-quote and cached ~1 day. Falls back to the static list if unreachable.
export async function fnoSymbols(): Promise<string[]> {
  if (fnoCache && Date.now() - fnoCache.at < DAY) return fnoCache.symbols;
  try {
    const arr = await nseGet<string[]>(FNO_MASTER_URL);
    // master-quote returns a flat array of F&O underlying symbols (stocks only).
    const symbols = (Array.isArray(arr) ? arr : []).filter((s) => typeof s === 'string' && s);
    if (symbols.length >= 100) {
      fnoCache = { symbols, at: Date.now() };
      return symbols;
    }
    throw new Error(`master-quote returned only ${symbols.length} symbols`);
  } catch {
    fnoCache = { symbols: FNO_FALLBACK, at: Date.now() };
    return FNO_FALLBACK;
  }
}

// Merge live constituent rows from every broad index that responds, deduped by symbol.
export async function liveBroadConstituents(): Promise<NseConstituent[]> {
  const bySymbol = new Map<string, NseConstituent>();
  let anyOk = false;
  let rehandshaked = false;
  for (const idx of BROAD_INDICES) {
    try {
      const j = await indexConstituents(idx);
      const rows = (j.data || []).filter((r) => r.symbol && r.symbol !== idx && r.lastPrice != null);
      if (rows.length) anyOk = true;
      for (const r of rows) if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);
    } catch {
      // Skip an index NSE won't serve right now — but the usual reason all three fail
      // together is a session NSE has stopped answering, and that shows up as a timeout
      // rather than the 401/403 nseGet replays on. Force one fresh handshake and let the
      // remaining indices try with it, instead of losing the whole universe to a dead cookie.
      if (!rehandshaked) { rehandshaked = true; await refreshCookie(true); }
    }
  }
  if (!anyOk) throw new Error('no broad index returned live data');
  return [...bySymbol.values()];
}

// Market Pulse feed: only option-tradable (F&O) stocks, each row carrying a live
// NSE quote. Non-F&O equities are excluded entirely.
export async function marketConstituents(): Promise<NseConstituent[]> {
  const [fno, live] = await Promise.all([fnoSymbols(), liveBroadConstituents()]);
  const tradable = new Set(fno);
  const rows = live.filter((r) => tradable.has(r.symbol));
  // Coverage guard. NIFTY 500 carries nearly the whole F&O list on its own, so when it
  // is the index NSE declines and MIDSMALLCAP is the one that answers, this returns a
  // universe with every large cap (RELIANCE, HDFCBANK, TCS…) quietly missing — around
  // half the usual rows. That renders as a plausible-looking but wrong board, which is
  // worse than an outage, so fail and let the caller serve the last good snapshot.
  if (rows.length < tradable.size * 0.7)
    throw new Error(`partial universe: ${rows.length}/${tradable.size} F&O symbols priced`);
  return rows;
}

export interface NseOptionLeg { openInterest: number; changeinOpenInterest: number; }
export interface NseOptionRow {
  strikePrice: number;
  // v3 omits this on the rows — the chain it returns is already a single expiry.
  expiryDate?: string;
  CE?: NseOptionLeg;
  PE?: NseOptionLeg;
}
export interface NseOptionChain {
  records: {
    data: NseOptionRow[];
    expiryDates: string[];
    underlyingValue: number;
    timestamp?: string; // "30-Jul-2026 15:30:00", IST — when NSE last stamped the chain
  };
}

// Expiry dates for an index, nearest first ("04-Aug-2026"). Separate call because the
// option chain itself now needs an expiry up front, so there's nothing to read it from.
export async function optionExpiries(symbol = 'NIFTY'): Promise<string[]> {
  const j = await nseGet<{ expiryDates?: string[] }>(
    `/api/option-chain-contract-info?symbol=${encodeURIComponent(symbol)}`,
  );
  const list = j?.expiryDates ?? [];
  if (!list.length) throw new Error(`no expiries for ${symbol}`);
  return list;
}

// One expiry's option chain, with open interest and today's OI change per strike.
//
// The `expiry` parameter is not optional to NSE even though it reads that way: v3
// answers 200 with an empty body when it's missing, and the older
// /api/option-chain-indices path — which did serve the whole chain at once — now 404s.
export async function optionChain(symbol = 'NIFTY', expiry?: string): Promise<NseOptionChain> {
  const exp = expiry || (await optionExpiries(symbol))[0];
  const j = await nseGet<NseOptionChain>(
    `/api/option-chain-v3?type=Indices&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(exp)}`,
  );
  if (!j?.records?.data?.length) throw new Error(`empty option chain for ${symbol} ${exp}`);
  return j;
}
