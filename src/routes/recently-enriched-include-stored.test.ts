/**
 * recently-enriched-include-stored.test.ts — unit tests for the
 * `include_stored=1` top-up on the three verifier spot-check sample endpoints:
 *   GET /api/marketplace/admin/agents/recently-enriched    (marketplace.ts)
 *   GET /api/tannlege/admin/agents/recently-enriched       (dental.ts)
 *   GET /api/opplevelser/admin/providers/recently-enriched (opplevelser.ts)
 *
 * A write pause empties the `since` window, so the weekly spot-check recorded
 * insufficient_sample. With include_stored=1 the sample is topped up from
 * content already stored. Per vertical this covers:
 *   - default (no param, or a value other than "1") unchanged: no
 *     sample_source / sample_source_counts keys
 *   - window empty + include_stored -> every row `stored`, each with fields
 *   - window partially filled -> recent first, then stored, no duplicates,
 *     total <= limit
 *   - rows with nothing checkable never come from stored
 *   - inactive / hidden / never-enriched rows never come from stored
 *
 * Setup follows admin-agents-recently-enriched.test.ts (rfb: in-memory main DB
 * via __setDbForTesting) and dental-agents-/opplevelser-providers-recently-
 * enriched.test.ts (in-memory vertical DBs via db-factory, router.handle()).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouterGet(router: any, path: string, opts: { headers?: Record<string, string>; query?: Record<string, string> }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method: "GET",
      url: path + qs,
      originalUrl: path + qs,
      path,
      query,
      headers: opts.headers || {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "not handled") } });
    });
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function daysAgoSqlite(days: number): string {
  return daysAgoIso(days).slice(0, 19).replace("T", " ");
}

export async function runRecentlyEnrichedIncludeStoredTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // Shared checks for a include_stored=1 response.
  function checkMerged(body: any, listKey: string, limit: number, prefix: string): any[] {
    const list = (body?.[listKey] ?? []) as any[];
    const ids = list.map((r) => r.id);
    assertTrue(list.length <= limit, `${prefix}: total ${list.length} <= limit ${limit}`);
    assertEq(new Set(ids).size, ids.length, `${prefix}: no duplicate ids`);
    assertEq(body?.count, list.length, `${prefix}: count matches list length`);
    const firstStored = list.findIndex((r) => r.sample_source === "stored");
    const lastRecent = list.map((r) => r.sample_source).lastIndexOf("recent");
    assertTrue(firstStored === -1 || lastRecent < firstStored, `${prefix}: recent rows come before stored rows`);
    assertTrue(list.every((r) => r.sample_source === "recent" || r.sample_source === "stored"), `${prefix}: every row carries sample_source`);
    assertEq(
      body?.sample_source_counts,
      {
        recent: list.filter((r) => r.sample_source === "recent").length,
        stored: list.filter((r) => r.sample_source === "stored").length,
      },
      `${prefix}: sample_source_counts matches rows`,
    );
    return list;
  }

  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const ADMIN_KEY = process.env.ADMIN_KEY || "include-stored-test-key";
  process.env.ADMIN_KEY = ADMIN_KEY;
  delete process.env.ANALYTICS_ADMIN_KEY;
  const H = { "x-admin-key": ADMIN_KEY };

  // ════════════════════════ RFB (marketplace.ts) ════════════════════════
  {
    const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
      typeof import("../database/init");
    const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");
    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);

      const insertAgent = (id: string, isActive = 1) => testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, city, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test-provider', 'test@example.no', ?, 'By', 'producer', ?, ?)`,
      ).run(id, `Navn ${id}`, `https://${id}.example.no`, `key-${id}`, isActive);
      const insertKnowledge = (agentId: string, lastEnrichedAt: string | null, f: { phone?: string; address?: string; about?: string } = {}) =>
        testDb.prepare(
          `INSERT INTO agent_knowledge (agent_id, last_enriched_at, field_provenance, phone, address, about)
           VALUES (?, ?, '{}', ?, ?, ?)`,
        ).run(agentId, lastEnrichedAt, f.phone ?? null, f.address ?? null, f.about ?? null);

      insertAgent("r-recent");        insertKnowledge("r-recent", daysAgoIso(1), { phone: "12345678" });
      insertAgent("r-recent-empty");  insertKnowledge("r-recent-empty", daysAgoIso(1));
      insertAgent("r-old-1");         insertKnowledge("r-old-1", daysAgoIso(30), { address: "Gata 1" });
      insertAgent("r-old-2");         insertKnowledge("r-old-2", daysAgoIso(40), { about: "Gard med geiter" });
      insertAgent("r-old-blank");     insertKnowledge("r-old-blank", daysAgoIso(30), { phone: "   " });
      insertAgent("r-old-inactive", 0); insertKnowledge("r-old-inactive", daysAgoIso(30), { phone: "87654321" });
      insertAgent("r-never");         insertKnowledge("r-never", null, { phone: "11111111" });

      delete require.cache[require.resolve("../routes/marketplace")];
      const router = require("../routes/marketplace").default;
      const PATH = "/admin/agents/recently-enriched";

      // Default unchanged.
      const def = await callRouterGet(router, PATH, { headers: H, query: { with_fields: "1" } });
      assertEq(def.status, 200, "rfb d1: default -> 200");
      assertEq(Object.keys(def.body), ["success", "count", "agents"], "rfb d2: default response has no sample_source_counts");
      assertEq((def.body.agents as any[]).map((a) => a.id), ["r-recent"], "rfb d3: default window rows only");
      assertTrue((def.body.agents as any[]).every((a) => !("sample_source" in a)), "rfb d4: default rows carry no sample_source");
      const notOne = await callRouterGet(router, PATH, { headers: H, query: { with_fields: "1", include_stored: "true" } });
      assertEq(Object.keys(notOne.body), ["success", "count", "agents"], "rfb d5: include_stored=true (not literal 1) is ignored");

      // Window empty -> all stored, all with fields, exclusions hold.
      const empty = await callRouterGet(router, PATH, { headers: H, query: { since: daysAgoIso(0.01), include_stored: "1", limit: "10" } });
      assertEq(empty.status, 200, "rfb e1: window empty + include_stored -> 200");
      const eList = checkMerged(empty.body, "agents", 10, "rfb e");
      assertEq(eList.map((a) => a.id).sort(), ["r-old-1", "r-old-2", "r-recent"], "rfb e2: stored = enriched+active+checkable only (blank/inactive/never/empty excluded)");
      assertTrue(eList.every((a) => a.sample_source === "stored"), "rfb e3: every row marked stored");
      assertEq(empty.body.sample_source_counts, { recent: 0, stored: 3 }, "rfb e4: counts recent=0 stored=3");

      // Window partially filled (no with_fields: the empty recent row is still served as recent).
      const part = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1", limit: "10" } });
      const pList = checkMerged(part.body, "agents", 10, "rfb p");
      assertEq(pList.filter((a) => a.sample_source === "recent").map((a) => a.id).sort(), ["r-recent", "r-recent-empty"], "rfb p2: window rows (as today) are the recent part");
      assertEq(pList.filter((a) => a.sample_source === "stored").map((a) => a.id).sort(), ["r-old-1", "r-old-2"], "rfb p3: stored part = remaining checkable rows, no window duplicates");
      assertTrue(!pList.some((a) => a.id === "r-recent-empty" && a.sample_source === "stored"), "rfb p4: row without fields never comes from stored");

      // limit caps the total.
      const capped = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1", limit: "3", with_fields: "1" } });
      const cList = checkMerged(capped.body, "agents", 3, "rfb c");
      assertEq(cList.length, 3, "rfb c2: limit=3 -> exactly 3 rows");
      assertEq(cList[0].id, "r-recent", "rfb c3: window row first");
      assertEq(capped.body.sample_source_counts, { recent: 1, stored: 2 }, "rfb c4: 1 recent + 2 stored");

      // Window already full -> no stored rows.
      const full = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1", limit: "1", with_fields: "1" } });
      assertEq(full.body.sample_source_counts, { recent: 1, stored: 0 }, "rfb f1: full window -> no top-up");
    } catch (err) {
      failed++;
      failures.push(`rfb: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb) __setDbForTesting(prevDb);
      try { delete require.cache[require.resolve("../routes/marketplace")]; } catch { /* ignore */ }
      testDb.close();
    }
  }

  // ═══════════════════════ dental (dental.ts) ════════════════════════
  {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    const cachePaths = [require.resolve("../database/db-factory"), require.resolve("./dental")];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");
      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, last_enriched_at, field_provenance, telefon, adresse, om_oss, is_inactive, verification_status)
         VALUES (@id, @id, @hjemmeside, @last_enriched_at, '{}', @telefon, @adresse, @om_oss, @is_inactive, @verification_status)`,
      );
      const add = (id: string, lastEnrichedAt: string | null, f: { telefon?: string; adresse?: string; om_oss?: string; is_inactive?: number; verification_status?: string } = {}) =>
        ins.run({
          id, hjemmeside: `https://${id}.example.no`, last_enriched_at: lastEnrichedAt,
          telefon: f.telefon ?? null, adresse: f.adresse ?? null, om_oss: f.om_oss ?? null,
          is_inactive: f.is_inactive ?? 0, verification_status: f.verification_status ?? "pending_verify",
        });
      add("d-recent", daysAgoSqlite(1), { telefon: "22334455" });
      add("d-recent-empty", daysAgoSqlite(1));
      add("d-old-1", daysAgoSqlite(30), { adresse: "Tanngata 1" });
      add("d-old-2", daysAgoSqlite(60), { om_oss: "Vi er en klinikk" });
      add("d-old-blank", daysAgoSqlite(30), { om_oss: "  " });
      add("d-old-inactive", daysAgoSqlite(30), { telefon: "99999999", is_inactive: 1 });
      add("d-old-rejected", daysAgoSqlite(30), { telefon: "88888888", verification_status: "rejected" });
      add("d-never", null, { telefon: "77777777" });

      const router = (require("./dental") as typeof import("./dental")).default as any;
      const PATH = "/admin/agents/recently-enriched";

      const def = await callRouterGet(router, PATH, { headers: H, query: { with_fields: "1" } });
      assertEq(def.status, 200, "dental d1: default -> 200");
      assertEq(Object.keys(def.body), ["success", "count", "agents"], "dental d2: default response has no sample_source_counts");
      assertEq((def.body.agents as any[]).map((a) => a.id), ["d-recent"], "dental d3: default window rows only");
      assertTrue((def.body.agents as any[]).every((a) => !("sample_source" in a)), "dental d4: default rows carry no sample_source");

      // The paused-dental case: window empty -> sample comes from stored.
      const empty = await callRouterGet(router, PATH, { headers: H, query: { since: daysAgoIso(0.01), include_stored: "1", with_fields: "1" } });
      assertEq(empty.status, 200, "dental e1: window empty + include_stored -> 200");
      const eList = checkMerged(empty.body, "agents", 10, "dental e");
      assertEq(eList.map((a) => a.id).sort(), ["d-old-1", "d-old-2", "d-recent"], "dental e2: stored = enriched+visible+checkable only (blank/inactive/rejected/never/empty excluded)");
      assertTrue(eList.every((a) => a.sample_source === "stored"), "dental e3: every row marked stored");
      assertTrue(eList.every((a) => typeof a.name === "string" && "field_provenance" in a && "last_enriched_at" in a), "dental e4: stored rows keep the normal row shape");

      const part = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1" } });
      const pList = checkMerged(part.body, "agents", 10, "dental p");
      assertEq(pList.filter((a) => a.sample_source === "recent").map((a) => a.id).sort(), ["d-recent", "d-recent-empty"], "dental p2: window rows are the recent part");
      assertEq(pList.filter((a) => a.sample_source === "stored").map((a) => a.id).sort(), ["d-old-1", "d-old-2"], "dental p3: stored part has no window duplicates");

      const capped = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1", with_fields: "1", limit: "2" } });
      const cList = checkMerged(capped.body, "agents", 2, "dental c");
      assertEq(cList.map((a) => a.sample_source), ["recent", "stored"], "dental c2: limit=2 -> 1 recent then 1 stored");
    } catch (err) {
      failed++;
      failures.push(`dental: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  // ═════════════════ experiences (opplevelser.ts) ═════════════════════
  {
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const insP = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, last_enriched_at, about_text, visit_text,
            opening_hours_text, products, content_source, content_evidence_url,
            enrichment_state, verification_status, source, confidence, catalog_hidden, is_test_provider)
         VALUES
           (@id, @id, 'experiences', @hjemmeside, @last_enriched_at, @about_text, NULL,
            NULL, @products, NULL, NULL,
            'raw', 'pending_verify', 'test-fixture', 'medium', @catalog_hidden, @is_test_provider)`,
      );
      const addP = (id: string, lastEnrichedAt: string | null, f: { about_text?: string; products?: string; catalog_hidden?: number; is_test_provider?: number } = {}) =>
        insP.run({
          id, hjemmeside: `https://${id}.example.no`, last_enriched_at: lastEnrichedAt,
          about_text: f.about_text ?? null, products: f.products ?? null,
          catalog_hidden: f.catalog_hidden ?? 0, is_test_provider: f.is_test_provider ?? null,
        });
      const insE = db.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, description, category, subcategory, booking_url,
            content_source, enrichment_state, content_field_evidence, updated_at)
         VALUES
           (@id, @provider_id, @title, @description, NULL, NULL, NULL,
            @content_source, 'enriched', @content_field_evidence, @updated_at)`,
      );
      const addE = (id: string, providerId: string, f: { description: string; content_source?: string; evidence?: string }) =>
        insE.run({
          id, provider_id: providerId, title: `Tittel ${id}`, description: f.description,
          content_source: f.content_source ?? "provider_site",
          content_field_evidence: f.evidence ? JSON.stringify({ description: f.evidence }) : null,
          updated_at: daysAgoIso(30),
        });

      addP("x-recent", daysAgoSqlite(1), { about_text: "Ny tekst" });
      addP("x-recent-empty", daysAgoSqlite(1));
      addP("x-old-about", daysAgoSqlite(30), { about_text: "Lagret tekst" });
      addP("x-old-products", daysAgoSqlite(30), { products: JSON.stringify(["Eplesider"]) });
      addP("x-old-exp", daysAgoSqlite(30));
      addE("e-old-exp", "x-old-exp", { description: "Guidet tur", evidence: "https://x-old-exp.example.no/tur" });
      // Only experience row was written from an aggregator -> screened out -> nothing judgeable.
      addP("x-old-aggregator-only", daysAgoSqlite(30));
      addE("e-agg", "x-old-aggregator-only", { description: "Fra visitnorway", evidence: "https://visitnorway.com/x" });
      // Only experience row is owner-authored -> excluded from the projection.
      addP("x-old-manual-only", daysAgoSqlite(30));
      addE("e-manual", "x-old-manual-only", { description: "Eiers egen tekst", content_source: "manual" });
      addP("x-old-empty", daysAgoSqlite(30), { products: "[]" });
      addP("x-old-hidden", daysAgoSqlite(30), { about_text: "Skjult", catalog_hidden: 1 });
      addP("x-old-testprov", daysAgoSqlite(30), { about_text: "Test", is_test_provider: 1 });
      addP("x-never", null, { about_text: "Aldri beriket" });

      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const PATH = "/admin/providers/recently-enriched";

      const def = await callRouterGet(router, PATH, { headers: H, query: {} });
      assertEq(def.status, 200, "exp d1: default -> 200");
      assertEq(Object.keys(def.body), ["success", "count", "providers"], "exp d2: default response has no sample_source_counts");
      assertEq((def.body.providers as any[]).map((p) => p.id).sort(), ["x-recent", "x-recent-empty"], "exp d3: default window rows only");
      assertTrue((def.body.providers as any[]).every((p) => !("sample_source" in p)), "exp d4: default rows carry no sample_source");

      const empty = await callRouterGet(router, PATH, { headers: H, query: { since: daysAgoIso(0.01), include_stored: "1" } });
      assertEq(empty.status, 200, "exp e1: window empty + include_stored -> 200");
      const eList = checkMerged(empty.body, "providers", 10, "exp e");
      assertEq(
        eList.map((p) => p.id).sort(),
        ["x-old-about", "x-old-exp", "x-old-products", "x-recent"],
        "exp e2: stored = enriched+visible+checkable only (aggregator-only/manual-only/empty/hidden/test/never excluded)",
      );
      assertTrue(eList.every((p) => p.sample_source === "stored"), "exp e3: every row marked stored");
      const exp = eList.find((p) => p.id === "x-old-exp");
      assertEq((exp?.enriched_experiences ?? []).map((e: any) => e.id), ["e-old-exp"], "exp e4: stored row keeps the normal projection (enriched_experiences)");

      const part = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1" } });
      const pList = checkMerged(part.body, "providers", 10, "exp p");
      assertEq(pList.filter((p) => p.sample_source === "recent").map((p) => p.id).sort(), ["x-recent", "x-recent-empty"], "exp p2: window rows are the recent part");
      assertEq(pList.filter((p) => p.sample_source === "stored").map((p) => p.id).sort(), ["x-old-about", "x-old-exp", "x-old-products"], "exp p3: stored part has no window duplicates");

      const capped = await callRouterGet(router, PATH, { headers: H, query: { include_stored: "1", limit: "3" } });
      const cList = checkMerged(capped.body, "providers", 3, "exp c");
      assertEq(cList.length, 3, "exp c2: limit=3 -> exactly 3 rows");
      assertEq(capped.body.sample_source_counts, { recent: 2, stored: 1 }, "exp c3: 2 recent + 1 stored");
    } catch (err) {
      failed++;
      failures.push(`experiences: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  }

  if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
  if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/recently-enriched-include-stored.test.ts`
if (require.main === module) {
  runRecentlyEnrichedIncludeStoredTests({ log: true }).then((r) => {
    console.log(`\nrecently-enriched-include-stored: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
