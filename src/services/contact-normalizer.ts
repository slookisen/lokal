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

// Norwegian numbering plan (Nkom / E.164 +47): an 8-digit SUBSCRIBER number
// always starts with 2-9 (2/3/5/6/7 geographic+fixed, 4/9 mobile, 8 special
// services like 800/815). A leading 0 is the trunk/international access
// prefix and a leading 1 is the short-code range (1xx) — neither can ever
// begin a real 8-digit subscriber number. W33 breach (2026-08-10,
// platform-alerts/2026-08-10-rfb-enrichment-spotcheck-breach.md): the value
// "02812441" was written as a phone because the shape rule accepted ANY
// 8-digit string; this leading-digit rule closes that class structurally.
const NORWEGIAN_SUBSCRIBER_LEAD = /^[2-9]/;

/**
 * Reduce a digit string to the canonical 8-digit Norwegian national number, or
 * null if it cannot be confidently interpreted as one.
 *   • exactly 8 digits starting 2-9  → as-is
 *   • "47" + 8 digits starting 2-9   → drop the leading "47" (un-prefixed country code)
 *   • 8 digits starting 0 or 1       → null (structurally impossible subscriber
 *                                      number per the numbering plan — see
 *                                      NORWEGIAN_SUBSCRIBER_LEAD above)
 *   • anything else                  → null (do not guess)
 */
export function national8(digits: string): string | null {
  if (/^\d{8}$/.test(digits)) {
    return NORWEGIAN_SUBSCRIBER_LEAD.test(digits) ? digits : null;
  }
  if (/^47\d{8}$/.test(digits)) {
    const national = digits.slice(2);
    return NORWEGIAN_SUBSCRIBER_LEAD.test(national) ? national : null;
  }
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

// ─── Write-time guards (dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon) ──
//
// The above functions (normalizePhone/national8/isDisplayablePhone/phonesMatch)
// are only ever consulted at COMPARISON or DISPLAY time. They were never in
// the write path, so nothing stopped a structurally-impossible value —  a
// 9-digit Norwegian organisasjonsnummer or an 8-digit date — from being
// persisted into `phone` by KnowledgeService.upsertKnowledge() as if it were
// a real phone number. Confirmed live regressions (2026-07-27,
// controller/enrichment-write-pause.yaml):
//   • "927 011 840" (org-nr) written verbatim as phone for one agent.
//   • "20100101" (a date) written verbatim as phone for another.
//   • "Valmen 54, 2460 Osen Telefon" — a scraped field-label ("Telefon")
//     leaked onto the end of an address string.
//
// validatePhoneForWrite/stripTrailingContactLabel are the WRITE-time gate:
// called once, right before a new value is allowed to reach INSERT/UPDATE,
// so no matter what new way a future extractor finds to be wrong about a
// phone/address shape, a structurally-impossible value can never reach the
// DB. Fail-closed: any failing check rejects the whole value (never a
// partial/guessed value) — same "false negative is safe, false positive is
// not" posture as the rest of this module.

/**
 * The three write-guard rules a phone value is checked against. Shared
 * identifier set for `classifyPhoneForWrite`'s `failedRules` and for any
 * caller (e.g. the read-only audit sweep) that needs to report per-rule
 * breakdowns rather than a single accept/reject bit.
 */
export type PhoneWriteRule = "shape" | "org_nr_collision" | "date_shape";

export interface PhoneWriteClassification {
  /** True iff ANY rule failed — i.e. `validatePhoneForWrite` would reject. */
  rejected: boolean;
  /** Every rule that failed, in check order (shape, org_nr_collision, date_shape). */
  failedRules: PhoneWriteRule[];
}

/**
 * Classify a raw phone value against every write-guard rule, independently
 * of the others, so a caller can report WHICH rule(s) failed rather than a
 * single accept/reject bit.
 *
 * This is the SINGLE implementation of the three write-guard rules.
 * `validatePhoneForWrite` (the write-path gate) is a thin wrapper around
 * this function's `rejected` bit; the read-only audit sweep
 * (admin-contact-write-guard-audit.ts) calls this directly for its per-rule
 * counts. There is exactly one copy of each rule's logic — do not
 * reimplement any of these checks elsewhere.
 *
 * Rules (each evaluated independently; ANY failing ⇒ `rejected: true`):
 *   1. `shape` — `raw` must reduce to a valid 8-digit Norwegian national
 *      number via the EXISTING `national8(normalizePhone(raw))` — no
 *      reimplementation. If it doesn't reduce, rules 2/3 below are still
 *      evaluated where possible (rule 2's raw-digit-string leg does not
 *      depend on `reduced`), but rule 3 requires a reduced 8-digit value and
 *      is skipped (cannot fail) when shape already failed to produce one.
 *   2. `org_nr_collision` — not the agent's own org-nr: compares both the
 *      full digit-only form (not just the reduced 8-digit form) so an
 *      org-nr-shaped value is caught even before/independent of the shape
 *      check, AND the rule-1 `reduced` (national8) form, so a bare (no
 *      `+`/`00`) `47`-prefixed value that `normalizePhone` doesn't strip but
 *      `national8` still reduces to the org-nr's last 8 digits is also
 *      caught. Fails if `normalizePhone(raw)` equals `normalizePhone(orgNr)`,
 *      OR equals the LAST 8 digits of `normalizePhone(orgNr)`, OR `reduced`
 *      equals that same last-8-digit form. Skipped (cannot fail) when
 *      `orgNr` is empty/null.
 *   3. `date_shape` — not a plausible calendar date: if the value reduces to
 *      exactly 8 digits, those 8 digits must NOT parse as a plausible
 *      YYYYMMDD date (year 1900-2099, valid month/day).
 */
export function classifyPhoneForWrite(
  raw: string | null | undefined,
  orgNr: string | null | undefined,
): PhoneWriteClassification {
  const failedRules: PhoneWriteRule[] = [];
  if (!raw) return { rejected: true, failedRules }; // nothing to validate; caller treats as reject

  const rawDigits = normalizePhone(raw);

  // Rule 1 — exact-8-digit shape INCLUDING the numbering-plan leading-digit
  // rule (delegates to the existing, already-trusted national8/normalizePhone
  // logic; not reimplemented here). Since the W33 leading-digit hardening, an
  // 8-digit value starting 0/1 fails this rule too — so a 19xx-dated value
  // like "19991231" now fails BOTH shape and date_shape (each rule is
  // evaluated independently and truthfully; the audit sweep's per-rule
  // buckets deliberately may overlap for such values).
  const reduced = national8(rawDigits);
  if (reduced === null) {
    failedRules.push("shape");
  }

  // Rule 2 — not the agent's own org-nr. Runs independent of rule 1's
  // result (checked here unconditionally on the digit-only forms) so a value
  // that ALSO happens to look like a valid 8-digit number is still caught.
  if (orgNr) {
    const orgDigits = normalizePhone(orgNr);
    if (orgDigits) {
      const orgLast8 = orgDigits.length >= 8 ? orgDigits.slice(-8) : orgDigits;
      if (rawDigits === orgDigits || rawDigits === orgLast8 || reduced === orgLast8) {
        failedRules.push("org_nr_collision");
      }
    }
  }

  // Rule 3 — not a plausible calendar date. Evaluated on the 8-digit national
  // candidate INDEPENDENT of rule 1's verdict (previously it read `reduced`
  // and was skipped whenever shape failed — harmless before the W33
  // leading-digit hardening, but afterwards a 19xx date would have silently
  // moved from the date_shape bucket to shape-only; evaluating independently
  // keeps the per-rule diagnosis truthful for values that violate both).
  const dateCandidate =
    reduced ??
    (/^\d{8}$/.test(rawDigits)
      ? rawDigits
      : /^47\d{8}$/.test(rawDigits)
        ? rawDigits.slice(2)
        : null);
  if (dateCandidate !== null && looksLikeYyyymmdd(dateCandidate)) {
    failedRules.push("date_shape");
  }

  return { rejected: failedRules.length > 0, failedRules };
}

/**
 * Decide whether a raw phone value is safe to WRITE (not just display).
 *
 * Returns the ORIGINAL `raw` string unchanged if it passes every check, or
 * `null` if it should be rejected (caller should then leave the field
 * blank / fall back to the existing stored value — never store a partial or
 * "closest guess" value).
 *
 * Thin wrapper around `classifyPhoneForWrite` — see that function's doc
 * comment for the exact per-rule logic. This function only adds the
 * write-path logging and the accept/reject-to-string-or-null translation;
 * it does not duplicate any rule.
 */
export function validatePhoneForWrite(
  raw: string | null | undefined,
  orgNr: string | null | undefined,
): string | null {
  if (!raw) return null; // nothing to validate

  const { rejected, failedRules } = classifyPhoneForWrite(raw, orgNr);
  if (rejected) {
    for (const rule of failedRules) {
      const reason =
        rule === "shape"
          ? "rule1 - does not reduce to a valid 8-digit Norwegian national number"
          : rule === "org_nr_collision"
            ? "rule2 - matches agent's own org-nr"
            : "rule3 - looks like a YYYYMMDD date";
      console.log(`[contact-write-guard] rejected phone "${raw}": ${reason}`);
    }
    return null;
  }

  // All checks passed — return the ORIGINAL value unchanged.
  return raw;
}

// Days-in-month lookup (non-leap-year safe upper bound; Feb allowed up to 29
// so a leap-year date like "20240229" is still recognised as date-shaped —
// this is a conservative WRITE-time reject check, not a calendar validator,
// so erring toward "looks date-ish" is the safe direction here).
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * True when an 8-digit string plausibly parses as YYYYMMDD:
 * year 1900-2099, month 01-12, day valid for that month.
 */
function looksLikeYyyymmdd(digits8: string): boolean {
  if (!/^\d{8}$/.test(digits8)) return false;
  const year = parseInt(digits8.slice(0, 4), 10);
  const month = parseInt(digits8.slice(4, 6), 10);
  const day = parseInt(digits8.slice(6, 8), 10);
  if (year < 1900 || year > 2099) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return false;
  return true;
}

// A trailing standalone contact-field label — matched at the very end of the
// (trimmed) string, optionally preceded by a colon/comma/whitespace
// separator. Anchored with `\b` + `$` so "Kontaktveien 3" (label embedded as
// part of a real street name) is never matched — only a label that is its
// own trailing token is.
//
// Kept in sync with LEADING_LABEL_WORD below and PHONE_CONTEXT_KONTAKT_HEADING
// (routes/marketplace.ts) — the "Kontakt(info(rmasjon)?)?" alternation is the
// SAME label vocabulary in all three places (code-review follow-up, 2026-08-10).
const TRAILING_CONTACT_LABEL = /[\s,:]+(?:Telefon|Tlf\.?|E-?post|Adresse|Kontakt(?:info(?:rmasjon)?)?)[:,]?$/i;

/**
 * Strip a trailing standalone contact-field label ("Telefon", "Tlf", "Tlf.",
 * "E-post"/"Epost", "Adresse", "Kontakt"/"Kontaktinfo"/"Kontaktinformasjon" —
 * case-insensitive) from the end of an address string, if present.
 * Conservative: only strips when the label is the LAST whitespace/
 * punctuation-delimited token, so it never touches a label that's part of a
 * real street name ("Kontaktveien 3"). If stripping would leave the string
 * empty, the original is returned unchanged instead — an address must never
 * become blank via this function.
 *
 * `null`/`undefined` pass through unchanged.
 */
export function stripTrailingContactLabel(
  address: string | null | undefined,
): string | null | undefined {
  if (address === null || address === undefined) return address;
  if (typeof address !== "string") return address;

  const trimmed = address.trim();
  const match = trimmed.match(TRAILING_CONTACT_LABEL);
  if (!match) return address;

  const stripped = trimmed.slice(0, match.index).replace(/[\s,:]+$/g, "").trim();
  if (!stripped) return address; // never let the field go blank

  return stripped;
}

// ─── Leading contact-label stripping (dev-request
// 2026-08-10-verifier-portkjede-og-provenansrydding, slice D) ───────────────
//
// stripTrailingContactLabel above only ever matched a label at the END of a
// string. Live repro (Oceanfood AS, 2026-08-10 recrawl): a flattened
// "Kontakt" box heading (no punctuation boundary from the scraper's tag-strip)
// glued a LEADING label onto the front of an otherwise-real address —
// "Kontakt Oceanfood AS Storhaugen 26, 5527 Haugesund" instead of "Storhaugen
// 26, 5527 Haugesund". A bare "Kontakt " prefix is the same shape as
// stripTrailingContactLabel's label, just anchored at the start; but the
// Norwegian "Kontakt oss" box pattern commonly also glues the producer's OWN
// company name (ending in a legal-entity suffix — AS/ASA/SA/DA/ANS/ENK/BA/NUF)
// between the label and the real street, since that's a separate box
// element (company-name heading) with no punctuation before the address line
// either. `LEADING_CONTACT_LABEL_WITH_ENTITY` matches that combined shape
// FIRST (label + up to 4 title-case words + a legal-suffix word) so the whole
// "Kontakt Oceanfood AS" run is removed in one pass; `LEADING_CONTACT_LABEL`
// (bare label only) is the fallback for the simple case with no company name
// in between. Same conservative posture as the trailing version: no match ⇒
// unchanged; stripping-to-blank ⇒ unchanged (original returned).
// Kept in sync with TRAILING_CONTACT_LABEL above and
// PHONE_CONTEXT_KONTAKT_HEADING (routes/marketplace.ts) — same label
// vocabulary, including the "Kontaktinformasjon" long form.
const LEADING_LABEL_WORD = "(?:Telefon|Tlf\\.?|E-?post|Adresse|Kontakt(?:info(?:rmasjon)?)?)";
const LEGAL_SUFFIX_WORD = "(?:AS|ASA|SA|DA|ANS|ENK|BA|NUF)";
const LEADING_CONTACT_LABEL_WITH_ENTITY = new RegExp(
  `^${LEADING_LABEL_WORD}[:,]?[\\s,:]+(?:\\p{L}[\\p{L}'-]*[\\s,:]+){0,4}?${LEGAL_SUFFIX_WORD}[\\s,:]+`,
  "iu",
);
const LEADING_CONTACT_LABEL = new RegExp(`^${LEADING_LABEL_WORD}[:,]?[\\s,:]+`, "i");

/**
 * Strip a leading standalone contact-field label ("Telefon", "Tlf", "Tlf.",
 * "E-post"/"Epost", "Adresse", "Kontakt"/"Kontaktinfo" — case-insensitive)
 * from the FRONT of an address string, if present — the mirror image of
 * `stripTrailingContactLabel`. Also handles the common "Kontakt <Firmanavn>
 * AS ..." shape (a flattened "Kontakt oss" box heading directly followed by
 * the producer's own company name ending in a Norwegian legal-entity
 * suffix), stripping the whole label+company-name run in one pass so the
 * real street name is what remains. Conservative: the company-name variant
 * only fires when a legal-suffix word appears within the next few tokens; a
 * street name that merely happens to start with a label-shaped word but has
 * no legal-suffix nearby only has the bare label stripped, same as the
 * trailing version. If stripping would leave the string empty, the original
 * is returned unchanged instead — an address must never become blank via
 * this function.
 *
 * `null`/`undefined` pass through unchanged.
 */
export function stripLeadingContactLabel(
  address: string | null | undefined,
): string | null | undefined {
  if (address === null || address === undefined) return address;
  if (typeof address !== "string") return address;

  const trimmed = address.trim();

  const entityMatch = trimmed.match(LEADING_CONTACT_LABEL_WITH_ENTITY);
  const match = entityMatch ?? trimmed.match(LEADING_CONTACT_LABEL);
  if (!match) return address;

  const stripped = trimmed.slice(match[0].length).trim();
  if (!stripped) return address; // never let the field go blank

  return stripped;
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
 *   5. Collapse known formatting/spelling variants (see
 *      canonicalizeAddressVariants) — a space before a house-number letter
 *      suffix, and the veien/vegen + gate/gata street-suffix spelling pair.
 *
 * Street names and house numbers are otherwise preserved verbatim (only
 * cased down). "Bjørkeveien 20B" → "bjørkeveien 20b".
 */
export function normalizeAddress(raw: string): string {
  if (typeof raw !== "string") return "";
  return canonicalizeAddressVariants(
    raw
      .toLowerCase()
      .replace(/\s+/g, " ")
      // normalize comma spacing to ", "
      .replace(/\s*,\s*/g, ", ")
      // strip surrounding punctuation / whitespace
      .replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "")
      .trim()
  );
}

// dev-request 2026-08-27-verifier-agree-false-adresse-normalisering: two more
// KNOWN Norwegian address-formatting variants that were still keying
// otherwise-identical addresses differently and forcing agree=False:
//
//   1. A space between a house number and its single-letter suffix —
//      "12 A" vs "12A" — both denote the same building; only a whitespace
//      difference (real evidence: Li Lynghonning, homepage gave both forms
//      across two enrichment passes, enrichment-reports/2026-08-27.md).
//   2. The bokmål "-vei(en)" street-type suffix vs the dialectal/nynorsk
//      "-veg(en)" spelling of the SAME word — "Liagrendveien" vs
//      "Liagrendvegen" (real evidence: Lien Gård, homepage vs
//      google_places, same address).
//
// Deliberately NOT included: the "-gate(n)"/"-gata" pair. It looks like the
// same class of variant, but "gata"/"gate" are also ordinary word endings in
// unrelated street names already covered by this module's own pinned tests
// ("Storgata" must keep normalizing to "storgata", not "storgaten" — see
// contact-normalizer.test.ts) and no real occurrence of this specific pair
// was found in the evidence. Widening the whitelist without real evidence
// risks exactly the kind of over-eager rewrite this fix must not become —
// left for a future slice if a real gate/gata false-negative shows up.
//
// Both handled rules are whitelist/pattern-anchored and touch ONLY the
// suffix/spacing — they never rewrite a street-name stem, house number, or
// postcode, so two genuinely different streets or house numbers can never
// be made to match (see the NEG cases in contact-normalizer.test.ts).
// Exported so cross-source-validator.ts's own parseAddressCore() can apply
// the identical canonicalization to its independently-computed comparison
// key.
const STREET_SUFFIX_PATTERN = /(veien|vegen|vei|veg)\b/gu;

export function canonicalizeAddressVariants(text: string): string {
  return text
    // "12 a" / "20 b" -> "12a" / "20b" (house-number + single-letter suffix).
    // Anchored to (comma | end-of-string) right after the letter — NOT a bare
    // \b — so this can only fire on an actual trailing suffix position, never
    // on a digit run followed by an unrelated one-letter word elsewhere in
    // the address ("...12 i Tromsø", "...4 å Bakken"): \b alone treats any
    // single letter as a boundary, matching those too and silently gluing
    // them onto the number (found in independent review of this PR — PoC:
    // "Nordgata 12 i Tromsø" vs "Nordgata 12i Tromsø" wrongly agreed).
    .replace(/(\d+)\s+([a-zæøå])(?=,|$)/gu, "$1$2")
    // "-vegen"/"-veg" -> canonical "-veien"/"-vei"
    .replace(STREET_SUFFIX_PATTERN, (m) => (m === "veg" ? "vei" : m === "vegen" ? "veien" : m));
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
