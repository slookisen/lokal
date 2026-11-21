/**
 * opplevelser-gardssalg-mcp-cancel-tool-o5-3.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-3.
 *
 * cancel_gardssalg_booking behind GARDSSALG_MCP_CANCEL_TOOL_ENABLED (off),
 * registered only when O1-5's GARDSSALG_CANCEL_ENABLED is on as well:
 *
 *   (ak1)  flag off: tools/list byte-identical (same golden as O5-1/O5-2) and
 *          a call is an unknown tool (nothing written, nothing sent).
 *   (flag) strict: "1", "false", "TRUE" do not enable it; nor does the tool
 *          flag alone with GARDSSALG_CANCEL_ENABLED off.
 *   (ak2)  flag on: listed last with the OA-2 C5 texts and destructive,
 *          idempotent annotations; a call withdraws/cancels the test booking
 *          through O1-5 (status, reason, time), the producer gets the receipt
 *          exactly once, and a second call answers cancel.already (the same
 *          answer every time after) without a new e-mail.
 *   (np)   declined / expired / attended / no-show / past visit: cancel.notPossible
 *          with the status word, nothing written, nothing sent.
 *   (ak3)  wrong guest_ref / wrong reference: get_gardssalg_booking's
 *          not-found answer, no data, no state change, no e-mail.
 *   (log)  no guest_ref, guest data or reason in log lines.
 *   (rl)   the cancel quota: call max+1 gets the JSON-RPC 429.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-cancel-tool-o5-3.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same golden as the O5-1 and O5-2 suites: tools/list before O5-1 (unchanged since).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";

// OA-2 §C5, copied verbatim from the approved text package.
const OA2_TITLE = "Cancel a visit request or a confirmed visit";
const OA2_SHORT_TITLE = "Cancel visit request";
const OA2_DESCRIPTION = "Use this when the guest wants to cancel a visit request or a confirmed visit made with book_gardssalg. It needs the reference and the guest_ref that book_gardssalg returned, and takes an optional reason that is passed on to the producer. The producer is told by email. A cancellation cannot be undone; the guest can send a new request afterwards. Cancelling a request that is already cancelled returns the same answer and sends nothing.";
const OA2_OK = "Avlyst. {produsent} har fått beskjed. Referanse: {ref}. / Cancelled. {produsent} has been told. Reference: {ref}.";
const OA2_OK_PENDING = "Forespørselen er trukket. {produsent} har fått beskjed. Referanse: {ref}. / The request is withdrawn. {produsent} has been told. Reference: {ref}.";
const OA2_ALREADY = "Forespørselen er allerede avlyst eller trukket. Ingenting er sendt på nytt. / The request is already cancelled or withdrawn. Nothing was sent again.";
const OA2_NOT_POSSIBLE = "Forespørselen kan ikke avlyses, fordi den er {status}. / The request cannot be cancelled because it is {status}.";
const OA2_NOT_FOUND = "Finner ikke forespørselen. Sjekk referansen, eller åpne statuslenken i e-posten. / The request was not found. Check the reference, or open the status link in the email.";
const PRODUCER = "Avlysgard Sideri";
const PRODUCER_EMAIL = "post@avlysgard.example.no";

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body");
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function futureSlot(daysAhead: number, hour = 11): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string): number => +(parts.find((p) => p.type === t)?.value ?? "0");
  const b = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + daysAhead));
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}T${pad2(hour)}:00`;
}

export function runOpplevelserGardssalgMcpCancelToolTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const assertTrue = (cond: boolean, label: string): void => assertEq(cond, true, label);

  return (async () => {
    const envKeys = [
      "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED", "GARDSSALG_MCP_STATUS_TOOL_ENABLED",
      "GARDSSALG_MCP_CANCEL_TOOL_ENABLED", "GARDSSALG_CANCEL_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED",
    ];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    for (const k of envKeys.slice(2)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-honest-receipt"),
      require.resolve("../services/gardssalg-cancel"),
      require.resolve("./experiences-mcp"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const origConsole = methods.map((m) => console[m]);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const cancel = require("../services/gardssalg-cancel") as typeof import("../services/gardssalg-cancel");
      const mcpMod = require("./experiences-mcp") as typeof import("./experiences-mcp");

      const sent: Array<{ to: string; subject: string; text: string }> = [];
      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (m: any) => {
        sent.push({ to: String(m?.to), subject: String(m?.subject), text: String(m?.textContent ?? "") });
        return { success: true, messageId: "test" };
      };
      // Producer mails about `ref` sent from index `from` on (the booking's own notice comes before).
      const producerMails = (ref: string, from: number) => sent.slice(from).filter((m) => m.to === PRODUCER_EMAIL && m.subject.includes(ref));

      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES ('av-gard', ?, 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', 1,
                 ?, 'avlysgard-sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run(PRODUCER, PRODUCER_EMAIL);

      const app = express();
      // Each block sends its own X-Forwarded-For address (198.18.0.0/15, no
      // other suite uses it), so the per-IP quotas start empty per block.
      app.set("trust proxy", true);
      app.use(express.json());
      app.use("/mcp", mcpMod.default as any);
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      let clientIp = "198.18.0.1";
      const useIp = (n: number): void => { clientIp = `198.18.0.${n}`; };
      // node:http, not the global fetch: other suites in the gate stub it.
      function request(headers: Record<string, string>, payload: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(payload);
          const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...headers, "X-Forwarded-For": clientIp, "Content-Length": String(Buffer.byteLength(data)) } }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(data);
        });
      }
      const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      async function mcpRaw(method: string, params: unknown): Promise<{ status: number; text: string; body: any }> {
        const init = await request(h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request({ ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return { status: res.status, text: res.text, body: res.status === 429 ? JSON.parse(res.text) : parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null) };
      }
      const cancelCall = async (args: Record<string, unknown>): Promise<string> => {
        const r = await mcpRaw("tools/call", { name: "cancel_gardssalg_booking", arguments: args });
        return String(r.body.result?.content?.[0]?.text ?? JSON.stringify(r.body));
      };
      let day = 30;
      const book = async (guestName: string, guestEmail: string): Promise<{ ref: string; gref: string }> => {
        process.env.GARDSSALG_MCP_GUEST_REF_ENABLED = "true";
        try {
          const r = await mcpRaw("tools/call", { name: "book_gardssalg", arguments: { provider_id: "av-gard", slot_at: futureSlot(day++), party_size: 2, guest_name: guestName, guest_email: guestEmail } });
          const b = JSON.parse(String(r.body.result?.content?.[0]?.text ?? "{}"));
          return { ref: String(b.booking_ref), gref: String(b.guest_ref ?? "") };
        } finally {
          delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
        }
      };
      const row = (ref: string): any => store.getBookingByRef(ref);
      const snapshot = (ref: string): string => JSON.stringify(db.prepare("SELECT * FROM gardssalg_bookings WHERE booking_ref = ?").get(ref));
      const listNames = async (): Promise<string[]> => ((await mcpRaw("tools/list", {})).body.result.tools as any[]).map((t) => t.name);
      const fill = (t: string, v: Record<string, string>): string => Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(x), t);

      // ── (ak1) flag off ──────────────────────────────────────────────────
      const listOff = JSON.stringify((await mcpRaw("tools/list", {})).body.result);
      assertEq(createHash("sha256").update(listOff).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "ak1: flag off: tools/list equals the golden (byte-identical)");
      assertTrue(!listOff.includes("cancel_gardssalg_booking"), "ak1b: flag off: the tool is not listed");

      const b1 = await book("Kari Avlys", "kari.avlys@example.no");
      assertTrue(/^[A-Za-z0-9_-]{32}$/.test(b1.gref), "setup: book_gardssalg (O5-1 flag on) returned a guest_ref");
      const sentBefore = sent.length;
      const before1 = snapshot(b1.ref);
      const offCall = await cancelCall({ booking_ref: b1.ref, guest_ref: b1.gref });
      assertTrue(/not found/i.test(offCall) && /cancel_gardssalg_booking/.test(offCall), "ak1c: flag off: a call is an unknown tool");
      assertTrue(!offCall.includes(b1.ref) && !offCall.includes(PRODUCER), "ak1d: flag off: the answer has no booking data");
      assertEq([snapshot(b1.ref), sent.length], [before1, sentBefore], "ak1e: flag off: nothing written, nothing sent");

      // ── (flag) strict reading ───────────────────────────────────────────
      process.env.GARDSSALG_CANCEL_ENABLED = "true";
      for (const v of ["1", "false", "TRUE", "yes", " true"]) {
        process.env.GARDSSALG_MCP_CANCEL_TOOL_ENABLED = v;
        assertTrue(!(await listNames()).includes("cancel_gardssalg_booking"), `flag: GARDSSALG_MCP_CANCEL_TOOL_ENABLED=${JSON.stringify(v)} does not enable the tool`);
      }
      process.env.GARDSSALG_MCP_CANCEL_TOOL_ENABLED = "true";
      for (const v of [undefined, "1", "false"]) {
        if (v === undefined) delete process.env.GARDSSALG_CANCEL_ENABLED; else process.env.GARDSSALG_CANCEL_ENABLED = v;
        assertTrue(!(await listNames()).includes("cancel_gardssalg_booking"), `flag: tool flag on but GARDSSALG_CANCEL_ENABLED=${JSON.stringify(v ?? null)} -> not listed (O1-5 is the cancellation)`);
      }
      assertEq(createHash("sha256").update(JSON.stringify((await mcpRaw("tools/list", {})).body.result)).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "flag: tool flag alone leaves tools/list byte-identical");

      // ── (ak2) flag on ───────────────────────────────────────────────────
      process.env.GARDSSALG_CANCEL_ENABLED = "true";
      const listOn = JSON.parse(JSON.stringify((await mcpRaw("tools/list", {})).body.result));
      const tool = listOn.tools.find((t: any) => t.name === "cancel_gardssalg_booking");
      assertEq(listOn.tools[listOn.tools.length - 1]?.name, "cancel_gardssalg_booking", "ak2: flag on: the tool is listed, last");
      assertEq(JSON.stringify({ ...listOn, tools: listOn.tools.filter((t: any) => t.name !== "cancel_gardssalg_booking") }), listOff, "ak2b: every other tool unchanged");
      assertEq([tool?.title, tool?.description, tool?.annotations], [
        OA2_TITLE, OA2_DESCRIPTION,
        { title: OA2_SHORT_TITLE, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ], "ak2c: title, description (OA-2 C5 verbatim) and destructive, idempotent annotations");
      assertEq(Object.keys(tool?.inputSchema?.properties ?? {}), ["booking_ref", "guest_ref", "reason"], "ak2d: input is booking_ref + guest_ref + optional reason");
      assertEq([...(tool?.inputSchema?.required ?? [])].sort(), ["booking_ref", "guest_ref"], "ak2e: reason is optional");
      assertEq(tool?.inputSchema?.properties?.reason?.maxLength, cancel.CANCEL_REASON_MAX, "ak2f: reason is bounded by O1-5's CANCEL_REASON_MAX");
      assertTrue(!/tasting|smaking|øl|cider|vin\b|pris|price|kr\b/i.test(JSON.stringify(tool)), "ak2g: the definition names no drink, product or price");
      assertTrue(mcpMod.GARDSSALG_CANCEL_TOOLS.has("cancel_gardssalg_booking") && !mcpMod.EXPERIENCES_MCP_SIDE_EFFECT_TOOLS.has("cancel_gardssalg_booking") && !mcpMod.GARDSSALG_STATUS_LOOKUP_TOOLS.has("cancel_gardssalg_booking"), "ak2h: the tool is metered by its own bucket");
      if (log) console.log("  cancel_gardssalg_booking definition:\n" + JSON.stringify(tool, null, 2));

      const logged: string[] = [];
      for (const m of methods) (console as any)[m] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : String((x as any)?.stack ?? JSON.stringify(x)))).join(" ")); };

      useIp(2);
      // Pending request -> withdrawn, producer told once.
      const reason = "Bilen streiket, beklager";
      const sentA = sent.length;
      const first = await cancelCall({ booking_ref: b1.ref, guest_ref: b1.gref, reason });
      assertEq(JSON.parse(first), {
        found: true, booking_ref: b1.ref, cancelled: true, result: "withdrawn",
        message: fill(OA2_OK_PENDING, { produsent: PRODUCER, ref: b1.ref }),
      }, "ak2i: pending request -> withdrawn (OA-2 cancel.okPending)");
      const r1 = row(b1.ref);
      const info1 = cancel.getCancelInfo(r1.booking_id)!;
      assertEq([r1.status, r1.pre_status, info1.cancelled_by, info1.cancel_reason, !!info1.cancelled_at], ["cancelled", "awaiting_provider", "guest", reason, true], "ak2j: written through O1-5: status cancelled by the guest, reason and time stored");
      assertEq(producerMails(b1.ref, sentA).length, 1, "ak2k: the producer gets the receipt exactly once");
      assertEq(sent.length - sentA, 1, "ak2l: and nothing else is sent");
      assertTrue(producerMails(b1.ref, sentA)[0].text.includes(reason), "ak2m: the reason is passed on to the producer");
      assertEq(producerMails(b1.ref, sentA)[0].subject, cancel.buildGuestCancelProducerEmail(r1, "withdraw", reason).subject, "ak2n: O1-5's withdraw e-mail");
      assertTrue(!/kari|example\.no/i.test(first), "ak2o: no guest personal data in the result");

      const snapAfter = snapshot(b1.ref);
      const second = await cancelCall({ booking_ref: b1.ref, guest_ref: b1.gref, reason: "igjen" });
      const third = await cancelCall({ booking_ref: b1.ref, guest_ref: b1.gref });
      assertEq(JSON.parse(second), { found: true, booking_ref: b1.ref, cancelled: true, result: "already", message: OA2_ALREADY }, "ak2p: second call -> cancel.already");
      assertEq(third, second, "ak2q: every later call gives the same answer (idempotent)");
      assertEq([producerMails(b1.ref, sentA).length, sent.length - sentA], [1, 1], "ak2r: no new e-mail on the second and third call");
      assertEq(snapshot(b1.ref), snapAfter, "ak2s: the second call writes nothing (reason and time kept)");

      // Confirmed visit -> cancelled.
      const b2 = await book("Per Bekreftet", "per.bekreftet@example.no");
      assertTrue(!!store.producerRespondConfirm(row(b2.ref).respond_token), "setup: producer confirms");
      const sent2 = sent.length;
      const c2 = JSON.parse(await cancelCall({ booking_ref: b2.ref, guest_ref: b2.gref }));
      assertEq(c2, { found: true, booking_ref: b2.ref, cancelled: true, result: "cancelled", message: fill(OA2_OK, { produsent: PRODUCER, ref: b2.ref }) }, "ak2t: confirmed visit -> cancelled (OA-2 cancel.ok)");
      assertEq([row(b2.ref).status, cancel.getCancelInfo(row(b2.ref).booking_id)!.cancel_reason, producerMails(b2.ref, sent2).length], ["cancelled", null, 1], "ak2u: cancelled without a reason, producer told once");
      assertEq(producerMails(b2.ref, sent2)[0].subject, cancel.buildGuestCancelProducerEmail(row(b2.ref), "cancel", "").subject, "ak2v: O1-5's cancel e-mail");

      // New time suggested -> withdrawn.
      const b3 = await book("Lise Forslag", "lise.forslag@example.no");
      assertTrue(!!store.producerSuggestTime(row(b3.ref).respond_token, futureSlot(60, 14)), "setup: producer suggests a new time");
      const sent3 = sent.length;
      const c3 = JSON.parse(await cancelCall({ booking_ref: b3.ref, guest_ref: b3.gref }));
      assertEq([c3.result, c3.message, producerMails(b3.ref, sent3).length], ["withdrawn", fill(OA2_OK_PENDING, { produsent: PRODUCER, ref: b3.ref }), 1], "ak2w: time suggested -> withdrawn, producer told once");

      // get_gardssalg_booking (O5-2) reads the result.
      process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED = "true";
      const st = JSON.parse(String((await mcpRaw("tools/call", { name: "get_gardssalg_booking", arguments: { booking_ref: b2.ref, guest_ref: b2.gref } })).body.result?.content?.[0]?.text));
      delete process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED;
      assertEq(st.status, "cancelledByGuest", "ak2x: get_gardssalg_booking shows the cancellation");

      useIp(3);
      // ── (np) not possible: status word, nothing written or sent ────────
      const npCase = async (label: string, prep: (ref: string) => void, nb: string, en: string): Promise<void> => {
        const b = await book(`Gjest ${label}`, `gjest.${label}@example.no`);
        prep(b.ref);
        const snap = snapshot(b.ref);
        const sentN = sent.length;
        const res = JSON.parse(await cancelCall({ booking_ref: b.ref, guest_ref: b.gref }));
        assertEq(res, { found: true, booking_ref: b.ref, cancelled: false, result: "not_possible", message: fill(OA2_NOT_POSSIBLE.replace("{status}", nb), {}).replace("{status}", en) }, `np.${label}: cancel.notPossible (${nb} / ${en})`);
        assertEq([snapshot(b.ref), sent.length - sentN], [snap, 0], `np.${label}: nothing written, nothing sent`);
      };
      await npCase("declined", (ref) => { store.producerRespondDecline(row(ref).respond_token); }, "avslått", "declined");
      await npCase("expired", (ref) => { db.prepare("UPDATE gardssalg_bookings SET pre_status = 'expired' WHERE booking_ref = ?").run(ref); }, "utløpt", "expired");
      await npCase("attended", (ref) => { db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed', status = 'confirmed_attended' WHERE booking_ref = ?").run(ref); }, "gjennomført", "completed");
      await npCase("past", (ref) => { db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed', slot_at = '2020-01-01T11:00' WHERE booking_ref = ?").run(ref); }, "gjennomført", "completed");
      await npCase("noshow", (ref) => { db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed', status = 'no_show' WHERE booking_ref = ?").run(ref); }, "avsluttet", "closed");

      // Cancelled by the producer -> already, nothing sent.
      const b4 = await book("Ola Produsent", "ola.produsent@example.no");
      store.producerRespondConfirm(row(b4.ref).respond_token);
      assertTrue(cancel.producerCancel(row(b4.ref), "Stengt pga. storm").ok, "setup: producer cancels");
      const sent4 = sent.length;
      const c4 = JSON.parse(await cancelCall({ booking_ref: b4.ref, guest_ref: b4.gref }));
      assertEq([c4.result, c4.message, sent.length - sent4], ["already", OA2_ALREADY, 0], "np.producerCancelled: cancel.already, nothing sent");

      useIp(4);
      // ── (ak3) wrong pair: not-found, no data, no change ────────────────
      const b5 = await book("Nina Annen", "nina.annen@example.no");
      const snap5 = snapshot(b5.ref);
      const sent5 = sent.length;
      const notFound = JSON.stringify({ found: false, message: OA2_NOT_FOUND }, null, 2);
      const flip = b5.gref.slice(0, -1) + (b5.gref.endsWith("A") ? "B" : "A");
      const answers = [
        await cancelCall({ booking_ref: b5.ref, guest_ref: flip }),
        await cancelCall({ booking_ref: "GARD-20990101-ZZZZZ", guest_ref: b5.gref }),
        await cancelCall({ booking_ref: b5.ref, guest_ref: b2.gref }),
        await cancelCall({ booking_ref: b2.ref, guest_ref: b5.gref, reason: "x" }),
        await cancelCall({ booking_ref: b5.ref, guest_ref: "" }),
      ];
      answers.forEach((a, i) => assertEq(a, notFound, `ak3.${i + 1}: wrong pair -> exactly get_gardssalg_booking's not-found answer`));
      assertEq(mcpMod.gardssalgBookingNotFoundPayload(), { found: false, message: OA2_NOT_FOUND }, "ak3b: the one shared not-found payload");
      assertEq([snapshot(b5.ref), row(b5.ref).status, sent.length - sent5], [snap5, "reserved", 0], "ak3c: no state change, no e-mail");
      assertTrue(answers.every((a) => !a.includes(b5.ref) && !a.includes(b2.ref) && !a.includes(PRODUCER) && !a.includes("/status/")), "ak3d: no booking data in the not-found answers");

      // Reason too long: refused by the schema, nothing written.
      const tooLong = await cancelCall({ booking_ref: b5.ref, guest_ref: b5.gref, reason: "x".repeat(cancel.CANCEL_REASON_MAX + 1) });
      assertTrue(!tooLong.includes(b5.ref) && !tooLong.includes(PRODUCER), "ak3e: a too long reason is refused, no booking data");
      assertEq([snapshot(b5.ref), sent.length - sent5], [snap5, 0], "ak3f: a too long reason writes and sends nothing");

      // A session registered with the flags on cancels nothing once a flag is off.
      for (const k of ["GARDSSALG_MCP_CANCEL_TOOL_ENABLED", "GARDSSALG_CANCEL_ENABLED"]) {
        const init = await request(h, { jsonrpc: "2.0", method: "initialize", id: "1", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } } });
        const sid = String(init.headers["mcp-session-id"]);
        delete process.env[k];
        const res = await request({ ...h, "mcp-session-id": sid }, { jsonrpc: "2.0", method: "tools/call", id: "2", params: { name: "cancel_gardssalg_booking", arguments: { booking_ref: b5.ref, guest_ref: b5.gref } } });
        process.env[k] = "true";
        const ct = res.headers["content-type"];
        assertEq(String(parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null).result?.content?.[0]?.text), notFound, `ak3g: ${k} turned off after registration -> not-found, nothing cancelled`);
        assertEq([snapshot(b5.ref), sent.length - sent5], [snap5, 0], `ak3h: ${k} off -> nothing written or sent`);
      }

      for (const m of methods) (console as any)[m] = origConsole[methods.indexOf(m)];
      const grefs = [b1, b2, b3, b4, b5].map((b) => b.gref);
      assertTrue(!logged.some((l) => grefs.some((g) => l.includes(g)) || l.includes(reason) || /kari|per bekreftet|lise|nina|example\.no/i.test(l)), "log: no guest_ref, reason or guest personal data in log lines");

      // ── (rl) the cancel quota ───────────────────────────────────────────
      useIp(5);
      const max = mcpMod.GARDSSALG_CANCEL_LIMIT.max;
      const statuses: number[] = [];
      for (let i = 0; i < max; i++) {
        statuses.push((await mcpRaw("tools/call", { name: "cancel_gardssalg_booking", arguments: { booking_ref: b5.ref, guest_ref: flip } })).status);
      }
      assertEq(statuses, new Array(max).fill(200), `rl1: ${max} cancel calls within a minute are answered`);
      const limited = await mcpRaw("tools/call", { name: "cancel_gardssalg_booking", arguments: { booking_ref: b5.ref, guest_ref: b5.gref } });
      assertEq([limited.status, limited.body], [429, { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: "2" }], `rl2: call ${max + 1} within a minute -> JSON-RPC 429, no data`);
      assertEq([row(b5.ref).status, sent.length - sent5], ["reserved", 0], "rl3: a refused call cancels nothing");
      process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED = "true";
      const lookupAfter = await mcpRaw("tools/call", { name: "get_gardssalg_booking", arguments: { booking_ref: b5.ref, guest_ref: b5.gref } });
      delete process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED;
      assertEq(lookupAfter.status, 200, "rl4: status lookups are not counted against the cancel quota");
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
      methods.forEach((m, i) => { (console as any)[m] = origConsole[i]; });
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      restoreModuleCache();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgMcpCancelToolTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
