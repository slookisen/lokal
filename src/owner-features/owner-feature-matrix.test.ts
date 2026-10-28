/**
 * owner-feature-matrix.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S4-2a: the CI test matrix per surface for every `live` owner-feature key.
 *
 * Binding test requirement (Daniel 2026-10-22): «Testmatrise i CI per
 * `live`-nøkkel: for hver flate i `surfaces`: standard → på → av → på igjen,
 * med observert effekt hver gang (data til stede/borte, e-post sendt/ikke
 * sendt, jobb kjører/hopper over).» Plus «uoppfylt krav → 409 og ingen
 * effekt; låste valg kan ikke slås av».
 *
 * OWNER_FEATURE_MATRIX_CASES is the coverage map: one entry per live key ×
 * declared surface. registry-governance-s4.test.ts fails CI when a live
 * entry has a surface without a case here, or when a case names a key or
 * surface the registry does not have. This suite runs every case and fails
 * when a declared case has no runner or a runner does not record all four
 * steps.
 *
 * Every step changes the value through the real owner API
 * (PUT /api/owner/:id/features/:key, handler pulled off the router) and
 * observes the effect through the real code path of the surface:
 *   order_gate                submitCart(): a real order row vs a contact handoff
 *   email:order_notification  submitCart() → sendOrderNotificationForOrder():
 *                             the producer mail captured at the transport seam
 *                             (__setOrderNotifySendForTesting); never real mail
 *   email:order_reminder      processOrderFollowups() (fake clock): reminder
 *                             mail to the producer captured / not
 *   job:order_followups       processOrderFollowups() result (reminders_sent)
 *                             + reminder_sent_at + the admin alert wording
 *   job:knowledge_write       knowledgeService.upsertKnowledge() (non-owner
 *                             write) on an owner-written field: skipped
 *                             owner_locked, value kept
 *   job:rfb_enrichment_nightly loadRfbEnrichmentCohort() — the job's own
 *                             eligibility: an owner profile is never picked
 *   email:outreach            crm.executeCompose() (cold send, stubbed
 *                             transport): List-Unsubscribe offered; after
 *                             POST /avmeld the send is refused and the
 *                             profile still exists
 *   S2e (side v2):
 *   visibility.profile × each of its 12 surfaces (the /eier pause card moved
 *                             into «Mine valg»): the real route / MCP tool /
 *                             feed / sitemap of that surface, with
 *                             OWNER_FEATURES_ENFORCE on and OWNER_PAUSE_ENABLED
 *                             off — the profile present / gone / present
 *   orders.email × email:order_notification  the order-address form from the
 *                             /eier «Bestillinger» card, now POST
 *                             /eier/:id/valg/ordre-epost: before the
 *                             confirmation click the order mail still goes to
 *                             the old address, after it to the new one; a
 *                             direct PUT is refused (409 confirm_by_email)
 * Kinds:
 *   switch     default → on → off → on again; the effect follows each step;
 *              plus an unmet requirement → 409, nothing written, no effect.
 *   locked     the owner's own write is refused (409 locked) at every step,
 *              the effect follows the parent (lockedWhen) through
 *              default → on → off → on again.
 *   guarantee  every write (off and on) is refused (409 guarantee), nothing
 *              stored, the effect stays on at every step.
 *
 * Real router + services on the production schema in an in-memory DB.
 * Exported runOwnerFeatureMatrixTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/owner-feature-matrix.test.ts
 *
 * Import has no side effects (the governance test imports the coverage map).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export type MatrixKind = "switch" | "locked" | "guarantee";

export interface OwnerFeatureMatrixCase {
  key: string;
  surface: string;
  kind: MatrixKind;
  /** How the effect is observed (for the log / review). */
  observe: string;
}

/** The coverage map: one case per live key × declared surface. */
export const OWNER_FEATURE_MATRIX_CASES: readonly OwnerFeatureMatrixCase[] = [
  { key: "orders.enabled", surface: "order_gate", kind: "switch",
    observe: "submitCart(): real order row for the producer vs contact handoff" },
  { key: "orders.enabled", surface: "email:order_notification", kind: "switch",
    observe: "producer order mail captured at the order-notify transport seam vs none" },
  { key: "orders.reminder", surface: "email:order_reminder", kind: "locked",
    observe: "processOrderFollowups(): reminder mail to the producer captured vs none" },
  { key: "orders.reminder", surface: "job:order_followups", kind: "locked",
    observe: "processOrderFollowups(): reminders_sent + admin alert wording" },
  { key: "notify.order_email", surface: "email:order_notification", kind: "locked",
    observe: "producer order mail captured vs none; owner cannot switch it off" },
  { key: "auto.guarantee", surface: "job:rfb_enrichment_nightly", kind: "guarantee",
    observe: "loadRfbEnrichmentCohort(): owner profile excluded (customer), never picked" },
  { key: "auto.guarantee", surface: "job:knowledge_write", kind: "guarantee",
    observe: "upsertKnowledge() non-owner write: owner field skipped owner_locked, value kept" },
  { key: "comms.unsubscribe", surface: "email:outreach", kind: "guarantee",
    observe: "executeCompose() cold send carries List-Unsubscribe; after /avmeld refused, profile kept" },
  // S2e: the pause (visibility.profile) on every declared surface.
  { key: "visibility.profile", surface: "profile_html", kind: "switch",
    observe: "/produsent/:slug: the full profile vs «Midlertidig pause»" },
  { key: "visibility.profile", surface: "json_ld", kind: "switch",
    observe: "/produsent/:slug JSON-LD carries the producer vs not" },
  { key: "visibility.profile", surface: "listing_html", kind: "switch",
    observe: "front-page cards + city-page JSON-LD list the producer vs not" },
  { key: "visibility.profile", surface: "mcp_search", kind: "switch",
    observe: "lokal_search / lokal_discover / lokal_find_offers / REST search + discover list it vs not" },
  { key: "visibility.profile", surface: "mcp_info", kind: "switch",
    observe: "lokal_info + the producer-detail MCP resource answer vs unknown id" },
  { key: "visibility.profile", surface: "rest_card", kind: "switch",
    observe: "/agents/:id/card and /info → 200 vs 404" },
  { key: "visibility.profile", surface: "vcard", kind: "switch",
    observe: "/agents/:id/vcard → a vCard vs none" },
  { key: "visibility.profile", surface: "acp_feed", kind: "switch",
    observe: "catalog /feed items + /acp-feed.csv rows of the producer vs none" },
  { key: "visibility.profile", surface: "sitemap", kind: "switch",
    observe: "sitemap.xml has the profile URL vs not" },
  { key: "visibility.profile", surface: "llms", kind: "switch",
    observe: "llms.txt + llms-full.txt name the producer vs not" },
  { key: "visibility.profile", surface: "a2a", kind: "switch",
    observe: "A2A agent/info + message/send search find it vs not" },
  { key: "visibility.profile", surface: "leaderboard", kind: "switch",
    observe: "/api/leaderboard lists it vs not" },
  // S2e: the order address (orders.email).
  { key: "orders.email", surface: "email:order_notification", kind: "switch",
    observe: "producer order mail recipient: profile e-mail → new address only after the confirmation click → back → new" },
];

export const MATRIX_STEPS = ["default", "on", "off", "on_again"] as const;
export type MatrixStep = (typeof MATRIX_STEPS)[number];

export const matrixCaseId = (c: { key: string; surface: string }): string => `${c.key} × ${c.surface}`;

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ADMIN_MAIL = "matrise-admin@example.test";
const SAVED_ENV = [
  ALLOW_ENV, "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "ORDER_BUYER_RECEIPTS_ENABLED",
  "ORDER_REMINDER_HOURS", "ORDER_AUTOCANCEL_HOURS", "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY",
  "PAYMENTS_ENABLED", "ORDER_NOTIFY_EMAIL_VERSION", "OWNER_LOCK_ENFORCE_WRITES", "OUTREACH_UNSUBSCRIBE_ENABLED",
  "OUTREACH_PAUSED", "ORDER_AUTOCOMPLETE_ENABLED", "RFB_DISABLE_ORDER_FOLLOWUPS",
  "OWNER_FEATURES_ENFORCE", "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED", "LANG_COOKIE_REDIRECT_ENABLED",
];

/** S2e: the visibility.profile producer — the same rich profile shape as owner-features-s2c2.test.ts. */
const VIS_NAME = "Pausematrise Gard Eier";

export async function runOwnerFeatureMatrixTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  // Captured producer / admin mail (order-notify seam) and cold sends (compose seam).
  const sent: Array<{ to: string; subject: string; textContent: string }> = [];
  let cartSvc: typeof import("../services/cart-service") | null = null;
  let notifySvc: typeof import("../services/order-notify-service") | null = null;
  let followSvc: typeof import("../services/order-followups") | null = null;
  let receiptSvc: typeof import("../services/order-receipt-service") | null = null;
  let trustSvc: typeof import("../services/trust-event-service") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    for (const m of ["../routes/owner-portal", "../routes/owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");
    const reg = require("./registry") as typeof import("./registry");
    const rs = require("./resolve") as typeof import("./resolve");
    cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    followSvc = require("../services/order-followups") as typeof import("../services/order-followups");
    receiptSvc = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
    trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const nightly = require("../services/rfb-enrichment-nightly") as typeof import("../services/rfb-enrichment-nightly");
    const crm = require("../routes/crm") as typeof import("../routes/crm");
    const av = require("../services/avmeld-service") as typeof import("../services/avmeld-service");
    const avRouter = require("../routes/avmeld").default as any;

    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    followSvc.__setOrderFollowupsTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject, textContent: o.textContent || "" });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));

    for (const k of SAVED_ENV) delete process.env[k];
    process.env.ADMIN_KEY = "owner-feature-matrix-secret";
    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_MAIL;
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
    process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";

    // ── Fixtures ───────────────────────────────────────────────────────────
    const emailOf = (id: string) => `post@${id}.example.no`;
    const seedProducer = (id: string, o: { claimed: boolean; isVerified: boolean }) => {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent for valgmatrisen.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?, 0)`,
      ).run(id, `Matrise Gard ${id}`, emailOf(id), `https://${id}.example.no`, `key-${id}`, o.isVerified ? 1 : 0,
        o.claimed ? "2026-10-01T00:00:00.000Z" : null);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line, url_last_status, url_last_probed)
         VALUES (?, ?, ?, 'Liten familiegård med grønnsaker og poteter fra egen jord.', 'verified', 0, 200, datetime('now'))`,
      ).run(id, emailOf(id), `https://${id}.example.no`);
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
         VALUES (?, ?, 'Poteter', 'poteter', 30, 'kg', 'in_stock', 'vegetables', NULL, 'admin_producer_confirmed')`,
      ).run(`p-${id}`, id);
      const token = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, emailOf(id), token, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      return token;
    };
    const ids = {
      gate: "mx-gate", mail: "mx-mail", unbadged: "mx-unbadged", reminderMail: "mx-rem-mail", reminderJob: "mx-rem-job",
      notifyLocked: "mx-notify", nightly: "mx-nightly", nightlyControl: "mx-nightly-ctl", knowledge: "mx-knowledge", outreach: "mx-outreach",
      orderEmail: "mx-order-email",
    };
    const tokens: Record<string, string> = {};
    for (const id of Object.values(ids)) {
      tokens[id] = seedProducer(id, {
        claimed: id !== ids.nightlyControl,
        isVerified: id !== ids.unbadged && id !== ids.nightlyControl,
      });
    }
    // S2e: the pause producer (rich profile so every list surface shows it today;
    // its own city, so llms.txt's 1–2 samples per city include it).
    const VIS_ID = "mx-vis-pause";
    {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
         VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 60.7945, 11.0680, 'Hamar', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
      ).run(VIS_ID, VIS_NAME, "Lokal produsent av poteter og grønnsaker i Hamar-området, med gårdsutsalg hver lørdag.",
        emailOf(VIS_ID), `https://${VIS_ID}.example.no`, `key-${VIS_ID}`);
      db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, email, website, phone, address, postal_code, about, products, verification_status, verified_second_line,
            enrichment_status, url_last_status, url_last_probed, last_verified_at)
         VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '0150', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
      ).run(VIS_ID, emailOf(VIS_ID), `https://${VIS_ID}.example.no`,
        "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
        JSON.stringify([{ name: "Listepoteter", price: "30 kr/kg", category: "vegetables" }]));
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url)
         VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg')`,
      ).run(`prod-${VIS_ID}`, VIS_ID);
      db.prepare(`INSERT OR REPLACE INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen) VALUES (?, 10, 5, 3)`).run(VIS_ID);
      tokens[VIS_ID] = `tok-${VIS_ID}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${VIS_ID}`, emailOf(VIS_ID), tokens[VIS_ID], VIS_ID, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    process.env[ALLOW_ENV] = [...Object.values(ids), VIS_ID].map((id) => `rfb:${id}`).join(",");

    const H = { put: findRouteHandler(featuresMod.default, "/api/owner/:id/features/:key", "put") };
    const put = (id: string, key: string, value: unknown) =>
      invoke(H.put, makeReq({ params: { id, key }, body: { value }, token: tokens[id] }));
    const optInCol = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as { v: number }).v;
    const settingsRows = (id: string, key: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ? AND key = ?").get(id, key) as { n: number }).n;
    const auditRows = (id: string, key: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ? AND key = ?").get(id, key) as { n: number }).n;
    const resolved = (id: string, key: string) => rs.resolveOwnerFeature("rfb", id, key as any, { db });
    const settle = () => new Promise((r) => setTimeout(r, 40));
    let buyerN = 0;
    /** One real cart with the producer's product, submitted with consented buyer contact. */
    const submitFor = async (agentId: string) => {
      const c = cartSvc!.createCart();
      const add = cartSvc!.addCartItem(c.cart_id, `p-${agentId}`, 1);
      if (!add.success) throw new Error(`setup: addCartItem for ${agentId} failed: ${(add as any).error}`);
      const r = cartSvc!.submitCart(c.cart_id, { buyer_name: "Kari Kjøper", buyer_email: `kjoper${++buyerN}@example.com`, contact_consent: true });
      await settle();
      if (!r.success) throw new Error(`setup: submitCart for ${agentId} failed: ${(r as any).error}`);
      const orders = (r.orders || []).filter((o: any) => o.agent_id === agentId);
      const handoffs = (r.contact_handoffs || []).filter((h: any) => h.agent_id === agentId);
      return { orderIds: orders.map((o: any) => o.order_id as string), handoffs: handoffs.length };
    };
    const producerMails = (agentId: string) => sent.filter((m) => m.to === emailOf(agentId));
    /** Producer mails caused by fn (one real submit / job run). */
    const mailsDuring = async (agentId: string, fn: () => Promise<unknown>) => {
      const before = producerMails(agentId).length;
      const out = await fn();
      return { mails: producerMails(agentId).slice(before), out };
    };

    // Step recorder: every case must record all four steps, in order.
    const recorded = new Map<string, MatrixStep[]>();
    const step = (c: OwnerFeatureMatrixCase, s: MatrixStep) => {
      const list = recorded.get(matrixCaseId(c)) ?? [];
      list.push(s);
      recorded.set(matrixCaseId(c), list);
    };

    /** A guarantee / locked write must be refused with `block` and change nothing. */
    const refused = async (id: string, key: string, value: unknown, block: string, label: string) => {
      const a0 = auditRows(id, key);
      const r = await put(id, key, value);
      assertEq([r.status, r.body?.error], [409, block], `${label}: PUT ${key}=${JSON.stringify(value)} → 409 ${block}`);
      assertTrue(typeof r.body?.reason === "string" && r.body.reason.length > 0, `${label}: refusal carries a Norwegian reason`);
      assertEq([settingsRows(id, key), auditRows(id, key) - a0], [0, 0], `${label}: refused write stores nothing (no setting, no audit)`);
    };
    const switchTo = async (id: string, key: string, value: boolean, label: string) => {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      const r = await put(id, key, value);
      assertEq([r.status, r.body?.feature?.value], [200, value], `${label}: PUT ${key}=${value} → 200`);
    };

    // T0 for the follow-ups fake clock (orders created «now» are younger than T0).
    const T0 = new Date("2026-03-10T08:00:00Z");
    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const ageToT0 = (orderId: string) =>
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL(T0), SQL(T0), orderId);
    const at25h = new Date(T0.getTime() + 25 * 3600_000);

    // ── S2e: probes for the visibility.profile surfaces ─────────────────
    // The same endpoints, per registry surface, as owner-features-s2c2.test.ts
    // (PRESENCE): a probe returns markers of THIS producer being there.
    type VisProbe = (id: string) => Promise<boolean[]>;
    let visKit: { probes: Record<string, Record<string, VisProbe>>; clear: () => void } | null = null;
    const getVisKit = () => {
      if (visKit) return visKit;
      const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
      for (const m of ["../routes/marketplace", "../routes/marketplace-catalog", "../routes/seo", "../routes/mcp", "../routes/a2a", "../routes/discovery"]) {
        try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
      }
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      const marketplaceRouter = require("../routes/marketplace").default as any;
      const { catalogRouter } = require("../routes/marketplace-catalog") as typeof import("../routes/marketplace-catalog");
      const seoMod = require("../routes/seo") as typeof import("../routes/seo");
      const a2aRouter = require("../routes/a2a").default as any;
      const discoveryRouter = require("../routes/discovery").default as any;
      const tools = new Map<string, (args: any) => Promise<any>>();
      const resources = new Map<string, (uri: URL) => Promise<any>>();
      const { registerTools } = require("../routes/mcp") as typeof import("../routes/mcp");
      registerTools({
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource(name: string, _uri: any, _meta: any, handler: any) { resources.set(name, handler); },
        prompt() { /* no-op */ },
        registerResource() { /* no-op */ },
        registerPrompt() { /* no-op */ },
      } as any, () => "test-client", () => undefined);
      const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");
      const visReq = (o: { params?: Record<string, string>; query?: Record<string, string>; body?: any }): any => ({
        method: "GET", url: "/", path: "/", originalUrl: "/",
        params: o.params || {}, body: o.body, query: o.query || {}, headers: {}, cookies: {},
        ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
        get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
      });
      const VH = {
        search: findRouteHandler(marketplaceRouter, "/search", "get"),
        card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
        vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
        info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
        discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
        feed: findRouteHandler(catalogRouter, "/feed", "get"),
        acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
        produsent: findRouteHandler(seoRouterOf(seoMod), "/produsent/:slug", "get"),
        home: findRouteHandler(seoRouterOf(seoMod), "/", "get"),
        city: findRouteHandler(seoRouterOf(seoMod), "/:city", "get"),
        a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
        leaderboard: findRouteHandler(a2aRouter, "/api/leaderboard", "get"),
        llms: findRouteHandler(discoveryRouter, "/llms.txt", "get"),
        llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      };
      const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
      const slug = slugify(VIS_NAME);
      const page = async () => String((await invoke(VH.produsent, visReq({ params: { slug } }))).body ?? "");
      const jsonLdOf = (html: string) => [...html.matchAll(LD_RE)].map((m) => m[1]).join("\n");
      const isProfilePage = (html: string) => html.includes(VIS_NAME) && html.includes("familiegård") && !html.includes("Midlertidig pause");
      const listBlock = (text: string) => text.split("\n\n").find((b) => b.includes(`. ${VIS_NAME}`)) ?? "";
      const cityNode = async () => {
        const html = String((await invoke(VH.city, visReq({ params: { city: "hamar" } }))).body ?? "");
        const found: any[] = [];
        const walk = (x: any) => {
          if (Array.isArray(x)) x.forEach(walk);
          else if (x && typeof x === "object") {
            if (x["@type"] === "LocalBusiness" && x.name === VIS_NAME) found.push(x);
            Object.values(x).forEach(walk);
          }
        };
        for (const m of html.matchAll(LD_RE)) { try { walk(JSON.parse(m[1])); } catch { /* not JSON */ } }
        return found[0];
      };
      const findOffer = async (id: string) => {
        const t = await toolText("lokal_find_offers", { items: ["listepoteter"], lat: 60.7945, lng: 11.0680 });
        let parsed: any;
        try { parsed = JSON.parse(t); } catch { return undefined; }
        const offers = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((x: any) => x?.offers ?? []);
        return offers.find((o: any) => o?.producer?.agent_id === id);
      };
      const a2aCall = (body: any) => invoke(VH.a2a, visReq({ body: { jsonrpc: "2.0", id: 1, ...body } }));
      const probes: Record<string, Record<string, VisProbe>> = {
        profile_html: { produsent: async () => [isProfilePage(await page())] },
        json_ld: { produsent: async () => [jsonLdOf(await page()).includes(`"name":"${VIS_NAME}"`)] },
        listing_html: {
          home_cards: async () => [String((await invoke(VH.home, visReq({}))).body ?? "").includes(`href="/produsent/${slug}"`)],
          city_jsonld: async () => [!!(await cityNode())],
        },
        mcp_search: {
          lokal_search_detail: async () => [(await toolText("lokal_search", { query: VIS_NAME })).includes(`**1. ${VIS_NAME}**`)],
          lokal_search_compact: async () => [listBlock(await toolText("lokal_search", { query: "listepoteter" })) !== ""],
          lokal_discover: async () => [listBlock(await toolText("lokal_discover", { categories: ["vegetables"] })) !== ""],
          rest_search: async (id) => [((await invoke(VH.search, visReq({ query: { q: VIS_NAME, heleNorge: "true" } }))).body?.results ?? []).some((r: any) => r.agent?.id === id)],
          rest_discover: async (id) => [((await invoke(VH.discover, visReq({ body: { categories: ["vegetables"] } }))).body?.results ?? []).some((r: any) => r.agent?.id === id)],
          lokal_find_offers: async (id) => [!!(await findOffer(id))],
        },
        mcp_info: {
          lokal_info: async (id) => [(await toolText("lokal_info", { agentId: id })).includes(`# ${VIS_NAME}`)],
          mcp_resource: async (id) => {
            const r = await resources.get("producer-detail")!(new URL(`lokal://producers/${id}`));
            let j: any; try { j = JSON.parse(String(r?.contents?.[0]?.text ?? "")); } catch { j = undefined; }
            return [j?.agent?.id === id];
          },
        },
        rest_card: {
          card: async (id) => [(await invoke(VH.card, visReq({ params: { id } }))).status === 200],
          info: async (id) => [(await invoke(VH.info, visReq({ params: { id } }))).status === 200],
        },
        vcard: { vcard: async (id) => [String((await invoke(VH.vcard, visReq({ params: { id } }))).body ?? "").includes("BEGIN:VCARD")] },
        acp_feed: {
          feed: async (id) => [((await invoke(VH.feed, visReq({}))).body?.items ?? []).some((i: any) => i.seller?.agent_id === id)],
          acp_csv: async (id) => [String((await invoke(VH.acp, visReq({}))).body ?? "").includes(`prod-${id}`)],
        },
        sitemap: { sitemap_xml: async () => [seoMod.buildSitemapXml().includes(`/produsent/${slug}</loc>`)] },
        llms: {
          llms_txt: async () => [String((await invoke(VH.llms, visReq({}))).body ?? "").includes(slug)],
          llms_full: async () => [String((await invoke(VH.llmsFull, visReq({}))).body ?? "").includes(VIS_NAME)],
        },
        a2a: {
          agent_info: async (id) => [!!(await a2aCall({ method: "agent/info", params: { agentId: id } })).body?.result],
          a2a_search: async (id) => [JSON.stringify((await a2aCall({ method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: VIS_NAME }] } } })).body ?? "").includes(id)],
        },
        leaderboard: { api_leaderboard: async (id) => [((await invoke(VH.leaderboard, visReq({}))).body?.data ?? []).some((r: any) => r.agentId === id)] },
      };
      const clear = () => {
        marketplaceRegistry._agentsCache = null;
        marketplaceRegistry._statsCache = null;
        marketplaceRegistry._agentsCacheTime = 0;
        marketplaceRegistry._statsCacheTime = 0;
        seoMod.__resetSitemapCacheForTesting();
      };
      visKit = { probes, clear };
      return visKit;
    };
    function seoRouterOf(seoMod: any): any { return seoMod.default; }

    /** visibility.profile × surface: default → on → off → on again through PUT, the profile present / gone / present. */
    const visibilityProfileRunner = async (c: OwnerFeatureMatrixCase) => {
      const kit = getVisKit();
      const L = matrixCaseId(c);
      const eps = kit.probes[c.surface];
      assertTrue(!!eps && Object.keys(eps).length > 0, `${L}: the surface has probes`);
      if (!eps) return;
      process.env.OWNER_FEATURES_ENFORCE = "1";
      try {
        const expect = async (shown: boolean, s: MatrixStep) => {
          for (const [ep, probe] of Object.entries(eps)) {
            kit.clear();
            const m = await probe(VIS_ID);
            const state = m.every(Boolean) ? "shown" : m.some(Boolean) ? "mixed" : "absent";
            assertEq(state, shown ? "shown" : "absent", `${L} [${s}]: ${ep} → ${shown ? "the producer is there" : "the producer is gone"}`);
          }
          const f = resolved(VIS_ID, c.key);
          assertEq([f.value, f.changeable], [shown, true], `${L} [${s}]: resolved ${shown}, changeable`);
          const pauseRow = !!db.prepare("SELECT 1 FROM owner_profile_pause WHERE agent_id = ?").get(VIS_ID);
          assertEq(pauseRow, !shown, `${L} [${s}]: owner_profile_pause row ${shown ? "absent" : "present"} (one truth with the old pause card)`);
        };
        await expect(true, "default"); step(c, "default");
        await switchTo(VIS_ID, c.key, true, `${L} [on]`);
        await expect(true, "on"); step(c, "on");
        await switchTo(VIS_ID, c.key, false, `${L} [off]`);
        await expect(false, "off"); step(c, "off");
        await switchTo(VIS_ID, c.key, true, `${L} [on_again]`);
        await expect(true, "on_again"); step(c, "on_again");
      } finally {
        delete process.env.OWNER_FEATURES_ENFORCE;
        db.prepare("DELETE FROM owner_profile_pause WHERE agent_id = ?").run(VIS_ID);
        kit.clear();
      }
    };

    // ── Case runners ───────────────────────────────────────────────────────
    type Runner = (c: OwnerFeatureMatrixCase) => Promise<void>;
    const runners: Record<string, Runner> = {
      // ── orders.enabled (switch) ──────────────────────────────────────────
      "orders.enabled × order_gate": async (c) => {
        const id = ids.gate;
        const L = matrixCaseId(c);
        const expectGate = async (open: boolean, s: MatrixStep) => {
          const r = await submitFor(id);
          assertEq([r.orderIds.length, r.handoffs], open ? [1, 0] : [0, 1],
            `${L} [${s}]: submit → ${open ? "a real order row, no handoff" : "contact handoff, no order row"}`);
          assertEq(cartSvc!.isEligibleForRealOrder(id), open, `${L} [${s}]: isEligibleForRealOrder = ${open}`);
          assertEq(resolved(id, c.key).value, open, `${L} [${s}]: resolved value = ${open}`);
        };
        assertEq([optInCol(id), resolved(id, c.key).source], [0, "default"], `${L} [default]: column 0, source default`);
        await expectGate(false, "default"); step(c, "default");
        await switchTo(id, c.key, true, `${L} [on]`);
        await expectGate(true, "on"); step(c, "on");
        await switchTo(id, c.key, false, `${L} [off]`);
        await expectGate(false, "off"); step(c, "off");
        await switchTo(id, c.key, true, `${L} [on_again]`);
        await expectGate(true, "on_again"); step(c, "on_again");

        // Unmet requirement (claimed owner, no is_verified badge): 409, nothing written, gate stays shut.
        const u = ids.unbadged;
        const before = await submitFor(u);
        assertEq([before.orderIds.length, before.handoffs], [0, 1], `${L} [requires]: unbadged producer → handoff before the attempt`);
        featuresMod.__resetOwnerFeaturesRateLimitForTesting();
        const r = await put(u, c.key, true);
        assertEq([r.status, r.body?.error], [409, "requirement_not_met"], `${L} [requires]: PUT on without is_verified → 409 requirement_not_met`);
        assertEq([optInCol(u), auditRows(u, c.key), settingsRows(u, c.key)], [0, 0, 0], `${L} [requires]: nothing written (column, audit, settings)`);
        const { mails, out } = await mailsDuring(u, () => submitFor(u));
        const after = out as { orderIds: string[]; handoffs: number };
        assertEq([after.orderIds.length, after.handoffs, mails.length], [0, 1, 0], `${L} [requires]: no effect — still a handoff, no order, no mail`);
      },
      "orders.enabled × email:order_notification": async (c) => {
        const id = ids.mail;
        const L = matrixCaseId(c);
        const expectMail = async (on: boolean, s: MatrixStep) => {
          const { mails, out } = await mailsDuring(id, () => submitFor(id));
          const r = out as { orderIds: string[] };
          assertEq(mails.length, on ? 1 : 0, `${L} [${s}]: producer order mail ${on ? "sent (1)" : "not sent"}`);
          if (on) assertTrue(mails[0]!.textContent.includes("/produsent/ordre/"), `${L} [${s}]: the mail carries the order link`);
          return r.orderIds;
        };
        await expectMail(false, "default"); step(c, "default");
        await switchTo(id, c.key, true, `${L} [on]`);
        const onOrders = await expectMail(true, "on"); step(c, "on");
        await switchTo(id, c.key, false, `${L} [off]`);
        await expectMail(false, "off");
        // The send path's own gate: an order received while on, re-sent after off → skipped, no mail.
        const input = cartSvc!.buildOrderNotificationInput(onOrders[0]!);
        const { mails: resend, out: outcome } = await mailsDuring(id, () => notifySvc!.sendOrderNotificationForOrder(input!, { retry: true }));
        assertEq([outcome, resend.length], ["skipped", 0], `${L} [off]: sendOrderNotificationForOrder for an earlier order → skipped, no mail`);
        step(c, "off");
        await switchTo(id, c.key, true, `${L} [on_again]`);
        await expectMail(true, "on_again"); step(c, "on_again");
      },

      // ── locked keys: effect follows orders.enabled, own writes refused ────
      "notify.order_email × email:order_notification": async (c) => {
        const id = ids.notifyLocked;
        const L = matrixCaseId(c);
        const expect = async (on: boolean, s: MatrixStep) => {
          const f = resolved(id, c.key);
          assertEq([f.value, f.source, f.changeable], [on, "locked", false], `${L} [${s}]: resolved ${on}, locked, not changeable`);
          await refused(id, c.key, !on, "locked", `${L} [${s}]`);
          await refused(id, c.key, on, "locked", `${L} [${s}]`);
          const { mails } = await mailsDuring(id, () => submitFor(id));
          assertEq(mails.length, on ? 1 : 0, `${L} [${s}]: producer order mail ${on ? "sent — the owner could not switch it off" : "not sent"}`);
        };
        await expect(false, "default"); step(c, "default");
        await switchTo(id, "orders.enabled", true, `${L} [on] parent`);
        await expect(true, "on"); step(c, "on");
        await switchTo(id, "orders.enabled", false, `${L} [off] parent`);
        await expect(false, "off"); step(c, "off");
        await switchTo(id, "orders.enabled", true, `${L} [on_again] parent`);
        await expect(true, "on_again"); step(c, "on_again");
      },
      "orders.reminder × email:order_reminder": async (c) => {
        const id = ids.reminderMail;
        const L = matrixCaseId(c);
        const lockedState = async (on: boolean, s: MatrixStep) => {
          const f = resolved(id, c.key);
          assertEq([f.value, f.source], [on, "locked"], `${L} [${s}]: resolved ${on}, locked`);
          await refused(id, c.key, false, "locked", `${L} [${s}]`);
        };
        const runJob = async (orderId: string, on: boolean, s: MatrixStep) => {
          ageToT0(orderId);
          const { mails } = await mailsDuring(id, () => followSvc!.processOrderFollowups({ now: at25h }));
          const reminders = mails.filter((m) => /Påminnelse/.test(m.subject));
          assertEq(reminders.length, on ? 1 : 0, `${L} [${s}]: reminder mail to the producer ${on ? "sent (1)" : "not sent"}`);
          if (on) assertTrue(reminders[0]!.textContent.includes("/produsent/ordre/"), `${L} [${s}]: reminder carries the order link`);
        };
        // default: never switched on. An order this producer received earlier
        // (seeded: no order can reach a producer whose orders are off) gets no reminder.
        await lockedState(false, "default");
        db.prepare(
          `INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at, notify_sent_at)
           VALUES ('mx-legacy-order', NULL, ?, 'mx-ref', 'pending', 'pickup', 30, 'mx-legacy-token', datetime('now'), datetime('now'), datetime('now'))`,
        ).run(id);
        await runJob("mx-legacy-order", false, "default"); step(c, "default");
        await switchTo(id, "orders.enabled", true, `${L} [on] parent`);
        await lockedState(true, "on");
        const o1 = (await submitFor(id)).orderIds[0]!;
        await runJob(o1, true, "on"); step(c, "on");
        const o2 = (await submitFor(id)).orderIds[0]!; // received while on …
        await switchTo(id, "orders.enabled", false, `${L} [off] parent`); // … then orders off
        await lockedState(false, "off");
        await runJob(o2, false, "off"); step(c, "off");
        await switchTo(id, "orders.enabled", true, `${L} [on_again] parent`);
        await lockedState(true, "on_again");
        const o3 = (await submitFor(id)).orderIds[0]!;
        await runJob(o3, true, "on_again"); step(c, "on_again");
      },
      "orders.reminder × job:order_followups": async (c) => {
        const id = ids.reminderJob;
        const L = matrixCaseId(c);
        const alertsFor = (orderId: string) => sent.filter((m) => m.to === ADMIN_MAIL && m.subject.includes(orderId.slice(0, 8)) && /ubesvart/.test(m.subject));
        const runJob = async (orderId: string, on: boolean, s: MatrixStep) => {
          ageToT0(orderId);
          const res = await followSvc!.processOrderFollowups({ now: at25h });
          assertEq(res.reminders_sent, on ? 1 : 0, `${L} [${s}]: job reminders_sent = ${on ? 1 : 0} (${on ? "runs the reminder" : "skips it"})`);
          const row = db.prepare("SELECT status, reminder_sent_at FROM orders WHERE id = ?").get(orderId) as any;
          assertTrue(row.status === "pending" && !!row.reminder_sent_at, `${L} [${s}]: order claimed once by the job (reminder_sent_at), still pending`);
          const alerts = alertsFor(orderId);
          assertTrue(alerts.length === 1 && (on ? /har fått én påminnelse/ : /ikke lenger kan motta/).test(alerts[0]!.textContent),
            `${L} [${s}]: admin alert says the reminder was ${on ? "sent" : "skipped (orders off)"}`);
          assertEq(resolved(id, c.key).value, on, `${L} [${s}]: resolved orders.reminder = ${on}`);
          await refused(id, c.key, !on, "locked", `${L} [${s}]`);
        };
        db.prepare(
          `INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at, notify_sent_at)
           VALUES ('mxjoblg-order', NULL, ?, 'mx-ref2', 'pending', 'pickup', 30, 'mx-legacy-token2', datetime('now'), datetime('now'), datetime('now'))`,
        ).run(id);
        await runJob("mxjoblg-order", false, "default"); step(c, "default");
        await switchTo(id, "orders.enabled", true, `${L} [on] parent`);
        await runJob((await submitFor(id)).orderIds[0]!, true, "on"); step(c, "on");
        const o2 = (await submitFor(id)).orderIds[0]!;
        await switchTo(id, "orders.enabled", false, `${L} [off] parent`);
        await runJob(o2, false, "off"); step(c, "off");
        await switchTo(id, "orders.enabled", true, `${L} [on_again] parent`);
        await runJob((await submitFor(id)).orderIds[0]!, true, "on_again"); step(c, "on_again");
      },

      // ── guarantees: every write refused, effect always on ────────────────
      "auto.guarantee × job:rfb_enrichment_nightly": async (c) => {
        const id = ids.nightly;
        const L = matrixCaseId(c);
        const expect = async (s: MatrixStep) => {
          const cohort = await nightly.loadRfbEnrichmentCohort(db as any);
          const picked = cohort.rows.map((r) => r.id);
          assertTrue(!picked.includes(id), `${L} [${s}]: owner profile is not in the nightly cohort (never picked)`);
          assertTrue(cohort.excluded.customer >= 1, `${L} [${s}]: excluded as customer`);
          assertTrue(picked.includes(ids.nightlyControl), `${L} [${s}]: control — an unclaimed twin IS picked (the observation discriminates)`);
          const f = resolved(id, c.key);
          assertEq([f.value, f.source, f.block], [true, "locked", "guarantee"], `${L} [${s}]: guarantee resolves on, locked`);
        };
        await expect("default"); step(c, "default");
        await refused(id, c.key, true, "guarantee", `${L} [on]`);
        await expect("on"); step(c, "on");
        await refused(id, c.key, false, "guarantee", `${L} [off]`);
        await expect("off"); step(c, "off");
        await refused(id, c.key, true, "guarantee", `${L} [on_again]`);
        await expect("on_again"); step(c, "on_again");
      },
      "auto.guarantee × job:knowledge_write": async (c) => {
        const id = ids.knowledge;
        const L = matrixCaseId(c);
        const OWNER_ABOUT = "Dette skrev eieren selv om gården, og det skal stå.";
        // The owner writes the field through the owner path (stamps nothing by itself) + the
        // owner portal's lock stamp curated_fields.about.by = "owner".
        knowledgeService.ownerUpdate(id, { about: OWNER_ABOUT });
        db.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?")
          .run(JSON.stringify({ about: { by: "owner", locked_at: "2026-10-27T10:00:00.000Z" } }), id);
        process.env.OWNER_LOCK_ENFORCE_WRITES = "1";
        const about = () => (db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get(id) as any).about;
        let n = 0;
        const expect = (s: MatrixStep) => {
          const r = knowledgeService.upsertKnowledge(id, { about: `Berikelse prøver å overskrive (${++n}).`, dataSource: "auto" });
          assertEq(r.skipped, [{ field: "about", reason: "owner_locked" }], `${L} [${s}]: non-owner write of the owner field → skipped owner_locked`);
          assertEq(about(), OWNER_ABOUT, `${L} [${s}]: the owner's text is kept`);
          const f = resolved(id, c.key);
          assertEq([f.value, f.block], [true, "guarantee"], `${L} [${s}]: guarantee resolves on`);
        };
        try {
          expect("default"); step(c, "default");
          await refused(id, c.key, true, "guarantee", `${L} [on]`);
          expect("on"); step(c, "on");
          await refused(id, c.key, false, "guarantee", `${L} [off]`);
          expect("off"); step(c, "off");
          await refused(id, c.key, true, "guarantee", `${L} [on_again]`);
          expect("on_again"); step(c, "on_again");
        } finally {
          delete process.env.OWNER_LOCK_ENFORCE_WRITES;
        }
      },
      "comms.unsubscribe × email:outreach": async (c) => {
        const id = ids.outreach;
        const L = matrixCaseId(c);
        const to = emailOf(id);
        process.env.OUTREACH_UNSUBSCRIBE_ENABLED = "1";
        const coldSends: any[] = [];
        const sendRaw = async (o: any) => { coldSends.push(o); return { success: true, messageId: "<mx@test>" }; };
        const compose = () =>
          Promise.resolve(crm.executeCompose(
            { to, subject: "Hei fra Rett fra Bonden", bodyText: "Kort hilsen.\nMvh", intent: "resend_send", category: "marketing", createdBy: "claude", vertical: "rfb" },
            { sendRaw },
          ) as any);
        const profileExists = () => !!db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id);
        // Each step is a fresh cold first-touch: clear the send bookkeeping the
        // 24 h duplicate guard, max-touch-vern and the daily cap read (isolation
        // between steps; the guards themselves are not under test here).
        const clearSendLog = () => {
          for (const t of ["outreach_sent_log", "crm_messages", "crm_threads", "outreach_daily_send_cap"]) {
            try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table not in schema */ }
          }
        };
        const expectOffered = async (s: MatrixStep) => {
          clearSendLog();
          const before = coldSends.length;
          const r = await compose();
          assertEq([r.httpStatus, coldSends.length - before], [200, 1], `${L} [${s}]: cold send goes out`);
          const m = String(coldSends[coldSends.length - 1]?.listUnsubscribe || "").match(/^<https:\/\/[^/]+\/avmeld\/([^>]+)>$/);
          assertEq(m ? av.verifyUnsubscribeToken(m[1]!)?.email : null, to, `${L} [${s}]: it offers List-Unsubscribe signed for this owner`);
          const f = resolved(id, c.key);
          assertEq([f.value, f.block], [true, "guarantee"], `${L} [${s}]: guarantee resolves on`);
          return m ? m[1]! : "";
        };
        try {
          await expectOffered("default"); step(c, "default");
          await refused(id, c.key, true, "guarantee", `${L} [on]`);
          await expectOffered("on"); step(c, "on");
          await refused(id, c.key, false, "guarantee", `${L} [off]`);
          await expectOffered("off"); step(c, "off");
          await refused(id, c.key, true, "guarantee", `${L} [on_again]`);
          const token = await expectOffered("on_again");
          // …and the promise holds: the unsubscribe works and the profile stays.
          const POST = findRouteHandler(avRouter, "/avmeld/:token", "post");
          const p = await invoke(POST, makeReq({ params: { token }, body: { "List-Unsubscribe": "One-Click" } }));
          assertEq(p.status, 200, `${L} [on_again]: POST /avmeld with the offered token → 200`);
          clearSendLog();
          const before = coldSends.length;
          const r = await compose();
          assertEq([r.httpStatus, r.body?.error, coldSends.length - before], [409, "recipient_bounced", 0], `${L} [on_again]: the next cold send is refused, nothing sent`);
          assertTrue(profileExists(), `${L} [on_again]: the profile is not deleted`);
          step(c, "on_again");
        } finally {
          delete process.env.OUTREACH_UNSUBSCRIBE_ENABLED;
        }
      },
    };

    for (const c of OWNER_FEATURE_MATRIX_CASES) {
      if (c.key === "visibility.profile") runners[matrixCaseId(c)] = visibilityProfileRunner;
    }

    // S2e: orders.email — the order address through «Mine valg» (confirmation flow).
    runners["orders.email × email:order_notification"] = async (c) => {
      const id = ids.orderEmail;
      const L = matrixCaseId(c);
      const NEW = "ny-ordreadresse@example.no";
      const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      const { emailService } = require("../services/email-service") as typeof import("../services/email-service");
      const es = emailService as any;
      const prevSend = es.sendOwnerOrderEmailConfirm;
      const confirms: string[] = [];
      es.sendOwnerOrderEmailConfirm = async (o: any) => { confirms.push(String(o.confirmUrl || "")); return { success: true, messageId: "stub" }; };
      process.env.OWNER_ORDER_EMAIL_ENABLED = "1";
      const formH = findRouteHandler(featuresMod.default, "/eier/:agentId/valg/ordre-epost", "post");
      const orderMailTo = async () => {
        const before = sent.length;
        await submitFor(id);
        return sent.slice(before).filter((m) => /Ny henteordre/.test(m.subject)).map((m) => m.to);
      };
      const request = async (email: string, s: MatrixStep) => {
        featuresMod.__resetOwnerFeaturesRateLimitForTesting();
        const r = await invoke(formH, makeReq({ params: { agentId: id }, body: { email }, token: tokens[id] }));
        assertEq([r.status, String(r.body?.__redirect ?? "").includes("melding=ordre_epost_sendt")], [303, true], `${L} [${s}]: «Mine valg» form → confirmation mailed`);
        const token = (confirms[confirms.length - 1] || "").split("/").pop() || "";
        assertEq(await orderMailTo(), [s === "off" ? NEW : emailOf(id)].map((x) => x), `${L} [${s}]: before the click the order mail still goes to the old address`);
        const out = portalMod.confirmOwnerOrderEmailChange(token);
        assertTrue(out.ok, `${L} [${s}]: the confirmation link (POST) is accepted`);
      };
      try {
        await switchTo(id, "orders.enabled", true, `${L} [setup] orders on`);
        // default: the profile e-mail; a direct write is refused.
        const f0 = resolved(id, c.key);
        assertEq([f0.value, f0.source, f0.block], [null, "default", "confirm_by_email"], `${L} [default]: no order address set (profile e-mail), changed only by confirmation`);
        await refused(id, c.key, NEW, "confirm_by_email", `${L} [default]`);
        assertEq(await orderMailTo(), [emailOf(id)], `${L} [default]: order mail to the profile e-mail`);
        step(c, "default");
        await request(NEW, "on");
        assertEq(await orderMailTo(), [NEW], `${L} [on]: after the click the order mail goes to the new address`);
        assertEq(resolved(id, c.key).value, NEW, `${L} [on]: resolved = the new address`);
        step(c, "on");
        await request(emailOf(id), "off");
        assertEq(await orderMailTo(), [emailOf(id)], `${L} [off]: back to the profile address after its click`);
        step(c, "off");
        await request(NEW, "on_again");
        assertEq(await orderMailTo(), [NEW], `${L} [on_again]: the new address again`);
        await refused(id, c.key, null, "confirm_by_email", `${L} [on_again]`);
        step(c, "on_again");
      } finally {
        es.sendOwnerOrderEmailConfirm = prevSend;
        delete process.env.OWNER_ORDER_EMAIL_ENABLED;
      }
    };

    // ── Run the matrix ─────────────────────────────────────────────────────
    const liveKeys = new Set(reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live").map((e) => e.key));
    for (const c of OWNER_FEATURE_MATRIX_CASES) {
      const id = matrixCaseId(c);
      const e = reg.findOwnerFeature(c.key);
      assertTrue(!!e && liveKeys.has(c.key), `${id}: key is a live registry entry`);
      if (e) {
        assertEq(c.kind, e.type === "locked" ? "locked" : e.type === "guarantee" ? "guarantee" : "switch", `${id}: case kind matches the entry type (${e.type})`);
        assertTrue((e.surfaces as string[]).includes(c.surface), `${id}: surface is declared on the entry`);
      }
      const run = runners[id];
      assertTrue(!!run, `${id}: has a runner`);
      if (!run) continue;
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      try {
        await run(c);
      } catch (err: any) {
        failed++;
        failures.push(`✗ ${id}: runner threw: ${String(err?.stack || err)}`);
      }
      assertEq(recorded.get(id) ?? [], [...MATRIX_STEPS], `${id}: ran default → on → off → on again`);
    }
    for (const id of Object.keys(runners)) {
      assertTrue(OWNER_FEATURE_MATRIX_CASES.some((c) => matrixCaseId(c) === id), `runner ${id} is declared in OWNER_FEATURE_MATRIX_CASES`);
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { notifySvc?.__setOrderNotifySendForTesting(null); notifySvc?.__setOrderNotifyTestDb(null); } catch { /* ignore */ }
    try { receiptSvc?.__setBuyerReceiptSendForTesting(null); receiptSvc?.__setBuyerReceiptTestDb(null); } catch { /* ignore */ }
    try { followSvc?.__setOrderFollowupsTestDb(null); } catch { /* ignore */ }
    try { cartSvc?.__setCartTestDb(null); } catch { /* ignore */ }
    try { trustSvc?.__setTrustEventTestDb(null); } catch { /* ignore */ }
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeatureMatrixTests({ log: true }).then((r) => {
    console.info(`\nowner-feature-matrix: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
