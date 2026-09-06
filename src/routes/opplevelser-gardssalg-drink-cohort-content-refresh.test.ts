/**
 * opplevelser-gardssalg-drink-cohort-content-refresh.test.ts — unit tests for
 * the `cohort: "drink"` target-selection mode of
 * POST /api/opplevelser/admin/gardssalg-content-refresh.
 *
 * Background (A2A experiences-enrichment Step 4b-i, Grep 1 of dev-request
 * 2026-08-19-kursjustering-drikkefunnel-llm-og-supply): the routine used to
 * build the drink queue client-side — GET /admin/gardssalg-verified-
 * drinkproducer-cohort (the FULL verified cohort, insertion order, no
 * thin-filter, no attempt-ordering) then `head -8` per call. That list is
 * stable across runs and its head was long since fully enriched, so every
 * run re-tried the same complete rows, saw agents_enriched:0 twice and
 * stopped — 10+ consecutive runs of "0 beriket etter 2 kall" against a
 * 126–138-row cohort while thin drink rows further down were never reached.
 *
 * The fix moves the queue server-side: `cohort: "drink"` selects verified
 * drink producers that are still THIN on >=1 content field, oldest-attempted
 * first (same eligibility + cadence clause as the generic gårdssalg
 * auto-select), and reports `selection` + `cohort_eligible_total`.
 *
 * Same conventions as opplevelser-gardssalg-owner-lock-content-refresh.test.ts:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router, router.handle() exercised directly,
 * globalThis.fetch mocked (homepage + judge) — the sandbox has no network.
 *
 * Covers:
 *   1. A fully-enriched drink row at the head of the table is NOT selected
 *      (the exact bug) — only thin+verified drink rows are, and
 *      cohort_eligible_total counts them before `limit`.
 *   2. Non-drink, unverified, manual-locked, parked and website-less rows
 *      are all excluded from the drink cohort.
 *   3. Ordering: NULL last_content_attempt_at first, then oldest attempt;
 *      an apply call stamps the row so the NEXT call moves on to the next
 *      thin row instead of re-trying the same one.
 *   4. `selection` reporting: "drink_cohort" / "provider_ids" (providerIds
 *      wins over cohort) / "auto" (cohort omitted or null).
 *   5. An unknown cohort value is a 400 (`invalid_cohort`), never a silent
 *      fallback to the generic auto-select.
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
    const url = opts.url || "/admin/gardssalg-content-refresh";
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

export function runOpplevelserGardssalgDrinkCohortContentRefreshTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  let restoreMainDb: (() => void) | null = null;

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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-drink-cohort-cr-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-drink-cohort-cr";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      require("../services/experience-store");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            field_provenance, producer_type, last_content_attempt_at, homepage_unreachable_since, created_at,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products,
            @field_provenance, @producer_type, @last_content_attempt_at, @homepage_unreachable_since, @created_at,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      function provenance(verified: boolean): string {
        return JSON.stringify({
          hjemmeside_verification: {
            verified,
            classification: verified ? "verified" : "unverified",
            checked_at: "2026-01-01T00:00:00.000Z",
          },
        });
      }

      const FULL = {
        about_text: "En lang og god om-tekst som allerede er skrevet fra produsentens egen hjemmeside.",
        visit_text: "Besøkende er velkomne i gårdsbutikken hver lørdag mellom ti og fire.",
        opening_hours_text: "Lørdag 10–16",
        products: JSON.stringify(["Pils", "IPA"]),
      };
      const THIN = { about_text: null, visit_text: null, opening_hours_text: null, products: null };

      type Fixture = {
        id: string; navn: string; hjemmeside: string | null; content_source: string | null;
        producer_type: string; verified: boolean; last_content_attempt_at: string | null;
        homepage_unreachable_since?: string | null; created_at: string; full?: boolean;
      };
      const fixtures: Fixture[] = [
        // The bug row: FIRST in insertion order, verified drink producer,
        // every content field already filled -> must never consume a slot.
        { id: "dk-full", navn: "Fullt Beriket Bryggeri", hjemmeside: "https://dk-full.example.no", content_source: "provider_site",
          producer_type: "bryggeri", verified: true, last_content_attempt_at: null, created_at: "2026-01-01 00:00:00", full: true },
        // Thin, verified, never attempted -> NULL-first, selected first.
        { id: "dk-thin-a", navn: "Thin A Sideri", hjemmeside: "https://dk-thin-a.example.no", content_source: null,
          producer_type: "cideri", verified: true, last_content_attempt_at: null, created_at: "2026-03-01 00:00:00" },
        // Thin, verified, attempted long ago -> second.
        { id: "dk-thin-b", navn: "Thin B Vingård", hjemmeside: "https://dk-thin-b.example.no", content_source: null,
          producer_type: "vingård", verified: true, last_content_attempt_at: "2026-01-15 00:00:00", created_at: "2026-02-01 00:00:00" },
        // Thin, verified, attempted more recently -> third.
        { id: "dk-thin-c", navn: "Thin C Destilleri", hjemmeside: "https://dk-thin-c.example.no", content_source: null,
          producer_type: "destilleri", verified: true, last_content_attempt_at: "2026-06-01 00:00:00", created_at: "2026-02-02 00:00:00" },
        // Excluded: thin drink row whose website is NOT verified (fail-closed).
        { id: "dk-unverified", navn: "Uverifisert Bryggeri", hjemmeside: "https://dk-unverified.example.no", content_source: null,
          producer_type: "bryggeri", verified: false, last_content_attempt_at: null, created_at: "2026-01-02 00:00:00" },
        // Excluded: thin + verified but NOT a drink producer_type.
        { id: "dk-nondrink", navn: "Gårdsbutikk Uten Drikke", hjemmeside: "https://dk-nondrink.example.no", content_source: null,
          producer_type: "gardsbutikk", verified: true, last_content_attempt_at: null, created_at: "2026-01-03 00:00:00" },
        // Excluded: row-locked 'manual'.
        { id: "dk-manual", navn: "Manuelt Låst Bryggeri", hjemmeside: "https://dk-manual.example.no", content_source: "manual",
          producer_type: "bryggeri", verified: true, last_content_attempt_at: null, created_at: "2026-01-04 00:00:00" },
        // Excluded: parked (dead homepage within the 30-day window).
        { id: "dk-parked", navn: "Parkert Mjøderi", hjemmeside: "https://dk-parked.example.no", content_source: null,
          producer_type: "mjøderi", verified: true, last_content_attempt_at: null,
          homepage_unreachable_since: "2026-09-01 00:00:00", created_at: "2026-01-05 00:00:00" },
        // Excluded: no website at all.
        { id: "dk-nosite", navn: "Uten Hjemmeside Cideri", hjemmeside: null, content_source: null,
          producer_type: "cideri", verified: true, last_content_attempt_at: null, created_at: "2026-01-06 00:00:00" },
      ];
      for (const f of fixtures) {
        insert.run({
          id: f.id, navn: f.navn, hjemmeside: f.hjemmeside, content_source: f.content_source,
          ...(f.full ? FULL : THIN),
          field_provenance: provenance(f.verified), producer_type: f.producer_type,
          last_content_attempt_at: f.last_content_attempt_at,
          homepage_unreachable_since: f.homepage_unreachable_since ?? null,
          created_at: f.created_at,
        });
      }

      // ── Fetch + judge mock ───────────────────────────────────────────
      function htmlFor(host: string): string {
        const about = `${host} er et lite håndverksbryggeri på gården som brygger øl og sider av egne råvarer hele året.`;
        const visit = `Besøkende er velkomne til gårdsutsalget hos ${host} for smaking og kjøp, åpent i helgene.`;
        return `<html><head><meta property="og:description" content="${about}"></head><body><p>${visit}</p></body></html>`;
      }
      let fetchedHosts: string[] = [];
      const knownHosts = fixtures.filter((f) => f.hjemmeside).map((f) => new URL(f.hjemmeside as string).hostname);
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const u = new URL(urlStr);
        // Only the homepage itself (path "/") counts as a "provider fetched";
        // sub-page probes (om-oss, besok, ...) 404 like in the sibling tests.
        if (knownHosts.includes(u.hostname) && (u.pathname === "/" || u.pathname === "")) {
          fetchedHosts.push(u.hostname);
          const html = htmlFor(u.hostname);
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      const hostOf = (id: string) => `${id}.example.no`;
      const uniqueSorted = (xs: string[]) => Array.from(new Set(xs)).sort();

      // ═══════════════════════════════════════════════════════════════════
      // (1) dry-run, cohort=drink, generous limit: exactly the 3 thin+verified
      //     drink rows are selected; dk-full (head of table) is NOT.
      // ═══════════════════════════════════════════════════════════════════
      {
        fetchedHosts = [];
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 8, apply: false },
        });
        assertEq(r.status, 200, "dc1-1: dry-run cohort=drink -> 200");
        assertEq(r.body.selection, "drink_cohort", "dc1-2: selection reported as drink_cohort");
        assertEq(r.body.cohort_eligible_total, 3, "dc1-3: cohort_eligible_total counts the 3 thin+verified drink rows only");
        assertEq(
          uniqueSorted(fetchedHosts),
          [hostOf("dk-thin-a"), hostOf("dk-thin-b"), hostOf("dk-thin-c")],
          "dc1-4: exactly the thin+verified drink rows were fetched",
        );
        assertTrue(!fetchedHosts.includes(hostOf("dk-full")), "dc1-5: the fully-enriched head-of-table drink row was NOT fetched (the bug)");
        assertTrue(!fetchedHosts.includes(hostOf("dk-unverified")), "dc1-6: unverified drink row excluded (fail-closed)");
        assertTrue(!fetchedHosts.includes(hostOf("dk-nondrink")), "dc1-7: non-drink producer_type excluded");
        assertTrue(!fetchedHosts.includes(hostOf("dk-manual")), "dc1-8: manual-locked row excluded");
        assertTrue(!fetchedHosts.includes(hostOf("dk-parked")), "dc1-9: parked row excluded");
        assertEq(r.body.excluded_unverified_website, [], "dc1-10: no row reached processOne's verification gate — the selection already applied it");
        assertEq(r.body.dry_run, true, "dc1-11: dry_run:true echoed");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (2) limit slices the batch but NOT cohort_eligible_total; the
      //     NULL-attempt row comes first, then the oldest attempt.
      // ═══════════════════════════════════════════════════════════════════
      {
        fetchedHosts = [];
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 1, apply: false },
        });
        assertEq(r.status, 200, "dc2-1: limit 1 -> 200");
        assertEq(r.body.cohort_eligible_total, 3, "dc2-2: cohort_eligible_total is the queue depth, unaffected by limit");
        assertEq(uniqueSorted(fetchedHosts), [hostOf("dk-thin-a")], "dc2-3: limit 1 picks the never-attempted row first (NULL last_content_attempt_at)");

        fetchedHosts = [];
        const r2 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 2, apply: false },
        });
        assertEq(r2.status, 200, "dc2-4: limit 2 -> 200");
        assertEq(uniqueSorted(fetchedHosts), [hostOf("dk-thin-a"), hostOf("dk-thin-b")], "dc2-5: limit 2 = NULL-first row + the OLDEST-attempted row (not the most recent)");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (3) apply with limit 1 stamps dk-thin-a; the NEXT call must move on
      //     to dk-thin-b instead of re-trying dk-thin-a — the cadence that
      //     the old head -8 pattern could never produce.
      // ═══════════════════════════════════════════════════════════════════
      {
        fetchedHosts = [];
        const applyR = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 1, apply: true },
        });
        assertEq(applyR.status, 200, "dc3-1: apply limit 1 -> 200");
        assertEq(applyR.body.selection, "drink_cohort", "dc3-2: selection drink_cohort in apply mode too");
        assertEq(uniqueSorted(fetchedHosts), [hostOf("dk-thin-a")], "dc3-3: apply processed dk-thin-a");
        assertEq(applyR.body.agents_enriched, 1, "dc3-4: dk-thin-a actually got enriched (about/visit filled from the mocked homepage)");
        const rowA = expDb.prepare(
          "SELECT about_text, visit_text, last_content_attempt_at FROM experience_providers WHERE id = ?",
        ).get("dk-thin-a") as any;
        assertTrue(!!rowA.about_text && !!rowA.visit_text, "dc3-5: about_text + visit_text written on dk-thin-a");
        assertTrue(!!rowA.last_content_attempt_at, "dc3-6: dk-thin-a is attempt-stamped");

        fetchedHosts = [];
        const next = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 1, apply: false },
        });
        assertEq(next.status, 200, "dc3-7: next call -> 200");
        assertEq(uniqueSorted(fetchedHosts), [hostOf("dk-thin-b")], "dc3-8: next call moves on to dk-thin-b — the just-stamped row cycled to the back");
        // dk-thin-a is still thin (opening_hours/products blank) so it stays
        // in the queue — at the back, not dropped.
        assertEq(next.body.cohort_eligible_total, 3, "dc3-9: dk-thin-a remains eligible (still thin on opening_hours/products), queue depth still 3");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (4) selection reporting for the other two modes.
      // ═══════════════════════════════════════════════════════════════════
      {
        // providerIds wins over cohort — and keeps its override semantics
        // (dk-full is NOT thin, yet an explicit id still gets processed).
        fetchedHosts = [];
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", providerIds: ["dk-full"], apply: false },
        });
        assertEq(r.status, 200, "dc4-1: providerIds + cohort -> 200");
        assertEq(r.body.selection, "provider_ids", "dc4-2: providerIds wins over cohort (explicit beats implicit)");
        assertEq(r.body.cohort_eligible_total, null, "dc4-3: cohort_eligible_total is null outside drink_cohort mode");
        assertEq(uniqueSorted(fetchedHosts), [hostOf("dk-full")], "dc4-4: explicit override still processes a non-thin row (unchanged override semantics)");

        // cohort omitted -> auto.
        const auto = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { limit: 1, apply: false },
        });
        assertEq(auto.status, 200, "dc4-5: cohort omitted -> 200");
        assertEq(auto.body.selection, "auto", "dc4-6: cohort omitted -> selection auto");
        assertEq(auto.body.cohort_eligible_total, null, "dc4-7: auto -> cohort_eligible_total null");

        // cohort: null -> treated as omitted.
        const nul = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: null, limit: 1, apply: false },
        });
        assertEq(nul.status, 200, "dc4-8: cohort null -> 200");
        assertEq(nul.body.selection, "auto", "dc4-9: cohort null -> selection auto");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (5) unknown cohort value -> 400, no fetch, no fallback to auto.
      // ═══════════════════════════════════════════════════════════════════
      {
        fetchedHosts = [];
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "beer", limit: 8, apply: true },
        });
        assertEq(r.status, 400, "dc5-1: cohort=beer -> 400");
        assertEq(r.body.error, "invalid_cohort", "dc5-2: error code invalid_cohort");
        assertEq(fetchedHosts, [], "dc5-3: nothing fetched — no silent fallback to the generic auto-select");
      }
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
