/**
 * experiences-seo-forside-seksjonering.test.ts — route-level tests for
 * arbeidspunkt 1 of dev-request 2026-07-19-opplevagent-forside-seksjoner-
 * design (slice 6): "opplevelser" and "gårdssalg & smaking" as two clearly
 * distinct homepage sections.
 *
 * Covers:
 *   (a) Change A — the .cat-grid (experience-category grid, inside
 *       #kategorier) contains ZERO gårdssalg entries, in BOTH the
 *       dark-launch and live booking states: no synthetic card is injected
 *       any more, AND a genuine `experiences` row whose category literally
 *       is "gardssalg" / "gårdssalg" (the DB-literal-leak defensive path)
 *       is filtered out too — real experience categories still render
 *       normally.
 *   (b) Change B — the #drikkested section's CTA text is state-driven:
 *       dark-launch copy (never promises active booking) when no bookable
 *       provider exists yet OR the global dispatch switch is off; live
 *       ("booking-forward") copy only when BOTH a real (non-catalog_hidden)
 *       provider has booking_live=1 AND bookingDispatchEnabled() is true.
 *       Checked in both NO and EN.
 *   (c) countGardssalgProvidersBookable(): same WHERE gate as
 *       countGardssalgProviders() (catalog_hidden=1 excluded) plus
 *       booking_live=1 — a hidden test provider's booking_live=1 must never
 *       count.
 *
 * Same synthetic-req/res harness + in-memory-DB pattern as
 * experiences-seo-forside-drikkested.test.ts /
 * experiences-seo-gardssalg-card-consistency.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-forside-seksjonering.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoForsideSeksjoneringTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling forside/gårdssalg
// test files. `lang` mirrors what the /en rewrite middleware stamps on req.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// The #kategorier section (which wraps .cat-grid) is never nested inside
// another <section>, so slicing up to the FIRST </section> after the id
// attribute is a safe, dependency-free way to scope assertions to just the
// category grid without a full HTML parser.
function sectionSlice(html: string, id: string): string {
  const idx = html.indexOf(`id="${id}"`);
  if (idx < 0) return "";
  const closeIdx = html.indexOf("</section>", idx);
  return closeIdx < 0 ? html.slice(idx) : html.slice(idx, closeIdx);
}

// One raw-SQL provider insert — same column set as the sibling gårdssalg
// test files use (there is no service-layer setter for producer_type /
// booking_live / catalog_hidden).
function insertProvider(
  db: any,
  p: {
    id: string;
    navn: string;
    producer_type: string | null;
    booking_live?: number | null;
    catalog_hidden?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
        lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
     VALUES
       (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, ?, ?,
        60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`
  ).run(p.id, p.navn, p.producer_type, p.booking_live ?? null, p.catalog_hidden ?? null, p.id);
}

// A real, verified `experiences` row — the source .cat-grid actually reads
// (listCategories()). category="gardssalg"/"gårdssalg" fixtures exercise the
// DB-literal-leak defensive path (isGardssalgCategorySlug()); the others are
// plain real experience categories that must keep rendering normally.
function insertExperience(db: any, e: { id: string; title: string; category: string }): void {
  db.prepare(
    `INSERT INTO experiences (id, title, category, verification_status)
     VALUES (@id, @title, @category, 'verified')`
  ).run(e);
}

export function runExperiencesSeoForsideSeksjoneringTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, bookingStorePath, seoPath];

    // Fresh module graph + fresh :memory: DB per phase, same convention as
    // experiences-seo-forside-drikkested.test.ts's freshModules().
    function freshModules(): {
      db: any;
      store: typeof import("../services/experience-store");
      seo: typeof import("./experiences-seo");
      router: any;
    } {
      for (const p of cachePaths) delete require.cache[p];
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      return { db, store, seo, router: (seo as any).default };
    }

    // Fixture set shared by every phase: 5 gårdssalg providers (clears the
    // GARDSSALG_VISIBILITY_THRESHOLD=5 gate so #drikkested + gårdssalg
    // catSource-injection paths are both live) + 4 real experience
    // categories (2 of them ALSO literally named gardssalg/gårdssalg — the
    // defensive DB-literal-leak fixture) + 1 real, non-gårdssalg category
    // that must keep rendering.
    function seedBaseFixtures(db: any): void {
      insertProvider(db, { id: "fs-sideri-1", navn: "Eplelund Sideri", producer_type: "sideri" });
      insertProvider(db, { id: "fs-brygg-1", navn: "Liaberg Bryggeri", producer_type: "bryggeri" });
      insertProvider(db, { id: "fs-mjod-1", navn: "Vollen Mjøderi", producer_type: "mjøderi" });
      insertProvider(db, { id: "fs-cideri-1", navn: "Hagen Cideri", producer_type: "cideri" });
      insertProvider(db, { id: "fs-vin-1", navn: "Aashagen Vingård", producer_type: "vingård" });

      // Real experience categories the grid MUST keep showing.
      insertExperience(db, { id: "fs-exp-natur-1", title: "Guidet fjelltur", category: "natur_friluft" });
      insertExperience(db, { id: "fs-exp-natur-2", title: "Kajakktur", category: "natur_friluft" });
      insertExperience(db, { id: "fs-exp-kultur-1", title: "Museumsomvisning", category: "kultur_historie" });
      // Defensive DB-literal-leak fixtures: a real `experiences` row whose
      // category is literally the gårdssalg slug (both the ASCII and
      // accented spelling) — must NEVER surface in .cat-grid.
      insertExperience(db, { id: "fs-exp-gardssalg-1", title: "Gårdsbutikk-opplevelse", category: "gardssalg" });
      insertExperience(db, { id: "fs-exp-gardssalg-2", title: "Gårdsbutikk-opplevelse 2", category: "gårdssalg" });
    }

    try {
      // ════════════════════════════════════════════════════════════════
      // Phase A — dark-launch: 5 gårdssalg providers, NONE booking_live=1,
      // BOOKING_DISPATCH_ENABLED unset.
      // ════════════════════════════════════════════════════════════════
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const A = freshModules();
      seedBaseFixtures(A.db);

      const homeA = await callHtmlRoute(A.router, "/");
      assertTrue(homeA.handled && homeA.status === 200, `a1: GET / renders 200 in dark-launch state (got ${homeA.status})`);

      // ── Change A: .cat-grid has zero gårdssalg entries ─────────────────
      const catGridA = sectionSlice(homeA.body, "kategorier");
      assertTrue(catGridA.length > 0, "a2: sanity — the #kategorier section is present");
      assertTrue(!catGridA.includes('href="/kategori/gardssalg"'), "a3: no gårdssalg card link inside .cat-grid (dark-launch)");
      assertTrue(!catGridA.includes("Gårdssalg &amp; smaking") && !catGridA.includes("Gårdssalg & smaking"), "a4: no 'Gårdssalg & smaking' card label inside .cat-grid (dark-launch)");
      // Real categories still render normally.
      assertTrue(catGridA.includes(">Natur &amp; friluft<") || catGridA.includes(">Natur & friluft<"), "a5: a real experience category (Natur & friluft) still renders in the grid");
      assertTrue(catGridA.includes(">Kultur &amp; historie<") || catGridA.includes(">Kultur & historie<"), "a6: a second real experience category (Kultur & historie) still renders in the grid");

      // ── Change B: dark-launch CTA copy (NO) ────────────────────────────
      assertTrue(homeA.body.includes('id="drikkested"'), "a7: sanity — #drikkested section renders (≥5 providers clears the gate)");
      // Daniel 2026-08-24, punkt 2: the pre-booking CTA no longer says
      // «Meld interesse — åpner snart» (it read as "this vertical hasn't
      // launched" about a live, browsable catalog). Same state machine, new
      // pre-booking copy: it points at the catalog instead.
      assertTrue(homeA.body.includes(">Se alle drikkeprodusentene<"), "a8: pre-booking CTA text (NO) renders");
      assertTrue(!/åpner snart/.test(homeA.body), "a8b: no 'åpner snart' launch promise anywhere on the homepage");
      assertTrue(!homeA.body.includes(">Book besøk &amp; smaking<") && !homeA.body.includes(">Book besøk & smaking<"), "a9: live CTA text (NO) does NOT render in dark-launch state");

      // ── Change B: dark-launch CTA copy (EN) ────────────────────────────
      const homeAEn = await callHtmlRoute(A.router, "/", "en");
      assertTrue(homeAEn.handled && homeAEn.status === 200, `a10: GET / (en) renders 200 in dark-launch state (got ${homeAEn.status})`);
      assertTrue(homeAEn.body.includes(">Browse the drink producers<"), "a11: pre-booking CTA text (EN) renders");
      assertTrue(!/opening soon/i.test(homeAEn.body), "a11b: no 'opening soon' launch promise anywhere on the EN homepage");
      assertTrue(!homeAEn.body.includes(">Book a visit &amp; tasting<") && !homeAEn.body.includes(">Book a visit & tasting<"), "a12: live CTA text (EN) does NOT render in dark-launch state");

      // ════════════════════════════════════════════════════════════════
      // Phase B — dispatch ON but NO bookable provider yet: still
      // dark-launch (proves the AND, not OR, between the two gates).
      // ════════════════════════════════════════════════════════════════
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      const B = freshModules();
      seedBaseFixtures(B.db);
      // A catalog_hidden=1 provider with booking_live=1 must NOT count as
      // "bookable" — same convention as every other gårdssalg count.
      insertProvider(B.db, { id: "fs-hidden-live", navn: "Skjult Sideri", producer_type: "sideri", booking_live: 1, catalog_hidden: 1 });

      const homeB = await callHtmlRoute(B.router, "/");
      assertTrue(homeB.handled && homeB.status === 200, `b1: GET / renders 200 (dispatch on, no real bookable provider) (got ${homeB.status})`);
      assertTrue(homeB.body.includes(">Se alle drikkeprodusentene<"), "b2: still pre-booking copy — dispatch on alone is not enough");
      assertTrue(!homeB.body.includes(">Book besøk &amp; smaking<") && !homeB.body.includes(">Book besøk & smaking<"), "b3: live copy does not render just because dispatch is on");
      assertTrue(B.store.countGardssalgProvidersBookable() === 0, "b4: countGardssalgProvidersBookable() excludes the catalog_hidden=1 booking_live=1 row");

      // ── Change A still holds with dispatch on ──────────────────────────
      const catGridB = sectionSlice(homeB.body, "kategorier");
      assertTrue(!catGridB.includes('href="/kategori/gardssalg"'), "b5: no gårdssalg card link inside .cat-grid (dispatch on, still dark-launch)");

      // ════════════════════════════════════════════════════════════════
      // Phase C — live: dispatch ON + a REAL provider with booking_live=1.
      // ════════════════════════════════════════════════════════════════
      const C = freshModules();
      seedBaseFixtures(C.db);
      insertProvider(C.db, { id: "fs-live-1", navn: "Aktivert Bryggeri", producer_type: "bryggeri", booking_live: 1 });
      // Same hidden trap as phase B — must still not matter (though the
      // section is already live via fs-live-1, this pins the exclusion in
      // the "live" phase too).
      insertProvider(C.db, { id: "fs-hidden-live-2", navn: "Skjult Mjøderi", producer_type: "mjøderi", booking_live: 1, catalog_hidden: 1 });

      const homeC = await callHtmlRoute(C.router, "/");
      assertTrue(homeC.handled && homeC.status === 200, `c1: GET / renders 200 in live state (got ${homeC.status})`);
      assertTrue(homeC.body.includes(">Book besøk &amp; smaking<") || homeC.body.includes(">Book besøk & smaking<"), "c2: live CTA text (NO) renders");
      assertTrue(!homeC.body.includes(">Se alle drikkeprodusentene<"), "c3: pre-booking CTA text (NO) does NOT render in live state");
      assertTrue(C.store.countGardssalgProvidersBookable() === 1, "c4: countGardssalgProvidersBookable() counts exactly the 1 real booking_live=1 provider (hidden row excluded)");

      const homeCEn = await callHtmlRoute(C.router, "/", "en");
      assertTrue(homeCEn.handled && homeCEn.status === 200, `c5: GET / (en) renders 200 in live state (got ${homeCEn.status})`);
      assertTrue(homeCEn.body.includes(">Book a visit &amp; tasting<") || homeCEn.body.includes(">Book a visit & tasting<"), "c6: live CTA text (EN) renders");
      assertTrue(!homeCEn.body.includes(">Browse the drink producers<"), "c7: pre-booking CTA text (EN) does NOT render in live state");

      // ── Change A still holds in the live state ─────────────────────────
      const catGridC = sectionSlice(homeC.body, "kategorier");
      assertTrue(catGridC.length > 0, "c8: sanity — the #kategorier section is present (live state)");
      assertTrue(!catGridC.includes('href="/kategori/gardssalg"'), "c9: no gårdssalg card link inside .cat-grid (live state)");
      assertTrue(!catGridC.includes("Gårdssalg &amp; smaking") && !catGridC.includes("Gårdssalg & smaking"), "c10: no 'Gårdssalg & smaking' card label inside .cat-grid (live state)");
      assertTrue(catGridC.includes(">Natur &amp; friluft<") || catGridC.includes(">Natur & friluft<"), "c11: real experience categories still render in the grid (live state)");

      // The CTA still links to /kategori/gardssalg either way (only the
      // label changes, never the target) — same convention as the per-card
      // CTA in experiences-seo-gardssalg-card-consistency.test.ts.
      assertTrue(/<a class="drikkested-cta" href="\/kategori\/gardssalg">/.test(homeC.body), "c12: the #drikkested CTA still links to /kategori/gardssalg in the live state");
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-forside-seksjonering: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevBookingDispatchEnabled === undefined) {
        delete process.env.BOOKING_DISPATCH_ENABLED;
      } else {
        process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoForsideSeksjoneringTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit on success too: requiring the seo route module leaves
    // live handles (email-service/counter timers) on the event loop, so a
    // fully green standalone run would otherwise hang instead of exiting.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
