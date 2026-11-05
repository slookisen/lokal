/**
 * dental-email-reveal-guard.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 1:
 * the per-IP e-mail limit (services/email-reveal-guard.ts) wired into
 * Finn-tannlege REST (GET /api/tannlege/agents and /agents/:id) and A2A
 * message/send (tannlege_info by org.nr and the search list).
 *
 * Fixture (in-memory dental DB, all in Oslo, every name and address made up):
 * six clinics with an e-mail (one with field_provenance entries for it) and
 * one without.
 *
 *   O   switch off (unset or "off"): REST and A2A bodies identical to each
 *       other, every e-mail as stored however often one IP asks, no
 *       Cache-Control from the guard
 *   U   switch on, under the limit: the same bodies as switch off
 *   L   switch on, limit 3: a list gives e-mail for 3 clinics; the rest have
 *       `epost: null` and are otherwise byte-identical to their switch-off
 *       form (the no-e-mail shape, no new field); repeat views are free
 *   A   A2A shares the counter with REST (both ways), info and list
 *   C   CCBot: no e-mail on its first request, REST and A2A
 *   K   X-Admin-Key: not limited
 *   P   Places rule off (public field_provenance): the e-mail's provenance
 *       entries go with the e-mail, the rest stays
 *   H   Cache-Control: private with the switch on; none with it off
 *   M   MCP tannlege_info: unchanged by the switch and the counter
 *   G   the log lines carry no e-mail address
 *
 * Standalone: npx tsx src/routes/dental-email-reveal-guard.test.ts
 * Wired into tests/test.ts via runDentalEmailRevealGuardTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult {
  status: number;
  text: string;
  body: any;
  cacheControl?: string;
}

export async function runDentalEmailRevealGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

  const envKeys = ["DENTAL_DB_PATH", "ADMIN_KEY", "EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_PER_IP_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.DENTAL_DB_PATH = ":memory:";
  const adminKey = process.env.ADMIN_KEY || "dental-email-reveal-test-key";
  process.env.ADMIN_KEY = adminKey;
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
  const policy = require("../services/places-display-policy") as typeof import("../services/places-display-policy");
  // F2-S7: the raw REST answers' Helfo/akutt rule sets Cache-Control too; H
  // below turns it off with the Places rule, so only the guard sets it.
  const restClaims = require("../services/dental-rest-claims") as typeof import("../services/dental-rest-claims");
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

    // ── Fixture ───────────────────────────────────────────────────────────
    const src = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-09-02T10:00:00.000Z" });
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ poststed: "OSLO", fylke: "Oslo", postnummer: "0150", organisasjonsform: "AS", ...row } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    const clinics = Array.from({ length: 6 }, (_, i) => ({
      navn: `Epostprøve Tannklinikk ${i + 1}`,
      org_nr: `91877020${i + 1}`,
      telefon: `+47223302${String(i + 1).padStart(2, "0")}`,
      adresse: `Prøveveien ${i + 1}`,
      epost: `post${i + 1}@epostprove-klinikk.example`,
    }));
    const ids = clinics.map((c, i) =>
      add(c, i === 0 ? { field_provenance: { email: [src("own_homepage", c.epost)], phone: [src("brreg", c.telefon)] } } : {}));
    const noEmail = { navn: "Utenpost Tannklinikk", org_nr: "918770299", telefon: "+4722330299", adresse: "Tomveien 9" };
    const idNoEmail = add(noEmail);
    const emailOf = new Map(ids.map((id, i) => [id, clinics[i]!.epost]));
    const allIds = [...ids, idNoEmail];

    // ── HTTP app (trust proxy as in index.ts, so X-Forwarded-For picks the test IP) ──
    const express = require("express") as typeof import("express");
    const cors = require("cors") as typeof import("cors");
    const { corsOptions } = require("../middleware/security") as typeof import("../middleware/security");
    const app = express();
    app.set("trust proxy", true);
    app.use(cors(corsOptions));
    app.use(express.json());
    app.use("/api/tannlege", restRouter);
    app.use(a2aRouter);
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
            origin: "https://claude.ai", "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 (test)",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { text += c; });
          res.on("end", () => {
            let parsed: any = null;
            try { parsed = JSON.parse(text); } catch { /* not JSON */ }
            resolve({ status: res.statusCode ?? 0, text, body: parsed, cacheControl: res.headers["cache-control"] as string | undefined });
          });
        });
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    const list = (ip: string, headers?: Record<string, string>) => request("GET", "/api/tannlege/agents?fylke=Oslo", ip, headers);
    const one = (id: string, ip: string, headers?: Record<string, string>) => request("GET", `/api/tannlege/agents/${id}`, ip, headers);
    const a2a = (ip: string, message: unknown, headers?: Record<string, string>) =>
      request("POST", "/a2a", ip, headers, { jsonrpc: "2.0", id: "epost", method: "message/send", params: { message } });
    const a2aInfo = (orgNr: string, ip: string, headers?: Record<string, string>) => a2a(ip, { text: `info om ${orgNr}` }, headers);
    const a2aList = (ip: string, headers?: Record<string, string>) => a2a(ip, { data: { fylke: "Oslo" } }, headers);
    // A2A answers carry a taskId and a timestamp from the clock; compare without them.
    const stable = (text: string) => text.replace(/"taskId":"[^"]*"/g, '"taskId":"-"').replace(/"timestamp":"[^"]*"/g, '"timestamp":"-"');
    const a2aClinic = (r: HttpResult) => r.body.result.artifacts[0].parts[0].data;
    const a2aClinics = (r: HttpResult) => r.body.result.artifacts[1].parts[0].data.clinics as any[];
    const withEmail = (agents: any[]) => agents.filter((a) => a.epost).map((a) => a.id).sort();

    /** Every surface for one IP: list, each /:id, each A2A info, the A2A list. */
    const surfaces = async (ip: string) => {
      const out: Record<string, { text: string; cacheControl?: string }> = {};
      const keep = (label: string, r: HttpResult, a2aText = false) => { out[label] = { text: a2aText ? stable(r.text) : r.text, cacheControl: r.cacheControl }; };
      keep("list", await list(ip));
      for (const [i, id] of allIds.entries()) keep(`one ${i}`, await one(id, ip));
      for (const [i, c] of [...clinics, noEmail].entries()) keep(`a2a info ${i}`, await a2aInfo(c.org_nr, ip), true);
      keep("a2a list", await a2aList(ip), true);
      return out;
    };
    const textsOf = (s: Record<string, { text: string }>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.text]));

    // ── O: switch off ─────────────────────────────────────────────────────
    freshGuard();
    const off = await surfaces("203.0.113.10");
    {
      const offList = JSON.parse(off.list!.text).agents as any[];
      eq(withEmail(offList), [...ids].sort(), "O1: switch unset -> /agents gives every stored e-mail");
      eq(offList.find((a) => a.id === idNoEmail).epost, null, "O1b: the clinic without e-mail has epost: null (the no-e-mail shape)");
      eq(allIds.map((id, i) => JSON.parse(off[`one ${i}`]!.text).agent.epost), [...ids.map((id) => emailOf.get(id)), null], "O2: /agents/:id gives each stored e-mail");
      eq(clinics.map((_, i) => JSON.parse(off[`a2a info ${i}`]!.text).result.artifacts[0].parts[0].data.epost), clinics.map((c) => c.epost), "O3: A2A info gives each stored e-mail");
      eq(withEmail(JSON.parse(off["a2a list"]!.text).result.artifacts[1].parts[0].data.clinics), [...ids].sort(), "O4: A2A list gives every stored e-mail");
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "off";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
      eq(textsOf(await surfaces("203.0.113.10")), textsOf(off), "O5: switch \"off\" (limit 1, same IP again) -> every body byte-identical to switch unset");
      eq(textsOf(await surfaces("203.0.113.10")), textsOf(off), "O6: ... a third full round from the same IP -> still identical (nothing is counted)");
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      eq(logLines, [], "O7: switch off -> no guard log line");
    }

    // ── U: switch on, under the limit ─────────────────────────────────────
    process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
    freshGuard();
    {
      const on = await surfaces("203.0.113.11");
      eq(textsOf(on), textsOf(off), "U1: switch on, under the limit -> every body byte-identical to switch off");
    }

    // ── L: switch on, limit 3 ─────────────────────────────────────────────
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "3";
    freshGuard();
    const offList = JSON.parse(off.list!.text).agents as any[];
    const offOne = (id: string) => JSON.parse(off[`one ${allIds.indexOf(id)}`]!.text).agent;
    const ipA = "198.51.100.20";
    let allowedA: string[] = [];
    {
      const r = await list(ipA);
      const agents = r.body.agents as any[];
      allowedA = withEmail(agents);
      eq(allowedA.length, 3, "L1: /agents from one IP, limit 3 -> e-mail for exactly 3 of the 6 clinics that have one");
      eq(allowedA, offList.filter((a) => a.epost).slice(0, 3).map((a) => a.id).sort(), "L2: ... the first 3 of the list, in list order");
      for (const a of agents) {
        const before = offList.find((x) => x.id === a.id);
        const expected = allowedA.includes(a.id) || !before.epost ? before : { ...before, epost: null };
        ok(same(a, expected), `L3 ${a.id === idNoEmail ? "no-e-mail clinic" : allowedA.includes(a.id) ? "allowed" : "withheld"}: the answer is the switch-off one${allowedA.includes(a.id) || a.id === idNoEmail ? "" : " with epost: null, same keys in the same order"}`);
      }
      eq(r.body.count, offList.length, "L4: count unchanged");
      const again = await list(ipA);
      eq(withEmail(again.body.agents), allowedA, "L5: the same list again -> the same 3 (repeat views are free)");
      const withheldId = ids.find((id) => !allowedA.includes(id))!;
      const oneWithheld = (await one(withheldId, ipA)).body.agent;
      eq(oneWithheld, { ...offOne(withheldId), epost: null }, "L6: /agents/:id of a withheld clinic -> epost: null, the rest as switch off");
      eq((await one(allowedA[0]!, ipA)).body.agent, offOne(allowedA[0]!), "L7: /agents/:id of an allowed clinic -> as switch off (e-mail kept)");
      const orgOf = (id: string) => clinics[ids.indexOf(id)]!.org_nr;
      eq((await one(orgOf(withheldId), ipA)).body.agent.epost, null, "L8: /agents/<org.nr> of a withheld clinic -> epost: null");
      eq((await one(idNoEmail, ipA)).body.agent, offOne(idNoEmail), "L9: the clinic without e-mail -> as switch off");
    }

    // ── A: A2A shares the counter ─────────────────────────────────────────
    {
      const orgOf = (id: string) => clinics[ids.indexOf(id)]!.org_nr;
      const withheldId = ids.find((id) => !allowedA.includes(id))!;
      eq(a2aClinic(await a2aInfo(orgOf(allowedA[1]!), ipA)).epost, emailOf.get(allowedA[1]!), "A1: A2A info of a clinic REST already gave -> e-mail (same counter)");
      const infoWithheld = await a2aInfo(orgOf(withheldId), ipA);
      const offInfo = JSON.parse(off[`a2a info ${ids.indexOf(withheldId)}`]!.text);
      eq(a2aClinic(infoWithheld), { ...offInfo.result.artifacts[0].parts[0].data, epost: null }, "A2: A2A info of a new clinic over the limit -> epost: null, the rest as switch off");
      const l = await a2aList(ipA);
      eq(withEmail(a2aClinics(l)), allowedA, "A3: A2A list -> e-mail only for the 3 already counted");
      const offA2aList = JSON.parse(off["a2a list"]!.text).result.artifacts[1].parts[0].data.clinics as any[];
      ok(a2aClinics(l).every((c) => same(c, allowedA.includes(c.id) || !c.epost && !offA2aList.find((x) => x.id === c.id).epost
        ? offA2aList.find((x) => x.id === c.id) : { ...offA2aList.find((x) => x.id === c.id), epost: null })),
        "A4: ... every other clinic is its switch-off form with epost: null");
      eq(stable(l.text).replace(/"epost":(null|"[^"]*")/g, ""), stable(JSON.stringify(JSON.parse(off["a2a list"]!.text))).replace(/"epost":(null|"[^"]*")/g, ""),
        "A5: the A2A list differs from switch off only in epost values");
      const ipB = "198.51.100.21";
      const lb = await a2aList(ipB);
      const allowedB = withEmail(a2aClinics(lb));
      eq(allowedB.length, 3, "A6: a new IP, A2A list first -> 3 e-mails");
      const restB = (await list(ipB)).body.agents as any[];
      eq(withEmail(restB), allowedB, "A7: ... then REST /agents from that IP -> the same 3 (A2A counted for REST)");
    }

    // ── C: CCBot ──────────────────────────────────────────────────────────
    {
      const ccbot = { "user-agent": "CCBot/2.0 (https://commoncrawl.org/faq/)" };
      const ipC = "192.0.2.77";
      eq(withEmail((await list(ipC, ccbot)).body.agents), [], "C1: CCBot, first request -> /agents without any e-mail");
      eq((await one(ids[1]!, ipC, ccbot)).body.agent.epost, null, "C2: CCBot -> /agents/:id without e-mail");
      eq(a2aClinic(await a2aInfo(clinics[1]!.org_nr, ipC, ccbot)).epost, null, "C3: CCBot -> A2A info without e-mail");
      eq(withEmail(a2aClinics(await a2aList(ipC, ccbot))), [], "C4: CCBot -> A2A list without e-mail");
      eq(withEmail((await list(ipC)).body.agents).length, 3, "C5: the same IP as a browser -> its own 3 (CCBot's requests counted nothing)");
    }

    // ── K: X-Admin-Key ────────────────────────────────────────────────────
    {
      const admin = { "x-admin-key": adminKey };
      eq(withEmail((await list(ipA, admin)).body.agents), [...ids].sort(), "K1: X-Admin-Key from an IP over the limit -> every e-mail");
      const withheldId = ids.find((id) => !allowedA.includes(id))!;
      eq((await one(withheldId, ipA, admin)).body.agent.epost, emailOf.get(withheldId), "K2: ... and /agents/:id too");
      eq((await one(withheldId, ipA, { "x-admin-key": "wrong" })).body.agent.epost, null, "K3: a wrong key gets the public, limited answer");
    }

    // ── P: Places rule off — public field_provenance ──────────────────────
    policy.__setPlacesDisplayPolicyForTesting(false);
    restClaims.__setRestClaimsRequireSourceForTesting(false);
    try {
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "0";
      freshGuard();
      const withheld = (await one(ids[0]!, "192.0.2.88")).body.agent;
      eq([withheld.epost, withheld.field_provenance], [null, { phone: [src("brreg", clinics[0]!.telefon)] }],
        "P1: withheld -> epost null and the e-mail's field_provenance entries gone, the phone's stay");
      const fromList = ((await list("192.0.2.88")).body.agents as any[]).find((a) => a.id === ids[0]);
      eq(fromList.field_provenance, { phone: [src("brreg", clinics[0]!.telefon)] }, "P2: ... in /agents too");
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      const shownOff = (await one(ids[0]!, "192.0.2.88")).body.agent;
      eq([shownOff.epost, Object.keys(shownOff.field_provenance)], [clinics[0]!.epost, ["email", "phone"]], "P3: switch off -> e-mail and its provenance as before");

      // ── H: headers (Places rule off, so only the guard sets Cache-Control) ──
      eq([(await one(ids[2]!, "192.0.2.89")).cacheControl, (await list("192.0.2.89")).cacheControl, (await a2aList("192.0.2.89")).cacheControl],
        [undefined, undefined, undefined], "H1: switch off -> no Cache-Control (as on main)");
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "30";
      eq([(await one(ids[2]!, "192.0.2.89")).cacheControl, (await one(idNoEmail, "192.0.2.89")).cacheControl, (await list("192.0.2.89")).cacheControl,
        (await a2aList("192.0.2.89")).cacheControl, (await a2aInfo(noEmail.org_nr, "192.0.2.89")).cacheControl, (await one(ids[2]!, "192.0.2.89", { "x-admin-key": adminKey })).cacheControl],
        ["private", "private", "private", "private", "private", "private"],
        "H2: switch on -> Cache-Control: private on /agents/:id (also without e-mail), /agents, A2A list and info, and the admin view");
    } finally {
      policy.__setPlacesDisplayPolicyForTesting(null);
      restClaims.__setRestClaimsRequireSourceForTesting(null);
    }

    // ── M: MCP tannlege_info is not part of this slice ────────────────────
    {
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
      const server = new McpServer({ name: "dental-email-reveal-test", version: "0.0.0" });
      (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "dental-email-reveal-test", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      closeMcp = async () => { await client.close(); await server.close(); };
      const info = async () => Promise.all(clinics.map(async (c) => ((await client.callTool({ name: "tannlege_info", arguments: { org_nr: c.org_nr } })) as any).content[0].text as string));
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      const mcpOff = await info();
      eq(mcpOff.map((t) => JSON.parse(t).epost), clinics.map((c) => c.epost), "M1: switch off -> tannlege_info gives each e-mail");
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "0";
      freshGuard();
      eq(await info(), mcpOff, "M2: switch on, limit 0 -> tannlege_info byte-identical to switch off (MCP not wired in slice 1)");
    }

    // ── G: logs ───────────────────────────────────────────────────────────
    ok(logLines.length > 0 && logLines.every((l) => !l.includes("@") && !l.includes("epostprove")), `G1: ${logLines.length} guard log lines, none with an e-mail address`);
  } catch (err: any) {
    failed++;
    failures.push("dental email reveal guard: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    policy.__setPlacesDisplayPolicyForTesting(null);
    restClaims.__setRestClaimsRequireSourceForTesting(null);
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
  console.log("── dental email reveal guard (dev-request 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 1) ──");
  runDentalEmailRevealGuardTests({ log: true }).then((r) => {
    console.log(`\ndental email reveal guard: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    // The rate limiters keep a timer; exit as the sibling suites do.
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
