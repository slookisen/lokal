// ─── Light-only owner pages for gårdssalg (Opplevagent) ─────────────────────
// dev-request 2026-11-24-opplevagent-eierdashbord-lyst-tema-og-testfunn,
// slice 1: every gårdssalg owner page is light, whatever the browser theme.
//
// «Mine valg» renders the shared owner CSS (OWNER_PAGE_CSS, owner-features/
// page.ts), which carries the T6 tokens with a dark block for Rett fra
// Bonden. The gårdssalg route swaps that CSS for this light-only copy, so the
// RFB pages and their CSS stay byte-identical.
//
// PURE: string in, string out.

/** Matches the opening of a `@media (prefers-color-scheme: dark) {` block. */
const DARK_MEDIA_OPEN = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;

/**
 * The CSS without any `@media (prefers-color-scheme: dark) { … }` block
 * (nested braces counted), and with `color-scheme: light dark` narrowed to
 * `color-scheme: light`. An unbalanced block (no closing brace) is cut to the
 * end of the string, so nothing dark survives a malformed input.
 */
export function lightOnlyCss(css: string): string {
  let out = "";
  let from = 0;
  DARK_MEDIA_OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DARK_MEDIA_OPEN.exec(css)) !== null) {
    out += css.slice(from, m.index);
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    from = i;
    DARK_MEDIA_OPEN.lastIndex = i;
  }
  out += css.slice(from);
  return out.replace(/color-scheme\s*:\s*light\s+dark/gi, "color-scheme: light");
}
