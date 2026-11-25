/**
 * gardssalg-owner-dashboard-hjelpelinje.test.ts — «Hjelpelinjen»: with the
 * gårdssalg owner dashboard shell active, every one of the four tabs shows
 * help.contact («Trenger du hjelp? Skriv til …») exactly once, as a mailto
 * link, rendered centrally by wrapGardssalgDashboard.
 *
 *   H1  «Oversikt», «Mine valg», «Statistikk» and «Mine besøk», each in its
 *       empty AND its normal state (Statistikk with numbers, Mine besøk with
 *       requests) → exactly one help line with the mailto link.
 *   H2  flag off → the portal and «Mine valg» carry no help line and no
 *       data-gardssalg-help marker (the non-shell pages are untouched).
 *   H3  RFB's owner shell and page CSS are unchanged.
 *
 * Exported runGardssalgOwnerDashboardHjelpelinjeTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-hjelpelinje.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";

export function runGardssalgOwnerDashboardHjelpelinjeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  return (async () => {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:hl-empty,gardssalg:hl-full";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
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
      } catch { /* already loaded by an earlier suite */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const dash = require("../owner-ui/gardssalg-dashboard") as typeof import("../owner-ui/gardssalg-dashboard");
      const besok = require("../owner-features/gardssalg-mine-besok") as typeof import("../owner-features/gardssalg-mine-besok");
      const CONTACT = (require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim")).CLAIM_MANUAL_FALLBACK_EMAIL;
      const HELP = `Trenger du hjelp? Skriv til <a href="mailto:${CONTACT}">${CONTACT}</a>.`;

      // ── fixtures: one producer with no requests, one with requests ────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @booking_live, 1, '2026-11-01 10:00:00')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, booking_live: number) =>
        insertProvider.run({ id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`, epost: `besok@${slug}.example.no`, booking_live });
      mk("hl-empty", "Hjelp Tom", "hltom", "918300001", 0);
      mk("hl-full", "Hjelp Full", "hlfull", "918300002", 1);
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const pid of ["hl-empty", "hl-full"]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, `tok-${pid}`);
      const HOUR = 3600 * 1000;
      const iso = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
      const insertBooking = expDb.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token, source,
           status, billable, notes, pre_status, respond_token, respond_token_expires_at, respond_token_used_at,
           suggested_slot_at, guest_decision_token, guest_status_token)
        VALUES
          (@booking_id, @provider_id, @slot_at, 2, @guest_name, @guest_email, NULL, @booking_ref, @confirm_token, 'web',
           'reserved', 0, NULL, @pre_status, @respond_token, @respond_token_expires_at, @respond_token_used_at,
           NULL, NULL, @guest_status_token)
      `);
      const mkBooking = (ref: string, over: Record<string, unknown> = {}) =>
        insertBooking.run({
          booking_id: `bid-${ref}`, provider_id: "hl-full", slot_at: iso(48), guest_name: `Gjest ${ref}`,
          guest_email: `${ref.toLowerCase()}@gjest.example.no`, booking_ref: ref, confirm_token: `ctok-${ref}`,
          pre_status: "awaiting_provider", respond_token: `rtok-${ref}`, respond_token_expires_at: iso(24),
          respond_token_used_at: null, guest_status_token: `gtok-${ref}`, ...over,
        });
      const countBookings = () => (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings`).get() as { n: number }).n;

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
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method: "GET", host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          r.end();
        });
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const url = (slug: string, tab: "portal" | "besok" | "valg" | "statistikk") => `/kategori/gardssalg/eier/${slug}/${tab}`;
      const TABS = ["portal", "besok", "valg", "statistikk"] as const;
      const mainEnd = (b: string) => b.lastIndexOf("</main>");

      // ── H2 baseline: flag off ─────────────────────────────────────────
      for (const tab of ["portal", "valg"] as const) {
        const r = await get(url("hltom", tab), cookie("tok-hl-empty"));
        assertEq(r.status, 200, `H2a: flag off → /${tab} opens`);
        assertTrue(!r.body.includes("Trenger du hjelp?") && !r.body.includes("data-gardssalg-help"), `H2b: flag off → /${tab} has no help line and no help marker`);
      }

      process.env[FLAG] = "pilot";

      // ── H1a: empty states — «Mine besøk» off, «Statistikk» no numbers ─
      for (const tab of TABS) {
        const r = await get(url("hltom", tab), cookie("tok-hl-empty"));
        assertEq(r.status, 200, `H1a: shell, empty → /${tab} 200`);
        assertEq(count(r.body, HELP), 1, `H1a: shell, empty → /${tab} has exactly one help line with the mailto link`);
        assertEq(count(r.body, "Trenger du hjelp?"), 1, `H1a: shell, empty → /${tab} has the help text once`);
        assertTrue(r.body.indexOf(HELP) > r.body.indexOf('<main id="innhold"') && r.body.indexOf(HELP) < mainEnd(r.body), `H1a: /${tab} help line is inside <main>`);
      }
      // ── H1b: normal states — requests exist (with numbers) ────────────
      mkBooking("GS-HL-1");
      mkBooking("GS-HL-2", { slot_at: iso(-2), pre_status: "provider_confirmed", respond_token_used_at: iso(-30) });
      assertEq(countBookings(), 2, "H1b0: two requests seeded");
      for (const tab of TABS) {
        const r = await get(url("hlfull", tab), cookie("tok-hl-full"));
        assertEq(r.status, 200, `H1b: shell, with requests → /${tab} 200`);
        assertEq(count(r.body, HELP), 1, `H1b: shell, with requests → /${tab} has exactly one help line with the mailto link`);
        assertEq(count(r.body, "Trenger du hjelp?"), 1, `H1b: shell, with requests → /${tab} has the help text once`);
      }
      const stat = await get(url("hlfull", "statistikk"), cookie("tok-hl-full"));
      assertTrue(!stat.body.includes("Det er ingen tall å vise ennå."), "H1c: «Statistikk» is the numbers page, not the empty state");
      const bes = await get(url("hlfull", "besok"), cookie("tok-hl-full"));
      assertTrue(!bes.body.includes("data-gardssalg-empty"), "H1d: «Mine besøk» is the list page, not the empty state");

      // ── the renderers: one place only ─────────────────────────────────
      assertTrue(!besok.renderGardssalgMineBesokEmpty("none").includes("Trenger du hjelp?"), "H1e: the «Mine besøk» empty state does not render the help line itself");
      assertTrue(!dash.renderGardssalgStatsEmpty().includes("Trenger du hjelp?"), "H1f: the «Statistikk» empty state does not render the help line itself");
      const wrapped = dash.wrapGardssalgDashboard("x", "oversikt", "<p>b</p>", CONTACT);
      assertTrue(wrapped.endsWith(`<p>b</p><p data-gardssalg-help="1">${HELP}</p></main>`), "H1g: wrapGardssalgDashboard puts the help line last in <main>");

      // ── H2: flag off again → still no help line ───────────────────────
      delete process.env[FLAG];
      for (const tab of ["portal", "valg"] as const) {
        const r = await get(url("hlfull", tab), cookie("tok-hl-full"));
        assertTrue(!r.body.includes("Trenger du hjelp?") && !r.body.includes("data-gardssalg-help"), `H2c: flag off → /${tab} still has no help line`);
      }

      // ── H3: RFB unchanged ─────────────────────────────────────────────
      {
        const rfbShell = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
        const pg = require("../owner-features/page") as typeof import("../owner-features/page");
        assertTrue(!rfbShell.OWNER_SHELL_CSS.includes("gardssalg-help") && !pg.OWNER_PAGE_CSS.includes("gardssalg-help"), "H3a: RFB shell and page CSS carry no gårdssalg help rule");
        assertTrue(!rfbShell.OWNER_SHELL_MAIN_OPEN.includes("help") && !/Trenger du hjelp/.test(rfbShell.OWNER_SHELL_CSS), "H3b: RFB's shell has no help line");
        assertTrue(/prefers-color-scheme:\s*dark/.test(pg.OWNER_PAGE_CSS), "H3c: RFB's page CSS keeps its dark block");
      }
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
  runGardssalgOwnerDashboardHjelpelinjeTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
