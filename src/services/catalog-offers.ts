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
// dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: plus the ONE
// shared public-listability predicate (agent-visibility.ts) — the hidden test
// fixture and non-RFB-vertical rows are never offered here (nor via
// lokal_find_offers); the fixture is reached by id instead.
//
// Geo: bounding-box pre-filter + haversine, using the ONE shared
// implementation in geo-distance.ts (the same helper lokal_search's
// marketplace-registry.ts discover() uses) — no full-table scan.
//
// can_order gate (skive 2): the ONE shared cart-service.isEligibleForRealOrder()
// — the exact function submitCart() uses to decide real order vs contact
// handoff — evaluated per offer row against the same db connection. So what
// this surface advertises as orderable is, by construction, what submit will
// actually turn into an order: cross-check verified + non-umbrella + not
// second-line + active + owner-claimed (is_verified) + opted in + a
// non-blocklisted recipient e-mail. `verifisert_av_eier` stays is_verified-
// only (see marketplace-catalog.ts's own note on why).
//
// dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-S: a row that
// is only a generic category label («Honning» at a bakery, written by the
// enrichment's category inference and copied into `products` by
// product-catalog-sync.ts) with no price_nok is no offer, unless the producer
// set it (availability_source 'producer_dashboard'). The rule is the one
// lokal_info lists such rows by (utils/category-label.ts); `offers` has the
// same shape, there are only fewer such rows.
//
// Slice I-S2 (b): the producers behind those label rows are not dropped. When
// the real offers leave free places on the page, the nearest label producers
// (ties by agent id) fill them in `category_matches`, one entry per producer:
// the producer and its category, with no product id, name, price, unit or
// availability and orderable:false, so a client can only offer to contact
// them. The field is left out when it is empty, so a response whose offers
// fill the page is what it was.
//
// Slice I-V (found live 2026-10-17):
// - Term: the term must start a word of the product name, or end one when it
//   has four letters or more (utils/product-name-match.ts), so «egg» no longer
//   offers «Kjøttpålegg», and «honning» still offers «Lynghonning». A shorter
//   term may end a word too when the row is in the term's own category: its
//   products.category, or its producer's categories when it has none, against
//   the term's category in the query parser's keyword map
//   (platformCategoriesOf). So «egg» offers «Gårdsegg» (eggs), not «Pålegg»
//   (meat), and «ost» «Brunost» (dairy), not «Eplemost» (beverages). A term
//   the map does not know («is») only starts a word. The SQL LIKE stays as a
//   pre-filter only.
// - Limit: `limit` counts producers, as the tool says («up to 5 nearby
//   producers»): one offer per producer, its best row (best match, then in
//   stock, then with a price, then by name (nb) and id). Producers are ordered
//   by distance, then agent id, as the category matches are, so neither list
//   hangs on the rows' order.
// - Distance: a producer placed at a centroid (geo_precision 'city',
//   'kommune' or 'postal') has distance_km null, never «0 km» (Fase 1c,
//   services/geo-precision.ts), and the additive distance_label says where it
//   is («i Ski-området»); an address-precise one gets «2,4 km unna» beside its
//   km figure. An untagged (null) producer is unchanged and has no label.
//   Ranking still uses the real haversine, as discover() does.

import { getDb } from "../database/init";
import { publicFieldChoices, publicFieldChoicesForMany, withoutHiddenContact, type PublicFieldChoices } from "../owner-features/enforce";
import { knowledgeService } from "./knowledge-service";
import { geocodingService } from "./geocoding-service";
import { isEligibleForRealOrder, isProducerStatedSource, isRowOrderableForRealOrder, foodInfoOf, type FoodInfo } from "./cart-service";
import { computeEffectiveAvailability } from "./supply-graph";
import { haversineDistanceKm, KM_PER_DEG_LAT, kmPerDegLng } from "./geo-distance";
import { isValidLatLng } from "../utils/geo-query";
import { slugify } from "../utils/slug";
import { publicListableSql } from "./agent-visibility";
import { isCategoryLabel } from "../utils/category-label";
import { productNameMatch, COMPOUND_HEAD_MIN_LENGTH, type ProductNameMatch } from "../utils/product-name-match";
import { formatRfbDistanceLabel, shouldSuppressDistance } from "./geo-precision";
import { PRODUCT_CATEGORY_KEYWORDS } from "./marketplace-registry";
import { PLATFORM_CATEGORIES, PRODUCT_KEY_TO_PLATFORM } from "./search-enrich";

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
  /** I-V: null when the producer's position is a centroid (see distance_label). */
  distance_km: number | null;
  /** I-V: «2,4 km unna» (address precision) or «i Ski-området» (centroid); absent for an untagged position. */
  distance_label?: string;
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
  /**
   * Skive 4 / 4c: present with food_info, and for every offer of a producer who takes orders
   * (left out otherwise, so such an answer is what it was): the row was stated by the producer, not scraped.
   */
  producer_confirmed?: boolean;
  /** Skive 4: ingredients / allergens / net weight where stated, shown to the buyer before submit; left out when none is stated. */
  food_info?: FoodInfo;
  producer: OfferProducer;
}

/** I-S2: a producer whose catalog has the term only as a category label (see the module comment). */
export interface CategoryMatch {
  match: "category";
  /** The category name on the producer's label row, e.g. «Honning»; of several, the first by name (nb). */
  category: string;
  orderable: false;
  note: string;
  producer: OfferProducer;
}

export interface FindOffersResult {
  term: string;
  offers: Offer[];
  /** I-S2: only when non-empty; offers.length + category_matches.length ≤ limit. */
  category_matches?: CategoryMatch[];
}

/** The note of a category match (NO / EN), as I-N labels a category match in lokal_search. */
export function categoryMatchNote(term: string): string {
  return `Kategoritreff — spør produsenten om de har «${term}». / Category match only — ask the producer whether they have «${term}».`;
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
  geo_precision: string | null;
  is_verified: number;
  product_category: string | null;
  /** agents.categories, a JSON array. */
  agent_categories: string | null;
  ingredients: string | null;
  allergens: string | null;
  net_weight: string | null;
}

// I-V: every word of the query parser's keyword map, and every platform key,
// to the platform categories it names (see platformCategoriesOf).
const PLATFORM_CATEGORIES_OF_WORD: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, string[]>();
  const add = (word: string, category: string) => {
    const list = index.get(word) ?? [];
    if (!list.includes(category)) list.push(category);
    index.set(word, list);
  };
  for (const c of PLATFORM_CATEGORIES) add(c, c);
  for (const [key, keywords] of Object.entries(PRODUCT_CATEGORY_KEYWORDS)) {
    for (const w of [key, ...keywords]) add(w.toLowerCase(), PRODUCT_KEY_TO_PLATFORM[key] ?? key);
  }
  return index;
})();

/**
 * I-V: the platform categories (search-enrich.ts PLATFORM_CATEGORIES) that a
 * search term or a stored category value names: a platform key itself
 * («fruit», «bakery»), or a key or keyword of the query parser's map
 * (marketplace-registry.ts PRODUCT_CATEGORY_KEYWORDS) on its platform key
 * (search-enrich.ts PRODUCT_KEY_TO_PLATFORM). «egg» → eggs, «bær» and
 * «berries» → fruit (berries are sold under fruit), «Kjøtt» → meat. A whole
 * value only, so «Frukt og bær» and «Pålegg» name none.
 */
export function platformCategoriesOf(word: string): readonly string[] {
  return PLATFORM_CATEGORIES_OF_WORD.get(word.trim().toLowerCase()) ?? [];
}

/** I-V: whether a row is in one of `categories`: by its own category, or by its producer's when it has none. */
function rowInCategories(r: RawOfferRow, categories: readonly string[]): boolean {
  const values = r.product_category ? [r.product_category] : producerCategories(r.agent_categories);
  return values.some((v) => platformCategoriesOf(v).some((c) => categories.includes(c)));
}

/** agents.categories (a JSON array) as strings; none when it is not one. */
function producerCategories(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** A row in the radius whose name matches the term, with its distance and its effective availability. */
interface OfferCandidate {
  r: RawOfferRow;
  dist: number;
  match: ProductNameMatch;
  availability: string;
}

/** I-S2: a producer's label rows by name (nb), then id, so its category match does not hang on the rows' order. */
function compareLabelRows(a: RawOfferRow, b: RawOfferRow): number {
  return a.product_name.trim().localeCompare(b.product_name.trim(), "nb") || a.product_id.localeCompare(b.product_id);
}

/** I-V: a producer's best offer row first: best match, in stock, with a price, then by name (nb) and id. */
function compareOfferRows(a: OfferCandidate, b: OfferCandidate): number {
  return b.match - a.match
    || Number(b.availability === "in_stock") - Number(a.availability === "in_stock")
    || Number(b.r.price_nok != null) - Number(a.r.price_nok != null)
    || compareLabelRows(a.r, b.r);
}

/**
 * Skive 4b (S1): for a producer who passes isEligibleForRealOrder() only the
 * producer-stated rows (availability_source producer_dashboard or
 * admin_producer_confirmed) can be ordered, so an in-stock stated row goes
 * before any other row: a scraped row must not hide the confirmed item (and its
 * food information) just because its name matches the term better. When no
 * in-stock stated row is involved, or for a producer who does not pass the
 * gate (every row is a contact row), compareOfferRows alone decides (unchanged).
 * The gate is only evaluated when the two rows differ in being an in-stock
 * stated row; a gate that cannot be evaluated counts as «not eligible».
 */
function compareOffersForProducer(a: OfferCandidate, b: OfferCandidate, db: any): number {
  const aOrderable = isProducerStatedSource(a.r.availability_source) && a.availability === "in_stock";
  const bOrderable = isProducerStatedSource(b.r.availability_source) && b.availability === "in_stock";
  if (aOrderable !== bOrderable) {
    let eligible = false;
    try { eligible = isEligibleForRealOrder(a.r.agent_id, db); } catch { /* not eligible */ }
    if (eligible) return Number(bOrderable) - Number(aOrderable);
  }
  return compareOfferRows(a, b);
}

/** Nearest first; equal distances (one centroid, say) by agent id. */
function byDistance(a: OfferCandidate, b: OfferCandidate): number {
  return a.dist - b.dist || a.r.agent_id.localeCompare(b.r.agent_id);
}

/** A LIKE pattern for text that contains `s` (its %, _ and \ escaped, for ESCAPE '\'). */
function likeContaining(s: string): string {
  return `%${s.replace(/[\\%_]/g, "\\$&")}%`;
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
 * The producer object of an offer (findOffers) or of a pre-selected order
 * line (findProducerOrderables). `dist` null: no position was given, so
 * neither a km figure nor a distance label is sent.
 */
function offerProducerOf(
  db: any,
  r: { agent_id: string; agent_name: string; city: string | null; geo_precision: string | null; is_verified: number },
  dist: number | null,
  choices?: PublicFieldChoices | null,
): OfferProducer {
  const info = knowledgeService.getAgentInfo(r.agent_id);
  // S2c-1: no phone when the owner hid it (contact.phone).
  const k = withoutHiddenContact(info?.knowledge, choices);

  const salgskanaler = (db.prepare(`
    SELECT sc.name AS name
    FROM agent_salgskanal asg
    INNER JOIN salgskanal_categories sc ON sc.slug = asg.category_slug
    WHERE asg.agent_id = ?
    ORDER BY sc.sort_order
  `).all(r.agent_id) as Array<{ name: string }>).map((s) => s.name);

  const isVerified = r.is_verified === 1;
  // skive 2: one shared gate with submitCart() — see the module doc comment.
  const canOrder = isEligibleForRealOrder(r.agent_id, db);

  // I-V: no km figure for a centroid; the label says where it is instead.
  const km = dist == null ? null : Math.round(dist * 10) / 10;
  const distanceLabel = km == null ? null : formatRfbDistanceLabel(km, r.geo_precision, r.city);

  return {
    agent_id: r.agent_id,
    name: r.agent_name,
    city: r.city ?? null,
    distance_km: km == null || shouldSuppressDistance(r.geo_precision) ? null : km,
    ...(distanceLabel ? { distance_label: distanceLabel } : {}),
    verifisert_av_eier: isVerified,
    can_order: canOrder,
    salgskanaler,
    delivery_text: k?.deliveryOptions?.length ? k.deliveryOptions.join(", ") : null,
    phone: k?.phone ?? null,
    email: k?.email ?? null,
    profile_url: `${BASE_URL}/produsent/${slugify(r.agent_name)}`,
    vcard_url: `${BASE_URL}/api/marketplace/agents/${r.agent_id}/vcard`,
  };
}

/**
 * Finds the product offers matching `q` of up to `limit` (max 5) eligible
 * producers within `radiusKm` of the resolved position, one offer per
 * producer (I-V), nearest first, and fills the rest of the `limit` with
 * category matches (I-S2).
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

  // I-V: the LIKE only pre-filters on the term being in the name; the word
  // rule below decides. SQLite's LOWER() and LIKE fold ASCII letters only, so
  // the term is also tried with its first letter upper-cased, or «øl» would
  // miss «Øl fra Lindheim» (an all-caps name is a section header and never
  // reaches `products`).
  const termLower = term.toLowerCase();
  const rows = db.prepare(`
    SELECT
      p.id AS product_id, p.name AS product_name, p.price_nok, p.unit,
      p.availability, p.availability_updated_at, p.availability_source,
      a.id AS agent_id, a.name AS agent_name, a.city AS city,
      a.lat AS lat, a.lng AS lng, a.geo_precision AS geo_precision,
      a.is_verified AS is_verified,
      p.category AS product_category, a.categories AS agent_categories,
      p.ingredients AS ingredients, p.allergens AS allergens, p.net_weight AS net_weight
    FROM products p
    INNER JOIN agents a ON a.id = p.agent_id
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.umbrella_type IS NULL
      AND a.is_active = 1
      AND a.lat IS NOT NULL AND a.lng IS NOT NULL
      AND k.verification_status = 'verified'
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
      AND ${publicListableSql("a")}
      AND a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
      AND (LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.name) LIKE ? ESCAPE '\\')
  `).all(
    position.lat - latDeltaDeg, position.lat + latDeltaDeg,
    position.lng - lngDeltaDeg, position.lng + lngDeltaDeg,
    likeContaining(termLower), likeContaining(termLower.charAt(0).toUpperCase() + termLower.slice(1))
  ) as RawOfferRow[];

  // I-S: the labels are split off before the limit, so they do not shorten
  // the page. I-V: one row per producer, its best (compareOfferRows).
  // I-S2: the free places go to the nearest label producers, one entry each:
  // per producer the label whose name sorts first (nb). A producer with a
  // real offer for the term is never one of them: when there are free
  // places, every such producer is on the page.
  // Equal distances are common (all rows of one producer, producers placed at
  // a city centroid) and the query has no ORDER BY, so no choice uses the
  // rows' order: both lists go by distance, then agent id.
  // A term shorter than COMPOUND_HEAD_MIN_LENGTH may end a word of a row in its own category.
  const termCategories = term.length < COMPOUND_HEAD_MIN_LENGTH ? platformCategoriesOf(term) : [];
  const bestOffer = new Map<string, OfferCandidate>();
  const firstLabel = new Map<string, OfferCandidate>();
  for (const r of rows) {
    const match = productNameMatch(r.product_name, term, termCategories.length > 0 && rowInCategories(r, termCategories));
    if (!match) continue;
    const dist = haversineDistanceKm(position.lat, position.lng, r.lat, r.lng);
    if (dist > radiusKm) continue;
    const x: OfferCandidate = {
      r, dist, match,
      availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
    };
    if (isCategoryLabel({ name: r.product_name, hasPrice: r.price_nok != null, availabilitySource: r.availability_source })) {
      const prev = firstLabel.get(r.agent_id);
      if (!prev || compareLabelRows(r, prev.r) < 0) firstLabel.set(r.agent_id, x);
    } else {
      const prev = bestOffer.get(r.agent_id);
      if (!prev || compareOffersForProducer(x, prev, db) < 0) bestOffer.set(r.agent_id, x);
    }
  }
  const offerRows = [...bestOffer.values()].sort(byDistance).slice(0, limit);
  const matchRows = [...firstLabel.values()]
    .filter((x) => !bestOffer.has(x.r.agent_id))
    .sort(byDistance)
    .slice(0, limit - offerRows.length);

  // One producer shape for offers and category matches.
  const ownerChoices = publicFieldChoicesForMany([...offerRows, ...matchRows].map((x) => x.r.agent_id), { db });
  const producerOf = (r: RawOfferRow, dist: number): OfferProducer => offerProducerOf(db, r, dist, ownerChoices.get(r.agent_id));

  const offers: Offer[] = offerRows.map(({ r, dist, availability }) => {
    const food_info = foodInfoOf(r);
    const producer = producerOf(r, dist);
    return {
      product_id: r.product_id ?? null,
      product_name: r.product_name,
      price_nok: r.price_nok ?? null,
      unit: r.unit ?? null,
      availability,
      // Skive 4c (F3): producer_confirmed is sent for every offer of a producer who takes orders (so a scraped
      // row is a contact choice already in step 2), and for any offer that carries food information.
      ...(food_info || producer.can_order ? { producer_confirmed: isProducerStatedSource(r.availability_source) } : {}),
      ...(food_info ? { food_info } : {}),
      producer,
    };
  });

  if (matchRows.length === 0) return { term, offers };
  const note = categoryMatchNote(term);
  const category_matches: CategoryMatch[] = matchRows.map(({ r, dist }) => ({
    match: "category",
    category: r.product_name.trim(),
    orderable: false,
    note,
    producer: producerOf(r, dist),
  }));
  return { term, offers, category_matches };
}

// ─── Skive 3: one producer's orderable products (bestillingsknapp) ───────
// dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel,
// skive 3: «Bestill for henting» on /produsent/:slug links to
// /handleliste?produsent=<agent_id>, which pre-fills the list with this
// producer's orderable products and pre-selects its offer per item. Read-only;
// no new rule: a producer that fails isEligibleForRealOrder() gets nothing,
// and each row must pass cart-service.isRowOrderableForRealOrder() (the
// add/submit per-row gates). Reached by id, like cart add/submit and
// /catalog/agents/:id/products, so — per agent-visibility.ts — no
// public-listability filter here; the callers carry their own (the producer
// page; /handleliste?produsent= checks isAgentIdPubliclyVisible first).

/** agents.id shape accepted from a URL (UUIDs and the older slug-like ids). */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isWellFormedAgentId(raw: unknown): raw is string {
  return typeof raw === "string" && AGENT_ID_RE.test(raw);
}

export interface ProducerOrderables {
  producer: OfferProducer;
  offers: Offer[];
}

interface RawProducerRow {
  product_id: string;
  product_name: string;
  description: string | null;
  price_nok: number | null;
  unit: string | null;
  availability: string;
  availability_updated_at: string | null;
  availability_source: string;
  product_category: string | null;
  ingredients: string | null;
  allergens: string | null;
  net_weight: string | null;
  agent_id: string;
  agent_name: string;
  city: string | null;
  geo_precision: string | null;
  is_verified: number;
}

/**
 * The orderable products of one producer, as offers of the shape findOffers
 * returns (distance_km null: no position), sorted by name (nb), then id, and
 * at most `limit`. null when the id is malformed, the producer does not pass
 * isEligibleForRealOrder(), or none of its rows is orderable. Never throws.
 */
export function findProducerOrderables(
  agentId: unknown,
  opts: { db?: any; now?: Date; limit: number },
): ProducerOrderables | null {
  if (!isWellFormedAgentId(agentId)) return null;
  try {
    const db = opts.db ?? getDb();
    const now = opts.now ?? new Date();
    if (!isEligibleForRealOrder(agentId, db)) return null;
    const rows = db.prepare(`
      SELECT
        p.id AS product_id, p.name AS product_name, p.description AS description,
        p.price_nok, p.unit, p.availability, p.availability_updated_at, p.availability_source,
        p.category AS product_category,
        p.ingredients AS ingredients, p.allergens AS allergens, p.net_weight AS net_weight,
        a.id AS agent_id, a.name AS agent_name, a.city AS city,
        a.geo_precision AS geo_precision, a.is_verified AS is_verified
      FROM products p
      INNER JOIN agents a ON a.id = p.agent_id
      WHERE a.id = ?
    `).all(agentId) as RawProducerRow[];
    const orderable = rows
      .filter((r) => isRowOrderableForRealOrder(db, { ...r, name: r.product_name, category: r.product_category }, now))
      .sort((a, b) => a.product_name.trim().localeCompare(b.product_name.trim(), "nb") || a.product_id.localeCompare(b.product_id))
      .slice(0, Math.max(0, opts.limit));
    if (orderable.length === 0) return null;
    const producer = offerProducerOf(db, orderable[0]!, null, publicFieldChoices(agentId, { db }));
    const offers: Offer[] = orderable.map((r) => {
      const food_info = foodInfoOf(r);
      return {
        product_id: r.product_id,
        product_name: r.product_name,
        price_nok: r.price_nok ?? null,
        unit: r.unit ?? null,
        availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
        producer_confirmed: true,
        ...(food_info ? { food_info } : {}),
        producer,
      };
    });
    return { producer, offers };
  } catch (e) {
    console.error("[catalog-offers] findProducerOrderables failed:", e);
    return null;
  }
}
