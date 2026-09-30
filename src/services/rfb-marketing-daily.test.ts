/**
 * rfb-marketing-daily.test.ts — the platform-side daily RFB outreach send
 * (dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben):
 * runRfbMarketingDaily + its tick guard + the lane switch
 * (GET/POST /admin/rfb-marketing-lane) + POST /admin/rfb-marketing-daily-run.
 *
 * Every block runs against a FRESH in-memory main DB with the full production
 * schema (__setDbForTesting + __initSchemaForTesting), so the real gate
 * (computeOutreachCandidates), the real compose guard chain (executeCompose)
 * and the real outreach_sent_log triggers run. The e-mail transport is the
 * `deps.sendRaw` seam (records every envelope that would leave the process);
 * one block drives the default emailService path with a stub transporter.
 * Health is injected (the suite's own process memory is not prod's).
 *
 * Covers:
 *   (a) tick window 08:10–08:59Z, once per ~day; knob parsing/clamping
 *   (b) G1 env switch: apply is a no-op; a dry run still lists (read-only)
 *   (c) dry run writes nothing, sends nothing, previews the exact text
 *   (d) G2 lane switch + routes; a paused lane sends nothing
 *   (e) apply: first-touch first, second-touch fills, exact template/identity,
 *       ledger + outreach_sent_log + CRM + cap + envelope
 *   (f) restart / second tick: never exceeds the cap, never re-sends; a
 *       crash-left 'reserved' row counts as sent and blocks the address
 *   (g) reserve-before-send fail-closed: ledger INSERT fails → no send, loop
 *       stops, reported
 *   (h) the gårdssalg 2026-09-27 bug class: e-mail sent, post-send DB write
 *       fails → reported, loop stops, and the address is NOT re-sent the next
 *       day even though the gate selects it again
 *   (i) ledger UPDATE fails after a send → row stays 'reserved', loop stops,
 *       counted + blocked on the next run; a transport failure AFTER the
 *       hand-off is an 'unknown' delivery — AT MOST ONCE: counted, blocked for
 *       the cooldown, never retried, and the run stops at the first one (a
 *       thrown/ambiguous failure on day 1 → no e-mail on day 2; a failing
 *       transport with five candidates → exactly one attempt)
 *   (j) G3 bounce/complaint → auto-pause (apply only), ack survives unpause,
 *       a new bounce re-pauses; soft/old/other-vertical bounces ignored
 *   (k) G3 health red → skip without pausing; /health threshold drift guard
 *   (l) G4 budget from the DB: RFB cap, OUTREACH_MAX_PER_DAY remainder,
 *       sends made elsewhere today
 *   (m) OUTREACH_PAUSED kill-switch
 *   (n) content backstop (held) + compose refusal are rows; budget backfills
 *   (o) in-process mutex: concurrent calls never double-send
 *   (p) POST /admin/rfb-marketing-daily-run: auth, dry-run default
 *   (q) canonical profile URL = the agent card's canonicalUrl
 *   (r) ledger UNIQUE(day, recipient) at the database level
 *   (s) default transport wiring (emailService, From/Reply-To, html part)
 *   (t) G1b: apply without a live transport → transport_not_live, no writes;
 *       isLiveTransport() = the negation of sendRaw's DRY_RUN short-circuit;
 *       transport_live in the dry-run report and the lane GET; a DRY_RUN
 *       answer that slips through stops the run and is not counted as sent
 *   (u) the compose-attempt cap bounds a streak of pre-transport refusals
 *   (v) a database error mid-run (a read, the second gate) → db_error, the
 *       envelope is still written
 *   (w) a lane pause set mid-run stops before the next reservation; the cap
 *       is re-checked inside the reservation transaction (concurrent send)
 *   (x) no_sendable_candidates vs no_candidates; the ledger blocks by agent
 *       too (changed address, same day)
 *   (y) envelope status: partial/failed whenever the run stopped or erred;
 *       the held list, the gate summary and unknown deliveries as claims
 *   (z) pre-send homepage refresh (owner decision 2026-09-29): only for the
 *       candidates about to be sent, before the content check (fresh content
 *       decides held/sent), never on a dry run, never blocking (failed /
 *       thrown / timeout / write-paused), bounded (count + per-candidate +
 *       total time), the real refreshHomepageContent path with curated locks
 *       and the enrichment write-pause, outcomes in report + envelope; a
 *       hijacked (theme-spam) homepage HOLDS the candidate (hijacked_homepage:
 *       no reservation, no compose, counted separately) while a transient
 *       refresh failure still sends
 *   (N) N-A: unknown / post-send-failed / crash-left 'reserved' ledger rows
 *       reconciled into outreach_sent_log — an unknown delivery on day 0 is
 *       NOT offered as a first touch on day 61; idempotent across runs;
 *       compose's email-keyed cooldown counts the reconciled row
 *
 * The pre-send refresh never touches the network in this file: every run
 * gets a stub fetch (module-level default + per-run seams).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-marketing-daily.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

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
    const url = opts.url ?? "/";
    const headers = opts.headers || {};
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers,
      body: opts.body ?? {},
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
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
      else resolve({ status: 404, body: { error: "unmatched" } });
    });
  });
}

const GOOD_ABOUT =
  "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honning og ull direkte fra gården hele året.";
const ENGLISH_ABOUT =
  "We are a small family farm selling lamb and honey directly to customers all year round, welcome.";

const ENV_KEYS = [
  "RFB_MARKETING_PLATFORM_ENABLED",
  "RFB_MARKETING_DAILY_CAP",
  "OUTREACH_MAX_PER_DAY",
  "OUTREACH_COOLDOWN_DAYS",
  "OUTREACH_PAUSED",
] as const;

export async function runRfbMarketingDailyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  try {
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded by an earlier suite in this process
  }
  const initMod = require("../database/init") as typeof import("../database/init");
  const daily = require("./rfb-marketing-daily") as typeof import("./rfb-marketing-daily");
  const tmpl = require("./rfb-outreach-template") as typeof import("./rfb-outreach-template");
  const identity = require("./crm-platform-identity") as typeof import("./crm-platform-identity");
  const aoc = require("../routes/admin-outreach-candidates") as typeof import("../routes/admin-outreach-candidates");
  const adminRoutes = require("../routes/admin-rfb-marketing") as typeof import("../routes/admin-rfb-marketing");
  const emailMod = require("./email-service") as typeof import("./email-service");

  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevAdminKey = process.env.ADMIN_KEY;
  // Adopt the ambient suite key (tests/test.ts assigns it once); standalone fallback.
  const testKey = process.env.ADMIN_KEY || "rfb-marketing-daily-test-key";
  process.env.ADMIN_KEY = testKey;
  const auth = { "x-admin-key": testKey };

  const emailSvc = emailMod.emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;

  let db: any = null;
  // outreach_eligible_at seconds for seeded producers: seed order == gate order.
  let eligibleSeq = 0;

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  }

  function freshDb(): any {
    eligibleSeq = 0;
    db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = OFF");
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    // 150 non-pool producers so the social-proof count clears 100.
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
       VALUES (?, ?, 'filler', 'test', '', 'https://filler-farm.no', 'producer', ?)`,
    );
    const insK = db.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, 'pending_verify')`);
    db.transaction(() => {
      for (let i = 0; i < 150; i++) {
        insA.run(`filler-${i}`, `Filler ${i}`, `key-filler-${i}`);
        insK.run(`filler-${i}`);
      }
    })();
    return db;
  }

  function seedProducer(
    id: string,
    name: string,
    email: string,
    o: {
      about?: string | null;
      description?: string;
      products?: string;
      secondTouchDaysAgo?: number;
      priorSends?: Array<{ daysAgo: number; vertical: string }>;
    } = {},
  ): void {
    eligibleSeq += 1;
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
       VALUES (?, ?, ?, 'test', ?, 'https://gard-test.no', 'producer', ?)`,
    ).run(id, name, o.description ?? "Gård", email, `key-${id}`);
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, about, products, field_provenance, verification_status, enrichment_status,
          url_last_status, url_last_probed, outreach_eligible_at)
       VALUES (?, ?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'), ?)`,
    ).run(
      id,
      email,
      o.about === undefined ? GOOD_ABOUT : o.about,
      o.products ?? "[]",
      `2026-01-01 00:00:${String(eligibleSeq % 60).padStart(2, "0")}`,
    );
    const prior = [...(o.priorSends ?? [])];
    if (o.secondTouchDaysAgo) prior.push({ daysAgo: o.secondTouchDaysAgo, vertical: "rfb" });
    for (const [i, p] of prior.entries()) {
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
         VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior', ?)`,
      ).run(id, email.toLowerCase(), `-${p.daysAgo} days`, `prior-${id}-${i}`, p.vertical);
    }
  }

  function makeTransport() {
    const calls: Array<Record<string, any>> = [];
    const sendRaw = async (o: any) => {
      calls.push(o);
      return { success: true, messageId: `stub-msg-${calls.length}` };
    };
    return { calls, sendRaw };
  }
  const healthy = () => ({ red: false, reasons: [] as string[], rss_mb: 100, disk_used_pct: 10 });

  async function run(
    apply: boolean,
    o: { now?: Date; transport?: ReturnType<typeof makeTransport>; health?: () => any; trigger?: "cron" | "manual" } = {},
  ) {
    return daily.runRfbMarketingDaily({
      apply,
      trigger: o.trigger ?? "manual",
      now: o.now ?? new Date(),
      deps: { sendRaw: o.transport?.sendRaw, healthProbe: o.health ?? healthy },
    });
  }

  const TABLES = [
    "crm_threads",
    "crm_messages",
    "crm_outbox",
    "crm_actions",
    "crm_contacts",
    "outreach_daily_send_cap",
    "outreach_sent_log",
    "rfb_marketing_send_ledger",
    "rfb_marketing_lane_state",
    "runs",
  ];
  function counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    return out;
  }
  function ledger(): Array<{ recipient_email: string; status: string; touch: string; thread_id: string | null; day: string }> {
    return db.prepare(`SELECT recipient_email, status, touch, thread_id, day FROM rfb_marketing_send_ledger ORDER BY id`).all();
  }
  function oslFor(email: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM outreach_sent_log WHERE recipient_email = ? AND notes LIKE 'auto:%'`).get(email) as { c: number }).c;
  }
  /** outreach_sent_log rows the job reconciled from its ledger (N-A). */
  function reconciledFor(email: string): Array<{ agent_id: string; message_id: string; notes: string; vertical_id: string; channel: string; sent_at: string }> {
    return db
      .prepare(
        `SELECT agent_id, message_id, notes, vertical_id, channel, sent_at FROM outreach_sent_log
          WHERE recipient_email = ? AND notes LIKE 'rfb-marketing-platform:%' ORDER BY id`,
      )
      .all(email);
  }
  function runsRows(): Array<{ run_id: string; status: string; claims: string; notes: string; errors: string | null }> {
    return db
      .prepare(`SELECT run_id, status, claims, notes, errors FROM runs WHERE agent = ? ORDER BY rowid`)
      .all(daily.RFB_MARKETING_DAILY_AGENT);
  }
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const tomorrow = () => new Date(Date.now() + 86400_000);

  // No test in this file may reach a real homepage: unless a block injects its
  // own, every pre-send refresh fetch "times out" (transient → no parking
  // strike, no write — the candidate goes out with the content it has).
  const noNetworkFetch = (async () => {
    throw Object.assign(new Error("network disabled in rfb-marketing-daily tests"), { name: "TimeoutError" });
  }) as unknown as typeof fetch;
  daily.__setRfbMarketingRefreshFetchForTesting(noNetworkFetch);
  const htmlPage = (og: string) =>
    new Response(`<html><head><title>Gård</title><meta property="og:description" content="${og}"></head><body><p>Velkommen.</p></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  try {
    // ── (a) scheduling + knobs ─────────────────────────────────────────────
    const should = daily.shouldRunRfbMarketingDaily;
    assertEq(should({ now: new Date("2026-10-01T08:09:59Z"), lastRunAt: null }), false, "a1: 08:09Z → before the window");
    assertEq(should({ now: new Date("2026-10-01T08:10:00Z"), lastRunAt: null }), true, "a2: 08:10Z, never run → run");
    assertEq(should({ now: new Date("2026-10-01T08:59:00Z"), lastRunAt: null }), true, "a3: 08:59Z → still in window");
    assertEq(should({ now: new Date("2026-10-01T09:00:00Z"), lastRunAt: null }), false, "a4: 09:00Z → window closed");
    assertEq(should({ now: new Date("2026-10-01T08:00:00Z"), lastRunAt: null }), false, "a5: 08:00Z (the gårdssalg slot) → not ours");
    assertEq(
      should({ now: new Date("2026-10-01T08:40:00Z"), lastRunAt: new Date("2026-10-01T08:10:00Z") }),
      false,
      "a6: ran 30 min ago → no second run in the same window",
    );
    assertEq(
      should({ now: new Date("2026-10-02T08:10:00Z"), lastRunAt: new Date("2026-10-01T08:15:00Z") }),
      true,
      "a7: next day, 23h55m later → run",
    );

    setEnv({});
    assertEq(daily.resolveRfbMarketingDailyCap(), 10, "a8: RFB_MARKETING_DAILY_CAP unset → 10");
    setEnv({ RFB_MARKETING_DAILY_CAP: "25" });
    assertEq(daily.resolveRfbMarketingDailyCap(), 25, "a9: 25 → 25");
    setEnv({ RFB_MARKETING_DAILY_CAP: "99" });
    assertEq(daily.resolveRfbMarketingDailyCap(), 30, "a10: clamped to 30");
    setEnv({ RFB_MARKETING_DAILY_CAP: "0" });
    assertEq(daily.resolveRfbMarketingDailyCap(), 1, "a11: clamped to 1");
    setEnv({ RFB_MARKETING_DAILY_CAP: "abc" });
    assertEq(daily.resolveRfbMarketingDailyCap(), 10, "a12: unparseable → default 10");
    setEnv({});
    assertEq(daily.resolveRfbMarketingGateCooldownDays(), 60, "a13: gate cooldown = route default 60");
    setEnv({ OUTREACH_COOLDOWN_DAYS: "90" });
    assertEq(daily.resolveRfbMarketingGateCooldownDays(), 90, "a14: send-path cooldown 90 → gate asks for 90 (never selects what compose refuses)");
    setEnv({ OUTREACH_COOLDOWN_DAYS: "30" });
    assertEq(daily.resolveRfbMarketingGateCooldownDays(), 60, "a15: a shorter send-path cooldown never loosens the gate below 60");
    setEnv({});
    assertEq(daily.isRfbMarketingPlatformEnabled(), false, "a16: platform switch defaults OFF");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "true" });
    assertEq(daily.isRfbMarketingPlatformEnabled(), false, "a17: only the exact string '1' turns it on");

    // ── (b) G1 — env switch ────────────────────────────────────────────────
    freshDb();
    seedProducer("p-a", "Alfa Gård", "alfa@gard-test.no");
    seedProducer("p-b", "Beta Gård", "beta@gard-test.no");
    setEnv({ RFB_MARKETING_DAILY_CAP: "5" });
    {
      const t = makeTransport();
      const before = counts();
      const r = await run(true, { transport: t });
      assertEq(r.skipped_reason, "disabled_by_env", "b1: env off + apply → disabled_by_env");
      assertEq(t.calls.length, 0, "b2: env off + apply → no e-mail");
      assertEq(counts(), before, "b3: env off + apply → no write anywhere (incl. no envelope)");
      assertEq(r.envelope_recorded, false, "b4: no envelope when the switch is off");

      const dry = await run(false, { transport: t });
      assertEq(dry.enabled_by_env, false, "b5: dry run reports the switch as off");
      assertEq(dry.skipped_reason, null, "b6: env off does not stop a dry run");
      assertEq(dry.results.map((x) => x.status), ["would_send", "would_send"], "b7: dry run still lists the candidates");
      assertEq(t.calls.length, 0, "b8: dry run sends nothing");
      assertEq(counts(), before, "b9: dry run writes nothing");
      assertEq([typeof dry.transport_live, dry.transport_live], ["boolean", emailMod.emailService.isLiveTransport()], "b10: the dry-run report carries transport_live");
    }

    // ── (c) dry run (enabled): budget respected, exact preview ─────────────
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const t = makeTransport();
      const before = counts();
      const r = await run(false, { transport: t });
      assertEq(r.results.length, 1, "c1: dry run stops at the budget (cap 1)");
      assertEq(r.results[0].status, "would_send", "c2: row is would_send");
      const expected = tmpl.renderRfbOutreachEmail({
        agentId: "p-a",
        producerName: "Alfa Gård",
        profileUrl: "https://rettfrabonden.com/produsent/alfa-gard",
        producerCountTotal: 152,
      });
      assertEq(r.results[0].preview_text, expected.text, "c3: preview is the exact template render");
      assertEq(r.results[0].subject, expected.subject, "c4: subject from the A/B rule");
      assertEq(r.results[0].profile_url, "https://rettfrabonden.com/produsent/alfa-gard", "c5: canonical profile URL");
      assertEq(r.social_proof?.line, "Katalogen har i dag over 100 norske matprodusenter.", "c6: social proof from the agent_knowledge count (152 → over 100)");
      assertEq(t.calls.length, 0, "c7: nothing sent");
      assertEq(counts(), before, "c8: nothing written (no ledger, no CRM, no cap, no envelope)");
      assertEq(r.envelope_recorded, false, "c9: dry run records no envelope");
      const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
      const beforeChanges = changes();
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
      const wide = await run(false, { transport: t });
      assertEq([wide.summary.would_send, changes()], [2, beforeChanges], "c10: a dry run changes no row in ANY table (total_changes unchanged)");
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    }

    // ── (d) G2 — lane switch + routes ──────────────────────────────────────
    {
      const laneRouter = adminRoutes.rfbMarketingLaneRouter as any;
      const noKey = await callRoute(laneRouter, { method: "GET" });
      assertEq(noKey.status, 403, "d1: GET lane without the admin key → 403");
      const g = await callRoute(laneRouter, { method: "GET", headers: auth });
      assertEq(g.status, 200, "d2: GET lane → 200");
      assertEq(g.body.paused, false, "d3: lane unpaused by default");
      assertEq(g.body.enabled_by_env, true, "d4: GET reports the env switch");
      assertEq(g.body.daily_cap, 1, "d5: GET reports the daily cap");
      assertEq([g.body.window_hour_utc, g.body.window_start_minute_utc], [8, 10], "d6: GET reports the 08:10Z window");
      assertEq(g.body.agent, "rfb-marketing-platform", "d7: GET names the envelope agent");
      assertEq([typeof g.body.transport_live, g.body.transport_live], ["boolean", emailMod.emailService.isLiveTransport()], "d7b: GET reports transport_live (G1b)");
      const bad = await callRoute(laneRouter, { method: "POST", headers: auth, body: { paused: "yes" } });
      assertEq(bad.status, 400, "d8: POST with non-boolean paused → 400");
      const p = await callRoute(laneRouter, { method: "POST", headers: auth, body: { paused: true, by: "daniel", reason: "ferie" } });
      assertEq([p.status, p.body.paused, p.body.changed_by, p.body.reason], [200, true, "daniel", "ferie"], "d9: POST pauses with by/reason");
      const g2 = await callRoute(laneRouter, { method: "GET", headers: auth });
      assertEq(g2.body.paused, true, "d10: GET reflects the pause");

      const t = makeTransport();
      const runsBefore = runsRows().length;
      const r = await run(true, { transport: t });
      assertEq(r.skipped_reason, "paused", "d11: paused lane → skipped");
      assertEq(t.calls.length, 0, "d12: paused lane → no e-mail");
      assertEq(runsRows().length, runsBefore + 1, "d13: a paused apply run still records an envelope");
      assertEq(JSON.parse(runsRows().slice(-1)[0].claims)[0], { type: "emails_sent", value: 0, meta: { lane: "rfb-marketing", channel: "resend_smtp", table: "rfb_marketing_send_ledger", template: "rfb-outreach-v2", agent_ids: [] } }, "d14: envelope claims emails_sent 0");
      const dry = await run(false, { transport: t });
      assertEq([dry.skipped_reason, runsRows().length], ["paused", runsBefore + 1], "d15: paused dry run → skipped, no envelope");
      const up = await callRoute(laneRouter, { method: "POST", headers: auth, body: { paused: false, by: "daniel" } });
      assertEq(up.body.paused, false, "d16: POST paused:false clears it");
    }

    // ── (e) apply: first-touch first, second-touch fills ───────────────────
    freshDb();
    // Haugerud Gård (Regenerativt): the canonical-url addendum's å example.
    seedProducer("f-0000-000a", "Haugerud Gård (Regenerativt)", "post@haugerud-test.no");
    seedProducer("f-0000-000b", "Bakke Honning", "Post@Bakke-Test.no");
    seedProducer("s-0000-0001", "Gammel Gård", "gammel@gard-test.no", { secondTouchDaysAgo: 120 });
    seedProducer("s-0000-0002", "Nyere Gård", "nyere@gard-test.no", { secondTouchDaysAgo: 80 });
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    const eTransport = makeTransport();
    const eNow = new Date();
    {
      const r = await run(true, { transport: eTransport, trigger: "cron", now: eNow });
      assertEq(r.skipped_reason, null, "e1: not skipped");
      assertEq(r.stopped_reason, null, "e2: not stopped");
      assertEq([r.summary.sent, r.summary.first_touch_sent, r.summary.second_touch_sent], [3, 2, 1], "e3: 3 sent — both first-touch, then the oldest second-touch");
      assertEq(
        eTransport.calls.map((c) => c.to),
        ["post@haugerud-test.no", "Post@Bakke-Test.no", "gammel@gard-test.no"],
        "e4: order: first-touch (gate order), then second-touch oldest-contacted-first",
      );
      const hauge = tmpl.renderRfbOutreachEmail({
        agentId: "f-0000-000a",
        producerName: "Haugerud Gård (Regenerativt)",
        profileUrl: "https://rettfrabonden.com/produsent/haugerud-gard-regenerativt",
        producerCountTotal: 154,
      });
      assertEq(eTransport.calls[0].subject, "Har vi info riktig om Haugerud Gård (Regenerativt)?", "e5: subject A for …a (even)");
      assertEq(eTransport.calls[0].textContent, hauge.text, "e6: body is the template, byte for byte");
      assertTrue(hauge.text.includes("https://rettfrabonden.com/produsent/haugerud-gard-regenerativt"), "e7: canonical å→a slug in the link");
      assertEq(eTransport.calls[1].subject, "Profil-utkast for Bakke Honning", "e8: subject B for …b (odd)");
      assertEq(eTransport.calls[0].from, identity.crmFromHeader("rfb"), "e9: From is the RFB platform identity");
      assertEq(eTransport.calls[0].replyTo, identity.resolveCrmIdentity("rfb").replyTo, "e10: Reply-To is the RFB identity's");
      assertTrue(String(eTransport.calls[0].htmlContent).includes("<p>"), "e11: html alternative derived from the text by the compose path");
      assertEq(r.results.filter((x) => x.status === "sent").every((x) => typeof x.thread_id === "string"), true, "e12: every sent row carries its CRM thread id");

      assertEq(
        ledger().map((l) => [l.recipient_email, l.status, l.touch]),
        [
          ["post@haugerud-test.no", "sent", "first"],
          ["post@bakke-test.no", "sent", "first"],
          ["gammel@gard-test.no", "sent", "second"],
        ],
        "e13: one ledger row per send, reserved then flipped to sent",
      );
      assertEq(
        [oslFor("post@haugerud-test.no"), oslFor("post@bakke-test.no"), oslFor("gammel@gard-test.no"), oslFor("nyere@gard-test.no")],
        [1, 1, 1, 0],
        "e14: outreach_sent_log recorded each send (compose's queued→sent trigger), nothing else",
      );
      const threads = db.prepare(`SELECT category, vertical_id FROM crm_threads ORDER BY rowid`).all();
      assertEq(threads, [{ category: "marketing", vertical_id: "rfb" }, { category: "marketing", vertical_id: "rfb" }, { category: "marketing", vertical_id: "rfb" }], "e15: CRM threads filed as rfb/marketing");
      const sentActions = db.prepare(`SELECT actor FROM crm_actions WHERE type = 'sent'`).all() as Array<{ actor: string }>;
      assertEq(sentActions.map((a) => a.actor), ["claude", "claude", "claude"], "e16: sends attributed to createdBy claude (counted by every guard like a routine send)");
      const cap = db.prepare(`SELECT reserved_count FROM outreach_daily_send_cap WHERE day = ?`).get(day(new Date())) as { reserved_count: number };
      assertEq(cap.reserved_count, 3, "e17: OUTREACH_MAX_PER_DAY reservation counted all three");

      const rr = runsRows();
      assertEq(rr.length, 1, "e18: one envelope");
      assertEq(rr[0].run_id, `run-${day(eNow)}-rfb-marketing-platform`, "e19: cron run id convention");
      assertEq(rr[0].status, "completed", "e20: envelope status completed");
      const claims = JSON.parse(rr[0].claims);
      assertEq([claims[0].type, claims[0].value], ["emails_sent", 3], "e21: emails_sent 3");
      assertEq(claims[0].meta.agent_ids, ["f-0000-000a", "f-0000-000b", "s-0000-0001"], "e22: claim names the agents");
      assertEq([claims[1].meta.kind, claims[1].value, claims[2].meta.kind, claims[2].value], ["rfb_marketing_first_touch_sent", 2, "rfb_marketing_second_touch_sent", 1], "e23: first/second-touch split claims");
    }

    // ── (f) restart / second tick: never exceeds the cap, never re-sends ──
    {
      const r2 = await run(true, { transport: eTransport, trigger: "cron", now: new Date() });
      assertEq(r2.skipped_reason, "daily_cap_already_sent", "f1: second tick the same day → cap already sent (counted from the DB)");
      assertEq(eTransport.calls.length, 3, "f2: no e-mail on the second tick");
      assertTrue(runsRows()[1].run_id !== runsRows()[0].run_id && runsRows()[1].run_id.startsWith(runsRows()[0].run_id), "f3: second cron envelope gets a suffixed run id");

      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
      const r3 = await run(true, { transport: eTransport });
      assertEq([r3.sent_today_before, r3.budget, r3.summary.sent], [3, 2, 1], "f4: cap raised to 5 → only the one remaining candidate is sent");
      assertEq(eTransport.calls[3].to, "nyere@gard-test.no", "f5: the remaining second-touch candidate");
      const perRecipient = new Map<string, number>();
      for (const c of eTransport.calls) perRecipient.set(String(c.to).toLowerCase(), (perRecipient.get(String(c.to).toLowerCase()) ?? 0) + 1);
      assertEq([...perRecipient.values()].every((n) => n === 1), true, "f6: no recipient ever received two e-mails");
      const r4 = await run(true, { transport: eTransport });
      assertEq([r4.skipped_reason, eTransport.calls.length], ["no_candidates", 4], "f7: third run → nothing left, nothing sent");

      // A crash between reservation and outcome leaves 'reserved': it counts as
      // sent for the budget and blocks that address on later days too.
      seedProducer("n-0000-0001", "Krasj Gård", "krasj@gard-test.no");
      db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES (?, 'run-crashed', 'n-0000-0001', 'krasj@gard-test.no', 'first', 'B', 'reserved', ?)`,
      ).run(day(new Date()), new Date().toISOString());
      const r5 = await run(true, { transport: eTransport });
      assertEq([r5.skipped_reason, r5.sent_today_before], ["daily_cap_already_sent", 5], "f8: a crash-left 'reserved' row counts toward today's cap");
      // N-A: r5's start-of-run sweep already wrote the crash-left row into
      // outreach_sent_log, so from here on every reader counts it as a contact.
      assertEq(
        [r5.sent_log_reconciliation?.inserted, reconciledFor("krasj@gard-test.no").map((x) => [x.notes, x.vertical_id])],
        [1, [["rfb-marketing-platform:reserved_outcome_unknown", "rfb"]]],
        "f8b: the crash-left 'reserved' row is reconciled into outreach_sent_log at the start of the next run",
      );
      const r6 = await run(true, { transport: eTransport, now: tomorrow() });
      const krasj = r6.results.find((x) => x.agent_id === "n-0000-0001");
      assertEq(
        [krasj, r6.sent_log_reconciliation?.inserted, reconciledFor("krasj@gard-test.no").length],
        [undefined, 0, 1],
        "f9: next day the reserved address is no longer even a candidate (gate sees the reconciled row); the sweep is idempotent",
      );
      assertEq(eTransport.calls.some((c) => c.to === "krasj@gard-test.no"), false, "f10: never e-mailed");
    }

    // ── (g) reserve-before-send fails closed ───────────────────────────────
    freshDb();
    seedProducer("g-1", "Første Gård", "first@gard-test.no");
    seedProducer("g-2", "Andre Gård", "second@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    db.exec(`CREATE TRIGGER t_ledger_insert_fails BEFORE INSERT ON rfb_marketing_send_ledger
             BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(t.calls.length, 0, "g1: reservation write fails → NOTHING is sent");
      assertEq(r.results.length, 1, "g2: the loop stopped at the first failure");
      assertEq([r.results[0].status, (r.results[0].reason ?? "").startsWith("reservation_failed")], ["error", true], "g3: the row reports reservation_failed");
      assertEq(r.stopped_reason, "reservation_failed", "g4: run reports why it stopped");
      assertEq([counts().crm_threads, counts().outreach_daily_send_cap], [0, 0], "g5: no CRM thread, no cap slot consumed");
      const rr = runsRows();
      assertEq([rr.length, rr[0]?.status], [1, "failed"], "g6: envelope recorded as failed");
      assertTrue(String(rr[0]?.errors ?? "").includes("nothing sent, loop stopped"), "g7: envelope errors explain it");
    }
    db.exec(`DROP TRIGGER t_ledger_insert_fails`);

    // ── (h) the 2026-09-27 gårdssalg bug class is NOT copied ───────────────
    freshDb();
    seedProducer("h-1", "Disk Gård", "disk@gard-test.no");
    seedProducer("h-2", "Neste Gård", "neste@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    db.exec(`CREATE TRIGGER t_sent_flip_fails BEFORE UPDATE OF delivery_status ON crm_messages
             WHEN NEW.delivery_status = 'sent'
             BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(t.calls.length, 1, "h1: the e-mail left, then the loop stopped");
      assertEq([r.results[0].status, typeof r.results[0].post_send_error], ["sent", "string"], "h2: reported as SENT with the post-send error");
      assertEq(r.stopped_reason, "post_send_record_failed", "h3: run stops on a failed post-send write");
      assertEq(ledger().map((l) => l.status), ["sent"], "h4: the job's own ledger knows it was sent");
      assertEq(oslFor("disk@gard-test.no"), 0, "h5: compose's trigger never wrote its row (the exact 2026-09-27 gap)…");
      assertEq(
        [r.results[0].sent_log_reconciled, reconciledFor("disk@gard-test.no").map((x) => [x.agent_id, x.notes, x.vertical_id, x.channel])],
        ["inserted", [["h-1", "rfb-marketing-platform:post_send_reconciled", "rfb", "email"]]],
        "h5c: …so the job reconciled it into outreach_sent_log at finalize time (N-A)",
      );
      assertEq(runsRows()[0]?.status, "partial", "h5b: envelope 'partial' — something was sent, then the run stopped");
      db.exec(`DROP TRIGGER t_sent_flip_fails`);
      const gateAgain = aoc.computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
      assertEq(
        gateAgain.candidates.some((c) => c.email === "disk@gard-test.no"),
        false,
        "h6: the gate alone no longer selects the address (before N-A it did — only the ledger kept it out)",
      );
      const next = await run(true, { transport: t, now: tomorrow() });
      assertEq(
        [next.results.find((x) => x.agent_id === "h-1"), next.sent_log_reconciliation?.inserted],
        [undefined, 0],
        "h7: next day it is not a candidate at all; nothing left to reconcile",
      );
      assertEq(t.calls.filter((c) => c.to === "disk@gard-test.no").length, 1, "h8: the producer got exactly ONE e-mail");
      assertEq(t.calls.filter((c) => c.to === "neste@gard-test.no").length, 1, "h9: the rest of the list still goes out");
    }

    // ── (i) ledger UPDATE fails after a send ───────────────────────────────
    freshDb();
    seedProducer("i-1", "Ledger Gård", "ledger@gard-test.no");
    seedProducer("i-2", "Etter Gård", "etter@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    db.exec(`CREATE TRIGGER t_ledger_update_fails BEFORE UPDATE ON rfb_marketing_send_ledger
             BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(t.calls.length, 1, "i1: one e-mail, then stop");
      assertEq([r.results[0].status, r.results[0].ledger_recorded], ["sent", false], "i2: sent, ledger update reported as failed");
      assertEq(r.stopped_reason, "ledger_update_failed", "i3: run stops when the ledger cannot be written");
      assertEq(ledger().map((l) => l.status), ["reserved"], "i4: the row stays 'reserved'");
      assertEq(runsRows()[0]?.status, "partial", "i4b: envelope 'partial'");
      db.exec(`DROP TRIGGER t_ledger_update_fails`);
      const again = await run(true, { transport: t });
      assertEq(again.sent_today_before, 1, "i5: the reserved row counts as today's send (not double-counted with its sent-log row)");
      assertEq(
        [again.results.some((x) => x.agent_id === "i-1"), oslFor("ledger@gard-test.no")],
        [false, 1],
        "i6: compose's own records (outreach_sent_log) keep it out of the gate — the ledger is a second, independent memory",
      );
      assertEq(t.calls.map((c) => c.to), ["ledger@gard-test.no", "etter@gard-test.no"], "i7: only the other producer is sent on the retry");
    }

    // A transport failure AFTER the hand-off has an UNKNOWN outcome (the
    // server may have accepted DATA before the error came back). AT MOST
    // ONCE: the address counts as contacted — today's budget and the cooldown
    // block — it is never retried, and the run stops at the first such failure.
    freshDb();
    seedProducer("i-3", "Feil Gård", "feil@gard-test.no");
    seedProducer("i-4", "Frisk Gård", "frisk@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const failingCalls: string[] = [];
      const failing = {
        calls: [] as Array<Record<string, any>>,
        sendRaw: async (o: any) => {
          failingCalls.push(o.to);
          return o.to === "feil@gard-test.no"
            ? { success: false, error: "smtp 451 try later" }
            : { success: true, messageId: "stub-frisk" };
        },
      };
      const r = await run(true, { transport: failing as any });
      assertEq(
        r.results.map((x) => [x.agent_id, x.status, x.reason ?? null, x.ledger_status ?? null]),
        [["i-3", "unknown", "transport_failed:smtp 451 try later", "unknown"]],
        "i8: a transport failure is an UNKNOWN delivery (never 'error'-and-retry, never 'sent')",
      );
      assertEq([r.stopped_reason, failingCalls], ["transport_failed", ["feil@gard-test.no"]], "i9: the run stops at the first transport failure — the next address is not tried");
      assertEq([ledger().map((l) => l.status), r.summary.unknown, r.summary.sent], [["unknown"], 1, 0], "i10: ledger 'unknown'; the summary counts it as unknown, not sent");
      const env = runsRows()[0];
      const unknownClaim = (JSON.parse(env.claims) as Array<any>).find((c) => c.meta?.kind === "rfb_marketing_unknown_delivery");
      assertEq([env.status, unknownClaim?.value, unknownClaim?.meta?.agent_ids], ["failed", 1, ["i-3"]], "i11: envelope 'failed' (nothing confirmed), the unknown delivery is a claim");
      const t = makeTransport();
      const same = await run(true, { transport: t });
      assertEq(same.sent_today_before, 1, "i12: the unknown delivery counts toward today's budget");
      assertEq(
        [r.results[0].sent_log_reconciled, reconciledFor("feil@gard-test.no").map((x) => [x.agent_id, x.message_id.startsWith("rfb-ledger-"), x.notes])],
        ["inserted", [["i-3", true, "rfb-marketing-platform:unknown_delivery"]]],
        "i12b: the unknown delivery is written into outreach_sent_log at finalize time (N-A)",
      );
      assertEq(same.results.find((x) => x.agent_id === "i-3"), undefined, "i13: no second attempt at the same address the same day (the gate no longer offers it)");
      assertEq(t.calls.map((c) => c.to), ["frisk@gard-test.no"], "i14: the same-day rerun sends only the producer never tried");
      const nextDay = await run(true, { transport: t, now: tomorrow() });
      assertEq(
        [nextDay.results.find((x) => x.agent_id === "i-3"), nextDay.skipped_reason],
        [undefined, "no_candidates"],
        "i15: next day the unknown address is not offered at all (outreach_sent_log) — not retried",
      );
      assertEq(failingCalls.concat(t.calls.map((c) => c.to)), ["feil@gard-test.no", "frisk@gard-test.no"], "i16: feil@ was handed to the transport exactly once, ever");
    }

    // B1 regression: an AMBIGUOUS failure — the connection drops after DATA,
    // sendRaw throws — on day 1 → no e-mail to that address on day 2.
    freshDb();
    seedProducer("v-1", "Tvil Gård", "tvil@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const wire: string[] = [];
      const dropping = {
        calls: [] as Array<Record<string, any>>,
        sendRaw: async (o: any): Promise<{ success: boolean; messageId?: string; error?: string }> => {
          wire.push(o.to);
          throw new Error("socket hang up after DATA");
        },
      };
      const d1 = await run(true, { transport: dropping as any });
      assertEq(
        [d1.results[0]?.status, d1.results[0]?.reason, d1.stopped_reason],
        ["unknown", "transport_failed:socket hang up after DATA", "transport_failed"],
        "i17: day 1 — a thrown transport error is an unknown delivery",
      );
      const sameDay = await run(true, { transport: makeTransport() });
      assertEq(sameDay.skipped_reason, "daily_cap_already_sent", "i18: it used today's budget (cap 1)");
      const t2 = makeTransport();
      const d2 = await run(true, { transport: t2, now: tomorrow() });
      assertEq(
        [t2.calls.length, d2.results.find((x) => x.agent_id === "v-1"), reconciledFor("tvil@gard-test.no").length],
        [0, undefined, 1],
        "i19: day 2 — no e-mail to that address (reconciled into outreach_sent_log on day 1)",
      );
      assertEq(wire, ["tvil@gard-test.no"], "i20: exactly one hand-off to the transport, ever");
    }

    // B2: a transport that keeps failing is tried ONCE per run — not once per
    // candidate: no hammering, no CRM thread per address, and the one address
    // it was handed stays blocked.
    freshDb();
    const b2Names = ["Aust", "Berg", "Dal", "Eng", "Fjell"];
    b2Names.forEach((n, i) => seedProducer(`x-${i + 1}`, `${n} Gård`, `${n.toLowerCase()}@gard-test.no`));
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "10" });
    {
      const wire: string[] = [];
      const broken = {
        calls: [] as Array<Record<string, any>>,
        sendRaw: async (o: any) => {
          wire.push(o.to);
          return { success: false, error: "smtp 421 service not available" };
        },
      };
      const r = await run(true, { transport: broken as any });
      assertEq([wire.length, r.compose_attempts, r.stopped_reason], [1, 1, "transport_failed"], "i21: five candidates, failing transport → exactly ONE attempt, then stop");
      assertEq(counts().crm_threads, 1, "i22: exactly one CRM thread (not one per candidate)");
      assertEq(ledger().map((l) => [l.recipient_email, l.status]), [["aust@gard-test.no", "unknown"]], "i23: one ledger row, 'unknown'");
      const t = makeTransport();
      const next = await run(true, { transport: t, now: tomorrow() });
      assertEq(
        [next.results.find((x) => x.agent_id === "x-1"), reconciledFor("aust@gard-test.no").length],
        [undefined, 1],
        "i24: next day the address it was handed is not offered again (reconciled)",
      );
      assertEq(
        t.calls.map((c) => c.to),
        ["berg@gard-test.no", "dal@gard-test.no", "eng@gard-test.no", "fjell@gard-test.no"],
        "i25: …and only the four never-tried producers are e-mailed",
      );
    }

    // ── (j) G3 — bounce / complaint → auto-pause ───────────────────────────
    {
      const seedRecentSend = (email: string, hoursAgo: number, vertical = "rfb") =>
        db
          .prepare(
            `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
             VALUES ('x', ?, datetime('now', ?), 'email', ?, 'test:recent', ?)`,
          )
          .run(email, `-${hoursAgo} hours`, `recent-${email}-${hoursAgo}`, vertical);
      const bounce = (email: string, type: string) =>
        Number(
          db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES (?, ?, ?)`).run(email, new Date().toISOString(), type)
            .lastInsertRowid,
        );

      // dry run first: detects, never writes the pause
      freshDb();
      seedProducer("j-1", "Mottaker Gård", "mottaker@gard-test.no");
      seedRecentSend("old@gard-test.no", 2);
      const bId = bounce("old@gard-test.no", "hard");
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
      const t = makeTransport();
      const dry = await run(false, { transport: t });
      assertEq([dry.skipped_reason, dry.auto_paused, daily.getRfbMarketingLaneState(db).paused], ["bounce_or_complaint_recent", false, false], "j1: dry run detects the bounce but does not pause");

      const r = await run(true, { transport: t });
      const lane = daily.getRfbMarketingLaneState(db);
      assertEq([r.skipped_reason, r.auto_paused, lane.paused], ["bounce_or_complaint_recent", true, true], "j2: apply → auto-pause + skip");
      assertEq(r.recent_bounces.map((b) => [b.recipient_email, b.bounce_type]), [["old@gard-test.no", "hard"]], "j3: names the bounced recipient");
      assertTrue(String(lane.reason).includes("old@gard-test.no") && lane.changed_by === "rfb-marketing-platform", "j4: pause reason names the address and the job");
      assertEq(lane.bounce_ack_max_id, bId, "j5: the bounce is recorded as acted on");
      assertEq(t.calls.length, 0, "j6: nothing sent");

      // Daniel clears the pause → the SAME bounce must not re-pause the lane.
      await callRoute(adminRoutes.rfbMarketingLaneRouter as any, { method: "POST", headers: auth, body: { paused: false, by: "daniel" } });
      assertEq(daily.getRfbMarketingLaneState(db).bounce_ack_max_id, bId, "j7: unpausing keeps the acknowledgement");
      const after = await run(true, { transport: t });
      assertEq([after.skipped_reason, after.summary.sent], [null, 1], "j8: acknowledged bounce does not re-trigger; the run sends");

      // A NEW complaint on the address just mailed → pause again.
      const b2 = bounce("mottaker@gard-test.no", "complaint");
      const again = await run(true, { transport: t, now: tomorrow() });
      assertEq([again.skipped_reason, again.auto_paused, daily.getRfbMarketingLaneState(db).bounce_ack_max_id], ["bounce_or_complaint_recent", true, b2], "j9: a new complaint on a recent recipient re-pauses");

      // Not fresh: soft bounce, send older than 48h, another platform's send.
      freshDb();
      seedRecentSend("soft@gard-test.no", 1);
      bounce("soft@gard-test.no", "soft");
      seedRecentSend("gammel@gard-test.no", 72);
      bounce("gammel@gard-test.no", "hard");
      seedRecentSend("opplev@gard-test.no", 1, "experiences");
      bounce("opplev@gard-test.no", "hard");
      assertEq(daily.findRfbMarketingRecentBounces(db, new Date(), null), [], "j10: soft / >48h / non-rfb sends never trigger");
    }

    // ── (k) G3 — health red ────────────────────────────────────────────────
    freshDb();
    seedProducer("k-1", "Helse Gård", "helse@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const t = makeTransport();
      const red = () => ({ red: true, reasons: ["data volume 96% full"], rss_mb: 200, disk_used_pct: 96 });
      const r = await run(true, { transport: t, health: red });
      assertEq([r.skipped_reason, t.calls.length, daily.getRfbMarketingLaneState(db).paused], ["health_red", 0, false], "k1: red → skip, nothing sent, lane NOT paused (transient)");
      assertEq(r.health?.reasons, ["data volume 96% full"], "k2: the reason is reported");
      const c = daily.classifyRfbMarketingHealth;
      assertEq([c({ rssMb: 421, diskUsedPct: 10 }).red, c({ rssMb: 420, diskUsedPct: 10 }).red], [true, false], "k3: memory threshold mirrors /health (> 420MB)");
      assertEq([c({ rssMb: 100, diskUsedPct: 95 }).red, c({ rssMb: 100, diskUsedPct: 94.9 }).red], [true, false], "k4: disk threshold mirrors /health (>= 95%)");
      assertEq(c({ rssMb: null, diskUsedPct: null }).red, false, "k5: an unreadable signal is not red");
      const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
      assertTrue(indexSrc.includes(`memUsedMb > ${daily.HEALTH_CRITICAL_RSS_MB}) { status = "critical"`), "k6: drift guard — /health's memory-critical threshold equals the mirror");
      assertTrue(indexSrc.includes(`disk.used_pct >= ${daily.HEALTH_CRITICAL_DISK_USED_PCT}) { status = "critical"`), "k7: drift guard — /health's disk-critical threshold equals the mirror");
      const consumes = daily.rfbMarketingRunConsumesWindow;
      assertEq(
        [consumes({ skipped_reason: "health_red" }), consumes({ skipped_reason: "run_in_progress" }), consumes({ skipped_reason: null }), consumes({ skipped_reason: "paused" })],
        [false, false, true, true],
        "k8: a health_red (or run_in_progress) skip does not use up the day's tick window",
      );
      assertTrue(indexSrc.includes("if (rfbMarketingRunConsumesWindow(r)) lastRfbMarketingRunAt = now;"), "k9: the 08:10Z tick stamps lastRunAt only through that rule");
    }

    // ── (l) G4 — budget from the database ──────────────────────────────────
    freshDb();
    seedProducer("l-1", "Budsjett En", "b1@gard-test.no");
    seedProducer("l-2", "Budsjett To", "b2@gard-test.no");
    seedProducer("l-3", "Budsjett Tre", "b3@gard-test.no");
    {
      const today = day(new Date());
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3", OUTREACH_MAX_PER_DAY: "2" });
      db.prepare(`INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 1)`).run(today);
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq([r.outreach_reserved_today, r.budget, r.summary.sent], [1, 1, 1], "l1: budget never exceeds what is left of OUTREACH_MAX_PER_DAY");
      const r2 = await run(true, { transport: t });
      assertEq([r2.skipped_reason, t.calls.length], ["outreach_max_per_day_reached", 1], "l2: global cap spent → skipped");

      freshDb();
      seedProducer("l-4", "Budsjett Fire", "b4@gard-test.no");
      seedProducer("l-5", "Budsjett Fem", "b5@gard-test.no");
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "2" });
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
         VALUES ('manual', 'manuell@annen.no', datetime('now'), 'email', 'manual-1', 'auto:cold_outreach_confirm_v2', 'rfb')`,
      ).run();
      const t2 = makeTransport();
      const r3 = await run(true, { transport: t2 });
      assertEq([r3.sent_today_before, r3.budget, t2.calls.length], [1, 1, 1], "l3: an RFB send made elsewhere today shrinks the budget");
    }

    // ── (m) OUTREACH_PAUSED ────────────────────────────────────────────────
    freshDb();
    seedProducer("m-1", "Pause Gård", "pause@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", OUTREACH_PAUSED: "true" });
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq([r.skipped_reason, t.calls.length], ["outreach_paused", 0], "m1: the global kill-switch stops the job (the gate returns paused)");
    }

    // ── (n) held + refused rows; the budget backfills ─────────────────────
    freshDb();
    seedProducer("n-1", "Engelsk Gård", "english@gard-test.no", { about: ENGLISH_ABOUT });
    seedProducer("n-2", "Kort Gård", "kort@gard-test.no", {
      about: "Liten gård.",
      products: JSON.stringify([{ name: "Egg" }, { name: "Honning" }, { name: "Ull" }]),
    });
    // Three old Opplevagent sends: passes the RFB first-touch gate (the pool only
    // excludes rfb sends; outside the cross-platform window), but compose's
    // max-touch-vern (any vertical, no reply ever) refuses the send.
    seedProducer("n-3", "Mye Kontaktet Gård", "maxtouch@gard-test.no", {
      priorSends: [
        { daysAgo: 100, vertical: "experiences" },
        { daysAgo: 130, vertical: "experiences" },
        { daysAgo: 160, vertical: "experiences" },
      ],
    });
    seedProducer("n-4", "God Gård", "god@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(
        r.results.map((x) => [x.agent_id, x.status, x.reason ?? null]),
        [
          ["n-1", "skipped", "held_for_reenrichment:not_norwegian"],
          ["n-2", "skipped", "held_for_reenrichment:for_kort"],
          ["n-3", "refused", "compose_refused:max_touch_suppressed"],
          ["n-4", "sent", null],
        ],
        "n1: held and refused candidates are rows; the next candidate fills the budget",
      );
      assertEq(r.held_for_reenrichment.map((h) => [h.agent_id, h.reason]), [["n-1", "not_norwegian"], ["n-2", "for_kort"]], "n2: held list in the SKILL's held-for-reenrichment vocabulary");
      assertEq([r.summary.sent, r.summary.held, r.summary.refused, r.stopped_reason], [1, 2, 1, null], "n3: summary; a per-recipient refusal does not stop the loop");
      assertEq(ledger().map((l) => [l.recipient_email, l.status]), [["maxtouch@gard-test.no", "refused"], ["god@gard-test.no", "sent"]], "n4: the refused attempt is in the ledger as refused (not counted, not blocking)");
      assertEq(t.calls.map((c) => c.to), ["god@gard-test.no"], "n5: only the good candidate was e-mailed");
      const env = runsRows()[0];
      const claims = JSON.parse(env.claims) as Array<any>;
      const byKind = (k: string) => claims.find((c) => c.meta?.kind === k);
      assertEq(
        [byKind("rfb_marketing_held_for_reenrichment")?.value, byKind("rfb_marketing_held_for_reenrichment")?.meta?.held],
        [2, r.held_for_reenrichment],
        "n6: the envelope carries the held-for-reenrichment list (the routine's held-for-reenrichment.json)",
      );
      assertEq(byKind("rfb_marketing_gate_summary")?.meta?.gate, r.gate, "n7: the envelope carries the gate's suppression summary");
      assertEq([r.gate?.cooldown_days, r.gate?.first?.count, byKind("rfb_marketing_unknown_delivery")?.value], [60, 4, 0], "n8: gate summary + an unknown-delivery claim (0)");
      assertEq(env.status, "completed", "n9: refusals and held rows alone keep the envelope 'completed'");
    }

    // ── (u) the compose-attempt cap ────────────────────────────────────────
    // Pre-transport refusals (4xx) do not use the budget, so a streak of them
    // is bounded at budget + RFB_MARKETING_EXTRA_COMPOSE_ATTEMPTS compose calls.
    freshDb();
    {
      const extra = daily.RFB_MARKETING_EXTRA_COMPOSE_ATTEMPTS;
      const maxTouched = [
        { daysAgo: 100, vertical: "experiences" },
        { daysAgo: 130, vertical: "experiences" },
        { daysAgo: 160, vertical: "experiences" },
      ];
      for (let i = 1; i <= extra + 2; i++) {
        seedProducer(`y-${i}`, `Nekt Gård ${String.fromCharCode(64 + i)}`, `nekt${i}@gard-test.no`, { priorSends: maxTouched });
      }
      seedProducer("y-good", "Siste Gård", "siste@gard-test.no");
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq([r.budget, r.max_compose_attempts, r.compose_attempts], [1, 1 + extra, 1 + extra], "u1: at most budget + margin compose calls in one run");
      assertEq([r.stopped_reason, r.summary.refused, t.calls.length], ["attempt_cap_reached", 1 + extra, 0], "u2: a streak of refusals stops at the cap; nothing sent");
      assertEq(
        [ledger().length, ledger().every((l) => l.status === "refused")],
        [1 + extra, true],
        "u3: every attempt is a 'refused' ledger row; no reservation is left dangling at the cap",
      );
    }

    // ── (v) a database error mid-run → db_error, envelope still written ────
    freshDb();
    seedProducer("z-1", "Tabell Gård", "tabell@gard-test.no");
    seedProducer("z-2", "Borte Gård", "borte@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const t = makeTransport();
      const dropping = {
        calls: t.calls,
        sendRaw: async (o: any) => {
          if (t.calls.length === 0) db.exec(`DROP TABLE rfb_marketing_lane_state`);
          return t.sendRaw(o);
        },
      };
      const r = await run(true, { transport: dropping as any });
      assertEq([r.summary.sent, r.stopped_reason, t.calls.length], [1, "db_error", 1], "v1: a read failing mid-run stops the loop as db_error (after the one send)");
      const errRow = r.results.find((x) => x.agent_id === "z-2");
      assertEq([errRow?.status, String(errRow?.reason ?? "").startsWith("db_error: ")], ["error", true], "v2: the candidate it stopped at is an error row");
      assertEq([r.envelope_recorded, runsRows()[0]?.status], [true, "partial"], "v3: the envelope is still written — 'partial'");
    }
    freshDb();
    seedProducer("z-3", "Andre Runde Gård", "runde@gard-test.no", { secondTouchDaysAgo: 90 });
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    db.exec(`DROP TABLE outreach_max_touch_vern_config`);
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq([r.gate?.first?.count, r.stopped_reason, t.calls.length], [0, "db_error", 0], "v4: the mode=second gate throwing is db_error; nothing sent");
      assertTrue(r.errors.some((e) => e.startsWith("gate (mode=second) failed")), "v5: the error names the gate");
      assertEq([r.envelope_recorded, runsRows()[0]?.status], [true, "failed"], "v6: the envelope is still written — 'failed'");
    }

    // ── (w) mid-run pause; the cap re-checked inside the reservation ───────
    freshDb();
    seedProducer("pm-1", "Pause En", "pm1@gard-test.no");
    seedProducer("pm-2", "Pause To", "pm2@gard-test.no");
    seedProducer("pm-3", "Pause Tre", "pm3@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const t = makeTransport();
      const pausing = {
        calls: t.calls,
        sendRaw: async (o: any) => {
          if (t.calls.length === 0) daily.setRfbMarketingLanePaused(db, { paused: true, by: "daniel", reason: "stopp nå" });
          return t.sendRaw(o);
        },
      };
      const r = await run(true, { transport: pausing as any });
      assertEq([t.calls.length, r.summary.sent, r.stopped_reason], [1, 1, "paused_mid_run"], "w1: a pause set mid-run → exactly one send, then paused_mid_run");
      assertEq([ledger().length, runsRows()[0]?.status], [1, "partial"], "w2: no further reservation; envelope 'partial'");
    }
    freshDb();
    seedProducer("cc-1", "Kappløp En", "cc1@gard-test.no");
    seedProducer("cc-2", "Kappløp To", "cc2@gard-test.no");
    seedProducer("cc-3", "Kappløp Tre", "cc3@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "2" });
    {
      const t = makeTransport();
      const racing = {
        calls: t.calls,
        sendRaw: async (o: any) => {
          if (t.calls.length === 0) {
            // A manual RFB compose recorded while this run is in flight.
            db.prepare(
              `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
               VALUES ('manual', 'manuell@annen.no', datetime('now'), 'email', 'manual-race', 'auto:cold_outreach_confirm_v2', 'rfb')`,
            ).run();
          }
          return t.sendRaw(o);
        },
      };
      const r = await run(true, { transport: racing as any });
      assertEq([r.budget, t.calls.length, r.stopped_reason], [2, 1, "daily_cap_reached"], "w3: budget 2 at the start, a concurrent send took the second slot → daily_cap_reached after one send");
      assertEq(ledger().map((l) => l.status), ["sent"], "w4: the transaction refused the reservation past the cap");
    }

    // ── (x) no_sendable_candidates; the ledger blocks by agent too ─────────
    freshDb();
    seedProducer("nn-1", "Engelsk To", "eng2@gard-test.no", { about: ENGLISH_ABOUT });
    seedProducer("nn-2", "Kort To", "kort2@gard-test.no", {
      about: "Liten gård.",
      products: JSON.stringify([{ name: "Egg" }, { name: "Honning" }, { name: "Ull" }]),
    });
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq([r.skipped_reason, r.summary.held, t.calls.length], ["no_sendable_candidates", 2, 0], "x1: candidates returned but all held → no_sendable_candidates (not no_candidates)");
      assertEq(r.gate?.first?.count, 2, "x2: …the gate did return them");
    }
    freshDb();
    seedProducer("ag-1", "Ny Adresse Gård", "ny@gard-test.no");
    seedProducer("ag-2", "Samme Dag Gård", "samme-ny@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const insLedger = db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES (?, 'run-old', ?, ?, 'first', 'A', ?, ?)`,
      );
      const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
      insLedger.run(day(tenDaysAgo), "ag-1", "gammel@gard-test.no", "sent", tenDaysAgo.toISOString());
      insLedger.run(day(new Date()), "ag-2", "samme-gammel@gard-test.no", "refused", new Date().toISOString());
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(
        r.results.map((x) => [x.agent_id, x.reason ?? null]),
        [["ag-1", "recently_contacted_by_platform_job"], ["ag-2", "already_attempted_today"]],
        "x3: blocked by agent_id — an address changed inside the cooldown, and a second address the same day",
      );
      assertEq(t.calls.length, 0, "x4: nothing sent");
    }

    // ── (z) pre-send homepage refresh ──────────────────────────────────────
    const THIN = "Gård.";
    // Products keep a thin profile inside the gate's content threshold, so it
    // reaches the job's own content check (same as block (n)).
    const PRODUCTS3 = JSON.stringify([{ name: "Egg" }, { name: "Honning" }, { name: "Ull" }]);
    const recorder = (impl?: (db: any, agentId: string) => Promise<any> | any) => {
      const calls: Array<{ agentId: string; deadlineAt: number; at: number }> = [];
      const fn = async (d: any, agentId: string, o: { deadlineAt: number }) => {
        calls.push({ agentId, deadlineAt: o.deadlineAt, at: Date.now() });
        if (impl) return impl(d, agentId);
        return { outcome: "unchanged", ms: 0 };
      };
      return { calls, fn };
    };
    const runZ = (apply: boolean, deps: Record<string, any>, t = makeTransport()) =>
      daily.runRfbMarketingDaily({ apply, trigger: "manual", now: new Date(), deps: { sendRaw: t.sendRaw, healthProbe: healthy, ...deps } });

    freshDb();
    seedProducer("z-1", "En Gård", "en@gard-test.no");
    seedProducer("z-2", "To Gård", "to@gard-test.no");
    seedProducer("z-3", "Tre Gård", "tre@gard-test.no");
    seedProducer("z-4", "Fire Gård", "fire@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "2" });
    {
      // z-1 already mailed by this job today (ledger) → skipped before any crawl.
      db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES (?, 'run-earlier', 'z-1', 'en@gard-test.no', 'first', 'A', 'refused', ?)`,
      ).run(day(new Date()), new Date().toISOString());
      const dryRec = recorder();
      const dry = await runZ(false, { homepageRefresh: dryRec.fn });
      assertEq([dryRec.calls.length, dry.homepage_refresh?.mode, dry.homepage_refresh?.attempted], [0, "skipped_dry_run", 0], "z1: a dry run never refreshes (a refresh writes)");
      const rec = recorder();
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn }, t);
      assertEq(rec.calls.map((c) => c.agentId), ["z-2", "z-3"], "z2: refreshed exactly the candidates that were then sent — not the ledger-blocked one, not the rest of the list");
      assertEq(t.calls.map((c) => c.to), ["to@gard-test.no", "tre@gard-test.no"], "z3: …and those two were sent (cap 2)");
      assertEq(
        [r.homepage_refresh?.mode, r.homepage_refresh?.attempted, r.homepage_refresh?.unchanged, r.homepage_refresh?.max_refreshes],
        ["applied", 2, 2, 2 + daily.RFB_MARKETING_EXTRA_REFRESHES],
        "z4: refresh summary in the report (max = budget + extra)",
      );
      assertTrue(
        rec.calls.every((c) => c.deadlineAt > c.at && c.deadlineAt - c.at <= daily.RFB_MARKETING_REFRESH_PER_CANDIDATE_MS),
        "z5: each refresh gets a per-candidate deadline ≤ RFB_MARKETING_REFRESH_PER_CANDIDATE_MS",
      );
      assertEq(r.results.find((x) => x.agent_id === "z-2")?.homepage_refresh?.outcome, "unchanged", "z6: the outcome is on the result row");
      const claim = (JSON.parse(runsRows()[0].claims) as Array<any>).find((c) => c.meta?.kind === "rfb_marketing_homepage_refresh");
      assertEq([claim?.meta?.summary?.attempted, claim?.meta?.rows?.map((x: any) => x.agent_id)], [2, ["z-2", "z-3"]], "z7: the envelope carries the refresh outcomes");
    }

    // Fresh content decides held vs sent: the refresh runs BEFORE the content check.
    freshDb();
    seedProducer("z-5", "Tynn Gård", "tynn@gard-test.no", { about: THIN, description: THIN, products: PRODUCTS3 });
    seedProducer("z-6", "Tynn Igjen", "tynnigjen@gard-test.no", { about: THIN, description: THIN, products: PRODUCTS3 });
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const rec = recorder((d, agentId) => {
        if (agentId === "z-5") {
          d.prepare(`UPDATE agent_knowledge SET about = ? WHERE agent_id = ?`).run(GOOD_ABOUT, agentId);
          return { outcome: "refreshed", fields: ["about"], ms: 1 };
        }
        return { outcome: "unchanged", ms: 1 };
      });
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn }, t);
      assertEq(
        r.results.map((x) => [x.agent_id, x.status, x.reason ?? null]),
        [["z-5", "sent", null], ["z-6", "skipped", "held_for_reenrichment:for_kort"]],
        "z8: the refreshed profile passes the content check and is sent; the unrefreshed thin one is held",
      );
      assertEq([r.homepage_refresh?.refreshed, r.homepage_refresh?.by_field], [1, { about: 1 }], "z9: refreshed count + by_field");
      assertEq(r.held_for_reenrichment.map((h) => h.agent_id), ["z-6"], "z10: held list after refresh");
    }

    // A failed / throwing refresh never blocks the send and never marks the run troubled.
    freshDb();
    seedProducer("z-7", "Feil Refresh", "feilrefresh@gard-test.no");
    seedProducer("z-8", "Kast Refresh", "kastrefresh@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const rec = recorder((_d, agentId) => {
        if (agentId === "z-8") throw new Error("boom");
        return { outcome: "failed", error: "fetch_failed:http_404 (permanent) for https://gard-test.no", ms: 3 };
      });
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn }, t);
      assertEq(t.calls.map((c) => c.to), ["feilrefresh@gard-test.no", "kastrefresh@gard-test.no"], "z11: both sent despite a failed and a throwing refresh");
      assertEq(
        [r.results[1].homepage_refresh?.outcome, (r.results[1].homepage_refresh?.error ?? "").startsWith("refresh_threw"), r.homepage_refresh?.failed],
        ["failed", true, 2],
        "z12: a thrown refresh is reported as failed",
      );
      assertEq([runsRows()[0].status, r.errors], ["completed", []], "z13: refresh failures do not make the run partial/failed");
    }

    // Bounded: the refresh COUNT (held candidates spend refreshes) and the TOTAL time budget.
    freshDb();
    for (let i = 1; i <= 12; i++) seedProducer(`zb-${String(i).padStart(2, "0")}`, `Tynn ${i}`, `tynn${i}@gard-test.no`, { about: THIN, description: THIN, products: PRODUCTS3 });
    seedProducer("zb-13", "God Gård", "god@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const rec = recorder();
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn }, t);
      const max = 1 + daily.RFB_MARKETING_EXTRA_REFRESHES;
      assertEq(
        [rec.calls.length, r.homepage_refresh?.attempted, r.homepage_refresh?.skipped_refresh_budget, t.calls.map((c) => c.to)],
        [max, max, 13 - max, ["god@gard-test.no"]],
        "z14: at most budget + RFB_MARKETING_EXTRA_REFRESHES refreshes; the rest go on with the content they have (the good one is still sent)",
      );
    }
    freshDb();
    for (let i = 1; i <= 4; i++) seedProducer(`zt-${i}`, `Tid ${i}`, `tid${i}@gard-test.no`);
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "4" });
    {
      const rec = recorder(async () => {
        await new Promise((res) => setTimeout(res, 70));
        return { outcome: "unchanged", ms: 70 };
      });
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn, refreshLimits: { perCandidateMs: 1000, totalBudgetMs: 100 } }, t);
      assertEq(
        [rec.calls.length, r.homepage_refresh?.skipped_refresh_budget, t.calls.length],
        [2, 2, 4],
        "z15: the total time budget stops refreshing (not sending) once spent",
      );
      const first = rec.calls[0];
      assertTrue(rec.calls[1].deadlineAt <= first.at + 100 + 5, "z16: a refresh started late in the budget gets a deadline clamped to the run's budget");
    }

    // The REAL refresh path (refreshHomepageContent) with a stub fetch:
    // content written from the homepage, curated locks kept, write-pause honoured, timeout.
    freshDb();
    seedProducer("zr-1", "Hjemmeside Gård", "hjemme@gard-test.no", { about: THIN, description: THIN, products: PRODUCTS3 });
    seedProducer("zr-2", "Låst Gård", "laast@gard-test.no", { about: THIN, description: THIN, products: PRODUCTS3 });
    db.prepare(`UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = 'zr-2'`).run(JSON.stringify({ about: true, description: true }));
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const fetched: string[] = [];
      const siteFetch = (async (url: string) => {
        const u = new URL(url);
        fetched.push(u.pathname);
        return u.pathname === "/" || u.pathname === "" ? htmlPage(GOOD_ABOUT) : new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const t = makeTransport();
      const r = await runZ(true, { refreshFetchImpl: siteFetch }, t);
      const r1 = r.results.find((x) => x.agent_id === "zr-1");
      const r2 = r.results.find((x) => x.agent_id === "zr-2");
      assertEq([r1?.homepage_refresh?.outcome, r1?.status], ["refreshed", "sent"], "z17: real path — the homepage's own text is written, so the thin profile is now sent");
      const k1 = db.prepare(`SELECT about, field_provenance FROM agent_knowledge WHERE agent_id = 'zr-1'`).get() as any;
      assertEq([k1.about, JSON.parse(k1.field_provenance).about?.[0]?.source_type], [GOOD_ABOUT, "website_homepage"], "z18: written with website_homepage provenance (the route's writer)");
      assertEq(
        [r2?.homepage_refresh?.outcome, r2?.homepage_refresh?.curated_locked, r2?.status, r2?.reason],
        ["unchanged", ["about", "description"], "skipped", "held_for_reenrichment:for_kort"],
        "z19: curated/owner-locked about+description are never overwritten — still thin, so held",
      );
      const k2 = db.prepare(`SELECT a.description AS d, k.about AS a FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = 'zr-2'`).get() as any;
      assertEq([k2.a, k2.d], [THIN, THIN], "z20: the locked columns are untouched in the database");
      assertTrue(fetched.length > 0, "z21: the injected fetch (not the network) served the crawl");
      const k1c = db.prepare(`SELECT email FROM agent_knowledge WHERE agent_id = 'zr-1'`).get() as any;
      assertEq(k1c.email, "hjemme@gard-test.no", "z22: contact fields untouched");
    }
    freshDb();
    seedProducer("zp-1", "Pause Gård", "pause@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const ewp = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
      ewp.setEnrichmentWritePause(db, { vertical: "rfb", enabled: true, reason: "test pause" }, "test");
      let fetchCalls = 0;
      const countingFetch = (async () => {
        fetchCalls += 1;
        return htmlPage(GOOD_ABOUT);
      }) as unknown as typeof fetch;
      const t = makeTransport();
      const r = await runZ(true, { refreshFetchImpl: countingFetch }, t);
      assertEq(
        [r.results[0].homepage_refresh?.outcome, r.results[0].homepage_refresh?.error, fetchCalls, r.results[0].status],
        ["write_paused", "test pause", 0, "sent"],
        "z23: enrichment write-pause → no crawl, no write (the route's 423), the send still goes out",
      );
    }
    freshDb();
    seedProducer("zh-1", "Heng Gård", "heng@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const hanging = ((_u: string, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          if (init?.signal?.aborted) return rej(init.signal.reason);
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        })) as unknown as typeof fetch;
      const before = db.prepare(`SELECT about, field_provenance, homepage_fetch_attempts FROM agent_knowledge WHERE agent_id = 'zh-1'`).get();
      const keepAlive = setTimeout(() => undefined, 5000);
      const t0 = Date.now();
      const t = makeTransport();
      const r = await runZ(true, { refreshFetchImpl: hanging, refreshLimits: { perCandidateMs: 150 } }, t);
      clearTimeout(keepAlive);
      assertEq(
        [r.results[0].homepage_refresh?.outcome, r.results[0].status, Date.now() - t0 < 3000],
        ["timeout", "sent", true],
        "z24: a hanging homepage is cut off at the per-candidate deadline and the send goes on",
      );
      assertEq(
        db.prepare(`SELECT about, field_provenance, homepage_fetch_attempts FROM agent_knowledge WHERE agent_id = 'zh-1'`).get(),
        before,
        "z25: …with nothing written (no content, no parking strike)",
      );
    }

    // Hijacked homepage (owner decision 2026-09-29 «2 Ja»): a theme-spam
    // refresh HOLDS the candidate — no reservation, no compose, held with
    // reason hijacked_homepage, counted separately — and the next candidate
    // is still sent. A transient refresh failure still sends.
    freshDb();
    seedProducer("zs-1", "Kapret Gård", "kapret@gard-test.no");
    seedProducer("zs-2", "Ekte Gård", "ekte@gard-test.no");
    seedProducer("zs-3", "Treg Gård", "treg@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "2" });
    {
      const rec = recorder((_d, agentId) => {
        if (agentId === "zs-1") return { outcome: "hijacked", error: "theme_spam_page for https://gard-test.no", ms: 2 };
        if (agentId === "zs-2") return { outcome: "timeout", error: "fetch_failed:timeout (transient) for https://gard-test.no", ms: 2 };
        return { outcome: "failed", error: "fetch_failed:conn_reset (transient) for https://gard-test.no", ms: 2 };
      });
      const t = makeTransport();
      const r = await runZ(true, { homepageRefresh: rec.fn }, t);
      assertEq(
        r.results.map((x) => [x.agent_id, x.status, x.reason ?? null, x.homepage_refresh?.outcome]),
        [
          ["zs-1", "skipped", "held_for_reenrichment:hijacked_homepage", "hijacked"],
          ["zs-2", "sent", null, "timeout"],
          ["zs-3", "sent", null, "failed"],
        ],
        "zs1: a hijacked homepage is held; the next candidates (transient timeout / failure) are still sent",
      );
      assertEq(t.calls.map((c) => c.to), ["ekte@gard-test.no", "treg@gard-test.no"], "zs2: the hijacked candidate is never handed to the transport");
      assertEq(ledger().map((l) => l.recipient_email).includes("kapret@gard-test.no"), false, "zs3: no reservation for the hijacked candidate");
      assertEq(
        db.prepare(`SELECT COUNT(*) AS n FROM outreach_sent_log WHERE LOWER(recipient_email) = 'kapret@gard-test.no' OR agent_id = 'zs-1'`).get(),
        { n: 0 },
        "zs4: nothing recorded as sent for it",
      );
      assertEq(r.compose_attempts, 2, "zs5: the hold spends no compose attempt (and no send budget: cap 2 still sent two)");
      assertEq(
        r.held_for_reenrichment,
        [{ agent_id: "zs-1", name: "Kapret Gård", reason: "hijacked_homepage", description_length: GOOD_ABOUT.trim().length, detail: "theme_spam_page for https://gard-test.no" }],
        "zs6: held for re-enrichment with the reason and the refresh's finding — even though the e-mail domain equals the website domain",
      );
      assertEq(
        [r.summary.held, r.summary.held_hijacked, r.homepage_refresh?.hijacked, r.homepage_refresh?.timeout, r.homepage_refresh?.failed],
        [1, 1, 1, 1, 1],
        "zs7: counted separately in the summary and the refresh summary",
      );
      const claims = JSON.parse(runsRows()[0].claims) as Array<any>;
      const hij = claims.find((c) => c.meta?.kind === "rfb_marketing_held_hijacked_homepage");
      assertEq([hij?.value, hij?.meta?.held?.map((h: any) => h.agent_id)], [1, ["zs-1"]], "zs8: its own envelope claim");
      const heldClaim = claims.find((c) => c.meta?.kind === "rfb_marketing_held_for_reenrichment");
      assertEq(heldClaim?.meta?.held?.map((h: any) => h.reason), ["hijacked_homepage"], "zs9: …and in the held-for-reenrichment claim");
      assertTrue(runsRows()[0].notes.includes("held=1 (hijacked=1)"), "zs10: the envelope notes say so");
      assertEq(runsRows()[0].status, "completed", "zs11: a hold does not make the run partial/failed");
    }
    // The REAL refresh path: the route's own theme-spam page detection → held.
    freshDb();
    seedProducer("zsr-1", "Kasino Gård", "post@kasino-gard.no");
    seedProducer("zsr-2", "Ærlig Gård", "post@aerlig-gard.no");
    db.prepare(`UPDATE agents SET url = 'https://kasino-gard.no' WHERE id = 'zsr-1'`).run();
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const spamPage = () =>
        new Response(
          `<html><head><title>Beste norske casino 2026</title><meta name="description" content="Casino bonus og free spins"></head><body><p>Spill casino med velkomstbonus.</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      const siteFetch = (async (url: string) => {
        const u = new URL(url);
        if (u.hostname === "kasino-gard.no") return spamPage();
        return u.pathname === "/" || u.pathname === "" ? htmlPage(GOOD_ABOUT) : new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      const before = db.prepare(`SELECT about, field_provenance, homepage_fetch_attempts FROM agent_knowledge WHERE agent_id = 'zsr-1'`).get();
      const t = makeTransport();
      const r = await runZ(true, { refreshFetchImpl: siteFetch }, t);
      const r1 = r.results.find((x) => x.agent_id === "zsr-1");
      assertEq(
        [r1?.homepage_refresh?.outcome, r1?.homepage_refresh?.error, r1?.status, r1?.reason],
        ["hijacked", "theme_spam_page for https://kasino-gard.no", "skipped", "held_for_reenrichment:hijacked_homepage"],
        "zs12: real path — the route's theme_spam_page skip holds the candidate",
      );
      assertEq(t.calls.map((c) => c.to), ["post@aerlig-gard.no"], "zs13: …and the next candidate takes the one budget slot");
      assertEq(
        db.prepare(`SELECT about, field_provenance, homepage_fetch_attempts FROM agent_knowledge WHERE agent_id = 'zsr-1'`).get(),
        before,
        "zs14: nothing written from the spam page",
      );
    }

    // ── (N) N-A: possible contacts reconciled into outreach_sent_log ───────
    freshDb();
    seedProducer("na-1", "Ukjent Gård", "ukjent@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      // Day 0 = 61 days ago: the transport fails after the hand-off → 'unknown'.
      const day0 = new Date(Date.now() - 61 * 86400_000);
      const failing = { calls: [] as any[], sendRaw: async () => ({ success: false, error: "smtp 451" }) };
      const r0 = await daily.runRfbMarketingDaily({ apply: true, trigger: "manual", now: day0, deps: { sendRaw: failing.sendRaw as any, healthProbe: healthy } });
      assertEq([r0.results[0]?.status, r0.results[0]?.sent_log_reconciled], ["unknown", "inserted"], "N1: day 0 — unknown delivery, reconciled at finalize time");
      const rec = reconciledFor("ukjent@gard-test.no");
      assertEq(
        [rec.length, rec[0]?.sent_at.slice(0, 10), rec[0]?.sent_at.includes("T")],
        [1, day(day0), false],
        "N2: the reconciled row is dated day 0 in the trigger's SQLite format",
      );
      // Control first: without the reconciled row, the gate WOULD offer the
      // producer as a FIRST touch again once the ledger window is over (the
      // N-A bug). Then the sweep puts the row back (idempotent re-insert).
      db.prepare(`DELETE FROM outreach_sent_log WHERE notes LIKE 'rfb-marketing-platform:%'`).run();
      const bare = aoc.computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
      assertEq(bare.candidates.some((c) => c.agent_id === "na-1"), true, "N3: control — without the reconciled row the gate re-selects it as a first touch");
      assertEq(daily.reconcileRfbMarketingSentLog(db).inserted, 1, "N4: the start-of-run sweep restores it");
      // Day 61: the ledger's 60-day window has passed — only outreach_sent_log remembers.
      const firstGate = aoc.computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
      assertEq(firstGate.candidates.some((c) => c.agent_id === "na-1"), false, "N5: day 61 — the gate's mode=first excludes it");
      const t = makeTransport();
      const r61 = await run(true, { transport: t });
      const again = r61.results.find((x) => x.agent_id === "na-1");
      assertEq(
        [again?.touch, again?.status],
        ["second", "sent"],
        "N5b: day 61 — it comes back only as a legitimate SECOND touch (day 0 counted as the first contact)",
      );
    }
    freshDb();
    seedProducer("na-2", "Idem Gård", "idem@gard-test.no");
    seedProducer("na-3", "Normal Gård", "normal@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const nowIso = new Date().toISOString();
      const ins = db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at, updated_at, error)
         VALUES (?, 'run-x', ?, ?, 'first', 'A', ?, ?, ?, ?)`,
      );
      ins.run(day(new Date()), "na-2", "idem@gard-test.no", "unknown", nowIso, nowIso, "transport_failed:x");
      ins.run(day(new Date(Date.now() - 86400_000)), "ghost-agent", "ghost@nowhere.test", "reserved", nowIso, null, null);
      const s1 = daily.reconcileRfbMarketingSentLog(db);
      const s2 = daily.reconcileRfbMarketingSentLog(db);
      const s3 = daily.reconcileRfbMarketingSentLog(db);
      assertEq(
        [s1.inserted, s1.no_agent, s2.inserted, s2.already_present, s3.inserted, reconciledFor("idem@gard-test.no").length],
        [1, 1, 0, 1, 0, 1],
        "N6: idempotent — three sweeps, one row; an address with no agent on file writes nothing",
      );
      assertEq(
        (db.prepare(`SELECT COUNT(*) AS c FROM outreach_sent_log WHERE recipient_email = 'ghost@nowhere.test'`).get() as any).c,
        0,
        "N7: no_agent → nothing inserted (outreach_sent_log.agent_id is NOT NULL, as for the trigger)",
      );
      // A normal send (compose's trigger row exists) forced into the sweep → already_present, no duplicate.
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(t.calls.map((c) => c.to), ["normal@gard-test.no"], "N8: the reconciled address is not mailed; the other one is");
      db.prepare(`UPDATE rfb_marketing_send_ledger SET error = 'forced' WHERE recipient_email = 'normal@gard-test.no'`).run();
      const s4 = daily.reconcileRfbMarketingSentLog(db);
      assertEq(
        [s4.inserted, oslFor("normal@gard-test.no"), reconciledFor("normal@gard-test.no").length],
        [0, 1, 0],
        "N9: a send compose's trigger already recorded is never duplicated",
      );
      assertEq(r.sent_log_reconciliation?.inserted, 0, "N10: the run's own start sweep found nothing new");
      // Compose's email-keyed (cross-platform) cooldown counts the reconciled row.
      const crm = require("../routes/crm") as typeof import("../routes/crm");
      const c = await crm.executeCompose(
        { to: "idem@gard-test.no", subject: "s", bodyText: "b", intent: "resend_send", category: "marketing", createdBy: "claude", vertical: "rfb" },
        { sendRaw: makeTransport().sendRaw },
      );
      assertEq([c.httpStatus, (c.body as any).error], [429, "cooldown_suppressed"], "N11: compose's cooldown refuses the reconciled address");
    }
    // A sweep that cannot write is reported, never fatal, and retried next run.
    freshDb();
    seedProducer("na-4", "Senere Gård", "senere@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "5" });
    {
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES (?, 'run-y', 'na-4', 'senere@gard-test.no', 'first', 'A', 'reserved', ?)`,
      ).run(day(new Date(Date.now() - 86400_000)), nowIso);
      db.exec(`CREATE TRIGGER t_osl_insert_fails BEFORE INSERT ON outreach_sent_log
               WHEN NEW.notes LIKE 'rfb-marketing-platform:%'
               BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END;`);
      const t = makeTransport();
      const r = await run(true, { transport: t });
      assertEq(
        [r.sent_log_reconciliation?.failed, r.errors.some((e) => e.includes("reconciliation failed")), r.skipped_reason],
        [1, true, "no_sendable_candidates"],
        "N12: a failed sweep is reported and the run carries on (the ledger still blocks the address)",
      );
      db.exec(`DROP TRIGGER t_osl_insert_fails`);
      const r2 = await run(true, { transport: t });
      assertEq([r2.sent_log_reconciliation?.inserted, reconciledFor("senere@gard-test.no").length, t.calls.length], [1, 1, 0], "N13: the next run's sweep writes it");
    }

    // ── (o) in-process mutex ───────────────────────────────────────────────
    freshDb();
    seedProducer("o-1", "Samtidig En", "o1@gard-test.no");
    seedProducer("o-2", "Samtidig To", "o2@gard-test.no");
    seedProducer("o-3", "Samtidig Tre", "o3@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const t = makeTransport();
      const [a, b] = await Promise.all([run(true, { transport: t }), run(true, { transport: t })]);
      assertEq([a.summary.sent, b.skipped_reason], [3, "run_in_progress"], "o1: a concurrent second call is refused, not interleaved");
      assertEq(new Set(t.calls.map((c) => c.to)).size, 3, "o2: three distinct recipients, no duplicate");
      assertEq(runsRows().length, 1, "o3: the refused concurrent call records no envelope");
    }

    // ── (p) POST /admin/rfb-marketing-daily-run ────────────────────────────
    // The route passes no deps, so the default health probe would read THIS
    // test process's memory — replace it for the duration of this block.
    freshDb();
    seedProducer("q-1", "Rute Gård", "rute@gard-test.no");
    daily.__setRfbMarketingHealthProbeForTesting(healthy);
    {
      const router = adminRoutes.rfbMarketingDailyRunRouter as any;
      setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
      const noKey = await callRoute(router, { method: "POST", body: {} });
      assertEq(noKey.status, 403, "p1: no admin key → 403");
      const before = counts();
      const dry = await callRoute(router, { method: "POST", headers: auth, body: {} });
      assertEq([dry.status, dry.body.apply, dry.body.trigger], [200, false, "manual"], "p2: body without apply → dry run");
      assertEq(counts(), before, "p3: the route's default run writes nothing");
      assertEq(dry.body.results?.[0]?.status, "would_send", "p4: dry run lists the candidate");
      setEnv({ RFB_MARKETING_DAILY_CAP: "3" });
      const off = await callRoute(router, { method: "POST", headers: auth, body: { apply: true } });
      assertEq(off.body.skipped_reason, "disabled_by_env", "p5: apply:true with the switch off is still a no-op");
    }
    daily.__setRfbMarketingHealthProbeForTesting(null);

    // ── (q) canonical URL = the agent card's canonicalUrl ──────────────────
    freshDb();
    seedProducer("u-1", "Haugerud Gård (Regenerativt)", "hg@gard-test.no");
    seedProducer("u-2", "Ærlige Øyvind's Gårdsbutikk", "oy@gard-test.no");
    seedProducer("u-3", "—", "dash@gard-test.no");
    db.prepare(`UPDATE agents SET origin = 'self_registered', is_vetted = 0 WHERE id = 'u-2'`).run();
    {
      const marketplaceRouter = require("../routes/marketplace").default as any;
      const layer = (marketplaceRouter.stack as any[]).find((l: any) => l.route?.path === "/agents/:id/card" && l.route.methods?.get);
      const cardHandler = layer.route.stack[layer.route.stack.length - 1].handle;
      const card = (id: string) =>
        new Promise<any>((resolve) => {
          const res: any = {
            statusCode: 200,
            status(c: number) { this.statusCode = c; return this; },
            json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
            setHeader() { return this; },
          };
          cardHandler({ params: { id }, query: {}, headers: {}, protocol: "https", get: (n: string) => (n.toLowerCase() === "host" ? "rettfrabonden.com" : undefined) }, res);
        });
      const c1 = await card("u-1");
      const u1 = daily.resolveRfbCanonicalProfileUrl("u-1");
      assertEq([u1.ok, u1.ok ? u1.url : null], [true, c1.body.canonicalUrl], "q1: same URL as the agent card's canonicalUrl");
      assertEq(c1.body.canonicalUrl, "https://rettfrabonden.com/produsent/haugerud-gard-regenerativt", "q2: å → a (never the aa of a local slugify)");
      db.prepare(`UPDATE agents SET origin = 'discovery', is_vetted = 1 WHERE id = 'u-2'`).run();
      const c2 = await card("u-2");
      const u2 = daily.resolveRfbCanonicalProfileUrl("u-2");
      assertEq(u2.ok ? u2.url : null, c2.body.canonicalUrl, "q3: æ/ø/å name — same URL as the card");
      db.prepare(`UPDATE agents SET origin = 'self_registered', is_vetted = 0 WHERE id = 'u-2'`).run();
      assertEq([(await card("u-2")).status, daily.resolveRfbCanonicalProfileUrl("u-2")], [404, { ok: false, reason: "quarantined" }], "q4: a quarantined agent 404s on the card and is skipped here");
      assertEq(daily.resolveRfbCanonicalProfileUrl("nope"), { ok: false, reason: "agent_not_found" }, "q5: unknown agent");
      assertEq(daily.resolveRfbCanonicalProfileUrl("u-3"), { ok: false, reason: "profile_url_invalid", url: "https://rettfrabonden.com/produsent/" }, "q6: a name with no slug fails validate_profile_url");
    }

    // ── (r) UNIQUE(day, recipient_email) ───────────────────────────────────
    {
      const ins = db.prepare(
        `INSERT INTO rfb_marketing_send_ledger (day, run_id, agent_id, recipient_email, touch, status, reserved_at)
         VALUES ('2026-10-01', 'r', 'a', 'same@gard-test.no', 'first', 'failed', '2026-10-01T08:10:00.000Z')`,
      );
      ins.run();
      let threw = false;
      try {
        ins.run();
      } catch {
        threw = true;
      }
      assertTrue(threw, "r1: a second ledger row for the same address and day is refused by the database");
    }

    // ── (s) default transport wiring through emailService ──────────────────
    freshDb();
    seedProducer("w-1", "Wire Gård", "wire@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "1" });
    {
      const mails: Array<Record<string, any>> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (m: Record<string, any>) => {
          mails.push(m);
          return { messageId: "stub-wire-1" };
        },
      };
      try {
        const r = await daily.runRfbMarketingDaily({ apply: true, trigger: "manual", deps: { healthProbe: healthy } });
        assertEq([r.summary.sent, mails.length], [1, 1], "s1: sent through emailService.sendRaw");
        assertEq(mails[0].from, identity.crmFromHeader("rfb"), "s2: From header on the wire");
        assertEq(mails[0].replyTo, identity.resolveCrmIdentity("rfb").replyTo, "s3: Reply-To on the wire");
        assertTrue(String(mails[0].text).startsWith("Hei,\n\nJeg har laget en profil for Wire Gård"), "s4: plain-text part is the template");
        assertTrue(String(mails[0].html).includes("Wire Gård") && String(mails[0].html).includes("<p>"), "s5: html part derived from it");
        assertEq(r.results[0].message_id, "stub-wire-1", "s6: transport message id recorded");
      } finally {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
    }

    // ── (t) G1b — a real run needs a live transport ────────────────────────
    freshDb();
    seedProducer("t-1", "Levende Gård", "levende@gard-test.no");
    seedProducer("t-2", "Neste Levende Gård", "levende2@gard-test.no");
    setEnv({ RFB_MARKETING_PLATFORM_ENABLED: "1", RFB_MARKETING_DAILY_CAP: "3" });
    {
      const prevForce = process.env.EMAIL_FORCE_DRY_RUN;
      const prevNodeEnv = process.env.NODE_ENV;
      const svc = emailMod.emailService;
      const stubTransporter = { sendMail: async () => ({ messageId: "stub-live" }) };
      try {
        // isLiveTransport() is exactly the negation of sendRaw's DRY_RUN short-circuit.
        process.env.NODE_ENV = "test";
        process.env.EMAIL_FORCE_DRY_RUN = "true";
        emailSvc.isConfigured = false;
        emailSvc.transporter = emailSvc.envTransporter;
        const dryAnswer = await svc.sendRaw({ to: "x@gard-test.no", subject: "s", textContent: "t" } as any);
        assertEq([svc.isLiveTransport(), dryAnswer.messageId], [false, "DRY_RUN"], "t1: SMTP not configured → not live (sendRaw answers DRY_RUN)");
        emailSvc.isConfigured = true;
        const forcedAnswer = await svc.sendRaw({ to: "x@gard-test.no", subject: "s", textContent: "t" } as any);
        assertEq([svc.isLiveTransport(), forcedAnswer.messageId], [false, "DRY_RUN"], "t2: configured but forced dry-run (test env) → not live (DRY_RUN)");
        delete process.env.EMAIL_FORCE_DRY_RUN;
        assertEq(svc.isLiveTransport(), true, "t3: configured, env transporter, not forced → live");
        process.env.EMAIL_FORCE_DRY_RUN = "true";
        emailSvc.transporter = stubTransporter;
        assertEq(svc.isLiveTransport(), true, "t4: a swapped-in transporter is never forced dry-run → live");

        // Apply, no seam, transport not live → skip with no writes at all.
        emailSvc.isConfigured = false;
        emailSvc.transporter = emailSvc.envTransporter;
        const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
        const before = changes();
        const r = await daily.runRfbMarketingDaily({ apply: true, trigger: "manual", deps: { healthProbe: healthy } });
        assertEq([r.skipped_reason, r.transport_live, r.envelope_recorded], ["transport_not_live", false, false], "t5: apply without a live transport → transport_not_live, no envelope");
        assertEq(changes(), before, "t6: …and not a single row changed (total_changes)");
        const dry = await daily.runRfbMarketingDaily({ apply: false, trigger: "manual", deps: { healthProbe: healthy } });
        assertEq([dry.transport_live, dry.skipped_reason, dry.summary.would_send, changes()], [false, null, 2, before], "t7: a dry run reports transport_live=false and still lists, read-only");
        const laneRouter = adminRoutes.rfbMarketingLaneRouter as any;
        assertEq((await callRoute(laneRouter, { method: "GET", headers: auth })).body.transport_live, false, "t8: GET /admin/rfb-marketing-lane → transport_live false");
        daily.__setRfbMarketingHealthProbeForTesting(healthy);
        const viaRoute = await callRoute(adminRoutes.rfbMarketingDailyRunRouter as any, { method: "POST", headers: auth, body: { apply: true } });
        daily.__setRfbMarketingHealthProbeForTesting(null);
        assertEq([viaRoute.body.skipped_reason, changes()], ["transport_not_live", before], "t9: POST /admin/rfb-marketing-daily-run {apply:true} → transport_not_live, nothing written");
        emailSvc.isConfigured = true;
        emailSvc.transporter = stubTransporter;
        assertEq((await callRoute(laneRouter, { method: "GET", headers: auth })).body.transport_live, true, "t10: …true once a real transport is in place");

        // Defense in depth: a transport that answers DRY_RUN anyway (through the
        // seam, which bypasses G1b) — the run stops and nothing counts as sent.
        const wire: string[] = [];
        const dryWire = {
          calls: [] as Array<Record<string, any>>,
          sendRaw: async (o: any) => {
            wire.push(o.to);
            return { success: true, messageId: "DRY_RUN" };
          },
        };
        const r2 = await run(true, { transport: dryWire as any });
        assertEq(
          [r2.results[0]?.status, r2.results[0]?.reason, r2.stopped_reason, r2.summary.sent, wire.length],
          ["error", "transport_dry_run", "transport_not_live", 0, 1],
          "t11: a DRY_RUN answer stops the run at once and is not a send",
        );
        const env = runsRows()[0];
        assertEq([ledger().map((l) => l.status), env?.status, JSON.parse(env?.claims ?? "[]")[0]?.value], [["failed"], "failed", 0], "t12: ledger 'failed' (not sent), envelope 'failed', emails_sent 0");
      } finally {
        if (prevForce === undefined) delete process.env.EMAIL_FORCE_DRY_RUN;
        else process.env.EMAIL_FORCE_DRY_RUN = prevForce;
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
        daily.__setRfbMarketingHealthProbeForTesting(null);
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-marketing-daily: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    daily.__setRfbMarketingHealthProbeForTesting(null);
    daily.__setRfbMarketingRefreshFetchForTesting(null);
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) initMod.__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  runRfbMarketingDailyTests({ log: true }).then((r) => {
    console.log(`\nrfb-marketing-daily: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
