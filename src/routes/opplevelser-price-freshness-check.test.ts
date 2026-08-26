/**
 * opplevelser-price-freshness-check.test.ts — tests for dev-request
 * 2026-08-25-experiences-pris-ferskhet.
 *
 * PROBLEM this closes: `experiences.price_from` is written once at harvest
 * insertion (LLM-composed) or by the content-refresh writer's fill-if-blank
 * extractPriceFrom regex, and is NEVER re-checked afterwards — the
 * 2026-08-25 mismatch investigation found 2/17 mismatch rows were simply
 * stale prices (130 vs 180 kr; 200 vs 195 kr) with no mechanism that would
 * ever catch them.
 *
 * THE FIX:
 *   - `price_checked_at` / `price_check_attempts` (NEW, additive columns —
 *     init-experiences.ts).
 *   - selectExperiencesForPriceFreshnessCheck() / resolvePriceProvenanceUrl()
 *     / priceFreshnessExclusionSql() (experience-store.ts) — the selector.
 *   - POST /admin/price-freshness-check (routes/opplevelser.ts) — the sweep
 *     that re-fetches a row's price provenance page, re-runs the SAME
 *     extractPriceFrom() content-refresh uses, and corrects/nulls/leaves the
 *     price alone depending on what the page says today.
 *
 * Covers the four literal acceptance criteria plus the write-side/selector
 * mechanics the dev-request calls out explicitly:
 *   (a) AC1 — a seeded stale price + a provenance page showing a different
 *       CLEAR price -> corrected in apply mode; content_field_evidence.
 *       price_from is preferred over evidence_url when both are present and
 *       point at different hosts (the wrong-host mock throws if reached).
 *   (b) AC2 — a provenance page with NO price at all -> price_from becomes
 *       NULL in apply mode, never guessed.
 *   (c) dry-run mode -> zero DB writes (price_from AND price_checked_at both
 *       untouched), reports under wouldCorrect instead.
 *   (d) AC4 — a locked row (verification_status='verified' OR
 *       content_source IN ('manual','claim')) is skipped even when targeted
 *       explicitly via experienceIds, never fetched, never written.
 *   (e) AC3 + selector mechanics — NULLs-first-then-oldest ordering; a
 *       recently-checked row is excluded (re-run no-op); a stale
 *       (>freshness-window) row is eligible again; locked rows never appear;
 *       rows with no price or no resolvable provenance URL never appear.
 *   (f) the 3-strikes fetch-failure park: attempts 1-2 remain immediately
 *       eligible for reselection (no 30-day wait), attempt 3 parks the row
 *       (excluded until the freshness window expires), and a SUCCESSFUL
 *       check resets price_check_attempts to 0.
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
    query?: Record<string, string>;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const path = opts.url || "/admin/price-freshness-check";
    const url = path + qs;
    const req: any = {
      method,
      url,
      originalUrl: url,
      path,
      query,
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

function mkResp(ok: boolean, html: string, status?: number): Response {
  return {
    ok,
    status: status ?? (ok ? 200 : 404),
    statusText: ok ? "OK" : "Not Found",
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    headers: { get: () => null },
  } as unknown as Response;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runOpplevelserPriceFreshnessCheckTests(
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
    const testKey = process.env.ADMIN_KEY || "price-freshness-check-test-key";
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
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser") & { default: any };
      const opplevelserRouter = opplevelserModule.default;
      const {
        selectExperiencesForPriceFreshnessCheck,
        resolvePriceProvenanceUrl,
        PRICE_CHECK_PARK_AFTER_ATTEMPTS,
      } = store;

      const providerId = store.createProvider({
        navn: "Pris Gard AS", org_nr: "900700700",
        fylke: "Troms", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      function seed(title: string, opts: {
        price_from: number | null;
        verification_status?: string;
        content_source?: string;
      }): string {
        return store.createExperience({
          title, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high",
          verification_status: opts.verification_status ?? "pending_verify",
          content_source: opts.content_source,
          price_from: opts.price_from ?? undefined,
        } as any);
      }

      function getRow(id: string): any {
        return db.prepare("SELECT * FROM experiences WHERE id = ?").get(id);
      }

      // ══════════════════════════════════════════════════════════════════
      // (a) AC1 — stale price corrected against a provenance page with a
      // clear DIFFERENT price. content_field_evidence.price_from preferred
      // over evidence_url (different host — the wrong one must never be
      // fetched).
      // ══════════════════════════════════════════════════════════════════
      const expCorrect = seed("AC1 correction experience", { price_from: 130 });
      db.prepare(
        "UPDATE experiences SET evidence_url = ?, content_field_evidence = ? WHERE id = ?"
      ).run(
        "https://pf-wrong-evidence.example/proof",
        JSON.stringify({ price_from: "https://pf-right-provenance.example/proof" }),
        expCorrect,
      );

      const fetchCallsByHost: Record<string, number> = {};
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        fetchCallsByHost[host] = (fetchCallsByHost[host] || 0) + 1;
        if (host === "pf-right-provenance.example") {
          return mkResp(true, "<html><body><p>Ny pris: fra 180 kr per person.</p></body></html>");
        }
        if (host === "pf-noprice.example") {
          return mkResp(true, "<html><body><p>Ingen priser oppgitt for tiden.</p></body></html>");
        }
        if (host === "pf-dryrun.example") {
          return mkResp(true, "<html><body><p>Aktivitet fra 120 kr per person.</p></body></html>");
        }
        if (host === "pf-parktest.example") {
          return mkResp(false, "", 404);
        }
        throw new Error(`price-freshness test: fetch must NOT be called for host "${host}"`);
      }) as typeof fetch;

      const acorrRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { experienceIds: [expCorrect], apply: true },
      });
      assertEq(acorrRes.status, 200, "ac1-1: price-freshness-check call -> 200");
      assertEq(fetchCallsByHost["pf-wrong-evidence.example"], undefined, "ac1-2: evidence_url host NEVER fetched — content_field_evidence.price_from took precedence");
      assertEq(fetchCallsByHost["pf-right-provenance.example"], 1, "ac1-3: content_field_evidence.price_from host WAS fetched exactly once");
      const corrList = acorrRes.body.corrected as any[];
      assertTrue(corrList.some((c) => c.experience_id === expCorrect && c.before === 130 && c.after === 180), "ac1-4: response.corrected carries before:130/after:180");
      const acorrRow = getRow(expCorrect);
      assertEq(acorrRow.price_from, 180, "ac1-5: price_from UPDATED to 180 in apply mode");
      assertTrue(!!acorrRow.price_checked_at, "ac1-6: price_checked_at stamped");
      assertEq(acorrRow.price_check_attempts, 0, "ac1-7: price_check_attempts stays/resets to 0 on a successful correction");
      assertEq(acorrRow.evidence_url, "https://pf-wrong-evidence.example/proof", "ac1-8: evidence_url column itself untouched (sweep only reads provenance, never writes it)");
      assertEq(
        JSON.parse(acorrRow.content_field_evidence).price_from,
        "https://pf-right-provenance.example/proof",
        "ac1-9: content_field_evidence untouched by this sweep",
      );

      // ══════════════════════════════════════════════════════════════════
      // (b) AC2 — provenance page has no price at all -> price_from NULLed,
      // never guessed.
      // ══════════════════════════════════════════════════════════════════
      const expNull = seed("AC2 null experience", { price_from: 200 });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-noprice.example/proof", expNull,
      );
      const anullRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { experienceIds: [expNull], apply: true },
      });
      assertEq(anullRes.status, 200, "ac2-1: call -> 200");
      const nulledList = anullRes.body.nulled as any[];
      assertTrue(nulledList.some((n) => n.experience_id === expNull && n.before === 200), "ac2-2: response.nulled carries before:200");
      const anullRow = getRow(expNull);
      assertEq(anullRow.price_from, null, "ac2-3: price_from is NULL — never a guessed replacement value");
      assertTrue(!!anullRow.price_checked_at, "ac2-4: price_checked_at stamped");
      assertEq(anullRow.price_check_attempts, 0, "ac2-5: attempts reset to 0 — nulling is a SUCCESSFUL check, not a failure");

      // ══════════════════════════════════════════════════════════════════
      // (c) Dry-run mode -> zero DB writes.
      // ══════════════════════════════════════════════════════════════════
      const expDryRun = seed("Dry-run experience", { price_from: 90 });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-dryrun.example/proof", expDryRun,
      );
      const dryRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { experienceIds: [expDryRun] }, // apply omitted -> dry-run
      });
      assertEq(dryRes.status, 200, "dryrun-1: call -> 200");
      assertEq(dryRes.body.dry_run, true, "dryrun-2: response reports dry_run:true");
      const wouldCorrectList = dryRes.body.wouldCorrect as any[];
      assertTrue(wouldCorrectList.some((c) => c.experience_id === expDryRun && c.before === 90 && c.after === 120), "dryrun-3: response.wouldCorrect carries before:90/after:120");
      assertEq((dryRes.body.corrected as any[]).length, 0, "dryrun-4: response.corrected stays empty in dry-run");
      const dryRow = getRow(expDryRun);
      assertEq(dryRow.price_from, 90, "dryrun-5: price_from UNCHANGED — zero DB writes in dry-run");
      assertEq(dryRow.price_checked_at, null, "dryrun-6: price_checked_at UNCHANGED (still null) — zero DB writes in dry-run");
      assertEq(dryRow.price_check_attempts, 0, "dryrun-7: price_check_attempts UNCHANGED — zero DB writes in dry-run");

      // ══════════════════════════════════════════════════════════════════
      // (d) AC4 — locked rows (verified / manual / claim) are skipped even
      // when targeted explicitly, never fetched, never written.
      // ══════════════════════════════════════════════════════════════════
      const expLockedVerified = seed("Locked verified experience", { price_from: 300, verification_status: "verified" });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-locked-verified.example/proof", expLockedVerified,
      );
      const expLockedManual = seed("Locked manual experience", { price_from: 310, content_source: "manual" });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-locked-manual.example/proof", expLockedManual,
      );
      const lockedRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { experienceIds: [expLockedVerified, expLockedManual], apply: true },
      });
      assertEq(lockedRes.status, 200, "ac4-1: call -> 200");
      const skippedLockedIds = (lockedRes.body.skippedLocked as any[]).map((s) => s.experience_id);
      assertTrue(skippedLockedIds.includes(expLockedVerified), "ac4-2: verified row appears in skippedLocked");
      assertTrue(skippedLockedIds.includes(expLockedManual), "ac4-3: manual-sourced row appears in skippedLocked");
      assertEq(fetchCallsByHost["pf-locked-verified.example"], undefined, "ac4-4: verified row's provenance host NEVER fetched");
      assertEq(fetchCallsByHost["pf-locked-manual.example"], undefined, "ac4-5: manual row's provenance host NEVER fetched");
      assertEq(getRow(expLockedVerified).price_from, 300, "ac4-6: verified row's price_from untouched");
      assertEq(getRow(expLockedManual).price_from, 310, "ac4-7: manual row's price_from untouched");
      assertEq(getRow(expLockedVerified).price_checked_at, null, "ac4-8: verified row's price_checked_at untouched (never even attempted)");

      // ══════════════════════════════════════════════════════════════════
      // (e) Selector mechanics: NULLs-first-then-oldest ordering; freshness
      // no-op; locked/no-price/no-provenance rows never selected.
      // ══════════════════════════════════════════════════════════════════
      const expFresh = seed("Selector: fresh (excluded)", { price_from: 150 });
      db.prepare(
        "UPDATE experiences SET evidence_url = ?, price_checked_at = ? WHERE id = ?"
      ).run("https://pf-selector-fresh.example/proof", new Date().toISOString(), expFresh);

      const expStale = seed("Selector: stale (eligible)", { price_from: 160 });
      db.prepare(
        "UPDATE experiences SET evidence_url = ?, price_checked_at = ? WHERE id = ?"
      ).run("https://pf-selector-stale.example/proof", daysAgoIso(40), expStale);

      const expNeverChecked = seed("Selector: never checked (eligible, NULLs-first)", { price_from: 170 });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-selector-never.example/proof", expNeverChecked,
      );

      const expNoPrice = seed("Selector: no price (excluded)", { price_from: null });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-selector-noprice.example/proof", expNoPrice,
      );

      const expNoProvenance = seed("Selector: no provenance (excluded)", { price_from: 180 });
      // Deliberately leave evidence_url AND content_field_evidence both blank.

      const selectorResults = selectExperiencesForPriceFreshnessCheck(50);
      const selectorIds = selectorResults.map((t) => t.id);

      assertTrue(selectorIds.includes(expStale), "sel-1: stale (>freshness window) row IS selected — freshness expired");
      assertTrue(selectorIds.includes(expNeverChecked), "sel-2: never-checked row IS selected");
      assertTrue(!selectorIds.includes(expFresh), "sel-3: freshly-checked row is EXCLUDED — re-run within window is a no-op (AC3)");
      assertTrue(!selectorIds.includes(expNoPrice), "sel-4: row with no price_from is never a candidate");
      assertTrue(!selectorIds.includes(expNoProvenance), "sel-5: row with no resolvable provenance URL is never a candidate");
      assertTrue(!selectorIds.includes(expLockedVerified), "sel-6: verified row is never a candidate");
      assertTrue(!selectorIds.includes(expLockedManual), "sel-7: manual-sourced row is never a candidate");

      const neverIdx = selectorIds.indexOf(expNeverChecked);
      const staleIdx = selectorIds.indexOf(expStale);
      assertTrue(neverIdx >= 0 && staleIdx >= 0 && neverIdx < staleIdx, "sel-8: NULLs-first ordering — never-checked sorts before the merely-stale row");

      // resolvePriceProvenanceUrl unit coverage (pure).
      assertEq(
        resolvePriceProvenanceUrl({ content_field_evidence: null, evidence_url: "https://x.example/p" }),
        "https://x.example/p",
        "unit-1: no content_field_evidence -> falls back to evidence_url",
      );
      assertEq(
        resolvePriceProvenanceUrl({
          content_field_evidence: JSON.stringify({ price_from: "https://y.example/p" }),
          evidence_url: "https://x.example/p",
        }),
        "https://y.example/p",
        "unit-2: content_field_evidence.price_from preferred over evidence_url",
      );
      assertEq(
        resolvePriceProvenanceUrl({
          content_field_evidence: JSON.stringify({ price_from: "unknown:blank-source-url" }),
          evidence_url: "https://x.example/p",
        }),
        "https://x.example/p",
        "unit-3: a non-URL provenance sentinel falls through to evidence_url",
      );
      assertEq(
        resolvePriceProvenanceUrl({ content_field_evidence: null, evidence_url: null }),
        null,
        "unit-4: neither source -> null (unresolved, never fabricated)",
      );

      // ══════════════════════════════════════════════════════════════════
      // (f) 3-strikes fetch-failure park; resets on a successful check.
      // ══════════════════════════════════════════════════════════════════
      const expPark = seed("Park test experience", { price_from: 250 });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-parktest.example/proof", expPark,
      );
      assertEq(PRICE_CHECK_PARK_AFTER_ATTEMPTS, 3, "park-0: sanity — 3-strike threshold constant");

      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { experienceIds: [expPark], apply: true },
        });
        assertEq(r.status, 200, `park-${attempt}a: fetch-failure attempt ${attempt} call -> 200`);
        const row = getRow(expPark);
        assertEq(row.price_check_attempts, attempt, `park-${attempt}b: price_check_attempts == ${attempt} after ${attempt} consecutive fetch failures`);
        assertTrue(!!row.price_checked_at, `park-${attempt}c: price_checked_at stamped even on a fetch failure`);
        assertEq(row.price_from, 250, `park-${attempt}d: price_from untouched by a fetch failure`);

        const eligible = selectExperiencesForPriceFreshnessCheck(50).some((t) => t.id === expPark);
        if (attempt < 3) {
          assertTrue(eligible, `park-${attempt}e: attempts=${attempt} (<3) -> still eligible for immediate reselection, NOT parked yet`);
        } else {
          assertTrue(!eligible, `park-${attempt}e: attempts=3 -> PARKED, excluded from the selector until the freshness window expires`);
        }
      }

      // Backdate price_checked_at past the freshness window -> the 3-strike
      // park itself expires (same convention as the provider-level pattern).
      db.prepare("UPDATE experiences SET price_checked_at = ? WHERE id = ?").run(daysAgoIso(40), expPark);
      assertTrue(
        selectExperiencesForPriceFreshnessCheck(50).some((t) => t.id === expPark),
        "park-4: after the freshness window passes, the parked row is eligible again",
      );

      // A SUCCESSFUL check (page now shows the SAME price) resets attempts
      // to 0 — "reset on a successful check".
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "pf-parktest.example") return mkResp(true, "<html><body><p>Aktivitet fra 250 kr per person.</p></body></html>");
        throw new Error(`price-freshness test (reset phase): fetch must NOT be called for host "${host}"`);
      }) as typeof fetch;
      const resetRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { experienceIds: [expPark], apply: true },
      });
      assertEq(resetRes.status, 200, "park-5a: successful re-check call -> 200");
      const resetRow = getRow(expPark);
      assertEq(resetRow.price_check_attempts, 0, "park-5b: a SUCCESSFUL check resets price_check_attempts to 0");
      assertEq(resetRow.price_from, 250, "park-5c: unchanged outcome — price stays 250");

      // ══════════════════════════════════════════════════════════════════
      // (g) Transient fetch failures (e.g. HTTP 503) must NEVER count a
      // strike — mirrors the persistence-aware provider-level 3-strikes
      // convention (fetch-page.ts persistenceOf()). Unlike a permanent
      // failure, a transient one leaves BOTH price_check_attempts AND
      // price_checked_at untouched (see the route's doc comment on that
      // `else` branch: price_checked_at doubles as the freshness-window
      // clock here, so stamping it on a strike-exempt failure would still
      // silently rest the row for the 30-day window via
      // priceFreshnessExclusionSql's case (c) requiring attempts>0 — an
      // indistinguishable-from-parked outcome even with attempts at 0).
      // price_check_attempts stays at 0 after 3 consecutive transient
      // failures, and the row remains eligible for reselection (not
      // parked). Fix-up for the reviewer's CHANGES-REQUESTED finding on the
      // price-freshness route.
      // ══════════════════════════════════════════════════════════════════
      const expTransient = seed("Transient-failure experience", { price_from: 275 });
      db.prepare("UPDATE experiences SET evidence_url = ? WHERE id = ?").run(
        "https://pf-transienttest.example/proof", expTransient,
      );
      globalThis.fetch = (async (url: string | URL | Request) => {
        const host = new URL(String(url)).hostname;
        if (host === "pf-transienttest.example") return mkResp(false, "", 503);
        throw new Error(`price-freshness test (transient phase): fetch must NOT be called for host "${host}"`);
      }) as typeof fetch;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { experienceIds: [expTransient], apply: true },
        });
        assertEq(r.status, 200, `transient-${attempt}a: fetch-failure attempt ${attempt} call -> 200`);
        const errList = r.body.errors as any[];
        assertTrue(
          errList.some((e) => e.experience_id === expTransient && e.persistence === "transient"),
          `transient-${attempt}b: response.errors reports this failure with persistence:"transient"`,
        );
        const row = getRow(expTransient);
        assertEq(row.price_check_attempts, 0, `transient-${attempt}c: price_check_attempts stays 0 after ${attempt} consecutive TRANSIENT failures`);
        assertEq(row.price_checked_at, null, `transient-${attempt}d: price_checked_at stays NULL — a strike-exempt failure must not start the 30-day freshness clock either`);
        assertEq(row.price_from, 275, `transient-${attempt}e: price_from untouched by a fetch failure`);
        assertTrue(
          selectExperiencesForPriceFreshnessCheck(50).some((t) => t.id === expTransient),
          `transient-${attempt}f: still eligible for immediate reselection after ${attempt} consecutive transient failures — NOT parked`,
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-price-freshness-check: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-price-freshness-check.test.ts`
if (require.main === module) {
  runOpplevelserPriceFreshnessCheckTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
