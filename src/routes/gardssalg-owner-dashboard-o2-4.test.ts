/**
 * gardssalg-owner-dashboard-o2-4.test.ts — dev-request 2026-11-12-opplevagent-
 * o2-eierdashbord-for-besok, slice O2-4: the «Statistikk» tab.
 *
 *   AK1  the numbers on GET …/statistikk equal counts taken straight from
 *        booking-store's table (gardssalg_bookings, by status / pre_status)
 *        and listProviderBookings for the same seeded data.
 *   (o)  two profiles: each owner sees only their own counts and AI number;
 *        another profile's bookings and AI rows never counted; B's session on
 *        A's page → 403.
 *   (a)  the AI row: computeAiDeliveries (vertical experiences, this profile)
 *        with stats.aiHelp and its own «Siden»; rfb rows with the same id
 *        and other profiles are not counted.
 *   (p)  stats.period = the earliest request date.
 *   (e)  no request → empty.stats verbatim (also with AI rows present).
 *   (f)  flag off → 404; no-store; the GET writes nothing.
 *   (t)  texts verbatim (tekstpakke OA-3 §1.4); no price/product words.
 *
 * Exported runGardssalgOwnerDashboardO24Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-o2-4.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";
const HOUR = 3600_000;

export function runGardssalgOwnerDashboardO24Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED",
      "PROFILE_AI_DELIVERIES_COUNTING_SINCE", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o24-a,gardssalg:o24-b,gardssalg:o24-c";

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
      } catch { /* already loaded by an earlier suite in the same process */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const st = require("../owner-features/gardssalg-statistikk") as typeof import("../owner-features/gardssalg-statistikk");
      const T = st.GARDSSALG_STATS_TEXTS;

      // ── fixtures ──────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 1, 1, '2026-11-01 10:00:00')
      `);
      const mkProvider = (id: string, slug: string, org: string) =>
        insertProvider.run({ id, navn: `Testgård ${id}`, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`, epost: `besok@${slug}.example.no` });
      mkProvider("o24-a", "o24agard", "918400001");
      mkProvider("o24-b", "o24bgard", "918400002");
      mkProvider("o24-c", "o24cgard", "918400003"); // no bookings at all
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const pid of ["o24-a", "o24-b", "o24-c"]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, `tok24-${pid}`);

      const now = Date.now();
      const iso = (h: number) => new Date(now + h * HOUR).toISOString();
      const insertBooking = expDb.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token, source,
           status, billable, notes, created_at, pre_status, respond_token, respond_token_expires_at, respond_token_used_at, guest_status_token,
           cancelled_by)
        VALUES
          (@booking_id, @provider_id, @slot_at, 2, @guest_name, @guest_email, NULL, @booking_ref, @confirm_token, 'web',
           @status, 0, NULL, @created_at, @pre_status, @respond_token, @respond_token_expires_at, @respond_token_used_at, @guest_status_token,
           @cancelled_by)
      `);
      const mkBooking = (ref: string, provider: string, over: Record<string, unknown> = {}) =>
        insertBooking.run({
          booking_id: `bid-${ref}`, provider_id: provider, slot_at: iso(48),
          guest_name: `Gjest ${ref}`, guest_email: `${ref.toLowerCase()}@gjest.example.no`,
          booking_ref: ref, confirm_token: `ctok-${ref}`, status: "reserved", created_at: "2026-11-15 09:00:00",
          pre_status: "awaiting_provider", respond_token: `rtok-${ref}`, respond_token_expires_at: iso(24),
          respond_token_used_at: null, guest_status_token: `gtok-${ref}`, cancelled_by: null, ...over,
        });
      const conf = (over: Record<string, unknown> = {}) => ({ pre_status: "provider_confirmed", respond_token_used_at: iso(-1), ...over });
      // Profile A — every status:
      mkBooking("GS-A-PEND", "o24-a");                                                              // pending: requests only
      mkBooking("GS-A-SUGG", "o24-a", { pre_status: "time_suggested" });                             // suggested: requests only
      mkBooking("GS-A-C1", "o24-a", conf());                                                         // confirmed (upcoming)
      mkBooking("GS-A-C2", "o24-a", conf({ slot_at: iso(-3) }));                                     // confirmed (past, unresolved)
      mkBooking("GS-A-ATT1", "o24-a", conf({ slot_at: iso(-50), status: "confirmed_attended" }));    // confirmed + attended
      mkBooking("GS-A-ATT2", "o24-a", conf({ slot_at: iso(-70), status: "confirmed_attended", created_at: "2026-11-02T08:30:00.000Z" })); // earliest
      mkBooking("GS-A-NOSH", "o24-a", conf({ slot_at: iso(-40), status: "no_show" }));               // confirmed + no-show
      mkBooking("GS-A-DECL", "o24-a", { pre_status: "provider_declined", respond_token_used_at: iso(-1) });
      mkBooking("GS-A-EXP1", "o24-a", { pre_status: "expired" });
      mkBooking("GS-A-EXP2", "o24-a", { respond_token_expires_at: iso(-1) });                       // deadline passed, not swept yet
      mkBooking("GS-A-CNG", "o24-a", conf({ status: "cancelled", cancelled_by: "guest" }));          // cancelled by guest (after confirm)
      mkBooking("GS-A-CNP", "o24-a", conf({ status: "cancelled", cancelled_by: "producer" }));       // cancelled by producer
      mkBooking("GS-A-WDR", "o24-a", { status: "cancelled", cancelled_by: "guest" });                // withdrawn while pending
      // Profile B — a few, different numbers; earlier created_at than A's earliest.
      mkBooking("GS-B-PEND", "o24-b", { created_at: "2026-10-30 07:00:00" });
      mkBooking("GS-B-ATT", "o24-b", conf({ slot_at: iso(-30), status: "confirmed_attended" }));
      mkBooking("GS-B-CNG", "o24-b", conf({ status: "cancelled", cancelled_by: "guest" }));
      mkBooking("GS-B-DECL", "o24-b", { pre_status: "provider_declined", respond_token_used_at: iso(-1) });
      mkBooking("GS-B-DECL2", "o24-b", { pre_status: "provider_declined", respond_token_used_at: iso(-1) });

      // AI deliveries (lokal.db profile_ai_deliveries).
      const today = new Date(now).toISOString().slice(0, 10);
      const insAi = rfbDb.prepare(`INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)`);
      insAi.run("experiences", "o24-a", today, "mcp", "claude", 5);
      insAi.run("experiences", "o24-a", today, "ai_page_profile", "chatgpt", 2);
      insAi.run("experiences", "o24-a", "2026-10-20", "mcp", "claude", 100); // before the counting start: never counted
      insAi.run("rfb", "o24-a", today, "mcp", "claude", 1000);               // same id, other vertical
      insAi.run("experiences", "o24-b", today, "a2a", "other", 3);
      insAi.run("experiences", "o24-c", today, "mcp", "claude", 9);          // C has AI rows but no request

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
      const cookie = (pid: string) => ({ Cookie: `oa_owner_session=tok24-${pid}` });
      const statsPage = (slug: string, pid: string) => get(`/kategori/gardssalg/eier/${slug}/statistikk`, cookie(pid));
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };
      const numbersOf = (html: string) => Object.fromEntries(
        [...html.matchAll(/<tr data-stat="([A-Za-z]+)"><th scope="row">[^<]*<\/th><td>(\d+)<\/td><\/tr>/g)].map((m) => [m[1], Number(m[2])]),
      );
      const changes = () => [(expDb.prepare("SELECT total_changes() AS n").get() as any).n, (rfbDb.prepare("SELECT total_changes() AS n").get() as any).n];
      /** Counts straight from booking-store's table for one producer (the reference for AK1). */
      const storeCounts = (pid: string) => {
        const n = (where: string) => (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = ? AND ${where}`).get(pid) as any).n as number;
        const nowIso = new Date().toISOString();
        return {
          requests: store.listProviderBookings(pid, Number.MAX_SAFE_INTEGER).length,
          confirmed: n("pre_status = 'provider_confirmed'"),
          declined: n("status = 'reserved' AND pre_status = 'provider_declined'"),
          expired: (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = ? AND status = 'reserved'
            AND (pre_status = 'expired' OR (pre_status IN ('awaiting_provider','time_suggested') AND respond_token_expires_at <= ?))`).get(pid, nowIso) as any).n as number,
          cancelled: n("status = 'cancelled'"),
          attended: n("status = 'confirmed_attended'"),
          noShow: n("status = 'no_show'"),
        };
      };

      // ── (f) flag off → 404 ───────────────────────────────────────────
      setFlag(undefined);
      assertEq((await statsPage("o24agard", "o24-a")).status, 404, "f1: flag off → «Statistikk» is 404");
      setFlag("pilot");

      // ── AK1: the numbers == booking-store ─────────────────────────────
      const a = await statsPage("o24agard", "o24-a");
      const b = await statsPage("o24bgard", "o24-b");
      assertEq([a.status, b.status], [200, 200], "AK1a: both pages open (200)");
      assertEq([a.headers["cache-control"], b.headers["cache-control"]], ["no-store", "no-store"], "AK1b: no-store");
      const na = numbersOf(a.body);
      const nb = numbersOf(b.body);
      const sa = storeCounts("o24-a");
      const sb = storeCounts("o24-b");
      assertEq({ ...na, aiDeliveries: undefined }, { ...sa, aiDeliveries: undefined }, "AK1c: A — every count == booking-store's table");
      assertEq({ ...nb, aiDeliveries: undefined }, { ...sb, aiDeliveries: undefined }, "AK1d: B — every count == booking-store's table");
      assertEq(sa, { requests: 13, confirmed: 7, declined: 1, expired: 2, cancelled: 3, attended: 2, noShow: 1 }, "AK1e: A's seeded numbers (guard against a vacuous match)");
      assertEq(sb, { requests: 5, confirmed: 2, declined: 2, expired: 0, cancelled: 1, attended: 1, noShow: 0 }, "AK1f: B's seeded numbers");
      assertEq(Object.keys(na), ["requests", "confirmed", "declined", "expired", "cancelled", "attended", "noShow", "aiDeliveries"], "AK1g: the rows in text-pack order, AI last");

      // ── (o) ownership ─────────────────────────────────────────────────
      assertTrue(!a.body.includes("GS-B-") && !b.body.includes("GS-A-") && !a.body.includes("Gjest"), "o1: no booking refs or guest names on the page");
      assertEq((await get("/kategori/gardssalg/eier/o24agard/statistikk", cookie("o24-b"))).status, 403, "o2: B's session on A's page → 403");
      assertEq((await get("/kategori/gardssalg/eier/o24agard/statistikk")).status, 401, "o3: no session → 401");

      // ── (a) the AI row ────────────────────────────────────────────────
      assertEq([na.aiDeliveries, nb.aiDeliveries], [7, 3], "a1: AI deliveries per profile (experiences only, from the counting start)");
      assertTrue(a.body.includes(`<th scope="row">${T["stats.aiDeliveries"]}</th>`), "a2: stats.aiDeliveries verbatim");
      assertTrue(a.body.includes(`<p class="gs-st-hjelp">${T["stats.aiHelp"]}</p>`), "a3: stats.aiHelp verbatim");
      assertTrue(a.body.includes(`data-stats-period="ai">Siden 26. oktober 2026</p>`), "a4: the AI row's «Siden» = the counting start");

      // ── (p) stats.period ──────────────────────────────────────────────
      assertTrue(a.body.includes(`data-stats-period="requests">Siden 2. november 2026</p>`), "p1: A — Siden <the earliest request> (ISO created_at)");
      assertTrue(b.body.includes(`data-stats-period="requests">Siden 30. oktober 2026</p>`), "p2: B — Siden <its own earliest request> (SQLite created_at)");

      // ── (e) no request → empty.stats ──────────────────────────────────
      {
        const c = await statsPage("o24cgard", "o24-c");
        assertEq(c.status, 200, "e1: C opens (200)");
        assertTrue(c.body.includes("Det er ingen tall å vise ennå.") && c.body.includes(`data-gardssalg-empty="statistikk"`), "e2: no request → empty.stats verbatim");
        assertTrue(!c.body.includes("gs-statistikk") && !c.body.includes(T["stats.aiDeliveries"]), "e3: no numbers, no AI row (even with AI rows stored)");
      }

      // ── (t) texts, content rules ──────────────────────────────────────
      assertEq(T, {
        "stats.heading": "Slik har det gått",
        "stats.requests": "Forespørsler",
        "stats.confirmed": "Bekreftet",
        "stats.declined": "Avslått",
        "stats.expired": "Utløpt uten svar",
        "stats.cancelled": "Avlyst eller trukket",
        "stats.attended": "Møtte",
        "stats.noShow": "Møtte ikke",
        "stats.aiDeliveries": "Ganger profilen din er vist i svar fra AI-assistenter",
        "stats.aiHelp": "Tallet viser hvor ofte en AI-assistent har hentet profilen din for å svare noen. Det sier ikke om personen så svaret eller tok kontakt.",
        "stats.period": "Siden {dato}",
      }, "t1: tekstpakke OA-3 §1.4 verbatim");
      assertTrue(a.body.includes(`<h2 id="gs-st-tittel">${T["stats.heading"]}</h2>`), "t2: stats.heading");
      for (const k of st.STATS_COUNT_KEYS) assertTrue(a.body.includes(`<tr data-stat="${k}"><th scope="row">${T[`stats.${k}`]}</th>`), `t3: stats.${k} verbatim`);
      const card = (/<section class="gc-card gs-statistikk"[\s\S]*?<\/section>/.exec(a.body) || [""])[0];
      assertTrue(card !== "" && !/\bkr\b|%|vol\.|alkohol|smak|pris/i.test(card), "t4: no price, strength, tasting or product words");

      // ── AK7 (dev-request 2026-11-24-…-testfunn, slice 6): label left, number right ─
      {
        const css = st.GARDSSALG_STATS_CSS;
        const rule = (sel: string) => (new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css) || ["", ""])[1];
        assertTrue(a.body.includes(`<style>${css}</style>`), "AK7a: the «Statistikk» page carries the number-table CSS");
        assertTrue(/width:\s*100%/.test(rule(".gs-st-tall")) && /border-collapse:\s*collapse/.test(rule(".gs-st-tall")), "AK7b: both tables fill the card (width 100%), so the columns line up");
        assertTrue(/text-align:\s*left/.test(rule(".gs-st-tall th")), "AK7c: the label cell is left-aligned");
        assertTrue(/text-align:\s*right/.test(rule(".gs-st-tall td")) && /white-space:\s*nowrap/.test(rule(".gs-st-tall td")), "AK7d: the number cell is right-aligned and never wraps");
        assertTrue(/padding-right:\s*1\d+px/.test(rule(".gs-st-tall th")) && /padding-left:\s*1\d+px/.test(rule(".gs-st-tall td")), "AK7e: a gap between label and number");
        assertTrue(/overflow-wrap:\s*anywhere/.test(rule(".gs-st-tall th")), "AK7f: a long label (the AI row) wraps inside its own cell");
        const widths = [...css.matchAll(/(?:^|[;{\s])(?:min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
        assertTrue(widths.every((w) => w <= 390) && !/table-layout:\s*fixed/.test(css), "AK7g: no fixed width above 390 px, no fixed table layout (no horizontal scroll at 390 px)");
        assertTrue(!/prefers-color-scheme/.test(css), "AK7h: no dark-mode rule added");
        assertEq((card.match(/<table class="gs-st-tall"/g) || []).length, 2, "AK7i: both tables (requests and AI) use the same aligned layout");
      }

      // ── pure model: the mapping ───────────────────────────────────────
      {
        const m = st.statistikkModel(store.listProviderBookings("o24-a", Number.MAX_SAFE_INTEGER), new Date());
        assertEq(m.counts, sa, "m1: statistikkModel over listProviderBookings == the table counts");
        assertEq(st.statistikkModel([], new Date()), { counts: { requests: 0, confirmed: 0, declined: 0, expired: 0, cancelled: 0, attended: 0, noShow: 0 }, firstRequestAt: null }, "m2: no rows → zeros");
        const html = st.renderGardssalgStatistikk(m, null);
        assertTrue(!html.includes(T["stats.aiDeliveries"]) && !html.includes(T["stats.aiHelp"]), "m3: no AI number → the AI row is left out");
      }

      // ── (f) a GET writes nothing ──────────────────────────────────────
      const before = changes();
      for (const [slug, pid] of [["o24agard", "o24-a"], ["o24bgard", "o24-b"], ["o24cgard", "o24-c"]]) await statsPage(slug, pid);
      assertEq(changes(), before, "f2: the «Statistikk» GETs write nothing (both databases)");
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
  runGardssalgOwnerDashboardO24Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
