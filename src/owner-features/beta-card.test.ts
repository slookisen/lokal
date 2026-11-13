/**
 * beta-card.test.ts — A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle,
 * slice S3 (beta card, opt-in/opt-out/register-interest, Beta badge, placeholder
 * texts, all behind OWNER_BETA_MODE=offer).
 *
 *   card      betaCardState / betaCardHtml: hidden with mode off/all/unset (AC1,
 *             AC6); offer card for a verified NON-pilot owner in offer mode;
 *             hidden for a pilot owner, an unverified owner, wrong vertical and
 *             on a DB error (fail closed); interest card at/over the cap; active
 *             card (badge + Slå av) once enrolled; lists only `beta`-tier features
 *   N2        an active row for an owner whose claim was revoked grants no beta,
 *             in the single and bulk access paths
 *   N1        admin-initiated outreach is capped at the pilot list — never a
 *             beta-enrolled owner (productImportOutreachAdminEnabledFor)
 *   routes    POST /eier/:id/beta/{pa,av,interesse}: owner session + verified
 *             owner + same-origin guard, terms required for opt-in, PRG status,
 *             mode ≠ offer rejects opt-in/interest (opt-out any mode), only the
 *             owner's own row
 *   portal    GET /eier/:id/portal shows the card only in offer mode; with the
 *             flag unset the body carries no beta markup (AC1)
 *
 * In-memory DB. Exported runBetaCardTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/beta-card.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

const NORMAL = "s3-normal";   // verified owner, NOT on the pilot list
const PILOT = "s3-pilot";     // verified owner, on the pilot list
const UNVER = "s3-unverified"; // no verified owner (claim pending)
const REVOKED = "s3-revoked"; // was a verified owner, claim later revoked
const DAY = 24 * 60 * 60 * 1000;

function envOf(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string> = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${PILOT}` };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) e[k] = v;
  return e as NodeJS.ProcessEnv;
}

const THROWING_DB: any = new Proxy({}, { get() { throw new Error("db must not be touched"); } });

export async function runBetaCardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); if (log) console.log(`  ✗ ${name} ${detail}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const bc = require("./beta-card") as typeof import("./beta-card");
  const be = require("./beta-enrollment") as typeof import("./beta-enrollment");
  const ft = require("./feature-tiers") as typeof import("./feature-tiers");
  const op = require("../services/product-import/outreach-prepare") as typeof import("../services/product-import/outreach-prepare");
  const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
  const betaRouter = (require("../routes/owner-beta") as any).default;

  const prevDb = initMod.__peekDbForTesting();
  const prevWarn = console.warn, prevErr = console.error;
  if (!log) { console.warn = () => undefined; console.error = () => undefined; }
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  const handlerOf = (r: any, path: string): Function => {
    const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.post);
    if (!layer) throw new Error(`route not found: POST ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  type Res = { status: number; body: string; location?: string };
  const invoke = (handler: Function, o: { params?: Record<string, string>; token?: string; body?: any; headers?: Record<string, string> }) =>
    new Promise<Res>((resolve) => {
      const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      const req: any = { method: "POST", url: "/", path: "/", params: o.params || {}, body: o.body, query: {}, headers, cookies: {}, ip: "127.0.0.1", protocol: "https", hostname: "rettfrabonden.com", get: (n: string) => headers[n.toLowerCase()] };
      let status = 200, settled = false;
      const settle = (r: Res) => { if (!settled) { settled = true; resolve(r); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(b: any) { settle({ status, body: typeof b === "string" ? b : JSON.stringify(b) }); return res; },
        send(b: any) { settle({ status, body: String(b ?? "") }); return res; },
        end() { settle({ status, body: "" }); return res; },
        redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
        setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; },
      };
      try { handler(req, res, () => settle({ status: 0, body: "next" })); } catch (e) { settle({ status: -1, body: String(e) }); }
    });

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    be.__setBetaEnrollmentTestDb(db);

    // Seed four producers + a logged-in owner session (magic_links) for each.
    const insAgent = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')`);
    const tok: Record<string, string> = {};
    for (const id of [NORMAL, PILOT, UNVER, REVOKED]) {
      insAgent.run(id, `Gård ${id}`, `${id}@farm.example.no`, `k-${id}`);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, products, data_source) VALUES (?, ?, 'https://example.no', '[]', 'hybrid')`).run(id, `${id}@farm.example.no`);
      tok[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`ml-${id}`, `${id}@farm.example.no`, tok[id], id, new Date().toISOString(), new Date(Date.now() + 30 * DAY).toISOString());
    }
    // NORMAL, PILOT, REVOKED are verified owners (claimed_at); UNVER has only a pending claim.
    db.prepare("UPDATE agents SET claimed_at = '2026-11-01T00:00:00Z' WHERE id IN (?, ?, ?)").run(NORMAL, PILOT, REVOKED);
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c-unver', ?, 'Noen', 'noen@example.no', 'pending')").run(UNVER);

    const offer = envOf({ OWNER_BETA_MODE: "offer", OWNER_FEATURE_TIERS: "dashboard=beta,orders=beta" });

    // ── betaCardState / betaCardHtml eligibility ────────────────────────────
    {
      // AC1 / AC6: no card in any non-offer mode.
      for (const [label, env] of [["unset", envOf({ OWNER_FEATURE_TIERS: "dashboard=beta" })], ["off", envOf({ OWNER_BETA_MODE: "off", OWNER_FEATURE_TIERS: "dashboard=beta" })], ["all", envOf({ OWNER_BETA_MODE: "all", OWNER_FEATURE_TIERS: "dashboard=beta" })]] as Array<[string, NodeJS.ProcessEnv]>) {
        check(`card hidden, mode ${label}`, bc.betaCardState(NORMAL, true, env, db).kind === "hidden");
        check(`card html empty, mode ${label}`, bc.betaCardHtml(NORMAL, true, env, db) === "");
      }
      // offer: verified non-pilot owner, no row → the offer card, listing beta features only.
      const s = bc.betaCardState(NORMAL, true, offer, db);
      check("offer: verified non-pilot owner → offer card", s.kind === "offer");
      check("offer: lists only beta-tier features", s.kind === "offer" && JSON.stringify(s.features) === JSON.stringify(["dashboard", "orders"]));
      check("offer: within cap → offer (not interest)", s.kind === "offer" && s.withinCap === true);
      const htmlOffer = bc.betaCardHtml(NORMAL, true, offer, db);
      check("offer card html: has the opt-in form + terms checkbox", htmlOffer.includes(`/eier/${NORMAL}/beta/pa`) && htmlOffer.includes('name="vilkar"') && htmlOffer.includes("required"));
      check("offer card html: is clearly placeholder (AC8)", htmlOffer.includes("[PLASSHOLDER]"));
      // Hidden: pilot owner, unverified owner, missing id, no beta feature.
      check("hidden: pilot owner never sees the card", bc.betaCardState(PILOT, true, offer, db).kind === "hidden");
      check("hidden: unverified owner (isVerified=false)", bc.betaCardState(NORMAL, false, offer, db).kind === "hidden");
      check("hidden: missing agent id", bc.betaCardState("", true, offer, db).kind === "hidden");
      check("hidden: no beta-tier feature → nothing to offer", bc.betaCardState(NORMAL, true, envOf({ OWNER_BETA_MODE: "offer" }), db).kind === "hidden");
      // Fail closed: a DB error → hidden, never shown.
      check("fail closed: DB error → hidden", bc.betaCardState(NORMAL, true, offer, THROWING_DB).kind === "hidden");
    }

    // ── Opt-in → active card with badge + Slå av; AC3 exactly the beta features ──
    {
      be.optIn("rfb", NORMAL, "v1", { env: offer });
      const s = bc.betaCardState(NORMAL, true, offer, db);
      check("active: enrolled owner → active card", s.kind === "active");
      const h = bc.betaCardHtml(NORMAL, true, offer, db);
      check("active card: Beta badge present", h.includes(">Beta<"));
      check("active card: Slå av beta form", h.includes(`/eier/${NORMAL}/beta/av`));
      // AC3: the owner now has exactly the beta features, and nothing on a pilot tier.
      check("AC3: dashboard (beta) allowed, source beta", ft.ownerFeatureAccess("dashboard", "rfb", NORMAL, offer).source === "beta");
      check("AC3: a pilot-tier feature stays denied", !ft.ownerFeatureAccess("mine_valg", "rfb", NORMAL, offer).allowed);
      be.optOut("rfb", NORMAL);
      // AC5: opt-out → the feature disappears at once (access follows ownerFeatureAccess).
      check("AC5: after opt-out, beta feature denied immediately", !ft.ownerFeatureAccess("dashboard", "rfb", NORMAL, offer).allowed);
      check("AC5: data retained — the row still exists (opted_out)", be.betaEnrollmentStatus("rfb", NORMAL, db) === "opted_out");
    }

    // ── Cap → interest card; raise → offer again ────────────────────────────
    {
      db.prepare("DELETE FROM owner_beta_enrollment").run();
      be.optIn("rfb", PILOT, "v1", { env: envOf({ OWNER_BETA_MODE: "offer" }) }); // one active row occupies the cap
      const cap1 = envOf({ OWNER_BETA_MODE: "offer", OWNER_BETA_CAP: "1", OWNER_FEATURE_TIERS: "dashboard=beta" });
      const atCap = bc.betaCardState(NORMAL, true, cap1, db);
      check("cap reached: interest card (Meld interesse), not opt-in", atCap.kind === "offer" && atCap.withinCap === false);
      const hCap = bc.betaCardHtml(NORMAL, true, cap1, db);
      check("cap card html: register-interest form", hCap.includes(`/eier/${NORMAL}/beta/interesse`));
      const raised = envOf({ OWNER_BETA_MODE: "offer", OWNER_BETA_CAP: "10", OWNER_FEATURE_TIERS: "dashboard=beta" });
      check("cap raised: offer (Slå på) again", (bc.betaCardState(NORMAL, true, raised, db) as any).withinCap === true);
      db.prepare("DELETE FROM owner_beta_enrollment").run();
    }

    // ── N2: a revoked-claim owner with an active row gets no beta ────────────
    {
      be.optIn("rfb", REVOKED, "v1", { env: offer });
      check("N2: active + still verified → allowed", ft.ownerFeatureAccess("dashboard", "rfb", REVOKED, offer).allowed);
      check("N2: active row in the verified bulk set", ft.ownerFeatureAllowedRfbIds("dashboard", { env: offer, db }).includes(REVOKED));
      // Revoke the claim: clear claimed_at and leave no verified agent_claims row.
      db.prepare("UPDATE agents SET claimed_at = NULL WHERE id = ?").run(REVOKED);
      check("N2 single: revoked owner → beta denied", !ft.ownerFeatureAccess("dashboard", "rfb", REVOKED, offer).allowed);
      check("N2 bulk: revoked owner dropped from the set", !ft.ownerFeatureAllowedRfbIds("dashboard", { env: offer, db }).includes(REVOKED));
      db.prepare("UPDATE agents SET claimed_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(REVOKED);
      db.prepare("DELETE FROM owner_beta_enrollment").run();
    }

    // ── N1: admin-initiated outreach is capped at the pilot list ────────────
    {
      be.optIn("rfb", NORMAL, "v1", { env: offer }); // NORMAL is a beta owner (not pilot)
      const pilotEnv = envOf({ PRODUCT_IMPORT_OUTREACH_ENABLED: "pilot", OWNER_BETA_MODE: "offer", OWNER_FEATURE_TIERS: "product_import_outreach=beta" });
      check("N1: pilot-list owner is reachable by admin outreach", op.productImportOutreachAdminEnabledFor(PILOT, pilotEnv) === true);
      check("N1: a beta owner is NOT reached by admin outreach", op.productImportOutreachAdminEnabledFor(NORMAL, pilotEnv) === false);
      check("N1: but the beta owner's own feature access IS on", ft.ownerFeatureAccess("product_import_outreach", "rfb", NORMAL, pilotEnv).allowed);
      check("N1: mode all → admin may reach anyone (flag fully on)", op.productImportOutreachAdminEnabledFor(NORMAL, envOf({ PRODUCT_IMPORT_OUTREACH_ENABLED: "1" })) === true);
      check("N1: mode off → nobody", op.productImportOutreachAdminEnabledFor(PILOT, envOf({ PRODUCT_IMPORT_OUTREACH_ENABLED: "0" })) === false);
      be.optOut("rfb", NORMAL);
      db.prepare("DELETE FROM owner_beta_enrollment").run();
    }

    // ── POST routes (gate, terms, same-origin, PRG, only-own-row) ───────────
    {
      const prevMode = process.env.OWNER_BETA_MODE, prevTiers = process.env.OWNER_FEATURE_TIERS, prevAllow = process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      process.env.OWNER_BETA_MODE = "offer";
      process.env.OWNER_FEATURE_TIERS = "dashboard=beta,orders=beta";
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${PILOT}`;
      const H = { pa: handlerOf(betaRouter, "/eier/:agentId/beta/pa"), av: handlerOf(betaRouter, "/eier/:agentId/beta/av"), interesse: handlerOf(betaRouter, "/eier/:agentId/beta/interesse") };
      const rowOf = (id: string) => be.betaEnrollmentStatus("rfb", id, db);

      // No session → bounce to login.
      const noSess = await invoke(H.pa, { params: { agentId: NORMAL }, body: { vilkar: "1" } });
      check("route: no session → 302 to login", noSess.status === 302 && String(noSess.location).includes(`/eier/${NORMAL}`));

      // Opt-in without the terms checkbox → beta_terms, no row written.
      const noTerms = await invoke(H.pa, { params: { agentId: NORMAL }, token: tok[NORMAL], body: {} });
      check("route: opt-in without terms → beta_terms", noTerms.status === 303 && String(noTerms.location).includes("status=beta_terms"));
      check("route: no row written without terms", rowOf(NORMAL) === null);

      // Cross-site write → 403, nothing written.
      const xsite = await invoke(H.pa, { params: { agentId: NORMAL }, token: tok[NORMAL], body: { vilkar: "1" }, headers: { "sec-fetch-site": "cross-site" } });
      check("route: cross-site opt-in → 403", xsite.status === 403);
      check("route: cross-site wrote nothing", rowOf(NORMAL) === null);

      // Opt-in with terms → beta_on, active row.
      const on = await invoke(H.pa, { params: { agentId: NORMAL }, token: tok[NORMAL], body: { vilkar: "1" } });
      check("route: opt-in with terms → beta_on", on.status === 303 && String(on.location).includes("status=beta_on"));
      check("route: active row written", rowOf(NORMAL) === "active");

      // Only own row: a session for NORMAL cannot change PILOT's row.
      const other = await invoke(H.pa, { params: { agentId: PILOT }, token: tok[NORMAL], body: { vilkar: "1" } });
      check("route: session for another agent → 403", other.status === 403);

      // Opt-out → beta_off, row opted_out (data retained).
      const off = await invoke(H.av, { params: { agentId: NORMAL }, token: tok[NORMAL], body: {} });
      check("route: opt-out → beta_off", off.status === 303 && String(off.location).includes("status=beta_off"));
      check("route: opt-out keeps the row (opted_out)", rowOf(NORMAL) === "opted_out");

      // Opt-in rejected when mode ≠ offer; opt-out still allowed.
      process.env.OWNER_BETA_MODE = "off";
      const offModeIn = await invoke(H.pa, { params: { agentId: UNVER }, token: tok[UNVER], body: { vilkar: "1" } });
      check("route: mode off → opt-in refused at the gate (unverified) ", offModeIn.status === 403 || String(offModeIn.location).includes("status=beta"));
      // A verified owner in mode off: opt-in answers not_offered.
      const offModeNormal = await invoke(H.pa, { params: { agentId: REVOKED }, token: tok[REVOKED], body: { vilkar: "1" } });
      check("route: mode off, verified owner → beta_not_offered", offModeNormal.status === 303 && String(offModeNormal.location).includes("status=beta_not_offered"));
      check("route: mode off opt-in wrote no row", rowOf(REVOKED) === null);
      process.env.OWNER_BETA_MODE = "offer";

      // Register interest.
      const interest = await invoke(H.interesse, { params: { agentId: REVOKED }, token: tok[REVOKED], body: {} });
      check("route: register interest → beta_interest", interest.status === 303 && String(interest.location).includes("status=beta_interest"));
      check("route: interest row written", rowOf(REVOKED) === "interested");

      db.prepare("DELETE FROM owner_beta_enrollment").run();
      if (prevMode === undefined) delete process.env.OWNER_BETA_MODE; else process.env.OWNER_BETA_MODE = prevMode;
      if (prevTiers === undefined) delete process.env.OWNER_FEATURE_TIERS; else process.env.OWNER_FEATURE_TIERS = prevTiers;
      if (prevAllow === undefined) delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS; else process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = prevAllow;
    }

    // ── Portal GET: card only in offer mode; AC1 flag-off → no beta markup ───
    {
      const portalGet = (r: any, path: string): Function => {
        const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
        return layer.route.stack[layer.route.stack.length - 1].handle;
      };
      const H = portalGet(portalMod.default, "/eier/:agentId/portal");
      const getPortal = (id: string) => new Promise<string>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", authorization: `Bearer ${tok[id]}` };
        const req: any = { method: "GET", url: "/", path: "/", params: { agentId: id }, query: {}, headers, cookies: {}, ip: "127.0.0.1", protocol: "https", hostname: "rettfrabonden.com", get: (n: string) => headers[n.toLowerCase()] };
        let status = 200, settled = false;
        const settle = (b: string) => { if (!settled) { settled = true; resolve(b); } };
        const res: any = { status(c: number) { status = c; return res; }, json() { settle(""); return res; }, send(b: any) { settle(String(b ?? "")); return res; }, end() { settle(""); return res; }, redirect() { settle(""); return res; }, setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; } };
        void status;
        try { H(req, res, () => settle("")); } catch { settle(""); }
      });

      const prevMode = process.env.OWNER_BETA_MODE, prevTiers = process.env.OWNER_FEATURE_TIERS, prevAllow = process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      // Flag unset → the portal carries no beta markup (AC1).
      delete process.env.OWNER_BETA_MODE; delete process.env.OWNER_FEATURE_TIERS;
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${PILOT}`;
      for (const id of [NORMAL, PILOT, UNVER]) {
        const body = await getPortal(id);
        check(`AC1 portal ${id}: no beta card with the flag unset`, !body.includes('id="beta-kort"') && !body.includes("[PLASSHOLDER]"));
      }
      // offer mode → the verified non-pilot owner sees the card; the pilot owner does not.
      process.env.OWNER_BETA_MODE = "offer"; process.env.OWNER_FEATURE_TIERS = "dashboard=beta,orders=beta";
      check("portal NORMAL offer: beta card shown", (await getPortal(NORMAL)).includes('id="beta-kort"'));
      check("portal PILOT offer: no beta card (pilot owner)", !(await getPortal(PILOT)).includes('id="beta-kort"'));
      if (prevMode === undefined) delete process.env.OWNER_BETA_MODE; else process.env.OWNER_BETA_MODE = prevMode;
      if (prevTiers === undefined) delete process.env.OWNER_FEATURE_TIERS; else process.env.OWNER_FEATURE_TIERS = prevTiers;
      if (prevAllow === undefined) delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS; else process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = prevAllow;
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err?.message || err}`);
  } finally {
    be.__setBetaEnrollmentTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
    console.warn = prevWarn; console.error = prevErr;
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBetaCardTests({ log: true }).then((r) => {
    console.log(`\nbeta-card: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(`  FAIL ${f}`);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
