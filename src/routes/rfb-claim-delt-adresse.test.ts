/**
 * rfb-claim-delt-adresse.test.ts — claim rule slice 1b, shared address
 * ("delt adresse").
 *
 * Before a claim code is sent on any path — rule 1 (the farm's known e-mail,
 * flag off or on) and the domain rule's P1/P2 (CLAIM_DOMAIN_RULE_ENABLED on)
 * — the address the code would go to must not be the known e-mail
 * (resolveFarmContactEmail) of MORE THAN ONE RFB profile. On a hit: no code,
 * no mail; the claim waits in the admin queue as pending_review with
 * review_reason 'shared_address' and recommendation 'shared_address', and the
 * admin notice shows the reason.
 *   (r1)  flag off, rule 1: shared listed address → queue; also when the
 *         claimant typed that address; normalization; outreach-known address;
 *   (one) the address on exactly one profile → code as before; bounced or
 *         superseded outreach, other verticals → not "known", code as before;
 *   (p1/p2) flag on: P1 and P2 to a shared address → queue; unshared → code;
 *   (own) existing owners: has_owner and already_owner unchanged, e-mail login
 *         unchanged;
 *   (q)   the admin notice and queue show the reason and recommendation.
 *
 * Same harness as rfb-claim-domeneregel.test.ts: the real handlers off the
 * routers' stacks, fake req/res, an in-memory DB, a stub mail transporter and
 * a stub HTTPS probe — no network.
 *
 * Exported runRfbClaimDeltAdresseTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-delt-adresse.test.ts
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

export async function runRfbClaimDeltAdresseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  process.env.CLAIM_CODE_SENDS_PER_HOUR_MAX = "100";
  process.env.CLAIM_REVIEW_INSERTS_PER_HOUR_MAX = "200";
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-delt-adresse-standalone-key";
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
  const probed: string[] = [];
  rule.__setDomainHttpsCheckForTesting(async (d: string) => { probed.push(d); return true; });

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

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const verifyH = handlerOf(marketplaceRouter, "/agents/:id/claim/verify", "post");
    const queueH = handlerOf(adminAgentsRouter, "/claim-review-queue", "get");
    const admin = { "x-admin-key": ADMIN };

    // ── fixtures ────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at, claimed_via, origin, is_vetted)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?)`,
    );
    interface AgentOpts { origin?: string; claimedAt?: string | null; listed?: string | null; website?: string | null; vertical?: string }
    function agent(id: string, o: AgentOpts = {}): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`,
        o.claimedAt ?? null, o.claimedAt ? "admin" : null, o.origin ?? "discovery", o.origin === "self_registered" ? 0 : 1);
      if (o.vertical) db.prepare("UPDATE agents SET vertical_id = ? WHERE id = ?").run(o.vertical, id);
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, data_source, curated_fields, field_provenance)
                  VALUES (?, ?, ?, 'auto', '{}', '{}')`).run(id, o.listed ?? null, o.website ?? null);
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const outreach = (agentId: string, to: string, vertical = "rfb") =>
      db.prepare("INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id) VALUES (?, ?, ?, 'email', ?)")
        .run(agentId, to, "2026-09-05 10:00:00", vertical);
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const claimsOf = (agentId: string): any[] => db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? ORDER BY created_at, id").all(agentId) as any[];
    const claim = (agentId: string, body: Record<string, unknown>) => invoke(claimH, makeReq({ params: { id: agentId }, body }));
    const verify = (agentId: string, claimId: string, code: unknown) => invoke(verifyH, makeReq({ params: { id: agentId }, body: { claimId, code } }));
    const sharedQueued = (r: HandlerResult, label: string) => {
      eq([r.status, r.body?.data?.status, r.body?.data?.reason], [202, "pending_review", "shared_address"], `${label}: 202 pending_review, reason shared_address`);
      const row = r.body?.data?.claimId ? claimRow(r.body.data.claimId) : undefined;
      eq([row?.status, row?.review_reason, row?.recommendation, row?.code_sent_to ?? null, row?.verification_code ?? null],
        ["pending_review", "shared_address", "shared_address", null, null], `${label}: claim row pending_review / shared_address / shared_address, no code`);
    };

    // ══ (r1) flag off, rule 1 ══════════════════════════════════════════════
    flagOff();
    {
      agent("sa-1", { listed: "post@delt.example.test" });
      agent("sa-2", { listed: " Post@DELT.example.test " });
      eq(knowledgeService.isSharedKnownEmail("POST@delt.example.test"), true, "r1: the listed address of two RFB profiles is shared (normalized)");
      const m0 = mails.length;
      const r = await claim("sa-1", { name: "Kari", email: "kari@annen.example.test" });
      sharedQueued(r, "r1: claim on a profile whose known address is on 2 profiles");
      ok(String(r.body?.message ?? "").includes("flere gårder"), "r1: the claimant is told why (address on several farms)");
      eq(mails.length, m0, "r1: no mail, no code");
      // The claimant typed the shared address themselves.
      const rt = await claim("sa-2", { name: "Ola", email: "post@delt.example.test" });
      sharedQueued(rt, "r1: the claimant typed the shared address themselves");
      eq(mails.length, m0, "r1: … still no mail");
      // A repeat by the same claimant returns the same open entry.
      const rr = await claim("sa-1", { name: "Kari", email: "kari@annen.example.test" });
      eq([rr.status, rr.body?.data?.claimId], [202, r.body?.data?.claimId], "r1: a repeat returns the same open entry");
      eq(claimsOf("sa-1").length, 1, "r1: … and writes no new row");
      // Known via delivered RFB outreach (no listed address on that profile).
      agent("sa-o1", {});
      outreach("sa-o1", "felles@outreach.example.test");
      agent("sa-o2", { listed: "felles@outreach.example.test" });
      eq(knowledgeService.resolveFarmContactEmail("sa-o1"), "felles@outreach.example.test", "r1: precondition: outreach address is sa-o1's known e-mail");
      sharedQueued(await claim("sa-o2", { name: "X", email: "x@x.example.test" }), "r1: listed on one profile + outreach-known on another");
      sharedQueued(await claim("sa-o1", { name: "X", email: "x@x.example.test" }), "r1: the outreach-known profile itself");
      eq(mails.length, m0, "r1: no mail for any shared address");
      // Three profiles.
      for (const id of ["sa-t1", "sa-t2", "sa-t3"]) agent(id, { listed: "tre@delt.example.test" });
      sharedQueued(await claim("sa-t3", { name: "X", email: "x@x.example.test" }), "r1: address on 3 profiles");
      // The second profile stores the address with a tab / no-break space:
      // SQLite's plain TRIM() would miss it, resolveFarmContactEmail does not.
      agent("sa-w1", { listed: "ws@delt.example.test" });
      agent("sa-w2", { listed: "\tws@delt.example.test \n" });
      eq(knowledgeService.resolveFarmContactEmail("sa-w2"), "ws@delt.example.test", "r1: precondition: the padded address resolves to the plain one");
      sharedQueued(await claim("sa-w1", { name: "X", email: "x@x.example.test" }), "r1: shared address stored with tab/no-break space on the other profile");
      // More stale outreach rows than the candidate cap must not crowd out the
      // claimed profile and the one real second holder.
      for (let i = 0; i < 30; i++) {
        agent(`sa-s${i}`, { listed: `egen${i}@stale.example.test` });
        outreach(`sa-s${i}`, "paraply@stale.example.test");
      }
      agent("sa-c1", { listed: "paraply@stale.example.test" });
      agent("sa-c2", {});
      outreach("sa-c2", "paraply@stale.example.test");
      eq(knowledgeService.resolveFarmContactEmail("sa-c2"), "paraply@stale.example.test", "r1: precondition: sa-c2 knows the address via outreach");
      sharedQueued(await claim("sa-c2", { name: "X", email: "x@x.example.test" }), "r1: 30 stale outreach rows do not hide the shared address");
      eq(mails.length, m0, "r1: … no mail for these either");
    }

    // ══ (one) exactly one profile → unchanged ═════════════════════════════
    {
      agent("one-1", { listed: "post@en.example.test" });
      eq(knowledgeService.isSharedKnownEmail("post@en.example.test"), false, "one: an address on one profile is not shared");
      const m0 = mails.length;
      const r = await claim("one-1", { name: "Kari", email: "kari@annen.example.test" });
      eq([r.status, r.body?.data?.status], [200, "code_sent"], "one: 200 code_sent as before");
      eq([mails.length - m0, mails[mails.length - 1]?.to], [1, "post@en.example.test"], "one: one mail, to the farm's known address");
      const row = claimRow(r.body.data.claimId);
      eq([row.status, row.code_sent_to, row.review_reason, row.recommendation], ["code_sent", "post@en.example.test", null, null], "one: claim row unchanged (no reason/recommendation)");
      const v = await verify("one-1", r.body.data.claimId, codeIn(mails[mails.length - 1]));
      eq(v.status, 200, "one: the right code still gives ownership");
      eq(knowledgeService.createMagicLink("kari@annen.example.test").success, false, "one: the typed address still cannot log in (rule 1 unchanged)");

      // Not "known": a bounced outreach address, an outreach address on a
      // profile that lists another address, other verticals.
      agent("nk-b1", {});
      outreach("nk-b1", "bounced@nk.example.test");
      db.prepare("INSERT INTO email_bounces (email, bounced_at) VALUES (?, ?)").run("bounced@nk.example.test", "2026-09-05 11:00:00");
      agent("nk-b2", { listed: "bounced@nk.example.test" });
      eq(knowledgeService.isSharedKnownEmail("bounced@nk.example.test"), false, "one: a bounced outreach address is not a known e-mail");
      agent("nk-l1", { listed: "egen@nk.example.test" });
      outreach("nk-l1", "annen@nk.example.test");
      agent("nk-l2", { listed: "annen@nk.example.test" });
      eq(knowledgeService.isSharedKnownEmail("annen@nk.example.test"), false, "one: outreach to a profile that lists another address does not count");
      agent("nk-d1", { listed: "vert@nk.example.test", vertical: "dental" });
      agent("nk-x1", { listed: "vert@nk.example.test", vertical: "experiences" });
      agent("nk-r1", { listed: "vert@nk.example.test" });
      eq(knowledgeService.isSharedKnownEmail("vert@nk.example.test"), false, "one: dental/experiences rows do not count (RFB only)");
      agent("nk-o1", {});
      outreach("nk-o1", "dentalout@nk.example.test", "dental");
      agent("nk-o2", { listed: "dentalout@nk.example.test" });
      eq(knowledgeService.isSharedKnownEmail("dentalout@nk.example.test"), false, "one: non-RFB outreach does not count");
      const m1 = mails.length;
      const rv = await claim("nk-r1", { name: "X", email: "x@x.example.test" });
      eq([rv.status, mails.length - m1, mails[mails.length - 1]?.to], [200, 1, "vert@nk.example.test"], "one: … so the RFB profile gets its code as before");
    }

    // ══ (p1/p2) flag on ═══════════════════════════════════════════════════
    flagOn();
    {
      // Rule 1 with the flag on.
      agent("on-1", { listed: "post@delt-on.example.test" });
      agent("on-2", { listed: "post@delt-on.example.test" });
      const m0 = mails.length;
      sharedQueued(await claim("on-1", { name: "X", email: "x@x.example.test" }), "on: rule 1 with the flag on, shared address");

      // P1: independent website, claimant at that domain; the address is
      // the listed e-mail of two other profiles.
      agent("p1-s", { website: "https://www.gardp1s.no/" });
      agent("p1-s-a", { listed: "kari@gardp1s.no" });
      agent("p1-s-b", { listed: "kari@gardp1s.no" });
      eq(knowledgeService.assessClaimDomain("p1-s", "kari@gardp1s.no").route, "p1", "p1: precondition: P1 applies");
      sharedQueued(await claim("p1-s", { name: "Kari", email: "Kari@GardP1s.no" }), "p1: P1 to a shared address");
      eq(mails.length, m0, "p1: no mail");

      // P1 unshared (the address on exactly one other profile) → code as before.
      agent("p1-u", { website: "https://www.gardp1u.no/" });
      agent("p1-u-a", { listed: "kari@gardp1u.no" });
      const r1 = await claim("p1-u", { name: "Kari", email: "kari@gardp1u.no" });
      eq([r1.status, mails[mails.length - 1]?.to, claimRow(r1.body.data.claimId).recommendation], [200, "kari@gardp1u.no", "domain_match_independent"],
        "p1: address on exactly one profile → P1 code as before");

      // P2: self-registered, HTTPS answers; the address is shared.
      agent("p2-s", { origin: "self_registered" });
      agent("p2-s-a", { listed: "ola@gardp2s.no" });
      agent("p2-s-b", {});
      outreach("p2-s-b", "ola@gardp2s.no");
      const m2 = mails.length;
      sharedQueued(await claim("p2-s", { name: "Ola", email: "ola@gardp2s.no" }), "p2: P2 to a shared address");
      eq(mails.length, m2, "p2: no mail");

      // P2 unshared → code as before.
      agent("p2-u", { origin: "self_registered" });
      const r2 = await claim("p2-u", { name: "Ola", email: "ola@gardp2u.no" });
      eq([r2.status, mails[mails.length - 1]?.to, claimRow(r2.body.data.claimId).recommendation], [200, "ola@gardp2u.no", "domain_code_sent"],
        "p2: unshared → P2 code as before");
    }
    flagOff();

    // ══ (own) existing owners and e-mail login unchanged ══════════════════
    {
      // An owner whose address is on a second profile.
      agent("own-1", { listed: "eier@own.example.test" });
      const r = await claim("own-1", { name: "Eier", email: "eier@own.example.test" });
      eq(r.status, 200, "own: precondition: code while the address is on one profile");
      const v = await verify("own-1", r.body.data.claimId, codeIn(mails[mails.length - 1]));
      eq(v.status, 200, "own: precondition: owner by code");
      agent("own-2", { listed: "eier@own.example.test" });
      eq(knowledgeService.isSharedKnownEmail("eier@own.example.test"), true, "own: the owner's address is now shared");
      const again = await claim("own-1", { name: "Eier", email: "eier@own.example.test" });
      eq(again.status, 400, "own: the owner's own address → already_owner (log in by e-mail), unchanged");
      eq(knowledgeService.createMagicLink("eier@own.example.test").agentId, "own-1", "own: e-mail login unchanged");
      const other = await claim("own-1", { name: "Annen", email: "annen@own.example.test" });
      eq([other.status, other.body?.data?.reason, claimRow(other.body.data.claimId).recommendation], [202, "has_owner", "has_owner"],
        "own: another claimant on an owned profile → has_owner, as before");
    }

    // ══ (q) admin notice and queue ════════════════════════════════════════
    {
      process.env.ADMIN_NOTIFICATION_EMAIL = "admin@plattform.example.test";
      try {
        agent("q-1", { listed: "post@q.example.test" });
        agent("q-2", { listed: "post@q.example.test" });
        const r = await claim("q-1", { name: "Kari", email: "kari@q-annen.example.test" });
        await new Promise<void>((res) => setTimeout(res, 20));
        const notice = mails.filter((m) => m.to === "admin@plattform.example.test").pop();
        ok(!!notice && notice.subject === "Eierkrav venter på godkjenning: Gård q-1", "q: the admin notice is sent");
        ok(!!notice && notice.text.includes("Grunn: delt adresse"), "q: … with the reason «delt adresse»");
        ok(!!notice && notice.text.includes("Anbefaling: shared_address"), "q: … and the recommendation shared_address");
        eq(mails.filter((m) => m.to === "post@q.example.test").length, 0, "q: nothing to the shared address");
        const q = await invoke(queueH, makeReq({ headers: admin }));
        const e = (q.body?.entries ?? []).find((x: any) => x.claim_id === r.body?.data?.claimId);
        eq([e?.reason, e?.recommendation], ["shared_address", "shared_address"], "q: the queue shows reason and recommendation");
      } finally {
        delete process.env.ADMIN_NOTIFICATION_EMAIL;
      }
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-delt-adresse: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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
  runRfbClaimDeltAdresseTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-delt-adresse: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
