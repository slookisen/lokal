/**
 * opplevelser-content-refresh-charset.test.ts — regression tests for
 * crFetchHtml() (src/routes/opplevelser.ts), the fetch helper backing both
 * POST /admin/content-refresh and POST /admin/gardssalg-content-refresh
 * (via crFetchHomepageContent/crFetchGardssalgContent, both of which call
 * crFetchHtml for every page they fetch).
 *
 * Root cause (mirrors the already-shipped fix in fetchHtml(),
 * src/services/search-enrich.ts, PR lokal#360, dev-request 2026-07-21-
 * opplevagent-norske-tegn-encoding): crFetchHtml previously called
 * `resp.text()` directly on the raw fetch Response, which per the WHATWG
 * Fetch spec ALWAYS UTF-8-decodes the response body regardless of what
 * charset the server actually declares. A legacy/small producer site served
 * as windows-1252 or iso-8859-1 (Content-Type header OR a <meta charset>
 * tag) would have every æ/ø/å in its homepage corrupted (mojibake or
 * U+FFFD) the moment it was crawled through either content-refresh route,
 * and that corrupted text was written straight into experiences.description
 * (or the gårdssalg about_text/visit_text fields) with no LLM step to catch
 * it. The fix: crFetchHtml now reads the response as raw bytes
 * (resp.arrayBuffer()) and decodes them with the SAME already-tested
 * detectHtmlCharset()/decodeHtmlBytes() pair fetchHtml() already uses
 * (imported from ../services/search-enrich, not re-implemented).
 *
 * This file exercises the fix end-to-end through the real
 * POST /admin/content-refresh route (mocking globalThis.fetch — repo
 * convention, see opplevelser-gardssalg-content-audit.test.ts block (k)),
 * with a provider seeded via experience-store.createProvider/createExperience
 * (same pattern as opplevelser-content-refresh-no-yield-backoff.test.ts's
 * seedProvider) rather than raw SQL, since /admin/content-refresh writes
 * experiences.description, not experience_providers.about_text.
 *
 * Covers:
 *   (a) a homepage served as windows-1252 (Content-Type charset param) with
 *       an og:description containing æ/ø/å is decoded correctly and the
 *       EXACT original Norwegian text lands in experiences.description —
 *       the reported bug, now fixed.
 *   (b) sanity check — naively UTF-8-decoding those same windows-1252 bytes
 *       (the old resp.text() behavior) does NOT reproduce the original text,
 *       confirming this is a real regression guard, not a vacuous test.
 *   (c) non-regression: a homepage served as plain UTF-8 with NO charset
 *       declared at all (the overwhelming common case for producer sites)
 *       still decodes byte-identically — the fix must not disturb the
 *       existing/default cohort.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/content-refresh";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserContentRefreshCharsetTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = "content-refresh-charset-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function seedProvider(id: string, hjemmeside: string): { providerId: string; experienceId: string } {
        const providerId = store.createProvider({
          navn: `Test Provider ${id}`,
          org_nr: `9100${id.padStart(5, "0")}`,
          fylke: "Troms", kommune: "Tromsø",
          hjemmeside,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        const experienceId = store.createExperience({
          title: `Test Provider ${id} opplevelse`, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        });
        return { providerId, experienceId };
      }

      function getDescription(experienceId: string): string | null {
        const row = expDb.prepare("SELECT description FROM experiences WHERE id = ?").get(experienceId) as
          | { description: string | null }
          | undefined;
        return row?.description ?? null;
      }

      // The actual bug, mirrored from search-enrich.test.ts's own
      // decodeHtmlBytes regression fixture: real, substantive Norwegian prose
      // (clears meetsAboutQualityBar's 80-char + Norwegian-word bar) that
      // contains all three æ/ø/å letters.
      const ORIGINAL_ABOUT =
        "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";

      const win1252 = seedProvider("w", "https://win1252-gard.example");
      const utf8NoHeader = seedProvider("u", "https://utf8-gard.example");

      const win1252Html =
        `<html><head><meta property="og:description" content="${ORIGINAL_ABOUT}"></head>` +
        `<body><p>Velkomen til garden.</p></body></html>`;
      const win1252Bytes = new Uint8Array(Buffer.from(win1252Html, "latin1"));

      const utf8Html =
        `<html><head><meta property="og:description" content="${ORIGINAL_ABOUT}"></head>` +
        `<body><p>Velkomen til garden.</p></body></html>`;
      const utf8Bytes = new Uint8Array(Buffer.from(utf8Html, "utf-8"));

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        const host = new URL(urlStr).hostname;
        if (host === "win1252-gard.example") {
          const u = new URL(urlStr);
          if (u.pathname !== "/") {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
          }
          return {
            ok: true, status: 200,
            arrayBuffer: async () => win1252Bytes.buffer,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=windows-1252" : null) },
          } as unknown as Response;
        }
        if (host === "utf8-gard.example") {
          const u = new URL(urlStr);
          if (u.pathname !== "/") {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
          }
          // No charset declared anywhere (no header param, no <meta charset>)
          // — the overwhelming common case; decodeHtmlBytes must default utf-8.
          return {
            ok: true, status: 200,
            arrayBuffer: async () => utf8Bytes.buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch;

      const res = await callRoute(opplevelserRouter, {
        url: "/admin/content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: [win1252.providerId, utf8NoHeader.providerId], apply: true },
      });
      assertEq(res.status, 200, "charset-1: POST /admin/content-refresh -> 200");

      // ── (a) windows-1252 homepage decodes to the EXACT original text ──────
      const descW = getDescription(win1252.experienceId);
      assertEq(
        descW,
        ORIGINAL_ABOUT,
        "charset-2: windows-1252 producer homepage's æ/ø/å description is decoded correctly via crFetchHtml (the reported bug, now fixed)",
      );

      // ── (b) sanity: the old resp.text()-forces-UTF-8 behavior on the SAME
      //    bytes would NOT reproduce the original text — proves this guards a
      //    real regression, not a vacuous no-op test. ────────────────────────
      assertTrue(
        new TextDecoder("utf-8").decode(win1252Bytes) !== ORIGINAL_ABOUT,
        "charset-3: sanity check — naive UTF-8 decode of the windows-1252 bytes does NOT match the original (confirms the bug this guards)",
      );

      // ── (c) non-regression: plain UTF-8, no charset declared anywhere ─────
      const descU = getDescription(utf8NoHeader.experienceId);
      assertEq(
        descU,
        ORIGINAL_ABOUT,
        "charset-4: plain UTF-8 homepage (no charset header/meta at all) still decodes byte-identically — no regression for the common case",
      );

      // Neither stored description carries mojibake/replacement-character
      // corruption (belt-and-suspenders on top of the exact-match checks
      // above).
      assertTrue(!!descW && !descW.includes("�"), "charset-5: windows-1252 description contains no U+FFFD replacement characters");
      assertTrue(!!descU && !descU.includes("�"), "charset-6: utf-8 description contains no U+FFFD replacement characters");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-charset: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-charset.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshCharsetTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
