/**
 * experience-description-proposals-job.test.ts — tests for dev-request
 * 2026-10-07-experiences-beskrivelser-forslagsko-steg2, part B: the hourly
 * server-side job that reads description proposal files from slookisen/A2A
 * (`experiences-proposals/<UTC-date>/<run-id>.json`) via the GitHub
 * contents API and stores them through applyPrewrittenExperienceDescriptions()
 * — the same function POST /admin/experiences-description-write runs — plus
 * the read-only GET /admin/experiences-description-proposals-status.
 *
 * Covers: disabled flag / missing token / write-pause -> no GitHub call at
 * all; only date dirs from the last 14 UTC days are listed; oldest-first,
 * max 2 files per tick; every path processed once (also after its sha
 * changes); invalid schema / too many items -> recorded error, nothing
 * written; a valid file writes exactly like the endpoint (twin rows through
 * both paths give identical per-item outcomes and stored values); GitHub
 * HTTP errors and timeouts record nothing, so the file is retried; a run-
 * ledger envelope per tick that did work; ZERO requests to
 * api.anthropic.com; status GET shape + 403 without the admin key.
 *
 * Setup mirrors opplevelser-experience-description-write.test.ts: a FRESH
 * in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:", require-cache
 * purge), the main db pinned in-memory (write-pause row + runs ledger), the
 * router driven through router.handle(). GitHub is a stub fetch keyed on
 * the contents-API path; nothing touches the network.
 */

import { experienceDescriptionFactsFingerprint, EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL } from "../routes/opplevelser";

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
  appSettings: Record<string, unknown>,
  opts: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method, url: opts.url, originalUrl: opts.url, path: opts.url,
      query: {}, headers: opts.headers || {}, body: opts.body,
      app: { get: (k: string) => appSettings[k] },
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

const FAKTALINJE_TEXT =
  "Denne opplevelsen byr på en aktiv dag ute i naturen sammen med en lokal tilbyder som legger vekt på trygghet og godt følge.";
const KT_SENTENCE =
  "Vi tilbyr en kajakktur i rolig sjø for både nybegynnere og erfarne padlere, og turen starter ved brygga rett ved sjøen der guiden ønsker alle velkommen.";
const KILDETRO_TEXT = [KT_SENTENCE, KT_SENTENCE, KT_SENTENCE].join(" ");
const HOMEPAGE_HTML =
  "<html><body><p>Vi tilbyr kajakktur i fjorden for hele familien. Kontakt oss for mer informasjon.</p></body></html>";
const SCHEMA = "experiences-description-proposals/v1";

function verifiedFieldProvenance(): string {
  return JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
}

export function runExperienceDescriptionProposalsJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      EXPERIENCE_PROPOSALS_JOB_ENABLED: process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED,
      A2A_READ_PAT: process.env.A2A_READ_PAT,
    };
    const prevFetch = globalThis.fetch;
    const ADMIN_KEY_PJ = process.env.ADMIN_KEY || "experience-proposals-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY_PJ;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-must-never-be-used";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    const jobPath = require.resolve("./experience-description-proposals-job");
    for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath, jobPath]) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    // ── No-LLM guard on every fetch seam. ──────────────────────────────
    let llmCalls = 0;
    const isLlmUrl = (url: unknown) => String(url).includes("api.anthropic.com");
    globalThis.fetch = (async (url: any) => {
      if (isLlmUrl(url)) llmCalls++;
      throw new Error(`global fetch must not be called (${String(url)})`);
    }) as typeof fetch;
    const homepageFetch = (async (url: any) => {
      if (isLlmUrl(url)) { llmCalls++; throw new Error("LLM via homepage seam"); }
      const u = new URL(String(url));
      if (u.pathname === "/" || u.pathname === "") {
        const bytes = new TextEncoder().encode(HOMEPAGE_HTML);
        return {
          ok: true, status: 200, arrayBuffer: async () => bytes.buffer,
          headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
          url: String(url),
        } as unknown as Response;
      }
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    // ── GitHub contents-API stub. ──────────────────────────────────────
    type Entry = { name: string; path: string; type: "dir" | "file"; sha: string; size?: number };
    const gh = {
      dirs: new Map<string, Entry[]>(),
      files: new Map<string, { sha: string; text: string }>(),
      fail: new Set<string>(),
      hang: new Set<string>(),
      calls: [] as string[],
      headersOk: true,
    };
    const ghFetch = (async (url: any, init: any) => {
      if (isLlmUrl(url)) { llmCalls++; throw new Error("LLM via github seam"); }
      const u = new URL(String(url));
      const prefix = "/repos/slookisen/A2A/contents/";
      const path = decodeURIComponent(u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname);
      gh.calls.push(path);
      const h = init?.headers ?? {};
      if (!String(h.Authorization ?? "").startsWith("Bearer ") || !h["User-Agent"]) gh.headersOk = false;
      if (gh.hang.has(path)) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (gh.fail.has(path)) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      const dir = gh.dirs.get(path);
      if (dir) return { ok: true, status: 200, json: async () => dir } as unknown as Response;
      const f = gh.files.get(path);
      if (f) {
        return {
          ok: true, status: 200,
          json: async () => ({ encoding: "base64", content: Buffer.from(f.text, "utf8").toString("base64"), sha: f.sha }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const ROOT = "experiences-proposals";
    function setRoot(names: Array<[string, "dir" | "file"]>): void {
      gh.dirs.set(ROOT, names.map(([name, type]) => ({ name, path: `${ROOT}/${name}`, type, sha: `sha-${name}` })));
    }
    function putFile(date: string, name: string, content: unknown, sha = `sha-${date}-${name}`, listedSize?: number): string {
      const path = `${ROOT}/${date}/${name}`;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      gh.files.set(path, { sha, text });
      const list = gh.dirs.get(`${ROOT}/${date}`) ?? [];
      const others = list.filter((e) => e.path !== path);
      gh.dirs.set(`${ROOT}/${date}`, [...others, { name, path, type: "file", sha, size: listedSize ?? Buffer.byteLength(text) }]);
      return path;
    }
    const fetchCount = (path: string) => gh.calls.filter((c) => c === path).length;

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
      const job = require("./experience-description-proposals-job") as typeof import("./experience-description-proposals-job");

      const NOW = new Date("2026-10-07T12:00:00Z");
      const env: Record<string, string | undefined> = { EXPERIENCE_PROPOSALS_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
      const tick = (over: Record<string, unknown> = {}) =>
        job.tickExperienceDescriptionProposals({
          fetchImpl: ghFetch, homepageFetchImpl: homepageFetch, now: NOW, env,
          expDb, mainDb: () => init.getDb(), ...over,
        } as any);

      const dumpAll = (): string =>
        JSON.stringify(expDb.prepare("SELECT id, description, content_field_evidence, content_source FROM experiences ORDER BY id").all());
      const rowOf = (id: string): any =>
        expDb.prepare("SELECT id, description, content_field_evidence, content_source FROM experiences WHERE id = ?").get(id);
      const processedPaths = (): string[] =>
        (expDb.prepare("SELECT path FROM experience_description_proposal_files ORDER BY path").all() as any[]).map((r) => r.path);
      const fileRow = (path: string): any =>
        expDb.prepare("SELECT * FROM experience_description_proposal_files WHERE path = ?").get(path);
      const runsFor = (): any[] =>
        init.getDb().prepare("SELECT * FROM runs WHERE agent = 'experience-proposals-job' ORDER BY rowid").all() as any[];

      // ── Seed ───────────────────────────────────────────────────────
      const providerF = expStore.createProvider({ navn: "Faktatur AS", kommune: "Bergen", fylke: "Vestland", brreg_verified: 1, brreg_active: 1, verification_status: "verified" });
      const providerK = expStore.createProvider({ navn: "Kildetur AS", kommune: "Bergen", fylke: "Vestland", brreg_verified: 1, brreg_active: 1, verification_status: "verified" });
      expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?").run("kildetur.example", verifiedFieldProvenance(), providerK);
      const seed = (id: string, over: Record<string, unknown> = {}): string =>
        expStore.createExperience({
          id, title: "Kajakktur i fjorden", provider_id: providerF, kommune: "Bergen", fylke: "Vestland",
          category: "natur_friluft", subcategory: "kajakk", season: ["summer"], indoor_outdoor: "outdoor",
          duration_min: 120, duration_max: 180, group_min: 2, group_max: 8, price_band: "standard",
          price_from: 890, price_unit: "per_person", languages: ["norsk", "engelsk"],
          accessibility: ["rullestolvennlig"], meeting_point: "Bryggen", booking_url: "https://example.no/book",
          verification_status: "verified", confidence: "high", slug: `slug-${id}`, ...over,
        } as any);
      const fpOf = (id: string): string => {
        const r = expDb.prepare(
          `SELECT e.*, p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified,
                  p.field_provenance AS provider_field_provenance, p.hjemmeside AS provider_hjemmeside
             FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = ?`,
        ).get(id);
        return experienceDescriptionFactsFingerprint(r);
      };
      const writeItem = (id: string, over: Record<string, unknown> = {}) => ({
        id, facts_fingerprint: fpOf(id), outcome: "write", level: "faktalinje", description: FAKTALINJE_TEXT,
        judge: { approved: true, model: "claude-opus-test", reasoning: "OK" }, ...over,
      });
      const file = (items: unknown[], extra: Record<string, unknown> = {}) =>
        ({ schema: SCHEMA, run_id: "test-run", created_at: "2026-10-07T00:00:00Z", items, ...extra });

      const idA1 = seed("pj-a1"); const idA2 = seed("pj-a2");
      const idB1 = seed("pj-b1");
      const idC1 = seed("pj-c1"); const idC2 = seed("pj-c2");
      const idK1 = seed("pj-k1", { provider_id: providerK });
      // Twins: the same items through the endpoint (t-*) and the job (j-*).
      const idTe1 = seed("pj-t-e1"); const idTe2 = seed("pj-t-e2"); const idTe3 = seed("pj-t-e3");
      const idTj1 = seed("pj-t-j1"); const idTj2 = seed("pj-t-j2"); const idTj3 = seed("pj-t-j3");
      const idE1 = seed("pj-e1");

      // ── pj-1: disabled flag / missing token / write-pause -> nothing
      //    fetched at all. ─────────────────────────────────────────────
      {
        gh.calls.length = 0;
        const r1 = await tick({ env: { A2A_READ_PAT: "test-pat" } });
        assertEq(r1.skipped_reason, "disabled", "pj-1a: flag unset -> disabled");
        const r2 = await tick({ env: { EXPERIENCE_PROPOSALS_JOB_ENABLED: "1", A2A_READ_PAT: "test-pat" } });
        assertEq(r2.skipped_reason, "disabled", 'pj-1b: flag "1" (not "true") -> disabled');
        const r3 = await tick({ env: { EXPERIENCE_PROPOSALS_JOB_ENABLED: "true" } });
        assertEq(r3.skipped_reason, "no_token", "pj-1c: missing A2A_READ_PAT -> no_token");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "pj test" }, "verifier");
        const r4 = await tick();
        assertEq(r4.skipped_reason, "paused", "pj-1d: experiences write-pause -> paused");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        assertEq(gh.calls.length, 0, "pj-1e: ZERO GitHub requests across disabled/no-token/paused ticks");
        assertEq(processedPaths(), [], "pj-1f: nothing recorded");
      }

      // ── Fixture tree. 2026-09-24 is 13 days before NOW (in range);
      //    2026-09-23 is 14 days (out); "notes" is not a date. ───────────
      setRoot([["2026-09-23", "dir"], ["2026-09-24", "dir"], ["2026-10-07", "dir"], ["notes", "dir"], ["README.md", "file"]]);
      gh.dirs.set(`${ROOT}/notes`, []);
      const pOld = putFile("2026-09-23", "old.json", file([writeItem(idE1)]));
      const pA = putFile("2026-09-24", "a.json", file([writeItem(idA1), writeItem(idA2)]));
      const pB = putFile("2026-09-24", "b.json", file([writeItem(idB1)], { schema: "something-else/v9" }));
      const pC = putFile("2026-10-07", "c.json", file([
        writeItem(idC1),
        { id: idC2, facts_fingerprint: fpOf(idC2), outcome: "skip", reason: "sentinel" },
        writeItem(idK1, { level: "kildetro", description: KILDETRO_TEXT }),
      ]));
      putFile("2026-10-07", "notes.txt", "ikke json");

      // ── pj-2: first tick — oldest first, max 2: a.json + b.json. ─────
      {
        const r = await tick();
        assertEq(r.skipped_reason, null, "pj-2a: not skipped");
        assertEq(r.processed.map((p: any) => p.path), [pA, pB], "pj-2b: oldest date first, file names ascending, max 2");
        assertEq(r.processed.map((p: any) => p.status), ["applied", "error"], "pj-2c: a applied, b error");
        assertEq(r.written, 2, "pj-2d: two rows written from a.json");
        // The 14-day-old dir is listed at most once, read-only, for the N6
        // "dropped by the window" log line — its files are never fetched
        // (pj-2g) and never processed.
        assertTrue(fetchCount(`${ROOT}/2026-09-23`) <= 1, "pj-2e: the 14-day-old dir is only listed for the dropped-file count");
        assertTrue(!r.processed.some((p: any) => p.path.startsWith(`${ROOT}/2026-09-23/`)), "pj-2e2: nothing from the old dir is processed");
        assertTrue(!gh.calls.includes(`${ROOT}/notes`), "pj-2f: a non-date dir is never listed");
        assertEq(fetchCount(pOld), 0, "pj-2g: a file in the old dir is never fetched");
        assertTrue(gh.headersOk, "pj-2h: every GitHub request carries Bearer auth + User-Agent");
        assertEq(rowOf(idA1).description, FAKTALINJE_TEXT, "pj-2i: a.json row 1 written");
        assertEq(JSON.parse(rowOf(idA2).content_field_evidence).description, EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL, "pj-2j: provenance generated:claude-code");
        assertEq(rowOf(idB1).description, null, "pj-2k: invalid-schema file wrote nothing");
        const fb = JSON.parse(fileRow(pB).result_json);
        assertEq(fb.status, "error", "pj-2l: b.json recorded as error");
        assertTrue(String(fb.error).includes("schema"), "pj-2m: error names the schema");
        assertEq(fileRow(pA).sha, `sha-2026-09-24-a.json`, "pj-2n: sha recorded");
        const runs = runsFor();
        assertEq(runs.length, 1, "pj-2o: one run-ledger envelope");
        const claims = JSON.parse(runs[0].claims);
        assertEq(claims, [
          { type: "db_state_change", value: 2, meta: { kind: "experiences_content_enriched", source: "proposals_job" } },
          { type: "db_state_change", value: 2, meta: { kind: "proposals_processed" } },
        ], "pj-2p: envelope claims");
        assertEq([runs[0].vertical, runs[0].status], ["experiences", "partial"], "pj-2q: vertical experiences, partial (one file errored)");
        assertTrue(r.envelope_recorded, "pj-2r: report says envelope recorded");
        assertEq(JSON.parse(runs[0].evidence), [
          { claim_idx: 0, ids: [idA1, idA2] },
          { claim_idx: 1, ids: [pA, pB] },
        ], "pj-2s: evidence carries the written experience ids (claim 0) and the processed paths (claim 1)");
      }

      // ── pj-3: second tick — only c.json; a/b never refetched. ────────
      {
        const r = await tick();
        assertEq(r.processed.map((p: any) => p.path), [pC], "pj-3a: second tick processes c.json only");
        assertEq(fetchCount(pA), 1, "pj-3b: a.json content fetched exactly once overall");
        assertEq(fetchCount(pB), 1, "pj-3c: b.json content fetched exactly once overall");
        const t = r.processed[0].totals;
        assertEq([t.written, t.skipped_recorded, t.rejected], [2, 1, 0], "pj-3d: c.json: faktalinje + kildetro written, one skip recorded");
        assertEq(rowOf(idK1).content_source, "provider_site", "pj-3e: kildetro write through the shared path");
        assertEq(JSON.parse(rowOf(idK1).content_field_evidence).description, "https://kildetur.example", "pj-3f: kildetro evidence = fetched URL");
        const attempt = expDb.prepare("SELECT * FROM experience_description_attempts WHERE experience_id = ?").get(idC2) as any;
        assertEq(attempt?.reason, "faktalinje:sentinel", "pj-3g: skip item recorded an attempt row");
        assertEq(fetchCount(`${ROOT}/2026-10-07/notes.txt`), 0, "pj-3h: non-.json file never fetched");
        assertEq(runsFor().length, 2, "pj-3i: second envelope");
        assertEq(runsFor()[1].status, "completed", "pj-3j: completed when every file applied");
      }

      // ── pj-4: nothing new -> no processing, no envelope; a changed sha
      //    on an already-processed path is still skipped. ────────────────
      {
        putFile("2026-09-24", "a.json", file([writeItem(idE1)]), "sha-changed");
        const r = await tick();
        assertEq(r.processed, [], "pj-4a: nothing processed");
        assertEq(runsFor().length, 2, "pj-4b: no envelope for an idle tick");
        assertEq(fileRow(pA).sha, "sha-2026-09-24-a.json", "pj-4c: original sha kept");
        assertEq(rowOf(idE1).description, null, "pj-4d: the changed file's content was never applied");
      }

      // ── pj-5: a valid file writes EXACTLY like the endpoint — twin rows,
      //    same items (one write, one judge-rejected, one ungrounded). ────
      {
        const twinItems = (ids: string[]) => [
          writeItem(ids[0]),
          writeItem(ids[1], { judge: { approved: false } }),
          writeItem(ids[2], { description: "Turen koster 1500 kroner per person." }),
        ];
        process.env.ADMIN_KEY = ADMIN_KEY_PJ;
        const ep = await callRoute(router, { experienceDescriptionHomepageFetchImpl: homepageFetch }, {
          method: "POST", url: "/admin/experiences-description-write", headers: { "x-admin-key": ADMIN_KEY_PJ },
          body: { dry_run: false, items: twinItems([idTe1, idTe2, idTe3]) },
        });
        const pT = putFile("2026-10-07", "d-twins.json", file(twinItems([idTj1, idTj2, idTj3])));
        const r = await tick();
        assertEq(r.processed.map((p: any) => p.path), [pT], "pj-5a: twin file processed");
        const jobResults = JSON.parse(fileRow(pT).result_json).results;
        const strip = (rs: any[]) => rs.map((x) => ({ result: x.result, reason: x.reason ?? null }));
        assertEq(strip(jobResults), strip(ep.body.results), "pj-5b: identical per-item outcomes via job and endpoint");
        assertEq(strip(jobResults), [
          { result: "written", reason: null },
          { result: "rejected", reason: "judge_not_approved" },
          { result: "rejected", reason: "ungrounded_numbers" },
        ], "pj-5c: the expected outcomes");
        const stored = (id: string) => { const x = rowOf(id); return [x.description, x.content_field_evidence, x.content_source]; };
        assertEq(stored(idTj1), stored(idTe1), "pj-5d: identical stored values for the written twin");
        assertEq(stored(idTj2), stored(idTe2), "pj-5e: identical (untouched) values for the rejected twin");
      }

      // ── pj-6: shared structural validation (>25 items) -> recorded
      //    error, nothing written; invalid JSON likewise. ────────────────
      {
        const many = Array.from({ length: 26 }, (_, i) => ({ id: `none-${i}`, facts_fingerprint: "x", outcome: "skip", reason: "sentinel" }));
        const pMany = putFile("2026-10-07", "e-too-many.json", file(many));
        const pBad = putFile("2026-10-07", "f-bad.json", "{ not json");
        const before = dumpAll();
        const r = await tick();
        assertEq(r.processed.map((p: any) => [p.path, p.status]), [[pMany, "error"], [pBad, "error"]], "pj-6a: both recorded as error");
        assertTrue(String(r.processed[0].error).includes("1..25"), "pj-6b: same item-count error as the endpoint");
        assertEq(dumpAll(), before, "pj-6c: nothing written");
      }

      // ── pj-7: GitHub errors / timeouts record nothing; retried later. ─
      {
        const pG = putFile("2026-10-07", "g.json", file([writeItem(idE1)]));
        gh.fail.add(pG);
        const r1 = await tick();
        assertEq(r1.processed, [], "pj-7a: file fetch HTTP 500 -> nothing processed");
        assertTrue(r1.github_error !== null, "pj-7b: github_error reported");
        assertEq(fileRow(pG), undefined, "pj-7c: nothing recorded for the failing file");
        assertEq(r1.failures.map((x: any) => [x.path, x.fail_count]), [[pG, 1]], "pj-7c2: the failure is counted per path");
        gh.fail.delete(pG);
        gh.hang.add(pG);
        const r2 = await tick({ timeoutMs: 30 });
        assertEq(r2.processed, [], "pj-7d: content timeout -> nothing processed");
        assertTrue(String(r2.github_error).includes("aborted"), "pj-7e: timeout surfaced as a github error");
        assertEq(fileRow(pG), undefined, "pj-7f: nothing recorded after a timeout");
        gh.hang.delete(pG);
        gh.fail.add(ROOT);
        const r3 = await tick();
        assertEq(r3.skipped_reason, "github_error", "pj-7g: root listing 500 -> github_error");
        const failedRuns = () => runsFor().filter((x) => x.status === "failed");
        assertEq(failedRuns().length, 1, "pj-7g2: every GitHub call failed -> one `failed` envelope");
        await tick();
        assertEq(failedRuns().length, 1, "pj-7g3: ...at most once per UTC day");
        gh.fail.delete(ROOT);
        const r4 = await tick();
        assertEq(r4.processed.map((p: any) => [p.path, p.status]), [[pG, "applied"]], "pj-7h: the file is processed on the next healthy tick");
        assertEq(rowOf(idE1).description, FAKTALINJE_TEXT, "pj-7i: and written");
        assertEq(expDb.prepare("SELECT * FROM experience_description_proposal_failures WHERE path = ?").get(pG), undefined,
          "pj-7i2: the failure counter is cleared once the file is processed");
        gh.dirs.delete(ROOT);
        const r5 = await tick();
        assertEq([r5.skipped_reason, r5.processed.length], [null, 0], "pj-7j: a missing proposals dir (404) is a quiet idle tick");
      }

      // Restore the tree for the review follow-up blocks below.
      setRoot([["2026-09-23", "dir"], ["2026-09-24", "dir"], ["2026-10-07", "dir"], ["notes", "dir"], ["README.md", "file"]]);

      // ── pj-11 (review B2): an always-failing file never blocks the files
      //    behind it, and becomes a permanent error after 3 ticks. ────────
      {
        const idH = seed("pj-h1");
        const pH = putFile("2026-10-07", "h-always-fail.json", file([writeItem(idH)]));
        const idI = seed("pj-i1");
        const pI = putFile("2026-10-07", "i-ok.json", file([writeItem(idI)]));
        gh.fail.add(pH);
        const t1 = await tick();
        assertEq(t1.failures.map((x: any) => [x.path, x.fail_count]), [[pH, 1]], "pj-11a: tick 1 — h fails (1/3)");
        assertEq(t1.processed.map((p: any) => [p.path, p.status]), [[pI, "applied"]], "pj-11b: ...and i, behind it, is processed in the same tick");
        assertEq(runsFor()[runsFor().length - 1].status, "partial", "pj-11c: envelope is partial while a file is failing");
        const t2 = await tick();
        assertEq(t2.failures.map((x: any) => x.fail_count), [2], "pj-11d: tick 2 — 2/3");
        assertEq(fileRow(pH), undefined, "pj-11e: not yet recorded");
        const t3 = await tick();
        assertEq(t3.failures.map((x: any) => x.fail_count), [3], "pj-11f: tick 3 — 3/3");
        const fh = JSON.parse(fileRow(pH).result_json);
        assertEq(fh.status, "error", "pj-11g: recorded as a permanent error");
        assertTrue(String(fh.error).startsWith("failed 3 times"), "pj-11h: error says it failed 3 times");
        const before = fetchCount(pH);
        await tick();
        assertEq(fetchCount(pH), before, "pj-11i: a permanently failed file is never fetched again");
        assertEq(rowOf(idH).description, null, "pj-11j: nothing written for it");
        gh.fail.delete(pH);
      }

      // ── pj-12 (review B1): size cap — by listing size (never fetched)
      //    and by decoded content (listing lied). ─────────────────────────
      {
        const pBig = putFile("2026-10-07", "j-big.json", file([]), undefined, 70_000);
        const bigItems = Array.from({ length: 20 }, (_, i) => writeItem(idE1, { id: `big-${i}`, description: "x".repeat(4000) }));
        const pLie = putFile("2026-10-07", "k-lying.json", file(bigItems), undefined, 100);
        const before = dumpAll();
        const r = await tick();
        assertEq(r.processed.map((p: any) => [p.path, p.status, p.error]), [[pBig, "error", "file too large"], [pLie, "error", "file too large"]],
          "pj-12a: both recorded as permanent 'file too large'");
        assertEq(fetchCount(pBig), 0, "pj-12b: a file listed over 64 KB is never fetched");
        assertEq(fetchCount(pLie), 1, "pj-12c: the lying listing is fetched once, then capped on its decoded size");
        assertEq(dumpAll(), before, "pj-12d: nothing written");
      }

      // ── pj-13 (review N2): an exception in apply() is a per-file failure,
      //    the next file is still processed, envelope partial. ────────────
      {
        const idM = seed("pj-m1");
        const pL = putFile("2026-10-07", "l-throws.json", file([{ id: "throw-me", facts_fingerprint: "x", outcome: "skip", reason: "sentinel" }]));
        const pM = putFile("2026-10-07", "m-ok.json", file([writeItem(idM)]));
        const realApply = opp.applyPrewrittenExperienceDescriptions;
        const throwingApply = (async (db: any, items: any, o: any) => {
          if (Array.isArray(items) && items[0]?.id === "throw-me") throw new Error("boom in apply");
          return realApply(db, items, o);
        }) as any;
        const r = await tick({ apply: throwingApply });
        assertEq(r.failures.map((x: any) => [x.path, x.fail_count]), [[pL, 1]], "pj-13a: apply exception counted as a failure");
        assertTrue(String(r.failures[0].error).includes("boom in apply"), "pj-13b: failure carries the exception message");
        assertEq(r.processed.map((p: any) => [p.path, p.status]), [[pM, "applied"]], "pj-13c: the next file is still processed");
        assertEq(rowOf(idM).description, FAKTALINJE_TEXT, "pj-13d: and written");
        const last = runsFor()[runsFor().length - 1];
        assertEq(last.status, "partial", "pj-13e: envelope written, partial");
        assertTrue(JSON.parse(last.errors).some((e: any) => String(e.message).includes("boom in apply")), "pj-13f: envelope errors include the apply failure");
        // Retire the throwing file so it does not interfere below.
        gh.dirs.set(`${ROOT}/2026-10-07`, (gh.dirs.get(`${ROOT}/2026-10-07`) ?? []).filter((e) => e.path !== pL));
      }

      // ── pj-14 (review N1 + N6): no query string in error messages; one
      //    log line counting unprocessed files dropped by the 14-day window. ─
      {
        job.__resetExperienceProposalsDroppedLogForTesting();
        const capture = async (): Promise<string[]> => {
          const lines: string[] = [];
          const prevLog = console.log;
          console.log = (...a: any[]) => { lines.push(a.map(String).join(" ")); };
          try {
            await tick();
          } finally {
            console.log = prevLog;
          }
          return lines;
        };
        const dropRe = /1 unprocessed proposal file\(s\) dropped by the 14-day window/;
        const lines = await capture();
        assertTrue(lines.some((l) => dropRe.test(l)), "pj-14a: the old dir's unprocessed file is reported as dropped");
        const oldListings = fetchCount(`${ROOT}/2026-09-23`);
        const lines2 = await capture();
        assertTrue(!lines2.some((l) => dropRe.test(l)), "pj-14a2: ...at most once per UTC day");
        assertEq(fetchCount(`${ROOT}/2026-09-23`), oldListings, "pj-14a3: and the old dir is not listed again that day");
        assertEq(fetchCount(pOld), 0, "pj-14b: ...but never fetched");
        const qFetch = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
        const r = await tick({ fetchImpl: qFetch });
        assertTrue(r.github_error !== null && !String(r.github_error).includes("?"), "pj-14c: error message has no query string");
      }

      // ── pj-15 (re-review): root listing OK but every date-dir listing
      //    fails -> nothing processed, yet a `partial` envelope is written. ─
      {
        gh.fail.add(`${ROOT}/2026-09-24`);
        gh.fail.add(`${ROOT}/2026-10-07`);
        const before = runsFor().length;
        const r = await tick();
        assertEq([r.processed.length, r.failures.length], [0, 0], "pj-15a: nothing processed, no per-file failures");
        assertTrue(r.github_error !== null, "pj-15b: github_error reported");
        assertEq(runsFor().length, before + 1, "pj-15c: one envelope written");
        const last = runsFor()[runsFor().length - 1];
        assertEq([last.run_id, last.status], [r.run_id, "partial"], "pj-15d: this tick's envelope, status partial");
        gh.fail.delete(`${ROOT}/2026-09-24`);
        gh.fail.delete(`${ROOT}/2026-10-07`);
      }

      // ── pj-8: status GET shape + admin gate. ────────────────────────
      {
        const prevEnabled = process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED;
        const prevPat = process.env.A2A_READ_PAT;
        process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED = "true";
        process.env.A2A_READ_PAT = "secret-pat-value";
        process.env.ADMIN_KEY = ADMIN_KEY_PJ;
        const r = await callRoute(router, {}, { method: "GET", url: "/admin/experiences-description-proposals-status", headers: { "x-admin-key": ADMIN_KEY_PJ } });
        assertEq(r.status, 200, "pj-8a: 200");
        assertEq([r.body.enabled, r.body.token_present], [true, true], "pj-8b: enabled + token_present");
        assertTrue(!JSON.stringify(r.body).includes("secret-pat-value"), "pj-8c: the token value is never returned");
        assertTrue(Array.isArray(r.body.files) && r.body.files.length >= 6 && r.body.files.length <= 20, "pj-8d: processed files listed (max 20)");
        const fa = (r.body.files as any[]).find((f) => f.path === pA);
        assertEq([fa.status, fa.totals?.written], ["applied", 2], "pj-8e: a.json shows status + totals");
        const fbb = (r.body.files as any[]).find((f) => f.path === pB);
        assertEq(fbb.status, "error", "pj-8f: b.json shows error");
        for (const k of ["path", "sha", "processed_at", "status", "error", "totals"]) assertTrue(k in fa, `pj-8g: file entry has ${k}`);
        const noKey = await callRoute(router, {}, { method: "GET", url: "/admin/experiences-description-proposals-status" });
        assertEq(noKey.status, 403, "pj-8h: no admin key -> 403");
        const wrongKey = await callRoute(router, {}, { method: "GET", url: "/admin/experiences-description-proposals-status", headers: { "x-admin-key": "wrong" } });
        assertEq(wrongKey.status, 403, "pj-8i: wrong admin key -> 403");
        delete process.env.A2A_READ_PAT;
        delete process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED;
        const off = await callRoute(router, {}, { method: "GET", url: "/admin/experiences-description-proposals-status", headers: { "x-admin-key": ADMIN_KEY_PJ } });
        assertEq([off.body.enabled, off.body.token_present], [false, false], "pj-8j: OFF by default, token absent");
        if (prevEnabled === undefined) delete process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED; else process.env.EXPERIENCE_PROPOSALS_JOB_ENABLED = prevEnabled;
        if (prevPat === undefined) delete process.env.A2A_READ_PAT; else process.env.A2A_READ_PAT = prevPat;
      }

      // ── pj-9: pure helpers. ─────────────────────────────────────────
      assertEq(job.experienceProposalsDateIsRecent("2026-10-07", NOW), true, "pj-9a: today is recent");
      assertEq(job.experienceProposalsDateIsRecent("2026-09-24", NOW), true, "pj-9b: 13 days ago is recent");
      assertEq(job.experienceProposalsDateIsRecent("2026-09-23", NOW), false, "pj-9c: 14 days ago is not");
      assertEq(job.experienceProposalsDateIsRecent("2026-10-08", NOW), false, "pj-9d: a future date is not");
      assertEq(job.experienceProposalsDateIsRecent("notes", NOW), false, "pj-9e: a non-date is not");
      assertEq("error" in job.validateExperienceProposalFile({ schema: SCHEMA, items: [] }), false, "pj-9f: valid shape");
      assertEq("error" in job.validateExperienceProposalFile({ schema: SCHEMA, items: {} }), true, "pj-9g: items must be an array");
      assertEq("error" in job.validateExperienceProposalFile([]), true, "pj-9h: must be an object");

      // ── pj-10: no LLM anywhere. ─────────────────────────────────────
      assertEq(llmCalls, 0, "pj-10: ZERO requests to api.anthropic.com");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-description-proposals-job: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath, jobPath]) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}
