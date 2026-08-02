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
 * The indices the app quotes, in the order the home-page ticker shows them.
 *
 * All of these ride in the same quote batch as the equity universe, so the whole ticker
 * costs no extra request. Keys are read off Upstox's instrument master — the display name
 * is not the trading symbol, and `NSE_INDEX|BANKNIFTY` is rejected where
 * `NSE_INDEX|Nifty Bank` is accepted.
 *
 * Every entry here was confirmed to price. BSE's SENSEX is deliberately absent: it is not
 * in NSE's instrument file, and a headline index showing an invented number is worse than
 * one that is simply not listed.
 */
export const MARQUEE: { name: string; label: string; key: string }[] = [
  { name: 'NIFTY 50', label: 'NIFTY 50', key: 'NSE_INDEX|Nifty 50' },
  { name: 'NIFTY BANK', label: 'BANK NIFTY', key: 'NSE_INDEX|Nifty Bank' },
  { name: 'FINNIFTY', label: 'FIN NIFTY', key: 'NSE_INDEX|Nifty Fin Service' },
  { name: 'MIDCPNIFTY', label: 'MIDCP NIFTY', key: 'NSE_INDEX|NIFTY MID SELECT' },
  { name: 'NIFTY NEXT 50', label: 'NEXT 50', key: 'NSE_INDEX|Nifty Next 50' },
  { name: 'NIFTY 100', label: 'NIFTY 100', key: 'NSE_INDEX|Nifty 100' },
  { name: 'NIFTY 500', label: 'NIFTY 500', key: 'NSE_INDEX|Nifty 500' },
  { name: 'INDIA VIX', label: 'INDIA VIX', key: 'NSE_INDEX|India VIX' },
  { name: 'NIFTY IT', label: 'IT', key: 'NSE_INDEX|Nifty IT' },
  { name: 'NIFTY AUTO', label: 'AUTO', key: 'NSE_INDEX|Nifty Auto' },
  { name: 'NIFTY PHARMA', label: 'PHARMA', key: 'NSE_INDEX|Nifty Pharma' },
  { name: 'NIFTY FMCG', label: 'FMCG', key: 'NSE_INDEX|Nifty FMCG' },
  { name: 'NIFTY METAL', label: 'METAL', key: 'NSE_INDEX|Nifty Metal' },
  { name: 'NIFTY ENERGY', label: 'ENERGY', key: 'NSE_INDEX|Nifty Energy' },
  { name: 'NIFTY REALTY', label: 'REALTY', key: 'NSE_INDEX|Nifty Realty' },
  { name: 'NIFTY PSU BANK', label: 'PSU BANK', key: 'NSE_INDEX|Nifty PSU Bank' },
];

/**
 * Index name -> Upstox instrument key.
 *
 * Derived from MARQUEE rather than written twice: the quote batch maps responses back by
 * instrument key, so listing one index under two different names would make the two
 * collide and silently drop one of them.
 */
export const INDEX_QUOTE_KEY: Record<string, string> =
  Object.fromEntries(MARQUEE.map((m) => [m.name, m.key]));

/** The four the home page gives full cards to, with a sparkline each. */
export const HEADLINE_INDICES = ['NIFTY 50', 'NIFTY BANK', 'FINNIFTY', 'MIDCPNIFTY'] as const;
