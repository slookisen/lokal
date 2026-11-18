/**
 * rfb-enrichment-needs-owner.test.ts — slice B3 of dev-request
 * 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer: "two misses on the
 * same source give needs_owner" in the nightly enrichment job's
 * content_refresh step (services/rfb-enrichment-nightly.ts).
 *
 * Every block runs on a FRESH in-memory main DB with the full production
 * schema (__pinInMemoryDbForTesting, restored in finally). content_refresh's
 * executor is a stub that answers per row; every other step has cap 0 and a
 * throwing executor. No network, no model call.
 *
 * Covers:
 *   (n1) two products misses on two nights → products needs_owner; the third
 *        night the row is neither in the preview's selection nor run
 *        (skipped_needs_owner counted); the envelope + run report + preview
 *        count it (total, by field, newly set this run)
 *   (n2) miss, success, miss → no needs_owner (a success resets the count)
 *   (n3) a marker older than 60 days → the row is selectable again; one more
 *        miss renews the marker
 *   (n4) per field: categories needs_owner alone keeps a row with generic
 *        products selectable (for products); both marked → not selected;
 *        products marked but categories open → selected, run WITHOUT the
 *        product-name model call (no reservation)
 *   (n5) contacted + verified + held by the gate (generic products /
 *        uncorroborated categories) → content_refresh may take it (after the
 *        uncontacted rows, same cap) and no other step does; contacted but
 *        not verified, or verified but not held, or contacted + also
 *        opted out → not taken
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-enrichment-needs-owner.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED",
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
  "ANTHROPIC_API_KEY",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

export async function runRfbEnrichmentNeedsOwnerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  type Outcome = import("./rfb-enrichment-nightly").RfbEnrichmentRowOutcome;
  type Preview = Awaited<ReturnType<typeof job.buildRfbEnrichmentPreview>>;

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
      job.ensureRfbEnrichmentNightlyTables(db);
      await fn();
    } catch (err) {
      failed++;
      failures.push(`${label}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      restore();
      db = null;
    }
  }

  const LONG_ABOUT =
    "Vi er en liten familiegård som dyrker grønnsaker og bær, og selger direkte fra gården hele sesongen gjennom.";
  const GEN = JSON.stringify([{ name: "Egg", category: "eggs", seasonal: false }]);
  const REAL3 = JSON.stringify([{ name: "Lammepølse" }, { name: "Spekeskinke" }, { name: "Eplemost" }]);
  const CATS = JSON.stringify(["vegetables"]);
  const hp = (v: string) => [{ source_type: "website_homepage", value: v, fetched_at: "2026-01-01T00:00:00.000Z" }];
  /** about corroborated; categories NOT (no categories provenance). */
  const PROV_NO_CATS = JSON.stringify({ about: hp(LONG_ABOUT) });
  /** about + categories corroborated by the homepage. */
  const PROV_CATS_OK = JSON.stringify({ about: hp(LONG_ABOUT), categories: hp("vegetables") });

  let seq = 0;
  /**
   * A content_refresh row: own site that answers, long about. `products`
   * generic → wants product names; `categories` without a homepage source
   * → held on categories_not_corroborated.
   */
  function seedRow(
    id: string,
    o: { products?: string; categories?: string; prov?: string; verification_status?: string; url_last_probed?: string | null } = {},
  ): void {
    seq += 1;
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, created_at, categories)
       VALUES (?, ?, 'test', 'test', ?, '', 'producer', ?, ?, ?)`,
    ).run(
      id,
      `Gård ${id}`,
      `post@${id}.no`,
      `key-${id}`,
      `2026-01-01 00:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`,
      o.categories ?? CATS,
    );
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, verification_status, website, email, about, products, field_provenance, url_last_status, url_last_probed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 200, ?)`,
    ).run(
      id,
      o.verification_status ?? "pending_verify",
      `https://${id}.no`,
      `post@${id}.no`,
      LONG_ABOUT,
      o.products ?? REAL3,
      o.prov ?? PROV_CATS_OK,
      o.url_last_probed === undefined ? "2026-10-01T00:00:00.000Z" : o.url_last_probed,
    );
  }
  function markContacted(id: string): void {
    db.prepare(
      `INSERT INTO outreach_sent_log (agent_id, recipient_email, channel, message_id, notes, vertical_id)
       VALUES (?, ?, 'email', ?, 'test', 'rfb')`,
    ).run(id, `post@${id}.no`, `m-${id}`);
  }
  function seedMarker(id: string, field: "categories" | "products", misses: number, at: Date): void {
    db.prepare(
      `INSERT INTO rfb_enrichment_nightly_attempts (agent_id, step, last_attempted_at, last_outcome, last_run_id)
       VALUES (?, ?, ?, ?, 'seed')`,
    ).run(id, job.rfbEnrichmentNeedsOwnerStepKey(field), at.toISOString(), `${misses >= 2 ? "needs_owner" : "miss"} misses=${misses}`);
  }
  const markerOf = (id: string, field: "categories" | "products"): string | null =>
    (
      db
        .prepare(`SELECT last_outcome FROM rfb_enrichment_nightly_attempts WHERE agent_id = ? AND step = ?`)
        .get(id, job.rfbEnrichmentNeedsOwnerStepKey(field)) as { last_outcome: string } | undefined
    )?.last_outcome ?? null;

  const DAY = 86_400_000;
  // Two days apart: the retry window (1 day) has always passed by the next night.
  const night = (n: number) => new Date(Date.UTC(2026, 10, 1 + 2 * n, 0, 10));
  const ONLY_CONTENT: Partial<Record<EnvKey, string>> = {
    RFB_ENRICHMENT_NIGHTLY_ENABLED: "1",
    RFB_ENRICHMENT_RETRY_DAYS: "1",
    RFB_ENRICHMENT_CAP_URL_CHECK: "0",
    RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "0",
    RFB_ENRICHMENT_CAP_BRREG: "0",
    RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
    RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "0",
    RFB_ENRICHMENT_CAP_CONTENT: "10",
    RFB_ENRICHMENT_CAP_REVERIFY: "0",
  };
  const noExec = async (): Promise<never> => {
    throw new Error("no executor but content_refresh may run in this suite");
  };
  const contentIds = (p: Preview): string[] => p.steps.find((s) => s.step === "content_refresh")?.selected_ids ?? [];
  const contentStep = (p: Preview) => p.steps.find((s) => s.step === "content_refresh");

  /** Stub executors: content_refresh answers from `answers[id]`; calls recorded with their opts. */
  function executors(answers: Record<string, Partial<Outcome>>, calls: Array<{ id: string; productNames: boolean }>): any {
    return {
      urlCheck: noExec,
      emailDomainWebsite: noExec,
      brregContact: noExec,
      contactExtraction: noExec,
      bmHarvest: noExec,
      reverify: noExec,
      contentRefresh: async (row: { id: string }, _deadline: number, o?: { productNames?: boolean }) => {
        calls.push({ id: row.id, productNames: o?.productNames === true });
        const a = answers[row.id] ?? {};
        return { outcome: "unchanged", written: false, changed: false, ...a } as Outcome;
      },
    };
  }
  const PROD_MISS: Partial<Outcome> = { outcome: "products_not_supported_by_homepage", product_names: "products_not_supported_by_homepage" };
  const PROD_OK: Partial<Outcome> = { outcome: "products_replaced", product_names: "products_replaced", written: true, changed: true };
  const CAT_MISS: Partial<Outcome> = { outcome: "categories_not_supported_by_homepage", categories_corroboration: "categories_not_supported_by_homepage" };

  async function run(n: number, answers: Record<string, Partial<Outcome>>, calls: Array<{ id: string; productNames: boolean }> = []) {
    return job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: night(n), deps: { executors: executors(answers, calls) } });
  }
  const claimsOf = (runId: string): any[] =>
    JSON.parse((db.prepare(`SELECT claims FROM runs WHERE run_id = ?`).get(runId) as { claims: string }).claims);

  try {
    // ── (n1) two misses → needs_owner, not selected the third night ──────
    await withDb("n1", async () => {
      setEnv(ONLY_CONTENT);
      seedRow("a-prod", { products: GEN });
      seedRow("z-other", { products: GEN });
      const calls1: Array<{ id: string; productNames: boolean }> = [];
      const r1 = await run(0, { "a-prod": PROD_MISS, "z-other": PROD_OK }, calls1);
      assertEq(calls1.map((c) => c.id), ["a-prod", "z-other"], "n1: night 1 — both generic-products rows are refreshed");
      assertEq(markerOf("a-prod", "products"), "miss misses=1", "n1: one miss → counted, not yet needs_owner");
      assertEq(markerOf("z-other", "products"), null, "n1: a success on a row that never missed writes no counter");
      assertEq(r1.needs_owner?.newly_set, { total: 0, categories: 0, products: 0 }, "n1: night 1 sets no needs_owner");

      const p1 = await job.buildRfbEnrichmentPreview(db, new Date(night(1).getTime() - 60_000));
      assertEq(contentIds(p1).includes("a-prod"), true, "n1: after one miss the row is still selectable (retry window passed)");

      const r2 = await run(1, { "a-prod": PROD_MISS });
      assertEq(markerOf("a-prod", "products"), "needs_owner misses=2", "n1: second miss on the same field → needs_owner");
      assertEq(
        r2.needs_owner,
        { total: 1, by_field: { categories: 0, products: 1 }, days: 60, newly_set: { total: 1, categories: 0, products: 1 } },
        "n1: run report counts needs_owner (total, by field, newly set this run)",
      );
      const claims2 = claimsOf(r2.run_id);
      const totals = claims2.find((c: any) => c.meta?.kind === "rfb_enrichment_totals");
      const cr = claims2.find((c: any) => c.meta?.kind === "rfb_enrichment_step_content_refresh");
      assertEq(totals?.meta?.needs_owner?.total, 1, "n1: envelope totals claim carries needs_owner.total");
      assertEq(totals?.meta?.needs_owner?.newly_set?.products, 1, "n1: envelope totals claim carries newly_set by field");
      assertEq(cr?.meta?.extra?.needs_owner?.by_field, { categories: 0, products: 1 }, "n1: content_refresh step claim extra carries needs_owner");

      const p3 = await job.buildRfbEnrichmentPreview(db, new Date(night(2).getTime() - 60_000));
      assertEq(contentIds(p3).includes("a-prod"), false, "n1 (AK): a profile with two misses is NOT selected the third night (preview)");
      assertEq(contentStep(p3)?.skipped?.skipped_needs_owner, 1, "n1: preview counts it as skipped_needs_owner");
      assertEq(p3.needs_owner, { total: 1, by_field: { categories: 0, products: 1 }, days: 60 }, "n1: preview carries needs_owner counts");
      const keys = Object.keys(p3);
      assertEq(keys[keys.length - 1], "contact_email_not_in_knowledge", "n1: preview keys additive — the B1 key stays last");

      const calls3: Array<{ id: string; productNames: boolean }> = [];
      const r3 = await run(2, { "a-prod": PROD_MISS }, calls3);
      assertEq(calls3.map((c) => c.id).includes("a-prod"), false, "n1 (AK): the third night's run does not refresh it");
      assertEq(
        (r3.steps.find((s) => s.step === "content_refresh")?.extra as any)?.skipped_before_selection?.skipped_needs_owner,
        1,
        "n1: the run's step extra counts skipped_needs_owner",
      );
      assertEq(r3.needs_owner?.newly_set.total, 0, "n1: nothing newly set on night 3");
      assertEq(r3.needs_owner?.total, 1, "n1: still one active marker on night 3");
    });

    // ── (n2) a success between misses does not trigger ───────────────────
    await withDb("n2", async () => {
      setEnv(ONLY_CONTENT);
      seedRow("b-flip", { products: GEN });
      await run(0, { "b-flip": PROD_MISS });
      // The success writes products in real life; the stub leaves them generic so the row stays eligible.
      await run(1, { "b-flip": PROD_OK });
      assertEq(markerOf("b-flip", "products"), "cleared misses=0", "n2: a success resets the count");
      const r3 = await run(2, { "b-flip": PROD_MISS });
      assertEq(markerOf("b-flip", "products"), "miss misses=1", "n2: miss, success, miss → one miss, no needs_owner");
      assertEq(r3.needs_owner?.total, 0, "n2: no needs_owner counted");
      const p = await job.buildRfbEnrichmentPreview(db, night(4));
      assertEq(contentIds(p), ["b-flip"], "n2: the row is still selected");
    });

    // ── (n3) marker older than 60 days → selectable again ────────────────
    await withDb("n3", async () => {
      setEnv(ONLY_CONTENT);
      seedRow("c-old", { products: GEN });
      seedRow("c-young", { products: GEN });
      const NOW = night(0);
      seedMarker("c-old", "products", 2, new Date(NOW.getTime() - 61 * DAY));
      seedMarker("c-young", "products", 2, new Date(NOW.getTime() - 59 * DAY));
      const p = await job.buildRfbEnrichmentPreview(db, NOW);
      assertEq(contentIds(p), ["c-old"], "n3: a marker older than 60 days → selectable again; 59 days → not");
      assertEq(p.needs_owner, { total: 1, by_field: { categories: 0, products: 1 }, days: 60 }, "n3: only the active marker is counted");
      const r = await run(0, { "c-old": PROD_MISS });
      assertEq(markerOf("c-old", "products"), "needs_owner misses=3", "n3: one more miss after expiry renews needs_owner");
      assertEq(r.needs_owner?.newly_set, { total: 1, categories: 0, products: 1 }, "n3: the renewal counts as newly set");
    });

    // ── (n4) per field ───────────────────────────────────────────────────
    await withDb("n4", async () => {
      setEnv({ ...ONLY_CONTENT, ANTHROPIC_API_KEY: "test-key-never-sent" });
      const NOW = night(0);
      const recent = new Date(NOW.getTime() - DAY);
      // generic products + uncorroborated categories
      seedRow("d-catno", { products: GEN, prov: PROV_NO_CATS });
      seedMarker("d-catno", "categories", 2, recent);
      seedRow("d-both", { products: GEN, prov: PROV_NO_CATS });
      seedMarker("d-both", "categories", 2, recent);
      seedMarker("d-both", "products", 2, recent);
      seedRow("d-prodno", { products: GEN, prov: PROV_NO_CATS });
      seedMarker("d-prodno", "products", 2, recent);
      // content enough, categories only, categories marked → nothing left
      seedRow("d-catonly", { products: REAL3, prov: PROV_NO_CATS });
      seedMarker("d-catonly", "categories", 2, recent);
      const p = await job.buildRfbEnrichmentPreview(db, NOW);
      assertEq(contentIds(p), ["d-catno", "d-prodno"], "n4: one field marked → still selected for the other; both / the only field marked → not selected");
      assertEq(contentStep(p)?.skipped?.skipped_needs_owner, 2, "n4: the two left out are counted as skipped_needs_owner");
      assertEq(p.needs_owner, { total: 4, by_field: { categories: 3, products: 2 }, days: 60 }, "n4: preview counts by field");
      const calls: Array<{ id: string; productNames: boolean }> = [];
      const r = await run(0, { "d-catno": PROD_MISS, "d-prodno": CAT_MISS }, calls);
      assertEq(
        calls,
        [
          { id: "d-catno", productNames: true },
          { id: "d-prodno", productNames: false },
        ],
        "n4: products marked → the row runs WITHOUT the product-name model call",
      );
      assertEq(r.llm.calls, 0, "n4: no model call made (stub)");
      assertEq(job.readRfbEnrichmentNightLlmCounter(db, NOW), 0, "n4: the reservation for d-catno was settled; none for d-prodno");
      assertEq(markerOf("d-catno", "products"), "miss misses=1", "n4: products miss counted per field");
      assertEq(markerOf("d-prodno", "categories"), "miss misses=1", "n4: categories miss counted per field");
    });

    // ── (n5) contacted + verified + held by the gate ─────────────────────
    await withDb("n5", async () => {
      setEnv({ ...ONLY_CONTENT, RFB_ENRICHMENT_CAP_URL_CHECK: "10", RFB_ENRICHMENT_CAP_CONTENT: "10" });
      const NOW = night(0);
      // url_last_probed null → url_check-eligible, so "no other step" is observable.
      seedRow("h-held-prod", { products: GEN, verification_status: "verified", url_last_probed: null });
      markContacted("h-held-prod");
      seedRow("h-held-cat", { products: REAL3, prov: PROV_NO_CATS, verification_status: "verified", url_last_probed: null });
      markContacted("h-held-cat");
      seedRow("x-notverified", { products: GEN, verification_status: "pending_verify", url_last_probed: null });
      markContacted("x-notverified");
      seedRow("x-notheld", { products: REAL3, verification_status: "verified", url_last_probed: null });
      markContacted("x-notheld");
      seedRow("x-optout", { products: GEN, verification_status: "verified", url_last_probed: null });
      markContacted("x-optout");
      db.prepare(`UPDATE agent_knowledge SET verification_status = 'opt_out' WHERE agent_id = 'x-optout'`).run();
      seedRow("u-uncontacted", { products: GEN, url_last_probed: null });

      const cohort = await job.loadRfbEnrichmentCohort(db, NOW.getTime());
      assertEq((cohort.contactedHeld ?? []).map((r) => r.id).sort(), ["h-held-cat", "h-held-prod"], "n5: only contacted + verified + held rows are kept aside");
      assertEq(cohort.excluded.contacted, 4, "n5: they still count as contacted in the cohort's exclusions");
      assertEq(cohort.rows.map((r) => r.id), ["u-uncontacted"], "n5: the cohort itself is unchanged");

      const p = await job.buildRfbEnrichmentPreview(db, NOW);
      assertEq(contentIds(p), ["u-uncontacted", "h-held-prod", "h-held-cat"], "n5: content_refresh takes them, after the uncontacted row");
      assertEq(contentStep(p)?.contacted_verified_held, { eligible: 2, selected: 2 }, "n5: preview counts them");
      assertEq(p.steps.find((s) => s.step === "url_check")?.selected_ids, ["u-uncontacted"], "n5: no other step takes them");

      setEnv({ ...ONLY_CONTENT, RFB_ENRICHMENT_CAP_CONTENT: "1" });
      const capped = await job.buildRfbEnrichmentPreview(db, NOW);
      assertEq(contentIds(capped), ["u-uncontacted"], "n5: same cap — uncontacted rows keep priority");
      assertEq(contentStep(capped)?.contacted_verified_held, { eligible: 2, selected: 0 }, "n5: eligible but not selected under the cap");

      setEnv(ONLY_CONTENT);
      const calls: Array<{ id: string; productNames: boolean }> = [];
      const r = await run(0, { "h-held-prod": PROD_MISS }, calls);
      assertEq(calls.map((c) => c.id), ["u-uncontacted", "h-held-prod", "h-held-cat"], "n5: the run refreshes them too");
      assertEq(markerOf("h-held-prod", "products"), "miss misses=1", "n5: misses are counted for held rows too");
      assertEq(
        (r.steps.find((s) => s.step === "content_refresh")?.extra as any)?.contacted_verified_held,
        { eligible: 2, selected: 2 },
        "n5: the run's step extra counts them",
      );
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
  runRfbEnrichmentNeedsOwnerTests({ log: true }).then((r) => {
    console.log(`\nrfb-enrichment-needs-owner: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
