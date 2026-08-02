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
      assertEq(written1.sort(), ["epost", "telefon"], "k1: both blank fields written");
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
      assertEq(written2, ["telefon"], "l1: only the blank field is written");
      assertEq(getProviderRow("app-existing").epost, "gammel@post.no", "l2: an existing value is NEVER overwritten");

      mkProvider({ id: "app-locked", navn: "Apply Locked", org_nr: orgFor(SHAPE_FULL), content_source: "claim", created_at: "2026-02-03 00:00:00" });
      assertEq(
        store.applyGardssalgProviderContact("app-locked", { epost: "x@y.no", telefon: "1" }, "https://brreg.example/1"),
        [],
        "m1: locked provider -> nothing written"
      );
      assertEq(getProviderRow("app-locked").epost, null, "m2: locked provider row untouched");

      assertEq(
        store.applyGardssalgProviderContact("app-blank", { epost: "annen@post.no", telefon: "87654321" }, "https://brreg.example/1"),
        [],
        "n1: second call on a filled row is a no-op"
      );
      assertEq(getAuditRows("app-blank").length, 2, "n2: no-op writes no extra audit rows");

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
