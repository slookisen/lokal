/**
 * gardssalg-owner-dashboard-o2-1.test.ts — dev-request 2026-11-12-opplevagent-
 * o2-eierdashbord-for-besok, slice O2-1: the gårdssalg owner dashboard shell
 * and the GARDSSALG_OWNER_DASHBOARD_ENABLED modes (off | pilot | 1).
 *
 *   (m)  flag modes: same parsing as the RFB owner flags (ownerFlagMode);
 *        pilot = `gardssalg:<id>` on OWNER_FEATURES_ALLOWED_SUBJECTS.
 *   AK1  flag off (unset, "0", "off", "Pilot", "pilot ") → the test
 *        producer's portal and «Mine valg» are byte-identical to the flag
 *        unset (headers included), carry no shell, and the new URLs are 404.
 *        With the flag on, taking the shell out gives the flag-off page.
 *   AK2  pilot + the test producer allowlisted → portal, «Mine besøk»,
 *        «Mine valg» and «Statistikk» answer 200 with the four tabs (one
 *        <nav>, one aria-current on the right tab).
 *   AK3  pilot → a gårdssalg profile off the list gets 404 on the dashboard
 *        URLs (and no shell on its portal); the test-producer lock holds in
 *        every mode (an allowlisted real producer → 404).
 *   AK4  every dashboard response is `Cache-Control: no-store`.
 *   (1)  flag "1" → all (no allowlist needed), the lock still applies.
 *   (g)  no session → 401, another producer → 403; the GETs write nothing.
 *   (t)  texts verbatim from tekstpakke OA-3 1.1; no «Rett fra Bonden».
 *
 * Exported runGardssalgOwnerDashboardO21Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-o2-1.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";
const TABS = ["Oversikt", "Mine besøk", "Mine valg", "Statistikk"];

export function runGardssalgOwnerDashboardO21Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    // «Mine valg» is open for the test producer, as in prod for the pilot.
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    const ALLOW = "gardssalg:o21-test,gardssalg:o21-real";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
    // The claim routes run the shared generalLimiter (one bucket for the
    // loopback client across suites): start from an empty bucket and leave
    // it empty, as owner-features-t5-anchors does.
    const LOOPBACK_KEY = "127.0.0.1";
    const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
    try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const gs = require("../owner-features/gardssalg") as typeof import("../owner-features/gardssalg");
      const dash = require("../owner-ui/gardssalg-dashboard") as typeof import("../owner-ui/gardssalg-dashboard");
      const besok = require("../owner-features/gardssalg-mine-besok") as typeof import("../owner-features/gardssalg-mine-besok");

      // ── (m) flag modes ────────────────────────────────────────────────
      const modeOf = (v: string | undefined) => gs.gardssalgOwnerDashboardMode(v === undefined ? {} : { [FLAG]: v });
      assertEq(modeOf(undefined), "off", "m1: unset → off (default)");
      for (const v of ["", "0", "off", "false", "Pilot", "pilot ", "PILOT", "yes", "2"]) assertEq(modeOf(v), "off", `m2: ${JSON.stringify(v)} → off`);
      assertEq(modeOf("pilot"), "pilot", "m3: pilot → pilot");
      assertEq(modeOf("1"), "all", "m4: 1 → all");
      assertEq(modeOf("true"), "all", "m5: true → all (as the RFB flags)");
      const flagOn = (v: string | undefined, id: string, allow = ALLOW) =>
        gs.gardssalgOwnerDashboardFlagOnFor(id, { ...(v === undefined ? {} : { [FLAG]: v }), OWNER_FEATURES_ALLOWED_SUBJECTS: allow });
      assertEq(flagOn(undefined, "o21-test"), false, "m6: off → no producer, allowlisted or not");
      assertEq(flagOn("pilot", "o21-test"), true, "m7: pilot + gardssalg:<id> on the list → on");
      assertEq(flagOn("pilot", "o21-other"), false, "m8: pilot + not on the list → off");
      assertEq(flagOn("pilot", "o21-test", "rfb:o21-test"), false, "m9: pilot needs the gardssalg: prefix (rfb:<id> does not count)");
      assertEq(flagOn("1", "o21-other", ""), true, "m10: 1 → on without the list (as RFB «all»)");
      assertEq(flagOn("1", "", ""), false, "m11: no provider id → off");

      // ── fixtures ──────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @booking_live, @is_test_provider, '2026-11-01 10:00:00')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`, epost: `besok@${slug}.example.no`,
          booking_live: 0, is_test_provider: 1, ...extra,
        });
      mk("o21-test", "Testgård Dashbord", "o21testgard", "918100001");
      mk("o21-other", "Annen Testgård", "o21annengard", "918100002"); // test producer, NOT on the list
      mk("o21-real", "Ekte Gård", "o21ektegard", "918100003", { is_test_provider: null }); // on the list, not the test producer
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["o21-test", "tok21-test"], ["o21-other", "tok21-other"], ["o21-real", "tok21-real"]]) {
        claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, tok);
      }

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const app = expressMod();
      app.use("/", claimRouter);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method: "GET", host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          r.end();
        });
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const url = (slug: string, tab: "portal" | "besok" | "valg" | "statistikk") => `/kategori/gardssalg/eier/${slug}/${tab}`;
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };
      // Headers that matter for "byte-identical" (Date/ETag-free view).
      const headView = (h: any) => ({ cc: h["cache-control"] ?? null, ct: h["content-type"] ?? null });
      const hasShell = (b: string) => b.includes('data-gardssalg-dashboard="1"') || b.includes('class="ow-nav"');
      const shellOf = (slug: string, tab: "oversikt" | "besok" | "valg" | "statistikk") => dash.renderGardssalgDashboardStart(slug, tab);
      const MAIN_OPEN = '<main id="innhold" tabindex="-1">';

      // ── AK1: flag off → byte-identical ────────────────────────────────
      setFlag(undefined);
      const basePortal = await get(url("o21testgard", "portal"), cookie("tok21-test"));
      const baseValg = await get(url("o21testgard", "valg"), cookie("tok21-test"));
      assertEq(basePortal.status, 200, "AK1a: flag unset → the portal opens (200)");
      assertEq(baseValg.status, 200, "AK1b: flag unset → «Mine valg» opens (200, OA_OWNER_FEATURES_ENABLED on)");
      assertTrue(!hasShell(basePortal.body) && !basePortal.body.includes(MAIN_OPEN), "AK1c: flag unset → no shell on the portal");
      assertTrue(!hasShell(baseValg.body) && !baseValg.body.includes(MAIN_OPEN), "AK1d: flag unset → no shell on «Mine valg»");
      // A second render with the flag unset is the same (nothing time-varying to mask on these pages).
      assertEq((await get(url("o21testgard", "portal"), cookie("tok21-test"))).body, basePortal.body, "AK1e: two flag-unset renders of the portal are identical (stable baseline)");
      for (const v of ["0", "off", "", "Pilot", "pilot ", "yes"]) {
        setFlag(v);
        const p = await get(url("o21testgard", "portal"), cookie("tok21-test"));
        const m = await get(url("o21testgard", "valg"), cookie("tok21-test"));
        assertEq(p.body, basePortal.body, `AK1f: flag ${JSON.stringify(v)} → portal byte-identical to the flag unset`);
        assertEq(headView(p.headers), headView(basePortal.headers), `AK1g: flag ${JSON.stringify(v)} → portal headers as with the flag unset`);
        assertEq(m.body, baseValg.body, `AK1h: flag ${JSON.stringify(v)} → «Mine valg» byte-identical to the flag unset`);
        assertEq((await get(url("o21testgard", "besok"), cookie("tok21-test"))).status, 404, `AK1i: flag ${JSON.stringify(v)} → «Mine besøk» URL is 404`);
        assertEq((await get(url("o21testgard", "statistikk"), cookie("tok21-test"))).status, 404, `AK1j: flag ${JSON.stringify(v)} → «Statistikk» URL is 404`);
      }

      // ── AK2: pilot + the test producer on the list ────────────────────
      setFlag("pilot");
      const tabsIn = (b: string) => {
        const nav = b.slice(b.indexOf('<nav class="ow-nav"'), b.indexOf("</nav>") + 6);
        return [...nav.matchAll(/<a class="ow-nav-item" href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((x) => ({ href: x[1], current: !!x[2], text: x[3] }));
      };
      const expectTabs = (slug: string) => [
        `/kategori/gardssalg/eier/${slug}/portal`, `/kategori/gardssalg/eier/${slug}/besok`,
        `/kategori/gardssalg/eier/${slug}/valg`, `/kategori/gardssalg/eier/${slug}/statistikk`,
      ];
      const onPages: Array<[string, "portal" | "besok" | "valg" | "statistikk", string]> = [
        ["Oversikt", "portal", "Oversikt"], ["Mine besøk", "besok", "Mine besøk"], ["Mine valg", "valg", "Mine valg"], ["Statistikk", "statistikk", "Statistikk"],
      ];
      const onBodies: Record<string, { status: number; headers: any; body: string }> = {};
      for (const [label, tab, current] of onPages) {
        const r = await get(url("o21testgard", tab), cookie("tok21-test"));
        onBodies[tab] = r;
        assertEq(r.status, 200, `AK2a: pilot → ${label} answers 200`);
        const tabs = tabsIn(r.body);
        assertEq(tabs.map((t) => t.text), TABS, `AK2b: ${label} has the four tabs in order`);
        assertEq(tabs.map((t) => t.href), expectTabs("o21testgard"), `AK2c: ${label} tabs link to the four pages`);
        assertEq(tabs.filter((t) => t.current).map((t) => t.text), [current], `AK2d: ${label} — exactly one aria-current, on its own tab`);
        assertEq((r.body.match(/<nav [^>]*aria-label="Eierportal"/g) || []).length, 1, `AK2e: ${label} — exactly one <nav aria-label="Eierportal">`);
        assertTrue(r.body.indexOf('class="ow-skip"') < r.body.indexOf("<nav ") && r.body.includes(MAIN_OPEN), `AK2f: ${label} — skip link before the menu, <main id="innhold">`);
        assertTrue(!/\son[a-z]+=/i.test(r.body.slice(r.body.indexOf('class="ow-skip"'), r.body.indexOf("</nav>"))), `AK2g: ${label} — no inline event handler in the shell`);
        assertTrue(!/rett fra bonden/i.test(r.body), `AK2h: ${label} never names Rett fra Bonden`);
      }
      // ── Lyst tema (dev-request 2026-11-24-opplevagent-eierdashbord-lyst-tema-og-testfunn, skive 1) ──
      // Every gårdssalg owner page is light whatever the browser theme: no
      // dark-scheme rule anywhere in the response, and the page says light.
      const DARK = /prefers-color-scheme\s*:\s*dark/i;
      const lightPage = (b: string) => !DARK.test(b) && b.includes('<meta name="color-scheme" content="light">') && /:root \{ color-scheme: light; \}/.test(b) && !/color-scheme\s*:\s*light\s+dark/i.test(b);
      for (const [label, tab] of onPages) {
        assertTrue(lightPage(onBodies[tab].body), `LT1: pilot → ${label} has no dark-scheme rule and declares color-scheme light`);
      }
      assertTrue(lightPage(basePortal.body), "LT2: flag off → the portal is light only");
      assertTrue(lightPage(baseValg.body), "LT3: flag off → «Mine valg» is light only");
      const claimPage = await get("/kategori/gardssalg/eier/o21testgard");
      assertEq(claimPage.status, 200, "LT4a: the claim page answers 200");
      assertTrue(lightPage(claimPage.body), "LT4b: the claim page is light only");
      assertTrue(!DARK.test(besok.MINE_BESOK_PAGE_CSS), "LT5: «Mine besøk» cards carry no dark-scheme rule");
      {
        const fo = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
        const pg = require("../owner-features/page") as typeof import("../owner-features/page");
        const lo = require("../owner-ui/light-only") as typeof import("../owner-ui/light-only");
        assertTrue(!DARK.test(fo.GARDSSALG_PAGE_CSS), "LT6: the gårdssalg page CSS has no dark block");
        assertTrue(!DARK.test(fo.OWNER_PAGE_CSS_LIGHT) && fo.OWNER_PAGE_CSS_LIGHT.includes(".mv-page"), "LT7: the light copy of the shared page CSS keeps the page rules and drops every dark block");
        assertTrue(DARK.test(pg.OWNER_PAGE_CSS), "LT8: RFB's shared page CSS still has its dark block (unchanged)");
        assertTrue(!baseValg.body.includes(pg.OWNER_PAGE_CSS) && baseValg.body.includes(fo.OWNER_PAGE_CSS_LIGHT), "LT9: «Mine valg» carries the light copy, not RFB's CSS");
        // lightOnlyCss: nested braces, spacing variants, an unbalanced block, light dark → light.
        assertEq(lo.lightOnlyCss("a{x:1}@media (prefers-color-scheme: dark) { :root { y:2 } .b { z:3 } }c{w:4}"), "a{x:1}c{w:4}", "LT10a: a nested dark block is removed whole");
        assertEq(lo.lightOnlyCss("@media(prefers-color-scheme:dark){a{b:c}}d{e:f}"), "d{e:f}", "LT10b: no-space spelling is removed too");
        assertEq(lo.lightOnlyCss("a{b:c}@media (prefers-color-scheme: dark) { d { e:f }"), "a{b:c}", "LT10c: an unbalanced dark block is cut to the end");
        assertEq(lo.lightOnlyCss(":root { color-scheme: light dark; --x: 1; }"), ":root { color-scheme: light; --x: 1; }", "LT10d: color-scheme light dark → light");
        assertEq(lo.lightOnlyCss("@media (max-width: 480px) { a { b: c } }"), "@media (max-width: 480px) { a { b: c } }", "LT10e: other media blocks are kept");
      }
      // With the shell taken out, the portal and «Mine valg» are the flag-off pages.
      // O2-3: the portal (Oversikt) also carries the overview card; take it out too.
      const OVERVIEW_CARD = /<section class="gc-card gs-oversikt"[\s\S]*?<\/section>\n {6}/;
      const HELP_P = /<p data-gardssalg-help="1">[\s\S]*?<\/p>(?=<\/main>)/;
      const unshell = (b: string, slug: string, tab: "oversikt" | "valg") => {
        const t = b.replace(shellOf(slug, tab) + MAIN_OPEN, "").replace(OVERVIEW_CARD, "").replace(HELP_P, "");
        const i = t.lastIndexOf("</main>");
        return i < 0 ? t : t.slice(0, i) + t.slice(i + "</main>".length);
      };
      assertTrue(!basePortal.body.includes("</main>") && !baseValg.body.includes("</main>"), "AK2i0: the flag-off pages have no </main> of their own");
      assertTrue(OVERVIEW_CARD.test(onBodies.portal.body) && !OVERVIEW_CARD.test(basePortal.body), "AK2i1: the overview card (O2-3) is on the dashboard portal only");
      // Slice 4 (dev-request 2026-11-24-opplevagent-eierdashbord-lyst-tema-og-testfunn):
      // «Oversikt» drops the flag-off portal's old stats box and its fetch.
      const OLD_STATS_BOX = /<div class="gc-card">\n {8}<h2>Statistikk<\/h2>[\s\S]*?<p id="gc-stats-note"[^>]*><\/p>\n {6}<\/div>\n {6}/;
      const OLD_STATS_FETCH = /fetch\("\/api\/opplevelser\/gardssalg-claim\/[^"]+\/stats"[\s\S]*?\}\)\.catch\(function \(\) \{\}\);\n/;
      assertTrue(OLD_STATS_BOX.test(basePortal.body) && OLD_STATS_FETCH.test(basePortal.body), "AK2i2: the flag-off portal keeps its stats box and fetch");
      assertTrue(!OLD_STATS_BOX.test(onBodies.portal.body) && !OLD_STATS_FETCH.test(onBodies.portal.body), "AK2i3: the dashboard portal («Oversikt») has neither");
      assertEq(unshell(onBodies.portal.body, "o21testgard", "oversikt"), basePortal.body.replace(OLD_STATS_BOX, "").replace(OLD_STATS_FETCH, ""),
        "AK2i: portal with the shell and the overview card taken out == the flag-off portal without its old stats box (only those changed)");
      // Slice 7 (same dev-request): in the shell «Mine valg» drops its
      // «Tilbake til eierportalen» button and appends the 13px-minimum CSS.
      const BACK_BUTTON = `<div class="ep-form-actions"><a class="ep-btn ep-btn-secondary" href="/kategori/gardssalg/eier/o21testgard/portal">Tilbake til eierportalen</a></div>\n        `;
      const MIN_TEXT_STYLE = `<style>${(require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).GARDSSALG_DASHBOARD_MIN_TEXT_CSS}</style>`;
      assertTrue(baseValg.body.includes(BACK_BUTTON) && !onBodies.valg.body.includes(BACK_BUTTON), "AK2j0: the back button is on the flag-off «Mine valg» only");
      assertTrue(onBodies.valg.body.includes(MIN_TEXT_STYLE) && !baseValg.body.includes(MIN_TEXT_STYLE), "AK2j1: the 13px-minimum CSS is on the dashboard «Mine valg» only");
      assertEq(unshell(onBodies.valg.body, "o21testgard", "valg").replace(MIN_TEXT_STYLE, ""), baseValg.body.replace(BACK_BUTTON, ""),
        "AK2j: «Mine valg» with the shell and the min-size CSS taken out == the flag-off page without its back button (only those changed)");
      // Empty states (tekstpakke OA-3 1.1, verbatim).
      assertTrue(onBodies.besok.body.includes("<p>«Ta imot besøk» er av. Slå det på under «Mine valg» når du vil ta imot forespørsler.</p>"), "AK2k: «Mine besøk» with booking off → empty.visitsOff verbatim");
      assertTrue(onBodies.besok.body.includes('data-state="off"'), "AK2l: «Mine besøk» state off");
      assertTrue(onBodies.statistikk.body.includes("Det er ingen tall å vise ennå."), "AK2m: «Statistikk» → empty.stats verbatim");
      for (const tab of ["portal", "besok", "valg", "statistikk"] as const) {
        assertEq(onBodies[tab].body.split("Trenger du hjelp? Skriv til <a href=\"mailto:kontakt@opplevagent.no\">kontakt@opplevagent.no</a>.").length - 1, 1, `AK2n: /${tab} shows help.contact once, with the contact address`);
      }
      expDb.prepare(`UPDATE experience_providers SET booking_live = 1 WHERE id = 'o21-test'`).run();
      const besokOn = await get(url("o21testgard", "besok"), cookie("tok21-test"));
      assertTrue(besokOn.body.includes("Du har ingen forespørsler ennå. Når noen ber om besøk, får du e-post, og forespørselen dukker opp her.") && besokOn.body.includes('data-state="none"'), "AK2o: booking on, no request → empty.visits verbatim");
      expDb.prepare(`UPDATE experience_providers SET booking_live = 0 WHERE id = 'o21-test'`).run();
      const pendingHtml = besok.renderGardssalgMineBesokEmpty("pending");
      assertTrue(!pendingHtml.includes("ingen forespørsler") && !pendingHtml.includes("er av") && !pendingHtml.includes("Trenger du hjelp?"), "AK2p: requests exist → no untrue «ingen forespørsler» line (the help line is the shell's)");
      assertEq(dash.GARDSSALG_DASHBOARD_TEXTS["tab.visits"], "Mine besøk", "AK2q: tab texts from tekstpakke OA-3");

      // ── AK3: pilot, a profile off the list → 404 ──────────────────────
      for (const tab of ["besok", "statistikk"] as const) {
        assertEq((await get(url("o21annengard", tab), cookie("tok21-other"))).status, 404, `AK3a: pilot, not on the list → /${tab} 404`);
        assertEq((await get(url("o21ektegard", tab), cookie("tok21-real"))).status, 404, `AK3b: pilot, on the list but not the test producer → /${tab} 404 (lock until O2-5)`);
        assertEq((await get(url("finnesikke", tab), cookie("tok21-test"))).status, 404, `AK3c: unknown slug → /${tab} 404`);
      }
      const otherPortal = await get(url("o21annengard", "portal"), cookie("tok21-other"));
      assertTrue(otherPortal.status === 200 && !hasShell(otherPortal.body), "AK3d: pilot, not on the list → its portal has no shell");

      // ── AK4: no-store ─────────────────────────────────────────────────
      for (const tab of ["portal", "besok", "valg", "statistikk"] as const) {
        assertEq(onBodies[tab].headers["cache-control"], "no-store", `AK4a: /${tab} with the dashboard on → Cache-Control: no-store`);
      }
      assertEq((await get(url("o21annengard", "besok"), cookie("tok21-other"))).headers["cache-control"], "no-store", "AK4b: the 404 of a dashboard URL is no-store too");
      assertEq((await get(url("o21testgard", "statistikk"))).headers["cache-control"], "no-store", "AK4c: the 401 of a dashboard URL is no-store too");

      // ── (g) session gate, and a GET writes nothing ────────────────────
      assertEq((await get(url("o21testgard", "besok"))).status, 401, "g1: no session → 401");
      assertEq((await get(url("o21testgard", "statistikk"), cookie("tok21-other"))).status, 403, "g2: another producer's session → 403");
      const changes = (db: any) => (db.prepare("SELECT total_changes() AS n").get() as any).n;
      const before = [changes(expDb), changes(rfbDb)];
      for (const tab of ["besok", "statistikk", "portal", "valg"] as const) await get(url("o21testgard", tab), cookie("tok21-test"));
      assertEq([changes(expDb), changes(rfbDb)], before, "g3: the dashboard GETs write nothing (both databases)");

      // ── (1) flag "1": all, the lock still applies ─────────────────────
      setFlag("1");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "";
      const all = await get(url("o21annengard", "besok"), cookie("tok21-other"));
      assertTrue(all.status === 200 && tabsIn(all.body).length === 4, "a1: flag 1 → a test producer off the list gets the dashboard (all)");
      assertEq((await get(url("o21ektegard", "besok"), cookie("tok21-real"))).status, 404, "a2: flag 1 → a real producer still 404 (test-producer lock until O2-5)");
      const realPortal = await get(url("o21ektegard", "portal"), cookie("tok21-real"));
      assertTrue(realPortal.status === 200 && !hasShell(realPortal.body), "a3: flag 1 → a real producer's portal has no shell");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;

      // ── (t) the shell's own text and content rules ────────────────────
      const shellHtml = shellOf("x", "oversikt");
      assertTrue(!/<script/i.test(shellHtml) && !/\sstyle="/i.test(shellHtml), "t1: the shell has no script and no style attribute");
      assertTrue(!/kr\b|%|vol\.|alkohol/i.test(shellHtml.replace(/<style>[\s\S]*?<\/style>/, "")), "t2: the shell names no price, strength or drink");
    } catch (e: any) {
      failed++;
      failures.push(`unexpected error: ${e?.stack || e}`);
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
      if (initMod) initMod.__setDbForTesting(prevRfbDb);
      restoreModuleCache();
      for (const k of ENV_KEYS) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgOwnerDashboardO21Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
