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
 *   (r) AC4 — fill-only: a row whose agent_knowledge.email is already
 *       non-empty is NEVER overwritten (agents.contact_email still gets its
 *       normal write); a sibling row with no pre-existing value still gets
 *       filled in the SAME apply call.
 *
 * dev-request (agent_knowledge.email column fix): (b)/(c)/(i)/(j)/(n) above
 * were extended with DB-level assertions against agent_knowledge.email +
 * field_provenance to prove AC1 (populated on write), AC2 (non-empty
 * source_url in field_provenance.email), and AC3 (curated/locked rows never
 * touch agent_knowledge.email either) — not just the existing
 * agents.contact_email assertions.
 *
 * dev-request 2026-09-02-rfb-innhoestet-contact-email-uten-k-email (option
 * A): mode:"backfill_from_contact_email" — a pure DB re-classification/
 * backfill of an address ALREADY on file in agents.contact_email into
 * agent_knowledge.email (no page fetch, so no fixtures/stubFetch use for
 * this section at all). Section (bf) covers:
 *   (bf1) dry-run over the new cohort reports the copy, writes nothing.
 *   (bf2) apply writes agent_knowledge.email with
 *         source_type:"harvest_contact_email" and source_url = k.website.
 *   (bf3) a platform-owned contact_email is rejected
 *         ("rejected_platform_domain"), never written.
 *   (bf4) a domain-mismatched (non-free-mail) contact_email is rejected
 *         ("rejected_domain_mismatch"), never written.
 *   (bf5) a row with no contact_email_dns_check.live=1 (missing, or
 *         explicitly 0) is NOT in the cohort at all — not just skipped, not
 *         present in `results`.
 *   (bf6) a row whose agent_knowledge.email is already non-blank is
 *         untouched (fill-only) — also not in the cohort (blank-email is
 *         part of the cohort filter itself).
 *   (bf7) the free-mail exemption: a gmail.com contact_email on a company
 *         whose website is a different domain IS accepted and written.
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
  // Grep 5b (dev-request 2026-08-19-kursjustering-drikkefunnel-llm-og-
  // supply): applyRfbCxWrite's call site now gates every email candidate
  // through the shared LLM-judge contact gate before writing — see
  // contact-candidate-judge.test.ts for the judge module's own unit tests.
  // Every existing fixture below is a plausible, legitimate candidate, so
  // the default mock always GODKJENNs; a dedicated W34 rejection case is
  // added in section (p).
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-cx-test-key";

  const fixtures: Map<string, Response> = new Map();
  const fetchCalls: string[] = [];
  const anthropicRejectCandidates = new Set<string>();

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("api.anthropic.com")) {
        const body = init?.body ? JSON.parse(init.body) : {};
        const prompt: string = body?.messages?.[0]?.content ?? "";
        const m = prompt.match(/^Kandidat \([^)]+\): (.+)$/m);
        const candidate = m ? m[1].trim() : "";
        if (anthropicRejectCandidates.has(candidate)) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy, ikke ekte kontaktinfo for denne produsenten." }] }),
          } as any;
        }
        return {
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }] }),
        } as any;
      }
      fetchCalls.push(urlStr);
      const fx = fixtures.get(urlStr);
      return fx ?? notFoundResponse();
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ANTHROPIC_API_KEY = "rfb-cx-test-anthropic-key";
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
      knowledgeEmail?: string | null;
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
        `INSERT INTO agent_knowledge (agent_id, website, field_provenance, curated_fields, email, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id, o.website, o.fieldProvenance ?? "{}", o.curatedFields ?? "{}", o.knowledgeEmail ?? null, new Date().toISOString(),
      );
    }

    function contactEmailOf(id: string): string {
      const row = testDb.prepare("SELECT contact_email FROM agents WHERE id = ?").get(id) as { contact_email: string };
      return row.contact_email;
    }
    function knowledgeEmailOf(id: string): string | null {
      const row = testDb.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(id) as { email: string | null };
      return row.email;
    }
    function fieldProvenanceOf(id: string): Record<string, any> {
      const row = testDb.prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?").get(id) as
        { field_provenance: string | null };
      return row.field_provenance ? JSON.parse(row.field_provenance) : {};
    }
    function auditRowsFor(id: string): any[] {
      return testDb.prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at").all(id);
    }
    const deadDnsProvenance = (domain: string) =>
      JSON.stringify({ contact_email_dns_check: { checked_at: "2026-08-01T00:00:00.000Z", domain, live: false, method: "none", batch_id: "x" } });
    const liveDnsProvenance = (domain: string) =>
      JSON.stringify({ contact_email_dns_check: { checked_at: "2026-08-01T00:00:00.000Z", domain, live: true, method: "none", batch_id: "x" } });

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
      assertEq(knowledgeEmailOf("cx-mailto"), null, "b9: dry-run also wrote nothing to agent_knowledge.email");
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

      // AC1/AC2: the funnel gates (lokal-agent-verifier.ts's
      // pickPendingVerifyBatch, admin-outreach-candidates.ts) read
      // agent_knowledge.email, NOT agents.contact_email — so a write that
      // only touched the latter (the pre-fix bug) would never surface here.
      // Reverting just the new agent_knowledge UPDATE statement makes c10
      // fail (knowledgeEmailOf stays null) while c4 above still passes —
      // mutation-proof for exactly the bug this fix targets.
      assertEq(knowledgeEmailOf("cx-mailto"), "kontakt@fjelldal.no", "c10 (AC1): agent_knowledge.email was ALSO populated — the column both funnel gates actually read");
      const prov = fieldProvenanceOf("cx-mailto");
      assertTrue(Array.isArray(prov.email) && prov.email.length === 1, "c11 (AC2): field_provenance.email has exactly one entry");
      assertEq(prov.email[0].source_url, "https://fjelldal.no", "c12 (AC2): field_provenance.email[0].source_url is non-empty and matches the scraped page");
      assertTrue(typeof prov.email[0].source_type === "string" && prov.email[0].source_type.length > 0, "c13 (AC2): field_provenance.email[0].source_type is set");
      assertEq(prov.email[0].value, "kontakt@fjelldal.no", "c14: field_provenance.email[0].value matches the written address");
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
      assertEq(knowledgeEmailOf("cx-curated"), null, "i4 (AC3): agent_knowledge.email also untouched by a curated-locked row");
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
      assertEq(knowledgeEmailOf("cx-claimed"), null, "j4 (AC3): agent_knowledge.email also untouched by a claimed-locked row");
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
      assertEq(knowledgeEmailOf("cx-dnsdead"), "ny@dodadressegard.no", "n5 (AC1): agent_knowledge.email was ALSO filled (it started empty on this fixture)");
    }

    // ── (r) AC4 — fill-only: a row whose agent_knowledge.email is ALREADY
    // non-empty is NEVER overwritten by this route, even though
    // agents.contact_email still gets its normal fill-or-replace write. Two
    // sibling rows in the SAME apply call, one with a pre-existing
    // agent_knowledge.email and one without, to regression-guard that the
    // fill-only guard is scoped to the row that actually has a value and
    // does not accidentally suppress the write for its neighbour. ─────────
    {
      insertAgent({
        id: "cx-fillonly-preexisting",
        name: "Alt Utfylt Gard",
        website: "https://altutfyltgard.no",
        knowledgeEmail: "eksisterende@annendomene.no",
      });
      fixtures.set(
        "https://altutfyltgard.no",
        htmlResponse('<a href="mailto:ny-funnet@altutfyltgard.no">Kontakt</a>', { finalUrl: "https://altutfyltgard.no" }),
      );

      insertAgent({ id: "cx-fillonly-empty", name: "Tomt Felt Gard", website: "https://tomtfeltgard.no" });
      fixtures.set(
        "https://tomtfeltgard.no",
        htmlResponse('<a href="mailto:post@tomtfeltgard.no">Kontakt</a>', { finalUrl: "https://tomtfeltgard.no" }),
      );

      const r = await callExtraction({ agentIds: ["cx-fillonly-preexisting", "cx-fillonly-empty"], apply: true });

      const preexisting = r.body.results.find((x: any) => x.agent_id === "cx-fillonly-preexisting");
      assertEq(preexisting.outcome, "written", "r1: outcome still 'written' — the row-level lock only, never a per-column guard, changes the reported outcome");
      assertEq(contactEmailOf("cx-fillonly-preexisting"), "ny-funnet@altutfyltgard.no", "r2: agents.contact_email STILL gets its normal fill-or-replace write");
      assertEq(knowledgeEmailOf("cx-fillonly-preexisting"), "eksisterende@annendomene.no", "r3 (AC4): agent_knowledge.email is UNCHANGED — fill-only never overwrites a pre-existing value, even a differing one");
      const preexistingProv = fieldProvenanceOf("cx-fillonly-preexisting");
      assertTrue(!preexistingProv.email, "r4 (AC4): no field_provenance.email entry was added for a row that was never actually filled");

      const empty = r.body.results.find((x: any) => x.agent_id === "cx-fillonly-empty");
      assertEq(empty.outcome, "written", "r5: sibling row (no pre-existing agent_knowledge.email) still writes normally");
      assertEq(knowledgeEmailOf("cx-fillonly-empty"), "post@tomtfeltgard.no", "r6: sibling row's agent_knowledge.email WAS filled — the fill-only guard did not leak onto it");
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

    // ── (p) Grep 5b — LLM-judge contact gate (dev-request 2026-08-19-
    // kursjustering-drikkefunnel-llm-og-supply): a candidate the shared
    // judge rejects is NEVER written — reported exactly like
    // 'no_contact_found' — while a genuine candidate in the SAME apply call
    // still writes normally (regression guard). ────────────────────────────
    {
      insertAgent({ id: "cx-gate-reject", name: "Dommeravvist Gard", website: "https://dommeravvist.no" });
      const rejectedCandidate = "post@dommeravvist.no";
      fixtures.set(
        "https://dommeravvist.no",
        htmlResponse(`<a href="mailto:${rejectedCandidate}">Kontakt</a>`, { finalUrl: "https://dommeravvist.no" }),
      );
      anthropicRejectCandidates.add(rejectedCandidate);

      insertAgent({ id: "cx-gate-ok", name: "Dommergodkjent Gard", website: "https://dommergodkjent.no" });
      fixtures.set(
        "https://dommergodkjent.no",
        htmlResponse('<a href="mailto:post@dommergodkjent.no">Kontakt</a>', { finalUrl: "https://dommergodkjent.no" }),
      );

      try {
        const r = await callExtraction({ agentIds: ["cx-gate-reject", "cx-gate-ok"], apply: true });
        const rejectedItem = r.body.results.find((x: any) => x.agent_id === "cx-gate-reject");
        assertEq(rejectedItem?.outcome, "no_contact_found", "p1: a judge-rejected candidate is reported exactly like no_contact_found");
        assertEq(contactEmailOf("cx-gate-reject"), "", "p2: the rejected candidate was NEVER written to agents.contact_email");
        assertEq(auditRowsFor("cx-gate-reject").length, 0, "p3: no audit row for a candidate the gate rejected");

        const okItem = r.body.results.find((x: any) => x.agent_id === "cx-gate-ok");
        assertEq(okItem?.outcome, "written", "p4: a genuine candidate on the SAME apply call still writes (regression guard)");
        assertEq(contactEmailOf("cx-gate-ok"), "post@dommergodkjent.no", "p5: the genuine candidate WAS written");
      } finally {
        anthropicRejectCandidates.delete(rejectedCandidate);
      }
    }

    // ── (q) Grep 5b — fail-closed on a missing ANTHROPIC_API_KEY: a
    // candidate that would otherwise write (mailto, clean syntax, own
    // domain) is still never written when the judge cannot even be called. ─
    {
      insertAgent({ id: "cx-gate-nokey", name: "Uten Nøkkel Gard", website: "https://utennokkel.no" });
      fixtures.set(
        "https://utennokkel.no",
        htmlResponse('<a href="mailto:post@utennokkel.no">Kontakt</a>', { finalUrl: "https://utennokkel.no" }),
      );
      const savedKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const r = await callExtraction({ agentIds: ["cx-gate-nokey"], apply: true });
        const item = r.body.results.find((x: any) => x.agent_id === "cx-gate-nokey");
        assertEq(item?.outcome, "no_contact_found", "q1: missing ANTHROPIC_API_KEY -> fails closed, reported as no_contact_found");
        assertEq(contactEmailOf("cx-gate-nokey"), "", "q2: nothing written with no ANTHROPIC_API_KEY, even though the page has a perfectly valid mailto");
      } finally {
        process.env.ANTHROPIC_API_KEY = savedKey;
      }
    }

    // ── (bf) mode: "backfill_from_contact_email" (dev-request
    // 2026-09-02-rfb-innhoestet-contact-email-uten-k-email, option A) — a
    // pure DB re-classification/backfill of an address ALREADY on file in
    // agents.contact_email into agent_knowledge.email. No page fetch: no
    // fixtures.set(...) needed for any row in this section, and fetchCalls
    // must never grow across it.
    {
      const fetchesBeforeBf = fetchCalls.length;

      // (bf1)/(bf2): dry-run reports the copy without writing; apply then
      // actually writes agent_knowledge.email with
      // source_type:"harvest_contact_email" and source_url = k.website.
      insertAgent({
        id: "cx-bf-basic", name: "Nydal Gard", website: "https://nydalgard.no",
        contactEmail: "post@nydalgard.no", fieldProvenance: liveDnsProvenance("nydalgard.no"),
      });

      const dry = await callExtraction({ agentIds: ["cx-bf-basic"], mode: "backfill_from_contact_email" });
      assertEq(dry.status, 200, "bf1-1: 200");
      assertEq(dry.body.dry_run, true, "bf1-2: dry-run by default");
      const dryItem = dry.body.results.find((x: any) => x.agent_id === "cx-bf-basic");
      assertTrue(!!dryItem, "bf1-3: result present for cx-bf-basic");
      assertEq(dryItem.outcome, "written", "bf1-4: outcome is 'written' (would-write in dry-run)");
      assertEq(dryItem.email, "post@nydalgard.no", "bf1-5: reports the already-known contact_email");
      assertEq(dryItem.source_url, "https://nydalgard.no", "bf1-6: source_url is k.website");
      assertEq(knowledgeEmailOf("cx-bf-basic"), null, "bf1-7: dry-run wrote NOTHING to agent_knowledge.email");

      const applied = await callExtraction({ agentIds: ["cx-bf-basic"], mode: "backfill_from_contact_email", apply: true });
      assertEq(applied.status, 200, "bf2-1: 200");
      assertEq(applied.body.dry_run, false, "bf2-2: apply turns off dry-run");
      const appliedItem = applied.body.results.find((x: any) => x.agent_id === "cx-bf-basic");
      assertEq(appliedItem.outcome, "written", "bf2-3: outcome written");
      assertEq(knowledgeEmailOf("cx-bf-basic"), "post@nydalgard.no", "bf2-4: agent_knowledge.email was filled from agents.contact_email");
      assertEq(contactEmailOf("cx-bf-basic"), "post@nydalgard.no", "bf2-5: agents.contact_email unchanged (same-value no-op)");
      const bfProv = fieldProvenanceOf("cx-bf-basic");
      assertTrue(Array.isArray(bfProv.email) && bfProv.email.length === 1, "bf2-6: field_provenance.email has exactly one entry");
      assertEq(bfProv.email[0].source_type, "harvest_contact_email", "bf2-7 (AC1): source_type is 'harvest_contact_email', distinguishing this from a fresh scrape");
      assertEq(bfProv.email[0].source_url, "https://nydalgard.no", "bf2-8: field_provenance.email[0].source_url is k.website");
      assertEq(bfProv.email[0].value, "post@nydalgard.no", "bf2-9: field_provenance.email[0].value matches the written address");

      // (bf2-audit) regression guard (CHANGES-REQUESTED review finding):
      // newEmail in backfill mode is BY CONSTRUCTION identical to the row's
      // pre-existing agents.contact_email (that's the whole premise of this
      // mode — copying an already-on-file address into agent_knowledge.email),
      // so applyRfbCxWrite must skip both the agents.contact_email UPDATE and
      // the agent_knowledge_audit INSERT for it — a fabricated "X changed to
      // X" audit row would pollute admin-agent-audit.ts's Daniel-only audit
      // trail and break the dev-request's rollback contract (resetting
      // k.email for provenance:harvest_contact_email rows must be
      // sufficient). Only the outcome stays "written" (asserted as bf2-3
      // above) — no DB-level contact_email audit row should exist.
      const bf2AuditRows = testDb
        .prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'contact_email'")
        .all("cx-bf-basic");
      assertEq(bf2AuditRows.length, 0, "bf2-audit: no agent_knowledge_audit row for contact_email — value was unchanged");

      // (bf3): platform-owned domain -> rejected, never written.
      insertAgent({
        id: "cx-bf-platform", name: "Feilkontakt Backfill Gard", website: "https://feilbf.no",
        contactEmail: "kontakt@rettfrabonden.com", fieldProvenance: liveDnsProvenance("rettfrabonden.com"),
      });
      const bf3 = await callExtraction({ agentIds: ["cx-bf-platform"], mode: "backfill_from_contact_email", apply: true });
      const bf3Item = bf3.body.results.find((x: any) => x.agent_id === "cx-bf-platform");
      assertEq(bf3Item.outcome, "rejected_platform_domain", "bf3-1: platform-owned domain rejected");
      assertEq(knowledgeEmailOf("cx-bf-platform"), null, "bf3-2: nothing written to agent_knowledge.email");

      // (bf4): non-free-mail domain mismatch (contact_email's domain differs
      // from k.website's host) -> rejected, never written.
      insertAgent({
        id: "cx-bf-mismatch", name: "Ukoblet Backfill Gard", website: "https://ukobletbf.no",
        contactEmail: "post@heltannenbedrift.no", fieldProvenance: liveDnsProvenance("heltannenbedrift.no"),
      });
      const bf4 = await callExtraction({ agentIds: ["cx-bf-mismatch"], mode: "backfill_from_contact_email", apply: true });
      const bf4Item = bf4.body.results.find((x: any) => x.agent_id === "cx-bf-mismatch");
      assertEq(bf4Item.outcome, "rejected_domain_mismatch", "bf4-1: domain mismatch rejected");
      assertEq(knowledgeEmailOf("cx-bf-mismatch"), null, "bf4-2: nothing written to agent_knowledge.email");

      // (bf7): free-mail exemption — a gmail.com contact_email on a company
      // whose website is a completely different domain IS accepted.
      insertAgent({
        id: "cx-bf-freemail", name: "Fjellro Backfill Gard", website: "https://fjellrobf.no",
        contactEmail: "fjellrogard@gmail.com", fieldProvenance: liveDnsProvenance("gmail.com"),
      });
      const bf7 = await callExtraction({ agentIds: ["cx-bf-freemail"], mode: "backfill_from_contact_email", apply: true });
      const bf7Item = bf7.body.results.find((x: any) => x.agent_id === "cx-bf-freemail");
      assertEq(bf7Item.outcome, "written", "bf7-1: free-mail exemption accepted");
      assertEq(knowledgeEmailOf("cx-bf-freemail"), "fjellrogard@gmail.com", "bf7-2: gmail.com address written despite domain differing from website");

      // (bf5)/(bf6): cohort exclusion, proven via AUTO-SELECT (no agentIds)
      // so that "not in the cohort at all" is distinguishable from the
      // agentIds path's own "not_found" (which reports an id that simply
      // isn't a row at all — a different case). A row absent from `results`
      // here means selectRfbCxBackfillTargets never selected it.
      insertAgent({
        id: "cx-bf-notchecked", name: "Usjekket Gard", website: "https://usjekketbf.no",
        contactEmail: "post@usjekketbf.no", // field_provenance defaults to "{}" -> no dns_check.live key at all
      });
      insertAgent({
        id: "cx-bf-deadflag", name: "Dødflagg Gard", website: "https://dodflaggbf.no",
        contactEmail: "post@dodflaggbf.no", fieldProvenance: deadDnsProvenance("dodflaggbf.no"), // live: false
      });
      insertAgent({
        id: "cx-bf-filled", name: "Alt Fylt Backfill Gard", website: "https://fyltbf.no",
        contactEmail: "post@fyltbf.no", knowledgeEmail: "original@fyltbf.no", fieldProvenance: liveDnsProvenance("fyltbf.no"),
      });

      const scan = await callExtraction({ limit: 48, mode: "backfill_from_contact_email" });
      const scanIds = new Set(scan.body.results.map((x: any) => x.agent_id));
      assertTrue(!scanIds.has("cx-bf-notchecked"), "bf5-1: a row with NO contact_email_dns_check.live key is NOT in the cohort at all");
      assertTrue(!scanIds.has("cx-bf-deadflag"), "bf5-2: a row with contact_email_dns_check.live=false is NOT in the cohort at all (mere 'not flagged dead' is not enough — must be explicitly live=1)");
      assertTrue(!scanIds.has("cx-bf-filled"), "bf6-1: a row whose agent_knowledge.email is already non-blank is NOT in the cohort at all (fill-only is enforced at the cohort level)");
      assertEq(knowledgeEmailOf("cx-bf-notchecked"), null, "bf5-3: untouched — still null");
      assertEq(knowledgeEmailOf("cx-bf-deadflag"), null, "bf5-4: untouched — still null");
      assertEq(knowledgeEmailOf("cx-bf-filled"), "original@fyltbf.no", "bf6-2: untouched — pre-existing value preserved exactly");

      assertEq(fetchCalls.length, fetchesBeforeBf, "bf-nofetch: backfill_from_contact_email never makes a live page fetch");
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
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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
