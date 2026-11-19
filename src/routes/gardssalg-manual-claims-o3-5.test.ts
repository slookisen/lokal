/**
 * O3-5 (A2A dev-request 2026-11-12-opplevagent-o3-eierkrav-og-innlogging):
 * manual gårdssalg claim queue — submit/receipt flags, AK1 queue with age,
 * age alarm, AK2 dry-run by default, domain rule, approve once, reject, old
 * value logged, no token in logs. Wired into tests/test.ts.
 * Standalone: npx tsx src/routes/gardssalg-manual-claims-o3-5.test.ts
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

export function runGardssalgManualClaimsO35Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const out = console.log.bind(console);
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    const msg = ok ? `ok ${label}` : `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    if (ok) passed++; else { failed++; failures.push(msg); }
    if (log) out("  " + msg);
  };
  const assertTrue = (cond: boolean, label: string): void => assertEq(!!cond, true, label);
  return (async () => {
    const ENV_KEYS = [
      "EXPERIENCES_DB_PATH", "OPPLEVAGENT_BASE_URL", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY",
      "GARDSSALG_CLAIM_MANUAL_QUEUE_ENABLED", "GARDSSALG_CLAIM_MANUAL_QUEUE_RECEIPT_ENABLED", "GARDSSALG_OWNER_SESSION_SLIDING_ENABLED",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = "test-admin-o35";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(
      ["../database/db-factory", "../services/gardssalg-claim", "../services/gardssalg-manual-claims", "./gardssalg-claim", "./admin-gardssalg-manual-claims"]
        .map((m) => require.resolve(m)),
    );
    const initMod = require("../database/init") as typeof import("../database/init");
    const restoreMainDb = initMod.__pinInMemoryDbForTesting();
    const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
    const origConfigured = emailSvc.isConfigured;
    const origTransporter = emailSvc.transporter;
    const mails: Array<{ to: string; subject: string; text: string }> = [];
    const logged: string[] = [];
    const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    let server: any = null;
    let claimSvc: typeof import("../services/gardssalg-claim") | null = null;
    try {
      emailSvc.isConfigured = true;
      emailSvc.transporter = { sendMail: async (m: Record<string, any>) => {
        mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? "") });
        return { messageId: `<stub-o35-${mails.length}@test>` };
      } };
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvc.__setClaimHarvestFetchForTesting((async () => new Response("", { status: 404 })) as typeof fetch);
      const svc = require("../services/gardssalg-manual-claims") as typeof import("../services/gardssalg-manual-claims");
      const ins = db.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, content_source, hjemmeside, field_provenance, enrichment_state, verification_status, source, confidence)
        VALUES (@id, @navn, @slug, 'experiences', @org, @bv, NULL, @hj, @fp, 'raw', 'pending_verify', 'test-fixture', 'medium')`);
      ins.run({ id: "prov-o35-a", navn: "Alfa Sideri", slug: "o35-alfa", org: "913500001", bv: 1, hj: null, fp: null });
      ins.run({ id: "prov-o35-b", navn: "Beta Bryggeri", slug: "o35-beta", org: "913500002", bv: 1, hj: null, fp: null });
      ins.run({ id: "prov-o35-c", navn: "Cgard Most", slug: "o35-cgard", org: "913500003", bv: 0, hj: "https://www.cgard.no",
        fp: JSON.stringify({ hjemmeside: { source_url: "https://www.cgard.no" } }) });
      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use(expressMod.json());
      app.use("/", (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default);
      app.use("/admin/gardssalg-manual-claims", (require("./admin-gardssalg-manual-claims") as typeof import("./admin-gardssalg-manual-claims")).default);
      await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
      const port = (server.address() as any).port as number;
      const req = async (method: string, path: string, body?: unknown, admin = false) => {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(admin ? { "X-Admin-Key": "test-admin-o35" } : {}) };
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const raw = await r.text();
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* html */ }
        return { status: r.status, body: parsed, raw };
      };
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
      const submit = (pid: string, body: unknown) => req("POST", `/kategori/gardssalg/eier/${pid}/manuelt-krav`, body);
      const snapshot = () => JSON.stringify({
        claims: db.prepare(`SELECT id, email, used, revoked_at FROM gardssalg_claims ORDER BY id`).all(),
        providers: db.prepare(`SELECT id, content_source, claimed_at FROM experience_providers WHERE id LIKE 'prov-o35-%' ORDER BY id`).all(),
        queue: db.prepare(`SELECT id, status, decided_at, old_value FROM gardssalg_manual_claims ORDER BY id`).all(),
        audit: db.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit`).get(),
      });
      for (const k of ["log", "warn", "error", "info"] as const) (console as any)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      // ── (s) public submit ───────────────────────────────────────────────
      const s0 = await submit("prov-o35-a", { name: "Ada", email: "ada@gmail.com" });
      assertEq([s0.status, count(`SELECT COUNT(*) AS n FROM gardssalg_manual_claims`)], [404, 0], "s1: queue flag off -> POST falls through, nothing queued");
      process.env.GARDSSALG_CLAIM_MANUAL_QUEUE_ENABLED = "true";
      const s1 = await submit("prov-o35-a", { name: "Ada", email: "Ada@Gmail.com", message: "Eier gården" });
      const s1b = await submit("prov-o35-a", { name: "Ada", email: "ada@gmail.com" });
      await settle();
      const rowsA = db.prepare(`SELECT claimant_email, reason, status FROM gardssalg_manual_claims WHERE provider_id = 'prov-o35-a'`).all();
      assertEq([s1.status, s1.body, s1b.status, rowsA], [200, { success: true }, 200, [{ claimant_email: "ada@gmail.com", reason: "no_org_linked_email", status: "pending" }]],
        "s2: flag on -> one pending row, a repeat answers the same and adds nothing");
      assertEq(mails.length, 0, "s3: receipt flag off -> no receipt mail");
      const bad = await submit("prov-o35-a", { name: "", email: "nope" });
      assertEq([bad.status, bad.body?.error], [400, "invalid_input"], "s4: missing name / bad e-mail -> 400");
      process.env.GARDSSALG_CLAIM_MANUAL_QUEUE_RECEIPT_ENABLED = "true";
      await submit("prov-o35-b", { name: "Bo", email: "bo@beta.example" });
      await settle();
      assertEq(mails.map((m) => [m.to, m.subject]), [["bo@beta.example", "Vi har fått kravet ditt om profilen til Beta Bryggeri"]], "s5: receipt flag on -> one receipt, to the claimant's own address");
      assertTrue(mails[0]?.text.startsWith("Hei Bo,\n\nVi har fått kravet ditt om å ta over profilen til Beta Bryggeri på Opplevagent."), "s6: receipt text filled");
      assertTrue(!!(db.prepare(`SELECT receipt_sent_at FROM gardssalg_manual_claims WHERE provider_id = 'prov-o35-b'`).get() as any).receipt_sent_at, "s7: receipt_sent_at stamped");
      await submit("prov-o35-c", { name: "Cecilie", email: "post@cgard.no" });
      const page = await req("GET", "/kategori/gardssalg/eier/o35-alfa");
      assertTrue(page.raw.includes('data-gc-manual-claim="1"') && page.raw.includes("/kategori/gardssalg/eier/prov-o35-a/manuelt-krav"), "s8: entry page shows the manual form (flag on, no self-service)");
      // ── (q) AK1 admin GET + age alarm ───────────────────────────────────
      const noKey = await req("GET", "/admin/gardssalg-manual-claims");
      const q = await req("GET", "/admin/gardssalg-manual-claims", undefined, true);
      assertEq(noKey.status, 403, "q1: admin GET without key -> 403");
      assertEq([q.status, q.body.count, q.body.entries.map((e: any) => e.provider_id)], [200, 3, ["prov-o35-a", "prov-o35-b", "prov-o35-c"]], "q2: AK1 the queue, oldest first");
      assertTrue(q.body.entries.every((e: any) => typeof e.age_hours === "number" && typeof e.age_business_days === "number" && e.age_alarm === false),
        "q3: AK1 age per row (age_hours, age_business_days, age_alarm)");
      const idA = q.body.entries[0].id as string;
      const idB = q.body.entries[1].id as string;
      const idC = q.body.entries[2].id as string;
      db.prepare(`UPDATE gardssalg_manual_claims SET created_at = '2026-11-13T12:00:00.000Z' WHERE id = ?`).run(idA); // a Friday
      const tue11 = svc.listManualClaimQueue(new Date("2026-11-17T11:00:00.000Z")).entries.find((e) => e.id === idA)!;
      const tue13 = svc.listManualClaimQueue(new Date("2026-11-17T13:00:00.000Z"));
      assertEq([tue11.age_business_days, tue11.age_alarm], [1.96, false], "q4: Fri 12:00 -> Tue 11:00 is 1.96 business days (weekend skipped), no alarm");
      assertEq([tue13.entries.find((e) => e.id === idA)!.age_alarm, tue13.alarm_count >= 1], [true, true], "q5: past 2 business days -> age_alarm");
      // ── (d) AK2 dry-run by default + the domain rule ─────────────────────
      const before = snapshot();
      const d1 = await req("POST", `/admin/gardssalg-manual-claims/${idA}/approve`, {}, true);
      const d2 = await req("POST", `/admin/gardssalg-manual-claims/${idA}/approve?apply=true`, { apply: "true", override_reason: "ringt" }, true);
      const d3 = await req("POST", `/admin/gardssalg-manual-claims/${idB}/reject`, { apply: 1 }, true);
      assertEq([d1.body.dry_run, d2.body.dry_run, d3.body.dry_run], [true, true, true], "d1: AK2 no apply / apply:\"true\" / ?apply=true / apply:1 -> dry run");
      assertEq(snapshot(), before, "d2: AK2 the DB is unchanged after the dry runs");
      assertEq([d1.body.domain_rule.recommendation, d1.body.would_block, d1.body.old_value],
        ["free_mail_needs_extra", "domain_rule_mismatch", { content_source: null, claimed_at: null, active_owner_claims: 0 }], "d3: dry run shows the domain rule, the block and the old value");
      const d4 = await req("POST", `/admin/gardssalg-manual-claims/${idA}/approve`, { apply: true }, true);
      assertEq([d4.status, d4.body.error, snapshot() === before], [409, "domain_rule_mismatch", true], "d4: domain-rule mismatch blocks apply without override, nothing written");
      // ── (a) approve: ownership exactly once ─────────────────────────────
      const mailsBefore = mails.length;
      const a1 = await req("POST", `/admin/gardssalg-manual-claims/${idA}/approve`, { apply: true, override_reason: "Ringt gården, bekreftet" }, true);
      await settle();
      const provA = db.prepare(`SELECT content_source, claimed_at FROM experience_providers WHERE id = 'prov-o35-a'`).get() as any;
      const claimsA = db.prepare(`SELECT email, used, email_source FROM gardssalg_claims WHERE provider_id = 'prov-o35-a' ORDER BY used DESC`).all();
      assertEq([a1.status, a1.body.dry_run, a1.body.claimant_email, provA.content_source, typeof provA.claimed_at], [200, false, "a*a@g***.com", "claim", "string"], "a1: override + apply -> ownership set");
      assertEq(claimsA, [{ email: "ada@gmail.com", used: 1, email_source: "manual" }, { email: "ada@gmail.com", used: 0, email_source: "manual" }], "a2: one owner row + one login link row to the claimant");
      assertEq(mails.slice(mailsBefore).map((m) => m.to), ["ada@gmail.com"], "a3: login link mailed to the claimant only");
      const a2 = await req("POST", `/admin/gardssalg-manual-claims/${idA}/approve`, { apply: true, override_reason: "igjen" }, true);
      assertEq([a2.status, a2.body.error, count(`SELECT COUNT(*) AS n FROM gardssalg_claims WHERE provider_id = 'prov-o35-a'`)], [409, "not_pending", 2], "a4: a second apply is rejected, nothing more written");
      const rowA = db.prepare(`SELECT status, old_value, decision_note FROM gardssalg_manual_claims WHERE id = ?`).get(idA) as any;
      const auditA = db.prepare(`SELECT field_name, old_value, changed_by, notes FROM gardssalg_content_audit WHERE provider_id = 'prov-o35-a' AND field_name LIKE 'gardssalg_manual%'`).all() as any[];
      assertEq([rowA.status, JSON.parse(rowA.old_value), auditA.length, auditA[0]?.changed_by, JSON.parse(auditA[0]?.old_value ?? "null")],
        ["approved", { content_source: null, claimed_at: null, active_owner_claims: 0 }, 1, "admin", { content_source: null, claimed_at: null, active_owner_claims: 0 }], "a5: old value logged on the row and in the audit");
      assertTrue(String(rowA.decision_note).includes("override: Ringt gården, bekreftet"), "a6: override reason recorded");
      const c1 = await req("POST", `/admin/gardssalg-manual-claims/${idC}/approve`, { apply: true }, true);
      assertEq([c1.status, c1.body.domain_rule?.recommendation], [200, "domain_match_independent"], "a7: P1 domain match on the verified website -> apply without override");
      // ── (r) reject ──────────────────────────────────────────────────────
      const r1 = await req("POST", `/admin/gardssalg-manual-claims/${idB}/reject`, { apply: true, note: "ukjent" }, true);
      const provB = db.prepare(`SELECT content_source, claimed_at FROM experience_providers WHERE id = 'prov-o35-b'`).get() as any;
      const rowB = db.prepare(`SELECT status, decision_note, old_value FROM gardssalg_manual_claims WHERE id = ?`).get(idB) as any;
      assertEq([r1.status, provB, count(`SELECT COUNT(*) AS n FROM gardssalg_claims WHERE provider_id = 'prov-o35-b'`)],
        [200, { content_source: null, claimed_at: null }, 0], "r1: reject leaves ownership untouched");
      assertEq([rowB.status, rowB.decision_note, typeof rowB.old_value], ["rejected", "ukjent", "string"], "r2: decision and old value recorded");
      const q2 = await req("GET", "/admin/gardssalg-manual-claims", undefined, true);
      assertEq(q2.body.count, 0, "r3: decided rows leave the queue");
      // ── (l) no token in logs or responses ───────────────────────────────
      const tokens = (db.prepare(`SELECT token FROM gardssalg_claims`).all() as any[]).map((r) => r.token as string);
      const seen = logged.join("\n") + JSON.stringify([a1.body, c1.body]);
      assertTrue(tokens.length > 0 && !tokens.some((t) => seen.includes(t)) && !seen.includes("token="), "l1: no token or link in logs or admin responses");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-manual-claims-o3-5: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      Object.assign(console, origConsole);
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      try { claimSvc?.__setClaimHarvestFetchForTesting(undefined); } catch { /* ignore */ }
      try {
        const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
        await generalLimiter.resetKey("127.0.0.1");
      } catch { /* ignore */ }
      emailSvc.isConfigured = origConfigured;
      emailSvc.transporter = origTransporter;
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* ignore */ }
      restoreModuleCache();
      restoreMainDb();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgManualClaimsO35Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) process.exit(1);
  });
}
