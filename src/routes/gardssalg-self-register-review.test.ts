/**
 * gardssalg-self-register-review.test.ts — the admin review queue for
 * self-registered gårdssalg producers (dev-request 2026-11-01-opplevagent-
 * drikkeprodusent-selvregistrering, skive 3: Spec F + review follow-ups of
 * lokal#1534).
 *
 * Real routers on a real http.Server, driven with raw http.request (never
 * global fetch): routes/opplevelser.ts at /api/opplevelser (the three admin
 * endpoints), routes/gardssalg-claim.ts (magic-link-verify, owner routes) and
 * routes/experiences-seo.ts (the confirm POST and the draft editor). Own
 * in-memory experiences db. Mails are captured on the emailService
 * singleton; IndexNow and the CRM ingest go through the service's
 * __setSelfRegisterReviewDepsForTesting seam, so nothing leaves the process
 * and the shared RFB database is never touched.
 *
 * Covers:
 *   off   flag off: the three endpoints are 404 (with a valid admin key) and
 *         nothing is written.
 *   auth  no / wrong X-Admin-Key → 403.
 *   q     the queue: oldest first, count, name, org.nr, Brreg outcome,
 *         duplicate signals, submitter, e-mail, assessment, timestamps, the
 *         e-mail link state (confirmed / pending / expired / not_sent),
 *         actionable only for a hidden pending row; no code hash, no token.
 *   note  the admin notice goes out once, at the confirm step, on the RFB
 *         channel (ADMIN_NOTIFICATION_EMAIL via emailService).
 *   ap    approve: public row, epost from the typed address with provenance
 *         self_registered, owner locks kept (N6), the draft claim becomes the
 *         owner claim (used=1, content_source='claim', claimed_at), a fresh
 *         login link (not the draft token) mailed to the typed address and
 *         CRM-filed without the link, IndexNow pinged for the produsent path,
 *         the login link works on magic-link-verify; a second approve /
 *         reject is 409 and changes nothing.
 *   rj    reject: stays hidden with self_registered_rejected, draft sessions
 *         revoked (and no longer authenticate), the draft's owner locks
 *         cleared but an admin lock kept (N6), a short mail CRM-filed, note
 *         stored; a second reject / approve is 409.
 *   nd    approve of a registration that never confirmed its e-mail: public,
 *         no owner claim until the mailed link is used.
 *   bad   400 / 404 / 409 for bad body, unknown id, an ordinary row.
 *   n5    the «Mine valg» booking adapter treats pending / rejected rows as
 *         booking-blocked, like ownerBookingEnableBlock.
 *
 * Exported runGardssalgSelfRegisterReviewTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-self-register-review.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const TEST_CLIENT_IP = "192.0.2.78";

export function runGardssalgSelfRegisterReviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevFlag = process.env.GARDSSALG_SELF_REGISTER_ENABLED;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAdminMail = process.env.ADMIN_NOTIFICATION_EMAIL;
    const adminKey = "gardssalg-selfreg-review-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = adminKey;
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin-test@example.invalid";
    delete process.env.GARDSSALG_SELF_REGISTER_ENABLED;

    const ids = [
      "../database/db-factory",
      "../services/experience-store",
      "./experiences-seo",
      "./gardssalg-self-register",
      "../services/gardssalg-self-register",
      "../services/gardssalg-claim",
      "./gardssalg-claim",
      "./opplevelser",
      "../owner-features/gardssalg-adapters",
    ].map((p) => require.resolve(p));
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(ids);

    const emailMod = require("../services/email-service") as typeof import("../services/email-service");
    const es = emailMod.emailService as any;
    const origs = {
      confirm: es.sendGardssalgSelfRegisterConfirmLink,
      approved: es.sendGardssalgSelfRegisterApproved,
      rejected: es.sendGardssalgSelfRegisterRejected,
      admin: es.sendAdminGardssalgSelfRegisterNotification,
    };
    const mails: Array<{ kind: string; o: any }> = [];
    let msgN = 0;
    es.sendGardssalgSelfRegisterConfirmLink = async (o: any) => { mails.push({ kind: "confirm", o }); return { success: true, messageId: `m-${++msgN}` }; };
    es.sendGardssalgSelfRegisterApproved = async (o: any) => { mails.push({ kind: "approved", o }); return { success: true, messageId: `m-${++msgN}` }; };
    es.sendGardssalgSelfRegisterRejected = async (o: any) => { mails.push({ kind: "rejected", o }); return { success: true, messageId: `m-${++msgN}` }; };
    es.sendAdminGardssalgSelfRegisterNotification = async (o: any) => { mails.push({ kind: "admin", o }); return { success: true, messageId: `m-${++msgN}` }; };

    let server: any = null;
    let svc: typeof import("../services/gardssalg-self-register") | null = null;
    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      svc = require("../services/gardssalg-self-register") as typeof import("../services/gardssalg-self-register");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const gate = require("../services/gardssalg-booking-gate") as typeof import("../services/gardssalg-booking-gate");
      const adapters = require("../owner-features/gardssalg-adapters") as typeof import("../owner-features/gardssalg-adapters");
      const { gardssalgVisibleSql, GARDSSALG_SURFACES } = require("../services/gardssalg-visibility") as typeof import("../services/gardssalg-visibility");
      const cryptoMod = require("crypto") as typeof import("crypto");

      const pings: Array<{ urls: string[]; host: string }> = [];
      const crm: Array<{ input: any; email: string; vertical: string }> = [];
      const cleared: string[] = [];
      svc.__setSelfRegisterReviewDepsForTesting({
        pingIndexNow: (urls, host) => { pings.push({ urls, host }); },
        crmIngestThread: (input, email, vertical) => { crm.push({ input, email, vertical }); return {}; },
        clearColdOutreachRow: (id) => { cleared.push(id); },
      });

      // ── Fixtures ───────────────────────────────────────────────────────
      const insProv = db.prepare(`
        INSERT INTO experience_providers
          (id, org_nr, navn, slug, kommune, producer_type, catalog_hidden, catalog_hidden_reason, origin, brreg_verified, source, booking_live, field_provenance)
        VALUES (@id, @org_nr, @navn, @slug, 'Lærdal', 'vingård', @hidden, @reason, @origin, 1, 'self_registered', 0, @fp)
      `);
      const insReg = db.prepare(`
        INSERT INTO gardssalg_self_registrations
          (id, status, provider_id, org_nr, submitted_name, submitted_place, submitted_producer_type, submitter_name,
           submitter_email, submitter_phone, brreg_status, brreg_checked_at, duplicate_signals, possible_duplicate_of, created_at)
        VALUES (@id, @status, @provider_id, @org_nr, @name, 'Lærdal', 'vin', @sub, @email, '+47 900 00 000', @brreg, @checked,
                @dup, @pdup, @created)
      `);
      const pend = svc.SELF_REGISTERED_PENDING_REVIEW_REASON;
      const prov = (id: string, org: string, navn: string, slug: string, extra: Record<string, unknown> = {}) =>
        insProv.run({ id, org_nr: org, navn, slug, hidden: 1, reason: pend, origin: "self_registered", fp: null, ...extra });
      const reg = (id: string, providerId: string | null, org: string, name: string, email: string, created: string, extra: Record<string, unknown> = {}) =>
        insReg.run({
          id, status: "pending_review", provider_id: providerId, org_nr: org, name, sub: "Kari Nordmann", email,
          brreg: "verified", checked: "2026-11-01T10:00:00.000Z", dup: JSON.stringify({ name_kommune: ["sr-namesake"], rfb_agent: null, confirmed_not_duplicate: true }),
          pdup: null, created, ...extra,
        });

      prov("p-ok", "920000001", "Godkjent Vingård", "godkjent-vingard");
      reg("r-ok", "p-ok", "920000001", "Godkjent Vingård", "kari@godkjent.no", "2026-11-01 10:00:00", { pdup: "sr-namesake" });
      prov("p-no", "920000002", "Avvist Vingård", "avvist-vingard",
        { fp: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-11-01T00:00:00.000Z", locked_by: "admin" } } }) });
      reg("r-no", "p-no", "920000002", "Avvist Vingård", "ola@avvist.no", "2026-11-02 10:00:00");
      prov("p-exp", "920000003", "Utløpt Vingård", "utlopt-vingard");
      reg("r-exp", "p-exp", "920000003", "Utløpt Vingård", "per@utlopt.no", "2026-11-03 10:00:00");
      reg("r-brreg", null, "920000004", "Ukjent Bryggeri", "lise@ukjent.no", "2026-10-30 09:00:00",
        { status: "brreg_unavailable", brreg: "unavailable", checked: "2026-10-30T09:00:00.000Z", dup: JSON.stringify({ name_kommune: [], rfb_agent: null }) });
      prov("p-nd", "920000005", "Ubekreftet Vingård", "ubekreftet-vingard");
      reg("r-nd", "p-nd", "920000005", "Ubekreftet Vingård", "anne@ubekreftet.no", "2026-11-04 10:00:00");
      insProv.run({ id: "p-plain", org_nr: "920000009", navn: "Vanlig Gård", slug: "vanlig-gard", hidden: 0, reason: null, origin: null, fp: null });

      const provRow = (id: string) => db.prepare("SELECT * FROM experience_providers WHERE id = ?").get(id) as any;
      const regRow = (id: string) => db.prepare("SELECT * FROM gardssalg_self_registrations WHERE id = ?").get(id) as any;
      const claimsOf = (pid: string) => db.prepare("SELECT * FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at, id").all(pid) as any[];
      const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_content_audit").get() as any).n;

      // ── HTTP harness ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.set("trust proxy", true);
      app.use("/api", expressMod.json());
      app.use("/", (require("./gardssalg-claim") as any).default);
      app.use("/api/opplevelser", (require("./opplevelser") as any).default);
      app.use("/", (require("./experiences-seo") as any).default);
      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: any; body: string; json: any }> {
        return new Promise((resolve, reject) => {
          const headers = { "X-Forwarded-For": TEST_CLIENT_IP, ...(o.headers || {}) };
          const r = httpMod.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8");
              let json: any = null;
              try { json = JSON.parse(body); } catch { /* html */ }
              resolve({ status: resp.statusCode || 0, headers: resp.headers, body, json });
            });
          });
          r.on("error", reject);
          if (o.body) r.write(o.body);
          r.end();
        });
      }
      const Q = "/api/opplevelser/admin/gardssalg-self-registered-review-queue";
      const admin = (method: string, path: string, body?: unknown, key: string | null = adminKey) =>
        req(method, path, {
          headers: { ...(key ? { "X-Admin-Key": key } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      const postForm = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
        req("POST", path, {
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null", ...headers },
          body: new URLSearchParams(fields).toString(),
        });

      // ── off: flag off → 404, nothing written ─────────────────────────────
      {
        const before = [JSON.stringify(provRow("p-ok")), JSON.stringify(regRow("r-ok")), auditCount()];
        const g = await admin("GET", Q);
        const a = await admin("POST", `${Q}-approve`, { providerId: "p-ok" });
        const r = await admin("POST", `${Q}-reject`, { providerId: "p-ok" });
        assertEq([g.status, a.status, r.status], [404, 404, 404], "off-1: flag off — GET queue, POST approve and POST reject are 404 (admin key given)");
        const noKey = await admin("GET", Q, undefined, null);
        assertEq(noKey.status, 404, "off-2: flag off — also 404 without a key (the route does not exist, not 403)");
        assertEq([JSON.stringify(provRow("p-ok")), JSON.stringify(regRow("r-ok")), auditCount()], before, "off-3: flag off — nothing was written");
        assertEq(mails.length + pings.length + crm.length, 0, "off-4: flag off — no mail, no IndexNow ping, no CRM write");
      }

      process.env.GARDSSALG_SELF_REGISTER_ENABLED = "true";

      // ── auth ─────────────────────────────────────────────────────────────
      {
        const a = await admin("GET", Q, undefined, null);
        const b = await admin("GET", Q, undefined, "wrong-key");
        const c = await admin("POST", `${Q}-approve`, { providerId: "p-ok" }, null);
        const d = await admin("POST", `${Q}-reject`, { providerId: "p-ok" }, "wrong-key");
        assertEq([a.status, b.status, c.status, d.status], [403, 403, 403, 403], "auth-1: no / wrong X-Admin-Key → 403 on all three");
        assertEq(provRow("p-ok")?.catalog_hidden, 1, "auth-2: a refused approve changed nothing");
      }

      // ── Confirm step: draft session + the admin notice (once) ────────────
      let okDraftCookie = "";
      let okDraftToken = "";
      {
        const issued = svc.issueSelfRegisterConfirmToken("r-ok");
        assertTrue(!!issued, "note-0: a confirm code is issued for the pending registration");
        const ok = await postForm("/for-tilbydere/registrer/bekreft", { t: issued!.token });
        assertEq(ok.status, 303, "note-1: the confirm POST succeeds (303)");
        const set = ([] as string[]).concat(ok.headers["set-cookie"] || []).find((c) => c.startsWith("oa_selfreg_draft=")) || "";
        okDraftCookie = set.split(";")[0];
        okDraftToken = okDraftCookie.slice("oa_selfreg_draft=".length);
        await new Promise((r) => setTimeout(r, 20));
        const adminMails = mails.filter((m) => m.kind === "admin");
        assertEq(adminMails.length, 1, "note-2: confirming sends exactly one admin notice");
        assertEq([adminMails[0]?.o.providerId, adminMails[0]?.o.orgNr, adminMails[0]?.o.submitterEmail, adminMails[0]?.o.assessmentResult, adminMails[0]?.o.possibleDuplicateOf],
          ["p-ok", "920000001", "kari@godkjent.no", "yellow", "sr-namesake"],
          "note-3: … naming the provider, org.nr, the confirmed address, the assessment and the duplicate signal");
        assertTrue(!!regRow("r-ok")?.admin_notified_at, "note-4: admin_notified_at is stamped");
        assertEq(svc.notifyAdminSelfRegisterConfirmed("r-ok"), false, "note-5: a second notify for the same registration sends nothing");
        assertEq(svc.notifyAdminSelfRegisterConfirmed("r-nd"), false, "note-6: an unconfirmed registration is never notified");
        await new Promise((r) => setTimeout(r, 20));
        assertEq(mails.filter((m) => m.kind === "admin").length, 1, "note-7: still exactly one admin notice");

        // The draft edits stamp owner locks on the hidden row (N6 setup).
        const save = await postForm("/for-tilbydere/registrer/utkast", { field_about_text: "Vi lager vin av egne druer.", field_products: "Rødvin" }, { Cookie: okDraftCookie });
        assertEq(save.headers.location, "/for-tilbydere/registrer/utkast?status=saved", "n6-0: the draft save works with the draft cookie");
        const fp = JSON.parse(provRow("p-ok")?.field_provenance || "{}");
        assertTrue(!!fp.owner_locks?.about_text && !!fp.owner_locks?.products, "n6-1: the draft save stamped owner_locks (about_text, products)");
      }

      // The rejected one: confirmed through the service, draft edits via the real writer.
      let noDraftToken = "";
      {
        const issued = svc.issueSelfRegisterConfirmToken("r-no");
        const c = svc.confirmSelfRegisterEmail(issued!.token);
        assertTrue(c.ok, "rj-0: r-no confirmed (draft session issued)");
        noDraftToken = c.ok ? c.sessionToken : "";
        claimSvc.updateClaimedProviderProfile("p-no", { about_text: "Utkast som avvises.", visit_text: "Nytt besøk" });
        const fp = JSON.parse(provRow("p-no")?.field_provenance || "{}");
        assertTrue(!!fp.owner_locks?.about_text && fp.owner_locks?.visit_text?.locked_by === "admin",
          "rj-0b: the draft save locked about_text; the admin lock on visit_text stays an admin lock");
        // An expired link for p-exp.
        svc.issueSelfRegisterConfirmToken("r-exp");
        db.prepare("UPDATE gardssalg_self_registrations SET email_code_expires_at = ? WHERE id = 'r-exp'").run(new Date(Date.now() - 60_000).toISOString());
        // r-nd: the link was sent and is still valid.
        svc.issueSelfRegisterConfirmToken("r-nd");
      }

      // ── q: the queue ─────────────────────────────────────────────────────
      {
        const g = await admin("GET", Q);
        assertEq(g.status, 200, "q-1: GET queue → 200");
        const e = (g.json?.entries || []) as any[];
        assertEq(g.json?.count, 5, "q-2: count = every open registration (4 pending + 1 Brreg unavailable)");
        assertEq(e.map((x) => x.registration_id), ["r-brreg", "r-ok", "r-no", "r-exp", "r-nd"], "q-3: oldest first");
        const ok = e.find((x) => x.registration_id === "r-ok");
        assertEq([ok?.provider_id, ok?.provider_name, ok?.org_nr, ok?.brreg?.status, ok?.possible_duplicate_of, ok?.actionable, ok?.status],
          ["p-ok", "Godkjent Vingård", "920000001", "verified", "sr-namesake", true, "pending_review"],
          "q-4: name, org.nr, Brreg outcome, possible_duplicate_of, actionable");
        assertEq(ok?.duplicate_signals, { name_kommune: ["sr-namesake"], rfb_agent: null, confirmed_not_duplicate: true }, "q-5: duplicate signals parsed");
        assertEq([ok?.submitter?.name, ok?.submitter?.email, ok?.submitter?.phone], ["Kari Nordmann", "kari@godkjent.no", "+47 900 00 000"], "q-6: submitter and e-mail");
        assertEq([ok?.assessment?.result, ok?.assessment?.reason], ["yellow", "assessment_module_missing"], "q-7: the stored assessment");
        assertTrue(ok?.email_link?.state === "confirmed" && !!ok?.email_link?.confirmed_at && !!ok?.email_link?.sent_at && !!ok?.created_at && typeof ok?.age_days === "number",
          "q-8: e-mail link confirmed, with timestamps and age_days");
        assertEq(ok?.draft_session_active, true, "q-9: an active draft session is shown");
        assertEq(e.find((x) => x.registration_id === "r-exp")?.email_link?.state, "expired", "q-10: an expired, unconfirmed link shows as expired (review N4)");
        assertEq(e.find((x) => x.registration_id === "r-nd")?.email_link?.state, "pending", "q-11: a sent, still valid link shows as pending");
        const br = e.find((x) => x.registration_id === "r-brreg");
        assertEq([br?.actionable, br?.provider_id, br?.brreg?.status, br?.email_link?.state], [false, null, "unavailable", "not_sent"],
          "q-12: a Brreg-unavailable submission is listed, not actionable, link not_sent");
        assertTrue(!g.body.includes("email_code_hash") && !g.body.includes(okDraftToken) && !/[0-9a-f]{64}/.test(g.body),
          "q-13: no code hash, no token in the queue response");
      }

      // ── bad input ───────────────────────────────────────────────────────
      {
        const a = await admin("POST", `${Q}-approve`, {});
        const b = await admin("POST", `${Q}-approve`, { providerId: 42 });
        const c = await admin("POST", `${Q}-reject`, { providerId: "p-ok", note: 7 });
        assertEq([a.status, b.status, c.status], [400, 400, 400], "bad-1: missing / non-string providerId, non-string note → 400");
        const d = await admin("POST", `${Q}-approve`, { providerId: "nope" });
        assertEq([d.status, d.json?.error], [404, "provider_not_found"], "bad-2: unknown provider → 404");
        const before = JSON.stringify(provRow("p-plain"));
        const e1 = await admin("POST", `${Q}-approve`, { providerId: "p-plain" });
        const e2 = await admin("POST", `${Q}-reject`, { providerId: "p-plain" });
        assertEq([e1.status, e1.json?.error, e2.status, e2.json?.error], [409, "not_pending_review", 409, "not_pending_review"],
          "bad-3: an ordinary (not self-registered pending) row → 409 not_pending_review on approve and reject");
        assertEq(JSON.stringify(provRow("p-plain")), before, "bad-4: … and it is unchanged");
      }

      // ── ap: approve ─────────────────────────────────────────────────────
      {
        const auditBefore = auditCount();
        const r = await admin("POST", `${Q}-approve`, { providerId: "p-ok" });
        assertEq([r.status, r.json?.success, r.json?.status, r.json?.catalogHidden, r.json?.epostSet, r.json?.ownerClaimPromoted, r.json?.loginLinkSent, r.json?.crmRecorded, r.json?.indexNowPinged],
          [200, true, "approved", false, true, true, true, true, true], "ap-1: approve → 200 with the outcome flags");
        assertTrue(!/[0-9a-f]{64}/.test(r.body) && !r.body.includes("kari@godkjent.no"), "ap-2: the response carries no token and only a masked address");
        const p = provRow("p-ok");
        assertEq([p?.catalog_hidden, p?.catalog_hidden_reason, p?.epost], [0, null, "kari@godkjent.no"], "ap-3: public, reason cleared, epost = the typed address");
        const fp = JSON.parse(p?.field_provenance || "{}");
        assertEq([fp.epost?.source_type, fp.epost?.value, fp.epost?.registration_id], ["self_registered", "kari@godkjent.no", "r-ok"], "ap-4: epost provenance self_registered");
        assertTrue(!!fp.owner_locks?.about_text && !!fp.owner_locks?.products, "ap-5 (N6): the owner locks from the draft are kept on approve");
        assertEq(p?.about_text, "Vi lager vin av egne druer.", "ap-6: the draft text is the public text");
        for (const surface of GARDSSALG_SURFACES) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = 'p-ok' AND ${gardssalgVisibleSql(surface)}`).get() as any).n;
          assertEq(n, 1, `ap-7: after approval gardssalgVisibleSql('${surface}') includes the row`);
        }
        const claims = claimsOf("p-ok");
        const draft = claims.find((c) => c.token === okDraftToken);
        assertEq([draft?.draft_mode, draft?.used, draft?.revoked_at], [0, 1, null], "ap-8: the draft claim became an ordinary used owner claim");
        assertEq([p?.content_source, !!p?.claimed_at, claimSvc.isGardssalgProviderClaimed("p-ok")], ["claim", true, true],
          "ap-9: content_source='claim', claimed_at set, the provider counts as claimed");
        const login = claims.find((c) => c.token !== okDraftToken);
        assertEq([claims.length, login?.email, login?.email_source, login?.used, login?.draft_mode], [2, "kari@godkjent.no", "self_registered", 0, 0],
          "ap-10: one fresh login-link claim row to the typed address (source self_registered)");
        const mail = mails.filter((m) => m.kind === "approved").pop();
        assertEq(mail?.o.to, "kari@godkjent.no", "ap-11: the approval mail goes to the typed address");
        assertTrue(String(mail?.o.loginUrl).endsWith(`/kategori/gardssalg/eier/magic-link-verify?token=${login?.token}`) && !String(mail?.o.loginUrl).includes(okDraftToken),
          "ap-12: … with the fresh login link, never the draft token");
        assertEq(mail?.o.profileUrl, "https://opplevagent.no/kategori/gardssalg/produsent/godkjent-vingard", "ap-13: … and the public profile URL");
        assertEq(pings, [{ urls: ["https://opplevagent.no/kategori/gardssalg/produsent/godkjent-vingard"], host: "opplevagent.no" }],
          "ap-14: IndexNow pinged once for the produsent path on opplevagent.no");
        const c = crm.pop();
        assertEq([c?.vertical, c?.email, c?.input?.threadId, c?.input?.category, c?.input?.messages?.[0]?.direction, c?.input?.messages?.[0]?.toEmails],
          ["experiences", "kari@godkjent.no", "gardssalg-selfreg-r-ok", "system", "out", ["kari@godkjent.no"]],
          "ap-15: the mail is filed in the CRM (experiences vertical, own thread, outbound)");
        assertTrue(!JSON.stringify(c?.input).includes(String(login?.token)) && String(c?.input?.messages?.[0]?.bodyText).includes("[innloggingslenke]"),
          "ap-16: … with a placeholder instead of the login link");
        assertEq(cleared, [c?.input?.messages?.[0]?.messageId], "ap-17: … and its cold-outreach trigger row is cleared");
        assertEq([regRow("r-ok")?.status, !!regRow("r-ok")?.reviewed_at], ["approved", true], "ap-18: the registration is approved with reviewed_at");
        assertTrue(auditCount() > auditBefore, "ap-19: the approval is audited");

        // The mailed link logs the owner in on the ordinary portal.
        const v = await req("GET", `/kategori/gardssalg/eier/magic-link-verify?token=${login?.token}`);
        const ownerCookie = ([] as string[]).concat(v.headers["set-cookie"] || []).find((x) => x.startsWith("oa_owner_session=")) || "";
        assertTrue(v.status === 302 && v.headers.location === "/kategori/gardssalg/eier/godkjent-vingard/portal" && !!ownerCookie,
          "ap-20: the login link → ordinary owner session + portal redirect");
        const prof = await req("GET", "/api/opplevelser/gardssalg-claim/p-ok/profile", { headers: { Cookie: ownerCookie.split(";")[0] } });
        assertEq(prof.status, 200, "ap-21: the owner JSON profile route accepts that session");
        const draftAfter = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: okDraftCookie } });
        assertEq(draftAfter.status, 401, "ap-22: the old draft cookie no longer opens the draft editor");
        // Booking is no longer blocked by the self-registration gate.
        assertEq(gate.ownerBookingEnableBlock(claimSvc.getClaimProviderById("p-ok")!), null, "ap-23: ownerBookingEnableBlock allows booking after approval (epost present)");

        const snap = [JSON.stringify(provRow("p-ok")), claimsOf("p-ok").length, auditCount(), mails.length, pings.length];
        const again = await admin("POST", `${Q}-approve`, { providerId: "p-ok" });
        const rej = await admin("POST", `${Q}-reject`, { providerId: "p-ok" });
        assertEq([again.status, again.json?.error, rej.status, rej.json?.error], [409, "already_approved", 409, "already_approved"],
          "ap-24: a second approve / a reject after approval → 409 already_approved");
        assertEq([JSON.stringify(provRow("p-ok")), claimsOf("p-ok").length, auditCount(), mails.length, pings.length], snap,
          "ap-25: … and nothing changed, nothing was sent");
      }

      // ── rj: reject ──────────────────────────────────────────────────────
      {
        assertEq(svc.verifySelfRegisterDraftSession(noDraftToken).valid, true, "rj-1: before the reject the draft session is valid");
        const r = await admin("POST", `${Q}-reject`, { providerId: "p-no", note: "Ikke en drikkeprodusent." });
        assertEq([r.status, r.json?.status, r.json?.revokedSessions, r.json?.clearedOwnerLocks, r.json?.mailSent, r.json?.crmRecorded],
          [200, "rejected", 1, ["about_text"], true, true], "rj-2: reject → 200, one session revoked, the draft's lock cleared");
        const p = provRow("p-no");
        assertEq([p?.catalog_hidden, p?.catalog_hidden_reason, p?.epost, p?.claimed_at, p?.booking_live], [1, "self_registered_rejected", null, null, 0],
          "rj-3: stays hidden with self_registered_rejected, no epost, unclaimed, booking off");
        const fp = JSON.parse(p?.field_provenance || "{}");
        assertEq(fp.owner_locks, { visit_text: { locked_at: "2026-11-01T00:00:00.000Z", locked_by: "admin" } },
          "rj-4 (N6): the draft's owner lock is cleared on reject; the admin lock stays");
        const claims = claimsOf("p-no");
        assertTrue(claims.length === 1 && !!claims[0].revoked_at && claims[0].used === 0, "rj-5: the draft claim is revoked (and was never used)");
        assertEq(svc.verifySelfRegisterDraftSession(noDraftToken).valid, false, "rj-6: the revoked draft session no longer authenticates");
        db.prepare("UPDATE experience_providers SET catalog_hidden_reason = ? WHERE id = 'p-no'").run(pend);
        assertEq(svc.verifySelfRegisterDraftSession(noDraftToken).valid, false, "rj-7: … not even if the row were pending again (revoked_at, not only the reason)");
        const ed = await req("GET", "/for-tilbydere/registrer/utkast", { headers: { Cookie: `oa_selfreg_draft=${noDraftToken}` } });
        assertEq(ed.status, 401, "rj-8: the draft editor refuses the revoked session");
        db.prepare("UPDATE experience_providers SET catalog_hidden_reason = 'self_registered_rejected' WHERE id = 'p-no'").run();
        const mail = mails.filter((m) => m.kind === "rejected").pop();
        assertEq([mail?.o.to, mail?.o.providerName], ["ola@avvist.no", "Avvist Vingård"], "rj-9: the short rejection mail goes to the submitter");
        const c = crm.pop();
        assertEq([c?.vertical, c?.input?.threadId, c?.email], ["experiences", "gardssalg-selfreg-r-no", "ola@avvist.no"], "rj-10: … CRM-filed");
        assertTrue(!String(c?.input?.messages?.[0]?.bodyText).includes("Ikke en drikkeprodusent"), "rj-11: the admin note is never in the mail");
        assertEq([regRow("r-no")?.status, regRow("r-no")?.review_note], ["rejected", "Ikke en drikkeprodusent."], "rj-12: registration rejected, note stored");
        for (const surface of GARDSSALG_SURFACES) {
          const n = (db.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = 'p-no' AND ${gardssalgVisibleSql(surface)}`).get() as any).n;
          assertEq(n, 0, `rj-13: after rejection gardssalgVisibleSql('${surface}') still excludes the row`);
        }
        assertEq(pings.length, 1, "rj-14: no IndexNow ping on reject");

        const snap = [JSON.stringify(provRow("p-no")), auditCount(), mails.length];
        const again = await admin("POST", `${Q}-reject`, { providerId: "p-no" });
        const ap = await admin("POST", `${Q}-approve`, { providerId: "p-no" });
        assertEq([again.status, again.json?.error, ap.status, ap.json?.error], [409, "already_rejected", 409, "already_rejected"],
          "rj-15: a second reject / an approve after reject → 409 already_rejected");
        assertEq([JSON.stringify(provRow("p-no")), auditCount(), mails.length], snap, "rj-16: … and nothing changed");
        const g = await admin("GET", Q);
        assertEq((g.json?.entries || []).map((x: any) => x.registration_id), ["r-brreg", "r-exp", "r-nd"], "rj-17: decided registrations leave the queue");
      }

      // ── nd: approve without a confirmed e-mail ───────────────────────────
      {
        const r = await admin("POST", `${Q}-approve`, { providerId: "p-nd" });
        assertEq([r.status, r.json?.ownerClaimPromoted, r.json?.loginLinkSent, r.json?.epostSet], [200, false, true, true],
          "nd-1: approve of an unconfirmed registration → public, no owner claim promoted, login link sent");
        assertEq([claimSvc.isGardssalgProviderClaimed("p-nd"), provRow("p-nd")?.claimed_at], [false, null], "nd-2: not claimed until the link is used");
        const login = claimsOf("p-nd")[0];
        const v = await req("GET", `/kategori/gardssalg/eier/magic-link-verify?token=${login?.token}`);
        assertEq([v.status, claimSvc.isGardssalgProviderClaimed("p-nd"), provRow("p-nd")?.content_source], [302, true, "claim"],
          "nd-3: using the mailed link makes the producer the owner (verifyClaimToken)");
      }

      // ── n5: the «Mine valg» booking adapter ──────────────────────────────
      {
        const facts = adapters.loadGardssalgSubjectFacts("p-exp");
        assertEq([facts.conditions.noBookingAdminBrake?.met, facts.conditions.noBookingAdminBrake?.reason?.no], [false, gate.OWNER_BOOKING_PENDING_REVIEW_MSG],
          "n5-1: a pending self-registered row: the booking entry's enable condition is not met (pending-review reason)");
        const factsRej = adapters.loadGardssalgSubjectFacts("p-no");
        assertEq(factsRej.conditions.noBookingAdminBrake?.met, false, "n5-2: a rejected row is booking-blocked too");
        assertEq(adapters.loadGardssalgSubjectFacts("p-ok").conditions.noBookingAdminBrake?.met, true, "n5-3: an approved row is not blocked by it");
        db.prepare("UPDATE experience_providers SET epost = 'post@avvist.no' WHERE id = 'p-no'").run();
        const w = adapters.GARDSSALG_BOOKING_ENABLED_ADAPTER.write(null, "p-no", true) as any;
        assertTrue(!!w?.blocked && w.blocked.no === gate.OWNER_BOOKING_PENDING_REVIEW_MSG && /approved the registration/.test(w.blocked.en),
          "n5-4: the adapter's write refuses booking on a rejected row with the pending-review reason (no and en)");
        assertEq(provRow("p-no")?.booking_live, 0, "n5-5: … and booking_live stays 0");
        assertEq(gate.ownerBookingEnableBlock({ epost: "x@y.no", booking_admin_brake_at: null, booking_admin_brake_note: null, catalog_hidden_reason: "self_registered_rejected" })?.reason,
          "pending_review", "n5-6: ownerBookingEnableBlock refuses a rejected self-registration");
      }

      // ── off again: the queue disappears ──────────────────────────────────
      {
        delete process.env.GARDSSALG_SELF_REGISTER_ENABLED;
        const g = await admin("GET", Q);
        const a = await admin("POST", `${Q}-approve`, { providerId: "p-exp" });
        assertEq([g.status, a.status, provRow("p-exp")?.catalog_hidden], [404, 404, 1], "off-5: flag off again → 404, nothing approved");
      }
      void cryptoMod;
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
    } finally {
      es.sendGardssalgSelfRegisterConfirmLink = origs.confirm;
      es.sendGardssalgSelfRegisterApproved = origs.approved;
      es.sendGardssalgSelfRegisterRejected = origs.rejected;
      es.sendAdminGardssalgSelfRegisterNotification = origs.admin;
      if (server) {
        try { server.close(); } catch { /* ignore */ }
      }
      try { svc?.__setSelfRegisterReviewDepsForTesting(null); } catch { /* ignore */ }
      try {
        const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
        (generalLimiter as any).resetKey(TEST_CLIENT_IP);
      } catch { /* ignore */ }
      const restoreEnv = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restoreEnv("GARDSSALG_SELF_REGISTER_ENABLED", prevFlag);
      restoreEnv("ADMIN_KEY", prevAdminKey);
      restoreEnv("ADMIN_NOTIFICATION_EMAIL", prevAdminMail);
      restoreEnv("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
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
  runGardssalgSelfRegisterReviewTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
