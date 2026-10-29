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
 *   S0b       categories: «organic» in the fixture's categories is not shown
 *             without status (chip badge-c, JSON-LD additionalType, answer-
 *             first opening, /agents, card, /find-match, MCP, A2A metrics/
 *             leaderboard), the opening stays grammatical, an «organic»-only
 *             producer gets no category list, chip or additionalType at all;
 *             category filter/ranking for «organic» only finds the verified
 *             producer. The «Hva folk søker etter» panel drops «økologisk
 *             kjøtt» without status and renders as with no data when every
 *             term is gone.
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
const ONLY_ORGANIC_CAT_ID = "s0b-kun-en-kategori";
const DEBIO_ID = "41fde168-d82b-4b1b-a173-ed72df8c944e";
const NAMES: Record<string, string> = {
  [UNVERIFIED_ID]: "Kvernstua Gard Prove",
  [VERIFIED_ID]: "Lysbakken Gard Prove",
  [CLEAN_ID]: "Nordtun Gard Prove",
  [ONLY_ORGANIC_CAT_ID]: "Vestli Gard Prove",
  [DEBIO_ID]: "Debio Sertifisering",
};

function seedProducer(db: Database.Database, id: string, o: { verified: boolean; organic: boolean; role?: string; url?: string; categories?: string[] }): void {
  // S0b: an organic producer's categories carry «organic» too.
  const categories = o.categories ?? (o.organic ? ["vegetables", "organic"] : ["vegetables"]);
  const tags = o.organic ? ["organic", "økologisk", "debio", "gårdsutsalg", "local/organic"] : ["gårdsutsalg", "local"];
  const skills = [{ id: "sell", name: "Gårdsutsalg", description: "Salg fra gården", tags: o.organic ? ["økologisk", "grønnsaker"] : ["grønnsaker"] }];
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified)
     VALUES (?, ?, ?, 'test', ?, ?, ?, ?, 59.9139, 10.7522, 'Oslo', ?, ?, ?, 0.7, 1, 1, 'discovery', 'rfb', 0, ?)`,
  ).run(
    id, NAMES[id],
    "Familiegård i Oslo-området som dyrker gulrøtter og poteter, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, o.url ?? `https://${id}.example.no`, o.role ?? "producer", `key-${id}`,
    JSON.stringify(categories), JSON.stringify(tags), JSON.stringify(skills), o.verified ? 1 : 0,
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
    JSON.stringify(o.organic ? ["Økologisk", "Debio-sertifisert", "Nyt Norge", "Kortreist/økologisk"] : ["Nyt Norge", "Kortreist"]),
  );
}

/** Organic-word hits in a text (one per token), for comparing against the clean twin. */
/**
 * Fix-up round 1 (review B1): an independent probe that does NOT use the
 * module under test — a plain case-insensitive regex over the output. The
 * fixtures avoid the other-meaning words (økonomi, økosystem, økologisk
 * mangfold), so every hit here is a leak.
 */
const PLAIN_ORGANIC_RE = /øko|organic|organisk|ekologisk|debio|biodynam|demeter|ø-merk/gi;
function plainHits(text: string): string[] {
  // JSON field NAMES («"debioVerified":», «"organic": false») are not claims.
  return text.replace(/"(debioVerified|organic)"\s*:/g, "").match(PLAIN_ORGANIC_RE) ?? [];
}

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
  // Fix-up round 1 (review B1): organic words glued to other words.
  for (const [input, expected] of [
    ["Kortreist/økologisk", "Kortreist"],
    ["Lokal,økologisk", "Lokal"],
    ["100%økologisk", null],
    ["Halvøko", null],
    ["Honning (økologisk)", "Honning"],
    ["Gulrøtter; Ø-merket", "Gulrøtter"],
    ["bio-dynamisk dyrking", null],
    ["Lokal|organic|kortreist", "Lokal|kortreist"],
    ["øko-egg", "egg"],
    ["Øko-egg", "Egg"],
  ] as Array<[string, string | null]>) {
    assertEq(stripOrganicFromEntry(input), expected, `glued: «${input}» → ${JSON.stringify(expected)}`);
    assertTrue(containsOrganicClaim(input), `glued: «${input}» is a claim`);
  }
  assertEq(stripOrganicTags(["local/organic", "fresh+organic"]), ["local", "fresh"], "glued: tags «local/organic», «fresh+organic» → «local», «fresh»");
  for (const w of ["sjøkort", "Samfunnsøkonomi", "kystøkosystem", "organisasjon"]) {
    assertTrue(!containsOrganicClaim(w), `glued-miss: «${w}» is not a claim`);
  }

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
    // S0b: «organic» is this unverified producer's ONLY category.
    seedProducer(db, ONLY_ORGANIC_CAT_ID, { verified: false, organic: false, categories: ["organic"] });

    // S0b: visitor search terms («Hva folk søker etter», conversations.query_text).
    const conv = db.prepare("INSERT INTO conversations (id, seller_agent_id, query_text) VALUES (?, ?, ?)");
    let convN = 0;
    for (const [pid, terms] of [
      [UNVERIFIED_ID, ["økologisk kjøtt", "økologisk kjøtt", "gulrøtter oslo"]],
      [VERIFIED_ID, ["økologisk kjøtt", "gulrøtter oslo"]],
      [ONLY_ORGANIC_CAT_ID, ["økologisk kjøtt", "Organic eggs"]],
    ] as Array<[string, string[]]>) {
      for (const t of terms) conv.run(`s0b-conv-${++convN}`, pid, t);
    }

    // Fix-up round 1 (review B2): umbrellas + affiliations. The real Debio
    // umbrella is inactive since 2026-07-06 but its affiliation rows remain.
    const umbrella = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, categories, tags,
         trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, umbrella_type)
       VALUES (?, ?, 'Paraply', 'test', ?, ?, 'producer', ?, 'Oslo', '[]', '[]', 0.5, ?, 1, 'discovery', 'rfb', 0, ?)`,
    );
    umbrella.run("2a10c855-00c5-4ba3-a34e-315e930f95a5", "Debio", "post@debio.example.no", "https://debio.example.no", "key-debio-umb", 0, "certification");
    umbrella.run("s0-umb-demeter", "Demeter Norge", "post@demeter.example.no", "https://demeter.example.no", "key-demeter-umb", 1, "certification");
    umbrella.run("s0-umb-bm", "Bondens marked Oslo", "post@bm.example.no", "https://bm.example.no", "key-bm-umb", 1, "market_network");
    const aff = db.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, ?, ?)");
    for (const pid of [UNVERIFIED_ID, VERIFIED_ID]) {
      aff.run(pid, "2a10c855-00c5-4ba3-a34e-315e930f95a5", "pending_confirmation", "inferred");
      aff.run(pid, "s0-umb-demeter", "active", "admin");
      aff.run(pid, "s0-umb-bm", "active", "admin");
    }
    const OWNER_CLAIM = "s0-owner-claim";
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
      .run("claim-s0", UNVERIFIED_ID, `post@${UNVERIFIED_ID}.example.no`, "Eier", OWNER_CLAIM, new Date(Date.now() + 86_400_000).toISOString());

    const snapshot = () => JSON.stringify([
      db.prepare("SELECT id, categories, tags, skills, debio_verified, is_active FROM agents ORDER BY id").all(),
      db.prepare("SELECT id, seller_agent_id, query_text FROM conversations ORDER BY id").all(),
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
    // The affiliation chips («Tilknytninger» card) of a profile page.
    const affChips = (html: string) => (html.match(/<a [^>]*class="aff-item[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? []).join("\n");
    // JSON field NAMES («"debioVerified":», «"organic": false») are not claims.
    const withoutJsonKeys = (text: string) => text.replace(/"(debioVerified|organic)"\s*:/g, "");
    // Two independent probes: the module's own matcher AND a plain regex (B1).
    const noClaim = (label: string, text: string) => {
      assertTrue(!containsOrganicClaim(withoutJsonKeys(text)), label, organicHits(withoutJsonKeys(text)));
      assertEq(plainHits(text), [], `${label} [plain regex]`);
    };

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
      assertEq(plainHits(html).length, plainHits(twin).length, `html-${lang}-5: plain-regex hits equal the clean twin's (page chrome only)`);
      assertEq(plainHits(ld).length, plainHits(jsonLd(twin)).length, `ld-${lang}-4: JSON-LD plain-regex hits equal the clean twin's`);
      // B2: affiliation chips.
      const chips = affChips(html);
      assertTrue(!chips.includes("antatt — ikke bekreftet") && !/>Debio</.test(chips), `aff-${lang}-1: no inactive Debio umbrella chip`, chips);
      assertTrue(!chips.includes("Demeter Norge"), `aff-${lang}-2: no certification-umbrella chip without Debio status`, chips);
      assertTrue(chips.includes("Bondens marked Oslo"), `aff-${lang}-3: a non-organic umbrella chip stays`, chips);
    }

    // ── unverified: /info ─────────────────────────────────────────────────
    const info = (await restInfo(UNVERIFIED_ID)).body?.data;
    assertEq(info?.knowledge?.certifications, ["Nyt Norge", "Kortreist"], "info-1: certifications without organic words, no «Hevder økologisk»");
    assertEq(info?.knowledge?.specialties, ["Grønnsaker", "Gårdsost"], "info-2: specialties without organic words (organic-only entry dropped)");
    assertTrue((info?.knowledge?.products ?? []).every((p: any) => p?.organic !== true), "info-3: products[].organic never true");
    assertEq(info?.knowledge?.products?.[0]?.name, "Gulrøtter", "info-4: product names untouched");
    assertEq(info?.agent?.debioVerified, false, "info-5: debioVerified false");
    noClaim("info-6: no organic word in certifications/specialties", json([info?.knowledge?.certifications, info?.knowledge?.specialties]));

    // ── owner's own /info read sees the stored lists ──────────────────────
    const ownerInfo = (await restInfo(UNVERIFIED_ID, OWNER_CLAIM)).body?.data;
    assertEq(ownerInfo?.knowledge?.certifications, ["Økologisk", "Debio-sertifisert", "Nyt Norge", "Kortreist/økologisk"], "owner-1: owner read keeps stored certifications (no save-back loss)");
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
    assertEq(listed?.categories, ["vegetables"], "s0b-agents-1: /agents categories without «organic»");
    assertTrue((listed?.tags ?? []).includes("local") && !(listed?.tags ?? []).some((t: string) => t.toLowerCase().includes("organic")), "agents-1b: «local/organic» → «local», no substring left for discover's tag match", listed?.tags);
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

    // B2: the producer's affiliations on the AI surfaces (MCP tool).
    const affText = await toolText("lokal_get_producer_affiliations", { producerId: UNVERIFIED_ID });
    assertTrue(affText.includes("Bondens marked Oslo"), "aff-mcp-0: lokal_get_producer_affiliations lists the market umbrella", affText);
    noClaim("aff-mcp-1: lokal_get_producer_affiliations shows no certification/organic umbrella without status", affText);
    assertTrue((await toolText("lokal_get_producer_affiliations", { producerId: VERIFIED_ID })).includes("Demeter Norge"), "aff-mcp-2: verified producer keeps its certification umbrella");

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
    assertTrue(affChips(vHtml).includes("Demeter Norge"), "verified-6: certification-umbrella chip kept with Debio status");
    assertTrue(!affChips(vHtml).includes("antatt — ikke bekreftet") && !/>Debio</.test(affChips(vHtml)), "verified-7: inactive Debio umbrella chip gone for verified too (is_active filter)");

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

    // ── S0b: categories + «Hva folk søker etter» ──────────────────────────
    const ANSWER_RE = /<p class="pf-answer">([\s\S]*?)<\/p>/;
    const chipsC = (html: string) => (html.match(/<span class="badge badge-c">[^<]*<\/span>/g) ?? []);
    const additionalTypes = (html: string) => [...jsonLd(html).matchAll(/"additionalType":\s*"([^"]*)"/g)].map((m) => m[1]);
    const termsBlock = (html: string) => (html.match(/<div class="act-terms">[\s\S]*?<\/div>/) ?? [""])[0];
    for (const lang of ["no", "en", "sv"]) {
      const html = await page(UNVERIFIED_ID, lang);
      const chips = chipsC(html);
      assertTrue(chips.length === 1 && !chips.some((c) => /organic|økolog|ekolog/i.test(c)), `s0b-chip-${lang}-1: one category chip, not «organic»`, chips);
      assertTrue(additionalTypes(html).every((t) => t.trim() !== "" && !containsOrganicClaim(t) && plainHits(t).length === 0), `s0b-ld-${lang}-1: JSON-LD additionalType without organic word`, additionalTypes(html));
      const answer = (html.match(ANSWER_RE) ?? [])[1] ?? "";
      assertTrue(answer.length > 0, `s0b-answer-${lang}-0: answer-first opening rendered`);
      noClaim(`s0b-answer-${lang}-1: answer-first opening carries no organic word`, answer);
      assertTrue(!/,\s*(—|&mdash;|\.)|,\s*$|(tilbyr|offers)\s+(—|&mdash;)/.test(answer), `s0b-answer-${lang}-2: opening grammatical (no «, —», no trailing comma, no empty list)`, answer);
      const terms = termsBlock(html);
      assertTrue(terms.includes("gulrøtter oslo"), `s0b-terms-${lang}-1: a non-organic search term stays in the panel`, terms);
      noClaim(`s0b-terms-${lang}-2: «Hva folk søker etter» shows no organic term`, terms);
    }
    assertEq(((await page(UNVERIFIED_ID)).match(ANSWER_RE) ?? [])[1], "Kvernstua Gard Prove i Oslo tilbyr Grønnsaker — finn kontaktinfo under.", "s0b-answer-no-3: «tilbyr Grønnsaker — finn kontaktinfo under.»");
    assertEq(((await page(UNVERIFIED_ID, "en")).match(ANSWER_RE) ?? [])[1], "Kvernstua Gard Prove in Oslo offers Vegetables — find contact details below.", "s0b-answer-en-3: «offers Vegetables — find contact details below.»");

    // «organic» as the ONLY category: normal template, no chip, no additionalType.
    for (const lang of ["no", "en", "sv"]) {
      const html = await page(ONLY_ORGANIC_CAT_ID, lang);
      const twin = await page(CLEAN_ID, lang);
      assertTrue(html.includes(NAMES[ONLY_ORGANIC_CAT_ID]), `s0b-only-${lang}-0: the profile page renders`);
      assertEq(chipsC(html), [], `s0b-only-${lang}-1: no category chip (and no empty one)`);
      assertEq(additionalTypes(html), [], `s0b-only-${lang}-2: no JSON-LD additionalType (and no empty one)`);
      assertTrue(!ANSWER_RE.test(html), `s0b-only-${lang}-3: no answer-first opening without a category list (normal template)`, (html.match(ANSWER_RE) ?? [])[1]);
      assertEq(plainHits(html).length, plainHits(twin).length, `s0b-only-${lang}-4: plain-regex hits equal the clean twin's`);
      assertEq(organicHits(html).length, organicHits(twin).length, `s0b-only-${lang}-5: organic-word hits equal the clean twin's`);
      // Every visitor term was organic → the panel renders as with no data.
      assertTrue(!html.includes('class="act-terms"') && !html.includes(lang === "en" ? "What people search for" : "Hva folk søker etter"), `s0b-only-${lang}-6: no search-term block when every term was organic`);
      assertEq(html.includes('class="act-sub"'), twin.includes('class="act-sub"'), `s0b-only-${lang}-7: activity panel as the no-data twin's`);
    }

    // Verified fixture keeps its organic category and organic search term.
    const vHtmlNo = await page(VERIFIED_ID);
    assertTrue(chipsC(vHtmlNo).some((c) => /organic/i.test(c)), "s0b-verified-1: verified producer keeps its «organic» category chip", chipsC(vHtmlNo));
    assertTrue(additionalTypes(vHtmlNo).some((t) => /organic/i.test(t)), "s0b-verified-2: verified JSON-LD additionalType keeps «organic»", additionalTypes(vHtmlNo));
    assertTrue(termsBlock(vHtmlNo).includes("økologisk kjøtt"), "s0b-verified-3: verified producer's panel keeps «økologisk kjøtt»", termsBlock(vHtmlNo));
    assertEq(((await agentsList()).find((a: any) => a.id === VERIFIED_ID))?.categories, ["vegetables", "organic"], "s0b-verified-4: /agents keeps the verified producer's categories");

    // /card, /find-match, MCP, A2A.
    const cUnv = await card(UNVERIFIED_ID);
    noClaim("s0b-card-1: card carries no organic category", json(cUnv));
    const cOnly = await card(ONLY_ORGANIC_CAT_ID);
    noClaim("s0b-card-2: card of the «organic»-only producer carries no organic word", json(cOnly));
    const findMatch = findRouteHandler(marketplaceRouter, "/find-match", "get");
    const fm = ((await invoke(findMatch, makeReq({ query: { name: "Gard Prove" } }))).body?.matches ?? []) as any[];
    assertEq(fm.find((m: any) => m.id === UNVERIFIED_ID)?.categories, ["vegetables"], "s0b-findmatch-1: /find-match categories without «organic»");
    assertEq(fm.find((m: any) => m.id === ONLY_ORGANIC_CAT_ID)?.categories, [], "s0b-findmatch-2: «organic»-only → no categories");
    assertEq(fm.find((m: any) => m.id === VERIFIED_ID)?.categories, ["vegetables", "organic"], "s0b-findmatch-3: verified keeps «organic»");
    for (const id of [UNVERIFIED_ID, ONLY_ORGANIC_CAT_ID]) {
      const liS0b = await lokalInfo(id);
      assertTrue(liS0b.includes(NAMES[id]), `s0b-mcp-info-0 ${id}: lokal_info answers`);
      noClaim(`s0b-mcp-info-1 ${id}: lokal_info («Kategorier») carries no organic word`, liS0b);
      const lsS0b = await toolText("lokal_search", { query: NAMES[id] });
      noClaim(`s0b-mcp-search-1 ${id}: lokal_search carries no organic word`, listBlock(lsS0b, id));
      const a2aS0b = json(await a2aInfo(id));
      assertTrue(a2aS0b.includes(NAMES[id]), `s0b-a2a-0 ${id}: A2A agent/info answers`);
      noClaim(`s0b-a2a-1 ${id}: A2A agent/info carries no organic word`, a2aS0b);
    }
    const ldAll = await toolText("lokal_discover", { categories: ["vegetables"] });
    noClaim("s0b-mcp-discover-1: lokal_discover block carries no organic category", listBlock(ldAll, UNVERIFIED_ID));
    const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
    assertEq(conversationService.getAgentMetrics(UNVERIFIED_ID)?.categories, ["vegetables"], "s0b-a2a-metrics-1: A2A metrics categories without «organic»");
    assertEq(conversationService.getAgentMetrics(VERIFIED_ID)?.categories, ["vegetables", "organic"], "s0b-a2a-metrics-2: verified keeps «organic»");
    const board = conversationService.getLeaderboard(50);
    assertEq(board.find((r: any) => r.agentId === ONLY_ORGANIC_CAT_ID)?.categories, [], "s0b-a2a-leaderboard-1: leaderboard «organic»-only → no categories");

    // /reise + GET /api/marketplace/reise: stops come from loadRfbCandidates
    // (own SQL on agents.categories, not rowToAgent).
    const { loadRfbCandidates } = require("../services/route-corridor-service") as typeof import("../services/route-corridor-service");
    const reise = loadRfbCandidates({ minLat: 59, maxLat: 61, minLng: 10, maxLng: 11.5 }, db);
    const reiseCats = (id: string) => reise.find((c) => c.id === id)?.categories;
    assertEq(reiseCats(UNVERIFIED_ID), ["vegetables"], "s0b-reise-1: /reise stop categories without «organic»");
    assertEq(reiseCats(ONLY_ORGANIC_CAT_ID), [], "s0b-reise-2: «organic»-only → no categories on /reise");
    assertEq(reiseCats(VERIFIED_ID), ["vegetables", "organic"], "s0b-reise-3: verified keeps «organic» on /reise");
    assertTrue(reise.filter((c) => c.id === UNVERIFIED_ID || c.id === VERIFIED_ID).every((c) => c.isDrink === false), "s0b-reise-4: isDrink unaffected");

    // Category filter + ranking: «organic» only finds the verified producer.
    const { getRelatedBySameCategory } = require("./seo") as typeof import("./seo");
    const relOrganic = getRelatedBySameCategory(db, CLEAN_ID, "organic", null, 10).map((r) => r.id).sort();
    assertEq(relOrganic, [VERIFIED_ID], "s0b-related-1: «Andre organic-produsenter» links only the verified producer");
    assertTrue(getRelatedBySameCategory(db, CLEAN_ID, "vegetables", null, 10).some((r) => r.id === UNVERIFIED_ID), "s0b-related-2: a non-organic category still links the unverified producer");
    const byOrganicCat = await discover({ categories: ["organic"] });
    assertEq(byOrganicCat.map((r: any) => r.agent?.id).sort(), [VERIFIED_ID], "s0b-search-1: categories:[organic] filters to the verified producer only");
    const mcpOrganicCat = await toolText("lokal_discover", { categories: ["organic"] });
    assertTrue(!mcpOrganicCat.includes(NAMES[UNVERIFIED_ID]) && !mcpOrganicCat.includes(NAMES[ONLY_ORGANIC_CAT_ID]), "s0b-search-2: lokal_discover categories:[organic] lists no unverified producer", mcpOrganicCat.slice(0, 400));
    const rankedVeg = await discover({ categories: ["vegetables", "organic"] });
    const vegScore = (id: string) => rankedVeg.find((r: any) => r.agent?.id === id)?.relevanceScore;
    assertTrue(vegScore(UNVERIFIED_ID) === vegScore(CLEAN_ID), "s0b-search-3: «organic» category gives the unverified producer no ranking edge over its clean twin", [vegScore(UNVERIFIED_ID), vegScore(CLEAN_ID)]);

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
