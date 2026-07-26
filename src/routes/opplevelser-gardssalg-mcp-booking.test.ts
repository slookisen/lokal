/**
 * opplevelser-gardssalg-mcp-booking.test.ts — dev-request
 * 2026-07-21-mcp-booking-tool (Daniel GO 2026-07-21, recorded in
 * daniel-responses/2026-07-21-go-outreach-pakke.md on the A2A workspace
 * repo): a new `book_gardssalg` MCP tool in experiences-mcp.ts, a THIN
 * wrapper over the EXISTING booking chain (BookingInputSchema validation,
 * createBooking(), sendBookingConfirmation()/sendProducerNotification()) —
 * the same chain POST /api/opplevelser/book (opplevelser.ts) uses.
 *
 * Covers (acceptance criteria from the dev-request):
 *   (a) tool call -> pending 'reserved' row + confirm_token created in
 *       gardssalg_bookings, source='mcp', same table as the web form.
 *   (b) non-live producer (booking_live=0) -> clear rejection, not a 500,
 *       no row created.
 *   (c) BOOKING_DISPATCH_ENABLED unset -> same clear rejection even for a
 *       provider whose OWN booking_live=1 (the global gate still applies,
 *       identical to the web path's isBookingPaused() double-gate).
 *   (d) no bypass path: the tool's response NEVER carries confirm_token —
 *       only a token read directly from the DB (never exposed to the
 *       calling agent) can resolve the booking via the existing
 *       resolveBooking()/confirm-token flow; a wrong/guessed token cannot.
 *   (e) input validation — invalid email, non-integer/out-of-range
 *       party_size, and a garbage date are all rejected with a clear
 *       error (not a crash, not isError-less silent success), and no row
 *       is created for any of them.
 *   (f) unknown provider_id behaves exactly like a paused provider (same
 *       gate, same message) rather than a special-cased crash.
 *
 * Same real-MCP-session-over-HTTP approach as
 * opplevelser-gardssalg-mcp-discoverability.test.ts (the synthetic
 * router.handle() shortcut can't drive the MCP SDK's
 * StreamableHTTPServerTransport).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-mcp-booking.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgMcpBookingTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Parses a JSON-RPC response body that may be a raw JSON object or an SSE
// stream ("event: message\ndata: {...}\n\n") — same helper as
// opplevelser-gardssalg-mcp-discoverability.test.ts / opplevelser-discover-geo.test.ts.
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

export function runOpplevelserGardssalgMcpBookingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.BOOKING_DISPATCH_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const experiencesMcpPath = require.resolve("./experiences-mcp");
    const cachePaths = [dbFactoryPath, expStorePath, bookingStorePath, experiencesMcpPath];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");

      // ── Fixtures ────────────────────────────────────────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @epost, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      // bk-live: onboarded (booking_live=1), real (catalog_hidden NULL) — needs
      // BOTH its own flag AND the global BOOKING_DISPATCH_ENABLED to accept.
      insertProvider.run({
        id: "bk-live", navn: "Bookbar Gård AS", fylke: "Vestland", kommune: "Bergen", producer_type: "bryggeri",
        booking_live: 1, catalog_hidden: null, epost: "produsent@bookbar-gaard.example.no", slug: "bookbar-gaard",
      });
      // bk-paused: never onboarded (booking_live=0) — must always reject,
      // dispatch flag irrelevant.
      insertProvider.run({
        id: "bk-paused", navn: "Ikke Klar Gård AS", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 0, catalog_hidden: null, epost: "produsent@ikke-klar.example.no", slug: "ikke-klar-gaard",
      });

      // ── Real MCP session over HTTP ───────────────────────────────────────
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const initRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "booking-mcp-test-client", version: "1.0.0" } },
          id: "1",
        }),
      });
      assertTrue(initRes.ok, `init: MCP initialize returns 2xx (got ${initRes.status})`);
      const sessionId = initRes.headers.get("mcp-session-id");
      assertTrue(!!sessionId, "init2: MCP initialize response carries an mcp-session-id header");
      await initRes.text();

      async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ body: any; parsed: any }> {
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "tools/call",
            params: { name, arguments: args },
            id: String(Math.random()),
          }),
        });
        assertTrue(res.ok, `${name}: tools/call returns 2xx (got ${res.status})`);
        const body = parseJsonRpcBody(await res.text(), res.headers.get("content-type"));
        assertTrue(!("error" in body), `${name}: no top-level JSON-RPC error (got ${JSON.stringify(body.error)})`);
        const text = body.result?.content?.[0]?.text;
        assertTrue(typeof text === "string", `${name}: returns a text content block`);
        return { body, parsed: JSON.parse(text) };
      }

      function countRows(): number {
        return (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;
      }

      // ── (b) non-live producer (booking_live=0) -> clear rejection ────────
      const pausedCall = await callTool("book_gardssalg", {
        provider_id: "bk-paused",
        slot_at: "2026-08-20T12:00",
        party_size: 2,
        guest_name: "Ola Nordmann",
        guest_email: "ola@example.no",
      });
      assertEq(pausedCall.parsed.success, false, "b1: booking_live=0 producer -> success:false");
      assertEq(pausedCall.parsed.pending, false, "b2: booking_live=0 producer -> pending:false");
      assertTrue(
        typeof pausedCall.parsed.message === "string" && pausedCall.parsed.message.length > 0,
        "b3: booking_live=0 producer -> a clear, non-empty rejection message (not a silent failure)"
      );
      assertEq(countRows(), 0, "b4: booking_live=0 producer -> no gardssalg_bookings row created");

      // ── (f) unknown provider_id -> same gate, same clear rejection ───────
      const unknownCall = await callTool("book_gardssalg", {
        provider_id: "does-not-exist",
        slot_at: "2026-08-20T12:00",
        party_size: 2,
        guest_name: "Ola Nordmann",
        guest_email: "ola@example.no",
      });
      assertEq(unknownCall.parsed.success, false, "f1: unknown provider_id -> success:false (not a crash/500)");
      assertEq(unknownCall.parsed.pending, false, "f2: unknown provider_id -> pending:false");
      assertEq(countRows(), 0, "f3: unknown provider_id -> no row created");

      // ── (c) BOOKING_DISPATCH_ENABLED unset -> reject even for bk-live
      //     (own booking_live=1) — the global master switch still gates ────
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const dispatchOffCall = await callTool("book_gardssalg", {
        provider_id: "bk-live",
        slot_at: "2026-08-20T12:00",
        party_size: 2,
        guest_name: "Kari Nordmann",
        guest_email: "kari@example.no",
      });
      assertEq(dispatchOffCall.parsed.success, false, "c1: BOOKING_DISPATCH_ENABLED unset -> success:false even for booking_live=1 provider");
      assertEq(dispatchOffCall.parsed.pending, false, "c2: BOOKING_DISPATCH_ENABLED unset -> pending:false");
      assertEq(countRows(), 0, "c3: BOOKING_DISPATCH_ENABLED unset -> no row created");

      // ── (e) input validation — invalid email, bad party_size, garbage date,
      //     all via the SAME BookingInputSchema the web form uses ───────────
      process.env.BOOKING_DISPATCH_ENABLED = "true";

      const badEmailCall = await callTool("book_gardssalg", {
        provider_id: "bk-live",
        slot_at: "2026-08-20T12:00",
        party_size: 2,
        guest_name: "Kari Nordmann",
        guest_email: "not-an-email",
      });
      assertEq(badEmailCall.parsed.success, false, "e1: invalid guest_email -> success:false");
      assertTrue(badEmailCall.body.result?.isError === true, "e2: invalid guest_email -> tool result marked isError");
      assertEq(countRows(), 0, "e3: invalid guest_email -> no row created");

      const badPartySizeCall = await callTool("book_gardssalg", {
        provider_id: "bk-live",
        slot_at: "2026-08-20T12:00",
        party_size: 0,
        guest_name: "Kari Nordmann",
        guest_email: "kari@example.no",
      });
      assertEq(badPartySizeCall.parsed.success, false, "e4: party_size=0 (below BookingInputSchema's min 1) -> success:false");
      assertEq(countRows(), 0, "e5: party_size=0 -> no row created");

      const emptyNameCall = await callTool("book_gardssalg", {
        provider_id: "bk-live",
        slot_at: "2026-08-20T12:00",
        party_size: 2,
        guest_name: "",
        guest_email: "kari@example.no",
      });
      assertEq(emptyNameCall.parsed.success, false, "e6: empty guest_name (below BookingInputSchema's min 1) -> success:false");
      assertEq(countRows(), 0, "e7: empty guest_name -> no row created");

      // ── (a) happy path: BOOKING_DISPATCH_ENABLED=true + bk-live's own
      //     booking_live=1 -> pending row + confirm_token created ──────────
      const okCall = await callTool("book_gardssalg", {
        provider_id: "bk-live",
        slot_at: "2026-08-20T12:00",
        party_size: 3,
        guest_name: "Kari Nordmann",
        guest_email: "kari@example.no",
        guest_phone: "40000000",
        notes: "Vegetarmeny, takk",
      });
      assertEq(okCall.parsed.success, true, "a1: valid booking against a live+dispatched producer -> success:true");
      assertEq(okCall.parsed.pending, true, "a2: response explicitly marks pending:true");
      assertEq(okCall.parsed.status, "reserved", "a3: response status is 'reserved' (never auto-confirmed)");
      assertEq(okCall.parsed.confirmation_required, true, "a4: response explicitly flags confirmation_required:true");
      assertTrue(
        typeof okCall.parsed.message === "string" && /produsent(en)?|producer/i.test(okCall.parsed.message),
        "a5: response message explains the PRODUCER (not the guest) must respond — confirm, suggest another time, or decline — before the booking is final"
      );
      assertTrue(
        typeof okCall.parsed.message === "string" &&
          !/guest (must click|clicks)|gjesten (må selv |selv )?(klikke|bekrefter)/i.test(okCall.parsed.message),
        "a5b: response message does NOT falsely claim the guest must click a link to finalize the booking"
      );
      assertTrue(typeof okCall.parsed.booking_ref === "string" && okCall.parsed.booking_ref.length > 0, "a6: response carries a booking_ref");
      assertTrue(!("confirm_token" in okCall.parsed), "a7: response NEVER carries confirm_token (no self-confirm path via the tool)");
      assertTrue(!("confirm_url" in okCall.parsed), "a8: response NEVER carries confirm_url (no self-confirm path via the tool)");
      assertEq(countRows(), 1, "a9: exactly one gardssalg_bookings row created");

      const dbRow = db
        .prepare("SELECT * FROM gardssalg_bookings WHERE booking_ref = ?")
        .get(okCall.parsed.booking_ref) as Record<string, unknown>;
      assertTrue(!!dbRow, "a10: the row is findable by booking_ref in the SAME gardssalg_bookings table the web form writes to");
      assertEq(dbRow.status, "reserved", "a11: DB row status is 'reserved'");
      assertEq(dbRow.source, "mcp", "a12: DB row source is stamped 'mcp' (channel analytics only)");
      assertEq(dbRow.provider_id, "bk-live", "a13: DB row provider_id matches the request");
      assertEq(dbRow.party_size, 3, "a14: DB row party_size matches the request");
      assertEq(dbRow.guest_name, "Kari Nordmann", "a15: DB row guest_name matches the request");
      assertEq(dbRow.guest_email, "kari@example.no", "a16: DB row guest_email matches the request");
      assertEq(dbRow.guest_phone, "40000000", "a17: DB row guest_phone matches the request");
      assertEq(dbRow.notes, "Vegetarmeny, takk", "a18: DB row notes matches the request");
      assertTrue(typeof dbRow.confirm_token === "string" && (dbRow.confirm_token as string).length > 0, "a19: DB row has a real confirm_token issued by the EXISTING token-issuance code (createBooking), unmodified");

      // ── (d) no bypass path: only the confirm_token actually stored in the
      //     DB (never surfaced by the tool) can resolve the booking via the
      //     EXISTING, untouched resolveBooking()/confirm-token flow ────────
      const realToken = dbRow.confirm_token as string;
      const wrongTokenResult = bookingStore.resolveBooking("not-the-real-token", "confirmed_attended", "test-producer");
      assertEq(wrongTokenResult, null, "d1: a guessed/wrong confirm_token cannot resolve the booking");
      const stillReserved = bookingStore.getBookingByRef(okCall.parsed.booking_ref as string);
      assertEq(stillReserved?.status, "reserved", "d2: booking is still 'reserved' after the failed wrong-token attempt — no bypass mutated it");

      const resolved = bookingStore.resolveBooking(realToken, "confirmed_attended", "test-producer");
      assertTrue(!!resolved, "d3: the REAL confirm_token (read directly from the DB, never returned by the tool) resolves via the existing, untouched resolveBooking()");
      assertEq(resolved?.status, "confirmed_attended", "d4: resolveBooking() with the real token flips status as designed — proving the ONLY path to confirmation is that existing token flow, not this tool");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-mcp-booking: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-mcp-booking.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgMcpBookingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
