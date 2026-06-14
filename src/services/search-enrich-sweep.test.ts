/**
 * search-enrich-sweep.test.ts — tests for the full-cohort background sweep,
 * the durable findings table, and the gated apply-findings step
 * (services/search-enrich-sweep.ts + enrichOneAgent in services/search-enrich.ts).
 *
 * All I/O is stubbed (injected `search`/`crawl` deps + injected DB + noSleep) —
 * ZERO network. These pin the PR's core invariants:
 *   - Dry-run sweep writes NOTHING to agent contact data (only findings).
 *   - apply-findings writes ONLY write-tier, fill-empty-only, idempotent.
 *   - Directory/coordinator emails are never written (picker handles it).
 *
 * Run standalone: npx tsx src/services/search-enrich-sweep.test.ts
 * Wired into the gate: tests/test.ts calls runSearchEnrichSweepTests().
 */

import Database from "better-sqlite3";
import {
  enrichOneAgent,
  type EnrichDeps,
  type BraveResult,
  type PageEvidence,
} from "./search-enrich";
import {
  startSearchEnrichSweep,
  getSearchEnrichSweepJob,
  __resetSearchEnrichSweepJobForTesting,
  applyFindings,
  ensureFindingsTable,
  selectCohort,
} from "./search-enrich-sweep";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const noSleep = () => Promise.resolve();

/** Minimal prod-like schema for cohort selection + writes. */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, city TEXT, url TEXT,
      claimed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_knowledge (
      agent_id TEXT PRIMARY KEY,
      address TEXT, postal_code TEXT, website TEXT, phone TEXT, email TEXT,
      verification_status TEXT,
      field_provenance TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT
    );
    CREATE TABLE crm_contacts (
      id INTEGER PRIMARY KEY, agent_id TEXT, status TEXT
    );
  `);
  return db;
}

function seedAgent(
  db: Database.Database,
  id: string,
  name: string,
  city: string,
  phone: string,
  opts: { email?: string | null; website?: string | null; claimed?: boolean; created?: string } = {},
): void {
  db.prepare(
    "INSERT INTO agents (id, name, city, url, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, name, city, `https://example.test/${id}`, opts.claimed ? "2026-01-01" : null, opts.created ?? "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO agent_knowledge (agent_id, phone, email, website, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, phone, opts.email ?? null, opts.website ?? null, "2026-01-01T00:00:00Z");
}

/**
 * Build injected deps that map a producer name → a fixed (results, evidence)
 * scenario. Keyed by name-stem so the stub is deterministic and offline.
 */
function makeStubDeps(scenarios: Record<string, { results: BraveResult[]; pages: Record<string, PageEvidence | null> }>): EnrichDeps & { pickFor: (name: string) => { results: BraveResult[]; pages: Record<string, PageEvidence | null> } | null } {
  function pickFor(name: string) {
    const lc = name.toLowerCase();
    for (const key of Object.keys(scenarios)) {
      if (lc.includes(key.toLowerCase())) return scenarios[key]!;
    }
    return null;
  }
  // The deps need to know which scenario the current call belongs to. We embed
  // the producer name in the query ("<name>" <city>) and parse it back out.
  function nameFromQuery(q: string): string {
    const m = q.match(/^"([^"]+)"/);
    return m ? m[1]! : q;
  }
  let lastScenario: { results: BraveResult[]; pages: Record<string, PageEvidence | null> } | null = null;
  const deps: EnrichDeps = {
    search: async (query: string) => {
      lastScenario = pickFor(nameFromQuery(query));
      return lastScenario?.results ?? [];
    },
    crawl: async (url: string) => {
      if (!lastScenario) return null;
      return lastScenario.pages[url] ?? null;
    },
  };
  return Object.assign(deps, { pickFor });
}

// Three canonical scenarios.
function scenarios() {
  return {
    // 1) Nalums: strong phone-match page + producer gmail → WRITE
    Nalums: {
      results: [
        { title: "Nalums Gårdsbutikk", url: "https://nalum.no", description: "Nalums gårdsbutikk i Nærbø" },
      ] as BraveResult[],
      pages: {
        "https://nalum.no": {
          url: "https://nalum.no",
          title: "Nalums Gårdsbutikk",
          html: "<title>Nalums Gårdsbutikk</title> Ring oss 924 31 142 <a href='mailto:nalumsgaard@gmail.com'>e-post</a>",
          emails: ["nalumsgaard@gmail.com"],
          phones: ["92431142"],
        } as PageEvidence,
      },
    },
    // 2) Hjerttind: directory page, no producer email → QUEUE
    //    Page confirms (phone match = strong) but the only email is a hub
    //    coordinator address (post@hanen.no) which the picker rejects.
    Hjerttind: {
      results: [
        { title: "Hjerttind Gård — Hanen", url: "https://hanen.no/hjerttind", description: "Hjerttind gård medlem" },
      ] as BraveResult[],
      pages: {
        "https://hanen.no/hjerttind": {
          url: "https://hanen.no/hjerttind",
          title: "Hjerttind Gård",
          html: "<title>Hjerttind Gård</title> Tlf 911 22 333 Kontakt: <a href='mailto:post@hanen.no'>post@hanen.no</a>",
          emails: ["post@hanen.no"],
          phones: ["91122333"],
        } as PageEvidence,
      },
    },
    // 3) Ingenmann: no candidate at all → NONE
    Ingenmann: {
      results: [] as BraveResult[],
      pages: {},
    },
  };
}

export function runSearchEnrichSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  async function waitForSweepDone(timeoutMs = 3000): Promise<void> {
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (getSearchEnrichSweepJob().status !== "running") {
          clearInterval(interval);
          resolve();
        }
      }, 5);
      setTimeout(() => { clearInterval(interval); resolve(); }, timeoutMs);
    });
  }

  return (async () => {
    // ──────────────────────────────────────────────────────────────────────────
    // PART A — enrichOneAgent with stubs reproduces Nalums / Hjerttind logic.
    // ──────────────────────────────────────────────────────────────────────────
    {
      const deps = makeStubDeps(scenarios());

      // Nalums: strong phone-match + name-stem gmail → write
      const nalums = await enrichOneAgent(
        { agent_id: "a-nalums", name: "Nalums Gårdsbutikk", query: '"Nalums Gårdsbutikk" Nærbø', phone: "92431142", postcode: null, street: null, orgnr: null, siteRoot: null },
        deps,
      );
      assertEq(nalums.tier, "write", "enrichOne: Nalums strong phone-match + gmail → write");
      assertEq(nalums.candidate_email, "nalumsgaard@gmail.com", "enrichOne: Nalums picks producer gmail");
      assertEq(nalums.confirm.strength, "strong", "enrichOne: Nalums confirm strength=strong");
      assertTrue(nalums.confirm.signals.some((s) => s.startsWith("phone_match")), "enrichOne: Nalums has phone_match signal");

      // Hjerttind: directory-only (hub coordinator email rejected) → queue
      const hjerttind = await enrichOneAgent(
        { agent_id: "a-hjerttind", name: "Hjerttind Gård", query: '"Hjerttind Gård" Målselv', phone: "91122333", postcode: null, street: null, orgnr: null, siteRoot: null },
        deps,
      );
      assertEq(hjerttind.tier, "queue", "enrichOne: Hjerttind confirmed but hub-email-only → queue");
      assertEq(hjerttind.candidate_email, null, "enrichOne: Hjerttind hub email (post@hanen.no) rejected → null");
      assertEq(hjerttind.confirm.strength, "strong", "enrichOne: Hjerttind confirm strength=strong (phone match)");

      // Ingenmann: no candidate → none
      const none = await enrichOneAgent(
        { agent_id: "a-none", name: "Ingenmann Gård", query: '"Ingenmann Gård" Oslo', phone: "55667788", postcode: null, street: null, orgnr: null, siteRoot: null },
        deps,
      );
      assertEq(none.tier, "none", "enrichOne: Ingenmann no candidate → none");
      assertEq(none.candidate_email, null, "enrichOne: Ingenmann no email");
      assertEq(none.chosen_url, null, "enrichOne: Ingenmann no chosen_url");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART B — DRY-RUN sweep over the whole cohort writes NOTHING but records all.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetSearchEnrichSweepJobForTesting();
      const db = makeDb();
      // Cohort: 3 missing-email + phone-present agents (one per scenario).
      seedAgent(db, "a-nalums", "Nalums Gårdsbutikk", "Nærbø", "92431142");
      seedAgent(db, "a-hjerttind", "Hjerttind Gård", "Målselv", "91122333");
      seedAgent(db, "a-none", "Ingenmann Gård", "Oslo", "55667788");
      // Excluded: claimed agent + agent that already HAS an email.
      seedAgent(db, "a-claimed", "Nalums Gårdsbutikk", "Nærbø", "92431142", { claimed: true });
      seedAgent(db, "a-hasemail", "Nalums Gårdsbutikk", "Nærbø", "92431142", { email: "already@there.no" });

      assertEq(selectCohort(db).length, 3, "cohort: 3 selected (claimed + has-email excluded)");

      const deps = makeStubDeps(scenarios());
      const res = startSearchEnrichSweep({ apply: false, db, deps, sleep: noSleep });
      assertTrue(res.started === true, "dry-run: sweep started");
      if (res.started) {
        assertEq(res.total, 3, "dry-run: total=3");
        assertEq(res.status, "running", "dry-run: status=running immediately");
      }
      assertEq(getSearchEnrichSweepJob().status, "running", "dry-run: job running right after start");

      await waitForSweepDone();

      const job = getSearchEnrichSweepJob();
      assertEq(job.status, "done", "dry-run: job done");
      assertEq(job.processed, 3, "dry-run: processed=3");
      assertEq(job.counts.write, 1, "dry-run: counts.write=1 (Nalums)");
      assertEq(job.counts.queue, 1, "dry-run: counts.queue=1 (Hjerttind)");
      assertEq(job.counts.none, 1, "dry-run: counts.none=1 (Ingenmann)");
      assertEq(job.counts.error, 0, "dry-run: counts.error=0");
      assertEq(job.applied_writes, 0, "dry-run: applied_writes=0 (dry-run writes nothing)");
      assertEq(job.apply, false, "dry-run: job.apply=false");

      // Findings table: all 3 rows with correct tiers.
      const findings = db.prepare("SELECT agent_id, tier, candidate_email FROM search_enrich_findings ORDER BY agent_id").all() as Array<{ agent_id: string; tier: string; candidate_email: string | null }>;
      assertEq(findings.length, 3, "dry-run: 3 findings recorded");
      const byId = Object.fromEntries(findings.map((f) => [f.agent_id, f]));
      assertEq(byId["a-nalums"]!.tier, "write", "dry-run: Nalums finding tier=write");
      assertEq(byId["a-nalums"]!.candidate_email, "nalumsgaard@gmail.com", "dry-run: Nalums finding email recorded");
      assertEq(byId["a-hjerttind"]!.tier, "queue", "dry-run: Hjerttind finding tier=queue");
      assertEq(byId["a-hjerttind"]!.candidate_email, null, "dry-run: Hjerttind finding email=null (hub rejected)");
      assertEq(byId["a-none"]!.tier, "none", "dry-run: Ingenmann finding tier=none");

      // CRITICAL INVARIANT: agent_knowledge has ZERO contact writes.
      const emails = db.prepare("SELECT agent_id, email FROM agent_knowledge WHERE email IS NOT NULL AND trim(email) != '' ORDER BY agent_id").all() as Array<{ agent_id: string; email: string }>;
      assertEq(emails.length, 1, "dry-run: only the pre-existing email exists (no new writes)");
      assertEq(emails[0]!.agent_id, "a-hasemail", "dry-run: the one email is the pre-seeded a-hasemail");
      // Provenance untouched for the write-tier agent.
      const prov = db.prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'a-nalums'").get() as { field_provenance: string };
      assertEq(prov.field_provenance, "{}", "dry-run: Nalums provenance untouched ('{}')");

      // ────────────────────────────────────────────────────────────────────────
      // PART C — apply-findings writes ONLY write-tier, fill-empty-only, idempotent
      // ────────────────────────────────────────────────────────────────────────
      const r1 = applyFindings(db);
      assertEq(r1.total_write_findings, 1, "apply: 1 write-tier finding (Nalums)");
      assertEq(r1.applied, 1, "apply: applied=1");
      assertEq(r1.skipped_nonempty, 0, "apply: skipped_nonempty=0 on first apply");

      // ONLY the write-tier agent's email is written.
      const nalumsEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-nalums'").get() as { email: string | null }).email;
      assertEq(nalumsEmail, "nalumsgaard@gmail.com", "apply: Nalums email now written");
      const hjEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-hjerttind'").get() as { email: string | null }).email;
      assertEq(hjEmail, null, "apply: Hjerttind (queue) NOT written");
      const noneEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-none'").get() as { email: string | null }).email;
      assertEq(noneEmail, null, "apply: Ingenmann (none) NOT written");

      // Provenance now present for the written agent.
      const prov2 = JSON.parse((db.prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'a-nalums'").get() as { field_provenance: string }).field_provenance);
      assertTrue(Array.isArray(prov2.email) && prov2.email.length === 1, "apply: Nalums provenance has 1 email source");
      assertTrue(String(prov2.email?.[0]?.source_type ?? "").startsWith("web_search:"), "apply: provenance source_type=web_search:<domain>");

      // Idempotent re-run: writes nothing new (fields now non-empty).
      const r2 = applyFindings(db);
      assertEq(r2.total_write_findings, 1, "apply-idempotent: still 1 write-tier finding");
      assertEq(r2.applied, 0, "apply-idempotent: applied=0 on re-run");
      assertEq(r2.skipped_nonempty, 1, "apply-idempotent: skipped_nonempty=1 (already filled)");
      // Provenance not duplicated.
      const prov3 = JSON.parse((db.prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = 'a-nalums'").get() as { field_provenance: string }).field_provenance);
      assertEq(prov3.email.length, 1, "apply-idempotent: provenance still 1 source (no dup)");

      db.close();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART D — fill-empty-only: apply-findings NEVER overwrites a pre-existing email
    // ──────────────────────────────────────────────────────────────────────────
    {
      const db = makeDb();
      ensureFindingsTable(db);
      // Agent already has an email; a write-tier finding exists for it.
      seedAgent(db, "a-pre", "Nalums Gårdsbutikk", "Nærbø", "92431142", { email: "owner@nalum.no" });
      db.prepare(
        `INSERT INTO search_enrich_findings
           (agent_id, name, query, tier, candidate_email, source_url, confirm_strength, signals, email_reason, run_id, created_at)
         VALUES ('a-pre', 'Nalums Gårdsbutikk', 'q', 'write', 'scraped@gmail.com', 'https://nalum.no', 'strong', '[]', 'producer_domain_match', 'r', '2026-01-01')`,
      ).run();

      const r = applyFindings(db);
      assertEq(r.applied, 0, "fill-empty: applied=0 (pre-existing email present)");
      assertEq(r.skipped_nonempty, 1, "fill-empty: skipped_nonempty=1");
      const email = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-pre'").get() as { email: string }).email;
      assertEq(email, "owner@nalum.no", "fill-empty: pre-existing email NOT overwritten");
      db.close();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART E — apply=true sweep writes write-tier inline; queue/none stay unwritten.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetSearchEnrichSweepJobForTesting();
      const db = makeDb();
      seedAgent(db, "a-nalums", "Nalums Gårdsbutikk", "Nærbø", "92431142");
      seedAgent(db, "a-hjerttind", "Hjerttind Gård", "Målselv", "91122333");

      const deps = makeStubDeps(scenarios());
      const res = startSearchEnrichSweep({ apply: true, db, deps, sleep: noSleep });
      assertTrue(res.started === true, "apply-sweep: started");
      await waitForSweepDone();

      const job = getSearchEnrichSweepJob();
      assertEq(job.status, "done", "apply-sweep: done");
      assertEq(job.apply, true, "apply-sweep: job.apply=true");
      assertEq(job.applied_writes, 1, "apply-sweep: applied_writes=1 (Nalums only)");

      const nalumsEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-nalums'").get() as { email: string | null }).email;
      assertEq(nalumsEmail, "nalumsgaard@gmail.com", "apply-sweep: Nalums email written inline");
      const hjEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'a-hjerttind'").get() as { email: string | null }).email;
      assertEq(hjEmail, null, "apply-sweep: Hjerttind (queue) NOT written");
      db.close();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART F — concurrency guard: a second start while running is refused.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetSearchEnrichSweepJobForTesting();
      const db = makeDb();
      seedAgent(db, "a-nalums", "Nalums Gårdsbutikk", "Nærbø", "92431142");
      // A crawl that blocks so the first sweep stays 'running' during the test.
      let release: () => void = () => {};
      const blocker = new Promise<PageEvidence | null>((resolve) => { release = () => resolve(null); });
      const slowDeps: EnrichDeps = {
        search: async () => [{ title: "Nalums", url: "https://nalum.no", description: "x" }],
        crawl: () => blocker,
      };
      const r1 = startSearchEnrichSweep({ apply: false, db, deps: slowDeps, sleep: noSleep });
      assertTrue(r1.started === true, "concurrency: first start ok");
      assertEq(getSearchEnrichSweepJob().status, "running", "concurrency: running");
      const r2 = startSearchEnrichSweep({ apply: false, db, deps: slowDeps, sleep: noSleep });
      assertEq(r2.started, false, "concurrency: second start refused");
      if (!r2.started) assertEq(r2.reason, "already_running", "concurrency: reason=already_running");
      release(); // unblock so the loop completes
      await waitForSweepDone();
      assertEq(getSearchEnrichSweepJob().status, "done", "concurrency: first sweep completes after unblock");
      db.close();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PART G — resilience: one agent's crawl throw never aborts the sweep.
    // ──────────────────────────────────────────────────────────────────────────
    {
      __resetSearchEnrichSweepJobForTesting();
      const db = makeDb();
      seedAgent(db, "a-boom", "Boom Gård", "Oslo", "10000001", { created: "2026-01-01T00:00:00Z" });
      seedAgent(db, "a-nalums", "Nalums Gårdsbutikk", "Nærbø", "92431142", { created: "2026-01-02T00:00:00Z" });
      const sc = scenarios();
      const deps: EnrichDeps = {
        search: async (q: string) => {
          if (q.includes("Boom")) return [{ title: "Boom", url: "https://boom.no", description: "x" }];
          return sc.Nalums.results;
        },
        crawl: async (url: string) => {
          if (url === "https://boom.no") throw new Error("simulated crawl failure");
          return sc.Nalums.pages[url] ?? null;
        },
      };
      const res = startSearchEnrichSweep({ apply: false, db, deps, sleep: noSleep });
      assertTrue(res.started === true, "resilience: started");
      await waitForSweepDone();
      const job = getSearchEnrichSweepJob();
      assertEq(job.status, "done", "resilience: completed despite one failure");
      assertEq(job.processed, 2, "resilience: processed=2 (both attempted)");
      assertEq(job.counts.error, 1, "resilience: counts.error=1 (Boom)");
      assertEq(job.counts.write, 1, "resilience: counts.write=1 (Nalums still processed after the error)");
      // An error finding is recorded for the failed agent.
      const boomFinding = db.prepare("SELECT tier, email_reason FROM search_enrich_findings WHERE agent_id = 'a-boom'").get() as { tier: string; email_reason: string } | undefined;
      assertTrue(!!boomFinding, "resilience: error finding recorded for Boom");
      if (boomFinding) {
        assertEq(boomFinding.tier, "none", "resilience: Boom finding tier=none");
        assertTrue(boomFinding.email_reason.startsWith("error:"), "resilience: Boom finding email_reason starts with error:");
      }
      db.close();
      __resetSearchEnrichSweepJobForTesting();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/services/search-enrich-sweep.test.ts
if (require.main === module) {
  console.log("── search-enrich-sweep tests ──");
  runSearchEnrichSweepTests({ log: true }).then((r) => {
    console.log(`\nsearch-enrich-sweep: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
