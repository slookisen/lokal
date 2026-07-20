/**
 * opplevelser-gardssalg-navstoy-heuristikk.test.ts — tests for dev-request
 * 2026-07-20-gardssalg-navstoy-duplikatfelt-heuristikk:
 *
 *   - gardssalgIsNavPolluted() / gardssalgMeetsQualityBar() (src/services/
 *     experience-store.ts) — nav-menu-vocabulary contamination heuristic
 *   - applyGardssalgProviderContent()'s duplicate-block guard — never writes
 *     the same raw candidate to both about_text and visit_text in one pass
 *   - evaluateGardssalgContentQuality() / selectGardssalgProvidersForQualityScan()
 *     / applyGardssalgContentQualityFixes() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-content-quality-scan (src/routes/opplevelser.ts)
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle() with X-Admin-Key via headers).
 *
 * Covers:
 *   (a) the real Draopar pattern (nav tokens glued in front of one real
 *       sentence) is flagged nav-polluted
 *   (b) genuine Norwegian prose — including the passive-voice Title-Case
 *       product-list shape this codebase already had to specifically NOT
 *       reject (search-enrich.ts round-2 fix-up) — is NOT flagged
 *   (c) a single incidental nav-word mention (e.g. "meny", "Åpningstider")
 *       is NOT enough to flag (requires >=2 distinct nav words)
 *   (d) applyGardssalgProviderContent never duplicates one raw block into
 *       both about_text and visit_text — about_text wins, visit_text stays
 *       blank
 *   (e) evaluateGardssalgContentQuality flags nav-polluted fields AND
 *       byte-identical about/visit duplicates (visit_text only, unless
 *       about_text is independently nav-polluted too)
 *   (f) selectGardssalgProvidersForQualityScan includes catalog_hidden=1
 *       rows and excludes manual/claim-locked rows
 *   (g) POST .../gardssalg-content-quality-scan dry-run reports flags with
 *       zero writes; apply=true nulls the flagged fields via the existing
 *       audit/provenance path and resets last_content_attempt_at (re-queue);
 *       manual/claim rows are never touched; 403 unauthenticated
 *   (h) end-to-end: POST /admin/gardssalg-content-refresh's REAL crawl path
 *       (mocked fetch, og:description = the real Draopar text) never fills
 *       a blank about_text with nav-polluted content — the critical review
 *       round-2 finding, verified at the actual production call site, not
 *       just the pure gardssalgIsNavPolluted function
 */

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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-content-quality-scan";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgNavstoyHeuristikkTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-navstoy-heuristikk-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a)-(c): gardssalgIsNavPolluted — pure function, no DB ───────────

      // The real Draopar text (dev-request session finding, 2026-07-20):
      // nav tokens ("Heim", "Kontakt") glued in front of one real sentence.
      const draoparText =
        "Draopar eplesider Heim Salg og sidersmaking Om sider Kontakt Sidersortar Alkoholfritt draopar Draopar er dialekt for dråper.";
      assertTrue(store.gardssalgIsNavPolluted(draoparText), "a1: real Draopar text flagged nav-polluted");
      assertTrue(!store.gardssalgMeetsQualityBar(draoparText), "a2: Draopar text fails the gårdssalg composite quality bar");

      // (b) Genuine real prose must NOT be flagged, including the
      // passive-voice Title-Case product-list shape search-enrich.ts's own
      // round-2 fix-up had to specifically stop over-rejecting — a naive
      // "flat Title-Case run with no early punctuation" heuristic would
      // reproduce that exact regression.
      const goodAbout =
        "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";
      assertTrue(!store.gardssalgIsNavPolluted(goodAbout), "b1: genuine short Norwegian prose not flagged");
      assertTrue(store.gardssalgMeetsQualityBar(goodAbout), "b2: genuine prose passes the gårdssalg composite bar");

      const passiveProductList =
        "Nordfjord Ost Sunnmøre Smør Stryn Rømme Geiranger Skyr Loen Youghurt Olden Kefir Briksdal Kremfløte og Hjørundfjord Cottage Cheese produseres her på garden hver eneste dag.";
      assertTrue(!store.gardssalgIsNavPolluted(passiveProductList), "b3: passive-voice Title-Case product-list prose not flagged (no regression of search-enrich round-2 fix-up)");
      assertTrue(store.gardssalgMeetsQualityBar(passiveProductList), "b4: passive-voice product-list prose passes the gårdssalg composite bar");

      const realWithMenu =
        "Vår restaurant har en fast meny med lokale råvarer, og gjestene kan også besøke gårdsbutikken vår for å handle rett fra produksjonen.";
      const realWithOpeningHours =
        "Vi holder åpent i sommersesongen. Kom innom gårdsbutikken vår for ferske varer. Åpningstider: mandag til fredag klokken ti til seksten.";

      // (c) A single incidental nav-word mention must never be enough.
      assertTrue(!store.gardssalgIsNavPolluted(realWithMenu), "c1: single incidental 'meny' mention not flagged");
      assertTrue(!store.gardssalgIsNavPolluted(realWithOpeningHours), "c2: single incidental 'Åpningstider' mention not flagged");

      // A text carrying >=2 distinct nav words with no offsetting real
      // sentence at all (pure menu chrome) must be flagged too.
      const pureNavChrome = "Hjem Kontakt Meny Handlekurv Sortiment Vilkår Levering";
      assertTrue(store.gardssalgIsNavPolluted(pureNavChrome), "c3: pure nav-chrome text with >=2 distinct nav words flagged");

      // ── round-1 review fix-up (2026-07-20, CHANGES-REQUESTED): the naive
      // "any-case, anywhere" version of the wordlist match destructively
      // false-positived on ordinary honest visit_text sentences that
      // legitimately use "kontakt"/"hjem"/"åpningstider" as normal
      // vocabulary, not as leaked nav labels. Reviewer's exact reproduced
      // failing examples — both must NOT be flagged. ─────────────────────
      const honestContactSentence =
        "Kontakt oss på forhånd, vi har åpningstider tirsdag til lørdag klokken ti til fjorten.";
      assertTrue(
        !store.gardssalgIsNavPolluted(honestContactSentence),
        "c4: 'Kontakt oss på forhånd...' (capitalized only by being sentence-initial) not flagged"
      );
      assertTrue(
        store.gardssalgMeetsQualityBar(honestContactSentence),
        "c5: honest contact/opening-hours sentence passes the gårdssalg composite bar"
      );
      const honestDeliverySentence =
        "Vi leverer rett hjem til deg om du tar kontakt i god tid før helgen, og ellers er du velkommen til gårdsbutikken.";
      assertTrue(
        !store.gardssalgIsNavPolluted(honestDeliverySentence),
        "c6: 'Vi leverer rett hjem ... tar kontakt ...' (both words lowercase mid-sentence) not flagged"
      );
      assertTrue(
        store.gardssalgMeetsQualityBar(honestDeliverySentence),
        "c7: honest home-delivery sentence passes the gårdssalg composite bar"
      );

      // A nav word that is ONLY ever capitalized because it starts a real
      // sentence (not because it's a leaked menu label) must not count even
      // when paired with a second, later real sentence that also happens to
      // open with a nav word — sentence-initial capitalization is excluded
      // by position, not by whether it's the FIRST sentence in the text.
      const twoSentencesEachOpeningWithNavWord =
        "Kontakt oss for booking av gårdsbesøk. Hjem til deg leverer vi ferske grønnsaker hver uke i sommersesongen.";
      assertTrue(
        !store.gardssalgIsNavPolluted(twoSentencesEachOpeningWithNavWord),
        "c8: two real sentences each merely opening with a nav-adjacent word not flagged"
      );

      // ── round-2 review fix-up (2026-07-20, CHANGES-REQUESTED): two new
      // edge cases found in the sentence-boundary-aware heuristic itself.
      // (1) A punctuation-light "label: value" blurb — a Title-Case label
      // right after a bare number/day-name carries no sentence-ending
      // punctuation before it, so it looked mid-sentence-capitalized (=
      // nav-artifact-shaped) when it's really just a normal short blurb.
      // (2) The phrase matcher never applied the single-token matcher's
      // sentence-initial exclusion, so a heading like "Om Oss: ..." at the
      // very start of the text falsely counted. Reviewer's exact reproduced
      // failing examples — neither must be flagged. ───────────────────────
      const labelValueBlurb =
        "Kontakt 900 12 345 Åpningstider mandag-fredag 10-17 Levering Vi leverer i hele bygda og omegn hver fredag ettermiddag.";
      assertTrue(
        !store.gardssalgIsNavPolluted(labelValueBlurb),
        "c9: 'Kontakt 900 12 345 Åpningstider mandag-fredag 10-17 ...' label:value blurb not flagged"
      );
      assertTrue(
        store.gardssalgMeetsQualityBar(labelValueBlurb),
        "c10: label:value contact/hours/delivery blurb passes the gårdssalg composite bar"
      );
      const headingThenRealProse =
        "Om Oss: Vi er en familiegård med lange tradisjoner, og selger ferske varer rett fra egen gårdsbutikk hver helg.";
      assertTrue(
        !store.gardssalgIsNavPolluted(headingThenRealProse),
        "c11: 'Om Oss: Vi er en familiegård ...' (heading capitalized only by starting the text) not flagged"
      );
      assertTrue(
        store.gardssalgMeetsQualityBar(headingThenRealProse),
        "c12: heading-prefixed genuine prose passes the gårdssalg composite bar"
      );

      // ── (d): applyGardssalgProviderContent duplicate-block guard ────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text,
            producer_type, catalog_hidden, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text,
            @producer_type, @catalog_hidden, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "prov-dup", navn: "Prov Dup Sideri", hjemmeside: "https://prov-dup.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
        producer_type: "sideri", catalog_hidden: 0,
      });

      const sameBlock = "Om Prov Dup gård og sideriet vårt, med lang nok tekst til å passere kvalitetsporten.";
      const writtenDup = store.applyGardssalgProviderContent(
        "prov-dup",
        { about_text: sameBlock, visit_text: sameBlock },
        "https://prov-dup.example.no",
      );
      assertEq(writtenDup, ["about_text"], "d1: duplicate about/visit candidate -> only about_text written");
      const rowDup = expDb.prepare(`SELECT about_text, visit_text FROM experience_providers WHERE id = ?`).get("prov-dup") as any;
      assertEq(rowDup.about_text, sameBlock, "d2: about_text written to the duplicate block");
      assertEq(rowDup.visit_text, null, "d3: visit_text stays blank (never duplicated)");

      // Distinct candidates for the two fields still both write normally
      // (regression: the dedup guard must not over-trigger).
      insertProvider.run({
        id: "prov-distinct", navn: "Prov Distinct Bryggeri", hjemmeside: "https://prov-distinct.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
        producer_type: "bryggeri", catalog_hidden: 0,
      });
      const writtenDistinct = store.applyGardssalgProviderContent(
        "prov-distinct",
        { about_text: "Om Prov Distinct gård, med lang nok tekst til å passere kvalitetsporten skikkelig godt her.", visit_text: "Besøk oss i helgene, vi holder åpent hver lørdag og søndag hele sommeren for alle gjester." },
        "https://prov-distinct.example.no",
      );
      assertEq(writtenDistinct.sort(), ["about_text", "visit_text"], "d4: distinct about/visit candidates both still written (no over-trigger)");

      // ── round-1 review fix-up (2026-07-20, CHANGES-REQUESTED): the
      // duplicate-block guard must NOT suppress visit_text when about_text
      // ISN'T actually going to consume the shared candidate block —
      // e.g. about_text already holds decent, quality-bar-passing content
      // (never churned) while visit_text is genuinely blank. Reviewer's
      // exact reproduced failing scenario: pre-fix, this silently left
      // visit_text blank forever because candidate equality alone (ignoring
      // whether about_text's OWN write was a no-op) suppressed it. ────────
      const decentExistingAbout =
        "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";
      insertProvider.run({
        id: "prov-dup-noop-about", navn: "Prov Dup Noop About Gard", hjemmeside: "https://prov-dup-noop-about.example.no",
        content_source: null, about_text: decentExistingAbout, visit_text: null, opening_hours_text: null,
        producer_type: "sideri", catalog_hidden: 0,
      });
      const sameBlock2 = "Velkommen til gårdsbutikken vår hver lørdag, med masse ferske varer å velge blant hele sesongen.";
      const writtenNoopAbout = store.applyGardssalgProviderContent(
        "prov-dup-noop-about",
        { about_text: sameBlock2, visit_text: sameBlock2 },
        "https://prov-dup-noop-about.example.no",
      );
      assertEq(writtenNoopAbout, ["visit_text"], "d5: about_text already decent (never churned, no-op) -> visit_text's IDENTICAL candidate still fills the genuinely blank field");
      const rowNoopAbout = expDb.prepare(`SELECT about_text, visit_text FROM experience_providers WHERE id = ?`).get("prov-dup-noop-about") as any;
      assertEq(rowNoopAbout.about_text, decentExistingAbout, "d6: about_text unchanged (its own decent content was never touched)");
      assertEq(rowNoopAbout.visit_text, sameBlock2, "d7: visit_text filled from the candidate, even though it's byte-identical to the (untouched) about_text candidate");

      // ── (e): evaluateGardssalgContentQuality — pure decision function ────
      const scanRows = [
        { id: "p1", navn: "P1", content_source: null, about_text: draoparText, visit_text: null },
        { id: "p2", navn: "P2", content_source: null, about_text: goodAbout, visit_text: goodAbout },
        { id: "p3", navn: "P3", content_source: null, about_text: draoparText, visit_text: draoparText },
        { id: "p4", navn: "P4", content_source: null, about_text: goodAbout, visit_text: passiveProductList },
      ];
      const evalFlags = store.evaluateGardssalgContentQuality(scanRows);

      const p1Flags = evalFlags.filter((f: any) => f.provider_id === "p1");
      assertEq(p1Flags.length, 1, "e1: p1 (nav-polluted about_text only) -> exactly 1 flag");
      assertEq(p1Flags[0], { provider_id: "p1", navn: "P1", field_name: "about_text", reason: "nav_polluted", excerpt: draoparText.slice(0, 160) }, "e2: p1 flag shape (about_text, nav_polluted)");

      const p2Flags = evalFlags.filter((f: any) => f.provider_id === "p2");
      assertEq(p2Flags.length, 1, "e3: p2 (genuine duplicate, both fields clean prose) -> exactly 1 flag");
      assertEq(p2Flags[0].field_name, "visit_text", "e4: p2's duplicate flag targets visit_text only (about_text wins)");
      assertEq(p2Flags[0].reason, "duplicate_about_visit", "e5: p2's flag reason is duplicate_about_visit");

      const p3Flags = evalFlags.filter((f: any) => f.provider_id === "p3");
      assertEq(p3Flags.length, 2, "e6: p3 (both fields Draopar-identical) -> 2 flags, one per field");
      assertTrue(p3Flags.every((f: any) => f.reason === "nav_polluted"), "e7: p3's flags are both nav_polluted (not double-flagged as duplicate too)");
      assertTrue(p3Flags.some((f: any) => f.field_name === "about_text") && p3Flags.some((f: any) => f.field_name === "visit_text"), "e8: p3 flags cover both fields independently");

      const p4Flags = evalFlags.filter((f: any) => f.provider_id === "p4");
      assertEq(p4Flags.length, 0, "e9: p4 (two distinct, clean fields) -> zero flags");

      // ── (f): selectGardssalgProvidersForQualityScan — DB read ───────────
      insertProvider.run({
        id: "prov-hidden", navn: "Prov Hidden Mjøderi", hjemmeside: "https://prov-hidden.example.no",
        content_source: null, about_text: draoparText, visit_text: null, opening_hours_text: null,
        producer_type: "mjøderi", catalog_hidden: 1,
      });
      insertProvider.run({
        id: "prov-locked", navn: "Prov Locked Gard", hjemmeside: "https://prov-locked.example.no",
        content_source: "manual", about_text: draoparText, visit_text: null, opening_hours_text: null,
        producer_type: "sideri", catalog_hidden: 0,
      });

      const scanTargets = store.selectGardssalgProvidersForQualityScan();
      const scanIds = new Set(scanTargets.map((r: any) => r.id));
      assertTrue(scanIds.has("prov-hidden"), "f1: catalog_hidden=1 row IS included in the quality-scan target set");
      assertTrue(!scanIds.has("prov-locked"), "f2: manual/claim-locked row is EXCLUDED from the quality-scan target set");
      assertTrue(scanIds.has("prov-dup") && scanIds.has("prov-distinct"), "f3: ordinary visible providers included too");

      // ── (g): POST /admin/gardssalg-content-quality-scan ─────────────────

      // 403 unauthenticated.
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "g1: unauthenticated request -> 403");

      // Dry-run: reports flags, writes nothing.
      const dry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-hidden"], apply: false },
      });
      assertEq(dry.status, 200, "g2: dry-run -> 200");
      assertEq(dry.body.dry_run, true, "g3: dry_run:true");
      assertEq(dry.body.scanned, 1, "g4: scanned == 1 (scoped to prov-hidden)");
      assertEq(dry.body.flagged, 1, "g5: flagged == 1 (prov-hidden's nav-polluted about_text)");
      const rowHiddenBeforeApply = expDb.prepare(
        `SELECT about_text, last_content_attempt_at FROM experience_providers WHERE id = ?`
      ).get("prov-hidden") as any;
      assertEq(rowHiddenBeforeApply.about_text, draoparText, "g6: dry-run performs zero writes — about_text unchanged");

      // Stamp last_content_attempt_at so we can prove the apply path resets
      // it (re-queue signal) rather than it just happening to already be null.
      expDb.prepare(`UPDATE experience_providers SET last_content_attempt_at = datetime('now') WHERE id = ?`).run("prov-hidden");

      // Apply: nulls the flagged field via the existing audit path, resets
      // last_content_attempt_at, and never touches the locked row.
      const apply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-hidden", "prov-locked"], apply: true },
      });
      assertEq(apply.status, 200, "g7: apply -> 200");
      assertEq(apply.body.dry_run, false, "g8: dry_run:false");
      assertEq(apply.body.applied.length, 1, "g9: exactly 1 field applied (prov-hidden's about_text; prov-locked excluded from the scan entirely)");
      assertEq(apply.body.applied[0], { provider_id: "prov-hidden", field_name: "about_text" }, "g10: applied entry names prov-hidden/about_text");
      assertTrue(typeof apply.body.batch_id === "string" && apply.body.batch_id.length > 0, "g11: response carries a non-empty batch_id");

      const rowHiddenAfterApply = expDb.prepare(
        `SELECT about_text, last_content_attempt_at FROM experience_providers WHERE id = ?`
      ).get("prov-hidden") as any;
      assertEq(rowHiddenAfterApply.about_text, null, "g12: prov-hidden's about_text nulled");
      assertEq(rowHiddenAfterApply.last_content_attempt_at, null, "g13: last_content_attempt_at reset to NULL (re-queued)");

      const rowLockedAfterApply = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id = ?`).get("prov-locked") as any;
      assertEq(rowLockedAfterApply.about_text, draoparText, "g14: manual/claim-locked row's about_text is untouched by apply");

      const auditRowsHidden = expDb.prepare(
        `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
      ).all("prov-hidden") as any[];
      assertEq(auditRowsHidden.length, 1, "g15: exactly 1 audit row for prov-hidden's scan-fix");
      assertEq(auditRowsHidden[0].field_name, "about_text", "g16: audit row field_name is about_text");
      assertEq(auditRowsHidden[0].old_value, draoparText, "g17: audit row old_value is the real pre-null Draopar text");
      assertEq(auditRowsHidden[0].new_value, null, "g18: audit row new_value is null (the nulling write)");
      assertEq(auditRowsHidden[0].batch_id, apply.body.batch_id, "g19: audit row batch_id matches the response's batch_id");

      // The existing rollback lever must be able to undo a scan-fix batch —
      // proves this feature reuses the SAME audit/provenance path rather
      // than inventing a parallel, non-reversible write mechanism.
      const rollback = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: apply.body.batch_id, apply: true },
      });
      assertEq(rollback.status, 200, "g20: rollback of the scan-fix batch -> 200");
      const rowHiddenAfterRollback = expDb.prepare(`SELECT about_text FROM experience_providers WHERE id = ?`).get("prov-hidden") as any;
      assertEq(rowHiddenAfterRollback.about_text, draoparText, "g21: rollback restores the original Draopar text");

      // Re-running apply against an already-clean row set is a no-op
      // (skipped, not a hard error) — the flag no longer matches (rollback
      // restored it, and the previous null->text history means the field is
      // no longer flagged as duplicate/nav-polluted post-restore since it's
      // back to the SAME flagged text again — re-scan to get fresh flags).
      const rescan = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-hidden"], apply: false },
      });
      assertEq(rescan.body.flagged, 1, "g22: re-scan after rollback finds the SAME flag again (restored text is still nav-polluted)");

      // ── (h) end-to-end: the REAL crawl path never fills a blank field with
      // nav-polluted content — review round 2's CRITICAL finding, verified
      // at the actual production call site (POST /admin/gardssalg-content-
      // refresh), not just the pure gardssalgIsNavPolluted function. Mocks
      // globalThis.fetch (repo convention — see opplevelser-gardssalg-
      // content-audit.test.ts block (k)) since this route makes real
      // fetch() calls and the sandbox has no network access. ──────────────
      const prevFetchH = globalThis.fetch;
      try {
        const draoparHtml = `<html><head><meta property="og:description" content="${draoparText}"></head><body><p>${draoparText}</p></body></html>`;
        insertProvider.run({
          id: "prov-draopar-crawl", navn: "Draopar Crawl Test", hjemmeside: "https://prov-draopar-crawl.example.no",
          content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
          producer_type: "sideri", catalog_hidden: 0,
        });
        globalThis.fetch = (async (url: string | URL | Request) => {
          const host = new URL(String(url)).hostname;
          if (host === "prov-draopar-crawl.example.no") {
            return { ok: true, status: 200, text: async () => draoparHtml } as unknown as Response;
          }
          return { ok: false, status: 404, text: async () => "" } as unknown as Response;
        }) as typeof fetch;

        const applyDraoparCrawl = await callRoute(opplevelserRouter, {
          url: "/admin/gardssalg-content-refresh",
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["prov-draopar-crawl"], apply: true },
        });
        assertEq(applyDraoparCrawl.status, 200, "h1: apply gardssalg-content-refresh (Draopar-shaped crawl) -> 200");
        assertEq(
          applyDraoparCrawl.body.changed.find((c: any) => c.provider_id === "prov-draopar-crawl"),
          undefined,
          "h2: prov-draopar-crawl does NOT appear in changed[] — the nav-polluted candidate was never accepted"
        );
        const rowDraoparCrawl = expDb.prepare(`SELECT about_text, visit_text FROM experience_providers WHERE id = ?`).get("prov-draopar-crawl") as any;
        assertEq(rowDraoparCrawl.about_text, null, "h3: about_text stays blank — the real crawl path rejects the Draopar-shaped extraction");
        assertEq(rowDraoparCrawl.visit_text, null, "h4: visit_text stays blank too");
      } finally {
        globalThis.fetch = prevFetchH;
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-navstoy-heuristikk: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-navstoy-heuristikk.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgNavstoyHeuristikkTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
