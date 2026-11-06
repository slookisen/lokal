/**
 * mcp-intent-terms.ts — A2A dev-request 2026-10-16-mcp-beskrivelser-intensjonsord-og-lint,
 * slices S7 and S9.
 *
 * The user-intent words an MCP server's tool titles and first sentences open
 * with, one list per vertical. The tests read them from here
 * (src/routes/opplevagent-tool-metadata.test.ts); the tool text itself is
 * written by hand in the route file.
 *
 * experiences: Daniel's positioning decision 1=B (2026-10-17) — gårdssalg,
 * smaking og drikke. Widening that positioning later is a separate decision:
 * it is a new list here plus new text, not a new structure.
 */

import type { CatalogVertical } from "../services/honest-count";

export interface IntentTerms {
  /** English intent words, matched case-insensitively as substrings («tasting» matches «tastings»). */
  en: readonly string[];
  /** Norwegian intent words, matched the same way. */
  no: readonly string[];
}

export const MCP_INTENT_TERMS: Readonly<Partial<Record<CatalogVertical, IntentTerms>>> = {
  experiences: {
    en: [
      "tasting", "visit", "farm sale", "drink producer",
      "brewery", "cidery", "winery", "distillery", "meadery", "farm café",
    ],
    no: [
      "smaking", "besøk", "gårdssalg", "drikkeprodusent",
      "bryggeri", "sideri", "vingård", "destilleri", "mjøderi", "gårdskafé",
    ],
  },
};

/**
 * Broad intent words from positioning alternative A, which Daniel did not
 * choose (decision 1=B). They must not open any Opplevagent tool: no tool's
 * first sentence may contain them. Words already further down a description
 * may stay.
 */
export const BROAD_TERMS_NOT_CHOSEN: readonly string[] = [
  "things to do", "ting å gjøre", "tours", "tickets", "hvalsafari", "whale safari", "nordlys", "northern lights",
];

/** The intent words of `terms` found in `text` (case-insensitive substring match), by language. */
export function intentTermsIn(text: string, terms: IntentTerms): { en: string[]; no: string[] } {
  const lower = text.toLowerCase();
  return {
    en: terms.en.filter((t) => lower.includes(t.toLowerCase())),
    no: terms.no.filter((t) => lower.includes(t.toLowerCase())),
  };
}

/** The words of BROAD_TERMS_NOT_CHOSEN found in `text` (case-insensitive). */
export function broadTermsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return BROAD_TERMS_NOT_CHOSEN.filter((t) => lower.includes(t.toLowerCase()));
}
