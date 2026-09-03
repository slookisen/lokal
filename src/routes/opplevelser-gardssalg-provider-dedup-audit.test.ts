/**
 * opplevelser-gardssalg-provider-dedup-audit.test.ts — tests for
 * GET /admin/gardssalg-provider-dedup-audit (src/routes/opplevelser.ts).
 *
 * dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
 * slice 1 of 3 (read-only audit only — no merge lever, no outreach-guard).
 *
 * Coverage measurement on 2026-07-31 found near-duplicate experience_providers
 * rows across seed batches (same real-world producer, two ids), e.g. a sparse
 * homepage_unreachable_since-flagged row vs a richer contact-complete row
 * discovered later. This endpoint groups candidate duplicates by org_nr /
 * website registrable-domain / name (scoreNameMatch, brreg-client.ts) — never
 * writes, never merges.
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, raw SQL INSERT fixtures).
 *
 * Covers (acceptance criteria from the dev-request):
 *   (a) 403 without X-Admin-Key
 *   (b) name-signal group at the "first token + same postal" tier (0.95) —
 *       the Wilsgård Bryggeri — Torsken / Wilsgård shape — grouped, but only
 *       LOW confidence (dev-request 2026-08-18-gardssalg-dedup-org-nr-
 *       override, point 1: name_first_token_postal alone must NEVER produce
 *       "high" — it's a hint for human review, not a merge basis; this
 *       fixture used to assert HIGH here, which was exactly the 17-false-
 *       high bug that dev-request fixed), signal "name_first_token_postal"
 *       still present/reported, confidence_signals empty
 *   (c) name-signal group at the "first token only" tier (0.80) — the
 *       Himkok / Himkok Rtd shape — grouped, but flagged LOW confidence,
 *       signal "name_first_token" only (never silently dropped, never
 *       silently treated as equally certain as an exact match)
 *   (d) exact-name-signal group — the Kinn Bryggeri / Kinn Bryggeri shape —
 *       grouped, HIGH confidence, signal "name_exact", confidence_signals
 *       includes "name_exact" — PLUS a third row "Kinn Bryggeri AS" (same
 *       dev-request, point 4a / acceptance #3): normaliseNamePruned
 *       (brreg-client.ts) already strips the bare legal-form suffix "AS"
 *       before the score===1.0 comparison, so this join was never actually
 *       broken — this is the regression proof that it still isn't, now that
 *       "high" requires an identity-bearing signal
 *   (e) org_nr-only signal group (distinct names/domains, same org_nr)
 *   (f) domain-only signal group (distinct names/org_nr, same registrable
 *       domain reached via a www./path variant) — one side's org_nr left
 *       blank so this fixture stays a clean "domain is the ONLY identity
 *       signal" case under the point-3 org_nr-override rule below (real
 *       cross-seed domain-duplicates in production are exactly this shape —
 *       a sparse early row with no org_nr yet vs a richer later one)
 *   (g) negative control — two genuinely different rows never appear
 *       together in any group, nor as a singleton "group"
 *   (h) non-gårdssalg row (no producer_type, not rfb-seed) and the synthetic
 *       test-gardssalg row are both excluded from the scan entirely
 *   (i) per-row response shape: only id/navn/org_nr/rfb_seed_source/
 *       producer_type/content_source/has_email/has_phone/unreachable/
 *       homepage_unreachable_since — never a raw epost/telefon/hjemmeside
 *       value anywhere in the response; group-level shape carries exactly
 *       signals/confidence/confidence_signals/corporate_group/
 *       org_nr_conflict/rows
 *   (j) has_email/has_phone/unreachable booleans computed correctly
 *   (k) zero net DB writes: row count and every fixture row's raw column
 *       values are byte-identical before vs after calling the endpoint
 *       TWICE, and no merge/delete-marker column exists on the table at all
 *   (l) dev-request 2026-08-18-gardssalg-dedup-org-nr-override, points 2/3:
 *       "high" requires an identity-bearing signal — a pair whose ONLY
 *       evidence is name_first_token_postal (Geiranger Brenneri / Geiranger
 *       Bryggeri shape, DIFFERENT populated org_nr on both sides) never
 *       grades high, org_nr_conflict:true on the group
 *   (m) point 3, override even against name_exact and domain: two rows with
 *       an EXACT name match but different, both-populated org_nr — stays
 *       LOW, "name_exact" still listed in `signals` but absent from
 *       `confidence_signals`; and separately, two rows sharing a domain but
 *       with different, both-populated org_nr — also stays LOW despite the
 *       domain match (a real production shape: one shared website listing
 *       two legally-distinct producer brands)
 *   (n) point 4, corporate-group label: "Fjording" vs "Fjording Holding" —
 *       grouped (still shares a first-token name signal), LOW confidence
 *       (no identity-bearing signal), but `corporate_group: true` — a label
 *       distinct from any duplicate-confidence tier
 *   (o) point 6, response schema: every group carries the new
 *       confidence_signals/corporate_group/org_nr_conflict fields with the
 *       correct shape (array/boolean/boolean) for both a high- and a
 *       low-confidence group
 *   (p) pure-function matrix, exercising gsDedupBestNameTier/
 *       gsDedupIsCorporateGroupPair (opplevelser.ts) DIRECTLY (no DB/HTTP
 *       round-trip) against every non-duplicate pair named in the dev-
 *       request's acceptance criteria #1 (13 pairs) plus the full
 *       AS/ASA/SA/ANS/DA (identity-preserving) vs Holding/Gruppen/Norge/
 *       "Supply Company" (corporate-group) suffix matrix — proves the name
 *       tier those 13 pairs land on is never name_exact (the only tier that
 *       can drive "high" post-fix), and that each corporate-group suffix
 *       word is individually detected
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg-provider-dedup-audit",
      originalUrl: "/admin/gardssalg-provider-dedup-audit",
      path: "/admin/gardssalg-provider-dedup-audit",
      query: {},
      headers: opts.headers || {},
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

export function runOpplevelserGardssalgProviderDedupAuditTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-provider-dedup-audit-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, postnummer, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, content_source, homepage_unreachable_since,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @postnummer, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @content_source, @homepage_unreachable_since,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── (b) name_first_token_postal — Wilsgård Bryggeri — Torsken / Wilsgård ──
      // Sparse, seeded-early row: no contact info at all, flagged unreachable.
      insertProvider.run({
        id: "prov-wilsgard-a", navn: "Wilsgård Bryggeri — Torsken", org_nr: null, postnummer: "9391",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: "2026-06-01T00:00:00.000Z",
      });
      // Richer, later-discovered row for the same postal area, full contact info.
      insertProvider.run({
        id: "prov-wilsgard-b", navn: "Wilsgård", org_nr: null, postnummer: "9391",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@wilsgaard.no", telefon: "99999999", hjemmeside: "https://www.wilsgaard.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (c) name_first_token (LOW confidence) — Himkok / Himkok Rtd ─────────
      // Different postal codes -> no postal corroboration -> stays at the
      // first-token-only (0.80) tier, a genuine judgment call.
      insertProvider.run({
        id: "prov-himkok-a", navn: "Himkok", org_nr: null, postnummer: "0150",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-himkok-b", navn: "Himkok Rtd", org_nr: null, postnummer: "0250",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@himkokrtd.no", telefon: "88888888", hjemmeside: "https://himkokrtd.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (d) name_exact — Kinn Bryggeri / Kinn Bryggeri ──────────────────────
      insertProvider.run({
        id: "prov-kinn-a", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-kinn-b", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@kinnbryggeri.no", telefon: "77777777", hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      // Third row, "AS"-suffixed — acceptance criterion #3 regression proof
      // (see file-header doc comment (d) above): must land in the SAME group.
      insertProvider.run({
        id: "prov-kinn-c", navn: "Kinn Bryggeri AS", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "destilleri",
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });

      // ── (e) org_nr-only — distinct names/domains, same org_nr ──────────────
      // NB: experience_providers.org_nr has a UNIQUE constraint (init-
      // experiences.ts), so two rows can never carry the LITERAL same org_nr
      // string — that's precisely why real cross-seed-source duplicates
      // (e.g. the Wilsgård pair) end up with only ONE side org_nr-populated
      // in practice. The one way two rows legitimately end up with the same
      // org_nr AFTER normalization while still satisfying the DB's raw
      // UNIQUE constraint is whitespace padding drift between seed sources
      // (" 900111222 " vs "900111222" — different raw strings, same number)
      // — used here to exercise the org_nr signal's own .trim() end-to-end
      // rather than only unit-testing the comparison in isolation.
      insertProvider.run({
        id: "prov-orgnr-a", navn: "Nordlys Utsalg AS", org_nr: "900111222", postnummer: null,
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://nordlys-utsalg.no",
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-orgnr-b", navn: "Object Produksjon AS", org_nr: " 900111222 ", postnummer: null,
        rfb_seed_source: null, producer_type: "destilleri",
        epost: "post@objectprod.no", telefon: null, hjemmeside: "https://annet-domene.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (f) domain-only — distinct names/org_nr, same registrable domain ───
      // (one reached via www. + a path, the other bare — must still collapse
      // to the same registrable domain via homepageRegistrableDomain).
      // prov-domain-b's org_nr is deliberately left BLANK (not merely
      // "different"): dev-request 2026-08-18-gardssalg-dedup-org-nr-override
      // point 3 makes two DIFFERENT, BOTH-POPULATED org_nr values override
      // even a domain match to LOW — real cross-seed domain-duplicates in
      // production are one-side-blank, matching the "Lofthus Sideri (one
      // missing org_nr)" acceptance example, not both-populated-different.
      insertProvider.run({
        id: "prov-domain-a", navn: "Sjømat Nord AS", org_nr: "111000111", postnummer: null,
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://www.sjomatprodukt.no/om-oss",
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-domain-b", navn: "Kystfisk Handel", org_nr: null, postnummer: null,
        rfb_seed_source: null, producer_type: "fiskeri",
        epost: "post@sjomatprodukt.no", telefon: null, hjemmeside: "http://sjomatprodukt.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (l) org_nr-override vs. name_first_token_postal — the actual
      // Geiranger Brenneri / Geiranger Bryggeri false-high shape: same first
      // name-word, same postal, DIFFERENT populated org_nr on both sides.
      insertProvider.run({
        id: "prov-geiranger-a", navn: "Geiranger Brenneri", org_nr: "600111222", postnummer: "6216",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-geiranger-b", navn: "Geiranger Bryggeri", org_nr: "600333444", postnummer: "6216",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@geirangerbryggeri.no", telefon: null, hjemmeside: null,
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (m1) org_nr-override vs. name_exact — identical normalized names,
      // DIFFERENT populated org_nr (two distinct companies sharing a plain
      // name is rare but must still never be graded high).
      insertProvider.run({
        id: "prov-nameexact-conflict-a", navn: "Nordheim Gårdsutsalg", org_nr: "700111222", postnummer: "2600",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-nameexact-conflict-b", navn: "Nordheim Gårdsutsalg", org_nr: "700333444", postnummer: "8900",
        rfb_seed_source: null, producer_type: "gardssalg",
        epost: "post@nordheim-annet.no", telefon: null, hjemmeside: null,
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (m2) org_nr-override vs. domain — a real "one shared website, two
      // legally-distinct producer brands" shape (the Svalbard/Bivrost real
      // example): shared registrable domain, DIFFERENT populated org_nr,
      // names that don't share a first token (so domain is the ONLY thing
      // connecting this pair at all).
      insertProvider.run({
        id: "prov-domainconflict-a", navn: "Iskaldt Destilleri", org_nr: "800111222", postnummer: "9170",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://polardrikke.no",
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-domainconflict-b", navn: "Bivrost Bryggeri", org_nr: "800333444", postnummer: "9170",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@polardrikke.no", telefon: null, hjemmeside: "https://www.polardrikke.no/bivrost",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (n) corporate-group label — "Fjording" vs "Fjording Holding":
      // shares a first-token name signal (so it still lands in a group), no
      // identity-bearing signal at all -> LOW confidence, but
      // corporate_group:true (a DIFFERENT, related legal entity — not a
      // duplicate-confidence tier).
      insertProvider.run({
        id: "prov-fjording-a", navn: "Fjording", org_nr: null, postnummer: "5000",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-fjording-b", navn: "Fjording Holding", org_nr: null, postnummer: "5003",
        rfb_seed_source: null, producer_type: "destilleri",
        epost: "post@fjordingholding.no", telefon: null, hjemmeside: null,
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (g) negative control — genuinely different rows, must never group ──
      insertProvider.run({
        id: "prov-negctrl-a", navn: "Østbø Gård", org_nr: "111222333", postnummer: "5700",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ostbogard.no", telefon: "11111111", hjemmeside: "https://ostbogard.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-negctrl-b", navn: "Ramsøy Sjømat", org_nr: "444555666", postnummer: "6000",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ramsoysjomat.no", telefon: "22222222", hjemmeside: "https://ramsoy-sjomat.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (h) excluded rows: never scoped in at all ───────────────────────────
      // Non-gårdssalg row: no producer_type, not rfb-seed.
      insertProvider.run({
        id: "prov-not-gardssalg", navn: "Wilsgård", org_nr: null, postnummer: "9391",
        rfb_seed_source: null, producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      // Synthetic booking-flyt test provider — same guard other gårdssalg
      // read routes already apply (gardssalgSharedHostCounts etc.).
      insertProvider.run({
        id: "prov-test-gardssalg", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "test-gardssalg",
        epost: "test@test.no", telefon: "00000000", hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });

      // ── (q) merged_into read-path filter regression (dev-request
      // 2026-09-03-gardssalg-merged-provider-read-path-filter, bug fix) ──────
      // q1: a fourth "Kinn Bryggeri" row that WOULD join the existing (d)
      // name_exact group on its own merits, but has been folded away via
      // POST /admin/gardssalg-provider-dedup-merge (merged_into set) — must
      // never be counted into that group; the group must stay exactly the
      // same 3 rows it was before this fixture existed.
      insertProvider.run({
        id: "prov-kinn-merged", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      expDb.prepare(`UPDATE experience_providers SET merged_into = 'prov-kinn-a' WHERE id = 'prov-kinn-merged'`).run();
      // q2: a pair that would otherwise form its OWN org_nr-signal group
      // (same padding-trick as the (e) org_nr-only fixtures above, since
      // org_nr has a UNIQUE raw-column constraint), but BOTH sides are
      // merged away into the same (external, not itself a row here) survivor
      // — from a batch like nace-agent-bridge-20260828's. With both sides
      // excluded from the scan entirely, no pair is ever formed, so this
      // "group" must not appear in the output AT ALL (not even as a
      // zero/one-row remnant).
      insertProvider.run({
        id: "prov-nace-merged-a", navn: "Nace Bru Utsalg AS", org_nr: "950111222", postnummer: null,
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-nace-merged-b", navn: "Nace Bru Produkter AS", org_nr: " 950111222 ", postnummer: null,
        rfb_seed_source: null, producer_type: "gardssalg",
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      expDb
        .prepare(
          `UPDATE experience_providers SET merged_into = 'prov-nace-merged-survivor'
             WHERE id IN ('prov-nace-merged-a', 'prov-nace-merged-b')`,
        )
        .run();

      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      // ── (p) pure-function matrix — no DB/HTTP round-trip ─────────────────
      // Exercises gsDedupBestNameTier / gsDedupIsCorporateGroupPair DIRECTLY.
      // A minimal row-builder — only navn/postnummer matter to these two
      // pure functions; the rest are unused filler to satisfy the type.
      function row(navn: string, postnummer: string | null = null): import("./opplevelser").GsDedupRow {
        return {
          id: "x", navn, org_nr: null, hjemmeside: null, epost: null, telefon: null,
          postnummer, rfb_seed_source: null, producer_type: null, content_source: null,
          homepage_unreachable_since: null,
        };
      }
      const { gsDedupBestNameTier: pureBestTier, gsDedupIsCorporateGroupPair: pureIsCorpGroup } = opplevelserModule;

      // Acceptance criterion #1 — none of these 13 pairs' BEST name tier may
      // ever be "name_exact" (the only tier that can drive "high" post-fix).
      // Some share no first token at all (tier null) — also fine, also never
      // "name_exact". Postal codes chosen to mirror the real shapes: same
      // postal where the false-high bug specifically hinged on postal
      // corroboration (name_first_token_postal), omitted where it doesn't
      // matter to this particular pair's story.
      const thirteenNonDuplicatePairs: Array<[string, string, string | null, string | null]> = [
        ["Geiranger Brenneri", "Geiranger Bryggeri", "6216", "6216"],
        ["Lom Destilleri", "Lom Bryggeri", "2686", "2686"],
        ["Halden Bryggeri", "Halden Mikrobryggeri", "1767", "1767"],
        ["Fjording", "Fjording Holding", null, null],
        ["Guajiro Gårdsdrift", "Guajiro Holding", null, null],
        ["Tradish Brewing", "Tradish Holding", null, null],
        ["Ringnes", "Ringnes Brygghus", null, null],
        ["Ringnes", "Ringnes Norge", null, null],
        ["Ringnes", "Ringnes Supply", null, null],
        ["Svalbard Bryggeri", "Svalbard Holding", null, null],
        ["Svalbard Bryggeri", "Svalbard Distillery", null, null],
        ["Monkey Brew", "Monkey Businessmen", null, null],
        ["Arcus Norway", "Arcus-Gruppen", null, null],
        ["Skifjorden Bryggeri", "Skifjorden Cooperative", null, null],
        ["Inderøy Gårdsbryggeri", "Inderøy Brenneri", "7670", "7670"],
        ["Edel Vin", "Edel Vingård", null, null],
      ];
      for (const [navnA, navnB, postalA, postalB] of thirteenNonDuplicatePairs) {
        const tier = pureBestTier(row(navnA, postalA), row(navnB, postalB));
        assertTrue(
          tier !== "name_exact",
          `p1 [${navnA} / ${navnB}]: best name tier is never "name_exact" (got ${JSON.stringify(tier)}) — cannot drive "high" post-fix`,
        );
      }

      // Corporate-group suffix matrix — each of the 4 group-denoting words
      // individually detected as "X" vs "X <suffix>", case-insensitively;
      // "supply company" as the two-word phrase.
      for (const suffix of ["Holding", "HOLDING", "Gruppen", "Norge", "Supply Company", "supply company"]) {
        assertTrue(
          pureIsCorpGroup(row("Bjørnstad"), row(`Bjørnstad ${suffix}`)),
          `p2 ["Bjørnstad" / "Bjørnstad ${suffix}"]: detected as a corporate-group pair`,
        );
      }
      // Symmetric — order of the two rows must not matter.
      assertTrue(
        pureIsCorpGroup(row("Bjørnstad Holding"), row("Bjørnstad")),
        "p3: corporate-group detection is symmetric in argument order",
      );
      // Both sides suffixed, or neither -> NOT a corporate-group pair (that's
      // either a plain name_exact match or a plain non-match, not this shape).
      assertTrue(
        !pureIsCorpGroup(row("Bjørnstad Holding"), row("Bjørnstad Holding")),
        "p4: both sides carrying the SAME suffix is not a corporate-group pair (name_exact territory instead)",
      );
      assertTrue(
        !pureIsCorpGroup(row("Bjørnstad"), row("Bjørnstad")),
        "p5: neither side suffixed is not a corporate-group pair",
      );
      // A suffix word NOT in the corporate-group list (e.g. mandatory legal
      // form "AS") must NOT be detected as corporate-group — those are
      // identity-preserving (name_exact territory), already handled by
      // brreg-client.ts's own normaliseNamePruned.
      assertTrue(
        !pureIsCorpGroup(row("Kinn Bryggeri"), row("Kinn Bryggeri AS")),
        "p6: \"AS\" is NOT a corporate-group suffix — it's identity-preserving, not a corporate-group relationship",
      );
      assertEq(
        pureBestTier(row("Kinn Bryggeri"), row("Kinn Bryggeri AS")),
        "name_exact",
        "p7: \"Kinn Bryggeri\" vs \"Kinn Bryggeri AS\" scores name_exact directly via the pure function (acceptance #3, unit-level proof)",
      );
      // The other bare legal-form suffixes point 4 lists (ASA/SA/ANS/DA) are
      // ALSO already identity-preserving via the same existing brreg-client.ts
      // normalisation — not corporate-group, and still name_exact.
      for (const legalForm of ["ASA", "SA", "ANS", "DA"]) {
        assertTrue(
          !pureIsCorpGroup(row("Kinn Bryggeri"), row(`Kinn Bryggeri ${legalForm}`)),
          `p8 [${legalForm}]: bare legal-form suffix is NOT corporate-group`,
        );
        assertEq(
          pureBestTier(row("Kinn Bryggeri"), row(`Kinn Bryggeri ${legalForm}`)),
          "name_exact",
          `p9 [${legalForm}]: bare legal-form suffix still scores name_exact`,
        );
      }

      // Snapshot every fixture row's raw columns before any request, for the
      // zero-writes check below.
      const snapshotBefore = expDb
        .prepare(
          `SELECT id, navn, org_nr, postnummer, rfb_seed_source, producer_type,
                  epost, telefon, hjemmeside, content_source, homepage_unreachable_since
             FROM experience_providers ORDER BY id`,
        )
        .all();
      const countBefore = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg-provider-dedup-audit without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.groups, "a2: no-key response carries no groups payload");

      // ── Happy-path call (used by b–j below) ─────────────────────────────
      const first = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(first.status, 200, "0: happy-path call -> 200");

      const groups: any[] = first.body.groups;
      assertTrue(Array.isArray(groups), "0b: response carries a groups array");

      function groupContaining(id: string): any | undefined {
        return groups.find((g) => g.rows.some((r: any) => r.id === id));
      }

      // ── (b) name_first_token_postal — Wilsgård pair ─────────────────────
      // dev-request 2026-08-18-gardssalg-dedup-org-nr-override, point 1: this
      // tier alone must NEVER produce "high" any more (it used to — that was
      // exactly the 17-false-high bug).
      const wilsgard = groupContaining("prov-wilsgard-a");
      assertTrue(!!wilsgard, "b1: Wilsgård Bryggeri — Torsken lands in a group");
      assertTrue(
        !!wilsgard && wilsgard.rows.some((r: any) => r.id === "prov-wilsgard-b"),
        "b2: Wilsgård Bryggeri — Torsken groups WITH Wilsgård (same group)",
      );
      assertEq(wilsgard?.rows.length, 2, "b3: Wilsgård group has exactly 2 rows (the non-gårdssalg homonym is excluded)");
      assertTrue(
        !!wilsgard && wilsgard.signals.includes("name_first_token_postal"),
        "b4: Wilsgård group's signals include name_first_token_postal (evidence still reported)",
      );
      assertEq(wilsgard?.confidence, "low", "b5: Wilsgård group is now LOW confidence — name_first_token_postal alone never yields high (point 1)");
      assertEq(wilsgard?.confidence_signals, [], "b6: Wilsgård group's confidence_signals is empty — nothing identity-bearing fired");
      assertEq(wilsgard?.corporate_group, false, "b7: Wilsgård group is not a corporate-group pair");
      assertEq(wilsgard?.org_nr_conflict, false, "b8: Wilsgård group has no org_nr conflict (neither side has org_nr)");

      // ── (c) name_first_token (LOW confidence) — Himkok pair ─────────────
      const himkok = groupContaining("prov-himkok-a");
      assertTrue(!!himkok, "c1: Himkok lands in a group");
      assertTrue(
        !!himkok && himkok.rows.some((r: any) => r.id === "prov-himkok-b"),
        "c2: Himkok groups WITH Himkok Rtd (same group)",
      );
      assertEq(himkok?.signals, ["name_first_token"], "c3: Himkok group's ONLY signal is name_first_token (first-token only, no postal corroboration)");
      assertEq(himkok?.confidence, "low", "c4: Himkok group is LOW confidence — a judgment call, surfaced not silently merged or silently dropped");

      // ── (d) name_exact — Kinn Bryggeri pair (+ "AS"-suffixed 3rd row) ────
      const kinn = groupContaining("prov-kinn-a");
      assertTrue(!!kinn, "d1: Kinn Bryggeri lands in a group");
      assertTrue(
        !!kinn && kinn.rows.some((r: any) => r.id === "prov-kinn-b"),
        "d2: Kinn Bryggeri groups WITH the second Kinn Bryggeri row",
      );
      assertEq(kinn?.rows.length, 3, "d3: Kinn Bryggeri group has exactly 3 rows (bare x2 + AS-suffixed; the test-gardssalg homonym AND the merged-away prov-kinn-merged are excluded)");
      assertTrue(!!kinn && kinn.signals.includes("name_exact"), "d4: Kinn Bryggeri group's signals include name_exact");
      assertEq(kinn?.confidence, "high", "d5: Kinn Bryggeri group is HIGH confidence (exact name match)");
      assertEq(kinn?.confidence_signals, ["name_exact"], "d6: Kinn Bryggeri group's confidence_signals is exactly [\"name_exact\"]");
      assertEq(kinn?.corporate_group, false, "d7: Kinn Bryggeri group is not a corporate-group pair");
      assertEq(kinn?.org_nr_conflict, false, "d8: Kinn Bryggeri group has no org_nr conflict");
      assertTrue(
        !!kinn && kinn.rows.some((r: any) => r.id === "prov-kinn-c"),
        "d9: acceptance #3 — \"Kinn Bryggeri AS\" lands in the SAME group as the bare rows (normaliseNamePruned's existing as/asa/da/ans/sa stripping already covers this; regression-proofed here now that 'high' requires an identity-bearing signal)",
      );

      // ── (q) merged_into read-path filter regression (dev-request
      // 2026-09-03-gardssalg-merged-provider-read-path-filter, bug fix) ──────
      assertTrue(
        !!kinn && !kinn.rows.some((r: any) => r.id === "prov-kinn-merged"),
        "q1: merged-away prov-kinn-merged does NOT appear in the Kinn Bryggeri group despite otherwise matching name_exact",
      );
      assertTrue(
        !groupContaining("prov-kinn-merged"),
        "q2: merged-away prov-kinn-merged appears in NO group at all",
      );
      // With both sides of the would-be org_nr-signal pair merged away, no
      // pair is ever formed — the "group" disappears from the output
      // entirely, not just one of its two rows.
      assertTrue(
        !groupContaining("prov-nace-merged-a"),
        "q3: a group whose members are ALL merged away (nace-agent-bridge-20260828 shape) does not appear in the output at all",
      );
      assertTrue(
        !groupContaining("prov-nace-merged-b"),
        "q4: same group, other side — also absent",
      );

      // ── (e) org_nr-only signal ───────────────────────────────────────────
      const orgnrGroup = groupContaining("prov-orgnr-a");
      assertTrue(!!orgnrGroup, "e1: org_nr-sharing row lands in a group");
      assertTrue(
        !!orgnrGroup && orgnrGroup.rows.some((r: any) => r.id === "prov-orgnr-b"),
        "e2: org_nr-sharing rows land in the SAME group",
      );
      assertEq(orgnrGroup?.signals, ["org_nr"], "e3: org_nr-only group's ONLY signal is org_nr (names/domains genuinely differ)");
      assertEq(orgnrGroup?.confidence, "high", "e4: org_nr-only group is HIGH confidence");
      assertEq(orgnrGroup?.confidence_signals, ["org_nr"], "e5: org_nr-only group's confidence_signals is exactly [\"org_nr\"]");
      assertEq(orgnrGroup?.org_nr_conflict, false, "e6: org_nr-only group has no conflict — the org_nr MATCHES");

      // ── (f) domain-only signal ───────────────────────────────────────────
      const domainGroup = groupContaining("prov-domain-a");
      assertTrue(!!domainGroup, "f1: domain-sharing row lands in a group");
      assertTrue(
        !!domainGroup && domainGroup.rows.some((r: any) => r.id === "prov-domain-b"),
        "f2: domain-sharing rows (www.+path vs bare) land in the SAME group",
      );
      assertEq(domainGroup?.signals, ["domain"], "f3: domain-only group's ONLY signal is domain (names/org_nr genuinely differ)");
      assertEq(domainGroup?.confidence, "high", "f4: domain-only group is HIGH confidence — real cross-seed duplicates matched via domain must still surface as high (acceptance #2)");
      assertEq(domainGroup?.confidence_signals, ["domain"], "f5: domain-only group's confidence_signals is exactly [\"domain\"]");
      assertEq(domainGroup?.org_nr_conflict, false, "f6: no org_nr conflict — one side is simply blank, not a genuine conflict");

      // ── (l) org_nr-override vs. name_first_token_postal — Geiranger pair ──
      // The actual real-world false-high shape this dev-request fixes.
      const geiranger = groupContaining("prov-geiranger-a");
      assertTrue(!!geiranger, "l1: Geiranger Brenneri lands in a group");
      assertTrue(
        !!geiranger && geiranger.rows.some((r: any) => r.id === "prov-geiranger-b"),
        "l2: Geiranger Brenneri groups WITH Geiranger Bryggeri (same first token + same postal)",
      );
      assertTrue(
        !!geiranger && geiranger.signals.includes("name_first_token_postal"),
        "l3: Geiranger group's signals include name_first_token_postal (the evidence that used to be enough alone)",
      );
      assertEq(geiranger?.confidence, "low", "l4: Geiranger group is LOW confidence — no identity-bearing signal, and org_nr differs on both sides");
      assertEq(geiranger?.confidence_signals, [], "l5: Geiranger group's confidence_signals is empty");
      assertEq(geiranger?.org_nr_conflict, true, "l6: Geiranger group is flagged org_nr_conflict:true — different, both-populated org_nr explains the suppression");

      // ── (m1) org_nr-override vs. name_exact — identical names, different
      // populated org_nr must STILL never grade high (point 3 overrides even
      // the strongest name signal).
      const nameExactConflict = groupContaining("prov-nameexact-conflict-a");
      assertTrue(!!nameExactConflict, "m1a: Nordheim Gårdsutsalg (conflict pair) lands in a group");
      assertTrue(
        !!nameExactConflict && nameExactConflict.rows.some((r: any) => r.id === "prov-nameexact-conflict-b"),
        "m1b: both Nordheim rows are in the same group (identical normalized name)",
      );
      assertTrue(
        !!nameExactConflict && nameExactConflict.signals.includes("name_exact"),
        "m1c: name_exact is still reported in signals (it WAS matched — just doesn't count toward confidence)",
      );
      assertEq(nameExactConflict?.confidence, "low", "m1d: Nordheim conflict group is LOW confidence despite the exact name match");
      assertEq(nameExactConflict?.confidence_signals, [], "m1e: Nordheim conflict group's confidence_signals is empty — name_exact did NOT count");
      assertEq(nameExactConflict?.org_nr_conflict, true, "m1f: Nordheim conflict group is flagged org_nr_conflict:true");

      // ── (m2) org_nr-override vs. domain — a shared website, two legally-
      // distinct producer brands. Domain is the ONLY thing connecting this
      // pair (names share no first token), and it must still not go high.
      const domainConflict = groupContaining("prov-domainconflict-a");
      assertTrue(!!domainConflict, "m2a: Iskaldt Destilleri (domain-conflict pair) lands in a group");
      assertTrue(
        !!domainConflict && domainConflict.rows.some((r: any) => r.id === "prov-domainconflict-b"),
        "m2b: both domain-conflict rows are in the same group (shared registrable domain)",
      );
      assertTrue(
        !!domainConflict && domainConflict.signals.includes("domain"),
        "m2c: domain is still reported in signals (it WAS matched — just doesn't count toward confidence)",
      );
      assertEq(domainConflict?.confidence, "low", "m2d: domain-conflict group is LOW confidence despite the shared domain");
      assertEq(domainConflict?.confidence_signals, [], "m2e: domain-conflict group's confidence_signals is empty — domain did NOT count");
      assertEq(domainConflict?.org_nr_conflict, true, "m2f: domain-conflict group is flagged org_nr_conflict:true");

      // ── (n) corporate-group label — Fjording / Fjording Holding ─────────
      const fjording = groupContaining("prov-fjording-a");
      assertTrue(!!fjording, "n1: Fjording lands in a group");
      assertTrue(
        !!fjording && fjording.rows.some((r: any) => r.id === "prov-fjording-b"),
        "n2: Fjording groups WITH Fjording Holding (shared first-token name signal)",
      );
      assertEq(fjording?.confidence, "low", "n3: Fjording group is LOW confidence — no identity-bearing signal");
      assertEq(fjording?.confidence_signals, [], "n4: Fjording group's confidence_signals is empty");
      assertEq(fjording?.corporate_group, true, "n5: Fjording group is flagged corporate_group:true — \"X\" vs \"X Holding\" is a related-but-different entity, not a duplicate");

      // ── (g) negative control ─────────────────────────────────────────────
      assertTrue(!groupContaining("prov-negctrl-a"), "g1: Østbø Gård (negative control) appears in NO group");
      assertTrue(!groupContaining("prov-negctrl-b"), "g2: Ramsøy Sjømat (negative control) appears in NO group");

      // ── (h) excluded rows ─────────────────────────────────────────────────
      const allReturnedIds = new Set(groups.flatMap((g) => g.rows.map((r: any) => r.id)));
      assertTrue(!allReturnedIds.has("prov-not-gardssalg"), "h1: non-gårdssalg row never appears in any group");
      assertTrue(!allReturnedIds.has("prov-test-gardssalg"), "h2: synthetic test-gardssalg row never appears in any group");
      assertEq(first.body.total_providers_scanned, 21, "h3: total_providers_scanned excludes the 2 out-of-scope rows (23 inserted - 2 excluded)");

      // ── (i) per-row response shape / no raw PII ──────────────────────────
      const sampleRow = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-b");
      assertEq(
        Object.keys(sampleRow).sort(),
        ["content_source", "has_email", "has_phone", "homepage_unreachable_since", "id", "navn", "org_nr", "producer_type", "rfb_seed_source", "unreachable"].sort(),
        "i1: row object carries only the documented fields",
      );

      // ── (o) group-level response shape — point 6 schema coverage ─────────
      // Every group (high and low confidence alike) carries exactly these
      // top-level keys — checked on one HIGH group (Kinn) and one LOW group
      // (Himkok) so both branches of the confidence_signals/corporate_group/
      // org_nr_conflict logic are shape-checked, not just value-checked.
      const expectedGroupKeys = ["signals", "confidence", "confidence_signals", "corporate_group", "org_nr_conflict", "rows"].sort();
      assertEq(Object.keys(kinn).sort(), expectedGroupKeys, "o1: HIGH-confidence group carries exactly the documented top-level keys");
      assertEq(Object.keys(himkok).sort(), expectedGroupKeys, "o2: LOW-confidence group carries exactly the documented top-level keys");
      assertTrue(Array.isArray(kinn.confidence_signals), "o3: confidence_signals is an array");
      assertTrue(typeof kinn.corporate_group === "boolean", "o4: corporate_group is a boolean");
      assertTrue(typeof kinn.org_nr_conflict === "boolean", "o5: org_nr_conflict is a boolean");
      const serialized = JSON.stringify(first.body);
      for (const pii of [
        "post@wilsgaard.no", "99999999", "www.wilsgaard.no",
        "post@himkokrtd.no", "88888888", "himkokrtd.no",
        "post@kinnbryggeri.no", "77777777",
        "post@objectprod.no",
        "post@sjomatprodukt.no", "sjomatprodukt.no",
      ]) {
        assertTrue(!serialized.includes(pii), `i2: response never includes raw contact value "${pii}"`);
      }

      // ── (j) has_email / has_phone / unreachable booleans ─────────────────
      const wilsgardA = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-a");
      const wilsgardB = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-b");
      assertEq(wilsgardA.has_email, false, "j1: sparse Wilsgård row has_email=false");
      assertEq(wilsgardA.has_phone, false, "j2: sparse Wilsgård row has_phone=false");
      assertEq(wilsgardA.unreachable, true, "j3: sparse Wilsgård row unreachable=true (homepage_unreachable_since set)");
      assertEq(wilsgardA.homepage_unreachable_since, "2026-06-01T00:00:00.000Z", "j4: sparse Wilsgård row carries the raw homepage_unreachable_since timestamp");
      assertEq(wilsgardB.has_email, true, "j5: rich Wilsgård row has_email=true");
      assertEq(wilsgardB.has_phone, true, "j6: rich Wilsgård row has_phone=true");
      assertEq(wilsgardB.unreachable, false, "j7: rich Wilsgård row unreachable=false");

      // ── (k) zero net DB writes ─────────────────────────────────────────────
      // Call the endpoint a SECOND time and confirm nothing changed.
      const second = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(second.status, 200, "k1: second call -> 200");
      assertEq(second.body, first.body, "k2: second call returns byte-identical output to the first (deterministic, no side effect from the first call)");

      const countAfter = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;
      assertEq(countAfter, countBefore, "k3: row count unchanged after two calls");

      const snapshotAfter = expDb
        .prepare(
          `SELECT id, navn, org_nr, postnummer, rfb_seed_source, producer_type,
                  epost, telefon, hjemmeside, content_source, homepage_unreachable_since
             FROM experience_providers ORDER BY id`,
        )
        .all();
      assertEq(snapshotAfter, snapshotBefore, "k4: every fixture row's raw columns are byte-identical before vs after two calls");

      // dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
      // merge lever (2026-08-15): `merged_into` now DOES exist (added for
      // POST /admin/gardssalg-provider-dedup-merge — this audit route itself
      // never writes it, and every fixture row above still has it NULL, so
      // this endpoint's own zero-writes/byte-identical checks above are
      // unaffected). `deleted_at` is still absent — this lever soft-marks via
      // merged_into, never a deletion timestamp.
      const columns = (expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as Array<{ name: string }>).map((c) => c.name);
      assertTrue(columns.includes("merged_into"), "k5: merged_into column exists on experience_providers (merge lever)");
      assertTrue(!columns.includes("deleted_at"), "k6: no deleted_at column exists on experience_providers");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-provider-dedup-audit: unexpected error: " + String(err?.stack || err?.message || err));
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
      delete process.env.BOOKING_DISPATCH_ENABLED;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-provider-dedup-audit.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProviderDedupAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
