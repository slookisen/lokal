/**
 * opplevelser-test-producer-hidden-bookable.test.ts — dev-request
 * 2026-11-12-f1-felles-for-ai-kanalene, slice F1-5 («skjult, bookbar
 * testprodusent»).
 *
 * The hidden gårdssalg test producer (KNOWN_TEST_PROVIDER_ID) is bookable by
 * its explicit provider_id and hidden on every public surface.
 *
 *   AK3  GET /api/opplevelser/admin/gardssalg/test-provider/reviewer-state
 *        answers 200 with old and new value per field and writes nothing;
 *        POST without explicit apply is a dry-run too; POST {apply:true}
 *        writes exactly the plan (+ one audit row per field) and a repeat
 *        is a no-op. No key → 403; missing row → 404; unflagged row → 409.
 *   AK1  after apply, a walk over every public surface — web pages
 *        (front page, gårdssalg grid + type page, /sok, profile/book/tilbyder
 *        by slug and id), sitemap.xml, llms.txt, openapi.json, agent card,
 *        REST /discover + /categories + /:id, MCP discover_gardssalg without
 *        an id (no filter, kommune, producer_type, query = the name),
 *        list_experience_categories, discover_experiences, and A2A
 *        message/send (gårdssalg intent, name, raw id) — FAILS if the test
 *        producer's id, name or slug appears. A visible control producer
 *        must appear on the listing surfaces (so an empty/500 surface cannot
 *        pass by accident), and the same walk with the row un-hidden must
 *        catch it (so the detector is proven to bite).
 *   AK2  book_gardssalg (MCP) with the test producer's id → success, one
 *        gardssalg_bookings row, producer e-mail to
 *        GARDSSALG_TEST_PRODUCER_EMAIL (mocked transport), with the global
 *        BOOKING_DISPATCH_ENABLED switch off.
 *
 * Standalone: npx tsx src/routes/opplevelser-test-producer-hidden-bookable.test.ts
 * Wired into tests/test.ts via runOpplevelserTestProducerHiddenBookableTests().
 */

import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ADMIN_KEY = "f1-5-test-producer-admin-key";
const TEST_NAME = "Zqxvik Anmeldergård";
const TEST_SLUG = "zqxvik-anmeldergard";
const CONTROL_NAME = "Kontrollgård Bryggeri";
const PRIVATE_EMAIL = "privat.innboks@example.no";

function parseJsonRpcBody(text: string): any {
  const line = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
  return JSON.parse(line ? line.slice("data:".length).trim() : text);
}

export function runOpplevelserTestProducerHiddenBookableTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const assertTrue = (cond: boolean, label: string): void => assertEq(!!cond, true, label);

  return (async () => {
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/email-service"),
      require.resolve("./opplevelser"),
      require.resolve("./opplevelser-test-producer-reviewer"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-a2a"),
      require.resolve("./experiences-seo"),
    ]);

    let closeHttp: (() => Promise<void>) | null = null;
    let emailMod: typeof import("../services/email-service") | undefined;
    let origSendEmail: unknown;
    const prevConsoleLog = console.log;
    if (!log) console.log = () => {};

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const { KNOWN_TEST_PROVIDER_ID: TEST_ID } = require("../database/init-experiences") as typeof import("../database/init-experiences");
      const { GARDSSALG_TEST_PRODUCER_EMAIL, TEST_PRODUCER_REVIEWER_TARGET, REVIEWER_STATE_AUDIT_BATCH } =
        require("../services/gardssalg-test-producer-reviewer") as typeof import("../services/gardssalg-test-producer-reviewer");

      emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const emailCalls: Array<{ to: string; subject: string }> = [];
      origSendEmail = emailMod.emailService.sendEmail;
      (emailMod.emailService as any).sendEmail = async (o: { to: string; subject: string }) => {
        emailCalls.push({ to: o.to, subject: o.subject });
        return { success: true, messageId: "test" };
      };

      // ── HTTP app wired like index.ts's opplevagent host gate ──────────
      const express = require("express") as typeof import("express");
      const http = require("http") as typeof import("http");
      const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
      const oppRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default as any;
      const a2aRouter = (require("./experiences-a2a") as typeof import("./experiences-a2a")).default as any;
      const seoMod = require("./experiences-seo") as typeof import("./experiences-seo");
      const app = express();
      app.use(express.json());
      app.use(langMiddleware);
      app.use("/api/opplevelser", oppRouter);
      app.use((req: any, res: any, next: any) => {
        if (req.path === "/mcp" || req.path.startsWith("/mcp/")) return mcpRouter(req, res, next);
        if (req.path === "/a2a" || req.path.startsWith("/a2a/")) return a2aRouter(req, res, next);
        return (seoMod.default as any)(req, res, next);
      });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      closeHttp = () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
      const port = (server.address() as AddressInfo).port;
      // node:http, not globalThis.fetch: other suites in the same process stub
      // fetch (tests/test.ts «SHARED GLOBAL STATE» #1).
      const request = (method: string, path: string, headers: Record<string, string>, body?: string) =>
        new Promise<{ status: number; headers: import("http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
          const h: Record<string, string | number> = { ...headers };
          if (body !== undefined) h["content-length"] = Buffer.byteLength(body);
          const r = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body !== undefined) r.write(body);
          r.end();
        });
      const get = (path: string, headers: Record<string, string> = {}) => request("GET", path, headers);
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        request("POST", path, { "Content-Type": "application/json", ...headers }, JSON.stringify(body));
      const admin = { "X-Admin-Key": ADMIN_KEY };
      const RS = "/api/opplevelser/admin/gardssalg/test-provider/reviewer-state";

      // ── AK3 (part 1): no key / missing row / unflagged row ────────────
      assertEq((await get(RS)).status, 403, "ak3.0: GET without X-Admin-Key → 403");
      assertEq((await post(RS, { apply: true })).status, 403, "ak3.0b: POST apply without X-Admin-Key → 403");
      assertEq((await get(RS, admin)).status, 404, "ak3.1: no test row → 404");

      // ── fixtures: the test row in a «before» state, plus a control ────
      const ins = db.prepare(
        `INSERT INTO experience_providers
           (id, org_nr, navn, vertical, fylke, kommune, poststed, adresse, telefon, mobil, epost, hjemmeside,
            producer_type, booking_live, catalog_hidden, catalog_hidden_reason, is_test_provider, slug, lat, lon,
            geocode_confidence, brreg_verified, brreg_active, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @org_nr, @navn, 'experiences', 'Telemark', 'Skien', 'Skien', @adresse, @telefon, @mobil, @epost, @hjemmeside,
                 'bryggeri', @booking_live, @catalog_hidden, @reason, @is_test, @slug, @lat, @lon,
                 'high', 1, 1, 'raw', 'verified', 'test-fixture', 'medium')`,
      );
      ins.run({
        id: "f15-control", org_nr: "999000111", navn: CONTROL_NAME, adresse: "Storgata 1", telefon: null, mobil: null,
        epost: "post@kontrollgard.example.no", hjemmeside: null, booking_live: 1, catalog_hidden: 0, reason: null,
        is_test: null, slug: "kontrollgard-bryggeri", lat: 59.21, lon: 9.61,
      });
      // Four more visible rows: the gårdssalg sections (front page, sitemap)
      // only render from GARDSSALG_VISIBILITY_THRESHOLD = 5 visible producers.
      for (let i = 1; i <= 4; i++) {
        ins.run({
          id: `f15-fill-${i}`, org_nr: `99900020${i}`, navn: `Fyllgård ${i}`, adresse: null, telefon: null, mobil: null,
          epost: null, hjemmeside: null, booking_live: 0, catalog_hidden: 0, reason: null, is_test: null,
          slug: `fyllgard-${i}`, lat: 59.3 + i / 100, lon: 9.7,
        });
      }
      ins.run({
        id: TEST_ID, org_nr: "TEST000000", navn: TEST_NAME, adresse: "Privatveien 7", telefon: "+47 911 11 111",
        mobil: "+47 922 22 222", epost: PRIVATE_EMAIL, hjemmeside: "https://privat.example.no", booking_live: 0,
        catalog_hidden: 1, reason: null, is_test: 0, slug: TEST_SLUG, lat: 59.2101, lon: 9.6101,
      });
      assertEq((await get(RS, admin)).status, 409, "ak3.2: row not flagged is_test_provider → 409");
      db.prepare("UPDATE experience_providers SET is_test_provider = 1 WHERE id = ?").run(TEST_ID);

      const snapshot = () => db.prepare("SELECT * FROM experience_providers WHERE id = ?").get(TEST_ID);
      const auditCount = () =>
        (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE batch_id = ?").get(REVIEWER_STATE_AUDIT_BATCH) as { n: number }).n;

      // ── AK3 (part 2): dry-run shows old + new per field, writes nothing ─
      const before = JSON.stringify(snapshot());
      const dry = await get(RS, admin);
      const dj = JSON.parse(dry.text);
      assertEq(dry.status, 200, "ak3.3: GET dry-run → 200");
      assertEq(dj.dry_run, true, "ak3.3b: dry_run true");
      assertEq(dj.provider_id, TEST_ID, "ak3.3c: targets KNOWN_TEST_PROVIDER_ID");
      const byField = Object.fromEntries((dj.changes as any[]).map((c) => [c.field, c]));
      assertEq(byField.epost, { field: "epost", old: PRIVATE_EMAIL, new: GARDSSALG_TEST_PRODUCER_EMAIL }, "ak3.4: epost old→new");
      assertEq(byField.telefon, { field: "telefon", old: "+47 911 11 111", new: null }, "ak3.4b: telefon old→null");
      assertEq(byField.mobil?.new, null, "ak3.4c: mobil → null");
      assertEq(byField.adresse, { field: "adresse", old: "Privatveien 7", new: null }, "ak3.4d: adresse old→null");
      assertEq(byField.hjemmeside?.new, null, "ak3.4e: hjemmeside → null");
      assertEq(byField.booking_live, { field: "booking_live", old: 0, new: 1 }, "ak3.4f: booking_live 0→1");
      assertEq(byField.catalog_hidden_reason, { field: "catalog_hidden_reason", old: null, new: "test_fixture" }, "ak3.4g: reason → test_fixture");
      assertEq([...dj.unchanged].sort(), ["catalog_hidden", "is_test_provider"], "ak3.4h: already-correct fields listed as unchanged");
      assertEq(dj.changes.length + dj.unchanged.length, Object.keys(TEST_PRODUCER_REVIEWER_TARGET).length, "ak3.4i: every target field accounted for");
      const dryPost = JSON.parse((await post(RS, {}, admin)).text);
      assertEq(dryPost.dry_run, true, "ak3.5: POST without apply is a dry-run");
      assertEq(JSON.parse((await post(RS, { apply: false }, admin)).text).dry_run, true, "ak3.5b: apply:false is a dry-run");
      assertEq(JSON.stringify(snapshot()), before, "ak3.6: dry-runs wrote nothing");
      assertEq(auditCount(), 0, "ak3.6b: no audit rows from dry-runs");

      // ── apply ────────────────────────────────────────────────────────
      const ap = await post(RS, { apply: true }, admin);
      const aj = JSON.parse(ap.text);
      assertEq(ap.status, 200, "ak3.7: POST apply → 200");
      assertEq(aj.dry_run, false, "ak3.7b: dry_run false");
      assertEq(aj.changes.length, dj.changes.length, "ak3.7c: applied exactly the dry-run plan");
      const after = snapshot() as Record<string, unknown>;
      for (const [k, v] of Object.entries(TEST_PRODUCER_REVIEWER_TARGET)) assertEq(after[k] ?? null, v, `ak3.8: ${k} written`);
      assertEq(after.navn, TEST_NAME, "ak3.8b: navn untouched");
      assertEq(auditCount(), dj.changes.length, "ak3.9: one audit row per changed field");
      const again = JSON.parse((await get(RS, admin)).text);
      assertEq(again.changes, [], "ak3.10: dry-run after apply → no changes (reset is idempotent)");
      assertEq(JSON.parse((await post(RS, { apply: true }, admin)).text).changes, [], "ak3.10b: second apply writes nothing");
      assertEq(auditCount(), dj.changes.length, "ak3.10c: no extra audit rows");
      assertEq(
        (db.prepare("SELECT epost FROM experience_providers WHERE id = 'f15-control'").get() as { epost: string }).epost,
        "post@kontrollgard.example.no",
        "ak3.11: control row untouched",
      );

      // ── MCP / A2A clients ────────────────────────────────────────────
      const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const initRes = await request("POST", "/mcp", mcpHeaders,
        JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "f1-5-test", version: "1.0.0" } }, id: "1" }));
      const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
      const mcpCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const r = await request("POST", "/mcp", { ...mcpHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
          JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: String(Math.random()) }));
        return JSON.stringify(parseJsonRpcBody(r.text));
      };
      const a2a = async (text: string): Promise<string> =>
        (await post("/a2a", { jsonrpc: "2.0", id: "a", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text }] } } })).text;

      // ── AK1: walk every public surface ───────────────────────────────
      // `listing` = the surface lists gårdssalg producers, so the visible
      // control producer must show there (an error page cannot pass).
      type Surface = { name: string; listing: boolean; body: string; echo?: string[] };
      const walk = async (): Promise<Surface[]> => {
        (seoMod as any).__resetExperiencesSitemapCacheForTesting?.();
        const s: Surface[] = [];
        const page = async (name: string, path: string, listing = false, echo: string[] = []) =>
          s.push({ name, listing, body: (await get(path)).text, echo });
        await page("web:/", "/");
        await page("web:/kategori/gardssalg", "/kategori/gardssalg", true);
        await page("web:/kategori/gardssalg/bryggeri", "/kategori/gardssalg/bryggeri", true);
        await page("web:/sok?q=Skien", "/sok?q=Skien");
        await page("web:/sok?q=<name>", `/sok?q=${encodeURIComponent(TEST_NAME)}`, false, [TEST_NAME]);
        await page("web:/sok?q=<control>", `/sok?q=${encodeURIComponent(CONTROL_NAME)}`, true);
        await page("web:produsent/<slug>", `/kategori/gardssalg/produsent/${TEST_SLUG}`, false, [TEST_SLUG]);
        await page("web:book/<slug>", `/kategori/gardssalg/book/${TEST_SLUG}`, false, [TEST_SLUG]);
        await page("web:tilbyder/<id>", `/tilbyder/${TEST_ID}`, false, [TEST_ID]);
        await page("web:tilbyder/<slug>", `/tilbyder/${TEST_SLUG}`, false, [TEST_SLUG]);
        await page("sitemap.xml", "/sitemap.xml", true);
        await page("llms.txt", "/llms.txt");
        await page("openapi.json", "/openapi.json");
        await page("agent-card.json", "/.well-known/agent-card.json");
        await page("rest:/discover gardssalg", "/api/opplevelser/discover?category=gardssalg_smaking", true);
        await page("rest:/discover gardssalg kommune", "/api/opplevelser/discover?category=gardssalg_smaking&kommune=Skien", true);
        await page("rest:/categories", "/api/opplevelser/categories");
        await page("rest:/:id", `/api/opplevelser/${TEST_ID}`, false, [TEST_ID]);
        s.push({ name: "mcp:discover_gardssalg {}", listing: true, body: await mcpCall("discover_gardssalg", {}) });
        s.push({ name: "mcp:discover_gardssalg kommune", listing: true, body: await mcpCall("discover_gardssalg", { kommune: "Skien" }) });
        s.push({ name: "mcp:discover_gardssalg type", listing: true, body: await mcpCall("discover_gardssalg", { producer_type: "bryggeri" }) });
        s.push({ name: "mcp:discover_gardssalg near", listing: true, body: await mcpCall("discover_gardssalg", { lat: 59.21, lng: 9.61, radius_km: 20 }) });
        s.push({ name: "mcp:discover_gardssalg query=name", listing: false, body: await mcpCall("discover_gardssalg", { query: TEST_NAME }), echo: [TEST_NAME] });
        s.push({ name: "mcp:list_experience_categories", listing: false, body: await mcpCall("list_experience_categories", {}) });
        s.push({ name: "mcp:discover_experiences", listing: false, body: await mcpCall("discover_experiences", { query: "bryggeri i Skien" }) });
        s.push({ name: "a2a:bryggeri i Skien", listing: true, body: await a2a("bryggeri i Skien") });
        s.push({ name: "a2a:gårdssalg i Telemark", listing: true, body: await a2a("gårdssalg i Telemark") });
        s.push({ name: "a2a:<name>", listing: false, body: await a2a(`gårdssalg ${TEST_NAME}`), echo: [TEST_NAME] });
        s.push({ name: "a2a:<id>", listing: false, body: await a2a(`fortell om ${TEST_ID}`), echo: [TEST_ID] });
        return s;
      };
      // `echo`: needles the request itself carried (a search box or «no hit
      // for <id>» repeating the input is not a leak); every other needle —
      // above all id + slug, which any real hit carries — must stay absent.
      const leaks = (body: string, echo: string[] = []): string[] =>
        [TEST_ID, TEST_NAME, TEST_SLUG, GARDSSALG_TEST_PRODUCER_EMAIL].filter((needle) => !echo.includes(needle) && body.includes(needle));

      const hidden = await walk();
      assertTrue(hidden.length >= 25, `ak1.0: walked ${hidden.length} surfaces`);
      for (const s of hidden) {
        assertEq(leaks(s.body, s.echo), [], `ak1: test producer absent on ${s.name}`);
        if (s.listing) assertTrue(s.body.includes(CONTROL_NAME) || s.body.includes("kontrollgard-bryggeri"), `ak1-canary: control producer present on ${s.name}`);
      }

      // Detector must bite: the same walk with the row un-hidden finds it.
      db.prepare("UPDATE experience_providers SET catalog_hidden = 0 WHERE id = ?").run(TEST_ID);
      const exposed = await walk();
      db.prepare("UPDATE experience_providers SET catalog_hidden = 1 WHERE id = ?").run(TEST_ID);
      const exposedLeaky = exposed.filter((s) => leaks(s.body, s.echo).length > 0).map((s) => s.name);
      for (const must of ["web:/kategori/gardssalg", "sitemap.xml", "rest:/discover gardssalg", "mcp:discover_gardssalg kommune", "mcp:discover_gardssalg query=name", "a2a:bryggeri i Skien"]) {
        assertTrue(exposedLeaky.includes(must), `ak1-bite: un-hidden row is caught on ${must}`);
      }

      // ── AK2: book_gardssalg with the explicit id ─────────────────────
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 10);
      const pad = (n: number): string => String(n).padStart(2, "0");
      const slot = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T12:00`;
      const count = (): number => (db.prepare("SELECT COUNT(*) AS n FROM gardssalg_bookings WHERE provider_id = ?").get(TEST_ID) as { n: number }).n;
      emailCalls.length = 0;
      const n0 = count();
      const bookRaw = await mcpCall("book_gardssalg", {
        provider_id: TEST_ID, slot_at: slot, party_size: 2, guest_name: "Anne Anmelder", guest_email: "anne@example.no",
      });
      const book = JSON.parse(JSON.parse(bookRaw).result?.content?.[0]?.text ?? "{}");
      assertEq(book.success, true, "ak2.1: book_gardssalg with the test id → success (global switch off)");
      assertEq(count(), n0 + 1, "ak2.2: one booking row for the test producer");
      for (let i = 0; i < 20 && !emailCalls.some((c) => c.to === GARDSSALG_TEST_PRODUCER_EMAIL); i++) await new Promise((r) => setTimeout(r, 10));
      assertTrue(emailCalls.some((c) => c.to === GARDSSALG_TEST_PRODUCER_EMAIL), "ak2.3: producer e-mail goes to the reserved test address");
      assertTrue(!emailCalls.some((c) => c.to === PRIVATE_EMAIL), "ak2.4: nothing to the old private address");
      assertTrue(emailCalls.every((c) => c.to === GARDSSALG_TEST_PRODUCER_EMAIL || c.to === "anne@example.no"), "ak2.5: only guest + test address mailed");
    } catch (err) {
      failed++;
      failures.push(`✗ test crashed: ${(err as Error).stack || err}`);
    } finally {
      console.log = prevConsoleLog;
      if (closeHttp) await closeHttp();
      if (emailMod && origSendEmail) (emailMod.emailService as any).sendEmail = origSendEmail;
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
  runOpplevelserTestProducerHiddenBookableTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
