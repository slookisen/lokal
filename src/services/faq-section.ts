// ─── Visible FAQ section for a FAQPage ───────────────────────────────────────
// dev-request 2026-10-17-integrasjonstest-oppfolging, I-E (SD-01).
//
// Google's FAQPage guidelines require the markup to mirror questions and
// answers the reader can see on the page. The integration test found RFB's
// producer and place pages emitting FAQPage JSON-LD with no visible FAQ at all
// (31 of 31 sampled pages).
//
// faqPairsFromJsonLd() reads the Q/A pairs back out of a FAQPage node, and
// renderFaqSection() turns them into a <section id="faq">. A caller passes the
// same FAQPage object it serialises as JSON-LD, so the visible text and the
// markup cannot drift. The id matches the FAQPage's "@id" anchor (<url>#faq).
// The markup is the same as Opplevagent's renderFaqSectionHtml() in
// experiences-seo.ts, which keeps its own copy for now; a later slice may move
// it here.
//
// Pure: no DB, no I/O. Styling is the caller's (each site has its own tokens).

export interface FaqPair {
  q: string;
  a: string;
}

/**
 * The Q/A pairs of a FAQPage JSON-LD node, in order. Entries without a string
 * question and answer are skipped. [] for null, undefined or a node with no
 * mainEntity array.
 */
export function faqPairsFromJsonLd(faqLd: unknown): FaqPair[] {
  const mainEntity = (faqLd as { mainEntity?: unknown } | null | undefined)?.mainEntity;
  if (!Array.isArray(mainEntity)) return [];
  const pairs: FaqPair[] = [];
  for (const entry of mainEntity) {
    const q = entry?.name;
    const a = entry?.acceptedAnswer?.text;
    if (typeof q === "string" && typeof a === "string") pairs.push({ q, a });
  }
  return pairs;
}

/**
 * `<section id="faq">` with one <h3>/<p> per pair, every text escaped. ""
 * when there are no pairs, so a FAQ the quality gate left out renders nothing.
 * `lang` sets the section's own lang attribute, for a page whose FAQ text is
 * in another language than the page.
 */
export function renderFaqSection(pairs: readonly FaqPair[], opts: { heading: string; lang?: string }): string {
  if (pairs.length === 0) return "";
  const langAttr = opts.lang ? ` lang="${escapeHtml(opts.lang)}"` : "";
  const items = pairs
    .map((p) => `<div class="faq-item"><h3>${escapeHtml(p.q)}</h3><p>${escapeHtml(p.a)}</p></div>`)
    .join("");
  return `<section id="faq" class="faq" aria-labelledby="faq-title"${langAttr}><h2 id="faq-title">${escapeHtml(opts.heading)}</h2>${items}</section>`;
}

// Same `& < > " '` set as the route files' own escapeHtml(); a service cannot
// import from a route.
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
