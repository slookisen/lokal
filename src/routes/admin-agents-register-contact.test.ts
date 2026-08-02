/**
 * admin-agents-register-contact.test.ts — unit/integration tests for the
 * contact-field write path added to POST /admin/agents/register (src/routes/
 * admin-agents.ts), dev-request 2026-07-28-discovery-registrering-mangler-
 * kontaktfelt-endepunkt.
 *
 * Background: lokal-agent-discovery's Step 4 has always described saving
 * `email`/`phone` (only at HIGH confidence, per its own strict evidence
 * policy) with provenance at registration time, but the only registration
 * endpoint (a) required org_nr + source (this agent's candidates aren't
 * always Norwegian companies), (b) accepted no `email` field at all, (c)
 * wrote a hardcoded placeholder contact_email regardless of input, and (d)
 * silently discarded any `phone` sent to it. This suite proves the fix:
 * the SAME endpoint now accepts optional org_nr/source, optional email/
 * phone, persists a real (non-placeholder) contact_email when an email is
 * given, and writes agent_knowledge.email/.phone + field_provenance using
 * this codebase's established provenance shape (mergeFieldProvenance —
 * the SAME merge function every other admin write path here uses).
 *
 * Harness mirrors admin-agents.test.ts (POST /register brreg-verify wiring)
 * exactly: fresh in-memory SQLite via __setDbForTesting/__initSchemaForTesting
 * (real production schema), the router re-required fresh, the POST
 * "/register" handler grabbed directly off the router's internal stack and
 * invoked with fake req/res (no HTTP server/socket, no shared-env races with
 * the ~40 other independent blocks tests/test.ts runs).
 *
 * "Live GET" acceptance criterion (dev-request criterion 1: "verifiable via
 * a live GET"): this suite also grabs the two REAL, unmodified GET handlers
 * a caller would actually use to verify a registration —
 *   - GET /api/marketplace/agents/:id/knowledge (src/routes/marketplace.ts)
 *     for email/phone
 *   - GET /api/marketplace/admin/knowledge/:agentId/field-provenance
 *     (src/routes/marketplace.ts) for provenance
 * — off the marketplace router's own stack and invokes them directly,
 * exactly the same "grab the handler, no socket" idiom
 * marketplace-agent-provenance.test.ts already established. This is the
 * same in-process invocation idiom every other suite in this file uses to
 * prove a real route surfaces real data, without needing an actual prod
 * deploy.
 *
 * Covers:
 *   (a) email persisted to agents.contact_email (non-placeholder) AND
 *       agent_knowledge.email, both readable via the live GET handlers.
 *   (b) registration with NO contact info at all succeeds (201), empty
 *       contact fields, no agent_knowledge row forced into existence.
 *   (c) org_nr is NOT required — a candidate with no org_nr registers fine,
 *       org_nr column stays NULL, no "org_nr:" tag written.
 *   (d) field_provenance written correctly for BOTH phone and email, with
 *       source_type taken from the request's `source` field.
 *   (e) regression: existing org_nr dedup + Brreg-verify paths (case1-style,
 *       org_nr+source both present) are untouched.
 *   (f) invalid email format is rejected (400), never silently stored.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents-register-contact.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminAgentsRegisterContactTests() via runSerial().
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminAgentsRegisterContactTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevBrregFlag = process.env.BRREG_VERIFY_ON_REGISTER;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "admin-agents-register-contact-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    // Never exercise the Brreg-verify slice in this suite — it's covered by
    // admin-agents.test.ts and isn't the point here; keep it off so a
    // missing org_nr/flag interaction can't add noise.
    delete process.env.BRREG_VERIFY_ON_REGISTER;

    // ── Grab POST /register off admin-agents.ts's router ────────────────
    const registerRoutePath = require.resolve("../routes/admin-agents");
    delete require.cache[registerRoutePath];
    const adminAgentsRouter = require("../routes/admin-agents").default;
    const registerLayer = adminAgentsRouter.stack.find(
      (l: any) => l.route && l.route.path === "/register" && l.route.methods && l.route.methods.post,
    );
    assertTrue(!!registerLayer, "setup: POST /register handler is registered on the router");
    const registerHandler = registerLayer.route.stack[0].handle;

    // ── Grab the two REAL live-GET handlers off marketplace.ts's router ──
    const marketplaceRoutePath = require.resolve("../routes/marketplace");
    delete require.cache[marketplaceRoutePath];
    const marketplaceRouter = require("../routes/marketplace").default;
    const knowledgeGetLayer = marketplaceRouter.stack.find(
      (l: any) => l.route && l.route.path === "/agents/:id/knowledge" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!knowledgeGetLayer, "setup: GET /agents/:id/knowledge handler is registered");
    const knowledgeGetHandler = knowledgeGetLayer.route.stack[0].handle;

    const provenanceGetLayer = marketplaceRouter.stack.find(
      (l: any) =>
        l.route &&
        l.route.path === "/admin/knowledge/:agentId/field-provenance" &&
        l.route.methods &&
        l.route.methods.get,
    );
    assertTrue(!!provenanceGetLayer, "setup: GET /admin/knowledge/:agentId/field-provenance handler is registered");
    const provenanceGetHandler = provenanceGetLayer.route.stack[0].handle;

    async function callRegister(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const res = fakeRes();
      await registerHandler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    async function liveGetKnowledge(agentId: string): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const res = fakeRes();
      await knowledgeGetHandler(
        { params: { id: agentId }, headers: { "x-admin-key": ADMIN_KEY } } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    async function liveGetProvenance(agentId: string): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const res = fakeRes();
      await provenanceGetHandler(
        { params: { agentId }, headers: { "x-admin-key": ADMIN_KEY } } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    function readAgentRow(id: string): { contact_email: string; org_nr: string | null; tags: string } | undefined {
      return testDb
        .prepare("SELECT contact_email, org_nr, tags FROM agents WHERE id = ?")
        .get(id) as any;
    }

    function agentKnowledgeRowExists(id: string): boolean {
      return !!testDb.prepare("SELECT 1 FROM agent_knowledge WHERE agent_id = ?").get(id);
    }

    // ── Case A: HIGH-confidence email → non-placeholder contact_email,
    //    readable via the live GET, plus provenance ──────────────────────
    {
      const r = await callRegister({
        name: "Gårdsysteriet Kontakt A",
        url: "https://gardsysteriet-a.no",
        city: "Voss",
        vertical_id: "rfb",
        source: "lokal-agent-discovery",
        email: "post@gardsysteriet-a.no",
        phone: "91234567",
      });
      assertEq(r.status, 201, "caseA: registers (201) with email+phone, no org_nr");
      const agentId = r.body?.agent_id as string;
      assertTrue(typeof agentId === "string" && agentId.length > 0, "caseA: agent_id returned");

      const row = readAgentRow(agentId);
      assertEq(row?.contact_email, "post@gardsysteriet-a.no", "caseA: agents.contact_email is the REAL email, not the placeholder");
      assertEq(r.body?.contact_email, "post@gardsysteriet-a.no", "caseA: response echoes the real contact_email");

      // Live GET #1: /agents/:id/knowledge — email/phone surfaced for real.
      const kg = await liveGetKnowledge(agentId);
      assertEq(kg.status, 200, "caseA: live GET /agents/:id/knowledge -> 200");
      assertEq(kg.body?.data?.email, "post@gardsysteriet-a.no", "caseA: live GET returns persisted email");
      assertEq(kg.body?.data?.phone, "91234567", "caseA: live GET returns persisted phone");

      // Live GET #2: field-provenance — both fields carry a real record.
      const pv = await liveGetProvenance(agentId);
      assertEq(pv.status, 200, "caseA: live GET field-provenance -> 200");
      const emailProv = pv.body?.field_provenance?.email;
      const phoneProv = pv.body?.field_provenance?.phone;
      assertTrue(Array.isArray(emailProv) && emailProv.length === 1, "caseA: field_provenance.email is a 1-element array");
      assertEq(emailProv?.[0]?.value, "post@gardsysteriet-a.no", "caseA: provenance email value matches");
      assertEq(emailProv?.[0]?.source_type, "lokal-agent-discovery", "caseA: provenance email source_type = request's `source`");
      assertTrue(typeof emailProv?.[0]?.fetched_at === "string" && emailProv[0].fetched_at.length > 0, "caseA: provenance email fetched_at stamped");
      assertTrue(Array.isArray(phoneProv) && phoneProv.length === 1, "caseA: field_provenance.phone is a 1-element array");
      assertEq(phoneProv?.[0]?.value, "91234567", "caseA: provenance phone value matches");
      assertEq(phoneProv?.[0]?.source_type, "lokal-agent-discovery", "caseA: provenance phone source_type = request's `source`");
    }

    // ── Case B: no contact info at all → succeeds, empty contact fields,
    //    no forced agent_knowledge row ───────────────────────────────────
    {
      const r = await callRegister({
        name: "Ukjent Kontakt Gård B",
        url: "https://ukjent-kontakt-b.no",
        city: "Namsos",
        vertical_id: "rfb",
      });
      assertEq(r.status, 201, "caseB: registers (201) with zero contact info and zero org_nr/source");
      const agentId = r.body?.agent_id as string;
      const row = readAgentRow(agentId);
      assertEq(row?.contact_email, "kontakt@rettfrabonden.com", "caseB: contact_email falls back to the placeholder (unchanged old behavior)");
      assertEq(row?.org_nr, null, "caseB: org_nr stays NULL — never required");
      assertTrue(!String(row?.tags ?? "").includes("org_nr:"), "caseB: no org_nr: tag written when org_nr absent");
      assertTrue(!String(row?.tags ?? "").includes("source:"), "caseB: no source: tag written when source absent");
      assertEq(agentKnowledgeRowExists(agentId), false, "caseB: no agent_knowledge row created when no contact info given (never crashes, never fabricates a row)");

      const kg = await liveGetKnowledge(agentId);
      assertEq(kg.status, 404, "caseB: live GET /agents/:id/knowledge -> 404 (no knowledge row, correctly not fabricated)");
    }

    // ── Case C: org_nr present but no email/phone — org_nr dedup tag still
    //    written, no agent_knowledge row forced ──────────────────────────
    {
      const r = await callRegister({
        name: "Gård Med Orgnr C",
        url: "https://gard-med-orgnr-c.no",
        city: "Kristiansand",
        vertical_id: "rfb",
        org_nr: "920000001",
        source: "brreg-nace-discovery",
      });
      assertEq(r.status, 201, "caseC: registers (201) with org_nr+source, no contact info");
      const agentId = r.body?.agent_id as string;
      const row = readAgentRow(agentId);
      assertEq(row?.org_nr, "920000001", "caseC: org_nr column written when supplied");
      assertTrue(String(row?.tags ?? "").includes('"org_nr:920000001"'), "caseC: org_nr: tag still written when org_nr supplied (regression guard)");
      assertTrue(String(row?.tags ?? "").includes('"source:brreg-nace-discovery"'), "caseC: source: tag still written when source supplied (regression guard)");
    }

    // ── Case D: org_nr dedup still fires (regression: brreg-nace-discovery's
    //    own usage of this endpoint is untouched) ────────────────────────
    {
      const dupOrgNr = "920000002";
      const first = await callRegister({
        name: "Duplikat Gård Ett",
        url: "https://duplikat-gard-1.no",
        city: "Bodø",
        vertical_id: "rfb",
        org_nr: dupOrgNr,
        source: "brreg-nace-discovery",
      });
      assertEq(first.status, 201, "caseD: first registration with org_nr succeeds");

      const second = await callRegister({
        name: "Duplikat Gård To (Annet Navn)",
        url: "https://duplikat-gard-2.no",
        city: "Bodø",
        vertical_id: "rfb",
        org_nr: dupOrgNr,
        source: "brreg-nace-discovery",
      });
      assertEq(second.status, 200, "caseD: second registration with the SAME org_nr -> 200 (dedup path, not an error)");
      assertEq(second.body?.duplicate, true, "caseD: org_nr dedup still fires (regression guard)");
      assertEq(second.body?.existing_id, first.body?.agent_id, "caseD: dedup points at the first agent's id");
    }

    // ── Case E: name+city dedup still fires regardless of org_nr presence ─
    {
      const first = await callRegister({
        name: "Navn By Dedup E",
        url: "https://navn-by-dedup-e-1.no",
        city: "Drammen",
        vertical_id: "rfb",
      });
      assertEq(first.status, 201, "caseE: first registration (no org_nr) succeeds");

      const second = await callRegister({
        name: "Navn By Dedup E",
        url: "https://navn-by-dedup-e-2.no",
        city: "drammen", // case-insensitive match
        vertical_id: "rfb",
      });
      assertEq(second.status, 200, "caseE: second registration with same name+city -> 200 (dedup path)");
      assertEq(second.body?.duplicate, true, "caseE: name+city dedup still fires with no org_nr in play (regression guard)");
    }

    // ── Case F: invalid email format is rejected, never silently stored ──
    {
      const r = await callRegister({
        name: "Ugyldig Epost Gård F",
        url: "https://ugyldig-epost-f.no",
        city: "Tromsø",
        vertical_id: "rfb",
        email: "not-an-email",
      });
      assertEq(r.status, 400, "caseF: malformed email -> 400, not silently stored");
      assertTrue(!!r.body?.error, "caseF: 400 response carries an error message");
    }

    // ── Case G: only phone given (no email) — phone still persists +
    //    provenance, contact_email stays the placeholder ─────────────────
    {
      const r = await callRegister({
        name: "Kun Telefon Gård G",
        url: "https://kun-telefon-g.no",
        city: "Ålesund",
        vertical_id: "rfb",
        source: "lokal-agent-discovery",
        phone: "92345678",
      });
      assertEq(r.status, 201, "caseG: registers (201) with phone only");
      const agentId = r.body?.agent_id as string;
      const row = readAgentRow(agentId);
      assertEq(row?.contact_email, "kontakt@rettfrabonden.com", "caseG: contact_email stays the placeholder when no email given, even though phone was");

      const pv = await liveGetProvenance(agentId);
      const emailProv = pv.body?.field_provenance?.email;
      const phoneProv = pv.body?.field_provenance?.phone;
      assertTrue(emailProv === undefined, "caseG: no email provenance record fabricated when email wasn't given");
      assertTrue(Array.isArray(phoneProv) && phoneProv.length === 1, "caseG: phone provenance written even though email wasn't given");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-agents-register-contact: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevBrregFlag === undefined) delete process.env.BRREG_VERIFY_ON_REGISTER; else process.env.BRREG_VERIFY_ON_REGISTER = prevBrregFlag;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("../routes/marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-register-contact.test.ts`
if (require.main === module) {
  console.log("── admin-agents-register-contact (POST /admin/agents/register contact-field write path) unit tests ──");
  runAdminAgentsRegisterContactTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-register-contact: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
