/**
 * admin-rfb-brreg-selfsufficiency.test.ts — tests for
 * dev-request 2026-08-22-rfb-website-email-selvforsyning: a combined batch
 * job that (a) resolves `agents.org_nr` for RFB producer rows using the
 * SAME veto-chain/write-path as POST /admin/agents/org-nr-backfill
 * (admin-agents.ts) plus two ADDITIONAL candidate-generation heuristics
 * (domain-token-as-company-name, personal-name-ENK), then (b)+(c) — for
 * rows that have (or just got) an org_nr but are missing a website — calls
 * Brreg's own registered contact block (fetchBrregContact,
 * brreg-client.ts) and feeds a returned `hjemmeside` into the EXISTING
 * external-candidates-intake function evaluateRfbWebsiteCandidate
 * (admin-rfb-website-discovery.ts), threading Brreg's own `telefon`/`mobil`
 * through as anchor-field evidence via that function's new (additive)
 * `contactOverride` param, and (d) — Grep 1d, dev-request
 * 2026-08-22-rfb-website-email-selvforsyning, Daniel's explicit GO —
 * resolves Brreg's own `epostadresse` into `agents.contact_email` through
 * the SAME shared LLM-judge + deterministic-backstop gate
 * (gateContactCandidates, services/contact-candidate-judge.ts) used
 * elsewhere in this codebase, with "egen side vinner ved avvik" (own site
 * wins on conflict): a non-blank existing contact_email that differs from
 * the gate-approved Brreg candidate is NEVER overwritten.
 *
 * Covers (src/routes/admin-rfb-brreg-selfsufficiency.ts):
 *   (a) 403 without X-Admin-Key.
 *   (b) domainTokenCandidateName: "torgersenmat.no" -> "Torgersen" (strips
 *       the generic trailing word); a domain that's ENTIRELY a generic word
 *       -> null; too-short leftover -> null.
 *   (c) looksLikePersonalName: "Bråstein" (single Title-Case token) -> true;
 *       a business-shaped name ("Torgersen Mat") -> false (2 tokens, second
 *       is a block-listed word); a 3-token name -> false.
 *   (d) findLocalOrgnrCandidate's additive `opts.kommuneFilter` — a query
 *       name shared by two vendored records in DIFFERENT postal regions:
 *       omitted (default) -> both score 1.0, exact_ties=2 (ambiguous);
 *       {kommuneFilter:true} with a postal code matching ONE region only ->
 *       exact_ties=1 (the other-region record is narrowed out BEFORE
 *       scoring, not just down-weighted after).
 *   (e) resolveOrgNrForTarget: domain-token heuristic finds a live-Brreg
 *       candidate the base chain missed (0.95, postal-corroborated but not
 *       exact) -> `queued`, sourceType 'domain_token_name_match' — the SAME
 *       call also proves the veto chain still applies to a NEW heuristic's
 *       hit (confidence < 1.0 -> never auto-written).
 *   (f) resolveOrgNrForTarget: personal-name-ENK heuristic (kommune-filtered
 *       local-JSON candidate, exact match + postal corroboration) ->
 *       `written` (apply mode), sourceType 'personal_name_enk_match' — this
 *       is also the kommune-filter "narrows out a false positive" case in
 *       full end-to-end context (a same-named record in a DIFFERENT region
 *       is present in the fixture set but never considered).
 *   (g) resolveOrgNrForTarget: already-has-org_nr row -> `already_had`,
 *       zero network calls.
 *   (h) resolveOrgNrForTarget: no heuristic produces any hit ->
 *       `no_candidate`, upserted into agents_org_nr_review_queue with null
 *       candidate fields and reason 'no_candidate_found_any_heuristic'.
 *   (i) resolveWebsiteAndContactForTarget: already-has-website row ->
 *       `website_already_present`, fetchBrregContact never called (no
 *       Brreg detail-endpoint call for that org_nr).
 *   (j) resolveWebsiteAndContactForTarget: fetchBrregContact resolves to
 *       null (simulated network failure) -> `brreg_contact_fetch_failed`,
 *       handled gracefully (never throws), nothing queued.
 *   (k) resolveWebsiteAndContactForTarget: Brreg contact has no `hjemmeside`
 *       -> `no_brreg_hjemmeside`, evaluateRfbWebsiteCandidate never called.
 *   (l) telefon/mobil evidence threading (the (c) requirement): the SAME
 *       fixture page (carrying only Brreg's MOBIL number + the producer's
 *       kommune, no org_nr/name match) is rejected by evaluateRfbWebsiteCandidate
 *       when contactOverride is OMITTED (mirrors today's hardcoded
 *       telefon:t.phone/mobil:null — t.phone is blank here, so phone_found
 *       is false) but PROPOSED (verified:true) when contactOverride passes
 *       Brreg's telefon+mobil through — proving the wiring, not just the
 *       underlying matcher (gardssalgWebsiteEvidenceMatch already supported
 *       separate telefon/mobil; this route's caller previously never
 *       supplied them). A second call through
 *       resolveWebsiteAndContactForTarget (this route's own function) with
 *       a Brreg fixture whose `telefon` is a DIFFERENT number from `mobil`
 *       (only mobil appears on the page) confirms the full route wiring
 *       end-to-end, not just the underlying function's own param.
 *   (m) evaluateRfbWebsiteCandidate's new `reason` param — regression guard:
 *       called with the OLD 6-arg shape (reason/contactOverride both
 *       omitted) queues a row whose `reason` column is still the exact
 *       original literal 'website_discovery_candidate_external' — byte-
 *       identical to before this dev-request touched the shared function.
 *   (n) Route-level: POST /admin/rfb-brreg-selfsufficiency without
 *       X-Admin-Key -> 403.
 *   (o) Route-level: dry-run via agentIds override — an already-org_nr'd,
 *       blank-website row with a Brreg hjemmeside fixture is proposed into
 *       agents_website_review_queue (queueing is unconditional, mirrors
 *       both sibling routes' own "queueing is not an apply-gated write"
 *       convention) while dry_run:true and agent_knowledge.website stays
 *       untouched either way (this route never writes that column itself —
 *       only the separate rfb-website-review-approve lever does).
 *   (p) Route-level: apply mode actually writes org_nr for a base-chain
 *       exact/corroborated candidate; org_nr_outcome 'written' in details[].
 *   (q) Route-level: a claimed (locked) agent via agentIds override ->
 *       skipped_locked, never resolved/queued.
 *   (r) Part (d): resolveEmailForTarget — blank contact_email + gate-approved
 *       Brreg epost -> `email_written` (apply) / `email_would_write`
 *       (dry-run), with an agent_knowledge_audit row asserted for the apply
 *       case and none for the dry-run case.
 *   (s) Part (d): gate rejects via the cheap deterministic backstop
 *       classifier (favicon-shaped local part) -> `email_rejected_by_gate`,
 *       never written.
 *   (t) Part (d): Brreg epost on a platform-owned domain
 *       (isPlatformOwnedEmailDomain) -> `email_rejected_platform_domain`,
 *       and the judge/gate is proven NEVER called (call-count assertion) —
 *       the cheap check runs before the LLM judge.
 *   (u) Part (d): existing contact_email non-blank and DIFFERENT from the
 *       gate-approved Brreg candidate -> `email_conflict_kept_own`,
 *       agents.contact_email UNCHANGED, no audit row — "egen side vinner ved
 *       avvik".
 *   (v) Part (d): existing contact_email case-insensitively EQUALS the
 *       gate-approved Brreg candidate -> `email_already_present`, no write;
 *       the gate is still proven to have run first (comparison is AFTER
 *       gating, per spec).
 *   (w) Part (d): agents.claimed_at set BETWEEN scan and write (simulated
 *       race) -> `email_skipped_locked`, caught by the write function's own
 *       fresh re-read, not the outer batch scan.
 *   (x) Part (d): curated_fields locks "contact_email" BETWEEN scan and
 *       write (same race-simulation approach) -> `email_skipped_curated`.
 *   (y) Part (d) scope-boundary regression guard (folded into (i) above,
 *       assertions i3/i4): a row whose website was already non-blank at scan
 *       time never triggers a Brreg fetch at all, so its email outcome is
 *       `not_attempted` and the judge is never called for it — proving this
 *       is the deliberate, documented scope boundary, not an accidental
 *       fetch-skip bug.
 *   (z) Route-level: the response's new `email: {...}` block carries every
 *       RfbBssEmailOutcome key (plus `reject_reasons`) with correct counts
 *       across a small multi-row batch mixing email_written/no_brreg_epost/
 *       not_attempted/email_conflict_kept_own in one call, and each row's
 *       `details[]` entry carries its own `email_outcome`/`email_detail`.
 *
 * All Brreg I/O is stubbed via this route's OWN injectable fetch seam
 * (__setRfbBrregSelfSufficiencyFetchForTesting) for every direct Brreg call
 * this route makes (findOrgnumberByName/verifyOrgNumber/fetchBrregContact
 * all accept an explicit fetchImpl). The ONE inherited exception: the
 * website-candidate leg's own page fetch is reached through
 * evaluateRfbWebsiteCandidate -> services/fetch-page.ts, which reads
 * globalThis.fetch directly and has no injectable param of its own — the
 * closest sibling suite (admin-rfb-website-discovery.test.ts) documents the
 * same unavoidable gap and monkeypatches globalThis.fetch for exactly this
 * reason, safe here for the same reason it's safe there: this suite is run
 * STANDALONE (see below), never interleaved with another
 * globalThis.fetch-swapping suite. Both the injectable seam and
 * globalThis.fetch are pointed at the SAME stub function in this file, so
 * Brreg calls and page fetches are served from one consistent fixture set.
 *
 * Standalone-runnable: `npx tsx src/routes/admin-rfb-brreg-selfsufficiency.test.ts`
 * — deliberately NOT wired into tests/test.ts, matching the established
 * "many newer route-level suites are deliberately standalone" convention
 * (see admin-rfb-website-discovery.test.ts's own file header).
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

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function htmlResponse(html: string, finalUrl?: string): Response {
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

function notFoundPageResponse(): Response {
  return {
    ok: false,
    status: 404,
    url: undefined,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function activeDetail(orgNr: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
    ...extra,
  };
}

function searchHit(orgNr: string, navn: string, postnummer: string | null, poststed: string | null) {
  return {
    organisasjonsnummer: orgNr,
    navn,
    forretningsadresse: { adresse: ["Testveien 1"], postnummer: postnummer ?? undefined, poststed: poststed ?? undefined },
  };
}

export async function runAdminRfbBrregSelfSufficiencyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  // Part (d), Grep 1d: resolveEmailForTarget's gateContactCandidates ->
  // judgeContactCandidate calls globalThis.fetch DIRECTLY (no injectable
  // seam of its own — same as admin-rfb-contact-extraction.ts's own email
  // leg, see contact-candidate-judge.ts's own doc comment) to
  // https://api.anthropic.com/v1/messages. Mocked below via the SAME
  // combined stub this suite already points both the injectable seam and
  // globalThis.fetch at, matching admin-rfb-contact-extraction.test.ts's own
  // convention of parsing the candidate back out of the prompt text.
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-bss-test-key";

  // Fixture registries shared by the combined stub below.
  const searchFixtures: Map<string, { status: number; body: Record<string, unknown> }> = new Map();
  const detailFixtures: Map<string, { status: number; body: Record<string, unknown> } | "network_error"> = new Map();
  const pageFixtures: Map<string, Response> = new Map();
  let searchCallCount = 0;
  let detailCallCount = 0;
  let pageCallCount = 0;
  let anthropicCallCount = 0;
  // Candidate strings (exact, case-sensitive) the fake judge should AVVIS
  // rather than GODKJENN — every fixture not listed here is approved, same
  // "everything plausible is approved by default" convention as
  // admin-rfb-contact-extraction.test.ts's own anthropicRejectCandidates set.
  const anthropicRejectCandidates = new Set<string>();

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request, init?: any) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        anthropicCallCount++;
        const body = init?.body ? JSON.parse(init.body) : {};
        const prompt: string = body?.messages?.[0]?.content ?? "";
        const m = prompt.match(/^Kandidat \([^)]+\): (.+)$/m);
        const candidate = m ? m[1].trim() : "";
        if (anthropicRejectCandidates.has(candidate)) {
          return jsonResponse(200, {
            content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy, ikke ekte kontaktinfo for denne produsenten." }],
          });
        }
        return jsonResponse(200, {
          content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }],
        });
      }
      if (u.includes("navn=")) {
        searchCallCount++;
        for (const [key, fx] of searchFixtures) {
          if (u.includes(key)) return jsonResponse(fx.status, fx.body);
        }
        return jsonResponse(200, { _embedded: { enheter: [] } });
      }
      const dm = /\/enheter\/(\d{9})$/.exec(u);
      if (dm) {
        detailCallCount++;
        const fx = detailFixtures.get(dm[1]);
        if (fx === "network_error") throw new Error("simulated network failure");
        if (!fx) return jsonResponse(404, {});
        return jsonResponse(fx.status, fx.body);
      }
      if (/^https?:\/\//i.test(u)) {
        pageCallCount++;
        const fx = pageFixtures.get(u);
        return fx ?? notFoundPageResponse();
      }
      return jsonResponse(404, {});
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ANTHROPIC_API_KEY = "rfb-bss-test-anthropic-key";
    delete process.env.ANALYTICS_ADMIN_KEY;

    const combinedStub = stubFetch();
    globalThis.fetch = combinedStub;

    // Fresh require of the whole dependency graph — mirrors the sibling
    // suites' own cache-busting convention so this file never depends on
    // module-level state left over from another test file/run.
    for (const mod of [
      "../routes/admin-rfb-brreg-selfsufficiency",
      "../routes/admin-agents",
      "../routes/admin-rfb-website-discovery",
      "../routes/admin-knowledge",
      "../services/brreg-client",
      "../services/local-orgnr-candidates",
      "../services/contact-candidate-judge",
      "../routes/admin-agents-contact-email-write",
    ]) {
      try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
    }

    const routeModule = require("../routes/admin-rfb-brreg-selfsufficiency") as
      typeof import("../routes/admin-rfb-brreg-selfsufficiency");
    const routerModule = routeModule.default;
    const {
      domainTokenCandidateName,
      looksLikePersonalName,
      pickDomainSourceForTarget,
      resolveOrgNrForTarget,
      resolveWebsiteAndContactForTarget,
      resolveEmailForTarget,
      __setRfbBrregSelfSufficiencyFetchForTesting,
    } = routeModule;
    __setRfbBrregSelfSufficiencyFetchForTesting(combinedStub);

    const websiteDiscoveryModule = require("../routes/admin-rfb-website-discovery") as
      typeof import("../routes/admin-rfb-website-discovery");
    const { evaluateRfbWebsiteCandidate, rfbWdExistingWebsiteHosts, ensureRfbWebsiteReviewQueueTable } =
      websiteDiscoveryModule;

    const localCandidates = require("../services/local-orgnr-candidates") as
      typeof import("../services/local-orgnr-candidates");

    ensureRfbWebsiteReviewQueueTable(testDb as any);

    function getHandler(method: "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }
    const postSelfSufficiency = getHandler("post", "/rfb-brreg-selfsufficiency");
    async function callRoute(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postSelfSufficiency({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string; name: string; orgNr?: string | null; claimedAt?: string | null;
      city?: string | null; url?: string | null; isActive?: number;
      role?: string; verticalId?: string | null; umbrellaType?: string | null;
      createdAt?: string; postalCode?: string | null; website?: string | null;
      phone?: string | null; address?: string | null;
      contactEmail?: string | null; curatedFields?: string | null;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
           id, name, description, provider, contact_email, url, role, api_key,
           org_nr, claimed_at, city, is_active, vertical_id, umbrella_type, created_at
         ) VALUES (?, ?, 't', 't', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        // agents.contact_email is NOT NULL (src/database/init.ts) — default
        // preserves the pre-part-(d) fixture value ('x@example.com') for
        // every existing call site; part (d)'s own tests pass
        // contactEmail:"" explicitly for a "blank, eligible to receive a
        // Brreg-sourced address" row (the route's own blank check is
        // `.trim() === ""`, so "" behaves identically to a true NULL would).
        o.id, o.name, o.contactEmail !== undefined ? o.contactEmail : "x@example.com",
        o.url ?? "https://example.com", o.role ?? "producer", `key-${o.id}`,
        o.orgNr ?? null, o.claimedAt ?? null, o.city ?? null,
        o.isActive ?? 1, o.verticalId ?? "rfb", o.umbrellaType ?? null,
        o.createdAt ?? "2026-01-01 00:00:00",
      );
      if (
        o.postalCode !== undefined || o.website !== undefined || o.phone !== undefined ||
        o.address !== undefined || o.curatedFields !== undefined
      ) {
        testDb.prepare(
          `INSERT INTO agent_knowledge (agent_id, postal_code, website, phone, address, curated_fields, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          // agent_knowledge.curated_fields is NOT NULL DEFAULT '{}'
          // (src/database/init.ts) — "{}" is the "not locked" sentinel.
          o.id, o.postalCode ?? null, o.website ?? null, o.phone ?? null, o.address ?? null,
          o.curatedFields ?? "{}", new Date().toISOString(),
        );
      }
    }
    function readAgent(id: string): any {
      return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    }
    function readOrgNrQueueRow(agentId: string): any {
      return testDb.prepare("SELECT * FROM agents_org_nr_review_queue WHERE agent_id = ?").get(agentId);
    }
    function readWebsiteQueueRow(agentId: string): any {
      return testDb.prepare("SELECT * FROM agents_website_review_queue WHERE agent_id = ?").get(agentId);
    }
    function clearWebsiteQueue(): void {
      testDb.prepare("DELETE FROM agents_website_review_queue").run();
    }
    function readAuditRows(agentId: string, fieldName: string): any[] {
      return testDb
        .prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ? ORDER BY changed_at ASC")
        .all(agentId, fieldName);
    }
    // Builds an RfbBssTargetRow-shaped object straight off a live agents/
    // agent_knowledge read — mirrors every other test group's own `t` literal
    // shape (id/name/org_nr/claimed_at/city/url/postal_code/website/phone/
    // address), extended with contact_email/curated_fields (part d).
    function targetRow(id: string): any {
      const a = readAgent(id);
      const k = testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(id) as any;
      return {
        id: a.id, name: a.name, org_nr: a.org_nr, claimed_at: a.claimed_at,
        city: a.city, url: a.url, postal_code: k?.postal_code ?? null, website: k?.website ?? null,
        phone: k?.phone ?? null, address: k?.address ?? null,
        contact_email: a.contact_email ?? null, curated_fields: k?.curated_fields ?? null,
      };
    }

    // ── (b) domainTokenCandidateName ──────────────────────────────────────
    assertEq(domainTokenCandidateName("https://torgersenmat.no"), "Torgersen", "b1: torgersenmat.no -> Torgersen");
    assertEq(domainTokenCandidateName("www.sigerfjordfisk.no"), "Sigerfjord", "b2: sigerfjordfisk.no -> Sigerfjord");
    assertEq(domainTokenCandidateName("https://gard.no"), null, "b3: domain IS entirely a generic word -> null");
    assertEq(domainTokenCandidateName("https://ab.no"), null, "b4: too-short leftover -> null");
    assertEq(domainTokenCandidateName(null), null, "b5: null input -> null");

    // ── (c) looksLikePersonalName ──────────────────────────────────────────
    assertTrue(looksLikePersonalName("Bråstein"), "c1: single Title-Case token -> personal-name-shaped");
    assertTrue(!looksLikePersonalName("Torgersen Mat"), "c2: business-shaped (block-listed 2nd word) -> false");
    assertTrue(!looksLikePersonalName("Nordre Bergan Gård"), "c3: 3 tokens -> false");
    assertTrue(!looksLikePersonalName(""), "c4: empty -> false");
    assertTrue(looksLikePersonalName("Søndre Elton") === true || looksLikePersonalName("Søndre Elton") === false,
      "c5: sanity — 2-token farm-place name does not throw (shape check only, no crash either way)");

    // ── (d) findLocalOrgnrCandidate additive kommuneFilter ─────────────────
    localCandidates.__setLocalOrgnrCandidatesForTesting([
      { orgnr: "970100001", name: "Haugen AS", postal_code: "9006", city: "Tromsø", source: "lokalmat" },
      { orgnr: "970100002", name: "Haugen AS", postal_code: "1001", city: "Oslo", source: "debio" },
    ]);
    {
      const noFilter = localCandidates.findLocalOrgnrCandidate("Haugen", "9008");
      assertTrue(!!noFilter, "d1: without kommuneFilter, a hit is still returned");
      assertEq(noFilter?.exact_ties, 2, "d2: without kommuneFilter, BOTH cross-region records tie at 1.0 (ambiguous)");

      const withFilter = localCandidates.findLocalOrgnrCandidate("Haugen", "9008", { kommuneFilter: true });
      assertTrue(!!withFilter, "d3: with kommuneFilter, a hit is still returned");
      assertEq(withFilter?.exact_ties, 1, "d4: with kommuneFilter, the other-region record is narrowed out BEFORE scoring — no tie");
      assertEq(withFilter?.orgnumber, "970100001", "d5: the SURVIVING (same-region) record wins");
    }

    // ── (e) domain-token heuristic finds a candidate; veto chain still
    //        applies (confidence 0.95 -> queued, never auto-written) ──────
    insertAgent({
      id: "org-domain-token", name: "Torgersen Mat og Pølsemakeri", url: "https://torgersenmat.no",
      postalCode: "3300", city: "Hokksund", createdAt: "2026-02-01 00:00:00",
    });
    // Exact query string for the domain-token attempt's OWN search
    // ("navn=Torgersen&size=5") — deliberately more specific than a bare
    // "navn=Torgersen" substring, which would ALSO match the base chain's
    // own (unrelated, full-name) search and falsely short-circuit this test
    // before the domain-token heuristic is even reached.
    searchFixtures.set(
      "navn=Torgersen&size=5",
      { status: 200, body: { _embedded: { enheter: [searchHit("932265354", "Torgersen Mat og Pølsemakeri AS", "3300", "Hokksund")] } } },
    );
    {
      const target = readAgent("org-domain-token");
      const t = {
        id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: target.claimed_at,
        city: target.city, url: target.url, postal_code: "3300", website: null, phone: null, address: null,
      };
      const resolution = await resolveOrgNrForTarget(testDb as any, t as any, "test-batch-e", true, combinedStub);
      assertEq(resolution.outcome, "queued", "e1: domain-token candidate found, but confidence 0.95 -> queued, not auto-written");
      assertEq(resolution.sourceType, "domain_token_name_match", "e2: sourceType tagged domain_token_name_match");
      assertEq(readAgent("org-domain-token").org_nr, null, "e3: never auto-written");
      const q = readOrgNrQueueRow("org-domain-token");
      assertTrue(!!q, "e4: upserted into the review queue");
      assertEq(q.candidate_source, "domain_token_name_match", "e5: queue row candidate_source matches");
      assertEq(q.candidate_orgnr, "932265354", "e6: queue row carries the found candidate org_nr for a human to confirm");
    }

    // ── (f) personal-name-ENK heuristic: kommune-filtered local hit,
    //        exact + corroborated -> written; the same fixture set proves
    //        the cross-region "Haugen" record from (d) is never considered
    //        here since a totally different search string is used ────────
    localCandidates.__setLocalOrgnrCandidatesForTesting([
      { orgnr: "970100001", name: "Haugen AS", postal_code: "9006", city: "Tromsø", source: "lokalmat" },
      { orgnr: "970100002", name: "Haugen AS", postal_code: "1001", city: "Oslo", source: "debio" },
      { orgnr: "988776655", name: "Bråstein ENK", postal_code: "4300", city: "Sandnes", source: "debio" },
      { orgnr: "988776699", name: "Bråstein ENK", postal_code: "1001", city: "Oslo", source: "lokalmat" },
    ]);
    detailFixtures.set("988776655", { status: 200, body: activeDetail("988776655", "Bråstein ENK") });
    insertAgent({
      id: "org-personal-enk", name: "Bråstein", postalCode: "4300", city: "Sandnes", createdAt: "2026-02-01 00:00:00",
    });
    {
      const target = readAgent("org-personal-enk");
      const t = {
        id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: target.claimed_at,
        city: target.city, url: null, postal_code: "4300", website: null, phone: null, address: null,
      };
      const searchCallsBefore = searchCallCount;
      const resolution = await resolveOrgNrForTarget(testDb as any, t as any, "test-batch-f", true, combinedStub);
      assertEq(resolution.outcome, "written", "f1: personal-name-ENK candidate, exact + corroborated -> written");
      assertEq(resolution.sourceType, "personal_name_enk_match", "f2: sourceType tagged personal_name_enk_match");
      assertEq(resolution.orgNr, "988776655", "f3: the SAME-region (Sandnes) record wins, not the Oslo duplicate");
      assertEq(readAgent("org-personal-enk").org_nr, "988776655", "f4: actually written to the row");
      assertTrue(!readOrgNrQueueRow("org-personal-enk"), "f5: no stale review-queue row left behind");
      // No live Brreg name-search was even needed — the kommune-filtered
      // local-JSON hit alone (confidence 1.0) already beats anything a live
      // search could return, mirroring the base chain's own
      // local-hit-at-1.0-short-circuits convention.
      assertEq(searchCallCount, searchCallsBefore, "f6: no live Brreg name-search call was made — local-JSON-first held");
    }

    // ── (g) already-has-org_nr -> already_had, zero network calls ────────
    insertAgent({ id: "org-already-had", name: "Already Had AS", orgNr: "900111222", createdAt: "2026-02-01 00:00:00" });
    {
      const target = readAgent("org-already-had");
      const t = { id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: target.claimed_at, city: null, url: null, postal_code: null, website: null, phone: null, address: null };
      const searchBefore = searchCallCount;
      const detailBefore = detailCallCount;
      const resolution = await resolveOrgNrForTarget(testDb as any, t as any, "test-batch-g", true, combinedStub);
      assertEq(resolution.outcome, "already_had", "g1: already-has-org_nr -> already_had");
      assertEq(resolution.orgNr, "900111222", "g2: returns the existing org_nr");
      assertEq(searchCallCount, searchBefore, "g3: zero Brreg name-search calls");
      assertEq(detailCallCount, detailBefore, "g4: zero Brreg detail calls");
    }

    // ── (h) no heuristic finds anything -> no_candidate, queued with nulls ─
    insertAgent({ id: "org-no-candidate", name: "Zzyzx Nonexistent Entity", postalCode: "9999", createdAt: "2026-02-01 00:00:00" });
    {
      const target = readAgent("org-no-candidate");
      const t = { id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: target.claimed_at, city: null, url: null, postal_code: "9999", website: null, phone: null, address: null };
      const resolution = await resolveOrgNrForTarget(testDb as any, t as any, "test-batch-h", true, combinedStub);
      assertEq(resolution.outcome, "no_candidate", "h1: no heuristic found anything -> no_candidate");
      const q = readOrgNrQueueRow("org-no-candidate");
      assertTrue(!!q, "h2: upserted into the review queue");
      assertEq(q.candidate_orgnr, null, "h3: null candidate_orgnr");
      assertEq(q.reason, "no_candidate_found_any_heuristic", "h4: reason names ALL heuristics exhausted");
    }

    // ── (i) resolveWebsiteAndContactForTarget: already-has-website ────────
    insertAgent({ id: "web-already-has", name: "Web Already Has AS", orgNr: "911000111", website: "https://existing.no", createdAt: "2026-02-01 00:00:00" });
    {
      const target = readAgent("web-already-has");
      const t = { id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: null, city: null, url: null, postal_code: null, website: "https://existing.no", phone: null, address: null, contact_email: null, curated_fields: null };
      const detailBefore = detailCallCount;
      const existingHosts = rfbWdExistingWebsiteHosts(testDb as any);
      const result = await resolveWebsiteAndContactForTarget(
        testDb as any, t as any, "911000111", "test-batch-i", existingHosts, new Set(), { attempted: 0, verified: 0 }, combinedStub, false,
      );
      assertEq(result.outcome, "website_already_present", "i1: already-has-website -> website_already_present");
      assertEq(detailCallCount, detailBefore, "i2: fetchBrregContact NEVER called for an already-webbed row");
      // Part (d) scope-boundary regression guard: this route's own cohort
      // only requires org_nr-missing OR website-missing, so a row that
      // already has a website only qualified because org_nr was missing —
      // no Brreg fetch happens at all, so the email leg is a documented
      // `not_attempted`, not a fetch or a gate call.
      assertEq(result.email.outcome, "not_attempted", "i3: already-has-website row -> email not_attempted (no Brreg fetch at all, deliberate scope boundary)");
      assertEq(anthropicCallCount, 0, "i4: the judge is never even called for an already-webbed row");
    }

    // ── (j) fetchBrregContact resolves to null (network failure) -> graceful
    insertAgent({ id: "web-brreg-fail", name: "Web Brreg Fail AS", orgNr: "911000222", createdAt: "2026-02-01 00:00:00" });
    detailFixtures.set("911000222", "network_error");
    {
      const target = readAgent("web-brreg-fail");
      const t = { id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: null, city: null, url: null, postal_code: null, website: null, phone: null, address: null, contact_email: null, curated_fields: null };
      const existingHosts = rfbWdExistingWebsiteHosts(testDb as any);
      const result = await resolveWebsiteAndContactForTarget(
        testDb as any, t as any, "911000222", "test-batch-j", existingHosts, new Set(), { attempted: 0, verified: 0 }, combinedStub, false,
      );
      assertEq(result.outcome, "brreg_contact_fetch_failed", "j1: network failure handled gracefully -> brreg_contact_fetch_failed");
      assertTrue(!readWebsiteQueueRow("web-brreg-fail"), "j2: nothing queued");
      // Part (d): the SAME fetch failure that fails the website leg also
      // means the email leg never got a `contact` object to read `epost`
      // from — simplification per spec, not a distinct email-fetch-failure
      // outcome.
      assertEq(result.email.outcome, "not_attempted", "j3: Brreg fetch failure -> email not_attempted too");
    }

    // ── (k) Brreg contact has no hjemmeside -> no_brreg_hjemmeside ────────
    insertAgent({ id: "web-no-hjemmeside", name: "Web No Hjemmeside AS", orgNr: "911000333", createdAt: "2026-02-01 00:00:00" });
    detailFixtures.set("911000333", { status: 200, body: activeDetail("911000333", "Web No Hjemmeside AS", { hjemmeside: null }) });
    {
      const target = readAgent("web-no-hjemmeside");
      const t = { id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: null, city: null, url: null, postal_code: null, website: null, phone: null, address: null, contact_email: null, curated_fields: null };
      const existingHosts = rfbWdExistingWebsiteHosts(testDb as any);
      const result = await resolveWebsiteAndContactForTarget(
        testDb as any, t as any, "911000333", "test-batch-k", existingHosts, new Set(), { attempted: 0, verified: 0 }, combinedStub, false,
      );
      assertEq(result.outcome, "no_brreg_hjemmeside", "k1: no hjemmeside on file -> no_brreg_hjemmeside");
      assertTrue(!readWebsiteQueueRow("web-no-hjemmeside"), "k2: nothing queued");
      // Part (d): the fixture carries no epostadresse either -> the
      // independent email leg still ran (contact WAS fetched successfully)
      // but found nothing.
      assertEq(result.email.outcome, "no_brreg_epost", "k3: no epostadresse on file -> no_brreg_epost");
    }

    // ── (l) telefon/mobil evidence threading ───────────────────────────────
    // Fixture: the page carries ONLY the MOBIL number + the target's own
    // kommune — no org_nr, no name match. Without contactOverride (today's
    // hardcoded telefon:t.phone/mobil:null, t.phone blank here) this can
    // NEVER verify; with contactOverride threading Brreg's own telefon+mobil,
    // the mobil candidate alone (place also present) crosses the bar.
    insertAgent({
      id: "evidence-agent", name: "Evidence Agent Totally Unrelated Name", orgNr: "911000444",
      city: "Solør", createdAt: "2026-02-01 00:00:00",
    });
    pageFixtures.set(
      "https://mobil-evidence-test.no",
      htmlResponse(`<html><body>Velkommen. Ring oss: 912 34 567. Vi holder til i Solør.</body></html>`, "https://mobil-evidence-test.no"),
    );
    {
      const target = readAgent("evidence-agent");
      const targetForFn = {
        id: target.id, name: target.name, org_nr: target.org_nr, claimed_at: null,
        city: target.city, url: null, postal_code: null, website: null, phone: null, address: null,
      };

      // (l1) WITHOUT contactOverride — mirrors the pre-existing 6-arg call
      // shape exactly (no reason, no contactOverride) — must NOT verify.
      const outcomeWithout = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: target.id, url: "https://mobil-evidence-test.no" },
        new Set(), new Set(), { attempted: 0, verified: 0 }, "test-batch-l-without",
      );
      assertEq(outcomeWithout.outcome, "rejected", "l1: WITHOUT contactOverride, phone-only-via-mobil evidence never surfaces -> rejected");

      // (l2) WITH contactOverride — Brreg's own telefon+mobil threaded in.
      const outcomeWith = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: target.id, url: "https://mobil-evidence-test.no" },
        new Set(), new Set(), { attempted: 0, verified: 0 }, "test-batch-l-with",
        "brreg_register_candidate",
        { telefon: "22000000", mobil: "91234567" },
      );
      assertEq(outcomeWith.outcome, "proposed", "l2: WITH contactOverride (telefon+mobil), the mobil-only evidence verifies -> proposed");
      if (outcomeWith.outcome === "proposed") {
        assertTrue(outcomeWith.evidence.phone_found, "l3: evidence.phone_found is true (matched via mobil, not telefon)");
      }
      const qRow = readWebsiteQueueRow("evidence-agent");
      assertTrue(!!qRow, "l4: a queue row was inserted");
      assertEq(qRow.reason, "brreg_register_candidate", "l5: queue row reason tagged brreg_register_candidate");

      // (l6) Full route-wiring proof: resolveWebsiteAndContactForTarget
      // (THIS route's own function) with a Brreg detail fixture whose
      // telefon is a DIFFERENT (non-matching) office number and mobil is
      // the one that actually appears on the page.
      testDb.prepare("DELETE FROM agents_website_review_queue WHERE agent_id = ?").run("evidence-agent");
      detailFixtures.set(
        "911000444",
        { status: 200, body: activeDetail("911000444", "Evidence Agent", { hjemmeside: "https://mobil-evidence-test.no", telefon: "22000000", mobil: "91234567" }) },
      );
      const existingHosts = rfbWdExistingWebsiteHosts(testDb as any);
      const routeResult = await resolveWebsiteAndContactForTarget(
        testDb as any, targetForFn as any, "911000444", "test-batch-l-route",
        existingHosts, new Set(), { attempted: 0, verified: 0 }, combinedStub, false,
      );
      assertEq(routeResult.outcome, "website_proposed", "l6: full route wiring (fetchBrregContact -> contactOverride) proposes the candidate");
      assertEq(routeResult.email.outcome, "no_brreg_epost", "l7: no epostadresse on this fixture -> email leg no_brreg_epost, independent of the website leg's own outcome");
    }

    // ── (m) evaluateRfbWebsiteCandidate reason-param regression guard ─────
    insertAgent({ id: "reason-regress", name: "Reason Regress AS", createdAt: "2026-02-01 00:00:00" });
    pageFixtures.set(
      "https://reason-regress.no",
      htmlResponse(`<html><body>Reason Regress AS. Org.nr 911000555.</body></html>`, "https://reason-regress.no"),
    );
    testDb.prepare(`UPDATE agents SET org_nr = '911000555' WHERE id = 'reason-regress'`).run();
    {
      // OLD 6-arg call shape — reason/contactOverride both omitted.
      const outcome = await evaluateRfbWebsiteCandidate(
        testDb as any,
        { agentId: "reason-regress", url: "https://reason-regress.no" },
        new Set(), new Set(), { attempted: 0, verified: 0 }, "test-batch-m",
      );
      assertEq(outcome.outcome, "proposed", "m1: 6-arg call still verifies (org_nr match)");
      const q = readWebsiteQueueRow("reason-regress");
      assertEq(q?.reason, "website_discovery_candidate_external", "m2: reason column is the ORIGINAL literal, byte-identical when the new param is omitted");
    }

    // ── (n) route-level: 403 without X-Admin-Key ──────────────────────────
    {
      const res = await callRoute({}, {});
      assertEq(res.status, 403, "n1: POST /rfb-brreg-selfsufficiency without X-Admin-Key -> 403");
    }

    // ── (o) route-level: dry-run via agentIds override — website leg queues
    //        unconditionally, agent_knowledge.website untouched either way ─
    insertAgent({
      id: "route-dryrun-web", name: "Route Dryrun Web AS", orgNr: "911000666", createdAt: "2026-02-01 00:00:00",
    });
    detailFixtures.set(
      "911000666",
      { status: 200, body: activeDetail("911000666", "Route Dryrun Web AS", { hjemmeside: "https://route-dryrun-web.no", telefon: "22111111", mobil: null }) },
    );
    pageFixtures.set(
      "https://route-dryrun-web.no",
      htmlResponse(`<html><body>Route Dryrun Web AS. Org.nr 911000666.</body></html>`, "https://route-dryrun-web.no"),
    );
    {
      const res = await callRoute({ agentIds: ["route-dryrun-web"], apply: false });
      assertEq(res.status, 200, "o1: dry-run route call -> 200");
      assertEq(res.body.dry_run, true, "o2: dry_run true");
      const detail = res.body.details.find((d: any) => d.agent_id === "route-dryrun-web");
      assertTrue(!!detail, "o3: agent appears in details[]");
      assertEq(detail.org_nr_outcome, "already_had", "o4: org_nr_outcome already_had (org_nr was pre-set)");
      assertEq(detail.website_outcome, "website_proposed", "o5: website_outcome website_proposed — queueing happens even in dry-run");
      assertEq(readAgent("route-dryrun-web-nonexistent-guard") === undefined, true, "o5b: sanity guard row doesn't exist");
      // This route NEVER writes agent_knowledge.website itself — confirm the
      // column is still blank regardless of dry_run/apply.
      const kRow = testDb.prepare("SELECT website FROM agent_knowledge WHERE agent_id = ?").get("route-dryrun-web") as any;
      assertEq(kRow?.website ?? null, null, "o6: agent_knowledge.website untouched — this route never writes it directly");
    }

    // ── (p) route-level: apply mode actually writes org_nr (base chain) ───
    insertAgent({ id: "route-apply-orgnr", name: "Route Apply Orgnr AS", postalCode: "1601", createdAt: "2026-02-01 00:00:00" });
    searchFixtures.set(
      "navn=Route%20Apply%20Orgnr%20AS",
      { status: 200, body: { _embedded: { enheter: [searchHit("911000777", "Route Apply Orgnr AS", "1601", "Sarpsborg")] } } },
    );
    detailFixtures.set("911000777", { status: 200, body: activeDetail("911000777", "Route Apply Orgnr AS", { hjemmeside: null }) });
    {
      const res = await callRoute({ agentIds: ["route-apply-orgnr"], apply: true });
      assertEq(res.status, 200, "p1: apply route call -> 200");
      assertEq(res.body.dry_run, false, "p2: dry_run false");
      const detail = res.body.details.find((d: any) => d.agent_id === "route-apply-orgnr");
      assertEq(detail?.org_nr_outcome, "written", "p3: org_nr_outcome written (base chain, exact + corroborated)");
      assertEq(readAgent("route-apply-orgnr").org_nr, "911000777", "p4: org_nr actually written to the row");
    }

    // ── (q) route-level: locked agent via agentIds override -> skipped_locked
    insertAgent({ id: "route-locked", name: "Route Locked AS", claimedAt: "2026-01-01 00:00:00", createdAt: "2026-02-01 00:00:00" });
    {
      const searchBefore = searchCallCount;
      const res = await callRoute({ agentIds: ["route-locked"], apply: true });
      assertTrue(res.body.skipped_locked.includes("route-locked"), "q1: locked agent -> skipped_locked");
      assertEq(searchCallCount, searchBefore, "q2: no Brreg name-search call made for a locked agent");
      assertEq(readAgent("route-locked").org_nr, null, "q3: locked agent untouched");
      assertTrue(!res.body.details.some((d: any) => d.agent_id === "route-locked"), "q4: locked agent never appears in details[]");
    }

    // ═══ Part (d), Grep 1d: Brreg epostadresse -> agents.contact_email ═══
    // dev-request 2026-08-22-rfb-website-email-selvforsyning. Daniel's
    // explicit GO: "ja, godkjenn Brreg som e-postkilde — egen side vinner
    // ved avvik". resolveEmailForTarget is unit-tested directly below (the
    // exported seam this slice's spec calls for); (z) covers the full
    // route-level response shape across a mixed batch.

    // ── (r) blank contact_email + Brreg epost + gate approves -> written
    //        (apply) / would_write (dry-run) ─────────────────────────────
    insertAgent({ id: "email-apply-write", name: "Email Apply Write AS", orgNr: "912000101", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    {
      const t = targetRow("email-apply-write");
      assertEq(t.contact_email, "", "r0: sanity — contact_email starts blank");
      const auditBefore = readAuditRows("email-apply-write", "contact_email").length;
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000101", "post@bondensgaard-r1.no", "test-batch-r-apply", true,
      );
      assertEq(resolution.outcome, "email_written", "r1: blank contact_email + gate-approved Brreg epost -> email_written in apply mode");
      assertEq(readAgent("email-apply-write").contact_email, "post@bondensgaard-r1.no", "r2: agents.contact_email actually written");
      const auditRows = readAuditRows("email-apply-write", "contact_email");
      assertEq(auditRows.length, auditBefore + 1, "r3: exactly one agent_knowledge_audit row inserted for this write");
      const auditRow = auditRows[auditRows.length - 1];
      assertEq(auditRow.old_value, "", "r4: audit row old_value is the blank string it was before (was blank)");
      assertEq(auditRow.new_value, "post@bondensgaard-r1.no", "r5: audit row new_value is the written address");
      assertEq(auditRow.changed_by, "system", "r6: audit row changed_by is 'system' (CHECK constraint)");
      assertTrue(
        String(auditRow.notes).includes("rfb-brreg-selfsufficiency") && String(auditRow.notes).includes("912000101") && String(auditRow.notes).includes("test-batch-r-apply"),
        "r7: audit row notes carry the route tag, org_nr, and batch_id",
      );
    }
    insertAgent({ id: "email-dryrun-write", name: "Email Dryrun Write AS", orgNr: "912000102", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    {
      const t = targetRow("email-dryrun-write");
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000102", "post@bondensgaard-r2.no", "test-batch-r-dryrun", false,
      );
      assertEq(resolution.outcome, "email_would_write", "r8: same shape, dry-run -> email_would_write");
      assertEq(readAgent("email-dryrun-write").contact_email, "", "r9: dry-run never writes");
      assertEq(readAuditRows("email-dryrun-write", "contact_email").length, 0, "r10: dry-run leaves no audit row");
    }

    // ── (s) gate rejects (backstop classifier: favicon-shaped local part) ──
    insertAgent({ id: "email-gate-reject", name: "Email Gate Reject AS", orgNr: "912000103", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    {
      const t = targetRow("email-gate-reject");
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000103", "favicon@somefarm-s1.no", "test-batch-s", true,
      );
      assertEq(resolution.outcome, "email_rejected_by_gate", "s1: favicon-shaped local part -> email_rejected_by_gate");
      assertTrue(!!resolution.detail && resolution.detail.startsWith("backstop classifier:"), "s2: detail names the backstop classifier, not the LLM judge (cheaper check caught it first)");
      assertEq(readAgent("email-gate-reject").contact_email, "", "s3: never written");
    }

    // ── (t) Brreg epost is a platform-owned domain -> rejected BEFORE the
    //        judge is ever called (cheap, deterministic check first) ──────
    insertAgent({ id: "email-platform-domain", name: "Email Platform Domain AS", orgNr: "912000104", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    {
      const t = targetRow("email-platform-domain");
      const anthropicBefore = anthropicCallCount;
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000104", "kontakt@rettfrabonden.com", "test-batch-t", true,
      );
      assertEq(resolution.outcome, "email_rejected_platform_domain", "t1: rettfrabonden.com epost -> email_rejected_platform_domain");
      assertEq(anthropicCallCount, anthropicBefore, "t2: the judge/gate is NEVER called for a platform-owned domain (call-count assertion)");
      assertEq(readAgent("email-platform-domain").contact_email, "", "t3: never written");
    }

    // ── (u) existing contact_email non-blank, DIFFERS from the gate-approved
    //        Brreg candidate -> email_conflict_kept_own, existing NEVER
    //        overwritten ("egen side vinner ved avvik") ────────────────────
    insertAgent({
      id: "email-conflict", name: "Email Conflict AS", orgNr: "912000105",
      contactEmail: "gammel@egenside-u1.no", createdAt: "2026-02-01 00:00:00",
    });
    {
      const t = targetRow("email-conflict");
      const auditBefore = readAuditRows("email-conflict", "contact_email").length;
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000105", "annen@brreg-u1.no", "test-batch-u", true,
      );
      assertEq(resolution.outcome, "email_conflict_kept_own", "u1: existing differs from gate-approved Brreg candidate -> email_conflict_kept_own");
      assertTrue(
        !!resolution.detail && resolution.detail.includes("gammel@egenside-u1.no") && resolution.detail.includes("annen@brreg-u1.no"),
        "u2: detail carries BOTH the existing and the Brreg candidate values",
      );
      assertEq(readAgent("email-conflict").contact_email, "gammel@egenside-u1.no", "u3: agents.contact_email UNCHANGED — own site wins on conflict");
      assertEq(readAuditRows("email-conflict", "contact_email").length, auditBefore, "u4: no new audit row for this field from this batch");
    }

    // ── (v) existing contact_email case-insensitively EQUALS the Brreg
    //        candidate -> email_already_present, no write; the gate is still
    //        called first (comparison happens AFTER gating) ────────────────
    insertAgent({
      id: "email-already-present", name: "Email Already Present AS", orgNr: "912000106",
      contactEmail: "SAME@Farm-v1.NO", createdAt: "2026-02-01 00:00:00",
    });
    {
      const t = targetRow("email-already-present");
      const anthropicBefore = anthropicCallCount;
      const resolution = await resolveEmailForTarget(
        testDb as any, t as any, "912000106", "same@farm-v1.no", "test-batch-v", true,
      );
      assertEq(resolution.outcome, "email_already_present", "v1: case-insensitive match -> email_already_present");
      assertTrue(anthropicCallCount > anthropicBefore, "v2: the gate WAS still called before the comparison (order per spec)");
      assertEq(readAgent("email-already-present").contact_email, "SAME@Farm-v1.NO", "v3: original casing untouched, no write attempted");
    }

    // ── (w) agents.claimed_at set BETWEEN scan and write (race) ->
    //        email_skipped_locked, caught by the write function's own fresh
    //        re-read, not the outer batch scan ──────────────────────────────
    insertAgent({ id: "email-locked-race", name: "Email Locked Race AS", orgNr: "912000107", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    {
      const staleTarget = targetRow("email-locked-race"); // captured BEFORE the row gets locked
      testDb.prepare("UPDATE agents SET claimed_at = ? WHERE id = ?").run("2026-02-02 00:00:00", "email-locked-race");
      const resolution = await resolveEmailForTarget(
        testDb as any, staleTarget as any, "912000107", "post@bondensgaard-w1.no", "test-batch-w", true,
      );
      assertEq(resolution.outcome, "email_skipped_locked", "w1: locked between scan and write -> email_skipped_locked");
      assertEq(readAgent("email-locked-race").contact_email, "", "w2: never written");
      assertEq(readAuditRows("email-locked-race", "contact_email").length, 0, "w3: no audit row");
    }

    // ── (x) curated_fields locks "contact_email" BETWEEN scan and write
    //        (same race-simulation approach as (w)) -> email_skipped_curated
    insertAgent({
      id: "email-curated-race", name: "Email Curated Race AS", orgNr: "912000108",
      contactEmail: "", curatedFields: "{}", createdAt: "2026-02-01 00:00:00",
    });
    {
      const staleTarget = targetRow("email-curated-race"); // captured BEFORE curated_fields locks it
      testDb.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?").run(
        JSON.stringify({ contact_email: true }), "email-curated-race",
      );
      const resolution = await resolveEmailForTarget(
        testDb as any, staleTarget as any, "912000108", "post@bondensgaard-x1.no", "test-batch-x", true,
      );
      assertEq(resolution.outcome, "email_skipped_curated", "x1: curated_fields locked between scan and write -> email_skipped_curated");
      assertEq(readAgent("email-curated-race").contact_email, "", "x2: never written");
      assertEq(readAuditRows("email-curated-race", "contact_email").length, 0, "x3: no audit row");
    }

    // ── (y) already covered as a regression guard in (i) above: a row whose
    //        target.website was already non-blank at scan time -> the email
    //        leg is `not_attempted` and NEITHER fetchBrregContact NOR the
    //        judge is ever called for that row (assertions i3/i4).

    // ── (z) route-level response shape: the new `email: {...}` block's keys
    //        are all present with correct counts across a mixed batch ──────
    insertAgent({ id: "route-email-rz1", name: "Route Email RZ1 AS", orgNr: "912000201", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    insertAgent({ id: "route-email-rz2", name: "Route Email RZ2 AS", orgNr: "912000202", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    insertAgent({ id: "route-email-rz3", name: "Qzxk99 Route Email RZ3 NonMatch", contactEmail: "", createdAt: "2026-02-01 00:00:00" });
    insertAgent({
      id: "route-email-rz4", name: "Route Email RZ4 AS", orgNr: "912000204",
      contactEmail: "min@egenside-rz4.no", createdAt: "2026-02-01 00:00:00",
    });
    detailFixtures.set("912000201", { status: 200, body: activeDetail("912000201", "Route Email RZ1 AS", { hjemmeside: null, epostadresse: "kontakt@bondensgaard-rz1.no" }) });
    detailFixtures.set("912000202", { status: 200, body: activeDetail("912000202", "Route Email RZ2 AS", { hjemmeside: null }) });
    detailFixtures.set("912000204", { status: 200, body: activeDetail("912000204", "Route Email RZ4 AS", { hjemmeside: null, epostadresse: "annen@brreg-rz4.no" }) });
    {
      const res = await callRoute({ agentIds: ["route-email-rz1", "route-email-rz2", "route-email-rz3", "route-email-rz4"], apply: true });
      assertEq(res.status, 200, "z1: mixed-batch apply call -> 200");
      const expectedEmailBlockKeys = [
        "email_already_present", "no_brreg_epost", "email_written", "email_would_write",
        "email_conflict_kept_own", "email_rejected_by_gate", "email_rejected_platform_domain",
        "email_skipped_locked", "email_skipped_curated", "not_attempted", "reject_reasons",
      ];
      for (const key of expectedEmailBlockKeys) {
        assertTrue(Object.prototype.hasOwnProperty.call(res.body.email, key), `z2: response email block has key '${key}'`);
      }
      assertEq(res.body.email.email_written, 1, "z3: exactly one email_written (rz1)");
      assertEq(res.body.email.no_brreg_epost, 1, "z4: exactly one no_brreg_epost (rz2)");
      assertEq(res.body.email.not_attempted, 1, "z5: exactly one not_attempted (rz3 — no org_nr, no candidate found)");
      assertEq(res.body.email.email_conflict_kept_own, 1, "z6: exactly one email_conflict_kept_own (rz4)");
      assertEq(res.body.email.email_already_present, 0, "z7: zero email_already_present in this mix");
      assertEq(readAgent("route-email-rz1").contact_email, "kontakt@bondensgaard-rz1.no", "z8: rz1 actually written");
      assertEq(readAgent("route-email-rz4").contact_email, "min@egenside-rz4.no", "z9: rz4's own contact_email untouched (conflict, own site wins)");
      const detailRz1 = res.body.details.find((d: any) => d.agent_id === "route-email-rz1");
      assertEq(detailRz1?.email_outcome, "email_written", "z10: details[] carries the per-row email_outcome");
      const detailRz4 = res.body.details.find((d: any) => d.agent_id === "route-email-rz4");
      assertEq(detailRz4?.email_outcome, "email_conflict_kept_own", "z11: details[] email_outcome for the conflict row");
      assertTrue(!!detailRz4?.email_detail, "z12: details[] carries email_detail for a rejected/conflicted row");
      assertTrue(Object.keys(res.body.email.reject_reasons).length >= 1, "z13: reject_reasons carries at least the conflict's detail string");
    }

  } catch (err: any) {
    failed++;
    failures.push("admin-rfb-brreg-selfsufficiency: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    try {
      if (prevDb) (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-rfb-brreg-selfsufficiency.test.ts`
if (require.main === module) {
  runAdminRfbBrregSelfSufficiencyTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
