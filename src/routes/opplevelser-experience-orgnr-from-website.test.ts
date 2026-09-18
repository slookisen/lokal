/**
 * opplevelser-experience-orgnr-from-website.test.ts — tests for
 * POST /admin/experiences-orgnr-from-website (routes/opplevelser.ts) and its
 * underlying services/experience-orgnr-from-website.ts.
 *
 * PROBLEM this closes (dev-request 2026-09-14-opplevagent-karantene-utgang-
 * brreg-krav, Trinn A): the existing Brreg re-check (experience-brreg-
 * recheck-backfill.ts) is a NAME search, which only resolves a small
 * fraction of the 1774-row brreg_active IS NULL backlog. This file's target
 * fetches the provider's OWN website, extracts its OWN labeled org.nr, and
 * looks THAT org.nr up directly in Brreg (verifyOrgNumber) — corroborating
 * the hit (name or poststed/kommune must agree) before ever writing.
 *
 * Same harness conventions as opplevelser-experience-brreg-recheck-
 * backfill.test.ts: in-memory experiences DB (EXPERIENCES_DB_PATH=":memory:"),
 * fresh requires per run, router.handle() as the HTTP entry point. Unlike
 * that file (which stubs Brreg via experience-brreg's own
 * __setBrregFetchForTesting seam), THIS file's underlying service calls
 * fetchPage() (services/fetch-page.ts) and brreg-client.ts's
 * verifyOrgNumber()/fetchBrregBusinessAddress() directly with no injected
 * fetchImpl call site — same convention the gårdssalg org_nr-backfill route
 * tests already use for these exact functions
 * (opplevelser-gardssalg-orgnr-backfill.test.ts: "globalThis.fetch stubbed
 * since findOrgnumberByName has no injected-fetchImpl call site here") and
 * the RFB/dental website-discovery routes use for fetchPage() itself
 * (admin-rfb-website-discovery.test.ts's stubFetch()) — so this file swaps
 * globalThis.fetch, not a third mocking convention. No live network anywhere
 * in this file.
 *
 * Covers:
 *   (a) extractOrgNrFromText pure-function cases (label variants, MVA
 *       variant, unlabeled 9-digit non-match, mixed text).
 *   (b) auth: no X-Admin-Key -> 403.
 *   (c) selection: brreg_active already 0/1, NULL hjemmeside, owner-locked
 *       (content_source manual/claim), catalog_hidden=1 — all excluded, and
 *       NEVER fetched (fetchCalls proof).
 *   (d) dry-run: every outcome bucket classified correctly, ZERO DB writes.
 *   (e) apply (dry_run:false): resolved_active/resolved_inactive rows are
 *       ACTUALLY written; every other outcome leaves brreg_active NULL.
 *   (f) org.nr found + Brreg active + name-corroborated -> resolved_active.
 *   (g) org.nr found + Brreg confirms konkurs -> resolved_inactive.
 *   (h) org.nr found + Brreg has no such entity -> orgnr_not_found_in_brreg.
 *   (i) org.nr found + Brreg entity exists/active but name AND poststed/
 *       kommune both mismatch -> corroboration_failed (the key precision
 *       test Daniel's condition requires).
 *   (j) org.nr found + corroborated, but already held by a DIFFERENT row ->
 *       orgnr_collision, no write, no thrown DB error.
 *   (k) homepage has nothing, but a discovered contact/about sub-page does
 *       -> resolved via the sub-page fetch.
 *   (l) no org.nr found anywhere fetched -> no_orgnr_found.
 *   (m) homepage fetch itself fails -> fetch_failed (distinct from
 *       no_orgnr_found).
 *   (n) STRICT dry_run parse: dry_run:"false" (string) is NOT apply.
 *   (o) time budget: an injected clock already past budget on the very
 *       first check -> the row lands in skipped_due_to_time_budget, ZERO
 *       fetches attempted for it (fetch-call counter proof).
 *   (p) pagination: a full page advances next_after; a page with no writes
 *       still advances (never re-selects the same rows forever).
 *   (q) enrichment write-pause fence: blocks apply (423), never blocks
 *       dry-run.
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
  opts: { url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url;
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      app: { get() { return undefined; } },
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

/** Deterministic PER-LABEL 9-digit org_nr — avoids hardcoded literals
 * colliding across test scenarios (org_nr carries a UNIQUE constraint on
 * experience_providers). Mirrors the sibling recheck-backfill test's own
 * orgNrFor() helper. */
function orgNrFor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return "8" + String(h % 100000000).padStart(8, "0");
}

function htmlResponse(html: string, finalUrl: string): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: { get: () => null },
  } as unknown as Response;
}

function brregEnhetResponse(o: {
  orgNr: string;
  navn: string;
  konkurs?: boolean;
  poststed?: string | null;
}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      organisasjonsnummer: o.orgNr,
      navn: o.navn,
      konkurs: o.konkurs ?? false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      slettedato: null,
      forretningsadresse: o.poststed
        ? { adresse: ["Testveien 1"], postnummer: "0000", poststed: o.poststed }
        : null,
    }),
  } as unknown as Response;
}

export function runOpplevelserExperienceOrgnrFromWebsiteTests(
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
    const testKey = process.env.ADMIN_KEY || "orgnr-from-website-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const svcPath = require.resolve("../services/experience-orgnr-from-website");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, svcPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const initMod = require("../database/init") as typeof import("../database/init");
    const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
    brregClient.__clearBrregVerifyCacheForTesting();
    brregClient.__clearBrregAddressCacheForTesting();

    // URL -> Response. Two disjoint keyspaces: exact page URLs (the "https://…"
    // homepage/sub-page requests fetchPage() issues) and "<9-digit-orgnr>" for
    // the Brreg GET /enheter/{orgNr} lookups both verifyOrgNumber() and
    // fetchBrregBusinessAddress() hit (same endpoint, same response, no
    // fetchImpl injection point here — see file header).
    const pageFixtures: Map<string, Response> = new Map();
    const brregFixtures: Map<string, Response> = new Map();
    const fetchCalls: string[] = [];

    function stubFetch(): typeof fetch {
      return (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCalls.push(urlStr);
        const enhetMatch = urlStr.match(/\/enheter\/(\d{9})$/);
        if (enhetMatch) {
          return brregFixtures.get(enhetMatch[1]!) ?? notFoundResponse();
        }
        return pageFixtures.get(urlStr) ?? notFoundResponse();
      }) as unknown as typeof fetch;
    }
    globalThis.fetch = stubFetch();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const svc = require("../services/experience-orgnr-from-website") as
        typeof import("../services/experience-orgnr-from-website");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const adminHeaders = { "x-admin-key": testKey };
      const ROUTE = "/admin/experiences-orgnr-from-website";

      // ═══ (a) extractOrgNrFromText — pure function ══════════════════════
      {
        assertEq(svc.extractOrgNrFromText("Org.nr: 923 456 789"), "923456789", "owf-a1: labeled, spaced");
        assertEq(svc.extractOrgNrFromText("org.nr:923456789"), "923456789", "owf-a2: labeled, no spaces, lowercase");
        assertEq(svc.extractOrgNrFromText("Organisasjonsnummer 923 456 789"), "923456789", "owf-a3: organisasjonsnummer label variant");
        assertEq(svc.extractOrgNrFromText("Foretaksnr: 923456789"), "923456789", "owf-a4: foretaksnr label variant");
        assertEq(svc.extractOrgNrFromText("NO 923 456 789 MVA"), "923456789", "owf-a5: MVA form, spaced");
        assertEq(svc.extractOrgNrFromText("NO923456789MVA"), "923456789", "owf-a6: MVA form, no spaces");
        assertEq(svc.extractOrgNrFromText("Telefon: 923 45 678, Kontonummer 923456789"), null, "owf-a7: unlabeled 9-digit numbers (phone-like/account-like) never match");
        assertEq(svc.extractOrgNrFromText("Velkommen til gården vår! Vi selger egg og honning."), null, "owf-a8: ordinary text, no match");
        assertEq(
          svc.extractOrgNrFromText("Om oss. Kontakt: post@gard.no. Org.nr: 923 456 789. Følg oss på Facebook."),
          "923456789",
          "owf-a9: labeled org-nr embedded in mixed surrounding text",
        );
      }

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, brreg_active, brreg_verified, org_nr, content_source, catalog_hidden, kommune, postnummer, poststed, hjemmeside, producer_type)
         VALUES (@id, @navn, @brreg_active, @brreg_verified, @org_nr, @content_source, @catalog_hidden, @kommune, @postnummer, @poststed, @hjemmeside, @producer_type)`,
      );
      const seedProvider = (o: {
        id: string; navn: string; brreg_active?: number | null; brreg_verified?: number; org_nr?: string | null;
        content_source?: string | null; catalog_hidden?: number | null; kommune?: string | null;
        postnummer?: string | null; poststed?: string | null; hjemmeside?: string | null;
        // dev-request 2026-09-18-opplevagent-skop-katalogen-til-gardssalg-og-
        // drikke, del 1: defaults to 'bryggeri' so every fixture in this file
        // (whose subject — Trinn A org.nr-from-website — is unrelated to the
        // scope gate) is, by construction, in the gårdssalg cohort per
        // experience-scope.ts's isProviderInGardssalgCohort(). Pass
        // `producer_type: null` explicitly to seed a genuinely OUT-OF-SCOPE
        // provider for the dedicated scope-gate cases below.
        producer_type?: string | null;
      }) => {
        insertProvider.run({
          id: o.id, navn: o.navn,
          brreg_active: o.brreg_active === undefined ? null : o.brreg_active,
          brreg_verified: o.brreg_verified ?? 0,
          org_nr: o.org_nr ?? null,
          content_source: o.content_source ?? null,
          catalog_hidden: o.catalog_hidden ?? null,
          kommune: o.kommune ?? null,
          postnummer: o.postnummer ?? null,
          poststed: o.poststed ?? null,
          hjemmeside: o.hjemmeside ?? null,
          producer_type: o.producer_type === undefined ? "bryggeri" : o.producer_type,
        });
      };
      const providerRow = (id: string) =>
        expDb
          .prepare(`SELECT brreg_active, brreg_verified, org_nr, brreg_checked_at FROM experience_providers WHERE id = ?`)
          .get(id) as { brreg_active: number | null; brreg_verified: number; org_nr: string | null; brreg_checked_at: string | null };

      // ═══ (b) auth ═══════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, body: {} });
        assertEq(r.status, 403, "owf-b1: no X-Admin-Key -> 403");
      }

      // ═══ (c)-(m) main batch: selection exclusions + every outcome ═══════
      // ── selection-exclusion rows (never a candidate; never fetched) ─────
      seedProvider({ id: "prov-already-active", navn: "Aktiv AlleredeSatt AS", brreg_active: 1, brreg_verified: 1, hjemmeside: "https://alreadyactive1.test" });
      seedProvider({ id: "prov-already-inactive", navn: "Nedlagt AlleredeSatt AS", brreg_active: 0, brreg_verified: 1, hjemmeside: "https://alreadyinactive1.test" });
      seedProvider({ id: "prov-null-website", navn: "Uten Nettside AS", hjemmeside: null });
      seedProvider({ id: "prov-locked-manual", navn: "Låst Eier AS", content_source: "manual", hjemmeside: "https://lockedmanual1.test" });
      seedProvider({ id: "prov-locked-claim", navn: "Låst Claim AS", content_source: "claim", hjemmeside: "https://lockedclaim1.test" });
      seedProvider({ id: "prov-hidden", navn: "Skjult Katalog AS", catalog_hidden: 1, hjemmeside: "https://hidden1.test" });

      // ── (f) resolved_active ──────────────────────────────────────────────
      const orgNrActive = orgNrFor("active1");
      seedProvider({ id: "prov-active", navn: "Aktiv Gaardsprodukter AS", poststed: "Lillehammer", kommune: "Lillehammer", hjemmeside: "https://active1.test" });
      pageFixtures.set("https://active1.test", htmlResponse(
        `<html><body><p>Velkommen. Org.nr: ${orgNrActive.slice(0, 3)} ${orgNrActive.slice(3, 6)} ${orgNrActive.slice(6)}</p></body></html>`,
        "https://active1.test",
      ));
      brregFixtures.set(orgNrActive, brregEnhetResponse({ orgNr: orgNrActive, navn: "AKTIV GAARDSPRODUKTER AS" }));

      // ── (g) resolved_inactive ─────────────────────────────────────────────
      const orgNrInactive = orgNrFor("inactive1");
      seedProvider({ id: "prov-inactive", navn: "Nedlagt Seterdrift AS", hjemmeside: "https://inactive1.test" });
      pageFixtures.set("https://inactive1.test", htmlResponse(
        `<html><body>Org.nr: ${orgNrInactive}</body></html>`,
        "https://inactive1.test",
      ));
      brregFixtures.set(orgNrInactive, brregEnhetResponse({ orgNr: orgNrInactive, navn: "NEDLAGT SETERDRIFT AS", konkurs: true }));

      // ── (h) orgnr_not_found_in_brreg ──────────────────────────────────────
      const orgNrNotFound = orgNrFor("notfound1");
      seedProvider({ id: "prov-notfound", navn: "Ukjent Firma AS", hjemmeside: "https://notfound1.test" });
      pageFixtures.set("https://notfound1.test", htmlResponse(
        `<html><body>Org.nr: ${orgNrNotFound}</body></html>`,
        "https://notfound1.test",
      ));
      // Deliberately no brregFixtures entry for orgNrNotFound -> falls through to notFoundResponse() (404).

      // ── (i) corroboration_failed ─────────────────────────────────────────
      const orgNrMismatch = orgNrFor("mismatch1");
      seedProvider({ id: "prov-mismatch", navn: "Blomsterhagen Gard", poststed: "Molde", kommune: "Molde", hjemmeside: "https://mismatch1.test" });
      pageFixtures.set("https://mismatch1.test", htmlResponse(
        `<html><body>Org.nr: ${orgNrMismatch}</body></html>`,
        "https://mismatch1.test",
      ));
      brregFixtures.set(orgNrMismatch, brregEnhetResponse({ orgNr: orgNrMismatch, navn: "HELT UBESLEKTET SELSKAP AS", poststed: "Bergen" }));

      // ── (j) orgnr_collision ───────────────────────────────────────────────
      const orgNrCollide = orgNrFor("collide1");
      seedProvider({ id: "prov-collide-existing", navn: "Kolliderende Original AS", org_nr: orgNrCollide, brreg_active: 1, brreg_verified: 1 });
      seedProvider({ id: "prov-collide-new", navn: "Kolliderende Gaard AS", hjemmeside: "https://collide1.test" });
      pageFixtures.set("https://collide1.test", htmlResponse(
        `<html><body>Org.nr: ${orgNrCollide}</body></html>`,
        "https://collide1.test",
      ));
      brregFixtures.set(orgNrCollide, brregEnhetResponse({ orgNr: orgNrCollide, navn: "KOLLIDERENDE GAARD AS" }));

      // ── (k) resolved via a discovered sub-page ───────────────────────────
      const orgNrSubpage = orgNrFor("subpage1");
      seedProvider({ id: "prov-subpage", navn: "Kontaktside Gaard AS", hjemmeside: "https://subpage1.test" });
      pageFixtures.set("https://subpage1.test", htmlResponse(
        `<html><body><p>Velkommen til gården.</p><a href="/kontakt">Kontakt oss</a></body></html>`,
        "https://subpage1.test",
      ));
      pageFixtures.set("https://subpage1.test/kontakt", htmlResponse(
        `<html><body>Org.nr: ${orgNrSubpage}</body></html>`,
        "https://subpage1.test/kontakt",
      ));
      brregFixtures.set(orgNrSubpage, brregEnhetResponse({ orgNr: orgNrSubpage, navn: "KONTAKTSIDE GAARD AS" }));

      // ── (l) no_orgnr_found ────────────────────────────────────────────────
      seedProvider({ id: "prov-noorgnr", navn: "Ingen Orgnr Gaard AS", hjemmeside: "https://noorgnr1.test" });
      pageFixtures.set("https://noorgnr1.test", htmlResponse(
        `<html><body><p>Velkommen. Telefon: 12345678.</p></body></html>`,
        "https://noorgnr1.test",
      ));

      // ── (m) fetch_failed ──────────────────────────────────────────────────
      seedProvider({ id: "prov-fetchfail", navn: "Feilet Fetch Gaard AS", hjemmeside: "https://fetchfail1.test" });
      // No pageFixtures entry -> stubFetch() falls through to notFoundResponse() (404, permanent, not retried).

      // ── (d) dry-run: correct classification everywhere, ZERO writes ──────
      let dryRes: RouteResult;
      {
        const beforeRows: Record<string, any> = {};
        for (const id of [
          "prov-active", "prov-inactive", "prov-notfound", "prov-mismatch",
          "prov-collide-new", "prov-subpage", "prov-noorgnr", "prov-fetchfail",
        ]) beforeRows[id] = providerRow(id);

        dryRes = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 20 } });
        assertEq(dryRes.status, 200, "owf-d1: dry-run -> 200");
        assertEq(dryRes.body.dry_run, true, "owf-d2: apply omitted -> dry_run:true");

        const byId = new Map<string, any>((dryRes.body.planned as any[]).map((p) => [p.provider_id, p]));

        assertEq(byId.get("prov-active")?.outcome, "resolved_active", "owf-d3: labeled org.nr + active Brreg + name overlap -> resolved_active");
        assertEq(byId.get("prov-active")?.org_nr, orgNrActive, "owf-d3b: org_nr reported matches the extracted one");
        assertEq(byId.get("prov-inactive")?.outcome, "resolved_inactive", "owf-d4: labeled org.nr + konkurs Brreg entity -> resolved_inactive");
        assertEq(byId.get("prov-notfound")?.outcome, "orgnr_not_found_in_brreg", "owf-d5: extracted org.nr, Brreg has no such entity");
        assertEq(byId.get("prov-mismatch")?.outcome, "corroboration_failed", "owf-d6: Brreg entity exists+active but name AND poststed/kommune both mismatch");
        assertEq(byId.get("prov-collide-new")?.outcome, "orgnr_collision", "owf-d7: corroborated org.nr already held by a different row");
        assertEq(byId.get("prov-subpage")?.outcome, "resolved_active", "owf-d8: homepage empty, discovered /kontakt sub-page carries the org.nr");
        assertEq(byId.get("prov-noorgnr")?.outcome, "no_orgnr_found", "owf-d9: no labeled org.nr anywhere fetched");
        assertEq(byId.get("prov-fetchfail")?.outcome, "fetch_failed", "owf-d10: homepage fetch itself failed (distinct from no_orgnr_found)");

        assertEq(dryRes.body.processed, 8, "owf-d11: processed=8 — exactly the 8 true candidates, none of the 6 excluded rows");
        assertEq(dryRes.body.resolved_active, 2, "owf-d12: aggregate resolved_active=2 (prov-active + prov-subpage)");
        assertEq(dryRes.body.resolved_inactive, 1, "owf-d13: aggregate resolved_inactive=1");
        assertEq(dryRes.body.orgnr_not_found_in_brreg, 1, "owf-d14: aggregate orgnr_not_found_in_brreg=1");
        assertEq(dryRes.body.corroboration_failed, 1, "owf-d15: aggregate corroboration_failed=1");
        assertEq(dryRes.body.orgnr_collision, 1, "owf-d16: aggregate orgnr_collision=1");
        assertEq(dryRes.body.no_orgnr_found, 1, "owf-d17: aggregate no_orgnr_found=1");
        assertEq(dryRes.body.fetch_failed, 1, "owf-d18: aggregate fetch_failed=1");
        assertEq(dryRes.body.errors, 0, "owf-d19: aggregate errors=0");
        assertEq(
          dryRes.body.resolved_active + dryRes.body.resolved_inactive + dryRes.body.no_orgnr_found +
          dryRes.body.orgnr_not_found_in_brreg + dryRes.body.corroboration_failed + dryRes.body.orgnr_collision +
          dryRes.body.fetch_failed + dryRes.body.errors,
          dryRes.body.processed,
          "owf-d20: every outcome bucket sums exactly to processed — no double counting",
        );

        for (const excludedId of [
          "prov-already-active", "prov-already-inactive", "prov-null-website",
          "prov-locked-manual", "prov-locked-claim", "prov-hidden",
        ]) {
          assertTrue(!byId.has(excludedId), `owf-d21 ${excludedId}: never selected as a candidate`);
        }
        assertTrue(!fetchCalls.includes("https://alreadyactive1.test"), "owf-d22: already brreg_active=1 row never fetched");
        assertTrue(!fetchCalls.includes("https://lockedmanual1.test"), "owf-d23: content_source=manual row never fetched");
        assertTrue(!fetchCalls.includes("https://lockedclaim1.test"), "owf-d24: content_source=claim row never fetched");
        assertTrue(!fetchCalls.includes("https://hidden1.test"), "owf-d25: catalog_hidden row never fetched");

        // ZERO writes from the dry-run, across every outcome bucket.
        for (const id of [
          "prov-active", "prov-inactive", "prov-notfound", "prov-mismatch",
          "prov-collide-new", "prov-subpage", "prov-noorgnr", "prov-fetchfail",
        ]) {
          assertEq(providerRow(id), beforeRows[id], `owf-d26 ${id}: dry-run wrote NOTHING`);
        }
      }

      // ── (n) STRICT dry_run parse: a STRING "false" is NOT apply ─────────
      {
        const before = providerRow("prov-active");
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: "false", limit: 20 } });
        assertEq(r.body.dry_run, true, "owf-n1: dry_run:'false' (string) is still treated as dry-run");
        assertEq(providerRow("prov-active"), before, "owf-n2: …and nothing was written");
      }

      // ═══ (e) apply: actual writes, only for the two resolved buckets ════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 20 } });
        assertEq(r.status, 200, "owf-e1: apply -> 200");
        assertEq(r.body.dry_run, false, "owf-e2: dry_run:false echoed back");
        assertEq(r.body.resolved_active, 2, "owf-e3: resolved_active=2 on the real run too");
        assertEq(r.body.resolved_inactive, 1, "owf-e4: resolved_inactive=1");

        const active = providerRow("prov-active");
        assertEq(active.brreg_active, 1, "owf-e5: prov-active.brreg_active -> 1 (actually written)");
        assertEq(active.brreg_verified, 1, "owf-e6: prov-active.brreg_verified -> 1");
        assertEq(active.org_nr, orgNrActive, "owf-e7: prov-active.org_nr written from the extracted+verified org.nr");
        assertTrue(!!active.brreg_checked_at, "owf-e8: prov-active.brreg_checked_at stamped");

        const subpageRow = providerRow("prov-subpage");
        assertEq(subpageRow.brreg_active, 1, "owf-e9: prov-subpage.brreg_active -> 1 (resolved via the sub-page fetch)");
        assertEq(subpageRow.org_nr, orgNrSubpage, "owf-e10: prov-subpage.org_nr written");

        const inactive = providerRow("prov-inactive");
        assertEq(inactive.brreg_active, 0, "owf-e11: prov-inactive.brreg_active -> 0 (a confirmed answer, not a guess)");
        assertEq(inactive.brreg_verified, 1, "owf-e12: prov-inactive.brreg_verified -> 1");
        assertEq(inactive.org_nr, orgNrInactive, "owf-e13: prov-inactive.org_nr written");

        // Every non-resolved bucket stays byte-identical — NEVER guessed.
        assertEq(providerRow("prov-notfound").brreg_active, null, "owf-e14: prov-notfound STILL NULL");
        assertEq(providerRow("prov-mismatch").brreg_active, null, "owf-e15: prov-mismatch STILL NULL");
        assertEq(providerRow("prov-collide-new").brreg_active, null, "owf-e16: prov-collide-new STILL NULL (fail-closed on collision)");
        assertEq(providerRow("prov-collide-new").org_nr, null, "owf-e17: prov-collide-new.org_nr never written");
        assertEq(providerRow("prov-collide-existing").org_nr, orgNrCollide, "owf-e18: the row that legitimately holds the org_nr is untouched");
        assertEq(providerRow("prov-noorgnr").brreg_active, null, "owf-e19: prov-noorgnr STILL NULL");
        assertEq(providerRow("prov-fetchfail").brreg_active, null, "owf-e20: prov-fetchfail STILL NULL");
      }

      // ═══ (p) pagination: a page with no writes still ADVANCES ══════════
      {
        // ids sort AFTER everything seeded above ('z' > 'p') so the cursor
        // isolates this section. All three yield no_orgnr_found (no state
        // change) — proving next_after still converges instead of a bare
        // `ORDER BY id LIMIT ?` re-selecting them forever.
        seedProvider({ id: "zzp-01", navn: "Ingen Orgnr Ett AS", hjemmeside: "https://zzp01.test" });
        seedProvider({ id: "zzp-02", navn: "Ingen Orgnr To AS", hjemmeside: "https://zzp02.test" });
        seedProvider({ id: "zzp-03", navn: "Ingen Orgnr Tre AS", hjemmeside: "https://zzp03.test" });
        for (const host of ["zzp01", "zzp02", "zzp03"]) {
          pageFixtures.set(`https://${host}.test`, htmlResponse("<html><body>Ingenting her.</body></html>", `https://${host}.test`));
        }

        const page1 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: "zzp-00" } });
        assertEq(page1.body.processed, 2, "owf-p1: page 1 processes exactly `limit` rows");
        assertEq(page1.body.next_after, "zzp-02", "owf-p2: next_after is the id of the LAST row this call scanned");
        const page1Ids = (page1.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          page1Ids.includes("zzp-01") && page1Ids.includes("zzp-02") && !page1Ids.includes("zzp-03"),
          `owf-p3: page 1 covers rows 1-2, not row 3 (got ${JSON.stringify(page1Ids)})`,
        );
        assertEq(providerRow("zzp-01").brreg_active, null, "owf-p4: row 1 left unchanged (no_orgnr_found, never guessed) — STILL eligible");

        const page2 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: page1.body.next_after } });
        const page2Ids = (page2.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          !page2Ids.includes("zzp-01") && !page2Ids.includes("zzp-02"),
          `owf-p5: page 2 does NOT re-process rows page 1 already scanned (got ${JSON.stringify(page2Ids)})`,
        );
        assertTrue(
          page2Ids.includes("zzp-03") && page2.body.next_after === null,
          `owf-p6: page 2 reaches row 3, and next_after is null once the page comes back shorter than \`limit\` (ids=${JSON.stringify(page2Ids)}, next_after=${page2.body.next_after})`,
        );
      }

      // ═══ (o) time budget: skip everything, zero fetches ═════════════════
      {
        seedProvider({ id: "zzt-01", navn: "Tidsbudsjett Ett AS", hjemmeside: "https://zzt01.test" });
        seedProvider({ id: "zzt-02", navn: "Tidsbudsjett To AS", hjemmeside: "https://zzt02.test" });
        // Fixtures deliberately absent — if the budget guard failed to skip
        // these rows, the fetch would hit notFoundResponse() and the row
        // would resolve fetch_failed instead of being skipped, which the
        // assertions below would catch.

        const fetchCallsBefore = fetchCalls.length;
        let calls = 0;
        svc.__setNowForTesting(() => {
          calls++;
          // First call establishes the batch's own start time (0). Every
          // subsequent call (the per-candidate budget check) reports the
          // budget as already exceeded — deterministic, no real waiting.
          return calls === 1 ? 0 : svc.EXPERIENCE_ORGNR_WEBSITE_TIME_BUDGET_MS + 1;
        });
        try {
          const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10, after: "zzt-00" } });
          assertEq(r.status, 200, "owf-o1: a time-budget-exceeded batch does not error");
          assertEq(r.body.processed, 0, "owf-o2: processed=0 — nothing was attempted");
          assertEq(
            [...r.body.skipped_due_to_time_budget].sort(),
            ["zzt-01", "zzt-02"],
            "owf-o3: both candidates land in skipped_due_to_time_budget",
          );
          assertEq(fetchCalls.length, fetchCallsBefore, "owf-o4: ZERO fetch calls were made for a batch that never got a chance to start");
        } finally {
          svc.__setNowForTesting(null);
        }
      }

      // ═══ (q) enrichment write-pause fence ════════════════════════════════
      {
        const BetterSqlite = require("better-sqlite3") as typeof import("better-sqlite3");
        const mainDb = new BetterSqlite(":memory:");
        mainDb.pragma("journal_mode = DELETE");
        mainDb.pragma("foreign_keys = OFF");
        const prevMainDb = initMod.__peekDbForTesting();
        initMod.__setDbForTesting(mainDb as any);
        initMod.__initSchemaForTesting(mainDb as any);

        const orgNrPaused = orgNrFor("paused1");
        seedProvider({ id: "prov-paused-01", navn: "Aktiv UnderPause AS", hjemmeside: "https://paused1.test" });
        pageFixtures.set("https://paused1.test", htmlResponse(`<html><body>Org.nr: ${orgNrPaused}</body></html>`, "https://paused1.test"));
        brregFixtures.set(orgNrPaused, brregEnhetResponse({ orgNr: orgNrPaused, navn: "AKTIV UNDERPAUSE AS" }));

        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "test: orgnr-from-website pause" }, "verifier");

        const before = providerRow("prov-paused-01");
        const blockedApply = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(blockedApply.status, 423, "owf-q1: apply under a live experiences pause -> 423");
        assertEq(blockedApply.body?.paused, true, "owf-q2: body.paused===true");
        assertEq(blockedApply.body?.vertical, "experiences", "owf-q3: body.vertical==='experiences'");
        assertEq(providerRow("prov-paused-01"), before, "owf-q4: ZERO writes across the blocked apply call");

        const dryUnderPause = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 5, after: "prov-paused-00" } });
        assertEq(dryUnderPause.status, 200, "owf-q5: dry-run under the SAME pause is NEVER blocked");

        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        const afterClear = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(afterClear.status, 200, "owf-q6: apply goes through again once the pause is cleared");
        assertEq(providerRow("prov-paused-01").brreg_active, 1, "owf-q7: …and actually writes now");

        initMod.__setDbForTesting(prevMainDb);
        try { mainDb.close(); } catch { /* ignore */ }
      }

      // ═══ (r) dev-request 2026-09-18-opplevagent-skop-katalogen-til-
      //      gardssalg-og-drikke, del 1: the in-scope gate. An out-of-scope
      //      provider (producer_type:null, no mat_drikke experience) is
      //      NEVER selected/fetched — proven on the fetchCalls log, not just
      //      a response counter. A provider IN the gårdssalg cohort is still
      //      resolved even with zero mat_drikke experiences (the OR rule). ══
      {
        const fetchCallsBefore = fetchCalls.length;

        seedProvider({
          id: "prov-scope-outofscope", navn: "Ukjent Museum AS",
          hjemmeside: "https://scope-outofscope.test", producer_type: null,
        });
        // Deliberately no pageFixtures/brregFixtures entry for this provider
        // — if this row were ever fetched it would 404 (notFoundResponse())
        // and stay unresolved either way, so the real proof below is that
        // its URL never appears in fetchCalls at all, not merely that
        // brreg_active stayed NULL.

        seedProvider({
          id: "prov-scope-viacohort", navn: "Gaardsdrikke Cohort AS",
          hjemmeside: "https://scope-viacohort.test", producer_type: "bryggeri",
        });
        const orgNrCohort = orgNrFor("scopecohort1");
        pageFixtures.set(
          "https://scope-viacohort.test",
          htmlResponse(`<html><body>Org.nr: ${orgNrCohort}</body></html>`, "https://scope-viacohort.test"),
        );
        brregFixtures.set(orgNrCohort, brregEnhetResponse({ orgNr: orgNrCohort, navn: "GAARDSDRIKKE COHORT AS" }));

        // `after` scoped past every earlier fixture id in this file (all
        // "prov-…" < "prov-scope-000" alphabetically) so this call's
        // candidate set is exactly these 2 new rows (+ the harmless already-
        // exercised zz*-prefixed pagination/time-budget fixtures, which sort
        // after "prov-scope-…" and are idempotent either way).
        const r = await callRoute(opplevelserRouter, {
          url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10, after: "prov-scope-000" },
        });
        assertEq(r.status, 200, "owf-r1: apply -> 200");
        assertTrue(
          !fetchCalls.slice(fetchCallsBefore).includes("https://scope-outofscope.test"),
          "owf-r2: the out-of-scope provider's own website was NEVER fetched",
        );
        assertEq(providerRow("prov-scope-outofscope").brreg_active, null, "owf-r3: out-of-scope provider's brreg_active left untouched (still NULL)");
        assertEq(providerRow("prov-scope-viacohort").brreg_active, 1, "owf-r4: the gårdssalg-cohort provider (zero mat_drikke experiences) WAS resolved and written");
        assertTrue((r.body.skipped_out_of_scope as number) >= 1, "owf-r5: response reports skipped_out_of_scope >= 1 (additive field, on top of every pre-existing field)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experience-orgnr-from-website: unexpected error: " + String(err?.stack || err));
    } finally {
      globalThis.fetch = prevFetch;
      brregClient.__clearBrregVerifyCacheForTesting();
      brregClient.__clearBrregAddressCacheForTesting();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserExperienceOrgnrFromWebsiteTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
