/**
 * experience-content-judgement-job.test.ts — tests for A2A dev-request
 * 2026-10-06-experiences-enrichment-plattformjobb-og-felles-serverjobbramme,
 * «Innsnevring 2026-10-28», skive 3k med punkt b: the server-side half of
 * the needs_review content judge.
 *
 * Covers:
 *   - GET /admin/experiences-content-judge-candidates: auth; the sweep's
 *     selection (eligible + in scope) and ordering (never-checked first,
 *     then oldest-checked); public fields only; `limit` clamp; punkt b
 *     (`batches` 1..4, continues past queue_exhausted into re-pass rows,
 *     200-row cap); remaining / never_checked_remaining / queue_exhausted;
 *     zero writes.
 *   - applyExperienceContentJudgements(): file-level vs item-level
 *     validation; re-checks (not_found, not_eligible, out_of_scope,
 *     evidence_changed, stale_verdict, content_changed); mismatch write;
 *     match stamp WITHOUT promotion when any one of the four requirements
 *     fails (each separately); promotion when all hold (both source-verified
 *     paths), audited under a batch_id the existing rollback route reverts;
 *     write-pause inside the per-row transaction.
 *   - the job tick on the shared proposal file queue: flag off / no token /
 *     paused = zero GitHub calls; 4 files per tick; once per file; run-ledger
 *     envelope claims (incl. needs_review_judge_sweep_promoted); a pause
 *     raised mid-tick writes nothing and the file is retried.
 *   - ZERO LLM: no request to api.anthropic.com, no global fetch at all, no
 *     call to judgeExperienceContentMatch / judgeExperienceEvidencePage, and
 *     every job request goes to api.github.com.
 *
 * Setup mirrors experience-description-proposals-job.test.ts: fresh
 * in-memory experiences DB, main db pinned in-memory, router.handle(),
 * GitHub as a stub fetch keyed on the contents-API path.
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
    const req: any = {
      method: opts.method, url: opts.url, originalUrl: opts.url, path,
      query, headers: opts.headers || {}, body: opts.body ?? {},
      app: { get: () => undefined },
      get() { return undefined; },
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

const SCHEMA = "experiences-content-judgements/v1";
const VERIFIED_FP = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
const VERIFIED_EV = JSON.stringify({ verified: true });

/** SQLite datetime('now') format for a JS time. */
function sqlTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function runExperienceContentJudgementJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevEnv = {
      EXPERIENCES_DB_PATH: process.env.EXPERIENCES_DB_PATH,
      ADMIN_KEY: process.env.ADMIN_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    const prevFetch = globalThis.fetch;
    const ADMIN = process.env.ADMIN_KEY || "content-judgement-job-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-must-never-be-used";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const contentJudgePath = require.resolve("./experience-content-judge");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    const jobPath = require.resolve("./experience-content-judgement-job");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath, experienceStorePath, contentJudgePath, opplevelserPath, jobPath,
    ]);
    let restoreMainDb: (() => void) | null = null;

    // ── No-LLM guards. ─────────────────────────────────────────────────
    let llmCalls = 0;
    let globalFetchCalls = 0;
    const isLlmUrl = (url: unknown) => String(url).includes("api.anthropic.com");
    globalThis.fetch = (async (url: any) => {
      globalFetchCalls++;
      if (isLlmUrl(url)) llmCalls++;
      throw new Error(`global fetch must not be called (${String(url)})`);
    }) as typeof fetch;
    // Spy the judge module BEFORE the route module binds to it.
    let judgeCalls = 0;
    {
      const real = require("./experience-content-judge");
      const spied: Record<string, unknown> = { ...real };
      for (const k of ["judgeExperienceContentMatch", "judgeExperienceEvidencePage"]) {
        const orig = real[k];
        spied[k] = (...args: unknown[]) => { judgeCalls++; return orig(...args); };
      }
      (require.cache[contentJudgePath] as NodeJS.Module).exports = spied;
    }

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
    const ROOT = "experiences-content-judgements";
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
      const job = require("./experience-content-judgement-job") as typeof import("./experience-content-judgement-job");
      const adminHeaders = { "x-admin-key": ADMIN };
      const setPause = (on: boolean) =>
        pauseSvc.setEnrichmentWritePause(
          init.getDb() as any,
          on ? { vertical: "experiences", enabled: true, reason: "cj test" } : { vertical: "experiences", enabled: false, cleared_by: "daniel" },
          "verifier",
        );

      // Real clock throughout: the job's own stamps use datetime('now').
      const NOW = new Date();
      const nowMs = NOW.getTime();
      const CREATED = new Date(nowMs - 60 * 60_000).toISOString(); // file written an hour ago
      const OLD = sqlTs(nowMs - 30 * 86_400_000);
      const TODAY = NOW.toISOString().slice(0, 10);
      const env = { EXPERIENCE_CONTENT_JUDGEMENT_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
      const tick = (over: Record<string, unknown> = {}) =>
        job.tickExperienceContentJudgements({ fetchImpl: ghFetch, now: NOW, env, expDb, mainDb: () => init.getDb(), ...over } as any);
      const apply = (items: unknown[], over: Record<string, unknown> = {}) =>
        opp.applyExperienceContentJudgements(expDb, items, { createdAt: CREATED, runId: "cj-test", now: NOW, ...over } as any);

      // ── Seed ───────────────────────────────────────────────────────
      const provOk = expStore.createProvider({ navn: "Gardsmat AS", kommune: "Voss", fylke: "Vestland", brreg_verified: 1, brreg_active: 1, verification_status: "verified" } as any);
      expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(VERIFIED_FP, provOk);
      const provNoSrc = expStore.createProvider({ navn: "Usikker AS", kommune: "Voss", fylke: "Vestland", brreg_verified: 1, brreg_active: 1, verification_status: "verified" } as any);
      const provInactive = expStore.createProvider({ navn: "Nedlagt AS", kommune: "Voss", fylke: "Vestland", brreg_verified: 1, brreg_active: 0, verification_status: "verified" } as any);
      expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(VERIFIED_FP, provInactive);

      const insertExp = expDb.prepare(
        `INSERT INTO experiences
           (id, title, slug, description, category, price_band, price_from, evidence_url, provider_id,
            verification_status, confidence, canonical_id, content_source, enrichment_state,
            admission_checked_at, updated_at, evidence_url_verification)
         VALUES
           (@id, @title, @id, @description, @category, 'standard', 400, @evidence_url, @provider_id,
            @verification_status, @confidence, @canonical_id, 'provider_site', 'enriched',
            @admission_checked_at, @updated_at, @evidence_url_verification)`,
      );
      const seed = (id: string, over: Record<string, unknown> = {}): string => {
        insertExp.run({
          id, title: `Gardsbesøk ${id}`, description: "Omvisning og smaking på gården.", category: "mat_drikke",
          evidence_url: `https://gard.example/${id}`, provider_id: provOk, verification_status: "verified",
          confidence: "high", canonical_id: null, admission_checked_at: OLD, updated_at: OLD,
          evidence_url_verification: null, ...over,
        });
        return id;
      };
      const row = (id: string): any =>
        expDb.prepare("SELECT id, verification_status, admission_verdict, admission_checked_at, admission_verdict_prev, admission_checked_at_prev, description, confidence FROM experiences WHERE id = ?").get(id);
      const auditFor = (id: string): any[] => expDb.prepare("SELECT * FROM experience_admission_promotion_audit WHERE experience_id = ?").all(id) as any[];
      const item = (id: string, over: Record<string, unknown> = {}) => ({ id, evidence_url: `https://gard.example/${id}`, verdict: "match", reasoning: "Siden beskriver gårdsbesøket.", ...over });
      const dumpAll = (): string => JSON.stringify(expDb.prepare("SELECT * FROM experiences ORDER BY id").all());

      // ── cj-1: candidate GET. ─────────────────────────────────────────
      {
        // Queue: 3 never-checked, 3 checked at distinct ages, plus
        // ineligible/out-of-scope rows that must never be served.
        seed("q-n1", { admission_checked_at: null });
        seed("q-n2", { admission_checked_at: null });
        seed("q-n3", { admission_checked_at: null });
        seed("q-c3", { admission_checked_at: sqlTs(nowMs - 3 * 86_400_000) });
        seed("q-c1", { admission_checked_at: sqlTs(nowMs - 9 * 86_400_000) });
        seed("q-c2", { admission_checked_at: sqlTs(nowMs - 6 * 86_400_000) });
        seed("q-dup", { canonical_id: "q-n1", admission_checked_at: null });
        seed("q-noev", { evidence_url: null, admission_checked_at: null });
        seed("q-scope", { category: "natur_friluft", admission_checked_at: null });

        const noKey = await callRoute(router, { method: "GET", url: "/admin/experiences-content-judge-candidates" });
        assertEq(noKey.status, 403, "cj-1a: no admin key -> 403");
        const before = dumpAll();
        const r = await callRoute(router, { method: "GET", url: "/admin/experiences-content-judge-candidates", headers: adminHeaders });
        assertEq(r.status, 200, "cj-1b: 200");
        const ids = r.body.rows.map((x: any) => x.id);
        assertEq(ids.slice(0, 3).sort(), ["q-n1", "q-n2", "q-n3"], "cj-1c: never-checked rows first");
        assertEq(ids.slice(3), ["q-c1", "q-c2", "q-c3"], "cj-1d: then oldest-checked first");
        assertTrue(!ids.includes("q-dup") && !ids.includes("q-noev") && !ids.includes("q-scope"), "cj-1e: ineligible + out-of-scope rows never served");
        assertEq(Object.keys(r.body.rows[0]).sort(), ["admission_checked_at", "category", "confidence", "description", "evidence_url", "id", "provider_id", "title", "verification_status"], "cj-1f: public catalog fields only");
        assertEq([r.body.batch_size, r.body.batches, r.body.scanned, r.body.remaining], [50, 1, 6, 0], "cj-1g: default batch 50, 1 batch, 6 rows, 0 remaining");
        assertEq([r.body.never_checked_remaining, r.body.queue_exhausted, r.body.skipped_out_of_scope], [3, false, 1], "cj-1h: never_checked_remaining / queue_exhausted / skipped_out_of_scope like the sweep");
        assertEq([r.body.judgement_schema, r.body.max_items_per_file], [SCHEMA, 50], "cj-1i: schema hint + max items per file");
        assertEq(dumpAll(), before, "cj-1j: zero writes");

        const s = (q: Record<string, string>) => opp.selectContentJudgeCandidates(expDb, q);
        assertEq(s({ limit: "2" }).rows.length, 2, "cj-1k: limit honoured");
        assertEq(s({ limit: "2" }).remaining, 4, "cj-1l: remaining = eligible - served");
        // Punkt b: batches continue past the never-checked rows into re-pass rows.
        const b3 = s({ limit: "2", batches: "3" });
        assertEq([b3.batches, b3.scanned], [3, 6], "cj-1m: limit 2 × batches 3 = 6 rows");
        assertEq(b3.rows.slice(3).map((x) => x.id), ["q-c1", "q-c2", "q-c3"], "cj-1n: batches run on into the oldest-checked re-pass rows");
        assertEq(s({ limit: "1", batches: "9" }).batches, 4, "cj-1o: batches clamped to 4");
        assertEq([s({ batches: "0" }).batches, s({ batches: "x" }).batches], [1, 1], "cj-1p: invalid batches -> 1");
        assertEq([s({ limit: "999" }).batch_size, s({ limit: "0" }).batch_size, s({ limit: "abc" }).batch_size], [50, 50, 50], "cj-1q: limit clamp/defaults like the sweep");

        // queue_exhausted, and the GET does not stop there.
        expDb.prepare("UPDATE experiences SET admission_checked_at = ? WHERE id IN ('q-n1','q-n2','q-n3')").run(sqlTs(nowMs - 1 * 86_400_000));
        const ex = s({ limit: "2", batches: "2" });
        assertEq([ex.queue_exhausted, ex.never_checked_remaining, ex.scanned], [true, 0, 4], "cj-1r: queue_exhausted=true and rows still served (punkt b)");
        assertEq(ex.rows.map((x) => x.id), ["q-c1", "q-c2", "q-c3", ex.rows[3].id], "cj-1s: re-pass order oldest-checked first");

        // 200-row cap: 4 × 50.
        const ins = expDb.transaction(() => { for (let i = 0; i < 205; i++) seed(`bulk-${String(i).padStart(3, "0")}`, { admission_checked_at: null }); });
        ins();
        const big = s({ limit: "50", batches: "4" });
        assertEq([big.scanned, big.remaining], [200, 211 - 200], "cj-1t: 4 batches -> 200 rows max, remaining reports the rest");
        expDb.prepare("DELETE FROM experiences WHERE id LIKE 'bulk-%' OR id LIKE 'q-%'").run();
      }

      // ── cj-2: file-level validation (pure + apply). ──────────────────
      {
        const v = job.validateExperienceContentJudgementFile;
        const good = { schema: SCHEMA, run_id: "r1", created_at: CREATED, items: [] };
        assertEq("error" in v(good), false, "cj-2a: valid shape");
        assertEq("error" in v([]), true, "cj-2b: not an object");
        assertEq("error" in v({ ...good, schema: "x/v1" }), true, "cj-2c: wrong schema");
        assertEq("error" in v({ ...good, run_id: "" }), true, "cj-2d: empty run_id");
        assertEq("error" in v({ ...good, created_at: "2026-11-01 10:00:00" }), true, "cj-2e: created_at without zone");
        assertEq("error" in v({ ...good, items: {} }), true, "cj-2f: items not an array");
        seed("v-1");
        const before = dumpAll();
        const cases: Array<[string, unknown[], Record<string, unknown>]> = [
          ["0 items", [], {}],
          ["51 items", Array.from({ length: 51 }, (_, i) => item(`v-x${i}`)), {}],
          ["non-object item", [item("v-1"), "x"], {}],
          ["missing id", [{ evidence_url: "https://gard.example/v-1", verdict: "match", reasoning: "r" }], {}],
          ["duplicate ids", [item("v-1"), item("v-1", { verdict: "mismatch" })], {}],
          ["future created_at", [item("v-1")], { createdAt: new Date(nowMs + 3600_000).toISOString() }],
        ];
        for (const [label, items, over] of cases) {
          const out = await apply(items, over);
          assertEq(out.ok, false, `cj-2g: ${label} -> whole file rejected`);
        }
        assertEq(dumpAll(), before, "cj-2h: file-level rejects wrote nothing");
      }

      // ── cj-3: item-level validation + re-checks. ─────────────────────
      {
        seed("i-ok");
        seed("i-verdict"); seed("i-url"); seed("i-reason-long"); seed("i-reason-empty");
        seed("i-dup", { canonical_id: "i-ok" });
        seed("i-scope", { category: "natur_friluft" });
        seed("i-evchg");
        seed("i-stale", { admission_checked_at: sqlTs(nowMs - 10 * 60_000) });
        seed("i-content", { updated_at: sqlTs(nowMs - 5 * 60_000) });
        const out: any = await apply([
          item("i-ok"),
          item("i-verdict", { verdict: "MATCH" }),
          item("i-url", { evidence_url: "" }),
          item("i-reason-long", { reasoning: "x".repeat(501) }),
          item("i-reason-empty", { reasoning: "   " }),
          item("i-missing"),
          item("i-dup"),
          item("i-scope"),
          item("i-evchg", { evidence_url: "https://gard.example/annen-side" }),
          item("i-stale"),
          item("i-content"),
        ]);
        assertEq(out.ok, true, "cj-3a: file with item-level problems still applies");
        const byId = new Map(out.results.map((r: any) => [r.id, r]));
        const reasonOf = (id: string) => (byId.get(id) as any)?.reason;
        assertEq((byId.get("i-ok") as any).result, "written", "cj-3b: the valid item is written");
        assertEq(
          ["i-verdict", "i-url", "i-reason-long", "i-reason-empty", "i-missing", "i-dup", "i-scope", "i-evchg", "i-stale", "i-content"].map(reasonOf),
          ["invalid_verdict", "invalid_evidence_url", "invalid_reasoning", "invalid_reasoning", "not_found", "not_eligible", "out_of_scope", "evidence_changed", "stale_verdict", "content_changed"],
          "cj-3c: per-item reject reasons",
        );
        for (const id of ["i-verdict", "i-url", "i-reason-long", "i-dup", "i-scope", "i-evchg"]) {
          assertEq(row(id).admission_checked_at, OLD, `cj-3d: ${id} untouched`);
        }
        assertEq(row("i-stale").admission_checked_at, sqlTs(nowMs - 10 * 60_000), "cj-3e: stale row keeps its newer stamp");
        assertEq([out.totals.written, out.totals.rejected], [1, 10], "cj-3f: totals");
        // A 500-char reasoning (after whitespace collapse) is accepted.
        seed("i-500");
        const o500: any = await apply([item("i-500", { reasoning: "y".repeat(500) })]);
        assertEq(o500.results[0].result, "written", "cj-3g: 500-char reasoning accepted");
      }

      // ── cj-4: mismatch write mirrors the sweep. ──────────────────────
      {
        seed("m-pub");
        seed("m-nr", { verification_status: "needs_review" });
        const out: any = await apply([item("m-pub", { verdict: "mismatch", reasoning: "Siden  handler\nom noe annet." }), item("m-nr", { verdict: "mismatch" })]);
        assertEq(row("m-pub").verification_status, "needs_review", "cj-4a: mismatch -> needs_review");
        assertEq(row("m-pub").admission_verdict, "mismatch: Siden handler om noe annet.", "cj-4b: stamped mismatch: <reasoning> (whitespace collapsed)");
        assertTrue(row("m-pub").admission_checked_at !== OLD, "cj-4c: admission_checked_at advanced");
        assertEq(row("m-pub").admission_checked_at_prev, OLD, "cj-4d: previous stamp shifted into _prev");
        assertEq([row("m-nr").verification_status, auditFor("m-nr").length], ["needs_review", 0], "cj-4e: mismatch on a needs_review row never promotes");
        assertEq([out.totals.mismatch, out.totals.promoted], [2, 0], "cj-4f: totals");
      }

      // ── cj-5: match without promotion (each requirement separately). ─
      {
        seed("p-pub"); // not needs_review -> not applicable
        seed("p-low", { verification_status: "needs_review", confidence: "low" });
        seed("p-null", { verification_status: "needs_review", confidence: null });
        seed("p-brreg", { verification_status: "needs_review", provider_id: provInactive });
        seed("p-src", { verification_status: "needs_review", provider_id: provNoSrc });
        const out: any = await apply(["p-pub", "p-low", "p-null", "p-brreg", "p-src"].map((id) => item(id)));
        const r = new Map(out.results.map((x: any) => [x.id, x]));
        assertEq([row("p-pub").verification_status, row("p-pub").admission_verdict.startsWith("match: "), (r.get("p-pub") as any).promotion.status], ["verified", true, "not_applicable"], "cj-5a: match on a published row: stamp only");
        assertEq([(r.get("p-low") as any).promotion.missing, row("p-low").verification_status], [["confidence"], "needs_review"], "cj-5b: low confidence -> held");
        assertEq((r.get("p-null") as any).promotion.missing, ["confidence"], "cj-5c: null confidence -> held");
        assertEq([(r.get("p-brreg") as any).promotion.missing, row("p-brreg").verification_status], [["brreg_active"], "needs_review"], "cj-5d: brreg_active 0 -> held");
        assertEq([(r.get("p-src") as any).promotion.missing, row("p-src").verification_status], [["source_verified"], "needs_review"], "cj-5e: unverified source -> held");
        for (const id of ["p-low", "p-null", "p-brreg", "p-src"]) {
          assertTrue(row(id).admission_verdict.startsWith("match: ") && auditFor(id).length === 0, `cj-5f: ${id} stamped match:, no audit row`);
        }
        assertEq(out.totals.promoted, 0, "cj-5g: zero promotions");
      }

      // ── cj-6: match WITH promotion when all four hold + rollback. ────
      let promotedBatch = "";
      {
        seed("g-hjem", { verification_status: "needs_review", confidence: "medium" });
        seed("g-ev", { verification_status: "needs_review", provider_id: provNoSrc, evidence_url_verification: VERIFIED_EV });
        const out: any = await apply([item("g-hjem"), item("g-ev")]);
        promotedBatch = out.batch_id;
        assertEq([row("g-hjem").verification_status, row("g-ev").verification_status], ["verified", "verified"], "cj-6a: both promoted (hjemmeside / evidence_url verified)");
        assertEq(row("g-hjem").admission_verdict, "promoted: Siden beskriver gårdsbesøket.", "cj-6b: promoted: stamp in place of match:");
        assertEq(row("g-hjem").confidence, "medium", "cj-6c: confidence untouched");
        const a = auditFor("g-hjem");
        assertEq([a.length, a[0]?.from_status, a[0]?.to_status, a[0]?.batch_id], [1, "needs_review", "verified", promotedBatch], "cj-6d: one audit row under the file's batch_id");
        assertTrue(promotedBatch.startsWith("content-judgement-job-"), "cj-6e: batch_id names the job");
        assertEq(out.totals.promoted, 2, "cj-6f: promoted total");
        const rb = await callRoute(router, { method: "POST", url: "/admin/experiences-admission-promotion-rollback", headers: adminHeaders, body: { batch_id: promotedBatch } });
        assertEq([rb.status, row("g-hjem").verification_status, row("g-ev").verification_status], [200, "needs_review", "needs_review"], "cj-6g: the existing rollback route reverts the job's batch");
        // Re-applying the same verdict now is stale (the row was stamped after created_at).
        const again: any = await apply([item("g-hjem")]);
        assertEq(again.results[0].reason, "stale_verdict", "cj-6h: re-apply of the same file is a stale_verdict, never a second promotion");
      }

      // ── cj-7: write-pause inside the per-row transaction. ────────────
      {
        seed("w-1", { verification_status: "needs_review" });
        setPause(true);
        let threw = false;
        try { await apply([item("w-1")]); } catch (err) { threw = pauseSvc.isEnrichmentWritePausedError(err); }
        setPause(false);
        assertTrue(threw, "cj-7a: a live pause throws EnrichmentWritePausedError from the apply step");
        assertEq([row("w-1").verification_status, row("w-1").admission_checked_at], ["needs_review", OLD], "cj-7b: nothing written under the pause");
      }

      // ── cj-8: the job tick. ──────────────────────────────────────────
      {
        gh.calls.length = 0;
        const r1 = await tick({ env: { A2A_READ_PAT: "test-pat" } });
        const r2 = await tick({ env: { EXPERIENCE_CONTENT_JUDGEMENT_JOB_ENABLED: "1", A2A_READ_PAT: "test-pat" } });
        const r3 = await tick({ env: { EXPERIENCE_CONTENT_JUDGEMENT_JOB_ENABLED: "true" } });
        setPause(true);
        const r4 = await tick();
        setPause(false);
        assertEq([r1.skipped_reason, r2.skipped_reason, r3.skipped_reason, r4.skipped_reason], ["disabled", "disabled", "no_token", "paused"], "cj-8a: flag off / not \"true\" / no token / paused");
        assertEq(gh.calls.length, 0, "cj-8b: zero GitHub requests when skipped");

        const yesterday = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
        for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) seed(id);
        seed("t-prom", { verification_status: "needs_review" });
        const f = (items: unknown[], extra: Record<string, unknown> = {}) => ({ schema: SCHEMA, run_id: "run-x", created_at: CREATED, items, ...extra });
        const pA = putFile(yesterday, "a.json", f([item("t-1"), item("t-prom")]));
        const pB = putFile(yesterday, "b.json", f([item("t-2", { verdict: "mismatch" })]));
        const pC = putFile(TODAY, "c.json", f([item("t-3")], { schema: "wrong/v1" }));
        const pD = putFile(TODAY, "d.json", f([item("t-4")]));
        const pE = putFile(TODAY, "e.json", f([item("t-5")]));
        const t1 = await tick();
        assertEq(t1.processed.map((p) => p.path), [pA, pB, pC, pD], "cj-8c: 4 files per tick, oldest dir first");
        assertEq(t1.processed.map((p) => p.status), ["applied", "applied", "error", "applied"], "cj-8d: wrong schema -> error");
        assertEq(t1.written, 4, "cj-8e: 4 rows written");
        assertEq([row("t-prom").verification_status, row("t-2").verification_status, row("t-3").admission_checked_at], ["verified", "needs_review", OLD], "cj-8f: promotion + mismatch applied; invalid file wrote nothing");
        const runs = init.getDb().prepare("SELECT * FROM runs WHERE agent = ? ORDER BY rowid").all(job.EXPERIENCE_CONTENT_JUDGEMENT_AGENT) as any[];
        assertEq(runs.length, 1, "cj-8g: one envelope");
        assertEq(JSON.parse(runs[0].claims), [
          { type: "db_state_change", value: 4, meta: { kind: "content_judgements_applied", source: "content_judgement_job" } },
          { type: "db_state_change", value: 4, meta: { kind: "content_judgements_processed" } },
          { type: "db_state_change", value: 1, meta: { kind: "needs_review_judge_sweep_promoted", source: "content_judgement_job" } },
        ], "cj-8h: envelope claims incl. needs_review_judge_sweep_promoted");
        const ev = JSON.parse(runs[0].evidence);
        assertEq(ev[2], { claim_idx: 2, ids: ["t-prom"] }, "cj-8i: promoted ids as claim-2 evidence");
        assertEq([runs[0].vertical, runs[0].status], ["experiences", "partial"], "cj-8j: partial (one file errored)");

        const t2 = await tick();
        assertEq(t2.processed.map((p) => p.path), [pE], "cj-8k: the fifth file on the next tick");
        // Once per file: a changed sha is ignored, nothing re-applied.
        putFile(yesterday, "a.json", f([item("t-1", { verdict: "mismatch" })]), "sha-changed");
        const t3 = await tick();
        assertEq([t3.processed.length, row("t-1").verification_status], [0, "verified"], "cj-8l: processed files never re-run (even with a new sha)");

        // A pause raised while a file is being applied: nothing written,
        // file not recorded, retried on a later tick.
        seed("t-6");
        const pF = putFile(TODAY, "f.json", f([item("t-6", { verdict: "mismatch" })]));
        const pausingApply = async (db: any, items: any, o: any) => { setPause(true); return opp.applyExperienceContentJudgements(db, items, o); };
        const t4 = await tick({ apply: pausingApply });
        setPause(false);
        assertEq([t4.processed.length, t4.failures.map((x) => x.path), row("t-6").verification_status], [0, [pF], "verified"], "cj-8m: pause mid-file -> per-file failure, nothing written");
        const t5 = await tick();
        assertEq([t5.processed.map((p) => p.path), row("t-6").verification_status], [[pF], "needs_review"], "cj-8n: retried and applied once the pause clears");

        // Status GET.
        const st403 = await callRoute(router, { method: "GET", url: "/admin/experiences-content-judgements-status" });
        assertEq(st403.status, 403, "cj-8o: status GET needs the admin key");
        const st = job.getExperienceContentJudgementsStatus(expDb, env, { mainDb: () => init.getDb() });
        assertEq([st.enabled, st.token_present, st.files.length >= 6], [true, true, true], "cj-8p: status shape");
        assertEq(job.getExperienceContentJudgementsStatus(expDb, {}).enabled, false, "cj-8q: flag off by default");
        assertTrue(gh.urls.every((u) => u.startsWith("https://api.github.com/")), "cj-8r: every job request went to api.github.com");
      }

      // ── cj-9: no LLM anywhere. ───────────────────────────────────────
      assertEq([llmCalls, globalFetchCalls, judgeCalls], [0, 0, 0], "cj-9: ZERO api.anthropic.com requests, zero global fetch, zero judge calls");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-content-judgement-job: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperienceContentJudgementJobTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
