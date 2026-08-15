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

import {
  generateGardssalgProductList,
  GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP,
  GARDSSALG_PRODUCTS_INVALID_SAMPLE_CHARS,
  gardssalgProductSourceText,
  gardssalgLabelLooksLikeProducts,
} from "./opplevelser";

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
        // Dropping "meny" from GARDSSALG_PRODUCT_PATH_SUBSTRINGS only changes
        // page ORDER — a small site's menu page still lands inside the
        // 20 000-character window, so the prompt is the part that actually
        // keeps Svensefjøset's "Røkelaks med pepperrotkrem" out of `products`.
        // Both halves are asserted because either alone leaves the hole open.
        assertTrue(
          body.messages[0].content.includes("Retter som serveres er IKKE produkter"),
          "pg-2j: prompt excludes served dishes from the product list",
        );
        assertTrue(
          ["selskapsmeny", "cateringmeny", "dagens rett", "buffet"].every((w) =>
            body.messages[0].content.includes(w),
          ),
          "pg-2k: prompt names the serving shapes it excludes, rather than relying on one word",
        );
        assertTrue(
          body.messages[0].content.includes("varer i utsalget"),
          "pg-2l: prompt still defines a product as goods sold — a gårdsbutikk's food is not excluded, only served dishes are",
        );
        // Belt half of the fence fix (Skive 6). The braces half —
        // gardssalgStripCodeFence — is asserted at pg-16/pg-17; neither is
        // trusted alone, same discipline as the prose path's markdown rule.
        assertTrue(
          body.messages[0].content.includes("ingen kodeblokk, ingen backticks"),
          "pg-2m: prompt asks for a bare JSON array — no markdown fence",
        );
      }
      // ── pg-2h (Skive 1): diagnosticOut.outcome = "products_found" when a
      //    valid non-empty array comes back. ────────────────────────────────
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, ["Eplesider", "Eplemost"], "pg-2h: valid array still returned unchanged with diagnosticOut passed");
        assertEq(diag.outcome, "products_found", "pg-2i: diagnosticOut.outcome = products_found for a valid array response");
      }

      // ── pg-3: source text capped in the prompt. Bound to the exported
      //    constant, not a literal: the cap moved once already (6 000 ->
      //    20 000, 2026-08-15) and a hardcoded number here just fails the
      //    build for the wrong reason next time. ─────────────────────────────
      {
        const hugeSource = "x".repeat(GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP * 2);
        await generateGardssalgProductList(hugeSource);
        const body = JSON.parse(capturedInit.body);
        const xRunLength = (body.messages[0].content.match(/x+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
        assertTrue(xRunLength <= GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP, "pg-3: source text is capped to the configured cap in the prompt");
        // Pins WHY the cap is the size it is, which a bare `<= CAP` cannot.
        // Oslo Brewing's crawled text measured 15 640 characters on
        // 2026-08-15, with its two product pages beyond the old 6 000 cap and
        // therefore invisible to the model. A cap below that reproduces the
        // exact bug this was raised to fix.
        assertTrue(
          GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP >= 15_640,
          "pg-3b: the cap still fits a whole measured producer site (Oslo Brewing, 15 640 chars)",
        );
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
        assertEq(diag.invalid_reason, "not_json", "pg-5e: prose is classified not_json, not lumped with the other three shapes");
        assertEq(diag.invalid_sample, "Vi selger Eplesider og Eplemost.", "pg-5f: the sample IS what came back — the whole point of Skive 5");
        assertEq(diag.stop_reason, null, "pg-5g: stop_reason is null when the API response carries none");
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
        assertEq(diag.invalid_reason, "not_array", "pg-6e: valid JSON, wrong shape → not_array (a prompt problem, not a truncation problem)");
        assertEq(diag.invalid_sample, '{"products":["Eplesider"]}', "pg-6f: the sample shows the shape that came back");
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
        assertEq(diag.invalid_reason, "empty_after_filter", "pg-7e: a well-formed array that yields no items is its own reason");
        assertEq(diag.invalid_sample, "[]", "pg-7f: a literal [] is visible as such, distinct from an array the filter emptied");
      }

      // ═══════════════════════════════════════════════════════════════════
      // Section A3 — Skive 5 (2026-08-15): what an unparseable response WAS.
      //
      // The PR #608 measurement produced four invalid_unparseable rows
      // (Hurum Bryggeri and Nordfjord Distillery among them, both of which had
      // returned products before) and not one of them could be explained,
      // because the outcome was recorded and the response was thrown away. The
      // leading hypothesis — max_tokens: 400 truncating a long list — was
      // arithmetic, not evidence. These fields are the evidence: after this
      // ships, `stop_reason: "max_tokens"` confirms it outright and
      // `stop_reason: "end_turn"` kills it, with no further deploy needed.
      // ═══════════════════════════════════════════════════════════════════

      // ── pg-11: the truncation shape itself. A 400-token ceiling cuts a long
      //    array mid-string, so what arrives is unterminated JSON — reason
      //    not_json, with stop_reason naming the cause outright. ─────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: '["Pils","Session IPA","Nordic Saison","Juleø' }],
          stop_reason: "max_tokens",
        }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-11a: a truncated array is still null — never a partial list written as if complete");
        assertEq(diag.invalid_reason, "not_json", "pg-11b: truncation surfaces as not_json");
        assertEq(diag.stop_reason, "max_tokens", "pg-11c: stop_reason carries the API's own verdict on truncation");
        assertTrue(
          typeof diag.invalid_sample === "string" && diag.invalid_sample.endsWith("Juleø"),
          "pg-11d: the sample shows the cut-off point, so 'was it truncated' is readable even without stop_reason",
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // Section A4 — Skive 6 (2026-08-15): the markdown code fence.
      //
      // This is not a hypothetical. It is what the Skive 5 diagnostic
      // reported on its first live run, on BOTH rows that had regressed:
      //   Hurum      end_turn  ```json [ "Hurums Pale Ale", …11 øl… ] ```
      //   Nordfjord  end_turn  ```json [ "Frisider eple", … ] ```
      // Complete, correct answers — thrown away because JSON.parse will not
      // accept three backticks. max_tokens was never involved (`end_turn` on
      // both), and is deliberately left alone.
      // ═══════════════════════════════════════════════════════════════════

      // ── pg-16: the exact Hurum response shape → parsed, not discarded. ───
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: '```json\n["Hurums Pale Ale","Meksikansk Lager","Stout","Weiss"]\n```' }],
          stop_reason: "end_turn",
        }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(
          r,
          ["Hurums Pale Ale", "Meksikansk Lager", "Stout", "Weiss"],
          "pg-16a: a fenced JSON array is read, not thrown away — the live Hurum regression",
        );
        assertEq(diag.outcome, "products_found", "pg-16b: outcome is products_found, not invalid_unparseable");
      }

      // ── pg-17: the fence variants, and the two that must NOT be stripped. ─
      {
        const cases: Array<[string, string[] | null, string]> = [
          ['```\n["Gin"]\n```', ["Gin"], "bare fence, no language tag"],
          ['```JSON\n["Gin"]\n```', ["Gin"], "upper-case language tag"],
          ['```json ["Gin"] ```', ["Gin"], "single-line fence, space-separated tag"],
          ['  ```json\n["Gin"]\n```  ', ["Gin"], "fence with surrounding whitespace"],
          ['["Gin"]', ["Gin"], "no fence at all — unchanged"],
          // Only a HALF fence: the answer is genuinely damaged (this is what a
          // real max_tokens cut would look like), so it must stay unparseable
          // rather than be coerced into half a list.
          ['```json\n["Gin","Vod', null, "unterminated fence stays unparseable"],
        ];
        for (const [text, expected, label] of cases) {
          globalThis.fetch = (async () => ({
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
          })) as unknown as typeof fetch;
          const r = await generateGardssalgProductList(SOURCE_TEXT);
          assertEq(r, expected, `pg-17: ${label}`);
        }
      }

      // ── pg-18: a FENCED sentinel is still an honest "no products", not a
      //    parse failure. Misfiling it would recreate exactly the confusion
      //    the Skive 1 buckets exist to prevent. ─────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "```\nINGEN_PRODUKTER_FUNNET\n```" }] }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-18a: a fenced sentinel is still null");
        assertEq(diag.outcome, "sentinel_no_products", "pg-18b: and is classified as an honest answer, not a defect");
      }

      // ── pg-19: when a fenced answer DOES fail, the sample still shows the
      //    fence. "What came back" must keep showing what came back. ────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: '```json\n{"produkter":["Gin"]}\n```' }], stop_reason: "end_turn" }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(diag.invalid_reason, "not_array", "pg-19a: unfenced, then judged on its actual shape");
        assertTrue(
          diag.invalid_sample?.startsWith("```json") === true,
          "pg-19b: the sample reports the RAW answer, fence included — never the post-processed version",
        );
      }

      // ── pg-12: no text block at all — the fourth path to
      //    invalid_unparseable, and the one with no model text to sample.
      //    Records the response shape instead of going blank. ────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "tool_use", id: "x" }], stop_reason: "tool_use" }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-12a: a response with no text block → null");
        assertEq(diag.invalid_reason, "no_text_block", "pg-12b: no text block is its own reason, not a parse failure");
        assertTrue(
          typeof diag.invalid_sample === "string" && diag.invalid_sample.includes("tool_use"),
          "pg-12c: with no model text to sample, the response's own shape is recorded instead",
        );
        assertEq(diag.stop_reason, "tool_use", "pg-12d: stop_reason is captured on this path too");
      }

      // ── pg-13: the sample is bounded and readable — ~200 chars, whitespace
      //    collapsed. A diagnostic must never carry a page of model output
      //    into a report, and a wall of newlines is not readable in one. ─────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Beklager,\n\n   jeg kan ikke.\t" + "z".repeat(500) }] }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(
          diag.invalid_sample?.length,
          GARDSSALG_PRODUCTS_INVALID_SAMPLE_CHARS,
          "pg-13a: the sample is capped at the exported constant, not an inline literal",
        );
        assertTrue(
          diag.invalid_sample?.startsWith("Beklager, jeg kan ikke. zzz") === true,
          "pg-13b: whitespace is collapsed to single spaces so the sample stays one readable line",
        );
      }

      // ── pg-14: the fields are ABSENT, not null/empty, on every outcome that
      //    is not a parse failure. A reader must never have to tell "no sample
      //    was taken" apart from "the sample was empty". ─────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: JSON.stringify(["Eplesider"]) }], stop_reason: "end_turn" }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(diag.outcome, "products_found", "pg-14a: a good response is still products_found");
        assertTrue(
          !("invalid_reason" in diag) && !("invalid_sample" in diag) && !("stop_reason" in diag),
          "pg-14b: no invalid_* / stop_reason keys are stamped on products_found",
        );
      }
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "INGEN_PRODUKTER_FUNNET" }] }),
      })) as unknown as typeof fetch;
      {
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(diag.outcome, "sentinel_no_products", "pg-14c: the sentinel is still sentinel_no_products");
        assertTrue(
          !("invalid_reason" in diag) && !("invalid_sample" in diag),
          "pg-14d: an honest 'no products' answer carries no failure sample",
        );
      }

      // ── pg-15: with the retry in play (Skive 4), the recorded evidence is
      //    the FINAL attempt's — the response whose failure actually produced
      //    the outcome, not the one that was already retried past. ───────────
      {
        let call = 0;
        globalThis.fetch = (async () => {
          call += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: [{ type: "text", text: call === 1 ? "FØRSTE FORSØK" : "ANDRE FORSØK" }],
              stop_reason: call === 1 ? "end_turn" : "max_tokens",
            }),
          };
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(call, 2, "pg-15a: an unparseable first attempt still triggers exactly one retry");
        assertEq(diag.invalid_sample, "ANDRE FORSØK", "pg-15b: the sample comes from the final attempt");
        assertEq(diag.stop_reason, "max_tokens", "pg-15c: stop_reason comes from the same attempt as the sample");
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
    // Section A2 — dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-
    // rader, Skive 4: retry-once on invalid_unparseable. The observed,
    // reproduced-live defect (Rabalder Sideri, 2026-08-12): the SAME row and
    // SAME cappedSource got products_found on one call and invalid_unparseable
    // on another moments later — pure LLM response-sampling non-determinism.
    // A manual immediate retry against the exact same row succeeded, which is
    // the evidence base for this fix.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SOURCE_TEXT = "Vi selger Eplesider, Eplemost og Pæremost rett fra gården. Åpent hver lørdag.";
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key-retry";

      // ── pg-14 (AK8): first mocked call returns unparseable/non-JSON text,
      //    second mocked call (the retry) returns valid JSON → the function
      //    returns the RETRY's products, and diagnosticOut.outcome reflects
      //    the retry's success, not the first attempt's failure. ───────────
      {
        let callCount = 0;
        globalThis.fetch = (async () => {
          callCount++;
          if (callCount === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ content: [{ type: "text", text: "Vi selger Eplesider og Eplemost." }] }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: JSON.stringify(["Eplesider", "Eplemost"]) }] }),
          } as unknown as Response;
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, ["Eplesider", "Eplemost"], "pg-14a (AK8): unparseable first attempt, valid-JSON retry → returns the retry's products");
        assertEq(diag.outcome, "products_found", "pg-14b (AK8): diagnosticOut.outcome = products_found after a successful retry");
        assertEq(callCount, 2, "pg-14c (AK8): exactly 2 API calls made (first attempt + the one retry)");
      }

      // ── pg-15 (AK9): BOTH mocked calls return unparseable text → the
      //    function returns null, outcome stays invalid_unparseable (exactly
      //    like today's single-attempt behavior — no new outcome value), and
      //    the mock was called EXACTLY 2 times, never a 3rd (hard cap of 1
      //    retry). ─────────────────────────────────────────────────────────
      {
        let callCount = 0;
        globalThis.fetch = (async () => {
          callCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "Vi selger Eplesider og Eplemost." }] }),
          } as unknown as Response;
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-15a (AK9): both attempts unparseable → null");
        assertEq(diag.outcome, "invalid_unparseable", "pg-15b (AK9): diagnosticOut.outcome stays invalid_unparseable when both attempts fail");
        assertEq(callCount, 2, "pg-15c (AK9): EXACTLY 2 API calls total — proves the hard cap, never a 3rd attempt");
      }

      // ── pg-16 (AK10): sentinel_no_products and infra_failure paths make
      //    exactly ONE API call each — no retry triggered — regression-
      //    securing that the retry ONLY applies to invalid_unparseable. ─────
      {
        let callCount = 0;
        globalThis.fetch = (async () => {
          callCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "INGEN_PRODUKTER_FUNNET" }] }),
          } as unknown as Response;
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-16a (AK10): sentinel response → null");
        assertEq(diag.outcome, "sentinel_no_products", "pg-16b (AK10): diagnosticOut.outcome = sentinel_no_products");
        assertEq(callCount, 1, "pg-16c (AK10): exactly 1 API call for the sentinel path — no retry");
      }
      {
        let callCount = 0;
        globalThis.fetch = (async () => {
          callCount++;
          throw new Error("simulated network failure");
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-16d (AK10): thrown fetch (infra failure) → null");
        assertEq(diag.outcome, "infra_failure", "pg-16e (AK10): diagnosticOut.outcome = infra_failure");
        assertEq(callCount, 1, "pg-16f (AK10): exactly 1 API call for the infra-failure path — no retry");
      }
      {
        let callCount = 0;
        globalThis.fetch = (async () => {
          callCount++;
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
        }) as unknown as typeof fetch;
        const diag: import("./opplevelser").GardssalgProductsExtractionDiagnostic = {};
        const r = await generateGardssalgProductList(SOURCE_TEXT, diag);
        assertEq(r, null, "pg-16g (AK10): non-2xx response (infra failure) → null");
        assertEq(diag.outcome, "infra_failure", "pg-16h (AK10): diagnosticOut.outcome = infra_failure");
        assertEq(callCount, 1, "pg-16i (AK10): exactly 1 API call for the non-2xx path — no retry");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-products (section A2 — Skive 4 retry): unexpected error: " + String(err?.stack || err?.message || err));
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
      // Skive 5: the row that comes back unparseable — the shape the PR #608
      // measurement produced four of and could not explain.
      insertProvider.run({
        id: "prov-pg-invalid", navn: "Prov PG Invalid Gard", hjemmeside: "https://prov-pg-invalid.example.no",
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
      // dev-request 2026-08-15-products-parser-kodegjerde, AC3: the row still
      // ENTERS the branch (gardssalgProductsEligible is checked every run) —
      // it's the eligibility check itself that now declines and reports why,
      // rather than the row vanishing from the diagnostic entirely.
      const secondDiag = secondRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-blank");
      assertTrue(!!secondDiag, "pg-r3e (AC3): prov-pg-blank STILL gets a products_diagnostic row once products is non-blank — every processed provider gets one");
      assertEq(secondDiag.outcome, "generator_not_invoked:products_already_present", "pg-r3f (AC3): outcome explains the generator was never invoked because products already has content");

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
      // dev-request 2026-08-15-products-parser-kodegjerde, AC3: the lock
      // guard short-circuits before ANY fetch, so this row now gets an
      // explicit generator_not_invoked:locked diagnostic row instead of
      // being silently absent — a locked provider is exactly the shape of
      // row a human running a drain/backfill needs explained, not hidden.
      const lockedDiag = lockedRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-locked");
      assertTrue(!!lockedDiag, "pg-r4f (AC3): a locked row now gets a products_diagnostic entry — every processed provider gets one, even one the lock guard never let past");
      assertEq(lockedDiag.outcome, "generator_not_invoked:locked", "pg-r4g (AC3): outcome explains the generator was never invoked because the row is locked");
      assertEq(lockedDiag.content_chars_full, 0, "pg-r4h (AC3): no fetch happened before the lock guard, so content_chars_full is zeroed, not fabricated");
      assertEq(lockedDiag.pages_fetched_paths, [], "pg-r4i (AC3): no sub-pages were fetched before the lock guard");

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
      // dev-request 2026-08-15-products-parser-kodegjerde, AC3: a fetched-
      // but-not-eligible row now gets a diagnostic entry too — with the real
      // content_chars_full/pages_fetched_paths from the fetch that DID
      // happen (unlike the pre-fetch gates, this one runs after a
      // successful fetch), proving knownStats is wired through correctly.
      const existingDiag = existingRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-existing");
      assertTrue(!!existingDiag, "pg-r5e (AC3): a row with pre-existing products still gets a products_diagnostic entry — gardssalgProductsEligible being false no longer means the row vanishes from the report");
      assertEq(existingDiag.outcome, "generator_not_invoked:products_already_present", "pg-r5f (AC3): outcome explains the generator was never invoked because products already has content");
      assertTrue(typeof existingDiag.content_chars_full === "number" && existingDiag.content_chars_full > 0, "pg-r5g (AC3): content_chars_full IS populated (real fetch happened) even though the generator was never invoked");
      assertEq(existingDiag.products_source_chars, 0, "pg-r5h (AC3): products_source_chars stays zeroed — gardssalgProductSourceText was never computed for this row");
      assertEq(existingDiag.product_pages, [], "pg-r5i (AC3): product_pages stays empty — no product-page ranking was ever done");

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
      assertTrue(
        !("invalid_reason" in noneDiag) && !("invalid_sample" in noneDiag),
        "pg-r7h (Skive 5): an honest sentinel row carries no failure sample in the report either",
      );

      // ── pg-r11 (Skive 5): the whole point, end to end. An unparseable
      //    response must reach the REPORT with its reason, its first ~200
      //    characters and the API's stop_reason — the three things the PR #608
      //    measurement needed and did not have. Nothing is written, exactly as
      //    before. ──────────────────────────────────────────────────────────
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              // A list cut off mid-string — what max_tokens: 400 produces.
              content: [{ type: "text", text: '["Pils",\n  "Session IPA",\n  "Nordic Sais' }],
              stop_reason: "max_tokens",
            }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        if (host === "prov-pg-invalid.example.no") {
          return {
            ok: true, status: 200, text: async () => plainPage,
            arrayBuffer: async () => new TextEncoder().encode(plainPage).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;
      const invalidRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-invalid"], apply: true },
      });
      assertEq(invalidRes.status, 200, "pg-r11a: unparseable-response provider call -> 200");
      assertEq(getProviderRow("prov-pg-invalid").products, null, "pg-r11b: nothing is written from an unparseable response — never a partial list");
      const invalidDiag = invalidRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-invalid");
      assertTrue(!!invalidDiag, "pg-r11c: the row appears in products_diagnostic");
      assertEq(invalidDiag.outcome, "invalid_unparseable", "pg-r11d: outcome is invalid_unparseable");
      assertEq(invalidDiag.invalid_reason, "not_json", "pg-r11e: the report says WHICH parse path failed");
      assertEq(invalidDiag.stop_reason, "max_tokens", "pg-r11f: the report carries the API's own stop_reason — this is what settles the truncation question");
      assertEq(
        invalidDiag.invalid_sample,
        '["Pils", "Session IPA", "Nordic Sais',
        "pg-r11g: the report carries what actually came back, on one readable line",
      );

      // ═══════════════════════════════════════════════════════════════════
      // Section B2 — AC3 (dev-request 2026-08-15-products-parser-kodegjerde):
      // products_diagnostic must carry a row for EVERY processed provider,
      // including the early-return/gate paths in processOne() that run
      // BEFORE the generator is ever invoked. Measured live: 3 of 4
      // processed providers in a targeted run had no diagnostic row at all
      // once the generator wasn't invoked — silently indistinguishable from
      // a row nobody looked at. pg-r3/pg-r4/pg-r5 above already cover the
      // idempotent-refill and manual-lock and pre-existing-products gates;
      // this section covers the three remaining gates.
      // ═══════════════════════════════════════════════════════════════════

      // ── pg-r12: the shared-/directory-domain guard is a PRE-FETCH gate —
      //    neither the homepage fetch nor the LLM may ever run for a row it
      //    excludes, and it still gets an explicit diagnostic row instead of
      //    vanishing. "visit*.no" is a real DMO domain pattern
      //    (gardssalgSharedDomainReason), so a single row is enough to
      //    trigger it — no second provider sharing a host needed. ──────────
      insertProvider.run({
        id: "prov-pg-shareddomain", navn: "Prov PG SharedDomain Gard", hjemmeside: "https://visitpgshared.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      {
        globalThis.fetch = (async () => {
          throw new Error("pg-r12: neither the homepage fetch nor the LLM should ever be called — the shared-/directory-domain guard short-circuits before both");
        }) as unknown as typeof fetch;
        const sharedRes = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-pg-shareddomain"], apply: true },
        });
        assertEq(sharedRes.status, 200, "pg-r12a: shared-domain-excluded provider call -> 200");
        assertTrue(
          sharedRes.body.excluded_shared_domain.some((e: any) => e.provider_id === "prov-pg-shareddomain"),
          "pg-r12b: reported in excluded_shared_domain, as before this change",
        );
        const sharedDiag = sharedRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-shareddomain");
        assertTrue(!!sharedDiag, "pg-r12c (AC3): a shared-/directory-domain-excluded row now gets a products_diagnostic entry — it never touched the network, but it was still a processed provider");
        assertEq(sharedDiag.outcome, "generator_not_invoked:excluded_shared_domain", "pg-r12d (AC3): outcome names the exact gate that short-circuited the row");
        assertEq(sharedDiag.content_chars_full, 0, "pg-r12e (AC3): no fetch ever happened, so content_chars_full is zeroed rather than fabricated");
        assertEq(sharedDiag.pages_fetched_paths, [], "pg-r12f (AC3): no sub-pages were fetched before this pre-fetch gate");
        assertEq(sharedDiag.product_pages, [], "pg-r12g (AC3): no product-page ranking was ever done");
      }

      // ── pg-r13: the website-verification gate is also a PRE-FETCH gate —
      //    a hjemmeside the verification sweep never stamped verified=true
      //    must never be fetched at all. ─────────────────────────────────
      insertProvider.run({
        id: "prov-pg-unverified", navn: "Prov PG Unverified Gard", hjemmeside: "https://prov-pg-unverified.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
        field_provenance: JSON.stringify({}),
      });
      {
        globalThis.fetch = (async () => {
          throw new Error("pg-r13: neither the homepage fetch nor the LLM should ever be called — the unverified-website gate short-circuits before both");
        }) as unknown as typeof fetch;
        const unverifiedRes = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-pg-unverified"], apply: true },
        });
        assertEq(unverifiedRes.status, 200, "pg-r13a: unverified-website provider call -> 200");
        assertTrue(
          unverifiedRes.body.excluded_unverified_website.some((e: any) => e.provider_id === "prov-pg-unverified"),
          "pg-r13b: reported in excluded_unverified_website, as before this change",
        );
        const unverifiedDiag = unverifiedRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-unverified");
        assertTrue(!!unverifiedDiag, "pg-r13c (AC3): an unverified-website row now gets a products_diagnostic entry");
        assertEq(unverifiedDiag.outcome, "generator_not_invoked:unverified_website", "pg-r13d (AC3): outcome names the exact gate that short-circuited the row");
        assertEq(unverifiedDiag.content_chars_full, 0, "pg-r13e (AC3): no fetch ever happened, so content_chars_full is zeroed rather than fabricated");
      }

      // ── pg-r14: a homepage that fails to fetch entirely (every request
      //    404s) never reaches the products branch either — the row still
      //    gets a diagnostic row explaining that the generator was never
      //    invoked, distinct from every other gate above. ─────────────────
      insertProvider.run({
        id: "prov-pg-fetchfail", navn: "Prov PG FetchFail Gard", hjemmeside: "https://prov-pg-fetchfail.example.no",
        content_source: null, about_text: SILENT_LONG_TEXT, visit_text: SILENT_LONG_TEXT, opening_hours_text: null, products: null,
      });
      {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            throw new Error("pg-r14: the LLM must never be called when the homepage fetch itself failed");
          }
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;
        const failRes = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-pg-fetchfail"], apply: true },
        });
        assertEq(failRes.status, 200, "pg-r14a: fetch-failed provider call -> 200");
        assertTrue(
          failRes.body.errors.some((e: any) => e.provider_id === "prov-pg-fetchfail"),
          "pg-r14b: reported in errors[], as before this change",
        );
        const failDiag = failRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-fetchfail");
        assertTrue(!!failDiag, "pg-r14c (AC3): a row whose homepage fetch failed now gets a products_diagnostic entry");
        assertEq(failDiag.outcome, "generator_not_invoked:fetch_failed", "pg-r14d (AC3): outcome names the exact gate that short-circuited the row — distinct from every pre-fetch gate above");
        assertEq(failDiag.content_chars_full, 0, "pg-r14e (AC3): the fetch never succeeded, so there is no content to report — zeroed, not fabricated");
      }

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
      // Built FROM the cap, so this boundary pair keeps testing the boundary
      // wherever the cap is set — see pg-3.
      const AT_CAP_PAGE = `<html><body><p>${"x".repeat(GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP)}</p></body></html>`;
      const OVER_CAP_PAGE = `<html><body><p>${"x".repeat(GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP + 1)}</p></body></html>`;
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
      assertEq(atCapDiag.products_source_full_chars, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP, "pg-r9c: products_source_full_chars is exactly the cap for a homepage body of exactly cap characters");
      assertEq(atCapDiag.truncated, false, "pg-r9d: truncated=false AT exactly the cap (cap is not > cap)");
      assertEq(atCapDiag.products_source_chars, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP, "pg-r9d2: nothing was sliced off — the model received the whole source");
      assertEq(atCapDiag.pages_fetched_paths, [], "pg-r9e: no sub-pages fetched (every candidate path 404s in this mock)");

      const overCapRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-pg-overcap"], apply: false },
      });
      assertEq(overCapRes.status, 200, "pg-r9f: over-cap provider call -> 200");
      const overCapDiag = overCapRes.body.products_diagnostic.find((d: any) => d.provider_id === "prov-pg-overcap");
      assertTrue(!!overCapDiag, "pg-r9g: prov-pg-overcap appears in products_diagnostic");
      assertEq(overCapDiag.products_source_full_chars, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP + 1, "pg-r9h: products_source_full_chars is exactly cap+1 for a homepage body of exactly cap+1 characters");
      assertEq(overCapDiag.products_source_chars, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP, "pg-r9h2: exactly the cap reached the model — one character was cut");
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

      // ── pg-src: which page the extractor reads FIRST ────────────────────
      //
      // Daniel, live session 2026-08-15. Of the 18 rows with a verified
      // website and no products, 12 came back `sentinel_no_products` — the
      // model answering honestly about text that never contained a product.
      // Fetching Oslo Brewing's own pages showed why: the front page is 7 406
      // characters on its own, `/ourbeer/` begins at 7 406 and `/products-2/`
      // at ~15 000. Both were crawled. Under a 6 000-character cap that slices
      // from the front, neither was ever read.
      //
      // Pure functions, no network, no DB — the ordering rule is the fix and
      // it is testable on its own.
      {
        // Every label here was observed live on 2026-08-15.
        for (const label of [
          "/produkter", "/nettbutikk", "/sortiment", "/vare-ol", "/ourbeer/",
          "/products-2/", "/butikken.php?lang=en", "/v-re-viner",
          "/produkter.php?lang=en",
        ]) {
          assertTrue(gardssalgLabelLooksLikeProducts(label), `pg-src1: ${label} reads as a product page`);
        }
        // The other side. `/om-bryggeriet` is the one that makes "brygg"
        // unusable as a keyword — it is an about page on nearly every brewery
        // site, and promoting it would push the real product page back out of
        // the window this exists to protect.
        //
        // `/menyer` and `/meny` moved here from the list above on 2026-08-15,
        // and this assertion is the regression guard for the one row PR #608's
        // measurement changed for the worse: Svensefjøset's `/menyer` is a
        // selskapsmeny (party catering), and promoting it turned a correct
        // "no products" into four dish names written into `products`. A menu
        // page is a different KIND of page, not a product page that happens to
        // rank low — see GARDSSALG_PRODUCT_PATH_SUBSTRINGS' comment.
        for (const label of [
          "/kontakt", "/kontakt-oss", "/om-oss", "/om-bryggeriet", "/historien",
          "/about", "/contact", "/history", "/", "/minnesamvaer",
          // `/vare-menyer` ("våre menyer") is the one that needed a veto rather
          // than a removal: `vare` is a product SEGMENT keyword (it exists for
          // `/vare-ol`), so this label matched through the possessive even
          // after "meny" left the substring list. `/produkt-meny` is the same
          // trap from the other direction — the veto wins over a product word.
          "/menyer", "/meny", "/selskapsmeny", "/vare-menyer", "/produkt-meny",
          "/catering", "/servering",
        ]) {
          assertTrue(!gardssalgLabelLooksLikeProducts(label), `pg-src2: ${label} is not mistaken for a product page`);
        }
        // A site that has BOTH: the menu page must not outrank the real
        // product page, and must not outrank the homepage either.
        const bothPages = gardssalgProductSourceText(
          [
            { label: "/menyer", text: "MENY Roastbiff Brie" },
            { label: "/", text: "HJEM" },
            { label: "/produkter", text: "PRODUKTER Pils" },
          ],
          100_000,
        );
        assertTrue(
          bothPages.text.indexOf("PRODUKTER") < bothPages.text.indexOf("HJEM") &&
            bothPages.text.indexOf("HJEM") < bothPages.text.indexOf("MENY"),
          "pg-src10: a menu page ranks with the rest — behind the product page AND behind the homepage",
        );

        // The Oslo Brewing shape, to scale: a front page that fills the whole
        // budget on its own, with the product page crawled AFTER it.
        const front = "F".repeat(7_406);
        const beer = "Pils Session IPA Nordic Saison " + "B".repeat(2_000);
        const contact = "C".repeat(1_000);
        const ordered = gardssalgProductSourceText(
          [
            { label: "/", text: front },
            { label: "/kontakt", text: contact },
            { label: "/ourbeer/", text: beer },
          ],
          6_000, // the OLD cap — the fix must hold even at the size that broke
        );
        assertTrue(
          ordered.text.startsWith("Pils Session IPA Nordic Saison"),
          "pg-src3: the product page leads the source text, so the product names survive the cap",
        );
        // Checked with a generous cap, deliberately: at the 6 000 above the
        // front page alone fills the budget, so "contact is absent" would pass
        // whether or not anything was reordered. This pins the ORDER itself —
        // product page, then homepage, then the rest.
        const wholeOrdering = gardssalgProductSourceText(
          [
            { label: "/", text: front },
            { label: "/kontakt", text: contact },
            { label: "/ourbeer/", text: beer },
          ],
          100_000,
        );
        assertTrue(
          wholeOrdering.text.indexOf("Pils") <
            wholeOrdering.text.indexOf("F".repeat(100)) &&
            wholeOrdering.text.indexOf("F".repeat(100)) <
              wholeOrdering.text.indexOf("C".repeat(100)),
          "pg-src4: product page, then homepage, then the rest — the contact page is what gets cut when the budget runs out",
        );
        assertEq(
          ordered.fullChars,
          [front, beer, contact].map((s) => s.length).reduce((a, b) => a + b, 0) + 4,
          "pg-src5: fullChars measures the whole ordered source (plus its two \n\n joins), not the truncated slice",
        );
        assertEq(ordered.text.length, 6_000, "pg-src6: the returned text respects the cap it was given");

        // Homepage second, not first: it is where a producer says who they
        // are, which helps read a product list, but it is rarely the list.
        const withoutProductPage = gardssalgProductSourceText([
          { label: "/kontakt", text: "KONTAKT" },
          { label: "/", text: "HJEM" },
          { label: "/om-oss", text: "OM" },
        ]);
        assertTrue(
          withoutProductPage.text.startsWith("HJEM"),
          "pg-src7: with no product page, the homepage leads",
        );
        assertTrue(
          withoutProductPage.text.indexOf("KONTAKT") < withoutProductPage.text.indexOf("OM"),
          "pg-src8: the remaining pages keep their crawl order — same site, same source text, every run",
        );
        assertEq(
          gardssalgProductSourceText([{ label: "/", text: "   " }, { label: "/produkter", text: "Gin" }]).text,
          "Gin",
          "pg-src9: a blank page contributes nothing — no leading separator burning the budget",
        );
      }
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
