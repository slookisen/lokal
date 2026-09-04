/**
 * admin-outreach-pool-rich-vs-partial.test.ts — dev-request
 * 2026-09-02-rfb-pool-view-rich-vs-partial (slookisen/A2A, Daniel option A,
 * confirmed live 2026-09-02: "go på A, og kjør dublettene og skjul-lista",
 * daniel-responses/2026-09-02-go-a-dubletter-og-skjul-lista.md).
 *
 * Supersedes the narrower pin in admin-outreach-gate-tynne-profiler.test.ts
 * (dev-request 2026-07-30-outreach-gate-tynne-profiler), which tightened
 * `outreach_ready_pool` to `enrichment_status = 'rich'` only. That file is
 * left as-is (its own fixtures happen to still hold under the new rule — see
 * below) rather than rewritten; this file is the new source of truth for the
 * 2026-09-02 behaviour.
 *
 * Three call sites now share ONE content-depth predicate — about>=80 chars OR
 * products array length>=3 (POOL_CONTENT_THRESHOLD_SQL, src/database/init.ts;
 * mirrors computeKvalitetsGate's own `content_threshold`,
 * src/agents/lokal-agent-verifier.ts):
 *
 * 1. `outreach_ready_pool` VIEW (src/database/init.ts): now
 *    `enrichment_status IN ('rich','partial') AND POOL_CONTENT_THRESHOLD_SQL`
 *    (was `= 'rich'` only). Tests 1-2 below are the VIEW-level acceptance
 *    criteria: a 'partial' row whose about clears 80 chars now appears; a
 *    'partial' row that fails the content threshold (short about, <3
 *    products) still does not.
 * 2. `funnelBase` in GET /admin/outreach-ready-pool/stats
 *    (src/routes/admin-outreach-pool.ts): now ANDs in the same
 *    POOL_CONTENT_THRESHOLD_SQL (imported from database/init.ts) so
 *    `pool_funnel.verified_and_rich_or_partial` and `pool_size` (the VIEW's
 *    own COUNT(*)) never disagree. Test 3.
 * 3. `nowInPool` in runVerifierBatch (src/agents/lokal-agent-verifier.ts):
 *    now also requires `gate.reasons.content_threshold` (reused verbatim from
 *    the same computeKvalitetsGate call already made for this agent this
 *    run) before stamping outreach_eligible_at / counting pool_added — same
 *    fixture style as the existing lokal-agent-verifier-stegb-email-website-
 *    gate.test.ts integration fixtures (seed via runVerifierBatch, assert on
 *    outreach_ready_pool membership / outreach_eligible_at). Test 4.
 *
 * SCOPE NOTE: GET /admin/outreach-candidates (admin-outreach-candidates.ts)
 * reads this same VIEW but then re-runs its OWN independent
 * coreEligibilityCheck(), which still hard-codes enrichment_status==='rich'
 * (dev-request 2026-07-30-outreach-gate-tynne-profiler) and was NOT named in
 * this dev-request's scope (only the outreach_ready_pool VIEW, funnelBase and
 * nowInPool were). That route's own JS-level gate is therefore now STRICTER
 * than the VIEW it reads from and will silently re-exclude the 'partial' rows
 * this change surfaces in the VIEW — i.e. the real outreach-candidate export
 * endpoint will not actually pick up the newly-eligible rows yet. This is a
 * real, load-bearing inconsistency (see admin-outreach-candidates.ts's
 * coreEligibilityCheck + its existing pin in admin-outreach-candidates-gate-
 * integrity.test.ts), deliberately left untouched here — out of the scope
 * this dev-request authorized — and flagged in the implementation report
 * instead of silently fixed.
 *
 * Exported runAdminOutreachPoolRichVsPartialTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-outreach-pool-rich-vs-partial.test.ts
 */

import Database from "better-sqlite3";
import { getDb, __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = {
    method: opts.method || "GET",
    url: opts.url || "/",
    query: opts.query || {},
    headers: opts.headers || {},
  };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { result = { status: this.statusCode, body: payload }; return this; },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminOutreachPoolRichVsPartialTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDb = getDb();
    const testKey = process.env.ADMIN_KEY || "outreach-pool-rich-vs-partial-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);

    function insertAgent(id: string, name: string, email: string): void {
      db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
        VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
      `).run(id, name, email, `key-${id}`);
    }

    function insertKnowledge(
      id: string,
      email: string,
      enrichmentStatus: string,
      opts2: { about?: string; products?: unknown[] } = {},
    ): void {
      db.prepare(`
        INSERT INTO agent_knowledge
          (agent_id, email, field_provenance, verification_status, enrichment_status,
           url_last_status, url_last_probed, about, products)
        VALUES (?, ?, '{}', 'verified', ?, 200, datetime('now'), ?, ?)
      `).run(id, email, enrichmentStatus, opts2.about ?? null, JSON.stringify(opts2.products ?? []));
    }

    try {
      // ── Test 1 (Acceptance Criterion 1a): partial + about=90 chars, verified,
      // valid email, fresh 2xx URL probe, never sent -> appears in the VIEW ──
      insertAgent("rvp-partial-pass", "Delvis Men Fyldig Gård", "partial-pass@rvp-test.no");
      insertKnowledge("rvp-partial-pass", "partial-pass@rvp-test.no", "partial", {
        about: "x".repeat(90),
        products: [],
      });

      // ── Test 2 (Acceptance Criterion 1b): partial + about=40 chars + 1
      // product (fails content_threshold: 40<80 AND 1<3) -> NOT in the VIEW ──
      insertAgent("rvp-partial-thin", "Tynn Partial Gård", "partial-thin@rvp-test.no");
      insertKnowledge("rvp-partial-thin", "partial-thin@rvp-test.no", "partial", {
        about: "x".repeat(40),
        products: [{ name: "Poteter" }],
      });

      // Control: an already-passing 'rich' row, to confirm the VIEW still
      // admits rich content the same as before (no regression on the
      // pre-existing rich-only behaviour).
      insertAgent("rvp-rich-control", "Fyldig Kontroll Gård", "rich-control@rvp-test.no");
      insertKnowledge("rvp-rich-control", "rich-control@rvp-test.no", "rich", {
        about: "x".repeat(200),
        products: [{ name: "a" }, { name: "b" }, { name: "c" }],
      });

      const viewRows = db
        .prepare(`SELECT agent_id, email, enrichment_status FROM outreach_ready_pool ORDER BY email`)
        .all() as Array<{ agent_id: string; email: string; enrichment_status: string }>;
      const viewIds = viewRows.map((r) => r.agent_id);

      assertTrue(
        viewIds.includes("rvp-partial-pass"),
        "rvp-01 (AC1a): partial row with about>=80 chars now appears in outreach_ready_pool",
      );
      assertTrue(
        !viewIds.includes("rvp-partial-thin"),
        "rvp-02 (AC1b): partial row failing content_threshold (about<80, products<3) still does NOT appear",
      );
      assertTrue(
        viewIds.includes("rvp-rich-control"),
        "rvp-03 (no regression): a 'rich' row still appears in outreach_ready_pool",
      );

      // ── Test 3 (funnelBase / stats endpoint) ────────────────────────────
      // Reuses the SAME db/fixtures from Test 1/2 (rvp-partial-pass passes
      // content_threshold, rvp-partial-thin fails it, rvp-rich-control is
      // 'rich') — confirms funnelBase's verified_and_rich_or_partial count
      // now matches pool_size exactly (both gated by the identical
      // POOL_CONTENT_THRESHOLD_SQL fragment: 2 of the 3 fixtures pass — only
      // rvp-partial-thin is excluded). Pre-fix, funnelBase would have
      // over-counted by 1 (it would have included rvp-partial-thin, which
      // fails content threshold and is not actually in the pool).
      delete require.cache[require.resolve("./admin-outreach-pool")];
      const statsRouteMod = require("./admin-outreach-pool");
      const statsRouter = statsRouteMod.default;

      const statsRes = callRouteSync(statsRouter, {
        url: "/stats",
        headers: { "x-admin-key": testKey },
      });
      assertEq(statsRes.status, 200, "rvp-04: GET /admin/outreach-ready-pool/stats -> 200");
      // Fixture from Test 1/2: rvp-partial-pass + rvp-rich-control pass;
      // rvp-partial-thin fails content_threshold.
      assertEq(
        statsRes.body?.pool_funnel?.verified_and_rich_or_partial,
        2,
        "rvp-05: funnelBase counts only the 2 content-threshold-passing rows (partial-pass + rich-control), not the thin partial row",
      );
      assertEq(
        statsRes.body?.pool_size,
        viewRows.length,
        "rvp-06: pool_funnel.verified_and_rich_or_partial's cohort and pool_size (raw VIEW COUNT(*)) agree — both content-threshold-gated identically",
      );

      // ── Test 4 (nowInPool / verifier) ───────────────────────────────────
      // Fresh in-memory DB with the FULL schema, run through runVerifierBatch
      // (integration style, matching lokal-agent-verifier-stegb-email-
      // website-gate.test.ts's own convention — this specific function has no
      // pre-existing direct/pure-function unit test to extend).
      const prevFetch = (globalThis as any).fetch;
      const verifierDb = new Database(":memory:");
      __setDbForTesting(verifierDb as any);
      __initSchemaForTesting(verifierDb as any);
      try {
        // PR-21 link-freshness probe (probeAgentUrl) calls the real global
        // fetch with no override hook — stub it so the fake *.no test domains
        // resolve as reachable, same convention as the stegb-email-website-
        // gate test file.
        (globalThis as any).fetch = async () => ({ status: 200 });

        const { runVerifierBatch } = require("../agents/lokal-agent-verifier") as
          typeof import("../agents/lokal-agent-verifier");

        const RICH_ADDRESS = "Testveien 1, 1400 Ski";
        const insertVAgent = verifierDb.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test producer', 'test', '', ?, 'producer', ?)`,
        );
        const insertVKnowledge = verifierDb.prepare(
          `INSERT INTO agent_knowledge
             (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
           VALUES (?, ?, '91234567', ?, ?, ?, ?, ?, 'pending_verify')`,
        );

        function seedVerifierAgent(seed: {
          id: string;
          domain: string;
          about: string;
          products: string;
        }): void {
          const url = `https://${seed.domain}`;
          const email = `post@${seed.domain}`;
          insertVAgent.run(seed.id, seed.id, url, `key-${seed.id}`);
          insertVKnowledge.run(
            seed.id,
            RICH_ADDRESS,
            url,
            email,
            seed.about,
            seed.products,
            JSON.stringify({
              address: [
                { value: RICH_ADDRESS, source_type: "homepage", fetched_at: "2026-08-01T07:00:00Z" },
                { value: RICH_ADDRESS, source_type: "google_places", fetched_at: "2026-08-01T07:05:00Z" },
              ],
            }),
          );
        }

        // Passes content_threshold (about=90>=80, 0 products) — should reach
        // 'verified' + 'partial' and get nowInPool=true (outreach_eligible_at
        // stamped, pool_added counted).
        seedVerifierAgent({
          id: "rvp-verifier-partial-pass",
          domain: "rvp-verifier-pass.no",
          about: "x".repeat(90),
          products: "[]",
        });

        const mockHeadProbe200 = async (_url: string) => 200 as number | null;
        const result = await runVerifierBatch({
          db: verifierDb,
          batchSize: 50,
          brregLookup: null,
          headProbe: mockHeadProbe200,
        });

        const vr = result.results.find((r) => r.agent_id === "rvp-verifier-partial-pass");
        assertTrue(!!vr, "rvp-07: precondition — result found for rvp-verifier-partial-pass");
        assertEq(vr?.new_verification_status, "verified",
          "rvp-08: address (2 agreeing sources) + valid email + live website -> verified");
        assertEq(vr?.new_enrichment_status, "partial",
          "rvp-09: about=90<150 and 0 products -> 'partial', not 'rich'");
        assertTrue(vr?.outreach_eligible_at !== null,
          "rvp-10: nowInPool=true — outreach_eligible_at stamped for a content-threshold-passing partial agent (matches VIEW/funnelBase)");
        const poolRow = verifierDb
          .prepare("SELECT 1 FROM outreach_ready_pool WHERE agent_id = ?")
          .get("rvp-verifier-partial-pass");
        assertTrue(!!poolRow,
          "rvp-11: the same agent is independently present in outreach_ready_pool (VIEW and verifier agree)");
      } finally {
        (globalThis as any).fetch = prevFetch;
      }
    } catch (err) {
      failed++;
      failures.push(`admin-outreach-pool-rich-vs-partial: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      __setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}
