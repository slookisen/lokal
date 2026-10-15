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
 *   AC5  categoriesCorroborateOnly (the nightly R6 job's option): a non-empty,
 *        uncorroborated stored category list is corroborated (provenance only,
 *        list unchanged) when the page supports every stored category, else
 *        left alone with a categories_not_supported_by_homepage reason: partial
 *        support, a directory/social/own-domain homepage (also after a
 *        redirect), a wrong-entity site, unreadable field_provenance, a
 *        theme-spam summary, an unmapped stored value ("other"), a known
 *        hijacked or unparseable host. Stored values compare case-insensitively;
 *        a non-platform key (berries) needs that same keyword on the page, not
 *        just its platform category; the provenance source_url is the final URL. Empty stored categories,
 *        the curated lock and every caller without the option behave as before.
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

    // AC3b — rows the refresh cannot fix do not stick at the front. Stuck rows
    // (no-write, transient fetch failure, theme-spam page) are stamped in
    // homepage_content_checked_at and rotate to the back; the fixable row is
    // reached; updated_at is never touched without a data change.
    const stuckHtml = `<html><head><title>Tom</title></head><body><p>Velkommen.</p></body></html>`;
    const spamHtml =
      `<html><head><title>Beste norske casino 2026</title><meta property="og:description" content="Casino bonus og free spins"></head>` +
      `<body><h1>Beste norske casino 2026</h1><p>Spill casino med velkomstbonus.</p></body></html>`;
    const pages: Record<string, string> = {};
    const order = ["rot-a", "rot-b", "rot-c", "rot-e", "rot-d"];
    order.forEach((id, i) => {
      seed(id, { cats: ["fish"], products: REAL, prov: aboutHp, updated: `2020-02-0${i + 1}T00:00:00.000Z` });
      pages[`${id}.kat-test.no`] = id === "rot-d" ? HOME_HTML : id === "rot-e" ? spamHtml : stuckHtml;
    });
    const rotFetch = async (url: string) => {
      const host = new URL(url).host;
      if (host.startsWith("rot-c")) {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }
      return new Response(pages[host] ?? "", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const updatedBefore = Object.fromEntries(
      order.map((id) => [id, (db.prepare(`SELECT updated_at FROM agent_knowledge WHERE agent_id = ?`).get(id) as any).updated_at]),
    );
    const seen: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const targets = mod.selectHomepageContentRefreshAutoTargets(db as any, 2);
      seen.push(targets.map((t) => t.agent_id));
      if (targets.length === 0) break;
      await mod.refreshHomepageContent(db as any, targets, { dryRun: false, fetchImpl: rotFetch as any });
    }
    assertEq(seen[0], ["rot-a", "rot-b"], "AC3b: round 1 takes the front of the queue (no-write rows)");
    assertEq(seen[1], ["rot-c", "rot-e"], "AC3b: round 2 takes the transient-failure row and the theme-spam row (stamped rows moved back)");
    assertEq(seen[2].includes("rot-d"), true, "AC3b: round 3 reaches the fixable row, after all stuck kinds were attempted once");
    assertEq(
      JSON.parse((db.prepare(`SELECT categories FROM agents WHERE id = 'rot-d'`).get() as any).categories).includes("honey"),
      true,
      "AC3b: the fixable row got corroborated categories written",
    );
    const stuckAfter = Object.fromEntries(
      ["rot-a", "rot-b", "rot-c", "rot-e"].map((id) => [id, (db.prepare(`SELECT updated_at, homepage_content_checked_at AS c FROM agent_knowledge WHERE agent_id = ?`).get(id) as any)]),
    );
    assertEq(
      ["rot-a", "rot-b", "rot-c", "rot-e"].map((id) => stuckAfter[id].updated_at === updatedBefore[id]),
      [true, true, true, true],
      "AC3b: updated_at is unchanged on every no-write / failed / spam attempt",
    );
    assertEq(
      ["rot-a", "rot-b", "rot-c", "rot-e"].map((id) => !!stuckAfter[id].c),
      [true, true, true, true],
      "AC3b: homepage_content_checked_at is stamped for no-write, transient failure and theme-spam",
    );
    // dry run stamps nothing
    seed("rot-dry", { cats: ["fish"], products: REAL, prov: aboutHp });
    pages["rot-dry.kat-test.no"] = stuckHtml;
    await mod.refreshHomepageContent(
      db as any,
      [{ agent_id: "rot-dry", name: "x", homepage_url: "https://rot-dry.kat-test.no" }] as any,
      { dryRun: true, fetchImpl: rotFetch as any },
    );
    assertEq(
      (db.prepare(`SELECT homepage_content_checked_at AS c FROM agent_knowledge WHERE agent_id = 'rot-dry'`).get() as any).c,
      null,
      "AC3b: a dry run stamps nothing",
    );
    db.prepare(`DELETE FROM agent_knowledge`).run();
    db.prepare(`DELETE FROM agents`).run();

    // AC5 — categoriesCorroborateOnly (the nightly R6 job's option): a
    // non-empty, uncorroborated stored category list is never replaced by the
    // page's keyword extraction. The page below extracts [meat, vegetables, honey].
    const cvs = require("../services/cross-source-validator") as typeof import("../services/cross-source-validator");
    const CORR_HTML =
      `<html><head><title>Grønt Gård</title><meta property="og:description" content="${PAGE_ABOUT}"></head>` +
      `<body><h1>Grønt Gård</h1><p>Vi selger grønnsaker, honning og lammekjøtt rett fra gården.</p></body></html>`;
    // Same categories, but the about summary carries a gambling term (the
    // candidate-level theme-spam rejection; the page as a whole is not spam).
    const SPAM_SUMMARY_HTML =
      `<html><head><title>Grønt Gård</title></head><body><h1>Grønt Gård</h1>` +
      `<p>Vi selger grønnsaker, honning og lammekjøtt rett fra gården, og spiller casino med gjestene hver helg.</p></body></html>`;
    // Names berries: product keywords [fruit, berries] → platform [fruit].
    // (The lexicon's berry keywords match "berries", not the accented "bær",
    // which its accent folding turns into "baer".)
    const BERRIES_HTML =
      `<html><head><title>Bær Gård</title></head><body><h1>Bær Gård</h1>` +
      `<p>Vi selger bær (berries), epler og plommer rett fra gården.</p></body></html>`;
    // Apples only: product keywords [fruit] → platform [fruit]; no berries.
    const APPLES_HTML =
      `<html><head><title>Eple Gård</title></head><body><h1>Eple Gård</h1>` +
      `<p>Vi selger epler og plommer rett fra gården.</p></body></html>`;
    // Requested host → final URL after a redirect (fetchPage reads resp.url).
    const REDIRECTS: Record<string, string> = {
      "c-redir-bad.kat-test.no": "https://www.facebook.com/c-redir-bad",
      "c-redir-ok.kat-test.no": "https://www.c-redir-ok-ny.no/",
      "c-unparse.kat-test.no": "https:///no-host",
    };
    const corrFetch = async (url: string) => {
      const host = new URL(url).host;
      const html = host.startsWith("c-spam")
        ? SPAM_SUMMARY_HTML
        : host.startsWith("c-berries")
          ? BERRIES_HTML
          : host.startsWith("c-apples")
            ? APPLES_HTML
            : CORR_HTML;
      const resp = new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (REDIRECTS[host]) Object.defineProperty(resp, "url", { value: REDIRECTS[host] });
      return resp;
    };
    const gpProv = { about: [GP(OLD_ABOUT)], categories: [GP("vegetables")] };
    seed("c-veg", { cats: ["vegetables"], products: REAL, prov: gpProv });
    seed("c-fruit", { cats: ["fruit", "berries"], products: REAL, prov: gpProv });
    seed("c-empty", { cats: null, products: REAL, prov: { about: [GP(OLD_ABOUT)] } });
    seed("c-locked", { cats: ["vegetables"], products: REAL, prov: gpProv });
    db.prepare(`UPDATE agent_knowledge SET curated_fields = '{"categories":true}' WHERE agent_id = 'c-locked'`).run();
    seed("c-noopt", { cats: ["vegetables"], products: REAL, prov: gpProv });
    seed("c-wrongent", { cats: ["vegetables"], products: REAL, prov: { ...gpProv, website_ownership: { status: "unverified" } } });
    seed("c-spam", { cats: ["vegetables"], products: REAL, prov: gpProv });
    seed("c-partial", { cats: ["vegetables", "fruit"], products: REAL, prov: gpProv });
    seed("c-case", { cats: ["Vegetables"], products: REAL, prov: gpProv });
    seed("c-berries", { cats: ["berries"], products: REAL, prov: gpProv });
    seed("c-other", { cats: ["vegetables", "other"], products: REAL, prov: gpProv });
    seed("c-badprov", { cats: ["vegetables"], products: REAL, prov: gpProv });
    db.prepare(`UPDATE agent_knowledge SET field_provenance = '{not json' WHERE agent_id = 'c-badprov'`).run();
    seed("c-apples", { cats: ["berries"], products: REAL, prov: gpProv });
    for (const id of ["c-fb", "c-dir", "c-own", "c-redir-bad", "c-redir-ok", "c-hijacked", "c-unparse"]) {
      seed(id, { cats: ["vegetables"], products: REAL, prov: gpProv });
    }
    // Homepages on a social / directory host and on our own domain.
    const HOSTED: Record<string, string> = {
      "c-fb": "https://www.facebook.com/c-fb",
      "c-dir": "https://www.1881.no/c-dir",
      "c-own": "https://rettfrabonden.com/produsent/c-own",
      "c-hijacked": "https://storbuktgard.no/",
    };
    const tgt = (id: string) => ({ agent_id: id, name: `Gård ${id}`, homepage_url: HOSTED[id] ?? `https://${id}.kat-test.no` });
    const catsOf = (id: string) => (db.prepare(`SELECT categories FROM agents WHERE id = ?`).get(id) as any).categories;
    const provOf = (id: string) =>
      (db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any).field_provenance;
    const aboutOf = (id: string) => (db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(id) as any).about;
    assertEq(
      ["c-veg", "c-fruit", "c-locked", "c-noopt"].map((id) => cvs.categoriesLackWebsiteCorroboration(catsOf(id), provOf(id))),
      [true, true, true, true],
      "AC5 fixture: the stored categories are held by the gate (categories_not_corroborated)",
    );
    const corr = await mod.refreshHomepageContent(
      db as any,
      [
        "c-veg", "c-fruit", "c-empty", "c-locked", "c-wrongent", "c-spam", "c-partial", "c-case", "c-berries",
        "c-other", "c-badprov", "c-fb", "c-dir", "c-own", "c-redir-bad", "c-redir-ok", "c-apples", "c-hijacked",
        "c-unparse",
      ].map(tgt) as any,
      { dryRun: false, fetchImpl: corrFetch as any, categoriesCorroborateOnly: true },
    );
    const noopt = await mod.refreshHomepageContent(db as any, [tgt("c-noopt")] as any, {
      dryRun: false,
      fetchImpl: corrFetch as any,
    });
    const changedOf = (r: typeof corr, id: string) => r.changed.find((c) => c.agent_id === id)?.fields ?? [];

    // corroborated: list unchanged, homepage source added, gate passes
    assertEq(JSON.parse(catsOf("c-veg")), ["vegetables"], "AC5 corroborate: stored [vegetables] stays exactly [vegetables] (meat/honey from the page NOT added)");
    const vegCat = JSON.parse(provOf("c-veg")).categories as any[];
    const vegHp = vegCat.filter((r) => r.source_type === "website_homepage");
    assertEq(
      vegHp.map((r) => [r.value, r.source_url, typeof r.fetched_at]),
      [["vegetables", "https://c-veg.kat-test.no", "string"]],
      "AC5 corroborate: one website_homepage provenance record for the stored value, with the page source_url",
    );
    assertEq(vegCat.length, 2, "AC5 corroborate: the earlier google_places record is kept (merge, not replace)");
    assertEq(cvs.categoriesLackWebsiteCorroboration(catsOf("c-veg"), provOf("c-veg")), false, "AC5 corroborate: the row now passes the gate's categories test");
    assertEq(changedOf(corr, "c-veg").includes(mod.HCR_CATEGORIES_CORROBORATED), true, "AC5 corroborate: reported as categories_corroborated in changed[].fields");
    assertEq(changedOf(corr, "c-veg").includes("categories"), false, "AC5 corroborate: NOT reported as a categories column write");

    // not supported: nothing written for categories, reason recorded, gate holds
    assertEq(JSON.parse(catsOf("c-fruit")), ["fruit", "berries"], "AC5 not supported: stored [fruit, berries] unchanged");
    assertEq(
      (JSON.parse(provOf("c-fruit")).categories as any[]).map((r) => r.source_type),
      ["google_places"],
      "AC5 not supported: no categories provenance added",
    );
    assertEq(cvs.categoriesLackWebsiteCorroboration(catsOf("c-fruit"), provOf("c-fruit")), true, "AC5 not supported: the gate still holds the row");
    const fruitReason = corr.skipped_unsubstantiated.find((s) => s.agent_id === "c-fruit")?.reason ?? "";
    assertEq(
      [fruitReason.startsWith(mod.HCR_CATEGORIES_NOT_SUPPORTED), fruitReason.includes("fruit,berries"), fruitReason.includes("meat,vegetables,honey")],
      [true, true, true],
      "AC5 not supported: skip reason categories_not_supported_by_homepage with stored and page categories",
    );
    assertEq(
      changedOf(corr, "c-fruit").some((f) => f === "categories" || f === mod.HCR_CATEGORIES_CORROBORATED),
      false,
      "AC5 not supported: nothing reported written for categories",
    );

    // empty stored categories: today's behaviour (the page's categories are written)
    assertEq(JSON.parse(catsOf("c-empty")), ["meat", "vegetables", "honey"], "AC5 empty stored: categories written from the page as today");
    assertEq(
      (JSON.parse(provOf("c-empty")).categories as any[]).map((r) => [r.source_type, r.value]),
      [["website_homepage", "meat,vegetables,honey"]],
      "AC5 empty stored: website_homepage provenance as today",
    );
    assertEq(changedOf(corr, "c-empty").includes("categories"), true, "AC5 empty stored: reported as a categories write as today");

    // the curated lock still wins
    assertEq(
      [JSON.parse(catsOf("c-locked")), (JSON.parse(provOf("c-locked")).categories as any[]).length],
      [["vegetables"], 1],
      "AC5 curated lock: nothing written for categories",
    );
    assertEq(
      corr.skipped_curated.find((s) => s.agent_id === "c-locked")?.fields,
      ["categories"],
      "AC5 curated lock: reported in skipped_curated",
    );

    // a wrong-entity site / a theme-spam summary never corroborates
    for (const [id, why] of [["c-wrongent", "website ownership unverified"], ["c-spam", "homepage summary reads as theme spam"]] as const) {
      const reasons = corr.skipped_unsubstantiated.filter((x) => x.agent_id === id).map((x) => x.reason);
      assertEq(
        [JSON.parse(catsOf(id)), (JSON.parse(provOf(id)).categories as any[]).map((r) => r.source_type)],
        [["vegetables"], ["google_places"]],
        `AC5 ${id}: nothing written for categories although the page lists every stored category`,
      );
      assertEq(
        reasons.some((r) => r.startsWith(mod.HCR_CATEGORIES_NOT_SUPPORTED) && r.includes(why)),
        true,
        `AC5 ${id}: reported as ${mod.HCR_CATEGORIES_NOT_SUPPORTED} (${why})`,
      );
    }
    assertEq(
      corr.skipped_unsubstantiated.find((x) => x.agent_id === "c-spam")?.reason,
      mod.HCR_THEME_SPAM_CANDIDATE_REASON,
      "AC5 c-spam: the theme-spam reason stays first (the morning send's hijacked check reads the first one)",
    );

    // review B1/B2/N1/N3/N4 — refusals: nothing written for categories, exact reason
    const catReason = (id: string) =>
      corr.skipped_unsubstantiated.find((x) => x.agent_id === id && x.reason.startsWith(mod.HCR_CATEGORIES_NOT_SUPPORTED))?.reason;
    const hasHpCats = (id: string) => {
      try {
        return JSON.stringify(JSON.parse(provOf(id)).categories ?? null).includes("website_homepage");
      } catch {
        return false;
      }
    };
    const refusals: Array<[string, string, unknown[], string]> = [
      ["c-partial", "stored: vegetables,fruit; homepage: meat,vegetables,honey", ["vegetables", "fruit"], "B2 partial support ([vegetables, fruit] vs page [meat, vegetables, honey]) — every stored category must be on the page, not some"],
      ["c-fb", "directory/social host", ["vegetables"], "B1 social-media homepage (facebook.com)"],
      ["c-dir", "directory/social host", ["vegetables"], "B1 directory homepage (1881.no)"],
      ["c-own", "own platform domain", ["vegetables"], "B1 our own platform domain"],
      ["c-redir-bad", "directory/social host", ["vegetables"], "N1 a redirect that lands on a social-media host"],
      ["c-other", "unmapped stored category: other", ["vegetables", "other"], "N3 a stored value that maps to no platform key (other)"],
      ["c-badprov", "unreadable field_provenance", ["vegetables"], "N4 unreadable field_provenance fails closed"],
      ["c-apples", "stored: berries; homepage: fruit; page keywords: fruit", ["berries"], "round 2 N1: stored [berries] on a page that only names apples (fruit on the page, berries not)"],
      ["c-hijacked", "known hijacked host", ["vegetables"], "round 2 N2: a known hijacked domain (storbuktgard.no)"],
      ["c-unparse", "unparseable host", ["vegetables"], "round 2 N2: a final URL whose host cannot be read"],
    ];
    for (const [id, why, storedCats, label] of refusals) {
      assertEq(
        [catReason(id), JSON.parse(catsOf(id)), hasHpCats(id), changedOf(corr, id).includes(mod.HCR_CATEGORIES_CORROBORATED)],
        [`${mod.HCR_CATEGORIES_NOT_SUPPORTED} (${why})`, storedCats, false, false],
        `AC5 ${label}: nothing written for categories, reason recorded`,
      );
    }
    assertEq(cvs.categoriesLackWebsiteCorroboration(catsOf("c-partial"), provOf("c-partial")), true, "AC5 B2: the partially supported row is still held by the gate");

    // review N1/N3 + casing — corroborated, stored value never rewritten
    const corroborated: Array<[string, string, string, string]> = [
      ["c-case", '["Vegetables"]', "Vegetables", "https://c-case.kat-test.no"],
      ["c-berries", '["berries"]', "berries", "https://c-berries.kat-test.no"],
      ["c-redir-ok", '["vegetables"]', "vegetables", "https://www.c-redir-ok-ny.no/"],
    ];
    for (const [id, col, val, url] of corroborated) {
      const hpRecs = (JSON.parse(provOf(id)).categories as any[]).filter((r) => r.source_type === "website_homepage");
      assertEq(
        [catsOf(id), hpRecs.map((r) => [r.value, r.source_url]), cvs.categoriesLackWebsiteCorroboration(catsOf(id), provOf(id))],
        [col, [[val, url]], false],
        `AC5 ${id}: corroborated (${id === "c-case" ? "stored casing compared case-insensitively" : id === "c-berries" ? "stored berries on a page that names berries" : "source_url is the final URL after a same-owner redirect"}); stored column byte-identical`,
      );
    }

    // without the option (route / morning send): replacement exactly as before
    assertEq(JSON.parse(catsOf("c-noopt")), ["meat", "vegetables", "honey"], "AC5 regression: WITHOUT the option the stored categories are still replaced");
    assertEq(changedOf(noopt, "c-noopt").includes("categories"), true, "AC5 regression: reported as a categories write");
    assertEq(
      noopt.skipped_unsubstantiated.some((s) => s.reason.startsWith(mod.HCR_CATEGORIES_NOT_SUPPORTED)),
      false,
      "AC5 regression: no corroboration reason without the option",
    );
    // other fields: same as without the option
    assertEq([aboutOf("c-veg"), aboutOf("c-noopt")], [PAGE_ABOUT, PAGE_ABOUT], "AC5: about is written the same with and without the option");
    assertEq(
      [corr.by_field.categories, noopt.by_field.categories],
      [1, 1],
      "AC5: by_field.categories counts only real column writes (c-empty / c-noopt)",
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
