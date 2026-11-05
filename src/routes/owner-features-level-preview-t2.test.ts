/**
 * owner-features-level-preview-t2.test.ts — eierportal bølge 0, T2: the
 * «Mine valg» level preview (GET …/valg?niva=<level>) never writes.
 *
 * previewOwnerLevel runs the real applyOwnerLevel inside a rolled-back
 * lokal.db transaction over a registry clone whose storage adapters go to an
 * in-memory overlay (changes.ts previewOverlayRegistry). Before T2 the
 * gårdssalg booking.enabled adapter wrote experiences.db
 * (updateClaimedProviderProfile) outside that transaction, so a GET preview
 * switched booking_live on/off and wrote gardssalg_content_audit rows.
 *
 * AC6, on both platforms, for every level × five starting states:
 *   - GET …/valg?niva=<level> answers 200 and leaves every DB unchanged: no
 *     new owner_feature_audit / owner_feature_change_batch /
 *     owner_feature_settings / owner_feature_level_choice row (lokal.db), no
 *     gardssalg_content_audit row and no change to the experience_providers
 *     row (experiences.db) — booking_live / order_notifications_opt_in
 *     untouched — and no e-mail;
 *   - the preview equals the change the confirmed POST …/valg/niva then
 *     performs (changed keys with from → to as written to owner_feature_audit
 *     and the column; skipped keys from the «hoppet» redirect).
 *   - overlay unit checks: reads fall through, writes never reach the real
 *     adapter, a missing subject row answers false like the real writers.
 *
 * Exported runOwnerLevelPreviewT2Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-level-preview-t2.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Assert = { eq(a: unknown, b: unknown, label: string): void; ok(c: boolean, label: string): void };

function makeAssert(log: boolean, sum: TestSummary): Assert {
  const eq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      sum.passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      sum.failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      sum.failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };
  return { eq, ok: (c, label) => eq(!!c, true, label) };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// ── gårdssalg (Opplevagent tab, real HTTP) ─────────────────────────────────

async function gardssalgPart(A: Assert, sum: TestSummary): Promise<void> {
  const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  // Five starting states (one producer each, reset before every level).
  const STATES: Array<{ id: string; slug: string; label: string; booking_live: number; epost: string | null; brake: boolean }> = [
    { id: "t2-off", slug: "t2-av", label: "booking off, request address", booking_live: 0, epost: "post@t2-av.no", brake: false },
    { id: "t2-on", slug: "t2-pa", label: "booking on, request address", booking_live: 1, epost: "post@t2-pa.no", brake: false },
    { id: "t2-noemail", slug: "t2-utenepost", label: "booking off, no request address", booking_live: 0, epost: null, brake: false },
    { id: "t2-brake-on", slug: "t2-brems-pa", label: "booking on, admin brake", booking_live: 1, epost: "post@t2-brems-pa.no", brake: true },
    { id: "t2-brake-off", slug: "t2-brems-av", label: "booking off, admin brake", booking_live: 0, epost: "post@t2-brems-av.no", brake: true },
  ];
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  process.env.OA_OWNER_FEATURES_ENABLED = "true";
  process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = STATES.map((s) => `gardssalg:${s.id}`).join(",");
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
    let sent = 0;
    (emailMod.emailService as any).sendEmail = async () => { sent++; return { success: true, messageId: "test" }; };

    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const R = reg.GARDSSALG_OWNER_FEATURE_REGISTRY;

    const insertProvider = expDb.prepare(`
      INSERT INTO experience_providers
        (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
         producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider,
         booking_admin_brake_at, booking_admin_brake_note, claimed_at)
      VALUES
        (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '["Eplesider"]',
         'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, NULL, NULL, datetime('now'))
    `);
    const claimRow = expDb.prepare(
      `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
       VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
    );
    STATES.forEach((s, i) => {
      insertProvider.run({ id: s.id, navn: `T2 Gård ${i + 1}`, slug: s.slug, org_nr: `91900000${i + 1}`, hjemmeside: `https://${s.slug}.no`, epost: s.epost });
      claimRow.run(`gsc_${s.id}`, s.id, `eier@${s.id}.no`, `tok-${s.id}`);
    });
    const resetState = (s: (typeof STATES)[number]) => {
      expDb.prepare(
        `UPDATE experience_providers SET booking_live = ?, epost = ?, booking_admin_brake_at = ?, booking_admin_brake_note = ?,
                field_provenance = NULL, updated_at = '2026-10-01 00:00:00' WHERE id = ?`,
      ).run(s.booking_live, s.epost, s.brake ? "2026-10-20 10:00:00" : null, s.brake ? "klage fra gjest" : null, s.id);
    };

    // HTTP wiring (same as gardssalg-owner-features-o1a).
    const expressMod = require("express") as typeof import("express");
    const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
    const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
    const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
    const ownerFeaturesRoutes = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
    const app = expressMod();
    app.use("/api/opplevelser", expressMod.json(), opplevelserRouter);
    app.use("/", claimRouter);
    app.use("/", seoRouter);
    const httpMod = require("http") as typeof import("http");
    const server = httpMod.createServer(app);
    servers.push(server);
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
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const page = (slug: string, tail = "") => `/kategori/gardssalg/eier/${slug}/valg${tail}`;

    const count = (db: any, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
    const snapshot = (id: string) => JSON.stringify({
      provider: expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id),
      contentAudit: count(expDb, "gardssalg_content_audit"),
      audit: count(rfbDb, "owner_feature_audit"),
      batch: count(rfbDb, "owner_feature_change_batch"),
      settings: count(rfbDb, "owner_feature_settings"),
      levelChoice: count(rfbDb, "owner_feature_level_choice"),
      sent,
    });
    const bookingLive = (id: string) => Number((expDb.prepare(`SELECT booking_live FROM experience_providers WHERE id = ?`).get(id) as any).booking_live);
    const contentAuditFor = (id: string) => count(expDb, `gardssalg_content_audit WHERE provider_id = '${id}'`);

    // Sanity: the GET preview really goes through the page (a level that changes booking.enabled is listed).
    let anyChange = false;
    for (const s of STATES) {
      for (const level of ch.GARDSSALG_OWNER_LEVELS) {
        const tag = `gardssalg ${s.label} / ${level.key}`;
        resetState(s);
        ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
        const before = snapshot(s.id);
        const liveBefore = bookingLive(s.id);
        const get = await req("GET", page(s.slug, `?niva=${level.key}`), { Cookie: `oa_owner_session=tok-${s.id}` });
        A.eq(get.status, 200, `${tag}: GET ?niva= answers 200`);
        A.eq(bookingLive(s.id), liveBefore, `${tag}: GET leaves booking_live unchanged`);
        A.eq(snapshot(s.id), before, `${tag}: GET writes nothing (provider row, gardssalg_content_audit, owner_feature_audit/change_batch/settings/level_choice, e-mail)`);

        // The preview the page rendered (same function, same state).
        const preview = ch.previewOwnerLevel("gardssalg", s.id, level.key, { registry: R });
        A.eq(snapshot(s.id), before, `${tag}: previewOwnerLevel itself writes nothing`);
        A.ok(preview !== null, `${tag}: a preview for the level`);
        if (!preview) continue;
        for (const c of preview.changes) {
          const label = reg.findOwnerFeature(c.key, R)?.label.no ?? c.key;
          A.ok(get.body.includes(`<strong>${label}</strong>: `), `${tag}: the page lists the previewed change ${c.key}`);
          anyChange = true;
        }
        for (const sk of preview.skipped) {
          const label = reg.findOwnerFeature(sk.key, R)?.label.no ?? sk.key;
          A.ok(get.body.includes(`<strong>${label}</strong> endres ikke`), `${tag}: the page lists the previewed skip ${sk.key}`);
        }

        // The confirmed POST performs exactly the previewed change.
        const auditMax = Number((rfbDb.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit`).get() as any).m);
        const contentBefore = contentAuditFor(s.id);
        const post = await req("POST", page(s.slug, "/niva"), { ...form, Cookie: `oa_owner_session=tok-${s.id}` }, `level=${level.key}&confirmed=1`);
        A.eq(post.status, 303, `${tag}: POST valg/niva answers 303`);
        const written = (rfbDb.prepare(
          `SELECT key, old_json, new_json FROM owner_feature_audit WHERE vertical = 'gardssalg' AND subject_id = ? AND id > ? ORDER BY id`,
        ).all(s.id, auditMax) as any[]).map((r) => ({ key: r.key, from: parseJson(r.old_json), to: parseJson(r.new_json) }));
        A.eq(written, preview.changes, `${tag}: preview changes == what the POST wrote`);
        const target = preview.changes.find((c) => c.key === "booking.enabled");
        A.eq(bookingLive(s.id), target ? (target.to === true ? 1 : 0) : liveBefore, `${tag}: booking_live after the POST == the previewed value`);
        A.eq(contentAuditFor(s.id) - contentBefore, target ? 1 : 0, `${tag}: the POST (not the GET) writes the gardssalg_content_audit row`);
        const loc = String(post.headers.location ?? "");
        const skippedKeys = loc.includes("melding=hoppet")
          ? decodeURIComponent((loc.match(/nokkel=([^#&]*)/) ?? [])[1] ?? "").split(",").filter(Boolean)
          : [];
        A.eq(skippedKeys, preview.changes.length ? [] : preview.skipped.map((x) => x.key), `${tag}: preview skips == what the POST skipped`);
      }
    }
    A.ok(anyChange, "gardssalg: at least one starting state previews a real change (the matrix is not vacuous)");
    ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
  } catch (err: any) {
    sum.failed++;
    sum.failures.push("gardssalg: unexpected error: " + String(err?.stack || err));
  } finally {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
    if (initMod) initMod.__setDbForTesting(prevRfbDb);
    restoreModuleCache();
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try {
      (require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).__resetGardssalgOwnerFeaturesRateLimitForTesting();
    } catch { /* ignore */ }
  }
}

// ── RFB (/eier/:agentId/valg, handlers off the router stack) ────────────────

async function rfbPart(A: Assert, sum: TestSummary, log: boolean): Promise<void> {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = ["OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  let emailMod: typeof import("../services/email-service") | undefined;
  let origSendEmail: unknown;

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  // Five starting states.
  const STATES: Array<{ id: string; label: string; optIn: number; verified: boolean; paused: boolean; adminLockOff: boolean }> = [
    { id: "t2r-off", label: "orders off, verified", optIn: 0, verified: true, paused: false, adminLockOff: false },
    { id: "t2r-on", label: "orders on, verified", optIn: 1, verified: true, paused: false, adminLockOff: false },
    { id: "t2r-unbadged", label: "orders off, no verified badge", optIn: 0, verified: false, paused: false, adminLockOff: false },
    { id: "t2r-paused", label: "orders on, profile paused, no verified badge", optIn: 1, verified: false, paused: true, adminLockOff: false },
    { id: "t2r-locked", label: "orders off, admin lock off", optIn: 0, verified: true, paused: false, adminLockOff: true },
  ];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  if (!log) console.log = () => { /* silence route chatter */ };
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED;
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = STATES.map((s) => `rfb:${s.id}`).join(",");
    for (const m of ["./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const { OWNER_PAUSE_TABLE } = require("../services/agent-visibility") as typeof import("../services/agent-visibility");

    emailMod = require("../services/email-service") as typeof import("../services/email-service");
    origSendEmail = emailMod.emailService.sendEmail;
    let sent = 0;
    (emailMod.emailService as any).sendEmail = async () => { sent++; return { success: true, messageId: "test" }; };

    for (const s of STATES) {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent for T2.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 0)`,
      ).run(s.id, `T2 Gard ${s.id}`, `post@${s.id}.example.no`, `https://${s.id}.example.no`, `key-${s.id}`, s.verified ? 1 : 0);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
      ).run(s.id, `post@${s.id}.example.no`, `https://${s.id}.example.no`);
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${s.id}`, `post@${s.id}.example.no`, `tok-${s.id}`, s.id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    const resetState = (s: (typeof STATES)[number]) => {
      db.prepare(`UPDATE agents SET order_notifications_opt_in = ? WHERE id = ?`).run(s.optIn, s.id);
      db.prepare(`DELETE FROM ${OWNER_PAUSE_TABLE} WHERE agent_id = ?`).run(s.id);
      if (s.paused) {
        db.prepare(`INSERT INTO ${OWNER_PAUSE_TABLE} (agent_id, paused_at, pause_until, set_by) VALUES (?, '2026-10-01T00:00:00.000Z', NULL, 'owner')`).run(s.id);
      }
      db.prepare(`DELETE FROM owner_feature_settings WHERE vertical = 'rfb' AND subject_id = ?`).run(s.id);
      if (s.adminLockOff) {
        db.prepare(
          `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
           VALUES ('rfb', ?, 'orders.enabled', 'false', 'admin', 1, '2026-10-01T00:00:00.000Z')`,
        ).run(s.id);
      }
    };
    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
    };
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
    const optIn = (id: string) => Number((db.prepare(`SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?`).get(id) as any).v);
    const snapshot = (id: string) => JSON.stringify({
      agent: db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id),
      pause: db.prepare(`SELECT * FROM ${OWNER_PAUSE_TABLE} WHERE agent_id = ?`).all(id),
      settings: db.prepare(`SELECT * FROM owner_feature_settings WHERE subject_id = ? ORDER BY key`).all(id),
      audit: count("owner_feature_audit"),
      batch: count("owner_feature_change_batch"),
      levelChoice: count("owner_feature_level_choice"),
      sent,
    });

    let anyChange = false;
    let anySkip = false;
    for (const s of STATES) {
      for (const level of ch.OWNER_LEVELS) {
        const tag = `rfb ${s.label} / ${level.key}`;
        resetState(s);
        featuresMod.__resetOwnerFeaturesRateLimitForTesting();
        const before = snapshot(s.id);
        const optBefore = optIn(s.id);
        const get = await invoke(H.page, makeReq({ params: { agentId: s.id }, query: { niva: level.key }, token: `tok-${s.id}` }));
        A.eq(get.status, 200, `${tag}: GET ?niva= answers 200`);
        A.eq(optIn(s.id), optBefore, `${tag}: GET leaves order_notifications_opt_in unchanged`);
        A.eq(snapshot(s.id), before, `${tag}: GET writes nothing (agent row, pause, owner_feature_audit/change_batch/settings/level_choice, e-mail)`);

        const resolvedBefore = rs.resolveOwnerFeatures("rfb", s.id);
        const preview = ch.previewOwnerLevel("rfb", s.id, level.key);
        A.ok(preview !== null, `${tag}: a preview for the level`);
        if (!preview) continue;
        const html = String(get.body ?? "");
        for (const c of preview.changes) {
          A.ok(html.includes(`<strong>${reg.findOwnerFeature(c.key)?.label.no ?? c.key}</strong>: `), `${tag}: the page lists the previewed change ${c.key}`);
          anyChange = true;
        }
        for (const sk of preview.skipped) {
          A.ok(html.includes(`<strong>${reg.findOwnerFeature(sk.key)?.label.no ?? sk.key}</strong> endres ikke`), `${tag}: the page lists the previewed skip ${sk.key}`);
          anySkip = true;
        }

        const auditMax = Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM owner_feature_audit`).get() as any).m);
        const post = await invoke(H.niva, makeReq({ params: { agentId: s.id }, body: { level: level.key, confirmed: "1" }, token: `tok-${s.id}` }));
        A.eq(post.status, 303, `${tag}: POST valg/niva answers 303`);
        const written = (db.prepare(
          `SELECT key, old_json, new_json FROM owner_feature_audit WHERE vertical = 'rfb' AND subject_id = ? AND id > ? ORDER BY id`,
        ).all(s.id, auditMax) as any[]).map((r) => ({ key: r.key, from: parseJson(r.old_json), to: parseJson(r.new_json) }));
        // `from` in the preview is the resolved (effective) value the page
        // shows; the audit row's old value is the stored column. They differ
        // only when a requirement is unmet (stored on, shown off) — so the
        // keys and target values are compared, and `from` against the
        // resolved value before the POST.
        A.eq(written.map((w) => [w.key, w.to]), preview.changes.map((c) => [c.key, c.to]), `${tag}: preview changes (key → to) == what the POST wrote`);
        A.eq(preview.changes.map((c) => c.from), preview.changes.map((c) => resolvedBefore.byKey[c.key]?.value ?? null), `${tag}: preview from == the resolved value before`);
        const target = preview.changes.find((c) => c.key === "orders.enabled");
        A.eq(optIn(s.id), target ? (target.to === true ? 1 : 0) : optBefore, `${tag}: order_notifications_opt_in after the POST == the previewed value`);
        const loc = String(post.body?.__redirect ?? "");
        const skippedKeys = loc.includes("melding=hoppet")
          ? decodeURIComponent((loc.match(/nokkel=([^#&]*)/) ?? [])[1] ?? "").split(",").filter(Boolean)
          : [];
        A.eq(skippedKeys, preview.changes.length ? [] : preview.skipped.map((x) => x.key), `${tag}: preview skips == what the POST skipped`);
      }
    }
    A.ok(anyChange && anySkip, "rfb: the matrix covers both a previewed change and a previewed skip");

    // ── overlay unit checks (previewOverlayRegistry) ──────────────────────
    const realWrites: unknown[] = [];
    const store = new Map<string, unknown>([["a", false]]);
    const fixture = [{
      ...reg.OWNER_FEATURE_REGISTRY.find((e) => e.key === "orders.enabled")!,
      storage: {
        column: "fixture.col",
        read: (_db: any, id: string) => (store.has(id) ? (store.get(id) as any) : null),
        write: (_db: any, id: string, v: any) => { realWrites.push([id, v]); store.set(id, v); return true; },
      },
    }];
    const clone = ch.previewOverlayRegistry(fixture);
    const ad = clone[0].storage!;
    A.eq([ad.column, ad.read(db, "a")], ["fixture.col", false], "overlay: column kept, read falls through to the real store");
    A.eq(ad.write(db, "a", true), true, "overlay: a write is accepted");
    A.eq([ad.read(db, "a"), store.get("a"), realWrites.length], [true, false, 0], "overlay: the write is visible through the clone only — never forwarded");
    A.eq(ad.write(db, "missing", true), false, "overlay: no subject row → false, like the real writers");
    A.eq(ch.previewOverlayRegistry(fixture)[0].storage!.read(db, "a"), false, "overlay: every clone starts from a fresh overlay");
    A.ok(fixture[0].storage.read(db, "a") === false && clone[0] !== fixture[0], "overlay: the original registry entry is untouched");
    featuresMod.__resetOwnerFeaturesRateLimitForTesting();
  } catch (err: any) {
    sum.failed++;
    sum.failures.push("rfb: unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
    initMod.__setDbForTesting(prevDb);
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
}

export async function runOwnerLevelPreviewT2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const sum: TestSummary = { passed: 0, failed: 0, failures: [] };
  const A = makeAssert(log, sum);
  await gardssalgPart(A, sum);
  await rfbPart(A, sum, log);
  return sum;
}

if (require.main === module) {
  runOwnerLevelPreviewT2Tests({ log: true }).then((r) => {
    console.log(`\nowner-features-level-preview-t2: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
