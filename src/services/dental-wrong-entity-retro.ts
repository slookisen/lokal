// ─── dental-wrong-entity-retro-sanitize ────────────────────────────────────
// dev-request 2026-09-09-dental-non-clinic-retro-sanitize (one-time
// retroactive batch): `dental_agents` was seeded from a Brreg sweep over NACE
// 86.230 + 86.221 + 32.500 (see the header comment in
// ./dental-catalog-class.ts), which pulled in non-dental businesses
// (orthopedic suppliers, aesthetic-medicine clinics, ...) alongside real
// dental clinics. A few of these non-dental rows got
// enrichment_state='enriched' by a previous enrichment cycle, before the
// 2026-08-29 fix (v1.5.8) closed the front door for NEW enrichments —
// already live and correct, not touched here. This module finds already-
// `enriched` rows that are actually non-dental (by their own NACE code +
// content) so the batch endpoint
// (src/routes/admin-dental-wrong-entity-retro-sanitize.ts) can park them via
// the EXISTING wrong-entity parking mechanism (PR #698,
// dental-store.ts's parkDentalWrongEntity(), shared with the normal
// per-record recordDentalExtractionResult() flow).
//
// Pure, side-effect-free — no DB access. The route owns the SELECT/UPDATE.

// The three NACE codes the original Brreg sweep covered (cited from
// dental-catalog-class.ts's own header comment: "seeded from a Brreg sweep
// over NACE 86.230 + 86.221 + 32.500"). Not a new guess — this batch only
// ever targets rows from that same sweep, never widens scope to other NACE
// codes.
export const NON_DENTAL_SWEPT_NACE_CODES = ["86.230", "86.221", "32.500"] as const;

// ── Content-signal word list — DELIBERATELY NARROWER than dental-catalog-
// class.ts's DENTAL_NAME_WORDS. DO NOT "simplify" this back to reusing that
// list — it is wrong for scanning free-text content fields (om_oss,
// treatments), not just a stylistic choice.
//
// DENTAL_NAME_WORDS includes "orto", "implant", "protet", "klinikk", "smil"
// — all fine for matching a CLINIC'S OWN NAME (a clinic calling itself
// "... Ortodonti" or "... Implantklinikk" really is dental), but every one
// of those is also a normal word in genuine NON-dental content:
//
//   - "orto" is a substring of "ortoped"/"ortopediteknisk"/"ortopediske" —
//     proven by a real production row, DREVELIN ORTOPEDI SØR AS
//     (naeringskode 32.500, enrichment_state='enriched'): its own om_oss
//     text (written by enrichment) says, verbatim, "Dette er ikke en
//     tannklinikk, men en ortopediteknisk virksomhet..." — it explicitly
//     states it is NOT a dental clinic, yet contains "orto" four times
//     (ortoped, ortopediteknisk x2, ortopediske). Substring-matching the
//     full DENTAL_NAME_WORDS list against that text would register a false
//     "dental signal" from the row's own denial that it's a dental clinic —
//     a silent false negative on exactly the case this batch exists to
//     catch.
//   - "klinikk" is far too generic for content scanning: KLINIKK FØRDE AS
//     (naeringskode 86.221, an aesthetic/cosmetic-medicine clinic with zero
//     dental content) has "KLINIKK" in its own NAME, and any clinic's
//     about-text says things like "vår klinikk tilbyr...".
//   - "implant"/"protet"/"smil" are common in orthopedic-prosthetics and
//     aesthetic-medicine copy too (implants, proteser, "smil" in a cosmetic
//     marketing sense) without any dental connection.
//
// So this list keeps only words that are unambiguously DENTAL in plain
// Norwegian free text, with no orthopedic/aesthetic near-miss substring.
export const DENTAL_CONTENT_SIGNAL_WORDS: readonly string[] = [
  "tann",
  "dental",
  "kjeve",
  "odont",
  "endo",
  "perio",
  "munn",
  "dentist",
  "dent ",
  "dent.",
];

export interface DentalContentSignalRow {
  navn: string;
  om_oss: string | null;
  treatments: string | null;
}

// Lower-cases and substring-checks navn/om_oss/treatments (treatments is the
// raw JSON-text column — treated as a plain string for substring purposes,
// no need to JSON.parse it) against DENTAL_CONTENT_SIGNAL_WORDS. Null-safe.
export function hasDentalContentSignal(row: DentalContentSignalRow): boolean {
  const haystack = `${row.navn ?? ""} ${row.om_oss ?? ""} ${row.treatments ?? ""}`.toLowerCase();
  return DENTAL_CONTENT_SIGNAL_WORDS.some((word) => haystack.includes(word));
}

export interface WrongEntityRetroCandidateRow {
  id: string;
  navn: string;
  naeringskode: string | null;
  om_oss: string | null;
  treatments: string | null;
}

export interface WrongEntityRetroPlanEntry {
  id: string;
  navn: string;
  naeringskode: string | null;
  reason: string;
}

// Pure planning step. Returns the subset of rows with NO dental content
// signal at all — these are the ones to park as wrong-entity. Never writes.
export function planWrongEntityRetroSanitize(
  rows: WrongEntityRetroCandidateRow[],
): WrongEntityRetroPlanEntry[] {
  const plan: WrongEntityRetroPlanEntry[] = [];
  for (const row of rows) {
    if (hasDentalContentSignal(row)) continue;
    const code = row.naeringskode ?? "ukjent";
    plan.push({
      id: row.id,
      navn: row.navn,
      naeringskode: row.naeringskode,
      reason: `nace_${code}_no_dental_signal`,
    });
  }
  return plan;
}
