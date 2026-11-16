/**
 * gardssalg-booking-caps.test.ts — O1-3 (audit findings R9/R10, G6/G7),
 * flag GARDSSALG_BOOKING_CAP_ENABLED.
 *
 * Covers:
 *   (f) the flag is on only for the exact string "true".
 *   (u) pure guard: normalised e-mail, the 30-minute window boundary
 *       (30 min = duplicate, 31 min = not), declined/expired/past/test rows
 *       are not open, each cap, duplicate wins over a cap.
 *   (o) flag off: two identical POST /api/opplevelser/book calls still create
 *       two rows (today's behaviour), and two identical book_gardssalg MCP
 *       calls too.
 *   (a) AK1, flag on: two identical calls give one row and one producer
 *       e-mail; the second returns the same ref with duplicate:true (REST and
 *       MCP); a differently cased / padded e-mail is the same guest.
 *   (c) AK2, flag on: over each cap → cap_reached, the cap name, and no row
 *       and no e-mail; producer cap → one admin notice per producer per day.
 *   (n) no-JS form (POST /kategori/gardssalg/book/:slug), flag on: an
 *       identical second post → 303 to the existing ref's confirm page (no
 *       row, no producer e-mail); over a cap → 303 ?error=cap_<cap> (no row);
 *       GET ?error=cap_producer_per_day renders cap.producerDay with the
 *       producer name.
 *   (s) SQL lookup: lower(trim(guest_email)) matches a stored mixed-case /
 *       padded e-mail at other producers (guest_per_day).
 *   (l) tools/list: book_gardssalg's listing is identical with the flag on
 *       and off (the hashed freeze in tests/fixtures/opplevagent-mcp-
 *       contract-freeze.json pins the full listing in the main gate).
 *
 * Fixtures are test producers in an in-memory experiences DB (example.no
 * addresses); every e-mail send is stubbed. No real data is touched.
 *
 * Standalone: npx tsx src/services/gardssalg-booking-caps.test.ts
 * Gate: tests/test.ts imports runGardssalgBookingCapsTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data line: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

/** A whole UTC hour `days` ahead, plus `minutes`, as an ISO instant. */
function slotAhead(days: number, minutes = 0): string {
  const base = new Date(Date.now() + days * 24 * 3600_000);
  base.setUTCHours(11, 0, 0, 0);
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

export function runGardssalgBookingCapsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
    const setFlag = (v: string | undefined) => {
      if (v === undefined) delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
      else process.env.GARDSSALG_BOOKING_CAP_ENABLED = v;
    };

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-booking-caps"),
      require.resolve("../routes/opplevelser"),
      require.resolve("../routes/experiences-mcp"),
      require.resolve("../routes/experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    let server: http.Server | null = null;
    let followup: typeof import("./gardssalg-booking-followup") | null = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const caps = require("./gardssalg-booking-caps") as typeof import("./gardssalg-booking-caps");
      followup = require("./gardssalg-booking-followup") as typeof import("./gardssalg-booking-followup");
      const alerts: string[] = [];
      followup.__setBookingNotifyAlertForTesting(async (subject) => { alerts.push(subject); return true; });

      // ── (f) flag parsing ────────────────────────────────────────────────
      for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) {
        setFlag(v);
        assertEq(caps.bookingCapEnabled(), false, `f1: flag ${JSON.stringify(v)} -> off`);
      }
      setFlag("true");
      assertEq(caps.bookingCapEnabled(), true, "f2: flag \"true\" -> on");
      setFlag(undefined);
      assertEq(caps.checkGardssalgBookingGuard({ provider_id: "x", guest_email: "a@b.no", slot_at: slotAhead(5) }), { kind: "ok" }, "f3: flag off -> ok without a lookup");

      // ── (u) pure guard ──────────────────────────────────────────────────
      assertEq(caps.normaliseGuestEmail("  Kari@Example.NO "), "kari@example.no", "u1: e-mail trimmed + lower-cased");
      assertEq([caps.DUPLICATE_WINDOW_MINUTES, caps.MAX_OPEN_PER_GUEST_PER_PRODUCER, caps.MAX_NEW_PER_GUEST_PER_DAY, caps.MAX_NEW_PER_PRODUCER_PER_DAY], [30, 2, 5, 10], "u2: limits");
      const now = new Date();
      const nowIso = now.toISOString();
      const s0 = slotAhead(7);
      const row = (o: Partial<import("./gardssalg-booking-caps").GuardRow>) => ({
        booking_ref: "GARD-X", provider_id: "p1", guest_email: "kari@example.no", slot_at: s0,
        status: "reserved", pre_status: "awaiting_provider", created_at: nowIso, is_test: 0, ...o,
      });
      const req = (slot: string, email = "kari@example.no", provider_id = "p1") => ({ provider_id, guest_email: email, slot_at: slot });
      const ev = caps.evaluateGardssalgBookingGuard;
      assertEq(ev(req(s0), [row({})], now), { kind: "duplicate", booking_ref: "GARD-X" }, "u3: same producer + e-mail + slot -> duplicate");
      assertEq(ev(req(s0, " KARI@example.NO"), [row({ guest_email: "Kari@Example.no " })], now).kind, "duplicate", "u4: normalised e-mail on both sides matches");
      assertEq(ev(req(slotAhead(7, 30)), [row({})], now).kind, "duplicate", "u5: +30 min is inside the window");
      assertEq(ev(req(slotAhead(7, -30)), [row({})], now).kind, "duplicate", "u5b: -30 min is inside the window");
      assertEq(ev(req(slotAhead(7, 31)), [row({})], now).kind, "ok", "u6: +31 min is outside the window");
      assertEq(ev(req(s0, "kari@example.no", "p2"), [row({})], now).kind, "ok", "u7: another producer is not a duplicate");
      assertEq(ev(req(s0, "ola@example.no"), [row({})], now).kind, "ok", "u8: another guest is not a duplicate");
      for (const pre of ["provider_declined", "expired"]) {
        assertEq(ev(req(s0), [row({ pre_status: pre })], now).kind, "ok", `u9: ${pre} is not open -> not a duplicate`);
      }
      assertEq(ev(req(s0), [row({ status: "cancelled" })], now).kind, "ok", "u9b: cancelled is not open");
      assertEq(ev(req(s0), [row({ pre_status: "provider_confirmed" })], now).kind, "duplicate", "u9c: a confirmed, upcoming visit is open");
      assertEq(ev(req(s0), [row({ is_test: 1 })], now).kind, "ok", "u9d: an admin test row is never counted");
      assertTrue(!caps.isOpenRequest({ status: "reserved", pre_status: null, slot_at: "2020-01-01T10:00:00.000Z" }, now), "u9e: a passed visit time is not open");
      assertTrue(caps.isOpenRequest({ status: "reserved", pre_status: null, slot_at: s0 }, now), "u9f: legacy NULL pre_status counts as awaiting_provider");
      const two = [row({ booking_ref: "A", slot_at: slotAhead(8) }), row({ booking_ref: "B", slot_at: slotAhead(9) })];
      assertEq(ev(req(slotAhead(10)), two, now), { kind: "cap_reached", cap: "open_per_guest_producer", limit: 2 }, "u10: third open request with one producer -> cap");
      assertEq(ev(req(slotAhead(9)), two, now), { kind: "duplicate", booking_ref: "B" }, "u11: duplicate wins over a cap (the retry gets its ref back)");
      const twoConfirmed = two.map((r) => ({ ...r, pre_status: "provider_confirmed" }));
      assertEq(ev(req(slotAhead(10)), twoConfirmed, now).kind, "ok", "u11b: confirmed upcoming visits are not 'waiting for a reply' -> no open cap");
      const twoSuggested = two.map((r) => ({ ...r, pre_status: "time_suggested" }));
      assertEq(ev(req(slotAhead(10)), twoSuggested, now).kind, "cap_reached", "u11c: time_suggested requests still wait for a reply -> open cap");
      assertEq(ev(req(slotAhead(10)), [two[0], twoConfirmed[1]], now).kind, "ok", "u11d: one pending + one confirmed -> under the open cap");
      const five = [1, 2, 3, 4, 5].map((i) => row({ booking_ref: `G${i}`, provider_id: `px${i}`, slot_at: slotAhead(10 + i) }));
      assertEq(ev(req(slotAhead(20)), five, now), { kind: "cap_reached", cap: "guest_per_day", limit: 5 }, "u12: sixth request in 24 h across producers -> cap");
      const fiveOld = five.map((r) => ({ ...r, created_at: new Date(now.getTime() - 25 * 3600_000).toISOString() }));
      assertEq(ev(req(slotAhead(20)), fiveOld, now).kind, "ok", "u13: requests older than 24 h do not count");
      const fiveSqlite = five.map((r) => ({ ...r, created_at: nowIso.slice(0, 19).replace("T", " ") }));
      assertEq(ev(req(slotAhead(20)), fiveSqlite, now).kind, "cap_reached", "u14: sqlite datetime('now') created_at is read as UTC");
      const ten = Array.from({ length: 10 }, (_, i) => row({ booking_ref: `P${i}`, guest_email: `g${i}@example.no`, slot_at: slotAhead(10 + i) }));
      assertEq(ev(req(slotAhead(30)), ten, now), { kind: "cap_reached", cap: "producer_per_day", limit: 10 }, "u15: eleventh request to one producer in 24 h -> cap");

      // ── (t) text pack OA-1 §2, verbatim (approved by Daniel 2026-11-15) ─
      // Do not "fix" these here: a mismatch means the code drifted.
      const OA1_S2: Record<string, { no: string; en: string }> = {
        "dup.message": {
          no: "Du har allerede sendt denne forespørselen. Referansen er {ref}. Vi har ikke sendt den på nytt.",
          en: "You have already sent this request. The reference is {ref}. We have not sent it again.",
        },
        "cap.guestOpen": {
          no: "Du har allerede forespørsler hos {produsent} som venter på svar. Vent til produsenten har svart, eller trekk en av dem, før du sender en ny.",
          en: "You already have requests waiting for a reply from {produsent}. Please wait for the producer to reply, or withdraw one of them, before sending a new one.",
        },
        "cap.guestDay": {
          no: "Du har sendt mange forespørsler i dag. Prøv igjen i morgen, eller skriv til oss hvis du planlegger et større opplegg.",
          en: "You have sent many requests today. Please try again tomorrow, or write to us if you are planning something larger.",
        },
        "cap.producerDay": {
          no: "{produsent} har fått mange forespørsler i dag og kan ikke ta imot flere akkurat nå. Prøv igjen i morgen.",
          en: "{produsent} has received many requests today and cannot take more right now. Please try again tomorrow.",
        },
      };
      assertEq(Object.keys(caps.BOOKING_CAP_TEXTS).sort(), Object.keys(OA1_S2).sort(), "t1: exactly the OA-1 §2 keys (no capLead)");
      for (const [key, exp] of Object.entries(OA1_S2)) {
        const got = (caps.BOOKING_CAP_TEXTS as Record<string, { no: string; en: string }>)[key];
        assertTrue(Buffer.from(got?.no ?? "", "utf8").equals(Buffer.from(exp.no, "utf8")), `t2: ${key} (no) byte-equal`);
        assertTrue(Buffer.from(got?.en ?? "", "utf8").equals(Buffer.from(exp.en, "utf8")), `t3: ${key} (en) byte-equal`);
      }
      assertEq(caps.CAP_TEXT_KEY, { open_per_guest_producer: "cap.guestOpen", guest_per_day: "cap.guestDay", producer_per_day: "cap.producerDay" }, "t4: cap -> text key");
      assertEq(caps.duplicateMessage("GARD-1", "no"), "Du har allerede sendt denne forespørselen. Referansen er GARD-1. Vi har ikke sendt den på nytt.", "t5: dup.message filled (no)");
      assertEq(caps.capReachedMessage("producer_per_day", "en", "Testsideri AS"), "Testsideri AS has received many requests today and cannot take more right now. Please try again tomorrow.", "t6: {produsent} filled with the producer name");
      assertEq(caps.capReachedMessage("open_per_guest_producer", "no", "Testsideri AS"), "Du har allerede forespørsler hos Testsideri AS som venter på svar. Vent til produsenten har svart, eller trekk en av dem, før du sender en ny.", "t7: cap.guestOpen filled (no)");
      assertEq(caps.capReachedMessage("producer_per_day", "no", null), "Produsenten har fått mange forespørsler i dag og kan ikke ta imot flere akkurat nå. Prøv igjen i morgen.", "t8: no name on file -> neutral noun, capitalised");
      const allTexts = [
        caps.duplicateMessage("GARD-1", "no"), caps.duplicateMessage("GARD-1", "en"),
        ...(["open_per_guest_producer", "guest_per_day", "producer_per_day"] as const).flatMap((c) => [caps.capReachedMessage(c, "no", "X"), caps.capReachedMessage(c, "en", "X")]),
      ];
      assertTrue(allTexts.every((t) => !/gratis|bekreftet|\{produsent\}|\{ref\}/i.test(t)), "u16: texts filled, no 'gratis'/'bekreftet'");

      // ── fixtures ────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', 'Vestland', 'Voss', 'sideri', @epost, 1, 0,
            @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const producers = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
      for (const id of producers) {
        insertProvider.run({ id: `cap-${id}`, navn: `Captest ${id} AS`, epost: `post@cap-${id}.example.no`, slug: `cap-test-${id}` });
      }
      const rows = (provider?: string): number =>
        provider
          ? (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = ?").get(provider) as { n: number }).n
          : (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;

      const sends: Array<{ to: string; subject: string }> = [];
      emailSvc.sendEmail = async (o: any) => {
        sends.push({ to: o.to, subject: o.subject || "" });
        return { success: true, messageId: "stub" };
      };
      const sentTo = (to: string) => sends.filter((s) => s.to === to).length;
      const settle = () => new Promise((r) => setTimeout(r, 30));

      const mcpRouter = (require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use("/api/opplevelser", (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any);
      // The seo router (no-JS booking form) only sees /kategori/… so /mcp stays with the MCP router.
      const seoRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;
      app.use((rq: express.Request, rs: express.Response, next: express.NextFunction) =>
        rq.path.startsWith("/kategori/") ? seoRouter(rq, rs, next) : next());
      app.use((rq: express.Request, rs: express.Response, next: express.NextFunction) => (mcpRouter as any)(rq, rs, next));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const book = async (provider: string, email: string, slot: string) => {
        const r = await fetch(`${base}/api/opplevelser/book`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider_id: `cap-${provider}`, slot_at: slot, party_size: 2, guest_name: "Kari Test", guest_email: email }),
        });
        const body: any = await r.json();
        await settle();
        return { status: r.status, body };
      };

      const initRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "booking-caps-test-client", version: "1.0.0" } } }),
      });
      const sessionId = initRes.headers.get("mcp-session-id");
      await initRes.text();
      const rpc = async (method: string, params: Record<string, unknown>): Promise<any> => {
        const r = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: String(Math.random()) }),
        });
        return parseJsonRpcBody(await r.text(), r.headers.get("content-type"));
      };
      const mcpBook = async (provider: string, email: string, slot: string): Promise<{ parsed: any; isError: boolean }> => {
        const body = await rpc("tools/call", { name: "book_gardssalg", arguments: {
          provider_id: `cap-${provider}`, slot_at: slot, party_size: 2, guest_name: "Kari Test", guest_email: email } });
        await settle();
        return { parsed: JSON.parse(body.result?.content?.[0]?.text ?? "{}"), isError: body.result?.isError === true };
      };
      const bookToolListing = async () => JSON.stringify(((await rpc("tools/list", {})).result?.tools ?? []).find((t: any) => t.name === "book_gardssalg"));

      // ── (l) tools/list unchanged by the flag ────────────────────────────
      setFlag(undefined);
      const listOff = await bookToolListing();
      setFlag("true");
      const listOn = await bookToolListing();
      setFlag(undefined);
      assertTrue(listOff.length > 10 && listOff === listOn, "l1: book_gardssalg tools/list entry is identical with the flag on and off");

      // ── (o) flag off: today's behaviour ─────────────────────────────────
      const sOff = slotAhead(6);
      const o1 = await book("c1", "ola@example.no", sOff);
      const o2 = await book("c1", "ola@example.no", sOff);
      assertEq([o1.status, o2.status], [201, 201], "o1: flag off -> both REST calls 201");
      assertTrue(o1.body.booking_ref !== o2.body.booking_ref && o2.body.duplicate === undefined, "o2: flag off -> two refs, no duplicate field");
      assertEq(rows("cap-c1"), 2, "o3: flag off -> two identical calls create two rows (as today)");
      assertEq(sentTo("post@cap-c1.example.no"), 2, "o4: flag off -> two producer e-mails (as today)");
      const om1 = await mcpBook("c2", "ola@example.no", sOff);
      const om2 = await mcpBook("c2", "ola@example.no", sOff);
      assertTrue(om1.parsed.success === true && om2.parsed.success === true && om2.parsed.duplicate === undefined, "o5: flag off -> MCP both success, no duplicate field");
      assertEq(rows("cap-c2"), 2, "o6: flag off -> two identical MCP calls create two rows");
      db.prepare("DELETE FROM gardssalg_bookings").run();
      sends.length = 0;

      // ── (a) AK1, flag on: duplicate guard ───────────────────────────────
      setFlag("true");
      const sOn = slotAhead(6);
      const a1 = await book("c1", "kari@example.no", sOn);
      const a2 = await book("c1", "KARI@Example.no", slotAhead(6, 20)); // padding is rejected by the schema; case is the live variant
      assertEq(a1.status, 201, "a1: first REST call created (201)");
      assertEq(a2.status, 200, "a2: duplicate -> 200, nothing created");
      assertEq(a2.body.duplicate, true, "a3: duplicate:true");
      assertEq(a2.body.booking_ref, a1.body.booking_ref, "a4: the existing ref is returned");
      assertEq(a2.body.success, true, "a4b: success:true (the request exists)");
      assertEq(a2.body.message, `Du har allerede sendt denne forespørselen. Referansen er ${a1.body.booking_ref}. Vi har ikke sendt den på nytt.`, "a4c: NO message (dup.message)");
      assertTrue(typeof a2.body.message_en === "string" && a2.body.message_en.includes(a1.body.booking_ref), "a4d: EN message carries the ref");
      assertEq(rows("cap-c1"), 1, "a5: AK1 one row (normalised e-mail matched)");
      assertEq(sentTo("post@cap-c1.example.no"), 1, "a6: AK1 one producer e-mail");
      assertEq(sends.filter((s) => s.to.toLowerCase().includes("kari@example.no")).length, 1, "a7: one guest e-mail");
      const a3 = await book("c1", "kari@example.no", slotAhead(6, 31));
      assertEq(a3.status, 201, "a8: +31 min with the same producer is a new request");
      assertEq(rows("cap-c1"), 2, "a9: …and a new row");

      const m1 = await mcpBook("c2", "kari@example.no", sOn);
      const m2 = await mcpBook("c2", "kari@example.no", sOn);
      assertEq(m1.parsed.success, true, "a10: MCP first call created");
      assertEq([m2.parsed.duplicate, m2.parsed.booking_ref, m2.parsed.pending, m2.isError], [true, m1.parsed.booking_ref, true, false], "a11: MCP second call -> duplicate:true + existing ref, not an error");
      assertTrue(typeof m2.parsed.message === "string" && m2.parsed.message.includes(" / You have already sent this request."), "a12: MCP message NO / EN");
      assertEq(rows("cap-c2"), 1, "a13: MCP AK1 one row");
      assertEq(sentTo("post@cap-c2.example.no"), 1, "a14: MCP AK1 one producer e-mail");

      // ── (c) AK2: caps ───────────────────────────────────────────────────
      // open per guest per producer: kari has 2 open with c1 (a1, a3).
      let before = rows();
      let mailsBefore = sends.length;
      const c1 = await book("c1", "kari@example.no", slotAhead(12));
      assertEq([c1.status, c1.body.success, c1.body.cap_reached, c1.body.cap, c1.body.limit], [200, false, true, "open_per_guest_producer", 2], "c1: third open request with one producer -> cap_reached");
      assertEq(c1.body.message, "Du har allerede forespørsler hos Captest c1 AS som venter på svar. Vent til produsenten har svart, eller trekk en av dem, før du sender en ny.", "c1b: NO message (cap.guestOpen, producer name)");
      assertEq([rows(), sends.length], [before, mailsBefore], "c2: no row, no e-mail");
      // After a decline, the slot frees up.
      db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_declined' WHERE booking_ref = ?").run(a3.body.booking_ref);
      const c3 = await book("c1", "kari@example.no", slotAhead(12));
      assertEq(c3.status, 201, "c3: a declined request is no longer open -> new request allowed");

      // guest per day: kari has 4 rows today (a1, a3, c3 at c1; m1 at c2).
      const c4 = await book("c3", "kari@example.no", slotAhead(13));
      assertEq(c4.status, 201, "c4: fifth request in 24 h is allowed");
      before = rows(); mailsBefore = sends.length;
      const c5 = await book("c4", "kari@example.no", slotAhead(14));
      assertEq([c5.body.cap_reached, c5.body.cap, c5.body.limit], [true, "guest_per_day", 5], "c5: sixth request in 24 h -> guest_per_day");
      assertEq([rows(), sends.length], [before, mailsBefore], "c6: no row, no e-mail");
      const cm = await mcpBook("c4", "kari@example.no", slotAhead(14));
      assertEq([cm.parsed.success, cm.parsed.cap_reached, cm.parsed.reason, cm.parsed.cap, cm.isError], [false, true, "cap_reached", "guest_per_day", false], "c7: MCP returns cap_reached as a normal result");
      assertTrue(typeof cm.parsed.message === "string" && cm.parsed.message.includes(" / You have sent many requests today."), "c7b: MCP message NO / EN");
      assertEq(rows(), before, "c8: MCP cap -> no row");

      // producer per day: 10 guests to c5, then the 11th and 12th.
      for (let i = 0; i < 10; i++) await book("c5", `gjest${i}@example.no`, slotAhead(15, i * 60));
      assertEq(rows("cap-c5"), 10, "c9: ten requests to one producer are allowed");
      alerts.length = 0;
      before = rows(); mailsBefore = sends.length;
      const c10 = await book("c5", "gjest10@example.no", slotAhead(20));
      assertEq([c10.body.cap_reached, c10.body.cap, c10.body.limit], [true, "producer_per_day", 10], "c10: eleventh -> producer_per_day");
      assertEq(c10.body.message_en, "Captest c5 AS has received many requests today and cannot take more right now. Please try again tomorrow.", "c10b: EN message (cap.producerDay, producer name)");
      await settle();
      assertEq(alerts.length, 1, "c11: one admin notice");
      assertTrue(alerts[0]?.includes("cap-c5") === true, "c11b: …naming the producer");
      const c12 = await book("c5", "gjest11@example.no", slotAhead(21));
      await settle();
      assertEq([c12.body.cap, alerts.length], ["producer_per_day", 1], "c12: still capped, no second notice the same day");
      assertEq([rows(), sends.length], [before, mailsBefore], "c13: no row, no e-mail over the producer cap");

      // ── (n) no-JS form, flag on ────────────────────────────────────────
      const postForm = async (provider: string, email: string, slot: string) => {
        const r = await fetch(`${base}/kategori/gardssalg/book/cap-test-${provider}`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ slot_at: slot, party_size: "2", guest_name: "Kari Test", guest_email: email }).toString(),
          redirect: "manual",
        });
        await r.text();
        await settle();
        return { status: r.status, location: r.headers.get("location") || "" };
      };
      const formBack = "/kategori/gardssalg/book/cap-test-c6";
      const sForm = slotAhead(8);
      const n1 = await postForm("c6", "skjema@example.no", sForm);
      const n1Ref = decodeURIComponent(n1.location.split("/confirm/")[1] || "");
      assertTrue(n1.status === 303 && n1Ref.startsWith("GARD") && rows("cap-c6") === 1, "n1: first form post -> 303 to its confirm page, one row");
      before = rows(); mailsBefore = sentTo("post@cap-c6.example.no");
      const n2 = await postForm("c6", "skjema@example.no", sForm);
      assertEq([n2.status, n2.location], [303, `${formBack}/confirm/${encodeURIComponent(n1Ref)}`], "n2: identical form post -> 303 to the existing ref's confirm page");
      assertEq([rows(), sentTo("post@cap-c6.example.no")], [before, mailsBefore], "n3: duplicate form post -> no row, no producer e-mail");
      const n4 = await postForm("c6", "skjema@example.no", slotAhead(9));
      assertEq(n4.status, 303, "n4: second open request via the form is allowed");
      before = rows(); mailsBefore = sends.length;
      const n5 = await postForm("c6", "skjema@example.no", slotAhead(10));
      assertEq([n5.status, n5.location], [303, `${formBack}?error=cap_open_per_guest_producer`], "n5: over the open cap -> 303 ?error=cap_open_per_guest_producer");
      assertEq([rows(), sends.length], [before, mailsBefore], "n6: form cap -> no row, no e-mail");
      const panel = await (await fetch(`${base}${formBack}?error=cap_producer_per_day`)).text();
      assertTrue(panel.includes("Captest c6 AS har fått mange forespørsler i dag og kan ikke ta imot flere akkurat nå. Prøv igjen i morgen."), "n7: GET ?error=cap_producer_per_day renders cap.producerDay with the producer name");

      // ── (s) SQL normalisation: stored mixed-case / padded e-mail ────────
      const insBooking = db.prepare(
        `INSERT INTO gardssalg_bookings (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, booking_ref, confirm_token)
         VALUES (?, ?, ?, 2, 'Mixed Test', ?, ?, ?)`,
      );
      ["c1", "c2", "c3", "c4", "c7"].forEach((p, i) =>
        insBooking.run(`mx-id-${i}`, `cap-${p}`, slotAhead(25 + i), "  MiXed@Example.NO ", `GARD-MX${i}`, `mx-tok-${i}`));
      assertEq(caps.checkGardssalgBookingGuard({ provider_id: "cap-c8", guest_email: "mixed@example.no", slot_at: slotAhead(31) }),
        { kind: "cap_reached", cap: "guest_per_day", limit: 5 }, "s1: SQL lower(trim(guest_email)) finds the guest's rows at other producers");
      insBooking.run("mx-id-dup", "cap-c8", slotAhead(32), " MIXED@example.no", "GARD-MXD", "mx-tok-dup");
      assertEq(caps.checkGardssalgBookingGuard({ provider_id: "cap-c8", guest_email: "Mixed@Example.no", slot_at: slotAhead(32, 10) }),
        { kind: "duplicate", booking_ref: "GARD-MXD" }, "s2: padded / mixed-case stored e-mail is the same guest (duplicate)");
      db.prepare("DELETE FROM gardssalg_bookings WHERE booking_id LIKE 'mx-id-%'").run();

      // flag off again → caps gone (behaviour exactly as today).
      setFlag(undefined);
      const c14 = await book("c5", "gjest12@example.no", slotAhead(22));
      assertEq(c14.status, 201, "c14: flag off -> no cap");
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      try { followup?.__setBookingNotifyAlertForTesting(null); } catch { /* best-effort */ }
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgBookingCapsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
