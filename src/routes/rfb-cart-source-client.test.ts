/**
 * rfb-cart-source-client.test.ts — dev-request
 * 2026-11-12-rfb-c1-claude-knapp-sporing-gjenkjenning, slice C1-B2.
 *
 * A Rett fra Bonden cart records which AI assistant it came from in
 * carts.source_client, and every order submitted from it copies the value to
 * orders.source_client. Only one fixed label of SOURCE_CLIENT_LABELS
 * (utils/url-utm.ts, the F1-1 set) or NULL is ever stored:
 *
 *   (s)  schema — carts.source_client / orders.source_client exist, nullable,
 *        no default.
 *   (u)  unit — createCart stores only an allow-listed label; submitCart copies
 *        it to every order (and never copies a non-label value).
 *   (m)  AK1 over the real /mcp router (initialize + tools/call): a Claude
 *        session (by User-Agent, and by initialize client name) → 'claude';
 *        a ChatGPT session → 'chatgpt'; an unknown client → NULL. The
 *        lokal_cart_create answer has exactly its old keys.
 *   (r)  AK1: POST /api/marketplace/cart (website / REST) → NULL, even when the
 *        caller is an AI client.
 *   (a)  AK3: GET /admin/api/ordre/oversikt answers 200 with
 *        rfb.by_source_client (counts per label + 'none').
 *
 * AK2 (tools/list byte-identical) is rfb-mcp-contract-freeze.test.ts, unchanged.
 *
 * Standalone: npx tsx src/routes/rfb-cart-source-client.test.ts
 * Wired into the gate via tests/test.ts.
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
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CLAUDE_UA = "Claude-User (claude-code/1.0; +https://support.anthropic.com/)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ADMIN_KEY = "rfb-cart-source-client-admin-key";

export async function runRfbCartSourceClientTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
  // Eight orders at one producer today: keep the per-producer day cap out of the way.
  const prevCap = process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY;
  process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "100";
  let server: http.Server | undefined;
  let statsRoute: typeof import("./admin-order-stats") | undefined;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const utm = require("../utils/url-utm") as typeof import("../utils/url-utm");

    // ── (s) schema ─────────────────────────────────────────────────────
    for (const table of ["carts", "orders"]) {
      const col = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>)
        .find((c) => c.name === "source_client");
      assertEq(col ? { notnull: col.notnull, dflt: col.dflt_value } : null, { notnull: 0, dflt: null }, `s1: ${table}.source_client exists, nullable, no default`);
    }

    // One producer who takes orders (opted in, verified, contact e-mail).
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
         lat, lng, city, is_active, is_verified, order_notifications_opt_in)
      VALUES ('sc-aker', 'Kildeaker Gard', 'test', 'test', 'sc-aker@example.com', 'https://example.com', 'producer', 'key-sc-aker',
              59.91, 10.75, 'Oslo', 1, 1, 1)
    `).run();
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('sc-aker', 'verified')").run();
    db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_source, availability_updated_at)
                VALUES ('prod-sc-aker', 'sc-aker', 'Poteter', 'poteter', 30, 'in_stock', 'producer_dashboard', ?)`)
      .run(new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19));
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const cartLabel = (cartId: string): unknown =>
      (db.prepare("SELECT source_client FROM carts WHERE id = ?").get(cartId) as { source_client: unknown } | undefined)?.source_client;
    const orderLabels = (cartId: string): unknown[] =>
      (db.prepare("SELECT source_client FROM orders WHERE cart_id = ? ORDER BY id").all(cartId) as Array<{ source_client: unknown }>).map((r) => r.source_client);

    // ── (u) createCart / submitCart ────────────────────────────────────
    let buyerN = 0;
    const submitOne = (cart: { cart_id: string }): void => {
      const added = cartSvc.addCartItem(cart.cart_id, "prod-sc-aker", 1);
      if (!added.success) throw new Error("addItem failed: " + JSON.stringify(added));
      const sub = cartSvc.submitCart(cart.cart_id, { buyer_email: `kjoper${++buyerN}@example.no`, contact_consent: true } as any);
      if (!sub.success) throw new Error("submitCart failed: " + JSON.stringify(sub));
    };
    const uClaude = cartSvc.createCart({ sourceClient: "claude" });
    assertEq(cartLabel(uClaude.cart_id), "claude", "u1: createCart({sourceClient:'claude'}) stores 'claude'");
    submitOne(uClaude);
    assertEq(orderLabels(uClaude.cart_id), ["claude"], "u2: submitCart copies 'claude' onto the order");
    const uChat = cartSvc.createCart({ sourceClient: "chatgpt" });
    submitOne(uChat);
    assertEq(orderLabels(uChat.cart_id), ["chatgpt"], "u3: 'chatgpt' cart → 'chatgpt' order");
    const uPlain = cartSvc.createCart();
    assertEq(cartLabel(uPlain.cart_id), null, "u4: createCart() (website / REST / A2A) → NULL");
    submitOne(uPlain);
    assertEq(orderLabels(uPlain.cart_id), [null], "u5: …and its orders → NULL");
    const uDisplay = cartSvc.createCart({ sourceClient: "Claude" });
    assertEq(cartLabel(uDisplay.cart_id), null, "u6: display name (not a slug) → NULL");
    const uRaw = cartSvc.createCart({ sourceClient: "Kari Nordmann (kari@example.no)" });
    assertEq(cartLabel(uRaw.cart_id), null, "u7: arbitrary string → NULL, never the raw value");
    const uOther = cartSvc.createCart({ sourceClient: "other" });
    assertEq(cartLabel(uOther.cart_id), null, "u8: 'other' is not in the F1-1 label set → NULL");
    // A non-label value that somehow sits in carts is never copied to an order.
    const uTampered = cartSvc.createCart();
    db.prepare("UPDATE carts SET source_client = 'ola@example.no' WHERE id = ?").run(uTampered.cart_id);
    submitOne(uTampered);
    assertEq(orderLabels(uTampered.cart_id), [null], "u9: submitCart copies only an allow-listed label");

    // ── (m) AK1 over the real /mcp router ──────────────────────────────
    const mcpRouter = (require("./mcp") as typeof import("./mcp")).default;
    const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
    statsRoute = require("./admin-order-stats") as typeof import("./admin-order-stats");
    statsRoute.__setAdminOrderStatsTestDbs(db as any, null);
    statsRoute.__setAdminOrderStatsNowForTesting(null);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpRouter);
    app.use("/api/marketplace", cartRouter);
    app.use("/admin/api/ordre", statsRoute.default);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // node:http, not the global fetch: other suites in the gate stub
    // globalThis.fetch while they run.
    function request(method: string, path: string, headers: Record<string, string>, payload?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
      return new Promise((resolve, reject) => {
        const data = payload === undefined ? "" : JSON.stringify(payload);
        const req = http.request(`${base}${path}`, { method, headers: { ...headers, "Content-Length": String(Buffer.byteLength(data)) } }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { text += c; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        });
        req.on("error", reject);
        req.end(data);
      });
    }
    async function mcpSession(ua: string, clientName: string) {
      const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": ua };
      const init = await request("POST", "/mcp", h, {
        jsonrpc: "2.0", method: "initialize", id: "1",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
      });
      const sid = init.headers["mcp-session-id"];
      if (typeof sid !== "string") throw new Error("initialize returned no mcp-session-id: " + init.text.slice(0, 300));
      const sh = { ...h, "mcp-session-id": sid };
      await request("POST", "/mcp", sh, { jsonrpc: "2.0", method: "notifications/initialized" });
      let n = 2;
      const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const res = await request("POST", "/mcp", sh, { jsonrpc: "2.0", method: "tools/call", id: String(n++), params: { name, arguments: args } });
        const ct = res.headers["content-type"];
        const body = parseJsonRpcBody(res.text, typeof ct === "string" ? ct : null);
        return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      };
      return { call };
    }
    async function mcpCartAndSubmit(ua: string, clientName: string): Promise<{ cartId: string; createKeys: string[] }> {
      const s = await mcpSession(ua, clientName);
      const created = await s.call("lokal_cart_create", {});
      if (!created.cart_id) throw new Error("lokal_cart_create failed: " + JSON.stringify(created));
      const added = await s.call("lokal_cart_add_item", { cart_id: created.cart_id, buyer_ref: created.buyer_ref, product_id: "prod-sc-aker", qty: 1 });
      if (added.success !== true) throw new Error("lokal_cart_add_item failed: " + JSON.stringify(added));
      const sub = await s.call("lokal_cart_submit", { cart_id: created.cart_id, buyer_ref: created.buyer_ref, buyer_email: `mcp-kjoper${++buyerN}@example.no`, contact_consent: true });
      if (sub.success !== true) throw new Error("lokal_cart_submit failed: " + JSON.stringify(sub).slice(0, 600));
      return { cartId: created.cart_id, createKeys: Object.keys(created) };
    }

    const mClaude = await mcpCartAndSubmit(CLAUDE_UA, "claude-ai");
    assertEq(mClaude.createKeys, ["success", "cart_id", "buyer_ref"], "m0: lokal_cart_create answer keeps exactly its keys (no source_client field)");
    assertEq(cartLabel(mClaude.cartId), "claude", "m1: Claude session (User-Agent) → cart 'claude'");
    assertEq(orderLabels(mClaude.cartId), ["claude"], "m1b: …and the order source_client = 'claude'");
    const mClaudeByName = await mcpCartAndSubmit("mcp-gateway/2.0", "claude-ai");
    assertEq(orderLabels(mClaudeByName.cartId), ["claude"], "m2: unknown UA, initialize client name claude-ai → 'claude'");
    const mChat = await mcpCartAndSubmit(CHATGPT_UA, "openai-mcp");
    assertEq(orderLabels(mChat.cartId), ["chatgpt"], "m3: ChatGPT session → order 'chatgpt'");
    const mUnknown = await mcpCartAndSubmit("Kari Nordmann private agent/1.0", "Kari Nordmann laptop");
    assertEq(cartLabel(mUnknown.cartId), null, "m4: unknown client → cart NULL, never the raw name");
    assertEq(orderLabels(mUnknown.cartId), [null], "m4b: …and order NULL");
    const stored = (db.prepare("SELECT source_client FROM orders WHERE source_client IS NOT NULL UNION SELECT source_client FROM carts WHERE source_client IS NOT NULL").all() as Array<{ source_client: string }>)
      .map((r) => r.source_client)
      .filter((v) => v !== "ola@example.no"); // the row u9 wrote by hand
    assertEq(stored.every((v) => utm.SOURCE_CLIENT_LABELS.includes(v)), true, "m5: every stored value is in SOURCE_CLIENT_LABELS");

    // ── (r) website / REST → NULL ──────────────────────────────────────
    for (const [label, ua] of [["browser (website)", BROWSER_UA], ["ChatGPT-User over REST", CHATGPT_UA], ["Claude-User over REST", CLAUDE_UA]] as Array<[string, string]>) {
      const r = await request("POST", "/api/marketplace/cart", { "Content-Type": "application/json", "User-Agent": ua }, {});
      const body = JSON.parse(r.text || "{}");
      assertEq([r.status, Object.keys(body)], [201, ["success", "cart_id", "buyer_ref"]], `r: POST /api/marketplace/cart → 201, unchanged body (${label})`);
      assertEq(cartLabel(body.cart_id), null, `r: REST cart from ${label} → NULL`);
    }

    // ── (a) AK3: admin order statistics ────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const ov = await request("GET", `/admin/api/ordre/oversikt?plattform=rfb&fra=${today}&til=${today}`, { "X-Admin-Key": ADMIN_KEY });
    assertEq(ov.status, 200, "a1: GET /admin/api/ordre/oversikt → 200");
    const rfb = JSON.parse(ov.text || "{}").rfb ?? {};
    const expectedKeys = [...[...utm.SOURCE_CLIENT_LABELS].sort(), "none"];
    assertEq(Object.keys(rfb.by_source_client?.counts ?? {}), expectedKeys, "a2: by_source_client.counts has every label plus 'none'");
    assertEq(Object.keys(rfb.by_source_client?.test_counts ?? {}), expectedKeys, "a2b: by_source_client.test_counts has the same keys");
    const c = rfb.by_source_client?.counts ?? {};
    // claude: u1 + m1 + m2 = 3; chatgpt: u3 + m3 = 2; none: u5 + u9 + m4 = 3.
    assertEq([c.claude, c.chatgpt, c.none], [3, 2, 3], "a3: counts per label (claude 3, chatgpt 2, none 3)");
    const sum = Object.values(c).reduce((a: number, b) => a + Number(b), 0);
    assertEq(sum, rfb.total, "a4: the distribution adds up to rfb.total");
    assertEq(typeof rfb.by_source_client?.forklaring, "string", "a5: by_source_client has a forklaring");
    assertEq([typeof rfb.by_status, typeof rfb.total, typeof rfb.cart_handoffs], ["object", "number", "object"], "a6: the existing fields are still there");
    const unauth = await request("GET", `/admin/api/ordre/oversikt?plattform=rfb`, {});
    assertEq(unauth.status, 401, "a7: without X-Admin-Key → 401 (unchanged)");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (statsRoute) {
      statsRoute.__setAdminOrderStatsTestDbs(null, null);
      statsRoute.__setAdminOrderStatsNowForTesting(null);
    }
    if (prevCap === undefined) delete process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY; else process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = prevCap;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsKey;
    cartSvc.__setCartTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbCartSourceClientTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
