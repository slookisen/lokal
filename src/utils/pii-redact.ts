/**
 * PII redaction for publicly-rendered user input.
 *
 * Scope:
 *   - Applied at RENDER time to user-originating content that is displayed
 *     publicly (search queries, buyer-side conversation messages, system
 *     messages that include query context).
 *   - NOT applied to producer-entered content (seller-role messages, agent
 *     profile fields) — that input is controlled/validated elsewhere.
 *
 * What we redact:
 *   - E-mail addresses (always)
 *   - Norwegian fødselsnummer (11 digits, validated with mod-11 checksum
 *     so random 11-digit numbers don't false-positive)
 *   - Norwegian phone numbers: either with +47 prefix, or an 8-digit standalone
 *     whose first digit is 2–9 (the Norwegian phone number range). 8-digit
 *     sequences starting with 0 or 1, or that sit inside longer numeric
 *     strings (IDs, product codes, timestamps), pass through unchanged.
 *
 * What we deliberately do NOT redact:
 *   - Organisation numbers (9 digits — public in Brønnøysundregistrene)
 *   - Postal codes (4 digits)
 *   - Prices, opening hours, coordinates
 *   - URLs (important for agent-card discovery)
 *   - Names, cities, categories, product names
 *
 * Failure mode goal: false negatives (miss) are preferable to false positives
 * (redacting legitimate text) for this usage — the output is user-facing, and
 * redacting "oslo" would be worse than missing a rare phone number.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/g;

// 11 digits, optionally split as 6+5 with a space or dash
const NO_PERSONAL_ID_RE = /\b(\d{6})[ -]?(\d{5})\b/g;

// Norwegian phone with country code
const NO_PHONE_CC_RE = /\+?\s?47[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}\b/g;

// Standalone 8-digit Norwegian phone (first digit 2-9), not inside a longer digit run.
// Separators restricted to spaces only — ISO dates like 2026-04-23 would otherwise match.
const NO_PHONE_PLAIN_RE = /(?<![\d\w])[2-9]\d(?:\s?\d{2}){3}(?![\d\w])/g;

/**
 * Validate the mod-11 checksum of a Norwegian fødselsnummer (11 digits).
 * Returns true only for structurally valid numbers — a much lower false-positive
 * rate than a naive "11 digits" match.
 */
export function isValidFodselsnummer(eleven: string): boolean {
  if (!/^\d{11}$/.test(eleven)) return false;
  const d = eleven.split("").map(Number) as number[];
  const w1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
  let s1 = 0;
  for (let i = 0; i < 9; i++) s1 += d[i]! * w1[i]!;
  let c1 = 11 - (s1 % 11);
  if (c1 === 11) c1 = 0;
  if (c1 === 10 || c1 !== d[9]) return false;

  const w2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s2 = 0;
  for (let i = 0; i < 10; i++) s2 += d[i]! * w2[i]!;
  let c2 = 11 - (s2 % 11);
  if (c2 === 11) c2 = 0;
  if (c2 === 10 || c2 !== d[10]) return false;
  return true;
}

/**
 * Redact PII from a string for public display.
 * Returns the input unchanged if it is null/undefined/empty or not a string.
 */
export function redactPII(input: string | null | undefined): string {
  if (!input || typeof input !== "string") return input ?? "";
  let out = input;

  // E-mail
  out = out.replace(EMAIL_RE, "[skjult e-post]");

  // Fødselsnummer — only redact if the 11 digits pass mod-11 validation
  out = out.replace(NO_PERSONAL_ID_RE, (match, a: string, b: string) =>
    isValidFodselsnummer(a + b) ? "[skjult]" : match,
  );

  // Phone — country-code form first, then plain 8-digit
  out = out.replace(NO_PHONE_CC_RE, "[skjult tlf]");
  out = out.replace(NO_PHONE_PLAIN_RE, "[skjult tlf]");

  return out;
}
