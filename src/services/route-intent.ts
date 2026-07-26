/**
 * route-intent.ts — dev-request 2026-07-25-reisesok-korridor-discovery-og-
 * naerhetssok, Fase 3a/3b/3c.
 *
 * Daniel: «om jeg skriver et stedsnavn, eller jeg skal reise fra oslo til
 * bodø, så skal vi ha en algoritme/løsning for å få forslag til stopp
 * underveis» — and, approving the single-field design: «jeg er enig i "ett
 * felt" så lenge dette er "smart" og fungerer til alle formål uten
 * missforståelser».
 *
 * «Uten missforståelser» is the whole specification. One search box now has to
 * carry route intent alongside every other intent it already serves, and the
 * cost of a false positive is much higher than the cost of a false negative: a
 * missed route just gives the user the ordinary search they typed, while a
 * hijacked product search sends them to a travel page they never asked for.
 *
 * So this module is deliberately reluctant. It answers ONE question —
 * "does this string LOOK like a route, and if so what are the two endpoints?"
 * — synchronously and with no I/O. It never decides that a route IS a route.
 * That takes geocoding both endpoints, which the caller does (see
 * resolveRouteIntent), because only a caller can afford to be async.
 *
 * ── WHY THE DASH FORM IS TREATED AS WEAK ────────────────────────────
 *
 * The spec listed «X - Y» as a route separator alongside «X til Y». Checked
 * against the live catalogue first, that would have been a catastrophe: our own
 * producer naming convention is `Navn — Sted`. «Bent Gate Brewing — Gjerdrum»,
 * «Kringler Gjestegård — Gårdsutsalg», «Moe Gård — Bringebær fra Moe» — a bare
 * dash rule turns every one of those name searches into a route query.
 *
 * Dashes are therefore WEAK markers: recognised, but the caller must clear a
 * higher bar before acting on them (see RouteIntent.weak). Directional markers
 * — «til», «fra … til», «→», «to» — are STRONG, because no producer in the
 * catalogue is named with one.
 *
 * ── INTENT ORDER (Fase 3b) ──────────────────────────────────────────
 *
 *   route > exact name > category+place > category > place > free text
 *
 * Route sits first, which is only safe because recognition is this strict AND
 * because failure always falls through to the next intent rather than dead-
 * ending. `detectRouteIntent` returning null is the normal case, not an error.
 */

/** A pair of endpoint strings the caller may try to geocode. */
export type RouteIntent = {
  from: string;
  to: string;
  /** Which separator matched — kept for tests and for honest logging. */
  marker: "fra-til" | "til" | "arrow" | "to" | "dash";
  /**
   * True for separators that also occur in ordinary producer names. The caller
   * must apply the extra guards in resolveRouteIntent before acting.
   */
  weak: boolean;
};

/**
 * Endpoints shorter than this are not places. Guards against «a til b» and
 * against a stray separator splitting a word.
 */
const MIN_ENDPOINT_CHARS = 2;

/** Longer than this and it is a sentence, not a place name. */
const MAX_ENDPOINT_CHARS = 60;

/**
 * Phrases where «til» is a preposition, not a route marker. Checked against the
 * RIGHT-HAND side, which is where the giveaway sits: «ost til pizza»,
 * «grønnsaker til middag», «gaver til jul». A place name never follows «til»
 * in these.
 *
 * This list is a cheap first cut; the real guard is that both sides must
 * geocode. It exists so the common cases never even reach the geocoder.
 */
const TIL_NOT_A_PLACE = [
  "middag", "frokost", "lunsj", "kvelds", "helga", "helgen", "jul", "påske",
  "pizza", "grillen", "grill", "bakst", "baking", "salg", "søndag", "lørdag",
  "fest", "selskap", "bursdag", "17 mai", "17. mai", "dessert", "forrett",
  "barn", "barna", "hunden", "katten", "deg", "meg", "oss", "dem",
];

/** Normalise for matching: lowercase, collapse whitespace, strip end punctuation. */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim an endpoint candidate and reject the obviously-not-a-place. */
function cleanEndpoint(raw: string): string | null {
  const s = (raw || "").replace(/[?!.,;:]+$/g, "").replace(/\s+/g, " ").trim();
  if (s.length < MIN_ENDPOINT_CHARS) return null;
  if (s.length > MAX_ENDPOINT_CHARS) return null;
  // A trailing/leading separator leftover means the split was wrong.
  if (/^[-–—→]|[-–—→]$/.test(s)) return null;
  // Digits-only is a postcode or a quantity, never a route endpoint here.
  if (/^\d+$/.test(s)) return null;
  return s;
}

/**
 * Pure, synchronous, no I/O. Returns the endpoint pair a route WOULD use, or
 * null when the string does not look like a route at all.
 *
 * Returning a non-null value is NOT a decision that this is a route — see the
 * module header. The caller must still resolve both endpoints.
 */
export function detectRouteIntent(query: string): RouteIntent | null {
  const q = norm(query);
  if (!q) return null;

  // ── «fra X til Y» — the least ambiguous form, so it is tried first and
  //    its match is authoritative even if the string also contains a dash.
  const fraTil = /^fra\s+(.+?)\s+til\s+(.+)$/.exec(q);
  if (fraTil) {
    const from = cleanEndpoint(fraTil[1]);
    const to = cleanEndpoint(fraTil[2]);
    if (from && to && !endsInNonPlace(to)) {
      return { from, to, marker: "fra-til", weak: false };
    }
    return null; // «fra X til middag» is not a route, and not a dash query either
  }

  // ── «X til Y» ──
  //    Split on the FIRST « til », so «Oslo til Bodø til Tromsø» yields
  //    Oslo→(Bodø til Tromsø) and the second leg fails to geocode, which is
  //    the honest outcome: we do not support via-points from the search box.
  const til = /^(.+?)\s+til\s+(.+)$/.exec(q);
  if (til) {
    const from = cleanEndpoint(til[1]);
    const to = cleanEndpoint(til[2]);
    if (from && to && !endsInNonPlace(to)) {
      return { from, to, marker: "til", weak: false };
    }
    return null;
  }

  // ── «X → Y» ──
  const arrow = /^(.+?)\s*(?:→|->)\s*(.+)$/.exec(q);
  if (arrow) {
    const from = cleanEndpoint(arrow[1]);
    const to = cleanEndpoint(arrow[2]);
    if (from && to) return { from, to, marker: "arrow", weak: false };
    return null;
  }

  // ── «X to Y» (English, for agents and foreign visitors) ──
  const to_ = /^(.+?)\s+to\s+(.+)$/.exec(q);
  if (to_) {
    const from = cleanEndpoint(to_[1]);
    const to = cleanEndpoint(to_[2]);
    if (from && to) return { from, to, marker: "to", weak: false };
    return null;
  }

  // ── «X - Y» / «X – Y» / «X — Y» — WEAK. See the module header: this is our
  //    own producer naming convention, so a match here is a suspicion, not a
  //    finding. Only ONE dash may be present; «Moe Gård — Bringebær fra Moe»
  //    style names with further punctuation are rejected outright.
  const dashes = q.match(/\s[-–—]\s/g);
  if (dashes && dashes.length === 1) {
    const parts = q.split(/\s[-–—]\s/);
    const from = cleanEndpoint(parts[0]);
    const to = cleanEndpoint(parts[1]);
    if (from && to) return { from, to, marker: "dash", weak: true };
  }

  return null;
}

/** True when the right-hand side is a known non-place after «til». */
function endsInNonPlace(to: string): boolean {
  const t = norm(to);
  return TIL_NOT_A_PLACE.some((w) => t === w || t.startsWith(w + " ") || t.endsWith(" " + w));
}

/**
 * Two endpoints closer together than this are not a journey worth planning.
 * Also the guard against «Oslo til Oslo» and against both sides resolving to
 * the same city centroid under different spellings.
 */
export const MIN_ROUTE_SEPARATION_KM = 15;

/** Extra separation demanded of WEAK (dash) matches before they may redirect. */
export const MIN_WEAK_ROUTE_SEPARATION_KM = 50;

/** Great-circle km. Local copy: this module must stay dependency-free. */
export function routeHaversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type ResolvedRoute = {
  from: { query: string; lat: number; lng: number };
  to: { query: string; lat: number; lng: number };
  separation_km: number;
  marker: RouteIntent["marker"];
};

export type RouteRejection =
  | "no_intent"
  | "from_unresolved"
  | "to_unresolved"
  | "too_close"
  | "name_match";

/**
 * Decide whether a detected intent is really a route.
 *
 * `geocode` is injected rather than imported so this stays testable without a
 * network seam and so both platforms can pass their own hardened lookup.
 * `isKnownProducerName` lets the caller veto a weak (dash) match that is
 * actually a producer in the catalogue — the «Bent Gate Brewing — Gjerdrum»
 * case. It is only consulted for weak markers, so a deliberate «Oslo til
 * Bodø» is never vetoed by a coincidental name.
 *
 * Returns a rejection reason rather than throwing: EVERY rejection path must
 * end in "fall through to ordinary search", and a caller that cannot see why
 * cannot log it honestly.
 */
export async function resolveRouteIntent(
  query: string,
  deps: {
    geocode: (place: string) => Promise<{ lat: number; lng: number } | null>;
    isKnownProducerName?: (s: string) => boolean;
  },
): Promise<{ ok: true; route: ResolvedRoute } | { ok: false; reason: RouteRejection }> {
  const intent = detectRouteIntent(query);
  if (!intent) return { ok: false, reason: "no_intent" };

  // Veto FIRST for weak markers — cheaper than two geocodes, and it is the
  // case that actually occurs in production.
  if (intent.weak && deps.isKnownProducerName?.(query)) {
    return { ok: false, reason: "name_match" };
  }

  const from = await deps.geocode(intent.from);
  if (!from) return { ok: false, reason: "from_unresolved" };
  const to = await deps.geocode(intent.to);
  if (!to) return { ok: false, reason: "to_unresolved" };

  const km = routeHaversineKm(from.lat, from.lng, to.lat, to.lng);
  const floor = intent.weak ? MIN_WEAK_ROUTE_SEPARATION_KM : MIN_ROUTE_SEPARATION_KM;
  if (km < floor) return { ok: false, reason: "too_close" };

  return {
    ok: true,
    route: {
      from: { query: intent.from, lat: from.lat, lng: from.lng },
      to: { query: intent.to, lat: to.lat, lng: to.lng },
      separation_km: Math.round(km * 10) / 10,
      marker: intent.marker,
    },
  };
}

/** The URL a recognised route should send a browser to. */
export function reiseUrlFor(route: ResolvedRoute, basePath: string = "/reise"): string {
  const p = new URLSearchParams({ from: route.from.query, to: route.to.query });
  return `${basePath}?${p.toString()}`;
}
