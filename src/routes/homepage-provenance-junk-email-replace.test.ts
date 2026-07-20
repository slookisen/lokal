/**
 * homepage-provenance-junk-email-replace.test.ts — tests the low_quality-mode
 * junk-email REPLACEMENT added to POST /admin/homepage-provenance-batch
 * (dev-request 2026-07-13-enrichment-tynne-profiler-trust-score, item 2 —
 * items 1/3 are the selector/trust-refresh slice, covered by
 * homepage-provenance-low-quality-selector.test.ts; item 5's existing
 * fill-if-empty path is the OTHER regression this file re-asserts stays
 * unchanged; see marketplace.ts's module doc comment on the handler).
 *
 * Background: the `select: "low_quality"` cohort (PR #318) re-targets agents
 * ranked worst-first by trust_score + junk/thinness signals for
 * re-enrichment — but the write path in processAgent() only ever backfilled
 * EMPTY columns. A bad-but-non-empty value (a placeholder email like
 * "info@example.com", the exact class isJunkEmail() already counts as a junk
 * signal) was never replaced, even in low_quality mode, whose whole point is
 * to fix already-"rich"-but-bad profiles.
 *
 * Covered here:
 *   (1) default (non-low_quality) mode: a junk stored email is NEVER
 *       replaced — regression-proof that default mode is byte-for-byte
 *       untouched by this slice.
 *   (2) low_quality mode, stored email is junk, a new distinct guarded email
 *       is extracted -> email column IS replaced, field_provenance gains the
 *       new homepage source, and the outcome carries emailReplaced: true.
 *   (3) low_quality mode, stored email is junk, curated_fields locks "email"
 *       -> email column is NOT replaced despite being junk (absolute guard).
 *   (4) low_quality mode, stored email is a real GOOD (non-junk) email, a
 *       different email is extracted -> email column is NOT replaced (never
 *       downgrade a verified-good value).
 *   (5) low_quality mode, stored email is empty -> existing fill-if-empty
 *       behavior still works unchanged (no regression on the pre-existing
 *       path).
 *   (6) low_quality mode, stored email is junk but the extracted value is
 *       identical to the current value (case/whitespace aside) -> no
 *       spurious write, no emailReplaced marker.
 *
 * Mirrors homepage-provenance-email-backfill.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)), no
 *     HTTP server / supertest.
 *   - global.fetch is stubbed for the duration of the test and restored
 *     after.
 *   - exported runHomepageProvenanceJunkEmailReplaceTests({log}) ->
 *     TestSummary; wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-junk-email-replace.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { knowledgeService } from "../services/knowledge-service";

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

export function runHomepageProvenanceJunkEmailReplaceTests(
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
    const testKey = "homepage-provenance-junk-email-replace-test-key";
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
      insertAgent.run("agent-default-junk", "Defaultjunk AS", "https://defaultjunk.no", "key-1");
      insertAgent.run("agent-lq-junk-replace", "Lqjunkreplace AS", "https://lqjunkreplace.no", "key-2");
      insertAgent.run("agent-lq-junk-locked", "Lqjunklocked AS", "https://lqjunklocked.no", "key-3");
      insertAgent.run("agent-lq-good-email", "Lqgoodemail AS", "https://lqgoodemail.no", "key-4");
      insertAgent.run("agent-lq-empty-email", "Lqemptyemail AS", "https://lqemptyemail.no", "key-5");
      insertAgent.run("agent-lq-junk-same", "Lqjunksame AS", "https://lqjunksame.no", "key-6");

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, about, field_provenance)
         VALUES (?, ?, ?, NULL, NULL, 'A test farm shop', '{}')`,
      );
      // (1) default mode — junk stored email, must NOT be touched.
      insertKnowledge.run("agent-default-junk", "https://defaultjunk.no", "info@example.com");
      // (2) low_quality mode — junk stored email, distinct guarded email on page -> replaced.
      insertKnowledge.run("agent-lq-junk-replace", "https://lqjunkreplace.no", "info@example.com");
      // (3) low_quality mode — junk stored email but curated-locked -> NOT replaced.
      insertKnowledge.run("agent-lq-junk-locked", "https://lqjunklocked.no", "info@example.com");
      // (4) low_quality mode — GOOD (non-junk) stored email -> never downgraded.
      insertKnowledge.run("agent-lq-good-email", "https://lqgoodemail.no", "post@lqgoodemail.no");
      // (5) low_quality mode — empty stored email -> existing fill-if-empty path unchanged.
      insertKnowledge.run("agent-lq-empty-email", "https://lqemptyemail.no", null);
      // (6) low_quality mode — junk stored email but extracted value is identical -> no spurious
      // write. Uses an own-domain "noreply@" address (junk per isJunkEmail's
      // "noreply@" pattern) rather than "info@example.com", so the SAME value
      // also passes isAcceptableHomepageEmail's own-domain guard when it's
      // "extracted" from the page — an aggregator-class placeholder like
      // example.com would never pass that guard, so it couldn't be the
      // "newly extracted" value in the first place.
      insertKnowledge.run("agent-lq-junk-same", "https://lqjunksame.no", "noreply@lqjunksame.no");

      // Curated-field lock on "email" for agent-lq-junk-locked (mirrors the
      // setCuratedFieldLock/getCuratedFields usage pattern already in
      // marketplace.ts at ~line 1060/1066).
      knowledgeService.setCuratedFieldLock("agent-lq-junk-locked", "email", {
        locked_at: new Date().toISOString(),
        by: "test-fixture",
      } as any);

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      // Stub global fetch: return HTML keyed by URL — each page mentions its
      // own producer name (passes the ownership guard) and carries a
      // mailto: link to a distinct, guarded (own-domain) address.
      (globalThis as any).fetch = async (url: string) => {
        let html = "";
        if (url.includes("defaultjunk.no")) {
          html = `<html><head><title>Defaultjunk AS</title></head><body>
            <h1>Defaultjunk AS</h1>
            <a href="mailto:post@defaultjunk.no">post@defaultjunk.no</a>
          </body></html>`;
        } else if (url.includes("lqjunkreplace.no")) {
          html = `<html><head><title>Lqjunkreplace AS</title></head><body>
            <h1>Lqjunkreplace AS</h1>
            <a href="mailto:post@lqjunkreplace.no">post@lqjunkreplace.no</a>
          </body></html>`;
        } else if (url.includes("lqjunklocked.no")) {
          html = `<html><head><title>Lqjunklocked AS</title></head><body>
            <h1>Lqjunklocked AS</h1>
            <a href="mailto:post@lqjunklocked.no">post@lqjunklocked.no</a>
          </body></html>`;
        } else if (url.includes("lqgoodemail.no")) {
          html = `<html><head><title>Lqgoodemail AS</title></head><body>
            <h1>Lqgoodemail AS</h1>
            <a href="mailto:kontakt@lqgoodemail.no">kontakt@lqgoodemail.no</a>
          </body></html>`;
        } else if (url.includes("lqemptyemail.no")) {
          html = `<html><head><title>Lqemptyemail AS</title></head><body>
            <h1>Lqemptyemail AS</h1>
            <a href="mailto:post@lqemptyemail.no">post@lqemptyemail.no</a>
          </body></html>`;
        } else if (url.includes("lqjunksame.no")) {
          // The page's only mailto: is IDENTICAL to the stored (junk) value —
          // exercises the "no spurious write" hygiene case.
          html = `<html><head><title>Lqjunksame AS</title></head><body>
            <h1>Lqjunksame AS</h1>
            <a href="mailto:noreply@lqjunksame.no">noreply@lqjunksame.no</a>
          </body></html>`;
        }
        return {
          ok: true,
          status: 200,
          text: async () => html,
        } as any;
      };

      // ── (1) default mode: junk stored email is NEVER replaced ──────────
      let result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-default-junk"] },
      });
      assertEq(result.status, 200, "default mode POST -> 200");
      let row = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-default-junk") as { email: string | null };
      assertEq(row.email, "info@example.com",
        "agent-default-junk: junk stored email is NEVER replaced outside low_quality mode (default-mode regression guard)");

      // ── (2) low_quality mode: junk stored email replaced by distinct guarded email ──
      result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-lq-junk-replace"], select: "low_quality" },
      });
      assertEq(result.status, 200, "low_quality junk-replace POST -> 200");
      row = db.prepare("SELECT email, field_provenance FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-lq-junk-replace") as { email: string | null; field_provenance: string | null };
      assertEq(row.email, "post@lqjunkreplace.no",
        "agent-lq-junk-replace: junk stored email IS replaced by the newly extracted guarded value under low_quality mode");
      // mergeFieldProvenance's OUTPUT shape is a bare array per field (unlike
      // the wrapped `{ sources: [...] }` shape processAgent's own
      // incomingProv uses on the way IN — see admin-knowledge.ts's
      // mergeFieldProvenance doc comment).
      const prov2 = JSON.parse(row.field_provenance || "{}");
      assertEq(Array.isArray(prov2?.email) && prov2.email.some((s: any) => s.value === "post@lqjunkreplace.no"), true,
        "agent-lq-junk-replace: field_provenance gains the new homepage email source");
      assertEq(result.body?.data?.email_replaced, 1,
        "agent-lq-junk-replace: response's additive email_replaced counter is 1 for this run");

      // ── (3) low_quality mode: curated-locked email — junk, but NOT replaced ──
      result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-lq-junk-locked"], select: "low_quality" },
      });
      assertEq(result.status, 200, "low_quality curated-locked POST -> 200");
      row = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-lq-junk-locked") as { email: string | null };
      assertEq(row.email, "info@example.com",
        "agent-lq-junk-locked: curated_fields locks \"email\" -> NOT replaced despite being junk (absolute guard holds)");

      // ── (4) low_quality mode: GOOD stored email — never downgraded ──────
      result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-lq-good-email"], select: "low_quality" },
      });
      assertEq(result.status, 200, "low_quality good-email POST -> 200");
      row = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-lq-good-email") as { email: string | null };
      assertEq(row.email, "post@lqgoodemail.no",
        "agent-lq-good-email: a real GOOD (non-junk) stored email is NEVER replaced, even in low_quality mode with a distinct extracted email");

      // ── (5) low_quality mode: empty stored email — existing fill-if-empty unchanged ──
      result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-lq-empty-email"], select: "low_quality" },
      });
      assertEq(result.status, 200, "low_quality empty-email POST -> 200");
      row = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-lq-empty-email") as { email: string | null };
      assertEq(row.email, "post@lqemptyemail.no",
        "agent-lq-empty-email: the pre-existing fill-if-empty behavior is unchanged under low_quality mode");
      assertEq(result.body?.data?.email_replaced, 0,
        "agent-lq-empty-email: a fill (not a replace) does not bump the email_replaced counter");

      // ── (6) low_quality mode: junk stored email, extracted value IDENTICAL — no spurious write ──
      result = await callRoute(router, {
        method: "POST",
        url: "/admin/homepage-provenance-batch",
        headers: { "x-admin-key": testKey, "content-type": "application/json" },
        body: { agentIds: ["agent-lq-junk-same"], select: "low_quality" },
      });
      assertEq(result.status, 200, "low_quality junk-same POST -> 200");
      row = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-lq-junk-same") as { email: string | null };
      assertEq(row.email, "noreply@lqjunksame.no",
        "agent-lq-junk-same: extracted value identical to the current (junk) value -> column left as-is, no spurious write");
      assertEq(result.body?.data?.email_replaced, 0,
        "agent-lq-junk-same: no email_replaced count bump when the extracted value equals the current value");
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
  runHomepageProvenanceJunkEmailReplaceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
