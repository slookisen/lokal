/**
 * produktimport-s2.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-
 * egen-nettside, skive 2: kilde og datoer som stemmer.
 *
 *   stamp  stampProductSources(): the owner path stamps owner_manual (+
 *          confirmedAt), keeps owner_import/owner_auto_sync; any other path
 *          cannot claim an owner source; a plain product is returned as is.
 *   PUT    PUT /agents/:id/knowledge with X-Claim-Token stores owner_manual;
 *          a non-owner upsertKnowledge cannot store an owner claim.
 *   AC7    two catalog syncs with no change → identical products.updated_at;
 *          a price or category change moves it; owner-written products get
 *          source ≠ 'enrichment'; source_url / fetched_at / owner_confirmed_at
 *          are stored; rows of other writers keep their provenance.
 *   order  an owner_import product alone is not orderable
 *          (not_confirmed_by_owner); a B1 producer_dashboard row keeps its
 *          availability and stays orderable-by-source after a sync.
 *   AC8    /produsent/:slug shows the date line + price caveat (NO and EN)
 *          for imported and owner-typed products; a profile without dated
 *          products, or without products, has no line; the footer shows the
 *          newer of the owner's and enrichment's date with the right label.
 *
 * Real schema in an in-memory DB, swapped in as the getDb() singleton for the
 * route/service parts (restored in finally). Exported
 * runProduktimportS2Tests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/produktimport-s2.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OLD = "2020-01-01 00:00:00";

export async function runProduktimportS2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const ks = require("./knowledge-service") as typeof import("./knowledge-service");
    const { runProductCatalogSync } = require("./product-catalog-sync") as typeof import("./product-catalog-sync");
    const cart = require("./cart-service") as typeof import("./cart-service");

    const addAgent = (id: string, name: string) => db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at)
      VALUES (?, ?, 'En beskrivelse', 'p', ?, 'https://example.no', 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.5, 1, 1, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(id, name, `${id}@example.no`, `key-${id}`);
    const storedProducts = (id: string): any[] =>
      JSON.parse((db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(id) as { products: string }).products);
    const productRow = (id: string, name: string): any =>
      db.prepare("SELECT * FROM products WHERE agent_id = ? AND name = ?").get(id, name);

    // ── stamp: stampProductSources ──────────────────────────────────────
    {
      const now = "2026-10-21T10:00:00.000Z";
      const plain = { name: "Egg", category: "eggs", seasonal: false, price: "kr 55" };
      const imported = { ...plain, name: "Lam", source: "owner_import" as const, sourceUrl: "https://hommelstad.no/lam", fetchedAt: "2026-10-20T08:00:00Z" };
      const owner = ks.stampProductSources([plain, imported, { ...plain, name: "Ost", source: "enrichment" as const, sourceUrl: "https://x.no", fetchedAt: "2026-01-01" }], true, now);
      assertEq(owner[0], { ...plain, source: "owner_manual", confirmedAt: now }, "stamp: owner path → owner_manual + confirmedAt");
      assertEq(owner[1], { ...imported, confirmedAt: now }, "stamp: owner path keeps owner_import with its URL and fetch date");
      assertEq([owner[2].source, owner[2].sourceUrl, owner[2].fetchedAt], ["owner_manual", undefined, undefined], "stamp: owner path turns any other source into owner_manual (no fetch URL/date)");
      const other = ks.stampProductSources([plain, { ...imported, confirmedAt: now }, { ...plain, confirmedAt: now }], false, now);
      assertTrue(other[0] === plain, "stamp: non-owner path returns a plain product as is (same object)");
      assertEq([other[1].source, other[1].confirmedAt, other[1].sourceUrl], ["enrichment", undefined, imported.sourceUrl], "stamp: non-owner path cannot claim owner_import or an owner confirmation");
      assertEq(other[2], plain, "stamp: non-owner path drops a lone confirmedAt");
    }

    // ── PUT /agents/:id/knowledge with X-Claim-Token → owner_manual ────
    {
      addAgent("s2-put", "Put Gard");
      db.prepare(`INSERT INTO agent_knowledge (agent_id, products, data_source) VALUES ('s2-put', '[]', 'auto')`).run();
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
         VALUES ('claim-s2', 's2-put', 'Eier', 's2-put@example.no', 'verified', 'claim-token-s2', ?)`,
      ).run(new Date(Date.now() + 86_400_000).toISOString());
      const router = (require("../routes/marketplace") as any).default;
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === "/agents/:id/knowledge" && l.route.methods?.put);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const result = await new Promise<{ status: number; body: any }>((resolve) => {
        let status = 200;
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { resolve({ status, body: b }); return res; },
          send(b: any) { resolve({ status, body: b }); return res; },
        };
        const headers: Record<string, string> = { "x-claim-token": "claim-token-s2" };
        handler({ params: { id: "s2-put" }, headers, body: { products: [{ name: "Poteter", category: "vegetables", price: "kr 20" }] },
          get: (n: string) => headers[n.toLowerCase()], ip: "127.0.0.1" }, res, () => undefined);
      });
      assertEq(result.status, 200, "PUT: claim-token write accepted");
      const p = storedProducts("s2-put")[0];
      assertEq(p?.source, "owner_manual", "PUT: claim-token write stamps source owner_manual");
      assertTrue(typeof p?.confirmedAt === "string" && Number.isFinite(Date.parse(p.confirmedAt)), "PUT: claim-token write stamps confirmedAt");

      // A non-owner write (enrichment / admin lane) cannot claim the owner.
      ks.knowledgeService.upsertKnowledge("s2-put", {
        products: [{ name: "Poteter", category: "vegetables", seasonal: false, price: "kr 20", source: "owner_import", confirmedAt: "2026-10-21T00:00:00Z" }],
        dataSource: "auto",
      });
      const q = storedProducts("s2-put")[0];
      assertEq([q?.source, q?.confirmedAt], ["enrichment", undefined], "upsertKnowledge (non-owner): owner_import/confirmedAt are not stored as an owner claim");
    }

    // ── AC7: catalog sync provenance + updated_at ───────────────────────
    const SYNC = "s2-sync";
    addAgent(SYNC, "Hommelstad Test");
    const knowledge = [
      { name: "Lammelaar", category: "meat", price: "kr 300", source: "owner_import", sourceUrl: "https://www.hommelstad.no/butikk", fetchedAt: "2026-10-21T09:00:00Z", confirmedAt: "2026-10-21T10:00:00Z" },
      { name: "Honning", category: "honey", price: "kr 120", source: "owner_manual", confirmedAt: "2026-10-20T10:00:00Z" },
      { name: "Egg", category: "eggs", price: "kr 55" },
      { name: "Bestilt ost", category: "dairy", price: "kr 90", source: "owner_auto_sync", sourceUrl: "https://hommelstad.no/ost", fetchedAt: "2026-10-19T00:00:00Z" },
      { name: "Eierlagt", category: "other", price: "kr 10", source: "owner_manual", confirmedAt: "2026-10-21T00:00:00Z" },
      { name: "Admin-ost", category: "dairy", price: "kr 70", source: "owner_manual", confirmedAt: "2026-10-21T00:00:00Z" },
      { name: "Bekreftet lam", category: "meat", price: "kr 250", source: "owner_import", sourceUrl: "https://hommelstad.no/lam", fetchedAt: "2026-10-21T09:00:00Z", confirmedAt: "2026-10-21T10:00:00Z" },
      { name: "Bad source", category: "meat", price: "kr 5", source: "scraped", confirmedAt: "2026-10-21T00:00:00Z" },
      { name: "Bekreftet honning", category: "sweets", price: "kr 99", source: "owner_import", sourceUrl: "https://hommelstad.no/honning", fetchedAt: "2026-10-21T09:00:00Z", confirmedAt: "2026-10-21T10:00:00Z" },
    ];
    const setKnowledge = (list: unknown[]) => db.prepare(
      `INSERT INTO agent_knowledge (agent_id, products, data_source) VALUES (?, ?, 'hybrid')
       ON CONFLICT(agent_id) DO UPDATE SET products = excluded.products`,
    ).run(SYNC, JSON.stringify(list));
    setKnowledge(knowledge);
    // Rows other writers made before the sync: B1 owner portal ('owner',
    // producer_dashboard in stock) and the admin producer list.
    const confirmedAt = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, currency, availability, source, availability_updated_at, availability_source, created_at, updated_at)
       VALUES ('p-owner', ?, 'Eierlagt', 'eierlagt', 10, 'NOK', 'in_stock', 'owner', ?, 'producer_dashboard', ?, ?)`,
    ).run(SYNC, confirmedAt, OLD, OLD);
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, category, currency, availability, source, availability_updated_at, availability_source, created_at, updated_at)
       VALUES ('p-admin', ?, 'Admin-ost', 'admin-ost', 75, 'dairy', 'NOK', 'in_stock', 'admin', ?, 'admin_producer_confirmed', ?, ?)`,
    ).run(SYNC, confirmedAt, OLD, OLD);
    // A B1-confirmed (producer_dashboard) row that the owner also imported.
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, category, currency, availability, source, availability_updated_at, availability_source, created_at, updated_at)
       VALUES ('p-b1', ?, 'Bekreftet lam', 'bekreftet lam', 250, 'meat', 'NOK', 'in_stock', 'enrichment', ?, 'producer_dashboard', ?, ?)`,
    ).run(SYNC, confirmedAt, OLD, OLD);

    // An enrichment-created row the admin later confirmed through POST
    // /admin/products/producer-list's UPDATE (source stays 'enrichment',
    // availability_source becomes admin_producer_confirmed).
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, category, currency, availability, source, availability_updated_at, availability_source, created_at, updated_at)
       VALUES ('p-admin-enr', ?, 'Bekreftet honning', 'bekreftet honning', 130, 'honey', 'NOK', 'in_stock', 'enrichment', ?, 'admin_producer_confirmed', ?, ?)`,
    ).run(SYNC, confirmedAt, OLD, OLD);
    const r1 = runProductCatalogSync(db);
    assertTrue(r1.success, "AC7: sync 1 succeeds");
    const lam = productRow(SYNC, "Lammelaar");
    assertEq([lam?.source, lam?.source_url, lam?.fetched_at, lam?.owner_confirmed_at],
      ["owner_import", "https://www.hommelstad.no/butikk", "2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z"],
      "AC7: owner_import → source, source_url, fetched_at, owner_confirmed_at stored");
    assertEq([productRow(SYNC, "Honning")?.source, productRow(SYNC, "Honning")?.owner_confirmed_at], ["owner_manual", "2026-10-20T10:00:00Z"],
      "AC7: an owner-written product gets source owner_manual (≠ 'enrichment')");
    assertEq([productRow(SYNC, "Egg")?.source, productRow(SYNC, "Egg")?.source_url, productRow(SYNC, "Egg")?.owner_confirmed_at], ["enrichment", null, null],
      "AC7: a product without source stays 'enrichment', no provenance");
    assertEq([productRow(SYNC, "Bestilt ost")?.source, productRow(SYNC, "Bestilt ost")?.owner_confirmed_at], ["owner_auto_sync", null],
      "AC7: owner_auto_sync is carried over");
    assertEq([productRow(SYNC, "Bad source")?.source, productRow(SYNC, "Bad source")?.owner_confirmed_at], ["enrichment", null],
      "AC7: an unknown source is 'enrichment' and its confirmedAt is not an owner confirmation");
    assertEq([productRow(SYNC, "Eierlagt")?.source, productRow(SYNC, "Eierlagt")?.owner_confirmed_at], ["owner", null],
      "AC7: a B1 owner-portal row ('owner') keeps its provenance");
    assertEq([productRow(SYNC, "Admin-ost")?.source, productRow(SYNC, "Admin-ost")?.price_nok, productRow(SYNC, "Admin-ost")?.owner_confirmed_at, productRow(SYNC, "Admin-ost")?.updated_at],
      ["admin", 75, null, OLD], "AC7: an admin_producer_confirmed row keeps provenance, price and updated_at");
    {
      const r = productRow(SYNC, "Bekreftet honning");
      assertEq([r?.source, r?.source_url, r?.fetched_at, r?.owner_confirmed_at, r?.price_nok, r?.category, r?.updated_at],
        ["enrichment", null, null, null, 130, "honey", OLD],
        "AC7: an admin_producer_confirmed row with source 'enrichment' keeps its provenance, price, category and updated_at");
    }
    assertEq(productRow(SYNC, "Eierlagt")?.updated_at, OLD, "AC7: a row whose price/category did not change keeps updated_at (sync 1)");
    assertEq(productRow(SYNC, "Bekreftet lam")?.updated_at, OLD, "AC7: the B1 row's price/category are unchanged → updated_at kept (sync 1)");

    // Age every row, then sync again with no change.
    db.prepare("UPDATE products SET updated_at = ? WHERE agent_id = ?").run(OLD, SYNC);
    const before = db.prepare("SELECT name, updated_at FROM products WHERE agent_id = ? ORDER BY name").all(SYNC);
    const r2 = runProductCatalogSync(db);
    assertTrue(r2.success, "AC7: sync 2 succeeds");
    const after = db.prepare("SELECT name, updated_at FROM products WHERE agent_id = ? ORDER BY name").all(SYNC);
    assertEq(after, before, "AC7: two catalog syncs with no change → identical products.updated_at on every row");
    const r3 = runProductCatalogSync(db);
    assertEq([r3.success, db.prepare("SELECT name, updated_at FROM products WHERE agent_id = ? ORDER BY name").all(SYNC)], [true, before],
      "AC7: a third unchanged sync still leaves updated_at alone");

    // A real price change moves updated_at for that row only; so does a category change.
    setKnowledge(knowledge.map((p) => p.name === "Egg" ? { ...p, price: "kr 60" } : p.name === "Honning" ? { ...p, category: "sweets" } : p));
    runProductCatalogSync(db);
    assertTrue(productRow(SYNC, "Egg")?.updated_at !== OLD && productRow(SYNC, "Egg")?.price_nok === 60, "AC7: a price change moves updated_at");
    assertTrue(productRow(SYNC, "Honning")?.updated_at !== OLD && productRow(SYNC, "Honning")?.category === "sweets", "AC7: a category change moves updated_at");
    assertEq(productRow(SYNC, "Lammelaar")?.updated_at, OLD, "AC7: an unchanged row keeps updated_at while others change");

    // ── order: owner_import alone is not orderable; B1 unchanged ────────
    {
      const now = new Date();
      const lamRow = productRow(SYNC, "Lammelaar");
      assertEq([lamRow.availability_source, lamRow.availability_updated_at], ["enrichment", null],
        "order: the sync gives an owner_import row no producer-stated availability source");
      assertTrue(!cart.isRowOrderableForRealOrder(db, lamRow, now), "order: an owner_import row alone is not orderable");
      assertTrue(cart.orderabilityReasons(db, lamRow, now).reasons.some((r) => r.code === "not_confirmed_by_owner"),
        "order: … because it is not confirmed by the owner (not_confirmed_by_owner)");
      for (const name of ["Honning", "Bestilt ost"]) {
        const row = productRow(SYNC, name);
        assertTrue(cart.orderabilityReasons(db, row, now).reasons.some((r) => r.code === "not_confirmed_by_owner"),
          `order: ${name} (${row.source}) is not orderable on its source alone`);
      }
      const b1 = productRow(SYNC, "Bekreftet lam");
      assertEq([b1.availability, b1.availability_source, b1.availability_updated_at, b1.source],
        ["in_stock", "producer_dashboard", confirmedAt, "owner_import"],
        "order: a B1 «på lager» row keeps availability, its producer-stated source and date through the sync");
      const b1Reasons = cart.orderabilityReasons(db, b1, now);
      assertTrue(!b1Reasons.reasons.some((r) => r.level === "product"), "order: the B1 row has no product-level block (in stock, producer-stated)");
      assertTrue(typeof b1Reasons.stock_expires_at === "string" &&
        Math.abs(Date.parse(b1Reasons.stock_expires_at!) - (Date.parse(confirmedAt.replace(" ", "T") + "Z") + 14 * 86_400_000)) < 1000,
        "order: the B1 row still expires 14 days after the owner's confirmation");
    }

    // ── AC8: profile page date line + footer ────────────────────────────
    {
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded */ }
      const seoRouter = require("../routes/seo").default as any;
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const render = (slug: string, lang: string) => {
        let body = "";
        const res: any = {
          status: () => res, send: (b: unknown) => { body = String(b); return res; }, redirect: () => res,
          setHeader: () => res, set: () => res, header: () => res, type: () => res,
        };
        handler({ params: { slug }, lang, ip: "10.9.9.9", headers: { "user-agent": CHROME_UA }, method: "GET" }, res, () => undefined);
        return body;
      };
      const profile = (id: string, name: string, products: unknown[], ownerAt: string | null, enrichedAt: string | null, dataSource?: string) => {
        addAgent(id, name);
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, products, data_source, owner_updated_at, last_enriched_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(id, JSON.stringify(products), dataSource ?? (ownerAt ? "hybrid" : "auto"), ownerAt, enrichedAt);
      };
      profile("s2-imp", "Importgard Test", [
        { name: "Lammelaar", category: "meat", price: "kr 300", source: "owner_import", sourceUrl: "https://www.hommelstad.no/butikk", fetchedAt: "2026-10-21T09:00:00Z", confirmedAt: "2026-10-21T10:00:00Z" },
        { name: "Honning", category: "honey", price: "kr 120", source: "owner_manual", confirmedAt: "2026-10-01T10:00:00Z" },
        { name: "Egg", category: "eggs", price: "kr 55" },
      ], "2026-10-21T10:00:00Z", "2026-09-01T10:00:00Z");
      profile("s2-man", "Eiergard Test", [
        { name: "Honning", category: "honey", price: "kr 120", source: "owner_manual", confirmedAt: "2026-10-21T10:00:00Z" },
      ], "2026-10-21T10:00:00Z", "2026-10-25T10:00:00Z", "owner");
      profile("s2-auto", "Autogard Test", [{ name: "Egg", category: "eggs", price: "kr 55" }], null, "2026-09-01T10:00:00Z");
      profile("s2-none", "Tomgard Test", [], null, "2026-09-01T10:00:00Z");
      profile("s2-noprice", "Prisfri Test", [
        { name: "Honning", category: "honey", source: "owner_manual", confirmedAt: "2026-10-21T10:00:00Z" },
      ], null, null);
      (marketplaceRegistry as any).invalidateCache();

      const no = render("importgard-test", "no");
      const en = render("importgard-test", "en");
      assertTrue(no.includes("Priser hentet fra hommelstad.no 21. okt. 2026 · bekreftet av eier"), "AC8 NO: «Priser hentet fra hommelstad.no 21. okt. 2026 · bekreftet av eier»");
      assertTrue(no.includes("Prisene kan ha endret seg, sjekk med produsenten."), "AC8 NO: price caveat");
      assertTrue(en.includes("Prices fetched from hommelstad.no on 21 Oct 2026 · confirmed by owner"), "AC8 EN: «Prices fetched from hommelstad.no on 21 Oct 2026 · confirmed by owner»");
      assertTrue(en.includes("Prices may have changed, check with the producer."), "AC8 EN: price caveat");
      assertTrue(no.indexOf('class="prod-dates"') > 0 && no.indexOf('class="prod-dates"') < no.indexOf('class="prod-grid"'), "AC8: the date line sits above the products");
      assertTrue(no.includes("Oppdatert av eier 21.10.2026") && en.includes("Updated by owner 10/21/2026"),
        "AC8 footer: owner date newer than enrichment → «Oppdatert av eier» / «Updated by owner»");

      const man = render("eiergard-test", "no");
      const manEn = render("eiergard-test", "en");
      // The footer's source label reads meta.dataSource (getAgentInfo's
      // knowledge has none): owner profiles must not say «Automatisk».
      const footer = (body: string) => { const i = body.indexOf('<div class="data-src">'); return i < 0 ? "" : body.slice(i, body.indexOf("</div>", i)); };
      assertTrue(footer(no).includes('data-dot owner') && footer(no).includes("Verifisert av eier — Oppdatert av eier") && !footer(no).includes("Automatisk"),
        "AC8 footer NO: hybrid profile → owner dot, «Verifisert av eier — Oppdatert av eier …», no «Automatisk»");
      assertTrue(footer(en).includes("Verified by owner — Updated by owner") && !footer(en).includes("Auto-collected"),
        "AC8 footer EN: hybrid profile → «Verified by owner — Updated by owner …»");
      assertTrue(footer(man).includes('data-dot owner') && footer(man).includes("Eierstyrt") && !footer(man).includes("Automatisk"),
        "AC8 footer NO: owner profile → «Eierstyrt», no «Automatisk»");
      assertTrue(footer(manEn).includes("Owner-managed") && !footer(manEn).includes("Auto-collected"), "AC8 footer EN: owner profile → «Owner-managed»");
      for (const lang of ["no", "en"]) {
        const f = footer(render("autogard-test", lang));
        assertTrue(f.includes('data-dot auto') && f.includes(lang === "en" ? "Auto-collected data" : "Automatisk innhentet data"),
          `AC8 footer ${lang}: enrichment-only profile keeps the auto dot and label`);
      }
      assertTrue(man.includes("Oppdatert av eier 21. okt. 2026") && man.includes("Prisene kan ha endret seg"), "AC8 NO: owner-typed products → «Oppdatert av eier 21. okt. 2026» + caveat");
      assertTrue(manEn.includes("Updated by owner on 21 Oct 2026"), "AC8 EN: owner-typed products → «Updated by owner on 21 Oct 2026»");
      assertTrue(man.includes("Sist oppdatert 25.10.2026") && !man.includes("Oppdatert av eier 21.10.2026"),
        "AC8 footer: enrichment date newer → «Sist oppdatert» with that date");

      for (const [slug, what] of [["autogard-test", "enrichment-only products"], ["tomgard-test", "no products"]] as const) {
        for (const lang of ["no", "en"]) {
          const body = render(slug, lang);
          assertTrue(body.length > 1000, `AC8 ${what} (${lang}): page renders`);
          assertTrue(!body.includes("prod-dates") && !body.includes("Prisene kan ha endret seg") && !body.includes("Prices may have changed"),
            `AC8 ${what} (${lang}): no date line, no caveat`);
          assertTrue(!body.includes("Oppdatert av eier") && !body.includes("Updated by owner"), `AC8 ${what} (${lang}): footer has no owner label`);
          assertTrue(body.includes(lang === "en" ? "Last updated 9/1/2026" : "Sist oppdatert 1.9.2026"), `AC8 ${what} (${lang}): footer shows the enrichment date as «Sist oppdatert» / «Last updated»`);
        }
      }
      assertTrue(render("autogard-test", "no").includes('<div class="card-body"><div class="prod-grid">'), "AC8: enrichment-only products card is as before");
      const noPrice = render("prisfri-test", "no");
      assertTrue(noPrice.includes("prod-grid") && !noPrice.includes("prod-dates") && !noPrice.includes("Prisene kan ha endret seg"),
        "AC8: owner products without a shown price get no date line");
      assertTrue(!noPrice.includes("Sist oppdatert") && !noPrice.includes("Oppdatert av eier"), "AC8 footer: no dates → no date in the footer");
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
      (marketplaceRegistry as any).invalidateCache();
    } catch { /* ignore */ }
    db.close();
  }
  if (log) console.log(`\nproduktimport-s2: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runProduktimportS2Tests({ log: true }).then((r) => {
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
