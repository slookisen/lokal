/**
 * opplevelser-gardssalg-outreach-candidates.test.ts — tests for
 * GET /admin/gardssalg-outreach-candidates (src/routes/opplevelser.ts),
 * added for dev-request 2026-08-16-opplevagent-outreach-rutine (slookisen/A2A),
 * Slice 1: gårdssalg's own outreach candidate-selection endpoint, the
 * counterpart to RFB's GET /admin/outreach-candidates
 * (admin-outreach-candidates.ts) mode=first/second split.
 *
 * Harness copied verbatim from opplevelser-gardssalg-outreach-pilot-send.test.ts
 * (fresh in-memory EXPERIENCES db via db-factory, fresh in-memory RFB db
 * injected via database/init's __setDbForTesting/__initSchemaForTesting — the
 * SAME global singleton routes/opplevelser.ts's own getRfbDb() reads), adapted
 * for a GET request with query params instead of a POST body.
 *
 * Covers:
 *   (a) missing/invalid mode -> 400
 *   (b) never-contacted, otherwise-eligible outreach_ready provider ->
 *       present under mode=first, absent from mode=second
 *   (c) contacted 10 days ago (own log) -> absent from BOTH modes
 *   (d) contacted 45 days ago (own log), no reply -> present under
 *       mode=second, absent from mode=first
 *   (e) two providers contacted 60 and 45 days ago (both otherwise eligible)
 *       -> mode=second returns them oldest-contacted-first
 *   (f) contacted 45 days ago WITH a CRM inbound reply -> excluded from
 *       mode=second (and mode=first)
 *   (g) blocklisted email (with a 45-day-old prior send, so the touch-
 *       cadence check itself does not already explain the exclusion) ->
 *       excluded from both modes, suppressed_counts.blocklisted reflects it
 *       in both
 *   (h) hard-bounced email, never contacted -> excluded from both modes;
 *       mode=first's suppressed_counts.hard_bounced reflects it directly
 *       (mode=second excludes it via "never contacted" first, which is a
 *       correct but different reason — see the block's own comment)
 *   (i) readiness_tier !== "outreach_ready" (needs_enrichment) -> excluded
 *       from both modes even with no send history
 *   (j) two providers sharing one recipient email, both never-contacted and
 *       otherwise eligible -> dedupe collapses to one candidate under
 *       mode=first, dedupe_suppressed_count reflects it
 *   (k) limit clamping: limit=0 -> clamped to 1; limit=500 -> not capped
 *       below the natural (small) candidate count
 *
 * Exported runOpplevelserGardssalgOutreachCandidatesTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-candidates.test.ts
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
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = "/admin/gardssalg-outreach-candidates" + (qs ? `?${qs}` : "");
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: "/admin/gardssalg-outreach-candidates",
      query,
      headers: opts.headers || {},
      body: {},
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

const VERIFIED_STAMP = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified" },
});

export function runOpplevelserGardssalgOutreachCandidatesTests(
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
    const prevSecondTouch = process.env.GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS;
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-candidates-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS = "30";
    process.env.OUTREACH_COOLDOWN_DAYS = "60";

    // NOTE: deliberately does NOT clear require.cache for "../database/init"
    // — see opplevelser-gardssalg-outreach-pilot-send.test.ts's own comment
    // for why (the module's `db` singleton must stay the SAME instance every
    // already-loaded file resolves to).
    const dbFactoryPath = require.resolve("../database/db-factory");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, blocklistPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        /* already loaded by an earlier suite in the same process */
      }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fixture helpers ─────────────────────────────────────────────────
      const insertGo = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, vertical, hjemmeside, epost, about_text, products, brreg_verified,
           catalog_hidden, slug, field_provenance, producer_type,
           enrichment_state, verification_status, source, confidence, created_at)
        VALUES
          (@id, @navn, 'experiences', @hjemmeside, @epost, 'En fin gård.', 'Cider, sider', 1,
           0, @slug, @field_provenance, 'sideri',
           'raw', 'pending_verify', 'test-fixture', 'medium', @created_at)
      `);
      function mkOutreachReady(p: { id: string; navn: string; epost: string; created_at?: string }): void {
        insertGo.run({
          id: p.id,
          navn: p.navn,
          hjemmeside: `https://${p.id}.example.no`,
          epost: p.epost,
          slug: p.id,
          field_provenance: VERIFIED_STAMP,
          created_at: p.created_at ?? "2026-01-01 00:00:00",
        });
      }

      // sent_at is computed SERVER-SIDE via SQLite's datetime('now', ...) —
      // the days-ago offset is interpolated into the SQL (integer, never
      // caller-controlled) rather than computed in JS and bound as a string,
      // so it lands in the exact SQLite-format sent_at rows this table's
      // real writers (pilot-send) produce, keeping the " " -> "T" mixed-
      // format normalization the route's mode=second ordering exercises.
      function insertSentRow(providerId: string, email: string, daysAgo: number, isTest = 0): void {
        expDb
          .prepare(
            `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, is_test)
             VALUES (?, ?, datetime('now', '-${daysAgo} days'), 'email', ?)`,
          )
          .run(providerId, email, isTest);
      }

      let contactIdSeq = 0;
      function mkCrmReply(providerId: string, email: string): void {
        contactIdSeq++;
        const contactId = `cid-${contactIdSeq}`;
        const threadId = `tid-${contactIdSeq}`;
        const msgId = `mid-${contactIdSeq}`;
        rfbDb
          .prepare(
            `INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, ?, ?, 'Test Contact', 'active', 'experiences')`,
          )
          .run(contactId, providerId, email);
        rfbDb
          .prepare(
            `INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Re: outreach', 'new', 'innkommende', 'experiences')`,
          )
          .run(threadId, contactId);
        rfbDb
          .prepare(
            `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, delivery_status, vertical_id)
             VALUES (?, ?, 'in', ?, '["outreach@opplevagent.no"]', 'Re: outreach', 'Takk for eposten', 'sent', 'experiences')`,
          )
          .run(msgId, threadId, email);
      }

      function mkHardBounce(email: string): void {
        rfbDb
          .prepare(
            `INSERT INTO email_bounces (email, bounced_at, bounce_type)
             VALUES (?, datetime('now'), 'hard')`,
          )
          .run(email);
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) missing/invalid mode -> 400 ───────────────────────────────
      const noMode = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      assertEq(noMode.status, 400, "a1: missing mode -> 400");
      assertEq(noMode.body.error, "mode must be 'first' or 'second'", "a2: error message matches the mirrored shape");
      const badMode = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "third" } });
      assertEq(badMode.status, 400, "a3: invalid mode -> 400");

      // ── (b) never-contacted, otherwise-eligible provider ───────────────
      mkOutreachReady({ id: "prov-never", navn: "Never Kontaktet Gård", epost: "post@fixture-never.no" });

      const firstNever = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertEq(firstNever.status, 200, "b1: mode=first -> 200");
      assertTrue(
        (firstNever.body.candidates as any[]).some((c) => c.provider_id === "prov-never"),
        "b2: never-contacted provider appears under mode=first",
      );
      const secondNever = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(secondNever.body.candidates as any[]).some((c) => c.provider_id === "prov-never"),
        "b3: never-contacted provider is ABSENT from mode=second",
      );

      // ── (c) contacted 10 days ago -> absent from BOTH modes ─────────────
      mkOutreachReady({ id: "prov-10d", navn: "Ti Dager Gård", epost: "post@fixture-10d.no" });
      insertSentRow("prov-10d", "post@fixture-10d.no", 10);

      const first10d = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(first10d.body.candidates as any[]).some((c) => c.provider_id === "prov-10d"),
        "c1: contacted-10-days-ago provider ABSENT from mode=first (no longer never-contacted)",
      );
      const second10d = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(second10d.body.candidates as any[]).some((c) => c.provider_id === "prov-10d"),
        "c2: contacted-10-days-ago provider ABSENT from mode=second (too recent for the 30-day second-touch window)",
      );

      // ── (d) contacted 45 days ago, no reply -> mode=second only ─────────
      mkOutreachReady({ id: "prov-45d", navn: "Femogfoerti Dager Gård", epost: "post@fixture-45d.no" });
      insertSentRow("prov-45d", "post@fixture-45d.no", 45);

      const first45d = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(first45d.body.candidates as any[]).some((c) => c.provider_id === "prov-45d"),
        "d1: contacted-45-days-ago provider ABSENT from mode=first",
      );
      const second45d = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        (second45d.body.candidates as any[]).some((c) => c.provider_id === "prov-45d"),
        "d2: contacted-45-days-ago provider PRESENT under mode=second (outside the 30-day second-touch window)",
      );

      // ── (e) 60-day and 45-day contacted providers -> oldest-first order ─
      mkOutreachReady({ id: "prov-order-60", navn: "Seksti Dager Order Gård", epost: "post@fixture-order60.no" });
      insertSentRow("prov-order-60", "post@fixture-order60.no", 60);
      mkOutreachReady({ id: "prov-order-45", navn: "Femogfoerti Dager Order Gård", epost: "post@fixture-order45.no" });
      insertSentRow("prov-order-45", "post@fixture-order45.no", 45);

      const secondOrder = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second", limit: "100" } });
      const orderIds = (secondOrder.body.candidates as any[]).map((c) => c.provider_id);
      const idx60 = orderIds.indexOf("prov-order-60");
      const idx45 = orderIds.indexOf("prov-order-45");
      assertTrue(idx60 !== -1 && idx45 !== -1, "e1: both ordering fixtures are present under mode=second");
      assertTrue(idx60 < idx45, "e2: the 60-day-ago send sorts BEFORE the 45-day-ago send (oldest-contacted-first)");

      // ── (f) 45 days ago + CRM inbound reply -> excluded from mode=second
      mkOutreachReady({ id: "prov-replied", navn: "Svarte Gård", epost: "post@fixture-replied.no" });
      insertSentRow("prov-replied", "post@fixture-replied.no", 45);
      mkCrmReply("prov-replied", "post@fixture-replied.no");

      const secondReplied = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(secondReplied.body.candidates as any[]).some((c) => c.provider_id === "prov-replied"),
        "f1: a replied provider is excluded from mode=second",
      );
      const firstReplied = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(firstReplied.body.candidates as any[]).some((c) => c.provider_id === "prov-replied"),
        "f2: also excluded from mode=first (already contacted, independently of the reply)",
      );

      // ── (g) blocklisted email, with a 45-day-old prior send so the touch-
      // cadence check itself doesn't already explain the exclusion ─────────
      mkOutreachReady({ id: "prov-blocked", navn: "Blokkert Gård", epost: "post@fixture-blocked.no" });
      insertSentRow("prov-blocked", "post@fixture-blocked.no", 45);
      blocklistSvc.addManualEntry({ identifierType: "email", identifierValue: "post@fixture-blocked.no" });

      const secondBlocked = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(secondBlocked.body.candidates as any[]).some((c) => c.provider_id === "prov-blocked"),
        "g1: blocklisted provider excluded from mode=second",
      );
      assertTrue(
        secondBlocked.body.suppressed_counts.blocklisted >= 1,
        "g2: mode=second suppressed_counts.blocklisted reflects it",
      );
      const firstBlocked = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(firstBlocked.body.candidates as any[]).some((c) => c.provider_id === "prov-blocked"),
        "g3: blocklisted provider excluded from mode=first",
      );
      assertTrue(
        firstBlocked.body.suppressed_counts.blocklisted >= 1,
        "g4: mode=first suppressed_counts.blocklisted reflects it",
      );

      // ── (h) hard-bounced email, never contacted -> excluded from both ──
      mkOutreachReady({ id: "prov-bounced", navn: "Sprettet Gård", epost: "post@fixture-bounced.no" });
      mkHardBounce("post@fixture-bounced.no");

      const firstBounced = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(firstBounced.body.candidates as any[]).some((c) => c.provider_id === "prov-bounced"),
        "h1: hard-bounced provider excluded from mode=first",
      );
      assertTrue(
        firstBounced.body.suppressed_counts.hard_bounced >= 1,
        "h2: mode=first suppressed_counts.hard_bounced reflects it directly (never-contacted, so it reaches the bounce check)",
      );
      const secondBounced = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(secondBounced.body.candidates as any[]).some((c) => c.provider_id === "prov-bounced"),
        "h3: hard-bounced, never-contacted provider is ALSO excluded from mode=second (it is simply never a second-touch candidate at all — never contacted)",
      );

      // ── (i) readiness_tier !== outreach_ready -> excluded from both ────
      expDb
        .prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, epost, brreg_verified, catalog_hidden, producer_type,
              enrichment_state, verification_status, source, confidence, created_at)
           VALUES
             ('prov-thin', 'Tynn Gård', 'experiences', 'https://prov-thin.example.no',
              'post@fixture-thin.no', 0, 0, 'sideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
              '2026-01-01 00:00:00')`,
        )
        .run();

      const firstThin = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first" } });
      assertTrue(
        !(firstThin.body.candidates as any[]).some((c) => c.provider_id === "prov-thin"),
        "i1: needs_enrichment-tier provider excluded from mode=first",
      );
      const secondThin = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "second" } });
      assertTrue(
        !(secondThin.body.candidates as any[]).some((c) => c.provider_id === "prov-thin"),
        "i2: needs_enrichment-tier provider excluded from mode=second",
      );

      // ── (j) two providers sharing one email -> dedupe collapses to one ──
      mkOutreachReady({ id: "prov-dup-a", navn: "Dublett A Gård", epost: "post@fixture-dup.no", created_at: "2026-01-05 00:00:00" });
      mkOutreachReady({ id: "prov-dup-b", navn: "Dublett B Gård", epost: "post@fixture-dup.no", created_at: "2026-01-06 00:00:00" });

      const firstDup = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first", limit: "100" } });
      const dupCandidates = (firstDup.body.candidates as any[]).filter((c) => c.epost === "post@fixture-dup.no");
      assertEq(dupCandidates.length, 1, "j1: only ONE candidate survives for the shared email");
      assertTrue(
        firstDup.body.dedupe_suppressed_count >= 1,
        "j2: dedupe_suppressed_count reflects the collapsed duplicate",
      );
      assertEq(firstDup.body.dedupe_by_email, true, "j3: dedupe_by_email is reported true");

      // ── (k) limit clamping ──────────────────────────────────────────────
      // At this point in the fixture universe, mode=first's natural (un-
      // clamped) candidate set is exactly prov-never + the one dedupe
      // survivor from (j) = 2 candidates — small enough to directly assert
      // the LOWER clamp bound (limit=0 -> 1) against a known natural count
      // greater than 1. The UPPER bound (limit>100 -> capped at 100) is a
      // two-line Math.min/Math.max formula mirrored verbatim from
      // admin-outreach-candidates.ts's own (already-covered) clamp — building
      // >100 fixtures here to exercise it directly would be disproportionate
      // to what it tests, so it is verified by code inspection instead; this
      // block only confirms a large limit does not accidentally cap the
      // response BELOW the natural (small) candidate count.
      const naturalFirst = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first", limit: "500" } });
      const naturalCount = naturalFirst.body.candidates.length;
      assertTrue(naturalCount >= 2, "k1: sanity — at least 2 natural mode=first candidates exist at this point");
      assertEq(naturalFirst.body.count, naturalCount, "k2: limit=500 is not capped below the natural candidate count");

      const clampedLow = await callRoute(opplevelserRouter, { headers: auth, query: { mode: "first", limit: "0" } });
      assertEq(clampedLow.body.count, 1, "k3: limit=0 clamps to 1");
      assertEq(clampedLow.body.candidates.length, 1, "k4: exactly one candidate returned with limit=0");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-outreach-candidates: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS", prevSecondTouch);
      restore("OUTREACH_COOLDOWN_DAYS", prevCooldownDays);
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) {
          initMod.__setDbForTesting(prevRfbDb);
        }
      } catch {
        // best-effort cleanup
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

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-outreach-candidates.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOutreachCandidatesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
