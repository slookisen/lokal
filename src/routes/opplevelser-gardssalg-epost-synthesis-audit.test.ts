/**
 * opplevelser-gardssalg-epost-synthesis-audit.test.ts — route-level tests for
 * dev-request 2026-08-06-aldri-gjett-epostadresse (slookisen/A2A), criterion 6:
 *
 *   - GET  /admin/gardssalg-epost-synthesis-audit        (read-only diagnosis)
 *   - POST /admin/gardssalg-epost-synthesis-remediation  (dry-run-by-default write)
 *
 * Daniel's ruling: never CONSTRUCT/guess a producer's email — only ever use
 * addresses actually found. These routes verify that ruling against LIVE
 * data instead of assuming it: they scan experience_providers.epost and
 * RFB's agents.contact_email for the exact post@<own-domain> shape, then
 * classify every match by whether the row carries any trace of a legitimate
 * source (content_source / field_provenance for experience_providers,
 * claimed_at for agents) before ever considering removal.
 *
 * Setup: two separate in-memory DBs, mirroring gardssalg-claim.test.ts's own
 * dual-DB precedent exactly —
 *   - experiences: EXPERIENCES_DB_PATH=":memory:" + fresh require of
 *     db-factory + opplevelser (the same require-cache-reset pattern every
 *     sibling opplevelser-gardssalg-*.test.ts file in this directory uses).
 *   - RFB (`agents`): a STANDALONE better-sqlite3(":memory:") schema'd via
 *     src/database/init.ts's __initSchemaForTesting, wired in through this
 *     route's OWN __setGardssalgEpostSynthesisRfbDbForTesting() override —
 *     deliberately NOT src/database/init.ts's shared __setDbForTesting
 *     singleton (gardssalg-claim.test.ts's own header comment documents
 *     exactly why: that pin races any concurrently-running, unrelated suite
 *     in the full test.ts run).
 *
 * Handler driven directly through router.handle() with a fake req/res — no
 * HTTP server, no supertest, no network.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on both routes
 *   (b) THE hunsfos-bryggeri.no CASE (experience_providers): pattern match +
 *       content_source='manual' -> has_content_source_evidence, NEVER a
 *       removal candidate, survives apply=true byte-for-byte untouched. This
 *       is the single most important assertion in this file.
 *   (c) a genuine no_evidence_found case (experience_providers): pattern
 *       match, content_source NULL, field_provenance NULL/empty -> flagged,
 *       and actually nulled out by apply=true (with a field_provenance audit
 *       trail entry + an experience_provider_field_write_audit row)
 *   (d) a has_provenance_evidence case (experience_providers): pattern
 *       match, content_source NULL, but field_provenance is a non-empty
 *       object -> preserved, never a removal candidate
 *   (e) a different-domain case (experience_providers): epost's domain
 *       does NOT match hjemmeside's domain -> not a pattern match at all,
 *       absent from every bucket
 *   (f) dry_run (default AND explicit true) performs ZERO writes — asserted
 *       via a direct DB re-read after the call, on both tables
 *   (g)-(i) the SAME three cases (protected / no_evidence / domain-mismatch)
 *       mirrored on the agents/RFB side (contact_email/url), using
 *       claimed_at as that side's protective-evidence analog
 *   (j) idempotency: running apply=true twice in a row does not error and
 *       does not double-write/double-audit (the second pass's fresh re-scan
 *       naturally finds nothing left to remove, since a removed epost/
 *       contact_email is no longer a pattern match at all)
 *   (k) response-shape truncation: no_evidence_rows caps at 200 with a
 *       truncated:true flag, while buckets.no_evidence_found still reports
 *       the TRUE (uncapped) count
 */

import Database from "better-sqlite3";

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
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-epost-synthesis-audit";
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

export function runOpplevelserGardssalgEpostSynthesisAuditTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-epost-synthesis-audit-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    for (const p of [dbFactoryPath, opplevelserPath]) delete require.cache[p];

    // Standalone RFB db — never installed as the shared singleton (see the
    // file-header comment for why). Handed to the route's own testing seam.
    const initMod = require("../database/init") as typeof import("../database/init");
    const rfbDb = new Database(":memory:");
    initMod.__initSchemaForTesting(rfbDb as any);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const opplevelser = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelser.default as any;
      opplevelser.__setGardssalgEpostSynthesisRfbDbForTesting(rfbDb as any);

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance,
           epost, claimed_at, enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, @hjemmeside, @content_source, @field_provenance,
           @epost, @claimed_at, 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      const insertAgent = rfbDb.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
        VALUES (@id, @name, 'test agent', 'test', @contact_email, @url, 'producer', @api_key, @claimed_at)
      `);

      function getProviderEpost(id: string): { epost: string | null; field_provenance: string | null } {
        return expDb
          .prepare(`SELECT epost, field_provenance FROM experience_providers WHERE id = ?`)
          .get(id) as any;
      }
      function getAgentContactEmail(id: string): { contact_email: string | null } {
        return rfbDb.prepare(`SELECT contact_email FROM agents WHERE id = ?`).get(id) as any;
      }
      function getAgentKnowledgeAuditCount(agentId: string, fieldName: string): number {
        return (
          rfbDb
            .prepare(`SELECT COUNT(*) AS c FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ?`)
            .get(agentId, fieldName) as { c: number }
        ).c;
      }

      // ── (b) THE hunsfos-bryggeri.no case — MUST be preserved ────────────
      insertProvider.run({
        id: "prov-hunsfos",
        navn: "Hunsfos Bryggeri",
        slug: "hunsfos-bryggeri",
        org_nr: "910000001",
        hjemmeside: "https://hunsfos-bryggeri.no",
        content_source: "manual",
        field_provenance: null,
        epost: "post@hunsfos-bryggeri.no",
        claimed_at: null,
      });

      // ── (c) genuine no_evidence_found case — the only removal candidate ──
      insertProvider.run({
        id: "prov-synthetic",
        navn: "Syntetisk Gård",
        slug: "syntetisk-gard",
        org_nr: "910000002",
        hjemmeside: "https://syntetiskgard.no",
        content_source: null,
        field_provenance: null,
        epost: "post@syntetiskgard.no",
        claimed_at: null,
      });

      // ── (d) has_provenance_evidence case — preserved, no content_source ──
      insertProvider.run({
        id: "prov-provenance",
        navn: "Proveniens Gård",
        slug: "proveniens-gard",
        org_nr: "910000003",
        hjemmeside: "https://proveniensgard.no",
        content_source: null,
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/x", fetched_at: "2026-07-01T00:00:00Z" } }),
        epost: "post@proveniensgard.no",
        claimed_at: null,
      });

      // ── (e) different-domain — not a pattern match at all ────────────────
      insertProvider.run({
        id: "prov-mismatch",
        navn: "Feil Domene Gård",
        slug: "feil-domene-gard",
        org_nr: "910000004",
        hjemmeside: "https://etannetsted.no",
        content_source: null,
        field_provenance: null,
        epost: "post@annendomene.no",
        claimed_at: null,
      });

      // ── (g) agents/RFB: claimed protective case ──────────────────────────
      insertAgent.run({
        id: "agent-vinbonden",
        name: "Vinbonden AS",
        contact_email: "post@vinbonden.no",
        url: "https://vinbonden.no",
        api_key: "key-vinbonden",
        claimed_at: "2026-01-01T00:00:00.000Z",
      });

      // ── (h) agents/RFB: genuine no_evidence_found case ───────────────────
      insertAgent.run({
        id: "agent-ubevist",
        name: "Ubevisst AS",
        contact_email: "post@ubevist.no",
        url: "https://ubevist.no",
        api_key: "key-ubevist",
        claimed_at: null,
      });

      // ── (i) agents/RFB: different-domain — not a pattern match ───────────
      insertAgent.run({
        id: "agent-mismatch",
        name: "Feil Domene AS",
        contact_email: "post@annendomene.no",
        url: "https://etannetsted.no",
        api_key: "key-mismatch",
        claimed_at: null,
      });

      // ── (a) 403 without X-Admin-Key ──────────────────────────────────────
      const noKeyGet = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-epost-synthesis-audit" });
      assertEq(noKeyGet.status, 403, "a1: GET .../gardssalg-epost-synthesis-audit without X-Admin-Key -> 403");
      const noKeyPost = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-epost-synthesis-remediation",
      });
      assertEq(noKeyPost.status, 403, "a2: POST .../gardssalg-epost-synthesis-remediation without X-Admin-Key -> 403");

      // ── GET audit ─────────────────────────────────────────────────────
      const auditRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-epost-synthesis-audit",
        headers: { "x-admin-key": testKey },
      });
      assertEq(auditRes.status, 200, "audit GET -> 200");

      assertEq(auditRes.body.pattern_matches.experience_providers, 3, "pattern_matches.experience_providers counts hunsfos+synthetic+provenance (mismatch excluded)");
      assertEq(auditRes.body.pattern_matches.agents, 2, "pattern_matches.agents counts vinbonden+ubevist (mismatch excluded)");

      assertEq(auditRes.body.buckets.has_content_source_evidence, 2, "buckets.has_content_source_evidence: hunsfos (content_source) + vinbonden (claimed_at)");
      assertEq(auditRes.body.buckets.has_provenance_evidence, 1, "buckets.has_provenance_evidence: prov-provenance only");
      assertEq(auditRes.body.buckets.no_evidence_found, 2, "buckets.no_evidence_found: prov-synthetic + agent-ubevist only");

      const noEvidenceIds = (auditRes.body.no_evidence_rows as any[]).map((r) => r.id).sort();
      assertEq(noEvidenceIds, ["agent-ubevist", "prov-synthetic"].sort(), "b1: no_evidence_rows lists EXACTLY the two genuinely-unevidenced rows");
      assertTrue(
        !(auditRes.body.no_evidence_rows as any[]).some((r) => r.id === "prov-hunsfos"),
        "b2 (hunsfos): the hunsfos-bryggeri.no row is NEVER in no_evidence_rows (acceptance criterion 6's central case)",
      );
      assertTrue(
        !(auditRes.body.no_evidence_rows as any[]).some((r) => r.id === "agent-vinbonden"),
        "g1: the claimed agents row is never in no_evidence_rows",
      );
      assertTrue(
        !(auditRes.body.no_evidence_rows as any[]).some((r) => r.id === "prov-mismatch" || r.id === "agent-mismatch"),
        "e1/i1: domain-mismatch rows never appear in no_evidence_rows (they were never a pattern match)",
      );

      // ── (f) dry-run POST — zero writes, on BOTH tables ──────────────────
      const dryRunRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-epost-synthesis-remediation",
        headers: { "x-admin-key": testKey },
        body: {},
      });
      assertEq(dryRunRes.status, 200, "dry-run POST -> 200");
      assertEq(dryRunRes.body.dry_run, true, "dry_run defaults true");
      assertEq(dryRunRes.body.removed, 0, "dry-run removed is always 0");
      assertEq(dryRunRes.body.would_remove, 2, "dry-run would_remove counts the 2 no_evidence_found rows");

      assertEq(getProviderEpost("prov-synthetic").epost, "post@syntetiskgard.no", "f1: dry-run left prov-synthetic.epost completely unchanged");
      assertEq(getProviderEpost("prov-hunsfos").epost, "post@hunsfos-bryggeri.no", "f2: dry-run left prov-hunsfos.epost completely unchanged");
      assertEq(getAgentContactEmail("agent-ubevist").contact_email, "post@ubevist.no", "f3: dry-run left agent-ubevist.contact_email completely unchanged");
      assertEq(getAgentContactEmail("agent-vinbonden").contact_email, "post@vinbonden.no", "f4: dry-run left agent-vinbonden.contact_email completely unchanged");

      // explicit apply:false is byte-identical to the default
      const explicitDryRunRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-epost-synthesis-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: false },
      });
      assertEq(explicitDryRunRes.body.dry_run, true, "f5: explicit apply:false -> dry_run true, same as default");

      // ── apply=true — the real write ──────────────────────────────────────
      const applyRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-epost-synthesis-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true },
      });
      assertEq(applyRes.status, 200, "apply POST -> 200");
      assertEq(applyRes.body.dry_run, false, "apply -> dry_run false");
      assertEq(applyRes.body.removed, 2, "apply removed exactly the 2 no_evidence_found rows");

      // (c) prov-synthetic actually nulled, with an audit trail
      const afterSynthetic = getProviderEpost("prov-synthetic");
      assertEq(afterSynthetic.epost, null, "c1: prov-synthetic.epost is NULL after apply");
      assertTrue(
        !!afterSynthetic.field_provenance && JSON.parse(afterSynthetic.field_provenance).epost_synthesis_removal?.removed_value === "post@syntetiskgard.no",
        "c2: field_provenance carries an epost_synthesis_removal audit entry with the removed value",
      );
      assertEq(
        (expDb
          .prepare(`SELECT COUNT(*) AS c FROM experience_provider_field_write_audit WHERE provider_id = ? AND field_name = 'epost'`)
          .get("prov-synthetic") as { c: number }).c,
        1,
        "c3: exactly one experience_provider_field_write_audit row for prov-synthetic/epost",
      );

      // (h) agent-ubevist actually cleared (contact_email NOT NULL -> ""), with an audit trail
      const afterUbevist = getAgentContactEmail("agent-ubevist");
      assertEq(afterUbevist.contact_email, "", "h1: agent-ubevist.contact_email is '' after apply (NOT NULL column convention)");
      assertEq(getAgentKnowledgeAuditCount("agent-ubevist", "contact_email"), 1, "h2: exactly one agent_knowledge_audit row for agent-ubevist/contact_email");

      // (b) hunsfos-bryggeri.no — MUST survive apply=true byte-for-byte
      assertEq(getProviderEpost("prov-hunsfos").epost, "post@hunsfos-bryggeri.no", "b3 (hunsfos): survives apply=true UNCHANGED — the central acceptance-criterion-6 assertion");

      // (g) claimed agent — MUST survive apply=true byte-for-byte
      assertEq(getAgentContactEmail("agent-vinbonden").contact_email, "post@vinbonden.no", "g2: claimed agent's contact_email survives apply=true UNCHANGED");

      // (d) provenance-evidence row — untouched, still a pattern match
      assertEq(getProviderEpost("prov-provenance").epost, "post@proveniensgard.no", "d1: has_provenance_evidence row survives apply=true UNCHANGED");

      // (e)/(i) domain-mismatch rows — untouched (never in scope)
      assertEq(getProviderEpost("prov-mismatch").epost, "post@annendomene.no", "e2: domain-mismatch provider row untouched by apply");
      assertEq(getAgentContactEmail("agent-mismatch").contact_email, "post@annendomene.no", "i2: domain-mismatch agent row untouched by apply");

      // ── (j) idempotency: a second apply=true does not error or double-log ─
      const applyAgainRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-epost-synthesis-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true },
      });
      assertEq(applyAgainRes.status, 200, "j1: second apply -> 200, no error");
      assertEq(applyAgainRes.body.removed, 0, "j2: second apply removes nothing (the rows are no longer a pattern match — already cleared)");
      assertEq(
        (expDb
          .prepare(`SELECT COUNT(*) AS c FROM experience_provider_field_write_audit WHERE provider_id = ? AND field_name = 'epost'`)
          .get("prov-synthetic") as { c: number }).c,
        1,
        "j3: still exactly ONE experience_provider_field_write_audit row for prov-synthetic (no double-log)",
      );
      assertEq(getAgentKnowledgeAuditCount("agent-ubevist", "contact_email"), 1, "j4: still exactly ONE agent_knowledge_audit row for agent-ubevist (no double-log)");

      // ── (k) response-shape truncation: cap at 200, buckets stay true count ─
      const bulkInsert = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance, epost)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, @hjemmeside, NULL, NULL, @epost)
      `);
      for (let i = 0; i < 205; i++) {
        const dom = `bulk${i}.no`;
        bulkInsert.run({
          id: `prov-bulk-${i}`,
          navn: `Bulk ${i}`,
          slug: `bulk-${i}`,
          org_nr: `9200${String(i).padStart(5, "0")}`,
          hjemmeside: `https://${dom}`,
          epost: `post@${dom}`,
        });
      }
      const bulkAuditRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-epost-synthesis-audit",
        headers: { "x-admin-key": testKey },
      });
      assertEq(bulkAuditRes.body.truncated, true, "k1: truncated:true once no_evidence_found exceeds 200");
      assertEq((bulkAuditRes.body.no_evidence_rows as any[]).length, 200, "k2: no_evidence_rows capped at exactly 200");
      // prov-synthetic/agent-ubevist were already cleared by the earlier
      // apply=true (epost is now NULL / contact_email is now "") — the scan's
      // own WHERE clause excludes them from consideration entirely, so only
      // the 205 freshly-inserted bulk rows remain in this bucket.
      assertEq(bulkAuditRes.body.buckets.no_evidence_found, 205, "k3: buckets.no_evidence_found reports the TRUE uncapped count (205), not the capped list length (200)");
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const opplevelser = require("./opplevelser") as typeof import("./opplevelser");
        opplevelser.__setGardssalgEpostSynthesisRfbDbForTesting(null);
      } catch {
        /* module already uncached — nothing to clear */
      }
    }

    return { passed, failed, failures };
  })();
}
