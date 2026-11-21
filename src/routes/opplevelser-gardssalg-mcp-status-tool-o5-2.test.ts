/**
 * opplevelser-gardssalg-mcp-status-tool-o5-2.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-2.
 *
 * get_gardssalg_booking behind GARDSSALG_MCP_STATUS_TOOL_ENABLED (off):
 *
 *   (ak1) flag off: tools/list byte-identical (same golden as O5-1).
 *   (ak2) flag on: the tool is in tools/list (read-only, OA-2 C4 texts), and
 *         the right booking_ref + guest_ref give the status of the booking
 *         (pending, suggested with the reply link, confirmed, cancelled).
 *   (ak3) wrong guest_ref / wrong reference: one identical answer, no data.
 *   (n3)  verifyGuestRef hashes also when the row or its hash is missing.
 *   (rl)  the lookup quota: call max+1 gets the JSON-RPC 429.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-status-tool-o5-2.test.ts
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

// Same golden as the O5-1 suite: tools/list before O5-1 (unchanged since).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";

// OA-2 §C4, copied verbatim from the approved text package.
const OA2_DESCRIPTION = "Use this to look up a visit request made with book_gardssalg. It returns the current status (waiting for the producer, confirmed, new time suggested, declined, expired or cancelled), the agreed or suggested time, the reply deadline, the guest's own status page and, when the producer has suggested a new time, the link where the guest replies. It needs the reference and the guest_ref that book_gardssalg returned. It only reads and never changes the request. If the reference and guest_ref do not match a request, it answers that the request was not found.";
const OA2_NOT_FOUND = "Finner ikke forespørselen. Sjekk referansen, eller åpne statuslenken i e-posten. / The request was not found. Check the reference, or open the status link in the email.";

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

export function runOpplevelserGardssalgMcpStatusToolTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED", "GARDSSALG_MCP_STATUS_TOOL_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
    delete process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED;
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;

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
      const receipt = require("../services/gardssalg-honest-receipt") as typeof import("../services/gardssalg-honest-receipt");
      const cancel = require("../services/gardssalg-cancel") as typeof import("../services/gardssalg-cancel");
      const mcpMod = require("./experiences-mcp") as typeof import("./experiences-mcp");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async () => ({ success: true, messageId: "test" });

      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES ('st-gard', 'Statusgard Sideri', 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', 1,
                 'post@statusgard.example.no', 'statusgard-sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();

      const app = express();
      app.use(express.json());
      app.use("/mcp", mcpMod.default as any);
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      // node:http, not the global fetch: other suites in the gate stub it.
      function request(headers: Record<string, string>, payload: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(payload);
          const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...headers, "Content-Length": String(Buffer.byteLength(data)) } }, (res) => {
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
      let lookups = 0; // every get_gardssalg_booking call counts against the quota
      const lookup = async (booking_ref: unknown, guest_ref: unknown): Promise<string> => {
        lookups++;
        const r = await mcpRaw("tools/call", { name: "get_gardssalg_booking", arguments: { booking_ref, guest_ref } });
        return String(r.body.result?.content?.[0]?.text ?? JSON.stringify(r.body));
      };
      const book = async (guestName: string, guestEmail: string): Promise<any> => {
        process.env.GARDSSALG_MCP_GUEST_REF_ENABLED = "true";
        try {
          const r = await mcpRaw("tools/call", { name: "book_gardssalg", arguments: { provider_id: "st-gard", slot_at: futureSlot(30), party_size: 2, guest_name: guestName, guest_email: guestEmail } });
          return JSON.parse(String(r.body.result?.content?.[0]?.text ?? "{}"));
        } finally {
          delete process.env.GARDSSALG_MCP_GUEST_REF_ENABLED;
        }
      };

      // ── (ak1) flag off ──────────────────────────────────────────────────
      const listOff = JSON.stringify((await mcpRaw("tools/list", {})).body.result);
      assertEq(createHash("sha256").update(listOff).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "ak1: flag off: tools/list equals the golden (byte-identical)");
      assertTrue(!listOff.includes("get_gardssalg_booking"), "ak1b: flag off: the tool is not listed");

      const b1 = await book("Kari Status", "kari.status@example.no");
      const ref1 = String(b1.booking_ref);
      const gref1 = String(b1.guest_ref ?? "");
      assertTrue(/^[A-Za-z0-9_-]{32}$/.test(gref1), "setup: book_gardssalg (O5-1 flag on) returned a guest_ref");
      const offCall = await lookup(ref1, gref1);
      assertTrue(!offCall.includes(ref1) && !offCall.includes("Statusgard"), "ak1c: flag off: a call gives no booking data");

      // ── (ak2) flag on ───────────────────────────────────────────────────
      process.env.GARDSSALG_MCP_STATUS_TOOL_ENABLED = "true";
      const listOn = JSON.parse(JSON.stringify((await mcpRaw("tools/list", {})).body.result));
      const tool = listOn.tools.find((t: any) => t.name === "get_gardssalg_booking");
      assertEq(listOn.tools[listOn.tools.length - 1]?.name, "get_gardssalg_booking", "ak2: flag on: the tool is listed, last");
      assertEq(JSON.stringify({ ...listOn, tools: listOn.tools.filter((t: any) => t.name !== "get_gardssalg_booking") }), listOff, "ak2b: every other tool unchanged");
      assertEq([tool?.title, tool?.description, tool?.annotations], [
        "Check the status of a visit request", OA2_DESCRIPTION,
        { title: "Get visit request status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ], "ak2c: title, description (OA-2 C4 verbatim) and read-only annotations");
      assertEq(Object.keys(tool?.inputSchema?.properties ?? {}).sort(), ["booking_ref", "guest_ref"], "ak2d: input is booking_ref + guest_ref");
      assertTrue(!/tasting|smaking|øl|cider|vin\b|pris|price|kr\b/i.test(JSON.stringify(tool)), "ak2e: the definition names no drink, product or price");
      if (log) console.log("  get_gardssalg_booking definition:\n" + JSON.stringify(tool, null, 2));

      const row = (): any => store.getBookingByRef(ref1);
      const nb = (iso: string | null) => receipt.formatOsloInstant(iso, "nb");
      const en = (iso: string | null) => receipt.formatOsloInstant(iso, "en");
      const slotIso = (s: string) => store.osloDatetimeLocalToUtcIso(s) ?? s;

      const logged: string[] = [];
      for (const m of methods) (console as any)[m] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : String((x as any)?.stack ?? JSON.stringify(x)))).join(" ")); };

      const pending = JSON.parse(await lookup(ref1, gref1));
      const frist = row().respond_token_expires_at;
      assertEq(pending, {
        found: true, booking_ref: ref1, status: "pending",
        message: `Venter på svar fra Statusgard Sideri. Svarfrist: ${nb(frist)}. / Waiting for a reply from Statusgard Sideri. Reply deadline: ${en(frist)}.`,
        provider: { navn: "Statusgard Sideri" },
        slot_at_local: nb(slotIso(row().slot_at)),
        reply_deadline_local: nb(frist),
        status_url: store.guestStatusUrl(row()),
      }, "ak2f: right pair -> pending status, deadline, status_url (OA-2 status.pending)");
      assertTrue(!/kari|example\.no/i.test(JSON.stringify(pending)), "ak2g: no guest personal data in the result");

      const newSlot = futureSlot(31, 14);
      assertTrue(!!store.producerSuggestTime(row().respond_token, newSlot), "setup: producer suggests a new time");
      const sug = JSON.parse(await lookup(ref1, gref1));
      const replyUrl = `${process.env.APP_URL || "https://opplevagent.no"}/kategori/gardssalg/gjestesvar/${row().guest_decision_token}`;
      const due = new Date(store.previsitExpiryDueMs(row())).toISOString();
      assertEq([sug.status, sug.reply_url, sug.suggested_slot_at_local, sug.reply_deadline_local], ["suggested", replyUrl, nb(slotIso(newSlot)), nb(due)], "ak2h: suggested: new time, deadline and the guest's reply link (suggestion e-mail's link)");
      assertEq(sug.message, `Statusgard Sideri foreslår ${nb(slotIso(newSlot))}. Gjesten svarer her: ${replyUrl}. Svarfrist: ${nb(due)}. / Statusgard Sideri suggests ${en(slotIso(newSlot))}. The guest replies here: ${replyUrl}. Reply deadline: ${en(due)}.`, "ak2i: OA-2 status.suggested");
      assertEq(store.guestDecisionUrl(row()), replyUrl, "ak2j: guestDecisionUrl() is the suggestion e-mail's link");

      assertTrue(!!store.guestAcceptSuggestion(row().guest_decision_token), "setup: guest accepts");
      const conf = JSON.parse(await lookup(ref1, gref1));
      assertEq([conf.status, conf.message, conf.reply_url, conf.reply_deadline_local], ["confirmed", `Besøket er bekreftet: ${nb(slotIso(newSlot))}. / The visit is confirmed: ${en(slotIso(newSlot))}.`, undefined, undefined], "ak2k: confirmed: agreed time (OA-2 status.confirmed)");

      assertTrue(cancel.guestCancel(row(), "").ok, "setup: guest cancels");
      const canc = JSON.parse(await lookup(ref1, gref1));
      const at = cancel.getCancelInfo(row().booking_id)!.cancelled_at;
      assertEq([canc.status, canc.message], ["cancelledByGuest", `Avlyst av gjesten ${nb(at)}. / Cancelled by the guest ${en(at)}.`], "ak2l: cancelled by the guest (OA-2 status.cancelledByGuest)");

      // ── (ak3) wrong pair: one answer, no data ──────────────────────────
      const b2 = await book("Ola Annen", "ola.annen@example.no");
      const notFound = JSON.stringify({ found: false, message: OA2_NOT_FOUND }, null, 2);
      const flip = gref1.slice(0, -1) + (gref1.endsWith("A") ? "B" : "A");
      const answers = [
        await lookup(ref1, flip),
        await lookup("GARD-20990101-ZZZZZ", gref1),
        await lookup(ref1, String(b2.guest_ref)),
        await lookup(String(b2.booking_ref), gref1),
        await lookup(ref1, ""),
      ];
      answers.forEach((a, i) => assertEq(a, notFound, `ak3.${i + 1}: wrong pair -> exactly the OA-2 status.notFound answer`));
      assertTrue(answers.every((a) => !a.includes(ref1) && !a.includes(String(b2.booking_ref)) && !a.includes("Statusgard") && !a.includes("/status/")), "ak3b: no booking data in the not-found answers");

      for (const m of methods) (console as any)[m] = origConsole[methods.indexOf(m)];
      assertTrue(!logged.some((l) => l.includes(gref1) || l.includes(String(b2.guest_ref)) || /kari|ola annen|example\.no/i.test(l)), "log: no guest_ref and no guest personal data in log lines");

      // ── (n3) verifyGuestRef always hashes ──────────────────────────────
      const orig = store.guestRefHasher.hash;
      let hashes = 0;
      store.guestRefHasher.hash = (g: string) => { hashes++; return orig(g); };
      try {
        const count = (f: () => unknown): number => { hashes = 0; f(); return hashes; };
        assertEq([
          count(() => store.verifyGuestRef("GARD-20990101-ZZZZZ", gref1)),
          count(() => store.verifyGuestRef(ref1, flip)),
          count(() => store.verifyGuestRef(ref1, gref1)),
        ], [1, 1, 1], "n3: one hash for an unknown ref, a wrong guest_ref and the right pair");
        db.prepare("UPDATE gardssalg_bookings SET guest_ref_hash = NULL WHERE booking_ref = ?").run(String(b2.booking_ref));
        assertEq(count(() => store.verifyGuestRef(String(b2.booking_ref), String(b2.guest_ref))), 1, "n3b: one hash for a row without a stored hash");
        assertEq(store.verifyGuestRef(String(b2.booking_ref), String(b2.guest_ref)), null, "n3c: a row without a stored hash never verifies");
      } finally {
        store.guestRefHasher.hash = orig;
      }

      // ── (rl) the lookup quota ───────────────────────────────────────────
      const max = mcpMod.GARDSSALG_STATUS_LOOKUP_LIMIT.max;
      assertTrue(lookups < max, "rl setup: fewer lookups than the quota so far");
      while (lookups < max) await lookup(ref1, gref1);
      lookups++;
      const limited = await mcpRaw("tools/call", { name: "get_gardssalg_booking", arguments: { booking_ref: ref1, guest_ref: gref1 } });
      assertEq([limited.status, limited.body], [429, { jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded" }, id: "2" }], `rl1: lookup ${max + 1} within a minute -> JSON-RPC 429, no data`);
      const other = await mcpRaw("tools/list", {});
      assertEq(other.status, 200, "rl2: other calls are not counted against the lookup quota");
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
  runOpplevelserGardssalgMcpStatusToolTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
