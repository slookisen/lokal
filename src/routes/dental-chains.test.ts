/**
 * dental-chains.test.ts — A2A dev-request 2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S6).
 *
 * MCP tannlege_kjeder and GET /api/tannlege/chains list the chains from the
 * clinics' chain_brand (the curated dental_chains table is empty in
 * production), against an in-memory fixture DB. By prefix:
 *   S   store listChains(): an empty dental_chains still gives the chains,
 *       the threshold of DENTAL_CHAIN_MIN_LOCATIONS public clinics, the honest
 *       public set only (no rejected, closed, non-clinic or probe row), names
 *       trimmed and case-folded with the most used spelling shown, blank names
 *       left out, a dental_chains row merged with its own fields, one key set
 *       for every entry, largest first, and the gap to getDentalStats'
 *       chain_count is exactly the chains under the threshold;
 *   N   no N+1: two statements whatever the number of chains, through the
 *       store and through the MCP tool; no row is written;
 *   M   MCP tannlege_kjeder over a real server + client;
 *   R   GET /api/tannlege/chains.
 *
 * Standalone: npx tsx src/routes/dental-chains.test.ts
 * Wired into tests/test.ts via runDentalChainsTests().
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query: {}, headers: {}, ip: "127.0.0.1", get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: String(err ?? "unhandled") }));
  });
}

const CHAIN_KEYS = ["id", "chain_brand", "parent_orgnr", "website", "num_locations_advertised", "tier", "confidence", "antall_lokasjoner_i_db"];

export async function runDentalChainsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const { DENTAL_SYNTHETIC_PROBE_IDS } = require("../services/dental-contamination") as typeof import("../services/dental-contamination");

    let n = 0;
    const add = (chain_brand: string | null, extra: Record<string, unknown> = {}): string => {
      n++;
      const id = store.createDentalAgent({ navn: `Kjedeklinikk ${n}`, poststed: "OSLO", fylke: "Oslo", ...(chain_brand !== null ? { chain_brand } : {}) } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", is_chain_member: chain_brand && chain_brand.trim() ? 1 : 0, ...extra };
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...cols, id });
      return id;
    };
    const chainOf = (name: string) => store.listChains().find((c) => c.chain_brand === name);

    // ── S: listChains from chain_brand ────────────────────────────────────
    eq(store.listChains(), [], "S0: no clinics and no dental_chains rows -> no chains");
    for (let i = 0; i < 3; i++) add("Kjede Nord");
    add("Kjede Sør"); add("Kjede Sør");
    add("Enkeltstående Kjede");
    eq((db.prepare("SELECT COUNT(*) AS n FROM dental_chains").get() as { n: number }).n, 0, "S1: (dental_chains is empty, as in production)");
    eq(store.listChains().map((c) => [c.chain_brand, c.antall_lokasjoner_i_db]), [["Kjede Nord", 3], ["Kjede Sør", 2]],
      "S2: the chains come from chain_brand, each with its number of clinics");
    eq(store.DENTAL_CHAIN_MIN_LOCATIONS, 2, "S3: the threshold is 2 public clinics ...");
    ok(!chainOf("Enkeltstående Kjede"), "S4: ... so a chain_brand on a single clinic is not listed");

    // Rows outside the honest public set do not count.
    const notPublic = [
      add("Kjede Skjult", { verification_status: "rejected" }),
      add("Kjede Skjult", { is_inactive: 1 }),
      add("Kjede Skjult", { catalog_class: "holding" }),
    ];
    add("Kjede Skjult");
    ok(!chainOf("Kjede Skjult"), "S5: rejected, closed and non-clinic rows are not counted (1 public clinic -> not listed)");
    {
      const probeId = [...DENTAL_SYNTHETIC_PROBE_IDS][0]!;
      db.prepare("INSERT INTO dental_agents (id, navn, chain_brand, catalog_class) VALUES (?, 'Probe', 'Kjede Skjult', 'klinikk')").run(probeId);
      ok(!chainOf("Kjede Skjult"), "S6: the synthetic probe row is not counted either");
      db.prepare("DELETE FROM dental_agents WHERE id = ?").run(probeId);
    }
    add("Kjede Skjult");
    eq(chainOf("Kjede Skjult")?.antall_lokasjoner_i_db, 2, "S7: two public clinics -> listed with 2 (the hidden rows still not counted)");
    eq(chainOf("Kjede Nord")?.antall_lokasjoner_i_db, store.countPublicDentalAgents({ chain_brand: "Kjede Nord" }),
      "S8: the count equals the old per-chain countPublicDentalAgents for a chain with one spelling");

    // Trim and case-fold, for display only.
    add("  TannlegeTeam "); add("TannlegeTeam"); add("TannlegeTeam"); add("Tannlegeteam");
    {
      const team = store.listChains().filter((c) => c.chain_brand.toLowerCase() === "tannlegeteam");
      eq(team.map((c) => [c.chain_brand, c.antall_lokasjoner_i_db]), [["TannlegeTeam", 4]],
        "S9: spellings that differ only in case or surrounding spaces are one chain, shown in the most used spelling");
    }
    add("Ørsta Tann"); add("ØRSTA TANN");
    eq(store.listChains().filter((c) => c.chain_brand.toLowerCase() === "ørsta tann").map((c) => [c.chain_brand, c.antall_lokasjoner_i_db]),
      [["ØRSTA TANN", 2]], "S10: case folding covers Æ/Ø/Å; a tie goes to the first spelling in code-point order");
    add(""); add("   "); add(""); add(null);
    ok(store.listChains().every((c) => c.chain_brand.trim().length > 0), "S11: a blank chain_brand is never a chain");

    // A curated dental_chains row is merged, not duplicated.
    db.prepare("INSERT INTO dental_chains (id, chain_brand, parent_orgnr, website, num_locations_advertised, tier, confidence) VALUES (?,?,?,?,?,?,?)")
      .run("chain-nord", "kjede nord", "912345678", "https://kjedenord.no", 12, "national", "high");
    db.prepare("INSERT INTO dental_chains (id, chain_brand, website) VALUES (?,?,?)").run("chain-tom", "Kjede Uten Klinikker", "https://tom.no");
    {
      const chains = store.listChains();
      const nord = chains.filter((c) => c.chain_brand.toLowerCase() === "kjede nord");
      eq(nord, [{ id: "chain-nord", chain_brand: "kjede nord", parent_orgnr: "912345678", website: "https://kjedenord.no", num_locations_advertised: 12, tier: "national", confidence: "high", antall_lokasjoner_i_db: 3 }],
        "S12: a dental_chains row keeps its own fields, gets the clinics' count, and is listed once");
      eq(chains.find((c) => c.id === "chain-tom")?.antall_lokasjoner_i_db, 0, "S13: a dental_chains row is listed even without clinics (as before)");
      ok(chains.every((c) => JSON.stringify(Object.keys(c)) === JSON.stringify(CHAIN_KEYS)), "S14: every entry has the same keys, the old ones plus antall_lokasjoner_i_db");
      ok(chains.filter((c) => c.id === null).every((c) => c.website === null && c.parent_orgnr === null), "S15: a chain read from chain_brand has website null");
      const counts = chains.map((c) => c.antall_lokasjoner_i_db);
      ok(counts.every((v, i) => i === 0 || counts[i - 1] >= v), "S16: largest first");
      const kjedeSor = chains.findIndex((c) => c.chain_brand === "Kjede Sør");
      const kjedeSkjult = chains.findIndex((c) => c.chain_brand === "Kjede Skjult");
      ok(kjedeSkjult >= 0 && kjedeSkjult < kjedeSor, "S17: equal counts are ordered by name");
    }
    db.prepare("DELETE FROM dental_chains").run();
    {
      // The gap to tannlege_stats.chain_count (is_chain_member = 1 on the same
      // public set): chain members without a chain_brand, and the clinics of
      // chains under the threshold.
      add(null, { is_chain_member: 1 });
      const chains = store.listChains();
      const listed = new Set(chains.map((c) => c.chain_brand.toLowerCase()));
      const members = store.listPublicDentalAgents({}, 500, 0).filter((a) => a.is_chain_member === 1);
      const noBrand = members.filter((a) => !a.chain_brand?.trim()).length;
      const underThreshold = members.filter((a) => a.chain_brand?.trim() && !listed.has(a.chain_brand.trim().toLowerCase())).length;
      const sum = chains.reduce((s, c) => s + c.antall_lokasjoner_i_db, 0);
      eq([noBrand, underThreshold], [1, 1], "S18: (the fixture has one member without a chain_brand and one chain under the threshold)");
      eq(sum + noBrand + underThreshold, store.getDentalStats().chain_count,
        "S19: sum of antall_lokasjoner_i_db + members without chain_brand + clinics of chains under the threshold == chain_count");
      void notPublic;
    }

    // ── N: no N+1, no writes ──────────────────────────────────────────────
    const countStatements = async (fn: () => unknown | Promise<unknown>) => {
      const realPrepare = db.prepare;
      let prepared = 0;
      (db as any).prepare = function (this: any, sql: string) { prepared++; return realPrepare.call(this, sql); };
      try { await fn(); } finally { (db as any).prepare = realPrepare; }
      return prepared;
    };
    const snapshot = () => JSON.stringify(db.prepare("SELECT id, chain_brand, is_chain_member FROM dental_agents ORDER BY id").all());
    const before = snapshot();
    const few = await countStatements(() => store.listChains());
    for (let c = 0; c < 30; c++) { add(`Masse Kjede ${c}`); add(`Masse Kjede ${c}`); }
    const many = await countStatements(() => store.listChains());
    eq([few, many, store.listChains().length > 30], [2, 2, true], "N1: listChains runs two statements with 7 chains and with 37");

    // ── M: MCP tannlege_kjeder ────────────────────────────────────────────
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-chains-test", version: "0.0.0" });
    mcp.registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-chains-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    {
      let text = "";
      const prepared = await countStatements(async () => {
        text = String(((await client.callTool({ name: "tannlege_kjeder", arguments: {} })) as any).content[0].text);
      });
      const res = JSON.parse(text);
      ok(res.count > 0 && res.count === res.kjeder.length, "M1: tannlege_kjeder gives count > 0, the number of chains listed");
      eq(res.kjeder, store.listChains(), "M2: ... the same chains as listChains, each with antall_lokasjoner_i_db");
      eq(prepared, 2, "M3: the tool runs listChains' two statements, no count query per chain");
      ok(!text.includes("\n"), "M4: compact JSON, as the other list tools");
    }
    eq(snapshot().length > before.length, true, "N2: (the fixture grew)");
    eq(JSON.parse(snapshot()).filter((r: any) => JSON.parse(before).some((b: any) => b.id === r.id)), JSON.parse(before),
      "N3: listChains and the tool write nothing: chain_brand keeps its stored spelling");

    // ── R: GET /api/tannlege/chains ───────────────────────────────────────
    {
      const route = (require("./dental") as typeof import("./dental")).default as any;
      const r = await callRoute(route, "/chains");
      eq([r.status, Object.keys(r.body)], [200, ["count", "chains"]], "R1: GET /api/tannlege/chains -> 200 {count, chains}");
      ok(r.body.count > 0 && r.body.count === r.body.chains.length, "R2: count > 0");
      eq(r.body.chains, store.listChains(), "R3: the same chains as MCP tannlege_kjeder");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental chains: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (closeMcp) await closeMcp().catch(() => {});
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
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
  runDentalChainsTests({ log: true }).then((r) => {
    console.log(`\ndental chains: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
