/**
 * admin-knowledge-geocode-invalidate.test.ts — tests for the geocode
 * invalidation added to PUT /admin/knowledge (routes/admin-knowledge.ts;
 * dev-request 2026-09-11-rettet-adresse-oppdaterer-ikke-kartpunktet).
 *
 * Root cause fixed here (root cause 2 of 2 — root cause 1, the geocode
 * worker's selector never re-attempting a row already at 'address'
 * precision, is unaffected by design: that IS the ceiling this invalidation
 * exists to clear): this route wrote `agent_knowledge.address`/`postal_code`
 * but never reset `agents.geo_precision`/`lat`/`lng`/`geocode_source`/
 * `geocode_outcome`/`geocode_attempts`/`geocode_attempted_at`, so a row
 * already geocoded to 'address' precision from the OLD address kept its
 * stale coordinate forever — concretely, "Valens heimelaga"'s map pin stayed
 * near Haugesund (~210 km away) after customer service corrected the address
 * to Nordagutu, across two customer complaints.
 *
 * Covers (acceptance criterion 1):
 *   i1-i5  an address change resets ALL seven geocode fields to their
 *          documented reset values (NULL except geocode_attempts -> 0),
 *          and the response carries geocode_invalidated:true
 *   i6-i8  an UNCHANGED address (byte-identical, including post-
 *          normalisation — the trailing ", Norge" case) does NOT reset
 *          anything, and geocode_invalidated is ABSENT from the response
 *   i9-i11 a postal_code-only change (address untouched) also invalidates
 *   i12    a PUT that never touches address/postalCode at all never
 *          invalidates (a sibling-field-only write)
 *   i13    going from NO address to a real one invalidates too (clears
 *          whatever stale city/kommune centroid tier might be sitting there)
 *   i14    a REFUSED allow_correct overwrite (existing value kept, "address"
 *          dropped from columns_updated) must NOT invalidate — nothing
 *          actually changed
 *   i15    valueChanged() — the pure helper — table-driven
 *
 * Setup mirrors admin-knowledge-address-norge-suffix.test.ts's harness:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting, the
 * default-exported router driven through router.handle() with a fake
 * req/res — no HTTP, no network.
 *
 * Exported runAdminKnowledgeGeocodeInvalidateTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-knowledge-geocode-invalidate.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runAdminKnowledgeGeocodeInvalidateTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    delete require.cache[require.resolve("./admin-knowledge")];
    const routeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");

    // ── i15: valueChanged() — pure, table-driven ────────────────────────
    const table: Array<[string, string | null | undefined, unknown, boolean]> = [
      ["i15a", "Foo 1", "Foo 1", false],
      ["i15b", "Foo 1", "Foo 2", true],
      ["i15c", null, "Foo 1", true],
      ["i15d", undefined, "Foo 1", true],
      ["i15e", null, "", false], // both "nothing" — not a change
      ["i15f", "", "", false],
      ["i15g", "Foo 1", null, true],
      ["i15h", "3820", "3820", false],
    ];
    for (const [label, oldVal, newVal, expected] of table) {
      assertEq(
        routeMod.valueChanged(oldVal, newVal),
        expected,
        `${label}: valueChanged(${JSON.stringify(oldVal)}, ${JSON.stringify(newVal)}) -> ${expected}`,
      );
    }

    // ── Route-level integration ──────────────────────────────────────────
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "geocode-invalidate-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id,
                             lat, lng, geo_precision, geocode_source, geocode_outcome,
                             geocode_attempts, geocode_attempted_at)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', '', 'producer', ?, 'rfb',
                 ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, field_provenance) VALUES (?, ?, ?, '{}')`,
      );

      // "Valens heimelaga"-shaped fixture: geocoded to 'address' precision
      // near Haugesund from an old address; customer service is about to
      // correct it to Nordagutu.
      function seedGeocoded(id: string, address: string | null, postalCode: string | null) {
        insertAgent.run(
          id, `Test Gård ${id}`, `key-${id}`,
          59.69314, 5.47994, "address", "kartverket_adresse", "high", 0, "2026-09-08T10:00:00.000Z",
        );
        insertKnowledge.run(id, address, postalCode);
      }

      function geoRow(id: string) {
        return db
          .prepare(
            `SELECT lat, lng, geo_precision, geocode_source, geocode_outcome,
                    geocode_attempts, geocode_attempted_at
               FROM agents WHERE id = ?`,
          )
          .get(id) as any;
      }
      function addressRow(id: string) {
        return db
          .prepare(`SELECT address, postal_code FROM agent_knowledge WHERE agent_id = ?`)
          .get(id) as any;
      }

      delete require.cache[require.resolve("./admin-knowledge")];
      const knowledgeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");
      const router = knowledgeMod.default;

      function put(body: any): Promise<RouteResult> {
        return callRoute(router, {
          method: "PUT",
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      // ── i1-i5: a real address change resets ALL seven geocode fields ────
      seedGeocoded("valen-01", "Gamleveien 12, 5500 Haugesund", "5500");
      let r = await put({ agent_id: "valen-01", address: "Nordagutuvegen, 3820 Nordagutu", postalCode: "3820" });
      assertEq(r.status, 200, "i1: 200 on the correcting write");
      let g = geoRow("valen-01");
      assertEq(g.geo_precision, null, "i2: geo_precision reset to NULL");
      assertEq(g.lat, null, "i3a: lat reset to NULL — the stale Haugesund-area point is gone");
      assertEq(g.lng, null, "i3b: lng reset to NULL");
      assertEq(g.geocode_source, null, "i4a: geocode_source reset to NULL");
      assertEq(g.geocode_outcome, null, "i4b: geocode_outcome reset to NULL");
      assertEq(g.geocode_attempts, 0, "i5a: geocode_attempts reset to 0 (NOT_PARKED again)");
      assertEq(g.geocode_attempted_at, null, "i5b: geocode_attempted_at cleared — selectable again next tick");
      assertEq(r.body?.geocode_invalidated, true, "i5c: response reports geocode_invalidated:true");
      const addrAfter = addressRow("valen-01");
      assertEq(addrAfter.address, "Nordagutuvegen, 3820 Nordagutu", "i5d: the corrected address text is what's actually stored");
      assertEq(addrAfter.postal_code, "3820", "i5e: …and the corrected postal_code");

      // ── i6-i8: an UNCHANGED address must NOT reset anything ──────────────
      seedGeocoded("stable-01", "Storgata 5, 0155 Oslo", "0155");
      r = await put({ agent_id: "stable-01", address: "Storgata 5, 0155 Oslo", postalCode: "0155" });
      assertEq(r.status, 200, "i6: 200 on the no-op write");
      g = geoRow("stable-01");
      assertEq(g.geo_precision, "address", "i7a: geo_precision UNCHANGED — same address, nothing to invalidate");
      assertEq(g.lat, 59.69314, "i7b: lat UNCHANGED");
      assertEq(g.geocode_attempted_at, "2026-09-08T10:00:00.000Z", "i7c: geocode_attempted_at UNCHANGED");
      assertTrue(r.body?.geocode_invalidated === undefined, "i8: geocode_invalidated ABSENT — this write did nothing geocode-relevant");

      // Also unchanged when the write goes through the trailing ", Norge"
      // normalizer (dev-request 2026-09-09-outreach-profilkvalitet) — the
      // OLD column value is compared against the value that actually lands
      // in the column (post-normalisation), not the raw incoming body.
      seedGeocoded("stable-02", "Torvet 1, Arendal", "4838");
      r = await put({ agent_id: "stable-02", address: "Torvet 1, Arendal, Norge", postalCode: "4838" });
      g = geoRow("stable-02");
      assertEq(g.geo_precision, "address", "i8b: a write that normalises to the SAME stored address is still a no-op for geocode purposes");
      assertTrue(r.body?.geocode_invalidated === undefined, "i8c: …and geocode_invalidated is absent here too");

      // ── i9-i11: postal_code-only change also invalidates ─────────────────
      seedGeocoded("postal-01", "Kirkeveien 9", "9990");
      r = await put({ agent_id: "postal-01", postalCode: "9991" });
      assertEq(r.body?.geocode_invalidated, true, "i9: a postal_code change alone invalidates too");
      g = geoRow("postal-01");
      assertEq(g.geo_precision, null, "i10: geo_precision reset");
      assertEq(g.lat, null, "i11: lat reset");

      // ── i12: a sibling-field-only write never invalidates ────────────────
      seedGeocoded("sibling-01", "Fjellveien 2", "9000");
      r = await put({ agent_id: "sibling-01", about: "Vi selger honning fra egen gård." });
      assertTrue(r.body?.geocode_invalidated === undefined, "i12: a write that never touches address/postalCode never invalidates");
      g = geoRow("sibling-01");
      assertEq(g.geo_precision, "address", "i12b: geo_precision untouched");
      assertEq(g.lat, 59.69314, "i12c: lat untouched");

      // ── i13: NO address -> a real one invalidates too ─────────────────────
      // (clears whatever centroid/city-tier guess a Tier B/C run might have
      // left, even though this fixture happens to carry an 'address'-tier
      // stamp — the invalidation only cares that the stored value CHANGED.)
      insertAgent.run(
        "new-01", "Test Gård new-01", "key-new-01",
        63.4305, 10.3951, "city", "kartverket_stedsnavn", "city_centroid", 0, "2026-09-01T00:00:00.000Z",
      );
      insertKnowledge.run("new-01", null, null);
      r = await put({ agent_id: "new-01", address: "Kongens gate 1", postalCode: "7011" });
      assertEq(r.body?.geocode_invalidated, true, "i13a: NULL -> real address counts as a change");
      g = geoRow("new-01");
      assertEq(g.geo_precision, null, "i13b: the stale 'city'-tier guess is cleared, not left in place");

      // ── i14: a REFUSED allow_correct overwrite must NOT invalidate ────────
      // Existing address has REAL (non-inference) provenance and no
      // website_ownership=unverified flag, so canCorrectFactualField refuses
      // the overwrite even with allow_correct=1 — "address" never lands in
      // columns_updated, and nothing should be invalidated.
      insertAgent.run(
        "refused-01", "Test Gård refused-01", "key-refused-01",
        59.9, 10.7, "address", "kartverket_adresse", "high", 0, "2026-09-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, field_provenance)
         VALUES (?, ?, ?, ?)`,
      ).run(
        "refused-01",
        "Ekte Gate 1",
        "1234",
        JSON.stringify({ address: [{ value: "Ekte Gate 1", source_type: "homepage", fetched_at: "2026-01-01T00:00:00.000Z" }] }),
      );
      r = await put({
        agent_id: "refused-01",
        address: "Falsk Gate 99",
        postalCode: "1234",
        allow_correct: true,
        field_provenance: { address: [{ value: "Falsk Gate 99", source_type: "web_search", fetched_at: "2026-09-11T00:00:00.000Z" }] },
      });
      assertTrue(
        !(r.body?.columns_updated ?? []).includes("address"),
        "i14a: the overwrite was refused — 'address' never reached columns_updated",
      );
      assertTrue(r.body?.geocode_invalidated === undefined, "i14b: a refused (no-op) address write never invalidates the geocode");
      g = geoRow("refused-01");
      assertEq(g.geo_precision, "address", "i14c: geo_precision untouched — the refused write changed nothing");
      const addrRefused = addressRow("refused-01");
      assertEq(addrRefused.address, "Ekte Gate 1", "i14d: the original (correct) address survives the refused overwrite");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminKnowledgeGeocodeInvalidateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
