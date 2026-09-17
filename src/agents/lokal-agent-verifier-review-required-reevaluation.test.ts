/**
 * lokal-agent-verifier-review-required-reevaluation.test.ts — dev-request
 * 2026-09-17-rfb-review-required-poolblokker-uten-forklaring-og-uten-
 * reevaluering, punkt 2+3: the daily verifier loop's additive selection of
 * stale `review_required` rows, and the new `review_required_reevaluated` /
 * `review_required_promoted` per-run counts.
 *
 * Background: a census (2026-09-17) found ~74-75 review_required rows stuck
 * for a full week (verifier throughput to `verified` of only 2,3,1,0/day, 5
 * rows even regressing 2026-09-15) — nothing guaranteed a review_required
 * row would ever be re-checked once judged, even after gaining new
 * corroborating evidence.
 *
 * Sections:
 *   A. pickStaleReviewRequiredBatch (lokal-agent-verifier.ts) — pure
 *      selection-query unit tests: a fresh (<7d) review_required row is NOT
 *      selected; an old (>=7d, or NULL last_verified_at) one IS; oldest
 *      first; cap of 40 respected; non-review_required statuses excluded
 *      regardless of age.
 *   B. runVerifierBatch's `includeStaleReviewRequired` merge — opt-in
 *      (default off, byte-identical to every pre-existing caller/test);
 *      when on, merges in up to 40 stale review_required rows alongside
 *      whatever `pickFn` already selected, deduplicated by agent id, and
 *      runs them through the EXACT SAME gate/guards as every other
 *      candidate — proves a row that still fails a real requirement (no
 *      email) stays review_required (no gate lowered), and a row whose
 *      evidence has genuinely improved since its last verdict CAN be
 *      promoted to verified.
 *   C. review_required_reevaluated / review_required_promoted — the exact
 *      derivation runVerifierTick (admin-run-verifier.ts) uses over a
 *      `results` array (prior_verification_status === 'review_required'),
 *      pinned against a known results set built from section B's runs.
 *
 * Exported runLokalAgentVerifierReviewRequiredReevaluationTests({log}) ->
 * TestSummary; wired into tests/test.ts via runSerial() at the tail (see
 * that file's own established convention for new registrations).
 * Standalone: npx tsx src/agents/lokal-agent-verifier-review-required-reevaluation.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierReviewRequiredReevaluationTests(
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
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const {
        runVerifierBatch,
        pickStaleReviewRequiredBatch,
      } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'partial')`,
      );

      function seedAgent(id: string, opts: {
        status: string;
        email?: string | null;
        website?: string | null;
        about?: string | null;
        products?: unknown[];
        agentUrl?: string;
        isVerified?: boolean;
      }): void {
        insertAgent.run(
          id,
          `Testgard ${id}`,
          opts.agentUrl ?? `https://${id}.example-registration.invalid`,
          `key-${id}`,
          opts.isVerified ? 1 : 0,
        );
        insertKnowledge.run(
          id,
          "Testveien 1, 1400 Ski",
          "91234567",
          opts.email === undefined ? null : opts.email,
          opts.website ?? null,
          opts.about ?? "En liten gård som selger egg og grønnsaker direkte fra tunet.",
          JSON.stringify(opts.products ?? []),
          JSON.stringify({}),
          opts.status,
        );
      }

      function setLastVerifiedAt(id: string, sqlOffset: string | null): void {
        if (sqlOffset === null) {
          db.prepare(`UPDATE agent_knowledge SET last_verified_at = NULL WHERE agent_id = ?`).run(id);
        } else {
          db.prepare(`UPDATE agent_knowledge SET last_verified_at = datetime('now', ?) WHERE agent_id = ?`).run(sqlOffset, id);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // Section A — pickStaleReviewRequiredBatch selection-query unit tests
      // ═══════════════════════════════════════════════════════════════
      {
        // a1: fresh (3 days old) review_required row -> NOT selected.
        seedAgent("a-fresh", { status: "review_required" });
        setLastVerifiedAt("a-fresh", "-3 days");

        // a2: old (10 days old) review_required row -> selected.
        seedAgent("a-old", { status: "review_required" });
        setLastVerifiedAt("a-old", "-10 days");

        // a3: NULL last_verified_at (never verified) review_required row ->
        // selected (defensively treated as "definitely stale").
        seedAgent("a-null", { status: "review_required" });
        setLastVerifiedAt("a-null", null);

        // a4: exactly at the 7-day boundary -> selected (the query uses <=).
        seedAgent("a-boundary", { status: "review_required" });
        setLastVerifiedAt("a-boundary", "-7 days");

        // a5: old (10 days) but NOT review_required (pending_verify) -> NOT
        // selected regardless of age.
        seedAgent("a-old-pending", { status: "pending_verify" });
        setLastVerifiedAt("a-old-pending", "-30 days");

        const batch = pickStaleReviewRequiredBatch(db, 40);
        const ids = batch.map((r: any) => r.id);

        assertTrue(!ids.includes("a-fresh"), "a1: a review_required row younger than 7 days is NOT selected");
        assertTrue(ids.includes("a-old"), "a2: a review_required row older than 7 days IS selected");
        assertTrue(ids.includes("a-null"), "a3: a review_required row with NULL last_verified_at IS selected");
        assertTrue(ids.includes("a-boundary"), "a4: a review_required row exactly 7 days old IS selected (boundary is inclusive)");
        assertTrue(!ids.includes("a-old-pending"), "a5: an old but non-review_required row is never selected regardless of age");

        // a6: oldest-first ordering among the selected rows.
        const oldIdx = ids.indexOf("a-old");
        const nullIdx = ids.indexOf("a-null");
        const boundaryIdx = ids.indexOf("a-boundary");
        // NULL is COALESCEd to '1970-01-01' — the oldest possible value —
        // so a-null must sort before a-old (10 days) and a-boundary (7 days).
        assertTrue(nullIdx < oldIdx, "a6a: NULL last_verified_at sorts as oldest (before the 10-day-old row)");
        assertTrue(oldIdx < boundaryIdx, "a6b: the 10-day-old row sorts before the 7-day-old (boundary) row — oldest first");

        // a7: cap of 40 respected — seed 45 total stale review_required rows
        // (4 already seeded above + 41 more) and confirm at most 40 come back.
        for (let i = 0; i < 41; i++) {
          const id = `a-cap-${i}`;
          seedAgent(id, { status: "review_required" });
          setLastVerifiedAt(id, `-${20 + i} days`);
        }
        const capBatch = pickStaleReviewRequiredBatch(db, 40);
        assertEq(capBatch.length, 40, "a7: cap of 40 is respected even with 45 eligible stale review_required rows");
      }

      // ═══════════════════════════════════════════════════════════════
      // Section B — runVerifierBatch's includeStaleReviewRequired merge
      // ═══════════════════════════════════════════════════════════════
      // Fresh, isolated DB for this section so section A's ~46 fixtures
      // don't interfere with exact candidate-count assertions below.
      const db2 = new Database(":memory:");
      try {
        db2.pragma("journal_mode = DELETE");
        initMod.__setDbForTesting(db2 as any);
        initMod.__initSchemaForTesting(db2 as any);

        const insertAgent2 = db2.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
        );
        const insertKnowledge2 = db2.prepare(
          `INSERT INTO agent_knowledge
             (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'partial')`,
        );
        function seedAgent2(id: string, o: {
          status: string;
          email?: string | null;
          website?: string | null;
          about?: string | null;
          products?: unknown[];
          agentUrl?: string;
          fieldProvenance?: Record<string, unknown>;
        }): void {
          insertAgent2.run(id, `Testgard ${id}`, o.agentUrl ?? `https://${id}.example-registration.invalid`, `key-${id}`, 0);
          insertKnowledge2.run(
            id, "Testveien 1, 1400 Ski", "91234567",
            o.email === undefined ? null : o.email,
            o.website ?? null,
            o.about ?? "En liten gård som selger egg og grønnsaker direkte fra tunet.",
            JSON.stringify(o.products ?? []),
            JSON.stringify(o.fieldProvenance ?? {}),
            o.status,
          );
        }
        function setLastVerifiedAt2(id: string, sqlOffset: string | null): void {
          if (sqlOffset === null) {
            db2.prepare(`UPDATE agent_knowledge SET last_verified_at = NULL WHERE agent_id = ?`).run(id);
          } else {
            db2.prepare(`UPDATE agent_knowledge SET last_verified_at = datetime('now', ?) WHERE agent_id = ?`).run(sqlOffset, id);
          }
        }
        // pickFn scoped to NOTHING — proves candidates come ONLY from the
        // includeStaleReviewRequired merge, not from pickFn itself.
        const pickNone = () => [];

        // b1: default (opts omitted) — a stale review_required row that
        // pickFn does not select must NOT be processed.
        seedAgent2("b-stale-noemail", { status: "review_required", email: null, website: null });
        setLastVerifiedAt2("b-stale-noemail", "-10 days");

        {
          const r = await runVerifierBatch({ db: db2, pickFn: pickNone, brregLookup: null });
          assertEq(r.results.length, 0, "b1: includeStaleReviewRequired defaults to off — no candidates without opting in");
        }

        // b2: includeStaleReviewRequired=true — the SAME stale row is now
        // picked up even though pickFn still selects nothing.
        {
          const r = await runVerifierBatch({
            db: db2, pickFn: pickNone, brregLookup: null, includeStaleReviewRequired: true,
          });
          assertEq(r.results.length, 1, "b2: includeStaleReviewRequired=true merges in the one stale review_required row");
          assertEq(r.results[0]!.agent_id, "b-stale-noemail", "b2b: it's the expected agent");
          assertEq(r.results[0]!.prior_verification_status, "review_required", "b2c: prior_verification_status is correctly review_required");
        }

        // b3: still fails a real requirement (domain-incoherent: agents.url
        // and knowledge.website/email point at DIFFERENT hosts, no
        // homepage-provenance rescue) -> stays review_required after
        // re-evaluation, even though the site is reachable (headProbe=200)
        // and the email is otherwise perfectly valid — proving this is a
        // genuine, persistent identity-integrity failure the re-evaluation
        // correctly does NOT paper over. No gate lowered: this is the SAME
        // domain-coherence guard every other candidate goes through.
        seedAgent2("b-stale-incoherent", {
          status: "review_required",
          email: "post@stillbad.no",
          website: "https://stillbad.no",
          agentUrl: "https://totally-different-host.no",
        });
        setLastVerifiedAt2("b-stale-incoherent", "-10 days");
        {
          const r = await runVerifierBatch({
            db: db2, pickFn: pickNone, brregLookup: null, includeStaleReviewRequired: true,
            headProbe: async () => 200,
          });
          const incoherent = r.results.find((x) => x.agent_id === "b-stale-incoherent");
          assertTrue(!!incoherent, "b3-setup: the domain-incoherent stale row was processed");
          assertEq(incoherent!.prior_verification_status, "review_required", "b3a: prior status is review_required");
          assertEq(incoherent!.new_verification_status, "review_required", "b3b: a row that still fails a real requirement (domain incoherence) stays review_required after re-evaluation — no gate lowered");
          assertEq(incoherent!.domain_incoherent, true, "b3c: the persistent failure is genuinely domain incoherence, not a stale re-confirmation of nothing");

          const row = db2.prepare(`SELECT verification_status FROM agent_knowledge WHERE agent_id = ?`).get("b-stale-incoherent") as { verification_status: string };
          assertEq(row.verification_status, "review_required", "b3d: the persisted DB row also stays review_required (not just the in-memory result)");
        }

        // b4: dedup — a row returned by BOTH pickFn and the stale merge is
        // only processed once.
        seedAgent2("b-dup", { status: "review_required", email: null, website: null });
        setLastVerifiedAt2("b-dup", "-10 days");
        const pickDup = (dbi: any) =>
          dbi.prepare(`SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                              k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                              k.verification_status, k.enrichment_status,
                              k.last_verified_at, k.last_http_check_at, k.last_http_status
                         FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
                        WHERE a.id = 'b-dup'`).all();
        {
          const r = await runVerifierBatch({
            db: db2, pickFn: pickDup, brregLookup: null, includeStaleReviewRequired: true,
          });
          const dupResults = r.results.filter((x) => x.agent_id === "b-dup");
          assertEq(dupResults.length, 1, "b4: a row selected by BOTH pickFn and the stale merge is processed exactly once, not twice");
        }

        // b5: positive control — a stale review_required row whose evidence
        // has genuinely improved since its last verdict (good email,
        // healthy website via an injected headProbe, real content) CAN be
        // promoted to verified by re-evaluation. Proves the merge doesn't
        // just re-quarantine everything unconditionally.
        seedAgent2("b-promotable", {
          status: "review_required",
          email: "post@promotable.no",
          website: "https://promotable.no",
          agentUrl: "https://promotable.no",
          about: "En lang og god beskrivelse av gården vår med mye relevant innhold om produktene og driften.",
          products: [{ name: "Sider" }, { name: "Eplemost" }, { name: "Honning" }],
          // address is the only GATING_FIELDS entry (cross-source-
          // validator.ts) — two independent, corroborating, non-inference
          // sources give it a `pool_eligible` verdict (same fixture shape
          // admin-pool-blocker-explain.test.ts's "pbe-pool" case uses).
          fieldProvenance: {
            address: [
              { source_type: "homepage", value: "Testveien 1, 1400 Ski" },
              { source_type: "google_places", value: "Testveien 1, 1400 Ski" },
            ],
          },
        });
        setLastVerifiedAt2("b-promotable", "-10 days");
        {
          const r = await runVerifierBatch({
            db: db2,
            pickFn: pickNone,
            brregLookup: null,
            includeStaleReviewRequired: true,
            headProbe: async () => 200,
          });
          const promo = r.results.find((x) => x.agent_id === "b-promotable");
          assertTrue(!!promo, "b5: the promotable stale row was processed");
          assertEq(promo!.prior_verification_status, "review_required", "b5b: prior status is review_required");
          assertEq(promo!.new_verification_status, "verified", "b5c: re-evaluation promotes it to verified when evidence genuinely clears the gate");

          // ═══════════════════════════════════════════════════════════
          // Section C — pin the EXACT review_required_reevaluated /
          // review_required_promoted derivation (mirrors runVerifierTick's
          // own formula in admin-run-verifier.ts) against this known
          // results set (one promoted review_required-origin row).
          // ═══════════════════════════════════════════════════════════
          const reviewRequiredReevaluated = r.results.filter(
            (x) => x.prior_verification_status === "review_required",
          ).length;
          const reviewRequiredPromoted = r.results.filter(
            (x) => x.prior_verification_status === "review_required" && x.new_verification_status === "verified",
          ).length;
          assertEq(reviewRequiredReevaluated, 1, "c1: review_required_reevaluated counts the one review_required-origin row this run processed");
          assertEq(reviewRequiredPromoted, 1, "c2: review_required_promoted counts the one that reached verified");
        }
      } finally {
        try { initMod.__setDbForTesting(db as any); } catch { /* best-effort */ }
        db2.close();
      }
    } catch (err: any) {
      failed++;
      failures.push("lokal-agent-verifier-review-required-reevaluation: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      try { initMod.__setDbForTesting(prevDb); } catch { /* best-effort restore */ }
      db.close();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/agents/lokal-agent-verifier-review-required-reevaluation.test.ts`
if (require.main === module) {
  runLokalAgentVerifierReviewRequiredReevaluationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
