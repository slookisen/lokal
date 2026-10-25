/**
 * opplevelser-gardssalg-outreach-v4-measurement.test.ts — dev-request
 * 2026-10-22-opplevagent-utsending-v4, endring 10 / AC8: GET
 * /admin/gardssalg-outreach-v4-measurement.
 *
 *   • human page views of /produsent/<slug> and /eier/<slug> inside vs outside the 72 h window;
 *   • exact slug match (no prefix leakage), bots / owner views / error statuses not counted;
 *   • only template personal-v4 / personal-v4-followup rows; older `personal` excluded;
 *   • claim link requested (gardssalg_claims), claimed (claimed_at), replied, «fjern»;
 *   • the endpoint requires admin auth and writes nothing.
 *
 * Exported runOpplevelserGardssalgOutreachV4MeasurementTests({log}) -> TestSummary; wired into
 * tests/test.ts (runSerial). Standalone: npx tsx src/routes/opplevelser-gardssalg-outreach-v4-measurement.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function callRoute(router: any, query: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const path = "/admin/gardssalg-outreach-v4-measurement";
    const url = path + (qs ? `?${qs}` : "");
    const req: any = { method: "GET", url, originalUrl: url, path, query, headers, body: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      set() { return this; },
      setHeader() { return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
      send(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
    };
    router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
  });
}

export function runOpplevelserGardssalgOutreachV4MeasurementTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (a: unknown, e: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(e)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
  };

  return (async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ["EXPERIENCES_DB_PATH", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"]) saved[k] = process.env[k];
    const testKey = "v4-measurement-test-admin-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const cachePaths = [require.resolve("../database/db-factory"), require.resolve("../services/blocklist-service"), require.resolve("./opplevelser")];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    let prevRfbDb: any = null;
    const prevLog = console.log;
    const prevWarn = console.warn;

    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      if (!log) { console.log = () => {}; console.warn = () => {}; }

      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      const sqlTs = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      const HOUR = 3600 * 1000;
      const sentAt = new Date(Date.now() - 10 * 24 * HOUR); // window long closed
      const at = (hours: number) => sqlTs(new Date(sentAt.getTime() + hours * HOUR));

      const mkProvider = (id: string, slug: string, claimedAt: string | null = null) =>
        expDb.prepare(`INSERT INTO experience_providers (id, navn, vertical, slug, source, confidence, created_at, claimed_at)
          VALUES (?, ?, 'experiences', ?, 'test-fixture', 'medium', '2026-01-01 00:00:00', ?)`).run(id, `Gård ${id}`, slug, claimedAt);
      const mkThread = (threadId: string, email: string) => {
        rfbDb.prepare(`INSERT OR IGNORE INTO crm_contacts (id, type, email) VALUES (?, 'producer', ?)`).run(`c-${email}`, email);
        rfbDb.prepare(`INSERT INTO crm_threads (id, contact_id, subject) VALUES (?, ?, 'x')`).run(threadId, `c-${email}`);
      };
      const mkOut = (providerId: string, email: string, template: string, arm: string | null, when: Date) => {
        const threadId = `opplevagent-outreach-${providerId}`;
        mkThread(threadId, email);
        rfbDb.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, raw_metadata)
          VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, 'Emne', 'tekst', ?, ?)`)
          .run(`m-${providerId}`, threadId, JSON.stringify([email]), when.toISOString(),
            JSON.stringify({ source: "t", provider_id: providerId, template, ...(arm ? { subject_arm: arm } : {}) }));
      };
      const view = (path: string, createdAt: string, o: { ua?: string; owner?: number; status?: number; cls?: string } = {}) =>
        rfbDb.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, client_class, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(path, `h${Math.random().toString(36).slice(2)}:${o.ua ?? HUMAN_UA}`, o.owner ?? 0, o.status ?? 200, o.cls ?? "human", createdAt);
      const P = (s: string) => `/kategori/gardssalg/produsent/${s}`;
      const E = (s: string) => `/kategori/gardssalg/eier/${s}`;

      // Provider "alfa" (v4 first, arm A) with traffic, claim request, takeover, reply + fjern.
      mkProvider("p-alfa", "alfa", "2026-10-20 10:00:00");
      mkOut("p-alfa", "post@alfa.example.no", "personal-v4", "A", sentAt);
      view(P("alfa"), at(1));
      view(P("alfa"), at(71.9));
      view(P("alfa"), at(72.1));            // outside (after)
      view(P("alfa"), at(-1));              // outside (before the send)
      view(P("alfa"), at(2), { ua: BOT_UA, cls: "search_bot" }); // bot
      view(P("alfa"), at(2), { owner: 1 }); // owner
      view(P("alfa"), at(2), { status: 404 }); // error status
      view(E("alfa"), at(5));
      view(P("alfabet"), at(1));            // prefix neighbour — must not leak
      view(P("alfa") + "x", at(1));
      view(E("alfabet"), at(1));
      mkProvider("p-alfabet", "alfabet");
      expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, expires_at, created_at)
        VALUES ('cl1', 'p-alfa', 'post@alfa.example.no', 'brreg_contact', 'tok-a', datetime('now', '+7 days'), ?)`).run(at(30));
      rfbDb.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, subject, body_text, sent_at)
        VALUES ('in1', 'opplevagent-outreach-p-alfa', 'in', 'post@alfa.example.no', 'Re: Emne', 'Ja, fjern siden takk', ?)`).run(new Date(sentAt.getTime() + 20 * HOUR).toISOString());

      // Same-calendar-day replies stored in space format with NULL sent_at (received_at only).
      const sameDay = new Date(Date.now() - 2 * HOUR);
      const sameDayThen = new Date(sameDay.getTime() - 10 * 60 * 1000);
      mkProvider("p-eps", "eps");
      mkOut("p-eps", "post@eps.example.no", "personal-v4", "A", sameDayThen);
      rfbDb.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, subject, body_text, sent_at, received_at)
        VALUES ('in-eps', 'opplevagent-outreach-p-eps', 'in', 'post@eps.example.no', 'Re', 'Takk, ingen interesse', NULL, ?)`).run(sqlTs(sameDay));
      mkProvider("p-zeta", "zeta");
      mkOut("p-zeta", "post@zeta.example.no", "personal-v4", "B", sameDayThen);
      mkThread("other-gmail-thread", "post@zeta.example.no");
      rfbDb.prepare(`INSERT INTO crm_messages (id, thread_id, direction, from_email, subject, body_text, sent_at, received_at)
        VALUES ('in-zeta', 'other-gmail-thread', 'in', 'Post@Zeta.example.no', 'Re', 'Fjern meg', NULL, ?)`).run(sqlTs(sameDay));

      // Provider "beta" (v4 follow-up) — no activity at all.
      mkProvider("p-beta", "beta");
      mkOut("p-beta", "post@beta.example.no", "personal-v4-followup", null, sentAt);

      // Provider "gamma" — older template `personal`: excluded. Provider "delta" — v4, revoked-free test claim only + avmeld.
      mkProvider("p-gamma", "gamma");
      mkOut("p-gamma", "post@gamma.example.no", "personal", null, sentAt);
      mkProvider("p-delta", "delta");
      mkOut("p-delta", "post@delta.example.no", "personal-v4", "B", sentAt);
      expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, expires_at, created_at, is_test)
        VALUES ('cl2', 'p-delta', 'post@delta.example.no', 'brreg_contact', 'tok-d', datetime('now', '+7 days'), ?, 1)`).run(at(3));
      rfbDb.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('Post@Delta.example.no', ?, 'unsubscribe')`).run(at(4));

      const before = {
        views: (rfbDb.prepare(`SELECT COUNT(*) AS c FROM analytics_page_views`).get() as any).c,
        msgs: (rfbDb.prepare(`SELECT COUNT(*) AS c FROM crm_messages`).get() as any).c,
      };

      const unauth = await callRoute(router, {}, {});
      assertEq(unauth.status === 401 || unauth.status === 403, true, "auth: no admin key is refused");
      const wrong = await callRoute(router, {}, { "x-admin-key": "nope" });
      assertEq(wrong.status === 401 || wrong.status === 403, true, "auth: wrong admin key is refused");

      const r = await callRoute(router, {}, auth);
      assertEq(r.status, 200, "ok: status 200 with admin key");
      const bySlug = Object.fromEntries((r.body.sends as any[]).map((s) => [s.slug, s]));
      assertEq(Object.keys(bySlug).sort(), ["alfa", "beta", "delta", "eps", "zeta"], "template: only personal-v4 / -followup rows (older `personal` excluded)");

      const a = bySlug.alfa;
      assertEq([a.template, a.arm, a.window_complete], ["personal-v4", "A", true], "alfa: template, arm, window_complete");
      assertEq(a.views_profile_72h, 2, "alfa: profile views inside 72 h only (no bot/owner/404/outside, no prefix leakage)");
      assertEq(a.views_eier_72h, 1, "alfa: eier views exact slug (alfabet excluded)");
      assertEq([a.claim_link_requested, a.claimed, a.replied, a.unsubscribed], [true, true, true, true], "alfa: claim requested, claimed, replied, fjern");

      const b = bySlug.beta;
      assertEq([b.template, b.arm, b.views_profile_72h, b.views_eier_72h], ["personal-v4-followup", null, 0, 0], "beta: follow-up row with zero views");
      assertEq([b.claim_link_requested, b.claimed, b.replied, b.unsubscribed], [false, false, false, false], "beta: all flags false");

      const d = bySlug.delta;
      assertEq([d.arm, d.claim_link_requested, d.replied, d.unsubscribed], ["B", false, false, true], "delta: test claim ignored, avmeld counts as unsubscribed");

      assertEq([bySlug.eps.replied, bySlug.eps.unsubscribed], [true, false], "same-day reply (NULL sent_at, space-format received_at) counts");
      assertEq([bySlug.zeta.replied, bySlug.zeta.unsubscribed], [true, true], "same-day fjern reply from the address in another thread counts");
      assertEq(r.body.summary.first, { sends: 4, replied: 3, unsubscribed: 3, claim_link_requested: 1, claimed: 1, with_views_72h: 1 }, "summary: first sends");
      assertEq(r.body.summary.followup.sends, 1, "summary: follow-up sends");
      assertEq(r.body.summary.total_sends, 5, "summary: total");

      const short = await callRoute(router, { days: "5" }, auth);
      assertEq((short.body.sends as any[]).map((x) => x.slug).sort(), ["eps", "zeta"], "days=5: sends older than the window are left out");

      const after = {
        views: (rfbDb.prepare(`SELECT COUNT(*) AS c FROM analytics_page_views`).get() as any).c,
        msgs: (rfbDb.prepare(`SELECT COUNT(*) AS c FROM crm_messages`).get() as any).c,
      };
      assertEq(after, before, "read-only: no rows written by the endpoint");
    } finally {
      console.log = prevLog;
      console.warn = prevWarn;
      try { if (prevRfbDb) (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb); } catch { /* ignore */ }
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
      restoreModuleCache();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOutreachV4MeasurementTests({ log: true }).then((s) => {
    console.log(`${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
