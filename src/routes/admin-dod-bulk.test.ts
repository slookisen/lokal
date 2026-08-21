/**
 * admin-dod-bulk.test.ts — tests for GET /admin/dod-bulk, the READ-ONLY,
 * paginated bulk DoD (Definition-of-Done) endpoint that closes the
 * `MEASUREMENT-PENDING` gap in A2A/scripts/dod-scorecard.py: per-producer
 * verification_status + provenance/content signals for all 8 DoD checks in
 * one batch call, over the SAME population
 * (`role='producer' AND umbrella_type IS NULL`) dod-scorecard.py /
 * scripts/v3-b0-quality-harness.py already use.
 *
 * Covers (src/routes/admin-dod-bulk.ts):
 *   (a) auth — missing X-Admin-Key -> 403, wrong key -> 403, ADMIN_KEY not
 *       configured server-side -> 503.
 *   (b) empty cohort: no rows in DB -> total 0, returned 0, agents: [].
 *   (c) population filter: role != 'producer' and umbrella_type set are both
 *       excluded; a plain producer with no vertical filter is included.
 *   (d) a producer with NO agent_knowledge row at all still appears (LEFT
 *       JOIN), with verification_status defaulting to 'unverified' and every
 *       content check false.
 *   (e) a producer with a full, well-formed profile: all 8 checks true,
 *       build_complete true, INCLUDING provenance_complete computed from a
 *       real (non-inference) 2-source field_provenance entry.
 *   (f) provenance edge cases: an inference-only source (web_search) does
 *       NOT count toward field_source_counts / provenance_complete; a field
 *       with exactly 1 real source does not reach provenance_complete either
 *       (needs >=2 on at least one field).
 *   (g) richness: about text >=120 chars with no nav-junk substring is rich
 *       even with no products; short about + empty products is NOT rich;
 *       empty about + non-empty products IS rich via the products leg.
 *   (h) location: requires BOTH lat and lng — a row with only city set is
 *       location:false (mirrors marketplace-registry.ts's rowToAgent()).
 *   (i) website check reads agent_knowledge.website only — a row with a
 *       populated agents.url but no agent_knowledge.website is website:false.
 *   (j) vertical filter: `?vertical=dental` returns only dental-vertical
 *       producers; total reflects the filtered population.
 *   (k) pagination: limit/offset walk the cohort (ordered by agent_id) without
 *       omission/duplication; default limit/offset when omitted; limit capped
 *       at DOD_BULK_MAX_LIMIT even if a caller asks for more.
 *   (l) read-only: agents + agent_knowledge byte-identical before/after.
 *
 * Standalone: npx tsx src/routes/admin-dod-bulk.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminDodBulkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "dod-bulk-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("../routes/admin-dod-bulk");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-dod-bulk") as typeof import("../routes/admin-dod-bulk");
    const routerModule = routeModule.default;

    const layer = (routerModule as any).stack.find(
      (l: any) => l.route && l.route.path === "/" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET / handler registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callDodBulk(
      query: Record<string, string> = {},
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string;
      name: string;
      role?: string;
      umbrellaType?: string | null;
      verticalId?: string;
      categories?: string[];
      lat?: number | null;
      lng?: number | null;
      city?: string | null;
      url?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           city, lat, lng, categories, vertical_id, umbrella_type,
           created_at, is_active
         ) VALUES (?, 't', 't', 't', 'x@example.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00', 1)`,
      ).run(
        o.id,
        o.url ?? "https://example.com",
        o.role ?? "producer",
        `key-${o.id}`,
        o.city ?? null,
        o.lat ?? null,
        o.lng ?? null,
        JSON.stringify(o.categories ?? []),
        o.verticalId ?? "rfb",
        o.umbrellaType ?? null,
      );
      // name is set separately (schema puts description before it in no
      // particular required order) — done via UPDATE to keep the INSERT
      // column list above stable and readable.
      testDb.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run(o.name, o.id);
    }

    function insertKnowledge(o: {
      agentId: string;
      website?: string | null;
      email?: string | null;
      phone?: string | null;
      about?: string | null;
      products?: unknown[];
      openingHours?: unknown[];
      verificationStatus?: string;
      fieldProvenance?: Record<string, unknown> | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agent_knowledge (
           agent_id, website, email, phone, about, products, opening_hours,
           verification_status, field_provenance, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.agentId,
        o.website ?? null,
        o.email ?? null,
        o.phone ?? null,
        o.about ?? null,
        JSON.stringify(o.products ?? []),
        JSON.stringify(o.openingHours ?? []),
        o.verificationStatus ?? "unverified",
        JSON.stringify(o.fieldProvenance ?? {}),
        new Date().toISOString(),
      );
    }

    // ── (a) auth ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const r0 = await callDodBulk({}, { "x-admin-key": "whatever" });
      assertEq(r0.status, 503, "a1: 503 when no admin key configured server-side");
      process.env.ADMIN_KEY = ADMIN_KEY;

      const r1 = await callDodBulk({}, {});
      assertEq(r1.status, 403, "a2: 403 without X-Admin-Key header");

      const r2 = await callDodBulk({}, { "x-admin-key": "wrong-key" });
      assertEq(r2.status, 403, "a3: 403 with wrong X-Admin-Key");
    }

    // ── (b) empty cohort ──
    {
      const r = await callDodBulk();
      assertEq(r.status, 200, "b1: 200 on empty DB");
      assertEq(r.body.total, 0, "b2: total 0");
      assertEq(r.body.returned, 0, "b3: returned 0");
      assertEq(r.body.agents, [], "b4: agents []");
    }

    // ── (c) population filter ──
    insertAgent({ id: "p-consumer", name: "En kjøper", role: "consumer" });
    insertAgent({ id: "p-umbrella", name: "Et paraply-punkt", umbrellaType: "venue" });
    insertAgent({ id: "p-plain", name: "Vanlig produsent" });
    {
      const r = await callDodBulk({ limit: "50" });
      const ids = r.body.agents.map((a: any) => a.agent_id);
      assertTrue(!ids.includes("p-consumer"), "c1: role=consumer excluded");
      assertTrue(!ids.includes("p-umbrella"), "c2: umbrella_type set excluded");
      assertTrue(ids.includes("p-plain"), "c3: plain producer included");
      assertEq(r.body.total, 1, "c4: total counts only the plain producer");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (d) producer with no agent_knowledge row ──
    insertAgent({ id: "no-knowledge", name: "Uten kunnskapsrad", categories: ["frukt"] });
    {
      const r = await callDodBulk();
      const row = r.body.agents.find((a: any) => a.agent_id === "no-knowledge");
      assertTrue(!!row, "d1: row with no agent_knowledge still appears");
      assertEq(row.verification_status, "unverified", "d2: verification_status defaults to unverified");
      assertEq(row.checks.contact, false, "d3: contact false");
      assertEq(row.checks.website, false, "d4: website false");
      assertEq(row.checks.richness, false, "d5: richness false");
      assertEq(row.checks.opening_hours, false, "d6: opening_hours false");
      assertEq(row.checks.verified, false, "d7: verified false");
      assertEq(row.checks.provenance_complete, false, "d8: provenance_complete false");
      assertEq(row.build_complete, false, "d9: build_complete false");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (e) full, well-formed profile — all 8 checks true ──
    const richAbout =
      "Vi er en liten familiegard som har drevet med okologisk grontsaksdyrking " +
      "og birøkt i over tretti ar. Besok var gardsbutikk for ferske grontsaker, " +
      "honning og hjemmelaget syltetoy rett fra jordet, apent hele sommeren.";
    insertAgent({
      id: "full-1",
      name: "Full Gard",
      categories: ["frukt", "gronnsaker"],
      lat: 63.4,
      lng: 10.4,
      city: "Trondheim",
    });
    insertKnowledge({
      agentId: "full-1",
      website: "https://fullgard.no",
      email: "post@fullgard.no",
      about: richAbout,
      products: [{ name: "Poteter" }],
      openingHours: [{ day: "mon", open: "09:00", close: "17:00" }],
      verificationStatus: "verified",
      fieldProvenance: {
        address: [
          { value: "Gardsveien 1", source_type: "homepage", fetched_at: "2026-01-01" },
          { value: "Gardsveien 1", source_type: "google_places", fetched_at: "2026-01-02" },
        ],
      },
    });
    {
      const r = await callDodBulk();
      const row = r.body.agents.find((a: any) => a.agent_id === "full-1");
      assertTrue(!!row, "e1: full row present");
      assertEq(row.checks, {
        identity: true,
        location: true,
        contact: true,
        website: true,
        richness: true,
        opening_hours: true,
        verified: true,
        provenance_complete: true,
      }, "e2: all 8 checks true");
      assertEq(row.build_complete, true, "e3: build_complete true");
      assertEq(row.field_source_counts, { address: 2 }, "e4: field_source_counts reflects the 2 real address sources");
      assertEq(row.verification_status, "verified", "e5: verification_status passed through");
      assertEq(row.categories_count, 2, "e6: categories_count");
      assertEq(row.products_count, 1, "e7: products_count");
      assertEq(row.opening_hours_count, 1, "e8: opening_hours_count");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (f) provenance edge cases ──
    insertAgent({ id: "prov-inference-only", name: "Kun gjetning" });
    insertKnowledge({
      agentId: "prov-inference-only",
      fieldProvenance: {
        products: [{ value: "Jordbaer", source_type: "web_search", fetched_at: "2026-01-01" }],
      },
    });
    insertAgent({ id: "prov-one-real", name: "En ekte kilde" });
    insertKnowledge({
      agentId: "prov-one-real",
      fieldProvenance: {
        phone: [{ value: "12345678", source_type: "brreg", fetched_at: "2026-01-01" }],
      },
    });
    {
      const r = await callDodBulk({ limit: "50" });
      const inferOnly = r.body.agents.find((a: any) => a.agent_id === "prov-inference-only");
      const oneReal = r.body.agents.find((a: any) => a.agent_id === "prov-one-real");
      assertEq(inferOnly.checks.provenance_complete, false, "f1: inference-only source does not count");
      assertEq(inferOnly.field_source_counts, {}, "f2: inference-only source excluded from field_source_counts entirely");
      assertEq(oneReal.checks.provenance_complete, false, "f3: exactly 1 real source is not provenance_complete");
      assertEq(oneReal.field_source_counts, { phone: 1 }, "f4: 1 real source still reported in field_source_counts");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (g) richness ──
    insertAgent({ id: "rich-about-only", name: "Rik tekst" });
    insertKnowledge({ agentId: "rich-about-only", about: richAbout });
    insertAgent({ id: "short-about-no-products", name: "Kort tekst" });
    insertKnowledge({ agentId: "short-about-no-products", about: "For kort." });
    insertAgent({ id: "products-only", name: "Bare produkter" });
    insertKnowledge({ agentId: "products-only", products: [{ name: "Honning" }] });
    {
      const r = await callDodBulk({ limit: "50" });
      const byId = (id: string) => r.body.agents.find((a: any) => a.agent_id === id);
      assertEq(byId("rich-about-only").checks.richness, true, "g1: long about with no products is rich");
      assertEq(byId("short-about-no-products").checks.richness, false, "g2: short about + no products is NOT rich");
      assertEq(byId("products-only").checks.richness, true, "g3: empty about + non-empty products IS rich");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (h) location requires BOTH lat and lng ──
    insertAgent({ id: "city-only", name: "Bare by", city: "Bergen" });
    {
      const r = await callDodBulk();
      const row = r.body.agents.find((a: any) => a.agent_id === "city-only");
      assertEq(row.checks.location, false, "h1: city alone (no lat/lng) is location:false");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (i) website reads agent_knowledge.website only, not agents.url ──
    insertAgent({ id: "url-only", name: "Bare agents.url", url: "https://has-a-url.example" });
    {
      const r = await callDodBulk();
      const row = r.body.agents.find((a: any) => a.agent_id === "url-only");
      assertEq(row.checks.website, false, "i1: agents.url alone does not satisfy the website check");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (j) vertical filter ──
    insertAgent({ id: "v-rfb", name: "RFB produsent", verticalId: "rfb" });
    insertAgent({ id: "v-dental", name: "Dental produsent", verticalId: "dental" });
    {
      const r = await callDodBulk({ vertical: "dental" });
      const ids = r.body.agents.map((a: any) => a.agent_id);
      assertTrue(ids.includes("v-dental"), "j1: dental row included when filtered to dental");
      assertTrue(!ids.includes("v-rfb"), "j2: rfb row excluded when filtered to dental");
      assertEq(r.body.total, 1, "j3: total reflects the filtered population");
      assertEq(r.body.vertical, "dental", "j4: echoes the vertical filter used");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (k) pagination ──
    for (let i = 0; i < 5; i++) {
      insertAgent({ id: `pg-${i}`, name: `Produsent ${i}` });
    }
    {
      const full = await callDodBulk({ limit: "50" });
      assertEq(full.body.total, 5, "k1: total counts all 5");
      const seen: string[] = [];
      let offset = 0;
      for (let i = 0; i < 7; i++) {
        const page = await callDodBulk({ limit: "1", offset: String(offset) });
        if (page.body.agents.length === 0) break;
        seen.push(...page.body.agents.map((a: any) => a.agent_id));
        offset += 1;
      }
      assertEq(seen.length, 5, "k2: paginated walk visits exactly `total` rows");
      assertEq(new Set(seen).size, seen.length, "k3: no duplicates across pages");

      const r1 = await callDodBulk();
      assertEq(r1.body.limit, 100, "k4: default limit is 100");
      assertEq(r1.body.offset, 0, "k5: default offset is 0");
      const r2 = await callDodBulk({ limit: "5000" });
      assertEq(r2.body.limit, 1000, "k6: limit capped at DOD_BULK_MAX_LIMIT (1000)");
    }
    testDb.exec(`DELETE FROM agents; DELETE FROM agent_knowledge;`);

    // ── (l) read-only ──
    insertAgent({ id: "ro-1", name: "Ro Ett" });
    insertKnowledge({ agentId: "ro-1", email: "ro@example.com" });
    {
      const beforeAgents = testDb.prepare(`SELECT * FROM agents WHERE id = 'ro-1'`).get();
      const beforeKnowledge = testDb.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'ro-1'`).get();
      await callDodBulk();
      const afterAgents = testDb.prepare(`SELECT * FROM agents WHERE id = 'ro-1'`).get();
      const afterKnowledge = testDb.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'ro-1'`).get();
      assertEq(afterAgents, beforeAgents, "l1: no write side-effect on agents");
      assertEq(afterKnowledge, beforeKnowledge, "l2: no write side-effect on agent_knowledge");
    }
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminDodBulkTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      console.log("\nFailures:");
      summary.failures.forEach((f) => console.log(`  ${f}`));
      process.exit(1);
    }
  });
}
