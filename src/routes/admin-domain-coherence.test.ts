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

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminDomainCoherenceSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
