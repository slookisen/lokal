/**
 * admin-gardssalg-guest-contact-sweep.test.ts — O1-7 AK2 (dev-request
 * 2026-11-12-opplevagent-o1-trygg-aa-aapne): route test for the existing
 * GET /admin/gardssalg/guest-contact-sweep/dry-run (built for dev-request
 * 2026-10-23-opplevagent-besoksforesporsler-automatisk-sletting).
 *
 * Covers: 503 without a configured admin key; 403 without / with a wrong
 * key; 200 with the key and a numeric `eligible` equal to the rows the 30-day
 * sweep would clear now; Cache-Control: no-store; the body carries no ids,
 * names, e-mails, phone numbers or notes; the call changes no row.
 *
 * Own in-memory DB through the sweep's test seam; ADMIN_KEY /
 * ANALYTICS_ADMIN_KEY restored in finally.
 *
 * Standalone: npx tsx src/routes/admin-gardssalg-guest-contact-sweep.test.ts
 * Gate: tests/test.ts imports runAdminGardssalgGuestContactSweepRouteTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 24 * 3600_000;
const KEY = "gs-dry-run-route-admin-key-for-tests";

/** Plain node:http request (global fetch may be stubbed by other test blocks). */
function httpReq(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const rq = http.request(url, { method: opts.method || "GET", headers: opts.headers }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c) => chunks.push(c as Buffer));
      resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    rq.on("error", reject);
    if (opts.body) rq.write(opts.body);
    rq.end();
  });
}

export async function runAdminGardssalgGuestContactSweepRouteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (c: boolean, label: string): void => assertEq(!!c, true, label);

  const { initExperiencesSchema } = require("../database/init-experiences") as typeof import("../database/init-experiences");
  const sweepMod = require("../services/gardssalg-guest-contact-sweep") as typeof import("../services/gardssalg-guest-contact-sweep");
  const routeMod = require("./admin-gardssalg-guest-contact-sweep") as typeof import("./admin-gardssalg-guest-contact-sweep");

  const prevKey = process.env.ADMIN_KEY;
  const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
  const db = new Database(":memory:");
  initExperiencesSchema(db);
  sweepMod.__setGardssalgGuestContactSweepTestDb(db);
  let server: http.Server | null = null;

  try {
    const now = Date.now();
    const iso = (offsetDays: number) => new Date(now + offsetDays * DAY).toISOString();
    db.prepare(`INSERT INTO experience_providers (id, navn, slug, vertical) VALUES ('dr-p1','Tørrkjøring Gård','dr-gard','experiences')`).run();
    let n = 0;
    const ins = (id: string, status: string, slot: string, resolved: string | null) => {
      n++;
      db.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token,
           status, resolved_at, commission_rate, billable, notes)
        VALUES (?, 'dr-p1', ?, 2, 'Ola Tørr', 'ola-torr@example.no', '98765432', ?, ?, ?, ?, 0.1, 0, 'nøtteallergi')
      `).run(id, slot, `DRREF${n}`, `drtok${n}`, status, resolved);
    };
    ins("dr-res40", "confirmed_attended", iso(-60), iso(-40)); // eligible
    ins("dr-ns35", "no_show", iso(-60), iso(-35));              // eligible
    ins("dr-rsv33", "reserved", iso(-33), null);                // eligible
    ins("dr-res10", "confirmed_attended", iso(-20), iso(-10));  // kept
    ins("dr-rsv-future", "reserved", iso(7), null);             // kept
    const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM gardssalg_bookings ORDER BY booking_id").all());
    const before = snapshot();
    const expected = sweepMod.sweepExpiredGardssalgGuestContact(sweepMod.GARDSSALG_SWEEP_CUTOFF_DAYS, new Date(), true).sweptCount;
    assertEq(expected, 3, "fixture: 3 rows eligible for the 30-day sweep");

    const app = express();
    app.use("/admin/gardssalg/guest-contact-sweep", routeMod.default);
    server = http.createServer(app);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/gardssalg/guest-contact-sweep/dry-run`;
    const get = async (headers: Record<string, string>) => {
      const res = await httpReq(url, { headers });
      const text = res.text;
      return { status: res.status, text, cacheControl: res.headers["cache-control"] ?? null, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    };

    delete process.env.ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    assertEq((await get({ "X-Admin-Key": KEY })).status, 503, "a1: no admin key configured -> 503");

    process.env.ADMIN_KEY = KEY;
    assertEq((await get({})).status, 403, "a2: no key -> 403");
    assertEq((await get({ "X-Admin-Key": "wrong" })).status, 403, "a3: wrong key -> 403");

    const ok = await get({ "X-Admin-Key": KEY });
    assertEq(ok.status, 200, "a4 (AK2): key -> 200");
    assertEq(typeof ok.body?.eligible, "number", "a5 (AK2): eligible is a number");
    assertEq(ok.body?.eligible, expected, "a6 (AK2): eligible = rows the sweep would clear now (3)");
    assertEq(ok.body?.cutoffDays, 30, "a7: cutoffDays 30");
    assertEq(Object.keys(ok.body || {}).sort(), ["cutoffDays", "eligible", "live"], "a8: only counts/flags in the body");
    assertEq(ok.cacheControl, "no-store", "a9: Cache-Control: no-store");
    for (const needle of ["dr-res40", "dr-ns35", "dr-rsv33", "DRREF", "drtok", "Ola", "ola-torr@example.no", "98765432", "nøtteallergi"]) {
      assertTrue(!ok.text.includes(needle), `a10: body has no ${needle}`);
    }
    assertEq(snapshot(), before, "a11: dry-run changes no row");
    await get({ "X-Admin-Key": KEY });
    assertEq(snapshot(), before, "a12: repeated dry-run still changes no row");
  } catch (err) {
    failed++;
    failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
    if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
    sweepMod.__setGardssalgGuestContactSweepTestDb(null);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminGardssalgGuestContactSweepRouteTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
