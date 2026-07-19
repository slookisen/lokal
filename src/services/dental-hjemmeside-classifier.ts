// ─── dental-hjemmeside-classifier ──────────────────────────────────────────
// dev-request 2026-07-18-dental-hjemmeside-directory-portal-cleanup.
//
// WHY: dental_agents.hjemmeside is supposed to be the clinic's OWN homepage,
// but a lot of rows actually carry a directory-listing site, a booking
// portal, or an industry-association URL instead (e.g. legelisten.no,
// tannlegerinorge.no, tannlegetidende.no, kjeveortopediskforening.no,
// *.business.site) — a wasted/misleading value that pollutes downstream
// enrichment (46% hit rate on dirty URLs vs 83% on real clinic homepages)
// and could point a real user at the wrong place. This module is a PURE
// classifier: given a URL string, decide whether it looks like one of those
// known-bad shapes. It does not fetch anything and does not touch the DB —
// see src/routes/admin-dental-hjemmeside-cleanup.ts for the sweep endpoint
// that uses this to move bad values out of hjemmeside.
//
// Bias hard toward NOT flagging: a false positive here would move a
// clinic's real homepage out of hjemmeside, so every heuristic below is
// deliberately conservative — when genuinely unsure, don't flag.

export interface HjemmesideClassification {
  isBad: boolean;
  reason: "directory" | "business_site" | "parked" | null;
}

// Known directory / booking-portal / industry-association domains that show
// up in dental_agents.hjemmeside instead of a clinic's own site. Exported so
// this list is easy to extend later without touching the classification
// logic itself. (Searched src/routes/dental*.ts for any other known
// booking-portal domain — e.g. an "Opus" booking-system domain — already
// referenced in code/comments; found none, so none is added here.)
export const KNOWN_DIRECTORY_DOMAINS: readonly string[] = [
  "legelisten.no",
  "tannlegerinorge.no",
  "tannlegetidende.no",
  "kjeveortopediskforening.no",
];

// Small, conservative list of domain-PARKING service hostnames. We cannot
// fetch the URL in this module (no live HTTP — see the dev-request's
// non-goals), so this can only ever catch the case where the hjemmeside
// URL's OWN hostname literally IS one of these parking-service hosts (e.g.
// a clinic's old domain lapsed and now bounces straight to sedo.com's own
// domain marketplace) — NOT the far more common case of a domain that
// *resolves* (via DNS/redirect) to a parking page while its hostname still
// looks like the clinic's own domain. Detecting that would require a live
// fetch, which is explicitly out of scope for this slice.
export const KNOWN_PARKING_HOSTNAMES: readonly string[] = [
  "sedo.com",
  "parkingcrew.net",
  "bodis.com",
  "above.com",
];

/**
 * Strip scheme/path/query/fragment/www/port from a URL-ish string down to a
 * bare hostname. Small dental-local copy of blocklist-service.ts's
 * normalizeDomain() (that module is RFB-vertical code — not imported
 * cross-vertical, per this codebase's vertical-isolation convention).
 * Never throws; returns "" for anything unparseable/empty.
 */
export function normalizeHostname(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  // If it contains @, treat as email (defensive — hjemmeside shouldn't be
  // an email address, but this must never throw on one).
  if (s.includes("@")) {
    const [, dom] = s.split("@");
    s = (dom || "").trim();
  }
  // Strip protocol + path.
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Strip query/fragment that survived because there was no path segment.
  s = s.replace(/[?#].*$/, "");
  // Strip leading www.
  s = s.replace(/^www\./, "");
  // Strip trailing port.
  s = s.replace(/:\d+$/, "");
  return s;
}

// True if `hostname` equals `domain` or is a subdomain of it (e.g.
// "www.legelisten.no" / "oslo.legelisten.no" both match "legelisten.no" —
// "www." is already stripped by normalizeHostname before this runs).
function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const NOT_BAD: HjemmesideClassification = { isBad: false, reason: null };

/**
 * Classify a dental_agents.hjemmeside URL. Pure, side-effect-free, never
 * throws — malformed/empty input is simply not flagged.
 */
export function classifyHjemmeside(url: string | null | undefined): HjemmesideClassification {
  const hostname = normalizeHostname(url);
  if (!hostname) return NOT_BAD;

  for (const domain of KNOWN_DIRECTORY_DOMAINS) {
    if (hostMatchesDomain(hostname, domain)) return { isBad: true, reason: "directory" };
  }

  if (hostname === "business.site" || hostname.endsWith(".business.site")) {
    return { isBad: true, reason: "business_site" };
  }

  for (const parkingHost of KNOWN_PARKING_HOSTNAMES) {
    if (hostMatchesDomain(hostname, parkingHost)) return { isBad: true, reason: "parked" };
  }

  return NOT_BAD;
}
