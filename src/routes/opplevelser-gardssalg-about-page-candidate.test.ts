/**
 * opplevelser-gardssalg-about-page-candidate.test.ts — gårdssalg half of
 * dev-request 2026-10-27-rfb-berikelse-om-oss-sider-til-beskrivelse (AC1):
 * experience_providers.about_text may come from the producer's «Om oss»
 * page, behind ENRICHMENT_ABOUT_PAGE_ENABLED (default OFF), with a
 * dry-run-only `about_page_preview` (spec 6).
 *
 * Same conventions as opplevelser-gardssalg-owner-lock-content-refresh.test.ts:
 * EXPERIENCES_DB_PATH=":memory:", fresh module copies of db-factory +
 * experience-store + opplevelser, the main DB pinned in memory (the apply
 * path's write-pause gate reads it), globalThis.fetch stubbed for the
 * producer sites AND the judge, everything restored in finally (runSerial in
 * tests/test.ts). GARDSSALG_VISIT_LLM_ENABLED=false keeps the unrelated
 * visit generator out of the way; products are pre-filled so the products
 * generator is never called.
 *
 * Covers:
 *   (A) flag OFF: «Om oss» is crowded out by four contact links, the homepage
 *       candidate is the one judged and written, no about_* keys;
 *   (B) dry-run preview: «Om oss» gets a sub-page slot (still four), its
 *       candidate is chosen with the about page as source_url, reported next
 *       to the homepage candidate; nothing written;
 *   (C) llm:false: the about-page candidate is reported, judge_required, no
 *       model call at all;
 *   (D) the judge rejects the about-page text -> the homepage candidate is
 *       judged as before;
 *   (E) flag ON + apply: about_text, field_provenance and the audit row carry
 *       the about page; content_evidence_url stays the homepage;
 *   (F) preview with apply: ignored;
 *   (G) manual (locked) row: no fetch at all;
 *   (H) owner-locked about_text: reported, not written;
 *   (I) code-artifact about page -> homepage candidate;
 *   (J) fallback list: /om-oss ahead of the visit paths only for a row that
 *       needs a description; otherwise the same fetches as today;
 *   (K) the pure ordering/need helpers;
 *   (L) the route: about_page_preview honoured in a dry run, ignored with
 *       apply (body or ?apply=1); not reported as ignored when the env flag
 *       runs the logic anyway;
 *   (M) a deep-path homepage: the host's root /about never takes the slot
 *       from the producer's own in-section «Om oss»;
 *   (N) a village «Historie» page: not about the producer -> never judged;
 *   (O) about_page_in_content_text reflects the LLM's 6000-char window;
 *   (P) flag ON without an about page: same response and DB row as flag OFF.
 */

import { ENRICHMENT_ABOUT_PAGE_FLAG } from "../services/about-page-candidate";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HOME_META = "Gårdsbruket i Hallingdal selger lammekjøtt og spekemat fra egne dyr rett fra gården.";
const P1 =
  "Tverås er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.";
const P2 =
  "Kjøttet foredler vi selv i vårt eget slakteri og pølsemakeri på gården, og vi selger spekemat, pølser og ferskt lammekjøtt direkte til kundene våre.";
const P3 =
  "Du finner oss på REKO-ringen i Gol og på bondens marked i Oslo, og vi tar gjerne imot bestillinger til selskap og høytider.";
const ABOUT_TEXT = `${P1} ${P2} ${P3}`;
const HELIOS_CODE =
  'Grønn Guide Trondheim Static = window.Static || {}; Static.SQUARESPACE_CONTEXT = {"betaFeatureFlags":["supports_versioned_template_assets",' +
  '"campaigns_merch_state","marketing_landing_page","enable_form_submission_trigger","campaigns_table_v2","contacts_and_campaigns_redesign",' +
  '"marketing_automations"]}; Vi er en gård i Trondheim.';

const NAV_4_CONTACT_1_ABOUT =
  `<nav><a href="/kontakt">Kontakt</a><a href="/kontakt-oss">Kontakt oss</a><a href="/contact">Contact</a>` +
  `<a href="/kontaktinfo">Kontaktinfo</a><a href="/om-oss">Om oss</a></nav>`;

function homepage(nav: string): string {
  return `<html><head><title>Gård</title><meta name="description" content="${HOME_META}"></head><body>${nav}<p>Velkommen!</p></body></html>`;
}
function aboutPage(body: string, h1 = "Om oss"): string {
  return `<html><head><title>Om oss</title></head><body><header><nav><a href="/">Hjem</a></nav></header><main><h1>${h1}</h1>${body}</main></body></html>`;
}
const VILLAGE_P1 =
  "Gol er en bygd i Hallingdal med lange tradisjoner for jordbruk og husdyrhold. Stavkirken herfra står i dag på Bygdøy i Oslo.";
const VILLAGE_P2 =
  "Bygda vokste fram rundt jernbanen på begynnelsen av nittenhundretallet, og mange gamle gardsbygninger står fortsatt på hver side av elva.";
// ~7000 chars of visible homepage text: anything after it in contentText is
// beyond what the LLM rewrite/fill read (GARDSSALG_REWRITE_SOURCE_CHAR_CAP).
const BIG_FILLER = "Her kommer en lang tekst om ingenting spesielt som fyller opp siden. ".repeat(105);
const CONTACT_PAGE = "<html><body><p>Ring oss på telefon.</p></body></html>";

/** The site a test host serves, by host prefix. Anything not listed is a 404. */
function siteFor(host: string): Record<string, string> {
  if (host.startsWith("gs-om")) {
    return {
      "/": homepage(NAV_4_CONTACT_1_ABOUT),
      "/kontakt": CONTACT_PAGE,
      "/kontakt-oss": CONTACT_PAGE,
      "/contact": CONTACT_PAGE,
      "/kontaktinfo": CONTACT_PAGE,
      "/om-oss": aboutPage(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`),
    };
  }
  if (host.startsWith("gs-code")) {
    return { "/": homepage(NAV_4_CONTACT_1_ABOUT), "/om-oss": aboutPage(`<p>${HELIOS_CODE}</p>`) };
  }
  if (host.startsWith("gs-fb") || host.startsWith("gs-good")) {
    return { "/": homepage(""), "/om-oss": aboutPage(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`) };
  }
  if (host.startsWith("gs-deep")) {
    // Review finding 1, the repro: four contact links inside the producer's
    // section, the host's root /about and the producer's own
    // /medlem/gard-x/om-oss (the hanen.no shape; hanen.no itself is on the
    // shared-domain list and never fetched, so a test host is used).
    const nav =
      `<nav><a href="/medlem/gard-x/kontakt">Kontakt</a><a href="/medlem/gard-x/kontakt-oss">Kontakt oss</a>` +
      `<a href="/medlem/gard-x/contact">Contact</a><a href="/medlem/gard-x/kontaktinfo">Kontaktinfo</a>` +
      `<a href="/about">About</a><a href="/medlem/gard-x/om-oss">Om oss</a></nav>`;
    return {
      "/medlem/gard-x": homepage(nav),
      "/medlem/gard-x/kontakt": CONTACT_PAGE,
      "/medlem/gard-x/kontakt-oss": CONTACT_PAGE,
      "/medlem/gard-x/contact": CONTACT_PAGE,
      "/medlem/gard-x/kontaktinfo": CONTACT_PAGE,
      "/about": aboutPage(
        "<p>Fellessiden er en portal for lokale matprodusenter i hele landet, med over tusen medlemsbedrifter og egne sider for hver av dem.</p>",
      ),
      "/medlem/gard-x/om-oss": aboutPage(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`),
    };
  }
  if (host.startsWith("gs-hist")) {
    return {
      "/": homepage(`<nav><a href="/historie">Historie</a></nav>`),
      "/historie": aboutPage(`<p>${VILLAGE_P1}</p><p>${VILLAGE_P2}</p>`, "Historien om Gol"),
    };
  }
  if (host.startsWith("gs-big")) {
    return {
      "/": homepage(`<nav><a href="/om-oss">Om oss</a></nav><div>${BIG_FILLER}</div>`),
      "/om-oss": aboutPage(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`),
    };
  }
  if (host.startsWith("gs-none")) {
    return {
      "/": homepage(`<nav><a href="/kontakt">Kontakt</a><a href="/produkter">Produkter</a></nav>`),
      "/kontakt": CONTACT_PAGE,
      "/produkter": "<html><body><p>Lammekjøtt, pølser og spekemat fra egne dyr.</p></body></html>",
    };
  }
  return {};
}

function callRoute(router: any, body: any, query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const url = "/admin/gardssalg-content-refresh";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query,
      headers: { "x-admin-key": process.env.ADMIN_KEY ?? "" },
      body,
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

export function runOpplevelserGardssalgAboutPageCandidateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  let restoreMainDb: (() => void) | null = null;

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
    const prev = {
      exp: process.env.EXPERIENCES_DB_PATH,
      admin: process.env.ADMIN_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      flag: process.env[ENRICHMENT_ABOUT_PAGE_FLAG],
      visitLlm: process.env.GARDSSALG_VISIT_LLM_ENABLED,
      fetch: globalThis.fetch,
    };
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = prev.admin || "gardssalg-about-page-test-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-about-page";
    process.env.GARDSSALG_VISIT_LLM_ENABLED = "false";
    delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opp = require("./opplevelser") as typeof import("./opplevelser");
      const router = opp.default as any;

      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, NULL, NULL, '["Lammekjøtt"]', @field_provenance,
            'gardsbutikk', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      function prov(extra?: Record<string, unknown>): string {
        return JSON.stringify({
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
          ...extra,
        });
      }
      function add(id: string, o: { about?: string | null; content_source?: string | null; prov?: string; path?: string } = {}): void {
        insert.run({
          id,
          navn: "Tverås Gårdsmat",
          hjemmeside: `https://${id}.example.no${o.path ?? ""}`,
          content_source: o.content_source ?? null,
          about_text: o.about ?? null,
          field_provenance: o.prov ?? prov(),
        });
      }
      const GOOD_ABOUT = "Gården driver med økologisk dyrking av grønnsaker og bær, og har holdt på med det i mer enn tretti år nå.";
      for (const id of ["gs-om-a", "gs-om-b", "gs-om-c", "gs-om-d", "gs-om-e", "gs-om-f", "gs-om-l1", "gs-om-l2", "gs-code", "gs-fb-1", "gs-fb-2"]) add(id);
      add("gs-good-1", { about: GOOD_ABOUT });
      add("gs-good-2", { about: GOOD_ABOUT });
      add("gs-om-manual", { content_source: "manual", about: "Håndskrevet." });
      add("gs-om-lock", { content_source: "claim", prov: prov({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }) });
      add("gs-deep-off", { path: "/medlem/gard-x" });
      add("gs-deep-on", { path: "/medlem/gard-x" });
      for (const id of ["gs-hist", "gs-big", "gs-none-dry", "gs-none-a", "gs-none-b", "gs-om-l4", "gs-om-l5"]) add(id);

      // ── fetch stub: producer sites + the judge ────────────────────────────
      const fetchLog: string[] = [];
      let llmCalls = 0;
      const judgePrompts: string[] = [];
      let rejectJudgeIfIncludes: string | null = null;
      globalThis.fetch = (async (input: any, init?: any) => {
        const urlStr = String(input instanceof Request ? input.url : input);
        if (urlStr.includes("api.anthropic.com")) {
          llmCalls++;
          let prompt = "";
          try {
            prompt = String(JSON.parse(String(init?.body ?? "{}"))?.messages?.[0]?.content ?? "");
          } catch {
            /* not JSON */
          }
          const isJudge = prompt.startsWith("Du er en kvalitetsdommer");
          if (isJudge) judgePrompts.push(prompt);
          const text = isJudge
            ? rejectJudgeIfIncludes && prompt.includes(rejectJudgeIfIncludes)
              ? "AVVIS\nTesten avviser denne teksten."
              : "GODKJENN\nRen, konkret prosa om produsenten."
            : "INGEN_UTVIDELSE_MULIG";
          return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const u = new URL(urlStr);
        fetchLog.push(u.toString());
        const html = siteFor(u.host)[u.pathname || "/"];
        if (html === undefined) return new Response("<html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }) as typeof fetch;

      const fetchedFor = (id: string) => fetchLog.filter((u) => u.startsWith(`https://${id}.example.no`)).map((u) => new URL(u).pathname);
      async function run(ids: string[], o: { apply?: boolean; preview?: boolean; flag?: boolean; llm?: boolean } = {}) {
        if (o.flag) process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "true";
        else delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        try {
          return await opp.runGardssalgContentRefresh({
            apply: o.apply === true,
            providerIds: ids,
            llm: o.llm !== false,
            ...(o.preview ? { aboutPagePreview: true } : {}),
          });
        } finally {
          delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        }
      }
      const rowOf = (id: string) =>
        expDb.prepare("SELECT about_text, field_provenance, content_evidence_url FROM experience_providers WHERE id = ?").get(id) as any;
      const ABOUT_URL = (id: string) => `https://${id}.example.no/om-oss`;
      const HOME_URL = (id: string) => `https://${id}.example.no`;

      // ── (A) flag OFF ──────────────────────────────────────────────────────
      {
        const r = await run(["gs-om-a"]);
        assertEq(r.status, 200, "A-1: dry run -> 200");
        assertTrue(!("about_page_mode" in r.body) && !("about_page_candidates" in r.body), "A-2: flag off -> no about_* keys");
        assertEq(fetchedFor("gs-om-a"), ["/", "/contact", "/kontakt", "/kontakt-oss", "/kontaktinfo"], "A-3: flag off -> four contact links, «Om oss» crowded out (today)");
        const c = r.body.changed.find((x: any) => x.provider_id === "gs-om-a");
        assertEq(c?.actions?.about_text, "filled", "A-4: the homepage candidate fills the blank about_text, as today");
        assertEq(c?.provenance?.about_text?.source_url, HOME_URL("gs-om-a"), "A-5: … with the homepage as source");
        assertEq(rowOf("gs-om-a").about_text, null, "A-6: dry run writes nothing");
      }

      // ── (B) dry-run preview ───────────────────────────────────────────────
      {
        const r = await run(["gs-om-b"], { preview: true });
        assertEq(r.body.about_page_mode, "dry_run_preview", "B-1: preview -> about_page_mode dry_run_preview");
        const subs = fetchedFor("gs-om-b").slice(1);
        assertTrue(subs.includes("/om-oss"), "B-2: «Om oss» is fetched");
        assertEq(subs.length, 4, "B-3: … still four sub-pages (no extra fetch)");
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.provider_id, "gs-om-b", "B-4: one report entry for the row");
        assertEq(e?.needs_description, true, "B-5: blank about_text -> needs_description");
        assertEq(e?.deterministic_choice, "about_page", "B-6: the about page supplies the deterministic candidate");
        assertEq(e?.candidate_source, "about_page", "B-7: … and the judge approved it");
        assertEq(e?.about_text_action, "filled", "B-8: action filled");
        assertEq(e?.about_text_after, ABOUT_TEXT, "B-9: about_text_after = the about page's prose");
        assertEq(e?.about_text_source_url, ABOUT_URL("gs-om-b"), "B-10: source_url = the about page");
        assertEq(e?.homepage_candidate, { text: HOME_META, source_url: HOME_URL("gs-om-b") }, "B-11: the homepage candidate is reported next to it");
        assertEq(e?.stored_about_text, null, "B-12: before = blank");
        assertEq(e?.about_page_in_content_text, true, "B-13: the about page's text is in contentText (what the LLM rewrite reads)");
        assertEq(e?.about_pages?.map((x: any) => [x.url, x.verdict]), [[ABOUT_URL("gs-om-b"), "chosen"]], "B-14: per-page verdict");
        const c = r.body.changed.find((x: any) => x.provider_id === "gs-om-b");
        assertEq(c?.provenance?.about_text?.source_url, ABOUT_URL("gs-om-b"), "B-15: changed[].provenance carries the about page");
        assertEq(rowOf("gs-om-b").about_text, null, "B-16: dry run writes nothing");
      }

      // ── (C) llm:false ─────────────────────────────────────────────────────
      {
        const before = llmCalls;
        const r = await run(["gs-om-c"], { preview: true, llm: false });
        const e = r.body.about_page_candidates?.[0];
        assertEq(llmCalls, before, "C-1: llm:false -> no model call");
        assertEq(e?.deterministic_choice, "about_page", "C-2: the about-page candidate is still reported");
        assertEq(e?.candidate_source, null, "C-3: … but nothing is admitted without the judge");
        assertEq(r.body.field_diagnostic?.[0]?.about_text, "judge_required", "C-4: field_diagnostic says judge_required");
        assertEq(r.body.judge_required_rows, 1, "C-5: counted in judge_required_rows");
      }

      // ── (D) the judge rejects the about-page text ─────────────────────────
      {
        rejectJudgeIfIncludes = "samme slekt siden 1850";
        const r = await run(["gs-om-d"], { preview: true });
        rejectJudgeIfIncludes = null;
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.deterministic_choice, "about_page", "D-1: the about page was the deterministic choice");
        assertEq(e?.candidate_source, "homepage", "D-2: the judge rejected it -> the homepage candidate is judged and used");
        assertEq(e?.about_text_after, HOME_META, "D-3: about_text_after = the homepage meta");
        assertEq(e?.about_text_source_url, HOME_URL("gs-om-d"), "D-4: source_url = the homepage");
      }

      // ── (E) flag ON + apply ───────────────────────────────────────────────
      {
        const r = await run(["gs-om-e"], { apply: true, flag: true });
        assertEq(r.status, 200, "E-1: apply -> 200");
        assertEq(r.body.about_page_mode, "env_flag", "E-2: about_page_mode env_flag");
        const row = rowOf("gs-om-e");
        assertEq(row.about_text, ABOUT_TEXT, "E-3: about_text written from the about page");
        assertEq(JSON.parse(row.field_provenance).about_text?.source_url, ABOUT_URL("gs-om-e"), "E-4: field_provenance.about_text.source_url = the about page");
        assertEq(row.content_evidence_url, HOME_URL("gs-om-e"), "E-5: content_evidence_url stays the homepage");
        const audit = expDb
          .prepare("SELECT source_url, new_value FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'about_text'")
          .get("gs-om-e") as any;
        assertEq([audit?.source_url, audit?.new_value], [ABOUT_URL("gs-om-e"), ABOUT_TEXT], "E-6: the audit row (rollback) carries the about page");
      }

      // ── (F) preview with apply: ignored ───────────────────────────────────
      {
        const r = await run(["gs-om-f"], { apply: true, preview: true });
        assertTrue(!("about_page_mode" in r.body) && !("about_page_candidates" in r.body), "F-1: preview + apply -> no about-page logic");
        assertEq(rowOf("gs-om-f").about_text, HOME_META, "F-2: the homepage candidate is written, as today");
        assertTrue(!fetchedFor("gs-om-f").includes("/om-oss"), "F-3: … and «Om oss» is not even fetched");
      }

      // ── (G) manual row: no fetch ──────────────────────────────────────────
      {
        const r = await run(["gs-om-manual"], { preview: true, flag: true });
        assertTrue(r.body.skipped_locked.includes("gs-om-manual"), "G-1: manual row -> skipped_locked");
        assertEq(fetchedFor("gs-om-manual"), [], "G-2: … and never fetched");
        assertEq(r.body.about_page_candidates, [], "G-3: … and has no about-page report entry");
        assertEq(rowOf("gs-om-manual").about_text, "Håndskrevet.", "G-4: untouched");
      }

      // ── (H) owner-locked about_text ───────────────────────────────────────
      {
        const r = await run(["gs-om-lock"], { preview: true });
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.owner_locked, true, "H-1: owner_locked reported");
        assertTrue(!r.body.changed.some((c: any) => c.provider_id === "gs-om-lock" && c.fields.includes("about_text")), "H-2: about_text is not in changed[]");
        const ra = await run(["gs-om-lock"], { apply: true, flag: true });
        assertEq(ra.status, 200, "H-3: apply -> 200");
        assertEq(rowOf("gs-om-lock").about_text, null, "H-4: the locked field is not written");
      }

      // ── (I) code-artifact about page ──────────────────────────────────────
      {
        const r = await run(["gs-code"], { preview: true });
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.deterministic_choice, "homepage", "I-1: code-artifact about page -> homepage candidate");
        assertEq(e?.about_pages?.[0]?.verdict, "code_artifact", "I-2: verdict code_artifact");
        assertEq(e?.about_text_after, HOME_META, "I-3: the homepage meta is what would be written");
      }

      // ── (J) fallback list ─────────────────────────────────────────────────
      {
        await run(["gs-fb-1"]);
        await run(["gs-fb-2"], { preview: true });
        const off = fetchedFor("gs-fb-1");
        const on = fetchedFor("gs-fb-2");
        assertTrue(off.indexOf("/om-oss") > off.indexOf("/besok"), "J-1: flag off -> /om-oss after the visit paths (today)");
        assertTrue(on.indexOf("/om-oss") < on.indexOf("/besok"), "J-2: preview, row needs a description -> /om-oss ahead of the visit paths");
        assertTrue(on.indexOf("/om") < on.indexOf("/besok"), "J-3: … and /om too");
        assertEq([...on].sort(), [...off].sort(), "J-4: same set of paths, only the order changed");
        await run(["gs-good-1"]);
        const r = await run(["gs-good-2"], { preview: true });
        assertEq(fetchedFor("gs-good-2"), fetchedFor("gs-good-1"), "J-5: a row with a decent about_text -> fallback order unchanged");
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.needs_description, false, "J-6: decent about_text -> needs_description false");
        assertEq(e?.about_pages?.map((x: any) => x.verdict), ["not_evaluated"], "J-7: … its about page is not evaluated");
        assertEq(e?.deterministic_choice, "homepage", "J-8: … and the homepage candidate path is unchanged");
      }

      // ── (M) review finding 1: deep-path homepage, root /about vs own «Om oss» ─
      {
        await run(["gs-deep-off"]);
        const r = await run(["gs-deep-on"], { preview: true });
        const off = fetchedFor("gs-deep-off");
        const on = fetchedFor("gs-deep-on");
        assertTrue(!off.includes("/medlem/gard-x/om-oss"), "M-1: flag off -> four contact links, the own «Om oss» crowded out (today)");
        assertTrue(on.includes("/medlem/gard-x/om-oss"), "M-2: preview -> the producer's own «Om oss» is fetched");
        assertTrue(!on.includes("/about"), "M-3: … not the host's root /about");
        assertEq(on.length - 1, 4, "M-4: … still four sub-pages");
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.about_pages?.map((x: any) => [x.url, x.verdict]), [["https://gs-deep-on.example.no/medlem/gard-x/om-oss", "chosen"]], "M-5: it is evaluated and chosen");
        assertEq(e?.about_text_source_url, "https://gs-deep-on.example.no/medlem/gard-x/om-oss", "M-6: source_url = the in-section about page");
      }

      // ── (N) review finding 3: a village «Historie» page ───────────────────
      {
        const before = judgePrompts.length;
        const r = await run(["gs-hist"], { preview: true });
        const e = r.body.about_page_candidates?.[0];
        assertTrue(fetchedFor("gs-hist").includes("/historie"), "N-1: the «Historie» page was fetched");
        assertEq(e?.about_pages?.[0]?.verdict, "not_about_producer", "N-2: it does not name the producer -> not_about_producer");
        assertEq(e?.deterministic_choice, "homepage", "N-3: the homepage candidate goes to the judge");
        assertTrue(!judgePrompts.slice(before).some((pr) => pr.includes("Stavkirken herfra")), "N-4: the village text never reaches the judge (deterministic pre-check)");
        assertEq(e?.about_text_after, HOME_META, "N-5: the homepage meta is what would be written");
      }

      // ── (O) review finding 2: about_page_in_content_text uses the LLM's window ─
      {
        const r = await run(["gs-big"], { preview: true });
        const e = r.body.about_page_candidates?.[0];
        assertEq(e?.about_pages?.[0]?.verdict, "chosen", "O-1: (control) the about page was fetched and chosen");
        assertEq(e?.about_page_in_content_text, false, "O-2: its text lies beyond the first 6000 chars the rewrite/fill read -> false");
      }

      // ── (P) flag ON without an about page == flag OFF ─────────────────────
      {
        const dOff = await run(["gs-none-dry"]);
        const dOn = await run(["gs-none-dry"], { flag: true });
        const { about_page_mode: m, about_page_candidates: ac, ...restOn } = dOn.body;
        assertEq(m, "env_flag", "P-1: flag on reported");
        assertEq(restOn, dOff.body, "P-2: dry run, no about page -> identical response apart from the about_page_* keys");
        assertEq(ac?.[0]?.about_pages, [], "P-3: … no about page fetched");
        const aOff = await run(["gs-none-a"], { apply: true });
        const aOn = await run(["gs-none-b"], { apply: true, flag: true });
        const norm = (x: unknown) => JSON.parse(JSON.stringify(x).split("gs-none-b").join("gs-none-a"), (k, v) => (k === "fetched_at" ? "<t>" : v));
        const { about_page_mode: _m2, about_page_candidates: _ac2, ...restApplyOn } = aOn.body;
        assertEq(norm(restApplyOn), norm(aOff.body), "P-4: apply, no about page -> identical response apart from the about_page_* keys");
        const rowFull = (id: string) =>
          expDb
            .prepare("SELECT about_text, visit_text, opening_hours_text, products, content_source, content_evidence_url, field_provenance FROM experience_providers WHERE id = ?")
            .get(id) as any;
        const rowNorm = (id: string) => {
          const r0 = rowFull(id);
          return norm({ ...r0, field_provenance: JSON.parse(r0.field_provenance) });
        };
        assertEq(rowNorm("gs-none-b"), rowNorm("gs-none-a"), "P-5: … and the same DB row");
        assertEq(fetchedFor("gs-none-b"), fetchedFor("gs-none-a"), "P-6: … and the same pages fetched");
      }

      // ── (K) pure helpers ──────────────────────────────────────────────────
      {
        const { gardssalgOrderContentPathsForAboutNeed: forAbout, gardssalgOrderContentPathsForNeed: forNeed, gardssalgAboutNeedsDescription: needs } = opp;
        assertEq(forAbout(false, false), forNeed(false), "K-1: no description need -> today's order (needsDriven=false)");
        assertEq(forAbout(true, false), forNeed(true), "K-2: no description need -> today's order (needsDriven=true)");
        const a = forAbout(false, true);
        const base = forNeed(false);
        assertEq(a.indexOf("/om-oss") + 2, a.indexOf("/besok"), "K-3: /om-oss, /om right before the first visit path");
        assertEq(a.indexOf("/om") + 1, a.indexOf("/besok"), "K-4: … in that order");
        const strip = (l: readonly string[]) => l.filter((p) => p !== "/om-oss" && p !== "/om");
        assertEq(strip(a), strip(base), "K-5: every other path keeps its order");
        assertEq([...a].sort(), [...base].sort(), "K-6: membership unchanged");
        const b = forAbout(true, true);
        assertEq(b.slice(0, 2), ["/om-oss", "/om"], "K-7: needsDriven (visit paths first) -> /om-oss, /om first");
        assertEq(strip(b), strip(forNeed(true)), "K-8: … the rest unchanged");
        assertEq([needs(null), needs(""), needs("  "), needs("Kort tekst."), needs(GOOD_ABOUT)], [true, true, true, true, false], "K-9: needs a description = blank or below the cheap bar");
      }

      // ── (L) the route ─────────────────────────────────────────────────────
      {
        add("gs-om-l3");
        const dry = await callRoute(router, { providerIds: ["gs-om-l1"], about_page_preview: true });
        assertEq(dry.status, 200, "L-1: dry-run preview -> 200");
        assertEq(dry.body?.about_page_mode, "dry_run_preview", "L-2: the route passes the preview through in a dry run");
        assertTrue(!("about_page_preview_ignored" in (dry.body ?? {})), "L-3: … not flagged as ignored");
        const ap = await callRoute(router, { providerIds: ["gs-om-l2"], apply: true, about_page_preview: true });
        assertEq(ap.status, 200, "L-4: apply + preview -> 200");
        assertEq(ap.body?.about_page_preview_ignored, "apply", "L-5: the preview is ignored with apply, and said so");
        assertTrue(!("about_page_candidates" in (ap.body ?? {})), "L-6: no about-page report in the apply response");
        assertEq(rowOf("gs-om-l2").about_text, HOME_META, "L-7: apply wrote the homepage candidate, not the about page");
        const plain = await callRoute(router, { providerIds: ["gs-om-l3"] });
        assertTrue(!("about_page_mode" in (plain.body ?? {})) && !("about_page_preview_ignored" in (plain.body ?? {})), "L-8: no preview -> no about keys");
        // apply in the QUERY (?apply=1), preview in the body.
        const q = await callRoute(router, { providerIds: ["gs-om-l4"], about_page_preview: true }, { apply: "1" });
        assertEq([q.status, q.body?.dry_run], [200, false], "L-9: ?apply=1 + preview in the body -> an apply run");
        assertEq(q.body?.about_page_preview_ignored, "apply", "L-10: … the preview is ignored and said so");
        assertTrue(!("about_page_mode" in (q.body ?? {})) && !("about_page_candidates" in (q.body ?? {})), "L-11: … no preview logic ran");
        assertEq(rowOf("gs-om-l4").about_text, HOME_META, "L-12: … the homepage candidate was written");
        // Env flag on + apply + preview: the logic runs on the flag; nothing is "ignored".
        process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "1";
        const fl = await callRoute(router, { providerIds: ["gs-om-l5"], apply: true, about_page_preview: true });
        delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        assertEq(fl.body?.about_page_mode, "env_flag", "L-13: flag on + apply -> about_page_mode env_flag");
        assertTrue(!("about_page_preview_ignored" in (fl.body ?? {})), "L-14: … and no contradictory about_page_preview_ignored");
        assertEq(rowOf("gs-om-l5").about_text, ABOUT_TEXT, "L-15: … the about page was written");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-about-page-candidate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prev.fetch;
      const restoreEnv = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restoreEnv("EXPERIENCES_DB_PATH", prev.exp);
      restoreEnv("ADMIN_KEY", prev.admin);
      restoreEnv("ANTHROPIC_API_KEY", prev.anthropic);
      restoreEnv(ENRICHMENT_ABOUT_PAGE_FLAG, prev.flag);
      restoreEnv("GARDSSALG_VISIT_LLM_ENABLED", prev.visitLlm);
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        /* best-effort */
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgAboutPageCandidateTests({ log: true }).then((r) => {
    console.log(`\nopplevelser-gardssalg-about-page-candidate: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
