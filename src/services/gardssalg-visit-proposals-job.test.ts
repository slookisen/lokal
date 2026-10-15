/**
 * gardssalg-visit-proposals-job.test.ts — «4b-forslag» (A2A dev-request
 * 2026-10-06-experiences-enrichment-plattformjobb-og-felles-serverjobbramme,
 * tillegg 2026-10-15): the drink-producer visit_text proposals lane.
 *
 *   A. GET /admin/gardssalg-visit-candidates — read-only: verified drink
 *      rows blank on visit_text (manual / owner-locked / shared-domain /
 *      unverified excluded; resting rows INCLUDED), crawled page text and
 *      the server-owned prompts in the response, nothing stamped.
 *   B. applyGardssalgVisitProposals() through POST /admin/gardssalg-visit-
 *      proposals-write — every deterministic gate, the server's own
 *      re-fetch, verbatim evidence, word overlap, fill-only, owner lock,
 *      host match, skip items stamping + no-yield strike, dry-run honesty,
 *      and ZERO calls to api.anthropic.com throughout.
 *   C. The hourly job (tickGardssalgVisitProposals) against a fake GitHub
 *      contents API: disabled / no token / paused guards, file processed
 *      exactly once through the SAME apply function, envelope claims
 *      (gardssalg_drink_cohort_enriched source visit_proposals_job).
 *
 * Conventions as in experience-description-proposals-job.test.ts and
 * gardssalg-content-refresh-job.test.ts (in-memory DBs, router.handle(),
 * globalThis.fetch stubbed for the crawl; GitHub via the fetchImpl seam).
 */
export interface TestSummary { passed: number; failed: number; failures: string[]; }

export function runGardssalgVisitProposalsJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "gardssalg-visit-proposals-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-visit-proposals";
    const testKey = process.env.ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../routes/opplevelser"),
      require.resolve("./proposal-file-queue"),
      require.resolve("./gardssalg-visit-proposals-job"),
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
      const job = require("./gardssalg-visit-proposals-job") as typeof import("./gardssalg-visit-proposals-job");

      const call = (method: "GET" | "POST", url: string, body?: any): Promise<{ status: number; body: any }> =>
        new Promise((resolve) => {
          const q: Record<string, string> = {};
          const qi = url.indexOf("?");
          if (qi >= 0) for (const [k, v] of new URLSearchParams(url.slice(qi + 1))) q[k] = v;
          const req: any = { method, url, originalUrl: url, path: url.split("?")[0], query: q, headers: { "x-admin-key": testKey }, body: body ?? {}, get() { return undefined; } };
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, body: p }); return this; } };
          router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
        });

      // ── Seed ─────────────────────────────────────────────────────────
      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            field_provenance, producer_type, last_content_attempt_at, content_no_yield_streak, created_at,
            enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, NULL, @products,
            @fp, @producer_type, @last_attempt, @streak, @created_at, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const fp = (verified: boolean, extra: Record<string, unknown> = {}) => JSON.stringify({
        hjemmeside_verification: { verified, classification: verified ? "verified" : "unverified", checked_at: "2026-01-01T00:00:00.000Z" }, ...extra,
      });
      const ABOUT = "Bryggeriet ligger på gården ved fjorden og har brygget øl av eget korn og humle siden 2012, med fokus på håndverk.";
      const PRODUCTS = JSON.stringify(["Pils"]);
      const seed = (id: string, over: Record<string, unknown> = {}) => insert.run({
        id, navn: `Navn ${id}`, hjemmeside: `https://${id}.example.no`, content_source: null, about_text: ABOUT, visit_text: null, products: PRODUCTS,
        fp: fp(true), producer_type: "bryggeri", last_attempt: null, streak: 0, created_at: "2026-01-01 00:00:00", ...over,
      });
      seed("vp-a", { created_at: "2026-01-01 00:00:00" });                                   // eligible, never attempted
      seed("vp-b", { last_attempt: "2026-09-01 00:00:00", streak: 3, created_at: "2026-01-02 00:00:00" }); // resting (3 strikes, recent attempt) -> still a candidate
      seed("vp-manual", { content_source: "manual" });
      seed("vp-locked", { content_source: "claim", fp: fp(true, { owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }) });
      seed("vp-unverified", { fp: fp(false) });
      seed("vp-has-visit", { visit_text: "Allerede skrevet besøkstekst om gårdsbutikken som er åpen i helgene." });
      seed("vp-nondrink", { producer_type: "gardsbutikk" });
      seed("vp-dead", { created_at: "2026-01-03 00:00:00" });                                 // homepage 404

      let anthropicCalls = 0;
      const htmlA = `<html><head><title>A</title></head><body><p>Velkommen til bryggeriet. Taprommet vårt er åpent for besøkende hver lørdag, og vi tilbyr smaking av sesongens øl og omvisning i bryggeriet. Gårdsutsalget selger flasker og gavekort.</p></body></html>`;
      const htmlB = `<html><body><p>Et lite bryggeri i dalen. Vi leverer til utvalgte butikker og restauranter i regionen.</p></body></html>`;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("api.anthropic.com")) { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS" }] }) } as unknown as Response; }
        const parsed = new URL(u);
        const host = parsed.hostname;
        const html = host === "vp-a.example.no" ? htmlA : host === "vp-dead.example.no" ? null : host.endsWith(".example.no") ? htmlB : null;
        if (html && (parsed.pathname === "/" || parsed.pathname === "")) {
          return { ok: true, status: 200, text: async () => html, arrayBuffer: async () => new TextEncoder().encode(html).buffer, headers: { get: () => null } } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      const row = (id: string): any => expDb.prepare("SELECT visit_text, last_content_attempt_at, content_no_yield_streak, content_source FROM experience_providers WHERE id = ?").get(id);

      // ═══════════════ A. candidates GET ════════════════════════════════
      {
        anthropicCalls = 0;
        const r = await call("GET", "/admin/gardssalg-visit-candidates?limit=10");
        assertEq(r.status, 200, "a1: candidates GET -> 200");
        const ids = r.body.items.map((i: any) => i.provider_id);
        assertEq(ids, ["vp-a", "vp-dead", "vp-b"], "a2: only eligible drink rows, queue order (never-attempted first, then oldest attempt), resting row INCLUDED, manual/locked/unverified/has-visit/non-drink excluded");
        assertEq(r.body.eligible_total, 3, "a3: eligible_total counts the same set");
        const a = r.body.items.find((i: any) => i.provider_id === "vp-a");
        assertEq(a.fetch_ok, true, "a4: vp-a crawled");
        assertEq(a.source_url, "https://vp-a.example.no", "a5: source_url is the crawl's fetch URL");
        assertTrue(Array.isArray(a.pages) && a.pages.length >= 1 && a.pages[0].text.includes("Taprommet"), "a6: page text included (homepage first)");
        assertTrue(typeof a.deterministic_visit_summary === "string", "a7: deterministic summary present (string)");
        const dead = r.body.items.find((i: any) => i.provider_id === "vp-dead");
        assertEq(dead.fetch_ok, false, "a8: dead homepage reported as fetch_ok:false, not dropped");
        assertEq(r.body.rules.schema, job.GARDSSALG_VISIT_PROPOSALS_SCHEMA, "a9: rules carry the file schema");
        assertTrue(r.body.rules.generator_prompt.includes("{{KILDETEKST}}") && r.body.rules.judge_prompt.includes("{{KANDIDATTEKST}}"), "a10: server-owned prompts with placeholders");
        assertEq(row("vp-a").last_content_attempt_at, null, "a11: GET stamps nothing");
        assertEq(anthropicCalls, 0, "a12: candidates GET makes no model call");
        const r2 = await call("GET", "/admin/gardssalg-visit-candidates?limit=1");
        assertEq(r2.body.items.length, 1, "a13: limit respected");
        assertEq(r2.body.eligible_total, 3, "a14: eligible_total unaffected by limit");
        const r3 = await call("GET", "/admin/gardssalg-visit-candidates?limit=999");
        assertTrue(r3.body.returned <= route.GARDSSALG_VISIT_CANDIDATES_MAX_LIMIT, "a15: limit capped");
      }

      // ═══════════════ B. write endpoint / shared apply ═════════════════
      const GOOD_TEXT = "Taprommet er åpent for besøkende hver lørdag, med smaking av sesongens øl og omvisning i bryggeriet, og gårdsutsalget selger flasker.";
      const good = (over: Record<string, unknown> = {}) => ({
        provider_id: "vp-a", outcome: "write", visit_text: GOOD_TEXT, source_url: "https://vp-a.example.no/",
        evidence_snippets: ["Taprommet vårt er åpent for besøkende hver lørdag", "smaking av sesongens øl og omvisning i bryggeriet"],
        judge: { approved: true, model: "claude-code-judge-subagent", reasoning: "Alt har dekning." }, ...over,
      });
      {
        anthropicCalls = 0;
        // b1: dry-run default -> would_write, nothing written
        const d = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [good()] });
        assertEq(d.status, 200, "b1-1: dry-run -> 200");
        assertEq(d.body.dry_run, true, "b1-2: dry_run defaults to true");
        assertEq(d.body.results[0].result, "would_write", "b1-3: honest dry-run verdict would_write (server re-fetched and checked)");
        assertEq(row("vp-a").visit_text, null, "b1-4: nothing written on dry-run");

        // b2: rejections, each gate
        const cases: Array<[string, Record<string, unknown>, string]> = [
          ["not_found", { provider_id: "nope" }, "unknown provider"],
          ["unverified_website", { provider_id: "vp-unverified" }, "unverified website"],
          ["manual", { provider_id: "vp-manual" }, "manual row"],
          ["owner_locked", { provider_id: "vp-locked" }, "owner-locked visit_text"],
          ["already_present", { provider_id: "vp-has-visit" }, "fill-only: visit_text already present"],
          ["judge_not_approved", { judge: { approved: false } }, "judge not approved"],
          ["below_min_chars", { visit_text: "For kort." }, "too short"],
          ["above_max_chars", { visit_text: "x".repeat(401) }, "too long"],
          ["contact_or_link_or_markup", { visit_text: GOOD_TEXT + " Se www.eksempel.no" }, "link in text"],
          ["evidence_snippets_count", { evidence_snippets: [] }, "no evidence"],
          ["source_host_mismatch", { source_url: "https://visitnorway.com/bryggeri" }, "foreign source host"],
          ["evidence_not_found", { evidence_snippets: ["Dette står ikke på siden i det hele tatt."] }, "evidence not on page"],
        ];
        for (const [reason, over, label] of cases) {
          const r = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [good(over)] });
          assertEq(r.status, 200, `b2-${reason}-status: ${label} -> 200`);
          assertEq(r.body.results[0].result, "rejected", `b2-${reason}-result: ${label} -> rejected`);
          assertTrue(String(r.body.results[0].reason).startsWith(reason), `b2-${reason}-reason: ${label} -> reason ${reason} (got ${r.body.results[0].reason})`);
        }
        const lo = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [good({ visit_text: "Produsenten arrangerer internasjonale festivaler med kjendiskokker og fyrverkeri hver eneste kveld gjennom hele sommeren.", evidence_snippets: ["Taprommet vårt er åpent for besøkende hver lørdag"] })] });
        assertTrue(String(lo.body.results[0].reason).startsWith("low_source_overlap"), "b2-overlap: text whose words are not on the page -> low_source_overlap");
        assertEq(row("vp-a").visit_text, null, "b2-z: still nothing written after all rejections");

        // b3: structural errors -> 400
        const s1 = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [] });
        assertEq(s1.status, 400, "b3-1: empty items -> 400");
        const s2 = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [good(), good()] });
        assertEq(s2.status, 400, "b3-2: duplicate provider_id -> 400");
        const s3 = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: Array.from({ length: 11 }, (_, i) => good({ provider_id: `vp-x${i}` })) });
        assertEq(s3.status, 400, "b3-3: > 10 write items -> 400");
        const s4 = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [{ provider_id: "vp-a", outcome: "skip", reason: "whatever" }] });
        assertEq(s4.status, 400, "b3-4: unknown skip reason -> 400");

        // b4: the real write
        const w = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [good()] });
        assertEq(w.status, 200, "b4-1: apply -> 200");
        assertEq(w.body.results[0].result, "written", "b4-2: written");
        assertEq(w.body.totals.written, 1, "b4-3: totals.written 1");
        assertEq(row("vp-a").visit_text, GOOD_TEXT, "b4-4: visit_text stored verbatim (whitespace-normalised)");
        assertTrue(!!row("vp-a").last_content_attempt_at, "b4-5: attempt stamped on write");
        assertEq(row("vp-a").content_no_yield_streak, 0, "b4-6: no-yield streak reset to 0");
        const again = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [good()] });
        assertEq(again.body.results[0].reason, "already_present", "b4-7: second write of the same row -> already_present (fill-only)");

        // b5: skip item -> attempt stamped + strike; dry-run -> would_record_skip
        const sd = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [{ provider_id: "vp-b", outcome: "skip", reason: "no_visit_info" }] });
        assertEq(sd.body.results[0].result, "would_record_skip", "b5-1: dry-run skip -> would_record_skip");
        assertEq(row("vp-b").content_no_yield_streak, 3, "b5-2: dry-run skip changes nothing");
        const sk = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [{ provider_id: "vp-b", outcome: "skip", reason: "no_visit_info" }] });
        assertEq(sk.body.results[0].result, "skipped_recorded", "b5-3: apply skip -> skipped_recorded");
        assertEq(row("vp-b").content_no_yield_streak, 4, "b5-4: skip counts a no-yield strike");
        assertTrue(!!row("vp-b").last_content_attempt_at && row("vp-b").last_content_attempt_at !== "2026-09-01 00:00:00", "b5-5: skip stamps the attempt (row cycles to the back)");

        // b6: write-pause fence on apply only
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "vp test" }, "verifier");
        const p1 = await call("POST", "/admin/gardssalg-visit-proposals-write", { dry_run: false, items: [good({ provider_id: "vp-dead" })] });
        assertEq(p1.status, 423, "b6-1: apply under write-pause -> 423");
        const p2 = await call("POST", "/admin/gardssalg-visit-proposals-write", { items: [good({ provider_id: "vp-dead" })] });
        assertEq(p2.status, 200, "b6-2: dry-run under write-pause still answers");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        assertEq(anthropicCalls, 0, "b7: ZERO calls to api.anthropic.com across all write-endpoint cases");
      }

      // ═══════════════ C. the hourly job against a fake GitHub ═══════════
      {
        // Fresh eligible row for the job to write.
        seed("vp-j", { created_at: "2026-01-04 00:00:00" });
        const htmlJ = htmlA.replace("A</title>", "J</title>");
        const prevFetch2 = globalThis.fetch;
        globalThis.fetch = (async (url: any) => {
          const u = String(url);
          if (new URL(u).hostname === "vp-j.example.no" && (new URL(u).pathname === "/" || new URL(u).pathname === "")) {
            return { ok: true, status: 200, text: async () => htmlJ, arrayBuffer: async () => new TextEncoder().encode(htmlJ).buffer, headers: { get: () => null } } as unknown as Response;
          }
          return prevFetch2(url as any);
        }) as typeof fetch;

        const gh = { dirs: new Map<string, any[]>(), files: new Map<string, { sha: string; text: string }>(), calls: [] as string[] };
        const ghFetch = (async (url: any, init?: any) => {
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
        const ROOT = job.GARDSSALG_VISIT_PROPOSALS_DIR;
        const putFile = (date: string, name: string, content: unknown): string => {
          const path = `${ROOT}/${date}/${name}`;
          const text = JSON.stringify(content);
          gh.files.set(path, { sha: `sha-${name}`, text });
          const list = gh.dirs.get(`${ROOT}/${date}`) ?? [];
          gh.dirs.set(`${ROOT}/${date}`, [...list.filter((e) => e.path !== path), { name, path, type: "file", sha: `sha-${name}`, size: Buffer.byteLength(text) }]);
          if (!gh.dirs.get(ROOT)) gh.dirs.set(ROOT, []);
          if (!gh.dirs.get(ROOT)!.some((e) => e.name === date)) gh.dirs.get(ROOT)!.push({ name: date, path: `${ROOT}/${date}`, type: "dir", sha: `sha-${date}` });
          return path;
        };
        const NOW = new Date("2026-10-16T12:00:00Z");
        const env = { GARDSSALG_VISIT_PROPOSALS_JOB_ENABLED: "true", A2A_READ_PAT: "test-pat" };
        const tick = (over: Record<string, unknown> = {}) =>
          job.tickGardssalgVisitProposals({ fetchImpl: ghFetch, now: NOW, env, expDb, mainDb: () => init.getDb() as any, ...over } as any);
        const runsFor = () => (init.getDb() as any).prepare("SELECT * FROM runs WHERE agent = ? ORDER BY rowid").all(job.GARDSSALG_VISIT_PROPOSALS_AGENT) as any[];

        gh.calls.length = 0;
        const d1 = await tick({ env: { A2A_READ_PAT: "test-pat" } });
        assertEq(d1.skipped_reason, "disabled", "c1-1: flag off -> disabled");
        const d2 = await tick({ env: { GARDSSALG_VISIT_PROPOSALS_JOB_ENABLED: "true" } });
        assertEq(d2.skipped_reason, "no_token", "c1-2: no A2A_READ_PAT -> no_token");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "vp test" }, "verifier");
        const d3 = await tick();
        assertEq(d3.skipped_reason, "paused", "c1-3: write-pause -> paused");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        assertEq(gh.calls.length, 0, "c1-4: zero GitHub calls across guard skips");

        const pFile = putFile("2026-10-16", "experiences-enrichment-20261016T020000Z.json", {
          schema: job.GARDSSALG_VISIT_PROPOSALS_SCHEMA, run_id: "experiences-enrichment-2026-10-16T02:00:00Z", created_at: "2026-10-16T02:05:00Z",
          items: [
            good({ provider_id: "vp-j", source_url: "https://vp-j.example.no/" }),
            { provider_id: "vp-dead", outcome: "skip", reason: "fetch_failed" },
            good({ provider_id: "vp-unverified", source_url: "https://vp-unverified.example.no/" }),
          ],
        });
        putFile("2026-10-16", "bad-schema.json", { schema: "nope/v1", items: [] });
        anthropicCalls = 0;
        const t1 = await tick();
        assertEq(t1.skipped_reason, null, "c2-1: tick ran");
        assertEq(t1.processed.map((p) => [p.path.split("/").pop(), p.status]), [["bad-schema.json", "error"], ["experiences-enrichment-20261016T020000Z.json", "applied"]], "c2-2: both files processed (names ascending), schema error recorded, proposal applied");
        assertEq(t1.written, 1, "c2-3: one row written by the job");
        assertEq(row("vp-j").visit_text, GOOD_TEXT, "c2-4: vp-j visit_text written through the SAME apply function");
        assertEq(row("vp-dead").content_no_yield_streak, 1, "c2-5: skip item in the file -> no-yield strike on vp-dead");
        assertEq(anthropicCalls, 0, "c2-6: the job made ZERO model calls");
        const fileRow = expDb.prepare("SELECT result_json FROM gardssalg_visit_proposal_files WHERE path = ?").get(pFile) as any;
        const resultJson = JSON.parse(fileRow.result_json);
        assertEq(resultJson.totals.written, 1, "c2-7: ledger row records the file's totals");
        assertEq(resultJson.results.find((r: any) => r.provider_id === "vp-unverified")?.reason, "unverified_website", "c2-8: per-item rejection recorded in the file ledger");
        const runs = runsFor();
        assertEq(runs.length, 1, "c2-9: one envelope");
        const claims = JSON.parse(runs[0].claims);
        assertEq(claims[0].meta.kind, "gardssalg_drink_cohort_enriched", "c2-10: claim kind gardssalg_drink_cohort_enriched");
        assertEq(claims[0].meta.source, "visit_proposals_job", "c2-11: claim source visit_proposals_job");
        assertEq(claims[0].value, 1, "c2-12: claim value = written");
        assertEq(claims[1].meta.kind, "visit_proposals_processed", "c2-13: second claim visit_proposals_processed");
        assertEq(runs[0].status, "partial", "c2-14: status partial (one file errored)");

        const t2 = await tick();
        assertEq(t2.processed.length, 0, "c3-1: second tick processes nothing (each file once)");
        assertEq(runsFor().length, 1, "c3-2: no new envelope when nothing was processed");

        const st = await call("GET", "/admin/gardssalg-visit-proposals-status");
        assertEq(st.status, 200, "c4-1: status route -> 200");
        assertEq(st.body.files.length, 2, "c4-2: status lists both processed files");
        assertEq(st.body.schema, job.GARDSSALG_VISIT_PROPOSALS_SCHEMA, "c4-3: status carries schema");
        globalThis.fetch = prevFetch2;
      }
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
