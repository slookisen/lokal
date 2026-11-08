/**
 * experience-facts-proposals-job.test.ts — A2A dev-request 2026-10-16-
 * opplevagent-katalogfakta-alder-og-title-no, slice S3b: the hourly
 * catalogue facts proposals job on the shared proposal file queue.
 *
 *   A. Guards: flag off / no token / write-pause -> nothing fetched,
 *      nothing written.
 *   B. Flag on (test env only) against a fake GitHub contents API: a file is
 *      processed exactly once through the SAME applyExperienceFactsProposals
 *      as POST /admin/experience-facts-write; an out-of-scope / unpublished
 *      item is rejected and not written; a file with > 25 items and a file
 *      over 64 KB are recorded as errors; envelope claims
 *      (published_profile_fact_filled); ZERO calls to api.anthropic.com.
 *   C. GET /admin/experience-facts-proposals-status -> 200.
 *
 * Conventions as in gardssalg-visit-proposals-job.test.ts (in-memory DBs,
 * router.handle(), globalThis.fetch stubbed for the source fetch, GitHub via
 * the fetchImpl seam, apply bound to this test's route-module instance).
 */
export interface TestSummary { passed: number; failed: number; failures: string[]; }

export function runExperienceFactsProposalsJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0; let failed = 0; const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(msg); if (log) console.log("  " + msg); }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "experience-facts-proposals-job-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-facts-proposals-job";
    const testKey = process.env.ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../routes/opplevelser"),
      require.resolve("./proposal-file-queue"),
      require.resolve("./experience-facts-proposals-job"),
    ];
    for (const p of cachePaths) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences") as any;
      require("../services/experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const pauseSvc = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
      const route = require("../routes/opplevelser") as typeof import("../routes/opplevelser");
      const router = route.default as any;
      const job = require("./experience-facts-proposals-job") as typeof import("./experience-facts-proposals-job");

      const call = (method: "GET" | "POST", url: string, body?: any): Promise<{ status: number; body: any }> =>
        new Promise((resolve) => {
          const q: Record<string, string> = {};
          const qi = url.indexOf("?");
          if (qi >= 0) for (const [k, v] of new URLSearchParams(url.slice(qi + 1))) q[k] = v;
          const req: any = { method, url, originalUrl: url, path: url.split("?")[0], query: q, headers: { "x-admin-key": testKey }, body: body ?? {}, get() { return undefined; } };
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, body: p }); return this; } };
          router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
        });

      // ── Seed (same fixtures as routes/experience-facts-proposals.test.ts) ──
      const fp = (verified: boolean) => JSON.stringify({
        hjemmeside_verification: { verified, classification: verified ? "verified" : "unverified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, field_provenance, producer_type, brreg_active,
            created_at, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @hjemmeside, @content_source, @fp, @producer_type, 1,
            '2026-01-01 00:00:00', 'raw', 'verified', 'test-fixture', 'high')`,
      );
      const provider = (id: string, over: Record<string, unknown> = {}) => insertProvider.run({
        id, navn: `Navn ${id}`, hjemmeside: `https://${id}.example.no`, content_source: null, fp: fp(true), producer_type: "bryggeri", ...over,
      });
      provider("fa");                          // gårdssalg cohort, verified site
      provider("fb", { producer_type: null }); // NOT in the cohort

      const insertExp = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, category, title_no, min_age, group_min, group_max, age_suitability, languages,
            content_source, content_field_evidence, source_page_url, verification_status, confidence, canonical_id, created_at, updated_at)
         VALUES (@id, @provider_id, @title, @id, @category, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, @cfe, NULL, @verification_status, 'high', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
      );
      const exp = (id: string, over: Record<string, unknown> = {}) => insertExp.run({
        id, provider_id: "fa", title: "Ølsmaking på garden", category: "natur_friluft",
        cfe: JSON.stringify({ description: "https://fa.example.no/" }), verification_status: "verified", ...over,
      });
      exp("j-ok");
      exp("j-out", { provider_id: "fb", category: "kultur_historie" }); // out of scope
      exp("j-unpub", { verification_status: "needs_review" });          // not published

      const PAGE = `<html><head><title>Smaking</title></head><body><h1>Ølsmaking på gården</h1>
        <p>Passer for voksne fra 18 år.</p><p>Grupper fra 4 til 20 personer.</p></body></html>`;
      let anthropicCalls = 0;
      const sourceFetches: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("api.anthropic.com")) { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "x" }] }) } as unknown as Response; }
        sourceFetches.push(u);
        const host = new URL(u).hostname;
        if (host.endsWith(".example.no")) {
          return { ok: true, status: 200, text: async () => PAGE, arrayBuffer: async () => new TextEncoder().encode(PAGE).buffer, headers: { get: () => null } } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "", headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch;

      const row = (id: string): any => expDb.prepare("SELECT min_age, group_min, content_field_evidence FROM experiences WHERE id = ?").get(id);

      // ── Fake GitHub contents API ─────────────────────────────────────
      const gh = { dirs: new Map<string, any[]>(), files: new Map<string, { sha: string; text: string }>(), calls: [] as string[] };
      const ghFetch = (async (url: any) => {
        const u = new URL(String(url));
        const prefix = "/repos/slookisen/A2A/contents/";
        const path = decodeURIComponent(u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname);
        gh.calls.push(path);
        const dir = gh.dirs.get(path);
        if (dir) return { ok: true, status: 200, json: async () => dir } as unknown as Response;
        const f = gh.files.get(path);
        if (f) return { ok: true, status: 200, json: async () => ({ encoding: "base64", content: Buffer.from(f.text, "utf8").toString("base64"), sha: f.sha }) } as unknown as Response;
        return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
      }) as unknown as typeof fetch;
      const ROOT = job.EXPERIENCE_FACTS_PROPOSALS_DIR;
      const putFile = (date: string, name: string, content: unknown, sizeOverride?: number): string => {
        const path = `${ROOT}/${date}/${name}`;
        const text = JSON.stringify(content);
        gh.files.set(path, { sha: `sha-${name}`, text });
        const list = gh.dirs.get(`${ROOT}/${date}`) ?? [];
        gh.dirs.set(`${ROOT}/${date}`, [...list.filter((e) => e.path !== path), { name, path, type: "file", sha: `sha-${name}`, size: sizeOverride ?? Buffer.byteLength(text) }]);
        if (!gh.dirs.get(ROOT)) gh.dirs.set(ROOT, []);
        if (!gh.dirs.get(ROOT)!.some((e) => e.name === date)) gh.dirs.get(ROOT)!.push({ name: date, path: `${ROOT}/${date}`, type: "dir", sha: `sha-${date}` });
        return path;
      };
      const NOW = new Date("2026-11-08T12:00:00Z");
      const DATE = "2026-11-08";
      const env = { EXPERIENCE_FACTS_PROPOSALS_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
      // Bound to THIS test's route-module instance (see the gardssalg visit
      // job test and tests/test.ts "SHARED GLOBAL STATE"); it maps the
      // queue's opts exactly as the job's own defaultApply does.
      const applyViaRoute = (_db: any, items: unknown[], o: any) =>
        route.applyExperienceFactsProposals(items, { dryRun: false, fetchImpl: o.homepageFetchImpl, logTag: o.logTag });
      const tick = (over: Record<string, unknown> = {}) =>
        job.tickExperienceFactsProposals({ fetchImpl: ghFetch, now: NOW, env, expDb, mainDb: () => init.getDb() as any, apply: applyViaRoute, ...over } as any);
      const runsFor = () => (init.getDb() as any).prepare("SELECT * FROM runs WHERE agent = ? ORDER BY rowid").all(job.EXPERIENCE_FACTS_PROPOSALS_AGENT) as any[];
      const fileRow = (path: string): any => expDb.prepare(`SELECT * FROM ${job.EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE} WHERE path = ?`).get(path);
      const fileRowCount = (path: string): number =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM ${job.EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE} WHERE path = ?`).get(path) as any).n;

      const item = (id: string, field: string, value: unknown, excerpt: string, source_url = "https://fa.example.no/") =>
        ({ id, field, value, excerpt, source_url });

      // s0: wiring — the job's own apply is S3a's applyExperienceFactsProposals,
      // flag OFF by default, the S3a 25-item cap and the queue's 64 KB cap.
      {
        const fs = require("fs") as typeof import("fs");
        const pathMod = require("path") as typeof import("path");
        const src = fs.readFileSync(pathMod.join(__dirname, "experience-facts-proposals-job.ts"), "utf8");
        assertTrue(src.includes("mod.applyExperienceFactsProposals(items,") && src.includes("runProposalFileQueueTick"), "s0-1: default apply is applyExperienceFactsProposals on the shared queue");
        assertTrue(!src.includes("maxFilesPerDay") && !/anthropic/i.test(src.replace(/\/\/.*$/gm, "")), "s0-2: no daily-cap override, no model seam");
        assertEq(job.experienceFactsProposalsJobEnabled({}), false, "s0-3: flag unset -> disabled");
        assertEq(job.experienceFactsProposalsJobEnabled({ EXPERIENCE_FACTS_PROPOSALS_JOB_ENABLED: "1" }), false, "s0-4: only the string \"true\" enables");
        assertEq(route.EXPERIENCE_FACTS_WRITE_MAX_ITEMS, 25, "s0-5: S3a item cap is 25");
        const q = require("./proposal-file-queue") as typeof import("./proposal-file-queue");
        assertEq(q.PROPOSAL_QUEUE_MAX_FILE_BYTES, 64 * 1024, "s0-6: queue file cap is 64 KB");
      }

      // ── A. guards ───────────────────────────────────────────────────
      const pMain = putFile(DATE, "a-main.json", {
        schema: job.EXPERIENCE_FACTS_PROPOSALS_SCHEMA, run_id: "facts-20261108T020000Z", created_at: "2026-11-08T02:05:00Z",
        items: [
          item("j-ok", "min_age", 18, "voksne fra 18 år"),
          item("j-out", "min_age", 18, "voksne fra 18 år", "https://fb.example.no/"),
          item("j-unpub", "min_age", 18, "voksne fra 18 år"),
        ],
      });
      gh.calls.length = 0;
      const d1 = await tick({ env: { A2A_READ_PAT: "test-pat" } });
      assertEq(d1.skipped_reason, "disabled", "a1-1: flag off -> disabled");
      const d1b = await job.tickExperienceFactsProposals({ fetchImpl: ghFetch, now: NOW, env: { A2A_READ_PAT: "test-pat" }, expDb, mainDb: () => init.getDb() as any });
      assertEq(d1b.skipped_reason, "disabled", "a1-2: flag off without an injected apply -> disabled (no route import needed)");
      const d2 = await tick({ env: { EXPERIENCE_FACTS_PROPOSALS_JOB_ENABLED: "true" } });
      assertEq(d2.skipped_reason, "no_token", "a1-3: no A2A_READ_PAT -> no_token");
      pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "facts job test" }, "verifier");
      const d3 = await tick();
      assertEq(d3.skipped_reason, "paused", "a1-4: write-pause -> paused");
      pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
      assertEq(gh.calls.length, 0, "a1-5: zero GitHub calls across guard skips");
      assertEq([row("j-ok").min_age, fileRow(pMain), runsFor().length], [null, undefined, 0], "a1-6: nothing written, recorded or enveloped while guarded");

      // ── B. flag on: processed once, gates unchanged, caps ──────────────
      const tooMany = Array.from({ length: 26 }, (_, i) => item("j-ok", `f${i}`, 1, "voksne fra 18 år"));
      const pMany = putFile(DATE, "b-too-many.json", { schema: job.EXPERIENCE_FACTS_PROPOSALS_SCHEMA, items: tooMany });
      const pBig = putFile(DATE, "c-too-big.json", { schema: job.EXPERIENCE_FACTS_PROPOSALS_SCHEMA, items: [item("j-ok", "group_min", 4, "Grupper fra 4 til 20 personer")] }, 64 * 1024 + 1);
      anthropicCalls = 0;
      gh.calls.length = 0;
      const t1 = await tick();
      assertEq(t1.skipped_reason, null, "b1-1: tick ran");
      assertEq(t1.processed.map((p) => [p.path.split("/").pop(), p.status]), [["a-main.json", "applied"], ["b-too-many.json", "error"]], "b1-2: two files per tick, names ascending");
      assertEq(t1.written, 1, "b1-3: one fact written");
      assertEq(row("j-ok").min_age, 18, "b1-4: j-ok.min_age written through applyExperienceFactsProposals");
      assertEq(JSON.parse(row("j-ok").content_field_evidence).min_age, "https://fa.example.no/", "b1-5: provenance stamped by the S3a write path");
      assertEq([row("j-out").min_age, row("j-unpub").min_age], [null, null], "b1-6: out-of-scope and unpublished rows NOT written");
      const mainJson = JSON.parse(fileRow(pMain).result_json);
      const reasonOf = (id: string) => mainJson.results.find((r: any) => r.id === id)?.reason;
      assertEq([reasonOf("j-out"), reasonOf("j-unpub")], ["out_of_scope", "not_published"], "b1-7: per-item rejections recorded in the file ledger");
      assertEq(mainJson.totals, { written: 1, would_write: 0, rejected: 2 }, "b1-8: ledger row records the file's totals");
      const manyRow = JSON.parse(fileRow(pMany).result_json);
      assertEq([manyRow.status, manyRow.error], ["error", "items must be an array of 1..25 items"], "b1-9: a file with 26 items is rejected whole (S3a cap)");
      assertEq(row("j-ok").group_min, null, "b1-10: nothing from the too-many file written");
      const runs = runsFor();
      assertEq(runs.length, 1, "b1-11: one envelope");
      const claims = JSON.parse(runs[0].claims);
      assertEq([claims[0].meta.kind, claims[0].meta.source, claims[0].meta.llm, claims[0].value], ["published_profile_fact_filled", "facts_proposals_job", false, 1], "b1-12: claim kind published_profile_fact_filled, value = written");
      assertEq(claims[1].meta.kind, "facts_proposals_processed", "b1-13: second claim facts_proposals_processed");
      assertEq(runs[0].status, "partial", "b1-14: status partial (one file errored)");
      assertEq(JSON.parse(runs[0].evidence)[0]?.ids, ["j-ok"], "b1-15: written ids as evidence");

      const t2 = await tick();
      assertEq(t2.processed.map((p) => [p.path.split("/").pop(), p.status, p.error]), [["c-too-big.json", "error", "file too large"]], "b2-1: a file over 64 KB is a permanent error");
      assertTrue(!gh.calls.includes(pBig), "b2-2: the oversized file was never fetched");
      assertEq(row("j-ok").group_min, null, "b2-3: nothing from the oversized file written");

      const t3 = await tick();
      assertEq(t3.processed.length, 0, "b3-1: third tick processes nothing (each file once)");
      assertEq([fileRowCount(pMain), fileRowCount(pMany), fileRowCount(pBig)], [1, 1, 1], "b3-2: exactly one ledger row per file");
      // A changed sha after processing is ignored, never re-applied.
      expDb.prepare("UPDATE experiences SET min_age = NULL WHERE id = 'j-ok'").run();
      gh.files.set(pMain, { sha: "sha-changed", text: gh.files.get(pMain)!.text });
      gh.dirs.set(`${ROOT}/${DATE}`, gh.dirs.get(`${ROOT}/${DATE}`)!.map((e) => (e.path === pMain ? { ...e, sha: "sha-changed" } : e)));
      const t4 = await tick();
      assertEq([t4.processed.length, row("j-ok").min_age], [0, null], "b3-3: a changed file is not processed again");
      assertEq(anthropicCalls, 0, "b3-4: the job made ZERO model calls");
      assertTrue(sourceFetches.every((u) => new URL(u).hostname.endsWith(".example.no")), "b3-5: the only non-GitHub fetches are the provider source pages");

      // ── C. status route ───────────────────────────────────────────────
      const st = await call("GET", "/admin/experience-facts-proposals-status");
      assertEq(st.status, 200, "c1-1: status route -> 200");
      assertEq([st.body.success, st.body.schema, st.body.dir], [true, job.EXPERIENCE_FACTS_PROPOSALS_SCHEMA, job.EXPERIENCE_FACTS_PROPOSALS_DIR], "c1-2: status carries schema + dir");
      assertEq(st.body.files.length, 3, "c1-3: status lists the three processed files");
      for (const k of ["enabled", "token_present", "health", "last_tick", "failures"]) assertTrue(k in st.body, `c1-4: status has ${k}`);
      const viaFn = job.getExperienceFactsProposalsStatus(expDb, { A2A_READ_PAT: "github_pat_SECRETSECRET" }, { mainDb: () => init.getDb() as any });
      assertEq([viaFn.enabled, viaFn.token_present, viaFn.health], [false, true, "disabled"], "c1-5: flag off -> disabled in status");
      assertTrue(!JSON.stringify(viaFn).includes("github_pat_"), "c1-6: no token value in the status JSON");
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}
