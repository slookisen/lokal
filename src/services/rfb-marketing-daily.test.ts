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
 *       counted + blocked on the next run
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

  function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  }

  function freshDb(): any {
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

  let eligibleSeq = 0;
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
  function runsRows(): Array<{ run_id: string; status: string; claims: string; notes: string; errors: string | null }> {
    return db
      .prepare(`SELECT run_id, status, claims, notes, errors FROM runs WHERE agent = ? ORDER BY rowid`)
      .all(daily.RFB_MARKETING_DAILY_AGENT);
  }
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const tomorrow = () => new Date(Date.now() + 86400_000);

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
      const r6 = await run(true, { transport: eTransport, now: tomorrow() });
      const krasj = r6.results.find((x) => x.agent_id === "n-0000-0001");
      assertEq(krasj?.reason, "recently_contacted_by_platform_job", "f9: next day, the reserved address is still blocked (outcome unknown → treated as sent)");
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
      assertEq(oslFor("disk@gard-test.no"), 0, "h5: outreach_sent_log never got the row (the exact 2026-09-27 gap)");
      db.exec(`DROP TRIGGER t_sent_flip_fails`);
      const gateAgain = aoc.computeOutreachCandidates(db, { mode: "first", cooldownDays: 60, limit: 100 });
      assertTrue(gateAgain.candidates.some((c) => c.email === "disk@gard-test.no"), "h6: the gate alone WOULD select the address again");
      const next = await run(true, { transport: t, now: tomorrow() });
      assertEq(
        next.results.find((x) => x.agent_id === "h-1")?.reason,
        "recently_contacted_by_platform_job",
        "h7: next day the ledger keeps it out",
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

    // A transport failure is a per-recipient error (loop continues), is never
    // re-attempted the same day, and is retried on a later day.
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
        r.results.map((x) => [x.agent_id, x.status, x.reason ?? null]),
        [["i-3", "error", "compose_failed:smtp 451 try later"], ["i-4", "sent", null]],
        "i8: a transport failure is an error row and the loop continues",
      );
      assertEq([r.stopped_reason, ledger().map((l) => l.status)], [null, ["failed", "sent"]], "i9: ledger records the failed attempt");
      const t = makeTransport();
      const same = await run(true, { transport: t });
      assertEq(same.results.find((x) => x.agent_id === "i-3")?.reason, "already_attempted_today", "i10: no second attempt at the same address the same day");
      assertEq(t.calls.length, 0, "i11: nothing sent on the same-day rerun");
      const nextDay = await run(true, { transport: t, now: tomorrow() });
      assertEq(nextDay.results.find((x) => x.agent_id === "i-3")?.status, "sent", "i12: a failed send is retried on a later day");
      assertEq(failingCalls.concat(t.calls.map((c) => c.to)), ["feil@gard-test.no", "frisk@gard-test.no", "feil@gard-test.no"], "i13: exactly one retry, nobody else re-mailed");
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
  } catch (err) {
    failed++;
    failures.push(`rfb-marketing-daily: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    daily.__setRfbMarketingHealthProbeForTesting(null);
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
