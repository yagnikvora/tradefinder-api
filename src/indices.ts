// Index membership for Index Mover.
//
// Upstox serves quotes for any instrument but publishes no index composition — its
// instruments master carries segment, name, isin, lot size and tick size, and no index,
// weight or sector field at all. So the membership lives here.
//
// These are NSE's own constituent lists, captured from
// /api/equity-stock-indices?index=… on 2026-08-01 and verified against it: NIFTY 50
// matched 50/50 with no difference.
//
// NOT the same thing as SECTOR_BASKETS in sectors.ts. Those mirror tradefinder's own
// sector buckets, which drift from the index deliberately — their BANK bucket carries
// BANKINDIA and INDIANB where NIFTY BANK carries UNIONBANK and YESBANK. Index Mover is
// about the index, so it reads these.
//
// To refresh after an NSE reshuffle (usually March and September):
//   curl 'https://www.nseindia.com/api/equity-stock-indices?index=NIFTY%2050'
// and take every `symbol` where `priority !== 1`. A stale list shows up as a constituent
// count that disagrees with the exchange, not as an error.

export const INDEX_MEMBERS: Record<string, string[]> = {
  'NIFTY 50': [
    'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJAJFINSV',
    'BAJFINANCE', 'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL',
    'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDIGO',
    'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MAXHEALTH',
    'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN',
    'SUNPHARMA', 'TATACONSUM', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TMPV', 'TRENT',
    'ULTRACEMCO', 'WIPRO',
  ],
  'NIFTY BANK': [
    'AUBANK', 'AXISBANK', 'BANKBARODA', 'CANBK', 'FEDERALBNK', 'HDFCBANK', 'ICICIBANK',
    'IDFCFIRSTB', 'INDUSINDBK', 'KOTAKBANK', 'PNB', 'SBIN', 'UNIONBANK', 'YESBANK',
  ],
};

/**
 * Upstox instrument keys for the index levels themselves.
 *
 * These ride in the same quote batch as the constituents, so Index Mover's headline costs
 * no extra request. Keys read off Upstox's instrument master — the display name is not the
 * trading symbol, and `NSE_INDEX|BANKNIFTY` is rejected where `NSE_INDEX|Nifty Bank` works.
 */
export const INDEX_QUOTE_KEY: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
};
