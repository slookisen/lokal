/**
 * experiences-visning-s2.test.ts — slice S2 of dev-request
 * 2026-10-06-opplevagent-visning-mcp-og-tilbydersider (reviewer follow-ups).
 *
 *   1  MCP provider.phone is washed through isDisplayablePhone (null otherwise)
 *   2  /sitemap.xml lists /en only while OPPLEVAGENT_LANG_SWITCHER_ENABLED is on
 *   3  gårdssalg meta description (page with real about_text) never promises
 *      tasting/tour/booking, in NO and EN
 *   4  MCP booking_url is only returned when http(s); else null + booking_info_only
 *
 * Run standalone: npx tsx src/routes/experiences-visning-s2.test.ts
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, url: string, lang = "no"): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = { method: "GET", url, originalUrl: url, path: url.split("?")[0], query: {}, headers: {}, lang, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { statusCode = c; return this; },
      setHeader() {},
      redirect(c: number, loc: string) { resolve({ status: c, body: loc }); },
      send(b: unknown) { resolve({ status: statusCode, body: String(b) }); },
    };
    router.handle(req, res, (err?: any) => resolve({ status: statusCode, body: err ? String(err) : "" }));
  });
}

export function runExperiencesVisningS2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      // 7 gårdssalg producers (visibility threshold); one has a real about_text.
      const insGs = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, about_text, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', 0, NULL, 60.63, 6.42,
            'high', @slug, @about, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insGs.run({ id: "s2-about", navn: "Omtale Bryggeri", slug: "omtale-bryggeri",
        about: "Omtale Bryggeri brygger øl på gården i Voss og har holdt på siden 1998 med lokale råvarer fra dalen rundt." });
      for (let i = 1; i <= 6; i++) insGs.run({ id: `s2-f${i}`, navn: `Fyllgård ${i}`, slug: `s2-fyll-${i}`, about: null });

      const insProv = db.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, telefon, slug, brreg_active, brreg_verified, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', @tel, @slug, 1, 1, 'verified', 'test-fixture', 'high')`,
      );
      insProv.run({ id: "s2-good", navn: "God Tlf AS", tel: "+47 911 22 333", slug: "god-tlf" });
      insProv.run({ id: "s2-bad", navn: "Dårlig Tlf AS", tel: "+47 19 09 49", slug: "darlig-tlf" });
      insProv.run({ id: "s2-junk", navn: "Tekst Tlf AS", tel: "ring oss i dag", slug: "tekst-tlf" });
      const insExp = db.prepare(
        `INSERT INTO experiences (id, provider_id, slug, title, title_no, description, category, kommune, fylke,
           indoor_outdoor, verification_status, booking_url)
         VALUES (@id, @pid, @slug, @title, @title, 'En ekte opplevelse med lokal guide for små grupper og familier.',
           'mat_drikke', 'Voss', 'Vestland', 'outdoor', 'verified', @bk)`,
      );
      const { randomUUID } = require("crypto") as typeof import("crypto");
      const U: Record<string, string> = {};
      const exps: Array<[string, string, string | null]> = [
        ["s2-e-good", "s2-good", "https://book.example.no/x"],
        ["s2-e-bad", "s2-bad", "javascript:alert(1)"],
        ["s2-e-junk", "s2-junk", "   "],
        ["s2-e-ftp", "s2-good", "ftp://x.example.no"],
        ["s2-e-nourl", "s2-good", "ikke en url"],
      ];
      for (const [name, pid, bk] of exps) { U[name] = randomUUID(); insExp.run({ id: U[name], pid, slug: name, title: `Opplevelse ${name}`, bk }); }

      const expMcp = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
      const mcpCall = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const server = new McpServer({ name: "s2-test", version: "0.0.0" });
        expMcp.registerExperienceTools(server);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "s2-test-client", version: "0.0.0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        try { return await client.callTool({ name, arguments: args }); }
        finally { await client.close(); await server.close(); }
      };

      // 1: phone wash
      const g = (await mcpCall("get_experience", { id: U["s2-e-good"] })).structuredContent;
      const b = (await mcpCall("get_experience", { id: U["s2-e-bad"] })).structuredContent;
      const j = (await mcpCall("get_experience", { id: U["s2-e-junk"] })).structuredContent;
      ok(g?.provider?.phone === "+47 911 22 333", `1a: displayable phone passes through (got ${JSON.stringify(g?.provider?.phone)})`);
      ok(b?.provider?.phone === null, `1b: 6-digit phone is null (got ${JSON.stringify(b?.provider?.phone)})`);
      ok(j?.provider?.phone === null, `1c: garbage phone text is null (got ${JSON.stringify(j?.provider?.phone)})`);
      const vis = expMcp.buildExperienceVisibilityFields({ provider_id: "s2-bad", slug: "s2-e-bad" });
      ok(vis.provider?.phone === null, "1d: buildExperienceVisibilityFields washes phone too");

      // 4: booking_url
      ok(g?.booking_url === "https://book.example.no/x" && g?.booking_info_only === false, "4a: https booking_url passes, not info-only");
      for (const [id, v] of [["s2-e-bad", b], ["s2-e-junk", j]] as const) {
        ok(v?.booking_url === null && v?.booking_info_only === true, `4b: ${id} invalid booking_url -> null + booking_info_only`);
      }
      for (const id of ["s2-e-ftp", "s2-e-nourl"]) {
        const v = (await mcpCall("get_experience", { id: U[id] })).structuredContent;
        ok(v?.booking_url === null && v?.booking_info_only === true, `4c: ${id} non-http(s) -> null + booking_info_only`);
      }
      const disc = (await mcpCall("discover_experiences", { kommune: "Voss" })).structuredContent;
      const rows: any[] = disc?.experiences ?? [];
      ok(rows.length > 0 && rows.every((r) => r.booking_url === null || /^https?:\/\//.test(r.booking_url)),
        "4d: discover_experiences never returns a non-http(s) booking_url");
      ok(rows.every((r) => r.booking_url !== null || r.booking_info_only === true), "4e: discover rows with null booking_url are booking_info_only");

      // 2: sitemap /en follows the flag
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const seoRouter = seo.default as any;
      seo.__resetExperiencesSitemapCacheForTesting();
      const off = await callRoute(seoRouter, "/sitemap.xml");
      ok(off.status === 200 && off.body.includes("<loc>https://opplevagent.no/opplevelser</loc>"), "2a: sitemap renders (flag off)");
      ok(!/<loc>[^<]*\/en(\/[^<]*)?<\/loc>/.test(off.body), "2b: no /en URL in sitemap while EN flag is off");
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      seo.__resetExperiencesSitemapCacheForTesting();
      const on = await callRoute(seoRouter, "/sitemap.xml");
      ok(/<loc>[^<]*\/en<\/loc>/.test(on.body), "2c: /en is in the sitemap when the EN flag is on");
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
      seo.__resetExperiencesSitemapCacheForTesting();

      // 3: gsMeta neutral, NO + EN
      const metaOf = (html: string) => /<meta name="description" content="([^"]*)"/.exec(html)?.[1] || "";
      const claims = /smak|omvisning|provsmakning|visning|tasting|tour|book|bestill|besøk|besök|visit/i;
      const no = await callRoute(seoRouter, "/kategori/gardssalg/produsent/omtale-bryggeri");
      const noMeta = metaOf(no.body);
      ok(no.status === 200 && noMeta.includes("Omtale Bryggeri"), `3a: page with about_text renders meta (status ${no.status})`);
      ok(!claims.test(noMeta), `3b: NO meta does not promise tasting/tour/booking/visit (got "${noMeta}")`);
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      const en = await callRoute(seoRouter, "/kategori/gardssalg/produsent/omtale-bryggeri", "en");
      const enMeta = metaOf(en.body);
      ok(en.status === 200 && enMeta.includes("Omtale Bryggeri"), `3c: EN page renders meta (status ${en.status})`);
      ok(!claims.test(enMeta), `3d: EN meta does not promise tasting/tour/booking/visit (got "${enMeta}")`);
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesVisningS2Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
