/**
 * experiences-provenance-read.test.ts — tests for
 * GET /api/opplevelser/admin/experiences/:id/provenance
 * (src/routes/opplevelser.ts), dev-request 2026-06-23-experiences-richer-
 * profiles, slice F2 (honest wrong_content_rate measurement).
 *
 * The 2026-08-25 WCR audit had no direct read surface for a single
 * experiences row's provenance columns and had to reverse-engineer them via
 * keyset-pagination tricks. This endpoint is that missing surface: raw row
 * (id/title/status/citation/provenance/admission/timestamps) + provider
 * identity in one admin-gated, read-only call — deliberately NOT
 * publish-gated (the rows an audit needs most are exactly the quarantined
 * ones the public surfaces hide).
 *
 * Same conventions as experiences-wrong-content-rate.test.ts: in-memory
 * experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires per run,
 * router.handle() as the HTTP entry point. No network anywhere (the route
 * is a single SELECT).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) 404 on an unknown id
 *   (c) 200 shape for a quarantined (needs_review) row WITH a provider:
 *       every documented field, parsed content_field_evidence map,
 *       published:false — proving the raw (ungated) lookup serves it
 *   (d) provider-less row -> provider: null; NULL content_field_evidence
 *       column -> null (distinguishable from a stamped-but-empty map)
 *   (e) a publish-gate-passing row reports published: true
 *   (f) malformed content_field_evidence JSON -> {} (never a throw/500)
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
  id: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = `/admin/experiences/${encodeURIComponent(id)}/provenance`;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
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

export function runExperiencesProvenanceReadTests(
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
    const testKey = process.env.ADMIN_KEY || "provenance-read-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./opplevelser"),
    ];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const oppl = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = oppl.default as any;
      const adminHeaders = { "x-admin-key": testKey };

      expDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, hjemmeside, brreg_active)
           VALUES (@id, @navn, @hjemmeside, @brreg_active)`,
        )
        .run({ id: "prov-pv-1", navn: "Sildehuset Museum AS", hjemmeside: "https://sildehuset.example.no", brreg_active: 1 });

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, description, category,
            evidence_url, content_field_evidence, content_source, enrichment_state,
            verification_status, confidence, canonical_id,
            admission_verdict, admission_checked_at, created_at, updated_at)
         VALUES
           (@id, @provider_id, @title, @slug, @description, @category,
            @evidence_url, @content_field_evidence, @content_source, @enrichment_state,
            @verification_status, @confidence, @canonical_id,
            @admission_verdict, @admission_checked_at, @created_at, @updated_at)`,
      );

      // (c) The audit's central case: a QUARANTINED row with full provenance.
      insertExperience.run({
        id: "exp-pv-quarantined",
        provider_id: "prov-pv-1",
        title: "Sildehuset omvisning",
        slug: "exp-pv-quarantined",
        description: "Kjenn røyken fra brislingovnene i det gamle sjøhuset.",
        category: "kultur_historie",
        evidence_url: "https://old-listing.example.no/find",
        content_field_evidence: JSON.stringify({ description: "https://sildehuset.example.no/om" }),
        content_source: "provider_site",
        enrichment_state: "enriched",
        verification_status: "needs_review",
        confidence: "medium",
        canonical_id: null,
        admission_verdict: "mismatch: beskrivelsen matcher ikke synlig sidetekst",
        admission_checked_at: "2026-08-25 06:00:00",
        created_at: "2026-08-01 10:00:00",
        updated_at: "2026-08-20 12:00:00",
      });

      // (d) Provider-less row, content_field_evidence column NULL.
      insertExperience.run({
        id: "exp-pv-bare",
        provider_id: null,
        title: "Fjelltur uten tilbyder",
        slug: "exp-pv-bare",
        description: "d",
        category: "natur_friluft",
        evidence_url: null,
        content_field_evidence: null,
        content_source: null,
        enrichment_state: "raw",
        verification_status: "pending_verify",
        confidence: null,
        canonical_id: null,
        admission_verdict: null,
        admission_checked_at: null,
        created_at: "2026-08-02 10:00:00",
        updated_at: "2026-08-02 10:00:00",
      });

      // (e) A publish-gate-passing row (verified, confidence high, canonical,
      // provider brreg_active=1 — the same predicate /discover serves).
      insertExperience.run({
        id: "exp-pv-published",
        provider_id: "prov-pv-1",
        title: "Publisert opplevelse",
        slug: "exp-pv-published",
        description: "d",
        category: "kultur_historie",
        evidence_url: "https://sildehuset.example.no/",
        content_field_evidence: null,
        content_source: "provider_site",
        enrichment_state: "enriched",
        verification_status: "verified",
        confidence: "high",
        canonical_id: null,
        admission_verdict: null,
        admission_checked_at: null,
        created_at: "2026-08-03 10:00:00",
        updated_at: "2026-08-03 10:00:00",
      });

      // (f) Malformed content_field_evidence JSON.
      insertExperience.run({
        id: "exp-pv-junk-evidence",
        provider_id: null,
        title: "Rar provenance",
        slug: "exp-pv-junk-evidence",
        description: "d",
        category: "c",
        evidence_url: null,
        content_field_evidence: "{not valid json",
        content_source: null,
        enrichment_state: "raw",
        verification_status: "pending_verify",
        confidence: null,
        canonical_id: null,
        admission_verdict: null,
        admission_checked_at: null,
        created_at: "2026-08-04 10:00:00",
        updated_at: "2026-08-04 10:00:00",
      });

      // ── (a) auth gate ────────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-quarantined", {});
        assertEq(r.status, 403, "pv-1: no X-Admin-Key -> 403");
      }
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-quarantined", { headers: { "x-admin-key": "wrong-key" } });
        assertEq(r.status, 403, "pv-2: wrong X-Admin-Key -> 403");
      }

      // ── (b) unknown id ───────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, "no-such-id", { headers: adminHeaders });
        assertEq(r.status, 404, "pv-3a: unknown id -> 404");
        assertEq(r.body.error, "experience_not_found", "pv-3b: 404 body carries the experience_not_found error code");
      }

      // ── (c) full shape, quarantined row WITH provider ────────────────────
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-quarantined", { headers: adminHeaders });
        assertEq(r.status, 200, "pv-4a: quarantined (needs_review) row -> 200 — the raw lookup is deliberately NOT publish-gated");
        assertEq(
          r.body.experience,
          {
            id: "exp-pv-quarantined",
            title: "Sildehuset omvisning",
            verification_status: "needs_review",
            confidence: "medium",
            canonical_id: null,
            published: false,
            evidence_url: "https://old-listing.example.no/find",
            content_field_evidence: { description: "https://sildehuset.example.no/om" },
            content_source: "provider_site",
            enrichment_state: "enriched",
            admission_verdict: "mismatch: beskrivelsen matcher ikke synlig sidetekst",
            admission_checked_at: "2026-08-25 06:00:00",
            created_at: "2026-08-01 10:00:00",
            updated_at: "2026-08-20 12:00:00",
          },
          "pv-4b: experience block carries every documented field, with content_field_evidence PARSED to its per-field map",
        );
        assertEq(
          r.body.provider,
          { id: "prov-pv-1", navn: "Sildehuset Museum AS", hjemmeside: "https://sildehuset.example.no", brreg_active: 1 },
          "pv-4c: provider block carries id/navn/hjemmeside/brreg_active",
        );
      }

      // ── (d) provider-less row / NULL evidence column ─────────────────────
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-bare", { headers: adminHeaders });
        assertEq(r.status, 200, "pv-5a: provider-less row -> 200");
        assertEq(r.body.provider, null, "pv-5b: provider is null when the row has no provider");
        assertEq(r.body.experience.content_field_evidence, null, "pv-5c: a NULL content_field_evidence column stays null (never-stamped, distinguishable from a stamped-but-empty map)");
        assertEq(r.body.experience.admission_verdict, null, "pv-5d: never-gated row's admission_verdict is null");
      }

      // ── (e) publish-gate-passing row ─────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-published", { headers: adminHeaders });
        assertEq(r.status, 200, "pv-6a: published row -> 200");
        assertEq(r.body.experience.published, true, "pv-6b: a row passing the SAME publish-gate predicate /discover uses reports published: true");
      }

      // ── (f) malformed content_field_evidence ─────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, "exp-pv-junk-evidence", { headers: adminHeaders });
        assertEq(r.status, 200, "pv-7a: malformed content_field_evidence JSON -> 200, never a 500");
        assertEq(r.body.experience.content_field_evidence, {}, "pv-7b: malformed JSON parses defensively to {} (same convention as the holdout resolver)");
      }

      // Read-only sanity: the endpoint made zero writes.
      {
        const count = (expDb.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n;
        assertEq(count, 4, "pv-8: the table still holds exactly the 4 seeded rows — read-only, no side effects");
        assertTrue(
          (expDb.prepare("SELECT updated_at FROM experiences WHERE id='exp-pv-quarantined'").get() as { updated_at: string }).updated_at === "2026-08-20 12:00:00",
          "pv-8b: updated_at untouched by the read",
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-provenance-read: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      for (const p of cachePaths) delete require.cache[p];
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-provenance-read.test.ts`
if (require.main === module) {
  runExperiencesProvenanceReadTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
