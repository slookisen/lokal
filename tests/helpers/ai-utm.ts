// dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 3: profile links
// handed to AI clients carry utm_source=<client>&utm_medium=mcp|a2a|api&
// utm_campaign=ai_search (utils/url-utm.ts tagAiProfileLinks). Tests that pin
// an answer's other content compare with this mark taken out.
const AI_UTM_RE = /[?&]utm_source=[a-z0-9_]+&utm_medium=(?:mcp|a2a|api)&utm_campaign=ai_search/g;

/** `s` (a string, or any JSON value) with every AI profile-link mark removed. */
export function stripAiUtm<T>(v: T): T {
  if (typeof v === "string") return v.replace(AI_UTM_RE, "") as unknown as T;
  return JSON.parse(JSON.stringify(v).replace(AI_UTM_RE, "")) as T;
}
