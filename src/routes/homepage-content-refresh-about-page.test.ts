/**
 * homepage-content-refresh-about-page.test.ts — RFB half of dev-request
 * 2026-10-27-rfb-berikelse-om-oss-sider-til-beskrivelse (AC1): the producer
 * description may come from the producer's «Om oss» page instead of the
 * homepage, behind ENRICHMENT_ABOUT_PAGE_ENABLED (default OFF), with a
 * dry-run-only `about_page_preview` for Daniel's preview (spec 6).
 *
 * Drives refreshHomepageContent (the route's per-agent body) with an
 * injected fetchImpl — no global fetch swap — against a fresh in-memory DB
 * per case (better-sqlite3 ":memory:" + __setDbForTesting/
 * __initSchemaForTesting, as admin-knowledge-about-substantiation.test.ts).
 * The route's own `about_page_preview` parsing is exercised once through
 * homepageContentRefreshRouter with a stubbed globalThis.fetch, restored in
 * finally (runSerial in tests/test.ts).
 *
 * Covers:
 *   (a) flag OFF: the three contact links are fetched (not «Om oss»), the
 *       homepage candidate is written, and the result has no about_* keys —
 *       today's behaviour;
 *   (b) dry-run preview: «Om oss» takes one of the three sub-page slots, the
 *       about-page candidate is chosen with the about page as source_url,
 *       the homepage candidate is reported next to it, nothing is written;
 *   (c) preview with apply: ignored — identical to (a);
 *   (d) flag ON + apply: about/description written from the about page,
 *       field_provenance source_url = the about page;
 *   (e) about page with code / theme spam / another business -> homepage
 *       candidate;
 *   (f) curated (locked) about: not touched; reported curated_locked;
 *   (g) no about page: flag ON is identical to flag OFF (result, DB, fetches);
 *   (h) directory/social host and a deep-path section: no about page used;
 *   (i) route: about_page_preview honoured in a dry run, ignored with apply.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { ENRICHMENT_ABOUT_PAGE_FLAG, ABOUT_PAGE_NOT_ABOUT_PRODUCER } from "../services/about-page-candidate";
import { ORGANIC_CLAIM_GATE_ENV, REFUSED_ORGANIC_CLAIM_UNVERIFIED } from "../services/description-quality";

type HcrAboutJudges = import("./admin-knowledge").HcrAboutJudges;

/**
 * Since skive B (lokal#1370) every about/description candidate goes through
 * the LLM about judges before it is written. These suites test the about-page
 * selection, not the judges, so they run with stub judges that approve —
 * except where a case says otherwise. `factsPages` records the URLs the facts
 * judge was shown, `candidates` the texts it judged.
 */
function stubJudges(
  o: {
    quality?: "GODKJENN" | "AVVIS";
    /** Per-text verdicts: a candidate containing this marker gets the "no" (or "unavailable"). */
    avvisIf?: string;
    notSupportedIf?: string;
    factsUnavailableIf?: string;
    notBetterIf?: string;
    /** The quality judge answers a candidate containing `delay.marker` only at `delay.until` (ms). */
    delay?: { marker: string; until: number };
    timeoutMs?: number;
  } = {},
): HcrAboutJudges & { factsPages: string[]; candidates: string[] } {
  const factsPages: string[] = [];
  const candidates: string[] = [];
  return {
    factsPages,
    candidates,
    timeoutMs: o.timeoutMs ?? 1,
    quality: async (candidate) => {
      candidates.push(candidate);
      if (o.delay && candidate.includes(o.delay.marker)) {
        await new Promise((r) => setTimeout(r, Math.max(0, o.delay!.until - Date.now())));
      }
      return o.quality === "AVVIS" || (o.avvisIf !== undefined && candidate.includes(o.avvisIf))
        ? { approved: false, reasoning: "generisk tekst" }
        : { approved: true, reasoning: "konkret om produsenten" };
    },
    facts: async (params) => {
      factsPages.push(...params.pages.map((p) => p.url));
      if (o.factsUnavailableIf !== undefined && params.about.includes(o.factsUnavailableIf)) {
        return { ok: false, failure: "timeout", reason: "dommeren svarte ikke i tide" };
      }
      if (o.notSupportedIf !== undefined && params.about.includes(o.notSupportedIf)) {
        return { ok: true, supported: false, unsupportedClaims: ["siden 1850"], bestPage: null, reason: "ikke støttet" };
      }
      return { ok: true, supported: true, unsupportedClaims: [], bestPage: 0, reason: "støttet" };
    },
    comparison: async (params) =>
      o.notBetterIf !== undefined && params.candidate.includes(o.notBetterIf)
        ? { ok: true, better: false, verdict: "IKKE_BEDRE", reasoning: "ikke bedre enn lagret" }
        : { ok: true, better: true, verdict: "BEDRE", reasoning: "mer konkret" },
  };
}

/** Only in the about-page text of tveras.no / okohjem.no (P1), never in HOME_META. */
const ABOUT_MARKER = "Tverås er en familiegård";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HOME_META =
  "Tverås Gårdsmat er en liten gård i Hallingdal som selger lammekjøtt og spekemat direkte fra gården.";
const P1 =
  "Tverås er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.";
const P2 =
  "Kjøttet foredler vi selv i vårt eget slakteri og pølsemakeri på gården, og vi selger spekemat, pølser og ferskt lammekjøtt direkte til kundene våre.";
const P3 =
  "Du finner oss på REKO-ringen i Gol og på bondens marked i Oslo, og vi tar gjerne imot bestillinger til selskap og høytider.";
const ABOUT_TEXT = `${P1} ${P2} ${P3}`;

const NAV_3_CONTACT_1_ABOUT =
  `<nav><a href="/kontakt">Kontakt</a><a href="/kontakt-oss">Kontakt oss</a><a href="/contact">Contact</a>` +
  `<a href="/om-oss">Om oss</a></nav>`;

function homepage(nav: string, meta: string = HOME_META): string {
  return `<html><head><title>Gård</title><meta name="description" content="${meta}"></head><body>${nav}<p>Velkommen!</p></body></html>`;
}
function aboutPage(paragraphs: string[], name?: string): string {
  return `<html><head><title>Om oss${name ? ` – ${name}` : ""}</title><meta name="description" content="${HOME_META}"></head><body>
<header><nav><a href="/">Hjem</a><a href="/om-oss">Om oss</a></nav></header>
<main><h1>Om oss</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}</main>
<footer><p>Alle rettigheter reservert.</p></footer></body></html>`;
}
const CONTACT_PAGE = "<html><body><p>Ring oss på 900 00 000.</p></body></html>";

const HELIOS_CODE =
  'Grønn Guide Trondheim Static = window.Static || {}; Static.SQUARESPACE_CONTEXT = {"betaFeatureFlags":["supports_versioned_template_assets",' +
  '"campaigns_merch_state","marketing_landing_page","enable_form_submission_trigger","campaigns_table_v2","contacts_and_campaigns_redesign",' +
  '"marketing_automations"]}; Vi er en gård i Trondheim.';
const SPAM_ABOUT =
  "<html><head><title>Beste casino på nett i 2026</title></head><body><main><p>Spill på nettcasino med gratisspinn og velkomstbonus hos de beste norske casinoene. Vi har testet alle casino uten innskudd.</p><p>" +
  P1 + "</p><p>" + P2 + "</p></main></body></html>";
const UMBRELLA_ABOUT = aboutPage([
  "Hallingdal Matforum er et samarbeid mellom lokale produsenter i regionen. Våre medlemmer leverer kjøtt, ost og grønnsaker til butikker og restauranter.",
  "Vi arrangerer markeder og kurs for medlemmene våre gjennom hele året, og hjelper nye produsenter i gang med salg.",
]);

/** host -> path -> html. Anything else is a 404. */
const SITES: Record<string, Record<string, string>> = {
  "tveras.no": {
    "/": homepage(NAV_3_CONTACT_1_ABOUT),
    "/kontakt": CONTACT_PAGE,
    "/kontakt-oss": CONTACT_PAGE,
    "/contact": CONTACT_PAGE,
    "/om-oss": aboutPage([P1, P2, P3]),
  },
  // Økologi S3b: an «Om oss» that claims «økologisk» for a producer without a
  // Debio status must be refused like the homepage summary would be.
  // Homepage meta with an organic claim; the about page without one.
  "okohjem.no": {
    "/": homepage(
      NAV_3_CONTACT_1_ABOUT,
      "Økologisk gårdsbruk i Hallingdal som selger lammekjøtt og spekemat fra egne dyr rett fra gården vår.",
    ),
    "/om-oss": aboutPage([P1, P2, P3], "Tverås Økohjem"),
  },
  "okogard.no": {
    "/": homepage(NAV_3_CONTACT_1_ABOUT),
    "/om-oss": aboutPage(
      [
        "Okogard er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver økologisk med sau og storfe på utmarksbeite i fjellet om sommeren.",
        P2,
        P3,
      ],
      "Okogard",
    ),
  },
  "kodegard.no": { "/": homepage(NAV_3_CONTACT_1_ABOUT), "/om-oss": `<html><body><main><p>${HELIOS_CODE}</p></main></body></html>` },
  "spamgard.no": { "/": homepage(NAV_3_CONTACT_1_ABOUT), "/om-oss": SPAM_ABOUT },
  "medlemsgard.no": { "/": homepage(NAV_3_CONTACT_1_ABOUT), "/om-oss": UMBRELLA_ABOUT },
  "laastgard.no": { "/": homepage(NAV_3_CONTACT_1_ABOUT), "/om-oss": aboutPage([P1, P2, P3], "Låstgard") },
  "utenomgard.no": {
    "/": homepage(`<nav><a href="/kontakt">Kontakt</a><a href="/produkter">Produkter</a></nav>`),
    "/kontakt": CONTACT_PAGE,
    "/produkter": "<html><body><p>Lammekjøtt, pølser og spekemat.</p></body></html>",
  },
  // A deep-path homepage on a shared host whose root «Om oss» describes the
  // host organisation (the hanen.no shape — hanen.no itself is a refused
  // directory host, so an unlisted host is used).
  "fellesportal.no": {
    "/medlem/gard-x": homepage(`<nav><a href="/om-oss">Om oss</a><a href="/medlem/gard-x/kontakt">Kontakt</a></nav>`),
    "/om-oss": aboutPage([
      "Hanen er en landsdekkende organisasjon for bygdeturisme og gardsmat, med flere hundre bedrifter over hele landet.",
      "Organisasjonen jobber for bedre rammevilkår for små bedrifter på bygda og driver markedsføring av hele næringen.",
    ]),
  },
  // A social-media "homepage" with an about page inside its own section:
  // only the host refusal stops it.
  "facebook.com": {
    "/fbgard": homepage(`<nav><a href="/fbgard/om-oss">Om oss</a></nav>`),
    "/fbgard/om-oss": aboutPage([P1, P2, P3]),
  },
  // No links at all on the homepage: the fixed fallback paths are tried.
  "fallbackgard.no": {
    "/": homepage(""),
    "/om-oss": aboutPage([P1, P2, P3], "Fallbackgard"),
  },
  // Review finding 1, the repro: four contact links inside the producer's
  // section, the host's root /about and /om-oss, and the producer's own
  // /medlem/gard-x/om-oss.
  "fellesside.no": {
    "/medlem/gard-x": homepage(
      `<nav><a href="/medlem/gard-x/kontakt">Kontakt</a><a href="/medlem/gard-x/kontakt-oss">Kontakt oss</a>` +
        `<a href="/medlem/gard-x/contact">Contact</a><a href="/medlem/gard-x/kontaktinfo">Kontaktinfo</a>` +
        `<a href="/about">About</a><a href="/om-oss">Om oss</a><a href="/medlem/gard-x/om-oss">Om oss</a></nav>`,
    ),
    "/medlem/gard-x/kontakt": CONTACT_PAGE,
    "/medlem/gard-x/kontakt-oss": CONTACT_PAGE,
    "/medlem/gard-x/contact": CONTACT_PAGE,
    "/medlem/gard-x/kontaktinfo": CONTACT_PAGE,
    "/about": aboutPage([
      "Fellessiden er en portal for lokale matprodusenter i hele landet, med over tusen medlemsbedrifter og egne sider for hver av dem.",
      "Portalen drives av en ideell stiftelse og finansieres av medlemskontingenter og annonser fra samarbeidspartnere i bransjen.",
    ], "Fellessiden"),
    "/medlem/gard-x/om-oss": aboutPage([
      "Fjellgard ligger øverst i dalen og har vært drevet av samme familie i fem generasjoner. Vi holder sau og geit på fjellbeite hele sommeren.",
      P2,
    ], "Fjellgard"),
  },
  // A village «Historie» page on the producer's own host (review finding 3).
  "historiegard.no": {
    "/": homepage(`<nav><a href="/historie">Historie</a></nav>`),
    "/historie": aboutPage([
      "Gol er en bygd i Hallingdal med lange tradisjoner for jordbruk og husdyrhold. Stavkirken herfra står i dag på Bygdøy i Oslo.",
      "Bygda vokste fram rundt jernbanen på begynnelsen av nittenhundretallet, og mange gamle gardsbygninger står fortsatt på hver side av elva.",
    ]).replace("<h1>Om oss</h1>", "<h1>Historien om Gol</h1>").replace("<title>Om oss</title>", "<title>Historie</title>"),
  },
};

// A site that answers every path with its front page (a soft 404): its
// fallback /om-oss is the homepage again, prose and all.
const SOFT_404_HOME =
  `<html><head><meta name="description" content="${HOME_META}"></head><body><main>` +
  `<p>Softgard er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.</p>` +
  `<p>${P2}</p></main></body></html>`;

function makeFetch(log: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    log.push(url.toString());
    const host = url.host.replace(/^www\./, "");
    if (host === "softgard.no") return new Response(SOFT_404_HOME, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const html = SITES[host]?.[url.pathname === "" ? "/" : url.pathname];
    if (html === undefined) return new Response("<html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
}

interface RouteResult {
  status: number;
  body: any;
}
function callRoute(router: any, body: any, query: Record<string, string> = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "x-admin-key": process.env.ADMIN_KEY ?? "", "content-type": "application/json" };
    const req: any = {
      method: "POST",
      url: "/homepage-content-refresh",
      originalUrl: "/homepage-content-refresh",
      query,
      headers,
      body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
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
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

export function runHomepageContentRefreshAboutPageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDb = initMod.getDb();
    const prevFlag = process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevFetch = globalThis.fetch;
    process.env.ADMIN_KEY = prevAdminKey || "hcr-about-page-test-key";
    const opened: Database.Database[] = [];
    try {
      const { refreshHomepageContent, homepageContentRefreshRouter } =
        require("./admin-knowledge") as typeof import("./admin-knowledge");

      const AGENTS: Array<{ id: string; name: string; url: string; curated?: string; about?: string | null }> = [
        { id: "tveras", name: "Tverås Gårdsmat", url: "https://tveras.no/" },
        { id: "kodegard", name: "Kodegard", url: "https://kodegard.no/" },
        { id: "spamgard", name: "Spamgard", url: "https://spamgard.no/" },
        { id: "medlemsgard", name: "Medlemsgard", url: "https://medlemsgard.no/" },
        { id: "laastgard", name: "Låstgard", url: "https://laastgard.no/", curated: '{"about":true}', about: "Eierens egen tekst." },
        { id: "utenomgard", name: "Utenomgard", url: "https://utenomgard.no/" },
        { id: "fbgard", name: "Fbgard", url: "https://www.facebook.com/fbgard" },
        { id: "hanengard", name: "Gard X", url: "https://fellesportal.no/medlem/gard-x" },
        { id: "fallbackgard", name: "Fallbackgard", url: "https://fallbackgard.no/" },
        { id: "fjellgard", name: "Fjellgard", url: "https://fellesside.no/medlem/gard-x" },
        { id: "historiegard", name: "Tverås Gårdsmat", url: "https://historiegard.no/" },
        { id: "softgard", name: "Softgard", url: "https://softgard.no/" },
        { id: "okogard", name: "Okogard", url: "https://okogard.no/" },
        { id: "tveras2", name: "Tverås Gårdsmat", url: "https://tveras.no/", about: "Gammel kort tekst om gården vår." },
        { id: "okohjem", name: "Tverås Økohjem", url: "https://okohjem.no/" },
      ];

      function freshDb(): Database.Database {
        const db = new Database(":memory:");
        opened.push(db);
        initMod.__setDbForTesting(db as any);
        initMod.__initSchemaForTesting(db as any);
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test agent', 'test', 'post@example.no', ?, 'producer', ?)`,
        );
        const insertKnowledge = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, about, products, field_provenance, curated_fields, updated_at)
           VALUES (?, ?, ?, '[]', '{}', ?, '2020-01-01T00:00:00.000Z')`,
        );
        for (const a of AGENTS) {
          insertAgent.run(a.id, a.name, a.url, `key-${a.id}`);
          insertKnowledge.run(a.id, a.url, a.about ?? null, a.curated ?? "{}");
        }
        return db;
      }
      function target(id: string) {
        const a = AGENTS.find((x) => x.id === id)!;
        return { agent_id: a.id, name: a.name, homepage_url: a.url };
      }
      function row(db: Database.Database, id: string) {
        return db
          .prepare(
            `SELECT k.about AS about, k.field_provenance AS field_provenance, a.description AS description, a.categories AS categories
               FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`,
          )
          .get(id) as { about: string | null; field_provenance: string; description: string | null; categories: string | null };
      }
      async function run(
        id: string | string[],
        o: { dryRun: boolean; aboutPagePreview?: boolean; flag?: boolean; judges?: HcrAboutJudges; deadlineAt?: number },
      ) {
        if (o.flag) process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "1";
        else delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        const db = freshDb();
        const fetchLog: string[] = [];
        const ids = Array.isArray(id) ? id : [id];
        const result = await refreshHomepageContent(db as any, ids.map(target), {
          dryRun: o.dryRun,
          fetchImpl: makeFetch(fetchLog),
          aboutJudges: o.judges ?? stubJudges(),
          ...(o.aboutPagePreview ? { aboutPagePreview: true } : {}),
          ...(o.deadlineAt !== undefined ? { deadlineAt: o.deadlineAt } : {}),
        });
        return { db, result, fetchLog };
      }
      // Today's keys = main's keys since skive B (lokal#1370), without any about-page key.
      const LEGACY_KEYS = [
        "scanned",
        "by_field",
        "changed",
        "skipped_curated",
        "skipped_unsubstantiated",
        "errors",
        "parked_now",
        "about_reviews",
        "about_judge_rejected",
        "about_not_supported",
        "about_not_better",
        "about_judge_unavailable",
      ];

      // ── (a) flag OFF — today's behaviour ──────────────────────────────────
      const off = await run("tveras", { dryRun: false });
      {
        assertEq(Object.keys(off.result), LEGACY_KEYS, "a-1: flag off -> the result carries exactly today's keys (no about_page_mode/about_candidates)");
        assertEq(
          off.fetchLog,
          ["https://tveras.no/", "https://tveras.no/contact", "https://tveras.no/kontakt", "https://tveras.no/kontakt-oss"],
          "a-2: flag off -> the three contact links are fetched, «Om oss» is not (unchanged ranking)",
        );
        const r = row(off.db, "tveras");
        assertEq(r.about, HOME_META, "a-3: flag off -> about written from the homepage meta, as today");
        assertEq(r.description, HOME_META, "a-4: … and description too");
        assertEq(JSON.parse(r.field_provenance).about[0].source_url, "https://tveras.no/", "a-5: … with the homepage as source_url");
      }

      // ── (b) dry-run preview ───────────────────────────────────────────────
      {
        const p = await run("tveras", { dryRun: true, aboutPagePreview: true });
        assertEq(p.result.about_page_mode, "dry_run_preview", "b-1: preview -> about_page_mode dry_run_preview");
        assertEq(
          p.fetchLog,
          ["https://tveras.no/", "https://tveras.no/contact", "https://tveras.no/kontakt", "https://tveras.no/om-oss"],
          "b-2: «Om oss» takes one of the three sub-page slots — still three sub-pages",
        );
        const e = p.result.about_candidates?.[0];
        assertTrue(!!e && e.agent_id === "tveras", "b-3: one about_candidates entry for the agent");
        assertEq(e?.chosen, "about_page", "b-4: chosen = about_page");
        assertEq(e?.chosen_text, ABOUT_TEXT, "b-5: chosen_text = the about page's first three prose paragraphs");
        assertEq(e?.chosen_source_url, "https://tveras.no/om-oss", "b-6: chosen_source_url = the about page URL");
        assertEq(e?.homepage_candidate, { text: HOME_META, source_url: "https://tveras.no/" }, "b-7: the homepage candidate is reported next to it");
        assertEq(e?.stored_about, null, "b-8: stored_about = the value before the run");
        assertEq(e?.would_write_about, true, "b-9: would_write_about (about is in changed[].fields)");
        assertEq(e?.about_pages.map((x: any) => [x.url, x.verdict]), [["https://tveras.no/om-oss", "chosen"]], "b-10: per-page verdict");
        assertEq(e?.subpages_fetched, ["https://tveras.no/contact", "https://tveras.no/kontakt", "https://tveras.no/om-oss"], "b-11: subpages_fetched");
        assertTrue(p.result.changed.some((c) => c.agent_id === "tveras" && c.fields.includes("about") && c.fields.includes("description")), "b-12: changed reports about + description");
        const r = row(p.db, "tveras");
        assertEq([r.about, r.description], [null, "test agent"], "b-13: dry run -> nothing written");
      }

      // ── (c) preview with apply: ignored ───────────────────────────────────
      {
        const c = await run("tveras", { dryRun: false, aboutPagePreview: true });
        assertEq(Object.keys(c.result), LEGACY_KEYS, "c-1: preview + apply -> no about-page keys (the preview never writes)");
        assertEq(c.fetchLog, off.fetchLog, "c-2: … same fetches as flag off");
        assertEq(row(c.db, "tveras").about, HOME_META, "c-3: … and the homepage candidate is written, as today");
      }

      // ── (d) flag ON + apply ───────────────────────────────────────────────
      {
        const d = await run("tveras", { dryRun: false, flag: true });
        assertEq(d.result.about_page_mode, "env_flag", "d-1: flag on -> about_page_mode env_flag");
        const r = row(d.db, "tveras");
        assertEq(r.about, ABOUT_TEXT, "d-2: about written from the about page");
        assertEq(r.description, ABOUT_TEXT, "d-3: description written from the about page");
        const prov = JSON.parse(r.field_provenance);
        assertEq(prov.about[0].source_url, "https://tveras.no/om-oss", "d-4: about provenance source_url = the about page");
        assertEq(prov.description[0].source_url, "https://tveras.no/om-oss", "d-5: description provenance source_url = the about page");
        assertEq(prov.about[0].source_type, "website_homepage", "d-6: same source_type as the homepage candidate (same precedence)");
        assertEq(d.result.about_candidates?.[0]?.would_write_about, true, "d-7: would_write_about true");
      }

      // ── (e) code / theme spam / another business -> homepage candidate ────
      {
        const e = await run(["kodegard", "spamgard", "medlemsgard"], { dryRun: true, aboutPagePreview: true });
        const byId = (id: string) => e.result.about_candidates?.find((x) => x.agent_id === id);
        for (const [id, verdict] of [["kodegard", "code_artifact"], ["spamgard", "theme_spam_page"], ["medlemsgard", "below_quality_bar"]] as const) {
          const x = byId(id);
          assertEq(x?.chosen, "homepage", `e-1 ${id}: about page rejected -> homepage candidate`);
          assertEq(x?.chosen_text, HOME_META, `e-2 ${id}: chosen_text = the homepage meta`);
          assertEq(x?.chosen_source_url, `https://${id}.no/`, `e-3 ${id}: source_url = the homepage`);
          assertEq(x?.about_pages?.[0]?.verdict, verdict, `e-4 ${id}: verdict ${verdict}`);
          assertTrue(!!x?.about_pages?.[0]?.url.endsWith("/om-oss"), `e-5 ${id}: the about page was fetched and evaluated`);
        }
      }

      // ── (f) curated (locked) about ────────────────────────────────────────
      {
        const f = await run("laastgard", { dryRun: false, flag: true });
        const r = row(f.db, "laastgard");
        assertEq(r.about, "Eierens egen tekst.", "f-1: a curated about is not touched");
        assertTrue(f.result.skipped_curated.some((s) => s.agent_id === "laastgard" && s.fields.includes("about")), "f-2: reported in skipped_curated");
        const x = f.result.about_candidates?.[0];
        assertEq(x?.chosen, "about_page", "f-3: the about page is still the candidate (the lock is the gate's decision)");
        assertEq(x?.about_gate_reason, "curated_locked", "f-4: about_gate_reason curated_locked");
        assertEq(x?.would_write_about, false, "f-5: would_write_about false");
        assertEq(x?.stored_about, "Eierens egen tekst.", "f-6: stored_about reported");
        const fd = await run("laastgard", { dryRun: true, aboutPagePreview: true });
        assertEq(fd.result.about_candidates?.[0]?.would_write_about, false, "f-7: the dry-run preview predicts the same (no write)");
      }

      // ── (g) no about page: flag ON identical to flag OFF ──────────────────
      {
        const gOff = await run("utenomgard", { dryRun: false });
        const gOn = await run("utenomgard", { dryRun: false, flag: true });
        const { about_page_mode: m, about_candidates: ac, ...rest } = gOn.result;
        assertEq(m, "env_flag", "g-1: flag on reported");
        assertEq(rest, gOff.result, "g-2: without an about page the result is identical to flag off");
        assertEq(gOn.fetchLog, gOff.fetchLog, "g-3: … the same pages are fetched");
        const strip = (x: ReturnType<typeof row>) => ({
          ...x,
          field_provenance: JSON.stringify(JSON.parse(x.field_provenance), (k, v) => (k === "fetched_at" ? "<t>" : v)),
        });
        assertEq(strip(row(gOn.db, "utenomgard")), strip(row(gOff.db, "utenomgard")), "g-4: … and the same values are written");
        assertEq(ac?.[0]?.chosen, "homepage", "g-5: report says homepage");
        assertEq(ac?.[0]?.about_pages, [], "g-6: no about page fetched");
      }

      // ── (g2) fallback paths (no links on the homepage) ────────────────────
      {
        const fOff = await run("fallbackgard", { dryRun: true });
        const fOn = await run("fallbackgard", { dryRun: true, aboutPagePreview: true });
        assertEq(
          fOff.fetchLog,
          ["https://fallbackgard.no/", "https://fallbackgard.no/om-oss", "https://fallbackgard.no/about", "https://fallbackgard.no/produkter"],
          "g2-1: flag off -> the fixed fallback paths, as today",
        );
        assertEq(fOn.fetchLog, fOff.fetchLog, "g2-2: preview -> the same fallback paths (RFB's list is unchanged)");
        const x = fOn.result.about_candidates?.[0];
        assertEq([x?.chosen, x?.chosen_source_url], ["about_page", "https://fallbackgard.no/om-oss"], "g2-3: the fallback /om-oss page supplies the candidate");
        assertEq(x?.about_pages?.map((e: any) => e.url), ["https://fallbackgard.no/om-oss"], "g2-4: only fetched about paths are evaluated (/about was a 404)");
      }

      // ── (h) directory/social host; deep-path section ──────────────────────
      {
        const h = await run(["fbgard", "hanengard"], { dryRun: true, aboutPagePreview: true });
        const fb = h.result.about_candidates?.find((x) => x.agent_id === "fbgard");
        assertTrue(h.fetchLog.includes("https://www.facebook.com/fbgard/om-oss"), "h-0: the social page's own «Om oss» was fetched");
        assertTrue(!!fb && fb.chosen !== "about_page", "h-1: a social/directory homepage never supplies an about page");
        assertEq(fb?.about_page_refusal, "directory/social host", "h-2: … with the refusal reported");
        assertEq(fb?.about_pages?.map((e: any) => e.verdict), ["not_evaluated"], "h-2b: … and its about page not evaluated");
        const hn = h.result.about_candidates?.find((x) => x.agent_id === "hanengard");
        assertTrue(h.fetchLog.includes("https://fellesportal.no/om-oss"), "h-3: the host-root «Om oss» was fetched as before (fetch list unchanged)");
        assertEq(hn?.about_pages, [], "h-4: … but outside the homepage's section it is not the producer's about page");
        assertTrue(hn?.chosen !== "about_page", "h-5: … so it never becomes the candidate");
      }

      // ── (j) review finding 1: deep-path homepage, root /about vs own «Om oss» ─
      {
        const jOff = await run("fjellgard", { dryRun: true });
        const j = await run("fjellgard", { dryRun: true, aboutPagePreview: true });
        const home = "https://fellesside.no/medlem/gard-x";
        assertEq(
          jOff.fetchLog,
          [home, `${home}/contact`, `${home}/kontakt`, `${home}/kontakt-oss`],
          "j-1: flag off -> three of the four in-section contact links (today)",
        );
        assertEq(
          j.fetchLog,
          [home, `${home}/contact`, `${home}/kontakt`, `${home}/om-oss`],
          "j-2: preview -> the producer's own «Om oss» takes the slot, still three sub-pages",
        );
        assertTrue(!j.fetchLog.includes("https://fellesside.no/about"), "j-3: the host's root /about is not fetched (its HTML never reaches combinedHtml)");
        const x = j.result.about_candidates?.[0];
        assertEq([x?.chosen, x?.chosen_source_url], ["about_page", `${home}/om-oss`], "j-4: the in-section «Om oss» is the candidate");
      }

      // ── (k) review finding 3: a village «Historie» page on the own host ───
      {
        const k = await run("historiegard", { dryRun: true, aboutPagePreview: true });
        const x = k.result.about_candidates?.[0];
        assertTrue(k.fetchLog.includes("https://historiegard.no/historie"), "k-1: the «Historie» page was fetched");
        assertEq(x?.about_pages?.[0]?.verdict, "not_about_producer", "k-2: it does not name the producer -> not_about_producer");
        assertEq(x?.about_page_refusal, ABOUT_PAGE_NOT_ABOUT_PRODUCER, "k-3: about_page_refusal = about_page_not_about_producer");
        assertEq([x?.chosen, x?.chosen_text], ["homepage", HOME_META], "k-4: the homepage candidate is kept");
      }

      // ── (l) soft 404: a fallback /om-oss that is the homepage again ───────
      {
        const l = await run("softgard", { dryRun: true, aboutPagePreview: true });
        const x = l.result.about_candidates?.[0];
        assertTrue(l.fetchLog.includes("https://softgard.no/om-oss"), "l-1: the fallback /om-oss was fetched");
        assertEq(x?.about_pages, [], "l-2: a page identical to the homepage is not an about page");
        assertEq([x?.chosen, x?.chosen_source_url], ["homepage", "https://softgard.no/"], "l-3: so nothing is attributed to /om-oss");
      }

      // ── (m) the about judges (skive B) judge the about-page candidate ──────
      {
        const j = stubJudges();
        const m = await run("tveras", { dryRun: true, aboutPagePreview: true, judges: j });
        assertEq(j.candidates, [m.result.about_candidates?.[0]?.chosen_text], "m-1: the quality judge is shown the about-page text");
        assertTrue(j.factsPages.includes("https://tveras.no/om-oss"), "m-2: the facts judge is shown the about page itself");
        assertEq(m.result.about_reviews?.length, 1, "m-3: one about review in the answer");
        const rj = stubJudges({ quality: "AVVIS" });
        const mr = await run("tveras", { dryRun: false, flag: true, judges: rj });
        const x = mr.result.about_candidates?.[0];
        assertEq(
          [x?.about_page_judge_rejected, x?.chosen, rj.candidates.length],
          ["about: kvalitetsdommer AVVIS", "homepage", 2],
          "m-4: AVVIS on the about page -> the homepage candidate is judged next",
        );
        assertEq([x?.would_write_about, x?.about_gate_reason], [false, "about: kvalitetsdommer AVVIS"], "m-5: … also AVVIS: not written, and the report says why");
        assertEq(row(mr.db, "tveras").about, null, "m-6: nothing written to about");
      }

      // ── (n) Økologi S3b gate applies to the about-page text ──────────────
      {
        const prevGate = process.env[ORGANIC_CLAIM_GATE_ENV];
        process.env[ORGANIC_CLAIM_GATE_ENV] = "1";
        try {
          const n = await run("okogard", { dryRun: false, flag: true });
          const x = n.result.about_candidates?.[0];
          assertEq(x?.about_page_refusal, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "n-1: an «økologisk» about page without Debio status is refused");
          assertEq([x?.chosen, x?.chosen_source_url], ["homepage", "https://okogard.no/"], "n-2: … the homepage candidate is used instead");
          assertEq(row(n.db, "okogard").about, HOME_META, "n-3a: … and written");
          assertTrue(
            !n.result.skipped_unsubstantiated.some((s: any) => s.agent_id === "okogard"),
            "n-3: the homepage text was written, so the about-page refusal is NOT in skipped_unsubstantiated (the morning send's `rejected`)",
          );
          assertTrue(!String(row(n.db, "okogard").about ?? "").toLowerCase().includes("økologisk"), "n-4: no organic claim was written");
          // Nothing about/description written at all: the refusal is reported after the agent's own reasons.
          const nNone = await run("okogard", { dryRun: false, flag: true, judges: stubJudges({ quality: "AVVIS" }) });
          const reasons = nNone.result.skipped_unsubstantiated.filter((s: any) => s.agent_id === "okogard").map((s: any) => s.reason);
          assertEq(reasons, ["about: kvalitetsdommer AVVIS", REFUSED_ORGANIC_CLAIM_UNVERIFIED], "n-6: nothing written -> the homepage's reason first, then the about-page refusal");
          // The morning send's own reading of it (rfb-marketing-daily: first reason = `rejected`).
          const { refreshRfbCandidateHomepage } = require("../services/rfb-marketing-daily") as typeof import("../services/rfb-marketing-daily");
          process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "1";
          const ms = freshDb();
          const prevJ = (globalThis as any)[Symbol.for("lokal.admin-knowledge.hcrAboutJudgesOverride")];
          (require("./admin-knowledge") as typeof import("./admin-knowledge")).__setHcrAboutJudgesForTesting(stubJudges());
          try {
            const sendRow = await refreshRfbCandidateHomepage(ms as any, "okogard", { deadlineAt: Date.now() + 30_000, fetchImpl: makeFetch([]) });
            assertEq([sendRow.outcome, sendRow.rejected], ["refreshed", undefined], "n-7: morning send: homepage text written -> `rejected` is not the about-page refusal");
          } finally {
            (require("./admin-knowledge") as typeof import("./admin-knowledge")).__setHcrAboutJudgesForTesting(prevJ ?? null);
            delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
          }
        } finally {
          if (prevGate === undefined) delete process.env[ORGANIC_CLAIM_GATE_ENV];
          else process.env[ORGANIC_CLAIM_GATE_ENV] = prevGate;
        }
        const nOff = await run("okogard", { dryRun: true, aboutPagePreview: true });
        assertEq(nOff.result.about_candidates?.[0]?.chosen, "about_page", "n-5: gate off -> the about page is chosen as before");
      }

      // ── (o) review: a judge's "no" on the about-page text -> homepage fallback ─
      {
        const { HCR_ABOUT_REASON_QUALITY_REJECTED: AVVIS_R, HCR_ABOUT_REASON_NOT_SUPPORTED: NS_R, HCR_ABOUT_REASON_NOT_BETTER: NB_R, HCR_ABOUT_REASON_JUDGE_UNAVAILABLE: UN_R } =
          require("./admin-knowledge") as typeof import("./admin-knowledge");
        // Quality AVVIS, dry-run preview: reported.
        const j1 = stubJudges({ avvisIf: ABOUT_MARKER });
        const o1 = await run("tveras", { dryRun: true, aboutPagePreview: true, judges: j1 });
        const x1 = o1.result.about_candidates?.[0];
        assertEq(j1.candidates, [ABOUT_TEXT, HOME_META], "o-1: the about-page text is judged first, then the homepage candidate");
        assertEq(
          [x1?.about_page_judge_rejected, x1?.chosen, x1?.chosen_text, x1?.chosen_source_url, x1?.would_write_about],
          [AVVIS_R, "homepage", HOME_META, "https://tveras.no/", true],
          "o-2: preview reports the AVVIS and that the homepage text would be written",
        );
        assertEq(
          o1.result.about_reviews.map((r: any) => [r.about_review.source, r.about_review.decision, r.about_review.candidate]),
          [["about_page", "skip", ABOUT_TEXT], ["homepage", "write", HOME_META]],
          "o-3: one about_reviews entry per judged candidate",
        );
        assertTrue(!o1.result.skipped_unsubstantiated.some((s: any) => s.agent_id === "tveras"), "o-4: the about-page AVVIS is not a skip reason when the homepage text is written");
        // Quality AVVIS, apply: HOME_META written with the homepage as source.
        const o2 = await run("tveras", { dryRun: false, flag: true, judges: stubJudges({ avvisIf: ABOUT_MARKER }) });
        const r2 = row(o2.db, "tveras");
        assertEq([r2.about, r2.description], [HOME_META, HOME_META], "o-5: apply writes the homepage text");
        assertEq(JSON.parse(r2.field_provenance).about[0].source_url, "https://tveras.no/", "o-6: … with the homepage as source_url");
        // Facts NOT_SUPPORTED, apply.
        const o3 = await run("tveras", { dryRun: false, flag: true, judges: stubJudges({ notSupportedIf: ABOUT_MARKER }) });
        assertEq(row(o3.db, "tveras").about, HOME_META, "o-7: NOT_SUPPORTED on the about page -> homepage text written");
        assertEq(o3.result.about_candidates?.[0]?.about_page_judge_rejected, NS_R, "o-8: … reported as not supported");
        // Comparison IKKE_BEDRE (stored about present), apply.
        const o4 = await run("tveras2", { dryRun: false, flag: true, judges: stubJudges({ notBetterIf: ABOUT_MARKER }) });
        assertEq(row(o4.db, "tveras2").about, HOME_META, "o-9: IKKE_BEDRE on the about page -> homepage text judged and written");
        assertEq(o4.result.about_candidates?.[0]?.about_page_judge_rejected, NB_R, "o-10: … reported as not better");
        // A judge that could not answer: no fallback.
        const j5 = stubJudges({ factsUnavailableIf: ABOUT_MARKER });
        const o5 = await run("tveras", { dryRun: false, flag: true, judges: j5 });
        assertEq(row(o5.db, "tveras").about, null, "o-11: unavailable judge on the about page -> no fallback, nothing written");
        assertEq(j5.candidates, [ABOUT_TEXT], "o-12: … the homepage candidate is never judged");
        assertEq(
          [o5.result.about_candidates?.[0]?.chosen, o5.result.about_candidates?.[0]?.about_gate_reason],
          ["about_page", UN_R],
          "o-13: … the report keeps the about page and says the judge was unavailable",
        );
        assertTrue(o5.result.skipped_unsubstantiated.some((s: any) => s.agent_id === "tveras" && s.reason === UN_R), "o-14: … and skipped_unsubstantiated says so");
        // Deadline: the about-page judge answers too late to start the homepage judge.
        const deadlineAt = Date.now() + 1500;
        const j6 = stubJudges({ avvisIf: ABOUT_MARKER, timeoutMs: 500, delay: { marker: ABOUT_MARKER, until: deadlineAt - 250 } });
        const o6 = await run("tveras", { dryRun: false, flag: true, judges: j6, deadlineAt });
        assertEq(j6.candidates, [ABOUT_TEXT], "o-15: no time left for another judge -> the homepage candidate is not judged");
        assertTrue(o6.result.errors.some((e: any) => e.agent_id === "tveras" && e.error.startsWith("refresh_deadline_exceeded")), "o-16: … the profile is not reached");
        assertEq(row(o6.db, "tveras").about, null, "o-17: … and nothing is written");
        // The homepage candidate failed one of its own guards (S3b): no fallback, and its reason is not emitted.
        const prevGate = process.env[ORGANIC_CLAIM_GATE_ENV];
        process.env[ORGANIC_CLAIM_GATE_ENV] = "1";
        try {
          const j7 = stubJudges({ avvisIf: ABOUT_MARKER });
          const o7 = await run("okohjem", { dryRun: false, flag: true, judges: j7 });
          assertEq(j7.candidates, [ABOUT_TEXT], "o-18: homepage text refused by its own guard -> not judged");
          assertEq(
            o7.result.skipped_unsubstantiated.filter((s: any) => s.agent_id === "okohjem").map((s: any) => s.reason),
            [AVVIS_R],
            "o-19: only the about-page AVVIS is reported — not the homepage's own reason, since no fallback was attempted",
          );
          assertEq(row(o7.db, "okohjem").about, null, "o-20: nothing written");
        } finally {
          if (prevGate === undefined) delete process.env[ORGANIC_CLAIM_GATE_ENV];
          else process.env[ORGANIC_CLAIM_GATE_ENV] = prevGate;
        }
      }

      // ── (p) review: a judge not started before the deadline is in the report ─
      {
        const p1 = await run("tveras", { dryRun: true, aboutPagePreview: true, judges: stubJudges({ timeoutMs: 10_000 }), deadlineAt: Date.now() + 5_000 });
        const x = p1.result.about_candidates?.[0];
        assertTrue(p1.result.errors.some((e: any) => e.agent_id === "tveras" && e.error.startsWith("refresh_deadline_exceeded")), "p-1: quality judge not started (less than its timeout left)");
        assertEq([x?.about_gate_reason, x?.would_write_about], ["refresh_deadline_exceeded", false], "p-2: about_gate_reason says refresh_deadline_exceeded");
      }

      // ── (i) route: about_page_preview is honoured only in a dry run ───────
      const { __setHcrAboutJudgesForTesting } = require("./admin-knowledge") as typeof import("./admin-knowledge");
      __setHcrAboutJudgesForTesting(stubJudges());
      {
        delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        freshDb();
        globalThis.fetch = makeFetch([]);
        const dry = await callRoute(homepageContentRefreshRouter, { agentIds: ["tveras"], about_page_preview: true });
        assertEq(dry.status, 200, "i-1: dry-run preview -> 200");
        assertEq(dry.body?.about_page_mode, "dry_run_preview", "i-2: the route passes the preview through in a dry run");
        assertEq(dry.body?.about_candidates?.[0]?.chosen_source_url, "https://tveras.no/om-oss", "i-3: … and the response carries the about candidate");
        assertTrue(!("about_page_preview_ignored" in (dry.body ?? {})), "i-4: … not flagged as ignored");
        const plain = await callRoute(homepageContentRefreshRouter, { agentIds: ["tveras"] });
        assertTrue(!("about_page_mode" in (plain.body ?? {})) && !("about_candidates" in (plain.body ?? {})), "i-5: no preview -> no about keys");
        const db = freshDb();
        const ap = await callRoute(homepageContentRefreshRouter, { agentIds: ["tveras"], apply: true, about_page_preview: true });
        assertEq(ap.status, 200, "i-6: apply + preview -> 200");
        assertEq(ap.body?.about_page_preview_ignored, "apply", "i-7: the preview is ignored with apply, and said so");
        assertTrue(!("about_candidates" in (ap.body ?? {})), "i-8: no about candidates in the apply response");
        assertEq((db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = 'tveras'").get() as any).about, HOME_META, "i-9: apply wrote the homepage candidate, not the about page");
        // apply in the QUERY (?apply=1), preview in the body.
        const qdb = freshDb();
        const q = await callRoute(homepageContentRefreshRouter, { agentIds: ["tveras"], about_page_preview: true }, { apply: "1" });
        assertEq([q.status, q.body?.dry_run], [200, false], "i-10: ?apply=1 + preview in the body -> an apply run");
        assertEq(q.body?.about_page_preview_ignored, "apply", "i-11: … the preview is ignored and said so");
        assertTrue(!("about_page_mode" in (q.body ?? {})) && !("about_candidates" in (q.body ?? {})), "i-12: … no preview logic ran");
        assertEq((qdb.prepare("SELECT about FROM agent_knowledge WHERE agent_id = 'tveras'").get() as any).about, HOME_META, "i-13: … the homepage candidate was written");
        // Env flag on + apply + preview: the logic runs on the flag; nothing is "ignored".
        freshDb();
        process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "1";
        const fl = await callRoute(homepageContentRefreshRouter, { agentIds: ["tveras"], apply: true, about_page_preview: true });
        delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
        assertEq(fl.body?.about_page_mode, "env_flag", "i-14: flag on + apply -> about_page_mode env_flag");
        assertTrue(!("about_page_preview_ignored" in (fl.body ?? {})), "i-15: … and no contradictory about_page_preview_ignored");
      }
    } catch (err: any) {
      failed++;
      failures.push("homepage-content-refresh-about-page: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      try {
        (require("./admin-knowledge") as typeof import("./admin-knowledge")).__setHcrAboutJudgesForTesting(null);
      } catch {
        /* module not loaded */
      }
      globalThis.fetch = prevFetch;
      if (prevFlag === undefined) delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
      else process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = prevFlag;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      initMod.__setDbForTesting(prevDb as any);
      for (const db of opened) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageContentRefreshAboutPageTests({ log: true }).then((r) => {
    console.log(`\nhomepage-content-refresh-about-page: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
