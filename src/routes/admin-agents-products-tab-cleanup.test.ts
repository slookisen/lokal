/**
 * admin-agents-products-tab-cleanup.test.ts — dev-request 2026-11-10-rfb-
 * bakke-rydding-dublett-og-innlimte-varer, S2.
 *
 * POST /admin/agents/products-tab-cleanup: splits pasted tab-separated
 * product rows («Solbærsyltetøy\tSyltetøy\t95 kr\tIkke oppgitt») of ONE
 * profile into name / category / price, drops the header row, the alcohol
 * rows and rows that duplicate an existing non-tab row. Dry run by default.
 *
 * Covers: auth (no / wrong key -> 403), validation (missing / non-string /
 * blank agent_id -> 400, unknown -> 404); dry run reports per-row before/after
 * and writes nothing (products, audit, catalog); split values (category map,
 * unknown category kept, «kr 95» + priceUnit, «Ikke oppgitt» price left empty,
 * availability dropped / kept as note); header + alcohol (incl. inside a word)
 * removed; «Groviser (håndlaget)» kept once; non-tab rows byte-identical and
 * in their positions; apply writes + one audit row with the old value
 * (revertable) + catalog rename / retire; a second apply is a no-op; curated
 * `products` -> skipped_curated / products_locked on dry run and apply;
 * owner-locked profile still cleaned (reported); apply:"false" is a dry run;
 * «Navn/Kategori/Pris/Sesong» header (Bakke S2b) removed, season -> note;
 * PUT /admin/knowledge still stores a tab row as before.
 *
 * Harness: __pinInMemoryDbForTesting (getDb() -> fresh in-memory DB, restored
 * in finally), router.handle() with a fake req/res — no HTTP. Sets ADMIN_KEY
 * only when unset (restored).
 */

import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: "/",
      originalUrl: "/",
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

const T = "\t";
const HEADER = { name: `Produkt${T}Kategori${T}Pris${T}Tilgjengelighet`, category: "other", seasonal: false, price: "" };
const SOLBAER = { name: `Solbærsyltetøy${T}Syltetøy${T}95 kr${T}Ikke oppgitt`, category: "other", seasonal: false, price: "" };
const KIRSEBAER_COGNAC = { name: `Kirsebærgelé med Cognac${T}Gelé${T}110 kr${T}Ikke oppgitt`, category: "other", seasonal: false, price: "" };
const AQUAVIT = { name: `Aquavitgelé${T}Gelé${T}110 kr${T}Ikke oppgitt`, category: "other", seasonal: false, price: "" };
const MARVPOSTEI = { name: `Marvpostei${T}Postei${T}85 kr${T}Ikke oppgitt`, category: "dairy", seasonal: false, price: "" };
const SPEKEPOLSE = { name: `Spekepølse${T}Spekemat${T}120 kr/kg${T}Fra september`, category: "other", seasonal: false, price: "" };
const KJEKS = { name: `Havrekjeks${T}Kjeks${T}Ikke oppgitt${T}Ikke oppgitt`, category: "other", seasonal: false, price: "" };
const GROVIS_TAB = { name: `Groviser (håndlaget)${T}Bakst${T}60 kr${T}Ikke oppgitt`, category: "other", seasonal: false, price: "" };
// Non-tab rows: must survive byte-identical and in place.
const GROVIS = { name: "Groviser (håndlaget)", category: "bakery", seasonal: false, price: "kr 60", priceUnit: "kr", note: "Samlerad" };
const EGG = { name: "Egg", category: "eggs", seasonal: true, months: [3, 4, 5], organic: false };
const STRING_ENTRY = "Rabarbra";

const FIXTURE = [GROVIS, HEADER, SOLBAER, EGG, KIRSEBAER_COGNAC, AQUAVIT, MARVPOSTEI, STRING_ENTRY, SPEKEPOLSE, KJEKS, GROVIS_TAB];

export function runAdminAgentsProductsTabCleanupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "products-tab-cleanup-standalone-key";
    const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;
    const restoreDb = initMod.__pinInMemoryDbForTesting();
    try {
      const db = initMod.getDb();
      const mod = require("./admin-agents-products-tab-cleanup") as typeof import("./admin-agents-products-tab-cleanup");
      mod.__setProductsTabCleanupDbForTesting(null);
      const router = mod.default;
      const H = { "x-admin-key": testKey };
      const call = (body: any, headers: Record<string, string> = H, query?: Record<string, string>) =>
        callRoute(router, { body, headers, query });

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, 'Gårdsutsalg.', 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
      );
      const insertKnowledge = db.prepare(`INSERT INTO agent_knowledge (agent_id, products, curated_fields) VALUES (?, ?, ?)`);
      const agent = (id: string, products: unknown[] | null, curated = "{}", claimedAt: string | null = null) => {
        insertAgent.run(id, `Gård ${id}`, `k-${id}`, claimedAt);
        if (products) insertKnowledge.run(id, JSON.stringify(products), curated);
      };
      const storedProducts = (id: string) =>
        (db.prepare(`SELECT products FROM agent_knowledge WHERE agent_id = ?`).get(id) as { products: string }).products;
      const audits = (id: string) =>
        db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ?`).all(id) as any[];
      const insertCatalog = db.prepare(`INSERT INTO products (id, agent_id, name, name_norm) VALUES (?, ?, ?, ?)`);
      const catalog = (id: string) =>
        db.prepare(`SELECT id, name, name_norm FROM products WHERE agent_id = ? ORDER BY id`).all(id) as any[];

      // ── pure planner ──────────────────────────────────────────────────
      {
        assertEq(mod.parsePriceCell("95 kr"), "kr 95", "price: «95 kr» -> «kr 95»");
        assertEq(mod.parsePriceCell("kr 95"), "kr 95", "price: «kr 95»");
        assertEq(mod.parsePriceCell("95,-"), "kr 95", "price: «95,-»");
        assertEq(mod.parsePriceCell("120 kr/kg"), "kr 120/kg", "price: «120 kr/kg»");
        assertEq(mod.parsePriceCell("49,50 kr"), "kr 49,50", "price: decimals");
        assertEq(mod.parsePriceCell("Ikke oppgitt"), null, "price: «Ikke oppgitt» -> null");
        assertEq(mod.parsePriceCell("0 kr"), null, "price: 0 -> null");
        const none = mod.planProductsTabCleanup([GROVIS, EGG, STRING_ENTRY]);
        assertEq([none.changes.length, none.tab_rows, none.unchanged], [0, 0, 3], "planner: no tab rows -> no changes");
        assertEq(JSON.stringify(none.products), JSON.stringify([GROVIS, EGG, STRING_ENTRY]), "planner: no tab rows -> same array");
        // Header columns decide the layout (price before category here).
        const swapped = mod.planProductsTabCleanup([
          { name: `Navn${T}Pris${T}Kategori`, category: "other" },
          { name: `Bringebærsyltetøy${T}90 kr${T}Syltetøy`, category: "other" },
        ]);
        assertEq(swapped.products, [{ name: "Bringebærsyltetøy", category: "preserves", price: "kr 90", priceUnit: "kr" }],
          "planner: columns read from the header row");
        // «Sesong» header (the real Bakke header): removed, not split into «Navn».
        const sesong = mod.planProductsTabCleanup([
          { name: `Navn${T}Kategori${T}Pris${T}Sesong`, category: "other", price: "" },
          { name: `Solbærsyltetøy${T}Syltetøy${T}95 kr${T}Ikke oppgitt`, category: "other", price: "" },
          { name: `Havrekjeks${T}Kjeks${T}45 kr${T}Ikke oppgitt`, category: "other", price: "" },
          { name: `Jordbærsyltetøy${T}Syltetøy${T}95 kr${T}Juni–august`, category: "other", price: "" },
        ]);
        assertEq(sesong.changes.map((c) => c.action), ["removed_header", "split", "split", "split"],
          "planner: «Sesong» header -> removed_header, rows split");
        assertTrue(!sesong.products.some((p: any) => p && p.name === "Navn"), "planner: «Sesong» header -> no product named «Navn»");
        assertEq(sesong.products, [
          { name: "Solbærsyltetøy", category: "preserves", price: "kr 95", priceUnit: "kr" },
          { name: "Havrekjeks", category: "bakery", price: "kr 45", priceUnit: "kr" },
          { name: "Jordbærsyltetøy", category: "preserves", price: "kr 95", priceUnit: "kr", note: "Juni–august" },
        ], "planner: «Sesong» rows -> category / price split, meaningful season -> note");
        assertEq(sesong.changes[1].dropped_cells, ["availability: Ikke oppgitt"], "planner: «Sesong» «Ikke oppgitt» dropped as availability");
        assertEq(sesong.changes[3].dropped_cells, undefined, "planner: «Sesong» meaningful cell not dropped");
        for (const w of ["Sesong", "Sesonger", "Sesongvare"]) {
          const h = mod.planProductsTabCleanup([{ name: `Produkt${T}${w}`, category: "other" }]);
          assertEq(h.changes.map((c) => c.action), ["removed_header"], `planner: «${w}» is a header word`);
        }
        // Existing header fixture still behaves the same.
        const legacy = mod.planProductsTabCleanup([HEADER, SOLBAER]);
        assertEq(legacy.changes.map((c) => c.action), ["removed_header", "split"], "planner: «Tilgjengelighet» header unchanged");
        // Two identical tab lines -> one product.
        const twice = mod.planProductsTabCleanup([SOLBAER, SOLBAER]);
        assertEq(twice.changes.map((c) => c.action), ["split", "removed_duplicate"], "planner: identical tab rows -> split + removed_duplicate");
        // Alcohol only touches tab rows; a non-tab one is only listed.
        const nonTabAlc = mod.planProductsTabCleanup([{ name: "Akevittgelé", category: "preserves" }, SOLBAER]);
        assertEq([nonTabAlc.products.length, nonTabAlc.non_tab_alcohol_rows], [2, ["Akevittgelé"]], "planner: non-tab alcohol row kept, listed");
        // An existing price on a tab row is kept.
        const priced = mod.planProductsTabCleanup([{ ...SOLBAER, price: "kr 99" }]);
        assertEq((priced.products[0] as any).price, "kr 99", "planner: existing price kept");
      }

      // ── auth + validation ─────────────────────────────────────────────
      agent("bakke", FIXTURE);
      const original = storedProducts("bakke");
      {
        const r1 = await call({ agent_id: "bakke" }, {});
        assertEq(r1.status, 403, "auth: no admin key -> 403");
        const r2 = await call({ agent_id: "bakke", apply: true }, { "x-admin-key": "wrong" });
        assertEq(r2.status, 403, "auth: wrong admin key -> 403");
        assertEq(storedProducts("bakke"), original, "auth: rejected apply wrote nothing");
        assertEq((await call({})).status, 400, "validation: missing agent_id -> 400");
        assertEq((await call({ agent_id: 42 })).status, 400, "validation: non-string agent_id -> 400");
        assertEq((await call({ agent_id: "   " })).status, 400, "validation: blank agent_id -> 400");
        assertEq((await call({ agent_id: "a b" })).status, 400, "validation: agent_id with whitespace -> 400");
        assertEq((await call({ agent_id: "x".repeat(201) })).status, 400, "validation: over-long agent_id -> 400");
        const nf = await call({ agent_id: "nope" });
        assertEq([nf.status, nf.body?.outcome], [404, "not_found"], "validation: unknown agent -> 404");
        const nfa = await call({ agent_id: "nope", apply: true });
        assertEq(nfa.status, 404, "validation: unknown agent on apply -> 404");
      }

      // Catalog rows as the sync would have made them (key = whole tab line).
      insertCatalog.run("p-solbaer", "bakke", SOLBAER.name, `solbærsyltetøy syltetøy 95 kr ikke oppgitt`);
      insertCatalog.run("p-aquavit", "bakke", AQUAVIT.name, `aquavitgelé gelé 110 kr ikke oppgitt`);
      insertCatalog.run("p-egg", "bakke", "Egg", "egg");
      const catalogBefore = catalog("bakke");

      // ── dry run ───────────────────────────────────────────────────────
      const dry = await call({ agent_id: "bakke" });
      {
        assertEq([dry.status, dry.body.dry_run, dry.body.outcome], [200, true, "would_write"], "dry run: would_write");
        assertEq(dry.body.counts, {
          split: 4, removed_header: 1, removed_alcohol: 2, removed_duplicate: 1, skipped_unparseable: 0, unchanged: 3,
        }, "dry run: counts");
        assertEq([dry.body.products_before, dry.body.products_after, dry.body.tab_rows], [11, 7, 8], "dry run: sizes");
        assertEq(storedProducts("bakke"), original, "dry run: products byte-identical");
        assertEq(audits("bakke").length, 0, "dry run: no audit row");
        assertEq(catalog("bakke"), catalogBefore, "dry run: catalog untouched");
        const byIdx = (i: number) => dry.body.rows.find((r: any) => r.index === i);
        assertEq([byIdx(1).action, byIdx(1).before], ["removed_header", HEADER], "row 1: header removed, before shown");
        assertEq(byIdx(2).action, "split", "row 2: Solbærsyltetøy split");
        assertEq(byIdx(2).after, { name: "Solbærsyltetøy", category: "preserves", seasonal: false, price: "kr 95", priceUnit: "kr" },
          "row 2: Solbærsyltetøy -> preserves, kr 95, priceUnit kr");
        assertEq(byIdx(2).dropped_cells, ["availability: Ikke oppgitt"], "row 2: «Ikke oppgitt» availability dropped");
        assertEq(byIdx(4).action, "removed_alcohol", "row 4: Kirsebærgelé med Cognac removed");
        assertEq(byIdx(5).action, "removed_alcohol", "row 5: Aquavitgelé removed (inside a word)");
        assertEq(byIdx(6).after, { name: "Marvpostei", category: "dairy", seasonal: false, price: "kr 85", priceUnit: "kr" },
          "row 6: unknown category cell keeps the existing category");
        assertEq(byIdx(8).after, {
          name: "Spekepølse", category: "meat", seasonal: false, price: "kr 120/kg", priceUnit: "kr", note: "Fra september",
        }, "row 8: Spekemat -> meat, kr 120/kg, availability kept as note");
        assertEq(byIdx(9).after, { name: "Havrekjeks", category: "bakery", seasonal: false, price: "" },
          "row 9: «Ikke oppgitt» price left empty, no priceUnit");
        assertEq(byIdx(10).action, "removed_duplicate", "row 10: Groviser (håndlaget) tab row -> removed_duplicate");
        assertEq(byIdx(2).catalog?.action, "rename_in_place", "dry run: catalog rename planned for the split row");
        assertEq(byIdx(5).catalog?.action, "retire_delete", "dry run: catalog retire planned for the alcohol row");
        assertEq(dry.body.owner_locked, false, "dry run: owner_locked reported");
      }

      // ── «Sesong» header via the route (dry run) ───────────────────────
      {
        const SESONG_HEADER = { name: `Navn${T}Kategori${T}Pris${T}Sesong`, category: "other", seasonal: false, price: "" };
        agent("sesong", [SESONG_HEADER, SOLBAER, KJEKS]);
        const before = storedProducts("sesong");
        const r = await call({ agent_id: "sesong" });
        assertEq([r.status, r.body.dry_run, r.body.counts?.removed_header, r.body.counts?.split], [200, true, 1, 2],
          "«Sesong» dry run: header removed (removed_header 1), rows split");
        assertTrue(!r.body.rows.some((x: any) => x.after && x.after.name === "Navn"), "«Sesong» dry run: no «Navn» product");
        assertEq([storedProducts("sesong"), audits("sesong").length], [before, 0], "«Sesong» dry run: nothing written");
      }

      // apply:"false" / unknown forms stay dry.
      {
        const r = await call({ agent_id: "bakke", apply: "false" });
        assertEq([r.body.dry_run, storedProducts("bakke") === original], [true, true], "apply:\"false\" is a dry run");
      }

      // ── apply ─────────────────────────────────────────────────────────
      {
        const r = await call({ agent_id: "bakke", apply: true });
        assertEq([r.status, r.body.dry_run, r.body.outcome], [200, false, "written"], "apply: written");
        const after = JSON.parse(storedProducts("bakke"));
        assertEq(after, dry.body.rows.length && [
          GROVIS,
          dry.body.rows.find((x: any) => x.index === 2).after,
          EGG,
          dry.body.rows.find((x: any) => x.index === 6).after,
          STRING_ENTRY,
          dry.body.rows.find((x: any) => x.index === 8).after,
          dry.body.rows.find((x: any) => x.index === 9).after,
        ], "apply: stored products = the dry run's plan, in original order");
        assertEq([JSON.stringify(after[0]), JSON.stringify(after[2]), JSON.stringify(after[4])],
          [JSON.stringify(GROVIS), JSON.stringify(EGG), JSON.stringify(STRING_ENTRY)], "apply: non-tab rows byte-identical");
        assertTrue(!storedProducts("bakke").includes("\\t"), "apply: no tab left in products");
        assertEq(after.filter((p: any) => p && p.name === "Groviser (håndlaget)").length, 1, "apply: no duplicate Groviser");
        assertTrue(!/cognac|aquavit/i.test(storedProducts("bakke")), "apply: alcohol rows gone");
        const a = audits("bakke");
        assertEq(a.length, 1, "apply: one audit row");
        assertEq([a[0].field_name, a[0].changed_by, a[0].old_value, a[0].new_value], ["products", "admin", original, storedProducts("bakke")],
          "apply: audit row carries the old value (revertable) and the new value");
        assertTrue(r.body.audit_id && typeof r.body.audit_id === "string", "apply: audit_id returned");
        assertTrue(/products-tab-cleanup-/.test(a[0].notes) && /catalog/.test(a[0].notes), "apply: audit notes carry batch tag + catalog effect");
        const cat = catalog("bakke");
        assertEq(cat.map((c: any) => [c.id, c.name, c.name_norm]), [["p-egg", "Egg", "egg"], ["p-solbaer", "Solbærsyltetøy", "solbærsyltetøy"]],
          "apply: catalog row renamed in place, alcohol row deleted, others untouched");
        const again = await call({ agent_id: "bakke", apply: true });
        assertEq([again.body.outcome, audits("bakke").length], ["skipped_no_tab_rows", 1], "apply twice: second is a no-op, no audit");
      }

      // ── locked products ───────────────────────────────────────────────
      {
        agent("locked", FIXTURE, JSON.stringify({ products: true }));
        const before = storedProducts("locked");
        const d = await call({ agent_id: "locked" });
        assertEq([d.status, d.body.outcome, d.body.reason], [200, "skipped_curated", "products_locked"], "locked: dry run stops with products_locked");
        const ap = await call({ agent_id: "locked", apply: true });
        assertEq([ap.body.outcome, ap.body.reason, ap.body.dry_run], ["skipped_curated", "products_locked", false], "locked: apply stops too");
        assertEq([storedProducts("locked"), audits("locked").length], [before, 0], "locked: nothing written");
        // Other curated keys do not lock products.
        agent("otherlock", [SOLBAER], JSON.stringify({ about: true }));
        const o = await call({ agent_id: "otherlock", apply: true });
        assertEq(o.body.outcome, "written", "curated about only: products still cleaned");
      }

      // ── owner-locked profile (Bakke is owner-verified) ────────────────
      {
        agent("owned", [SOLBAER, EGG], "{}", "2026-10-01T00:00:00Z");
        const r = await call({ agent_id: "owned", apply: true });
        assertEq([r.body.outcome, r.body.owner_locked], ["written", true], "owner-locked: cleaned, owner_locked reported");
      }

      // ── no knowledge row / malformed JSON ─────────────────────────────
      {
        agent("bare", null);
        const r = await call({ agent_id: "bare", apply: true });
        assertEq([r.status, r.body.outcome], [200, "skipped_no_tab_rows"], "no knowledge row -> skipped_no_tab_rows");
        insertAgent.run("bad", "Gård bad", "k-bad", null);
        insertKnowledge.run("bad", "{not json", "{}");
        const b = await call({ agent_id: "bad", apply: true });
        assertEq([b.body.outcome, storedProducts("bad"), audits("bad").length], ["skipped_malformed_json", "{not json", 0],
          "malformed products -> skipped, nothing written");
      }

      // ── catalog safety branches ───────────────────────────────────────
      {
        agent("cat", [SOLBAER, AQUAVIT, MARVPOSTEI, KJEKS, SPEKEPOLSE]);
        agent("neighbour", [EGG]);
        // SOLBAER: old row referenced by a cart item AND the cleaned name already
        //   has its own catalog row -> retire_out_of_stock (no rename, no 500).
        insertCatalog.run("c-solbaer-old", "cat", SOLBAER.name, "solbærsyltetøy syltetøy 95 kr ikke oppgitt");
        insertCatalog.run("c-solbaer-new", "cat", "Solbærsyltetøy", "solbærsyltetøy");
        db.prepare(`INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty) VALUES ('ci1', 'cart1', 'c-solbaer-old', 'cat', 1)`).run();
        // AQUAVIT: removed row referenced by a cart wish -> retire_out_of_stock.
        insertCatalog.run("c-aquavit", "cat", AQUAVIT.name, "aquavitgelé gelé 110 kr ikke oppgitt");
        db.prepare(`INSERT INTO cart_wishes (id, cart_id, term, qty, chosen_product_id) VALUES ('cw1', 'cart2', 'gelé', 1, 'c-aquavit')`).run();
        // KJEKS: unreferenced old row, cleaned name already in the catalog -> retire_delete.
        insertCatalog.run("c-kjeks-old", "cat", KJEKS.name, "havrekjeks kjeks ikke oppgitt ikke oppgitt");
        insertCatalog.run("c-kjeks-new", "cat", "Havrekjeks", "havrekjeks");
        // MARVPOSTEI: only ANOTHER producer has a row with the old key, and
        //   another producer has rows with the new keys -> neither is touched.
        insertCatalog.run("n-marv-old", "neighbour", MARVPOSTEI.name, "marvpostei postei 85 kr ikke oppgitt");
        insertCatalog.run("n-speke-new", "neighbour", "Spekepølse", "spekepølse");
        // SPEKEPOLSE: own old row, no refs, new key free for THIS agent -> rename_in_place.
        insertCatalog.run("c-speke-old", "cat", SPEKEPOLSE.name, "spekepølse spekemat 120 kr/kg fra september");
        const row = (id: string) => db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as any;
        const neighbourBefore = JSON.stringify(db.prepare(`SELECT * FROM products WHERE agent_id = 'neighbour' ORDER BY id`).all());
        const keptNewBefore = JSON.stringify([row("c-solbaer-new"), row("c-kjeks-new")]);

        const d = await call({ agent_id: "cat" });
        const act = (i: number) => d.body.rows.find((r: any) => r.index === i)?.catalog?.action;
        assertEq([act(0), act(1), act(2), act(3), act(4)],
          ["retire_out_of_stock", "retire_out_of_stock", "none", "retire_delete", "rename_in_place"], "catalog dry run: planned actions");
        assertEq(d.body.rows.find((r: any) => r.index === 0).catalog.references, { cart_items: 1, cart_wishes: 0 }, "catalog dry run: cart_items reference counted");
        assertEq(d.body.rows.find((r: any) => r.index === 1).catalog.references, { cart_items: 0, cart_wishes: 1 }, "catalog dry run: cart_wishes reference counted");
        assertEq(d.body.rows.find((r: any) => r.index === 0).catalog.existing_product_id, "c-solbaer-new", "catalog dry run: existing new-name row reported");
        assertEq(row("c-solbaer-old").availability, "in_stock", "catalog dry run: availability untouched");

        const r = await call({ agent_id: "cat", apply: true });
        assertEq([r.status, r.body.outcome], [200, "written"], "catalog apply: new name already in catalog -> no 500, written");
        assertEq(audits("cat").length, 1, "catalog apply: audit row written");
        assertTrue(!storedProducts("cat").includes("\\t"), "catalog apply: products cleaned");
        const so = row("c-solbaer-old");
        assertEq(so ? [so.name_norm, so.availability] : null, ["solbærsyltetøy syltetøy 95 kr ikke oppgitt", "out_of_stock"],
          "catalog apply: cart_items-referenced row kept, availability = out_of_stock");
        const aq = row("c-aquavit");
        assertEq(aq ? aq.availability : null, "out_of_stock", "catalog apply: cart_wishes-referenced row kept, availability = out_of_stock");
        assertEq(row("c-kjeks-old"), undefined, "catalog apply: unreferenced old row with existing new name -> deleted");
        assertEq(JSON.stringify([row("c-solbaer-new"), row("c-kjeks-new")]), keptNewBefore, "catalog apply: existing new-name rows byte-identical");
        const sp = row("c-speke-old");
        assertEq(sp ? [sp.name, sp.name_norm] : null, ["Spekepølse", "spekepølse"], "catalog apply: own row renamed in place");
        assertEq(JSON.stringify(db.prepare(`SELECT * FROM products WHERE agent_id = 'neighbour' ORDER BY id`).all()), neighbourBefore,
          "catalog apply: another producer's rows with the same name_norm byte-identical");
      }

      // ── query-string apply ────────────────────────────────────────────
      {
        agent("q", [SOLBAER]);
        const r = await call({ agent_id: "q" }, H, { apply: "1" });
        assertEq([r.body.dry_run, r.body.outcome], [false, "written"], "?apply=1 applies");
      }

      // ── PUT /admin/knowledge unaffected ───────────────────────────────
      {
        agent("putk", null);
        const knowledgeRouter = (require("./admin-knowledge") as typeof import("./admin-knowledge")).default;
        const r = await callRoute(knowledgeRouter, {
          method: "PUT",
          headers: H,
          body: { agent_id: "putk", products: [SOLBAER] },
        });
        assertEq(r.status, 200, "PUT /admin/knowledge: still 200");
        const stored = JSON.parse(storedProducts("putk"));
        assertEq(stored.length === 1 ? stored[0].name : null, SOLBAER.name, "PUT /admin/knowledge: stores the tab row as before (no cleanup there)");
        assertEq(audits("putk").filter((x: any) => /products-tab-cleanup/.test(x.notes || "")).length, 0,
          "PUT /admin/knowledge: no tab-cleanup audit");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      restoreDb();
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminAgentsProductsTabCleanupTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
