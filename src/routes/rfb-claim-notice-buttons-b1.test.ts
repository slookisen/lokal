/**
 * rfb-claim-notice-buttons-b1.test.ts — dev-request 2026-10-30-rfb-eierkrav-
 * automatisk-vurdering-og-ettklikk, SLICE B1: signed «Godkjenn» / «Avvis»
 * buttons (the C4 links) in the admin notice for a queued owner claim.
 *
 *   B1.1  flag on + valid secret: the notice for a NEW queued claim carries one
 *         approve and one reject link to https://rettfrabonden.com/eierkrav/
 *         handling?t=…, both for this claim (inspectClaimActionToken), and two
 *         claim_action_links rows exist for it; no token is logged
 *   B1.2  flag off / secret missing / secret too short: the notice is sent
 *         without links, no claim_action_links rows, and the body equals the
 *         rendering with links undefined
 *   B1.3  a repeat claim from the same claimant (created:false): no new
 *         notice, no new links
 *   throw minting throws → the notice still goes out, without links
 *
 * No network, no production DB: a fresh in-memory SQLite with the real schema,
 * the real POST /agents/:id/claim handler and a stub mail transporter (the
 * rfb-claim-kjent-kontakt.test.ts harness).
 *
 * Exported runRfbClaimNoticeButtonsB1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-notice-buttons-b1.test.ts
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
}

export async function runRfbClaimNoticeButtonsB1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    "CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_CRM_TRACKING_ENABLED",
    "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_TO = "admin@plattform.example.test";
  const SECRET = "b1-notice-test-secret-0123456789abcdef-0123456789";

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const adminMails = () => mails.filter((m) => m.to === ADMIN_TO);
  const flush = () => new Promise<void>((r) => setTimeout(r, 20));

  // ── console capture (no token or link may be logged) ───────────────────
  const logged: string[] = [];
  const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (orig: (...a: any[]) => void) => (...a: any[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (log) orig(...a);
  };

  // ── handler harness ─────────────────────────────────────────────────────
  const handlerOf = (router: any, path: string, method: "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any }): any {
    return {
      params: o.params || {}, body: o.body, query: {}, headers: {}, ip: "127.0.0.1", lang: "no", protocol: "https",
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

    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const cal = require("../services/claim-action-link") as typeof import("../services/claim-action-link");
    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");

    // A profile with no known e-mail → every claim goes to the admin queue.
    function agent(id: string): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery')`)
        .run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`);
      (marketplaceRegistry as any)._agentsCache = null;
      return id;
    }
    const claim = (agentId: string, email = `kari@${agentId}.example.test`) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body: { name: "Kari", email } }));
    const linkRows = (claimId: string) =>
      db.prepare("SELECT action FROM claim_action_links WHERE claim_id = ? ORDER BY action").all(claimId) as { action: string }[];
    const allLinkRows = () => (db.prepare("SELECT COUNT(*) AS n FROM claim_action_links").get() as { n: number }).n;
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") || "";
    const textLink = (m: SentMail, label: string): string => (m.text.match(new RegExp(`^${label}: (\\S+)$`, "m")) ?? [])[1] ?? "";
    const LINK_RE = /https:\/\/rettfrabonden\.com\/eierkrav\/handling\?t=[A-Za-z0-9._%-]+/g;
    // The notice stamps the send time; everything else must match byte for byte.
    const stripTime = (s: string) => s.replace(/Tidspunkt:[^\n]*/g, "Tidspunkt:").replace(/(>Tidspunkt:<\/td><td[^>]*>)[^<]*/g, "$1");
    // The same advice text notifyAdminClaimQueued builds.
    const { CLAIM_RECOMMENDATION_LABELS } = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
    const recommendationText = (r: string | null): string | undefined =>
      r ? `${r} — ${(CLAIM_RECOMMENDATION_LABELS as Record<string, string>)[r] ?? ""}`.replace(/ — $/, "") : undefined;
    // Today's rendering (links undefined) of the notice for this claim.
    async function renderedWithoutLinks(claimId: string): Promise<SentMail> {
      const row = db.prepare(`SELECT c.agent_id, c.claimant_name, c.claimant_email, c.recommendation, a.name AS agent_name
                                FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`).get(claimId) as any;
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification(row.agent_name, row.agent_id, row.claimant_name, row.claimant_email,
        "profilen har ingen kjent e-postadresse", recommendationText(row.recommendation), undefined);
      return mails.splice(n, 1)[0];
    }

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;

    // ══ B1.1 flag on + valid secret ═══════════════════════════════════════
    let b11Claim = "";
    let b11Notice: SentMail | undefined;
    {
      process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;
      agent("b11");
      const n0 = adminMails().length;
      console.log = capture(origConsole.log); console.warn = capture(origConsole.warn);
      console.error = capture(origConsole.error); console.info = capture(origConsole.info);
      let r: { status: number; body: any };
      try {
        r = await claim("b11");
        await flush();
      } finally {
        Object.assign(console, origConsole);
      }
      eq([r.status, r.body?.data?.status], [202, "pending_review"], "B1.1: the claim is queued (202, pending_review)");
      b11Claim = r.body?.data?.claimId;
      eq(r.body?.data, { claimId: b11Claim, status: "pending_review", reason: "no_known_email" }, "B1.1: the route response is unchanged (no links in it)");
      eq(adminMails().length, n0 + 1, "B1.1: exactly one admin notice");
      const notice = adminMails()[adminMails().length - 1];
      b11Notice = notice;
      eq(mails.filter((m) => m.text.includes("/eierkrav/handling")).map((m) => m.to), [ADMIN_TO], "B1.1: the links go only to the admin recipient");
      const approveUrl = textLink(notice, "Godkjenn");
      const rejectUrl = textLink(notice, "Avvis");
      ok(approveUrl.startsWith("https://rettfrabonden.com/eierkrav/handling?t="), "B1.1: text part has the approve link");
      ok(rejectUrl.startsWith("https://rettfrabonden.com/eierkrav/handling?t="), "B1.1: text part has the reject link");
      ok(approveUrl !== rejectUrl, "B1.1: two different links");
      const ia = cal.inspectClaimActionToken(tokenOf(approveUrl));
      const ir = cal.inspectClaimActionToken(tokenOf(rejectUrl));
      eq([ia.state, ia.state === "valid" ? [ia.ctx.claim_id, ia.ctx.action] : null], ["valid", [b11Claim, "approve"]], "B1.1: «Godkjenn» is a valid approve link for this claim");
      eq([ir.state, ir.state === "valid" ? [ir.ctx.claim_id, ir.ctx.action] : null], ["valid", [b11Claim, "reject"]], "B1.1: «Avvis» is a valid reject link for this claim");
      eq(linkRows(b11Claim).map((x) => x.action), ["approve", "reject"], "B1.1: two claim_action_links rows for the claim");
      eq(allLinkRows(), 2, "B1.1: … and no other rows");
      const htmlLinks = (notice.html.match(LINK_RE) ?? []).sort();
      eq(htmlLinks, [approveUrl, rejectUrl].sort(), "B1.1: the HTML part has the same two links as buttons");
      ok(notice.html.includes(`href="${approveUrl}"`) && /href="[^"]+"[^>]*>Godkjenn<\/a>/.test(notice.html), "B1.1: «Godkjenn» button");
      ok(/href="[^"]+"[^>]*>Avvis<\/a>/.test(notice.html), "B1.1: «Avvis» button");
      ok(notice.text.includes("Lenken åpner en bekreftelsesside og virker én gang innen 72 timer.")
        && notice.html.includes("Lenken åpner en bekreftelsesside og virker én gang innen 72 timer."), "B1.1: the one-line note (confirmation page, once, 72 hours)");
      ok(!logged.some((l) => l.includes(tokenOf(approveUrl)) || l.includes(tokenOf(rejectUrl)) || l.includes("/eierkrav/handling")),
        "B1.1: no token or link is logged");
      // The rest of the notice is today's: removing the link block gives the old body.
      const plain = await renderedWithoutLinks(b11Claim);
      const textNoLinks = notice.text.replace(/Godkjenn: \S+\nAvvis: \S+\n[^\n]+\n\n/, "");
      const htmlNoLinks = notice.html.replace(/\n {10}<p><a href=[\s\S]*?72 timer\.<\/p>/, "");
      eq(stripTime(textNoLinks), stripTime(plain.text), "B1.1: text part = today's text plus only the link block");
      eq(stripTime(htmlNoLinks), stripTime(plain.html), "B1.1: HTML part = today's HTML plus only the button block");
      eq(notice.subject, plain.subject, "B1.1: subject unchanged");
    }

    // ══ B1.3 repeat claim from the same claimant ══════════════════════════
    {
      const n0 = adminMails().length;
      const rows0 = allLinkRows();
      const r = await claim("b11");
      await flush();
      eq([r.status, r.body?.data?.claimId], [202, b11Claim], "B1.3: a repeat returns the same queue entry");
      eq(adminMails().length, n0, "B1.3: no new notice");
      eq(allLinkRows(), rows0, "B1.3: no new links minted");
      void b11Notice;
    }

    // ══ B1.2 flag off / secret missing / secret too short ═════════════════
    const cases: { label: string; flag?: string; secret?: string }[] = [
      { label: "flag off", secret: SECRET },
      { label: "flag \"TRUE\" (not exactly true)", flag: "TRUE", secret: SECRET },
      { label: "secret missing", flag: "true" },
      { label: "secret too short", flag: "true", secret: "x".repeat(31) },
    ];
    let i = 0;
    for (const c of cases) {
      const id = agent(`b12-${++i}`);
      if (c.flag === undefined) delete process.env.CLAIM_ACTION_LINKS_ENABLED; else process.env.CLAIM_ACTION_LINKS_ENABLED = c.flag;
      if (c.secret === undefined) delete process.env.CLAIM_ACTION_LINK_SECRET; else process.env.CLAIM_ACTION_LINK_SECRET = c.secret;
      const n0 = adminMails().length;
      const rows0 = allLinkRows();
      const r = await claim(id);
      await flush();
      eq(r.status, 202, `B1.2 (${c.label}): the claim is queued`);
      eq(adminMails().length, n0 + 1, `B1.2 (${c.label}): the notice is sent`);
      const notice = adminMails()[adminMails().length - 1];
      ok(!notice.text.includes("/eierkrav/handling") && !notice.html.includes("/eierkrav/handling")
        && !notice.html.includes(">Godkjenn<") && !notice.text.includes("72 timer"), `B1.2 (${c.label}): no links, buttons or note`);
      eq(allLinkRows(), rows0, `B1.2 (${c.label}): no claim_action_links rows`);
      const plain = await renderedWithoutLinks(r.body.data.claimId);
      eq([stripTime(notice.text), stripTime(notice.html), notice.subject], [stripTime(plain.text), stripTime(plain.html), plain.subject],
        `B1.2 (${c.label}): body equals the rendering with links undefined`);
    }

    // Omitting the parameter and passing undefined render the same (today's call shape).
    {
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification("Gård x", "x", "Kari", "k@x.example.test", "grunn", undefined);
      await emailSvc.sendAdminClaimReviewNotification("Gård x", "x", "Kari", "k@x.example.test", "grunn", undefined, undefined);
      const [a, b] = mails.splice(n, 2);
      eq([stripTime(a.text), stripTime(a.html)], [stripTime(b.text), stripTime(b.html)], "B1.2: links omitted = links undefined");
    }

    // HTML-escaping of the interpolated link.
    {
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification("Gård x", "x", "Kari", "k@x.example.test", "grunn", undefined,
        { approve: 'https://rettfrabonden.com/eierkrav/handling?t=a"><script>&b', reject: "https://rettfrabonden.com/eierkrav/handling?t=r" });
      const m = mails.splice(n, 1)[0];
      ok(!m.html.includes("<script>") && m.html.includes("t=a&quot;&gt;&lt;script&gt;&amp;b"), "escape: the link is HTML-escaped in the button href");
    }

    // ══ minting throws → the notice still goes out, without links ═════════
    {
      process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;
      const id = agent("b1-throw");
      db.exec("ALTER TABLE claim_action_links RENAME TO claim_action_links_hidden");
      const n0 = adminMails().length;
      let r: { status: number; body: any };
      console.error = capture(origConsole.error); console.warn = capture(origConsole.warn);
      try {
        r = await claim(id);
        await flush();
      } finally {
        Object.assign(console, origConsole);
        db.exec("ALTER TABLE claim_action_links_hidden RENAME TO claim_action_links");
      }
      eq(r.status, 202, "throw: the claim is still queued");
      eq(adminMails().length, n0 + 1, "throw: the notice is still sent");
      const notice = adminMails()[adminMails().length - 1];
      ok(!notice.text.includes("/eierkrav/handling") && !notice.html.includes("/eierkrav/handling"), "throw: … without links");
      eq(linkRows(r.body.data.claimId).length, 0, "throw: no claim_action_links rows");
      const plain = await renderedWithoutLinks(r.body.data.claimId);
      eq([stripTime(notice.text), stripTime(notice.html)], [stripTime(plain.text), stripTime(plain.html)], "throw: body equals today's rendering");
    }

    // ══ no admin recipient → nothing minted ═══════════════════════════════
    {
      delete process.env.ADMIN_NOTIFICATION_EMAIL;
      const id = agent("b1-norecipient");
      const rows0 = allLinkRows();
      const r = await claim(id);
      await flush();
      eq(r.status, 202, "no recipient: the claim is queued");
      eq(allLinkRows(), rows0, "no recipient: no links minted for a notice nobody receives");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    Object.assign(console, origConsole);
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
  runRfbClaimNoticeButtonsB1Tests({ log: true }).then((s) => {
    console.log(`\nrfb-claim-notice-buttons-b1: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0); // the marketplace module keeps timers open
  });
}
