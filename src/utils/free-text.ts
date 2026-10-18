/**
 * The length cap on free-text search input, shared by the search and A2A
 * handlers of the three platforms: Rett fra Bonden, Opplevagent and
 * Finn-tannlege.
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
 */

/**
 * The most characters of free text a handler reads. Real searches are far
 * shorter (the longest prompt in the ChatGPT test sets is 87 characters).
 * The value is the 2000 that the Opplevagent and Finn-tannlege A2A handlers
 * already cut message text at (their MAX_MESSAGE_TEXT), so their messages
 * read as before.
 */
export const MAX_FREE_TEXT_CHARS = 2000;

const WHITESPACE = /\s/;

/**
 * `text` cut to at most MAX_FREE_TEXT_CHARS characters, at a word boundary.
 *   - Text within the cap is returned as is, so a real search reads exactly
 *     as before.
 *   - Longer text keeps its whole words up to the cap. A word the cut would
 *     split is dropped, so no fragment of it is read as a word of its own,
 *     and the whitespace before the cut is trimmed.
 *   - Text with no whole word before the cap (one very long word) is cut at
 *     the cap itself, never between the halves of a surrogate pair.
 * It never rejects: a long search is answered from its first words.
 */
export function capFreeText(text: string): string {
  if (text.length <= MAX_FREE_TEXT_CHARS) return text;
  const head = text.slice(0, MAX_FREE_TEXT_CHARS);
  let end = head.length;
  // The cut splits a word: back to where that word starts.
  if (!WHITESPACE.test(text.charAt(end))) {
    while (end > 0 && !WHITESPACE.test(head.charAt(end - 1))) end--;
  }
  while (end > 0 && WHITESPACE.test(head.charAt(end - 1))) end--;
  if (end > 0) return head.slice(0, end);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}
