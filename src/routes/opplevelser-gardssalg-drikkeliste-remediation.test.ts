/**
 * opplevelser-gardssalg-drikkeliste-remediation.test.ts — tests for the
 * §4a-§4e drikkeliste data-quality remediation batch (dev-request
 * 2026-08-29-drikkeliste-remapping-og-dodkilde):
 *
 *   - applyGardssalgSetOrgNr() / applyGardssalgSetHjemmeside()
 *     (src/services/experience-store.ts — the two new small write primitives)
 *   - POST /admin/gardssalg-set-org-nr / POST /admin/gardssalg-set-hjemmeside
 *     (src/routes/opplevelser.ts)
 *   - runGardssalgDrikkelisteRemediation()
 *     (src/services/gardssalg-drikkeliste-remediation.ts)
 *   - POST /admin/gardssalg-drikkeliste-remediation (src/routes/opplevelser.ts)
 *
 * Harness copied from opplevelser-gardssalg-set-terminal-status.test.ts /
 * opplevelser-gardssalg-orgnr-backfill.test.ts (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + experience-store + opplevelser
 * router per run, callRoute() exercised directly against router.handle(),
 * globalThis.fetch stubbed for the §4e sub-step's live Brreg calls).
 *
 * Does NOT seed all 64 report rows — only enough fixtures to exercise every
 * branch explicitly named as required coverage, plus a light touch of each
 * category. Every OTHER item in the five source lists has no matching
 * fixture and is therefore expected (and asserted, for a sample) to resolve
 * as `unresolved`/`source_not_found` — itself a form of coverage for the
 * "don't guess" contract.
 *
 * Covers:
 *   (a) applyGardssalgSetOrgNr: happy path, invalid_format, org_nr_conflict,
 *       provider_not_found, null clears
 *   (b) applyGardssalgSetHjemmeside: happy path, null clears,
 *       provider_not_found
 *   (c) POST /admin/gardssalg-set-org-nr / -set-hjemmeside: auth, validation,
 *       response shape
 *   (d) §4a merge-vs-in-place-correction branching: Njot→Aga Sideri (target
 *       row exists -> merge) vs Guajiro Holding (target row absent -> in-
 *       place org_nr correction), both dry-run and apply
 *   (e) §4a Fjellbryggeriet DA ×2 -> AS: first source row corrects in
 *       place, second source row then merges into the now-corrected row —
 *       proven identical in dry-run (virtual overlay) and apply (real DB)
 *   (f) §4a Skifjorden: both rows survive untouched (no merge/terminal
 *       mark), twin_link audit note recorded on both sides, apply is
 *       idempotent (rerun records no duplicate note)
 *   (g) §4a Lundetangen: unresolvable target -> terminal-marked dod_kilde,
 *       not guessed; idempotent on rerun (already_terminal)
 *   (h) §4a defer-to-4e (Hardanger Handbryggeri): always reports
 *       deferred_to_4e regardless of catalog state
 *   (i) an explicitly unresolved §4a row (no matching fixture) ->
 *       unresolved/source_not_found
 *   (j) §4b: happy-path terminal-mark with evidence class embedded in
 *       reason; already_terminal on rerun; Vestavin-shaped "already merged"
 *       skip case
 *   (k) §4c: a genuine duplicate pair merges (survivor = more complete
 *       data); the Fjellbryggeriet-leftover pair is unresolved BY DESIGN
 *       even though matching rows exist
 *   (l) §4d: name-resolved and website-resolved corrections, including a
 *       null-out
 *   (m) §4e: exact cross-check match, a mismatch (route's own Brreg
 *       resolution differs from the report's expected value), a veto
 *       (needs_human_review), and the §4b+§4e "same row, independent
 *       fields, both done" case (Telemark Bryggeri)
 *   (n) idempotency: a full second `apply` run performs no further writes
 *       to rows already resolved on the first run (spot-checked)
 *   (o) untouched rows: a fixture unrelated to every list is byte-identical
 *       before/after apply
 *   (p) dry-run performs zero writes anywhere (spot-checked across
 *       categories) while reporting the same shape apply would
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

export function runOpplevelserGardssalgDrikkelisteRemediationTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-drikkeliste-remediation-test-key";
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

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregCacheForTesting();

      const auth = { "x-admin-key": testKey };

      // ── Fixture-seeding helper — copied from
      // opplevelser-gardssalg-set-terminal-status.test.ts, extended with the
      // columns this batch's resolvers/pick-survivor logic also read. ──────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            about_text, products, brreg_verified, catalog_hidden, slug, field_provenance,
            merged_into, terminal_status, postnummer, poststed,
            producer_type, enrichment_state, verification_status, source, confidence,
            created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            @about_text, @products, @brreg_verified, @catalog_hidden, @slug, @field_provenance,
            @merged_into, @terminal_status, @postnummer, @poststed,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          about_text: null, products: null, brreg_verified: 0, catalog_hidden: null, slug: null,
          field_provenance: null, merged_into: null, terminal_status: null, postnummer: null, poststed: null,
          created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getRow(id: string): any {
        return expDb.prepare(
          `SELECT id, navn, org_nr, hjemmeside, merged_into, terminal_status FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // ══════════════════════════════════════════════════════════════════
      // (a) applyGardssalgSetOrgNr — direct service coverage
      // ══════════════════════════════════════════════════════════════════
      mkProvider({ id: "onr-a", navn: "Org Nr Test A", org_nr: "911111111", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "onr-b", navn: "Org Nr Test B", org_nr: null, created_at: "2026-01-01 00:00:00" });

      const onrHappy = store.applyGardssalgSetOrgNr("onr-b", "922222222", "test correction", undefined);
      assertTrue(onrHappy.ok === true, "a1: happy-path correction succeeds");
      if (onrHappy.ok) {
        assertEq(onrHappy.old_value, null, "a2: old_value is prior (blank) org_nr");
        assertEq(onrHappy.new_value, "922222222", "a3: new_value is the corrected org_nr");
      }
      assertEq(getRow("onr-b").org_nr, "922222222", "a4: DB row actually updated");
      const onrAudit = getAuditRows("onr-b");
      assertEq(onrAudit.length, 1, "a5: exactly one audit row");
      assertEq(onrAudit[0].field_name, "org_nr", "a6: audit field_name is org_nr");

      const onrInvalid = store.applyGardssalgSetOrgNr("onr-a", "not-9-digits", "test", undefined);
      assertTrue(onrInvalid.ok === false && onrInvalid.reason === "invalid_format", "a7: non-9-digit org_nr -> invalid_format");

      const onrConflict = store.applyGardssalgSetOrgNr("onr-b", "911111111", "test", undefined);
      assertTrue(
        onrConflict.ok === false && onrConflict.reason === "org_nr_conflict" && (onrConflict as any).conflicting_provider_id === "onr-a",
        "a8: org_nr already held by another row -> org_nr_conflict with conflicting_provider_id",
      );
      assertEq(getRow("onr-b").org_nr, "922222222", "a9: rejected conflict write left onr-b untouched");

      const onrNotFound = store.applyGardssalgSetOrgNr("does-not-exist", "933333333", "test", undefined);
      assertTrue(onrNotFound.ok === false && onrNotFound.reason === "provider_not_found", "a10: unknown id -> provider_not_found");

      const onrClear = store.applyGardssalgSetOrgNr("onr-a", null, "rollback test", undefined);
      assertTrue(onrClear.ok === true && (onrClear as any).new_value === null, "a11: org_nr: null clears the column");
      assertEq(getRow("onr-a").org_nr, null, "a12: DB row cleared");

      // ══════════════════════════════════════════════════════════════════
      // (b) applyGardssalgSetHjemmeside — direct service coverage
      // ══════════════════════════════════════════════════════════════════
      mkProvider({ id: "hj-a", navn: "Hjemmeside Test A", hjemmeside: "https://wrong.example", created_at: "2026-01-01 00:00:00" });

      const hjHappy = store.applyGardssalgSetHjemmeside("hj-a", "https://correct.example", "test correction", undefined);
      assertTrue(hjHappy.ok === true, "b1: happy-path correction succeeds");
      assertEq(getRow("hj-a").hjemmeside, "https://correct.example", "b2: DB row updated");

      const hjClear = store.applyGardssalgSetHjemmeside("hj-a", null, "dead site", undefined);
      assertTrue(hjClear.ok === true && (hjClear as any).new_value === null, "b3: hjemmeside: null clears the column");
      assertEq(getRow("hj-a").hjemmeside, null, "b4: DB row cleared");

      const hjNotFound = store.applyGardssalgSetHjemmeside("does-not-exist", "https://x.example", "test", undefined);
      assertTrue(hjNotFound.ok === false && (hjNotFound as any).reason === "provider_not_found", "b5: unknown id -> provider_not_found");

      // ══════════════════════════════════════════════════════════════════
      // (c) HTTP routes: auth, validation, response shape
      // ══════════════════════════════════════════════════════════════════
      const unauthOrgNr = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-set-org-nr", body: {} });
      assertEq(unauthOrgNr.status, 403, "c1: gardssalg-set-org-nr unauthenticated -> 403");
      const unauthHj = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-set-hjemmeside", body: {} });
      assertEq(unauthHj.status, 403, "c2: gardssalg-set-hjemmeside unauthenticated -> 403");

      mkProvider({ id: "route-onr", navn: "Route OrgNr Gard", org_nr: null, created_at: "2026-01-01 00:00:00" });
      const routeOnrRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-set-org-nr", headers: auth,
        body: { provider_id: "route-onr", org_nr: "944444444", reason: "route test" },
      });
      assertEq(routeOnrRes.status, 200, "c3: route happy path -> 200");
      assertEq(routeOnrRes.body, {
        success: true, provider_id: "route-onr", field: "org_nr", old_value: null, new_value: "944444444",
      }, "c4: response shape matches spec exactly");

      const routeOnrMissingReason = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-set-org-nr", headers: auth,
        body: { provider_id: "route-onr", org_nr: "955555555" },
      });
      assertEq(routeOnrMissingReason.status, 400, "c5: missing reason -> 400");
      assertEq(routeOnrMissingReason.body.error, "reason_required", "c6: error code reason_required");

      const routeOnrMissingId = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-set-org-nr", headers: auth,
        body: { org_nr: "955555555", reason: "x" },
      });
      assertEq(routeOnrMissingId.status, 400, "c7: missing provider_id -> 400 provider_id_required");
      assertEq(routeOnrMissingId.body.error, "provider_id_required", "c7b: error code provider_id_required");

      mkProvider({ id: "route-hj", navn: "Route Hjemmeside Gard", hjemmeside: null, created_at: "2026-01-01 00:00:00" });
      const routeHjRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-set-hjemmeside", headers: auth,
        body: { provider_id: "route-hj", hjemmeside: "https://ok.example", reason: "route test" },
      });
      assertEq(routeHjRes.body, {
        success: true, provider_id: "route-hj", field: "hjemmeside", old_value: null, new_value: "https://ok.example",
      }, "c8: hjemmeside route response shape matches spec exactly");

      const routeHjBlank = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-set-hjemmeside", headers: auth,
        body: { provider_id: "route-hj", hjemmeside: "   ", reason: "x" },
      });
      assertEq(routeHjBlank.status, 400, "c9: blank-string hjemmeside (must be null to clear) -> 400");
      assertEq(routeHjBlank.body.error, "invalid_hjemmeside", "c10: error code invalid_hjemmeside");

      // ══════════════════════════════════════════════════════════════════
      // Orchestrator fixtures — the §4a-§4e catalog-cleanup batch itself.
      // ══════════════════════════════════════════════════════════════════

      // (d) §4a merge-vs-in-place-correction branching ─────────────────────
      // d-conflict: Njot -> Aga Sideri — TARGET row already exists, but BOTH
      // sides already carry their OWN distinct, populated org.nr (exactly
      // as the report states them). The merge lever's own fail-closed guard
      // (gardssalg-provider-merge.ts's evaluatePair: two distinct non-blank
      // org.nr values is treated as positive proof of two separate
      // companies) correctly REJECTS this pair — this module calls the
      // existing primitive as instructed and reports that rejection
      // verbatim, rather than working around a safety guard the rest of
      // the codebase relies on. See the final report for why this affects
      // most "operating row exists" §4a items with two already-populated
      // org numbers, not just this one.
      mkProvider({ id: "njot", navn: "Njot", org_nr: "928791432", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "aga-sideri", navn: "Aga Sideri", org_nr: "933780929", created_at: "2026-01-01 00:00:00" });
      // d1: Svalbard Distillery -> Svalbard Bryggeri AS — TARGET row already
      // exists AND the source row's own org.nr is genuinely blank (the
      // report gives no org.nr for this source, only a name) -> the merge
      // succeeds cleanly (no org_nr conflict possible when one side is
      // blank). This is the real "target row exists -> merge succeeds"
      // demonstration.
      mkProvider({ id: "svalbard-distillery", navn: "Svalbard Distillery", org_nr: null, created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "svalbard-bryggeri", navn: "Svalbard Bryggeri AS", org_nr: "919176547", created_at: "2026-01-01 00:00:00" });
      // d2: Guajiro Holding — TARGET row does NOT exist -> in-place correction branch.
      mkProvider({ id: "guajiro-holding", navn: "Guajiro Holding", org_nr: "924944870", created_at: "2026-01-01 00:00:00" });
      // (No "Guajiro Gårdsdrift" row seeded — that's the point of this fixture.)

      // (e) Fjellbryggeriet DA ×2 -> AS (no AS row seeded).
      mkProvider({ id: "fjell-da-1", navn: "Fjellbryggeriet DA", org_nr: "995720329", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "fjell-da-2", navn: "Fjellbryggeriet DA", org_nr: null, created_at: "2026-01-02 00:00:00" });

      // (f) Skifjorden coop + operating-AS — both survive, twin-link only.
      mkProvider({ id: "skifjorden-coop", navn: "Skifjorden SA", org_nr: "912748146", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "skifjorden-as", navn: "Skifjorden Bryggeri AS", org_nr: "918608893", created_at: "2026-01-01 00:00:00" });

      // (g) Lundetangen — unresolvable target -> terminal-mark.
      mkProvider({ id: "lundetangen", navn: "Lundetangen", org_nr: "966488948", created_at: "2026-01-01 00:00:00" });

      // (h) Hardanger Handbryggeri — org.nr missing, deferred to §4e.
      mkProvider({ id: "hardanger-hand", navn: "Hardanger Handbryggeri", org_nr: null, created_at: "2026-01-01 00:00:00" });

      // (i) unresolved sample: "Simple Spotting" deliberately NOT seeded.

      // (j) §4b fixtures.
      mkProvider({ id: "st-hallvards", navn: "St.Hallvards SA", org_nr: "936739547", created_at: "2026-01-01 00:00:00" });
      // Vestavin: simulate "already adopted under Ystebakken" — merged_into
      // set, org_nr cleared (mirrors what a real merge would have done).
      mkProvider({ id: "ystebakken", navn: "Ystebakken", org_nr: "937441290", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "vestavin", navn: "Vestavin", org_nr: null, merged_into: "ystebakken", created_at: "2026-01-01 00:00:00" });
      // Telemark Bryggeri: §4b (brreg_slettet) AND §4e (missing org.nr) both
      // target this SAME row — independent fields, both should fire.
      mkProvider({ id: "telemark-bryggeri", navn: "Telemark Bryggeri AS", org_nr: null, postnummer: "3800", poststed: "Bø", created_at: "2026-01-01 00:00:00" });

      // (k) §4c fixtures: a genuine duplicate pair (better-data row wins as
      // keep), and the Fjellbryggeriet-leftover pair (ambiguous by design —
      // matching rows DO exist here, on purpose, to prove the by-design
      // refusal isn't just "nothing matched").
      mkProvider({
        id: "grana-1", navn: "Grana Bryggeri", org_nr: "940000001", epost: "post@grana.no",
        hjemmeside: "https://grana.no", created_at: "2026-01-01 00:00:00",
      });
      mkProvider({ id: "grana-2", navn: "Grana Bryggeri", org_nr: null, created_at: "2026-01-02 00:00:00" });
      // fjell-da-1/fjell-da-2 above already both match "Fjellbryggeriet" —
      // proving §4c's Fjellbryggeriet-leftover item stays unresolved
      // regardless (it's flagged ambiguousByDesign and never even attempts
      // a name lookup).

      // (l) §4d fixtures.
      mkProvider({ id: "myken", navn: "Myken Destilleri", hjemmeside: "https://wrong-myken.example", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "marlobobo-row", navn: "Marlobobo Gard", hjemmeside: "https://marlobobo.no/old", created_at: "2026-01-01 00:00:00" });

      // (m) §4e fixtures.
      mkProvider({ id: "killi", navn: "Killi Mikrobryggeri", org_nr: null, postnummer: "9050", poststed: "Storsteinnes", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "fossmoen", navn: "Fossmoen Frukt", org_nr: null, postnummer: "5300", poststed: "Kleppestø", created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "hunsfos", navn: "Hunsfos Bryggeri", org_nr: null, postnummer: "9999", poststed: null, created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "hardanger-hand-4e", navn: "Hardanger Handbryggeri Butikk", org_nr: null, created_at: "2026-01-01 00:00:00" });

      // (o) untouched-row control fixture — unrelated to every list.
      mkProvider({
        id: "untouched", navn: "Untouched Reference Gard", org_nr: "900000000",
        hjemmeside: "https://untouched.example", created_at: "2026-01-01 00:00:00",
      });

      // ── Brreg stub for the §4e sub-step (uses the SAME
      // callGardssalgAdminRouteInProcess -> POST /admin/gardssalg-orgnr-backfill
      // in-process path as the existing route) ────────────────────────────
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        const dm = u.match(/\/enheter\/(\d{9})$/);
        if (dm) {
          return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: dm[1], navn: "SUNN TESTENHET AS" }) } as unknown as Response;
        }
        // Killi -> exact match at the report's expected org.nr, corroborated.
        if (u.includes("navn=Killi%20Mikrobryggeri")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "924960884", navn: "Killi Mikrobryggeri",
              forretningsadresse: { adresse: ["Vei 1"], postnummer: "9050", poststed: "Storsteinnes" },
            }] } }),
          } as unknown as Response;
        }
        // Fossmoen -> exact match, but at a DIFFERENT org.nr than the report
        // states (backfilled_mismatch case).
        if (u.includes("navn=Fossmoen%20Frukt")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "986427599", navn: "Fossmoen Frukt",
              forretningsadresse: { adresse: ["Vei 2"], postnummer: "5300", poststed: "Kleppestø" },
            }] } }),
          } as unknown as Response;
        }
        // Hunsfos -> exact name match but postal does NOT corroborate ->
        // needs_human_review (backfilled_vetoed case).
        if (u.includes("navn=Hunsfos%20Bryggeri")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "913052803", navn: "Hunsfos Bryggeri",
              forretningsadresse: { adresse: ["Vei 3"], postnummer: "4600", poststed: "Kristiansand" },
            }] } }),
          } as unknown as Response;
        }
        if (u.includes("navn=Telemark%20Bryggeri%20AS")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [{
              organisasjonsnummer: "987141662", navn: "Telemark Bryggeri AS",
              forretningsadresse: { adresse: ["Vei 4"], postnummer: "3800", poststed: "Bø" },
            }] } }),
          } as unknown as Response;
        }
        if (u.includes("navn=Hardanger%20Handbryggeri%20Butikk")) {
          return {
            ok: true, status: 200,
            json: async () => ({ _embedded: { enheter: [] } }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      // ══════════════════════════════════════════════════════════════════
      // (p) DRY RUN — zero writes anywhere, same response shape as apply.
      // ══════════════════════════════════════════════════════════════════
      const dryRes = await callRoute(opplevelserRouter, { headers: auth, body: { apply: false, batch_id: "test-batch-1" } });
      assertEq(dryRes.status, 200, "p1: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "p2: dry_run:true");
      assertEq(dryRes.body.batch_id, "test-batch-1", "p3: caller-supplied batch_id echoed");

      function findResult(body: any, key: string): any {
        return (body.results as any[]).find((r) => r.key === key);
      }

      // (d-conflict) org_nr-conflict guard fires as designed — reported, not bypassed.
      const dryNjot = findResult(dryRes.body, "njot-aga-sideri");
      assertEq(dryNjot.method, "merge", "dc1: Njot (target exists) is attempted via the merge lever, as instructed");
      assertEq(dryNjot.outcome, "rejected", "dc2: Njot/Aga Sideri — both sides have distinct populated org.nr -> merge lever's own fail-closed guard rejects it");
      assertEq(dryNjot.reason, "org_nr_konflikt_ulike_org_nr", "dc3: rejection reason is the merge lever's own guard, verbatim");
      assertEq(dryNjot.remove_id, "njot", "dc4: Njot is remove_id");
      assertEq(dryNjot.keep_id, "aga-sideri", "dc5: Aga Sideri is keep_id");
      assertEq(getRow("njot").merged_into, null, "dc6: dry-run performed ZERO writes on Njot");

      // (d) merge-vs-in-place branching, dry-run shape (the successful-merge case).
      const drySvalbard = findResult(dryRes.body, "svalbard-distillery");
      assertEq(drySvalbard.method, "merge", "d1: Svalbard Distillery (target exists, source org_nr blank) previews as merge");
      assertEq(drySvalbard.outcome, "would_merge", "d2: Svalbard dry-run outcome would_merge — no org_nr conflict possible when one side is blank");
      assertEq(drySvalbard.remove_id, "svalbard-distillery", "d3: Svalbard Distillery is remove_id");
      assertEq(drySvalbard.keep_id, "svalbard-bryggeri", "d4: Svalbard Bryggeri AS is keep_id");
      assertEq(getRow("svalbard-distillery").merged_into, null, "d5: dry-run performed ZERO writes on Svalbard Distillery");

      const dryGuajiro = findResult(dryRes.body, "guajiro-holding");
      assertEq(dryGuajiro.method, "org_nr_correction", "d6: Guajiro Holding (no target row) previews as org_nr_correction");
      assertEq(dryGuajiro.outcome, "would_correct_org_nr", "d7: Guajiro Holding dry-run outcome would_correct_org_nr");
      assertEq(dryGuajiro.old_value, "924944870", "d8: old_value is Guajiro Holding's current org_nr");
      assertEq(dryGuajiro.new_value, "932165422", "d9: new_value is the target operating org_nr");
      assertEq(getRow("guajiro-holding").org_nr, "924944870", "d10: dry-run performed ZERO writes on Guajiro Holding");

      // (e) Fjellbryggeriet ×2, dry-run: virtual overlay reproduces the
      // sequential correct-then-merge branching WITHOUT any real writes.
      const dryFjell = (dryRes.body.results as any[]).filter((r) => r.key === "fjellbryggeriet-da-as");
      assertEq(dryFjell.length, 2, "e1: two source rows produce two result entries");
      const dryFjellOrgNr = dryFjell.find((r) => r.method === "org_nr_correction");
      const dryFjellMerge = dryFjell.find((r) => r.method === "merge");
      assertTrue(!!dryFjellOrgNr, "e2: exactly one of the two is the in-place correction (first, org.nr-selector)");
      assertTrue(!!dryFjellMerge, "e3: the other is a merge (second, name-only selector, into the virtually-corrected first)");
      assertEq(dryFjellOrgNr.provider_id, "fjell-da-1", "e4: fjell-da-1 (has the org.nr selector) is the one that would self-correct");
      assertEq(dryFjellOrgNr.new_value, "916476450", "e5: corrects to the Fjellbryggeriet AS org.nr");
      assertEq(dryFjellMerge.remove_id, "fjell-da-2", "e6: fjell-da-2 is the one that would merge");
      assertEq(dryFjellMerge.keep_id, "fjell-da-1", "e7: it would merge into the (virtually) corrected fjell-da-1");
      assertEq(getRow("fjell-da-1").org_nr, "995720329", "e8: dry-run performed ZERO real writes (fjell-da-1 unchanged)");

      // (f) Skifjorden, dry-run.
      const dryTwin = findResult(dryRes.body, "skifjorden-twin-link");
      assertEq(dryTwin.method, "twin_link", "f1: Skifjorden method is twin_link");
      assertEq(dryTwin.outcome, "would_twin_link", "f2: dry-run outcome would_twin_link");
      assertEq(getAuditRows("skifjorden-coop").length, 0, "f3: dry-run inserted ZERO audit rows");

      // (g) Lundetangen, dry-run.
      const dryLunde = findResult(dryRes.body, "lundetangen");
      assertEq(dryLunde.method, "terminal_status", "g1: Lundetangen method is terminal_status");
      assertEq(dryLunde.outcome, "would_terminal_mark", "g2: dry-run outcome would_terminal_mark");
      assertEq(dryLunde.new_value, "dod_kilde", "g3: would-be new_value is dod_kilde");
      assertEq(getRow("lundetangen").terminal_status, null, "g4: dry-run performed ZERO writes");

      // (h) defer-to-4e.
      const dryDefer = findResult(dryRes.body, "hardanger-handbryggeri-orgnr");
      assertEq(dryDefer.outcome, "deferred_to_4e", "h1: Hardanger Handbryggeri §4a entry always reports deferred_to_4e");

      // (i) unresolved sample.
      const dryUnresolved = findResult(dryRes.body, "simple-spotting");
      assertEq(dryUnresolved.outcome, "unresolved", "i1: unseeded §4a row (Simple Spotting) -> unresolved");
      assertEq(dryUnresolved.reason, "source_not_found", "i2: reason is source_not_found, not a guess");

      // (j) §4b dry-run.
      const dryStHallvards = findResult(dryRes.body, "st-hallvards-sa");
      assertEq(dryStHallvards.outcome, "would_terminal_mark", "j1: St.Hallvards SA would be terminal-marked");
      assertTrue(String(dryStHallvards.reason).includes("konkursbo_kbo"), "j2: reason embeds the evidence class");
      const dryVestavin = findResult(dryRes.body, "vestavin");
      assertEq(dryVestavin.outcome, "already_merged_skip", "j3: Vestavin (already merged under Ystebakken) -> already_merged_skip, not reprocessed");

      // (k) §4c dry-run.
      const dryGrana = findResult(dryRes.body, "grana-bryggeri");
      assertEq(dryGrana.method, "merge", "k1: Grana Bryggeri duplicate pair previews as merge");
      assertEq(dryGrana.keep_id, "grana-1", "k2: the more-complete row (org_nr+epost+hjemmeside) is the keep survivor");
      assertEq(dryGrana.remove_id, "grana-2", "k3: the blanker row is the remove");
      const dryFjellLeftover = findResult(dryRes.body, "fjellbryggeriet-leftover-pair");
      assertEq(dryFjellLeftover.outcome, "unresolved", "k4: Fjellbryggeriet leftover pair is unresolved BY DESIGN");
      assertEq(dryFjellLeftover.reason, "ambiguous_name_collision_with_4a_fjellbryggeriet_by_design", "k5: reason names the deliberate refusal");

      // (l) §4d dry-run.
      const dryMyken = findResult(dryRes.body, "myken-destilleri");
      assertEq(dryMyken.outcome, "would_correct_hjemmeside", "l1: Myken Destilleri would be corrected");
      assertEq(dryMyken.new_value, "https://mykendistillery.com", "l2: corrects to the report's stated value");
      const dryMarlobobo = findResult(dryRes.body, "marlobobo");
      assertEq(dryMarlobobo.outcome, "would_correct_hjemmeside", "l3: Marlobobo (resolved by website substring) would be corrected");
      assertEq(dryMarlobobo.new_value, null, "l4: nulled (dead site)");

      // (m) §4e dry-run cross-check.
      const dryKilli = findResult(dryRes.body, "killi-mikrobryggeri");
      assertEq(dryKilli.outcome, "would_backfill_match", "m1: Killi dry-run matches the report's expected org.nr");
      assertEq(dryKilli.new_value, "924960884", "m2: candidate org.nr matches");
      const dryFossmoen = findResult(dryRes.body, "fossmoen-frukt");
      assertEq(dryFossmoen.outcome, "backfilled_mismatch", "m3: Fossmoen — route's own Brreg resolution DIFFERS from report -> mismatch, not silently trusted");
      assertEq(dryFossmoen.new_value, "986427599", "m4: reports the route's own resolved value");
      assertEq(dryFossmoen.expected_value, "986427538", "m5: AND the report's expected value, both shown");
      const dryHunsfos = findResult(dryRes.body, "hunsfos-bryggeri");
      assertEq(dryHunsfos.outcome, "backfilled_vetoed", "m6: Hunsfos — postal corroboration fails -> vetoed, never auto-written");
      const dryTelemarkB = (dryRes.body.results as any[]).filter((r) => r.key === "telemark-bryggeri");
      assertEq(dryTelemarkB.length, 2, "m7: Telemark Bryggeri appears once for §4b and once for §4e — independent fields");
      const dryTelemark4b = dryTelemarkB.find((r) => r.category === "4b");
      const dryTelemark4e = dryTelemarkB.find((r) => r.category === "4e");
      assertEq(dryTelemark4b.outcome, "would_terminal_mark", "m8: §4b side would terminal-mark");
      assertEq(dryTelemark4e.outcome, "would_backfill_match", "m9: §4e side would backfill org.nr — both fire independently");

      // ══════════════════════════════════════════════════════════════════
      // APPLY — first real run.
      // ══════════════════════════════════════════════════════════════════
      const applyRes = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true, batch_id: "test-batch-1" } });
      assertEq(applyRes.status, 200, "apply1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "apply2: dry_run:false");

      // (d-conflict / d) merge-vs-in-place, applied.
      assertEq(getRow("njot").merged_into, null, "dc7: Njot still NOT merged under apply — the guard applies at apply-time too, not just preview");
      assertEq(getRow("njot").org_nr, "928791432", "dc8: Njot's own org_nr untouched by the rejected merge attempt");
      assertEq(getRow("svalbard-distillery").merged_into, "svalbard-bryggeri", "d11: Svalbard Distillery actually merged into Svalbard Bryggeri AS");
      assertEq(getRow("guajiro-holding").org_nr, "932165422", "d12: Guajiro Holding's org_nr actually corrected in place");

      // (e) Fjellbryggeriet ×2, applied: real DB state now matches the
      // dry-run's virtual-overlay prediction exactly.
      assertEq(getRow("fjell-da-1").org_nr, "916476450", "e9: fjell-da-1 actually corrected to the AS org.nr");
      assertEq(getRow("fjell-da-2").merged_into, "fjell-da-1", "e10: fjell-da-2 actually merged into the now-corrected fjell-da-1");

      // (f) Skifjorden, applied: BOTH rows survive untouched (no merge, no
      // terminal mark), only the twin-link audit note was written.
      assertEq(getRow("skifjorden-coop").merged_into, null, "f4: Skifjorden coop row survives, not merged");
      assertEq(getRow("skifjorden-as").merged_into, null, "f5: Skifjorden AS row survives, not merged");
      assertEq(getRow("skifjorden-coop").terminal_status, null, "f6: neither row was terminal-marked");
      const coopTwinAudit = getAuditRows("skifjorden-coop").filter((r) => r.field_name === "twin_link");
      assertEq(coopTwinAudit.length, 1, "f7: exactly one twin_link audit row on the coop side");
      assertEq(coopTwinAudit[0].new_value, "skifjorden-as", "f8: it points at the AS row's id");
      const asTwinAudit = getAuditRows("skifjorden-as").filter((r) => r.field_name === "twin_link");
      assertEq(asTwinAudit.length, 1, "f9: exactly one twin_link audit row on the AS side too");

      // (g) Lundetangen, applied.
      assertEq(getRow("lundetangen").terminal_status, "dod_kilde", "g5: Lundetangen actually terminal-marked");

      // (j) §4b, applied.
      assertEq(getRow("st-hallvards").terminal_status, "dod_kilde", "j4: St.Hallvards SA actually terminal-marked");

      // (k) §4c, applied.
      assertEq(getRow("grana-2").merged_into, "grana-1", "k6: Grana duplicate actually merged");

      // (l) §4d, applied.
      assertEq(getRow("myken").hjemmeside, "https://mykendistillery.com", "l5: Myken Destilleri hjemmeside actually corrected");
      assertEq(getRow("marlobobo-row").hjemmeside, null, "l6: Marlobobo hjemmeside actually nulled");

      // (m) §4e, applied.
      assertEq(getRow("killi").org_nr, "924960884", "m10: Killi org_nr actually backfilled to the matching value");
      assertEq(getRow("fossmoen").org_nr, "986427599", "m11: Fossmoen — the ROUTE'S resolved value is what's written (mismatch is reported, not silently overridden by the report's expectation)");
      assertEq(getRow("hunsfos").org_nr, null, "m12: Hunsfos — vetoed candidate is never auto-written");
      assertEq(getRow("telemark-bryggeri").terminal_status, "dod_kilde", "m13: Telemark Bryggeri §4b side applied");
      assertEq(getRow("telemark-bryggeri").org_nr, "987141662", "m14: Telemark Bryggeri §4e side ALSO applied — same row, independent fields");

      // (h) defer-to-4e still reports deferred (never itself writes) even
      // under apply — the actual write for this row happened via the §4e
      // "hardanger-hand-4e" fixture instead (a separate row in this test,
      // since the real-world "same row" case can't be modeled without
      // conflating the two fixtures; the deferral behaviour itself is what's
      // under test here).
      const applyDefer = findResult(applyRes.body, "hardanger-handbryggeri-orgnr");
      assertEq(applyDefer.outcome, "deferred_to_4e", "h2: still deferred_to_4e under apply — never writes itself");
      assertEq(getRow("hardanger-hand").org_nr, null, "h3: the §4a-side fixture itself is untouched by this route");

      // (o) untouched-row control: byte-identical before/after.
      const untouchedAfter = getRow("untouched");
      assertEq(untouchedAfter.org_nr, "900000000", "o1: untouched row's org_nr unchanged");
      assertEq(untouchedAfter.hjemmeside, "https://untouched.example", "o2: untouched row's hjemmeside unchanged");
      assertEq(untouchedAfter.merged_into, null, "o3: untouched row not merged");
      assertEq(untouchedAfter.terminal_status, null, "o4: untouched row not terminal-marked");
      assertEq(getAuditRows("untouched").length, 0, "o5: zero audit rows for the untouched row");

      // before_count === after_count: nothing is ever hard-deleted.
      assertEq(applyRes.body.before_count, applyRes.body.after_count, "apply3: before_count === after_count — no row ever hard-deleted");

      // ══════════════════════════════════════════════════════════════════
      // (n) idempotency — a second full apply run performs no further
      // incorrect/duplicate writes on rows already resolved.
      // ══════════════════════════════════════════════════════════════════
      const audit_svalbard_before = getAuditRows("svalbard-distillery").length;
      const audit_guajiro_before = getAuditRows("guajiro-holding").length;
      const audit_skifjorden_before = getAuditRows("skifjorden-coop").length;
      const audit_st_hallvards_before = getAuditRows("st-hallvards").length;

      const applyRes2 = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true, batch_id: "test-batch-2" } });
      assertEq(applyRes2.status, 200, "n1: second apply -> 200 (no crash)");

      // Svalbard: on a rerun, name-based source resolution naturally excludes
      // the now-already-merged row (findByNameContains's default
      // merged_into IS NULL filter) -> unresolved, not re-found/re-merged.
      // Either way the key idempotency property holds: zero further writes.
      const svalbardResult2 = findResult(applyRes2.body, "svalbard-distillery");
      assertEq(svalbardResult2.outcome, "unresolved", "n2: second apply on Svalbard -> unresolved (already-merged row excluded from name lookup), not re-merged");
      assertEq(getAuditRows("svalbard-distillery").length, audit_svalbard_before, "n3: no new audit rows for Svalbard on the second apply");
      assertEq(getRow("svalbard-distillery").merged_into, "svalbard-bryggeri", "n4: Svalbard's merged_into unchanged by the second apply");

      // Guajiro: org.nr-selector no longer matches (org.nr changed), name
      // fallback finds the SAME (now self-corrected) row as its own target
      // -> reported unresolved, zero further writes — the key idempotency
      // property (never re-corrects/never mis-corrects on a rerun).
      const guajiroResult2 = findResult(applyRes2.body, "guajiro-holding");
      assertTrue(guajiroResult2.outcome !== "org_nr_corrected", "n5: second apply never re-writes Guajiro Holding's org_nr");
      assertEq(getAuditRows("guajiro-holding").length, audit_guajiro_before, "n6: no new audit rows for Guajiro Holding on the second apply");
      assertEq(getRow("guajiro-holding").org_nr, "932165422", "n7: Guajiro Holding's org_nr unchanged by the second apply");

      // Skifjorden: twin-link dedup guard prevents duplicate audit rows.
      const twinResult2 = findResult(applyRes2.body, "skifjorden-twin-link");
      assertEq(twinResult2.outcome, "already_twin_linked", "n8: second apply reports already_twin_linked");
      assertEq(getAuditRows("skifjorden-coop").length, audit_skifjorden_before, "n9: no duplicate twin_link audit row inserted");

      // St.Hallvards: already-terminal guard prevents a redundant write.
      const stHallvardsResult2 = findResult(applyRes2.body, "st-hallvards-sa");
      assertEq(stHallvardsResult2.outcome, "already_terminal", "n10: second apply reports already_terminal");
      assertEq(getAuditRows("st-hallvards").length, audit_st_hallvards_before, "n11: no new audit rows for St.Hallvards on the second apply");

      // Lundetangen: already-terminal guard (the §4a special-case branch).
      const lundeResult2 = findResult(applyRes2.body, "lundetangen");
      assertEq(lundeResult2.outcome, "already_terminal", "n12: Lundetangen — second apply reports already_terminal (§4a terminal_dead_source branch guarded too)");

      // ══════════════════════════════════════════════════════════════════
      // Summary shape sanity.
      // ══════════════════════════════════════════════════════════════════
      assertTrue(typeof applyRes.body.summary.total === "number" && applyRes.body.summary.total > 0, "sum1: summary.total is a positive number");
      assertTrue(!!applyRes.body.summary.by_category["4a"], "sum2: summary.by_category has a 4a bucket");
      assertTrue(!!applyRes.body.summary.by_category["4b"], "sum3: summary.by_category has a 4b bucket");
      assertTrue(!!applyRes.body.summary.by_category["4c"], "sum4: summary.by_category has a 4c bucket");
      assertTrue(!!applyRes.body.summary.by_category["4d"], "sum5: summary.by_category has a 4d bucket");
      assertTrue(!!applyRes.body.summary.by_category["4e"], "sum6: summary.by_category has a 4e bucket");
      assertTrue(Array.isArray(applyRes.body.unresolved), "sum7: unresolved is an array");
      assertTrue(
        applyRes.body.unresolved.some((r: any) => r.key === "simple-spotting"),
        "sum8: unresolved[] includes the sample unresolved row",
      );

      // Unauthenticated orchestrator route.
      const unauthRemediation = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauthRemediation.status, 403, "auth1: gardssalg-drikkeliste-remediation unauthenticated -> 403");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drikkeliste-remediation: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-drikkeliste-remediation.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgDrikkelisteRemediationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
