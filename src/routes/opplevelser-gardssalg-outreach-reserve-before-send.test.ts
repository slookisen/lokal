/**
 * opplevelser-gardssalg-outreach-reserve-before-send.test.ts — regression
 * tests for the 2026-09-27/28 double send on the gårdssalg outreach lane
 * (src/routes/opplevelser.ts: sendGardssalgOutreachToEligibleProvider, the
 * runGardssalgOutreachDaily loop, the POST /admin/gardssalg-outreach-pilot-
 * send loop).
 *
 * The incident: on 2026-09-27 the prod SQLite volume was full, so the
 * experience_outreach_sent_log INSERT — which ran only AFTER each send —
 * threw for all six already-delivered mails. They were reported as errors,
 * no row set a cooldown or counted toward the daily budget, and on
 * 2026-09-28 the daily job mailed the same six producers again. The fix
 * reserves the sent_log row BEFORE sending and confirms it afterwards; a DB
 * that is not taking writes can cost a send, never duplicate one.
 *
 * Same harness as opplevelser-gardssalg-outreach-daily-run.test.ts: fresh
 * in-memory EXPERIENCES db, fresh in-memory RFB db via database/init's
 * __setDbForTesting, and a fake nodemailer transporter injected onto the
 * emailService singleton. DB failures are forced at the real seam — SQLite
 * BEFORE INSERT/UPDATE/DELETE triggers that RAISE(ABORT) on
 * experience_outreach_sent_log — so the route's own SQL statements fail
 * exactly as they did on the full volume, nothing about the DB is stubbed.
 *
 * Covers:
 *   (a) reservation INSERT throws -> the send is NEVER attempted, the row is
 *       error + db_write_failed, the daily loop stops after the first
 *       candidate (the rest are skipped/not_attempted), the envelope carries
 *       the reason; the next day's run then mails each producer exactly once
 *       (the incident replayed: with the old post-send INSERT every producer
 *       was mailed on both days)
 *   (b) reservation OK, send OK, confirm UPDATE throws -> sent +
 *       log_recorded:false; the reservation row keeps cooldown AND daily
 *       budget, so the next day's run does NOT select that producer again
 *   (c) send returns success:false -> the reservation is released and the
 *       provider stays eligible; if the release DELETE itself throws, the row
 *       is kept (fail-closed) and flagged db_write_failed + reservation_kept
 *   (d) send throws (outcome unknown) -> the reservation is kept
 *   (e) happy path unchanged: row confirmed with message_id, log_recorded
 *       true, CRM filed, clean envelope (no errors, unchanged notes)
 *   (f) POST /admin/gardssalg-outreach-pilot-send stops at a db_write_failed
 *       row too; an ineligible id keeps its own skip reason
 *
 * Exported runOpplevelserGardssalgOutreachReserveBeforeSendTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-reserve-before-send.test.ts
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
  opts: { method?: string; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method ?? "POST";
    const url = opts.url ?? "/admin/gardssalg-outreach-pilot-send";
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

const VERIFIED_PROVENANCE = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
});
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

export function runOpplevelserGardssalgOutreachReserveBeforeSendTests(
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
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const prevMaxCandidates = process.env.DAILY_PREP_MAX_CANDIDATES;
    const prevDisabled = process.env.GARDSSALG_OUTREACH_DAILY_DISABLED;
    // runGardssalgOutreachDaily runs the autosvar-apply pass too; unset so its
    // LLM contact gate could only ever fail closed, never make a network call
    // (same belt-and-suspenders as the daily-run suite — no autosvar fixture
    // exists here, so the pass has no candidates anyway).
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-reserve-before-send-test-key";

    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.OUTREACH_COOLDOWN_DAYS = "60";
    delete process.env.DAILY_PREP_MAX_CANDIDATES; // default cap = 4
    delete process.env.GARDSSALG_OUTREACH_DAILY_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;

    // Same cache-clear set as the daily-run suite (see its comment on why
    // experience-store is in it); database/init is deliberately NOT cleared.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const emailPath = require.resolve("../services/email-service");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, emailPath, blocklistPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;
    let prevRfbDb: any = null;
    let expDbRef: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        // config already loaded / not needed
      }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expDbRef = expDb;

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserMod.default as any;
      const {
        runGardssalgOutreachDaily,
        sendGardssalgOutreachToEligibleProvider,
        computeGardssalgOutreachSendEligibility,
        countGardssalgOutreachSentToday,
        GARDSSALG_OUTREACH_SENT_LOG_RESERVED_NOTE,
        GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON,
      } = opplevelserMod;

      // ── Fake transport at the REAL send boundary ────────────────────────
      // `sent` = mail that left the building; `transportAttempts` also counts
      // the ones the transport rejected (mode "reject" -> sendEmail reports
      // success:false, the only way a real transport error surfaces).
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      const sent: Array<Record<string, any>> = [];
      let transportAttempts = 0;
      let transportMode: "ok" | "reject" = "ok";
      let stubMessageSeq = 0;
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          transportAttempts += 1;
          if (transportMode === "reject") throw new Error("simulated Resend rejection (422)");
          sent.push(mailOptions);
          stubMessageSeq += 1;
          return { messageId: `stub-reserve-${stubMessageSeq}` };
        },
      };
      // Spy (not a stub — the real method still runs) so "the send was never
      // attempted" is asserted at the service boundary, not just the transport.
      let serviceCalls = 0;
      const realSendGardssalgOutreach = emailSvc.sendGardssalgOutreach;
      const spySendGardssalgOutreach = function (this: unknown, ...args: unknown[]) {
        serviceCalls += 1;
        return realSendGardssalgOutreach.apply(emailSvc, args);
      };
      emailSvc.sendGardssalgOutreach = spySendGardssalgOutreach;

      // ── Fixtures: full outreach_ready rows (same shape as the daily-run
      // suite), distinct email domains so the recipient-domain dedupe never
      // collapses two of them. Inserted per block so each block's daily run
      // selects exactly the providers it is about (earlier ones sit in
      // cooldown by then). Selection order is plain id ascending.
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte, naeringskode,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, 'Voss', 'rfb-seed', 'sideri',
            @epost, NULL, @hjemmeside, @about_text, NULL, NULL,
            'Sider, eplemost', 'provider_site', 0, 0, @slug, @field_provenance,
            1, 4, NULL,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const emailOf = (n: number) => `post@reserve-sideri-${n}.no`;
      const mkProvider = (n: number): string => {
        const id = `prov-rbs-${String(n).padStart(2, "0")}`;
        insertProvider.run({
          id,
          navn: `Reserve Sideri ${n}`,
          org_nr: String(300000000 + n),
          epost: emailOf(n),
          hjemmeside: `https://reserve-sideri-${n}.no`,
          about_text: REALISTIC_ABOUT_TEXT,
          slug: `reserve-sideri-${n}`,
          field_provenance: VERIFIED_PROVENANCE,
        });
        return id;
      };

      // Budget days strictly AFTER the real today: sent_at is the real clock
      // (column DEFAULT), so a run dated day k>0 starts with a full budget no
      // matter when this suite runs, while the cooldown (also real clock)
      // holds for every row written here.
      const dayAhead = (k: number): Date => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + k);
        d.setUTCHours(8, 10, 0, 0);
        return d;
      };

      const failSentLogWrites = (...ops: Array<"INSERT" | "UPDATE" | "DELETE">) => {
        for (const op of ops) {
          expDb.exec(
            `CREATE TRIGGER test_fail_sent_log_${op.toLowerCase()} BEFORE ${op} ON experience_outreach_sent_log
             BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated ${op})'); END`,
          );
        }
      };
      const healSentLogWrites = () => {
        for (const op of ["insert", "update", "delete"]) expDb.exec(`DROP TRIGGER IF EXISTS test_fail_sent_log_${op}`);
      };

      const logRowsFor = (providerId: string) =>
        expDb
          .prepare(
            `SELECT provider_id, recipient_email, message_id, notes, is_test FROM experience_outreach_sent_log
              WHERE provider_id = ? ORDER BY id`,
          )
          .all(providerId) as Array<{ provider_id: string; recipient_email: string; message_id: string | null; notes: string | null; is_test: number }>;
      const sentLogCount = () =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_outreach_sent_log`).get() as { n: number }).n;
      const mailsTo = (address: string) => sent.filter((m) => String(m.to) === address).length;
      const eligibilityOf = (providerId: string) => computeGardssalgOutreachSendEligibility(expDb, [providerId])[0];
      const envelopeOf = (runId: string) =>
        rfbDb.prepare(`SELECT status, claims, notes, errors FROM runs WHERE run_id = ?`).get(runId) as
          | { status: string; claims: string; notes: string; errors: string | null }
          | undefined;
      const auth = { "x-admin-key": testKey };

      // ── (a) reservation INSERT throws: nothing is sent, the loop stops ──
      const a1 = mkProvider(1);
      const a2 = mkProvider(2);
      const a3 = mkProvider(3);
      failSentLogWrites("INSERT", "UPDATE"); // the DB takes no sent_log write at all, as on 2026-09-27
      const dayA = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(1) });
      healSentLogWrites();
      assertEq(dayA.candidates.map((c) => c.provider_id), [a1, a2, a3], "a1: all three producers were selected");
      assertEq(serviceCalls, 0, "a2: emailService.sendGardssalgOutreach was NEVER called");
      assertEq(transportAttempts, 0, "a3: nothing reached the transport");
      assertEq(dayA.results[0]?.status, "error", "a4: first candidate -> error");
      assertEq(dayA.results[0]?.db_write_failed, true, "a5: ...flagged db_write_failed");
      assertTrue(
        String(dayA.results[0]?.reason).startsWith("sent_log_reservation_failed: disk I/O error (simulated INSERT)"),
        "a6: ...reason names the failed reservation and the DB error",
      );
      assertEq(dayA.results[0]?.reservation_kept, undefined, "a7: ...no reservation_kept (none was ever made)");
      assertEq(
        dayA.results.slice(1).map((r) => [r.provider_id, r.status, r.reason]),
        [
          [a2, "skipped", GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON],
          [a3, "skipped", GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON],
        ],
        "a8: the loop stopped after the first candidate; the rest are reported not attempted",
      );
      assertEq(dayA.stopped_on_db_write_failure, true, "a9: report.stopped_on_db_write_failure");
      assertEq(dayA.errors.map((e) => [e.provider_id, e.status]), [[a1, "error"]], "a10: report.errors lists the failed candidate");
      assertEq(dayA.log_not_recorded, 0, "a11: log_not_recorded = 0");
      assertEq(sentLogCount(), 0, "a12: no sent_log row exists");
      const envA = envelopeOf(dayA.run_id);
      assertEq(envA?.status, "failed", "a13: envelope status failed (unchanged rule: errors, nothing sent)");
      const envAErrors = JSON.parse(envA?.errors ?? "null") as Array<{ message: string; meta?: Record<string, unknown> }> | null;
      assertTrue(
        !!envAErrors && envAErrors[0].message.startsWith("sent_log_reservation_failed:") && envAErrors[0].meta?.provider_id === a1,
        "a14: envelope `errors` carries the per-candidate reason",
      );
      assertEq(envAErrors?.[1]?.meta?.not_attempted, [a2, a3], "a15: envelope `errors` names the candidates left untried");
      assertTrue(
        String(envA?.notes).includes("STOPPED (sent_log write failed): not_attempted=2"),
        "a16: envelope notes flag the stop",
      );

      // The next day, DB healthy again: every producer is mailed exactly
      // once. This is the incident replayed end to end — with the old
      // post-send INSERT, day A had mailed all three and logged none, so this
      // run would have mailed all three a second time.
      const dayA2 = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(2) });
      assertEq(dayA2.candidates.map((c) => c.provider_id), [a1, a2, a3], "a17: next day: all three still eligible (nothing was burned)");
      assertEq(dayA2.summary.sent, 3, "a18: next day: all three sent");
      assertEq([mailsTo(emailOf(1)), mailsTo(emailOf(2)), mailsTo(emailOf(3))], [1, 1, 1], "a19: each producer received exactly ONE mail across both days");
      assertEq(
        [a1, a2, a3].map((id) => logRowsFor(id).map((r) => [r.notes, r.message_id !== null])),
        [[[null, true]], [[null, true]], [[null, true]]],
        "a20: one confirmed row per producer (message_id set, reservation marker cleared)",
      );

      // ── (b) confirm UPDATE throws AFTER a successful send ──────────────
      // The spec'd regression test for 2026-09-27/28: the mail left, the log
      // write after it failed — the next day's run must NOT select it again.
      const b4 = mkProvider(4);
      const b5 = mkProvider(5);
      const b6 = mkProvider(6);
      const sentTodayBeforeB = countGardssalgOutreachSentToday(expDb, new Date());
      const serviceCallsBeforeB = serviceCalls;
      failSentLogWrites("UPDATE");
      const dayB = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(4) });
      healSentLogWrites();
      assertEq(dayB.candidates.map((c) => c.provider_id), [b4, b5, b6], "b1: three fresh producers selected");
      assertEq(serviceCalls - serviceCallsBeforeB, 1, "b2: exactly one send attempted");
      assertEq(mailsTo(emailOf(4)), 1, "b3: the mail DID go out");
      const rowB4 = dayB.results[0];
      assertEq(rowB4?.status, "sent", "b4: reported sent — not error — so nothing invites a retry");
      assertEq(rowB4?.log_recorded, false, "b5: log_recorded:false");
      assertEq(rowB4?.db_write_failed, true, "b6: db_write_failed (the DB refused a write)");
      assertTrue(String(rowB4?.reason).startsWith("sent_log_update_failed: disk I/O error (simulated UPDATE)"), "b7: reason names the failed confirm");
      assertEq(rowB4?.crm_recorded, true, "b8: CRM filing after the successful send is unchanged");
      assertEq(
        logRowsFor(b4).map((r) => [r.notes, r.message_id, r.is_test, r.recipient_email]),
        [[GARDSSALG_OUTREACH_SENT_LOG_RESERVED_NOTE, null, 0, emailOf(4)]],
        "b9: the reservation row is still there (real send, message_id missing)",
      );
      assertEq(
        dayB.results.slice(1).map((r) => [r.provider_id, r.status, r.reason]),
        [
          [b5, "skipped", GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON],
          [b6, "skipped", GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON],
        ],
        "b10: loop stopped after the failed write",
      );
      assertEq(dayB.log_not_recorded, 1, "b11: report.log_not_recorded = 1");
      assertEq(dayB.errors.map((e) => [e.provider_id, e.status]), [[b4, "sent"]], "b12: report.errors lists it, with status sent");
      assertEq(
        countGardssalgOutreachSentToday(expDb, new Date()),
        sentTodayBeforeB + 1,
        "b13: the reservation counts toward today's daily budget",
      );
      const eligB4 = eligibilityOf(b4);
      assertEq([eligB4?.eligible, eligB4?.eligible === false ? eligB4.reason : null], [false, "cooldown_suppressed"], "b14: ...and sets the cooldown");
      const envB = envelopeOf(dayB.run_id);
      const envBClaims = JSON.parse(envB?.claims ?? "[]") as Array<{ type: string; value: number; meta?: Record<string, unknown> }>;
      assertEq([envBClaims[0]?.value, envBClaims[0]?.meta?.provider_ids], [1, [b4]], "b15: envelope still claims the delivered mail");
      assertTrue(String(envB?.notes).includes("log_not_recorded=1"), "b16: envelope notes carry log_not_recorded");
      const envBErrors = JSON.parse(envB?.errors ?? "null") as Array<{ message: string; meta?: Record<string, unknown> }> | null;
      assertTrue(
        !!envBErrors && envBErrors[0].message.startsWith("sent_log_update_failed:") && envBErrors[0].meta?.status === "sent",
        "b17: envelope `errors` carries the confirm failure, marked status sent",
      );

      const dayB2 = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(5) });
      assertEq(dayB2.candidates.map((c) => c.provider_id), [b5, b6], "b18: next day: the producer already mailed is NOT selected again");
      assertEq(mailsTo(emailOf(4)), 1, "b19: still exactly ONE mail to that producer");
      assertEq([mailsTo(emailOf(5)), mailsTo(emailOf(6))], [1, 1], "b20: the two left untried are mailed the next day");

      // ── (c) send returns success:false -> reservation released ─────────
      const c7 = mkProvider(7);
      transportMode = "reject";
      const attemptsBeforeC = transportAttempts;
      const dayC = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(7) });
      assertEq(dayC.candidates.map((c) => c.provider_id), [c7], "c1: the fresh producer selected");
      assertEq(transportAttempts - attemptsBeforeC, 1, "c2: the send was attempted");
      assertEq(dayC.results[0]?.status, "error", "c3: rejected send -> error");
      assertEq(dayC.results[0]?.reason, "simulated Resend rejection (422)", "c4: reason is the transport's own error, unchanged");
      assertEq([dayC.results[0]?.db_write_failed, dayC.results[0]?.reservation_kept], [undefined, undefined], "c5: no db/reservation flags");
      assertEq(logRowsFor(c7).length, 0, "c6: the reservation was released (no row)");
      assertEq(eligibilityOf(c7)?.eligible, true, "c7: the provider is eligible again");
      assertEq(dayC.stopped_on_db_write_failure, false, "c8: a rejected send does not stop the loop");

      // ...and if releasing it fails, the row stays: fail-closed.
      const eligC7 = eligibilityOf(c7);
      failSentLogWrites("DELETE");
      const rowC7 =
        eligC7 && eligC7.eligible
          ? await sendGardssalgOutreachToEligibleProvider(expDb, eligC7, {
              template: "personal",
              isTest: false,
              source: "reserve-before-send-test",
            })
          : null;
      healSentLogWrites();
      transportMode = "ok";
      assertEq(rowC7?.status, "error", "c9: release failure -> still error (nothing was sent)");
      assertTrue(
        String(rowC7?.reason).startsWith("simulated Resend rejection (422); sent_log_release_failed: disk I/O error (simulated DELETE)"),
        "c10: reason carries both the send error and the release failure",
      );
      assertEq([rowC7?.db_write_failed, rowC7?.reservation_kept], [true, true], "c11: db_write_failed + reservation_kept");
      assertEq(logRowsFor(c7).map((r) => r.notes), [GARDSSALG_OUTREACH_SENT_LOG_RESERVED_NOTE], "c12: the reservation row stays");
      assertEq(eligibilityOf(c7)?.eligible, false, "c13: ...so the provider sits in cooldown (fail-closed)");
      assertEq(mailsTo(emailOf(7)), 0, "c14: no mail ever reached that producer");

      // ── (d) send THROWS (outcome unknown) -> reservation kept ──────────
      // sendEmail converts every transport error into success:false, so a
      // throw can only be forced by replacing the service method itself.
      const d8 = mkProvider(8);
      emailSvc.sendGardssalgOutreach = async () => {
        throw new Error("socket hang up (simulated)");
      };
      let dayD: Awaited<ReturnType<typeof runGardssalgOutreachDaily>>;
      try {
        dayD = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(8) });
      } finally {
        emailSvc.sendGardssalgOutreach = spySendGardssalgOutreach;
      }
      assertEq(dayD.candidates.map((c) => c.provider_id), [d8], "d1: the fresh producer selected");
      assertEq(dayD.results[0]?.status, "error", "d2: throwing send -> error");
      assertEq(dayD.results[0]?.reason, "send_outcome_unknown: socket hang up (simulated)", "d3: reason says the outcome is unknown");
      assertEq([dayD.results[0]?.reservation_kept, dayD.results[0]?.db_write_failed], [true, undefined], "d4: reservation_kept, no db flag");
      assertEq(
        logRowsFor(d8).map((r) => [r.notes, r.message_id, r.is_test]),
        [[GARDSSALG_OUTREACH_SENT_LOG_RESERVED_NOTE, null, 0]],
        "d5: the reservation row is kept",
      );
      const eligD8 = eligibilityOf(d8);
      assertEq([eligD8?.eligible, eligD8?.eligible === false ? eligD8.reason : null], [false, "cooldown_suppressed"], "d6: the provider sits in cooldown");

      // ── (e) happy path unchanged ────────────────────────────────────────
      const e9 = mkProvider(9);
      const dayE = await runGardssalgOutreachDaily({ apply: true, trigger: "manual", now: dayAhead(10) });
      assertEq(dayE.candidates.map((c) => c.provider_id), [e9], "e1: the fresh producer selected");
      const rowE9 = dayE.results[0];
      assertEq(
        [rowE9?.status, rowE9?.log_recorded, rowE9?.crm_recorded],
        ["sent", true, true],
        "e2: sent, log_recorded:true, CRM-filed",
      );
      assertEq(
        [rowE9?.reason, rowE9?.db_write_failed, rowE9?.reservation_kept],
        [undefined, undefined, undefined],
        "e3: no reason / failure flags on a clean send",
      );
      assertEq(mailsTo(emailOf(9)), 1, "e4: exactly one mail");
      const rowsE9 = logRowsFor(e9);
      assertEq(rowsE9.length, 1, "e5: exactly one sent_log row");
      assertTrue(/^stub-reserve-\d+$/.test(String(rowsE9[0]?.message_id)), "e6: the row carries the Resend message_id");
      assertEq([rowsE9[0]?.notes, rowsE9[0]?.is_test], [null, 0], "e7: reservation marker cleared, real send");
      const crmThreadE9 = rfbDb.prepare(`SELECT vertical_id FROM crm_threads WHERE id = ?`).get(`opplevagent-outreach-${e9}`) as
        | { vertical_id: string }
        | undefined;
      assertEq(crmThreadE9?.vertical_id, "experiences", "e8: the CRM thread was filed");
      assertEq(
        [dayE.errors, dayE.log_not_recorded, dayE.stopped_on_db_write_failure],
        [[], 0, false],
        "e9: report carries no errors / log gaps / stop",
      );
      const envE = envelopeOf(dayE.run_id);
      assertEq(envE?.status, "completed", "e10: envelope completed");
      assertEq(envE?.errors, null, "e11: envelope `errors` absent on a clean run");
      assertTrue(
        !String(envE?.notes).includes("STOPPED") && !String(envE?.notes).includes("log_not_recorded"),
        "e12: clean-run notes unchanged",
      );

      // ── (f) pilot-send route stops at a db_write_failed row too ────────
      const f10 = mkProvider(10);
      const f11 = mkProvider(11);
      const serviceCallsBeforeF = serviceCalls;
      failSentLogWrites("INSERT");
      const pilot = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_ids: [f10, f11, b4], apply: true },
      });
      healSentLogWrites();
      assertEq(pilot.status, 200, "f1: pilot-send -> 200 (per-row outcomes, not a 500)");
      const pr = (pilot.body?.results ?? []) as Array<Record<string, any>>;
      assertEq([pr[0]?.provider_id, pr[0]?.status, pr[0]?.db_write_failed], [f10, "error", true], "f2: first id -> error + db_write_failed");
      assertTrue(String(pr[0]?.reason).startsWith("sent_log_reservation_failed:"), "f3: ...with the reservation reason");
      assertEq([pr[1]?.provider_id, pr[1]?.status, pr[1]?.reason], [f11, "skipped", GARDSSALG_OUTREACH_NOT_ATTEMPTED_REASON], "f4: next eligible id not attempted");
      assertEq([pr[2]?.provider_id, pr[2]?.status, pr[2]?.reason], [b4, "skipped", "cooldown_suppressed"], "f5: an ineligible id keeps its own reason");
      assertEq(serviceCalls - serviceCallsBeforeF, 0, "f6: no send attempted");
      assertEq([logRowsFor(f10).length, logRowsFor(f11).length], [0, 0], "f7: no rows written");
    } catch (err) {
      failed++;
      failures.push(`✗ harness error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      if (log) console.log(`  ✗ harness error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        if (expDbRef) {
          for (const op of ["insert", "update", "delete"]) expDbRef.exec(`DROP TRIGGER IF EXISTS test_fail_sent_log_${op}`);
        }
      } catch {
        // ignore
      }
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
        delete emailSvc.sendGardssalgOutreach; // back to the prototype method
      }
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        initMod.__setDbForTesting(prevRfbDb);
      } catch {
        // ignore
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("OUTREACH_COOLDOWN_DAYS", prevCooldownDays);
      restore("DAILY_PREP_MAX_CANDIDATES", prevMaxCandidates);
      restore("GARDSSALG_OUTREACH_DAILY_DISABLED", prevDisabled);
      restore("ANTHROPIC_API_KEY", prevAnthropicKey);
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-outreach-reserve-before-send.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOutreachReserveBeforeSendTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
