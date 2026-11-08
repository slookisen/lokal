/**
 * admin-agents-content-correction-address.test.ts — Daniel 2026-11-07 (Lega:
 * «Bygg admin-retting her»).
 *
 * POST /admin/agents/content-correction gains `field: "address"`: an audited,
 * reason-carrying correction of agent_knowledge.address that PUT
 * /admin/knowledge refuses (canCorrectFactualField). On a real change the
 * apply resets the agent's geocode in the same transaction; field_provenance
 * is never touched, so the cross-source verdict cannot move.
 *
 * Covers: dry-run writes nothing (address, geocode, audit); apply writes the
 * column, resets all seven geocode columns, writes one audit row (reason,
 * «geocode reset», source_url); field_provenance byte-identical afterwards for
 * full, empty, inference-only and malformed values, and the crossSourceAgreement
 * verdict with it; no agent_knowledge row -> inserted, geocode reset; unchanged
 * -> no write, geocode kept; owner lock / curated -> skipped, geocode kept;
 * owner-locked row + valid owner_consent -> written_with_owner_consent;
 * validation (empty, too long, exactly 200, two lines, bad / too long
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
const GEO_COLS = "geo_precision, lat, lng, geocode_source, geocode_outcome, geocode_attempts, geocode_attempted_at";
const GEO_SET = ["address", 59.7, 8.0, "kartverket", "ok", 2, "2026-06-01 00:00:00"];
const GEO_RESET = [null, null, null, null, null, 0, null];

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
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at,
                             ${GEO_COLS})
         VALUES (?, ?, 'Ysteri og bakeri.', 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?,
                 ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, field_provenance, curated_fields) VALUES (?, ?, ?, ?)`,
      );
      const agent = (id: string, knowledge: { address?: string | null; fp?: string; curated?: string } | null, claimedAt: string | null = null) => {
        insertAgent.run(id, `Gård ${id}`, `k-${id}`, claimedAt, ...GEO_SET);
        if (knowledge) insertKnowledge.run(id, knowledge.address ?? null, knowledge.fp ?? "{}", knowledge.curated ?? "{}");
      };
      const FP_FULL = JSON.stringify({
        address: [REC(`${OLD_ADDR}, 3864 Rauland`, "google_places"), REC(OLD_ADDR, "homepage")],
        phone: [REC("+47 35 00 00 00", "google_places")],
      });
      const FP_INFER = JSON.stringify({ address: [REC(OLD_ADDR, "web_search:gulesider.no")] });
      const FP_ONE = JSON.stringify({ address: [REC(OLD_ADDR, "google_places")] });

      agent("ad-a", { address: OLD_ADDR, fp: FP_FULL });
      agent("ad-empty", { address: OLD_ADDR, fp: "{}" });
      agent("ad-infer", { address: OLD_ADDR, fp: FP_INFER });
      agent("ad-one", { address: OLD_ADDR, fp: FP_ONE });
      agent("ad-badjson", { address: OLD_ADDR, fp: "{not json" });
      agent("ad-norow", null);
      agent("ad-claimed", { address: OLD_ADDR, fp: FP_FULL }, "2026-01-01T00:00:00.000Z");
      agent("ad-curated", { address: OLD_ADDR, fp: FP_FULL, curated: JSON.stringify({ address: true }) });
      agent("ad-same", { address: NEW_ADDR, fp: FP_FULL });

      // Owner-locked row with a valid owner consent (S2e rule): our sent notice,
      // then a reply from the contact's own address.
      agent("ad-consent", { address: OLD_ADDR, fp: FP_ONE }, "2026-01-01T00:00:00.000Z");
      db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email) VALUES ('cc-ad', 'producer', 'ad-consent', 'eier@example.no')`).run();
      db.prepare(`INSERT INTO crm_threads (id, contact_id, subject) VALUES ('th-ad', 'cc-ad', 'Adresse')`).run();
      const msg = db.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, sent_at, received_at, delivery_status) VALUES (?, 'th-ad', ?, ?, ?, ?, 'sent')`,
      );
      msg.run("m-ad-out", "out", "post@rettfrabonden.com", "2026-11-01T08:00:00.000Z", "2026-11-01 08:00:00");
      msg.run("m-ad-in", "in", "eier@example.no", "2026-11-01T10:00:00.000Z", "2026-11-01 10:00:00");

      delete require.cache[require.resolve("./admin-agents-content-correction")];
      const routeMod = require("./admin-agents-content-correction");
      const router = routeMod.default;
      routeMod.__setContentCorrectionDbForTesting(db as any);

      const REASON = "Daniel 2026-11-07: adressen rettes etter lega.no";
      const post = (items: any[], apply = false) =>
        callRoute(router, { headers: { "x-admin-key": testKey }, body: { reason: REASON, items }, query: apply ? { apply: "1" } : {} });
      const item = (agent_id: string, extra: Record<string, unknown> = {}) => ({ agent_id, field: "address", text: NEW_ADDR, source_url: SRC, ...extra });
      const know = (id: string) =>
        db.prepare(`SELECT address, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as { address: string | null; field_provenance: string | null } | undefined;
      const geo = (id: string) => Object.values(db.prepare(`SELECT ${GEO_COLS} FROM agents WHERE id = ?`).get(id) as Record<string, unknown>);
      const audit = (id: string) =>
        db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ?`).all(id) as any[];
      const first = (r: RouteResult) => r.body?.results?.[0];

      assertEq(geo("ad-a"), GEO_SET, "ad-00: fixture geocode is set (reset assertions are not vacuous)");

      // ── Dry-run ──
      let r = await post([item("ad-a")]);
      assertEq([r.status, r.body?.dry_run, first(r)?.outcome], [200, true, "would_write"], "ad-01: dry-run -> would_write");
      assertEq([first(r)?.old_value_preview, first(r)?.new_value_preview], [OLD_ADDR, NEW_ADDR], "ad-02: dry-run previews old/new address");
      assertEq([know("ad-a")?.address, know("ad-a")?.field_provenance], [OLD_ADDR, FP_FULL], "ad-03: dry-run wrote nothing");
      assertEq(geo("ad-a"), GEO_SET, "ad-04: dry-run kept the geocode");
      assertEq(audit("ad-a").length, 0, "ad-05: dry-run wrote no audit row");

      // ── Apply ──
      r = await post([item("ad-a")], true);
      assertEq([r.body?.dry_run, first(r)?.outcome, first(r)?.field], [false, "written", "address"], "ad-06: apply -> written");
      assertEq(know("ad-a")?.address, NEW_ADDR, "ad-07: address column written");
      assertEq(know("ad-a")?.field_provenance, FP_FULL, "ad-08: field_provenance byte-identical");
      assertEq(geo("ad-a"), GEO_RESET, "ad-09: all seven geocode columns reset");
      const a = audit("ad-a");
      assertEq(a.length, 1, "ad-10: one audit row");
      assertEq([a[0]?.field_name, a[0]?.old_value, a[0]?.new_value, a[0]?.changed_by], ["address", OLD_ADDR, NEW_ADDR, "admin"], "ad-11: audit row field/old/new/changed_by");
      const notes = String(a[0]?.notes);
      assertTrue(notes.startsWith(r.body?.batch_tag) && notes.includes(REASON), "ad-12: audit notes carry batch tag + reason");
      assertTrue(notes.includes("[geocode reset]") && notes.includes(`[source_url: ${SRC}]`), "ad-13: audit notes carry the geocode reset and source_url");

      // Same value again -> unchanged: nothing written, geocode kept.
      db.prepare(`UPDATE agents SET lat = 59.7, lng = 8.0, geo_precision = 'address' WHERE id = 'ad-a'`).run();
      r = await post([item("ad-a")], true);
      assertEq(first(r)?.outcome, "skipped_unchanged", "ad-14: same address again -> skipped_unchanged");
      assertEq(geo("ad-a").slice(0, 3), ["address", 59.7, 8.0], "ad-15: unchanged keeps the geocode");
      assertEq(audit("ad-a").length, 1, "ad-16: unchanged writes no audit row");

      // ── Provenance never touched, so the verdict cannot move ──
      const shapes: Array<[string, string]> = [["ad-empty", "{}"], ["ad-infer", FP_INFER], ["ad-one", FP_ONE], ["ad-badjson", "{not json"]];
      const verdicts = (fp: string) => {
        try { return crossSourceAgreement(JSON.parse(fp), "address").verdict; } catch { return "unparseable"; }
      };
      const before = shapes.map(([, fp]) => verdicts(fp));
      r = await post(shapes.map(([id]) => item(id, { source_url: undefined })), true);
      assertEq(r.body?.results?.map((x: any) => x.outcome), ["written", "written", "written", "written"], "ad-17: empty / inference-only / one-source / malformed provenance -> written");
      for (const [id, fp] of shapes) {
        assertEq([know(id)?.address, know(id)?.field_provenance], [NEW_ADDR, fp], `ad-18: ${id} address written, field_provenance byte-identical`);
        assertEq(geo(id), GEO_RESET, `ad-19: ${id} geocode reset`);
      }
      assertEq(shapes.map(([id]) => verdicts(know(id)?.field_provenance ?? "")), before, "ad-20: crossSourceAgreement verdict unchanged for every shape");
      assertTrue(!String(audit("ad-empty")[0]?.notes).includes("source_url"), "ad-21: no source_url in notes when none given");

      // No agent_knowledge row -> inserted.
      r = await post([item("ad-norow")], true);
      assertEq(first(r)?.outcome, "written", "ad-22: no knowledge row -> written");
      assertEq(know("ad-norow")?.address, NEW_ADDR, "ad-23: knowledge row inserted with the address");
      assertEq(geo("ad-norow"), GEO_RESET, "ad-24: inserted row's agent geocode reset");
      assertEq(audit("ad-norow")[0]?.old_value, null, "ad-25: audit old_value NULL for an inserted row");

      // ── Locks / skips (apply; nothing written, geocode kept) ──
      r = await post([item("ad-claimed"), item("ad-curated"), item("ad-same")], true);
      assertEq(r.body?.results?.map((x: any) => x.outcome), ["skipped_claimed", "skipped_curated", "skipped_unchanged"], "ad-26: owner lock / curated / unchanged -> skipped");
      for (const id of ["ad-claimed", "ad-curated", "ad-same"]) {
        assertEq(geo(id), GEO_SET, `ad-27: ${id} geocode kept`);
        assertEq(audit(id).length, 0, `ad-28: ${id} no audit row`);
      }
      assertEq([know("ad-claimed")?.address, know("ad-curated")?.address], [OLD_ADDR, OLD_ADDR], "ad-29: locked rows' address not written");

      // ── Owner consent lets an address correction past the owner lock ──
      r = await post([item("ad-consent")]);
      assertEq(first(r)?.outcome, "skipped_claimed", "ad-30: owner-locked without consent -> skipped_claimed");
      r = await post([item("ad-consent", { owner_consent: { crm_message_id: "m-ad-in" } })], true);
      assertEq(first(r)?.outcome, "written_with_owner_consent", "ad-31: owner-locked + valid consent -> written_with_owner_consent");
      assertEq([know("ad-consent")?.address, geo("ad-consent")], [NEW_ADDR, GEO_RESET], "ad-32: consent write sets the address and resets the geocode");
      assertTrue(String(audit("ad-consent")[0]?.notes).includes("owner_consent=m-ad-in"), "ad-33: consent recorded in the audit notes");

      // ── Validation ──
      r = await post([
        item("ad-a", { text: "   " }),
        item("ad-a", { text: "x".repeat(201) }),
        item("ad-a", { text: "Litangen 2\n3864 Rauland" }),
        item("ad-a", { source_url: "ftp://lega.no/" }),
        item("ad-a", { source_url: "javascript:alert(1)" }),
        item("ad-a", { source_url: "" }),
        item("ad-a", { source_url: 42 }),
        item("ad-a", { source_url: "https://lega.no/" + "a".repeat(490) }),
        item("ad-a", { text: "<script>alert(1)</script>" }),
        item("ad-a", { text: "casino bonus spill" }),
      ]);
      const outs = r.body?.results?.map((x: any) => x.outcome);
      assertEq(outs?.slice(0, 8), Array(8).fill("invalid_item"), "ad-34: empty / too long / two lines / bad or too long source_url -> invalid_item");
      assertEq(outs?.slice(8), ["refused_junk_text", "refused_junk_text"], "ad-35: code artifact / theme spam -> refused_junk_text (shared gate)");
      assertEq(r.body?.results?.[0]?.detail, "text required (non-empty)", "ad-36: empty text detail");
      assertEq(r.body?.results?.[2]?.detail, "address must be one line", "ad-37: two-line detail");
      r = await post([item("ad-a", { text: "x".repeat(200), source_url: "https://lega.no/" + "a".repeat(484) })]);
      assertEq(first(r)?.outcome, "would_write", "ad-38: exactly 200 chars and a 500-char source_url accepted (dry-run)");
      r = await post([{ agent_id: "ad-a", field: "adresse", text: NEW_ADDR }]);
      assertTrue(String(first(r)?.detail).includes("address"), "ad-39: unknown field detail lists address");

      // A description item in the same call keeps its own behaviour.
      r = await post([item("ad-norow", { text: "Totakvegen 181" }), { agent_id: "ad-norow", field: "description", text: "Ost og bakst." }]);
      assertEq(r.body?.results?.map((x: any) => [x.field, x.outcome]), [["address", "would_write"], ["description", "would_write"]], "ad-40: mixed address + description items each plan on their own");
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
