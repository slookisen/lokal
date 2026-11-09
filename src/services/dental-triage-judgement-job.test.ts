/**
 * dental-triage-judgement-job.test.ts — dev-request 2026-09-02-dental-
 * permanent-triage-needs-review-drain, slice 3c-2: the server-side half of
 * the dental-triage judgement lane (file queue, no LLM on the server).
 *
 * Setup mirrors dental-triage.test.ts (in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + __resetDbFactoryForTesting(), main DB pinned in
 * memory for the write-pause row and the run ledger) and the GitHub stub of
 * gardssalg-website-judgement-job.test.ts.
 *
 * Covers: file validation (schema, run_id, created_at, items count, duplicate
 * agent_id); each item outcome (AVVIS -> rejected + dental_exclusions row +
 * audit; KATALOGKLASSE -> catalog_class/source/at + audit, review state
 * unchanged; not_found; not_eligible; invalid_catalog_class; unchanged);
 * write-pause (apply throws, tick no-op, mid-file retry); flag off / no PAT =
 * no-op with zero GitHub calls; idempotency (same file never applied twice);
 * routes (403 without key, judge-candidates shape + limit clamp, status);
 * ZERO global fetch / LLM.
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

const SCHEMA = "dental-triage-judgements/v1";
const ROOT = "dental-triage-judgements";

export function runDentalTriageJudgementJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      DENTAL_DB_PATH: process.env.DENTAL_DB_PATH,
      ADMIN_KEY: process.env.ADMIN_KEY,
      ANALYTICS_ADMIN_KEY: process.env.ANALYTICS_ADMIN_KEY,
      DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED: process.env.DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED,
    };
    const prevFetch = globalThis.fetch;
    const ADMIN = process.env.ADMIN_KEY || "dental-triage-judgement-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./dental-store"),
      require.resolve("./dental-verifier"),
      require.resolve("./dental-enrichment-write-pause"),
      require.resolve("./dental-triage"),
      require.resolve("./dental-triage-judgement-job"),
      require.resolve("../routes/admin-dental-mark-inactive"),
      require.resolve("../routes/admin-dental-hjemmeside-cleanup"),
      require.resolve("../routes/admin-dental-triage"),
    ]);
    const init = require("../database/init") as typeof import("../database/init");
    const restoreMainDb = init.__pinInMemoryDbForTesting();

    // ── No-LLM / no-network guard. ─────────────────────────────────────
    let globalFetchCalls = 0;
    const throwingFetch = (async (url: any) => {
      globalFetchCalls++;
      throw new Error(`global fetch must not be called (${String(url)})`);
    }) as typeof fetch;
    globalThis.fetch = throwingFetch;

    // ── GitHub contents-API stub. ──────────────────────────────────────
    type Entry = { name: string; path: string; type: "dir" | "file"; sha: string; size?: number };
    const gh = { dirs: new Map<string, Entry[]>(), files: new Map<string, { sha: string; text: string }>(), calls: [] as string[], urls: [] as string[] };
    const ghFetch = (async (url: any) => {
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
      const db = dbFactory.getDb("dental") as any;
      const mainDb = () => init.getDb();
      const pauseSvc = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
      const job = require("./dental-triage-judgement-job") as typeof import("./dental-triage-judgement-job");
      const router = (require("../routes/admin-dental-triage") as typeof import("../routes/admin-dental-triage")).default as any;
      const adminHeaders = { "x-admin-key": ADMIN };
      const setPause = (on: boolean) =>
        pauseSvc.setEnrichmentWritePause(
          init.getDb() as any,
          on ? { vertical: "dental", enabled: true, reason: "dtj test" } : { vertical: "dental", enabled: false, cleared_by: "daniel" },
          "verifier",
        );

      const NOW = new Date();
      const nowMs = NOW.getTime();
      const CREATED = new Date(nowMs - 60 * 60_000).toISOString();
      const TODAY = NOW.toISOString().slice(0, 10);
      const env = { DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
      const tick = (over: Record<string, unknown> = {}) =>
        job.tickDentalTriageJudgements({ fetchImpl: ghFetch, now: NOW, env, db, mainDb, ...over } as any);
      const apply = (items: unknown, over: Record<string, unknown> = {}) =>
        job.applyDentalTriageJudgements(db, items, { runId: "dtj-test", createdAt: CREATED, now: NOW, pauseBlock: () => null, ...over } as any);

      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, org_nr, hjemmeside, poststed, postnummer, catalog_class,
            enrichment_state, verification_status, review_reason, review_since, created_at)
         VALUES (@id, @navn, @org_nr, @hjemmeside, @poststed, @postnummer, @catalog_class,
            @enrichment_state, @verification_status, @review_reason, @review_since, @created_at)`,
      );
      let orgSeq = 910000000;
      const seed = (r: Record<string, unknown>): string => {
        const row = {
          navn: `Klinikk ${r.id}`, org_nr: String(++orgSeq), hjemmeside: `https://${String(r.id).replace(/[^a-z0-9]/g, "")}.example.no`,
          poststed: "BERGEN", postnummer: "5003", catalog_class: "klinikk", enrichment_state: "enriched",
          verification_status: "needs_review", review_reason: "wrong_entity_repeat",
          review_since: "2026-09-10T00:00:00.000Z", created_at: "2026-01-01T00:00:00Z", ...r,
        };
        ins.run(row);
        return row.id as string;
      };
      const rowOf = (id: string) => db.prepare("SELECT * FROM dental_agents WHERE id = ?").get(id) as any;
      const findingsOf = (id: string) =>
        db.prepare("SELECT * FROM dental_verifier_findings WHERE agent_id = ? AND check_type = 'dental_triage_judgement' ORDER BY rowid").all(id) as any[];
      const exclusionsBy = (runId: string) =>
        db.prepare("SELECT * FROM dental_exclusions WHERE excluded_by = ? ORDER BY rowid").all(`dental-triage-judgement:${runId}`) as any[];
      const snapshot = () =>
        JSON.stringify([
          db.prepare("SELECT * FROM dental_agents ORDER BY id").all(),
          db.prepare("SELECT * FROM dental_verifier_findings ORDER BY id").all(),
          db.prepare("SELECT * FROM dental_exclusions ORDER BY id").all(),
        ]);
      const file = (items: unknown[], over: Record<string, unknown> = {}) => ({ schema: SCHEMA, run_id: "run-a", created_at: CREATED, items, ...over });
      const avvis = (id: string, over: Record<string, unknown> = {}) => ({ agent_id: id, decision: "AVVIS", reason: "Ikke en tannklinikk; nedlagt virksomhet.", ...over });
      const klasse = (id: string, cls: unknown, over: Record<string, unknown> = {}) => ({ agent_id: id, decision: "KATALOGKLASSE", catalog_class: cls, reason: "Tannteknisk laboratorium.", ...over });

      // ── dtj-1: flag parsing + file validation. ───────────────────────
      assertEq(job.dentalTriageJudgementJobEnabled({}), false, "dtj-1a: flag unset -> off");
      assertEq(job.dentalTriageJudgementJobEnabled({ DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED: "1" }), false, "dtj-1b: flag '1' -> off");
      assertEq(job.dentalTriageJudgementJobEnabled({ DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED: "true" }), true, "dtj-1c: flag 'true' -> on");
      const v = (p: unknown) => {
        const r = job.validateDentalTriageJudgementFile(p, NOW);
        return "error" in r ? r.error : "ok";
      };
      assertEq(v(file([avvis("a")])), "ok", "dtj-1d: valid file");
      assertTrue(v([1]).includes("not a JSON object"), "dtj-1e: array -> error");
      assertTrue(v(file([avvis("a")], { schema: "dental-triage-judgements/v2" })).includes("schema"), "dtj-1f: wrong schema");
      assertTrue(v(file([avvis("a")], { run_id: "" })).includes("run_id"), "dtj-1g: empty run_id");
      assertTrue(v(file([avvis("a")], { run_id: "bad id/../x" })).includes("run_id"), "dtj-1h: run_id with unsafe chars");
      assertTrue(v(file([avvis("a")], { created_at: "2026-11-01 10:00" })).includes("created_at"), "dtj-1i: created_at without zone");
      assertTrue(v(file([avvis("a")], { created_at: new Date(nowMs + 3600_000).toISOString() })).includes("future"), "dtj-1j: created_at in the future");
      assertTrue(v(file([])).includes("1..50"), "dtj-1k: zero items");
      assertTrue(v(file(Array.from({ length: 51 }, (_, i) => avvis(`a${i}`)))).includes("1..50"), "dtj-1l: 51 items");
      assertTrue(v(file([avvis("a"), avvis("a")])).includes("duplicate agent_id"), "dtj-1m: duplicate agent_id");
      assertTrue(v(file([{ decision: "AVVIS", reason: "x" }])).includes("agent_id"), "dtj-1n: missing agent_id");
      assertTrue(v(file(["x"])).includes("must be an object"), "dtj-1o: non-object item");

      // ── dtj-2: apply — each item outcome. ────────────────────────────
      {
        seed({ id: "d-avvis", hjemmeside: "https://avvis.example.no" });
        seed({ id: "d-avvis-dir", hjemmeside: "https://legelisten.no/tannlege/x", review_reason: "dead_homepage_repeat" });
        seed({ id: "d-klasse", catalog_class: "klinikk" });
        seed({ id: "d-same", catalog_class: "holding" });
        seed({ id: "d-pending", verification_status: "pending_verify", review_reason: null, review_since: null });
        seed({ id: "d-other", review_reason: "brreg_nace_mismatch" });
        seed({ id: "d-inactive" });
        db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE id = 'd-inactive'").run();
        seed({ id: "d-badclass" });
        const before = rowOf("d-klasse");

        const r = apply([
          avvis("d-avvis"),
          avvis("d-avvis-dir"),
          klasse("d-klasse", "lab_leverandor"),
          klasse("d-same", "holding"),
          avvis("d-missing"),
          avvis("d-pending"),
          avvis("d-other"),
          avvis("d-inactive"),
          klasse("d-badclass", "tannlege_kjede"),
          klasse("d-badclass2", undefined),
          { agent_id: "d-x1", decision: "SLETT", reason: "x" },
          avvis("d-x2", { reason: "   " }),
          avvis("x".repeat(65)),
        ]);
        assertTrue(r.ok, "dtj-2a: apply ok");
        if (r.ok) {
          const byId = Object.fromEntries(r.results.map((x) => [x.agent_id, `${x.result}:${x.reason ?? x.decision}`]));
          assertEq(byId, {
            "d-avvis": "written:AVVIS",
            "d-avvis-dir": "written:AVVIS",
            "d-klasse": "written:KATALOGKLASSE",
            "d-same": "rejected:unchanged",
            "d-missing": "rejected:not_found",
            "d-pending": "rejected:not_eligible",
            "d-other": "rejected:not_eligible",
            "d-inactive": "rejected:not_eligible",
            "d-badclass": "rejected:invalid_catalog_class",
            "d-badclass2": "rejected:invalid_catalog_class",
            "d-x1": "rejected:invalid_decision",
            "d-x2": "rejected:invalid_reason",
            ["x".repeat(64)]: "rejected:invalid_agent_id",
          }, "dtj-2b: per-item outcomes");
          assertEq(r.totals, { written: 3, rejected: 10, avvis: 2, katalogklasse: 1 }, "dtj-2c: totals");
        }

        const a = rowOf("d-avvis");
        assertEq([a.verification_status, a.review_reason, a.review_since], ["rejected", null, null], "dtj-2d: AVVIS -> rejected, review state cleared");
        const ex = exclusionsBy("dtj-test");
        assertEq(ex.length, 2, "dtj-2e: one exclusion row per AVVIS");
        const exA = ex.find((e) => e.org_nr === a.org_nr);
        assertEq(
          [exA?.reason, exA?.hjemmeside_url, exA?.evidence, exA?.notes, exA?.is_permanent],
          ["manual_review", "https://avvis.example.no", "Ikke en tannklinikk; nedlagt virksomhet.", "dental-triage-judgement:dtj-test", 0],
          "dtj-2f: exclusion row columns",
        );
        const exDir = ex.find((e) => e.org_nr === rowOf("d-avvis-dir").org_nr);
        assertEq(exDir?.hjemmeside_url, null, "dtj-2g: a directory/catalog hjemmeside is never excluded (shared URL)");
        const fa = findingsOf("d-avvis");
        assertEq([fa.length, fa[0]?.status, fa[0]?.notes], [1, "avvis", "Ikke en tannklinikk; nedlagt virksomhet."], "dtj-2h: AVVIS audit row");
        const ev = JSON.parse(fa[0].evidence);
        assertEq([ev.run_id, ev.prior.verification_status, ev.prior.review_reason, typeof ev.exclusion_id], ["dtj-test", "needs_review", "wrong_entity_repeat", "string"], "dtj-2i: AVVIS audit evidence");

        const k = rowOf("d-klasse");
        assertEq(
          [k.catalog_class, k.catalog_class_source, k.catalog_class_at, k.verification_status, k.review_reason, k.review_since],
          ["lab_leverandor", "dental_triage_judgement:dtj-test", NOW.toISOString(), "needs_review", before.review_reason, before.review_since],
          "dtj-2j: KATALOGKLASSE -> class/source/at set, review state unchanged",
        );
        assertEq(findingsOf("d-klasse").map((f) => f.status), ["katalogklasse"], "dtj-2k: KATALOGKLASSE audit row");
        assertEq(JSON.parse(findingsOf("d-klasse")[0].evidence).prior.catalog_class, "klinikk", "dtj-2l: audit keeps the prior class");

        assertEq(rowOf("d-same").catalog_class_source, null, "dtj-2m: unchanged class -> nothing written");
        assertEq(findingsOf("d-same").map((f) => f.status), ["unchanged"], "dtj-2n: unchanged audit row");
        assertEq([rowOf("d-pending").verification_status, findingsOf("d-pending").map((f) => f.status)], ["pending_verify", ["not_eligible"]], "dtj-2o: not_eligible row untouched, audited");
        assertEq(rowOf("d-other").verification_status, "needs_review", "dtj-2p: other review_reason untouched");
        assertEq([rowOf("d-badclass").catalog_class, findingsOf("d-badclass").map((f) => f.status)], ["klinikk", ["invalid_catalog_class"]], "dtj-2q: invalid catalog_class -> nothing written, audited");
        assertEq((db.prepare("SELECT COUNT(*) AS n FROM dental_verifier_findings WHERE agent_id IN ('d-missing','d-x1','d-x2')").get() as any).n, 0, "dtj-2r: no audit row for a missing agent (FK)");
        assertEq(db.prepare("SELECT COUNT(*) AS n FROM dental_exclusions").get().n, 2, "dtj-2s: no other exclusion rows");

        // Re-applying: AVVIS rows are no longer eligible (idempotent).
        const again = apply([avvis("d-avvis")]);
        assertEq(again.ok && again.results[0].reason, "not_eligible", "dtj-2t: an applied AVVIS row is not_eligible the second time");
        assertEq(exclusionsBy("dtj-test").length, 2, "dtj-2u: no duplicate exclusion row");

        // apply's own file-level guard.
        const bad = apply([avvis("d-a1"), avvis("d-a1")]);
        assertEq(bad.ok, false, "dtj-2v: apply rejects duplicate agent_id");
        const badRun = apply([avvis("d-a1")], { runId: "x y" });
        assertEq(badRun.ok, false, "dtj-2w: apply rejects an invalid run_id");
      }

      // ── dtj-3: write-pause in apply. ─────────────────────────────────
      {
        seed({ id: "p-1" });
        const before = snapshot();
        let threw = "";
        try {
          job.applyDentalTriageJudgements(db, [avvis("p-1")], { runId: "p", now: NOW, pauseBlock: () => ({ error: "x", paused: true, vertical: "dental", reason: "t", triggered_at: null, fail_closed: false } as any) });
        } catch (err: any) { threw = err?.name ?? String(err); }
        assertEq(threw, "EnrichmentWritePausedError", "dtj-3a: apply throws under the pause");
        assertEq(snapshot(), before, "dtj-3b: nothing written under the pause");
        // Default pause check reads the real (pinned main DB) dental pause.
        setPause(true);
        threw = "";
        try { job.applyDentalTriageJudgements(db, [avvis("p-1")], { runId: "p", now: NOW }); } catch (err: any) { threw = err?.name ?? String(err); }
        setPause(false);
        assertEq([threw, snapshot() === before], ["EnrichmentWritePausedError", true], "dtj-3c: default pause check = dental write-pause");
      }

      // ── dtj-4: tick guards (no-ops, zero GitHub calls). ──────────────
      {
        seed({ id: "g-1" });
        putFile(TODAY, "g.json", file([avvis("g-1")], { run_id: "run-g" }));
        const before = snapshot();
        gh.calls.length = 0;
        const off = await tick({ env: { A2A_READ_PAT: "test-pat" } });
        assertEq([off.skipped_reason, gh.calls.length], ["disabled", 0], "dtj-4a: flag off -> disabled, zero GitHub calls");
        const noTok = await tick({ env: { DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED: "true" } });
        assertEq([noTok.skipped_reason, gh.calls.length], ["no_token", 0], "dtj-4b: no A2A_READ_PAT -> no_token, zero GitHub calls");
        setPause(true);
        const paused = await tick();
        setPause(false);
        assertEq([paused.skipped_reason, gh.calls.length], ["paused", 0], "dtj-4c: dental write-pause -> paused, zero GitHub calls");
        // An experiences pause does NOT gate the dental lane.
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "other" }, "verifier");
        assertEq(snapshot(), before, "dtj-4d: no-op ticks wrote nothing");
        const t = await tick();
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        assertEq([t.skipped_reason, t.processed.map((p) => p.status), t.written], [null, ["applied"], 1], "dtj-4e: enabled tick applies the file (experiences pause irrelevant)");
        assertEq(rowOf("g-1").verification_status, "rejected", "dtj-4f: file's AVVIS stored");
        assertEq(exclusionsBy("run-g").length, 1, "dtj-4g: exclusion row with the file's run_id");
        assertTrue(t.envelope_recorded, "dtj-4h: run-ledger envelope recorded");
        const env1 = (init.getDb().prepare("SELECT vertical, agent, status FROM runs WHERE run_id = ?").get(t.run_id) as any);
        assertEq([env1?.vertical, env1?.agent, env1?.status], ["dental", "dental-triage-judgement-job", "completed"], "dtj-4i: envelope on the dental vertical");
      }

      // ── dtj-5: idempotency + file-level error + mid-file pause retry. ─
      {
        const again = await tick();
        assertEq(again.processed.length, 0, "dtj-5a: the same file is never applied twice");
        putFile(TODAY, "g.json", file([avvis("g-1")], { run_id: "run-g" }), "sha-changed");
        const changed = await tick();
        assertEq([changed.processed.length, exclusionsBy("run-g").length], [0, 1], "dtj-5b: a changed sha on a processed path is ignored");

        const badPath = putFile(TODAY, "h-bad.json", file([avvis("h-1"), avvis("h-1")], { run_id: "run-h" }));
        const bad = await tick();
        assertEq(bad.processed.map((p) => [p.path, p.status]), [[badPath, "error"]], "dtj-5c: file-level error recorded");
        assertTrue((bad.processed[0].error ?? "").includes("duplicate agent_id"), "dtj-5d: error names the problem");
        const notJson = putFile(TODAY, "i-notjson.json", "{not json");
        const nj = await tick();
        assertEq(nj.processed.map((p) => [p.path, p.status, p.error]), [[notJson, "error", "file is not valid JSON"]], "dtj-5e: invalid JSON recorded as error");

        seed({ id: "m-1" });
        const mPath = putFile(TODAY, "j-mid.json", file([klasse("m-1", "person_enk")], { run_id: "run-m" }));
        let pauseOn = false;
        const midPause = () => (pauseOn ? ({ error: "x", paused: true, vertical: "dental", reason: "mid", triggered_at: null, fail_closed: false } as any) : null);
        pauseOn = true;
        const m1 = await tick({ pauseBlock: midPause });
        assertEq([m1.processed.length, m1.failures.map((x) => x.path), rowOf("m-1").catalog_class], [0, [mPath], "klinikk"], "dtj-5f: pause inside apply -> per-file failure, nothing written");
        pauseOn = false;
        const m2 = await tick({ pauseBlock: midPause });
        assertEq([m2.processed.map((p) => p.path), rowOf("m-1").catalog_class, rowOf("m-1").catalog_class_source], [[mPath], "person_enk", "dental_triage_judgement:run-m"], "dtj-5g: retried and applied once the pause clears");
        assertTrue(gh.urls.every((u) => u.startsWith("https://api.github.com/")), "dtj-5h: every job request went to api.github.com");
      }

      // ── dtj-6: routes. ───────────────────────────────────────────────
      {
        seed({ id: "c-old", review_since: "2026-08-01T00:00:00.000Z" });
        seed({ id: "c-undecided", review_since: "2026-09-20T00:00:00.000Z" });
        db.prepare(
          `INSERT INTO dental_verifier_findings (id, agent_id, check_type, status, evidence, notes, checked_at)
           VALUES ('f-u', 'c-undecided', 'dental_triage', 'undecided', '{}', 'verified_rule_not_met', datetime('now'))`,
        ).run();
        const noKey = await callRoute(router, { method: "GET", url: "/judge-candidates" });
        assertEq(noKey.status, 403, "dtj-6a: judge-candidates needs the admin key");
        const noKey2 = await callRoute(router, { method: "GET", url: "/judgement-status" });
        assertEq(noKey2.status, 403, "dtj-6b: judgement-status needs the admin key");
        const before = snapshot();
        const c = await callRoute(router, { method: "GET", url: "/judge-candidates?limit=500", headers: adminHeaders });
        assertEq([c.status, c.body.limit, c.body.judgement_schema], [200, 50, SCHEMA], "dtj-6c: candidates 200, limit clamped to 50");
        const ids = c.body.rows.map((r: any) => r.id);
        assertEq(ids[0], "c-undecided", "dtj-6d: 3c-1 undecided rows first");
        assertTrue(ids.indexOf("c-old") > 0, "dtj-6e: then oldest review_since");
        assertTrue(!ids.includes("d-avvis") && !ids.includes("d-pending") && !ids.includes("d-inactive") && !ids.includes("d-other"), "dtj-6f: only rows in the triage state");
        assertTrue(!ids.includes("d-klasse") && !ids.includes("m-1"), "dtj-6g: a row with a recent applied judgement is not re-offered");
        assertTrue(ids.includes("d-badclass"), "dtj-6h: a rejected (not applied) judgement does not hide the row");
        assertEq(Object.keys(c.body.rows[0]).sort(), ["catalog_class", "directory_url", "homepage", "id", "name", "org_nr", "postnummer", "poststed", "review_reason", "review_since", "triage_last"], "dtj-6i: public fields only");
        assertEq(c.body.rows[0].triage_last?.status, "undecided", "dtj-6j: latest 3c-1 outcome included");
        const c1 = await callRoute(router, { method: "GET", url: "/judge-candidates?limit=1", headers: adminHeaders });
        assertEq(c1.body.rows.length, 1, "dtj-6k: limit=1");
        const c0 = await callRoute(router, { method: "GET", url: "/judge-candidates?limit=0", headers: adminHeaders });
        assertEq(c0.body.limit, 1, "dtj-6l: limit=0 clamped to 1");
        assertEq(snapshot(), before, "dtj-6m: candidates GET writes nothing");
        const st = await callRoute(router, { method: "GET", url: "/judgement-status", headers: adminHeaders });
        assertEq([st.status, st.body.success, st.body.enabled, Array.isArray(st.body.files)], [200, true, false, true], "dtj-6n: status route (flag unset in process -> enabled false)");
        const s2 = job.getDentalTriageJudgementsStatus(db, env, { mainDb });
        assertEq([s2.enabled, s2.token_present, s2.files.length >= 4, s2.last_applied_at !== null], [true, true, true, true], "dtj-6o: status shape");
      }

      assertEq(globalFetchCalls, 0, "dtj-7: ZERO global fetch (no LLM, no other host)");
      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("dental-triage-judgement-job: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      restoreMainDb();
      globalThis.fetch = prevFetch;
      for (const [k, val] of Object.entries(prevEnv)) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runDentalTriageJudgementJobTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
