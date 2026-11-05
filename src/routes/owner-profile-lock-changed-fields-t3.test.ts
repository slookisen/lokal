/**
 * owner-profile-lock-changed-fields-t3.test.ts — slice T3 of the owner
 * portal: a profile save locks / audits / writes ONLY the fields that
 * actually change (all owners), and empty opening hours ('[]', the DB
 * default) are never shown as "[]" and never locked.
 *
 *   a  full seven-field save where one field changed → exactly one audit row
 *      and one new lock, for that field; other curated_fields entries
 *      (including a pre-existing owner lock) byte-identical.
 *   b  full save with nothing changed → zero audit rows, curated_fields and
 *      updated_at untouched, updated_fields [].
 *   c  stored opening_hours '[]' + submitted '' → no lock, no audit.
 *   d  the portal page for an agent with opening_hours '[]' does not render
 *      value="[]" in the opening-hours input.
 *   e  whitespace / CRLF-only differences count as unchanged (gårdssalg model).
 *   f  a lock by another party (by:"admin") still skips with locked_by_admin.
 *   g  the no-JS fallback POST /eier/:id/save forwards to update-profile and
 *      inherits the rule.
 *
 * Real router on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as write-guard-t0a.test.ts).
 * Exported runOwnerProfileLockChangedFieldsT3Tests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/owner-profile-lock-changed-fields-t3.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const ID = "t3-owner";
const EMAIL = `post@${ID}.example.no`;
const ABOUT = "Liten familiegård.\nVi selger egg og poteter.";
const PRE_LOCK = { locked_at: "2026-09-01T10:00:00.000Z", by: "owner" };

export async function runOwnerProfileLockChangedFieldsT3Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void { assertEq(!!cond, true, label); }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevGate = process.env[GATE_ENV];

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { method?: string; route: string; params: Record<string, string>; body?: any; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.method || "POST", url: "/", path: "/", originalUrl: "/", route: { path: o.route },
      params: o.params, body: o.body ?? {}, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc?: string) { if (typeof c === "number") status = c; settle({ __redirect: loc ?? c }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; }, clearCookie() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  console.log = () => { /* silence route logging */ };
  const prevFetch = (globalThis as any).fetch;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env[GATE_ENV];
    try { delete require.cache[require.resolve("./owner-portal")]; } catch { /* not loaded yet */ }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");

    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
       VALUES (?, 'T3 Gard', 'Testprodusent for T3.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
    ).run(ID, EMAIL, `https://${ID}.example.no`, `key-${ID}`);
    // opening_hours omitted → the schema default '[]'.
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, phone, address, postal_code, website, about, curated_fields, updated_at, verification_status, verified_second_line)
       VALUES (?, ?, '+47 400 00 000', 'Gardsveien 1', '0150', ?, ?, ?, '2026-09-01T10:00:00.000Z', 'verified', 0)`,
    ).run(ID, EMAIL, `https://${ID}.example.no`, ABOUT, JSON.stringify({ address: PRE_LOCK }));
    const token = `tok-secret-${ID}`;
    db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(`mlsess_${ID}`, EMAIL, token, ID, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());

    const UP = "/api/agents/:id/update-profile";
    const updateProfile = findRouteHandler(portalMod.default, UP, "post");
    const portal = findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get");
    const save = findRouteHandler(portalMod.default, "/eier/:agentId/save", "post");
    const row = () => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(ID) as any;
    const audits = () => db.prepare("SELECT field_name, old_value, new_value FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid").all(ID) as any[];
    const up = (body: Record<string, unknown>) => invoke(updateProfile, makeReq({ route: UP, params: { id: ID }, body, token }));

    // What the portal form posts on an untouched save: every field as shown.
    const fullForm = (over: Record<string, string> = {}) => {
      const k = row();
      return {
        email: k.email ?? "", phone: k.phone ?? "", address: k.address ?? "", postal_code: k.postal_code ?? "",
        website: k.website ?? "", opening_hours: k.opening_hours === "[]" ? "" : (k.opening_hours ?? ""),
        description: k.about ?? "", ...over,
      };
    };

    assertEq(row().opening_hours, "[]", "setup: opening_hours is the schema default '[]'");

    // ── d: portal page never shows "[]" ─────────────────────────────────
    const page = await invoke(portal, makeReq({ method: "GET", route: "/eier/:agentId/portal", params: { agentId: ID }, token }));
    const html = String(page.body);
    const ohInput = (html.match(/<input id="field_opening_hours"[^>]*>/) || [""])[0];
    assertEq(page.status, 200, "d-01: portal page renders (200)");
    assertTrue(ohInput.includes('value=""'), "d-02: opening-hours input value is empty for stored '[]'");
    assertTrue(!ohInput.includes("[]"), "d-03: the raw [] is not rendered in the opening-hours input");

    // ── b: nothing changed → nothing touched ─────────────────────────────
    const before = row();
    const rb = await up(fullForm({ opening_hours: "" }));
    assertEq([rb.status, rb.body?.success, rb.body?.updated_fields, rb.body?.skipped_fields, rb.body?.audit_ids], [200, true, [], [], []], "b-01: untouched full save → 200, updated_fields [], no audit ids");
    assertEq(audits().length, 0, "b-02: zero audit rows");
    const afterB = row();
    assertEq(afterB.curated_fields, before.curated_fields, "b-03: curated_fields byte-identical");
    assertEq(afterB.updated_at, before.updated_at, "b-04: updated_at untouched (row not rewritten)");
    // c: stored '[]' + submitted '' → no lock, no audit, value unchanged.
    assertEq([afterB.opening_hours, JSON.parse(afterB.curated_fields).opening_hours], ["[]", undefined], "c-01: opening_hours stays '[]', no lock");
    const rc = await up({ opening_hours: "  " });
    assertEq([rc.body?.updated_fields, audits().length, row().curated_fields, row().opening_hours], [[], 0, before.curated_fields, "[]"], "c-02: whitespace-only opening_hours on '[]' → unchanged, no lock, no audit");
    const rc2 = await up({ opening_hours: "[]" });
    assertEq([rc2.body?.updated_fields, audits().length, row().curated_fields], [[], 0, before.curated_fields], "c-03: submitting '[]' on '[]' → unchanged");

    // ── e: whitespace / CRLF-only differences are unchanged ──────────────
    const re = await up(fullForm({ phone: "  +47 400 00 000  ", description: ABOUT.replace(/\n/g, "\r\n") + "\n", opening_hours: "" }));
    assertEq([re.body?.updated_fields, audits().length, row().curated_fields, row().phone, row().about], [[], 0, before.curated_fields, "+47 400 00 000", ABOUT], "e-01: padded phone + CRLF description → unchanged, nothing written");

    // ── a: one field changed in a full save ──────────────────────────────
    const ra = await up(fullForm({ phone: "+47 400 00 999", opening_hours: "" }));
    assertEq([ra.status, ra.body?.updated_fields, ra.body?.skipped_fields, (ra.body?.audit_ids || []).length], [200, ["phone"], [], 1], "a-01: only phone reported as updated, one audit id");
    assertEq(audits(), [{ field_name: "phone", old_value: "+47 400 00 000", new_value: "+47 400 00 999" }], "a-02: exactly one audit row, for phone");
    const cf = JSON.parse(row().curated_fields);
    assertEq(Object.keys(cf).sort(), ["address", "phone"], "a-03: exactly one new lock (phone); no lock for the six unchanged fields");
    assertEq(cf.phone?.by, "owner", "a-04: the new phone lock is by:owner");
    assertEq(cf.address, PRE_LOCK, "a-05: the pre-existing address lock is left exactly as it was");
    assertEq([row().phone, row().opening_hours, row().about], ["+47 400 00 999", "[]", ABOUT], "a-06: phone written; untouched fields not rewritten");

    // opening_hours changed to real hours → locked; then cleared → written, not re-locked.
    const ro = await up({ opening_hours: "Lør 10–14" });
    assertEq([ro.body?.updated_fields, JSON.parse(row().curated_fields).opening_hours?.by], [["opening_hours"], "owner"], "c-04: real opening hours → written and locked");
    const ohLock = JSON.parse(row().curated_fields).opening_hours;
    const ro2 = await up({ opening_hours: "" });
    assertEq([ro2.body?.updated_fields, row().opening_hours, JSON.parse(row().curated_fields).opening_hours], [["opening_hours"], "", ohLock], "c-05: cleared opening hours → written, no new lock (existing lock left as is)");
    const nAud = audits().length;
    const ro3 = await up({ opening_hours: "[]" });
    assertEq([ro3.body?.updated_fields, audits().length], [[], nAud], "c-06: '' stored + '[]' submitted → unchanged");

    // ── f: another party's lock still skips ──────────────────────────────
    const cfF = JSON.parse(row().curated_fields);
    cfF.website = { locked_at: "2026-09-02T10:00:00.000Z", by: "admin" };
    db.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?").run(JSON.stringify(cfF), ID);
    const cfBefore = row().curated_fields;
    const auditsBefore = audits().length;
    const rf = await up({ website: "https://annen.example.no" });
    assertEq([rf.body?.updated_fields, rf.body?.skipped_fields], [[], [{ field: "website", reason: "locked_by_admin" }]], "f-01: admin-locked website → skipped locked_by_admin");
    assertEq([row().website, row().curated_fields, audits().length], [`https://${ID}.example.no`, cfBefore, auditsBefore], "f-02: nothing written for the admin-locked field");

    // ── g: the no-JS fallback inherits the rule ──────────────────────────
    const auditsG = audits().length;
    const cfG = row().curated_fields;
    let forwarded: any = null;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      forwarded = JSON.parse(init.body);
      const r = await up(forwarded);
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    };
    const formBody: Record<string, string> = {};
    for (const [k, v] of Object.entries(fullForm())) formBody[`field_${k}`] = v;
    formBody.field_postal_code = "0151";
    const rg = await invoke(save, makeReq({ route: "/eier/:agentId/save", params: { agentId: ID }, body: formBody, token }));
    assertEq(rg.status, 303, "g-01: /eier/:id/save → 303");
    assertTrue(forwarded && Object.keys(forwarded).length === 7, "g-02: the fallback forwards all seven fields");
    const newAud = audits().slice(auditsG);
    assertEq(newAud.map((a) => a.field_name), ["postal_code"], "g-03: only postal_code audited");
    const cfAfterG = JSON.parse(row().curated_fields);
    const cfBeforeG = JSON.parse(cfG);
    assertEq(cfAfterG.postal_code?.by, "owner", "g-04: postal_code locked by owner");
    delete cfAfterG.postal_code;
    assertEq(cfAfterG, cfBeforeG, "g-05: every other curated_fields entry unchanged");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    (globalThis as any).fetch = prevFetch;
    if (prevGate === undefined) delete process.env[GATE_ENV]; else process.env[GATE_ENV] = prevGate;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerProfileLockChangedFieldsT3Tests({ log: true }).then((r) => {
    console.info(`owner-profile-lock-changed-fields-t3: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
