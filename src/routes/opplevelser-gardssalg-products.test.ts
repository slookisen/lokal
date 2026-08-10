/**
 * opplevelser-gardssalg-products.test.ts — tests for slice 5c of dev-request
 * 2026-07-18-gardssalg-profilkvalitet-foer-outreach: fill-only extraction of
 * the "products" JSON-array column for gårdssalg providers.
 *
 *   - generateGardssalgProductList() (src/routes/opplevelser.ts): mirrors
 *     generateGardssalgAboutRewrite()'s never-fabricate contract — missing
 *     key / network throw / non-200 / unparseable JSON / non-JSON-array
 *     response / the literal INGEN_PRODUKTER_FUNNET sentinel / an
 *     empty-after-filtering result all resolve to null, never throw.
 *     Non-string / empty / over-length entries are dropped (never
 *     fabricated); survivors are deduped case-insensitively and capped to
 *     20 items.
 *   - gardssalgProductsEligible() (src/services/experience-store.ts) has its
 *     own dedicated pure-function tests in experience-store.test.ts; this
 *     file exercises it only through the route's wiring.
 *   - POST /admin/gardssalg-content-refresh's processOne(): fill-only — only
 *     fires when the current `products` column is blank/empty; in apply
 *     mode, writes through the EXISTING applyGardssalgProviderContent()
 *     audit/provenance/lock-guard machinery.
 *
 * Mirrors opplevelser-gardssalg-rewrite.test.ts's setup convention
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and mocks globalThis.fetch for BOTH the
 * page-content crawl (crFetchGardssalgContent, keyed by hostname) AND the
 * Anthropic API call (keyed by URL containing "api.anthropic.com").
 */

import { generateGardssalgProductList } from "./opplevelser";

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
    const url = opts.url || "/admin/gardssalg-content-refresh";
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

export function runOpplevelserGardssalgProductsTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;

    // ═══════════════════════════════════════════════════════════════════
    // Section A — generateGardssalgProductList() direct unit tests
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Vi selger Eplesider, Eplemost og Pæremost rett fra gården. Åpent hver lørdag.";

      // ── pg-1: missing ANTHROPIC_API_KEY → null, fetch never invoked ──────
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("pg-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-1: missing ANTHROPIC_API_KEY → null");
      }
      // ── pg-1d (dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-
      //    rader, Skive 1): the ADDITIVE diagnosticOut out-param is stamped
      //    "infra_failure" for the missing-key path, and — proving it's truly
      //    additive — omitting it entirely (every call above/below that
      //    doesn't pass a second arg) reproduces the exact same null return,
      //    which is what pg-1's own assertion already established. ─────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-1d: missing ANTHROPIC_API_KEY → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "infra_failure", "pg-1e: diagnosticOut.outcome = infra_failure for missing API key");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── pg-2: mocked 200 response with a valid JSON array → returned,
      //    request carries the model/prompt contract. ──────────────────────
      let capturedInit: any = null;
      let capturedUrl: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: JSON.stringify(["Eplesider", "Eplemost"]) }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, ["Eplesider", "Eplemost"], "pg-2a: mocked 200 with a valid JSON array → returned");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "pg-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "pg-2c: model is claude-haiku-4-5");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(SOURCE_TEXT), "pg-2d: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("INGEN_PRODUKTER_FUNNET"), "pg-2e: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN produktnavn som faktisk står i kildeteksten"), "pg-2f: prompt includes the exact grounding instruction");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "pg-2g: x-api-key header carries ANTHROPIC_API_KEY");
      }
      // ── pg-2h (Skive 1): diagnosticOut.outcome = "products_found" when a
      //    valid non-empty array comes back. ────────────────────────────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, ["Eplesider", "Eplemost"], "pg-2h: valid array still returned unchanged with diagnosticOut passed");
        assertEq(diag.outcome, "products_found", "pg-2i: diagnosticOut.outcome = products_found for a valid array response");
      }

      // ── pg-3: source text capped to ~6000 chars in the prompt. ───────────
      {
        const hugeSource = "x".repeat(20000);
        await generateGardssalgProductList(hugeSource);
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= 6000, "pg-3: source text is capped to ~6000 chars in the prompt");
      }

      // ── pg-4: the literal sentinel (with/without whitespace) → null. ─────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "INGEN_PRODUKTER_FUNNET" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-4a: the literal INGEN_PRODUKTER_FUNNET sentinel → null");
      }
      // ── pg-4c (Skive 1): sentinel is classified distinctly from a
      //    parse/validation failure — this is the whole point of the
      //    diagnostic (telling "model legitimately found nothing" apart from
      //    "something went wrong"). ────────────────────────────────────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-4d: sentinel → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "sentinel_no_products", "pg-4e: diagnosticOut.outcome = sentinel_no_products for the literal sentinel");
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "  INGEN_PRODUKTER_FUNNET  \n" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-4b: sentinel with surrounding whitespace (trimmed) → still null");
      }

      // ── pg-5: response is not valid JSON (free prose) → null, never
      //    guessed/parsed out of the prose. ─────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Vi selger Eplesider og Eplemost." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-5: non-JSON prose response → null, never fabricated/parsed from prose");
      }
      // ── pg-5b (Skive 1): non-JSON prose is a genuine parse failure, NOT the
      //    model's explicit sentinel — classified invalid_unparseable. ───────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-5c: non-JSON prose → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "invalid_unparseable", "pg-5d: diagnosticOut.outcome = invalid_unparseable for non-JSON prose");
      }

      // ── pg-6: valid JSON but not an array (an object) → null. ────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: '{"products":["Eplesider"]}' }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-6: valid JSON object (not an array) → null");
      }
      // ── pg-6b (Skive 1): valid JSON but wrong shape → invalid_unparseable. ─
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-6c: JSON object (not array) → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "invalid_unparseable", "pg-6d: diagnosticOut.outcome = invalid_unparseable for a non-array JSON value");
      }

      // ── pg-7: an empty JSON array → null (never an empty-but-truthy
      //    array). ────────────────────────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "[]" }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-7: empty JSON array response → null");
      }
      // ── pg-7b (Skive 1): a syntactically valid but EMPTY array is also
      //    classified invalid_unparseable — not the model's explicit sentinel,
      //    so it is not conflated with a legitimate "no products" answer. ────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-7c: empty JSON array → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "invalid_unparseable", "pg-7d: diagnosticOut.outcome = invalid_unparseable for an empty array");
      }

      // ── pg-8: filtering + dedup + cap — non-string entries, an
      //    empty/whitespace-only entry, an over-60-char entry, and a
      //    case-insensitive duplicate are all dropped; order + first
      //    occurrence preserved otherwise. ──────────────────────────────────
      const OVERLONG = "x".repeat(61);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{
            type: "text",
            text: JSON.stringify(["Eplesider", 42, "  ", "eplesider", "Eplemost", OVERLONG, "Pæremost"]),
          }],
        }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, ["Eplesider", "Eplemost", "Pæremost"], "pg-8: non-string/blank/over-length entries dropped, case-insensitive duplicate deduped, order preserved");
      }
      // ── pg-8b (Skive 1): survives filtering with >=1 item → products_found. ─
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, ["Eplesider", "Eplemost", "Pæremost"], "pg-8c: filtered/deduped result unchanged with diagnosticOut passed");
        assertEq(diag.outcome, "products_found", "pg-8d: diagnosticOut.outcome = products_found once >=1 item survives filtering");
      }

      // ── pg-9: capped to 20 items even when the model returns more. ───────
      const twentyFive = Array.from({ length: 25 }, (_, i) => `Produkt${i + 1}`);
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: JSON.stringify(twentyFive) }] }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r?.length, 20, "pg-9a: result capped to 20 items");
        assertEq(r, twentyFive.slice(0, 20), "pg-9b: capped result keeps the first 20 in order");
      }

      // ── pg-10: network throw → null, never throws itself. ────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-10: fetch throw (network failure) → null, not re-thrown");
      }
      // ── pg-10b (Skive 1): a network throw is an infra failure, not a
      //    genuine "no products in this text" answer. ─────────────────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-10c: network throw → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "infra_failure", "pg-10d: diagnosticOut.outcome = infra_failure for a network throw");
      }

      // ── pg-11: non-200 response → null. ───────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-11: non-200 response → null");
      }
      // ── pg-11b (Skive 1): non-200 → infra_failure. ──────────────────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-11c: non-200 response → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "infra_failure", "pg-11d: diagnosticOut.outcome = infra_failure for a non-200 response");
      }

      // ── pg-12: unparseable JSON body (.json() throws) → null. ─────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-12: unparseable JSON response body → null");
      }
      // ── pg-12b (Skive 1): unparseable response body → infra_failure. ────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-12c: unparseable JSON body → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "infra_failure", "pg-12d: diagnosticOut.outcome = infra_failure for an unparseable response body");
      }

      // ── pg-13: response shape with non-array content field → null, never
      //    throws (mirrors generateTitleNo/generateGardssalgAboutRewrite's
      //    own defensive regression). ─────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await generateGardssalgProductList(SOURCE_TEXT);
        assertEq(r, null, "pg-13: non-array content field → null, not a thrown TypeError");
      }
      // ── pg-13b (Skive 1): the response text itself never resolved to a
      //    string at all → invalid_unparseable (not infra_failure — the HTTP
      //    call itself succeeded; it's the payload shape that's wrong). ─────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-13c: non-array content field → null (with diagnosticOut passed)");
        assertEq(diag.outcome, "invalid_unparseable", "pg-13d: diagnosticOut.outcome = invalid_unparseable when no text field is found in the response");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-products (section A): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — POST /admin/gardssalg-content-refresh route-level wiring
    // ═══════════════════════════════════════════════════════════════════
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-products-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";

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

      // about_text/visit_text are pre-set LONG (>=200 chars) and quality-
      // passing so neither the fill/replace path nor the slice 5a rewrite
      // path can ever fire for them — isolates every assertion below to the
      // "products" field alone.
      const SILENT_LONG_TEXT =
        "Familiedrevet gård på Toten som i fire generasjoner har dyrket poteter, gulrøtter og bær, og som selger alt direkte fra egen gårdsbutikk hver lørdag om sommeren. Gården ligger vakkert til med utsikt over Mjøsa, og tar imot besøkende gjennom hele sesongen.";
      assertTrue(SILENT_LONG_TEXT.length >= 200, "sanity: SILENT_LONG_TEXT is >=200 chars (never eligible for fill/replace/rewrite)");

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
      // Steg 3 follow-up: POST /admin/gardssalg-content-refresh now fail-
      // closed-gates its fetch on field_provenance.hjemmeside_verification.
      // verified === true (see isHjemmesideVerified() in routes/opplevelser.ts).
      // This file is about the products-extraction path AFTER a fetch
      // succeeds, not about that gate (see opplevelser-gardssalg-fillblank.
      // test.ts for the gate's own dedicated tests) — so every fixture is
      // stamped verified by default here unless a call site explicitly
      // overrides field_provenance.
      const VERIFIED_PROVENANCE_PG = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const insertProvider = {
        run(params: Record<string, unknown>): void {
          insertProviderStmt.run({ field_provenance: VERIFIED_PROVENANCE_PG, ...params });
        },
      };

      insertProvider.run({
        id: "prov-pg-blank", navn: "Prov PG Blank Gard", hjemmeside: "https://prov-pg-blank.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      insertProvider.run({
        id: "prov-pg-locked", navn: "Prov PG Locked Gard", hjemmeside: "https://prov-pg-locked.example.no",
        content_source: "manual", about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      insertProvider.run({
        id: "prov-pg-existing", navn: "Prov PG Existing Gard", hjemmeside: "https://prov-pg-existing.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null,
        products: JSON.stringify(["Eplesider"]),
      });
      insertProvider.run({
        id: "prov-pg-emptyarr", navn: "Prov PG EmptyArr Gard", hjemmeside: "https://prov-pg-emptyarr.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: "[]",
      });
      insertProvider.run({
        id: "prov-pg-none", navn: "Prov PG None Gard", hjemmeside: "https://prov-pg-none.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, products, content_source, content_evidence_url, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const CANDIDATE = ["Eplesider", "Eplemost", "Pæremost"];
      let anthropicCallCount = 0;
      const plainPage = "<html><body><p>Velkommen til gården vår, ring for mer info.</p></body></html>";

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: JSON.stringify(CANDIDATE) }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (
          host === "prov-pg-blank.example.no" ||
          host === "prov-pg-existing.example.no" ||
          host === "prov-pg-emptyarr.example.no"
        ) {
          return {
            ok: true, status: 200, text: async () => plainPage,
            arrayBuffer: async () => new TextEncoder().encode(plainPage).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ── pg-r1: dry-run on prov-pg-blank → products action "filled", LLM
      //    WAS called (real preview), nothing written. ──────────────────────
      const callsBeforeDry = anthropicCallCount;
      const dryRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-blank"], apply: false },
      });
      assertEq(dryRes.status, 200, "pg-r1a: dry-run -> 200");
      assertTrue(anthropicCallCount > callsBeforeDry, "pg-r1b: dry-run DID call the LLM (real preview, not guessed)");
      const dryEntry = dryRes.body.changed.find((c: any) => c.provider_id === "prov-pg-blank");
      assertTrue(!!dryEntry, "pg-r1c: prov-pg-blank appears in dry-run changed[]");
      assertEq(dryEntry.actions.products, "filled", "pg-r1d: dry-run projects products as 'filled'");
      assertTrue(dryEntry.fields.includes("products"), "pg-r1e: fields[] lists products");
      assertTrue(!!dryEntry.provenance.products, "pg-r1f: dry-run response carries provenance for products");
      assertEq(dryEntry.provenance.products.source_url, "https://prov-pg-blank.example.no", "pg-r1g: provenance source_url is the fetched homepage");
      const beforeDryWrite = getProviderRow("prov-pg-blank");
      assertEq(beforeDryWrite.products, null, "pg-r1h: dry-run performed ZERO writes — products unchanged in the DB");
      assertEq(getAuditRows("prov-pg-blank").length, 0, "pg-r1i: dry-run created no audit row");

      // ── pg-r1j..n (dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-
      //    28-rader, Skive 1; path list updated for Skive 2): products_diagnostic
      //    reports this row even though it's the SAME dry-run response that
      //    already reports it in changed[] — proving the new bucket is
      //    additive, not a replacement. plainPage's real text is a couple
      //    dozen characters and every candidate sub-page in this mock 200s
      //    (host-only match), so the homepage + the first 4
      //    GARDSSALG_CONTENT_PATHS entries (/produkter, /nettbutikk,
      //    /kontakt, /sortiment — Skive 2's product-prioritized front of the
      //    list) all get concatenated in — still nowhere near the 6000-char
      //    cap. ─────────────────────────────────────────────────────────────
      const dryDiag = dryRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-blank");
      assertTrue(!!dryDiag, "pg-r1j: prov-pg-blank appears in dry-run products_diagnostic");
      assertEq(dryDiag.outcome, "products_found", "pg-r1k: dry-run diagnostic outcome is products_found");
      assertEq(dryDiag.truncated, false, "pg-r1l: dry-run diagnostic truncated=false — plainPage is far under the 6000-char cap");
      assertTrue(typeof dryDiag.content_chars_full === "number" && dryDiag.content_chars_full > 0, "pg-r1m: dry-run diagnostic content_chars_full is a positive number");
      assertEq(dryDiag.pages_fetched_paths, ["/produkter", "/nettbutikk", "/kontakt", "/sortiment"], "pg-r1n: dry-run diagnostic lists exactly the 4 sub-pages this mock actually fetched, in GARDSSALG_CONTENT_PATHS order");

      // ── pg-r2: apply mode on prov-pg-blank → actually writes through
      //    applyGardssalgProviderContent, with a matching audit row +
      //    field_provenance entry. ────────────────────────────────────────
      const applyRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-blank"], apply: true },
      });
      assertEq(applyRes.status, 200, "pg-r2a: apply -> 200");
      const applyEntry = applyRes.body.changed.find((c: any) => c.provider_id === "prov-pg-blank");
      assertTrue(!!applyEntry, "pg-r2b: prov-pg-blank appears in apply changed[]");
      assertEq(applyEntry.actions.products, "filled", "pg-r2c: apply response tags products 'filled'");

      const rowAfterApply = getProviderRow("prov-pg-blank");
      assertEq(JSON.parse(rowAfterApply.products), CANDIDATE, "pg-r2d: products actually written as the accepted candidate array");
      assertEq(rowAfterApply.content_source, "provider_site", "pg-r2e: content_source stamped provider_site");

      const auditRows = getAuditRows("prov-pg-blank");
      const productsAudit = auditRows.find((r: any) => r.field_name === "products");
      assertTrue(!!productsAudit, "pg-r2f: a products audit row exists");
      assertEq(productsAudit.old_value, null, "pg-r2g: audit old_value is null (was blank before)");
      assertEq(productsAudit.new_value, JSON.stringify(CANDIDATE), "pg-r2h: audit new_value is the written JSON array");

      const provenanceAfterApply = JSON.parse(rowAfterApply.field_provenance);
      assertTrue(!!provenanceAfterApply.products, "pg-r2i: field_provenance.products is present after the write");
      assertEq(provenanceAfterApply.products.source_url, "https://prov-pg-blank.example.no", "pg-r2j: field_provenance.products.source_url matches the fetched homepage");

      // ── pg-r2k (Skive 1): apply-mode response carries the SAME diagnostic
      //    shape as dry-run — reporting behavior is identical in both modes,
      //    only the write side differs. ───────────────────────────────────
      const applyDiag = applyRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-blank");
      assertTrue(!!applyDiag, "pg-r2k: prov-pg-blank appears in apply products_diagnostic");
      assertEq(applyDiag.outcome, "products_found", "pg-r2l: apply diagnostic outcome is products_found");

      // ── pg-r3: idempotency — a second run against the now-filled row finds
      //    nothing eligible for products; the LLM is NOT called again. ──────
      const callsBeforeSecond = anthropicCallCount;
      const secondRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-blank"], apply: true },
      });
      assertEq(secondRes.status, 200, "pg-r3a: second run -> 200");
      assertEq(anthropicCallCount, callsBeforeSecond, "pg-r3b: idempotency — the LLM is NOT called again once products is non-blank");
      const secondEntry = secondRes.body.changed.find((c: any) => c.provider_id === "prov-pg-blank");
      assertTrue(!secondEntry, "pg-r3c: prov-pg-blank no longer appears in changed[] — nothing left to do");
      const rowAfterSecond = getProviderRow("prov-pg-blank");
      assertEq(JSON.parse(rowAfterSecond.products), CANDIDATE, "pg-r3d: products unchanged by the idempotent second run");
      assertTrue(!secondRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-blank"), "pg-r3e (Skive 1): no products_diagnostic entry once products is non-blank — the row never enters the branch");

      // ── pg-r4: manual/claim-locked provider → unaffected; the lock guard
      //    short-circuits BEFORE any fetch, so the LLM is never invoked. ────
      const callsBeforeLocked = anthropicCallCount;
      const lockedRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-locked"], apply: true },
      });
      assertEq(lockedRes.status, 200, "pg-r4a: locked-provider call -> 200");
      assertTrue(lockedRes.body.skipped_locked.includes("prov-pg-locked"), "pg-r4b: locked provider reported in skipped_locked");
      assertEq(lockedRes.body.changed.length, 0, "pg-r4c: nothing written for the locked provider");
      assertEq(anthropicCallCount, callsBeforeLocked, "pg-r4d: the LLM is never called for a locked provider");
      const rowLocked = getProviderRow("prov-pg-locked");
      assertEq(rowLocked.products, null, "pg-r4e: locked provider's products is completely unchanged");
      assertTrue(!lockedRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-locked"), "pg-r4f (Skive 1): no products_diagnostic entry for a locked row — the lock guard short-circuits before the products branch");

      // ── pg-r5: a provider with an EXISTING non-empty products list is
      //    fill-only-protected — never overwritten, LLM never called for it,
      //    and (since about/visit are also silent by construction) the
      //    provider does not appear in changed[] at all. ────────────────────
      const callsBeforeExisting = anthropicCallCount;
      const existingRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-existing"], apply: true },
      });
      assertEq(existingRes.status, 200, "pg-r5a: existing-products provider call -> 200");
      assertEq(anthropicCallCount, callsBeforeExisting, "pg-r5b: the LLM is never called when products already has content — fill-only, never replaced");
      assertTrue(!existingRes.body.changed.find((c: any) => c.provider_id === "prov-pg-existing"), "pg-r5c: prov-pg-existing does not appear in changed[] at all — nothing eligible on this provider");
      const rowExisting = getProviderRow("prov-pg-existing");
      assertEq(JSON.parse(rowExisting.products), ["Eplesider"], "pg-r5d: existing products value is completely untouched");
      assertTrue(!existingRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-existing"), "pg-r5e (Skive 1): no products_diagnostic entry when products already has content — gardssalgProductsEligible is false, so the branch (and the diagnostic capture inside it) never runs");

      // ── pg-r6: a provider whose products column is the literal "[]"
      //    (empty array, not NULL) is STILL eligible — the LLM IS called
      //    and a fill happens, proving eligibility isn't NULL-only. ────────
      const callsBeforeEmptyArr = anthropicCallCount;
      const emptyArrRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-emptyarr"], apply: true },
      });
      assertEq(emptyArrRes.status, 200, "pg-r6a: '[]'-products provider call -> 200");
      assertTrue(anthropicCallCount > callsBeforeEmptyArr, "pg-r6b: the LLM IS called for a literal '[]' products value — eligibility isn't NULL-only");
      const rowEmptyArr = getProviderRow("prov-pg-emptyarr");
      assertEq(JSON.parse(rowEmptyArr.products), CANDIDATE, "pg-r6c: '[]'-products provider gets filled just like a NULL one");
      const emptyArrDiag = emptyArrRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-emptyarr");
      assertTrue(!!emptyArrDiag, "pg-r6d (Skive 1): products_diagnostic fires for the literal '[]' case too — eligibility isn't NULL-only for the diagnostic either");
      assertEq(emptyArrDiag.outcome, "products_found", "pg-r6e: '[]'-products provider's diagnostic outcome is products_found");

      // ── pg-r7: LLM finds no products (sentinel) → nothing written, the
      //    provider does not appear in changed[] at all. ────────────────────
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "INGEN_PRODUKTER_FUNNET" }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-pg-none.example.no") {
          return {
            ok: true, status: 200, text: async () => plainPage,
            arrayBuffer: async () => new TextEncoder().encode(plainPage).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;
      const noneRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-none"], apply: true },
      });
      assertEq(noneRes.status, 200, "pg-r7a: sentinel-response provider call -> 200");
      assertTrue(!noneRes.body.changed.find((c: any) => c.provider_id === "prov-pg-none"), "pg-r7b: prov-pg-none does not appear in changed[] — sentinel means nothing to write");
      const rowNone = getProviderRow("prov-pg-none");
      assertEq(rowNone.products, null, "pg-r7c: prov-pg-none's products stays null after a sentinel response");

      // ── pg-r7d..g (Skive 1 — THE motivating case for this whole diagnostic
      //    pass): a sentinel row is exactly the shape that is invisible
      //    everywhere else in this report (not in changed[], not in errors,
      //    not in any locked/excluded bucket — see pg-r7b above) — which is
      //    precisely why 28-of-30 content-blocked gårdssalg rows would
      //    otherwise vanish from the report with zero explanation for WHY
      //    products came back empty. products_diagnostic must surface it. ──
      const noneDiag = noneRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-none");
      assertTrue(!!noneDiag, "pg-r7d: prov-pg-none DOES appear in products_diagnostic even though it's absent from changed[]");
      assertEq(noneDiag.outcome, "sentinel_no_products", "pg-r7e: sentinel response classified as sentinel_no_products, not invalid_unparseable");
      assertEq(noneDiag.truncated, false, "pg-r7f: plainPage-derived content is far under the 6000-char cap");
      assertTrue(Array.isArray(noneDiag.pages_fetched_paths), "pg-r7g: pages_fetched_paths is present and an array");

      // ── pg-r9 (Skive 1): truncation flag is correct AT and JUST OVER the
      //    6000-char GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP boundary.
      //    extractVisibleText strips tags to single collapsed/trimmed
      //    whitespace, so a homepage body of exactly N same-character bytes
      //    with no internal markup extracts to exactly N characters — giving
      //    exact control over content_chars_full without depending on any
      //    internal cap/extraction constant beyond the one under test. Only
      //    the homepage host resolves in this mock (every sub-page 404s), so
      //    contentText is driven purely by the homepage body. ───────────────
      insertProvider.run({
        id: "prov-pg-atcap", navn: "Prov PG AtCap Gard", hjemmeside: "https://prov-pg-atcap.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      insertProvider.run({
        id: "prov-pg-overcap", navn: "Prov PG OverCap Gard", hjemmeside: "https://prov-pg-overcap.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      const AT_CAP_PAGE = `<html><body><p>${"x".repeat(6000)}</p></body></html>`;
      const OVER_CAP_PAGE = `<html><body><p>${"x".repeat(6001)}</p></body></html>`;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: JSON.stringify(CANDIDATE) }] }),
          } as unknown as Response;
        }
        const u = new URL(urlStr);
        // Homepage only ("/") succeeds — every GARDSSALG_CONTENT_PATHS
        // sub-page 404s, so contentText is driven purely by the homepage
        // body, keeping the char count exact.
        if (u.hostname === "prov-pg-atcap.example.no" && u.pathname === "/") {
          return {
            ok: true, status: 200, text: async () => AT_CAP_PAGE,
            arrayBuffer: async () => new TextEncoder().encode(AT_CAP_PAGE).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (u.hostname === "prov-pg-overcap.example.no" && u.pathname === "/") {
          return {
            ok: true, status: 200, text: async () => OVER_CAP_PAGE,
            arrayBuffer: async () => new TextEncoder().encode(OVER_CAP_PAGE).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      const atCapRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-atcap"], apply: false },
      });
      assertEq(atCapRes.status, 200, "pg-r9a: at-cap provider call -> 200");
      const atCapDiag = atCapRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-atcap");
      assertTrue(!!atCapDiag, "pg-r9b: prov-pg-atcap appears in products_diagnostic");
      assertEq(atCapDiag.content_chars_full, 6000, "pg-r9c: content_chars_full is exactly 6000 for a homepage body of exactly 6000 characters");
      assertEq(atCapDiag.truncated, false, "pg-r9d: truncated=false AT exactly the cap (6000 is not > 6000)");
      assertEq(atCapDiag.pages_fetched_paths, [], "pg-r9e: no sub-pages fetched (every candidate path 404s in this mock)");

      const overCapRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-overcap"], apply: false },
      });
      assertEq(overCapRes.status, 200, "pg-r9f: over-cap provider call -> 200");
      const overCapDiag = overCapRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-overcap");
      assertTrue(!!overCapDiag, "pg-r9g: prov-pg-overcap appears in products_diagnostic");
      assertEq(overCapDiag.content_chars_full, 6001, "pg-r9h: content_chars_full is exactly 6001 for a homepage body of exactly 6001 characters");
      assertEq(overCapDiag.truncated, true, "pg-r9i: truncated=true one character OVER the cap");

      // ── pg-r10 (Skive 1; path list updated for Skive 2): pages_fetched_paths
      //    names the SPECIFIC GARDSSALG_CONTENT_PATHS entries that succeeded,
      //    not just a count — here only /om-oss and /kontakt 200, everything
      //    else 404s, and the two non-adjacent successes must both be
      //    reported in path-list order. Skive 2 moved /kontakt ahead of
      //    /om-oss in GARDSSALG_CONTENT_PATHS (product-path prioritization,
      //    with /kontakt kept as one of the guaranteed-early generic slots),
      //    so the expected order below is now ["/kontakt", "/om-oss"], not
      //    ["/om-oss", "/kontakt"] — this test is exactly the kind of
      //    path-priority coverage the Skive 2 change needs. ────────────────
      insertProvider.run({
        id: "prov-pg-paths", navn: "Prov PG Paths Gard", hjemmeside: "https://prov-pg-paths.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: JSON.stringify(CANDIDATE) }] }),
          } as unknown as Response;
        }
        const u = new URL(urlStr);
        if (u.hostname === "prov-pg-paths.example.no" &&
          (u.pathname === "/" || u.pathname === "/om-oss" || u.pathname === "/kontakt")) {
          return {
            ok: true, status: 200, text: async () => plainPage,
            arrayBuffer: async () => new TextEncoder().encode(plainPage).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;
      const pathsRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-paths"], apply: false },
      });
      assertEq(pathsRes.status, 200, "pg-r10a: paths-tracking provider call -> 200");
      const pathsDiag = pathsRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-paths");
      assertTrue(!!pathsDiag, "pg-r10b: prov-pg-paths appears in products_diagnostic");
      assertEq(pathsDiag.pages_fetched_paths, ["/kontakt", "/om-oss"], "pg-r10c: pages_fetched_paths lists exactly the 2 sub-pages that 200'd, in GARDSSALG_CONTENT_PATHS order (kontakt now precedes om-oss) — not the rest that 404'd");

      // ── pg-r8: rollback — the products write from pg-r2 is restorable via
      //    the existing GARDSSALG_ROLLBACKABLE_FIELDS-driven rollback route,
      //    proving slice 5c needed no new rollback mechanism. ───────────────
      const rollbackRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-pg-blank", field_name: "products", apply: true },
      });
      assertEq(rollbackRes.status, 200, "pg-r8a: rollback call -> 200");
      assertTrue(rollbackRes.body.success === true, "pg-r8b: rollback reports success");
      const restoredEntry = rollbackRes.body.restored.find((r: any) => r.provider_id === "prov-pg-blank" && r.field_name === "products");
      assertTrue(!!restoredEntry, "pg-r8c: rollback response includes the products restore");
      assertEq(restoredEntry.restored_to, null, "pg-r8d: rollback restores products to its pre-write value (null)");
      const rowAfterRollback = getProviderRow("prov-pg-blank");
      assertEq(rowAfterRollback.products, null, "pg-r8e: products actually restored to null in the DB");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-products (section B): unexpected error: " + String(err?.stack || err?.message || err));
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
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-products.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProductsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
