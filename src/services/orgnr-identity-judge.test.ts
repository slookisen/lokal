/**
 * orgnr-identity-judge.test.ts — unit tests for judgeOrgnrIdentityMatch
 * (src/services/orgnr-identity-judge.ts), dev-request 2026-08-23-opplevagent-
 * drikke-selvforsyning-speiling, item 3 ("LLM-dommer-tier for mellom-
 * konfidens-køene", mirror of RFB Grep 3 slice 2, PR lokal#691).
 *
 * Mirrors contact-candidate-judge.test.ts's Section B (judgeContactCandidate
 * direct unit tests) structure and fetch-mocking convention exactly:
 * globalThis.fetch stubbed directly (this module always calls
 * api.anthropic.com, no dispatch needed), ANTHROPIC_API_KEY and
 * globalThis.fetch saved/restored around the section. Covers the exact
 * fail-closed contract judgeOrgnrIdentityMatch's own doc comment states
 * (identical to judgeContactCandidate's): missing ANTHROPIC_API_KEY, a
 * network failure, a non-200 response, unparseable JSON, or any model output
 * that isn't the EXACT GODKJENN/AVVIS token alone on its own first line ->
 * rejected, never thrown. Plus the two clean happy-path cases (GODKJENN /
 * AVVIS).
 *
 * This module's own call-site integration tests (proving POST
 * /admin/gardssalg-orgnr-review-judge in src/routes/opplevelser.ts actually
 * wires this judge in) live in
 * src/routes/opplevelser-gardssalg-orgnr-review-judge.test.ts — this file
 * covers judgeOrgnrIdentityMatch directly, not through the route.
 *
 * Sections:
 *   B. judgeOrgnrIdentityMatch — direct unit tests of the fail-closed
 *      fetch/parse contract (missing key / network throw / non-200 /
 *      unparseable JSON / ambiguous text / a clean approval / a clean
 *      rejection).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runOrgnrIdentityJudgeTests(
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
    const { judgeOrgnrIdentityMatch } = require("./orgnr-identity-judge") as
      typeof import("./orgnr-identity-judge");

    // ═══════════════════════════════════════════════════════════════════
    // Section B — judgeOrgnrIdentityMatch direct unit tests.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        const PARAMS = {
          providerName: "Solheim Sider",
          providerKommune: "Ullensvang",
          providerPoststed: "Lofthus",
          candidateName: "SOLHEIM SIDER AS",
          candidateAddress: "Lofthusvegen 1, 5781 Lofthus",
        };

        // ── b-1: missing ANTHROPIC_API_KEY -> approved:false, fetch NEVER
        //    invoked. ──────────────────────────────────────────────────────
        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("b-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-1: missing ANTHROPIC_API_KEY -> approved:false");
          assertTrue(/ANTHROPIC_API_KEY/.test(v.reason ?? ""), "b-1b: reason names the missing key");
        }

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── b-2: network throw -> approved:false, not re-thrown, reason
        //    mentions network/nettverksfeil. ────────────────────────────────
        globalThis.fetch = (async () => { throw new Error("simulated network failure"); }) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-2: fetch throw (network failure) -> approved:false, not re-thrown");
          assertTrue(/nettverksfeil/i.test(v.reason ?? ""), "b-2b: reason mentions nettverksfeil (network failure)");
        }

        // ── b-3: non-200 response -> approved:false. ───────────────────────
        globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-3: non-200 response -> approved:false");
          assertTrue(/500/.test(v.reason ?? ""), "b-3b: reason carries the status code");
        }

        // ── b-4: unparseable JSON body -> approved:false. ──────────────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-4: unparseable JSON response body -> approved:false");
        }

        // ── b-5: non-array content field -> approved:false, never throws. ──
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) })) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-5: non-array content field -> approved:false, not a thrown TypeError");
        }

        // ── b-6: ambiguous / garbage first line -> approved:false. ─────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hmm, maybe?" }] }) })) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-6: ambiguous/non-token model output -> approved:false, fail-closed");
          assertTrue(/tvetydig|uventet/i.test(v.reason ?? ""), "b-6b: reason notes the ambiguous/unexpected verdict");
        }

        // ── b-7: a clean, valid candidate, mocked GODKJENN -> approved:true.
        //    Also asserts the request contract. ─────────────────────────────
        let capturedUrl: any = null;
        let capturedInit: any = null;
        globalThis.fetch = (async (url: any, init: any) => {
          capturedUrl = url;
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nSamme produsent — navn og sted stemmer overens." }] }) };
        }) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, true, "b-7a: clean candidate + GODKJENN mock -> approved:true");
          assertEq(v.reason, "Samme produsent — navn og sted stemmer overens.", "b-7b: reason carried through from the mock response");
          assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "b-7c: calls the exact Anthropic messages endpoint");
          const body = JSON.parse(capturedInit.body);
          assertEq(body.model, "claude-haiku-4-5", "b-7d: model is claude-haiku-4-5");
          const prompt: string = body.messages[0].content;
          assertTrue(prompt.includes(PARAMS.providerName), "b-7e: prompt includes the provider name");
          assertTrue(prompt.includes(PARAMS.candidateName), "b-7f: prompt includes the candidate name");
          assertTrue(prompt.includes(PARAMS.candidateAddress), "b-7g: prompt includes the candidate address");
          assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "b-7h: x-api-key header carries ANTHROPIC_API_KEY");
        }

        // ── b-8: reject-token mock -> approved:false with a reason carried
        //    through. ──────────────────────────────────────────────────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nUlikt sted — sannsynligvis en annen virksomhet med samme navneord." }] }) })) as unknown as typeof fetch;
        {
          const v = await judgeOrgnrIdentityMatch(PARAMS);
          assertEq(v.approved, false, "b-8a: AVVIS mock -> approved:false");
          assertEq(v.reason, "Ulikt sted — sannsynligvis en annen virksomhet med samme navneord.", "b-8b: rejection reason carried through from the mock response");
        }
      } catch (err: any) {
        failed++;
        failures.push("orgnr-identity-judge (section B): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        globalThis.fetch = prevFetch;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOrgnrIdentityJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
