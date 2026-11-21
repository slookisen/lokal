/**
 * opplevelser-gardssalg-mcp-preview-o5-4.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-4.
 *
 * book_gardssalg `preview`, shares/privacy/age lines and the C1/C2 tool texts
 * behind GARDSSALG_MCP_PREVIEW_ENABLED (off):
 *
 *   (ak2) flag off: tools/list equals the golden; a call (even with
 *         preview:true) gives the pre-O5-4 result byte-identically and books.
 *   (ak3) flag on: no "tasting" in discover_gardssalg / book_gardssalg, the C1
 *         titles, C2 last in the description, a `preview` field; the other
 *         tools unchanged.
 *   (ak1) flag on, preview:true: no row, no e-mail; C3 preview + shares + age +
 *         privacy; the checks still run (invalid input, paused producer).
 *   (ok)  flag on, normal success: shares + age + privacy lines and fields.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-preview-o5-4.test.ts
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

// sha256 of the tools/list `result` JSON before O5-4 (same golden as O5-1..O5-3).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";

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

const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

// C1/C2/C3, copied verbatim from the owner-approved O5-4 text package.
const C1_DISCOVER_TITLE = "Find drink producers in Norway that accept visit requests (gårdssalg)";
const C1_BOOK_TITLE = "Request a visit at a drink producer (pending until the producer replies)";
const C1_DISCOVER_FIRST = "Use this to plan a visit to a Norwegian drink producer (brewery, cidery, winery, distillery, meadery, farm café) and find ones that accept visit requests; it does not sell or order products.";
const C1_BOOK_FIRST = "Use this to request a visit (besøk) at a Norwegian gårdssalg drink producer found with discover_gardssalg or named by the guest; it sends a visit request and does not sell or order products.";
const C2 = "With preview: true the tool runs every check and returns the summary the guest should see, without storing or sending anything. On success the response carries guest_ref and status_url. Keep guest_ref for this conversation: it is needed to check the status or cancel with get_gardssalg_booking and cancel_gardssalg_booking. The response also lists what is shared with the producer and links to the privacy policy.";
const C3_SHARES = "Dette deles med produsenten: navn, e-postadresse, telefonnummer hvis det er oppgitt, antall personer, tidspunkt og kommentar. / Shared with the producer: name, email address, phone number if given, number of guests, time and note.";
const C3_AGE = "Produsenten kontrollerer alder ved kjøp og servering, og kan ha egen aldersgrense for hele eller deler av besøket. / The producer checks age for any purchase or serving, and may set its own age limit for all or part of the visit.";
const C3_PRIVACY = "Slik behandler vi personopplysninger: https://opplevagent.no/personvern / How we handle personal data: https://opplevagent.no/personvern";

export function runOpplevelserGardssalgMcpPreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_PREVIEW_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    for (const k of envKeys.slice(2)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-mcp"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      const receipt = require("../services/gardssalg-honest-receipt") as typeof import("../services/gardssalg-honest-receipt");
      const store = require("../services/booking-store") as typeof import("../services/booking-store");

      const sent: string[] = [];
      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (m: unknown) => { sent.push(JSON.stringify(m)); return { success: true, messageId: "test" }; };

      const insert = (id: string, navn: string, type: string, live: number, slug: string) => db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES (?, ?, 'experiences', 'Vestland', 'Ulvik', 'Ulvik', ?, ?, 'post@pv.example.no', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run(id, navn, type, live, slug);
      insert("pv-gard", "Pvgard Sideri", "cideri", 1, "pvgard-sideri");
      insert("pv-kafe", "Pvkafe Gardskafe", "gårdskafé", 1, "pvkafe-gardskafe");
      insert("pv-off", "Pvoff Bryggeri", "bryggeri", 0, "pvoff-bryggeri");
      const rowCount = (): number => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;

      const app = express();
      app.use(express.json());
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => mcpRouter(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      // node:http, not the global fetch: other suites in the gate stub it.
      function request(method: string, path: string, headers: Record<string, string>, payload?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = payload === undefined ? undefined : JSON.stringify(payload);
          const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(data ? { "Content-Length": String(Buffer.byteLength(data)) } : {}) } }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(data);
        });
      }
      const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": CHATGPT_UA };
      async function mcp(method: string, params: unknown): Promise<any> {
        const init = await request("POST", "/mcp", h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request("POST", "/mcp", { ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
      }
      const slot = futureSlot(30, 13);
      const book = async (args: Record<string, unknown>): Promise<string> => {
        const body = await mcp("tools/call", { name: "book_gardssalg", arguments: { provider_id: "pv-gard", slot_at: slot, party_size: 3, guest_name: "Ola Pv", guest_email: "ola.pv@example.no", ...args } });
        await new Promise((r) => setTimeout(r, 50)); // fire-and-forget e-mails
        return String(body.result?.content?.[0]?.text ?? "");
      };
      type Tool = { name: string; title?: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } };
      const toolsOf = (list: string): Tool[] => JSON.parse(list).tools;
      const tool = (list: string, name: string): Tool => toolsOf(list).find((t) => t.name === name)!;

      // ── (ak2) flag off ──────────────────────────────────────────────────
      const listOff = JSON.stringify((await mcp("tools/list", {})).result);
      assertEq(createHash("sha256").update(listOff).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "ak2: flag off: tools/list equals the golden (byte-identical)");
      assertEq(tool(listOff, "book_gardssalg").inputSchema?.properties?.preview, undefined, "ak2b: flag off: no preview field");
      const offRows = rowCount();
      const offText = await book({ preview: true });
      const off = JSON.parse(offText);
      assertEq(rowCount(), offRows + 1, "ak2c: flag off: preview:true is ignored, the request is stored as today");
      const legacyMessage =
        `Produsent: Pvgard Sideri · Tidspunkt: ${off.slot_at_local} · 3 person(er). ` +
        `Reservasjonsforespørsel mottatt (${off.booking_ref}) — status: PENDING/AVVENTER. ` +
        `En bekreftelse på forespørselen er sendt til ola.pv@example.no; produsenten er varslet ` +
        `og svarer på e-post (bekrefter, foreslår nytt tidspunkt eller avslår) — reservasjonen blir ` +
        `IKKE endelig før produsenten har svart. / ` +
        `Reservation request received (${off.booking_ref}) — status: PENDING. A confirmation ` +
        `email has been sent to ola.pv@example.no; the producer has been notified and will ` +
        `respond by email (confirm, propose another time, or decline) — the booking only becomes ` +
        `final once the producer responds, and this tool can never confirm it itself.`;
      const golden = {
        success: true, pending: true, status: "reserved", booking_ref: off.booking_ref, source: "mcp", confirmation_required: true,
        provider: { id: "pv-gard", navn: "Pvgard Sideri", profile_url: "https://opplevagent.no/kategori/gardssalg/produsent/pvgard-sideri?utm_source=chatgpt&utm_medium=mcp&utm_campaign=ai_search" },
        slot_at_local: off.slot_at_local, party_size: 3, producer_notification: { status: "queued" }, message: legacyMessage,
      };
      assertEq(offText, JSON.stringify(golden, null, 2), "ak2d: flag off: result byte-identical to the pre-O5-4 golden");

      // ── (ak3) flag on: tools/list ───────────────────────────────────────
      process.env.GARDSSALG_MCP_PREVIEW_ENABLED = "true";
      const listOn = JSON.stringify((await mcp("tools/list", {})).result);
      const dOn = tool(listOn, "discover_gardssalg");
      const bOn = tool(listOn, "book_gardssalg");
      assertTrue(!/tasting/i.test(JSON.stringify(dOn)) && !/tasting/i.test(JSON.stringify(bOn)), "ak3: flag on: no 'tasting' in discover_gardssalg / book_gardssalg");
      assertEq([dOn.title, bOn.title], [C1_DISCOVER_TITLE, C1_BOOK_TITLE], "ak3b: C1 titles");
      assertTrue(String(dOn.description).startsWith(C1_DISCOVER_FIRST + " "), "ak3c: C1 discover first sentence");
      assertTrue(String(dOn.description).includes("drink producers to visit (besøk) (bryggeri/"), "ak3d: C1 discover second sentence");
      assertTrue(String(bOn.description).startsWith(C1_BOOK_FIRST + " "), "ak3e: C1 book first sentence");
      assertTrue(String(bOn.description).endsWith("guest_email 'kari@example.no'. " + C2), "ak3f: C2 last in book_gardssalg's description");
      assertEq((bOn.inputSchema?.properties?.preview as { type?: string } | undefined)?.type, "boolean", "ak3g: preview field present (boolean)");
      const restOf = (d: unknown) => String(d).replace(/^.*?products\. /, "");
      assertEq(restOf(tool(listOn, "discover_gardssalg").description).replace("visit (besøk) (", "visit (besøk, smaking) ("), restOf(tool(listOff, "discover_gardssalg").description), "ak3h: rest of discover description unchanged");
      assertEq(restOf(bOn.description), restOf(tool(listOff, "book_gardssalg").description) + " " + C2, "ak3i: rest of book description unchanged, C2 appended");
      const others = (list: string) => JSON.stringify(toolsOf(list).filter((t) => t.name !== "discover_gardssalg" && t.name !== "book_gardssalg"));
      assertEq(others(listOn), others(listOff), "ak3j: every other tool (discover_experiences, get_experience, …) unchanged");

      // ── (ak1) flag on, preview:true ─────────────────────────────────────
      const logged: string[] = [];
      const methods = ["log", "info", "warn", "error", "debug"] as const;
      const origConsole = methods.map((m) => console[m]);
      const rows0 = rowCount();
      const sent0 = sent.length;
      let pvText = "";
      try {
        for (const m of methods) (console as any)[m] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
        pvText = await book({ preview: true, guest_phone: "+4799999999" });
      } finally {
        methods.forEach((m, i) => { (console as any)[m] = origConsole[i]; });
      }
      const pv = JSON.parse(pvText);
      assertEq(rowCount(), rows0, "ak1: preview creates no row");
      assertEq(sent.length, sent0, "ak1b: preview sends no e-mail");
      assertTrue(!logged.some((l) => l.includes("ola.pv@example.no") || l.includes("Ola Pv")), "ak1c: no guest personal data in log lines");
      assertEq([pv.success, pv.preview, pv.sent, pv.pending, pv.booking_ref], [true, true, false, false, undefined], "ak1d: preview flags, no booking_ref");
      const iso = store.osloDatetimeLocalToUtcIso(slot)!;
      const tidEn = receipt.formatOsloInstant(iso, "en");
      assertTrue(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} at 13:00$/.test(tidEn), "ak1e: English {tid} like 'Friday 12 December 2026 at 13:00'");
      const previewLine =
        `Forhåndsvisning. Ingenting er sendt ennå. Forespørsel om besøk hos Pvgard Sideri, ${receipt.formatOsloInstant(iso, "nb")}, 3 personer. / ` +
        `Preview. Nothing has been sent yet. Visit request to Pvgard Sideri, ${tidEn}, 3 guests.`;
      assertEq(pv.message, [previewLine, C3_SHARES, C3_AGE, C3_PRIVACY].join("\n"), "ak1f: C3 preview + shares + age + privacy");
      assertEq(pv.privacy_url, "https://opplevagent.no/personvern", "ak1g: privacy_url is Opplevagent's /personvern");
      assertEq(pv.shared_with_producer, ["guest_name", "guest_email", "guest_phone", "party_size", "slot_at"], "ak1h: shared_with_producer lists what is given");
      assertTrue(!/must be|at least \d|minst \d|over \d+ år|\d+ years/i.test(pvText), "ak1i: no age gate in the text");
      const kafe = JSON.parse(await book({ preview: true, provider_id: "pv-kafe", notes: "Kommer kl 13" }));
      assertTrue(!kafe.message.includes(C3_AGE) && kafe.message.includes(C3_SHARES), "ak1j: gårdskafé without alcohol: no age line");
      assertEq(kafe.shared_with_producer, ["guest_name", "guest_email", "party_size", "slot_at", "notes"], "ak1k: notes listed when given");
      db.prepare("UPDATE experience_providers SET alcohol_categories = ? WHERE id = 'pv-kafe'").run(JSON.stringify(["gruppe1"]));
      assertTrue(JSON.parse(await book({ preview: true, provider_id: "pv-kafe" })).message.includes(C3_AGE), "ak1l: alcohol_categories set: age line");
      const bad = JSON.parse(await book({ preview: true, guest_email: "not-an-email" }));
      assertEq([bad.error, bad.preview], ["invalid_input", undefined], "ak1m: preview still validates input");
      const paused = JSON.parse(await book({ preview: true, provider_id: "pv-off" }));
      assertEq([paused.reason, paused.preview], ["not_live", undefined], "ak1n: preview still checks the producer takes requests");
      assertEq([rowCount(), sent.length], [rows0, sent0], "ak1o: no row and no e-mail across every preview call");

      // ── (ok) flag on, normal success ────────────────────────────────────
      const okText = await book({});
      const ok = JSON.parse(okText);
      assertEq(rowCount(), rows0 + 1, "ok: normal call stores the request");
      assertTrue(sent.length > sent0, "ok2: normal call sends e-mail");
      assertEq(ok.message, [legacyMessage.split(off.booking_ref).join(ok.booking_ref), C3_SHARES, C3_AGE, C3_PRIVACY].join("\n"), "ok3: success message + shares + age + privacy");
      assertEq([ok.privacy_url, ok.shared_with_producer], ["https://opplevagent.no/personvern", ["guest_name", "guest_email", "party_size", "slot_at"]], "ok4: privacy_url + shared_with_producer");
      const { message: _m, privacy_url: _p, shared_with_producer: _s, booking_ref: _r, ...okRest } = ok;
      const { message: _gm, booking_ref: _gr, ...goldenRest } = golden;
      assertEq(okRest, goldenRest, "ok5: every other field unchanged");
      process.env.GARDSSALG_MCP_GUEST_REF_ENABLED = "true";
      const both = JSON.parse(await book({ guest_email: "kari.pv@example.no" }));
      assertTrue(typeof both.guest_ref === "string" && both.message.startsWith("Forespørselen er mottatt") && both.message.endsWith("\n" + C3_PRIVACY), "ok6: with O5-1 on: book.ok text, then the O5-4 lines");
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
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
  runOpplevelserGardssalgMcpPreviewTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
