/**
 * opplevelser-gardssalg-source-client.test.ts — dev-request
 * 2026-11-12-f1-felles-for-ai-kanalene, slice F1-1.
 *
 * A gårdssalg booking records which AI assistant it came from in
 * gardssalg_bookings.source_client, as one fixed label (SOURCE_CLIENT_LABELS
 * in utils/url-utm.ts) or NULL:
 *
 *   (u)  unit — sourceClientLabel / isSourceClientLabel / the closed label set;
 *        createBooking stores only an allow-listed value (AK2).
 *   (m)  book_gardssalg (MCP): a ChatGPT session → 'chatgpt', a Claude session
 *        → 'claude' (by User-Agent, and by the initialize client name), an
 *        unknown client with a person-like name → NULL (AK1, AK2).
 *   (r)  POST /api/opplevelser/book: ChatGPT-User → 'chatgpt', Claude-User →
 *        'claude'; a browser (the web form), no UA, or a plain script → NULL.
 *   (w)  the no-JS web form fallback (experiences-seo.ts) never passes a label.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-source-client.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function callRoute(
  router: any,
  opts: { url: string; body?: any; headers?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url.split("?")[0],
      query: {},
      headers: opts.headers ?? {},
      body: opts.body ?? {},
      get(k: string) { return (opts.headers ?? {})[k.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : null });
    });
  });
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
const CLAUDE_UA = "Claude-User (claude-code/1.0; +https://support.anthropic.com/)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

export function runOpplevelserGardssalgSourceClientTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-mcp"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let server: http.Server | undefined;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      const utm = require("../utils/url-utm") as typeof import("../utils/url-utm");

      // ── (u) the closed label set ──────────────────────────────────────
      assertEq([...utm.SOURCE_CLIENT_LABELS].sort(), [
        "chatgpt", "claude", "cline", "continue_dev", "cursor", "github_copilot",
        "node_sdk", "perplexity", "python_sdk", "windsurf",
      ], "u1: SOURCE_CLIENT_LABELS is the fixed AI-client slug list");
      assertEq(utm.sourceClientLabel("ChatGPT"), "chatgpt", "u2: ChatGPT -> chatgpt");
      assertEq(utm.sourceClientLabel("Claude"), "claude", "u2b: Claude -> claude");
      assertEq(utm.sourceClientLabel(undefined), null, "u2c: no client -> null");
      assertEq(utm.sourceClientLabel(""), null, "u2d: empty -> null");
      assertEq(utm.sourceClientLabel("Ola Nordmann's assistant"), null, "u2e: unknown name -> null, never the raw string");
      assertEq(utm.sourceClientLabel("constructor"), null, "u2f: prototype key -> null");
      assertEq(utm.sourceClientLabel("__proto__"), null, "u2g: __proto__ -> null");
      assertEq(utm.sourceClientLabel(utm.aiClientFromHeaders({ "user-agent": CHATGPT_UA })), "chatgpt", "u3: ChatGPT-User UA -> chatgpt");
      assertEq(utm.sourceClientLabel(utm.aiClientFromHeaders({ "user-agent": "undici" }, "claude-ai")), "claude", "u3b: initialize name claude-ai -> claude");
      assertEq(utm.isSourceClientLabel("chatgpt"), true, "u4: isSourceClientLabel(chatgpt)");
      assertEq(utm.isSourceClientLabel("ChatGPT"), false, "u4b: display name is not a stored label");
      assertEq(utm.isSourceClientLabel("ola@example.no"), false, "u4c: arbitrary string is not a label");

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");

      const cols = (db.prepare("PRAGMA table_info(gardssalg_bookings)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
      const col = cols.find((c) => c.name === "source_client");
      assertEq(col ? { notnull: col.notnull, dflt: col.dflt_value } : null, { notnull: 0, dflt: null }, "u5: gardssalg_bookings.source_client exists, nullable, no default");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async () => ({ success: true, messageId: "test" });

      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES ('sc-gard', 'Kildegard Sideri', 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', 1,
                 'post@kildegard.example.no', 'kildegard-sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const sourceClientOf = (ref: string | undefined): unknown =>
        (db.prepare("SELECT source_client FROM gardssalg_bookings WHERE booking_ref = ?").get(ref ?? "") as { source_client: unknown } | undefined)?.source_client;

      const slot = futureSlot(30);
      const guest = { provider_id: "sc-gard", slot_at: slot, party_size: 2, guest_name: "Kari Test", guest_email: "kari@example.no" };

      // ── (u) createBooking stores only allow-listed values (AK2) ──────
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const parsedInput = bookingStore.BookingInputSchema.parse(guest);
      assertEq(bookingStore.createBooking(parsedInput, "mcp", { sourceClient: "chatgpt" }).source_client, "chatgpt", "u6: allow-listed label is kept");
      const raw = bookingStore.createBooking(parsedInput, "mcp", { sourceClient: "Kari Nordmann (kari@example.no)" });
      assertEq(raw.source_client, null, "u6b: arbitrary string -> null on the object");
      assertEq(sourceClientOf(raw.booking_ref), null, "u6c: …and NULL in the row");
      assertEq(bookingStore.createBooking(parsedInput, "mcp", { sourceClient: "ChatGPT" }).source_client, null, "u6d: display name (not a slug) -> null");
      const plain = bookingStore.createBooking(parsedInput);
      assertEq(sourceClientOf(plain.booking_ref), null, "u6e: no label -> NULL");
      assertEq(bookingStore.getBookingByRef(plain.booking_ref)?.source_client, null, "u6f: hydrate reads NULL");

      // ── (m) MCP book_gardssalg ───────────────────────────────────────
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const app = express();
      app.use(express.json());
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpRouter as any)(req, res, next));
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // node:http, not the global fetch: other suites in the gate stub
      // globalThis.fetch while they run.
      function post(headers: Record<string, string>, payload: unknown): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(payload);
          const req = http.request(`${base}/mcp`, { method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(data)) } }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { text += c; });
            res.on("end", () => resolve({ headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(data);
        });
      }
      async function mcpBook(ua: string, clientName: string): Promise<string | undefined> {
        const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": ua };
        const init = await post(h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await post(
          { ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) },
          { jsonrpc: "2.0", method: "tools/call", id: "2", params: { name: "book_gardssalg", arguments: guest } },
        );
        const ct = res.headers["content-type"];
        const body = parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
        const out = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
        return out.booking_ref;
      }

      const mChat = await mcpBook(CHATGPT_UA, "openai-mcp");
      assertEq(typeof mChat, "string", "m1: ChatGPT session books");
      assertEq(sourceClientOf(mChat), "chatgpt", "m1b: ChatGPT session -> source_client 'chatgpt'");
      const mClaude = await mcpBook(CLAUDE_UA, "claude-ai");
      assertEq(sourceClientOf(mClaude), "claude", "m2: Claude session -> 'claude'");
      const mClaudeByName = await mcpBook("mcp-gateway/2.0", "claude-ai");
      assertEq(sourceClientOf(mClaudeByName), "claude", "m2b: unknown UA, initialize client name claude-ai -> 'claude'");
      const mUnknown = await mcpBook("Kari Nordmann private agent/1.0", "Kari Nordmann laptop");
      assertEq(typeof mUnknown, "string", "m3: unknown client books");
      assertEq(sourceClientOf(mUnknown), null, "m3b: unknown client name -> NULL, never the raw name");
      const stored = (db.prepare("SELECT DISTINCT source_client FROM gardssalg_bookings WHERE source_client IS NOT NULL").all() as Array<{ source_client: string }>)
        .map((r) => r.source_client);
      assertEq(stored.every((v) => utm.SOURCE_CLIENT_LABELS.includes(v)), true, "m4: every stored value is in SOURCE_CLIENT_LABELS");

      // ── (r) POST /api/opplevelser/book ───────────────────────────────
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const restBook = async (headers: Record<string, string>): Promise<unknown> => {
        const r = await callRoute(router, { url: "/book", body: guest, headers });
        assertEq(r.status, 201, `r: POST /book -> 201 (${headers["user-agent"] ?? "no UA"})`);
        return sourceClientOf(r.body?.booking_ref);
      };
      assertEq(await restBook({ "user-agent": CHATGPT_UA }), "chatgpt", "r1: ChatGPT-User (GPT action) -> 'chatgpt'");
      assertEq(await restBook({ "user-agent": CLAUDE_UA }), "claude", "r2: Claude-User -> 'claude'");
      assertEq(await restBook({ "user-agent": BROWSER_UA, origin: "https://opplevagent.no" }), null, "r3: web form (browser) -> NULL");
      assertEq(await restBook({}), null, "r4: no User-Agent -> NULL");
      assertEq(await restBook({ "user-agent": "python-requests/2.32" }), null, "r5: plain REST script (no AI client) -> NULL");

      // ── (w) the no-JS web form fallback never passes a label ─────────
      const seoSrc = fs.readFileSync(path.join(__dirname, "experiences-seo.ts"), "utf8");
      assertEq(seoSrc.match(/createBooking\([^)]+\)/g), ["createBooking(parsed.data, undefined, { guestLang: body.lang })"], "w1: experiences-seo.ts calls createBooking with the guest language only (O4-2), never a source_client (NULL)");
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
      restoreModuleCache();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgSourceClientTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
