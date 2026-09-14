/**
 * experience-content-judge-evidence-page.test.ts — unit tests for
 * judgeExperienceEvidencePage() (experience-content-judge.ts), the fetch+
 * classify+judge entry point added by dev-request 2026-09-14-opplevagent-
 * falske-karantener-doede-sider-gjenopprett to fix the 2026-09-13 mass-
 * apply's root cause: a dead OR parked evidence page used to reach the LLM
 * judge (whose own prompt says "ved minste tvil, svar MISMATCH"), producing
 * a content-quality verdict about a page that carries no content-quality
 * signal at all.
 *
 * No DB — HoldoutExperienceRow is a plain object, not a persisted row. Two
 * independent fetch surfaces are mocked separately, exactly as the function
 * under test actually uses them:
 *   - the evidence-page fetch goes through FetchPageOptions.fetchImpl (an
 *     injected stub — fetchPage()'s own preferred seam, see fetch-page.ts's
 *     own doc comment on why an injected stub beats a globalThis.fetch swap
 *     in this test suite), counted as `pageFetches`.
 *   - the LLM judge call (judgeExperienceContentMatch) always goes through
 *     the global `fetch` (no injection seam exists there), counted as
 *     `judgeCalls` — restored after every test run.
 *
 * Covers:
 *   (a) dead evidence page (fetchImpl throws a DNS-style error) -> unresolved
 *       / evidence_page_dead, ZERO judge calls.
 *   (b) dead evidence page (fetchImpl resolves 503) -> unresolved /
 *       evidence_page_dead, ZERO judge calls.
 *   (c) parked evidence page — the evidence_url's OWN hostname is a known
 *       parking host (sedo.com) -> unresolved / evidence_page_parked, ZERO
 *       judge calls, fetchImpl itself never even has to be reached
 *       meaningfully (still returns 200 so the classification, not the
 *       fetch, is what is under test).
 *   (d) parked evidence page via REDIRECT — fetchImpl's finalUrl lands on a
 *       known parking host even though the requested evidenceUrl's own
 *       hostname does not -> unresolved / evidence_page_parked, ZERO judge
 *       calls.
 *   (e) REGRESSION GUARD: a live page with genuinely mismatched content ->
 *       MISMATCH, exactly as before this fix — judge IS called exactly once.
 *   (f) a live page with genuinely matching content -> MATCH, judge called
 *       exactly once.
 *   (g) empty evidence_url string -> unresolved / evidence_page_dead, ZERO
 *       judge calls, ZERO page fetches (nothing to fetch).
 *   (h) fetchPage succeeds but the judge API itself fails (bad JSON) ->
 *       unresolved / judge_failed (a THIRD unresolved reason, distinct from
 *       the two this dev-request adds) — pageText is still returned (the
 *       page itself was real) even though the verdict is unresolved.
 */

import { judgeExperienceEvidencePage, type HoldoutExperienceRow } from "./experience-content-judge";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function mkRow(overrides: Partial<HoldoutExperienceRow> = {}): HoldoutExperienceRow {
  return {
    id: "row-1",
    title: "Fjelltur med guide",
    description: "Kort om fjellturen.",
    category: "aktivitet",
    price_band: "standard",
    price_from: 500,
    evidence_url: "https://good.no/fjelltur",
    content_field_evidence: null,
    ...overrides,
  };
}

function mkPageResponse(html: string, finalUrl: string, status = 200): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function mkAnthropicResponse(verdictLine: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: verdictLine }] }),
  } as unknown as Response;
}

export function runExperienceContentJudgeEvidencePageTests(
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
    process.env.ANTHROPIC_API_KEY = "test-key-evidence-page";

    let judgeCalls = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr !== "https://api.anthropic.com/v1/messages") {
        throw new Error("evidence-page test: unexpected global fetch call: " + urlStr);
      }
      judgeCalls++;
      const body = JSON.parse(init?.body ?? "{}");
      const promptText: string = body?.messages?.[0]?.content ?? "";
      if (promptText.includes("bad-json-marker")) {
        return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response;
      }
      if (promptText.includes("Kajakktur")) return mkAnthropicResponse("MISMATCH\nSiden handler om noe annet.");
      return mkAnthropicResponse("MATCH\nStemmer med kilden.");
    }) as unknown as typeof fetch;

    try {
      // ── (a) dead page: network error -> unresolved/evidence_page_dead, no judge call
      {
        judgeCalls = 0;
        let pageFetches = 0;
        const fetchImpl = (async () => {
          pageFetches++;
          throw Object.assign(new Error("dns fail"), { cause: { code: "ENOTFOUND" } });
        }) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "https://dead-dns.no/x", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "unresolved", "epa-1a: DNS failure -> unresolved");
        assertEq((outcome as any).unresolvedReason, "evidence_page_dead", "epa-1b: reason evidence_page_dead");
        assertEq(judgeCalls, 0, "epa-1c: LLM judge NEVER called for a dead page");
        assertTrue(pageFetches >= 1, "epa-1d: the evidence page fetch was actually attempted");
      }

      // ── (b) dead page: HTTP 503 -> unresolved/evidence_page_dead, no judge call
      {
        judgeCalls = 0;
        const fetchImpl = (async () =>
          mkPageResponse("Service Unavailable", "https://flaky.no/x", 503)) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "https://flaky.no/x", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "unresolved", "epa-2a: HTTP 503 -> unresolved");
        assertEq((outcome as any).unresolvedReason, "evidence_page_dead", "epa-2b: reason evidence_page_dead");
        assertEq(judgeCalls, 0, "epa-2c: LLM judge NEVER called for a 503 page");
      }

      // ── (c) parked page: evidenceUrl's OWN hostname is a known parking host
      {
        judgeCalls = 0;
        const fetchImpl = (async (url: any) =>
          mkPageResponse("<html><body>Domain for sale</body></html>", String(url))) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "https://sedo.com/search/details?domain=lapsed.no", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "unresolved", "epa-3a: parked hostname (evidence_url) -> unresolved");
        assertEq((outcome as any).unresolvedReason, "evidence_page_parked", "epa-3b: reason evidence_page_parked");
        assertEq(judgeCalls, 0, "epa-3c: LLM judge NEVER called for a parked page (by evidence_url hostname)");
      }

      // ── (d) parked page: lands on a known parking host via REDIRECT (finalUrl)
      {
        judgeCalls = 0;
        const fetchImpl = (async () =>
          mkPageResponse("<html><body>This domain is parked.</body></html>", "https://www.bodis.com/land?d=lapsed2.no")) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "https://lapsed2.no/tur", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "unresolved", "epa-4a: parked via redirect finalUrl -> unresolved");
        assertEq((outcome as any).unresolvedReason, "evidence_page_parked", "epa-4b: reason evidence_page_parked");
        assertEq(judgeCalls, 0, "epa-4c: LLM judge NEVER called for a parked-by-redirect page");
      }

      // ── (e) REGRESSION GUARD: live page, genuinely wrong content -> MISMATCH unchanged
      {
        judgeCalls = 0;
        const fetchImpl = (async () =>
          mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", "https://mismatch.no/kajakk")) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(
          mkRow({ title: "Kajakktur", description: "En kajakktur langs kysten." }),
          "https://mismatch.no/kajakk",
          { userAgent: "test-ua", timeoutMs: 1000, fetchImpl },
        );
        assertEq(outcome.verdict, "MISMATCH", "epa-5a: live page, genuinely wrong content -> MISMATCH (unchanged)");
        assertEq(judgeCalls, 1, "epa-5b: LLM judge called exactly once for a live page");
      }

      // ── (f) live page, genuinely matching content -> MATCH
      {
        judgeCalls = 0;
        const fetchImpl = (async () =>
          mkPageResponse("<html><body>Fjelltur med guide i vakker natur, avgang hver dag.</body></html>", "https://good.no/fjelltur")) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "https://good.no/fjelltur", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "MATCH", "epa-6a: live page, genuinely matching content -> MATCH");
        assertEq(judgeCalls, 1, "epa-6b: LLM judge called exactly once for a live page");
        assertTrue(typeof (outcome as any).pageText === "string" && (outcome as any).pageText.length > 0, "epa-6c: MATCH outcome carries pageText");
      }

      // ── (g) empty evidence_url string -> unresolved/evidence_page_dead, no fetch, no judge
      {
        judgeCalls = 0;
        let pageFetches = 0;
        const fetchImpl = (async () => {
          pageFetches++;
          throw new Error("must not be called for an empty evidence_url");
        }) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(mkRow(), "   ", {
          userAgent: "test-ua",
          timeoutMs: 1000,
          fetchImpl,
        });
        assertEq(outcome.verdict, "unresolved", "epa-7a: empty evidence_url -> unresolved");
        assertEq((outcome as any).unresolvedReason, "evidence_page_dead", "epa-7b: reason evidence_page_dead (nothing to fetch)");
        assertEq(judgeCalls, 0, "epa-7c: LLM judge NEVER called for an empty evidence_url");
        assertEq(pageFetches, 0, "epa-7d: fetchPage never even attempted for an empty evidence_url");
      }

      // ── (h) live page, but the judge API itself fails -> unresolved/judge_failed
      {
        judgeCalls = 0;
        const fetchImpl = (async () =>
          mkPageResponse("<html><body>bad-json-marker page text</body></html>", "https://judgefail.no/x")) as unknown as typeof fetch;
        const outcome = await judgeExperienceEvidencePage(
          mkRow({ title: "bad-json-marker" }),
          "https://judgefail.no/x",
          { userAgent: "test-ua", timeoutMs: 1000, fetchImpl },
        );
        assertEq(outcome.verdict, "unresolved", "epa-8a: judge API failure -> unresolved");
        assertEq((outcome as any).unresolvedReason, "judge_failed", "epa-8b: reason judge_failed (distinct from dead/parked)");
        assertEq(judgeCalls, 1, "epa-8c: LLM judge WAS called (the page itself was live) — it just failed");
        assertTrue(typeof (outcome as any).pageText === "string", "epa-8d: judge_failed outcome still carries the real pageText");
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}
