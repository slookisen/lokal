/**
 * opplevelser-gardssalg-quality-judge.test.ts — tests for dev-request
 * 2026-07-20-gardssalg-kvalitetsgate-redesign, slice 2/3/4: the LLM judge
 * that replaces the retired regex nav-menu-leakage heuristic layer
 * (isLikelyNavMenuLeakage / hasVerbatimRepeatedPhrase / NAV_BOILERPLATE_
 * MARKERS / UMBRELLA_MEMBERSHIP_MARKERS) for gårdssalg about_text/visit_text
 * candidates ONLY (search-enrich.ts's meetsAboutQualityBar and its existing
 * callers, e.g. admin-knowledge.ts, are untouched — see the doc comment on
 * judgeGardssalgAboutCandidate in routes/opplevelser.ts for why).
 *
 * Covers:
 *   (a) judgeGardssalgAboutCandidate()'s sentinel/fail-closed contract —
 *       mirrors generateGardssalgAboutRewrite's exact never-fabricate
 *       discipline: missing ANTHROPIC_API_KEY / network failure / non-200 /
 *       unparseable JSON / unexpected response shape / ambiguous verdict
 *       text all resolve to { approved: false }, never a thrown error, never
 *       a silent approval.
 *   (b) meetsGardssalgAboutQualityBar()'s cascade order — the cheap,
 *       deterministic prefilter (meetsAboutCheapBar) runs FIRST; the LLM is
 *       called ONLY when that passes (cost control — asserted via a fetch
 *       call counter, not inferred).
 *   (c) a ≥10-example, hand-labeled CALIBRATION set (fixtures checked into
 *       this file, per the dev-request's acceptance criterion 2): each
 *       fixture's expected cheap-bar outcome and expected final verdict are
 *       asserted, with the LLM mocked to return the calibration's own
 *       expected label (this proves the plumbing — prefilter gating,
 *       verdict parsing, fail-closed wiring — is correct on realistic
 *       shapes; it does not (and cannot, without a live model) prove the
 *       real model's judgment accuracy). Includes Draopar's actual
 *       nav-polluted about_text shape (reject) and realistic equivalents of
 *       Kinn Bryggeri's / Graff Brygghus's clean about_text (approve), per
 *       the dev-request's calibration-set seed list.
 *
 * Mocks globalThis.fetch (repo convention, no live network access in the
 * sandbox) — never calls the real Anthropic API.
 */

import {
  judgeGardssalgAboutCandidate,
  meetsGardssalgAboutQualityBar,
} from "./opplevelser";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runOpplevelserGardssalgQualityJudgeTests(
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

    const GOOD_PRODUCER_NAME = "Toten Gårdsutsalg";

    // A genuinely good, on-entity Norwegian about_text — used as the default
    // "approve" candidate across the fail-closed contract tests below (the
    // contract must reject even a perfectly good candidate on any API/parse
    // failure — the failure mode is what's under test, not the text).
    const GOOD_CANDIDATE =
      "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken hver lørdag om sommeren.";

    try {
      // ═══════════════════════════════════════════════════════════════════
      // (a) judgeGardssalgAboutCandidate — sentinel/fail-closed contract
      // ═══════════════════════════════════════════════════════════════════

      // ── jc-1: missing ANTHROPIC_API_KEY → rejected, fetch never invoked ──
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("jc-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-1: missing ANTHROPIC_API_KEY → rejected fail-closed");
        assertTrue(typeof r.reasoning === "string" && r.reasoning.length > 0, "jc-1b: reasoning string is present");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-judge-key";

      // ── jc-2: mocked 200 approve response → approved, request carries the
      //    exact Anthropic contract (endpoint/model/candidate/producer name). ──
      let capturedUrl: any = null;
      let capturedInit: any = null;
      globalThis.fetch = (async (url: any, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte, konkret prosa om produsenten." }] }),
        };
      }) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, true, "jc-2a: mocked GODKJENN response → approved");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "jc-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-opus-4-8", "jc-2c: model is claude-opus-4-8 (same as generateGardssalgAboutRewrite)");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(GOOD_CANDIDATE), "jc-2d: prompt includes the candidate text");
        assertTrue(body.messages[0].content.includes(GOOD_PRODUCER_NAME), "jc-2e: prompt includes the producer name");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-judge-key", "jc-2f: x-api-key header carries ANTHROPIC_API_KEY");
      }

      // ── jc-3: mocked 200 reject response → rejected, with reasoning. ─────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette er en lenkeliste fra en navigasjonsmeny." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate("Heim Salg Om oss Kontakt", GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-3a: mocked AVVIS response → rejected");
        assertTrue(r.reasoning.includes("navigasjonsmeny"), "jc-3b: reasoning is carried through from the model's response");
      }

      // ── jc-4: network throw → rejected, never throws itself. ─────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-4: fetch throw (network failure) → rejected, not re-thrown");
      }

      // ── jc-5: non-200 response → rejected. ────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-5: non-200 response → rejected");
      }

      // ── jc-6: unparseable JSON body (.json() throws) → rejected. ──────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-6: unparseable JSON response body → rejected");
      }

      // ── jc-7: non-array content field (defensive, mirrors the other
      //    Anthropic-calling helpers' own regression) → rejected, no throw. ──
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-7: non-array content field → rejected, not a thrown TypeError");
      }

      // ── jc-8: ambiguous/garbage verdict text (neither GODKJENN nor AVVIS)
      //    → rejected, NEVER a silent approval on ambiguity. ────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Dette er en fin tekst, den bør nok godkjennes." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-8: ambiguous verdict text (contains 'godkjennes' but isn't the exact token) → rejected fail-closed, never a guessed approval");
      }

      // ── jc-9: empty response text → rejected. ─────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "   " }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-9: empty/whitespace-only response text → rejected");
      }

      // ── jc-10: verdict token embedded mid-sentence (not on its own first
      //    line) does NOT approve — only the EXACT token on the first line
      //    counts, per the fail-closed "no ambiguity" discipline. ───────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Jeg tror kanskje GODKJENN er riktig her, men usikker." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeGardssalgAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-10: approve token embedded mid-sentence (not the exact first-line token) → rejected fail-closed");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) meetsGardssalgAboutQualityBar — cascade order (cheap prefilter
      //     FIRST, LLM only when it passes) — cost control.
      // ═══════════════════════════════════════════════════════════════════
      let llmCallCount = 0;
      globalThis.fetch = (async () => {
        llmCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nGreit." }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      // ── cc-1: too-short candidate (<80 chars) fails the cheap bar → the
      //    LLM is NEVER called. ──────────────────────────────────────────
      {
        const callsBefore = llmCallCount;
        const r = await meetsGardssalgAboutQualityBar("For kort tekst.", GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-1a: too-short candidate → false");
        assertEq(llmCallCount, callsBefore, "cc-1b: the LLM is NOT called for a candidate the cheap prefilter already rejects");
      }

      // ── cc-2: boilerplate/cookie candidate fails the cheap bar → the LLM
      //    is never called (GENERIC_ABOUT_MARKERS, shared cheap prefilter). ──
      {
        const cookieText =
          "Denne siden bruker informasjonskapsler (cookies) for å gi deg en bedre opplevelse. Ved å fortsette godtar du vår bruk av cookies og samtykke til personvernerklæringen vår.";
        const callsBefore = llmCallCount;
        const r = await meetsGardssalgAboutQualityBar(cookieText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-2a: cookie/consent boilerplate → false");
        assertEq(llmCallCount, callsBefore, "cc-2b: the LLM is NOT called for boilerplate the cheap prefilter already rejects");
      }

      // ── cc-3: mangled-Unicode candidate fails the cheap bar → the LLM is
      //    never called. ──────────────────────────────────────────────────
      {
        const mangledText =
          "Familiedrevet gård på Toten som dyrker grønnsaker og selger dem fra egen butikk, med mange flotte oppleve�lser p� garden.";
        const callsBefore = llmCallCount;
        const r = await meetsGardssalgAboutQualityBar(mangledText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-3a: mangled-Unicode (replacement character) text → false");
        assertEq(llmCallCount, callsBefore, "cc-3b: the LLM is NOT called for mangled text the cheap prefilter already rejects");
      }

      // ── cc-4: non-Norwegian (English) candidate fails the cheap bar → the
      //    LLM is never called. ──────────────────────────────────────────
      {
        const englishText =
          "This family-run farm on Toten grows organic vegetables and berries and sells them directly from the farm shop every Saturday during summer.";
        const callsBefore = llmCallCount;
        const r = await meetsGardssalgAboutQualityBar(englishText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-4a: long English (non-Norwegian) snippet → false");
        assertEq(llmCallCount, callsBefore, "cc-4b: the LLM is NOT called for foreign-language text the cheap prefilter already rejects");
      }

      // ── cc-5: a candidate that clears the cheap bar DOES reach the LLM,
      //    and the cascade's final result reflects the judge's verdict
      //    (approve). ──────────────────────────────────────────────────────
      {
        const callsBefore = llmCallCount;
        const r = await meetsGardssalgAboutQualityBar(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r, true, "cc-5a: cheap-bar-passing candidate + LLM approve → true");
        assertTrue(llmCallCount > callsBefore, "cc-5b: the LLM IS called once the cheap prefilter passes");
      }

      // ── cc-6: a candidate that clears the cheap bar but the LLM rejects
      //    → final result is false. ──────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "AVVIS\nFeil enhet." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await meetsGardssalgAboutQualityBar(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-6: cheap-bar-passing candidate + LLM reject → false");
      }

      // ── cc-7: null/undefined/empty candidate → false, no LLM call. ───────
      {
        globalThis.fetch = (async () => {
          throw new Error("cc-7: fetch must NOT be called for a null/empty candidate");
        }) as unknown as typeof fetch;
        assertEq(await meetsGardssalgAboutQualityBar(null, GOOD_PRODUCER_NAME, "about"), false, "cc-7a: null candidate → false");
        assertEq(await meetsGardssalgAboutQualityBar(undefined, GOOD_PRODUCER_NAME, "about"), false, "cc-7b: undefined candidate → false");
        assertEq(await meetsGardssalgAboutQualityBar("", GOOD_PRODUCER_NAME, "about"), false, "cc-7c: empty-string candidate → false");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c) Calibration set — ≥10 hand-labeled examples (dev-request
      //     acceptance criterion 2). Each fixture asserts BOTH the cheap-bar
      //     outcome (is the LLM even reached) and the final cascade result
      //     (with the LLM mocked to return the fixture's own expected
      //     label — this proves the wiring, not live model accuracy).
      // ═══════════════════════════════════════════════════════════════════
      interface CalibrationFixture {
        label: string;
        producerName: string;
        text: string;
        expectCheapBarPass: boolean;
        // Only meaningful when expectCheapBarPass is true — the verdict the
        // (mocked) LLM judge returns for this fixture.
        mockedLlmVerdict?: "GODKJENN" | "AVVIS";
        expectFinal: boolean;
      }

      const CALIBRATION_SET: CalibrationFixture[] = [
        {
          label: "cal-1 Draopar-style nav-polluted about_text (real incident shape) — REJECT",
          producerName: "Draopar Sideri",
          // The actual Draopar bug: nav-menu link labels glued in front of
          // one real trailing sentence containing the loophole prose-signal
          // word "er" that let the old 4-signal regex heuristic through.
          text:
            "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger.",
          expectCheapBarPass: true, // has "er" (Norwegian word marker), length ok, no boilerplate markers
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-2 Kinn Bryggeri-equivalent clean about_text — APPROVE",
          producerName: "Kinn Bryggeri",
          text:
            "Kinn Bryggeri er et lite håndverksbryggeri på Vågsøy som brygger øl med lokalt vann og kortreiste råvarer, og tar imot besøkende til smaking og omvisning gjennom sommersesongen.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-3 Graff Brygghus-equivalent clean about_text — APPROVE",
          producerName: "Graff Brygghus",
          text:
            "Graff Brygghus holder til i Trondheim og brygger håndverksøl i små satser, med egen skjenkestue der du kan smake det ferskeste brygget rett fra tanken hver helg.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-4 genuine short farm-product list prose (passive voice) — APPROVE",
          producerName: "Nordfjord Gard",
          text:
            "Poteter, gulrøtter og kålrot dyrkes her på garden hver sommer, og selges rett fra den vesle gårdsbutikken ved tunet, sammen med hjemmelaget syltetøy og saft.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-5 umbrella/tourism-association 'our members' text — REJECT (wrong entity)",
          producerName: "Vestlandet Gardsmat",
          text:
            "Våre medlemmer tilbyr alt fra gårdsutsalg til overnatting og opplevelser langs hele kysten, og vi hjelper deg med å finne den beste medlemsbedriften for din tur i regionen.",
          expectCheapBarPass: true, // real, grammatical Norwegian prose — no boilerplate/mangled markers
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-6 boilerplate/cookie/consent text — REJECT at cheap-bar stage (LLM never reached)",
          producerName: "Hvilken Som Helst Gard",
          text:
            "Denne nettsiden bruker informasjonskapsler for analyse og personvern. Ved å fortsette bruken av siden godtar du vår personvernerklæring og samtykke til cookies.",
          expectCheapBarPass: false,
          expectFinal: false,
        },
        {
          label: "cal-7 mangled-Unicode text — REJECT at cheap-bar stage (LLM never reached)",
          producerName: "Olestølen Mikroysteri",
          text:
            "Osteriet vårt lager ost fra egen melk og tilbyr smaksprøver og gårdsopplevelser p� garden gjennom hele sommers�songen for besøkende som ønsker noe ekte og lokalt.",
          expectCheapBarPass: false,
          expectFinal: false,
        },
        {
          label: "cal-8 genuinely good varied-length real prose (longer) — APPROVE",
          producerName: "Sunnmøre Gardsysteri",
          text:
            "Sunnmøre Gardsysteri ligger vakkert til med utsikt over fjorden, og har i tre generasjoner laget ost av melk fra egne kyr. Gården tar imot besøkende til omvisning og osteproduksjon, og selger et bredt utvalg av modne og ferske oster fra gårdsbutikken hele året, i tillegg til hjemmelaget rømme og smør.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-9 flat Title-Case nav-menu-shaped list (no boilerplate markers) — REJECT",
          producerName: "Harstad Bryggeri",
          text: "Harstad Bryggeri Cart Bryggeriet Ølet Omvisning Nyheter Kontakt Merch Handlekurv Meny",
          expectCheapBarPass: true, // has "ø" (Nordic letter), length ok, no boilerplate markers — exactly the shape the old regex heuristic (now retired for gårdssalg) used to catch
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-10 too-short text (<80 chars) — REJECT at cheap-bar stage (LLM never reached)",
          producerName: "Liten Gard",
          text: "Liten gård med noen dyr og epletrær.",
          expectCheapBarPass: false,
          expectFinal: false,
        },
        {
          // Deliberately avoids common English function words that also
          // spell common Norwegian ones ("for", "som", "er", "av", "til",
          // "med", "har") — those would incidentally match
          // NORWEGIAN_WORD_MARKERS's substring check and false-pass the
          // cheap bar, which is not what this fixture is calibrating.
          label: "cal-11 non-Norwegian (English) text — REJECT at cheap-bar stage (LLM never reached)",
          producerName: "Some English Farm",
          text:
            "Welcome to our family farm shop where we sell fresh produce, eggs and homemade jam every weekend.",
          expectCheapBarPass: false,
          expectFinal: false,
        },
      ];

      assertTrue(CALIBRATION_SET.length >= 10, "cal-sanity: calibration set has at least 10 hand-labeled examples");

      for (const fx of CALIBRATION_SET) {
        let calLlmCalled = false;
        globalThis.fetch = (async () => {
          calLlmCalled = true;
          const text = fx.mockedLlmVerdict === "GODKJENN"
            ? "GODKJENN\nRen, konkret prosa om produsenten."
            : "AVVIS\nIkke egnet til publisering.";
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text } ] }),
          } as unknown as Response;
        }) as unknown as typeof fetch;

        const result = await meetsGardssalgAboutQualityBar(fx.text, fx.producerName, "about");
        assertEq(result, fx.expectFinal, `${fx.label}: final cascade result`);
        assertEq(calLlmCalled, fx.expectCheapBarPass, `${fx.label}: LLM invoked iff the cheap prefilter passed`);
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-quality-judge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-quality-judge.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgQualityJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
