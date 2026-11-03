/**
 * rfb-profile-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 3:
 * S-A1 (per-IP limit, «Vis e-post») and S-A3 (CCBot) on the rettfrabonden.com
 * producer profile page GET /produsent/:slug (producer and umbrella contact
 * card, JSON-LD `email`) and the reveal endpoint GET /produsent/:slug/epost.
 *
 * Fixture (own in-memory main DB, made-up names and addresses): three
 * producers with an e-mail (one with characters HTML escapes), one producer
 * without, one umbrella (market network) with an e-mail, one non-producer
 * (role logistics) with an e-mail.
 *
 *   O   switch off (unset, and "off"): every profile has its mailto: line and
 *       JSON-LD `email` (umbrella: mailto:) however many profiles one IP
 *       views, no Cache-Control, CCBot too; the reveal path answers the
 *       app's fall-through 404, byte for byte, with no guard headers
 *   U   switch on, under the limit: page body byte-identical to switch off,
 *       plus Cache-Control: private (producer, umbrella, /en)
 *   L   switch on, over the limit: «Vis e-post» link, the address nowhere in
 *       the body (raw, escaped or URL-encoded), no producer mailto: (only the
 *       platform's kontakt@ may remain), no JSON-LD `email`; a repeat view of
 *       an already counted profile is free; another IP has its own budget;
 *       the default limit (30) lets 30 distinct profiles through and not the
 *       31st
 *   N   a producer without e-mail costs nothing and gets no «Vis e-post»
 *   C   CCBot (any case): no address, no «Vis e-post», no JSON-LD `email`, on
 *       the first request; it spends none of the IP's budget
 *   S   one RFB counter shared by the profile page and the reveal endpoint
 *       (both directions)
 *   R   reveal endpoint: allowed (200 + mailto), over the limit (429, no
 *       address, Retry-After), CCBot (403), unknown slug / no e-mail /
 *       non-producer (404); Cache-Control: private, X-Robots-Tag and meta
 *       noindex
 *   G   the guard's log lines carry no e-mail address and no IP
 *
 * The byte-identity of switch-off against main itself was checked when the
 * slice was built (same scenario rendered from a clean main checkout and from
 * this branch; see the PR).
 *
 * Standalone: npx tsx src/routes/rfb-profile-email-reveal.test.ts
 * Wired into tests/test.ts via runRfbProfileEmailRevealTests().
 */

import Database from "better-sqlite3";

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

/**
 * Every address after a mailto: anywhere in a page (href or not). The page's
 * inline click-tracking script mentions «mailto:/tel:» in comments; those
 * carry no address and are not counted.
 */
function mailtos(html: string): string[] {
  return Array.from(html.matchAll(/mailto:([^"'\s<>]*@[^"'\s<>]*)/gi)).map((m) => m[1]!);
}

export const RFB_EMAIL_FIXTURE = {
  producers: [
    { id: "rer-p1", name: "Visprøve Gård En", email: "post1@visprove-gard.example" },
    { id: "rer-p2", name: "Visprøve Gård To", email: "post2@visprove-gard.example" },
    { id: "rer-p3", name: "Visprøve Gård Tre", email: "a&b3@visprove-gard.example" },
  ],
  noEmail: { id: "rer-p4", name: "Utenpost Visprøve Gård" },
  umbrella: { id: "rer-u1", name: "Visprøve Marked Nettverk", email: "marked@visprove-gard.example" },
  logistics: { id: "rer-l1", name: "Visprøve Logistikk", email: "logistikk@visprove-gard.example" },
};

/** Seeds the fixture into a fresh main DB (also used by the one-off main-vs-branch comparison). */
export function seedRfbEmailFixture(db: Database.Database, extraProducers = 0): Array<{ id: string; name: string; email: string }> {
  const insertAgent = (id: string, name: string, role = "producer") => db.prepare(
    `INSERT INTO agents (
      id, name, description, provider, contact_email, url, role, api_key,
      categories, tags, skills, capabilities, languages, city, lat, lng,
      trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
      total_interactions, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
      '["vegetables"]', '[]', '[]', '{}', '["no"]', 'Voss', 60.63, 6.42,
      0.5, 1, 0, 0, 0, 0, 0, '2026-10-01 00:00:00', '2026-10-01 00:00:00')`,
  ).run(id, name, "Liten gård som selger grønnsaker rett fra tunet hele året.", name, `kontakt-${id}@agents.example`, `https://${id}.example.no`, role, `key-${id}`);
  const insertKnowledge = (id: string, email: string | null) => db.prepare(
    `INSERT INTO agent_knowledge (agent_id, address, postal_code, phone, email, website, about, products, updated_at, created_at)
     VALUES (?, 'Gardsvegen 1', '5700', '55512345', ?, ?, 'Vi dyrker poteter og gulrøtter.', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  ).run(id, email, `https://${id}.example.no`, JSON.stringify([{ name: "Poteter", price: "30" }]));

  const all: Array<{ id: string; name: string; email: string }> = [];
  for (const p of RFB_EMAIL_FIXTURE.producers) { insertAgent(p.id, p.name); insertKnowledge(p.id, p.email); all.push(p); }
  insertAgent(RFB_EMAIL_FIXTURE.noEmail.id, RFB_EMAIL_FIXTURE.noEmail.name);
  insertKnowledge(RFB_EMAIL_FIXTURE.noEmail.id, null);
  const u = RFB_EMAIL_FIXTURE.umbrella;
  insertAgent(u.id, u.name);
  insertKnowledge(u.id, u.email);
  db.prepare("UPDATE agents SET umbrella_type = 'market_network' WHERE id = ?").run(u.id);
  const l = RFB_EMAIL_FIXTURE.logistics;
  insertAgent(l.id, l.name, "logistics");
  insertKnowledge(l.id, l.email);
  for (let n = 0; n < extraProducers; n++) {
    const p = { id: `rer-x${String(n).padStart(2, "0")}`, name: `Massevis Gård ${String(n).padStart(2, "0")}`, email: `x${n}@massevis-gard.example` };
    insertAgent(p.id, p.name);
    insertKnowledge(p.id, p.email);
    all.push(p);
  }
  return all;
}

export async function runRfbProfileEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["EMAIL_REVEAL_GUARD_RFB", "EMAIL_REVEAL_PER_IP_PER_HOUR"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  delete process.env.EMAIL_REVEAL_GUARD_RFB;
  delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevMainDb = initMod.__peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  // The related-producer blocks order ties by SQL RANDOM(); a constant makes
  // two renders of one page comparable byte for byte.
  testDb.function("random", () => 0);

  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const logLines: string[] = [];
  const freshGuard = (limit?: number) => {
    guard.__resetEmailRevealGuardForTesting({ log: (l) => logLines.push(l) });
    if (limit === undefined) delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    else process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = String(limit);
  };
  const clearRegistry = () => {
    const reg = (require("../services/marketplace-registry") as any).marketplaceRegistry;
    reg._agentsCache = null;
    reg._statsCache = null;
    reg._slugIdMap = null;
  };
  let closeHttp: (() => Promise<void>) | null = null;
  const prevConsoleLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const extra = seedRfbEmailFixture(testDb, 32);
    clearRegistry();
    try { delete require.cache[require.resolve("./seo")]; } catch { /* not loaded yet */ }
    const seoMod = require("./seo") as typeof import("./seo");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

    const P = RFB_EMAIL_FIXTURE.producers;
    const U = RFB_EMAIL_FIXTURE.umbrella;
    const slugs = P.map((p) => slugify(p.name));
    const emails = P.map((p) => p.email);
    const umbSlug = slugify(U.name);
    const noEmailSlug = slugify(RFB_EMAIL_FIXTURE.noEmail.name);
    const logisticsSlug = slugify(RFB_EMAIL_FIXTURE.logistics.name);
    const massSlugs = extra.slice(P.length).map((p) => slugify(p.name));
    const massEmails = extra.slice(P.length).map((p) => p.email);
    const allEmails = [...emails, U.email, RFB_EMAIL_FIXTURE.logistics.email, ...massEmails];

    /** Every way an address could appear in a page. */
    const leaks = (html: string, email: string) => [
      email,
      email.replace(/&/g, "&amp;"),
      email.replace(/&/g, "&amp;").replace(/'/g, "&#39;"),
      encodeURIComponent(email),
      JSON.stringify(email).slice(1, -1),
    ].some((form) => html.includes(form)) || html.includes(email.split("@")[0]! + "@");

    // ── HTTP app (trust proxy as in index.ts, so X-Forwarded-For picks the test IP) ──
    const express = require("express") as typeof import("express");
    const http = require("http") as typeof import("http");
    const app = express();
    app.set("trust proxy", true);
    app.use(langMiddleware);
    app.use("/", seoMod.default as any);
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
    const page = (slug: string, ip: string, ua?: string) => get(`/produsent/${slug}`, ip, ua);
    const reveal = (slug: string, ip: string, ua?: string) => get(`/produsent/${slug}/epost`, ip, ua);
    const mailtoOf = (email: string) => `href="mailto:${email}"`;
    const revealLink = (slug: string, prefix = "") => `<a href="${prefix}/produsent/${slug}/epost" rel="nofollow">`;
    const shows = (r: HttpResult, i: number) => r.text.includes(mailtoOf(emails[i]!)) && JSON.stringify(jsonLdBlocks(r.text)).includes(JSON.stringify(emails[i]));
    const onlyPlatformMailto = (html: string) => mailtos(html).every((m) => /^kontakt@/i.test(m));
    const isRevealOnly = (r: HttpResult, slug: string, email: string) =>
      r.status === 200 && r.text.includes(revealLink(slug)) && r.text.includes(">Vis e-post</a>") && !leaks(r.text, email) && !jsonLdHasEmail(r.text) && onlyPlatformMailto(r.text);

    // ── O: switch off ─────────────────────────────────────────────────────
    freshGuard(1);
    const offPages: HttpResult[] = [];
    for (const [i, slug] of slugs.entries()) {
      const r = await page(slug, "203.0.113.10");
      offPages.push(r);
      ok(r.status === 200 && shows(r, i), `O1: switch off -> producer ${i + 1} has its mailto: and JSON-LD email`);
      eq(r.headers["cache-control"], undefined, `O2: switch off -> no Cache-Control on producer ${i + 1}`);
      ok(!r.text.includes("Vis e-post") && !r.text.includes("/epost"), `O3: switch off -> no «Vis e-post» on producer ${i + 1}`);
    }
    const offUmb = await page(umbSlug, "203.0.113.10");
    ok(offUmb.status === 200 && offUmb.text.includes(mailtoOf(U.email)), "O4: switch off -> the umbrella card has its mailto:");
    const offEn = await get(`/en/produsent/${slugs[0]}`, "203.0.113.10");
    ok(offEn.status === 200 && offEn.text.includes(mailtoOf(emails[0]!)), "O5: switch off -> /en page has the mailto:");
    {
      let all = true;
      for (let n = 0; n < 12; n++) {
        const i = n % slugs.length;
        const r = await page(slugs[i]!, "203.0.113.10");
        all = all && r.text === offPages[i]!.text && r.headers["cache-control"] === undefined;
      }
      ok(all, "O6: switch off, limit 1 -> 12 more views from one IP are byte-identical (no limit)");
      const cc = await page(slugs[0]!, "203.0.113.11", CCBOT);
      ok(cc.text === offPages[0]!.text, "O7: switch off -> CCBot gets the page as everyone else (S-A3 only with the switch on)");
      process.env.EMAIL_REVEAL_GUARD_RFB = "off";
      ok((await page(slugs[1]!, "203.0.113.12")).text === offPages[1]!.text, "O8: switch \"off\" -> same as unset");
      delete process.env.EMAIL_REVEAL_GUARD_RFB;
      const fallThrough = await get(`/produsent/${slugs[0]}/finnes-ikke`, "203.0.113.10");
      const offReveal = await reveal(slugs[0]!, "203.0.113.10");
      ok(offReveal.status === 404 && offReveal.text === fallThrough.text.replace("/finnes-ikke", "/epost"), "O9: switch off -> the reveal path is the app's fall-through 404, byte for byte");
      ok(!leaks(offReveal.text, emails[0]!), "O10: switch off -> the reveal path gives no address");
      eq([offReveal.headers["cache-control"], offReveal.headers["x-robots-tag"], offReveal.headers["retry-after"]], [undefined, undefined, undefined], "O11: switch off -> the reveal path has none of the guard's headers");
      eq(logLines.length, 0, "O12: switch off -> no guard log line");
    }

    process.env.EMAIL_REVEAL_GUARD_RFB = "on";

    // ── U: under the limit ────────────────────────────────────────────────
    freshGuard();
    for (const [i, slug] of slugs.entries()) {
      const r = await page(slug, "203.0.113.20");
      ok(r.text === offPages[i]!.text, `U1: switch on, under the limit -> producer ${i + 1} byte-identical to switch off`);
      eq(r.headers["cache-control"], "private", `U2: switch on -> Cache-Control: private on producer ${i + 1}`);
    }
    {
      const r = await page(umbSlug, "203.0.113.20");
      ok(r.text === offUmb.text && r.headers["cache-control"] === "private", "U3: the umbrella page under the limit: byte-identical body, private");
      const en = await get(`/en/produsent/${slugs[0]}`, "203.0.113.20");
      ok(en.text === offEn.text && en.headers["cache-control"] === "private", "U4: /en under the limit (profile already counted): byte-identical body, private");
    }

    // ── L: over the limit ─────────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.30";
      const p0 = await page(slugs[0]!, ip);
      const p1 = await page(slugs[1]!, ip);
      ok(shows(p0, 0) && shows(p1, 1), "L1: limit 2 -> the first two profiles show the e-mail");
      const p2 = await page(slugs[2]!, ip);
      ok(isRevealOnly(p2, slugs[2]!, emails[2]!), "L2: the third profile -> «Vis e-post», no address anywhere (incl. &-escaped), no producer mailto:, no JSON-LD email");
      eq(p2.headers["cache-control"], "private", "L3: over the limit -> Cache-Control: private");
      ok(jsonLdBlocks(p2.text).some((b) => b && b["@type"] === "LocalBusiness" && b.telephone), "L4: over the limit -> the LocalBusiness JSON-LD is still there (only `email` is left out)");
      ok(p2.text.includes("tel:55512345"), "L5: over the limit -> the phone line stays");
      const umb = await page(umbSlug, ip);
      ok(isRevealOnly(umb, umbSlug, U.email), "L6: the umbrella card over the limit -> «Vis e-post», no address");
      const en = await get(`/en/produsent/${slugs[2]}`, ip);
      ok(en.status === 200 && en.text.includes(revealLink(slugs[2]!, "/en")) && en.text.includes(">Show e-mail</a>") && !leaks(en.text, emails[2]!) && !jsonLdHasEmail(en.text),
        "L7: /en over the limit -> «Show e-mail» to /en/produsent/:slug/epost, no address");
      const again = await page(slugs[0]!, ip);
      ok(again.text === offPages[0]!.text, "L8: a repeat view of a counted profile is free (still byte-identical to switch off)");
      ok(shows(await page(slugs[2]!, "203.0.113.31"), 2), "L9: another IP has its own budget");
    }
    freshGuard(); // default limit 30
    {
      const ip = "203.0.113.32";
      let first30 = true;
      for (let n = 0; n < 30; n++) {
        const r = await page(massSlugs[n]!, ip);
        first30 = first30 && r.text.includes(mailtoOf(massEmails[n]!)) && jsonLdHasEmail(r.text);
      }
      ok(first30, "L10: default limit -> 30 distinct profiles from one IP all show the e-mail");
      const r31 = await page(massSlugs[30]!, ip);
      ok(isRevealOnly(r31, massSlugs[30]!, massEmails[30]!), "L11: the 31st distinct profile -> «Vis e-post», no address, no JSON-LD email");
      const r1 = await page(massSlugs[0]!, ip);
      ok(r1.text.includes(mailtoOf(massEmails[0]!)), "L12: ... while the 1st, seen again, still shows (counts once)");
      eq((await reveal(massSlugs[31]!, ip)).status, 429, "L13: ... and the reveal endpoint for a 32nd is 429");
    }

    // ── N: no e-mail stored ───────────────────────────────────────────────
    freshGuard(1);
    {
      const ip = "203.0.113.40";
      const n = await page(noEmailSlug, ip);
      ok(n.status === 200 && !n.text.includes("Vis e-post") && !jsonLdHasEmail(n.text) && onlyPlatformMailto(n.text), "N1: a producer without e-mail -> no «Vis e-post», no JSON-LD email");
      eq(n.headers["cache-control"], "private", "N2: ... and still Cache-Control: private");
      ok(shows(await page(slugs[0]!, ip), 0), "N3: viewing it cost nothing (limit 1, the next profile still shows its e-mail)");
    }

    // ── C: CCBot ──────────────────────────────────────────────────────────
    freshGuard();
    for (const ua of [CCBOT, "Mozilla/5.0 (compatible; ccbot/2.0)", "CCBOT"]) {
      const r = await page(slugs[0]!, "203.0.113.50", ua);
      ok(r.status === 200 && !leaks(r.text, emails[0]!) && !r.text.includes("Vis e-post") && !r.text.includes("/epost") && !jsonLdHasEmail(r.text) && onlyPlatformMailto(r.text),
        `C1: ${ua} on its first request -> no address, no «Vis e-post», no JSON-LD email`);
      eq(r.headers["cache-control"], "private", `C2: ${ua} -> Cache-Control: private`);
      const u = await page(umbSlug, "203.0.113.50", ua);
      ok(!leaks(u.text, U.email) && !u.text.includes("Vis e-post"), `C3: ${ua} on the umbrella page -> no address, no «Vis e-post»`);
    }
    freshGuard(1);
    {
      await page(slugs[1]!, "203.0.113.51", CCBOT);
      ok(shows(await page(slugs[0]!, "203.0.113.51"), 0), "C4: CCBot used none of the IP's budget (a browser from that IP still gets e-mail at limit 1)");
    }

    // ── S: one counter for page and reveal endpoint ───────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.60";
      eq((await reveal(slugs[0]!, ip)).status, 200, "S1: reveal 1 of 2");
      eq((await reveal(slugs[1]!, ip)).status, 200, "S2: reveal 2 of 2");
      ok(isRevealOnly(await page(slugs[2]!, ip), slugs[2]!, emails[2]!), "S3: the reveals spent the budget -> the page of a third producer gets «Vis e-post»");
      ok(shows(await page(slugs[1]!, ip), 1), "S4: a profile already counted by the reveal endpoint is free on its page");
    }
    freshGuard(2);
    {
      const ip = "203.0.113.61";
      ok(shows(await page(slugs[0]!, ip), 0), "S5: page 1 of 2");
      ok(shows(await page(slugs[1]!, ip), 1), "S6: page 2 of 2");
      eq((await reveal(slugs[2]!, ip)).status, 429, "S7: the pages spent the budget the reveal endpoint shares (429)");
      eq((await reveal(slugs[0]!, ip)).status, 200, "S8: revealing a profile counted by its page is free");
    }

    // ── R: the reveal endpoint ────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.70";
      const a = await reveal(slugs[2]!, ip);
      ok(a.status === 200 && a.text.includes(`href="mailto:${emails[2]!.replace(/&/g, "&amp;")}"`), "R1: within the limit -> 200 with the (escaped) mailto: link");
      eq([a.headers["cache-control"], a.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "R2: Cache-Control: private, X-Robots-Tag noindex");
      ok(a.text.includes('content="noindex, nofollow"'), "R3: the reveal page has a robots noindex meta");
      ok(a.text.includes(`href="/produsent/${slugs[2]}"`), "R4: it links back to the profile");
      eq((await reveal(slugs[0]!, ip)).status, 200, "R5: 2 of 2 -> 200");
      const over = await reveal(slugs[1]!, ip);
      ok(over.status === 429 && !leaks(over.text, emails[1]!) && over.text.includes("Prøv igjen senere") && onlyPlatformMailto(over.text), "R6: over the limit -> 429, «prøv igjen senere», no address");
      eq([over.headers["cache-control"], over.headers["retry-after"], over.headers["x-robots-tag"]], ["private", "3600", "noindex, nofollow"], "R7: 429 -> Cache-Control: private, Retry-After, noindex");
      eq((await reveal(slugs[2]!, ip)).status, 200, "R8: revealing a counted profile again is free");
      const cc = await reveal(slugs[1]!, "203.0.113.71", CCBOT);
      ok(cc.status === 403 && !leaks(cc.text, emails[1]!) && onlyPlatformMailto(cc.text), "R9: CCBot -> 403, no address");
      eq(cc.headers["x-robots-tag"], "noindex, nofollow", "R10: 403 -> noindex");
      const unknown = await reveal("finnes-ikke-gard", ip);
      eq([unknown.status, unknown.headers["x-robots-tag"]], [404, "noindex, nofollow"], "R11: unknown slug -> 404, noindex");
      eq((await reveal(noEmailSlug, ip)).status, 404, "R12: a producer without e-mail -> 404");
      const lg = await reveal(logisticsSlug, "203.0.113.72");
      ok(lg.status === 404 && !leaks(lg.text, RFB_EMAIL_FIXTURE.logistics.email), "R13: a non-producer (role gate) -> 404, no address");
      eq((await page(logisticsSlug, "203.0.113.72")).status, 404, "R14: the non-producer profile itself stays 404");
      const umb = await reveal(umbSlug, "203.0.113.73");
      ok(umb.status === 200 && umb.text.includes(mailtoOf(U.email)), "R15: an umbrella's e-mail can be revealed (200)");
      const en = await reveal(slugs[0]!, "203.0.113.74", BROWSER);
      ok(en.status === 200, "R16: unprefixed reveal works for a fresh IP");
      const enOver = await get(`/en/produsent/${slugs[1]}/epost`, ip);
      ok(enOver.status === 429 && enOver.text.includes("try again later") && !leaks(enOver.text, emails[1]!), "R17: /en reveal over the limit -> 429 in English, no address");
    }

    // ── G: log lines ──────────────────────────────────────────────────────
    {
      ok(logLines.length > 0, "G1: withheld e-mail was logged");
      const joined = logLines.join("\n");
      ok(![...allEmails, "visprove-gard", "massevis-gard"].some((e) => joined.includes(e)), "G2: no log line carries an e-mail address");
      ok(!/203\.0\.113\./.test(joined), "G3: no log line carries an IP");
      ok(logLines.every((l) => { try { const o = JSON.parse(l); return o.evt === "email_reveal_withheld" && o.host === "rfb"; } catch { return false; } }), "G4: every line is the guard's JSON line for rfb");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevConsoleLog;
    if (closeHttp) await closeHttp().catch(() => {});
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    guard.__resetEmailRevealGuardForTesting();
    try { clearRegistry(); } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    if (prevMainDb) initMod.__setDbForTesting(prevMainDb as any);
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbProfileEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
