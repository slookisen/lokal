/**
 * rfb-claim-vurdering.test.ts — dev-request
 * 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk, slice A
 * (record-only), route level: POST /agents/:id/claim with
 * CLAIM_AUTO_ASSESSMENT_ENABLED
 *   (off)  no assessment stored, no assessment network call, and the response
 *          is the same as with the flag on (and as before);
 *   (on)   the assessment is stored on the new claim row (queue entry and
 *          code_sent), the outcome — status code, body, e-mails, ownership,
 *          recommendation — is unchanged;
 *   (q)    GET /admin/agents/claim-review-queue shows `assessment` (parsed
 *          JSON, or null);
 *   (err)  an assessment that throws never touches the submission, and the
 *          warning carries no PII;
 *   (priv) no Brreg person name in the stored JSON;
 *   (mig)  claim_assessment / claim_assessment_at are added idempotently.
 *
 * Same harness as rfb-claim-domeneregel.test.ts: the real handlers off the
 * routers' stacks, fake req/res, an in-memory DB, a stub mail transporter,
 * stub assessment deps — no network.
 *
 * Exported runRfbClaimVurderingTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-vurdering.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

export async function runRfbClaimVurderingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");

  const ENV_KEYS = ["CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_CODE_MAX_FAILED_ATTEMPTS",
    "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX", "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX",
    "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX", "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS.slice(0, 7)) delete process.env[k];
  process.env.CLAIM_CODE_SENDS_PER_HOUR_MAX = "100";
  process.env.CLAIM_REVIEW_INSERTS_PER_HOUR_MAX = "200";
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-vurdering-standalone-key";
  if (!process.env.ADMIN_KEY && !process.env.ANALYTICS_ADMIN_KEY) process.env.ADMIN_KEY = ADMIN;
  delete process.env.ADMIN_NOTIFICATION_EMAIL;
  const assessOn = () => { process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = "true"; };
  const assessOff = () => { delete process.env.CLAIM_AUTO_ASSESSMENT_ENABLED; };

  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: Array<{ to: string; subject: string }> = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject) });
      return { messageId: `stub-${mails.length}` };
    },
  };

  const rule = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
  rule.__setDomainHttpsCheckForTesting(async () => true);
  const ca = require("../services/claim-assessment") as typeof import("../services/claim-assessment");
  const calls: string[] = [];
  const NOW = new Date("2026-11-02T12:00:00.000Z");
  let brregDown = false;
  const stubDeps: Partial<import("../services/claim-assessment").ClaimAssessmentDeps> = {
    now: () => NOW,
    timeoutMs: 50,
    fetchApi: async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://data.brreg.no/")) {
        if (brregDown) throw new Error("ECONNREFUSED");
        return { status: 200, body: JSON.stringify({ rollegrupper: [{ roller: [
          { type: { kode: "DAGL" }, person: { navn: { fornavn: "Kari", etternavn: "Nordmann" } } },
          { type: { kode: "MEDL" }, person: { navn: { fornavn: "Ingrid", etternavn: "Bakkestuen" } } },
        ] }] }) };
      }
      return { status: 200, body: JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2026-04-01T00:00:00Z" }] }) };
    },
    fetchSite: async (host: string) => { calls.push(`site:${host}`); return { status: 200, body: "<html>Velkommen</html>" }; },
    resolveMx: async (d: string) => { calls.push(`mx:${d}`); return [{ exchange: `mx.${d}`, priority: 10 }]; },
  };
  ca.__setClaimAssessmentDepsForTesting(stubDeps);
  ca.__resetClaimIpWindowForTesting();

  function findRoute(router: any, path: string, method: "get" | "post"): any {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route;
  }
  const handlerOf = (router: any, path: string, method: "get" | "post"): Function => {
    const route = findRoute(router, path, method);
    return route.stack[route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any; headers?: Record<string, string>; ip?: string }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      params: o.params || {}, body: o.body, query: {}, headers, ip: o.ip ?? "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const done = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { done(p); return res; },
        send(p: any) { done(p); return res; },
        end() { done(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, () => done({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => done({ __error: String(err) }));
      } catch (err) {
        done({ __error: String(err) });
      }
    });
  }

  try {
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./marketplace")];
    delete require.cache[require.resolve("./admin-agents")];
    const marketplaceRouter = require("./marketplace").default as any;
    const adminAgentsRouter = require("./admin-agents").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const queueH = handlerOf(adminAgentsRouter, "/claim-review-queue", "get");
    const admin = { "x-admin-key": ADMIN };

    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, is_vetted, org_nr)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery', 1, ?)`,
    );
    function agent(id: string, website: string, orgNr: string, phone: string | null = null): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`, orgNr);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, phone, data_source, curated_fields, field_provenance)
                  VALUES (?, NULL, ?, ?, 'auto', '{}', '{}')`).run(id, website, phone);
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT is_verified, claimed_at, claimed_via FROM agents WHERE id = ?").get(id);
    // One IP per profile, so the velocity_ip flag (≥ 3 claims per IP in 24 h) stays out of the way.
    const claim = (agentId: string, body: Record<string, unknown>, ip = `198.51.100.${agentId.length}${agentId.charCodeAt(3)}`) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body, ip }));
    const normalize = (b: any, claimId: string): string => JSON.stringify(b).split(claimId).join("<id>");

    // ══ (off) flag off → nothing stored, no assessment network call ══════
    assessOff();
    const off = (() => ({ id: agent("va-off", "https://www.gard-off.no/", "911111111") }))();
    const mOff = mails.length;
    const rOff = await claim(off.id, { name: "Kari Nordmann", email: "kari@gard-off.no" });
    await ca.__waitForClaimAssessmentsForTesting();
    eq([rOff.status, rOff.body?.data?.status, rOff.body?.data?.reason], [202, "pending_review", "no_known_email"],
      "off: claim → 202 queue (no_known_email), as before");
    const rowOff = claimRow(rOff.body.data.claimId);
    eq([rowOff.claim_assessment, rowOff.claim_assessment_at], [null, null], "off: no claim_assessment stored");
    eq(calls.length, 0, "off: no assessment network call at all");
    const mailsOff = mails.length - mOff;

    // ══ (on) flag on → stored, outcome unchanged ═════════════════════════
    assessOn();
    agent("va-on", "https://www.gard-on.no/", "922222222");
    const mOn = mails.length;
    const rOn = await claim("va-on", { name: "Kari Nordmann", email: "kari@gard-on.no" });
    eq(rOn.status, rOff.status, "on: same status code as flag off");
    eq(normalize(rOn.body, rOn.body?.data?.claimId), normalize(rOff.body, rOff.body?.data?.claimId),
      "on: response body byte-identical to flag off (claim id aside)");
    await ca.__waitForClaimAssessmentsForTesting();
    eq(mails.length - mOn, mailsOff, "on: the same e-mails as flag off");
    const rowOn = claimRow(rOn.body.data.claimId);
    eq([rowOn.status, rowOn.review_reason, rowOn.recommendation, rowOn.code_sent_to],
      [rowOff.status, rowOff.review_reason, rowOff.recommendation, rowOff.code_sent_to], "on: the claim row's outcome fields are unchanged");
    eq([agentRow("va-on").is_verified, agentRow("va-on").claimed_at], [agentRow("va-off").is_verified, null], "on: no ownership, no badge change");
    ok(typeof rowOn.claim_assessment === "string", "on: claim_assessment stored");
    eq(rowOn.claim_assessment_at, NOW.toISOString(), "on: claim_assessment_at from the injected clock");
    const stored = JSON.parse(rowOn.claim_assessment);
    eq([stored.result, stored.anchors, stored.supports, stored.red_flags, stored.rule_version], ["green", ["A1"], ["S1"], [], "A1"],
      "on: the stored assessment (A1 + S1, no flags → green — recorded only)");
    ok(calls.includes("https://data.brreg.no/enhetsregisteret/api/enheter/922222222/roller"), "on: Brreg asked (stubbed) for the profile's org.nr");
    ok(calls.includes("https://rdap.norid.no/domain/gard-on.no"), "on: Norid RDAP asked (stubbed)");
    // (priv)
    for (const name of ["Kari", "Nordmann", "Ingrid", "Bakkestuen"]) {
      ok(!rowOn.claim_assessment.includes(name), `priv: «${name}» not in the stored JSON`);
    }

    // ══ (q) the admin queue shows the assessment ════════════════════════
    {
      const q = await invoke(queueH, makeReq({ headers: admin }));
      eq(q.status, 200, "q: queue 200");
      const eOn = (q.body?.entries ?? []).find((e: any) => e.claim_id === rOn.body.data.claimId);
      const eOff = (q.body?.entries ?? []).find((e: any) => e.claim_id === rOff.body.data.claimId);
      eq(eOn?.assessment?.result, "green", "q: `assessment` is the parsed JSON");
      eq(eOff?.assessment, null, "q: `assessment` is null when none was stored");
      ok(!("claim_assessment" in (eOn ?? {})), "q: the raw column is not exposed");
    }

    // ══ a repeat (queued, created=false) is not re-assessed ═════════════
    {
      const before = claimRow(rOn.body.data.claimId);
      brregDown = true; // a re-assessment would now store yellow
      const n0 = calls.length;
      const rep = await claim("va-on", { name: "Kari Nordmann", email: "kari@gard-on.no" });
      await ca.__waitForClaimAssessmentsForTesting();
      brregDown = false;
      eq([rep.status, rep.body?.data?.claimId], [202, rOn.body.data.claimId], "repeat: the claimant's own open entry is returned");
      const after = claimRow(rOn.body.data.claimId);
      eq([after.claim_assessment, after.claim_assessment_at], [before.claim_assessment, before.claim_assessment_at],
        "repeat: the earlier assessment is not overwritten");
      eq(calls.length, n0, "repeat: no assessment network call");
    }

    // ══ off the request path: nothing is read before the response ══════
    {
      agent("va-async", "https://www.gard-async.no/", "988888888");
      const r = await claim("va-async", { name: "Kari Nordmann", email: "kari@gard-async.no" });
      eq(claimRow(r.body.data.claimId).claim_assessment, null, "async: no assessment yet when the response is sent");
      await ca.__waitForClaimAssessmentsForTesting();
      ok(typeof claimRow(r.body.data.claimId).claim_assessment === "string", "async: stored afterwards");
    }

    // ══ code_sent path (domain rule P1) ══════════════════════════════════
    {
      process.env.CLAIM_DOMAIN_RULE_ENABLED = "1";
      agent("va-p1", "https://www.gard-p1.no/", "933333333");
      const m0 = mails.length;
      const r = await claim("va-p1", { name: "Kari Nordmann", email: "kari@gard-p1.no" });
      eq([r.status, r.body?.data?.status, r.body?.data?.via], [200, "code_sent", "domain_match_independent"], "p1: code_sent outcome unchanged");
      eq(mails.length - m0, 1, "p1: exactly the one code e-mail");
      await ca.__waitForClaimAssessmentsForTesting();
      const row = claimRow(r.body.data.claimId);
      eq([row.status, row.recommendation], ["code_sent", "domain_match_independent"], "p1: row unchanged");
      ok(JSON.parse(row.claim_assessment ?? "{}").result === "green", "p1: assessment stored on the code_sent row");
      const again = await claim("va-p1", { name: "Kari Nordmann", email: "kari@gard-p1.no" });
      eq(again.body?.data?.status, "code_already_sent", "p1: a repeat returns the open code (no new row)");
      delete process.env.CLAIM_DOMAIN_RULE_ENABLED;
    }

    // ══ Brreg down → yellow, stored ═════════════════════════════════════
    {
      brregDown = true;
      agent("va-brdown", "https://www.gard-brdown.no/", "944444444");
      const r = await claim("va-brdown", { name: "Kari Nordmann", email: "kari@gard-brdown.no" });
      eq(r.status, 202, "brreg down: the submission is unaffected");
      await ca.__waitForClaimAssessmentsForTesting();
      const a = JSON.parse(claimRow(r.body.data.claimId).claim_assessment ?? "{}");
      eq([a.result, a.unavailable_sources], ["yellow", ["brreg_roller"]], "brreg down: stored as yellow, brreg_roller unavailable");
      brregDown = false;
    }

    // ══ sibling profile (same phone, written differently) → yellow ══════
    {
      agent("va-sib1", "https://www.gard-sib1.no/", "977777771", "912 34 567");
      agent("va-sib2", "https://www.gard-sib2.no/", "977777772", "+47 91234567");
      const r = await claim("va-sib2", { name: "Kari Nordmann", email: "kari@gard-sib2.no" });
      await ca.__waitForClaimAssessmentsForTesting();
      const a = JSON.parse(claimRow(r.body.data.claimId).claim_assessment ?? "{}");
      eq([r.status, a.result, a.possible_duplicate, a.anchors], [202, "yellow", true, ["A1"]],
        "sibling: a profile with the same phone (other spelling) → possible duplicate, yellow");
    }

    // ══ velocity_ip: the 3rd new claim from one IP in 24 h → red (recorded only) ══
    {
      const ip = "203.0.113.9";
      const results: string[] = [];
      for (const [id, orgNr] of [["va-ip1", "966666661"], ["va-ip2", "966666662"], ["va-ip3", "966666663"]] as const) {
        agent(id, `https://www.gard-${id}.no/`, orgNr);
        const r = await claim(id, { name: "Kari Nordmann", email: `kari@gard-${id}.no` }, ip);
        await ca.__waitForClaimAssessmentsForTesting();
        eq(r.status, 202, `velocity: ${id} submission unaffected`);
        results.push(JSON.parse(claimRow(r.body.data.claimId).claim_assessment ?? "{}").red_flags?.includes("velocity_ip") ? "ip" : "-");
      }
      eq(results, ["-", "-", "ip"], "velocity: the 3rd claim from the same IP in 24 h carries velocity_ip");
    }

    // ══ (err) the assessment fails → submission untouched, no PII logged ═
    {
      ca.__setClaimAssessmentDepsForTesting({ ...stubDeps, now: () => { throw new Error("clock broke"); } });
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
      let r: HandlerResult;
      try {
        agent("va-err", "https://www.gard-err.no/", "955555555");
        r = await claim("va-err", { name: "Kari Nordmann", email: "kari@gard-err.no", phone: "91234567" });
        await ca.__waitForClaimAssessmentsForTesting();
      } finally {
        console.warn = origWarn;
        ca.__setClaimAssessmentDepsForTesting(stubDeps);
      }
      eq([r.status, r.body?.data?.status], [202, "pending_review"], "err: the submission's outcome is unchanged");
      eq(claimRow(r.body.data.claimId).claim_assessment, null, "err: nothing stored");
      const w = warns.filter((x) => x.includes("[claim-assessment]"));
      eq(w.length, 1, "err: one warning logged");
      ok(w.every((x) => !x.includes("kari") && !x.includes("Kari") && !x.includes("91234567")), "err: the warning carries no PII");
    }

    // ══ (mig) the columns are added once ════════════════════════════════
    {
      const old = new Database(":memory:");
      initMod.__initSchemaForTesting(old);
      old.pragma("foreign_keys = OFF");
      old.exec("ALTER TABLE agent_claims DROP COLUMN claim_assessment");
      old.exec("ALTER TABLE agent_claims DROP COLUMN claim_assessment_at");
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason) VALUES ('o1', 'x', 'n', 'e@x.no', 'pending_review', 'no_known_email')").run();
      initMod.__initSchemaForTesting(old);
      initMod.__initSchemaForTesting(old);
      const cols = (old.prepare("PRAGMA table_info(agent_claims)").all() as Array<{ name: string }>).map((c) => c.name);
      eq([cols.filter((c) => c === "claim_assessment").length, cols.filter((c) => c === "claim_assessment_at").length], [1, 1],
        "mig: both columns added once (idempotent)");
      eq(old.prepare("SELECT status, claim_assessment FROM agent_claims WHERE id = 'o1'").get(), { status: "pending_review", claim_assessment: null },
        "mig: existing rows keep their values, claim_assessment NULL");
      old.close();
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-vurdering: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    try { await ca.__waitForClaimAssessmentsForTesting(); } catch { /* ignore */ }
    ca.__setClaimAssessmentDepsForTesting(null);
    ca.__resetClaimIpWindowForTesting();
    rule.__setDomainHttpsCheckForTesting(null);
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  if (!process.env.EMAIL_FORCE_DRY_RUN) process.env.EMAIL_FORCE_DRY_RUN = "true";
  runRfbClaimVurderingTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-vurdering: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
