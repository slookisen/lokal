// ─── front-page-faq.ts ──────────────────────────────────────────────────────
// «Spørsmål og svar» on the front pages of rettfrabonden.com and
// opplevagent.no (A2A dev-request 2026-11-06-faq-fra-forsiden-begge-plattformer).
//
// Behind the EXISTING page flags, no new flag:
//   - Rett fra Bonden: FOR_PRODUSENTER_PAGE_ENABLED (seo.ts, discovery.ts, a2a.ts)
//   - Opplevagent:     FOR_TILBYDERE_FAQ_ENABLED    (experiences-seo.ts,
//                      services/experiences-agent-card.ts)
// With a flag off the callers add nothing ("" / no key), so the front pages,
// menus, footers, llms.txt and agent cards stay byte-identical.
//
// AC2: this module holds NO question or answer text. Each column is a
// selection, by question, from the FAQPage object the FAQ page itself renders
// (faqPairsFromJsonLd of the same builder), so the front page cannot say
// something the FAQ page does not:
//   - RFB producers  → buildForProdusenterFaqLd (/for-produsenter)
//   - RFB buyers     → buildMcpGuideFaqJsonLd (/guide-mat-ai, the existing RFB
//                      buyer FAQ; there is no other buyer FAQ source)
//   - OA providers   → buildForTilbydereFaqLd (/for-tilbydere#sporsmal, lokal#1346)
//   - OA guests      → buildOpplevagentMcpGuideFaqJsonLd (/guide-opplevelser-mcp)
// A question that is renamed in its source simply drops out of the block
// (front-page-faq.test.ts pins that every selected question resolves).
//
// Text rules (dev-request «Regler for teksten»): the buyer/guest selections
// leave out the source questions whose answers describe ordering or booking
// through the platform (cart / henteordre / book_gardssalg), because no text
// may promise an order or a visit before a real producer takes them. That is
// why those columns have fewer than five questions; no text is written here
// to fill them.

import type { FaqPair } from "../services/faq-section";

/** Anchor of the block on the front page; the menu and footer links point here. */
export const FRONT_PAGE_FAQ_ANCHOR = "sporsmal-og-svar";

/** The pairs whose question is in `questions`, in the order of `questions`. Missing ones are skipped. */
export function pickFaqPairs(pairs: readonly FaqPair[], questions: readonly string[]): FaqPair[] {
  const byQ = new Map(pairs.map((p) => [p.q, p] as const));
  const out: FaqPair[] = [];
  for (const q of questions) {
    const p = byQ.get(q);
    if (p) out.push(p);
  }
  return out;
}

/** Questions picked from each source (exact question text in the source). */
export const RFB_FRONT_FAQ_QUESTIONS = {
  producers: {
    no: [
      "Har jeg allerede en profil?",
      "Må jeg gjøre noe?",
      "Hvordan tar jeg over profilen?",
      "Kan jeg betale for å komme høyere opp?",
      "Hva koster det?",
    ],
    en: [
      "Do I already have a profile?",
      "Do I have to do anything?",
      "How do I take over my profile?",
      "Can I pay to rank higher?",
      "What does it cost?",
    ],
  },
  // Left out of the /guide-mat-ai FAQ: the cart/ordering question and the
  // tool list (its answer describes placing a pickup order).
  buyers: {
    no: [
      "Hvilke AI-assistenter kan jeg bruke for å finne lokale matprodusenter?",
      "Koster det noe å bruke MCP-serveren?",
      "Hvordan setter jeg opp MCP i Claude Desktop eller ChatGPT?",
    ],
    en: [
      "Which AI assistants can I use to find local food producers?",
      "Does it cost anything to use the MCP server?",
      "How do I set up MCP in Claude Desktop or ChatGPT?",
    ],
  },
} as const;

export const OA_FRONT_FAQ_QUESTIONS = {
  providers: [
    "Har jeg allerede en profil?",
    "Hva koster det å være på Opplevagent?",
    "Hvordan tar jeg over profilen?",
    "Blir et besøk bekreftet automatisk?",
    "Må jeg ta imot besøk?",
  ],
  // Left out of the /guide-opplevelser-mcp FAQ: the booking question and the
  // tool list (both describe book_gardssalg visit requests), and the set-up
  // question (its answer says «lenger opp på denne siden», which is only
  // true on the guide page).
  guests: [
    "Hvilke AI-assistenter fungerer med opplevagent-mcp?",
    "Koster det noe å bruke MCP-serveren?",
  ],
} as const;

/** UI labels only (headings, column titles, link labels) — no claims. */
export const FRONT_PAGE_FAQ_LABELS = {
  rfb: {
    no: {
      heading: "Spørsmål og svar",
      nav: "Spørsmål og svar",
      buyers: "For kjøpere",
      producers: "For produsenter",
      moreBuyers: "Flere spørsmål for kjøpere",
      moreProducers: "Alle spørsmål for produsenter",
    },
    en: {
      heading: "Questions and answers",
      nav: "Questions and answers",
      buyers: "For buyers",
      producers: "For producers",
      moreBuyers: "More questions for buyers",
      moreProducers: "All questions for producers",
    },
  },
  oa: {
    heading: "Spørsmål og svar",
    nav: "Spørsmål og svar",
    guests: "For gjester",
    providers: "For tilbydere",
    moreGuests: "Flere spørsmål for gjester",
    moreProviders: "Alle spørsmål for tilbydere",
  },
} as const;

export interface FrontPageFaqColumn {
  /** Short id, used for the column heading id (fq-<id>-h). */
  id: string;
  title: string;
  pairs: FaqPair[];
  moreHref: string;
  moreLabel: string;
}

function esc(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The two columns (accordion per column). Every string is escaped. */
export function renderFrontPageFaqColumns(columns: readonly FrontPageFaqColumn[]): string {
  return `<div class="fq-grid">${columns.map((c) => {
    const h = `fq-${esc(c.id)}-h`;
    const qa = c.pairs
      .map((p) => `<details class="fq-qa"><summary>${esc(p.q)}</summary><p>${esc(p.a)}</p></details>`)
      .join("");
    return `<div class="fq-col"><h3 id="${h}">${esc(c.title)}</h3><div class="fq-list">${qa}</div><p class="fq-more"><a href="${esc(c.moreHref)}">${esc(c.moreLabel)} →</a></p></div>`;
  }).join("")}</div>`;
}

// Shared layout; colours come from each site's own tokens. Two columns on
// desktop, one below 768px (375px phones stack buyers above producers).
const FQ_LAYOUT_CSS = `
  .fq-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 32px; text-align: left; }
  .fq-col h3 { font-size: 1.1rem; font-weight: 700; margin: 0 0 8px; }
  .fq-qa summary { cursor: pointer; font-weight: 600; padding: 12px 4px; line-height: 1.5; }
  .fq-qa p { margin: 0; padding: 0 4px 14px; font-size: 0.93rem; line-height: 1.65; }
  .fq-more { margin-top: 12px; font-weight: 600; }
  @media (max-width: 768px) { .fq-grid { grid-template-columns: 1fr; } }
`;

/** Rett fra Bonden front-page CSS (seo.ts :root tokens). Added only while the flag is on. */
export const RFB_FRONT_FAQ_CSS = `${FQ_LAYOUT_CSS}
  .fq-sec { background: var(--white); }
  .fq-grid { max-width: 1080px; margin: 0 auto; }
  .fq-col h3 { color: var(--charcoal); }
  .fq-list { border-top: 1px solid var(--g200); }
  .fq-qa { border-bottom: 1px solid var(--g200); }
  .fq-qa summary { color: var(--charcoal); }
  .fq-qa summary:hover { color: var(--green-700); }
  .fq-qa summary:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fq-qa p { color: var(--g700); }
  .fq-more a { color: var(--green-700); }
`;

/** Opplevagent front-page CSS (experiences-seo.ts tokens). Added only while the flag is on. */
export const OA_FRONT_FAQ_CSS = `${FQ_LAYOUT_CSS}
  .fq-col h3 { color: var(--fjord-900); }
  .fq-list { border-top: 1px solid var(--line); }
  .fq-qa { border-bottom: 1px solid var(--line); }
  .fq-qa summary { color: var(--fjord-900); }
  .fq-qa summary:focus-visible { outline: 2px solid var(--fjord-800); outline-offset: 2px; }
  .fq-qa p { color: var(--ink-soft); }
  .fq-more a { color: var(--fjord-800); }
`;
