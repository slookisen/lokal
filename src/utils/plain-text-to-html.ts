/**
 * plainTextToEmailHtml — render a plain-text email body as HTML that keeps the
 * line structure the author actually wrote.
 *
 * WHY THIS EXISTS
 *
 * Both CRM send paths (POST /admin/crm/threads/:id/send and POST
 * /admin/crm/compose) passed `bodyHtml ?? bodyText` to emailService.sendRaw.
 * With no bodyHtml — which is every reply the CS routine composes — the raw
 * plain text became the text/html alternative verbatim. In HTML a newline is
 * just whitespace, so every paragraph break collapsed and the recipient saw
 * one unbroken wall of text. The text/plain alternative was correct the whole
 * time; Gmail simply prefers text/html and never showed it.
 *
 * Observed in production on a real producer reply (Angr Brenneri thread
 * 1a0a9a04c58fceaf, 2026-09-16) and reported by Daniel from his own copy.
 * Every CRM reply sent without an explicit bodyHtml had the same shape.
 *
 * Escaping is not a nicety here: the input is a human-written body that can
 * contain &, < or >. A producer name like `Bær & Brygg` or any stray angle
 * bracket would otherwise be swallowed or break the surrounding markup.
 *
 * Deliberately NOT done here: linkification. Mail clients already auto-link
 * bare URLs, and rewriting author text into anchors is a bigger change with
 * its own failure modes (mangled trailing punctuation, tracking-param
 * surprises). Keeping this function to "escape + preserve line structure"
 * makes it the kind of thing you can read once and trust.
 */

/** Escape the three characters that change how HTML is parsed. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Longest line that still counts as part of a short line block (signature, address). */
export const LINE_BLOCK_MAX_CHARS = 40;

/**
 * A line that opens a list item or a quote: `- `, `* `, `• `, `– `, `— `,
 * `1. ` / `2) `, or `>`. Leading whitespace is allowed (indented lists).
 */
const LIST_OR_QUOTE_MARKER = /^[ \t]*(?:[-*\u2022\u2013\u2014][ \t]|\d+[.)][ \t]|>)/;

/**
 * Should the newline between `prev` and `next` (two consecutive lines of one
 * paragraph) stay a hard <br>? Each newline is decided on its own; only
 * genuine source wrapping is joined.
 */
function keepsHardBreak(prev: string, next: string): boolean {
  const p = prev.trim();
  if (p.length <= LINE_BLOCK_MAX_CHARS) return true; // a short line is never source wrapping
  if (LIST_OR_QUOTE_MARKER.test(next)) return true; // next line starts a list item / quote
  if (p.endsWith(":")) return true; // "Label:" line introduces what follows
  return false;
}

function renderParagraph(para: string): string {
  const lines = para.split("\n");
  if (lines.length === 1) return escapeHtml(para);

  // Group lines into runs separated by hard breaks. A run of one line is
  // escaped as-is (exactly what a short line block always got); a run of two
  // or more lines is source wrapping, so its lines are trimmed and joined
  // with one space (exactly what a wrapped prose paragraph always got).
  const runs: string[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    if (keepsHardBreak(lines[i - 1], lines[i])) runs.push([lines[i]]);
    else runs[runs.length - 1].push(lines[i]);
  }
  return runs
    .map((run) =>
      run.length === 1 ? escapeHtml(run[0]) : run.map((l) => escapeHtml(l.trim())).join(" "),
    )
    .join("<br>");
}

/**
 * Convert a plain-text body to HTML.
 *
 * - Blank line(s) separate paragraphs -> <p>…</p>
 * - Each single newline inside a paragraph is decided ON ITS OWN (dev-request
 *   2026-10-22-rfb-utsending-v4, skive 4 (review lokal#1245 ikke-blokkerende 1)).
 *   It stays a hard <br> when ANY of these hold for the line before it (prev)
 *   and the line after it (next):
 *     1. prev is short (trimmed length at most LINE_BLOCK_MAX_CHARS): a
 *        signature, an address, a "Hei Ola," line is never source wrapping;
 *     2. next starts a list item or a quote (`- `, `* `, `• `, `– `, `— `,
 *        `1. `, `2) `, `>`; leading whitespace allowed);
 *     3. prev ends with `:` (a "Label:" line introducing what follows).
 *   Otherwise the newline is source wrapping and is joined with ONE space
 *   (both sides trimmed), so the recipient's client wraps the sentence to its
 *   own width (endring 2: hard <br> broke sentences mid-line on a phone). A
 *   wrapped list item's continuation line (no marker) is therefore joined to
 *   its item. Whitespace: a line that stands alone between hard breaks is
 *   escaped untrimmed (HTML collapses it anyway); lines joined into one run
 *   are trimmed. Never emits &nbsp;.
 *   Consequences: a paragraph of only short lines renders all-<br> and a
 *   paragraph of long wrapped prose renders all-joined, exactly as before.
 *   Known limit: a short line AFTER a long unmarked line is joined to it
 *   (e.g. a phone number under a long signature tagline) — indistinguishable
 *   from the short last line of a wrapped sentence without a wrap width.
 * - &, < and > are escaped
 * - Empty/whitespace-only input returns "" so a caller can treat it as absent
 */
export function plainTextToEmailHtml(text: string): string {
  if (!text || !text.trim()) return "";

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  return normalized
    .split(/\n[ \t]*\n+/)
    .map((para) => para.replace(/^\n+|\n+$/g, ""))
    .filter((para) => para.trim().length > 0)
    .map((para) => `<p>${renderParagraph(para)}</p>`)
    .join("\n");
}
