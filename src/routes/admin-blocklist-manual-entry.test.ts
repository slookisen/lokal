/**
 * admin-blocklist-manual-entry.test.ts — tests the generic
 * { identifier_type, identifier_value, reason? } shape added to
 * POST /admin/blocklist (dev-request 2026-07-15-admin-blocklist-manual-entry-api,
 * slookisen/A2A).
 *
 * Incident context: an outreach email went to norskott@online.no (wrong
 * entity — mixed-up producer data). The filer tried POST /admin/blocklist and
 * hit a 404 — but that was because they hit the bare, un-mounted path; the
 * real route (mounted under /api/marketplace) already existed and already
 * accepted a named-field body ({name?, website?, email?, agentId?, reason}).
 * That legacy shape would already have handled the incident's actual need
 * (an orphaned email with no agent to key off). The one genuine gap: no
 * guard stopped a website_domain entry from being a free-mail/ISP host
 * (gmail.com etc, PROTECTED_DOMAINS in blocklist-service.ts) or vipps.no,
 * either of which would over-suppress a huge, unrelated population of
 * producers. This file tests the new generic shape end-to-end (the route),
 * the domain guard, that the legacy shape is untouched, and that a manual
 * entry is actually seen by isBlocked() (the mechanism GET
 * /admin/outreach-candidates already relies on to suppress candidates — so
 * proving isBlocked() sees the row is sufficient evidence that acceptance
 * criterion 6 is satisfied without exercising that route directly here).
 *
 * Mirrors admin-outreach-candidates-gate-integrity.test.ts: synchronous route
 * exercise via router.handle(), real init.ts schema, wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import { add as blocklistAddDirect, isBlocked } from "../services/blocklist-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { method?: string; url: string; body?: any; headers?: Record<string, string> },
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method || "GET",
    url: opts.url,
    query: {},
    headers,
    body: opts.body,
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
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminBlocklistManualEntryTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-blocklist-manual-entry-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  try {
    const router = require("./marketplace").default;

    function countRows(identifierType: string, identifierValue: string): number {
      return (
        db
          .prepare("SELECT COUNT(*) AS n FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?")
          .get(identifierType, identifierValue) as { n: number }
      ).n;
    }

    // ── 1. Valid email entry → 201, appears in GET list ─────────────────
    const resEmail = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "email", identifier_value: "norskott@online.no", reason: "wrong entity — mixed-up producer data" },
    });
    assertEq(resEmail.status, 201, "generic shape: valid email entry -> 201");
    assertEq(resEmail.body?.success, true, "generic shape: valid email entry -> success:true");
    assertEq(resEmail.body?.identifier_type, "email", "generic shape: response echoes identifier_type");
    assertEq(resEmail.body?.identifier_value, "norskott@online.no", "generic shape: response echoes normalized identifier_value");
    assertEq(typeof resEmail.body?.id, "number", "generic shape: response includes numeric id");
    assertEq(typeof resEmail.body?.created_at, "string", "generic shape: response includes created_at");

    const resList = callRouteSync(router, { method: "GET", url: "/admin/blocklist", headers: { "x-admin-key": testKey } });
    assertEq(resList.status, 200, "GET /admin/blocklist -> 200");
    const listedEmail = (resList.body?.rows || []).find((r: any) => r.identifier_value === "norskott@online.no");
    assertEq(!!listedEmail, true, "generic shape: inserted email entry appears in GET /admin/blocklist list");

    // ── 2. Same request twice -> second call 200 (not 201), no duplicate row ──
    const resEmailAgain = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "email", identifier_value: "norskott@online.no", reason: "wrong entity — mixed-up producer data" },
    });
    assertEq(resEmailAgain.status, 200, "generic shape: repeat POST of same identifier -> 200 (idempotent, not 201)");
    assertEq(countRows("email", "norskott@online.no"), 1, "generic shape: repeat POST does not create a duplicate row");

    // ── 3. website_domain guard: gmail.com and online.no -> 400 ─────────
    const resGmail = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "website_domain", identifier_value: "gmail.com", reason: "test" },
    });
    assertEq(resGmail.status, 400, "domain guard: website_domain=gmail.com -> 400");
    assertEq(countRows("website_domain", "gmail.com"), 0, "domain guard: gmail.com never inserted");

    const resOnlineNo = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "website_domain", identifier_value: "online.no", reason: "test" },
    });
    assertEq(resOnlineNo.status, 400, "domain guard: website_domain=online.no -> 400");

    const resVipps = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "website_domain", identifier_value: "vipps.no", reason: "test" },
    });
    assertEq(resVipps.status, 400, "domain guard: website_domain=vipps.no -> 400");
    assertEq(countRows("website_domain", "vipps.no"), 0, "domain guard: vipps.no never inserted");

    // A non-protected domain must still work normally.
    const resRealDomain = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "website_domain", identifier_value: "some-bad-actor.no", reason: "test" },
    });
    assertEq(resRealDomain.status, 201, "domain guard: a real (non-protected) domain still inserts -> 201");

    // ── 4. Missing identifier_type / identifier_value -> 400 ────────────
    const resMissingType = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_value: "someone@example.no" },
    });
    assertEq(resMissingType.status, 400, "generic shape: missing identifier_type -> 400");

    const resMissingValue = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "email" },
    });
    assertEq(resMissingValue.status, 400, "generic shape: missing identifier_value -> 400");

    // ── 5. Missing/wrong X-Admin-Key -> 403 (kept convention, not 401) ───
    const resNoKey = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      body: { identifier_type: "email", identifier_value: "someone-else@example.no", reason: "test" },
    });
    assertEq(resNoKey.status, 403, "auth: no X-Admin-Key -> 403 (not 401)");

    const resWrongKey = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": "totally-wrong-key" },
      body: { identifier_type: "email", identifier_value: "someone-else@example.no", reason: "test" },
    });
    assertEq(resWrongKey.status, 403, "auth: wrong X-Admin-Key -> 403 (not 401)");

    // ── 6. agent_id and name_normalized insert + retrieve correctly ─────
    const resAgentId = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "agent_id", identifier_value: "  BadAgent-123  ", reason: "test" },
    });
    assertEq(resAgentId.status, 201, "generic shape: agent_id entry -> 201");
    assertEq(resAgentId.body?.identifier_value, "badagent-123", "generic shape: agent_id normalized (trim+lowercase)");
    assertEq(countRows("agent_id", "badagent-123"), 1, "generic shape: agent_id row retrievable");

    const resName = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "name_normalized", identifier_value: "Øvre-Eide Gård", reason: "test" },
    });
    assertEq(resName.status, 201, "generic shape: name_normalized entry -> 201");
    assertEq(resName.body?.identifier_value, "ovre eide gard", "generic shape: name_normalized uses existing normalizeName()");
    assertEq(countRows("name_normalized", "ovre eide gard"), 1, "generic shape: name_normalized row retrievable");

    // ── 7. Legacy named-field shape still works, completely unchanged ───
    const resLegacy = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: {
        name: "Legacy Test Gård",
        website: "https://legacy-test-gard.no",
        email: "post@legacy-test-gard.no",
        agentId: "legacy-agent-1",
        reason: "opt-out via outreach reply",
        sourceEmail: "post@legacy-test-gard.no",
      },
    });
    assertEq(resLegacy.status, 201, "legacy shape: named-field POST still -> 201");
    assertEq(resLegacy.body?.success, true, "legacy shape: response has success:true");
    assertEq(resLegacy.body?.inserted, 4, "legacy shape: inserts all 4 identifiers unchanged");
    assertEq(Array.isArray(resLegacy.body?.rows) && resLegacy.body.rows.length === 4, true, "legacy shape: returns all 4 rows unchanged");

    // ── 8. Manual entry is seen by isBlocked() (criterion-6 mechanism) ───
    const blockCheck = isBlocked({ email: "norskott@online.no" });
    assertEq(blockCheck.blocked, true, "isBlocked(): sees the manually-inserted email row (outreach-candidates suppression mechanism)");
    assertEq(blockCheck.matchedBy, "email", "isBlocked(): reports matchedBy='email' for the manual entry");

    // ── 9. org_nr (Skive D, dev-request 2026-08-17-cs-plattformparitet-og-
    //    verifisert-utfoerelse) — generic shape, whitespace normalized. ─────
    const resOrgNr = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: { identifier_type: "org_nr", identifier_value: " 977 777 777 ", reason: "test" },
    });
    assertEq(resOrgNr.status, 201, "generic shape: org_nr entry -> 201");
    assertEq(resOrgNr.body?.identifier_type, "org_nr", "generic shape: response echoes identifier_type=org_nr");
    assertEq(resOrgNr.body?.identifier_value, "977777777", "generic shape: org_nr normalized (whitespace stripped)");
    assertEq(countRows("org_nr", "977777777"), 1, "generic shape: org_nr row retrievable");
    const blockCheckOrgNr = isBlocked({ orgNr: "977 777 777" });
    assertEq(blockCheckOrgNr.blocked, true, "isBlocked(): sees the manually-inserted org_nr row regardless of whitespace");
    assertEq(blockCheckOrgNr.matchedBy, "org_nr", "isBlocked(): reports matchedBy='org_nr'");

    // ── 10. orgNr on the legacy named-field shape (the write side of the
    //    "fjern oss" removal path — Skive D). ────────────────────────────
    const resLegacyOrgNr = callRouteSync(router, {
      method: "POST",
      url: "/admin/blocklist",
      headers: { "x-admin-key": testKey },
      body: {
        website: "https://legacy-orgnr-gard.no",
        orgNr: "988111222",
        reason: "customer-opt-out (opplevagent)",
      },
    });
    assertEq(resLegacyOrgNr.status, 201, "legacy shape: orgNr field accepted -> 201");
    assertEq(resLegacyOrgNr.body?.inserted, 2, "legacy shape: inserts both website_domain and org_nr");
    assertEq(countRows("org_nr", "988111222"), 1, "legacy shape: org_nr row written via the named-field shape");

    // ── 11. linked_org_nr disambiguation (dev-request 2026-09-03-rfb-
    //    korrigering-navn-sted-kategorier, Mål 3). Incident: deleting
    //    "Moland Gård — Telemark" auto-blocklisted the name, which would
    //    also wrongly block a DIFFERENT, real "Moland Gård" (different
    //    org.nr) re-registering under the exact same name string. A
    //    name_normalized row recorded against a KNOWN org.nr must not
    //    block a candidate we can affirmatively show is a different
    //    org.nr — but must stay conservative (still block) whenever we
    //    can't disambiguate. Fresh/unique names per case for isolation. ──

    // (a) add(name, orgNr=111111111) → isBlocked(same name, orgNr=222222222)
    //     is NOT blocked (different org.nr, same name).
    blocklistAddDirect({ name: "Moland Gård", orgNr: "111111111", reason: "test: Mål 3 disambiguation" });
    const molandDifferentOrgNr = isBlocked({ name: "Moland Gård", orgNr: "222222222" });
    assertEq(molandDifferentOrgNr.blocked, false, "linked_org_nr: different org.nr, same name -> NOT blocked");

    // (b) same setup, isBlocked(same name, orgNr=111111111) -> still blocked
    //     (same org.nr). Note: add({name, orgNr}) also inserts a plain
    //     identifier_type='org_nr' row (unrelated to Mål 3), and isBlocked()'s
    //     checks loop tries org_nr before name_normalized, so this
    //     particular case matches via matchedBy='org_nr' rather than ever
    //     reaching the name_normalized/linked_org_nr comparison — still a
    //     correct "still blocked" per acceptance criterion (b).
    const molandSameOrgNr = isBlocked({ name: "Moland Gård", orgNr: "111111111" });
    assertEq(molandSameOrgNr.blocked, true, "linked_org_nr: same org.nr, same name -> still blocked");

    // (c) same setup, isBlocked(same name, no orgNr given at all) -> still
    //     blocked (conservative default — can't disambiguate without an
    //     incoming org.nr).
    const molandNoOrgNr = isBlocked({ name: "Moland Gård" });
    assertEq(molandNoOrgNr.blocked, true, "linked_org_nr: no orgNr given -> conservative default, still blocked");

    // (d) regression guard: add(name="X", NO orgNr) then isBlocked(name="X",
    //     orgNr=999999999) -> still blocked (no linked_org_nr was ever
    //     recorded, so no disambiguation is possible — must stay blocked,
    //     exactly like today).
    blocklistAddDirect({ name: "Blokkert Gård Uten Orgnr", reason: "test: Mål 3 regression guard" });
    const noLinkRegression = isBlocked({ name: "Blokkert Gård Uten Orgnr", orgNr: "999999999" });
    assertEq(noLinkRegression.blocked, true, "linked_org_nr: no linked_org_nr recorded -> still blocked regardless of incoming orgNr");

    // (e) regression guard: a LATER, UNRELATED add() call for a DIFFERENT
    //     org.nr that happens to reuse an EXISTING name_normalized row's
    //     exact string must not retroactively stamp that pre-existing row's
    //     linked_org_nr. Reviewer-found bug: the linked_org_nr UPDATE in
    //     add() matched on identifier_value alone, table-wide, so it fired
    //     even when the name_normalized row's own INSERT OR IGNORE was a
    //     no-op against a pre-existing row from an earlier, different add()
    //     call — silently narrowing an existing conservative (no-org-nr)
    //     block. Fresh name string ("Solvang Gård") so this doesn't collide
    //     with cases (a)-(d) above.
    blocklistAddDirect({ name: "Solvang Gård", reason: "name-only block, no org.nr known" });
    const solvangBeforeUnrelatedAdd = isBlocked({ name: "Solvang Gård", orgNr: "999999999" });
    assertEq(solvangBeforeUnrelatedAdd.blocked, true, "linked_org_nr regression: name-only block with no org.nr -> conservative default, blocked");

    // Second, unrelated add() call: same name string, but a DIFFERENT
    // org.nr, from what should be treated as an unrelated event (e.g. a
    // different company's own opt-out that happens to share the exact name
    // string). Because the name_normalized row already exists, this is a
    // no-op INSERT OR IGNORE for that row.
    blocklistAddDirect({ name: "Solvang Gård", orgNr: "222222222", reason: "unrelated later call, same name string" });
    const solvangAfterUnrelatedAdd = isBlocked({ name: "Solvang Gård", orgNr: "999999999" });
    assertEq(solvangAfterUnrelatedAdd.blocked, true, "linked_org_nr regression: unrelated later add() with a different org.nr must NOT weaken the pre-existing name-only block");
  } catch (err) {
    failed++;
    failures.push(`admin-blocklist-manual-entry: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runAdminBlocklistManualEntryTests({ log: true });
  console.log(`\nadmin-blocklist-manual-entry: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
