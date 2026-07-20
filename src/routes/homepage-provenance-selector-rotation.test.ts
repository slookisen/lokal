/**
 * homepage-provenance-selector-rotation.test.ts — tests the selector-rotation
 * + no-yield backoff added to POST /admin/homepage-provenance-batch (dev-request
 * 2026-07-19-enrichment-selector-rotasjon-no-yield-backoff):
 *
 * CONFIRMED bug this fixes: 3 consecutive calls with {limit:15} returned the
 * IDENTICAL processed=13, enriched=0 batch — zero universe coverage. Root
 * cause: the default auto-select's two "fetch succeeded but nothing useful
 * came out of it" early-return paths (ownership-guard rejection; nothing
 * extractable) wrote NOTHING to agent_knowledge, so those agents sorted as
 * "least recently touched" forever under `ORDER BY k.updated_at ASC` and got
 * reselected every single run.
 *
 * Fix under test:
 *   1. last_enrichment_attempt_at / last_enrichment_outcome are stamped for
 *      EVERY agent a homepage fetch was actually attempted for, on every
 *      outcome (enriched / no_yield / fetch_failed / wrong_entity).
 *   2. The default auto-select now orders by last_enrichment_attempt_at ASC
 *      (never-attempted NULLs first) instead of updated_at — two consecutive
 *      calls over an all-no-yield universe must select DISJUNCT sets.
 *   3. no_yield_streak reaching 3 excludes the agent from the default
 *      auto-select for NO_YIELD_BACKOFF_DAYS days (default 14); an 'enriched'
 *      outcome resets the streak to 0 and clears the exclusion immediately.
 *   4. The existing homepage_fetch_attempts / homepage_unreachable_since
 *      3-strikes fetch-FAILURE parking mechanism is untouched (covered by its
 *      own homepage-provenance-selector-parking.test.ts, run unmodified).
 *
 * Mirrors homepage-provenance-selector-parking.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema, includes this PR's
 *     migration).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - global.fetch is stubbed and restored after.
 *   - exported runHomepageProvenanceSelectorRotationTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-selector-rotation.test.ts
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

export function runHomepageProvenanceSelectorRotationTests(
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
    const testKey = "homepage-provenance-selector-rotation-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;
    const prevParkingDisabled = process.env.HOMEPAGE_PARKING_DISABLED;
    delete process.env.HOMEPAGE_PARKING_DISABLED;
    const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;
    delete process.env.NO_YIELD_BACKOFF_DAYS;

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
         VALUES (?, ?, NULL, 'A test farm shop', '{}', 'pending_verify')`,
      );
      // 'verified' (NOT one of data_insufficient/review_required/pending_verify)
      // so these two control agents are invisible to the default auto-select's
      // WHERE clause and are only ever reached via explicit agentIds — keeping
      // them from diluting/contaminating the rotation-cohort assertions below,
      // which rely on the default auto-select's universe being exactly the 6
      // agent-rot-* agents.
      const insertKnowledgeVerified = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status)
         VALUES (?, ?, NULL, 'A test farm shop', '{}', 'verified')`,
      );

      // A cohort of 6 agents, all pending_verify, all whose fetched homepage
      // mentions the producer (passes ownership guard) but has NO extractable
      // contact fields — every one of them lands in the no_yield bug path.
      const rotationAgents = [1, 2, 3, 4, 5, 6].map((n) => ({
        id: `agent-rot-${n}`,
        name: `Rotgard${n} AS`,
        host: `rot${n}-gard.no`,
      }));
      for (const a of rotationAgents) {
        insertAgent.run(a.id, a.name, `https://${a.host}`, `key-${a.id}`);
        insertKnowledge.run(a.id, `https://${a.host}`);
      }

      // A single agent used for the no-yield-backoff (3-strikes) test. Its
      // `agents` row is created now, but its `agent_knowledge` row (with
      // verification_status='pending_verify', so it becomes visible to the
      // default auto-select) is only inserted further below, right before the
      // backoff test phase — so it cannot dilute/contaminate the rotation-
      // cohort disjoint-set assertions above, which rely on the default
      // auto-select's universe being exactly the 6 agent-rot-* agents.
      insertAgent.run("agent-noyield", "Noyieldgard AS", "https://noyield-gard.no", "key-noyield");

      // A control agent whose fetch DOES yield an extractable field, to prove
      // the 'enriched' outcome resets no_yield_streak / stamps correctly.
      // 'verified' (excluded from the default auto-select's WHERE clause) —
      // it is only ever reached via explicit agentIds below.
      insertAgent.run("agent-enrich", "Enrichgard AS", "https://enrich-gard.no", "key-enrich");
      insertKnowledgeVerified.run("agent-enrich", "https://enrich-gard.no");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const hostNames: Record<string, string> = {};
      for (const a of rotationAgents) hostNames[a.host] = a.name;
      hostNames["noyield-gard.no"] = "Noyieldgard AS";
      hostNames["enrich-gard.no"] = "Enrichgard AS";

      const fetchedHosts: string[] = [];
      (globalThis as any).fetch = async (url: string) => {
        const host = new URL(url).hostname;
        fetchedHosts.push(host);
        const name = hostNames[host] ?? "Ukjent AS";
        if (host === "enrich-gard.no") {
          // Mentions the producer AND carries an extractable phone number.
          return {
            ok: true,
            status: 200,
            text: async () =>
              `<html><head><title>${name}</title></head><body><h1>${name}</h1><p>Ring oss på 91 23 45 67</p></body></html>`,
          } as any;
        }
        // Mentions the producer (passes ownership guard) but has no
        // extractable email/phone/address — the no_yield bug path.
        return {
          ok: true,
          status: 200,
          text: async () => `<html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
        } as any;
      };

      async function post(body: any): Promise<RouteResult> {
        fetchedHosts.length = 0;
        return callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      function knowledgeRow(agentId: string): {
        last_enrichment_attempt_at: string | null;
        last_enrichment_outcome: string | null;
        no_yield_streak: number;
      } {
        return db
          .prepare(
            "SELECT last_enrichment_attempt_at, last_enrichment_outcome, no_yield_streak FROM agent_knowledge WHERE agent_id = ?",
          )
          .get(agentId) as {
          last_enrichment_attempt_at: string | null;
          last_enrichment_outcome: string | null;
          no_yield_streak: number;
        };
      }

      // ── (1) rotation: two consecutive calls over an all-no-yield universe
      // must select DISJUNCT sets (the core regression test) ───────────────
      const rotIds = rotationAgents.map((a) => a.id);
      let result = await post({ limit: 3 });
      assertEq(result.status, 200, "rot-01: first batch call -> 200");
      const firstBatchHosts = [...fetchedHosts];
      assertEq(firstBatchHosts.length, 3, "rot-02: first batch selects exactly limit=3 agents");

      result = await post({ limit: 3 });
      assertEq(result.status, 200, "rot-03: second batch call -> 200");
      const secondBatchHosts = [...fetchedHosts];
      assertEq(secondBatchHosts.length, 3, "rot-04: second batch also selects 3 agents");

      const overlap = firstBatchHosts.filter((h) => secondBatchHosts.includes(h));
      assertEq(overlap.length, 0,
        "rot-05: first and second batch selected DISJUNCT agent sets (rotation works — the exact bug being fixed)");

      // Together, the two disjoint 3-agent batches cover the ENTIRE 6-agent
      // universe exactly once each — full coverage before any repeat.
      const uniqueSelected = new Set([...firstBatchHosts, ...secondBatchHosts]);
      assertEq(uniqueSelected.size, rotIds.length,
        "rot-06: across 2 batches (limit=3 each), all 6 agents in the universe were reached exactly once each (full coverage before any repeat)");

      // ── (2) every no_yield outcome is stamped ─────────────────────────────
      const firstAgentId = rotationAgents.find((a) => a.host === firstBatchHosts[0])!.id;
      const stampedRow = knowledgeRow(firstAgentId);
      assertTrue(!!stampedRow.last_enrichment_attempt_at,
        "rot-07: last_enrichment_attempt_at stamped for a no_yield outcome");
      assertEq(stampedRow.last_enrichment_outcome, "no_yield",
        "rot-08: last_enrichment_outcome='no_yield' for a fetch that yielded nothing");
      assertEq(stampedRow.no_yield_streak, 1,
        "rot-09: no_yield_streak incremented to 1 on the first no-yield outcome");

      // ── (3) no-yield backoff: 3 consecutive no-yield outcomes exclude the
      // agent for NO_YIELD_BACKOFF_DAYS days, then it becomes selectable again
      // once the window passes ──────────────────────────────────────────────
      // NOW give agent-noyield a pending_verify agent_knowledge row (visible
      // to the default auto-select) — deliberately only from this point on,
      // so it played no part in the rotation-cohort assertions above.
      insertKnowledge.run("agent-noyield", "https://noyield-gard.no");

      await post({ agentIds: ["agent-noyield"] });
      await post({ agentIds: ["agent-noyield"] });
      let noYieldRow = knowledgeRow("agent-noyield");
      assertEq(noYieldRow.no_yield_streak, 2, "rot-10: 2 consecutive no-yield outcomes -> streak=2");

      result = await post({ agentIds: ["agent-noyield"] });
      noYieldRow = knowledgeRow("agent-noyield");
      assertEq(noYieldRow.no_yield_streak, 3, "rot-11: 3rd consecutive no-yield outcome -> streak=3");
      assertEq(noYieldRow.last_enrichment_outcome, "no_yield", "rot-11b: outcome recorded as no_yield");

      // Now the streak is 3 AND the attempt just happened (recent) -> the
      // default auto-select must exclude it.
      result = await post({ limit: 25 });
      assertTrue(!fetchedHosts.includes("noyield-gard.no"),
        "rot-12: agent with no_yield_streak>=3 and a RECENT attempt is excluded from default auto-select");

      // Move the timestamp outside the (default 14-day) backoff window ->
      // selectable again.
      db.prepare(
        "UPDATE agent_knowledge SET last_enrichment_attempt_at = datetime('now','-15 days') WHERE agent_id = 'agent-noyield'",
      ).run();
      result = await post({ limit: 25 });
      assertTrue(fetchedHosts.includes("noyield-gard.no"),
        "rot-13: once the 14-day backoff window has passed, the agent is selectable again");

      // ── (4) an 'enriched' outcome resets no_yield_streak to 0 and clears
      // any backoff ──────────────────────────────────────────────────────────
      // Re-park it (3 fresh no-yield outcomes, recent timestamp) then prove a
      // single enriched outcome clears the exclusion.
      db.prepare(
        "UPDATE agent_knowledge SET no_yield_streak = 3, last_enrichment_attempt_at = datetime('now') WHERE agent_id = 'agent-noyield'",
      ).run();
      result = await post({ limit: 25 });
      assertTrue(!fetchedHosts.includes("noyield-gard.no"),
        "rot-14: re-parked (streak=3, recent attempt) agent is excluded again");

      // Explicit agentIds bypasses the auto-select WHERE clause (trusted path,
      // matches the existing fetch-failure parking's own explicit-bypass
      // behaviour) — used here only to drive a fresh fetch for the agent so we
      // can observe the enriched outcome resetting its streak.
      result = await post({ agentIds: ["agent-enrich"] });
      assertTrue(fetchedHosts.includes("enrich-gard.no"), "rot-15: control agent fetched");
      const enrichedRow = knowledgeRow("agent-enrich");
      assertEq(enrichedRow.last_enrichment_outcome, "enriched",
        "rot-16: last_enrichment_outcome='enriched' when a field was actually extracted");
      assertEq(enrichedRow.no_yield_streak, 0,
        "rot-17: no_yield_streak reset to 0 on an enriched outcome");
      assertTrue(!!enrichedRow.last_enrichment_attempt_at,
        "rot-18: last_enrichment_attempt_at stamped for the enriched outcome too");

      // Prove the reset actually clears backoff selectability: park
      // agent-noyield fresh again, then simulate its OWN enriched recovery.
      db.prepare(
        "UPDATE agent_knowledge SET no_yield_streak = 3, last_enrichment_attempt_at = datetime('now') WHERE agent_id = 'agent-noyield'",
      ).run();
      result = await post({ limit: 25 });
      assertTrue(!fetchedHosts.includes("noyield-gard.no"),
        "rot-19: still excluded before recovery");
      db.prepare(
        "UPDATE agent_knowledge SET no_yield_streak = 0 WHERE agent_id = 'agent-noyield'",
      ).run();
      result = await post({ limit: 25 });
      assertTrue(fetchedHosts.includes("noyield-gard.no"),
        "rot-20: streak reset to 0 immediately clears the backoff exclusion (no separate cleared-column needed)");

      // ── (5) response shape unaffected ─────────────────────────────────────
      assertTrue(
        result.body?.success === true &&
        typeof result.body?.data?.processed === "number" &&
        typeof result.body?.data?.enriched === "number" &&
        Array.isArray(result.body?.data?.errors) &&
        Array.isArray(result.body?.data?.parked_now),
        "rot-21: response keeps the existing shape (success/processed/enriched/errors/parked_now)",
      );
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
      else process.env.HOMEPAGE_PARKING_DISABLED = prevParkingDisabled;
      if (prevNoYieldBackoffDays === undefined) delete process.env.NO_YIELD_BACKOFF_DAYS;
      else process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceSelectorRotationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
