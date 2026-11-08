/**
 * experience-facts-proposals.test.ts — A2A dev-request 2026-10-16-
 * opplevagent-katalogfakta-alder-og-title-no, slice S3a: the LLM-free,
 * dry-run-by-default catalogue facts write path.
 *
 *   A. GET /admin/experience-facts-candidates — only PUBLISHED, IN-SCOPE
 *      rows with an empty, unlocked fact field and a verified website; the
 *      page text the server will check against; nothing written.
 *   B. applyExperienceFactsProposals() through POST /admin/experience-facts-
 *      write — dry-run default, every per-item gate (field registry, scope,
 *      publish gate, locks, fill-only, excerpt + number checks, group
 *      ordering, languages, title_no, host match, SSRF guard, the server's
 *      own fetch), the write-pause 423, a real fill-only write with
 *      provenance, and ZERO calls to api.anthropic.com throughout.
 *
 * Conventions as in gardssalg-visit-proposals-job.test.ts (in-memory DBs,
 * router.handle(), globalThis.fetch stubbed and restored in finally).
 */
export interface TestSummary { passed: number; failed: number; failures: string[]; }

export function runExperienceFactsProposalsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "experience-facts-proposals-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-experience-facts";
    const testKey = process.env.ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./opplevelser"),
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
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const route = require("./opplevelser") as typeof import("./opplevelser");
      const router = route.default as any;

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
      provider("fa");                                         // gårdssalg cohort, verified site
      provider("fb", { producer_type: null });                // NOT in the cohort
      provider("fu", { fp: fp(false) });                      // unverified website
      provider("fm", { content_source: "manual" });           // provider owner-managed
      provider("fl", { hjemmeside: "http://127.0.0.1" });     // SSRF target

      const insertExp = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, category, title_no, min_age, group_min, group_max, age_suitability, languages,
            content_source, content_field_evidence, source_page_url, verification_status, confidence, canonical_id, created_at, updated_at)
         VALUES (@id, @provider_id, @title, @id, @category, @title_no, @min_age, @group_min, @group_max, @age_suitability, @languages,
            @content_source, @cfe, @source_page_url, @verification_status, 'high', NULL, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
      );
      const exp = (id: string, over: Record<string, unknown> = {}) => insertExp.run({
        id, provider_id: "fa", title: "Ølsmaking på garden", category: "natur_friluft", title_no: null, min_age: null,
        group_min: null, group_max: null, age_suitability: null, languages: null, content_source: null,
        cfe: JSON.stringify({ description: "https://fa.example.no/" }), source_page_url: null, verification_status: "verified", ...over,
      });
      exp("e-ok", { source_page_url: "https://fa.example.no/smaking" });
      exp("e-matdrikke", { provider_id: "fb", category: "mat_drikke" }); // in scope via category
      exp("e-out", { provider_id: "fb", category: "kultur_historie" });  // out of scope
      exp("e-unpub", { verification_status: "needs_review" });           // not published
      exp("e-locked", { content_source: "manual" });
      exp("e-claim", { content_source: "claim" });
      exp("e-provlock", { provider_id: "fm" });
      exp("e-unv", { provider_id: "fu" });
      exp("e-local", { provider_id: "fl" });
      exp("e-partial", { group_max: 10 });
      exp("e-full", { title_no: "Eksisterende tittel", min_age: 12, group_min: 2, group_max: 10, age_suitability: "all", languages: JSON.stringify(["no"]) });

      const PAGE = `<html><head><title>Smaking</title></head><body><h1>Ølsmaking på gården</h1>
        <p>Passer for voksne fra 18 år.</p><p>Grupper fra 4 til 20 personer.</p>
        <p>Omvisningen foregår på norsk og engelsk.</p><p>Vi tar imot hele familien.</p></body></html>`;
      let anthropicCalls = 0;
      const fetched: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        fetched.push(u);
        if (u.includes("api.anthropic.com")) { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "x" }] }) } as unknown as Response; }
        const host = new URL(u).hostname;
        if (host.endsWith(".example.no") && host !== "other.example.no") {
          return { ok: true, status: 200, text: async () => PAGE, arrayBuffer: async () => new TextEncoder().encode(PAGE).buffer, headers: { get: () => null } } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "", headers: { get: () => null } } as unknown as Response;
      }) as typeof fetch;

      const row = (id: string): any => expDb.prepare(
        "SELECT title_no, min_age, group_min, group_max, age_suitability, languages, content_field_evidence FROM experiences WHERE id = ?",
      ).get(id);
      const item = (id: string, field: string, value: unknown, excerpt: unknown, over: Record<string, unknown> = {}) =>
        ({ id, field, value, excerpt, source_url: "https://fa.example.no/smaking", ...over });
      const write = (items: unknown[], dryRun?: boolean) =>
        call("POST", "/admin/experience-facts-write", dryRun === undefined ? { items } : { dry_run: dryRun, items });
      const resultOf = (r: { body: any }, id: string, field: string) =>
        (r.body.results ?? []).find((x: any) => x.id === id && x.field === field);
      const reasonOf = (r: { body: any }, id: string, field: string) => {
        const x = resultOf(r, id, field);
        return x ? (x.result === "rejected" ? `rejected:${x.reason}` : x.result) : "missing";
      };

      // ═══════════════ A. candidates GET ════════════════════════════════
      {
        const before = JSON.stringify(expDb.prepare("SELECT * FROM experiences ORDER BY id").all());
        const r = await call("GET", "/admin/experience-facts-candidates?limit=25");
        assertEq(r.status, 200, "a1: candidates -> 200");
        const ids = (r.body.items ?? []).map((x: any) => x.id).sort();
        assertEq(ids, ["e-local", "e-matdrikke", "e-ok", "e-partial"], "a2: only published, in-scope, unlocked rows with a verified site and an empty field");
        assertTrue(!ids.includes("e-out"), "a3: out-of-scope row excluded");
        assertTrue(!ids.includes("e-unpub"), "a4: unpublished row excluded");
        const ok = (r.body.items ?? []).find((x: any) => x.id === "e-ok");
        assertEq(ok?.empty_fields, ["min_age", "group_min", "group_max", "age_suitability", "languages", "title_no"], "a5: all six empty fields listed");
        assertEq([ok?.title, ok?.title_no, ok?.source_url, ok?.provider_hjemmeside], ["Ølsmaking på garden", null, "https://fa.example.no/smaking", "https://fa.example.no"], "a6: title, title_no, source + provider website");
        assertTrue(ok?.fetch_ok === true && String(ok?.page_text).includes("voksne fra 18 år"), "a7: page text the server will check against");
        const partial = (r.body.items ?? []).find((x: any) => x.id === "e-partial");
        assertTrue(!partial?.empty_fields.includes("group_max") && partial?.current?.group_max === 10, "a8: stored group_max reported as current, not empty");
        const local = (r.body.items ?? []).find((x: any) => x.id === "e-local");
        assertEq([local?.fetch_ok, local?.fetch_reason], [false, "fetch_failed:ssrf_blocked"], "a9: SSRF-guarded fetch in the candidates GET");
        assertEq([typeof r.body.time_budget_ms, typeof r.body.per_row_timeout_ms, r.body.truncated], ["number", "number", false], "a10: time budget reported");
        const r2 = await call("GET", "/admin/experience-facts-candidates?limit=1");
        assertEq([r2.body.returned, r2.body.next_after_id], [1, "e-local"], "a11: limit + cursor");
        const r3 = await call("GET", "/admin/experience-facts-candidates?limit=10&after_id=e-matdrikke");
        assertEq((r3.body.items ?? []).map((x: any) => x.id), ["e-ok", "e-partial"], "a12: after_id pages through");
        assertEq(JSON.stringify(expDb.prepare("SELECT * FROM experiences ORDER BY id").all()), before, "a13: candidates GET writes nothing");
      }

      // ═══════════════ B. write endpoint ════════════════════════════════
      {
        // b1: dry run is the default.
        const d = await write([item("e-ok", "min_age", 18, "voksne fra 18 år")]);
        assertEq([d.status, d.body.dry_run, reasonOf(d, "e-ok", "min_age")], [200, true, "would_write"], "b1-1: no dry_run key -> dry run, would_write");
        assertEq(row("e-ok").min_age, null, "b1-2: dry run writes nothing");
        const d2 = await write([item("e-ok", "min_age", 18, "voksne fra 18 år")], true);
        assertEq(reasonOf(d2, "e-ok", "min_age"), "would_write", "b1-3: explicit dry_run:true -> would_write");
        const d3 = await call("POST", "/admin/experience-facts-write", { dry_run: "false", items: [item("e-ok", "min_age", 18, "voksne fra 18 år")] });
        assertEq([d3.body.dry_run, row("e-ok").min_age], [true, null], "b1-4: dry_run:\"false\" (string) is still a dry run");

        // b2: excerpt / number evidence.
        const e = await write([
          item("e-ok", "min_age", 18, undefined),
          item("e-ok", "group_min", 4, "Grupper fra 4 til 30 personer"),
          item("e-ok", "group_max", 20, "  "),
          item("e-matdrikke", "min_age", 16, "voksne fra 18 år", { source_url: "https://fb.example.no/" }),
          item("e-partial", "age_suitability", "adults", "Passer for voksne", { source_url: "https://fa.example.no/" }),
        ]);
        assertEq(reasonOf(e, "e-ok", "min_age"), "rejected:missing_excerpt", "b2-1: missing excerpt -> rejected");
        assertEq(reasonOf(e, "e-ok", "group_min"), "rejected:evidence_not_found", "b2-2: false excerpt (not on the page) -> rejected");
        assertEq(reasonOf(e, "e-ok", "group_max"), "rejected:missing_excerpt", "b2-3: blank excerpt -> rejected");
        assertEq(reasonOf(e, "e-matdrikke", "min_age"), "rejected:number_not_in_excerpt", "b2-4: number not in excerpt -> rejected");
        assertEq(reasonOf(e, "e-partial", "age_suitability"), "would_write", "b2-5: valid enum + verbatim excerpt -> would_write");

        // b3: locks, scope, publish gate, registry.
        const g = await write([
          item("e-locked", "min_age", 18, "voksne fra 18 år"),
          item("e-claim", "min_age", 18, "voksne fra 18 år"),
          item("e-provlock", "min_age", 18, "voksne fra 18 år", { source_url: "https://fm.example.no/" }),
          item("e-out", "min_age", 18, "voksne fra 18 år", { source_url: "https://fb.example.no/" }),
          item("e-unpub", "min_age", 18, "voksne fra 18 år"),
          item("e-ok", "description", "Fin tur", "voksne fra 18 år"),
          item("e-ok", "price_from", 100, "voksne fra 18 år"),
          item("e-nope", "min_age", 18, "voksne fra 18 år"),
        ], false);
        assertEq(reasonOf(g, "e-locked", "min_age"), "rejected:owner_locked", "b3-1: manual row skipped");
        assertEq(reasonOf(g, "e-claim", "min_age"), "rejected:owner_locked", "b3-2: claim row skipped");
        assertEq(reasonOf(g, "e-provlock", "min_age"), "rejected:field_owner_locked", "b3-3: provider owner lock on the field skipped");
        assertEq(reasonOf(g, "e-out", "min_age"), "rejected:out_of_scope", "b3-4: out-of-scope row -> rejected:out_of_scope");
        assertEq(reasonOf(g, "e-unpub", "min_age"), "rejected:not_published", "b3-5: unpublished row -> rejected:not_published");
        assertEq(reasonOf(g, "e-ok", "description"), "rejected:field_not_allowed", "b3-6: field not in FACT_VALIDATORS -> field_not_allowed");
        assertEq(reasonOf(g, "e-ok", "price_from"), "rejected:field_not_allowed", "b3-7: price_from not allowed either");
        assertEq(reasonOf(g, "e-nope", "min_age"), "rejected:not_found", "b3-8: unknown id -> not_found");
        assertEq([row("e-locked").min_age, row("e-out").min_age, row("e-unpub").min_age, row("e-provlock").min_age], [null, null, null, null], "b3-9: none of those rows written");
        assertEq(g.body.totals, { written: 0, would_write: 0, rejected: 8 }, "b3-10: totals");

        // b4: group checks.
        const gr = await write([
          item("e-ok", "group_min", 20, "Grupper fra 4 til 20 personer"),
          item("e-ok", "group_max", 4, "Grupper fra 4 til 20 personer"),
          item("e-partial", "group_min", 20, "Grupper fra 4 til 20 personer", { source_url: "https://fa.example.no/" }),
          item("e-matdrikke", "group_max", 25, "Grupper fra 4 til 20 personer", { source_url: "https://fb.example.no/" }),
          item("e-matdrikke", "group_min", 0, "Grupper fra 4 til 20 personer", { source_url: "https://fb.example.no/" }),
        ]);
        assertEq(reasonOf(gr, "e-ok", "group_min"), "rejected:group_min_gt_group_max", "b4-1: group_min > proposed group_max -> rejected");
        assertEq(reasonOf(gr, "e-ok", "group_max"), "rejected:group_min_gt_group_max", "b4-2: group_max < proposed group_min -> rejected");
        assertEq(reasonOf(gr, "e-partial", "group_min"), "rejected:group_min_gt_group_max", "b4-3: group_min > STORED group_max -> rejected");
        assertEq(reasonOf(gr, "e-matdrikke", "group_max"), "rejected:number_not_in_excerpt", "b4-4: group number not in excerpt -> rejected");
        assertEq(reasonOf(gr, "e-matdrikke", "group_min"), "rejected:invalid_value", "b4-5: group 0 is not a positive integer");

        // b5: languages + title_no + min_age range.
        const lt = await write([
          item("e-ok", "languages", ["no", "de"], "Omvisningen foregår på norsk og engelsk."),
          item("e-ok", "title_no", "Beer tasting at the farm", "Ølsmaking på gården"),
          item("e-matdrikke", "languages", ["xx"], "Omvisningen foregår på norsk og engelsk.", { source_url: "https://fb.example.no/" }),
          item("e-matdrikke", "title_no", "Ølsmaking på Hansens gården", "Ølsmaking på gården", { source_url: "https://fb.example.no/" }),
          item("e-partial", "title_no", "Kajakkpadling", "Ølsmaking på gården", { source_url: "https://fa.example.no/" }),
          item("e-partial", "min_age", 120, "Passer for voksne fra 18 år.", { source_url: "https://fa.example.no/" }),
        ]);
        assertEq(reasonOf(lt, "e-ok", "languages"), "rejected:language_not_in_excerpt", "b5-1: a language the excerpt never names -> rejected");
        assertEq(reasonOf(lt, "e-ok", "title_no"), "rejected:not_norwegian", "b5-2: English title_no -> rejected");
        assertEq(reasonOf(lt, "e-matdrikke", "languages"), "rejected:language_not_allowed", "b5-3: code outside the allow-list -> rejected");
        assertEq(reasonOf(lt, "e-matdrikke", "title_no"), "rejected:new_proper_noun", "b5-4: new proper noun -> rejected");
        assertTrue(String(reasonOf(lt, "e-partial", "title_no")).startsWith("rejected:title_not_similar:"), "b5-5: dissimilar title_no -> rejected");
        assertEq(reasonOf(lt, "e-partial", "min_age"), "rejected:invalid_value", "b5-6: min_age outside 0–99 -> rejected");

        // b6: source gates + SSRF.
        const fetchedBefore = fetched.length;
        const sg = await write([
          item("e-ok", "min_age", 18, "voksne fra 18 år", { source_url: "https://other.example.no/" }),
          item("e-unv", "min_age", 18, "voksne fra 18 år", { source_url: "https://fu.example.no/" }),
          item("e-local", "min_age", 18, "voksne fra 18 år", { source_url: "http://127.0.0.1/" }),
          item("e-partial", "min_age", 18, "voksne fra 18 år", { source_url: undefined }),
        ]);
        assertEq(reasonOf(sg, "e-ok", "min_age"), "rejected:source_host_mismatch", "b6-1: source on another host -> rejected");
        assertEq(reasonOf(sg, "e-unv", "min_age"), "rejected:unverified_website", "b6-2: unverified provider website -> rejected");
        assertEq(reasonOf(sg, "e-local", "min_age"), "rejected:fetch_failed:ssrf_blocked", "b6-3: SSRF guard blocks a private address");
        assertEq(reasonOf(sg, "e-partial", "min_age"), "rejected:missing_source_url", "b6-4: missing source_url -> rejected");
        assertTrue(!fetched.slice(fetchedBefore).some((u) => u.includes("127.0.0.1") || u.includes("other.example.no")), "b6-5: blocked / mismatched URLs never fetched");

        // b7: structural bounds -> 400.
        const s1 = await write([]);
        assertEq(s1.status, 400, "b7-1: empty items -> 400");
        const s2 = await write(Array.from({ length: 26 }, (_, i) => item(`e-x${i}`, "min_age", 18, "voksne fra 18 år")));
        assertEq(s2.status, 400, "b7-2: 26 items -> 400 (cap 25)");
        const s3 = await write([item("e-ok", "min_age", 18, "voksne fra 18 år"), item("e-ok", "min_age", 18, "voksne fra 18 år")]);
        assertEq(s3.status, 400, "b7-3: duplicate (id, field) -> 400");
        const s4 = await write(Array.from({ length: 11 }, (_, i) => item(`e-x${i}`, "min_age", 18, "voksne fra 18 år", { source_url: `https://fa.example.no/p${i}` })));
        assertEq(s4.status, 400, "b7-4: more than 10 distinct source URLs -> 400");
        const s5 = await write([{ id: "e-ok", value: 18 }]);
        assertEq(s5.status, 400, "b7-5: item without field -> 400");

        // b8: write-pause.
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: true, reason: "facts test" }, "verifier");
        const p1 = await write([item("e-ok", "min_age", 18, "voksne fra 18 år")], false);
        assertEq(p1.status, 423, "b8-1: apply under write-pause -> 423");
        assertEq(row("e-ok").min_age, null, "b8-2: nothing written under the pause");
        const p2 = await write([item("e-ok", "min_age", 18, "voksne fra 18 år")]);
        assertEq([p2.status, reasonOf(p2, "e-ok", "min_age")], [200, "would_write"], "b8-3: dry run still answers under the pause (same as the visit lane)");
        pauseSvc.setEnrichmentWritePause(init.getDb() as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");

        // b9: a real write fills ONLY empty fields.
        const w = await write([
          item("e-ok", "min_age", 18, "voksne fra 18 år"),
          item("e-ok", "group_min", 4, "Grupper fra 4 til 20 personer"),
          item("e-ok", "group_max", 20, "Grupper fra 4 til 20 personer"),
          item("e-ok", "age_suitability", "adults", "Passer for voksne fra 18 år."),
          item("e-ok", "languages", ["no", "EN"], "Omvisningen foregår på norsk og engelsk."),
          item("e-ok", "title_no", "Ølsmaking på gården", "Ølsmaking på gården"),
          item("e-full", "min_age", 18, "voksne fra 18 år", { source_url: "https://fa.example.no/" }),
          item("e-full", "title_no", "Ølsmaking på gården", "Ølsmaking på gården", { source_url: "https://fa.example.no/" }),
          item("e-partial", "group_min", 4, "Grupper fra 4 til 20 personer", { source_url: "https://fa.example.no/" }),
          item("e-partial", "group_max", 20, "Grupper fra 4 til 20 personer", { source_url: "https://fa.example.no/" }),
        ], false);
        assertEq(w.status, 200, "b9-1: apply -> 200");
        assertEq(w.body.totals, { written: 7, would_write: 0, rejected: 3 }, "b9-2: totals");
        const ok = row("e-ok");
        assertEq([ok.min_age, ok.group_min, ok.group_max, ok.age_suitability, ok.languages, ok.title_no],
          [18, 4, 20, "adults", JSON.stringify(["no", "en"]), "Ølsmaking på gården"], "b9-3: all six empty fields written");
        const ev = JSON.parse(ok.content_field_evidence);
        assertEq([ev.min_age, ev.title_no, ev.description], ["https://fa.example.no/smaking", "https://fa.example.no/smaking", "https://fa.example.no/"], "b9-4: per-field provenance recorded, prior entries kept");
        assertEq([reasonOf(w, "e-full", "min_age"), reasonOf(w, "e-full", "title_no")], ["rejected:field_not_empty", "rejected:field_not_empty"], "b9-5: existing values -> field_not_empty");
        const full = row("e-full");
        assertEq([full.min_age, full.title_no, full.content_field_evidence], [12, "Eksisterende tittel", JSON.stringify({ description: "https://fa.example.no/" })], "b9-6: existing values left untouched");
        assertEq([reasonOf(w, "e-partial", "group_min"), reasonOf(w, "e-partial", "group_max"), row("e-partial").group_min, row("e-partial").group_max],
          ["written", "rejected:field_not_empty", 4, 10], "b9-7: partial row: empty group_min filled (≤ stored max), stored group_max kept");
        const again = await write([item("e-ok", "min_age", 18, "voksne fra 18 år")], false);
        assertEq(reasonOf(again, "e-ok", "min_age"), "rejected:field_not_empty", "b9-8: re-run never overwrites");

        // b10: no LLM anywhere.
        assertEq(anthropicCalls, 0, "b10: ZERO calls to api.anthropic.com across the candidates GET and every write");
        assertTrue(!fetched.some((u) => u.includes("anthropic")), "b10-2: no request to any anthropic host");
      }

      // ═══════════════ C. registry shape ════════════════════════════════
      assertEq(Object.keys(route.FACT_VALIDATORS).sort(), ["age_suitability", "group_max", "group_min", "languages", "min_age", "title_no"], "c1: exactly the six allowed fields");
      assertEq(route.EXPERIENCE_FACTS_TITLE_NO_MIN_SIMILARITY, 0.6, "c2: title_no similarity threshold is a named constant");
      // c3/c4: languages — only "no" for Norwegian, and whole-word language names.
      {
        const lang = route.FACT_VALIDATORS.languages;
        const ctxOf = (excerpt: string) => ({ excerpt } as unknown as Parameters<typeof lang.validate>[1]);
        assertTrue(!Object.prototype.hasOwnProperty.call(route.EXPERIENCE_FACTS_LANGUAGE_NAMES, "nb"), "c3-1: nb is not an allowed code (catalogue uses no)");
        assertTrue(!Object.prototype.hasOwnProperty.call(route.EXPERIENCE_FACTS_LANGUAGE_NAMES, "nn"), "c3-2: nn is not an allowed code (catalogue uses no)");
        assertEq(lang.validate(["nb"], ctxOf("Omvisningen foregår på norsk")), { ok: false, reason: "language_not_allowed" }, "c3-3: [nb] rejected");
        assertEq(lang.validate(["no"], ctxOf("Omvisningen foregår på bokmål")), { ok: true, stored: JSON.stringify(["no"]) }, "c3-4: bokmål evidence stores no");
        assertEq(lang.validate(["de"], ctxOf("Gjester fra Tyskland er velkomne")), { ok: false, reason: "language_not_in_excerpt" }, "c4-1: Tyskland does not name German");
        assertEq(lang.validate(["no"], ctxOf("Gården ligger langs norskekysten")), { ok: false, reason: "language_not_in_excerpt" }, "c4-2: norskekysten does not name Norwegian");
        assertEq(lang.validate(["en"], ctxOf("En engelskmann startet bryggeriet")), { ok: false, reason: "language_not_in_excerpt" }, "c4-3: engelskmann does not name English");
        assertEq(lang.validate(["no", "en"], ctxOf("Guidede turer på norske og engelske.")), { ok: true, stored: JSON.stringify(["no", "en"]) }, "c4-4: inflected -e form still counts");
        assertEq(lang.validate(["de"], ctxOf("Vi snakker tysk.")), { ok: true, stored: JSON.stringify(["de"]) }, "c4-5: word before punctuation counts");
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

if (require.main === module) {
  runExperienceFactsProposalsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed === 0 ? 0 : 1);
  });
}
