/**
 * opplevelser-gardssalg-booking-switch.test.ts — dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg, G1 items 3 and 7.
 *
 * Covers:
 *   (p) pure rules in services/gardssalg-booking-gate.ts: the shared
 *       booking-request-address rule, the owner enable gate (admin brake
 *       first), and the AI booking note (owned + off = "tar ikke imot
 *       forespørsler nå"; never claimed = "åpner snart").
 *   (o) owner write (updateClaimedProviderProfile): switching booking ON
 *       without an address -> booking_blocked/no_booking_email and nothing
 *       written; a content_source='manual' row CAN change booking_live while
 *       its content fields stay locked.
 *   (b) admin brake through the real admin route (POST /admin/gardssalg-
 *       booking-activation): enabled:false stamps the brake (also on a row
 *       whose booking is already off), the owner can then not switch booking
 *       on (admin_brake with the operator's note) but can still switch it
 *       off; enabled:true lifts the brake. Audit rows for brake changes.
 *   (m) MCP discover_gardssalg / book_gardssalg over a real HTTP session: an
 *       owned profile with booking off never says "åpner snart"; a
 *       never-claimed profile still does.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-booking-switch.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgBookingSwitchTests().
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { headers?: Record<string, string>; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const url = "/admin/gardssalg-booking-activation";
    const req: any = {
      method: "POST", url, originalUrl: url, path: url, query: {},
      headers: opts.headers || {}, body: opts.body,
      get(name: string) { return (opts.headers || {})[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function nextWeekdayDatetimeLocal(targetDow: number, hour: number, minute: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(hour)}:${pad(minute)}`;
}

export function runOpplevelserGardssalgBookingSwitchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-booking-switch-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-booking-gate"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    let server: http.Server | undefined;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }

      const gate = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");

      // ── (p) pure rules ──────────────────────────────────────────────────
      assertEq(gate.hasBookingRequestEmail("post@gard.no"), true, "p1: a real address counts");
      assertEq(gate.hasBookingRequestEmail("   "), false, "p2: whitespace is no address");
      assertEq(gate.hasBookingRequestEmail(null), false, "p3: null is no address");

      assertEq(
        gate.ownerBookingEnableBlock({ epost: "post@gard.no", booking_admin_brake_at: null, booking_admin_brake_note: null }),
        null,
        "p4: address + no brake -> owner may switch booking on",
      );
      const pNoEmail = gate.ownerBookingEnableBlock({ epost: null, booking_admin_brake_at: null, booking_admin_brake_note: null });
      assertEq(pNoEmail?.reason, "no_booking_email", "p5: no address -> no_booking_email");
      assertTrue(/e-postadresse/.test(pNoEmail?.message || ""), "p6: no_booking_email carries a Norwegian reason");
      const pBrake = gate.ownerBookingEnableBlock({ epost: "post@gard.no", booking_admin_brake_at: "2026-10-23 10:00:00", booking_admin_brake_note: " klage fra gjest " });
      assertEq(pBrake?.reason, "admin_brake", "p7: brake set -> admin_brake, even with an address");
      assertEq(pBrake?.note, "klage fra gjest", "p8: the brake carries the operator's note (trimmed)");
      assertTrue(/stanset av Opplevagent/.test(pBrake?.message || ""), "p9: admin_brake message says 'stanset av Opplevagent'");
      assertEq(
        gate.ownerBookingEnableBlock({ epost: null, booking_admin_brake_at: "2026-10-23 10:00:00", booking_admin_brake_note: null })?.reason,
        "admin_brake",
        "p10: the brake is reported before the missing address",
      );

      const live = gate.gardssalgBookingStatus({ booking_live: 1, claimed_at: "2026-10-01" });
      assertEq(live, { live: true, mode: "request", note: gate.GARDSSALG_BOOKING_NOTE_LIVE }, "p11: live -> request + 'Book direkte'");
      const ownedOff = gate.gardssalgBookingStatus({ booking_live: 0, claimed_at: "2026-10-01" });
      assertEq(ownedOff.mode, "paused", "p12: owned + off -> paused");
      assertTrue(/tar ikke imot forespørsler nå/.test(ownedOff.note), "p13: owned + off -> 'tar ikke imot forespørsler nå'");
      assertTrue(/not taking requests right now/.test(ownedOff.note), "p14: ...with the English half kept");
      assertTrue(!/åpner snart|open soon/i.test(ownedOff.note), "p15: owned + off never says 'åpner snart'");
      const unclaimedOff = gate.gardssalgBookingStatus({ booking_live: 0, claimed_at: null });
      assertEq(unclaimedOff.note, gate.GARDSSALG_BOOKING_NOTE_OPENS_SOON, "p16: never claimed + off keeps 'åpner snart'");
      assertEq(gate.gardssalgNotTakingRequestsText(null), null, "p17: never claimed -> no 'not taking' line for book_gardssalg");
      assertTrue(!!gate.gardssalgNotTakingRequestsText("2026-10-01"), "p18: owned -> a 'not taking' line for book_gardssalg");

      // ── DB fixtures ─────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");

      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, content_source, booking_live, catalog_hidden,
            slug, claimed_at, about_text, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', 'Vestland', 'Voss', 'sideri', @epost, @content_source, @booking_live, 0,
            @slug, @claimed_at, @about_text, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insert.run({ id: "sw-noemail", navn: "Sideri Uten Adresse AS", epost: null, content_source: "claim", booking_live: 0, slug: "sw-noemail", claimed_at: "2026-10-01T10:00:00Z", about_text: "Gammel tekst" });
      insert.run({ id: "sw-manual", navn: "Sideri Manuell AS", epost: "post@manuell.no", content_source: "manual", booking_live: 0, slug: "sw-manual", claimed_at: "2026-10-01T10:00:00Z", about_text: "Kuratert tekst" });
      insert.run({ id: "sw-brake", navn: "Sideri Bremset AS", epost: "post@bremset.no", content_source: "claim", booking_live: 0, slug: "sw-brake", claimed_at: "2026-10-01T10:00:00Z", about_text: null });
      insert.run({ id: "sw-unclaimed", navn: "Sideri Uten Eier AS", epost: "post@uteneier.no", content_source: "provider_site", booking_live: 0, slug: "sw-unclaimed", claimed_at: null, about_text: null });

      const rowOf = (id: string): any =>
        expDb.prepare(`SELECT booking_live, about_text, booking_admin_brake_at, booking_admin_brake_note FROM experience_providers WHERE id = ?`).get(id);
      const auditCount = (id: string, field: string): number =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = ?`).get(id, field) as { n: number }).n;

      // ── (o) owner write ─────────────────────────────────────────────────
      const o1 = claimSvc.updateClaimedProviderProfile("sw-noemail", { about_text: "Ny tekst", booking_live: 1 });
      assertEq(o1.ok, false, "o1: switching booking on without an address is refused");
      assertEq(!o1.ok && "block" in o1 ? o1.block.reason : null, "no_booking_email", "o2: ...with reason no_booking_email");
      assertEq(rowOf("sw-noemail").booking_live, 0, "o3: booking_live still 0");
      assertEq(rowOf("sw-noemail").about_text, "Gammel tekst", "o4: nothing else in the request was written either");
      assertEq(auditCount("sw-noemail", "booking_live"), 0, "o5: no audit row for the refused write");
      const o6 = claimSvc.updateClaimedProviderProfile("sw-noemail", { about_text: "Ny tekst", booking_live: 0 });
      assertEq(o6.ok, true, "o6: the same save with booking off goes through");
      assertEq(rowOf("sw-noemail").about_text, "Ny tekst", "o7: ...and the text is saved");

      const o8 = claimSvc.updateClaimedProviderProfile("sw-manual", { about_text: "Overskriv", booking_live: true });
      assertEq(o8.ok, true, "o8: a manual row's owner write returns ok");
      assertTrue(o8.ok === true && o8.updatedFields.includes("booking_live"), "o9: manual row: booking_live is updated (no longer blocked by the manual lock)");
      assertTrue(o8.ok === true && o8.skippedFields.some((s) => s.field === "about_text" && s.reason === "locked_by_manual"), "o10: manual row: about_text still skipped locked_by_manual");
      assertEq(rowOf("sw-manual").booking_live, 1, "o11: manual row: booking_live is 1");
      assertEq(rowOf("sw-manual").about_text, "Kuratert tekst", "o12: manual row: curated text untouched");
      const o13 = claimSvc.updateClaimedProviderProfile("sw-manual", { booking_live: 0 });
      assertEq(o13.ok, true, "o13: manual row: owner can switch booking off again");
      assertEq(rowOf("sw-manual").booking_live, 0, "o14: manual row: booking_live is 0");

      // ── (b) admin brake via the real admin route ────────────────────────
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const authHeaders = { "x-admin-key": testKey };

      const dry = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["sw-brake"], enabled: false, note: "klage" } });
      assertEq(dry.body.dry_run, true, "b0: dry-run sanity");
      assertEq(rowOf("sw-brake").booking_admin_brake_at, null, "b1: dry-run sets no brake");

      const brake = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["sw-brake"], enabled: false, apply: true, note: "Klage fra gjest <ikke fulgt opp>" },
      });
      assertEq(brake.status, 200, "b2: admin brake call -> 200");
      assertEq(brake.body.results[0].reason, "already_current", "b3: booking_live was already 0 (result shape unchanged)");
      assertTrue(!!rowOf("sw-brake").booking_admin_brake_at, "b4: the brake is stamped even though booking was already off");
      assertEq(rowOf("sw-brake").booking_admin_brake_note, "Klage fra gjest <ikke fulgt opp>", "b5: the operator's note is kept");
      assertEq(auditCount("sw-brake", "booking_admin_brake"), 1, "b6: one audit row for the brake");
      assertEq(auditCount("sw-brake", "booking_live"), 0, "b7: no booking_live audit row (value unchanged)");

      const again = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["sw-brake"], enabled: false, apply: true } });
      assertEq(again.status, 200, "b8: repeat brake -> 200");
      assertEq(auditCount("sw-brake", "booking_admin_brake"), 1, "b9: repeat brake writes no new audit row");

      const ownerOn = claimSvc.updateClaimedProviderProfile("sw-brake", { booking_live: 1 });
      assertEq(!ownerOn.ok && "block" in ownerOn ? ownerOn.block.reason : null, "admin_brake", "b10: owner cannot switch booking on while braked");
      assertEq(!ownerOn.ok && "block" in ownerOn ? ownerOn.block.note : null, "Klage fra gjest <ikke fulgt opp>", "b11: the refusal carries the brake reason");
      assertEq(rowOf("sw-brake").booking_live, 0, "b12: booking_live still 0");
      const ownerOff = claimSvc.updateClaimedProviderProfile("sw-brake", { booking_live: 0 });
      assertEq(ownerOff.ok, true, "b13: owner may still switch booking off while braked");

      const lift = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["sw-brake"], enabled: true, apply: true, note: "avklart" } });
      assertEq(lift.body.results[0].changed, true, "b14: admin enabled:true flips booking on");
      assertEq(rowOf("sw-brake").booking_admin_brake_at, null, "b15: ...and lifts the brake");
      assertEq(rowOf("sw-brake").booking_admin_brake_note, null, "b16: ...and clears the note");
      assertEq(auditCount("sw-brake", "booking_admin_brake"), 2, "b17: lifting the brake is audited too");
      const ownerOffAfter = claimSvc.updateClaimedProviderProfile("sw-brake", { booking_live: 0 });
      assertEq(ownerOffAfter.ok, true, "b18: owner switches off after lift");
      const ownerOnAfter = claimSvc.updateClaimedProviderProfile("sw-brake", { booking_live: 1 });
      assertEq(ownerOnAfter.ok, true, "b19: owner can switch booking on again once the brake is lifted");
      assertEq(rowOf("sw-brake").booking_live, 1, "b20: booking_live is 1");

      const flipOff = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["sw-brake"], enabled: false, apply: true, note: "pause" } });
      assertEq(flipOff.body.results[0].changed, true, "b21: admin brake on a live row flips it off");
      assertTrue(!!rowOf("sw-brake").booking_admin_brake_at, "b22: ...and stamps the brake");

      const noEmailOn = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["sw-noemail"], enabled: true, apply: true } });
      assertEq(noEmailOn.body.results[0].reason, "no_email", "b23: admin no_email guard unchanged (shared rule)");

      // ── (m) MCP discover_gardssalg / book_gardssalg ─────────────────────
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const initRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "booking-switch-test-client", version: "1.0.0" } },
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

      const disc = await callTool("discover_gardssalg", { fylke: "Vestland" });
      const byId = new Map<string, any>(((disc?.gardssalg_producers as any[]) || []).map((p) => [p.id, p]));
      const ownedOffRow = byId.get("sw-noemail");
      assertTrue(!!ownedOffRow, "m1: owned, booking-off producer is listed");
      assertEq(ownedOffRow?.booking?.live, false, "m2: ...not live");
      assertTrue(!/åpner snart|open soon/i.test(ownedOffRow?.booking?.note || ""), "m3: discover_gardssalg: owned + off does NOT say 'åpner snart'");
      assertTrue(/tar ikke imot forespørsler nå/.test(ownedOffRow?.booking?.note || ""), "m4: discover_gardssalg: owned + off says 'tar ikke imot forespørsler nå'");
      assertTrue(/åpner snart/.test(byId.get("sw-brake")?.booking?.note || "") === false, "m5: admin-braked owned producer does not say 'åpner snart' either");
      assertTrue(/åpner snart/.test(byId.get("sw-unclaimed")?.booking?.note || ""), "m6: never-claimed producer keeps 'åpner snart'");

      const slot = nextWeekdayDatetimeLocal(2, 12, 0);
      const bookOwned = await callTool("book_gardssalg", {
        provider_id: "sw-noemail", slot_at: slot, party_size: 2, guest_name: "Gjest", guest_email: "gjest@example.no",
      });
      assertEq(bookOwned?.reason, "not_live", "m7: book_gardssalg on owned + off -> not_live");
      assertTrue(/tar ikke imot forespørsler nå/.test(bookOwned?.message || ""), "m8: book_gardssalg says 'tar ikke imot forespørsler nå' for an owned profile");
      assertTrue(!/ikke aktivert/.test(bookOwned?.message || ""), "m9: ...not 'ikke aktivert ennå'");
      const bookUnclaimed = await callTool("book_gardssalg", {
        provider_id: "sw-unclaimed", slot_at: slot, party_size: 2, guest_name: "Gjest", guest_email: "gjest@example.no",
      });
      assertTrue(/ikke aktivert/.test(bookUnclaimed?.message || ""), "m10: book_gardssalg keeps the 'ikke aktivert' copy for a never-claimed profile");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-booking-switch: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgBookingSwitchTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
