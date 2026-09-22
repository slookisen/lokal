/**
 * admin-field-spot-check.test.ts — tests POST /admin/field-spot-check
 * (dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
 * point 2 fix-up / B3): the thin HTTP wrapper around computeFieldSpotCheck()
 * (src/agents/lokal-agent-verifier.ts) that gives the weekly field-
 * verification SKILL an actual endpoint to call.
 *
 * Mirrors admin-phone-context-gate-retro-scan.test.ts's harness conventions
 * (in-memory DB via __setDbForTesting/__initSchemaForTesting, router
 * exercised directly via router.handle, globalThis.fetch stubbing for the
 * homepage re-fetch).
 *
 * Coverage:
 *   1. Auth: missing/wrong X-Admin-Key -> 403; admin not configured -> 503.
 *   2. Request shape: missing agent_id -> 400; missing field_name -> 400;
 *      unsupported field_name -> 400; unknown agent_id -> 404; no
 *      homepage_url on file -> 400.
 *   3. End-to-end: a field found one level deep on a discovered subpage
 *      (the Vollan Gård repro shape computeFieldSpotCheck's own unit tests
 *      exercise at the function level) -> 200, status "match", checked_url
 *      stamped to the subpage, NOT the root.
 *
 * Exported runAdminFieldSpotCheckTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-field-spot-check.test.ts
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
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
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
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

function htmlResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    url: "",
    headers: { get: () => null } as unknown as Headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  } as unknown as Response;
}

export async function runAdminFieldSpotCheckTests(
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

  const prevDb = initMod.getDb();
  const testKey = process.env.ADMIN_KEY || "field-spot-check-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;
  const prevFetch = (globalThis as any).fetch;

  const db = new Database(":memory:");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
       VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
    );
    const insertKnowledge = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, website, about, phone, verification_status, curated_fields)
       VALUES (?, ?, ?, ?, 'verified', '{}')`,
    );

    const ABOUT = "Vollan Gård er en liten familiedrevet gård med sauer og geiter på Innherred.";

    // fsc-vollan: about text is NOT on the root page, only on /om-oss —
    // exact shape computeFieldSpotCheck's own unit tests exercise, here
    // driven through the HTTP route end-to-end.
    insertAgent.run("fsc-vollan", "Vollan Gård", "https://vollangaard.no/", "key-fsc-vollan");
    insertKnowledge.run("fsc-vollan", "https://vollangaard.no/", ABOUT, null);

    // fsc-no-homepage: no website on file at all (agents.url is NOT NULL in
    // the schema, so "" is the blank sentinel, same as every other call
    // site's homepage_url resolution in this codebase) -> 400, not a crash.
    insertAgent.run("fsc-no-homepage", "Ingen Nettside Gård", "", "key-fsc-no-homepage");
    insertKnowledge.run("fsc-no-homepage", null, "Noe tekst", null);

    (globalThis as any).fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://vollangaard.no/") {
        return htmlResponse(
          200,
          '<html><body><h1>Vollan Gård</h1><p>Velkommen til gården vår!</p>' +
          '<nav><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a></nav></body></html>',
        );
      }
      if (u === "https://vollangaard.no/om-oss") {
        return htmlResponse(200, `<html><body><h1>Om oss</h1><p>${ABOUT}</p></body></html>`);
      }
      return htmlResponse(404, "not found");
    }) as unknown as typeof fetch;

    delete require.cache[require.resolve("./admin-field-spot-check")];
    const routeMod = require("./admin-field-spot-check");
    const router = routeMod.default;

    // ── Auth: admin not configured (no ADMIN_KEY/ANALYTICS_ADMIN_KEY at
    //    all) -> 503, checked BEFORE the X-Admin-Key comparison. ──────
    const savedAdminKey = process.env.ADMIN_KEY;
    const savedAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    const notConfiguredResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "about" },
    });
    assertEq(notConfiguredResult.status, 503, "auth-00: no ADMIN_KEY/ANALYTICS_ADMIN_KEY configured at all -> 503");
    if (savedAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = savedAdminKey;
    if (savedAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = savedAnalyticsAdminKey;

    // ── Auth ──────────────────────────────────────────────────────────
    const noKeyResult = await callRoute(router, {
      url: "/",
      headers: { "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "about" },
    });
    assertEq(noKeyResult.status, 403, "auth-01: missing X-Admin-Key -> 403");

    const wrongKeyResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": "wrong-key", "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "about" },
    });
    assertEq(wrongKeyResult.status, 403, "auth-02: wrong X-Admin-Key -> 403");

    // ── Request shape ────────────────────────────────────────────────
    const missingAgentIdResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { field_name: "about" },
    });
    assertEq(missingAgentIdResult.status, 400, "shape-01: missing agent_id -> 400");

    const missingFieldNameResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-vollan" },
    });
    assertEq(missingFieldNameResult.status, 400, "shape-02: missing field_name -> 400");

    const unsupportedFieldResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "not_a_real_field" },
    });
    assertEq(unsupportedFieldResult.status, 400, "shape-03: unsupported field_name -> 400");

    const unknownAgentResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "does-not-exist", field_name: "about" },
    });
    assertEq(unknownAgentResult.status, 404, "shape-04: unknown agent_id -> 404");

    const noHomepageResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-no-homepage", field_name: "about" },
    });
    assertEq(noHomepageResult.status, 400, "shape-05: no homepage_url on file -> 400 (never crashes / never fetches)");

    // ── End-to-end: Vollan Gård repro through the HTTP route ───────────
    const e2eResult = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "about" },
    });
    assertEq(e2eResult.status, 200, "e2e-01: valid request -> 200");
    assertEq(e2eResult.body?.success, true, "e2e-02: success:true");
    assertEq(e2eResult.body?.status, "match", "e2e-03: about text found one level deep on /om-oss -> match, not mismatch");
    assertEq(e2eResult.body?.checked_url, "https://vollangaard.no/om-oss", "e2e-04: checked_url stamped to /om-oss, NOT the root");
    assertEq(e2eResult.body?.field_value, ABOUT, "e2e-05: field_value echoes the CURRENTLY STORED about text resolved server-side");
    assertEq(e2eResult.body?.root_url, "https://vollangaard.no/", "e2e-06: root_url resolved from agent_knowledge.website");
    assertEq(
      e2eResult.body?.urls_tried,
      ["https://vollangaard.no/", "https://vollangaard.no/om-oss"],
      "e2e-07: urls_tried reports root fetched first, then the one subpage that actually matched",
    );
  } catch (err: any) {
    failed++;
    failures.push("admin-field-spot-check: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (globalThis as any).fetch = prevFetch;
    initMod.__setDbForTesting(prevDb as any);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    delete require.cache[require.resolve("./admin-field-spot-check")];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminFieldSpotCheckTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
