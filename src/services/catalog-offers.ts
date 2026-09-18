// ─── Catalog offers lookup ──────────────────────────────────────────────
// dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 0: shared logic behind GET /api/marketplace/catalog/offers
// (src/routes/marketplace-catalog.ts) and the lokal_find_offers MCP tool
// (src/routes/mcp.ts) — one implementation, two callers, so the two
// surfaces can never drift on filtering, sorting, or the can_order gate.
//
// Visibility filter is based on cart-service.ts's isProducerEligible() /
// marketplace-catalog.ts's GET /feed — the same "eligible for real customer
// checkout" bar used elsewhere on this exact `products` table: non-umbrella,
// has coordinates, verification_status='verified', and NOT
// verified_second_line (that bar unlocks outreach/contact only, per
// dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel — never
// real checkout). This filter additionally requires is_active=1, which
// neither isProducerEligible() nor GET /feed currently check — a
// deliberately STRICTER bar here (never show/offer a deactivated producer),
// not a functional divergence from those two in the other direction; if
// is_active ever needs to widen to match them exactly, that's a decision
// for whoever owns this filter, not an oversight in this comment.
//
// Geo: bounding-box pre-filter + haversine, using the ONE shared
// implementation in geo-distance.ts (the same helper lokal_search's
// marketplace-registry.ts discover() uses) — no full-table scan.
//
// can_order gate: is_verified (owner-claim, NOT the internal
// verification_status cross-check — see marketplace-catalog.ts's own note on
// why `verifisert_av_eier` is is_verified-only) AND
// order_notifications_opt_in AND not blocklisted. The "blocked" check is the
// exact same isBlocked({email}) call order-notify-service.ts's
// resolveOrderNotificationRecipient() gate 4 uses — this module only READS
// agents.order_notifications_opt_in / order_notification_email /
// contact_email; it never changes order-notify-service.ts's own send logic.

import { getDb } from "../database/init";
import { knowledgeService } from "./knowledge-service";
import { geocodingService } from "./geocoding-service";
import { isBlocked } from "./blocklist-service";
import { computeEffectiveAvailability } from "./supply-graph";
import { haversineDistanceKm, KM_PER_DEG_LAT, kmPerDegLng } from "./geo-distance";
import { isValidLatLng } from "../utils/geo-query";
import { slugify } from "../utils/slug";

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

export const OFFERS_RADIUS_KM_DEFAULT = 50;
export const OFFERS_LIMIT_DEFAULT = 5;
export const OFFERS_LIMIT_MAX = 5;

export function resolveOffersRadiusKm(raw: unknown): number {
  const n = parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n <= 0) return OFFERS_RADIUS_KM_DEFAULT;
  return Math.min(500, Math.max(1, n));
}

/** Always ≤ OFFERS_LIMIT_MAX — the spec caps this endpoint at 5, "vis flere" is a later slice. */
export function resolveOffersLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return OFFERS_LIMIT_DEFAULT;
  return Math.min(OFFERS_LIMIT_MAX, n);
}

export interface FindOffersParams {
  q: string;
  near?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: unknown;
  limit?: unknown;
}

export interface OfferProducer {
  agent_id: string;
  name: string;
  city: string | null;
  distance_km: number;
  verifisert_av_eier: boolean;
  can_order: boolean;
  salgskanaler: string[];
  delivery_text: string | null;
  phone: string | null;
  email: string | null;
  profile_url: string;
  vcard_url: string;
}

export interface Offer {
  product_id: string | null;
  product_name: string;
  price_nok: number | null;
  unit: string | null;
  availability: string;
  producer: OfferProducer;
}

export interface FindOffersResult {
  term: string;
  offers: Offer[];
}

export type OffersGeocodeFn = (place: string) => Promise<{ lat: number; lng: number } | null>;

export interface FindOffersDeps {
  db?: any;
  geocode?: OffersGeocodeFn;
  /** Injectable for tests — real callers default to `new Date()`. */
  now?: Date;
}

interface RawOfferRow {
  product_id: string;
  product_name: string;
  price_nok: number | null;
  unit: string | null;
  availability: string;
  availability_updated_at: string | null;
  availability_source: string;
  agent_id: string;
  agent_name: string;
  city: string | null;
  lat: number;
  lng: number;
  is_verified: number;
  opt_in: number;
  order_notification_email: string | null;
  contact_email: string | null;
}

async function defaultGeocode(place: string): Promise<{ lat: number; lng: number } | null> {
  const g = await geocodingService.geocode(place);
  return g ? { lat: g.lat, lng: g.lng } : null;
}

/**
 * Resolves `near`/`lat`/`lng` into a single position, or null when none of
 * them could be resolved. Explicit lat/lng always wins over `near` text —
 * same priority order lokal_search uses (fix 0g(i)).
 */
async function resolvePosition(
  params: FindOffersParams,
  geocode: OffersGeocodeFn
): Promise<{ lat: number; lng: number } | null> {
  if (isValidLatLng(params.lat as number, params.lng as number)) {
    return { lat: params.lat as number, lng: params.lng as number };
  }
  const near = (params.near || "").trim();
  if (!near) return null;
  try {
    return await geocode(near);
  } catch {
    // Geocode failure must never throw — same posture as
    // enrichParsedWithGeo() in src/routes/mcp.ts. Caller sees an empty
    // offers list, not a 500.
    return null;
  }
}

/**
 * Finds up to `limit` (max 5) product offers matching `q`, from eligible
 * producers within `radiusKm` of the resolved position, nearest first.
 * Never throws: an unresolvable position or a geocode failure both result in
 * an empty `offers` array rather than an error.
 */
export async function findOffers(params: FindOffersParams, deps: FindOffersDeps = {}): Promise<FindOffersResult> {
  const db = deps.db ?? getDb();
  const geocode = deps.geocode ?? defaultGeocode;
  const now = deps.now ?? new Date();

  const term = (params.q || "").trim();
  const radiusKm = resolveOffersRadiusKm(params.radiusKm);
  const limit = resolveOffersLimit(params.limit);

  if (!term) return { term, offers: [] };

  const position = await resolvePosition(params, geocode);
  if (!position) return { term, offers: [] };

  // Bounding-box pre-filter (same shape as marketplace-registry.ts discover()
  // step 2, using the shared geo-distance.ts helpers) so the haversine below
  // only ever runs over a small, already-nearby candidate set — never a full
  // table scan.
  const latDeltaDeg = radiusKm / KM_PER_DEG_LAT;
  const lngDeltaDeg = radiusKm / kmPerDegLng(position.lat);

  const rows = db.prepare(`
    SELECT
      p.id AS product_id, p.name AS product_name, p.price_nok, p.unit,
      p.availability, p.availability_updated_at, p.availability_source,
      a.id AS agent_id, a.name AS agent_name, a.city AS city,
      a.lat AS lat, a.lng AS lng,
      a.is_verified AS is_verified,
      a.order_notifications_opt_in AS opt_in,
      a.order_notification_email AS order_notification_email,
      a.contact_email AS contact_email
    FROM products p
    INNER JOIN agents a ON a.id = p.agent_id
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.umbrella_type IS NULL
      AND a.is_active = 1
      AND a.lat IS NOT NULL AND a.lng IS NOT NULL
      AND k.verification_status = 'verified'
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
      AND a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
      AND LOWER(p.name) LIKE ?
  `).all(
    position.lat - latDeltaDeg, position.lat + latDeltaDeg,
    position.lng - lngDeltaDeg, position.lng + lngDeltaDeg,
    `%${term.toLowerCase()}%`
  ) as RawOfferRow[];

  const withDistance = rows
    .map((r) => ({ r, dist: haversineDistanceKm(position.lat, position.lng, r.lat, r.lng) }))
    .filter((x) => x.dist <= radiusKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);

  const salgskanalStmt = db.prepare(`
    SELECT sc.name AS name
    FROM agent_salgskanal asg
    INNER JOIN salgskanal_categories sc ON sc.slug = asg.category_slug
    WHERE asg.agent_id = ?
    ORDER BY sc.sort_order
  `);

  const offers: Offer[] = withDistance.map(({ r, dist }) => {
    const info = knowledgeService.getAgentInfo(r.agent_id);
    const k = info?.knowledge;

    const salgskanaler = (salgskanalStmt.all(r.agent_id) as Array<{ name: string }>).map((s) => s.name);

    const isVerified = r.is_verified === 1;
    const optedIn = r.opt_in === 1;
    // Gate 4's exact check from order-notify-service.ts's
    // resolveOrderNotificationRecipient(): admin override email wins over
    // contact_email, and isBlocked() runs against whichever is present.
    const recipientEmail = ((r.order_notification_email || "").trim() || (r.contact_email || "").trim());
    const blocked = recipientEmail ? isBlocked({ email: recipientEmail }).blocked : false;
    const canOrder = isVerified && optedIn && !blocked;

    return {
      product_id: r.product_id ?? null,
      product_name: r.product_name,
      price_nok: r.price_nok ?? null,
      unit: r.unit ?? null,
      availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
      producer: {
        agent_id: r.agent_id,
        name: r.agent_name,
        city: r.city ?? null,
        distance_km: Math.round(dist * 10) / 10,
        verifisert_av_eier: isVerified,
        can_order: canOrder,
        salgskanaler,
        delivery_text: k?.deliveryOptions?.length ? k.deliveryOptions.join(", ") : null,
        phone: k?.phone ?? null,
        email: k?.email ?? null,
        profile_url: `${BASE_URL}/produsent/${slugify(r.agent_name)}`,
        vcard_url: `${BASE_URL}/api/marketplace/agents/${r.agent_id}/vcard`,
      },
    };
  });

  return { term, offers };
}
