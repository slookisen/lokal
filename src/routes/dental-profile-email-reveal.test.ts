/**
 * dental-profile-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 2:
 * S-A1 (per-IP limit, «Vis e-post») and S-A3 (CCBot) on the finn-tannlege.com
 * clinic profile pages (/klinikk/id/:id and /klinikk/:slug) and the reveal
 * endpoint GET /klinikk/id/:id/epost.
 *
 * Fixture (in-memory dental DB, made-up names and addresses, fixed ids):
 * four clinics with an e-mail (one with characters HTML escapes), one without,
 * one rejected.
 *
 *   O   switch off (unset, and "off"): every profile has its mailto: line and
 *       JSON-LD `email` however many profiles one IP views, no Cache-Control,
 *       CCBot too; the reveal path answers the catch-all 404, byte for byte
 *   U   switch on, under the limit: page body byte-identical to switch off,
 *       plus Cache-Control: private (id and slug routes)
 *   L   switch on, over the limit: «Vis e-post» link, the address nowhere in
 *       the body (raw, escaped or URL-encoded), no JSON-LD `email`; a repeat
 *       view of an already counted profile is free
 *   N   a clinic without e-mail costs nothing and gets no «Vis e-post»
 *   C   CCBot: no address, no «Vis e-post», no JSON-LD `email`, first request
 *   S   one counter shared by the profile page, the reveal endpoint and the
 *       slice-1 REST answer (both directions)
 *   R   reveal endpoint: allowed (200 + mailto), over the limit (429, no
 *       address, Retry-After), CCBot (403), unknown / no e-mail / rejected
 *       (404); Cache-Control: private and X-Robots-Tag noindex
 *   G   the guard's log lines carry no e-mail address and no IP
 *   T   S-A4 trap path /kontakt-arkiv: disallowed in every robots.txt group
 *       (same text switch on or off); the hidden link only with the switch
 *       on, never in JSON-LD or the sitemap; switch off → fall-through, nothing
 *       recorded; a GET/HEAD blocks that IP for 24 h (injected clock) on the
 *       page, «Vis e-post» and REST; another IP unaffected; logs without IP
 *
 * The byte-identity of switch-off against main itself was checked when the
 * slice was built: 208 responses (7 fixture clinics, id and slug routes, the
 * reveal path, GET and HEAD, browser and CCBot, 40 views from one IP) had the
 * same status, headers and body before and after the change.
 *
 * Standalone: npx tsx src/routes/dental-profile-email-reveal.test.ts
 * Wired into tests/test.ts via runDentalProfileEmailRevealTests().
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

const BROWSER = "Mozilla/5.0 (test)";
const CCBOT = "CCBot/2.0 (https://commoncrawl.org/faq/)";

/** The JSON-LD blocks of a page, parsed. */
function jsonLdBlocks(html: string): any[] {
  return Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => {
    try { return JSON.parse(m[1]!); } catch { return null; }
  });
}

function jsonLdHasEmail(html: string): boolean {
  return JSON.stringify(jsonLdBlocks(html)).includes('"email"');
}

export async function runDentalProfileEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  // S-A4: with the switch on, a profile page carries the hidden trap link once;
  // apart from it the page is the switch-off page byte for byte.
  const { EMAIL_TRAP_LINK_HTML } = require("../services/email-reveal-trap") as typeof import("../services/email-reveal-trap");
  const noTrap = (html: string) => (html.split(EMAIL_TRAP_LINK_HTML).length === 2 ? html.replace(EMAIL_TRAP_LINK_HTML, "") : `[trap link count ${html.split(EMAIL_TRAP_LINK_HTML).length - 1}]`);

  const envKeys = ["DENTAL_DB_PATH", "EMAIL_REVEAL_GUARD_DENTAL", "EMAIL_REVEAL_PER_IP_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
  delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
  const prevMainDb = __peekDbForTesting();
  const mainDb = new Database(":memory:");
  __setDbForTesting(mainDb as any);
  __initSchemaForTesting(mainDb as any);

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const logLines: string[] = [];
  const freshGuard = (limit?: number) => {
    guard.__resetEmailRevealGuardForTesting({ log: (l) => logLines.push(l) });
    if (limit === undefined) delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    else process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = String(limit);
  };
  let closeHttp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const restRouter = (require("./dental") as typeof import("./dental")).default as any;

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (n: number, input: Record<string, unknown>, cols: Record<string, unknown> = {}) => {
      const id = `5b000000-0000-4000-8000-00000000000${n}`;
      store.createDentalAgent({ id, poststed: "OSLO", fylke: "Oslo", postnummer: "0150", organisasjonsform: "AS", ...input } as any);
      const all: Record<string, unknown> = { catalog_class: "klinikk", updated_at: "2026-10-30T00:00:00.000Z", ...cols };
      const keys = Object.keys(all);
      db.prepare(`UPDATE dental_agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => all[k]), id);
      return id;
    };
    const c = [
      { navn: "Visprøve Tannklinikk 1 AS", org_nr: "918990101", epost: "post1@visprove-klinikk.example" },
      { navn: "Visprøve Tannklinikk 2 AS", org_nr: "918990102", epost: "post2@visprove-klinikk.example" },
      { navn: "Visprøve Tannklinikk 3 AS", org_nr: "918990103", epost: "post3@visprove-klinikk.example" },
      // Characters HTML escapes (set by SQL: createDentalAgent validates the address).
      { navn: "Visprøve Tannklinikk 4 AS", org_nr: "918990104", epost: "a&b'4@visprove-klinikk.example" },
    ];
    const ids = c.map((row, i) => add(i + 1,
      { navn: row.navn, org_nr: row.org_nr, adresse: `Prøvegata ${i + 1}`, telefon: `2211010${i + 1}`, ...(i === 3 ? {} : { epost: row.epost }) },
      i === 3 ? { epost: row.epost } : {}));
    const idNoEmail = add(5, { navn: "Utenpost Visprøve AS", org_nr: "918990105", adresse: "Prøvegata 5", telefon: "22110105" });
    const idRejected = add(6, { navn: "Avvist Visprøve AS", org_nr: "918990106", adresse: "Prøvegata 6", epost: "avvist@visprove-klinikk.example" }, { verification_status: "rejected" });
    const emails = c.map((row) => row.epost);
    /** Every way an address could appear in a page. */
    const leaks = (html: string, email: string) => [email, email.replace(/&/g, "&amp;").replace(/'/g, "&#39;"), encodeURIComponent(email), email.replace(/&/g, "&amp;").replace(/'/g, "&#039;")]
      .some((form) => html.includes(form)) || html.includes(email.split("@")[0]! + "@");

    // ── HTTP app (trust proxy as in index.ts, so X-Forwarded-For picks the test IP) ──
    const express = require("express") as typeof import("express");
    const http = require("http") as typeof import("http");
    const app = express();
    app.set("trust proxy", true);
    app.use("/api/tannlege", restRouter);
    app.use(dentalSeo.default as any);
    const httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    closeHttp = () => new Promise<void>((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); });
    const port = (httpServer.address() as import("net").AddressInfo).port;
    const get = (path: string, ip: string, ua = BROWSER): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { "x-forwarded-for": ip, "user-agent": ua } }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
        });
        r.on("error", reject);
        r.end();
      });
    const page = (id: string, ip: string, ua?: string) => get(`/klinikk/id/${id}`, ip, ua);
    const slugPage = (i: number, ip: string, ua?: string) => get(`/klinikk/${dentalSeo.slugifyClinic(c[i]!.navn, c[i]!.org_nr)}`, ip, ua);
    const reveal = (id: string, ip: string, ua?: string) => get(`/klinikk/id/${id}/epost`, ip, ua);
    const rest = (id: string, ip: string) => get(`/api/tannlege/agents/${id}`, ip);
    const mailtoOf = (email: string) => `<a href="mailto:${email.replace(/&/g, "&amp;").replace(/'/g, "&#39;")}">`;
    const revealLink = (id: string) => `<a href="/klinikk/id/${id}/epost" rel="nofollow">Vis e-post</a>`;
    const shows = (r: HttpResult, i: number) => r.text.includes(mailtoOf(emails[i]!)) && JSON.stringify(jsonLdBlocks(r.text)).includes(JSON.stringify(emails[i]));
    const isRevealOnly = (r: HttpResult, i: number) =>
      r.status === 200 && r.text.includes(revealLink(ids[i]!)) && !leaks(r.text, emails[i]!) && !jsonLdHasEmail(r.text);

    // ── O: switch off ─────────────────────────────────────────────────────
    freshGuard(1);
    const offPages: HttpResult[] = [];
    for (const [i, id] of ids.entries()) {
      const r = await page(id, "203.0.113.10");
      offPages.push(r);
      ok(r.status === 200 && shows(r, i), `O1: switch off -> clinic ${i + 1} has its mailto: and JSON-LD email`);
      eq(r.headers["cache-control"], undefined, `O2: switch off -> no Cache-Control on clinic ${i + 1}`);
      ok(!r.text.includes("Vis e-post"), `O3: switch off -> no «Vis e-post» on clinic ${i + 1}`);
    }
    {
      let all = true;
      for (let n = 0; n < 12; n++) {
        const i = n % ids.length;
        const r = await page(ids[i]!, "203.0.113.10");
        all = all && r.text === offPages[i]!.text;
      }
      ok(all, "O4: switch off, limit 1 -> 12 more views from one IP are byte-identical (no limit)");
      const cc = await page(ids[0]!, "203.0.113.11", CCBOT);
      ok(cc.text === offPages[0]!.text, "O5: switch off -> CCBot gets the page as everyone else (S-A3 only with the switch on)");
      process.env.EMAIL_REVEAL_GUARD_DENTAL = "off";
      ok((await page(ids[1]!, "203.0.113.12")).text === offPages[1]!.text, "O6: switch \"off\" -> same as unset");
      delete process.env.EMAIL_REVEAL_GUARD_DENTAL;
      const catchAll = await get(`/finnes/ikke/${ids[0]}`, "203.0.113.10");
      const offReveal = await reveal(ids[0]!, "203.0.113.10");
      ok(offReveal.status === 404 && offReveal.text === catchAll.text, "O7: switch off -> the reveal path is the catch-all 404, byte for byte");
      ok(!leaks(offReveal.text, emails[0]!), "O8: switch off -> the reveal path gives no address");
      eq([offReveal.headers["cache-control"], offReveal.headers["x-robots-tag"]], [undefined, undefined], "O9: switch off -> the reveal path has none of the guard's headers");
      eq(logLines.length, 0, "O10: switch off -> no guard log line");
    }

    process.env.EMAIL_REVEAL_GUARD_DENTAL = "on";

    // ── U: under the limit ────────────────────────────────────────────────
    freshGuard();
    for (const [i, id] of ids.entries()) {
      const r = await page(id, "203.0.113.20");
      ok(noTrap(r.text) === offPages[i]!.text, `U1: switch on, under the limit -> clinic ${i + 1} byte-identical to switch off but for the hidden trap link`);
      eq(r.headers["cache-control"], "private", `U2: switch on -> Cache-Control: private on clinic ${i + 1}`);
    }
    {
      const r = await slugPage(0, "203.0.113.21");
      ok(r.status === 200 && shows(r, 0) && r.headers["cache-control"] === "private", "U3: the /klinikk/:slug route under the limit: mailto:, JSON-LD email, private");
    }

    // ── L: over the limit ─────────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.30";
      const p0 = await page(ids[0]!, ip);
      const p1 = await page(ids[1]!, ip);
      ok(shows(p0, 0) && shows(p1, 1), "L1: limit 2 -> the first two profiles show the e-mail");
      const p2 = await page(ids[2]!, ip);
      ok(isRevealOnly(p2, 2), "L2: the third profile -> «Vis e-post», no address anywhere in the body, no JSON-LD email");
      eq(p2.headers["cache-control"], "private", "L3: over the limit -> Cache-Control: private");
      ok(!p2.text.includes("mailto:post") && p2.text.includes("mailto:kontakt@finn-tannlege.com"), "L4: over the limit -> no clinic mailto:, the platform address stays");
      ok(jsonLdBlocks(p2.text).some((b) => b && b["@type"] === "Dentist"), "L5: over the limit -> the Dentist JSON-LD is still there (only `email` is left out)");
      const p3 = await page(ids[3]!, ip);
      ok(isRevealOnly(p3, 3), "L6: an address with &' is not leaked raw, escaped or encoded");
      const again = await page(ids[0]!, ip);
      ok(noTrap(again.text) === offPages[0]!.text, "L7: a repeat view of a counted profile is free (still byte-identical to switch off but for the hidden trap link)");
      const slug = await slugPage(2, ip);
      ok(isRevealOnly(slug, 2), "L8: the /klinikk/:slug route over the limit: «Vis e-post», no address");
      ok(shows(await page(ids[2]!, "203.0.113.31"), 2), "L9: another IP has its own budget");
    }

    // ── N: no e-mail stored ───────────────────────────────────────────────
    freshGuard(1);
    {
      const ip = "203.0.113.40";
      const n = await page(idNoEmail, ip);
      ok(n.status === 200 && !n.text.includes("Vis e-post") && !jsonLdHasEmail(n.text), "N1: a clinic without e-mail -> no «Vis e-post», no JSON-LD email");
      eq(n.headers["cache-control"], "private", "N2: ... and still Cache-Control: private");
      ok(shows(await page(ids[0]!, ip), 0), "N3: viewing it cost nothing (limit 1, the next profile still shows its e-mail)");
    }

    // ── C: CCBot ──────────────────────────────────────────────────────────
    freshGuard();
    for (const ua of [CCBOT, "Mozilla/5.0 (compatible; ccbot/2.0)"]) {
      const r = await page(ids[0]!, "203.0.113.50", ua);
      ok(r.status === 200 && !leaks(r.text, emails[0]!) && !r.text.includes("Vis e-post") && !jsonLdHasEmail(r.text) && !r.text.includes("mailto:post"),
        `C1: ${ua} on its first request -> no address, no «Vis e-post», no JSON-LD email`);
      eq(r.headers["cache-control"], "private", `C2: ${ua} -> Cache-Control: private`);
      const s = await slugPage(1, "203.0.113.50", ua);
      ok(!leaks(s.text, emails[1]!) && !s.text.includes("Vis e-post"), `C3: ${ua} on /klinikk/:slug -> no address, no «Vis e-post»`);
    }
    ok(shows(await page(ids[0]!, "203.0.113.50"), 0), "C4: CCBot used none of the IP's budget (a browser from that IP still gets e-mail)");

    // ── S: one counter for page, reveal endpoint and REST ─────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.60";
      const r0 = await rest(ids[0]!, ip);
      const r1 = await rest(ids[1]!, ip);
      ok(JSON.parse(r0.text).agent.epost === emails[0] && JSON.parse(r1.text).agent.epost === emails[1], "S1: REST /agents/:id spends the budget (2 of 2)");
      ok(isRevealOnly(await page(ids[2]!, ip), 2), "S2: ... so the profile page of a third clinic gets «Vis e-post»");
      ok(shows(await page(ids[1]!, ip), 1), "S3: a profile already counted by REST is free on its page");
      eq((await reveal(ids[2]!, ip)).status, 429, "S4: ... and the reveal endpoint of the third is over the limit too");
    }
    freshGuard(2);
    {
      const ip = "203.0.113.61";
      ok(shows(await page(ids[0]!, ip), 0), "S5: page 1 of 2");
      eq((await reveal(ids[1]!, ip)).status, 200, "S6: reveal 2 of 2");
      eq(JSON.parse((await rest(ids[2]!, ip)).text).agent.epost, null, "S7: pages and reveal spent the budget REST shares (epost null)");
      eq(JSON.parse((await rest(ids[0]!, ip)).text).agent.epost, emails[0], "S8: REST for a profile counted by its page is free");
    }

    // ── R: the reveal endpoint ────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.70";
      const a = await reveal(ids[3]!, ip);
      ok(a.status === 200 && a.text.includes(mailtoOf(emails[3]!)), "R1: within the limit -> 200 with the mailto: link");
      eq([a.headers["cache-control"], a.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "R2: Cache-Control: private, X-Robots-Tag noindex");
      ok(a.text.includes('<meta name="robots" content="noindex, nofollow">') && !a.text.includes('rel="canonical"'), "R3: the reveal page is noindex and has no canonical");
      ok(a.text.includes(`href="${dentalSeo.clinicProfileUrl({ navn: c[3]!.navn, org_nr: c[3]!.org_nr } as any)}"`), "R4: it links back to the profile");
      eq((await reveal(ids[0]!, ip)).status, 200, "R5: 2 of 2 -> 200");
      const over = await reveal(ids[1]!, ip);
      ok(over.status === 429 && !leaks(over.text, emails[1]!) && over.text.includes("Prøv igjen senere"), "R6: over the limit -> 429, «prøv igjen senere», no address");
      eq([over.headers["cache-control"], over.headers["retry-after"]], ["private", "3600"], "R7: 429 -> Cache-Control: private, Retry-After");
      eq((await reveal(ids[3]!, ip)).status, 200, "R8: revealing a counted profile again is free");
      const cc = await reveal(ids[2]!, "203.0.113.71", CCBOT);
      ok(cc.status === 403 && !leaks(cc.text, emails[2]!), "R9: CCBot -> 403, no address");
      eq((await reveal("5b000000-0000-4000-8000-0000000000ff", ip)).status, 404, "R10: unknown id -> 404");
      eq((await reveal(idNoEmail, ip)).status, 404, "R11: a clinic without e-mail -> 404");
      const rej = await reveal(idRejected, "203.0.113.72");
      ok(rej.status === 404 && !rej.text.includes("avvist@"), "R12: a rejected clinic -> 404, no address");
      ok((await page(idRejected, "203.0.113.72")).status === 404, "R13: the rejected profile itself stays 404");
      eq((await reveal("abc/../x", ip)).status, 404, "R14: a malformed id -> 404");
    }

    // ── G: log lines ──────────────────────────────────────────────────────
    {
      ok(logLines.length > 0, "G1: withheld e-mail was logged");
      const joined = logLines.join("\n");
      ok(![...emails, "avvist@visprove-klinikk.example", "visprove-klinikk"].some((e) => joined.includes(e)), "G2: no log line carries an e-mail address");
      ok(!/203\.0\.113\./.test(joined), "G3: no log line carries an IP");
      ok(logLines.every((l) => { try { const o = JSON.parse(l); return o.evt === "email_reveal_withheld" && o.host === "dental"; } catch { return false; } }), "G4: every line is the guard's JSON line for dental");
    }

    // ── T: the trap path (S-A4) ─────────────────────────────────────────
    {
      const trap = require("../services/email-reveal-trap") as typeof import("../services/email-reveal-trap");
      const robotsParser = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
      const jsonLdText = (html: string) => Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)).map((m) => m[1]).join("\n");
      const trapLinks = (html: string) => html.split(trap.EMAIL_TRAP_LINK_HTML).length - 1;
      const http2 = require("http") as typeof import("http");
      const head = (path: string, ip: string): Promise<number> => new Promise((resolve, reject) => {
        const r = http2.request({ host: "127.0.0.1", port, path, method: "HEAD", headers: { "x-forwarded-for": ip, "user-agent": BROWSER } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        r.on("error", reject);
        r.end();
      });
      let now = 50_000_000;
      const trapLines: string[] = [];
      guard.__resetEmailRevealGuardForTesting({ now: () => now, log: (l) => trapLines.push(l) });
      delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
      const SW = "EMAIL_REVEAL_GUARD_DENTAL";

      // robots.txt: every group disallows the trap path; same text switch on or off
      delete process.env[SW];
      const robotsOff = await get("/robots.txt", "203.0.113.200");
      process.env[SW] = "on";
      const robotsOn = await get("/robots.txt", "203.0.113.200");
      ok(robotsOff.status === 200 && robotsOff.text === robotsOn.text, "T1: robots.txt is the same with the switch on and off");
      const agents = Array.from(robotsOn.text.matchAll(/^User-agent: (.+)$/gm)).map((m) => m[1]!.trim());
      ok(agents.length > 15 && agents.includes("*") && agents.includes("Googlebot") && agents.includes("GPTBot"), "T2: robots.txt has the * group and the named groups");
      const allowedFor = agents.filter((ua) => {
        const policy = robotsParser.parseRobotsTxt(robotsOn.text, ua === "*" ? "some-unlisted-bot" : ua);
        return robotsParser.isPathAllowed(policy, "/kontakt-arkiv/") || robotsParser.isPathAllowed(policy, "/kontakt-arkiv");
      });
      eq(allowedFor, [], "T3: no robots.txt group (incl. *) may fetch the trap path");
      const groups = robotsOn.text.split(/\n\n/).filter((g) => /^User-agent: /m.test(g));
      ok(groups.length === agents.length && groups.every((g) => g.includes(trap.EMAIL_TRAP_ROBOTS_DISALLOW)), "T4: the Disallow line is repeated inside every User-agent group");
      ok(robotsParser.isPathAllowed(robotsParser.parseRobotsTxt(robotsOn.text, "Googlebot"), `/klinikk/id/${ids[0]}`), "T5: profile pages stay crawlable");

      // switch off: no link, the path falls through, nothing recorded
      delete process.env[SW];
      const offPage = await ((ip: string) => page(ids[0]!, ip))("203.0.113.201");
      eq(trapLinks(offPage.text), 0, "T6: switch off -> no trap link on the profile page");
      ok(!offPage.text.includes("kontakt-arkiv"), "T6b: ... the path is nowhere in the page");
      const offTrap = await get("/kontakt-arkiv/", "203.0.113.201");
      const fallThrough = await get("/kontakt-arkiv-finnes-ikke/", "203.0.113.201");
      ok(offTrap.status === fallThrough.status && offTrap.text === fallThrough.text.replace(/kontakt-arkiv-finnes-ikke/g, "kontakt-arkiv") && offTrap.headers["cache-control"] === fallThrough.headers["cache-control"],
        "T7: switch off -> the trap path is the router's ordinary fall-through answer");
      eq(trapLines.length, 0, "T8: switch off -> nothing logged");
      process.env[SW] = "on";
      ok(((r: HttpResult) => shows(r, 0))(await ((ip: string) => page(ids[0]!, ip))("203.0.113.201")), "T9: a hit while the switch was off left no block");

      // switch on: link on the page, not in JSON-LD, not in the sitemap
      const onPage = await ((ip: string) => page(ids[0]!, ip))("203.0.113.202");
      eq(trapLinks(onPage.text), 1, "T10: switch on -> the hidden trap link once on the profile page");
      ok(!jsonLdText(onPage.text).includes("kontakt-arkiv"), "T11: ... and not in JSON-LD");
      const sitemap = await get("/sitemap.xml", "203.0.113.202");
      ok(sitemap.status === 200 && !sitemap.text.includes("kontakt-arkiv"), "T12: the trap path is not in the sitemap");

      // a hit blocks this IP on every surface of the host
      const ip = "203.0.113.210";
      ok(((r: HttpResult) => shows(r, 1))(await ((ip: string) => slugPage(1, ip))(ip)), "T13: before the hit the page shows the e-mail");
      const hit = await get("/kontakt-arkiv/", ip);
      ok(hit.status === 200 && hit.text.includes("Ingen oppføringer"), "T14: the trap answers a small 200 page");
      eq([hit.headers["x-robots-tag"], hit.headers["cache-control"]], ["noindex, nofollow", "no-store"], "T15: ... noindex, nofollow and no-store");
      const blockedPage = await ((ip: string) => slugPage(1, ip))(ip);
      ok(blockedPage.status === 200 && !leaks(blockedPage.text, emails[1]!) && !jsonLdText(blockedPage.text).includes('"email"') && blockedPage.text.includes("Vis e-post"),
        "T16: blocked -> the page renders, «Vis e-post», no address, no JSON-LD email (a profile it saw before too)");
      eq((await ((ip: string) => reveal(ids[2]!, ip))(ip)).status, 429, "T17: blocked -> the reveal endpoint answers as over the limit (429)");
      ok(((r: HttpResult) => shows(r, 2))(await ((ip: string) => page(ids[2]!, ip))("203.0.113.211")), "T18: another IP is unaffected");
      const blockedRest = await rest(ids[2]!, ip);
      const freeRest = await rest(ids[2]!, "203.0.113.211");
      ok(blockedRest.status === 200 && !blockedRest.text.includes(emails[2]!) && freeRest.text.includes(emails[2]!), "T19: blocked -> REST /api/tannlege/agents/:id without e-mail (same counter); another IP gets it");
      eq(await head("/kontakt-arkiv/noe", "203.0.113.212"), 200, "T20: HEAD on a path below the trap is the trap too");
      ok(!((r: HttpResult) => shows(r, 0))(await ((ip: string) => page(ids[0]!, ip))("203.0.113.212")), "T21: ... and blocks that IP");
      now += 24 * 60 * 60_000 - 1;
      ok(!((r: HttpResult) => shows(r, 0))(await ((ip: string) => page(ids[0]!, ip))(ip)), "T22: still blocked just before 24 h");
      now += 1;
      ok(((r: HttpResult) => shows(r, 0))(await ((ip: string) => page(ids[0]!, ip))(ip)), "T23: after 24 h the e-mail is back");
      const joined = trapLines.join("\n");
      ok(trapLines.some((l) => JSON.parse(l).evt === "email_reveal_trap_hit" && JSON.parse(l).host === "dental"), "T24: the hit is logged (email_reveal_trap_hit, host dental)");
      ok(trapLines.some((l) => JSON.parse(l).reason === "trap_blocked"), "T25: withheld answers are logged with reason trap_blocked");
      ok(!((text: string) => [...emails, "visprove-klinikk"].some((e) => text.includes(e)))(joined) && !/203\.0\.113\./.test(joined), "T26: no log line carries an e-mail address or an IP");
      delete process.env[SW];
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (closeHttp) await closeHttp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    if (prevMainDb) __setDbForTesting(prevMainDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalProfileEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
