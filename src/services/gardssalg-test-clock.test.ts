/**
 * gardssalg-test-clock.test.ts — O1-7 (dev-request
 * 2026-11-12-opplevagent-o1-trygg-aa-aapne): a test-only clock so «Møtte» /
 * «Ikke møtt» can be tried before the visit time.
 *
 * Covers:
 *   (c) gardssalgNow(): real time without an override; setter and
 *       GARDSSALG_TEST_NOW move it in test; the setter wins over the env var;
 *       an invalid override is ignored.
 *   (p) AK1: with NODE_ENV=production (or FLY_APP_NAME set) the override has
 *       no effect — real time, visitTimeReached() stays closed.
 *   (r) route: POST /kategori/gardssalg/bekreft/:token on a confirmed visit
 *       in the future → ?error=too_early without override; with the override
 *       past the slot the bekreft page offers «Møtte» and the POST resolves;
 *       under NODE_ENV=production the same override still gives too_early.
 *
 * Fixtures: in-memory experiences DB, example.no addresses, e-mail stubbed.
 * process.env (NODE_ENV, FLY_APP_NAME, GARDSSALG_TEST_NOW, …) is restored in
 * finally, the in-process override is cleared.
 *
 * Standalone: npx tsx src/services/gardssalg-test-clock.test.ts
 * Gate: tests/test.ts imports runGardssalgTestClockTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HOUR = 3600_000;

/** Plain node:http request (global fetch may be stubbed by other test blocks). */
function httpReq(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const rq = http.request(url, { method: opts.method || "GET", headers: opts.headers }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c) => chunks.push(c as Buffer));
      resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    rq.on("error", reject);
    if (opts.body) rq.write(opts.body);
    rq.end();
  });
}

export function runGardssalgTestClockTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  };
  const assertTrue = (c: boolean, label: string): void => assertEq(!!c, true, label);

  return (async () => {
    const envKeys = ["NODE_ENV", "FLY_APP_NAME", "GARDSSALG_TEST_NOW", "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.NODE_ENV = "test";
    delete process.env.FLY_APP_NAME;
    delete process.env.GARDSSALG_TEST_NOW;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-attendance-guard"),
      require.resolve("../routes/experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const clock = require("./gardssalg-test-clock") as typeof import("./gardssalg-test-clock");
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    let server: http.Server | null = null;

    try {
      const store = require("./booking-store") as typeof import("./booking-store");
      const near = (d: Date, label: string) => assertTrue(Math.abs(d.getTime() - Date.now()) < 5_000, label);
      const FUTURE = "2099-06-01T12:00:00.000Z";
      const slot = { slot_at: "2099-06-01T10:00" };

      // ── (c) clock in test ───────────────────────────────────────────────
      near(clock.gardssalgNow(), "c1: no override -> real time");
      assertEq(store.visitTimeReached(slot), false, "c2: no override -> visit in 2099 not reached");
      clock.__setGardssalgTestNow(FUTURE);
      assertEq(clock.gardssalgNow().toISOString(), FUTURE, "c3: setter moves now in test");
      assertEq(store.visitTimeReached(slot), true, "c4: visitTimeReached() default follows the override");
      assertEq(store.visitTimeReached(slot, new Date()), false, "c5: an explicit now is still honoured");
      clock.__setGardssalgTestNow(null);
      process.env.GARDSSALG_TEST_NOW = FUTURE;
      assertEq(clock.gardssalgNow().toISOString(), FUTURE, "c6: GARDSSALG_TEST_NOW moves now in test");
      clock.__setGardssalgTestNow("2098-01-01T00:00:00Z");
      assertEq(clock.gardssalgNow().toISOString(), "2098-01-01T00:00:00.000Z", "c7: setter wins over the env var");
      clock.__setGardssalgTestNow(null);
      for (const bad of ["garbage", "2099-13-45T99:99", "1735689600000", "next tuesday", "2099-06-01", " "]) {
        process.env.GARDSSALG_TEST_NOW = bad;
        near(clock.gardssalgNow(), `c8: invalid override ${JSON.stringify(bad)} -> real time`);
      }
      clock.__setGardssalgTestNow("not-a-date");
      near(clock.gardssalgNow(), "c9: invalid setter value -> real time");
      clock.__setGardssalgTestNow(null);
      delete process.env.GARDSSALG_TEST_NOW;

      // ── (p) AK1: no effect in production ────────────────────────────────
      clock.__setGardssalgTestNow(FUTURE);
      process.env.GARDSSALG_TEST_NOW = FUTURE;
      process.env.NODE_ENV = "production";
      try {
        assertEq(clock.gardssalgTestClockAllowed(), false, "p1 (AK1): override not allowed with NODE_ENV=production");
        near(clock.gardssalgNow(), "p2 (AK1): NODE_ENV=production -> real time despite setter + env override");
        assertEq(store.visitTimeReached(slot), false, "p3 (AK1): NODE_ENV=production -> visit in 2099 still not reached");
      } finally {
        process.env.NODE_ENV = "test";
      }
      process.env.FLY_APP_NAME = "lokal";
      try {
        near(clock.gardssalgNow(), "p4: on Fly (FLY_APP_NAME) -> real time despite override");
      } finally {
        delete process.env.FLY_APP_NAME;
      }
      assertEq(clock.gardssalgNow({ NODE_ENV: "production", GARDSSALG_TEST_NOW: FUTURE } as NodeJS.ProcessEnv).getTime() < Date.parse(FUTURE), true, "p5: explicit production env -> real time");
      assertEq(clock.gardssalgNow().toISOString(), FUTURE, "p6: back in test the override applies again");
      clock.__setGardssalgTestNow(null);
      delete process.env.GARDSSALG_TEST_NOW;

      // ── (r) attendance route ────────────────────────────────────────────
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES ('tc-p1', 'Klokketest AS', 'experiences', 'Vestland', 'Voss', 'sideri', 'post@tc-p1.example.no', 1, 0,
            'tc-test-p1', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      emailSvc.sendEmail = async () => ({ success: true, messageId: "stub" });
      const settle = () => new Promise((res) => setTimeout(res, 30));
      const slotDate = new Date(Date.now() + 5 * 24 * HOUR);
      slotDate.setUTCHours(11, 0, 0, 0);
      const slotAt = slotDate.toISOString();
      const afterSlot = new Date(slotDate.getTime() + HOUR).toISOString();
      const mk = (name: string) => {
        const b = store.createBooking({
          provider_id: "tc-p1", slot_at: slotAt, party_size: 2,
          guest_name: name, guest_email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.no`,
        });
        assertTrue(!!store.producerRespondConfirm(String(b.respond_token)), `r0: producer confirms ${name}`);
        return b;
      };
      const rowOf = (ref: string) => store.getBookingByRef(ref)!;

      const app = express();
      app.use((require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any);
      server = http.createServer(app);
      await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const postForm = async (path: string, form: Record<string, string>) => {
        const res = await httpReq(`${base}${path}`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString(),
        });
        await settle();
        return { status: res.status, location: String(res.headers.location || "") };
      };
      const getText = async (path: string) => (await httpReq(`${base}${path}`)).text;

      const early = mk("Tidlig Gjest");
      const earlyPath = `/kategori/gardssalg/bekreft/${early.confirm_token}`;
      const e1 = await postForm(earlyPath, { action: "attended" });
      assertEq([e1.status, e1.location], [303, `${earlyPath}?error=too_early`], "r1: no override -> POST attended before the visit -> too_early");
      assertEq(rowOf(early.booking_ref).status, "reserved", "r2: nothing written");
      assertTrue(!(await getText(earlyPath)).includes('value="attended"'), "r3: no override -> no «Møtte» button before the visit");

      clock.__setGardssalgTestNow(afterSlot);
      const page = await getText(earlyPath);
      assertTrue(page.includes('value="attended"') && page.includes('value="no_show"'), "r4: override past the slot -> «Møtte»/«Ikke møtt» shown");
      const e2 = await postForm(earlyPath, { action: "attended" });
      assertEq(e2.location, `${earlyPath}?done=confirmed_attended`, "r5: override -> POST attended resolves before the real visit time");
      assertEq([rowOf(early.booking_ref).status, rowOf(early.booking_ref).billable], ["confirmed_attended", 1], "r6: attended, billable 1");
      const noShow = mk("Uteblitt Gjest");
      const nsPath = `/kategori/gardssalg/bekreft/${noShow.confirm_token}`;
      const e3 = await postForm(nsPath, { action: "no_show" });
      assertEq([e3.location, rowOf(noShow.booking_ref).status], [`${nsPath}?done=no_show`, "no_show"], "r7: override -> «Ikke møtt» resolves too");

      const prod = mk("Prod Gjest");
      const prodPath = `/kategori/gardssalg/bekreft/${prod.confirm_token}`;
      process.env.NODE_ENV = "production";
      try {
        const e4 = await postForm(prodPath, { action: "attended" });
        assertEq(e4.location, `${prodPath}?error=too_early`, "r8 (AK1): NODE_ENV=production + override -> still too_early");
        assertEq(rowOf(prod.booking_ref).status, "reserved", "r9 (AK1): nothing written under production");
      } finally {
        process.env.NODE_ENV = "test";
      }
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      clock.__setGardssalgTestNow(null);
      emailSvc.sendEmail = origSend;
      if (server) await new Promise<void>((res) => server!.close(() => res()));
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgTestClockTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
