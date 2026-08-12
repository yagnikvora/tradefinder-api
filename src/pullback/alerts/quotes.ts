// Where the session bells get their quote.
//
// Live, from ZenQuotes, so the line is different every day and the supply never runs out — a fixed
// list of twenty is a two-month cycle, and the twenty-first morning it stops being a nice touch and
// becomes wallpaper you skim past.
//
// THE FETCH IS NOT THE HARD PART. THE FILTER IS. `/api/quotes` returns fifty RANDOM inspirational
// quotes, and inspirational here means the whole genre: love, friendship, kindness, grief. Taken
// raw it produces "Sadness is but a wall between two gardens" at the opening bell — a real result
// from this endpoint, and precisely the kind of thing that makes a channel feel automated rather
// than written. So the batch is scored locally and the best fit wins, which is also why a batch is
// fetched at all instead of `/api/random`: fifty candidates to choose from costs the same one
// request as one candidate you are stuck with.
//
// WHAT IT MUST NEVER DO IS FAIL THE BELL. A greeting that does not arrive because a quote host was
// slow is a worse outcome than a repeated quote, so every failure path here — timeout, non-200,
// malformed JSON, a batch where nothing is usable — falls back to the built-in set below and says
// so in its return value. The bells work with the network unplugged.
//
// ATTRIBUTION IS A LICENCE TERM, NOT A COURTESY. ZenQuotes' free tier requires a visible credit
// linking back to them. `sourced` is what the message renders that from, and it is false for the
// built-in set, so the credit appears exactly when their content does.

export interface Quote {
  text: string;
  /** Null for the built-in lines that are trading-floor adages with no honest attribution. */
  by: string | null;
  /** True when it came from ZenQuotes, which is what obliges the credit line. */
  sourced: boolean;
}

export type Mood = 'open' | 'close';

const ENDPOINT = 'https://zenquotes.io/api/quotes';
export const ZENQUOTES_URL = 'https://zenquotes.io/';

/**
 * Six seconds.
 *
 * The bell tick is not on a request path and nothing waits on it, but the tick interval is thirty
 * seconds and a fetch that outlived it would let two ticks overlap. Six leaves room for a slow
 * response and none for a hung socket.
 */
const TIMEOUT_MS = 6000;

/* -------------------------------------------------------------------- the safety net --- */

/**
 * The offline set. Used when the network is unavailable, and only then.
 *
 * Kept deliberately small — it is a fallback, not the feature. These are the lines worth having on
 * the one morning the quote host is down, which is why they are trading-specific in a way a general
 * inspirational API cannot be.
 */
const BUILTIN: Record<Mood, Quote[]> = {
  open: [
    { text: 'Every battle is won before it is ever fought.', by: 'Sun Tzu', sourced: false },
    { text: 'The most important rule of trading is to play great defence, not great offence.', by: 'Paul Tudor Jones', sourced: false },
    { text: 'Markets are never wrong — opinions often are.', by: 'Jesse Livermore', sourced: false },
    { text: 'The elements of good trading are cutting losses, cutting losses, and cutting losses.', by: 'Ed Seykota', sourced: false },
    { text: 'Amateurs think about how much money they can make. Professionals think about how much they could lose.', by: 'Jack Schwager', sourced: false },
    { text: 'Risk comes from not knowing what you are doing.', by: 'Warren Buffett', sourced: false },
    { text: 'The big money is not in the buying and the selling, but in the waiting.', by: 'Charlie Munger', sourced: false },
    { text: 'Fortune favours the prepared mind.', by: 'Louis Pasteur', sourced: false },
    { text: 'Plan the trade. Trade the plan. Everything else is noise.', by: null, sourced: false },
    { text: 'You do not have to be in every move. You have to be right about the one you are in.', by: null, sourced: false },
    { text: 'Patience is a position.', by: null, sourced: false },
  ],
  close: [
    { text: 'It was never my thinking that made the big money for me. It always was my sitting.', by: 'Jesse Livermore', sourced: false },
    { text: 'Win or lose, everybody gets what they want out of the market.', by: 'Ed Seykota', sourced: false },
    { text: 'I am always thinking about losing money, as opposed to making money.', by: 'Paul Tudor Jones', sourced: false },
    { text: 'Do more of what works and less of what does not.', by: 'Steve Clark', sourced: false },
    { text: 'The market will still be here tomorrow. Make sure you are too.', by: null, sourced: false },
    { text: 'A losing day you followed your plan on is a better day than a winning one you did not.', by: null, sourced: false },
    { text: 'Review the trades you did not take as carefully as the ones you did.', by: null, sourced: false },
    { text: 'Tomorrow brings 375 fresh minutes. None of them care what today did.', by: null, sourced: false },
    { text: 'Count the process, not the P&L. The P&L is downstream.', by: null, sourced: false },
    { text: 'Rest is part of risk management.', by: null, sourced: false },
  ],
};

/* ------------------------------------------------------------------------ the filter --- */

/**
 * A quote has to fit a phone notification before anything else about it matters.
 *
 * The floor rejects fragments that read as truncation; the ceiling is where a lock-screen preview
 * cuts off, and a quote whose ending you cannot see is not a quote.
 */
const MIN_CHARS = 25;
const MAX_CHARS = 160;

/**
 * Tones that are wrong for a bell whatever else they have going for them.
 *
 * Narrow on purpose. A blocklist that grows to catch every unwanted quote ends up rejecting the
 * good ones too — "the only thing we have to fear is fear itself" is a fine opening line and would
 * die to a naive `fear` rule — so this catches only what is unambiguously the wrong register to
 * open a trading day on, and the scoring below does the rest of the work.
 */
const OFF_TONE = /\b(death|dead|dying|die|grief|mourn|funeral|murder|suicide|hatred|despair|misery)\b/i;

/** Doing-the-work words. What a 09:15 message should sound like. */
const ACTION = /\b(work|working|discipline|disciplined|focus|begin|beginning|start|effort|persist|persistence|persevere|courage|prepare|prepared|preparation|opportunity|succeed|success|action|decide|decision|goal|plan|progress|improve|strength|attempt|dare|achieve|build|create|today|habit|practice|master|mastery|risk|patience|patient|ready|forward|climb|step)\b/i;

/** Reflection words. What a 15:30 message should sound like. */
const REFLECTION = /\b(learn|learned|learning|lesson|mistake|mistakes|experience|wisdom|patience|patient|reflect|review|time|better|grow|growth|rest|tomorrow|journey|process|slowly|quiet|calm|humble|humility|understand|memory|past)\b/i;

/** A trader's vocabulary. A bonus rather than a requirement — the source is not a trading feed. */
const MARKET = /\b(risk|money|wealth|fortune|invest|investment|price|profit|loss|losses|gain|market|markets|opportunity|patience|odds|bet|value|capital|earn)\b/i;

/**
 * The sentimental register — penalised, not rejected.
 *
 * This is the bulk of what a general inspirational feed serves, and it is not WRONG, it is just
 * not what a trading desk wants at 09:15: "whatever you decide to do, make sure it makes you
 * happy" is a real result from this endpoint and it lands as a greeting card. A penalty rather
 * than a blocklist because on a batch made entirely of these, one of them still has to win —
 * silence or a stale repeat would both be worse than a soft line.
 */
const SENTIMENTAL = /\b(love|loved|loving|happy|happiness|heart|hearts|beauty|beautiful|dream|dreams|friend|friends|friendship|kind|kindness|soul|smile|joy)\b/i;

/** Whether a quote is fit to send at all, before any question of tone. */
export function usable(q: Quote): boolean {
  if (!q.text || q.text.length < MIN_CHARS || q.text.length > MAX_CHARS) return false;
  if (OFF_TONE.test(q.text)) return false;
  // A quote with no attribution reads as an app talking to itself, and ZenQuotes always carries
  // one. `Unknown` and `Anonymous` are its way of saying it does not have it.
  if (!q.by || /^(unknown|anonymous)$/i.test(q.by.trim())) return false;
  return true;
}

/**
 * How well a quote suits this bell — higher is better, and everything usable scores at least 1.
 *
 * The floor matters as much as the ranking: on a batch where nothing matches the mood words, this
 * still returns a usable quote rather than falling back to the built-in set, because a slightly
 * off-theme quote from a live source is closer to what was asked for than the eleventh airing of a
 * line the reader has already seen.
 */
export function fitness(q: Quote, mood: Mood): number {
  if (!usable(q)) return 0;
  let score = 1;
  if ((mood === 'open' ? ACTION : REFLECTION).test(q.text)) score += 3;
  if (MARKET.test(q.text)) score += 2;
  if (SENTIMENTAL.test(q.text)) score -= 2;
  // A short line lands harder on a phone than one that fills the notification.
  if (q.text.length <= 100) score += 1;
  // Floored rather than allowed to reach zero, because zero means "unusable" to `bestOf` and a
  // batch of nothing but soft lines still has to produce a winner.
  return Math.max(1, score);
}

/**
 * Pick the best quote in a batch that has not been used lately.
 *
 * `recent` is what makes "new every day" true rather than merely likely: fifty random quotes drawn
 * from ten thousand will eventually serve one twice, and the day it does is the day the whole
 * feature looks broken. Comparison is on the text, normalised, because the same quote comes back
 * with different punctuation.
 */
export function bestOf(batch: Quote[], mood: Mood, recent: string[] = []): Quote | null {
  const seen = new Set(recent.map(normalise));
  let best: Quote | null = null;
  let bestScore = 0;

  for (const q of batch) {
    if (seen.has(normalise(q.text))) continue;
    const score = fitness(q, mood);
    // Strictly greater, so ties go to the earlier entry — and since the batch arrives in a random
    // order from the API, that is already an arbitrary but stable choice.
    if (score > bestScore) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

/** Lowercased, stripped of punctuation and collapsed whitespace — for comparing, never for display. */
export const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------------- the fetch --- */

interface ZenQuote { q?: unknown; a?: unknown; }

/** Whatever came back, reduced to the shape this file trusts. Never throws. */
export function parseBatch(body: unknown): Quote[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((row: ZenQuote) => ({
      text: typeof row?.q === 'string' ? row.q.trim() : '',
      by: typeof row?.a === 'string' ? row.a.trim() : null,
      sourced: true,
    }))
    .filter((q) => q.text.length > 0);
}

let lastError: string | null = null;
let lastFetchAt: number | null = null;
let fetchFailures = 0;

/**
 * How many fifty-quote batches to draw per bell.
 *
 * Two, because the ranking can only be as good as its candidate pool and the endpoint is random:
 * one batch of general inspirational quotes often contains nothing that sounds like a trading
 * desk, and the best-of-fifty is then a soft line. A hundred candidates roughly doubles the odds
 * of a genuinely good fit for the same negligible cost — two requests per bell, four a day,
 * against a limit of five per THIRTY SECONDS.
 */
const BATCHES = 2;

/** One batch, or an empty array. Never throws — a dead quote host must not cost the bell. */
async function fetchBatch(): Promise<Quote[]> {
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`zenquotes -> ${res.status}`);
    const quotes = parseBatch(await res.json());
    if (!quotes.length) throw new Error('zenquotes returned nothing usable');
    lastFetchAt = Date.now();
    lastError = null;
    return quotes;
  } catch (e) {
    fetchFailures++;
    lastError = String((e as Error).message);
    return [];
  }
}

/**
 * The candidate pool. Concurrent, and one batch failing does not lose the other — the rate limit
 * is per thirty seconds and these land together, so a partial answer is the normal shape of a
 * throttled response rather than an edge case.
 */
const fetchPool = async (): Promise<Quote[]> =>
  (await Promise.all(Array.from({ length: BATCHES }, fetchBatch))).flat();

/**
 * Today's quote for this bell.
 *
 * Live first, built-in only if the network could not provide one. The `recent` list is applied to
 * both, so even the fallback rotates rather than repeating the same line every time the host is
 * down.
 */
/** `builtin` pins the bells to the offline set and makes no outbound request at all. */
const liveEnabled = (): boolean =>
  (process.env.SESSION_BELL_QUOTES ?? '').trim().toLowerCase() !== 'builtin';

export async function quoteFor(mood: Mood, recent: string[] = []): Promise<Quote> {
  const live = liveEnabled() ? bestOf(await fetchPool(), mood, recent) : null;
  if (live) return live;

  const seen = new Set(recent.map(normalise));
  const pool = BUILTIN[mood];
  return pool.find((q) => !seen.has(normalise(q.text))) ?? pool[0];
}

/**
 * Reported on `/pullback/status`, so a channel quietly serving fallbacks is visible.
 *
 * Worth having because the failure is silent by design: a bell that fell back still arrives, still
 * reads well, and says nothing about the fetch behind it. A climbing `fetchFailures` is the only
 * warning that the quotes have stopped being new.
 */
export const quoteStatus = () => ({
  source: liveEnabled() ? 'zenquotes' : 'builtin',
  lastFetchAt,
  fetchFailures,
  lastError,
});

/** Test seam. */
export const resetQuoteStatus = (): void => {
  lastError = null;
  lastFetchAt = null;
  fetchFailures = 0;
};
