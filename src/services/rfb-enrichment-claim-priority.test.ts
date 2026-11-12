/**
 * rfb-enrichment-claim-priority.test.ts — slice D4 of dev-request
 * 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk: RFB profiles with
 * an open owner claim that are thin / not reviewed go first in the nightly
 * enrichment job (services/rfb-enrichment-nightly.ts), behind
 * RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED (default OFF).
 *
 * Every block runs on a FRESH in-memory main DB with the full production
 * schema (__pinInMemoryDbForTesting, restored in finally). Selection is read
 * through the job's own read-only preview; the run report through a dry run
 * and an apply run whose step caps are all 0 (no executor is ever called).
 * No network, no model call.
 *
 * Covers:
 *   (k)  knobs: the flag is on only for the exact string "true"; the age
 *        window parses defensively (unset/junk → 30, clamped to [1, 365])
 *   D4.1 flag ON: an open claim (pending / code_sent / pending_review) on a
 *        thin row (empty website, empty or placeholder e-mail, empty
 *        address) ranks first — ahead of a tier-1 row and of its same-tier
 *        twin; verified / rejected / expired claims, claims older than 30
 *        days or with source 'test', and a claim on a row that is not thin
 *        give no priority; SQLite datetime('now') created_at parsed as UTC
 *   D4.2 flag ON: a step attempt yesterday (inside the retry window) and a
 *        claim today → the row is selected; a claim from BEFORE that
 *        attempt → skipped as today; once re-attempted after the claim it is
 *        skipped again (one fresh attempt per claim, never every night)
 *   D4.3 flag ON: is_vetted = 0 with an open claim → in the cohort
 *        (claim_priority_admitted_unvetted = 1); without a claim → still
 *        excluded as unvetted; an open-claim row that is curated or opted
 *        out → still excluded
 *   D4.4 flag OFF: selection and report exactly as without any claim (the
 *        whole preview JSON is identical), no claim_priority keys in the
 *        preview, the dry-run report or the apply-run report, and the
 *        claims query never runs; flag ON adds the keys to both reports
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-enrichment-claim-priority.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED",
  "RFB_ENRICHMENT_CLAIM_PRIORITY_DAYS",
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
  "OWNER_AUTO_UPDATES_ENABLED",
  // Cleared for every block (restored after): no block may reach a real model.
  "ANTHROPIC_API_KEY",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

export async function runRfbEnrichmentClaimPriorityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  try {
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded by an earlier suite in this process
  }
  const initMod = require("../database/init") as typeof import("../database/init");
  const job = require("./rfb-enrichment-nightly") as typeof import("./rfb-enrichment-nightly");

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];

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
      restore();
      db = null;
    }
  }

  let seq = 0;
  /**
   * A producer row. Default: vetted, a website not yet probed (url_check
   * eligible), a real e-mail and a street address — i.e. tier 1 and NOT thin.
   */
  function seedAgent(
    id: string,
    o: {
      contact_email?: string;
      url?: string;
      is_vetted?: number | null;
      website?: string | null;
      email?: string | null;
      address?: string | null;
      curated_fields?: string | null;
      verification_status?: string;
    } = {},
  ): void {
    seq += 1;
    const cols: Record<string, unknown> = {
      id,
      name: `Gård ${id}`,
      description: "test",
      provider: "test",
      contact_email: o.contact_email ?? "",
      url: o.url ?? "",
      role: "producer",
      api_key: `key-${id}`,
      created_at: `2026-01-01 00:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`,
    };
    if (o.is_vetted !== undefined) cols.is_vetted = o.is_vetted;
    const names = Object.keys(cols);
    db.prepare(`INSERT INTO agents (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
      ...names.map((n) => cols[n]),
    );
    const kc: Record<string, unknown> = {
      agent_id: id,
      verification_status: o.verification_status ?? "pending_verify",
      website: o.website === undefined ? `https://${id}.no` : o.website,
      email: o.email === undefined ? `post@${id}.no` : o.email,
      address: o.address === undefined ? "Gardsvegen 1" : o.address,
    };
    if (o.curated_fields !== undefined) kc.curated_fields = o.curated_fields;
    const kn = Object.keys(kc);
    db.prepare(`INSERT INTO agent_knowledge (${kn.join(", ")}) VALUES (${kn.map(() => "?").join(", ")})`).run(
      ...kn.map((n) => kc[n]),
    );
  }

  let claimSeq = 0;
  function seedClaim(agentId: string, status: string, createdAt: string, source: string | null = "organic"): void {
    claimSeq += 1;
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, source, created_at)
       VALUES (?, ?, 'Eier', 'eier@example.no', ?, ?, ?)`,
    ).run(`cl-${claimSeq}`, agentId, status, source, createdAt);
  }

  const NIGHT = new Date("2026-10-12T00:10:00Z");
  /** SQLite datetime('now') format (UTC, no zone) for NIGHT + deltaMs. */
  const sqlTs = (deltaMs: number): string =>
    new Date(NIGHT.getTime() + deltaMs).toISOString().replace("T", " ").slice(0, 19);
  const DAY = 86_400_000;
  const ALL_CAPS_ZERO: Partial<Record<EnvKey, string>> = {
    RFB_ENRICHMENT_CAP_URL_CHECK: "0",
    RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "0",
    RFB_ENRICHMENT_CAP_BRREG: "0",
    RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
    RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "0",
    RFB_ENRICHMENT_CAP_CONTENT: "0",
    RFB_ENRICHMENT_CAP_REVERIFY: "0",
  };
  const urlCheckIds = (p: Awaited<ReturnType<typeof job.buildRfbEnrichmentPreview>>): string[] =>
    p.steps.find((s) => s.step === "url_check")?.selected_ids ?? [];
  const noExec = async (): Promise<never> => {
    throw new Error("no executor may run in this suite");
  };
  const noExecutors = {
    urlCheck: noExec,
    emailDomainWebsite: noExec,
    brregContact: noExec,
    contactExtraction: noExec,
    contentRefresh: noExec,
    bmHarvest: noExec,
    reverify: noExec,
  } as any;

  try {
    // ── (k) knobs ─────────────────────────────────────────────────────────
    {
      setEnv({});
      assertEq(job.isRfbEnrichmentClaimPriorityEnabled(), false, "k1: flag unset → off (default OFF)");
      for (const [v, want] of [["true", true], ["1", false], ["TRUE", false], ["yes", false], [" true", false]] as const) {
        setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: v });
        assertEq(job.isRfbEnrichmentClaimPriorityEnabled(), want, `k1: flag "${v}" → ${want} (only the exact "true")`);
      }
      for (const [v, want] of [[undefined, 30], ["", 30], ["junk", 30], ["-5", 30], ["7.5", 30], ["7", 7], ["0", 1], ["9999", 365]] as const) {
        setEnv(v === undefined ? {} : { RFB_ENRICHMENT_CLAIM_PRIORITY_DAYS: v });
        assertEq(job.resolveRfbEnrichmentClaimPriorityDays(), want, `k2: RFB_ENRICHMENT_CLAIM_PRIORITY_DAYS=${JSON.stringify(v)} → ${want}`);
      }
    }

    // ── D4.1 priority ahead of the tiers; which claims count ──────────────
    await withDb("d4.1", async () => {
      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true" });
      // Tier 1 (e-mail + website, not thin) — no claim.
      seedAgent("t1-full");
      // Tier 3 twins (e-mail, no knowledge website; agents.url is the homepage for url_check).
      seedAgent("t3-noclaim", { website: "", url: "https://t3-noclaim.no" });
      // Tier 3, claims that must NOT give priority.
      seedAgent("n-rejected", { website: "", url: "https://n-rejected.no" });
      seedClaim("n-rejected", "rejected", sqlTs(-DAY));
      seedAgent("n-expired", { website: "", url: "https://n-expired.no" });
      seedClaim("n-expired", "expired", sqlTs(-DAY));
      seedAgent("n-old", { website: "", url: "https://n-old.no" });
      seedClaim("n-old", "pending", sqlTs(-31 * DAY));
      seedAgent("n-testsrc", { website: "", url: "https://n-testsrc.no" });
      seedClaim("n-testsrc", "pending", sqlTs(-DAY), "test");
      seedAgent("n-verified", { website: "", url: "https://n-verified.no" });
      seedClaim("n-verified", "verified", sqlTs(-DAY));
      // Open claim on a row that is NOT thin (vetted, website, e-mail, address) → no priority.
      seedAgent("n-notthin");
      seedClaim("n-notthin", "pending", sqlTs(-DAY));
      // Open claims on thin rows → priority 0. Seeded last, so cohort order puts them last.
      seedAgent("p-claim", { website: "", url: "https://p-claim.no" });
      seedClaim("p-claim", "pending", sqlTs(-DAY));
      seedClaim("p-claim", "rejected", sqlTs(-2 * DAY)); // an older closed claim beside it changes nothing
      seedAgent("p-codesent-noaddr", { address: "" });
      seedClaim("p-codesent-noaddr", "code_sent", sqlTs(-29 * DAY));
      seedAgent("p-review-placeholder", { email: "Kontakt@RettFraBonden.com", contact_email: " kontakt@rettfrabonden.com " });
      seedClaim("p-review-placeholder", "pending_review", sqlTs(-2 * 60_000));
      seedClaim("p-review-placeholder", "pending", sqlTs(-10 * DAY), null); // NULL source counts as not-test

      const cohort = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
      assertEq(
        [...(cohort.claimPriority?.keys() ?? [])].sort(),
        ["p-claim", "p-codesent-noaddr", "p-review-placeholder"],
        "D4.1: only open (pending/code_sent/pending_review), recent, non-test claims on thin rows are prioritised",
      );
      assertEq(
        cohort.claimPriority?.get("p-review-placeholder"),
        NIGHT.getTime() - 2 * 60_000,
        "D4.1: the newest open claim per agent; SQLite datetime('now') created_at parsed as UTC",
      );
      assertEq(cohort.rows.find((r) => r.id === "n-verified"), undefined, "D4.1: a verified claim is a customer — left out of the cohort as before");
      assertEq(cohort.rows.find((r) => r.id === "p-claim")?.tier, 3, "D4.1: the prioritised row keeps its own tier (3)");
      assertEq(cohort.rows.find((r) => r.id === "t3-noclaim")?.tier, 3, "D4.1: its twin is the same tier");

      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(
        urlCheckIds(p),
        ["p-claim", "p-codesent-noaddr", "p-review-placeholder", "t1-full", "n-notthin", "t3-noclaim", "n-rejected", "n-expired", "n-old", "n-testsrc"],
        "D4.1: prioritised rows first (ahead of tier 1, cohort order among them), then tiers 1 → 3 as before",
      );
      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true", RFB_ENRICHMENT_CAP_URL_CHECK: "2" });
      const capped = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(urlCheckIds(capped), ["p-claim", "p-codesent-noaddr"], "D4.1: within the step's own cap");
      assertEq(capped.steps.find((s) => s.step === "url_check")?.eligible, 10, "D4.1: eligibility unchanged (stepEligible)");
      assertEq(
        [p.cohort.claim_priority, p.cohort.claim_priority_admitted_unvetted],
        [3, 0],
        "D4.1: preview cohort reports claim_priority = 3, claim_priority_admitted_unvetted = 0",
      );

      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true", RFB_ENRICHMENT_CLAIM_PRIORITY_DAYS: "7" });
      const narrow = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
      assertEq(
        [...(narrow.claimPriority?.keys() ?? [])].sort(),
        ["p-claim", "p-review-placeholder"],
        "D4.1: RFB_ENRICHMENT_CLAIM_PRIORITY_DAYS=7 drops the 29-day-old claim",
      );
    });

    // ── D4.2 one fresh attempt per claim inside the retry window ──────────
    await withDb("d4.2", async () => {
      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true" });
      job.ensureRfbEnrichmentNightlyTables(db);
      const stamp = db.prepare(
        `INSERT INTO rfb_enrichment_nightly_attempts (agent_id, step, last_attempted_at, last_outcome)
         VALUES (?, 'url_check', ?, 'unchanged')
         ON CONFLICT(agent_id, step) DO UPDATE SET last_attempted_at = excluded.last_attempted_at`,
      );
      const yesterday = new Date(NIGHT.getTime() - DAY).toISOString();
      seedAgent("r-claim-after", { website: "", url: "https://r-claim-after.no" });
      stamp.run("r-claim-after", yesterday);
      seedClaim("r-claim-after", "pending", sqlTs(-10 * 60_000)); // today, after yesterday's attempt
      seedAgent("r-claim-before", { website: "", url: "https://r-claim-before.no" });
      stamp.run("r-claim-before", yesterday);
      seedClaim("r-claim-before", "pending", sqlTs(-2 * DAY)); // before yesterday's attempt
      seedAgent("r-noclaim", { website: "", url: "https://r-noclaim.no" });
      stamp.run("r-noclaim", yesterday);
      // Same-hour UTC check: a claim 30 min after the attempt, in SQLite format —
      // parsed as local time anywhere east of UTC it would look older.
      seedAgent("r-claim-utc", { website: "", url: "https://r-claim-utc.no" });
      stamp.run("r-claim-utc", "2026-10-11T23:00:00.000Z");
      seedClaim("r-claim-utc", "code_sent", "2026-10-11 23:30:00");

      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(
        urlCheckIds(p),
        ["r-claim-after", "r-claim-utc"],
        "D4.2: tried yesterday + claim today → selected; claim before that attempt → skipped as today; no claim → skipped",
      );
      assertEq(p.cohort.claim_priority, 3, "D4.2: all three claim rows are prioritised (the skipped one too)");
      setEnv({});
      const off = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(urlCheckIds(off), [], "D4.2: flag off → the retry window holds for every row");
      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true" });

      // The fresh attempt happens tonight; tomorrow it is newer than the claim → rotation memory again.
      stamp.run("r-claim-after", NIGHT.toISOString());
      stamp.run("r-claim-utc", NIGHT.toISOString());
      const tomorrow = await job.buildRfbEnrichmentPreview(db, new Date(NIGHT.getTime() + DAY));
      assertEq(urlCheckIds(tomorrow), [], "D4.2: once attempted after the claim, the row waits out the retry window (never every night)");

    });

    // ── D4.3 cohort: only the unvetted exclusion is lifted ────────────────
    await withDb("d4.3", async () => {
      setEnv({ RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true" });
      seedAgent("u-claim", { is_vetted: 0 });
      seedClaim("u-claim", "pending", sqlTs(-DAY));
      seedAgent("u-noclaim", { is_vetted: 0 });
      seedAgent("u-oldclaim", { is_vetted: 0 });
      seedClaim("u-oldclaim", "pending", sqlTs(-45 * DAY));
      seedAgent("u-claim-curated", { is_vetted: 0, curated_fields: JSON.stringify({ about: { by: "owner" } }) });
      seedClaim("u-claim-curated", "pending", sqlTs(-DAY));
      seedAgent("c-claim-curated", { curated_fields: JSON.stringify({ about: { by: "owner" } }) });
      seedClaim("c-claim-curated", "pending", sqlTs(-DAY));
      seedAgent("o-claim-optout", { verification_status: "opt_out", website: "" });
      seedClaim("o-claim-optout", "pending", sqlTs(-DAY));
      seedAgent("v-plain");

      const cohort = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
      assertEq(cohort.rows.map((r) => r.id).sort(), ["u-claim", "v-plain"], "D4.3: the unvetted row with an open claim is admitted; nothing else changes");
      assertEq(cohort.claimPriorityAdmittedUnvetted, 1, "D4.3: claim_priority_admitted_unvetted = 1");
      assertEq([...(cohort.claimPriority?.keys() ?? [])], ["u-claim"], "D4.3: the admitted row is prioritised (unvetted = thin)");
      assertEq(
        cohort.excluded,
        { umbrella: 0, inactive: 0, unvetted: 3, customer: 0, curated: 1, opt_out: 1, contacted: 0, blocklisted: 0, terminal_dead: 0 },
        "D4.3: unvetted without a (recent) claim still excluded; curated / opt_out with a claim still excluded (unvetted+curated stays counted as unvetted)",
      );
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(
        [p.cohort.eligible, p.cohort.claim_priority, p.cohort.claim_priority_admitted_unvetted],
        [2, 1, 1],
        "D4.3: preview cohort eligible = 2, claim_priority = 1, claim_priority_admitted_unvetted = 1",
      );
      assertEq(urlCheckIds(p), ["u-claim", "v-plain"], "D4.3: and it goes first");

      setEnv({});
      const off = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
      assertEq(off.rows.map((r) => r.id), ["v-plain"], "D4.3: flag off → the unvetted claim row is excluded as before");
      assertEq(off.excluded.unvetted, 4, "D4.3: flag off → counted as unvetted");
    });

    // ── D4.4 flag off = exactly as today; flag on adds the report keys ────
    await withDb("d4.4", async () => {
      seedAgent("t1-full");
      seedAgent("t3-noclaim", { website: "", url: "https://t3-noclaim.no" });
      seedAgent("p-claim", { website: "", url: "https://p-claim.no" });
      seedAgent("u-claim", { is_vetted: 0 });
      seedClaim("p-claim", "pending", sqlTs(-DAY));
      seedClaim("u-claim", "pending", sqlTs(-DAY));

      // Spy on the claims query: it must not run with the flag off.
      const origPrepare = db.prepare;
      let claimQueries = 0;
      db.prepare = function (this: any, sql: string) {
        if (/COALESCE\(source, ''\) <> 'test'/.test(sql)) claimQueries++;
        return origPrepare.call(this, sql);
      };
      try {
        for (const off of [undefined, "1", "TRUE", "false"] as const) {
          setEnv(off === undefined ? {} : { RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: off });
          claimQueries = 0;
          const withClaims = await job.buildRfbEnrichmentPreview(db, NIGHT);
          assertEq(claimQueries, 0, `D4.4: flag ${JSON.stringify(off)} → the claims query never runs`);
          assertEq(
            Object.keys(withClaims.cohort),
            ["considered", "eligible", "excluded", "by_tier"],
            `D4.4: flag ${JSON.stringify(off)} → preview cohort has exactly today's keys`,
          );
          assertEq(urlCheckIds(withClaims), ["t1-full", "t3-noclaim", "p-claim"], `D4.4: flag ${JSON.stringify(off)} → tier order as today`);
          const dry = await job.runRfbEnrichmentNightly({ apply: false, trigger: "manual", now: NIGHT });
          assertEq(
            Object.keys(dry.cohort ?? {}),
            ["considered", "eligible", "excluded", "by_tier"],
            `D4.4: flag ${JSON.stringify(off)} → dry-run report cohort has no claim_priority keys`,
          );
        }

        // Byte-identical: the same preview with every claim removed.
        setEnv({});
        const before = JSON.stringify(await job.buildRfbEnrichmentPreview(db, NIGHT));
        const saved = db.prepare(`SELECT * FROM agent_claims`).all();
        db.prepare(`DELETE FROM agent_claims`).run();
        const without = JSON.stringify(await job.buildRfbEnrichmentPreview(db, NIGHT));
        assertEq(before === without, true, "D4.4: flag off → the whole preview is byte-identical with or without open claims");
        for (const c of saved as Array<Record<string, unknown>>) {
          const ks = Object.keys(c);
          db.prepare(`INSERT INTO agent_claims (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`).run(...ks.map((k) => c[k]));
        }

        // Apply run (all caps 0, no executor runs): the run report's cohort.
        setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1" });
        claimQueries = 0;
        const runOff = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: noExecutors } });
        assertEq(runOff.skipped_reason, null, "D4.4: the apply run (flag off) ran");
        assertEq(Object.keys(runOff.cohort ?? {}), ["considered", "eligible", "excluded", "by_tier"], "D4.4: flag off → run report cohort has no claim_priority keys");
        assertEq(claimQueries, 0, "D4.4: flag off → no claims query in the apply run either");

        setEnv({ ...ALL_CAPS_ZERO, RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED: "true" });
        const runOn = await job.runRfbEnrichmentNightly({
          apply: true,
          trigger: "manual",
          now: new Date(NIGHT.getTime() + 60_000),
          force: true,
          deps: { executors: noExecutors },
        });
        assertEq(runOn.skipped_reason, null, "D4.4: the forced apply run (flag on) ran");
        assertEq(
          runOn.cohort && [runOn.cohort.eligible, runOn.cohort.claim_priority, runOn.cohort.claim_priority_admitted_unvetted],
          [4, 2, 1],
          "D4.4: flag on → run report cohort has claim_priority = 2 and claim_priority_admitted_unvetted = 1",
        );
        assertEq(claimQueries, 1, "D4.4: flag on → exactly one claims query per cohort load");

        const dryOn = await job.runRfbEnrichmentNightly({ apply: false, trigger: "manual", now: NIGHT });
        assertEq(
          Object.keys(dryOn.cohort ?? {}),
          ["considered", "eligible", "excluded", "by_tier", "claim_priority", "claim_priority_admitted_unvetted"],
          "D4.4: flag on → dry-run report cohort gains the two keys (after today's)",
        );
      } finally {
        db.prepare = origPrepare;
      }
    });
  } finally {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbEnrichmentClaimPriorityTests({ log: true }).then((r) => {
    console.log(`\nrfb-enrichment-claim-priority: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
