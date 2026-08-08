/**
 * opplevelser-gardssalg-booking-activation.test.ts — tests for
 * POST/GET /admin/gardssalg-booking-activation (src/routes/opplevelser.ts),
 * added for dev-request 2026-08-08-booking-aktivering-per-produsent: the
 * admin lever + per-producer emergency brake over the EXISTING booking_live
 * gate (isBookingPaused()/bookingDispatchEnabled(), services/booking-
 * store.ts) — reused unchanged, never re-derived.
 *
 * Covers (mapping to the dev-request's acceptance criteria):
 *   AC1 — apply absent/false = dry-run: reports planned changes, zero writes.
 *   AC2 — apply=true writes ONLY booking_live (never catalog_hidden/epost/
 *         other columns), and inserts exactly one gardssalg_content_audit
 *         row per changed provider, preserving the note.
 *   AC3 — enabled:true + no epost on file -> rejected reason "no_email";
 *         enabled:false carries NO such guard (always works).
 *   AC4 — THE EMERGENCY-BRAKE TEST: enabled:false for provider A makes ONLY
 *         A non-bookable on every surface (POST /api/opplevelser/book, the
 *         SSR no-JS form, MCP book_gardssalg) while a DIFFERENT
 *         booking_live=1 provider B in the same corpus stays bookable.
 *   AC5 — regression: BOOKING_DISPATCH_ENABLED off still blocks a
 *         booking_live=1 provider (the double gate is untouched).
 *   AC6 — GET overview: count/list of booking_live=1 providers, reusing
 *         computeGardssalgReadinessRows's own booking_status field.
 *   AC7 — regression: the owner-portal checkbox
 *         (updateClaimedProviderProfile, services/gardssalg-claim.ts) still
 *         writes booking_live exactly as before, leaving its own
 *         changed_by='owner' audit row alongside the admin lever's
 *         changed_by='admin' rows for the same provider (last-write-wins,
 *         both leave a trail).
 *   AC8 — structural: this migration/route addition writes zero rows by
 *         itself (proven by the fixtures below never being touched until a
 *         test explicitly calls apply=true).
 *   + validation: missing/empty/non-array provider_ids, non-boolean
 *     enabled, >200 ids, unknown X-Admin-Key, a not-found id mixed into a
 *     real batch (reported per-row, doesn't fail the batch), idempotency
 *     (already_current -> zero writes on a repeat call).
 *
 * Same synthetic router.handle() shortcut as
 * opplevelser-gardssalg-outreach-preflight.test.ts for the plain-JSON admin
 * routes; the SSR/MCP legs of the AC4 cross-surface test spin a real
 * ephemeral http.Server (same pattern as
 * opplevelser-gardssalg-mcp-booking.test.ts) since those routers need real
 * request bodies/redirects an MCP SDK transport or urlencoded() body-parser
 * middleware can act on.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-booking-activation.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgBookingActivationTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-booking-activation";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body,
      get(name: string) {
        return (opts.headers || {})[name.toLowerCase()];
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

// Parses a JSON-RPC response body that may be raw JSON or an SSE stream —
// same helper as opplevelser-gardssalg-mcp-booking.test.ts.
function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

export function runOpplevelserGardssalgBookingActivationTests(
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    const testKey = process.env.ADMIN_KEY || "gardssalg-booking-activation-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const emailPath = require.resolve("../services/email-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const seoPath = require.resolve("./experiences-seo");
    const mcpPath = require.resolve("./experiences-mcp");
    const cachePaths = [
      dbFactoryPath, expStorePath, bookingStorePath, claimSvcPath, emailPath,
      opplevelserPath, seoPath, mcpPath,
    ];
    for (const p of cachePaths) delete require.cache[p];

    let servers: http.Server[] = [];
    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const emailMod = require("../services/email-service") as typeof import("../services/email-service");

      // ── Fake transport at the real send boundary — createBooking() fires
      // confirmation/producer-notification emails fire-and-forget on a
      // successful booking; this stubs the transporter so `npm test` never
      // makes an outbound network call (same recipe as
      // opplevelser-booking-send-guard.test.ts).
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      emailSvc.isConfigured = true;
      emailSvc.transporter = { sendMail: async () => ({ messageId: "stub" }) };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, content_source, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @content_source, @booking_live, @catalog_hidden,
            @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // prov-a / prov-b: both booking_live=1, real epost — the AC4 pair.
      insertProvider.run({
        id: "prov-a", navn: "Gård A AS", org_nr: "111111111", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@garda.no", telefon: null, hjemmeside: "https://garda.no",
        content_source: "provider_site", booking_live: 1, catalog_hidden: 0, slug: "gard-a",
      });
      insertProvider.run({
        id: "prov-b", navn: "Gård B AS", org_nr: "222222222", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@gardb.no", telefon: null, hjemmeside: "https://gardb.no",
        content_source: "provider_site", booking_live: 1, catalog_hidden: 0, slug: "gard-b",
      });
      // prov-off-noemail: booking_live=1 but NO epost — proves enabled:false
      // never gets guarded by the no_email check.
      insertProvider.run({
        id: "prov-off-noemail", navn: "Gård Uten Epost AS", org_nr: "333333333", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: "12345678", hjemmeside: "https://utenepost.no",
        content_source: "provider_site", booking_live: 1, catalog_hidden: 0, slug: "uten-epost",
      });
      // prov-on-noemail: booking_live=0, NO epost — enabled:true must be
      // rejected reason:"no_email".
      insertProvider.run({
        id: "prov-on-noemail", navn: "Gård Vil Åpne Uten Epost AS", org_nr: "444444444", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: "87654321", hjemmeside: "https://vilapne.no",
        content_source: "provider_site", booking_live: 0, catalog_hidden: 0, slug: "vil-apne-uten-epost",
      });
      // prov-turn-on: booking_live=0, real epost — happy-path turn-on.
      insertProvider.run({
        id: "prov-turn-on", navn: "Gård Skal Åpnes AS", org_nr: "555555555", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@skalapnes.no", telefon: null, hjemmeside: "https://skalapnes.no",
        content_source: "provider_site", booking_live: 0, catalog_hidden: 0, slug: "skal-apnes",
      });
      // prov-owner: booking_live=0, content_source will flip to 'claim' via
      // the owner-portal write below — used for the AC7 regression.
      insertProvider.run({
        id: "prov-owner", navn: "Gård Eier AS", org_nr: "666666666", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@gardeier.no", telefon: null, hjemmeside: "https://gardeier.no",
        content_source: "provider_site", booking_live: 0, catalog_hidden: 0, slug: "gard-eier",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const authHeaders = { "x-admin-key": testKey };

      function countAudit(providerId: string, fieldName = "booking_live"): number {
        return (
          expDb
            .prepare(
              `SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = ?`,
            )
            .get(providerId, fieldName) as { n: number }
        ).n;
      }
      function bookingLiveOf(providerId: string): number | null {
        return (
          expDb.prepare(`SELECT booking_live FROM experience_providers WHERE id = ?`).get(providerId) as {
            booking_live: number | null;
          }
        ).booking_live;
      }

      // ── auth gate ──────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: { provider_ids: ["prov-a"], enabled: false } });
      assertEq(noKey.status, 403, "auth1: POST without X-Admin-Key -> 403");
      const badKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "wrong" },
        body: { provider_ids: ["prov-a"], enabled: false },
      });
      assertEq(badKey.status, 403, "auth2: POST with wrong X-Admin-Key -> 403");

      // ── validation ────────────────────────────────────────────────────
      const missingIds = await callRoute(opplevelserRouter, { headers: authHeaders, body: { enabled: false } });
      assertEq(missingIds.status, 400, "val1: missing provider_ids -> 400");
      const emptyIds = await callRoute(opplevelserRouter, {
        headers: authHeaders, body: { provider_ids: [], enabled: false },
      });
      assertEq(emptyIds.status, 400, "val2: empty provider_ids array -> 400");
      const nonArrayIds = await callRoute(opplevelserRouter, {
        headers: authHeaders, body: { provider_ids: "prov-a", enabled: false },
      });
      assertEq(nonArrayIds.status, 400, "val3: non-array provider_ids -> 400");
      const nonStringIds = await callRoute(opplevelserRouter, {
        headers: authHeaders, body: { provider_ids: [123], enabled: false },
      });
      assertEq(nonStringIds.status, 400, "val4: non-string element in provider_ids -> 400");
      const missingEnabled = await callRoute(opplevelserRouter, {
        headers: authHeaders, body: { provider_ids: ["prov-a"] },
      });
      assertEq(missingEnabled.status, 400, "val5: missing enabled -> 400");
      const stringEnabled = await callRoute(opplevelserRouter, {
        headers: authHeaders, body: { provider_ids: ["prov-a"], enabled: "true" },
      });
      assertEq(stringEnabled.status, 400, "val6: enabled as a string (not boolean) -> 400");
      const tooMany = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: Array.from({ length: 201 }, (_, i) => `id-${i}`), enabled: false },
      });
      assertEq(tooMany.status, 400, "val7: >200 provider_ids -> 400");
      assertEq(bookingLiveOf("prov-a"), 1, "val8: no writes happened from any of the invalid requests above");

      // ── AC1: dry-run reports, writes nothing ─────────────────────────────
      const dryOff = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-a"], enabled: false, note: "klage fra gjest" },
      });
      assertEq(dryOff.status, 200, "ac1-1: dry-run (apply absent) -> 200");
      assertEq(dryOff.body.dry_run, true, "ac1-2: dry_run:true when apply is absent");
      assertEq(
        dryOff.body.results[0],
        { provider_id: "prov-a", name: "Gård A AS", ok: true, changed: true, from: 1, to: 0 },
        "ac1-3: dry-run reports the planned change (1 -> 0)",
      );
      assertEq(bookingLiveOf("prov-a"), 1, "ac1-4: dry-run performed ZERO writes — prov-a still booking_live=1");
      assertEq(countAudit("prov-a"), 0, "ac1-5: dry-run wrote NO audit row");

      const dryOffFalse = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-a"], enabled: false, apply: false },
      });
      assertEq(dryOffFalse.body.dry_run, true, "ac1-6: apply:false is ALSO a dry-run (explicit false, same as absent)");
      assertEq(bookingLiveOf("prov-a"), 1, "ac1-7: apply:false performed zero writes");

      // ── AC3: no_email guard — enabled:true rejected, enabled:false NOT ──
      const guardOn = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-on-noemail"], enabled: true, apply: true },
      });
      assertEq(
        guardOn.body.results[0],
        { provider_id: "prov-on-noemail", name: "Gård Vil Åpne Uten Epost AS", ok: false, changed: false, reason: "no_email", from: 0 },
        "ac3-1: enabled:true + no epost -> rejected reason:no_email, unchanged",
      );
      assertEq(bookingLiveOf("prov-on-noemail"), 0, "ac3-2: no_email guard -> no write happened");
      assertEq(countAudit("prov-on-noemail"), 0, "ac3-3: no_email guard -> no audit row");

      const guardOff = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-off-noemail"], enabled: false, apply: true, note: "nødbrems uten epost" },
      });
      assertEq(guardOff.body.results[0].ok, true, "ac3-4: enabled:false is NEVER guarded by no_email — ok:true even with no epost on file");
      assertEq(guardOff.body.results[0].changed, true, "ac3-5: enabled:false + no epost -> changed:true");
      assertEq(bookingLiveOf("prov-off-noemail"), 0, "ac3-6: the emergency brake actually flipped booking_live to 0 despite no epost");
      assertEq(countAudit("prov-off-noemail"), 1, "ac3-7: one audit row written for the off-flip");

      // ── AC2: apply=true writes ONLY booking_live + one audit row, note preserved ──
      const beforeCatalogHidden = (
        expDb.prepare(`SELECT catalog_hidden, epost FROM experience_providers WHERE id = ?`).get("prov-turn-on") as any
      );
      const applyOn = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-turn-on"], enabled: true, apply: true, note: "produsent svarte ja på e-post" },
      });
      assertEq(applyOn.body.dry_run, false, "ac2-1: apply:true -> dry_run:false");
      assertEq(applyOn.body.results[0], { provider_id: "prov-turn-on", name: "Gård Skal Åpnes AS", ok: true, changed: true, from: 0, to: 1 }, "ac2-2: turn-on applied");
      assertEq(bookingLiveOf("prov-turn-on"), 1, "ac2-3: booking_live actually written to 1");
      const afterRow = expDb.prepare(`SELECT catalog_hidden, epost FROM experience_providers WHERE id = ?`).get("prov-turn-on") as any;
      assertEq(afterRow.catalog_hidden, beforeCatalogHidden.catalog_hidden, "ac2-4: catalog_hidden untouched");
      assertEq(afterRow.epost, beforeCatalogHidden.epost, "ac2-5: epost untouched");
      assertEq(countAudit("prov-turn-on"), 1, "ac2-6: exactly one audit row written");
      const auditRow = expDb
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'booking_live'`)
        .get("prov-turn-on") as any;
      assertEq(auditRow.old_value, "0", "ac2-7: audit old_value is '0'");
      assertEq(auditRow.new_value, "1", "ac2-8: audit new_value is '1'");
      assertEq(auditRow.changed_by, "admin", "ac2-9: audit changed_by is 'admin'");
      assertEq(auditRow.notes, "produsent svarte ja på e-post", "ac2-10: the operator's note is preserved verbatim in the audit row");

      // ── idempotency: already_current -> zero writes, zero new audit rows ──
      const already = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-turn-on"], enabled: true, apply: true, note: "re-run" },
      });
      assertEq(already.body.results[0].changed, false, "idem1: re-running the same enabled:true -> changed:false");
      assertEq(already.body.results[0].reason, "already_current", "idem2: reason is already_current");
      assertEq(countAudit("prov-turn-on"), 1, "idem3: STILL only one audit row — the re-run wrote nothing new");

      // ── not_found handling — a bad id doesn't fail the whole batch ──────
      const withMissing = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-b", "does-not-exist"], enabled: false, apply: false },
      });
      assertEq(withMissing.status, 200, "nf1: batch with a nonexistent id -> 200, not an error");
      assertEq(withMissing.body.results.length, 2, "nf2: two results, one per requested id");
      assertEq(withMissing.body.results[0].provider_id, "prov-b", "nf3: real id present and unaffected");
      assertEq(withMissing.body.results[0].reason, undefined, "nf3b: real id has no reason (it's a real planned change)");
      assertEq(withMissing.body.results[1], { provider_id: "does-not-exist", name: null, ok: false, changed: false, reason: "not_found" }, "nf4: nonexistent id -> not_found, per-row");

      // dedupe check
      const dupIds = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-b", "prov-b"], enabled: false, apply: false },
      });
      assertEq(dupIds.body.results.length, 1, "dedupe1: duplicate id in the request -> appears once");

      // ── AC6: overview GET reuses computeGardssalgReadinessRows's booking_status ──
      const overviewBefore = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-booking-activation", headers: authHeaders,
      });
      assertEq(overviewBefore.status, 200, "ac6-1: GET overview -> 200");
      const liveIdsBefore = new Set((overviewBefore.body.providers as any[]).map((p) => p.id));
      assertTrue(liveIdsBefore.has("prov-a"), "ac6-2: prov-a (booking_live=1) listed as live");
      assertTrue(liveIdsBefore.has("prov-b"), "ac6-3: prov-b (booking_live=1) listed as live");
      assertTrue(!liveIdsBefore.has("prov-on-noemail"), "ac6-4: booking_live=0 provider NOT listed as live");
      assertEq(overviewBefore.body.count_live, liveIdsBefore.size, "ac6-5: count_live matches the returned list length");

      // ═══════════════════════════════════════════════════════════════════
      // AC4 — THE EMERGENCY-BRAKE TEST: turn OFF prov-a; prov-b (same
      // corpus, also booking_live=1) must stay bookable on every surface.
      // ═══════════════════════════════════════════════════════════════════
      const brake = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-a"], enabled: false, apply: true, note: "produsent ba om pause" },
      });
      assertEq(brake.body.results[0].changed, true, "ac4-0: brake applied to prov-a");
      assertEq(bookingLiveOf("prov-a"), 0, "ac4-1: prov-a booking_live=0 after the brake");
      assertEq(bookingLiveOf("prov-b"), 1, "ac4-2: prov-b booking_live UNCHANGED (still 1) — no leak to the other row");

      // -- unit-level: the shared gate itself reflects the flip -----------
      assertEq(bookingStore.isBookingPaused(0, null), true, "ac4-3: isBookingPaused(prov-a's now-0 value) -> true (paused)");
      assertEq(bookingStore.isBookingPaused(1, null), false, "ac4-4: isBookingPaused(prov-b's still-1 value) -> false (bookable), dispatch is on");

      // -- surface 1: POST /api/opplevelser/book (JSON API) ---------------
      function countBookings(): number {
        return (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings`).get() as { n: number }).n;
      }
      const bookA = await callRoute(opplevelserRouter, {
        url: "/book", headers: {},
        body: {
          provider_id: "prov-a", slot_at: "2026-09-01T12:00", party_size: 2,
          guest_name: "Gjest A", guest_email: "gjest.a@example.no",
        },
      });
      assertEq(bookA.body.success, false, "ac4-5: POST /book against the now-paused prov-a -> success:false");
      assertEq(bookA.body.paused, true, "ac4-6: POST /book against prov-a -> paused:true");
      assertEq(countBookings(), 0, "ac4-7: no gardssalg_bookings row created for prov-a");

      const bookB = await callRoute(opplevelserRouter, {
        url: "/book", headers: {},
        body: {
          provider_id: "prov-b", slot_at: "2026-09-01T12:00", party_size: 2,
          guest_name: "Gjest B", guest_email: "gjest.b@example.no",
        },
      });
      assertEq(bookB.body.success, true, "ac4-8: POST /book against still-live prov-b -> success:true (NOT blocked by prov-a's brake)");
      assertEq(countBookings(), 1, "ac4-9: exactly one booking row created, for prov-b");
      const bRow = expDb.prepare(`SELECT provider_id FROM gardssalg_bookings LIMIT 1`).get() as { provider_id: string };
      assertEq(bRow.provider_id, "prov-b", "ac4-10: the created row belongs to prov-b, not prov-a");

      // -- surface 2: MCP book_gardssalg, real HTTP MCP session -----------
      {
        const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
        const app = express();
        app.use(express.json());
        app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
        const server = http.createServer(app);
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}`;

        const initRes = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "booking-activation-test-client", version: "1.0.0" } },
            id: "1",
          }),
        });
        const sessionId = initRes.headers.get("mcp-session-id");
        await initRes.text();

        async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
          const res = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: String(Math.random()) }),
          });
          const body = parseJsonRpcBody(await res.text(), res.headers.get("content-type"));
          const text = body.result?.content?.[0]?.text;
          return typeof text === "string" ? JSON.parse(text) : null;
        }

        const mcpA = await callTool("book_gardssalg", {
          provider_id: "prov-a", slot_at: "2026-09-02T12:00", party_size: 2,
          guest_name: "MCP Gjest A", guest_email: "mcp.a@example.no",
        });
        assertEq(mcpA?.success, false, "ac4-11: MCP book_gardssalg against paused prov-a -> success:false");

        const mcpB = await callTool("book_gardssalg", {
          provider_id: "prov-b", slot_at: "2026-09-02T12:00", party_size: 2,
          guest_name: "MCP Gjest B", guest_email: "mcp.b@example.no",
        });
        assertEq(mcpB?.success, true, "ac4-12: MCP book_gardssalg against still-live prov-b -> success:true (no leak from prov-a's brake)");
        assertEq(countBookings(), 2, "ac4-13: two total bookings now (prov-b JSON API + prov-b MCP), still none for prov-a");
      }

      // -- surface 3: SSR no-JS fallback, real HTTP server -----------------
      {
        const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default;
        const app = express();
        app.use(seoRouter as any);
        const server = http.createServer(app);
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}`;

        async function postForm(slug: string, form: Record<string, string>): Promise<string | null> {
          const res = await fetch(`${base}/kategori/gardssalg/book/${encodeURIComponent(slug)}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form).toString(),
            redirect: "manual",
          });
          return res.headers.get("location");
        }

        const locA = await postForm("gard-a", {
          slot_at: "2026-09-03T12:00", party_size: "2", guest_name: "SSR Gjest A", guest_email: "ssr.a@example.no",
        });
        assertTrue(!!locA && locA.includes("error=paused"), `ac4-14: SSR no-JS form against paused prov-a redirects with ?error=paused (got ${locA})`);

        const locB = await postForm("gard-b", {
          slot_at: "2026-09-03T12:00", party_size: "2", guest_name: "SSR Gjest B", guest_email: "ssr.b@example.no",
        });
        assertTrue(!!locB && locB.includes("/confirm/"), `ac4-15: SSR no-JS form against still-live prov-b redirects to the confirmation page (got ${locB})`);
        assertEq(countBookings(), 3, "ac4-16: three total bookings now (all prov-b across the three surfaces), still zero for prov-a");
      }

      // ── AC5: the double gate is unbroken — dispatch off still blocks a
      //     booking_live=1 provider (regression, existing coverage elsewhere
      //     must stay green; this is an additional direct check) ──────────
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const dispatchOffBook = await callRoute(opplevelserRouter, {
        url: "/book", headers: {},
        body: {
          provider_id: "prov-b", slot_at: "2026-09-04T12:00", party_size: 2,
          guest_name: "Gjest Uten Dispatch", guest_email: "nodispatch@example.no",
        },
      });
      assertEq(dispatchOffBook.body.paused, true, "ac5-1: BOOKING_DISPATCH_ENABLED unset -> even booking_live=1 prov-b is paused");
      assertEq(countBookings(), 3, "ac5-2: no new booking row created while dispatch is off");
      process.env.BOOKING_DISPATCH_ENABLED = "true";

      // ── AC7: owner-portal write still works unchanged, and coexists with
      //     the admin lever's audit trail (both leave a trace) ───────────
      const ownerOutcome = claimSvc.updateClaimedProviderProfile("prov-owner", { booking_live: 1 });
      assertTrue("ok" in ownerOutcome && ownerOutcome.ok === true, "ac7-1: owner-portal write still succeeds");
      assertEq(bookingLiveOf("prov-owner"), 1, "ac7-2: owner-portal write actually set booking_live=1");
      const ownerAudit = expDb
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'booking_live' ORDER BY rowid DESC LIMIT 1`)
        .get("prov-owner") as any;
      assertEq(ownerAudit.changed_by, "owner", "ac7-3: owner-portal write's audit row is changed_by='owner' (unchanged convention)");

      // Admin lever now flips the SAME provider off — last-write-wins, but
      // BOTH audit trails survive.
      const adminAfterOwner = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-owner"], enabled: false, apply: true, note: "admin overstyrer eier" },
      });
      assertEq(adminAfterOwner.body.results[0].changed, true, "ac7-4: admin lever can flip a provider the owner-portal just touched");
      assertEq(bookingLiveOf("prov-owner"), 0, "ac7-5: last write (admin) wins on the booking_live column");
      const ownerRowStillThere = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'booking_live' AND changed_by = 'owner'`)
        .get("prov-owner") as { n: number };
      const adminRowNowThere = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'booking_live' AND changed_by = 'admin'`)
        .get("prov-owner") as { n: number };
      assertTrue(ownerRowStillThere.n >= 1, "ac7-6: the owner's audit row is still there — never mutated/deleted");
      assertTrue(adminRowNowThere.n >= 1, "ac7-7: the admin's own audit row is also there — neither clobbers the other's trail");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-booking-activation: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
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

if (require.main === module) {
  runOpplevelserGardssalgBookingActivationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
