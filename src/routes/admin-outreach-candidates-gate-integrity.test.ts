/**
 * admin-outreach-candidates-gate-integrity.test.ts — regression pins for the
 * 2026-07-15 gate-integrity fixes to GET /admin/outreach-candidates (dev-request
 * gate-integrity-unverified-agent-bypass, slookisen/A2A).
 *
 * Incident: the outreach suppression gate sent a marketing email to the wrong
 * entity (norskott@online.no, attached to agent "Dalheim Gårdsysteri" but
 * actually belonging to a different person). Investigation found two concrete,
 * mechanical bugs in this file:
 *
 * Fix 1 — dedupe tiebreak-field parity bug: the `candidates` array this route
 * built only ever carried {agent_id, name, email} into dedupeByEmail(), never
 * views_count/google_rating/google_review_count. Since those tiebreak fields
 * evaluate to 0/0/0 for every row, dedupeByEmail() silently fell through to its
 * THIRD tiebreak — alphabetical name — instead of the intended engagement/rating
 * ranking that /admin/outreach-ready-pool (the reference implementation) uses.
 * Two endpoints picking a DIFFERENT winner for the SAME email collision is a
 * genuine gate-integrity divergence. Tests 1-2 below prove the fix.
 *
 * Fix 2 — defense-in-depth re-verification: right before responding, the route
 * now re-runs ONE fresh, independent query re-checking the SAME core eligibility
 * conditions the pool enforces (verification_status/enrichment_status/email
 * present/non-umbrella) for the exact agent_ids about to be returned, dropping
 * (never adding) any candidate that fails, logging a `P0-ALERT: gate-integrity`
 * line, and reporting a `gate_integrity_violations` count in the response. Since
 * racing a live DB update mid-request isn't practical in a synchronous test,
 * test 3 unit-tests the extracted pure `coreEligibilityCheck()` function
 * directly, matching the style of `websiteOwnershipUnverified` /
 * `hasInferenceOnlyFactualField` already in this file.
 *
 * Mirrors admin-outreach-candidates-mode2-ordering.test.ts: synchronous route
 * exercise, real init.ts schema, wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

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
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const req: any = { method: "GET", url: "/", query: opts.query || {}, headers: opts.headers || {} };
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

export function runAdminOutreachCandidatesGateIntegrityTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-outreach-candidates-gate-integrity-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  function insertVerifiedPoolAgent(
    id: string,
    name: string,
    email: string,
    opts2: { googleRating?: number; googleReviewCount?: number } = {},
  ): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, name, email, `key-${id}`);
    // dev-request 2026-09-02-rfb-pool-view-rich-vs-partial: outreach_ready_pool
    // now ALSO requires POOL_CONTENT_THRESHOLD_SQL (about>=80 chars OR
    // products>=3) against the raw columns, not just enrichment_status='rich'
    // — an explicit about text keeps this synthetic fixture pool-eligible
    // (this test is about dedupe/gate-integrity, not content depth).
    db.prepare(`
      INSERT INTO agent_knowledge
        (agent_id, email, about, field_provenance, verification_status, enrichment_status,
         url_last_status, url_last_probed, google_rating, google_review_count)
      VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'), ?, ?)
    `).run(id, email, "x".repeat(200), opts2.googleRating ?? null, opts2.googleReviewCount ?? null);
  }

  // Record N profile-view rows for an agent (analytics_agent_views is what
  // admin-outreach-pool.ts's views_count subquery counts).
  function insertViews(agentId: string, agentName: string, count: number): void {
    const stmt = db.prepare(`
      INSERT INTO analytics_agent_views (agent_id, agent_name, view_source)
      VALUES (?, ?, 'direct')
    `);
    for (let i = 0; i < count; i++) stmt.run(agentId, agentName);
  }

  try {
    // ── Test 1 + 2: Fix 1 — dedupe tiebreak-field parity ──────────────────────
    //
    // Two verified pool agents share ONE email. "Aaa Alphabetically First" would
    // win under the OLD bug (views_count/rating silently 0/0 for both → falls
    // through to name-asc tiebreak). "Zzz Higher Engagement" has real, higher
    // views_count and must win under the FIXED behavior — proving parity with
    // outreach-ready-pool's real engagement-based tiebreak.
    insertVerifiedPoolAgent("gi-A", "Aaa Alphabetically First", "shared@prod-test.no");
    insertVerifiedPoolAgent("gi-Z", "Zzz Higher Engagement", "shared@prod-test.no");
    insertViews("gi-Z", "Zzz Higher Engagement", 25);
    insertViews("gi-A", "Aaa Alphabetically First", 2);

    // A normal, uncontested single-agent-per-email producer (regression pin for
    // the common case — must still come back untouched).
    insertVerifiedPoolAgent("gi-solo", "Solo Producer", "solo@prod-test.no");

    const candidatesRouter = require("./admin-outreach-candidates").default;
    const poolRouter = require("./admin-outreach-pool").default;

    const resCandidates = callRouteSync(candidatesRouter, {
      query: { mode: "first" },
      headers: { "x-admin-key": testKey },
    });
    assertEq(resCandidates.status, 200, "gate-integrity: GET mode=first → 200");

    const candList = (resCandidates.body?.candidates || []) as Array<{ agent_id: string; email: string }>;
    const sharedEmailWinner = candList.find((c) => c.email.toLowerCase() === "shared@prod-test.no");
    assertEq(
      sharedEmailWinner?.agent_id,
      "gi-Z",
      "gate-integrity Fix 1: higher-views agent wins the email collision (NOT alphabetical-first)",
    );
    assertEq(
      resCandidates.body?.dedupe_email_collision_groups >= 1,
      true,
      "gate-integrity Fix 1: dedupe_email_collision_groups reflects the shared@ collision",
    );
    // Response shape must stay {agent_id, name, email} only — no leaked
    // views_count/rating fields.
    assertEq(
      sharedEmailWinner ? Object.keys(sharedEmailWinner).sort() : null,
      ["agent_id", "email", "name"],
      "gate-integrity Fix 1: candidate response shape stays {agent_id, name, email} only",
    );

    // Parity check: /admin/outreach-ready-pool must pick the SAME winner for the
    // same email collision — proving the two endpoints are no longer divergent.
    const resPool = callRouteSync(poolRouter, { headers: { "x-admin-key": testKey } });
    assertEq(resPool.status, 200, "gate-integrity: GET outreach-ready-pool → 200");
    const poolAgents = (resPool.body?.agents || []) as Array<{ agent_id: string; email: string }>;
    const poolSharedWinner = poolAgents.find((a) => (a.email || "").toLowerCase() === "shared@prod-test.no");
    assertEq(
      poolSharedWinner?.agent_id,
      sharedEmailWinner?.agent_id,
      "gate-integrity Fix 1: outreach-candidates and outreach-ready-pool pick the SAME winner for the same email",
    );

    // Test 2 — regression pin: normal single-agent-per-email case unaffected.
    const soloCandidate = candList.find((c) => c.email.toLowerCase() === "solo@prod-test.no");
    assertEq(soloCandidate?.agent_id, "gi-solo", "gate-integrity: single-agent-per-email case still works unchanged");

    // gate_integrity_violations must be present and 0 in the normal case (Fix 2
    // response-shape contract; the actual violation-detection path is unit-
    // tested directly below since it can't be race-triggered synchronously).
    assertEq(
      resCandidates.body?.gate_integrity_violations,
      0,
      "gate-integrity Fix 2: gate_integrity_violations is 0 in the normal/expected case",
    );
  } catch (err) {
    failed++;
    failures.push(`gate-integrity: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  // ── Test 3: Fix 2 — coreEligibilityCheck() pure-function unit tests ─────────
  try {
    const { coreEligibilityCheck } = require("./admin-outreach-candidates") as
      typeof import("./admin-outreach-candidates");

    const failVerification = coreEligibilityCheck({
      verification_status: "pending_verify",
      enrichment_status: "rich",
      email: "x@example.no",
      umbrella_type: null,
    });
    assertEq(failVerification.ok, false, "coreEligibilityCheck: fails when verification_status != 'verified'");
    assertEq(
      failVerification.failedCondition,
      "verification_status_not_verified",
      "coreEligibilityCheck: reports the correct failed condition for verification_status",
    );

    const failEnrichment = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "thin",
      email: "x@example.no",
      umbrella_type: null,
    });
    assertEq(failEnrichment.ok, false, "coreEligibilityCheck: fails when enrichment_status is 'thin'");
    assertEq(
      failEnrichment.failedCondition,
      "enrichment_status_not_rich",
      "coreEligibilityCheck: reports the correct failed condition for 'thin'",
    );

    // dev-request 2026-09-05-orch-pr-1-coreeligibility-partial: a 'partial' row
    // now qualifies IFF isContentQualified(row) is true (about>=80 chars OR
    // products>=3), mirroring the outreach_ready_pool VIEW's own widened gate
    // (PR #796 / dev-request 2026-09-02-rfb-pool-view-rich-vs-partial). A
    // 'partial' row with NO about/products (this fixture) fails the content
    // threshold and must be rejected — but with the NEW `content_threshold_
    // not_met` label, not the OLD `enrichment_status_not_rich` label (that
    // label is now reserved for genuinely non-rich, non-partial statuses, e.g.
    // 'thin', tested above). Mutation pin: reverting the content-threshold
    // branch back to a bare `!== "rich"` check makes this assertion fail.
    const failPartialThin = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "partial",
      email: "x@example.no",
      umbrella_type: null,
    });
    assertEq(
      failPartialThin.ok,
      false,
      "coreEligibilityCheck: fails when enrichment_status is 'partial' and content threshold is not met",
    );
    assertEq(
      failPartialThin.failedCondition,
      "content_threshold_not_met",
      "coreEligibilityCheck: reports the NEW 'content_threshold_not_met' condition for a thin 'partial' row (NOT 'enrichment_status_not_rich')",
    );

    // ── dev-request 2026-09-05-orch-pr-1-coreeligibility-partial: new tests ──
    //
    // 1. A 'partial' row with about~90 chars (clears the 80-char threshold)
    //    must PASS.
    const passPartialAbout = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "partial",
      email: "x@example.no",
      umbrella_type: null,
      about: "x".repeat(90),
      products: [],
    });
    assertEq(
      passPartialAbout.ok,
      true,
      "coreEligibilityCheck: 'partial' with about>=80 chars PASSES (content threshold met via about)",
    );
    assertEq(
      passPartialAbout.failedCondition,
      null,
      "coreEligibilityCheck: failedCondition is null for a content-threshold-qualifying 'partial' row",
    );

    // 2. A 'partial' row with 3 products (clears the products>=3 threshold,
    //    short about) must also PASS.
    const passPartialProducts = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "partial",
      email: "x@example.no",
      umbrella_type: null,
      about: "kort",
      products: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    assertEq(
      passPartialProducts.ok,
      true,
      "coreEligibilityCheck: 'partial' with products>=3 PASSES (content threshold met via products, short about)",
    );

    // 3. A 'partial' row with about~40 chars AND only 1 product (fails BOTH
    //    legs of the threshold) must FAIL with the NEW failedCondition.
    const failPartialContent = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "partial",
      email: "x@example.no",
      umbrella_type: null,
      about: "x".repeat(40),
      products: [{ name: "Poteter" }],
    });
    assertEq(
      failPartialContent.ok,
      false,
      "coreEligibilityCheck: 'partial' with about=40 chars + 1 product FAILS (neither leg of the threshold clears)",
    );
    assertEq(
      failPartialContent.failedCondition,
      "content_threshold_not_met",
      "coreEligibilityCheck: reports 'content_threshold_not_met' (NOT 'enrichment_status_not_rich') for a thin 'partial' row",
    );

    // 4. Parity: the same about/products fixtures must agree between
    //    isContentQualified() (the extracted predicate, database/init.ts) and
    //    coreEligibilityCheck() — the whole point of extracting ONE canonical
    //    predicate instead of duplicating the threshold.
    const { isContentQualified } = require("../database/init") as typeof import("../database/init");
    const parityFixtures: Array<{ about: string; products: unknown[]; label: string }> = [
      { about: "x".repeat(90), products: [], label: "about>=80, 0 products" },
      { about: "kort", products: [{ name: "a" }, { name: "b" }, { name: "c" }], label: "short about, 3 products" },
      { about: "x".repeat(40), products: [{ name: "Poteter" }], label: "about=40, 1 product" },
      { about: "", products: [], label: "empty about, 0 products" },
    ];
    for (const fx of parityFixtures) {
      const directResult = isContentQualified({ about: fx.about, products: fx.products });
      const viaCheck = coreEligibilityCheck({
        verification_status: "verified",
        enrichment_status: "partial",
        email: "x@example.no",
        umbrella_type: null,
        about: fx.about,
        products: fx.products,
      });
      assertEq(
        viaCheck.ok,
        directResult,
        `coreEligibilityCheck/isContentQualified parity (${fx.label}): both must agree on eligibility`,
      );
    }

    const failEmail = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "rich",
      email: "",
      umbrella_type: null,
    });
    assertEq(failEmail.ok, false, "coreEligibilityCheck: fails when email is empty");
    assertEq(
      failEmail.failedCondition,
      "email_missing",
      "coreEligibilityCheck: isolates the email check (row is otherwise fully eligible)",
    );

    const failUmbrella = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "rich",
      email: "x@example.no",
      umbrella_type: "chain",
    });
    assertEq(failUmbrella.ok, false, "coreEligibilityCheck: fails when umbrella_type is not null");

    const failMissingRow = coreEligibilityCheck(undefined);
    assertEq(failMissingRow.ok, false, "coreEligibilityCheck: fails when the row is missing entirely (drift/deletion)");

    const passes = coreEligibilityCheck({
      verification_status: "verified",
      enrichment_status: "rich",
      email: "x@example.no",
      umbrella_type: null,
    });
    assertEq(passes.ok, true, "coreEligibilityCheck: passes a fully-eligible row");
    assertEq(passes.failedCondition, null, "coreEligibilityCheck: failedCondition is null when it passes");
  } catch (err) {
    failed++;
    failures.push(`gate-integrity (coreEligibilityCheck): unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runAdminOutreachCandidatesGateIntegrityTests({ log: true });
  console.log(`\ngate-integrity: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
