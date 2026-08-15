/**
 * admin-agents-rfb-quality-judge.test.ts — tests for dev-request
 * rfb-kvalitetsgate-parity: RFB's port of gårdssalg's LLM-judge quality-gate
 * cascade (judgeGardssalgAboutCandidate / meetsGardssalgAboutQualityBar,
 * routes/opplevelser.ts, dev-request 2026-07-20-gardssalg-kvalitetsgate-
 * redesign) to RFB's own content fields: agents.description and
 * agent_knowledge.about (judgeRfbAboutCandidate / meetsRfbAboutQualityBar /
 * isRfbJudgeInfraFailure, routes/admin-agents.ts).
 *
 * Covers:
 *   (a) judgeRfbAboutCandidate()'s sentinel/fail-closed contract — mirrors
 *       judgeGardssalgAboutCandidate's exact never-fabricate discipline:
 *       missing ANTHROPIC_API_KEY / network failure / non-200 / unparseable
 *       JSON / unexpected response shape / ambiguous verdict text all
 *       resolve to { approved: false }, never a thrown error, never a
 *       silent approval.
 *   (b) meetsRfbAboutQualityBar()'s cascade order — the cheap, deterministic
 *       prefilter (meetsAboutCheapBar) runs FIRST; the LLM is called ONLY
 *       when that passes (cost control — asserted via a fetch call counter).
 *   (c) isRfbJudgeInfraFailure() correctly tells a genuine AVVIS verdict
 *       (real model reasoning) apart from every one of judgeRfbAboutCandidate's
 *       own fail-closed sentinel reasons.
 *   (d) a calibration set (dev-request acceptance criterion 2) covering the
 *       5 required known-bad real-world-shaped cases (must be REJECTED —
 *       Skakke's "Jump to ..." nav chrome, Hol Ysteri's "Skip to the
 *       content"-prefixed text, Avdem's "Skip to main content"-prefixed
 *       text, and two "top of page"-glued Atlungstad/Søndre Bjerkerud-style
 *       fixtures) plus >=3 known-good, unpolluted Norwegian producer
 *       descriptions (must be APPROVED). Each fixture asserts BOTH the
 *       cheap-bar outcome and the final cascade result (LLM mocked to return
 *       the fixture's own expected label — this proves the plumbing, not
 *       live model accuracy).
 *   (e) kriterium 8 (dev-request rfb-kvalitetsgate-og-retroskann, "Daniels
 *       beslutning 2026-08-15" section): the recalibrated judge's
 *       short-but-specific principle ("ikke lengde, ikke volum. Kort-men-
 *       spesifikk = godkjenn; trekk-løs/generisk = avvis"), proven against
 *       13 REAL verbatim `agents.description` catalog texts (as of
 *       2026-08-15T02:1xZ) that Daniel reviewed live and confirmed should
 *       pass. Calls judgeRfbAboutCandidate() DIRECTLY (same direct-call
 *       pattern as section (a) above) rather than going through
 *       meetsRfbAboutQualityBar() — several of these 13 real texts are
 *       under 80 chars, and meetsRfbAboutQualityBar()'s meetsAboutCheapBar()
 *       prefilter has an 80-char floor that the real retro-scan code path
 *       (rfbRetroScanShouldNull, admin-agents.ts) never applies (it calls
 *       judgeRfbAboutCandidate directly, bypassing that floor entirely — see
 *       that function's own code), so routing these fixtures through the
 *       cheap-bar prefilter would wrongly fail known-good short-but-real
 *       text before it ever reached the judge. fetch is mocked to return
 *       GODKJENN for each (same mocking convention as the rest of this file
 *       — this proves plumbing, not live model accuracy).
 *
 * Mocks globalThis.fetch (repo convention, no live network access in the
 * sandbox) — never calls the real Anthropic API.
 */

import {
  judgeRfbAboutCandidate,
  meetsRfbAboutQualityBar,
  isRfbJudgeInfraFailure,
  type RfbJudgeVerdict,
} from "./admin-agents";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAdminAgentsRfbQualityJudgeTests(
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

  function assertFalseInfra(r: RfbJudgeVerdict, label: string): void {
    assertTrue(!isRfbJudgeInfraFailure(r), label);
  }

  return (async () => {
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;

    const GOOD_PRODUCER_NAME = "Toten Gårdsutsalg";

    // A genuinely good, on-entity Norwegian candidate — used as the default
    // "approve" candidate across the fail-closed contract tests below (the
    // contract must reject even a perfectly good candidate on any API/parse
    // failure — the failure mode is what's under test, not the text).
    const GOOD_CANDIDATE =
      "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken hver lørdag om sommeren.";

    try {
      // ═══════════════════════════════════════════════════════════════════
      // (a) judgeRfbAboutCandidate — sentinel/fail-closed contract
      // ═══════════════════════════════════════════════════════════════════

      // ── jc-1: missing ANTHROPIC_API_KEY → rejected, fetch never invoked ──
      delete process.env.ANTHROPIC_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("jc-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
      }) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-1: missing ANTHROPIC_API_KEY → rejected fail-closed");
        assertTrue(typeof r.reasoning === "string" && r.reasoning.length > 0, "jc-1b: reasoning string is present");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-1c: isRfbJudgeInfraFailure recognizes the missing-key sentinel");
      }

      process.env.ANTHROPIC_API_KEY = "test-anthropic-judge-key";

      // ── jc-2: mocked 200 approve response → approved, request carries the
      //    exact Anthropic contract (endpoint/model/candidate/producer name),
      //    and for BOTH kinds (description/about). ─────────────────────────
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
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, true, "jc-2a: mocked GODKJENN response → approved");
        assertFalseInfra(r, "jc-2a2: a genuine approval is not (vacuously) an infra failure");
        assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "jc-2b: calls the exact Anthropic messages endpoint");
        const body = JSON.parse(capturedInit.body);
        assertEq(body.model, "claude-haiku-4-5", "jc-2c: model is claude-haiku-4-5 (same as judgeGardssalgAboutCandidate)");
        assertTrue(typeof body.messages?.[0]?.content === "string" && body.messages[0].content.includes(GOOD_CANDIDATE), "jc-2d: prompt includes the candidate text");
        assertTrue(body.messages[0].content.includes(GOOD_PRODUCER_NAME), "jc-2e: prompt includes the producer name");
        assertEq(capturedInit.headers["x-api-key"], "test-anthropic-judge-key", "jc-2f: x-api-key header carries ANTHROPIC_API_KEY");

        const r2 = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "description");
        assertEq(r2.approved, true, "jc-2g: kind='description' also approves on a mocked GODKJENN response");
        const body2 = JSON.parse(capturedInit.body);
        assertTrue(typeof body2.messages?.[0]?.content === "string", "jc-2h: description-kind prompt is still well-formed");
      }

      // ── jc-3: mocked 200 reject response → rejected, with reasoning, NOT
      //    classified as an infra failure (a genuine model rejection). ─────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette er en lenkeliste fra en navigasjonsmeny." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate("Heim Salg Om oss Kontakt", GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-3a: mocked AVVIS response → rejected");
        assertTrue(r.reasoning.includes("navigasjonsmeny"), "jc-3b: reasoning is carried through from the model's response");
        assertTrue(!isRfbJudgeInfraFailure(r), "jc-3c: a genuine AVVIS verdict is NOT classified as an infra failure");
      }

      // ── jc-4: network throw → rejected, never throws itself, IS an infra
      //    failure. ──────────────────────────────────────────────────────
      globalThis.fetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-4a: fetch throw (network failure) → rejected, not re-thrown");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-4b: network failure IS classified as an infra failure");
      }

      // ── jc-5: non-200 response → rejected, infra failure. ─────────────────
      globalThis.fetch = (async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-5a: non-200 response → rejected");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-5b: non-200 response IS classified as an infra failure");
      }

      // ── jc-6: unparseable JSON body (.json() throws) → rejected, infra
      //    failure. ───────────────────────────────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not json"); },
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-6a: unparseable JSON response body → rejected");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-6b: unparseable JSON IS classified as an infra failure");
      }

      // ── jc-7: non-array content field (defensive) → rejected, not a
      //    thrown TypeError, infra failure. ─────────────────────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: { unexpected: "shape" } }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-7a: non-array content field → rejected, not a thrown TypeError");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-7b: unexpected response shape IS classified as an infra failure");
      }

      // ── jc-8: ambiguous/garbage verdict text (neither GODKJENN nor AVVIS)
      //    → rejected, NEVER a silent approval on ambiguity, infra failure. ──
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "Dette er en fin tekst, den bør nok godkjennes." }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-8a: ambiguous verdict text (contains 'godkjennes' but isn't the exact token) → rejected fail-closed, never a guessed approval");
        assertTrue(isRfbJudgeInfraFailure(r), "jc-8b: an ambiguous/unparseable verdict IS classified as an infra failure (never destroys data on doubt)");
      }

      // ── jc-9: empty response text → rejected, infra failure. ──────────────
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "   " }] }),
      })) as unknown as typeof fetch;
      {
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
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
        const r = await judgeRfbAboutCandidate(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r.approved, false, "jc-10: approve token embedded mid-sentence (not the exact first-line token) → rejected fail-closed");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (b) meetsRfbAboutQualityBar — cascade order (cheap prefilter FIRST,
      //     LLM only when it passes) — cost control.
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
        const r = await meetsRfbAboutQualityBar("For kort tekst.", GOOD_PRODUCER_NAME, "description");
        assertEq(r, false, "cc-1a: too-short candidate → false");
        assertEq(llmCallCount, callsBefore, "cc-1b: the LLM is NOT called for a candidate the cheap prefilter already rejects");
      }

      // ── cc-2: boilerplate/cookie candidate fails the cheap bar → the LLM
      //    is never called. ──────────────────────────────────────────────
      {
        const cookieText =
          "Denne siden bruker informasjonskapsler (cookies) for å gi deg en bedre opplevelse. Ved å fortsette godtar du vår bruk av cookies og samtykke til personvernerklæringen vår.";
        const callsBefore = llmCallCount;
        const r = await meetsRfbAboutQualityBar(cookieText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-2a: cookie/consent boilerplate → false");
        assertEq(llmCallCount, callsBefore, "cc-2b: the LLM is NOT called for boilerplate the cheap prefilter already rejects");
      }

      // ── cc-3: mangled-Unicode candidate fails the cheap bar → the LLM is
      //    never called. ──────────────────────────────────────────────────
      {
        const mangledText =
          "Familiedrevet gård på Toten som dyrker grønnsaker og selger dem fra egen butikk, med mange flotte oppleve�lser p� garden.";
        const callsBefore = llmCallCount;
        const r = await meetsRfbAboutQualityBar(mangledText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-3a: mangled-Unicode (replacement character) text → false");
        assertEq(llmCallCount, callsBefore, "cc-3b: the LLM is NOT called for mangled text the cheap prefilter already rejects");
      }

      // ── cc-4: non-Norwegian (English) candidate fails the cheap bar → the
      //    LLM is never called. ──────────────────────────────────────────
      {
        const englishText =
          "This family-run farm on Toten grows organic vegetables and berries and sells them directly from the farm shop every Saturday during summer.";
        const callsBefore = llmCallCount;
        const r = await meetsRfbAboutQualityBar(englishText, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-4a: long English (non-Norwegian) snippet → false");
        assertEq(llmCallCount, callsBefore, "cc-4b: the LLM is NOT called for foreign-language text the cheap prefilter already rejects");
      }

      // ── cc-5: a candidate that clears the cheap bar DOES reach the LLM,
      //    and the cascade's final result reflects the judge's verdict
      //    (approve). ──────────────────────────────────────────────────────
      {
        const callsBefore = llmCallCount;
        const r = await meetsRfbAboutQualityBar(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
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
        const r = await meetsRfbAboutQualityBar(GOOD_CANDIDATE, GOOD_PRODUCER_NAME, "about");
        assertEq(r, false, "cc-6: cheap-bar-passing candidate + LLM reject → false");
      }

      // ── cc-7: null/undefined/empty candidate → false, no LLM call. ───────
      {
        globalThis.fetch = (async () => {
          throw new Error("cc-7: fetch must NOT be called for a null/empty candidate");
        }) as unknown as typeof fetch;
        assertEq(await meetsRfbAboutQualityBar(null, GOOD_PRODUCER_NAME, "about"), false, "cc-7a: null candidate → false");
        assertEq(await meetsRfbAboutQualityBar(undefined, GOOD_PRODUCER_NAME, "about"), false, "cc-7b: undefined candidate → false");
        assertEq(await meetsRfbAboutQualityBar("", GOOD_PRODUCER_NAME, "about"), false, "cc-7c: empty-string candidate → false");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (d) Calibration set — the dev-request's 5 required known-bad
      //     real-world-shaped cases + >=3 known-good clean examples.
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
          label: "cal-1 Skakke-style 'Jump to ...' skip-link chrome (real bad case) — REJECT",
          producerName: "Skakkelaks",
          text:
            "Heim - Skakkelaks Jump to header bar Jump to header Jump to Menu Jump to main Jump to Sidebar Jump to footer widgets Jump to footer credits og meny",
          expectCheapBarPass: true, // long enough, has "og" (Norwegian word marker), no boilerplate markers
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-2 Hol Ysteri-style 'Skip to the content'-prefixed text (real bad case) — REJECT",
          producerName: "Hol Ysteri",
          text:
            "Skip to the content Hol Ysteri holder til på Hol i Hallingdal, og lager ost av melk fra egne geiter og kyr gjennom hele sommersesongen for besøkende.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-3 Avdem-style 'Skip to main content'-prefixed text (real bad case) — REJECT",
          producerName: "Avdem Gård",
          text:
            "Skip to main content Avdem Gård ligger vakkert til i bygda, og selger egenprodusert kjøtt og pølser rett fra gårdsutsalget hver lørdag.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-4 Atlungstad-style 'top of page' glued to otherwise-real prose — REJECT",
          producerName: "Atlungstad Brenneri",
          text:
            "Top of page Atlungstad Brenneri ligger ved Mjøsa og har brygget akevitt og brennevin på tradisjonelt vis siden 1855, med omvisning og salg fra gårdsutsalget.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-5 Søndre Bjerkerud-style 'top of page' glued to otherwise-real prose — REJECT",
          producerName: "Søndre Bjerkerud Gård",
          text:
            "top of page Søndre Bjerkerud Gård selger egne grønnsaker og bær fra gårdsbutikken, og tilbyr omvisning på gården for skoleklasser hver høst.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "AVVIS",
          expectFinal: false,
        },
        {
          label: "cal-6 clean unpolluted producer description (dairy) — APPROVE",
          producerName: "Nesbyen Gardsysteri",
          text:
            "Nesbyen Gardsysteri ligger idyllisk til i Hallingdal og har laget ost av melk fra egne geiter i over tjue år, med gårdsbutikk åpen hele sommeren.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-7 clean unpolluted producer description (bakery) — APPROVE",
          producerName: "Elverum Bakeri og Gardsutsalg",
          text:
            "Elverum Bakeri og Gardsutsalg bakes surdeigsbrød og kaker fra korn dyrket på egen gård, og selger dem hver morgen fra det lille gårdsutsalget ved tunet.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-8 clean unpolluted producer description (vegetables) — APPROVE",
          producerName: "Ringsaker Andelslandbruk",
          text:
            "Ringsaker Andelslandbruk dyrker økologiske grønnsaker sammen med andelshaverne gjennom hele sesongen, og deler ut ukentlige grønnsakskasser fra gården hver torsdag.",
          expectCheapBarPass: true,
          mockedLlmVerdict: "GODKJENN",
          expectFinal: true,
        },
        {
          label: "cal-9 too-short text (<80 chars) — REJECT at cheap-bar stage (LLM never reached)",
          producerName: "Liten Gard",
          text: "Liten gård med noen dyr og epletrær.",
          expectCheapBarPass: false,
          expectFinal: false,
        },
      ];

      assertTrue(
        CALIBRATION_SET.filter((f) => f.expectFinal === false && f.expectCheapBarPass === true).length >= 5,
        "cal-sanity: at least 5 known-bad, cheap-bar-passing fixtures are present (the dev-request's required 5)",
      );
      assertTrue(
        CALIBRATION_SET.filter((f) => f.expectFinal === true).length >= 3,
        "cal-sanity: at least 3 known-good fixtures are present",
      );

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

        const result = await meetsRfbAboutQualityBar(fx.text, fx.producerName, "about");
        assertEq(result, fx.expectFinal, `${fx.label}: final cascade result`);
        assertEq(calLlmCalled, fx.expectCheapBarPass, `${fx.label}: LLM invoked iff the cheap prefilter passed`);
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) Kriterium 8 — recalibrated-judge known-good set: 13 REAL verbatim
      //     agents.description catalog texts (2026-08-15T02:1xZ), Daniel-
      //     reviewed, "short-but-specific = approve" (dev-request
      //     rfb-kvalitetsgate-og-retroskann, "Implementer-spec for
      //     kriterium 8"). Calls judgeRfbAboutCandidate() DIRECTLY — NOT
      //     meetsRfbAboutQualityBar() — because several of these real texts
      //     are under meetsAboutCheapBar()'s 80-char floor, which the real
      //     retro-scan decision path (rfbRetroScanShouldNull) never applies
      //     (it calls judgeRfbAboutCandidate directly too). fetch is mocked
      //     to GODKJENN for every fixture — this proves the judge's plumbing
      //     accepts short-but-specific text end to end, not live model
      //     accuracy (matches this file's own documented caveat above).
      // ═══════════════════════════════════════════════════════════════════
      interface Kriterium8Fixture {
        label: string;
        agentId: string;
        producerName: string;
        description: string;
      }

      // Agent id column per the dev-request's verbatim table. "Opedalstunet"
      // has a name collision in the catalog: `09c66e41-…` (plain name
      // "Opedalstunet", description "Oppdaget via Brreg NACE-søk" — a
      // discovery-source placeholder, NOT known-good) vs. `789ab32b-…` (name
      // "Opedalstunet — Lofthus, Hardanger", description below, matches the
      // "kort men med sted/vareprofil/særtrekk" pattern) — the dev-request
      // explicitly directs using `789ab32b-…`; flagged here as the judgment
      // call it is, not a silent assumption.
      const KRITERIUM_8_KNOWN_GOOD: Kriterium8Fixture[] = [
        {
          label: "k8-1 Vika Frukt og Grønt",
          agentId: "760e0e49-1039-4dc3-a904-6ff4bf0411a1",
          producerName: "Vika Frukt og Grønt",
          description: "Frukt- og grøntbutikk i Vika, Oslo sentrum. Ferske varer daglig.",
        },
        {
          label: "k8-2 Vulkan Frukt og Grønt",
          agentId: "50651bd2-0541-4773-8efe-0b94035995eb",
          producerName: "Vulkan Frukt og Grønt",
          description: "Frukt- og grøntbutikk i Mathallen på Vulkan. Kvalitetsvarer og sesongprodukter.",
        },
        {
          label: "k8-3 Grønland Grønt Agent",
          agentId: "16797909-f7ed-431f-bc2f-b3ccf9f9bc06",
          producerName: "Grønland Grønt Agent",
          description: "Dagligvarebutikk på Grønland med ferskt, rimelig grønt fra lokale leverandører.",
        },
        {
          label: "k8-4 Løren Frukt og Grønt",
          agentId: "a30c5ebc-b4b9-4bf0-b3c6-5a6729da2dd9",
          producerName: "Løren Frukt og Grønt",
          description: "Frukt- og grøntbutikk på Løren, Oslo. Ferskt utvalg med lokalt fokus.",
        },
        {
          label: "k8-5 Biri Landhandel",
          agentId: "08111fbf-864b-4c49-83c6-cef378c61130",
          producerName: "Biri Landhandel",
          description: "Delikatessebutikk og landhandel med sjølvbetjening via Vipps.",
        },
        {
          label: "k8-6 Naukeset — Telemark",
          agentId: "86b29c12-b1b3-474d-97ca-cc52de473e9d",
          producerName: "Naukeset — Telemark",
          description: "Grønnsaksprodusent i Bø, Telemark — sesongbaserte grønnsaker.",
        },
        {
          label: "k8-7 Opedalstunet — Lofthus, Hardanger (disambiguated: 789ab32b-…, NOT the 09c66e41-… placeholder row)",
          agentId: "789ab32b-8f49-4e0a-8457-600ab34d1cf9",
          producerName: "Opedalstunet — Lofthus, Hardanger",
          description: "Fruktgård i Lofthus med sider, juice, syltetøy og kaker på bestilling",
        },
        {
          label: "k8-8 Bergen Mathall",
          agentId: "fb674aa8-f3ec-4441-a7a2-baf2db061a68",
          producerName: "Bergen Mathall",
          description: "Vestlandets framtidige mathall i Bergen — mat, kultur og kunst",
        },
        {
          label: "k8-9 Lyse Insecta",
          agentId: "888e4668-8ec3-4767-8553-a94d00ab5096",
          producerName: "Lyse Insecta",
          description: "Birøkteri i Sandnes med honning, dronninger og birøktprodukter.",
        },
        {
          label: "k8-10 Jenseg Bakeri og Konditori",
          agentId: "8d5cf2a7-7a4b-41ad-b288-a608ac7eb329",
          producerName: "Jenseg Bakeri og Konditori",
          description: "Jenseg Bakeri og Konditori i Sarpsborg bakar tradisjonelle bakevarer og brød.",
        },
        {
          label: "k8-11 Brandstorp Gårdsbutikk",
          agentId: "23c8ae52-72ff-4a4b-9d4e-f99c4ee6d0c1",
          producerName: "Brandstorp Gårdsbutikk",
          description: "Brandstorp Gårdsbutikk — gårdsutsalg med lokale produkt i Sarpsborg.",
        },
        {
          label: "k8-12 Skakadalskurv",
          agentId: "e4695cdd-27a2-4c08-9081-0d145792ded9",
          producerName: "Skakadalskurv",
          description: "Gullvinnar kurv-NM 2024 — tradisjonell sauekurv frå Øygarden gard i Vang",
        },
        {
          label: "k8-13 rotfesta da",
          agentId: "b95e0f68-e6ff-47c3-b7f5-d69646882b09",
          producerName: "rotfesta da",
          description:
            "Tre ungdommar frå Vindafjord dyrkar Astrix og Fakse potet på hobbybasert vis. Henting på gård i postnummer 5585, betaling via Vipps.",
        },
      ];

      assertEq(
        KRITERIUM_8_KNOWN_GOOD.length,
        13,
        "k8-sanity: all 13 kriterium-8 known-good catalog fixtures are present",
      );

      for (const fx of KRITERIUM_8_KNOWN_GOOD) {
        globalThis.fetch = (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "text", text: "GODKJENN\nKort, men spesifikk om denne produsentens sted/vareprofil/særtrekk." }],
          }),
        })) as unknown as typeof fetch;

        const r = await judgeRfbAboutCandidate(fx.description, fx.producerName, "description");
        assertEq(r.approved, true, `${fx.label} (${fx.agentId}): recalibrated judge approves the real verbatim description`);
      }
    } catch (err: any) {
      failed++;
      failures.push("admin-agents-rfb-quality-judge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-agents-rfb-quality-judge.test.ts`
if (require.main === module) {
  runAdminAgentsRfbQualityJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
