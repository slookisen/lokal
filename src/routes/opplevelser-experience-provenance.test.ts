/**
 * opplevelser-experience-provenance.test.ts — unit tests for the additive
 * `provenance` summary field on GET /api/opplevelser/:id
 * (src/routes/opplevelser.ts, backed by experience-store.ts's
 * getExperienceById()).
 *
 * dev-request 2026-07-13-proveniens-transparens-side, slice 2
 * (orch-pr-20260725-proveniens-api-provenance): opplevagent has no separate
 * public "provider detail" JSON endpoint (only GET /:id for an experience,
 * which already joins in the provider's phone — see providerPhoneOf() in
 * experience-store.ts). This mirrors that exact precedent with
 * providerProvenanceOf(): the returned experience additively carries
 * `provenance` sourced from its provider's experience_providers row.
 *
 * experience_providers.field_provenance uses a DIFFERENT on-disk shape than
 * rfb/dental's ({ field: {source_url, fetched_at} }, no source_type — see
 * init-experiences.ts), so `sources` here is derived from classifying each
 * field's source_url host (brreg.no -> "brreg", anything else ->
 * "provider_site") folded with the provider's own brreg_verified flag, and
 * `last_verified` is the provider's brreg_checked_at (the only existing
 * verification-style timestamp on experience_providers — see
 * setBrregVerification()).
 *
 * Setup mirrors opplevelser-gardssalg-provider-lookup.test.ts's convention:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, router.handle() exercised
 * directly against a real Express Router dispatch (so :id path-matching
 * runs for real).
 *
 * Covers (acceptance criteria 1, 2, 5 of the dev-request):
 *   (a) presence: an experience whose provider has field_provenance +
 *       brreg_checked_at gets `experience.provenance` with sources deduped
 *       by host classification, folded with brreg_verified.
 *   (b) absence: an experience whose provider has no field_provenance and
 *       is not brreg_verified never gets the key.
 *   (c) absence: an experience whose provider has field_provenance but no
 *       brreg_checked_at also omits the key (never fabricate a timestamp).
 *   (d) absence: an experience with no provider_id at all omits the key.
 *   (e) additive-regression: every other field of the response for an
 *       experience without provenance data is unchanged from a direct
 *       getExperienceById() read taken on an equivalent fixture without a
 *       provider (proves the provenance lookup never perturbs the existing
 *       experience shape).
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

function callRoute(router: any, path: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: path,
      originalUrl: path,
      path,
      params: {},
      query: {},
      headers: {},
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

export function runOpplevelserExperienceProvenanceTests(
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const experienceStorePath = require.resolve("../services/experience-store");
    const cachePaths = [dbFactoryPath, opplevelserPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── (a) provider with real field_provenance + brreg_checked_at ────────
      const providerWithProv = store.createProvider({
        navn: "Gårdsbutikk Med Proveniens",
        telefon: "12345678",
        brreg_verified: 1,
      } as any);
      expDb
        .prepare(
          `UPDATE experience_providers SET brreg_checked_at = @checked_at, field_provenance = @fp WHERE id = @id`,
        )
        .run({
          id: providerWithProv,
          checked_at: "2026-07-15T09:00:00.000Z",
          fp: JSON.stringify({
            about_text: { source_url: "https://gard.example.no/om-oss", fetched_at: "2026-07-01T00:00:00.000Z" },
            visit_text: { source_url: "https://gard.example.no/besok", fetched_at: "2026-07-02T00:00:00.000Z" }, // same host -> dedup
          }),
        });
      const expWithProv = store.createExperience({
        title: "Gårdsbesøk med proveniens",
        provider_id: providerWithProv,
        verification_status: "verified",
      } as any);

      // ── (b) provider with no field_provenance, not brreg_verified ─────────
      const providerNoProv = store.createProvider({
        navn: "Gårdsbutikk Uten Proveniens",
        telefon: "87654321",
        brreg_verified: 0,
      } as any);
      const expNoProv = store.createExperience({
        title: "Gårdsbesøk uten proveniens",
        provider_id: providerNoProv,
        verification_status: "verified",
      } as any);

      // ── (c) provider with field_provenance but no brreg_checked_at ────────
      const providerUnverified = store.createProvider({
        navn: "Gårdsbutikk Ikke Brreg-sjekket",
        brreg_verified: 0,
      } as any);
      expDb
        .prepare(`UPDATE experience_providers SET field_provenance = @fp WHERE id = @id`)
        .run({
          id: providerUnverified,
          fp: JSON.stringify({ about_text: { source_url: "https://ikke-sjekket.example.no", fetched_at: "2026-07-01T00:00:00.000Z" } }),
        });
      const expUnverified = store.createExperience({
        title: "Gårdsbesøk ikke brreg-sjekket",
        provider_id: providerUnverified,
        verification_status: "verified",
      } as any);

      // ── (d) experience with no provider_id at all ──────────────────────────
      const expNoProvider = store.createExperience({
        title: "Opplevelse uten produsent",
        verification_status: "verified",
      } as any);

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) presence + host-classification dedup + brreg_verified fold-in ──
      {
        const r = await callRoute(opplevelserRouter, `/${expWithProv}`);
        assertEq(r.status, 200, "a1: experience with provider provenance -> 200");
        assertTrue(!!r.body?.experience?.provenance, "a2: provenance key present when provider has field_provenance + brreg_checked_at");
        assertEq(r.body.experience.provenance.sources, ["provider_site", "brreg"], "a3: sources deduped by host classification, brreg_verified folded in");
        assertEq(r.body.experience.provenance.last_verified, "2026-07-15T09:00:00.000Z", "a4: last_verified matches provider.brreg_checked_at exactly");
      }

      // ── (b) absence: no field_provenance, not brreg_verified ────────────────
      {
        const r = await callRoute(opplevelserRouter, `/${expNoProv}`);
        assertEq(r.status, 200, "b1: experience with bare provider -> 200");
        assertTrue(!("provenance" in r.body.experience), "b2: provenance key genuinely absent when provider has nothing to summarize");
      }

      // ── (c) absence: no brreg_checked_at ─────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, `/${expUnverified}`);
        assertTrue(!("provenance" in r.body.experience), "c1: provenance key absent when provider has field_provenance but no brreg_checked_at");
      }

      // ── (d) absence: no provider_id at all ───────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, `/${expNoProvider}`);
        assertEq(r.status, 200, "d1: experience with no provider_id -> 200");
        assertTrue(!("provenance" in r.body.experience), "d2: provenance key absent when the experience has no provider_id at all");
      }

      // ── (e) additive-regression: other fields unchanged ─────────────────
      {
        const r = await callRoute(opplevelserRouter, `/${expNoProv}`);
        const { provenance, ...rest } = r.body.experience as Record<string, unknown>;
        const direct = store.getExperienceById(expNoProv) as Record<string, unknown>;
        assertTrue(!!direct, "e1: setup — getExperienceById returns a value for expNoProv");
        assertEq(rest, direct, "e2: additive regression — every non-provenance field of the route response matches a direct getExperienceById() read exactly");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experience-provenance: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
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

// Standalone runner: `npx tsx src/routes/opplevelser-experience-provenance.test.ts`
if (require.main === module) {
  runOpplevelserExperienceProvenanceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
