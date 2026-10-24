/**
 * opplevelser-gardssalg-owner-email-confirm.test.ts — slice 1 of dev-request
 * 2026-10-22-opplevagent-takksvar-eierlenke-og-bekreftet-av-eier:
 *
 *   POST /api/opplevelser/admin/gardssalg-owner-email-confirm  (opplevelser.ts)
 *   services/gardssalg-owner-email-confirm.ts
 *   "Bekreftet av eier" display on /kategori/gardssalg/produsent/:slug
 *   withdrawal through POST /admin/gardssalg-provider-visibility ("fjern oss")
 *
 * AC1  the lever stamps the confirmation for an address the claim flow accepts
 *      for THIS producer and rejects others — also another address on the same
 *      domain, and an address that is accepted for a different producer.
 * AC2  the profile shows the badge for an e-mail-confirmed producer AND keeps
 *      the "Ta over profilen" link; a taken-over profile looks as before.
 * AC3  a confirmed field is locked, so a later content write is refused
 *      (existing owner-lock check); manual/claim locks are never downgraded.
 * AC4  "fjern" clears the confirmation together with the profile; an admin
 *      can reset it.
 *
 * Same in-memory-DB + synthetic router.handle() harness as the claim-revoke
 * and claimed-badge suites. No network: the provider fixtures have no
 * hjemmeside, so the harvest tiers never fetch.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callPost(router: any, url: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST", url, originalUrl: url, path: url, query: {}, headers, body, get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function callHtml(router: any, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET", url, originalUrl: url, path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {}, lang: "no", get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() {},
      send(body: unknown) { resolve({ status: this.statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => resolve({ status: 500, body: err ? String(err) : "" }));
  });
}

export function runOpplevelserGardssalgOwnerEmailConfirmTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "owner-email-confirm-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const paths = [
      "../database/db-factory",
      "../database/init-experiences",
      "../services/experience-store",
      "../services/gardssalg-claim",
      "../services/gardssalg-owner-email-confirm",
      "../services/email-service",
      "./experiences-seo",
      "./opplevelser",
    ].map((p) => require.resolve(p));
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    let claimSvc: any = null;
    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      // The "delivered outreach, no bounce" tier of the claim flow reads the
      // RFB db; hand it a standalone in-memory one (never the global singleton).
      claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const rfbDb = new Database(":memory:");
      initMod.__initSchemaForTesting(rfbDb as any);
      claimSvc.__setRfbDbForTesting(rfbDb as any);
      rfbDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('agent-oec', 'Fixture', 'x', 'test', 'a@example.no', 'https://example.no', 'producer', 'oec-key', 1)`,
      ).run();
      for (const addr of ["eier@okgard.no", "eier@annengard.no", "eier@overtattgard.no"]) {
        rfbDb.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
           VALUES ('agent-oec', ?, datetime('now', '-2 days'), 'email', 'experiences')`,
        ).run(addr);
      }

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence,
            claimed_at, org_nr, brreg_verified, epost, content_source, about_text)
         VALUES
           (@id, @navn, 'experiences', 'Telemark', 'Skien', 'Skien', 'bryggeri', NULL, NULL, @lat, @lon,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium',
            @claimed_at, @org_nr, @brreg_verified, @epost, @content_source, 'Opprinnelig om-tekst')`,
      );
      const mk = (o: Record<string, unknown>) =>
        insertProvider.run({ claimed_at: null, org_nr: null, brreg_verified: null, epost: null, content_source: null, ...o });

      mk({ id: "oec-ok", navn: "Ok Gard", slug: "ok-gard", lat: 59.31, lon: 9.71, org_nr: "911111111", brreg_verified: 1, epost: "eier@okgard.no" });
      mk({ id: "oec-other", navn: "Annen Gard", slug: "annen-gard", lat: 59.32, lon: 9.72, org_nr: "922222222", brreg_verified: 1, epost: "eier@annengard.no" });
      mk({ id: "oec-manual", navn: "Manuell Gard", slug: "manuell-gard", lat: 59.33, lon: 9.73, org_nr: "933333333", brreg_verified: 1, epost: "eier@manuellgard.no", content_source: "manual" });
      mk({ id: "oec-unverified", navn: "Uverifisert Gard", slug: "uverifisert-gard", lat: 59.34, lon: 9.74, org_nr: "944444444", brreg_verified: 0, epost: "eier@okgard.no" });
      mk({ id: "oec-claimed", navn: "Overtatt Gard", slug: "overtatt-gard", lat: 59.35, lon: 9.75, claimed_at: "2026-07-15T09:00:00.000Z", content_source: "claim", org_nr: "955555555", brreg_verified: 1, epost: "eier@overtattgard.no" });
      mk({ id: "oec-plain", navn: "Vanlig Gard", slug: "vanlig-gard", lat: 59.36, lon: 9.76 });
      mk({ id: "oec-remove", navn: "Fjern Gard", slug: "fjern-gard", lat: 59.37, lon: 9.77, org_nr: "966666666", brreg_verified: 1, epost: "eier@okgard.no" });

      const auth = { "x-admin-key": testKey };
      const URL_ = "/admin/gardssalg-owner-email-confirm";
      const row = (id: string): any =>
        db.prepare(
          `SELECT claimed_at, content_source, owner_email_confirmed_at, owner_email_confirmed_email, owner_email_confirmed_thread,
                  field_provenance, about_text, catalog_hidden FROM experience_providers WHERE id = ?`,
        ).get(id);
      const audit = (id: string, field: string): any[] =>
        db.prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = ?`).all(id, field);

      // ── auth + validation ─────────────────────────────────────────────
      assertEq((await callPost(opplevelserRouter, URL_, {}, { provider_id: "oec-ok" })).status, 403, "a1: missing admin key -> 403");
      assertEq((await callPost(opplevelserRouter, URL_, auth, {})).body.error, "provider_id_required", "a2: provider_id required");
      assertEq((await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok" })).body.error, "sender_email_required", "a3: sender_email required");
      assertEq((await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "eier@okgard.no" })).body.error, "thread_id_required", "a4: thread_id required");
      assertEq(
        (await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "eier@okgard.no", thread_id: "t1", confirmed_fields: ["epost"] })).body.error,
        "invalid_confirmed_fields", "a5: a field outside the lockable vocabulary is refused",
      );
      assertEq((await callPost(opplevelserRouter, URL_, auth, { provider_id: "nope", sender_email: "eier@okgard.no", thread_id: "t1" })).status, 404, "a6: unknown provider -> 404");

      // ── AC1: rejections (each with a reason, nothing written) ─────────
      const sameDomain = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "annen@okgard.no", thread_id: "t1", apply: true });
      assertEq([sameDomain.status, sameDomain.body.error], [422, "sender_not_accepted"], "b1: another address on the SAME domain the claim flow does not accept -> rejected");
      const foreign = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "eier@annengard.no", thread_id: "t1", apply: true });
      assertEq([foreign.status, foreign.body.error], [422, "sender_not_accepted"], "b2: an address accepted for ANOTHER producer is rejected for this one");
      const gmail = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "noen@gmail.com", thread_id: "t1", apply: true });
      assertEq(gmail.body.error, "sender_not_accepted", "b3: a free-mail address that is not a candidate is rejected");
      const unverified = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-unverified", sender_email: "eier@okgard.no", thread_id: "t1", apply: true });
      assertEq(unverified.body.error, "not_brreg_verified", "b4: a producer that is not Brreg-verified is rejected");
      const nonsense = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "ikke-en-adresse", thread_id: "t1", apply: true });
      assertEq([nonsense.status, nonsense.body.error], [400, "invalid_sender"], "b5: a malformed sender -> 400 invalid_sender");
      const noCandidate = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-plain", sender_email: "eier@okgard.no", thread_id: "t1", apply: true });
      assertEq(noCandidate.body.error, "not_brreg_verified", "b6: a producer with no org-linked basis is rejected");
      assertEq(row("oec-ok").owner_email_confirmed_at, null, "b7: none of the rejections wrote anything");
      assertEq(audit("oec-ok", "owner_email_confirmed_at").length, 0, "b8: ...and no audit row");

      // ── AC1: dry-run default, then apply ──────────────────────────────
      const dry = await callPost(opplevelserRouter, URL_, auth, {
        provider_id: "oec-ok", sender_email: "Eier@OkGard.no", thread_id: "thr-1", confirmed_fields: ["about_text"],
      });
      assertEq(dry.status, 200, "c1: accepted sender, no apply -> 200");
      assertEq(dry.body.dry_run, true, "c2: dry-run is the default");
      assertEq(dry.body.accepted_source, "stored_epost_verified", "c3: reports which claim-flow tier accepted the sender");
      assertTrue(!JSON.stringify(dry.body).includes("eier@okgard.no"), "c4: the sender address is masked in the response");
      assertEq(dry.body.fields, [{ field: "about_text", action: "lock" }], "c5: dry-run plans the field lock");
      assertEq(row("oec-ok").owner_email_confirmed_at, null, "c6: dry-run writes nothing");
      assertTrue(!(row("oec-ok").field_provenance || "").includes("owner_locks"), "c7: dry-run locks nothing");

      const strictApply = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", sender_email: "eier@okgard.no", thread_id: "thr-1", apply: "true" });
      assertEq(strictApply.body.dry_run, true, "c8: apply must be the literal boolean true");

      const applied = await callPost(opplevelserRouter, URL_, auth, {
        provider_id: "oec-ok", sender_email: "Eier@OkGard.no", thread_id: "thr-1", confirmed_fields: ["about_text"], apply: true,
      });
      assertEq([applied.status, applied.body.dry_run], [200, false], "d1: apply:true writes");
      const after = row("oec-ok");
      assertTrue(typeof after.owner_email_confirmed_at === "string" && after.owner_email_confirmed_at.length > 0, "d2: owner_email_confirmed_at is set");
      assertEq(after.owner_email_confirmed_email, "eier@okgard.no", "d3: the sender is stored normalised as evidence");
      assertEq(after.owner_email_confirmed_thread, "thr-1", "d4: the CRM thread id is stored");
      assertEq(after.claimed_at, null, "d5: claimed_at is NOT touched");
      assertEq(after.content_source, null, "d6: content_source is NOT touched");
      assertEq(audit("oec-ok", "owner_email_confirmed_at").length, 1, "d7: one audit row for the confirmation");
      assertEq(audit("oec-ok", "owner_email_confirmed_at")[0].source_url, "crm-thread:thr-1", "d8: ...pointing at the thread");

      // AC3: the confirmed field is locked -> a content write is refused.
      const lockedProv = JSON.parse(after.field_provenance).owner_locks.about_text;
      assertEq(lockedProv.locked_by, "admin", "e1: about_text carries the existing admin field lock");
      assertTrue(store.isGardssalgFieldOwnerLocked(after, "about_text"), "e2: the existing lock check now reports about_text locked");
      assertTrue(!store.isGardssalgFieldOwnerLocked(after, "visit_text"), "e3: an unconfirmed field stays unlocked");
      const overwrite = store.applyGardssalgSetContentField("oec-ok", "about_text", "Berikelsen vil overskrive dette", "enrichment");
      assertEq(overwrite.ok, false, "e4: a content write to the confirmed field is refused");
      assertEq((overwrite as any).reason, "owner_locked", "e5: ...as owner_locked");
      assertEq(row("oec-ok").about_text, "Opprinnelig om-tekst", "e6: the confirmed text is unchanged");

      // Idempotent: the first confirmation timestamp is kept.
      const firstAt = after.owner_email_confirmed_at;
      const again = await callPost(opplevelserRouter, URL_, auth, {
        provider_id: "oec-ok", sender_email: "eier@okgard.no", thread_id: "thr-2", confirmed_fields: ["about_text", "visit_text"], apply: true,
      });
      assertEq(again.body.already_confirmed, true, "f1: a second confirmation reports already_confirmed");
      assertEq(row("oec-ok").owner_email_confirmed_at, firstAt, "f2: the first timestamp is kept");
      assertEq(row("oec-ok").owner_email_confirmed_thread, "thr-1", "f3: ...and the first thread");
      assertEq(audit("oec-ok", "owner_email_confirmed_at").length, 1, "f4: no second confirmation audit row");
      assertEq(again.body.fields, [
        { field: "about_text", action: "already_locked", reason: "field_locked" },
        { field: "visit_text", action: "lock" },
      ], "f5: an existing lock is left alone, a new field is locked");
      assertEq(JSON.parse(row("oec-ok").field_provenance).owner_locks.about_text.locked_at, lockedProv.locked_at, "f6: the existing lock entry was not rewritten");

      // AC3: a manual/claim lock is never downgraded; claimed_at never touched.
      const manual = await callPost(opplevelserRouter, URL_, auth, {
        provider_id: "oec-manual", sender_email: "eier@manuellgard.no", thread_id: "thr-m", confirmed_fields: ["about_text"], apply: true,
      });
      assertEq(manual.body.success, true, "g1: a manual-locked row can still be confirmed");
      assertEq(manual.body.fields, [{ field: "about_text", action: "already_locked", reason: "row_locked_manual_or_claim" }], "g2: its field is reported already locked");
      assertEq(row("oec-manual").content_source, "manual", "g3: the manual lock is not downgraded");
      assertTrue(!(row("oec-manual").field_provenance || "").includes("owner_locks"), "g4: no admin lock is layered onto the manual row");
      const claimed = await callPost(opplevelserRouter, URL_, auth, {
        provider_id: "oec-claimed", sender_email: "eier@overtattgard.no", thread_id: "thr-c", confirmed_fields: ["products"], apply: true,
      });
      assertEq(claimed.body.fields, [{ field: "products", action: "already_locked", reason: "row_locked_manual_or_claim" }], "g5: a claim-locked row keeps its lock (nothing layered on)");
      assertTrue(!(row("oec-claimed").field_provenance || "").includes("owner_locks"), "g5b: no admin lock written to the claim row");
      assertEq(row("oec-claimed").content_source, "claim", "g6: the claim lock is untouched");
      assertEq(row("oec-claimed").claimed_at, "2026-07-15T09:00:00.000Z", "g7: claimed_at is untouched");

      // ── AC2: display ──────────────────────────────────────────────────
      const BADGE = "Bekreftet av eier";
      {
        const r = await callHtml(seoRouter, "/kategori/gardssalg/produsent/ok-gard");
        assertEq(r.status, 200, "h1: the e-mail-confirmed profile renders");
        assertTrue(r.body.includes(BADGE), "h2: it shows «Bekreftet av eier»");
        assertTrue(r.body.includes('href="/kategori/gardssalg/eier/ok-gard"') && r.body.includes(">Ta over profilen<"), "h3: ...and keeps the «Ta over profilen» link");
        assertTrue(!r.body.includes('>Logg inn</a>'), "h4: ...without the owner «Logg inn» link");
        assertTrue(!r.body.includes("Driver du dette stedet?"), "h5: the plain claim card is replaced by the badge card");
      }
      {
        const r = await callHtml(seoRouter, "/kategori/gardssalg/produsent/overtatt-gard");
        assertTrue(r.body.includes(BADGE), "i1: a taken-over profile shows the badge");
        assertTrue(r.body.includes('href="/kategori/gardssalg/eier/overtatt-gard/portal"'), "i2: ...with «Logg inn» as before");
        assertTrue(!r.body.includes("Ta over profilen"), "i3: ...and no «Ta over profilen» link, as before");
      }
      {
        const r = await callHtml(seoRouter, "/kategori/gardssalg/produsent/vanlig-gard");
        assertTrue(!r.body.includes(BADGE), "j1: an unconfirmed profile has no badge");
        assertTrue(r.body.includes("Er dette din bedrift?"), "j2: ...and the claim card as before");
      }
      {
        const r = await callHtml(seoRouter, "/kategori/gardssalg");
        const count = (r.body.match(/Eier-bekreftet/g) || []).length;
        assertEq(count, 3, "k1: the catalogue marks the two e-mail-confirmed producers and the taken-over one (3), not the others");
      }
      assertTrue(store.gardssalgHasOwnerBadge({ claimed_at: null, owner_email_confirmed_at: "x" }), "k2: badge helper: e-mail basis");
      assertTrue(store.gardssalgHasOwnerBadge({ claimed_at: "x", owner_email_confirmed_at: null }), "k3: badge helper: claim basis");
      assertTrue(!store.gardssalgHasOwnerBadge({ claimed_at: null, owner_email_confirmed_at: null }), "k4: badge helper: neither");

      // ── AC4: withdrawal ───────────────────────────────────────────────
      await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-remove", sender_email: "eier@okgard.no", thread_id: "thr-r", apply: true });
      assertTrue(row("oec-remove").owner_email_confirmed_at != null, "l1: precondition: the producer is confirmed");
      const vis = "/admin/gardssalg-provider-visibility";
      const visDry = await callPost(opplevelserRouter, vis, auth, { providerIds: ["oec-remove"], hidden: true });
      assertEq(visDry.body.dry_run, true, "l2: «fjern» dry-run");
      assertTrue(row("oec-remove").owner_email_confirmed_at != null, "l3: a dry-run does not clear the confirmation");
      const visApply = await callPost(opplevelserRouter, vis, auth, { providerIds: ["oec-remove"], hidden: true, apply: true });
      assertEq(visApply.body.changed_count, 1, "l4: «fjern» apply hides the profile");
      assertEq(row("oec-remove").owner_email_confirmed_at, null, "l5: ...and the confirmation is cleared with it");
      assertEq(row("oec-remove").owner_email_confirmed_email, null, "l6: ...including the stored address");
      assertEq(audit("oec-remove", "owner_email_confirmed_at").length, 2, "l7: set + clear are both audited");
      const qualityHide = await callPost(opplevelserRouter, vis, auth, { providerIds: ["oec-ok"], hidden: true, mode: "quality", apply: true });
      assertEq(qualityHide.body.changed_count, 1, "l8: a quality-hide changes visibility");
      assertTrue(row("oec-ok").owner_email_confirmed_at != null, "l9: a quality-hide (not a removal request) keeps the confirmation");
      db.prepare(`UPDATE experience_providers SET catalog_hidden = NULL, catalog_hidden_reason = NULL WHERE id = 'oec-ok'`).run();
      const afterRemoval = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-remove", sender_email: "eier@okgard.no", thread_id: "thr-r2", apply: true });
      assertEq(afterRemoval.body.error, "provider_hidden", "l10: a removed (hidden) profile cannot be confirmed again");

      // Admin reset.
      const clearDry = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", clear: true });
      assertEq([clearDry.body.dry_run, clearDry.body.had_confirmation], [true, true], "m1: admin reset dry-run reports what would be cleared");
      assertTrue(row("oec-ok").owner_email_confirmed_at != null, "m2: ...and writes nothing");
      const clearApply = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", clear: true, apply: true });
      assertEq(clearApply.body.dry_run, false, "m3: admin reset apply");
      assertEq(row("oec-ok").owner_email_confirmed_at, null, "m4: the confirmation is gone");
      assertEq(row("oec-ok").claimed_at, null, "m5: claimed_at still untouched");
      assertTrue((row("oec-ok").field_provenance || "").includes("about_text"), "m6: the value locks stay (they protect values, not the badge)");
      const r = await callHtml(seoRouter, "/kategori/gardssalg/produsent/ok-gard");
      assertTrue(!r.body.includes(BADGE), "m7: the badge is gone from the profile");
      const clearAgain = await callPost(opplevelserRouter, URL_, auth, { provider_id: "oec-ok", clear: true, apply: true });
      assertEq(clearAgain.body.had_confirmation, false, "m8: resetting twice is a no-op");
      assertEq(audit("oec-ok", "owner_email_confirmed_at").length, 2, "m9: ...with no extra audit row");
    } catch (err) {
      failed++;
      failures.push(`✗ suite threw: ${(err as Error).stack || err}`);
    } finally {
      try { claimSvc?.__setRfbDbForTesting(null); } catch { /* ignore */ }
      restoreModuleCache();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOwnerEmailConfirmTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
