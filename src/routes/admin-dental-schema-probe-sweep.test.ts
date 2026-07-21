/**
 * admin-dental-schema-probe-sweep.test.ts — unit tests for
 * POST /admin/dental/schema-probe-sweep
 * (src/routes/admin-dental-schema-probe-sweep.ts), dev-request
 * 2026-07-21-dental-schema-probe-writepath-fix (follow-up to PR #323's
 * write-path guard).
 *
 * Setup mirrors admin-dental-hjemmeside-cleanup.test.ts: fresh in-memory
 * dental DB via DENTAL_DB_PATH=":memory:" + db-factory,
 * __resetDbFactoryForTesting() (so initDentalSchema runs the real
 * production dental schema), fresh require of the route module per run,
 * exercised via router.handle() directly (X-Admin-Key passed via headers).
 *
 * Covers (per the build spec):
 *   1. dry-run detects `specialists` contamination.
 *   2. dry-run detects `online_booking_url` contamination.
 *   3. dry-run detects `social_media.facebook` contamination while a
 *      legitimate `social_media.instagram` value survives untouched.
 *   4. dry-run detects `om_oss` contamination.
 *   5. dry-run detects `field_provenance` contamination alongside a
 *      legitimate provenance entry for another field.
 *   6. apply=true on the social_media row: facebook cleared, instagram kept.
 *   7. apply=true on the field_provenance row: probe key cleared, legitimate
 *      entry kept.
 *   8. apply=true never touches a fully-clean row.
 *   9. apply=true sets verification_status = 'needs_review' on every
 *      repaired row.
 *   10. a completely clean catalog -> matched_count/repaired_count 0, no
 *       errors.
 *   11. requireAdmin: missing/wrong X-Admin-Key -> 403.
 *   12. idempotency: a second apply=true run finds 0 remaining matches.
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
  opts: { method?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: "/",
      originalUrl: "/",
      path: "/",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
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

export function runAdminDentalSchemaProbeSweepTests(
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "dental-schema-probe-sweep-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const routePath = require.resolve("./admin-dental-schema-probe-sweep");
    const cachePaths = [dbFactoryPath, routePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const routeMod = require("./admin-dental-schema-probe-sweep") as
        typeof import("./admin-dental-schema-probe-sweep");
      const router = routeMod.default as any;

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", headers, body });
      }

      // ── (11) admin gate — checked FIRST, before any row exists, so a
      // rejected request can never have touched the DB. ──────────────────
      let r = await post({}, false);
      assertEq(r.status, 403, "11a: missing X-Admin-Key -> 403");
      r = await post({}, "wrong-key");
      assertEq(r.status, 403, "11b: wrong X-Admin-Key -> 403");

      // ── (10) completely clean catalog: one clean row, zero contamination ──
      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents
           (id, navn, specialists, online_booking_url, social_media, om_oss, field_provenance, verification_status, created_at)
         VALUES (@id, @navn, @specialists, @online_booking_url, @social_media, @om_oss, @field_provenance, @verification_status, @created_at)`,
      );

      insertAgent.run({
        id: "clean-row",
        navn: "Ekte Tannlege AS",
        specialists: JSON.stringify([{ name: "Kari Nordmann", specialty: "kjeveortopedi" }]),
        online_booking_url: "https://ekte-tannlege-oslo.no/book",
        social_media: JSON.stringify({ instagram: "https://instagram.com/ekte_tannlege" }),
        om_oss: "En ekte klinikk med lang erfaring.",
        field_provenance: JSON.stringify({ navn: { source: "brreg", value: "Ekte Tannlege AS" } }),
        verification_status: "verified",
        created_at: "2026-01-01T00:00:00.000Z",
      });

      const cleanDry = await post({});
      assertEq(cleanDry.status, 200, "10a: dry-run on clean-only catalog -> 200");
      assertEq(cleanDry.body.mode, "dry_run", "10b: dry-run mode echoed");
      assertEq(cleanDry.body.matched_count, 0, "10c: clean catalog -> matched_count 0");
      assertEq(cleanDry.body.matches, [], "10d: clean catalog -> empty matches array");

      const cleanApply = await post({ apply: true });
      assertEq(cleanApply.body.mode, "apply", "10e: apply mode echoed");
      assertEq(cleanApply.body.repaired_count, 0, "10f: clean catalog apply -> repaired_count 0");
      assertEq(cleanApply.body.repairs, [], "10g: clean catalog apply -> empty repairs array");

      // ── Now insert the contaminated fixtures for tests 1-9, 12 ──────────
      insertAgent.run({
        id: "contam-specialists",
        navn: "Specialists Probe Tannlege AS",
        specialists: JSON.stringify([{ name: "Test" }]),
        online_booking_url: null,
        social_media: null,
        om_oss: null,
        field_provenance: null,
        verification_status: "pending_verify",
        created_at: "2026-01-02T00:00:00.000Z",
      });
      insertAgent.run({
        id: "contam-booking",
        navn: "Booking Probe Tannlege AS",
        specialists: null,
        online_booking_url: "https://example.com/booking",
        social_media: null,
        om_oss: null,
        field_provenance: null,
        verification_status: "pending_verify",
        created_at: "2026-01-03T00:00:00.000Z",
      });
      insertAgent.run({
        id: "contam-social-mixed",
        navn: "Social Probe Tannlege AS",
        specialists: null,
        online_booking_url: null,
        social_media: JSON.stringify({
          facebook: "https://facebook.com/x",
          instagram: "https://instagram.com/social_probe_tannlege",
        }),
        om_oss: null,
        field_provenance: null,
        verification_status: "pending_verify",
        created_at: "2026-01-04T00:00:00.000Z",
      });
      insertAgent.run({
        id: "contam-omoss",
        navn: "OmOss Probe Tannlege AS",
        specialists: null,
        online_booking_url: null,
        social_media: null,
        om_oss: "test probe",
        field_provenance: null,
        verification_status: "pending_verify",
        created_at: "2026-01-05T00:00:00.000Z",
      });
      insertAgent.run({
        id: "contam-provenance-mixed",
        navn: "Provenance Probe Tannlege AS",
        specialists: null,
        online_booking_url: null,
        social_media: null,
        om_oss: null,
        field_provenance: JSON.stringify({
          navn: { source: "brreg", value: "Provenance Probe Tannlege AS" },
          _smoke_test_provenance_probe: { source: "smoke-test", ts: "2026-07-21T00:00:00.000Z" },
        }),
        verification_status: "pending_verify",
        created_at: "2026-01-06T00:00:00.000Z",
      });

      // ── (1)-(5) dry-run detects each contamination independently ────────
      const dry = await post({});
      assertEq(dry.status, 200, "1a: dry-run -> 200");
      assertEq(dry.body.mode, "dry_run", "1b: dry-run mode echoed");
      assertEq(dry.body.scanned, 6, "1c: scanned counts all 6 rows (1 clean + 5 contaminated)");
      assertEq(dry.body.matched_count, 5, "1d: exactly 5 contaminated rows matched");
      const byId = Object.fromEntries((dry.body.matches as any[]).map((m) => [m.id, m]));
      assertTrue(!("clean-row" in byId), "1e: clean-row is never in matches");

      assertEq(byId["contam-specialists"].contaminated_fields, ["specialists"], "1f: specialists contamination detected");
      assertEq(byId["contam-booking"].contaminated_fields, ["online_booking_url"], "2a: online_booking_url contamination detected");
      assertEq(byId["contam-social-mixed"].contaminated_fields, ["social_media"], "3a: social_media contamination detected (facebook fingerprint) despite legitimate instagram present");
      assertEq(byId["contam-omoss"].contaminated_fields, ["om_oss"], "4a: om_oss contamination detected");
      assertEq(byId["contam-provenance-mixed"].contaminated_fields, ["field_provenance"], "5a: field_provenance contamination detected despite legitimate navn provenance present");

      // Dry-run makes ZERO writes — spot-check the social_media + provenance
      // rows (the ones with a mix of legitimate + contaminated data) are
      // byte-for-byte unchanged.
      const socialBeforeApply = dentalDb
        .prepare("SELECT social_media FROM dental_agents WHERE id = ?")
        .get("contam-social-mixed") as any;
      assertEq(
        JSON.parse(socialBeforeApply.social_media),
        { facebook: "https://facebook.com/x", instagram: "https://instagram.com/social_probe_tannlege" },
        "3b: dry-run never mutates social_media",
      );
      const provBeforeApply = dentalDb
        .prepare("SELECT field_provenance FROM dental_agents WHERE id = ?")
        .get("contam-provenance-mixed") as any;
      assertTrue(
        JSON.parse(provBeforeApply.field_provenance)._smoke_test_provenance_probe !== undefined,
        "5b: dry-run never mutates field_provenance",
      );

      // ── (6)-(9) apply=true repairs exactly the contaminated field(s) ────
      const applied = await post({ apply: true });
      assertEq(applied.status, 200, "6a: apply -> 200");
      assertEq(applied.body.mode, "apply", "6b: apply mode echoed");
      assertEq(applied.body.repaired_count, 5, "6c: exactly 5 rows repaired");
      const repairsById = Object.fromEntries((applied.body.repairs as any[]).map((r) => [r.id, r]));
      assertTrue(!("clean-row" in repairsById), "8a: clean-row is never in repairs");

      // (6) social_media: facebook cleared, instagram survives.
      assertEq(repairsById["contam-social-mixed"].cleared_fields, ["social_media"], "6d: cleared_fields reports social_media");
      const socialAfter = dentalDb
        .prepare("SELECT social_media FROM dental_agents WHERE id = ?")
        .get("contam-social-mixed") as any;
      const socialAfterParsed = JSON.parse(socialAfter.social_media);
      assertEq(socialAfterParsed.instagram, "https://instagram.com/social_probe_tannlege", "6e: legitimate instagram value survives the repair");
      assertTrue(!("facebook" in socialAfterParsed), "6f: contaminated facebook key is gone");

      // (7) field_provenance: probe key cleared, legitimate navn entry survives.
      assertEq(repairsById["contam-provenance-mixed"].cleared_fields, ["field_provenance"], "7a: cleared_fields reports field_provenance");
      const provAfter = dentalDb
        .prepare("SELECT field_provenance FROM dental_agents WHERE id = ?")
        .get("contam-provenance-mixed") as any;
      const provAfterParsed = JSON.parse(provAfter.field_provenance);
      assertTrue(!!provAfterParsed.navn, "7b: legitimate navn provenance entry survives the repair");
      assertEq(provAfterParsed.navn.value, "Provenance Probe Tannlege AS", "7c: legitimate navn provenance value untouched");
      assertTrue(!("_smoke_test_provenance_probe" in provAfterParsed), "7d: _smoke_test_provenance_probe key is gone");

      // specialists / online_booking_url / om_oss cleared to NULL outright.
      assertEq(repairsById["contam-specialists"].cleared_fields, ["specialists"], "1g: cleared_fields reports specialists");
      const specialistsAfter = dentalDb
        .prepare("SELECT specialists FROM dental_agents WHERE id = ?")
        .get("contam-specialists") as any;
      assertEq(specialistsAfter.specialists, null, "1h: specialists column nulled");

      assertEq(repairsById["contam-booking"].cleared_fields, ["online_booking_url"], "2b: cleared_fields reports online_booking_url");
      const bookingAfter = dentalDb
        .prepare("SELECT online_booking_url FROM dental_agents WHERE id = ?")
        .get("contam-booking") as any;
      assertEq(bookingAfter.online_booking_url, null, "2c: online_booking_url column nulled");

      assertEq(repairsById["contam-omoss"].cleared_fields, ["om_oss"], "4b: cleared_fields reports om_oss");
      const omOssAfter = dentalDb
        .prepare("SELECT om_oss FROM dental_agents WHERE id = ?")
        .get("contam-omoss") as any;
      assertEq(omOssAfter.om_oss, null, "4c: om_oss column nulled");

      // (8) clean-row completely untouched by apply.
      const cleanAfter = dentalDb
        .prepare(
          "SELECT specialists, online_booking_url, social_media, om_oss, field_provenance, verification_status FROM dental_agents WHERE id = ?",
        )
        .get("clean-row") as any;
      assertEq(JSON.parse(cleanAfter.specialists), [{ name: "Kari Nordmann", specialty: "kjeveortopedi" }], "8b: clean-row specialists unchanged");
      assertEq(cleanAfter.online_booking_url, "https://ekte-tannlege-oslo.no/book", "8c: clean-row online_booking_url unchanged");
      assertEq(JSON.parse(cleanAfter.social_media), { instagram: "https://instagram.com/ekte_tannlege" }, "8d: clean-row social_media unchanged");
      assertEq(cleanAfter.om_oss, "En ekte klinikk med lang erfaring.", "8e: clean-row om_oss unchanged");
      assertEq(JSON.parse(cleanAfter.field_provenance), { navn: { source: "brreg", value: "Ekte Tannlege AS" } }, "8f: clean-row field_provenance unchanged");
      assertEq(cleanAfter.verification_status, "verified", "8g: clean-row verification_status unchanged (never touched)");

      // (9) verification_status = needs_review on every repaired row.
      for (const id of [
        "contam-specialists",
        "contam-booking",
        "contam-social-mixed",
        "contam-omoss",
        "contam-provenance-mixed",
      ]) {
        const row = dentalDb.prepare("SELECT verification_status FROM dental_agents WHERE id = ?").get(id) as any;
        assertEq(row.verification_status, "needs_review", `9: ${id} verification_status set to needs_review`);
      }

      // ── (12) idempotency: a second dry-run / apply finds nothing left ────
      const secondDry = await post({});
      assertEq(secondDry.body.matched_count, 0, "12a: second dry-run after apply finds 0 remaining matches");
      assertEq(secondDry.body.matches, [], "12b: second dry-run matches array is empty");

      const secondApply = await post({ apply: true });
      assertEq(secondApply.body.repaired_count, 0, "12c: second apply run repairs 0 rows (already clean)");
      assertEq(secondApply.body.repairs, [], "12d: second apply repairs array is empty");

      // ── (13) reserved synthetic probe id is excluded from both dry-run
      // and apply — it's EXPECTED to carry the fingerprint on purpose (the
      // hourly enrichment worker's own schema probe writes it there every
      // cycle), so the sweep must never flag or "fix" it. ─────────────────
      insertAgent.run({
        id: "persistence-probe-pr100b",
        navn: "PR-100b Persistence Probe",
        specialists: JSON.stringify([{ name: "Test", title: "Tannlege" }]),
        online_booking_url: "https://example.com/booking",
        social_media: JSON.stringify({ facebook: "https://facebook.com/x" }),
        om_oss: "test probe",
        field_provenance: JSON.stringify({ _smoke_test_provenance_probe: { probed_at: "2026-07-21" } }),
        verification_status: "pending_verify",
        created_at: "2026-01-01T00:00:00.000Z",
      });

      const synthDry = await post({});
      assertEq(synthDry.body.matched_count, 0, "13a: synthetic probe id excluded from dry-run matches");
      assertTrue(
        !synthDry.body.matches.some((m: any) => m.id === "persistence-probe-pr100b"),
        "13b: synthetic probe id not present in dry-run matches list",
      );

      const synthApply = await post({ apply: true });
      assertEq(synthApply.body.repaired_count, 0, "13c: synthetic probe id excluded from apply repairs");
      const synthRow = dentalDb
        .prepare("SELECT specialists, online_booking_url, social_media, om_oss, field_provenance, verification_status FROM dental_agents WHERE id = ?")
        .get("persistence-probe-pr100b") as any;
      assertEq(
        synthRow.online_booking_url,
        "https://example.com/booking",
        "13d: synthetic probe row's fingerprint fields left completely untouched by apply",
      );
      assertEq(
        synthRow.verification_status,
        "pending_verify",
        "13e: synthetic probe row's verification_status untouched by apply",
      );
    } catch (err: any) {
      failed++;
      failures.push("admin-dental-schema-probe-sweep: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

// Standalone runner: `npx tsx src/routes/admin-dental-schema-probe-sweep.test.ts`
if (require.main === module) {
  runAdminDentalSchemaProbeSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
