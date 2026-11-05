/**
 * gardssalg-owner-features-o1a.test.ts — dev-request 2026-10-22-opplevagent-
 * mine-valg-gardssalg, «v2 for Opplevagent», slice O1a: «Mine valg» for
 * gårdssalg owners.
 *
 *   (g) registry: 34 gårdssalg entries (Vedlegg A), vertical, NO+EN, both
 *       segments, the live set, shared RFB key names, two levels;
 *   (f) flag + allowlist: OA_OWNER_FEATURES_ENABLED off → 404 and the portal
 *       unchanged; not allowlisted / not the test producer → 404; no session
 *       → 401; another producer's session → 403;
 *   (p) the page from the shared component: real choices only, the closed
 *       «Planlagt» box, no value on planned entries, the price message
 *       verbatim, the visit explanation with the code's timings, the
 *       prerequisite check, no level marked, never «Rett fra Bonden»;
 *   (w) writes: booking.enabled ↔ booking_live with the existing log, the
 *       enable gate (409 with a Norwegian reason), PUT on a planned key → 409
 *       and no effect;
 *   (i) «Gi meg beskjed»: one row per (subject, key), idempotent, no effect;
 *   (s) booking.pause: REST and book_gardssalg refuse a new request with
 *       «tar ikke imot forespørsler nå», the AI discover note says the same,
 *       the profile stays visible; off (or flag off) → requests go through.
 *
 * Exported runGardssalgOwnerFeaturesO1aTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-features-o1a.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PRICE_MESSAGE =
  "Det koster ingenting i dag. Innfører vi provisjon på besøk, får du beskjed minst 30 dager før, og du kan slå av besøk når som helst.";

const EXPECTED_LIVE = [
  "visibility.profile", "booking.enabled", "booking.pause", "booking.reminder", "booking.attendance",
  "content.guarantee", "notify.booking_email", "comms.unsubscribe",
];

function nextWeekdayDatetimeLocal(targetDow: number, hour: number, minute: number, minDaysAhead = 1): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(hour)}:${pad(minute)}`;
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : {};
  }
  return JSON.parse(text);
}

export function runGardssalgOwnerFeaturesO1aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OA_OWNER_FEATURES_ENABLED;
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o1-test,gardssalg:o1-noemail,gardssalg:o1-real,gardssalg:o1-brake";
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-seo"),
    ]);
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

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

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async () => ({ success: true, messageId: "test" });

      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const gate = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
      const gs = require("../owner-features/gardssalg") as typeof import("../owner-features/gardssalg");

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider,
           booking_admin_brake_at, booking_admin_brake_note, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '["Eplesider"]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @booking_live, @is_test_provider,
           @brake_at, @brake_note, datetime('now'))
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.no`, epost: `post@${slug}.no`,
          booking_live: 0, is_test_provider: 1, brake_at: null, brake_note: null, ...extra,
        });
      mk("o1-test", "Testgård Sideri", "testgard", "918000001");
      mk("o1-noemail", "Uten Epost Gård", "utenepost", "918000002", { epost: null });
      mk("o1-real", "Ekte Gård", "ektegard", "918000003", { is_test_provider: null });
      mk("o1-other", "Annen Gård", "annengard", "918000004");
      mk("o1-brake", "Bremsegård", "bremsegard", "918000005", { brake_at: "2026-10-20 10:00:00", brake_note: "klage fra gjest" });
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["o1-test", "tok-test"], ["o1-noemail", "tok-ne"], ["o1-real", "tok-real"], ["o1-other", "tok-other"], ["o1-brake", "tok-br"]]) {
        claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.no`, tok);
      }

      // ── (g) registry ──────────────────────────────────────────────────
      const R = reg.GARDSSALG_OWNER_FEATURE_REGISTRY;
      assertEq(R.length, 34, "g1: 34 gårdssalg entries (Vedlegg A)");
      assertEq(R.map((e) => e.key), [...reg.GARDSSALG_OWNER_FEATURE_KEYS], "g2: registry order == GARDSSALG_OWNER_FEATURE_KEYS");
      assertTrue(R.every((e) => JSON.stringify(e.verticals) === JSON.stringify(["gardssalg"])), "g3: every entry has verticals [gardssalg]");
      assertTrue(R.every((e) => e.label.no && e.label.en && e.description.no && e.description.en), "g4: NO+EN label and description on every entry");
      assertTrue(R.every((e) => "owner" in e.default && "unclaimed" in e.default), "g5: a default for both segments on every entry");
      assertEq(R.filter((e) => e.status === "live").map((e) => e.key).sort(), [...EXPECTED_LIVE].sort(), "g6: live set is exactly what O1a enforces");
      assertTrue(R.filter((e) => e.status !== "live").every((e) => e.status === "coming_soon"), "g7: everything else is coming_soon");
      for (const k of ["notify.changes", "notify.report", "notify.milestones"]) {
        assertEq(R.find((e) => e.key === k)?.status, "coming_soon", `g8: ${k} is coming_soon until the e-mail exists`);
      }
      const shared = ["visibility.profile", "visibility.ai_assistants", "visibility.search_engines", "visibility.english",
        "contact.phone", "contact.email_mode", "contact.address", "notify.report", "notify.milestones", "notify.changes",
        "stats.public_counts", "stats.share_partner", "comms.unsubscribe", "comms.news", "comms.beta", "comms.featured"];
      assertTrue(shared.every((k) => (reg.OWNER_FEATURE_KEYS as readonly string[]).includes(k) && R.some((e) => e.key === k)), "g9: shared choices reuse the RFB key names");
      assertTrue(!/rett fra bonden/i.test(JSON.stringify(R.map((e) => [e.label, e.description, e.confirmOn, e.confirmOff, e.options])) + JSON.stringify(reg.GARDSSALG_OWNER_FEATURE_GROUPS)), "g10: no gårdssalg registry text names Rett fra Bonden");
      assertEq(ch.GARDSSALG_OWNER_LEVELS.map((l) => l.label.no), ["Bare synlig", "Ta imot besøk"], "g11: exactly two levels, «Bare synlig» and «Ta imot besøk»");
      assertEq(R.find((e) => e.key === "booking.enabled")?.storage?.column, "experience_providers.booking_live", "g12: booking.enabled is the booking_live adapter (no new state)");
      // RFB registry unchanged by this slice.
      assertTrue(reg.OWNER_FEATURE_REGISTRY.every((e) => JSON.stringify(e.verticals) === JSON.stringify(["rfb"])), "g13: RFB entries keep verticals [rfb]");

      // Resolver: owner segment, defaults, planned entries locked.
      const resolved0 = rs.resolveOwnerFeatures("gardssalg", "o1-test");
      assertEq(resolved0.subject.segment, "owner", "g14: a live verified claim → owner segment");
      assertEq(resolved0.byKey["booking.enabled"].value, false, "g15: booking.enabled reads booking_live (0 → off)");
      assertEq(resolved0.byKey["visibility.profile"].value, true, "g16: visibility.profile reads the owner pause state (visible → on)");
      assertTrue(R.filter((e) => e.status === "coming_soon").every((e) => resolved0.byKey[e.key].block === "coming_soon"), "g17: every planned entry is not changeable (coming_soon)");
      assertEq(rs.resolveOwnerFeatures("gardssalg", "o1-test").subject.vertical, "gardssalg", "g18: subject vertical gardssalg");

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const ownerFeaturesRoutes = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const app = expressMod();
      app.use("/api/opplevelser", expressMod.json(), opplevelserRouter);
      app.use("/", claimRouter);
      app.use("/", seoRouter);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body) r.write(body);
          r.end();
        });
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const json = { "Content-Type": "application/json" };
      const form = { "Content-Type": "application/x-www-form-urlencoded" };
      const page = (slug: string, tail = "") => `/kategori/gardssalg/eier/${slug}/valg${tail}`;
      const api = (id: string, tail = "") => `/api/opplevelser/gardssalg-claim/${id}/features${tail}`;
      const settingsRows = () => (rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_settings WHERE vertical = 'gardssalg'`).get() as any).n;
      const bookingLive = (id: string) => (expDb.prepare(`SELECT booking_live FROM experience_providers WHERE id = ?`).get(id) as any).booking_live;

      // ── (f) flag off: nothing changes ─────────────────────────────────
      const portalOff = await req("GET", "/kategori/gardssalg/eier/testgard/portal", cookie("tok-test"));
      assertEq(portalOff.status, 200, "f1: portal opens with the flag off");
      assertTrue(!portalOff.body.includes("data-mine-valg"), "f2: flag off → no «Mine valg» card in the portal");
      assertTrue(portalOff.body.includes('id="f-booking"'), "f3: flag off → the portal booking checkbox is still there (O1b removes it only while the tab is open)");
      // Byte-identical with the flag off: the card slot adds no line and no
      // whitespace — the profile card follows the header card exactly as on main.
      assertTrue(/\n      <\/div>\n      <div class="gc-card">\n        <h2>Profilinformasjon<\/h2>/.test(portalOff.body), "f3b: flag off → the portal markup around the card slot is exactly as before (no extra line)");
      assertEq((await req("GET", page("testgard"), cookie("tok-test"))).status, 404, "f4: flag off → the tab is 404");
      assertEq((await req("GET", api("o1-test"), cookie("tok-test"))).status, 404, "f5: flag off → the API is 404");
      assertEq((await req("PUT", api("o1-test", "/booking.enabled"), { ...json, ...cookie("tok-test") }, JSON.stringify({ value: true }))).status, 404, "f6: flag off → PUT is 404");
      assertEq(bookingLive("o1-test"), 0, "f7: flag off → nothing written");
      assertTrue(!gs.gardssalgOwnerBookingPaused("o1-test"), "f8: flag off → the pause reader never applies");

      process.env.OA_OWNER_FEATURES_ENABLED = "true";
      assertEq((await req("GET", page("annengard"), cookie("tok-other"))).status, 404, "f9: not allowlisted → 404");
      assertEq((await req("GET", page("ektegard"), cookie("tok-real"))).status, 404, "f10: allowlisted but not the test producer → 404 (O1a: test producer only)");
      assertEq((await req("GET", page("testgard"))).status, 401, "f11: no session → 401");
      assertEq((await req("GET", page("testgard"), cookie("tok-other"))).status, 403, "f12: another producer's session → 403 (non-owner rejected)");
      assertEq((await req("GET", api("o1-test"), cookie("tok-other"))).status, 403, "f13: API with another producer's session → 403");
      assertEq((await req("POST", page("testgard", "/sett"), { ...form, ...cookie("tok-other") }, "key=booking.enabled&value=true&confirmed=1")).status, 403, "f14: write with another producer's session → 403");
      assertEq(bookingLive("o1-test"), 0, "f15: refused calls wrote nothing");
      const portalOn = await req("GET", "/kategori/gardssalg/eier/testgard/portal", cookie("tok-test"));
      assertTrue(portalOn.body.includes('data-mine-valg="1"') && portalOn.body.includes('href="/kategori/gardssalg/eier/testgard/valg"'), "f16: tab open → the portal links to «Mine valg»");
      // O1b (principle 7) changed this: with the tab open the portal also
      // drops the booking checkbox and the pause card for a pointer to «Mine
      // valg» (covered in gardssalg-owner-features-o1b.test.ts). What stays
      // from O1a: the card is added and the profile text form is unchanged.
      const profileForm = (body: string) => {
        const start = body.indexOf('<form id="gc-profile-form"');
        return start < 0 ? "" : body.slice(start, body.indexOf("</div>", body.indexOf('id="f-website"', start)));
      };
      assertTrue(profileForm(portalOn.body).length > 0, "f16a: the profile form is there with the tab open");
      assertEq(profileForm(portalOn.body), profileForm(portalOff.body), "f16b: with the tab open the profile text fields are exactly as with the flag off (O1b: booking checkbox and pause card moved to «Mine valg»)");
      const portalReal = await req("GET", "/kategori/gardssalg/eier/ektegard/portal", cookie("tok-real"));
      assertTrue(portalReal.status === 200 && !portalReal.body.includes("data-mine-valg"), "f17: a real producer's portal gets no link");

      // ── (p) the page ──────────────────────────────────────────────────
      const p = await req("GET", page("testgard"), cookie("tok-test"));
      assertEq(p.status, 200, "p1: owner → 200");
      const b = p.body;
      assertTrue(b.includes("<h1>Mine valg</h1>") && b.includes("Testgård Sideri"), "p2: the shared «Mine valg» page for the producer");
      assertTrue(!/rett fra bonden/i.test(b), "p3: the page never names Rett fra Bonden");
      assertTrue(b.includes(PRICE_MESSAGE), "p4: the price message, verbatim");
      const planned = R.filter((e) => e.status === "coming_soon");
      assertTrue(b.includes(`Planlagt — si fra hvis du vil ha dette (${planned.length})`), "p5: the «Planlagt» box with its count");
      assertTrue(/<details class="ep-card mv-planned" id="planlagt">/.test(b), "p6: the «Planlagt» box is closed by default");
      assertTrue(planned.every((e) => b.includes(`data-planned-key="${e.key}"`) && !b.includes(`id="valg-${e.key}"`)), "p7: every planned entry is only in the box, never a row in the main view");
      assertTrue(planned.every((e) => !b.includes(`data-status-key="${e.key}"`)), "p8: no planned entry in «Slik er du nå» (no false values)");
      assertEq((b.match(/data-level="/g) || []).length, 2, "p9: two levels on the page");
      assertTrue(!/<li class="mv-level" aria-current="true"/.test(b) && b.includes("Du har ikke valgt nivå ennå"), "p10: no level marked before the owner chose one");
      assertTrue(b.includes('id="valg-booking.enabled"') && b.includes("Ta imot besøk"), "p11: the «Ta imot besøk» switch is in the main view");
      assertTrue(b.includes('data-booking-check="ok"') && b.includes("post@testgard.no"), "p12: prerequisite check: requests go to the profile address");
      assertTrue(b.includes("påminnelse etter 24 timer") && b.includes("etter 60 timer, utløper den"), "p13: explanation uses booking-store's reminder (24 h) and expiry (60 h)");
      assertTrue(b.includes("bekrefter, avslår eller foreslår et annet tidspunkt") && b.includes("Du trenger ikke logge inn"), "p14: explanation: answer page without login");
      assertTrue(b.includes("selger ingenting og håndterer ikke betaling"), "p15: explanation: Opplevagent sells nothing, takes no payment");
      assertTrue(b.includes("Dette har profilen gjort for deg") && b.includes("Med i AI-søk"), "p16: proof-first statistics block");
      assertTrue(b.includes("«Alltid» betyr et løfte fra Opplevagent"), "p17: promises explained once, as Opplevagent's");
      assertTrue(!b.includes('id="valg-booking.pause"') && b.includes("valg til vises når du slår på «Ta imot besøk»"), "p18: the pause row appears only once booking is on");
      assertTrue(b.includes('action="/kategori/gardssalg/eier/testgard/valg/sett"'), "p19: forms post to the gårdssalg tab");
      const pNoEmail = await req("GET", page("utenepost"), cookie("tok-ne"));
      assertTrue(pNoEmail.body.includes('data-booking-check="no_email"') && pNoEmail.body.includes("mailto:kontakt@opplevagent.no"), "p20: no request address → the check says so, with where it is fixed");
      const pBrake = await req("GET", page("bremsegard"), cookie("tok-br"));
      assertTrue(pBrake.body.includes('data-booking-check="admin_brake"') && pBrake.body.includes("klage fra gjest"), "p21: admin brake → «stanset av Opplevagent» with the reason");
      const apiGet = JSON.parse((await req("GET", api("o1-test"), cookie("tok-test"))).body);
      assertTrue(apiGet.success && apiGet.features.length === 34, "p22: GET features lists the 34 entries");
      assertTrue(apiGet.features.filter((f: any) => f.status === "coming_soon").every((f: any) => f.value === null), "p23: API: no value on a planned entry");

      // ── (w) writes ────────────────────────────────────────────────────
      const putNoEmail = await req("PUT", api("o1-noemail", "/booking.enabled"), { ...json, ...cookie("tok-ne") }, JSON.stringify({ value: true }));
      assertEq(putNoEmail.status, 409, "w1: PUT booking.enabled=true without a request address → 409");
      assertTrue(/e-postadresse/.test(JSON.parse(putNoEmail.body).reason), "w2: 409 carries the Norwegian reason");
      assertEq(bookingLive("o1-noemail"), 0, "w3: nothing written");
      const putBrake = await req("PUT", api("o1-brake", "/booking.enabled"), { ...json, ...cookie("tok-br") }, JSON.stringify({ value: true }));
      assertTrue(putBrake.status === 409 && /stanset av Opplevagent/.test(JSON.parse(putBrake.body).reason), "w4: admin brake wins over the owner (409)");
      const putPlanned = await req("PUT", api("o1-test", "/contact.phone"), { ...json, ...cookie("tok-test") }, JSON.stringify({ value: false }));
      assertEq([putPlanned.status, JSON.parse(putPlanned.body).error], [409, "coming_soon"], "w5: PUT on a coming_soon key → 409");
      assertEq(settingsRows(), 0, "w6: … and no effect (no stored choice)");
      const unknownKey = await req("PUT", api("o1-test", "/orders.enabled"), { ...json, ...cookie("tok-test") }, JSON.stringify({ value: true }));
      assertEq(unknownKey.status, 404, "w7: an RFB-only key is unknown for gårdssalg");

      // Origin check: a cross-site write is refused and writes nothing.
      const auditCount = () => (rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE vertical = 'gardssalg'`).get() as any).n;
      const audit0 = auditCount();
      const evil = { Origin: "https://evil.example" };
      const xsPost = await req("POST", page("testgard", "/sett"), { ...form, ...evil, ...cookie("tok-test") }, "key=booking.enabled&value=true&confirmed=1");
      assertEq(xsPost.status, 403, "o1: page POST with a foreign Origin → 403");
      const xsPut = await req("PUT", api("o1-test", "/booking.enabled"), { ...json, ...evil, ...cookie("tok-test") }, JSON.stringify({ value: true }));
      assertEq(xsPut.status, 403, "o2: API PUT with a foreign Origin → 403");
      assertEq([bookingLive("o1-test"), auditCount()], [0, audit0], "o3: cross-site writes changed neither booking_live nor owner_feature_audit");
      // T0a (same-origin-write.ts): Fetch Metadata «cross-site» without an Origin is refused too, with the friendly page.
      const xsMeta = await req("POST", page("testgard", "/sett"), { ...form, "Sec-Fetch-Site": "cross-site", ...cookie("tok-test") }, "key=booking.enabled&value=true&confirmed=1");
      assertEq(xsMeta.status, 403, "t0a-g1: page POST with Sec-Fetch-Site: cross-site → 403");
      assertTrue(xsMeta.body.includes("<title>Kunne ikke lagre") || xsMeta.body.includes("Kunne ikke lagre"), "t0a-g2: refused page title «Kunne ikke lagre»");
      assertTrue(xsMeta.body.includes("Endringen ble ikke lagret") && xsMeta.body.includes("kontakt@opplevagent.no")
        && !xsMeta.body.includes("kontakt@rettfrabonden.com") && !/Rett fra Bonden/i.test(xsMeta.body), "t0a-g3: gårdssalg refusal names kontakt@opplevagent.no and never Rett fra Bonden");
      assertTrue(xsMeta.body.includes(`href="/kategori/gardssalg/eier/testgard/valg">Tilbake til Mine valg</a>`), "t0a-g4: back link «Tilbake til Mine valg»");
      assertEq([bookingLive("o1-test"), auditCount()], [0, audit0], "t0a-g5: the refused write changed nothing");

      const ask = await req("POST", page("testgard", "/sett"), { ...form, ...cookie("tok-test") }, "key=booking.enabled&value=true");
      assertTrue(ask.status === 303 && String(ask.headers.location).includes("bekreft=booking.enabled"), "w8: switching visits on asks for confirmation first");
      assertEq(bookingLive("o1-test"), 0, "w9: nothing written before the confirmation");
      // T0a: a plain form POST under Referrer-Policy: no-referrer carries «Origin: null» — accepted.
      const on = await req("POST", page("testgard", "/sett"), { ...form, Origin: "null", "Sec-Fetch-Site": "same-origin", ...cookie("tok-test") }, "key=booking.enabled&value=true&confirmed=1");
      assertTrue(on.status === 303 && /\?endret=\d+/.test(String(on.headers.location)), "w10: confirmed → saved (form POST with Origin: null)");
      assertEq(bookingLive("o1-test"), 1, "w11: the switch wrote experience_providers.booking_live");
      const contentAudit = expDb.prepare(`SELECT field_name, new_value, changed_by, batch_id FROM gardssalg_content_audit WHERE provider_id = 'o1-test' AND field_name = 'booking_live'`).all() as any[];
      assertEq(contentAudit.map((r) => [r.new_value, r.changed_by, r.batch_id]), [["1", "owner", "owner-portal"]], "w12: the existing booking_live log got its row");
      const ofAudit = rfbDb.prepare(`SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE vertical = 'gardssalg' AND subject_id = 'o1-test'`).all() as any[];
      assertEq(ofAudit.map((r) => [r.key, r.old_json, r.new_json, r.actor, r.actor_detail]), [["booking.enabled", "false", "true", "owner", "eier@o1-test.no"]], "w13: one owner_feature_audit row (vertical gardssalg)");
      assertEq(settingsRows(), 0, "w14: adapter entry stores no owner_feature_settings row");
      const pOn = (await req("GET", page("testgard", `?endret=${String(on.headers.location).match(/endret=(\d+)/)![1]}`), cookie("tok-test"))).body;
      assertTrue(pOn.includes("«Ta imot besøk» er På") && pOn.includes('id="valg-booking.pause"'), "w15: notice + the pause row shows once visits are on");

      // ── (i) «Gi meg beskjed» ──────────────────────────────────────────
      const interestRows = () => rfbDb.prepare(`SELECT vertical, subject_id, key, actor_detail FROM owner_feature_interest`).all() as any[];
      const i1 = await req("POST", page("testgard", "/interesse"), { ...form, ...cookie("tok-test") }, "key=contact.phone");
      assertTrue(i1.status === 303 && String(i1.headers.location).includes("melding=interesse"), "i1: «Gi meg beskjed» on a planned entry");
      assertEq(interestRows().map((r) => [r.vertical, r.subject_id, r.key, r.actor_detail]), [["gardssalg", "o1-test", "contact.phone", "eier@o1-test.no"]], "i2: one interest row per (subject, key)");
      const i2 = await req("POST", page("testgard", "/interesse"), { ...form, ...cookie("tok-test") }, "key=contact.phone");
      assertTrue(String(i2.headers.location).includes("melding=interesse_finnes") && interestRows().length === 1, "i3: idempotent");
      assertEq(settingsRows(), 0, "i4: interest has no effect (no stored choice)");
      assertEq(rs.resolveOwnerFeatures("gardssalg", "o1-test").byKey["contact.phone"].value, true, "i5: contact.phone resolves exactly as before");
      const i3 = await req("POST", page("testgard", "/interesse"), { ...form, ...cookie("tok-test") }, "key=booking.enabled");
      assertTrue(String(i3.headers.location).includes("melding=ugyldig") && interestRows().length === 1, "i6: a live entry takes no interest row");
      assertTrue((await req("GET", page("testgard"), cookie("tok-test"))).body.includes("Du har sagt fra"), "i7: the page shows the owner already asked");
      const interestCounts = (require("../owner-features/interest") as typeof import("../owner-features/interest")).ownerFeatureInterestCounts("gardssalg", { db: rfbDb });
      assertEq(interestCounts.find((c) => c.key === "contact.phone")?.count, 1, "i8: admin interest counts per gårdssalg key");

      // ── (s) booking.pause ─────────────────────────────────────────────
      const slot = nextWeekdayDatetimeLocal(2, 12, 0);
      const bookBody = JSON.stringify({ provider_id: "o1-test", slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" });
      const bookingRows = () => (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = 'o1-test'`).get() as any).n;
      const book0 = JSON.parse((await req("POST", "/api/opplevelser/book", json, bookBody)).body);
      assertEq(book0.success, true, "s0: visits on, no pause → REST request accepted (baseline)");
      const rows0 = bookingRows();
      const putPause = await req("PUT", api("o1-test", "/booking.pause"), { ...json, ...cookie("tok-test") }, JSON.stringify({ value: true }));
      assertEq(putPause.status, 200, "s1: owner switches the seasonal pause on");
      assertTrue(gs.gardssalgOwnerBookingPaused("o1-test"), "s2: the booking gate reads booking.pause");
      const book1 = JSON.parse((await req("POST", "/api/opplevelser/book", json, bookBody)).body);
      assertEq([book1.success, book1.paused, book1.reason], [false, true, "owner_paused"], "s3: REST: a new request is refused");
      assertTrue(/tar ikke imot forespørsler nå/.test(book1.message), "s4: REST: «tar ikke imot forespørsler nå»");
      assertEq(bookingRows(), rows0, "s5: no booking row was created");
      assertTrue(!!store.getGardssalgProviderBySlug("testgard"), "s6: the profile stays visible (public slug lookup)");
      assertTrue(store.listGardssalgProviders(200, 0).some((r: any) => r.id === "o1-test"), "s7: the profile stays in the public list");
      const status = gate.gardssalgBookingStatus({ id: "o1-test", booking_live: 1, claimed_at: "2026-10-01" });
      assertEq([status.live, status.mode, status.note], [false, "paused", gate.GARDSSALG_BOOKING_NOTE_NOT_TAKING], "s8: AI discover note: not taking requests now (G1 item 7)");
      assertEq(gate.gardssalgBookingStatus({ id: "o1-other", booking_live: 1, claimed_at: "2026-10-01" }).mode, "request", "s9: another producer is unaffected");

      // book_gardssalg over a real MCP session.
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const mcpApp = expressMod();
      mcpApp.use(expressMod.json());
      mcpApp.use((rq: any, rp: any, next: any) => (mcpRouter as any)(rq, rp, next));
      const mcpServer = httpMod.createServer(mcpApp);
      servers.push(mcpServer);
      await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", () => resolve()));
      const mcpAddr = mcpServer.address();
      // http.request, not fetch: other suites in the full run stub global fetch.
      const mcpPost = (payload: unknown, sessionId: string | null) =>
        new Promise<{ headers: any; body: string }>((resolve, reject) => {
          const data = JSON.stringify(payload);
          const r = httpMod.request({
            method: "POST", host: "127.0.0.1", port: typeof mcpAddr === "object" && mcpAddr ? mcpAddr.port : 0, path: "/mcp",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
          }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          r.write(data);
          r.end();
        });
      const initRes = await mcpPost({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "o1a-test", version: "1.0.0" } }, id: "1" }, null);
      const sessionId = (initRes.headers["mcp-session-id"] as string | undefined) ?? null;
      const callTool = async (name: string, args: Record<string, unknown>) => {
        const r = await mcpPost({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: String(Math.random()) }, sessionId);
        const body = parseJsonRpcBody(r.body, String(r.headers["content-type"] || ""));
        return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      };
      const mcp1 = await callTool("book_gardssalg", { provider_id: "o1-test", slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" });
      assertEq([mcp1.success, mcp1.reason], [false, "owner_paused"], "s10: book_gardssalg: refused while paused");
      assertTrue(/tar ikke imot forespørsler nå/.test(mcp1.message || ""), "s11: book_gardssalg: «tar ikke imot forespørsler nå»");
      assertEq(bookingRows(), rows0, "s12: no booking row via MCP");

      // The no-JS web booking form (experiences-seo.ts).
      const formBody = `slot_at=${encodeURIComponent(slot)}&party_size=2&guest_name=Kari+Nordmann&guest_email=kari%40example.no`;
      const formGet = await req("GET", "/kategori/gardssalg/book/testgard");
      assertTrue(formGet.status === 200 && formGet.body.includes('data-owner-paused="1"') && formGet.body.includes("tar ikke imot forespørsler nå"), "w-1: booking form shows the owner's pause up front");
      const formPost = await req("POST", "/kategori/gardssalg/book/testgard", form, formBody);
      assertTrue(formPost.status === 303 && String(formPost.headers.location).includes("error=not_taking"), "w-2: form POST while paused → 303 ?error=not_taking");
      assertEq(bookingRows(), rows0, "w-3: no booking row via the form");
      const formErr = await req("GET", "/kategori/gardssalg/book/testgard?error=not_taking");
      assertTrue(formErr.body.includes("Produsenten tar ikke imot forespørsler nå."), "w-4: the form's error banner says «tar ikke imot forespørsler nå»");

      // Allowlist in the pause reader: a stored pause for a producer that is
      // not allowlisted is never applied, even with the flag on.
      expDb.prepare(`UPDATE experience_providers SET booking_live = 1 WHERE id = 'o1-other'`).run();
      rfbDb.prepare(
        `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
         VALUES ('gardssalg', 'o1-other', 'booking.pause', 'true', 'owner', 0, ?)`,
      ).run(new Date().toISOString());
      assertTrue(rs.gardssalgFeatureOn("o1-other", "booking.pause"), "a-1: the seeded pause resolves on (so only the allowlist stops it)");
      assertTrue(!gs.gardssalgOwnerBookingPaused("o1-other"), "a-2: not allowlisted → the pause reader returns false");
      const otherBook = JSON.parse((await req("POST", "/api/opplevelser/book", json,
        JSON.stringify({ provider_id: "o1-other", slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" }))).body);
      assertEq(otherBook.success, true, "a-3: not allowlisted → REST accepts the request");

      // Flag off → today's behaviour: the pause is not read.
      delete process.env.OA_OWNER_FEATURES_ENABLED;
      assertTrue(!gs.gardssalgOwnerBookingPaused("o1-test"), "s13: flag off → the stored pause is not applied");
      const bookOff = JSON.parse((await req("POST", "/api/opplevelser/book", json, bookBody)).body);
      assertEq(bookOff.success, true, "s14: flag off → REST request accepted as today");
      const rowsFlagOff = bookingRows();
      const formOff = await req("POST", "/kategori/gardssalg/book/testgard", form, formBody);
      assertTrue(formOff.status === 303 && !String(formOff.headers.location).includes("error="), "s14b: flag off → the form accepts as today");
      assertEq(bookingRows(), rowsFlagOff + 1, "s14c: … and writes the booking row");
      assertTrue(!(await req("GET", "/kategori/gardssalg/book/testgard")).body.includes("data-owner-paused"), "s14d: flag off → no pause notice on the form");
      process.env.OA_OWNER_FEATURES_ENABLED = "true";

      const offPause = await req("PUT", api("o1-test", "/booking.pause"), { ...json, ...cookie("tok-test") }, JSON.stringify({ value: false }));
      assertEq(offPause.status, 200, "s15: owner switches the pause off");
      const book2 = JSON.parse((await req("POST", "/api/opplevelser/book", json, bookBody)).body);
      assertEq(book2.success, true, "s16: pause off → requests are taken again");
      const mcp2 = await callTool("book_gardssalg", { provider_id: "o1-test", slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" });
      assertEq(mcp2.success, true, "s17: pause off → book_gardssalg accepted again");
      const rowsPauseOff = bookingRows();
      const formOn = await req("POST", "/kategori/gardssalg/book/testgard", form, formBody);
      assertTrue(formOn.status === 303 && !String(formOn.headers.location).includes("error="), "s18: pause off → the form accepts again");
      assertEq(bookingRows(), rowsPauseOff + 1, "s19: … and writes the booking row");

      // Level: «Bare synlig» switches visits off; marked only after the owner's choice.
      const lvl = await req("POST", page("testgard", "/niva"), { ...form, ...cookie("tok-test") }, "level=bare_synlig&confirmed=1");
      assertTrue(lvl.status === 303 && /endret=\d+/.test(String(lvl.headers.location)), "l1: choosing «Bare synlig» saves");
      assertEq(bookingLive("o1-test"), 0, "l2: «Bare synlig» switched booking_live off");
      const pLvl = (await req("GET", page("testgard"), cookie("tok-test"))).body;
      assertTrue(/<li class="mv-level" aria-current="true" data-level="bare_synlig">/.test(pLvl), "l3: the level is marked after the owner chose it");
      // Undo restores booking_live through the same adapter.
      const undoId = String(lvl.headers.location).match(/endret=(\d+)/)![1];
      const undo = await req("POST", page("testgard", "/angre"), { ...form, ...cookie("tok-test") }, `batch=${undoId}`);
      assertEq(undo.status, 303, "l4: «Angre» answers 303");
      assertEq(bookingLive("o1-test"), 1, "l5: undo switched booking_live back on");

      // Late admin-brake refusal from the adapter (the brake landed after the
      // resolver's check): 409-class «blocked», never not_found, nothing kept.
      const noEnableGate = R.map((e) => (e.key === "booking.enabled" ? { ...e, enableRequires: [] } : e));
      const brakeAudit0 = (rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = 'o1-brake'`).get() as any).n;
      const late = rs.setOwnerFeatureValue("gardssalg", "o1-brake", "booking.enabled", true, { actor: "owner" }, { registry: noEnableGate });
      assertEq([late.kind, (late as any).block], ["blocked", "requirement_not_met"], "x1: the adapter's own brake refusal is a block (409), not not_found");
      assertTrue(late.kind === "blocked" && /stanset av Opplevagent/.test(late.reason.no) && /klage fra gjest/.test(late.reason.no), "x2: … with the Norwegian reason and the operator's note");
      assertEq(bookingLive("o1-brake"), 0, "x3: booking_live untouched");
      assertEq((rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = 'o1-brake'`).get() as any).n, brakeAudit0, "x4: the «Mine valg» log row was rolled back");

      // A failed log insert leaves the experiences.db column unchanged (log first, adapter last).
      const hidden = () => (expDb.prepare(`SELECT catalog_hidden FROM experience_providers WHERE id = 'o1-test'`).get() as any).catalog_hidden;
      const hidden0 = hidden();
      rfbDb.exec(`ALTER TABLE owner_feature_audit RENAME TO owner_feature_audit_away`);
      let threw = false;
      try {
        rs.setOwnerFeatureValue("gardssalg", "o1-test", "visibility.profile", false, { actor: "owner" });
      } catch { threw = true; }
      rfbDb.exec(`ALTER TABLE owner_feature_audit_away RENAME TO owner_feature_audit`);
      assertTrue(threw, "x5: the write fails when the log insert fails");
      assertEq(hidden(), hidden0, "x6: … and the profile was not paused (adapter never ran)");

      // 30 writes per minute per session.
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const limited: number[] = [];
      for (let n = 0; n < 30; n++) {
        limited.push((await req("POST", page("utenepost", "/interesse"), { ...form, ...cookie("tok-ne") }, "key=nope")).status);
      }
      assertTrue(limited.every((st) => st === 303), "r1: 30 writes in a minute are served");
      const over = await req("POST", page("utenepost", "/interesse"), { ...form, ...cookie("tok-ne") }, "key=contact.address");
      assertEq([over.status, String(over.headers.location)], [303, page("utenepost", "?melding=for_mange&ved=planlagt-contact.address#planlagt-contact.address")], "r2: the 31st write in a minute → 303 «For mange endringer» at the row (T5)");
      assertEq((rfbDb.prepare(`SELECT COUNT(*) AS n FROM owner_feature_interest WHERE subject_id = 'o1-noemail'`).get() as any).n, 0, "r3: the refused write stored nothing");
      const overPut = await req("PUT", api("o1-noemail", "/booking.enabled"), { ...json, ...cookie("tok-ne") }, JSON.stringify({ value: false }));
      assertEq(overPut.status, 429, "r4: the API shares the per-session limit");
      assertEq((await req("POST", page("testgard", "/interesse"), { ...form, ...cookie("tok-test") }, "key=nope")).status, 303, "r5: another session is not limited");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      if (initMod) initMod.__setDbForTesting(prevRfbDb);
      restoreModuleCache();
      for (const k of ENV_KEYS) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).__resetGardssalgOwnerFeaturesRateLimitForTesting();
      } catch { /* ignore */ }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgOwnerFeaturesO1aTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-owner-features-o1a: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
