/**
 * experiences-a2a-book-gardssalg-o5-7.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-7
 * (booking in the OpenAPI document and as an A2A task).
 *
 *   (ak1-oa)   the Opplevagent OpenAPI document parses as JSON, is 3.1, has
 *              POST /api/opplevelser/book with a request schema that covers
 *              BookingInputSchema's fields, and every $ref resolves.
 *   (ak1-list) MCP tools/list equals the O5-1..O5-5 golden (byte-identical).
 *   (ak2)      an A2A book_gardssalg task against the test producer gives the
 *              same booking row, the same e-mails (mocked sender) and the
 *              same payload as the equivalent MCP call, and one O5-8 outcome
 *              row each.
 *   (rej)      the A2A path answers rejections with the tool's own payloads
 *              (invalid_input, not_live) and logs their outcome codes.
 *   (par)      missing data / wrong types -> -32602, no row, no outcome row.
 *   (rl)       the A2A booking quota: the 21st book_gardssalg call in a
 *              minute from one IP gets 429; other A2A calls are not counted.
 *
 * Standalone: npx tsx src/routes/experiences-a2a-book-gardssalg-o5-7.test.ts
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

// Same golden as opplevelser-gardssalg-mcp-funnel-o5-8.test.ts (flags off).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";
const UA = "o5-7-test-agent/1.0";

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

function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) { for (const x of node) collectRefs(x, out); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
}

export function runExperiencesA2aBookGardssalgTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_MCP_PREVIEW_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED",
      "GARDSSALG_BOOKING_CAP_ENABLED", "GARDSSALG_MCP_VISIT_FACTS_ENABLED", "GARDSSALG_MCP_STATUS_TOOL_ENABLED", "GARDSSALG_MCP_CANCEL_TOOL_ENABLED",
    ];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    // The test producer dispatches with the master switch off (isBookingPaused).
    for (const k of envKeys.slice(1)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-mcp-funnel"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-a2a"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      // ── (ak1-oa) OpenAPI ────────────────────────────────────────────────
      const { getExperiencesOpenapi } = require("../services/experiences-openapi") as typeof import("../services/experiences-openapi");
      const doc = JSON.parse(JSON.stringify(getExperiencesOpenapi())) as any;
      assertEq(doc.openapi, "3.1.0", "ak1-oa1: OpenAPI 3.1 document parses");
      const op = doc.paths?.["/api/opplevelser/book"]?.post;
      assertTrue(!!op && op.operationId === "bookGardssalgVisit", "ak1-oa2: POST /api/opplevelser/book is described");
      const reqRef = op?.requestBody?.content?.["application/json"]?.schema?.$ref;
      assertEq(reqRef, "#/components/schemas/GardssalgBookingRequest", "ak1-oa3: request body schema is GardssalgBookingRequest");
      const reqSchema = doc.components?.schemas?.GardssalgBookingRequest;
      assertEq(reqSchema?.required, ["slot_at", "party_size", "guest_name", "guest_email"], "ak1-oa4: required fields");
      const { BookingInputSchema } = require("../services/booking-store") as typeof import("../services/booking-store");
      const missing = Object.keys(BookingInputSchema.shape).filter((k) => !(k in (reqSchema?.properties ?? {})));
      assertEq(missing, [], "ak1-oa5: every BookingInputSchema field is in the request schema");
      const { BookGardssalgInputSchema } = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const missingTool = Object.keys(BookGardssalgInputSchema).filter((k) => !(k in (reqSchema?.properties ?? {})));
      assertEq(missingTool, [], "ak1-oa6: every book_gardssalg argument is in the request schema");
      assertTrue(["201", "200", "400"].every((c) => c in (op?.responses ?? {})), "ak1-oa7: 201/200/400 responses described");
      const refs: string[] = [];
      collectRefs(doc, refs);
      const unresolved = refs.filter((r) => {
        const m = /^#\/components\/schemas\/(.+)$/.exec(r);
        return !m || !doc.components.schemas[m[1]];
      });
      assertEq(unresolved, [], "ak1-oa8: every $ref resolves");
      const a2aEx = doc.paths["/a2a"].post.requestBody.content["application/json"].examples.bookGardssalg?.value;
      assertEq(a2aEx?.params?.skillId, "book_gardssalg", "ak1-oa9: /a2a has a book_gardssalg example");

      // ── setup ───────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      const funnel = require("../services/gardssalg-mcp-funnel") as typeof import("../services/gardssalg-mcp-funnel");
      funnel.__resetGardssalgFunnelPruneForTesting();

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      const sent: any[] = [];
      (emailMod.emailService as any).sendEmail = async (o: any) => { sent.push(o); return { success: true, messageId: "test" }; };

      const insert = (id: string, navn: string, live: number, hidden: number, isTest: number, slug: string) => db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, is_test_provider, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES (?, ?, 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', ?, ?, ?, 'post@o57.example.no', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run(id, navn, live, hidden, isTest, slug);
      insert("o57-test", "O57 Testgard Sideri", 1, 1, 1, "o57-testgard-sideri");
      insert("o57-off", "O57 Avgard Bryggeri", 0, 0, 0, "o57-avgard-bryggeri");

      const events = (): string[] => (db.prepare("SELECT outcome FROM gardssalg_mcp_funnel_events ORDER BY id").all() as Array<{ outcome: string }>).map((r) => r.outcome);
      const bookingCount = (): number => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings").get() as { n: number }).n;

      const app = express();
      app.use(express.json());
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      const a2aRouter = (require("./experiences-a2a") as typeof import("./experiences-a2a")).default as any;
      app.use((req, res, next) => (req.path === "/a2a" ? a2aRouter(req, res, next) : mcpRouter(req, res, next)));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

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
      async function mcp(method: string, params: unknown): Promise<any> {
        const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA };
        const init = await request("POST", "/mcp", h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "o57-script", version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request("POST", "/mcp", { ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
      }
      async function a2a(body: unknown): Promise<{ status: number; body: any }> {
        const res = await request("POST", "/a2a", { "Content-Type": "application/json", "User-Agent": UA }, body);
        return { status: res.status, body: JSON.parse(res.text) };
      }
      const a2aBook = (data: unknown, method = "message/send") => a2a({
        jsonrpc: "2.0", method, id: "b1",
        params: { skillId: "book_gardssalg", message: { role: "user", parts: [{ kind: "data", data }] } },
      });
      const settle = () => new Promise((r) => setTimeout(r, 60)); // fire-and-forget e-mails

      // ── (ak1-list) tools/list byte-identical ────────────────────────────
      const list = JSON.stringify((await mcp("tools/list", {})).result);
      assertEq(createHash("sha256").update(list).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "ak1-list: tools/list equals the golden (byte-identical)");

      // ── (ak2) same row, same e-mails, same payload ──────────────────────
      const args = {
        provider_id: "o57-test", slot_at: futureSlot(30, 13), party_size: 3,
        guest_name: "Kari O57", guest_email: "kari.o57@example.no", guest_phone: "+4790000000", notes: "Vi kommer med sykkel.",
      };
      const mcpRes = await mcp("tools/call", { name: "book_gardssalg", arguments: args });
      await settle();
      const mcpPayload = JSON.parse(String(mcpRes.result?.content?.[0]?.text ?? "null"));
      const mcpMails = sent.splice(0);
      assertEq(mcpPayload?.success, true, "ak2.0: MCP book_gardssalg created a request");

      const a2aRes = await a2aBook(args);
      await settle();
      const a2aMails = sent.splice(0);
      const artifact = a2aRes.body?.result?.artifacts?.[0];
      const dataPart = artifact?.parts?.find((p: any) => p.kind === "data")?.data;
      const textPart = artifact?.parts?.find((p: any) => p.kind === "text")?.text;
      assertEq(a2aRes.status, 200, "ak2.1: A2A answers 200");
      assertEq([a2aRes.body?.result?.status?.state, a2aRes.body?.result?.metadata?.skill], ["completed", "book_gardssalg"], "ak2.2: task completed, skill book_gardssalg");
      assertEq(dataPart?.success, true, "ak2.3: A2A created a request");
      assertEq(textPart, dataPart?.message, "ak2.4: TextPart is the payload's message");

      type Row = Record<string, unknown>;
      const rowOf = (ref: string): Row => db.prepare("SELECT * FROM gardssalg_bookings WHERE booking_ref = ?").get(ref) as Row;
      const mcpRow = rowOf(mcpPayload.booking_ref);
      const a2aRow = rowOf(dataPart.booking_ref);
      const PER_ROW = ["booking_id", "booking_ref", "confirm_token", "respond_token", "respond_token_expires_at", "guest_status_token", "created_at", "notify_sent_at", "notify_failed_at"];
      const strip = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([k]) => !PER_ROW.includes(k)));
      assertTrue(!!mcpRow && !!a2aRow, "ak2.5: both rows exist");
      assertEq(strip(a2aRow), strip(mcpRow), "ak2.6: the A2A row equals the MCP row (besides ids, tokens and times)");
      assertEq([a2aRow.source, a2aRow.status, a2aRow.pre_status], ["mcp", "reserved", "awaiting_provider"], "ak2.7: pending request, same channel column as MCP");

      // Profile links carry the transport's own UTM medium (mcp / a2a, «Klikk
      // fra AI-svar» slice 3); everything else must match.
      const medium = (s: string): string => s.replace(/utm_medium=(mcp|a2a)/g, "utm_medium=<transport>");
      const norm = (v: unknown, row: Row): string => {
        let s = medium(JSON.stringify(v));
        for (const k of ["booking_ref", "confirm_token", "respond_token", "guest_status_token", "booking_id"]) {
          const val = row[k];
          if (typeof val === "string" && val) s = s.split(val).join(`<${k}>`);
        }
        return s;
      };
      assertEq(a2aMails.length, mcpMails.length, "ak2.8: same number of e-mails");
      assertTrue(mcpMails.length >= 2, "ak2.9: guest receipt and producer notice sent");
      assertEq(a2aMails.map((m) => norm(m, a2aRow)), mcpMails.map((m) => norm(m, mcpRow)), "ak2.10: the same e-mails (recipients, subjects, bodies)");
      assertEq(norm(dataPart, a2aRow), norm(mcpPayload, mcpRow), "ak2.11: the A2A payload equals the MCP payload (besides the transport's UTM medium)");
      assertEq(events(), ["created", "created"], "ak2.12: one O5-8 'created' row per call");

      // tasks/send alias and metadata.skillId work the same way.
      const viaMeta = await a2a({ jsonrpc: "2.0", method: "tasks/send", id: "b2", params: { metadata: { skillId: "book_gardssalg" }, message: { data: { ...args, guest_email: "not-an-email" } } } });
      const vmData = viaMeta.body?.result?.artifacts?.[0]?.parts?.find((p: any) => p.kind === "data")?.data;
      assertEq([vmData?.error, viaMeta.body?.result?.status?.state], ["invalid_input", "failed"], "ak2.13: tasks/send + metadata.skillId reaches the tool chain");
      sent.splice(0);

      // ── (rej) rejections as the tool answers them ───────────────────────
      const mcpBad = JSON.parse(String((await mcp("tools/call", { name: "book_gardssalg", arguments: { ...args, guest_email: "nope" } })).result?.content?.[0]?.text));
      const a2aBad = (await a2aBook({ ...args, guest_email: "nope" })).body?.result?.artifacts?.[0]?.parts?.find((p: any) => p.kind === "data")?.data;
      assertEq(a2aBad, mcpBad, "rej1: invalid_input payload identical");
      const mcpOff = JSON.parse(String((await mcp("tools/call", { name: "book_gardssalg", arguments: { ...args, provider_id: "o57-off" } })).result?.content?.[0]?.text));
      const a2aOff = (await a2aBook({ ...args, provider_id: "o57-off" })).body?.result?.artifacts?.[0]?.parts?.find((p: any) => p.kind === "data")?.data;
      assertEq(medium(JSON.stringify(a2aOff)), medium(JSON.stringify(mcpOff)), "rej2: not_live payload identical (besides the transport's UTM medium)");
      assertEq(a2aOff?.reason, "not_live", "rej2b: reason not_live");
      await settle();
      assertEq(sent.length, 0, "rej3: no e-mail for a rejection");
      assertEq(events().slice(-5), ["invalid_input", "invalid_input", "invalid_input", "not_live", "not_live"], "rej4: outcome rows for the rejections");
      assertEq(bookingCount(), 2, "rej5: no row for a rejection");

      // ── (par) unusable params ───────────────────────────────────────────
      const before = events().length;
      const noData = await a2a({ jsonrpc: "2.0", method: "message/send", id: "p1", params: { skillId: "book_gardssalg", message: { text: "book hos O57 fredag" } } });
      assertEq(noData.body?.error?.code, -32602, "par1: text only -> -32602");
      const wrongType = await a2aBook({ ...args, party_size: "3" });
      assertEq(wrongType.body?.error?.code, -32602, "par2: party_size as a string -> -32602 (the tool's loose schema)");
      assertTrue(!JSON.stringify(wrongType.body).includes(args.guest_email), "par3: the error does not echo the guest's e-mail");
      assertEq([events().length, bookingCount()], [before, 2], "par4: no outcome row and no booking for unusable params");

      // A discovery call is unchanged and not a booking.
      const disc = await a2a({ jsonrpc: "2.0", method: "message/send", id: "d1", params: { message: { text: "sideri i Vestland" } } });
      assertEq(disc.body?.result?.metadata?.skill, "gardssalg_discover", "par5: plain message/send still discovers");

      // ── (rl) the booking quota ──────────────────────────────────────────
      // Calls so far on the A2A booking bucket: 2 (ak2/ak2.13) + 2 (rej) + 2 (par) = 6.
      let last = 0;
      for (let i = 0; i < 14; i++) last = (await a2aBook({ ...args, guest_email: "nope" })).status;
      assertEq(last, 200, "rl1: the 20th booking call in the window is answered");
      const over = await a2aBook({ ...args, guest_email: "nope" });
      assertEq([over.status, over.body?.error?.code], [429, -32000], "rl2: the 21st booking call gets the JSON-RPC 429");
      const discAfter = await a2a({ jsonrpc: "2.0", method: "message/send", id: "d2", params: { message: { text: "sideri i Vestland" } } });
      assertEq(discAfter.status, 200, "rl3: other A2A calls are not in the booking bucket");
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
  runExperiencesA2aBookGardssalgTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
