/**
 * admin-domain-coherence.test.ts — tests POST /admin/verifier/domain-coherence-sweep
 * (dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction, item 3).
 *
 * Mirrors homepage-provenance-selector-parking.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAdminDomainCoherenceSweepTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-domain-coherence.test.ts
 *
 * Coverage (per the dev-request spec):
 *   - Coherent agent -> skipped, not in any bucket.
 *   - knowledge.website mismatch (auto-fixable) -> dry-run reports it, apply
 *     writes the corrected website, re-running dry-run afterward shows it
 *     coherent/skipped.
 *   - knowledge.email mismatch -> manual_review_needed, never written.
 *   - A genuine reciprocal circular pair -> both flagged in
 *     circular_scramble_candidates, neither auto-fixed.
 *   - Parking: after an apply run, a manual_review_needed agent gets
 *     domain_reconciliation_checked_at stamped; a second sweep within the
 *     backoff window skips it; the daily verifier's selection query
 *     (pickReviewQueueBatch) also excludes it.
 *   - DOMAIN_RECONCILIATION_PARKING_DISABLED=true removes the exclusion.
 *   - 403 without/with-wrong X-Admin-Key.
 *   - Umbrella agents excluded.
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
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
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

export function runAdminDomainCoherenceSweepTests(
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
    const testKey = "admin-domain-coherence-sweep-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevParkingDisabled = process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED;
    delete process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status, verification_review_reason)
         VALUES (?, ?, ?, 'A test farm shop', '{}', ?, ?)`,
      );

      // (1) Coherent agent — website matches agents.url. Some OTHER reason
      // (opaque JSON, doesn't matter) put it in review_required.
      insertAgent.run("agent-coherent", "Coherentgard AS", "https://coherent-gard.no", "key-coherent", null);
      insertKnowledge.run("agent-coherent", "https://coherent-gard.no", "post@coherent-gard.no", "review_required", JSON.stringify({ reason: "low_source_count" }));

      // (2) Auto-fixable: knowledge.website host != agents.url host, no email
      // anchor rescue.
      insertAgent.run("agent-webmismatch", "Webmismatch AS", "https://webmismatch-real.no", "key-webmismatch", null);
      insertKnowledge.run("agent-webmismatch", "https://totally-wrong-host.no", null, "review_required", "{}");

      // (3) Manual review: knowledge.email host != agents.url host (website
      // absent so only the email check fires).
      insertAgent.run("agent-emailmismatch", "Emailmismatch AS", "https://emailmismatch-real.no", "key-emailmismatch", null);
      insertKnowledge.run("agent-emailmismatch", null, "post@some-other-company.no", "review_required", "{}");

      // (4) Circular scramble pair: A's agents.url == B's knowledge.website
      // host, and B's agents.url == A's knowledge.website host. Hostnames
      // chosen to be brand-dissimilar (not just a single differing char)
      // so the domain-coherence similarity rescue (IDN/hyphen/edit-distance
      // same-brand equivalence) does NOT collapse them back to coherent —
      // verified directly against domainCoherenceCheck before writing this
      // fixture.
      insertAgent.run("agent-scramble-a", "ScrambleA AS", "https://haugland-gard.no", "key-scramble-a", null);
      insertKnowledge.run("agent-scramble-a", "https://vestgaard-mat.no", null, "review_required", "{}");
      insertAgent.run("agent-scramble-b", "ScrambleB AS", "https://vestgaard-mat.no", "key-scramble-b", null);
      insertKnowledge.run("agent-scramble-b", "https://haugland-gard.no", null, "review_required", "{}");

      // (5) Umbrella agent — must be excluded entirely even though it is
      // incoherent.
      insertAgent.run("agent-umbrella", "Umbrella AS", "https://umbrella-real.no", "key-umbrella", "network");
      insertKnowledge.run("agent-umbrella", "https://umbrella-wrong.no", null, "review_required", "{}");

      // (6) Not in review_required — must never surface.
      insertAgent.run("agent-verified", "Verifiedgard AS", "https://verified-wrong.no", "key-verified", null);
      insertKnowledge.run("agent-verified", "https://verified-mismatch.no", null, "verified", "{}");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./admin-domain-coherence")];
      const routeMod = require("./admin-domain-coherence");
      const router = routeMod.default;

      // key=false means "omit the header entirely" (auth-gate test); any string
      // (including "" ) sets that literal value. Defaults to the valid testKey.
      // (NOTE: a plain `key: string | undefined = testKey` default parameter
      // would NOT work here — JS applies default values whenever the argument
      // is exactly `undefined`, including when explicitly passed, so
      // `post({}, undefined)` would silently fall back to testKey instead of
      // omitting the header.)
      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, {
          method: "POST",
          url: "/",
          headers,
          body,
        });
      }

      // ── auth gate ──────────────────────────────────────────────────────
      let result = await post({}, false);
      assertEq(result.status, 403, "dc-01: missing X-Admin-Key -> 403");
      result = await post({}, "wrong-key");
      assertEq(result.status, 403, "dc-02: wrong X-Admin-Key -> 403");

      // ── dry-run cohort classification ────────────────────────────────
      result = await post({});
      assertEq(result.status, 200, "dc-03: dry-run POST -> 200");
      const body1 = result.body;
      assertEq(body1.apply, false, "dc-04: apply reflects false when absent");
      // cohort = coherent, webmismatch, emailmismatch, scramble-a, scramble-b
      // (umbrella + verified excluded) = 5
      assertEq(body1.cohort_size, 5, "dc-05: cohort_size excludes umbrella + non-review_required (5)");
      assertEq(body1.coherent_skipped, 1, "dc-06: exactly one coherent agent skipped");

      const autoFixIds = body1.auto_fixable.map((a: any) => a.agent_id).sort();
      assertEq(autoFixIds, ["agent-webmismatch"], "dc-07: only the plain website-mismatch agent is auto_fixable (scramble pair excluded)");
      assertEq(body1.auto_fixable[0].proposed_website, "https://webmismatch-real.no",
        "dc-08: proposed_website is the agents.url host, https-normalized");
      assertEq(body1.auto_fixable[0].current_website, "https://totally-wrong-host.no",
        "dc-09: current_website reported in the proposal");
      assertTrue(String(body1.auto_fixable[0].reason).startsWith("knowledge.website host"),
        "dc-10: reason string carries the knowledge.website mismatch shape");

      const manualIds = body1.manual_review_needed.map((a: any) => a.agent_id).sort();
      assertEq(manualIds, ["agent-emailmismatch"], "dc-11: only the email-mismatch agent is manual_review_needed");
      assertTrue(String(body1.manual_review_needed[0].reason).startsWith("knowledge.email host"),
        "dc-12: reason string carries the knowledge.email mismatch shape");

      const scrambleIds = body1.circular_scramble_candidates.map((a: any) => a.agent_id).sort();
      assertEq(scrambleIds, ["agent-scramble-a", "agent-scramble-b"], "dc-13: both scrambled agents appear in circular_scramble_candidates");
      const scrambleA = body1.circular_scramble_candidates.find((a: any) => a.agent_id === "agent-scramble-a");
      assertEq(scrambleA.paired_agent_id, "agent-scramble-b", "dc-14: scramble-a's paired_agent_id points at scramble-b");
      const scrambleB = body1.circular_scramble_candidates.find((a: any) => a.agent_id === "agent-scramble-b");
      assertEq(scrambleB.paired_agent_id, "agent-scramble-a", "dc-15: scramble-b's paired_agent_id points at scramble-a");

      assertEq(body1.would_write, 1, "dc-16: would_write counts only the auto_fixable bucket");

      // Dry-run must not write anything.
      const preApplyRow = db.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'agent-webmismatch'").get() as { website: string };
      assertEq(preApplyRow.website, "https://totally-wrong-host.no", "dc-17: dry-run does not write knowledge.website");
      const preApplyParkRow = db.prepare("SELECT domain_reconciliation_checked_at FROM agent_knowledge WHERE agent_id = 'agent-coherent'").get() as { domain_reconciliation_checked_at: string | null };
      assertEq(preApplyParkRow.domain_reconciliation_checked_at, null, "dc-18: dry-run does not stamp parking markers");

      // ── apply mode ───────────────────────────────────────────────────
      result = await post({ apply: true });
      assertEq(result.status, 200, "dc-19: apply POST -> 200");
      assertEq(result.body.apply, true, "dc-20: apply reflects true");
      assertEq(result.body.written, 1, "dc-21: written=1 (the auto_fixable candidate)");

      const postApplyRow = db.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'agent-webmismatch'").get() as { website: string };
      assertEq(postApplyRow.website, "https://webmismatch-real.no", "dc-22: apply writes the corrected website");

      const emailRow = db.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'agent-emailmismatch'").get() as { website: string | null };
      assertEq(emailRow.website, null, "dc-23: email-mismatch agent's website is NEVER written");

      const scrambleAUrlRow = db.prepare("SELECT url FROM agents WHERE id = 'agent-scramble-a'").get() as { url: string };
      assertEq(scrambleAUrlRow.url, "https://haugland-gard.no", "dc-24: circular-scramble candidate's agents.url is NEVER written (still the pre-sweep value)");

      // Parking markers stamped on everything NOT auto-fixed.
      const coherentPark = db.prepare(
        "SELECT domain_reconciliation_checked_at, domain_reconciliation_outcome FROM agent_knowledge WHERE agent_id = 'agent-coherent'"
      ).get() as { domain_reconciliation_checked_at: string | null; domain_reconciliation_outcome: string | null };
      assertTrue(!!coherentPark.domain_reconciliation_checked_at, "dc-25: coherent agent gets a parking timestamp after apply");
      assertEq(coherentPark.domain_reconciliation_outcome, "no_action_needed", "dc-26: coherent agent's outcome is no_action_needed");

      const manualPark = db.prepare(
        "SELECT domain_reconciliation_checked_at, domain_reconciliation_outcome FROM agent_knowledge WHERE agent_id = 'agent-emailmismatch'"
      ).get() as { domain_reconciliation_checked_at: string | null; domain_reconciliation_outcome: string | null };
      assertTrue(!!manualPark.domain_reconciliation_checked_at, "dc-27: manual_review_needed agent gets a parking timestamp after apply");
      assertEq(manualPark.domain_reconciliation_outcome, "manual_review_needed", "dc-28: manual_review_needed agent's outcome recorded");

      const scramblePark = db.prepare(
        "SELECT domain_reconciliation_checked_at, domain_reconciliation_outcome FROM agent_knowledge WHERE agent_id = 'agent-scramble-a'"
      ).get() as { domain_reconciliation_checked_at: string | null; domain_reconciliation_outcome: string | null };
      assertTrue(!!scramblePark.domain_reconciliation_checked_at, "dc-29: scramble candidate gets a parking timestamp after apply");
      assertEq(scramblePark.domain_reconciliation_outcome, "circular_scramble_candidate", "dc-30: scramble candidate's outcome recorded");

      // The auto-fixed agent itself is NOT parked (it's fixed, not skipped).
      const fixedPark = db.prepare(
        "SELECT domain_reconciliation_checked_at FROM agent_knowledge WHERE agent_id = 'agent-webmismatch'"
      ).get() as { domain_reconciliation_checked_at: string | null };
      assertEq(fixedPark.domain_reconciliation_checked_at, null, "dc-31: auto-fixed agent is NOT given a parking marker");

      // ── re-running dry-run afterward: the fixed agent is now coherent ──
      result = await post({});
      assertTrue(!result.body.auto_fixable.some((a: any) => a.agent_id === "agent-webmismatch"),
        "dc-32: re-run after apply no longer classifies the fixed agent as auto_fixable");
      assertTrue(!result.body.manual_review_needed.some((a: any) => a.agent_id === "agent-webmismatch"),
        "dc-32b: fixed agent is not in manual_review_needed either");

      // ── backoff parking: a second sweep skips parked agents ──────────
      // cohort_size should now exclude agent-coherent, agent-emailmismatch,
      // agent-scramble-a, agent-scramble-b (all freshly parked) — only
      // agent-webmismatch remains, and it's coherent now (fixed), so cohort
      // should be 1 with coherent_skipped=1 and all buckets empty.
      assertEq(result.body.cohort_size, 1, "dc-33: second sweep's cohort excludes all agents parked in the first apply run");
      assertEq(result.body.coherent_skipped, 1, "dc-34: the one remaining cohort member (now-fixed agent) is coherent");
      assertEq(result.body.auto_fixable.length, 0, "dc-35: no auto_fixable left");
      assertEq(result.body.manual_review_needed.length, 0, "dc-36: parked manual_review_needed agent does not reappear");
      assertEq(result.body.circular_scramble_candidates.length, 0, "dc-37: parked scramble candidates do not reappear");

      // ── the daily verifier's own selection query also excludes parked agents ──
      const { pickReviewQueueBatch } = require("../agents/lokal-agent-verifier") as
        typeof import("../agents/lokal-agent-verifier");
      let queueBatch = pickReviewQueueBatch(db, 100);
      let queueIds = queueBatch.map((r: any) => r.id);
      assertTrue(!queueIds.includes("agent-emailmismatch"), "dc-38: pickReviewQueueBatch excludes the parked manual_review_needed agent");
      assertTrue(!queueIds.includes("agent-coherent"), "dc-39: pickReviewQueueBatch excludes the parked coherent agent");
      assertTrue(!queueIds.includes("agent-scramble-a") && !queueIds.includes("agent-scramble-b"),
        "dc-40: pickReviewQueueBatch excludes the parked scramble candidates");

      // ── "something new happened" — a changed verification_review_reason
      // un-silences the agent even inside the 30-day window. ──────────
      db.prepare(
        "UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'agent-emailmismatch'"
      ).run(JSON.stringify({ reason: "something_new" }));
      queueBatch = pickReviewQueueBatch(db, 100);
      queueIds = queueBatch.map((r: any) => r.id);
      assertTrue(queueIds.includes("agent-emailmismatch"),
        "dc-41: a changed verification_review_reason re-surfaces the agent even within the 30-day backoff window");

      result = await post({});
      assertTrue(result.body.manual_review_needed.some((a: any) => a.agent_id === "agent-emailmismatch"),
        "dc-42: the sweep itself also re-classifies the agent once its review_reason changed");

      // ── 30-day backoff expiry: an old park is retried ────────────────
      db.prepare(
        "UPDATE agent_knowledge SET domain_reconciliation_checked_at = datetime('now','-31 days') WHERE agent_id = 'agent-coherent'"
      ).run();
      result = await post({});
      assertTrue(result.body.coherent_skipped >= 1 &&
        // cohort_size must have grown back to include agent-coherent again
        result.body.cohort_size >= 2,
        "dc-43: domain_reconciliation_checked_at older than 30 days -> agent is selectable again");

      // ── DOMAIN_RECONCILIATION_PARKING_DISABLED rollback flag ─────────
      // Re-park everything freshly first.
      result = await post({ apply: true });
      const parkedBefore = (await post({})).body.cohort_size;
      process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED = "true";
      result = await post({});
      assertTrue(result.body.cohort_size > parkedBefore,
        "dc-44: DOMAIN_RECONCILIATION_PARKING_DISABLED=true reverts the exclusion (more agents reappear)");
      delete process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED;
      result = await post({});
      assertEq(result.body.cohort_size, parkedBefore,
        "dc-45: unsetting the flag restores the exclusion");

      // The pickReviewQueueBatch picker also honors the same rollback flag.
      process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED = "true";
      const unrestricted = pickReviewQueueBatch(db, 100).map((r: any) => r.id);
      assertTrue(unrestricted.includes("agent-coherent"),
        "dc-46: pickReviewQueueBatch also honors DOMAIN_RECONCILIATION_PARKING_DISABLED");
      delete process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED;

      // ── umbrella exclusion is structural (never in any bucket, any run) ──
      const anyRunHasUmbrella =
        [body1, result.body].some((b: any) =>
          [...b.auto_fixable, ...b.manual_review_needed, ...b.circular_scramble_candidates]
            .some((a: any) => a.agent_id === "agent-umbrella")
        );
      assertTrue(!anyRunHasUmbrella, "dc-47: umbrella agent never appears in any bucket across all runs");
      const umbrellaKnowledge = db.prepare(
        "SELECT website FROM agent_knowledge WHERE agent_id = 'agent-umbrella'"
      ).get() as { website: string };
      assertEq(umbrellaKnowledge.website, "https://umbrella-wrong.no", "dc-48: umbrella agent's website is never touched");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED;
      else process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED = prevParkingDisabled;
    }

    // ── ONE-DIRECTIONAL scramble overlap (separate, isolated DB) ─────────
    // Regression test for a real prod finding, not a hypothetical: probing
    // the deployed sweep against production surfaced Solheim Kjøtt
    // (agents.url=bi1.no, website=solheimkjott.no — its website is ALREADY
    // correct) whose agents.url collides with a DIFFERENT agent's
    // (Bi 1 Bigård) website. That's the same shape as the 2026-07-05
    // 5-agent circular-scramble incident, but the strict-reciprocal check
    // (A's url==B's website AND B's url==A's website) missed it because
    // Bi 1 Bigård's OWN agents.url does not equal Solheim's website — the
    // overlap only holds in ONE direction. Under the original logic,
    // Solheim would have been "auto-fixed" by overwriting its already-
    // correct website with the still-scrambled agents.url host — actively
    // re-corrupting good data. This fixture reproduces that exact shape
    // with two fresh agents (no shared state with the block above) and
    // asserts both land in circular_scramble_candidates, neither is
    // auto-fixed, and the one with an already-correct website is not
    // overwritten by apply.
    {
      const prevDb2 = initMod.getDb();
      const testKey2 = "admin-domain-coherence-onedir-test-key";
      const prevAdminKey2 = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testKey2;
      const db2 = new Database(":memory:");
      try {
        initMod.__setDbForTesting(db2 as any);
        initMod.__initSchemaForTesting(db2 as any);

        const insertAgent2 = db2.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
        );
        const insertKnowledge2 = db2.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status, verification_review_reason)
           VALUES (?, ?, NULL, 'A test farm shop', '{}', 'review_required', '{}')`,
        );

        // agent-onedir-scrambled-url (Solheim-shaped): its agents.url is the
        // SCRAMBLED one (wrongly points at the OTHER agent's real domain,
        // shared-collision-host.no) but its OWN knowledge.website is ALREADY
        // CORRECT (onedir-scrambled-url-actual-site.no) and must never be
        // overwritten.
        insertAgent2.run("agent-onedir-scrambled-url", "OneDirScrambledUrl AS", "https://shared-collision-host.no", "key-onedir-a");
        insertKnowledge2.run("agent-onedir-scrambled-url", "https://onedir-scrambled-url-actual-site.no");
        // agent-onedir-wrong-website (Bi1-shaped): its OWN agents.url is its
        // real, correct domain, but its knowledge.website is wrong — it
        // holds the SAME host (shared-collision-host.no) that the OTHER
        // agent's (scrambled) agents.url points at. Verified this pair is
        // genuinely ONE-DIRECTIONAL: agent-onedir-wrong-website's agentHost
        // (onedir-wrong-website-actual-site.no) does NOT equal
        // agent-onedir-scrambled-url's websiteHost
        // (onedir-scrambled-url-actual-site.no) — only the reverse
        // direction (wrong-website's website == scrambled-url's agents.url)
        // holds. A strict-reciprocal check (PR #251's original logic) would
        // have missed this pair entirely.
        insertAgent2.run("agent-onedir-wrong-website", "OneDirWrongWebsite AS", "https://onedir-wrong-website-actual-site.no", "key-onedir-b");
        insertKnowledge2.run("agent-onedir-wrong-website", "https://shared-collision-host.no");

        delete require.cache[require.resolve("./admin-domain-coherence")];
        const routeMod2 = require("./admin-domain-coherence");
        const router2 = routeMod2.default;

        function post2(body: any): Promise<RouteResult> {
          return callRoute(router2, {
            method: "POST",
            url: "/",
            headers: { "content-type": "application/json", "x-admin-key": testKey2 },
            body,
          });
        }

        let r = await post2({});
        assertEq(r.status, 200, "dc-49: one-directional fixture dry-run -> 200");
        const oneDirIds = r.body.circular_scramble_candidates.map((a: any) => a.agent_id).sort();
        assertEq(oneDirIds, ["agent-onedir-scrambled-url", "agent-onedir-wrong-website"],
          "dc-50: a ONE-DIRECTIONAL host overlap (not a strict reciprocal pair) still flags both agents as scramble candidates");
        assertTrue(!r.body.auto_fixable.some((a: any) => a.agent_id === "agent-onedir-scrambled-url"),
          "dc-51: the agent whose website is already correct is NOT auto-fixed despite the incoherence check flagging it");
        assertTrue(!r.body.auto_fixable.some((a: any) => a.agent_id === "agent-onedir-wrong-website"),
          "dc-52: the other side of the one-directional overlap is also excluded from auto_fixable");

        r = await post2({ apply: true });
        const scrambledUrlRow = db2.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'agent-onedir-scrambled-url'").get() as { website: string };
        assertEq(scrambledUrlRow.website, "https://onedir-scrambled-url-actual-site.no",
          "dc-53: apply does NOT overwrite the already-correct website with the scrambled agents.url host (the actual bug found in prod)");
        const wrongWebsiteRow = db2.prepare("SELECT website FROM agent_knowledge WHERE agent_id = 'agent-onedir-wrong-website'").get() as { website: string };
        assertEq(wrongWebsiteRow.website, "https://shared-collision-host.no",
          "dc-54: apply does not touch the other scramble-candidate's website either (report-only, even though this one genuinely is wrong)");
      } finally {
        initMod.__setDbForTesting(prevDb2);
        if (prevAdminKey2 === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey2;
      }
    }

    // ── Slice 3b (dev-request 2026-07-15-gate-integrity-unverified-agent-bypass):
    // homepage-evidence widening (separate, isolated DB). A cohort row whose
    // knowledge.website host mismatches agents.url's host, but whose
    // field_provenance carries homepage-proven phone/address evidence that
    // matches the row's own phone/address value, must be classified
    // `coherent` (never auto_fixable/manual_review_needed) — and under
    // apply:true must get stampParking(..., "no_action_needed", ...), never
    // reach the auto-fix WRITE path (knowledge.website must be left
    // untouched).
    {
      const prevDb3 = initMod.getDb();
      const testKey3 = "admin-domain-coherence-homepage-evidence-test-key";
      const prevAdminKey3 = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testKey3;
      const db3 = new Database(":memory:");
      try {
        initMod.__setDbForTesting(db3 as any);
        initMod.__initSchemaForTesting(db3 as any);

        const insertAgent3 = db3.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
        );
        const insertKnowledge3 = db3.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, field_provenance, about, verification_status, verification_review_reason)
           VALUES (?, ?, ?, ?, ?, ?, 'A test farm shop', 'review_required', '{}')`,
        );

        // agent_url host (b1.no) mismatches knowledge.website (totally-wrong-host.no)
        // — the classic auto_fixable shape — BUT field_provenance.phone has a
        // homepage-proven record matching the row's own phone value. This must
        // rescue coherence entirely: no bucket, no write.
        insertAgent3.run("agent-homepage-rescued", "HomepageRescued AS", "https://b1.no", "key-hp-rescued", null);
        insertKnowledge3.run(
          "agent-homepage-rescued",
          "https://totally-wrong-host.no",
          null,
          "91122333",
          null,
          JSON.stringify({ phone: [{ value: "91122333", source_type: "homepage", fetched_at: "2026-07-01" }] }),
        );

        // Control: identical shape, but NO homepage evidence — must classify
        // normally (auto_fixable), proving the fixture above wasn't coherent
        // for some other reason.
        insertAgent3.run("agent-homepage-not-rescued", "HomepageNotRescued AS", "https://b2.no", "key-hp-not-rescued", null);
        insertKnowledge3.run(
          "agent-homepage-not-rescued",
          "https://also-totally-wrong-host.no",
          null,
          "91122333",
          null,
          "{}",
        );

        delete require.cache[require.resolve("./admin-domain-coherence")];
        const routeMod3 = require("./admin-domain-coherence");
        const router3 = routeMod3.default;

        function post3(body: any): Promise<RouteResult> {
          return callRoute(router3, {
            method: "POST",
            url: "/",
            headers: { "content-type": "application/json", "x-admin-key": testKey3 },
            body,
          });
        }

        let r = await post3({});
        assertEq(r.status, 200, "dc-55: homepage-evidence fixture dry-run -> 200");
        assertTrue(
          !r.body.auto_fixable.some((a: any) => a.agent_id === "agent-homepage-rescued"),
          "dc-56: homepage-proven-phone agent is NOT auto_fixable",
        );
        assertTrue(
          !r.body.manual_review_needed.some((a: any) => a.agent_id === "agent-homepage-rescued"),
          "dc-57: homepage-proven-phone agent is NOT manual_review_needed either",
        );
        assertTrue(
          !r.body.circular_scramble_candidates.some((a: any) => a.agent_id === "agent-homepage-rescued"),
          "dc-58: homepage-proven-phone agent is NOT a circular_scramble_candidate",
        );
        assertTrue(
          r.body.auto_fixable.some((a: any) => a.agent_id === "agent-homepage-not-rescued"),
          "dc-59: control agent WITHOUT homepage evidence IS classified auto_fixable (proves the rescue discriminates)",
        );

        r = await post3({ apply: true });
        assertEq(r.status, 200, "dc-60: apply POST -> 200");

        const rescuedRow = db3.prepare(
          "SELECT website, domain_reconciliation_outcome, domain_reconciliation_checked_at FROM agent_knowledge WHERE agent_id = 'agent-homepage-rescued'"
        ).get() as { website: string; domain_reconciliation_outcome: string | null; domain_reconciliation_checked_at: string | null };
        assertEq(rescuedRow.website, "https://totally-wrong-host.no",
          "dc-61: apply does NOT rewrite the homepage-rescued agent's website (never reaches the auto-fix WRITE path)");
        assertEq(rescuedRow.domain_reconciliation_outcome, "no_action_needed",
          "dc-62: homepage-rescued agent is parked as no_action_needed under apply:true");
        assertTrue(!!rescuedRow.domain_reconciliation_checked_at,
          "dc-63: homepage-rescued agent gets a parking timestamp under apply:true");

        const notRescuedRow = db3.prepare(
          "SELECT website FROM agent_knowledge WHERE agent_id = 'agent-homepage-not-rescued'"
        ).get() as { website: string };
        assertEq(notRescuedRow.website, "https://b2.no",
          "dc-64: control agent WITHOUT homepage evidence IS auto-fixed under apply:true (website corrected to agents.url host)");
      } finally {
        initMod.__setDbForTesting(prevDb3);
        if (prevAdminKey3 === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey3;
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminDomainCoherenceSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
