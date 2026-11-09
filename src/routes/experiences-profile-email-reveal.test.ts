/**
 * experiences-profile-email-reveal.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 4:
 * S-A1 (per-IP limit, «Vis e-post») and S-A3 (CCBot) on the opplevagent.no
 * gårdssalg producer profile page GET /kategori/gardssalg/produsent/:providerSlug
 * («E-post» fact row mailto: and JSON-LD `email`) and the reveal endpoint
 * GET /kategori/gardssalg/produsent/:providerSlug/epost.
 *
 * Fixture (own in-memory experiences DB, made-up names and addresses): three
 * producers with an e-mail (one with characters HTML escapes), one without,
 * one whose e-mail is under review (AC4 flag in field_provenance), one hidden
 * (catalog_hidden = 1), one visible test producer (is_test_provider = 1), and
 * 32 more with an e-mail for the default-limit run.
 *
 *   O   switch off (unset, and "off"): every profile has its mailto: row and
 *       JSON-LD `email` however many profiles one IP views, Cache-Control
 *       public, max-age=300 as on main, CCBot too; the reveal path answers the
 *       router's catch-all 404, byte for byte, with no guard headers
 *   U   switch on, under the limit: page body byte-identical to switch off,
 *       plus Cache-Control: private
 *   L   switch on, over the limit: «Vis e-post» link, the address nowhere in
 *       the body (raw, escaped or URL-encoded), only the platform's kontakt@
 *       mailto:, no JSON-LD `email`; a repeat view is free; another IP has its
 *       own budget; the default limit (30) lets 30 distinct profiles through
 *       and not the 31st; with the language switcher on, /en shows «Show
 *       e-mail» to /en/…/epost
 *   N   a producer without e-mail, or with its e-mail under review, costs
 *       nothing and gets no «Vis e-post»; the under-review address is never
 *       on the page and never revealed by the endpoint
 *   C   CCBot (any case): no address, no «Vis e-post», no JSON-LD `email`, on
 *       the first request; it spends none of the IP's budget
 *   S   one experiences counter shared by the profile page and the reveal
 *       endpoint (both directions)
 *   R   reveal endpoint: allowed (200 + mailto), over the limit (429, no
 *       address, Retry-After), CCBot (403), unknown / hidden / test producer /
 *       no e-mail / under review (404); Cache-Control: private, X-Robots-Tag
 *       and meta noindex
 *   G   the guard's log lines carry no e-mail address and no IP
 *   T   S-A4 trap path /kontakt-arkiv: disallowed in every robots.txt group
 *       (same text switch on or off); the hidden link only with the switch
 *       on, never in JSON-LD or the sitemap; switch off → fall-through, nothing
 *       recorded; a GET/HEAD blocks that IP for 24 h (injected clock) on the
 *       page and «Vis e-post»; another IP unaffected; logs without IP
 *
 * The byte-identity of switch-off against main itself was checked when the
 * slice was built (the same fixture rendered from a clean main checkout and
 * from this branch; see the PR).
 *
 * Standalone: npx tsx src/routes/experiences-profile-email-reveal.test.ts
 * Wired into tests/test.ts via runExperiencesProfileEmailRevealTests().
 */

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

/** Every address after a mailto: anywhere in a page. */
function mailtos(html: string): string[] {
  return Array.from(html.matchAll(/mailto:([^"'\s<>]*@[^"'\s<>]*)/gi)).map((m) => m[1]!);
}

export const EXPERIENCES_EMAIL_FIXTURE = {
  producers: [
    { id: "oer-p1", slug: "visprove-sideri-en", navn: "Visprøve Sideri En", epost: "post1@visprove-sideri.example" },
    { id: "oer-p2", slug: "visprove-sideri-to", navn: "Visprøve Sideri To", epost: "post2@visprove-sideri.example" },
    { id: "oer-p3", slug: "visprove-sideri-tre", navn: "Visprøve Sideri Tre", epost: "a&b3@visprove-sideri.example" },
  ],
  noEmail: { id: "oer-p4", slug: "utenpost-visprove-sideri", navn: "Utenpost Visprøve Sideri" },
  underReview: { id: "oer-p5", slug: "visprove-bryggeri-review", navn: "Visprøve Bryggeri Review", epost: "avvik@annet-domene.example" },
  hidden: { id: "oer-p6", slug: "skjult-visprove-sideri", navn: "Skjult Visprøve Sideri", epost: "skjult@visprove-sideri.example" },
  testProvider: { id: "oer-p7", slug: "test-visprove-sideri", navn: "Test Visprøve Sideri", epost: "test@visprove-sideri.example" },
};

/** Seeds the fixture into an experiences DB (also used by the one-off main-vs-branch comparison). */
export function seedExperiencesEmailFixture(db: any, extraProducers = 0): Array<{ id: string; slug: string; navn: string; epost: string }> {
  const insert = db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, is_test_provider,
        lat, lon, geocode_confidence, slug, epost, telefon, hjemmeside, field_provenance,
        enrichment_state, verification_status, source, confidence)
     VALUES
       (@id, @navn, 'experiences', 'Vestland', 'Voss', 'Voss', 'sideri', 1, @hidden, @test,
        60.63, 6.42, 'high', @slug, @epost, '55512345', @site, @prov,
        'raw', 'verified', 'test-fixture', 'medium')`,
  );
  const row = (p: { id: string; slug: string; navn: string; epost?: string | null }, extra: { hidden?: number | null; test?: number; prov?: string | null } = {}) =>
    insert.run({
      id: p.id, slug: p.slug, navn: p.navn, epost: p.epost ?? null, site: `https://${p.slug}.example.no`,
      hidden: extra.hidden ?? null, test: extra.test ?? 0, prov: extra.prov ?? null,
    });
  const F = EXPERIENCES_EMAIL_FIXTURE;
  const all: Array<{ id: string; slug: string; navn: string; epost: string }> = [];
  for (const p of F.producers) { row(p); all.push(p); }
  row(F.noEmail);
  row(F.underReview, { prov: JSON.stringify({ contact_email_flagged_review: { flagged_email: F.underReview.epost, flagged_at: "2026-10-01T00:00:00.000Z" } }) });
  row(F.hidden, { hidden: 1 });
  row(F.testProvider, { test: 1 });
  for (let n = 0; n < extraProducers; n++) {
    const p = { id: `oer-x${String(n).padStart(2, "0")}`, slug: `massevis-sideri-${String(n).padStart(2, "0")}`, navn: `Massevis Sideri ${String(n).padStart(2, "0")}`, epost: `x${n}@massevis-sideri.example` };
    row(p);
    all.push(p);
  }
  return all;
}

export async function runExperiencesProfileEmailRevealTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const envKeys = ["EMAIL_REVEAL_GUARD_EXPERIENCES", "EMAIL_REVEAL_PER_IP_PER_HOUR", "EXPERIENCES_DB_PATH", "OPPLEVAGENT_LANG_SWITCHER_ENABLED"];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  delete process.env.EMAIL_REVEAL_GUARD_EXPERIENCES;
  delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
  delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-seo"),
  ]);

  const guard = require("../services/email-reveal-guard") as typeof import("../services/email-reveal-guard");
  const logLines: string[] = [];
  const freshGuard = (limit?: number) => {
    guard.__resetEmailRevealGuardForTesting({ log: (l) => logLines.push(l) });
    if (limit === undefined) delete process.env.EMAIL_REVEAL_PER_IP_PER_HOUR;
    else process.env.EMAIL_REVEAL_PER_IP_PER_HOUR = String(limit);
  };
  let closeHttp: (() => Promise<void>) | null = null;
  const prevConsoleLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("experiences");
    const extra = seedExperiencesEmailFixture(db, 32);
    const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default;
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");

    const F = EXPERIENCES_EMAIL_FIXTURE;
    const P = F.producers;
    const slugs = P.map((p) => p.slug);
    const emails = P.map((p) => p.epost);
    const mass = extra.slice(P.length);
    const allEmails = [...emails, F.underReview.epost, F.hidden.epost, F.testProvider.epost, ...mass.map((p) => p.epost)];

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
    app.use("/", seoRouter as any);
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
    const base = "/kategori/gardssalg/produsent/";
    const page = (slug: string, ip: string, ua?: string) => get(`${base}${slug}`, ip, ua);
    const reveal = (slug: string, ip: string, ua?: string) => get(`${base}${slug}/epost`, ip, ua);
    const mailtoOf = (email: string) => `href="mailto:${email.replace(/&/g, "&amp;")}"`;
    const revealLink = (slug: string, prefix = "") => `<a href="${prefix}${base}${slug}/epost" rel="nofollow">`;
    const shows = (r: HttpResult, email: string) => r.status === 200 && r.text.includes(mailtoOf(email)) && JSON.stringify(jsonLdBlocks(r.text)).includes(JSON.stringify(email));
    const onlyPlatformMailto = (html: string) => mailtos(html).every((m) => /^kontakt@/i.test(m));
    const isRevealOnly = (r: HttpResult, slug: string, email: string) =>
      r.status === 200 && r.text.includes(revealLink(slug)) && r.text.includes(">Vis e-post</a>") && !leaks(r.text, email) && !jsonLdHasEmail(r.text) && onlyPlatformMailto(r.text);

    // ── O: switch off ─────────────────────────────────────────────────────
    freshGuard(1);
    const offPages: HttpResult[] = [];
    for (const [i, slug] of slugs.entries()) {
      const r = await page(slug, "203.0.113.10");
      offPages.push(r);
      ok(shows(r, emails[i]!), `O1: switch off -> producer ${i + 1} has its mailto: and JSON-LD email`);
      eq(r.headers["cache-control"], "public, max-age=300", `O2: switch off -> Cache-Control as on main on producer ${i + 1}`);
      ok(!r.text.includes("Vis e-post") && !r.text.includes("/epost"), `O3: switch off -> no «Vis e-post» on producer ${i + 1}`);
    }
    const offReview = await page(F.underReview.slug, "203.0.113.10");
    ok(offReview.status === 200 && !leaks(offReview.text, F.underReview.epost) && !jsonLdHasEmail(offReview.text), "O4: switch off -> an under-review address is shown nowhere (AC4, unchanged)");
    {
      let all = true;
      for (let n = 0; n < 12; n++) {
        const i = n % slugs.length;
        const r = await page(slugs[i]!, "203.0.113.10");
        all = all && r.text === offPages[i]!.text && r.headers["cache-control"] === "public, max-age=300";
      }
      ok(all, "O5: switch off, limit 1 -> 12 more views from one IP are byte-identical (no limit)");
      const cc = await page(slugs[0]!, "203.0.113.11", CCBOT);
      ok(cc.text === offPages[0]!.text, "O6: switch off -> CCBot gets the page as everyone else (S-A3 only with the switch on)");
      process.env.EMAIL_REVEAL_GUARD_EXPERIENCES = "off";
      ok((await page(slugs[1]!, "203.0.113.12")).text === offPages[1]!.text, "O7: switch \"off\" -> same as unset");
      delete process.env.EMAIL_REVEAL_GUARD_EXPERIENCES;
      const fallThrough = await get(`${base}${slugs[0]}/finnes-ikke`, "203.0.113.10");
      const offReveal = await reveal(slugs[0]!, "203.0.113.10");
      ok(offReveal.status === 404 && offReveal.text === fallThrough.text, "O8: switch off -> the reveal path is the router's catch-all 404, byte for byte");
      ok(!leaks(offReveal.text, emails[0]!), "O9: switch off -> the reveal path gives no address");
      eq([offReveal.headers["cache-control"], offReveal.headers["x-robots-tag"], offReveal.headers["retry-after"]], [undefined, undefined, undefined], "O10: switch off -> the reveal path has none of the guard's headers");
      eq(logLines.length, 0, "O11: switch off -> no guard log line");
    }

    process.env.EMAIL_REVEAL_GUARD_EXPERIENCES = "on";

    // ── U: under the limit ────────────────────────────────────────────────
    freshGuard();
    for (const [i, slug] of slugs.entries()) {
      const r = await page(slug, "203.0.113.20");
      ok(noTrap(r.text) === offPages[i]!.text, `U1: switch on, under the limit -> producer ${i + 1} byte-identical to switch off but for the hidden trap link`);
      eq(r.headers["cache-control"], "private", `U2: switch on -> Cache-Control: private on producer ${i + 1}`);
    }

    // ── L: over the limit ─────────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.30";
      const p0 = await page(slugs[0]!, ip);
      const p1 = await page(slugs[1]!, ip);
      ok(shows(p0, emails[0]!) && shows(p1, emails[1]!), "L1: limit 2 -> the first two profiles show the e-mail");
      const p2 = await page(slugs[2]!, ip);
      ok(isRevealOnly(p2, slugs[2]!, emails[2]!), "L2: the third profile -> «Vis e-post», no address anywhere (incl. &-escaped), no producer mailto:, no JSON-LD email");
      eq(p2.headers["cache-control"], "private", "L3: over the limit -> Cache-Control: private");
      ok(jsonLdBlocks(p2.text).some((b) => b && b["@type"] === "LocalBusiness" && b.telephone), "L4: over the limit -> the LocalBusiness JSON-LD is still there (only `email` is left out)");
      ok(p2.text.includes('href="tel:55512345"'), "L5: over the limit -> the phone row stays");
      ok(p2.text.includes(`<th scope="row">E-post</th><td>${revealLink(slugs[2]!)}Vis e-post</a></td>`), "L6: «Vis e-post» sits in the «E-post» fact row");
      const again = await page(slugs[0]!, ip);
      ok(noTrap(again.text) === offPages[0]!.text, "L7: a repeat view of a counted profile is free (still byte-identical to switch off but for the hidden trap link)");
      ok(shows(await page(slugs[2]!, "203.0.113.31"), emails[2]!), "L8: another IP has its own budget");
      // Language switcher on: /en is a real English page, and so is the link.
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      try {
        const en = await get(`/en${base}${slugs[2]}`, ip);
        ok(en.status === 200 && en.text.includes(revealLink(slugs[2]!, "/en")) && en.text.includes(">Show e-mail</a>") && !leaks(en.text, emails[2]!) && !jsonLdHasEmail(en.text),
          "L9: switcher on, /en over the limit -> «Show e-mail» to /en/…/epost, no address");
        const enReveal = await get(`/en${base}${slugs[2]}/epost`, ip);
        ok(enReveal.status === 429 && enReveal.text.includes("try again later") && !leaks(enReveal.text, emails[2]!), "L10: /en reveal over the limit -> 429 in English, no address");
      } finally {
        delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
      }
      const enOff = await get(`/en${base}${slugs[2]}`, ip);
      ok(enOff.text.includes(revealLink(slugs[2]!)) && enOff.text.includes(">Vis e-post</a>"), "L11: switcher off, /en -> the NO page and the unprefixed «Vis e-post» link (as the page's other labels)");
    }
    freshGuard(); // default limit 30
    {
      const ip = "203.0.113.32";
      let first30 = true;
      for (let n = 0; n < 30; n++) first30 = first30 && shows(await page(mass[n]!.slug, ip), mass[n]!.epost);
      ok(first30, "L12: default limit -> 30 distinct profiles from one IP all show the e-mail");
      const r31 = await page(mass[30]!.slug, ip);
      ok(isRevealOnly(r31, mass[30]!.slug, mass[30]!.epost), "L13: the 31st distinct profile -> «Vis e-post», no address, no JSON-LD email");
      ok(shows(await page(mass[0]!.slug, ip), mass[0]!.epost), "L14: ... while the 1st, seen again, still shows (counts once)");
      eq((await reveal(mass[31]!.slug, ip)).status, 429, "L15: ... and the reveal endpoint for a 32nd is 429");
    }

    // ── N: no e-mail / under review ───────────────────────────────────────
    freshGuard(1);
    {
      const ip = "203.0.113.40";
      const n = await page(F.noEmail.slug, ip);
      ok(n.status === 200 && !n.text.includes("Vis e-post") && !jsonLdHasEmail(n.text) && onlyPlatformMailto(n.text), "N1: a producer without e-mail -> no «Vis e-post», no JSON-LD email");
      eq(n.headers["cache-control"], "private", "N2: ... and still Cache-Control: private");
      const rv = await page(F.underReview.slug, ip);
      ok(rv.status === 200 && !leaks(rv.text, F.underReview.epost) && !rv.text.includes("Vis e-post") && !jsonLdHasEmail(rv.text) && onlyPlatformMailto(rv.text),
        "N3: an under-review address (switch on) -> shown nowhere, no «Vis e-post»");
      const rvEnd = await reveal(F.underReview.slug, ip);
      ok(rvEnd.status === 404 && !leaks(rvEnd.text, F.underReview.epost), "N4: the reveal endpoint never gives the under-review address (404)");
      ok(shows(await page(slugs[0]!, ip), emails[0]!), "N5: none of that cost anything (limit 1, the next profile still shows its e-mail)");
    }

    // ── C: CCBot ──────────────────────────────────────────────────────────
    freshGuard();
    for (const ua of [CCBOT, "Mozilla/5.0 (compatible; ccbot/2.0)", "CCBOT"]) {
      const r = await page(slugs[0]!, "203.0.113.50", ua);
      ok(r.status === 200 && !leaks(r.text, emails[0]!) && !r.text.includes("Vis e-post") && !r.text.includes("/epost") && !jsonLdHasEmail(r.text) && onlyPlatformMailto(r.text),
        `C1: ${ua} on its first request -> no address, no «Vis e-post», no JSON-LD email`);
      eq(r.headers["cache-control"], "private", `C2: ${ua} -> Cache-Control: private`);
    }
    freshGuard(1);
    {
      await page(slugs[1]!, "203.0.113.51", CCBOT);
      await page(slugs[2]!, "203.0.113.51", CCBOT);
      ok(shows(await page(slugs[0]!, "203.0.113.51"), emails[0]!), "C3: CCBot used none of the IP's budget (a browser from that IP still gets e-mail at limit 1)");
    }

    // ── S: one counter for page and reveal endpoint ───────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.60";
      eq((await reveal(slugs[0]!, ip)).status, 200, "S1: reveal 1 of 2");
      eq((await reveal(slugs[1]!, ip)).status, 200, "S2: reveal 2 of 2");
      ok(isRevealOnly(await page(slugs[2]!, ip), slugs[2]!, emails[2]!), "S3: the reveals spent the budget -> the page of a third producer gets «Vis e-post»");
      ok(shows(await page(slugs[1]!, ip), emails[1]!), "S4: a profile already counted by the reveal endpoint is free on its page");
    }
    freshGuard(2);
    {
      const ip = "203.0.113.61";
      ok(shows(await page(slugs[0]!, ip), emails[0]!), "S5: page 1 of 2");
      ok(shows(await page(slugs[1]!, ip), emails[1]!), "S6: page 2 of 2");
      eq((await reveal(slugs[2]!, ip)).status, 429, "S7: the pages spent the budget the reveal endpoint shares (429)");
      eq((await reveal(slugs[0]!, ip)).status, 200, "S8: revealing a profile counted by its page is free");
    }

    // ── R: the reveal endpoint ────────────────────────────────────────────
    freshGuard(2);
    {
      const ip = "203.0.113.70";
      const a = await reveal(slugs[2]!, ip);
      ok(a.status === 200 && a.text.includes(mailtoOf(emails[2]!)), "R1: within the limit -> 200 with the (escaped) mailto: link");
      eq([a.headers["cache-control"], a.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "R2: Cache-Control: private, X-Robots-Tag noindex");
      ok(a.text.includes('<meta name="robots" content="noindex, nofollow">'), "R3: the reveal page has a robots noindex meta");
      ok(a.text.includes(`href="${base}${slugs[2]}"`), "R4: it links back to the profile");
      eq((await reveal(slugs[0]!, ip)).status, 200, "R5: 2 of 2 -> 200");
      const over = await reveal(slugs[1]!, ip);
      ok(over.status === 429 && !leaks(over.text, emails[1]!) && over.text.includes("Prøv igjen senere") && onlyPlatformMailto(over.text), "R6: over the limit -> 429, «prøv igjen senere», no address");
      eq([over.headers["cache-control"], over.headers["retry-after"], over.headers["x-robots-tag"]], ["private", "3600", "noindex, nofollow"], "R7: 429 -> Cache-Control: private, Retry-After, noindex");
      eq((await reveal(slugs[2]!, ip)).status, 200, "R8: revealing a counted profile again is free");
      const cc = await reveal(slugs[1]!, "203.0.113.71", CCBOT);
      ok(cc.status === 403 && !leaks(cc.text, emails[1]!) && onlyPlatformMailto(cc.text), "R9: CCBot -> 403, no address");
      eq([cc.headers["cache-control"], cc.headers["x-robots-tag"]], ["private", "noindex, nofollow"], "R10: 403 -> private, noindex");
      const unknown = await reveal("finnes-ikke-sideri", ip);
      eq([unknown.status, unknown.headers["x-robots-tag"], unknown.headers["cache-control"]], [404, "noindex, nofollow", "private"], "R11: unknown slug -> 404, noindex, private");
      eq((await reveal(F.noEmail.slug, ip)).status, 404, "R12: a producer without e-mail -> 404");
      const hid = await reveal(F.hidden.slug, "203.0.113.72");
      ok(hid.status === 404 && !leaks(hid.text, F.hidden.epost), "R13: a hidden producer -> 404, no address");
      eq((await page(F.hidden.slug, "203.0.113.72")).status, 404, "R14: the hidden profile itself stays 404");
      const tp = await reveal(F.testProvider.slug, "203.0.113.73");
      ok(tp.status === 404 && !leaks(tp.text, F.testProvider.epost), "R15: the test producer -> 404, no address");
      freshGuard(0);
      const tpPage = await page(F.testProvider.slug, "203.0.113.73");
      ok(tpPage.status === 200 && !leaks(tpPage.text, F.testProvider.epost) && !tpPage.text.includes("Vis e-post"), "R16: the test producer's page over the limit -> no address and no «Vis e-post» to an endpoint that would 404");
    }

    // ── G: log lines ──────────────────────────────────────────────────────
    {
      ok(logLines.length > 0, "G1: withheld e-mail was logged");
      const joined = logLines.join("\n");
      ok(![...allEmails, "visprove-sideri.example", "massevis-sideri.example", "annet-domene"].some((e) => joined.includes(e)), "G2: no log line carries an e-mail address");
      ok(!/203\.0\.113\./.test(joined), "G3: no log line carries an IP");
      ok(logLines.every((l) => { try { const o = JSON.parse(l); return o.evt === "email_reveal_withheld" && o.host === "experiences"; } catch { return false; } }), "G4: every line is the guard's JSON line for experiences");
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
      const SW = "EMAIL_REVEAL_GUARD_EXPERIENCES";

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
      ok(robotsParser.isPathAllowed(robotsParser.parseRobotsTxt(robotsOn.text, "Googlebot"), `${base}${slugs[0]}`), "T5: profile pages stay crawlable");

      // switch off: no link, the path falls through, nothing recorded
      delete process.env[SW];
      const offPage = await ((ip: string) => page(slugs[0]!, ip))("203.0.113.201");
      eq(trapLinks(offPage.text), 0, "T6: switch off -> no trap link on the profile page");
      ok(!offPage.text.includes("kontakt-arkiv"), "T6b: ... the path is nowhere in the page");
      const offTrap = await get("/kontakt-arkiv/", "203.0.113.201");
      const fallThrough = await get("/kontakt-arkiv-finnes-ikke/", "203.0.113.201");
      ok(offTrap.status === fallThrough.status && offTrap.text === fallThrough.text.replace(/kontakt-arkiv-finnes-ikke/g, "kontakt-arkiv") && offTrap.headers["cache-control"] === fallThrough.headers["cache-control"],
        "T7: switch off -> the trap path is the router's ordinary fall-through answer");
      eq(trapLines.length, 0, "T8: switch off -> nothing logged");
      process.env[SW] = "on";
      ok(((r: HttpResult) => shows(r, emails[0]!))(await ((ip: string) => page(slugs[0]!, ip))("203.0.113.201")), "T9: a hit while the switch was off left no block");

      // switch on: link on the page, not in JSON-LD, not in the sitemap
      const onPage = await ((ip: string) => page(slugs[0]!, ip))("203.0.113.202");
      eq(trapLinks(onPage.text), 1, "T10: switch on -> the hidden trap link once on the profile page");
      ok(!jsonLdText(onPage.text).includes("kontakt-arkiv"), "T11: ... and not in JSON-LD");
      const sitemap = await get("/sitemap.xml", "203.0.113.202");
      ok(sitemap.status === 200 && !sitemap.text.includes("kontakt-arkiv"), "T12: the trap path is not in the sitemap");

      // a hit blocks this IP on every surface of the host
      const ip = "203.0.113.210";
      ok(((r: HttpResult) => shows(r, emails[1]!))(await ((ip: string) => page(slugs[1]!, ip))(ip)), "T13: before the hit the page shows the e-mail");
      const hit = await get("/kontakt-arkiv/", ip);
      ok(hit.status === 200 && hit.text.includes("Ingen oppføringer"), "T14: the trap answers a small 200 page");
      eq([hit.headers["x-robots-tag"], hit.headers["cache-control"]], ["noindex, nofollow", "no-store"], "T15: ... noindex, nofollow and no-store");
      const blockedPage = await ((ip: string) => page(slugs[1]!, ip))(ip);
      ok(blockedPage.status === 200 && !leaks(blockedPage.text, emails[1]!) && !jsonLdText(blockedPage.text).includes('"email"') && blockedPage.text.includes("Vis e-post"),
        "T16: blocked -> the page renders, «Vis e-post», no address, no JSON-LD email (a profile it saw before too)");
      eq((await ((ip: string) => reveal(slugs[2]!, ip))(ip)).status, 429, "T17: blocked -> the reveal endpoint answers as over the limit (429)");
      ok(((r: HttpResult) => shows(r, emails[2]!))(await ((ip: string) => page(slugs[2]!, ip))("203.0.113.211")), "T18: another IP is unaffected");

      eq(await head("/kontakt-arkiv/noe", "203.0.113.212"), 200, "T20: HEAD on a path below the trap is the trap too");
      ok(!((r: HttpResult) => shows(r, emails[0]!))(await ((ip: string) => page(slugs[0]!, ip))("203.0.113.212")), "T21: ... and blocks that IP");
      now += 24 * 60 * 60_000 - 1;
      ok(!((r: HttpResult) => shows(r, emails[0]!))(await ((ip: string) => page(slugs[0]!, ip))(ip)), "T22: still blocked just before 24 h");
      now += 1;
      ok(((r: HttpResult) => shows(r, emails[0]!))(await ((ip: string) => page(slugs[0]!, ip))(ip)), "T23: after 24 h the e-mail is back");
      const joined = trapLines.join("\n");
      ok(trapLines.some((l) => JSON.parse(l).evt === "email_reveal_trap_hit" && JSON.parse(l).host === "experiences"), "T24: the hit is logged (email_reveal_trap_hit, host experiences)");
      ok(trapLines.some((l) => JSON.parse(l).reason === "trap_blocked"), "T25: withheld answers are logged with reason trap_blocked");
      ok(!((text: string) => [...allEmails, "visprove-sideri.example"].some((e) => text.includes(e)))(joined) && !/203\.0\.113\./.test(joined), "T26: no log line carries an e-mail address or an IP");
      delete process.env[SW];
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
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch { /* ignore */ }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runExperiencesProfileEmailRevealTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
