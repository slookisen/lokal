/**
 * owner-opening-hours-json-t0d.test.ts — slice T0d of the owner portal
 * (dev-request 2026-10-30-rfb-eierportal-bolge-0-ingen-tilgang).
 *
 * The portal's «Åpningstider» field stored the owner's text as it was typed
 * into agent_knowledge.opening_hours, a JSON column. The strict read of
 * knowledgeService.upsertKnowledge then threw on every non-owner write for
 * that profile, and lenient readers logged `[knowledge-guard]` and dropped
 * the hours. Now:
 *
 *   a  an owner save stores the text as JSON (JSON.stringify(text)); a later
 *      non-owner upsertKnowledge succeeds and still skips the owner-locked
 *      field (OWNER_LOCK_ENFORCE_WRITES on).
 *   b  re-saving the identical text (also padded, also through the no-JS
 *      /eier/:id/save form) writes nothing: no audit row, no new lock; the
 *      portal input shows the decoded text, not the JSON.
 *   c  a raw-text row from before T0d reads as text in strict and lenient
 *      mode, without a `[knowledge-guard]` line; a non-owner write succeeds;
 *      the portal shows it and an identical re-save is a no-op.
 *   d  lokal_info's «Åpningstider» section shows the text for both forms.
 *   e  the tolerance is opening_hours only: products that are not JSON still
 *      fail a write, as before.
 *
 * Real router + knowledge-service on the production schema in an in-memory
 * DB; handlers pulled off the router stack (same harness as
 * owner-profile-lock-changed-fields-t3.test.ts).
 * Exported runOwnerOpeningHoursJsonT0dTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/owner-opening-hours-json-t0d.test.ts
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
const LOCK_ENV = "OWNER_LOCK_ENFORCE_WRITES";
const NEW_ID = "t0d-new";
const RAW_ID = "t0d-raw";
const BAD_ID = "t0d-bad";
const HOURS = "Man–fre 10–17";
const RAW_HOURS = "Lørdag 10–14 (kun test)";

export async function runOwnerOpeningHoursJsonT0dTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevLock = process.env[LOCK_ENV];

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
  const prevError = console.error;
  const errorLog: string[] = [];
  console.log = () => { /* silence route logging */ };
  console.error = (...a: unknown[]) => { errorLog.push(a.map(String).join(" ")); };
  const prevFetch = (globalThis as any).fetch;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env[GATE_ENV];
    process.env[LOCK_ENV] = "1";
    try { delete require.cache[require.resolve("./owner-portal")]; } catch { /* not loaded yet */ }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { formatOpeningHoursForMcp } = require("./mcp") as typeof import("./mcp");

    const tokens: Record<string, string> = {};
    const seedAgent = (id: string, knowledge: Record<string, string>) => {
      const email = `post@${id}.example.no`;
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
         VALUES (?, ?, 'Testprodusent for T0d.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
      ).run(id, `T0d Gard ${id}`, email, `https://${id}.example.no`, `key-${id}`);
      const cols = ["agent_id", "email", "phone", "address", "about", "updated_at", "verification_status", "verified_second_line", ...Object.keys(knowledge)];
      const vals: unknown[] = [id, email, "+47 400 00 000", "Gardsveien 1", "Liten familiegård.", "2026-09-01T10:00:00.000Z", "verified", 0, ...Object.values(knowledge)];
      db.prepare(`INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
      const token = `tok-secret-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, email, token, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      tokens[id] = token;
    };
    seedAgent(NEW_ID, {});                                   // opening_hours → schema default '[]'
    seedAgent(RAW_ID, { opening_hours: RAW_HOURS });         // a row the portal wrote before T0d
    seedAgent(BAD_ID, { products: "Poteter 30 kr" });       // another column that is not JSON

    const UP = "/api/agents/:id/update-profile";
    const updateProfile = findRouteHandler(portalMod.default, UP, "post");
    const portal = findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get");
    const save = findRouteHandler(portalMod.default, "/eier/:agentId/save", "post");
    const row = (id: string) => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(id) as any;
    const audits = (id: string) => db.prepare("SELECT field_name, old_value, new_value FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid").all(id) as any[];
    const up = (id: string, body: Record<string, unknown>) => invoke(updateProfile, makeReq({ route: UP, params: { id }, body, token: tokens[id] }));
    const ohInput = async (id: string) => {
      const page = await invoke(portal, makeReq({ method: "GET", route: "/eier/:agentId/portal", params: { agentId: id }, token: tokens[id] }));
      return { status: page.status, input: (String(page.body).match(/<input id="field_opening_hours"[^>]*>/) || [""])[0] };
    };
    const guardLines = (since: number, id: string) => errorLog.slice(since).filter((l) => l.includes("[knowledge-guard]") && l.includes(id));
    // The no-JS fallback forwards to update-profile through fetch.
    (globalThis as any).fetch = async (url: string, init: any) => {
      const id = decodeURIComponent(String(url).split("/api/agents/")[1].split("/")[0]);
      const r = await up(id, JSON.parse(init.body));
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    };
    const formSave = async (id: string, fields: Record<string, string>) => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) body[`field_${k}`] = v;
      return invoke(save, makeReq({ route: "/eier/:agentId/save", params: { agentId: id }, body, token: tokens[id] }));
    };

    // ── a: owner save stores JSON; a non-owner write then succeeds ───────
    {
      const r = await up(NEW_ID, { opening_hours: HOURS });
      assertEq([r.status, r.body?.updated_fields], [200, ["opening_hours"]], "a-01: owner saves «Man–fre 10–17» → 200, opening_hours updated");
      const stored = row(NEW_ID).opening_hours;
      let parsed: unknown;
      try { parsed = JSON.parse(stored); } catch { parsed = Symbol("invalid"); }
      assertEq([stored, parsed], [JSON.stringify(HOURS), HOURS], "a-02: the stored value is valid JSON (the text as a JSON string)");
      assertEq(JSON.parse(row(NEW_ID).curated_fields).opening_hours?.by, "owner", "a-03: opening_hours locked by owner");
      assertEq(audits(NEW_ID), [{ field_name: "opening_hours", old_value: "[]", new_value: HOURS }], "a-04: one audit row carrying the text the owner wrote");

      const before = errorLog.length;
      let threw = "";
      let res: any = null;
      try {
        res = knowledgeService.upsertKnowledge(NEW_ID, { openingHours: [{ day: "mon", open: "09:00", close: "15:00" } as any], about: "Ny tekst fra beriking." });
      } catch (e: any) { threw = String(e?.message || e); }
      assertEq(threw, "", "a-05: a non-owner upsertKnowledge no longer throws");
      assertTrue(!!res && (res.skipped || []).some((s: any) => s.field === "opening_hours" && s.reason === "owner_locked"),
        `a-06: …and still skips the owner-locked opening_hours (got: ${JSON.stringify(res?.skipped)})`);
      assertEq([row(NEW_ID).opening_hours, row(NEW_ID).about], [JSON.stringify(HOURS), "Ny tekst fra beriking."],
        "a-07: the owner's hours are kept; the unlocked field is written");
      assertEq(knowledgeService.getAgentInfo(NEW_ID)!.knowledge.openingHours as unknown, HOURS, "a-08: getAgentInfo reads the owner's hours as text");
      assertEq(guardLines(before, NEW_ID), [], "a-09: no [knowledge-guard] line for it");
    }

    // ── b: identical re-save is a no-op; the portal shows the text ───────
    {
      const page = await ohInput(NEW_ID);
      assertEq(page.status, 200, "b-01: portal page renders (200)");
      assertTrue(page.input.includes(`value="${HOURS}"`) && !page.input.includes("&quot;"),
        `b-02: the opening-hours input shows the decoded text, not the JSON (got: ${page.input})`);
      const nAud = audits(NEW_ID).length;
      const cf = row(NEW_ID).curated_fields;
      const r1 = await up(NEW_ID, { opening_hours: HOURS });
      const r2 = await up(NEW_ID, { opening_hours: `  ${HOURS}\r\n` });
      assertEq([r1.body?.updated_fields, r2.body?.updated_fields, audits(NEW_ID).length, row(NEW_ID).curated_fields],
        [[], [], nAud, cf], "b-03: re-saving the identical (or padded) text → no write, no audit row, no new lock");
      const k = row(NEW_ID);
      const rf = await formSave(NEW_ID, {
        email: k.email, phone: k.phone, address: k.address, postal_code: k.postal_code ?? "", website: k.website ?? "",
        opening_hours: HOURS, description: k.about,
      });
      assertEq([rf.status, audits(NEW_ID).length, row(NEW_ID).curated_fields, row(NEW_ID).opening_hours],
        [303, nAud, cf, JSON.stringify(HOURS)], "b-04: the no-JS form save of the shown value is a no-op too");
      const r3 = await up(NEW_ID, { opening_hours: "Lør 10–14" });
      assertEq([r3.body?.updated_fields, row(NEW_ID).opening_hours, audits(NEW_ID).slice(nAud)],
        [["opening_hours"], JSON.stringify("Lør 10–14"), [{ field_name: "opening_hours", old_value: HOURS, new_value: "Lør 10–14" }]],
        "b-05: a real change is written as JSON, audited text → text");
      const r4 = await up(NEW_ID, { opening_hours: "" });
      assertEq([r4.body?.updated_fields, row(NEW_ID).opening_hours], [["opening_hours"], ""], "b-06: clearing still stores the empty value as before");
      assertTrue(!(await ohInput(NEW_ID)).input.includes("[]"), "b-07: empty hours are not shown as []");
    }

    // ── c: a raw-text row from before T0d ────────────────────────────────
    {
      const before = errorLog.length;
      const lenient = knowledgeService.getKnowledge(RAW_ID)!;
      assertEq(lenient.openingHours as unknown, RAW_HOURS, "c-01: lenient read returns the raw text");
      assertEq(knowledgeService.getAgentInfo(RAW_ID)!.knowledge.openingHours as unknown, RAW_HOURS, "c-02: getAgentInfo hands the text on");
      assertEq(guardLines(before, RAW_ID), [], "c-03: no [knowledge-guard] warning for a raw-text opening_hours");

      const page = await ohInput(RAW_ID);
      assertTrue(page.input.includes(`value="${RAW_HOURS}"`), `c-04: the portal shows the raw text (got: ${page.input})`);
      const nAud = audits(RAW_ID).length;
      const r = await up(RAW_ID, { opening_hours: RAW_HOURS });
      assertEq([r.body?.updated_fields, audits(RAW_ID).length, row(RAW_ID).opening_hours], [[], nAud, RAW_HOURS],
        "c-05: re-saving the same text on a raw row → no write, no audit row");

      // Strict read (the write path): no throw; the text survives the merge.
      let threw = "";
      try { knowledgeService.upsertKnowledge(RAW_ID, { about: "Beriket tekst." }); } catch (e: any) { threw = String(e?.message || e); }
      assertEq(threw, "", "c-06: strict read of a raw-text opening_hours does not throw (non-owner write succeeds)");
      const stored = row(RAW_ID).opening_hours;
      assertEq([JSON.parse(stored), row(RAW_ID).about], [RAW_HOURS, "Beriket tekst."], "c-07: the text is kept (now as JSON), the write landed");
      assertEq(guardLines(before, RAW_ID), [], "c-08: still no [knowledge-guard] line");
    }

    // ── d: lokal_info shows the text ─────────────────────────────────────
    {
      db.prepare("UPDATE agent_knowledge SET opening_hours = ? WHERE agent_id = ?").run(JSON.stringify(HOURS), NEW_ID);
      db.prepare("UPDATE agent_knowledge SET opening_hours = ? WHERE agent_id = ?").run(RAW_HOURS, RAW_ID);
      const jsonSection = formatOpeningHoursForMcp(knowledgeService.getAgentInfo(NEW_ID)!.knowledge.openingHours);
      const rawSection = formatOpeningHoursForMcp(knowledgeService.getAgentInfo(RAW_ID)!.knowledge.openingHours);
      assertEq(jsonSection, "\n## Åpningstider\nMan–Fre 10:00–17:00", "d-01: lokal_info «Åpningstider» shows the JSON-stored text");
      assertEq(rawSection, `\n## Åpningstider\n${RAW_HOURS}`, "d-02: lokal_info «Åpningstider» shows a raw-text row's text");
    }

    // ── e: the tolerance is opening_hours only ───────────────────────────
    {
      let threw = "";
      try { knowledgeService.upsertKnowledge(BAD_ID, { about: "Ny" }); } catch (e: any) { threw = String(e?.name); }
      assertEq([threw, row(BAD_ID).products, row(BAD_ID).about], ["SyntaxError", "Poteter 30 kr", "Liten familiegård."],
        "e-01: products that are not JSON still fail the strict write, nothing written");
      const before = errorLog.length;
      assertEq(knowledgeService.getKnowledge(BAD_ID)!.products, [], "e-02: lenient read of bad products is still empty");
      assertEq(guardLines(before, BAD_ID).length, 1, "e-03: …and still logged as [knowledge-guard]");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevError;
    (globalThis as any).fetch = prevFetch;
    if (prevGate === undefined) delete process.env[GATE_ENV]; else process.env[GATE_ENV] = prevGate;
    if (prevLock === undefined) delete process.env[LOCK_ENV]; else process.env[LOCK_ENV] = prevLock;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerOpeningHoursJsonT0dTests({ log: true }).then((r) => {
    console.info(`owner-opening-hours-json-t0d: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
