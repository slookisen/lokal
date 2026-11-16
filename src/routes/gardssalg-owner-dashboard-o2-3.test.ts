/**
 * gardssalg-owner-dashboard-o2-3.test.ts — dev-request 2026-11-12-opplevagent-
 * o2-eierdashbord-for-besok, slice O2-3: the «Oversikt» card on the portal.
 *
 *   AK1  the numbers on the card (waiting requests, upcoming confirmed
 *        visits) equal those of the admin GET /admin/api/ordre/liste
 *        (plattform=gardssalg, status=reserved, filtered on producer_id) for
 *        the same seeded data; with closed / expired / past rows added they
 *        still equal the «Mine besøk» grouping over listProviderBookings.
 *   (o)  two profiles: each owner sees only their own numbers and visits.
 *   (r)  readiness from the existing gates: ready; switch off + no address +
 *        no opening hours → all three lines; dispatch gate closed → «ikke
 *        ennå» without a missing line; hours never decide «tar imot».
 *   (e)  a guest name holding `<script>` and `$&` is escaped / literal (also
 *        on «Mine besøk»); only the first name; no comment, e-mail or phone.
 *   (f)  flag off / profile off the pilot list → no card, portal unchanged;
 *        no-store; the GET writes nothing.
 *   (t)  texts verbatim (tekstpakke OA-3 1.3); link to «Mine valg»; no
 *        price, strength or product words.
 *
 * Exported runGardssalgOwnerDashboardO23Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-o2-3.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";
const HOUR = 3600_000;

export function runGardssalgOwnerDashboardO23Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED", "ADMIN_KEY", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    process.env.ADMIN_KEY = "o23-admin-key";
    const ALLOW = "gardssalg:o23-a,gardssalg:o23-b,gardssalg:o23-d";
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
    const LOOPBACK_KEY = "127.0.0.1";
    const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
    try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;
    let adminStats: typeof import("./admin-order-stats") | null = null;

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
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const besok = require("../owner-features/gardssalg-mine-besok") as typeof import("../owner-features/gardssalg-mine-besok");
      const ov = require("../owner-features/gardssalg-oversikt") as typeof import("../owner-features/gardssalg-oversikt");
      const { formatSlotOslo } = require("../services/gardssalg-booking-resolve") as typeof import("../services/gardssalg-booking-resolve");
      const T = ov.GARDSSALG_OVERVIEW_TEXTS;

      // ── fixtures ──────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at,
           opening_hours_text)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @booking_live, 1, '2026-11-01 10:00:00', @hours)
      `);
      const mkProvider = (id: string, slug: string, org: string, over: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn: `Testgård ${id}`, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`,
          epost: `besok@${slug}.example.no`, booking_live: 1, hours: "Lør 12–16", ...over,
        });
      mkProvider("o23-a", "o23agard", "918300001");
      mkProvider("o23-b", "o23bgard", "918300002");
      mkProvider("o23-d", "o23dgard", "918300003", { booking_live: 0, epost: "  ", hours: null });
      mkProvider("o23-c", "o23cgard", "918300004"); // test producer, NOT on the list
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const pid of ["o23-a", "o23-b", "o23-c", "o23-d"]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, `tok23-${pid}`);

      const now = Date.now();
      const iso = (h: number) => new Date(now + h * HOUR).toISOString();
      const insertBooking = expDb.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token, source,
           status, billable, notes, pre_status, respond_token, respond_token_expires_at, respond_token_used_at, guest_status_token)
        VALUES
          (@booking_id, @provider_id, @slot_at, @party_size, @guest_name, @guest_email, @guest_phone, @booking_ref, @confirm_token, 'web',
           @status, 0, @notes, @pre_status, @respond_token, @respond_token_expires_at, @respond_token_used_at, @guest_status_token)
      `);
      const mkBooking = (ref: string, provider: string, over: Record<string, unknown> = {}) =>
        insertBooking.run({
          booking_id: `bid-${ref}`, provider_id: provider, slot_at: iso(48), party_size: 2,
          guest_name: `Gjest ${ref}`, guest_email: `${ref.toLowerCase()}@gjest.example.no`, guest_phone: "+4799999999",
          booking_ref: ref, confirm_token: `ctok-${ref}`, status: "reserved", notes: null,
          pre_status: "awaiting_provider", respond_token: `rtok-${ref}`, respond_token_expires_at: iso(24),
          respond_token_used_at: null, guest_status_token: `gtok-${ref}`, ...over,
        });
      const confirmed = (slotH: number, over: Record<string, unknown> = {}) =>
        ({ slot_at: iso(slotH), pre_status: "provider_confirmed", respond_token_used_at: iso(-1), ...over });
      const EVIL = "<script>alert(1)</script>$&$' Hansen";
      // Phase 1 — only open, unexpired requests and future confirmed visits.
      mkBooking("GS-A-P1", "o23-a", { respond_token_expires_at: iso(20) });
      mkBooking("GS-A-P2", "o23-a", { respond_token_expires_at: iso(6) }); // the nearest deadline
      mkBooking("GS-A-P3", "o23-a", { respond_token_expires_at: iso(30) });
      mkBooking("GS-A-C1", "o23-a", confirmed(72, { party_size: 1, guest_name: "Kari Nordmann" }));
      mkBooking("GS-A-C2", "o23-a", confirmed(30, { guest_name: EVIL, notes: "<script>x</script> merknad $&" }));
      mkBooking("GS-B-P1", "o23-b");
      mkBooking("GS-B-C1", "o23-b", confirmed(40));

      // ── HTTP wiring: the portal and the admin list ────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      adminStats = require("./admin-order-stats") as typeof import("./admin-order-stats");
      adminStats.__setAdminOrderStatsTestDbs(rfbDb as any, expDb as any);
      const app = expressMod();
      app.use("/admin/api/ordre", adminStats.default);
      app.use("/", claimRouter);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      type Resp = { status: number; headers: any; body: string };
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<Resp>((resolve, reject) => {
          const r = httpMod.request({ method: "GET", host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          r.end();
        });
      const cookie = (pid: string) => ({ Cookie: `oa_owner_session=tok23-${pid}` });
      const portal = (slug: string, pid: string) => get(`/kategori/gardssalg/eier/${slug}/portal`, cookie(pid));
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };
      const CARD = /<section class="gc-card gs-oversikt"[\s\S]*?<\/section>/;
      const cardOf = (html: string) => (CARD.exec(html) || [""])[0];
      const waitingOf = (card: string) => Number((/data-waiting-count="(\d+)"/.exec(card) || [])[1] ?? NaN);
      const upcomingCountOf = (card: string) => Number((/data-upcoming-count="(\d+)"/.exec(card) || [])[1] ?? NaN);
      const refsOf = (card: string) => [...card.matchAll(/data-booking-ref="([^"]+)"/g)].map((m) => m[1]);
      const changes = () => [(expDb.prepare("SELECT total_changes() AS n").get() as any).n, (rfbDb.prepare("SELECT total_changes() AS n").get() as any).n];
      /** The admin GET's numbers for one producer: open requests and confirmed visits (status reserved). */
      const adminCounts = async (pid: string) => {
        const r = await get("/admin/api/ordre/liste?plattform=gardssalg&status=reserved", { "X-Admin-Key": "o23-admin-key" });
        const rows = (JSON.parse(r.body).rows as Array<{ producer_id: string; pre_status: string }>).filter((x) => x.producer_id === pid);
        return {
          status: r.status,
          waiting: rows.filter((x) => x.pre_status === "awaiting_provider").length,
          upcoming: rows.filter((x) => x.pre_status === "provider_confirmed").length,
        };
      };

      // ── (f) flag off / off the list → no card ─────────────────────────
      setFlag(undefined);
      {
        const off = await portal("o23agard", "o23-a");
        assertEq(off.status, 200, "f1: flag off → the portal opens");
        assertTrue(!off.body.includes("gs-oversikt") && !off.body.includes(T["overview.waiting.many"].slice(4)), "f2: flag off → no overview card");
        setFlag("pilot");
        const otherList = await portal("o23cgard", "o23-c");
        assertTrue(otherList.status === 200 && !otherList.body.includes("gs-oversikt"), "f3: pilot, profile off the list → no card");
      }
      setFlag("pilot");

      // ── AK1: the card's numbers == the admin GET's ────────────────────
      const a1 = await portal("o23agard", "o23-a");
      const b1 = await portal("o23bgard", "o23-b");
      const ca = cardOf(a1.body);
      const cb = cardOf(b1.body);
      assertEq([a1.status, b1.status], [200, 200], "AK1a: both portals open (200)");
      assertEq([a1.headers["cache-control"], b1.headers["cache-control"]], ["no-store", "no-store"], "AK1b: no-store");
      const adA = await adminCounts("o23-a");
      const adB = await adminCounts("o23-b");
      assertEq(adA.status, 200, "AK1c: the admin GET answers 200");
      assertEq([waitingOf(ca), upcomingCountOf(ca)], [adA.waiting, adA.upcoming], "AK1d: A — waiting / upcoming == admin GET /admin/api/ordre/liste");
      assertEq([waitingOf(cb), upcomingCountOf(cb)], [adB.waiting, adB.upcoming], "AK1e: B — waiting / upcoming == admin GET");
      assertEq([adA.waiting, adA.upcoming, adB.waiting, adB.upcoming], [3, 2, 1, 1], "AK1f: the seeded numbers (guard against a vacuous match)");
      assertTrue(ca.includes(`<strong>3 forespørsler venter på svar fra deg</strong>`), "AK1g: overview.waiting.many with {n}=3");
      assertTrue(cb.includes(`<strong>${T["overview.waiting.one"]}</strong>`), "AK1h: overview.waiting.one for B");
      assertTrue(ca.includes(`Nærmeste svarfrist: ${formatSlotOslo(iso(6))}`), "AK1i: the nearest deadline (the soonest of the three)");
      assertEq(refsOf(ca), ["GS-A-C2", "GS-A-C1"], "AK1j: A's upcoming confirmed visits, soonest first");

      // ── (o) ownership: two profiles ────────────────────────────────────
      assertEq(refsOf(cb), ["GS-B-C1"], "o1: B's card lists only B's visit");
      assertTrue(!a1.body.includes("GS-B-") && !b1.body.includes("GS-A-") && !b1.body.includes("Kari"), "o2: nothing of the other profile on either page");
      assertEq((await get("/kategori/gardssalg/eier/o23agard/portal", cookie("o23-b"))).status, 403, "o3: B's session on A's portal → 403 (no card)");

      // ── AK1 with closed / expired / past rows: == the «Mine besøk» grouping ─
      mkBooking("GS-A-TOKEXP", "o23-a", { respond_token_expires_at: iso(-1) });
      mkBooking("GS-A-CPAST", "o23-a", confirmed(-3));
      mkBooking("GS-A-DFUT", "o23-a", { pre_status: "provider_declined", respond_token_used_at: iso(-1) });
      mkBooking("GS-A-SUGG", "o23-a", { pre_status: "time_suggested" });
      mkBooking("GS-A-CANC", "o23-a", confirmed(50, { status: "cancelled" }));
      mkBooking("GS-A-DONE", "o23-a", confirmed(-50, { status: "confirmed_attended" }));
      {
        const ca2 = cardOf((await portal("o23agard", "o23-a")).body);
        const g = besok.groupMineBesok(store.listProviderBookings("o23-a"), new Date());
        const storeUpcoming = g.upcoming.filter((x) => besok.mineBesokPageStatus(x, new Date()) === "confirmed").map((x) => x.booking_ref);
        assertEq([waitingOf(ca2), refsOf(ca2)], [g.waiting.length, storeUpcoming], "AK1k: with closed rows — the card == the «Mine besøk» grouping over listProviderBookings");
        assertEq([waitingOf(ca2), refsOf(ca2)], [3, ["GS-A-C2", "GS-A-C1"]], "AK1l: expired / declined / suggested / cancelled / past rows are not counted");
      }

      // ── (e) escaping, minimal personal data ───────────────────────────
      assertTrue(ca.includes("&lt;script&gt;alert(1)&lt;/script&gt;$&amp;$&#039;, 2 personer"), "e1: a first name with <script>, $& and $' is escaped and literal");
      assertTrue(!/<script>alert/.test(a1.body), "e2: no raw <script> from the guest anywhere on the portal");
      assertTrue(ca.includes("Kari, 1 person<") && !ca.includes("Nordmann") && !ca.includes("Hansen"), "e3: first name only");
      assertTrue(!ca.includes("gjest.example.no") && !ca.includes("+4799999999") && !ca.includes("merknad"), "e4: no e-mail, phone or comment on the card");
      {
        const mb = (await get("/kategori/gardssalg/eier/o23agard/besok", cookie("o23-a"))).body;
        assertTrue(mb.includes("&lt;script&gt;alert(1)&lt;/script&gt;$&amp;$&#039; Hansen, 2 personer") && !/<script>alert|<script>x/.test(mb), "e5: «Mine besøk» shows the same name literally and escaped (guestLine $& fix)");
      }

      // ── (r) readiness ──────────────────────────────────────────────────
      assertTrue(ca.includes(`data-ready="1"><strong>${T["overview.ready.yes"]}</strong>`) && !ca.includes(T["overview.missing.lead"]), "r1: A takes requests, no «Dette mangler»");
      {
        const d = await portal("o23dgard", "o23-d");
        const cd = cardOf(d.body);
        assertTrue(cd.includes(`data-ready="0"><strong>${T["overview.ready.no"]}</strong>`), "r2: D (switch off) → overview.ready.no");
        assertEq([...cd.matchAll(/<li data-missing="([a-z]+)">([^<]+)<\/li>/g)].map((m) => [m[1], m[2]]),
          [["switch", T["overview.missing.switch"]], ["address", T["overview.missing.address"]], ["hours", T["overview.missing.hours"]]],
          "r3: D lists switch, address and hours, verbatim, in that order");
        assertTrue(cd.includes(`<p>${T["overview.missing.lead"]}</p>`), "r4: overview.missing.lead");
        assertTrue(cd.includes(`<strong>${T["overview.waiting.none"]}</strong>`) && cd.includes(`<p>${T["overview.upcoming.none"]}</p>`) && !cd.includes("Nærmeste svarfrist"), "r5: no requests → waiting.none, upcoming.none, no deadline line");
      }
      expDb.prepare(`UPDATE experience_providers SET opening_hours_text = NULL WHERE id = 'o23-a'`).run();
      assertTrue(cardOf((await portal("o23agard", "o23-a")).body).includes(T["overview.ready.yes"]), "r6: opening hours never decide «tar imot» (A without hours still ready)");
      delete process.env.BOOKING_DISPATCH_ENABLED;
      {
        const c = cardOf((await portal("o23agard", "o23-a")).body);
        assertTrue(c.includes(T["overview.ready.no"]) && c.includes(`data-missing="hours"`) && !c.includes(`data-missing="switch"`) && !c.includes(`data-missing="address"`),
          "r7: the guest gate closed (isBookingPaused) → «ikke ennå»; only what is really missing is listed");
      }
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      const r = (f: Partial<import("../owner-features/gardssalg-oversikt").OverviewReadinessFacts>) => ov.overviewReadiness({
        switchOn: true, bookingGateOpen: true, ownerPaused: false, hasRequestAddress: true, hasOpeningHours: true, ...f,
      });
      assertEq(r({}), { ready: true, missing: [] }, "r8: all met → ready");
      assertEq(r({ ownerPaused: true }), { ready: false, missing: [] }, "r9: the owner's booking.pause → not ready");
      assertEq(r({ hasRequestAddress: false }), { ready: false, missing: ["address"] }, "r10: no address → not ready, address listed");
      assertEq(r({ switchOn: false, bookingGateOpen: false }), { ready: false, missing: ["switch"] }, "r11: switch off → not ready, switch listed");

      // ── (t) texts, link, content rules ────────────────────────────────
      assertEq(T, {
        "overview.waiting.one": "1 forespørsel venter på svar fra deg",
        "overview.waiting.many": "{n} forespørsler venter på svar fra deg",
        "overview.waiting.none": "Ingen forespørsler venter på svar.",
        "overview.nextDeadline": "Nærmeste svarfrist: {frist}",
        "overview.upcoming.heading": "Kommende besøk",
        "overview.upcoming.none": "Du har ingen bekreftede besøk framover.",
        "overview.ready.yes": "Profilen din tar imot forespørsler.",
        "overview.ready.no": "Profilen din tar ikke imot forespørsler ennå.",
        "overview.missing.lead": "Dette mangler:",
        "overview.missing.switch": "«Ta imot besøk» er av.",
        "overview.missing.address": "Adressen forespørslene skal sendes til, er ikke bekreftet.",
        "overview.missing.hours": "Åpningstider er ikke lagt inn.",
        "overview.goToChoices": "Gå til «Mine valg»",
      }, "t1: tekstpakke OA-3 1.3 verbatim");
      assertTrue(ca.includes(`<a href="/kategori/gardssalg/eier/o23agard/valg">${T["overview.goToChoices"]}</a>`), "t2: the link to «Mine valg»");
      assertTrue(ca.includes(`<h3>${T["overview.upcoming.heading"]}</h3>`), "t3: overview.upcoming.heading");
      assertTrue(!/\bkr\b|%|vol\.|alkohol|smak|pris/i.test(ca), "t4: no price, strength, tasting or product words on the card");
      assertTrue(!/<script|\son[a-z]+=/i.test(ca), "t5: no script or inline handler in the card");

      // ── (f) a GET writes nothing ──────────────────────────────────────
      const before = changes();
      for (const [slug, pid] of [["o23agard", "o23-a"], ["o23bgard", "o23-b"], ["o23dgard", "o23-d"]]) await portal(slug, pid);
      assertEq(changes(), before, "f4: the portal GETs with the card write nothing (both databases)");
    } catch (e: any) {
      failed++;
      failures.push(`unexpected error: ${e?.stack || e}`);
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
      if (adminStats) adminStats.__setAdminOrderStatsTestDbs(null);
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
  runGardssalgOwnerDashboardO23Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
