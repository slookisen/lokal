/**
 * rfb-enrichment-nightly.test.ts — the nightly RFB enrichment job (R6,
 * dev-request 2026-10-10-rfb-berikelse-nattjobb + Daniel's 2026-10-11
 * amendments: Brreg contact step, Bondens Marked step with a rotating cursor).
 *
 * Every block runs on a FRESH in-memory main DB with the full production
 * schema (__pinInMemoryDbForTesting, restored in finally). The step tools are
 * replaced by stub executors (deps.executors) except in (n), which drives the
 * real URL-probe executor and the real in-process Bondens Marked route call
 * against a stubbed global fetch. No real network anywhere.
 *
 * Covers:
 *   (a) knobs + scheduling: flag parsing, per-step caps (start values, env,
 *       clamp, 0), LLM cap, window hours (08 never accepted), shouldRun,
 *       deadline never later than 07:55Z, BM cursor arithmetic + wrap
 *   (b) AC1 cohort: leaves out contacted (already_sent / already_contacted as
 *       pool-blocker-explain derives them — pinned against the route itself),
 *       umbrella, inactive, unvetted, claimed / verified claim, curated,
 *       opt-out (status + CRM), blocklisted, terminal konkurs / inactive /
 *       non-producer; keeps a legacy terminal row, a pending claim, another
 *       vertical's send; tiers closest-to-pool first
 *   (c) AC1 flag off = nothing happens (no executor call, no lock, no write,
 *       no envelope, no stamp; tick returns null)
 *   (d) AC1 never 08:00–08:59Z: refused in 08Z and in the 5-minute margin;
 *       a run that reaches its deadline stops before 07:55Z; a clock that
 *       jumps into 08Z stops the next row
 *   (e) AC1 per-step caps honoured; step 5 takes changed rows first
 *   (f) AC1 LLM cap honoured: calls never pass the cap, LLM steps stop for
 *       the night, non-LLM steps go on, verify skips when it needs the LLM
 *   (g) the verifier tick lock: held → skipped (no work, no stamp, retried);
 *       held BY the job during the run (runVerifierTick skips); released after
 *   (h) run-ledger envelope shape: one per run, a claim per step with the
 *       spec's fields, LLM + totals claims
 *   (i) dry run / preview writes nothing and fetches nothing (service + routes)
 *   (j) BM cursor rotation over ~6 nights, wrap to 0, partial scan, a cursor
 *       past a shrunken catalog restarts at 0 the same night
 *   (k) step 5 attribution: new verified / new in pool credited to the step
 *       that changed the row; unreachable-site rows after the changed rows
 *   (l) tick: once per night in the window, persisted stamp, not in 08Z
 *   (m) rotation memory: a row a step tried recently is not re-selected
 *   (n) real executors: URL probe writes url_last_*; BM step calls the real
 *       route in process with the stored offset and advances the cursor
 *   (o) admin routes: auth, dry-run default, apply with the flag off
 *   (p) enrichment write-pause: writing steps skipped, verify still runs
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-enrichment-nightly.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { method?: string; url?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const method = opts.method ?? "GET";
    const url = opts.url ?? "/";
    const headers = opts.headers || {};
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: opts.query ?? {},
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
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "unmatched") } }));
  });
}

const ENV_KEYS = [
  "RFB_ENRICHMENT_NIGHTLY_ENABLED",
  "RFB_ENRICHMENT_CAP_URL_CHECK",
  "RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE",
  "RFB_ENRICHMENT_CAP_BRREG",
  "RFB_ENRICHMENT_CAP_BM_SLUGS",
  "RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION",
  "RFB_ENRICHMENT_CAP_CONTENT",
  "RFB_ENRICHMENT_CAP_REVERIFY",
  "RFB_ENRICHMENT_LLM_CAP",
  "RFB_ENRICHMENT_MAX_RUNTIME_MINUTES",
  "RFB_ENRICHMENT_RETRY_DAYS",
  "RFB_ENRICHMENT_LLM_USD_PER_CALL",
  "RFB_ENRICHMENT_NIGHTLY_HOURS_UTC",
  "RFB_SECOND_LINE_VERIFICATION_ENABLED",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const LONG_ABOUT =
  "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honning og ull direkte fra gården hele året.";

export async function runRfbEnrichmentNightlyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const job = require("./rfb-enrichment-nightly") as typeof import("./rfb-enrichment-nightly");
  const meterMod = require("./llm-call-meter") as typeof import("./llm-call-meter");
  const ledger = require("./run-ledger") as typeof import("./run-ledger");
  const pause = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
  const routes = require("../routes/admin-rfb-enrichment-nightly") as typeof import("../routes/admin-rfb-enrichment-nightly");
  const poolExplainRouter = (require("../routes/admin-pool-blocker-explain") as typeof import("../routes/admin-pool-blocker-explain")).default;
  const runVerifierMod = require("../routes/admin-run-verifier") as typeof import("../routes/admin-run-verifier");

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevAdminKey = process.env.ADMIN_KEY;
  // Adopt the ambient suite key (tests/test.ts assigns it once); standalone fallback.
  const testKey = process.env.ADMIN_KEY || "rfb-enrichment-nightly-test-key";
  process.env.ADMIN_KEY = testKey;
  const auth = { "x-admin-key": testKey };
  const prevFetch = globalThis.fetch;

  function setEnv(values: Partial<Record<EnvKey, string>>): void {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  }

  let db: any = null;
  async function withDb(label: string, fn: () => Promise<void>): Promise<void> {
    const restore = initMod.__pinInMemoryDbForTesting();
    db = initMod.getDb();
    try {
      await fn();
    } catch (err) {
      failed++;
      failures.push(`${label}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      (globalThis as any).fetch = prevFetch;
      restore();
      db = null;
    }
  }

  let seq = 0;
  function seedAgent(
    id: string,
    o: {
      name?: string;
      contact_email?: string;
      url?: string;
      org_nr?: string | null;
      umbrella_type?: string | null;
      is_active?: number;
      is_vetted?: number | null;
      claimed_at?: string | null;
      vertical_id?: string;
      catalog_hidden?: number;
      k?:
        | false
        | {
            website?: string | null;
            email?: string | null;
            about?: string | null;
            products?: string | null;
            verification_status?: string;
            verification_review_reason?: string | null;
            url_last_status?: number | null;
            url_last_probed?: string | null;
            homepage_unreachable_since?: string | null;
            curated_fields?: string | null;
            enrichment_status?: string;
          };
    } = {},
  ): void {
    seq += 1;
    const cols: Record<string, unknown> = {
      id,
      name: o.name ?? `Gård ${id}`,
      description: "test",
      provider: "test",
      contact_email: o.contact_email ?? "",
      url: o.url ?? "",
      role: "producer",
      api_key: `key-${id}`,
      created_at: `2026-01-01 00:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`,
    };
    if (o.org_nr !== undefined) cols.org_nr = o.org_nr;
    if (o.umbrella_type !== undefined) cols.umbrella_type = o.umbrella_type;
    if (o.is_active !== undefined) cols.is_active = o.is_active;
    if (o.is_vetted !== undefined) cols.is_vetted = o.is_vetted;
    if (o.claimed_at !== undefined) cols.claimed_at = o.claimed_at;
    if (o.vertical_id !== undefined) cols.vertical_id = o.vertical_id;
    if (o.catalog_hidden !== undefined) cols.catalog_hidden = o.catalog_hidden;
    const names = Object.keys(cols);
    db.prepare(`INSERT INTO agents (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
      ...names.map((n) => cols[n]),
    );
    if (o.k === false) return;
    const k = o.k ?? {};
    const kc: Record<string, unknown> = { agent_id: id, verification_status: k.verification_status ?? "pending_verify" };
    for (const key of [
      "website",
      "email",
      "about",
      "products",
      "verification_review_reason",
      "url_last_status",
      "url_last_probed",
      "homepage_unreachable_since",
      "curated_fields",
      "enrichment_status",
    ] as const) {
      if ((k as any)[key] !== undefined) kc[key] = (k as any)[key];
    }
    const kn = Object.keys(kc);
    db.prepare(`INSERT INTO agent_knowledge (${kn.join(", ")}) VALUES (${kn.map(() => "?").join(", ")})`).run(
      ...kn.map((n) => kc[n]),
    );
  }

  /** A row eligible for url_check, brreg_contact, contact_extraction and content_refresh. */
  function seedGeneric(id: string): void {
    seedAgent(id, {
      org_nr: null,
      k: { website: `https://${id}.no`, email: "", about: "", products: "[]", url_last_status: 200, url_last_probed: null },
    });
  }

  type Call = { step: string; id: string; at: string };
  function stubExecutors(
    calls: Call[],
    clock: () => Date,
    over: Partial<import("./rfb-enrichment-nightly").RfbEnrichmentExecutors> = {},
  ): Partial<import("./rfb-enrichment-nightly").RfbEnrichmentExecutors> {
    const rec = (step: string, changed = false) => async (row: { id: string }) => {
      calls.push({ step, id: row.id, at: clock().toISOString() });
      return { outcome: "stub_written", written: true, changed };
    };
    return {
      urlCheck: rec("url_check"),
      emailDomainWebsite: rec("email_domain_website"),
      brregContact: rec("brreg_contact", true),
      contactExtraction: rec("contact_extraction", true),
      contentRefresh: async (row: { id: string }) => {
        calls.push({ step: "content_refresh", id: row.id, at: clock().toISOString() });
        return { outcome: "unchanged", written: false, changed: false };
      },
      bmHarvest: async ({ offset, limit }: { offset: number; limit: number }) => {
        calls.push({ step: "bm_harvest", id: `${offset}+${limit}`, at: clock().toISOString() });
        return { status: 200, total_slugs: 0, offset, scanned: 0, time_budget_exceeded: false, counts: {}, changed_agent_ids: [], written: 0 };
      },
      reverify: async (agentId: string) => {
        calls.push({ step: "reverify", id: agentId, at: clock().toISOString() });
        return { outcome: "pending_verify", prior: "pending_verify", next: "pending_verify" };
      },
      ...over,
    };
  }
  const realClock = () => new Date();
  const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  const NIGHT = new Date("2026-10-12T00:10:00Z");
  const ALL_CAPS_ZERO: Partial<Record<EnvKey, string>> = {
    RFB_ENRICHMENT_CAP_URL_CHECK: "0",
    RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "0",
    RFB_ENRICHMENT_CAP_BRREG: "0",
    RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
    RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "0",
    RFB_ENRICHMENT_CAP_CONTENT: "0",
    RFB_ENRICHMENT_CAP_REVERIFY: "0",
  };

  try {
    // ── (a) knobs + scheduling ───────────────────────────────────────────
    {
      setEnv({});
      assertEq(job.isRfbEnrichmentNightlyEnabled(), false, "a1: flag unset → off (default OFF)");
      for (const [v, want] of [["1", true], ["true", true], ["TRUE", true], ["0", false], ["yes", false]] as const) {
        setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: v });
        assertEq(job.isRfbEnrichmentNightlyEnabled(), want, `a1: flag "${v}" → ${want}`);
      }
      setEnv({});
      assertEq(
        job.resolveRfbEnrichmentCaps(),
        { url_check: 50, email_domain_website: 30, brreg_contact: 25, bm_harvest: 60, contact_extraction: 30, content_refresh: 30, reverify: 60 },
        "a2: per-step start values = the spec's table + Daniel's 2026-10-11 caps (Brreg 25, BM 60)",
      );
      assertEq(job.resolveRfbEnrichmentLlmCap(), 150, "a2: LLM cap start value 150");
      setEnv({ RFB_ENRICHMENT_CAP_URL_CHECK: "7", RFB_ENRICHMENT_CAP_BRREG: "999", RFB_ENRICHMENT_CAP_CONTENT: "abc", RFB_ENRICHMENT_CAP_REVERIFY: "0", RFB_ENRICHMENT_LLM_CAP: "-5" });
      const c = job.resolveRfbEnrichmentCaps();
      assertEq([c.url_check, c.brreg_contact, c.content_refresh, c.reverify], [7, 48, 30, 0], "a2: env override, clamp to the tool's own hard cap, junk → start value, 0 allowed");
      assertEq(job.resolveRfbEnrichmentLlmCap(), 150, "a2: a negative LLM cap is junk → 150");
      setEnv({ RFB_ENRICHMENT_MAX_RUNTIME_MINUTES: "500" });
      assertEq(job.resolveRfbEnrichmentMaxRuntimeMs(), 40 * 60_000, "a2: max runtime clamped below the verifier lock's 50-min staleness");
      setEnv({});
      assertEq(job.resolveRfbEnrichmentWindowHours(), [0, 1], "a3: default night slot 00–01Z");
      setEnv({ RFB_ENRICHMENT_NIGHTLY_HOURS_UTC: "23, 0" });
      assertEq(job.resolveRfbEnrichmentWindowHours(), [23, 0], "a3: env window inside the verifier night");
      setEnv({ RFB_ENRICHMENT_NIGHTLY_HOURS_UTC: "8,6,12" });
      assertEq(job.resolveRfbEnrichmentWindowHours(), [0, 1], "a3: 08Z (and 06Z/12Z) are never accepted as start hours");
      setEnv({});
      const at = (iso: string) => new Date(iso);
      assertEq(job.shouldRunRfbEnrichmentNightly({ now: at("2026-10-12T00:10:00Z"), lastRunAt: null }), true, "a4: 00:10Z, never ran → run");
      assertEq(job.shouldRunRfbEnrichmentNightly({ now: at("2026-10-12T03:10:00Z"), lastRunAt: null }), false, "a4: 03:10Z is outside the slot");
      assertEq(job.shouldRunRfbEnrichmentNightly({ now: at("2026-10-12T08:10:00Z"), lastRunAt: null, windowHours: [8] }), false, "a4: 08Z never runs, even if configured");
      assertEq(job.shouldRunRfbEnrichmentNightly({ now: at("2026-10-12T01:10:00Z"), lastRunAt: at("2026-10-12T00:10:00Z") }), false, "a4: once per night");
      assertEq(job.shouldRunRfbEnrichmentNightly({ now: at("2026-10-13T00:05:00Z"), lastRunAt: at("2026-10-12T00:10:00Z") }), true, "a4: next night runs again");
      assertEq(job.computeRfbEnrichmentDeadline(at("2026-10-12T00:10:00Z"), 20 * 60_000).toISOString(), "2026-10-12T00:30:00.000Z", "a5: deadline = start + max runtime");
      assertEq(job.computeRfbEnrichmentDeadline(at("2026-10-12T07:50:00Z"), 20 * 60_000).toISOString(), "2026-10-12T07:55:00.000Z", "a5: deadline never past 07:55Z (08:00Z − 5 min margin)");
      assertEq(job.computeRfbEnrichmentDeadline(at("2026-10-12T09:00:00Z"), 20 * 60_000).toISOString(), "2026-10-12T09:20:00.000Z", "a5: after 08Z the next window start is tomorrow");
      assertEq(
        [job.nextBmCursor(0, 60, 354), job.nextBmCursor(300, 54, 354), job.nextBmCursor(300, 60, 354), job.nextBmCursor(120, 25, 354), job.nextBmCursor(40, 10, 0)],
        [60, 0, 0, 145, 40],
        "a6: BM cursor = offset + scanned, wraps to 0 at the end, unchanged when the catalog was unreadable",
      );
      assertEq(
        job.RFB_ENRICHMENT_STEP_ORDER.map((s) => job.rfbEnrichmentLlmCallsPerRowMax(s)),
        [0, 0, 1, 0, 1, 0, 0],
        "a7: per-row LLM worst case: Brreg + contact extraction 1, verify 0 with the second line off",
      );
      setEnv({ RFB_SECOND_LINE_VERIFICATION_ENABLED: "true" });
      assertEq(job.rfbEnrichmentLlmCallsPerRowMax("reverify"), 1, "a7: verify 1 when the second line is on");
      setEnv({});
    }

    // ── (b) AC1 cohort ───────────────────────────────────────────────────
    await withDb("b", async () => {
      setEnv({});
      seedAgent("ok-1", { k: { email: "post@okgard1.no", website: "https://okgard1.no", url_last_status: 200 } });
      seedAgent("ok-2", { k: { website: "https://okgard2.no", url_last_status: 200 } });
      seedAgent("ok-3", { k: { email: "post@okgard3.no" } });
      seedAgent("ok-4", { k: { email: "post@okgard4.no", website: "https://okgard4.no", url_last_status: 404 } });
      seedAgent("ok-5", { k: { website: "https://okgard5.no", homepage_unreachable_since: "2026-09-01T00:00:00Z" } });
      seedAgent("ok-6", {});
      seedAgent("ok-noknow", { k: false });
      seedAgent("ok-claim-pending", {});
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('cl1', 'ok-claim-pending', 'X', 'x@x.no', 'pending')`).run();
      seedAgent("ok-curated-empty", { k: { curated_fields: "{}" } });
      seedAgent("ok-term-legacy", { k: { verification_status: "terminal_unconfirmable", verification_review_reason: JSON.stringify({ terminal_reason: "zero_identity_sources" }) } });
      seedAgent("ok-other-vertical-send", { k: { email: "post@annen.no" } });
      db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, channel, message_id, notes, vertical_id) VALUES ('ok-other-vertical-send', 'post@annen.no', 'email', 'm-ov', 'test', 'experiences')`).run();
      seedAgent("ok-crm-draft", { contact_email: "hei@draftgard.no" });
      seedAgent("ok-crm-in-only", { contact_email: "hei@inngard.no" });

      seedAgent("x-umbrella", { umbrella_type: "market" });
      seedAgent("x-inactive", { is_active: 0 });
      seedAgent("x-unvetted", { is_vetted: 0 });
      seedAgent("x-claimed", { claimed_at: "2026-05-01T00:00:00Z" });
      seedAgent("x-claim-verified", {});
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('cl2', 'x-claim-verified', 'Y', 'y@y.no', 'verified')`).run();
      seedAgent("x-curated", { k: { curated_fields: JSON.stringify({ about: { by: "owner" } }) } });
      seedAgent("x-optout-status", { k: { verification_status: "opt_out" } });
      seedAgent("x-optout-crm", {});
      db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, status) VALUES ('cc-oo', 'producer', 'x-optout-crm', 'oo@oogard.no', 'blocked')`).run();
      seedAgent("x-sent-agent", { k: { email: "post@sentagent.no" } });
      db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, channel, message_id, notes, vertical_id) VALUES ('x-sent-agent', 'annen@adresse.no', 'email', 'm-sa', 'test', 'rfb')`).run();
      seedAgent("x-sent-email", { k: { email: "Kontakt@SentMail.no" } });
      db.prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, channel, message_id, notes, vertical_id) VALUES ('ghost-agent', 'kontakt@sentmail.no', 'email', 'm-se', 'test', 'rfb')`).run();
      seedAgent("x-crm-out", { contact_email: "Hei@CrmGard.no" });
      const crm = (cid: string, email: string, dir: "in" | "out", sentAt: string | null) => {
        db.prepare(`INSERT INTO crm_contacts (id, type, email) VALUES (?, 'producer', ?)`).run(cid, email);
        db.prepare(`INSERT INTO crm_threads (id, contact_id, subject) VALUES (?, ?, 's')`).run(`t-${cid}`, cid);
        db.prepare(
          `INSERT INTO crm_messages (id, thread_id, direction, from_email, sent_at, delivery_status) VALUES (?, ?, ?, 'x@rettfrabonden.com', ?, 'queued')`,
        ).run(`m-${cid}`, `t-${cid}`, dir, sentAt);
      };
      crm("cc-out", "hei@crmgard.no", "out", "2026-09-01 10:00:00");
      crm("cc-draft", "hei@draftgard.no", "out", null);
      crm("cc-in", "hei@inngard.no", "in", "2026-09-02 10:00:00");
      seedAgent("x-blocked", {});
      db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('agent_id', 'x-blocked', 'test')`).run();
      seedAgent("x-term-konkurs", { k: { verification_status: "terminal_unconfirmable", verification_review_reason: JSON.stringify({ terminal_reason: "brreg_konkurs" }) } });
      seedAgent("x-term-inactive", { k: { verification_status: "terminal_unconfirmable", verification_review_reason: JSON.stringify({ terminal_reason: "brreg_inactive" }) } });
      seedAgent("x-term-nonproducer", { k: { verification_status: "terminal_unconfirmable", verification_review_reason: JSON.stringify({ terminal_reason: "non_producer_entity" }) } });
      seedAgent("n-dental", { vertical_id: "dental" });
      seedAgent("n-hidden", { catalog_hidden: 1 });

      const cohort = await job.loadRfbEnrichmentCohort(db);
      assertEq(
        cohort.rows.map((r) => r.id).sort(),
        ["ok-1", "ok-2", "ok-3", "ok-4", "ok-5", "ok-6", "ok-claim-pending", "ok-crm-draft", "ok-crm-in-only", "ok-curated-empty", "ok-noknow", "ok-other-vertical-send", "ok-term-legacy"],
        "b1: the cohort is exactly the uncontacted, unlocked, live RFB producers",
      );
      assertEq(
        cohort.excluded,
        { umbrella: 1, inactive: 1, unvetted: 1, customer: 2, curated: 1, opt_out: 2, contacted: 3, blocklisted: 1, terminal_dead: 3 },
        "b2: exclusions counted by reason (contacted = already_sent ×2 + already_contacted ×1; customer = claimed + verified claim)",
      );
      assertEq(cohort.considered, 13 + 15, "b2: 13 kept + 15 excluded; other verticals and the hidden fixture are never considered");
      const tierOf = (id: string) => cohort.rows.find((r) => r.id === id)?.tier;
      assertEq(["ok-1", "ok-2", "ok-3", "ok-4", "ok-5", "ok-6"].map(tierOf), [1, 2, 3, 4, 5, 6], "b3: tiers follow the spec's Context groups, closest to the pool first");

      // Parity: the contacted signal is pool-blocker-explain's own verdict.
      const ids = db.prepare(`SELECT id FROM agents ORDER BY id`).all().map((r: any) => r.id);
      const pb = await callRoute(poolExplainRouter, { url: "/", headers: auth, query: { agentIds: ids.join(",") } });
      assertEq(pb.status, 200, "b4: pool-blocker-explain answers for every fixture");
      const signals = job.readRfbContactedSignals(db);
      const mine = db
        .prepare(`SELECT a.id AS id, LOWER(a.contact_email) AS contact_email_lower, LOWER(k.email) AS k_email_lower FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id`)
        .all() as Array<{ id: string; contact_email_lower: string | null; k_email_lower: string | null }>;
      const mismatches: string[] = [];
      for (const a of pb.body?.agents ?? []) {
        if (!a.found) continue;
        const theirs = a.signals.already_sent === true || !!a.signals.contacted_at;
        const row = mine.find((m) => m.id === a.agent_id)!;
        if (theirs !== job.isContactedPerPoolBlockerExplain(row, signals)) mismatches.push(a.agent_id);
      }
      assertEq(mismatches, [], "b4: contacted == pool-blocker-explain's already_sent || already_contacted, for every fixture");
      assertEq(
        (pb.body?.agents ?? []).filter((a: any) => a.signals?.already_sent || a.signals?.contacted_at).map((a: any) => a.agent_id).sort(),
        ["x-crm-out", "x-sent-agent", "x-sent-email"],
        "b4: and the route itself flags exactly the three contacted fixtures",
      );
    });

    // ── (c) AC1 flag off = nothing happens ───────────────────────────────
    await withDb("c", async () => {
      setEnv({});
      for (let i = 0; i < 4; i++) seedGeneric(`g${i}`);
      const calls: Call[] = [];
      const before = ["runs", "rfb_enrichment_nightly_attempts", "rfb_enrichment_sweep_state", "orchestrator_locks", "agent_knowledge_audit"].map(count);
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors(calls, realClock) } });
      const after = ["runs", "rfb_enrichment_nightly_attempts", "rfb_enrichment_sweep_state", "orchestrator_locks", "agent_knowledge_audit"].map(count);
      assertEq([r.skipped_reason, r.enabled_by_env, r.envelope_recorded, r.lock.acquired], ["disabled_by_env", false, false, false], "c1: apply with the flag off → disabled_by_env, no lock, no envelope");
      assertEq(calls.length, 0, "c1: no step executor is called");
      assertEq(after, before, "c1: nothing written (runs, attempts, cursor, locks, audit)");
      assertEq(job.rfbEnrichmentRunConsumesWindow(r), false, "c1: a flag-off skip never stamps the night");
      const t = await job.tickRfbEnrichmentNightly({ now: NIGHT, lastRunAt: null, deps: { executors: stubExecutors(calls, realClock) } });
      assertEq([t.report, t.lastRunAt, calls.length], [null, null, 0], "c2: the tick is a no-op with the flag off");
      assertEq(count("boot_job_state"), 0, "c2: and stamps nothing");
    });

    // ── (d) AC1 never 08:00–08:59Z ───────────────────────────────────────
    await withDb("d", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1" });
      for (let i = 0; i < 5; i++) seedGeneric(`d${i}`);
      const calls: Call[] = [];
      for (const iso of ["2026-10-12T08:00:00Z", "2026-10-12T08:20:00Z", "2026-10-12T08:59:59Z", "2026-10-12T07:57:00Z"]) {
        const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: new Date(iso), deps: { executors: stubExecutors(calls, realClock) } });
        assertEq([r.skipped_reason, r.lock.acquired], ["forbidden_hour", false], `d1: a run asked for at ${iso.slice(11, 19)}Z is refused (08Z / inside the 5-min margin)`);
      }
      assertEq([calls.length, count("orchestrator_locks"), count("runs")], [0, 0, 0], "d1: no work, no lock, no envelope");

      // A run at 07:40Z whose rows take 6 minutes each: writing steps stop at
      // the write deadline (07:51:15Z), nothing starts at/after 07:55Z.
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_BM_SLUGS: "0" });
      let t = new Date("2026-10-12T07:40:00Z").getTime();
      const clock = () => new Date(t);
      const advancing = (step: string) => async (row: { id: string }) => {
        calls.push({ step, id: row.id, at: clock().toISOString() });
        t += 6 * 60_000;
        return { outcome: "stub_written", written: true, changed: false };
      };
      const r2 = await job.runRfbEnrichmentNightly({
        apply: true,
        trigger: "manual",
        now: new Date(t),
        deps: { clock, executors: stubExecutors(calls, clock, { urlCheck: advancing("url_check"), brregContact: advancing("brreg_contact") }) },
      });
      assertEq([r2.deadline_at, r2.write_deadline_at], ["2026-10-12T07:55:00.000Z", "2026-10-12T07:51:15.000Z"], "d2: deadline 07:55Z, writes stop 3m45s earlier (verify reserve)");
      assertEq(calls.map((c) => c.at), ["2026-10-12T07:40:00.000Z", "2026-10-12T07:46:00.000Z"], "d2: rows start only before the write deadline");
      assertTrue(calls.every((c) => c.at < "2026-10-12T07:55:00.000Z" && !c.at.startsWith("2026-10-12T08")), "d2: no row ever starts at/after 07:55Z or in 08Z");
      assertEq(r2.steps.find((s) => s.step === "url_check")?.stopped_reason, "time_budget", "d2: url_check stopped by the time budget");
      assertEq(r2.steps.find((s) => s.step === "brreg_contact")?.skipped_reason, "time_budget", "d2: later writing steps skipped");
      assertEq(r2.envelope_recorded, true, "d2: the run still records its envelope");

      // A clock that jumps into 08Z stops before the next row.
      calls.length = 0;
      db.prepare(`DELETE FROM rfb_enrichment_nightly_attempts`).run();
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_MAX_RUNTIME_MINUTES: "40" });
      t = new Date("2026-10-12T05:00:00Z").getTime();
      const jump = async (row: { id: string }) => {
        calls.push({ step: "url_check", id: row.id, at: clock().toISOString() });
        t = new Date("2026-10-12T08:01:00Z").getTime();
        return { outcome: "stub_written", written: true, changed: false };
      };
      const r3 = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: new Date(t), deps: { clock, executors: stubExecutors(calls, clock, { urlCheck: jump }) } });
      assertEq([calls.length, r3.stopped_reason], [1, "url_check:forbidden_hour"], "d3: after the clock reaches 08Z not one more row starts");
      assertTrue(r3.steps.filter((s) => s.step !== "url_check").every((s) => s.attempted === 0), "d3: every later step does nothing");
    });

    // ── (e) AC1 per-step caps ────────────────────────────────────────────
    let envelopeRow: any = null;
    await withDb("e", async () => {
      setEnv({
        RFB_ENRICHMENT_NIGHTLY_ENABLED: "1",
        RFB_ENRICHMENT_CAP_URL_CHECK: "3",
        RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "2",
        RFB_ENRICHMENT_CAP_BRREG: "2",
        RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
        RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "4",
        RFB_ENRICHMENT_CAP_CONTENT: "5",
        RFB_ENRICHMENT_CAP_REVERIFY: "3",
      });
      for (let i = 0; i < 10; i++) seedGeneric(`e${i}`);
      const calls: Call[] = [];
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "cron", now: NIGHT, deps: { executors: stubExecutors(calls, realClock) } });
      const n = (step: string) => calls.filter((c) => c.step === step).length;
      assertEq(
        [n("url_check"), n("email_domain_website"), n("brreg_contact"), n("bm_harvest"), n("contact_extraction"), n("content_refresh"), n("reverify")],
        [3, 0, 2, 0, 4, 5, 3],
        "e1: each step stops at its own cap (email-domain has no candidates; BM cap 0 = off)",
      );
      const step = (s: string) => r.steps.find((x) => x.step === s)!;
      assertEq([step("url_check").eligible, step("url_check").selected, step("url_check").attempted], [10, 3, 3], "e2: eligible 10, selected = cap 3, attempted 3");
      assertEq(step("bm_harvest").skipped_reason, "cap_zero", "e2: a step with cap 0 is skipped");
      assertEq(
        calls.filter((c) => c.step === "reverify").map((c) => c.id),
        ["e0", "e1", "e2"],
        "e3: step 5 re-verifies tonight's changed rows first (Brreg's e0,e1 then contact extraction's e2), up to its cap",
      );
      assertEq(count("rfb_enrichment_nightly_attempts"), 3 + 2 + 4 + 5, "e4: every attempted row is stamped (rotation memory)");
      assertEq(r.lock.released, true, "e5: the verifier tick lock is released after the run");
      envelopeRow = db.prepare(`SELECT * FROM runs WHERE agent = ?`).all(job.RFB_ENRICHMENT_NIGHTLY_AGENT);
    });

    // ── (h) envelope shape (from the run in (e)) ─────────────────────────
    {
      assertEq(Array.isArray(envelopeRow) ? envelopeRow.length : -1, 1, "h1: exactly one envelope per run");
      const env = envelopeRow?.[0] ?? {};
      assertEq([env.run_id, env.vertical, env.trigger_source, env.status], ["run-2026-10-12-rfb-enrichment-nightly", "rfb", "cron", "completed"], "h2: run_id per night, vertical rfb, cron, completed");
      const claims = JSON.parse(env.claims ?? "[]");
      assertEq(
        claims.map((c: any) => c.meta?.kind),
        [
          "rfb_enrichment_step_url_check",
          "rfb_enrichment_step_email_domain_website",
          "rfb_enrichment_step_brreg_contact",
          "rfb_enrichment_step_bm_harvest",
          "rfb_enrichment_step_contact_extraction",
          "rfb_enrichment_step_content_refresh",
          "rfb_enrichment_step_reverify",
          "rfb_enrichment_llm_calls",
          "rfb_enrichment_totals",
        ],
        "h3: one claim per step in order, then LLM and totals",
      );
      const need = ["attempted", "written", "rejected", "rejected_reasons", "llm_calls", "est_cost_usd", "re_verified", "new_verified", "new_in_pool", "skipped_reason", "stopped_reason", "agent_ids"];
      assertTrue(claims.slice(0, 7).every((c: any) => need.every((k) => k in (c.meta ?? {}))), "h4: every step claim carries attempted/written/rejected(+reasons)/LLM/cost/re-verified/new verified/new in pool");
      const cr = claims.find((c: any) => c.meta?.kind === "rfb_enrichment_step_content_refresh");
      assertEq([cr?.value, cr?.meta?.attempted, cr?.meta?.rejected, cr?.meta?.rejected_reasons], [0, 5, 5, { unchanged: 5 }], "h5: rejected rows are counted with their reason");
      const cx = claims.find((c: any) => c.meta?.kind === "rfb_enrichment_step_contact_extraction");
      assertEq([cx?.value, cx?.meta?.re_verified, cx?.meta?.agent_ids], [4, 1, ["e2", "e3"]], "h6: re-verified credited to the step that changed the row (e0/e1 were Brreg's)");
      const llm = claims.find((c: any) => c.meta?.kind === "rfb_enrichment_llm_calls");
      assertEq([llm?.value, llm?.meta?.cap, llm?.meta?.est_cost_usd], [0, 150, 0], "h7: LLM claim with count, cap and estimated cost");
      assertTrue(typeof env.notes === "string" && env.notes.length <= 490 && env.notes.includes("verify=3/3"), "h8: notes are a short per-step summary");
    }

    // ── (f) AC1 LLM cap ──────────────────────────────────────────────────
    await withDb("f", async () => {
      setEnv({
        RFB_ENRICHMENT_NIGHTLY_ENABLED: "1",
        RFB_ENRICHMENT_LLM_CAP: "3",
        RFB_ENRICHMENT_CAP_BRREG: "5",
        RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "5",
        RFB_ENRICHMENT_CAP_URL_CHECK: "2",
        RFB_ENRICHMENT_CAP_CONTENT: "2",
        RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
        RFB_ENRICHMENT_LLM_USD_PER_CALL: "0.01",
        RFB_SECOND_LINE_VERIFICATION_ENABLED: "true",
      });
      for (let i = 0; i < 10; i++) seedGeneric(`f${i}`);
      const calls: Call[] = [];
      const judging = (step: string) => async (row: { id: string }) => {
        calls.push({ step, id: row.id, at: new Date().toISOString() });
        meterMod.noteLlmCall("contact-candidate-judge");
        return { outcome: "email_rejected_by_gate", written: false, changed: false };
      };
      const r = await job.runRfbEnrichmentNightly({
        apply: true,
        trigger: "manual",
        now: NIGHT,
        deps: { executors: stubExecutors(calls, realClock, { brregContact: judging("brreg_contact"), contactExtraction: judging("contact_extraction") }) },
      });
      const n = (step: string) => calls.filter((c) => c.step === step).length;
      assertEq([r.llm.calls, r.llm.cap, r.llm.cap_reached], [3, 3, true], "f1: model calls stop exactly at the cap");
      assertEq([n("brreg_contact"), n("contact_extraction")], [3, 0], "f2: Brreg stops at the cap; contact extraction is skipped for the night");
      const step = (s: string) => r.steps.find((x) => x.step === s)!;
      assertEq([step("brreg_contact").stopped_reason, step("contact_extraction").skipped_reason, step("reverify").skipped_reason], ["llm_cap_reached", "llm_cap_reached", "llm_cap_reached"], "f3: every LLM-needing step stops (verify needs the LLM with the second line on)");
      assertEq([n("url_check"), n("content_refresh")], [2, 2], "f4: steps without an LLM go on");
      assertEq([step("brreg_contact").llm_calls, step("brreg_contact").est_cost_usd, r.llm.est_cost_usd, r.llm.by_source], [3, 0.03, 0.03, { "contact-candidate-judge": 3 }], "f5: calls + estimated cost per step and per run");
      const env = db.prepare(`SELECT claims FROM runs WHERE agent = ?`).get(job.RFB_ENRICHMENT_NIGHTLY_AGENT) as { claims: string };
      const llm = JSON.parse(env.claims).find((c: any) => c.meta?.kind === "rfb_enrichment_llm_calls");
      assertEq([llm?.value, llm?.meta?.cap_reached], [3, true], "f6: the envelope reports the calls (≤ cap)");

      // Cap 0: no LLM step even starts.
      calls.length = 0;
      db.prepare(`DELETE FROM rfb_enrichment_nightly_attempts`).run();
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_LLM_CAP: "0", RFB_ENRICHMENT_CAP_BM_SLUGS: "0" });
      const r2 = await job.runRfbEnrichmentNightly({
        apply: true,
        trigger: "manual",
        now: NIGHT,
        deps: { executors: stubExecutors(calls, realClock, { brregContact: judging("brreg_contact"), contactExtraction: judging("contact_extraction") }) },
      });
      assertEq([r2.llm.calls, n("brreg_contact"), n("contact_extraction"), n("url_check") > 0], [0, 0, 0, true], "f7: LLM cap 0 → no LLM step runs, the rest do");
    });

    // ── (g) the verifier tick lock ───────────────────────────────────────
    await withDb("g", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_BM_SLUGS: "0" });
      for (let i = 0; i < 3; i++) seedGeneric(`g${i}`);
      const calls: Call[] = [];
      ledger.acquireLock({ agent: job.VERIFIER_TICK_LOCK_AGENT, run_id: "run-x-lokal-agent-verifier-tick", started_at: new Date().toISOString(), staleMinutes: 50 });
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "cron", now: NIGHT, deps: { executors: stubExecutors(calls, realClock) } });
      assertEq([r.skipped_reason, r.lock.holder?.run_id, calls.length, count("runs")], ["verifier_tick_lock_held", "run-x-lokal-agent-verifier-tick", 0, 0], "g1: a held verifier tick lock → skipped, no work, no envelope");
      assertEq(job.rfbEnrichmentRunConsumesWindow(r), false, "g1: retried on the next tick (does not consume the night)");
      const t = await job.tickRfbEnrichmentNightly({ now: NIGHT, lastRunAt: null, deps: { executors: stubExecutors(calls, realClock) } });
      assertEq([t.report?.skipped_reason, t.lastRunAt, count("boot_job_state")], ["verifier_tick_lock_held", null, 0], "g1: the tick leaves the night unstamped");

      db.prepare(`DELETE FROM orchestrator_locks`).run();
      let tickDuringRun: any = null;
      const probe = async (row: { id: string }) => {
        calls.push({ step: "url_check", id: row.id, at: new Date().toISOString() });
        if (!tickDuringRun) tickDuringRun = await runVerifierMod.runVerifierTick({ batchSize: 1 });
        return { outcome: "probe_ok", written: true, changed: false };
      };
      const r2 = await job.runRfbEnrichmentNightly({ apply: true, trigger: "cron", now: NIGHT, deps: { executors: stubExecutors(calls, realClock, { urlCheck: probe }) } });
      assertEq(r2.lock.acquired, true, "g2: the job takes the verifier's own tick lock");
      assertEq(
        [tickDuringRun?.skipped, String(tickDuringRun?.reason ?? "").includes(r2.run_id)],
        [true, true],
        "g2: a verifier tick during the run skips itself (never concurrent)",
      );
      assertEq([r2.lock.released, count("orchestrator_locks")], [true, 0], "g3: released at the end — the next verifier tick is free");
    });

    // ── (i) dry run / preview writes nothing, fetches nothing ────────────
    await withDb("i", async () => {
      setEnv({});
      for (let i = 0; i < 4; i++) seedGeneric(`i${i}`);
      seedAgent("i-maildomain", { k: { email: "post@egengard.no" } });
      seedAgent("i-unreach", { k: { website: "https://dod.no", homepage_unreachable_since: "2026-09-01T00:00:00Z" } });
      let fetches = 0;
      (globalThis as any).fetch = async () => {
        fetches++;
        throw new Error("a dry run must not fetch");
      };
      const tables = ["runs", "rfb_enrichment_nightly_attempts", "rfb_enrichment_sweep_state", "orchestrator_locks", "agent_knowledge_audit", "boot_job_state", "agents_org_nr_review_queue"];
      const snap = () => tables.map((tb) => { try { return count(tb); } catch { return -1; } });
      const knowSnap = () => JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all());
      const before = [snap(), knowSnap()];
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const dry = await job.runRfbEnrichmentNightly({ apply: false, trigger: "manual", now: NIGHT });
      const g = await callRoute(routes.rfbEnrichmentNightlyRouter, { url: "/preview", headers: auth });
      const pr = await callRoute(routes.rfbEnrichmentNightlyRouter, { method: "POST", url: "/run", headers: auth, body: {} });
      assertEq([snap(), knowSnap()], before, "i1: preview, dry run, GET /preview and POST /run (no apply) write nothing");
      assertEq(fetches, 0, "i1: and fetch nothing");
      assertEq([p.enabled_by_env, dry.apply, dry.skipped_reason, dry.envelope_recorded, g.status, pr.status, pr.body?.apply], [false, false, null, false, 200, 200, false], "i2: the dry run works with the flag off (AC2)");
      const sel = (s: string) => p.steps.find((x) => x.step === s);
      assertEq(sel("url_check")?.selected_ids, ["i0", "i1", "i2", "i3", "i-unreach"], "i3: preview lists the ids each step would take (url_check)");
      assertEq(sel("email_domain_website")?.selected_ids, ["i-maildomain"], "i3: email-domain website candidate (own domain, no website)");
      assertEq(sel("contact_extraction")?.selected_ids, ["i0", "i1", "i2", "i3"], "i3: contact extraction = site answers, no e-mail");
      assertEq(sel("reverify")?.selected_ids, ["i-unreach"], "i3: verify lists the ≥14-day unreachable rows");
      assertEq([sel("bm_harvest")?.bm?.offset, sel("bm_harvest")?.bm?.limit], [0, 60], "i3: BM window from the stored cursor");
      assertEq([p.cohort.eligible, p.caps.brreg_contact, p.llm_cap, p.verifier_tick_lock.held], [6, 25, 150, false], "i4: cohort size, caps and lock state reported");
    });

    // ── (j) BM cursor rotation ───────────────────────────────────────────
    await withDb("j", async () => {
      setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_BM_SLUGS: "60" });
      const total = { n: 354 };
      let scannedOverride: number | null = null;
      const offsets: number[] = [];
      const bm = async ({ offset, limit }: { offset: number; limit: number }) => {
        offsets.push(offset);
        const scanned = scannedOverride ?? Math.max(0, Math.min(limit, total.n - offset));
        return { status: 200, total_slugs: total.n, offset, scanned, time_budget_exceeded: false, counts: {}, changed_agent_ids: [], written: 0 };
      };
      const calls: Call[] = [];
      for (let night = 0; night < 7; night++) {
        await job.runRfbEnrichmentNightly({ apply: true, trigger: "cron", now: new Date(NIGHT.getTime() + night * 86_400_000), deps: { executors: stubExecutors(calls, realClock, { bmHarvest: bm }) } });
      }
      assertEq(offsets, [0, 60, 120, 180, 240, 300, 0], "j1: six nights of 60 cover 354 slugs, the seventh wraps to 0");
      assertEq(job.getRfbEnrichmentBmCursor(db).next_offset, 60, "j1: cursor persisted (after the wrap night it points at 60)");
      scannedOverride = 25;
      await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors(calls, realClock, { bmHarvest: bm }) } });
      assertEq(job.getRfbEnrichmentBmCursor(db).next_offset, 85, "j2: a partial scan (route time budget) advances by what was scanned");
      scannedOverride = null;
      job.setRfbEnrichmentBmCursor(db, 400, 420, new Date());
      offsets.length = 0;
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors(calls, realClock, { bmHarvest: bm }) } });
      assertEq([offsets, job.getRfbEnrichmentBmCursor(db).next_offset], [[400, 0], 60], "j3: a cursor past a shrunken catalog restarts at 0 the same night");
      const bmStep = r.steps.find((s) => s.step === "bm_harvest")!;
      assertEq([bmStep.extra?.offset, bmStep.extra?.next_offset, bmStep.extra?.total_slugs], [0, 60, 354], "j4: the step reports offset / next offset / total");
    });

    // ── (k) step 5 attribution + unreachable rows ────────────────────────
    await withDb("k", async () => {
      setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "1", RFB_ENRICHMENT_CAP_REVERIFY: "5" });
      seedGeneric("k-cx");
      seedAgent("k-dead", { k: { website: "https://k-dead.no", homepage_unreachable_since: "2026-09-01T00:00:00Z" } });
      seedAgent("k-dead-recent", { k: { website: "https://k-dead2.no", homepage_unreachable_since: "2026-10-05T00:00:00Z" } });
      const calls: Call[] = [];
      const cx = async (row: { id: string }) => {
        calls.push({ step: "contact_extraction", id: row.id, at: "" });
        db.prepare(`UPDATE agent_knowledge SET email = 'post@k-cx.no' WHERE agent_id = ?`).run(row.id);
        return { outcome: "written", written: true, changed: true };
      };
      const verify = async (agentId: string) => {
        calls.push({ step: "reverify", id: agentId, at: "" });
        if (agentId === "k-cx") {
          db.prepare(
            `UPDATE agent_knowledge SET verification_status = 'verified', enrichment_status = 'rich', about = ?, url_last_status = 200, url_last_probed = datetime('now') WHERE agent_id = ?`,
          ).run(LONG_ABOUT, agentId);
          return { outcome: "verified", prior: "pending_verify", next: "verified" };
        }
        return { outcome: "terminal_unconfirmable", prior: "pending_verify", next: "terminal_unconfirmable" };
      };
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors(calls, realClock, { contactExtraction: cx, reverify: verify }) } });
      assertEq(calls.filter((c) => c.step === "reverify").map((c) => c.id), ["k-cx", "k-dead"], "k1: changed rows first, then rows unreachable ≥14 days (not the 7-day one)");
      const step = (s: string) => r.steps.find((x) => x.step === s)!;
      assertEq([step("reverify").re_verified, step("reverify").new_verified, step("reverify").new_in_pool, step("reverify").extra?.new_terminal_unconfirmable], [2, 1, 1, 1], "k2: verify step totals");
      assertEq([step("contact_extraction").re_verified, step("contact_extraction").new_verified, step("contact_extraction").new_in_pool], [1, 1, 1], "k3: new verified + new in pool credited to the step that changed the row");
      assertEq([r.totals.new_verified, r.totals.new_in_pool, r.totals.changed_agents], [1, 1, 1], "k4: run totals");
      const stamped = db.prepare(`SELECT agent_id FROM rfb_enrichment_nightly_attempts WHERE step = 'reverify'`).all().map((x: any) => x.agent_id);
      assertEq(stamped, ["k-dead"], "k5: only the unreachable-row pick is stamped for rotation");
    });

    // ── (l) tick ─────────────────────────────────────────────────────────
    await withDb("l", async () => {
      setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1" });
      const calls: Call[] = [];
      const deps = { executors: stubExecutors(calls, realClock) };
      const t1 = await job.tickRfbEnrichmentNightly({ now: NIGHT, lastRunAt: null, deps });
      assertEq([t1.report?.skipped_reason, t1.report?.envelope_recorded, t1.lastRunAt?.toISOString()], [null, true, NIGHT.toISOString()], "l1: first tick in the slot runs and stamps");
      const t2 = await job.tickRfbEnrichmentNightly({ now: new Date("2026-10-12T01:40:00Z"), lastRunAt: null, deps });
      assertEq(t2.report, null, "l2: a restart later the same night skips (persisted stamp)");
      const t3 = await job.tickRfbEnrichmentNightly({ now: new Date("2026-10-12T08:05:00Z"), lastRunAt: null, deps });
      assertEq(t3.report, null, "l3: never in 08Z");
      const t4 = await job.tickRfbEnrichmentNightly({ now: new Date("2026-10-13T00:05:00Z"), lastRunAt: t1.lastRunAt, deps });
      assertEq([t4.report?.run_id, count("runs")], ["run-2026-10-13-rfb-enrichment-nightly", 2], "l4: the next night runs again — one envelope per night");
    });

    // ── (m) rotation memory ──────────────────────────────────────────────
    await withDb("m", async () => {
      setEnv({ RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "10" });
      seedGeneric("m-recent");
      seedGeneric("m-old");
      seedGeneric("m-never");
      seedAgent("m-tier1", { k: { email: "post@m.no", website: "https://m-tier1.no", url_last_status: 200 } });
      const ins = db.prepare(`INSERT INTO rfb_enrichment_nightly_attempts (agent_id, step, last_attempted_at, last_outcome) VALUES (?, 'contact_extraction', ?, 'no_contact_found')`);
      ins.run("m-recent", new Date(NIGHT.getTime() - 3 * 86_400_000).toISOString());
      ins.run("m-old", new Date(NIGHT.getTime() - 20 * 86_400_000).toISOString());
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(p.steps.find((s) => s.step === "contact_extraction")?.selected_ids, ["m-never", "m-old"], "m1: tried 3 days ago → left out (14-day retry); never tried before tried-20-days-ago");
      assertEq(p.steps.find((s) => s.step === "url_check")?.selected_ids, ["m-tier1", "m-recent", "m-old", "m-never"], "m2: closest-to-pool tier first");
    });

    // ── (n) real executors ───────────────────────────────────────────────
    await withDb("n", async () => {
      setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_URL_CHECK: "5", RFB_ENRICHMENT_CAP_BM_SLUGS: "2" });
      seedAgent("n-live", { k: { website: "https://n-live.no" } });
      seedAgent("n-gone", { k: { website: "https://n-gone.no" } });
      const slugs = ["bm-a", "bm-b", "bm-c", "bm-d", "bm-e"];
      const sitemap = `<urlset>${slugs.map((s) => `<url><loc>https://bondensmarked.no/produsenter/${s}</loc></url>`).join("")}</urlset>`;
      const fetched: string[] = [];
      (globalThis as any).fetch = async (url: any, init?: any) => {
        const u = String(url);
        fetched.push(`${init?.method ?? "GET"} ${u}`);
        if (u === "https://bondensmarked.no/sitemap.xml") return new Response(sitemap, { status: 200 });
        if (u.startsWith("https://bondensmarked.no/produsenter/")) return new Response("<html></html>", { status: 200 });
        if (u.startsWith("https://n-live.no")) return new Response("", { status: 200 });
        throw new Error("getaddrinfo ENOTFOUND");
      };
      const r1 = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT });
      const k = (id: string) => db.prepare(`SELECT url_last_status, url_last_probed FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
      assertEq([k("n-live").url_last_status, k("n-gone").url_last_status], [200, 0], "n1: the real URL probe writes url_last_status (200 / 0)");
      assertTrue(!!k("n-live").url_last_probed && !!k("n-gone").url_last_probed, "n1: and url_last_probed");
      const bmStep = r1.steps.find((s) => s.step === "bm_harvest")!;
      assertEq([bmStep.attempted, bmStep.extra?.offset, bmStep.extra?.next_offset, bmStep.extra?.total_slugs], [2, 0, 2, 5], "n2: the real BM route ran in process over slugs 0..1");
      assertTrue(fetched.includes("GET https://bondensmarked.no/produsenter/bm-a") && fetched.includes("GET https://bondensmarked.no/produsenter/bm-b") && !fetched.some((f) => f.endsWith("/bm-c")), "n2: exactly the window's pages were fetched");
      fetched.length = 0;
      await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT });
      assertTrue(fetched.some((f) => f.endsWith("/bm-c")) && fetched.some((f) => f.endsWith("/bm-d")) && !fetched.some((f) => f.endsWith("/bm-a")), "n3: the next run continues at the stored offset (slugs 2..3)");
      assertEq(job.getRfbEnrichmentBmCursor(db).next_offset, 4, "n3: cursor advanced to 4");
    });

    // ── (o) admin routes ─────────────────────────────────────────────────
    await withDb("o", async () => {
      setEnv({});
      const r403 = await callRoute(routes.rfbEnrichmentNightlyRouter, { method: "POST", url: "/run", headers: { "x-admin-key": "wrong" }, body: { apply: true } });
      const g403 = await callRoute(routes.rfbEnrichmentNightlyRouter, { url: "/preview", headers: {} });
      assertEq([r403.status, g403.status], [403, 403], "o1: both routes require the admin key");
      const off = await callRoute(routes.rfbEnrichmentNightlyRouter, { method: "POST", url: "/run", headers: auth, body: { apply: true } });
      assertEq([off.status, off.body?.skipped_reason, off.body?.apply], [200, "disabled_by_env", true], "o2: apply with the flag off answers at once: disabled_by_env");
      const last = await callRoute(routes.rfbEnrichmentNightlyRouter, { url: "/last", headers: auth });
      assertEq(last.body?.report?.skipped_reason, "disabled_by_env", "o3: GET /last returns the last apply report");
    });

    // ── (p) enrichment write-pause ───────────────────────────────────────
    await withDb("p", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CAP_BM_SLUGS: "5" });
      for (let i = 0; i < 3; i++) seedGeneric(`p${i}`);
      seedAgent("p-dead", { k: { website: "https://p-dead.no", homepage_unreachable_since: "2026-09-01T00:00:00Z" } });
      pause.setEnrichmentWritePause(db, { vertical: "rfb", enabled: true, reason: "test" }, "test");
      const calls: Call[] = [];
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors(calls, realClock) } });
      assertEq(calls.filter((c) => c.step !== "reverify").length, 0, "p1: no writing step runs while the write-pause is on");
      assertTrue(
        r.steps.filter((s) => s.step !== "reverify").every((s) => s.skipped_reason === "enrichment_write_paused"),
        "p1: every writing step reports enrichment_write_paused",
      );
      assertEq(calls.filter((c) => c.step === "reverify").map((c) => c.id), ["p-dead"], "p2: verification (exempt by design) still runs");
    });
  } catch (err) {
    failed++;
    failures.push(`rfb-enrichment-nightly: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    (globalThis as any).fetch = prevFetch;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  runRfbEnrichmentNightlyTests({ log: true }).then((r) => {
    console.log(`\nrfb-enrichment-nightly: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
