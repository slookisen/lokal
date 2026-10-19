/**
 * dental-openapi-truth.test.ts — dev-request 2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S7).
 *
 * The dental OpenAPI spec may only document what the handlers do:
 *   T  every query parameter documented for /api/tannlege/agents and
 *      /api/tannlege/discover is read by that route's handler (source scan),
 *      and /agents and /agents/{id} document the answers they really give;
 *   D  GET /discover over an in-memory fixture: honest set (rejected, closed
 *      and non-clinic rows left out), `total`/`count`, `tolkning`, the helfo
 *      alias, the akutt filter and the card fields next to the old keys.
 *
 * Standalone: npx tsx src/routes/dental-openapi-truth.test.ts
 * Wired into tests/test.ts via runDentalOpenapiTruthTests().
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, p: string, query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: p, originalUrl: p, path: p, params: {}, query, headers: {}, ip: "127.0.0.1", get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      vary() { return this; },
      once() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: null }));
  });
}

export async function runDentalOpenapiTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevDisabled = process.env.DENTAL_QUERY_PARSER_DISABLED;
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    // ── T: documented query parameters are read ───────────────────────────
    const { getDentalOpenapi } = require("../services/dental-openapi") as typeof import("../services/dental-openapi");
    const spec = getDentalOpenapi() as any;
    const source = fs.readFileSync(path.join(__dirname, "dental.ts"), "utf8");
    const handlerSource = (route: string): string => {
      const start = source.indexOf(`router.get("${route}"`);
      const end = source.indexOf("\nrouter.", start + 1);
      return start >= 0 ? source.slice(start, end > start ? end : undefined) : "";
    };
    const pairs: Array<[specPath: string, route: string]> = [
      ["/api/tannlege/agents", "/agents"],
      ["/api/tannlege/discover", "/discover"],
    ];
    for (const [specPath, route] of pairs) {
      const body = handlerSource(route);
      ok(body.length > 0, `T0: found the ${route} handler`);
      const params = ((spec.paths[specPath]?.get?.parameters ?? []) as any[]).filter((p) => p.in === "query");
      ok(params.length > 0, `T0: ${specPath} documents query parameters`);
      for (const p of params) {
        ok(new RegExp(`req\\.query\\.${p.name}\\b`).test(body), `T1: ${specPath} documents «${p.name}» and ${route} reads req.query.${p.name}`);
      }
    }
    const agentsOk = spec.paths["/api/tannlege/agents"].get.responses["200"].content["application/json"].schema;
    ok(agentsOk.type === "object" && !!agentsOk.properties.count && !!agentsOk.properties.agents, "T2: /agents is documented as {count, agents}");
    const oneOk = spec.paths["/api/tannlege/agents/{id}"].get.responses["200"].content["application/json"].schema;
    ok(oneOk.type === "object" && !!oneOk.properties.agent, "T3: /agents/{id} is documented as {agent}");
    ok(spec.paths["/api/tannlege/discover"].get.operationId === "discoverDentalAgents", "T4: /discover keeps operationId discoverDentalAgents");
    ok(!JSON.stringify(spec).includes("/api/tannlege/stats"), "T5: the spec no longer points to /api/tannlege/stats");

    // ── D: /discover over a fixture ───────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const ins = db.prepare(
      "INSERT INTO dental_agents (id, navn, fylke, poststed, verification_status, helfo_agreement, acute_vakt, is_inactive) VALUES (?,?,?,?,?,?,?,?)"
    );
    ins.run("d-1", "Bergen Tannlegesenter", "Vestland", "Bergen", "unverified", "true", 0, 0);
    ins.run("d-2", "Bergen Tannhelse", "Vestland", "Bergen", "unverified", "false", 0, 0);
    ins.run("d-3", "Avvist Tannklinikk", "Vestland", "Bergen", "rejected", "true", 0, 0);
    ins.run("d-4", "Nedlagt Tannklinikk", "Vestland", "Bergen", "unverified", "true", 0, 1);
    ins.run("d-5", "Oslo Tannlege", "Oslo", "Oslo", "unverified", "true", 0, 0);

    const dentalRouter = (require("./dental") as typeof import("./dental")).default;
    const idsOf = (r: { body: any }): string[] => (r.body?.results ?? []).map((x: any) => x.id).sort();

    const plain = await callRoute(dentalRouter, "/discover", { fylke: "Vestland" });
    ok(plain.status === 200 && plain.body.vertical === "dental", "D1: 200 and vertical dental");
    ok(JSON.stringify(idsOf(plain)) === JSON.stringify(["d-1", "d-2"]), `D2: rejected and closed rows are left out (got ${JSON.stringify(idsOf(plain))})`);
    ok(plain.body.count === 2 && plain.body.total === 2, "D3: count is the page length, total the matching clinics");
    const first = plain.body.results[0];
    ok(["id", "navn", "org_nr", "fylke", "poststed", "chain_brand", "available_specialties", "verification_status"].every((k) => k in first || first[k] === undefined) &&
      "badges" in first && "profil_url" in first && "akutt" in first, "D4: old keys kept, card fields added");

    const paged = await callRoute(dentalRouter, "/discover", { fylke: "Vestland", limit: "1", offset: "1" });
    ok(paged.body.count === 1 && paged.body.total === 2, "D5: limit/offset page the list, total stays");

    const natural = await callRoute(dentalRouter, "/discover", { q: "tannlege i Bergen" });
    ok(natural.status === 200 && natural.body.total === 2 && !!natural.body.tolkning, "D6: q goes through the parser (total and tolkning)");

    const helfo = await callRoute(dentalRouter, "/discover", { fylke: "Vestland", helfo_agreement: "true" });
    const alias = await callRoute(dentalRouter, "/discover", { fylke: "Vestland", helfo: "true" });
    ok(JSON.stringify(idsOf(helfo)) === JSON.stringify(["d-1"]) && JSON.stringify(idsOf(alias)) === JSON.stringify(["d-1"]), "D7: helfo_agreement and its alias helfo filter");

    const bad = await callRoute(dentalRouter, "/discover", { akutt: "kanskje" });
    ok(bad.status === 400, "D8: an invalid akutt is a 400");
    const akutt = await callRoute(dentalRouter, "/discover", { fylke: "Vestland", akutt: "1" });
    ok(akutt.status === 200 && akutt.body.total === 0, "D9: akutt filters on the claim, not the bare flag (none in the fixture)");
    const poststed = await callRoute(dentalRouter, "/discover", { poststed: "Oslo" });
    ok(JSON.stringify(idsOf(poststed)) === JSON.stringify(["d-5"]), "D10: poststed filters");
  } catch (err: any) {
    ok(false, `unexpected error: ${err?.stack || err}`);
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevDisabled === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    else process.env.DENTAL_QUERY_PARSER_DISABLED = prevDisabled;
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
  runDentalOpenapiTruthTests({ log: true }).then((r) => {
    console.log(`\ndental openapi truth: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
