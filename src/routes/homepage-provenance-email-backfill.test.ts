/**
 * homepage-provenance-email-backfill.test.ts — tests the email-column
 * backfill added 2026-07-05 to POST /admin/homepage-provenance-batch.
 *
 * Root cause: the `outreach_ready_pool` VIEW (database/init.ts) gates
 * strictly on `agent_knowledge.email IS NOT NULL` — but the homepage
 * scraper only ever wrote an extracted, guarded email into the
 * `field_provenance` JSON blob, mirroring the phone/address handling EXCEPT
 * for the actual column write those two fields get. Result: a "successful"
 * enrichment run could never move outreach_pool_added off zero for an
 * agent whose only contact-field gap was email (controller-handoff
 * 2026-07-05-lokal-agent-enrichment-email-acquisition-1.md).
 *
 * Mirrors admin-db-table-sizes.test.ts / contact-tracking.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - global.fetch is stubbed for the duration of the test (the route does
 *     a real server-side fetch of the agent's homepage) and restored after.
 *   - exported runHomepageProvenanceEmailBackfillTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-email-backfill.test.ts
 *
 * Covers:
 *   (a) agent with website + no email, no phone, no address: homepage HTML
 *       mentions the producer name and has a same-domain mailto: link ->
 *       agent_knowledge.email gets backfilled with the extracted address
 *       (this is the actual regression check: previously stayed NULL).
 *   (b) same run also still back-fills phone/address when present in the
 *       HTML and empty in the DB (unchanged prior behavior, still covered
 *       so a future edit can't silently break the existing pattern).
 *   (c) agent that ALREADY has an email on file: a different mailto: found
 *       on the page must NOT overwrite the existing value (mirrors the
 *       existing "only if column empty" rule for phone/address).
 *   (d) email extracted but rejected by isAcceptableHomepageEmail (foreign
 *       domain, not a freemail) -> not written to the column (nor would it
 *       be in field_provenance).
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

export function runHomepageProvenanceEmailBackfillTests(
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
    const testKey = "homepage-provenance-email-backfill-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      insertAgent.run("agent-no-email", "Testgard AS", "https://testgard.no", "key-1");
      insertAgent.run("agent-has-email", "Andregard AS", "https://andregard.no", "key-2");
      insertAgent.run("agent-bad-domain", "Tredjegard AS", "https://tredjegard.no", "key-3");

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, about, field_provenance)
         VALUES (?, ?, ?, NULL, NULL, 'A test farm shop', '{}')`,
      );
      insertKnowledge.run("agent-no-email", "https://testgard.no", null);
      insertKnowledge.run("agent-has-email", "https://andregard.no", "post@andregard.no");
      insertKnowledge.run("agent-bad-domain", "https://tredjegard.no", null);

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      // Stub global fetch: return HTML keyed by URL.
      (globalThis as any).fetch = async (url: string) => {
        let html = "";
        if (url.includes("testgard.no")) {
          html = `<html><head><title>Testgard AS</title></head><body>
            <h1>Testgard AS</h1>
            <p>Velkommen til Testgard! Ring oss på 92 34 56 78 eller besøk
            oss på Gardsveien 12, 2740 Roa.</p>
            <a href="mailto:post@testgard.no">post@testgard.no</a>
          </body></html>`;
        } else if (url.includes("andregard.no")) {
          html = `<html><head><title>Andregard AS</title></head><body>
            <h1>Andregard AS</h1>
            <a href="mailto:annen@andregard.no">annen@andregard.no</a>
          </body></html>`;
        } else if (url.includes("tredjegard.no")) {
          html = `<html><head><title>Tredjegard AS</title></head><body>
            <h1>Tredjegard AS</h1>
            <a href="mailto:kontakt@en-helt-annen-aggregator.example">kontakt@en-helt-annen-aggregator.example</a>
          </body></html>`;
        }
        return {
          ok: true,
          status: 200,
          text: async () => html,
        } as any;
      };

      const result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: {
          agentIds: ["agent-no-email", "agent-has-email", "agent-bad-domain"],
        },
      });

      assertEq(result.status, 200, "POST /admin/homepage-provenance-batch -> 200");

      // ── (a) email backfilled when column was empty ─────────────
      const rowNoEmail = db
        .prepare("SELECT email, phone, address FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-no-email") as { email: string | null; phone: string | null; address: string | null };
      assertEq(rowNoEmail.email, "post@testgard.no",
        "agent-no-email: agent_knowledge.email backfilled from homepage mailto: (the actual regression)");

      // ── (b) phone/address still backfilled (unchanged prior behavior) ──
      assertEq(rowNoEmail.phone, "92345678",
        "agent-no-email: agent_knowledge.phone still backfilled (normalised digits)");
      assertTrue(!!rowNoEmail.address && rowNoEmail.address.includes("2740"),
        "agent-no-email: agent_knowledge.address still backfilled");

      // ── (c) existing email is never overwritten ─────────────────
      const rowHasEmail = db
        .prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-has-email") as { email: string | null };
      assertEq(rowHasEmail.email, "post@andregard.no",
        "agent-has-email: pre-existing email is NOT overwritten by a different mailto: found on the page");

      // ── (d) rejected (foreign-domain, non-freemail) email is not written ──
      const rowBadDomain = db
        .prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-bad-domain") as { email: string | null };
      assertEq(rowBadDomain.email, null,
        "agent-bad-domain: email on an unrelated domain is rejected by isAcceptableHomepageEmail, column stays NULL");
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceEmailBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
