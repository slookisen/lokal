/**
 * lokal-agent-verifier-second-line-evidence.test.ts — dev-request
 * 2026-10-23-rfb-flere-forstehenvendelser-dommer-bevis-og-kontaktuttrekk
 * (skive 1, "port A"): own-website evidence for RFB's second-line judge,
 * behind RFB_SECOND_LINE_EVIDENCE_ENABLED (default OFF), plus the read-only
 * POST /admin/second-line-judge-preview route.
 *
 * Sections:
 *   A. No evidence ⇒ the judge prompt is byte-identical to before this slice
 *      (sha256 pinned from the pre-change judgeSecondLineProfile prompt) and
 *      computeSecondLineVerification passes NO `evidence` key to the judge.
 *   B. With an excerpt the prompt carries the evidence block + criterion 5.
 *   C. buildSecondLineEvidence: same-host only (www stripped), different
 *      final domain ⇒ not sent, fetch failure ⇒ [], no own_website ⇒ no fetch.
 *   D. runVerifierBatch: evidence flag off ⇒ verdicts unchanged and the
 *      evidence fetcher is never called; flag on ⇒ evidence reaches the judge.
 *   E. Preview route: writes nothing (SQLite total_changes() unchanged), 400
 *      on 0 or >25 ids, not_found rows, skipped_reason.
 *
 * No real network or LLM: every fetch/judge is injected.
 * Wired into tests/test.ts via runSerial().
 * Standalone: npx tsx src/agents/lokal-agent-verifier-second-line-evidence.test.ts
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// sha256 of the prompt the PRE-change judgeSecondLineProfile sent for
// BASE_A / BASE_B below (captured by mocking globalThis.fetch on origin/main
// before buildSecondLineJudgePrompt was factored out).
const GOLDEN_PROMPT_SHA_A = "26c25c50ac67045c951d525e9326faea0e9cdaaeffd58a36468b5ddb13ccd28b";
const GOLDEN_PROMPT_SHA_B = "7aaaa438ed48b45e9206767a4b37d5bad50c5f418464e9c84c91ca2fff7f9d58";

const BASE_A = {
  businessName: "Testgård Bryggeri",
  city: "Ski",
  about: "Vi brygger øl på gården i Ski.",
  products: ["øl", { name: "sider" }] as unknown[],
  email: "post@testgard.no",
  acceptedSources: ["own_website", "brreg_name_match"],
  brregName: "TESTGÅRD BRYGGERI AS",
};
const BASE_B = { ...BASE_A, brregName: null, about: null, products: [] as unknown[], acceptedSources: ["own_website"] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A fetch stub that serves `html` and reports `finalUrl` as the post-redirect URL. */
function pageFetch(html: string, finalUrl: string | null, calls: string[], status = 200): typeof fetch {
  return (async (input: any) => {
    calls.push(String(input));
    const resp = new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(resp, "url", { value: finalUrl ?? String(input) });
    return resp;
  }) as unknown as typeof fetch;
}

const SITE_HTML =
  "<html><head><title>Testgård</title><style>.x{}</style><script>var a=1;</script></head>" +
  "<body><h1>Testgård i Lillehammer</h1><p>Vi selger egg og poteter fra gården. Org.nr 912 345 678.</p></body></html>";

interface RouteResult { status: number; body: any; ended: boolean }
function callRoute(router: any, opts: { method?: string; url: string; headers?: Record<string, string>; body?: any }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, ended: true }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined, ended: true }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

export function runLokalAgentVerifierSecondLineEvidenceTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      computeSecondLineVerification,
      buildSecondLineEvidence,
      isRfbSecondLineEvidenceEnabled,
      runVerifierBatch,
    } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");
    const { buildSecondLineJudgePrompt } =
      require("../services/second-line-profile-judge") as typeof import("../services/second-line-profile-judge");

    const goodGate = { website_ok: true, no_wrong_fit: true, brreg_active: true };
    const baseInput = {
      producer_name: "Testgård",
      city: "Lillehammer",
      about: "En liten gård i Lillehammer.",
      products: [{ name: "Egg" }] as unknown[],
      email: "kari@testgard.no",
      field_provenance: {},
      brreg: null,
      gate_reasons: goodGate,
    };

    // ═══ Section A — no evidence ⇒ byte-identical ═══════════════════════
    try {
      assertEq(sha(buildSecondLineJudgePrompt(BASE_A)), GOLDEN_PROMPT_SHA_A, "a-1: no-evidence prompt A is byte-identical to the pre-change prompt");
      assertEq(sha(buildSecondLineJudgePrompt(BASE_B)), GOLDEN_PROMPT_SHA_B, "a-2: no-evidence prompt B (no brreg/about/products) is byte-identical to the pre-change prompt");
      assertEq(
        sha(buildSecondLineJudgePrompt({ ...BASE_A, evidence: [] })),
        GOLDEN_PROMPT_SHA_A,
        "a-3: evidence: [] renders exactly the no-evidence prompt",
      );
      assertEq(
        sha(buildSecondLineJudgePrompt({ ...BASE_A, evidence: [{ source_url: "https://x.no", content_excerpt: "   " }] })),
        GOLDEN_PROMPT_SHA_A,
        "a-4: whitespace-only excerpt is dropped -> still the no-evidence prompt",
      );

      const seen: any[] = [];
      const judge = async (p: any) => { seen.push(p); return { approved: true, reason: "ok" }; };
      await computeSecondLineVerification({ ...baseInput, judgeFn: judge });
      assertTrue(seen.length === 1 && !("evidence" in seen[0]), "a-5: no evidence input -> judge params carry NO evidence key");
      await computeSecondLineVerification({ ...baseInput, evidence: [], judgeFn: judge });
      assertTrue(seen.length === 2 && !("evidence" in seen[1]), "a-6: evidence: [] -> judge params carry NO evidence key");
      await computeSecondLineVerification({ ...baseInput, evidenceFn: async () => [], judgeFn: judge });
      assertTrue(seen.length === 3 && !("evidence" in seen[2]), "a-7: evidenceFn returning [] -> judge params carry NO evidence key");
      await computeSecondLineVerification({ ...baseInput, evidenceFn: async () => { throw new Error("boom"); }, judgeFn: judge });
      assertTrue(seen.length === 4 && !("evidence" in seen[3]), "a-8: throwing evidenceFn -> fails to today's no-evidence call");
      const keysToday = ["businessName", "city", "about", "products", "email", "acceptedSources", "brregName"];
      assertEq(Object.keys(seen[0]), keysToday, "a-9: judge param keys exactly as before this slice");
    } catch (err: any) {
      failed++;
      failures.push("section A: unexpected error: " + String(err?.stack || err));
    }

    // ═══ Section B — with excerpt ⇒ evidence block + criterion 5 ═══════
    try {
      const ev = [{ source_url: "https://testgard.no/", content_excerpt: "Testgård i Lillehammer selger egg." }];
      const prompt = buildSecondLineJudgePrompt({ ...BASE_A, evidence: ev });
      assertTrue(prompt.includes("Fremlagt kildeinnhold"), "b-1: prompt contains the evidence block label");
      assertTrue(prompt.includes(`- https://testgard.no/: "Testgård i Lillehammer selger egg."`), "b-2: prompt contains the excerpt line");
      assertTrue(prompt.includes("5. Dersom kildeinnhold er fremlagt"), "b-3: prompt contains criterion 5");

      const seen: any[] = [];
      const r = await computeSecondLineVerification({
        ...baseInput,
        evidence: ev,
        judgeFn: async (p: any) => { seen.push(p); return { approved: true, reason: "ok" }; },
      });
      assertEq(seen[0]?.evidence, ev, "b-4: computeSecondLineVerification forwards evidence to the judge");
      assertTrue(buildSecondLineJudgePrompt(seen[0]).includes("5. Dersom kildeinnhold"), "b-5: the forwarded params render criterion 5");
      assertEq(r.passes, true, "b-6: approve still passes");

      let evCalls = 0;
      const seen2: any[] = [];
      await computeSecondLineVerification({
        ...baseInput,
        email: null,
        evidenceFn: async () => { evCalls++; return ev; },
        judgeFn: async (p: any) => { seen2.push(p); return { approved: true }; },
      });
      assertEq(evCalls, 0, "b-7: evidenceFn not called when deterministic checks fail (no email)");
      assertEq(seen2.length, 0, "b-8: judge not called when deterministic checks fail");

      let gotSources: readonly string[] = [];
      await computeSecondLineVerification({
        ...baseInput,
        evidenceFn: async (s) => { gotSources = s; return ev; },
        judgeFn: async () => ({ approved: false }),
      });
      assertEq(gotSources, ["own_website"], "b-9: evidenceFn receives the computed sources");
    } catch (err: any) {
      failed++;
      failures.push("section B: unexpected error: " + String(err?.stack || err));
    }

    // ═══ Section C — buildSecondLineEvidence + domain guard ═════════════
    try {
      let calls: string[] = [];
      const same = await buildSecondLineEvidence(
        { sources: ["own_website"], website: "testgard.no" },
        { fetchImpl: pageFetch(SITE_HTML, "https://www.testgard.no/hjem", calls) },
      );
      assertEq(calls, ["https://testgard.no"], "c-1: one fetch of the website_ok homepage (scheme added)");
      assertEq(same.length, 1, "c-2: same host (www stripped) -> one evidence item");
      assertEq(same[0]?.source_url, "https://www.testgard.no/hjem", "c-3: source_url is the final URL");
      assertTrue(!!same[0] && same[0].content_excerpt.includes("Vi selger egg og poteter") && !same[0].content_excerpt.includes("<") && !same[0].content_excerpt.includes("var a=1"), "c-4: excerpt is plain visible text (no tags/scripts)");

      calls = [];
      const other = await buildSecondLineEvidence(
        { sources: ["own_website"], website: "https://testgard.no" },
        { fetchImpl: pageFetch(SITE_HTML, "https://domeneshop.no/parkert", calls) },
      );
      assertEq(other, [], "c-5: final URL on a different domain -> NOT sent");
      const sub = await buildSecondLineEvidence(
        { sources: ["own_website"], website: "https://testgard.no" },
        { fetchImpl: pageFetch(SITE_HTML, "https://testgard.no.evil.example/x", calls) },
      );
      assertEq(sub, [], "c-6: lookalike host -> NOT sent");

      calls = [];
      const noOwn = await buildSecondLineEvidence(
        { sources: ["facebook_official_page"], website: "https://testgard.no" },
        { fetchImpl: pageFetch(SITE_HTML, null, calls) },
      );
      assertEq(noOwn, [], "c-7: no own_website source -> []");
      assertEq(calls.length, 0, "c-8: no own_website source -> no fetch at all");

      const throwing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
      assertEq(await buildSecondLineEvidence({ sources: ["own_website"], website: "https://testgard.no" }, { fetchImpl: throwing }), [], "c-9: fetch failure -> []");
      assertEq(
        await buildSecondLineEvidence({ sources: ["own_website"], website: "https://testgard.no" }, { fetchImpl: pageFetch(SITE_HTML, null, [], 404) }),
        [],
        "c-10: HTTP 404 -> []",
      );
      assertEq(await buildSecondLineEvidence({ sources: ["own_website"], website: null }, { fetchImpl: throwing }), [], "c-11: no website -> []");

      const big = "<html><body><p>" + "ord ".repeat(3000) + "</p></body></html>";
      const capped = await buildSecondLineEvidence({ sources: ["own_website"], website: "https://testgard.no" }, { fetchImpl: pageFetch(big, null, []) });
      assertEq(capped[0]?.content_excerpt.length, 2000, "c-12: excerpt capped by the judge module's 2000-char cap");

      const prev = process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED;
      try {
        const cases: Array<[string | undefined, boolean]> = [[undefined, false], ["", false], ["0", false], ["false", false], ["TRUE", false], ["yes", false], ["1", true], ["true", true]];
        for (const [v, want] of cases) {
          if (v === undefined) delete process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED;
          else process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED = v;
          assertEq(isRfbSecondLineEvidenceEnabled(), want, `c-13: flag value ${JSON.stringify(v)} -> ${want}`);
        }
      } finally {
        if (prev === undefined) delete process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED;
        else process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED = prev;
      }
    } catch (err: any) {
      failed++;
      failures.push("section C: unexpected error: " + String(err?.stack || err));
    }

    // ═══ Sections D + E — DB-backed (isolated in-memory DB) ═════════════
    const prevDb = initMod.getDb();
    const prevSecondLine = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const prevEvidence = process.env.RFB_SECOND_LINE_EVIDENCE_ENABLED;
    const prevAdminKey = process.env.ADMIN_KEY;
    const db = new Database(":memory:");
    const setEnv = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://testgard.no', 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, 'Testveien 1, 2600 Lillehammer', '91234567', ?, ?, ?, '[]', '{}', 'pending_verify', 'partial')`,
      );
      // Live website (headProbe 200) + own-domain email, but thin content ->
      // first line fails, own_website is the accepted second-line source.
      function seed(id: string, email: string | null = "kari@testgard.no", website: string | null = "https://testgard.no"): void {
        insertAgent.run(id, `Testgård ${id}`, `key-${id}`);
        insertKnowledge.run(id, email, website, "kort");
      }
      const pickOnly = (id: string) => (dbi: any) => dbi.prepare(
        `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                k.verification_status, k.enrichment_status,
                k.last_verified_at, k.last_http_check_at, k.last_http_status
           FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`,
      ).all(id);
      const urlProbeFetch = (async () => ({ status: 200 })) as any;

      async function runD(id: string, evidenceFlag: string | undefined, secondLineFlag = "true") {
        const judgeCalls: any[] = [];
        const evidenceCalls: string[] = [];
        setEnv("RFB_SECOND_LINE_VERIFICATION_ENABLED", secondLineFlag);
        setEnv("RFB_SECOND_LINE_EVIDENCE_ENABLED", evidenceFlag);
        const out = await runVerifierBatch({
          db,
          pickFn: pickOnly(id),
          headProbe: async () => 200,
          brregLookup: null,
          urlProbeFetch,
          secondLineJudgeFn: async (p: any) => { judgeCalls.push(p); return { approved: false, reason: "for tynt" }; },
          secondLineEvidenceFetch: pageFetch(SITE_HTML, "https://testgard.no/", evidenceCalls),
        });
        const stored = (db.prepare(`SELECT verification_status, verification_review_reason FROM agent_knowledge WHERE agent_id = ?`).get(id) as any);
        return { r: out.results[0], judgeCalls, evidenceCalls, stored };
      }

      // ── Section D ──
      seed("d1");
      const baseline = await runD("d1", undefined);
      assertEq(baseline.evidenceCalls.length, 0, "d-1: evidence flag unset -> evidence fetcher never called");
      assertTrue(baseline.judgeCalls.length === 1 && !("evidence" in baseline.judgeCalls[0]), "d-2: evidence flag unset -> judge called without evidence");
      assertEq(baseline.r.new_verification_status, "pending_verify", "d-3: baseline verdict pending_verify (judge rejects)");
      for (const v of ["0", "false", "yes", "TRUE"]) {
        const x = await runD("d1", v);
        assertEq(x.evidenceCalls.length, 0, `d-4: evidence flag ${v} -> evidence fetcher never called`);
        assertTrue(x.judgeCalls.length === 1 && !("evidence" in x.judgeCalls[0]), `d-5: evidence flag ${v} -> judge called without evidence`);
        assertEq(x.r.new_verification_status, baseline.r.new_verification_status, `d-6: evidence flag ${v} -> verdict unchanged`);
        assertEq(x.stored.verification_review_reason, baseline.stored.verification_review_reason, `d-7: evidence flag ${v} -> persisted reason byte-identical`);
      }
      const offBoth = await runD("d1", "true", "false");
      assertEq(offBoth.evidenceCalls.length, 0, "d-8: second line off (evidence flag on) -> no evidence fetch");
      assertEq(offBoth.judgeCalls.length, 0, "d-9: second line off -> no judge call");

      const on = await runD("d1", "true");
      assertEq(on.evidenceCalls, ["https://testgard.no"], "d-10: evidence flag on -> exactly one homepage fetch");
      assertTrue(Array.isArray(on.judgeCalls[0]?.evidence) && on.judgeCalls[0].evidence[0].content_excerpt.includes("Vi selger egg"), "d-11: evidence flag on -> judge receives the homepage excerpt");
      assertEq(on.r.new_verification_status, baseline.r.new_verification_status, "d-12: same judge verdict -> same outcome (flag adds evidence only)");

      // ── Section E — preview route ──
      process.env.ADMIN_KEY = "test-admin-key-second-line-preview";
      setEnv("RFB_SECOND_LINE_EVIDENCE_ENABLED", undefined); // preview uses evidence regardless
      seed("e1");
      seed("e2", null); // no email -> deterministic check fails
      // Stored verdict from an earlier verifier run.
      db.prepare(`UPDATE agent_knowledge SET verification_review_reason = ?, verified_second_line = 0 WHERE agent_id = 'e1'`).run(
        JSON.stringify({ second_line: { attempted: true, passes: false, judge_reason: "har ikke tilgang til nettsideinnholdet" } }),
      );
      const routeMod = require("../routes/admin-second-line-judge-preview") as typeof import("../routes/admin-second-line-judge-preview");
      const previewJudgeCalls: any[] = [];
      const previewFetchCalls: string[] = [];
      routeMod.__setSecondLinePreviewDepsForTesting({
        db,
        headProbe: async () => 200,
        brregLookup: null,
        judgeFn: async (p: any) => { previewJudgeCalls.push(p); return { approved: true, reason: "nettsiden nevner gården i Lillehammer" }; },
        evidenceFetch: pageFetch(SITE_HTML, "https://testgard.no/", previewFetchCalls),
      });
      const router = routeMod.default;
      const H = { "x-admin-key": "test-admin-key-second-line-preview" };
      try {
        const totalChanges = () => (db.prepare(`SELECT total_changes() AS n`).get() as any).n as number;
        const snapshot = () => JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all());
        const before = totalChanges();
        const snapBefore = snapshot();

        const r403 = await callRoute(router, { method: "POST", url: "/", headers: {}, body: { agentIds: ["e1"] } });
        assertEq(r403.status, 403, "e-1: no admin key -> 403");
        const r0 = await callRoute(router, { method: "POST", url: "/", headers: H, body: { agentIds: [] } });
        assertEq(r0.status, 400, "e-2: 0 ids -> 400");
        const rMissing = await callRoute(router, { method: "POST", url: "/", headers: H, body: {} });
        assertEq(rMissing.status, 400, "e-3: missing agentIds -> 400");
        const r26 = await callRoute(router, { method: "POST", url: "/", headers: H, body: { agentIds: Array.from({ length: 26 }, (_, i) => `x${i}`) } });
        assertEq(r26.status, 400, "e-4: 26 ids -> 400");

        const ok = await callRoute(router, { method: "POST", url: "/", headers: H, body: { agentIds: ["e1", "e2", "nope"] } });
        assertEq(ok.status, 200, "e-5: valid call -> 200");
        const rows = ok.body?.rows ?? [];
        const e1 = rows.find((x: any) => x.agent_id === "e1");
        const e2 = rows.find((x: any) => x.agent_id === "e2");
        const nope = rows.find((x: any) => x.agent_id === "nope");
        assertEq(rows.length, 3, "e-6: one row per id");
        assertEq(nope, { agent_id: "nope", error: "not_found" }, "e-7: unknown id -> not_found row");
        assertEq(e1?.name, "Testgård e1", "e-8: name");
        assertEq(e1?.stored_second_line_passes, false, "e-9: stored verdict read from verification_review_reason.second_line");
        assertEq(e1?.stored_second_line_reason, "har ikke tilgang til nettsideinnholdet", "e-10: stored reason");
        assertEq(e1?.shadow_passes, true, "e-11: shadow verdict from the judge with evidence");
        assertEq(e1?.shadow_judge_reason, "nettsiden nevner gården i Lillehammer", "e-12: shadow judge reason");
        assertEq(e1?.evidence_sent, true, "e-13: evidence_sent=true");
        assertEq(e1?.source_url, "https://testgard.no/", "e-14: source_url");
        assertTrue(typeof e1?.excerpt_shown === "string" && e1.excerpt_shown.includes("Vi selger egg") && e1.excerpt_shown.length <= 500, "e-15: excerpt_shown present and <= 500 chars");
        assertEq(e1?.skipped_reason, null, "e-16: no skipped_reason when the judge ran");
        assertTrue(previewJudgeCalls.length === 1 && Array.isArray(previewJudgeCalls[0].evidence), "e-17: judge called once (e1 only), with evidence, while the flag is OFF");
        assertTrue(typeof e2?.skipped_reason === "string" && e2.skipped_reason.includes("email_present"), "e-18: e2 deterministic fail -> skipped_reason names the failed check");
        assertEq(e2?.evidence_sent, false, "e-19: e2 -> no evidence sent");
        assertEq(previewFetchCalls.length, 1, "e-20: only the judged agent's homepage was fetched");

        assertEq(totalChanges(), before, "e-21: total_changes() unchanged across all preview calls (writes nothing)");
        assertEq(snapshot(), snapBefore, "e-22: agent_knowledge rows byte-identical after preview");
      } finally {
        routeMod.__setSecondLinePreviewDepsForTesting(null);
      }
    } catch (err: any) {
      failed++;
      failures.push("sections D/E: unexpected error: " + String(err?.stack || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      setEnv("RFB_SECOND_LINE_VERIFICATION_ENABLED", prevSecondLine);
      setEnv("RFB_SECOND_LINE_EVIDENCE_ENABLED", prevEvidence);
      setEnv("ADMIN_KEY", prevAdminKey);
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierSecondLineEvidenceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
