/**
 * contact-candidate-judge.test.ts — unit tests for the shared LLM-judge +
 * deterministic-backstop gate (dev-request 2026-08-19-kursjustering-
 * drikkefunnel-llm-og-supply, "Grep 5b") that src/services/experience-store.
 * ts, src/routes/opplevelser.ts, src/routes/admin-rfb-contact-extraction.ts
 * and src/routes/admin-agents.ts all now call before writing a contact
 * field. Mirrors marketplace-rfb-contact-judge.test.ts's structure and
 * fetch-mocking convention exactly (globalThis.fetch stubbed, dispatching
 * on whether the URL contains "api.anthropic.com"; ANTHROPIC_API_KEY and
 * globalThis.fetch saved/restored around each section) — this module's own
 * call-site integration tests (proving each of the four write sites
 * actually wires the gate in) live NEAR each site's existing test file
 * instead of here; see:
 *   - src/routes/opplevelser-gardssalg-contact-backfill.test.ts (section aa)
 *   - src/routes/opplevelser-gardssalg-autosvar-apply.test.ts (section h)
 *   - src/routes/admin-rfb-contact-extraction.test.ts (sections p, q)
 *   - src/routes/admin-agents-brreg-contact-backfill.test.ts (section v)
 *
 * Sections:
 *   A. classifyContactCandidateDefect — pure, no mocks. Phone: reachable
 *      repeated-digit-run / sequential-digit-run checks (the shapes every
 *      real extractor in this codebase — extractGardssalgContactPhone,
 *      fetchBrregContact's telefon/mobil — can actually hand it, mirroring
 *      the "honesty" fix marketplace.ts's own classifier went through).
 *      Email: favicon/icon-filename local part + icon-extension domain
 *      (the W34 shape), plus basic structural parsing. Address: always
 *      {defective:false} — no independent structural signal exists for
 *      free-text addresses, by design (see the function's own doc
 *      comment) — detection is the LLM judge's job alone for that field.
 *   B. judgeContactCandidate — direct unit tests of the fail-closed
 *      fetch/parse contract (missing key / network throw / non-200 /
 *      unparseable JSON / ambiguous text / a clean approval / a clean
 *      rejection), for all three field types.
 *   C. gateContactCandidates — composition: backstop-rejected candidates
 *      never reach the LLM call (cost control); judge-rejected candidates
 *      that cleared the backstop still end up null; independent per-field
 *      gating (one field rejected does not block a sibling field in the
 *      same call); all-optional-fields contract (a call site that only has
 *      a candidate for one or two of the three fields never triggers a
 *      judge call for the field(s) it didn't pass a candidate for).
 */

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
    const {
      classifyContactCandidateDefect,
      judgeContactCandidate,
      gateContactCandidates,
    } = require("./contact-candidate-judge") as typeof import("./contact-candidate-judge");

    // ═══════════════════════════════════════════════════════════════════
    // Section A — classifyContactCandidateDefect (pure, no mocks).
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── Reachable phone backstop check #1: long repeated-digit run ─────
      const repeatedRunVerdict = classifyContactCandidateDefect("phone", "55555555");
      assertEq(repeatedRunVerdict.defective, true, "a-1: 8-digit candidate that's an 8-in-a-row repeated digit -> defective");
      assertTrue(/repeat/i.test(repeatedRunVerdict.reason ?? ""), "a-2: reason mentions the repeated-digit run");
      const partialRepeatVerdict = classifyContactCandidateDefect("phone", "23222222");
      assertEq(partialRepeatVerdict.defective, true, "a-3: a PARTIAL (6+) repeated-digit run is also defective");
      const shortRepeatVerdict = classifyContactCandidateDefect("phone", "23222212");
      assertEq(shortRepeatVerdict.defective, false, "a-4: a 5-run repeat stays under the threshold -> NOT defective");

      // ── Reachable phone backstop check #2: sequential digit run ────────
      const ascendingVerdict = classifyContactCandidateDefect("phone", "23456789");
      assertEq(ascendingVerdict.defective, true, "a-5: strictly ascending 8-digit run -> defective");
      assertTrue(/sequential/i.test(ascendingVerdict.reason ?? ""), "a-6: reason mentions the sequential run");
      const descendingVerdict = classifyContactCandidateDefect("phone", "98765432");
      assertEq(descendingVerdict.defective, true, "a-7: strictly descending 8-digit run -> also defective");

      // ── Normal, legitimate phone candidates must NOT be flagged ─────────
      assertEq(classifyContactCandidateDefect("phone", "92345678").defective, false, "a-8: a plain, non-repeating, non-sequential 8-digit phone -> NOT defective");
      assertEq(classifyContactCandidateDefect("phone", "+47 400 12 345").defective, false, "a-9: a +47-prefixed formatted phone -> NOT defective (left to the LLM judge, same as upstream)");

      // ── Email: W34 favicon-filename shape ───────────────────────────────
      const faviconVerdict = classifyContactCandidateDefect("email", "favicon@2x.png");
      assertEq(faviconVerdict.defective, true, "a-10: 'favicon@2x.png' as an email candidate -> defective");
      assertTrue(/favicon|icon/i.test(faviconVerdict.reason ?? ""), "a-11: reason mentions favicon/icon");
      assertEq(classifyContactCandidateDefect("email", "apple-touch-icon@180x180.png").defective, true, "a-12: another icon-filename-derived candidate -> also defective");
      assertEq(classifyContactCandidateDefect("email", "not-an-email").defective, true, "a-13: no '@' at all -> defective");
      assertEq(classifyContactCandidateDefect("email", "").defective, false, "a-14: empty candidate -> not defective (blank is fill-only's job, not this classifier's)");
      assertEq(classifyContactCandidateDefect("email", "kontakt@gardsbutikk.no").defective, false, "a-15: a normal-looking email -> NOT defective");

      // ── Address: always a pass-through — no independent structural
      //    signal exists for free-text addresses (see the function's own
      //    doc comment); detection is the LLM judge's job alone. ─────────
      assertEq(classifyContactCandidateDefect("address", "Gårdsveien 12, 1601 Sarpsborg").defective, false, "a-16: a normal address -> NOT defective (backstop has nothing to check)");
      assertEq(classifyContactCandidateDefect("address", "facebookAppId: 1234567890123456").defective, false, "a-17: even an obviously-wrong address-shaped string is NOT caught by the backstop — honestly a judge-only gap, not a silent double-cover claim");
      assertEq(classifyContactCandidateDefect("address", "").defective, false, "a-18: empty address candidate -> not defective");
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

        // ── b-1: missing ANTHROPIC_API_KEY -> approved:false, fetch NEVER
        //    invoked. ──────────────────────────────────────────────────────
        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("b-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-1: missing ANTHROPIC_API_KEY -> approved:false");
        }

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── b-2: network throw -> approved:false, not re-thrown. ───────────
        globalThis.fetch = (async () => { throw new Error("simulated network failure"); }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-2: fetch throw (network failure) -> approved:false, not re-thrown");
        }

        // ── b-3: non-200 response -> approved:false. ───────────────────────
        globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-3: non-200 response -> approved:false");
        }

        // ── b-4: unparseable JSON body -> approved:false. ──────────────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-4: unparseable JSON response body -> approved:false");
        }

        // ── b-5: non-array content field -> approved:false, never throws. ──
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }) })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-5: non-array content field -> approved:false, not a thrown TypeError");
        }

        // ── b-6: ambiguous / garbage first line -> approved:false. ─────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hmm, maybe?" }] }) })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-6: ambiguous/non-token model output -> approved:false, fail-closed");
        }

        // ── b-7: a clean, valid PHONE candidate, mocked GODKJENN ->
        //    approved:true. Also asserts the request contract. ─────────────
        let capturedUrl: any = null;
        let capturedInit: any = null;
        globalThis.fetch = (async (url: any, init: any) => {
          capturedUrl = url;
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nDette er et ekte telefonnummer for produsenten." }] }) };
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
          assertTrue(/hex|farge/i.test(prompt), "b-7g: prompt teaches the CSS-hex-color failure mode");
          assertTrue(/app id|facebookappid|fbappid/i.test(prompt), "b-7h: prompt teaches the Facebook App ID failure mode");
          assertTrue(/favicon/i.test(prompt), "b-7i: prompt teaches the favicon-filename failure mode");
          assertTrue(/telefonnummer/i.test(prompt), "b-7j: prompt uses the Norwegian phone field label");
          assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "b-7k: x-api-key header carries ANTHROPIC_API_KEY");
        }

        // ── b-8: source context capped to a reasonable length in the
        //    prompt (not passed through unbounded). ────────────────────────
        {
          const hugeContext = "y".repeat(20000);
          await judgeContactCandidate({ fieldType: "email", candidate: "kontakt@gardsbutikk.no", sourceContext: hugeContext, businessName: BUSINESS });
          const body = JSON.parse(capturedInit.body);
          const yRunLength = (body.messages[0].content.match(/y+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
          assertTrue(yRunLength <= 4000, "b-8: source context is capped (<= 4000 chars) in the prompt, not passed through unbounded");
        }

        // ── b-9: reject-token mock -> approved:false with a reason. ─────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette ser ut som sidestøy." }] }) })) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({ fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS });
          assertEq(v.approved, false, "b-9a: AVVIS mock -> approved:false");
          assertTrue(!!v.reason && v.reason.length > 0, "b-9b: rejection carries a reason");
        }

        // ── b-10: ADDRESS field type — prompt uses the Norwegian "adresse"
        //    label and teaches the address-specific failure mode (third-
        //    party/umbrella-org address misattribution). ────────────────────
        globalThis.fetch = (async (url: any, init: any) => {
          capturedInit = init;
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nOK." }] }) };
        }) as unknown as typeof fetch;
        {
          const v = await judgeContactCandidate({
            fieldType: "address", candidate: "Gårdsveien 12, 1601 Sarpsborg",
            sourceContext: "Brreg forretningsadresse", businessName: BUSINESS,
          });
          assertEq(v.approved, true, "b-10a: a clean address candidate + GODKJENN mock -> approved:true");
          const prompt: string = JSON.parse(capturedInit.body).messages[0].content;
          assertTrue(/adresse/i.test(prompt), "b-10b: prompt uses the Norwegian address field label");
          assertTrue(/paraplyorganisasjon|bransjeforening/i.test(prompt), "b-10c: prompt teaches the address-specific umbrella-org misattribution failure mode");
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
    // Section C — gateContactCandidates composition.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── c-1: a backstop-rejected phone candidate never reaches the LLM
        //    call at all (cost control) — fetch throws if invoked. ─────────
        globalThis.fetch = (async () => { throw new Error("c-1: judge must NOT be called for a backstop-rejected candidate"); }) as unknown as typeof fetch;
        {
          const g = await gateContactCandidates({ businessName: "Austrått Kaffebrenneri", sourceContext: "some page text", candidatePhone: "23456789" });
          assertEq(g.phone, null, "c-1a: sequential-digit-run phone candidate -> gated phone is null");
          assertTrue(!!g.phoneRejectedReason && /backstop/i.test(g.phoneRejectedReason), "c-1b: rejection reason attributes this to the backstop classifier");
        }

        // ── c-2: a candidate that clears the backstop but is rejected by
        //    the LLM judge -> null, with a judge-attributed reason. ────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy." }] }) })) as unknown as typeof fetch;
        {
          const g = await gateContactCandidates({ businessName: "Li Lynghonning", sourceContext: "some page text", candidatePhone: "92345678" });
          assertEq(g.phone, null, "c-2a: LLM-rejected (but structurally clean) phone candidate -> gated phone is null");
          assertTrue(!!g.phoneRejectedReason && /llm judge/i.test(g.phoneRejectedReason), "c-2b: rejection reason attributes this to the LLM judge");
        }

        // ── c-3: a candidate that clears BOTH -> passed through verbatim,
        //    for all three field types in one call. ────────────────────────
        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }] }) })) as unknown as typeof fetch;
        {
          const g = await gateContactCandidates({
            businessName: "Testgard AS", sourceContext: "Ring oss på 92 34 56 78",
            candidatePhone: "92345678", candidateEmail: "post@testgard.no", candidateAddress: "Gårdsveien 12",
          });
          assertEq(g.phone, "92345678", "c-3a: candidate clearing both gates -> phone passed through");
          assertEq(g.email, "post@testgard.no", "c-3b: candidate clearing both gates -> email passed through");
          assertEq(g.address, "Gårdsveien 12", "c-3c: candidate clearing both gates -> address passed through");
          assertEq(g.phoneRejectedReason, undefined, "c-3d: no rejection reason on an approved candidate");
        }

        // ── c-4: an email backstop-rejected (favicon) while phone/address
        //    are absent entirely -> all null, only email carries a
        //    rejection reason, and the judge is never called for any of
        //    them (cost control extends to the whole call, not just one
        //    field). ───────────────────────────────────────────────────────
        globalThis.fetch = (async () => { throw new Error("c-4: judge must NOT be called — email is backstop-rejected and phone/address have no candidate"); }) as unknown as typeof fetch;
        {
          const g = await gateContactCandidates({ businessName: "LOKAL Matkvartalet Hamar", sourceContext: "some page text", candidateEmail: "favicon@2x.png" });
          assertEq(g.phone, null, "c-4a: no phone candidate -> gated phone is null, no reason");
          assertEq(g.phoneRejectedReason, undefined, "c-4b: no phone rejection reason when there was no candidate to begin with");
          assertEq(g.address, null, "c-4c: no address candidate -> gated address is null, no reason");
          assertEq(g.email, null, "c-4d: favicon-shaped email candidate -> gated email is null");
          assertTrue(!!g.emailRejectedReason && /backstop/i.test(g.emailRejectedReason), "c-4e: email rejection reason attributes this to the backstop classifier");
        }

        // ── c-5: independent per-field gating — one field rejected by the
        //    judge does not block an unrelated, approved sibling field in
        //    the SAME call. ────────────────────────────────────────────────
        globalThis.fetch = (async (url: any, init: any) => {
          const body = JSON.parse(init.body);
          const prompt: string = body.messages[0].content;
          if (prompt.includes("Kandidat (telefonnummer)")) {
            return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS\nSidestøy." }] }) };
          }
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte." }] }) };
        }) as unknown as typeof fetch;
        {
          const g = await gateContactCandidates({
            businessName: "Blandet Gård", sourceContext: "kontekst",
            candidatePhone: "92345671", candidateEmail: "post@blandetgard.no",
          });
          assertEq(g.phone, null, "c-5a: the judge-rejected phone is null");
          assertEq(g.email, "post@blandetgard.no", "c-5b: the SAME call's independently-approved email still passes through");
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
