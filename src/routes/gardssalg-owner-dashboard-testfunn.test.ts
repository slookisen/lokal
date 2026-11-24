/**
 * gardssalg-owner-dashboard-testfunn.test.ts — dev-request 2026-11-24-
 * opplevagent-eierdashbord-lyst-tema-og-testfunn, slices 5, 7 and 8.
 *
 *   S5  the claim page («Er dette din bedrift?», GET /kategori/gardssalg/eier/:slug):
 *       the logged-in owner of THAT profile with the dashboard on → 302 to
 *       «Oversikt» (…/portal). Anonymous, another profile's owner, an invalid
 *       session and the dashboard off → 200, the claim page byte-identical.
 *   S7  «Mine valg» in the shell: no «Tilbake til eierportalen» button and no
 *       text under 13px. Outside the shell the page is as before; Rett fra
 *       Bonden's page keeps the button and its CSS.
 *   S8  the red «Teksten i denne profilen er låst av Opplevagent-support» box
 *       on the portal: only for content_source 'manual' (the row-level lock
 *       that also disables the fields); not for 'claim', NULL or
 *       'provider_site'.
 *
 * Exported runGardssalgOwnerDashboardTestfunnTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-testfunn.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";
const LOCK_BOX = "Teksten i denne profilen er låst av Opplevagent-support.";
const BACK_BUTTON = "Tilbake til eierportalen";

/** Every font-size in px a page can end up with (later rules with the same selector win). */
export function smallFontSizes(html: string, minPx: number): string[] {
  const toPx = (v: string): number | null => {
    const m = /^\s*([\d.]+)\s*(px|rem)\s*$/i.exec(v);
    if (!m) return null;
    return m[2].toLowerCase() === "px" ? Number(m[1]) : Number(m[1]) * 16;
  };
  const effective = new Map<string, string>();
  for (const block of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    // Flatten @media wrappers: the selector of a nested rule is keyed with its media query.
    let css = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
    let media = "";
    const re = /(@media[^{]*)\{|([^{}]+)\{([^{}]*)\}|\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      if (m[1]) { media = m[1].trim(); continue; }
      if (!m[2]) { media = ""; continue; }
      const fs = /(?:^|;)\s*font-size\s*:\s*([^;!]+)/i.exec(m[3]);
      if (!fs) continue;
      for (const sel of m[2].split(",")) effective.set(`${media}|${sel.trim()}`, fs[1].trim());
    }
  }
  const out: string[] = [];
  for (const [sel, v] of effective) {
    const px = toPx(v);
    if (px !== null && px < minPx) out.push(`${sel}: ${v}`);
  }
  for (const m of html.matchAll(/style="[^"]*font-size\s*:\s*([^;"]+)/gi)) {
    const px = toPx(m[1]);
    if (px !== null && px < minPx) out.push(`inline: ${m[1]}`);
  }
  return out;
}

export function runGardssalgOwnerDashboardTestfunnTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    const ALLOW = "gardssalg:tf-a,gardssalg:tf-b,gardssalg:tf-lock";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
    const LOOPBACK_KEY = "127.0.0.1";
    const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
    try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
    const servers: any[] = [];
    let prevRfbDb: any = null;
    let initMod: typeof import("../database/init") | null = null;

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
      const fo = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
      const pg = require("../owner-features/page") as typeof import("../owner-features/page");

      // ── fixtures: no hjemmeside/epost, so the claim page harvests nothing ──
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, NULL, NULL, @content_source, '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, '2026-11-01 10:00:00')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, content_source: string | null = "claim") =>
        insertProvider.run({ id, navn, slug, org_nr: org, content_source });
      mk("tf-a", "Testgård A", "tfagard", "918200001");
      mk("tf-b", "Testgård B", "tfbgard", "918200002");
      mk("tf-lock", "Testgård Låst", "tflockgard", "918200003", "manual");
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const [pid, tok] of [["tf-a", "toktf-a"], ["tf-b", "toktf-b"], ["tf-lock", "toktf-lock"]]) {
        claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, tok);
      }

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const app = expressMod();
      app.use("/", claimRouter);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method: "GET", host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          r.end();
        });
      const cookie = (t: string) => ({ Cookie: `oa_owner_session=${t}` });
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };
      const claimUrl = (slug: string) => `/kategori/gardssalg/eier/${slug}`;

      // ── S5: the claim page ────────────────────────────────────────────
      setFlag(undefined);
      const anonOff = await get(claimUrl("tfagard"));
      assertEq(anonOff.status, 200, "S5a: flag off, anonymous → the claim page (200)");
      assertTrue(anonOff.body.includes("Er dette din bedrift?"), "S5b: it is «Er dette din bedrift?»");
      const ownerOff = await get(claimUrl("tfagard"), cookie("toktf-a"));
      assertEq([ownerOff.status, ownerOff.body], [200, anonOff.body], "S5c: flag off, the owner → the claim page as before (dashboard off)");

      setFlag("pilot");
      const owner = await get(claimUrl("tfagard"), cookie("toktf-a"));
      assertEq(owner.status, 302, "S5d: pilot, the logged-in owner of the profile → 302");
      assertEq(owner.headers.location, "/kategori/gardssalg/eier/tfagard/portal", "S5e: … to «Oversikt» (the dashboard's portal path)");
      const ownerSent = await get(`${claimUrl("tfagard")}?status=sent`, cookie("toktf-a"));
      assertEq([ownerSent.status, ownerSent.headers.location], [302, "/kategori/gardssalg/eier/tfagard/portal"], "S5f: a ?status= query does not change the redirect");
      const portal = await get(owner.headers.location, cookie("toktf-a"));
      assertEq(portal.status, 200, "S5g: the redirect target opens for the owner (no loop)");
      const anon = await get(claimUrl("tfagard"));
      assertEq([anon.status, anon.body], [200, anonOff.body], "S5h: pilot, anonymous → the claim page, byte-identical");
      const other = await get(claimUrl("tfagard"), cookie("toktf-b"));
      assertEq([other.status, other.body], [200, anonOff.body], "S5i: pilot, another profile's owner → the claim page, byte-identical");
      const bogus = await get(claimUrl("tfagard"), cookie("finnes-ikke"));
      assertEq([bogus.status, bogus.body], [200, anonOff.body], "S5j: pilot, an invalid session → the claim page, byte-identical");
      expDb.prepare(`UPDATE gardssalg_claims SET revoked_at = datetime('now') WHERE provider_id = 'tf-a'`).run();
      const revoked = await get(claimUrl("tfagard"), cookie("toktf-a"));
      assertEq(revoked.status, 200, "S5k: pilot, the owner's claim revoked → the claim page (no redirect)");
      expDb.prepare(`UPDATE gardssalg_claims SET revoked_at = NULL WHERE provider_id = 'tf-a'`).run();
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:tf-b";
      const offList = await get(claimUrl("tfagard"), cookie("toktf-a"));
      assertEq([offList.status, offList.body], [200, anonOff.body], "S5l: pilot, the profile off the allowlist → the claim page, byte-identical");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;
      assertEq((await get(claimUrl("finnesikke"), cookie("toktf-a"))).status, 404, "S5m: unknown slug → 404 as before");

      // ── S7: «Mine valg» in the shell ──────────────────────────────────
      setFlag(undefined);
      const valgOff = await get(`${claimUrl("tfagard")}/valg`, cookie("toktf-a"));
      setFlag("pilot");
      const valgOn = await get(`${claimUrl("tfagard")}/valg`, cookie("toktf-a"));
      assertEq([valgOff.status, valgOn.status], [200, 200], "S7a: «Mine valg» opens with the flag off and on");
      assertTrue(valgOn.body.includes('data-gardssalg-dashboard="1"'), "S7b: pilot → «Mine valg» is in the shell");
      assertTrue(!valgOn.body.includes(BACK_BUTTON), "S7c: in the shell → no «Tilbake til eierportalen» button");
      assertTrue(valgOff.body.includes(`<a class="ep-btn ep-btn-secondary" href="/kategori/gardssalg/eier/tfagard/portal">${BACK_BUTTON}</a>`), "S7d: outside the shell → the button as before");
      const small = smallFontSizes(valgOn.body, 13);
      assertEq(small, [], "S7e: in the shell → no text on «Mine valg» under 13px");
      assertTrue(smallFontSizes(valgOff.body, 13).length > 0, "S7f: outside the shell the sizes are as before (the probe sees the small ones)");
      assertTrue(!valgOff.body.includes(fo.GARDSSALG_DASHBOARD_MIN_TEXT_CSS), "S7g: outside the shell → no min-size CSS");
      // RFB: the shared page without a variant keeps the button and its CSS.
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const rfbBody = pg.renderOwnerFeaturesPageBody({
        agent: { id: "rfb-1", name: "Gård" }, resolved: rs.resolveOwnerFeatures("rfb", "rfb-1", { db: rfbDb as any }), level: null, showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
      } as any);
      assertTrue(rfbBody.includes(`href="/eier/rfb-1/portal">${BACK_BUTTON}</a>`), "S7h: Rett fra Bonden «Mine valg» keeps «Tilbake til eierportalen»");
      assertTrue(rfbBody.includes(`<style>${pg.OWNER_PAGE_CSS}</style>`) && !rfbBody.includes(fo.GARDSSALG_DASHBOARD_MIN_TEXT_CSS), "S7i: Rett fra Bonden page CSS is the shared OWNER_PAGE_CSS, nothing added");
      const crypto = require("crypto") as typeof import("crypto");
      assertEq(crypto.createHash("sha256").update(pg.OWNER_PAGE_CSS).digest("hex"), OWNER_PAGE_CSS_SHA256, "S7j: OWNER_PAGE_CSS (Rett fra Bonden) is byte-identical");

      // ── S8: the lock box ──────────────────────────────────────────────
      setFlag(undefined);
      for (const [cs, label] of [["claim", "'claim' (an ordinary claimed owner)"], [null, "NULL"], ["provider_site", "'provider_site'"]] as const) {
        expDb.prepare(`UPDATE experience_providers SET content_source = ? WHERE id = 'tf-b'`).run(cs);
        for (const flag of [undefined, "pilot"]) {
          setFlag(flag);
          const p = await get(`${claimUrl("tfbgard")}/portal`, cookie("toktf-b"));
          assertTrue(p.status === 200 && !p.body.includes(LOCK_BOX), `S8a: content_source ${label}, flag ${flag ?? "off"} → no lock box`);
          assertTrue(!/<textarea id="f-about" name="field_about_text" disabled>/.test(p.body), `S8b: content_source ${label}, flag ${flag ?? "off"} → the fields are editable`);
        }
      }
      for (const flag of [undefined, "pilot"]) {
        setFlag(flag);
        const p = await get(`${claimUrl("tflockgard")}/portal`, cookie("toktf-lock"));
        assertTrue(p.status === 200 && p.body.includes(LOCK_BOX), `S8c: content_source 'manual', flag ${flag ?? "off"} → the lock box`);
        assertTrue(/<textarea id="f-about" name="field_about_text" disabled>/.test(p.body), `S8d: content_source 'manual', flag ${flag ?? "off"} → the fields are disabled (the box tells the truth)`);
      }
    } catch (e: any) {
      failed++;
      failures.push(`unexpected error: ${e?.stack || e}`);
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
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

/** sha256 of OWNER_PAGE_CSS at main 58e026f (Rett fra Bonden's «Mine valg» CSS must not change). */
const OWNER_PAGE_CSS_SHA256 = "48588798abafc45ae84c768962a95c2b84666664fe0a58abddb12774c3e4e7f8";

if (require.main === module) {
  runGardssalgOwnerDashboardTestfunnTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
