/**
 * admin-knowledge-website-write-guard.test.ts — tests for the new
 * website-candidate junk-shape backstop wired into PUT /admin/knowledge
 * (routes/admin-knowledge.ts; dev-request 2026-08-22-rfbweb-about-guard).
 *
 * `agent_knowledge.website` had NO extraction guard at all before this
 * slice — this is the enrichment SKILL's own write surface (PUT
 * /admin/knowledge, populated during the Phase 2D crawl), and every other
 * factual column (about/address/phone) at least reaches the pre-existing
 * orch-pr-17 correct-not-just-add gate for an OVERWRITE; `website` never did
 * and never had a junk-shape backstop either.
 *
 * Setup mirrors homepage-content-refresh-parking.test.ts's harness:
 * better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting (the
 * shared getDb() singleton, restored in `finally` — this route reads getDb()
 * directly, unlike admin-agents-url-write.ts's own per-call DB seam), the
 * default-exported router driven through router.handle() with a fake
 * req/res — no HTTP, no network (the classifier this route calls is pure,
 * no LLM judge is reachable from this write site — see the route's own
 * comment on why).
 *
 * Covers:
 *   (a) a junk website candidate (favicon path, App Store host, CSS-hex
 *       string) is silently dropped from the write set — NOT written, NOT a
 *       400/error — and surfaced back as `website_rejected_reason`
 *   (b) a normal, legitimate website candidate is written exactly as before
 *       (no regression)
 *   (c) an empty string ("clear the website") is NEVER treated as junk —
 *       it skips the classifier entirely, same as before this slice
 *   (d) a junk website candidate never blocks the REST of the same call's
 *       column writes (about/phone/etc. still get written)
 *   (e) `website_rejected_reason` is ABSENT (not present with any value,
 *       including null) on an ordinary call that never touched website
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
      method: opts.method || "PUT",
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

export function runAdminKnowledgeWebsiteWriteGuardTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-knowledge-website-guard-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
         VALUES (?, ?, 'test agent', 'test', 'post@example.no', '', 'producer', ?, 'rfb')`,
      );
      insertAgent.run("akw-01", "Test Gård AS", "key-akw-01");
      insertAgent.run("akw-02", "Test Gård To AS", "key-akw-02");
      insertAgent.run("akw-03", "Test Gård Tre AS", "key-akw-03");
      insertAgent.run("akw-04", "Test Gård Fire AS", "key-akw-04");
      insertAgent.run("akw-05", "Test Gård Fem AS", "key-akw-05");

      delete require.cache[require.resolve("./admin-knowledge")];
      const routeMod = require("./admin-knowledge");
      const router = routeMod.default;

      function put(body: any): Promise<RouteResult> {
        return callRoute(router, {
          method: "PUT",
          url: "/",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }
      function websiteOf(agentId: string): string | null {
        const row = db.prepare(`SELECT website FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
          | { website: string | null }
          | undefined;
        return row?.website ?? null;
      }
      function aboutOf(agentId: string): string | null {
        const row = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
          | { about: string | null }
          | undefined;
        return row?.about ?? null;
      }

      // ── (a) junk website candidates dropped, surfaced, never written ────
      let r = await put({ agent_id: "akw-01", website: "https://akw-01.no/favicon.ico" });
      assertEq(r.status, 200, "akw-01a: junk website candidate -> 200 (never a 400/error)");
      assertEq(r.body?.success, true, "akw-01b: response still reports success:true");
      assertTrue(!!r.body?.website_rejected_reason && /favicon|icon/i.test(r.body.website_rejected_reason), "akw-01c: response carries website_rejected_reason naming the favicon/icon shape");
      assertEq(websiteOf("akw-01"), null, "akw-01d: website column left untouched (never written)");
      assertTrue(!(r.body?.columns_updated ?? []).includes("website"), "akw-01e: 'website' absent from columns_updated");

      r = await put({ agent_id: "akw-01", website: "https://apps.apple.com/no/app/testgard/id1234567890" });
      assertTrue(!!r.body?.website_rejected_reason && /app store|play store/i.test(r.body.website_rejected_reason), "akw-02: App Store listing URL -> rejected, reason names the shape");
      assertEq(websiteOf("akw-01"), null, "akw-03: still untouched");

      r = await put({ agent_id: "akw-01", website: "#3a7d44" });
      assertTrue(!!r.body?.website_rejected_reason && /hex|tailwind|css/i.test(r.body.website_rejected_reason), "akw-04: bare CSS hex-color string -> rejected, reason names the shape");
      assertEq(websiteOf("akw-01"), null, "akw-05: still untouched");

      // ── (b) a normal, legitimate website candidate is written unchanged ──
      r = await put({ agent_id: "akw-02", website: "https://ekte-testgard.no" });
      assertEq(r.status, 200, "akw-06: normal website write -> 200");
      assertEq(r.body?.website_rejected_reason, undefined, "akw-07: no rejection reason for a clean candidate");
      assertEq(websiteOf("akw-02"), "https://ekte-testgard.no", "akw-08: website column actually written");
      assertTrue((r.body?.columns_updated ?? []).includes("website"), "akw-09: 'website' present in columns_updated");

      // ── (c) empty string (clear) is never junk — unaffected by this slice ─
      r = await put({ agent_id: "akw-02", website: "" });
      assertEq(r.body?.website_rejected_reason, undefined, "akw-10: clearing the website never triggers a rejection");
      assertEq(websiteOf("akw-02"), "", "akw-11: website actually cleared to '' (not blocked by the new guard)");

      // ── (d) a junk website candidate never blocks the REST of the call ──
      r = await put({
        agent_id: "akw-03",
        website: "https://akw-03.no/apple-touch-icon.png",
        about: "Vi produserer ekte gårdshonning fra egne bikuber.",
      });
      assertTrue(!!r.body?.website_rejected_reason, "akw-12: website candidate rejected");
      assertEq(websiteOf("akw-03"), null, "akw-13: website left untouched");
      assertEq(aboutOf("akw-03"), "Vi produserer ekte gårdshonning fra egne bikuber.", "akw-14: about STILL written in the SAME call — one field's rejection does not block a sibling field");
      assertTrue((r.body?.columns_updated ?? []).includes("about"), "akw-15: 'about' present in columns_updated even though 'website' was dropped");
      assertTrue(!(r.body?.columns_updated ?? []).includes("website"), "akw-16: 'website' absent from columns_updated");

      // ── (e) website_rejected_reason ABSENT on a call that never touched website ─
      r = await put({ agent_id: "akw-04", about: "En helt vanlig oppdatering uten nettside-felt." });
      assertTrue(!Object.prototype.hasOwnProperty.call(r.body ?? {}, "website_rejected_reason"), "akw-17: website_rejected_reason key entirely ABSENT (not present-with-null) when website was never provided");

      // Negative control: a real subpage of a real domain must not be
      // mistaken for a favicon path merely because it has a file-looking
      // final segment — same specificity guarantee as the pure classifier's
      // own unit tests.
      r = await put({ agent_id: "akw-05", website: "https://ekte-testgard.no/produkter/bilde.png" });
      assertEq(r.body?.website_rejected_reason, undefined, "akw-18: an ordinary image-path URL (not a known favicon/icon basename) is NOT flagged");
      assertEq(websiteOf("akw-05"), "https://ekte-testgard.no/produkter/bilde.png", "akw-19: ...and actually written");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminKnowledgeWebsiteWriteGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
