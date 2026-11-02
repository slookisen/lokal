/**
 * gardssalg-website-judgement-job.test.ts — tests for A2A dev-request
 * 2026-10-06-experiences-enrichment-plattformjobb-og-felles-serverjobbramme,
 * «Innsnevring 2026-10-28», skive 3j: the server-side half of the gårdssalg
 * website-discovery judge (file queue, no LLM on the server).
 *
 * Covers: candidate GET (auth, limit, ordering, public fields only, zero
 * writes); applyGardssalgWebsiteJudgements() (file-level + item-level
 * validation, every re-check, structural backstop override, GODKJENN via the
 * approve path, blocked write, AVVIS append, write-pause); the job tick on
 * the shared proposal file queue (flag off / no token / paused = zero GitHub
 * calls, files per tick, once per file, daily file cap across ticks, malformed
 * file rejected, envelope); the judge route's response unchanged; ZERO LLM
 * (no api.anthropic.com request, no global fetch).
 *
 * Setup mirrors experience-content-judgement-job.test.ts.
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
  opts: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const qIdx = opts.url.indexOf("?");
    const path = qIdx >= 0 ? opts.url.slice(0, qIdx) : opts.url;
    const query: Record<string, string> = {};
    if (qIdx >= 0) new URLSearchParams(opts.url.slice(qIdx + 1)).forEach((v, k) => { query[k] = v; });
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method, url: opts.url, originalUrl: opts.url, path,
      query, headers, body: opts.body ?? {},
      app: { get: () => undefined },
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "unhandled" } });
    });
  });
}

const SCHEMA = "gardssalg-website-judgements/v1";

export function runGardssalgWebsiteJudgementJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevEnv = {
      EXPERIENCES_DB_PATH: process.env.EXPERIENCES_DB_PATH,
      ADMIN_KEY: process.env.ADMIN_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    const prevFetch = globalThis.fetch;
    const ADMIN = process.env.ADMIN_KEY || "website-judgement-job-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-must-never-be-used";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const judgePath = require.resolve("./contact-candidate-judge");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    const jobPath = require.resolve("./gardssalg-website-judgement-job");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath, experienceStorePath, judgePath, opplevelserPath, jobPath,
    ]);
    let restoreMainDb: (() => void) | null = null;

    // ── No-LLM guards. ─────────────────────────────────────────────────
    let llmCalls = 0;
    let globalFetchCalls = 0;
    const isLlmUrl = (url: unknown) => String(url).includes("api.anthropic.com");
    const throwingFetch = (async (url: any) => {
      globalFetchCalls++;
      if (isLlmUrl(url)) llmCalls++;
      throw new Error(`global fetch must not be called (${String(url)})`);
    }) as typeof fetch;
    globalThis.fetch = throwingFetch;

    // ── GitHub contents-API stub. ──────────────────────────────────────
    type Entry = { name: string; path: string; type: "dir" | "file"; sha: string; size?: number };
    const gh = { dirs: new Map<string, Entry[]>(), files: new Map<string, { sha: string; text: string }>(), calls: [] as string[], urls: [] as string[] };
    const ghFetch = (async (url: any) => {
      if (isLlmUrl(url)) { llmCalls++; throw new Error("LLM via github seam"); }
      gh.urls.push(String(url));
      const u = new URL(String(url));
      const prefix = "/repos/slookisen/A2A/contents/";
      const path = decodeURIComponent(u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname);
      gh.calls.push(path);
      const dir = gh.dirs.get(path);
      if (dir) return { ok: true, status: 200, json: async () => dir } as unknown as Response;
      const f = gh.files.get(path);
      if (f) {
        return { ok: true, status: 200, json: async () => ({ encoding: "base64", content: Buffer.from(f.text, "utf8").toString("base64"), sha: f.sha }) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const ROOT = "gardssalg-website-judgements";
    function putFile(date: string, name: string, content: unknown, sha = `sha-${date}-${name}`): string {
      const path = `${ROOT}/${date}/${name}`;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      gh.files.set(path, { sha, text });
      const root = gh.dirs.get(ROOT) ?? [];
      if (!root.some((e) => e.name === date)) gh.dirs.set(ROOT, [...root, { name: date, path: `${ROOT}/${date}`, type: "dir", sha: `sha-${date}` }]);
      const list = (gh.dirs.get(`${ROOT}/${date}`) ?? []).filter((e) => e.path !== path);
      gh.dirs.set(`${ROOT}/${date}`, [...list, { name, path, type: "file", sha, size: Buffer.byteLength(text) }]);
      return path;
    }

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences") as any;
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const pauseSvc = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
      const opp = require("../routes/opplevelser") as typeof import("../routes/opplevelser");
      const router = opp.default as any;
      const job = require("./gardssalg-website-judgement-job") as typeof import("./gardssalg-website-judgement-job");
      const adminHeaders = { "x-admin-key": ADMIN };
      const setPause = (on: boolean) =>
        pauseSvc.setEnrichmentWritePause(
          init.getDb() as any,
          on ? { vertical: "experiences", enabled: true, reason: "wj test" } : { vertical: "experiences", enabled: false, cleared_by: "daniel" },
          "verifier",
        );

      const NOW = new Date();
      const nowMs = NOW.getTime();
      const CREATED = new Date(nowMs - 60 * 60_000).toISOString();
      const TODAY = NOW.toISOString().slice(0, 10);
      const env = { GARDSSALG_WEBSITE_JUDGEMENT_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
      // The apply fn is passed explicitly: the approve path inside it reads the
      // module-level experiences DB, so it must be THIS test's (swapped-in)
      // opplevelser instance, not one a lazy import() might resolve elsewhere.
      const tick = (over: Record<string, unknown> = {}) =>
        job.tickGardssalgWebsiteJudgements({ apply: opp.applyGardssalgWebsiteJudgements, fetchImpl: ghFetch, now: NOW, env, expDb, mainDb: () => init.getDb(), ...over } as any);
      const apply = (items: unknown[], over: Record<string, unknown> = {}) =>
        opp.applyGardssalgWebsiteJudgements(expDb, items, { createdAt: CREATED, runId: "wj-test", now: NOW, ...over } as any);

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, poststed, hjemmeside, content_source, brreg_verified, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', NULL, NULL, NULL, @hjemmeside, 'provider_site', 0, NULL, '2026-01-01')`,
      );
      const urlOf = (id: string) => `https://${id.replace(/[^a-z0-9]/g, "")}.no`;
      /** Seeds a provider + a queue row. updatedAt orders the candidate GET. */
      const seed = (id: string, over: { url?: string; confidence?: number; hjemmeside?: string | null; updatedAt?: string } = {}): string => {
        insertProvider.run({ id, navn: `Gard ${id}`, hjemmeside: over.hjemmeside ?? null });
        expStore.upsertGardssalgWebsiteReviewQueue({
          provider_id: id, provider_name: `Gard ${id}`, candidate_url: over.url ?? urlOf(id),
          confidence: over.confidence ?? 0.92, evidence: JSON.stringify({ name_found: true, place_found: true }),
        });
        if (over.updatedAt) expDb.prepare("UPDATE gardssalg_website_review_queue SET updated_at = ? WHERE provider_id = ?").run(over.updatedAt, id);
        return id;
      };
      const q = (id: string): any => expDb.prepare("SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?").get(id);
      const hj = (id: string): string | null => (expDb.prepare("SELECT hjemmeside FROM experience_providers WHERE id = ?").get(id) as any)?.hjemmeside ?? null;
      const item = (id: string, over: Record<string, unknown> = {}) => ({ provider_id: id, candidate_url: urlOf(id), verdict: "GODKJENN", reason: "Siden tilhører produsenten.", ...over });
      const dumpAll = (): string =>
        JSON.stringify([
          expDb.prepare("SELECT * FROM gardssalg_website_review_queue ORDER BY provider_id").all(),
          expDb.prepare("SELECT id, hjemmeside FROM experience_providers ORDER BY id").all(),
        ]);
      const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

      // ── wj-1: candidate GET. ─────────────────────────────────────────
      {
        seed("c-new", { updatedAt: sqlTs(nowMs - 1 * 86_400_000) });
        seed("c-old", { updatedAt: sqlTs(nowMs - 9 * 86_400_000) });
        seed("c-mid", { updatedAt: sqlTs(nowMs - 5 * 86_400_000), confidence: 1.0 });
        seed("c-bad", { updatedAt: sqlTs(nowMs - 7 * 86_400_000), url: "https://cbad.no/favicon.ico" });
        seed("c-low", { confidence: 0.5 });
        seed("c-parked");
        expDb.prepare("UPDATE gardssalg_website_review_queue SET parked_since = datetime('now') WHERE provider_id = 'c-parked'").run();
        seed("c-other");
        expDb.prepare("UPDATE gardssalg_website_review_queue SET reason = 'verification_failed' WHERE provider_id = 'c-other'").run();

        const noKey = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judge-candidates" });
        assertEq(noKey.status, 403, "wj-1a: no admin key -> 403");
        const before = dumpAll();
        const r = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judge-candidates", headers: adminHeaders });
        assertEq(r.status, 200, "wj-1b: 200");
        assertEq(r.body.rows.map((x: any) => x.provider_id), ["c-old", "c-bad", "c-mid", "c-new"], "wj-1c: judge-route predicate (band, not parked, right reason) and updated_at ASC order");
        assertEq(Object.keys(r.body.rows[0]).sort(), ["candidate_url", "confidence", "final_url", "id", "provider_id", "provider_name", "source_context", "structural_defect", "structural_defect_reason", "updated_at"], "wj-1d: public catalog fields only (+ source_context + structural_defect)");
        assertEq(r.body.rows.map((x: any) => x.structural_defect), [false, true, false, false], "wj-1e: structural_defect from classifyContactCandidateDefect");
        assertTrue(typeof r.body.rows[1].structural_defect_reason === "string" && r.body.rows[0].structural_defect_reason === null, "wj-1f: reason present only for a defect");
        assertTrue(typeof r.body.rows[0].source_context === "string" && r.body.rows[0].source_context.includes("produsentnavn"), "wj-1g: source_context is the judge's public evidence summary");
        assertEq([r.body.judgement_schema, r.body.max_items_per_file, r.body.count], [SCHEMA, 50, 4], "wj-1h: schema hint + max items + count");
        assertEq(dumpAll(), before, "wj-1i: zero writes");
        const l2 = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judge-candidates?limit=2", headers: adminHeaders });
        assertEq(l2.body.rows.map((x: any) => x.provider_id), ["c-old", "c-bad"], "wj-1j: limit honoured, oldest first");
        const l999 = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judge-candidates?limit=999", headers: adminHeaders });
        assertEq(l999.status, 200, "wj-1k: over-max limit is clamped to 50, not an error");
        const bads = await Promise.all(["0", "-1", "abc", "1.5", ""].map((v) => callRoute(router, { method: "GET", url: `/admin/gardssalg-website-judge-candidates?limit=${v}`, headers: adminHeaders })));
        assertEq(bads.map((b) => b.status), [400, 400, 400, 400, 400], "wj-1l: invalid limit -> 400");
        const c = opp.selectGardssalgWdJudgeCandidates(expDb, "50");
        assertEq(c && c.limit, 50, "wj-1m: helper max limit 50");
        expDb.prepare("DELETE FROM gardssalg_website_review_queue").run();
      }

      // ── wj-2: file-level + item-level validation. ────────────────────
      {
        const v = job.validateGardssalgWebsiteJudgementFile;
        const good = { schema: SCHEMA, run_id: "r1", created_at: CREATED, items: [] };
        assertEq("error" in v(good), false, "wj-2a: valid shape");
        assertEq("error" in v([]), true, "wj-2b: not an object");
        assertEq("error" in v({ ...good, schema: "x/v1" }), true, "wj-2c: wrong schema");
        assertEq("error" in v({ ...good, run_id: "" }), true, "wj-2d: empty run_id");
        assertEq("error" in v({ ...good, created_at: "2026-11-01 10:00:00" }), true, "wj-2e: created_at without zone");
        assertEq("error" in v({ ...good, created_at: new Date(nowMs + 3600_000).toISOString() }), true, "wj-2f: future created_at");
        assertEq("error" in v({ ...good, items: {} }), true, "wj-2g: items not an array");
        seed("v-1");
        const before = dumpAll();
        const cases: Array<[string, unknown[]]> = [
          ["0 items", []],
          ["51 items", Array.from({ length: 51 }, (_, i) => item(`v-x${i}`))],
          ["non-object item", [item("v-1"), "x"]],
          ["missing provider_id", [{ candidate_url: urlOf("v-1"), verdict: "GODKJENN", reason: "r" }]],
          ["duplicate provider_ids", [item("v-1"), item("v-1", { verdict: "AVVIS" })]],
        ];
        for (const [label, items] of cases) {
          const out = await apply(items);
          assertEq(out.ok, false, `wj-2h: ${label} -> whole file rejected`);
        }
        assertEq(dumpAll(), before, "wj-2i: file-level rejects wrote nothing");
        seed("v-2");
        const before2 = dumpAll();
        const out: any = await apply([item("v-1", { verdict: "MAYBE" }), item("v-2", { reason: "x".repeat(501) })]);
        assertEq(out.results.map((r: any) => r.reason), ["invalid_verdict", "invalid_reason"], "wj-2j: item-level rejects (verdict, over-long reason)");
        const out2: any = await apply([item("v-1".padEnd(70, "x")), item("v-2", { candidate_url: "" }), item("v-2".concat("-nope"))]);
        assertEq(out2.results.map((r: any) => r.reason), ["invalid_provider_id", "invalid_candidate_url", "not_found"], "wj-2k: over-long id, empty url, unknown provider");
        assertEq(dumpAll(), before2, "wj-2l: item-level rejects wrote nothing");
        expDb.prepare("DELETE FROM gardssalg_website_review_queue").run();
      }

      // ── wj-3: re-checks. ─────────────────────────────────────────────
      {
        seed("r-chg");
        seed("r-parked");
        expDb.prepare("UPDATE gardssalg_website_review_queue SET parked_since = datetime('now') WHERE provider_id = 'r-parked'").run();
        seed("r-reason");
        expDb.prepare("UPDATE gardssalg_website_review_queue SET reason = 'verification_failed' WHERE provider_id = 'r-reason'").run();
        seed("r-low", { confidence: 0.5 });
        seed("r-ok");
        const before = dumpAll();
        const out: any = await apply([
          item("r-chg", { candidate_url: "https://annen.no" }),
          item("r-parked"),
          item("r-reason"),
          item("r-low"),
          item("nope-1"),
        ]);
        assertEq(out.results.map((r: any) => r.reason), ["candidate_changed", "not_eligible", "not_eligible", "out_of_scope", "not_found"], "wj-3a: candidate_changed / parked / wrong reason / out_of_scope / not_found");
        assertEq(dumpAll(), before, "wj-3b: no re-check failure wrote anything");
        assertEq(hj("r-chg"), null, "wj-3c: candidate_changed -> no hjemmeside write");
      }

      // ── wj-4: structural backstop overrides a client GODKJENN. ───────
      {
        seed("b-fav", { url: "https://bfav.no/favicon.ico" });
        const out: any = await apply([item("b-fav", { candidate_url: "https://bfav.no/favicon.ico", verdict: "GODKJENN" })]);
        assertEq([out.results[0].result, out.results[0].verdict, out.results[0].via], ["written", "AVVIS", "backstop"], "wj-4a: defective URL + client GODKJENN -> AVVIS via backstop");
        assertTrue(q("b-fav").reason.startsWith("judge backstop AVVIS"), "wj-4b: queue reason carries the backstop note");
        assertEq(hj("b-fav"), null, "wj-4c: nothing written to the provider");
      }

      // ── wj-5: GODKJENN happy path, blocked write, AVVIS append. ──────
      {
        seed("g-ok");
        seed("g-blocked", { hjemmeside: "https://allerede-satt.no" });
        seed("a-no");
        const out: any = await apply([
          item("g-ok"),
          item("g-blocked"),
          item("a-no", { verdict: "AVVIS", reason: "Ser ut som\n en annen   produsent." }),
        ]);
        assertEq(out.ok, true, "wj-5a: ok");
        assertEq([out.results[0].result, out.results[0].verdict], ["written", "GODKJENN"], "wj-5b: GODKJENN written");
        assertEq([hj("g-ok"), q("g-ok")], [urlOf("g-ok"), undefined], "wj-5c: written via the approve path (hjemmeside set, queue row cleared)");
        assertEq([out.results[1].result, out.results[1].verdict, out.results[1].via], ["written", "AVVIS", "write_blocked"], "wj-5d: blocked write counted as AVVIS, not approval");
        assertTrue(q("g-blocked").reason.startsWith("judge GODKJENN but write blocked:"), "wj-5e: blocked-write note appended");
        assertEq(hj("g-blocked"), "https://allerede-satt.no", "wj-5f: fill-only guard held");
        assertEq([out.results[2].verdict, out.results[2].via], ["AVVIS", "client"], "wj-5g: client AVVIS");
        assertEq(q("a-no").reason, "routine judge AVVIS: Ser ut som en annen produsent.", "wj-5h: AVVIS appends 'routine judge AVVIS: <reason>' (whitespace collapsed)");
        assertEq(hj("a-no"), null, "wj-5i: AVVIS writes nothing to the provider");
        assertEq(out.totals, { written: 3, rejected: 0, godkjenn: 1, avvis: 2 }, "wj-5j: totals");
        seed("a-race");
        const out2: any = await apply([item("a-race", { verdict: "AVVIS" })]);
        assertEq(out2.results[0].result, "written", "wj-5k: AVVIS lands on an untouched row");
        const again: any = await apply([item("a-race", { verdict: "AVVIS" })]);
        assertEq(again.results[0].reason, "not_eligible", "wj-5l: re-applying the same file is idempotent (row no longer a candidate)");
      }

      // ── wj-6: write-pause. ───────────────────────────────────────────
      {
        seed("p-1");
        seed("p-2");
        const before = dumpAll();
        setPause(true);
        let threw = false;
        try { await apply([item("p-1"), item("p-2", { verdict: "AVVIS" })]); } catch (err) { threw = pauseSvc.isEnrichmentWritePausedError(err); }
        setPause(false);
        assertTrue(threw, "wj-6a: a live pause throws EnrichmentWritePausedError");
        assertEq(dumpAll(), before, "wj-6b: nothing written under the pause (whole file)");
      }

      // ── wj-7: the job tick. ──────────────────────────────────────────
      {
        gh.calls.length = 0;
        const beforeOff = dumpAll();
        const r1 = await tick({ env: { A2A_READ_PAT: "test-pat" } });
        const r2 = await tick({ env: { GARDSSALG_WEBSITE_JUDGEMENT_JOB_ENABLED: "1", A2A_READ_PAT: "test-pat" } });
        const r3 = await tick({ env: { GARDSSALG_WEBSITE_JUDGEMENT_JOB_ENABLED: "true" } });
        setPause(true);
        const r4 = await tick();
        setPause(false);
        assertEq([r1.skipped_reason, r2.skipped_reason, r3.skipped_reason, r4.skipped_reason], ["disabled", "disabled", "no_token", "paused"], "wj-7a: flag off / not \"true\" / no token / paused");
        assertEq(gh.calls.length, 0, "wj-7b: zero GitHub requests when skipped");
        assertEq(dumpAll(), beforeOff, "wj-7c: flag OFF -> no writes");
        const flagOffEnv: Record<string, string | undefined> = {};
        assertEq(job.gardssalgWebsiteJudgementJobEnabled(flagOffEnv), false, "wj-7d: default OFF");

        const yesterday = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
        for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) seed(id);
        const f = (items: unknown[], extra: Record<string, unknown> = {}) => ({ schema: SCHEMA, run_id: "run-x", created_at: CREATED, items, ...extra });
        const pA = putFile(yesterday, "a.json", f([item("t-1")]));
        const pB = putFile(yesterday, "b.json", f([item("t-2", { verdict: "AVVIS" })]));
        const pC = putFile(TODAY, "c.json", f([item("t-3")], { schema: "wrong/v1" }));
        const pD = putFile(TODAY, "d.json", f([item("t-4")]));
        const pE = putFile(TODAY, "e.json", f([item("t-5")]));
        const t1 = await tick();
        assertEq(t1.processed.map((p) => p.path), [pA, pB, pC, pD], "wj-7e: 4 files per tick, oldest dir first");
        assertEq(t1.processed.map((p) => p.status), ["applied", "applied", "error", "applied"], "wj-7f: malformed (wrong schema) file -> rejected as error");
        assertEq([hj("t-1"), q("t-2").reason, q("t-3").reason, hj("t-4")], [urlOf("t-1"), "routine judge AVVIS: Siden tilhører produsenten.", "website_discovery_candidate", urlOf("t-4")], "wj-7g: applied files wrote; rejected file wrote nothing");
        const runs = init.getDb().prepare("SELECT * FROM runs WHERE agent = ? ORDER BY rowid").all(job.GARDSSALG_WEBSITE_JUDGEMENT_AGENT) as any[];
        assertEq(runs.length, 1, "wj-7h: one envelope");
        assertEq(JSON.parse(runs[0].claims), [
          { type: "db_state_change", value: 3, meta: { kind: "website_judgements_applied", source: "website_judgement_job" } },
          { type: "db_state_change", value: 4, meta: { kind: "website_judgements_processed" } },
          { type: "db_state_change", value: 2, meta: { kind: "website_judgements_approved", source: "website_judgement_job" } },
        ], "wj-7i: envelope claims");
        assertEq([runs[0].vertical, runs[0].status], ["experiences", "partial"], "wj-7j: partial (one file errored)");

        const t2 = await tick();
        assertEq(t2.processed.map((p) => p.path), [pE], "wj-7k: the fifth file on the next tick");
        putFile(yesterday, "a.json", f([item("t-1", { verdict: "AVVIS" })]), "sha-changed");
        const t3 = await tick();
        assertEq(t3.processed.length, 0, "wj-7l: processed files never re-run (even with a new sha)");

        // Pause raised mid-file: nothing written, file not recorded, retried.
        seed("t-6");
        const pF = putFile(TODAY, "f.json", f([item("t-6")]));
        const pausingApply = async (db: any, items: any, o: any) => { setPause(true); return opp.applyGardssalgWebsiteJudgements(db, items, o); };
        const t4 = await tick({ apply: pausingApply });
        setPause(false);
        assertEq([t4.processed.length, t4.failures.map((x) => x.path), hj("t-6")], [0, [pF], null], "wj-7m: pause mid-file -> per-file failure, nothing written");
        const t5 = await tick();
        assertEq([t5.processed.map((p) => p.path), hj("t-6")], [[pF], urlOf("t-6")], "wj-7n: retried and applied once the pause clears");

        const st403 = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judgements-status" });
        assertEq(st403.status, 403, "wj-7o: status GET needs the admin key");
        const stR = await callRoute(router, { method: "GET", url: "/admin/gardssalg-website-judgements-status", headers: adminHeaders });
        assertEq([stR.status, stR.body.success, stR.body.enabled], [200, true, false], "wj-7p: status route answers (flag unset in test process -> enabled false)");
        const st = job.getGardssalgWebsiteJudgementsStatus(expDb, env, { mainDb: () => init.getDb() });
        assertEq([st.enabled, st.token_present, st.files.length >= 5], [true, true, true], "wj-7q: status shape");
        assertTrue(gh.urls.every((u) => u.startsWith("https://api.github.com/")), "wj-7r: every job request went to api.github.com");
      }

      // ── wj-8: files-per-UTC-day cap holds across ticks. ──────────────
      {
        const f = (items: unknown[]) => ({ schema: SCHEMA, run_id: "run-cap", created_at: CREATED, items });
        const countToday = (): number =>
          (expDb.prepare(`SELECT COUNT(*) AS n FROM ${job.GARDSSALG_WEBSITE_JUDGEMENT_FILES_TABLE} WHERE substr(processed_at, 1, 10) = ?`).get(TODAY) as any).n;
        const used = countToday();
        const cap = job.GARDSSALG_WEBSITE_JUDGEMENT_MAX_FILES_PER_DAY;
        assertEq(cap, 8, "wj-8a: the daily cap is 8 files");
        assertTrue(used < cap && cap - used <= 3, `wj-8b: test precondition (used ${used} of ${cap} today)`);
        const left = cap - used;
        const capPaths: string[] = [];
        for (let i = 0; i <= left; i++) {
          seed(`cap-${i}`);
          capPaths.push(putFile(TODAY, `cap-${i}.json`, f([item(`cap-${i}`)])));
        }
        const c1 = await tick();
        assertEq(c1.processed.map((p) => p.path), capPaths.slice(0, left), "wj-8c: only the files left under today's cap are evaluated");
        assertEq([c1.daily_cap_reached, countToday()], [true, cap], "wj-8d: daily cap reached; exactly cap files recorded today");
        assertEq(hj(`cap-${left}`), null, "wj-8e: the file past the cap wrote nothing");
        const c2 = await tick();
        assertEq([c2.processed.length, c2.daily_cap_reached], [0, true], "wj-8f: a further tick the same UTC day evaluates nothing");
        const tomorrow = new Date(nowMs + 86_400_000);
        const c3 = await tick({ now: tomorrow });
        assertEq([c3.processed.map((p) => p.path), c3.daily_cap_reached], [[capPaths[left]], false], "wj-8g: the next UTC day the waiting file is evaluated");
      }

      // ── wj-9: the judge route's response is unchanged (LLM stubbed). ─
      {
        expDb.prepare("DELETE FROM gardssalg_website_review_queue").run();
        seed("j-fav", { url: "https://jfav.no/favicon.ico" });
        seed("j-ok");
        globalThis.fetch = (async (url: any) => {
          if (!isLlmUrl(url)) throw new Error(`unexpected fetch ${String(url)}`);
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nPlausibel." }] }) } as unknown as Response;
        }) as typeof fetch;
        const r = await callRoute(router, { method: "POST", url: "/admin/gardssalg-website-review-judge", headers: adminHeaders, body: { limit: 30 } });
        globalThis.fetch = throwingFetch;
        assertEq(r.status, 200, "wj-9a: judge route 200");
        assertEq(Object.keys(r.body).sort(), ["approved", "processed", "rejected", "results", "still_pending"], "wj-9b: response keys unchanged");
        assertEq([r.body.processed, r.body.approved, r.body.rejected, r.body.still_pending], [2, 1, 1, 0], "wj-9c: counts as before (an AVVIS-noted row leaves the pending set)");
        assertEq(r.body.results.map((x: any) => `${x.provider_id}:${x.verdict}`).sort(), ["j-fav:AVVIS", "j-ok:GODKJENN"], "wj-9d: results shape unchanged");
        assertTrue(r.body.results.find((x: any) => x.provider_id === "j-fav").reason.startsWith("judge backstop AVVIS"), "wj-9e: backstop reason text unchanged");
        llmCalls = 0; // the judge route is the one place an LLM call is legitimate (stubbed above)
      }

      // ── wj-10: no LLM anywhere in the job/apply/candidate paths. ─────
      assertEq([llmCalls, globalFetchCalls], [0, 0], "wj-10: ZERO api.anthropic.com requests, zero global fetch outside the stubbed judge route");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-website-judgement-job: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgWebsiteJudgementJobTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
