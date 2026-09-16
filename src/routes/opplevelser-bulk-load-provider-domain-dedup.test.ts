/**
 * opplevelser-bulk-load-provider-domain-dedup.test.ts — regression proof for
 * dev-request 2026-09-14-svarteliste-navnematch-bommer-pa-listenavn-
 * varianter.
 *
 * PRODUCTION INCIDENT: the bulk-load resolve-or-create logic
 * (POST /api/opplevelser/admin/bulk-load, src/routes/opplevelser.ts) only
 * ever matched an existing provider by org_nr or EXACT (case/trim-
 * insensitive) name. "Smakfulle Rom" (an already-onboarded provider) and
 * "Smakfulle Rom – Konferanse, Event & Catering" (the same producer's
 * listing name from a different harvest source, sharing the same website)
 * failed both lookups and were inserted as TWO `experience_providers` rows.
 *
 * FIX: a THIRD fallback, getProviderByDomain() (services/experience-store.ts),
 * tried only when org_nr AND name both miss — matches the candidate's
 * website against an existing provider's `hjemmeside` column via the
 * SAME eTLD+1 comparison used elsewhere in that file (hostFromUrlLike +
 * registrableDomain), plus collapseDomain() for hyphen-insensitivity
 * (PR-126). A hit runs through the EXACT SAME "found existing" branch as an
 * org_nr/name hit — no new provider row, experiences attach to the existing
 * provider — and is reported on the response as
 * `providers_matched_by_domain` / `providers_matched_by_domain_names`.
 *
 * Conventions mirror opplevelser-bulk-load-admission-gate.test.ts: in-memory
 * experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires per run,
 * router.handle() as the HTTP entry point (no real HTTP server/sockets),
 * Brreg stubbed via __setBrregFetchForTesting, and an in-memory RFB db
 * pinned for the route's agent_blocklist gate (isBlocked()) — same technique
 * as tests/test.ts's orch-pr-18 block. No evidence_url on any row in this
 * file, so the LLM admission gate never fires and globalThis.fetch needs no
 * stub.
 *
 * Covers:
 *   (a) domain-dedup: an existing provider ("Smakfulle Rom") + a bulk-load
 *       candidate under a DIFFERENT name but the SAME website domain (given
 *       as a hyphenated variant, to also prove collapseDomain's
 *       hyphen-insensitivity) resolves to the EXISTING provider — no second
 *       `experience_providers` row, the new experience attaches to the
 *       existing provider's id, and the response names the domain match.
 *   (b) non-goal regression guard: a candidate whose name is a
 *       prefix/substring of a DIFFERENT existing provider's name, but whose
 *       website domain does NOT match that provider, still creates a NEW
 *       provider row — this fix is domain-only, never fuzzy/substring name
 *       matching.
 *   (c) differing-org_nr guard (CHANGES-REQUESTED fix-up, PR #872 review):
 *       an existing provider that is ALREADY brreg_verified with a KNOWN
 *       org_nr, sharing a domain with a bulk-load candidate whose OWN Brreg
 *       resolution yields a DIFFERENT, non-null org_nr ("Underenhet A
 *       Kaffe AS" / '333333333' vs a candidate "Underenhet B Kaffe AS"
 *       resolving to '444444444' — a real franchise/shared-domain shape,
 *       not a hypothetical). Must NOT dedup by domain: the existing
 *       provider's org_nr must be UNCHANGED (proven via a direct DB read,
 *       not just the response body — this is exactly the field
 *       setBrregVerification's `COALESCE(@orgnr, org_nr)` would otherwise
 *       silently overwrite), and a NEW, separate provider row must be
 *       created for the candidate instead — two distinct legal entities
 *       sharing a domain must both exist as separate rows.
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
    const url = opts.url || "/admin/bulk-load";
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

export function runOpplevelserBulkLoadProviderDomainDedupTests(
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
    const testKey = process.env.ADMIN_KEY || "bulk-load-provider-domain-dedup-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: unknown = null;
    let expBrreg: typeof import("../services/experience-brreg") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // Pin an in-memory RFB db for the route's agent_blocklist gate (same
      // technique as tests/test.ts orch-pr-18 / opplevelser-bulk-load-
      // admission-gate.test.ts) — no entries added, just needs to exist so
      // isBlocked()'s query doesn't hit a foreign/missing schema.
      const initMod = require("../database/init") as typeof import("../database/init");
      const RfbDatabase = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new RfbDatabase(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      // Brreg stub: each candidate's own name resolves to a confident
      // verified_active match (own distinct org_nr) — this test is about the
      // PROVIDER-DEDUP fallback (org_nr/name miss -> domain match), so every
      // candidate clears Brreg on its own merits and is NEVER itself
      // recognized as one of the SEEDED existing providers (those keep
      // org_nr NULL, exactly as an `unverified`/never-Brreg-checked
      // real-world onboarded row would).
      expBrreg.__setBrregFetchForTesting(async (url: string) => {
        const navn = decodeURIComponent(new URL(url).searchParams.get("navn") || "");
        const lc = navn.toLowerCase();
        let orgNr: string | null = null;
        if (lc.includes("smakfulle rom")) orgNr = "911111111";
        else if (lc.includes("kaffebrenneriet")) orgNr = "922222222";
        else if (lc.includes("underenhet b kaffe")) orgNr = "444444444";
        if (!orgNr) return { ok: true, status: 200, json: async () => ({ _embedded: { enheter: [] } }) };
        const enheter = [{
          organisasjonsnummer: orgNr,
          navn: navn.toUpperCase(),
          naeringskode1: { kode: "93.291" },
          konkurs: false,
          underAvvikling: false,
          underTvangsavviklingEllerTvangsopplosning: false,
          slettedato: null,
        }];
        return { ok: true, status: 200, json: async () => ({ _embedded: { enheter } }) };
      });

      // ── Seed the two pre-existing providers this run's candidates must
      //    (and must NOT) dedup against. Neither carries an org_nr — same
      //    shape as a provider onboarded before Brreg-verification existed,
      //    which is exactly the case the production incident hit. ──────────
      const smakfulleRomId = expStore.createProvider({
        navn: "Smakfulle Rom",
        hjemmeside: "https://smakfullerom.no",
        source: "seed",
      });
      const kaffebrennerietId = expStore.createProvider({
        navn: "Kaffebrenneriet AS",
        hjemmeside: "https://kaffebrenneriet.no",
        source: "seed",
      });

      const providerCount = () =>
        (expDb.prepare("SELECT COUNT(*) AS n FROM experience_providers").get() as { n: number }).n;
      const providerByNavn = (navn: string) =>
        expDb.prepare("SELECT * FROM experience_providers WHERE navn = ?").get(navn) as
          | { id: string; org_nr: string | null; hjemmeside: string | null }
          | undefined;
      const experienceByTitle = (title: string) =>
        expDb.prepare("SELECT * FROM experiences WHERE title = ?").get(title) as
          | { id: string; provider_id: string }
          | undefined;

      const beforeCount = providerCount();

      // ── (a) domain-dedup: different name, same domain (hyphen variant —
      //    proves collapseDomain's hyphen-insensitivity engages), no org_nr
      //    overlap, no exact name match. Must resolve to the EXISTING
      //    "Smakfulle Rom" provider. ──────────────────────────────────────
      const rA = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          apply: true,
          experiences: [
            {
              title: "Julebord for bedrifter",
              provider_name: "Smakfulle Rom – Konferanse, Event & Catering",
              category: "mat_drikke",
              website: "https://smakfulle-rom.no",
            },
          ],
        },
      });
      assertEq(rA.status, 200, "dd-1a: apply -> 200");
      assertEq(rA.body.providers_inserted, 0, "dd-1b: NO new provider inserted — resolved to the existing one");
      assertEq(rA.body.providers_matched_by_domain, 1, "dd-1c: response reports exactly one domain-fallback match");
      assertEq(
        rA.body.providers_matched_by_domain_names,
        ["Smakfulle Rom – Konferanse, Event & Catering"],
        "dd-1d: response names the matched candidate",
      );
      assertEq(rA.body.experiences_inserted, 1, "dd-1e: the experience itself is still inserted");
      assertEq(
        providerCount(),
        beforeCount,
        "dd-1f: experience_providers row count UNCHANGED — no duplicate row for the domain-matched candidate",
      );
      assertTrue(
        !providerByNavn("Smakfulle Rom – Konferanse, Event & Catering"),
        "dd-1g: no provider row exists under the new candidate's own name",
      );
      const julebordExp = experienceByTitle("Julebord for bedrifter");
      assertTrue(!!julebordExp, "dd-1h: the new experience row exists");
      assertEq(
        julebordExp?.provider_id,
        smakfulleRomId,
        "dd-1i: the new experience is attached to the EXISTING (pre-seeded) provider id, not a fresh one",
      );

      // ── (b) regression guard: candidate name is a prefix/substring of a
      //    DIFFERENT existing provider's name ("Kaffebrenneriet" vs seeded
      //    "Kaffebrenneriet AS"), but a DIFFERENT website domain — must still
      //    create a NEW provider row. Proves this fix is domain-only, not
      //    fuzzy/substring name matching. ──────────────────────────────────
      const beforeCountB = providerCount();
      const rB = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          apply: true,
          experiences: [
            {
              title: "Kaffekurs for nybegynnere",
              provider_name: "Kaffebrenneriet",
              category: "mat_drikke",
              website: "https://helt-annet-kaffeselskap.example",
            },
          ],
        },
      });
      assertEq(rB.status, 200, "dd-2a: apply -> 200");
      assertEq(rB.body.providers_inserted, 1, "dd-2b: a NEW provider IS inserted (name substring + different domain must not dedup)");
      assertEq(
        rB.body.providers_matched_by_domain ?? 0,
        0,
        "dd-2c: no domain match reported for this call — different domain, no fallback fired",
      );
      assertEq(
        providerCount(),
        beforeCountB + 1,
        "dd-2d: exactly one new experience_providers row created",
      );
      const newKaffeRow = providerByNavn("Kaffebrenneriet");
      assertTrue(!!newKaffeRow, "dd-2e: a provider row exists under the candidate's OWN (substring) name");
      assertTrue(
        !!newKaffeRow && newKaffeRow.id !== kaffebrennerietId,
        "dd-2f: it is a DIFFERENT row from the pre-existing 'Kaffebrenneriet AS' provider — no false-positive merge",
      );
      const existingKaffeStillAlone = providerByNavn("Kaffebrenneriet AS");
      assertTrue(
        !!existingKaffeStillAlone && existingKaffeStillAlone.id === kaffebrennerietId,
        "dd-2g: the pre-existing 'Kaffebrenneriet AS' row is untouched",
      );

      // ── (c) differing-org_nr guard: existing provider is ALREADY
      //    brreg_verified with a KNOWN org_nr, sharing a domain with a
      //    bulk-load candidate whose OWN Brreg resolution yields a
      //    DIFFERENT, non-null org_nr. Reproduces the reviewer's exact
      //    CHANGES-REQUESTED scenario for PR #872: without the guard,
      //    setBrregVerification's `org_nr = COALESCE(@orgnr, org_nr)` would
      //    silently overwrite the existing row's org_nr under the ORIGINAL
      //    provider's name — corrupting two genuinely distinct legal
      //    entities that merely share a domain (franchise / shared
      //    corporate-parking-page shape). ─────────────────────────────────
      const underenhetAId = expStore.createProvider({
        navn: "Underenhet A Kaffe AS",
        hjemmeside: "https://kaffefranchise.no/lokal-a",
        org_nr: "333333333",
        brreg_verified: 1,
        brreg_active: 1,
        source: "seed",
      });
      const beforeCountC = providerCount();
      const rC = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          apply: true,
          experiences: [
            {
              title: "Kaffekurs i franchiselokalet",
              provider_name: "Underenhet B Kaffe AS",
              category: "mat_drikke",
              website: "https://www.kaffefranchise.no/lokal-b",
            },
          ],
        },
      });
      assertEq(rC.status, 200, "dd-3a: apply -> 200");
      assertEq(
        rC.body.providers_inserted,
        1,
        "dd-3b: a NEW provider IS inserted — a shared domain must never win over two KNOWN, DIFFERENT org_nrs",
      );
      assertEq(
        rC.body.providers_matched_by_domain ?? 0,
        0,
        "dd-3c: no domain match reported — the differing-org_nr guard fired, so the domain fallback never matched",
      );
      assertEq(
        providerCount(),
        beforeCountC + 1,
        "dd-3d: exactly one new experience_providers row created — two distinct legal entities, two rows",
      );
      const underenhetARowAfter = expDb
        .prepare("SELECT * FROM experience_providers WHERE id = ?")
        .get(underenhetAId) as { org_nr: string | null; navn: string } | undefined;
      assertEq(
        underenhetARowAfter?.org_nr,
        "333333333",
        "dd-3e: REGRESSION — the EXISTING provider's org_nr is UNCHANGED after the bulk-load call (read straight from the DB, not the response body)",
      );
      const underenhetBRow = providerByNavn("Underenhet B Kaffe AS");
      assertTrue(!!underenhetBRow, "dd-3f: a NEW provider row exists under the candidate's own name");
      assertEq(
        underenhetBRow?.org_nr,
        "444444444",
        "dd-3g: the new row carries the candidate's OWN (different) org_nr",
      );
      assertTrue(
        !!underenhetBRow && underenhetBRow.id !== underenhetAId,
        "dd-3h: the new row is a DIFFERENT id from the existing 'Underenhet A Kaffe AS' provider",
      );
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-bulk-load-provider-domain-dedup: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      try {
        expBrreg?.__setBrregFetchForTesting(null);
      } catch { /* best-effort */ }
      try {
        if (prevRfbDb) {
          (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb as any);
        }
      } catch { /* best-effort */ }
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

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-provider-domain-dedup.test.ts`
if (require.main === module) {
  runOpplevelserBulkLoadProviderDomainDedupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
