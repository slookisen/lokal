/**
 * opplevelser-bulk-load-admission-gate.test.ts — tests for the harvest
 * admission gate on POST /api/opplevelser/admin/bulk-load (dev-request
 * 2026-06-23-experiences-richer-profiles, faithfulness-inflow slice,
 * 2026-08-25).
 *
 * The gate: in APPLY mode, every row about to be INSERTED as a NEW
 * experience that carries an evidence_url is fetched (fetchPage) and graded
 * by the fail-closed LLM judge (judgeExperienceContentMatch) against that
 * page BEFORE admission. MATCH → inserted per today's Brreg-derived rules;
 * MISMATCH / judge failure / fetch failure / per-request budget cap → still
 * inserted but forced verification_status='needs_review', with the verdict +
 * reasoning stamped on the row (admission_verdict/admission_checked_at).
 * DRY-RUN spends ZERO fetch/judge budget. Full rationale: the block comment
 * above ADMISSION_GATE_MAX_JUDGED in src/routes/opplevelser.ts.
 *
 * Conventions mirror experiences-wrong-content-rate.test.ts (the judge-mock
 * precedent): in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"),
 * fresh requires per run, router.handle() as the HTTP entry point, Brreg
 * stubbed via __setBrregFetchForTesting, and a mocked globalThis.fetch keyed
 * on URL for evidence pages + the Anthropic endpoint — no live network
 * anywhere. The RFB db (agent_blocklist, read by the route's blocklist gate)
 * is pinned in-memory the same way tests/test.ts's orch-pr-18 block does.
 *
 * Covers:
 *   (a) dry-run: zero evidence-page fetches, zero judge calls, nothing
 *       written; admission_gate reports dry_run:true.
 *   (b) apply, mixed cohort under one verified_active provider: MATCH row
 *       admitted as `verified` (today's rule), MISMATCH row lands
 *       needs_review with "mismatch: …" stamped, judge-failure row lands
 *       needs_review "unresolved: …", SSRF-blocked-evidence row lands
 *       needs_review "unresolved: …" — plus the response's admission_gate
 *       tallies/results.
 *   (c) a row with NO evidence_url keeps today's behavior exactly: not
 *       judged, not stamped, admitted `verified` under a verified_active
 *       provider.
 *   (d) composition with the publish-gated by-id surface: the quarantined
 *       MISMATCH row 404s on public GET /:id while the MATCH row serves.
 *   (e) budget cap: a 51-new-row apply judges exactly
 *       ADMISSION_GATE_MAX_JUDGED (50) rows and fail-closes the rest to
 *       needs_review with the "admission-gate cap" reason.
 */

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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/bulk-load";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
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

/** fetchPage()-compatible Response stub (arrayBuffer + headers.get — same
 * shape as experiences-wrong-content-rate.test.ts's mkPageResponse). */
function mkPageResponse(html: string, finalUrl: string): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
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

export function runOpplevelserBulkLoadAdmissionGateTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "bulk-load-admission-gate-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-admission-gate";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: unknown = null;
    let expBrreg: typeof import("../services/experience-brreg") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // Pin an in-memory RFB db for the route's agent_blocklist gate (same
      // technique as tests/test.ts orch-pr-18 — the blocklist table lives on
      // the RFB db, not the experiences db).
      const initMod = require("../database/init") as typeof import("../database/init");
      const RfbDatabase = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new RfbDatabase(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      // Brreg stub: "Aktiv …" provider names resolve to a verified_active
      // entity; anything else is unverified.
      expBrreg.__setBrregFetchForTesting(async (url: string) => {
        const navn = decodeURIComponent(new URL(url).searchParams.get("navn") || "");
        const lc = navn.toLowerCase();
        const enheter = lc.startsWith("aktiv")
          ? [{
              organisasjonsnummer: lc.includes("kapasitet") ? "913000002" : "913000001",
              navn: navn.toUpperCase(),
              naeringskode1: { kode: "93.291" },
              forretningsadresse: { kommune: "Tromsø" },
              konkurs: false,
              underAvvikling: false,
              underTvangsavviklingEllerTvangsopplosning: false,
              slettedato: null,
            }]
          : [];
        return { ok: true, status: 200, json: async () => ({ _embedded: { enheter } }) };
      });

      // Evidence-page + Anthropic mock, with call counters so the dry-run
      // case can assert ZERO budget spent.
      let pageFetches = 0;
      let judgeCalls = 0;
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr === "https://api.anthropic.com/v1/messages") {
          judgeCalls++;
          const body = JSON.parse(init?.body ?? "{}");
          const promptText: string = body?.messages?.[0]?.content ?? "";
          if (promptText.includes("Mismatch nordlystur")) {
            return mkAnthropicResponse("MISMATCH\nSiden handler om noe helt annet.");
          }
          if (promptText.includes("Dommerfeil skitur")) {
            // Judge-side failure: unparseable JSON → { ok: false } fail-closed.
            return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response;
          }
          return mkAnthropicResponse("MATCH\nStemmer med kilden.");
        }
        pageFetches++;
        if (urlStr === "https://evidens.example/hvalsafari") {
          return mkPageResponse("<html><body>Hvalsafari med båt fra kaia i Tromsø, avgang hver dag.</body></html>", urlStr);
        }
        if (urlStr === "https://evidens.example/nordlys") {
          return mkPageResponse("<html><body>Dette er en side om noe helt annet.</body></html>", urlStr);
        }
        if (urlStr === "https://evidens.example/skitur") {
          return mkPageResponse("<html><body>Skitur i fjellet med guide.</body></html>", urlStr);
        }
        if (urlStr.startsWith("https://evidens.example/cap/")) {
          return mkPageResponse("<html><body>Evidensside for kapasitetstesten.</body></html>", urlStr);
        }
        throw new Error("admission-gate test: unexpected fetch URL: " + urlStr);
      }) as unknown as typeof fetch;

      const PAYLOAD = {
        experiences: [
          { title: "Hvalsafari fra kaia", provider_name: "Aktiv Opplevelser AS", category: "dyreliv_safari",
            kommune: "Tromsø", fylke: "Troms", price_from: 1290, confidence: "high",
            evidence_url: "https://evidens.example/hvalsafari" },
          { title: "Mismatch nordlystur", provider_name: "Aktiv Opplevelser AS", category: "natur_friluft",
            kommune: "Tromsø", fylke: "Troms", price_from: 1490, confidence: "high",
            evidence_url: "https://evidens.example/nordlys" },
          { title: "Dommerfeil skitur", provider_name: "Aktiv Opplevelser AS", category: "natur_friluft",
            kommune: "Tromsø", fylke: "Troms", price_from: 990, confidence: "high",
            evidence_url: "https://evidens.example/skitur" },
          // SSRF-blocked before any network call (same deterministic-failure
          // technique as wcr-3's fetchfail row) → fetch failure → unresolved.
          { title: "Blokkert fisketur", provider_name: "Aktiv Opplevelser AS", category: "natur_friluft",
            kommune: "Tromsø", fylke: "Troms", price_from: 790, confidence: "high",
            evidence_url: "http://localhost/fisketur" },
          // No evidence_url at all → never judged, today's rule unchanged
          // (verified under a verified_active provider).
          { title: "Uten evidens byvandring", provider_name: "Aktiv Opplevelser AS", category: "kultur_historie",
            kommune: "Tromsø", fylke: "Troms", price_from: 290, confidence: "high" },
        ],
      };

      const expRow = (title: string) =>
        expDb.prepare("SELECT id, verification_status, admission_verdict, admission_checked_at FROM experiences WHERE title = ?").get(title) as
          | { id: string; verification_status: string; admission_verdict: string | null; admission_checked_at: string | null }
          | undefined;

      // ── (a) dry-run: gate spends NOTHING ────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: PAYLOAD });
        assertEq(r.status, 200, "ag-1a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "ag-1b: apply omitted -> dry_run");
        assertEq(pageFetches, 0, "ag-1c: dry-run fetched ZERO evidence pages");
        assertEq(judgeCalls, 0, "ag-1d: dry-run spent ZERO judge calls");
        assertEq(r.body.admission_gate?.dry_run, true, "ag-1e: admission_gate reports it only runs in apply mode");
        const n = (expDb.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n;
        assertEq(n, 0, "ag-1f: dry-run wrote nothing");
      }

      // ── (b) apply: mixed cohort verdict routing ─────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { ...PAYLOAD, apply: true } });
        assertEq(r.status, 200, "ag-2a: apply -> 200");
        assertEq(r.body.experiences_inserted, 5, "ag-2b: ALL 5 rows inserted — the gate quarantines, it never drops data");
        assertEq(
          { judged: r.body.admission_gate.judged, match: r.body.admission_gate.match, mismatch: r.body.admission_gate.mismatch, unresolved: r.body.admission_gate.unresolved, capped: r.body.admission_gate.capped },
          { judged: 4, match: 1, mismatch: 1, unresolved: 2, capped: 0 },
          "ag-2c: admission_gate tallies — 4 evidence-backed rows judged (match+mismatch+unresolved partition), the no-evidence row never judged",
        );
        assertEq((r.body.admission_gate.results as any[]).length, 4, "ag-2d: per-row results for exactly the 4 gated rows");

        const match = expRow("Hvalsafari fra kaia");
        assertEq(match?.verification_status, "verified", "ag-2e: MATCH row admitted as `verified` (today's verified_active rule)");
        assertTrue(!!match?.admission_verdict && match.admission_verdict.startsWith("match:"), "ag-2f: MATCH row's verdict stamped for inspection");
        assertTrue(!!match?.admission_checked_at, "ag-2g: MATCH row's admission_checked_at stamped");

        const mismatch = expRow("Mismatch nordlystur");
        assertEq(mismatch?.verification_status, "needs_review", "ag-2h: MISMATCH row forced needs_review despite the verified_active provider");
        assertTrue(!!mismatch?.admission_verdict && mismatch.admission_verdict.startsWith("mismatch:"), "ag-2i: MISMATCH verdict + judge reasoning stamped");

        const judgefail = expRow("Dommerfeil skitur");
        assertEq(judgefail?.verification_status, "needs_review", "ag-2j: judge-failure row fails CLOSED to needs_review — never admitted verified on doubt");
        assertTrue(!!judgefail?.admission_verdict && judgefail.admission_verdict.startsWith("unresolved:"), "ag-2k: judge failure stamped as unresolved");

        const fetchfail = expRow("Blokkert fisketur");
        assertEq(fetchfail?.verification_status, "needs_review", "ag-2l: evidence-fetch-failure row fails CLOSED to needs_review");
        assertTrue(!!fetchfail?.admission_verdict && fetchfail.admission_verdict.startsWith("unresolved:"), "ag-2m: fetch failure stamped as unresolved");

        // ── (c) no-evidence row: untouched by the gate ────────────────────
        const noEvidence = expRow("Uten evidens byvandring");
        assertEq(noEvidence?.verification_status, "verified", "ag-3a: no-evidence row keeps today's behavior (verified under verified_active) — the gate only judges evidence-backed rows");
        assertEq(noEvidence?.admission_verdict, null, "ag-3b: no-evidence row never stamped");

        // ── (d) composition with the publish-gated by-id surface ──────────
        {
          const served = await callRoute(opplevelserRouter, { method: "GET", url: `/${match!.id}`, headers: {} });
          assertEq(served.status, 200, "ag-4a: the MATCH (verified) row serves on public GET /:id");
          const hidden = await callRoute(opplevelserRouter, { method: "GET", url: `/${mismatch!.id}`, headers: {} });
          assertEq(hidden.status, 404, "ag-4b: the quarantined MISMATCH row 404s on public GET /:id — the two fixes compose: wrong inflow is quarantined AND the by-id door respects the quarantine");
        }
      }

      // ── (e) budget cap: 51 new rows -> 50 judged, the rest fail-closed ──
      {
        pageFetches = 0;
        judgeCalls = 0;
        // Distinct kommune per row so the re-harvest dedup guard (same
        // provider + kommune + fuzzy title) can never fold two cap-fixture
        // rows together — every row must genuinely reach the insert branch.
        const capRows = Array.from({ length: 51 }, (_, i) => ({
          title: `Kapasitetstur ${i}`,
          provider_name: "Aktiv Kapasitet AS",
          category: "natur_friluft",
          kommune: `Kommune${i}`,
          fylke: "Troms",
          confidence: "medium",
          evidence_url: `https://evidens.example/cap/${i}`,
        }));
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { experiences: capRows, apply: true } });
        assertEq(r.status, 200, "ag-5a: 51-row apply -> 200");
        assertEq(r.body.admission_gate.judged, 50, "ag-5b: exactly ADMISSION_GATE_MAX_JUDGED (50) rows judged");
        assertEq(r.body.admission_gate.capped, 1, "ag-5c: the 51st row counted in `capped`, its own bucket");
        assertEq(judgeCalls, 50, "ag-5d: exactly 50 judge calls spent — the cap bounds real LLM spend, not just a counter");
        const capped = expDb
          .prepare("SELECT verification_status, admission_verdict FROM experiences WHERE title = 'Kapasitetstur 50'")
          .get() as { verification_status: string; admission_verdict: string | null } | undefined;
        assertEq(capped?.verification_status, "needs_review", "ag-5e: the capped row fails CLOSED to needs_review");
        assertTrue(
          !!capped?.admission_verdict && capped.admission_verdict.includes("admission-gate cap"),
          "ag-5f: the capped row's stamp names the cap as the reason",
        );
        const verifiedCount = (expDb
          .prepare("SELECT COUNT(*) AS n FROM experiences WHERE title LIKE 'Kapasitetstur %' AND verification_status = 'verified'")
          .get() as { n: number }).n;
        assertEq(verifiedCount, 50, "ag-5g: the 50 judged (MATCH) rows admitted verified as today");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-bulk-load-admission-gate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      try { expBrreg?.__setBrregFetchForTesting(null); } catch { /* best-effort */ }
      try {
        if (prevRfbDb) {
          (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb as any);
        }
      } catch { /* best-effort */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-admission-gate.test.ts`
if (require.main === module) {
  runOpplevelserBulkLoadAdmissionGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
