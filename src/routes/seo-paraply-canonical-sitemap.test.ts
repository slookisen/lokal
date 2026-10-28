/**
 * seo-paraply-canonical-sitemap.test.ts — dev-request
 * 2026-10-06-rfb-sitemap-rollesperre-bm-event-og-paraply-canonical (skive B,
 * option A).
 *
 * Umbrella pages (/produsent/<slug> for umbrella_type != NULL):
 *   - canonical (and og:url) is the page's own URL (NO and /en), no longer
 *     the front page; a non-empty umbrella has no noindex;
 *   - an umbrella with 0 members and 0 upcoming market days is noindex and
 *     absent from the sitemap (members-only, events-only and past-event
 *     variants; a hidden producer is not a member);
 *   - the sitemap lists non-empty umbrellas (NO + EN, hreflang alternates)
 *     and never one that fails the route's gates (unvetted, catalog_hidden,
 *     non-RFB vertical, inactive);
 *   - invariant: every /produsent/ URL in the sitemap answers 200 and is not
 *     noindex, umbrellas included; the cached /sitemap.xml path carries them.
 *
 * Exported runSeoParaplyCanonicalSitemapTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/seo-paraply-canonical-sitemap.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runSeoParaplyCanonicalSitemapTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origErr = console.error;
  let seo: typeof import("./seo") | undefined;
  let registry: any;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const ins = testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at,
        umbrella_type, parent_umbrella_id, is_vetted, catalog_hidden, vertical_id
      ) VALUES (?, ?, 'Beskrivelse', ?, ?, ?, ?, ?, '[]', '[]', '[]', '{}', '["no"]', 'Oslo',
        0.5, ?, 0, 0, 0, 0, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)`,
    );
    const know = testDb.prepare("INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status) VALUES (?, datetime('now'), datetime('now'), 'enriched')");
    type Row = { id: string; name: string; role?: string; umbrella_type?: string | null; parent?: string | null; active?: number; vetted?: number; hidden?: number; vertical?: string | null };
    const add = (r: Row) => {
      ins.run(r.id, r.name, r.name, `${r.id}@example.no`, `https://${r.id}.example.no`, r.role ?? "producer", `key-${r.id}`,
        r.active ?? 1, r.umbrella_type ?? null, r.parent ?? null, r.vetted ?? 1, r.hidden ?? 0, r.vertical ?? "rfb");
      know.run(r.id);
    };
    const aff = testDb.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, ?, 'admin')");
    let evN = 0;
    const event = (venueId: string, startAt: string) =>
      testDb.prepare("INSERT INTO bm_market_events (venue_agent_id, event_slug, event_name, start_at, source_url) VALUES (?, ?, 'Markedsdag', ?, 'https://bondensmarked.no')")
        .run(venueId, `ev-${++evN}`, startAt);

    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    const past = new Date(Date.now() - 7 * 86400000).toISOString();

    // Producers
    add({ id: "pc-p1", name: "Paraply Gard En" });
    add({ id: "pc-p2", name: "Paraply Gard To" });
    add({ id: "pc-hid", name: "Skjult Fixture Gard", hidden: 1 });
    // Umbrellas — non-empty
    add({ id: "pc-nat", name: "Bondens marked Norge", role: "quality", umbrella_type: "market_network" });
    add({ id: "pc-osl", name: "Bondens marked Oslo", umbrella_type: "market_network", parent: "pc-nat" });
    aff.run("pc-p1", "pc-osl", "active");
    add({ id: "pc-ven", name: "Testtorget Venue", umbrella_type: "venue", parent: "pc-osl" });
    event("pc-ven", future); // events only, no members
    add({ id: "pc-org", name: "Medlemsforening Test", umbrella_type: "industry_org" });
    aff.run("pc-p2", "pc-org", "active"); // members only
    // Umbrellas — empty
    add({ id: "pc-e1", name: "Tom Forening", umbrella_type: "industry_org" });
    add({ id: "pc-e2", name: "Gammelt Torg", umbrella_type: "venue" });
    event("pc-e2", past); // only a PAST market day
    add({ id: "pc-e3", name: "Ventende Forening", umbrella_type: "cooperative" });
    aff.run("pc-p1", "pc-e3", "pending_confirmation"); // not an active member
    add({ id: "pc-e4", name: "Skjult Medlem Forening", umbrella_type: "industry_org" });
    aff.run("pc-hid", "pc-e4", "active"); // only member is a hidden fixture
    // Umbrellas — fail the route's gates (with members, so only the gate excludes them)
    add({ id: "pc-g1", name: "Ikke Vettet Paraply", umbrella_type: "industry_org", vetted: 0 });
    aff.run("pc-p1", "pc-g1", "active");
    add({ id: "pc-g2", name: "Skjult Paraply", umbrella_type: "industry_org", hidden: 1 });
    aff.run("pc-p1", "pc-g2", "active");
    add({ id: "pc-g3", name: "Tannlege Paraply", umbrella_type: "industry_org", vertical: "dental" });
    aff.run("pc-p1", "pc-g3", "active");
    add({ id: "pc-g4", name: "Inaktiv Paraply", umbrella_type: "industry_org", active: 0 });
    aff.run("pc-p1", "pc-g4", "active");

    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    delete require.cache[require.resolve("./seo")];
    seo = require("./seo") as typeof import("./seo");
    registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry;
    registry.invalidateCache();
    seo.__resetSitemapCacheForTesting();

    const layer = ((seo.default as any).stack as any[]).find(
      (l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    function render(slug: string, lang: "no" | "en" = "no"): { status: number; html: string } {
      let status = 200;
      let html = "";
      const res: any = {
        status(c: number) { status = c; return res; },
        send(b: any) { html = String(b); return res; },
        redirect(c: number) { status = c; return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      const req: any = {
        params: { slug }, query: {}, body: {}, headers: {}, ip: "127.0.0.1", lang, protocol: "https",
        get(n: string) { return n.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
      };
      console.log = () => {};
      try { handler(req, res, () => {}); } finally { console.log = origLog; }
      return { status, html };
    }
    const canonicalOf = (html: string) => (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    const ogUrlOf = (html: string) => (html.match(/<meta property="og:url" content="([^"]+)"/) || [])[1];
    const isNoindex = (html: string) => /<meta name="robots" content="[^"]*noindex/.test(html);
    const BASE = "https://rettfrabonden.com";

    // ── 1. Self-canonical + no noindex on non-empty umbrellas ───────────
    for (const name of ["Bondens marked Oslo", "Bondens marked Norge", "Testtorget Venue", "Medlemsforening Test"]) {
      const slug = slugify(name);
      const no = render(slug, "no");
      assertEq(no.status, 200, `${slug}: 200`);
      assertEq(canonicalOf(no.html), `${BASE}/produsent/${slug}`, `${slug}: canonical is its own URL (not the front page)`);
      assertEq(ogUrlOf(no.html), `${BASE}/produsent/${slug}`, `${slug}: og:url is its own URL`);
      assertTrue(!isNoindex(no.html), `${slug}: non-empty umbrella is NOT noindex`);
      const en = render(slug, "en");
      assertEq(canonicalOf(en.html), `${BASE}/en/produsent/${slug}`, `${slug}: /en canonical is its own /en URL`);
    }
    // JSON-LD @id of the umbrella matches the producer memberOf target.
    const osl = render("bondens-marked-oslo").html;
    assertTrue(osl.includes(`"@id":"${BASE}/produsent/bondens-marked-oslo#org"`), "bondens-marked-oslo: JSON-LD @id is its own #org");
    const p1 = render(slugify("Paraply Gard En")).html;
    assertTrue(p1.includes(`"@id":"${BASE}/produsent/bondens-marked-oslo#org"`), "producer memberOf points at the umbrella's own #org");
    assertTrue(!isNoindex(p1), "producer page: unchanged, not noindex");

    // ── 2. Empty umbrellas: noindex (still 200, self-canonical) ─────────
    const emptySlugs = ["Tom Forening", "Gammelt Torg", "Ventende Forening", "Skjult Medlem Forening"].map(slugify);
    for (const slug of emptySlugs) {
      const r = render(slug);
      assertEq(r.status, 200, `${slug}: empty umbrella still answers 200`);
      assertTrue(isNoindex(r.html), `${slug}: empty umbrella is noindex`);
      assertEq(canonicalOf(r.html), `${BASE}/produsent/${slug}`, `${slug}: empty umbrella self-canonical`);
    }

    // ── 3. Shared predicate ──────────────────────────────────────────────
    const { umbrellaHasContent, indexableUmbrellas } = require("../services/umbrella-indexability") as
      typeof import("../services/umbrella-indexability");
    assertEq(umbrellaHasContent(testDb, "pc-ven"), true, "predicate: venue with an upcoming event has content");
    assertEq(umbrellaHasContent(testDb, "pc-ven", new Date(Date.now() + 30 * 86400000).toISOString()), false, "predicate: same venue after its last event is empty");
    assertEq(umbrellaHasContent(testDb, "pc-org"), true, "predicate: active affiliation = member");
    assertEq(umbrellaHasContent(testDb, "pc-e1"), false, "predicate: no members, no events = empty");
    assertEq(umbrellaHasContent(testDb, "pc-e2"), false, "predicate: past event only = empty");
    assertEq(umbrellaHasContent(testDb, "pc-e3"), false, "predicate: pending affiliation is not a member");
    assertEq(umbrellaHasContent(testDb, "pc-e4"), false, "predicate: hidden producer is not a member");
    assertEq(
      (indexableUmbrellas(testDb) || []).map((r) => r.id).sort(),
      ["pc-nat", "pc-org", "pc-osl", "pc-ven"],
      "predicate: batch list = exactly the gated, non-empty umbrellas",
    );
    // Missing event table: members still count, events silently dropped (like the page).
    const noEv = new Database(":memory:");
    noEv.exec("CREATE TABLE agents (id TEXT, name TEXT, umbrella_type TEXT, parent_umbrella_id TEXT, is_active INTEGER, is_vetted INTEGER, catalog_hidden INTEGER, vertical_id TEXT, agent_review_status TEXT)");
    noEv.exec("CREATE TABLE agent_affiliations (producer_id TEXT, umbrella_id TEXT, status TEXT)");
    noEv.exec("INSERT INTO agents VALUES ('u1','U En','industry_org',NULL,1,1,0,NULL,NULL),('u2','U To','industry_org',NULL,1,1,0,NULL,NULL),('p','P',NULL,NULL,1,1,0,NULL,NULL)");
    noEv.exec("INSERT INTO agent_affiliations VALUES ('p','u1','active')");
    assertEq((indexableUmbrellas(noEv) || []).map((r) => r.id), ["u1"], "predicate: no bm_market_events table -> members-only fallback");
    noEv.close();

    // ── 4. Sitemap ───────────────────────────────────────────────────────
    console.log = () => {};
    const xml = seo.buildSitemapXml();
    console.log = origLog;
    const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]!);
    for (const name of ["Bondens marked Oslo", "Bondens marked Norge", "Testtorget Venue", "Medlemsforening Test"]) {
      const slug = slugify(name);
      assertEq(locs.filter((l) => l === `${BASE}/produsent/${slug}`).length, 1, `sitemap: ${slug} (NO) listed once`);
      assertEq(locs.filter((l) => l === `${BASE}/en/produsent/${slug}`).length, 1, `sitemap: ${slug} (EN) listed once`);
    }
    assertTrue(
      xml.includes(`<xhtml:link rel="alternate" hreflang="en" href="${BASE}/en/produsent/bondens-marked-oslo"/>`),
      "sitemap: umbrella entry carries hreflang alternates like producers",
    );
    for (const slug of emptySlugs) {
      assertEq(locs.filter((l) => l.endsWith(`/produsent/${slug}`)).length, 0, `sitemap: empty umbrella ${slug} has 0 URLs`);
    }
    for (const name of ["Ikke Vettet Paraply", "Skjult Paraply", "Tannlege Paraply", "Inaktiv Paraply"]) {
      const slug = slugify(name);
      assertEq(locs.filter((l) => l.endsWith(`/produsent/${slug}`)).length, 0, `sitemap: gated umbrella ${slug} excluded`);
      assertEq(render(slug).status, 404, `premise: gated umbrella ${slug} is 404 on the route`);
    }

    // Invariant: every /produsent/ URL answers 200 and is indexable.
    const prodLocs = locs.filter((l) => /\/produsent\//.test(l));
    assertTrue(prodLocs.some((l) => l.endsWith("/produsent/bondens-marked-oslo")), "invariant covers umbrellas");
    let allOk = true;
    for (const l of prodLocs) {
      const en = l.startsWith(`${BASE}/en/`);
      const slug = l.split("/produsent/")[1]!;
      const r = render(slug, en ? "en" : "no");
      if (r.status !== 200 || isNoindex(r.html)) { allOk = false; failures.push(`✗ invariant: ${l} -> ${r.status}${isNoindex(r.html) ? " noindex" : ""}`); }
    }
    if (allOk) passed++; else failed++;

    // Cached path (/sitemap.xml) carries the umbrellas too.
    seo.__resetSitemapCacheForTesting();
    console.log = () => {};
    const cached = seo.getSitemapXml();
    console.log = origLog;
    assertTrue(cached.includes(`${BASE}/produsent/bondens-marked-oslo</loc>`), "cached sitemap: umbrella listed");
    assertTrue(!cached.includes(`/produsent/${slugify("Tom Forening")}</loc>`), "cached sitemap: empty umbrella absent");
  } catch (err) {
    failed++;
    failures.push(`paraply-canonical-sitemap: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = origLog;
    console.error = origErr;
    try { seo?.__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    if (prevDb) __setDbForTesting(prevDb);
    try { registry?.invalidateCache(); } catch { /* ignore */ }
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSeoParaplyCanonicalSitemapTests({ log: true }).then((r) => {
    console.log(`\nparaply-canonical-sitemap: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
