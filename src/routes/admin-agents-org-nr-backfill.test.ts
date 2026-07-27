/**
 * admin-agents-org-nr-backfill.test.ts — tests for the RFB `agents.org_nr`
 * backfill via local-JSON-first + Brreg name-search + corroboration
 * (dev-request 2026-07-26-rfb-outreach-tilsig-blokkerdiagnose-og-orgnr,
 * Steg 2). This is a direct port of the already-reviewed gårdssalg org_nr
 * backfill (POST /admin/gardssalg-orgnr-backfill, routes/opplevelser.ts,
 * dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach slice 5b —
 * see opplevelser-gardssalg-orgnr-backfill.test.ts) onto the `agents` table,
 * with ONE new capability: a vendored local-JSON candidate generator
 * (services/local-orgnr-candidates.ts) is tried BEFORE any Brreg network
 * call.
 *
 * Covers (src/routes/admin-agents.ts):
 *   - agentOrgNrPostalCorroborated / agentOrgNrAutoWriteEligible
 *   - applyAgentOrgNr (fill-only write + audit + field_provenance)
 *   - agentOrgNrWasRolledBack
 *   - POST /admin/agents/org-nr-backfill
 *   - GET  /admin/agents/org-nr-review-queue
 *   - POST /admin/agents/org-nr-review-approve
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on all three routes.
 *   (b) auto-select scoping: locked (claimed_at), already-has-org_nr,
 *       inactive, umbrella, dental-vertical, and non-producer rows are ALL
 *       excluded from the auto-selected batch; an eligible RFB producer row
 *       IS selected.
 *   (c) agentOrgNrPostalCorroborated: postal_code match, city match (no
 *       postal_code on target), no signal at all -> false, postal-region
 *       mismatch -> false, short-city substring collision -> false
 *       (regression case mirrored from the gårdssalg original).
 *   (d) agentOrgNrAutoWriteEligible: confidence 1.0 + corroboration -> true;
 *       confidence 0.95 -> NEVER auto-write even with matching postal;
 *       confidence 1.0 with no corroboration -> false.
 *   (e) applyAgentOrgNr: fill-only write + audit row + agent_knowledge
 *       field_provenance["org_nr"]; idempotent second call is a no-op;
 *       claimed (locked) agent -> nothing written; org_nr already held by
 *       another agent -> skipped cleanly, no throw.
 *   (f) agentOrgNrWasRolledBack: true only when the latest audit row for
 *       this agent carries the rollback marker.
 *   (g) route dry-run: auto-write-eligible candidate (via Brreg name-search,
 *       no local-JSON hit) appears in changed[]; ZERO writes performed.
 *   (h) route apply: the same candidate is actually written; agents_enriched
 *       matches changed.length.
 *   (i) route: locked agent -> skipped_locked, no Brreg call ever made for it.
 *   (j) route: already-has-org_nr agent via agentIds override -> unresolved
 *       reason already_filled, never reappears in changed[].
 *   (k) route: no_brreg_candidate -> unresolved + upserted into the review
 *       queue with null candidate fields.
 *   (l) route: ambiguous_exact_name_ties (two DISTINCT org numbers both
 *       scoring 1.0 in the same Brreg response) -> review queue, never
 *       auto-written.
 *   (m) route: stripped_name_requires_postal_match — a "Navn — Sted" agent
 *       name strips to a core name whose exact Brreg match does NOT
 *       corroborate on postal -> review queue, never auto-written.
 *   (n) route: previously_rolled_back — a prior audit row carrying the
 *       rollback marker vetoes an otherwise-perfect auto-write candidate.
 *   (o) route: brreg_not_active — confidence 1.0 + corroborated, but the
 *       liveness check (verifyOrgNumber) reports a dissolved/bankrupt entity
 *       -> review queue, NEVER written (the exact "successor entity" case
 *       Daniel's identitetskrav bans).
 *   (p) route: needs_human_review — a hit found but not corroborated to the
 *       auto-write bar (confidence 0.95) -> review queue, never written.
 *   (q) local-JSON-first: an agent whose name+postal matches a vendored
 *       local-JSON fixture is written WITHOUT any Brreg name-search network
 *       call (only the liveness check hits the network); a sibling agent
 *       with no local match still falls through to the Brreg crawl.
 *   (r) GET /org-nr-review-queue: lists upserted entries; a rerun upserts in
 *       place (no duplicate rows).
 *   (s) POST /org-nr-review-approve: dry-run preview; apply writes and
 *       clears the queue entry; a mismatched org_nr is rejected
 *       (mismatch_with_queued_candidate) and writes nothing; an item not in
 *       the queue is rejected (not_in_review_queue).
 *   (t) route: errors[] populated (write_failed: prefix) on a write failure,
 *       200 status (never a 500).
 *
 * All Brreg I/O is stubbed via a monkey-patched global.fetch (mirrors
 * admin-agents-brreg-catalog-sweep.test.ts exactly). The local-JSON
 * candidate file is swapped for a small deterministic in-memory fixture set
 * via __setLocalOrgnrCandidatesForTesting, so this suite never depends on
 * (or is broken by future edits to) the real ~4.4k-row vendored file.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-agents-org-nr-backfill.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminAgentsOrgNrBackfillTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type BrregFixture = { status: number; body?: Record<string, unknown> };

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function activeDetail(orgNr: string, name: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
  };
}

function dissolvedDetail(orgNr: string, name: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: "2022-01-15",
  };
}

function searchHit(orgNr: string, navn: string, postnummer: string | null, poststed: string | null) {
  return {
    organisasjonsnummer: orgNr,
    navn,
    forretningsadresse: {
      adresse: ["Testveien 1"],
      postnummer: postnummer ?? undefined,
      poststed: poststed ?? undefined,
    },
  };
}

export async function runAdminAgentsOrgNrBackfillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "agents-org-nr-backfill-test-key";

  // navn-search fixtures keyed by a substring of the encoded query string;
  // detail/liveness fixtures keyed by the bare 9-digit org number.
  const searchFixtures: Map<string, BrregFixture> = new Map();
  const detailFixtures: Map<string, BrregFixture> = new Map();
  let searchCallCount = 0;
  let detailCallCount = 0;

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("navn=")) {
        searchCallCount++;
        for (const [key, fx] of searchFixtures) {
          if (u.includes(key)) {
            return { status: fx.status, ok: fx.status >= 200 && fx.status < 300, json: async () => fx.body ?? {} } as unknown as Response;
          }
        }
        return { status: 200, ok: true, json: async () => ({ _embedded: { enheter: [] } }) } as unknown as Response;
      }
      const dm = /\/enheter\/(\d{9})$/.exec(u);
      if (dm) {
        detailCallCount++;
        const fx = detailFixtures.get(dm[1]);
        if (!fx) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
        return { status: fx.status, ok: fx.status >= 200 && fx.status < 300, json: async () => fx.body ?? {} } as unknown as Response;
      }
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    globalThis.fetch = stubFetch();

    // Fresh require of admin-agents.ts + its brreg-client/local-orgnr-
    // candidates dependency graph, mirroring the sibling brreg-* suites'
    // own cache-busting convention.
    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    try { delete require.cache[require.resolve("../routes/admin-knowledge")]; } catch { /* ignore */ }
    const brregClientPath = require.resolve("../services/brreg-client");
    delete require.cache[brregClientPath];
    const localCandidatesPath = require.resolve("../services/local-orgnr-candidates");
    delete require.cache[localCandidatesPath];

    const adminAgentsModule = require("../routes/admin-agents") as typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default;
    const {
      agentOrgNrPostalCorroborated,
      agentOrgNrAutoWriteEligible,
      applyAgentOrgNr,
      agentOrgNrWasRolledBack,
    } = adminAgentsModule;

    const localCandidates = require("../services/local-orgnr-candidates") as typeof import("../services/local-orgnr-candidates");
    // Deterministic fixture set — the suite must never depend on (or be
    // broken by future edits to) the real ~4.4k-row vendored file.
    localCandidates.__setLocalOrgnrCandidatesForTesting([
      { orgnr: "980000001", name: "Lokal Fixture Gård AS", postal_code: "1450", city: "Nesoddtangen", source: "lokalmat" },
      { orgnr: "980000002", name: "Debio Fixture Meieri AS", postal_code: "2000", city: "Lillestrøm", source: "debio" },
    ]);

    function getHandler(method: "get" | "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postBackfill = getHandler("post", "/org-nr-backfill");
    const getQueue = getHandler("get", "/org-nr-review-queue");
    const postApprove = getHandler("post", "/org-nr-review-approve");

    async function callBackfill(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postBackfill({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }
    async function callQueue(headers: Record<string, string> = { "x-admin-key": ADMIN_KEY }): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await getQueue({ headers, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }
    async function callApprove(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postApprove({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string; name: string; orgNr?: string | null; claimedAt?: string | null;
      postalCode?: string | null; city?: string | null; isActive?: number;
      role?: string; verticalId?: string | null; umbrellaType?: string | null;
      createdAt?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, claimed_at, city, is_active, vertical_id, umbrella_type, created_at
         ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.name, o.role ?? "producer", `key-${o.id}`,
        o.orgNr ?? null, o.claimedAt ?? null, o.city ?? null,
        o.isActive ?? 1, o.verticalId ?? "rfb", o.umbrellaType ?? null,
        o.createdAt ?? "2026-01-01 00:00:00",
      );
      if (o.postalCode !== undefined) {
        testDb.prepare(`INSERT INTO agent_knowledge (agent_id, postal_code, updated_at) VALUES (?, ?, ?)`)
          .run(o.id, o.postalCode, new Date().toISOString());
      }
    }

    function readAgent(id: string): any {
      return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    }
    function readKnowledge(agentId: string): any {
      return testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
    }
    function readAuditRows(agentId: string): any[] {
      return testDb.prepare("SELECT * FROM agents_org_nr_audit WHERE agent_id = ? ORDER BY rowid ASC").all(agentId);
    }
    function readQueueRow(agentId: string): any {
      return testDb.prepare("SELECT * FROM agents_org_nr_review_queue WHERE agent_id = ?").get(agentId);
    }

    // ── (a) 403 without X-Admin-Key on all three routes ──────────────────
    {
      const b = await callBackfill({}, {});
      assertEq(b.status, 403, "a1: POST org-nr-backfill without X-Admin-Key -> 403");
      const q = await callQueue({});
      assertEq(q.status, 403, "a2: GET org-nr-review-queue without X-Admin-Key -> 403");
      const ap = await callApprove({ approvals: [] }, {});
      assertEq(ap.status, 403, "a3: POST org-nr-review-approve without X-Admin-Key -> 403");
    }

    // ── (b) auto-select scoping ───────────────────────────────────────────
    insertAgent({ id: "sel-eligible", name: "Sel Eligible Gård AS", createdAt: "2026-01-01 00:00:00" });
    insertAgent({ id: "sel-locked", name: "Sel Locked Gård AS", claimedAt: "2026-01-01 00:00:00", createdAt: "2026-01-02 00:00:00" });
    insertAgent({ id: "sel-has-orgnr", name: "Sel Has Orgnr AS", orgNr: "911111100", createdAt: "2026-01-03 00:00:00" });
    insertAgent({ id: "sel-inactive", name: "Sel Inactive AS", isActive: 0, createdAt: "2026-01-04 00:00:00" });
    insertAgent({ id: "sel-umbrella", name: "Sel Umbrella AS", umbrellaType: "hanen", createdAt: "2026-01-05 00:00:00" });
    insertAgent({ id: "sel-dental", name: "Sel Dental AS", verticalId: "dental", createdAt: "2026-01-06 00:00:00" });
    insertAgent({ id: "sel-consumer", name: "Sel Consumer", role: "consumer", createdAt: "2026-01-07 00:00:00" });
    {
      const dry = await callBackfill({ limit: 50, apply: false });
      const ids = (dry.body.changed as any[]).map((c) => c.agent_id)
        .concat((dry.body.unresolved as any[]).map((u) => u.agent_id))
        .concat(dry.body.skipped_locked as string[]);
      // sel-eligible has no Brreg/local candidate configured -> no_brreg_candidate, but it MUST have been scanned (proves selection).
      assertTrue(ids.includes("sel-eligible"), "b1: eligible blank-org_nr RFB producer row IS selected/processed");
      assertTrue(!ids.includes("sel-locked") || dry.body.skipped_locked.includes("sel-locked"), "setup sanity: locked row only ever appears via skipped_locked");
      assertTrue(!ids.includes("sel-has-orgnr"), "b2: already-has-org_nr row excluded from auto-selection");
      assertTrue(!ids.includes("sel-inactive"), "b3: inactive row excluded from auto-selection");
      assertTrue(!ids.includes("sel-umbrella"), "b4: umbrella row excluded from auto-selection");
      assertTrue(!ids.includes("sel-dental"), "b5: dental-vertical row excluded from auto-selection");
      assertTrue(!ids.includes("sel-consumer"), "b6: non-producer role excluded from auto-selection");
    }

    // ── (c) agentOrgNrPostalCorroborated ─────────────────────────────────
    assertTrue(
      agentOrgNrPostalCorroborated({ postal_code: "1450", city: null }, { brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "c1: matching postal_code -> corroborated",
    );
    assertTrue(
      agentOrgNrPostalCorroborated({ postal_code: null, city: "Nesoddtangen" }, { brreg_postal: null, brreg_poststed: "Nesoddtangen" }),
      "c2: matching city (exact, no postal_code on target) -> corroborated",
    );
    assertTrue(
      !agentOrgNrPostalCorroborated({ postal_code: null, city: null }, { brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "c3: no signal at all on target -> NEVER corroborated",
    );
    assertTrue(
      !agentOrgNrPostalCorroborated({ postal_code: "9999", city: null }, { brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "c4: postal-code region mismatch (different first digit) -> not corroborated",
    );
    assertTrue(
      !agentOrgNrPostalCorroborated({ postal_code: null, city: "Nes" }, { brreg_postal: null, brreg_poststed: "Sandnes" }),
      "c5: short city 'Nes' does NOT falsely corroborate against unrelated 'Sandnes'",
    );

    // ── (d) agentOrgNrAutoWriteEligible ───────────────────────────────────
    assertTrue(
      agentOrgNrAutoWriteEligible({ postal_code: "1450", city: null }, { confidence: 1.0, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "d1: confidence 1.0 + corroboration -> eligible",
    );
    assertTrue(
      !agentOrgNrAutoWriteEligible({ postal_code: "1450", city: null }, { confidence: 0.95, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "d2: confidence 0.95 -> NEVER auto-write even with matching postal",
    );
    assertTrue(
      !agentOrgNrAutoWriteEligible({ postal_code: null, city: null }, { confidence: 1.0, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" }),
      "d3: confidence 1.0 but no corroboration signal -> not eligible",
    );

    // ── (e) applyAgentOrgNr ────────────────────────────────────────────────
    insertAgent({ id: "apply-fill", name: "Apply Fill AS" });
    insertAgent({ id: "apply-locked", name: "Apply Locked AS", claimedAt: "2026-01-01 00:00:00" });
    insertAgent({ id: "apply-conflict-a", name: "Apply Conflict A AS", orgNr: "922222200" });
    insertAgent({ id: "apply-conflict-b", name: "Apply Conflict B AS" });
    {
      const writtenE = applyAgentOrgNr(testDb as any, "apply-fill", "933333300", "https://data.brreg.no/enhetsregisteret/api/enheter/933333300", "brreg_name_search", "batch-e1");
      assertEq(writtenE, ["org_nr"], "e1: applyAgentOrgNr writes org_nr");
      assertEq(readAgent("apply-fill").org_nr, "933333300", "e2: org_nr written to the row");
      const auditE = readAuditRows("apply-fill");
      assertEq(auditE.length, 1, "e3: exactly 1 audit row");
      assertEq(auditE[0].new_value, "933333300", "e4: audit new_value matches");
      assertEq(auditE[0].batch_id, "batch-e1", "e5: audit batch_id matches");
      const kE = readKnowledge("apply-fill");
      const provE = JSON.parse(kE.field_provenance);
      assertTrue(Array.isArray(provE.org_nr) && provE.org_nr.length === 1, "e6: agent_knowledge.field_provenance has an org_nr entry");
      assertEq(provE.org_nr[0].source_type, "brreg_name_search", "e7: provenance source_type matches");

      // idempotent second call
      const writtenE2 = applyAgentOrgNr(testDb as any, "apply-fill", "944444400", "url2", "brreg_name_search");
      assertEq(writtenE2, [], "e8: second call on an already-filled row writes nothing");
      assertEq(readAgent("apply-fill").org_nr, "933333300", "e9: org_nr unchanged by the idempotent second call");
      assertEq(readAuditRows("apply-fill").length, 1, "e10: no new audit row from the idempotent second call");

      // locked
      const writtenLocked = applyAgentOrgNr(testDb as any, "apply-locked", "955555500", "url", "brreg_name_search");
      assertEq(writtenLocked, [], "e11: claimed (locked) agent -> nothing written");
      assertEq(readAgent("apply-locked").org_nr, null, "e12: locked agent's org_nr remains blank");

      // UNIQUE-style conflict (no DB constraint on agents.org_nr, enforced in application code)
      const writtenConflict = applyAgentOrgNr(testDb as any, "apply-conflict-b", "922222200", "url", "brreg_name_search");
      assertEq(writtenConflict, [], "e13: org_nr already held by another agent -> nothing written, no throw");
      assertEq(readAgent("apply-conflict-b").org_nr, null, "e14: apply-conflict-b's org_nr remains blank");
      assertEq(readAgent("apply-conflict-a").org_nr, "922222200", "e15: apply-conflict-a untouched by the other agent's attempt");
    }

    // ── (f) agentOrgNrWasRolledBack ────────────────────────────────────────
    insertAgent({ id: "rb-agent", name: "Rollback Agent AS" });
    {
      assertTrue(!agentOrgNrWasRolledBack(testDb as any, "rb-agent"), "f1: no audit history -> not rolled back");
      testDb.prepare(
        `INSERT INTO agents_org_nr_audit (id, agent_id, field_name, old_value, new_value, source_url, changed_by, changed_at)
         VALUES ('rb-audit-1', 'rb-agent', 'org_nr', '966666600', NULL, 'internal://rollback', 'admin', datetime('now'))`,
      ).run();
      assertTrue(agentOrgNrWasRolledBack(testDb as any, "rb-agent"), "f2: latest audit row carries the rollback marker -> rolled back");
    }

    // ── Route tests ─────────────────────────────────────────────────────

    // (g)+(h): dry-run + apply for an exact-match, corroborated candidate
    // via Brreg name-search (no local-JSON hit configured for this name).
    insertAgent({ id: "route-exact", name: "Route Exact AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Exact%20AS", { status: 200, body: { _embedded: { enheter: [searchHit("970000001", "Route Exact AS", "1601", "Sarpsborg")] } } });
    detailFixtures.set("970000001", { status: 200, body: activeDetail("970000001", "Route Exact AS") });
    {
      const searchCallsBefore = searchCallCount;
      const dry = await callBackfill({ agentIds: ["route-exact"], apply: false });
      assertEq(dry.status, 200, "g1: dry-run -> 200");
      assertEq(dry.body.dry_run, true, "g2: dry_run true");
      const dryHit = dry.body.changed.find((c: any) => c.agent_id === "route-exact");
      assertTrue(!!dryHit, "g3: route-exact appears in dry-run changed[]");
      assertEq(dryHit.org_nr, "970000001", "g4: dry-run candidate org_nr matches the Brreg hit");
      assertEq(dryHit.source, "brreg_name_search", "g5: source tagged as brreg_name_search (no local-JSON hit for this name)");
      assertEq(readAgent("route-exact").org_nr, null, "g6: dry-run performs ZERO writes");
      assertTrue(searchCallCount > searchCallsBefore, "g7: dry-run genuinely called the Brreg name-search");

      const applyRes = await callBackfill({ agentIds: ["route-exact"], apply: true });
      assertEq(applyRes.status, 200, "h1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "h2: dry_run false");
      assertEq(readAgent("route-exact").org_nr, "970000001", "h3: route-exact org_nr actually written");
      assertEq(applyRes.body.agents_enriched, applyRes.body.changed.length, "h4: agents_enriched === changed.length");
    }

    // (i) locked agent -> skipped_locked, no Brreg call for it.
    insertAgent({ id: "route-locked", name: "Route Locked AS", claimedAt: "2026-01-01 00:00:00", createdAt: "2026-02-01 00:00:00" });
    {
      const callsBefore = searchCallCount;
      const res = await callBackfill({ agentIds: ["route-locked"], apply: true });
      assertTrue(res.body.skipped_locked.includes("route-locked"), "i1: locked agent -> skipped_locked");
      assertEq(searchCallCount, callsBefore, "i2: no Brreg name-search call made for a locked agent");
      assertEq(readAgent("route-locked").org_nr, null, "i3: locked agent untouched");
    }

    // (j) already-has-org_nr via agentIds override.
    {
      const res = await callBackfill({ agentIds: ["route-exact"], apply: true });
      assertTrue(res.body.unresolved.some((u: any) => u.agent_id === "route-exact" && u.reason === "already_filled"), "j1: already-filled agent via override -> unresolved already_filled");
      assertTrue(!res.body.changed.some((c: any) => c.agent_id === "route-exact"), "j2: does not reappear in changed[]");
    }

    // (k) no_brreg_candidate.
    insertAgent({ id: "route-no-cand", name: "Route No Candidate AS", createdAt: "2026-02-01 00:00:00" });
    {
      const res = await callBackfill({ agentIds: ["route-no-cand"], apply: false });
      assertTrue(res.body.unresolved.some((u: any) => u.agent_id === "route-no-cand" && u.reason === "no_brreg_candidate"), "k1: no_brreg_candidate reported");
      const q = readQueueRow("route-no-cand");
      assertTrue(!!q, "k2: upserted into review queue");
      assertEq(q.candidate_orgnr, null, "k3: null candidate fields on a no_brreg_candidate row");
    }

    // (l) ambiguous_exact_name_ties — two DISTINCT org numbers, both 1.0.
    insertAgent({ id: "route-tie", name: "Route Tie AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Tie%20AS", {
      status: 200,
      body: { _embedded: { enheter: [
        searchHit("970000010", "Route Tie AS", "1601", "Sarpsborg"),
        searchHit("970000011", "Route Tie AS", "1601", "Sarpsborg"),
      ] } },
    });
    {
      const res = await callBackfill({ agentIds: ["route-tie"], apply: true });
      assertTrue(res.body.unresolved.some((u: any) => u.agent_id === "route-tie" && u.reason === "ambiguous_exact_name_ties"), "l1: ambiguous_exact_name_ties reported");
      assertEq(readAgent("route-tie").org_nr, null, "l2: never auto-written");
      assertEq(readQueueRow("route-tie").reason, "ambiguous_exact_name_ties", "l3: review-queue reason matches");
    }

    // (m) stripped_name_requires_postal_match — "Navn — Sted" suffix strips,
    // exact match on the core name, but postal does NOT corroborate.
    insertAgent({ id: "route-stripped", name: "Route Stripped Gård — Bygdøy", postalCode: "9999", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Stripped%20G%C3%A5rd", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000020", "Route Stripped Gård", "1601", "Sarpsborg")] } },
    });
    detailFixtures.set("970000020", { status: 200, body: activeDetail("970000020", "Route Stripped Gård") });
    {
      const res = await callBackfill({ agentIds: ["route-stripped"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "route-stripped" && u.reason === "stripped_name_requires_postal_match"),
        "m1: stripped_name_requires_postal_match reported",
      );
      assertEq(readAgent("route-stripped").org_nr, null, "m2: never auto-written");
    }

    // (n) previously_rolled_back — otherwise-perfect candidate vetoed by a
    // prior rollback-marker audit row.
    insertAgent({ id: "route-rolledback", name: "Route Rolledback AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    testDb.prepare(
      `INSERT INTO agents_org_nr_audit (id, agent_id, field_name, old_value, new_value, source_url, changed_by, changed_at)
       VALUES ('rb-audit-2', 'route-rolledback', 'org_nr', '970000030', NULL, 'internal://rollback', 'admin', datetime('now'))`,
    ).run();
    searchFixtures.set("navn=Route%20Rolledback%20AS", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000030", "Route Rolledback AS", "1601", "Sarpsborg")] } },
    });
    {
      const res = await callBackfill({ agentIds: ["route-rolledback"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "route-rolledback" && u.reason === "previously_rolled_back"),
        "n1: previously_rolled_back veto reported — the same deterministic answer is NOT silently re-applied",
      );
      assertEq(readAgent("route-rolledback").org_nr, null, "n2: never re-written");
    }

    // (o) brreg_not_active — confidence 1.0 + corroborated, but liveness
    // check reports a dissolved entity.
    insertAgent({ id: "route-dissolved", name: "Route Dissolved AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Dissolved%20AS", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000040", "Route Dissolved AS", "1601", "Sarpsborg")] } },
    });
    detailFixtures.set("970000040", { status: 200, body: dissolvedDetail("970000040", "Route Dissolved AS") });
    {
      const res = await callBackfill({ agentIds: ["route-dissolved"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "route-dissolved" && u.reason === "brreg_not_active"),
        "o1: brreg_not_active veto reported — a dissolved entity must never claim a row",
      );
      assertEq(readAgent("route-dissolved").org_nr, null, "o2: never written");
    }

    // (p) needs_human_review — hit found, confidence 0.95 (first-token +
    // postal match, not an exact name match).
    insertAgent({ id: "route-review", name: "Route Review AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Review%20AS", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000050", "Route Something Else Entirely AS", "1601", "Sarpsborg")] } },
    });
    {
      const res = await callBackfill({ agentIds: ["route-review"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "route-review" && u.reason === "needs_human_review"),
        "p1: needs_human_review reported for a sub-exact-match hit",
      );
      assertEq(readAgent("route-review").org_nr, null, "p2: never auto-written");
    }

    // (q) local-JSON-first — one agent matches a vendored fixture (NO Brreg
    // name-search call), a sibling with no local match still crawls Brreg.
    insertAgent({ id: "route-local-hit", name: "Lokal Fixture Gård AS", postalCode: "1450", createdAt: "2026-02-01 00:00:00" });
    detailFixtures.set("980000001", { status: 200, body: activeDetail("980000001", "Lokal Fixture Gård AS") });
    insertAgent({ id: "route-local-miss", name: "Route Local Miss AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Local%20Miss%20AS", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000060", "Route Local Miss AS", "1601", "Sarpsborg")] } },
    });
    detailFixtures.set("970000060", { status: 200, body: activeDetail("970000060", "Route Local Miss AS") });
    {
      const searchCallsBefore = searchCallCount;
      const res = await callBackfill({ agentIds: ["route-local-hit", "route-local-miss"], apply: true });

      const localHitChanged = res.body.changed.find((c: any) => c.agent_id === "route-local-hit");
      assertTrue(!!localHitChanged, "q1: route-local-hit auto-written via the local-JSON candidate");
      assertEq(localHitChanged.org_nr, "980000001", "q2: org_nr matches the vendored fixture, not any live Brreg number");
      assertEq(localHitChanged.source, "local_json_lokalmat", "q3: source tagged local_json_lokalmat");
      assertEq(readAgent("route-local-hit").org_nr, "980000001", "q4: actually written to the row");

      const missChanged = res.body.changed.find((c: any) => c.agent_id === "route-local-miss");
      assertTrue(!!missChanged, "q5: route-local-miss (no local match) still resolved via Brreg fallback");
      assertEq(missChanged.source, "brreg_name_search", "q6: source tagged brreg_name_search for the fallback path");
      assertTrue(searchCallCount > searchCallsBefore, "q7: the Brreg name-search WAS called for the local-miss agent");
    }

    // ── (r) GET review-queue: lists entries, rerun upserts in place ──────
    {
      const list1 = await callQueue();
      assertEq(list1.status, 200, "r1: review-queue GET -> 200");
      const entry1 = list1.body.entries.find((e: any) => e.agent_id === "route-review");
      assertTrue(!!entry1, "r2: route-review appears in the review-queue listing");
      const countBefore = list1.body.entries.length;

      await callBackfill({ agentIds: ["route-review"], apply: true }); // rerun, still needs_human_review
      const list2 = await callQueue();
      assertEq(list2.body.entries.length, countBefore, "r3: rerun upserts in place, no duplicate row");
      assertEq(list2.body.entries.filter((e: any) => e.agent_id === "route-review").length, 1, "r4: exactly one row for route-review");
    }

    // ── (s) POST review-approve ────────────────────────────────────────────
    {
      // dry-run preview of the queued route-review candidate.
      const q = readQueueRow("route-review");
      const dryApprove = await callApprove({ approvals: [{ agent_id: "route-review", org_nr: q.candidate_orgnr }], apply: false });
      assertEq(dryApprove.status, 200, "s1: dry-run approve -> 200");
      assertEq(dryApprove.body.dry_run, true, "s2: dry_run true");
      assertEq(dryApprove.body.approved_count, 1, "s3: 1 approved in dry-run preview");
      assertEq(readAgent("route-review").org_nr, null, "s4: dry-run approve performs ZERO writes");

      // mismatch: wrong org_nr for the queued candidate.
      const mismatchRes = await callApprove({ approvals: [{ agent_id: "route-review", org_nr: "999999999" }], apply: true });
      assertTrue(
        mismatchRes.body.rejected.some((r: any) => r.agent_id === "route-review" && r.reason === "mismatch_with_queued_candidate"),
        "s5: wrong org_nr -> mismatch_with_queued_candidate, nothing written",
      );
      assertEq(readAgent("route-review").org_nr, null, "s6: mismatch performs zero writes");

      // not_in_review_queue.
      const notQueuedRes = await callApprove({ approvals: [{ agent_id: "does-not-exist", org_nr: "970000099" }], apply: true });
      assertTrue(
        notQueuedRes.body.rejected.some((r: any) => r.agent_id === "does-not-exist" && r.reason === "not_in_review_queue"),
        "s7: agent not in queue -> not_in_review_queue",
      );

      // real approve: correct org_nr for the queued candidate.
      const approveRes = await callApprove({ approvals: [{ agent_id: "route-review", org_nr: q.candidate_orgnr }], apply: true });
      assertEq(approveRes.body.approved_count, 1, "s8: correct org_nr -> approved");
      assertEq(readAgent("route-review").org_nr, q.candidate_orgnr, "s9: org_nr actually written on approve");
      assertTrue(!readQueueRow("route-review"), "s10: queue entry cleared after a confirmed approve-write");
    }

    // ── (t) errors[]: write failure during apply ───────────────────────────
    insertAgent({ id: "route-write-fail", name: "Route Write Fail AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set("navn=Route%20Write%20Fail%20AS", {
      status: 200,
      body: { _embedded: { enheter: [searchHit("970000070", "Route Write Fail AS", "1601", "Sarpsborg")] } },
    });
    detailFixtures.set("970000070", { status: 200, body: activeDetail("970000070", "Route Write Fail AS") });
    testDb.exec("DROP TABLE agents_org_nr_audit");
    {
      const res = await callBackfill({ agentIds: ["route-write-fail"], apply: true });
      assertEq(res.status, 200, "t1: a write failure is a 200 with the failure reported in errors[], not a 500");
      assertTrue(
        res.body.errors.some((e: any) => e.agent_id === "route-write-fail" && typeof e.error === "string" && e.error.startsWith("write_failed:")),
        "t2: route-write-fail -> errors[] with a write_failed: prefix",
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-agents-org-nr-backfill: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-org-nr-backfill.test.ts`
if (require.main === module) {
  runAdminAgentsOrgNrBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
