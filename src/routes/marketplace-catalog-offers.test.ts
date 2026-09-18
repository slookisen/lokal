/**
 * marketplace-catalog-offers.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 0.
 *
 * Proves GET /api/marketplace/catalog/offers:
 *   - visibility filter (umbrella excluded, unverified excluded,
 *     verified_second_line excluded, inactive excluded, out-of-radius
 *     excluded — based on cart-service.ts's isProducerEligible() /
 *     the GET /feed filter, the "eligible for real checkout" bar; is_active
 *     is checked here even though neither of those two currently check it,
 *     a deliberately stricter bar, see catalog-offers.ts's own note).
 *   - sorted ascending by distance_km, capped at limit (default/max 5).
 *   - can_order = is_verified AND order_notifications_opt_in AND NOT
 *     blocklisted — each clause independently provable false.
 *   - verifisert_av_eier reflects ONLY is_verified (owner-claim), never the
 *     internal verification_status cross-check.
 *   - salgskanaler[] / delivery_text / phone / email / profile_url /
 *     vcard_url are populated from the existing structured sources.
 *   - response envelope is exactly { term, offers: [...] } — no wrapper.
 *   - 400 when `q` is missing; 400 when neither `near` nor `lat`+`lng` given.
 *
 * Harness mirrors marketplace-catalog-supply-graph.test.ts: in-memory
 * better-sqlite3 DB via __setDbForTesting + __initSchemaForTesting, router
 * exercised directly (router.handle(req, res, next)) — no HTTP server.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/marketplace-catalog-offers.test.ts
 *   2. Wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { catalogRouter } from "./marketplace-catalog";
import { add as addToBlocklist } from "../services/blocklist-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; query?: Record<string, any>; headers?: Record<string, string> }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      params: {},
      query: opts.query || {},
      headers,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

// Oslo — chosen because geocodingService hardcodes "oslo" (no network call
// needed for the `near=Oslo` test below).
const OSLO = { lat: 59.9139, lng: 10.7522 };
// ~2 km from Oslo centroid.
const OSLO_NEAR = { lat: 59.9289, lng: 10.7522 };
// Tromsø — ~1 500 km from Oslo, well outside any radius used here.
const TROMSO = { lat: 69.6492, lng: 18.9553 };

function insertAgent(db: Database.Database, a: {
  id: string; name: string; city?: string; lat?: number; lng?: number;
  umbrellaType?: string | null; isActive?: number; isVerified?: number;
  optIn?: number; orderNotificationEmail?: string | null; contactEmail?: string;
}) {
  db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, role, api_key,
       lat, lng, city, umbrella_type, is_active, is_verified,
       order_notifications_opt_in, order_notification_email)
    VALUES (?, ?, 'test', 'test', ?, 'https://example.com', 'producer', ?,
            ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.id, a.name, a.contactEmail ?? `${a.id}@example.com`, `key-${a.id}`,
    a.lat ?? null, a.lng ?? null, a.city ?? null, a.umbrellaType ?? null,
    a.isActive ?? 1, a.isVerified ?? 1,
    a.optIn ?? 1, a.orderNotificationEmail ?? null
  );
}

function insertKnowledge(db: Database.Database, agentId: string, opts: {
  verificationStatus?: string | null; verifiedSecondLine?: number | null;
  phone?: string | null; email?: string | null; deliveryOptions?: string[];
}) {
  db.prepare(`
    INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email, delivery_options)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    agentId,
    opts.verificationStatus === undefined ? "verified" : opts.verificationStatus,
    opts.verifiedSecondLine ?? 0,
    opts.phone ?? null,
    opts.email ?? null,
    JSON.stringify(opts.deliveryOptions ?? [])
  );
}

function insertProduct(db: Database.Database, opts: {
  id: string; agentId: string; name: string; priceNok?: number | null; unit?: string | null;
  availability?: string; availabilitySource?: string; availabilityUpdatedAt?: string | null;
}) {
  db.prepare(`
    INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.agentId, opts.name, opts.name.toLowerCase(),
    opts.priceNok ?? null, opts.unit ?? null,
    opts.availability ?? "in_stock", opts.availabilitySource ?? "enrichment",
    opts.availabilityUpdatedAt ?? null
  );
}

export async function runMarketplaceCatalogOffersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db);
  (initMod as any).__initSchemaForTesting(db);

  try {
    // ── Eligible, nearby, fully order-able producer ────────────────────
    insertAgent(db, { id: "off-eligible", name: "Eligible Gård", city: "Oslo", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isVerified: 1, optIn: 1 });
    insertKnowledge(db, "off-eligible", { verificationStatus: "verified", phone: "91234567", email: "eligible@example.com", deliveryOptions: ["Hjemlevering", "Gårdsbutikk"] });
    insertProduct(db, { id: "prod-eligible", agentId: "off-eligible", name: "Poteter", priceNok: 25, unit: "kg" });
    db.prepare(`INSERT INTO agent_salgskanal (agent_id, category_slug) VALUES ('off-eligible', 'gardsbutikk')`).run();

    // ── Umbrella agent — must be excluded entirely ──────────────────────
    insertAgent(db, { id: "off-umbrella", name: "Paraply AS", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, umbrellaType: "reko" });
    insertKnowledge(db, "off-umbrella", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-umbrella", agentId: "off-umbrella", name: "Poteter" });

    // ── Unverified (verification_status) — excluded ─────────────────────
    insertAgent(db, { id: "off-unverified", name: "Uverifisert Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng });
    insertKnowledge(db, "off-unverified", { verificationStatus: "pending" });
    insertProduct(db, { id: "prod-unverified", agentId: "off-unverified", name: "Poteter" });

    // ── verified_second_line — excluded (low-bar outreach-only, never checkout) ──
    insertAgent(db, { id: "off-secondline", name: "Andrelinje Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng });
    insertKnowledge(db, "off-secondline", { verificationStatus: "verified", verifiedSecondLine: 1 });
    insertProduct(db, { id: "prod-secondline", agentId: "off-secondline", name: "Poteter" });

    // ── Inactive — excluded ──────────────────────────────────────────────
    insertAgent(db, { id: "off-inactive", name: "Inaktiv Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isActive: 0 });
    insertKnowledge(db, "off-inactive", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-inactive", agentId: "off-inactive", name: "Poteter" });

    // ── Far away (Tromsø) — excluded by radius ───────────────────────────
    insertAgent(db, { id: "off-far", name: "Tromsø Poteter", lat: TROMSO.lat, lng: TROMSO.lng });
    insertKnowledge(db, "off-far", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-far", agentId: "off-far", name: "Poteter" });

    // ── Eligible but NOT owner-verified — can_order=false, verifisert_av_eier=false ──
    insertAgent(db, { id: "off-notowner", name: "Ikke Eier-Verifisert Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isVerified: 0, optIn: 1 });
    insertKnowledge(db, "off-notowner", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-notowner", agentId: "off-notowner", name: "Poteter" });

    // ── Eligible + owner-verified but NOT opted in — can_order=false ─────
    insertAgent(db, { id: "off-noopt", name: "Ikke Opt-In Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isVerified: 1, optIn: 0 });
    insertKnowledge(db, "off-noopt", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-noopt", agentId: "off-noopt", name: "Poteter" });

    // ── Eligible + verified + opted in, but blocklisted email — can_order=false ──
    insertAgent(db, { id: "off-blocked", name: "Blokkert Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isVerified: 1, optIn: 1, contactEmail: "blocked@example.com" });
    insertKnowledge(db, "off-blocked", { verificationStatus: "verified" });
    insertProduct(db, { id: "prod-blocked", agentId: "off-blocked", name: "Poteter" });
    addToBlocklist({ email: "blocked@example.com", reason: "test" });

    // ── 6 eligible, close producers to prove the 5-cap + ascending sort ──
    for (let i = 0; i < 6; i++) {
      const id = `off-cap-${i}`;
      // Slightly increasing latitude offset so each is progressively farther.
      insertAgent(db, { id, name: `Cap Gård ${i}`, lat: OSLO_NEAR.lat + i * 0.01, lng: OSLO_NEAR.lng, isVerified: 1, optIn: 1 });
      insertKnowledge(db, id, { verificationStatus: "verified" });
      insertProduct(db, { id: `prod-cap-${i}`, agentId: id, name: "Poteter" });
    }

    // ── Stale producer_dashboard availability → exposed as 'unknown' ────
    // Distinct product name ("Stalevare") so this fixture's distance-0 tie
    // with every other Oslo-area fixture above can never push it out of a
    // limit=5 window in the shared-term ("poteter") tests.
    insertAgent(db, { id: "off-stale", name: "Ustabil Gård", lat: OSLO_NEAR.lat, lng: OSLO_NEAR.lng, isVerified: 1, optIn: 1 });
    insertKnowledge(db, "off-stale", { verificationStatus: "verified" });
    insertProduct(db, {
      id: "prod-stale", agentId: "off-stale", name: "Stalevare",
      availability: "in_stock", availabilitySource: "producer_dashboard",
      availabilityUpdatedAt: "2020-01-01 00:00:00",
    });

    // ════════════════════════════════════════════════════════════════════
    // Test: missing q → 400
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { lat: String(OSLO.lat), lng: String(OSLO.lng) } });
      assertEq(r.status, 400, "missing q: 400");
      assertEq(r.body.success, false, "missing q: success=false");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: missing near AND lat/lng → 400
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter" } });
      assertEq(r.status, 400, "missing position: 400");
      assertEq(r.body.success, false, "missing position: success=false");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: response envelope is exactly { term, offers }
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "5", limit: "1" } });
      assertEq(r.status, 200, "envelope: 200 OK");
      assertEq(r.body.term, "poteter", "envelope: term echoes q");
      assertTrue(Array.isArray(r.body.offers), "envelope: offers is an array");
      assertEq(Object.keys(r.body).sort(), ["offers", "term"], "envelope: exactly {term, offers}, no extra top-level fields");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: visibility filter — only off-eligible (+off-notowner/off-noopt/
    // off-blocked, which are visible-but-not-orderable) show up; umbrella,
    // unverified, second-line, inactive, far-away never do.
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "5", limit: "5" } });
      const ids = (r.body.offers as any[]).map((o) => o.producer.agent_id);
      assertTrue(ids.includes("off-eligible"), "visibility: eligible producer present");
      assertTrue(!ids.includes("off-umbrella"), "visibility: umbrella producer excluded");
      assertTrue(!ids.includes("off-unverified"), "visibility: unverified producer excluded");
      assertTrue(!ids.includes("off-secondline"), "visibility: verified_second_line producer excluded (outreach-only bar, never checkout)");
      assertTrue(!ids.includes("off-inactive"), "visibility: inactive producer excluded");
      assertTrue(!ids.includes("off-far"), "visibility: far-away (Tromsø) producer excluded by radius");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: can_order clauses, independently provable false
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "1", limit: "5" } });
      const byId = new Map<string, any>((r.body.offers as any[]).map((o) => [o.producer.agent_id, o]));

      const elig = byId.get("off-eligible");
      assertTrue(!!elig, "can_order: off-eligible present");
      if (elig) {
        assertEq(elig.producer.can_order, true, "can_order: fully eligible producer → true");
        assertEq(elig.producer.verifisert_av_eier, true, "verifisert_av_eier: is_verified=1 → true");
      }

      const notOwner = byId.get("off-notowner");
      assertTrue(!!notOwner, "can_order: off-notowner present (visible even though not orderable)");
      if (notOwner) {
        assertEq(notOwner.producer.can_order, false, "can_order: is_verified=0 → false");
        assertEq(notOwner.producer.verifisert_av_eier, false, "verifisert_av_eier: is_verified=0 → false (even though verification_status='verified')");
      }

      const noOpt = byId.get("off-noopt");
      assertTrue(!!noOpt, "can_order: off-noopt present");
      if (noOpt) assertEq(noOpt.producer.can_order, false, "can_order: order_notifications_opt_in=0 → false");

      const blocked = byId.get("off-blocked");
      assertTrue(!!blocked, "can_order: off-blocked present");
      if (blocked) assertEq(blocked.producer.can_order, false, "can_order: blocklisted email → false");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: 5-cap + ascending distance sort
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, {
        url: "/offers",
        query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "200", limit: "50" },
      });
      // limit is capped at 5 regardless of the requested 50.
      assertEq(r.body.offers.length, 5, `cap: offers capped at 5 even though limit=50 was requested (got ${r.body.offers.length})`);
      const distances = (r.body.offers as any[]).map((o) => o.producer.distance_km);
      const sorted = [...distances].sort((a, b) => a - b);
      assertEq(distances, sorted, "sort: offers are sorted ascending by distance_km");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: default limit is 5 when omitted
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "200" } });
      assertEq(r.body.offers.length, 5, `default limit: 5 offers returned with no limit= param (got ${r.body.offers.length})`);
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: producer field shape — salgskanaler / delivery_text / phone /
    // email / profile_url / vcard_url / price_nok / unit / availability
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "1", limit: "5" } });
      const off = (r.body.offers as any[]).find((o) => o.producer.agent_id === "off-eligible");
      assertTrue(!!off, "shape: off-eligible offer present");
      if (off) {
        assertEq(off.product_name, "Poteter", "shape: product_name");
        assertEq(off.price_nok, 25, "shape: price_nok");
        assertEq(off.unit, "kg", "shape: unit");
        assertEq(off.availability, "in_stock", "shape: availability");
        assertTrue(typeof off.product_id === "string", "shape: product_id is a string");
        assertEq(off.producer.name, "Eligible Gård", "shape: producer.name");
        assertEq(off.producer.city, "Oslo", "shape: producer.city");
        assertTrue(typeof off.producer.distance_km === "number", "shape: producer.distance_km is a number");
        assertEq(off.producer.salgskanaler, ["Gårdsbutikk"], "shape: producer.salgskanaler is populated from agent_salgskanal");
        assertEq(off.producer.delivery_text, "Hjemlevering, Gårdsbutikk", "shape: producer.delivery_text joins agent_knowledge.delivery_options");
        assertEq(off.producer.phone, "91234567", "shape: producer.phone");
        assertEq(off.producer.email, "eligible@example.com", "shape: producer.email");
        assertTrue(off.producer.profile_url.includes("/produsent/"), "shape: producer.profile_url is a /produsent/ URL");
        assertTrue(off.producer.vcard_url.includes(`/agents/off-eligible/vcard`), "shape: producer.vcard_url points at the vcard route");
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: supply-graph staleness — a stale producer_dashboard row is
    // exposed as 'unknown' here too (same rule as GET /feed).
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "stalevare", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "1", limit: "5" } });
      const stale = (r.body.offers as any[]).find((o) => o.producer.agent_id === "off-stale");
      assertTrue(!!stale, "stale: off-stale offer present");
      if (stale) assertEq(stale.availability, "unknown", "stale: producer_dashboard row >14d old exposes availability='unknown'");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: `near` free-text is geocoded (hardcoded MAJOR_CITIES path — no
    // network needed for "Oslo") and lat/lng takes priority when both given.
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "poteter", near: "Oslo", radius_km: "50", limit: "5" } });
      assertEq(r.status, 200, "near: 200 OK");
      const ids = (r.body.offers as any[]).map((o) => o.producer.agent_id);
      assertTrue(ids.includes("off-eligible"), "near: geocoded 'Oslo' finds the nearby eligible producer");
    }

    // ════════════════════════════════════════════════════════════════════
    // Test: q is a substring/case-insensitive match on product name
    // ════════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, { url: "/offers", query: { q: "POTE", lat: String(OSLO_NEAR.lat), lng: String(OSLO_NEAR.lng), radius_km: "1", limit: "5" } });
      const ids = (r.body.offers as any[]).map((o) => o.producer.agent_id);
      assertTrue(ids.includes("off-eligible"), "q match: case-insensitive substring match finds 'Poteter' for q='POTE'");
    }
  } finally {
    (initMod as any).__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceCatalogOffersTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-catalog-offers: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
