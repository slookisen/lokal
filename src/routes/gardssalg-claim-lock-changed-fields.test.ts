/**
 * gardssalg-claim-lock-changed-fields.test.ts — G1 pkt 2 of dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg: «Lås bare endrede felt».
 *
 * Covers:
 *   (s) service: updateClaimedProviderProfile with the FULL portal payload
 *       (the form always posts every field) where only visit_text differs
 *       from the stored value -> only visit_text is written, audited and
 *       locked; empty fields are not locked; a field changed to empty is
 *       written but not locked; an untouched over-long stored text is not
 *       truncated.
 *   (r) service: releaseClaimedProviderFieldLock removes the lock and writes
 *       exactly one audit row (field_name `<field>_lock`); no-op without a
 *       lock; refuses unknown fields, admin locks and manual rows; the
 *       content job's lock check (isGardssalgFieldOwnerLocked) sees the
 *       field as unlocked afterwards; the owner-lock backfill does not
 *       re-lock a released field.
 *   (h) HTTP: JSON release-field endpoint (401 / 403 / 400 / 200), no-JS
 *       release-field form route, portal shows the «gi tilbake» button only
 *       for locked fields, profile API lists owner_locked_fields.
 *
 * Exported runGardssalgClaimLockChangedFieldsTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim-lock-changed-fields.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimLockChangedFieldsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const storePath = require.resolve("../services/experience-store");
    const routerPath = require.resolve("./gardssalg-claim");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      dbFactoryPath,
      claimSvcPath,
      storePath,
      routerPath,
    ]);
    let server: any = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      const longText = "x".repeat(2100); // longer than the 2000-char sanitizer cap
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance,
           about_text, visit_text, opening_hours_text, products, booking_live,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, @hjemmeside, @content_source, @field_provenance,
           @about_text, @visit_text, @opening_hours_text, @products, @booking_live,
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertProvider.run({
        org_nr: "913000001", id: "prov-lc", navn: "Låsetest Gård", slug: "lasetest-gard",
        hjemmeside: "https://lasetest.no", content_source: "claim",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://x.no", fetched_at: "2026-07-01T00:00:00Z" } }),
        about_text: "  Om gården fra nettsiden.  ", visit_text: "Gammel besøkstekst", opening_hours_text: null,
        products: JSON.stringify(["Eplemost", "Sider"]), booking_live: 0,
      });
      insertProvider.run({
        org_nr: "913000002", id: "prov-long", navn: "Lang Tekst Gård", slug: "lang-tekst-gard",
        hjemmeside: null, content_source: "claim", field_provenance: null,
        about_text: longText, visit_text: "Besøk", opening_hours_text: "Lør 10-14",
        products: null, booking_live: 0,
      });
      insertProvider.run({
        org_nr: "913000003", id: "prov-manual-lc", navn: "Manuell Gård", slug: "manuell-gard",
        hjemmeside: null, content_source: "manual",
        field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }),
        about_text: "Kuratert", visit_text: null, opening_hours_text: null, products: null, booking_live: 0,
      });

      const readRow = (id: string) => expDb.prepare(
        "SELECT about_text, visit_text, opening_hours_text, products, hjemmeside, booking_live, content_source, field_provenance FROM experience_providers WHERE id = ?",
      ).get(id) as any;
      const locksOf = (id: string) => Object.keys(JSON.parse(readRow(id).field_provenance || "{}").owner_locks || {}).sort();
      const auditOf = (id: string) => expDb.prepare(
        "SELECT field_name, old_value, new_value, batch_id, changed_by FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid",
      ).all(id) as any[];

      // ── (s) only changed fields are locked ────────────────────────────
      // The exact payload shape the portal form posts: every field, the
      // untouched ones with their displayed (stored) values.
      const fullPayload = {
        about_text: "Om gården fra nettsiden.",
        visit_text: "Ny besøkstekst fra eieren",
        opening_hours_text: "",
        products: ["Eplemost", "Sider"],
        hjemmeside: "https://lasetest.no",
        booking_live: 0,
      };
      const s1 = claimSvc.updateClaimedProviderProfile("prov-lc", fullPayload);
      assertTrue("ok" in s1 && s1.ok === true, "s1: save with the full portal payload succeeds");
      if ("ok" in s1 && s1.ok) {
        assertEq(s1.updatedFields, ["visit_text"], "s2: only visit_text is reported as updated");
        assertEq(s1.lockedFields, ["visit_text"], "s3: only visit_text is reported as locked");
        assertEq(
          s1.unchangedFields.slice().sort(),
          ["about_text", "booking_live", "hjemmeside", "opening_hours_text", "products"],
          "s4: the five untouched fields are reported as unchanged (stored untrimmed about_text and empty opening hours count as equal)",
        );
      }
      assertEq(locksOf("prov-lc"), ["visit_text"], "s5: field_provenance.owner_locks holds visit_text only (not the empty opening_hours_text, not untouched fields)");
      const prov1 = JSON.parse(readRow("prov-lc").field_provenance);
      assertEq(prov1.hjemmeside, { source_url: "https://x.no", fetched_at: "2026-07-01T00:00:00Z" }, "s6: unrelated field_provenance keys survive");
      assertEq(readRow("prov-lc").visit_text, "Ny besøkstekst fra eieren", "s7: visit_text persisted");
      assertEq(readRow("prov-lc").about_text, "  Om gården fra nettsiden.  ", "s8: an unchanged field is not rewritten");
      assertEq(auditOf("prov-lc").map((r) => r.field_name), ["visit_text"], "s9: exactly one audit row, for visit_text");
      assertTrue(store.isGardssalgFieldOwnerLocked(readRow("prov-lc"), "visit_text"), "s10: content-job lock check: visit_text locked");
      assertTrue(!store.isGardssalgFieldOwnerLocked(readRow("prov-lc"), "about_text"), "s11: content-job lock check: untouched about_text stays open for Opplevagent");

      // Saving the same payload again changes nothing at all.
      const s2 = claimSvc.updateClaimedProviderProfile("prov-lc", fullPayload);
      if ("ok" in s2 && s2.ok) {
        assertEq(s2.updatedFields, [], "s12: an identical re-save updates nothing");
        assertEq(s2.lockedFields, [], "s13: an identical re-save locks nothing");
      }
      assertEq(auditOf("prov-lc").length, 1, "s14: an identical re-save writes no audit row");

      // A field changed TO empty is written but not locked.
      const s3 = claimSvc.updateClaimedProviderProfile("prov-lc", { ...fullPayload, about_text: "" });
      if ("ok" in s3 && s3.ok) {
        assertEq(s3.updatedFields, ["about_text"], "s15: clearing about_text is a change that is written");
        assertEq(s3.lockedFields, [], "s16: an emptied field is not locked");
      }
      assertEq(readRow("prov-lc").about_text, "", "s17: about_text cleared");
      assertEq(locksOf("prov-lc"), ["visit_text"], "s18: owner_locks unchanged after saving an empty field");

      // Untouched over-long stored text: not truncated, not locked.
      const s4 = claimSvc.updateClaimedProviderProfile("prov-long", {
        about_text: longText, visit_text: "Besøk", opening_hours_text: "Lør 10-14", products: [], hjemmeside: "", booking_live: 0,
      });
      if ("ok" in s4 && s4.ok) assertEq(s4.updatedFields, [], "s19: untouched over-long text counts as unchanged");
      assertEq(readRow("prov-long").about_text.length, 2100, "s20: untouched over-long stored text is not truncated by a save");
      assertEq(readRow("prov-long").field_provenance, null, "s21: no field_provenance write when nothing changed");

      // booking_live: a change is still written (consent toggle) — unchanged rule.
      const s5 = claimSvc.updateClaimedProviderProfile("prov-long", { booking_live: 1 });
      if ("ok" in s5 && s5.ok) assertEq(s5.updatedFields, ["booking_live"], "s22: a changed booking_live is written");

      // ── (r) «gi tilbake» ─────────────────────────────────────────────
      const r1 = claimSvc.releaseClaimedProviderFieldLock("prov-lc", "visit_text");
      assertEq(r1, { ok: true, field: "visit_text", released: true }, "r1: release of a locked field succeeds");
      assertEq(locksOf("prov-lc"), [], "r2: owner_locks.visit_text removed");
      assertTrue(!store.isGardssalgFieldOwnerLocked(readRow("prov-lc"), "visit_text"), "r3: content-job lock check: released visit_text is open again");
      const relRows = auditOf("prov-lc").filter((r) => r.field_name === "visit_text_lock");
      assertEq(relRows.length, 1, "r4: exactly one log row for the release");
      assertEq(
        relRows.map((r) => ({ b: r.batch_id, c: r.changed_by, n: r.new_value, o: !!JSON.parse(r.old_value).locked_at })),
        [{ b: "owner-portal-release", c: "owner", n: null, o: true }],
        "r5: the log row is attributed to the owner and keeps the prior lock",
      );
      assertEq(readRow("prov-lc").visit_text, "Ny besøkstekst fra eieren", "r6: release does not change the field's content");
      assertEq(JSON.parse(readRow("prov-lc").field_provenance).hjemmeside.source_url, "https://x.no", "r7: unrelated field_provenance keys survive a release");

      const r2 = claimSvc.releaseClaimedProviderFieldLock("prov-lc", "visit_text");
      assertEq(r2, { ok: true, field: "visit_text", released: false }, "r8: releasing an unlocked field is a no-op");
      assertEq(auditOf("prov-lc").filter((r) => r.field_name === "visit_text_lock").length, 1, "r9: a no-op release writes no log row");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-lc", "booking_live"), { ok: false, error: "unknown_field" }, "r10: booking_live cannot be released (not a content field)");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-lc", "epost"), { ok: false, error: "unknown_field" }, "r11: a non-portal field is refused");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-missing", "about_text"), { ok: false, error: "provider_not_found" }, "r12: missing provider");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-manual-lc", "about_text"), { ok: false, error: "locked_by_manual" }, "r13: a manual row cannot be released by the owner");

      store.applyGardssalgFieldLock("prov-lc", "products", true, "test");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-lc", "products"), { ok: false, error: "locked_by_admin" }, "r14: an Opplevagent-support lock cannot be released by the owner");
      assertEq(locksOf("prov-lc"), ["products"], "r15: the admin lock is still there");
      store.applyGardssalgFieldLock("prov-lc", "products", false, "test");

      // B2: backfill must not lock a field whose latest owner edit was empty.
      // prov-lc.about_text was saved as "" in s15 (owner audit row, new_value "")
      // and never re-locked since. Seed a matching empty-products owner row too.
      expDb.prepare(
        `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES ('aud-empty-products', 'prov-long', 'products', NULL, '[]', NULL, 'owner-portal', 'owner', datetime('now'))`,
      ).run();
      // Backfill must not re-lock a field the owner gave back.
      const bf = claimSvc.backfillGardssalgOwnerLockProvenance(true);
      assertTrue(!locksOf("prov-lc").includes("visit_text"), "r16: owner-lock backfill does not re-lock a released field");
      assertTrue(!locksOf("prov-lc").includes("visit_text_lock"), "r17: backfill ignores the synthetic <field>_lock audit rows");
      assertTrue(bf.skipped_released >= 1, "r18: backfill counts the released field as skipped_released");
      assertTrue(!locksOf("prov-lc").includes("about_text"), "r19: backfill does not lock about_text, which the owner last saved as empty");
      assertTrue(!locksOf("prov-long").includes("products"), "r20: backfill does not lock products, last saved as []");
      assertTrue(bf.skipped_empty >= 2, "r21: backfill counts empty-saved fields as skipped_empty");

      // B1: an Opplevagent-support lock survives an owner save of that field,
      // so «gi tilbake» is still refused.
      store.applyGardssalgFieldLock("prov-long", "visit_text", true, "test");
      const b1 = claimSvc.updateClaimedProviderProfile("prov-long", { visit_text: "Eieren skriver over" });
      if ("ok" in b1 && b1.ok) assertEq(b1.updatedFields, ["visit_text"], "b1: the owner's change is still written");
      const b1Lock = JSON.parse(readRow("prov-long").field_provenance).owner_locks.visit_text;
      assertEq(b1Lock.locked_by, "admin", "b2: the admin lock is not stamped over by the owner's save");
      assertEq(claimSvc.releaseClaimedProviderFieldLock("prov-long", "visit_text"), { ok: false, error: "locked_by_admin" }, "b3: «gi tilbake» is still refused after the owner's save");

      // ── (h) HTTP ─────────────────────────────────────────────────────
      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      assertEq(
        routerMod.describeSaveOutcome(true, { success: true, updated_fields: [], skipped_fields: [] }),
        { success: true, message: "Ingen endringer å lagre." },
        "h0: save receipt says so when nothing changed",
      );

      // Give prov-lc a fresh lock on about_text and a session.
      claimSvc.updateClaimedProviderProfile("prov-lc", { about_text: "Eierens egen tekst" });
      const token = "lc-session-token";
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_lc', 'prov-lc', 'post@lasetest.no', 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      ).run(token);
      const otherToken = "lc-other-session-token";
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_lc2', 'prov-long', 'post@lang.no', 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      ).run(otherToken);

      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use("/", routerMod.default);
      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body) r.write(body);
          r.end();
        });
      const cookie = { Cookie: `oa_owner_session=${token}` };
      const json = { "Content-Type": "application/json" };

      const profile = await req("GET", "/api/opplevelser/gardssalg-claim/prov-lc/profile", cookie);
      assertEq(JSON.parse(profile.body).owner_locked_fields, ["about_text"], "h1: profile API lists owner_locked_fields");

      const portal = await req("GET", "/kategori/gardssalg/eier/lasetest-gard/portal", cookie);
      assertEq(portal.status, 200, "h2: portal renders");
      assertTrue(portal.body.includes('name="release_field" value="about_text"'), "h3: portal shows «gi tilbake» for the locked about_text");
      assertTrue(portal.body.includes("La Opplevagent oppdatere dette"), "h4: button text is Norwegian");
      assertTrue(!portal.body.includes('name="release_field" value="visit_text"'), "h5: no «gi tilbake» for an unlocked field");
      assertTrue(portal.body.includes('sub.name === "release_field"'), "h6: inline script lets the release submit through natively");
      assertTrue(!/rett fra bonden/i.test(portal.body), "h7: the portal never mentions Rett fra Bonden");

      const noAuth = await req("POST", "/api/opplevelser/gardssalg-claim/prov-lc/release-field", json, JSON.stringify({ field: "about_text" }));
      assertEq(noAuth.status, 401, "h8: JSON release without a session -> 401");
      const wrongOwner = await req("POST", "/api/opplevelser/gardssalg-claim/prov-lc/release-field", { ...json, Cookie: `oa_owner_session=${otherToken}` }, JSON.stringify({ field: "about_text" }));
      assertEq(wrongOwner.status, 403, "h9: another producer's session -> 403");
      assertEq(locksOf("prov-lc"), ["about_text"], "h10: lock untouched after refused requests");
      const badField = await req("POST", "/api/opplevelser/gardssalg-claim/prov-lc/release-field", { ...json, ...cookie }, JSON.stringify({ field: "epost" }));
      assertEq(badField.status, 400, "h11: unknown field -> 400");
      const ok = await req("POST", "/api/opplevelser/gardssalg-claim/prov-lc/release-field", { ...json, ...cookie }, JSON.stringify({ field: "about_text" }));
      assertEq(ok.status, 200, "h12: JSON release with the owner's session -> 200");
      assertEq(JSON.parse(ok.body), { success: true, field: "about_text", released: true }, "h13: JSON release body");
      assertEq(locksOf("prov-lc"), [], "h14: lock removed via the JSON endpoint");

      const adminLocked = await req("POST", "/api/opplevelser/gardssalg-claim/prov-long/release-field", { ...json, Cookie: `oa_owner_session=${otherToken}` }, JSON.stringify({ field: "visit_text" }));
      assertEq(adminLocked.status, 409, "b4: JSON release of a support lock after an owner save -> 409");
      assertEq(JSON.parse(readRow("prov-long").field_provenance).owner_locks.visit_text.locked_by, "admin", "b5: the support lock is still there");

      // No-JS path: the portal form's formaction posts urlencoded.
      claimSvc.updateClaimedProviderProfile("prov-lc", { opening_hours_text: "Lør 11-15" });
      assertEq(locksOf("prov-lc"), ["opening_hours_text"], "h15: fixture: opening_hours_text locked");
      const form = await req(
        "POST",
        "/kategori/gardssalg/eier/lasetest-gard/release-field",
        { "Content-Type": "application/x-www-form-urlencoded", ...cookie },
        "field_about_text=x&release_field=opening_hours_text",
      );
      assertEq(form.status, 303, "h16: form release redirects");
      assertEq(form.headers.location, "/kategori/gardssalg/eier/lasetest-gard/portal?status=released", "h17: back to the portal with status=released");
      assertEq(locksOf("prov-lc"), [], "h18: lock removed via the form route");
      assertEq(readRow("prov-lc").about_text, "Eierens egen tekst", "h19: the form route does not save the other posted fields");
      const formNoAuth = await req(
        "POST",
        "/kategori/gardssalg/eier/lasetest-gard/release-field",
        { "Content-Type": "application/x-www-form-urlencoded" },
        "release_field=about_text",
      );
      assertEq(formNoAuth.status, 303, "h20: form release without a session redirects");
      assertEq(formNoAuth.headers.location, "/kategori/gardssalg/eier/lasetest-gard", "h21: ...to the login page, not the portal");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim-lock-changed-fields: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgClaimLockChangedFieldsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
