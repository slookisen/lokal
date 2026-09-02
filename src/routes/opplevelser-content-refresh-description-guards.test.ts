/**
 * opplevelser-content-refresh-description-guards.test.ts — tests for the
 * description faithfulness guards on POST /admin/content-refresh
 * (dev-request 2026-06-23-experiences-richer-profiles, faithfulness-inflow
 * slice, 2026-08-25).
 *
 * The measured failure this closes: summarizeAbout() extracts the provider
 * HOMEPAGE's og/meta description (a SITE-WIDE text), and the writer stored
 * it as per-experience descriptions — so experiences got site-wide marketing
 * boilerplate, scraped nav/contact junk, and even parked-domain sales text
 * as their description. Three write-path guards (full rationale: the block
 * comment above descriptionMentionsExperienceTitle in
 * src/routes/opplevelser.ts):
 *   1. parked-domain page → the whole fetch is treated as failed
 *      (fetch_failed:parked_domain, permanent, parking strike);
 *   2. junk description (isJunkDescription) → description write skipped;
 *   3. homepage-boilerplate: a homepage-derived description that never
 *      mentions a significant token of the experience's own title →
 *      skipped FOR THAT EXPERIENCE (an experience it does name still
 *      writes).
 * A skipped write leaves the field blank; skips are reported in
 * description_guard_skips (dry-run and apply alike).
 *
 * Setup mirrors opplevelser-content-refresh-charset.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh requires, router.handle() as the
 * HTTP entry point, globalThis.fetch mocked per host, providers stamped
 * hjemmeside-verified so the pre-existing verification gate stays out of
 * the way.
 *
 * Covers:
 *   (a) junk guard: a contact-block junk og:description (passes
 *       meetsAboutQualityBar, fails isJunkDescription) is NOT written;
 *       skip reported as junk_description.
 *   (b) homepage-boilerplate guard, per experience: the same site-wide
 *       og:description is written to the experience it names and skipped
 *       for the one it doesn't; skip reported with that experience's id.
 *   (c) dry-run honesty: the same skips are reported with zero writes.
 *   (d) parked-domain guard: a parked lander is a classified failed fetch
 *       (fetch_failed:parked_domain, permanent), nothing written, and a
 *       parking strike is counted in apply mode.
 *   (e) non-regression: category (keyword-extracted, not lifted prose) still
 *       writes for the boilerplate-guarded experience.
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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/content-refresh";
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

export function runOpplevelserContentRefreshDescriptionGuardsTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "description-guards-test-key";
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
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });

      function seedProvider(navn: string, orgSuffix: string, hjemmeside: string): string {
        const providerId = store.createProvider({
          navn,
          org_nr: `9200${orgSuffix.padStart(5, "0")}`,
          fylke: "Troms", kommune: "Tromsø",
          hjemmeside,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expDb.prepare("UPDATE experience_providers SET field_provenance = ? WHERE id = ?").run(VERIFIED_PROVENANCE, providerId);
        return providerId;
      }
      function seedExperience(providerId: string, title: string): string {
        return store.createExperience({
          title, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        });
      }
      const getDescription = (experienceId: string): string | null =>
        (expDb.prepare("SELECT description FROM experiences WHERE id = ?").get(experienceId) as { description: string | null } | undefined)
          ?.description ?? null;

      // ── fixtures ────────────────────────────────────────────────────────
      // (a) Contact-block junk: clears meetsAboutQualityBar (long, Norwegian,
      // no nav-marker) but trips isJunkDescription rule 3 (email + phone +
      // social clustered in the opening 150 chars).
      const JUNK_ABOUT =
        "Kontakt oss på post@gard.no eller ring 12345678. Følg oss på Facebook og Instagram for nyheter fra gården vår og fjøset.";
      const junkProviderId = seedProvider("Junk Gard AS", "1", "https://junk-gard.example");
      const junkExpId = seedExperience(junkProviderId, "Gårdsbesøk med omvisning");

      // (b) Site-wide homepage boilerplate: names "Svalbard" but not
      // "hvalsafari" — must write to the Svalbard-titled experience and skip
      // the hvalsafari one.
      const BOILER_ABOUT =
        "Velkommen til Svalbard - det ekte Arktis! Vi tilbyr uforglemmelige opplevelser i verdens vakreste villmark hele året.";
      const boilerProviderId = seedProvider("Boiler Ekspedisjoner AS", "2", "https://boiler-gard.example");
      const boilerSkippedExpId = seedExperience(boilerProviderId, "Hvalsafari med båt");
      const boilerWrittenExpId = seedExperience(boilerProviderId, "Svalbard villmarksafari");

      // (d) Parked lander: tiny page + registrar sales boilerplate.
      const parkedProviderId = seedProvider("Parked Gard AS", "3", "https://parked-gard.example");
      const parkedExpId = seedExperience(parkedProviderId, "Sirdal fjelltur");

      const junkHtml = `<html><head><meta property="og:description" content="${JUNK_ABOUT}"></head><body></body></html>`;
      // Body prose feeds the KEYWORD category mapper ("vandring" →
      // natur_friluft) — og:description still wins for summarizeAbout, so
      // the description candidate stays BOILER_ABOUT. This is what lets
      // dg-2g prove the guards are description-only.
      const boilerHtml =
        `<html><head><meta property="og:description" content="${BOILER_ABOUT}"></head>` +
        `<body><p>Vi tilbyr vandring og naturopplevelse i villmarka rundt Svalbard.</p></body></html>`;
      const parkedHtml = `<html><body><h1>parked-gard.example</h1><p>This domain is for sale! Buy this domain today. Domenet er til salgs.</p></body></html>`;

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = new URL(String(url));
        const page = (html: string): Response => {
          const bytes = new TextEncoder().encode(html);
          return {
            ok: true, status: 200,
            arrayBuffer: async () => bytes.buffer,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
          } as unknown as Response;
        };
        const notFound = (): Response =>
          ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response);
        if (u.pathname !== "/") return notFound(); // sub-page crawl probes
        if (u.hostname === "junk-gard.example") return page(junkHtml);
        if (u.hostname === "boiler-gard.example") return page(boilerHtml);
        if (u.hostname === "parked-gard.example") return page(parkedHtml);
        return notFound();
      }) as typeof fetch;

      // ── (c) dry-run FIRST: skips reported, zero writes ──────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [junkProviderId, boilerProviderId] },
        });
        assertEq(r.status, 200, "dg-1a: dry-run -> 200");
        assertEq(r.body.dry_run, true, "dg-1b: dry-run by default");
        const skips = r.body.description_guard_skips as any[];
        assertTrue(
          skips.some((s) => s.provider_id === junkProviderId && s.reason === "junk_description"),
          "dg-1c: dry-run names the junk-description skip",
        );
        assertTrue(
          skips.some((s) => s.provider_id === boilerProviderId && s.experience_id === boilerSkippedExpId && s.reason === "homepage_boilerplate_no_title_token"),
          "dg-1d: dry-run names the homepage-boilerplate skip with the affected experience's id",
        );
        assertEq(getDescription(junkExpId), null, "dg-1e: dry-run wrote nothing (junk provider)");
        assertEq(getDescription(boilerWrittenExpId), null, "dg-1f: dry-run wrote nothing (boilerplate provider)");
      }

      // ── (a)+(b)+(e) apply: junk skipped, boilerplate per-experience ─────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [junkProviderId, boilerProviderId], apply: true },
        });
        assertEq(r.status, 200, "dg-2a: apply -> 200");

        // (a) junk guard
        assertEq(getDescription(junkExpId), null, "dg-2b: contact-block junk was NOT written as a description — blank is honest");
        assertTrue(
          (r.body.description_guard_skips as any[]).some((s) => s.provider_id === junkProviderId && s.reason === "junk_description"),
          "dg-2c: junk skip reported in apply mode too",
        );

        // (b) homepage-boilerplate guard, decided PER EXPERIENCE
        assertEq(
          getDescription(boilerWrittenExpId),
          BOILER_ABOUT,
          "dg-2d: the experience the homepage text actually NAMES ('Svalbard …') still gets its description — today's behavior kept where the text is on-topic",
        );
        assertEq(
          getDescription(boilerSkippedExpId),
          null,
          "dg-2e: the experience the text never names ('Hvalsafari …') is SKIPPED — site-wide marketing is not a description of this experience",
        );
        assertTrue(
          (r.body.description_guard_skips as any[]).some((s) => s.experience_id === boilerSkippedExpId && s.reason === "homepage_boilerplate_no_title_token"),
          "dg-2f: the per-experience skip is reported with the experience id",
        );

        // (e) non-lifted fields untouched by the guards: the boilerplate page
        // maps to an experiences-vocab category via keyword extraction, and
        // that write must still land on BOTH experiences (guards are
        // description-only).
        const skippedRowCategory = (expDb.prepare("SELECT category FROM experiences WHERE id = ?").get(boilerSkippedExpId) as { category: string | null }).category;
        assertTrue(!!skippedRowCategory, "dg-2g: category still written for the description-skipped experience — the guard is description-only");
      }

      // ── (d) parked-domain guard ─────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: [parkedProviderId], apply: true },
        });
        assertEq(r.status, 200, "dg-3a: parked-provider apply -> 200");
        const err = (r.body.errors as any[]).find((e) => e.provider_id === parkedProviderId);
        assertTrue(!!err && String(err.error).startsWith("fetch_failed:parked_domain"), "dg-3b: parked lander reported as a classified failed fetch (fetch_failed:parked_domain)");
        assertEq(err?.persistence, "permanent", "dg-3c: parked is `permanent` — a parked domain is a dead homepage, not a blip");
        assertEq(getDescription(parkedExpId), null, "dg-3d: parking-lander text was NOT written as a description");
        const attempts = (expDb.prepare("SELECT homepage_fetch_attempts FROM experience_providers WHERE id = ?").get(parkedProviderId) as { homepage_fetch_attempts: number }).homepage_fetch_attempts;
        assertEq(attempts, 1, "dg-3e: apply mode counts a parking strike for the parked homepage (same as a permanent fetch failure)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-description-guards: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-description-guards.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshDescriptionGuardsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
