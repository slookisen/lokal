/**
 * opplevelser-gardssalg-outreach-size-gate.test.ts — tests for Skive 1 of
 * dev-request 2026-08-09-daglig-outreach-klargjoering-og-stoerrelsesgate:
 * the antall_ansatte size signal + hard exclusion gate layered onto
 * GET /admin/gardssalg-outreach-readiness, POST /admin/gardssalg-outreach-
 * preflight, and POST /admin/gardssalg-outreach-pilot-send, plus the new
 * L1 knob endpoints GET/POST /admin/gardssalg-outreach-size-gate.
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers) and opplevelser-gardssalg-outreach-pilot-send.
 * test.ts's fake-transporter harness for the pilot-send apply:true case.
 *
 * Covers:
 *   AK1 — GET readiness exposes antall_ansatte + size_flag per row; the
 *         Macks Ølbryggeri fixture (org 975967093, antall_ansatte 119)
 *         tiers size_flag "stor".
 *   AK2 — a row with no registered antall_ansatte (null) tiers "ukjent",
 *         never "liten".
 *   AK3 — pilot-send against a "stor"-flagged, otherwise outreach_ready
 *         producer returns skipped/reason:"large_company_excluded", even
 *         with apply:true — proven via the REAL send boundary (a fake
 *         transporter that must never be called) and by asserting
 *         experience_outreach_sent_log gains no new row.
 *   AK4 — the threshold is read from the DB-backed L1 knob (POST
 *         /admin/gardssalg-outreach-size-gate), not a compiled constant:
 *         changing it via that endpoint moves a row's size_flag between
 *         "liten"/"stor" on the very next call, with no process restart.
 *   (e) the gate only EXCLUDES: "liten" and "ukjent" never auto-clear a row
 *       that is NO-GO for an unrelated (content-readiness) reason.
 *   (f) the on/off switch: enabled:false stops preflight/pilot-send from
 *       treating "stor" as blocking, while readiness keeps reporting
 *       size_flag "stor" regardless (informational, unaffected by the
 *       switch).
 *   (g) GET/POST /admin/gardssalg-outreach-size-gate: auth gate, dry-run
 *       default (no write), apply persists, default reported when nobody
 *       has ever configured it.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method ?? "GET";
    const url = opts.url ?? "/admin/gardssalg-outreach-readiness";
    const headers = opts.headers || {};
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

const VERIFIED_PROVENANCE = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-09T00:00:00.000Z" },
});

export function runOpplevelserGardssalgOutreachSizeGateTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-size-gate-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    const sizeGatePath = require.resolve("../services/gardssalg-outreach-size-gate");
    const emailPath = require.resolve("../services/email-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, sizeGatePath, emailPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const sizeGateSvc = require("../services/gardssalg-outreach-size-gate") as typeof import("../services/gardssalg-outreach-size-gate");

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      let sent: Array<Record<string, any>> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          sent.push(mailOptions);
          return { messageId: `stub-${sent.length}` };
        },
      };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @about_text, @visit_text, @opening_hours_text,
            @products, @content_source, @booking_live, @catalog_hidden, @slug, @field_provenance,
            @brreg_verified, @antall_ansatte,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── AK1/AK3 fixture: Macks Ølbryggeri — otherwise fully outreach_ready
      // (krav 2 content-complete, searchable, website-verified, no conflict),
      // org_nr 975967093, antall_ansatte 119 (>= the default threshold 25).
      insertProvider.run({
        id: "prov-macks", navn: "Macks Ølbryggeri", org_nr: "975967093", kommune: "Tromsø",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@macksolbryggerifixture.no", telefon: null, hjemmeside: "https://macksolbryggerifixture.no",
        about_text: "Om bryggeriet.", visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "macks-olbryggeri", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 119,
      });

      // ── AK2 fixture: otherwise outreach_ready, antall_ansatte NEVER set
      // (Brreg has no registered figure) — must tier "ukjent", never "liten".
      insertProvider.run({
        id: "prov-unmeasured", navn: "Umålt Gård AS", org_nr: "222000111", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@umaaltgardfixture.no", telefon: null, hjemmeside: "https://umaaltgardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "umaalt-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: null,
      });

      // ── "liten" fixture: otherwise outreach_ready, antall_ansatte well
      // under the default threshold — must stay go:true (the gate excludes,
      // never approves, but must also never BLOCK a legitimately small row).
      insertProvider.run({
        id: "prov-liten", navn: "Liten Gård AS", org_nr: "333000222", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@litengardfixture.no", telefon: null, hjemmeside: "https://litengardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "liten-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5,
      });

      // ── (e) fixture: NOT content-complete (missing products -> krav 2
      // needs_enrichment) AND small (antall_ansatte 3) — proves "liten"
      // never auto-clears an unrelated NO-GO reason (krav 5).
      insertProvider.run({
        id: "prov-liten-notready", navn: "Liten Uferdig Gård", org_nr: "444000333", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@litenuferdiggardfixture.no", telefon: null, hjemmeside: "https://litenuferdiggardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 1, antall_ansatte: 3,
      });

      // ── AK4 fixture: right at the boundary — 22 employees. "liten" at the
      // default threshold (25), "stor" once the knob is lowered to 20.
      insertProvider.run({
        id: "prov-wettre", navn: "Wettre Gård AS", org_nr: "555000444", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@wettregardfixture.no", telefon: null, hjemmeside: "https://wettregardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "wettre-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 22,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      // ══ AK1: readiness exposes antall_ansatte + size_flag; Macks -> stor ══
      const readiness1 = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-readiness", headers: auth,
      });
      assertEq(readiness1.status, 200, "AK1 a: readiness -> 200");
      const macksRow = (readiness1.body.providers as any[]).find((r) => r.name === "Macks Ølbryggeri");
      assertTrue(!!macksRow, "AK1 b: Macks row present in readiness");
      assertEq(macksRow?.org_nr, "975967093", "AK1 c: Macks org_nr passthrough");
      assertEq(macksRow?.antall_ansatte, 119, "AK1 d: Macks antall_ansatte is 119");
      assertEq(macksRow?.size_flag, "stor", "AK1 e: Macks size_flag is 'stor' (119 >= default threshold 25)");
      assertEq(macksRow?.readiness_tier, "outreach_ready", "AK1 f: Macks is otherwise outreach_ready (isolates the size gate as the sole exclusion reason below)");

      // ══ AK2: unmeasured row -> "ukjent", never "liten" ══════════════════
      const unmeasuredRow = (readiness1.body.providers as any[]).find((r) => r.name === "Umålt Gård AS");
      assertTrue(!!unmeasuredRow, "AK2 a: unmeasured row present");
      assertEq(unmeasuredRow?.antall_ansatte, null, "AK2 b: antall_ansatte is null");
      assertEq(unmeasuredRow?.size_flag, "ukjent", "AK2 c: size_flag is 'ukjent', not 'liten'");

      const litenRow = (readiness1.body.providers as any[]).find((r) => r.name === "Liten Gård AS");
      assertEq(litenRow?.size_flag, "liten", "sanity: 5 < 25 -> 'liten'");

      // ══ AK3: preflight + pilot-send block Macks, even with apply:true ═══
      const preflightMacks = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-preflight", headers: auth,
        body: { provider_ids: ["prov-macks"] },
      });
      assertEq(preflightMacks.status, 200, "AK3 a: preflight -> 200");
      assertEq(
        preflightMacks.body.results[0],
        { provider_id: "prov-macks", name: "Macks Ølbryggeri", go: false, reason: "large_company_excluded" },
        "AK3 b: preflight go:false, reason:large_company_excluded",
      );

      const beforeLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;
      const sentBefore = sent.length;
      const pilotMacksApply = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-pilot-send", headers: auth,
        body: { provider_ids: ["prov-macks"], apply: true },
      });
      assertEq(pilotMacksApply.status, 200, "AK3 c: pilot-send apply:true -> 200 (reported, not rejected)");
      assertEq(
        pilotMacksApply.body.results[0],
        { provider_id: "prov-macks", status: "skipped", reason: "large_company_excluded" },
        "AK3 d: pilot-send skipped, reason:large_company_excluded, EVEN with apply:true",
      );
      assertEq(sent.length, sentBefore, "AK3 e: no email left the real send boundary");
      const afterLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;
      assertEq(afterLogCount, beforeLogCount, "AK3 f: experience_outreach_sent_log gained no new row");

      // Also without apply (dry-run) — same block, same reason.
      const pilotMacksDry = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-pilot-send", headers: auth,
        body: { provider_ids: ["prov-macks"] },
      });
      assertEq(
        pilotMacksDry.body.results[0],
        { provider_id: "prov-macks", status: "skipped", reason: "large_company_excluded" },
        "AK3 g: dry-run pilot-send also blocks Macks",
      );

      // ── (e) "liten" that's ALSO NO-GO for an unrelated reason stays that
      // reason — the gate never auto-clears anything.
      const preflightLitenNotReady = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-preflight", headers: auth,
        body: { provider_ids: ["prov-liten-notready"] },
      });
      assertEq(
        preflightLitenNotReady.body.results[0],
        { provider_id: "prov-liten-notready", name: "Liten Uferdig Gård", go: false, reason: "needs_enrichment" },
        "(e) a small (liten) row that's otherwise not content-complete stays needs_enrichment, unaffected by the size gate",
      );

      // A legitimately outreach_ready "liten" row stays go:true — the gate
      // only ever excludes "stor", never blocks anything else.
      const preflightLiten = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-preflight", headers: auth,
        body: { provider_ids: ["prov-liten", "prov-unmeasured"] },
      });
      assertEq(
        preflightLiten.body.results[0],
        { provider_id: "prov-liten", name: "Liten Gård AS", go: true, reason: null },
        "(e) an otherwise-ready 'liten' row stays go:true",
      );
      assertEq(
        preflightLiten.body.results[1],
        { provider_id: "prov-unmeasured", name: "Umålt Gård AS", go: true, reason: null },
        "(e) an otherwise-ready 'ukjent' row stays go:true — ukjent is never auto-approved, but never auto-blocked either",
      );

      // ══ (g) GET/POST /admin/gardssalg-outreach-size-gate ════════════════
      const noKeyGet = await callRoute(opplevelserRouter, { method: "GET", url: "/admin/gardssalg-outreach-size-gate" });
      assertEq(noKeyGet.status, 403, "(g) a1: GET size-gate config without X-Admin-Key -> 403");
      const noKeyPost = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", body: { threshold: 10 },
      });
      assertEq(noKeyPost.status, 403, "(g) a2: POST size-gate config without X-Admin-Key -> 403");

      const configBefore = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
      });
      assertEq(configBefore.status, 200, "(g) b1: GET size-gate config -> 200");
      assertEq(configBefore.body.config.enabled, true, "(g) b2: default enabled:true (nobody has configured it yet)");
      assertEq(configBefore.body.config.threshold, 25, "(g) b3: default threshold:25");
      assertEq(configBefore.body.config.is_default, true, "(g) b4: is_default:true before any write");

      const dryRunSet = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 20 },
      });
      assertEq(dryRunSet.status, 200, "(g) c1: POST size-gate config (no apply) -> 200");
      assertEq(dryRunSet.body.dry_run, true, "(g) c2: dry_run true (apply absent)");
      assertEq(dryRunSet.body.would_be.threshold, 20, "(g) c3: would_be.threshold reflects the proposed value");
      const configUnchanged = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
      });
      assertEq(configUnchanged.body.config.threshold, 25, "(g) c4: dry-run wrote NOTHING — threshold still 25");

      // ══ AK4: apply a threshold change via the admin lever, no restart ═══
      // prov-wettre sits at antall_ansatte:22 — "liten" at threshold 25.
      const readinessBeforeThresholdChange = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-readiness", headers: auth,
      });
      const wettreBefore = (readinessBeforeThresholdChange.body.providers as any[]).find((r) => r.name === "Wettre Gård AS");
      assertEq(wettreBefore?.size_flag, "liten", "AK4 a: Wettre (22) is 'liten' at the default threshold 25");

      const applySet = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 20, note: "AK4 test: lower threshold to catch Wettre too" },
      });
      assertEq(applySet.status, 200, "AK4 b: POST with apply omitted -> 200");
      assertEq(applySet.body.dry_run, true, "AK4 c: apply omitted -> dry_run true (no write yet)");

      const applySetForReal = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 20, apply: true },
      });
      assertEq(applySetForReal.status, 200, "AK4 d: POST apply:true -> 200");
      assertEq(applySetForReal.body.dry_run, false, "AK4 e: dry_run false");
      assertEq(applySetForReal.body.config.threshold, 20, "AK4 f: config.threshold persisted as 20");
      assertEq(applySetForReal.body.config.is_default, false, "AK4 g: is_default false once written");

      // The SAME process, no require.cache reset, no restart — the very
      // next readiness call must reflect the new threshold immediately.
      const readinessAfterThresholdChange = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-readiness", headers: auth,
      });
      const wettreAfter = (readinessAfterThresholdChange.body.providers as any[]).find((r) => r.name === "Wettre Gård AS");
      assertEq(wettreAfter?.size_flag, "stor", "AK4 h: Wettre (22) is now 'stor' — threshold lowered to 20 with NO deploy/restart");

      // The same change also flips preflight's blocking behavior for Wettre.
      const preflightWettreAfter = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-preflight", headers: auth,
        body: { provider_ids: ["prov-wettre"] },
      });
      assertEq(
        preflightWettreAfter.body.results[0],
        { provider_id: "prov-wettre", name: "Wettre Gård AS", go: false, reason: "large_company_excluded" },
        "AK4 i: preflight now excludes Wettre too, after the live threshold change",
      );

      // Restore threshold to 25 for the remaining assertions below.
      await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 25, apply: true },
      });

      // ══ (f) enabled:false turns the BLOCK off, size_flag reporting stays ═
      const disableGate = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { enabled: false, apply: true },
      });
      assertEq(disableGate.status, 200, "(f) a: POST enabled:false -> 200");
      assertEq(disableGate.body.config.enabled, false, "(f) b: config.enabled false persisted");

      const preflightMacksDisabled = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-preflight", headers: auth,
        body: { provider_ids: ["prov-macks"] },
      });
      assertEq(
        preflightMacksDisabled.body.results[0],
        { provider_id: "prov-macks", name: "Macks Ølbryggeri", go: true, reason: null },
        "(f) c: with the gate disabled, Macks preflights go:true again (content-readiness otherwise fine)",
      );

      const readinessDisabled = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-readiness", headers: auth,
      });
      const macksRowDisabled = (readinessDisabled.body.providers as any[]).find((r) => r.name === "Macks Ølbryggeri");
      assertEq(macksRowDisabled?.size_flag, "stor", "(f) d: readiness KEEPS reporting size_flag 'stor' even with the gate disabled (informational, unaffected by the switch)");

      // Re-enable for cleanliness (not strictly required — process teardown
      // resets the DB — but keeps this test's intent obvious top-to-bottom).
      await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { enabled: true, apply: true },
      });

      // ══ (h) applyGardssalgBrregVerified's antall_ansatte piggyback ══════
      // Unit-level, bypassing HTTP: proves the write path the brreg-verify
      // route (POST /admin/gardssalg-brreg-verify) uses to populate
      // antall_ansatte actually persists it AND only appends "antall_ansatte"
      // to fields_written when the value genuinely changes (the existing
      // opplevelser-gardssalg-brreg-verify.test.ts's fixture never supplies
      // an employees figure and must keep asserting fields_written ===
      // ["brreg_verified","brreg_active"] exactly — this proves why that
      // stays true: a no-data call is a strict no-op on this column).
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      insertProvider.run({
        id: "prov-bv-unverified", navn: "Ubekreftet Gård AS", org_nr: "666000555", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ubekreftetgardfixture.no", telefon: null, hjemmeside: "https://ubekreftetgardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 0, antall_ansatte: null,
      });
      const writtenWithEmployees = expStore.applyGardssalgBrregVerified(
        "prov-bv-unverified",
        "https://data.brreg.no/enhetsregisteret/api/enheter/666000555",
        "test-batch",
        42,
      );
      assertEq(
        writtenWithEmployees,
        ["brreg_verified", "brreg_active", "antall_ansatte"],
        "(h) a: fields_written includes antall_ansatte when a real figure changes it",
      );
      const bvRow = expDb
        .prepare(`SELECT antall_ansatte, field_provenance FROM experience_providers WHERE id = 'prov-bv-unverified'`)
        .get() as { antall_ansatte: number; field_provenance: string };
      assertEq(bvRow.antall_ansatte, 42, "(h) b: antall_ansatte persisted (42)");
      const bvProv = JSON.parse(bvRow.field_provenance || "{}");
      assertTrue(
        typeof bvProv.antall_ansatte?.fetched_at === "string",
        "(h) c: field_provenance.antall_ansatte carries a fetched_at timestamp",
      );

      // A second provider, verified with NO employees figure at all
      // (undefined, matching every pre-Skive-1 test double's stub shape) —
      // must NOT touch antall_ansatte, and must NOT list it in fields_written.
      insertProvider.run({
        id: "prov-bv-nodata", navn: "Ingen Data Gård AS", org_nr: "777000666", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ingendatagardfixture.no", telefon: null, hjemmeside: "https://ingendatagardfixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 0, antall_ansatte: null,
      });
      const writtenNoEmployees = expStore.applyGardssalgBrregVerified(
        "prov-bv-nodata",
        "https://data.brreg.no/enhetsregisteret/api/enheter/777000666",
        "test-batch",
      );
      assertEq(
        writtenNoEmployees,
        ["brreg_verified", "brreg_active"],
        "(h) d: fields_written excludes antall_ansatte when the caller supplies no figure (undefined) — regression guard for the existing brreg-verify test's exact-array assertion",
      );
      const bvNoDataRow = expDb
        .prepare(`SELECT antall_ansatte FROM experience_providers WHERE id = 'prov-bv-nodata'`)
        .get() as { antall_ansatte: number | null };
      assertEq(bvNoDataRow.antall_ansatte, null, "(h) e: antall_ansatte stays null when no figure was supplied");

      // ══ (i) pure computeGardssalgSizeFlag / config module sanity ═══════
      assertEq(sizeGateSvc.computeGardssalgSizeFlag(119, 25), "stor", "(i) a: 119 >= 25 -> stor");
      assertEq(sizeGateSvc.computeGardssalgSizeFlag(22, 25), "liten", "(i) b: 22 < 25 -> liten");
      assertEq(sizeGateSvc.computeGardssalgSizeFlag(25, 25), "stor", "(i) c: boundary is inclusive (>=)");
      assertEq(sizeGateSvc.computeGardssalgSizeFlag(null, 25), "ukjent", "(i) d: null -> ukjent");
      assertEq(sizeGateSvc.computeGardssalgSizeFlag(undefined, 25), "ukjent", "(i) e: undefined -> ukjent");

      // ══ (j) POST size-gate: `note` is only touched when the caller sends
      // it — omitting it from a later apply must NOT wipe a previously-set
      // note. Regression guard for the bug where `patch.note` was always
      // included (as null when absent), silently clearing note on every
      // apply that didn't re-supply it. Explicit `note: null` / `note: ""`
      // still clear it on purpose.
      const noteSet = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 30, note: "context", apply: true },
      });
      assertEq(noteSet.status, 200, "(j) a: POST threshold+note apply:true -> 200");
      assertEq(noteSet.body.config.note, "context", "(j) b: note persisted as 'context'");

      const noteAfterUnrelatedEnabledChange = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { enabled: false, apply: true },
      });
      assertEq(noteAfterUnrelatedEnabledChange.status, 200, "(j) c: POST enabled:false (no note field) apply:true -> 200");
      assertEq(
        noteAfterUnrelatedEnabledChange.body.config.note,
        "context",
        "(j) d: note UNCHANGED — an apply that omits `note` entirely must not wipe the previously-set note",
      );

      const noteAfterUnrelatedThresholdChange = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 31, apply: true },
      });
      assertEq(noteAfterUnrelatedThresholdChange.status, 200, "(j) e: POST threshold-only (no note field) apply:true -> 200");
      assertEq(
        noteAfterUnrelatedThresholdChange.body.config.note,
        "context",
        "(j) f: note still UNCHANGED after a threshold-only apply",
      );

      const configAfterUnrelatedChanges = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
      });
      assertEq(
        configAfterUnrelatedChanges.body.config.note,
        "context",
        "(j) g: GET confirms note survives across two unrelated applies via a fresh read",
      );

      // Explicit note:null clears it on purpose.
      const noteClearedNull = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 31, note: null, apply: true },
      });
      assertEq(noteClearedNull.status, 200, "(j) h: POST note:null apply:true -> 200");
      assertEq(noteClearedNull.body.config.note, null, "(j) i: explicit note:null clears the note");

      // Explicit note:"" also clears it on purpose (same normalization as a
      // fresh write: an empty/whitespace-only string is stored as null).
      const noteResetForEmptyCheck = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 31, note: "set again", apply: true },
      });
      assertEq(noteResetForEmptyCheck.body.config.note, "set again", "(j) j: note re-set to 'set again'");
      const noteClearedEmpty = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 31, note: "", apply: true },
      });
      assertEq(noteClearedEmpty.status, 200, "(j) k: POST note:'' apply:true -> 200");
      assertEq(noteClearedEmpty.body.config.note, null, "(j) l: explicit note:'' also clears the note");

      // ══ (k) POST size-gate: `note` must be rejected with 400 when it's
      // neither a string nor null. Regression guard for the bug where a
      // non-string, non-undefined `note` (e.g. a number) silently fell
      // through the ternary to `null`, wiping an existing note with a 200
      // instead of being rejected with a 400.
      const noteSetForTypeGuard = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 25, note: "hello", apply: true },
      });
      assertEq(noteSetForTypeGuard.status, 200, "(k) a: POST threshold+note:'hello' apply:true -> 200");
      assertEq(noteSetForTypeGuard.body.config.note, "hello", "(k) b: note persisted as 'hello'");

      const noteBadType = await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 25, note: 42, apply: true },
      });
      assertEq(noteBadType.status, 400, "(k) c: POST note:42 (number) apply:true -> 400");
      assertEq(
        noteBadType.body.error,
        "note must be a string or null",
        "(k) d: 400 error message names `note`",
      );

      const configAfterBadTypeReject = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
      });
      assertEq(
        configAfterBadTypeReject.body.config.note,
        "hello",
        "(k) e: note UNCHANGED after the rejected note:42 call — proves reject-before-write, not just the 400 status",
      );

      // Restore threshold to 25 for consistency with the rest of this file's
      // convention of leaving the knob at its default when a section is done.
      await callRoute(opplevelserRouter, {
        method: "POST", url: "/admin/gardssalg-outreach-size-gate", headers: auth,
        body: { threshold: 25, apply: true },
      });
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-outreach-size-gate: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-outreach-size-gate.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOutreachSizeGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
