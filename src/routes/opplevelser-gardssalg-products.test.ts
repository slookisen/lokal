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
        assertEq(body.model, "claude-opus-4-8", "pg-2c: model is claude-opus-4-8");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(SOURCE_TEXT), "pg-2d: prompt includes the source text");
        assertTrue(body.messages[0].content.includes("INGEN_PRODUKTER_FUNNET"), "pg-2e: prompt includes the escape sentinel instruction");
        assertTrue(body.messages[0].content.includes("Bruk KUN produktnavn som faktisk står i kildeteksten"), "pg-2f: prompt includes the exact grounding instruction");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "pg-2g: x-api-key header carries ANTHROPIC_API_KEY");
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
    const testKey = "gardssalg-products-test-key";
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

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

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
          return { ok: true, status: 200, text: async () => plainPage } as unknown as Response;
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
          return { ok: true, status: 200, text: async () => plainPage } as unknown as Response;
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
