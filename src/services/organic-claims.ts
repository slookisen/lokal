// ─── Organic claims on public read surfaces (økologi S0) ─────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S0 (P0, regulator complaint from Debio): «økologisk» is
// a legally protected term (EU 2018/848, økologiforskriften). An organic claim
// may only be shown for a producer with a valid Debio status — until S1 that
// is `agents.debio_verified = 1`.
//
// This module is the ONE shared word list and the read-side filter every
// display surface uses (profile HTML, JSON-LD, /api/marketplace/agents,
// /agents/:id/info, /agents/:id/card, MCP, A2A, search tags). It is read-side
// only: it never writes, and callers hand it copies, so stored values in
// `agents` / `agent_knowledge` are unchanged.
//
// Scope (Daniel's choice A, 2026-10-28): list fields only — certifications,
// specialties, tags, products[].organic. Product names and free text
// (description/about) are NOT touched here; they are rewritten properly in S2.
//
// Word list: protocols/debio-okologisk-tekstregler-2026-10-28.md §2. The
// "other meaning" words (økonomi, økosystem, økologisk mangfold/balanse/
// fotavtrykk/kretsløp, økologiske prosesser/sammenhenger) are not hits.
//
// PURE (no project imports).

/** A single token (lower-cased, edge punctuation stripped) that is an organic claim word. */
function isOrganicToken(token: string): boolean {
  const t = token.toLowerCase();
  if (!t) return false;
  // Other meanings first (regelbok §2, «Ikke treff»).
  if (/^økonom/.test(t) || /^økosystem/.test(t)) return false;
  return (
    /^øko/.test(t) ||                 // økologisk/økologiske/økologi-, øko, øko-, økogård, økomerket …
    /^ø-merk/.test(t) ||              // Ø-merket, Ø-merke
    /^organic/.test(t) ||             // organic, organically
    /^organisk/.test(t) ||            // organisk, organiske
    /^ekologi/.test(t) ||             // ekologisk (sv)
    /^bio-?dynami/.test(t) ||         // biodynamisk, bio-dynamisk, biodynamic
    /^demeter/.test(t) ||             // Demeter
    /^debio/.test(t)                  // Debio, Debio-sertifisert, Debio-godkjent, DEBIO
  );
}

/** «økologisk mangfold» and friends — the organic-looking word is not a claim there. */
const OTHER_MEANING_NEXT = /^(mangfold|balanse|fotavtrykk|kretsløp|prosess|sammenheng)/i;

function cleanToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Is this single word an organic claim word (regelbok §2)? */
export function isOrganicWord(word: string): boolean {
  return isOrganicToken(cleanToken(word));
}

/**
 * Does `text` contain an organic claim word? Used by tests and callers that
 * only need a yes/no (e.g. the AC0.1 probe). Other-meaning phrases are not hits.
 */
export function containsOrganicClaim(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = cleanToken(tokens[i]);
    if (!isOrganicToken(t)) continue;
    if (/^økolog/i.test(t) && OTHER_MEANING_NEXT.test(cleanToken(tokens[i + 1] || ""))) continue;
    return true;
  }
  return false;
}

/**
 * Words that carry no meaning of their own once the organic word is gone
 * («Økologisk produksjon» → «produksjon»): an entry left with only these is
 * dropped rather than shown as a stub.
 */
const LEFTOVER_FILLER = new Set([
  "og", "and", "&", "/", "-", "–", "+", "eller", "or", "med", "with", "i", "in", "av", "of", "for",
  "produksjon", "drift", "landbruk", "jordbruk", "dyrking", "dyrket", "dyrka", "produsert", "produsent",
  "production", "farming", "farm", "grown", "produced", "producer", "agriculture",
  "sertifisert", "sertifisering", "sertifikat", "certified", "certification", "godkjent", "approved",
  "merket", "merke", "label", "labelled", "labeled", "kontrollert", "verified", "verifisert",
  "gård", "gard", "mat", "food", "kvalitet", "quality", "prinsipper", "principles", "metoder", "methods",
  "hevder", "claims",
]);

/**
 * One list entry with the organic claim words taken out. Returns null when
 * nothing meaningful is left (the entry consisted only of organic words, or of
 * organic words plus filler), otherwise the remaining words with the first
 * letter's case kept from the original entry. An entry without organic words
 * is returned unchanged (same string).
 */
export function stripOrganicFromEntry(entry: string): string | null {
  const tokens = entry.split(/\s+/).filter(Boolean);
  let hit = false;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = cleanToken(tokens[i]);
    const otherMeaning = /^økolog/i.test(t) && OTHER_MEANING_NEXT.test(cleanToken(tokens[i + 1] || ""));
    if (isOrganicToken(t) && !otherMeaning) {
      hit = true;
      continue;
    }
    kept.push(tokens[i]);
  }
  if (!hit) return entry;
  const meaningful = kept.filter((w) => {
    const c = cleanToken(w).toLowerCase();
    return c.length >= 2 && /\p{L}/u.test(c) && !LEFTOVER_FILLER.has(c);
  });
  if (meaningful.length === 0) return null;
  // Trim connectors/punctuation left dangling at either end («og kortreist» → «kortreist»).
  while (kept.length && (LEFTOVER_FILLER.has(cleanToken(kept[0]).toLowerCase()) || !cleanToken(kept[0]))) kept.shift();
  while (kept.length && (LEFTOVER_FILLER.has(cleanToken(kept[kept.length - 1]).toLowerCase()) || !cleanToken(kept[kept.length - 1]))) kept.pop();
  let out = kept.join(" ").replace(/^[\s,;:/&+–-]+|[\s,;:/&+–-]+$/g, "").trim();
  if (!out) return null;
  const firstUpper = /^\p{Lu}/u.test(entry.trim());
  if (firstUpper) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/** A list of text entries with organic claims removed (entries that were only organic words dropped, duplicates collapsed). */
export function stripOrganicEntries(list: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const cleaned = stripOrganicFromEntry(item);
    if (cleaned === null) continue;
    const key = cleaned.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/** `agents.debio_verified` read leniently (older schemas: absent/NULL = 0). */
export function isDebioVerifiedValue(value: unknown): boolean {
  return value === 1 || value === "1" || value === true;
}

/**
 * Products with `organic` read as false — a copy; the caller's array and its
 * objects are not mutated. Product names are left as they are (S0, choice A).
 */
export function productsWithoutOrganicFlag<T>(products: readonly T[]): T[] {
  return products.map((p) => {
    if (p && typeof p === "object" && (p as { organic?: unknown }).organic) {
      return { ...(p as object), organic: false } as T;
    }
    return p;
  });
}

/** Tags of an unverified producer without organic tags; skill tags likewise. */
export function stripOrganicTags(tags: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const cleaned = stripOrganicFromEntry(tag);
    if (cleaned !== null) out.push(cleaned);
  }
  return out;
}
