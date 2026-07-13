/**
 * admin-domain-reconciliation.test.ts — dev-request 2026-07-12-rfb-enrichment-
 * pool-refill-and-waste-reduction, item 3 (domain-incoherent reconciliation,
 * 2026-07-13).
 *
 * Covers:
 *   (1) circular_scramble_detected — a 5-agent circular chain, generalizing
 *       the 07-05 shape: each agent's agents.url holds the NEXT agent's real
 *       agent_knowledge.website, forming a ring. All 5 must be classified
 *       circular_scramble_detected with the correct related_agent_ids.
 *   (2) stale_knowledge_website — a single agent whose own agents.url is
 *       internally coherent but agent_knowledge.website points at an
 *       unrelated company (the 19-agent 07-05 shape).
 *   (3) manual_review_needed — (a) a domain-coherent agent (no signal at
 *       all) and (b) a genuinely ambiguous mismatch (no scramble partner,
 *       own url doesn't cohere against its email either).
 *   (4) GET /admin/domain-reconciliation-audit is read-only: zero DB writes
 *       even though it runs the full classifier.
 *   (5) POST /admin/domain-reconciliation-sweep dry_run (default) vs
 *       dry_run=false: dry_run writes nothing; dry_run=false applies the
 *       two high-confidence fixes atomically (agents.url and/or
 *       agent_knowledge.website + field_provenance + verification_status ->
 *       'pending_verify') and stamps review_required_last_audited_at on
 *       every other visited row.
 *   (6) A proposed fix that fails its re-coherence check (email disagrees
 *       with the corrected value) is refused — reported in failed_recheck,
 *       stamped instead of applied.
 *   (7) Multi-cycle simulation (the PR #248 review-blocker shape): sweep ->
 *       pickReviewQueueBatch excludes -> backoff expires -> pickReviewQueueBatch
 *       includes again -> sweep AGAIN re-stamps to a fresh timestamp (not
 *       left stale) -> pickReviewQueueBatch excludes again. Also checks
 *       force=1 bypasses the exclusion regardless of a fresh stamp.
 *
 * Mirrors homepage-provenance-selector-parking.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema, so the real
 *     review_required_last_audited_at migration + column is present).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAdminDomainReconciliationTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-domain-reconciliation.test.ts
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
        resolve({ status: 404, body: undefined, ended: false });
      }
    });
  });
}

export function runAdminDomainReconciliationTests(
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
    const testKey = "admin-domain-reconciliation-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status)
         VALUES (?, ?, ?, 'A test farm shop', '{}', ?)`,
      );

      // ── (1) circular_scramble_detected: 5-agent ring ────────────────────
      // Each agent's OWN website is correct (a distinct, mutually-unrelated
      // domain — deliberately NOT near-miss variants of each other, since
      // domainsEquivalent's Norwegian-transliteration/edit-distance rescue
      // would otherwise treat two of these as the SAME entity and mask the
      // mismatch this fixture needs); each agent's OWN url wrongly holds the
      // NEXT agent's website domain.
      const ring = ["ra", "rb", "rc", "rd", "re"];
      const RING_DOMAIN: Record<string, string> = {
        ra: "https://alfagarden.no",
        rb: "https://bravofarm.no",
        rc: "https://charliehage.no",
        rd: "https://deltabruk.no",
        re: "https://echobonde.no",
      };
      const ringWebsite = (id: string) => RING_DOMAIN[id];
      for (let i = 0; i < ring.length; i++) {
        const id = ring[i];
        const nextId = ring[(i + 1) % ring.length];
        insertAgent.run(id, `Ring ${id}`, ringWebsite(nextId), `key-${id}`);
        insertKnowledge.run(id, ringWebsite(id), null, "review_required");
      }

      // ── (2) stale_knowledge_website: own url coherent, website is wrong ──
      insertAgent.run("sw-1", "Stale AS", "https://foxstadgard.no", "key-sw1");
      insertKnowledge.run("sw-1", "https://unrelatedbedrift.no", null, "review_required");

      // ── (3a) manual_review_needed: domain-coherent (no signal at all) ────
      insertAgent.run("mc-1", "Coherent AS", "https://golfhagen.no", "key-mc1");
      insertKnowledge.run("mc-1", "https://golfhagen.no", null, "review_required");

      // ── (3b) manual_review_needed: ambiguous mismatch (no scramble
      // partner, email also disagrees with url — nothing to anchor on) ─────
      insertAgent.run("mc-2", "Ambiguous AS", "https://hotelgard.no", "key-mc2");
      insertKnowledge.run("mc-2", "https://indiafarm.no", "post@juliettbedrift.no", "review_required");

      // ── (6) failed-recheck fixture: I's url matches J's website (circular
      // candidate), but I's OWN email disagrees with I's OWN website — so
      // the proposed fix (agents.url <- I.website) would still leave I
      // domain-incoherent against its own email. J is 'verified' (a
      // scramble partner outside the audited cohort, matching-universe only).
      insertAgent.run("fr-j", "Partner J", "https://kilogard.no", "key-frj");
      insertKnowledge.run("fr-j", "https://kilogard.no", null, "verified");
      insertAgent.run("fr-i", "Agent I", "https://kilogard.no", "key-fri");
      insertKnowledge.run("fr-i", "https://limafarm.no", "post@mikebedrift.no", "review_required");

      // ── (7) multi-cycle backoff fixture: plain manual_review_needed row ──
      insertAgent.run("bo-1", "Backoff AS", "https://novemberhage.no", "key-bo1");
      insertKnowledge.run("bo-1", "https://novemberhage.no", null, "review_required");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./admin-domain-reconciliation")];
      const mod = require("./admin-domain-reconciliation");
      const router = mod.default;

      function get(url: string): Promise<RouteResult> {
        return callRoute(router, {
          method: "GET",
          url,
          headers: { "x-admin-key": testKey },
        });
      }
      function post(url: string, body: any): Promise<RouteResult> {
        return callRoute(router, {
          method: "POST",
          url,
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      function snapshot() {
        return {
          agents: db.prepare("SELECT id, url FROM agents ORDER BY id").all(),
          knowledge: db
            .prepare(
              "SELECT agent_id, website, verification_status, review_required_last_audited_at FROM agent_knowledge ORDER BY agent_id",
            )
            .all(),
        };
      }

      function byId(list: any[], id: string): any {
        return list.find((r: any) => r.agent_id === id || r.id === id);
      }

      // ═══ Audit (read-only) ═══════════════════════════════════════════════
      const before = JSON.stringify(snapshot());
      const auditResult = await get("/domain-reconciliation-audit");
      const after = JSON.stringify(snapshot());
      assertEq(auditResult.status, 200, "audit-01: GET audit -> 200");
      assertEq(before, after, "audit-02: GET audit makes ZERO DB writes");

      const agentsById: Record<string, any> = {};
      for (const a of auditResult.body.agents) agentsById[a.agent_id] = a;

      // (1) circular ring — all 5 detected, each pointing at its own real
      // fix (agent_knowledge.website of the SAME agent).
      for (const id of ring) {
        assertEq(
          agentsById[id]?.classification,
          "circular_scramble_detected",
          `audit-ring: ${id} classified circular_scramble_detected`,
        );
        assertEq(
          agentsById[id]?.proposed_fix,
          { field: "agents.url", new_value: ringWebsite(id) },
          `audit-ring: ${id} proposed fix is agents.url <- own website (${ringWebsite(id)})`,
        );
        assertTrue(
          Array.isArray(agentsById[id]?.related_agent_ids) && agentsById[id].related_agent_ids.length >= 1,
          `audit-ring: ${id} carries at least one related_agent_id (audit trail)`,
        );
      }
      const nextOf = (id: string) => ring[(ring.indexOf(id) + 1) % ring.length];
      assertTrue(
        agentsById["ra"].related_agent_ids.includes(nextOf("ra")),
        "audit-ring: ra's related_agent_ids names the agent whose website it was holding (rb)",
      );

      // (2) stale_knowledge_website
      assertEq(agentsById["sw-1"]?.classification, "stale_knowledge_website", "audit-stale: sw-1 classified stale_knowledge_website");
      assertEq(
        agentsById["sw-1"]?.proposed_fix,
        { field: "agent_knowledge.website", new_value: "https://foxstadgard.no" },
        "audit-stale: sw-1 proposed fix is agent_knowledge.website <- agents.url",
      );

      // (3) manual_review_needed
      assertEq(agentsById["mc-1"]?.classification, "manual_review_needed", "audit-manual: mc-1 (domain-coherent) -> manual_review_needed");
      assertEq(agentsById["mc-1"]?.proposed_fix, null, "audit-manual: mc-1 has no proposed fix");
      assertEq(agentsById["mc-2"]?.classification, "manual_review_needed", "audit-manual: mc-2 (ambiguous mismatch) -> manual_review_needed");

      // (6) fr-i: circular CANDIDATE at classification time (matches fr-j's website)
      assertEq(agentsById["fr-i"]?.classification, "circular_scramble_detected", "audit-recheck: fr-i classified circular_scramble_detected pre-recheck");

      // Summary counts sanity: circular=5(ring)+1(fr-i)=6, stale=1, manual>=2
      assertEq(auditResult.body.summary.circular_scramble_detected, 6, "audit-summary: circular count = 6 (5-ring + fr-i)");
      assertEq(auditResult.body.summary.stale_knowledge_website, 1, "audit-summary: stale count = 1");
      assertTrue(auditResult.body.summary.manual_review_needed >= 3, "audit-summary: manual count includes mc-1, mc-2, bo-1");

      // ═══ Sweep — dry_run default (true): zero writes ════════════════════
      const beforeDry = JSON.stringify(snapshot());
      const dryResult = await post("/domain-reconciliation-sweep", {});
      const afterDry = JSON.stringify(snapshot());
      assertEq(dryResult.status, 200, "sweep-01: POST sweep (no body) -> 200");
      assertEq(dryResult.body.dry_run, true, "sweep-02: dry_run defaults true");
      assertEq(beforeDry, afterDry, "sweep-03: dry_run=true makes ZERO DB writes");
      assertTrue(dryResult.body.applied_count >= 6, "sweep-04: dry_run response still reports what WOULD be applied");

      // ═══ Sweep — dry_run=false: real writes ═════════════════════════════
      const applyResult = await post("/domain-reconciliation-sweep", { dry_run: false });
      assertEq(applyResult.status, 200, "sweep-05: POST sweep dry_run=false -> 200");
      assertEq(applyResult.body.dry_run, false, "sweep-06: response echoes dry_run=false");
      assertEq(applyResult.body.visited, 10, "sweep-07: visited = 10 (5 ring + sw-1 + mc-1 + mc-2 + fr-i + bo-1; fr-j is 'verified', never visited)");
      assertEq(applyResult.body.applied.length, 6, "sweep-08: applied = 6 (5 ring + sw-1; fr-i's fix failed its re-check)");
      assertEq(applyResult.body.failed_recheck, ["fr-i"], "sweep-09: failed_recheck = [fr-i]");
      assertTrue(
        applyResult.body.stamped_no_fix.includes("mc-1") &&
          applyResult.body.stamped_no_fix.includes("mc-2") &&
          applyResult.body.stamped_no_fix.includes("bo-1") &&
          applyResult.body.stamped_no_fix.includes("fr-i"),
        "sweep-10: stamped_no_fix includes every manual_review_needed row plus the failed-recheck row",
      );

      const afterApply = snapshot();

      // Ring: every agent's url now equals its OWN website; status pending_verify.
      for (const id of ring) {
        const agentRow = byId(afterApply.agents, id);
        const kRow = byId(afterApply.knowledge, id);
        assertEq(agentRow.url, ringWebsite(id), `apply-ring: ${id}.agents.url corrected to its own website`);
        assertEq(kRow.verification_status, "pending_verify", `apply-ring: ${id} verification_status -> pending_verify (never straight to verified)`);
      }

      // stale: agent_knowledge.website corrected to agents.url; status pending_verify.
      const swK = byId(afterApply.knowledge, "sw-1");
      assertEq(swK.website, "https://foxstadgard.no", "apply-stale: sw-1.agent_knowledge.website corrected to agents.url");
      assertEq(swK.verification_status, "pending_verify", "apply-stale: sw-1 verification_status -> pending_verify");

      // field_provenance audit trail present for a corrected agent.
      const raProv = JSON.parse(
        db.prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'ra'").get().field_provenance,
      );
      assertTrue(
        Array.isArray(raProv.domain_reconciliation_history) && raProv.domain_reconciliation_history.length === 1,
        "apply-provenance: ra's field_provenance carries a domain_reconciliation_history entry",
      );
      assertTrue(
        raProv.domain_reconciliation_history[0].related_agent_ids.includes(nextOf("ra")),
        "apply-provenance: history entry names the related agent id for audit trail",
      );
      assertTrue(
        Array.isArray(raProv.url) && raProv.url.some((r: any) => r.source_type === "domain_reconciliation_sweep"),
        "apply-provenance: standard field_provenance['url'] array also carries a domain_reconciliation_sweep record",
      );

      // manual rows: NOT touched (no url/website change), but audited-stamped.
      const mc1K = byId(afterApply.knowledge, "mc-1");
      assertTrue(!!mc1K.review_required_last_audited_at, "apply-manual: mc-1.review_required_last_audited_at stamped");
      assertEq(mc1K.verification_status, "review_required", "apply-manual: mc-1 verification_status untouched (still review_required)");
      const mc2K = byId(afterApply.knowledge, "mc-2");
      assertTrue(!!mc2K.review_required_last_audited_at, "apply-manual: mc-2.review_required_last_audited_at stamped");

      // (6) fr-i: proposed fix failed its re-check (own email disagrees with
      // the proposed new url value) -> refused, NOT applied, stamped instead.
      const friAgent = byId(afterApply.agents, "fr-i");
      const friK = byId(afterApply.knowledge, "fr-i");
      assertEq(friAgent.url, "https://kilogard.no", "apply-recheck: fr-i.agents.url UNCHANGED (fix was refused)");
      assertEq(friK.verification_status, "review_required", "apply-recheck: fr-i verification_status UNCHANGED (fix was refused)");
      assertTrue(!!friK.review_required_last_audited_at, "apply-recheck: fr-i stamped instead of fixed");
      assertTrue(applyResult.body.failed_recheck.includes("fr-i"), "apply-recheck: fr-i reported in failed_recheck");
      assertTrue(!applyResult.body.applied.some((a: any) => a.agent_id === "fr-i"), "apply-recheck: fr-i NOT in applied[]");

      // fr-j (the matching partner, 'verified') must be completely untouched —
      // it was never a member of the audited cohort.
      const frjAgent = byId(afterApply.agents, "fr-j");
      const frjK = byId(afterApply.knowledge, "fr-j");
      assertEq(frjAgent.url, "https://kilogard.no", "apply-recheck: fr-j (matching partner) url untouched");
      assertEq(frjK.verification_status, "verified", "apply-recheck: fr-j (matching partner) status untouched");

      // ═══ (7) Multi-cycle backoff simulation ═════════════════════════════
      const { pickReviewQueueBatch } = require("../agents/lokal-agent-verifier");

      function idsOf(rows: any[]): string[] {
        return rows.map((r: any) => r.id);
      }

      // bo-1 was just stamped by the dry_run=false sweep above (manual_review_needed).
      const boStampAfterCycle1 = db
        .prepare("SELECT review_required_last_audited_at FROM agent_knowledge WHERE agent_id = 'bo-1'")
        .get().review_required_last_audited_at;
      assertTrue(!!boStampAfterCycle1, "cycle1: bo-1 stamped by the first sweep pass");

      let batch = pickReviewQueueBatch(db, 200);
      assertTrue(!idsOf(batch).includes("bo-1"), "cycle1: pickReviewQueueBatch excludes bo-1 right after the stamp");

      let forcedBatch = pickReviewQueueBatch(db, 200, true);
      assertTrue(idsOf(forcedBatch).includes("bo-1"), "cycle1: force=true still includes bo-1 despite the recent stamp");

      // Expire the backoff (22 days ago) and confirm it becomes selectable again.
      db.prepare("UPDATE agent_knowledge SET review_required_last_audited_at = datetime('now', '-22 days') WHERE agent_id = 'bo-1'").run();
      batch = pickReviewQueueBatch(db, 200);
      assertTrue(idsOf(batch).includes("bo-1"), "cycle2: pickReviewQueueBatch includes bo-1 once the 21-day backoff has expired");

      // Cycle 2: sweep runs again (simulating the next audited-with-no-fix
      // pass). This MUST refresh the timestamp to a fresh value — the PR #248
      // review-blocker shape was exactly a no-op revisit failing to re-stamp,
      // leaving a stale timestamp that satisfied the exclusion forever.
      const sweepCycle2 = await post("/domain-reconciliation-sweep", { dry_run: false });
      assertEq(sweepCycle2.status, 200, "cycle2: second sweep call -> 200");
      const boStampAfterCycle2 = db
        .prepare("SELECT review_required_last_audited_at FROM agent_knowledge WHERE agent_id = 'bo-1'")
        .get().review_required_last_audited_at;
      assertTrue(
        !!boStampAfterCycle2 && Date.parse(boStampAfterCycle2) > Date.now() - 60_000,
        "cycle2: bo-1's timestamp is RE-STAMPED to a fresh value (not left at the 22-day-old value)",
      );
      assertTrue(boStampAfterCycle2 !== boStampAfterCycle1, "cycle2: re-stamped timestamp actually changed");

      // Cycle 3: pickReviewQueueBatch must exclude bo-1 again immediately
      // after the fresh re-stamp — proving the exclusion re-applies across
      // >=2 consecutive audit-with-no-fix passes, not just the first one.
      batch = pickReviewQueueBatch(db, 200);
      assertTrue(!idsOf(batch).includes("bo-1"), "cycle3: pickReviewQueueBatch EXCLUDES bo-1 again after the second no-fix stamp");

      forcedBatch = pickReviewQueueBatch(db, 200, true);
      assertTrue(idsOf(forcedBatch).includes("bo-1"), "cycle3: force=true still bypasses the exclusion on the second cycle too");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminDomainReconciliationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
