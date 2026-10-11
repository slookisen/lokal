/**
 * homepage-refresh-kategorinavn.test.ts — dev-request
 * 2026-10-10-rfb-homepage-refresh-kategorinavn-som-produkter.
 *
 *   AC1  refreshHomepageContent writes `categories` with a website_homepage
 *        source and NO products built from category names.
 *   AC2  canCorrectFactualField: products that are only category names are
 *        "known bad" (a real product list replaces them), a new list that is
 *        itself only category names never replaces anything, and real
 *        homepage-sourced products are still not overwritten.
 *   AC3  the auto-select of POST /admin/homepage-content-refresh also takes
 *        rows with a homepage source but uncorroborated categories / generic
 *        products, and leaves fully corroborated rows alone.
 *   AC4  (gate part) GET /admin/outreach-candidates names the rows held only by
 *        generic_products_only / categories_not_corroborated in
 *        data_quality_held (last key); the suppression itself is unchanged.
 *
 * Standalone: npx tsx src/routes/homepage-refresh-kategorinavn.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PAGE_ABOUT = "Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.";
const OLD_ABOUT = "Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.";
const HOME_HTML =
  `<html><head><title>Kategori Gård</title><meta property="og:description" content="${PAGE_ABOUT}"></head>` +
  `<body><h1>Kategori Gård</h1><p>Vi selger honning, egg og lammekjøtt. Velkommen til gården!</p></body></html>`;

function callGateSync(router: any, query: Record<string, string>, key: string): any {
  let body: any;
  const req: any = { method: "GET", url: "/", query, headers: { "x-admin-key": key } };
  const res: any = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(p: any) { body = p; return this; },
  };
  router.handle(req, res, () => {});
  return body;
}

export async function runHomepageRefreshKategorinavnTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.__peekDbForTesting();
  const prevParking = process.env.HOMEPAGE_PARKING_DISABLED;
  const prevAdminKey = process.env.ADMIN_KEY;
  delete process.env.HOMEPAGE_PARKING_DISABLED;
  const testKey = process.env.ADMIN_KEY || "homepage-refresh-kategorinavn-test-key";
  process.env.ADMIN_KEY = testKey;

  const GENERIC = JSON.stringify([
    { name: "Frukt", category: "fruit", seasonal: false },
    { name: "Bær", category: "berries", seasonal: false },
  ]);
  const REAL = JSON.stringify([{ name: "Eplemost", category: "other", seasonal: false }]);
  const HP = (v: string) => ({ source_type: "website_homepage", value: v, fetched_at: "2026-01-01T00:00:00.000Z" });
  const GP = (v: string) => ({ source_type: "google_places", value: v, fetched_at: "2026-01-01T00:00:00.000Z" });

  try {
    const mod = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const aoc = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");

    // ── AC2: canCorrectFactualField (pure) ───────────────────────────────
    const can = mod.canCorrectFactualField;
    const base = { field: "products", websiteOwnershipUnverified: false, isCurated: false };
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Frukt,Bær")], incomingFieldProvenance: [HP("Eplemost")], existingValue: GENERIC, incomingValue: REAL }),
      { allowed: true, reason: "ok_existing_generic_category_names" },
      "AC2: homepage-sourced category-name products ARE replaceable by real products from a homepage source",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [GP("x")], incomingFieldProvenance: [HP("Eplemost")], existingValue: GENERIC, incomingValue: REAL }).allowed,
      true,
      "AC2: google_places-sourced category-name products replaceable by real products",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Frukt,Bær")], incomingFieldProvenance: [HP("Frukt,Bær")], existingValue: GENERIC, incomingValue: GENERIC }),
      { allowed: false, reason: "new_generic_category_names" },
      "AC2: a new list that is itself only category names never replaces",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [GP("x")], incomingFieldProvenance: [HP("Frukt")], existingValue: REAL, incomingValue: GENERIC }).allowed,
      false,
      "AC2: category names never replace real products either",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Eplemost")], incomingFieldProvenance: [HP("Sider")], existingValue: REAL, incomingValue: JSON.stringify([{ name: "Sider" }]) }),
      { allowed: false, reason: "new_not_two_tierA_or_owner" },
      "AC2: existing REAL homepage-sourced products still cannot be overwritten (current rule)",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Frukt,Bær")], incomingFieldProvenance: [GP("Eplemost")], existingValue: GENERIC, incomingValue: REAL }).allowed,
      false,
      "AC2: a single weak (google_places) source does not replace category-name products",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Frukt,Bær")], incomingFieldProvenance: [HP("Eplemost")], existingValue: GENERIC, incomingValue: REAL, isCurated: true }),
      { allowed: false, reason: "curated_locked" },
      "AC2: the curated lock stays absolute",
    );
    assertEq(
      can({
        ...base,
        existingFieldProvenance: [{ source_type: "owner", value: "Frukt,Bær", fetched_at: "2026-01-01T00:00:00.000Z" }],
        incomingFieldProvenance: [HP("Eplemost")],
        existingValue: GENERIC,
        incomingValue: REAL,
      }).allowed,
      false,
      "AC2: owner-attested category-name products are NOT known bad (owner lock)",
    );
    assertEq(
      can({ ...base, existingFieldProvenance: [HP("Frukt,Bær")], incomingFieldProvenance: [HP("Eplemost")] }).allowed,
      false,
      "AC2: without values (old call sites) the provenance-only behaviour is unchanged",
    );

    // ── fixtures for AC1 / AC3 / AC4 ──────────────────────────────────────
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    function seed(
      id: string,
      o: { cats?: unknown[] | null; products?: string; prov?: Record<string, unknown>; email?: string; updated?: string },
    ): void {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
         VALUES (?, ?, 'Gård', 'test', 'post@example.no', ?, 'producer', ?, ?)`,
      ).run(id, `Gård ${id}`, `https://${id}.kat-test.no`, `key-${id}`, o.cats ? JSON.stringify(o.cats) : null);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, products, field_provenance, curated_fields,
            verification_status, enrichment_status, url_last_status, url_last_probed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'), ?)`,
      ).run(
        id,
        o.email ?? `post@${id}.kat-test.no`,
        `https://${id}.kat-test.no`,
        OLD_ABOUT,
        o.products ?? "[]",
        JSON.stringify(o.prov ?? {}),
        o.updated ?? "2020-01-01T00:00:00.000Z",
      );
    }

    // AC1 — refresh on a page with platform categories.
    seed("ac1-generic", { products: GENERIC, prov: { about: [GP(OLD_ABOUT)] } });
    seed("ac1-empty", { prov: { about: [GP(OLD_ABOUT)] } });
    const stubFetch = async () =>
      new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const result = await mod.refreshHomepageContent(
      db as any,
      [
        { agent_id: "ac1-generic", name: "Gård ac1-generic", homepage_url: "https://ac1-generic.kat-test.no" },
        { agent_id: "ac1-empty", name: "Gård ac1-empty", homepage_url: "https://ac1-empty.kat-test.no" },
      ] as any,
      { dryRun: false, fetchImpl: stubFetch as any },
    );
    assertEq(result.by_field.products, 0, "AC1: no products written (by_field.products = 0)");
    assertEq((result.by_field.categories ?? 0) >= 2, true, "AC1: categories written for both rows");
    for (const id of ["ac1-generic", "ac1-empty"]) {
      const k = db.prepare(`SELECT products, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
      const a = db.prepare(`SELECT categories FROM agents WHERE id = ?`).get(id) as any;
      const prov = JSON.parse(k.field_provenance);
      const catSources = JSON.stringify(prov.categories ?? "");
      assertEq(catSources.includes("website_homepage"), true, `AC1 ${id}: categories carry a website_homepage source`);
      assertEq(Array.isArray(JSON.parse(a.categories)) && JSON.parse(a.categories).length > 0, true, `AC1 ${id}: categories column written`);
      assertEq("products" in prov, false, `AC1 ${id}: no products provenance written`);
      assertEq(k.products, id === "ac1-generic" ? GENERIC : "[]", `AC1 ${id}: products column untouched (never rewritten as category names)`);
    }
    db.prepare(`DELETE FROM agent_knowledge`).run();
    db.prepare(`DELETE FROM agents`).run();

    // AC3 — auto-select.
    const aboutHp = { about: [HP("x")] };
    const fullHp = { about: [HP("x")], categories: [HP("honey")], products: [HP("Eplemost")] };
    seed("sel-fresh", { prov: { about: [GP(OLD_ABOUT)] }, updated: "2020-01-01T00:00:00.000Z" });
    seed("sel-nocats", { cats: ["honey"], products: REAL, prov: aboutHp, updated: "2020-01-02T00:00:00.000Z" });
    seed("sel-generic", { cats: ["honey"], products: GENERIC, prov: { ...fullHp, products: [HP("Frukt")] }, updated: "2020-01-03T00:00:00.000Z" });
    seed("sel-ok", { cats: ["honey"], products: REAL, prov: fullHp, updated: "2020-01-04T00:00:00.000Z" });
    seed("sel-parked", { cats: ["honey"], products: REAL, prov: aboutHp, updated: "2020-01-05T00:00:00.000Z" });
    db.prepare(`UPDATE agent_knowledge SET homepage_unreachable_since = datetime('now') WHERE agent_id = 'sel-parked'`).run();
    const picked = mod.selectHomepageContentRefreshAutoTargets(db as any, 25).map((t) => t.agent_id).sort();
    assertEq(
      picked,
      ["sel-fresh", "sel-nocats"],
      "AC3: picks the no-homepage row and the row with homepage about but no categories source; NOT the generic-products row with corroborated categories (the refresh cannot fix it), NOT the fully corroborated row, NOT the parked row",
    );
    assertEq(
      mod.selectHomepageContentRefreshAutoTargets(db as any, 2).length,
      2,
      "AC3: the limit still applies",
    );
    db.prepare(`DELETE FROM agent_knowledge`).run();
    db.prepare(`DELETE FROM agents`).run();

    // AC3b — rows the refresh cannot fix do not stick at the front: after a
    // refresh with no write they move to the back and fixable rows are reached.
    const stuckHtml = `<html><head><title>Tom</title></head><body><p>Velkommen.</p></body></html>`;
    const pages: Record<string, string> = {};
    for (const id of ["rot-a", "rot-b", "rot-c"]) {
      seed(id, { cats: ["fish"], products: REAL, prov: aboutHp, updated: `2020-02-0${id.charCodeAt(4) - 96}T00:00:00.000Z` });
      pages[`${id}.kat-test.no`] = stuckHtml;
    }
    seed("rot-d", { cats: ["fish"], products: REAL, prov: aboutHp, updated: "2020-02-09T00:00:00.000Z" });
    pages["rot-d.kat-test.no"] = HOME_HTML;
    const rotFetch = async (url: string) =>
      new Response(pages[new URL(url).host] ?? "", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const seen: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const targets = mod.selectHomepageContentRefreshAutoTargets(db as any, 2);
      seen.push(targets.map((t) => t.agent_id));
      if (targets.length === 0) break;
      await mod.refreshHomepageContent(db as any, targets, { dryRun: false, fetchImpl: rotFetch as any });
    }
    assertEq(seen[0], ["rot-a", "rot-b"], "AC3b: round 1 takes the front of the queue");
    assertEq(seen[1].includes("rot-d"), true, "AC3b: round 2 reaches the fixable row after the stuck rows were stamped");
    assertEq(seen[1].includes("rot-a") || seen[1].includes("rot-b"), false, "AC3b: stamped stuck rows are not re-selected in the next round (they rotate to the back)");
    assertEq(
      JSON.parse((db.prepare(`SELECT categories FROM agents WHERE id = 'rot-d'`).get() as any).categories).includes("honey"),
      true,
      "AC3b: the fixable row got corroborated categories written",
    );
    db.prepare(`DELETE FROM agent_knowledge`).run();
    db.prepare(`DELETE FROM agents`).run();

    // AC4 (gate) — named producers held only by the data-quality reasons.
    const goodProv = { about: [HP("x")], categories: [HP("honey")], products: [HP("Eplemost")] };
    seed("gate-generic", { cats: ["honey"], products: GENERIC, prov: goodProv });
    seed("gate-nocats", { cats: ["fish"], products: REAL, prov: { about: [HP("x")] } });
    seed("gate-ok", { cats: ["honey"], products: REAL, prov: goodProv });
    const router = aoc.default as any;
    const gate = callGateSync(router, { mode: "first", cooldown_days: "60" }, testKey);
    const ids = (gate.candidates || []).map((c: any) => c.agent_id);
    assertEq(ids, ["gate-ok"], "AC4: the suppression stands — only the clean row is a candidate");
    assertEq(
      (gate.data_quality_held?.producers || []).map((p: any) => [p.agent_id, p.reasons]).sort(),
      [["gate-generic", ["generic_products_only"]], ["gate-nocats", ["categories_not_corroborated"]]],
      "AC4: data_quality_held names the stopped rows with their reasons",
    );
    assertEq(gate.data_quality_held?.count, 2, "AC4: data_quality_held.count");
    const keys = Object.keys(gate);
    assertEq(keys[keys.length - 1], "data_quality_held", "AC4: the new field is the LAST key (existing order unchanged)");
    assertEq(
      [gate.suppressed_counts.generic_products_only, gate.suppressed_counts.categories_not_corroborated],
      [1, 1],
      "AC4: suppressed_counts unchanged",
    );
  } catch (err) {
    failed++;
    failures.push(`homepage-refresh-kategorinavn: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    if (prevParking === undefined) delete process.env.HOMEPAGE_PARKING_DISABLED;
    else process.env.HOMEPAGE_PARKING_DISABLED = prevParking;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runHomepageRefreshKategorinavnTests({ log: true }).then((r) => {
    console.log(`\nhomepage-refresh-kategorinavn: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
