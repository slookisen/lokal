/**
 * admin-enrichment-write-pause.test.ts — the MECHANICAL fence behind the
 * per-vertical enrichment write-pause.
 *
 * dev-request 2026-08-20-enrichment-write-pause-mekanisk-gjerde (L3, P1).
 *
 * ── What this suite is actually proving ────────────────────────────────────
 * On 2026-08-20 `lokal-agent-enrichment` wrote to prod for a whole cycle while
 * an RFB enrichment write-pause was in force — 5 producers registered and ~8
 * agents enriched in violation, one of them outside the target list and given
 * a wrong website/phone. Second occurrence of the same failure class the same
 * day. The pause existed ONLY as prose in a SKILL file, so nothing could have
 * stopped it: no code read it.
 *
 * The claim under test is therefore not "the endpoint returns 423". It is:
 * while a vertical's pause is active, a write against ANY of the four RFB
 * enrichment write surfaces changes ZERO rows — proven with SQLite's own
 * `total_changes()` counter across each blocked call, not by reading a status
 * code and hoping.
 *
 * Covers:
 *   (A) the admin lever itself: auth, defaults, and the ASYMMETRY —
 *       enabling demands `reason`, CLEARING demands an explicit `cleared_by`
 *       and is REJECTED (400) without one, leaving the pause standing.
 *   (B) pause ACTIVE ⇒ all four surfaces answer 423 {paused:true, …} and
 *       total_changes() does not move by a single row.
 *   (C) per-vertical resolution: an RFB pause does not touch a dental agent,
 *       and a dental registration still goes through.
 *   (D) pause INACTIVE ⇒ all four surfaces behave exactly as before (writes
 *       land, response shapes unchanged) — the no-regression half.
 *   (E) FAIL-CLOSED: a DB lookup that throws inside the guard REJECTS the
 *       write. "Unknown" is never "open" — unknown = open is precisely how
 *       the incident happened.
 *   (F) blast radius: gårdssalg/booking's own already-mechanical gates are
 *       untouched, and the guard is imported by exactly the intended files.
 *
 * Harness mirrors admin-agents-register-contact.test.ts (real handlers pulled
 * straight off each router's stack, fake req/res, no HTTP, no socket) plus the
 * per-route DB seams admin-agents-url-write.ts / admin-agents-contact-email-
 * write.ts already export. The getDb() singleton IS swapped here (the
 * knowledge PUT and agents/register handlers resolve it directly and expose no
 * seam) and is restored in `finally`, same contract as
 * admin-agents-register-contact.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-enrichment-write-pause.test.ts
 *   2. Wired into the gate: tests/test.ts calls
 *      runAdminEnrichmentWritePauseTests() via runSerial().
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: any) => {
    r.body = b;
    return r;
  };
  return r;
}

/** Find a handler on an express router's internal stack. */
function handlerFor(router: any, method: string, routePath: string): any {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods && l.route.methods[method],
  );
  return layer ? layer.route.stack[0].handle : null;
}

export async function runAdminEnrichmentWritePauseTests(
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const { __setDbForTesting, __initSchemaForTesting, getDb } = initMod;

  const prevDb = (() => {
    try {
      return getDb();
    } catch {
      return undefined;
    }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevBrregFlag = process.env.BRREG_VERIFY_ON_REGISTER;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "admin-enrichment-write-pause-test-key";

  const ROUTE_MODULES = [
    "../routes/admin-enrichment-write-pause",
    "../routes/admin-agents-url-write",
    "../routes/admin-agents-contact-email-write",
    "../routes/admin-knowledge",
    "../routes/admin-agents",
  ];

  try {
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    // Keep the Brreg-verify slice of POST /register out of this suite entirely
    // — it is covered elsewhere and would only add network-shaped noise.
    delete process.env.BRREG_VERIFY_ON_REGISTER;

    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // ── The table must actually exist on the MAIN db ────────────────────────
    // Schema-vs-query discipline: every column the service SELECTs/INSERTs has
    // to be in the CREATE TABLE. Assert the real column set, not a guess.
    const cols = (testDb.prepare("PRAGMA table_info(enrichment_write_pause)").all() as Array<{
      name: string;
    }>).map((c) => c.name);
    assertEq(
      cols.slice().sort(),
      ["cleared_at", "cleared_by", "enabled", "reason", "triggered_at", "triggered_by", "vertical"],
      "ewp-00: enrichment_write_pause exists on the MAIN db with exactly the documented columns",
    );

    // ── Fresh route modules, all sharing this one in-memory DB ──────────────
    for (const m of ROUTE_MODULES) {
      try {
        delete require.cache[require.resolve(m)];
      } catch {
        /* ignore */
      }
    }
    const pauseMod = require("../routes/admin-enrichment-write-pause");
    const urlWriteMod = require("../routes/admin-agents-url-write");
    const emailWriteMod = require("../routes/admin-agents-contact-email-write");
    const knowledgeMod = require("../routes/admin-knowledge");
    const agentsMod = require("../routes/admin-agents");

    pauseMod.__setEnrichmentWritePauseDbForTesting(testDb as any);
    urlWriteMod.__setUrlWriteDbForTesting(testDb as any);
    emailWriteMod.__setContactEmailWriteDbForTesting(testDb as any);

    const pauseGet = handlerFor(pauseMod.default, "get", "/");
    const pausePost = handlerFor(pauseMod.default, "post", "/");
    const urlWritePost = handlerFor(urlWriteMod.default, "post", "/");
    const emailWritePost = handlerFor(emailWriteMod.default, "post", "/");
    const knowledgePut = handlerFor(knowledgeMod.default, "put", "/");
    const registerPost = handlerFor(agentsMod.default, "post", "/register");

    assertTrue(!!pauseGet && !!pausePost, "ewp-01: GET+POST /admin/enrichment-write-pause are registered");
    assertTrue(!!urlWritePost, "ewp-02: POST /admin/agents/url-write handler found");
    assertTrue(!!emailWritePost, "ewp-03: POST /admin/agents/contact-email-write handler found");
    assertTrue(!!knowledgePut, "ewp-04: PUT /admin/knowledge handler found");
    assertTrue(!!registerPost, "ewp-05: POST /admin/agents/register handler found");

    // ── Seed agents ────────────────────────────────────────────────────────
    const insertAgent = testDb.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
       VALUES (?, ?, 'test agent', 'test', ?, ?, 'producer', ?, ?, NULL)`,
    );
    insertAgent.run(
      "ewp-rfb",
      "Pause Gård AS",
      "gammel@example.no",
      "https://www.hanen.no/bedrift/999",
      "key-ewp-rfb",
      "rfb",
    );
    testDb.prepare(`INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, '{}')`).run("ewp-rfb");
    insertAgent.run(
      "ewp-dental",
      "Tannklinikk AS",
      "post@tann.no",
      "https://www.hanen.no/bedrift/1000",
      "key-ewp-dental",
      "dental",
    );
    testDb.prepare(`INSERT INTO agent_knowledge (agent_id, curated_fields) VALUES (?, '{}')`).run("ewp-dental");

    // ── Small helpers ──────────────────────────────────────────────────────
    function totalChanges(): number {
      return (testDb.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    }
    function urlOf(id: string): string | null {
      const r = testDb.prepare("SELECT url FROM agents WHERE id = ?").get(id) as { url: string } | undefined;
      return r ? r.url : null;
    }
    function emailOf(id: string): string | null {
      const r = testDb.prepare("SELECT contact_email FROM agents WHERE id = ?").get(id) as
        | { contact_email: string }
        | undefined;
      return r ? r.contact_email : null;
    }
    function aboutOf(id: string): string | null {
      const r = testDb.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get(id) as
        | { about: string | null }
        | undefined;
      return r ? r.about : null;
    }
    function agentCount(): number {
      return (testDb.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    }

    const AK = { "x-admin-key": ADMIN_KEY };
    async function call(handler: any, req: any): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: AK, query: {}, params: {}, body: {}, ...req } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // The four write attempts, each one a REAL change against a live row (or a
    // real net-new registration) — so "nothing happened" can only mean the
    // gate stopped it, never that there was nothing to do.
    const urlWriteReq = {
      body: {
        apply: true,
        items: [{ agent_id: "ewp-rfb", url: "https://www.pausegard.no", reason: "homepage_verified_live" }],
      },
    };
    const emailWriteReq = {
      body: {
        apply: true,
        items: [{ agent_id: "ewp-rfb", email: "ny@pausegard.no", reason: "contact_verified" }],
      },
    };
    const knowledgeReq = { body: { agent_id: "ewp-rfb", about: "Ny beskrivelse fra berikelse." } };
    let registerSeq = 0;
    function registerReq(vertical: string) {
      registerSeq++;
      return {
        body: {
          name: `Ny Produsent ${registerSeq}`,
          url: `https://www.nyprodusent${registerSeq}.no`,
          city: "Oslo",
          vertical_id: vertical,
        },
      };
    }

    // ══ (A) The admin lever itself ═════════════════════════════════════════
    let r = await call(pauseGet, { headers: {} });
    assertEq(r.status, 403, "ewp-10: GET without X-Admin-Key -> 403");
    r = await call(pausePost, { headers: { "x-admin-key": "feil" }, body: { enabled: true, reason: "x" } });
    assertEq(r.status, 403, "ewp-11: POST with wrong X-Admin-Key -> 403");

    r = await call(pauseGet, {});
    assertEq(r.status, 200, "ewp-12: GET defaults to vertical=rfb");
    assertEq(r.body?.status?.vertical, "rfb", "ewp-13: GET default vertical is rfb");
    assertEq(r.body?.status?.enabled, false, "ewp-14: no row => not paused");
    assertEq(r.body?.status?.is_default, true, "ewp-15: no row => is_default true (no seed migration needed)");

    r = await call(pauseGet, { query: { vertical: "finnesikke" } });
    assertEq(r.status, 400, "ewp-16: unknown vertical on GET is a 400, never a silent 'not paused'");

    r = await call(pausePost, { body: { vertical: "rfb", enabled: true } });
    assertEq(r.status, 400, "ewp-17: enabling without a reason -> 400");
    assertEq(r.body?.code, "reason_required", "ewp-18: … with code reason_required");

    r = await call(pausePost, { body: { vertical: "rfb", enabled: "ja", reason: "x" } });
    assertEq(r.status, 400, "ewp-19: non-boolean `enabled` -> 400");

    r = await call(pausePost, { body: { vertical: "finnesikke", enabled: true, reason: "x" } });
    assertEq(r.status, 400, "ewp-20: unknown vertical on POST -> 400 (never pause the wrong vertical on a typo)");

    // ── PR review finding 4: an ABSENT/EMPTY vertical on POST is a 400 too ──
    // Same stance as ewp-20, applied to the case that used to slip through:
    // the route defaulted a missing vertical to 'rfb', so a CLEAR that never
    // named RFB could lift the live RFB pause. GET keeps its default (ewp-12) —
    // it is a read. Nothing may be written on any of these.
    r = await call(pausePost, { body: { enabled: true, reason: "x" } });
    assertEq(r.status, 400, "ewp-20a: MISSING vertical on POST -> 400, never a silent default to rfb");
    r = await call(pausePost, { body: { vertical: "", enabled: true, reason: "x" } });
    assertEq(r.status, 400, "ewp-20b: EMPTY-string vertical on POST -> 400");
    r = await call(pausePost, { body: { vertical: "   ", enabled: true, reason: "x" } });
    assertEq(r.status, 400, "ewp-20c: whitespace-only vertical on POST -> 400 (same path as empty)");
    // The dangerous one: a CLEAR with cleared_by but no vertical must NOT lift
    // rfb. Nothing is paused yet here, so prove it by the absence of any row.
    r = await call(pausePost, { body: { enabled: false, cleared_by: "daniel" } });
    assertEq(r.status, 400, "ewp-20d: a CLEAR with no vertical -> 400 (it must never resolve to rfb)");
    assertEq(
      (testDb.prepare("SELECT COUNT(*) AS n FROM enrichment_write_pause").get() as { n: number }).n,
      0,
      "ewp-20e: … and none of the rejected POSTs wrote a single row",
    );
    r = await call(pauseGet, {});
    assertEq(r.body?.status?.is_default, true, "ewp-20f: … rfb still has no row at all");

    const PAUSE_REASON = "verifier: feil website/telefon skrevet under pause";
    r = await call(pausePost, {
      body: { vertical: "rfb", enabled: true, reason: PAUSE_REASON, triggered_by: "platform-verifier" },
    });
    assertEq(r.status, 200, "ewp-21: enabling with a reason succeeds");
    assertEq(r.body?.status?.enabled, true, "ewp-22: … pause is on");
    assertEq(r.body?.status?.reason, PAUSE_REASON, "ewp-23: … reason stored verbatim");
    assertEq(r.body?.status?.triggered_by, "platform-verifier", "ewp-24: … triggered_by recorded");
    assertTrue(typeof r.body?.status?.triggered_at === "string", "ewp-25: … triggered_at stamped");
    assertEq(r.body?.status?.cleared_at, null, "ewp-26: … cleared_at reset by a fresh pause");

    r = await call(pauseGet, { query: { vertical: "rfb" } });
    assertEq(r.body?.status?.enabled, true, "ewp-27: GET reads the pause back on the very next call (no process cache)");
    assertEq(r.body?.status?.is_default, false, "ewp-28: … and no longer reports is_default");

    r = await call(pauseGet, { query: { vertical: "dental" } });
    assertEq(r.body?.status?.enabled, false, "ewp-29: pausing rfb leaves dental untouched");

    // THE asymmetry: a clear without cleared_by is rejected and the pause STANDS.
    r = await call(pausePost, { body: { vertical: "rfb", enabled: false } });
    assertEq(r.status, 400, "ewp-30: clearing without cleared_by -> 400");
    assertEq(r.body?.code, "cleared_by_required", "ewp-31: … with code cleared_by_required");
    r = await call(pausePost, { body: { vertical: "rfb", enabled: false, cleared_by: "   " } });
    assertEq(r.status, 400, "ewp-32: a whitespace-only cleared_by is not an attribution -> 400");
    r = await call(pauseGet, { query: { vertical: "rfb" } });
    assertEq(r.body?.status?.enabled, true, "ewp-33: a rejected clear leaves the pause STANDING");

    // ══ (B) Pause ACTIVE ⇒ four surfaces, 423, zero rows changed ═══════════
    const urlBefore = urlOf("ewp-rfb");
    const emailBefore = emailOf("ewp-rfb");
    const aboutBefore = aboutOf("ewp-rfb");
    const agentsBefore = agentCount();
    const changesBefore = totalChanges();

    r = await call(urlWritePost, urlWriteReq);
    assertEq(r.status, 423, "ewp-40: paused url-write -> 423");
    assertEq(r.body?.paused, true, "ewp-41: … paused:true");
    assertEq(r.body?.vertical, "rfb", "ewp-42: … vertical resolved from agents.vertical_id");
    assertEq(r.body?.reason, PAUSE_REASON, "ewp-43: … the stored reason is surfaced");
    assertTrue(typeof r.body?.triggered_at === "string", "ewp-44: … triggered_at surfaced");
    assertEq(r.body?.fail_closed, false, "ewp-45: … flagged as a real pause, not a lookup failure");

    r = await call(emailWritePost, emailWriteReq);
    assertEq(r.status, 423, "ewp-46: paused contact-email-write -> 423");
    assertEq(r.body?.paused, true, "ewp-47: … paused:true");

    r = await call(knowledgePut, knowledgeReq);
    assertEq(r.status, 423, "ewp-48: paused PUT /admin/knowledge -> 423");
    assertEq(r.body?.paused, true, "ewp-49: … paused:true");

    r = await call(registerPost, registerReq("rfb"));
    assertEq(r.status, 423, "ewp-50: paused POST /admin/agents/register -> 423");
    assertEq(r.body?.paused, true, "ewp-51: … paused:true");

    // The claim that actually matters.
    assertEq(
      totalChanges() - changesBefore,
      0,
      "ewp-52: FOUR blocked write attempts changed ZERO rows (SQLite total_changes())",
    );
    assertEq(urlOf("ewp-rfb"), urlBefore, "ewp-53: agents.url untouched");
    assertEq(emailOf("ewp-rfb"), emailBefore, "ewp-54: agents.contact_email untouched");
    assertEq(aboutOf("ewp-rfb"), aboutBefore, "ewp-55: agent_knowledge.about untouched");
    assertEq(agentCount(), agentsBefore, "ewp-56: no net-new agent registered");
    assertEq(
      (testDb.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as { n: number }).n,
      0,
      "ewp-57: no audit row written either — the gate runs before everything",
    );

    // A dry-run is still blocked: the gate is about the SURFACE, not the mode.
    r = await call(urlWritePost, {
      body: { items: [{ agent_id: "ewp-rfb", url: "https://www.pausegard.no", reason: "r" }] },
    });
    assertEq(r.status, 423, "ewp-58: even a dry-run against a paused surface is refused");

    // A malformed body is ALSO 423, not 400 — the gate precedes validation, so
    // a paused caller can never learn its payload was fine.
    r = await call(urlWritePost, { body: { items: [] } });
    assertEq(r.status, 423, "ewp-59: the gate runs BEFORE payload validation (empty items -> 423, not 400)");

    // ══ (C) Per-vertical resolution ════════════════════════════════════════
    const dentalUrlBefore = urlOf("ewp-dental");
    r = await call(urlWritePost, {
      body: {
        apply: true,
        items: [{ agent_id: "ewp-dental", url: "https://www.tannklinikken.no", reason: "homepage_verified_live" }],
      },
    });
    assertEq(r.status, 200, "ewp-60: an RFB pause does NOT block a dental agent");
    assertEq(urlOf("ewp-dental"), "https://www.tannklinikken.no", "ewp-61: … and the dental write actually landed");
    assertTrue(dentalUrlBefore !== urlOf("ewp-dental"), "ewp-62: … it was a real change, not a no-op");

    r = await call(registerPost, registerReq("dental"));
    assertEq(r.status, 201, "ewp-63: an RFB pause does NOT block a dental registration");

    // A batch spanning BOTH verticals is blocked whole — zero partial writes.
    const spanChanges = totalChanges();
    r = await call(urlWritePost, {
      body: {
        apply: true,
        items: [
          { agent_id: "ewp-dental", url: "https://www.tannklinikken.no/ny", reason: "r" },
          { agent_id: "ewp-rfb", url: "https://www.pausegard.no", reason: "r" },
        ],
      },
    });
    assertEq(r.status, 423, "ewp-64: a batch spanning a paused vertical is blocked whole");
    assertEq(totalChanges() - spanChanges, 0, "ewp-65: … including the un-paused item — ZERO partial writes");

    // ══ (E) FAIL-CLOSED ════════════════════════════════════════════════════
    // (run while the pause is still on so a lookup failure cannot be confused
    //  with the ordinary allowed path, then again below with it off)
    const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
    const throwingDb: any = {
      prepare() {
        throw new Error("simulated DB failure inside the guard");
      },
    };
    let g = svc.assertEnrichmentWriteAllowed(throwingDb, "rfb");
    assertEq(g.allowed, false, "ewp-70: a throwing lookup => NOT allowed (fail-closed)");
    assertEq((g as any).fail_closed, true, "ewp-71: … flagged fail_closed so an operator can tell it apart");
    g = svc.assertEnrichmentWriteAllowedForAgents(throwingDb, ["ewp-rfb"]);
    assertEq(g.allowed, false, "ewp-72: the batch guard fails closed on a throwing agents lookup too");
    assertEq((g as any).fail_closed, true, "ewp-73: … also flagged fail_closed");

    // ══ (D) Pause INACTIVE ⇒ no regression ═════════════════════════════════
    r = await call(pausePost, { body: { vertical: "rfb", enabled: false, cleared_by: "daniel" } });
    assertEq(r.status, 200, "ewp-80: clearing WITH cleared_by succeeds");
    assertEq(r.body?.status?.enabled, false, "ewp-81: … pause is off");
    assertEq(r.body?.status?.cleared_by, "daniel", "ewp-82: … cleared_by recorded");
    assertTrue(typeof r.body?.status?.cleared_at === "string", "ewp-83: … cleared_at stamped");
    assertEq(r.body?.status?.reason, PAUSE_REASON, "ewp-84: … and the ORIGINAL reason survives the lift (audit trail)");
    assertTrue(typeof r.body?.status?.triggered_at === "string", "ewp-85: … as does triggered_at");

    r = await call(urlWritePost, urlWriteReq);
    assertEq(r.status, 200, "ewp-86: unpaused url-write -> 200 as before");
    assertEq(r.body?.success, true, "ewp-87: … usual response shape (success)");
    assertEq(r.body?.dry_run, false, "ewp-88: … usual response shape (dry_run)");
    assertEq(r.body?.counts?.written, 1, "ewp-89: … and it wrote");
    assertEq(urlOf("ewp-rfb"), "https://www.pausegard.no", "ewp-90: agents.url actually changed");

    r = await call(emailWritePost, emailWriteReq);
    assertEq(r.status, 200, "ewp-91: unpaused contact-email-write -> 200 as before");
    assertEq(r.body?.counts?.written, 1, "ewp-92: … and it wrote");
    assertEq(emailOf("ewp-rfb"), "ny@pausegard.no", "ewp-93: agents.contact_email actually changed");

    r = await call(knowledgePut, knowledgeReq);
    assertEq(r.status, 200, "ewp-94: unpaused PUT /admin/knowledge -> 200 as before");
    assertEq(r.body?.success, true, "ewp-95: … usual response shape");
    assertEq(aboutOf("ewp-rfb"), "Ny beskrivelse fra berikelse.", "ewp-96: agent_knowledge.about actually changed");

    const beforeRegisterCount = agentCount();
    r = await call(registerPost, registerReq("rfb"));
    assertEq(r.status, 201, "ewp-97: unpaused POST /admin/agents/register -> 201 as before");
    assertEq(agentCount(), beforeRegisterCount + 1, "ewp-98: … and the agent was actually created");

    // Empty items on url-write is a 400 again once the pause is off — proof
    // the 423 above really was the gate, not a changed validation path.
    r = await call(urlWritePost, { body: { items: [] } });
    assertEq(r.status, 400, "ewp-99: with no pause, an empty items[] is a 400 exactly as before");

    // Route-level fail-closed: point a surface's DB seam at a throwing handle
    // while NO pause is set. Nothing is paused, yet the write must still be
    // refused — "the lookup could not answer" must never read as "go ahead".
    const changesBeforeTrap = totalChanges();
    urlWriteMod.__setUrlWriteDbForTesting(throwingDb);
    r = await call(urlWritePost, urlWriteReq);
    urlWriteMod.__setUrlWriteDbForTesting(testDb as any);
    assertEq(r.status, 423, "ewp-100: a throwing DB inside the guard REJECTS the write, even with no pause set");
    assertEq(r.body?.fail_closed, true, "ewp-101: … and says so");
    assertEq(totalChanges() - changesBeforeTrap, 0, "ewp-102: … having changed zero rows");

    __setDbForTesting(throwingDb);
    r = await call(knowledgePut, knowledgeReq);
    assertEq(r.status, 423, "ewp-103: PUT /admin/knowledge fails closed on a throwing lookup too");
    r = await call(registerPost, registerReq("rfb"));
    assertEq(r.status, 423, "ewp-104: POST /admin/agents/register fails closed on a throwing lookup too");
    __setDbForTesting(testDb as any);
    assertEq(agentCount(), beforeRegisterCount + 1, "ewp-105: … and no agent slipped through while failing closed");

    // Re-pausing after a clear wipes the stale cleared_* stamps.
    r = await call(pausePost, { body: { vertical: "rfb", enabled: true, reason: "ny pause" } });
    assertEq(r.body?.status?.cleared_by, null, "ewp-106: a new pause clears the stale cleared_by");
    assertEq(r.body?.status?.cleared_at, null, "ewp-107: … and the stale cleared_at");
    assertEq(r.body?.status?.triggered_by, "admin", "ewp-108: triggered_by falls back to the actor when unstated");
    r = await call(pausePost, { body: { vertical: "rfb", enabled: false, cleared_by: "daniel" } });
    assertEq(r.body?.status?.enabled, false, "ewp-109: cleared again for the remaining assertions");

    // ══ (F) Blast radius ═══════════════════════════════════════════════════
    // Pure helpers of the guard, exercised directly.
    assertEq(svc.normalizeEnrichmentVertical("  DENTAL "), "dental", "ewp-110: vertical normalisation trims + lowercases");
    assertEq(
      svc.normalizeEnrichmentVertical("tulle"),
      "rfb",
      "ewp-111: an UNKNOWN vertical collapses to 'rfb' — it must never be an escape hatch past a live pause",
    );
    assertEq(svc.normalizeEnrichmentVertical(undefined), "rfb", "ewp-112: a missing vertical matches the column default");
    assertEq(svc.isEnrichmentVertical("dental"), true, "ewp-113: isEnrichmentVertical accepts an exact match");
    assertEq(svc.isEnrichmentVertical("DENTAL"), false, "ewp-114: … and does not coerce (the admin surface stays strict)");
    assertEq(
      svc.resolveVerticalsForAgents(testDb as any, ["ewp-dental"]).slice().sort(),
      ["dental"],
      "ewp-115: vertical resolved from agents.vertical_id",
    );
    assertEq(
      svc.resolveVerticalsForAgents(testDb as any, ["finnes-ikke"]).slice().sort(),
      ["rfb"],
      "ewp-116: an unknown agent id resolves to the column default rather than skipping the gate",
    );
    assertEq(
      svc.resolveVerticalsForAgents(testDb as any, []).slice().sort(),
      ["rfb"],
      "ewp-117: an empty id list still resolves to a vertical (a request naming no agent is still a write surface)",
    );

    // gårdssalg/booking's own already-mechanical gates are NOT touched by this
    // dev-request. Assert the classifier still behaves, and that neither the
    // opplevelser route nor the experiences schema has learned about this guard.
    const sizeGate = require("../services/gardssalg-outreach-size-gate") as typeof import("../services/gardssalg-outreach-size-gate");
    assertEq(sizeGate.computeGardssalgSizeFlag(30, 25), "stor", "ewp-120: gårdssalg size gate unchanged (stor)");
    assertEq(sizeGate.computeGardssalgSizeFlag(3, 25), "liten", "ewp-121: gårdssalg size gate unchanged (liten)");
    assertEq(sizeGate.computeGardssalgSizeFlag(null, 25), "ukjent", "ewp-122: gårdssalg size gate unchanged (ukjent)");

    const srcDir = path.resolve(__dirname, "..");
    function readSrc(rel: string): string {
      return fs.readFileSync(path.join(srcDir, rel), "utf8");
    }
    // dev-request 2026-09-02-experiences-skrivepause-catalog-hidden-og-
    // rapportspraak, del 1: opplevelser.ts NOW imports this guard — through
    // ONE shared helper (experiencesWritePauseBlock → enrichmentWritePauseBlock
    // with the getRfbDb THUNK, vertical 'experiences') on every apply:true
    // admin write route. This assertion used to pin the opposite ("neither
    // imports nor calls"); it now pins the shape the wiring must keep: the
    // route file never calls the lower-level assert* entry points directly
    // and always goes through the thunk + 'experiences' helper. The per-route
    // behaviour is proven in opplevelser-write-pause-gate.test.ts.
    const opplevelserSrc = readSrc("routes/opplevelser.ts");
    assertTrue(
      opplevelserSrc.includes("services/enrichment-write-pause") &&
        opplevelserSrc.includes('enrichmentWritePauseBlock(getRfbDb, "experiences")') &&
        !opplevelserSrc.includes("assertEnrichmentWriteAllowed"),
      "ewp-123: opplevelser.ts imports the guard through the one shared experiences helper (getRfbDb thunk + 'experiences'), never the raw assert* entry points",
    );
    assertTrue(
      !readSrc("database/init-experiences.ts").includes("enrichment_write_pause"),
      "ewp-124: the experiences DB schema is untouched — this table lives on the MAIN db only",
    );

    // The guard must be reachable from exactly the intended files, so a review
    // can see the blast radius without re-reading the whole tree.
    const importers: string[] = [];
    for (const dir of ["routes", "services"]) {
      for (const f of fs.readdirSync(path.join(srcDir, dir))) {
        if (!f.endsWith(".ts")) continue;
        const rel = `${dir}/${f}`;
        if (rel === "services/enrichment-write-pause.ts") continue;
        // Two spellings of the same import: routes/ reach it as
        // "../services/enrichment-write-pause", a sibling in services/ as
        // "./enrichment-write-pause". Matching only the first silently missed
        // services/marketplace-registry.ts — i.e. the invariant would not have
        // noticed the guard appearing on a shared primitive at all.
        const src = readSrc(rel);
        if (src.includes("services/enrichment-write-pause") || src.includes('"./enrichment-write-pause"')) {
          importers.push(rel);
        }
      }
    }
    assertEq(
      importers.slice().sort(),
      [
        // The four original handler surfaces.
        "routes/admin-agents-contact-email-write.ts",
        "routes/admin-agents-url-write.ts",
        "routes/admin-agents.ts",
        "routes/admin-knowledge.ts",
        // Its own admin route + the two test files.
        "routes/admin-enrichment-write-pause.test.ts",
        "routes/admin-enrichment-write-pause.ts",
        "routes/enrichment-write-pause-shared-primitives.test.ts",
        // PR review finding 1 — the surfaces `lokal-agent-enrichment` ACTUALLY
        // calls, and the shared write primitives behind them. marketplace.ts
        // carries three (admin/register, homepage-provenance-batch,
        // google-rating-batch) plus the public /register that inherits from
        // the registry primitive; admin-rfb-website-discovery.ts carries the
        // review-approve lever and applyRfbAgentWebsite itself;
        // marketplace-registry.ts is register(), the one INSERT into `agents`.
        "routes/admin-rfb-brreg-selfsufficiency.ts",
        "routes/admin-rfb-website-discovery.ts",
        "routes/marketplace.ts",
        "services/marketplace-registry.ts",
        // dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding,
        // round-2 review finding 3: the description-code-artifact sweep route
        // writes producer content (agents.description) the same as the
        // url-write sibling, and is now wired to the same gate the same way
        // — plus its own test file, which sets up pause state directly via
        // the service to prove the wiring.
        "routes/admin-agents-description-code-artifact-sweep.test.ts",
        "routes/admin-agents-description-code-artifact-sweep.ts",
        // dev-request 2026-09-02-experiences-skrivepause-catalog-hidden-og-
        // rapportspraak, del 1: the experiences vertical's admin write routes
        // (routes/opplevelser.ts, one shared helper) plus their own test file.
        "routes/opplevelser-write-pause-gate.test.ts",
        "routes/opplevelser.ts",
      ].sort(),
      "ewp-125: the guard is imported by exactly the gated surfaces, the shared write primitives, its own admin route, and the test files",
    );

    // No YAML anywhere near this guard: controller/enrichment-write-pause.yaml
    // lives in slookisen/A2A and is NEVER in this app's container image, so a
    // process that read it would pass in dev and silently no-op in prod.
    const svcSrc = readSrc("services/enrichment-write-pause.ts");
    assertTrue(
      !/require\(["']js-yaml|from ["']js-yaml|readFileSync|\.yaml["']/.test(svcSrc),
      "ewp-126: the guard reads no YAML and no file — DB-backed only (it would no-op in the prod image otherwise)",
    );
  } catch (err) {
    failed++;
    failures.push(
      `admin-enrichment-write-pause: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevBrregFlag === undefined) delete process.env.BRREG_VERIFY_ON_REGISTER;
    else process.env.BRREG_VERIFY_ON_REGISTER = prevBrregFlag;
    // Release every DB seam this suite pinned BEFORE the handle is closed.
    for (const [mod, setter] of [
      ["../routes/admin-enrichment-write-pause", "__setEnrichmentWritePauseDbForTesting"],
      ["../routes/admin-agents-url-write", "__setUrlWriteDbForTesting"],
      ["../routes/admin-agents-contact-email-write", "__setContactEmailWriteDbForTesting"],
    ] as const) {
      try {
        require(mod)[setter](null);
      } catch {
        /* ignore */
      }
    }
    if (prevDb) __setDbForTesting(prevDb);
    for (const m of ROUTE_MODULES) {
      try {
        delete require.cache[require.resolve(m)];
      } catch {
        /* ignore */
      }
    }
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-enrichment-write-pause.test.ts`
if (require.main === module) {
  console.log("── admin-enrichment-write-pause (mekanisk gjerde for berikelses-skrivepause) unit tests ──");
  runAdminEnrichmentWritePauseTests({ log: true }).then((r) => {
    console.log(`\nadmin-enrichment-write-pause: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
