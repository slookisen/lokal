/**
 * mcp-input-limits.test.ts — dev-request 2026-10-23-mcp-sdk-1-32-sikkerhetsfiks-prod-og-npm.
 *
 * GHSA-46jr-4wx8-v453: one oversized tools/call could exhaust memory during
 * validation. All three McpServers now set `maxToolInputElements`, and the
 * lokal_discover / lokal_find_offers handlers refuse list inputs over their
 * caps (categories / tags > MCP_MAX_FILTER_LIST, items > MCP_MAX_SHOPPING_ITEMS).
 * The caps are not `.max()` in the inputSchema: that adds maxItems to
 * tools/list, and the Rett fra Bonden contract is frozen while OpenAI reviews
 * the ChatGPT app (rfb-mcp-contract-freeze.test.ts). Proven over real MCP
 * sessions on the live routers: an oversized call answers with isError: true
 * (no crash, session still usable), a call at the limit does not.
 *
 * Standalone: npx tsx src/routes/mcp-input-limits.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { MCP_MAX_TOOL_INPUT_ELEMENTS, MCP_MAX_FILTER_LIST, MCP_MAX_SHOPPING_ITEMS, mcpListTooLongResult } from "../services/mcp-input-limits";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

function post(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function parse(text: string): any {
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
  return JSON.parse(line ? line.slice(5).trim() : text);
}

export async function runMcpInputLimitsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push("✗ " + label); if (log) console.log("  ✗ " + label); }
  };

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  const servers: http.Server[] = [];
  // Hermetic experiences DB (same pattern as opplevagent-mcp-contract-freeze.test.ts).
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-mcp"),
  ]);
  try {
    const targets: Array<{ label: string; mod: string; tool: string; args: Record<string, unknown> }> = [
      { label: "rfb /mcp", mod: "./mcp", tool: "lokal_stats", args: {} },
      { label: "opplevagent", mod: "./experiences-mcp", tool: "list_experience_categories", args: {} },
      { label: "dental", mod: "./dental-mcp", tool: "tannlege_info", args: {} },
    ];
    for (const t of targets) {
      const router = (require(t.mod) as any).default;
      const app = express();
      app.use(express.json());
      app.use("/mcp", router);
      const srv = http.createServer(app);
      servers.push(srv);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
      const base = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const init = await post(url, JSON.stringify({
        jsonrpc: "2.0", id: "i", method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "input-limits-test", version: "1" } },
      }), base);
      const sid = init.headers["mcp-session-id"] as string | undefined;
      check(!!sid, `${t.label}: session opened`);
      if (!sid) continue;
      const h = { ...base, "mcp-session-id": sid };
      let id = 0;
      const call = async (args: Record<string, unknown>, tool = t.tool) =>
        parse((await post(url, JSON.stringify({ jsonrpc: "2.0", id: String(++id), method: "tools/call", params: { name: tool, arguments: args } }), h)).text);

      const over = await call({ pad: Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS + 1 }, () => "x") });
      const overText = JSON.stringify(over?.result?.content ?? "");
      check(over?.result?.isError === true && /maximum of \d+ elements/.test(overText),
        `${t.label}: ${MCP_MAX_TOOL_INPUT_ELEMENTS + 1} elements -> isError: true (element limit), not a crash`);
      const nested = await call({ a: Array.from({ length: 150 }, () => ({ k: 1 })) });
      check(nested?.result?.isError === true && /maximum of \d+ elements/.test(JSON.stringify(nested?.result?.content ?? "")),
        `${t.label}: nested objects count keys too (150 objects x 1 key + 150 items)`);
      const after = await call({});
      check(!!after?.result && !after?.error && !/maximum of \d+ elements/.test(JSON.stringify(after.result)), `${t.label}: session still answers a normal call after the rejected one`);

      if (t.mod === "./mcp") {
        const resultText = (r: any) => (r?.result?.content ?? []).map((c: any) => String(c?.text ?? "")).join("\n");
        // The refusal is the handler's own text (mcpListTooLongResult), not a
        // schema validation error: the inputSchema has no maxItems.
        const refusal = (field: string, max: number, sent: number) => mcpListTooLongResult(field, max, sent).content[0].text;

        const tooMany = await call({ items: Array.from({ length: MCP_MAX_SHOPPING_ITEMS + 1 }, (_, i) => `v${i}`), near: "Oslo" }, "lokal_find_offers");
        const tm = resultText(tooMany);
        check(tooMany?.result?.isError === true && tm === refusal("items", MCP_MAX_SHOPPING_ITEMS, MCP_MAX_SHOPPING_ITEMS + 1) && /items/.test(tm) && /at most/.test(tm),
          `lokal_find_offers: ${MCP_MAX_SHOPPING_ITEMS + 1} items -> isError from the handler, naming items and the cap`);
        const atMax = await call({ items: Array.from({ length: MCP_MAX_SHOPPING_ITEMS }, (_, i) => `v${i}`), lat: 59.9, lng: 10.7 }, "lokal_find_offers");
        check(atMax?.result?.isError !== true && !atMax?.error && resultText(atMax).includes(`of ${MCP_MAX_SHOPPING_ITEMS} items were looked up`),
          `lokal_find_offers: ${MCP_MAX_SHOPPING_ITEMS} items is accepted (soft cap note, no refusal)`);
        const normalItems = await call({ items: ["poteter", "honning", "egg"], lat: 59.9, lng: 10.7 }, "lokal_find_offers");
        check(normalItems?.result?.isError !== true && !normalItems?.error && !/at most/.test(resultText(normalItems)),
          "lokal_find_offers: a normal 3-item list is accepted");

        const cats = await call({ categories: Array.from({ length: MCP_MAX_FILTER_LIST + 1 }, (_, i) => `c${i}`) }, "lokal_discover");
        check(cats?.result?.isError === true && resultText(cats) === refusal("categories", MCP_MAX_FILTER_LIST, MCP_MAX_FILTER_LIST + 1),
          `lokal_discover: ${MCP_MAX_FILTER_LIST + 1} categories -> isError from the handler, naming categories`);
        const tags = await call({ tags: Array.from({ length: MCP_MAX_FILTER_LIST + 1 }, (_, i) => `t${i}`) }, "lokal_discover");
        check(tags?.result?.isError === true && resultText(tags) === refusal("tags", MCP_MAX_FILTER_LIST, MCP_MAX_FILTER_LIST + 1),
          `lokal_discover: ${MCP_MAX_FILTER_LIST + 1} tags -> isError from the handler, naming tags`);
        const catsAtMax = await call({ categories: Array.from({ length: MCP_MAX_FILTER_LIST }, (_, i) => `c${i}`), tags: Array.from({ length: MCP_MAX_FILTER_LIST }, (_, i) => `t${i}`) }, "lokal_discover");
        check(catsAtMax?.result?.isError !== true && !catsAtMax?.error && !/at most/.test(resultText(catsAtMax)),
          `lokal_discover: ${MCP_MAX_FILTER_LIST} categories and ${MCP_MAX_FILTER_LIST} tags are accepted`);
        const normalDiscover = await call({ categories: ["honey", "eggs"], tags: ["organic"] }, "lokal_discover");
        check(normalDiscover?.result?.isError !== true && !normalDiscover?.error && !/at most/.test(resultText(normalDiscover)),
          "lokal_discover: a normal call (2 categories, 1 tag) is accepted");

        // The contract stays frozen: tools/list carries no maxItems on these lists.
        const listed = parse((await post(url, JSON.stringify({ jsonrpc: "2.0", id: String(++id), method: "tools/list", params: {} }), h)).text);
        const toolSchema = (name: string) => (listed?.result?.tools ?? []).find((x: any) => x?.name === name)?.inputSchema?.properties ?? {};
        const discoverProps = toolSchema("lokal_discover");
        const offersProps = toolSchema("lokal_find_offers");
        check(!!discoverProps.categories && !!discoverProps.tags && !("maxItems" in discoverProps.categories) && !("maxItems" in discoverProps.tags),
          "tools/list: lokal_discover categories/tags have no maxItems (contract unchanged)");
        check(!!offersProps.items && !("maxItems" in offersProps.items) && offersProps.items.minItems === 1,
          "tools/list: lokal_find_offers items has minItems 1 and no maxItems (contract unchanged)");
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("mcp-input-limits: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    restoreModuleCache();
    if (prevDb) __setDbForTesting(prevDb as any);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpInputLimitsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
