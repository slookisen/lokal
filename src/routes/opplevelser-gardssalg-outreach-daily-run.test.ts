/**
 * opplevelser-gardssalg-outreach-daily-run.test.ts — tests for the
 * platform-side daily gårdssalg outreach send (dev-request
 * 2026-09-03-opplevagent-sending-uten-llm-i-sendestien, option A):
 * runGardssalgOutreachDaily + shouldRunGardssalgOutreachDaily + the lane
 * switch (GET/POST /admin/gardssalg-outreach-lane) + POST
 * /admin/gardssalg-outreach-daily-run, all in src/routes/opplevelser.ts.
 *
 * Same harness as opplevelser-gardssalg-outreach-pilot-send.test.ts: fresh
 * in-memory EXPERIENCES db, fresh in-memory RFB db via database/init's
 * __setDbForTesting, and a fake nodemailer transporter injected onto the
 * emailService singleton so send assertions are made against the real
 * envelope that would leave the process.
 *
 * Covers:
 *   (a) shouldRunGardssalgOutreachDaily: only inside the 08:xx UTC window,
 *       at most once per ~day
 *   (b) lane switch: default unpaused; POST validates `paused`; GET reflects it
 *   (c) paused lane: apply run sends nothing, still records an envelope
 *   (d) dry run: candidates + would_send rows, zero writes, no envelope
 *   (e) real run: sends exactly the selected candidates with the personal
 *       template, logs them, records an envelope with the sent count
 *   (f) budget: a second run the same day cannot exceed daily_cap
 *       (no_candidates while cooldown holds; daily_cap_already_sent once the
 *       cap is reached), so restarts / double ticks never double-send
 *   (g) fresh hard bounce on a recent recipient → auto-pause + skip
 *   (h) routes: daily-run needs the admin key and defaults to dry run; the
 *       daily-prep route still returns its unchanged shape after extraction
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
    const method = opts.method ?? "GET";
    const url = opts.url ?? "/admin/gardssalg-outreach-lane";
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

export function runOpplevelserGardssalgOutreachDailyRunTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-daily-run-test-key";

    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.OUTREACH_COOLDOWN_DAYS = "60";
    delete process.env.DAILY_PREP_MAX_CANDIDATES; // default cap = 4
    delete process.env.GARDSSALG_OUTREACH_DAILY_DISABLED;

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
        // config already loaded / not needed
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
      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserMod.default as any;
      const {
        shouldRunGardssalgOutreachDaily,
        runGardssalgOutreachDaily,
        getGardssalgOutreachLaneState,
        setGardssalgOutreachLanePaused,
        GARDSSALG_OUTREACH_DAILY_AGENT,
      } = opplevelserMod;

      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      const sent: Array<Record<string, any>> = [];
      let stubMessageSeq = 0;
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          sent.push(mailOptions);
          stubMessageSeq += 1;
          return { messageId: `stub-daily-${stubMessageSeq}` };
        },
      };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte, naeringskode,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, 'rfb-seed', @producer_type,
            @epost, NULL, @hjemmeside, @about_text, NULL, NULL,
            @products, 'provider_site', 0, 0, @slug, @field_provenance,
            1, 4, NULL,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({
        id: "prov-alpha", navn: "Alpha Sideri", org_nr: "200000001", kommune: "Voss", producer_type: "sideri",
        epost: "post@alpha-sideri.no", hjemmeside: "https://alpha-sideri.no",
        about_text: REALISTIC_ABOUT_TEXT, products: "Sider, eplemost", slug: "alpha-sideri",
        field_provenance: VERIFIED_PROVENANCE,
      });
      insertProvider.run({
        id: "prov-beta", navn: "Beta Bryggeri", org_nr: "200000002", kommune: "Ulvik", producer_type: "bryggeri",
        epost: "post@beta-bryggeri.no", hjemmeside: "https://beta-bryggeri.no",
        about_text: REALISTIC_ABOUT_TEXT, products: "Øl, juleøl", slug: "beta-bryggeri",
        field_provenance: VERIFIED_PROVENANCE,
      });

      const auth = { "x-admin-key": testKey };
      const sentLogCount = () =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_outreach_sent_log WHERE is_test = 0`).get() as { n: number }).n;
      const runsFor = () =>
        rfbDb
          .prepare(`SELECT run_id, agent, status, claims, notes FROM runs WHERE agent = ? ORDER BY rowid`)
          .all(GARDSSALG_OUTREACH_DAILY_AGENT) as Array<{ run_id: string; agent: string; status: string; claims: string; notes: string }>;

      // ── (a) scheduling guard ───────────────────────────────────────────
      assertEq(shouldRunGardssalgOutreachDaily({ now: new Date("2026-09-06T07:59:00Z"), lastRunAt: null }), false, "a1: 07:59Z -> not in window");
      assertEq(shouldRunGardssalgOutreachDaily({ now: new Date("2026-09-06T08:00:00Z"), lastRunAt: null }), true, "a2: 08:00Z, never run -> run");
      assertEq(
        shouldRunGardssalgOutreachDaily({ now: new Date("2026-09-06T08:30:00Z"), lastRunAt: new Date("2026-09-06T08:05:00Z") }),
        false,
        "a3: 08:30Z, ran 25 min ago -> no second run",
      );
      assertEq(
        shouldRunGardssalgOutreachDaily({ now: new Date("2026-09-07T08:10:00Z"), lastRunAt: new Date("2026-09-06T08:50:00Z") }),
        true,
        "a4: next day 08:10Z, ran 23h20m ago -> run",
      );
      assertEq(shouldRunGardssalgOutreachDaily({ now: new Date("2026-09-06T09:00:00Z"), lastRunAt: null }), false, "a5: 09:00Z -> not in window");

      // ── (b) lane switch ────────────────────────────────────────────────
      const laneDefault = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(laneDefault.status, 200, "b1: GET lane -> 200");
      assertEq(laneDefault.body.paused, false, "b2: lane unpaused by default");
      assertEq(laneDefault.body.daily_cap, 4, "b3: GET lane reports the default daily cap");
      assertEq(laneDefault.body.window_hour_utc, 8, "b4: GET lane reports the 08:xx UTC window");
      const laneBad = await callRoute(opplevelserRouter, { method: "POST", headers: auth, body: { paused: "yes" } });
      assertEq(laneBad.status, 400, "b5: POST lane with non-boolean paused -> 400");
      const lanePause = await callRoute(opplevelserRouter, {
        method: "POST", headers: auth, body: { paused: true, by: "test-suite", reason: "manual pause" },
      });
      assertEq(lanePause.status, 200, "b6: POST lane paused:true -> 200");
      assertEq(lanePause.body.paused, true, "b7: lane now paused");
      assertEq(lanePause.body.changed_by, "test-suite", "b8: changed_by recorded");
      assertEq(getGardssalgOutreachLaneState(expDb).paused, true, "b9: state readable from the helper too");

      // ── (c) paused lane: nothing sent, envelope still written ──────────
      const pausedRun = await runGardssalgOutreachDaily({ apply: true, trigger: "manual" });
      assertEq(pausedRun.skipped_reason, "paused", "c1: paused lane -> skipped_reason paused");
      assertEq(pausedRun.summary.sent, 0, "c2: paused lane sends nothing");
      assertEq(sent.length, 0, "c3: transporter untouched while paused");
      assertEq(pausedRun.envelope_recorded, true, "c4: envelope recorded for a real (apply) run even when skipped");
      assertEq(runsFor().length, 1, "c5: exactly one runs row so far");
      assertTrue(runsFor()[0].notes.includes("skipped: paused"), "c6: envelope notes carry the skip reason");

      // ── (d) dry run: list, no writes, no envelope ───────────────────────
      setGardssalgOutreachLanePaused(expDb, { paused: false, by: "test-suite", reason: null });
      const dry = await runGardssalgOutreachDaily({ apply: false, trigger: "manual" });
      assertEq(dry.skipped_reason, null, "d1: dry run not skipped");
      assertEq(dry.candidates.map((c) => c.provider_id), ["prov-alpha", "prov-beta"], "d2: dry run lists both eligible providers");
      assertEq(dry.candidates.map((c) => c.touch), ["first", "first"], "d3: both are first-touch");
      assertEq(dry.results.map((r) => r.status), ["would_send", "would_send"], "d4: dry run rows are would_send");
      assertEq(dry.budget, 4, "d5: full budget when nothing sent today");
      assertEq(sentLogCount(), 0, "d6: dry run writes no sent_log rows");
      assertEq(sent.length, 0, "d7: dry run touches no transporter");
      assertEq(runsFor().length, 1, "d8: dry run records no envelope");

      // ── (e) real run ───────────────────────────────────────────────────
      const real = await runGardssalgOutreachDaily({ apply: true, trigger: "manual" });
      assertEq(real.skipped_reason, null, "e1: real run not skipped");
      assertEq(real.summary.sent, 2, "e2: real run sent both candidates");
      assertEq(real.summary.error, 0, "e3: no errors");
      assertEq(sentLogCount(), 2, "e4: two real sent_log rows");
      assertEq(sent.length, 2, "e5: two envelopes left the transporter");
      assertEq(
        sent.map((m) => String(m.to)).sort(),
        ["post@alpha-sideri.no", "post@beta-bryggeri.no"],
        "e6: sent to the two producers' own addresses",
      );
      assertTrue(sent.every((m) => String(m.subject).startsWith("Har vi riktig info om")), "e7: personal template subject on every mail");
      assertTrue(real.results.every((r) => r.status === "sent" && r.crm_recorded === true), "e8: every row sent + CRM-filed");
      assertTrue(real.run_id.includes("-manual-"), "e9: manual run ids are distinct from the cron id");
      const runs = runsFor();
      assertEq(runs.length, 2, "e10: second runs row recorded");
      const claims = JSON.parse(runs[1].claims) as Array<{ type: string; value: number; meta?: Record<string, unknown> }>;
      assertEq(runs[1].status, "completed", "e11: envelope status completed");
      assertEq(claims[0].type, "emails_sent", "e12: first claim is emails_sent");
      assertEq(claims[0].value, 2, "e13: emails_sent = 2");
      assertEq(claims[1].meta?.kind, "gardssalg_outreach_first_touch_sent", "e14: first-touch claim present");
      assertEq(claims[1].value, 2, "e15: first_touch_sent = 2");

      // ── (f) budget / idempotency ───────────────────────────────────────
      const again = await runGardssalgOutreachDaily({ apply: true, trigger: "cron" });
      assertEq(again.skipped_reason, "no_candidates", "f1: same day again -> both in cooldown -> no_candidates");
      assertEq(again.sent_today_before, 2, "f2: reports the two already sent today");
      assertEq(again.budget, 2, "f3: budget is cap minus sent today");
      assertEq(sentLogCount(), 2, "f4: nothing re-sent");
      process.env.DAILY_PREP_MAX_CANDIDATES = "2";
      const capped = await runGardssalgOutreachDaily({ apply: true, trigger: "cron" });
      assertEq(capped.skipped_reason, "daily_cap_already_sent", "f5: cap reached -> daily_cap_already_sent");
      assertEq(capped.budget, 0, "f6: zero budget at cap");
      assertEq(sent.length, 2, "f7: transporter still at two");
      delete process.env.DAILY_PREP_MAX_CANDIDATES;

      // ── (g) fresh hard bounce -> auto-pause ────────────────────────────
      rfbDb
        .prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type, reason) VALUES (?, ?, 'hard', 'test')`)
        .run("post@alpha-sideri.no", new Date().toISOString());
      const bounced = await runGardssalgOutreachDaily({ apply: true, trigger: "cron" });
      assertEq(bounced.skipped_reason, "bounce_or_complaint_recent", "g1: fresh hard bounce -> skipped");
      assertEq(bounced.auto_paused, true, "g2: lane auto-paused");
      assertEq(bounced.recent_bounces.map((b) => b.recipient_email), ["post@alpha-sideri.no"], "g3: bounce identified");
      assertEq(getGardssalgOutreachLaneState(expDb).paused, true, "g4: pause persisted in the DB");
      assertTrue(String(getGardssalgOutreachLaneState(expDb).reason).startsWith("auto-pause"), "g5: reason explains the auto-pause");
      assertTrue(runsFor()[runsFor().length - 1].notes.includes("AUTO-PAUSED"), "g6: envelope notes flag the auto-pause");
      assertEq(sent.length, 2, "g7: nothing sent after the bounce");

      // ── (h) routes ─────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { method: "POST", url: "/admin/gardssalg-outreach-daily-run", body: { apply: true } });
      assertEq(noKey.status, 403, "h1: daily-run without X-Admin-Key -> 403");
      const viaRoute = await callRoute(opplevelserRouter, { method: "POST", url: "/admin/gardssalg-outreach-daily-run", headers: auth, body: {} });
      assertEq(viaRoute.status, 200, "h2: daily-run with key -> 200");
      assertEq(viaRoute.body.apply, false, "h3: daily-run defaults to dry run");
      assertEq(viaRoute.body.skipped_reason, "paused", "h4: dry run reports the (auto-)paused lane");
      const prep = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-outreach-daily-prep", headers: auth });
      assertEq(prep.status, 200, "h5: daily-prep route still 200 after extraction");
      assertEq(
        Object.keys(prep.body).filter((k) => k !== "refill_hints"),
        ["generated_at", "candidates", "excluded", "pool", "dry", "missing", "note", "active_contact_email_overrides", "second_line_verified_count"],
        "h6: daily-prep response shape unchanged",
      );
      assertEq(prep.body.pool.daily_cap, 4, "h7: daily-prep still reports the cap");
      assertEq(prep.body.candidates.length, 0, "h8: both providers now in cooldown -> no candidates");
      assertEq(
        prep.body.excluded.filter((e: any) => e.reason === "cooldown_suppressed").length,
        2,
        "h9: both excluded as cooldown_suppressed",
      );
      const pilotDry = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-pilot-send", headers: auth, body: { provider_ids: ["prov-alpha"] },
      });
      assertEq(pilotDry.status, 200, "h10: pilot-send route still answers after extraction");
      assertEq(pilotDry.body.results[0].status, "skipped", "h11: pilot-send dry run reports the cooldown skip");
      assertEq(pilotDry.body.results[0].reason, "cooldown_suppressed", "h12: ...with the same reason as before");
    } catch (err) {
      failed++;
      failures.push(`✗ harness error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      if (log) console.log(`  ✗ harness error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        initMod.__setDbForTesting(prevRfbDb);
      } catch {
        // ignore
      }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevCooldownDays === undefined) delete process.env.OUTREACH_COOLDOWN_DAYS;
      else process.env.OUTREACH_COOLDOWN_DAYS = prevCooldownDays;
      if (prevMaxCandidates === undefined) delete process.env.DAILY_PREP_MAX_CANDIDATES;
      else process.env.DAILY_PREP_MAX_CANDIDATES = prevMaxCandidates;
      if (prevDisabled === undefined) delete process.env.GARDSSALG_OUTREACH_DAILY_DISABLED;
      else process.env.GARDSSALG_OUTREACH_DAILY_DISABLED = prevDisabled;
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}
