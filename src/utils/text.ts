// Small text-formatting helpers shared across SEO route modules.

/**
 * Cap a string at maxChars on a word boundary — no sentence detection, so
 * it's safe for composite strings like "Name i By. Beskrivelse…" where the
 * prefix itself may contain a period (e.g. a producer name like "Gård A.S."
 * or "H. Aslaksby Mikroysteri" — a sentence-boundary regex would wrongly
 * treat that period as the end of the string and drop everything after it).
 *
 * Used for <meta name="description">/og:description/twitter:description
 * content: capping ourselves on a clean word boundary means downstream
 * consumers (Google SERP, WhatsApp/Facebook/Twitter link-unfurl engines)
 * never need to apply their own byte-oriented truncation, which can slice a
 * multi-byte UTF-8 character (e.g. æ/ø/å) in half and render it as "�".
 */
export function capMetaText(text: string | null | undefined, maxChars: number): string {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars - 1).replace(/\s+\S*$/, "").trim() + "…";
}
