/**
 * The length caps on search input, shared by the search and A2A handlers of
 * the three platforms: Rett fra Bonden, Opplevagent and Finn-tannlege.
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-Y (FUNN
 * rfb-sok-fritekst-uten-lengdetak): free text reached parseNaturalQuery with
 * no length cap, through MCP lokal_search (`query: z.string()` with no max),
 * RFB A2A message/send, /api/marketplace/search and /sok. The parser and
 * better-sqlite3 are synchronous, so a 98 kB search took about 0.9 s and a
 * 1 MB one (what express.json lets through) about 9 s. All that time the
 * Node process that also serves Opplevagent and Finn-tannlege was blocked.
 * The handlers now cut the text here before anything reads it. The MCP
 * input schemas keep no `max`: they are frozen while OpenAI reviews the apps.
 *
 * Slice I-Y2 (FUNN rfb-find-match-levenshtein-uten-tak and
 * strukturerte-stedsfelt-uten-lengdetak): a name is cut far lower than free
 * text (capName). /api/marketplace/find-match computes an edit distance over
 * the whole name per producer, and a place field (`near`, `place`, `sted`,
 * `fylke`, `kommune`, `region`) goes to the geocoder, a LIKE or a filter and
 * is echoed in the answer.
 *
 * Slice I-Y3 (FUNN rfb-discover-lister-uten-tak): a list of names is cut
 * too (capNameList). MCP lokal_discover and POST /api/marketplace/discover
 * sent their lists (`categories`, `tags`, and the route's `skills`) whole to
 * discover(), which compares every entry with every producer's: 175 000
 * categories took 45 s on live-like data, and one category of 1 MB 6.1 s.
 * I-Y2 already cut A2A's lists so (utils/a2a-message.ts); the cut now lives
 * here, shared by all three.
 */

/**
 * The most characters of free text a handler reads. Real searches are far
 * shorter (the longest prompt in the ChatGPT test sets is 87 characters).
 * The value is the 2000 that the Opplevagent and Finn-tannlege A2A handlers
 * already cut message text at (their MAX_MESSAGE_TEXT), so their messages
 * read as before.
 */
export const MAX_FREE_TEXT_CHARS = 2000;

/**
 * The most characters of a name a handler reads: a producer's name
 * (find-match) or a place's (the place fields). The longest of the 1563
 * public producer names is 52 characters («Alde Sider / Ulvik Frukt &
 * Cideri — Ulvik, Hardanger») and the longest kommune name 34 («Storfjord –
 * Omasvuotna – Omasvuono»). find-match's cost grows with the name (measured
 * on the 1563 names: 99 ms for the 52 characters, 176 ms for 80, 3.9 s for
 * 2000), so the cap stays low, at about one and a half times the longest
 * real name.
 */
export const MAX_NAME_CHARS = 80;

const WHITESPACE = /\s/;

/**
 * `text` cut to at most `max` characters, at a word boundary.
 *   - Text within the cap is returned as is, so a real search reads exactly
 *     as before.
 *   - Longer text keeps its whole words up to the cap. A word the cut would
 *     split is dropped, so no fragment of it is read as a word of its own,
 *     and the whitespace before the cut is trimmed.
 *   - Text with no whole word before the cap (one very long word) is cut at
 *     the cap itself, never between the halves of a surrogate pair.
 * It never rejects: a long search is answered from its first words.
 */
function cutAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = head.length;
  // The cut splits a word: back to where that word starts.
  if (!WHITESPACE.test(text.charAt(end))) {
    while (end > 0 && !WHITESPACE.test(head.charAt(end - 1))) end--;
  }
  while (end > 0 && WHITESPACE.test(head.charAt(end - 1))) end--;
  if (end > 0) return head.slice(0, end);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** `text` cut to at most MAX_FREE_TEXT_CHARS characters, at a word boundary (cutAtWordBoundary). */
export function capFreeText(text: string): string {
  return cutAtWordBoundary(text, MAX_FREE_TEXT_CHARS);
}

/**
 * A name or place `text` cut to at most MAX_NAME_CHARS characters, at a word
 * boundary (cutAtWordBoundary). An optional field that was not sent stays
 * undefined.
 */
export function capName(text: string): string;
export function capName(text: string | undefined): string | undefined;
export function capName(text: string | undefined): string | undefined {
  return text === undefined ? undefined : cutAtWordBoundary(text, MAX_NAME_CHARS);
}

/**
 * The most entries of a list of names a handler reads: RFB's `categories`,
 * `tags` and `skills`, each entry compared with every producer's. The
 * platform has 12 categories (PLATFORM_CATEGORIES in
 * services/search-enrich.ts), and a real list names a few.
 */
export const MAX_NAME_LIST_ITEMS = 50;

/**
 * A list's first MAX_NAME_LIST_ITEMS entries, each string a name cut by
 * capName. Any other entry is kept as it is, for the caller's validation to
 * judge. A list within the caps is returned as the same list, so a real
 * search reads exactly as before, and an optional list that was not sent
 * stays undefined.
 */
export function capNameList(list: string[]): string[];
export function capNameList(list: string[] | undefined): string[] | undefined;
export function capNameList(list: unknown[]): unknown[];
export function capNameList(list: unknown[] | undefined): unknown[] | undefined {
  if (list === undefined) return undefined;
  const kept = list.length > MAX_NAME_LIST_ITEMS ? list.slice(0, MAX_NAME_LIST_ITEMS) : list;
  const cut = kept.map((v) => (typeof v === "string" ? capName(v) : v));
  return kept === list && cut.every((v, i) => v === list[i]) ? list : cut;
}
