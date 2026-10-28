/**
 * organic-claims-s0.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S0 (P0, Debio complaint):
 * no organic claim on any public read surface without a valid Debio status
 * (until S1: agents.debio_verified = 1). AC0.1–AC0.4.
 *
 *   words     the shared word list (organic-claims.ts, regelbok §2): hits,
 *             other meanings (økonomi, økosystem, økologisk mangfold) are not,
 *             list entries filtered / dropped.
 *   unverif.  a fixture producer WITHOUT status, «Økologisk» in
 *             certifications, specialties, tags, skill tags and organic:true
 *             on a product → 0 hits from the word list (beyond the page
 *             chrome a clean twin also has) in profile HTML (NO/EN/SV),
 *             JSON-LD, /info, /card, /agents, MCP lokal_info/lokal_search/
 *             lokal_discover and A2A agent/info; no badge-o, no prod-org,
 *             no «Hevder økologisk», organic:false.
 *   verified  a fixture WITH debio_verified=1 keeps the badge, «✓ Debio-
 *             verifisert», its organic tags and organic:true.
 *   search    the «organic» tag family (økologisk/organic/øko/debio) only
 *             filters to / ranks the verified producer.
 *   owner     the owner's own /info read (X-Claim-Token) sees stored lists.
 *   debio     «Debio Sertifisering» (41fde168-…) is not in /agents nor
 *             discover, /info 404, lokal_info and A2A not found.
 *   stored    agents + agent_knowledge rows byte-identical after every read.
 *
 * Real routers/services on the production schema in an in-memory DB; handlers
 * pulled off the router stacks (same harness as owner-features-s2c.test.ts).
 * Exported runOrganicClaimsS0Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/organic-claims-s0.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";
import {
  containsOrganicClaim, isOrganicWord, stripOrganicEntries, stripOrganicFromEntry, stripOrganicTags,
} from "../services/organic-claims";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const UNVERIFIED_ID = "s0-uten-status";
const VERIFIED_ID = "s0-med-status";
const CLEAN_ID = "s0-ren-tvilling";
const DEBIO_ID = "41fde168-d82b-4b1b-a173-ed72df8c944e";
const NAMES: Record<string, string> = {
  [UNVERIFIED_ID]: "Kvernstua Gard Prove",
  [VERIFIED_ID]: "Lysbakken Gard Prove",
  [CLEAN_ID]: "Nordtun Gard Prove",
  [DEBIO_ID]: "Debio Sertifisering",
};

function seedProducer(db: Database.Database, id: string, o: { verified: boolean; organic: boolean; role?: string; url?: string }): void {
  const tags = o.organic ? ["organic", "økologisk", "debio", "gårdsutsalg"] : ["gårdsutsalg"];
  const skills = [{ id: "sell", name: "Gårdsutsalg", description: "Salg fra gården", tags: o.organic ? ["økologisk", "grønnsaker"] : ["grønnsaker"] }];
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified)
     VALUES (?, ?, ?, 'test', ?, ?, ?, ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', ?, ?, 0.7, 1, 1, 'discovery', 'rfb', 0, ?)`,
  ).run(
    id, NAMES[id],
    "Familiegård i Oslo-området som dyrker gulrøtter og poteter, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, o.url ?? `https://${id}.example.no`, o.role ?? "producer", `key-${id}`,
    JSON.stringify(tags), JSON.stringify(skills), o.verified ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, phone, address, postal_code, about, products, specialties, certifications,
        verification_status, verified_second_line, enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '0150', ?, ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker gulrøtter, poteter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([
      { name: "Gulrøtter", category: "vegetables", organic: o.organic },
      { name: "Poteter", category: "vegetables" },
    ]),
    JSON.stringify(o.organic ? ["Økologisk produksjon", "Økologiske grønnsaker", "Gårdsost"] : ["Grønnsaker", "Gårdsost"]),
    JSON.stringify(o.organic ? ["Økologisk", "Debio-sertifisert", "Nyt Norge"] : ["Nyt Norge"]),
  );
}

/** Organic-word hits in a text (one per token), for comparing against the clean twin. */
function organicHits(text: string): string[] {
  return text.split(/[\s<>"'(),.;:!?=]+/).filter((t) => t && isOrganicWord(t) && !/^økonom|^økosystem/i.test(t));
}

export async function runOrganicClaimsS0Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  // ── words: the shared list (pure) ─────────────────────────────────────────
  for (const w of ["økologisk", "Økologiske", "øko", "økogård", "Ø-merket", "organic", "Organisk", "ekologisk", "biodynamisk", "Bio-dynamisk", "Demeter", "Debio", "Debio-sertifisert", "DEBIO", "økomerket"]) {
    assertTrue(isOrganicWord(w), `words-hit: «${w}» is an organic word`);
  }
  for (const w of ["økonomi", "økosystem", "gård", "Nyt", "bio", "organisasjon"]) {
    assertTrue(!isOrganicWord(w), `words-miss: «${w}» is not an organic word`);
  }
  assertTrue(!containsOrganicClaim("Vi tar vare på økologisk mangfold i kulturlandskapet."), "words-G: «økologisk mangfold» is another meaning");
  assertTrue(containsOrganicClaim("Gård med økologisk drift."), "words-A2: «økologisk drift» is a claim");
  assertEq(stripOrganicFromEntry("Økologiske grønnsaker"), "Grønnsaker", "entry-1: «Økologiske grønnsaker» → «Grønnsaker»");
  assertEq(stripOrganicFromEntry("Økologisk produksjon"), null, "entry-2: «Økologisk produksjon» dropped (filler only)");
  assertEq(stripOrganicFromEntry("Debio-sertifisert"), null, "entry-3: «Debio-sertifisert» dropped");
  assertEq(stripOrganicFromEntry("Ø-merket honning"), "Honning", "entry-4: «Ø-merket honning» → «Honning»");
  assertEq(stripOrganicFromEntry("økologisk og kortreist"), "kortreist", "entry-5: dangling connector trimmed");
  assertEq(stripOrganicFromEntry("100% økologisk"), null, "entry-6: no letters left → dropped");
  assertEq(stripOrganicFromEntry("Nyt Norge"), "Nyt Norge", "entry-7: entry without organic words unchanged");
  assertEq(stripOrganicEntries(["Økologisk", "Økologiske grønnsaker", "Grønnsaker", "Gårdsost"]), ["Grønnsaker", "Gårdsost"], "entry-8: list filtered, duplicates collapsed");
  assertEq(stripOrganicTags(["organic", "økologisk", "debio", "gårdsutsalg"]), ["gårdsutsalg"], "entry-9: tags filtered");

  // ── route harness ─────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string>; body?: any; lang?: string }): any {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header(k: string, v: string) { headers[String(k).toLowerCase()] = String(v); return res; },
        set() { return res; }, type() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const routeModules = ["./marketplace", "./seo", "./mcp", "./a2a"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
    const a2aRouter = require("./a2a").default as any;

    const tools = new Map<string, (args: any) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    const H = {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      agents: findRouteHandler(marketplaceRouter, "/agents", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
    };

    seedProducer(db, UNVERIFIED_ID, { verified: false, organic: true });
    seedProducer(db, VERIFIED_ID, { verified: true, organic: true });
    seedProducer(db, CLEAN_ID, { verified: false, organic: false });
    seedProducer(db, DEBIO_ID, { verified: false, organic: true, role: "quality", url: "https://debio.no" });
    const OWNER_CLAIM = "s0-owner-claim";
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
      .run("claim-s0", UNVERIFIED_ID, `post@${UNVERIFIED_ID}.example.no`, "Eier", OWNER_CLAIM, new Date(Date.now() + 86_400_000).toISOString());

    const snapshot = () => JSON.stringify([
      db.prepare("SELECT id, tags, skills, debio_verified, is_active FROM agents ORDER BY id").all(),
      db.prepare("SELECT agent_id, products, specialties, certifications, about FROM agent_knowledge ORDER BY agent_id").all(),
    ]);
    const before = snapshot();

    // ── Surface readers ───────────────────────────────────────────────────
    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const page = async (id: string, lang = "no") => String((await invoke(H.produsent, makeReq({ params: { slug: slugify(NAMES[id]) }, lang }))).body ?? "");
    const jsonLd = (html: string) => [...html.matchAll(LD_RE)].map((m) => m[1]).join("\n");
    const restInfo = async (id: string, claim?: string) =>
      (await invoke(H.info, makeReq({ params: { id }, headers: claim ? { "x-claim-token": claim } : {} })));
    const card = async (id: string) => (await invoke(H.card, makeReq({ params: { id } }))).body;
    const agentsList = async () => (await invoke(H.agents, makeReq({}))).body?.agents ?? [];
    const lokalInfo = (id: string) => toolText("lokal_info", { agentId: id });
    const listBlock = (text: string, id: string) => text.split("\n\n").find((b) => b.includes(NAMES[id])) ?? "";
    const a2aInfo = async (id: string) =>
      (await invoke(H.a2a, makeReq({ body: { jsonrpc: "2.0", method: "agent/info", params: { agentId: id }, id: 1 } }))).body;
    const json = (x: unknown) => JSON.stringify(x ?? null);
    const noClaim = (label: string, text: string) => assertTrue(!containsOrganicClaim(text), label, organicHits(text));

    // ── unverified: profile HTML NO/EN/SV + JSON-LD ───────────────────────
    for (const lang of ["no", "en", "sv"]) {
      const html = await page(UNVERIFIED_ID, lang);
      const twin = await page(CLEAN_ID, lang);
      assertTrue(html.includes(NAMES[UNVERIFIED_ID]), `html-${lang}-0: the profile page renders`);
      assertTrue(!html.includes('class="badge badge-o"'), `html-${lang}-1: no «🌱 Økologisk» badge (badge-o) without status`);
      assertTrue(!html.includes('class="prod-org"'), `html-${lang}-2: no «🌱 Øko» product marker (prod-org)`);
      assertTrue(!html.includes("Hevder økologisk"), `html-${lang}-3: no «Hevder økologisk»`);
      assertEq(organicHits(html).length, organicHits(twin).length, `html-${lang}-4: organic-word hits equal the clean twin's (page chrome only)`);
      const ld = jsonLd(html);
      const keywords = [...ld.matchAll(/"keywords":\s*"([^"]*)"/g)].map((m) => m[1]).join(", ");
      assertTrue(keywords.includes("Nyt Norge"), `ld-${lang}-1: JSON-LD keywords keep the non-organic certification`);
      noClaim(`ld-${lang}-2: JSON-LD keywords carry no organic word`, keywords);
      assertEq(organicHits(ld).length, organicHits(jsonLd(twin)).length, `ld-${lang}-3: JSON-LD organic hits equal the clean twin's`);
    }

    // ── unverified: /info ─────────────────────────────────────────────────
    const info = (await restInfo(UNVERIFIED_ID)).body?.data;
    assertEq(info?.knowledge?.certifications, ["Nyt Norge"], "info-1: certifications without organic words, no «Hevder økologisk»");
    assertEq(info?.knowledge?.specialties, ["Grønnsaker", "Gårdsost"], "info-2: specialties without organic words (organic-only entry dropped)");
    assertTrue((info?.knowledge?.products ?? []).every((p: any) => p?.organic !== true), "info-3: products[].organic never true");
    assertEq(info?.knowledge?.products?.[0]?.name, "Gulrøtter", "info-4: product names untouched");
    assertEq(info?.agent?.debioVerified, false, "info-5: debioVerified false");
    noClaim("info-6: no organic word in certifications/specialties", json([info?.knowledge?.certifications, info?.knowledge?.specialties]));

    // ── owner's own /info read sees the stored lists ──────────────────────
    const ownerInfo = (await restInfo(UNVERIFIED_ID, OWNER_CLAIM)).body?.data;
    assertEq(ownerInfo?.knowledge?.certifications, ["Økologisk", "Debio-sertifisert", "Nyt Norge"], "owner-1: owner read keeps stored certifications (no save-back loss)");
    assertEq(ownerInfo?.knowledge?.specialties, ["Økologisk produksjon", "Økologiske grønnsaker", "Gårdsost"], "owner-2: owner read keeps stored specialties");
    assertEq(ownerInfo?.knowledge?.products?.[0]?.organic, true, "owner-3: owner read keeps the stored organic flag");

    // ── unverified: /card, /agents ────────────────────────────────────────
    const c = await card(UNVERIFIED_ID);
    assertTrue(!!c && !c.error, "card-0: card served", c);
    noClaim("card-1: card tags/certifications/specialties/skill tags carry no organic word", json([c?.["x-lokal"]?.tags, c?.certifications, c?.specialties, c?.skills]));
    assertTrue((c?.products ?? []).every((p: any) => p?.organic !== true), "card-2: card products never organic");
    const listed = (await agentsList()).find((a: any) => a.id === UNVERIFIED_ID);
    assertTrue(!!listed, "agents-0: unverified producer listed");
    noClaim("agents-1: /agents tags + skill tags carry no organic word", json([listed?.tags, listed?.skills]));
    const listedVerified = (await agentsList()).find((a: any) => a.id === VERIFIED_ID);
    assertTrue((listedVerified?.tags ?? []).includes("organic"), "agents-2: verified producer keeps its organic tag");

    // ── unverified: MCP ───────────────────────────────────────────────────
    const li = await lokalInfo(UNVERIFIED_ID);
    assertTrue(li.includes(NAMES[UNVERIFIED_ID]), "mcp-info-0: lokal_info answers");
    noClaim("mcp-info-1: lokal_info carries no organic word", li);
    const ls = await toolText("lokal_search", { query: NAMES[UNVERIFIED_ID] });
    assertTrue(ls.includes(NAMES[UNVERIFIED_ID]), "mcp-search-0: lokal_search finds the producer");
    noClaim("mcp-search-1: lokal_search carries no organic word", ls);
    const ld = await toolText("lokal_discover", { categories: ["vegetables"] });
    const block = listBlock(ld, UNVERIFIED_ID);
    assertTrue(block.length > 0, "mcp-discover-0: lokal_discover lists the producer");
    noClaim("mcp-discover-1: lokal_discover block carries no organic word", block);

    // ── unverified: A2A ───────────────────────────────────────────────────
    const a2a = await a2aInfo(UNVERIFIED_ID);
    const a2aText = json(a2a);
    assertTrue(a2aText.includes(NAMES[UNVERIFIED_ID]), "a2a-0: agent/info answers");
    noClaim("a2a-1: A2A agent/info carries no organic word (besides product names, none here)", a2aText);
    assertTrue(!/"organic":\s*true/.test(a2aText), "a2a-2: A2A organic never true");

    // ── verified fixture keeps its status markers ─────────────────────────
    const vHtml = await page(VERIFIED_ID);
    assertTrue(vHtml.includes('class="badge badge-o"'), "verified-1: badge-o kept with debio_verified=1");
    assertTrue(vHtml.includes('class="prod-org"'), "verified-2: «🌱 Øko» product marker kept");
    const vInfo = (await restInfo(VERIFIED_ID)).body?.data;
    assertEq(vInfo?.knowledge?.certifications?.[0], "✓ Debio-verifisert", "verified-3: «✓ Debio-verifisert» kept");
    assertEq(vInfo?.knowledge?.products?.[0]?.organic, true, "verified-4: organic:true kept");
    assertTrue((vInfo?.knowledge?.specialties ?? []).includes("Økologiske grønnsaker"), "verified-5: specialties untouched");

    // ── search: the organic tag family only matches the verified producer ─
    const discover = async (body: any) => ((await invoke(H.discover, makeReq({ body }))).body?.results ?? []) as any[];
    const organicHitsDiscover = await discover({ categories: ["vegetables"], tags: ["organic"] });
    assertEq(organicHitsDiscover.map((r: any) => r.agent?.id).sort(), [VERIFIED_ID], "search-1: tags:[organic] filters to the verified producer only");
    const srch = (await invoke(H.search, makeReq({ query: { q: "økologisk grønnsaker", heleNorge: "true" } }))).body?.results ?? [];
    const unverRes = srch.find((r: any) => r.agent?.id === UNVERIFIED_ID);
    assertTrue(!unverRes || !json(unverRes.matchReasons ?? unverRes.reasons ?? []).includes("organic"), "search-2: no organic ranking reason for the unverified producer", unverRes?.matchReasons);
    assertTrue(srch.length === 0 || srch[0]?.agent?.id === VERIFIED_ID, "search-3: «økologisk grønnsaker» ranks the verified producer first", srch.map((r: any) => r.agent?.id));

    // ── «Debio Sertifisering» delisted ────────────────────────────────────
    assertTrue(!(await agentsList()).some((a: any) => a.id === DEBIO_ID || a.name === NAMES[DEBIO_ID]), "debio-1: not in /api/marketplace/agents");
    assertEq((await restInfo(DEBIO_ID)).status, 404, "debio-2: /agents/41fde168-…/info → 404");
    assertTrue((await lokalInfo(DEBIO_ID)).startsWith("Fant ingen produsent"), "debio-3: lokal_info not found");
    assertTrue(!!(await a2aInfo(DEBIO_ID))?.error, "debio-4: A2A agent/info not found");
    const allDiscover = await discover({});
    assertTrue(!allDiscover.some((r: any) => r.agent?.id === DEBIO_ID), "debio-5: not in discover");
    const debioSearch = await toolText("lokal_search", { query: "Debio Sertifisering" });
    assertTrue(!debioSearch.includes(`. ${NAMES[DEBIO_ID]}**`), "debio-6: not found by name in lokal_search", debioSearch.slice(0, 300));

    // ── stored values unchanged (AC0.4) ───────────────────────────────────
    assertEq(snapshot(), before, "stored-1: agents + agent_knowledge byte-identical after all reads");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* already closed */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicClaimsS0Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
