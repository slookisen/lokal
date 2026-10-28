/**
 * rfb-claim-domeneregel.test.ts — dev-request
 * 2026-10-27-rfb-eierkrav-domeneregel-og-cs-sjekkliste, slice 1 (server).
 *
 * The claim domain rule (services/claim-domain-rule.ts, knowledge-service.ts
 * requestClaimWithDomainRule) behind CLAIM_DOMAIN_RULE_ENABLED:
 *   (ac1) independent website + claim from name@same-domain → code to that
 *         address, no queue, the right code gives ownership (as rule 1);
 *   (ac2) the same, but the website came from the self-registration or the
 *         owner (or is otherwise not independent) → not P1;
 *   (ac3) gmail/hotmail/online.no … → never P1/P2: queue, free_mail_needs_extra;
 *   (ac4) a profile with an owner → queue, has_owner (unchanged);
 *   (ac5) P2: a self-registered profile gets an owner, but is_vetted stays 0
 *         and no badge; a discovery profile owned via P2 gets no badge either;
 *   (ac6) flag off → the old behaviour (queue no_known_email, no probe, no
 *         mail), only `recommendation` is new;
 *   (ac7) HTTPS probe false / throws / non-true → queue (needs_review);
 *   (ac8) domain normalization (www., subdomain, upper case, trailing dot),
 *         IP-literal and internal e-mail domains refused, the probe's guards;
 *   (q)   GET /admin/agents/claim-review-queue shows `recommendation`, and the
 *         admin notice shows the rule and what Daniel can do;
 *   (mig) the recommendation column is added to an older table, idempotently.
 *
 * Same harness as rfb-claim-kjent-kontakt.test.ts: the real handlers off the
 * routers' stacks, fake req/res, an in-memory DB, a stub mail transporter and
 * a stub HTTPS probe — no network.
 *
 * Exported runRfbClaimDomeneregelTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-domeneregel.test.ts
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

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

export async function runRfbClaimDomeneregelTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS",
    "CLAIM_CODE_SENDS_PER_HOUR_MAX", "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX",
    "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "NODE_ENV", "FLY_APP_NAME"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS.slice(0, 6)) delete process.env[k];
  // This suite sends more codes than the platform's hourly default (10).
  process.env.CLAIM_CODE_SENDS_PER_HOUR_MAX = "100";
  process.env.CLAIM_REVIEW_INSERTS_PER_HOUR_MAX = "200";
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-domeneregel-standalone-key";
  if (!process.env.ADMIN_KEY && !process.env.ANALYTICS_ADMIN_KEY) process.env.ADMIN_KEY = ADMIN;
  delete process.env.ADMIN_NOTIFICATION_EMAIL;
  const flagOn = () => { process.env.CLAIM_DOMAIN_RULE_ENABLED = "1"; };
  const flagOff = () => { delete process.env.CLAIM_DOMAIN_RULE_ENABLED; };

  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const codeIn = (m: SentMail | undefined): string => (m?.text.match(/\b(\d{6})\b/) ?? [])[1] ?? "";

  const rule = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
  // The HTTPS probe: a stub that records each domain and answers `probeAnswer`.
  const probed: string[] = [];
  let probeAnswer: () => Promise<boolean> = async () => true;
  rule.__setDomainHttpsCheckForTesting(async (d: string) => { probed.push(d); return probeAnswer(); });

  function findRoute(router: any, path: string, method: "get" | "post"): any {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route;
  }
  const handlerOf = (router: any, path: string, method: "get" | "post"): Function => {
    const route = findRoute(router, path, method);
    return route.stack[route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      params: o.params || {}, body: o.body, query: {}, headers, ip: "127.0.0.1", lang: "no", protocol: "https",
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
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const { maskEmail } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const verifyH = handlerOf(marketplaceRouter, "/agents/:id/claim/verify", "post");
    const queueH = handlerOf(adminAgentsRouter, "/claim-review-queue", "get");
    const admin = { "x-admin-key": ADMIN };

    // ── fixtures ────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at, claimed_via, origin, is_vetted)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?)`,
    );
    interface AgentOpts {
      origin?: string; isVetted?: number; claimedAt?: string | null; listed?: string | null; website?: string | null;
      dataSource?: string; ownerUpdatedAt?: string | null; curated?: string; provenance?: string; noKnowledge?: boolean;
    }
    function agent(id: string, o: AgentOpts = {}): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`,
        o.claimedAt ?? null, o.claimedAt ? "admin" : null, o.origin ?? "discovery", o.isVetted ?? (o.origin === "self_registered" ? 0 : 1));
      if (!o.noKnowledge) {
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, data_source, owner_updated_at, curated_fields, field_provenance)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, o.listed ?? null, o.website ?? null, o.dataSource ?? "auto", o.ownerUpdatedAt ?? null, o.curated ?? "{}", o.provenance ?? "{}");
      }
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT is_verified, is_vetted, claimed_at, claimed_via FROM agents WHERE id = ?").get(id);
    const claimsOf = (agentId: string): any[] => db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? ORDER BY created_at, id").all(agentId) as any[];
    const claim = (agentId: string, body: Record<string, unknown>) => invoke(claimH, makeReq({ params: { id: agentId }, body }));
    const verify = (agentId: string, claimId: string, code: unknown) => invoke(verifyH, makeReq({ params: { id: agentId }, body: { claimId, code } }));

    // ══ (ac1) P1: independent website + same domain → code to the claimant ══
    flagOn();
    {
      agent("p1", { website: "https://www.gardp1.no/om-oss" });
      eq(knowledgeService.independentWebsiteHost("p1"), "www.gardp1.no", "ac1: an enrichment-written website (data_source auto) is independent");
      const m0 = mails.length;
      const p0 = probed.length;
      const r = await claim("p1", { name: "Kari", email: "Kari@GardP1.no" });
      eq([r.status, r.body?.data?.status], [200, "code_sent"], "ac1: claim from kari@gardp1.no → 200 code_sent");
      eq(mails.length, m0 + 1, "ac1: exactly one mail");
      eq(mails[mails.length - 1]?.to, "kari@gardp1.no", "ac1: the code goes to the claimant's own (normalized) address");
      eq(r.body?.data?.sentTo, maskEmail("kari@gardp1.no"), "ac1: the response shows that recipient masked");
      ok(!JSON.stringify(r.body).includes(codeIn(mails[mails.length - 1])), "ac1: the code is not in the response");
      eq(probed.length, p0, "ac1: P1 makes no HTTPS probe");
      const row = claimRow(r.body.data.claimId);
      eq([row.status, row.code_sent_to, row.recommendation, row.review_reason], ["code_sent", "kari@gardp1.no", "domain_match_independent", null],
        "ac1: claim row: code_sent to the claimant, recommendation domain_match_independent, no review reason");
      eq(knowledgeService.listClaimReviewQueue().entries.filter((e) => e.agent_id === "p1").length, 0, "ac1: no admin-queue entry");
      const lifeH = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 3_600_000;
      ok(Math.abs(lifeH - 24) < 0.01, "ac1: the same 24 h code life as rule 1");

      const bad = await verify("p1", r.body.data.claimId, "000000");
      eq(bad.status, 400, "ac1: a wrong code → 400 (same counting as rule 1)");
      const v = await verify("p1", r.body.data.claimId, codeIn(mails[mails.length - 1]));
      eq(v.status, 200, "ac1: the right code → 200");
      ok(String(v.body?.data?.claimToken ?? "").startsWith("claim_"), "ac1: claim token issued");
      eq([agentRow("p1").is_verified, agentRow("p1").claimed_via, agentRow("p1").is_vetted], [1, "claim", 1],
        "ac1: ownership exactly as rule 1 (badge on a discovery profile, claimed_via 'claim', is_vetted untouched)");
      eq(claimRow(r.body.data.claimId).claimant_email, "kari@gardp1.no", "ac1: the owner's address is the proven one");
      eq(knowledgeService.createMagicLink("kari@gardp1.no").agentId, "p1", "ac1: e-mail login reaches the profile");

      // Subdomain mail, www site, and the existing rate limits.
      agent("p1-sub", { website: "www.gard-sub.no" });
      const rs = await claim("p1-sub", { name: "Ola", email: "ola@post.gard-sub.no" });
      eq([rs.status, mails[mails.length - 1]?.to], [200, "ola@post.gard-sub.no"], "ac1: post.gard-sub.no matches www.gard-sub.no (subdomain)");
      const again = await claim("p1-sub", { name: "Per", email: "per@gard-sub.no" });
      eq(again.status, 429, "ac1: a 2nd code on the profile within 24 h → 429 (rule 4 unchanged)");
      eq(claimsOf("p1-sub").length, 1, "ac1: … and writes nothing");

      // A listed farm e-mail still wins (rule 1), flag on or not.
      agent("p1-listed", { listed: "post@gard-listed.no", website: "https://gard-listed.no" });
      const rl = await claim("p1-listed", { name: "X", email: "x@gard-listed.no" });
      eq([rl.status, mails[mails.length - 1]?.to, claimRow(rl.body.data.claimId).recommendation], [200, "post@gard-listed.no", null],
        "ac1: with a listed farm e-mail the code goes there (rule 1), no domain rule");

      // Different domain than the independent website → no P1, no P2 → queue.
      agent("p1-other", { website: "https://gard-other.no" });
      const p1o = probed.length;
      const ro = await claim("p1-other", { name: "X", email: "x@annet-firma.no" });
      eq([ro.status, ro.body?.data?.reason, claimRow(ro.body.data.claimId).recommendation], [202, "no_known_email", "needs_review"],
        "ac1: a domain other than the independent website → queue (needs_review), no P2");
      eq(probed.length, p1o, "ac1: … and no HTTPS probe");
    }

    // ══ (ac2) website not independent → not P1 ══════════════════════════
    {
      const notIndependent: Array<[string, AgentOpts, string]> = [
        ["np-self", { origin: "self_registered", website: "https://np-self.no" }, "self_registered origin"],
        ["np-owner", { website: "https://np-owner.no", dataSource: "owner", ownerUpdatedAt: "2026-10-01T00:00:00Z" }, "written by the owner (data_source owner)"],
        ["np-hybrid", { website: "https://np-hybrid.no", dataSource: "hybrid" }, "data_source hybrid"],
        ["np-oupd", { website: "https://np-oupd.no", ownerUpdatedAt: "2026-10-01T00:00:00Z" }, "owner_updated_at set"],
        ["np-cur", { website: "https://np-cur.no", curated: JSON.stringify({ website: { by: "rfb-customer-service", locked_at: "x" } }) }, "curated_fields.website lock"],
        ["np-curbad", { website: "https://np-curbad.no", curated: "{not json" }, "curated_fields unreadable"],
        ["np-wo", { website: "https://np-wo.no", provenance: JSON.stringify({ website_ownership: { status: "unverified" } }) }, "website_ownership unverified"],
        ["np-host", { website: "https://np-host.wixsite.com/gard" }, "a hosting platform"],
      ];
      for (const [id, o, why] of notIndependent) {
        agent(id, o);
        eq(knowledgeService.independentWebsiteHost(id), null, `ac2: not an independent website: ${why}`);
      }
      probeAnswer = async () => false;
      const m0 = mails.length;
      for (const [id, , why] of notIndependent.slice(0, 2)) {
        const dom = id === "np-host" ? "wixsite.com" : `${id}.no`;
        const r = await claim(id, { name: "X", email: `post@${dom}` });
        eq([r.status, r.body?.data?.reason, claimRow(r.body.data.claimId)?.recommendation], [202, "no_known_email", "needs_review"],
          `ac2: same-domain claim on a profile whose website is ${why} → not P1 (probe false → queue)`);
      }
      eq(mails.length, m0, "ac2: no mail sent");
      eq(knowledgeService.assessClaimDomain("np-host", "x@wixsite.com").route, "p2_candidate", "ac2: a hosting-platform website never gives P1");
      probeAnswer = async () => true;
      // With a working domain, the self-registered profile goes P2 instead (ac5 checks the outcome).
      const r2 = await claim("np-hybrid", { name: "X", email: "x@np-hybrid.no" });
      eq([r2.status, claimRow(r2.body.data.claimId)?.recommendation], [200, "domain_code_sent"], "ac2: not P1, but P2 when the domain answers on HTTPS");
    }

    // ══ (ac3) free-mail → never P1/P2 ════════════════════════════════════
    {
      const p0 = probed.length;
      const m0 = mails.length;
      let i = 0;
      for (const addr of ["kari@gmail.com", "ola@Hotmail.com", "per@online.no", "x@live.no", "y@googlemail.com", "z@icloud.com", "q@yahoo.no", "w@mail.telia.no"]) {
        const id = agent(`fm-${i++}`, { website: "https://" + addr.split("@")[1]!.toLowerCase() });
        const r = await claim(id, { name: "Fri", email: addr });
        eq([r.status, r.body?.data?.reason, claimRow(r.body.data.claimId)?.recommendation], [202, "no_known_email", "free_mail_needs_extra"],
          `ac3: ${addr} → queue, free_mail_needs_extra (even with a matching 'website')`);
      }
      eq([mails.length, probed.length], [m0, p0], "ac3: no mail and no HTTPS probe for free-mail");
      ok(rule.FREE_MAIL_DOMAINS.has("gmail.com") && rule.FREE_MAIL_DOMAINS.has("online.no") && rule.FREE_MAIL_DOMAINS.has("altibox.no"),
        "ac3: the list is one exported constant");
    }

    // ══ (ac4) owner → has_owner, unchanged ═══════════════════════════════
    {
      agent("own", { website: "https://own-gard.no", claimedAt: "2026-09-01T00:00:00Z" });
      const m0 = mails.length;
      const r = await claim("own", { name: "Ny", email: "ny@own-gard.no" });
      eq([r.status, r.body?.data?.reason, claimRow(r.body.data.claimId)?.recommendation], [202, "has_owner", "has_owner"],
        "ac4: profile with an owner → queue has_owner, even with a P1-matching domain");
      eq(mails.length, m0, "ac4: no mail");
    }

    // ══ (ac5) P2: self-registered gets an owner, stays unvetted, no badge ═
    {
      probeAnswer = async () => true;
      agent("p2-self", { origin: "self_registered", website: "https://p2-self.no" });
      const p0 = probed.length;
      const r = await claim("p2-self", { name: "Selv", email: "selv@P2-Self.no" });
      eq([r.status, r.body?.data?.status], [200, "code_sent"], "ac5: self-registered + working domain → P2 code sent");
      eq(probed.slice(p0), ["p2-self.no"], "ac5: the probe got the claimant's normalized domain, once");
      eq([mails[mails.length - 1]?.to, claimRow(r.body.data.claimId).recommendation], ["selv@p2-self.no", "domain_code_sent"],
        "ac5: code to the claimant, recommendation domain_code_sent");
      ok(String(r.body?.message).includes("Verifiseringskode sendt til") && !String(r.body?.message).includes("gårdens e-post"),
        "ac5: the message does not call the claimant's address the farm's");
      const v = await verify("p2-self", r.body.data.claimId, codeIn(mails[mails.length - 1]));
      eq(v.status, 200, "ac5: the right code → owner");
      const a = agentRow("p2-self");
      eq([a.is_vetted, a.is_verified, a.claimed_via], [0, 0, "claim"], "ac5: is_vetted stays 0, no badge, owner stamped");
      ok(!!a.claimed_at, "ac5: claimed_at stamped");

      agent("p2-disc", { noKnowledge: true });
      const rd = await claim("p2-disc", { name: "D", email: "d@p2-disc.no" });
      const vd = await verify("p2-disc", rd.body?.data?.claimId, codeIn(mails[mails.length - 1]));
      eq([rd.status, vd.status, agentRow("p2-disc").is_verified, agentRow("p2-disc").is_vetted], [200, 200, 0, 1],
        "ac5: a discovery profile owned via P2 gets no badge either (the domain is not tied to the farm)");
    }

    // ══ (ac6) flag off → old behaviour ══════════════════════════════════
    {
      for (const v of ["", "0", "false", "yes", "on"]) {
        eq(rule.claimDomainRuleEnabled({ CLAIM_DOMAIN_RULE_ENABLED: v } as any), false, `ac6: flag value '${v}' is off`);
      }
      for (const v of ["1", "true", "TRUE", " true "]) {
        eq(rule.claimDomainRuleEnabled({ CLAIM_DOMAIN_RULE_ENABLED: v } as any), true, `ac6: flag value '${v}' is on`);
      }
      eq(rule.claimDomainRuleEnabled({} as any), false, "ac6: unset is off");
      flagOff();
      agent("off-p1", { website: "https://off-p1.no" });
      agent("off-self", { origin: "self_registered", website: "https://off-self.no" });
      const m0 = mails.length;
      const p0 = probed.length;
      const r = await claim("off-p1", { name: "K", email: "k@off-p1.no" });
      eq(r.status, 202, "ac6: flag off, P1 case → 202 queue as before");
      eq(r.body?.data, { claimId: r.body?.data?.claimId, status: "pending_review", reason: "no_known_email" }, "ac6: … the response body has the old shape");
      eq(claimRow(r.body.data.claimId).recommendation, "domain_match_independent", "ac6: … the queue row carries the advice (additive)");
      const r2 = await claim("off-self", { name: "S", email: "s@off-self.no" });
      eq([r2.status, r2.body?.data?.reason, claimRow(r2.body.data.claimId).recommendation], [202, "no_known_email", "needs_review"],
        "ac6: flag off, P2 case → queue, needs_review");
      eq([mails.length, probed.length], [m0, p0], "ac6: no mail and no HTTPS probe with the flag off");
      flagOn();
    }

    // ══ (ac7) probe false / throws / not true → queue ═══════════════════
    {
      const answers: Array<[string, () => Promise<any>]> = [
        ["false", async () => false],
        ["throws", async () => { throw new Error("ECONNREFUSED (test)"); }],
        ["truthy non-true", async () => "yes"],
      ];
      let i = 0;
      for (const [why, fn] of answers) {
        probeAnswer = fn;
        const id = agent(`hx-${i}`, { origin: "self_registered" });
        const m0 = mails.length;
        const r = await claim(id, { name: "H", email: `h@hx-${i++}.no` });
        eq([r.status, r.body?.data?.reason, claimRow(r.body.data.claimId)?.recommendation, mails.length - m0], [202, "no_known_email", "needs_review", 0],
          `ac7: probe ${why} → queue needs_review, no mail`);
      }
      probeAnswer = async () => true;
      // The probe is skipped when the profile could not get a code anyway.
      agent("hx-rl", { origin: "self_registered" });
      const first = await claim("hx-rl", { name: "A", email: "a@hx-rl.no" });
      const p0 = probed.length;
      const second = await claim("hx-rl", { name: "B", email: "b@hx-rl.no" });
      eq([first.status, second.status, probed.length - p0], [200, 202, 0], "ac7: inside the 24 h window no probe is made (falls to the queue)");
      // Ownership changes between probe and transaction: requestClaim re-checks.
      agent("hx-race", { origin: "self_registered" });
      probeAnswer = async () => { db.prepare("UPDATE agents SET claimed_at = ? WHERE id = 'hx-race'").run(new Date().toISOString()); return true; };
      const race = await claim("hx-race", { name: "R", email: "r@hx-race.no" });
      eq([race.status, race.body?.data?.reason], [202, "has_owner"], "ac7: an owner appearing during the probe → queue has_owner");
      probeAnswer = async () => true;
    }

    // ══ (ac8) normalization and the probe's guards ═════════════════════
    {
      eq(rule.emailDomain("Kari@GARD.NO."), "gard.no", "ac8: upper case and a trailing dot are normalized");
      eq(rule.emailDomain("a@www.Gard.no"), "www.gard.no", "ac8: domain kept as host (www stripped only when comparing)");
      eq(rule.websiteHost("HTTPS://WWW.Gard.no:443/om?x=1"), "www.gard.no", "ac8: website host from a full URL");
      eq(rule.websiteHost("gard.no/kontakt"), "gard.no", "ac8: website without scheme");
      eq(rule.websiteHost("ftp://gard.no"), null, "ac8: only http(s) websites");
      eq(rule.emailDomainMatchesWebsite("post.gard.no", "www.gard.no"), true, "ac8: post.gard.no ↔ www.gard.no match on gard.no");
      eq(rule.emailDomainMatchesWebsite("gard.no", "shop.gard.no"), true, "ac8: parent domain matches a subdomain site");
      eq(rule.emailDomainMatchesWebsite("www.gard.no", "gard.no"), true, "ac8: www. on either side");
      eq(rule.emailDomainMatchesWebsite("a.gard.no", "b.gard.no"), false, "ac8: sibling subdomains do not match (conservative)");
      eq(rule.emailDomainMatchesWebsite("gard.no", "gard2.no"), false, "ac8: a different domain does not match");
      eq(rule.emailDomainMatchesWebsite("evilgard.no", "gard.no"), false, "ac8: a suffix that is not a label boundary does not match");
      eq(rule.emailDomainMatchesWebsite("a.oslo.no", "b.oslo.no"), false, "ac8: two farms under a geographic suffix do not match");
      eq(rule.emailDomainMatchesWebsite("co.uk", "gard.co.uk"), false, "ac8: a bare public suffix never matches");
      eq(rule.emailDomainMatchesWebsite("post.gard.co.uk", "www.gard.co.uk"), true, "ac8: .co.uk registrable domain");
      eq(rule.emailDomainMatchesWebsite("priv.no", "ola.priv.no"), false, "ac8: priv.no is a suffix, not a farm");
      eq(rule.registrableDomain("post.gard.co.uk"), "gard.co.uk", "ac8: registrableDomain under co.uk");
      eq(rule.registrableDomain("post.gard.no"), "gard.no", "ac8: registrableDomain under .no");
      for (const bad of ["a@1.2.3.4", "a@[1.2.3.4]", "a@[::1]", "a@127.0.0.1", "a@gard.no:8080", "a@localhost", "a@gard", "a@-gard.no", "a@gard..no", "a@0x7f.1"]) {
        eq(rule.emailDomain(bad), null, `ac8: e-mail domain refused: ${bad}`);
      }
      agent("ip", { website: "http://10.0.0.5/" });
      const m0 = mails.length;
      const p0 = probed.length;
      const rip = await claim("ip", { name: "I", email: "i@10.0.0.5" });
      eq([rip.status, claimRow(rip.body.data.claimId)?.recommendation, mails.length - m0, probed.length - p0], [202, "free_mail_needs_extra", 0, 0],
        "ac8: an IP-literal e-mail domain → queue (invalid → free_mail_needs_extra), no probe");
      for (const d of ["localhost", "gard.local", "x.internal", "gard.test", "example", "gard.no.", "GARD.NO", "1.2.3.4", "co.uk", "home.arpa"]) {
        eq(rule.isProbeableDomain(d), false, `ac8: never probed: ${d}`);
      }
      eq(rule.isProbeableDomain("gard.no"), true, "ac8: a public name is probeable");
      for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
        eq(rule.isPublicIp(ip), false, `ac8: not a public address: ${ip}`);
      }
      eq([rule.isPublicIp("195.88.54.16"), rule.isPublicIp("2a02:c7f::1")], [true, true], "ac8: public v4/v6 addresses pass");
      // The default probe refuses unsafe names before any network call.
      for (const d of ["localhost", "127.0.0.1", "gard.internal", "gard.test"]) {
        eq(await rule.defaultDomainAnswersHttps(d), false, `ac8: default probe answers false for ${d} without a request`);
      }
      eq(rule.isFreeMailDomain("mail.online.no"), true, "ac8: a subdomain of a free-mail domain is free-mail");
    }

    // ══ (q) the queue and the admin notice show the rule ════════════════
    {
      const q = await invoke(queueH, makeReq({ headers: admin }));
      const recs = new Set((q.body?.entries ?? []).map((e: any) => e.recommendation));
      ok(["free_mail_needs_extra", "has_owner", "needs_review", "domain_match_independent"].every((r) => recs.has(r)),
        "q: GET /admin/agents/claim-review-queue exposes recommendation per entry");
      ok((q.body?.entries ?? []).every((e: any) => "recommendation" in e), "q: every entry has the field");

      process.env.ADMIN_NOTIFICATION_EMAIL = "admin@plattform.example.test";
      try {
        agent("notice", {});
        await claim("notice", { name: "Kari", email: "kari@gmail.com" });
        await new Promise<void>((r) => setTimeout(r, 20));
        const notice = mails.filter((m) => m.to === "admin@plattform.example.test").pop();
        ok(!!notice && notice.subject === "Eierkrav venter på godkjenning: Gård notice", "q: the admin notice is sent");
        ok(!!notice && notice.text.includes("Anbefaling: free_mail_needs_extra") && notice.text.includes("Krever ekstra bekreftelse"),
          "q: … showing the rule and what Daniel can do");
        ok(!!notice && notice.text.includes("Grunn: profilen har ingen kjent e-postadresse"), "q: … the reason line is unchanged");
      } finally {
        delete process.env.ADMIN_NOTIFICATION_EMAIL;
      }
    }

    // ══ (mig) the column is added to an older table, idempotently ══════
    {
      const old = new Database(":memory:");
      initMod.__initSchemaForTesting(old);
      old.pragma("foreign_keys = OFF");
      old.exec("ALTER TABLE agent_claims DROP COLUMN recommendation");
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason) VALUES ('o1', 'x', 'n', 'e@x.no', 'pending_review', 'no_known_email')").run();
      initMod.__initSchemaForTesting(old);
      initMod.__initSchemaForTesting(old);
      const cols = (old.prepare("PRAGMA table_info(agent_claims)").all() as Array<{ name: string }>).map((c) => c.name);
      eq(cols.filter((c) => c === "recommendation").length, 1, "mig: recommendation added once (idempotent)");
      eq(old.prepare("SELECT status, review_reason, recommendation FROM agent_claims WHERE id = 'o1'").get(),
        { status: "pending_review", review_reason: "no_known_email", recommendation: null }, "mig: existing rows keep their values, recommendation NULL");
      old.close();
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-domeneregel: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
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
  runRfbClaimDomeneregelTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-domeneregel: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
