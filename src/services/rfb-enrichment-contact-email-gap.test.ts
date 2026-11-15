/**
 * rfb-enrichment-contact-email-gap.test.ts — dev-request
 * 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer, slice B1 step 1
 * ("tell først"): the nightly enrichment preview
 * (services/rfb-enrichment-nightly.ts, buildRfbEnrichmentPreview) carries a
 * read-only `contact_email_not_in_knowledge` count — cohort rows with
 * agents.contact_email set and agent_knowledge.email empty, split by the
 * contact_email DNS-check stamp and by website / responding website.
 *
 * Every block runs on a FRESH in-memory main DB with the full production
 * schema (__pinInMemoryDbForTesting, restored in finally). No network, no
 * model call, no executor.
 *
 * Covers:
 *   g1 one row in each DNS bucket (never_checked / live / dead / unknown)
 *   g2 not counted: a knowledge e-mail present; an empty / blank
 *      contact_email; an inactive row; another vertical's row; a contacted
 *      row (outside the job's cohort)
 *   g3 website split: no website / website not probed / answering / dead
 *   g4 counts only — no address, no id in the object; the preview writes
 *      nothing; the rest of the preview is unchanged by the new key
 *   g5 the DNS-state reader on edge inputs
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-enrichment-contact-email-gap.test.ts
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
  "OWNER_AUTO_UPDATES_ENABLED",
  "ANTHROPIC_API_KEY",
] as const;

export async function runRfbEnrichmentContactEmailGapTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  for (const k of ENV_KEYS) delete process.env[k];

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

  const dnsStamp = (live: unknown): string =>
    JSON.stringify({
      contact_email_dns_check: { checked_at: "2026-11-01T00:00:00Z", domain: "x.no", live, method: "mx", batch_id: "b" },
    });

  let seq = 0;
  /** A cohort producer. Default: contact_email set, knowledge e-mail empty, website not probed, never DNS-checked. */
  function seedAgent(
    id: string,
    o: {
      contact_email?: string;
      is_active?: number;
      vertical_id?: string;
      website?: string | null;
      email?: string | null;
      field_provenance?: string;
      url_last_status?: number | null;
      homepage_unreachable_since?: string | null;
    } = {},
  ): void {
    seq += 1;
    const cols: Record<string, unknown> = {
      id,
      name: `Gård ${id}`,
      description: "test",
      provider: "test",
      contact_email: o.contact_email ?? `post@${id}.no`,
      url: "",
      role: "producer",
      api_key: `key-${id}`,
      created_at: `2026-01-01 00:00:${String(seq % 60).padStart(2, "0")}`,
    };
    if (o.is_active !== undefined) cols.is_active = o.is_active;
    if (o.vertical_id !== undefined) cols.vertical_id = o.vertical_id;
    const names = Object.keys(cols);
    db.prepare(`INSERT INTO agents (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
      ...names.map((n) => cols[n]),
    );
    const kc: Record<string, unknown> = {
      agent_id: id,
      verification_status: "pending_verify",
      website: o.website === undefined ? `https://${id}.no` : o.website,
      email: o.email === undefined ? "" : o.email,
    };
    if (o.field_provenance !== undefined) kc.field_provenance = o.field_provenance;
    if (o.url_last_status !== undefined) {
      kc.url_last_status = o.url_last_status;
      kc.url_last_probed = "2026-11-10T00:00:00Z";
    }
    if (o.homepage_unreachable_since !== undefined) kc.homepage_unreachable_since = o.homepage_unreachable_since;
    const kn = Object.keys(kc);
    db.prepare(`INSERT INTO agent_knowledge (${kn.join(", ")}) VALUES (${kn.map(() => "?").join(", ")})`).run(
      ...kn.map((n) => kc[n]),
    );
  }

  const NIGHT = new Date("2026-11-15T00:10:00Z");

  try {
    // ── g1–g4 ──────────────────────────────────────────────────────────────
    await withDb("g1-g4", async () => {
      // Counted (5): one per DNS bucket, plus a second never_checked.
      seedAgent("c-never"); // no stamp, website not probed
      seedAgent("c-live", { field_provenance: dnsStamp(true), url_last_status: 200 }); // answering
      seedAgent("c-dead", { field_provenance: dnsStamp(false), url_last_status: 404 }); // dead site
      seedAgent("c-unknown", { field_provenance: dnsStamp("maybe"), website: "" }); // no website
      seedAgent("c-never-gone", {
        url_last_status: 200,
        homepage_unreachable_since: "2026-11-01T00:00:00Z", // parked → does not answer
      });
      // Not counted.
      seedAgent("n-kemail", { email: "post@n-kemail.no", field_provenance: dnsStamp(true), url_last_status: 200 });
      seedAgent("n-nocontact", { contact_email: "", url_last_status: 200 });
      seedAgent("n-blankcontact", { contact_email: "   ", url_last_status: 200 });
      seedAgent("n-inactive", { is_active: 0, url_last_status: 200 });
      seedAgent("n-dental", { vertical_id: "dental", url_last_status: 200 });
      seedAgent("n-contacted", { url_last_status: 200 });
      db.prepare(
        `INSERT INTO outreach_sent_log (agent_id) VALUES ('n-contacted')`,
      ).run();

      const before = JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all());
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const gap = p.contact_email_not_in_knowledge;

      assertEq(
        gap,
        {
          total: 5,
          by_dns: { never_checked: 2, live: 1, dead: 1, unknown: 1 },
          with_website: 4,
          with_responding_website: 1,
        },
        "g1/g3: counted per DNS bucket; website = 4 (c-unknown has none), responding = 1 (c-live only)",
      );
      assertEq(Object.keys(gap), ["total", "by_dns", "with_website", "with_responding_website"], "g4: exact key order");
      assertEq(Object.keys(gap.by_dns), ["never_checked", "live", "dead", "unknown"], "g4: by_dns keys");

      const json = JSON.stringify(gap);
      assertEq(/@/.test(json), false, "g4: no e-mail address in the object");
      assertEq(/c-|n-/.test(json), false, "g4: no agent id in the object");
      assertEq(
        JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all()) === before,
        true,
        "g4: the preview writes nothing",
      );

      // Cross-check against the job's own cohort: the not-counted rows that
      // are in the cohort are left out by the new filter only.
      const cohort = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
      const ids = cohort.rows.map((r) => r.id).sort();
      assertEq(
        ids.includes("n-inactive") || ids.includes("n-dental") || ids.includes("n-contacted"),
        false,
        "g2: inactive / other-vertical / contacted rows are outside the cohort",
      );
      assertEq(
        ["n-kemail", "n-nocontact", "n-blankcontact"].every((id) => ids.includes(id)),
        true,
        "g2: knowledge-email / empty-contact rows are in the cohort but not counted",
      );

      // Additive: the new key is the last one; the existing keys keep their order.
      const keys = Object.keys(p);
      assertEq(keys[keys.length - 1], "contact_email_not_in_knowledge", "g4: the new key is appended last");
      assertEq(p.cohort.eligible, cohort.rows.length, "g4: cohort summary unchanged");

      // The dry-run report carries the same object inside its preview.
      const dry = await job.runRfbEnrichmentNightly({ apply: false, trigger: "manual", now: NIGHT });
      assertEq(dry.preview?.contact_email_not_in_knowledge, gap, "g4: dry-run report preview carries the same count");
    });

    // ── g5 DNS-state reader ────────────────────────────────────────────────
    {
      const s = job.rfbContactEmailDnsState;
      assertEq(s(null), "never_checked", "g5: no knowledge row → never_checked");
      assertEq(s("{}"), "never_checked", "g5: empty provenance → never_checked");
      assertEq(s(JSON.stringify({ contact_email_dns_check: {} })), "never_checked", "g5: stamp without live → never_checked (json_extract NULL)");
      assertEq(s(dnsStamp(true)), "live", "g5: live true → live");
      assertEq(s(dnsStamp(1)), "live", "g5: live 1 → live (json_extract = 1)");
      assertEq(s(dnsStamp(false)), "dead", "g5: live false → dead");
      assertEq(s(dnsStamp(0)), "dead", "g5: live 0 → dead (json_extract = 0)");
      assertEq(s(dnsStamp("yes")), "unknown", "g5: live of another type → unknown");
      assertEq(s("not json"), "unknown", "g5: unparseable provenance → unknown");
      assertEq(s(JSON.stringify({ contact_email_dns_check: "x" })), "unknown", "g5: non-object stamp → unknown");
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbEnrichmentContactEmailGapTests({ log: true }).then((r) => {
    console.log(`\nrfb-enrichment-contact-email-gap: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
