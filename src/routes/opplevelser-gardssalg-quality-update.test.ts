/**
 * opplevelser-gardssalg-quality-update.test.ts — DB/HTTP-level tests for
 * POST /admin/gardssalg-content-quality-update (dev-request 2026-08-17-
 * forsyningskjede-samarbeid-og-kvalitetsoppdatering, Skive 3 — "erstatter
 * fill-only"). The PURE classifier/margin/plan logic (services/gardssalg-
 * quality-update.ts) has its own dedicated unit tests
 * (gardssalg-quality-update.test.ts, no DB needed) — this file covers
 * everything that DOES need a DB and/or the real fetch pipeline:
 *
 *   (a) AC5 — owner-lock, both branches: a 'claim' row where the owner has
 *       touched about_text specifically (field_provenance.owner_locks.
 *       about_text) is NEVER replaced, even with a clean, defect-free
 *       candidate and an objectively-defective current value; a 'claim' row
 *       where the owner has touched a DIFFERENT field (or none at all) IS
 *       free for about_text.
 *   (b) AC6 — a row with an objectively-defective current value (CSS
 *       leakage) IS replaced by a valid candidate in apply mode; a row with
 *       a fine current value and a candidate that does NOT clear the margin
 *       is NOT touched, and dry-run reports the same decisions with zero
 *       writes.
 *   (c) AC7 — every replacement writes exactly one gardssalg_content_audit
 *       row with correct old_value/new_value, and the EXISTING POST
 *       /admin/gardssalg-content-rollback endpoint (unmodified) restores it.
 *   (d) AC12/13 — the Bringebærlandet-shaped fixture (opening_hours_text
 *       containing literal "Previous Next" mid-string, truncated word
 *       fragments "ebook"/"kilome"): dry-run flags it as a defect diff
 *       entry; apply replaces it with a clean candidate; a LOCKED variant of
 *       the same row is correctly reported owner_locked instead, never
 *       silently left untouched for an unrelated reason.
 *   (e) anti-churn (Skive 3-D): a second apply run within 30 days on the
 *       SAME (provider, field) does not re-replace when the source content
 *       hash is unchanged, but a genuinely changed source page unblocks it.
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup exactly
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle(), globalThis.fetch mocked for the
 * candidate-generation pipeline + api.anthropic.com judge calls).
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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-content-quality-update";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgQualityUpdateTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-quality-update-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-gqu";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const gqUpdatePath = require.resolve("../services/gardssalg-quality-update");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, gqUpdatePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const VERIFIED_PROVENANCE = { hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" } };
      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      function insertProvider(params: {
        id: string; navn: string; hjemmeside: string; content_source: string | null;
        about_text?: string | null; visit_text?: string | null; opening_hours_text?: string | null;
        field_provenance?: string | Record<string, unknown> | null;
      }): void {
        const fp = params.field_provenance === undefined
          ? JSON.stringify(VERIFIED_PROVENANCE)
          : params.field_provenance === null
            ? null
            : typeof params.field_provenance === "string"
              ? params.field_provenance
              : JSON.stringify(params.field_provenance);
        insertProviderStmt.run({
          id: params.id, navn: params.navn, hjemmeside: params.hjemmeside, content_source: params.content_source,
          about_text: params.about_text ?? null, visit_text: params.visit_text ?? null,
          opening_hours_text: params.opening_hours_text ?? null, field_provenance: fp,
        });
      }

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source,
                  content_evidence_url, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // ── Shared fetch mock ────────────────────────────────────────────
      // hostHtml: hostname -> homepage HTML to serve. All hosts share the
      // SAME html unless overridden per test (the route fetches the SAME
      // homepage for every field on a row in one crFetchGardssalgContent
      // call — there is no per-field fetch).
      const hostHtml = new Map<string, string>();
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const u = new URL(urlStr);
        // Homepage path only — every fixture's website content lives on the
        // primary page. crFetchGardssalgContent also tries up to 4 candidate
        // sub-paths (GARDSSALG_CONTENT_PATHS); returning 404 for those keeps
        // combinedHtml a SINGLE copy of the page text (a 404 sub-page costs
        // nothing, same as production — see that function's own doc
        // comment). This matters specifically for extractOpeningHours()'s
        // fixed 80-char window: with sub-pages echoing the SAME body text
        // (as every fixture here does), the window can otherwise bleed into
        // a REPEATED copy of the page and manufacture a truncation artifact
        // that has nothing to do with the fixture's own content.
        if (hostHtml.has(u.hostname) && (u.pathname === "/" || u.pathname === "")) {
          const html = hostHtml.get(u.hostname)!;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      const CLEAN_ABOUT =
        "Vi er en gårdsbutikk på Toten som produserer og selger egen sider og eplemost, og tilbyr smaking i sesong.";
      const CLEAN_VISIT =
        "Besøk gårdsbutikken vår i sommersesongen. Book gjerne en omvisning på forhånd, vi holder til rett ved fylkesveien.";
      const CLEAN_HOURS = "Åpent lør og søn kl. 10-17. Følger for øvrig Vinmonopolets ordinære åpningstider.";
      function cleanHtmlFor(about: string, visit: string): string {
        return `<html><head><meta property="og:description" content="${about}"></head><body><p>${visit}</p></body></html>`;
      }

      // ── (a) AC5: owner-lock, both branches ───────────────────────────
      const CSS_LEAK = ".hero{color:#fff;padding:10px;} body{margin:0!important;} .nav{display:flex;}";
      hostHtml.set("prov-a-locked.example.no", cleanHtmlFor(CLEAN_ABOUT, CLEAN_VISIT));
      insertProvider({
        id: "prov-a-locked", navn: "Prov A Locked Gard", hjemmeside: "https://prov-a-locked.example.no",
        content_source: "claim", about_text: CSS_LEAK,
        field_provenance: { ...VERIFIED_PROVENANCE, owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } },
      });
      hostHtml.set("prov-a-free.example.no", cleanHtmlFor(CLEAN_ABOUT, CLEAN_VISIT));
      insertProvider({
        id: "prov-a-free", navn: "Prov A Free Gard", hjemmeside: "https://prov-a-free.example.no",
        content_source: "claim", about_text: CSS_LEAK,
        // owner touched a DIFFERENT field (visit_text), never about_text
        field_provenance: { ...VERIFIED_PROVENANCE, owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00.000Z" } } },
      });

      const dryA = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-a-locked", "prov-a-free"], apply: false },
      });
      assertEq(dryA.status, 200, "a1: dry-run -> 200");
      assertTrue(
        dryA.body.owner_locked.some((o: any) => o.provider_id === "prov-a-locked" && o.field_name === "about_text"),
        "a2 (AC5): the owner-touched-about_text claim row's about_text is reported owner_locked, its own bucket — not silently folded into diff/not_replaced"
      );
      assertTrue(
        !dryA.body.diff.some((d: any) => d.provider_id === "prov-a-locked" && d.field_name === "about_text"),
        "a3 (AC5): the locked field never appears in the diff (would-replace) list"
      );
      assertTrue(
        dryA.body.diff.some((d: any) => d.provider_id === "prov-a-free" && d.field_name === "about_text"),
        "a4 (AC5): the SAME defective content on a row where the owner never touched about_text IS a candidate replacement"
      );
      assertTrue(
        !dryA.body.owner_locked.some((o: any) => o.provider_id === "prov-a-free" && o.field_name === "about_text"),
        "a5 (AC5): prov-a-free's about_text is NOT reported owner_locked (the owner touched visit_text, not this field)"
      );

      const applyA = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-a-locked", "prov-a-free"], apply: true },
      });
      assertEq(applyA.status, 200, "a6: apply -> 200");
      const rowALocked = getProviderRow("prov-a-locked");
      assertEq(rowALocked.about_text, CSS_LEAK, "a7 (AC5): apply mode NEVER writes the owner-locked field — value unchanged");
      const rowAFree = getProviderRow("prov-a-free");
      assertEq(rowAFree.about_text, CLEAN_ABOUT, "a8 (AC5): apply mode DOES write the free field on the sibling row");
      assertTrue(
        applyA.body.owner_locked.some((o: any) => o.provider_id === "prov-a-locked" && o.field_name === "about_text"),
        "a9: apply response's owner_locked[] also reports the locked field (present in BOTH dry-run and apply responses, never silently dropped)"
      );

      // ── (b) AC6: defect -> replace; fine + no-margin -> untouched ────
      hostHtml.set("prov-b-defect.example.no", cleanHtmlFor(CLEAN_ABOUT, CLEAN_VISIT));
      insertProvider({
        id: "prov-b-defect", navn: "Prov B Defect Gard", hjemmeside: "https://prov-b-defect.example.no",
        content_source: null, about_text: CSS_LEAK,
      });
      const DECENT_CURRENT =
        "Vi er en gårdsbutikk som produserer og selger egen sider og honning. Gården ligger i Hardanger kommune. " +
        "Vi tilbyr smaking og omvisning i sesong. Åpningstider: velkommen til å besøke oss, book gjerne på forhånd.";
      hostHtml.set("prov-b-nomargin.example.no", cleanHtmlFor(DECENT_CURRENT, CLEAN_VISIT));
      insertProvider({
        id: "prov-b-nomargin", navn: "Prov B Nomargin Gard", hjemmeside: "https://prov-b-nomargin.example.no",
        content_source: null, about_text: DECENT_CURRENT,
      });

      const dryB = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-b-defect", "prov-b-nomargin"], apply: false },
      });
      const bDefectDiff = dryB.body.diff.find((d: any) => d.provider_id === "prov-b-defect" && d.field_name === "about_text");
      assertTrue(!!bDefectDiff, "b1 (AC6): a row with an objectively-defective current value (CSS leakage) appears in the dry-run diff");
      assertTrue(bDefectDiff.reason.startsWith("defect:"), "b2 (AC6): its reason is tagged defect:<type>");
      assertTrue(
        !dryB.body.diff.some((d: any) => d.provider_id === "prov-b-nomargin"),
        "b3 (AC6): a row with a fine current value and a same-richness candidate is NOT in the diff (no defect, no margin)"
      );
      const bBeforeApply = getProviderRow("prov-b-defect");
      assertEq(bBeforeApply.about_text, CSS_LEAK, "b4: dry-run performed ZERO writes");

      const applyB = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-b-defect", "prov-b-nomargin"], apply: true },
      });
      assertTrue(
        applyB.body.applied.some((a: any) => a.provider_id === "prov-b-defect" && a.field_name === "about_text"),
        "b5 (AC6): apply mode actually replaces the defective row"
      );
      const bAfterApplyDefect = getProviderRow("prov-b-defect");
      assertEq(bAfterApplyDefect.about_text, CLEAN_ABOUT, "b6 (AC6): the defective value is REPLACED by the clean candidate");
      const bAfterApplyNomargin = getProviderRow("prov-b-nomargin");
      assertEq(bAfterApplyNomargin.about_text, DECENT_CURRENT, "b7 (AC6): the fine, no-margin row is STILL untouched after apply");

      // ── (c) AC7: audit row shape + EXISTING rollback endpoint restores ─
      const auditB = getAuditRows("prov-b-defect").find((r: any) => r.field_name === "about_text");
      assertTrue(!!auditB, "c1 (AC7): exactly one gardssalg_content_audit row exists for the replaced field");
      assertEq(getAuditRows("prov-b-defect").filter((r: any) => r.field_name === "about_text").length, 1, "c1b (AC7): exactly ONE such row (not duplicated)");
      assertEq(auditB.old_value, CSS_LEAK, "c2 (AC7): audit old_value is the real prior defective text");
      assertEq(auditB.new_value, CLEAN_ABOUT, "c3 (AC7): audit new_value is the written replacement");
      assertEq(auditB.source_url, "https://prov-b-defect.example.no", "c4 (AC7): audit source_url is the real fetched evidence URL (not an internal marker)");
      assertEq(auditB.changed_by, "system", "c5 (AC7): audit changed_by is 'system', same convention as every other gårdssalg writer");
      assertTrue(typeof auditB.notes === "string" && auditB.notes.includes("gardssalg-content-quality-update"), "c6: audit notes carries this lever's marker (for anti-churn lookups)");

      const rollbackC = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { provider_id: "prov-b-defect", field_name: "about_text", apply: true },
      });
      assertEq(rollbackC.status, 200, "c7 (AC7): the EXISTING, unmodified rollback endpoint accepts the quality-update's audit row");
      const rowAfterRollback = getProviderRow("prov-b-defect");
      assertEq(rowAfterRollback.about_text, CSS_LEAK, "c8 (AC7): rollback restores the exact prior (defective) value — proves this lever's writes are reversible with NO changes to the rollback endpoint");

      // ── (d) AC12/13: Bringebærlandet (ce85458a-shaped) fixture ────────
      const BRINGEBAERLANDET_HOURS =
        "ebook , der legger vi ut alt som skjer. Vinsalget følger Vinmonopolet i Ås sine åpningstider (man, tirs, ons: 10-17 …). Previous Next Seks kilome";
      // Hours-only body (no preceding/following paragraph) — see the shared
      // fetch mock's own doc comment above for why: extractOpeningHours()'s
      // fixed 80-char window needs the match isolated to extract a clean
      // candidate, matching how the ACTUAL Bringebærlandet defect (an 80-ish-
      // char windowed snippet cut at both ends) looks in production.
      hostHtml.set("bringebaerlandet.example.no", `<html><head><meta property="og:description" content="${CLEAN_ABOUT}"></head><body><p>${CLEAN_HOURS}</p></body></html>`);
      insertProvider({
        id: "ce85458a", navn: "Bringebærlandet", hjemmeside: "https://bringebaerlandet.example.no",
        content_source: null, opening_hours_text: BRINGEBAERLANDET_HOURS,
      });

      const dryD = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["ce85458a"], apply: false },
      });
      const dDiff = dryD.body.diff.find((d: any) => d.provider_id === "ce85458a" && d.field_name === "opening_hours_text");
      assertTrue(!!dDiff, "d1 (AC12/13): report-mode flags the Bringebærlandet defect as a diff entry");
      assertEq(dDiff.reason, "defect:ui_chrome_leakage", "d2 (AC12/13): flagged for the 'Previous Next' slider-chrome defect specifically");
      assertEq(dDiff.current_value, BRINGEBAERLANDET_HOURS, "d3: diff carries the real current (defective) value");

      const applyD = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["ce85458a"], apply: true },
      });
      assertTrue(
        applyD.body.applied.some((a: any) => a.provider_id === "ce85458a" && a.field_name === "opening_hours_text"),
        "d4 (AC12/13): apply mode replaces the defect"
      );
      const rowD = getProviderRow("ce85458a");
      assertTrue(
        !!rowD.opening_hours_text && !rowD.opening_hours_text.includes("Previous Next"),
        "d5 (AC12/13): the stored value no longer contains the slider-chrome leakage after apply"
      );

      // ── (d, locked variant) the same defect, but owner-locked ─────────
      hostHtml.set("bringebaerlandet-locked.example.no", `<html><head><meta property="og:description" content="${CLEAN_ABOUT}"></head><body><p>${CLEAN_HOURS}</p></body></html>`);
      insertProvider({
        id: "ce85458a-locked", navn: "Bringebærlandet Locked", hjemmeside: "https://bringebaerlandet-locked.example.no",
        content_source: "claim", opening_hours_text: BRINGEBAERLANDET_HOURS,
        field_provenance: { ...VERIFIED_PROVENANCE, owner_locks: { opening_hours_text: { locked_at: "2026-08-09T00:00:00.000Z" } } },
      });
      const applyDLocked = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["ce85458a-locked"], apply: true },
      });
      assertTrue(
        applyDLocked.body.owner_locked.some((o: any) => o.provider_id === "ce85458a-locked" && o.field_name === "opening_hours_text"),
        "d6 (AC13): the locked variant is correctly reported owner_locked (the ONLY acceptable reason to leave a defective row untouched)"
      );
      const rowDLocked = getProviderRow("ce85458a-locked");
      assertEq(rowDLocked.opening_hours_text, BRINGEBAERLANDET_HOURS, "d7 (AC13): the locked row's defective value is left completely untouched");

      // ── (e) anti-churn (Skive 3-D) ─────────────────────────────────────
      hostHtml.set("prov-e-churn.example.no", cleanHtmlFor(CLEAN_ABOUT, CLEAN_VISIT));
      insertProvider({
        id: "prov-e-churn", navn: "Prov E Churn Gard", hjemmeside: "https://prov-e-churn.example.no",
        content_source: null, about_text: CSS_LEAK,
      });
      const applyE1 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-e-churn"], apply: true },
      });
      assertTrue(
        applyE1.body.applied.some((a: any) => a.provider_id === "prov-e-churn"),
        "e1: first replacement on prov-e-churn succeeds"
      );
      // Same source page, same defect shape re-introduced (simulating a
      // second bad edit) — the SAME hash, within the 30-day window ->
      // anti-churn should block a second replacement.
      const CSS_LEAK_2 = ".card{color:red;padding:5px;} .box{display:block!important;}";
      expDb.prepare(`UPDATE experience_providers SET about_text = ? WHERE id = ?`).run(CSS_LEAK_2, "prov-e-churn");
      const applyE2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-e-churn"], apply: true },
      });
      assertTrue(
        applyE2.body.anti_churn_blocked.some((a: any) => a.provider_id === "prov-e-churn" && a.field_name === "about_text"),
        "e2 (Skive 3-D): a second replacement within 30 days, SAME source content hash, is anti-churn blocked"
      );
      const rowE2 = getProviderRow("prov-e-churn");
      assertEq(rowE2.about_text, CSS_LEAK_2, "e3 (Skive 3-D): the anti-churn-blocked write did not happen — value unchanged");

      // Now the SOURCE PAGE actually changes (different homepage HTML ->
      // different content hash) — anti-churn must NOT block this one.
      const CLEAN_ABOUT_2 = "Vi produserer og selger eplemost og sider fra egen frukthage, og holder åpent gårdsbutikk hver helg.";
      hostHtml.set("prov-e-churn.example.no", cleanHtmlFor(CLEAN_ABOUT_2, CLEAN_VISIT));
      const applyE3 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-e-churn"], apply: true },
      });
      assertTrue(
        applyE3.body.applied.some((a: any) => a.provider_id === "prov-e-churn" && a.field_name === "about_text"),
        "e4 (Skive 3-D): once the source page's content actually changed (different hash), the replacement is allowed again despite being within 30 days"
      );
      const rowE3 = getProviderRow("prov-e-churn");
      assertEq(rowE3.about_text, CLEAN_ABOUT_2, "e5 (Skive 3-D): the row now reflects the freshly-changed-source candidate");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-quality-update: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-quality-update.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgQualityUpdateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
