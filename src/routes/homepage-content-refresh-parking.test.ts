/**
 * homepage-content-refresh-parking.test.ts — tests the dead-cohort parking
 * fix added 2026-07-30 to POST /admin/homepage-content-refresh
 * (routes/admin-knowledge.ts; dev-request
 * 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 3, rfb
 * measurement):
 *
 *   Before this fix, the route never touched
 *   homepage_fetch_attempts/homepage_unreachable_since at all -- a fetch
 *   failure left no trace, so its own ORDER BY updated_at ASC auto-select
 *   kept re-selecting the SAME dead domain every single day (measured across
 *   six consecutive enrichment reports, 2026-07-25..07-30: ~4-8% of the
 *   default limit=25 candidates ever had a fetchable homepage). This mirrors
 *   the 3-strikes/30-day parking convention already live on the SAME
 *   agent_knowledge columns for the sibling selector (POST
 *   /admin/homepage-provenance-batch, marketplace.ts) -- with one
 *   improvement: this route uses services/fetch-page.ts's classified
 *   `persistence` (which marketplace.ts's pre-fetchPage-era code does not)
 *   so a `transient` failure (timeout/5xx/429/conn_reset/conn_refused/
 *   tls_error) never counts a strike, only `permanent` (dns_not_found/
 *   404/410) and `blocked` (401/403/empty_body) do.
 *
 * Mirrors homepage-provenance-selector-parking.test.ts's harness:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - global.fetch is stubbed to return real Response objects (for HTTP
 *     status failures) or throw classified network errors (dns/conn_refused),
 *     recording which hosts get fetched -- that is how selection is
 *     observed.
 *   - exported runHomepageContentRefreshParkingTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-content-refresh-parking.test.ts
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
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runHomepageContentRefreshParkingTests(
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
    const testKey = "homepage-content-refresh-parking-test-key";
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
      insertAgent.run("agent-good", "Godgard AS", "https://god-gard.no", "key-good");
      insertAgent.run("agent-dead-permanent", "Dnsdeadgard AS", "https://dns-dead-gard.no", "key-dns");
      insertAgent.run("agent-dead-blocked", "Blockedgard AS", "https://blocked-gard.no", "key-blocked");
      insertAgent.run("agent-dead-transient", "Transientgard AS", "https://transient-gard.no", "key-transient");

      // All candidates: has about text (satisfies "existing about/products"),
      // field_provenance = '{}' (no website_homepage source yet -- eligible),
      // non-umbrella. ORDER BY updated_at ASC with an old fixed timestamp so
      // insertion order is deterministic across the whole run.
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, updated_at)
         VALUES (?, ?, 'Existing google-sourced about text.', '[]', '{}', '2020-01-01T00:00:00.000Z')`,
      );
      insertKnowledge.run("agent-good", "https://god-gard.no");
      insertKnowledge.run("agent-dead-permanent", "https://dns-dead-gard.no");
      insertKnowledge.run("agent-dead-blocked", "https://blocked-gard.no");
      insertKnowledge.run("agent-dead-transient", "https://transient-gard.no");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./admin-knowledge")];
      const adminKnowledgeMod = require("./admin-knowledge");
      const router = adminKnowledgeMod.homepageContentRefreshRouter;

      const fetchedHosts: string[] = [];

      (globalThis as any).fetch = async (url: string) => {
        const host = new URL(url).hostname;
        fetchedHosts.push(host);
        if (host === "dns-dead-gard.no") {
          const err: any = new Error("getaddrinfo ENOTFOUND dns-dead-gard.no");
          err.cause = { code: "ENOTFOUND" };
          throw err;
        }
        if (host === "blocked-gard.no") {
          return new Response("Forbidden", { status: 401, statusText: "Unauthorized" });
        }
        if (host === "transient-gard.no") {
          const err: any = new Error("connect ECONNREFUSED");
          err.cause = { code: "ECONNREFUSED" };
          throw err;
        }
        // agent-good and anything else: a real, minimal, deliberately INERT
        // HTML page -- no product-category tokens and no about-length text,
        // so the extractors never produce a writable candidate. This test is
        // about selection/parking, not the content-write path; a page that
        // DID pass meetsAboutQualityBar would get its about/products written
        // and stamp field_provenance with "website_homepage" on apply=1,
        // which correctly (and separately) removes the agent from this
        // route's own "not yet homepage-sourced" auto-select criterion --
        // that's real, wanted behavior, just not what hcr-15 onward exercises.
        return new Response(
          `<html><head><title>Godgard AS</title></head><body><h1>Godgard AS</h1></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      };

      async function post(body: any, query?: Record<string, string>): Promise<RouteResult> {
        fetchedHosts.length = 0;
        return callRoute(router, {
          method: "POST",
          url: "/homepage-content-refresh",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
          query,
        });
      }

      function knowledgeRow(agentId: string): { homepage_fetch_attempts: number; homepage_unreachable_since: string | null } {
        return db
          .prepare("SELECT homepage_fetch_attempts, homepage_unreachable_since FROM agent_knowledge WHERE agent_id = ?")
          .get(agentId) as { homepage_fetch_attempts: number; homepage_unreachable_since: string | null };
      }

      // ── (0) dry-run auto-select sees all four candidates, no bookkeeping ──
      let result = await post({});
      assertEq(result.status, 200, "hcr-01: POST (dry-run default) -> 200");
      assertTrue(fetchedHosts.includes("god-gard.no"), "hcr-02: auto-select includes the healthy candidate");
      assertTrue(fetchedHosts.includes("dns-dead-gard.no"), "hcr-03: auto-select includes the not-yet-parked dns-dead candidate");
      assertTrue(fetchedHosts.includes("blocked-gard.no"), "hcr-04: auto-select includes the not-yet-parked blocked candidate");
      assertTrue(fetchedHosts.includes("transient-gard.no"), "hcr-05: auto-select includes the not-yet-parked transient candidate");
      assertEq(knowledgeRow("agent-dead-permanent").homepage_fetch_attempts, 0,
        "hcr-06: dry-run does NOT increment homepage_fetch_attempts (no bookkeeping on preview)");
      assertEq(result.body?.parked_now, [],
        "hcr-07: parked_now present and empty on a dry-run");

      // ── (1) apply mode: failures increment attempts, gated by persistence ──
      for (let i = 1; i <= 3; i++) {
        result = await post({}, { apply: "1" });
        assertEq(knowledgeRow("agent-dead-permanent").homepage_fetch_attempts, i,
          `hcr-08-${i}: permanent (dns_not_found) failure #${i} -> homepage_fetch_attempts=${i}`);
        assertEq(knowledgeRow("agent-dead-blocked").homepage_fetch_attempts, i,
          `hcr-09-${i}: blocked (http_401) failure #${i} -> homepage_fetch_attempts=${i}`);
        assertEq(knowledgeRow("agent-dead-transient").homepage_fetch_attempts, 0,
          `hcr-10-${i}: transient (conn_refused) failure #${i} does NOT increment -- must never strike a momentary blip`);
      }
      assertTrue(!!knowledgeRow("agent-dead-permanent").homepage_unreachable_since,
        "hcr-11: permanent cohort is parked after 3 strikes");
      assertTrue(!!knowledgeRow("agent-dead-blocked").homepage_unreachable_since,
        "hcr-12: blocked cohort is parked after 3 strikes");
      assertEq(knowledgeRow("agent-dead-transient").homepage_unreachable_since, null,
        "hcr-13: transient cohort is NEVER parked, no matter how many failures -- by design");
      assertEq(result.body?.parked_now?.sort(), ["agent-dead-blocked", "agent-dead-permanent"].sort(),
        "hcr-14: both newly-crossed-threshold agents reported in parked_now on the run that parked them");

      // ── (2) parked agents excluded from the NEXT auto-select; transient stays selectable ──
      result = await post({}, { apply: "1" });
      assertTrue(fetchedHosts.includes("god-gard.no"), "hcr-15: healthy candidate still selected");
      assertTrue(fetchedHosts.includes("transient-gard.no"), "hcr-16: transient candidate still selected (never parked)");
      assertTrue(!fetchedHosts.includes("dns-dead-gard.no"), "hcr-17: permanent-parked candidate excluded from auto-select");
      assertTrue(!fetchedHosts.includes("blocked-gard.no"), "hcr-18: blocked-parked candidate excluded from auto-select");

      // ── (3) explicit agentIds bypasses the parking exclusion ────────────────
      result = await post({ agentIds: ["agent-dead-permanent"] }, { apply: "1" });
      assertTrue(fetchedHosts.includes("dns-dead-gard.no"),
        "hcr-19: explicit agentIds still processes a parked agent (trusted path)");

      // ── (4) HOMEPAGE_PARKING_DISABLED reverts the auto-select exclusion ─────
      process.env.HOMEPAGE_PARKING_DISABLED = "true";
      result = await post({}, { apply: "1" });
      assertTrue(fetchedHosts.includes("dns-dead-gard.no"),
        "hcr-20: HOMEPAGE_PARKING_DISABLED=true -> parked agent IS selected again (rollback flag)");
      delete process.env.HOMEPAGE_PARKING_DISABLED;
      result = await post({}, { apply: "1" });
      assertTrue(!fetchedHosts.includes("dns-dead-gard.no"),
        "hcr-21: unsetting the flag restores the exclusion");

      // ── (5) 30-day backoff: an old park is retried, and a failed retry re-stamps ──
      db.prepare(
        "UPDATE agent_knowledge SET homepage_unreachable_since = datetime('now','-31 days') WHERE agent_id = 'agent-dead-permanent'"
      ).run();
      result = await post({}, { apply: "1" });
      assertTrue(fetchedHosts.includes("dns-dead-gard.no"),
        "hcr-22: homepage_unreachable_since older than 30 days -> selectable again");
      const reparkedRow = knowledgeRow("agent-dead-permanent");
      assertTrue(
        !!reparkedRow.homepage_unreachable_since &&
        Date.parse(reparkedRow.homepage_unreachable_since) > Date.now() - 60_000,
        "hcr-23: failed retry after expired backoff re-stamps homepage_unreachable_since to a fresh value");

      // ── (6) a successful fetch fully resets the parking state ───────────────
      db.prepare(
        "UPDATE agent_knowledge SET homepage_fetch_attempts = 3, homepage_unreachable_since = datetime('now') WHERE agent_id = 'agent-dead-blocked'"
      ).run();
      result = await post({ agentIds: ["agent-dead-blocked"] }, { apply: "1" });
      // Re-route this id's host to succeed for this one call by temporarily
      // swapping the stub -- simplest way to prove a real recovery resets state.
      // (Re-stub fetch: blocked-gard.no now answers 200.)
      const savedFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = async (url: string) => {
        fetchedHosts.push(new URL(url).hostname);
        return new Response(
          `<html><head><title>Blockedgard AS</title></head><body><h1>Blockedgard AS</h1><p>Na fungerer siden vare igjen med okse og gris.</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      };
      result = await post({ agentIds: ["agent-dead-blocked"] }, { apply: "1" });
      (globalThis as any).fetch = savedFetch;
      const resetRow = knowledgeRow("agent-dead-blocked");
      assertEq(resetRow.homepage_fetch_attempts, 0,
        "hcr-24: successful fetch resets homepage_fetch_attempts to 0");
      assertEq(resetRow.homepage_unreachable_since, null,
        "hcr-25: successful fetch clears homepage_unreachable_since");

      // Response shape: existing keys untouched alongside parked_now.
      assertTrue(
        typeof result.body?.dry_run === "boolean" &&
        typeof result.body?.scanned === "number" &&
        Array.isArray(result.body?.errors) &&
        Array.isArray(result.body?.parked_now),
        "hcr-26: response keeps the existing shape (dry_run/scanned/errors) plus parked_now",
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
  runHomepageContentRefreshParkingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
