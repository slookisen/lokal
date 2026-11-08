/**
 * admin-agents-content-correction-address.test.ts — Daniel 2026-11-07 (Lega:
 * «Bygg admin-retting her»).
 *
 * POST /admin/agents/content-correction gains `field: "address"`: an audited,
 * reason-carrying correction of agent_knowledge.address that PUT
 * /admin/knowledge refuses (canCorrectFactualField). The apply appends ONE
 * `admin_correction` record to field_provenance.address and keeps every
 * existing record, so the cross-source verdict does not move and an
 * enrichment write of the old value stays refused.
 *
 * Covers: dry-run writes nothing; apply writes the column + provenance + one
 * audit row; existing records and other provenance fields kept; a single-object
 * address entry becomes an array; no address entry / NULL field_provenance;
 * no agent_knowledge row -> inserted; crossSourceAgreement verdict unchanged;
 * canCorrectFactualField still refuses the old value afterwards; owner lock,
 * curated lock, unchanged, malformed field_provenance (bad JSON, array) ->
 * skipped, nothing written; validation (empty, too long, two lines, bad
 * source_url, junk text); a description item in the same call is unchanged.
 *
 * Same harness as admin-agents-content-correction-owner-consent.test.ts
 * (better-sqlite3 ":memory:" + __initSchemaForTesting, the route's own DB
 * seam, router.handle() with a fake req/res — no HTTP). Mutates no shared
 * global (ADMIN_KEY only when unset, restored).
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { crossSourceAgreement } from "../services/cross-source-validator";
import { canCorrectFactualField } from "./admin-knowledge";

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
  opts: { headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: "/",
      originalUrl: "/",
      query: opts.query || {},
      headers,
      body: opts.body,
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
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

const OLD_ADDR = "Linutvegen 2";
const NEW_ADDR = "Litangen 2";
const SRC = "https://www.lega.no/kontakt";
const REC = (value: string, source_type: string) => ({ value, source_type, fetched_at: "2026-06-01T00:00:00Z" });
/** Two agreeing Tier-A records for the old value: pool_eligible today. */
const OLD_RECORDS = [REC(`${OLD_ADDR}, 3864 Rauland`, "google_places"), REC(OLD_ADDR, "homepage")];

export function runAdminAgentsContentCorrectionAddressTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "content-correction-address-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
         VALUES (?, ?, 'Ysteri og bakeri.', 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, field_provenance, curated_fields) VALUES (?, ?, ?, ?)`,
      );
      const agent = (id: string, knowledge: { address?: string | null; fp?: string | null; curated?: string } | null, claimedAt: string | null = null) => {
        insertAgent.run(id, `Gård ${id}`, `k-${id}`, claimedAt);
        if (knowledge) insertKnowledge.run(id, knowledge.address ?? null, knowledge.fp ?? null, knowledge.curated ?? "{}");
      };
      const FP_FULL = JSON.stringify({ address: OLD_RECORDS, phone: [REC("+47 35 00 00 00", "google_places")], website_ownership: { status: "verified" } });

      agent("ad-a", { address: OLD_ADDR, fp: FP_FULL });
      agent("ad-single", { address: OLD_ADDR, fp: JSON.stringify({ address: REC(OLD_ADDR, "google_places") }) });
      agent("ad-noentry", { address: OLD_ADDR, fp: JSON.stringify({ phone: [] }) });
      agent("ad-nullfp", { address: OLD_ADDR, fp: "" });
      agent("ad-norow", null);
      agent("ad-claimed", { address: OLD_ADDR, fp: FP_FULL }, "2026-01-01T00:00:00.000Z");
      agent("ad-curated", { address: OLD_ADDR, fp: FP_FULL, curated: JSON.stringify({ address: true }) });
      agent("ad-same", { address: NEW_ADDR, fp: FP_FULL });
      agent("ad-badjson", { address: OLD_ADDR, fp: "{not json" });
      agent("ad-array", { address: OLD_ADDR, fp: JSON.stringify([REC(OLD_ADDR, "google_places")]) });

      delete require.cache[require.resolve("./admin-agents-content-correction")];
      const routeMod = require("./admin-agents-content-correction");
      const router = routeMod.default;
      routeMod.__setContentCorrectionDbForTesting(db as any);

      const REASON = "Daniel 2026-11-07: adressen rettes etter lega.no";
      const post = (items: any[], apply = false) =>
        callRoute(router, { headers: { "x-admin-key": testKey }, body: { reason: REASON, items }, query: apply ? { apply: "1" } : {} });
      const item = (agent_id: string, extra: Record<string, unknown> = {}) => ({ agent_id, field: "address", text: NEW_ADDR, source_url: SRC, ...extra });
      const row = (id: string) =>
        db.prepare(`SELECT address, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as { address: string | null; field_provenance: string | null } | undefined;
      const audit = (id: string) =>
        db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ?`).all(id) as any[];
      const first = (r: RouteResult) => r.body?.results?.[0];

      // ── Dry-run ──
      let r = await post([item("ad-a")]);
      assertEq([r.status, r.body?.dry_run, first(r)?.outcome], [200, true, "would_write"], "ad-01: dry-run -> would_write");
      assertEq([first(r)?.old_value_preview, first(r)?.new_value_preview], [OLD_ADDR, NEW_ADDR], "ad-02: dry-run previews old/new address");
      assertEq([row("ad-a")?.address, row("ad-a")?.field_provenance], [OLD_ADDR, FP_FULL], "ad-03: dry-run wrote nothing");
      assertEq(audit("ad-a").length, 0, "ad-04: dry-run wrote no audit row");

      // ── Apply ──
      const verdictBefore = crossSourceAgreement(JSON.parse(FP_FULL), "address").verdict;
      r = await post([item("ad-a")], true);
      assertEq([r.body?.dry_run, first(r)?.outcome, first(r)?.field], [false, "written", "address"], "ad-05: apply -> written");
      assertEq(row("ad-a")?.address, NEW_ADDR, "ad-06: address column written");
      const fp = JSON.parse(row("ad-a")?.field_provenance ?? "{}");
      assertEq(fp.address.slice(0, 2), OLD_RECORDS, "ad-07: existing address records kept, in order, unchanged");
      assertEq(fp.address.length, 3, "ad-08: exactly one record appended");
      const added = fp.address[2];
      assertEq(
        [added.value, added.source_type, added.source_url],
        [NEW_ADDR, "admin_correction", SRC],
        "ad-09: appended record carries the new value, admin_correction, source_url",
      );
      assertTrue(typeof added.fetched_at === "string" && !isNaN(Date.parse(added.fetched_at)), "ad-10: appended record has an ISO fetched_at");
      assertTrue(typeof added.reason === "string" && added.reason.includes(REASON) && added.reason.startsWith(r.body?.batch_tag), "ad-11: appended record carries batch tag + reason");
      assertEq([fp.phone, fp.website_ownership], [JSON.parse(FP_FULL).phone, { status: "verified" }], "ad-12: other provenance fields untouched");
      const a = audit("ad-a");
      assertEq(a.length, 1, "ad-13: one audit row");
      assertEq([a[0]?.field_name, a[0]?.old_value, a[0]?.new_value, a[0]?.changed_by], ["address", OLD_ADDR, NEW_ADDR, "admin"], "ad-14: audit row field/old/new/changed_by");
      assertTrue(String(a[0]?.notes).includes(REASON) && String(a[0]?.notes).includes("field_provenance.address += ") && String(a[0]?.notes).includes("admin_correction"), "ad-15: audit notes carry reason and the appended record");
      assertEq(crossSourceAgreement(fp, "address").verdict, verdictBefore, "ad-16: cross-source verdict unchanged by the admin_correction record");
      assertEq(verdictBefore, "pool_eligible", "ad-17: fixture really was pool_eligible (ad-16 is not vacuous)");
      const reWrite = canCorrectFactualField({
        field: "address",
        existingFieldProvenance: fp.address,
        websiteOwnershipUnverified: false,
        incomingFieldProvenance: [REC(OLD_ADDR, "google_places"), REC(OLD_ADDR, "website_homepage")],
        isCurated: false,
        existingValue: NEW_ADDR,
        incomingValue: OLD_ADDR,
      });
      assertEq(reWrite.allowed, false, "ad-18: an enrichment write of the old address is still refused afterwards");

      // Second apply of the same value -> unchanged, nothing appended.
      r = await post([item("ad-a")], true);
      assertEq(first(r)?.outcome, "skipped_unchanged", "ad-19: same address again -> skipped_unchanged");
      assertEq(JSON.parse(row("ad-a")?.field_provenance ?? "{}").address.length, 3, "ad-20: unchanged appends no record");
      assertEq(audit("ad-a").length, 1, "ad-21: unchanged writes no audit row");

      // ── Provenance shapes ──
      r = await post([item("ad-single"), item("ad-noentry"), item("ad-nullfp", { source_url: undefined })], true);
      assertEq(r.body?.results?.map((x: any) => x.outcome), ["written", "written", "written"], "ad-22: single-object / no entry / empty provenance -> written");
      const single = JSON.parse(row("ad-single")?.field_provenance ?? "{}").address;
      assertEq([Array.isArray(single), single.length, single[0]?.source_type, single[1]?.source_type], [true, 2, "google_places", "admin_correction"], "ad-23: single-object entry becomes [old, appended]");
      const noentry = JSON.parse(row("ad-noentry")?.field_provenance ?? "{}");
      assertEq([noentry.phone, noentry.address.length], [[], 1], "ad-24: no address entry -> list of the one record, phone kept");
      const nullfp = JSON.parse(row("ad-nullfp")?.field_provenance ?? "{}");
      assertEq([Object.keys(nullfp), nullfp.address.length, "source_url" in nullfp.address[0]], [["address"], 1, false], "ad-25: empty provenance -> {address:[record]}, no source_url when none given");

      // No agent_knowledge row -> inserted.
      r = await post([item("ad-norow")], true);
      assertEq(first(r)?.outcome, "written", "ad-26: no knowledge row -> written");
      assertEq(row("ad-norow")?.address, NEW_ADDR, "ad-27: knowledge row inserted with the address");
      assertEq(audit("ad-norow")[0]?.old_value, null, "ad-28: audit old_value NULL for an inserted row");

      // ── Locks / skips (apply; nothing written) ──
      r = await post([item("ad-claimed"), item("ad-curated"), item("ad-same"), item("ad-badjson"), item("ad-array")], true);
      assertEq(
        r.body?.results?.map((x: any) => x.outcome),
        ["skipped_claimed", "skipped_curated", "skipped_unchanged", "skipped_malformed_json", "skipped_malformed_json"],
        "ad-29: owner lock / curated / unchanged / bad JSON / array provenance -> skipped",
      );
      for (const id of ["ad-claimed", "ad-curated", "ad-badjson", "ad-array"]) {
        assertEq(row(id)?.address, OLD_ADDR, `ad-30: ${id} address not written`);
        assertEq(audit(id).length, 0, `ad-31: ${id} no audit row`);
      }
      assertEq(row("ad-badjson")?.field_provenance, "{not json", "ad-32: malformed provenance left exactly as it was");

      // ── Validation ──
      r = await post([
        item("ad-a", { text: "   " }),
        item("ad-a", { text: "x".repeat(201) }),
        item("ad-a", { text: "Litangen 2\n3864 Rauland" }),
        item("ad-a", { source_url: "ftp://lega.no/" }),
        item("ad-a", { source_url: "javascript:alert(1)" }),
        item("ad-a", { source_url: "" }),
        item("ad-a", { source_url: 42 }),
        item("ad-a", { text: "<script>alert(1)</script>" }),
        item("ad-a", { text: "casino bonus spill" }),
      ]);
      const outs = r.body?.results?.map((x: any) => x.outcome);
      assertEq(outs?.slice(0, 7), Array(7).fill("invalid_item"), "ad-33: empty / too long / two lines / bad source_url -> invalid_item");
      assertEq(outs?.slice(7), ["refused_junk_text", "refused_junk_text"], "ad-34: code artifact / theme spam -> refused_junk_text (shared gate)");
      assertEq(r.body?.results?.[0]?.detail, "text required (non-empty)", "ad-35: empty text detail");
      assertEq(r.body?.results?.[2]?.detail, "address must be one line", "ad-36: two-line detail");
      r = await post([item("ad-a", { text: "x".repeat(200) })]);
      assertEq(first(r)?.outcome, "would_write", "ad-37: exactly 200 chars accepted (dry-run)");
      r = await post([{ agent_id: "ad-a", field: "adresse", text: NEW_ADDR }]);
      assertTrue(String(first(r)?.detail).includes("address"), "ad-38: unknown field detail lists address");

      // A description item in the same call keeps its own behaviour.
      r = await post([item("ad-norow", { text: "Totakvegen 181" }), { agent_id: "ad-norow", field: "description", text: "Ost og bakst." }]);
      assertEq(r.body?.results?.map((x: any) => [x.field, x.outcome]), [["address", "would_write"], ["description", "would_write"]], "ad-39: mixed address + description items each plan on their own");
    } finally {
      try { require("./admin-agents-content-correction").__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminAgentsContentCorrectionAddressTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
