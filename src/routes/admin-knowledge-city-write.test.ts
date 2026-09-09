/**
 * admin-knowledge-city-write.test.ts — tests for the new `agents.city` write
 * path wired into PUT /admin/knowledge (routes/admin-knowledge.ts;
 * dev-request 2026-09-09-outreach-profilkvalitet).
 *
 * `agents.city` had NO write path before this slice: PUT /admin/knowledge
 * accepted address/postalCode/about/products/description/categories but not
 * city, so it could only ever be set once, at POST /admin/agents/register.
 * An empty city breaks the seo.ts hero location line, buildProducerAnswer-
 * FirstOpening (needs 2 of {products, city}), JSON-LD addressLocality, and
 * the contact card's postal-code-only fallback.
 *
 * Setup mirrors admin-knowledge-website-write-guard.test.ts's harness:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting, the
 * default-exported router driven through router.handle() with a fake
 * req/res — no HTTP, no network.
 *
 * Covers (acceptance criterion 1):
 *   (a) a PURE ADD (agents.city currently empty) is always written, with or
 *       without allow_correct
 *   (b) a NON-EMPTY existing city is NOT overwritten when allow_correct is
 *       absent — the write is silently dropped (never a 400/error),
 *       city_rejected_reason names why, and columns_updated omits "city"
 *   (c) the SAME overwrite IS applied when allow_correct=1 is set AND the
 *       incoming value carries qualifying evidence (>=2 Tier-A sources) over
 *       an existing value whose own provenance is inference-only (known-bad
 *       legacy) — mirrors canCorrectFactualField's existing address/phone/
 *       about contract exactly
 *   (d) allow_correct=1 alone is NOT sufficient — an overwrite whose existing
 *       value is NOT known-bad legacy (real, non-inference provenance) is
 *       still refused even with the flag set
 *   (e) an unchanged value (identical to what's already there) is always a
 *       no-op write, never blocked
 *   (f) city_rejected_reason is ABSENT on an ordinary call that never
 *       touched city
 *   (g) a rejected city write never blocks the REST of the same call's
 *       column writes (about/etc. still get written)
 *
 * Exported runAdminKnowledgeCityWriteTests({log}) -> TestSummary; wired into
 * tests/test.ts.
 * Standalone: npx tsx src/routes/admin-knowledge-city-write.test.ts
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
      method: opts.method || "PUT",
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

export function runAdminKnowledgeCityWriteTests(
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
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-knowledge-city-write-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, city)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', '', 'producer', ?, 'rfb', ?)`,
      );
      insertAgent.run("akc-01", "Test Gård AS", "key-akc-01", null); // empty city — pure add
      insertAgent.run("akc-02", "Test Gård To AS", "key-akc-02", "Eksisterende By"); // populated
      insertAgent.run("akc-03", "Test Gård Tre AS", "key-akc-03", "Eksisterende By"); // populated
      insertAgent.run("akc-04", "Test Gård Fire AS", "key-akc-04", "Eksisterende By"); // populated
      insertAgent.run("akc-05", "Test Gård Fem AS", "key-akc-05", "Samme By"); // populated, same value test
      insertAgent.run("akc-06", "Test Gård Seks AS", "key-akc-06", "Eksisterende By"); // populated — refuse-doesn't-block-siblings

      // Pre-create agent_knowledge rows so the later field_provenance UPDATEs
      // below (akc-03/akc-04) actually persist — a bare UPDATE against a
      // non-existent row silently affects 0 rows.
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, field_provenance) VALUES (?, '{}')`,
      );
      for (const id of ["akc-02", "akc-03", "akc-04", "akc-05", "akc-06"]) insertKnowledge.run(id);

      delete require.cache[require.resolve("./admin-knowledge")];
      const routeMod = require("./admin-knowledge");
      const router = routeMod.default;

      function put(body: any, query?: Record<string, string>): Promise<RouteResult> {
        return callRoute(router, {
          method: "PUT",
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
          query,
        });
      }
      function cityOf(agentId: string): string | null {
        const row = db.prepare(`SELECT city FROM agents WHERE id = ?`).get(agentId) as
          | { city: string | null }
          | undefined;
        return row?.city ?? null;
      }
      function aboutOf(agentId: string): string | null {
        const row = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
          | { about: string | null }
          | undefined;
        return row?.about ?? null;
      }

      // ── (a) pure ADD — empty city always written, no allow_correct needed ──
      let r = await put({ agent_id: "akc-01", city: "Ny By" });
      assertEq(r.status, 200, "akc-01a: pure-add city write -> 200");
      assertEq(cityOf("akc-01"), "Ny By", "akc-01b: city column actually written");
      assertTrue((r.body?.columns_updated ?? []).includes("city"), "akc-01c: 'city' present in columns_updated");
      assertEq(r.body?.city_rejected_reason, undefined, "akc-01d: no rejection reason for a pure add");

      // ── (b) populated city, allow_correct ABSENT -> refused, never written ─
      r = await put({ agent_id: "akc-02", city: "Ny By" });
      assertEq(r.status, 200, "akc-02a: refused city overwrite -> 200 (never a 400/error)");
      assertEq(r.body?.success, true, "akc-02b: response still reports success:true");
      assertEq(cityOf("akc-02"), "Eksisterende By", "akc-02c: city column left UNTOUCHED (never overwritten)");
      assertTrue(!(r.body?.columns_updated ?? []).includes("city"), "akc-02d: 'city' absent from columns_updated");
      assertEq(
        r.body?.city_rejected_reason,
        "city_populated_allow_correct_required",
        "akc-02e: city_rejected_reason names why (allow_correct required)",
      );

      // ── (c) same overwrite WITH allow_correct=1 + qualifying evidence -> applied ─
      // Existing city's own provenance is inference-only (category_inference) =
      // known-bad legacy; incoming carries 2 distinct Tier-A sources (homepage +
      // google_places) = qualifies. Mirrors canCorrectFactualField's existing
      // address/phone/about contract exactly.
      db.prepare(`UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?`).run(
        JSON.stringify({
          city: [{ value: "Eksisterende By", source_type: "category_inference", fetched_at: "2026-01-01T00:00:00Z" }],
        }),
        "akc-03",
      );
      r = await put(
        {
          agent_id: "akc-03",
          city: "Korrigert By",
          allow_correct: true,
          field_provenance: {
            city: [
              { value: "Korrigert By", source_type: "homepage", fetched_at: "2026-09-09T00:00:00Z" },
              { value: "Korrigert By", source_type: "google_places", fetched_at: "2026-09-09T00:05:00Z" },
            ],
          },
        },
      );
      assertEq(r.status, 200, "akc-03a: allow_correct overwrite -> 200");
      assertEq(cityOf("akc-03"), "Korrigert By", "akc-03b: city column ACTUALLY overwritten with allow_correct + qualifying evidence");
      assertTrue((r.body?.columns_updated ?? []).includes("city"), "akc-03c: 'city' present in columns_updated");
      assertEq(r.body?.city_rejected_reason, undefined, "akc-03d: no rejection reason for an approved correction");
      const akc03Correction = (r.body?.corrections ?? []).find((c: any) => c.field === "city");
      assertTrue(!!akc03Correction && akc03Correction.action === "applied", "akc-03e: corrections[] records the applied city correction");

      // ── (d) allow_correct=1 alone is NOT sufficient — existing value is
      // real (non-inference) provenance, so it is NOT known-bad legacy, and
      // the overwrite is still refused even with the flag set. ──────────────
      db.prepare(`UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = ?`).run(
        JSON.stringify({
          city: [{ value: "Eksisterende By", source_type: "homepage", fetched_at: "2026-01-01T00:00:00Z" }],
        }),
        "akc-04",
      );
      r = await put(
        {
          agent_id: "akc-04",
          city: "Uverifisert By",
          allow_correct: true,
          field_provenance: {
            city: [
              { value: "Uverifisert By", source_type: "homepage", fetched_at: "2026-09-09T00:00:00Z" },
              { value: "Uverifisert By", source_type: "google_places", fetched_at: "2026-09-09T00:05:00Z" },
            ],
          },
        },
      );
      assertEq(cityOf("akc-04"), "Eksisterende By", "akc-04a: allow_correct alone does NOT bypass the known-bad-legacy requirement");
      assertTrue(!(r.body?.columns_updated ?? []).includes("city"), "akc-04b: 'city' absent from columns_updated");
      assertEq(r.body?.city_rejected_reason, "existing_not_known_bad", "akc-04c: rejection reason names the real refusal cause");

      // ── (e) unchanged value — identical to what's already there — is always a no-op write ─
      r = await put({ agent_id: "akc-05", city: "Samme By" });
      assertEq(r.status, 200, "akc-05a: identical-value write -> 200");
      assertEq(cityOf("akc-05"), "Samme By", "akc-05b: city unchanged (still the same value)");
      assertEq(r.body?.city_rejected_reason, undefined, "akc-05c: no rejection reason — nothing was actually being overwritten");

      // ── (f) city_rejected_reason ABSENT on a call that never touched city ──
      r = await put({ agent_id: "akc-01", about: "En helt vanlig oppdatering uten by-felt." });
      assertTrue(
        !Object.prototype.hasOwnProperty.call(r.body ?? {}, "city_rejected_reason"),
        "akc-06: city_rejected_reason key entirely ABSENT when city was never provided",
      );

      // ── (g) a refused city write never blocks the REST of the same call ────
      r = await put({
        agent_id: "akc-06",
        city: "Ny By Uten Bevis",
        about: "Vi produserer ekte gårdshonning fra egne bikuber.",
      });
      assertTrue(!!r.body?.city_rejected_reason, "akc-07a: city overwrite rejected");
      assertEq(cityOf("akc-06"), "Eksisterende By", "akc-07b: city left untouched");
      assertEq(
        aboutOf("akc-06"),
        "Vi produserer ekte gårdshonning fra egne bikuber.",
        "akc-07c: about STILL written in the SAME call — city's rejection does not block a sibling field",
      );
      assertTrue((r.body?.columns_updated ?? []).includes("about"), "akc-07d: 'about' present in columns_updated");
      assertTrue(!(r.body?.columns_updated ?? []).includes("city"), "akc-07e: 'city' absent from columns_updated");
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
  runAdminKnowledgeCityWriteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
