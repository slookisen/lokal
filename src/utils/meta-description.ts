// Meta-description repair — pure, dependency-free helpers.
//
// EXTRACTED from src/routes/seo.ts (2026-07-11) so the truncation-sweep code in
// admin-knowledge.ts can reuse the EXACT repair logic WITHOUT importing seo.ts.
// seo.ts is a ~4300-line route module that transitively pulls in a large service
// chain (geocoding, analytics, conversation-service, traffic-stats, indexnow, …);
// importing it just for these two tiny pure helpers dragged that whole chain into
// admin-knowledge.ts's import graph. admin-knowledge.ts is reachable from the
// isolated `agent-knowledge-get-auth.test.ts` CI job (test → marketplace.ts →
// admin-knowledge.ts), so the added import made that isolated test process load
// seo.ts's service chain — one of whose module-load handles kept the process
// alive and hung the job. This module has ZERO imports, so both seo.ts and
// admin-knowledge.ts can depend on it with no side-effect coupling.
//
// dev-request 2026-07-11 truncation-sweep fix-up: the trailing-run regex is
// exported on its own (TRAILING_REPLACEMENT_CHAR_REGEX) so the sweep endpoint
// can classify a candidate row as "single trailing run" (safe to auto-apply)
// vs. interior/multiple-occurrence/degenerate (never safe to auto-apply — the
// SECOND pass below, `/�+/gu` → "", deletes an interior "�" with no word-boundary
// awareness, fusing the two halves of the surrounding text into new,
// wrong-but-plausible text). This constant is the single source of truth for
// "what counts as a trailing run" — do not re-derive it elsewhere.
export const TRAILING_REPLACEMENT_CHAR_REGEX = /\S*�+\s*$/u;

export function safeMetaDescription(text: string | null | undefined): string {
  if (!text) return "";
  let s = String(text);
  if (!s.includes("�")) return s;
  // Drop a trailing replacement-char run plus the (now-broken) word fragment
  // it's attached to, so we don't end the tag mid-word either.
  s = s.replace(TRAILING_REPLACEMENT_CHAR_REGEX, "").trimEnd();
  // Any remaining "�" (leading/interior) — collapse rather than ship it raw.
  s = s.replace(/�+/gu, "").replace(/\s{2,}/g, " ").trim();
  return s;
}
