/**
 * testmiljo.test.ts — the local test environment (src/testmiljo).
 *
 * dev-request 2026-11-25-testmiljo-lokal-kopi-med-testdata-foer-prodsetting
 * (points 2, 3 and 4; AK3 and AK4).
 *
 * Covers:
 *   g1-g8   the switch: off by default, on only for TESTMILJO=1 outside
 *           production, boot refused in production / wrong value / with mail
 *           credentials / without own database files; loopback check.
 *   h1-h6   local host names: mapping, production URLs rewritten in Location
 *           and HTML only, self-removing service worker, no effect when off.
 *   o1-o6   outbound guard: a non-loopback connection is refused before DNS
 *           (raw socket and global fetch), loopback passes, uninstall restores.
 *   x1-x4   outbox: capture, list, read, clear; EmailService uses it in the
 *           test environment and is unchanged outside it.
 *   r1-r9   /testmiljo pages over a real HTTP server: 404 when off, 403 for a
 *           non-loopback peer, owner list, login redirect per site, refusals,
 *           outbox pages, nothing mounted when off.
 *   d1-d4   the real dependencies against in-memory databases: owners are
 *           read from verified claims, and login issues an ordinary unused
 *           login link (no session is written directly).
 *
 * Standalone: npx tsx src/testmiljo/testmiljo.test.ts
 * Wired into tests/test.ts via runTestmiljoTests().
 */

import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "TESTMILJO", "NODE_ENV", "FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS",
  "DB_PATH", "DENTAL_DB_PATH", "EXPERIENCES_DB_PATH", "EMAIL_FORCE_DRY_RUN", "TESTMILJO_RATE_LIMITS",
] as const;

export async function runTestmiljoTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  function restoreEnv(): void {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
  /** process.env as the test environment sees it: on, not production, own database files. */
  function enterTestmiljo(dbDir: string): void {
    process.env.TESTMILJO = "1";
    process.env.NODE_ENV = "test";
    for (const key of ["FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "TESTMILJO_RATE_LIMITS"]) delete process.env[key];
    process.env.DB_PATH = path.join(dbDir, "lokal.db");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "testmiljo-test-"));

  const guard = require("./guard") as typeof import("./guard");
  const hosts = require("./hosts") as typeof import("./hosts");
  const outbound = require("./outbound-guard") as typeof import("./outbound-guard");
  const outbox = require("./outbox") as typeof import("./outbox");
  const routerMod = require("./router") as typeof import("./router");

  try {
    // ── g: the switch ─────────────────────────────────────────────────
    const dbs = { DB_PATH: "/t/lokal.db", DENTAL_DB_PATH: "/t/dental.db", EXPERIENCES_DB_PATH: "/t/experiences.db" };
    const throws = (env: NodeJS.ProcessEnv): string => {
      try { guard.assertTestmiljoBootSafe(env); return ""; } catch (err) { return String((err as Error).message); }
    };
    assertTrue(!guard.isTestmiljo({}) && guard.testmiljoBootProblems({}).length === 0 && throws({ NODE_ENV: "production", FLY_APP_NAME: "lokal" }) === "",
      "g1 unset: off, and production boots untouched");
    assertTrue(guard.isTestmiljo({ TESTMILJO: "1", ...dbs }) && throws({ TESTMILJO: "1", ...dbs }) === "", "g2 TESTMILJO=1 with own databases: on, boot allowed");
    assertTrue(!guard.isTestmiljo({ TESTMILJO: "1", NODE_ENV: "production", ...dbs }) && /production/.test(throws({ TESTMILJO: "1", NODE_ENV: "production", ...dbs })),
      "g3 NODE_ENV=production: off, boot refused");
    for (const fly of ["FLY_APP_NAME", "FLY_MACHINE_ID", "FLY_ALLOC_ID"]) {
      assertTrue(!guard.isTestmiljo({ TESTMILJO: "1", [fly]: "x", ...dbs }) && throws({ TESTMILJO: "1", [fly]: "x", ...dbs }) !== "", `g4 ${fly} set: off, boot refused`);
    }
    for (const value of ["true", "0", "on", "yes"]) {
      assertTrue(!guard.isTestmiljo({ TESTMILJO: value, ...dbs }) && /exactly/.test(throws({ TESTMILJO: value, ...dbs })), `g5 TESTMILJO=${value}: off, boot refused (not silently ignored)`);
    }
    for (const smtp of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
      assertTrue(new RegExp(smtp).test(throws({ TESTMILJO: "1", [smtp]: "x", ...dbs })), `g6 ${smtp} set: boot refused`);
    }
    for (const key of Object.keys(dbs)) {
      const env: NodeJS.ProcessEnv = { TESTMILJO: "1", ...dbs };
      delete env[key];
      assertTrue(new RegExp(key).test(throws(env)), `g7 ${key} missing: boot refused`);
    }
    assertEq(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "10.0.0.5", "192.168.1.20", "fdaa:0:1::3", "::ffff:10.0.0.5", "", undefined].map((a) => guard.isLoopbackAddress(a)),
      [true, true, true, true, false, false, false, false, false, false], "g8 loopback addresses only");

    // ── h: local host names ───────────────────────────────────────────
    assertEq(["rettfrabonden.localhost", "opplevagent.localhost", "finn-tannlege.localhost", "OPPLEVAGENT.localhost", "localhost", "opplevagent.no", "evil.opplevagent.localhost"].map(hosts.prodHostFor),
      ["rettfrabonden.com", "opplevagent.no", "finn-tannlege.com", "opplevagent.no", null, null, null], "h1 local name → production name, nothing else");
    assertEq([hosts.splitHostPort("opplevagent.localhost:4310"), hosts.splitHostPort("localhost"), hosts.splitHostPort(undefined)],
      [{ hostname: "opplevagent.localhost", port: "4310" }, { hostname: "localhost", port: "" }, { hostname: "", port: "" }], "h2 host and port split");
    assertEq(
      hosts.rewriteProdUrls(
        'a href="https://opplevagent.no/kategori/gardssalg" b https://www.rettfrabonden.com/sok c http://finn-tannlege.com d https://opplevagent.no.example.com/x e kontakt@opplevagent.no f https://opplevagent.no',
        "4310",
      ),
      'a href="http://opplevagent.localhost:4310/kategori/gardssalg" b http://rettfrabonden.localhost:4310/sok c http://finn-tannlege.localhost:4310 d https://opplevagent.no.example.com/x e kontakt@opplevagent.no f http://opplevagent.localhost:4310',
      "h3 scheme-qualified production URLs are rewritten; look-alikes and bare names are not",
    );

    type FakeRes = { headers: Record<string, unknown>; body: unknown; ended: unknown; setHeader(n: string, v: any): any; getHeader(n: string): any; send(b?: unknown): any; end(b?: unknown): any };
    const fakeRes = (): FakeRes => {
      const res: FakeRes = {
        headers: {}, body: undefined, ended: undefined,
        setHeader(n, v) { this.headers[n.toLowerCase()] = v; return this; },
        getHeader(n) { return this.headers[n.toLowerCase()]; },
        send(b) { this.body = b; return this; },
        end(b) { this.ended = b; return this; },
      };
      return res;
    };
    const runHost = (hostHeader: string, pathName: string, extraHeaders: Record<string, string> = {}) => {
      const req: any = { headers: { host: hostHeader, ...extraHeaders }, path: pathName };
      const res = fakeRes();
      let nexted = false;
      hosts.testmiljoHostMiddleware()(req, res as any, () => { nexted = true; });
      return { req, res, nexted };
    };

    enterTestmiljo(tmpDir);
    {
      const { req, res, nexted } = runHost("opplevagent.localhost:4310", "/kategori/gardssalg", { "x-forwarded-host": "spoofed.example" });
      res.setHeader("Location", "https://opplevagent.no/kategori/gardssalg/eier/x/portal");
      res.setHeader("X-Other", "https://opplevagent.no/");
      res.send('<a href="https://rettfrabonden.com/">x</a>');
      assertTrue(nexted && req.headers["x-forwarded-host"] === "opplevagent.no", "h4 the local name reaches the app as the production host; a client-sent X-Forwarded-Host is dropped");
      assertEq([res.headers["location"], res.headers["x-other"], res.body],
        ["http://opplevagent.localhost:4310/kategori/gardssalg/eier/x/portal", "https://opplevagent.no/", '<a href="http://rettfrabonden.localhost:4310/">x</a>'],
        "h4 Location and HTML are rewritten, other headers are not");
      const json = runHost("rettfrabonden.localhost:4310", "/api/x");
      json.res.setHeader("Content-Type", "application/json; charset=utf-8");
      json.res.send('{"url":"https://rettfrabonden.com/p"}');
      assertEq(json.res.body, '{"url":"https://rettfrabonden.com/p"}', "h4 JSON bodies are left alone");
      const plain = runHost("localhost:4310", "/");
      assertTrue(plain.nexted && plain.req.headers["x-forwarded-host"] === undefined, "h4 plain localhost is not mapped");
    }
    {
      const sw = runHost("rettfrabonden.localhost:4310", "/sw.js");
      assertTrue(!sw.nexted && String(sw.res.ended).includes("registration.unregister") && /javascript/.test(String(sw.res.headers["content-type"])),
        "h5 /sw.js is a service worker that removes itself");
    }
    delete process.env.TESTMILJO;
    {
      const off = runHost("opplevagent.localhost:4310", "/sw.js", { "x-forwarded-host": "kept.example" });
      off.res.setHeader("Location", "https://opplevagent.no/x");
      assertTrue(off.nexted && off.req.headers["x-forwarded-host"] === "kept.example" && off.res.headers["location"] === "https://opplevagent.no/x" && off.res.ended === undefined,
        "h6 outside the test environment the middleware does nothing");
    }

    // ── o: outbound guard ─────────────────────────────────────────────
    assertEq(["localhost", "x.localhost", "127.0.0.1", "[::1]", "::ffff:127.0.0.1", "example.no", "127.0.0.1.example.no", "10.0.0.1"].map(outbound.isLoopbackHost),
      [true, true, true, true, true, false, false, false], "o1 loopback host names");
    assertEq([outbound.parseAllowList(" api.anthropic.com , .Example.NO ,,"), outbound.parseAllowList(undefined)], [["api.anthropic.com", ".example.no"], []], "o2 allow-list parsing");
    const allow = [".example.no", "api.anthropic.com"];
    assertEq(["api.anthropic.com", "x.api.anthropic.com", "example.no", "www.example.no", "notexample.no", "example.no.evil.com"].map((h) => outbound.hostAllowed(h, allow)),
      [true, false, true, true, false, false], "o3 exact host, or subdomains with a leading dot");
    assertEq(
      [outbound.connectTarget([{ host: "a.example", port: 443 }]), outbound.connectTarget([[{ host: "b.example", port: 80 }, null]]), outbound.connectTarget([8080, "c.example"]),
        outbound.connectTarget([8080]), outbound.connectTarget([{ path: "/tmp/sock" }]), outbound.connectTarget(["/tmp/sock"]), outbound.connectTarget([{ port: 25 }])],
      [{ host: "a.example", port: 443 }, { host: "b.example", port: 80 }, { host: "c.example", port: 8080 }, { host: "localhost", port: 8080 }, null, null, { host: "localhost", port: 25 }],
      "o4 connect() targets in every call form",
    );
    {
      const originalConnect = net.Socket.prototype.connect;
      outbound.resetOutboundAttempts();
      const uninstall = outbound.installOutboundGuard({ allow: [] });
      const local = net.createServer((socket) => socket.end());
      try {
        await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", () => resolve()));
        const localPort = (local.address() as net.AddressInfo).port;
        const blockedCode = await new Promise<string>((resolve) => {
          const socket = net.connect({ host: "blocked.example.invalid", port: 443 });
          socket.on("error", (err: any) => resolve(String(err?.code)));
          socket.on("connect", () => { socket.destroy(); resolve("CONNECTED"); });
        });
        const fetchCode = await fetch("http://fetch.example.invalid/x").then(() => "FETCHED", (err: any) => String(err?.cause?.code ?? err?.code));
        const loopbackResult = await new Promise<string>((resolve) => {
          const socket = net.connect({ host: "127.0.0.1", port: localPort });
          socket.on("error", (err: any) => resolve(String(err?.code)));
          socket.on("connect", () => { socket.destroy(); resolve("CONNECTED"); });
        });
        assertEq([blockedCode, fetchCode, loopbackResult], ["ETESTMILJO_BLOCKED", "ETESTMILJO_BLOCKED", "CONNECTED"], "o5 a raw socket and global fetch are refused before DNS; this machine is reachable");
        const seen = outbound.outboundAttempts().map((a) => `${a.host}:${a.allowed}`).sort();
        assertEq(seen, ["blocked.example.invalid:false", "fetch.example.invalid:false"], "o5 refused hosts are recorded, loopback is not");
      } finally {
        uninstall();
        await new Promise<void>((resolve) => local.close(() => resolve()));
        outbound.resetOutboundAttempts();
      }
      assertTrue(net.Socket.prototype.connect === originalConnect, "o6 uninstall puts the original connect back");
    }

    // ── x: outbox ─────────────────────────────────────────────────────
    const outboxPath = path.join(tmpDir, "outbox.jsonl");
    {
      const transport = outbox.createOutboxTransport(() => outboxPath);
      const first = await transport.sendMail({
        from: { name: "Opplevagent", address: "ikke-svar@opplevagent.invalid" }, to: ["eier@gard.invalid", "to@gard.invalid"], replyTo: "kontakt@opplevagent.invalid",
        subject: "Ny forespørsel", text: "Hei", html: '<p>Hei <a href="https://opplevagent.no/x">lenke</a></p>',
        headers: { "X-Lokal-Agent": "outreach-system/v1" }, attachments: [{ filename: "a.pdf", content: Buffer.from("12345"), contentType: "application/pdf" }],
      });
      const second = await transport.sendMail({ from: "a@b.invalid", to: "c@d.invalid", subject: "Nummer to", text: "T" });
      const all = outbox.listOutbox(outboxPath);
      assertTrue(/^<[0-9a-f]{16}@testmiljo\.invalid>$/.test(first.messageId) && first.messageId !== second.messageId && first.accepted.length === 1, "x1 a captured send returns a real-looking message id");
      assertEq(all.map((m) => m.subject), ["Nummer to", "Ny forespørsel"], "x1 the outbox lists newest first");
      const stored = all[1];
      assertEq([stored.from, stored.to, stored.replyTo, stored.headers["X-Lokal-Agent"], stored.attachments, stored.text],
        ["Opplevagent <ikke-svar@opplevagent.invalid>", "eier@gard.invalid, to@gard.invalid", "kontakt@opplevagent.invalid", "outreach-system/v1", [{ filename: "a.pdf", contentType: "application/pdf", bytes: 5 }], "Hei"],
        "x2 addresses, headers and attachment sizes are kept; attachment content is not");
      assertTrue(outbox.getOutboxMail(stored.id, outboxPath)?.subject === "Ny forespørsel" && outbox.getOutboxMail("nope", outboxPath) === null, "x2 one e-mail can be read by id");
      fs.appendFileSync(outboxPath, "{torn line\n", "utf8");
      assertEq(outbox.listOutbox(outboxPath).length, 2, "x2 a torn line is skipped");
      outbox.clearOutbox(outboxPath);
      assertEq([outbox.listOutbox(outboxPath).length, fs.existsSync(outboxPath)], [0, false], "x3 clearing empties the outbox");
    }
    {
      const { EmailService } = require("../services/email-service") as typeof import("../services/email-service");
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
      enterTestmiljo(tmpDir);
      process.env.EMAIL_FORCE_DRY_RUN = ""; // the suite forces dry-run on the env transport; a test environment never has NODE_ENV=test
      const inTest = new EmailService();
      const sent = await inTest.sendRaw({ to: "eier@gard.invalid", subject: "Fra tjenesten", textContent: "Hei" });
      const captured = outbox.listOutbox(outboxPath);
      assertTrue(sent.success === true && /@testmiljo\.invalid>$/.test(String(sent.messageId)) && inTest.isLiveTransport() && captured.length === 1 && captured[0].subject === "Fra tjenesten" && captured[0].to === "eier@gard.invalid",
        "x4 in the test environment EmailService captures to the outbox and reports a real send");
      outbox.clearOutbox(outboxPath);
      delete process.env.TESTMILJO;
      const outside = new EmailService();
      const dry = await outside.sendRaw({ to: "eier@gard.invalid", subject: "Utenfor", textContent: "Hei" });
      assertTrue(dry.messageId === "DRY_RUN" && !outside.isLiveTransport() && outbox.listOutbox(outboxPath).length === 0, "x4 outside it, an unconfigured EmailService is the same dry-run as before");
      restoreEnv();
    }

    // ── r: the /testmiljo pages ───────────────────────────────────────
    {
      const express = require("express") as typeof import("express");
      const issued: string[] = [];
      const deps: import("./router").TestmiljoDeps = {
        rfbOwners: () => [{ id: "rfb-1", name: "Solgården <b>", email: "eier@solgarden.invalid" }],
        gardssalgOwners: () => [{ id: "gs-1", name: "Fjordsider", email: "besok@fjordsider.invalid", detail: "fjordsider" }],
        issueRfbLogin: (id, email) => { issued.push(`rfb:${id}:${email}`); return "tok rfb/1"; },
        issueGardssalgLogin: (id, email) => { issued.push(`gs:${id}:${email}`); return id === "gs-1" ? "tok-gs-1" : null; },
      };
      const app = express();
      app.use("/testmiljo", routerMod.createTestmiljoRouter(deps));
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      const call = (method: string, urlPath: string, form?: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
        new Promise((resolve, reject) => {
          const payload = form ? new URLSearchParams(form).toString() : "";
          const req = http.request(
            { host: "127.0.0.1", port, method, path: urlPath, headers: { Host: "rettfrabonden.localhost:4310", ...(form ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } : {}) } },
            (res) => { let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body })); },
          );
          req.on("error", reject);
          req.end(payload);
        });
      try {
        delete process.env.TESTMILJO;
        const off = await call("GET", "/testmiljo");
        const offPost = await call("POST", "/testmiljo/logg-inn", { site: "rfb", id: "rfb-1" });
        assertEq([off.status, offPost.status, issued.length], [404, 404, 0], "r1 outside the test environment every /testmiljo route is a 404 and no login is issued");

        enterTestmiljo(tmpDir);
        const remote = await new Promise<{ status: number; nexted: boolean }>((resolve) => {
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, type() { return this; }, setHeader() { return this; }, send() { resolve({ status: this.statusCode, nexted: false }); return this; } };
          (routerMod.createTestmiljoRouter(deps) as any).handle({ method: "GET", url: "/", headers: { host: "rettfrabonden.localhost:4310" }, socket: { remoteAddress: "10.0.0.9" } }, res, () => resolve({ status: 0, nexted: true }));
        });
        assertEq(remote, { status: 403, nexted: false }, "r2 a request that does not come from this machine is refused");

        const start = await call("GET", "/testmiljo");
        assertTrue(start.status === 200 && start.body.includes("Solgården &lt;b&gt;") && !start.body.includes("Solgården <b>") && start.body.includes("eier@solgarden.invalid") && start.body.includes("Fjordsider") && start.body.includes('name="id" value="gs-1"'),
          "r3 the start page lists the owners of both sites, escaped");
        assertTrue(start.body.includes("http://opplevagent.localhost:4310/") && start.body.includes("http://finn-tannlege.localhost:4310/") && /form-action 'self' http:\/\/\*\.localhost:\*/.test(String(start.headers["content-security-policy"])) && start.headers["cache-control"] === "no-store",
          "r3 it links the three local sites on the request's port and sets its own policy");

        const rfbLogin = await call("POST", "/testmiljo/logg-inn", { site: "rfb", id: "rfb-1" });
        const gsLogin = await call("POST", "/testmiljo/logg-inn", { site: "opplevagent", id: "gs-1" });
        assertEq([rfbLogin.status, rfbLogin.headers.location, gsLogin.status, gsLogin.headers.location],
          [303, "http://rettfrabonden.localhost:4310/magic-link-verify?token=tok%20rfb%2F1", 303, "http://opplevagent.localhost:4310/kategori/gardssalg/eier/magic-link-verify?token=tok-gs-1"],
          "r4 logging in issues a link and follows it on the right site's ordinary verify route");
        assertEq(issued, ["rfb:rfb-1:eier@solgarden.invalid", "gs:gs-1:besok@fjordsider.invalid"], "r4 the link is issued for the listed owner's own address");

        issued.length = 0;
        const unknownOwner = await call("POST", "/testmiljo/logg-inn", { site: "rfb", id: "someone-else" });
        const crossSite = await call("POST", "/testmiljo/logg-inn", { site: "opplevagent", id: "rfb-1" });
        const dental = await call("POST", "/testmiljo/logg-inn", { site: "dental", id: "rfb-1" });
        const noSite = await call("POST", "/testmiljo/logg-inn", { id: "rfb-1" });
        assertEq([unknownOwner.status, crossSite.status, dental.status, noSite.status, issued.length], [404, 404, 400, 400, 0], "r5 an id that is not a listed owner of that site, or an unknown site, issues nothing");

        const transport = outbox.createOutboxTransport();
        await transport.sendMail({ from: "a@b.invalid", to: "eier@gard.invalid", subject: "Besøk <script>", text: "Ren tekst", html: '<p>Hei</p><a href="https://opplevagent.no/x">Bekreft</a>' });
        await transport.sendMail({ from: "a@b.invalid", to: "eier@gard.invalid", subject: "Bare tekst", text: "Linje <1>" });
        const [textOnly, withHtml] = outbox.listOutbox();
        const list = await call("GET", "/testmiljo/epost");
        assertTrue(list.status === 200 && list.body.includes("Besøk &lt;script&gt;") && !list.body.includes("<script>") && list.body.includes(`/testmiljo/epost/${withHtml.id}`), "r6 the outbox page lists captured e-mail, escaped");
        const one = await call("GET", `/testmiljo/epost/${withHtml.id}`);
        const body = await call("GET", `/testmiljo/epost/${withHtml.id}/html`);
        const textBody = await call("GET", `/testmiljo/epost/${textOnly.id}/html`);
        assertTrue(one.status === 200 && one.body.includes(`src="/testmiljo/epost/${withHtml.id}/html"`) && one.body.includes("Ren tekst"), "r7 one e-mail shows its headers, a frame for the HTML and the text version");
        assertTrue(body.status === 200 && body.body.includes('<a href="https://opplevagent.no/x">Bekreft</a>') && /default-src 'none'/.test(String(body.headers["content-security-policy"])) && !/script-src/.test(String(body.headers["content-security-policy"])),
          "r7 the HTML body is served alone under a policy that runs no script");
        assertTrue(textBody.body.includes("Linje &lt;1&gt;"), "r7 a text-only e-mail is shown escaped");
        const missing = await call("GET", "/testmiljo/epost/ffffffffffffffff");
        const cleared = await call("POST", "/testmiljo/epost/tom");
        assertEq([missing.status, cleared.status, cleared.headers.location, outbox.listOutbox().length], [404, 303, "/testmiljo/epost", 0], "r8 unknown id is a 404; emptying the outbox works");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        outbox.clearOutbox();
        restoreEnv();
      }
      const mounted: string[] = [];
      const fakeApp: any = { use(p: string) { mounted.push(p); } };
      delete process.env.TESTMILJO;
      routerMod.mountTestmiljo(fakeApp);
      enterTestmiljo(tmpDir);
      const logSpy = console.log;
      console.log = () => {};
      try { routerMod.mountTestmiljo(fakeApp); } finally { console.log = logSpy; }
      restoreEnv();
      assertEq(mounted, ["/testmiljo"], "r9 the router is mounted only in the test environment");
    }

    // ── d: the real dependencies, in-memory databases ─────────────────
    {
      const initMod = require("../database/init") as typeof import("../database/init");
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      const restoreDb = initMod.__pinInMemoryDbForTesting();
      const prevExperiences = process.env.EXPERIENCES_DB_PATH;
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      dbFactory.__resetDbFactoryForTesting();
      try {
        const db = initMod.__peekDbForTesting()!;
        const insertAgent = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
                                        VALUES (?, ?, 'Testprodusent', 'test', ?, 'https://example.test', 'producer', ?, '["vegetables"]')`);
        insertAgent.run("tm-owned", "Åkergården", "post@akergarden.invalid", "k-tm-owned");
        insertAgent.run("tm-unowned", "Uten eier", "post@uteneier.invalid", "k-tm-unowned");
        insertAgent.run("tm-pending", "Venter", "post@venter.invalid", "k-tm-pending");
        const insertClaim = db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at) VALUES (?, ?, 'Eier', ?, ?, ?)`);
        insertClaim.run("tm-c1", "tm-owned", "gammel@akergarden.invalid", "verified", "2026-01-01 10:00:00");
        insertClaim.run("tm-c2", "tm-owned", "eier@akergarden.invalid", "verified", "2026-06-01 10:00:00");
        insertClaim.run("tm-c3", "tm-pending", "noen@venter.invalid", "pending", null);

        const deps = routerMod.defaultTestmiljoDeps();
        assertEq(deps.rfbOwners(), [{ id: "tm-owned", name: "Åkergården", email: "eier@akergarden.invalid" }], "d1 RFB owners are profiles with a verified claim, with the latest verified address");
        const rfbToken = deps.issueRfbLogin("tm-owned", "eier@akergarden.invalid");
        const link = db.prepare(`SELECT agent_id, email, used, id FROM magic_links WHERE token = ?`).get(rfbToken) as any;
        assertTrue(/^[0-9a-f]{64}$/.test(rfbToken) && link?.agent_id === "tm-owned" && link?.email === "eier@akergarden.invalid" && link?.used === 0 && String(link?.id).startsWith("ml_"),
          "d2 RFB login issues an ordinary unused login link (the verify route makes the session)");

        const expDb = dbFactory.getDb("experiences");
        const insertProvider = expDb.prepare(`
          INSERT INTO experience_providers
            (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
             producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
          VALUES (?, ?, ?, 'experiences', ?, 1, 1, 'https://example.test', ?, 'claim', '[]', 'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 1, 0, '2026-11-01 10:00:00')`);
        insertProvider.run("tm-gs-owned", "Fjordsider", "fjordsider", "900000001", "besok@fjordsider.invalid");
        insertProvider.run("tm-gs-revoked", "Tilbakekalt", "tilbakekalt", "900000002", "post@tilbakekalt.invalid");
        insertProvider.run("tm-gs-unowned", "Uten eier", "uten-eier", "900000003", "post@uteneier.invalid");
        const insertGsClaim = expDb.prepare(`INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, revoked_at)
                                             VALUES (?, ?, ?, 'verified_domain_address', ?, ?, datetime('now'), datetime('now','+7 days'), ?)`);
        insertGsClaim.run("gsc_tm1", "tm-gs-owned", "eier@fjordsider.invalid", "tm-token-1", 1, null);
        insertGsClaim.run("gsc_tm2", "tm-gs-revoked", "eier@tilbakekalt.invalid", "tm-token-2", 1, "2026-11-02 10:00:00");
        insertGsClaim.run("gsc_tm3", "tm-gs-unowned", "eier@uteneier.invalid", "tm-token-3", 0, null);
        assertEq(deps.gardssalgOwners(), [{ id: "tm-gs-owned", name: "Fjordsider", detail: "fjordsider", email: "eier@fjordsider.invalid" }],
          "d3 gårdssalg owners are providers with a used, unrevoked claim");
        const gsToken = deps.issueGardssalgLogin("tm-gs-owned", "eier@fjordsider.invalid");
        const gsRow = expDb.prepare(`SELECT provider_id, email, used FROM gardssalg_claims WHERE token = ?`).get(gsToken) as any;
        assertTrue(typeof gsToken === "string" && gsToken.length >= 32 && gsRow?.provider_id === "tm-gs-owned" && gsRow?.email === "eier@fjordsider.invalid" && gsRow?.used === 0,
          "d4 gårdssalg login issues an ordinary unused login link");
      } finally {
        restoreDb();
        if (prevExperiences === undefined) delete process.env.EXPERIENCES_DB_PATH;
        else process.env.EXPERIENCES_DB_PATH = prevExperiences;
        dbFactory.__resetDbFactoryForTesting();
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("✗ unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runTestmiljoTests({ log: true }).then((r) => {
    console.log(`\ntestmiljo: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
