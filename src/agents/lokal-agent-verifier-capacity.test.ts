/**
 * lokal-agent-verifier-capacity.test.ts — dev-request
 * 2026-10-10-rfb-verifier-kapasitet-til-fulle-profiler.
 *
 *   AC1: pickBatchBiased gives verified slots only to verified rows that need
 *        a re-check; a full-profile pending row is picked before an older one
 *        without; round-robin unchanged.
 *   AC2: the full-profile ranking uses the gate fields; phone is not used.
 *   AC3: the verifier sweep passes a Brreg lookup to every verifier batch
 *        (mocked; no network).
 *   Point 5: pick_slot reaches the run-envelope claims.
 *
 * Wired into tests/test.ts (runSerial, same convention as
 * lokal-agent-verifier-rfb-scope.test.ts).
 * Standalone: npx tsx src/agents/lokal-agent-verifier-capacity.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  pickBatchBiased,
  isFullProfileForVerifierRanking,
  verifierSecondTouchCooldownDays,
  buildRunEnvelope,
  resolveBrregLookup,
  type VerifierResult,
} from "./lokal-agent-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const DAY = 86400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Two agreeing Tier-A address sources (homepage + google_places).
const FULL_PROV = JSON.stringify({
  address: [
    { value: "Storgata 1, 0150 Oslo", source_type: "homepage", source_url: "https://full.no/" },
    { value: "Storgata 1, 0150 Oslo", source_type: "google_places", source_url: "https://maps.google.com/x" },
  ],
});
// Only one source, and an inference one.
const THIN_PROV = JSON.stringify({
  address: [{ value: "Storgata 1, 0150 Oslo", source_type: "category_inference" }],
});
const ABOUT = "Vi driver en liten gard med egen produksjon av eple, most og syltetøy, og selger direkte fra gården hele året.";
const PRODUCTS = JSON.stringify([{ name: "Eplemost" }, { name: "Bringebærsyltetøy" }, { name: "Eplekake" }]);

function fullRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Full Gård",
    email: "post@full.no",
    website: "https://full.no",
    about: ABOUT,
    products: PRODUCTS,
    field_provenance: FULL_PROV,
    phone: "+4791234567",
    ...over,
  };
}

export async function runLokalAgentVerifierCapacityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const prevDb = initMod.getDb();

  function freshDb(): any {
    const db = new Database(":memory:");
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    return db;
  }

  function seeder(db: any) {
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
       VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, 0)`,
    );
    const insK = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, website, about, products, field_provenance, phone,
                                    verification_status, enrichment_status, last_verified_at,
                                    url_last_probed, url_last_status, last_http_status, sweep_processed_at)
       VALUES (@id, @email, @website, @about, @products, @field_provenance, @phone,
               @status, @enrichment, @last_verified_at,
               @url_last_probed, @url_last_status, @last_http_status, @sweep_processed_at)`,
    );
    return (id: string, status: string, o: Record<string, unknown> = {}) => {
      const website = (o.website as string | null | undefined) ?? `https://${id}.no`;
      insA.run(id, (o.name as string) ?? `${id} AS`, website, `key-${id}`);
      insK.run({
        id,
        email: `post@${id}.no`,
        website,
        about: "kort",
        products: "[]",
        field_provenance: "{}",
        phone: null,
        enrichment: "thin",
        last_verified_at: "2026-01-01T00:00:00.000Z",
        url_last_probed: iso(1 * DAY),
        url_last_status: 200,
        last_http_status: 200,
        sweep_processed_at: null,
        ...o,
        status,
      });
    };
  }

  const sendLog = (db: any, agentId: string, email: string, sentMsAgo: number) =>
    db.prepare(
      `INSERT INTO outreach_sent_log (agent_id, sent_at, channel, recipient_email, vertical_id)
       VALUES (?, ?, 'email', ?, 'rfb')`,
    ).run(agentId, iso(sentMsAgo).replace("T", " ").slice(0, 19), email);

  try {
    // ── AC1a: verified rows that need no re-check are not picked ─────────
    {
      const db = freshDb();
      const seed = seeder(db);
      // 10 verified rows: already contacted 5 days ago (not in/entering the
      // pool, second contact not due), fresh 200 URL probe, nothing flagged.
      for (let i = 0; i < 10; i++) {
        seed(`calm-${i}`, "verified", { enrichment: "rich", about: ABOUT });
        sendLog(db, `calm-${i}`, `post@calm-${i}.no`, 5 * DAY);
      }
      for (let i = 0; i < 40; i++) seed(`pv-${i}`, "pending_verify");
      const batch = pickBatchBiased(db, 30);
      const ver = batch.filter((r: any) => r.verification_status === "verified");
      assertTrue(batch.length === 30, `AC1a: batch is still full (got ${batch.length})`);
      assertTrue(ver.length === 0, `AC1a: no verified row without re-check need is picked when growth exists (got ${ver.length})`);
      assertTrue(batch.every((r: any) => r.pick_slot === "growth_other" || r.pick_slot === "growth_full_profile"),
        "AC1a: every slot is tagged as a growth slot");
      db.close();
    }

    // ── AC1a': each re-check reason earns a verified slot ────────────────
    {
      const db = freshDb();
      const seed = seeder(db);
      seed("calm", "verified", { enrichment: "rich", about: ABOUT });
      sendLog(db, "calm", "post@calm.no", 5 * DAY);
      // (a) URL probe about to go stale (25 days old)
      seed("url-stale", "verified", { enrichment: "rich", about: ABOUT, url_last_probed: iso(25 * DAY) });
      sendLog(db, "url-stale", "post@url-stale.no", 5 * DAY);
      // (b) flagged: last HTTP check failed
      seed("flagged", "verified", { enrichment: "rich", about: ABOUT, last_http_status: 503 });
      sendLog(db, "flagged", "post@flagged.no", 5 * DAY);
      // (c) entering the pool: verified, rich, content OK, never contacted
      seed("pool", "verified", { enrichment: "rich", about: ABOUT });
      // (d) second contact due within 14 days (one send, cooldown-10 days ago)
      seed("second", "verified", { enrichment: "rich", about: ABOUT });
      sendLog(db, "second", "post@second.no", (verifierSecondTouchCooldownDays() - 10) * DAY);
      // a contacted row whose second contact is NOT yet due (cooldown-30 days)
      seed("second-later", "verified", { enrichment: "rich", about: ABOUT });
      sendLog(db, "second-later", "post@second-later.no", (verifierSecondTouchCooldownDays() - 30) * DAY);
      for (let i = 0; i < 40; i++) seed(`pv-${i}`, "pending_verify");

      const batch = pickBatchBiased(db, 30);
      const verIds = batch.filter((r: any) => r.verification_status === "verified").map((r: any) => r.id).sort();
      assertTrue(JSON.stringify(verIds) === JSON.stringify(["flagged", "pool", "second", "url-stale"]),
        `AC1a': exactly the 4 rows that need a re-check get verified slots (got ${JSON.stringify(verIds)})`);
      assertTrue(batch.length === 30, `AC1a': unused verified slots go to growth (batch ${batch.length})`);
      assertTrue(batch.filter((r: any) => r.pick_slot === "verified_recheck").length === 4,
        "AC1a': verified rows are tagged verified_recheck");
      db.close();
    }

    // ── AC1a'': no growth rows → verified rows still fill the batch ──────
    {
      const db = freshDb();
      const seed = seeder(db);
      for (let i = 0; i < 12; i++) {
        seed(`calm-${i}`, "verified", { enrichment: "rich", about: ABOUT });
        sendLog(db, `calm-${i}`, `post@calm-${i}.no`, 5 * DAY);
      }
      const batch = pickBatchBiased(db, 10);
      assertTrue(batch.length === 10, `AC1a'': without growth rows, verified rows fill the batch (got ${batch.length})`);
      assertTrue(batch.every((r: any) => r.pick_slot === "verified_fill"), "AC1a'': those are tagged verified_fill");
      db.close();
    }

    // ── AC1b: a full-profile pending row is picked before an older one ───
    {
      const db = freshDb();
      const seed = seeder(db);
      for (let i = 0; i < 5; i++) seed(`old-${i}`, "pending_verify", { last_verified_at: "2025-01-01T00:00:00.000Z" });
      seed("full", "pending_verify", {
        ...fullRow({ website: "https://full.no", email: "post@full.no" }),
        last_verified_at: "2026-06-01T00:00:00.000Z",
      });
      // limit 4, ratio 1.0 → one slot per growth status; pending gets one.
      const batch = pickBatchBiased(db, 4, 1.0);
      const pv = batch.filter((r: any) => r.verification_status === "pending_verify");
      assertTrue(pv[0]?.id === "full", `AC1b: the full-profile pending row takes the pending slot (got ${pv[0]?.id})`);
      assertTrue(pv[0]?.pick_slot === "growth_full_profile", "AC1b: tagged growth_full_profile");

      // Without the full profile the older row would win (today's order).
      db.prepare(`UPDATE agent_knowledge SET field_provenance = ? WHERE agent_id = 'full'`).run(THIN_PROV);
      const batch2 = pickBatchBiased(db, 4, 1.0);
      const pv2 = batch2.filter((r: any) => r.verification_status === "pending_verify");
      assertTrue(pv2[0]?.id === "old-0", `AC1b: without full profile the oldest row comes first (got ${pv2[0]?.id})`);
      db.close();
    }

    // ── AC1c: round-robin unchanged ──────────────────────────────────────
    {
      const db = freshDb();
      const seed = seeder(db);
      // A full-profile row swept an hour ago keeps its round-robin place:
      // never-swept rows without a full profile come first.
      seed("full-recent", "pending_verify", { ...fullRow({ website: "https://full.no", email: "post@full.no" }), sweep_processed_at: iso(3600_000) });
      for (let i = 0; i < 3; i++) seed(`never-${i}`, "pending_verify");
      const b1 = pickBatchBiased(db, 3, 1.0).map((r: any) => r.id);
      assertTrue(!b1.includes("full-recent"), `AC1c: a just-swept full profile is not re-picked (got ${JSON.stringify(b1)})`);

      // Rotation: stamp what was picked, pick again → no repeats until all seen.
      const seen = new Set<string>();
      for (let round = 0; round < 3; round++) {
        const ids = pickBatchBiased(db, 1, 1.0).map((r: any) => r.id);
        for (const id of ids) {
          assertTrue(!seen.has(id), `AC1c: round ${round} does not repeat ${id}`);
          seen.add(id);
          db.prepare(`UPDATE agent_knowledge SET sweep_processed_at = ? WHERE agent_id = ?`)
            .run(new Date(Date.now() + round * 1000).toISOString(), id);
        }
      }

      // A full profile swept 4 days ago (older than the 72 h no-boost
      // window) jumps ahead of a non-full row swept 5 days ago.
      const db2 = freshDb();
      const seed2 = seeder(db2);
      seed2("plain-5d", "pending_verify", { sweep_processed_at: iso(5 * DAY) });
      seed2("full-4d", "pending_verify", { ...fullRow({ website: "https://full.no", email: "post@full.no" }), sweep_processed_at: iso(4 * DAY) });
      const b2 = pickBatchBiased(db2, 1, 1.0).map((r: any) => r.id);
      assertTrue(b2[0] === "full-4d", `AC1c: a full profile not swept for 3+ days is boosted (got ${JSON.stringify(b2)})`);
      db.close();
      db2.close();
    }

    // ── AC2: ranking uses the gate fields; phone is not used ─────────────
    {
      const a = fullRow({ phone: "+4791234567" });
      const b = fullRow({ phone: null });
      assertTrue(isFullProfileForVerifierRanking(a) === true, "AC2: full profile with phone");
      assertTrue(isFullProfileForVerifierRanking(b) === true, "AC2: same row without phone is still a full profile");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ website: "" })) === false, "AC2: no website → not full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ email: "post@annet-domene.no" })) === false,
        "AC2: e-mail on another domain → not full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ email: "fullgard@gmail.com" })) === true,
        "AC2: free-mail address → full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ about: "kort", products: "[]" })) === false,
        "AC2: content under the threshold → not full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ about: ABOUT, products: JSON.stringify(["Honning", "Egg", "Kjøtt"]) })) === false,
        "AC2: products that are only category names → not full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({ field_provenance: THIN_PROV })) === false,
        "AC2: address with only an inference source → not full");
      assertTrue(isFullProfileForVerifierRanking(fullRow({
        field_provenance: JSON.stringify({ address: [{ value: "Storgata 1, 0150 Oslo", source_type: "homepage" }] }),
      })) === false, "AC2: one Tier-A address source → not full");

      // Two pending rows identical except phone get the same rank: the
      // round-robin order decides (older last_verified_at first) either way.
      for (const phoneOnFirst of [true, false]) {
        const db = freshDb();
        const seed = seeder(db);
        for (let i = 0; i < 3; i++) seed(`plain-${i}`, "pending_verify", { last_verified_at: "2025-01-01T00:00:00.000Z" });
        seed("p-older", "pending_verify", { ...fullRow({ website: "https://full.no", email: "post@full.no" }), phone: phoneOnFirst ? "+4791234567" : null, last_verified_at: "2026-02-01T00:00:00.000Z" });
        seed("p-newer", "pending_verify", { ...fullRow({ website: "https://full.no", email: "post@full.no" }), phone: phoneOnFirst ? null : "+4791234567", last_verified_at: "2026-03-01T00:00:00.000Z" });
        const pv = pickBatchBiased(db, 8, 1.0).filter((r: any) => r.verification_status === "pending_verify").map((r: any) => r.id);
        assertTrue(pv[0] === "p-older" && pv[1] === "p-newer",
          `AC2: phone does not change the rank (phone on ${phoneOnFirst ? "older" : "newer"}; got ${JSON.stringify(pv)})`);
        db.close();
      }
    }

    // ── Cooldown mirror stays equal to the marketing gate's ──────────────
    {
      const { resolveRfbMarketingGateCooldownDays } = require("../services/rfb-marketing-daily") as typeof import("../services/rfb-marketing-daily");
      const prev = process.env.OUTREACH_COOLDOWN_DAYS;
      for (const v of [undefined, "30", "90"]) {
        if (v === undefined) delete process.env.OUTREACH_COOLDOWN_DAYS;
        else process.env.OUTREACH_COOLDOWN_DAYS = v;
        assertTrue(verifierSecondTouchCooldownDays() === resolveRfbMarketingGateCooldownDays(),
          `cooldown mirror equals resolveRfbMarketingGateCooldownDays (OUTREACH_COOLDOWN_DAYS=${v ?? "unset"})`);
      }
      if (prev === undefined) delete process.env.OUTREACH_COOLDOWN_DAYS;
      else process.env.OUTREACH_COOLDOWN_DAYS = prev;
    }

    // ── Point 5: pick_slot counts reach the envelope claims ──────────────
    {
      const base = { passed: true, flags: [], fields_verified: [], fields_failed: [], http_status: 200, brreg_status: null,
        new_verification_status: "verified", new_enrichment_status: "rich", outreach_eligible_at: null, cross_source_reason: {},
        url_last_probed: null, url_last_status: null, url_demoted: false, domain_incoherent: false,
        email_ownership_unproven: false, email_ownership_report_only: false, verified_second_line: false,
        agent_name: null, prior_verification_status: "pending_verify" };
      const results = [
        { ...base, agent_id: "a", pick_slot: "verified_recheck" },
        { ...base, agent_id: "b", pick_slot: "growth_full_profile" },
        { ...base, agent_id: "c", pick_slot: "growth_full_profile" },
        { ...base, agent_id: "d", pick_slot: "growth_other" },
        { ...base, agent_id: "e" },
      ] as unknown as VerifierResult[];
      const env: any = buildRunEnvelope({ run_id: "r", started_at: "s", finished_at: "f", results });
      const claim = (k: string) => env.claims.find((c: any) => c.meta?.kind === k)?.value;
      assertTrue(claim("verifier_slots_verified_recheck") === 1, "point 5: verified_recheck claim");
      assertTrue(claim("verifier_slots_growth_full_profile") === 2, "point 5: growth_full_profile claim");
      assertTrue(claim("verifier_slots_growth_other") === 1, "point 5: growth_other claim");
      assertTrue(claim("verifier_slots_verified_fill") === 0, "point 5: verified_fill claim");
      const legacy: any = buildRunEnvelope({ run_id: "r", started_at: "s", finished_at: "f", results: [results[4]!] });
      assertTrue(!legacy.claims.some((c: any) => String(c.meta?.kind ?? "").startsWith("verifier_slots_")),
        "point 5: no slot claims when no result carries pick_slot (other pickers unchanged)");
    }

    // ── AC3: the sweep passes Brreg data to the verifier ─────────────────
    {
      const { startSweep, getSweepJob } = require("../services/verifier-sweep") as typeof import("../services/verifier-sweep");
      const waitDone = async () => {
        for (let i = 0; i < 1000 && getSweepJob().status === "running"; i++) {
          await new Promise((r) => setImmediate(r));
        }
      };

      const db = freshDb();
      const brregCalls: Array<[string, string | null]> = [];
      const mockBrreg = async (name: string, city: string | null) => {
        brregCalls.push([name, city]);
        return { is_active: true, is_konkurs: false, naering: "01.130", navn: name.toUpperCase() };
      };
      const seenLookups: unknown[] = [];
      const seenBrreg: unknown[] = [];
      let calls = 0;
      const res = startSweep({
        db,
        sleep: () => Promise.resolve(),
        brregLookup: mockBrreg,
        runBatch: async (o) => {
          calls++;
          seenLookups.push(o.brregLookup);
          if (calls > 1) return { run_id: "x", started_at: "s", finished_at: "f", results: [] };
          // What runVerifierBatch does with it: one lookup per candidate.
          seenBrreg.push(await o.brregLookup?.("Solbakken Gard", "Oslo"));
          return { run_id: "x", started_at: "s", finished_at: "f", results: [] };
        },
      });
      assertTrue(res.started === true, "AC3: sweep started");
      await waitDone();
      assertTrue(seenLookups.length >= 1 && seenLookups.every((f) => f === mockBrreg),
        "AC3: every sweep chunk gets the injected Brreg lookup");
      assertTrue(brregCalls.length === 1 && brregCalls[0]![0] === "Solbakken Gard",
        "AC3: the lookup is called with the agent's name");
      assertTrue((seenBrreg[0] as any)?.navn === "SOLBAKKEN GARD" && (seenBrreg[0] as any)?.is_active === true,
        "AC3: Brreg data reaches the verifier batch");

      // Default (nothing injected): the same lookup the scheduled path uses.
      const defaults: unknown[] = [];
      const res2 = startSweep({
        db,
        sleep: () => Promise.resolve(),
        agentIds: ["none-1"],
        runBatch: async (o) => {
          defaults.push(o.brregLookup);
          return { run_id: "x", started_at: "s", finished_at: "f", results: [] };
        },
      });
      assertTrue(res2.started === true, "AC3: second sweep started");
      await waitDone();
      assertTrue(defaults.length === 1 && defaults[0] === resolveBrregLookup,
        "AC3: default sweep lookup is resolveBrregLookup (as in admin-run-verifier.ts)");

      // End to end: the sweep's lookup through the REAL runVerifierBatch —
      // Brreg data shows up in the verifier result. All network seams are
      // mocked and global fetch throws, so nothing leaves the process.
      const { runVerifierBatch } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");
      const seed = seeder(db);
      seed("sweep-pv", "pending_verify", { name: "Solbakken Gard" });
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = async () => { throw new Error("network disabled in test"); };
      const e2eStatuses: Array<string | null> = [];
      try {
        brregCalls.length = 0;
        const res3 = startSweep({
          db,
          sleep: () => Promise.resolve(),
          chunkSize: 5,
          maxAgents: 1,
          brregLookup: mockBrreg,
          runBatch: async (o) => {
            const out = await runVerifierBatch({
              ...o,
              headProbe: async () => 200,
              urlProbeFetch: (async () => { throw new Error("no network"); }) as any,
              terminalDeathCheckFetch: (async () => { throw new Error("no network"); }) as any,
            });
            for (const r of out.results) e2eStatuses.push(r.brreg_status);
            return out;
          },
        });
        assertTrue(res3.started === true, "AC3 e2e: sweep started");
        for (let i = 0; i < 20000 && getSweepJob().status === "running"; i++) {
          await new Promise((r) => setTimeout(r, 1));
        }
      } finally {
        (globalThis as any).fetch = realFetch;
      }
      assertTrue(brregCalls.some(([n]) => n === "Solbakken Gard"), "AC3 e2e: runVerifierBatch called the sweep's Brreg lookup");
      assertTrue(e2eStatuses[0] === "aktiv", `AC3 e2e: Brreg status reaches the verifier result (got ${JSON.stringify(e2eStatuses)})`);
      db.close();
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runLokalAgentVerifierCapacityTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
