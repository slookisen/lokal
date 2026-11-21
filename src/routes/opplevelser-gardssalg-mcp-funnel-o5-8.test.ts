/**
 * opplevelser-gardssalg-mcp-funnel-o5-8.test.ts — dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter, slice O5-8
 * («trakt og kilde»).
 *
 *   (ak1-list) tools/list equals the O5-1..O5-5 golden (byte-identical).
 *   (log)  one outcome row per discover_gardssalg / book_gardssalg call:
 *          search, created, provider_not_found, not_live, invalid_input,
 *          preview; source_client label from the session; no guest data in
 *          the table (columns and values); a log failure leaves the tool
 *          result unchanged; rows older than 90 days are pruned.
 *   (cls)  classifyBookGardssalgResult on the internal-error text and the
 *          duplicate / outside_hours / cap_reached payloads.
 *   (adm)  GET /admin/gardssalg/booking-funnel: 403 without/with a wrong key
 *          (same as bookings-count), 200 with counts per client and total,
 *          booking stages from gardssalg_bookings, `days` window and
 *          validation, no personal data in the answer.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-mcp-funnel-o5-8.test.ts
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

// sha256 of the tools/list `result` JSON (same golden as O5-1..O5-5, flags off).
const TOOLS_LIST_GOLDEN_SHA256 = "ca0b5c861ae68df2121db9fa96187301f5c5884546f6db579f0231d97b7544c3";
const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

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

function callAdmin(router: any, query: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(query).toString();
    const path = "/admin/gardssalg/booking-funnel";
    const req: any = {
      method: "GET",
      url: path + (qs ? `?${qs}` : ""),
      originalUrl: path + (qs ? `?${qs}` : ""),
      path,
      query,
      headers,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "not handled") } });
    });
  });
}

export function runOpplevelserGardssalgMcpFunnelTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "ADMIN_KEY", "GARDSSALG_MCP_PREVIEW_ENABLED", "GARDSSALG_MCP_GUEST_REF_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED", "GARDSSALG_MCP_VISIT_FACTS_ENABLED"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    const adminKey = process.env.ADMIN_KEY || "gardssalg-funnel-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    process.env.ADMIN_KEY = adminKey;
    for (const k of envKeys.slice(3)) delete process.env[k];

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-mcp-funnel"),
      require.resolve("./experiences-mcp"),
      require.resolve("./opplevelser"),
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
      const funnel = require("../services/gardssalg-mcp-funnel") as typeof import("../services/gardssalg-mcp-funnel");
      funnel.__resetGardssalgFunnelPruneForTesting();

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async () => ({ success: true, messageId: "test" });

      const insert = (id: string, navn: string, live: number, slug: string) => db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, epost, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES (?, ?, 'experiences', 'Vestland', 'Ulvik', 'Ulvik', 'cideri', ?, 'post@fn.example.no', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run(id, navn, live, slug);
      insert("fn-gard", "Fngard Sideri", 1, "fngard-sideri");
      insert("fn-off", "Fnoff Bryggeri", 0, "fnoff-bryggeri");

      type EventRow = { id: number; created_at: string; outcome: string; source_client: string | null };
      const events = (): EventRow[] => db.prepare("SELECT * FROM gardssalg_mcp_funnel_events ORDER BY id").all() as EventRow[];
      const lastOutcomes = (n: number): Array<[string, string | null]> => events().slice(-n).map((r) => [r.outcome, r.source_client]);

      const app = express();
      app.use(express.json());
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => mcpRouter(req, res, next));
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
      async function mcp(method: string, params: unknown, ua = CHATGPT_UA, clientName = "openai-mcp"): Promise<any> {
        const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": ua };
        const init = await request("POST", "/mcp", h, {
          jsonrpc: "2.0", method: "initialize", id: "1",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
        });
        const sid = init.headers["mcp-session-id"];
        const res = await request("POST", "/mcp", { ...h, ...(typeof sid === "string" ? { "mcp-session-id": sid } : {}) }, { jsonrpc: "2.0", method, id: "2", params });
        const ct = res.headers["content-type"];
        return parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
      }
      const slot = futureSlot(30, 13);
      const GUEST_NAME = "Ola Fn";
      const GUEST_EMAIL = "ola.fn@example.no";
      const book = async (args: Record<string, unknown>, ua?: string, clientName?: string): Promise<string> => {
        const body = await mcp("tools/call", { name: "book_gardssalg", arguments: { provider_id: "fn-gard", slot_at: slot, party_size: 2, guest_name: GUEST_NAME, guest_email: GUEST_EMAIL, ...args } }, ua, clientName);
        await new Promise((r) => setTimeout(r, 30)); // fire-and-forget e-mails
        return String(body.result?.content?.[0]?.text ?? "");
      };

      // ── (ak1-list) tools/list byte-identical ────────────────────────────
      const list = JSON.stringify((await mcp("tools/list", {})).result);
      assertEq(createHash("sha256").update(list).digest("hex"), TOOLS_LIST_GOLDEN_SHA256, "ak1-list: tools/list equals the golden (byte-identical)");
      assertEq(events().length, 0, "ak1-list2: tools/list writes no outcome row");

      // ── (log) one row per call ──────────────────────────────────────────
      await mcp("tools/call", { name: "discover_gardssalg", arguments: { fylke: "Vestland" } });
      assertEq(lastOutcomes(1), [["search", "chatgpt"]], "log1: discover_gardssalg -> one 'search' row, source_client chatgpt");
      assertEq(events().length, 1, "log1b: exactly one row");

      const okText = await book({});
      const ok = JSON.parse(okText);
      assertEq(ok.success, true, "log2: book_gardssalg succeeded");
      assertEq(lastOutcomes(1), [["created", "chatgpt"]], "log2b: created -> one 'created' row");
      const bk = db.prepare("SELECT source_client FROM gardssalg_bookings WHERE booking_ref = ?").get(ok.booking_ref) as { source_client: string | null };
      assertEq(bk.source_client, "chatgpt", "log2c: the booking keeps its F1-1 source_client (unchanged)");

      await book({ provider_id: undefined, provider_query: "Finnesikkeharidetheletatt" });
      assertEq(lastOutcomes(1), [["provider_not_found", "chatgpt"]], "log3: provider not found -> 'provider_not_found'");
      await book({ provider_id: "fn-off" });
      assertEq(lastOutcomes(1), [["not_live", "chatgpt"]], "log4: paused producer -> 'not_live'");
      await book({ guest_email: "not-an-email" });
      assertEq(lastOutcomes(1), [["invalid_input", "chatgpt"]], "log5: invalid input -> 'invalid_input'");
      await book({}, "curl/8.0", "some-script");
      assertEq(lastOutcomes(1), [["created", null]], "log6: unknown client -> source_client NULL");
      process.env.GARDSSALG_MCP_PREVIEW_ENABLED = "true";
      const pv = JSON.parse(await book({ preview: true }));
      delete process.env.GARDSSALG_MCP_PREVIEW_ENABLED;
      assertEq(pv.preview, true, "log7: preview answered");
      assertEq(lastOutcomes(1), [["preview", "chatgpt"]], "log7b: preview -> 'preview'");
      assertEq(events().length, 7, "log8: exactly one row per tool call (7 calls)");

      const cols = (db.prepare("PRAGMA table_info(gardssalg_mcp_funnel_events)").all() as Array<{ name: string }>).map((c) => c.name);
      assertEq(cols, ["id", "created_at", "outcome", "source_client"], "log9: table has no guest/provider/ref columns");
      const allRows = JSON.stringify(events());
      for (const v of [GUEST_NAME, GUEST_EMAIL, ok.booking_ref, "fn-gard", "Fngard"]) {
        assertTrue(!allRows.includes(v), `log10: no "${v}" in the outcome log`);
      }
      assertTrue(events().every((r) => (funnel.GARDSSALG_FUNNEL_OUTCOMES as readonly string[]).includes(r.outcome)), "log11: every outcome is in the closed list");

      // Fail-open: the table is gone, the tool still answers the same way.
      db.exec("ALTER TABLE gardssalg_mcp_funnel_events RENAME TO gardssalg_mcp_funnel_events_away");
      const failOpen = JSON.parse(await book({ provider_id: "fn-off" }));
      assertEq([failOpen.success, failOpen.reason], [false, "not_live"], "log12: a failing outcome log leaves the tool result unchanged");
      db.exec("ALTER TABLE gardssalg_mcp_funnel_events_away RENAME TO gardssalg_mcp_funnel_events");

      // Retention: a row older than 90 days goes on the next (hourly) prune.
      const now = Date.now();
      db.prepare("INSERT INTO gardssalg_mcp_funnel_events (created_at, outcome, source_client) VALUES (?, 'search', 'claude')")
        .run(new Date(now - 100 * 86_400_000).toISOString());
      db.prepare("INSERT INTO gardssalg_mcp_funnel_events (created_at, outcome, source_client) VALUES (?, 'search', 'claude')")
        .run(new Date(now - 40 * 86_400_000).toISOString());
      funnel.__resetGardssalgFunnelPruneForTesting();
      funnel.recordGardssalgFunnelEvent("search", "claude", now);
      const claude = events().filter((r) => r.source_client === "claude");
      assertEq(claude.length, 2, "log13: the 100-day-old row is pruned, the 40-day-old and the new row stay");
      funnel.recordGardssalgFunnelEvent("not-a-code" as any, "claude", now);
      funnel.recordGardssalgFunnelEvent("search", "<script>", now);
      assertEq(events().slice(-1)[0].source_client, null, "log14: an unknown label is stored as NULL; an unknown code is not stored");
      assertEq(events().filter((r) => r.source_client === "claude").length, 2, "log14b: unknown code wrote nothing");

      // ── (cls) classification of the other branches ──────────────────────
      const txt = (p: unknown, isError?: boolean) => ({ content: [{ type: "text", text: typeof p === "string" ? p : JSON.stringify(p) }], ...(isError ? { isError } : {}) });
      assertEq(funnel.classifyBookGardssalgResult(txt("Opplevagent had an internal error.", true)), "internal_error", "cls1: internal-error text -> internal_error");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: true, pending: true, duplicate: true, booking_ref: "X" })), "duplicate", "cls2: duplicate");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: false, outside_hours: true })), "outside_hours", "cls3: outside_hours");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: false, cap_reached: true, reason: "cap_reached" })), "cap_reached", "cls4: cap_reached");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: false, reason: "owner_paused" })), "owner_paused", "cls5: owner_paused");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: false, error: "internal_error" }, true)), "internal_error", "cls6: createBooking failure");
      assertEq(funnel.classifyBookGardssalgResult(txt({ success: false, reason: "weekday_mismatch", weekday_mismatch: true })), "weekday_mismatch", "cls7: weekday_mismatch");
      assertEq(funnel.classifyBookGardssalgResult(txt({ something: 1 })), "other", "cls8: anything else -> other");

      // ── (adm) admin GET ─────────────────────────────────────────────────
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const noKey = await callAdmin(opplevelserRouter, {}, {});
      assertEq([noKey.status, noKey.body?.total], [403, undefined], "adm1: no X-Admin-Key -> 403, no payload (as bookings-count)");
      const badKey = await callAdmin(opplevelserRouter, {}, { "x-admin-key": "wrong" });
      assertEq(badKey.status, 403, "adm2: wrong X-Admin-Key -> 403");

      // Booking stages: one created MCP booking confirmed; an unknown-client
      // booking cancelled; a test row and a web-form row are not counted.
      db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed' WHERE booking_ref = ?").run(ok.booking_ref);
      db.prepare("UPDATE gardssalg_bookings SET status = 'cancelled' WHERE source_client IS NULL AND source = 'mcp'").run();
      const ins = db.prepare(
        `INSERT INTO gardssalg_bookings (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, booking_ref, confirm_token, source, status, created_at, is_test, source_client, pre_status)
         VALUES (?, 'fn-gard', '2030-01-01T10:00:00Z', 1, 'X Y', 'x@example.no', ?, ?, ?, 'reserved', ?, ?, 'chatgpt', ?)`,
      );
      ins.run("fx-1", "OPP-FX-1", "tok-fx-1", "mcp", new Date(now).toISOString(), 1, "provider_declined");
      ins.run("fx-2", "OPP-FX-2", "tok-fx-2", "opplevagent", new Date(now).toISOString(), 0, "provider_declined");
      ins.run("fx-3", "OPP-FX-3", "tok-fx-3", "mcp", new Date(now).toISOString(), 0, "expired");
      ins.run("fx-4", "OPP-FX-4", "tok-fx-4", "mcp", new Date(now - 40 * 86_400_000).toISOString(), 0, "provider_declined");

      const res = await callAdmin(opplevelserRouter, {}, { "x-admin-key": adminKey });
      assertEq(res.status, 200, "adm3: valid key -> 200");
      assertEq([res.body.success, res.body.days], [true, 30], "adm4: default days 30");
      assertEq(res.body.outcome_codes, funnel.GARDSSALG_FUNNEL_OUTCOMES, "adm5: outcome_codes is the closed list");
      const c = res.body.by_client.chatgpt;
      assertEq(
        [c.search, c.attempt, c.created, c.pending, c.confirmed, c.declined, c.expired, c.cancelled],
        [1, 4, 1, 0, 1, 0, 1, 0],
        "adm6: chatgpt: search 1, attempt 4 (preview not counted), created 1, confirmed 1, expired 1 (test/web/old rows not counted)",
      );
      assertEq(
        [c.outcomes.created, c.outcomes.provider_not_found, c.outcomes.not_live, c.outcomes.invalid_input, c.outcomes.preview],
        [1, 1, 1, 1, 1],
        "adm7: chatgpt outcome breakdown",
      );
      const u = res.body.by_client.unknown;
      assertEq([u.created, u.attempt, u.cancelled, u.search], [1, 1, 1, 1], "adm8: NULL client shown as 'unknown' (created 1, cancelled 1, the '<script>' search 1)");
      assertEq(res.body.by_client.claude.search, 1, "adm9: claude: one search in 30 days (the 40-day-old row is outside)");
      const t = res.body.total;
      assertEq([t.search, t.attempt, t.created, t.confirmed, t.cancelled, t.expired], [3, 5, 2, 1, 1, 1], "adm10: total sums every client");
      assertEq(Object.keys(res.body).sort(), ["by_client", "days", "outcome_codes", "since", "success", "total"], "adm11: counts only — no rows");
      const resText = JSON.stringify(res.body);
      for (const v of [GUEST_NAME, GUEST_EMAIL, ok.booking_ref, "x@example.no", "OPP-FX", "fn-gard"]) {
        assertTrue(!resText.includes(v), `adm12: no "${v}" in the answer`);
      }

      const wide = await callAdmin(opplevelserRouter, { days: "60" }, { "x-admin-key": adminKey });
      assertEq([wide.status, wide.body.days, wide.body.by_client.claude.search, wide.body.by_client.chatgpt.declined], [200, 60, 2, 1], "adm13: days=60 takes in the 40-day-old search and booking");
      for (const bad of ["0", "91", "abc", "1.5", "-3", ""]) {
        const r = await callAdmin(opplevelserRouter, { days: bad }, { "x-admin-key": adminKey });
        assertEq(r.status, 400, `adm14: days=${JSON.stringify(bad)} -> 400`);
      }
      const arr = await callAdmin(opplevelserRouter, { days: ["7", "8"] as any }, { "x-admin-key": adminKey });
      assertEq(arr.status, 400, "adm15: repeated days -> 400");
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
  runOpplevelserGardssalgMcpFunnelTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
