/**
 * admin-pool-blocker-explain.test.ts — tests for
 * dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype punkt 2:
 * GET /admin/pool-blocker-explain, the READ-ONLY per-agent gate diagnosis
 * that names which outreach_ready_pool-VIEW leg and which
 * homepage-provenance-batch auto-select leg blocks a given agent.
 *
 * Covers (src/routes/admin-pool-blocker-explain.ts):
 *   (a) 403 without X-Admin-Key.
 *   (b) 400 without agentId/agentIds.
 *   (c) unknown agent id -> found: false, no throw.
 *   (d) the F1 pilot shape (pending_verify + k.website set + about set +
 *       field_provenance empty) -> crawl_auto_select.eligible TRUE, and
 *       pool_blockers names verification_status_not_verified.
 *   (e) no-yield backoff (streak >= 3, recent attempt) -> crawl blocker
 *       no_yield_or_wrong_entity_backoff; an OLD attempt does NOT block.
 *   (f) parked homepage (homepage_unreachable_since fresh) -> crawl blocker
 *       parked_homepage_unreachable.
 *   (g) fully pool-eligible row -> pool_blockers empty, in_pool true (VIEW
 *       agrees), crawl blockers name already_has_homepage_provenance +
 *       status_not_in_selector_list.
 *   (h) read-only: the endpoint performs no writes (row byte-identical
 *       before/after).
 *
 * Standalone: npx tsx src/routes/admin-pool-blocker-explain.test.ts
 * (not wired into tests/test.ts — same file-scoping convention as
 * admin-rfb-website-discovery.test.ts.)
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminPoolBlockerExplainTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "pbe-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("../routes/admin-pool-blocker-explain");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-pool-blocker-explain") as
      typeof import("../routes/admin-pool-blocker-explain");
    const routerModule = routeModule.default;

    const layer = (routerModule as any).stack.find(
      (l: any) => l.route && l.route.path === "/" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET / handler registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callExplain(
      query: Record<string, string>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string;
      name: string;
      website?: string | null;
      aUrl?: string | null;
      verificationStatus?: string;
      enrichmentStatus?: string | null;
      email?: string | null;
      about?: string | null;
      fieldProvenance?: string | null;
      urlLastStatus?: number | null;
      urlLastProbed?: string | null;
      homepageUnreachableSince?: string | null;
      noYieldStreak?: number;
      wrongEntityStreak?: number;
      lastEnrichmentAttemptAt?: string | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at, is_active)
         VALUES (?, ?, 't', 't', 'x@example.com', ?, 'producer', ?, 'rfb', '2026-01-01 00:00:00', 1)`,
      ).run(o.id, o.name, o.aUrl ?? "", `key-${o.id}`);
      testDb.prepare(
        `INSERT INTO agent_knowledge (
           agent_id, website, verification_status, enrichment_status, email, about,
           field_provenance, url_last_status, url_last_probed, homepage_unreachable_since,
           no_yield_streak, wrong_entity_streak, last_enrichment_attempt_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website ?? null, o.verificationStatus ?? "pending_verify",
        o.enrichmentStatus ?? "partial", o.email ?? null, o.about ?? null,
        o.fieldProvenance ?? "{}", o.urlLastStatus ?? null, o.urlLastProbed ?? null,
        o.homepageUnreachableSince ?? null, o.noYieldStreak ?? 0, o.wrongEntityStreak ?? 0,
        o.lastEnrichmentAttemptAt ?? null, new Date().toISOString(),
      );
    }

    const nowIso = new Date().toISOString();
    const daysAgoIso = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

    // ── (a) auth --
    {
      const r = await callExplain({ agentId: "x" }, {});
      assertEq(r.status, 403, "a1: 403 without X-Admin-Key");
    }

    // ── (b) missing input --
    {
      const r = await callExplain({});
      assertEq(r.status, 400, "b1: 400 without agentId/agentIds");
    }

    // ── (c) unknown id --
    {
      const r = await callExplain({ agentId: "finnes-ikke" });
      assertEq(r.status, 200, "c1: 200");
      assertEq(r.body.agents[0].found, false, "c2: found: false for unknown id");
    }

    // ── (d) the F1 pilot shape: k.website set, about set, provenance empty,
    //     status pending_verify -> crawl-eligible, pool blocked on status --
    {
      insertAgent({
        id: "pbe-f1",
        name: "Eksempel Ysteri",
        website: "https://eksempelysteri.no",
        about: "Et lite ysteri i fjellbygda med egne geiter.",
        verificationStatus: "pending_verify",
        fieldProvenance: "{}",
      });
      const r = await callExplain({ agentId: "pbe-f1" });
      const a = r.body.agents[0];
      assertEq(a.found, true, "d1: found");
      assertEq(a.crawl_auto_select.eligible, true, "d2: F1 shape IS crawl-auto-select eligible");
      assertEq(a.crawl_auto_select.blockers, [], "d3: no crawl blockers");
      assertTrue(
        a.pool_blockers.some((b: string) => b.startsWith("verification_status_not_verified")),
        "d4: pool blocker names the unverified status",
      );
      assertTrue(a.pool_blockers.includes("no_email"), "d5: pool blocker names missing email");
      assertEq(a.in_pool, false, "d6: not in pool");
      assertEq(a.signals.homepage_url, "https://eksempelysteri.no", "d7: homepage COALESCE resolved");
    }

    // ── (e) no-yield backoff: streak >= 3 + RECENT attempt blocks; an OLD
    //     attempt does not --
    {
      insertAgent({
        id: "pbe-backoff",
        name: "Backoff Gard",
        website: "https://backoffgard.no",
        about: "Gard i test.",
        noYieldStreak: 3,
        lastEnrichmentAttemptAt: nowIso,
      });
      insertAgent({
        id: "pbe-backoff-old",
        name: "Gammel Backoff Gard",
        website: "https://gammelbackoffgard.no",
        about: "Gard i test.",
        noYieldStreak: 3,
        lastEnrichmentAttemptAt: daysAgoIso(30),
      });
      const r = await callExplain({ agentIds: "pbe-backoff,pbe-backoff-old" });
      const fresh = r.body.agents.find((x: any) => x.agent_id === "pbe-backoff");
      const old = r.body.agents.find((x: any) => x.agent_id === "pbe-backoff-old");
      assertTrue(
        fresh.crawl_auto_select.blockers.some((b: string) => b.startsWith("no_yield_or_wrong_entity_backoff")),
        "e1: fresh streak>=3 attempt blocks",
      );
      assertEq(fresh.signals.backoff_active, true, "e2: backoff_active signal true");
      assertTrue(
        !old.crawl_auto_select.blockers.some((b: string) => b.startsWith("no_yield_or_wrong_entity_backoff")),
        "e3: a 30-day-old attempt is past the backoff window (default 14d) and does not block",
      );
    }

    // ── (f) parked homepage --
    {
      insertAgent({
        id: "pbe-parked",
        name: "Parkert Gard",
        website: "https://parkertgard.no",
        about: "Gard i test.",
        homepageUnreachableSince: daysAgoIso(5),
      });
      const r = await callExplain({ agentId: "pbe-parked" });
      const a = r.body.agents[0];
      assertTrue(
        a.crawl_auto_select.blockers.some((b: string) => b.startsWith("parked_homepage_unreachable")),
        "f1: fresh homepage_unreachable_since blocks the crawl selector",
      );
    }

    // ── (g) fully pool-eligible row: pool_blockers empty, VIEW agrees --
    {
      insertAgent({
        id: "pbe-pool",
        name: "Klar Gard",
        website: "https://klargard.no",
        about: "Ferdig beriket gard.",
        verificationStatus: "verified",
        enrichmentStatus: "rich",
        email: "post@klargard.no",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
        fieldProvenance: JSON.stringify({
          address: [{ source_type: "homepage", value: "Testveien 1" }, { source_type: "google_places", value: "Testveien 1" }],
        }),
      });
      const r = await callExplain({ agentId: "pbe-pool" });
      const a = r.body.agents[0];
      assertEq(a.pool_blockers, [], "g1: no pool blockers");
      assertEq(a.in_pool, true, "g2: the outreach_ready_pool VIEW agrees");
      assertTrue(
        a.crawl_auto_select.blockers.some((b: string) => b.startsWith("status_not_in_selector_list")),
        "g3: crawl selector correctly does NOT target verified rows",
      );
      assertEq(a.signals.provenance_source_counts.address, 2, "g4: per-field provenance source count surfaced");
    }

    // ── (i) skive A: guard 3 (domain coherence) and guard 4 (email
    //     ownership) are surfaced as blockers. Live 2026-08-10: 19 of 45
    //     review_required rows had BOTH gating fields pool_eligible and were
    //     blocked solely by these two — this route used to report them as
    //     having no blockers at all. --
    {
      insertAgent({
        id: "pbe-dc",
        name: "Larsagarden-lignende",
        website: "https://plattformvert.example",
        aUrl: "https://egetdomene.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        enrichmentStatus: "rich",
        email: "post@egetdomene.no",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-dc'`,
      ).run(JSON.stringify({
        domain_coherence: {
          coherent: false,
          reason: "knowledge.website host plattformvert.example != agents.url host egetdomene.no",
        },
      }));

      insertAgent({
        id: "pbe-eo",
        name: "Frimeil-produsent",
        website: "https://frimeil.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        enrichmentStatus: "rich",
        email: "produsent@gmail.com",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-eo'`,
      ).run(JSON.stringify({ email_ownership_unproven: true }));

      const r = await callExplain({ agentIds: "pbe-dc,pbe-eo" });
      const dc = r.body.agents.find((x: any) => x.agent_id === "pbe-dc");
      const eo = r.body.agents.find((x: any) => x.agent_id === "pbe-eo");

      assertTrue(
        dc.pool_blockers.some((b: string) => b.startsWith("domain_incoherent")),
        "i1: domain-incoherent row names the domain_incoherent blocker",
      );
      assertTrue(
        String(dc.pool_blockers.find((b: string) => b.startsWith("domain_incoherent"))).includes("egetdomene.no"),
        "i2: the blocker carries the verifier's own reason text",
      );
      assertEq(dc.signals.domain_coherence.coherent, false, "i3: raw domain_coherence signal surfaced");
      // Policy 2026-08-10 (Daniel, lokal#568): free-mail no longer blocks, so
      // this must NOT appear as a pool blocker — the signal stays observable
      // but is not an answer to "what is holding this agent back".
      assertTrue(
        !eo.pool_blockers.some((b: string) => b.startsWith("email_ownership_unproven")),
        "i4: free-mail is NOT reported as a pool blocker (report-only since 2026-08-10)",
      );
      assertEq(eo.signals.email_ownership_unproven, true, "i5: raw email-ownership signal still surfaced for observability");
      // A row with a clean stored verdict must NOT gain phantom blockers.
      const clean = await callExplain({ agentId: "pbe-pool" });
      assertEq(clean.body.agents[0].pool_blockers, [], "i6: a clean row still reports no blockers");
      assertEq(
        clean.body.agents[0].signals.email_ownership_unproven, false,
        "i7: absent stored verdict is reported as false, never null/undefined",
      );
    }

    // ── (h) read-only: no writes happen --
    {
      const before = testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'pbe-f1'").get();
      await callExplain({ agentId: "pbe-f1" });
      const after = testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = 'pbe-f1'").get();
      assertEq(after, before, "h1: agent_knowledge row is byte-identical after an explain call");
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-pool-blocker-explain: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
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

// Standalone runner: `npx tsx src/routes/admin-pool-blocker-explain.test.ts`
if (require.main === module) {
  runAdminPoolBlockerExplainTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
