// ─── Canonical slug generator ──────────────────────────────────
// Single source of truth for /produsent/<slug> URLs.
// Why this lives in utils: previously slugify lived inline in 4+
// files, and one of those copies kept Norwegian æ/ø/å verbatim
// (vs. transliterating to ae/o/a) — so /agents/:id/card returned
// links.profile URLs that the actual /produsent/:slug route 400'd
// on. Importing from one place prevents that drift.
//
// Rules (must match src/routes/seo.ts handler exactly):
//   - NFC-normalize, lowercase
//   - Norwegian/German letters transliterate: æ→ae, ø→o, å→a,
//     ä→a, ö→o, ü→u
//   - Anything not [a-z0-9] becomes a single "-"
//   - Strip leading/trailing "-"
export function slugify(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
