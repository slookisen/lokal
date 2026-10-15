/**
 * profile-ai-deliveries-s2.test.ts — dev-request 2026-10-14-med-i-ai-svar-per-profil, S2
 * («Med i AI-svar» for finn-tannlege and opplevagent incl. gårdssalg).
 *
 * Same rules as S1 (profile-ai-deliveries.test.ts), now under vertical
 * 'dental' / 'experiences':
 *   (a) dental list pages: an ai_search fetch of /sok counts each clinic once
 *       in ai_page_list; GPTBot / Googlebot / a person / curl / our own
 *       traffic count nothing; a repeat in the same session counts nothing.
 *   (b) dental profile page: ai_page_profile +1 for an AI client, none for a
 *       person; the «Med i AI-svar · 60d» tile shows with the help text,
 *       «sendt til AI-en», and no literal `${`; no tile at 0.
 *   (c) experiences: /sok, a gårdssalg category list and a gårdssalg type page
 *       count the experiences / producers on them; the experience page and the
 *       gårdssalg producer page count themselves and render the tile.
 *   (d) MCP: tannlege_search / discover_experiences count the returned
 *       profiles per AI, a probe client counts nothing.
 *   (e) A2A: the answers' profile ids are read from the artifacts; the router
 *       records them after the countable verdict; countable = 0 counts nothing.
 *   (f) the gårdssalg owner stats carry aiDeliveries (60 d and whole period).
 *
 * Exported runProfileAiDeliveriesS2Tests({log}) -> Promise<TestSummary>; wired
 * into tests/test.ts. Standalone: npx tsx src/services/profile-ai-deliveries-s2.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CLAUDE_USER = "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CURL = "curl/8.5.0";

export async function runProfileAiDeliveriesS2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const mainDb = new Database(":memory:");
  mainDb.pragma("journal_mode = DELETE");
  mainDb.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const cachePaths = [
    "../database/db-factory", "../services/dental-store", "../services/experience-store",
    "../routes/dental-seo", "../routes/dental-mcp", "../routes/dental-a2a",
    "../routes/experiences-seo", "../routes/experiences-mcp", "../routes/experiences-a2a",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    initMod.__setDbForTesting(mainDb as any);
    initMod.__initSchemaForTesting(mainDb as any);
    const svc = require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries");
    svc.__resetAiDeliveriesForTesting();
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const expDb = dbFactory.getDb("experiences");
    const dentalStore = require("./dental-store") as typeof import("./dental-store");
    const expStore = require("./experience-store") as typeof import("./experience-store");

    const flush = () => svc.flushAiDeliveries(mainDb as any);
    const rowsFor = (vertical: string, channel: string) => mainDb.prepare(
      "SELECT profile_id, ai_vendor, SUM(count) AS n FROM profile_ai_deliveries WHERE vertical_id = ? AND channel = ? GROUP BY profile_id, ai_vendor ORDER BY profile_id",
    ).all(vertical, channel) as Array<{ profile_id: string; ai_vendor: string; n: number }>;
    const total = (vertical: string) => (mainDb.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM profile_ai_deliveries WHERE vertical_id = ?").get(vertical) as { n: number }).n;

    function invoke(router: any, url: string, ua: string, extra: { ip?: string; cookie?: string } = {}): Promise<{ status: number; body: string }> {
      return new Promise((resolve) => {
        const headers: Record<string, string> = { "user-agent": ua };
        if (extra.cookie) headers.cookie = extra.cookie;
        const req: any = {
          method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "example.test",
          query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
          params: {}, headers, lang: "no", ip: extra.ip ?? "203.0.113.7",
          get(h: string) { return headers[h.toLowerCase()]; },
        };
        const res: any = new EventEmitter();
        Object.assign(res, {
          statusCode: 200, locals: {},
          status(c: number) { res.statusCode = c; return res; },
          set() { return res; }, header() { return res; }, setHeader() { return res; },
          redirect() { res.statusCode = 301; res.emit("finish"); resolve({ status: 301, body: "" }); return res; },
          send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
        });
        router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? String(err) : "" }));
      });
    }

    // ── dental fixtures ────────────────────────────────────────────────
    const dentalIds: string[] = [];
    for (const [i, navn] of ["Sentrum Tannklinikk AS", "Nord Tannlegesenter AS"].entries()) {
      const id = dentalStore.createDentalAgent({
        navn, org_nr: `91880010${i}`, poststed: "OSLO", fylke: "Oslo",
        adresse: "Storgata 1", telefon: "2211009" + i, hjemmeside: `https://klinikk${i}.example.no`,
      } as any);
      dentalDb.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(id);
      dentalIds.push(id);
    }
    const dentalRouter = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;

    // ── (a) dental list pages ──────────────────────────────────────────
    {
      const r = await invoke(dentalRouter, "/sok?q=tann", CHATGPT_USER);
      assertEq(r.status, 200, "(a) dental /sok renders 200");
      flush();
      const rows = rowsFor("dental", "ai_page_list");
      assertEq(rows.map((x) => x.profile_id).sort().join(","), [...dentalIds].sort().join(","), "(a) ChatGPT-User on dental /sok: each clinic counted");
      assertTrue(rows.every((x) => x.n === 1 && x.ai_vendor === "chatgpt"), "(a) once each, under chatgpt");

      for (const [label, ua, cookie] of [
        ["GPTBot (AI crawler)", GPTBOT, undefined], ["Googlebot", GOOGLEBOT, undefined], ["a person", HUMAN, undefined],
        ["a script / scraper", CURL, undefined], ["ChatGPT-User with the owner cookie", CHATGPT_USER, "_rfb_owner=1"],
      ] as Array<[string, string, string | undefined]>) {
        const before = total("dental");
        await invoke(dentalRouter, "/sok?q=tann", ua, { ip: "198.51.100.9", cookie });
        flush();
        assertEq(total("dental"), before, `(a) the same dental /sok fetch from ${label} counts nothing`);
      }

      const before = total("dental");
      await invoke(dentalRouter, "/sok?q=tann&utm_source=chatgpt.com", CHATGPT_USER);
      flush();
      assertEq(total("dental"), before, "(a) the same AI session fetching the same list again within 30 min counts nothing more");

      await invoke(dentalRouter, "/fylke/Oslo", CLAUDE_USER);
      flush();
      assertEq(rowsFor("dental", "ai_page_list").filter((x) => x.ai_vendor === "claude").length, 2, "(a) Claude-User on /fylke/Oslo: each clinic counted under claude");
      assertEq(total("rfb"), 0, "(a) nothing is written under rfb");
    }

    // ── (b) dental profile page + tile ─────────────────────────────────
    {
      mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
      svc.__resetAiDeliveriesForTesting();
      const clinic = `/klinikk/id/${dentalIds[0]}`;
      const first = await invoke(dentalRouter, clinic, HUMAN, { ip: "198.51.100.30" });
      assertEq(first.status, 200, "(b) dental profile renders 200");
      assertTrue(!first.body.includes('data-stat="aiDeliveries"'), "(b) no tile while the clinic has not been sent to an AI");
      await invoke(dentalRouter, clinic, HUMAN, { ip: "198.51.100.31" });
      flush();
      assertEq(rowsFor("dental", "ai_page_profile").length, 0, "(b) a person on the profile page counts nothing");
      await invoke(dentalRouter, clinic, CHATGPT_USER);
      flush();
      const prof = rowsFor("dental", "ai_page_profile");
      assertTrue(prof.length === 1 && prof[0].profile_id === dentalIds[0] && prof[0].ai_vendor === "chatgpt" && prof[0].n === 1, "(b) ChatGPT-User on the profile page: ai_page_profile +1 under chatgpt");

      const withTile = await invoke(dentalRouter, clinic, HUMAN, { ip: "198.51.100.32" });
      assertTrue(withTile.body.includes('data-stat="aiDeliveries"'), "(b) the clinic page has the «Med i AI-svar» tile");
      assertTrue(withTile.body.includes("Med i AI-svar"), "(b) tile label «Med i AI-svar»");
      assertTrue(withTile.body.includes("sendt til AI-en &middot; 60d"), "(b) tile meta «sendt til AI-en · 60d»");
      assertTrue(withTile.body.includes("Tallet viser ikke hvor mange som så den."), "(b) help text: it does not show how many saw it");
      assertTrue(withTile.body.includes("ChatGPT 1"), "(b) per-AI split in the tooltip");
      assertTrue(!withTile.body.includes("${"), "(b) rendered HTML has no literal ${");
      assertTrue(!/vist i ChatGPT/i.test(withTile.body), "(b) never «vist i ChatGPT»");
    }

    // ── experiences fixtures ───────────────────────────────────────────
    expDb.prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
          geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
       VALUES ('gs-fossmoen', 'Fossmoen Frukt', 'experiences', 'Telemark', 'Skien', 'Skien', 'cideri', NULL, NULL, 59.21, 9.61,
          'high', 'fossmoen-frukt', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
    ).run();
    const expProvider = expStore.createProvider({
      navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    });
    const expId = expStore.createExperience({
      title: "Hvalsafari i Tromsø", provider_id: expProvider,
      provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
      verification_status: "verified", confidence: "high",
    });
    const expSlug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(expId) as { slug: string }).slug;
    const expRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;

    // ── (c) experiences / gårdssalg pages ──────────────────────────────
    {
      mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
      svc.__resetAiDeliveriesForTesting();

      const sok = await invoke(expRouter, "/sok?q=Skien", CHATGPT_USER);
      assertEq(sok.status, 200, "(c) /sok renders 200");
      flush();
      assertEq(rowsFor("experiences", "ai_page_list").map((x) => x.profile_id).join(","), "gs-fossmoen", "(c) ChatGPT-User on /sok: the matching gårdssalg producer counted");

      await invoke(expRouter, "/sok?q=hvalsafari", CLAUDE_USER);
      flush();
      const claude = rowsFor("experiences", "ai_page_list").filter((x) => x.ai_vendor === "claude");
      assertEq(claude.map((x) => x.profile_id).join(","), expId, "(c) Claude-User on /sok: the experience counted by its id");

      const list = await invoke(expRouter, "/kategori/gardssalg", CHATGPT_USER, { ip: "203.0.113.50" });
      assertEq(list.status, 200, "(c) /kategori/gardssalg renders 200");
      flush();
      assertTrue(rowsFor("experiences", "ai_page_list").some((x) => x.profile_id === "gs-fossmoen" && x.ai_vendor === "chatgpt" && x.n === 2), "(c) the gårdssalg catalogue page counts its producers (second list, same producer)");

      for (const [label, ua] of [["GPTBot", GPTBOT], ["Googlebot", GOOGLEBOT], ["a person", HUMAN], ["curl", CURL]] as Array<[string, string]>) {
        const before = total("experiences");
        await invoke(expRouter, "/kategori/gardssalg", ua, { ip: "198.51.100.77" });
        await invoke(expRouter, "/sok?q=Skien", ua, { ip: "198.51.100.77" });
        flush();
        assertEq(total("experiences"), before, `(c) the same list fetches from ${label} count nothing`);
      }
      const before = total("experiences");
      await invoke(expRouter, "/kategori/gardssalg", CHATGPT_USER, { ip: "203.0.113.50" });
      flush();
      assertEq(total("experiences"), before, "(c) a repeat of the same list in the same AI session counts nothing more");

      // experience page (clean slate: the tile is left out at 0)
      mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
      svc.__resetAiDeliveriesForTesting();
      const detail0 = await invoke(expRouter, `/opplevelse/${expSlug}`, HUMAN, { ip: "198.51.100.40" });
      assertEq(detail0.status, 200, "(c) the experience page renders 200");
      assertTrue(!detail0.body.includes('data-stat="aiDeliveries"'), "(c) no tile on the experience page at 0");
      await invoke(expRouter, `/opplevelse/${expSlug}`, CHATGPT_USER, { ip: "203.0.113.60" });
      flush();
      assertTrue(rowsFor("experiences", "ai_page_profile").some((x) => x.profile_id === expId && x.ai_vendor === "chatgpt" && x.n === 1), "(c) an AI fetch of the experience page counts ai_page_profile");
      const detail = await invoke(expRouter, `/opplevelse/${expSlug}`, HUMAN, { ip: "198.51.100.41" });
      assertTrue(detail.body.includes('data-stat="aiDeliveries"') && detail.body.includes("sendt til AI-en &middot; 60d"), "(c) the experience page has the «Med i AI-svar · 60d» tile");
      assertTrue(detail.body.includes("Tallet viser ikke hvor mange som så den."), "(c) experience tile help text");
      assertTrue(!detail.body.includes("${"), "(c) the experience page has no literal ${");

      // gårdssalg producer page
      const gsPath = "/kategori/gardssalg/produsent/fossmoen-frukt";
      mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
      svc.__resetAiDeliveriesForTesting();
      const gs0 = await invoke(expRouter, gsPath, HUMAN, { ip: "198.51.100.42" });
      assertEq(gs0.status, 200, "(c) the gårdssalg producer page renders 200");
      assertTrue(!gs0.body.includes('data-stat="aiDeliveries"'), "(c) no tile on the producer page at 0");
      await invoke(expRouter, gsPath, CLAUDE_USER, { ip: "203.0.113.61" });
      flush();
      assertTrue(rowsFor("experiences", "ai_page_profile").some((x) => x.profile_id === "gs-fossmoen" && x.ai_vendor === "claude" && x.n === 1), "(c) an AI fetch of the producer page counts ai_page_profile under the provider id");
      const gs = await invoke(expRouter, gsPath, HUMAN, { ip: "198.51.100.43" });
      assertTrue(gs.body.includes('data-stat="aiDeliveries"') && gs.body.includes("Med i AI-svar") && gs.body.includes("sendt til AI-en &middot; 60d"), "(c) the producer page has the «Med i AI-svar · 60d» tile");
      assertTrue(gs.body.includes("Tallet viser ikke hvor mange som så den.") && gs.body.includes("Claude 1"), "(c) producer tile help text and per-AI split");
      assertTrue(!gs.body.includes("${"), "(c) the producer page has no literal ${");

    }

      // ── (d) MCP ──────────────────────────────────────────────────────
      mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
      svc.__resetAiDeliveriesForTesting();
      const fakeServerFor = (clientName?: string) => {
        const tools = new Map<string, any>();
        const server: any = {
          server: { getClientVersion: () => (clientName ? { name: clientName, version: "1" } : undefined) },
          registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
          resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
        };
        return { tools, server };
      };
      {
        const { tools, server } = fakeServerFor();
        (require("../routes/dental-mcp") as typeof import("../routes/dental-mcp")).registerDentalTools(server);
        const search = tools.get("tannlege_search");
        const call = (ua: string, sessionId: string) => search({ query: "tann", limit: 10 }, { sessionId, requestInfo: { headers: { "user-agent": ua } } });
        const out = await call("openai-mcp/1.0.0", "d-1");
        flush();
        assertTrue(String(out?.content?.[0]?.text ?? "").includes("Sentrum Tannklinikk AS"), "(d) tannlege_search returns the seeded clinics");
        const rows = rowsFor("dental", "mcp");
        assertEq(rows.map((x) => x.profile_id).sort().join(","), [...dentalIds].sort().join(","), "(d) an MCP clinic search returning K profiles counts each");
        assertTrue(rows.every((x) => x.n === 1 && x.ai_vendor === "chatgpt"), "(d) once each, chatgpt from the UA");
        await call("openai-mcp/1.0.0", "d-1");
        flush();
        assertEq(total("dental"), 2, "(d) the same MCP session repeating the call counts nothing more");
        for (const ua of ["mcpbeat/2.0", "rfb-health/1.0", "UptimeRobot monitor"]) {
          await call(ua, `d-${ua}`);
          flush();
          assertEq(total("dental"), 2, `(d) a probe / own / monitor client (${ua}) counts nothing`);
        }
        const info = tools.get("tannlege_info");
        await info({ id: dentalIds[0] }, { sessionId: "d-info", requestInfo: { headers: { "user-agent": "claude-ai/1.0" } } });
        flush();
        assertTrue(rowsFor("dental", "mcp").some((x) => x.profile_id === dentalIds[0] && x.ai_vendor === "claude" && x.n === 1), "(d) tannlege_info counts its clinic, claude from the UA");
      }
      {
        const { tools, server } = fakeServerFor("claude-ai");
        (require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp")).registerExperienceTools(server);
        const discover = tools.get("discover_experiences");
        await discover({ kommune: "Tromsø", limit: 10 }, { sessionId: "e-1", requestInfo: { headers: { "user-agent": "node" } } });
        flush();
        assertTrue(rowsFor("experiences", "mcp").some((x) => x.profile_id === expId && x.ai_vendor === "claude" && x.n === 1), "(d) discover_experiences counts the returned experience, claude from the client name");
        const gsDiscover = tools.get("discover_gardssalg");
        await gsDiscover({ fylke: "Telemark", limit: 10 }, { sessionId: "e-2", requestInfo: { headers: { "user-agent": "node" } } });
        flush();
        assertTrue(rowsFor("experiences", "mcp").some((x) => x.profile_id === "gs-fossmoen" && x.n === 1), "(d) discover_gardssalg counts the returned producer");
        const before = total("experiences");
        await tools.get("get_experience")({ id: expId }, { sessionId: "e-3", requestInfo: { headers: { "user-agent": "mcpbeat/2.0" } } });
        flush();
        assertEq(total("experiences"), before, "(d) a probe client on get_experience counts nothing");
        await tools.get("get_experience")({ id: expId }, { sessionId: "e-4", requestInfo: { headers: { "user-agent": "node" } } });
        flush();
        assertEq(total("experiences"), before + 1, "(d) get_experience counts its experience");
      }

      // ── (e) A2A ──────────────────────────────────────────────────────
      {
        mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
        svc.__resetAiDeliveriesForTesting();
        const dentalA2a = require("../routes/dental-a2a") as typeof import("../routes/dental-a2a");
        const answer = dentalA2a.handleDentalMessageSend({ message: { parts: [{ kind: "text", text: "tannlege i Oslo" }] } }, 1);
        const ids = dentalA2a.dentalAnswerProfileIds(answer);
        assertEq([...ids].sort().join(","), [...dentalIds].sort().join(","), "(e) the dental answer's clinic ids are read from the search artifact");
        const info = dentalA2a.handleDentalMessageSend({ message: { parts: [{ kind: "text", text: "info om org 918800100" }] } }, 2);
        assertEq(dentalA2a.dentalAnswerProfileIds(info).join(","), dentalIds[0], "(e) and from the single-clinic artifact");
        assertEq(dentalA2a.dentalAnswerProfileIds({ result: { artifacts: [{ name: "x", parts: [{ kind: "text", text: "hei" }] }] } }).length, 0, "(e) a text-only answer has no ids");

        const a2aRec = (vertical: "dental" | "experiences", countable: boolean, status: number, ip: string, profileIds: string[]) => {
          const res: any = Object.assign(new EventEmitter(), { statusCode: status, locals: { a2aCountable: countable } });
          svc.recordA2aDelivery({ headers: { "user-agent": "python-requests/2.31" }, ip } as any, res, profileIds, "q", vertical);
          res.emit("finish");
          flush();
        };
        a2aRec("dental", false, 200, "192.0.2.1", ids);
        assertEq(total("dental"), 0, "(e) an A2A answer with countable = 0 counts nothing");
        a2aRec("dental", true, 200, "192.0.2.2", ids);
        assertEq(rowsFor("dental", "a2a").length, 2, "(e) countable = 1: each clinic counted once under dental");

        const expA2a = require("../routes/experiences-a2a") as typeof import("../routes/experiences-a2a");
        const expAnswer = {
          result: { artifacts: [
            { name: "experience-discover-results", parts: [{ kind: "data", data: { count: 1, experiences: [{ id: "e-1" }] } }] },
            { name: "gardssalg-discover-results", parts: [{ kind: "data", data: { count: 1, producers: [{ id: "p-1" }] } }] },
            { name: "experience", parts: [{ kind: "data", data: { id: "e-2" } }] },
          ] },
        };
        assertEq(expA2a.experiencesAnswerProfileIds(expAnswer).join(","), "e-1,p-1,e-2", "(e) experience / producer / single-experience ids are read from the artifacts");
        a2aRec("experiences", true, 200, "192.0.2.3", expA2a.experiencesAnswerProfileIds(expAnswer));
        assertEq(total("experiences"), 3, "(e) countable = 1: each experience / producer counted under experiences");

        const dentalSrc = fs.readFileSync(path.join(__dirname, "../routes/dental-a2a.ts"), "utf8");
        const expSrc = fs.readFileSync(path.join(__dirname, "../routes/experiences-a2a.ts"), "utf8");
        assertTrue(/a2aCountable = a2aRequestCountable\(req, params, result\);\s*\n\s*\/\/[^\n]*\n\s*recordA2aDelivery\(req, res, dentalAnswerProfileIds\(result\)/.test(dentalSrc),
          "(e) dental-a2a.ts records the answer's clinics right after the countable verdict");
        assertTrue(/a2aCountable = a2aRequestCountable\([^\n]*\);\s*\n\s*\/\/[^\n]*\n\s*recordA2aDelivery\(req, res, experiencesAnswerProfileIds\(result\)/.test(expSrc),
          "(e) experiences-a2a.ts records the answer's profiles right after the countable verdict");
      }

      // ── (f) gårdssalg owner stats ────────────────────────────────────
      {
        mainDb.prepare("DELETE FROM profile_ai_deliveries").run();
        const compute = require("./profile-ai-deliveries-compute") as typeof import("./profile-ai-deliveries-compute");
        const now = Date.now();
        const today = compute.utcDay(now);
        const old = compute.utcDay(now - 90 * 24 * 60 * 60 * 1000);
        const ins = mainDb.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)");
        ins.run("experiences", "gs-fossmoen", today, "ai_page_list", "chatgpt", 5);
        ins.run("experiences", "gs-fossmoen", today, "mcp", "claude", 2);
        ins.run("experiences", "gs-fossmoen", old, "a2a", "unknown", 4);
        const { getGardssalgOwnerStats } = require("./gardssalg-owner-stats-service") as typeof import("./gardssalg-owner-stats-service");
        const o = getGardssalgOwnerStats("/kategori/gardssalg/produsent/fossmoen-frukt", "gs-fossmoen");
        assertEq(o.aiDeliveries?.window.total, 7, "(f) gårdssalg owner stats: 60 d");
        assertEq(o.aiDeliveries?.allTime.total, 11, "(f) gårdssalg owner stats: whole period");
        assertEq(o.aiDeliveries?.allTime.byChannel.a2a, 4, "(f) whole period per channel");
        assertEq(getGardssalgOwnerStats("/x").aiDeliveries, undefined, "(f) without a provider id the payload is unchanged");
        const claimSrc = fs.readFileSync(path.join(__dirname, "../routes/gardssalg-claim.ts"), "utf8");
        assertTrue(claimSrc.includes("getGardssalgOwnerStats(path, providerId)") && claimSrc.includes("Med i AI-svar, sendt til AI-en (hele perioden)"), "(f) the gårdssalg portal shows 60 d and the whole period");
        assertTrue(!/vist i ChatGPT/i.test(claimSrc), "(f) portal wording: never «vist i ChatGPT»");
      }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    (require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { mainDb.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileAiDeliveriesS2Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
