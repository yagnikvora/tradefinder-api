// Sector baskets for Sector Scope, mirroring the groups the real tradefinder.in
// widget shows. These are the F&O-tradable members of each index — NSE's raw index
// constituents include non-F&O names the widget leaves out, so the membership is
// pinned here rather than derived. Refresh if NSE reshuffles an index.
//
// Membership is not "the NSE index"; it is whatever tradefinder's own /api_be/data/
// order/all_sector bucket contains, which drifts from the index in both directions
// (their BANK carries BANKINDIA + INDIANB, which NIFTY BANK does not; their AUTO drops
// FORCEMOT and HYUNDAI, which the NSE auto index carries). Every basket below is
// reconciled against a logged-in capture of the live page — see
// ../../../captures/sector-scope.txt for the row-by-row source. Stock COUNT is the
// cheap check: the live page prints "N stocks Up / M stocks Down" per sector, and N+M
// has to equal the basket length here.
//
// Key order matters: the page renders its sector cards in this order, not by strength.
export const SECTOR_BASKETS: Record<string, string[]> = {
  "METAL": ["ADANIENT", "APLAPOLLO", "HINDALCO", "HINDZINC", "JINDALSTEL", "JSWSTEEL", "NATIONALUM", "NMDC", "SAIL", "TATASTEEL", "VEDL"],
  "PSU BANK": ["BANKBARODA", "BANKINDIA", "CANBK", "INDIANB", "PNB", "SBIN", "UNIONBANK"],
  "REALTY": ["DLF", "GODREJPROP", "LODHA", "NBCC", "OBEROIRLTY", "PHOENIXLTD", "PRESTIGE"],
  "ENERGY": ["ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "BDL", "BHEL", "BLUESTARCO", "BPCL", "CGPOWER", "COALINDIA", "GAIL", "GMRAIRPORT", "GVT&D", "HINDPETRO", "INOXWIND", "IOC", "IREDA", "JSWENERGY", "MAZDOCK", "NHPC", "NTPC", "OIL", "ONGC", "PETRONET", "POWERGRID", "POWERINDIA", "PREMIERENE", "RELIANCE", "SIEMENS", "SOLARINDS", "SUZLON", "TATAPOWER", "WAAREEENER"],
  // NSE's auto index also lists FORCEMOT and HYUNDAI; tradefinder's bucket does not.
  "AUTO": ["ASHOKLEY", "BAJAJ-AUTO", "BHARATFORG", "BOSCHLTD", "EICHERMOT", "EXIDEIND", "HEROMOTOCO", "M&M", "MARUTI", "MOTHERSON", "SONACOMS", "TIINDIA", "TMPV", "TVSMOTOR", "UNOMINDA"],
  // LTM and NAUKRI sit in the NSE IT index but not in tradefinder's IT bucket.
  "IT": ["CAMS", "COFORGE", "HCLTECH", "INFY", "KAYNES", "KPITTECH", "MPHASIS", "OFSS", "PERSISTENT", "TATAELXSI", "TCS", "TECHM", "WIPRO"],
  "PHARMA": ["ALKEM", "AUROPHARMA", "BIOCON", "CIPLA", "DIVISLAB", "DRREDDY", "FORTIS", "GLENMARK", "LAURUSLABS", "LUPIN", "MANKIND", "SUNPHARMA", "TORNTPHARM", "ZYDUSLIFE"],
  "NIFTY 50": ["ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BEL", "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDIGO", "INFY", "ITC", "JIOFIN", "JSWSTEEL", "KOTAKBANK", "LT", "M&M", "MARUTI", "MAXHEALTH", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN", "SUNPHARMA", "TATACONSUM", "TATASTEEL", "TCS", "TECHM", "TITAN", "TMPV", "TRENT", "ULTRACEMCO", "WIPRO"],
  // No YESBANK and no AUBANK — AUBANK is carried in BANK instead.
  "PVT BANK": ["AXISBANK", "BANDHANBNK", "FEDERALBNK", "HDFCBANK", "ICICIBANK", "IDFCFIRSTB", "INDUSINDBK", "KOTAKBANK", "RBLBANK"],
  // NIFTY BANK's 12 plus BANKINDIA and INDIANB; UNIONBANK and YESBANK are not in it.
  "BANK": ["AUBANK", "AXISBANK", "BANKBARODA", "BANKINDIA", "CANBK", "FEDERALBNK", "HDFCBANK", "ICICIBANK", "IDFCFIRSTB", "INDIANB", "INDUSINDBK", "KOTAKBANK", "PNB", "SBIN"],
  "FIN SERVICE": ["360ONE", "ABCAPITAL", "ANGELONE", "AXISBANK", "BAJAJFINSV", "BAJAJHLDNG", "BAJFINANCE", "BSE", "CDSL", "CHOLAFIN", "HDFCAMC", "HDFCBANK", "HDFCLIFE", "ICICIBANK", "ICICIGI", "ICICIPRULI", "IEX", "IRFC", "JIOFIN", "KFINTECH", "KOTAKBANK", "LICHSGFIN", "LICI", "LTF", "MANAPPURAM", "MAXHEALTH", "MCX", "MFSL", "MOTILALOFS", "MUTHOOTFIN", "NUVAMA", "PAYTM", "PFC", "PNBHOUSING", "POLICYBZR", "RECLTD", "SAMMAANCAP", "SBICARD", "SBILIFE", "SBIN", "SHRIRAMFIN"],
  // GODFRYPHLP, RADICO and VMM are in the NSE FMCG index but not in this bucket.
  "FMCG": ["BRITANNIA", "COLPAL", "DABUR", "DMART", "ETERNAL", "GODREJCP", "HINDUNILVR", "ITC", "KALYANKJIL", "MARICO", "NESTLEIND", "NYKAA", "PATANJALI", "SUPREMEIND", "SWIGGY", "TATACONSUM", "UNITDSPR", "VBL"],
  "CEMENT": ["AMBUJACEM", "DALBHARAT", "SHREECEM", "ULTRACEMCO"],
  "NIFTY MID SELECT": ["ASHOKLEY", "ASTRAL", "AUBANK", "AUROPHARMA", "BHARATFORG", "COFORGE", "CONCOR", "CUMMINSIND", "FEDERALBNK", "GODREJPROP", "HDFCAMC", "HINDPETRO", "IDFCFIRSTB", "INDHOTEL", "JUBLFOOD", "LUPIN", "MPHASIS", "PAGEIND", "PERSISTENT", "PIIND", "POLYCAB", "RVNL", "SUZLON", "UPL", "VOLTAS"],
  "SENSEX": ["ADANIPORTS", "ASIANPAINT", "AXISBANK", "BAJAJFINSV", "BAJFINANCE", "BHARTIARTL", "HCLTECH", "HDFCBANK", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY", "ITC", "JSWSTEEL", "KOTAKBANK", "LT", "M&M", "MARUTI", "NESTLEIND", "NTPC", "POWERGRID", "RELIANCE", "SBIN", "SUNPHARMA", "TATASTEEL", "TCS", "TECHM", "TITAN", "TMPV", "ULTRACEMCO"],
  "OTHERS": ["AMBER", "COCHINSHIP", "CROMPTON", "DELHIVERY", "DIXON", "HAL", "HAVELLS", "IDEA", "INDUSTOWER", "KEI", "NAM-INDIA", "PGEL", "PIDILITIND", "SRF"],
};

// OTHERS is a catch-all bucket: it appears in the treemap but not in the strength
// bars or the per-sector tables, matching the real page.
export const TREEMAP_ONLY = new Set(['OTHERS']);
