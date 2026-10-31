/**
 * gardssalg-claim-outreach-delivered-oa01.test.ts — bug OA-01 (dev-request
 * 2026-07-30-opplevagent-claim-epost-og-perfelt-laas): the gårdssalg claim
 * page never saw Opplevagent's own outreach. Measured 31.10: 20 of 49
 * e-mailed producers got «Vi kan ikke bekrefte automatisk …» on the claim page
 * the outreach mail links to, because the delivered-outreach provenance read
 * only the RFB outreach_sent_log, never experience_outreach_sent_log.
 *
 * New tier outreach_delivered (services/gardssalg-claim.ts,
 * findOpplevagentOutreachClaimEmail):
 *   d  pure derivation: added last, deduped, Brreg gate and shape check kept.
 *   o  lookup: real delivery for the same provider -> eligible with that
 *      address; bounce/complaint, dry-run, test send, unconfirmed reservation,
 *      missing message id, another provider's row -> not; unsubscribe is not
 *      a bounce; latest non-bounced delivery wins; a stored epost is the only
 *      address that can qualify when present; shared mailbox -> not; lookup
 *      errors fail closed and the RFB db is not read without a delivery.
 *   r  routes: GET shows «Send meg tilgangslenke» with a masked address, POST
 *      issues the claim to the outreach address (outreach_delivered); a
 *      two-candidate page lets the producer pick it; bounced -> fallback.
 *   x  unchanged: stronger tiers keep priority, Brreg gate, rate limit,
 *      admin grant's already-claimed guard.
 *
 * Real router + claim service on the production schema (in-memory
 * experiences db via db-factory, in-memory RFB db via __setRfbDbForTesting),
 * real http.Server like routes/gardssalg-claim.test.ts. No network (harvest
 * fetch stubbed), no mail (sendGardssalgClaimMagicLink stubbed).
 * Exported runGardssalgClaimOutreachDeliveredOa01Tests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/gardssalg-claim-outreach-delivered-oa01.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runGardssalgClaimOutreachDeliveredOa01Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string): void { assertEq(!!cond, true, label); }

  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const claimSvcPath = require.resolve("../services/gardssalg-claim");
  const routerPath = require.resolve("./gardssalg-claim");
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([dbFactoryPath, claimSvcPath, routerPath]);

  const initMod = require("../database/init") as typeof import("../database/init");
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const rfbDb = new Database(":memory:");
  const emailSvcMod = require("../services/email-service") as typeof import("../services/email-service");
  const origSendClaimLink = emailSvcMod.emailService.sendGardssalgClaimMagicLink;
  const sentClaimLinks: string[] = [];
  const prevWarn = console.warn;
  const warnLog: string[] = [];
  let server: any = null;

  try {
    initMod.__initSchemaForTesting(rfbDb as any);
    (emailSvcMod.emailService as any).sendGardssalgClaimMagicLink = async (o: { to: string }) => {
      sentClaimLinks.push(o.to);
      return { success: true, messageId: "oa01-mock" };
    };

    const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
    claimSvc.__setRfbDbForTesting(rfbDb as any);
    // Harvest fetch: only two-gard.no publishes an address; every other site
    // is an email-free page (most fixtures have no hjemmeside at all).
    claimSvc.__setClaimHarvestFetchForTesting(((async (input: unknown) => {
      const url = String(input);
      const html = url.startsWith("https://two-gard.no")
        ? "<html><body><p>Kontakt: kontakt@two-gard.no</p></body></html>"
        : "<html><body><h1>Ingen kontaktinfo</h1></body></html>";
      const bytes = new TextEncoder().encode(html);
      return {
        ok: true, status: 200, statusText: "S200", url,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }) as unknown) as typeof fetch);
    claimSvc.__resetClaimHarvestCacheForTesting();

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const expDb = dbFactory.getDb("experiences");

    // ── Fixtures ──────────────────────────────────────────────────────────
    const insertProvider = expDb.prepare(`
      INSERT INTO experience_providers
        (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance, epost,
         enrichment_state, verification_status, source, confidence)
      VALUES
        (@id, @navn, @slug, 'experiences', @org_nr, @brreg_verified, @hjemmeside, @content_source, @field_provenance, @epost,
         'raw', 'pending_verify', 'test-fixture', 'medium')
    `);
    let orgSeq = 913000000;
    function provider(id: string, o: { epost?: string | null; brreg_verified?: number; content_source?: string | null; hjemmeside?: string | null; field_provenance?: string | null } = {}): void {
      insertProvider.run({
        id, navn: `Gård ${id}`, slug: id, org_nr: String(orgSeq++), brreg_verified: o.brreg_verified ?? 1,
        hjemmeside: o.hjemmeside ?? null, content_source: o.content_source === undefined ? "provider_site" : o.content_source,
        field_provenance: o.field_provenance ?? null, epost: o.epost ?? null,
      });
    }
    const insertSent = expDb.prepare(`
      INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, message_id, notes, is_test)
      VALUES (@provider_id, @recipient_email, @sent_at, 'email', @message_id, @notes, @is_test)
    `);
    let msgSeq = 0;
    function sent(providerId: string, email: string, o: { sent_at?: string; message_id?: string | null; notes?: string | null; is_test?: number } = {}): void {
      insertSent.run({
        provider_id: providerId, recipient_email: email, sent_at: o.sent_at ?? "2026-10-15 09:00:00",
        message_id: o.message_id === undefined ? `<oa01-${++msgSeq}@rettfrabonden.com>` : o.message_id,
        notes: o.notes ?? null, is_test: o.is_test ?? 0,
      });
    }
    const insertBounce = rfbDb.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES (?, '2026-10-16 10:00:00', ?)`);

    provider("oa-nolisted");
    sent("oa-nolisted", "eier@nolisted-gard.no");
    provider("oa-listed-match", { epost: " Post@Listed-Gard.no " });
    sent("oa-listed-match", "post@listed-gard.no");
    provider("oa-listed-moved", { epost: "ny@moved-gard.no" });
    sent("oa-listed-moved", "gammel@moved-gard.no");
    provider("oa-bounced");
    sent("oa-bounced", "borte@bounced-gard.no");
    insertBounce.run("borte@bounced-gard.no", "hard");
    provider("oa-complaint");
    sent("oa-complaint", "klage@complaint-gard.no");
    insertBounce.run("Klage@Complaint-Gard.no", "complaint");
    provider("oa-legacy-bounce");
    sent("oa-legacy-bounce", "gml@legacy-gard.no");
    insertBounce.run("gml@legacy-gard.no", null);
    provider("oa-unsub");
    sent("oa-unsub", "avmeldt@unsub-gard.no");
    insertBounce.run("avmeldt@unsub-gard.no", "unsubscribe");
    provider("oa-dryrun");
    sent("oa-dryrun", "dry@dryrun-gard.no", { message_id: "DRY_RUN" });
    provider("oa-testsend");
    sent("oa-testsend", "test@testsend-gard.no", { is_test: 1 });
    provider("oa-reserved");
    sent("oa-reserved", "res@reserved-gard.no", { message_id: null, notes: "reserved" });
    provider("oa-noid");
    sent("oa-noid", "noid@noid-gard.no", { message_id: null });
    provider("oa-other");
    // Newer delivery inserted FIRST (lower id): order is by sent_at, not id.
    provider("oa-latest");
    sent("oa-latest", "ny@latest-gard.no", { sent_at: "2026-10-20 10:00:00" });
    sent("oa-latest", "gammel@latest-gard.no", { sent_at: "2026-09-01 10:00:00" });
    provider("oa-latest-bounced");
    sent("oa-latest-bounced", "gammel@lb-gard.no", { sent_at: "2026-09-01 10:00:00" });
    sent("oa-latest-bounced", "ny@lb-gard.no", { sent_at: "2026-10-20T10:00:00.000Z" });
    insertBounce.run("ny@lb-gard.no", "hard");
    provider("oa-shared-a");
    provider("oa-shared-b");
    sent("oa-shared-a", "felles@shared-gard.no");
    sent("oa-shared-b", "felles@shared-gard.no", { sent_at: "2026-10-18 09:00:00" });
    provider("oa-solo");
    provider("oa-solo-twin");
    sent("oa-solo", "solo@solo-gard.no");
    sent("oa-solo-twin", "solo@solo-gard.no", { is_test: 1 });
    provider("oa-not-brreg", { brreg_verified: 0 });
    sent("oa-not-brreg", "eier@notbrreg-gard.no");
    provider("oa-manual-same", { epost: "post@manual-gard.no", content_source: "manual" });
    sent("oa-manual-same", "post@manual-gard.no");
    provider("oa-two", {
      hjemmeside: "https://two-gard.no",
      field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/two-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
    });
    sent("oa-two", "eier@two-gard-post.no");
    provider("oa-ratelimit");
    sent("oa-ratelimit", "eier@ratelimit-gard.no");
    provider("oa-claimed", { content_source: "claim" });
    sent("oa-claimed", "eier@claimed-gard.no");
    expDb.prepare(
      `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, created_at, expires_at, is_test)
       VALUES ('gsc_oa01claimed', 'oa-claimed', 'eier@claimed-gard.no', 'manual', 'oa01-claimed-token', 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z', 0)`,
    ).run();

    const row = (id: string) => claimSvc.getClaimProviderById(id)!;
    const oaEmail = (id: string) => claimSvc.findOpplevagentOutreachClaimEmail(row(id));
    const candidates = (id: string) => claimSvc.deriveOrgLinkedEmailCandidatesWithHarvest(row(id), undefined, { cacheKey: id });

    // ── d: pure derivation ────────────────────────────────────────────────
    const pureBase = { org_nr: "913999999", brreg_verified: 1, hjemmeside: null, content_source: null, field_provenance: null };
    assertEq(
      claimSvc.deriveOrgLinkedEmailCandidates(pureBase, null, { opplevagentOutreachEmail: " Eier@Gard.NO " }),
      [{ email: "eier@gard.no", source: "outreach_delivered" }],
      "d1: an outreach address the lookup proved is a candidate (normalized), tagged outreach_delivered",
    );
    assertEq(
      claimSvc.deriveOrgLinkedEmailCandidates({ ...pureBase, brreg_verified: 0 }, null, { opplevagentOutreachEmail: "eier@gard.no" }),
      [],
      "d2: the Brreg baseline still applies to the new tier",
    );
    assertEq(
      claimSvc.deriveOrgLinkedEmailCandidates({ ...pureBase, content_source: "manual", epost: "post@gard.no" }, null, { opplevagentOutreachEmail: "eier@gard.no" }),
      [{ email: "post@gard.no", source: "stored_epost_verified" }, { email: "eier@gard.no", source: "outreach_delivered" }],
      "d3: ranked LAST, after stored_epost_verified",
    );
    assertEq(
      claimSvc.deriveOrgLinkedEmailCandidates({ ...pureBase, content_source: "manual", epost: "post@gard.no" }, null, { opplevagentOutreachEmail: "POST@gard.no" }),
      [{ email: "post@gard.no", source: "stored_epost_verified" }],
      "d4: the same address is never offered twice — the stronger tier keeps it",
    );
    assertEq(
      claimSvc.deriveOrgLinkedEmailCandidates(pureBase, null, { opplevagentOutreachEmail: "ikke-en-adresse" }),
      [],
      "d5: a malformed address is never a candidate",
    );
    assertEq(
      claimSvc.deriveOrgLinkedEmail(pureBase, null, { opplevagentOutreachEmail: "eier@gard.no" }),
      { eligible: true, email: "eier@gard.no", source: "outreach_delivered" },
      "d6: single-answer form takes it when it is the only tier",
    );

    // ── o: lookup ────────────────────────────────────────────────────────
    assertEq(oaEmail("oa-nolisted"), "eier@nolisted-gard.no", "o1: no stored epost + a real delivered outreach -> that address");
    assertEq(oaEmail("oa-listed-match"), "post@listed-gard.no", "o2: stored epost that outreach was delivered to -> qualifies (case/whitespace-insensitive)");
    assertEq(oaEmail("oa-listed-moved"), null, "o3: stored epost differs from every delivered address -> an old outreach address is never used");
    assertEq(oaEmail("oa-bounced"), null, "o4: hard-bounced address -> not eligible via outreach");
    assertEq(oaEmail("oa-complaint"), null, "o5: complaint (bounce row in another case) -> not eligible");
    assertEq(oaEmail("oa-legacy-bounce"), null, "o6: untyped legacy bounce row -> not eligible");
    assertEq(oaEmail("oa-unsub"), "avmeldt@unsub-gard.no", "o7: an unsubscribe is not a bounce (same rule as the RFB twin)");
    assertEq(oaEmail("oa-dryrun"), null, "o8: dry-run row (message_id DRY_RUN) -> not");
    assertEq(oaEmail("oa-testsend"), null, "o9: test send (is_test=1) -> not");
    assertEq(oaEmail("oa-reserved"), null, "o10: unconfirmed reservation (outcome unknown) -> not");
    assertEq(oaEmail("oa-noid"), null, "o11: no transport message id -> not");
    assertEq(oaEmail("oa-other"), null, "o12: rows for OTHER providers never count for this one");
    assertEq(oaEmail("oa-latest"), "ny@latest-gard.no", "o13: the latest real delivery wins (by sent_at, not insert order)");
    assertEq(oaEmail("oa-latest-bounced"), "gammel@lb-gard.no", "o14: latest delivery bounced -> the latest one without a bounce (mixed sent_at formats)");
    assertEq(oaEmail("oa-shared-a"), null, "o15: address also delivered to for another provider (shared mailbox) -> not, provider A");
    assertEq(oaEmail("oa-shared-b"), null, "o16: ... nor provider B");
    assertEq(oaEmail("oa-solo"), "solo@solo-gard.no", "o17: another provider's TEST send to the address does not make it shared");
    assertEq(claimSvc.findOpplevagentOutreachClaimEmail({ epost: null }), null, "o18: no provider id -> no lookup, null");

    // Lazy + fail-closed on the RFB db.
    console.warn = (...a: unknown[]) => { warnLog.push(a.map(String).join(" ")); };
    claimSvc.__setRfbDbForTesting({ prepare() { throw new Error("rfb db unavailable"); } } as any);
    assertEq(oaEmail("oa-other"), null, "o19: no delivery -> RFB db never read (a throwing RFB db is not even touched)");
    assertEq(warnLog.length, 0, "o20: ... and nothing is logged");
    assertEq(oaEmail("oa-nolisted"), null, "o21: lookup error -> fails closed (no candidate)");
    assertTrue(warnLog.some((l) => l.includes("Opplevagent outreach lookup failed for oa-nolisted")), "o22: ... with a [gardssalg-claim] warning");
    claimSvc.__setRfbDbForTesting(rfbDb as any);
    console.warn = prevWarn;

    // ── Through the shared derivation the page and the POST use ─────────────
    assertEq(await candidates("oa-nolisted"), [{ email: "eier@nolisted-gard.no", source: "outreach_delivered" }], "o23: deriveOrgLinkedEmailCandidatesWithHarvest offers it");
    assertEq(await candidates("oa-bounced"), [], "o24: bounced -> zero candidates (manual fallback)");
    assertEq(await candidates("oa-not-brreg"), [], "o25: not Brreg-verified -> zero candidates even with a delivery");
    assertEq(
      claimSvc.deriveOrgLinkedEmailWithOutreachLookup(row("oa-nolisted")),
      { eligible: true, email: "eier@nolisted-gard.no", source: "outreach_delivered" },
      "o26: single-answer wrapper agrees",
    );

    // ── x: unchanged rules ───────────────────────────────────────────────
    assertEq(await candidates("oa-manual-same"), [{ email: "post@manual-gard.no", source: "stored_epost_verified" }], "x1: existing stored_epost_verified keeps the address (no duplicate outreach_delivered)");
    assertEq(
      await candidates("oa-two"),
      [{ email: "kontakt@two-gard.no", source: "found_same_domain" }, { email: "eier@two-gard-post.no", source: "outreach_delivered" }],
      "x2: a found-tier address keeps first place; outreach_delivered is added after it",
    );
    assertEq(await claimSvc.issueClaimMagicLink("oa-not-brreg"), { ok: false, error: "not_brreg_verified" }, "x3: issueClaimMagicLink still refuses a non-Brreg provider");
    const rl: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await claimSvc.issueClaimMagicLink("oa-ratelimit");
      rl.push(r.ok ? `ok:${r.claim.email}:${r.claim.source}` : r.error);
    }
    assertEq(
      rl,
      ["ok:eier@ratelimit-gard.no:outreach_delivered", "ok:eier@ratelimit-gard.no:outreach_delivered", "ok:eier@ratelimit-gard.no:outreach_delivered", "rate_limited"],
      "x4: outreach_delivered claims go to the outreach address and obey the 3/hour rate limit",
    );
    assertEq(claimSvc.issueAdminGrantedClaimMagicLink("oa-claimed", "eier@claimed-gard.no"), { ok: false, error: "already_claimed" }, "x5: admin grant still refuses an already-claimed provider");
    assertTrue(claimSvc.isGardssalgProviderClaimed("oa-claimed"), "x6: claimed status is untouched by the lookup");

    // ── r: routes ────────────────────────────────────────────────────────
    const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
    const expressMod = require("express") as typeof import("express");
    const app = expressMod();
    app.use(expressMod.json());
    app.use("/", routerMod.default);
    const httpMod = require("http") as typeof import("http");
    server = httpMod.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const r = httpMod.request(
          { method, host: "127.0.0.1", port, path: urlPath, headers: payload ? { "content-type": "application/json" } : {} },
          (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    }

    const page = await req("GET", "/kategori/gardssalg/eier/oa-nolisted");
    assertEq(page.status, 200, "r1: claim page for an outreach-reached producer -> 200");
    assertTrue(page.body.includes("Send meg tilgangslenke"), "r2: shows «Send meg tilgangslenke», not the manual fallback");
    assertTrue(!page.body.includes("Vi kan ikke bekrefte automatisk"), "r3: the fallback block is gone");
    assertTrue(page.body.includes(claimSvc.maskEmail("eier@nolisted-gard.no")), "r4: shows the masked outreach address");
    assertTrue(!page.body.includes("eier@nolisted-gard.no"), "r5: never the full address");

    const post = await req("POST", "/kategori/gardssalg/eier/oa-nolisted/request", {});
    assertEq(post.status, 200, "r6: POST request -> 200");
    assertTrue(JSON.parse(post.body).success === true, "r7: ... success");
    const claimRow = expDb
      .prepare(`SELECT email, email_source FROM gardssalg_claims WHERE provider_id = 'oa-nolisted' ORDER BY created_at DESC LIMIT 1`)
      .get() as { email: string; email_source: string } | undefined;
    assertEq(claimRow, { email: "eier@nolisted-gard.no", email_source: "outreach_delivered" }, "r8: claim row goes to the outreach address, audited as outreach_delivered");
    await new Promise((resolve) => setImmediate(resolve));
    assertEq(sentClaimLinks.filter((t) => t === "eier@nolisted-gard.no").length, 1, "r9: the magic link is sent to that address");

    const bouncedPage = await req("GET", "/kategori/gardssalg/eier/oa-bounced");
    assertTrue(!bouncedPage.body.includes("Send meg tilgangslenke") && bouncedPage.body.includes("Vi kan ikke bekrefte automatisk"), "r10: bounced producer still gets the manual fallback");

    const twoPage = await req("GET", "/kategori/gardssalg/eier/oa-two");
    assertTrue(twoPage.body.includes('value="found_same_domain"') && twoPage.body.includes('value="outreach_delivered"'), "r11: two candidates -> both offered as choices");
    const twoNoChoice = await req("POST", "/kategori/gardssalg/eier/oa-two/request", {});
    assertEq([twoNoChoice.status, JSON.parse(twoNoChoice.body).error], [400, "selection_required"], "r12: no choice -> selection_required (unchanged)");
    const twoChoice = await req("POST", "/kategori/gardssalg/eier/oa-two/request", { selected: "outreach_delivered" });
    assertEq(twoChoice.status, 200, "r13: picking outreach_delivered is accepted by the route allow-list");
    const twoRow = expDb
      .prepare(`SELECT email, email_source FROM gardssalg_claims WHERE provider_id = 'oa-two' ORDER BY created_at DESC LIMIT 1`)
      .get() as { email: string; email_source: string } | undefined;
    assertEq(twoRow, { email: "eier@two-gard-post.no", email_source: "outreach_delivered" }, "r14: ... and the claim goes to the outreach address");
  } catch (err: any) {
    failed++;
    failures.push("gardssalg-claim-outreach-delivered-oa01: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.warn = prevWarn;
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
    (emailSvcMod.emailService as any).sendGardssalgClaimMagicLink = origSendClaimLink;
    try {
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvc.__setRfbDbForTesting(null);
      claimSvc.__setClaimHarvestFetchForTesting(undefined);
      claimSvc.__resetClaimHarvestCacheForTesting();
    } catch { /* ignore */ }
    try { rfbDb.close(); } catch { /* already closed */ }
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch { /* ignore */ }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/gardssalg-claim-outreach-delivered-oa01.test.ts`
if (require.main === module) {
  console.log("── gardssalg-claim-outreach-delivered-oa01 ──");
  runGardssalgClaimOutreachDeliveredOa01Tests({ log: true }).then((r) => {
    console.log(`\ngardssalg-claim-outreach-delivered-oa01: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
