/**
 * opplevelser-content-refresh-errors-by-persistence.test.ts — tests for
 * dev-request 2026-08-02-enrichment-kadens-og-kildekvalitet, AC3-slice:
 * "strukturert persistence-signal i content-refresh (permanent/transient/
 * blocked)". POST /admin/content-refresh and POST /admin/gardssalg-content-
 * refresh (src/routes/opplevelser.ts) already read fetched.persistence
 * correctly to gate PARKING strikes (`apply && fetched.persistence !==
 * "transient"` — untouched by this slice, see part 5 below). What was
 * missing: `persistence` was only ever embedded inside the free-text
 * `error` string (`fetch_failed:${reason} (${persistence}) for ${url}`) —
 * never as a structured field an external consumer could tally without
 * string-parsing.
 *
 * This file proves the additive fix on BOTH routes:
 *   1. Three synthetic fetch outcomes (permanent/transient/blocked) each
 *      produce one errors[] entry whose `persistence` field matches, and
 *      the response's new `errors_by_persistence` object tallies
 *      {permanent:1, transient:1, blocked:1, internal:0} for that call.
 *   2. The pre-existing `errors[].error` string format is BYTE-IDENTICAL to
 *      before this slice (explicit regression assertion, not just "other
 *      tests still pass").
 *   3. The parking call pattern (`apply && persistence !== "transient"`) is
 *      unchanged: permanent/blocked failures strike
 *      (homepage_fetch_attempts increments), transient does not. Neither
 *      route had its own dedicated parking-behavior test before this file
 *      (the existing homepage-content-refresh-parking.test.ts covers a
 *      DIFFERENT route, routes/admin-knowledge.ts) — this closes that gap
 *      for these two routes specifically, using the SAME assertions as
 *      before this slice (nothing about the parking logic itself changed).
 *   4. The two "our own bug, not the site's fault" branches — the
 *      fetch-throws catch block, and the write_failed branch — tag
 *      `persistence: "internal"` and are counted under
 *      errors_by_persistence.internal.
 *
 * On (4)'s fetch-throws branch: crFetchHomepageContent/crFetchGardssalgContent
 * only ever reach that catch if `fetchPage()` (services/fetch-page.ts)
 * itself throws — and fetchPage's own contract, verified by reading its
 * source, is "Never throws, never returns a bare null": every call it makes
 * (network fetch, arrayBuffer(), decodeHtmlBytes) is already wrapped in its
 * own try/catch or safe-by-construction. There is therefore no REACHABLE
 * external input (malformed URL, weird HTTP response, network error) that
 * trips this catch today — it is deliberately defensive code for a
 * hypothetical future bug, per the route's own comment ("fetchPage() never
 * throws ... reaching this catch means an INTERNAL fault on our side").
 * To exercise it honestly (without monkeypatching an internal module, which
 * this codebase's esbuild/tsx toolchain does not even allow — imported
 * bindings are not late-bound), this file makes global.fetch throw a
 * "poisoned" Error whose `.cause` getter itself throws. classifyFetchError()
 * (fetch-page.ts) unconditionally reads `err?.cause?.code` with no try/catch
 * of its own around that read, from INSIDE fetchPage's own catch block — so
 * a poisoned `.cause` getter escapes fetchPage entirely undexpectedly,
 * proving the outer route's defensive catch really does what its comment
 * says for ANY unexpected exception, not just the ones the classifier
 * anticipates.
 *
 * Harness matches opplevelser-content-refresh-website-verification-gate.
 * test.ts / opplevelser-gardssalg-owner-lock-content-refresh.test.ts:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router, router.handle() exercised directly
 * (no HTTP server), globalThis.fetch mocked.
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

/**
 * An Error whose `.cause` getter itself throws when read — used to prove
 * the fetch-throws catch block in opplevelser.ts handles ANY unexpected
 * exception escaping the fetch layer, not only the ones classifyFetchError
 * anticipates. See this file's top comment for the full mechanism.
 */
function makePoisonNetworkError(): Error {
  const err = new Error("poison-network-error: should never be read via message");
  Object.defineProperty(err, "cause", {
    configurable: true,
    get() {
      throw new TypeError("simulated malformed error object: .cause access itself throws");
    },
  });
  return err;
}

export function runOpplevelserContentRefreshErrorsByPersistenceTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply routes under test read enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
  let restoreMainDb: (() => void) | null = null;

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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "content-refresh-errors-by-persistence-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-errors-by-persistence";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function verifiedProvenance(): string {
        return JSON.stringify({
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
        });
      }

      // ── /admin/content-refresh fixtures (experiences table) ────────────
      function seedCrProvider(id: string, hjemmeside: string): { providerId: string; experienceId: string } {
        const providerId = store.createProvider({
          navn: `CR Provider ${id}`,
          org_nr: `9100${id.padStart(5, "0")}`,
          fylke: "Troms", kommune: "Tromsø",
          hjemmeside,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        db.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(verifiedProvenance(), providerId);
        // Title shares a significant token ("gårdsbutikk") with ABOUT_TEXT
        // below — required since the faithfulness-inflow slice's homepage-
        // boilerplate guard (dev-request 2026-06-23-experiences-richer-
        // profiles, 2026-08-25); this file tests error-persistence tallies,
        // not that guard, and the write-fail trigger fixture needs the
        // description write to actually be ATTEMPTED to raise its error.
        const experienceId = store.createExperience({
          title: `Gårdsbutikk CR ${id}`, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        });
        return { providerId, experienceId };
      }

      function crAttempts(providerId: string): number {
        return (db.prepare("SELECT homepage_fetch_attempts FROM experience_providers WHERE id = ?").get(providerId) as { homepage_fetch_attempts: number }).homepage_fetch_attempts;
      }

      const crPermanent = seedCrProvider("perm", "https://cr-permanent-a.example");
      const crTransient = seedCrProvider("trans", "https://cr-transient-a.example");
      const crBlocked = seedCrProvider("block", "https://cr-blocked-a.example");
      const crInternalThrow = seedCrProvider("ithrow", "https://cr-internal-throw-a.example");
      const crWriteFail = seedCrProvider("wfail", "https://cr-write-fail-a.example");

      // Trigger scoped to exactly ONE experience row (the write-fail
      // fixture's own id) — the SELECT in getExperiencesForProvider is
      // completely unaffected; only an UPDATE targeting this specific row
      // aborts. Mirrors opplevelser-gardssalg-address-enrichment.test.ts's
      // (o) block's DROP-TABLE technique in spirit (force the real writer's
      // own statement to throw), adapted here because applyExperienceContent
      // (unlike applyGardssalgProviderContent) writes with a single bare
      // UPDATE, no side audit table to drop instead.
      db.exec(`
        CREATE TRIGGER cr_force_write_fail
        BEFORE UPDATE ON experiences
        WHEN NEW.id = '${crWriteFail.experienceId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced write failure for AC3 persistence test');
        END;
      `);

      const ABOUT_TEXT =
        "Vi driver en liten gårdsbutikk med egne grønnsaker, bær og syltetøy rett fra tunet hver helg om sommeren.";
      const goodHtml = `<html><head><meta property="og:description" content="${ABOUT_TEXT}"></head><body></body></html>`;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "cr-permanent-a.example") {
          const err: any = new Error("getaddrinfo ENOTFOUND cr-permanent-a.example");
          err.cause = { code: "ENOTFOUND" };
          throw err;
        }
        if (host === "cr-transient-a.example") {
          const err: any = new Error("connect ECONNREFUSED");
          err.cause = { code: "ECONNREFUSED" };
          throw err;
        }
        if (host === "cr-blocked-a.example") {
          return { status: 401, statusText: "Unauthorized", headers: { get: () => null } } as unknown as Response;
        }
        if (host === "cr-internal-throw-a.example") {
          throw makePoisonNetworkError();
        }
        if (host === "cr-write-fail-a.example") {
          return {
            ok: true, status: 200,
            arrayBuffer: async () => new TextEncoder().encode(goodHtml).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        throw new Error(`content-refresh errors-by-persistence test: unexpected fetch host "${host}"`);
      }) as typeof fetch;

      // ═══════════════════════════════════════════════════════════════════
      // (A1) three synthetic outcomes -> errors[].persistence + tally
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [crPermanent.providerId, crTransient.providerId, crBlocked.providerId], apply: true },
        });
        assertEq(r.status, 200, "cr-a1: three-outcome call -> 200");
        assertEq(r.body.errors.length, 3, "cr-a2: three errors[] entries, one per target");

        const permEntry = r.body.errors.find((e: any) => e.provider_id === crPermanent.providerId);
        const transEntry = r.body.errors.find((e: any) => e.provider_id === crTransient.providerId);
        const blockEntry = r.body.errors.find((e: any) => e.provider_id === crBlocked.providerId);
        assertTrue(!!permEntry && !!transEntry && !!blockEntry, "cr-a3: all three provider ids present in errors[]");

        assertEq(permEntry.persistence, "permanent", "cr-a4: dns_not_found -> persistence 'permanent'");
        assertEq(transEntry.persistence, "transient", "cr-a5: conn_refused -> persistence 'transient'");
        assertEq(blockEntry.persistence, "blocked", "cr-a6: http_401 -> persistence 'blocked'");

        // (A2) error string format is BYTE-IDENTICAL to before this slice —
        // `fetch_failed:${reason} (${persistence}) for ${hjemmeside}`.
        assertEq(
          permEntry.error,
          `fetch_failed:dns_not_found (permanent) for https://cr-permanent-a.example`,
          "cr-a7: permanent error string format unchanged",
        );
        assertEq(
          transEntry.error,
          `fetch_failed:conn_refused (transient) for https://cr-transient-a.example`,
          "cr-a8: transient error string format unchanged",
        );
        assertEq(
          blockEntry.error,
          `fetch_failed:http_401 (blocked) for https://cr-blocked-a.example`,
          "cr-a9: blocked error string format unchanged",
        );

        assertEq(
          r.body.errors_by_persistence,
          { permanent: 1, transient: 1, blocked: 1, internal: 0 },
          "cr-a10: errors_by_persistence tallies {permanent:1, transient:1, blocked:1, internal:0}",
        );

        // (A3) parking pattern unchanged: permanent/blocked strike, transient
        // does not — same `apply && persistence !== "transient"` gate as
        // before this slice, untouched by it.
        assertEq(crAttempts(crPermanent.providerId), 1, "cr-a11: permanent failure DOES strike homepage_fetch_attempts");
        assertEq(crAttempts(crBlocked.providerId), 1, "cr-a12: blocked failure DOES strike homepage_fetch_attempts");
        assertEq(crAttempts(crTransient.providerId), 0, "cr-a13: transient failure does NOT strike homepage_fetch_attempts");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (A4a) internal — fetch throws (poisoned .cause getter)
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [crInternalThrow.providerId], apply: true },
        });
        assertEq(r.status, 200, "cr-b1: fetch-throws call -> 200, not a 500 (route's own catch handles it)");
        assertEq(r.body.errors.length, 1, "cr-b2: exactly one errors[] entry");
        assertEq(r.body.errors[0].provider_id, crInternalThrow.providerId, "cr-b3: entry is for the fetch-throws provider");
        assertEq(r.body.errors[0].persistence, "internal", "cr-b4: fetch-throws branch tags persistence 'internal'");
        assertEq(
          r.body.errors_by_persistence,
          { permanent: 0, transient: 0, blocked: 0, internal: 1 },
          "cr-b5: errors_by_persistence counts it under internal, nothing else",
        );
        // No parking strike for an internal fault — our own bug is no
        // evidence the producer's site is dead (unchanged from before this
        // slice; the route's own comment says so explicitly).
        assertEq(crAttempts(crInternalThrow.providerId), 0, "cr-b6: an internal fault does NOT strike homepage_fetch_attempts");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (A4b) internal — write_failed (forced by the scoped UPDATE trigger)
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [crWriteFail.providerId], apply: true },
        });
        assertEq(r.status, 200, "cr-c1: write-fail call -> 200, not a 500");
        assertEq(r.body.errors.length, 1, "cr-c2: exactly one errors[] entry");
        const entry = r.body.errors[0];
        assertEq(entry.provider_id, crWriteFail.providerId, "cr-c3: entry is for the write-fail provider");
        assertEq(entry.persistence, "internal", "cr-c4: write_failed branch tags persistence 'internal'");
        assertTrue(
          typeof entry.error === "string" && entry.error.startsWith(`write_failed ${crWriteFail.experienceId}:`),
          "cr-c5: error string keeps its pre-existing 'write_failed <id>: ...' format",
        );
        assertEq(
          r.body.errors_by_persistence,
          { permanent: 0, transient: 0, blocked: 0, internal: 1 },
          "cr-c6: errors_by_persistence counts it under internal",
        );
        const row = db.prepare("SELECT description FROM experiences WHERE id = ?").get(crWriteFail.experienceId) as { description: string | null };
        assertEq(row.description, null, "cr-c7: the aborted transaction wrote nothing — description stays blank");
      }

      // ═══════════════════════════════════════════════════════════════════
      // Section B — /admin/gardssalg-content-refresh (mirror-image coverage)
      // ═══════════════════════════════════════════════════════════════════
      const insertGsProviderStmt = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, NULL, NULL, NULL, NULL, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      function seedGsProvider(id: string, hjemmeside: string): string {
        insertGsProviderStmt.run({ id, navn: `GS Provider ${id}`, hjemmeside, field_provenance: verifiedProvenance() });
        return id;
      }

      function gsAttempts(providerId: string): number {
        return (db.prepare("SELECT homepage_fetch_attempts FROM experience_providers WHERE id = ?").get(providerId) as { homepage_fetch_attempts: number }).homepage_fetch_attempts;
      }

      const gsPermanent = seedGsProvider("gs-perm", "https://gs-permanent-b.example");
      const gsTransient = seedGsProvider("gs-trans", "https://gs-transient-b.example");
      const gsBlocked = seedGsProvider("gs-block", "https://gs-blocked-b.example");
      const gsInternalThrow = seedGsProvider("gs-ithrow", "https://gs-internal-throw-b.example");
      const gsWriteFail = seedGsProvider("gs-wfail", "https://gs-write-fail-b.example");

      // gardssalg-content-refresh's writer (applyGardssalgProviderContent)
      // wraps its UPDATE + an INSERT INTO gardssalg_content_audit inside one
      // db.transaction() — dropping the audit table makes that whole
      // transaction (including the UPDATE) throw and roll back. Exact same
      // technique already proven in
      // opplevelser-gardssalg-address-enrichment.test.ts's (o) block for the
      // sibling address-enrichment writer.
      db.exec("DROP TABLE gardssalg_content_audit");

      function gsHtmlFor(host: string): string {
        const about = `${host} gård ligger idyllisk til på bygda og driver med økologisk dyrking av grønnsaker og bær hele sesongen.`;
        const visit = `Besøkende er velkomne til gårdsbutikken hos ${host} for å handle ferske varer rett fra jordet, åpent i helgene.`;
        return `<html><head><meta property="og:description" content="${about}"></head><body><p>${visit}</p></body></html>`;
      }

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "gs-permanent-b.example") {
          const err: any = new Error("getaddrinfo ENOTFOUND gs-permanent-b.example");
          err.cause = { code: "ENOTFOUND" };
          throw err;
        }
        if (host === "gs-transient-b.example") {
          const err: any = new Error("connect ECONNREFUSED");
          err.cause = { code: "ECONNREFUSED" };
          throw err;
        }
        if (host === "gs-blocked-b.example") {
          return { status: 401, statusText: "Unauthorized", headers: { get: () => null } } as unknown as Response;
        }
        if (host === "gs-internal-throw-b.example") {
          throw makePoisonNetworkError();
        }
        if (host === "gs-write-fail-b.example") {
          const html = gsHtmlFor(host);
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ═══════════════════════════════════════════════════════════════════
      // (B1) three synthetic outcomes -> errors[].persistence + tally
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [gsPermanent, gsTransient, gsBlocked], apply: true },
        });
        assertEq(r.status, 200, "gs-a1: three-outcome call -> 200");
        assertEq(r.body.errors.length, 3, "gs-a2: three errors[] entries, one per target");

        const permEntry = r.body.errors.find((e: any) => e.provider_id === gsPermanent);
        const transEntry = r.body.errors.find((e: any) => e.provider_id === gsTransient);
        const blockEntry = r.body.errors.find((e: any) => e.provider_id === gsBlocked);
        assertTrue(!!permEntry && !!transEntry && !!blockEntry, "gs-a3: all three provider ids present in errors[]");

        assertEq(permEntry.persistence, "permanent", "gs-a4: dns_not_found -> persistence 'permanent'");
        assertEq(transEntry.persistence, "transient", "gs-a5: conn_refused -> persistence 'transient'");
        assertEq(blockEntry.persistence, "blocked", "gs-a6: http_401 -> persistence 'blocked'");

        assertEq(
          permEntry.error,
          `fetch_failed:dns_not_found (permanent) for https://gs-permanent-b.example`,
          "gs-a7: permanent error string format unchanged",
        );
        assertEq(
          transEntry.error,
          `fetch_failed:conn_refused (transient) for https://gs-transient-b.example`,
          "gs-a8: transient error string format unchanged",
        );
        assertEq(
          blockEntry.error,
          `fetch_failed:http_401 (blocked) for https://gs-blocked-b.example`,
          "gs-a9: blocked error string format unchanged",
        );

        assertEq(
          r.body.errors_by_persistence,
          { permanent: 1, transient: 1, blocked: 1, internal: 0 },
          "gs-a10: errors_by_persistence tallies {permanent:1, transient:1, blocked:1, internal:0}",
        );

        assertEq(gsAttempts(gsPermanent), 1, "gs-a11: permanent failure DOES strike homepage_fetch_attempts");
        assertEq(gsAttempts(gsBlocked), 1, "gs-a12: blocked failure DOES strike homepage_fetch_attempts");
        assertEq(gsAttempts(gsTransient), 0, "gs-a13: transient failure does NOT strike homepage_fetch_attempts");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (B4a) internal — fetch throws (poisoned .cause getter)
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [gsInternalThrow], apply: true },
        });
        assertEq(r.status, 200, "gs-b1: fetch-throws call -> 200, not a 500");
        assertEq(r.body.errors.length, 1, "gs-b2: exactly one errors[] entry");
        assertEq(r.body.errors[0].provider_id, gsInternalThrow, "gs-b3: entry is for the fetch-throws provider");
        assertEq(r.body.errors[0].persistence, "internal", "gs-b4: fetch-throws branch tags persistence 'internal'");
        assertEq(
          r.body.errors_by_persistence,
          { permanent: 0, transient: 0, blocked: 0, internal: 1 },
          "gs-b5: errors_by_persistence counts it under internal, nothing else",
        );
        assertEq(gsAttempts(gsInternalThrow), 0, "gs-b6: an internal fault does NOT strike homepage_fetch_attempts");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (B4b) internal — write_failed (forced by dropping the audit table)
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: [gsWriteFail], apply: true },
        });
        assertEq(r.status, 200, "gs-c1: write-fail call -> 200, not a 500");
        assertEq(r.body.errors.length, 1, "gs-c2: exactly one errors[] entry");
        const entry = r.body.errors[0];
        assertEq(entry.provider_id, gsWriteFail, "gs-c3: entry is for the write-fail provider");
        assertEq(entry.persistence, "internal", "gs-c4: write_failed branch tags persistence 'internal'");
        assertTrue(
          typeof entry.error === "string" && entry.error.startsWith("write_failed:"),
          "gs-c5: error string keeps its pre-existing 'write_failed: ...' format",
        );
        assertEq(
          r.body.errors_by_persistence,
          { permanent: 0, transient: 0, blocked: 0, internal: 1 },
          "gs-c6: errors_by_persistence counts it under internal",
        );
        const row = db.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get(gsWriteFail) as { about_text: string | null };
        assertEq(row.about_text, null, "gs-c7: the aborted transaction wrote nothing — about_text stays blank");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-errors-by-persistence: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
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
      if (prevAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-errors-by-persistence.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshErrorsByPersistenceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
