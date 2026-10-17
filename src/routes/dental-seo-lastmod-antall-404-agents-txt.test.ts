/**
 * dental-seo-lastmod-antall-404-agents-txt.test.ts -- dev-request
 * 2026-10-17-integrasjonstest-oppfolging, skive I-Q (integrasjonstest runde 2).
 *
 *   IDX2-01  sitemap <lastmod> for /klinikk is a W3C date (YYYY-MM-DD); it was
 *            SQLite datetime ("2026-07-21 11:39:18") on every clinic URL. A
 *            missing or junk updated_at gives no <lastmod>, never the build
 *            day (dev-request 2026-10-17-dental-d3-rettelser, D3b).
 *   IDX2-02  the clinic meta «Det finnes N klinikker i X» gives the count
 *            /sted/<x> shows; it was a related-clinics list capped at 20, + 1.
 *            /sted/<x> counts every spelling of the place (D3b).
 *   RYS-1    every HTML 404 (catch-all and the seven route branches) sends
 *            robots "noindex, follow"; it inherited "index, follow".
 *   MCP-02   agents.txt API-base is /api/tannlege (the REST mount), not the
 *            404 /api/tannleger.
 *
 * Same harness as dental-inactive-hidden.test.ts (in-memory dental DB, the
 * router driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-seo-lastmod-antall-404-agents-txt.test.ts
 * Wired into tests/test.ts via runDentalSeoLastmodAntall404AgentsTxtTests().
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
  json: any;
}

function callRoute(router: any, urlPath: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: urlPath,
      originalUrl: urlPath,
      path: urlPath,
      params: {},
      query: {},
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) {
        resolve({ status: this.statusCode, text: String(payload ?? ""), json: undefined });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, text: JSON.stringify(payload), json: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err), json: undefined });
      else resolve({ status: 404, text: "unhandled", json: undefined });
    });
  });
}

function metaContent(html: string, attr: "name" | "property", key: string): string[] {
  const re = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`, "g");
  return Array.from(html.matchAll(re), (m) => m[1]!);
}

export async function runDentalSeoLastmodAntall404AgentsTxtTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

    // ── fixture ──────────────────────────────────────────────────────────
    // OSLO: 25 public clinics (24 + one with its own description; more than
    // the old cap of 20), plus a closed and a rejected one the count must
    // leave out. HALDEN: 2 (old and new agree). SOLOBY: 1 (no sentence).
    // BERGEN/Bergen: two spellings of one slug. All rows have address +
    // phone, so none is thin.
    let orgSeq = 918950000;
    const mk = (navn: string, poststed: string, fylke: string, extra: { inactive?: boolean; rejected?: boolean; omOss?: string } = {}): { id: string; slug: string } => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({
        navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', is_inactive = ?, verification_status = ?, om_oss = ? WHERE id = ?")
        .run(extra.inactive ? 1 : 0, extra.rejected ? "rejected" : "unverified", extra.omOss ?? null, id);
      return { id, slug: dentalSeo.slugifyClinic(navn, org_nr) };
    };
    const oslo: Array<{ id: string; slug: string }> = [];
    for (let i = 1; i <= 24; i++) oslo.push(mk(`Klinikk ${String(i).padStart(2, "0")} AS`, "OSLO", "Oslo"));
    const osloClosed = mk("Nedlagt Klinikk AS", "OSLO", "Oslo", { inactive: true });
    const osloRejected = mk("Avvist Klinikk AS", "OSLO", "Oslo", { rejected: true });
    const osloRich = mk("Rik Klinikk AS", "OSLO", "Oslo", {
      omOss: "Rik Klinikk er en moderne tannlegeklinikk i Oslo sentrum med lang erfaring innen estetisk tannbehandling.",
    });
    const halden = [mk("Halden Tann AS", "HALDEN", "Østfold"), mk("Fredriksten Tann AS", "HALDEN", "Østfold")];
    const solo = mk("Eneste Tann AS", "SOLOBY", "Innlandet");
    const bergenUpper = [mk("Bryggen Tann AS", "BERGEN", "Vestland"), mk("Nordnes Tann AS", "BERGEN", "Vestland"), mk("Sandviken Tann AS", "BERGEN", "Vestland")];
    const bergenLower = mk("Fana Tann AS", "Bergen", "Vestland");

    // updated_at as prod stores it (SQLite datetime), as ISO, missing, and junk.
    const setUpdatedAt = (id: string, v: string | null) => db.prepare("UPDATE dental_agents SET updated_at = ? WHERE id = ?").run(v, id);
    setUpdatedAt(oslo[0]!.id, "2026-07-21 11:39:18");
    setUpdatedAt(oslo[1]!.id, "2026-08-02T09:15:00.000Z");
    setUpdatedAt(oslo[2]!.id, null);
    setUpdatedAt(oslo[3]!.id, "ukjent");

    const today = new Date().toISOString().slice(0, 10);
    const stedCount = (html: string): number | null => {
      const m = html.match(/([\d\s\u00a0\u202f]+) klinikker registrert/);
      return m ? Number(m[1]!.replace(/\D/g, "")) : null;
    };
    const finnesSentence = (html: string): string | null => {
      const desc = metaContent(html, "name", "description")[0] ?? "";
      const m = desc.match(/Det finnes (\d+) klinikker i ([^.]+)\./);
      return m ? m[0] : null;
    };

    // ── A. IDX2-01: sitemap lastmod is a W3C date ────────────────────────
    {
      dentalSeo.__resetDentalSitemapCacheForTesting();
      const sm = await callRoute(router, "/sitemap.xml");
      assertEq(sm.status, 200, "A1: GET /sitemap.xml -> 200");
      // /klinikk/<slug> -> its <lastmod> (null when the URL has none), from each <url>.
      const klinikkLastmod = new Map<string, string | null>();
      for (const m of sm.text.matchAll(/<url>(.*?)<\/url>/g)) {
        const loc = (m[1]!.match(/<loc>([^<]*)<\/loc>/) || [])[1] ?? "";
        if (loc.startsWith(`${base}/klinikk/`)) {
          klinikkLastmod.set(loc.slice(`${base}/klinikk/`.length), (m[1]!.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] ?? null);
        }
      }
      const lastmodFor = (slug: string): string | null | undefined => klinikkLastmod.get(slug);
      assertEq(lastmodFor(oslo[0]!.slug), "2026-07-21", "A2: SQLite datetime updated_at -> date only (regression: was «2026-07-21 11:39:18»)");
      assertEq(lastmodFor(oslo[1]!.slug), "2026-08-02", "A3: ISO updated_at -> date only");
      assertEq(lastmodFor(oslo[2]!.slug), null, "A4: missing updated_at -> listed with no <lastmod> (D3b; regression: the build day)");
      assertEq(lastmodFor(oslo[3]!.slug), null, "A5: updated_at that is not a date -> listed with no <lastmod> (D3b; regression: the build day)");
      assertTrue(!sm.text.includes("ukjent"), "A5b: the junk value is echoed nowhere in the sitemap");
      // createDentalAgent stamps datetime('now') — the shape of every prod row.
      assertEq(lastmodFor(oslo[4]!.slug), today, "A6: default datetime('now') updated_at -> today's date");
      const all = Array.from(sm.text.matchAll(/<lastmod>([^<]*)<\/lastmod>/g), (m) => m[1]!);
      const klinikkCount = (sm.text.match(/\/klinikk\//g) || []).length;
      assertTrue(klinikkCount >= 30, `A7: fixture sanity — sitemap lists the clinics (${klinikkCount})`);
      assertTrue(all.length > klinikkCount, "A8: fixture sanity — sitemap has non-clinic URLs too");
      assertEq(all.filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v)), [], "A9: every <lastmod> in the sitemap is YYYY-MM-DD");

      // D3b: a /klinikk URL carries the build day only when its own row
      // changed that day; no row falls back to it.
      const updatedAtBySlug = new Map(store.getDentalAgentsForSitemap().map((r) => [dentalSeo.slugifyClinic(r.navn, r.org_nr), r.updated_at]));
      const todays = [...klinikkLastmod].filter(([, d]) => d === today);
      assertTrue(todays.length > 0, "A10a: fixture sanity — rows created today carry today");
      assertEq(todays.filter(([slug]) => !String(updatedAtBySlug.get(slug) ?? "").startsWith(today)).map(([slug]) => slug), [], "A10: no /klinikk lastmod is the build day without an updated_at from that day");
    }

    // ── B. IDX2-02: «Det finnes N klinikker i X» = the /sted count ───────
    {
      const stedOslo = await callRoute(router, "/sted/oslo");
      assertEq(stedOslo.status, 200, "B1: /sted/oslo -> 200");
      assertEq(stedCount(stedOslo.text), 25, "B2: /sted/oslo shows 25 (closed + rejected left out)");

      const page = await callRoute(router, `/klinikk/${oslo[5]!.slug}`);
      assertEq(page.status, 200, "B3: OSLO clinic page -> 200");
      assertEq(finnesSentence(page.text), "Det finnes 25 klinikker i Oslo.", "B4: meta description gives the /sted count (regression: was «Det finnes 21 klinikker i Oslo.»)");
      assertTrue(!page.text.includes("Det finnes 21 klinikker"), "B5: the capped «21» is gone from the page");
      const desc = metaContent(page.text, "name", "description")[0];
      assertEq(metaContent(page.text, "property", "og:description"), [desc], "B6: og:description carries the same text");
      assertEq(metaContent(page.text, "name", "twitter:description"), [desc], "B7: twitter:description carries the same text");

      const closedPage = await callRoute(router, `/klinikk/${osloClosed.slug}`);
      assertEq(finnesSentence(closedPage.text), "Det finnes 25 klinikker i Oslo.", "B8: a closed clinic's page gives the same /sted count");

      const rich = await callRoute(router, `/klinikk/${osloRich.slug}`);
      assertEq(finnesSentence(rich.text), null, "B9: a clinic with its own description keeps it (no count sentence)");
      assertTrue((metaContent(rich.text, "name", "description")[0] ?? "").startsWith("Rik Klinikk er en moderne"), "B10: rich om_oss meta unchanged");

      // HALDEN: 2 clinics — the old «others + 1» gave the same number.
      const haldenPage = await callRoute(router, `/klinikk/${halden[0]!.slug}`);
      assertEq(finnesSentence(haldenPage.text), "Det finnes 2 klinikker i Halden.", "B11: small place unchanged (2 clinics)");
      assertEq(stedCount((await callRoute(router, "/sted/halden")).text), 2, "B12: /sted/halden agrees (2)");

      const soloPage = await callRoute(router, `/klinikk/${solo.slug}`);
      assertEq(soloPage.status, 200, "B13: single-clinic place page -> 200");
      assertEq(finnesSentence(soloPage.text), null, "B14: one clinic in the place -> no count sentence (never «1 klinikker»)");

      // Two spellings, one slug: /sted and the clinic page count both (D3b).
      const stedBergen = await callRoute(router, "/sted/bergen");
      const nBergen = stedCount(stedBergen.text);
      assertEq(nBergen, 4, "B15: /sted/bergen counts both spellings, BERGEN 3 + Bergen 1 (D3b; regression: 3, BERGEN only)");
      for (const c of [bergenUpper[0]!, bergenLower]) {
        const p = await callRoute(router, `/klinikk/${c.slug}`);
        assertEq(finnesSentence(p.text), `Det finnes ${nBergen} klinikker i Bergen.`, `B16: ${c.slug} gives the /sted/bergen count`);
      }

      // Rejected rows still 404 (the count change must not open them up).
      assertEq((await callRoute(router, `/klinikk/${osloRejected.slug}`)).status, 404, "B17: rejected clinic still 404");

      // The slug map follows the 60 s poststed cache: a new place appears on
      // /sted and in the clinic meta once the cache refreshes, not before.
      const nyby = [mk("Nyby Tann AS", "NYBY", "Oslo"), mk("Nyby Sentrum Tann AS", "NYBY", "Oslo")];
      assertEq((await callRoute(router, "/sted/nyby")).status, 404, "B18: a place added inside the cache TTL is not on /sted yet");
      assertEq(finnesSentence((await callRoute(router, `/klinikk/${nyby[0]!.slug}`)).text), null, "B19: …nor in the clinic meta");
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 61_000;
        assertEq(stedCount((await callRoute(router, "/sted/nyby")).text), 2, "B20: after the TTL /sted/nyby shows 2");
        assertEq(finnesSentence((await callRoute(router, `/klinikk/${nyby[0]!.slug}`)).text), "Det finnes 2 klinikker i Nyby.", "B21: after the TTL the clinic meta gives the same 2");
      } finally {
        Date.now = realNow;
      }
    }

    // ── C. buildClinicDescription unit ───────────────────────────────────
    {
      const agent = { navn: "Test Tann AS", poststed: "OSLO", fylke: "Oslo", opening_hours: [] } as any;
      assertTrue(dentalSeo.buildClinicDescription(agent, 978, true).includes("Det finnes 978 klinikker i Oslo."), "C1: count is printed as given (no +1, no cap)");
      assertTrue(!dentalSeo.buildClinicDescription(agent, 1, true).includes("Det finnes"), "C2: count 1 -> no sentence");
      assertTrue(!dentalSeo.buildClinicDescription(agent, 0, true).includes("Det finnes"), "C3: count 0 -> no sentence");
      assertTrue(!dentalSeo.buildClinicDescription(agent, undefined, true).includes("Det finnes"), "C4: no count -> no sentence");
      assertTrue(!dentalSeo.buildClinicDescription(agent, 978, false).includes("Det finnes"), "C5: full (JSON-LD) variant never has the sentence");
      assertTrue(!dentalSeo.buildClinicDescription({ ...agent, poststed: "Ukjent", fylke: "Ukjent" }, 978, true).includes("Det finnes"), "C6: invalid poststed -> no sentence");
    }

    // ── D. RYS-1: every 404 is noindex, follow ───────────────────────────
    {
      const notFound: Array<[string, string]> = [
        ["/finnes-ikke-404", "catch-all"],
        ["/klinikk/id/finnes-ikke", "/klinikk/id unknown id"],
        ["/klinikk/ikke-en-gyldig-slug", "/klinikk slug without org.nr"],
        ["/klinikk/ukjent-klinikk--999999999", "/klinikk unknown org.nr"],
        [`/klinikk/${osloRejected.slug}`, "/klinikk rejected clinic"],
        ["/fylke/Atlantis", "/fylke unknown"],
        ["/spesialitet/finnes-ikke", "/spesialitet unknown"],
        ["/sted/finnes-ikke", "/sted unknown"],
      ];
      for (const [p, label] of notFound) {
        const r = await callRoute(router, p);
        assertEq(r.status, 404, `D1: ${label} -> 404`);
        assertEq(metaContent(r.text, "name", "robots"), ["noindex, follow"], `D2: ${label} has exactly one robots meta, "noindex, follow"`);
      }
      const indexable = ["/", "/sted/oslo", "/fylke/Oslo", `/klinikk/${oslo[5]!.slug}`];
      for (const p of indexable) {
        const r = await callRoute(router, p);
        assertEq(r.status, 200, `D3: ${p} -> 200`);
        assertEq(metaContent(r.text, "name", "robots"), ["index, follow, max-snippet:-1, max-image-preview:large"], `D4: ${p} keeps the default robots`);
      }
      // A 404 added later cannot skip the helper by calling the shell directly.
      const src = fs.readFileSync(path.join(__dirname, "dental-seo.ts"), "utf8");
      assertEq((src.match(/status\(404\)\s*\.send\(\s*dentalShell\(/g) || []).length, 1, "D5: the only status(404)+dentalShell call is inside sendDentalNotFound");
    }

    // ── E. MCP-02: agents.txt API-base ───────────────────────────────────
    {
      const wk = await callRoute(router, "/.well-known/agents.txt");
      const root = await callRoute(router, "/agents.txt");
      assertEq(wk.status, 200, "E1: /.well-known/agents.txt -> 200");
      assertTrue(root.text === wk.text, "E2: /agents.txt is the same file");
      const apiBase = (wk.text.match(/^API-base: (.+)$/m) || [])[1];
      assertEq(apiBase, `${base}/api/tannlege`, "E3: API-base is /api/tannlege");
      assertTrue(!/\/api\/tannleger/.test(wk.text), "E4: no /api/tannleger (the 404) anywhere in agents.txt");
      for (const k of ["Agent-card", "MCP-endpoint", "MCP-server-card", "A2A-endpoint", "Rate-limit"]) {
        assertTrue(new RegExp(`^${k}: `, "m").test(wk.text), `E5: ${k} line still present`);
      }
      // The advertised base is the real REST mount and the openapi.json prefix.
      const basePath = apiBase ? new URL(apiBase).pathname : "";
      const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
      assertTrue(indexSrc.includes(`app.use("${basePath}", dentalRoutes)`), `E6: index.ts mounts the dental REST router at ${basePath}`);
      const spec = await callRoute(router, "/openapi.json");
      const restPaths = Object.keys(spec.json?.paths || {}).filter((p) => p.startsWith("/api/"));
      assertTrue(restPaths.length > 0, "E7: fixture sanity — openapi.json has REST paths");
      assertEq(restPaths.filter((p) => !p.startsWith(`${basePath}/`)), [], "E8: every REST path in openapi.json sits under API-base");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental seo I-Q: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalSeoLastmodAntall404AgentsTxtTests({ log: true }).then((r) => {
    console.log(`\ndental seo I-Q: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
