/**
 * opplevelser-gardssalg-mojibake-backfill.test.ts — tests for dev-request
 * 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3: the audited,
 * reversible databackfill for gårdssalg/opplevagent producer content that
 * was corrupted (æ/ø/å mojibake) BEFORE PR lokal#360 fixed fetchHtml()'s
 * decode path. NOT a blind find/replace on mojibake byte patterns (rejected
 * in the dev-request as too risky) — instead POST
 * /admin/gardssalg-mojibake-backfill re-fetches each flagged candidate's
 * homepage via the ALREADY-FIXED buildPageEvidence()/fetchHtml() decode
 * path, re-extracts about_text/visit_text/opening_hours_text with the SAME
 * deterministic (non-LLM) extractors the original write path used, and only
 * overwrites a field when the fresh value (a) differs from what's stored and
 * (b) does not itself still match a mojibake signature — via
 * applyGardssalgProviderContent()'s new `forceFields` bypass, so every write
 * still gets the SAME gardssalg_content_audit row + field_provenance stamp +
 * lock-guard as any other gårdssalg content write (own unit coverage in
 * experience-store.test.ts; this file covers the route's wiring/plumbing).
 *
 * `products` (JSON-array-of-strings) has no deterministic re-extraction path
 * (see the route's own doc comment) — flagged for detection/manual review
 * only, never auto-rewritten, and the route must not even fetch a provider
 * whose ONLY flagged field is products.
 *
 * Mirrors opplevelser-gardssalg-fillblank.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch keyed by
 * hostname+path (same technique as search-enrich-page-evidence.test.ts,
 * since buildPageEvidence()'s underlying fetchHtml() now reads
 * resp.arrayBuffer() + resp.headers.get('content-type'), not resp.text()).
 * No LLM involved anywhere in this route, so no api.anthropic.com mocking
 * is needed (unlike the fillblank/rewrite/products test files).
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
    const url = opts.url || "/admin/gardssalg-mojibake-backfill";
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

/** Mock HTML response — a mock fetch() Response shape matching fetchHtml()'s
 * post-PR-#360 arrayBuffer()-based read (see search-enrich-page-evidence.test.ts). */
function htmlResponse(body: string): unknown {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: { get: () => null },
  };
}
function notFoundResponse(): unknown {
  return {
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => null },
  };
}

export function runOpplevelserGardssalgMojibakeBackfillTests(
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
    const testKey = "gardssalg-mojibake-backfill-test-key";
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
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const CLEAN_ABOUT = "Gården vår ligger idyllisk til ved fjorden, med egne grønnsaker og bær som selges hver helg.";
      const CORRUPT_ABOUT = Buffer.from(CLEAN_ABOUT, "utf-8").toString("latin1"); // genuine Ã¦/Ã¸/Ã¥ mojibake
      const CLEAN_VISIT = "Kom innom for omvisning og smaking i gårdsbutikken vår hver lørdag om sommeren.";
      // A DIFFERENT corrupted string (not derived from CLEAN_ABOUT) to stand
      // in for "the re-fetch produced NEW content that is STILL corrupted"
      // (e.g. a nested/double-encoded source, or a source whose own copy is
      // genuinely unrecoverable) — deliberately contains a mojibake
      // signature without being byte-identical to any stored value.
      const STILL_CORRUPT_FRESH = "Velkommen til Â gÃ¥rden, ferskt fra Ã¥keren hver dag.";

      assertTrue(CORRUPT_ABOUT.length > CLEAN_ABOUT.length, "sanity: corrupted fixture is LONGER than its clean repair (why forceFields is needed)");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "mb-write", navn: "Mojibake Write Gard", hjemmeside: "https://mb-write.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-clean", navn: "Ren Gard", hjemmeside: "https://mb-clean.example.no",
        content_source: null, about_text: CLEAN_ABOUT, visit_text: CLEAN_VISIT, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-locked", navn: "Last Gard", hjemmeside: "https://mb-locked.example.no",
        content_source: "manual", about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-still-corrupt", navn: "Fortsatt Korrupt Gard", hjemmeside: "https://mb-still-corrupt.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-no-change", navn: "Uendret Gard", hjemmeside: "https://mb-no-change.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-fetch-fail", navn: "Utilgjengelig Gard", hjemmeside: "https://mb-fetch-fail.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "mb-products-only", navn: "Produkter Gard", hjemmeside: "https://mb-products-only.example.no",
        content_source: null, about_text: CLEAN_ABOUT, visit_text: null, opening_hours_text: null,
        products: JSON.stringify(["Eplesider", CORRUPT_ABOUT]),
      });

      const requestedHosts: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        const u = new URL(urlStr);
        requestedHosts.push(u.hostname);
        const path = u.pathname === "" ? "/" : u.pathname;
        if (u.hostname === "mb-write.example.no" && path === "/") {
          return htmlResponse(`<html><head><meta property="og:description" content="${CLEAN_ABOUT}"></head><body><p>Velkommen innom.</p></body></html>`);
        }
        if (u.hostname === "mb-still-corrupt.example.no" && path === "/") {
          return htmlResponse(`<html><head><meta property="og:description" content="${STILL_CORRUPT_FRESH}"></head><body><p>Velkommen innom.</p></body></html>`);
        }
        if (u.hostname === "mb-no-change.example.no" && path === "/") {
          return htmlResponse(`<html><head><meta property="og:description" content="${CORRUPT_ABOUT}"></head><body><p>Velkommen innom.</p></body></html>`);
        }
        return notFoundResponse();
      }) as unknown as typeof fetch;

      // ── admin gate ────────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: { providerIds: ["mb-write"], apply: true } });
        assertEq(r.status, 403, "gate-1: missing X-Admin-Key → 403");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong" }, body: { providerIds: ["mb-write"], apply: true } });
        assertEq(r.status, 403, "gate-2: wrong X-Admin-Key → 403");
      }

      // ── dry-run: candidate detection only, ZERO writes/fetches ──────────
      {
        const before = requestedHosts.length;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-write", "mb-clean", "mb-locked"], apply: false },
        });
        assertEq(r.status, 200, "dry-1a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "dry-1b: dry_run:true");
        assertEq(r.body.candidates, 1, "dry-1c: exactly one candidate (mb-write) — mb-clean is clean, mb-locked is locked");
        assertEq(r.body.written, 0, "dry-1d: written:0 in dry-run");
        const row = r.body.rows.find((x: any) => x.provider_id === "mb-write");
        assertTrue(!!row, "dry-1e: mb-write appears in dry-run rows[]");
        assertTrue(row.fields.some((f: any) => f.field === "about_text"), "dry-1f: row's fields[] names about_text");
        assertTrue(typeof row.fields[0].snippet === "string" && row.fields[0].snippet.length > 0, "dry-1g: row's field match carries a non-empty snippet");
        assertEq(requestedHosts.length, before, "dry-1h: dry-run performs ZERO fetches — pure DB read");
        const rowInDb = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-write") as { about_text: string };
        assertEq(rowInDb.about_text, CORRUPT_ABOUT, "dry-1i: dry-run left the DB completely unchanged");
      }

      // ── apply: successful re-fetch + clean re-extraction → written,
      //    audited, provenance-stamped, before/after diff in the response. ──
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-write"], apply: true },
        });
        assertEq(r.status, 200, "apply-1a: apply -> 200");
        assertEq(r.body.dry_run, false, "apply-1b: dry_run:false");
        assertEq(r.body.candidates, 1, "apply-1c: candidates:1");
        assertEq(r.body.written, 1, "apply-1d: written:1");
        assertEq(r.body.skipped_still_corrupt, 0, "apply-1e: skipped_still_corrupt:0");
        assertEq(r.body.skipped_no_change, 0, "apply-1f: skipped_no_change:0");
        assertEq(r.body.errors.length, 0, "apply-1g: errors:[]");
        assertEq(r.body.rows.length, 1, "apply-1h: exactly one before/after diff row");
        const diffRow = r.body.rows[0];
        assertEq(diffRow.provider_id, "mb-write", "apply-1i: diff row names the right provider");
        assertEq(diffRow.field, "about_text", "apply-1j: diff row names about_text");
        assertEq(diffRow.before, CORRUPT_ABOUT, "apply-1k: diff row 'before' is the pre-write corrupted text");
        assertEq(diffRow.after, CLEAN_ABOUT, "apply-1l: diff row 'after' is the corrected text");

        const rowAfter = expDb.prepare(
          "SELECT about_text, content_source, field_provenance FROM experience_providers WHERE id = ?"
        ).get("mb-write") as { about_text: string; content_source: string; field_provenance: string };
        assertEq(rowAfter.about_text, CLEAN_ABOUT, "apply-1m: DB about_text actually updated to the corrected value");
        assertEq(rowAfter.content_source, "provider_site", "apply-1n: content_source stamped provider_site");
        const provenance = JSON.parse(rowAfter.field_provenance);
        assertTrue(!!provenance.about_text?.source_url, "apply-1o: field_provenance.about_text stamped");

        const auditRows = expDb.prepare(
          "SELECT old_value, new_value FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'about_text'"
        ).all("mb-write") as Array<{ old_value: string | null; new_value: string | null }>;
        assertTrue(auditRows.length > 0, "apply-1p: a gardssalg_content_audit row exists (auditable/reversible)");
        assertEq(auditRows[auditRows.length - 1]!.old_value, CORRUPT_ABOUT, "apply-1q: audit old_value is the corrupted text");
        assertEq(auditRows[auditRows.length - 1]!.new_value, CLEAN_ABOUT, "apply-1r: audit new_value is the corrected text");
      }

      // ── apply: re-running on the now-clean mb-write is a no-op — it's no
      //    longer a candidate at all. ───────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-write"], apply: true },
        });
        assertEq(r.body.candidates, 0, "idempotent: a second run finds zero candidates — mb-write is no longer flagged after being fixed");
        assertEq(r.body.written, 0, "idempotent: nothing written on the second run");
      }

      // ── apply: locked provider never fetched, never written ─────────────
      {
        const before = requestedHosts.length;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-locked"], apply: true },
        });
        assertEq(r.body.candidates, 0, "locked-1: a locked provider is never even a candidate (excluded from selection, same as content-refresh's lock guard)");
        assertEq(requestedHosts.length, before, "locked-2: no fetch happened for the locked provider");
        const rowLocked = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-locked") as { about_text: string };
        assertEq(rowLocked.about_text, CORRUPT_ABOUT, "locked-3: locked provider's corrupted text is completely untouched");
      }

      // ── apply: re-fetch yields DIFFERENT content that is STILL corrupted
      //    → skipped_still_corrupt, no write (the safety-net guardrail). ────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-still-corrupt"], apply: true },
        });
        assertEq(r.body.written, 0, "still-corrupt-1: nothing written");
        assertEq(r.body.skipped_still_corrupt, 1, "still-corrupt-2: skipped_still_corrupt:1");
        assertEq(r.body.skipped_no_change, 0, "still-corrupt-3: skipped_no_change:0");
        assertEq(r.body.rows.length, 0, "still-corrupt-4: no before/after diff row (nothing was written)");
        const row = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-still-corrupt") as { about_text: string };
        assertEq(row.about_text, CORRUPT_ABOUT, "still-corrupt-5: original stored value is left exactly as-is — never blanked, never guessed");
      }

      // ── apply: re-fetch yields the SAME (still-corrupted) content → the
      //    "differs from stored" check fires first → skipped_no_change. ─────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-no-change"], apply: true },
        });
        assertEq(r.body.written, 0, "no-change-1: nothing written");
        assertEq(r.body.skipped_no_change, 1, "no-change-2: skipped_no_change:1");
        assertEq(r.body.skipped_still_corrupt, 0, "no-change-3: skipped_still_corrupt:0 (no_change is checked first)");
        const row = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-no-change") as { about_text: string };
        assertEq(row.about_text, CORRUPT_ABOUT, "no-change-4: value left untouched");
      }

      // ── apply: fetch failure → errors bucket, no write, no crash. ────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-fetch-fail"], apply: true },
        });
        assertEq(r.status, 200, "fetch-fail-1: still 200, not a crash");
        assertEq(r.body.written, 0, "fetch-fail-2: nothing written");
        assertTrue(r.body.errors.some((e: any) => e.provider_id === "mb-fetch-fail"), "fetch-fail-3: errors[] carries an entry for the unreachable homepage");
        const row = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-fetch-fail") as { about_text: string };
        assertEq(row.about_text, CORRUPT_ABOUT, "fetch-fail-4: value left untouched on fetch failure");
      }

      // ── products-only candidate: detected, but NEVER fetched (no
      //    deterministic re-extraction path exists for it) and NEVER
      //    written — flagged for manual review instead. ────────────────────
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-products-only"], apply: false },
        });
        assertEq(dry.body.candidates, 1, "products-1: products-only corruption still surfaces as a dry-run candidate");
        assertTrue(
          dry.body.products_flagged_for_manual_review.includes("mb-products-only"),
          "products-2: dry-run flags it for manual review"
        );
        const dryRow = dry.body.rows.find((x: any) => x.provider_id === "mb-products-only");
        assertTrue(!!dryRow && dryRow.fields.some((f: any) => f.field === "products"), "products-3: dry-run row names the products field");

        const before = requestedHosts.length;
        const apply = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["mb-products-only"], apply: true },
        });
        assertEq(requestedHosts.length, before, "products-4: apply mode never fetches a provider whose ONLY flagged field is products");
        assertEq(apply.body.written, 0, "products-5: nothing written");
        assertTrue(
          apply.body.products_flagged_for_manual_review.includes("mb-products-only"),
          "products-6: apply response also flags it for manual review"
        );
        const row = expDb.prepare("SELECT products FROM experience_providers WHERE id = ?").get("mb-products-only") as { products: string };
        assertTrue(row.products.includes(CORRUPT_ABOUT), "products-7: the corrupted products column is completely untouched — never guessed, never blanked");
      }

      // ── auto-select (no providerIds): the candidate scan finds mb-write's
      //    successors on its own — after the earlier fixes above, only the
      //    remaining still-corrupted/no-change/fetch-fail/products/locked
      //    fixtures are left; locked must never appear. ─────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { apply: false, limit: 25 },
        });
        assertEq(r.status, 200, "auto-1: auto-select dry-run -> 200");
        const ids = r.body.rows.map((x: any) => x.provider_id);
        assertTrue(!ids.includes("mb-locked"), "auto-2: locked provider never appears in auto-select candidates");
        assertTrue(!ids.includes("mb-clean"), "auto-3: fully clean provider never appears");
        assertTrue(ids.includes("mb-still-corrupt"), "auto-4: still-corrupted provider is auto-selected");
        assertTrue(ids.includes("mb-products-only"), "auto-5: products-only-corrupted provider is auto-selected too (detection is field-agnostic)");
      }

      // ── unknown providerId → empty, well-shaped 200, no crash. ───────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["does-not-exist"], apply: true },
        });
        assertEq(r.status, 200, "unknown-1: unknown providerId → 200 (no crash)");
        assertEq(r.body.candidates, 0, "unknown-2: candidates:0");
        assertEq(r.body.written, 0, "unknown-3: written:0");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-mojibake-backfill: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-mojibake-backfill.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgMojibakeBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
