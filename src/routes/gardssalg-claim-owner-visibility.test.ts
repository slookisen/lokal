/**
 * gardssalg-claim-owner-visibility.test.ts — G1 pkt 4 of dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg: an owned profile has three
 * clearly separate hidden/visible states (owner pause, «fjern», admin
 * quality-hide) and the admin visibility lever only touches owned rows with an
 * explicit confirm_owned:true.
 *
 * Exported runGardssalgClaimOwnerVisibilityTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim-owner-visibility.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimOwnerVisibilityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevAdminKey = process.env.ADMIN_KEY;
    const adminKey = "owner-visibility-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = adminKey;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./opplevelser"),
    ]);
    let server: any = null;
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products, catalog_hidden, catalog_hidden_reason,
           producer_type, enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, @content_source, '["x"]', @catalog_hidden, @catalog_hidden_reason,
           'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.no`, epost: `post@${slug}.no`,
          content_source: "claim", catalog_hidden: null, catalog_hidden_reason: null, ...extra,
        });
      mk("ov-a", "Pausegård", "pausegard", "917000001");
      mk("ov-b", "Fjerngård", "fjerngard", "917000002", { catalog_hidden: 1, catalog_hidden_reason: "remove_request" });
      mk("ov-c", "Kvalitetsgård", "kvalitetsgard", "917000003", { catalog_hidden: 1, catalog_hidden_reason: "quality" });
      mk("ov-d", "Annen Gård", "annen-gard", "917000004");
      mk("ov-e", "Uten Eier", "uten-eier", "917000005", { content_source: null });
      mk("ov-f", "Admingård", "admingard", "917000006");
      mk("ov-g", "Legacyskjult", "legacyskjult", "917000007", { catalog_hidden: 1, catalog_hidden_reason: null });

      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, 'post@x.no', 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["ov-a", "tok-a"], ["ov-b", "tok-b"], ["ov-c", "tok-c"], ["ov-d", "tok-d"], ["ov-f", "tok-f"], ["ov-g", "tok-g"]]) {
        claimRow.run(`gsc_${pid}`, pid, tok);
      }

      // An experience on ov-a, to prove the shared publish gate hides it too.
      expDb.prepare(
        `INSERT INTO experiences (id, provider_id, slug, title, category, verification_status, confidence)
         VALUES ('exp-a', 'ov-a', 'exp-a-slug', 'Smaking', 'tasting', 'verified', 'high')`,
      ).run();

      const hiddenRow = (id: string) =>
        expDb.prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = ?").get(id) as any;
      const listed = (navn: string) => store.listGardssalgProviders(200, 0).some((p: any) => p.navn === navn);
      const bySlug = (slug: string) => !!store.getGardssalgProviderBySlug(slug);
      const experienceVisible = () =>
        (expDb.prepare(
          `SELECT 1 AS x FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = 'exp-a' AND ${store.PUBLISH_GATE_SQL}`,
        ).get() as any) !== undefined;
      const blocklistCount = () => (rfbDb.prepare("SELECT COUNT(*) c FROM agent_blocklist").get() as any).c;
      const auditOf = (id: string) => expDb.prepare(
        "SELECT field_name, old_value, new_value, batch_id, changed_by, notes FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'catalog_hidden' ORDER BY rowid",
      ).all(id) as any[];

      // ── (s) service state mapping ─────────────────────────────────────
      assertEq(claimSvc.getOwnedVisibilityStateById("ov-a"), "visible", "s1: visible");
      assertEq(claimSvc.getOwnedVisibilityStateById("ov-b"), "removed", "s2: remove_request -> removed");
      assertEq(claimSvc.getOwnedVisibilityStateById("ov-c"), "quality_hidden", "s3: quality -> quality_hidden");
      assertEq(claimSvc.getOwnedVisibilityStateById("ov-g"), "removed", "s4: legacy hide without reason is treated as removed (cannot be resumed)");
      assertEq(claimSvc.pauseOwnedProvider("ov-e"), { ok: false, error: "not_owner" }, "s5: a row without a verified claim cannot be paused");
      assertEq(claimSvc.pauseOwnedProvider("finnes-ikke"), { ok: false, error: "provider_not_found" }, "s6: unknown row");

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const app = expressMod();
      app.use("/api/opplevelser", expressMod.json(), opplevelserRouter);
      app.use("/", claimRouter);
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
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const json = { "Content-Type": "application/json" };
      const api = (id: string, action: string) => `/api/opplevelser/gardssalg-claim/${id}/${action}`;

      // ── (p) owner pause hides everywhere, no blocklist ────────────────
      assertTrue(listed("Pausegård") && bySlug("pausegard") && experienceVisible(), "p0: visible before pause");
      const noSession = await req("POST", api("ov-a", "pause"), json, "{}");
      assertEq(noSession.status, 401, "p1: pause without session -> 401");
      const wrongOwner = await req("POST", api("ov-a", "pause"), { ...json, ...cookie("tok-d") }, "{}");
      assertEq(wrongOwner.status, 403, "p2: another producer's session -> 403");
      assertTrue(listed("Pausegård"), "p3: refused calls changed nothing");
      const blBefore = blocklistCount();
      const pause = await req("POST", api("ov-a", "pause"), { ...json, ...cookie("tok-a") }, "{}");
      assertEq(pause.status, 200, "p4: owner pause -> 200");
      assertEq(JSON.parse(pause.body), { success: true, state: "owner_pause", changed: true }, "p5: body reports owner_pause");
      assertEq(hiddenRow("ov-a"), { catalog_hidden: 1, catalog_hidden_reason: "owner_pause" }, "p6: stored as catalog_hidden=1 + owner_pause");
      assertTrue(!listed("Pausegård"), "p7: paused row not in the public gårdssalg list");
      assertTrue(!bySlug("pausegard"), "p8: paused row not reachable by public slug");
      assertTrue(!experienceVisible(), "p9: paused provider's experience is off the shared publish gate");
      assertEq(blocklistCount(), blBefore, "p10: pause writes NO blocklist entry");
      assertEq(JSON.parse((await req("POST", api("ov-a", "pause"), { ...json, ...cookie("tok-a") }, "{}")).body).changed, false, "p11: pausing twice is a no-op");
      const portalPaused = await req("GET", "/kategori/gardssalg/eier/pausegard/portal", cookie("tok-a"));
      assertEq(portalPaused.status, 200, "p12: owner portal still opens while paused");
      assertTrue(portalPaused.body.includes('data-visibility-state="owner_pause"') && portalPaused.body.includes("Gjør profilen synlig igjen"), "p13: portal shows the pause state with a resume button");
      assertTrue(!/Rett fra Bonden/i.test(portalPaused.body), "p14: portal never mentions Rett fra Bonden");

      // ── (r) resume restores; refused after «fjern» / quality-hide ─────
      const resume = await req("POST", api("ov-a", "resume"), { ...json, ...cookie("tok-a") }, "{}");
      assertEq(JSON.parse(resume.body), { success: true, state: "visible", changed: true }, "r1: resume -> visible");
      assertEq(hiddenRow("ov-a"), { catalog_hidden: null, catalog_hidden_reason: null }, "r2: flag cleared");
      assertTrue(listed("Pausegård") && bySlug("pausegard") && experienceVisible(), "r3: restored on every surface");
      assertEq(auditOf("ov-a").map((r) => [r.old_value, r.new_value, r.batch_id, r.changed_by]),
        [["visible", "owner_pause", "owner-portal-pause", "owner"], ["owner_pause", "visible", "owner-portal-resume", "owner"]],
        "r4: pause and resume are logged (one row each, no row for the no-op)");
      const resumeRemoved = await req("POST", api("ov-b", "resume"), { ...json, ...cookie("tok-b") }, "{}");
      assertEq(resumeRemoved.status, 409, "r5: resume after «fjern» -> 409");
      assertEq(JSON.parse(resumeRemoved.body).error, "removed", "r6: error is removed");
      assertTrue(/fjernet/.test(JSON.parse(resumeRemoved.body).message), "r7: Norwegian reason");
      assertEq(hiddenRow("ov-b"), { catalog_hidden: 1, catalog_hidden_reason: "remove_request" }, "r8: «fjern» state untouched");
      const resumeQuality = await req("POST", api("ov-c", "resume"), { ...json, ...cookie("tok-c") }, "{}");
      assertEq([resumeQuality.status, JSON.parse(resumeQuality.body).error], [409, "quality_hidden"], "r9: resume after admin quality-hide -> 409");
      assertEq(hiddenRow("ov-c"), { catalog_hidden: 1, catalog_hidden_reason: "quality" }, "r10: quality-hide untouched");
      const pauseRemoved = await req("POST", api("ov-b", "pause"), { ...json, ...cookie("tok-b") }, "{}");
      assertEq(pauseRemoved.status, 409, "r11: pausing a «fjern»-row cannot rewrite it into a resumable pause");
      assertEq(hiddenRow("ov-b").catalog_hidden_reason, "remove_request", "r12: reason still remove_request");
      const resumeLegacy = await req("POST", api("ov-g", "resume"), { ...json, ...cookie("tok-g") }, "{}");
      assertEq(resumeLegacy.status, 409, "r13: legacy hide without reason is not resumable by the owner");
      assertEq((await req("POST", api("ov-a", "resume"), json, "{}")).status, 401, "r14: resume without session -> 401");
      assertEq((await req("POST", api("ov-a", "resume"), { ...json, ...cookie("tok-d") }, "{}")).status, 403, "r15: resume with another producer's session -> 403");
      const portalRemoved = await req("GET", "/kategori/gardssalg/eier/fjerngard/portal", cookie("tok-b"));
      // getClaimProviderBySlug hides removed rows from the portal (unchanged behaviour).
      assertEq(portalRemoved.status, 404, "r16: a «fjern»-row stays unreachable in the portal (as before)");

      // no-JS form routes
      const formPause = await req("POST", "/kategori/gardssalg/eier/pausegard/pause", cookie("tok-a"));
      assertEq([formPause.status, formPause.headers.location], [303, "/kategori/gardssalg/eier/pausegard/portal?status=paused"], "f1: form pause redirects with status=paused");
      const formNoSession = await req("POST", "/kategori/gardssalg/eier/pausegard/resume");
      assertEq(formNoSession.status, 303, "f2: form resume without session redirects to login");
      assertEq(hiddenRow("ov-a").catalog_hidden_reason, "owner_pause", "f3: unauthenticated form call changed nothing");
      const formResume = await req("POST", "/kategori/gardssalg/eier/pausegard/resume", cookie("tok-a"));
      assertEq(formResume.headers.location, "/kategori/gardssalg/eier/pausegard/portal?status=resumed", "f4: form resume redirects with status=resumed");
      const portalVisible = await req("GET", "/kategori/gardssalg/eier/pausegard/portal", cookie("tok-a"));
      assertTrue(portalVisible.body.includes('data-visibility-state="visible"') && portalVisible.body.includes("Sett profilen på pause"), "f5: portal shows the visible state with a pause button");

      // ── (a) admin lever on owned rows ─────────────────────────────────
      const admin = (body: unknown, query = "") =>
        req("POST", `/api/opplevelser/admin/gardssalg-provider-visibility${query}`, { ...json, "x-admin-key": adminKey }, JSON.stringify(body));
      const noKey = await req("POST", "/api/opplevelser/admin/gardssalg-provider-visibility", json, JSON.stringify({ hidden: true, providerIds: ["ov-f"], apply: true, confirm_owned: true }));
      assertEq(noKey.status, 403, "a0: admin key still required");

      const unconfirmed = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-f"], apply: true })).body);
      assertEq(unconfirmed.changed_count, 0, "a1: owned row not changed without confirm_owned");
      assertEq(unconfirmed.skipped_owned.map((r: any) => [r.id, r.state]), [["ov-f", "visible"]], "a2: reported as skipped_owned with its state");
      assertEq(hiddenRow("ov-f").catalog_hidden, null, "a3: row still visible");
      const truthy = await admin({ hidden: true, mode: "quality", providerIds: ["ov-f"], apply: true, confirm_owned: "true" });
      assertEq(truthy.status, 400, "a4: confirm_owned must be a strict boolean");
      const falsy = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-f"], apply: true, confirm_owned: false })).body);
      assertEq(falsy.skipped_owned.length, 1, "a5: confirm_owned:false behaves like absent");

      const dry = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-f"], confirm_owned: true })).body);
      assertEq([dry.dry_run, dry.changed_count], [true, 1], "a6: dry-run with confirm reports the change");
      assertEq(hiddenRow("ov-f").catalog_hidden, null, "a7: dry-run writes nothing");
      assertEq(auditOf("ov-f").length, 0, "a8: dry-run logs nothing");

      const hide = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-f"], apply: true, confirm_owned: true })).body);
      assertEq(hide.changed_count, 1, "a9: confirmed admin quality-hide of an owned row is applied");
      assertEq(hiddenRow("ov-f"), { catalog_hidden: 1, catalog_hidden_reason: "quality" }, "a10: stored as quality hide");
      assertTrue(!listed("Admingård"), "a11: hidden publicly");
      const a12 = auditOf("ov-f");
      assertEq(a12.map((r) => [r.old_value, r.new_value, r.batch_id, r.changed_by]), [["visible", "quality_hidden", "admin-visibility-owned", "admin"]], "a12: admin change on an owned row is logged");
      assertEq(JSON.parse(a12[0].notes), { confirm_owned: true, mode: "quality" }, "a13: log notes carry the confirmation");
      assertEq((await req("POST", api("ov-f", "resume"), { ...json, ...cookie("tok-f") }, "{}")).status, 409, "a14: owner cannot undo the admin quality-hide");

      // «fjern» via the lever on an owned row blocklists, as before.
      const blB = blocklistCount();
      const fjern = JSON.parse((await admin({ hidden: true, providerIds: ["ov-d"], apply: true, confirm_owned: true })).body);
      assertEq(fjern.changed_count, 1, "a15: confirmed «fjern» of an owned row applied");
      assertEq(hiddenRow("ov-d").catalog_hidden_reason, "remove_request", "a16: stored as remove_request");
      assertTrue(blocklistCount() > blB, "a17: «fjern» still blocklists");

      // Admin un-hides an owned row only with confirmation too.
      const unhideNo = JSON.parse((await admin({ hidden: false, providerIds: ["ov-f"], apply: true })).body);
      assertEq([unhideNo.changed_count, unhideNo.skipped_owned.length, hiddenRow("ov-f").catalog_hidden], [0, 1, 1], "a18: un-hide of an owned row needs confirmation");
      const unhideYes = JSON.parse((await admin({ hidden: false, providerIds: ["ov-f"], apply: true, confirm_owned: true })).body);
      assertEq([unhideYes.changed_count, hiddenRow("ov-f").catalog_hidden], [1, null], "a19: confirmed un-hide restores");

      // Admin quality-hide of an owner-paused row is a real change (reason differs).
      claimSvc.pauseOwnedProvider("ov-a");
      const overPause = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-a"], apply: true, confirm_owned: true })).body);
      assertEq([overPause.changed_count, hiddenRow("ov-a").catalog_hidden_reason], [1, "quality"], "a20: admin quality-hide overrides an owner pause (owner can no longer resume)");

      // Non-owned rows keep working without any flag.
      const plain = JSON.parse((await admin({ hidden: true, mode: "quality", providerIds: ["ov-e"], apply: true })).body);
      assertEq([plain.changed_count, plain.skipped_owned.length], [1, 0], "a21: a non-owned row needs no confirmation");
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      try { if (initMod) initMod.__setDbForTesting(prevRfbDb); } catch { /* ignore */ }
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
  runGardssalgClaimOwnerVisibilityTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
