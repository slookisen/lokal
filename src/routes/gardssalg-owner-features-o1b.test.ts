/**
 * gardssalg-owner-features-o1b.test.ts — dev-request 2026-10-22-opplevagent-
 * mine-valg-gardssalg, «v2 for Opplevagent», slice O1b.
 *
 *   (t) «Prisbudskapet» (Daniel 29.10, verbatim) on /slik-fungerer-det and on
 *       the producer's attendance page; «tar ingen andel av et salg» and
 *       «Bekreftet oppmøte regnes med i provisjonsgrunnlaget» are gone; the
 *       attendance page says neutrally that attendance is registered; never
 *       «Rett fra Bonden». Public text: NOT behind the owner-features flag.
 *   (n) portal, tab NOT open (flag off, or allowlisted but not the test
 *       producer): the booking checkbox and the pause card are there and the
 *       markup around them is exactly as before; the old write paths work.
 *   (y) portal, tab open (principle 7, «Én bryter, ett sted»): no checkbox,
 *       no pause card, a pointer to «Mine valg»; the profile text fields
 *       stay; the old write paths (save form booking field, update-profile
 *       booking_live, pause/resume no-JS and JSON) change neither
 *       booking_live nor the pause.
 *
 * Exported runGardssalgOwnerFeaturesO1bTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-features-o1b.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PRICE_MESSAGE =
  "Det koster ingenting i dag. Innfører vi provisjon på besøk, får du beskjed minst 30 dager før, og du kan slå av besøk når som helst.";

export function runGardssalgOwnerFeaturesO1bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OA_OWNER_FEATURES_ENABLED;
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o1b-test,gardssalg:o1b-real";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
      require.resolve("./experiences-seo"),
    ]);
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

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '["Eplesider"]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @booking_live, @is_test_provider, datetime('now'))
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.no`, epost: `post@${slug}.no`,
          booking_live: 1, is_test_provider: 1, ...extra,
        });
      mk("o1b-test", "Testgård Sideri", "testgard", "918100001");
      mk("o1b-real", "Ekte Gård", "ektegard", "918100002", { is_test_provider: null });
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["o1b-test", "tok-test"], ["o1b-real", "tok-real"]]) {
        claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.no`, tok);
      }

      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const app = expressMod();
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
      const portal = (slug: string) => `/kategori/gardssalg/eier/${slug}/portal`;
      const row = (id: string) => expDb.prepare(
        `SELECT booking_live, catalog_hidden, catalog_hidden_reason, about_text FROM experience_providers WHERE id = ?`,
      ).get(id) as { booking_live: number | null; catalog_hidden: number | null; catalog_hidden_reason: string | null; about_text: string | null };
      const setBooking = (id: string, v: number) => expDb.prepare(`UPDATE experience_providers SET booking_live = ? WHERE id = ?`).run(v, id);

      // ── (t) public text: price message, both with the flag off and on ─────
      for (const flag of ["off", "on"] as const) {
        if (flag === "on") process.env.OA_OWNER_FEATURES_ENABLED = "true";
        else delete process.env.OA_OWNER_FEATURES_ENABLED;
        const sf = await req("GET", "/slik-fungerer-det");
        assertEq(sf.status, 200, `t1[${flag}]: /slik-fungerer-det renders`);
        const booking = (sf.body.match(/<section class="ft-section" aria-labelledby="sf-booking-h"[^>]*>([\s\S]*?)<\/section>/) || [])[1] || "";
        assertTrue(booking.includes(PRICE_MESSAGE), `t2[${flag}]: /slik-fungerer-det carries the price message verbatim (booking section)`);
        assertTrue(!sf.body.includes("tar ingen andel av et salg") && !sf.body.includes("ingen andel"), `t3[${flag}]: «tar ingen andel av et salg» is gone`);
        assertTrue(!sf.body.includes("<b>Det koster ingenting.</b>"), `t4[${flag}]: the unconditional «Det koster ingenting.» headline is replaced`);
        assertTrue(booking.includes("håndterer ikke betaling"), `t5[${flag}]: still says Opplevagent handles no payment`);
        assertTrue(!/rett fra bonden/i.test(booking), `t6[${flag}]: the touched text never names Rett fra Bonden`);
      }

      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const past = bookingStore.createBooking({
        provider_id: "o1b-test", slot_at: "2020-01-07T12:00", party_size: 2,
        guest_name: "Per Fortid", guest_email: "per@example.no",
      });
      for (const flag of ["off", "on"] as const) {
        if (flag === "on") process.env.OA_OWNER_FEATURES_ENABLED = "true";
        else delete process.env.OA_OWNER_FEATURES_ENABLED;
        const att = await req("GET", `/kategori/gardssalg/bekreft/${past.confirm_token}`);
        assertEq(att.status, 200, `t7[${flag}]: the attendance page renders`);
        assertTrue(att.body.includes(PRICE_MESSAGE), `t8[${flag}]: the attendance page carries the price message verbatim`);
        assertTrue(att.body.includes("Oppmøtet blir registrert."), `t9[${flag}]: neutral sentence: attendance is registered`);
        assertTrue(!att.body.includes("provisjonsgrunnlag") && !att.body.includes("regnes med i"), `t10[${flag}]: «Bekreftet oppmøte regnes med i provisjonsgrunnlaget» is gone`);
        assertTrue(!/rett fra bonden/i.test(att.body), `t11[${flag}]: the attendance page never names Rett fra Bonden`);
      }

      // ── (n) tab NOT open: the portal exactly as before ────────────────────
      delete process.env.OA_OWNER_FEATURES_ENABLED;
      const off = await req("GET", portal("testgard"), cookie("tok-test"));
      assertEq(off.status, 200, "n1: portal opens with the flag off");
      assertTrue(off.body.includes('id="f-booking"') && off.body.includes("Aktiver reservasjoner (booking) for besøkende"), "n2: flag off → the booking checkbox is there");
      assertTrue(off.body.includes('data-visibility-state="visible"') && off.body.includes("Sett profilen på pause"), "n3: flag off → the pause card is there");
      assertTrue(!off.body.includes("data-moved-to-mine-valg") && !off.body.includes("data-mine-valg"), "n4: flag off → no pointer and no «Mine valg» card");
      // Markup around the moved parts is byte-for-byte what main rendered.
      assertTrue(/\n      <\/div>\n      <div class="gc-card">\n        <h2>Profilinformasjon<\/h2>/.test(off.body), "n5: the card slot adds nothing (as O1a f3b)");
      assertTrue(/<\/div>\n          <div class="gc-field gc-toggle-row">\n            <input id="f-booking" name="field_booking_live" type="checkbox" value="1" style="width:auto;min-height:0;" checked >\n            <label for="f-booking" style="margin:0;">Aktiver reservasjoner \(booking\) for besøkende<\/label>\n          <\/div>\n          \n          <div class="gc-form-actions">/.test(off.body),
        "n6: the checkbox row and the line after it are exactly as before");
      assertTrue(/payload\.booking_live = fd\.get\("field_booking_live"\) \? 1 : 0;\n            var btn = document\.getElementById\("gc-save-btn"\);/.test(off.body), "n7: the JS save still sends booking_live, exactly as before");
      assertTrue(/<\/form>\n      <\/div>\n      <div class="gc-card" data-visibility-state="visible"><h2>Synlighet<\/h2>/.test(off.body), "n8: the pause card follows the profile card exactly as before");

      process.env.OA_OWNER_FEATURES_ENABLED = "true";
      const realOn = await req("GET", portal("ektegard"), cookie("tok-real"));
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o1b-test";
      const realNotListed = await req("GET", portal("ektegard"), cookie("tok-real"));
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:o1b-test,gardssalg:o1b-real";
      delete process.env.OA_OWNER_FEATURES_ENABLED;
      const realOff = await req("GET", portal("ektegard"), cookie("tok-real"));
      assertEq(realOn.body, realOff.body, "n9: allowlisted but not the test producer → portal byte-identical to flag off");
      assertEq(realNotListed.body, realOff.body, "n10: not allowlisted (flag on) → portal byte-identical to flag off");

      // Old write paths work as before while the tab is not open.
      setBooking("o1b-test", 1);
      const saveOff = await req("POST", "/kategori/gardssalg/eier/testgard/save", { ...form, ...cookie("tok-test") }, "field_about_text=Om+oss");
      assertTrue(saveOff.status === 303 && String(saveOff.headers.location).includes("status=saved"), "n11: no-JS save works");
      assertEq(row("o1b-test").booking_live, 0, "n12: flag off → an unchecked booking box still switches booking off (as before)");
      const apiOff = await req("POST", "/api/opplevelser/gardssalg-claim/o1b-test/update-profile", { ...json, ...cookie("tok-test") }, JSON.stringify({ booking_live: 1 }));
      const apiOffJ = JSON.parse(apiOff.body);
      assertTrue(apiOff.status === 200 && apiOffJ.success && !("ignored_fields" in apiOffJ), "n13: flag off → update-profile answers as before");
      assertEq(row("o1b-test").booking_live, 1, "n14: flag off → update-profile booking_live=1 switches booking on (as before)");
      const pauseOff = await req("POST", "/kategori/gardssalg/eier/testgard/pause", cookie("tok-test"));
      assertTrue(pauseOff.status === 303 && String(pauseOff.headers.location).includes("status=paused"), "n15: flag off → no-JS pause works");
      assertEq([row("o1b-test").catalog_hidden, row("o1b-test").catalog_hidden_reason], [1, "owner_pause"], "n16: … and paused the profile");
      const resumeOffJ = await req("POST", "/api/opplevelser/gardssalg-claim/o1b-test/resume", cookie("tok-test"));
      assertTrue(resumeOffJ.status === 200 && JSON.parse(resumeOffJ.body).state === "visible", "n17: flag off → JSON resume works");

      // ── (y) tab open: one switch, one place ──────────────────────────────
      process.env.OA_OWNER_FEATURES_ENABLED = "true";
      const on = await req("GET", portal("testgard"), cookie("tok-test"));
      assertEq(on.status, 200, "y1: portal opens with the tab open");
      assertTrue(!on.body.includes('id="f-booking"') && !on.body.includes("field_booking_live") && !on.body.includes("Aktiver reservasjoner"), "y2: no booking checkbox");
      assertTrue(!on.body.includes("data-visibility-state") && !on.body.includes("Sett profilen på pause") && !on.body.includes("/testgard/pause"), "y3: no pause card");
      assertTrue(on.body.includes('data-moved-to-mine-valg="1"') && on.body.includes("velger du nå i «Mine valg»")
        && on.body.includes('href="/kategori/gardssalg/eier/testgard/valg#gruppe-booking"')
        && on.body.includes('href="/kategori/gardssalg/eier/testgard/valg#gruppe-visibility"'), "y4: a short pointer to «Mine valg» (besøk and pause)");
      assertTrue(on.body.includes('data-mine-valg="1"'), "y5: the «Mine valg» card is still there");
      assertTrue(["f-about", "f-visit", "f-hours", "f-products", "f-website"].every((id) => on.body.includes(`id="${id}"`)), "y6: the profile text fields stay");
      assertTrue(!on.body.includes("payload.booking_live"), "y7: the JS save no longer sends booking_live");
      assertTrue(!/rett fra bonden/i.test(on.body), "y8: the portal never names Rett fra Bonden");

      // Old write paths cannot bypass «Mine valg».
      setBooking("o1b-test", 1);
      const saveOn = await req("POST", "/kategori/gardssalg/eier/testgard/save", { ...form, ...cookie("tok-test") }, "field_about_text=Ny+tekst");
      assertTrue(saveOn.status === 303 && String(saveOn.headers.location).includes("status=saved"), "y9: no-JS save of the text fields still works");
      assertEq([row("o1b-test").booking_live, row("o1b-test").about_text], [1, "Ny tekst"], "y10: … text saved, booking_live unchanged (missing box ≠ off)");
      setBooking("o1b-test", 0);
      await req("POST", "/kategori/gardssalg/eier/testgard/save", { ...form, ...cookie("tok-test") }, "field_about_text=Ny+tekst&field_booking_live=1");
      assertEq(row("o1b-test").booking_live, 0, "y11: a posted field_booking_live=1 is ignored (booking stays off)");
      setBooking("o1b-test", 1);
      const apiOn = await req("POST", "/api/opplevelser/gardssalg-claim/o1b-test/update-profile", { ...json, ...cookie("tok-test") }, JSON.stringify({ booking_live: 0, about_text: "Via API" }));
      const apiOnJ = JSON.parse(apiOn.body);
      assertTrue(apiOn.status === 200 && apiOnJ.success && JSON.stringify(apiOnJ.ignored_fields) === JSON.stringify(["booking_live"]), "y12: update-profile reports booking_live as ignored");
      assertEq([row("o1b-test").booking_live, row("o1b-test").about_text], [1, "Via API"], "y13: … booking_live unchanged, text saved");
      // O2a: n17's resume put this test producer back to the fixture state
      // (catalog_hidden=1, reason 'test_fixture', never public), so «not
      // paused» is read from the reason.
      const pauseOn = await req("POST", "/kategori/gardssalg/eier/testgard/pause", cookie("tok-test"));
      assertTrue(pauseOn.status === 303 && String(pauseOn.headers.location).includes("status=managed_in_mine_valg"), "y14: no-JS pause → refused, pointing to «Mine valg»");
      assertTrue(row("o1b-test").catalog_hidden_reason !== "owner_pause", "y15: … the profile was not paused");
      const pauseOnJ = await req("POST", "/api/opplevelser/gardssalg-claim/o1b-test/pause", cookie("tok-test"));
      assertEq([pauseOnJ.status, JSON.parse(pauseOnJ.body).error], [409, "managed_in_mine_valg"], "y16: JSON pause → 409 managed_in_mine_valg");
      assertTrue(row("o1b-test").catalog_hidden_reason !== "owner_pause", "y17: … the profile was not paused");
      expDb.prepare(`UPDATE experience_providers SET catalog_hidden = 1, catalog_hidden_reason = 'owner_pause' WHERE id = 'o1b-test'`).run();
      const resumeOn = await req("POST", "/kategori/gardssalg/eier/testgard/resume", cookie("tok-test"));
      assertTrue(String(resumeOn.headers.location).includes("status=managed_in_mine_valg"), "y18: no-JS resume → refused too");
      assertEq(row("o1b-test").catalog_hidden, 1, "y19: … the pause is unchanged");
      const pausedPortal = await req("GET", `${portal("testgard")}?status=managed_in_mine_valg`, cookie("tok-test"));
      assertTrue(pausedPortal.body.includes("Dette velger du nå i «Mine valg»") && pausedPortal.body.includes('data-moved-to-mine-valg="1"'), "y20: the portal explains the refusal; an owner-paused profile also gets the pointer");
      expDb.prepare(`UPDATE experience_providers SET catalog_hidden = NULL, catalog_hidden_reason = NULL WHERE id = 'o1b-test'`).run();

    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
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
  runGardssalgOwnerFeaturesO1bTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-owner-features-o1b: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
