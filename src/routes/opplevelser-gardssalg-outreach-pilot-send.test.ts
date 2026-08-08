/**
 * opplevelser-gardssalg-outreach-pilot-send.test.ts — tests for
 * POST /admin/gardssalg-outreach-pilot-send (src/routes/opplevelser.ts),
 * added for dev-request 2026-08-07-outreach-pool-krav123-og-pilot, AC4 (the
 * pilot send-mechanic).
 *
 * Mirrors opplevelser-booking-send-guard.test.ts's harness: a fresh
 * in-memory EXPERIENCES db (EXPERIENCES_DB_PATH=":memory:") via db-factory,
 * a fresh in-memory RFB db injected via database/init's
 * __setDbForTesting/__initSchemaForTesting (the SAME global singleton
 * routes/opplevelser.ts's own getRfbDb() reads — there is no per-module
 * seam for it the way services/gardssalg-claim.ts has, so the global
 * override is the only mechanism, per tests/test.ts's own documented DB
 * isolation contract), and a fake nodemailer transporter injected directly
 * onto the emailService singleton so every send assertion is made against
 * the REAL envelope that would leave the process (never a stub of
 * sendGardssalgOutreach/sendEmail itself, which would stub out the thing
 * under test).
 *
 * Covers:
 *   (a) auth: missing/wrong X-Admin-Key -> 403
 *   (b) batch-size guard: 0 provider_ids -> 400; 5 -> 400; 4 -> accepted
 *       (200, one result per id) — 1..4 is valid, only 0 and >4 rejected
 *   (c) preflight NO-GO -> skipped/preflight_no_go, zero send attempts
 *   (d) blocklist skip -> skipped/blocklisted (real agent_blocklist row via
 *       blocklist-service.addManualEntry, not a stub — isBlocked() reads
 *       the same RFB db this suite already controls)
 *   (e) own-table cooldown skip -> skipped/cooldown_suppressed,
 *       suppressed_by:"experiences", no cross_platform flag
 *   (f) cross-platform cooldown skip -> skipped/cooldown_suppressed,
 *       suppressed_by:<the other vertical_id>, cross_platform:true (seeded
 *       in the EXISTING RFB outreach_sent_log, vertical_id='rfb')
 *   (g) dry-run zero-write: apply absent -> would_send for an eligible row,
 *       but NEITHER experience_outreach_sent_log NOR the transporter is
 *       touched (before/after SELECT + sent-array length)
 *   (h) is_test passthrough: apply:true + is_test:true -> the real send
 *       boundary receives the TEST_SEND_REDIRECT_EMAIL address, not the
 *       real recipient; apply:true + is_test absent -> the real recipient
 *       is used, un-redirected
 *   (i) apply on an eligible row (real send boundary, mocked transporter)
 *       -> experience_outreach_sent_log gets exactly one new row with the
 *       right provider_id/recipient_email
 *   (j) AC10 regression (dev-request 2026-08-07-outreach-pool-krav123-og-pilot):
 *       a prior is_test:true send does NOT burn the real cooldown — a
 *       test-send against a candidate followed by a dry-run for the SAME
 *       candidate still reports would_send, not cooldown_suppressed
 *   (k) AC10 regression, other direction: a prior REAL (is_test:false) send
 *       still suppresses a later send to the same recipient within the
 *       cooldown window, so the AC10 fix doesn't silently disable cooldown
 *       altogether
 *
 * Exported runOpplevelserGardssalgOutreachPilotSendTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-pilot-send.test.ts
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
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/admin/gardssalg-outreach-pilot-send",
      originalUrl: "/admin/gardssalg-outreach-pilot-send",
      path: "/admin/gardssalg-outreach-pilot-send",
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

const VERIFIED_STAMP = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified" },
});

export function runOpplevelserGardssalgOutreachPilotSendTests(
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
    const prevRedirect = process.env.TEST_SEND_REDIRECT_EMAIL;
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-pilot-send-test-key";
    const REDIRECT = "daniel-test@example.no";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.OUTREACH_COOLDOWN_DAYS = "60";

    // NOTE: deliberately does NOT clear require.cache for "../database/init"
    // — that module's `db` singleton must stay the SAME instance every other
    // already-loaded (or not-yet-loaded) file resolves to; clearing it would
    // fork the module (a fresh instance for anything required after this
    // point) and desync it from __setDbForTesting()/__peekDbForTesting()
    // calls made through the canonical instance elsewhere in the same
    // process. Same convention opplevelser-booking-send-guard.test.ts and
    // routes/crm.test.ts already follow for exactly this reason.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const emailPath = require.resolve("../services/email-service");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, emailPath, blocklistPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;
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

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fake transport at the REAL send boundary ──────────────────────
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      let sent: Array<Record<string, any>> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          sent.push(mailOptions);
          return { messageId: `stub-${sent.length}` };
        },
      };

      // ── Provider fixtures ────────────────────────────────────────────
      // GO-tier (outreach_ready): has_website, has_about_text, has_products,
      // brreg_verified, has_email, not catalog_hidden, has a slug
      // (is_searchable), website_verified (VERIFIED_STAMP), no duplicate
      // conflict. Distinct email domains per fixture so
      // dedupeGardssalgOutreachRecipients (Slice 2 outreach-guard) never
      // cross-suppresses two of these fixtures inside the same batch.
      const insertGo = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, vertical, hjemmeside, epost, about_text, products, brreg_verified,
           catalog_hidden, slug, field_provenance, producer_type,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, 'experiences', @hjemmeside, @epost, 'En fin gård.', 'Cider, sider', 1,
           0, @slug, @field_provenance, 'sideri',
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertGo.run({
        id: "prov-alpha", navn: "Alpha Gård",
        hjemmeside: "https://alpha-gard.example.no", epost: "post@fixture-alpha.no",
        slug: "alpha-gard", field_provenance: VERIFIED_STAMP,
      });
      insertGo.run({
        id: "prov-beta", navn: "Beta Gård",
        hjemmeside: "https://beta-gard.example.no", epost: "post@fixture-beta.no",
        slug: "beta-gard", field_provenance: VERIFIED_STAMP,
      });
      insertGo.run({
        id: "prov-gamma", navn: "Gamma Gård",
        hjemmeside: "https://gamma-gard.example.no", epost: "post@fixture-gamma.no",
        slug: "gamma-gard", field_provenance: VERIFIED_STAMP,
      });
      insertGo.run({
        id: "prov-delta", navn: "Delta Gård",
        hjemmeside: "https://delta-gard.example.no", epost: "post@fixture-delta.no",
        slug: "delta-gard", field_provenance: VERIFIED_STAMP,
      });
      insertGo.run({
        id: "prov-foxtrot", navn: "Foxtrot Gård",
        hjemmeside: "https://foxtrot-gard.example.no", epost: "post@fixture-foxtrot.no",
        slug: "foxtrot-gard", field_provenance: VERIFIED_STAMP,
      });
      insertGo.run({
        id: "prov-hotel", navn: "Hotel Gård",
        hjemmeside: "https://hotel-gard.example.no", epost: "post@fixture-hotel.no",
        slug: "hotel-gard", field_provenance: VERIFIED_STAMP,
      });

      // NO-GO tier: needs_enrichment (no about_text/products/brreg_verified).
      expDb
        .prepare(`
          INSERT INTO experience_providers
            (id, navn, vertical, hjemmeside, epost, brreg_verified, catalog_hidden, producer_type,
             enrichment_state, verification_status, source, confidence)
          VALUES
            ('prov-echo', 'Echo Gård', 'experiences', 'https://echo-gard.example.no',
             'post@fixture-echo.no', 0, 0, 'sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')
        `)
        .run();

      const auth = { "x-admin-key": testKey };

      // ── (a) auth ─────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: { provider_ids: ["prov-alpha"] } });
      assertEq(noKey.status, 403, "a1: no X-Admin-Key -> 403");
      const badKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "wrong-key" }, body: { provider_ids: ["prov-alpha"] },
      });
      assertEq(badKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) batch-size guard ────────────────────────────────────────
      const zeroIds = await callRoute(opplevelserRouter, { headers: auth, body: { provider_ids: [] } });
      assertEq(zeroIds.status, 400, "b1: 0 provider_ids -> 400");

      const fiveIds = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["a", "b", "c", "d", "e"] },
      });
      assertEq(fiveIds.status, 400, "b2: 5 provider_ids -> 400");

      const fourIds = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_ids: ["prov-alpha", "prov-beta", "prov-gamma", "prov-delta"] },
      });
      assertEq(fourIds.status, 200, "b3: 4 provider_ids -> 200 (accepted, proceeds to processing)");
      assertEq(fourIds.body.results?.length, 4, "b4: one result per requested id");
      assertEq(fourIds.body.dry_run, true, "b5: apply absent -> dry_run true");
      assertTrue(
        (fourIds.body.results as any[]).every((r) => r.status === "would_send"),
        "b6: all 4 GO-tier, unblocked, un-cooled-down rows report would_send in dry-run",
      );
      assertEq(sent.length, 0, "b7: dry-run sent no email");

      // ── (c) preflight NO-GO ─────────────────────────────────────────
      const sentBeforeNoGo = sent.length;
      const noGo = await callRoute(opplevelserRouter, { headers: auth, body: { provider_ids: ["prov-echo"] } });
      assertEq(noGo.status, 200, "c1: NO-GO request -> 200 (reported, not rejected)");
      assertEq(noGo.body.results[0].status, "skipped", "c2: NO-GO row status is skipped");
      assertEq(noGo.body.results[0].reason, "preflight_no_go", "c3: reason is preflight_no_go");
      assertEq(noGo.body.results[0].preflight_reason, "needs_enrichment", "c4: preflight_reason names the readiness tier");
      assertEq(sent.length, sentBeforeNoGo, "c5: NO-GO row triggers zero send attempts");

      // ── (d) blocklist skip ───────────────────────────────────────────
      blocklistSvc.addManualEntry({ identifierType: "email", identifierValue: "post@fixture-beta.no" });
      const blocked = await callRoute(opplevelserRouter, { headers: auth, body: { provider_ids: ["prov-beta"] } });
      assertEq(blocked.status, 200, "d1: blocklisted row -> 200");
      assertEq(blocked.body.results[0].status, "skipped", "d2: blocklisted row status is skipped");
      assertEq(blocked.body.results[0].reason, "blocklisted", "d3: reason is blocklisted");
      assertEq(sent.length, sentBeforeNoGo, "d4: blocklisted row triggers zero send attempts");

      // ── (e) own-table cooldown skip ──────────────────────────────────
      expDb
        .prepare(
          `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, is_test)
           VALUES ('prov-gamma-prior', 'post@fixture-gamma.no', datetime('now', '-2 days'), 'email', 0)`,
        )
        .run();
      const ownCooldown = await callRoute(opplevelserRouter, { headers: auth, body: { provider_ids: ["prov-gamma"] } });
      assertEq(ownCooldown.status, 200, "e1: own-table cooldown row -> 200");
      assertEq(ownCooldown.body.results[0].status, "skipped", "e2: status is skipped");
      assertEq(ownCooldown.body.results[0].reason, "cooldown_suppressed", "e3: reason is cooldown_suppressed");
      assertEq(ownCooldown.body.results[0].suppressed_by, "experiences", "e4: suppressed_by names this vertical");
      assertTrue(!ownCooldown.body.results[0].cross_platform, "e5: not flagged cross_platform");
      assertTrue(!!ownCooldown.body.results[0].last_sent_at, "e6: last_sent_at is populated");

      // ── (f) cross-platform cooldown skip ─────────────────────────────
      rfbDb
        .prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
           VALUES ('agent-fixture-delta', 'Fixture Agent Delta', 'x', 'test', 'agent-delta@example.no', 'https://example.no', 'producer', 'fixture-key-delta', 1)`,
        )
        .run();
      rfbDb
        .prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
           VALUES ('agent-fixture-delta', 'post@fixture-delta.no', datetime('now', '-2 days'), 'email', 'rfb')`,
        )
        .run();
      const crossCooldown = await callRoute(opplevelserRouter, { headers: auth, body: { provider_ids: ["prov-delta"] } });
      assertEq(crossCooldown.status, 200, "f1: cross-platform cooldown row -> 200");
      assertEq(crossCooldown.body.results[0].status, "skipped", "f2: status is skipped");
      assertEq(crossCooldown.body.results[0].reason, "cooldown_suppressed", "f3: reason is cooldown_suppressed");
      assertEq(crossCooldown.body.results[0].suppressed_by, "rfb", "f4: suppressed_by names the OTHER vertical (rfb)");
      assertEq(crossCooldown.body.results[0].cross_platform, true, "f5: flagged cross_platform:true");

      // ── (g) dry-run zero-write for an eligible row ───────────────────
      const beforeLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;
      const sentBeforeDryRun = sent.length;
      const dryRunEligible = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-alpha"] },
      });
      assertEq(dryRunEligible.status, 200, "g1: dry-run on eligible row -> 200");
      assertEq(dryRunEligible.body.dry_run, true, "g2: dry_run true (apply absent)");
      assertEq(dryRunEligible.body.results[0].status, "would_send", "g3: eligible row reports would_send");
      const afterLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;
      assertEq(afterLogCount, beforeLogCount, "g4: NO new experience_outreach_sent_log row was written");
      assertEq(sent.length, sentBeforeDryRun, "g5: NO email left the send boundary");

      // ── (h) is_test passthrough ───────────────────────────────────────
      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;
      sent = [];
      const testSend = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-alpha"], apply: true, is_test: true },
      });
      assertEq(testSend.status, 200, "h1: apply+is_test -> 200");
      assertEq(testSend.body.dry_run, false, "h2: dry_run false (apply:true)");
      assertEq(testSend.body.results[0].status, "sent", "h3: reports sent");
      assertEq(sent.length, 1, "h4: exactly one email left the boundary");
      assertEq(sent[0].to, REDIRECT, "h5: is_test:true redirects to TEST_SEND_REDIRECT_EMAIL");
      assertTrue(
        !JSON.stringify(sent[0].to).includes("post@fixture-alpha.no"),
        "h6: the real recipient is NOT in the envelope's `to`",
      );
      const testLogRow = expDb
        .prepare(
          `SELECT is_test, recipient_email, provider_id FROM experience_outreach_sent_log
            WHERE provider_id = 'prov-alpha' ORDER BY id DESC LIMIT 1`,
        )
        .get() as any;
      assertEq(testLogRow.is_test, 1, "h7: the logged row is flagged is_test=1");
      assertEq(testLogRow.recipient_email, "post@fixture-alpha.no", "h8: the logged row records the REAL recipient email, not the redirect address");

      // Non-test apply on a fresh eligible row -> real recipient, un-redirected.
      sent = [];
      const realSend = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-foxtrot"], apply: true },
      });
      assertEq(realSend.status, 200, "h9: apply without is_test -> 200");
      assertEq(realSend.body.results[0].status, "sent", "h10: reports sent");
      assertEq(sent.length, 1, "h11: exactly one email left the boundary");
      assertEq(sent[0].to, "post@fixture-foxtrot.no", "h12: without is_test, the REAL recipient is used, not the redirect address");
      assertTrue(!String(sent[0].subject || "").startsWith("[TESTSENDING]"), "h13: subject is not marked as a test send");

      // ── (i) apply writes exactly one row for the eligible provider ──
      const foxtrotRows = expDb
        .prepare(`SELECT provider_id, recipient_email FROM experience_outreach_sent_log WHERE provider_id = 'prov-foxtrot'`)
        .all() as any[];
      assertEq(foxtrotRows.length, 1, "i1: exactly one experience_outreach_sent_log row for prov-foxtrot");
      assertEq(foxtrotRows[0].provider_id, "prov-foxtrot", "i2: correct provider_id");
      assertEq(foxtrotRows[0].recipient_email, "post@fixture-foxtrot.no", "i3: correct recipient_email");

      // ── (j) AC10: a prior test-send must NOT burn the real cooldown ─────
      // prov-alpha already got an apply:true + is_test:true send in block
      // (h) above, which wrote an is_test=1 row to experience_outreach_sent_log
      // for post@fixture-alpha.no. Before the AC10 fix, the own-table
      // cooldown SELECT had no `is_test = 0` filter, so that test-send row
      // would wrongly suppress this next (real) request for 60 days. After
      // the fix it must still report would_send.
      sent = [];
      const dryRunAfterTestSend = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-alpha"] },
      });
      assertEq(dryRunAfterTestSend.status, 200, "j1: dry-run after a prior test-send -> 200");
      assertEq(
        dryRunAfterTestSend.body.results[0].status,
        "would_send",
        "j2: a prior is_test=1 row does NOT suppress a subsequent dry-run/send for the same recipient (AC10)",
      );
      assertTrue(
        !dryRunAfterTestSend.body.results[0].reason,
        "j3: no cooldown_suppressed (or any other skip) reason is present",
      );
      assertEq(sent.length, 0, "j4: dry-run still sends no email");

      // ── (k) AC10 regression: a prior REAL send still enforces cooldown ──
      // Same shape as (j) but with is_test:false (the default) both times,
      // to prove the AC10 fix narrows the cooldown check to real sends only
      // rather than accidentally disabling the own-table cooldown outright.
      sent = [];
      const hotelRealSend = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-hotel"], apply: true },
      });
      assertEq(hotelRealSend.status, 200, "k1: real (non-test) send on prov-hotel -> 200");
      assertEq(hotelRealSend.body.results[0].status, "sent", "k2: reports sent");
      assertEq(sent.length, 1, "k3: exactly one email left the boundary");

      const hotelCooldown = await callRoute(opplevelserRouter, {
        headers: auth, body: { provider_ids: ["prov-hotel"] },
      });
      assertEq(hotelCooldown.status, 200, "k4: subsequent request for prov-hotel -> 200");
      assertEq(
        hotelCooldown.body.results[0].status,
        "skipped",
        "k5: a prior REAL (is_test=0) send still suppresses a later send within the cooldown window",
      );
      assertEq(hotelCooldown.body.results[0].reason, "cooldown_suppressed", "k6: reason is cooldown_suppressed");
      assertEq(hotelCooldown.body.results[0].suppressed_by, "experiences", "k7: suppressed_by is this vertical (own-table)");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-outreach-pilot-send: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("TEST_SEND_REDIRECT_EMAIL", prevRedirect);
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

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-outreach-pilot-send.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOutreachPilotSendTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
