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

/**
 * Convert a plain-text body to HTML.
 *
 * - Blank line(s) separate paragraphs -> <p>…</p>
 * - A single newline inside a paragraph is a hard break -> <br>
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
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
