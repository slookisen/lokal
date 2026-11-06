/**
 * rfb-claim-farm-notice-b2b2.test.ts — dev-request 2026-10-30-rfb-eierkrav-
 * automatisk-vurdering-og-ettklikk, SLICE B2b-2: after a green claim was
 * approved automatically (B2b-1), the farm's KNOWN address (as it was before
 * the approval) gets «Ny eier registrert for <profil>» — and the admin notice
 * says whether it went out.
 *
 *   B2b-2.1  auto-approved, known address ≠ claimant and not shared: exactly
 *            one notice to the known address, no claimant name/e-mail in the
 *            subject or body, no links, Reply-To = support address, profile
 *            name HTML-escaped; the admin notice says «sendt» and does not
 *            show the farm address
 *   B2b-2.2  no known address / the claimant's own (case + spaces) / a shared
 *            address: no notice, the admin notice says «ikke sendt (<grunn>)»
 *   B2b-2.3  a send failure or a throw: the claim stays approved, the login
 *            mail and the admin notice go out; «ikke sendt (sendefeil)»
 *   B2b-2.4  CLAIM_CRM_TRACKING_ENABLED on → one farm_notice row in
 *            claim-<claimId> (no outreach_sent_log row left); off → no row.
 *            Not green / a flag off → no notice.
 *
 * Same harness as the B2b-1 suite: the assessment runs with stub network deps
 * behind a gate, and a test-only trigger can replace the stored value.
 *
 * Exported runRfbClaimFarmNoticeB2b2Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-farm-notice-b2b2.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string;
}

export async function runRfbClaimFarmNoticeB2b2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["ADMIN_NOTIFICATION_EMAIL", "CLAIM_ACTION_LINK_SECRET", "CLAIM_ACTION_LINKS_ENABLED",
    "CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_AUTO_APPROVE_ENABLED", "CLAIM_CRM_TRACKING_ENABLED",
    "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.CLAIM_CODE_SENDS_PER_HOUR_MAX = "100";
  process.env.CLAIM_REVIEW_INSERTS_PER_HOUR_MAX = "500";
  const ADMIN_TO = "admin@plattform.example.test";
  const WAIT_MS = 300;

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const origSendFarmNotice = emailSvc.sendClaimFarmNotice;
  const mails: SentMail[] = [];
  let failTo: string | null = null;
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      if (failTo && String(m.to) === failTo) throw new Error("smtp 554 rejected");
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? ""), replyTo: String(m.replyTo ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const adminMails = () => mails.filter((m) => m.to === ADMIN_TO);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // ── assessment deps: stub network (green for an own-domain claimant) ───
  const ca = require("../services/claim-assessment") as typeof import("../services/claim-assessment");
  let gate: Promise<void> = Promise.resolve();
  let openGate: () => void = () => {};
  const closeGate = () => { gate = new Promise<void>((r) => { openGate = r; }); };
  ca.__setClaimAssessmentDepsForTesting({
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    timeoutMs: 10_000,
    fetchApi: async (url: string) => {
      await gate;
      if (url.startsWith("https://data.brreg.no/")) {
        return { status: 200, body: JSON.stringify({ rollegrupper: [{ roller: [
          { type: { kode: "DAGL" }, person: { navn: { fornavn: "Kari", etternavn: "Nordmann" } } },
        ] }] }) };
      }
      return { status: 200, body: JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2024-04-01T00:00:00Z" }] }) };
    },
    fetchSite: async () => { await gate; return { status: 200, body: "<html>Velkommen</html>" }; },
    resolveMx: async (d: string) => { await gate; return [{ exchange: `mx.${d}`, priority: 10 }]; },
  });
  ca.__resetClaimIpWindowForTesting();
  ca.__setClaimNoticeWaitMsForTesting(WAIT_MS);

  // ── handler harness ─────────────────────────────────────────────────────
  const handlerOf = (router: any, path: string, method: "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  let ipSeq = 0;
  function makeReq(o: { params?: Record<string, string>; body?: any }): any {
    ipSeq++;
    return {
      params: o.params || {}, body: o.body, query: {}, headers: {}, ip: `203.0.${100 + Math.floor(ipSeq / 200)}.${ipSeq % 200}`,
      lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
    };
  }
  function invoke(handler: Function, req: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, () => settle({ __next: true }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
  const origIsShared = knowledgeService.isSharedKnownEmail;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    db.exec(`CREATE TABLE b2b2_craft (v TEXT);
      CREATE TRIGGER b2b2_craft_after AFTER UPDATE OF claim_assessment ON agent_claims
        WHEN (SELECT COUNT(*) FROM b2b2_craft) > 0
      BEGIN
        UPDATE agent_claims SET claim_assessment = (SELECT v FROM b2b2_craft LIMIT 1) WHERE id = NEW.id;
      END;`);
    const craft = (v: string | null | undefined) => {
      db.exec("DELETE FROM b2b2_craft");
      if (v !== undefined) db.prepare("INSERT INTO b2b2_craft (v) VALUES (?)").run(v);
    };

    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const es = require("../services/email-service") as typeof import("../services/email-service");
    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");

    // A profile with an own website and no known e-mail → a claim is queued
    // (no_known_email). The known address is given to the profile while the
    // assessment runs, i.e. before the auto decision reads it.
    let seq = 0;
    function agent(id: string, name = `Gård ${id}`): string {
      seq++;
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, is_vetted, org_nr)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery', 1, ?)`)
        .run(id, name, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`, String(920000000 + seq));
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, phone, data_source, curated_fields, field_provenance)
                  VALUES (?, NULL, ?, NULL, 'auto', '{}', '{}')`).run(id, `https://www.gard-${id}.no/`);
      (marketplaceRegistry as any)._agentsCache = null;
      return id;
    }
    const setKnown = (agentId: string, email: string | null) =>
      db.prepare("UPDATE agent_knowledge SET email = ? WHERE agent_id = ?").run(email, agentId);
    const claimantOf = (agentId: string) => `kari@gard-${agentId}.no`;
    const claimRow = (id: string): any => db.prepare("SELECT status, verification_method FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT claimed_via FROM agents WHERE id = ?").get(id);
    const mailsTo = (to: string) => mails.filter((m) => m.to === to);
    const isFarmNotice = (m: SentMail) => m.subject.startsWith("Ny eier registrert for ");
    const farmRows = (claimId: string) => db.prepare(
      "SELECT id, to_emails, subject, body_text, delivery_status FROM crm_messages WHERE thread_id = ? AND direction = 'out' AND raw_metadata LIKE '%\"kind\":\"farm_notice\"%'"
    ).all(`claim-${claimId}`) as Array<{ id: string; to_emails: string; subject: string; body_text: string; delivery_status: string }>;
    const settle = async () => { await ca.__waitForClaimAssessmentsForTesting(); await sleep(40); };
    const isAutoNotice = (m: SentMail) => m.subject.startsWith("Eierkrav godkjent automatisk");
    const isQueuedNotice = (m: SentMail) => m.subject.startsWith("Eierkrav venter på godkjenning");
    const FARM_LINE = "Varsel til gårdens kjente adresse";

    const GREEN = {
      result: "green", anchors: ["A1"], supports: ["S1"], red_flags: [], unavailable_sources: [],
      possible_duplicate: false, signals: [], rule_version: "A1", org_nr: null,
    };

    /** Files a claim, sets the profile's known address while the assessment
     *  runs, lets it settle; returns what was sent for it. */
    async function run(id: string, known: string | null, o: { stored?: unknown; claimant?: string } = {}) {
      craft(o.stored === undefined ? JSON.stringify(GREEN) : (o.stored === null ? null : JSON.stringify(o.stored)));
      closeGate();
      const claimant = o.claimant ?? claimantOf(id);
      const n0 = mails.length;
      const r = await invoke(claimH, makeReq({ params: { id }, body: { name: "Kari Nordmann", email: claimant } }));
      const claimId = r.body?.data?.claimId as string;
      await sleep(20);
      setKnown(id, known);
      openGate();
      await settle();
      return { r, claimId, sent: mails.slice(n0), claimant };
    }

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;
    process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = "true";
    process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";

    // ══ unit: the admin line ══════════════════════════════════════════════
    {
      eq([
        es.claimFarmNoticeLabel({ sent: true }),
        es.claimFarmNoticeLabel({ sent: false, reason: "no_known_email" }),
        es.claimFarmNoticeLabel({ sent: false, reason: "same_as_claimant" }),
        es.claimFarmNoticeLabel({ sent: false, reason: "shared_address" }),
        es.claimFarmNoticeLabel({ sent: false, reason: "send_failed" }),
      ], ["sendt", "ikke sendt (ingen kjent adresse)", "ikke sendt (samme som innsender)", "ikke sendt (delt adresse)", "ikke sendt (sendefeil)"],
      "unit: «sendt» / «ikke sendt (<grunn>)» labels");
    }

    // ══ B2b-2.1 + B2b-2.4 (CRM on): one notice, no claimant data ══════════
    {
      const id = agent("b21", `Gård <b>"Ål"</b> & co`);
      const known = `post@gard-${id}.example.no`;
      const { claimId, sent, claimant } = await run(id, known);
      eq([claimRow(claimId).status, agentRow(id).claimed_via], ["verified", "auto_assessment"], "B2b-2.1: the claim is auto-approved");
      const toFarm = sent.filter((m) => m.to === known);
      eq(toFarm.length, 1, "B2b-2.1: exactly one mail to the known address");
      const m = toFarm[0]!;
      ok(isFarmNotice(m), "B2b-2.1: it is «Ny eier registrert for …»");
      eq(m.subject, `Ny eier registrert for Gård <b>"Ål"</b> & co på Rett fra Bonden`, "B2b-2.1: subject names the profile and the platform");
      ok(m.text.startsWith(`Ny eier registrert for Gård <b>"Ål"</b> & co på Rett fra Bonden.`) && m.text.includes("Var det ikke dere? Svar på denne e-posten."),
        "B2b-2.1: the text has the notice and the reply ask");
      ok(m.text.includes("6. november 2026") || /\d{1,2}\. \S+ \d{4}/.test(m.text), "B2b-2.1: the text has the date");
      ok(m.html.includes("Gård &lt;b&gt;&quot;Ål&quot;&lt;/b&gt; &amp; co") && !m.html.includes("<b>\"Ål\"</b>") && !m.html.includes("<b>&quot;"),
        "B2b-2.1: the profile name is HTML-escaped");
      ok(m.html.includes("Var det ikke dere? Svar på denne e-posten."), "B2b-2.1: the HTML has the reply ask");
      const all = `${m.subject}\n${m.text}\n${m.html}`.toLowerCase();
      ok(!all.includes("kari") && !all.includes("nordmann") && !all.includes(claimant.toLowerCase()) && !all.includes(`gard-${id}.no`),
        "B2b-2.1: no claimant name or e-mail in the subject or body");
      ok(!all.includes("href") && !all.includes("http") && !all.includes("magic") && !all.includes("/eier"), "B2b-2.1: no links (no login, no action)");
      eq(m.replyTo, "kontakt@rettfrabonden.com", "B2b-2.1: Reply-To is the platform's support address");
      eq(mailsTo(claimant).map((x) => x.subject), [`Profilen til Gård <b>"Ål"</b> & co er nå din på Rett fra Bonden`], "B2b-2.1: the claimant still gets the login mail, once");
      const notices = sent.filter((x) => x.to === ADMIN_TO);
      eq(notices.map(isAutoNotice), [true], "B2b-2.1: one admin notice, «godkjent automatisk»");
      const a = notices[0]!;
      ok(a.text.includes(`Innlogging: sendt\n${FARM_LINE}: sendt\nKrav-id:`), "B2b-2.1: the admin text says «Varsel til gårdens kjente adresse: sendt»");
      ok(a.html.includes(`>${FARM_LINE}:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">sendt</td>`), "B2b-2.1: the admin HTML has the line");
      ok(!a.text.includes(known) && !a.html.includes(known), "B2b-2.1: the admin notice does not show the farm address");

      // B2b-2.4 (CRM on)
      const rows = farmRows(claimId);
      eq(rows.length, 1, "B2b-2.4 (CRM on): one farm_notice row in claim-<claimId>");
      eq([JSON.parse(rows[0]?.to_emails ?? "[]"), rows[0]?.subject, rows[0]?.delivery_status], [[known], m.subject, "sent"],
        "B2b-2.4 (CRM on): the row is the sent notice to the known address");
      eq(rows[0]?.body_text, m.text.trim(), "B2b-2.4 (CRM on): the row's body is the sent text");
      const osl = (db.prepare("SELECT COUNT(*) AS n FROM outreach_sent_log WHERE message_id = ?").get(rows[0]?.id ?? "") as { n: number }).n;
      eq(osl, 0, "B2b-2.4 (CRM on): no outreach_sent_log touch left for the notice");
      eq((db.prepare("SELECT COUNT(*) AS n FROM crm_messages WHERE thread_id = ? AND direction = 'out'").get(`claim-${claimId}`) as { n: number }).n, 2,
        "B2b-2.4 (CRM on): the thread has the login mail and the farm notice");
    }

    // ══ B2b-2.2: no known address / the claimant's own / shared ═══════════
    async function skipCase(label: string, reasonText: string, setup: (id: string) => { known: string | null; claimant?: string }) {
      const id = agent(`b22-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const s = setup(id);
      const { claimId, sent, claimant } = await run(id, s.known, { claimant: s.claimant });
      eq(claimRow(claimId).status, "verified", `B2b-2.2 (${label}): the claim is auto-approved`);
      ok(!sent.some(isFarmNotice), `B2b-2.2 (${label}): no farm notice`);
      eq(mailsTo(claimant).length, 1, `B2b-2.2 (${label}): the login mail goes out`);
      const notices = sent.filter((x) => x.to === ADMIN_TO);
      eq(notices.map(isAutoNotice), [true], `B2b-2.2 (${label}): one «godkjent automatisk» notice`);
      ok(notices[0]?.text.includes(`\n${FARM_LINE}: ikke sendt (${reasonText})\n`) ?? false, `B2b-2.2 (${label}): the admin text says «ikke sendt (${reasonText})»`);
      ok(notices[0]?.html.includes(`ikke sendt (${reasonText})</td>`) ?? false, `B2b-2.2 (${label}): the admin HTML says it too`);
      if (s.known) ok(!notices[0]!.text.includes(s.known.trim().toLowerCase()) || s.known.trim().toLowerCase() === claimant, `B2b-2.2 (${label}): the farm address is not shown`);
      eq(farmRows(claimId).length, 0, `B2b-2.2 (${label}): no farm_notice CRM row`);
    }
    await skipCase("no known address", "ingen kjent adresse", () => ({ known: null }));
    await skipCase("same as claimant", "samme som innsender", (id) => ({ known: claimantOf(id) }));
    await skipCase("same, case and spaces", "samme som innsender", (id) => ({ known: `  ${claimantOf(id).toUpperCase()}  ` }));
    await skipCase("shared address", "delt adresse", (id) => {
      const shared = `felles@samvirke-${id}.example.no`;
      const other = agent(`${id}-nabo`);
      setKnown(other, shared);
      return { known: shared };
    });
    {
      const shared = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id LIKE '%-nabo'").get() as { email: string }).email;
      eq(knowledgeService.isSharedKnownEmail(shared), true, "B2b-2.2 (shared address): the address is the known e-mail of two profiles");
    }

    // ══ B2b-2.3: a send failure or a throw ═════════════════════════════════
    async function failCase(label: string, arm: (known: string) => void, disarm: () => void) {
      const id = agent(`b23-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const known = `post@gard-${id}.example.no`;
      arm(known);
      let res: Awaited<ReturnType<typeof run>>;
      try {
        res = await run(id, known);
      } finally {
        disarm();
      }
      const { claimId, sent, claimant } = res;
      eq([claimRow(claimId).status, agentRow(id).claimed_via], ["verified", "auto_assessment"], `B2b-2.3 (${label}): the claim stays approved`);
      eq(mailsTo(claimant).length, 1, `B2b-2.3 (${label}): the login mail goes out`);
      ok(!sent.some((m) => m.to === known), `B2b-2.3 (${label}): nothing reached the known address`);
      const notices = sent.filter((x) => x.to === ADMIN_TO);
      eq(notices.map(isAutoNotice), [true], `B2b-2.3 (${label}): the admin notice goes out`);
      ok(notices[0]?.text.includes(`\n${FARM_LINE}: ikke sendt (sendefeil)\n`) ?? false, `B2b-2.3 (${label}): the admin notice says «ikke sendt (sendefeil)»`);
      return claimId;
    }
    {
      const claimId = await failCase("smtp rejects", (k) => { failTo = k; }, () => { failTo = null; });
      const rows = farmRows(claimId);
      eq(rows.map((r) => r.delivery_status), ["failed"], "B2b-2.3 (smtp rejects): the CRM row is filed as failed");
    }
    await failCase("send throws",
      () => { emailSvc.sendClaimFarmNotice = async () => { throw new Error("boom"); }; },
      () => { emailSvc.sendClaimFarmNotice = origSendFarmNotice; });
    await failCase("lookup throws",
      // Only the auto decision's own call (address + holder id) throws; the
      // assessment's one-argument call keeps working.
      () => {
        (knowledgeService as any).isSharedKnownEmail = function (this: unknown, address: string, holder?: string) {
          if (holder !== undefined) throw new Error("db gone");
          return origIsShared.call(knowledgeService, address);
        };
      },
      () => { (knowledgeService as any).isSharedKnownEmail = origIsShared; });

    // ══ B2b-2.4: CRM off → notice, no row; not green / flag off → nothing ═
    {
      delete process.env.CLAIM_CRM_TRACKING_ENABLED;
      const id = agent("b24-crm-off");
      const known = `post@gard-${id}.example.no`;
      const { claimId, sent } = await run(id, known);
      eq(sent.filter((m) => m.to === known).map(isFarmNotice), [true], "B2b-2.4 (CRM off): the notice is still sent");
      eq(farmRows(claimId).length, 0, "B2b-2.4 (CRM off): no farm_notice row");
      eq((db.prepare("SELECT COUNT(*) AS n FROM crm_threads WHERE id = ?").get(`claim-${claimId}`) as { n: number }).n, 0, "B2b-2.4 (CRM off): no CRM thread at all");
      process.env.CLAIM_CRM_TRACKING_ENABLED = "true";
    }
    async function noNoticeCase(label: string, o: { stored?: unknown; approveFlag?: string | undefined }) {
      if ("approveFlag" in o) {
        if (o.approveFlag === undefined) delete process.env.CLAIM_AUTO_APPROVE_ENABLED; else process.env.CLAIM_AUTO_APPROVE_ENABLED = o.approveFlag;
      }
      const id = agent(`b24-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const known = `post@gard-${id}.example.no`;
      const { claimId, sent, claimant } = await run(id, known, { stored: o.stored });
      process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
      eq(claimRow(claimId).status, "pending_review", `B2b-2.4 (${label}): not approved`);
      eq(sent.filter((m) => m.to === known).length, 0, `B2b-2.4 (${label}): no farm notice`);
      eq(mailsTo(claimant).length, 0, `B2b-2.4 (${label}): no login mail`);
      const notices = sent.filter((x) => x.to === ADMIN_TO);
      eq(notices.map(isQueuedNotice), [true], `B2b-2.4 (${label}): today's queue notice`);
      ok(!notices[0]!.text.includes(FARM_LINE) && !notices[0]!.html.includes(FARM_LINE), `B2b-2.4 (${label}): the queue notice has no farm-notice line`);
      eq(farmRows(claimId).length, 0, `B2b-2.4 (${label}): no farm_notice row`);
    }
    await noNoticeCase("yellow", { stored: { ...GREEN, result: "yellow", supports: [] } });
    await noNoticeCase("red", { stored: { ...GREEN, result: "red", red_flags: ["has_owner"] } });
    await noNoticeCase("approve flag off", { approveFlag: undefined });
    await noNoticeCase("approve flag TRUE", { approveFlag: "TRUE" });

    // The admin notice without a farm-notice outcome has no line (other callers unchanged).
    {
      const n0 = mails.length;
      await emailSvc.sendAdminClaimAutoApprovedNotification({
        agentName: "Gård x", agentId: "x", claimId: "c-x", claimantName: "K", claimantEmail: "k@x.no", loginLinkSent: true, assessment: GREEN,
      });
      const m = mails.slice(n0)[0];
      ok(!!m && !m.text.includes(FARM_LINE) && !m.html.includes(FARM_LINE), "admin notice: no farmNotice → no line");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    try { openGate(); await ca.__waitForClaimAssessmentsForTesting(); await sleep(40); } catch { /* ignore */ }
    ca.__setClaimAssessmentDepsForTesting(null);
    ca.__setClaimNoticeWaitMsForTesting(null);
    ca.__resetClaimIpWindowForTesting();
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    emailSvc.sendClaimFarmNotice = origSendFarmNotice;
    (knowledgeService as any).isSharedKnownEmail = origIsShared;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbClaimFarmNoticeB2b2Tests({ log: true }).then((s) => {
    console.log(`\nrfb-claim-farm-notice-b2b2: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0); // the marketplace module keeps timers open
  });
}
