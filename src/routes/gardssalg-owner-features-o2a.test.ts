/**
 * gardssalg-owner-features-o2a.test.ts — dev-request 2026-10-22-opplevagent-
 * mine-valg-gardssalg, «v2 for Opplevagent», slice O2a (test setup for the
 * gårdssalg test producer).
 *
 *   (o) owner login: POST /admin/gardssalg/test-provider `owner_email` —
 *       dry-run by default (nothing written, not even the upsert), refused
 *       next to claimable/claimableEditable/claimEmail and against a real
 *       producer's slug; apply sets the self-serve tier (c) fields on the
 *       test row only, sends no e-mail, never touches gardssalg_claims or
 *       claimed_at; `owner_login` in the response; then the normal owner
 *       flow end to end: claim page → magic link to owner_email → verify →
 *       «Mine valg» 200; re-arming keeps the claim timestamp.
 *   (h) fixture state: the endpoint writes catalog_hidden_reason =
 *       'test_fixture'; the owner reads it as «visible» (not removed, not
 *       paused) and the pause switch works; resume goes back to the fixture
 *       state, never public; every public surface still hides the row; the
 *       claim lookup reaches it; rows with is_test_provider = 0 behave
 *       exactly as before (legacy copy of the state function, resume to
 *       NULL, terminal status, claim lookup).
 *   (p) «Vis som offentlig»: X-Admin-Key + ?as_public=1 on the Opplevagent
 *       host shows the fixture on the profile page, the grid, /sok, the
 *       sitemap, REST discover, MCP discover_gardssalg and A2A — with
 *       no-store/noindex; no key / wrong key / no opt-in / another host →
 *       unchanged; a real hidden row, a non-test row carrying the reason and
 *       an owner-paused fixture stay hidden; the sitemap cache is neither
 *       read nor filled; SQL outside the context is byte-identical;
 *       book_gardssalg refuses inside the view.
 *
 * Exported runGardssalgOwnerFeaturesO2aTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-features-o2a.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const KEY = "o2a-admin-key-for-tests";
const OWNER = "daniel-eier@example.no";
const FIX_NAME = "Provegard Testfixtur";
const FIX_SLUG = "provegard-testfixtur";

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : {};
  }
  return JSON.parse(text);
}

/** getOwnedVisibilityState() exactly as it was before O2a (gardssalg-claim.ts). */
function legacyOwnedVisibilityState(row: { catalog_hidden: number | null; catalog_hidden_reason: string | null }): string {
  if (Number(row.catalog_hidden) !== 1) return "visible";
  if (row.catalog_hidden_reason === "owner_pause") return "owner_pause";
  if (row.catalog_hidden_reason === "quality") return "quality_hidden";
  return "removed";
}

export function runGardssalgOwnerFeaturesO2aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = [
      "EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED",
      "ADMIN_KEY", "ANALYTICS_ADMIN_KEY",
    ];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.OA_OWNER_FEATURES_ENABLED;
    delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-a2a"),
      require.resolve("./experiences-seo"),
    ]);
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      origSendEmail = emailMod.emailService.sendEmail;
      const sent: Array<{ to: string }> = [];
      (emailMod.emailService as any).sendEmail = async (o: any) => {
        sent.push({ to: String(o?.to ?? "") });
        return { success: true, messageId: "test" };
      };

      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const vis = require("../services/gardssalg-visibility") as typeof import("../services/gardssalg-visibility");
      const agentVis = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const seoMod = require("./experiences-seo") as typeof import("./experiences-seo");
      seoMod.__resetExperiencesSitemapCacheForTesting();

      // Real producers next to the fixture.
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider,
           catalog_hidden, catalog_hidden_reason, fylke, kommune, poststed, lat, lon, geocode_confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @epost, NULL, '["Eplesider"]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, @is_test_provider,
           @hidden, @reason, 'Vestland', 'Ullensvang', 'Lofthus', 60.32, 6.65, 'high')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({ id, navn, slug, org_nr: org, epost: `post@${slug}.no`, is_test_provider: null, hidden: null, reason: null, ...extra });
      mk("o2-pub", "Offentlig Sideri Lofthus", "offentlig-sideri", "918200001");
      // The sitemap lists gårdssalg only from GARDSSALG_VISIBILITY_THRESHOLD (5) public producers.
      for (let i = 1; i <= 5; i++) mk(`o2-pub${i}`, `Offentlig Bryggeri ${i}`, `offentlig-bryggeri-${i}`, `91821000${i}`);
      mk("o2-hid", "Skjult Sideri Lofthus", "skjult-sideri", "918200002", { hidden: 1 });
      // A non-test row that somehow carries the fixture reason: must stay hidden everywhere.
      mk("o2-fake", "Falsk Fixtur Sideri", "falsk-fixtur", "918200003", { hidden: 1, reason: "test_fixture", is_test_provider: 0 });
      mk("o2-paused", "Pauset Sideri Lofthus", "pauset-sideri", "918200004", { hidden: 1, reason: "owner_pause" });

      // ── HTTP wiring: the real middleware + routers ────────────────────
      const expressMod = require("express") as typeof import("express");
      const { asPublicViewMiddleware } = require("../middleware/as-public-view") as typeof import("../middleware/as-public-view");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      const a2aRouter = (require("./experiences-a2a") as typeof import("./experiences-a2a")).default as any;
      (require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const app = expressMod();
      app.use(expressMod.json());
      app.use(asPublicViewMiddleware);
      app.use("/api/opplevelser", opplevelserMod.default as any);
      app.use("/", claimRouter);
      app.use((rq: any, rp: any, next: any) => (rq.path === "/mcp" ? mcpRouter(rq, rp, next) : next()));
      app.use("/", a2aRouter);
      app.use("/", seoMod.default as any);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      // http.request, not fetch: other suites in the full run stub global fetch.
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
      const json = { "Content-Type": "application/json" };
      const admin = { "X-Admin-Key": KEY };
      const OA = { Host: "opplevagent.no" };
      const tp = (body: Record<string, unknown>, headers: Record<string, string> = admin) =>
        req("POST", "/api/opplevelser/admin/gardssalg/test-provider", { ...json, ...headers }, JSON.stringify(body));
      const providerCount = () => (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as any).n;
      const rowOf = (id: string) =>
        expDb.prepare(
          `SELECT catalog_hidden, catalog_hidden_reason, is_test_provider, epost, brreg_verified, content_source, claimed_at, booking_live
             FROM experience_providers WHERE id = ?`,
        ).get(id) as any;

      // ── (o) owner login on the fixture endpoint ───────────────────────
      const base = { email: "booking-varsel@example.no", name: FIX_NAME, slug: FIX_SLUG };
      assertEq((await tp({ ...base, owner_email: OWNER }, {})).status, 403, "o1: no X-Admin-Key → 403");
      const n0 = providerCount();
      for (const [flag, label] of [[{ claimable: true }, "claimable"], [{ claimableEditable: true }, "claimableEditable"], [{ claimEmail: "x@example.no" }, "claimEmail"]] as const) {
        const r = await tp({ ...base, owner_email: OWNER, ...flag });
        assertEq(r.status, 400, `o2: owner_email + ${label} → 400`);
      }
      assertEq((await tp({ ...base, owner_email: "ikke-en-adresse" })).status, 400, "o3: malformed owner_email → 400");
      assertEq(providerCount(), n0, "o4: refused calls wrote nothing");

      const dry = await tp({ ...base, owner_email: OWNER });
      const dryJ = JSON.parse(dry.body);
      assertTrue(dry.status === 200 && dryJ.dry_run === true && dryJ.target === "create" && dryJ.provider_id === null, "o5: owner_email without apply → dry-run plan (create)");
      const dryFields = (dryJ.changes || []).map((c: any) => c.field);
      assertTrue(["catalog_hidden_reason", "epost", "brreg_verified", "content_source", "is_test_provider"].every((f) => dryFields.includes(f)), "o6: dry-run lists the planned fields");
      assertEq(providerCount(), n0, "o7: dry-run wrote nothing (not even the upsert)");

      const realSlug = await tp({ ...base, slug: "offentlig-sideri", owner_email: OWNER, apply: true });
      assertEq(realSlug.status, 409, "o8: a real producer's slug → 409");
      assertEq(rowOf("o2-pub"), { catalog_hidden: null, catalog_hidden_reason: null, is_test_provider: null, epost: "post@offentlig-sideri.no", brreg_verified: 1, content_source: null, claimed_at: null, booking_live: 0 }, "o9: … and the real row is untouched");

      const applied = await tp({ ...base, owner_email: OWNER, apply: true });
      const appliedJ = JSON.parse(applied.body);
      const FIX = appliedJ.provider_id as string;
      assertTrue(applied.status === 200 && appliedJ.success === true && appliedJ.dry_run === false && !!FIX, "o10: apply → 200, the test row created");
      assertEq(rowOf(FIX), {
        catalog_hidden: 1, catalog_hidden_reason: "test_fixture", is_test_provider: 1, epost: OWNER,
        brreg_verified: 1, content_source: "manual", claimed_at: null, booking_live: 1,
      }, "o11: test row: hidden as test_fixture, owner login fields set, claimed_at untouched");
      assertEq(appliedJ.owner_login, {
        email: OWNER, verified_owner: false, claim_ready: true, allowlisted: false,
        valg_path: `/kategori/gardssalg/eier/${FIX_SLUG}/valg`,
        claim_url: `${process.env.APP_URL || "https://opplevagent.no"}/kategori/gardssalg/eier/${FIX_SLUG}`,
        magic_link_request: `POST /kategori/gardssalg/eier/${FIX}/request`,
      }, "o12: owner_login in the response");
      assertEq((expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_claims`).get() as any).n, 0, "o13: no claim row written by the endpoint");
      assertEq(sent.length, 0, "o14: the endpoint sends no e-mail");
      const audit = expDb.prepare(
        `SELECT field_name, new_value FROM gardssalg_content_audit WHERE provider_id = ? AND batch_id = 'admin-test-provider-owner-login' ORDER BY field_name`,
      ).all(FIX) as Array<{ field_name: string; new_value: string }>;
      assertEq(audit, [
        { field_name: "brreg_verified", new_value: "1" },
        { field_name: "content_source", new_value: "manual" },
        { field_name: "epost", new_value: OWNER },
      ], "o15: one audit row per changed owner-login field");

      // The normal owner flow, end to end.
      process.env.OA_OWNER_FEATURES_ENABLED = "true";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `gardssalg:${FIX},gardssalg:o2-fake`;
      const claimPage = await req("GET", `/kategori/gardssalg/eier/${FIX_SLUG}`, OA);
      assertTrue(claimPage.status === 200 && claimPage.body.includes("Send meg tilgangslenke") && claimPage.body.includes(claimSvc.maskEmail(OWNER)), "o16: claim page reachable for the hidden test row, link goes to the masked owner_email");
      const linkReq = await req("POST", `/kategori/gardssalg/eier/${FIX}/request`, { ...json, ...OA }, "{}");
      assertTrue(linkReq.status === 200 && JSON.parse(linkReq.body).success === true, "o17: magic link requested through the normal flow");
      await new Promise((r) => setTimeout(r, 20));
      assertEq(sent.map((m) => m.to), [OWNER], "o18: … sent to owner_email only");
      const token = (expDb.prepare(`SELECT token FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1`).get(FIX) as any)?.token as string;
      const verify = await req("GET", `/kategori/gardssalg/eier/magic-link-verify?token=${encodeURIComponent(token)}`, OA);
      const setCookie = String((verify.headers["set-cookie"] || [])[0] || "");
      assertTrue(verify.status === 302 && setCookie.startsWith("oa_owner_session="), "o19: verify → owner session cookie");
      const session = { Cookie: `oa_owner_session=${token}` };
      const valg = await req("GET", `/kategori/gardssalg/eier/${FIX_SLUG}/valg`, { ...OA, ...session });
      assertEq(valg.status, 200, "o20: «Mine valg» opens for the test row as a verified owner");
      const claimedAt = rowOf(FIX).claimed_at;
      assertTrue(!!claimedAt, "o21: the clicked link set claimed_at (verified claim)");
      expDb.prepare(`UPDATE experience_providers SET claimed_at = '2026-10-01 08:00:00' WHERE id = ?`).run(FIX);
      const rearm = JSON.parse((await tp({ ...base, owner_email: OWNER, apply: true })).body);
      assertEq([rearm.owner_login.verified_owner, rearm.owner_login.allowlisted], [true, true], "o22: re-arm reports verified_owner and allowlisted");
      assertEq(rowOf(FIX).claimed_at, "2026-10-01 08:00:00", "o23: re-arm never overwrites the claim timestamp");
      assertEq((expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_claims WHERE provider_id = ? AND used = 1 AND revoked_at IS NULL`).get(FIX) as any).n, 1, "o24: re-arm leaves the claim as it is");
      // Without owner_email: the endpoint behaves as before (writes, no dry-run).
      const plain = JSON.parse((await tp({ ...base })).body);
      assertTrue(plain.success === true && !("dry_run" in plain) && !("owner_login" in plain) && plain.provider_id === FIX, "o25: without owner_email → unchanged behaviour (writes, no dry_run/owner_login)");

      // ── (h) fixture state ─────────────────────────────────────────────
      assertEq(claimSvc.getOwnedVisibilityStateById(FIX), "visible", "h1: the owner reads the fixture as visible (not removed, not paused)");
      assertEq(claimSvc.getOwnedVisibilityStateById("o2-fake"), "removed", "h2: the reason on a non-test row reads as removed (fail closed)");
      assertEq(claimSvc.getOwnedVisibilityState({ catalog_hidden: 1, catalog_hidden_reason: "test_fixture" }), "removed", "h3: … and without is_test_provider too");
      const resolved = rs.resolveOwnerFeatures("gardssalg", FIX);
      assertEq([resolved.byKey["visibility.profile"].value, resolved.byKey["visibility.profile"].changeable], [true, true], "h4: «Mine valg»: visibility.profile on and changeable");
      const putOff = await req("PUT", `/api/opplevelser/gardssalg-claim/${FIX}/features/visibility.profile`, { ...json, ...OA, ...session }, JSON.stringify({ value: false, confirmed: true }));
      assertEq(putOff.status, 200, "h5: pause via «Mine valg» → 200");
      assertEq([rowOf(FIX).catalog_hidden, rowOf(FIX).catalog_hidden_reason], [1, "owner_pause"], "h6: … the row is owner-paused");
      assertTrue(!!claimSvc.getClaimProviderBySlug(FIX_SLUG), "h7: the paused fixture still reaches the portal lookup");
      const putOn = await req("PUT", `/api/opplevelser/gardssalg-claim/${FIX}/features/visibility.profile`, { ...json, ...OA, ...session }, JSON.stringify({ value: true, confirmed: true }));
      assertEq(putOn.status, 200, "h8: resume via «Mine valg» → 200");
      assertEq([rowOf(FIX).catalog_hidden, rowOf(FIX).catalog_hidden_reason], [1, "test_fixture"], "h9: resume puts the fixture back to the fixture state, never public");

      const pubIds = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
      assertTrue(!pubIds(store.listGardssalgProviders(500, 0)).includes(FIX), "h10: hidden from the public list (web)");
      assertEq(store.getGardssalgProviderBySlug(FIX_SLUG), null, "h11: hidden from the public profile lookup");
      assertTrue(!pubIds(store.searchGardssalgProviders({}, 50, { surface: "mcp" })).includes(FIX), "h12: hidden from mcp/a2a/rest search");
      assertTrue(!store.listGardssalgProviderMapPoints().some((p: any) => p.slug === FIX_SLUG), "h13: hidden from the map");
      assertTrue(!pubIds(store.listGardssalgProviders(500, 0, undefined, "sitemap")).includes(FIX), "h14: hidden from the sitemap set");
      assertEq(claimSvc.getClaimProviderBySlug(FIX_SLUG)?.id, FIX, "h15: the claim lookup reaches the fixture");
      assertEq(claimSvc.getClaimProviderBySlug("falsk-fixtur"), null, "h16: … but not a non-test row with the reason");
      assertEq(claimSvc.getClaimProviderBySlug("skjult-sideri"), null, "h17: … nor a real hidden row");
      assertEq(opplevelserMod.deriveGardssalgTerminalStatus(null, { catalog_hidden: 1, catalog_hidden_reason: "test_fixture" }, () => false), null, "h18: terminal status: the reason is not «eier_fjernet»");

      // Rows with is_test_provider = 0/NULL: byte-identical to before.
      const reasons: Array<string | null> = [null, "owner_pause", "quality", "remove_request", "test_fixture", "annet"];
      const hiddens: Array<number | null> = [null, 0, 1];
      let same = true;
      for (const tpv of [null, 0]) for (const h of hiddens) for (const r of reasons) {
        const row = { catalog_hidden: h, catalog_hidden_reason: r, is_test_provider: tpv };
        if (claimSvc.getOwnedVisibilityState(row) !== legacyOwnedVisibilityState(row)) same = false;
      }
      assertTrue(same, "h19: owner state for every non-test row == the pre-O2a function");
      // A real owned row: pause/resume writes exactly as before (resume → NULL/NULL).
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc-pub', 'o2-pub', 'eier@offentlig-sideri.no', 'manual', 'tok-pub', 1, datetime('now'), datetime('now','+7 days'))`,
      ).run();
      claimSvc.pauseOwnedProvider("o2-pub");
      assertEq([rowOf("o2-pub").catalog_hidden, rowOf("o2-pub").catalog_hidden_reason], [1, "owner_pause"], "h20: real row: pause as before");
      claimSvc.resumeOwnedProvider("o2-pub");
      assertEq([rowOf("o2-pub").catalog_hidden, rowOf("o2-pub").catalog_hidden_reason], [null, null], "h21: real row: resume → NULL/NULL as before");
      expDb.prepare(`DELETE FROM gardssalg_claims WHERE id = 'gsc-pub'`).run();

      // ── (p) «Vis som offentlig» ───────────────────────────────────────
      const asPub = (path: string) => `${path}${path.includes("?") ? "&" : "?"}as_public=1`;
      const profile = `/kategori/gardssalg/produsent/${FIX_SLUG}`;
      // Gate: anything missing → unchanged.
      assertEq((await req("GET", profile, OA)).status, 404, "p1: plain request → the fixture's profile is 404");
      assertEq((await req("GET", asPub(profile), OA)).status, 404, "p2: opt-in without key → 404");
      assertEq((await req("GET", asPub(profile), { ...OA, "X-Admin-Key": "wrong" })).status, 404, "p3: wrong key → 404");
      assertEq((await req("GET", profile, { ...OA, ...admin })).status, 404, "p4: key without opt-in → 404");
      assertEq((await req("GET", `${profile}?as_public=true`, { ...OA, ...admin })).status, 404, "p5: as_public≠1 → 404");
      assertEq((await req("GET", asPub(profile), admin)).status, 404, "p6: key + opt-in on another host → 404 (host-aware)");
      const plainGrid = await req("GET", "/kategori/gardssalg", OA);
      assertEq(plainGrid.headers["cache-control"], "public, max-age=300", "p7: a plain answer keeps its own Cache-Control");

      // Covered surfaces.
      const prof = await req("GET", asPub(profile), { ...OA, ...admin });
      assertTrue(prof.status === 200 && prof.body.includes(FIX_NAME), "p8: profile page shows the fixture");
      assertEq([prof.headers["cache-control"], prof.headers["x-robots-tag"]], ["no-store, private", "noindex"], "p9: … with no-store, private + noindex");
      const grid = await req("GET", asPub("/kategori/gardssalg"), { ...OA, ...admin });
      assertTrue(grid.body.includes(FIX_SLUG) && grid.headers["cache-control"] === "no-store, private", "p10: the grid shows the fixture (no-store)");
      assertTrue(!plainGrid.body.includes(FIX_SLUG), "p11: … the plain grid does not");
      const sok = await req("GET", asPub(`/sok?q=${encodeURIComponent("Provegard")}`), { ...OA, ...admin });
      assertTrue(sok.body.includes(FIX_SLUG), "p12: /sok finds the fixture");
      assertTrue(!(await req("GET", `/sok?q=${encodeURIComponent("Provegard")}`, OA)).body.includes(FIX_SLUG), "p13: … plain /sok does not");
      seoMod.__resetExperiencesSitemapCacheForTesting();
      const smPub = await req("GET", asPub("/sitemap.xml"), { ...OA, ...admin });
      assertTrue(smPub.body.includes(FIX_SLUG), "p14: sitemap lists the fixture");
      const cache = (require("./sitemap-cache-util") as typeof import("./sitemap-cache-util")).getRegisteredSitemapCache("experiences");
      assertEq(cache?.peek() ?? null, null, "p15: … without filling the sitemap cache (IndexNow reads it)");
      const smPlain = await req("GET", "/sitemap.xml", OA);
      assertTrue(!smPlain.body.includes(FIX_SLUG) && smPlain.headers["cache-control"] !== "no-store, private", "p16: the plain sitemap does not list it");
      const rest = await req("GET", asPub("/api/opplevelser/discover?category=gardssalg_smaking&limit=50"), admin);
      assertTrue(rest.status === 200 && rest.body.includes(FIX), "p17: REST discover lists the fixture (any host)");
      assertTrue(!(await req("GET", "/api/opplevelser/discover?category=gardssalg_smaking&limit=50", admin)).body.includes(FIX), "p18: … plain REST discover does not");
      const a2aBody = (text: string) => JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text }] } } });
      const a2a = await req("POST", asPub("/a2a"), { ...json, ...OA, ...admin }, a2aBody("gårdssalg"));
      assertTrue(a2a.body.includes(FIX), "p19: A2A gårdssalg discovery lists the fixture");
      assertTrue(!(await req("POST", "/a2a", { ...json, ...OA, ...admin }, a2aBody("gårdssalg"))).body.includes(FIX), "p20: … plain A2A does not");

      // MCP over a real session (each POST carries the opt-in).
      const mcpPost = async (payload: unknown, sessionId: string | null, asPublic: boolean) => {
        const r = await req("POST", asPublic ? asPub("/mcp") : "/mcp", {
          ...json, ...OA, ...admin, Accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        }, JSON.stringify(payload));
        return r;
      };
      const init = await mcpPost({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "o2a-test", version: "1.0.0" } }, id: "1" }, null, true);
      const sid = (init.headers["mcp-session-id"] as string | undefined) ?? null;
      const callTool = async (name: string, args: Record<string, unknown>, asPublic: boolean) => {
        const r = await mcpPost({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: String(Math.random()) }, sid, asPublic);
        const body = parseJsonRpcBody(r.body, String(r.headers["content-type"] || ""));
        return body.result?.content?.[0]?.text ?? "";
      };
      assertTrue((await callTool("discover_gardssalg", { limit: 50 }, true)).includes(FIX), "p21: MCP discover_gardssalg lists the fixture");
      assertTrue(!(await callTool("discover_gardssalg", { limit: 50 }, false)).includes(FIX), "p22: … plain MCP does not");
      const bookings0 = (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings`).get() as any).n;
      const book = JSON.parse((await callTool("book_gardssalg", { provider_id: FIX, slot_at: "2030-06-05T12:00", party_size: 2, guest_name: "Kari Nordmann", guest_email: "kari@example.no" }, true)) || "{}");
      assertEq([book.success, book.reason], [false, "as_public_read_only"], "p23: book_gardssalg refuses inside the as-public view");
      assertEq((expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_bookings`).get() as any).n, bookings0, "p24: … no booking row");

      // Never: other hidden rows stay hidden inside the view.
      for (const [slug, label] of [["skjult-sideri", "a real hidden row"], ["falsk-fixtur", "a non-test row with the reason"], ["pauset-sideri", "a real owner-paused row"]]) {
        assertEq((await req("GET", asPub(`/kategori/gardssalg/produsent/${slug}`), { ...OA, ...admin })).status, 404, `p25: as-public: ${label} stays 404`);
        assertTrue(!grid.body.includes(slug) && !smPub.body.includes(slug) && !rest.body.includes(slug), `p26: as-public: ${label} not in grid/sitemap/REST`);
      }
      // The owner's pause on the fixture is observable inside the view.
      claimSvc.pauseOwnedProvider(FIX);
      assertEq((await req("GET", asPub(profile), { ...OA, ...admin })).status, 404, "p27: owner-paused fixture → gone from the as-public profile");
      claimSvc.resumeOwnedProvider(FIX);
      assertEq((await req("GET", asPub(profile), { ...OA, ...admin })).status, 200, "p28: resumed → back in the as-public view");

      // SQL: byte-identical outside the context; the exception only inside.
      const LEGACY_WEB = "(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') AND (catalog_hidden IS NULL OR catalog_hidden != 1) AND (merged_into IS NULL OR merged_into = '')";
      assertTrue(vis.GARDSSALG_SURFACES.filter((s) => s !== "claim").every((s) => vis.gardssalgVisibleSql(s) === LEGACY_WEB), "p29: public SQL outside the view == pre-O2a text");
      const inside = agentVis.runAsPublicView(() => vis.gardssalgVisibleSql("web"));
      assertTrue(inside.includes("(catalog_hidden_reason = 'test_fixture' AND is_test_provider = 1)"), "p30: inside the view the fixture exception is added");
      assertEq(agentVis.runAsPublicView(() => vis.gardssalgVisibleSql("rest", { includeHidden: true })), vis.gardssalgVisibleSql("rest", { includeHidden: true }), "p31: includeHidden text unchanged inside the view");
      const rowTwin = (row: Record<string, unknown>) => [
        vis.isGardssalgVisibleOnSurface({ producer_type: "cideri", ...row }, "web"),
        agentVis.runAsPublicView(() => vis.isGardssalgVisibleOnSurface({ producer_type: "cideri", ...row }, "web")),
      ];
      assertEq(rowTwin({ catalog_hidden: 1, catalog_hidden_reason: "test_fixture", is_test_provider: 1 }), [false, true], "p32: row twin: the fixture visible only inside the view");
      assertEq(rowTwin({ catalog_hidden: 1, catalog_hidden_reason: "test_fixture", is_test_provider: 0 }), [false, false], "p33: row twin: a non-test row never");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      if (emailMod) (emailMod.emailService as any).sendEmail = origSendEmail;
      if (initMod) initMod.__setDbForTesting(prevRfbDb);
      restoreModuleCache();
      for (const k of ENV_KEYS) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgOwnerFeaturesO2aTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-owner-features-o2a: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
