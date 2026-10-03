/**
 * opplevelser-booking-delisted-bypass.test.ts — dev-request
 * 2026-10-03-booking-avlistet-produsent-bypass (Daniel «ja» live 2026-10-03).
 *
 * isBookingPaused() used to let ANY catalog_hidden=1 row bypass the global
 * BOOKING_DISPATCH_ENABLED switch and booking_live. Since the 2026-08-17
 * consent fix catalog_hidden=1 also marks real producers who asked to be
 * delisted, so a caller holding their raw provider_id could dispatch a booking
 * notification to them. Fix: the test provider has its own identity
 * (experience_providers.is_test_provider=1); catalog_hidden=1 without it is
 * ALWAYS paused.
 *
 * Covers: (1) unit gate matrix, (2) flagged test provider dispatches as before
 * (unit + POST /api/opplevelser/book with the global switch OFF), (3)
 * POST /api/opplevelser/book + MCP book_gardssalg with a delisted raw
 * provider_id -> BOOKING_NOT_ACTIVATED_MSG, no row, no email, (4) migration
 * flags exactly the one known test row id.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-booking-delisted-bypass.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserBookingDelistedBypassTests().
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

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

export function runOpplevelserBookingDelistedBypassTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.BOOKING_DISPATCH_ENABLED;

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/email-service"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
    ];
    for (const p of paths) delete require.cache[p];

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const { BOOKING_NOT_ACTIVATED_MSG } = bookingStore;

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const emailCalls: string[] = [];
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (o: { to: string }) => {
        emailCalls.push(o.to);
        return { success: true, messageId: "test" };
      };

      // ── (1)+(2) unit: the gate matrix ───────────────────────────────────
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      assertEq(bookingStore.isBookingPaused(1, 1), true, "u1: catalog_hidden=1, booking_live=1, not test, switch ON -> paused");
      assertEq(bookingStore.isBookingPaused(1, 1, 0), true, "u1b: is_test_provider=0 -> paused");
      assertEq(bookingStore.isBookingPaused(1, 1, null), true, "u1c: is_test_provider NULL -> paused");
      delete process.env.BOOKING_DISPATCH_ENABLED;
      assertEq(bookingStore.isBookingPaused(1, 1), true, "u2: catalog_hidden=1, booking_live=1, not test, switch OFF -> paused");
      assertEq(bookingStore.isBookingPaused(1, 1, 1), false, "u3: flagged test provider dispatches with the switch OFF (as before)");
      assertEq(bookingStore.isBookingPaused(0, 1, 1), true, "u4: flagged test provider still needs booking_live=1");
      assertEq(bookingStore.isBookingPaused(1, 0), true, "u5: visible provider still gated by the switch (OFF)");
      assertEq(bookingStore.isBookingPaused(1, null, 1), true, "u5b: is_test_provider on a VISIBLE row grants no bypass");
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      assertEq(bookingStore.isBookingPaused(1, 0), false, "u6: visible provider, live, switch ON -> not paused (unchanged)");
      assertEq(bookingStore.isBookingPaused(1, null), false, "u6b: catalog_hidden NULL, live, switch ON -> not paused (unchanged)");
      assertEq(bookingStore.isBookingPaused(1, 1, 1), false, "u7: flagged test provider, switch ON -> not paused");
      delete process.env.BOOKING_DISPATCH_ENABLED;

      // ── fixtures ────────────────────────────────────────────────────────
      const insert = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, epost, booking_live, catalog_hidden, is_test_provider, slug,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @epost, @booking_live, @catalog_hidden, @is_test_provider, @slug,
                 'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // Delisted real producer: booking_live still 1 (the exact bug scenario).
      insert.run({ id: "bp-delisted", navn: "Avlistet Gård", epost: "avlistet@gard.example.no", booking_live: 1, catalog_hidden: 1, is_test_provider: null, slug: "avlistet-gard" });
      insert.run({ id: "bp-test", navn: "Testprodusent", epost: "daniel@example.no", booking_live: 1, catalog_hidden: 1, is_test_provider: 1, slug: "testprodusent" });

      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 10);
      const pad = (n: number): string => String(n).padStart(2, "0");
      const slot = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T12:00`;
      const countRows = (): number =>
        (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;

      // ── POST /api/opplevelser/book ──────────────────────────────────────
      const oppRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      function invokeBook(body: Record<string, unknown>): { status: number; json: any } {
        const layer = (oppRouter.stack as any[]).find(
          (l: any) => l.route && l.route.path === "/book" && l.route.methods?.post,
        );
        assertTrue(!!layer, "route: opplevelser router has POST /book layer");
        let status = 200; let jsonBody: any = null;
        const res: any = {
          status: (c: number) => { status = c; return res; },
          json: (o: unknown) => { jsonBody = o; return res; },
        };
        const handle = layer.route.stack[layer.route.stack.length - 1].handle;
        handle({ body }, res, () => {});
        return { status, json: jsonBody };
      }
      const bookBody = (provider_id: string) => ({
        provider_id, slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no",
      });

      for (const sw of ["true", "off"]) {
        if (sw === "true") process.env.BOOKING_DISPATCH_ENABLED = "true"; else delete process.env.BOOKING_DISPATCH_ENABLED;
        emailCalls.length = 0;
        const before = countRows();
        const r = invokeBook(bookBody("bp-delisted"));
        assertEq(r.status, 200, `i1[${sw}]: delisted raw provider_id via POST /book -> 200 paused response`);
        assertEq(r.json?.success, false, `i1b[${sw}]: success:false`);
        assertEq(r.json?.paused, true, `i1c[${sw}]: paused:true`);
        assertEq(r.json?.message, BOOKING_NOT_ACTIVATED_MSG, `i1d[${sw}]: honest BOOKING_NOT_ACTIVATED_MSG`);
        assertEq(countRows(), before, `i1e[${sw}]: no booking row created`);
        await new Promise((r2) => setTimeout(r2, 20));
        assertEq(emailCalls.length, 0, `i1f[${sw}]: no email/notification sent`);
      }

      // Flagged test provider still books with the global switch OFF.
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const beforeTest = countRows();
      const rt = invokeBook(bookBody("bp-test"));
      assertEq(rt.status, 201, "i2: flagged test provider books (201) with the global switch OFF (as before)");
      assertEq(countRows(), beforeTest + 1, "i2b: one booking row created for the test provider");

      // ── MCP book_gardssalg ──────────────────────────────────────────────
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
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "delisted-bypass-test", version: "1.0.0" } },
          id: "1",
        }),
      });
      const sessionId = initRes.headers.get("mcp-session-id");
      await initRes.text();
      async function callBook(provider_id: string): Promise<any> {
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "tools/call",
            params: { name: "book_gardssalg", arguments: { provider_id, slot_at: slot, party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" } },
            id: String(Math.random()),
          }),
        });
        const body = parseJsonRpcBody(await res.text(), res.headers.get("content-type"));
        return JSON.parse(body.result?.content?.[0]?.text);
      }
      for (const sw of ["true", "off"]) {
        if (sw === "true") process.env.BOOKING_DISPATCH_ENABLED = "true"; else delete process.env.BOOKING_DISPATCH_ENABLED;
        emailCalls.length = 0;
        const before = countRows();
        const m = await callBook("bp-delisted");
        assertEq(m.success, false, `m1[${sw}]: delisted raw provider_id via book_gardssalg -> success:false`);
        assertEq(m.reason, "not_live", `m1b[${sw}]: reason not_live`);
        assertTrue(typeof m.message === "string" && m.message.includes(BOOKING_NOT_ACTIVATED_MSG), `m1c[${sw}]: carries BOOKING_NOT_ACTIVATED_MSG`);
        assertEq(countRows(), before, `m1d[${sw}]: no booking row created`);
        await new Promise((r2) => setTimeout(r2, 20));
        assertEq(emailCalls.length, 0, `m1e[${sw}]: no email/notification sent`);
      }

      // Producer-side pre-visit sends are gated by the same predicate.
      delete process.env.BOOKING_DISPATCH_ENABLED;
      emailCalls.length = 0;
      const sent = await bookingStore.sendPrevisitReminderToProducer({
        booking_id: "bp-bk-1", experience_id: null, provider_id: "bp-delisted",
        slot_at: new Date(Date.now() + 86400000 * 10).toISOString(),
        party_size: 2, guest_name: "Kari", guest_email: "kari@example.no", guest_phone: null,
        booking_ref: "GARD-BP-1", confirm_token: "tok-bp", status: "reserved",
      } as any);
      assertEq(sent, false, "p1: pre-visit producer reminder to a delisted producer is suppressed");
      assertEq(emailCalls.length, 0, "p2: no producer email for a delisted producer");

      // ── (4) migration ───────────────────────────────────────────────────
      const { initExperiencesSchema, KNOWN_TEST_PROVIDER_ID } =
        require("../database/init-experiences") as typeof import("../database/init-experiences");
      assertEq(KNOWN_TEST_PROVIDER_ID, "0d11485a-c774-4f75-8bca-fd6e6fe19f8c", "mg0: the known test row id");
      const mdb = new Database(":memory:");
      try {
        initExperiencesSchema(mdb);
        // Simulate a pre-migration prod DB: column absent, rows present.
        mdb.exec("ALTER TABLE experience_providers DROP COLUMN is_test_provider");
        const ins = mdb.prepare(
          `INSERT INTO experience_providers (id, navn, vertical, catalog_hidden, booking_live, enrichment_state, verification_status, source, confidence)
           VALUES (?, ?, 'experiences', ?, 1, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        );
        ins.run(KNOWN_TEST_PROVIDER_ID, "Testprodusent", 1);
        ins.run("mg-delisted", "Avlistet", 1);
        ins.run("mg-visible", "Synlig", 0);
        initExperiencesSchema(mdb);
        const rows = mdb.prepare("SELECT id, is_test_provider FROM experience_providers ORDER BY id").all() as Array<{ id: string; is_test_provider: number | null }>;
        const flagged = rows.filter((r) => r.is_test_provider === 1).map((r) => r.id);
        assertEq(flagged, [KNOWN_TEST_PROVIDER_ID], "mg1: migration flags ONLY the one known test row");
        assertEq(rows.find((r) => r.id === "mg-delisted")?.is_test_provider ?? null, null, "mg2: delisted real row untouched");
        initExperiencesSchema(mdb);
        assertEq(
          (mdb.prepare("SELECT COUNT(*) AS n FROM experience_providers WHERE is_test_provider = 1").get() as { n: number }).n,
          1,
          "mg3: migration is idempotent",
        );
      } finally {
        mdb.close();
      }
    } catch (err) {
      failed++;
      failures.push(`✗ test crashed: ${(err as Error).stack || err}`);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of paths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserBookingDelistedBypassTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
