/**
 * opplevelser-gardssalg-drink-no-yield-backoff.test.ts — unit tests for
 * dev-request 2026-09-08-drikke-no-yield-backoff, Del B: ports the
 * experiences vertical's content-refresh no-yield backoff (dev-request
 * 2026-07-20-experiences-no-yield-backoff, see
 * opplevelser-content-refresh-no-yield-backoff.test.ts) onto the gårdssalg/
 * drink content-refresh selectors and POST /admin/gardssalg-content-refresh.
 *
 * Del A (visit-text/opening-hours extraction, VISIT_KEYWORDS,
 * GARDSSALG_CONTENT_PATHS, LLM-generation code) is explicitly OUT of scope
 * for this slice and is not touched or exercised here beyond what the
 * existing route already does.
 *
 * B1 — POST /admin/gardssalg-content-refresh's processOne() now calls
 *   recordProviderContentYield(id, false) when a row reaches scanned++ but
 *   wouldWrite ends up empty, and recordProviderContentYield(id, true) when
 *   >=1 field is actually written — apply mode only, mirroring the generic
 *   experiences content-refresh route's own two call sites
 *   (opplevelser.ts ~2503/~2617).
 *
 * B2 — selectGardssalgProvidersForContentRefresh and
 *   selectDrinkProducersForContentRefresh both now apply
 *   gardssalgNoYieldBackoffExclusionSql() (3 consecutive no-yield strikes ->
 *   NO_YIELD_BACKOFF_DAYS rest, env GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true
 *   restores the old no-exclusion selection for these two functions only).
 *
 * B3 — the route's JSON response gets an additive `cohort_resting_total`
 *   field: a number (thin+verified drink rows currently resting under the
 *   backoff) only when cohort:"drink", else null. Invariant:
 *   cohort_eligible_total + cohort_resting_total === the full thin+verified
 *   drink-producer count.
 *
 * Part A below (storeA*) exercises the store functions directly — no router,
 * no fetch mock, mirrors opplevelser-content-refresh-no-yield-backoff.test.ts's
 * own conventions. Part B (routeB*) exercises the real HTTP route with an
 * in-memory DB + globalThis.fetch mock, mirroring
 * opplevelser-gardssalg-drink-cohort-content-refresh.test.ts's own harness
 * (including its "GODKJENN" judge-approval convention).
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runOpplevelserGardssalgDrinkNoYieldBackoffTests(
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
    const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;
    const prevGardssalgDisabled = process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-drink-no-yield-backoff-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.NO_YIELD_BACKOFF_DAYS; // exercise the default-14 path
    delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-drink-no-yield-backoff";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      let db = dbFactory.getDb("experiences");

      // ── raw-insert helper (mirrors the drink-cohort test's own convention:
      // gårdssalg-specific columns like producer_type/hjemmeside/content
      // fields aren't part of createProvider()'s generic Provider shape) ──
      // Held as a rebindable `let` — Part B below resets the db-factory
      // singleton to a FRESH, empty "experiences" DB (so Part A's own
      // producer_type='bryggeri'/'cideri' fixtures, e.g. dr-a/dr-e, cannot
      // leak into Part B's drink-cohort counts) and rebinds both `db` and
      // `insert` to the new handle via makeInsertStmt().
      function makeInsertStmt(dbHandle: typeof db) {
        return dbHandle.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
              field_provenance, producer_type, content_no_yield_streak, last_content_attempt_at,
              homepage_unreachable_since, created_at, enrichment_state, verification_status, source, confidence)
           VALUES
             (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products,
              @field_provenance, @producer_type, @content_no_yield_streak, @last_content_attempt_at,
              @homepage_unreachable_since, @created_at,
              'raw', 'pending_verify', 'test-fixture', 'medium')`,
        );
      }
      let insert = makeInsertStmt(db);

      function provenance(verified: boolean): string {
        return JSON.stringify({
          hjemmeside_verification: {
            verified,
            classification: verified ? "verified" : "unverified",
            checked_at: "2026-01-01T00:00:00.000Z",
          },
        });
      }

      type Fixture = {
        id: string; navn: string; hjemmeside: string | null; content_source: string | null;
        producer_type: string; verified: boolean;
        about_text?: string | null; visit_text?: string | null; opening_hours_text?: string | null;
        products?: string | null;
        content_no_yield_streak?: number; last_content_attempt_at?: string | null;
        created_at?: string;
      };

      function seed(f: Fixture): void {
        insert.run({
          id: f.id, navn: f.navn, hjemmeside: f.hjemmeside, content_source: f.content_source,
          about_text: f.about_text ?? null, visit_text: f.visit_text ?? null,
          opening_hours_text: f.opening_hours_text ?? null, products: f.products ?? null,
          field_provenance: provenance(f.verified), producer_type: f.producer_type,
          content_no_yield_streak: f.content_no_yield_streak ?? 0,
          last_content_attempt_at: f.last_content_attempt_at ?? null,
          homepage_unreachable_since: null,
          created_at: f.created_at ?? "2026-01-01 00:00:00",
        });
      }

      function streakOf(id: string): number {
        return (db.prepare("SELECT content_no_yield_streak FROM experience_providers WHERE id = ?").get(id) as any)
          .content_no_yield_streak;
      }

      // ═══════════════════════════════════════════════════════════════════
      // Part A — store-level: selectGardssalgProvidersForContentRefresh /
      // selectDrinkProducersForContentRefresh backoff exclusion (B2).
      // ═══════════════════════════════════════════════════════════════════

      // (A1) selectGardssalgProvidersForContentRefresh: streak=3 + recent
      // attempt -> excluded; backdated past 14 days -> reappears.
      seed({
        id: "sg-a", navn: "Gårdsbutikk A", hjemmeside: "https://sg-a.example.no", content_source: null,
        producer_type: "gardsbutikk", verified: true,
        opening_hours_text: null, // thin on this one field -> eligible
        about_text: "En lang og god om-tekst.", visit_text: "Besøkende er velkomne.", products: JSON.stringify(["X"]),
        content_no_yield_streak: 3, last_content_attempt_at: daysAgoIso(1),
      });
      const afterA1 = expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id);
      assertTrue(!afterA1.includes("sg-a"), "A1: streak=3 + recent attempt -> excluded from selectGardssalgProvidersForContentRefresh");

      db.prepare("UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?").run(daysAgoIso(15), "sg-a");
      const afterA2 = expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id);
      assertTrue(afterA2.includes("sg-a"), "A2: same row, attempt backdated past default 14-day backoff -> reappears");

      // (A3) recordProviderContentYield(id, false) x3 -> streak reaches 3;
      // then a yielded=true call resets it to 0.
      seed({
        id: "sg-c", navn: "Gårdsbutikk C", hjemmeside: "https://sg-c.example.no", content_source: null,
        producer_type: "gardsbutikk", verified: true, opening_hours_text: null,
      });
      for (let i = 0; i < 3; i++) expStore.recordProviderContentYield("sg-c", false);
      assertEq(streakOf("sg-c"), 3, "A3: content_no_yield_streak reaches 3 after 3 consecutive no-yield calls");
      db.prepare("UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?").run(daysAgoIso(1), "sg-c");
      assertTrue(
        !expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id).includes("sg-c"),
        "A4: after streak=3 + recent attempt, sg-c is excluded",
      );
      expStore.recordProviderContentYield("sg-c", true);
      assertEq(streakOf("sg-c"), 0, "A5: recordProviderContentYield(id, true) resets streak to 0");
      assertTrue(
        expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id).includes("sg-c"),
        "A6: after reset, sg-c is selectable again (streak 0 clears the exclusion even with a recent attempt)",
      );

      // (A7) GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true restores today's
      // selection (no exclusion) for the gårdssalg selector.
      process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED = "true";
      const afterA7 = expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id);
      assertTrue(afterA7.includes("sg-a"), "A7: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true -> sg-a (streak reset to 0 above, N/A) still selectable");
      delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;
      // Re-verify a genuinely-resting row is bypassed under the flag.
      db.prepare("UPDATE experience_providers SET content_no_yield_streak = 3, last_content_attempt_at = ? WHERE id = ?")
        .run(daysAgoIso(1), "sg-a");
      assertTrue(
        !expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id).includes("sg-a"),
        "A8: sanity — sg-a (streak=3, recent attempt) excluded again with the flag unset",
      );
      process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED = "true";
      assertTrue(
        expStore.selectGardssalgProvidersForContentRefresh(48).map((r) => r.id).includes("sg-a"),
        "A9: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true -> sg-a (streak=3, recent attempt) IS selectable (bypass confirmed)",
      );
      delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;

      // (A10-A13) selectDrinkProducersForContentRefresh: SAME 3-strikes
      // exclusion, default cap; opts.applyNoYieldBackoff:false bypasses it
      // per-call regardless of the flag; the flag itself wins over both.
      seed({
        id: "dr-a", navn: "Drikkeprodusent A", hjemmeside: "https://dr-a.example.no", content_source: null,
        producer_type: "bryggeri", verified: true, opening_hours_text: null,
        content_no_yield_streak: 3, last_content_attempt_at: daysAgoIso(1),
      });
      const drDefault = expStore.selectDrinkProducersForContentRefresh(["bryggeri"]).map((r) => r.id);
      assertTrue(!drDefault.includes("dr-a"), "A10: selectDrinkProducersForContentRefresh default call excludes streak=3+recent dr-a");

      const drNoBackoff = expStore.selectDrinkProducersForContentRefresh(["bryggeri"], 500, { applyNoYieldBackoff: false })
        .map((r) => r.id);
      assertTrue(drNoBackoff.includes("dr-a"), "A11: opts.applyNoYieldBackoff:false includes dr-a regardless of streak (used for cohort_resting_total's full-count call)");

      db.prepare("UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?").run(daysAgoIso(15), "dr-a");
      assertTrue(
        expStore.selectDrinkProducersForContentRefresh(["bryggeri"]).map((r) => r.id).includes("dr-a"),
        "A12: dr-a reappears once last_content_attempt_at is past the 14-day backoff (default call)",
      );

      db.prepare("UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?").run(daysAgoIso(1), "dr-a");
      process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED = "true";
      assertTrue(
        expStore.selectDrinkProducersForContentRefresh(["bryggeri"]).map((r) => r.id).includes("dr-a"),
        "A13: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true bypasses the exclusion for the default (applyNoYieldBackoff:true) call too",
      );
      delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;

      // (A14) default streak (0, existing/new rows) never excludes an
      // otherwise-eligible row — zero behavior change for the default cohort.
      seed({
        id: "dr-e", navn: "Drikkeprodusent E", hjemmeside: "https://dr-e.example.no", content_source: null,
        producer_type: "bryggeri", verified: true, opening_hours_text: null,
      });
      assertTrue(
        expStore.selectDrinkProducersForContentRefresh(["bryggeri"]).map((r) => r.id).includes("dr-e"),
        "A14: default streak=0 drink row is selectable (zero behavior change for the default cohort)",
      );

      // ═══════════════════════════════════════════════════════════════════
      // Part B — route-level: POST /admin/gardssalg-content-refresh (B1, B3).
      // Resets the db-factory "experiences" singleton to a FRESH, empty DB
      // first — Part A above deliberately seeded real producer_type=
      // 'bryggeri'/'cideri' rows (dr-a, dr-e) to exercise
      // selectDrinkProducersForContentRefresh directly, and those must not
      // leak into Part B's own drink-cohort counts (B3). Also pins the
      // shared database/init.ts singleton the router's requireAdmin/write-
      // pause-fence handlers read through, same as
      // opplevelser-gardssalg-drink-cohort-content-refresh.test.ts's own
      // harness.
      // ═══════════════════════════════════════════════════════════════════

      dbFactory.__resetDbFactoryForTesting();
      db = dbFactory.getDb("experiences");
      insert = makeInsertStmt(db);
      require("../services/experience-store"); // already required above; re-affirm cache identity
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── B1 fixtures ──────────────────────────────────────────────────
      // "no-yield" row: EVERY content field already filled with decent, long
      // (>=200 char, cheap-bar-passing) text, so no candidate/rewrite/
      // blank-fill path can ever trigger regardless of what the (minimal)
      // mocked homepage returns — deterministic "fetched fine, extracted
      // nothing new" outcome with ZERO Anthropic calls.
      // >= 200 chars is load-bearing: gardssalgRewriteEligible() only fires
      // below 200 chars (services/experience-store.ts), and this fixture
      // must stay OUTSIDE both the replace-thin path (candidate is always
      // null here, see MINIMAL_HTML below) and the rewrite path, so the row
      // is a deterministic zero-Anthropic-call no-yield outcome.
      const LONG_TEXT =
        "Dette er en lang og detaljert tekst om gården og produktene som selges her, med god " +
        "informasjon om historie, drift og hva besøkende kan forvente å finne når de kommer innom " +
        "butikken i sesongen, inkludert åpningstider, produktutvalg og litt om driften gjennom året.";
      seed({
        id: "b1-noyield", navn: "No Yield Gård", hjemmeside: "https://b1-noyield.example.no", content_source: null,
        producer_type: "gardsbutikk", verified: true,
        about_text: LONG_TEXT, visit_text: LONG_TEXT, opening_hours_text: "Åpent i helgene.",
        products: JSON.stringify(["Syltetøy"]),
        content_no_yield_streak: 0,
      });
      // "yields something" row: about_text/visit_text BLANK so the extractive
      // candidate (approved via the mocked "GODKJENN" judge below) writes
      // both fields — mirrors dk-thin-a in
      // opplevelser-gardssalg-drink-cohort-content-refresh.test.ts.
      seed({
        id: "b1-yield", navn: "Yield Gård", hjemmeside: "https://b1-yield.example.no", content_source: null,
        producer_type: "gardsbutikk", verified: true,
        about_text: null, visit_text: null, opening_hours_text: "Åpent i helgene.",
        products: JSON.stringify(["Syltetøy"]),
        content_no_yield_streak: 2,
      });

      // ── B3 (cohort_resting_total) fixtures — all drink producer_type ──
      seed({
        id: "b3-eligible", navn: "Beriket Bryggeri", hjemmeside: "https://b3-eligible.example.no", content_source: null,
        producer_type: "bryggeri", verified: true, opening_hours_text: null, content_no_yield_streak: 0,
      });
      seed({
        id: "b3-resting-1", navn: "Hvilende Bryggeri 1", hjemmeside: "https://b3-resting-1.example.no", content_source: null,
        producer_type: "bryggeri", verified: true, opening_hours_text: null,
        content_no_yield_streak: 3, last_content_attempt_at: daysAgoIso(1),
      });
      seed({
        id: "b3-resting-2", navn: "Hvilende Bryggeri 2", hjemmeside: "https://b3-resting-2.example.no", content_source: null,
        producer_type: "cideri", verified: true, opening_hours_text: null,
        content_no_yield_streak: 3, last_content_attempt_at: daysAgoIso(1),
      });
      // Never counted in either bucket (unverified) — sanity guard against
      // over-counting.
      seed({
        id: "b3-unverified", navn: "Uverifisert Bryggeri", hjemmeside: "https://b3-unverified.example.no", content_source: null,
        producer_type: "bryggeri", verified: false, opening_hours_text: null,
      });

      // ── Fetch + judge mock (mirrors the drink-cohort test's harness) ──
      function goodHtmlFor(host: string): string {
        const about = `${host} er et lite håndverksbryggeri på gården som brygger øl av egne råvarer hele året.`;
        const visit = `Besøkende er velkomne til gårdsutsalget hos ${host} for smaking og kjøp, åpent i helgene.`;
        return `<html><head><meta property="og:description" content="${about}"></head><body><p>${visit}</p></body></html>`;
      }
      const MINIMAL_HTML = `<html><head></head><body><p>Velkommen.</p></body></html>`;
      const minimalHosts = new Set(["b1-noyield.example.no", "b3-eligible.example.no"]);
      const anthropicCalls: string[] = [];
      const knownHosts = [
        "b1-noyield.example.no", "b1-yield.example.no",
        "b3-eligible.example.no", "b3-resting-1.example.no", "b3-resting-2.example.no", "b3-unverified.example.no",
      ];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCalls.push(urlStr);
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const u = new URL(urlStr);
        if (knownHosts.includes(u.hostname) && (u.pathname === "/" || u.pathname === "")) {
          const html = minimalHosts.has(u.hostname) ? MINIMAL_HTML : goodHtmlFor(u.hostname);
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ── B1a: dry-run against the no-yield row does NOT touch the streak ──
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["b1-noyield"], apply: false },
        });
        assertEq(r.status, 200, "B1a-1: dry-run -> 200");
        assertEq(streakOf("b1-noyield"), 0, "B1a-2: dry-run never calls recordProviderContentYield — streak unchanged");
      }

      // ── B1b: apply against the no-yield row -> streak increments to 1,
      //     zero Anthropic calls (every candidate was cheap-bar-rejected or
      //     current-non-blank before reaching any network call).
      {
        anthropicCalls.length = 0;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["b1-noyield"], apply: true },
        });
        assertEq(r.status, 200, "B1b-1: apply -> 200");
        assertEq(r.body.agents_enriched, 0, "B1b-2: nothing written (agents_enriched 0)");
        assertEq(streakOf("b1-noyield"), 1, "B1b-3: apply + wouldWrite empty -> recordProviderContentYield(id,false) -> streak 1");
        assertEq(anthropicCalls.length, 0, "B1b-4: zero Anthropic calls for this row (deterministic no-yield, no judge/generation reached)");
      }

      // ── B1c: a second apply call on the same still-thin row -> streak 2 ──
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["b1-noyield"], apply: true },
        });
        assertEq(r.status, 200, "B1c-1: second apply -> 200");
        assertEq(streakOf("b1-noyield"), 2, "B1c-2: streak accumulates across runs (2 after 2 consecutive no-yield applies)");
      }

      // ── B1d: dry-run against the yields-something row does NOT reset the
      //     pre-set streak=2, even though the preview shows a would-write ──
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["b1-yield"], apply: false },
        });
        assertEq(r.status, 200, "B1d-1: dry-run -> 200");
        assertTrue((r.body.changed || []).some((c: any) => c.provider_id === "b1-yield"), "B1d-2: dry-run preview shows b1-yield would be written");
        assertEq(streakOf("b1-yield"), 2, "B1d-3: dry-run never calls recordProviderContentYield — streak still 2 (not reset)");
      }

      // ── B1e: apply against the yields-something row -> fields actually
      //     written -> recordProviderContentYield(id,true) -> streak resets
      //     to 0 (mirrors the generic route's own reset behavior).
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["b1-yield"], apply: true },
        });
        assertEq(r.status, 200, "B1e-1: apply -> 200");
        assertEq(r.body.agents_enriched, 1, "B1e-2: b1-yield actually enriched");
        const row = db.prepare("SELECT about_text, visit_text FROM experience_providers WHERE id = ?").get("b1-yield") as any;
        assertTrue(!!row.about_text && !!row.visit_text, "B1e-3: about_text + visit_text written on b1-yield");
        assertEq(streakOf("b1-yield"), 0, "B1e-4: a real field write resets content_no_yield_streak to 0");
      }

      // ── B3a: cohort:"drink" dry-run — cohort_resting_total is a number,
      //     and the invariant cohort_eligible_total + cohort_resting_total
      //     equals the full thin+verified drink count (3: b3-eligible,
      //     b3-resting-1, b3-resting-2 — b3-unverified excluded from both).
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 8, apply: false },
        });
        assertEq(r.status, 200, "B3a-1: cohort=drink dry-run -> 200");
        assertEq(typeof r.body.cohort_resting_total, "number", "B3a-2: cohort_resting_total is a number in drink-cohort mode");
        assertEq(r.body.cohort_eligible_total, 1, "B3a-3: cohort_eligible_total counts only b3-eligible (the two resting rows are excluded by the backoff)");
        assertEq(r.body.cohort_resting_total, 2, "B3a-4: cohort_resting_total counts both resting rows (b3-resting-1, b3-resting-2)");
        assertEq(
          r.body.cohort_eligible_total + r.body.cohort_resting_total,
          3,
          "B3a-5: invariant — cohort_eligible_total + cohort_resting_total === full thin+verified drink count (unverified row excluded from both)",
        );
      }

      // ── B3b: a non-drink-cohort call (auto) returns cohort_resting_total:
      //     null, never a number/0.
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { limit: 1, apply: false },
        });
        assertEq(r.status, 200, "B3b-1: auto (cohort omitted) -> 200");
        assertEq(r.body.selection, "auto", "B3b-2: selection auto");
        assertEq(r.body.cohort_resting_total, null, "B3b-3: cohort_resting_total is null outside drink-cohort mode");
      }

      // ── B3c: providerIds + cohort="drink" -> providerIds wins (selection
      //     provider_ids), cohort_resting_total still null (matches
      //     cohort_eligible_total's own existing null-outside-drink-cohort
      //     contract).
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", providerIds: ["b3-eligible"], apply: false },
        });
        assertEq(r.status, 200, "B3c-1: providerIds + cohort -> 200");
        assertEq(r.body.selection, "provider_ids", "B3c-2: providerIds wins over cohort");
        assertEq(r.body.cohort_resting_total, null, "B3c-3: cohort_resting_total null when providerIds overrides cohort mode");
      }

      // ── B3d: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true bypasses the
      //     exclusion for BOTH of the route's internal calls (the eligible-
      //     count call and the full-count call), so cohort_resting_total
      //     drops to 0 and cohort_eligible_total rises to the full 3.
      {
        process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED = "true";
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { cohort: "drink", limit: 8, apply: false },
        });
        delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;
        assertEq(r.status, 200, "B3d-1: cohort=drink dry-run under the disable flag -> 200");
        assertEq(r.body.cohort_eligible_total, 3, "B3d-2: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true -> all 3 thin+verified drink rows eligible");
        assertEq(r.body.cohort_resting_total, 0, "B3d-3: GARDSSALG_NO_YIELD_BACKOFF_DISABLED=true -> nothing resting");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-drink-no-yield-backoff: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevGardssalgDisabled === undefined) delete process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED;
      else process.env.GARDSSALG_NO_YIELD_BACKOFF_DISABLED = prevGardssalgDisabled;
      if (prevNoYieldBackoffDays === undefined) delete process.env.NO_YIELD_BACKOFF_DAYS;
      else process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-drink-no-yield-backoff.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgDrinkNoYieldBackoffTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
