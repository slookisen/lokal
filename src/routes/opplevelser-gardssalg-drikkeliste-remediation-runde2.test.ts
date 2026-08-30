/**
 * opplevelser-gardssalg-drikkeliste-remediation-runde2.test.ts — tests for
 * the round-2 follow-up (dev-request
 * 2026-08-30-drikkeliste-remediering-runde-2, daniel_authorized) to the §4a-
 * §4e drikkeliste remediation batch covered by
 * opplevelser-gardssalg-drikkeliste-remediation.test.ts. That file already
 * carries the surgical updates needed where round 2 changes round 1's own
 * behaviour (the 15 keys moved from a plain merge attempt to terminal-mark +
 * twin_link — see its own updated fixtures/assertions for njot-aga-sideri,
 * svalbard-distillery, and guajiro-holding). THIS file covers everything
 * round 2 adds that round 1's file does not already exercise:
 *
 *   Del A — GS_ROUND2_TERMINAL_ITEMS, additional coverage beyond the three
 *     keys already covered in round 1's file: a second full happy path
 *     (Erik Juel Karlsen Eid -> Norumbryggeriet AS), an unseeded/unresolved
 *     source, and Telemark Bryggeri's own no-operating-row / no-twin_link
 *     terminal-mark path (Del C part 2 reuses this exact mechanism).
 *   Del B — the `providerId` field added to §4a/§4c/§4d/§4e item shapes:
 *     one scenario per category, each seeded so the OLD name/website lookup
 *     would genuinely be ambiguous (multiple matching rows) while the NEW
 *     providerId resolves it outright. The §4a case additionally proves the
 *     org_nr-conflict merge guard is still fully active for everything
 *     OUTSIDE the named Del A cohort (Geiranger was never one of the 15).
 *   Del C — the postal-code data-input fix (GS_ROUND2_POSTAL_PREFILL_ITEMS)
 *     feeding into the EXISTING, unchanged §4e backfill call end-to-end for
 *     Hardanger Handbryggeri (previously vetoed on missing postal
 *     corroboration), plus idempotency of the prefill step itself.
 *
 * Harness copied verbatim from
 * opplevelser-gardssalg-drikkeliste-remediation.test.ts (EXPERIENCES_DB_PATH
 * = ":memory:", fresh require of db-factory + experience-store + opplevelser
 * router per run, callRoute() exercised directly against router.handle(),
 * globalThis.fetch stubbed for the §4e sub-step's live Brreg calls).
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
    const url = opts.url || "/admin/gardssalg-drikkeliste-remediation";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgDrikkelisteRemediationRunde2Tests(
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-drikkeliste-remediation-runde2-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const mergePath = require.resolve("../services/gardssalg-provider-merge");
    const remediationPath = require.resolve("../services/gardssalg-drikkeliste-remediation");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, mergePath, remediationPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregCacheForTesting();

      const auth = { "x-admin-key": testKey };

      // ── Fixture-seeding helper — same shape as round 1's test file ──────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            about_text, products, brreg_verified, catalog_hidden, slug, field_provenance,
            merged_into, terminal_status, adresse, postnummer, poststed,
            producer_type, enrichment_state, verification_status, source, confidence,
            created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            @about_text, @products, @brreg_verified, @catalog_hidden, @slug, @field_provenance,
            @merged_into, @terminal_status, @adresse, @postnummer, @poststed,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          about_text: null, products: null, brreg_verified: 0, catalog_hidden: null, slug: null,
          field_provenance: null, merged_into: null, terminal_status: null,
          adresse: null, postnummer: null, poststed: null,
          created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getRow(id: string): any {
        return expDb.prepare(
          `SELECT id, navn, org_nr, hjemmeside, merged_into, terminal_status, adresse, postnummer, poststed
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }
      function findResult(body: any, key: string): any {
        return (body.results as any[]).find((r) => r.key === key);
      }
      function findResultByMethod(body: any, key: string, method: string): any {
        return (body.results as any[]).find((r) => r.key === key && r.method === method);
      }
      function findResultsByKey(body: any, key: string): any[] {
        return (body.results as any[]).filter((r) => r.key === key);
      }

      // ══════════════════════════════════════════════════════════════════
      // Del A fixtures — beyond the njot/svalbard/guajiro trio already
      // covered by round 1's own test file.
      // ══════════════════════════════════════════════════════════════════

      // (a1) Erik Juel Karlsen Eid -> Norumbryggeriet AS — a second full
      // happy path (both rows present).
      mkProvider({ id: "erik-juel-karlsen-eid", navn: "Erik Juel Karlsen Eid", org_nr: "992114231", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "norumbryggeriet", navn: "Norumbryggeriet AS", org_nr: "915132782", created_at: "2026-01-01 00:00:00" });
      // (a2) "Ale Mates" deliberately NOT seeded -> source_not_found, exactly
      // as an unseeded round-1 §4a item behaves (same helper, same contract).

      // (a3) Telemark Bryggeri — Del C part 2's own no-operating-row path,
      // seeded fresh (independent of round 1's own telemark-bryggeri
      // fixture in the other test file) purely to isolate round 2's own
      // "4a" category result for this key.
      mkProvider({ id: "telemark-2", navn: "Telemark Bryggeri AS", org_nr: null, created_at: "2026-01-01 00:00:00" });

      // ══════════════════════════════════════════════════════════════════
      // Del B fixtures — providerId disambiguates what a bare name/website
      // hint alone cannot.
      // ══════════════════════════════════════════════════════════════════

      // (b1) §4a — "Geiranger" bare-name lookup is genuinely ambiguous (three
      // "Geiranger"-prefixed rows here, sixteen on the live catalog) —
      // GS_4A_ITEMS' own "geiranger" entry carries a hardcoded providerId for
      // exactly this reason. The target ("Geiranger Brenneri") already
      // carries its own populated, DIFFERENT org.nr, so once the source
      // resolves, the STILL-ACTIVE org_nr-conflict merge guard correctly
      // rejects the merge — proving that guard is untouched for every key
      // outside the named Del A cohort ("geiranger" was never one of the 15).
      mkProvider({ id: "geiranger-decoy-1", navn: "Geiranger Fjordservice", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "geiranger-decoy-2", navn: "Geiranger Kayak Center", created_at: "2026-01-01 00:00:00" });
      mkProvider({
        id: "cde95a67-283c-4520-803c-b998eb009cb7", navn: "Geiranger Bryggeri",
        org_nr: "914497264", created_at: "2026-01-01 00:00:00",
      });
      mkProvider({ id: "geiranger-brenneri", navn: "Geiranger Brenneri", org_nr: "929225236", created_at: "2026-01-01 00:00:00" });

      // (b2) §4c — the Fjellbryggeriet-leftover pair, seeded at the EXACT
      // providerIds GS_4C_ITEMS now carries for this key, alongside two
      // OTHER "Fjellbryggeriet"-named decoys to prove the plain name lookup
      // really would be ambiguous (4 matches) while providerIds picks
      // exactly the intended two.
      mkProvider({ id: "fjell-decoy-1", navn: "Fjellbryggeriet DA", org_nr: "995720329", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "fjell-decoy-2", navn: "Fjellbryggeriet DA", created_at: "2026-01-02 00:00:00" });
      mkProvider({ id: "7d2bfb81-41fc-41cb-b815-1f960e57c3fb", navn: "Fjellbryggeriet — Åmotsdal", org_nr: null, created_at: "2026-01-03 00:00:00" });
      mkProvider({
        id: "32fd77ac-d490-4873-bbe7-650a64ae54f4", navn: "Fjellbryggeriet — Åmotsdal",
        org_nr: "916476450", epost: "post@fjellbryggeriet.no", created_at: "2026-01-04 00:00:00",
      });

      // (b3) §4d — "Ulvik Frukt" name-matches multiple rows; the wrong
      // stored hjemmeside (aldesider.no) belongs specifically to the row at
      // this exact providerId.
      mkProvider({ id: "ulvik-decoy-1", navn: "Ulvik Fjord Pensjonat", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "ulvik-decoy-2", navn: "Lekve Gard — Ulvik", created_at: "2026-01-01 00:00:00" });
      mkProvider({
        id: "5fda0eed-f7ba-4653-b663-0f33345ce942", navn: "Alde Sider / Ulvik Frukt & Cideri — Ulvik, Hardanger",
        hjemmeside: "https://aldesider.no", created_at: "2026-01-01 00:00:00",
      });

      // (b4) §4e — "Trondhjem Mikrobryggeri" name-matches multiple rows; the
      // one genuinely missing its org.nr is at this exact providerId.
      mkProvider({ id: "trondhjem-decoy-1", navn: "Trondhjem Micro Bryggeri", org_nr: "900111222", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "trondhjem-decoy-2", navn: "Trondhjem Mikrobryggeri AS", org_nr: "900333444", created_at: "2026-01-01 00:00:00" });
      mkProvider({
        id: "0995b7f3-8fc7-4ff1-9b0b-612e5fa31ed2", navn: "Trondhjem Mikrobryggeri — Trondheim",
        org_nr: null, postnummer: "7010", poststed: "Trondheim", created_at: "2026-01-01 00:00:00",
      });

      // ══════════════════════════════════════════════════════════════════
      // Del C fixture — Hardanger Handbryggeri: postal data-input fix
      // feeding into the EXISTING (unchanged) §4e backfill call.
      // ══════════════════════════════════════════════════════════════════
      mkProvider({
        id: "8c2e422c-2d40-45c2-ba61-588faac2755a", navn: "Hardanger Handbryggeri",
        org_nr: null, adresse: null, postnummer: null, poststed: null, created_at: "2026-01-01 00:00:00",
      });

      // ── Brreg fetch stub ─────────────────────────────────────────────────
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        const dm = u.match(/\/enheter\/(\d{9})$/);
        if (dm) {
          return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: dm[1], navn: "SUNN TESTENHET AS" }) } as unknown as Response;
        }
        if (u.includes("navn=Trondhjem%20Mikrobryggeri")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "979740360", navn: "Trondhjem Mikrobryggeri",
              forretningsadresse: { adresse: ["Vei 5"], postnummer: "7010", poststed: "Trondheim" },
            }] } }),
          } as unknown as Response;
        }
        // Hardanger Handbryggeri -> exact match at the report's expected
        // org.nr, corroborated against the SAME postal the round-2 postal-
        // prefill step just wrote (5773 Hovland) — proving the data-input
        // fix, not a gate-logic change, is what unblocks this backfill.
        if (u.includes("navn=Hardanger%20Handbryggeri")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "915218857", navn: "Hardanger Handbryggeri",
              forretningsadresse: { adresse: ["Børve"], postnummer: "5773", poststed: "Hovland" },
            }] } }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      // ══════════════════════════════════════════════════════════════════
      // DRY RUN
      // ══════════════════════════════════════════════════════════════════
      const dryRes = await callRoute(opplevelserRouter, { headers: auth, body: { apply: false, batch_id: "runde2-test-batch-1" } });
      assertEq(dryRes.status, 200, "dry1: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "dry2: dry_run:true");

      // ── Del A ────────────────────────────────────────────────────────────
      const dryErikTerm = findResultByMethod(dryRes.body, "erik-juel-karlsen-eid", "terminal_status");
      const dryErikTwin = findResultByMethod(dryRes.body, "erik-juel-karlsen-eid", "twin_link");
      assertEq(dryErikTerm.outcome, "would_terminal_mark", "a1: Erik Juel Karlsen Eid would be terminal-marked");
      assertTrue(String(dryErikTerm.reason).includes("holding_drift_i_annet_orgnr"), "a1b: reason embeds the round-2 evidence class");
      assertEq(dryErikTwin.outcome, "would_twin_link", "a2: Erik Juel Karlsen Eid would twin_link to Norumbryggeriet AS");
      assertEq(dryErikTwin.new_value, "norumbryggeriet", "a3: twin_link points at Norumbryggeriet AS's id");

      const dryAleMates = findResult(dryRes.body, "ale-mates");
      assertEq(dryAleMates.outcome, "unresolved", "a4: unseeded Ale Mates -> unresolved");
      assertEq(dryAleMates.reason, "source_not_found", "a5: reason is source_not_found, not a guess");

      const dryTelemark2 = findResultsByKey(dryRes.body, "telemark-bryggeri").filter((r) => r.provider_id === "telemark-2" || r.category === "4a");
      // Only round 2's own "4a" terminal-mark entry should even be able to
      // resolve this fixture (round 1's §4b/§4e items ALSO share the same
      // key/name and will independently attempt this row too — that overlap
      // is expected and covered by round 1's own test file; here we only
      // assert the round-2-specific "4a" entry's own shape).
      const dryTelemarkRound2 = (dryRes.body.results as any[]).find((r) => r.key === "telemark-bryggeri" && r.category === "4a");
      assertEq(dryTelemarkRound2.method, "terminal_status", "a6: Telemark Bryggeri round-2 entry is terminal_status only");
      assertEq(dryTelemarkRound2.outcome, "would_terminal_mark", "a7: would be terminal-marked");
      assertTrue(String(dryTelemarkRound2.reason).includes("brreg_slettet"), "a8: reason embeds the brreg_slettet evidence class");
      const telemarkTwinEntries = (dryRes.body.results as any[]).filter((r) => r.key === "telemark-bryggeri" && r.method === "twin_link");
      assertEq(telemarkTwinEntries.length, 0, "a9: no twin_link attempted for Telemark Bryggeri — no operating row, per the item's own `operating: undefined`");

      // ── Del B ────────────────────────────────────────────────────────────
      const dryGeiranger = findResult(dryRes.body, "geiranger");
      assertEq(dryGeiranger.method, "merge", "b1: Geiranger resolves via providerId then attempts the ordinary merge lever");
      assertEq(dryGeiranger.outcome, "rejected", "b2: still hits the STILL-ACTIVE org_nr-conflict guard (Geiranger isn't in the Del A cohort)");
      assertEq(dryGeiranger.reason, "org_nr_konflikt_ulike_org_nr", "b3: rejection reason is the merge lever's own guard, verbatim");
      assertEq(dryGeiranger.remove_id, "cde95a67-283c-4520-803c-b998eb009cb7", "b4: providerId resolved the correct source row despite 3 name-ambiguous candidates");
      assertEq(dryGeiranger.keep_id, "geiranger-brenneri", "b5: target resolved via its own (unambiguous) org.nr");

      const dryFjellPair = findResult(dryRes.body, "fjellbryggeriet-leftover-pair");
      assertEq(dryFjellPair.outcome, "would_merge", "b6: providerIds resolves the pair despite 4 name-ambiguous candidates in this fixture set");
      assertEq(dryFjellPair.keep_id, "32fd77ac-d490-4873-bbe7-650a64ae54f4", "b7: the more-complete row (org_nr+epost) is the keep survivor");
      assertEq(dryFjellPair.remove_id, "7d2bfb81-41fc-41cb-b815-1f960e57c3fb", "b8: the blanker row is the remove");

      const dryUlvik = findResult(dryRes.body, "ulvik-frukt-cideri");
      assertEq(dryUlvik.outcome, "would_correct_hjemmeside", "b9: providerId resolves Ulvik Frukt & Cideri despite 3 name-ambiguous candidates");
      assertEq(dryUlvik.provider_id, "5fda0eed-f7ba-4653-b663-0f33345ce942", "b10: resolved to the exact row carrying the wrong site");
      assertEq(dryUlvik.new_value, null, "b11: would null the wrong (aldesider.no) hjemmeside");

      const dryTrondhjem = findResult(dryRes.body, "trondhjem-mikrobryggeri");
      assertEq(dryTrondhjem.outcome, "would_backfill_match", "b12: providerId resolves Trondhjem Mikrobryggeri despite 3 name-ambiguous candidates");
      assertEq(dryTrondhjem.new_value, "979740360", "b13: candidate org.nr matches the report's expected value");

      // ── Del C ────────────────────────────────────────────────────────────
      const dryPostal = findResult(dryRes.body, "hardanger-handbryggeri-postal");
      assertEq(dryPostal.outcome, "would_postal_prefill", "c1: Hardanger Handbryggeri postal data-input fix would be applied");
      assertEq(getRow("8c2e422c-2d40-45c2-ba61-588faac2755a").postnummer, null, "c2: dry-run performed ZERO writes");

      const dryHardangerBackfill = findResult(dryRes.body, "hardanger-handbryggeri");
      assertEq(dryHardangerBackfill.category, "4e", "c3: the existing §4e entry for this row is unchanged");
      // Under dry-run the postal prefill above never actually wrote anything
      // (still would_postal_prefill), so the row's OWN postnummer/poststed
      // are still blank when §4e's read happens later in the SAME dry-run —
      // gardssalgOrgnrPostalCorroborated has nothing to corroborate against
      // yet, so this still vetoes exactly as round 1 originally found it.
      // The full end-to-end unblock is proven under APPLY below.
      assertEq(dryHardangerBackfill.outcome, "backfilled_vetoed", "c4: dry-run alone doesn't unblock it — the postal write must actually happen first (proven under apply)");

      // ══════════════════════════════════════════════════════════════════
      // APPLY
      // ══════════════════════════════════════════════════════════════════
      const applyRes = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true, batch_id: "runde2-test-batch-1" } });
      assertEq(applyRes.status, 200, "apply1: apply -> 200");

      // ── Del A, applied ───────────────────────────────────────────────────
      assertEq(getRow("erik-juel-karlsen-eid").terminal_status, "dod_kilde", "a10: Erik Juel Karlsen Eid actually terminal-marked");
      assertEq(getRow("erik-juel-karlsen-eid").merged_into, null, "a11: never merged");
      const erikTwinAudit = getAuditRows("erik-juel-karlsen-eid").filter((r) => r.field_name === "twin_link");
      assertEq(erikTwinAudit.length, 1, "a12: exactly one twin_link audit row");
      assertEq(erikTwinAudit[0].new_value, "norumbryggeriet", "a13: it points at Norumbryggeriet AS's id");
      assertEq(getRow("norumbryggeriet").org_nr, "915132782", "a14: the operating row's own org_nr is completely untouched");
      assertEq(getRow("norumbryggeriet").terminal_status, null, "a15: the operating row is never itself terminal-marked");

      assertEq(getRow("telemark-2").terminal_status, "dod_kilde", "a16: Telemark Bryggeri actually terminal-marked (Del C part 2, no twin_link)");
      assertEq(getAuditRows("telemark-2").filter((r) => r.field_name === "twin_link").length, 0, "a17: zero twin_link audit rows — no operating row for this key");

      // ── Del B, applied ───────────────────────────────────────────────────
      assertEq(getRow("cde95a67-283c-4520-803c-b998eb009cb7").merged_into, null, "b14: Geiranger — rejected merge performs ZERO writes even under apply");
      assertEq(getRow("32fd77ac-d490-4873-bbe7-650a64ae54f4").merged_into, null, "b15: Fjellbryggeriet-leftover keep-survivor not marked as merged-away");
      assertEq(getRow("7d2bfb81-41fc-41cb-b815-1f960e57c3fb").merged_into, "32fd77ac-d490-4873-bbe7-650a64ae54f4", "b16: providerIds pair actually merged");
      assertEq(getRow("5fda0eed-f7ba-4653-b663-0f33345ce942").hjemmeside, null, "b17: Ulvik Frukt & Cideri's wrong hjemmeside actually nulled via providerId");
      assertEq(getRow("0995b7f3-8fc7-4ff1-9b0b-612e5fa31ed2").org_nr, "979740360", "b18: Trondhjem Mikrobryggeri's org_nr actually backfilled via providerId");

      // ── Del C, applied: full end-to-end unblock ─────────────────────────
      const applyPostal = findResult(applyRes.body, "hardanger-handbryggeri-postal");
      assertEq(applyPostal.outcome, "postal_prefilled", "c5: postal data-input fix actually applied");
      const hhRow = getRow("8c2e422c-2d40-45c2-ba61-588faac2755a");
      assertEq(hhRow.adresse, "Børve", "c6: adresse actually written");
      assertEq(hhRow.postnummer, "5773", "c7: postnummer actually written");
      assertEq(hhRow.poststed, "Hovland", "c8: poststed actually written");
      const postalAudit = getAuditRows("8c2e422c-2d40-45c2-ba61-588faac2755a");
      assertTrue(postalAudit.some((r) => r.field_name === "adresse"), "c9: adresse audited");
      assertTrue(postalAudit.some((r) => r.field_name === "postnummer"), "c10: postnummer audited");
      assertTrue(postalAudit.some((r) => r.field_name === "poststed"), "c11: poststed audited");

      const applyHardangerBackfill = findResult(applyRes.body, "hardanger-handbryggeri");
      assertEq(applyHardangerBackfill.outcome, "backfilled_match", "c12: THE data-input fix unblocked the previously-vetoed backfill — now matches the report's expected org.nr");
      assertEq(hhRow.org_nr, "915218857", "c13: org.nr actually backfilled to the report's expected value");

      // ══════════════════════════════════════════════════════════════════
      // Idempotency — second apply.
      // ══════════════════════════════════════════════════════════════════
      const audit_erik_before = getAuditRows("erik-juel-karlsen-eid").length;
      const audit_postal_before = getAuditRows("8c2e422c-2d40-45c2-ba61-588faac2755a").length;

      const applyRes2 = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true, batch_id: "runde2-test-batch-2" } });
      assertEq(applyRes2.status, 200, "n1: second apply -> 200 (no crash)");

      const erikTerm2 = findResultByMethod(applyRes2.body, "erik-juel-karlsen-eid", "terminal_status");
      const erikTwin2 = findResultByMethod(applyRes2.body, "erik-juel-karlsen-eid", "twin_link");
      assertEq(erikTerm2.outcome, "already_terminal", "n2: second apply on Erik Juel Karlsen Eid -> already_terminal");
      assertEq(erikTwin2.outcome, "already_twin_linked", "n3: second apply -> already_twin_linked");
      assertEq(getAuditRows("erik-juel-karlsen-eid").length, audit_erik_before, "n4: zero new audit rows on the second apply");

      const postalResult2 = findResult(applyRes2.body, "hardanger-handbryggeri-postal");
      assertEq(postalResult2.outcome, "already_filled", "n5: postal prefill is idempotent — second apply writes nothing further");
      assertEq(getAuditRows("8c2e422c-2d40-45c2-ba61-588faac2755a").length, audit_postal_before, "n6: zero new audit rows for the postal fields on the second apply");
      const backfillResult2 = findResult(applyRes2.body, "hardanger-handbryggeri");
      assertEq(backfillResult2.outcome, "already_filled", "n7: org.nr backfill is also idempotent — second apply sees it already filled");

      // Unauthenticated.
      const unauthRemediation = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauthRemediation.status, 403, "auth1: gardssalg-drikkeliste-remediation unauthenticated -> 403");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drikkeliste-remediation-runde2: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-drikkeliste-remediation-runde2.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgDrikkelisteRemediationRunde2Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
