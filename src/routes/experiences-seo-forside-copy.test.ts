/**
 * experiences-seo-forside-copy.test.ts — dev-request
 * 2026-10-16-opplevagent-stedssider-kvalitet, E4-S3: the Norwegian front
 * page is written around gårdssalg, smaking and local drink producers
 * (Daniel's decision 1=B, 2026-10-17), the developer language is gone, the
 * published catalog stays reachable, and English and Swedish keep their copy
 * (decision 6=A).
 *
 * Covers:
 *   (a) AC1 on GET / (no): <title> ≤70 characters and names gårdssalg; the
 *       <h1> names «Gårdssalg» or «smaking»; the meta, og and twitter
 *       descriptions say neither «søkbar for AI-agenter», «hvalsafari» nor
 *       «trehytter»; the pill has no «A2A». Plus: none of the changed
 *       strings (meta/og, hero, search placeholder, agents H2) carries
 *       developer language, and og:image:alt still starts with «Opplevagent»
 *       (experiences-seo-og-png.test.ts og-d4).
 *   (b) AC2: the search form, the nav links «Alle opplevelser» and
 *       «Kategorier», the hint link and the «Alle opplevelser» quick chip are
 *       still on the page, and the category grid still lists real
 *       experience categories.
 *   (c) AC3: homeStrings("en") and homeStrings("sv") equal their copy at main
 *       a312b909 (whole-object SHA-256, and the E4-S3 fields verbatim so a
 *       failure names the field); GET / (en) renders that copy, not the new
 *       Norwegian one.
 *   (d) the one exception to AC3: the front page's Organization description
 *       is one Norwegian string for every language. It follows the new
 *       positioning on both / and /en, and every other Organization field is
 *       still exactly organizationJsonLd("experiences") (owned by
 *       dev-request 2026-10-16-merkevare-entitet-og-connector-pakker).
 *
 * No assertion pins the new Norwegian wording, so it can be refined without
 * touching this file; the checks are the acceptance criteria themselves.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-forside-copy.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { createHash } from "crypto";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling forside test files.
// `lang` mirrors what the /en rewrite middleware stamps on req.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() {},
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible text of the first match's capture group: tags stripped, entities decoded. */
function textOf(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? unescapeHtml(m[1].replace(/<[^>]*>/g, "")).replace(/&mdash;/g, "—") : null;
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const m = html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`));
  return m ? unescapeHtml(m[1]) : null;
}

function jsonLdBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(JSON.parse(m[1]));
  return out;
}

const sha256 = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const charCount = (s: string): number => [...s].length;

// The homeStrings() fields E4-S3 rewrote for `no`.
const E4S3_FIELDS = [
  "metaTitle", "metaDesc", "ogTitle", "ogImageAlt", "heroPill",
  "heroH1", "heroAccent", "heroSub", "searchPlaceholder", "agentsTitle",
] as const;

// ── Frozen copies of `en` and `sv` at main a312b909 (before E4-S3) ──────────
// Decision 6=A: English waits for the week-47 data, so these must not move
// in this slice. When the English/Swedish copy is decided, update both the
// hashes (sha256 of JSON.stringify(homeStrings(lang))) and the fields here.
const FROZEN_HASH = {
  en: "2f2927887cf441965d3b2d975fd55b68e0c1484b7c2e1b2f57d68bd0ac7a2619",
  sv: "7c4531c43b710905799c586bc43457451ea734886230093c7522542a51a70f15",
};
const FROZEN_FIELDS: Record<"en" | "sv", Record<(typeof E4S3_FIELDS)[number], string>> = {
  en: {
    metaTitle: "Opplevagent — curated marketplace for Norwegian experiences",
    metaDesc: "Opplevagent is a curated marketplace for Norwegian experiences and activities — whale safaris, treehouses, guided tours, food and more. Searchable for AI agents by place, weather, season and group size.",
    ogTitle: "Opplevagent — Norwegian experiences, searchable for AI agents",
    ogImageAlt: "Opplevagent — marketplace for Norwegian experiences",
    heroPill: "A2A marketplace for Norwegian experiences",
    heroH1: "What can we do ",
    heroAccent: "today?",
    heroSub: "From whale safaris and treehouses to mountain hikes, food experiences and laser tag &mdash; hand-picked Norwegian experiences, gathered in one place.",
    searchPlaceholder: "Search: whale safari, Oslo, food …",
    agentsTitle: "Built to be queried by agents",
  },
  sv: {
    metaTitle: "Opplevagent — norska upplevelser, handplockade och verifierade",
    metaDesc: "Handplockade norska upplevelser och aktiviteter — valsafari, trädkojor, guidade turer, mat och mer. Alla arrangörer är verifierade mot Brønnøysundregistrene, och katalogen är sökbar för AI-agenter.",
    ogTitle: "Opplevagent — norska upplevelser, sökbara för AI-agenter",
    ogImageAlt: "Opplevagent — marknadsplats för norska upplevelser",
    heroPill: "A2A-marknadsplats för norska upplevelser",
    heroH1: "Vad ska vi hitta på ",
    heroAccent: "i dag?",
    heroSub: "Från valsafari och trädkojor till fjällturer, matupplevelser och lasertag &mdash; handplockade norska upplevelser, samlade på ett ställe.",
    searchPlaceholder: "Sök: valsafari, Oslo, mat …",
    agentsTitle: "Byggt för att frågas av agenter",
  },
};

// Positioning: the words decision 1=B is about.
const ON_POSITION = /gårdssalg|smaking/i;
// Drink-producer words a search placeholder or hero sub can point at.
const DRINK_WORDS = /bryggeri|sideri|vingård|destilleri|mjøderi|gårdskafe|gårdssalg/i;
// Developer language the old Norwegian copy used (pill, H2, meta, og).
const DEV_LANGUAGE = [/A2A/, /AI-agent/i, /søkbar/i, /\bagenter\b/i, /spurt av/i];
// AC1: the old meta description's travel examples and AI claim.
const AC1_META_FORBIDDEN = ["søkbar for AI-agenter", "hvalsafari", "trehytter"];

function insertExperience(db: any, e: { id: string; title: string; category: string }): void {
  db.prepare(
    `INSERT INTO experiences (id, title, category, verification_status)
     VALUES (@id, @title, @category, 'verified')`
  ).run(e);
}

export function runExperiencesSeoForsideCopyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const { organizationJsonLd } = require("../services/company-legal") as typeof import("../services/company-legal");
      const router = seo.default as any;

      // Real experience categories, so the grid shows the published catalog
      // rather than the pre-data example cards.
      insertExperience(db, { id: "fc-exp-1", title: "Guidet fjelltur", category: "natur_friluft" });
      insertExperience(db, { id: "fc-exp-2", title: "Museumsomvisning", category: "kultur_historie" });

      const no = seo.homeStrings("no");
      const home = await callHtmlRoute(router, "/");
      const homeEn = await callHtmlRoute(router, "/", "en");
      assertTrue(home.handled && home.status === 200, `fc-a0: GET / renders 200 (got ${home.status})`);
      assertTrue(homeEn.handled && homeEn.status === 200, `fc-c0: GET / (en) renders 200 (got ${homeEn.status})`);

      // ── (a) AC1: title, H1, meta description, pill ───────────────────────
      {
        const titles = home.body.match(/<title>[\s\S]*?<\/title>/g) ?? [];
        const title = textOf(home.body, /<title>([\s\S]*?)<\/title>/) ?? "";
        assertTrue(titles.length === 1 && charCount(title) <= 70 && /gårdssalg/i.test(title),
          `fc-a1: one <title>, ≤70 characters, naming gårdssalg (got ${titles.length} × «${title}», ${charCount(title)} characters)`);

        const h1 = textOf(home.body, /<h1 id="hero-title">([\s\S]*?)<\/h1>/) ?? "";
        assertTrue((home.body.match(/<h1[\s>]/g) ?? []).length === 1 && /Gårdssalg|smaking/.test(h1),
          `fc-a2: the one <h1> names «Gårdssalg» or «smaking» (got «${h1}»)`);

        const descs = {
          description: metaContent(home.body, "name", "description"),
          "og:description": metaContent(home.body, "property", "og:description"),
          "twitter:description": metaContent(home.body, "name", "twitter:description"),
        };
        for (const [key, desc] of Object.entries(descs)) {
          const hits = AC1_META_FORBIDDEN.filter((w) => (desc ?? "").toLowerCase().includes(w.toLowerCase()));
          assertTrue(desc !== null && hits.length === 0,
            `fc-a3 ${key}: present and says none of ${AC1_META_FORBIDDEN.map((w) => `«${w}»`).join(", ")} (hits ${JSON.stringify(hits)})`);
        }
        assertTrue(ON_POSITION.test(descs.description ?? "") && /Brønnøysundregistrene/.test(descs.description ?? ""),
          `fc-a4: the meta description is about gårdssalg/smaking and keeps the Brønnøysund verification (got «${descs.description}»)`);

        const pill = textOf(home.body, /<span class="eyebrow">([\s\S]*?)<\/span>\s*<h1/) ?? "";
        assertTrue(pill.trim().length > 0 && !/A2A/.test(pill), `fc-a5: the hero pill has no «A2A» (got «${pill.trim()}»)`);

        // No developer language left in any string E4-S3 rewrote.
        const devHits: string[] = [];
        for (const f of E4S3_FIELDS) {
          for (const re of DEV_LANGUAGE) if (re.test(no[f])) devHits.push(`${f} ~ ${re}`);
        }
        assertTrue(devHits.length === 0, `fc-a6: no developer language in the rewritten no strings (hits ${JSON.stringify(devHits)})`);

        const h2 = textOf(home.body, /<h2 id="agent-title">([\s\S]*?)<\/h2>/) ?? "";
        assertTrue(ON_POSITION.test(h2) && !DEV_LANGUAGE.some((re) => re.test(h2)),
          `fc-a7: the agents H2 speaks to visitors about gårdssalg/smaking, not to developers (got «${h2}»)`);

        const ogTitle = metaContent(home.body, "property", "og:title") ?? "";
        const ogAlt = metaContent(home.body, "property", "og:image:alt") ?? "";
        assertTrue(ON_POSITION.test(ogTitle) && ON_POSITION.test(ogAlt) && ogAlt.startsWith("Opplevagent"),
          `fc-a8: og:title and og:image:alt follow the positioning, the alt still starts with «Opplevagent» (got «${ogTitle}» / «${ogAlt}»)`);

        const placeholder = (home.body.match(/<input id="discover-q"[^>]*placeholder="([^"]*)"/) ?? [])[1] ?? "";
        const sub = textOf(home.body, /<p class="hero-sub">([\s\S]*?)<\/p>/) ?? "";
        assertTrue(DRINK_WORDS.test(placeholder) && !/hvalsafari/i.test(placeholder),
          `fc-a9: the search placeholder suggests drink producers, not «hvalsafari» (got «${placeholder}»)`);
        assertTrue(DRINK_WORDS.test(sub) && !/hvalsafari|trehytter|lasertag/i.test(sub),
          `fc-a10: the hero sub names drink producers, not the old travel examples (got «${sub}»)`);
      }

      // ── (b) AC2: the published catalog is still reachable ────────────────
      {
        assertTrue(/<form class="discover-form" action="\/sok" method="GET" role="search"[^>]*>/.test(home.body)
          && /<input id="discover-q" name="q" type="search"/.test(home.body),
          "fc-b1: the search form (GET /sok, input q) is still on the front page");
        const nav = (home.body.match(/<nav class="nav-links"[^>]*>([\s\S]*?)<\/nav>/) ?? [])[1] ?? "";
        assertTrue(nav.includes('<a href="/opplevelser">Alle opplevelser</a>') || /<a href="\/opplevelser"[^>]*>Alle opplevelser<\/a>/.test(nav),
          "fc-b2: the nav link «Alle opplevelser» → /opplevelser is still there");
        assertTrue(/<a href="\/#kategorier"[^>]*>Kategorier<\/a>/.test(nav), "fc-b3: the nav link «Kategorier» → /#kategorier is still there");
        assertTrue(/<p class="discover-hint">[^<]*<a href="\/opplevelser"[^>]*>bla i alle opplevelser<\/a>/.test(home.body),
          "fc-b4: the hint link «bla i alle opplevelser» → /opplevelser is still there");
        assertTrue(/<a role="listitem" href="\/opplevelser">Alle opplevelser<\/a>/.test(home.body),
          "fc-b5: the «Alle opplevelser» quick chip is still there");
        const catStart = home.body.indexOf('id="kategorier"');
        const catSection = catStart < 0 ? "" : home.body.slice(catStart, home.body.indexOf("</section>", catStart));
        assertTrue(catSection.includes('href="/kategori/natur_friluft"') && catSection.includes('href="/kategori/kultur_historie"'),
          "fc-b6: the #kategorier grid still links the published experience categories");
      }

      // ── (c) AC3: English and Swedish unchanged ───────────────────────────
      {
        for (const lang of ["en", "sv"] as const) {
          const s = seo.homeStrings(lang);
          const drift = E4S3_FIELDS.filter((f) => s[f] !== FROZEN_FIELDS[lang][f]);
          assertTrue(drift.length === 0, `fc-c1 ${lang}: the E4-S3 fields equal their copy at main a312b909 (changed: ${JSON.stringify(drift)})`);
          assertTrue(sha256(s) === FROZEN_HASH[lang], `fc-c2 ${lang}: the whole homeStrings("${lang}") object equals main a312b909 (sha256 ${sha256(s)})`);
        }
        const en = seo.homeStrings("en");
        const enTitle = textOf(homeEn.body, /<title>([\s\S]*?)<\/title>/);
        const enH1 = textOf(homeEn.body, /<h1 id="hero-title">([\s\S]*?)<\/h1>/);
        const enPill = textOf(homeEn.body, /<span class="eyebrow">([\s\S]*?)<\/span>\s*<h1/)?.trim();
        assertTrue(enTitle === en.metaTitle && enH1 === en.heroH1 + en.heroAccent && enPill === en.heroPill
          && metaContent(homeEn.body, "name", "description") === en.metaDesc,
          `fc-c3: GET / (en) renders the English title, H1, pill and description (got «${enTitle}» / «${enH1}» / «${enPill}»)`);
        const newNo = [no.metaTitle, no.metaDesc, no.heroPill, no.heroSub, no.agentsTitle];
        assertTrue(newNo.every((t) => !homeEn.body.includes(t)), "fc-c4: none of the new Norwegian front-page strings leaks into the English page");
        assertTrue(no.metaTitle !== en.metaTitle && no.heroH1 !== en.heroH1,
          "fc-c5: sanity — the Norwegian copy did change while the English did not");
      }

      // ── (d) the Organization description (the one exception to AC3) ──────
      {
        const orgOf = (html: string) => jsonLdBlocks(html).filter((o) => o && o["@type"] === "Organization");
        const orgs = orgOf(home.body);
        const orgsEn = orgOf(homeEn.body);
        const desc: string = orgs[0]?.description ?? "";
        assertTrue(orgs.length === 1 && ON_POSITION.test(desc) && !/A2A/.test(desc) && /Brønnøysundregistrene/.test(desc),
          `fc-d1: the front page's one Organization describes gårdssalg/smaking without «A2A», Brønnøysund verification kept (got «${desc}»)`);
        assertTrue(orgsEn.length === 1 && orgsEn[0].description === desc,
          "fc-d2: the English front page carries the same Norwegian Organization description (one string for every language)");
        const withoutDesc = (o: Record<string, unknown>) => JSON.stringify({ ...o, description: undefined });
        const brand = organizationJsonLd("experiences");
        assertTrue(orgs.length === 1 && withoutDesc(orgs[0]) === withoutDesc(brand) && orgsEn.length === 1 && withoutDesc(orgsEn[0]) === withoutDesc(brand),
          "fc-d3: apart from description, the Organization is exactly organizationJsonLd(\"experiences\") on / and /en");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-forside-copy: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoForsideCopyTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    // Explicit exit: requiring the seo route module leaves live handles
    // (email-service/counter timers) on the event loop.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
