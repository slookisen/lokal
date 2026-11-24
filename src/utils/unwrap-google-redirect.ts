/**
 * unwrapGoogleRedirectLinks — replace Gmail/Google redirect links in plain
 * text with the link they point to.
 *
 * Background (dev-request 2026-11-23-crm-send-dobbeltsending-og-tydelig-
 * kvittering, point 4): text copied out of Gmail carries links wrapped as
 * `https://www.google.com/url?q=<real url>&source=gmail&ust=…&sa=E`. Sent on
 * from the admin CRM, the recipient got a Google redirect instead of the
 * rettfrabonden.com link Daniel meant.
 *
 * Deliberately narrow — anything outside these rules is left untouched:
 *   - host is exactly `google.com` or `www.google.com` (any case), path `/url`
 *   - the target is the `q` parameter, else the `url` parameter
 *   - the decoded target must itself parse as an http: or https: URL
 */

const CANDIDATE = /https?:\/\/(?:www\.)?google\.com\/url\?[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;
const ALLOWED_HOSTS = new Set(["google.com", "www.google.com"]);

function unwrapOne(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.pathname !== "/url") return null;
  const target = parsed.searchParams.get("q") || parsed.searchParams.get("url");
  if (!target) return null;
  let t: URL;
  try {
    t = new URL(target);
  } catch {
    return null;
  }
  if (t.protocol !== "http:" && t.protocol !== "https:") return null;
  return target;
}

export function unwrapGoogleRedirectLinks(text: string): string {
  if (!text || !/google\.com\/url\?/i.test(text)) return text;
  return text.replace(CANDIDATE, (match) => {
    // A link at the end of a sentence/parenthesis: keep that punctuation
    // outside the link rather than letting it ride into the last parameter.
    const trail = match.match(TRAILING_PUNCT)?.[0] ?? "";
    const link = trail ? match.slice(0, -trail.length) : match;
    const unwrapped = unwrapOne(link);
    return unwrapped === null ? match : unwrapped + trail;
  });
}
