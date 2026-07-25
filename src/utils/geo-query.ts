// ─── Geo-query helpers (search honesty) ──────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0.
//
// Small, pure, vertical-agnostic helpers shared by the RFB REST search route
// (src/routes/marketplace.ts) and the RFB /sok web page (src/routes/seo.ts).
// They live here rather than in either route module so the two surfaces can
// never drift apart on "is this a usable position?", "what radius did the
// user actually ask for?" and "what do we tell them we did?" — the exact
// class of drift that let /api/marketplace/search report geoFiltered:true
// after it had silently dropped the geo filter.

/** True only for a finite, in-range coordinate pair. NaN/undefined → false. */
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * fix 0f — the search radius is user-adjustable instead of a hardcoded 30 km.
 * Default stays 30 (unchanged behaviour for every existing caller); the
 * accepted range mirrors OpplevAgent's discover_experiences (1–500 km), so
 * the two verticals answer the same question the same way.
 */
export const SEARCH_RADIUS_DEFAULT_KM = 30;
export const SEARCH_RADIUS_MIN_KM = 1;
export const SEARCH_RADIUS_MAX_KM = 500;

export function resolveSearchRadiusKm(raw: unknown): number {
  const n = parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n <= 0) return SEARCH_RADIUS_DEFAULT_KM;
  return Math.min(SEARCH_RADIUS_MAX_KM, Math.max(SEARCH_RADIUS_MIN_KM, n));
}

/**
 * Display casing for a resolved place name. geocodingService's hardcoded
 * MAJOR_CITIES branch echoes back the lowercased lookup key ("vadsø"), which
 * reads as a typo in a user-facing note. Norwegian connective words stay
 * lowercase ("Mo i Rana", "Nordre Land").
 */
const PLACE_LOWERCASE_WORDS = new Set(["i", "og", "på", "av", "for", "ved", "til"]);

export function formatPlaceLabel(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return trimmed;
  // Already mixed-case (Kartverket/Kommuneinfo give proper names) → leave alone.
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((w, i) =>
      i > 0 && PLACE_LOWERCASE_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

/**
 * fix 0b / 0e — a human-readable, bilingual explanation of what the search
 * actually did. Same voice as buildRelaxationNote() in experience-store.ts,
 * which OpplevAgent has used for its relaxed discovery since 2026-07.
 * Returns undefined when the result set needs no caveat.
 */
export function buildSearchNote(opts: {
  geoDropped?: boolean;
  geoPlaceLabel?: string;
  needsLocation?: boolean;
  /** Set when the widened result set came from the name-match branch (review B1). */
  nameQuery?: string;
}): string | undefined {
  if (opts.needsLocation) {
    return (
      "Søket ber om treff i nærheten, men vi vet ikke hvor du er — oppgi lat/lng " +
      "(eller tillat posisjon i nettleseren). / This search asks for nearby " +
      "results but we have no position — supply lat/lng (or allow browser location)."
    );
  }
  if (opts.geoDropped) {
    const place = opts.geoPlaceLabel || "stedet du søkte på";
    // A name search that had to be widened says so in its own terms — "no
    // «gårdsutsalg» near you" is a different, and more useful, statement than
    // "nothing near you at all".
    if (opts.nameQuery) {
      return (
        `Ingen treff på «${opts.nameQuery}» nær ${place} — viser navnetreff fra hele Norge. / ` +
        `No «${opts.nameQuery}» matches near ${place} — showing name matches from all of Norway.`
      );
    }
    return (
      `Ingen treff nær ${place} — utvidet til hele Norge. / ` +
      `No matches near ${place} — expanded to all of Norway.`
    );
  }
  return undefined;
}
