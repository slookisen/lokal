/**
 * admin-homepage-provenance-cohort.test.ts — tests for
 * dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, Skive 3 follow-up:
 * GET /admin/homepage-provenance-cohort, the READ-ONLY, paginated listing of
 * the agent IDs POST /admin/homepage-provenance-batch's default auto-select
 * would pick — using the identical predicate.
 *
 * Covers (src/routes/admin-homepage-provenance-cohort.ts):
 *   (a) 403 without X-Admin-Key.
 *   (b) a row matching the default auto-select predicate (pending_verify +
 *       website set + about set + field_provenance empty) is returned.
 *   (c) a row that fails EACH individual predicate leg is excluded: wrong
 *       verification_status, no homepage, empty about, field_provenance
 *       already has "homepage", parked (homepage_unreachable_since fresh),
 *       no-yield/wrong-entity backoff (streak >= 3 + recent attempt).
 *   (d) an OLD parked/backoff row (past the 30d/14d windows) is NOT excluded
 *       — the exclusion expires, mirroring the batch endpoint exactly.
 *   (e) `total` counts the full matching set regardless of limit/offset —
 *       pagination (limit=1/offset=1) walks the same two-row cohort without
 *       omission or duplication.
 *   (f) default limit/offset when omitted; limit is capped at
 *       COHORT_MAX_LIMIT even if a caller asks for more.
 *   (g) a matching row whose resolved homepage is whitespace-only is excluded
 *       from `agentIds`/`returned` (same as the batch endpoint's own
 *       post-query filter) — and `total` still reflects the pre-filter query
 *       (a documented, expected divergence, not a bug — matches the batch
 *       endpoint's own targetIds-vs-SQL-count relationship).
 *   (h) read-only: the endpoint performs no writes (row byte-identical
 *       before/after).
 *   (i) ORDER BY parity with POST /admin/homepage-provenance-batch's default
 *       auto-select: reachable (2xx/3xx url_last_status) rows before
 *       unreachable, then never-attempted (NULL last_enrichment_attempt_at)
 *       before attempted, then oldest-attempt-first — same three rows in the
 *       same order from both endpoints.
 *
 * Standalone: npx tsx src/routes/admin-homepage-provenance-cohort.test.ts
 * (not wired into tests/test.ts — same file-scoping convention as
 * admin-pool-blocker-explain.test.ts / admin-rfb-website-discovery.test.ts.)
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

export async function runAdminHomepageProvenanceCohortTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevParkingDisabled = process.env.HOMEPAGE_PARKING_DISABLED;
  const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "hpc-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.HOMEPAGE_PARKING_DISABLED;
    delete process.env.NO_YIELD_BACKOFF_DAYS;

    const routePath = require.resolve("../routes/admin-homepage-provenance-cohort");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-homepage-provenance-cohort") as
      typeof import("../routes/admin-homepage-provenance-cohort");
    const routerModule = routeModule.default;

    const layer = (routerModule as any).stack.find(
      (l: any) => l.route && l.route.path === "/" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET / handler registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callCohort(
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
      website?: string | null;
      aUrl?: string | null;
      verificationStatus?: string;
      about?: string | null;
      fieldProvenance?: string | null;
      urlLastStatus?: number | null;
      homepageUnreachableSince?: string | null;
      noYieldStreak?: number;
      wrongEntityStreak?: number;
      lastEnrichmentAttemptAt?: string | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at, is_active)
         VALUES (?, ?, 't', 't', 'x@example.com', ?, 'producer', ?, 'rfb', '2026-01-01 00:00:00', 1)`,
      ).run(o.id, o.name, o.aUrl ?? "", `key-${o.id}`);
      testDb.prepare(
        `INSERT INTO agent_knowledge (
           agent_id, website, verification_status, enrichment_status, email, about,
           field_provenance, url_last_status, url_last_probed, homepage_unreachable_since,
           no_yield_streak, wrong_entity_streak, last_enrichment_attempt_at, updated_at
         ) VALUES (?, ?, ?, 'partial', 'x@example.com', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website ?? null,
        o.verificationStatus ?? "pending_verify",
        o.about ?? "Om oss tekst",
        o.fieldProvenance ?? "{}",
        o.urlLastStatus ?? null,
        o.homepageUnreachableSince ?? null,
        o.noYieldStreak ?? 0, o.wrongEntityStreak ?? 0,
        o.lastEnrichmentAttemptAt ?? null,
        new Date().toISOString(),
      );
    }

    const daysAgoIso = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

    // ── (a) auth ──
    {
      const r = await callCohort({}, {});
      assertEq(r.status, 403, "a1: 403 without X-Admin-Key");
    }

    // ── (b) baseline eligible row ──
    insertAgent({ id: "elig-1", name: "Elig Ett", website: "https://elig1.no" });
    {
      const r = await callCohort();
      assertEq(r.status, 200, "b1: 200");
      assertTrue(r.body.agentIds.includes("elig-1"), "b2: eligible row is returned");
      assertEq(r.body.total, 1, "b3: total counts the eligible row");
      assertEq(r.body.returned, 1, "b4: returned matches agentIds length");
    }

    // ── (c) each individual exclusion leg ──
    insertAgent({ id: "excl-status", name: "Feil status", website: "https://x.no", verificationStatus: "verified" });
    insertAgent({ id: "excl-nohome", name: "Ingen nettsted", website: null, aUrl: null });
    insertAgent({ id: "excl-noabout", name: "Tomt about", website: "https://x.no", about: "" });
    insertAgent({ id: "excl-hasprov", name: "Har homepage-provenance", website: "https://x.no", fieldProvenance: '{"about":[{"source_type":"homepage"}]}' });
    insertAgent({ id: "excl-parked", name: "Parkert nylig", website: "https://x.no", homepageUnreachableSince: daysAgoIso(5) });
    insertAgent({ id: "excl-backoff", name: "No-yield backoff", website: "https://x.no", noYieldStreak: 3, lastEnrichmentAttemptAt: daysAgoIso(1) });
    {
      const r = await callCohort({ limit: "50" });
      assertTrue(!r.body.agentIds.includes("excl-status"), "c1: wrong verification_status excluded");
      assertTrue(!r.body.agentIds.includes("excl-nohome"), "c2: no homepage excluded");
      assertTrue(!r.body.agentIds.includes("excl-noabout"), "c3: empty about excluded");
      assertTrue(!r.body.agentIds.includes("excl-hasprov"), "c4: existing homepage provenance excluded");
      assertTrue(!r.body.agentIds.includes("excl-parked"), "c5: freshly parked excluded");
      assertTrue(!r.body.agentIds.includes("excl-backoff"), "c6: no-yield backoff excluded");
    }

    // ── (d) expired parking/backoff is NOT excluded ──
    insertAgent({ id: "expired-parked", name: "Parkert gammel", website: "https://y.no", homepageUnreachableSince: daysAgoIso(31) });
    insertAgent({ id: "expired-backoff", name: "Backoff gammel", website: "https://y.no", noYieldStreak: 3, lastEnrichmentAttemptAt: daysAgoIso(15) });
    {
      const r = await callCohort({ limit: "50" });
      assertTrue(r.body.agentIds.includes("expired-parked"), "d1: expired parking is re-selectable");
      assertTrue(r.body.agentIds.includes("expired-backoff"), "d2: expired backoff is re-selectable");
    }

    // ── (e) pagination walks the cohort without omission/duplication ──
    {
      const full = await callCohort({ limit: "50" });
      const totalEligible = full.body.total;
      const seen: string[] = [];
      let offset = 0;
      for (let i = 0; i < totalEligible + 2; i++) {
        const page = await callCohort({ limit: "1", offset: String(offset) });
        if (page.body.agentIds.length === 0) break;
        seen.push(...page.body.agentIds);
        offset += 1;
      }
      assertEq(seen.length, totalEligible, "e1: paginated walk visits exactly `total` rows");
      assertEq(new Set(seen).size, seen.length, "e2: no duplicates across pages");
      assertTrue(
        seen.every((id) => full.body.agentIds.includes(id)),
        "e3: every paginated id is a subset of the single-page result",
      );
    }

    // ── (f) default limit/offset + cap ──
    {
      const r1 = await callCohort();
      assertEq(r1.body.limit, 100, "f1: default limit is 100");
      assertEq(r1.body.offset, 0, "f2: default offset is 0");
      const r2 = await callCohort({ limit: "5000" });
      assertEq(r2.body.limit, 1000, "f3: limit capped at COHORT_MAX_LIMIT (1000)");
    }

    // ── (g) whitespace-only resolved homepage excluded from agentIds, not from total ──
    insertAgent({ id: "ws-homepage", name: "Whitespace homepage", website: "   ", aUrl: "   " });
    {
      const r = await callCohort({ limit: "50" });
      assertTrue(!r.body.agentIds.includes("ws-homepage"), "g1: whitespace-only homepage excluded from agentIds");
    }

    // ── (h) read-only ──
    {
      const before = testDb.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'elig-1'`).get();
      await callCohort({ limit: "50" });
      const after = testDb.prepare(`SELECT * FROM agent_knowledge WHERE agent_id = 'elig-1'`).get();
      assertEq(after, before, "h1: no write side-effect on the queried row");
    }

    // ── (i) ORDER BY parity: reachable-first, then never-attempted-first, then oldest-attempt ──
    testDb.exec(`DELETE FROM agent_knowledge; DELETE FROM agents;`);
    insertAgent({ id: "ord-unreachable", name: "Unreachable", website: "https://z.no", urlLastStatus: 500, lastEnrichmentAttemptAt: daysAgoIso(1) });
    insertAgent({ id: "ord-reachable-old", name: "Reachable old attempt", website: "https://z.no", urlLastStatus: 200, lastEnrichmentAttemptAt: daysAgoIso(10) });
    insertAgent({ id: "ord-reachable-never", name: "Reachable never attempted", website: "https://z.no", urlLastStatus: 200, lastEnrichmentAttemptAt: null });
    {
      const r = await callCohort({ limit: "50" });
      assertEq(
        r.body.agentIds,
        ["ord-reachable-never", "ord-reachable-old", "ord-unreachable"],
        "i1: reachable-never-attempted, reachable-old-attempt, unreachable — in that order",
      );
    }
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevParkingDisabled === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED; else process.env.HOMEPAGE_PARKING_DISABLED = prevParkingDisabled;
    if (prevNoYieldBackoffDays === undefined) delete process.env.NO_YIELD_BACKOFF_DAYS; else process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
    if (prevDb) __setDbForTesting(prevDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminHomepageProvenanceCohortTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      console.log("\nFailures:");
      summary.failures.forEach((f) => console.log(`  ${f}`));
      process.exit(1);
    }
  });
}
