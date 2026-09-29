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
import * as dbFactory from "../database/db-factory";

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
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;

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

    // Dental fallback fixtures: fresh in-memory dental DB (real production
    // dental schema via db-factory), separate from the RFB db above.
    process.env.DENTAL_DB_PATH = ":memory:";
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const insertDental = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, adresse, om_oss) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertDental.run("dental-ok", "Tannlege Test", "https://tannlege-test.no/", "+47 41 63 44 22", "Storgata 1", null);
    insertDental.run("dental-about", "Tannlege Om Oss", "https://tannlege-test.no/", null, null, "Klinikk i Oslo sentrum");
    insertDental.run("dental-nohp", "Tannlege Uten Nett", null, "22334455", null, null);

    (globalThis as any).fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "https://tannlege-test.no/") {
        return htmlResponse(200, "<html><body><p>Ring oss: 41 63 44 22</p></body></html>");
      }
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

    // ── Phone normalization (pure) ────────────────────────────────────
    const phoneOk = (stored: string, page: string) =>
      routeMod.checkPhoneSubstantiatedBySource(stored, page).substantiated;
    assertEq(phoneOk("+47 41 63 44 22", "<p>Ring: 41634422</p>"), true, "phone-01: +47 41 63 44 22 vs 41634422 -> match");
    assertEq(phoneOk("+47 482 60 494", "Tlf 48260494"), true, "phone-02: +47 482 60 494 vs 48260494 -> match");
    assertEq(phoneOk("+47 90583186", "Telefon: 905 83 186"), true, "phone-03: +47 90583186 vs 905 83 186 -> match");
    assertEq(phoneOk("+47 97 18 45 15", "Mobil 97 18 45 15 "), true, "phone-04: +47 97 18 45 15 vs 97 18 45 15 -> match");
    assertEq(phoneOk("41634422", "tel:+4741634422"), true, "phone-05: country-code prefixed run on page -> match");
    assertEq(phoneOk("+47 41 63 44 22", "Ring 41 63 44 23"), false, "phone-06: different number -> mismatch");
    assertEq(phoneOk("+47 41 63 44 22", "id 9941634422 og 416344221"), false, "phone-07: embedded in longer digit run -> mismatch");
    assertEq(routeMod.normalizePhoneToNationalDigits("0047 41 63 44 22"), "41634422", "phone-08: 0047 prefix stripped");
    assertEq(routeMod.normalizePhoneToNationalDigits("12345"), null, "phone-09: non-8-digit -> null");
    assertEq(
      routeMod.checkPhoneSubstantiatedBySource("12345", "ring 12345 nå").substantiated,
      routeMod.checkPhoneSubstantiatedBySource("12345", "ring 12345 nå").substantiated,
      "phone-10: non-8-digit falls back to text check (no throw)",
    );
    assertEq(
      routeMod.checkPhoneSubstantiatedBySource("12345", "ring 12345 nå").reason,
      require("../services/about-source-substantiation").checkAboutCandidateSubstantiatedBySource("12345", "ring 12345 nå").reason,
      "phone-11: non-8-digit fallback equals standard text check verdict",
    );

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

    // ── Dental fallback (dev-request 2026-09-28-dental-field-spot-check-404) ──
    const dentalOk = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "dental-ok", field_name: "phone" },
    });
    assertEq(dentalOk.status, 200, "dental-01: dental id resolves via dental_agents -> 200, not 404");
    assertEq(dentalOk.body?.status, "match", "dental-02: telefon compared against hjemmeside page -> match");
    assertEq(dentalOk.body?.root_url, "https://tannlege-test.no/", "dental-03: root_url from dental_agents.hjemmeside");
    assertEq(dentalOk.body?.field_value, "+47 41 63 44 22", "dental-04: field_value from dental_agents.telefon");

    const dentalMismatch = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "dental-ok", field_name: "address" },
    });
    assertEq(dentalMismatch.status, 200, "dental-05: address field on dental id -> 200");
    assertEq(dentalMismatch.body?.status, "unverifiable", "dental-06: adresse not on (thin) page -> unverifiable, existing comparison logic verdict");

    const dentalAbout = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "dental-about", field_name: "about" },
    });
    assertEq(dentalAbout.status, 200, "dental-12: about field on dental id -> 200");
    assertEq(dentalAbout.body?.field_value, "Klinikk i Oslo sentrum", "dental-13: about field_value from dental_agents.om_oss (not navn)");

    const dentalNoHp = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "dental-nohp", field_name: "phone" },
    });
    assertEq(dentalNoHp.status, 400, "dental-07: dental with no hjemmeside -> existing 'no homepage_url' 400 path");
    assertEq(/no homepage_url on file/.test(String(dentalNoHp.body?.error)), true, "dental-08: error text names no homepage_url");

    const neitherTable = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "in-neither-table", field_name: "phone" },
    });
    assertEq(neitherTable.status, 404, "dental-09: id in neither agents nor dental_agents -> 404");

    const rfbStill = await callRoute(router, {
      url: "/",
      headers: { "x-admin-key": testKey, "content-type": "application/json" },
      body: { agent_id: "fsc-vollan", field_name: "about" },
    });
    assertEq(rfbStill.body?.status, "match", "dental-10: RFB id unaffected by dental fallback");
    assertEq(rfbStill.body?.root_url, "https://vollangaard.no/", "dental-11: RFB root_url still from agent_knowledge");
  } catch (err: any) {
    failed++;
    failures.push("admin-field-spot-check: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (globalThis as any).fetch = prevFetch;
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    dbFactory.__resetDbFactoryForTesting();
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
