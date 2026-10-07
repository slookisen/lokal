/**
 * discovery-truth.test.ts — dev-request 2026-09-08-discovery-paritet-og-ett-katalogtall
 * (phase 1) incl. the 2026-10-06 addendum "discovery-sannhet generert fra live".
 *
 * Two locks, both driven through the REAL routers / MCP servers:
 *
 *  A. ONE catalog number ("honest count") per vertical. llms.txt, agent card,
 *     MCP server-card / mcp.json, agents.json (rfb), /api/stats and /health
 *     must all quote the SAME number. The fixtures are built so the honest
 *     count differs from every legacy raw count (unvetted / inactive / umbrella /
 *     hidden / rejected / non-clinic / unpublished rows), so a surface that
 *     still reads a legacy count fails here.
 *
 *  B. Tool lists = live tools/list. For every domain the tools named in
 *     mcp.json, server-card.json, the agent card (x-mcp-tools) and llms.txt
 *     must equal what a real MCP client gets back from tools/list (real
 *     McpServer + the SAME register function the /mcp endpoint runs, over the
 *     SDK's in-memory transport). Adding/removing a tool without the discovery
 *     files following (or the reverse) fails CI. Also: no phantom tools, no
 *     "agent-conversation"/forhandling capability, no ACP-feed channel while it
 *     has 0 rows.
 *
 * Plus the phase-1 parity items: dental /agents.txt alias + no "book" claim,
 * dental ai-plugin.json + openai-apps-challenge, robots.txt Content-Signal +
 * AI-agent groups on dental and opplevagent.
 *
 * Exported runDiscoveryTruthTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/discovery-truth.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Captured = { status: number; headers: Record<string, string>; body: any; text: string };

function fakeRes(done: (c: Captured) => void) {
  const headers: Record<string, string> = {};
  let status = 200;
  const finish = (body: any, text: string) => done({ status, headers, body, text });
  const r: any = {
    statusCode: 200,
    status(c: number) { status = c; r.statusCode = c; return r; },
    header(k: string, v?: string) { if (v !== undefined) headers[k.toLowerCase()] = String(v); return r; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return r; },
    set(k: string, v: string) { headers[k.toLowerCase()] = String(v); return r; },
    type(v: string) { headers["content-type"] = v; return r; },
    on() { return r; },
    json(b: any) { finish(b, JSON.stringify(b)); return r; },
    send(b: any) { finish(b, typeof b === "string" ? b : JSON.stringify(b)); return r; },
    end(b?: any) { finish(b, typeof b === "string" ? b : ""); return r; },
  };
  return r;
}

function fakeReq(url: string, hostname: string) {
  return {
    method: "GET",
    url,
    originalUrl: url,
    path: url.split("?")[0],
    query: {},
    headers: {},
    hostname,
    ip: "127.0.0.1",
    get(_n: string) { return undefined; },
  };
}

/** Drives an express Router with a fake req/res (no HTTP server). Resolves on send/json or when no route matched. */
function callRouter(router: any, url: string, hostname: string): Promise<Captured | null> {
  return new Promise((resolve) => {
    const res = fakeRes((c) => resolve(c));
    router.handle(fakeReq(url, hostname), res, () => resolve(null));
  });
}

/** Digits of a possibly nb-locale-formatted number ("5 447", NBSP/NNBSP/comma separators) -> number. */
function digitsToNumber(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const d = String(s).replace(/[^\d]/g, "");
  return d ? Number(d) : null;
}

export async function runDiscoveryTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const prevRfbDb = __peekDbForTesting();
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  const prevChallenge = process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN;
  delete process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN;

  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const resolveMod = (rel: string) => require.resolve(rel);
  const cachePaths = [
    resolveMod("../database/db-factory"),
    resolveMod("../services/dental-store"),
    resolveMod("../services/experience-store"),
    resolveMod("./a2a"),
    resolveMod("./dental-seo"),
    resolveMod("./experiences-seo"),
    resolveMod("./discovery"),
    resolveMod("./agent-readiness"),
  ];
  for (const p of cachePaths) delete require.cache[p];

  try {
    // ── vertical config (discovery.ts / registry card read getConfig()) ──
    const cfgMod = require("../config/vertical-config") as typeof import("../config/vertical-config");
    cfgMod._resetConfigCacheForTests();
    cfgMod.loadConfigsAtBoot({ dir: "./verticals" });

    // ── RFB fixtures: honest = active + non-umbrella + vetted + listable = 3 ──
    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);
    function seedRfb(id: string, o: { active?: number; umbrella?: string | null; vetted?: number; hidden?: number; vertical?: string } = {}): void {
      rfbTestDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          city, is_active, umbrella_type, is_vetted, catalog_hidden, vertical_id, created_at, last_seen_at
        ) VALUES (?, ?, 'En beskrivelse', ?, ?, ?, 'producer', ?, 'Oslo', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        id, `Testgård ${id}`, `Testgård ${id}`, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`,
        o.active ?? 1, o.umbrella ?? null, o.vetted ?? 1, o.hidden ?? 0, o.vertical ?? "rfb",
      );
    }
    seedRfb("rfb-1");
    seedRfb("rfb-2");
    seedRfb("rfb-3");
    seedRfb("rfb-inactive", { active: 0 });      // in legacy totalAgents, not honest
    seedRfb("rfb-umbrella", { umbrella: "venue" }); // in legacy totalAgents, not honest
    seedRfb("rfb-unvetted", { vetted: 0 });      // in legacy totalAgents, not honest
    seedRfb("rfb-hidden", { hidden: 1 });        // never listed anywhere
    seedRfb("rfb-dental", { vertical: "dental" }); // not an RFB producer
    const EXPECT_RFB = 3;

    const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const reg: any = regMod.marketplaceRegistry;
    const resetRfbCaches = () => { reg._statsCache = null; reg._agentsCache = null; };
    resetRfbCaches();

    // ── Dental fixtures: honest = 3 ──
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const insDental = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, poststed, fylke, verification_status, is_inactive, catalog_class)
       VALUES (@id, @navn, @poststed, @fylke, @verification_status, @is_inactive, @catalog_class)`,
    );
    const d = (id: string, vs: string, inactive: number, cls: string | null, poststed = "Oslo", fylke = "Oslo") =>
      insDental.run({ id, navn: `Tannlege ${id}`, poststed, fylke, verification_status: vs, is_inactive: inactive, catalog_class: cls });
    d("d-1", "verified", 0, "klinikk");
    d("d-2", "pending_verify", 0, null);
    d("d-3", "verified", 0, "offentlig_klinikk", "Bergen", "Vestland");
    d("d-rejected", "rejected", 0, "klinikk");        // legacy totalAgents only
    d("d-closed", "verified", 1, "klinikk");          // legacy totalAgents only
    d("d-lab", "verified", 0, "lab_leverandor");      // not a clinic
    d("persistence-probe-pr100b", "needs_review", 0, null, "TEST", "TEST"); // synthetic probe row
    const EXPECT_DENTAL = 3;

    // ── Experiences fixtures: honest (published experiences) = 2 ──
    const expDb = dbFactory.getDb("experiences");
    const insProv = expDb.prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, kommune, fylke, producer_type, rfb_seed_source, catalog_hidden, brreg_active)
       VALUES (@id, @navn, 'experiences', @kommune, @fylke, @producer_type, NULL, @catalog_hidden, 1)`,
    );
    insProv.run({ id: "e-1", navn: "Sidergård", kommune: "Bergen", fylke: "Vestland", producer_type: "cideri", catalog_hidden: null });
    insProv.run({ id: "e-2", navn: "Bryggeri Oslo", kommune: "Oslo", fylke: "Oslo", producer_type: "bryggeri", catalog_hidden: null });
    insProv.run({ id: "e-hidden", navn: "Skjult Gård", kommune: "Bergen", fylke: "Vestland", producer_type: "cideri", catalog_hidden: 1 });
    const insExp = expDb.prepare(
      `INSERT INTO experiences (id, provider_id, title, slug, verification_status, confidence, canonical_id)
       VALUES (@id, @provider_id, @title, @slug, @verification_status, @confidence, NULL)`,
    );
    insExp.run({ id: "x-1", provider_id: "e-1", title: "Sidersmaking", slug: "sidersmaking", verification_status: "verified", confidence: "high" });
    insExp.run({ id: "x-2", provider_id: "e-2", title: "Bryggeribesøk", slug: "bryggeribesok", verification_status: "verified", confidence: "medium" });
    insExp.run({ id: "x-3", provider_id: "e-1", title: "Ikke publisert", slug: "ikke-publisert", verification_status: "pending_verify", confidence: null });
    const EXPECT_EXP = 2;

    // ── Routers (fresh, after fixtures) ──
    const discoveryRouter = require("./discovery").default;
    const readinessRouter = require("./agent-readiness").default;
    const dentalRouter = require("./dental-seo").default;
    const expRouter = require("./experiences-seo").default;
    const a2aRouter = require("./a2a").default;
    const honest = require("../services/honest-count") as typeof import("../services/honest-count");
    const manifest = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");

    // ═════════════════════ A. ONE catalog number ═════════════════════
    assertEq(honest.honestCatalogCount("rfb"), EXPECT_RFB, "count-1: rfb honest count = active + non-umbrella + vetted + listable rows");
    assertEq(honest.honestCatalogCount("dental"), EXPECT_DENTAL, "count-2: dental honest count = non-rejected, open, clinic-class, non-probe rows");
    assertEq(honest.honestCatalogCount("experiences"), EXPECT_EXP, "count-3: experiences honest count = published experiences");
    assertEq(reg.getActiveAgents().length, EXPECT_RFB, "count-4: rfb honest count == marketplaceRegistry.getActiveAgents().length (the llms.txt list)");
    assertEq(
      (require("../services/dental-store") as typeof import("../services/dental-store")).getDentalStats().total,
      EXPECT_DENTAL,
      "count-5: dental honest count == getDentalStats().total (one shared SQL base)",
    );
    assertEq(honest.honestCatalogCounts(), { rfb: EXPECT_RFB, dental: EXPECT_DENTAL, experiences: EXPECT_EXP }, "count-6: honestCatalogCounts() (what /health serves as `catalog`)");
    assertEq(honest.catalogVerticalForHost("finn-tannlege.com"), "dental", "count-7a: host -> dental");
    assertEq(honest.catalogVerticalForHost("opplevagent.no"), "experiences", "count-7b: host -> experiences");
    assertEq(honest.catalogVerticalForHost("rettfrabonden.com"), "rfb", "count-7c: host -> rfb");

    // legacy numbers really do differ from the honest one in the fixtures (guards against a vacuous test)
    resetRfbCaches();
    assertTrue(reg.getStats().totalAgents !== EXPECT_RFB, "count-8a: fixture sanity — rfb legacy totalAgents differs from the honest count");
    assertTrue(
      (require("../services/dental-store") as typeof import("../services/dental-store")).getDentalMarketplaceStats().totalAgents !== EXPECT_DENTAL,
      "count-8b: fixture sanity — dental legacy totalAgents differs from the honest count",
    );

    // /health serves the shared helper (index.ts boots the whole app, so it is asserted on source)
    const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    assertTrue(indexSrc.includes("catalog: honestCatalogCounts()"), "count-9: /health's `catalog` is honestCatalogCounts()");

    // rfb surfaces
    {
      resetRfbCaches();
      const llms = await callRouter(discoveryRouter, "/llms.txt", "rettfrabonden.com");
      assertEq(digitsToNumber((llms?.text.match(/- (\d[\d\s.,]*) registrerte produsenter/) || [])[1]), EXPECT_RFB, "rfb-count-llms: llms.txt count");
      assertEq(digitsToNumber((llms?.text.match(/directly with (\d+)\+ local food/) || [])[1]), EXPECT_RFB, "rfb-count-llms-en: llms.txt English intro count");

      const card = regMod.marketplaceRegistry.getRegistryCard("https://rettfrabonden.com") as any;
      assertEq(digitsToNumber((String(card.description).match(/with (\d+)\+ verified/) || [])[1]), EXPECT_RFB, "rfb-count-card-desc: agent card description count");
      assertEq(card["x-lokal"].stats.totalAgents, EXPECT_RFB, "rfb-count-card-stats: agent card x-lokal.stats.totalAgents");

      for (const p of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp-server.json"]) {
        const r = await callRouter(readinessRouter, p, "rettfrabonden.com");
        assertEq(r?.body?.["x-lokal"]?.totalProducers, EXPECT_RFB, `rfb-count-${p}: totalProducers`);
        assertEq(digitsToNumber((String(r?.body?.description).match(/Discover (\d+) verified/) || [])[1]), EXPECT_RFB, `rfb-count-${p}: description count`);
      }
      const sc2 = await callRouter(discoveryRouter, "/.well-known/mcp/server-card.json", "rettfrabonden.com");
      assertEq(digitsToNumber((String(sc2?.body?.serverInfo?.description).match(/discover (\d+)/) || [])[1]), EXPECT_RFB, "rfb-count-discovery-server-card: description count");
      const aj = await callRouter(discoveryRouter, "/.well-known/agents.json", "rettfrabonden.com");
      assertEq(digitsToNumber((String(aj?.body?.description).match(/with (\d+)\+ producers/) || [])[1]), EXPECT_RFB, "rfb-count-agents.json: description count");
      const at = await callRouter(discoveryRouter, "/agents.txt", "rettfrabonden.com");
      assertEq(digitsToNumber((String(at?.text).match(/with (\d+)\+ producers/) || [])[1]), EXPECT_RFB, "rfb-count-agents.txt: description count");
      const plug = await callRouter(discoveryRouter, "/.well-known/ai-plugin.json", "rettfrabonden.com");
      assertEq(digitsToNumber((String(plug?.body?.description_for_model).match(/access to (\d+) verified/) || [])[1]), EXPECT_RFB, "rfb-count-ai-plugin: description count");
      const skills = await callRouter(readinessRouter, "/.well-known/agent-skills/index.json", "rettfrabonden.com");
      assertEq(digitsToNumber((String(skills?.body?.skills?.[0]?.description).match(/Search (\d+) verified/) || [])[1]), EXPECT_RFB, "rfb-count-agent-skills: description count");

      const st = await callRouter(a2aRouter, "/api/stats", "rettfrabonden.com");
      assertEq(st?.body?.data?.honestCount, EXPECT_RFB, "rfb-count-api-stats: data.honestCount");
      assertEq(st?.body?.data?.honestCountVertical, "rfb", "rfb-count-api-stats: data.honestCountVertical");
    }

    // dental surfaces
    {
      const llms = await callRouter(dentalRouter, "/llms.txt", "finn-tannlege.com");
      assertEq(digitsToNumber((llms?.text.match(/omtrent ([\d\s  ]+) klinikker/) || [])[1]), EXPECT_DENTAL, "dental-count-llms: llms.txt count");
      for (const p of ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/mcp-server.json"]) {
        const r = await callRouter(dentalRouter, p, "finn-tannlege.com");
        assertEq(r?.body?.["x-finn-tannlege"]?.totalClinics, EXPECT_DENTAL, `dental-count-${p}: totalClinics`);
        assertEq(digitsToNumber((String(r?.body?.description).match(/Search and compare ([\d\s  ]+) Norwegian/) || [])[1]), EXPECT_DENTAL, `dental-count-${p}: description count`);
      }
      const card = await callRouter(dentalRouter, "/.well-known/agent-card.json", "finn-tannlege.com");
      assertEq(card?.body?.["x-catalog"], { vertical: "dental", honestCount: EXPECT_DENTAL }, "dental-count-card: agent card x-catalog");
      assertEq(digitsToNumber((String(card?.body?.description).match(/Katalog \/ catalog: (\d+) klinikker/) || [])[1]), EXPECT_DENTAL, "dental-count-card-desc: agent card description count");
      const plug = await callRouter(dentalRouter, "/.well-known/ai-plugin.json", "finn-tannlege.com");
      assertEq(digitsToNumber((String(plug?.body?.description_for_model).match(/access to ([\d\s  ]+) clinics/) || [])[1]), EXPECT_DENTAL, "dental-count-ai-plugin: description count");
      const st = await callRouter(a2aRouter, "/api/stats", "finn-tannlege.com");
      assertEq(st?.body?.data?.honestCount, EXPECT_DENTAL, "dental-count-api-stats: data.honestCount");
      assertEq(st?.body?.data?.honestCountVertical, "dental", "dental-count-api-stats: data.honestCountVertical");
    }

    // experiences surfaces
    {
      const llms = await callRouter(expRouter, "/llms.txt", "opplevagent.no");
      assertEq(digitsToNumber((llms?.text.match(/Katalogen inneholder ([\d\s  ]+) publiserte opplevelser/) || [])[1]), EXPECT_EXP, "exp-count-llms: llms.txt now carries the catalog count (item 5)");
      for (const p of ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/mcp-server.json"]) {
        const r = await callRouter(expRouter, p, "opplevagent.no");
        assertEq(r?.body?.["x-opplevagent"]?.totalExperiences, EXPECT_EXP, `exp-count-${p}: totalExperiences`);
        assertEq(digitsToNumber((String(r?.body?.description).match(/Discover ([\d\s  ]+) curated/) || [])[1]), EXPECT_EXP, `exp-count-${p}: description count`);
      }
      const card = await callRouter(expRouter, "/.well-known/agent-card.json", "opplevagent.no");
      assertEq(card?.body?.["x-catalog"], { vertical: "experiences", honestCount: EXPECT_EXP }, "exp-count-card: agent card x-catalog");
      const st = await callRouter(a2aRouter, "/api/stats", "opplevagent.no");
      assertEq(st?.body?.data?.honestCount, EXPECT_EXP, "exp-count-api-stats: data.honestCount");
      assertEq(st?.body?.data?.honestCountVertical, "experiences", "exp-count-api-stats: data.honestCountVertical");
    }

    // ═════════════════ B. tool lists == live tools/list ═════════════════
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");

    async function liveToolNames(vertical: "rfb" | "dental" | "experiences"): Promise<string[]> {
      // Same register functions the /mcp endpoints call (routes/mcp.ts getOrCreateSession,
      // dental-mcp.ts, experiences-mcp.ts), real client, real tools/list.
      const server = new McpServer({ name: `live-${vertical}`, version: "0.0.0" });
      if (vertical === "rfb") (require("./mcp") as typeof import("./mcp")).registerTools(server);
      else if (vertical === "dental") (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
      else (require("./experiences-mcp") as typeof import("./experiences-mcp")).registerExperienceTools(server);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "discovery-truth-test", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      const res = await client.listTools();
      await client.close();
      await server.close();
      return res.tools.map((t) => t.name).sort();
    }
    const names = (arr: Array<{ name: string }> | undefined) => (arr || []).map((t) => t.name).sort();

    const live = {
      rfb: await liveToolNames("rfb"),
      dental: await liveToolNames("dental"),
      experiences: await liveToolNames("experiences"),
    };
    assertTrue(live.rfb.length >= 10 && live.dental.length === 5 && live.experiences.length >= 3, "tools-0: live tools/list returns tools for all three verticals");
    assertEq(manifest.registeredMcpToolNames("rfb").slice().sort(), live.rfb, "tools-1a: manifest(rfb) == live tools/list");
    assertEq(manifest.registeredMcpToolNames("dental").slice().sort(), live.dental, "tools-1b: manifest(dental) == live tools/list");
    assertEq(manifest.registeredMcpToolNames("experiences").slice().sort(), live.experiences, "tools-1c: manifest(experiences) == live tools/list");

    // RFB: mcp.json, server-card.json (+aliases), discovery.ts card, agent card, llms.txt, skills
    for (const p of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp-server.json"]) {
      const r = await callRouter(readinessRouter, p, "rettfrabonden.com");
      assertEq(names(r?.body?.tools), live.rfb, `tools-rfb-${p}: tools == live tools/list`);
    }
    {
      const arr = await callRouter(readinessRouter, "/.well-known/mcp/server-cards.json", "rettfrabonden.com");
      assertEq(names(arr?.body?.[0]?.tools), live.rfb, "tools-rfb-server-cards.json: tools == live tools/list");
      const sc2 = await callRouter(discoveryRouter, "/.well-known/mcp/server-card.json", "rettfrabonden.com");
      assertEq(names(sc2?.body?.tools), live.rfb, "tools-rfb-discovery-server-card: tools == live tools/list");
      const card = regMod.marketplaceRegistry.getRegistryCard("https://rettfrabonden.com") as any;
      assertEq([...card["x-lokal"].mcpTools].sort(), live.rfb, "tools-rfb-agent-card: x-lokal.mcpTools == live tools/list");
      const llms = await callRouter(discoveryRouter, "/llms.txt", "rettfrabonden.com");
      const m = String(llms?.text).match(/tilgjengelige verktøy \(([^)]*)\)/);
      assertEq((m ? m[1].split(",").map((s) => s.trim().replace(/`/g, "")) : []).sort(), live.rfb, "tools-rfb-llms: llms.txt tool list == live tools/list");

      // skills index never points at a tool that does not exist; negotiation skill gone
      const skills = await callRouter(readinessRouter, "/.well-known/agent-skills/index.json", "rettfrabonden.com");
      const skillTools = (skills?.body?.skills || []).map((s: any) => s?.invocation?.mcp?.tool).filter(Boolean);
      assertTrue(skillTools.length > 0 && skillTools.every((t: string) => live.rfb.includes(t)), `tools-rfb-skills: every skill's mcp tool exists (got ${JSON.stringify(skillTools)})`);
      assertTrue(!(skills?.body?.skills || []).some((s: any) => s.id === "agent-conversation"), "tools-rfb-skills: no agent-conversation skill");
      const stub = await callRouter(readinessRouter, "/.well-known/agent-skills/agent-conversation", "rettfrabonden.com");
      assertTrue(stub?.status === 404, "tools-rfb-skills: agent-conversation stub is gone (404)");
      for (const id of ["discover-local-food-agents", "search-compare-food"]) {
        const s = await callRouter(readinessRouter, `/.well-known/agent-skills/${id}`, "rettfrabonden.com");
        assertTrue(!s?.body?.mcpTool || live.rfb.includes(s.body.mcpTool), `tools-rfb-skill-stub-${id}: mcpTool exists in live tools/list`);
      }

      // no phantom tools anywhere in the rfb machine-readable surfaces
      const phantom = ["search_producers", "discover_by_category", "get_producer", "register_producer", "start_negotiation"];
      const blob = JSON.stringify([
        (await callRouter(readinessRouter, "/.well-known/mcp.json", "rettfrabonden.com"))?.body,
        skills?.body, card, sc2?.body,
      ]);
      assertTrue(phantom.every((n) => !blob.includes(`"${n}"`)), "tools-rfb-phantom: none of the 5 phantom tool names appear in mcp.json/server-card/skills/card");

      // option A: no negotiation capability on the card; ACP feed not advertised while it has 0 rows
      assertTrue(!(card.skills || []).some((s: any) => s.id === "agent-conversation"), "card-rfb-1: agent-conversation skill removed from the agent card");
      assertTrue(!/negotiat|forhandling/i.test(JSON.stringify(card)), "card-rfb-2: no negotiation/forhandling wording left on the agent card");
      assertTrue(!(card["x-distribution"] || []).some((c: any) => c.channel === "acp-product-feed"), "card-rfb-3: acp-product-feed removed from x-distribution (0 rows)");
    }

    // dental
    for (const p of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp-server.json"]) {
      const r = await callRouter(dentalRouter, p, "finn-tannlege.com");
      assertEq(names(r?.body?.tools), live.dental, `tools-dental-${p}: tools == live tools/list`);
    }
    {
      const arr = await callRouter(dentalRouter, "/.well-known/mcp/server-cards.json", "finn-tannlege.com");
      assertEq(names(arr?.body?.[0]?.tools), live.dental, "tools-dental-server-cards.json: tools == live tools/list");
      const card = await callRouter(dentalRouter, "/.well-known/agent-card.json", "finn-tannlege.com");
      assertEq([...(card?.body?.["x-mcp-tools"] || [])].sort(), live.dental, "tools-dental-agent-card: x-mcp-tools == live tools/list");
      assertTrue((card?.body?.skills || []).every((s: any) => live.dental.includes(s.id)), "tools-dental-agent-card: every card skill id is a live tool");
      const llms = await callRouter(dentalRouter, "/llms.txt", "finn-tannlege.com");
      const listed = [...String(llms?.text).matchAll(/^- (tannlege_\w+) — /gm)].map((m) => m[1]).sort();
      assertEq(listed, live.dental, "tools-dental-llms: llms.txt tool list == live tools/list");
    }

    // experiences
    for (const p of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp-server.json"]) {
      const r = await callRouter(expRouter, p, "opplevagent.no");
      assertEq(names(r?.body?.tools), live.experiences, `tools-exp-${p}: tools == live tools/list`);
    }
    {
      const arr = await callRouter(expRouter, "/.well-known/mcp/server-cards.json", "opplevagent.no");
      assertEq(names(arr?.body?.[0]?.tools), live.experiences, "tools-exp-server-cards.json: tools == live tools/list");
      const card = await callRouter(expRouter, "/.well-known/agent-card.json", "opplevagent.no");
      assertEq([...(card?.body?.["x-mcp-tools"] || [])].sort(), live.experiences, "tools-exp-agent-card: x-mcp-tools == live tools/list");
      // (experiences card skill ids are A2A skill names — opplevelser_*, not MCP tool ids — so only x-mcp-tools is compared)
      const llms = await callRouter(expRouter, "/llms.txt", "opplevagent.no");
      const section = String(llms?.text).split("Tilgjengelige MCP-verktøy:")[1]?.split("\n\n")[0] || "";
      const listed = [...section.matchAll(/^- (\w+) — /gm)].map((m) => m[1]).sort();
      assertEq(listed, live.experiences, "tools-exp-llms: llms.txt tool list == live tools/list");
    }

    // ═════════════════ C. phase-1 parity items ═════════════════
    {
      // 1. dental agents.txt: root alias, no booking claim
      const wk = await callRouter(dentalRouter, "/.well-known/agents.txt", "finn-tannlege.com");
      const root = await callRouter(dentalRouter, "/agents.txt", "finn-tannlege.com");
      assertEq(root?.status, 200, "dental-agents.txt: GET /agents.txt -> 200");
      assertEq(root?.text, wk?.text, "dental-agents.txt: root alias == well-known body");
      assertTrue(!/\bbook(ing)?\b/i.test(String(root?.text).replace(/no online booking/i, "")), "dental-agents.txt: no 'book'/'booking' capability claimed");
      assertTrue(live.dental.every((n) => !/book|bestill/i.test(n)), "dental-agents.txt: sanity — no dental MCP tool books anything");

      // 4. ai-plugin + openai-apps-challenge on dental
      const plug = await callRouter(dentalRouter, "/.well-known/ai-plugin.json", "finn-tannlege.com");
      assertEq(plug?.status, 200, "dental-ai-plugin: 200");
      assertEq(plug?.body?.api?.url, "https://finn-tannlege.com/openapi.json", "dental-ai-plugin: points at the dental OpenAPI spec");
      assertEq(plug?.body?.schema_version, "v1", "dental-ai-plugin: schema_version v1");
      const noTok = await callRouter(dentalRouter, "/.well-known/openai-apps-challenge", "finn-tannlege.com");
      assertEq(noTok?.status, 404, "dental-challenge: 404 while no token is configured (never a wrong token)");
      process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN = "test-token-123";
      const withTok = await callRouter(dentalRouter, "/.well-known/openai-apps-challenge", "finn-tannlege.com");
      assertEq(withTok?.status, 200, "dental-challenge: 200 once the token is configured");
      assertEq(withTok?.text, "test-token-123", "dental-challenge: literal token as body");
      assertEq(withTok?.headers["content-type"], "text/plain", "dental-challenge: text/plain");
      delete process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN;

      // 2. robots.txt parity (Content-Signal + AI-agent groups + CCBot block) on both verticals
      const requiredAgents = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "Perplexity-User", "Applebot", "MistralAI-User", "meta-externalfetcher", "Googlebot", "Bingbot"];
      for (const [label, router, host] of [["dental", dentalRouter, "finn-tannlege.com"], ["exp", expRouter, "opplevagent.no"]] as const) {
        const rb = await callRouter(router, "/robots.txt", host);
        const body = String(rb?.text);
        assertTrue(body.includes("User-agent: *\nAllow: /"), `robots-${label}: wildcard group`);
        assertTrue(body.includes("Content-Signal: search=yes, ai-input=yes, ai-train=no"), `robots-${label}: Content-Signal search=yes, ai-input=yes, ai-train=no`);
        for (const a of requiredAgents) {
          assertTrue(new RegExp(`^User-agent: ${a}$`, "mi").test(body), `robots-${label}: group for ${a}`);
        }
        assertTrue(/User-agent: CCBot\nDisallow: \/\n/.test(body), `robots-${label}: CCBot blocked like rfb`);
        // every AI group carries the signal
        const groups = body.split(/\n\n/).filter((g) => /^User-agent: (GPTBot|ClaudeBot|Claude-User|Perplexity-User|MistralAI-User|meta-externalfetcher|Applebot)$/m.test(g));
        assertTrue(groups.length === 7 && groups.every((g) => g.includes("Content-Signal: search=yes, ai-input=yes, ai-train=no")), `robots-${label}: each AI group carries the Content-Signal`);
        assertTrue(/Sitemap: https:\/\/[^\n]+\/sitemap\.xml/.test(body), `robots-${label}: Sitemap line kept`);
      }
      const rbExp = String((await callRouter(expRouter, "/robots.txt", "opplevagent.no"))?.text);
      assertTrue(rbExp.includes("Disallow: /kategori/gardssalg/eier/") && /User-agent: Claude-User\nAllow: \/\nDisallow: \/kategori\/gardssalg\/eier\//.test(rbExp), "robots-exp: gårdssalg private-path Disallow repeated inside the new groups");

      // 3. x-distribution
      const dCard = (await callRouter(dentalRouter, "/.well-known/agent-card.json", "finn-tannlege.com"))?.body;
      const eCard = (await callRouter(expRouter, "/.well-known/agent-card.json", "opplevagent.no"))?.body;
      const dCh = (dCard?.["x-distribution"] || []).map((c: any) => c.channel).sort();
      const eCh = (eCard?.["x-distribution"] || []).map((c: any) => c.channel).sort();
      assertEq(dCh, ["a2a-registry", "agenstry", "custom-gpt", "npm", "official-mcp-registry"], "xdist-dental: real channels declared (mcp.so omitted — not live)");
      assertEq(eCh, ["a2a-registry", "agenstry", "custom-gpt", "mcp-so", "npm", "official-mcp-registry"], "xdist-exp: real channels declared");
      assertTrue(
        [...(dCard?.["x-distribution"] || []), ...(eCard?.["x-distribution"] || [])].every((c: any) => c.status === "live" && /^https:\/\//.test(c.url) && c.install),
        "xdist: every entry has status live, https url and install",
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("discovery-truth: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    if (prevChallenge === undefined) delete process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN; else process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN = prevChallenge;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    try {
      const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (regMod.marketplaceRegistry as any)._statsCache = null;
      (regMod.marketplaceRegistry as any)._agentsCache = null;
    } catch { /* best-effort */ }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDiscoveryTruthTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    // route modules start background timers; exit explicitly
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
