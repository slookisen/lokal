/**
 * admin-agents-facebook-tier-shadow.test.ts — enrichment-kadens S1a.
 * The pure shadow (computeFacebookTierShadow) and the real read-only GET route
 * against an in-memory DB.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const rec = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-10-01T00:00:00Z" });

export async function runAdminAgentsFacebookTierShadowTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (ok) passed++;
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
    }
    if (opts.log) console.log(`  ${ok ? "ok" : "✗"} ${label}`);
  };

  const prevDb = (() => {
    try { return require("../database/init").getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = "fb-tier-shadow-test-key";
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  try {
    const { computeFacebookTierShadow } = require("../services/facebook-tier-shadow") as
      typeof import("../services/facebook-tier-shadow");
    const { crossSourceAgreement } = require("../services/cross-source-validator") as
      typeof import("../services/cross-source-validator");

    // (1) facebook + homepage only on address → agrees today, not without facebook.
    const fbHome = {
      address: [rec("facebook_official_page", "Storgata 1, 0150 Oslo"), rec("homepage", "Storgata 1, 0150 Oslo")],
    };
    const s1 = computeFacebookTierShadow(fbHome, { ownName: "Test Gard" });
    eq(s1.fields.address.now.verdict, "review_required", "(1) now (post-S1b): facebook+homepage address is review_required");
    eq(s1.fields.address.shadow.verdict, "review_required", "(1) shadow: homepage alone is review_required");
    eq(s1.fields.address.has_facebook_record, true, "(1) has_facebook_record");
    eq(s1.fields.address.would_lose, false, "(1) post-S1b: now already ignores facebook, nothing left to lose");
    eq([s1.aggregate_now, s1.aggregate_shadow, s1.aggregate_would_lose], ["review_required", "review_required", false],
      "(1) aggregate: review_required both (post-S1b)");
    // "now" must be exactly what production computes.
    eq(s1.fields.address.now, crossSourceAgreement(fbHome, "address", { ownName: "Test Gard" }),
      "(1) now result equals production crossSourceAgreement");

    // (1b) phone: facebook + google_places only.
    const s1p = computeFacebookTierShadow({
      phone: [rec("facebook_official_page", "+47 912 34 567"), rec("google_places", "91234567")],
    });
    eq([s1p.fields.phone.now.agree, s1p.fields.phone.would_lose], [false, false], "(1b) phone facebook+google_places -> no longer agrees (post-S1b)");
    eq(s1p.aggregate_would_lose, false, "(1b) phone does not gate the aggregate");

    // (2) facebook + brreg + google_places all agree → still agrees without facebook.
    const s2 = computeFacebookTierShadow({
      address: [
        rec("facebook_official_page", "Storgata 1, 0150 Oslo"),
        rec("brreg", "Storgata 1, 0150 Oslo"),
        rec("google_places", "Storgata 1, 0150 Oslo"),
      ],
    });
    eq([s2.fields.address.now.agree, s2.fields.address.shadow.agree], [true, true], "(2) brreg+google_places still agree");
    eq(s2.fields.address.would_lose, false, "(2) not counted as would_lose");
    eq(s2.aggregate_would_lose, false, "(2) aggregate unchanged");
    eq(s2.fields.address.shadow.sources_used, ["brreg", "google_places"], "(2) shadow drops only facebook");

    // (3) no facebook → unaffected (shadow identical to now).
    const noFb = {
      address: [rec("homepage", "Storgata 1, 0150 Oslo"), rec("brreg", "Storgata 1, 0150 Oslo")],
      phone: [rec("homepage", "91234567")],
    };
    const s3 = computeFacebookTierShadow(noFb);
    eq(s3.fields.address.has_facebook_record, false, "(3) no facebook record");
    eq(s3.fields.address.shadow, s3.fields.address.now, "(3) address shadow == now");
    eq(s3.fields.phone.shadow, s3.fields.phone.now, "(3) phone shadow == now");
    eq([s3.fields.address.would_lose, s3.fields.phone.would_lose, s3.aggregate_would_lose], [false, false, false],
      "(3) nothing would be lost");

    // Extra: Tier-S owner keeps agreement; legacy single-record facebook only is not "agreed" today.
    const sOwner = computeFacebookTierShadow({
      address: [rec("facebook_official_page", "Storgata 1"), rec("owner", "Storgata 1")],
    });
    eq(sOwner.fields.address.would_lose, false, "owner (Tier-S) + facebook: not lost");
    const sLegacy = computeFacebookTierShadow({ address: rec("facebook_official_page", "Storgata 1") });
    eq([sLegacy.fields.address.has_facebook_record, sLegacy.fields.address.now.verdict,
        sLegacy.fields.address.shadow.verdict, sLegacy.fields.address.would_lose],
      [true, "data_insufficient", "data_insufficient", false], "legacy single-record facebook: not counted");
    // The input object is not mutated.
    eq(fbHome.address.length, 2, "input provenance is not mutated");

    // ── Route ────────────────────────────────────────────────────────────────
    __setDbForTesting(db as any);
    __initSchemaForTesting(db as any);
    const ins = (id: string, name: string, prov: unknown, status = "pending_verify", umbrella: string | null = null) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, '', 't', 'x@example.com', 'https://example.com', 'producer', ?, ?)`,
      ).run(id, name, `key-${id}`, umbrella);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, field_provenance, verification_status) VALUES (?, ?, ?)`)
        .run(id, typeof prov === "string" ? prov : JSON.stringify(prov), status);
    };
    ins("fb-home", "Fjellgård Øst", fbHome, "verified");
    ins("fb-three", "Tre Kilder Gard", {
      address: [rec("facebook_official_page", "Storgata 1, 0150 Oslo"), rec("brreg", "Storgata 1, 0150 Oslo"),
        rec("google_places", "Storgata 1, 0150 Oslo")],
      phone: [rec("facebook_official_page", "91234567"), rec("google_places", "+47 91234567")],
    });
    ins("no-fb", "Uten Facebook", noFb);
    ins("empty", "Tom Gard", "{}");
    ins("broken", "Ødelagt Gard", "not json");
    ins("opted-out", "Ut Gard", fbHome, "opt_out");
    ins("umbrella", "Paraply", fbHome, "pending_verify", "association");

    const router = require("./admin-agents-facebook-tier-shadow").default;
    const call = (headers: Record<string, string>) => {
      let out: { status: number; body: any } = { status: 200, body: undefined };
      const res: any = {
        statusCode: 200,
        status(c: number) { this.statusCode = c; return this; },
        json(p: any) { out = { status: this.statusCode, body: p }; return this; },
      };
      router.handle({ method: "GET", url: "/", query: {}, headers, body: undefined }, res, () => {});
      return out;
    };

    // (4) auth
    eq(call({}).status, 403, "(4) route: no admin key -> 403");
    eq(call({ "x-admin-key": "wrong" }).status, 403, "(4) route: wrong admin key -> 403");

    // (5) read-only: total_changes and table snapshots unchanged.
    const snapshot = () => JSON.stringify({
      a: db.prepare(`SELECT * FROM agents ORDER BY id`).all(),
      k: db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all(),
    });
    const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
    const beforeSnap = snapshot();
    const beforeChanges = changes();
    const r = call({ "x-admin-key": "fb-tier-shadow-test-key" });
    eq(changes(), beforeChanges, "(5) route: total_changes() unchanged");
    eq(snapshot() === beforeSnap, true, "(5) route: agents/agent_knowledge rows unchanged");

    eq(r.status, 200, "(4) route: 200 with admin key");
    const b = r.body;
    eq([b.success, b.read_only, b.excluded_source_type], [true, true, "facebook_official_page"], "(4) header fields");
    eq(b.scanned_count, 4, "(4) scope: '{}', opt_out and umbrella rows excluded");
    eq(b.unparseable_provenance, 1, "(4) unparseable provenance counted, not thrown");
    const a = b.rfb.fields.address;
    eq([a.evaluated, a.with_records, a.has_facebook_record, a.agree_now, a.agree_shadow, a.would_lose], [3, 3, 2, 2, 2, 0],
      "(4) address counts");
    eq(a.examples, [], "(4) address examples empty post-S1b");
    const p = b.rfb.fields.phone;
    eq([p.evaluated, p.with_records, p.has_facebook_record, p.agree_now, p.agree_shadow, p.would_lose], [3, 2, 1, 0, 0, 0],
      "(4) phone counts");
    eq(p.examples, [], "(4) phone examples empty post-S1b");
    const g = b.rfb.aggregate;
    eq([g.gating_fields, g.pool_eligible_now, g.pool_eligible_shadow, g.would_lose, g.would_lose_to],
      [["address"], 2, 2, 0, {}], "(4) aggregate counts (post-S1b: now == shadow)");
    eq(g.examples, [], "(4) aggregate examples empty post-S1b");
    eq(b.rfb.uses_validator, true, "(4) rfb uses_validator");
    eq([b.gardssalg.uses_validator, b.dental.uses_validator], [false, false], "(4) gardssalg/dental uses_validator false");
    eq(typeof b.gardssalg.reason === "string" && typeof b.dental.reason === "string", true, "(4) reasons present");
  } catch (err) {
    failed++;
    failures.push(`facebook-tier-shadow: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./admin-agents-facebook-tier-shadow")]; } catch { /* ignore */ }
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAgentsFacebookTierShadowTests({ log: true }).then((r) => {
    console.log(`\nfacebook-tier-shadow: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
