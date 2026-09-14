/**
 * admin-cross-vertical-contact-lookup.test.ts — tests for the read-only
 * cross-vertical contact lookup (GET /admin/cross-vertical-contact-lookup),
 * added per dev-requests/2026-09-13-fjern-svar-kobles-ikke-paa-tvers-av-vertikaler.md.
 *
 * Mirrors admin-db-backup.test.ts's / admin-db-table-sizes.test.ts's
 * conventions:
 *   - rfb: in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema) — same singleton
 *     services/cross-vertical-contact-lookup.ts's `getDb()` import reads.
 *   - dental / experiences: real (non-`:memory:`) scratch-path DBs opened
 *     via db-factory.ts's own getDb('dental') / getDb('experiences') +
 *     __resetDbFactoryForTesting() seam, with DENTAL_DB_PATH /
 *     EXPERIENCES_DB_PATH pointed at a scratch temp directory BEFORE seeding
 *     — same seam admin-db-backup.test.ts uses for 'experiences' — so
 *     neither test ever touches real repo data.
 *   - the router is exercised directly (no HTTP server / supertest): build a
 *     minimal req/res pair and call `router.handle(req, res, next)`.
 *   - the previous rfb db handle is saved/restored so this test never leaves
 *     the module-level singleton swapped for later blocks.
 *   - exported runAdminCrossVerticalContactLookupTests({log}) -> TestSummary;
 *     wired into tests/test.ts. Standalone:
 *     npx tsx src/routes/admin-cross-vertical-contact-lookup.test.ts
 *
 * Covers:
 *   (a) email present on rfb AND dental, exclude_vertical=experiences ->
 *       hits contains exactly 2 entries (rfb + dental) with correct id/name,
 *       hit_count:2
 *   (b) case-insensitivity: rfb row seeded with mixed-case email, queried
 *       all-lowercase -> still matches
 *   (c) excluding the ONLY vertical that has the email (experiences) ->
 *       hits:[], hit_count:0 — proves exclusion actually suppresses a
 *       same-vertical match, not just labels it
 *   (d) missing `email` -> 400
 *   (e) missing/invalid `exclude_vertical` -> 400
 *   (f) no X-Admin-Key / wrong key -> 403
 *   (g) a genuinely unmatched email -> 200, hits:[], hit_count:0
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import * as initMod from "../database/init";
import * as dbFactory from "../database/db-factory";

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
  opts: { url?: string; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const rawUrl = opts.url || "/cross-vertical-contact-lookup";
    // No query-parser middleware in this bare router.handle() harness —
    // parse the querystring by hand, same convention as
    // admin-db-backup.test.ts's callRoute().
    const query: Record<string, string> = {};
    const queryIdx = rawUrl.indexOf("?");
    if (queryIdx !== -1) {
      for (const pair of rawUrl.slice(queryIdx + 1).split("&")) {
        if (!pair) continue;
        const [k, v] = pair.split("=");
        query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
    const req: any = {
      method: "GET",
      url: rawUrl,
      query,
      headers: opts.headers || {},
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runAdminCrossVerticalContactLookupTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-cross-vertical-contact-lookup-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const scratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "admin-cross-vertical-contact-lookup-test-"),
    );
    const scratchDentalDbPath = path.join(scratchRoot, "dental.db");
    const scratchExperiencesDbPath = path.join(scratchRoot, "experiences.db");
    const prevDentalDbPathEnv = process.env.DENTAL_DB_PATH;
    const prevExperiencesDbPathEnv = process.env.EXPERIENCES_DB_PATH;
    process.env.DENTAL_DB_PATH = scratchDentalDbPath;
    process.env.EXPERIENCES_DB_PATH = scratchExperiencesDbPath;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const experiencesDb = dbFactory.getDb("experiences");

      // ── Fixtures ────────────────────────────────────────────────
      // rfb: Producer@Example.com (mixed case, on purpose — see (b))
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.com', 'producer', ?)`,
      );
      insertAgent.run("rfb-agent-1", "RFB Gård", "Producer@Example.com", "key-rfb-1");

      // dental: same email, lowercase already
      dentalDb
        .prepare(`INSERT INTO dental_agents (id, navn, epost) VALUES (?, ?, ?)`)
        .run("dental-agent-1", "Dental Klinikk", "producer@example.com");

      // experiences: a DIFFERENT email, used for the "only vertical" case (c)
      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn, epost) VALUES (?, ?, ?)`)
        .run("exp-provider-1", "Opplevelse AS", "kun-experiences@example.com");

      // Fresh require of the route module so it picks up a clean module
      // state (mirrors admin-db-backup.test.ts's require.cache seam).
      delete require.cache[require.resolve("./admin-cross-vertical-contact-lookup")];
      const routeMod = require("./admin-cross-vertical-contact-lookup");
      const router = routeMod.default;

      // ── (a) email on rfb AND dental, exclude_vertical=experiences ────
      const both = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=producer%40example.com&exclude_vertical=experiences",
        headers: { "x-admin-key": testKey },
      });
      assertEq(both.status, 200, "(a) rfb+dental match: status 200");
      assertEq(both.body?.hit_count, 2, "(a) rfb+dental match: hit_count 2");
      assertTrue(Array.isArray(both.body?.hits) && both.body.hits.length === 2, "(a) hits array has 2 entries");
      const byVertical: Record<string, any> = {};
      for (const h of both.body?.hits || []) byVertical[h.vertical] = h;
      assertTrue(!!byVertical.rfb, "(a) hits include vertical:rfb");
      assertTrue(!!byVertical.dental, "(a) hits include vertical:dental");
      assertTrue(!byVertical.experiences, "(a) hits do NOT include the excluded vertical:experiences");
      assertEq(byVertical.rfb?.id, "rfb-agent-1", "(a) rfb hit has correct id");
      assertEq(byVertical.rfb?.name, "RFB Gård", "(a) rfb hit has correct name");
      assertEq(byVertical.dental?.id, "dental-agent-1", "(a) dental hit has correct id");
      assertEq(byVertical.dental?.name, "Dental Klinikk", "(a) dental hit has correct name");

      // ── (b) case-insensitivity already exercised by (a) via the
      // mixed-case rfb fixture matched with an all-lowercase query param —
      // restate explicitly with a fresh all-lowercase query to be sure.
      const caseInsensitive = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=PRODUCER@EXAMPLE.COM&exclude_vertical=experiences",
        headers: { "x-admin-key": testKey },
      });
      assertEq(caseInsensitive.status, 200, "(b) uppercase query email: status 200");
      assertEq(caseInsensitive.body?.hit_count, 2, "(b) uppercase query email: still matches both (hit_count 2)");

      // ── (c) excluding the ONLY vertical that has the email ────────
      const onlyExperiences = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=kun-experiences%40example.com&exclude_vertical=experiences",
        headers: { "x-admin-key": testKey },
      });
      assertEq(onlyExperiences.status, 200, "(c) exclude-only-vertical: status 200");
      assertEq(onlyExperiences.body?.hit_count, 0, "(c) exclude-only-vertical: hit_count 0 (exclusion actually suppresses the match)");
      assertEq(onlyExperiences.body?.hits, [], "(c) exclude-only-vertical: hits []");

      // ── (d) missing email -> 400 ───────────────────────────────────
      const noEmail = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?exclude_vertical=rfb",
        headers: { "x-admin-key": testKey },
      });
      assertEq(noEmail.status, 400, "(d) missing email: status 400");

      // ── (e) missing/invalid exclude_vertical -> 400 ────────────────
      const missingVertical = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=x%40example.com",
        headers: { "x-admin-key": testKey },
      });
      assertEq(missingVertical.status, 400, "(e) missing exclude_vertical: status 400");

      const bogusVertical = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=x%40example.com&exclude_vertical=bogus",
        headers: { "x-admin-key": testKey },
      });
      assertEq(bogusVertical.status, 400, "(e) invalid exclude_vertical=bogus: status 400");

      // ── (f) no X-Admin-Key / wrong key -> 403 ──────────────────────
      const noKey = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=producer%40example.com&exclude_vertical=experiences",
      });
      assertEq(noKey.status, 403, "(f) no X-Admin-Key: status 403");

      const wrongKey = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=producer%40example.com&exclude_vertical=experiences",
        headers: { "x-admin-key": "wrong-key" },
      });
      assertEq(wrongKey.status, 403, "(f) wrong X-Admin-Key: status 403");

      // ── (g) genuinely unmatched email -> 200, hits:[] ──────────────
      const unmatched = await callRoute(router, {
        url: "/cross-vertical-contact-lookup?email=nobody-anywhere%40example.com&exclude_vertical=rfb",
        headers: { "x-admin-key": testKey },
      });
      assertEq(unmatched.status, 200, "(g) unmatched email: status 200 (not an error)");
      assertEq(unmatched.body?.hit_count, 0, "(g) unmatched email: hit_count 0");
      assertEq(unmatched.body?.hits, [], "(g) unmatched email: hits []");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevDentalDbPathEnv === undefined) delete process.env.DENTAL_DB_PATH;
      else process.env.DENTAL_DB_PATH = prevDentalDbPathEnv;
      if (prevExperiencesDbPathEnv === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPathEnv;
      try {
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup — never fail the suite over teardown
      }
      db.close();
      try {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        // best-effort scratch-dir cleanup; never fail the test suite over it
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-cross-vertical-contact-lookup.test.ts`
if (require.main === module) {
  runAdminCrossVerticalContactLookupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
