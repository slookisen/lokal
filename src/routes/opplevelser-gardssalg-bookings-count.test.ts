/**
 * opplevelser-gardssalg-bookings-count.test.ts — tests for
 * GET /admin/gardssalg/bookings-count (src/routes/opplevelser.ts), added for
 * dev-request 2026-07-12-gardssalg-go-live-gate-dark-launch-og-onboarding,
 * acceptance criterion 5 ("Eksisterende bookings-rader talt og rapportert").
 *
 * Mirrors opplevelser-gardssalg-contact-coverage.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) happy path with mixed-status rows — correct total, correct by_status
 *       breakdown, rows list ordered oldest-first, rows_capped false under
 *       the cap, no guest PII (name/email/phone) anywhere in the response
 *   (c) zero-row edge case
 *   (d) rows_capped true + rows_returned == cap when row count exceeds the cap
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg/bookings-count",
      originalUrl: "/admin/gardssalg/bookings-count",
      path: "/admin/gardssalg/bookings-count",
      query: {},
      headers: opts.headers || {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgBookingsCountTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-bookings-count-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      // Providers referenced by gardssalg_bookings' FK — minimal fixtures.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "prov-a", navn: "Gård A" });
      insertProvider.run({ id: "prov-b", navn: "Gård B" });

      const insertBooking = expDb.prepare(
        `INSERT INTO gardssalg_bookings
           (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone,
            booking_ref, confirm_token, status, created_at)
         VALUES
           (@booking_id, @provider_id, @slot_at, @party_size, @guest_name, @guest_email, @guest_phone,
            @booking_ref, @confirm_token, @status, @created_at)`,
      );

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg/bookings-count without X-Admin-Key -> 403");
      assertTrue(noKey.body?.total === undefined, "a2: no-key response carries no report payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET /admin/gardssalg/bookings-count with wrong X-Admin-Key -> 403");

      // ── (c) zero-row edge case (checked first, before any fixture rows) ──
      const empty = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(empty.status, 200, "c1: zero-row case still returns 200");
      assertEq(empty.body.total, 0, "c2: total is 0");
      assertEq(empty.body.by_status, { reserved: 0, confirmed_attended: 0, no_show: 0, cancelled: 0 }, "c3: by_status all zero");
      assertEq(empty.body.rows, [], "c4: rows is an empty array");
      assertEq(empty.body.rows_capped, false, "c5: rows_capped is false");

      // ── (b) happy path with mixed-status fixtures ───────────────────────
      insertBooking.run({
        booking_id: "b-1", provider_id: "prov-a", slot_at: "2026-07-05T10:00:00Z",
        party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no",
        guest_phone: "40000001", booking_ref: "OPP-20260705-0001", confirm_token: "tok-1",
        status: "reserved", created_at: "2026-07-05T09:55:00Z",
      });
      insertBooking.run({
        booking_id: "b-2", provider_id: "prov-b", slot_at: "2026-07-06T11:00:00Z",
        party_size: 1, guest_name: "Ola Nordmann", guest_email: "ola@example.no",
        guest_phone: null, booking_ref: "OPP-20260706-0002", confirm_token: "tok-2",
        status: "reserved", created_at: "2026-07-06T10:30:00Z",
      });
      insertBooking.run({
        booking_id: "b-3", provider_id: "prov-a", slot_at: "2026-06-20T09:00:00Z",
        party_size: 4, guest_name: "Test Testesen", guest_email: "test@example.no",
        guest_phone: null, booking_ref: "OPP-20260620-0003", confirm_token: "tok-3",
        status: "confirmed_attended", created_at: "2026-06-20T08:45:00Z",
      });
      insertBooking.run({
        booking_id: "b-4", provider_id: "prov-b", slot_at: "2026-06-21T09:00:00Z",
        party_size: 1, guest_name: "Cancelled Guest", guest_email: "c@example.no",
        guest_phone: null, booking_ref: "OPP-20260621-0004", confirm_token: "tok-4",
        status: "cancelled", created_at: "2026-06-21T08:00:00Z",
      });

      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "b1: GET /admin/gardssalg/bookings-count (valid key) -> 200");
      assertEq(ok.body.total, 4, "b2: total counts all 4 rows regardless of status");
      assertEq(
        ok.body.by_status,
        { reserved: 2, confirmed_attended: 1, no_show: 0, cancelled: 1 },
        "b3: by_status breaks down correctly per status",
      );
      assertEq(ok.body.rows_returned, 4, "b4: rows_returned matches total (under cap)");
      assertEq(ok.body.rows_capped, false, "b5: rows_capped is false (4 < 200)");
      assertTrue(Array.isArray(ok.body.rows), "b6: rows is an array");
      const orderedIds = ok.body.rows.map((r: any) => r.booking_id);
      assertEq(orderedIds, ["b-3", "b-4", "b-1", "b-2"], "b7: rows ordered oldest-created_at-first");
      assertEq(
        Object.keys(ok.body.rows[0]).sort(),
        ["booking_id", "created_at", "party_size", "provider_id", "status"].sort(),
        "b8: each row exposes ONLY non-PII fields — no guest_name/guest_email/guest_phone/booking_ref/confirm_token",
      );

      const serialized = JSON.stringify(ok.body);
      for (const pii of [
        "Kari Nordmann", "kari@example.no", "40000001",
        "Ola Nordmann", "ola@example.no",
        "Test Testesen", "test@example.no",
        "Cancelled Guest", "c@example.no",
      ]) {
        assertTrue(!serialized.includes(pii), `b9: response never includes raw guest PII value "${pii}"`);
      }

      // ── (d) cap enforcement ──────────────────────────────────────────────
      expDb.prepare("DELETE FROM gardssalg_bookings").run();
      const insertMany = expDb.transaction(() => {
        for (let i = 0; i < 205; i++) {
          insertBooking.run({
            booking_id: `bulk-${i}`, provider_id: "prov-a", slot_at: "2026-07-10T10:00:00Z",
            party_size: 1, guest_name: `Guest ${i}`, guest_email: `guest${i}@example.no`,
            guest_phone: null, booking_ref: `OPP-BULK-${i}`, confirm_token: `tok-bulk-${i}`,
            status: "reserved", created_at: `2026-07-10T00:${String(i % 60).padStart(2, "0")}:00Z`,
          });
        }
      });
      insertMany();
      const capped = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(capped.body.total, 205, "d1: total reflects the true row count, uncapped");
      assertEq(capped.body.rows_returned, 200, "d2: rows_returned is capped at 200");
      assertEq(capped.body.rows_capped, true, "d3: rows_capped is true when total exceeds the cap");
      assertEq(capped.body.rows.length, 200, "d4: rows array itself is capped at 200");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-bookings-count: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-bookings-count.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgBookingsCountTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
