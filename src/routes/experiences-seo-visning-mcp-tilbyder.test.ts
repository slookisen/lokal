/**
 * experiences-seo-visning-mcp-tilbyder.test.ts — tests for dev-request
 * 2026-10-06-opplevagent-visning-mcp-og-tilbydersider.
 *
 * Covers:
 *   AC1 — gårdssalg pages carry no InStock Offer while booking is paused
 *         (and no ReserveAction either). A live-booking page signals the
 *         visit request as a ReserveAction, not as a price-less Offer
 *         (dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-
 *         og-places-treffvakt, S5).
 *   AC2 — get_experience returns provider{name,org_nr,website,phone},
 *         profile_url and source_url (null, never "", when unknown) for 10/10.
 *   AC3 — discover_experiences with group_size/age/language returns
 *         unfilterable_fields when no published row carries those fields.
 *   AC4 — /tilbyder/ pages carry Organization JSON-LD with non-empty name+url
 *         and zero empty-string values; the contact block shows only fields
 *         that have a value.
 *   AC5 — no hreflang="en" and no EN lang-toggle while
 *         OPPLEVAGENT_LANG_SWITCHER_ENABLED is off.
 *   AC6 — gårdssalg pages without visit_text never say "inkluderer typisk" or
 *         "Book et besøk"; the replacement does not promise visits/tastings.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-visning-mcp-tilbyder.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() {},
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

function ldBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].replace(/<\\\//g, "</"))); } catch { /* ignore */ }
  }
  return out;
}

function hasEmptyString(v: unknown): boolean {
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.some(hasEmptyString);
  if (v && typeof v === "object") return Object.values(v as object).some(hasEmptyString);
  return false;
}

export function runExperiencesSeoVisningMcpTilbyderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
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
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      // ── gårdssalg fixtures (7 ≥ visibility threshold) ──
      const insGs = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', @pt, @bl, NULL, 60.63, 6.42,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insGs.run({ id: "vm-paused", navn: "Pauset Bryggeri", pt: "bryggeri", bl: 0, slug: "pauset-bryggeri" });
      insGs.run({ id: "vm-live", navn: "Aktivt Bryggeri", pt: "bryggeri", bl: 1, slug: "aktivt-bryggeri" });
      for (let i = 1; i <= 5; i++) insGs.run({ id: `vm-f${i}`, navn: `Fyllgård ${i}`, pt: "bryggeri", bl: 0, slug: `fyll-${i}` });

      // ── tilbyder fixtures: providers with published experiences ──
      const insProv = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, adresse, postnummer, poststed, fylke, kommune, telefon, hjemmeside, slug,
            brreg_active, brreg_verified, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @adresse, @postnummer, @poststed, 'Vestland', 'Voss', @telefon, @hjemmeside, @slug,
            1, 1, 'verified', 'test-fixture', 'high')`,
      );
      const insExp = db.prepare(
        `INSERT INTO experiences (id, provider_id, slug, title, title_no, description, category, kommune, fylke,
           indoor_outdoor, verification_status, evidence_url, booking_url)
         VALUES (@id, @pid, @slug, @title, @title, 'En ekte opplevelse med lokal guide for små grupper og familier.',
           'mat_drikke', 'Voss', 'Vestland', 'outdoor', 'verified', @ev, @bk)`,
      );
      const { randomUUID } = require("crypto") as typeof import("crypto");
      const expIds: string[] = [];
      // Full-contact provider, empty-contact provider, spaces-only provider.
      insProv.run({ id: "tp-full", navn: "Full Tilbyder AS", org_nr: "123456789", adresse: "Storgata 1", postnummer: "5700", poststed: "Voss", telefon: "+47 91234567", hjemmeside: "https://full.example.no", slug: "full-tilbyder" });
      insProv.run({ id: "tp-empty", navn: "Tom Tilbyder", org_nr: null, adresse: null, postnummer: null, poststed: null, telefon: null, hjemmeside: null, slug: "tom-tilbyder" });
      insProv.run({ id: "tp-blank", navn: "Blank Tilbyder", org_nr: "  ", adresse: "  ", postnummer: "", poststed: "", telefon: "  ", hjemmeside: "  ", slug: "blank-tilbyder" });
      for (let i = 0; i < 10; i++) {
        const id = randomUUID();
        expIds.push(id);
        const pid = i % 3 === 0 ? "tp-full" : i % 3 === 1 ? "tp-empty" : "tp-blank";
        insExp.run({ id, pid, slug: `vm-exp-${i}`, title: `Opplevelse ${i}`, ev: i % 2 ? "https://kilde.example.no/a" : null, bk: i === 0 ? "javascript:alert(1)" : i === 1 ? "https://book.example.no" : null });
      }

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      {
        db.prepare("UPDATE experiences SET price_from = 990, price_unit = 'per_adult' WHERE id = ?").run(expIds[0]);
        const adult = await callHtmlRoute(seoRouter, "/opplevelse/vm-exp-0");
        assertTrue(adult.status === 200 && adult.body.includes("990 kr per voksen"), "adult-seo: detail shows adult basis");
        assertTrue(!adult.body.includes("fra 990 kr"), "adult-seo: adult price is not claimed as cheapest age price");
        // Offer.name in the page language (lokal#1097 review S4, landed with E2-S3).
        assertTrue(ldBlocks(adult.body).some((b) => b.offers?.price === 990 && b.offers?.name === "Voksenpris"), "adult-seo: structured offer labels adult basis");
        const listing = await callHtmlRoute(seoRouter, "/kategori/mat_drikke");
        assertTrue(listing.status === 200 && listing.body.includes("Voksenpris 990 kr"), "adult-seo: list card labels adult price");
        db.prepare("UPDATE experiences SET price_unit = 'unknown' WHERE id = ?").run(expIds[0]);
        const unknown = await callHtmlRoute(seoRouter, "/opplevelse/vm-exp-0");
        assertTrue(unknown.body.includes("fra 990 kr") && !unknown.body.includes("per voksen"), "adult-seo: unknown basis keeps fallback");
      }

      // ── AC1 + AC6: gårdssalg pages ──
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pauset-bryggeri");
        assertTrue(r.handled && r.status === 200, `ac1-0: paused page renders (status ${r.status})`);
        assertTrue(!r.body.includes("InStock"), "ac1-1: paused gårdssalg page has no InStock");
        assertTrue(!ldBlocks(r.body).some((b) => b.offers), "ac1-2: paused gårdssalg page has no offers node");
        assertTrue(!ldBlocks(r.body).some((b) => b.potentialAction) && !r.body.includes("ReserveAction"),
          "ac1-2b: paused gårdssalg page has no potentialAction (ReserveAction) either");
        assertTrue(!r.body.includes("inkluderer typisk"), "ac6-1: no 'inkluderer typisk' without visit_text");
        assertTrue(!r.body.includes("Book et besøk"), "ac6-2: no 'Book et besøk' without visit_text");
        assertTrue(r.body.includes("Spør Pauset Bryggeri direkte om det går an å komme på besøk."), "ac6-3: neutral visit text");
        assertTrue(!/smaking eller omvisning direkte hos produsenten/.test(r.body), "ac6-4: meta no longer promises booking a tasting");
        const metaA = /<meta name="description" content="([^"]*)"/.exec(r.body)?.[1] || "";
        const r2 = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/fyll-1");
        const metaB = /<meta name="description" content="([^"]*)"/.exec(r2.body)?.[1] || "";
        assertTrue(metaA.includes("Pauset Bryggeri") && metaA !== metaB, "ac6-5: meta description is unique per producer");
      }
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/aktivt-bryggeri");
        assertTrue(r.handled && r.status === 200, `ac1-3: live page renders (status ${r.status})`);
        // S5 rewrote ac1-4 («live-booking page keeps its Offer»): the visit has
        // no price, so the live page carries a ReserveAction to /book instead.
        const biz = ldBlocks(r.body).find((b) => b["@type"] === "LocalBusiness");
        assertTrue(biz?.potentialAction?.["@type"] === "ReserveAction"
          && biz.potentialAction.target?.["@type"] === "EntryPoint"
          && biz.potentialAction.target.urlTemplate === "https://opplevagent.no/kategori/gardssalg/book/aktivt-bryggeri",
          `ac1-4: live-booking page signals a ReserveAction to /book (got ${JSON.stringify(biz?.potentialAction)})`);
        assertTrue(!ldBlocks(r.body).some((b) => b.offers) && !r.body.includes("InStock"), "ac1-5: … and no Offer / InStock");
      }

      // ── AC5: no EN signals while the flag is off ──
      for (const path of ["/", "/guide-opplevelser-mcp", "/kategori/gardssalg/produsent/pauset-bryggeri", "/opplevelse/vm-exp-1"]) {
        const r = await callHtmlRoute(seoRouter, path);
        assertTrue(r.handled && r.status === 200, `ac5-0: ${path} renders (status ${r.status})`);
        assertTrue(!r.body.includes('hreflang="en"'), `ac5-1: ${path} has no hreflang=en (flag off)`);
        assertTrue(!r.body.includes('class="lang-toggle"'), `ac5-2: ${path} has no language toggle (flag off)`);
      }
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      {
        const r = await callHtmlRoute(seoRouter, "/");
        assertTrue(r.body.includes('hreflang="en"') && r.body.includes('class="lang-toggle"'), "ac5-3: flag on restores hreflang + toggle on the landing page");
      }
      delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;

      // ── AC4: /tilbyder/ Organization JSON-LD + contact block ──
      for (const slug of ["full-tilbyder", "tom-tilbyder", "blank-tilbyder"]) {
        const r = await callHtmlRoute(seoRouter, `/tilbyder/${slug}`);
        assertTrue(r.handled && r.status === 200, `ac4-0: /tilbyder/${slug} renders (status ${r.status})`);
        const org = ldBlocks(r.body).find((b) => b["@type"] === "Organization");
        assertTrue(!!org, `ac4-1: ${slug} has Organization JSON-LD`);
        assertTrue(!!org && typeof org.name === "string" && org.name.trim() !== "" && typeof org.url === "string" && org.url.includes(`/tilbyder/${slug}`), `ac4-2: ${slug} has non-empty name + url`);
        assertTrue(!!org && !hasEmptyString(org), `ac4-3: ${slug} Organization has zero empty strings`);
        if (slug === "full-tilbyder") {
          assertTrue(org?.telephone === "+47 91234567" && org?.sameAs?.[0] === "https://full.example.no" && org?.address?.streetAddress === "Storgata 1", "ac4-4: full provider exposes phone, website, address");
          assertTrue(r.body.includes('class="prov-contact"') && r.body.includes("Storgata 1"), "ac4-5: contact block shows the fields");
        } else {
          assertTrue(org && !("telephone" in org) && !("sameAs" in org) && !("identifier" in org) && !org.address?.streetAddress, `ac4-6: ${slug} Organization has only fields with values`);
          assertTrue(!r.body.includes('class="prov-contact"'), `ac4-7: ${slug} has no (empty) contact block`);
        }
      }

      // ── MCP scaffold ──
      const expMcp = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
      const mcpCall = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const server = new McpServer({ name: "vm-test", version: "0.0.0" });
        expMcp.registerExperienceTools(server);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "vm-test-client", version: "0.0.0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        try { return await client.callTool({ name, arguments: args }); }
        finally { await client.close(); await server.close(); }
      };

      // ── AC2: get_experience provider + profile_url for 10/10 ──
      let okCount = 0;
      let nullClean = true;
      for (let i = 0; i < expIds.length; i++) {
        const res = await mcpCall("get_experience", { id: expIds[i] });
        const sc = res.structuredContent;
        if (sc && sc.provider && sc.provider.name && typeof sc.profile_url === "string" && sc.profile_url.endsWith(`/opplevelse/vm-exp-${i}`)) okCount++;
        if (sc && sc.provider) {
          for (const k of ["name", "org_nr", "website", "phone"]) if (!(k in sc.provider) || sc.provider[k] === "") nullClean = false;
        }
        if (sc && (sc.source_url === "" || !("source_url" in sc))) nullClean = false;
        if (i === 0) assertTrue(sc.booking_info_only === true && sc.booking_url === "javascript:alert(1)", "ac2-3: a non-http booking_url is flagged booking_info_only");
        if (i === 1) assertTrue(sc.booking_info_only === false, "ac2-4: an http(s) booking_url is not info-only");
        if (i === 1) assertTrue(sc.source_url === "https://kilde.example.no/a", "ac2-5: source_url passes through");
        if (i === 2) assertTrue(sc.source_url === null && sc.provider.website === null && sc.provider.phone === null, "ac2-6: unknown fields are null, not empty strings");
      }
      assertTrue(okCount === 10, `ac2-1: provider + profile_url for 10/10 ids (got ${okCount})`);
      assertTrue(nullClean, "ac2-2: provider keys always present; no empty strings");

      // ── AC3: unfilterable_fields ──
      {
        const res = await mcpCall("discover_experiences", { group_size: 40, age: 3, language: "fr" });
        const sc = res.structuredContent;
        const u: string[] = sc?.unfilterable_fields ?? [];
        assertTrue(u.includes("group_size") && u.includes("age") && u.includes("language"), `ac3-1: unfilterable_fields lists all three (got ${JSON.stringify(u)})`);
        const row = sc?.experiences?.[0];
        assertTrue(!!row && "provider" in row && "profile_url" in row && "source_url" in row, "ac2-7: discover rows carry provider/profile_url/source_url too");
        const res2 = await mcpCall("discover_experiences", { kommune: "Voss" });
        assertTrue(res2.structuredContent?.unfilterable_fields === undefined, "ac3-2: no unfilterable_fields when no such filter is used");
      }
      db.prepare("UPDATE experiences SET group_min = 1, group_max = 50, min_age = 0, languages = '[\"no\",\"en\"]' WHERE id = ?").run(expIds[0]);
      {
        const res = await mcpCall("discover_experiences", { group_size: 4, age: 8, language: "en" });
        assertTrue(res.structuredContent?.unfilterable_fields === undefined, "ac3-3: no unfilterable_fields once the catalog carries the data");
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED; else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoVisningMcpTilbyderTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
