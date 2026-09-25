/**
 * rfb-bm-event-jsonld.test.ts — dev-request
 * 2026-09-24-ai-sok-bli-svaret-rfb, slice B2 (Daniel-GO 2026-09-24, see
 * daniel-responses/2026-09-24-go-chatgpt-claude-spor-a-b-c.md in the A2A
 * repo).
 *
 * Covers `src/routes/seo.ts`'s `GET /produsent/:slug` umbrella branch: the
 * "Kommende markedsdager" card (bmEventsHtml, built from bm_market_events)
 * now also emits a parallel schema.org `Event` JSON-LD entry per upcoming
 * row, alongside the existing `Organization` jsonLd for the umbrella
 * itself. `jsonLd` widens from a single object to `[umbJsonLd, ...events]`
 * ONLY when there is at least one upcoming event — zero events must keep
 * emitting exactly today's single Organization object (no regression).
 *
 * Same synthetic router.handle()-less harness as
 * rfb-makesoffer-price-optional.test.ts / rfb-trust-score-public-display-
 * removed.test.ts (own `Database(":memory:")`, `__setDbForTesting`/
 * `__initSchemaForTesting`, the real `seo.ts` router's `/produsent/:slug`
 * handler pulled directly off the route stack — no HTTP server, no port).
 *
 * Exported runBmEventJsonLdTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/rfb-bm-event-jsonld.test.ts
 *   2. Wired into the gate: tests/test.ts imports runBmEventJsonLdTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runBmEventJsonLdTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedVenueAgent(row: { id: string; name: string; city?: string | null; lat?: number | null; lng?: number | null }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        umbrella_type,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
        'venue',
        0.5, 1, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, row.city ?? null, row.lat ?? null, row.lng ?? null,
    );
  }

  function seedEvent(row: {
    venueAgentId: string; eventSlug: string; eventName: string;
    locationText?: string | null; startAt: string; endAt?: string | null; sourceUrl: string;
  }): void {
    testDb.prepare(
      `INSERT INTO bm_market_events (venue_agent_id, event_slug, event_name, location_text, start_at, end_at, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.venueAgentId, row.eventSlug, row.eventName, row.locationText ?? null, row.startAt, row.endAt ?? null, row.sourceUrl);
  }

  function resetRegistryCache(): void {
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }

    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;

    function findLayer(routePath: string) {
      return (seoRouter.stack as any[]).find(
        (l: any) => l.route && l.route.path === routePath && l.route.methods?.get,
      );
    }
    function invoke(routePath: string, req: any): { status: number; body: string } {
      const layer = findLayer(routePath);
      assertTrue(!!layer, `setup: GET ${routePath} layer is registered`);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      handler(req, res, (_e?: unknown) => {});
      return { status, body };
    }

    /** Extracts every JSON-LD <script> block on the page, parsed. */
    function extractJsonLdBlocks(body: string): any[] {
      const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      const parsed: any[] = [];
      for (const b of blocks) {
        try { parsed.push(JSON.parse(b[1])); } catch { /* ignore unparsable block */ }
      }
      return parsed;
    }

    // A future date, well clear of "now" regardless of when this suite runs
    // (2026-09-25 authored) — venues render up to 5 rows ordered by start_at.
    const FUTURE_START = "2026-12-01T10:00:00.000Z";
    const FUTURE_END = "2026-12-01T14:00:00.000Z";
    const PAST_START = "2020-01-01T10:00:00.000Z";

    // ══════════════════════════════════════════════════════════════
    // (a) Venue umbrella WITH an upcoming event -> jsonLd becomes an
    // array [Organization, Event], the Event carries startDate + location.
    // ══════════════════════════════════════════════════════════════
    {
      seedVenueAgent({ id: "bm-venue-with-event", name: "Torget Marked", city: "Oslo", lat: 59.91, lng: 10.75 });
      seedEvent({
        venueAgentId: "bm-venue-with-event",
        eventSlug: "torget-marked-2026-12-01",
        eventName: "Julemarked på Torget",
        locationText: "Torget",
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        sourceUrl: "https://bondensmarked.no/marked/torget-2026-12-01",
      });
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "torget-marked" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "with-event: renders 200");

      // shell() renders an ARRAY jsonLd as one <script> tag PER element
      // (see shell()'s jsonLdScript builder, ~line 551) — not one script
      // tag wrapping a JSON array. So [umbJsonLd, ...bmEventsJsonLd] with
      // 1 event produces 2 separate <script type="application/ld+json">
      // blocks, each a plain object.
      const blocks = extractJsonLdBlocks(r.body);
      assertTrue(blocks.length === 2, "with-event: exactly 2 <script type=application/ld+json> blocks (Organization + Event)");

      const org = blocks.find((x: any) => x["@type"] === "Organization");
      const ev = blocks.find((x: any) => x["@type"] === "Event");
      assertTrue(!!org, "with-event: an Organization entry is present");
      assertTrue(!!ev, "with-event: an Event entry is present");

      assertTrue(!!ev && ev.name === "Julemarked på Torget", "with-event: Event.name matches the seeded event_name");
      assertTrue(!!ev && ev.startDate === FUTURE_START, "with-event: Event.startDate matches the seeded start_at");
      assertTrue(!!ev && ev.endDate === FUTURE_END, "with-event: Event.endDate matches the seeded end_at");
      assertTrue(!!ev && ev.url === "https://bondensmarked.no/marked/torget-2026-12-01", "with-event: Event.url matches the seeded source_url");
      assertTrue(!!ev && typeof ev.location === "object" && ev.location !== null, "with-event: Event.location object is present");
      assertTrue(!!ev && ev.location["@type"] === "Place", "with-event: Event.location.@type is Place");
      assertTrue(!!ev && ev.location.name === "Torget Marked", "with-event: Event.location.name is the venue's name");
      assertTrue(!!ev && ev.location.address && ev.location.address["@type"] === "PostalAddress" && ev.location.address.addressLocality === "Oslo",
        "with-event: Event.location.address is a PostalAddress with the venue's city");
      assertTrue(!!ev && ev.location.geo && ev.location.geo["@type"] === "GeoCoordinates" && ev.location.geo.latitude === 59.91 && ev.location.geo.longitude === 10.75,
        "with-event: Event.location.geo carries the venue's lat/lng");
      assertTrue(!!ev && ev.organizer && ev.organizer["@type"] === "Organization" && ev.organizer.name === "Bondens marked Norge",
        "with-event: Event.organizer is Bondens marked Norge");
      assertTrue(!!ev && ev["@context"] === "https://schema.org", "with-event: Event carries its own @context");
    }

    // ══════════════════════════════════════════════════════════════
    // (b) Venue umbrella with ZERO upcoming events (none seeded) -> jsonLd
    // stays a single Organization object — no regression to today's shape.
    // ══════════════════════════════════════════════════════════════
    {
      seedVenueAgent({ id: "bm-venue-no-events", name: "Stille Marked", city: "Bergen", lat: 60.39, lng: 5.32 });
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "stille-marked" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "no-events: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      assertTrue(blocks.length === 1, "no-events: exactly one <script type=application/ld+json> block");
      const ld = blocks[0];
      assertTrue(!Array.isArray(ld), "no-events: jsonLd is a single object, not an array (no regression)");
      assertTrue(!!ld && ld["@type"] === "Organization", "no-events: the single object is the Organization");
      assertTrue(!!ld && ld.name === "Stille Marked", "no-events: Organization.name matches the venue");
    }

    // ══════════════════════════════════════════════════════════════
    // (c) Venue umbrella with only a PAST event (before "now") -> same
    // no-regression shape as (b): the event query filters start_at >= now.
    // ══════════════════════════════════════════════════════════════
    {
      seedVenueAgent({ id: "bm-venue-past-event", name: "Fortid Marked", city: "Trondheim", lat: 63.43, lng: 10.39 });
      seedEvent({
        venueAgentId: "bm-venue-past-event",
        eventSlug: "fortid-marked-2020-01-01",
        eventName: "Gammelt marked",
        startAt: PAST_START,
        sourceUrl: "https://bondensmarked.no/marked/fortid-2020-01-01",
      });
      resetRegistryCache();

      const r = invoke("/produsent/:slug", { params: { slug: "fortid-marked" }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, "past-event: renders 200");

      const blocks = extractJsonLdBlocks(r.body);
      assertTrue(blocks.length === 1, "past-event: exactly one <script type=application/ld+json> block");
      const ld = blocks[0];
      assertTrue(!Array.isArray(ld), "past-event: jsonLd stays a single object (past events are excluded)");
      assertTrue(!!ld && ld["@type"] === "Organization", "past-event: the single object is the Organization");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-bm-event-jsonld: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
    try {
      const regModCleanup = require("../services/marketplace-registry");
      regModCleanup.marketplaceRegistry._agentsCache = null;
      regModCleanup.marketplaceRegistry._statsCache = null;
    } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-bm-event-jsonld.test.ts`
if (require.main === module) {
  console.log("── RFB Bondens marked Event JSON-LD (dev-request 2026-09-24-ai-sok-bli-svaret-rfb slice B2) unit tests ──");
  runBmEventJsonLdTests({ log: true }).then((r) => {
    console.log(`\nrfb-bm-event-jsonld: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
