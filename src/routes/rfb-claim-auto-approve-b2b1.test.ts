/**
 * rfb-claim-auto-approve-b2b1.test.ts — dev-request 2026-10-30-rfb-eierkrav-
 * automatisk-vurdering-og-ettklikk, SLICE B2b-1: a green claim assessment
 * approves a queued owner claim automatically, and the admin is told so with
 * an «Angre» (revoke) option.
 *
 *   B2b-1.1  both flags on + a green assessment: the claim is approved once
 *            (claimed_via / verification_method = auto_assessment), the
 *            approval login mail goes out and is in the claim's CRM thread,
 *            and the admin gets «Eierkrav godkjent automatisk» with the
 *            assessment block and a signed revoke link (C4 flag on) or the
 *            claim-revoke text line (C4 flag off); values HTML-escaped
 *   B2b-1.2  yellow, red (has_owner, free mail without A2), NULL,
 *            unparseable JSON, an unknown result, a run that throws, a run
 *            over the wait: no approval, today's queue notice
 *   B2b-1.3  one flag off, or "TRUE" / "1": no approval, the notice is the
 *            B2a / today's notice byte for byte
 *   B2b-1.4  the admin approved/rejected first, or the profile got an owner
 *            first: no second approval, no extra mail; the POST
 *            /agents/:id/claim response is unchanged and does not wait
 *   B2b-1.5  applyClaimRevoke after an auto-approval puts the profile back
 *            (C1 snapshot)
 *
 * The assessment runs for real with stub network deps (Brreg names the
 * claimant, RDAP says the domain is old enough → A1 + S1 + S3 = green) behind a
 * gate. A test-only SQLite trigger can replace what it stores with a crafted
 * value (as in the B2a test).
 *
 * Exported runRfbClaimAutoApproveB2b1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-auto-approve-b2b1.test.ts
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
  at: number;
}

export async function runRfbClaimAutoApproveB2b1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const SECRET = "b2b1-auto-approve-test-secret-0123456789abcdef-0123";
  const WAIT_MS = 300;

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? ""), at: Date.now() });
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
  let nowThrows = false;
  ca.__setClaimAssessmentDepsForTesting({
    now: () => { if (nowThrows) throw new Error("clock broke"); return new Date("2026-11-06T12:00:00.000Z"); },
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
      params: o.params || {}, body: o.body, query: {}, headers: {}, ip: `198.51.${100 + Math.floor(ipSeq / 200)}.${ipSeq % 200}`,
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

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    db.exec(`CREATE TABLE b2b1_craft (v TEXT);
      CREATE TRIGGER b2b1_craft_after AFTER UPDATE OF claim_assessment ON agent_claims
        WHEN (SELECT COUNT(*) FROM b2b1_craft) > 0
      BEGIN
        UPDATE agent_claims SET claim_assessment = (SELECT v FROM b2b1_craft LIMIT 1) WHERE id = NEW.id;
      END;`);
    const craft = (v: string | null | undefined) => {
      db.exec("DELETE FROM b2b1_craft");
      if (v !== undefined) db.prepare("INSERT INTO b2b1_craft (v) VALUES (?)").run(v);
    };

    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const actions = require("../services/claim-review-actions") as typeof import("../services/claim-review-actions");
    const auto = require("../services/claim-auto-approve") as typeof import("../services/claim-auto-approve");
    const cal = require("../services/claim-action-link") as typeof import("../services/claim-action-link");
    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");

    // A profile with an own website and an independent org.nr, no known e-mail
    // → a claim is queued (no_known_email), and kari@gard-<id>.no is A1 + S1.
    let seq = 0;
    function agent(id: string, name = `Gård ${id}`): string {
      seq++;
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, is_vetted, org_nr)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery', 1, ?)`)
        .run(id, name, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`, String(910000000 + seq));
      db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website, phone, data_source, curated_fields, field_provenance)
                  VALUES (?, NULL, ?, NULL, 'auto', '{}', '{}')`).run(id, `https://www.gard-${id}.no/`);
      (marketplaceRegistry as any)._agentsCache = null;
      return id;
    }
    const claimantOf = (agentId: string) => `kari@gard-${agentId}.no`;
    const claim = (agentId: string, email = claimantOf(agentId)) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body: { name: "Kari Nordmann", email } }));
    const claimRow = (id: string): any => db.prepare("SELECT status, verification_method, claimant_email, claim_assessment FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT is_verified, claimed_at, claimed_via FROM agents WHERE id = ?").get(id);
    const dataSource = (id: string) => (db.prepare("SELECT data_source FROM agent_knowledge WHERE agent_id = ?").get(id) as any)?.data_source;
    const mailsTo = (to: string) => mails.filter((m) => m.to === to);
    const crmApproved = (claimId: string) => (db.prepare(
      "SELECT COUNT(*) AS n FROM crm_messages WHERE thread_id = ? AND direction = 'out' AND raw_metadata LIKE '%claim_approved%'"
    ).get(`claim-${claimId}`) as { n: number }).n;
    const linkRows = (claimId: string) => db.prepare("SELECT action FROM claim_action_links WHERE claim_id = ? ORDER BY action").all(claimId) as Array<{ action: string }>;
    const stripTime = (s: string) => s.replace(/Tidspunkt:[^\n]*/g, "Tidspunkt:").replace(/(>Tidspunkt:<\/td><td[^>]*>)[^<]*/g, "$1");
    const settle = async () => { await ca.__waitForClaimAssessmentsForTesting(); await sleep(40); };
    const isAutoNotice = (m: SentMail) => m.subject.startsWith("Eierkrav godkjent automatisk");
    const isQueuedNotice = (m: SentMail) => m.subject.startsWith("Eierkrav venter på godkjenning");
    const { CLAIM_RECOMMENDATION_LABELS } = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
    // The label notifyAdminClaimQueued shows for a no_known_email queue entry (the only reason here).
    const CLAIM_REVIEW_REASON_LABELS: Record<string, string> = { no_known_email: "profilen har ingen kjent e-postadresse" };
    /** The queue notice as B2a renders it (no links) for this claim and stored value. */
    async function queuedNoticeAsToday(claimId: string, assessment: unknown): Promise<SentMail> {
      const row = db.prepare(`SELECT c.agent_id, c.claimant_name, c.claimant_email, c.review_reason, c.recommendation, a.name AS agent_name
                                FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`).get(claimId) as any;
      const reason = row.review_reason ? (CLAIM_REVIEW_REASON_LABELS[row.review_reason] ?? row.review_reason) : "ukjent";
      const rec = row.recommendation
        ? `${row.recommendation} — ${(CLAIM_RECOMMENDATION_LABELS as Record<string, string>)[row.recommendation] ?? ""}`.replace(/ — $/, "")
        : undefined;
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification(row.agent_name, row.agent_id, row.claimant_name, row.claimant_email, reason, rec, undefined, assessment);
      return mails.splice(n, 1)[0];
    }
    const sameNotice = async (notice: SentMail | undefined, claimId: string, assessment: unknown, label: string) => {
      if (!notice) { eq(null, "a notice", label); return; }
      const expected = await queuedNoticeAsToday(claimId, assessment);
      eq([notice.subject, stripTime(notice.text), stripTime(notice.html)], [expected.subject, stripTime(expected.text), stripTime(expected.html)], label);
    };
    const parsed = (raw: string | null) => (require("../services/knowledge-service") as typeof import("../services/knowledge-service")).parseStoredClaimAssessment(raw) ?? undefined;

    const GREEN = {
      result: "green", anchors: ["A1"], supports: ["S1"], red_flags: [], unavailable_sources: [],
      possible_duplicate: false, signals: [], rule_version: "A1", org_nr: null,
    };

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;
    process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = "true";
    process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";

    // ══ unit: the flag and the green check ════════════════════════════════
    {
      eq([
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_APPROVE_ENABLED: "true", CLAIM_AUTO_ASSESSMENT_ENABLED: "true" } as any),
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_APPROVE_ENABLED: "true" } as any),
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_ASSESSMENT_ENABLED: "true" } as any),
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_APPROVE_ENABLED: "TRUE", CLAIM_AUTO_ASSESSMENT_ENABLED: "true" } as any),
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_APPROVE_ENABLED: "1", CLAIM_AUTO_ASSESSMENT_ENABLED: "true" } as any),
        auto.claimAutoApproveEnabled({ CLAIM_AUTO_APPROVE_ENABLED: "true", CLAIM_AUTO_ASSESSMENT_ENABLED: "TRUE" } as any),
        auto.claimAutoApproveEnabled({} as any),
      ], [true, false, false, false, false, false, false], "unit: on only when both flags are exactly \"true\"");
      eq([
        auto.isGreenClaimAssessment(GREEN),
        auto.isGreenClaimAssessment({ ...GREEN, result: "yellow" }),
        auto.isGreenClaimAssessment({ ...GREEN, red_flags: ["free_mail"] }),
        auto.isGreenClaimAssessment({ ...GREEN, unavailable_sources: ["rdap"] }),
        auto.isGreenClaimAssessment({ ...GREEN, possible_duplicate: true }),
        auto.isGreenClaimAssessment({ ...GREEN, anchors: ["A1_sibling"] }),
        auto.isGreenClaimAssessment({ ...GREEN, supports: ["S4"] }),
        auto.isGreenClaimAssessment({ ...GREEN, anchors: [] }),
        auto.isGreenClaimAssessment({ result: "green" }),
        auto.isGreenClaimAssessment(null),
        auto.isGreenClaimAssessment("green"),
        auto.isGreenClaimAssessment([GREEN]),
      ], [true, false, false, false, false, false, false, false, false, false, false, false],
      "unit: green only when the stored value holds up to slice A's green rule");
    }

    // ══ B2b-1.1 (C4 links off) + B2b-1.4 response + B2b-1.5 revoke ════════
    {
      craft(undefined);
      closeGate();
      const id = agent("b11");
      const before = agentRow(id);
      const n0 = adminMails().length;
      const t0 = Date.now();
      const r = await claim(id);
      const responseMs = Date.now() - t0;
      eq([r.status, r.body?.success, r.body?.data], [202, true, { claimId: r.body?.data?.claimId, status: "pending_review", reason: "no_known_email" }],
        "B2b-1.4: the POST /agents/:id/claim response is unchanged (202, pending_review)");
      ok(responseMs < WAIT_MS, `B2b-1.4: the response does not wait for the decision (${responseMs} ms)`);
      const claimId = r.body.data.claimId;
      await sleep(30);
      eq(claimRow(claimId).status, "pending_review", "B2b-1.1: still queued while the assessment runs");
      eq(adminMails().length, n0, "B2b-1.1: no notice while the assessment runs");
      openGate();
      await settle();

      const row = claimRow(claimId);
      eq(JSON.parse(row.claim_assessment ?? "{}").result, "green", "B2b-1.1: the real assessment is green (A1 + S1 + S3)");
      eq([row.status, row.verification_method], ["verified", "auto_assessment"], "B2b-1.1: the claim is approved, audit verification_method = auto_assessment");
      eq([agentRow(id).claimed_via, agentRow(id).is_verified, !!agentRow(id).claimed_at], ["auto_assessment", 1, true],
        "B2b-1.1: agents.claimed_via = auto_assessment, badge and claimed_at as an admin approval");
      eq(dataSource(id), "hybrid", "B2b-1.1: the profile's data_source follows the grant (auto → hybrid)");
      const toClaimant = mailsTo(claimantOf(id));
      eq(toClaimant.map((m) => m.subject), [`Profilen til Gård ${id} er nå din på Rett fra Bonden`], "B2b-1.1: the claimant gets today's approval login mail, once");
      eq(crmApproved(claimId), 1, "B2b-1.1: the login mail is in the claim's CRM thread");
      const notices = adminMails().slice(n0);
      eq(notices.length, 1, "B2b-1.1: exactly one admin notice");
      const m = notices[0]!;
      ok(isAutoNotice(m) && m.subject === `Eierkrav godkjent automatisk: Gård ${id}`, "B2b-1.1: the notice is «Eierkrav godkjent automatisk» (not the queue notice)");
      ok(m.text.includes(`Produsent: Gård ${id} (${id})`) && m.text.includes(`E-post: ${claimantOf(id)}`), "B2b-1.1: profile and claimant e-mail in the text");
      ok(m.html.includes(`Gård ${id} (${id})`) && m.html.includes(claimantOf(id)), "B2b-1.1: profile and claimant e-mail in the HTML");
      ok(m.text.includes("Innlogging: sendt\n"), "B2b-1.1: the notice says the login mail was sent");
      ok(m.text.includes("Automatisk vurdering: grønn\nAnker: A1 — e-postdomenet er profilens nettsted (uavhengig kilde)\nStøtte: S1 — navnet er innehaver, daglig leder eller styreleder i Brreg\nStøtte: S3 — domenet ble registrert for minst ett år siden\nKravet ble godkjent automatisk fordi vurderingen er grønn.\n"),
        "B2b-1.1: the text has the B2a assessment block with the auto note");
      ok(m.html.includes(">Automatisk vurdering: grønn</p>") && m.html.includes("<li>Anker: A1 — e-postdomenet er profilens nettsted (uavhengig kilde)</li>"),
        "B2b-1.1: the HTML has the assessment block");
      ok(!m.text.includes("Vurderingen er bare registrert") && !m.html.includes("Vurderingen er bare registrert"), "B2b-1.1: no «only recorded» note");
      const revokeLine = `Angre: POST /admin/agents/claim-revoke {"claimId": "${claimId}", "note": "…"} (X-Admin-Key)`;
      ok(m.text.endsWith(revokeLine), "B2b-1.1 (C4 off): the text names POST /admin/agents/claim-revoke {claimId, note}");
      ok(m.html.includes(`<p>Angre: POST /admin/agents/claim-revoke {&quot;claimId&quot;: &quot;${claimId}&quot;, &quot;note&quot;: &quot;…&quot;} (X-Admin-Key)</p>`),
        "B2b-1.1 (C4 off): the HTML has the escaped claim-revoke line");
      ok(!m.html.includes("/eierkrav/handling") && !m.text.includes("/eierkrav/handling"), "B2b-1.1 (C4 off): no signed link");
      eq(linkRows(claimId).length, 0, "B2b-1.1 (C4 off): no claim_action_links rows");

      // One decision: a later direct call changes nothing and sends nothing.
      const nMails = mails.length;
      eq(await auto.autoApproveGreenClaim(claimId, GREEN), false, "B2b-1.4: a second auto decision for the claim approves nothing");
      await sleep(20);
      eq(mails.length, nMails, "B2b-1.4: … and sends no mail");
      eq(knowledgeService.approveClaimReview(claimId, undefined, "auto_assessment"), { ok: false, error: "not_pending_review" },
        "B2b-1.4: approveClaimReview(auto) on a verified claim is refused");

      // B2b-1.5: revoke after the auto-approval restores the C1 snapshot.
      const rv = actions.applyClaimRevoke(claimId, "test");
      eq(rv.ok ? [rv.restored, rv.ownerRemains] : rv, ["snapshot", false], "B2b-1.5: applyClaimRevoke restores from the snapshot");
      eq(agentRow(id), before, "B2b-1.5: is_verified / claimed_at / claimed_via are back to before the auto-approval");
      eq(dataSource(id), "auto", "B2b-1.5: data_source is back to auto");
      eq(claimRow(claimId).status, "revoked", "B2b-1.5: the claim is revoked");
    }

    // ══ B2b-1.1 (C4 links on): a signed revoke link, values escaped ═══════
    {
      process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;
      craft(undefined);
      gate = Promise.resolve();
      const id = agent("b11l", `Gård <b>"Ål"</b> & co`);
      const n0 = adminMails().length;
      const r = await claim(id);
      await settle();
      const claimId = r.body.data.claimId;
      eq(agentRow(id).claimed_via, "auto_assessment", "B2b-1.1 (C4 on): approved automatically");
      const notices = adminMails().slice(n0);
      eq(notices.length, 1, "B2b-1.1 (C4 on): one admin notice");
      const m = notices[0]!;
      ok(isAutoNotice(m), "B2b-1.1 (C4 on): the auto-approved notice");
      const href = (m.html.match(/href="(https:\/\/rettfrabonden\.com\/eierkrav\/handling\?t=[^"]+)"[^>]*>Angre<\/a>/) ?? [])[1] ?? "";
      ok(!!href, "B2b-1.1 (C4 on): an «Angre» button with a /eierkrav/handling link");
      const textUrl = (m.text.match(/^Angre: (https:\/\/rettfrabonden\.com\/eierkrav\/handling\?t=\S+)$/m) ?? [])[1] ?? "";
      ok(!!textUrl, "B2b-1.1 (C4 on): the text has the «Angre» link");
      const tokenOf = (url: string) => new URL(url.replace(/&amp;/g, "&")).searchParams.get("t") || "";
      const it = cal.inspectClaimActionToken(tokenOf(textUrl));
      eq([it.state, it.state === "valid" ? [it.ctx.claim_id, it.ctx.action] : null], ["valid", [claimId, "revoke"]], "B2b-1.1 (C4 on): the link is a valid revoke link for this claim");
      eq(tokenOf(href), tokenOf(textUrl), "B2b-1.1 (C4 on): button and text carry the same link");
      eq(linkRows(claimId).map((x) => x.action), ["revoke"], "B2b-1.1 (C4 on): one claim_action_links row, revoke");
      ok(!m.text.includes("claim-revoke {"), "B2b-1.1 (C4 on): no claim-revoke text line instead of the link");
      ok(!m.html.includes("<b>") && m.html.includes("Gård &lt;b&gt;&quot;Ål&quot;&lt;/b&gt; &amp; co"), "B2b-1.1 (C4 on): the profile name is HTML-escaped");
      eq(mailsTo(claimantOf(id)).length, 1, "B2b-1.1 (C4 on): one login mail to the claimant");
      ok(mails.filter((x) => x.html.includes("/eierkrav/handling")).every((x) => x.to === ADMIN_TO), "B2b-1.1 (C4 on): the link goes only to the admin");
      delete process.env.CLAIM_ACTION_LINKS_ENABLED;
      delete process.env.CLAIM_ACTION_LINK_SECRET;
    }

    // ══ B2b-1.2: not green → no approval, today's queue notice ════════════
    async function noApprovalCase(label: string, o: { craftV?: string | null; email?: string; nowThrows?: boolean; hold?: boolean }) {
      craft(o.craftV);
      nowThrows = !!o.nowThrows;
      if (o.hold) closeGate(); else gate = Promise.resolve();
      const id = agent(`b12-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const email = o.email ?? claimantOf(id);
      const n0 = adminMails().length;
      const r = await claim(id, email);
      if (o.hold) await sleep(WAIT_MS + 150); else await settle();
      const claimId = r.body?.data?.claimId;
      eq(r.status, 202, `B2b-1.2 (${label}): the claim is queued`);
      const notices = adminMails().slice(n0);
      eq(notices.map(isQueuedNotice), [true], `B2b-1.2 (${label}): one notice, the queue notice`);
      const stored = o.hold ? undefined : parsed(claimRow(claimId).claim_assessment);
      await sameNotice(notices[0], claimId, stored, `B2b-1.2 (${label}): the notice is today's (B2a) notice byte for byte`);
      if (o.hold) {
        openGate();
        await settle();
        eq(JSON.parse(claimRow(claimId).claim_assessment ?? "{}").result, "green", `B2b-1.2 (${label}): the late assessment is green`);
        eq(adminMails().length, n0 + 1, `B2b-1.2 (${label}): no second notice when it lands`);
      }
      eq(claimRow(claimId).status, "pending_review", `B2b-1.2 (${label}): still pending_review`);
      eq(agentRow(id).claimed_via, null, `B2b-1.2 (${label}): no claimed_via`);
      eq(mailsTo(email).length, 0, `B2b-1.2 (${label}): no login mail`);
      nowThrows = false;
    }
    await noApprovalCase("yellow", { craftV: JSON.stringify({ ...GREEN, result: "yellow", supports: [] }) });
    await noApprovalCase("red has_owner", { craftV: JSON.stringify({ ...GREEN, result: "red", red_flags: ["has_owner"] }) });
    await noApprovalCase("red free mail", { craftV: undefined, email: "kari.nordmann.b2b1@gmail.com" });
    {
      const last = db.prepare("SELECT claim_assessment FROM agent_claims WHERE claimant_email = 'kari.nordmann.b2b1@gmail.com'").get() as any;
      const a = JSON.parse(last?.claim_assessment ?? "{}");
      eq([a.result, (a.red_flags ?? []).includes("free_mail"), a.anchors], ["red", true, []], "B2b-1.2 (red free mail): a real red assessment with free_mail and no A2");
    }
    await noApprovalCase("green with a red flag", { craftV: JSON.stringify({ ...GREEN, red_flags: ["domain_young"] }) });
    await noApprovalCase("stored NULL", { craftV: null });
    await noApprovalCase("unparseable JSON", { craftV: "{not json" });
    await noApprovalCase("unknown result", { craftV: JSON.stringify({ ...GREEN, result: "purple" }) });
    await noApprovalCase("assessment throws", { nowThrows: true });
    await noApprovalCase("over the wait", { hold: true });

    // ══ B2b-1.3: a flag off or not exactly "true" ═════════════════════════
    async function flagCase(label: string, approve: string | undefined, assess: string | undefined) {
      if (approve === undefined) delete process.env.CLAIM_AUTO_APPROVE_ENABLED; else process.env.CLAIM_AUTO_APPROVE_ENABLED = approve;
      if (assess === undefined) delete process.env.CLAIM_AUTO_ASSESSMENT_ENABLED; else process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = assess;
      craft(undefined);
      gate = Promise.resolve();
      const id = agent(`b13-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const n0 = adminMails().length;
      const r = await claim(id);
      await settle();
      const claimId = r.body.data.claimId;
      const stored = parsed(claimRow(claimId).claim_assessment);
      if (assess === "true") eq(stored?.result, "green", `B2b-1.3 (${label}): the assessment is green`);
      else eq(stored, undefined, `B2b-1.3 (${label}): no assessment stored`);
      const notices = adminMails().slice(n0);
      eq(notices.map(isQueuedNotice), [true], `B2b-1.3 (${label}): one notice, the queue notice`);
      await sameNotice(notices[0], claimId, stored, `B2b-1.3 (${label}): the notice is byte-identical to today's`);
      eq([claimRow(claimId).status, agentRow(id).claimed_via], ["pending_review", null], `B2b-1.3 (${label}): not approved`);
      eq(mailsTo(claimantOf(id)).length, 0, `B2b-1.3 (${label}): no login mail`);
    }
    await flagCase("approve off", undefined, "true");
    await flagCase("approve TRUE", "TRUE", "true");
    await flagCase("approve 1", "1", "true");
    await flagCase("assessment off", "true", undefined);
    await flagCase("assessment TRUE", "true", "TRUE");
    await flagCase("both off", undefined, undefined);
    process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    process.env.CLAIM_AUTO_ASSESSMENT_ENABLED = "true";

    // ══ B2b-1.4: decided or owned before the auto decision ════════════════
    async function raceCase(label: string, between: (claimId: string, agentId: string) => void,
      expect: { status: string; claimedVia: string | null; method: string | null }) {
      craft(undefined);
      closeGate();
      const id = agent(`b14-${label.replace(/[^a-z0-9]+/gi, "-")}`);
      const n0 = adminMails().length;
      const r = await claim(id);
      const claimId = r.body.data.claimId;
      await sleep(20);
      between(claimId, id);
      openGate();
      await settle();
      eq(JSON.parse(claimRow(claimId).claim_assessment ?? "{}").result, "green", `B2b-1.4 (${label}): the assessment is green`);
      eq([claimRow(claimId).status, agentRow(id).claimed_via, claimRow(claimId).verification_method], [expect.status, expect.claimedVia, expect.method],
        `B2b-1.4 (${label}): the earlier outcome stands`);
      eq(mailsTo(claimantOf(id)).length, 0, `B2b-1.4 (${label}): no (extra) login mail`);
      eq(crmApproved(claimId), 0, `B2b-1.4 (${label}): no approval in the CRM thread`);
      const notices = adminMails().slice(n0);
      ok(!notices.some(isAutoNotice), `B2b-1.4 (${label}): no «godkjent automatisk» notice`);
      eq(notices.length, 1, `B2b-1.4 (${label}): only today's queue notice`);
    }
    await raceCase("admin approved", (c) => { actions.applyClaimApprove(c); },
      { status: "verified", claimedVia: "admin_approval", method: "manual" });
    await raceCase("admin rejected", (c) => { actions.applyClaimReject(c, "nei"); },
      { status: "rejected", claimedVia: null, method: "manual" });
    await raceCase("profile got an owner", (_c, a) => {
      db.prepare("UPDATE agents SET claimed_at = ?, claimed_via = 'claim' WHERE id = ?").run(new Date().toISOString(), a);
    }, { status: "pending_review", claimedVia: "claim", method: "manual" });

    // The transaction re-check itself: a green claim on an owned profile is refused.
    {
      gate = Promise.resolve();
      delete process.env.CLAIM_AUTO_APPROVE_ENABLED;
      const id = agent("b14-direct");
      const r = await claim(id);
      await settle();
      const claimId = r.body.data.claimId;
      db.prepare("UPDATE agents SET claimed_at = ?, claimed_via = 'claim' WHERE id = ?").run(new Date().toISOString(), id);
      eq(knowledgeService.approveClaimReview(claimId, undefined, "auto_assessment"), { ok: false, error: "has_owner" },
        "B2b-1.4: approveClaimReview(auto) refuses when the profile has an owner");
      const nMails = mails.length;
      eq(await auto.autoApproveGreenClaim(claimId, GREEN), false, "B2b-1.4: autoApproveGreenClaim on an owned profile approves nothing");
      eq([mails.length, claimRow(claimId).status], [nMails, "pending_review"], "B2b-1.4: … no mail, still queued");
      process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    }

    // The admin path is unchanged by the new parameter.
    {
      gate = Promise.resolve();
      delete process.env.CLAIM_AUTO_APPROVE_ENABLED;
      const id = agent("b14-admin");
      const r = await claim(id);
      await settle();
      const res = actions.applyClaimApprove(r.body.data.claimId);
      eq(res.ok, true, "admin path: applyClaimApprove without via still approves");
      eq([agentRow(id).claimed_via, claimRow(r.body.data.claimId).verification_method], ["admin_approval", "manual"], "admin path: admin_approval / manual as before");
      process.env.CLAIM_AUTO_APPROVE_ENABLED = "true";
    }

    // A repeat claim (created:false) gets no decision and no notice.
    {
      gate = Promise.resolve();
      craft(JSON.stringify({ ...GREEN, result: "yellow" }));
      const id = agent("b14-repeat");
      const r1 = await claim(id);
      await settle();
      craft(undefined);
      const n0 = mails.length;
      const r2 = await claim(id);
      await sleep(WAIT_MS + 50);
      eq([r2.status, r2.body?.data?.claimId], [202, r1.body.data.claimId], "B2b-1.4: a repeat returns the same queue entry");
      eq([mails.length, claimRow(r1.body.data.claimId).status], [n0, "pending_review"], "B2b-1.4: a repeat sends nothing and approves nothing");
    }

    // The wait outcome helper.
    {
      eq(await ca.waitForClaimAssessmentOutcome("no-such-claim"), "none", "wait: no run in flight → none");
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
  runRfbClaimAutoApproveB2b1Tests({ log: true }).then((s) => {
    console.log(`\nrfb-claim-auto-approve-b2b1: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0); // the marketplace module keeps timers open
  });
}
