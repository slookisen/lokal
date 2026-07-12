/**
 * homepage-provenance-selector-parking.test.ts — tests the two selection
 * changes added 2026-07-12 to POST /admin/homepage-provenance-batch
 * (dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction):
 *
 *   1. `select: "verified_no_email"` body param — targets verified agents
 *      whose email column is still empty but who have a homepage. The default
 *      auto-select can never reach these (it only selects pre-verification
 *      statuses), which is why the RFB outreach pool was stuck at 2 despite
 *      ~472 verified agents.
 *   2. Dead-cohort parking — 3 consecutive homepage fetch failures set
 *      homepage_unreachable_since (via homepage_fetch_attempts), excluding
 *      the agent from BOTH auto-select paths for 30 days so each run stops
 *      re-fetching the same dead/aggregator URLs. A successful fetch fully
 *      resets the counter; explicit agentIds bypasses the exclusion; env
 *      HOMEPAGE_PARKING_DISABLED="true" reverts selection (rollback flag).
 *
 * Mirrors homepage-provenance-email-backfill.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - global.fetch is stubbed (recording which hosts get fetched — that is
 *     how selection is observed — with a mutable fail-set for the parking
 *     phases) and restored after.
 *   - exported runHomepageProvenanceSelectorParkingTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-selector-parking.test.ts
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

export function runHomepageProvenanceSelectorParkingTests(
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
    const testKey = "homepage-provenance-selector-parking-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;
    const prevParkingDisabled = process.env.HOMEPAGE_PARKING_DISABLED;
    delete process.env.HOMEPAGE_PARKING_DISABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      // Verified cohort (select:"verified_no_email" targets).
      insertAgent.run("agent-vne", "Vnegard AS", "https://vne-gard.no", "key-vne");
      insertAgent.run("agent-vne-hasemail", "Hasemail AS", "https://has-email.no", "key-hasemail");
      insertAgent.run("agent-vne-nohomepage", "Nohome AS", "", "key-nohome");
      insertAgent.run("agent-vne-dead", "Vnedead AS", "https://vne-dead.no", "key-vnedead");
      // Pre-verification cohort (default auto-select targets).
      insertAgent.run("agent-pending", "Pendinggard AS", "https://pending-gard.no", "key-pending");
      insertAgent.run("agent-dead", "Deadgard AS", "https://dead-gard.no", "key-dead");
      insertAgent.run("agent-vne-emptyweb", "Emptyweb AS", "https://emptyweb-gard.no", "key-emptyweb");

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status)
         VALUES (?, ?, ?, 'A test farm shop', '{}', ?)`,
      );
      insertKnowledge.run("agent-vne", "https://vne-gard.no", null, "verified");
      insertKnowledge.run("agent-vne-hasemail", "https://has-email.no", "post@has-email.no", "verified");
      insertKnowledge.run("agent-vne-nohomepage", null, null, "verified");
      insertKnowledge.run("agent-vne-dead", "https://vne-dead.no", null, "verified");
      insertKnowledge.run("agent-pending", "https://pending-gard.no", null, "pending_verify");
      insertKnowledge.run("agent-dead", "https://dead-gard.no", null, "pending_verify");
      // Empty-string website (NOT null): must fall back to agents.url via
      // NULLIF instead of burning a LIMIT slot as an unprocessable row.
      insertKnowledge.run("agent-vne-emptyweb", "", null, "verified");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      // Stub global fetch: records fetched hosts (= observable selection),
      // fails for hosts in failHosts, otherwise returns minimal HTML that
      // mentions the producer name (passes the ownership guard) but carries
      // no contact fields (so no enrichment writes disturb later phases).
      const fetchedHosts: string[] = [];
      const failHosts = new Set<string>();
      const hostNames: Record<string, string> = {
        "vne-gard.no": "Vnegard AS",
        "has-email.no": "Hasemail AS",
        "vne-dead.no": "Vnedead AS",
        "pending-gard.no": "Pendinggard AS",
        "dead-gard.no": "Deadgard AS",
        "emptyweb-gard.no": "Emptyweb AS",
      };
      (globalThis as any).fetch = async (url: string) => {
        const host = new URL(url).hostname;
        fetchedHosts.push(host);
        if (failHosts.has(host)) {
          return { ok: false, status: 503, text: async () => "" } as any;
        }
        const name = hostNames[host] ?? "Ukjent AS";
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

      function knowledgeRow(agentId: string): { homepage_fetch_attempts: number; homepage_unreachable_since: string | null } {
        return db
          .prepare("SELECT homepage_fetch_attempts, homepage_unreachable_since FROM agent_knowledge WHERE agent_id = ?")
          .get(agentId) as { homepage_fetch_attempts: number; homepage_unreachable_since: string | null };
      }

      // ── (1) select:"verified_no_email" selection set ─────────────────────
      let result = await post({ select: "verified_no_email" });
      assertEq(result.status, 200, "sp-01: POST select=verified_no_email -> 200");
      assertTrue(fetchedHosts.includes("vne-gard.no"),
        "sp-02: verified agent with empty email + homepage IS selected");
      assertTrue(fetchedHosts.includes("vne-dead.no"),
        "sp-03: second verified/no-email agent also selected (not yet parked)");
      assertTrue(!fetchedHosts.includes("has-email.no"),
        "sp-04: verified agent WITH email is NOT selected");
      assertTrue(!fetchedHosts.includes("pending-gard.no") && !fetchedHosts.includes("dead-gard.no"),
        "sp-05: pending_verify agents are NOT selected by verified_no_email");
      assertTrue(fetchedHosts.includes("emptyweb-gard.no"),
        "sp-05b: empty-string website falls back to agents.url (NULLIF) and is actually fetched");
      assertEq(result.body?.data?.processed, 3,
        "sp-06: processed=3 (no-homepage verified agent excluded from selection; empty-website agent included via agents.url)");
      assertTrue(Array.isArray(result.body?.data?.parked_now) && result.body.data.parked_now.length === 0,
        "sp-07: parked_now present in response and empty (all fetches ok)");

      // ── (1b) default auto-select unchanged when select absent/unknown ────
      result = await post({});
      assertEq(result.status, 200, "sp-08: POST without select -> 200");
      assertTrue(fetchedHosts.includes("pending-gard.no") && fetchedHosts.includes("dead-gard.no"),
        "sp-09: default auto-select still targets the pre-verification cohort");
      assertTrue(!fetchedHosts.includes("vne-gard.no"),
        "sp-10: default auto-select still excludes verified agents");

      result = await post({ select: "bogus_mode" });
      assertEq(result.status, 400,
        "sp-11: unrecognized select value -> 400 (an autonomous routine's typo must never silently run the wrong cohort)");
      assertEq(fetchedHosts.length, 0,
        "sp-11b: nothing is fetched on a rejected select value");

      // ── (2) parking after 3 consecutive fetch failures ────────────────────
      failHosts.add("dead-gard.no");

      result = await post({ agentIds: ["agent-dead"] });
      assertEq(knowledgeRow("agent-dead").homepage_fetch_attempts, 1,
        "sp-12: failure #1 -> homepage_fetch_attempts=1");
      assertEq(result.body?.data?.parked_now, [],
        "sp-13: failure #1 does not park");

      result = await post({ agentIds: ["agent-dead"] });
      assertEq(knowledgeRow("agent-dead").homepage_fetch_attempts, 2,
        "sp-14: failure #2 -> homepage_fetch_attempts=2");
      assertEq(result.body?.data?.parked_now, [],
        "sp-15: failure #2 does not park");

      result = await post({ agentIds: ["agent-dead"] });
      const parkedRow = knowledgeRow("agent-dead");
      assertEq(parkedRow.homepage_fetch_attempts, 3,
        "sp-16: failure #3 -> homepage_fetch_attempts=3");
      assertTrue(!!parkedRow.homepage_unreachable_since,
        "sp-17: failure #3 sets homepage_unreachable_since (parked)");
      assertEq(result.body?.data?.parked_now, ["agent-dead"],
        "sp-18: agent id reported in parked_now on the run that crossed the threshold");

      result = await post({});
      assertTrue(fetchedHosts.includes("pending-gard.no"),
        "sp-19: default auto-select still returns the healthy pending agent");
      assertTrue(!fetchedHosts.includes("dead-gard.no"),
        "sp-20: parked agent is excluded from the default auto-select");

      // Park a verified agent directly (already exercised the organic path
      // above) to prove the verified_no_email path filters too.
      db.prepare(
        "UPDATE agent_knowledge SET homepage_fetch_attempts = 3, homepage_unreachable_since = datetime('now') WHERE agent_id = 'agent-vne-dead'"
      ).run();
      result = await post({ select: "verified_no_email" });
      assertTrue(fetchedHosts.includes("vne-gard.no"),
        "sp-21: verified_no_email still returns the healthy verified agent");
      assertTrue(!fetchedHosts.includes("vne-dead.no"),
        "sp-22: parked agent is excluded from verified_no_email too");

      // Explicit agentIds bypasses parking (trusted path).
      result = await post({ agentIds: ["agent-dead"] });
      assertTrue(fetchedHosts.includes("dead-gard.no"),
        "sp-23: parked agent is still processable via explicit agentIds");
      assertEq(result.body?.data?.parked_now, [],
        "sp-24: already-parked agent is not re-reported in parked_now");
      assertEq(knowledgeRow("agent-dead").homepage_fetch_attempts, 4,
        "sp-25: attempts keep counting past the threshold");

      // ── (5) HOMEPAGE_PARKING_DISABLED reverts selection only ─────────────
      process.env.HOMEPAGE_PARKING_DISABLED = "true";
      result = await post({});
      assertTrue(fetchedHosts.includes("dead-gard.no"),
        "sp-26: HOMEPAGE_PARKING_DISABLED=true -> parked agent IS selected again (rollback flag, read at request time)");
      delete process.env.HOMEPAGE_PARKING_DISABLED;
      result = await post({});
      assertTrue(!fetchedHosts.includes("dead-gard.no"),
        "sp-27: unsetting the flag restores the exclusion");

      // ── (3) 30-day backoff: an old park is retried ────────────────────────
      db.prepare(
        "UPDATE agent_knowledge SET homepage_unreachable_since = datetime('now','-31 days') WHERE agent_id = 'agent-dead'"
      ).run();
      result = await post({});
      assertTrue(fetchedHosts.includes("dead-gard.no"),
        "sp-28: homepage_unreachable_since older than 30 days -> selectable again");

      // ── (3b) re-park: the expired-backoff retry FAILED again (failHosts
      // still contains dead-gard.no here), so the failure must RE-STAMP the
      // parking timestamp — otherwise the stale timestamp satisfies the
      // exclusion's `<= now-30d` forever and a still-dead agent is burned on
      // every run after its first backoff cycle (PR #248 review blocker).
      const reparkedRow = knowledgeRow("agent-dead");
      assertTrue(
        !!reparkedRow.homepage_unreachable_since &&
        Date.parse(reparkedRow.homepage_unreachable_since) > Date.now() - 60_000,
        "sp-28b: failed retry after expired backoff re-stamps homepage_unreachable_since to a fresh value");
      assertEq(result.body?.data?.parked_now, ["agent-dead"],
        "sp-28c: re-parked agent is reported in parked_now");
      result = await post({});
      assertTrue(!fetchedHosts.includes("dead-gard.no"),
        "sp-28d: re-parked agent is excluded from auto-select again");

      // ── (4) a successful fetch fully resets the parking state ────────────
      failHosts.delete("dead-gard.no");
      result = await post({ agentIds: ["agent-dead"] });
      const resetRow = knowledgeRow("agent-dead");
      assertEq(resetRow.homepage_fetch_attempts, 0,
        "sp-29: successful fetch resets homepage_fetch_attempts to 0");
      assertEq(resetRow.homepage_unreachable_since, null,
        "sp-30: successful fetch clears homepage_unreachable_since");

      // Response shape: existing keys untouched alongside parked_now.
      assertTrue(
        result.body?.success === true &&
        typeof result.body?.data?.processed === "number" &&
        typeof result.body?.data?.enriched === "number" &&
        Array.isArray(result.body?.data?.errors) &&
        Array.isArray(result.body?.data?.parked_now),
        "sp-31: response keeps the existing shape (success/processed/enriched/errors) plus parked_now",
      );
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
      else process.env.HOMEPAGE_PARKING_DISABLED = prevParkingDisabled;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceSelectorParkingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
