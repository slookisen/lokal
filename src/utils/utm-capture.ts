// ─── Inbound UTM capture (dev-request 2026-09-24-ai-sok-bli-svaret-rfb, slice B4) ───
// Reads utm_source / utm_medium / utm_campaign from an INBOUND request so the
// landing can be attributed (e.g. utm_source=chatgpt&utm_medium=mcp, which
// url-utm.ts addAiUtmParams stamps onto links we hand out through MCP/A2A).
//
// Values are untrusted client input: control chars stripped, whitespace
// collapsed, truncated to UTM_MAX_LEN. They are only ever bound as SQL
// parameters. No PII is read (only the three utm_* keys).

export const UTM_MAX_LEN = 64;

export interface UtmParams {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

/** Sanitise one raw utm value. Returns null for non-strings / empty results. */
export function sanitizeUtmValue(raw: unknown): string | null {
  let v: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const s = (v as string).slice(0, UTM_MAX_LEN).trim();
  return s.length > 0 ? s : null;
}

/** Extract sanitised utm params from an Express-style query object. */
export function extractUtmFromQuery(query: unknown): UtmParams {
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  return {
    utm_source: sanitizeUtmValue(q.utm_source),
    utm_medium: sanitizeUtmValue(q.utm_medium),
    utm_campaign: sanitizeUtmValue(q.utm_campaign),
  };
}

/** Extract utm params from a (same-origin) Referer URL's query string. */
export function extractUtmFromUrl(url: string | undefined | null): UtmParams {
  if (!url || typeof url !== "string") return extractUtmFromQuery(null);
  try {
    const p = new URL(url, "http://localhost").searchParams;
    return extractUtmFromQuery({
      utm_source: p.get("utm_source"),
      utm_medium: p.get("utm_medium"),
      utm_campaign: p.get("utm_campaign"),
    });
  } catch {
    return extractUtmFromQuery(null);
  }
}

export function hasAnyUtm(u: UtmParams): boolean {
  return !!(u.utm_source || u.utm_medium || u.utm_campaign);
}
