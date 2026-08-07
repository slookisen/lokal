/**
 * admin-rfb-contact-extraction.test.ts — tests for
 * dev-requests/2026-08-07-rfb-contact-extraction.md: POST
 * /admin/rfb-contact-extraction extracts a corroborated contact email from a
 * producer's OWN website and writes it to `agents.contact_email` for RFB
 * producer rows whose contact_email is blank OR DNS-flagged-dead
 * (field_provenance.contact_email_dns_check.live === false). Reuses
 * extractGardssalgContactEmail (services/experience-store.ts, pure) for
 * extraction and rfbWebsiteHostExclusionReason (admin-rfb-website-
 * discovery.ts, now exported) for the aggregator/social-media host guard.
 * Phone is explicitly out of scope. Write path mirrors
 * admin-agents-contact-email-write.ts: curated_fields lock, claimed_at
 * row-lock, isPlatformOwnedEmailDomain / isSyntacticallyValidEmail write-bar,
 * one agent_knowledge_audit row per write with changed_by='system' (the
 * table's CHECK(changed_by IN ('owner','admin','system')) constraint would
 * otherwise reject any other spelling — cx-o below regression-guards this).
 *
 * Covers (src/routes/admin-rfb-contact-extraction.ts):
 *   (a) 403 without X-Admin-Key.
 *   (b) mailto-hit on the front page: dry-run reports 'written' with the
 *       mailto address and source, and writes NOTHING to the DB.
 *   (c) apply on the same row actually UPDATEs agents.contact_email and
 *       inserts exactly one agent_knowledge_audit row.
 *   (d) same-domain text hit (no mailto) on the front page.
 *   (e) freemail hit found ONLY on a discovered /kontakt subpage — the front
 *       page itself carries no matching address, so the contact-ish subpage
 *       is what makes this resolvable at all (source_url points at the
 *       subpage, not the front page).
 *   (f) no candidate address anywhere -> 'no_contact_found'.
 *   (g) extracted address is a platform-owned domain -> rejected, never
 *       written, original value untouched.
 *   (h) extracted address fails the stricter isSyntacticallyValidEmail
 *       check (a double-dot domain the looser extractor regex still
 *       accepts) -> 'rejected_invalid_syntax', never written.
 *   (i) curated_fields locks the field -> 'skippedCurated', and — since the
 *       lock is checked BEFORE any fetch — the host is never fetched at all.
 *   (j) claimed_at row-lock -> 'skippedLocked', also never fetched.
 *   (k) an aggregator/directory host (RFB_WD_DIRECTORY_HOSTS) is excluded
 *       BEFORE any fetch -> 'host_excluded', host never fetched.
 *   (l) batch-size cap: more than RFB_CX_HARD_CAP agentIds -> 400.
 *   (m) concurrent call while a run is in progress -> 409 run_in_progress;
 *       the first call still completes 200, and the lock is released after.
 *   (n) DNS-flagged-dead cohort: a row with a REAL (non-blank) contact_email
 *       but field_provenance.contact_email_dns_check.live=false is still
 *       auto-selected and its (dead) address gets REPLACED on apply.
 *   (o) regression guard: the agent_knowledge_audit row this route writes
 *       always carries changed_by='system' (never a custom string) — the
 *       hard CHECK constraint in src/database/init.ts would otherwise reject
 *       the insert outright.
 *
 * globalThis.fetch is mocked directly, keyed on exact URL (same convention
 * as admin-rfb-website-discovery.test.ts). This file is intentionally NOT
 * wired into tests/test.ts (outside this slice's touched-files list — see
 * the dev-request) — same standalone-suite convention as its closest
 * sibling, admin-rfb-website-discovery.test.ts.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-rfb-contact-extraction.test.ts
 *   2. Not wired into `npm test` (tests/test.ts) — see note above.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, writableEnded: false, destroyed: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function htmlResponse(html: string, opts: { status?: number; finalUrl?: string } = {}) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: opts.finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    url: undefined,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

export async function runAdminRfbContactExtractionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-cx-test-key";

  const fixtures: Map<string, Response> = new Map();
  const fetchCalls: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const urlStr = String(url);
      fetchCalls.push(urlStr);
      const fx = fixtures.get(urlStr);
      return fx ?? notFoundResponse();
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    globalThis.fetch = stubFetch();

    const routePath = require.resolve("../routes/admin-rfb-contact-extraction");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-rfb-contact-extraction") as
      typeof import("../routes/admin-rfb-contact-extraction");
    const routerModule = routeModule.default;
    const { RFB_CX_HARD_CAP, __setRfbCxRowDelayForTesting, __resetRfbCxCooldownForTesting, RFB_WD_DIRECTORY_HOSTS } = routeModule;

    __setRfbCxRowDelayForTesting(0);
    __resetRfbCxCooldownForTesting();

    function getHandler(method: "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postExtraction = getHandler("post", "/rfb-contact-extraction");

    async function callExtraction(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      const req = { headers, body, query: {} } as any;
      await postExtraction(req, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string;
      name: string;
      contactEmail?: string;
      orgNr?: string | null;
      claimedAt?: string | null;
      website: string;
      fieldProvenance?: string | null;
      curatedFields?: string | null;
      role?: string;
      verticalId?: string | null;
      createdAt?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, vertical_id, claimed_at, created_at
         ) VALUES (?, ?, 't', 't', ?, 'https://example.com', ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.name, o.contactEmail ?? "", o.role ?? "producer", `key-${o.id}`,
        o.orgNr ?? null, o.verticalId ?? "rfb", o.claimedAt ?? null,
        o.createdAt ?? "2026-01-01 00:00:00",
      );
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, field_provenance, curated_fields, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website, o.fieldProvenance ?? "{}", o.curatedFields ?? "{}", new Date().toISOString(),
      );
    }

    function contactEmailOf(id: string): string {
      const row = testDb.prepare("SELECT contact_email FROM agents WHERE id = ?").get(id) as { contact_email: string };
      return row.contact_email;
    }
    function auditRowsFor(id: string): any[] {
      return testDb.prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at").all(id);
    }
    const deadDnsProvenance = (domain: string) =>
      JSON.stringify({ contact_email_dns_check: { checked_at: "2026-08-01T00:00:00.000Z", domain, live: false, method: "none", batch_id: "x" } });

    // ── (a) auth ──────────────────────────────────────────────────────────
    {
      const r = await callExtraction({}, {});
      assertEq(r.status, 403, "a1: POST without X-Admin-Key -> 403");
    }

    // ── (b) mailto-hit: dry-run writes nothing ──────────────────────────────
    {
      insertAgent({ id: "cx-mailto", name: "Fjelldal Gard", website: "https://fjelldal.no" });
      fixtures.set(
        "https://fjelldal.no",
        htmlResponse('<html><body>Velkommen. <a href="mailto:kontakt@fjelldal.no">Kontakt oss</a></body></html>', { finalUrl: "https://fjelldal.no" }),
      );

      const r = await callExtraction({ agentIds: ["cx-mailto"] });
      assertEq(r.status, 200, "b1: 200");
      assertEq(r.body.dry_run, true, "b2: dry-run by default");
      const item = r.body.results.find((x: any) => x.agent_id === "cx-mailto");
      assertTrue(!!item, "b3: result present for cx-mailto");
      assertEq(item.outcome, "written", "b4: outcome is 'written' (would-write in dry-run)");
      assertEq(item.email, "kontakt@fjelldal.no", "b5: extracted the mailto address");
      assertEq(item.email_source, "mailto", "b6: source is mailto");
      assertEq(contactEmailOf("cx-mailto"), "", "b7: dry-run wrote NOTHING to the DB");
      assertEq(auditRowsFor("cx-mailto").length, 0, "b8: dry-run wrote no audit row");
    }

    // ── (c) apply actually writes + exactly one audit row ───────────────────
    {
      const r = await callExtraction({ agentIds: ["cx-mailto"], apply: true });
      assertEq(r.status, 200, "c1: 200");
      assertEq(r.body.dry_run, false, "c2: apply turns off dry-run");
      const item = r.body.results.find((x: any) => x.agent_id === "cx-mailto");
      assertEq(item.outcome, "written", "c3: outcome written");
      assertEq(contactEmailOf("cx-mailto"), "kontakt@fjelldal.no", "c4: agents.contact_email actually updated");
      const audit = auditRowsFor("cx-mailto");
      assertEq(audit.length, 1, "c5: exactly one audit row");
      assertEq(audit[0].field_name, "contact_email", "c6: audit names the right column");
      assertEq(audit[0].old_value, "", "c7: audit preserves the old (blank) value");
      assertEq(audit[0].new_value, "kontakt@fjelldal.no", "c8: audit records the new value");
      assertTrue(String(audit[0].notes || "").includes("https://fjelldal.no"), "c9: audit notes carry the source URL");
      assertTrue(String(audit[0].notes || "").startsWith("rfb-contact-extraction "), "c9b: notes carry the route's identifying prefix");
    }

    // ── (d) same-domain text hit (no mailto) on the front page ──────────────
    {
      insertAgent({ id: "cx-samedomain", name: "Solvang Gard", website: "https://solvanggard.no" });
      fixtures.set(
        "https://solvanggard.no",
        htmlResponse("<html><body>Skriv til oss: post@solvanggard.no for bestilling</body></html>", { finalUrl: "https://solvanggard.no" }),
      );

      const r = await callExtraction({ agentIds: ["cx-samedomain"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-samedomain");
      assertEq(item.outcome, "written", "d1: outcome written");
      assertEq(item.email, "post@solvanggard.no", "d2: same-domain text address extracted");
      assertEq(item.email_source, "text_same_domain", "d3: source is text_same_domain");
      assertEq(contactEmailOf("cx-samedomain"), "post@solvanggard.no", "d4: written to the DB");
    }

    // ── (e) freemail hit found ONLY on a discovered /kontakt subpage ────────
    {
      insertAgent({ id: "cx-freemail", name: "Utsikten Gard", website: "https://utsiktengard.no" });
      fixtures.set(
        "https://utsiktengard.no",
        htmlResponse('<html><body>Velkommen til Utsikten Gard <a href="/kontakt">Kontakt oss</a></body></html>', { finalUrl: "https://utsiktengard.no" }),
      );
      fixtures.set(
        "https://utsiktengard.no/kontakt",
        htmlResponse("<html><body>Kontakt: gardsbutikk@gmail.com eller stikk innom</body></html>", { finalUrl: "https://utsiktengard.no/kontakt" }),
      );

      const r = await callExtraction({ agentIds: ["cx-freemail"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-freemail");
      assertEq(item.outcome, "written", "e1: outcome written");
      assertEq(item.email, "gardsbutikk@gmail.com", "e2: freemail address found on the contact subpage");
      assertEq(item.email_source, "text_contact_page", "e3: source is text_contact_page");
      assertEq(item.source_url, "https://utsiktengard.no/kontakt", "e4: source_url points at the SUBPAGE, not the front page");
      assertEq(contactEmailOf("cx-freemail"), "gardsbutikk@gmail.com", "e5: written to the DB");
    }

    // ── (f) no contact found anywhere ────────────────────────────────────────
    {
      insertAgent({ id: "cx-none", name: "Stille Gard", website: "https://stillegard.no" });
      fixtures.set("https://stillegard.no", htmlResponse("<html><body>Ingen kontaktinfo her, dessverre.</body></html>", { finalUrl: "https://stillegard.no" }));

      const r = await callExtraction({ agentIds: ["cx-none"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-none");
      assertEq(item.outcome, "no_contact_found", "f1: no_contact_found");
      assertEq(contactEmailOf("cx-none"), "", "f2: nothing written");
    }

    // ── (g) platform-owned-domain rejection ──────────────────────────────────
    {
      insertAgent({ id: "cx-platform", name: "Feilkontakt Gard", website: "https://feilkontakt.no" });
      fixtures.set(
        "https://feilkontakt.no",
        htmlResponse('<a href="mailto:kontakt@rettfrabonden.com">Kontakt</a>', { finalUrl: "https://feilkontakt.no" }),
      );

      const r = await callExtraction({ agentIds: ["cx-platform"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-platform");
      assertEq(item.outcome, "rejected_platform_domain", "g1: platform-owned domain rejected");
      assertEq(contactEmailOf("cx-platform"), "", "g2: nothing written");
      assertEq(auditRowsFor("cx-platform").length, 0, "g3: no audit row for a rejection");
    }

    // ── (h) invalid-syntax rejection (double-dot domain the looser extractor
    //     regex still accepts, but isSyntacticallyValidEmail does not) ───────
    {
      insertAgent({ id: "cx-badsyntax", name: "Dobbeltpunktum Gard", website: "https://dobbeltpunktum.no" });
      fixtures.set(
        "https://dobbeltpunktum.no",
        htmlResponse('<a href="mailto:kontakt@sub..no">Kontakt</a>', { finalUrl: "https://dobbeltpunktum.no" }),
      );

      const r = await callExtraction({ agentIds: ["cx-badsyntax"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-badsyntax");
      assertEq(item.outcome, "rejected_invalid_syntax", "h1: invalid syntax rejected");
      assertEq(contactEmailOf("cx-badsyntax"), "", "h2: nothing written");
    }

    // ── (i) curated_fields lock — skipped BEFORE any fetch ──────────────────
    {
      insertAgent({ id: "cx-curated", name: "Låst Felt Gard", website: "https://laastfeltgard.no", curatedFields: JSON.stringify({ email: { by: "owner" } }) });
      const fetchesBefore = fetchCalls.length;

      const r = await callExtraction({ agentIds: ["cx-curated"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-curated");
      assertEq(item.outcome, "skippedCurated", "i1: skippedCurated");
      assertEq(fetchCalls.length, fetchesBefore, "i2: never fetched — locked before any network call");
      assertEq(contactEmailOf("cx-curated"), "", "i3: nothing written");
    }

    // ── (j) claimed_at row-lock — skipped BEFORE any fetch ───────────────────
    {
      insertAgent({ id: "cx-claimed", name: "Eiers Gard", website: "https://eiersgard.no", claimedAt: "2026-01-01T00:00:00.000Z" });
      const fetchesBefore = fetchCalls.length;

      const r = await callExtraction({ agentIds: ["cx-claimed"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-claimed");
      assertEq(item.outcome, "skippedLocked", "j1: skippedLocked");
      assertEq(fetchCalls.length, fetchesBefore, "j2: never fetched — locked before any network call");
      assertEq(contactEmailOf("cx-claimed"), "", "j3: nothing written");
    }

    // ── (k) aggregator/directory host excluded BEFORE any fetch ─────────────
    {
      const directoryHost = [...RFB_WD_DIRECTORY_HOSTS][0] as string;
      insertAgent({ id: "cx-aggregator", name: "Aggregator Gard", website: `https://${directoryHost}/aggregator-gard` });
      const fetchesBefore = fetchCalls.length;

      const r = await callExtraction({ agentIds: ["cx-aggregator"], apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-aggregator");
      assertEq(item.outcome, "host_excluded", "k1: host_excluded");
      assertEq(fetchCalls.length, fetchesBefore, "k2: never fetched — excluded before any network call");
      assertEq(contactEmailOf("cx-aggregator"), "", "k3: nothing written");
    }

    // ── (l) batch-size cap enforced ──────────────────────────────────────────
    {
      const ids = Array.from({ length: RFB_CX_HARD_CAP + 1 }, (_, i) => `cap-${i}`);
      const r = await callExtraction({ agentIds: ids });
      assertEq(r.status, 400, `l1: more than ${RFB_CX_HARD_CAP} agentIds -> 400`);
    }

    // ── (m) run-lock: concurrent call -> 409, first call still completes ────
    {
      insertAgent({ id: "cx-lock-1", name: "Kjørelås Gard", website: "https://kjorelasgard.no" });
      fixtures.set("https://kjorelasgard.no", htmlResponse("<html><body>Ingenting her.</body></html>", { finalUrl: "https://kjorelasgard.no" }));

      const resA = fakeRes();
      const reqA = { headers: { "x-admin-key": ADMIN_KEY }, body: { agentIds: ["cx-lock-1"] }, query: {} } as any;
      const pA = postExtraction(reqA, resA as any); // NOT awaited — lock is set synchronously before the first await

      const resB = fakeRes();
      const reqB = { headers: { "x-admin-key": ADMIN_KEY }, body: { agentIds: ["cx-lock-1"] }, query: {} } as any;
      await postExtraction(reqB, resB as any);
      assertEq(resB.statusCode, 409, "m1: concurrent call gets 409");
      assertEq(resB.body?.error, "run_in_progress", "m2: run_in_progress error code");

      await pA;
      assertEq(resA.statusCode, 200, "m3: the first (in-flight) call still completes 200");

      // Lock released — a subsequent call goes through.
      const r = await callExtraction({ agentIds: ["cx-lock-1"] });
      assertEq(r.status, 200, "m4: lock released after completion — next call succeeds");
    }

    // ── (n) DNS-flagged-dead cohort: auto-select picks it up, dead address
    //     gets REPLACED (fill-or-replace-if-flagged-dead, not fill-only) ─────
    {
      insertAgent({
        id: "cx-dnsdead",
        name: "Dødadresse Gard",
        website: "https://dodadressegard.no",
        contactEmail: "gammel@dod-domene-xyz.no",
        fieldProvenance: deadDnsProvenance("dod-domene-xyz.no"),
      });
      fixtures.set(
        "https://dodadressegard.no",
        htmlResponse('<a href="mailto:ny@dodadressegard.no">Kontakt</a>', { finalUrl: "https://dodadressegard.no" }),
      );

      const r = await callExtraction({ limit: 48, apply: true });
      const item = r.body.results.find((x: any) => x.agent_id === "cx-dnsdead");
      assertTrue(!!item, "n1: DNS-dead row was picked up by AUTO-SELECT (no agentIds given)");
      assertEq(item.outcome, "written", "n2: outcome written");
      assertEq(contactEmailOf("cx-dnsdead"), "ny@dodadressegard.no", "n3: dead address was REPLACED with the newly corroborated one");
      assertEq(item.old_value, "gammel@dod-domene-xyz.no", "n4: old (dead) value is reported for reversibility");
    }

    // ── (o) regression guard: audit changed_by is ALWAYS 'system' ───────────
    {
      const audit = auditRowsFor("cx-mailto");
      assertTrue(audit.length > 0, "o1: setup — cx-mailto has an audit row from (c)");
      assertTrue(
        audit.every((row: any) => row.changed_by === "system"),
        "o2: every agent_knowledge_audit row this route writes has changed_by='system' — the CHECK(changed_by IN ('owner','admin','system')) constraint would reject anything else",
      );
      const auditDead = auditRowsFor("cx-dnsdead");
      assertTrue(auditDead.length > 0 && auditDead.every((row: any) => row.changed_by === "system"), "o3: same guarantee holds for the DNS-dead-replacement write");
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-rfb-contact-extraction: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-rfb-contact-extraction.test.ts`
if (require.main === module) {
  runAdminRfbContactExtractionTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
