/**
 * gardssalg-claim-host-gate.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-U (FUNN
 * `gardssalg-claim-request-uten-limiter` from the review of lokal#1132).
 *
 * src/index.ts mounted gardssalgClaimRoutes at "/" ahead of the host gates
 * and every limiter, so the OA owner-claim router answered on every host
 * (live 2026-10-17: rettfrabonden.com/kategori/gardssalg/eier/<unknown> gave
 * «Fant ikke produsent — Opplevagent»), with no ratelimit-* headers on any
 * host. Its entry page and POST …/request harvest the producer's website and
 * the request sends an e-mail; /api/opplevelser/gardssalg-claim/* answered
 * before index.ts's app.use("/api", generalLimiter). Now:
 *   - gardssalgClaimHostGate, mounted on GARDSSALG_CLAIM_PATH_PREFIXES above
 *     the finn-tannlege.com gate: opplevagent.no only; GET/HEAD elsewhere →
 *     301 to the same path and query on https://opplevagent.no, any other
 *     method → 404, and the router is not reached;
 *   - the shared generalLimiter first on every claim route, before the body
 *     parsers (the I-T pattern).
 *
 * Sections:
 *   w1-w12  wiring, by reference: each claim route is registered once and
 *           runs the real exported generalLimiter first.
 *   g1-g3   scope: every route on the router carries it, none router-wide,
 *           and every route sits under a gated prefix.
 *   a1      ac2LimitersFor (the AC2 shadow gate, client-ip.ts) counts every
 *           claim route path as general.
 *   i1-i5   index.ts order (source inspection): the gate is mounted once,
 *           above the finn-tannlege.com gate and the router; the router stays
 *           above the opplevagent.no gate and the "/api" limiter mount.
 *   l1      the e-mailed verify links default to the host the gate serves.
 *   h1-h13  behaviour over real HTTP on rettfrabonden.com, finn-tannlege.com
 *           and www.opplevagent.no: 301 with path and query kept for GET/HEAD,
 *           404 for POST, no limiter headers, router never reached, no quota
 *           spent; other paths pass the gate.
 *   b1-b12  behaviour over real HTTP on opplevagent.no: served as before, with
 *           `ratelimit-policy: 300;w=900`, one quota shared with /sok, 429
 *           after the limit (also before a POST's body parser), and a second
 *           client is unaffected.
 *
 * The HTTP app mirrors index.ts's order: langMiddleware, the gate on its
 * prefixes, the claim router, then the experiences-seo router the
 * opplevagent.no gate hands /sok to. It drives the production limiter
 * (300/15 min) on its own TEST-NET-2 client addresses via X-Forwarded-For
 * with `trust proxy` on (as installClientIp sets it), resets those keys
 * before and after, and so never touches the 127.0.0.1 bucket other suites
 * share. node:http with agent:false, not the global fetch other suites stub.
 * Only unknown slugs/ids, the session check, the token-less verify link and
 * /sok without q are requested on opplevagent.no: a lookup in an in-memory
 * experiences DB at most — no harvest, no e-mail.
 *
 * Standalone: npx tsx src/routes/gardssalg-claim-host-gate.test.ts
 * Wired into the gate: tests/test.ts imports runGardssalgClaimHostGateTests().
 */

import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteLayer {
  handle?: unknown;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown; method?: string }>;
  };
}

type Method = "get" | "post";

/** Every route layer on a router's own stack registered for `method` at `routePath`. */
function routeLayers(router: { stack: RouteLayer[] }, method: Method, routePath: string): NonNullable<RouteLayer["route"]>[] {
  return router.stack
    .map((l) => l.route)
    .filter((r): r is NonNullable<RouteLayer["route"]> => !!r && r.path === routePath && !!r.methods[method]);
}

/** "GET /x"-style labels for every route on the router, and for those that chain `limiter`. */
function routeLabels(router: { stack: RouteLayer[] }, limiter?: unknown): string[] {
  const out: string[] = [];
  for (const layer of router.stack) {
    const r = layer.route;
    if (!r || (limiter !== undefined && !r.stack.some((s) => s.handle === limiter))) continue;
    for (const m of Object.keys(r.methods).filter((k) => r.methods[k])) {
      out.push(`${m.toUpperCase()} ${Array.isArray(r.path) ? r.path.join("|") : r.path}`);
    }
  }
  return out.sort();
}

interface Hit {
  status: number;
  location: string | undefined;
  policy: string | undefined;
  limit: string | undefined;
  remaining: string | undefined;
  retryAfter: string | undefined;
  body: string;
}

function hit(
  port: number,
  method: string,
  urlPath: string,
  opts: { host: string; clientIp: string; json?: unknown },
): Promise<Hit> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { Host: opts.host, "X-Forwarded-For": opts.clientIp };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, agent: false, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({
        status: res.statusCode || 0,
        location: res.headers.location,
        policy: res.headers["ratelimit-policy"] as string | undefined,
        limit: res.headers["ratelimit-limit"] as string | undefined,
        remaining: res.headers["ratelimit-remaining"] as string | undefined,
        retryAfter: res.headers["retry-after"] as string | undefined,
        body,
      }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function runGardssalgClaimHostGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
  const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
  const { ac2LimitersFor } = require("../middleware/client-ip") as typeof import("../middleware/client-ip");
  // Loaded before the swap below: /sok without q reads no database, so it
  // stays bound to whatever db-factory copy the process already has.
  const expRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as unknown as express.RequestHandler;

  // A fresh claim router on a fresh db-factory with an in-memory experiences
  // DB, as gardssalg-claim.test.ts does it; restored in `finally`.
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const dbFactoryPath = require.resolve("../database/db-factory");
  const claimSvcPath = require.resolve("../services/gardssalg-claim");
  const routerPath = require.resolve("./gardssalg-claim");
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache"))
    .swapOutModules([dbFactoryPath, claimSvcPath, routerPath]);

  const CLIENT_A = "198.51.100.81"; // opplevagent.no, up to the limit
  const CLIENT_B = "198.51.100.82"; // opplevagent.no, untouched second client
  const CLIENT_C = "198.51.100.83"; // the other hosts only
  const LIMIT = 300; // generalLimiter's anonymous ceiling — read, never changed, here
  let server: http.Server | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("experiences");
    const claimMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
    const claimRouter = claimMod.default as unknown as { stack: RouteLayer[] };
    const { GARDSSALG_CLAIM_HOST, GARDSSALG_CLAIM_PATH_PREFIXES, gardssalgClaimHostGate } = claimMod;

    // ── w1-w12: wiring, by reference ────────────────────────────────────
    const wired: Array<[string, Method, string]> = [
      ["w1", "get", "/kategori/gardssalg/eier/magic-link-verify"],
      ["w2", "get", "/kategori/gardssalg/eier/:providerSlug"],
      ["w3", "post", "/kategori/gardssalg/eier/:providerId/request"],
      ["w4", "get", "/kategori/gardssalg/eier/:providerSlug/portal"],
      ["w5", "post", "/kategori/gardssalg/eier/:providerSlug/save"],
      ["w6", "post", "/kategori/gardssalg/eier/:providerSlug/logout"],
      ["w7", "get", "/api/opplevelser/gardssalg-claim/:providerId/profile"],
      ["w8", "post", "/api/opplevelser/gardssalg-claim/:providerId/update-profile"],
      ["w9", "get", "/api/opplevelser/gardssalg-claim/:providerId/stats"],
      ["w10", "get", "/api/opplevelser/gardssalg-claim/:providerId/session-status"],
      // G1 pkt 2 (dev-request 2026-10-22-opplevagent-mine-valg-gardssalg): «gi tilbake».
      ["w11", "post", "/kategori/gardssalg/eier/:providerSlug/release-field"],
      ["w12", "post", "/api/opplevelser/gardssalg-claim/:providerId/release-field"],
      // G1 pkt 4: eierens pause / gjenoppta.
      ["w13", "post", "/api/opplevelser/gardssalg-claim/:providerId/pause"],
      ["w14", "post", "/api/opplevelser/gardssalg-claim/:providerId/resume"],
      ["w15", "post", "/kategori/gardssalg/eier/:providerSlug/pause"],
      ["w16", "post", "/kategori/gardssalg/eier/:providerSlug/resume"],
    ];
    for (const [id, method, routePath] of wired) {
      const label = `${method.toUpperCase()} ${routePath}`;
      const layers = routeLayers(claimRouter, method, routePath);
      assertEq(layers.length, 1, `${id}a: ${label} is registered exactly once`);
      const layer = layers[0];
      if (!layer) continue;
      assertTrue(layer.stack[0]?.handle === generalLimiter,
        `${id}b: ${label} runs the real exported generalLimiter first (shared quota, before any body parser)`);
      assertTrue(layer.stack.length >= 2 && layer.stack.slice(1).every((s) => s.handle !== generalLimiter),
        `${id}c: ${label} chains it once, ahead of its own handler(s)`);
    }

    // ── g1-g3: scope ────────────────────────────────────────────────────
    const all = routeLabels(claimRouter);
    assertEq(all.length, wired.length, `g1: the claim router has exactly the ${wired.length} routes above (a new one must be added to w1-w16)`);
    assertEq(routeLabels(claimRouter, generalLimiter), all, "g2: every claim route chains generalLimiter, and none is router-wide");
    assertTrue(!claimRouter.stack.some((l) => !l.route && l.handle === generalLimiter),
      "g2b: no router-wide generalLimiter (an unmatched /api/opplevelser/gardssalg-claim/* path is counted once, by the \"/api\" mount)");
    const outside = claimRouter.stack
      .map((l) => l.route)
      .filter((r): r is NonNullable<RouteLayer["route"]> => !!r)
      .flatMap((r) => (Array.isArray(r.path) ? r.path : [r.path]))
      .filter((p) => !GARDSSALG_CLAIM_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/")));
    assertEq(outside, [], "g3: every claim route lies under GARDSSALG_CLAIM_PATH_PREFIXES, so the host gate covers all of them");

    // ── a1: the AC2 shadow gate counts every claim route ──────────────────
    {
      const uncounted: string[] = [];
      let checked = 0;
      for (const layer of claimRouter.stack) {
        const r = layer.route;
        if (!r || !r.stack.some((s) => s.handle === generalLimiter)) continue;
        for (const p of Array.isArray(r.path) ? r.path : [r.path]) {
          const sample = p.replace(/:[^/]+/g, "x");
          checked++;
          if (!ac2LimitersFor(sample).includes("general")) uncounted.push(sample);
        }
      }
      assertTrue(checked === 16 && uncounted.length === 0,
        `a1: ac2LimitersFor counts all 16 route-level generalLimiter paths on the claim router as general (checked ${checked}, uncounted ${JSON.stringify(uncounted)})`);
    }

    // ── i1-i5: index.ts order (source inspection) ───────────────────────
    {
      const idxSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
      const gateMount = "app.use(GARDSSALG_CLAIM_PATH_PREFIXES, gardssalgClaimHostGate);";
      const routerMount = 'app.use("/", gardssalgClaimRoutes);';
      const gateIdx = idxSrc.indexOf(gateMount);
      const routerIdx = idxSrc.indexOf(routerMount);
      const dentalGateIdx = idxSrc.indexOf("const DENTAL_HOSTS");
      const expGateIdx = idxSrc.indexOf("EXPERIENCES_HOSTS.has(");
      const apiIdx = idxSrc.indexOf('app.use("/api", generalLimiter);');
      assertEq([idxSrc.split(gateMount).length - 1, idxSrc.split(routerMount).length - 1], [1, 1],
        "i1: index.ts mounts the claim host gate and the claim router exactly once each");
      assertTrue(gateIdx > -1 && dentalGateIdx > gateIdx,
        "i2: the gate is above the finn-tannlege.com gate (which would hand /kategori/* to dental-seo and pass /api/* on)");
      assertTrue(gateIdx > -1 && routerIdx > gateIdx, "i3: the gate is above the claim router");
      assertTrue(routerIdx > -1 && expGateIdx > routerIdx,
        "i4: the claim router is still above the opplevagent.no gate (whose 404 catch-all would swallow the claim paths)");
      assertTrue(routerIdx > -1 && apiIdx > routerIdx,
        "i5: the claim router answers before app.use(\"/api\", generalLimiter), so a served claim API request is counted once, by its route");
    }

    // ── l1: the e-mailed links already point at the served host ─────────
    {
      const claimSrc = fs.readFileSync(path.join(__dirname, "gardssalg-claim.ts"), "utf8");
      const oppSrc = fs.readFileSync(path.join(__dirname, "opplevelser.ts"), "utf8");
      const defaultBase = /\(process\.env\.OPPLEVAGENT_BASE_URL \|\| "([^"]+)"\)/;
      const bases = [claimSrc.match(defaultBase)?.[1], oppSrc.match(defaultBase)?.[1]];
      assertEq(bases.map((b) => (b ? new URL(b).hostname : null)), [GARDSSALG_CLAIM_HOST, GARDSSALG_CLAIM_HOST],
        "l1: the verify links in the claim e-mails (gardssalg-claim.ts, opplevelser.ts) default to the host the gate serves, so no sent link is redirected");
    }

    // ── HTTP ─────────────────────────────────────────────────────────────
    for (const k of [CLIENT_A, CLIENT_B, CLIENT_C]) await generalLimiter.resetKey(k);
    const reachedRouter: string[] = [];
    const app = express();
    app.set("trust proxy", true);
    app.use(langMiddleware);
    app.use(GARDSSALG_CLAIM_PATH_PREFIXES, gardssalgClaimHostGate);
    app.use((req, _res, next) => { reachedRouter.push(`${req.hostname} ${req.method} ${req.originalUrl}`); next(); });
    app.use("/", claimMod.default);
    app.get("/sok", (req, res, next) => expRouter(req, res, next));
    app.use((_req, res) => { res.status(418).send("fell through"); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    // ── h1-h13: every other host ──────────────────────────────────────────
    const OA = `https://${GARDSSALG_CLAIM_HOST}`;
    const elsewhere = { clientIp: CLIENT_C };
    const rfb = { ...elsewhere, host: "rettfrabonden.com" };
    {
      const r = await hit(port, "GET", "/kategori/gardssalg/eier/ukjent-slug?ref=epost", rfb);
      assertEq([r.status, r.location], [301, `${OA}/kategori/gardssalg/eier/ukjent-slug?ref=epost`],
        "h1: rettfrabonden.com GET of the claim page → 301 to the same path and query on opplevagent.no");
      const head = await hit(port, "HEAD", "/kategori/gardssalg/eier/ukjent-slug?ref=epost", rfb);
      assertEq([head.status, head.location], [301, `${OA}/kategori/gardssalg/eier/ukjent-slug?ref=epost`], "h2: … and HEAD the same");
      const verify = await hit(port, "GET", "/kategori/gardssalg/eier/magic-link-verify?token=abc123", rfb);
      assertEq([verify.status, verify.location], [301, `${OA}/kategori/gardssalg/eier/magic-link-verify?token=abc123`],
        "h3: an e-mailed verify link on rettfrabonden.com lands on opplevagent.no with its token");
      const en = await hit(port, "GET", "/en/kategori/gardssalg/eier/gard-x/portal", rfb);
      assertEq([en.status, en.location], [301, `${OA}/en/kategori/gardssalg/eier/gard-x/portal`],
        "h4: /en is kept (the redirect uses the original URL, not langMiddleware's stripped one)");
      const api = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", rfb);
      assertEq([api.status, api.location], [301, `${OA}/api/opplevelser/gardssalg-claim/p1/session-status`],
        "h5: the claim API GETs are redirected too");
      const mixed = await hit(port, "GET", "/Kategori/Gardssalg/Eier/X", rfb);
      assertEq([mixed.status, mixed.location], [301, `${OA}/Kategori/Gardssalg/Eier/X`],
        "h6: matched case-insensitively, like the router's own routes");

      const posts = [
        ["/kategori/gardssalg/eier/p1/request", { selected: "brreg_contact" }],
        ["/kategori/gardssalg/eier/gard-x/save", {}],
        ["/kategori/gardssalg/eier/gard-x/logout", {}],
        ["/api/opplevelser/gardssalg-claim/p1/update-profile", { about_text: "x" }],
        ["/kategori/gardssalg/eier/gard-x/release-field", {}],
        ["/api/opplevelser/gardssalg-claim/p1/release-field", { field: "about_text" }],
      ] as const;
      const postOut: Array<[number, string]> = [];
      for (const [p, body] of posts) {
        const r2 = await hit(port, "POST", p, { ...rfb, json: body });
        postOut.push([r2.status, r2.body]);
      }
      const notFound = JSON.stringify({ success: false, error: "not_found" });
      assertEq(postOut, posts.map(() => [404, notFound]),
        "h7: rettfrabonden.com POST to the link request, save, logout, update-profile and release-field → 404, nothing is looked up, harvested or sent");
    }
    {
      const dental = { ...elsewhere, host: "finn-tannlege.com" };
      const g = await hit(port, "GET", "/kategori/gardssalg/eier/ukjent-slug", dental);
      const a = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/stats", dental);
      const p = await hit(port, "POST", "/kategori/gardssalg/eier/p1/request", { ...dental, json: {} });
      assertEq([g.status, g.location, a.status, a.location, p.status],
        [301, `${OA}/kategori/gardssalg/eier/ukjent-slug`, 301, `${OA}/api/opplevelser/gardssalg-claim/p1/stats`, 404],
        "h8: finn-tannlege.com answers the same way: 301 for GET, 404 for POST");
      const www = { ...elsewhere, host: "www.opplevagent.no" };
      const wg = await hit(port, "GET", "/kategori/gardssalg/eier/ukjent-slug?x=1", www);
      const wp = await hit(port, "POST", "/kategori/gardssalg/eier/p1/request", { ...www, json: {} });
      assertEq([wg.status, wg.location, wp.status], [301, `${OA}/kategori/gardssalg/eier/ukjent-slug?x=1`, 404],
        "h9: www.opplevagent.no is not the served host either: 301 to the apex for GET, 404 for POST");
      assertTrue([g, a, p, wg, wp].every((r) => r.policy === undefined && r.remaining === undefined),
        "h10: none of the other-host answers carries ratelimit-* headers (the gate answers before any route)");
    }
    assertEq(reachedRouter, [], "h11: on the other hosts the claim router was never reached, for any method");
    {
      const pass1 = await hit(port, "GET", "/kategori/gardssalg/eierx", rfb);
      const pass2 = await hit(port, "GET", "/kategori/gardssalg/produsent/gard-x", rfb);
      const pass3 = await hit(port, "POST", "/api/opplevelser/book", { ...rfb, json: {} });
      assertEq([pass1.status, pass2.status, pass3.status], [418, 418, 418],
        "h12: other paths pass the gate untouched on every host (…/eierx, …/produsent/<slug>, /api/opplevelser/book)");
    }
    {
      const first = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", { host: GARDSSALG_CLAIM_HOST, clientIp: CLIENT_C });
      assertEq([first.status, first.remaining], [200, "299"],
        "h13: the redirects and 404s spent none of that client's quota (its first served claim request leaves 299)");
    }

    // ── b1-b12: opplevagent.no ─────────────────────────────────────────────
    const oa = { host: GARDSSALG_CLAIM_HOST, clientIp: CLIENT_A };
    reachedRouter.length = 0;
    const page = await hit(port, "GET", "/kategori/gardssalg/eier/ukjent-slug", oa);
    assertTrue(page.status === 404 && page.body.includes("Fant ikke produsent"),
      "b1: opplevagent.no GET of an unknown slug → the router's own 404 page, as before");
    assertEq([page.policy, page.limit, page.remaining], ["300;w=900", "300", "299"],
      "b2: … with ratelimit-policy: 300;w=900 (what the live check after deploy reads), counted once");
    const status = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", oa);
    assertEq([status.status, status.body, status.remaining], [200, JSON.stringify({ isOwner: false }), "298"],
      "b3: GET …/session-status → 200 {isOwner:false}, same bucket");
    const verify = await hit(port, "GET", "/kategori/gardssalg/eier/magic-link-verify", oa);
    assertEq([verify.status, verify.location, verify.remaining], [302, "/kategori/gardssalg?error=invalid_token", "297"],
      "b4: GET magic-link-verify without a token → 302 to the error page, as before, same bucket");
    const request = await hit(port, "POST", "/kategori/gardssalg/eier/ukjent-id/request", { ...oa, json: {} });
    assertEq([request.status, request.body, request.remaining],
      [404, JSON.stringify({ success: false, error: "provider_not_found" }), "296"],
      "b5: POST …/request for an unknown id → the route's own 404 JSON, same bucket");
    const sok = await hit(port, "GET", "/sok", oa);
    assertEq([sok.status, sok.remaining], [200, "295"], "b6: GET /sok draws on the same bucket (one quota per client across the claim routes and /sok)");
    assertEq(reachedRouter.filter((l) => !l.endsWith(" GET /sok")).length, 4, "b7: on opplevagent.no each of the four claim requests passed the gate to the router");

    let used = 5;
    let allOk = true;
    let lastRemaining: string | undefined;
    while (used < LIMIT) {
      const r = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", oa);
      used++;
      if (r.status !== 200) allOk = false;
      lastRemaining = r.remaining;
    }
    assertTrue(allOk && lastRemaining === "0", `b8: every request up to the limit (${LIMIT}) → 200, the last leaves remaining 0`);

    const over = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", oa);
    let overBody: { success?: boolean; error?: string } = {};
    try { overBody = JSON.parse(over.body); } catch { /* asserted below */ }
    assertTrue(over.status === 429 && overBody.success === false && overBody.error === "For mange forespørsler. Prøv igjen senere." && !!over.retryAfter,
      "b9: request 301 → 429, generalLimiter's own (its Norwegian message + retry-after)");
    const overPost = await hit(port, "POST", "/kategori/gardssalg/eier/ukjent-id/request", { ...oa, json: {} });
    const overPage = await hit(port, "GET", "/kategori/gardssalg/eier/ukjent-slug", oa);
    assertEq([overPost.status, overPost.body.includes("provider_not_found"), overPage.status], [429, false, 429],
      "b10: the link request and the entry page are 429 too — refused before the body parser and the handler");
    const sokOver = await hit(port, "GET", "/sok", oa);
    assertEq(sokOver.status, 429, "b11: once the claim routes have spent the quota, /sok is 429 for that client too (shared quota)");
    const other = await hit(port, "GET", "/api/opplevelser/gardssalg-claim/p1/session-status", { host: GARDSSALG_CLAIM_HOST, clientIp: CLIENT_B });
    assertEq([other.status, other.remaining], [200, "299"], "b12: another client is unaffected (per-client bucket, not a global brake)");
  } catch (err) {
    failed++;
    failures.push(`✗ gardssalg-claim host gate block crashed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const k of [CLIENT_A, CLIENT_B, CLIENT_C]) await generalLimiter.resetKey(k);
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch { /* ignore */ }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runGardssalgClaimHostGateTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-claim-host-gate: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
