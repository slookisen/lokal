// ─── contact-normalizer ──────────────────────────────────────────────────────
//
// orchestrator-pr-13 (2026-06-15)
//
// CONSERVATIVE, PURE-FUNCTION canonicalization of Norwegian address and phone
// values, plus equivalence predicates used by the cross-source agreement check
// (services/cross-source-validator.ts) to recognise *formatting-only* differences
// between two high-quality sources as AGREEING instead of conflicting.
//
// WHY THIS EXISTS
// ───────────────
// A cohort of ~70 producers sits in `review_required` because their address
// and/or phone values from different sources are flagged as DISAGREEING when
// they are, in fact, the SAME value expressed differently, e.g.:
//   address  "Bjørkeveien 20B"      vs  "Bjørkeveien 20B, 1940 Bjørkelangen"
//   phone    "+47 911 22 333"       vs  "91122333"
// The cross-source comparison treats these as conflicts and blocks promotion
// into the outreach pool.
//
// SAFETY POSTURE (read before changing anything)
// ──────────────────────────────────────────────
// These functions are deliberately STRICT. A false negative on "match" is safe
// (the producer simply stays in review_required for a human to clear). A false
// POSITIVE is NOT safe — it could promote a wrong or duplicate producer into the
// outreach pool. Therefore, when in doubt, these predicates return `false`
// (= treat as a potential conflict). In particular:
//   • Phone matching compares the full 8-digit Norwegian national number. A
//     single differing digit ⇒ no match. No prefix matching on phones.
//   • Address matching ONLY accepts: exact (normalized) equality, one value
//     being a clean WHOLE-TOKEN prefix of the other, or one value equalling the
//     other minus an appended postal-code+city tail. It NEVER merges different
//     street names or different house numbers ("Storgata 1" ≠ "Storgata 10",
//     "Storgata 1" ≠ "Lillegata 1").
//
// This module is ADDITIVE. It does not change phone/address string storage, the
// website / domain-coherence axis, or any schema. It only provides equivalence
// predicates the validator consults as a *relaxation* step when its existing
// grouping has not already found agreement.

// ─── Phone ───────────────────────────────────────────────────────────────────

/**
 * Canonicalize a Norwegian phone number to its bare national digit string.
 *
 * Conservative rules:
 *   1. Strip whitespace, dashes, parentheses, dots, and the unicode non-break
 *      space sometimes injected by scrapers.
 *   2. Strip a single leading international prefix for Norway: `+47` or `0047`.
 *      A bare leading `+` (other country code typed without digits stripped) is
 *      also removed so the remaining digits can be compared — but we do NOT
 *      strip arbitrary 2-digit country codes, because doing so could silently
 *      equate a Norwegian number with a foreign one.
 *   3. Keep digits only.
 *
 * The function does not attempt to validate length; that is left to the caller.
 * `phonesMatch` enforces the 8-digit national-number comparison.
 *
 * Examples:
 *   "+47 911 22 333"  → "91122333"
 *   "0047 911 22 333" → "91122333"
 *   "911 22 333"      → "91122333"
 *   "(91) 12-23.33"   → "91122333"
 */
export function normalizePhone(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    // remove common separators incl. unicode NBSP / narrow NBSP
    .replace(/[\s  \-().–—.]/g, "")
    // strip a single Norwegian international prefix, if present
    .replace(/^\+47/, "")
    .replace(/^0047/, "")
    // strip a lone leading '+' (country code already digit-stripped above)
    .replace(/^\+/, "")
    // keep digits only
    .replace(/\D/g, "");
}

/**
 * True when two phone values are the SAME Norwegian national number.
 *
 * Both values are normalized, then compared on their trailing 8 digits (the
 * Norwegian national number length). We compare the *last 8* so a value that
 * still carries an un-stripped country variant (e.g. a leading "47" that was
 * not in "+47"/"0047" form) cannot accidentally shift the comparison — but only
 * when BOTH normalize to a recognisably 8-digit national number. Anything that
 * does not reduce to exactly 8 national digits on BOTH sides is treated as a
 * non-match (return false) so malformed / partial numbers never vacuously agree.
 *
 * No prefix or fuzzy matching: "91122333" vs "91122334" ⇒ false.
 */
export function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  const ea = national8(na);
  const eb = national8(nb);
  if (ea === null || eb === null) return false;
  return ea === eb;
}

/**
 * Reduce a digit string to the canonical 8-digit Norwegian national number, or
 * null if it cannot be confidently interpreted as one.
 *   • exactly 8 digits          → as-is
 *   • 10 digits starting "47"   → drop the leading "47" (un-prefixed country code)
 *   • anything else             → null (do not guess)
 */
export function national8(digits: string): string | null {
  if (/^\d{8}$/.test(digits)) return digits;
  if (/^47\d{8}$/.test(digits)) return digits.slice(2);
  return null;
}

/**
 * True when `raw` reduces to a valid 8-digit Norwegian national number and is
 * therefore safe to render. wrong_contact_rate guardrail: a wrong/invalid
 * phone shown to a user or an AI agent is worse than showing none, so any
 * value that doesn't confidently reduce (e.g. "+47 19 09 49", 6-7 digit
 * partials, garbage text) must be treated as absent by every display/output
 * call site — never rendered, never returned.
 */
export function isDisplayablePhone(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  return national8(normalizePhone(raw)) !== null;
}

// ─── Address ─────────────────────────────────────────────────────────────────

/**
 * Canonicalize an address string for comparison.
 *
 * Conservative rules:
 *   1. Lowercase.
 *   2. Collapse all internal whitespace runs to a single space.
 *   3. Normalize spacing around commas to a single ", " so segment boundaries
 *      are stable.
 *   4. Strip leading/trailing punctuation and whitespace.
 *
 * Street names, house numbers and letters are preserved verbatim (only cased
 * down). "Bjørkeveien 20B" → "bjørkeveien 20b".
 */
export function normalizeAddress(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    // normalize comma spacing to ", "
    .replace(/\s*,\s*/g, ", ")
    // strip surrounding punctuation / whitespace
    .replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "")
    .trim();
}

// A Norwegian postal-code + city tail, e.g. ", 1940 bjørkelangen" or
// " 1940 bjørkelangen". Matches a 4-digit postnummer optionally followed by a
// city name, anchored to the END of the normalized string. Used to strip an
// appended postal tail so a street-only value can be compared to a full one.
const POSTAL_TAIL = /(?:,\s*)?\b\d{4}\b(?:\s+[\p{L}\s.-]+?)?$/u;

/**
 * Split a normalized address into its street part (everything before an
 * appended postal-code+city tail) and the 4-digit postcode if present.
 *
 *   "bjørkeveien 20b, 1940 bjørkelangen" → { street: "bjørkeveien 20b", postcode: "1940" }
 *   "bjørkeveien 20b"                    → { street: "bjørkeveien 20b", postcode: null }
 */
export function splitAddress(normalized: string): { street: string; postcode: string | null } {
  const pcMatch = normalized.match(/(?<!\d)(\d{4})(?!\d)/);
  const postcode = pcMatch ? pcMatch[1] : null;
  const street = normalized
    .replace(POSTAL_TAIL, "")
    .replace(/[\s,]+$/g, "")
    .trim();
  return { street: street || normalized, postcode };
}

/**
 * Token-aware prefix test: is `short` a whole-token prefix of `long`?
 *
 * Splits both on whitespace and requires every token of `short` to equal the
 * corresponding leading token of `long`. This guarantees we never treat
 * "storgata 1" as a prefix of "storgata 10" (the tokens "1" and "10" differ),
 * which a naive `String.startsWith` WOULD wrongly accept. An empty `short` is
 * never a prefix (returns false) so blank values cannot vacuously match.
 */
function isWholeTokenPrefix(short: string, long: string): boolean {
  const s = short.split(" ").filter(Boolean);
  const l = long.split(" ").filter(Boolean);
  if (s.length === 0 || s.length > l.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== l[i]) return false;
  }
  return true;
}

/**
 * True when two address values denote the SAME place, allowing only formatting
 * differences, a clean whole-token prefix, or an appended postal-code+city tail.
 *
 * Accept cases (return true):
 *   • Exact normalized equality.
 *       "Bjørkeveien 20B" ≡ "bjørkeveien 20b"
 *   • One street part is a whole-token prefix of the other AND their postcodes
 *     do not conflict (at most one distinct postcode present).
 *       "Bjørkeveien 20B" ≡ "Bjørkeveien 20B, 1940 Bjørkelangen"
 *   • Equal once an appended postal-code+city tail is removed from one side.
 *       "Storgata 1, 0150 Oslo" ≡ "Storgata 1"
 *
 * Reject cases (return false — treated as a potential conflict):
 *   • Different street name:   "Storgata 1"  vs "Lillegata 1"
 *   • Different house number:  "Storgata 1"  vs "Storgata 10"
 *   • Different house letter:  "Storgata 1A" vs "Storgata 1B"
 *   • Two DIFFERENT postcodes: "Storgata 1, 0150 Oslo" vs "Storgata 1, 5003 Bergen"
 *   • Either side blank.
 *
 * Postcode-conflict guard: if both sides carry a 4-digit postcode and they
 * differ, the addresses are in different towns ⇒ NEVER match, even if the
 * street parts are identical. This is the critical anti-duplicate-promotion
 * safeguard.
 */
export function addressesMatch(a: string, b: string): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return false;

  // Fast path: exact normalized equality.
  if (na === nb) return true;

  const pa = splitAddress(na);
  const pb = splitAddress(nb);

  // Postcode-conflict guard: two distinct postcodes ⇒ different place.
  if (pa.postcode && pb.postcode && pa.postcode !== pb.postcode) return false;

  // Street parts must be equal, or one a whole-token prefix of the other.
  const sameStreet =
    pa.street === pb.street ||
    isWholeTokenPrefix(pa.street, pb.street) ||
    isWholeTokenPrefix(pb.street, pa.street);

  return sameStreet;
}
