/**
 * dental-contact-form-only.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D3a
 * («Kontaktskjema som valg per profil») on finn-tannlege.com: the
 * dental_agents.contact_form_only flag (admin POST
 * /admin/dental/agents/:id/contact-form-only), the clinic profile pages
 * /klinikk/:slug and /klinikk/id/:id (form instead of e-mail, no JSON-LD
 * `email`), «Vis e-post» (GET /klinikk/id/:id/epost → 404), POST
 * /klinikk/id/:id/kontakt (forwarding through a stubbed sender — no network),
 * and the e-mail left out of REST GET /api/tannlege/agents[/:id], A2A
 * message/send (tannlege_info + search list) and MCP tannlege_info — all
 * behind CONTACT_FORM_DENTAL.
 *
 * Fixture (in-memory dental DB, made-up names, example.no addresses): a
 * flagged clinic, an unflagged one, a flagged one without e-mail, a flagged
 * closed one and a flagged rejected one.
 *
 *   O   switch off: with the flags set, every surface (pages id + slug,
 *       /epost with the guard on, REST list + detail, A2A info + search, MCP
 *       tannlege_info) is byte-identical to the same surface unflagged; the
 *       POST path is the catch-all 404 byte for byte; nothing sent / logged
 *   F   switch on, flagged: the form (honeypot, labels), the address nowhere
 *       in the page, no JSON-LD `email`, no «Vis e-post», no Cache-Control;
 *       /epost 404 without the address; REST list + detail, A2A info +
 *       search and MCP give epost null and are otherwise the switch-off
 *       answers (same keys); the X-Admin-Key REST view keeps it; unflagged
 *       answers byte-identical to switch off; guard on: no budget spent;
 *       closed / no e-mail → no form
 *   A   admin endpoint: 200 on/off, 400 non-boolean, 404 unknown id, 403
 *       wrong/missing key, the stored e-mail untouched, no mail
 *   P   POST: happy path (HTML and JSON) sends ONE mail (to = the stored
 *       address, replyTo = the sender, From Finn Tannlege); honeypot →
 *       success, no send; invalid input incl. CR/LF → 400; CR/LF in the name
 *       never reaches the subject; no req.ip → 429; 6th message from one IP
 *       → 429 + Retry-After, another IP unaffected; unknown / unflagged / no
 *       e-mail / closed / rejected → 404; send failure → 502; switch off → 404
 *   G   no POST/admin body carries a clinic address; log lines carry no
 *       address, no IP and no message text
 *
 * Standalone: npx tsx src/routes/dental-contact-form-only.test.ts
 * Wired into tests/test.ts via runDentalContactFormOnlyTests().
 */

import Database from "better-sqlite3";
import type { EmailOptions } from "../services/email-service";

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

const BROWSER = "Mozilla/5.0 (test)";

function jsonLdBlocks(html: string): any[] {
  return Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => {
    try { return JSON.parse(m[1]!); } catch { return null; }
  });
}

function jsonLdHasEmail(html: string): boolean {
  return JSON.stringify(jsonLdBlocks(html)).includes('"email"');
}

export async function runDentalContactFormOnlyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["DENTAL_DB_PATH", "CONTACT_FORM_DENTAL", "CONTACT_FORM_RFB", "EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_PER_IP_PER_HOUR", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  process.env.DENTAL_DB_PATH = ":memory:";
  const ADMIN_KEY = "dental-contact-form-only-test-key";

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const mainDb = new Database(":memory:");
  initMod.__setDbForTesting(mainDb as any);
  initMod.__initSchemaForTesting(mainDb as any);

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("../services/dental-clinic-card"),
    require.resolve("../services/dental-contact-form-only"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental-mcp"),
    require.resolve("./admin-dental-contact-form-only"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const cf = require("../services/contact-form-only") as typeof import("../services/contact-form-only");
  const guardLog: string[] = [];
  const cfLog: string[] = [];
  const sent: EmailOptions[] = [];
  let sendResult: { success: boolean; error?: string } = { success: true };
  const freshContactForm = () => {
    sent.length = 0;
    sendResult = { success: true };
    cf.__resetContactFormForTesting({
      log: (l) => cfLog.push(l),
      sender: async (o) => { sent.push(o); return sendResult; },
    });
  };
  const freshGuard = () => guard.__resetEmailRevealGuardForTesting({ log: (l) => guardLog.push(l) });
  let closeHttp: (() => Promise<void>) | null = null;
  const prevConsoleLog = console.log;
  const consoleLines: string[] = [];
  if (!log) console.log = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const restRouter = (require("./dental") as typeof import("./dental")).default as any;
    const a2aRouter = (require("./dental-a2a") as typeof import("./dental-a2a")).default as any;
    const dentalMcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const adminRouter = (require("./admin-dental-contact-form-only") as typeof import("./admin-dental-contact-form-only")).default as any;
    freshGuard();
    freshContactForm();

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (n: number, input: Record<string, unknown>, cols: Record<string, unknown> = {}) => {
      const id = `5c000000-0000-4000-8000-00000000000${n}`;
      store.createDentalAgent({ id, poststed: "OSLO", fylke: "Oslo", postnummer: "0150", organisasjonsform: "AS", ...input } as any);
      const all: Record<string, unknown> = { catalog_class: "klinikk", updated_at: "2026-11-01T00:00:00.000Z", ...cols };
      const keys = Object.keys(all);
      db.prepare(`UPDATE dental_agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => all[k]), id);
      return id;
    };
    const F = { navn: "Skjemaprøve Tannklinikk 1 AS", org_nr: "918880101", epost: "klinikk1@example.no" };
    const U = { navn: "Skjemaprøve Tannklinikk 2 AS", org_nr: "918880102", epost: "klinikk2@example.no" };
    const N = { navn: "Skjemaprøve Utenpost AS", org_nr: "918880103" };
    const I = { navn: "Skjemaprøve Nedlagt AS", org_nr: "918880104", epost: "klinikk4@example.no" };
    const R = { navn: "Skjemaprøve Avvist AS", org_nr: "918880105", epost: "klinikk5@example.no" };
    const idF = add(1, { ...F, adresse: "Skjemagata 1", telefon: "22118801" });
    const idU = add(2, { ...U, adresse: "Skjemagata 2", telefon: "22118802" });
    const idN = add(3, { ...N, adresse: "Skjemagata 3", telefon: "22118803" });
    const idI = add(4, { ...I, adresse: "Skjemagata 4", telefon: "22118804" }, { is_inactive: 1 });
    const idR = add(5, { ...R, adresse: "Skjemagata 5", telefon: "22118805" }, { verification_status: "rejected" });
    const clinicEmails = [F.epost, U.epost, I.epost, R.epost];
    const setFlag = (id: string, on: boolean) => db.prepare("UPDATE dental_agents SET contact_form_only = ? WHERE id = ?").run(on ? 1 : 0, id);
    const flagRow = (id: string) => (db.prepare("SELECT contact_form_only, epost FROM dental_agents WHERE id = ?").get(id) as any);
    const leaks = (text: string, email: string) => [email, encodeURIComponent(email), JSON.stringify(email).slice(1, -1)].some((f) => text.includes(f)) || text.includes(email.split("@")[0]! + "@");
    const allBodies: Array<{ label: string; text: string }> = [];

    // ── HTTP app: admin, REST, A2A, MCP and the dental pages ──────────────
    const express = require("express") as typeof import("express");
    const http = require("http") as typeof import("http");
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      if (req.headers["x-test-no-ip"]) Object.defineProperty(req, "ip", { value: "", configurable: true });
      next();
    });
    app.use("/admin/dental/agents", adminRouter);
    app.use("/api/tannlege", restRouter);
    app.use(a2aRouter);
    app.use("/mcp", dentalMcp.default as any);
    app.use(dentalSeo.default as any);
    const httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    closeHttp = () => new Promise<void>((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); });
    const port = (httpServer.address() as import("net").AddressInfo).port;
    const request = (method: string, path: string, ip: string, body?: string, headers: Record<string, string> = {}): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const h: Record<string, string | number> = { "x-forwarded-for": ip, "user-agent": BROWSER, ...headers };
        if (body !== undefined) h["content-length"] = Buffer.byteLength(body);
        const r = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => {
            allBodies.push({ label: `${method} ${path}`, text });
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
        if (body !== undefined) r.write(body);
        r.end();
      });
    const get = (path: string, ip: string, headers?: Record<string, string>) => request("GET", path, ip, undefined, headers);
    const pageId = (id: string, ip = "198.51.100.1") => get(`/klinikk/id/${id}`, ip);
    const pageSlug = (c: { navn: string; org_nr: string }, ip = "198.51.100.1") => get(`/klinikk/${dentalSeo.slugifyClinic(c.navn, c.org_nr)}`, ip);
    const reveal = (id: string, ip: string) => get(`/klinikk/id/${id}/epost`, ip);
    const restList = (ip: string, headers?: Record<string, string>) => get("/api/tannlege/agents?fylke=Oslo", ip, headers);
    const restOne = (id: string, ip: string, headers?: Record<string, string>) => get(`/api/tannlege/agents/${id}`, ip, headers);
    const a2a = (ip: string, message: unknown) =>
      request("POST", "/a2a", ip, JSON.stringify({ jsonrpc: "2.0", id: "kf", method: "message/send", params: { message } }), { "content-type": "application/json" });
    const a2aInfo = (orgNr: string, ip: string) => a2a(ip, { text: `info om ${orgNr}` });
    const a2aList = (ip: string) => a2a(ip, { data: { fylke: "Oslo" } });
    const stable = (text: string) => text.replace(/"taskId":"[^"]*"/g, '"taskId":"-"').replace(/"timestamp":"[^"]*"/g, '"timestamp":"-"');
    const a2aClinic = (r: HttpResult) => r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
    const a2aClinics = (r: HttpResult) => (r.body?.result?.artifacts?.[1]?.parts?.[0]?.data?.clinics ?? []) as any[];

    // MCP over HTTP: one session.
    const accept = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const init = await request("POST", "/mcp", "198.51.100.1", JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dental-contact-form-only-test", version: "0.0.0" } },
    }), accept);
    const sid = String(init.headers["mcp-session-id"] ?? "");
    ok(init.status === 200 && sid !== "", `setup: MCP initialize over HTTP (status ${init.status})`);
    await request("POST", "/mcp", "198.51.100.1", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { ...accept, "mcp-session-id": sid });
    let rpcId = 10;
    const mcpInfo = async (orgNr: string, ip: string): Promise<string> => {
      const r = await request("POST", "/mcp", ip, JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "tannlege_info", arguments: { org_nr: orgNr } } }), { ...accept, "mcp-session-id": sid });
      return String(r.body?.result?.content?.[0]?.text ?? `no tool text: ${r.status} ${r.text.slice(0, 200)}`);
    };
    const epostOf = (text: string) => { try { return JSON.parse(text).epost; } catch { return `unparsable: ${text.slice(0, 80)}`; } };

    /** Every surface the switch touches, for one IP. Pages and REST as raw text; A2A without its clock fields. */
    const surfaces = async (ip: string, guardOn = false) => {
      const out: Record<string, { status: number; text: string; cacheControl?: string }> = {};
      const keep = (label: string, r: HttpResult, a2aText = false) => { out[label] = { status: r.status, text: a2aText ? stable(r.text) : r.text, cacheControl: r.headers["cache-control"] as string | undefined }; };
      keep("page id F", await pageId(idF, ip));
      keep("page slug F", await pageSlug(F, ip));
      keep("page id U", await pageId(idU, ip));
      keep("page id I", await pageId(idI, ip));
      keep("page id N", await pageId(idN, ip));
      if (guardOn) keep("epost F", await reveal(idF, ip));
      keep("rest list", await restList(ip));
      keep("rest one F", await restOne(idF, ip));
      keep("rest one U", await restOne(idU, ip));
      keep("a2a info F", await a2aInfo(F.org_nr, ip), true);
      keep("a2a list", await a2aList(ip), true);
      out["mcp info F"] = { status: 200, text: await mcpInfo(F.org_nr, ip) };
      out["mcp info U"] = { status: 200, text: await mcpInfo(U.org_nr, ip) };
      return out;
    };
    const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
    const goodFields = { name: "Kari Pasient", reply_email: "kari@pasient.example", message: "Hei! Har dere ledig time neste uke?", _honey: "" };
    const postForm = (id: string, ip: string, fields: Record<string, string> = goodFields, headers: Record<string, string> = {}) =>
      request("POST", `/klinikk/id/${id}/kontakt`, ip, form(fields), { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers });
    const postJson = (id: string, ip: string, fields: Record<string, unknown>) =>
      request("POST", `/klinikk/id/${id}/kontakt`, ip, JSON.stringify(fields), { "content-type": "application/json", accept: "application/json" });
    const admin = (id: string, body: unknown, key: string | null = ADMIN_KEY) =>
      request("POST", `/admin/dental/agents/${encodeURIComponent(id)}/contact-form-only`, "198.51.100.200", JSON.stringify(body), {
        "content-type": "application/json",
        ...(key === null ? {} : { "x-admin-key": key }),
      });
    const hasForm = (html: string, id: string) =>
      html.includes(`action="/klinikk/id/${id}/kontakt"`) && html.includes('name="_honey"') && html.includes('name="reply_email"') && html.includes('name="message"') && html.includes('id="kontaktskjema"');
    const clinicMailtos = (html: string) => Array.from(html.matchAll(/mailto:([^"'\s<>?]*@[^"'\s<>?]*)/gi)).map((m) => m[1]!).filter((m) => !/^kontakt@finn-tannlege\.com$/i.test(m));

    // ── O: switch off ─────────────────────────────────────────────────────
    const offBase = await surfaces("203.0.113.10");
    process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
    process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
    freshGuard();
    const offRevealBase = await reveal(idF, "203.0.113.11");
    delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
    delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    freshGuard();
    {
      ok(offBase["page id F"]!.text.includes(`href="mailto:${F.epost}"`) && jsonLdHasEmail(offBase["page id F"]!.text), "O0: baseline -> clinic F shows its mailto: and JSON-LD email");
      for (const id of [idF, idN, idI, idR]) setFlag(id, true);
      const off = await surfaces("203.0.113.10");
      for (const key of Object.keys(offBase)) {
        ok(JSON.stringify(off[key]) === JSON.stringify(offBase[key]), `O1: switch off -> ${key} byte-identical with the flags set (status, body, Cache-Control)`);
      }
      process.env.CONTACT_FORM_DENTAL = "off";
      ok(JSON.stringify(await surfaces("203.0.113.10")) === JSON.stringify(offBase), "O2: switch \"off\" -> every surface as unset");
      process.env.CONTACT_FORM_DENTAL = "yes";
      ok(JSON.stringify(await surfaces("203.0.113.10")) === JSON.stringify(offBase), "O3: switch \"yes\" -> off");
      delete process.env.CONTACT_FORM_DENTAL;
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "100";
      freshGuard();
      const r = await reveal(idF, "203.0.113.11");
      ok(r.status === 200 && r.text === offRevealBase.text && r.headers["cache-control"] === offRevealBase.headers["cache-control"], "O4: switch off, guard on -> «Vis e-post» of a flagged clinic unchanged (200 with the address)");
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      freshGuard();
      const fallThrough = await request("POST", `/klinikk/id/${idF}/finnes-ikke`, "203.0.113.12", form(goodFields), { "content-type": "application/x-www-form-urlencoded" });
      const offPost = await postForm(idF, "203.0.113.12");
      ok(offPost.status === 404 && offPost.text === fallThrough.text, "O5: switch off -> POST /klinikk/id/:id/kontakt is the catch-all 404, byte for byte");
      eq([offPost.headers["cache-control"], offPost.headers["x-robots-tag"]], [fallThrough.headers["cache-control"], fallThrough.headers["x-robots-tag"]], "O6: switch off -> the POST path has the catch-all's headers");
      eq(sent.length, 0, "O7: switch off -> nothing sent");
      eq(cfLog.length, 0, "O8: switch off -> no contact-form log line");
    }

    // ── A: admin endpoint ─────────────────────────────────────────────────
    process.env.ADMIN_KEY = ADMIN_KEY;
    {
      setFlag(idF, false);
      const on = await admin(idF, { enabled: true });
      ok(on.status === 200 && JSON.stringify(on.body) === JSON.stringify({ id: idF, contact_form_only: true }), `A1: enable -> 200 { id, contact_form_only: true } (got ${on.status} ${on.text})`);
      eq(flagRow(idF).contact_form_only, 1, "A2: the flag is stored");
      const offR = await admin(idU, { enabled: false });
      ok(offR.status === 200 && offR.body?.contact_form_only === false, "A3: disable -> 200 contact_form_only false");
      for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, { enabled: null }]) {
        eq((await admin(idF, body)).status, 400, `A4: ${JSON.stringify(body)} -> 400`);
      }
      eq(flagRow(idF).contact_form_only, 1, "A5: a 400 changes nothing");
      eq((await admin("finnes-ikke-id", { enabled: true })).status, 404, "A6: unknown id -> 404");
      eq((await admin(idF, { enabled: false }, "wrong-key")).status, 403, "A7: wrong admin key -> 403");
      eq((await admin(idF, { enabled: false }, null)).status, 403, "A8: no admin key -> 403");
      eq(flagRow(idF).contact_form_only, 1, "A9: a refused call changes nothing");
      eq(flagRow(idF).epost, F.epost, "A10: the stored e-mail address is untouched");
      eq(sent.length, 0, "A11: the admin endpoint sends no mail");
      ok(consoleLines.filter((l) => l.includes("contact_form_only_set")).every((l) => !clinicEmails.some((e) => l.includes(e))), "A12: the admin log line carries no address");
      delete process.env.ADMIN_KEY;
      eq((await admin(idF, { enabled: false })).status, 503, "A13: no admin key configured -> 503 (the /admin/dental convention)");
      eq(flagRow(idF).contact_form_only, 1, "A14: ... nothing changed");
    }

    // ── F: switch on ──────────────────────────────────────────────────────
    process.env.CONTACT_FORM_DENTAL = "on";
    {
      const on = await surfaces("203.0.113.20");
      for (const key of ["page id F", "page slug F"]) {
        const t = on[key]!.text;
        ok(on[key]!.status === 200 && hasForm(t, idF), `F1: ${key} -> the contact form (honeypot, name, reply e-mail, message)`);
        ok(t.includes("Send melding til klinikken") && t.includes(">Send melding</button>"), `F2: ${key} -> Norwegian labels`);
        ok(!leaks(t, F.epost) && clinicMailtos(t).length === 0, `F3: ${key} -> the address nowhere in the HTML, no clinic mailto:`);
        ok(!jsonLdHasEmail(t) && jsonLdBlocks(t).some((b) => b && b["@type"] === "Dentist" && b.telephone), `F4: ${key} -> JSON-LD Dentist without email (telephone still there)`);
        ok(!t.includes("Vis e-post") && !t.includes(`/klinikk/id/${idF}/epost`), `F5: ${key} -> no «Vis e-post»`);
        eq(on[key]!.cacheControl, undefined, `F6: ${key} -> no Cache-Control (guard off; the page does not vary by client)`);
      }
      for (const key of ["page id U", "page id N"]) {
        ok(JSON.stringify(on[key]) === JSON.stringify(offBase[key]), `F7: ${key} -> byte-identical to switch off (unflagged / flagged without e-mail: no form)`);
      }
      {
        const t = on["page id I"]!.text;
        ok(on["page id I"]!.status === 200 && t.includes("Nedlagt") && !t.includes("kontaktskjema") && !leaks(t, I.epost) && !jsonLdHasEmail(t) && !t.includes("Vis e-post"),
          "F8: a closed flagged clinic -> no form (its POST is a 404) and still no address");
      }

      // REST
      const offList = JSON.parse(offBase["rest list"]!.text);
      const onList = JSON.parse(on["rest list"]!.text);
      const expectedList = { ...offList, agents: offList.agents.map((a: any) => ([idF, idI, idR].includes(a.id) ? { ...a, epost: null } : a)) };
      ok(onList.agents.some((a: any) => a.id === idF) && JSON.stringify(onList) === JSON.stringify(expectedList), "F9: REST list -> every flagged clinic's epost null, everything else as switch off (same keys and order)");
      ok(![F.epost, I.epost, R.epost].some((e) => leaks(on["rest list"]!.text, e)) && on["rest list"]!.text.includes(U.epost), "F10: REST list -> no flagged address anywhere in the body, the unflagged one kept");
      const offOne = JSON.parse(offBase["rest one F"]!.text);
      ok(JSON.stringify(JSON.parse(on["rest one F"]!.text)) === JSON.stringify({ agent: { ...offOne.agent, epost: null } }) && !leaks(on["rest one F"]!.text, F.epost), "F11: REST /agents/:id flagged -> epost null, otherwise as switch off");
      eq(on["rest one U"], offBase["rest one U"], "F12: REST /agents/:id unflagged -> byte-identical to switch off");
      eq([on["rest list"]!.cacheControl, on["rest one F"]!.cacheControl], [offBase["rest list"]!.cacheControl, offBase["rest one F"]!.cacheControl], "F13: REST headers as switch off (no new Cache-Control: the flag does not vary by client)");
      process.env.ADMIN_KEY = ADMIN_KEY;
      eq((await restOne(idF, "203.0.113.21", { "x-admin-key": ADMIN_KEY })).body?.agent?.epost, F.epost, "F14: the X-Admin-Key REST view keeps the e-mail");
      delete process.env.ADMIN_KEY;

      // A2A
      const offInfo = JSON.parse(offBase["a2a info F"]!.text);
      const onInfo = JSON.parse(on["a2a info F"]!.text);
      eq(a2aClinic({ body: onInfo } as HttpResult)?.epost, null, "F15: A2A tannlege_info flagged -> epost null");
      const expectedInfo = JSON.parse(JSON.stringify(offInfo));
      expectedInfo.result.artifacts[0].parts[0].data.epost = null;
      ok(JSON.stringify(onInfo) === JSON.stringify(expectedInfo) && !leaks(on["a2a info F"]!.text, F.epost), "F16: A2A tannlege_info -> otherwise as switch off, no address");
      const onClinics = a2aClinics({ body: JSON.parse(on["a2a list"]!.text) } as HttpResult);
      eq([onClinics.find((c) => c.id === idF)?.epost, onClinics.find((c) => c.id === idU)?.epost], [null, U.epost], "F17: A2A search list -> flagged epost null, unflagged kept");
      ok(!leaks(on["a2a list"]!.text, F.epost), "F18: A2A search list -> the address is nowhere");

      // MCP
      eq(epostOf(on["mcp info F"]!.text), null, "F19: MCP tannlege_info flagged -> epost null");
      eq(on["mcp info F"]!.text, JSON.stringify({ ...JSON.parse(offBase["mcp info F"]!.text), epost: null }, null, 2), "F20: MCP tannlege_info -> the switch-off text with epost null (no new field)");
      eq(on["mcp info U"], offBase["mcp info U"], "F21: MCP tannlege_info unflagged -> byte-identical");

      for (const v of ["1", "true", "TRUE", " On "]) {
        process.env.CONTACT_FORM_DENTAL = v;
        ok(hasForm((await pageId(idF)).text, idF), `F22: switch ${JSON.stringify(v)} -> on`);
      }
      process.env.CONTACT_FORM_DENTAL = "on";

      // With the e-mail guard on too: no reveal, no budget spent for the flagged clinic.
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";
      process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = "1";
      freshGuard();
      const g = await pageId(idF, "203.0.113.30");
      ok(hasForm(g.text, idF) && !leaks(g.text, F.epost) && !g.text.includes("Vis e-post") && !jsonLdHasEmail(g.text), "F23: guard on + flagged -> form, no «Vis e-post», no address");
      eq(g.headers["cache-control"], "private", "F24: guard on -> Cache-Control: private (as every guarded page)");
      eq((await restOne(idF, "203.0.113.30")).body?.agent?.epost, null, "F25: guard on + flagged -> REST epost null");
      eq(a2aClinic(await a2aInfo(F.org_nr, "203.0.113.30"))?.epost, null, "F26: guard on + flagged -> A2A epost null");
      eq(epostOf(await mcpInfo(F.org_nr, "203.0.113.30")), null, "F27: guard on + flagged -> MCP epost null");
      const listG = await restList("203.0.113.30");
      eq((listG.body?.agents ?? []).find((a: any) => a.id === idU)?.epost, U.epost, "F28: the flagged clinic spent none of the IP's budget (limit 1: the unflagged one still has its e-mail)");
      eq(listG.headers["cache-control"], "private", "F29: guard on -> REST Cache-Control: private");
      const rv = await reveal(idF, "203.0.113.31");
      ok(rv.status === 404 && !leaks(rv.text, F.epost) && clinicMailtos(rv.text).length === 0, `F30: guard on + flagged -> «Vis e-post» 404 without the address (got ${rv.status})`);
      eq([rv.headers["cache-control"], rv.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "F31: ... private + noindex like the guard's own 404");
      const rvU = await reveal(idU, "203.0.113.31");
      ok(rvU.status === 200 && rvU.text.includes(`mailto:${U.epost}`), "F32: guard on, unflagged -> «Vis e-post» unchanged (200 with the address)");
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      freshGuard();
    }

    // ── P: POST /klinikk/id/:id/kontakt ───────────────────────────────────
    freshContactForm();
    {
      const r = await postForm(idF, "198.51.100.10");
      ok(r.status === 200 && r.text.includes("Takk for meldingen"), `P1: happy path -> 200 Norwegian thank-you page (got ${r.status})`);
      eq([r.headers["cache-control"], r.headers["x-robots-tag"]], ["private, no-store", "noindex, nofollow"], "P2: Cache-Control private, no-store + noindex");
      eq(sent.length, 1, "P3: exactly one mail sent");
      const m = sent[0];
      ok(!!m && m.to === F.epost && m.replyTo === goodFields.reply_email, "P4: to = the stored address, replyTo = the sender's address");
      ok(!!m && m.subject === `Melding via Finn-tannlege.com: ${goodFields.name}`, `P5: subject «Melding via Finn-tannlege.com: …» (got ${m?.subject})`);
      ok(!!m && m.textContent.includes(goodFields.message) && m.textContent.includes("videresendt av Finn-tannlege.com") && !m.htmlContent, "P6: plain text body with the message and the forwarded-by footer");
      ok(!!m && typeof m.from === "string" && m.from.includes("Finn Tannlege"), `P7: From is the Finn Tannlege identity (got ${m?.from})`);
      ok(!!m && m.redactRecipientInLogs === true && m.omitAgentHeader === true && m.logSubjectAs === "[Kontaktskjema · tannklinikk]", "P8: the send log is redacted");
      ok(!leaks(r.text, F.epost), "P9: the clinic's address is not in the answer");

      const j = await postJson(idF, "198.51.100.11", goodFields);
      ok(j.status === 200 && JSON.stringify(j.body) === JSON.stringify({ ok: true }), `P10: JSON client -> 200 {"ok":true} (got ${j.status} ${j.text})`);
      eq(sent.length, 2, "P11: ... and one more mail");

      const hp = await postForm(idF, "198.51.100.12", { ...goodFields, _honey: "http://spam.example" });
      ok(hp.status === 200 && hp.text.includes("Takk for meldingen"), "P12: honeypot filled -> answered like a success");
      eq(sent.length, 2, "P13: honeypot -> nothing sent");

      for (const [label, fields] of [
        ["bad reply e-mail", { ...goodFields, reply_email: "ikke-en-adresse" }],
        ["reply e-mail with CR/LF", { ...goodFields, reply_email: "kari@pasient.example\r\nBcc: x@y.example" }],
        ["missing message", { ...goodFields, message: "  " }],
        ["message too long", { ...goodFields, message: "x".repeat(2001) }],
        ["missing name", { ...goodFields, name: "" }],
        ["name too long", { ...goodFields, name: "n".repeat(101) }],
      ] as Array<[string, Record<string, string>]>) {
        const bad = await postForm(idF, "198.51.100.13", fields);
        ok(bad.status === 400 && bad.text.includes("Meldingen ble ikke sendt") && !leaks(bad.text, F.epost), `P14: ${label} -> 400, no address`);
      }
      const badJson = await postJson(idF, "198.51.100.13", { ...goodFields, reply_email: "nei" });
      ok(badJson.status === 400 && badJson.body?.fields?.includes("reply_email"), "P15: JSON invalid -> 400 with the field");
      eq(sent.length, 2, "P16: invalid input -> nothing sent");

      freshContactForm();
      const crlf = await postForm(idF, "198.51.100.14", { ...goodFields, name: "Kari\r\nBcc: x@y.example\u0000\u2028Pasient" });
      ok(crlf.status === 200 && sent.length === 1, "P17: a name with CR/LF/control chars is accepted (sanitized)");
      ok(!!sent[0] && !/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(sent[0].subject) && sent[0].subject.startsWith("Melding via Finn-tannlege.com: Kari "), `P18: the subject has no line break or control char (got ${JSON.stringify(sent[0]?.subject)})`);

      freshContactForm();
      const noIp = await postForm(idF, "198.51.100.15", goodFields, { "x-test-no-ip": "1" });
      ok(noIp.status === 429 && Number(noIp.headers["retry-after"]) > 0, `P19: no req.ip -> 429 with Retry-After (got ${noIp.status})`);
      eq(sent.length, 0, "P20: no req.ip -> nothing sent");

      // Per-IP limit: 5 per hour.
      freshContactForm();
      const ip = "198.51.100.20";
      let firstFive = true;
      for (let n = 0; n < 5; n++) firstFive = (await postForm(idF, ip)).status === 200 && firstFive;
      ok(firstFive, "P21: 5 messages from one IP -> all 200");
      const sixth = await postForm(idF, ip);
      ok(sixth.status === 429 && sixth.text.includes("For mange meldinger"), "P22: the 6th -> 429");
      const ra = Number(sixth.headers["retry-after"]);
      ok(Number.isFinite(ra) && ra > 0 && ra <= 3600, `P23: 429 has Retry-After in seconds (got ${sixth.headers["retry-after"]})`);
      eq(sent.length, 5, "P24: the 6th was not sent");
      eq((await postForm(idF, "198.51.100.21")).status, 200, "P25: another IP has its own budget");
      eq((await postForm(idF, ip, { ...goodFields, _honey: "x" })).status, 200, "P26: honeypot is answered like a success even over the limit");
      const rfbCheck = cf.contactFormRateCheck({ ip } as any, "rfb");
      ok(rfbCheck.ok === true, "P27: the dental limit does not spend the RFB store (separate per host)");

      // 404s
      freshContactForm();
      for (const [label, id] of [
        ["unknown id", "5c000000-0000-4000-8000-0000000000ff"],
        ["unflagged clinic", idU],
        ["flagged without e-mail", idN],
        ["flagged closed clinic", idI],
        ["flagged rejected clinic", idR],
      ] as Array<[string, string]>) {
        const nf = await postForm(id, "198.51.100.30");
        ok(nf.status === 404 && nf.headers["x-robots-tag"] === "noindex, nofollow" && !clinicEmails.some((e) => leaks(nf.text, e)), `P28: ${label} -> 404 noindex, no address (got ${nf.status})`);
      }
      eq((await postJson(idU, "198.51.100.30", goodFields)).status, 404, "P29: unflagged (JSON) -> 404");
      setFlag(idF, false);
      eq((await postForm(idF, "198.51.100.31")).status, 404, "P30: flag removed -> 404");
      setFlag(idF, true);
      eq(sent.length, 0, "P31: no 404 sent anything");

      // Send failure.
      freshContactForm();
      sendResult = { success: false, error: "boom" };
      const fail = await postForm(idF, "198.51.100.40");
      ok(fail.status === 502 && !leaks(fail.text, F.epost), "P32: send failure -> 502, no address");

      // Switch off again: the POST is back to the fall-through 404.
      delete process.env.CONTACT_FORM_DENTAL;
      freshContactForm();
      eq((await postForm(idF, "198.51.100.42")).status, 404, "P33: switch turned off -> POST 404");
      eq(sent.length, 0, "P34: ... nothing sent");
    }

    // ── G: bodies and logs ────────────────────────────────────────────────
    {
      const postAndAdmin = allBodies.filter((b) => b.label.includes("/kontakt") || b.label.includes("/admin/"));
      const leaked = postAndAdmin.filter((b) => clinicEmails.some((e) => leaks(b.text, e)));
      ok(leaked.length === 0, `G1: no POST/admin response body carries a clinic address (${leaked.map((b) => b.label).join(", ")})`);
      ok(cfLog.length > 0, "G2: contact-form outcomes were logged");
      const joined = cfLog.join("\n");
      ok(![...clinicEmails, goodFields.reply_email, "example.no", "pasient.example"].some((e) => joined.includes(e)), "G3: no contact-form log line carries an e-mail address");
      ok(!/198\.51\.100\./.test(joined), "G4: no contact-form log line carries an IP");
      ok(!joined.includes(goodFields.message), "G5: no log line carries the message text");
      ok(cfLog.every((l) => { try { const o = JSON.parse(l); return o.evt === "contact_form" && o.host === "dental" && typeof o.profile_id === "string"; } catch { return false; } }), "G6: every line is the dental contact-form JSON line with a profile id");
      ok(guardLog.every((l) => !clinicEmails.some((e) => l.includes(e))), "G7: no guard log line carries an address");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    if (closeHttp) await closeHttp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch { /* best-effort */ }
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    cf.__resetContactFormForTesting();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch { /* best-effort */ }
    restoreModuleCache();
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    mainDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalContactFormOnlyTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
