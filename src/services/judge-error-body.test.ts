/**
 * judge-error-body.test.ts — unit tests for readErrorBodySnippet /
 * describeJudgeHttpError (src/services/judge-error-body.ts) and for the
 * judges that use them on a non-2xx response.
 *
 * A2A dev-request 2026-11-25-dommerfeil-skal-ikke-nedgradere-verifiserte-profiler,
 * spec point 6: the reason now carries the API's error text, while the
 * verdict stays the same fail-closed value as before and the reason still
 * starts with "dommer-API svarte status <code>" and keeps its old suffix.
 *
 * Fetch mocking follows orgnr-identity-judge.test.ts /
 * dental-catalog-class-judge.test.ts: globalThis.fetch stubbed directly,
 * ANTHROPIC_API_KEY and globalThis.fetch saved/restored around the section.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/judge-error-body.test.ts
 *   2. Wired into the gate: tests/test.ts imports runJudgeErrorBodyTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runJudgeErrorBodyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      readErrorBodySnippet,
      describeJudgeHttpError,
      JUDGE_ERROR_BODY_MAX_CHARS,
      JUDGE_ERROR_BODY_UNREADABLE,
    } = require("./judge-error-body") as typeof import("./judge-error-body");

    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const prevConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      // ── (a) helper ────────────────────────────────────────────────────────
      {
        const long = "x".repeat(1000);
        const s = await readErrorBodySnippet({ text: async () => long });
        assertEq(JUDGE_ERROR_BODY_MAX_CHARS, 300, "a-1: cap is 300 chars");
        assertEq(s.length, 300, "a-1: a 1000-char body is cut to 300 chars");
        assertEq(s, "x".repeat(300), "a-1: the cut keeps the FIRST 300 chars");
      }
      {
        const s = await readErrorBodySnippet({ text: async () => { throw new Error("stream broke"); } });
        assertEq(s, JUDGE_ERROR_BODY_UNREADABLE, "a-2: a throwing text() gives the unreadable placeholder, not a throw");
        assertEq(JUDGE_ERROR_BODY_UNREADABLE, "(kunne ikke lese respons-body)", "a-2: placeholder text");
      }
      {
        const s = await readErrorBodySnippet({} as any);
        assertEq(s, JUDGE_ERROR_BODY_UNREADABLE, "a-3: a response with no text() gives the placeholder");
      }
      {
        const s = await readErrorBodySnippet({ text: async () => "line one\r\n\n  line two\nline three  " });
        assertEq(s, "line one line two line three", "a-4: newlines collapse to single spaces, one line");
      }
      {
        const s = await readErrorBodySnippet({ text: async () => "" });
        assertEq(s, "", "a-5: an empty body gives an empty snippet");
      }
      {
        // A body read that never resolves must not hang the judge.
        const hung = { text: () => new Promise<string>(() => { /* never */ }) };
        const t0 = Date.now();
        const s = await readErrorBodySnippet(hung, undefined, 50);
        assertEq(s, JUDGE_ERROR_BODY_UNREADABLE, "a-6: a hung body read times out to the placeholder");
        assertTrue(Date.now() - t0 < 2000, "a-6: the timeout returns promptly");
        const ac = new AbortController();
        const p = readErrorBodySnippet(hung, ac.signal);
        ac.abort();
        assertEq(await p, JUDGE_ERROR_BODY_UNREADABLE, "a-7: an abort on the caller's signal ends a hung body read");
        assertEq(await readErrorBodySnippet({ text: async () => "x" }, ac.signal), JUDGE_ERROR_BODY_UNREADABLE,
          "a-8: an already-aborted signal does not read the body");
      }
      {
        logged.length = 0;
        const d = await describeJudgeHttpError("testLabel", { status: 429, text: async () => "rate limited" });
        assertEq(d, "429: rate limited", "a-9: describe gives '<status>: <snippet>'");
        assertTrue(logged.some((l) => l.includes("[testLabel]") && l.includes("status=429") && l.includes("rate limited")),
          "a-9: describe logs label, status and body");
        assertEq(await describeJudgeHttpError("t", { status: 500, text: async () => "" }), "500",
          "a-10: an empty body gives just the status (reason unchanged from before)");
      }

      // ── (b) judges on a mocked non-2xx fetch ──────────────────────────────
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      const BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}';
      globalThis.fetch = (async () => ({
        ok: false,
        status: 400,
        text: async () => BODY,
        json: async () => JSON.parse(BODY),
      })) as unknown as typeof fetch;

      {
        const { judgeOrgnrIdentityMatch } = require("./orgnr-identity-judge") as typeof import("./orgnr-identity-judge");
        const v = await judgeOrgnrIdentityMatch({ providerName: "Gård AS", candidateName: "Gård AS" });
        assertEq(v.approved, false, "b-orgnr: non-2xx stays approved:false");
        assertEq(v.reason, `dommer-API svarte status 400: ${BODY} — avvist fail-closed`, "b-orgnr: reason carries the API body");
        assertTrue((v.reason ?? "").startsWith("dommer-API svarte status 400"), "b-orgnr: reason still starts with the status prefix");
      }
      {
        const { judgeDentalCatalogClass } = require("./dental-catalog-class-judge") as typeof import("./dental-catalog-class-judge");
        const v = await judgeDentalCatalogClass({ navn: "TANN AS", currentClass: "klinikk" });
        assertEq(v.verdict_class, "ukjent", "b-dental: non-2xx stays verdict_class ukjent");
        assertEq(v.reason, `dommer-API svarte status 400: ${BODY} — ukjent fail-closed`, "b-dental: reason carries the API body");
      }
      {
        const { judgeRfbAboutCandidate, isRfbJudgeInfraFailure } = require("./rfb-about-judge") as typeof import("./rfb-about-judge");
        const v = await judgeRfbAboutCandidate("Vi dyrker poteter.", "Gård AS", "about");
        assertEq(v.approved, false, "b-rfb: non-2xx stays approved:false");
        assertTrue(v.reasoning.startsWith("dommer-API svarte status 400: ") && v.reasoning.includes("credit balance is too low"),
          "b-rfb: reasoning carries the API body after the status");
        assertTrue(isRfbJudgeInfraFailure(v), "b-rfb: still recognised as an infra failure (suffix kept at the end)");
      }
      {
        const { judgeAboutBetterThanStored } = require("./about-comparison-judge") as typeof import("./about-comparison-judge");
        const v = await judgeAboutBetterThanStored({ stored: "a", candidate: "b", producerName: "Gård AS" });
        assertEq(v, { ok: false, reasoning: `dommer-API svarte status 400: ${BODY}` }, "b-comparison: ok:false, reasoning carries the body");
      }
      {
        const { judgeAboutAgainstPages } = require("./about-spot-check-judge") as typeof import("./about-spot-check-judge");
        const v = await judgeAboutAgainstPages({ about: "Vi dyrker poteter på Hedmarken.", pages: [{ url: "https://x.no", text: "Poteter fra Hedmarken." }] });
        assertEq(v.ok, false, "b-spot-check: non-2xx stays ok:false");
        assertEq((v as any).failure, "error", "b-spot-check: failure kind stays 'error'");
        assertEq((v as any).reason, `dommer-API svarte status 400: ${BODY}`, "b-spot-check: reason carries the body");
      }
      {
        // A throwing body read keeps the same verdict and uses the placeholder.
        globalThis.fetch = (async () => ({
          ok: false,
          status: 503,
          text: async () => { throw new Error("broken stream"); },
        })) as unknown as typeof fetch;
        const { judgeOrgnrIdentityMatch } = require("./orgnr-identity-judge") as typeof import("./orgnr-identity-judge");
        const v = await judgeOrgnrIdentityMatch({ providerName: "Gård AS", candidateName: "Gård AS" });
        assertEq(v.approved, false, "b-unreadable: approved:false");
        assertEq(v.reason, `dommer-API svarte status 503: ${JUDGE_ERROR_BODY_UNREADABLE} — avvist fail-closed`,
          "b-unreadable: reason uses the placeholder");
      }
      assertTrue(!logged.some((l) => l.includes("test-anthropic-key")), "b: the API key never reaches the log");
    } catch (err: any) {
      failed++;
      failures.push("judge-error-body: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      console.error = prevConsoleError;
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runJudgeErrorBodyTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
