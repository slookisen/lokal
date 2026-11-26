/**
 * gardssalg-owner-dashboard-o2-2.test.ts — dev-request 2026-11-12-opplevagent-
 * o2-eierdashbord-for-besok, slice O2-2: «Mine besøk» wired to a page.
 *
 *   AK1  two profiles with requests: owner A sees only A's requests (and B
 *        only B's); a POST by A on B's request → 404 and nothing written.
 *   AK2  every action (bekreft, foresla, avsla, møtte, møtte ikke) changes the
 *        status as expected, and is refused with nothing written on a row in
 *        the wrong state (attendance on an unconfirmed / declined / expired /
 *        not-yet-started visit, confirm on a declined / suggested / expired
 *        request, a second answer, an invalid suggested time, …).
 *   AK3  the forms are accepted with `Origin: null` (a browser under
 *        `Referrer-Policy: no-referrer`); a foreign Origin and Sec-Fetch-Site
 *        cross-site are refused (403) as on the RFB owner pages.
 *   (f)  flag off → GET and POST 404, the POST exactly as before (falls
 *        through); pilot with a profile off the list → 404 (a real producer
 *        off the list too); O2-5: a real (non-test) producer on the list
 *        with its own session sees and answers its own requests, never
 *        another real producer's; no session → 401; another producer's
 *        session → 403. `no-store` on every response; a GET writes nothing.
 *   (t)  texts from tekstpakke OA-3 1.2 verbatim; no «Avlys» (O1-5); plain
 *        POST forms without JavaScript; no price, product or strength.
 *
 * Exported runGardssalgOwnerDashboardO22Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/gardssalg-owner-dashboard-o2-2.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_OWNER_DASHBOARD_ENABLED";
const HOUR = 3600_000;

export function runGardssalgOwnerDashboardO22Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED", "WRITE_GUARD_FETCH_METADATA", FLAG];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[FLAG];
    delete process.env.WRITE_GUARD_FETCH_METADATA;
    process.env.OA_OWNER_FEATURES_ENABLED = "1";
    const ALLOW = "gardssalg:o22-a,gardssalg:o22-b,gardssalg:o22-real,gardssalg:o22-real2";
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
    const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
    const prevSendEmail = emailSvc.sendEmail;
    const sent: Array<{ to: string; subject: string }> = [];
    emailSvc.sendEmail = async (o: any) => {
      sent.push({ to: o.to, subject: o.subject });
      return { success: true, messageId: "stub" };
    };

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
      const store = require("../services/booking-store") as typeof import("../services/booking-store");
      const besokMod = require("../owner-features/gardssalg-mine-besok") as typeof import("../owner-features/gardssalg-mine-besok");
      const T = besokMod.GARDSSALG_VISITS_TEXTS;

      // ── fixtures ──────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @hjemmeside, @epost, 'claim', '[]',
           'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 1, @is_test_provider, '2026-11-01 10:00:00')
      `);
      const mkProvider = (id: string, navn: string, slug: string, org: string, isTest: number | null = 1) =>
        insertProvider.run({ id, navn, slug, org_nr: org, hjemmeside: `https://${slug}.example.no`, epost: `besok@${slug}.example.no`, is_test_provider: isTest });
      mkProvider("o22-a", "Testgård A", "o22agard", "918200001");
      mkProvider("o22-b", "Testgård B", "o22bgard", "918200002");
      mkProvider("o22-c", "Testgård C", "o22cgard", "918200003"); // test producer, NOT on the list
      mkProvider("o22-real", "Ekte Gård", "o22ektegard", "918200004", null); // on the list, not the test producer
      mkProvider("o22-real2", "Andre Ekte Gård", "o22andreekte", "918200006", 0); // on the list, real
      mkProvider("o22-real3", "Tredje Ekte Gård", "o22tredjeekte", "918200007", 0); // real, NOT on the list
      const claimRow = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, ?, ?, 'verified_domain_address', ?, 1, datetime('now'), datetime('now','+7 days'))`,
      );
      for (const pid of ["o22-a", "o22-b", "o22-c", "o22-real", "o22-real2", "o22-real3"]) claimRow.run(`gsc_${pid}`, pid, `eier@${pid}.example.no`, `tok22-${pid}`);

      const now = Date.now();
      const iso = (offsetHours: number) => new Date(now + offsetHours * HOUR).toISOString();
      const insertBooking = expDb.prepare(`
        INSERT INTO gardssalg_bookings
          (booking_id, provider_id, slot_at, party_size, guest_name, guest_email, guest_phone, booking_ref, confirm_token, source,
           status, billable, notes, pre_status, respond_token, respond_token_expires_at, respond_token_used_at,
           suggested_slot_at, guest_decision_token, guest_status_token)
        VALUES
          (@booking_id, @provider_id, @slot_at, @party_size, @guest_name, @guest_email, @guest_phone, @booking_ref, @confirm_token, 'web',
           @status, @billable, @notes, @pre_status, @respond_token, @respond_token_expires_at, @respond_token_used_at,
           @suggested_slot_at, @guest_decision_token, @guest_status_token)
      `);
      const mkBooking = (ref: string, provider: string, over: Record<string, unknown> = {}) =>
        insertBooking.run({
          booking_id: `bid-${ref}`, provider_id: provider, slot_at: iso(48), party_size: 2,
          guest_name: `Gjest ${ref}`, guest_email: `${ref.toLowerCase()}@gjest.example.no`, guest_phone: null,
          booking_ref: ref, confirm_token: `ctok-${ref}`, status: "reserved", billable: 0, notes: null,
          pre_status: "awaiting_provider", respond_token: `rtok-${ref}`, respond_token_expires_at: iso(24),
          respond_token_used_at: null, suggested_slot_at: null, guest_decision_token: null, guest_status_token: `gtok-${ref}`,
          ...over,
        });
      // Profile A
      mkBooking("GS-A-PEND", "o22-a", { notes: "Vi kommer på sykkel", party_size: 1 });
      mkBooking("GS-A-DECL", "o22-a");
      mkBooking("GS-A-SUGG", "o22-a");
      mkBooking("GS-A-ORIG", "o22-a"); // AK3
      mkBooking("GS-A-CPAST1", "o22-a", { slot_at: iso(-2), pre_status: "provider_confirmed", respond_token_used_at: iso(-30) });
      mkBooking("GS-A-CPAST2", "o22-a", { slot_at: iso(-3), pre_status: "provider_confirmed", respond_token_used_at: iso(-30) });
      mkBooking("GS-A-CFUT", "o22-a", { slot_at: iso(30), pre_status: "provider_confirmed", respond_token_used_at: iso(-1) });
      mkBooking("GS-A-DPAST", "o22-a", { slot_at: iso(-2), pre_status: "provider_declined", respond_token_used_at: iso(-30) });
      mkBooking("GS-A-EPAST", "o22-a", { slot_at: iso(-2), pre_status: "expired" });
      mkBooking("GS-A-PPAST", "o22-a", { slot_at: iso(-2), respond_token_expires_at: iso(5) });
      mkBooking("GS-A-DFUT", "o22-a", { pre_status: "provider_declined", respond_token_used_at: iso(-1) });
      mkBooking("GS-A-TOKEXP", "o22-a", { respond_token_expires_at: iso(-1) });
      mkBooking("GS-A-DONE", "o22-a", { slot_at: iso(-50), status: "confirmed_attended", billable: 1, pre_status: "provider_confirmed", respond_token_used_at: iso(-70) });
      // Profile B
      mkBooking("GS-B-PEND", "o22-b");
      mkBooking("GS-B-CPAST", "o22-b", { slot_at: iso(-2), pre_status: "provider_confirmed", respond_token_used_at: iso(-30) });
      // Profile C (off the list) and the real producer
      mkBooking("GS-C-PEND", "o22-c");
      mkBooking("GS-R-PEND", "o22-real");
      mkBooking("GS-R2-PEND", "o22-real2");
      mkBooking("GS-R3-PEND", "o22-real3");

      const row = (ref: string) => expDb.prepare(`SELECT * FROM gardssalg_bookings WHERE booking_ref = ?`).get(ref) as any;
      const changes = () => [(expDb.prepare("SELECT total_changes() AS n").get() as any).n, (rfbDb.prepare("SELECT total_changes() AS n").get() as any).n];

      // ── HTTP wiring ───────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const app = expressMod();
      app.use("/", claimRouter);
      app.use((_req, res) => { res.status(404).type("text/plain").send("fallthrough-404"); });
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      type Resp = { status: number; headers: any; body: string };
      const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<Resp>((resolve, reject) => {
          const h: Record<string, string | number> = { ...headers };
          if (body !== undefined) {
            h["Content-Type"] = "application/x-www-form-urlencoded";
            h["Content-Length"] = Buffer.byteLength(body);
          }
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers: h }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body !== undefined) r.write(body);
          r.end();
        });
      const cookie = (pid: string) => ({ Cookie: `oa_owner_session=tok22-${pid}` });
      // What a browser sends on a same-page form POST under Referrer-Policy: no-referrer.
      const browserForm = { Origin: "null", "Sec-Fetch-Site": "same-origin" };
      const page = (slug: string) => `/kategori/gardssalg/eier/${slug}/besok`;
      const action = (slug: string) => `/kategori/gardssalg/eier/${slug}/besok/handling`;
      const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
      const post = (slug: string, pid: string, f: Record<string, string>, extra: Record<string, string> = browserForm) =>
        request("POST", action(slug), { ...cookie(pid), ...extra }, form(f));
      const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };
      const meldingOf = (r: Resp) => {
        const loc = String(r.headers.location || "");
        const m = /[?&]melding=([^&#]+)/.exec(loc);
        return m ? decodeURIComponent(m[1]) : null;
      };
      const follow = async (r: Resp, pid: string) => request("GET", String(r.headers.location || ""), cookie(pid));
      const unescape = (s: string) => s.replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

      /** POST an action, expect 303 + melding, and (when `write` is false) that nothing was written. */
      const act = async (label: string, ref: string, f: Record<string, string>, expectMelding: string, write: boolean, pid = "o22-a", slug = "o22agard") => {
        const before = JSON.stringify(row(ref));
        const ch = changes();
        const r = await post(slug, pid, { ref, ...f });
        assertEq(r.status, 303, `${label}: 303 (PRG)`);
        assertEq(meldingOf(r), expectMelding, `${label}: melding=${expectMelding}`);
        assertTrue(String(r.headers.location || "").startsWith(`/kategori/gardssalg/eier/${slug}/besok?`), `${label}: back to «Mine besøk»`);
        assertEq(r.headers["cache-control"], "no-store", `${label}: no-store`);
        if (!write) {
          assertEq(JSON.stringify(row(ref)), before, `${label}: the row is unchanged`);
          assertEq(changes(), ch, `${label}: nothing written (both databases)`);
        }
        return r;
      };

      // ── (f) flag off: GET and POST 404, nothing written ───────────────
      setFlag(undefined);
      {
        const ch = changes();
        const g = await request("GET", page("o22agard"), cookie("o22-a"));
        assertEq(g.status, 404, "f1: flag off → GET «Mine besøk» 404");
        const p = await post("o22agard", "o22-a", { ref: "GS-A-PEND", action: "bekreft" });
        assertEq(p.status, 404, "f2: flag off → POST …/besok/handling 404");
        assertEq(p.body, "fallthrough-404", "f3: flag off → the POST falls through exactly as before (no route of its own)");
        const other = await request("POST", "/kategori/gardssalg/eier/o22agard/besok/finnesikke", { ...cookie("o22-a"), ...browserForm }, form({ ref: "GS-A-PEND", action: "bekreft" }));
        assertEq([p.status, p.body], [other.status, other.body], "f4: flag off → same answer as a path that never existed");
        for (const v of ["0", "off", "Pilot", "pilot "]) {
          setFlag(v);
          assertEq((await post("o22agard", "o22-a", { ref: "GS-A-PEND", action: "bekreft" })).status, 404, `f5: flag ${JSON.stringify(v)} → POST 404`);
        }
        assertEq(row("GS-A-PEND").pre_status, "awaiting_provider", "f6: flag off → the request is still unanswered");
        assertEq(changes(), ch, "f7: flag off → nothing written");
        assertEq(sent.length, 0, "f8: flag off → no e-mail");
      }

      setFlag("pilot");

      // ── (f) gates in pilot ─────────────────────────────────────────────
      {
        const ch = changes();
        const offList = await post("o22cgard", "o22-c", { ref: "GS-C-PEND", action: "bekreft" });
        assertEq(offList.status, 404, "f9: pilot, profile off the list → POST 404");
        assertEq(offList.headers["cache-control"], "no-store", "f10: that 404 is no-store");
        assertEq((await request("GET", page("o22cgard"), cookie("o22-c"))).status, 404, "f11: pilot, profile off the list → GET 404");
        // O2-5: the test-producer lock is gone. A real producer on the list
        // opens its own «Mine besøk» (it answers its own request further down).
        const realOwn = await request("GET", page("o22ektegard"), cookie("o22-real"));
        assertEq([realOwn.status, realOwn.headers["cache-control"]], [200, "no-store"], "f12: O2-5 — real producer on the list, own session → GET 200 no-store");
        assertEq([...realOwn.body.matchAll(/data-booking-ref="([^"]+)"/g)].map((m) => m[1]), ["GS-R-PEND"], "f12b: O2-5 — the real producer's page lists exactly its own request");
        assertTrue(!realOwn.body.includes("GS-R2-") && !realOwn.body.includes("GS-A-") && !realOwn.body.includes("Gjest GS-R2"), "f12c: O2-5 — nothing of another producer's on the real producer's page");
        // Cross-owner between two real producers on the list.
        assertEq((await request("GET", page("o22andreekte"), cookie("o22-real"))).status, 403, "f12d: O2-5 — real A's session on real B's «Mine besøk» → GET 403");
        assertEq((await post("o22andreekte", "o22-real", { ref: "GS-R2-PEND", action: "bekreft" })).status, 403, "f12e: O2-5 — real A's session posting on real B's page → 403");
        assertEq((await post("o22ektegard", "o22-real", { ref: "GS-R2-PEND", action: "bekreft" })).status, 404, "f12f: O2-5 — real A posts B's request through A's own page → 404");
        assertEq((await post("o22ektegard", "o22-real2", { ref: "GS-R-PEND", action: "bekreft" })).status, 403, "f12g: O2-5 — real B's session on real A's page → 403");
        // A real producer off the list stays out.
        assertEq((await request("GET", page("o22tredjeekte"), cookie("o22-real3"))).status, 404, "f12h: O2-5 — pilot, real producer off the list → GET 404");
        assertEq((await post("o22tredjeekte", "o22-real3", { ref: "GS-R3-PEND", action: "bekreft" })).status, 404, "f12i: O2-5 — pilot, real producer off the list → POST 404");
        const noSession = await request("POST", action("o22agard"), browserForm, form({ ref: "GS-A-PEND", action: "bekreft" }));
        assertEq(noSession.status, 401, "f13: no session → POST 401");
        assertEq(noSession.headers["cache-control"], "no-store", "f14: that 401 is no-store");
        assertEq((await post("o22agard", "o22-b", { ref: "GS-A-PEND", action: "bekreft" })).status, 403, "f15: B's session on A's page → POST 403");
        assertEq((await post("o22agard", "o22-a", { ref: "GS-FINNES-IKKE", action: "bekreft" })).status, 404, "f16: unknown request → 404");
        assertEq((await post("o22agard", "o22-a", { action: "bekreft" })).status, 404, "f17: no ref → 404");
        assertEq([row("GS-C-PEND").pre_status, row("GS-R-PEND").pre_status, row("GS-R2-PEND").pre_status, row("GS-R3-PEND").pre_status, row("GS-A-PEND").pre_status], ["awaiting_provider", "awaiting_provider", "awaiting_provider", "awaiting_provider", "awaiting_provider"], "f18: refused POSTs changed no status");
        assertEq(changes(), ch, "f19: refused POSTs wrote nothing");
      }

      // ── AK1: each owner sees only their own requests ───────────────────
      {
        const a = await request("GET", page("o22agard"), cookie("o22-a"));
        const b = await request("GET", page("o22bgard"), cookie("o22-b"));
        assertEq([a.status, b.status], [200, 200], "AK1a: both owners open «Mine besøk» (200)");
        assertEq([a.headers["cache-control"], b.headers["cache-control"]], ["no-store", "no-store"], "AK1b: no-store");
        const refsIn = (html: string) => [...html.matchAll(/data-booking-ref="([^"]+)"/g)].map((m) => m[1]).sort();
        assertEq(refsIn(a.body), ["GS-A-CFUT", "GS-A-CPAST1", "GS-A-CPAST2", "GS-A-DECL", "GS-A-DFUT", "GS-A-DONE", "GS-A-DPAST", "GS-A-EPAST", "GS-A-ORIG", "GS-A-PEND", "GS-A-PPAST", "GS-A-SUGG", "GS-A-TOKEXP"], "AK1c: A's page lists exactly A's requests");
        assertEq(refsIn(b.body), ["GS-B-CPAST", "GS-B-PEND"], "AK1d: B's page lists exactly B's requests");
        assertTrue(!a.body.includes("GS-B-") && !a.body.includes("gjest.example.no\">gs-b") && !a.body.includes("Gjest GS-B"), "AK1e: nothing of B's on A's page");
        assertTrue(!b.body.includes("GS-A-") && !b.body.includes("Gjest GS-A"), "AK1f: nothing of A's on B's page");
        // A acts on B's request through A's own page → 404, nothing written.
        for (const [ref, f] of [["GS-B-PEND", { action: "bekreft" }], ["GS-B-PEND", { action: "avsla" }], ["GS-B-CPAST", { action: "attended" }]] as const) {
          const before = JSON.stringify(row(ref));
          const ch = changes();
          const r = await post("o22agard", "o22-a", { ref, ...f });
          assertEq(r.status, 404, `AK1g: A posts ${f.action} on B's ${ref} → 404`);
          assertEq(JSON.stringify(row(ref)), before, `AK1h: B's ${ref} unchanged after A's ${f.action}`);
          assertEq(changes(), ch, `AK1i: A's ${f.action} on B's request wrote nothing`);
        }
        assertEq(sent.length, 0, "AK1j: no e-mail from the refused POSTs");
        // The page's forms post to the owner's own action route with the ref.
        assertTrue(a.body.includes(`action="${action("o22agard")}"`) && !a.body.includes("/kategori/gardssalg/svar/") && !a.body.includes("/kategori/gardssalg/bekreft/"), "AK1k: forms post to the dashboard route (no token links on the page)");
        assertTrue(!a.body.includes("rtok-") && !a.body.includes("ctok-") && !a.body.includes("gtok-"), "AK1l: no token of any kind on the page");
      }

      // ── page content (t) ───────────────────────────────────────────────
      {
        const a = (await request("GET", page("o22agard"), cookie("o22-a"))).body;
        const card = (ref: string) => {
          const i = a.indexOf(`data-booking-ref="${ref}"`);
          return i < 0 ? "" : a.slice(i, a.indexOf("</li>", i));
        };
        const sectionOf = (id: string) => {
          const i = a.indexOf(`id="${id}"`);
          return i < 0 ? "" : a.slice(i, a.indexOf("</section>", i));
        };
        assertTrue(a.includes(`>${T["visits.section.waiting"]}</h2>`) && a.includes(`>${T["visits.section.upcoming"]}</h2>`) && a.includes(`>${T["visits.section.past"]}</h2>`), "t1: the three sections (OA-3 visits.section.*)");
        assertTrue(sectionOf("besok-venter").includes("GS-A-PEND") && sectionOf("besok-venter").includes("GS-A-PPAST") && !sectionOf("besok-venter").includes("GS-A-TOKEXP"), "t2: waiting = still answerable requests");
        assertTrue(sectionOf("besok-kommende").includes("GS-A-CFUT") && !sectionOf("besok-kommende").includes("GS-A-DFUT"), "t3: upcoming = confirmed visits ahead (a declined one is not)");
        assertTrue(sectionOf("besok-tidligere").includes("GS-A-DONE") && sectionOf("besok-tidligere").includes("GS-A-DFUT"), "t4: the rest under «Tidligere»");
        assertTrue(sectionOf("besok-venter").includes(T["visits.expiryNote"]), "t5: visits.expiryNote in the waiting section");
        const pend = card("GS-A-PEND");
        assertTrue(pend.includes(`<strong>${T["visits.status.pending"]}</strong>`), "t6: status «Venter på svar»");
        assertTrue(pend.includes("Svarfrist: "), "t7: visits.deadline on a waiting request");
        assertTrue(pend.includes("Gjest GS-A-PEND, 1 person<"), "t8: guest line, singular");
        assertTrue(card("GS-A-DECL").includes("Gjest GS-A-DECL, 2 personer<"), "t9: visits.guestLine verbatim");
        assertTrue(pend.includes(`${T["visits.noteLabel"]}: Vi kommer på sykkel`), "t10: the guest's comment with visits.noteLabel");
        for (const label of [T["visits.action.confirm"], T["visits.action.suggest"], T["visits.action.decline"], T["visits.suggest.label"], T["visits.suggest.submit"], T["visits.decline.submit"]]) {
          assertTrue(pend.includes(`>${label}<`), `t11: the waiting card has «${label}»`);
        }
        assertTrue(unescape(pend).includes(T["visits.decline.confirm"]), "t12: «Avslå» asks first (visits.decline.confirm), no reason field");
        assertTrue(!/name="(reason|grunn)"/.test(a), "t13: no reason field anywhere");
        const cp = card("GS-A-CPAST1");
        assertTrue(cp.includes(`>${T["visits.action.attended"]}<`) && cp.includes(`>${T["visits.action.noShow"]}<`), "t14: a confirmed past visit has «Møtte» / «Møtte ikke»");
        assertTrue(!card("GS-A-DPAST").includes("<form") && !card("GS-A-EPAST").includes("<form") && !card("GS-A-CFUT").includes("<form"), "t15: no forms on declined / expired / not-yet-started rows");
        assertTrue(card("GS-A-DONE").includes(`<strong>${T["visits.status.attended"]}</strong>`) && card("GS-A-TOKEXP").includes(`<strong>${T["visits.status.expired"]}</strong>`) && card("GS-A-DPAST").includes(`<strong>${T["visits.status.declined"]}</strong>`), "t16: status texts from OA-3");
        assertTrue(!/avlys/i.test(a.replace(/<style>[\s\S]*?<\/style>/g, "")), "t17: no «Avlys» (O1-5 not built)");
        assertTrue(!/<script/i.test(a.slice(a.indexOf('data-owner-tab="mine-besok"'))) && !/\son[a-z]+=/i.test(a.slice(a.indexOf('data-owner-tab="mine-besok"'))), "t18: no script, no inline handlers in «Mine besøk»");
        const forms = [...a.matchAll(/<form [^>]*>/g)].map((m) => m[0]);
        assertTrue(forms.length > 0 && forms.every((f) => /method="post"/.test(f)), "t19: every form is a plain POST");
        const visible = a.slice(a.indexOf('data-owner-tab="mine-besok"')).replace(/<style>[\s\S]*?<\/style>/g, "");
        assertTrue(!/\bkr\b|%|vol\.|alkohol|smaking|gratis/i.test(visible), "t20: no price, strength, drink or «gratis»");
        assertTrue(!/rett fra bonden/i.test(a), "t21: never names Rett fra Bonden");
        assertTrue(a.includes('aria-current="page">Mine besøk<'), "t22: inside the dashboard shell, on its own tab");
      }

      // ── AK2: the actions, and refusals on rows in the wrong state ──────
      {
        // bekreft
        let r = await act("AK2a bekreft", "GS-A-PEND", { action: "bekreft" }, "bekreftet", true);
        assertEq(row("GS-A-PEND").pre_status, "provider_confirmed", "AK2a: awaiting_provider → provider_confirmed");
        assertTrue(!!row("GS-A-PEND").respond_token_used_at, "AK2a: answer consumed");
        assertTrue((await follow(r, "o22-a")).body.includes(T["visits.confirm.done"]), "AK2a: visits.confirm.done after PRG");
        assertEq(sent.map((s) => s.to), ["gs-a-pend@gjest.example.no"], "AK2a: the guest got the same confirm e-mail as the e-mail link sends");
        r = await act("AK2b bekreft twice", "GS-A-PEND", { action: "bekreft" }, "feil_tilstand", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Dette går ikke, fordi forespørselen er bekreftet."), "AK2b: visits.wrongState with the status");

        // avsla
        r = await act("AK2c avsla", "GS-A-DECL", { action: "avsla" }, "avslatt", true);
        assertEq(row("GS-A-DECL").pre_status, "provider_declined", "AK2c: awaiting_provider → provider_declined");
        assertTrue((await follow(r, "o22-a")).body.includes(T["visits.decline.done"]), "AK2c: visits.decline.done");
        assertEq(sent.length, 2, "AK2c: the guest got the decline e-mail");
        r = await act("AK2d bekreft on declined", "GS-A-DFUT", { action: "bekreft" }, "feil_tilstand", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Dette går ikke, fordi forespørselen er avslått."), "AK2d: «… er avslått.»");
        await act("AK2e avsla on declined", "GS-A-DFUT", { action: "avsla" }, "feil_tilstand", false);

        // foresla
        const osloLocal = (offsetHours: number) => {
          const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
          }).formatToParts(new Date(now + offsetHours * HOUR)).map((x) => [x.type, x.value]));
          return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
        };
        r = await act("AK2f foresla in the past", "GS-A-SUGG", { action: "foresla", suggested_slot: osloLocal(-5) }, "ugyldig_tid", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Ugyldig tidspunkt — velg et tidspunkt frem i tid."), "AK2f: the svar page's invalid-time text");
        await act("AK2g foresla garbage", "GS-A-SUGG", { action: "foresla", suggested_slot: "i morgen" }, "ugyldig_tid", false);
        r = await act("AK2h foresla", "GS-A-SUGG", { action: "foresla", suggested_slot: osloLocal(96) }, "foreslatt", true);
        const sg = row("GS-A-SUGG");
        assertEq(sg.pre_status, "time_suggested", "AK2h: awaiting_provider → time_suggested");
        assertTrue(!!sg.suggested_slot_at && !!sg.guest_decision_token, "AK2h: suggested time and guest decision token stored");
        assertTrue(new Date(sg.respond_token_expires_at).getTime() >= now + 47.9 * HOUR, "AK2h: O1-4 — the deadline moves to 48 h after the suggestion");
        assertTrue((await follow(r, "o22-a")).body.includes(T["visits.suggest.done"]), "AK2h: visits.suggest.done");
        assertEq(sent.length, 3, "AK2h: the guest got the suggestion e-mail");
        const sgPage = (await request("GET", page("o22agard"), cookie("o22-a"))).body;
        const sgCard = sgPage.slice(sgPage.indexOf('data-booking-ref="GS-A-SUGG"'), sgPage.indexOf("</li>", sgPage.indexOf('data-booking-ref="GS-A-SUGG"')));
        assertTrue(sgCard.includes(`<strong>${T["visits.status.suggested"]}</strong>`) && sgCard.includes(`${T["visits.suggest.label"]}: `), "AK2h: the card shows the suggestion");
        r = await act("AK2i bekreft on a suggestion", "GS-A-SUGG", { action: "bekreft" }, "feil_tilstand", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Dette går ikke, fordi forespørselen er "), "AK2i: wrongState");
        await act("AK2j bekreft on an expired request", "GS-A-TOKEXP", { action: "bekreft" }, "feil_tilstand", false);
        await act("AK2k foresla on an expired request", "GS-A-TOKEXP", { action: "foresla", suggested_slot: osloLocal(96) }, "feil_tilstand", false);
        await act("AK2l avsla on a confirmed request", "GS-A-CFUT", { action: "avsla" }, "feil_tilstand", false);

        // attendance
        r = await act("AK2m møtte", "GS-A-CPAST1", { action: "attended" }, "oppmote", true);
        assertEq([row("GS-A-CPAST1").status, row("GS-A-CPAST1").billable, row("GS-A-CPAST1").resolved_by], ["confirmed_attended", 1, "eier-dashbord"], "AK2m: reserved → confirmed_attended (billable 1)");
        assertTrue((await follow(r, "o22-a")).body.includes(T["visits.attended.done"]), "AK2m: visits.attended.done");
        await act("AK2n møtte ikke", "GS-A-CPAST2", { action: "no_show" }, "oppmote", true);
        assertEq([row("GS-A-CPAST2").status, row("GS-A-CPAST2").billable], ["no_show", 0], "AK2n: reserved → no_show (billable 0)");
        await act("AK2o møtte twice", "GS-A-CPAST1", { action: "no_show" }, "feil_tilstand", false);
        await act("AK2p møtte on an already registered visit", "GS-A-DONE", { action: "attended" }, "feil_tilstand", false);
        r = await act("AK2q møtte before the visit", "GS-A-CFUT", { action: "attended" }, "for_tidlig", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Oppmøte kan først registreres etter besøkstidspunktet."), "AK2q: the too-early text");
        r = await act("AK2r møtte on a declined request", "GS-A-DPAST", { action: "attended" }, "ikke_bekreftet", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er avslått."), "AK2r: OA-1 attendance.notConfirmed (avslått)");
        r = await act("AK2s møtte ikke on an expired request", "GS-A-EPAST", { action: "no_show" }, "ikke_bekreftet", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Denne forespørselen er utløpt."), "AK2s: … er utløpt");
        r = await act("AK2t møtte on an unanswered request", "GS-A-PPAST", { action: "attended" }, "ikke_bekreftet", false);
        assertTrue(unescape((await follow(r, "o22-a")).body).includes("Denne forespørselen er ikke bekreftet ennå."), "AK2t: … ikke bekreftet ennå");
        assertEq(row("GS-A-DPAST").billable, 0, "AK2u: billable untouched on refused attendance");
        await act("AK2v unknown action", "GS-A-PPAST", { action: "avlys" }, "ugyldig", false);
        await act("AK2w no action", "GS-A-PPAST", {}, "ugyldig", false);
        assertEq(sent.length, 3, "AK2x: refused actions send no e-mail");
      }

      // ── AK3: Origin null accepted; foreign origin refused ─────────────
      {
        const ref = "GS-A-ORIG";
        const refused = async (label: string, headers: Record<string, string>) => {
          const before = JSON.stringify(row(ref));
          const ch = changes();
          const r = await post("o22agard", "o22-a", { ref, action: "bekreft" }, headers);
          assertEq(r.status, 403, `${label}: 403`);
          assertTrue(r.body.includes("Endringen ble ikke lagret") && r.body.includes("Tilbake til Mine besøk"), `${label}: the shared refusal page, back to «Mine besøk»`);
          assertEq(r.headers["cache-control"], "no-store", `${label}: no-store`);
          assertEq(JSON.stringify(row(ref)), before, `${label}: row unchanged`);
          assertEq(changes(), ch, `${label}: nothing written`);
        };
        await refused("AK3a foreign Origin", { Origin: "https://evil.example" });
        await refused("AK3b Sec-Fetch-Site cross-site", { "Sec-Fetch-Site": "cross-site", Origin: "null" });
        await refused("AK3c Sec-Fetch-Site same-site", { "Sec-Fetch-Site": "same-site" });
        await refused("AK3d unparseable Origin", { Origin: "not a url" });
        const ok = await post("o22agard", "o22-a", { ref, action: "bekreft" }, { Origin: "null", "Sec-Fetch-Site": "same-origin" });
        assertEq([ok.status, meldingOf(ok)], [303, "bekreftet"], "AK3e: Origin: null (no-referrer form POST) → accepted");
        assertEq(row(ref).pre_status, "provider_confirmed", "AK3f: … and the request is confirmed");
        const ok2 = await post("o22agard", "o22-a", { ref: "GS-B-PEND", action: "bekreft" }, { Origin: "null" });
        assertEq(ok2.status, 404, "AK3g: Origin null does not bypass ownership (B's request via A → 404)");
        // Same-origin Origin and no Origin are accepted too (no write needed to show it: wrong state answers 303).
        const same = await post("o22agard", "o22-a", { ref, action: "bekreft" }, { Origin: `http://127.0.0.1:${port}` });
        assertEq([same.status, meldingOf(same)], [303, "feil_tilstand"], "AK3h: same-origin Origin passes the guard");
        const none = await post("o22agard", "o22-a", { ref, action: "bekreft" }, {});
        assertEq([none.status, meldingOf(none)], [303, "feil_tilstand"], "AK3i: no Origin passes the guard");
      }

      // ── B can act on B's own request ───────────────────────────────────
      await act("AK1m B confirms its own", "GS-B-PEND", { action: "bekreft" }, "bekreftet", true, "o22-b", "o22bgard");
      assertEq(row("GS-B-PEND").pre_status, "provider_confirmed", "AK1m: B's own request confirmed");

      // ── O2-5: a real (non-test) producer on the list acts on its own ───
      await act("R1 real producer confirms its own", "GS-R-PEND", { action: "bekreft" }, "bekreftet", true, "o22-real", "o22ektegard");
      assertEq(row("GS-R-PEND").pre_status, "provider_confirmed", "R1: O2-5 — the real producer's own request confirmed");
      assertEq(row("GS-R2-PEND").pre_status, "awaiting_provider", "R2: O2-5 — the other real producer's request untouched");

      // ── GET writes nothing (with every message variant) ───────────────
      {
        const ch = changes();
        const rows = JSON.stringify(expDb.prepare("SELECT * FROM gardssalg_bookings ORDER BY booking_ref").all());
        for (const q of ["", "?melding=bekreftet", "?melding=feil_tilstand&ref=GS-A-PEND", "?melding=ikke_bekreftet&ref=GS-A-DPAST", "?melding=feil_tilstand&ref=GS-B-PEND", "?melding=x"]) {
          const r = await request("GET", page("o22agard") + q, cookie("o22-a"));
          assertEq([r.status, r.headers["cache-control"]], [200, "no-store"], `g1: GET ${q || "(plain)"} → 200 no-store`);
          if (q.includes("GS-B-PEND")) assertTrue(!r.body.includes("Dette går ikke"), "g2: a message never reads another producer's request");
        }
        assertEq(changes(), ch, "g3: the GETs wrote nothing (both databases)");
        assertEq(JSON.stringify(expDb.prepare("SELECT * FROM gardssalg_bookings ORDER BY booking_ref").all()), rows, "g4: rows unchanged by the GETs");
      }

      // ── no request at all → the O2-1 empty state ───────────────────────
      {
        const c = await request("GET", page("o22cgard"), cookie("o22-c"));
        assertEq(c.status, 404, "e0: (profile C stays off the list)");
        process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW + ",gardssalg:o22-empty";
        mkProvider("o22-empty", "Tom Gård", "o22tomgard", "918200005");
        claimRow.run("gsc_o22-empty", "o22-empty", "eier@o22-empty.example.no", "tok22-o22-empty");
        const e = await request("GET", page("o22tomgard"), cookie("o22-empty"));
        assertTrue(e.status === 200 && e.body.includes('data-state="none"') && !e.body.includes("data-booking-ref"), "e1: no request → the empty state");
        process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;
      }

      // ── renderer unit: the module's own text table is OA-3 verbatim ────
      assertEq(T["visits.wrongState"], "Dette går ikke, fordi forespørselen er {status}.", "u1: wrongState verbatim");
      assertEq(T["visits.decline.confirm"], "Vil du avslå forespørselen? Gjesten får e-post med en gang.", "u2: decline.confirm verbatim");
      assertTrue(!("visits.action.cancel" in T), "u3: no cancel text wired (O1-5)");
      assertEq(typeof store.listProviderBookings, "function", "u4: listProviderBookings exported");
      assertEq(store.listProviderBookings("o22-b").map((b) => b.booking_ref).sort(), ["GS-B-CPAST", "GS-B-PEND"], "u5: listProviderBookings is scoped to the provider");
    } catch (e: any) {
      failed++;
      failures.push(`unexpected error: ${e?.stack || e}`);
    } finally {
      emailSvc.sendEmail = prevSendEmail;
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

if (require.main === module) {
  runGardssalgOwnerDashboardO22Tests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
