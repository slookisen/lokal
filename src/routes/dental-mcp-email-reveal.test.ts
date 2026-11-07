/**
 * dental-mcp-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A5 for the
 * Finn-tannlege MCP: tannlege_info (the only dental MCP answer with a clinic
 * e-mail) on the per-IP e-mail limit (services/email-reveal-guard.ts), on the
 * same dental counter as REST /api/tannlege/agents[/:id] and A2A.
 *
 * Fixture (in-memory dental DB, all in Oslo, every name and address made up):
 * four clinics with an e-mail and one without. MCP over HTTP (initialize,
 * initialized, tools/call) on the real dental-mcp router, with trust proxy so
 * X-Forwarded-For picks the test IP (req.ip, as in index.ts).
 *
 *   O   switch off (unset or "off", limit 1, many calls from one IP): every
 *       tannlege_info text byte-identical to the in-memory server's (no HTTP
 *       request in reach) and to the detail card; nothing is logged
 *   U   switch on, under the limit: byte-identical to switch off
 *   L   switch on, over the limit: epost null, the text otherwise the
 *       switch-off one (the no-e-mail shape; no new field, no new text);
 *       repeat views free
 *   C   CCBot: no e-mail on its first call
 *   S   one counter with REST and A2A: a clinic REST gave counts once; the
 *       limit reached via REST (or A2A) blocks MCP
 *   N   no usable req.ip, or no HTTP request at all: no e-mail
 *   T   tannlege_search and tannlege_akutt carry no e-mail (search card)
 *
 * Standalone: npx tsx src/routes/dental-mcp-email-reveal.test.ts
 * Wired into tests/test.ts via runDentalMcpEmailRevealTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export async function runDentalMcpEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const envKeys = ["DENTAL_DB_PATH", "EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_PER_IP_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
  delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("../services/dental-clinic-card"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const logLines: string[] = [];
  const freshGuard = () => guard.__resetEmailRevealGuardForTesting({ log: (l) => logLines.push(l) });
  let closeMcp: (() => Promise<void>) | null = null;
  let closeHttp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const restRouter = (require("./dental") as typeof import("./dental")).default as any;
    const a2aRouter = (require("./dental-a2a") as typeof import("./dental-a2a")).default as any;
    const dentalMcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const { toDentalClinicCard } = require("../services/dental-clinic-card") as typeof import("../services/dental-clinic-card");

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (row: Record<string, unknown>): string => {
      const id = store.createDentalAgent({ poststed: "OSLO", fylke: "Oslo", postnummer: "0150", organisasjonsform: "AS", ...row } as any);
      db.prepare(`UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?`).run(id);
      return id;
    };
    const clinics = Array.from({ length: 4 }, (_, i) => ({
      navn: `Mcpprøve Tannklinikk ${i + 1}`,
      org_nr: `91877030${i + 1}`,
      telefon: `+47223303${String(i + 1).padStart(2, "0")}`,
      adresse: `Mcpveien ${i + 1}`,
      epost: `post${i + 1}@mcpprove-klinikk.example`,
    }));
    const ids = clinics.map((c) => add(c));
    const noEmail = { navn: "Mcputenpost Tannklinikk", org_nr: "918770399", telefon: "+4722330399", adresse: "Tomveien 19" };
    const idNoEmail = add(noEmail);
    const all = [...clinics, noEmail];

    // ── HTTP app: REST, A2A and MCP on one server ─────────────────────────
    const express = require("express") as typeof import("express");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    // N: a broken proxy chain (no usable req.ip), simulated per request.
    app.use((req: any, _res: any, next: any) => {
      if (req.headers["x-test-no-ip"]) Object.defineProperty(req, "ip", { value: "", configurable: true });
      next();
    });
    app.use("/api/tannlege", restRouter);
    app.use(a2aRouter);
    app.use("/mcp", dentalMcp.default as any);
    const http = require("http") as typeof import("http");
    const httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    closeHttp = () => new Promise<void>((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); });
    const port = (httpServer.address() as import("net").AddressInfo).port;
    const request = (method: "GET" | "POST", path: string, ip: string, headers: Record<string, string> = {}, body?: unknown): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const r = http.request({
          host: "127.0.0.1", port, path, method,
          headers: {
            "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 (test)",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { text += c; });
          res.on("end", () => {
            let parsed: any = null;
            if (String(res.headers["content-type"] || "").includes("text/event-stream")) {
              const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
              try { parsed = line ? JSON.parse(line.slice("data:".length).trim()) : null; } catch { /* not JSON */ }
            } else {
              try { parsed = JSON.parse(text); } catch { /* not JSON */ }
            }
            resolve({ status: res.statusCode ?? 0, text, headers: res.headers, body: parsed });
          });
        });
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });

    // One MCP session; the IP and User-Agent are per call (the counter keys on req.ip, not the session).
    const accept = { accept: "application/json, text/event-stream" };
    const init = await request("POST", "/mcp", "198.51.100.1", accept, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dental-mcp-email-reveal-test", version: "0.0.0" } },
    });
    const sid = String(init.headers["mcp-session-id"] ?? "");
    ok(init.status === 200 && sid !== "", `setup: MCP initialize over HTTP (status ${init.status})`);
    await request("POST", "/mcp", "198.51.100.1", { ...accept, "mcp-session-id": sid }, { jsonrpc: "2.0", method: "notifications/initialized" });
    let rpcId = 10;
    const callTool = async (name: string, args: unknown, ip: string, headers: Record<string, string> = {}): Promise<string> => {
      const r = await request("POST", "/mcp", ip, { ...accept, "mcp-session-id": sid, ...headers },
        { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } });
      return String(r.body?.result?.content?.[0]?.text ?? `no tool text: ${r.status} ${r.text.slice(0, 200)}`);
    };
    const info = (orgNr: string, ip: string, headers?: Record<string, string>) => callTool("tannlege_info", { org_nr: orgNr }, ip, headers);
    const infoAll = (ip: string) => Promise.all(all.map((c) => info(c.org_nr, ip)));
    const epostOf = (text: string) => { try { return JSON.parse(text).epost; } catch { return `unparsable: ${text.slice(0, 80)}`; } };
    /** The text a withheld clinic gets: the switch-off text with epost null (the no-e-mail shape). */
    const withoutEmail = (text: string) => JSON.stringify({ ...JSON.parse(text), epost: null }, null, 2);

    // In-memory server: the same tool with no HTTP request in reach.
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const memServer = new McpServer({ name: "dental-mcp-email-reveal-test", version: "0.0.0" });
    dentalMcp.registerDentalTools(memServer);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const memClient = new Client({ name: "dental-mcp-email-reveal-test", version: "0.0.0" });
    await Promise.all([memServer.connect(st), memClient.connect(ct)]);
    closeMcp = async () => { await memClient.close(); await memServer.close(); };
    const memInfoAll = () => Promise.all(all.map(async (c) =>
      String(((await memClient.callTool({ name: "tannlege_info", arguments: { org_nr: c.org_nr } })) as any).content[0].text)));

    // ── O: switch off ─────────────────────────────────────────────────────
    freshGuard();
    const off = await infoAll("203.0.113.30");
    eq(off.map(epostOf), [...clinics.map((c) => c.epost), null], "O1: switch unset -> tannlege_info gives each stored e-mail; the clinic without one has epost null");
    eq(off, await memInfoAll(), "O2: switch unset -> HTTP texts byte-identical to the in-memory server's (no request in reach, the unguarded path)");
    {
      // The text is the detail card as main wrote it (JSON, 2-space indent), the profile link tagged for MCP.
      const cardTexts = [...ids, idNoEmail].map((id) => {
        const card = toDentalClinicCard(store.getDentalAgentById(id)!, "detail", { specialists: [] }) as any;
        return JSON.stringify({ ...card, profil_url: "<profil_url>" }, null, 2);
      });
      eq(off.map((t) => JSON.stringify({ ...JSON.parse(t), profil_url: "<profil_url>" }, null, 2)), cardTexts,
        "O3: switch unset -> each text is the unmodified detail card (same keys, order, values)");
    }
    process.env.EMAIL_REVEAL_GUARD_DENTAL = "off";
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
    eq(await infoAll("203.0.113.30"), off, "O4: switch \"off\", limit 1, same IP again -> byte-identical to switch unset");
    eq(await infoAll("203.0.113.30"), off, "O5: ... a third round -> still identical (nothing counted)");
    eq(await info(clinics[0]!.org_nr, "203.0.113.30", { "user-agent": "CCBot/2.0" }), off[0], "O6: switch off -> CCBot gets the same text (no-op)");
    eq(await info(clinics[0]!.org_nr, "203.0.113.30", { "x-test-no-ip": "1" }), off[0], "O7: switch off -> no usable IP gets the same text (no-op)");
    eq(logLines, [], "O8: switch off -> no guard log line");
    delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;

    // ── U: switch on, under the limit ─────────────────────────────────────
    process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
    freshGuard();
    eq(await infoAll("203.0.113.31"), off, "U1: switch on, under the limit -> every text byte-identical to switch off");

    // ── L: switch on, limit 2 ─────────────────────────────────────────────
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "2";
    freshGuard();
    {
      const ip = "198.51.100.40";
      const got = await infoAll(ip);
      eq(got.map(epostOf), [clinics[0]!.epost, clinics[1]!.epost, null, null, null], "L1: limit 2 -> e-mail for the first 2 clinics, then epost null");
      eq(got.slice(0, 2), off.slice(0, 2), "L2: ... the allowed ones byte-identical to switch off");
      eq(got.slice(2, 4), off.slice(2, 4).map(withoutEmail), "L3: ... a withheld one is its switch-off text with epost null (no new field, no new text)");
      eq(got[4], off[4], "L4: ... the clinic without e-mail byte-identical to switch off");
      eq(Object.keys(JSON.parse(got[2]!)), Object.keys(JSON.parse(off[2]!)), "L5: ... same keys in the same order as switch off");
      eq(await info(clinics[0]!.org_nr, ip), off[0], "L6: a repeat view of an allowed clinic -> still the e-mail (free)");
      eq(epostOf(await info(clinics[3]!.org_nr, ip)), null, "L7: a further clinic -> still withheld");
      eq(epostOf(await info(clinics[2]!.org_nr, "198.51.100.41")), clinics[2]!.epost, "L8: another IP has its own count");
    }

    // ── C: CCBot ──────────────────────────────────────────────────────────
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "30";
    freshGuard();
    {
      const ccbot = { "user-agent": "CCBot/2.0 (https://commoncrawl.org/faq/)" };
      const t = await info(clinics[0]!.org_nr, "192.0.2.50", ccbot);
      eq(t, withoutEmail(off[0]!), "C1: CCBot, first call -> epost null, the rest as switch off");
      eq(epostOf(await info(clinics[0]!.org_nr, "192.0.2.50")), clinics[0]!.epost, "C2: the same IP as a browser -> e-mail (CCBot's call counted nothing)");
    }

    // ── S: one counter with REST and A2A ──────────────────────────────────
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "2";
    freshGuard();
    {
      const ip = "198.51.100.60";
      eq((await request("GET", `/api/tannlege/agents/${ids[0]}`, ip)).body?.agent?.epost, clinics[0]!.epost, "S1: REST /agents/:id of clinic 1 -> e-mail");
      eq(epostOf(await info(clinics[0]!.org_nr, ip)), clinics[0]!.epost, "S2: then MCP tannlege_info of clinic 1 -> e-mail (already counted)");
      eq(epostOf(await info(clinics[1]!.org_nr, ip)), clinics[1]!.epost, "S3: MCP clinic 2 -> e-mail (clinic 1 counted once, so this is the 2nd)");
      eq(epostOf(await info(clinics[2]!.org_nr, ip)), null, "S4: MCP clinic 3 -> withheld (limit 2 reached)");
      eq((await request("GET", `/api/tannlege/agents/${ids[2]}`, ip)).body?.agent?.epost, null, "S5: ... and REST agrees for clinic 3");

      const ip2 = "198.51.100.61";
      await request("GET", `/api/tannlege/agents/${ids[0]}`, ip2);
      await request("GET", `/api/tannlege/agents/${ids[1]}`, ip2);
      eq(epostOf(await info(clinics[2]!.org_nr, ip2)), null, "S6: limit reached via REST -> MCP tannlege_info of a new clinic withheld");
      eq(epostOf(await info(clinics[1]!.org_nr, ip2)), clinics[1]!.epost, "S7: ... a clinic REST already gave -> e-mail via MCP");

      const ip3 = "198.51.100.62";
      const a2aInfo = (orgNr: string) => request("POST", "/a2a", ip3, {}, { jsonrpc: "2.0", id: "e", method: "message/send", params: { message: { text: `info om ${orgNr}` } } });
      await a2aInfo(clinics[0]!.org_nr);
      await a2aInfo(clinics[1]!.org_nr);
      eq(epostOf(await info(clinics[3]!.org_nr, ip3)), null, "S8: limit reached via A2A -> MCP withheld");
      eq((await a2aInfo(clinics[2]!.org_nr)).body?.result?.artifacts?.[0]?.parts?.[0]?.data?.epost, null, "S9: ... and A2A withholds a new one too");
    }

    // ── N: no usable IP / no HTTP request ─────────────────────────────────
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "30";
    freshGuard();
    {
      eq(await info(clinics[0]!.org_nr, "192.0.2.70", { "x-test-no-ip": "1" }), withoutEmail(off[0]!), "N1: no usable req.ip -> epost null, the rest as switch off");
      ok(logLines.some((l) => l.includes('"reason":"no_ip"')), "N2: ... logged with reason no_ip");
      eq((await memInfoAll()).map(epostOf), [null, null, null, null, null], "N3: switch on, no HTTP request in reach (in-memory) -> no e-mail (fail closed)");
      eq(epostOf(await info(clinics[0]!.org_nr, "192.0.2.70")), clinics[0]!.epost, "N4: the same IP with req.ip -> e-mail");
    }

    // ── T: the other dental MCP answers carry no e-mail ───────────────────
    {
      const search = await callTool("tannlege_search", { fylke: "Oslo", limit: 25 }, "192.0.2.80");
      const akutt = await callTool("tannlege_akutt", { fylke: "Oslo" }, "192.0.2.80");
      ok(search.includes("Mcpprøve") && !search.includes("@") && !/"epost"/.test(search), "T1: tannlege_search lists the clinics, no e-mail in the answer");
      ok(!akutt.includes("@mcpprove") && !/"epost"/.test(akutt), "T2: tannlege_akutt -> no e-mail in the answer");
    }

    ok(logLines.length > 0 && logLines.every((l) => !l.includes("@") && !l.includes("mcpprove")), `G1: ${logLines.length} guard log lines, none with an e-mail address`);
  } catch (err: any) {
    failed++;
    failures.push("dental mcp email reveal: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (closeMcp) await closeMcp().catch(() => {});
    if (closeHttp) await closeHttp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalMcpEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
