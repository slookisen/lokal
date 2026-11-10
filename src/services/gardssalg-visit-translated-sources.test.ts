/**
 * gardssalg-visit-translated-sources.test.ts — A2A dev-request
 * 2026-10-25-besokstekst-oversettelse-ikke-norske-kilder: «4b-forslag» rows
 * whose own homepage is NOT Norwegian get a bokmål visit_text through
 * applyGardssalgVisitProposals() with deterministic anchoring instead of the
 * word-overlap gate (a translation shares no words with its source).
 *
 *   U. gardssalgVisitSourceLooksNorwegian() — English true-negative, bokmål,
 *      nynorsk, short/mixed text (any doubt → Norwegian).
 *   T. The write endpoint over an English source: written with
 *      source_language "other" + totals.written_translated; the three
 *      translated_* rejections; nynorsk source still on the overlap gate;
 *      kill switch GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED=true → English
 *      source falls on low_source_overlap; candidates GET `rules` fields;
 *      ZERO calls to api.anthropic.com.
 *
 * Harness as in gardssalg-visit-proposals-job.test.ts (in-memory DBs,
 * router.handle(), globalThis.fetch stubbed for the server's own crawl).
 */
export interface TestSummary { passed: number; failed: number; failures: string[]; }

export function runGardssalgVisitTranslatedSourcesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevKill = process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED;
    const prevFetch = globalThis.fetch;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "gardssalg-visit-translated-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-visit-translated";
    delete process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED;
    const testKey = process.env.ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../routes/opplevelser"),
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
      const route = require("../routes/opplevelser") as typeof import("../routes/opplevelser");
      const router = route.default as any;
      const looksNo = route.gardssalgVisitSourceLooksNorwegian;

      // ═══════════════ U. language heuristic (pure) ═════════════════════
      const EN_PAGE = "Welcome to our cidery on the farm. We are open for visitors every Saturday from 12:00 to 16:00 from May to September, and you can taste our ciders in the old barn. The farm shop sells bottles and gift cards. Guided tours are available for groups of 10 or more.";
      const NB_PAGE = "Velkommen til gården vår. Vi har åpent i gårdsbutikken hver lørdag, og det er mulig å smake på eplemosten. Besøk oss gjerne med hele familien, men ring på forhånd om dere er en større gruppe.";
      const NN_PAGE = "Gardsbutikken vår er ope kvar laurdag frå mai til august. Me tek imot besøk av grupper, men dei må ringje på førehand. Eg viser gjerne rundt i sideriet, men det er ikkje servering på garden. Kva me har på lager står på tavla.";
      assertEq(looksNo(EN_PAGE), false, "u1: English farm page -> not Norwegian");
      assertEq(looksNo(NB_PAGE), true, "u2: bokmål farm page -> Norwegian");
      assertEq(looksNo(NN_PAGE), true, "u3: nynorsk farm page (ikkje/eg/dei/ope/me/kva) -> Norwegian");
      assertEq(looksNo(NN_PAGE.toUpperCase()), true, "u4: case-insensitive, æøå tokenised (upper-case nynorsk still Norwegian)");
      assertEq(looksNo("Welcome to our farm shop."), true, "u5: short English text (< 5 English hits) -> doubt -> Norwegian");
      assertEq(looksNo(""), true, "u6: empty text -> Norwegian (strict gate)");
      assertEq(looksNo(NB_PAGE + " " + "Welcome! We are open on the weekend and you can visit our shop with the family."), true,
        "u7: mixed page where English is not ≥ 2× the Norwegian hits -> Norwegian");
      assertEq(looksNo(NN_PAGE + " " + EN_PAGE + " " + EN_PAGE + " " + EN_PAGE), false,
        "u8: page dominated by English (≥ 2× Norwegian hits) -> not Norwegian");

      // ═══════════════ T. write endpoint ════════════════════════════════
      const call = (method: "GET" | "POST", url: string, body?: any): Promise<{ status: number; body: any }> =>
        new Promise((resolve) => {
          const q: Record<string, string> = {};
          const qi = url.indexOf("?");
          if (qi >= 0) for (const [k, v] of new URLSearchParams(url.slice(qi + 1))) q[k] = v;
          const req: any = { method, url, originalUrl: url, path: url.split("?")[0], query: q, headers: { "x-admin-key": testKey }, body: body ?? {}, get() { return undefined; } };
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, body: p }); return this; } };
          router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
        });

      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            field_provenance, producer_type, last_content_attempt_at, content_no_yield_streak, created_at,
            enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @hjemmeside, NULL, @about_text, NULL, NULL, @products,
            @fp, 'sideri', NULL, 0, '2026-01-01 00:00:00', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const FP = JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" } });
      const ABOUT = "Sideriet ligger på gården ved fjorden og har laget sider av egne epler siden 2012, med fokus på håndverk.";
      const seed = (id: string): void => insert.run({ id, navn: `Navn ${id}`, hjemmeside: `https://${id}.example.no`, about_text: ABOUT, products: JSON.stringify(["Sider"]), fp: FP });
      for (const id of ["vt-en-1", "vt-en-2", "vt-en-3", "vt-en-4", "vt-en-5", "vt-en-6", "vt-en-7", "vt-nn-1", "vt-nn-2"]) seed(id);

      let anthropicCalls = 0;
      const wrap = (body: string) => `<html><head><title>T</title></head><body><p>${body}</p></body></html>`;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("api.anthropic.com")) { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "AVVIS" }] }) } as unknown as Response; }
        const parsed = new URL(u);
        const host = parsed.hostname;
        const html = host.startsWith("vt-en-") ? wrap(EN_PAGE) : host.startsWith("vt-nn-") ? wrap(NN_PAGE) : null;
        if (html && (parsed.pathname === "/" || parsed.pathname === "")) {
          return { ok: true, status: 200, text: async () => html, arrayBuffer: async () => new TextEncoder().encode(html).buffer, headers: { get: () => null } } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;
      const row = (id: string): any => expDb.prepare("SELECT visit_text, content_no_yield_streak FROM experience_providers WHERE id = ?").get(id);

      const TR_TEXT = "Sideriet tar imot besøkende hver lørdag fra 12:00 til 16:00 fra mai til september, med smaking av sider i den gamle låven. Omvisning for grupper på 10 eller flere.";
      const TR_SNIPPETS = [
        "We are open for visitors every Saturday from 12:00 to 16:00 from May to September",
        "Guided tours are available for groups of 10 or more",
      ];
      const item = (id: string, over: Record<string, unknown> = {}) => ({
        provider_id: id, outcome: "write", visit_text: TR_TEXT, source_url: `https://${id}.example.no/`,
        evidence_snippets: TR_SNIPPETS,
        judge: { approved: true, model: "claude-code-judge-subagent", reasoning: "Trofast oversettelse." }, ...over,
      });
      const post = (items: unknown[], dryRun: boolean) => call("POST", "/admin/gardssalg-visit-proposals-write", dryRun ? { items } : { dry_run: false, items });

      // t0: candidates GET rules carry the new fields (feature on by default).
      {
        const g = await call("GET", "/admin/gardssalg-visit-candidates?limit=1");
        assertEq(g.status, 200, "t0-1: candidates GET -> 200");
        assertEq(g.body.rules.translated_sources_enabled, true, "t0-2: rules.translated_sources_enabled true by default");
        assertEq(g.body.rules.translated_min_snippets, 2, "t0-3: rules.translated_min_snippets 2");
        assertEq(g.body.rules.word_overlap_min, 0.6, "t0-4: word_overlap_min unchanged");
        assertTrue(g.body.rules.generator_prompt.includes("{{KILDETEKST}}") && g.body.rules.generator_prompt.includes("{{NAVN}}") &&
          g.body.rules.generator_prompt.includes("Er kildeteksten på et annet språk enn norsk, oversett trofast til bokmål uten å legge til noe; utdragene skal fortsatt være ordrette fra kildeteksten på kildespråket."),
          "t0-5: generator prompt keeps placeholders and carries the translation rule");
        assertTrue(g.body.rules.judge_prompt.includes("{{KANDIDATTEKST}}") && g.body.rules.judge_prompt.includes("{{KILDETEKST}}") &&
          g.body.rules.judge_prompt.includes("Kildeteksten kan være på et annet språk. GODKJENN en oversettelse bare når hver opplysning finnes i kilden; tall, klokkeslett og dager må være identiske."),
          "t0-6: judge prompt keeps placeholders and carries the translation rule");
      }

      // t1: English source + bokmål translation whose numbers/days are in ≥ 2 snippets.
      {
        const d = await post([item("vt-en-1")], true);
        assertEq([d.body.results[0].result, d.body.results[0].source_language], ["would_write", "other"], "t1-1: dry-run -> would_write, source_language other");
        assertEq(d.body.totals.written_translated, 0, "t1-2: dry-run writes nothing -> written_translated 0");
        assertEq(row("vt-en-1").visit_text, null, "t1-3: nothing stored on dry-run");
        const w = await post([item("vt-en-1")], false);
        assertEq(w.body.results[0], { provider_id: "vt-en-1", result: "written", source_language: "other" }, "t1-4: apply -> written, source_language other");
        assertEq([w.body.totals.written, w.body.totals.written_translated], [1, 1], "t1-5: totals.written 1, written_translated 1");
        assertEq(row("vt-en-1").visit_text, TR_TEXT, "t1-6: bokmål translation stored");
        assertEq(row("vt-en-1").content_no_yield_streak, 0, "t1-7: no-yield streak reset");
      }

      // t2..t4: the three translated_* rejections.
      {
        const cases: Array<[string, Record<string, unknown>, string]> = [
          ["translated_evidence_too_few", { evidence_snippets: [TR_SNIPPETS[0]] }, "only 1 snippet"],
          ["translated_numbers_not_in_evidence", { visit_text: TR_TEXT.replace("16:00", "18:00") }, "closing time not in the snippets"],
          ["translated_numbers_not_in_evidence", { visit_text: TR_TEXT.replace("grupper på 10", "grupper på 1") }, "«1» is not satisfied by «10»"],
          ["translated_days_not_in_evidence", { visit_text: TR_TEXT.replace("hver lørdag", "hver lørdag og søndag") }, "Sunday not in the snippets"],
          ["translated_days_not_in_evidence", { visit_text: TR_TEXT.replace("fra mai", "fra juni") }, "June not in the snippets"],
        ];
        let i = 0;
        for (const [reason, over, label] of cases) {
          i++;
          const r = await post([item("vt-en-2", over)], false);
          assertEq([r.body.results[0].result, r.body.results[0].reason, r.body.results[0].source_language], ["rejected", reason, "other"], `t2-${i}: ${label} -> ${reason}`);
          assertEq(r.body.totals.written_translated, 0, `t2-${i}b: written_translated 0 on rejection`);
        }
        assertEq(row("vt-en-2").visit_text, null, "t2-z: nothing written after the translated_* rejections");
        // Inflected weekday (lørdagene) and the same time in another separator style still pass.
        const inf = await post([item("vt-en-3", { visit_text: TR_TEXT.replace("hver lørdag fra 12:00 til 16:00", "på lørdagene fra 12.00 til 16.00") })], true);
        assertEq([inf.body.results[0].result, inf.body.results[0].source_language], ["would_write", "other"], "t2-inf: «lørdagene» + «12.00» normalised -> would_write");
        // The usual gates before the language decision are unchanged (no source_language there).
        const nf = await post([item("vt-en-4", { evidence_snippets: ["Dette står ikke på siden i det hele tatt.", TR_SNIPPETS[1]] })], false);
        assertEq(nf.body.results[0], { provider_id: "vt-en-4", result: "rejected", reason: "evidence_not_found" }, "t2-ev: evidence_not_found still first, row shape unchanged");
      }

      // t5: nynorsk source -> the word-overlap gate as before.
      {
        const NN_SNIPPETS = ["Gardsbutikken vår er ope kvar laurdag frå mai til august", "Eg viser gjerne rundt i sideriet"];
        const good = await post([{ ...item("vt-nn-1"), visit_text: "Gardsbutikken er ope kvar laurdag frå mai til august, og grupper kan komme på besøk i sideriet.", evidence_snippets: NN_SNIPPETS }], false);
        assertEq(good.body.results[0], { provider_id: "vt-nn-1", result: "written", source_language: "nb" }, "t5-1: nynorsk source + overlapping text -> written, source_language nb");
        assertEq(good.body.totals.written_translated, 0, "t5-2: a Norwegian-source write is not counted as translated");
        const lo = await post([{ ...item("vt-nn-2"), visit_text: "Produsenten arrangerer internasjonale festivaler med kjendiskokker og fyrverkeri hver eneste kveld gjennom hele sommeren.", evidence_snippets: NN_SNIPPETS }], false);
        assertTrue(String(lo.body.results[0].reason).startsWith("low_source_overlap:"), `t5-3: nynorsk source + non-overlapping text -> low_source_overlap (got ${lo.body.results[0].reason})`);
        assertEq(lo.body.results[0].source_language, "nb", "t5-4: nynorsk classified nb");
      }

      // t6: kill switch on -> English source falls on low_source_overlap.
      {
        process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED = "true";
        try {
          const r = await post([item("vt-en-5")], false);
          assertTrue(r.body.results[0].result === "rejected" && String(r.body.results[0].reason).startsWith("low_source_overlap:"),
            `t6-1: kill switch -> English source rejected low_source_overlap (got ${r.body.results[0].result}/${r.body.results[0].reason})`);
          assertEq(r.body.results[0].source_language, "nb", "t6-2: kill switch -> every source takes the nb (overlap) path");
          assertEq(r.body.totals.written_translated, 0, "t6-3: written_translated 0 under the kill switch");
          assertEq(row("vt-en-5").visit_text, null, "t6-4: nothing written under the kill switch");
          const g = await call("GET", "/admin/gardssalg-visit-candidates?limit=1");
          assertEq(g.body.rules.translated_sources_enabled, false, "t6-5: rules.translated_sources_enabled reflects the kill switch");
        } finally {
          delete process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED;
        }
        const back = await post([item("vt-en-5")], true);
        assertEq(back.body.results[0].result, "would_write", "t6-6: switch read at call time — off again -> translated path back");
      }

      // t7: a skip item's result row keeps its old shape (no source_language).
      {
        const sk = await post([{ provider_id: "vt-en-6", outcome: "skip", reason: "not_norwegian" }], true);
        assertEq(sk.body.results[0], { provider_id: "vt-en-6", result: "would_record_skip", reason: "not_norwegian" }, "t7: skip row shape unchanged");
      }

      assertEq(anthropicCalls, 0, "t8: ZERO calls to api.anthropic.com");
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevKill === undefined) delete process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED; else process.env.GARDSSALG_VISIT_TRANSLATED_SOURCES_DISABLED = prevKill;
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
  runGardssalgVisitTranslatedSourcesTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed ? 1 : 0);
  });
}
