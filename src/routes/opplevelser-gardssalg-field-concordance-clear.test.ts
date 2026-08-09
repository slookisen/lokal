/**
 * opplevelser-gardssalg-field-concordance-clear.test.ts — route-level tests
 * for dev-request 2026-08-09-epost-korrigering-paa-plass:
 *
 *   POST /admin/gardssalg-field-concordance-clear
 *
 * The missing lever for the OTHER half of a field-concordance epost finding
 * (applyGardssalgFieldConcordanceApproval only ever CORRECTS to a non-blank
 * value; this route CLEARS a stored epost once its own fresh, same-request
 * homepage fetch proves genuine absence). Same in-memory-DB +
 * router.handle() + mocked globalThis.fetch harness as
 * opplevelser-gardssalg-field-concordance-audit.test.ts (this route reuses
 * the SAME crFetchGardssalgContent/gardssalgPageText pipeline).
 *
 * Covers:
 *   1. missing provider_id -> 400, fetch mock never called
 *   2. unknown provider_id -> 404 not_found
 *   3. already-blank stored epost -> 400 already_blank, fetch mock never
 *      called (checked BEFORE any fetch — no wasted homepage crawl)
 *   4. no hjemmeside on the row -> 409 no_homepage, fetch mock never called
 *   5. fetch fails (ok:false) -> 409 fetch_failed, zero DB writes
 *   6. fetch succeeds, verdict bekreftet (page still shows the stored
 *      address) -> 409 still_confirmed, zero writes
 *   7. fetch succeeds, verdict avvik (page shows a DIFFERENT address) -> 409
 *      correction_available with the found value, zero writes
 *   8. fetch succeeds, verdict ikke_funnet_på_siden, apply omitted -> 200
 *      would_clear:true, zero writes
 *   9. same setup, apply:true -> 200, epost NULL in DB, one new audit row
 *   10. same setup run a second time (idempotency) -> already_blank, never
 *       an ambiguous error, never a double-clear
 *   11. an extra unexpected `field_name` body key is silently ignored — the
 *       route never reads it, so it has zero effect on which field is
 *       cleared (still only ever epost)
 *
 * Run standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-field-concordance-clear.test.ts
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
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-field-concordance-clear";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
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

export function runOpplevelserGardssalgFieldConcordanceClearTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-field-concordance-clear-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const concordanceServicePath = require.resolve("../services/gardssalg-field-concordance");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, concordanceServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, content_source, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @content_source, @field_provenance,
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // prov-blank — already-blank stored epost (check 3).
      insertProvider.run({
        id: "prov-blank", navn: "Gard Blank",
        hjemmeside: "https://prov-blank.example.no", epost: null,
        content_source: null, field_provenance: null,
      });

      // prov-no-homepage — non-blank epost, no hjemmeside (check 4).
      insertProvider.run({
        id: "prov-no-homepage", navn: "Gard No Homepage",
        hjemmeside: null, epost: "post@nohomepage.no",
        content_source: null, field_provenance: null,
      });

      // prov-fetch-fail — fetch will 500 (check 5).
      insertProvider.run({
        id: "prov-fetch-fail", navn: "Gard Fetch Fail",
        hjemmeside: "https://prov-fetch-fail.example.no", epost: "post@fetchfail.no",
        content_source: null, field_provenance: null,
      });

      // prov-confirmed — page still shows the stored address (check 6).
      insertProvider.run({
        id: "prov-confirmed", navn: "Gard Confirmed",
        hjemmeside: "https://prov-confirmed.example.no", epost: "post@confirmed.no",
        content_source: null, field_provenance: null,
      });

      // prov-avvik — page shows a DIFFERENT address (check 7).
      insertProvider.run({
        id: "prov-avvik", navn: "Gard Avvik",
        hjemmeside: "https://prov-avvik.example.no", epost: "gammel@avvik.no",
        content_source: null, field_provenance: null,
      });

      // prov-absent — page has no email at all (checks 8-11).
      insertProvider.run({
        id: "prov-absent", navn: "Gard Absent",
        hjemmeside: "https://prov-absent.example.no", epost: "post@absent.no",
        content_source: null, field_provenance: null,
      });

      const dumpProviders = () =>
        (expDb.prepare(`SELECT * FROM experience_providers ORDER BY id`).all() as unknown[]).map((r) => JSON.stringify(r));
      const dumpAudit = () =>
        (expDb.prepare(`SELECT * FROM gardssalg_content_audit ORDER BY rowid`).all() as unknown[]).map((r) => JSON.stringify(r));

      let fetchCallCount = 0;
      const fetchedHosts: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCallCount++;
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);

        if (host === "prov-fetch-fail.example.no") {
          return {
            ok: false, status: 500, statusText: "Internal Server Error", text: async () => "",
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "prov-confirmed.example.no") {
          const html = `<html><body><p>Kontakt oss: post@confirmed.no</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "prov-avvik.example.no") {
          const html = `<html><body><p>Kontakt oss: ny@avvik.no</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "prov-absent.example.no") {
          const html = `<html><body><p>Velkommen til gården vår! Ingen kontaktinfo her.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        // Should never be reached — no other fixture's homepage is expected
        // to be fetched in these tests.
        return {
          ok: false, status: 404, statusText: "Not Found", text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: { get: () => null }, url: urlStr,
        } as unknown as Response;
      }) as typeof fetch;

      const authHeaders = { "x-admin-key": testKey };

      // ── auth gate ────────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: { provider_id: "prov-absent" } });
      assertEq(noKey.status, 403, "auth1: POST without X-Admin-Key -> 403");

      // ── 1. missing provider_id -> 400, no fetch attempted ───────────────
      const beforeMissing = fetchCallCount;
      const missingId = await callRoute(opplevelserRouter, { headers: authHeaders, body: {} });
      assertEq(missingId.status, 400, "1a: missing provider_id -> 400");
      assertEq(fetchCallCount, beforeMissing, "1b: no fetch attempted for a missing provider_id");

      const missingIdBlank = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "   " } });
      assertEq(missingIdBlank.status, 400, "1c: blank (whitespace-only) provider_id -> 400");

      // ── 2. unknown provider_id -> 404 not_found ─────────────────────────
      const unknown = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "does-not-exist" } });
      assertEq(unknown.status, 404, "2a: unknown provider_id -> 404");
      assertEq(unknown.body.reason, "not_found", "2b: reason not_found");

      // ── 3. already-blank stored epost -> 400 already_blank, no fetch ────
      const beforeBlank = fetchCallCount;
      const blank = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-blank" } });
      assertEq(blank.status, 400, "3a: already-blank stored epost -> 400");
      assertEq(blank.body.reason, "already_blank", "3b: reason already_blank");
      assertEq(fetchCallCount, beforeBlank, "3c: no fetch attempted for an already-blank epost (avoid wasted work)");

      // ── 4. no hjemmeside -> 409 no_homepage, no fetch ───────────────────
      const beforeNoHome = fetchCallCount;
      const noHome = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-no-homepage" } });
      assertEq(noHome.status, 409, "4a: no hjemmeside -> 409");
      assertEq(noHome.body.reason, "no_homepage", "4b: reason no_homepage");
      assertEq(fetchCallCount, beforeNoHome, "4c: no fetch attempted when there's no homepage to fetch");

      // ── 5. fetch fails -> 409 fetch_failed, zero DB writes ──────────────
      const beforeFetchFailProviders = dumpProviders();
      const fetchFail = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-fetch-fail" } });
      assertEq(fetchFail.status, 409, "5a: fetch failure -> 409");
      assertEq(fetchFail.body.reason, "fetch_failed", "5b: reason fetch_failed");
      assertTrue(typeof fetchFail.body.detail === "string" && fetchFail.body.detail.length > 0, "5c: detail carries the underlying fetch failure reason");
      assertEq(dumpProviders(), beforeFetchFailProviders, "5d: zero DB writes on a fetch failure (the core safety property)");
      const fetchFailRow = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-fetch-fail'`).get() as any;
      assertEq(fetchFailRow.epost, "post@fetchfail.no", "5e: epost column unchanged after a fetch failure");

      // ── 6. verdict bekreftet -> 409 still_confirmed, zero writes ────────
      const beforeConfirmedProviders = dumpProviders();
      const confirmed = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-confirmed" } });
      assertEq(confirmed.status, 409, "6a: verdict bekreftet -> 409");
      assertEq(confirmed.body.reason, "still_confirmed", "6b: reason still_confirmed");
      assertEq(dumpProviders(), beforeConfirmedProviders, "6c: zero writes when the address is still genuinely on the page");

      // ── 7. verdict avvik -> 409 correction_available, zero writes ───────
      const beforeAvvikProviders = dumpProviders();
      const avvik = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-avvik" } });
      assertEq(avvik.status, 409, "7a: verdict avvik -> 409");
      assertEq(avvik.body.reason, "correction_available", "7b: reason correction_available");
      assertEq(avvik.body.found, "ny@avvik.no", "7c: found value carried in the response");
      assertEq(dumpProviders(), beforeAvvikProviders, "7d: zero writes when a different address exists (that's a correction, not a clear)");

      // ── 8. verdict ikke_funnet_på_siden, apply omitted -> dry-run 200 ───
      const beforeDryProviders = dumpProviders();
      const dryRun = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-absent" } });
      assertEq(dryRun.status, 200, "8a: genuine absence, apply omitted -> 200");
      assertEq(dryRun.body.dry_run, true, "8b: dry_run:true");
      assertEq(dryRun.body.would_clear, true, "8c: would_clear:true");
      assertEq(dryRun.body.provider_id, "prov-absent", "8d: provider_id echoed");
      assertEq(dryRun.body.current_epost, "post@absent.no", "8e: current_epost echoed");
      assertEq(dumpProviders(), beforeDryProviders, "8f: zero writes on the dry-run");

      // ── 9. apply:true -> 200, epost NULL, one new audit row ─────────────
      const beforeApplyAudit = dumpAudit();
      const apply = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-absent", apply: true } });
      assertEq(apply.status, 200, "9a: apply:true -> 200");
      assertEq(apply.body.written, true, "9b: written:true");
      assertEq(apply.body.provider_id, "prov-absent", "9c: provider_id in the store result");
      assertEq(apply.body.field_name, "epost", "9d: field_name is epost");
      const appliedRow = expDb.prepare(`SELECT epost, field_provenance FROM experience_providers WHERE id = 'prov-absent'`).get() as any;
      assertEq(appliedRow.epost, null, "9e: epost column is now NULL");
      const appliedProvenance = JSON.parse(appliedRow.field_provenance);
      assertEq(appliedProvenance.epost.source_url, "https://prov-absent.example.no", "9f: field_provenance.epost.source_url is the hjemmeside used as evidence");
      const afterApplyAudit = dumpAudit();
      assertEq(afterApplyAudit.length, beforeApplyAudit.length + 1, "9g: exactly one new gardssalg_content_audit row");
      const applyAuditRow = expDb
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = 'prov-absent' AND field_name = 'epost' ORDER BY rowid DESC LIMIT 1`)
        .get() as any;
      assertEq(applyAuditRow.old_value, "post@absent.no", "9h: audit old_value is the true pre-write epost");
      assertEq(applyAuditRow.new_value, null, "9i: audit new_value is NULL");

      // ── 10. idempotency: a second call on the now-blank provider ────────
      const second = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_id: "prov-absent", apply: true } });
      assertEq(second.status, 400, "10a: second clear of the now-blank provider -> 400 (already_blank), never a double-clear or ambiguous error");
      assertEq(second.body.reason, "already_blank", "10b: reason already_blank");

      // ── 11. an extra field_name-shaped key is silently ignored ──────────
      // prov-avvik still has its ORIGINAL (non-blank, "gammel@avvik.no")
      // epost — check 7 above rejected before any write. This proves the
      // route never reads a field_name key from the body at all: even
      // though the page's avvik verdict blocks a real clear anyway, the
      // response/behavior is byte-identical to check 7's, and NOTHING in
      // the route path branches on the presence of field_name.
      const beforeFieldNameProviders = dumpProviders();
      const withFieldName = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-avvik", apply: true, field_name: "telefon" },
      });
      assertEq(withFieldName.status, avvik.status, "11a: an extra field_name key produces the SAME status as without it");
      assertEq(withFieldName.body, avvik.body, "11b: an extra field_name key produces the SAME response body as without it (the key is never read)");
      assertEq(dumpProviders(), beforeFieldNameProviders, "11c: zero writes — the route never cleared telefon (or anything) based on the ignored field_name key");
      const untouchedTelefonRow = expDb.prepare(`SELECT telefon FROM experience_providers WHERE id = 'prov-avvik'`).get() as any;
      assertEq(untouchedTelefonRow.telefon, null, "11d: telefon (never set in the fixture, never targeted by this route) remains untouched");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-field-concordance-clear: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
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
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-field-concordance-clear.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgFieldConcordanceClearTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
