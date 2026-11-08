/**
 * gardssalg-guest-contact-sweep.test.ts — dev-request
 * 2026-10-23-opplevagent-besoksforesporsler-automatisk-sletting.
 *
 * Standalone: npx tsx src/services/gardssalg-guest-contact-sweep.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const KEY = "gs-guest-sweep-admin-key-for-tests";

export async function runGardssalgGuestContactSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (c: boolean, label: string) => assertEq(!!c, true, label);

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const { initExperiencesSchema } = require("../database/init-experiences") as typeof import("../database/init-experiences");
  const sweepMod = require("./gardssalg-guest-contact-sweep") as typeof import("./gardssalg-guest-contact-sweep");

  // No-op when no experiences DB is available / table missing.
  const bare = new Database(":memory:");
  sweepMod.__setGardssalgGuestContactSweepTestDb(bare);
  const noTable = sweepMod.sweepExpiredGardssalgGuestContact(30, new Date());
  assertEq(noTable.sweptCount, 0, "missing table => no-op count 0 (no throw)");
  bare.close();

  const db = new Database(":memory:");
  initExperiencesSchema(db);
  sweepMod.__setGardssalgGuestContactSweepTestDb(db);
  try {
    const now = new Date("2026-12-01T12:00:00.000Z");
    const iso = (offsetDays: number) => new Date(now.getTime() + offsetDays * DAY).toISOString();
    const sqlTs = (offsetDays: number) => iso(offsetDays).slice(0, 19).replace("T", " ");
    db.prepare(`INSERT INTO experience_providers (id, navn, slug, vertical) VALUES ('p1','Gård','gard','experiences')`).run();
    let n = 0;
    const ins = (id: string, status: string, slot: string, resolved: string | null) => {
      n++;
      db.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token,
           status, resolved_at, commission_rate, billable, notes)
        VALUES (?, 'p1', ?, 3, 'Kari Nordmann', 'kari@example.no', '12345678', ?, ?, ?, ?, 0.1, 1, 'allergi')
      `).run(id, slot, `REF${n}`, `tok${n}`, status, resolved);
    };
    ins("res29", "confirmed_attended", iso(-60), iso(-29));
    ins("res31", "confirmed_attended", iso(-60), iso(-31));
    ins("res31sql", "no_show", iso(-60), sqlTs(-31));
    ins("res29sql", "cancelled", iso(-60), sqlTs(-29));
    ins("rsv-old", "reserved", iso(-31), null);
    ins("rsv-oldsql", "reserved", sqlTs(-31), null);
    ins("rsv-29", "reserved", iso(-29), null);
    ins("rsv-future", "reserved", iso(10), null);

    const statusCounts = () => JSON.stringify(db.prepare("SELECT status, COUNT(*) c FROM gardssalg_bookings GROUP BY status ORDER BY status").all());
    const structural = () => JSON.stringify(db.prepare(
      "SELECT booking_id, provider_id, slot_at, party_size, status, billable, commission_rate, booking_ref, confirm_token, resolved_at, created_at FROM gardssalg_bookings ORDER BY booking_id").all());
    const beforeCounts = statusCounts();
    const beforeStruct = structural();

    const dry = sweepMod.sweepExpiredGardssalgGuestContact(30, now, true);
    assertEq(dry.dryRun, true, "dryRun flag reported");
    assertEq([...dry.sweptIds].sort(), ["res31", "res31sql", "rsv-old", "rsv-oldsql"], "dry run reports eligible ids (ISO + SQLite formats)");
    assertEq(db.prepare("SELECT COUNT(*) c FROM gardssalg_bookings WHERE guest_email = 'kari@example.no'").get(), { c: 8 }, "dry run mutates nothing");

    const real = sweepMod.sweepExpiredGardssalgGuestContact(30, now);
    assertEq([...real.sweptIds].sort(), [...dry.sweptIds].sort(), "real run sweeps same ids as dry run");
    assertEq(real.sweptCount, 4, "swept count 4");
    const row = (id: string) => db.prepare("SELECT guest_name, guest_email, guest_phone, notes FROM gardssalg_bookings WHERE booking_id = ?").get(id) as any;
    assertEq(row("res31"), { guest_name: sweepMod.GARDSSALG_SWEPT_SENTINEL, guest_email: sweepMod.GARDSSALG_SWEPT_SENTINEL, guest_phone: null, notes: null }, "resolved day 31: contact cleared");
    assertEq(row("res29").guest_email, "kari@example.no", "resolved day 29: contact kept");
    assertEq(row("res29sql").guest_phone, "12345678", "resolved day 29 (SQLite format): kept");
    assertEq(row("rsv-old").guest_name, "", "reserved, slot passed 31d: cleared");
    assertEq(row("rsv-oldsql").guest_name, "", "reserved, slot passed 31d (SQLite format): cleared");
    assertEq(row("rsv-29").guest_name, "Kari Nordmann", "reserved, slot passed 29d: kept");
    assertEq(row("rsv-future").guest_name, "Kari Nordmann", "reserved, future slot: untouched");

    assertEq(structural(), beforeStruct, "AC2: status/slot_at/provider_id/party_size/billable etc. unchanged");
    assertEq(statusCounts(), beforeCounts, "AC2: COUNT(*) per status identical before/after");

    const again = sweepMod.sweepExpiredGardssalgGuestContact(30, now);
    assertEq(again.sweptCount, 0, "idempotent: re-run selects 0");
    // Later clock picks up the remaining rows.
    const later = sweepMod.sweepExpiredGardssalgGuestContact(30, new Date(now.getTime() + 3 * DAY));
    assertEq([...later.sweptIds].sort(), ["res29", "res29sql", "rsv-29"], "3 days later the day-29 rows become eligible");

    // AC3: rendering of swept row.
    const seo = require("../routes/experiences-seo") as typeof import("../routes/experiences-seo");
    assertEq(seo.escapeOrDeleted(""), "slettet", "swept name/email renders «slettet»");
    assertEq(seo.escapeOrDeleted("<b>"), "&lt;b&gt;", "non-empty value still escaped");
    const fs = require("fs") as typeof import("fs");
    const mineSrc = fs.readFileSync(require.resolve("../owner-features/gardssalg-mine-besok"), "utf8");
    assertTrue(/guest_name \? escapeHtml\(String\(booking\.guest_name\)\) : "slettet"/.test(mineSrc), "owner portal card renders «slettet» for cleared guest");

    // Personvern text.
    const seoSrc = fs.readFileSync(require.resolve("../routes/experiences-seo"), "utf8");
    assertTrue(seoSrc.includes("Navn, e-post, telefon og kommentar slettes automatisk 30 dager etter at forespørselen er avgjort (gjennomført besøk, uteblitt eller kansellert), eller 30 dager etter ønsket besøksdato hvis den aldri ble avgjort. Dato, produsent, antall personer og status beholdes uten opplysninger om deg. Ber du om det, sletter vi tidligere."), "personvern: new Norwegian sentence");
    assertTrue(!/Besøksforespørsler<\/td><td>Ingen automatisk sletting i dag/.test(seoSrc), "personvern: old visit-request text gone");
    assertTrue(seoSrc.includes("<strong>Sist oppdatert:</strong> 8. november 2026") && seoSrc.includes("<strong>Last updated:</strong> 8 November 2026"), "personvern: updated dates");

    // Admin dry-run route.
    const prevKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = KEY;
    const expressMod = require("express") as typeof import("express");
    const routeMod = require("../routes/admin-gardssalg-guest-contact-sweep") as typeof import("../routes/admin-gardssalg-guest-contact-sweep");
    const app = expressMod();
    app.use("/admin/gardssalg/guest-contact-sweep", routeMod.default);
    const httpMod = require("http") as typeof import("http");
    const server = httpMod.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const get = (headers: Record<string, string>) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const rq = httpMod.request({ method: "GET", host: "127.0.0.1", port, path: "/admin/gardssalg/guest-contact-sweep/dry-run", headers }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c) => chunks.push(c as Buffer));
        resp.on("end", () => { let b: any = null; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ } resolve({ status: resp.statusCode || 0, body: b }); });
      });
      rq.on("error", reject);
      rq.end();
    });
    try {
      assertEq((await get({})).status, 403, "admin dry-run: no key => 403");
      assertEq((await get({ "X-Admin-Key": "wrong" })).status, 403, "admin dry-run: wrong key => 403");
      const ok = await get({ "X-Admin-Key": KEY });
      assertEq(ok.status, 200, "admin dry-run: key => 200");
      assertEq(Object.keys(ok.body).sort(), ["cutoffDays", "eligible", "live"], "admin dry-run: only counts/flags, no ids");
      assertEq(ok.body.cutoffDays, 30, "admin dry-run: cutoffDays 30");
    } finally {
      server.close();
      if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
    }
  } finally {
    sweepMod.__setGardssalgGuestContactSweepTestDb(null);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runGardssalgGuestContactSweepTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-guest-contact-sweep: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0); // imported route modules keep timers alive
  });
}
