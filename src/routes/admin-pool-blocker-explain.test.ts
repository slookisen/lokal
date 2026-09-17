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
      products?: string | null;
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
           agent_id, website, verification_status, enrichment_status, email, about, products,
           field_provenance, url_last_status, url_last_probed, homepage_unreachable_since,
           no_yield_streak, wrong_entity_streak, last_enrichment_attempt_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website ?? null, o.verificationStatus ?? "pending_verify",
        o.enrichmentStatus ?? "partial", o.email ?? null, o.about ?? null, o.products ?? "[]",
        o.fieldProvenance ?? "{}", o.urlLastStatus ?? null, o.urlLastProbed ?? null,
        o.homepageUnreachableSince ?? null, o.noYieldStreak ?? 0, o.wrongEntityStreak ?? 0,
        o.lastEnrichmentAttemptAt ?? null, new Date().toISOString(),
      );
    }

    function insertSentLog(o: { agentId?: string | null; recipientEmail?: string | null }): void {
      testDb.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
         VALUES (?, ?, ?, 'email', 'rfb')`,
      ).run(o.agentId ?? null, o.recipientEmail ?? null, new Date().toISOString());
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

    // ── (j) dev-request 2026-09-06: already_sent (outreach_sent_log) is a
    //     distinct blocker from already_contacted (CRM-derived) — an agent
    //     can be excluded by the VIEW's NOT EXISTS(outreach_sent_log) leg
    //     with no matching crm_messages row at all. --
    {
      insertAgent({
        id: "pbe-sent",
        name: "Sendt Gard",
        website: "https://sendtgard.no",
        about: "Ferdig beriket gard, allerede kontaktet via utsendingsjobben.",
        verificationStatus: "verified",
        enrichmentStatus: "rich",
        email: "post@sendtgard.no",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
      });
      insertSentLog({ agentId: "pbe-sent" });
      const r = await callExplain({ agentId: "pbe-sent" });
      const a = r.body.agents[0];
      assertTrue(
        a.pool_blockers.includes("already_sent (outreach_sent_log)"),
        "j1: outreach_sent_log row blocks via already_sent",
      );
      assertTrue(
        !a.pool_blockers.includes("already_contacted"),
        "j2: already_contacted (CRM-derived) is independent and absent here",
      );
      assertEq(a.signals.already_sent, true, "j3: raw already_sent signal surfaced");
      assertEq(a.in_pool, false, "j4: VIEW agrees — excluded via its outreach_sent_log NOT EXISTS leg");
    }

    // ── (k) partial + content threshold MET (about >= 80) -> no
    //     content_threshold_not_met blocker, VIEW admits it --
    {
      insertAgent({
        id: "pbe-partial-in",
        name: "Partial Innenfor",
        website: "https://partialinnenfor.no",
        about: "A".repeat(90),
        verificationStatus: "verified",
        enrichmentStatus: "partial",
        email: "post@partialinnenfor.no",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
      });
      const r = await callExplain({ agentId: "pbe-partial-in" });
      const a = r.body.agents[0];
      assertTrue(
        !a.pool_blockers.some((b: string) => b.startsWith("content_threshold_not_met")),
        "k1: about>=80 partial row has no content_threshold_not_met blocker",
      );
      assertTrue(
        !a.pool_blockers.some((b: string) => b.startsWith("enrichment_status_not_rich")),
        "k2: partial no longer masquerades as enrichment_status_not_rich",
      );
      assertEq(a.in_pool, true, "k3: VIEW admits a qualified partial row");
    }

    // ── (l) partial + content threshold NOT met (about < 80, < 3 products)
    //     -> content_threshold_not_met blocker, VIEW excludes it --
    {
      insertAgent({
        id: "pbe-partial-out",
        name: "Partial Utenfor",
        website: "https://partialutenfor.no",
        about: "A".repeat(40),
        products: JSON.stringify([{ name: "Ost" }]),
        verificationStatus: "verified",
        enrichmentStatus: "partial",
        email: "post@partialutenfor.no",
        urlLastStatus: 200,
        urlLastProbed: nowIso,
      });
      const r = await callExplain({ agentId: "pbe-partial-out" });
      const a = r.body.agents[0];
      assertTrue(
        a.pool_blockers.includes("content_threshold_not_met (partial: about <80 chars and <3 products)"),
        "l1: under-threshold partial row names content_threshold_not_met",
      );
      assertEq(a.in_pool, false, "l2: VIEW excludes the under-threshold partial row");
    }

    // ── (m) dev-request 2026-09-17-rfb-review-required-poolblokker-uten-
    //     forklaring-og-uten-reevaluering, punkt 1: quarantine:* reason
    //     mapping for review_required rows. --
    {
      // m1: inference_only_fields (array, from the stored verdict) -> one
      // quarantine:inference_only_fields(<field>) blocker per field.
      insertAgent({
        id: "pbe-inf",
        name: "Inferensgard",
        website: "https://inferensgard.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@inferensgard.no",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-inf'`,
      ).run(JSON.stringify({ inference_only_fields: ["address", "phone"] }));

      const rInf = await callExplain({ agentId: "pbe-inf" });
      const aInf = rInf.body.agents[0];
      assertTrue(
        aInf.pool_blockers.includes("quarantine:inference_only_fields(address)"),
        "m1a: names the inference-only address field",
      );
      assertTrue(
        aInf.pool_blockers.includes("quarantine:inference_only_fields(phone)"),
        "m1b: names the inference-only phone field",
      );

      // m2: website_ownership_unverified read DIRECTLY from field_provenance
      // (the historical-coverage path — the verifier only started
      // persisting this onto the stored verdict as of this same
      // dev-request, so pre-existing quarantined rows only have the
      // field_provenance trace).
      insertAgent({
        id: "pbe-wou-fp",
        name: "Feilanker Gard",
        website: "https://feilanker.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@feilanker.no",
        fieldProvenance: JSON.stringify({ website_ownership: { status: "unverified" } }),
      });
      const rWouFp = await callExplain({ agentId: "pbe-wou-fp" });
      assertTrue(
        rWouFp.body.agents[0].pool_blockers.includes("quarantine:website_ownership_unverified"),
        "m2: website_ownership_unverified read straight from field_provenance",
      );

      // m3: website_ownership_unverified via the (new) stored-verdict flag —
      // the path future verifier runs will use.
      insertAgent({
        id: "pbe-wou-verdict",
        name: "Feilanker Gard 2",
        website: "https://feilanker2.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@feilanker2.no",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-wou-verdict'`,
      ).run(JSON.stringify({ website_ownership_unverified: true }));
      const rWouVerdict = await callExplain({ agentId: "pbe-wou-verdict" });
      assertTrue(
        rWouVerdict.body.agents[0].pool_blockers.includes("quarantine:website_ownership_unverified"),
        "m3: website_ownership_unverified read from the stored verdict flag",
      );

      // m4: domain_incoherent gets the quarantine:-prefixed blocker TOO,
      // alongside the pre-existing (unprefixed) domain_incoherent blocker
      // from block (i) — reuses that same pbe-dc fixture.
      const rDc = await callExplain({ agentId: "pbe-dc" });
      assertTrue(
        rDc.body.agents[0].pool_blockers.some((b: string) =>
          b.startsWith("quarantine:domain_incoherent(") && b.includes("egetdomene.no")
        ),
        "m4: quarantine:domain_incoherent(...) carries the verifier's own reason text",
      );

      // m5: corroborated_email_missing read from the pre-existing, always-
      // persisted email_website_gate.corroborated_email boolean.
      insertAgent({
        id: "pbe-cem-gate",
        name: "Uverifisert Epost Gard",
        website: "https://uverifisertepost.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@uverifisertepost.no",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-cem-gate'`,
      ).run(JSON.stringify({ email_website_gate: { corroborated_email: false } }));
      const rCemGate = await callExplain({ agentId: "pbe-cem-gate" });
      assertTrue(
        rCemGate.body.agents[0].pool_blockers.includes("quarantine:corroborated_email_missing"),
        "m5: corroborated_email_missing read from email_website_gate.corroborated_email=false",
      );

      // m6: corroborated_email_missing via the (new) explicit top-level flag.
      insertAgent({
        id: "pbe-cem-flag",
        name: "Uverifisert Epost Gard 2",
        website: "https://uverifisertepost2.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@uverifisertepost2.no",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-cem-flag'`,
      ).run(JSON.stringify({ corroborated_email_missing: true }));
      const rCemFlag = await callExplain({ agentId: "pbe-cem-flag" });
      assertTrue(
        rCemFlag.body.agents[0].pool_blockers.includes("quarantine:corroborated_email_missing"),
        "m6: corroborated_email_missing read from the explicit top-level flag",
      );

      // m7: reason_missing fallback — review_required, clean stored verdict
      // AND clean field_provenance -> the route must NEVER silently report
      // zero quarantine blockers for a review_required row.
      insertAgent({
        id: "pbe-unknown-reason",
        name: "Ukjent Årsak Gard",
        website: "https://ukjentarsak.no",
        about: "Gard i test.",
        verificationStatus: "review_required",
        email: "post@ukjentarsak.no",
        fieldProvenance: "{}",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-unknown-reason'`,
      ).run(JSON.stringify({}));
      const rUnknown = await callExplain({ agentId: "pbe-unknown-reason" });
      assertTrue(
        rUnknown.body.agents[0].pool_blockers.includes("quarantine:reason_missing"),
        "m7: an unrecognized/empty stored verdict falls back to quarantine:reason_missing, never a silent empty list",
      );

      // m8: quarantine:* reasons are ONLY emitted for review_required rows —
      // a pending_verify row with the SAME stored-verdict shapes must get
      // NONE of them (even though the JSON parses fine).
      insertAgent({
        id: "pbe-not-review",
        name: "Ikke Review Gard",
        website: "https://ikkereview.no",
        about: "Gard i test.",
        verificationStatus: "pending_verify",
        email: "post@ikkereview.no",
      });
      testDb.prepare(
        `UPDATE agent_knowledge SET verification_review_reason = ? WHERE agent_id = 'pbe-not-review'`,
      ).run(JSON.stringify({ inference_only_fields: ["address"], corroborated_email_missing: true }));
      const rNotReview = await callExplain({ agentId: "pbe-not-review" });
      assertTrue(
        !rNotReview.body.agents[0].pool_blockers.some((b: string) => b.startsWith("quarantine:")),
        "m8: quarantine:* blockers are scoped to review_required rows only",
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
