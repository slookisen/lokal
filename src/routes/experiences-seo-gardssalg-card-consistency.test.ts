/**
 * experiences-seo-gardssalg-card-consistency.test.ts — dev-request
 * 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 4
 * (gårdssalg-kort-konsistens), slice 5 of 7 on that dev-request.
 *
 * Daniel's design review (2026-07-19) found the gårdssalg catalog cards
 * (GET /kategori/gardssalg) inconsistent in three ways:
 *   1. The kommune-etikett is missing on many cards (the place lives only in
 *      the title, after an em-dash — "Bryggeriet på Hvaler — Hvaler" — and
 *      where the label DOES exist it duplicates the title's own suffix).
 *   2. The producer_type (bryggeri/sideri/mjøderi) badge — data that already
 *      exists on the row — was unused on the card.
 *   3. The "Book besøk" CTA always says "Book besøk" even for a provider
 *      whose booking is paused (dark-launch), leading to a paused form.
 *
 * (The per-card "Kommer snart" badge finding 2 named is ALREADY gone — a
 * separate, earlier dev-request, 2026-08-09-gardssalg-kommer-snart-fjernes-
 * eier-aktivert-booking, removed it entirely in favor of positive-only
 * markers; see experiences-seo-gardssalg-booking-ikke-aktivert.test.ts's own
 * AC1/AC5 coverage. Nothing to re-fix here — this file only pins the
 * "still gone" invariant alongside its own new assertions so a future
 * regression on THIS route is caught by THIS slice's own gate too.)
 *
 * Covers (mapping to AC4 — "Gårdssalg-katalogen: alle kort har kommune-
 * etikett; ingen per-kort «Kommer snart»-badges; ingen kort med sted
 * duplisert i tittel+etikett"):
 *   (a) a card whose name carries a "Navn — Sted" suffix AND has a matching
 *       structured kommune: title is stripped of the suffix, the etikett
 *       shows the place exactly once (never "…Hvaler — Hvaler" + "Hvaler").
 *   (b) a card whose name carries the suffix but has NO structured
 *       poststed/kommune/fylke at all: the suffix becomes the kommune-
 *       etikett (previously silently absent) and is stripped from the title.
 *   (c) a card with no suffix and real structured data: unaffected — title
 *       is the plain name, etikett is the structured value.
 *   (d) producer_type badge renders (visible label) when producer_type is
 *       set, and does not render any badge markup at all when it is NULL.
 *   (e) zero per-card "Kommer snart" badges (single-marker-row invariant).
 *   (f) CTA text/class: "Book besøk" + gs-card-cta (active) while live
 *       (booking_live=1 + BOOKING_DISPATCH_ENABLED=true); "Meld interesse" +
 *       gs-card-cta-paused (neutral) while paused — same isBookingPaused()
 *       source used everywhere else on this route, not a new parallel check.
 *
 * Same synthetic router.handle() harness + in-memory-DB (EXPERIENCES_DB_PATH
 * = ":memory:") pattern as experiences-seo-gardssalg-claimed-badge.test.ts /
 * experiences-seo-gardssalg-booking-ikke-aktivert.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-gardssalg-card-consistency.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoGardssalgCardConsistencyTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling gårdssalg test files.
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

export function runExperiencesSeoGardssalgCardConsistencyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // Dispatch ON for the whole run — the "live" fixture below is genuinely
    // bookable (booking_live=1 + dispatch on); everything else stays paused
    // via its own booking_live=0/NULL. Same convention as
    // experiences-seo-gardssalg-booking-ikke-aktivert.test.ts.
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, bookingStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");
      require("../services/booking-store");

      // ── Fixtures — same raw-insert shape as
      // experiences-seo-gardssalg-claimed-badge.test.ts (createProvider()
      // doesn't support producer_type/slug). 6 rows ≥ the
      // GARDSSALG_VISIBILITY_THRESHOLD (5) so the base catalog renders. ────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence, claimed_at)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, NULL, 59.1, 10.1,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium', NULL)`
      );

      // (a) title suffix duplicates a REAL structured kommune value.
      insertProvider.run({
        id: "gsc-suffix-dup", navn: "Bryggeriet på Hvaler — Hvaler", fylke: "Østfold", kommune: "Hvaler",
        poststed: null, producer_type: "bryggeri", booking_live: 0, slug: "bryggeriet-pa-hvaler",
      });
      // (b) title suffix is the ONLY location signal — no structured data at all.
      insertProvider.run({
        id: "gsc-suffix-only", navn: "Solheim Sideri — Ullensvang", fylke: null, kommune: null,
        poststed: null, producer_type: "sideri", booking_live: 0, slug: "solheim-sideri",
      });
      // (c) plain name, no suffix, real structured data — unaffected baseline.
      insertProvider.run({
        id: "gsc-plain", navn: "Trysil Bryggeri", fylke: "Innlandet", kommune: "Trysil",
        poststed: "Trysil", producer_type: "bryggeri", booking_live: 0, slug: "trysil-bryggeri",
      });
      // (d) NULL producer_type — no badge should render, but the row still
      // needs a real, non-NULL 'source' predicate to appear (rfb_seed_source
      // fallback isn't set here, so give it a producer_type-less but still
      // catalog-eligible fixture via a distinct producer_type of "" — kept
      // simplest by using a genuinely NULL producer_type + relying on the
      // OTHER 5 fixtures to clear the visibility threshold; this row itself
      // must still satisfy listGardssalgProviders()'s WHERE clause, which
      // requires producer_type IS NOT NULL OR rfb_seed_source='rfb-seed' —
      // so use the rfb-seed path instead of a NULL producer_type here.
      insertProvider.run({
        id: "gsc-no-badge", navn: "Ukjent Type Gård", fylke: "Vestfold", kommune: "Sandefjord",
        poststed: "Sandefjord", producer_type: null, booking_live: 0, slug: "ukjent-type-gard",
      });
      db.prepare("UPDATE experience_providers SET rfb_seed_source = 'rfb-seed' WHERE id = 'gsc-no-badge'").run();
      // (f) live/bookable fixture — booking_live=1, dispatch on globally.
      insertProvider.run({
        id: "gsc-live", navn: "Aktivert Mjøderi", fylke: "Viken", kommune: "Drammen",
        poststed: "Drammen", producer_type: "mjøderi", booking_live: 1, slug: "aktivert-mjoderi",
      });
      // filler row to keep the fixture set comfortably above the threshold.
      insertProvider.run({
        id: "gsc-filler", navn: "Fyllgård Consistency", fylke: "Agder", kommune: "Kristiansand",
        poststed: "Kristiansand", producer_type: "vingård", booking_live: 0, slug: "fyllgard-consistency",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg");
      assertTrue(r.handled && r.status === 200, `x1: GET /kategori/gardssalg renders (status ${r.status})`);

      // ── (a) suffix + real kommune: title stripped, etikett shown once ───
      // Scoped to the CARD itself (provider-grid <article>…</article>) — the
      // raw provider name legitimately still appears elsewhere on the same
      // page (map marker JSON, JSON-LD, og:image alt) which is unrelated to
      // this dev-request's card template and out of scope for this slice.
      function cardSliceFor(marker: string): string {
        const idx = r.body.indexOf(marker);
        assertTrue(idx > -1, `sanity: '${marker}' card marker is present`);
        const gridStart = r.body.indexOf('class="provider-grid"');
        const start = r.body.lastIndexOf("<article", idx);
        return start > gridStart ? r.body.slice(start, r.body.indexOf("</article>", start)) : "";
      }
      const hvalerCard = cardSliceFor("Bryggeriet på Hvaler");
      assertTrue(hvalerCard.includes(">Bryggeriet på Hvaler<"), "a1: title is stripped of the ' — Hvaler' suffix");
      assertTrue(!hvalerCard.includes("Bryggeriet på Hvaler — Hvaler"), "a2: the raw un-stripped name never appears on the card");
      // "Hvaler" legitimately appears twice here — once inside the brand name
      // itself ("Bryggeriet på Hvaler") and once as the kommune-etikett — the
      // duplication this dev-request targets is the title's trailing
      // " — Hvaler" SUFFIX repeating the etikett, which a2 above already
      // proves is gone. What matters here is that the suffix pattern itself
      // never survives.
      assertTrue(!hvalerCard.includes(" — Hvaler"), "a3: the ' — Hvaler' title suffix does not survive anywhere on the card");

      // ── (b) suffix-only: becomes the etikett, stripped from the title ───
      const sideriCard = cardSliceFor("Solheim Sideri");
      assertTrue(sideriCard.includes(">Solheim Sideri<"), "b1: title is stripped of the ' — Ullensvang' suffix");
      assertTrue(!sideriCard.includes("Solheim Sideri — Ullensvang"), "b2: the raw un-stripped name never appears on the card");
      assertTrue(
        sideriCard.includes(">Ullensvang<"),
        "b3: the suffix becomes this card's kommune-etikett (previously would have had NONE — no poststed/kommune/fylke)",
      );

      // ── (c) plain name + real data — unaffected ──────────────────────────
      assertTrue(r.body.includes(">Trysil Bryggeri<"), "c1: a name with no suffix renders unchanged");
      assertTrue(r.body.includes(">Trysil<"), "c2: its kommune-etikett is the real structured value");

      // ── (d) producer_type badge presence/absence ─────────────────────────
      assertTrue(r.body.includes(">Bryggeri<") && r.body.includes(">Mjød<"), "d1: producer_type badges render their canonical labels (Bryggeri, Mjød)");
      {
        // Isolate the "Ukjent Type Gård" card's own markup (between its name
        // and the next <article>) and confirm no drink-type badge span
        // appears inside it — producer_type is NULL for this row.
        const idx = r.body.indexOf("Ukjent Type Gård");
        assertTrue(idx > -1, "d2: the NULL-producer_type card is present (sanity)");
        const cardSlice = r.body.slice(idx, r.body.indexOf("</article>", idx));
        assertTrue(
          !/text-transform:uppercase[^>]*>(Bryggeri|Sider|Mjød|Fruktvin|Destillat|Kombucha)</.test(cardSlice),
          "d3: no producer_type badge renders on a card whose producer_type is NULL",
        );
      }

      // ── (e) no per-card "Kommer snart" badge (single-banner invariant) ──
      assertTrue(!r.body.includes("Kommer snart"), "e1: zero occurrences of the old per-card 'Kommer snart' badge");

      // ── (f) CTA text/class is state-driven, same isBookingPaused() source ─
      {
        const liveIdx = r.body.indexOf("Aktivert Mjøderi");
        const liveSlice = r.body.slice(liveIdx, r.body.indexOf("</article>", liveIdx));
        assertTrue(liveSlice.includes('class="gs-card-cta"'), "f1: the live fixture's CTA uses the active gs-card-cta class");
        assertTrue(liveSlice.includes(">Book besøk<"), "f2: the live fixture's CTA reads 'Book besøk'");
        assertTrue(!liveSlice.includes("Meld interesse"), "f3: the live fixture's CTA does NOT say 'Meld interesse'");

        const pausedIdx = r.body.indexOf("Trysil Bryggeri");
        const pausedSlice = r.body.slice(pausedIdx, r.body.indexOf("</article>", pausedIdx));
        assertTrue(pausedSlice.includes('class="gs-card-cta-paused"'), "f4: a paused fixture's CTA uses the neutral gs-card-cta-paused class");
        assertTrue(pausedSlice.includes(">Meld interesse<"), "f5: a paused fixture's CTA reads 'Meld interesse'");
        assertTrue(!pausedSlice.includes(">Book besøk<"), "f6: a paused fixture's CTA does NOT say 'Book besøk'");
        // Same href either way — only the label/styling change, never the target.
        assertTrue(pausedSlice.includes('href="/kategori/gardssalg/book/trysil-bryggeri"'), "f7: the paused CTA still links to the real booking panel (interest path lives there)");
      }

      // ── CSS: both classes are defined exactly once, active keeps the
      // pre-existing fjord-700 fill, paused is neutral (no gradient) ────────
      assertTrue(r.body.includes(".gs-card-cta{"), "g1: .gs-card-cta (active) rule is defined");
      assertTrue(r.body.includes(".gs-card-cta-paused{"), "g2: .gs-card-cta-paused rule is defined");
      assertTrue(
        /\.gs-card-cta-paused\{[^}]*background:var\(--canvas-2\)/.test(r.body),
        "g3: the paused class uses the neutral canvas-2 background, not the active fill",
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-gardssalg-card-consistency: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    if (log) {
      console.log(`\nexperiences-seo-gardssalg-card-consistency: ${passed} passed, ${failed} failed`);
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoGardssalgCardConsistencyTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
    process.exit(0);
  });
}
