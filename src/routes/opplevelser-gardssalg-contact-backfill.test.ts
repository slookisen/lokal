/**
 * opplevelser-gardssalg-contact-backfill.test.ts — tests for the Brreg
 * contact backfill (dev-request 2026-07-26-brreg-kontakt-backfill):
 *
 *   - fetchBrregContact() (src/services/brreg-client.ts)
 *   - fetchBrregWebsite() still behaves identically after being refactored
 *     into a projection of fetchBrregContact()
 *   - selectGardssalgProvidersForContactBackfill() /
 *     countGardssalgProvidersForContactBackfill() /
 *     getGardssalgProviderContactTarget() (src/services/experience-store.ts)
 *   - applyGardssalgProviderContact() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-contact-backfill (src/routes/opplevelser.ts)
 *
 * The outreach-readiness report found 344 of 389 gårdssalg providers with
 * NEITHER epost NOR telefon — un-contactable AND un-claimable at once. Brreg's
 * GET /enheter/{orgNr} response carries the entity's own registered
 * `epostadresse`/`telefon`/`mobil`, which no code in this repo read before
 * fetchBrregContact(). Measured over the full live cohort 2026-07-27: 101 of
 * 333 (30.3 %) have a contact channel there.
 *
 * Mirrors opplevelser-gardssalg-orgnr-backfill.test.ts's setup and conventions
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle(), globalThis.fetch stubbed since
 * fetchBrregContact has no injected-fetchImpl call site in the route).
 *
 * Covers:
 *   (a) fetchBrregContact: reads epostadresse/telefon/mobil/hjemmeside,
 *       trimmed; blank-string fields become null
 *   (b) fetchBrregContact: `mobil` is the fallback when `telefon` is absent,
 *       and `telefon` wins when both are present
 *   (c) fetchBrregContact: 404 -> null; network failure -> null (never throws);
 *       blank orgNr -> null without a fetch
 *   (d) fetchBrregWebsite still returns exactly the hjemmeside string / null
 *       after the refactor (no behaviour change for existing callers)
 *   (e) fetchBrregWebsite + fetchBrregContact on the same org-nr share ONE
 *       round-trip (the shared cache is what makes the refactor a win)
 *   (f) selection: row missing both contact fields IS selected; row with both
 *       filled is NOT; locked (manual/claim) row is NOT; row without org_nr
 *       is NOT; row missing only telefon IS (fill-only can still contribute)
 *   (g) selection deliberately INCLUDES catalog_hidden rows — hidden is the
 *       cohort, unlike the sibling address-enrichment selector
 *   (h) selection paging: limit+offset walk the cohort without overlap or gaps
 *   (i) countGardssalgProvidersForContactBackfill matches the unpaged count
 *   (j) getGardssalgProviderContactTarget: override resolves locked/filled
 *       rows too; nonexistent -> null; org_nr-less -> null
 *   (k) applyGardssalgProviderContact: fill-only write + audit + provenance
 *   (l) applyGardssalgProviderContact: NEVER overwrites an existing value
 *   (m) applyGardssalgProviderContact: locked provider -> nothing written
 *   (n) applyGardssalgProviderContact: idempotent second call is a no-op
 *   (o) route: unauthenticated -> 403
 *   (p) route: dry-run writes NOTHING but reports what it would write
 *   (q) route: apply actually writes, and only the blank field
 *   (r) route: locked rows land in skipped_locked with no Brreg call
 *   (s) route: a provider with no contact in Brreg -> unresolved, no write
 *   (t) route: Brreg lookup failure -> unresolved, no write, no throw
 *   (u) route: hjemmeside is NEVER written to the provider row — it goes to
 *       gardssalg_website_review_queue instead
 *   (v) route: brreg_hits/cohort_total reporting is accurate (this is the
 *       number the dry-run exists to produce)
 *
 * dev-request 2026-08-17-kontaktadresse-feilkilde-og-override, Skive C —
 * the write-time contact-email domain gate now lives INSIDE
 * applyGardssalgProviderContact (one choke point for both writer routes),
 * and the one-time catalog-wide settlement lives behind a new endpoint:
 *   (w) applyGardssalgProviderContact's gate: same-domain still writes
 *       (no regression); foreign-domain non-freemail is withheld, reported
 *       and stamped into field_provenance.contact_email_flagged_review while
 *       telefon on the same call is unaffected; freemail stays exempt; a row
 *       with no hjemmeside on file still writes
 *   (x) route: the withheld candidate surfaces in
 *       contact_email_flagged_for_review and never in changed[]
 *   (y) POST /admin/gardssalg-contact-email-audit: admin-gated; dry-run
 *       reports without writing; apply flags; same-domain/freemail/
 *       active-override rows are excluded and owner-locked rows are reported
 *       but never auto-flagged; a re-run is idempotent (already_flagged); a
 *       flag lapses when epost changes
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
    const url = opts.url || "/admin/gardssalg-contact-backfill";
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

export function runOpplevelserGardssalgContactBackfillTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-contact-backfill-test-key";
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

      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");

      // ── Brreg stub. Keyed by org-nr, counts calls so (e) can prove the
      // shared cache collapses two lookups into one round-trip.
      //
      // experience_providers.org_nr is UNIQUE, so every provider fixture needs
      // its OWN org-nr even when it should get the same Brreg answer — hence
      // the shape constants + allocator rather than a flat literal map. ─────
      const SHAPE_FULL = {
        epostadresse: "  post@fullhouse.no  ",
        telefon: " 22 33 44 55 ",
        mobil: "99887766",
        hjemmeside: "  https://fullhouse.no  ",
      };
      const SHAPE_EMPTY = { epostadresse: "", telefon: "", mobil: "", hjemmeside: "" };
      const SHAPE_MOBILE_ONLY = { mobil: "40404040" };
      const SHAPE_EMAIL_ONLY = { epostadresse: "kun@epost.no" };
      const SHAPE_WEBSITE_ONLY = { hjemmeside: "https://kun-nettside.no" };
      const SHAPE_PHONE_ONLY = { telefon: "51515151" };

      const brregFixtures: Record<string, any> = {
        "810000001": SHAPE_FULL,
        "810000002": SHAPE_EMPTY,
        "810000003": SHAPE_MOBILE_ONLY,
        "810000004": SHAPE_EMAIL_ONLY,
        "810000005": SHAPE_WEBSITE_ONLY,
        "810000006": SHAPE_PHONE_ONLY,
      };
      // Allocates a fresh, unique org-nr bound to the given Brreg answer.
      let nextOrgSeq = 820000000;
      function orgFor(shape: any): string {
        const orgNr = String(++nextOrgSeq);
        brregFixtures[orgNr] = shape;
        return orgNr;
      }
      let fetchCalls: string[] = [];
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        fetchCalls.push(url);
        const m = url.match(/\/enheter\/(\d+)/);
        const orgNr = m ? m[1] : "";
        if (orgNr === "810000404") {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        if (orgNr === "810000500") {
          throw new Error("simulated network failure");
        }
        if (!(orgNr in brregFixtures)) {
          return { ok: false, status: 404, json: async () => ({}) } as any;
        }
        return { ok: true, status: 200, json: async () => brregFixtures[orgNr] } as any;
      }) as any;

      // ── (a)-(c) fetchBrregContact unit coverage ──────────────────────────
      brregClient.__clearBrregWebsiteCacheForTesting();
      const c1 = await brregClient.fetchBrregContact("810000001");
      assertEq(c1?.epost, "post@fullhouse.no", "a1: epostadresse is read and trimmed");
      assertEq(c1?.telefon, "22 33 44 55", "a2: telefon is read and trimmed");
      assertEq(c1?.hjemmeside, "https://fullhouse.no", "a3: hjemmeside is read and trimmed");

      brregClient.__clearBrregWebsiteCacheForTesting();
      const c2 = await brregClient.fetchBrregContact("810000002");
      assertEq(c2, { hjemmeside: null, epost: null, telefon: null }, "a4: blank-string fields all become null");

      brregClient.__clearBrregWebsiteCacheForTesting();
      const c3 = await brregClient.fetchBrregContact("810000003");
      assertEq(c3?.telefon, "40404040", "b1: mobil is the fallback when telefon is absent");
      assertEq(c1?.telefon, "22 33 44 55", "b2: telefon wins over mobil when both are present");

      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregContact("810000404"), null, "c1: 404 resolves to null");
      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregContact("810000500"), null, "c2: network failure resolves to null, never throws");
      brregClient.__clearBrregWebsiteCacheForTesting();
      fetchCalls = [];
      assertEq(await brregClient.fetchBrregContact(""), null, "c3: blank orgNr -> null");
      assertEq(fetchCalls.length, 0, "c4: blank orgNr does not issue a fetch");

      // ── (d) fetchBrregWebsite unchanged for existing callers ─────────────
      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregWebsite("810000001"), "https://fullhouse.no", "d1: hjemmeside still trimmed");
      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregWebsite("810000002"), null, "d2: whitespace-only hjemmeside still null");
      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregWebsite("810000500"), null, "d3: network failure still null, never throws");
      brregClient.__clearBrregWebsiteCacheForTesting();
      assertEq(await brregClient.fetchBrregWebsite("810000404"), null, "d4: 404 still null");
      brregClient.__clearBrregWebsiteCacheForTesting();
      fetchCalls = [];
      assertEq(await brregClient.fetchBrregWebsite(""), null, "d5: blank orgNr still null");
      assertEq(fetchCalls.length, 0, "d6: blank orgNr still issues no fetch");

      // ── (e) one round-trip shared by both functions ──────────────────────
      brregClient.__clearBrregWebsiteCacheForTesting();
      fetchCalls = [];
      await brregClient.fetchBrregContact("810000001");
      await brregClient.fetchBrregWebsite("810000001");
      await brregClient.fetchBrregContact("810000001");
      assertEq(fetchCalls.length, 1, "e: contact + website lookups on one org-nr share a single round-trip");

      // ── Fixtures ─────────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, epost, telefon, hjemmeside, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      mkProvider({ id: "sel-blank-both", navn: "Blank Both", org_nr: orgFor(SHAPE_FULL), created_at: "2026-01-01 00:00:00" });
      mkProvider({ id: "sel-full", navn: "Full Contact", org_nr: orgFor(SHAPE_FULL), epost: "a@b.no", telefon: "111", created_at: "2026-01-02 00:00:00" });
      mkProvider({ id: "sel-locked", navn: "Locked", org_nr: orgFor(SHAPE_FULL), content_source: "manual", created_at: "2026-01-03 00:00:00" });
      mkProvider({ id: "sel-claim-locked", navn: "Claim Locked", org_nr: orgFor(SHAPE_FULL), content_source: "claim", created_at: "2026-01-04 00:00:00" });
      mkProvider({ id: "sel-no-orgnr", navn: "No Orgnr", org_nr: null, created_at: "2026-01-05 00:00:00" });
      mkProvider({ id: "sel-half", navn: "Half Contact", org_nr: orgFor(SHAPE_PHONE_ONLY), epost: "har@epost.no", created_at: "2026-01-06 00:00:00" });
      mkProvider({ id: "sel-hidden", navn: "Hidden Row", org_nr: orgFor(SHAPE_EMAIL_ONLY), catalog_hidden: 1, created_at: "2026-01-07 00:00:00" });

      // ── (f)+(g) selection ────────────────────────────────────────────────
      const selIds = store.selectGardssalgProvidersForContactBackfill(100).map((r) => r.id);
      assertTrue(selIds.includes("sel-blank-both"), "f1: row missing both contact fields is selected");
      assertTrue(!selIds.includes("sel-full"), "f2: row with both contact fields is not selected");
      assertTrue(!selIds.includes("sel-locked"), "f3: manual-locked row is not selected");
      assertTrue(!selIds.includes("sel-claim-locked"), "f4: claim-locked row is not selected");
      assertTrue(!selIds.includes("sel-no-orgnr"), "f5: row without org_nr is not selected");
      assertTrue(selIds.includes("sel-half"), "f6: row missing only telefon is still selected (fill-only can contribute)");
      assertTrue(selIds.includes("sel-hidden"), "g: catalog_hidden row IS selected — hidden is the cohort here");

      // ── (h) paging ───────────────────────────────────────────────────────
      const page1 = store.selectGardssalgProvidersForContactBackfill(2, 0).map((r) => r.id);
      const page2 = store.selectGardssalgProvidersForContactBackfill(2, 2).map((r) => r.id);
      const page3 = store.selectGardssalgProvidersForContactBackfill(2, 4).map((r) => r.id);
      const walked = [...page1, ...page2, ...page3];
      assertEq(page1.length, 2, "h1: first page is full");
      assertEq(new Set(walked).size, walked.length, "h2: paging produces no duplicate rows");
      assertEq(walked, selIds.slice(0, walked.length), "h3: paged walk matches the unpaged order exactly (no gaps)");

      // ── (i) count ────────────────────────────────────────────────────────
      assertEq(store.countGardssalgProvidersForContactBackfill(), selIds.length, "i: count matches the unpaged selection size");

      // ── (j) explicit-override lookups ────────────────────────────────────
      assertTrue(store.getGardssalgProviderContactTarget("sel-locked") !== null, "j1: locked row still resolves via explicit override");
      assertTrue(store.getGardssalgProviderContactTarget("sel-full") !== null, "j2: already-filled row still resolves via explicit override");
      assertEq(store.getGardssalgProviderContactTarget("sel-no-orgnr"), null, "j3: org_nr-less row -> null");
      assertEq(store.getGardssalgProviderContactTarget("does-not-exist"), null, "j4: nonexistent id -> null");

      // ── (k)-(n) applyGardssalgProviderContact ────────────────────────────
      mkProvider({ id: "app-blank", navn: "Apply Blank", org_nr: orgFor(SHAPE_FULL), created_at: "2026-02-01 00:00:00" });
      const written1 = store.applyGardssalgProviderContact(
        "app-blank", { epost: " ny@post.no ", telefon: " 12345678 " }, "https://brreg.example/810000001", "batch-k"
      );
      assertEq(written1.written.sort(), ["epost", "telefon"], "k1: both blank fields written");
      assertEq(written1.epostFlaggedForReview, undefined, "k1b: no hjemmeside on file -> the domain gate never fires");
      const rowK = getProviderRow("app-blank");
      assertEq(rowK.epost, "ny@post.no", "k2: epost written trimmed");
      assertEq(rowK.telefon, "12345678", "k3: telefon written trimmed");
      const auditK = getAuditRows("app-blank");
      assertEq(auditK.length, 2, "k4: one audit row per written field");
      assertEq(auditK.every((a: any) => a.old_value === null), true, "k5: audit old_value is the true pre-write null");
      assertEq(auditK.every((a: any) => a.batch_id === "batch-k"), true, "k6: audit rows carry the batch id");
      assertEq(auditK.every((a: any) => a.source_url === "https://brreg.example/810000001"), true, "k7: audit rows carry the evidence url");
      const provK = JSON.parse(rowK.field_provenance || "{}");
      assertTrue(!!provK.epost?.source_url && !!provK.telefon?.source_url, "k8: field_provenance recorded for both fields");

      mkProvider({ id: "app-existing", navn: "Apply Existing", org_nr: orgFor(SHAPE_FULL), epost: "gammel@post.no", created_at: "2026-02-02 00:00:00" });
      const written2 = store.applyGardssalgProviderContact(
        "app-existing", { epost: "brreg@post.no", telefon: "99999999" }, "https://brreg.example/810000001"
      );
      assertEq(written2.written, ["telefon"], "l1: only the blank field is written");
      assertEq(getProviderRow("app-existing").epost, "gammel@post.no", "l2: an existing value is NEVER overwritten");

      mkProvider({ id: "app-locked", navn: "Apply Locked", org_nr: orgFor(SHAPE_FULL), content_source: "claim", created_at: "2026-02-03 00:00:00" });
      assertEq(
        store.applyGardssalgProviderContact("app-locked", { epost: "x@y.no", telefon: "1" }, "https://brreg.example/1").written,
        [],
        "m1: locked provider -> nothing written"
      );
      assertEq(getProviderRow("app-locked").epost, null, "m2: locked provider row untouched");

      assertEq(
        store.applyGardssalgProviderContact("app-blank", { epost: "annen@post.no", telefon: "87654321" }, "https://brreg.example/1").written,
        [],
        "n1: second call on a filled row is a no-op"
      );
      assertEq(getAuditRows("app-blank").length, 2, "n2: no-op writes no extra audit rows");

      // ── (w) write-time contact-email domain gate (dev-request 2026-08-17-
      // kontaktadresse-feilkilde-og-override, Skive C(a)). The gate lives
      // INSIDE applyGardssalgProviderContact, so both writer routes inherit
      // it; these cases pin the four branches that decide whether an epost
      // candidate is publishable or queued for review. ────────────────────
      {
        // (w1) same-domain candidate still writes normally — the load-bearing
        // no-regression case.
        mkProvider({
          id: "gate-same", navn: "Gate Same Domain", org_nr: orgFor(SHAPE_FULL),
          hjemmeside: "https://www.gatesame.no", created_at: "2026-02-10 00:00:00",
        });
        const r = store.applyGardssalgProviderContact(
          "gate-same", { epost: "post@gatesame.no", telefon: "22222222", epostSource: "mailto" },
          "https://gatesame.no/kontakt", "batch-w"
        );
        assertEq(r.written.sort(), ["epost", "telefon"], "w1a: same-domain candidate is written as before");
        assertEq(r.epostFlaggedForReview, undefined, "w1b: same-domain candidate is not flagged");
        assertEq(getProviderRow("gate-same").epost, "post@gatesame.no", "w1c: the row carries the address");
        assertTrue(
          !JSON.parse(getProviderRow("gate-same").field_provenance || "{}").contact_email_flagged_review,
          "w1d: no review stamp written for a same-domain candidate",
        );
      }
      {
        // (w2) foreign-domain, non-freemail candidate: NOT written, reported
        // back, stamped for review. telefon on the same call is unaffected.
        mkProvider({
          id: "gate-foreign", navn: "Gate Foreign Domain", org_nr: orgFor(SHAPE_FULL),
          hjemmeside: "https://gateforeign.no", created_at: "2026-02-11 00:00:00",
        });
        const r = store.applyGardssalgProviderContact(
          "gate-foreign", { epost: "tg@distributor-as.no", telefon: "33333333", epostSource: "mailto_other_domain" },
          "https://gateforeign.no/kontakt", "batch-w"
        );
        assertEq(r.written, ["telefon"], "w2a: the foreign-domain epost is NOT written; telefon still is");
        assertEq(getProviderRow("gate-foreign").epost, null, "w2b: the row's epost stays blank");
        assertEq(getProviderRow("gate-foreign").telefon, "33333333", "w2c: telefon is untouched by the email-only gate");
        assertEq(r.epostFlaggedForReview?.candidate, "tg@distributor-as.no", "w2d: the held-back candidate is reported back");
        assertEq(r.epostFlaggedForReview?.website_domain, "gateforeign.no", "w2e: the website domain is reported");
        assertEq(r.epostFlaggedForReview?.email_domain, "distributor-as.no", "w2f: the email domain is reported");
        const stamp = JSON.parse(getProviderRow("gate-foreign").field_provenance || "{}").contact_email_flagged_review;
        assertEq(stamp?.flagged_email, "tg@distributor-as.no", "w2g: field_provenance.contact_email_flagged_review stamped");
        assertEq(stamp?.reason, "domain_mismatch", "w2h: stamp carries the reason");
        assertEq(stamp?.source, "mailto_other_domain", "w2i: stamp carries the caller's source label");
        assertTrue(typeof stamp?.flagged_at === "string" && stamp.flagged_at.length > 0, "w2j: stamp carries flagged_at");
        // The stamp must survive the same call's OWN field_provenance merge
        // for telefon — both are read-modify-write on one column.
        assertTrue(
          !!JSON.parse(getProviderRow("gate-foreign").field_provenance || "{}").telefon?.source_url,
          "w2k: telefon provenance from the same call is preserved alongside the stamp",
        );
        // No audit row for the flag — it is not a content change.
        assertEq(getAuditRows("gate-foreign").length, 1, "w2l: only the telefon write produced an audit row");
      }
      {
        // (w3) freemail candidate stays exempt — a farm on gmail.com is the
        // norm, not a wrong-company signal.
        mkProvider({
          id: "gate-freemail", navn: "Gate Freemail", org_nr: orgFor(SHAPE_FULL),
          hjemmeside: "https://gatefreemail.no", created_at: "2026-02-12 00:00:00",
        });
        const r = store.applyGardssalgProviderContact(
          "gate-freemail", { epost: "gaardsbruket@gmail.com", telefon: null, epostSource: "mailto" },
          "https://gatefreemail.no/kontakt", "batch-w"
        );
        assertEq(r.written, ["epost"], "w3a: a freemail candidate is still written");
        assertEq(r.epostFlaggedForReview, undefined, "w3b: a freemail candidate is not flagged");
        assertEq(getProviderRow("gate-freemail").epost, "gaardsbruket@gmail.com", "w3c: the row carries the freemail address");
      }
      {
        // (w4) no hjemmeside on file -> nothing to contradict, write proceeds
        // (same precedent as applyGardssalgSetContactEmail's own domain check).
        mkProvider({
          id: "gate-nosite", navn: "Gate No Site", org_nr: orgFor(SHAPE_FULL),
          hjemmeside: null, created_at: "2026-02-13 00:00:00",
        });
        const r = store.applyGardssalgProviderContact(
          "gate-nosite", { epost: "post@heltannen.no", telefon: null, epostSource: "brreg" },
          "https://brreg.example/1", "batch-w"
        );
        assertEq(r.written, ["epost"], "w4a: with no homepage on file the candidate is written");
        assertEq(r.epostFlaggedForReview, undefined, "w4b: with no homepage on file nothing is flagged");
      }

      // ── (o) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "o: unauthenticated request -> 403");

      const auth = { "x-admin-key": testKey };

      // ── (p) dry-run writes nothing ───────────────────────────────────────
      mkProvider({ id: "rt-dry", navn: "Route Dry", org_nr: orgFor(SHAPE_FULL), created_at: "2026-03-01 00:00:00" });
      const dry = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-dry"] } });
      assertEq(dry.status, 200, "p1: dry-run returns 200");
      assertEq(dry.body.dry_run, true, "p2: dry_run defaults to true");
      assertEq(dry.body.changed.length, 1, "p3: dry-run reports the row it would write");
      assertEq(dry.body.changed[0].fields.sort(), ["epost", "telefon"], "p4: dry-run names the fields it would write");
      assertEq(getProviderRow("rt-dry").epost, null, "p5: dry-run wrote NOTHING to the row");
      assertEq(getAuditRows("rt-dry").length, 0, "p6: dry-run wrote no audit rows");

      // ── (q) apply writes, and only the blank field ───────────────────────
      mkProvider({ id: "rt-apply", navn: "Route Apply", org_nr: orgFor(SHAPE_FULL), telefon: "eksisterende", created_at: "2026-03-02 00:00:00" });
      const applied = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-apply"], apply: true } });
      assertEq(applied.body.dry_run, false, "q1: apply:true flips dry_run off");
      assertEq(applied.body.changed[0].fields, ["epost"], "q2: only the blank field is written");
      const rowQ = getProviderRow("rt-apply");
      assertEq(rowQ.epost, "post@fullhouse.no", "q3: epost written from Brreg");
      assertEq(rowQ.telefon, "eksisterende", "q4: existing telefon untouched");

      // ── (r) locked rows skipped without a Brreg call ─────────────────────
      fetchCalls = [];
      const lockedRes = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["sel-locked"] } });
      assertEq(lockedRes.body.skipped_locked, ["sel-locked"], "r1: locked row reported in skipped_locked");
      assertEq(fetchCalls.length, 0, "r2: no Brreg call issued for a locked row");
      assertEq(lockedRes.body.changed.length, 0, "r3: locked row produces no change entry");

      // ── (s) provider with no contact in Brreg ────────────────────────────
      mkProvider({ id: "rt-nocontact", navn: "Route No Contact", org_nr: orgFor(SHAPE_WEBSITE_ONLY), hjemmeside: "https://har.no", created_at: "2026-03-03 00:00:00" });
      const noContact = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-nocontact"], apply: true } });
      assertEq(noContact.body.changed.length, 0, "s1: no contact in Brreg -> nothing written");
      assertEq(noContact.body.unresolved[0]?.reason, "no_brreg_contact", "s2: bucketed as no_brreg_contact, not silently dropped");
      assertEq(getProviderRow("rt-nocontact").epost, null, "s3: row untouched");

      // ── (t) Brreg lookup failure ─────────────────────────────────────────
      mkProvider({ id: "rt-brregfail", navn: "Route Brreg Fail", org_nr: "810000500", created_at: "2026-03-04 00:00:00" });
      const brregFail = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-brregfail"], apply: true } });
      assertEq(brregFail.status, 200, "t1: a Brreg failure does not fail the request");
      assertEq(brregFail.body.unresolved[0]?.reason, "brreg_lookup_failed_or_404", "t2: bucketed as a lookup failure");
      assertEq(brregFail.body.errors.length, 0, "t3: a documented-never-throws failure is not an error[] entry");
      assertEq(getProviderRow("rt-brregfail").epost, null, "t4: no write on lookup failure");

      // ── (u) hjemmeside never written to the row ──────────────────────────
      mkProvider({ id: "rt-website", navn: "Route Website", org_nr: orgFor(SHAPE_WEBSITE_ONLY), created_at: "2026-03-05 00:00:00" });
      const web = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-website"], apply: true } });
      assertEq(getProviderRow("rt-website").hjemmeside, null, "u1: Brreg hjemmeside is NEVER written straight to the provider row");
      assertEq(web.body.website_candidates[0]?.candidate_url, "https://kun-nettside.no", "u2: it is reported as a website candidate");
      const queued = expDb.prepare(
        `SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`
      ).get("rt-website") as any;
      assertEq(queued?.candidate_url, "https://kun-nettside.no", "u3: and routed into the website review queue instead");
      assertEq(queued?.reason, "brreg_registered_hjemmeside", "u4: queue entry carries the Brreg-evidence reason");

      // ── (v) hit-rate reporting — the number the dry-run exists to make ───
      mkProvider({ id: "rt-rate-a", navn: "Rate A", org_nr: orgFor(SHAPE_FULL), created_at: "2026-04-01 00:00:00" }); // epost+telefon
      mkProvider({ id: "rt-rate-b", navn: "Rate B", org_nr: orgFor(SHAPE_EMAIL_ONLY), created_at: "2026-04-02 00:00:00" }); // epost only
      mkProvider({ id: "rt-rate-c", navn: "Rate C", org_nr: orgFor(SHAPE_PHONE_ONLY), created_at: "2026-04-03 00:00:00" }); // telefon only
      mkProvider({ id: "rt-rate-d", navn: "Rate D", org_nr: orgFor(SHAPE_EMPTY), created_at: "2026-04-04 00:00:00" }); // nothing
      const rate = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { providerIds: ["rt-rate-a", "rt-rate-b", "rt-rate-c", "rt-rate-d"] },
      });
      assertEq(rate.body.scanned, 4, "v1: scanned counts every row that reached a Brreg lookup");
      assertEq(rate.body.brreg_hits, { epost: 2, telefon: 2, any: 3 }, "v2: per-field and any-channel hit counts are accurate");
      assertEq(rate.body.cohort_total, store.countGardssalgProvidersForContactBackfill(), "v3: cohort_total reports the remaining walk");
      assertEq(rate.body.changed.length, 3, "v4: three of four rows would be enriched");
      assertEq(rate.body.unresolved.filter((u: any) => u.reason === "no_brreg_contact").length, 1, "v5: the contact-less row is bucketed");

      // ── (x) route: the write-time gate surfaces in the response (Skive C(a))
      // — a Brreg-registered address on a domain the producer's own homepage
      // does not use is queued for review, not published. ────────────────────
      mkProvider({
        id: "rt-gate", navn: "Route Gate", org_nr: orgFor(SHAPE_FULL),
        hjemmeside: "https://rutegaarden.no", created_at: "2026-05-01 00:00:00",
      });
      const gated = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-gate"], apply: true } });
      assertEq(gated.status, 200, "x1: the route still returns 200");
      assertEq(
        gated.body.contact_email_flagged_for_review.map((f: any) => f.provider_id),
        ["rt-gate"],
        "x2: the held-back candidate is reported in contact_email_flagged_for_review",
      );
      assertEq(
        gated.body.contact_email_flagged_for_review[0]?.candidate_email,
        "post@fullhouse.no",
        "x3: the reported entry names the candidate address",
      );
      assertEq(
        gated.body.contact_email_flagged_for_review[0]?.website_domain,
        "rutegaarden.no",
        "x4: the reported entry names the homepage domain it disagreed with",
      );
      assertTrue(
        !gated.body.changed.some((c: any) => (c.fields ?? []).includes("epost")),
        "x5: the flagged address never appears as a written epost in changed[]",
      );
      assertEq(getProviderRow("rt-gate").epost, null, "x6: the row's epost is still blank");
      assertEq(
        JSON.parse(getProviderRow("rt-gate").field_provenance || "{}").contact_email_flagged_review?.flagged_email,
        "post@fullhouse.no",
        "x7: the review stamp landed on the row",
      );
      assertEq(
        gated.body.unresolved.filter((u: any) => u.provider_id === "rt-gate").length,
        0,
        "x8: a flagged row is NOT mislabelled 'already_filled_or_locked_at_write_time'",
      );

      // ── (y) POST /admin/gardssalg-contact-email-audit (Skive C(c), AC5) ────
      const auditUrl = "/admin/gardssalg-contact-email-audit";
      {
        const unauthAudit = await callRoute(opplevelserRouter, { url: auditUrl, body: {} });
        assertEq(unauthAudit.status, 403, "y0: audit endpoint is admin-gated");
      }
      // Already-published legacy mismatches — exactly the Hull-1 population
      // the write-time gate cannot reach.
      mkProvider({
        id: "aud-mismatch", navn: "Audit Mismatch", org_nr: orgFor(SHAPE_EMPTY),
        hjemmeside: "https://audmismatch.no", epost: "kontakt@heltannenbedrift.no",
        created_at: "2026-06-01 00:00:00",
      });
      mkProvider({
        id: "aud-same", navn: "Audit Same", org_nr: orgFor(SHAPE_EMPTY),
        hjemmeside: "https://www.audsame.no", epost: "post@audsame.no",
        created_at: "2026-06-02 00:00:00",
      });
      mkProvider({
        id: "aud-freemail", navn: "Audit Freemail", org_nr: orgFor(SHAPE_EMPTY),
        hjemmeside: "https://audfreemail.no", epost: "audgarden@gmail.com",
        created_at: "2026-06-03 00:00:00",
      });
      mkProvider({
        id: "aud-locked", navn: "Audit Locked", org_nr: orgFor(SHAPE_EMPTY),
        hjemmeside: "https://audlocked.no", epost: "eier@annetfirma.no", content_source: "claim",
        created_at: "2026-06-04 00:00:00",
      });
      // An active Skive A force-approval override for this exact address —
      // Daniel already reviewed it; the audit must never re-flag it.
      mkProvider({
        id: "aud-override", navn: "Audit Override", org_nr: orgFor(SHAPE_EMPTY),
        hjemmeside: "https://audoverride.no", epost: "post@godkjentannet.no",
        created_at: "2026-06-05 00:00:00",
      });
      expDb.prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = 'aud-override'`).run(
        JSON.stringify({
          contact_email_domain_override: {
            approved_email: "post@godkjentannet.no",
            approved_by: "admin",
            approved_at: "2026-08-17T10:00:00.000Z",
            source: "manuell verifisering",
            website_domain: "audoverride.no",
            email_domain: "godkjentannet.no",
          },
        }),
      );

      const auditDry = await callRoute(opplevelserRouter, { url: auditUrl, headers: auth, body: {} });
      assertEq(auditDry.status, 200, "y1: audit dry-run returns 200");
      assertEq(auditDry.body.dry_run, true, "y2: dry_run defaults to true");
      const dryIds = auditDry.body.mismatches.map((m: any) => m.provider_id);
      assertTrue(dryIds.includes("aud-mismatch"), "y3: a genuine domain mismatch is counted");
      assertTrue(!dryIds.includes("aud-same"), "y4: a same-domain row is not a mismatch");
      assertTrue(!dryIds.includes("aud-freemail"), "y5: a freemail address is exempt");
      assertTrue(!dryIds.includes("aud-override"), "y6: an active force-approval override is exempt");
      assertTrue(!dryIds.includes("aud-locked"), "y7: an owner/manual-locked row is never auto-flagged");
      assertEq(
        auditDry.body.locked_not_flagged.map((l: any) => l.provider_id),
        ["aud-locked"],
        "y8: but the locked row IS reported, not silently unknown",
      );
      assertEq(auditDry.body.already_override_exempt, 1, "y9: the override exemption is counted, not hidden");
      assertEq(auditDry.body.mismatch_count, auditDry.body.mismatches.length, "y10: mismatch_count matches the list length");
      assertEq(auditDry.body.newly_flagged, 0, "y11: a dry run flags nothing");
      assertTrue(auditDry.body.cohort_total >= 5, "y12: cohort_total counts every row with both a homepage and an epost");
      assertEq(
        JSON.parse(getProviderRow("aud-mismatch").field_provenance || "{}").contact_email_flagged_review,
        undefined,
        "y13: a dry run wrote NOTHING to the row",
      );

      const auditApply = await callRoute(opplevelserRouter, { url: auditUrl, headers: auth, body: { apply: true } });
      assertEq(auditApply.body.dry_run, false, "y14: apply:true flips dry_run off");
      assertEq(auditApply.body.newly_flagged, auditDry.body.mismatch_count, "y15: apply flags every reported mismatch");
      const stampY = JSON.parse(getProviderRow("aud-mismatch").field_provenance || "{}").contact_email_flagged_review;
      assertEq(stampY?.flagged_email, "kontakt@heltannenbedrift.no", "y16: the stamp names the flagged address");
      assertEq(stampY?.source, "catalog_audit", "y17: the stamp records that the audit raised it");
      assertEq(stampY?.email_domain, "heltannenbedrift.no", "y18: the stamp records the deviating domain");
      assertEq(getProviderRow("aud-mismatch").epost, "kontakt@heltannenbedrift.no", "y19: the audit never changes the epost column itself");
      assertEq(getAuditRows("aud-mismatch").length, 0, "y20: flagging writes no gardssalg_content_audit row (it is not a content change)");
      assertEq(
        JSON.parse(getProviderRow("aud-override").field_provenance || "{}").contact_email_flagged_review,
        undefined,
        "y21: an override-exempt row is never stamped",
      );
      assertEq(
        JSON.parse(getProviderRow("aud-locked").field_provenance || "{}").contact_email_flagged_review,
        undefined,
        "y22: a locked row is never stamped",
      );

      const auditRerun = await callRoute(opplevelserRouter, { url: auditUrl, headers: auth, body: {} });
      assertEq(auditRerun.body.mismatch_count, 0, "y23: idempotent — a second run finds no NEW mismatch");
      assertEq(auditRerun.body.already_flagged, auditDry.body.mismatch_count, "y24: the flagged rows are now reported as already_flagged");

      // A lapse check that mirrors the override stamp's: change the address
      // and the old flag stops applying, so the row is re-detected.
      expDb.prepare(`UPDATE experience_providers SET epost = 'ny@ennyannen.no' WHERE id = 'aud-mismatch'`).run();
      const auditAfterChange = await callRoute(opplevelserRouter, { url: auditUrl, headers: auth, body: {} });
      assertTrue(
        auditAfterChange.body.mismatches.some((m: any) => m.provider_id === "aud-mismatch"),
        "y25: a stale flag lapses when epost changes — the new address is re-detected",
      );
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-contact-backfill.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgContactBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
