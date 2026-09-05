/**
 * dental-catalog-class-judge.test.ts — unit tests for judgeDentalCatalogClass
 * (src/services/dental-catalog-class-judge.ts), dev-request
 * 2026-09-02-dental-catalog-class-triage, slice 1c.
 *
 * Mirrors orgnr-identity-judge.test.ts's structure and fetch-mocking
 * convention exactly: globalThis.fetch stubbed directly (this module always
 * calls api.anthropic.com, no dispatch needed), ANTHROPIC_API_KEY and
 * globalThis.fetch saved/restored around the section. Covers the exact
 * fail-closed contract judgeDentalCatalogClass's own doc comment states:
 * missing ANTHROPIC_API_KEY, a network failure, a non-200 response,
 * unparseable JSON, or any model output that isn't an EXACT recognized
 * token alone on its own first line -> {verdict_class: "ukjent", ...},
 * never thrown. Plus each of the 6 valid tokens mapped correctly.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/dental-catalog-class-judge.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runDentalCatalogClassJudgeTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalCatalogClassJudgeTests(
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
    const { judgeDentalCatalogClass } = require("./dental-catalog-class-judge") as
      typeof import("./dental-catalog-class-judge");

    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    try {
      const PARAMS = {
        navn: "HØRSELSLABEN AS",
        naeringskode: "86.230",
        organisasjonsform: "AS",
        hjemmeside: "https://horselslaben.no",
        currentClass: "klinikk" as const,
      };

      // ── missing ANTHROPIC_API_KEY -> ukjent, fetch NEVER invoked ──────────
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("must NOT call fetch when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "missing ANTHROPIC_API_KEY -> ukjent");
        assertTrue(/ANTHROPIC_API_KEY/.test(v.reason), "reason names the missing key");
        assertTrue(/ukjent fail-closed/.test(v.reason), "reason ends with the fail-closed marker");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      // ── network throw -> ukjent, not re-thrown ────────────────────────────
      globalThis.fetch = (async () => { throw new Error("simulated network failure"); }) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "network throw -> ukjent, not re-thrown");
        assertTrue(/nettverksfeil/i.test(v.reason), "reason mentions nettverksfeil (network failure)");
      }

      // ── non-200 response -> ukjent ────────────────────────────────────────
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "non-200 response -> ukjent");
        assertTrue(/500/.test(v.reason), "reason carries the status code");
      }

      // ── unparseable JSON body -> ukjent ───────────────────────────────────
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "unparseable JSON response body -> ukjent");
      }

      // ── non-array content field -> ukjent, never throws ──────────────────
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "non-array content field -> ukjent, not a thrown TypeError");
      }

      // ── ambiguous / garbage first line -> ukjent ──────────────────────────
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hmm, maybe klinikk?" }] }) })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "ukjent", "ambiguous/non-token model output -> ukjent, fail-closed");
        assertTrue(/tvetydig|uventet/i.test(v.reason), "reason notes the ambiguous/unexpected verdict");
      }

      // ── each of the 6 valid tokens maps correctly, reason carried through ─
      const validTokens: Array<[string, string]> = [
        ["klinikk", "Reelt tannlegepraksis basert på navn og NACE."],
        ["offentlig_klinikk", "Fylkeskommunal tannklinikk."],
        ["person_enk", "Enkeltpersonforetak registrert under tannlegens eget navn."],
        ["lab_leverandor", "Tanntekniker-laboratorium, ikke en klinikk."],
        ["holding", "Holdingselskap, ikke en driftsklinikk."],
        ["not_a_clinic", "Dette er et høreapparatlaboratorium, ikke tannhelserelatert."],
      ];
      for (const [token, reasonText] of validTokens) {
        let capturedInit: any = null;
        globalThis.fetch = (async (_url: any, init: any) => {
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: `${token}\n${reasonText}` }] }) };
        }) as unknown as typeof fetch;
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, token, `valid token '${token}' maps to verdict_class '${token}'`);
        assertEq(v.reason, reasonText, `valid token '${token}' carries the reason text through`);
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", `'${token}' case: model is claude-haiku-4-5`);
      }

      // ── uppercase token still matches (case-insensitive first-line parse) ─
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "KLINIKK\nStor forbokstav." }] }) })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "klinikk", "uppercase KLINIKK token still parses to klinikk");
      }

      // ── request contract: prompt carries the row facts, x-api-key header ──
      let capturedUrl: any = null;
      let capturedInit2: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit2 = init;
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "not_a_clinic\nHøreapparatlaboratorium." }] }) };
      }) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass(PARAMS);
        assertEq(v.verdict_class, "not_a_clinic", "request-contract case: not_a_clinic verdict");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "calls the exact Anthropic messages endpoint");
        assertEq(capturedInit2.headers["x-api-key"], "test-anthropic-key", "x-api-key header carries ANTHROPIC_API_KEY");
        const prompt: string = JSON.parse(capturedInit2.body).messages[0].content;
        assertTrue(prompt.includes(PARAMS.navn), "prompt includes the row's navn");
        assertTrue(prompt.includes(PARAMS.naeringskode), "prompt includes the row's naeringskode");
        assertTrue(prompt.includes(PARAMS.organisasjonsform), "prompt includes the row's organisasjonsform");
        assertTrue(prompt.includes(PARAMS.hjemmeside), "prompt includes the row's hjemmeside URL string");
        assertTrue(prompt.includes(PARAMS.currentClass), "prompt includes the rule engine's current class for context");
        assertTrue(/not_a_clinic/.test(prompt) && /ukjent/.test(prompt), "prompt explains both not_a_clinic and ukjent");
      }

      // ── missing optional fields still produce a well-formed prompt ────────
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ukjent\nIngen sikre signaler." }] }) })) as unknown as typeof fetch;
      {
        const v = await judgeDentalCatalogClass({ navn: "UKJENT SELSKAP AS", currentClass: "ukjent" });
        assertEq(v.verdict_class, "ukjent", "minimal params (no nace/form/hjemmeside) still resolve cleanly");
      }
    } catch (err: any) {
      failed++;
      failures.push("dental-catalog-class-judge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runDentalCatalogClassJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
