/**
 * agentplatform-site.test.ts — the agentplatform.no company site and its host
 * gate (A2A dev-request 2026-10-08-agentplatform-no-paraplyside).
 *
 * Covers:
 *   (a) host gate: agentplatform.no is served, www → apex 301 (path + query
 *       kept), every other host falls through untouched
 *   (b) NOTHING passes through on this host: /api, /mcp, /a2a, /health and
 *       /.well-known/agent-card.json get the site's own 404, never an rfb router
 *   (c) the three service links (with utm_source) and live counts; a missing
 *       count hides the number instead of printing 0/null; "Over N" rounds down
 *   (d) counts are cached for COUNT_TTL_MS
 *   (e) the street address (most likely Daniel's home) is on /kontakt and
 *       /personvern only — not on the front pages, their JSON-LD or the footer
 *   (f) no third-party requests (fonts/scripts) and no "MVA" after the org.nr
 *   (g) machine surfaces: llms.txt, robots.txt, sitemap.xml, icons, font
 *   (h) index.ts mounts the gate BEFORE the analytics middleware, so visits are
 *       never stamped as rfb traffic
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/agentplatform-site.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import express from "express";
import {
  COUNT_TTL_MS,
  createAgentplatformHostGate,
  createAgentplatformRouter,
  escKeep,
  floorForClaim,
  formatCount,
} from "./agentplatform-site";
import { COMPANY_INFO } from "../config/company-info";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export async function runAgentplatformSiteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log !== false;
  const summary: TestSummary = { passed: 0, failed: 0, failures: [] };
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      summary.passed++;
      if (log) console.log(`  ✓ ${name}`);
    } else {
      summary.failed++;
      summary.failures.push(detail ? `${name} — ${detail}` : name);
      if (log) console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  // Fake counts + clock so the cache is observable.
  const counts: Record<string, number | null> = { rfb: 1809, experiences: 712, dental: 5446 };
  let reads = 0;
  let nowMs = 1_000_000;
  const router = createAgentplatformRouter({
    readCount: (v) => {
      reads++;
      return counts[v] ?? null;
    },
    now: () => nowMs,
  });

  const app = express();
  app.set("trust proxy", true);
  app.use(createAgentplatformHostGate(router));
  // Anything that falls through the gate lands here — must never happen for agentplatform.no.
  app.use((_req, res) => res.status(418).send("fell-through"));

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const get = (p: string, host = "agentplatform.no"): Promise<Resp> =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: p, headers: { host } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () =>
            resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }),
          );
        })
        .on("error", reject);
    });

  try {
    // ── (a) host gate ─────────────────────────────────────────────────────
    const home = await get("/");
    check("a1: GET / on agentplatform.no → 200 text/html", home.status === 200 && /text\/html/.test(String(home.headers["content-type"])));
    check('a2: front page is Norwegian (<html lang="nb">)', home.body.includes('<html lang="nb">'));
    const www = await get("/en?x=1", "www.agentplatform.no");
    check(
      "a3: www.agentplatform.no → 301 https://agentplatform.no<path+query>",
      www.status === 301 && www.headers.location === "https://agentplatform.no/en?x=1",
      `${www.status} ${www.headers.location}`,
    );
    for (const h of ["rettfrabonden.com", "opplevagent.no", "finn-tannlege.com", "lokal.fly.dev"]) {
      const r = await get("/", h);
      check(`a4: host ${h} falls through the gate untouched`, r.status === 418 && r.body === "fell-through");
    }
    const en = await get("/en");
    check('a5: /en → 200 English (<html lang="en">)', en.status === 200 && en.body.includes('<html lang="en">'));
    check(
      "a6: hreflang alternates nb ↔ en on the front page",
      home.body.includes('hreflang="nb" href="https://agentplatform.no/"') &&
        home.body.includes('hreflang="en" href="https://agentplatform.no/en"'),
    );

    // ── (b) nothing from the other routers answers on this host ───────────
    for (const p of ["/api/stats", "/api/marketplace/search?q=x", "/mcp", "/a2a", "/health", "/.well-known/agent-card.json", "/admin/dashboard", "/produsent/x"]) {
      const r = await get(p);
      check(`b1: ${p} → branded 404 on agentplatform.no (no pass-through)`, r.status === 404 && r.body.includes("agentplatform") && !r.body.includes("fell-through"));
    }
    const enMissing = await get("/en/finnes-ikke");
    check('b2: 404 under /en is English', enMissing.status === 404 && enMissing.body.includes('<html lang="en">'));
    check("b3: 404 is noindex", enMissing.body.includes('<meta name="robots" content="noindex">'));

    // ── (c) service links + counts ─────────────────────────────────────────
    for (const d of ["rettfrabonden.com", "opplevagent.no", "finn-tannlege.com"]) {
      check(
        `c1: front page links to https://${d}/ with utm_source=agentplatform.no`,
        home.body.includes(`href="https://${d}/?utm_source=agentplatform.no&amp;utm_medium=referral&amp;utm_campaign=paraply"`),
      );
      check(`c2: /en links to the English entry https://${d}/en`, en.body.includes(`href="https://${d}/en?utm_source=agentplatform.no`));
    }
    check("c3: counts rendered with a no-break space (1 809, 5 446, 712)", home.body.includes("1 809") && home.body.includes("5 446") && home.body.includes(">712<"));
    check('c4: "Over 7 900 oppføringer" rounds the sum (7 967) DOWN', home.body.includes("Over 7 900 oppføringer"));
    check("c5: formatCount / floorForClaim", formatCount(1809) === "1 809" && formatCount(712) === "712" && formatCount(1234567) === "1 234 567" && floorForClaim(7967) === 7900 && floorForClaim(812) === 812);
    check('c6: "AI-agenter" never breaks after the hyphen', escKeep("mennesker og AI-agenter med").includes('<span class="nw">AI-agenter</span>'));

    // A vertical without a count: no number, no "Over N", no "null"/"0".
    const sparse = createAgentplatformRouter({ readCount: (v) => (v === "dental" ? null : counts[v] ?? null) });
    const sparseApp = express();
    sparseApp.use(createAgentplatformHostGate(sparse));
    const s2 = http.createServer(sparseApp);
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    const p2 = (s2.address() as any).port;
    const sparseHome: string = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: p2, path: "/", headers: { host: "agentplatform.no" } }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c) => chunks.push(c as Buffer));
        resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }).on("error", reject);
    });
    await new Promise<void>((r) => s2.close(() => r()));
    check("c7: missing count → no 'tannlegeklinikker' number line", !/<strong>[^<]*<\/strong><span>tannlegeklinikker/.test(sparseHome));
    check('c8: missing count → no "Over N oppføringer" claim', !sparseHome.includes("oppføringer</li>"));
    check("c9: missing count never prints null/NaN/undefined", !/>(null|NaN|undefined)</.test(sparseHome));

    // ── (d) cache ─────────────────────────────────────────────────────────
    const before = reads;
    await get("/");
    await get("/en");
    await get("/llms.txt");
    check("d1: counts are cached within COUNT_TTL_MS (no re-read)", reads === before, `reads ${before} → ${reads}`);
    nowMs += COUNT_TTL_MS;
    await get("/");
    check("d2: counts re-read once the TTL has passed (3 verticals)", reads === before + 3, `reads ${before} → ${reads}`);

    // ── (e) address only on contact + privacy ─────────────────────────────
    const street = COMPANY_INFO.address.street;
    check("e1: front page (nb) does not show the street address", !home.body.includes(street));
    check("e2: front page (en) does not show the street address", !en.body.includes(street));
    const kontakt = await get("/kontakt");
    const contactEn = await get("/en/contact");
    const personvern = await get("/personvern");
    const privacy = await get("/en/privacy");
    check("e3: /kontakt and /en/contact → 200 with name, org.nr, address, email, register", [kontakt, contactEn].every(
      (r) => r.status === 200 && r.body.includes(COMPANY_INFO.legalName) && r.body.includes(COMPANY_INFO.orgNrDisplay) && r.body.includes(street) && r.body.includes(COMPANY_INFO.email),
    ) && kontakt.body.includes("Foretaksregisteret"));
    check("e4: /personvern and /en/privacy name the controller with org.nr and address", [personvern, privacy].every(
      (r) => r.status === 200 && r.body.includes(COMPANY_INFO.legalName) && r.body.includes(COMPANY_INFO.orgNrDisplay) && r.body.includes(street),
    ));
    const ldMatch = home.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let ld: any = null;
    try { ld = ldMatch ? JSON.parse(ldMatch[1]) : null; } catch { ld = null; }
    check("e5: Organization JSON-LD parses and carries the org.nr", !!ld && ld["@type"] === "Organization" && ld.identifier?.value === COMPANY_INFO.orgNr);
    check("e6: JSON-LD has no streetAddress", !!ld && !("streetAddress" in (ld.address || {})));
    check("e7: footer shows legal name + org.nr linked to /kontakt", home.body.includes(`<a href="/kontakt">${COMPANY_INFO.legalName} · Org.nr. ${COMPANY_INFO.orgNrDisplay}</a>`));
    check("e8: /contact and /privacy redirect to the English pages", (await get("/contact")).headers.location === "/en/contact" && (await get("/privacy")).headers.location === "/en/privacy");

    // ── (f) no third parties, no MVA ──────────────────────────────────────
    for (const [label, r] of [["/", home], ["/en", en], ["/kontakt", kontakt], ["/personvern", personvern]] as const) {
      check(`f1: ${label} loads no third-party fonts or scripts`, !/fonts\.(googleapis|gstatic)\.com/.test(r.body) && !/<script[^>]+src=/.test(r.body));
      check(`f2: ${label} never prints "MVA" after the org.nr`, !/938\s?635\s?676\s*MVA/i.test(r.body));
      check(`f3: ${label} sets no cookie`, !r.headers["set-cookie"]);
    }

    // ── (g) machine surfaces + assets ─────────────────────────────────────
    const llms = await get("/llms.txt");
    check("g1: /llms.txt lists the three MCP endpoints", llms.status === 200 && ["rettfrabonden.com", "opplevagent.no", "finn-tannlege.com"].every((d) => llms.body.includes(`https://${d}/mcp`)));
    const robots = await get("/robots.txt");
    check("g2: /robots.txt allows all and points at the sitemap", robots.status === 200 && robots.body.includes("Allow: /") && robots.body.includes("Sitemap: https://agentplatform.no/sitemap.xml"));
    const sm = await get("/sitemap.xml");
    check("g3: /sitemap.xml lists /, /en, /kontakt, /en/contact, /personvern, /en/privacy", sm.status === 200 && ["/", "/en", "/kontakt", "/en/contact", "/personvern", "/en/privacy"].every((p) => sm.body.includes(`<loc>https://agentplatform.no${p}</loc>`)));
    const assets: Array<[string, RegExp]> = [
      ["/favicon.svg", /^image\/svg\+xml/],
      ["/favicon.ico", /^image\/png/],
      ["/favicon-192.png", /^image\/png/],
      ["/favicon-512.png", /^image\/png/],
      ["/apple-touch-icon.png", /^image\/png/],
      ["/og.png", /^image\/png/],
      ["/assets/geist-latin-wght.woff2", /^font\/woff2/],
    ];
    for (const [p, type] of assets) {
      const r = await get(p);
      check(`g4: ${p} → 200 ${type.source}`, r.status === 200 && type.test(String(r.headers["content-type"])), `${r.status} ${r.headers["content-type"]}`);
    }
    check("g5: the OFL licence ships next to the Geist font", fs.existsSync(path.join(__dirname, "..", "public", "agentplatform-geist-OFL.txt")));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  // ── (h) mount order in index.ts ─────────────────────────────────────────
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
  const gateIdx = indexSrc.indexOf("app.use(createAgentplatformHostGate());");
  const analyticsIdx = indexSrc.indexOf("app.use(analyticsService.middleware());");
  const securityIdx = indexSrc.indexOf("app.use(securityHeaders);");
  const linkIdx = indexSrc.indexOf("app.use(linkHeaders);");
  check("h1: index.ts mounts the agentplatform gate after securityHeaders", gateIdx > securityIdx && securityIdx !== -1);
  check("h2: …and before analytics and the RFB Link headers", gateIdx !== -1 && gateIdx < analyticsIdx && gateIdx < linkIdx);

  return summary;
}

// Standalone runner
if (require.main === module) {
  runAgentplatformSiteTests({ log: true }).then((s) => {
    console.log(`\nagentplatform-site: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
  });
}
