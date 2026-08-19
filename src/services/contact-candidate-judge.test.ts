/**
 * contact-candidate-judge.test.ts — direct unit tests for the shared
 * backstop-classifier + LLM-judge gate (dev-request 2026-08-19-rfb-kontakt-
 * llm-dommer follow-on, "Grep 5b") that extends PR #655's contact-quality
 * gate (marketplace.ts's classifyRfbContactCandidateDefect/
 * judgeRfbContactCandidate/gateRfbContactCandidates, scoped to RFB's
 * homepage-provenance-batch write path only) to the four other write paths:
 *
 *   - applyGardssalgProviderContact (services/experience-store.ts)
 *   - the domain_match branch of POST /admin/gardssalg-autosvar-apply
 *     (routes/opplevelser.ts)
 *   - applyRfbCxWrite's call site (routes/admin-rfb-contact-extraction.ts)
 *   - applyAgentBrregContact (routes/admin-agents.ts)
 *
 * Each of those four write paths already has its own end-to-end coverage
 * (in opplevelser-gardssalg-contact-backfill.test.ts, opplevelser-gardssalg-
 * contact-extraction.test.ts, opplevelser-gardssalg-autosvar-apply.test.ts,
 * admin-rfb-contact-extraction.test.ts and admin-agents-brreg-contact-
 * backfill.test.ts respectively) proving a W34-pattern candidate is NOT
 * written and a genuine candidate STILL is, through the real production
 * write function with a real in-memory DB. THIS file instead exercises the
 * shared gate module directly and in isolation — mirrors marketplace-rfb-
 * contact-judge.test.ts's Section A/B/C structure exactly (no DB/route
 * fixtures needed for these):
 *
 *   A. classifyContactCandidateDefect — pure, no mocks: the reachable phone
 *      backstop checks (repeated-digit run, sequential run), the email
 *      checks (favicon local part, icon-extension TLD, unparseable shape),
 *      normal-looking values that must NOT be flagged, and the `address`
 *      fieldType's honest no-op (see the module's own "Honesty note").
 *   B. judgeContactCandidate — direct unit tests of the fail-closed fetch
 *      contract (missing key / network throw / non-200 / unparseable JSON /
 *      ambiguous verdict / a clean GODKJENN, including the address field
 *      label and the address-specific known-bad-patterns text) — mirrors
 *      judgeRfbContactCandidate's own test section.
 *   C. gateContactCandidate — composition: a backstop-rejected candidate
 *      never reaches the LLM call at all (cost control); a judge-rejected
 *      candidate that cleared the backstop still ends up null; a candidate
 *      clearing both is passed through verbatim.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/contact-candidate-judge.test.ts
 *   2. Wired into the gate via tests/test.ts (folds pass/fail into `npm test`).
 */

import {
  classifyContactCandidateDefect,
  judgeContactCandidate,
  gateContactCandidate,
} from "./contact-candidate-judge";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runContactCandidateJudgeTests(
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
    // ═══════════════════════════════════════════════════════════════════
    // Section A — classifyContactCandidateDefect (pure, no mocks).
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── phone: repeated-digit run ───────────────────────────────────────
      const repeatedRun = classifyContactCandidateDefect("phone", "23222222");
      assertEq(repeatedRun.defective, true, "a-1: 8-digit candidate with a 6+ repeated-digit run -> defective");
      assertTrue(/repeat/i.test(repeatedRun.reason ?? ""), "a-2: reason mentions the repeated-digit run");
      const shortRepeat = classifyContactCandidateDefect("phone", "23222212");
      assertEq(shortRepeat.defective, false, "a-3: only a 5-run repeat stays under the threshold -> NOT defective");

      // ── phone: sequential run ───────────────────────────────────────────
      const ascending = classifyContactCandidateDefect("phone", "23456789");
      assertEq(ascending.defective, true, "a-4: strictly ascending 8-digit run -> defective");
      assertTrue(/sequential/i.test(ascending.reason ?? ""), "a-5: reason mentions the sequential run");
      const descending = classifyContactCandidateDefect("phone", "98765432");
      assertEq(descending.defective, true, "a-6: strictly descending 8-digit run -> also defective");

      // ── phone: normal values must NOT be flagged ────────────────────────
      assertEq(classifyContactCandidateDefect("phone", "92345678").defective, false, "a-7: a plain 8-digit phone number -> NOT defective");
      assertEq(classifyContactCandidateDefect("phone", "+47 400 12 345").defective, false, "a-8: a +47-prefixed phone number (not pure-digit) -> NOT defective");
      assertEq(classifyContactCandidateDefect("phone", "45123678").defective, false, "a-9: a random-looking 8-digit number -> NOT defective");

      // ── email: W34 favicon-filename shape ───────────────────────────────
      const favicon = classifyContactCandidateDefect("email", "favicon@2x.png");
      assertEq(favicon.defective, true, "a-10: 'favicon@2x.png' as an email candidate -> defective");
      assertTrue(/favicon|icon/i.test(favicon.reason ?? ""), "a-11: reason mentions favicon/icon");
      assertEq(classifyContactCandidateDefect("email", "apple-touch-icon@180x180.png").defective, true, "a-12: another icon-filename-derived candidate -> also defective");

      // ── email: structural guards ────────────────────────────────────────
      assertEq(classifyContactCandidateDefect("email", "not-an-email").defective, true, "a-13: no '@' at all -> defective");
      assertEq(classifyContactCandidateDefect("email", "user@nodottld").defective, true, "a-14: no domain TLD -> defective");
      assertEq(classifyContactCandidateDefect("email", "").defective, false, "a-15: empty candidate -> not defective (blank is fill-only's job, not this classifier's)");

      // ── email: normal values must NOT be flagged ────────────────────────
      assertEq(classifyContactCandidateDefect("email", "kontakt@gardsbutikk.no").defective, false, "a-16: a normal-looking email -> NOT defective");
      assertEq(classifyContactCandidateDefect("email", "post@gaard.gmail.com").defective, false, "a-17: a multi-label domain -> NOT defective");

      // ── address: honest no-op (see the module's own "Honesty note") ─────
      assertEq(classifyContactCandidateDefect("address", "Gårdsveien 12, 1234 Sted").defective, false, "a-18: a normal address -> not defective (no structural check exists)");
      assertEq(classifyContactCandidateDefect("address", "N/A").defective, false, "a-19: even an obvious placeholder address -> not defective by the BACKSTOP (the LLM judge is the only line of defense for address — see Section B/C)");
      assertEq(classifyContactCandidateDefect("address", "").defective, false, "a-20: empty address candidate -> not defective");
    } catch (err: any) {
      failed++;
      failures.push("contact-candidate-judge (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — judgeContactCandidate direct unit tests.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        const CANDIDATE = "92345678";
        const CONTEXT = "Kontakt oss: Ring oss på 92 34 56 78 mandag til fredag.";
        const BUSINESS = "Testgard AS";

        // ── b-1: missing ANTHROPIC_API_KEY -> approved:false, fetch NEVER invoked.
        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("b-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-1: missing ANTHROPIC_API_KEY -> approved:false");
        }

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── b-2: network throw -> approved:false, not re-thrown. ────────────
        globalThis.fetch = (async () => {
          throw new Error("simulated network failure");
        }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-2: fetch throw (network failure) -> approved:false, not re-thrown");
        }

        // ── b-3: non-200 response -> approved:false. ────────────────────────
        globalThis.fetch = (async () => ({
          ok: false, status: 500, json: async () => ({ error: "boom" }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-3: non-200 response -> approved:false");
        }

        // ── b-4: unparseable JSON body -> approved:false. ───────────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => { throw new Error("not json"); },
        })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-4: unparseable JSON response body -> approved:false");
        }

        // ── b-5: non-array content field -> approved:false, never throws. ───
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-5: non-array content field -> approved:false, not a thrown TypeError");
        }

        // ── b-6: ambiguous/garbage first line -> approved:false. ────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hmm, maybe?" }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-6: ambiguous/non-token model output -> approved:false, fail-closed");
        }

        // ── b-7: a clean phone candidate, mocked GODKJENN -> approved:true.
        //    Also asserts the request contract: endpoint, model, x-api-key
        //    header, and that the prompt teaches the model the known
        //    bad-candidate shapes for phone/email. ───────────────────────────
        let capturedUrl: any = null;
        let capturedInit: any = null;
        globalThis.fetch = (async (url: any, init: any) => {
          capturedUrl = url;
          capturedInit = init;
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nDette er et ekte telefonnummer for virksomheten." }] }),
          };
        }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, true, "b-7a: clean candidate + GODKJENN mock -> approved:true");
          assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "b-7b: calls the exact Anthropic messages endpoint");
          const body = JSON.parse(capturedInit.body);
          assertEq(body.model, "claude-haiku-4-5", "b-7c: model is claude-haiku-4-5");
          const prompt: string = body.messages[0].content;
          assertTrue(prompt.includes(BUSINESS), "b-7d: prompt includes the business name");
          assertTrue(prompt.includes(CANDIDATE), "b-7e: prompt includes the candidate value");
          assertTrue(prompt.includes(CONTEXT), "b-7f: prompt includes the source context");
          assertTrue(/hex|farge/i.test(prompt), "b-7g: prompt teaches the CSS-hex-color failure mode for phone");
          assertTrue(/app id|facebookappid|fbappid/i.test(prompt), "b-7h: prompt teaches the Facebook App ID failure mode for phone");
          assertTrue(/favicon/i.test(prompt), "b-7i: prompt teaches the favicon-filename failure mode for phone/email");
          assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "b-7j: x-api-key header carries ANTHROPIC_API_KEY");
        }

        // ── b-8: address field label + address-specific known-bad-patterns
        //    text (no CSS-hex/App-ID text — those are phone/email-only). ─────
        {
          await judgeContactCandidate({ fieldType: "address", candidate: "N/A", sourceContext: CONTEXT, businessName: BUSINESS });
          const body = JSON.parse(capturedInit.body);
          const prompt: string = body.messages[0].content;
          assertTrue(prompt.includes("adresse"), "b-8a: prompt uses the 'adresse' field label for an address candidate");
          assertTrue(/plassholder|N\/A|Ukjent/i.test(prompt), "b-8b: prompt teaches an address-specific known-bad-pattern (placeholder text)");
          assertTrue(!/CSS-fargekode/i.test(prompt), "b-8c: prompt does NOT include the phone/email-only CSS-hex-color pattern for an address candidate");
        }

        // ── b-9: source context capped to a reasonable length in the prompt
        //    (not passed through unbounded). ────────────────────────────────
        {
          const hugeContext = "y".repeat(20000);
          await judgeContactCandidate({ fieldType: "email", candidate: "kontakt@gardsbutikk.no", sourceContext: hugeContext, businessName: BUSINESS });
          const body = JSON.parse(capturedInit.body);
          const yRunLength = (body.messages[0].content.match(/y+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
          assertTrue(yRunLength <= 4000, "b-9: source context is capped (<= 4000 chars) in the prompt, not passed through unbounded");
        }

        // ── b-10: reject-token mock -> approved:false with a reason. ────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette ser ut som sidestøy, ikke et telefonnummer." }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-10a: AVVIS mock -> approved:false");
          assertTrue(!!v.reason && v.reason.length > 0, "b-10b: rejection carries a reason");
        }
      } catch (err: any) {
        failed++;
        failures.push("contact-candidate-judge (section B): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        globalThis.fetch = prevFetch;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — gateContactCandidate composition.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── c-1: a backstop-rejected candidate never reaches the LLM call at
        //    all (cost control). ─────────────────────────────────────────────
        globalThis.fetch = (async () => {
          throw new Error("c-1: judge must NOT be called for a backstop-rejected candidate");
        }) as unknown as typeof fetch;
        {
          const g = await gateContactCandidate({
            fieldType: "phone", candidate: "23456789", sourceContext: "some page text", businessName: "Austrått Kaffebrenneri",
          });
          assertEq(g.value, null, "c-1a: sequential-digit-run phone candidate -> gated value is null");
          assertTrue(!!g.rejectedReason && /backstop/i.test(g.rejectedReason), "c-1b: rejection reason attributes this to the backstop classifier");
        }

        // ── c-2: a candidate that clears the backstop but is rejected by the
        //    LLM judge -> null, with a judge-attributed reason. ─────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy, ikke et telefonnummer for denne virksomheten." }] }),
        })) as unknown as typeof fetch;
        {
          const g = await gateContactCandidate({
            fieldType: "phone", candidate: "92345678", sourceContext: "some page text", businessName: "Li Lynghonning",
          });
          assertEq(g.value, null, "c-2a: LLM-rejected (but structurally clean) phone candidate -> gated value is null");
          assertTrue(!!g.rejectedReason && /llm judge/i.test(g.rejectedReason), "c-2b: rejection reason attributes this to the LLM judge");
        }

        // ── c-3: a candidate that clears BOTH -> passed through verbatim,
        //    for all three fieldTypes. ──────────────────────────────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for virksomheten." }] }),
        })) as unknown as typeof fetch;
        {
          const gPhone = await gateContactCandidate({ fieldType: "phone", candidate: "92345678", sourceContext: "Ring oss på 92 34 56 78", businessName: "Testgard AS" });
          assertEq(gPhone.value, "92345678", "c-3a: phone candidate clearing both gates -> passed through");
          const gEmail = await gateContactCandidate({ fieldType: "email", candidate: "post@testgard.no", sourceContext: "post@testgard.no", businessName: "Testgard AS" });
          assertEq(gEmail.value, "post@testgard.no", "c-3b: email candidate clearing both gates -> passed through");
          const gAddress = await gateContactCandidate({ fieldType: "address", candidate: "Gårdsveien 12, 1234 Sted", sourceContext: "Brreg lookup", businessName: "Testgard AS" });
          assertEq(gAddress.value, "Gårdsveien 12, 1234 Sted", "c-3c: address candidate clearing both gates -> passed through (backstop is a no-op, LLM approved)");
          assertEq(gPhone.rejectedReason, undefined, "c-3d: no rejection reason on an approved candidate");
        }

        // ── c-4: an address candidate rejected by the LLM (the ONLY line of
        //    defense for address — see the module's own "Honesty note"). ────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som en plassholderadresse, ikke en ekte gateadresse." }] }),
        })) as unknown as typeof fetch;
        {
          const g = await gateContactCandidate({ fieldType: "address", candidate: "N/A", sourceContext: "Brreg lookup", businessName: "LOKAL Matkvartalet Hamar" });
          assertEq(g.value, null, "c-4a: LLM-rejected address candidate -> gated value is null (the backstop alone would have let 'N/A' through — see a-19)");
          assertTrue(!!g.rejectedReason && /llm judge/i.test(g.rejectedReason), "c-4b: rejection reason attributes this to the LLM judge");
        }
      } catch (err: any) {
        failed++;
        failures.push("contact-candidate-judge (section C): unexpected error: " + String(err?.stack || err?.message || err));
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
  runContactCandidateJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
