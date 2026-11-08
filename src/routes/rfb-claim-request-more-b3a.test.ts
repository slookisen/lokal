/**
 * rfb-claim-request-more-b3a.test.ts — dev-request 2026-10-30-rfb-eierkrav-
 * automatisk-vurdering-og-ettklikk, SLICE B3a: «Be om mer bekreftelse» as a
 * third choice on a queued owner claim (CLAIM_REQUEST_MORE_ENABLED).
 *
 *   B3a.1  C4 links + B3a flag on: the admin notice for a new queued claim
 *          carries approve, reject AND request_more (third button + text
 *          line); B3a flag off: two links and a notice byte-identical to
 *          today's rendering
 *   B3a.2  request_more link: GET changes nothing and sends nothing; POST
 *          sends exactly one mail (claimant, support Reply-To, no links) and
 *          one CRM message kind request_more, the claim stays pending_review;
 *          second POST 409. Flag off → «not available», link not used up.
 *          24 h rule shared with the admin route; failed send → 502, link not
 *          used up, nothing stamped.
 *   B3a.3  POST /admin/agents/claim-request-more: 403 / 400 / 404 / 409 not
 *          pending / 503 flag off / 409 already_requested / 200; failed send
 *          → 502 and the 24 h window does not start
 *   mint   default mint of existing callers unchanged (admin mint default,
 *          actionsForStatus, explicit revoke / approve+reject)
 *
 * No network, no production DB: a fresh in-memory SQLite with the real schema,
 * the real routers on an in-process server, the real POST /agents/:id/claim
 * handler and a stub mail transporter.
 *
 * Exported runRfbClaimRequestMoreB3aTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-request-more-b3a.test.ts
 */

import Database from "better-sqlite3";
import http from "http";

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

export async function runRfbClaimRequestMoreB3aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "CLAIM_ACTION_LINK_SECRET",
    "CLAIM_ACTION_LINKS_ENABLED", "CLAIM_REQUEST_MORE_ENABLED", "CLAIM_CRM_TRACKING_ENABLED",
    "CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_AUTO_APPROVE_ENABLED",
    "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_KEY = "b3a-test-admin-key";
  const ADMIN_TO = "admin@plattform.example.test";
  const SECRET = "b3a-request-more-test-secret-0123456789abcdef-012345";

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  let failSends = false;
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      if (failSends) throw new Error("smtp down");
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? ""), replyTo: String(m.replyTo ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const adminMails = () => mails.filter((m) => m.to === ADMIN_TO);
  const flush = () => new Promise<void>((r) => setTimeout(r, 20));

  // ── console capture (no address, token or link may be logged) ──────────
  const logged: string[] = [];
  const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (orig: (...a: any[]) => void) => (...a: any[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (log) orig(...a);
  };
  const startCapture = () => {
    console.log = capture(origConsole.log); console.warn = capture(origConsole.warn);
    console.error = capture(origConsole.error); console.info = capture(origConsole.info);
  };
  const stopCapture = () => Object.assign(console, origConsole);

  // ── marketplace claim handler harness (as in the B1 suite) ──────────────
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

  let server: http.Server | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
    process.env.ADMIN_KEY = ADMIN_KEY;

    const express = require("express");
    const calRoutes = require("./claim-action-link") as typeof import("./claim-action-link");
    delete require.cache[require.resolve("./admin-agents")];
    const adminAgents = require("./admin-agents").default;
    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const cal = require("../services/claim-action-link") as typeof import("../services/claim-action-link");
    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    {
      const app = express();
      app.use(express.json());
      app.use("/", calRoutes.default);
      app.use("/admin/agents/claim-action-links", calRoutes.claimActionAdminRouter);
      app.use("/admin/agents", adminAgents);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; body: any; text: string };
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.body !== undefined) { bodyStr = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body: parsed, text: raw });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const admin = { "X-Admin-Key": ADMIN_KEY };
    const requestMore = (body: unknown, headers: Record<string, string> = admin) =>
      req("POST", "/admin/agents/claim-request-more", { headers, body });
    const mint = (body: unknown) => req("POST", "/admin/agents/claim-action-links", { headers: admin, body });
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") || "";
    const page = (t: string) => req("GET", `/eierkrav/handling?t=${encodeURIComponent(t)}`);
    const submit = (t: string) => req("POST", "/eierkrav/handling", { form: { t } });

    // ── fixtures ──────────────────────────────────────────────────────────
    // A profile with no known e-mail → every claim goes to the admin queue.
    function agent(id: string, name = `Gård ${id}`): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery')`)
        .run(id, name, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`);
      (marketplaceRegistry as any)._agentsCache = null;
      return id;
    }
    let seq = 0;
    function queuedClaim(agentId: string, status = "pending_review"): string {
      const id = `b3a-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES (?, ?, 'Kari', ?, ?, 'no_known_email')`).run(id, agentId, `kari@${agentId}.example.test`, status);
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const linkRow = (claimId: string, action: string): any =>
      db.prepare("SELECT * FROM claim_action_links WHERE claim_id = ? AND action = ? ORDER BY rowid DESC").get(claimId, action);
    const linkActions = (claimId: string) =>
      (db.prepare("SELECT action FROM claim_action_links WHERE claim_id = ? ORDER BY action").all(claimId) as { action: string }[]).map((r) => r.action);
    const crmKinds = (claimId: string) =>
      (db.prepare("SELECT raw_metadata FROM crm_messages WHERE thread_id = ? AND direction = 'out' ORDER BY rowid").all(`claim-${claimId}`) as { raw_metadata: string }[])
        .map((r) => { try { return JSON.parse(r.raw_metadata).kind; } catch { return null; } });
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = () => JSON.stringify({
      agent_claims: all("agent_claims"), agents: all("agents"), claim_action_links: all("claim_action_links"),
      crm_messages: all("crm_messages"), crm_threads: all("crm_threads"),
    });
    const mintLink = (claimId: string, action: "request_more" | "approve"): string => {
      const r = cal.createClaimActionLinks(claimId, [action]);
      if (!r.ok) throw new Error(`mint ${claimId} ${action}: ${r.reason}`);
      return tokenOf(r.links[0].url);
    };
    const supportEmail = String(emailSvc.supportEmail);
    const SUBJECT = (n: string) => `Eierkravet ditt for ${n} – vi trenger litt mer`;
    const BODY = (n: string) => `Vi har fått eierkravet ditt for ${n}. Før vi kan godkjenne det, trenger vi litt mer for å bekrefte at du hører til gården, for eksempel en e-post fra gårdens egen adresse, en lenke der gården oppgir deg som kontakt, eller org.nr. og din rolle i foretaket. Svar på denne e-posten.`;

    // Notice helpers (as in the B1 suite).
    const textLink = (m: SentMail, label: string): string => (m.text.match(new RegExp(`^${label}: (\\S+)$`, "m")) ?? [])[1] ?? "";
    const stripTime = (s: string) => s.replace(/Tidspunkt:[^\n]*/g, "Tidspunkt:").replace(/(>Tidspunkt:<\/td><td[^>]*>)[^<]*/g, "$1");
    const { CLAIM_RECOMMENDATION_LABELS } = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
    const recommendationText = (r: string | null): string | undefined =>
      r ? `${r} — ${(CLAIM_RECOMMENDATION_LABELS as Record<string, string>)[r] ?? ""}`.replace(/ — $/, "") : undefined;
    async function rendered(claimId: string, links: { approve: string; reject: string } | undefined): Promise<SentMail> {
      const row = db.prepare(`SELECT c.agent_id, c.claimant_name, c.claimant_email, c.recommendation, a.name AS agent_name
                                FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`).get(claimId) as any;
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification(row.agent_name, row.agent_id, row.claimant_name, row.claimant_email,
        "profilen har ingen kjent e-postadresse", recommendationText(row.recommendation), links);
      return mails.splice(n, 1)[0];
    }
    const claimVia = (agentId: string) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body: { name: "Kari", email: `kari@${agentId}.example.test` } }));

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;
    process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
    process.env.CLAIM_ACTION_LINK_SECRET = SECRET;

    // ══ B3a.1 both flags on: three links ═════════════════════════════════
    {
      process.env.CLAIM_REQUEST_MORE_ENABLED = "true";
      agent("b31-on");
      const n0 = adminMails().length;
      startCapture();
      let r: { status: number; body: any };
      try { r = await claimVia("b31-on"); await flush(); } finally { stopCapture(); }
      eq([r.status, r.body?.data?.status], [202, "pending_review"], "B3a.1 on: the claim is queued");
      const claimId = r.body?.data?.claimId;
      eq(adminMails().length, n0 + 1, "B3a.1 on: exactly one admin notice");
      const notice = adminMails()[adminMails().length - 1];
      const approveUrl = textLink(notice, "Godkjenn");
      const rejectUrl = textLink(notice, "Avvis");
      const moreUrl = textLink(notice, "Be om mer bekreftelse");
      ok([approveUrl, rejectUrl, moreUrl].every((u) => u.startsWith("https://rettfrabonden.com/eierkrav/handling?t=")), "B3a.1 on: three links in the text part");
      eq(new Set([approveUrl, rejectUrl, moreUrl]).size, 3, "B3a.1 on: three different links");
      const im = cal.inspectClaimActionToken(tokenOf(moreUrl));
      eq([im.state, im.state === "valid" ? [im.ctx.claim_id, im.ctx.action] : null], ["valid", [claimId, "request_more"]], "B3a.1 on: «Be om mer bekreftelse» is a valid request_more link for this claim");
      eq(linkActions(claimId), ["approve", "reject", "request_more"], "B3a.1 on: three claim_action_links rows");
      ok(notice.html.includes(`href="${moreUrl}"`) && /href="[^"]+"[^>]*>Be om mer bekreftelse<\/a>/.test(notice.html), "B3a.1 on: third HTML button «Be om mer bekreftelse»");
      eq(mails.filter((m) => m.text.includes("/eierkrav/handling")).map((m) => m.to), [ADMIN_TO], "B3a.1 on: the links go only to the admin recipient");
      ok(!logged.some((l) => l.includes(tokenOf(moreUrl)) || l.includes("/eierkrav/handling")), "B3a.1 on: no token or link logged");
      // Removing the third line/button gives the two-link notice as rendered today.
      const two = await rendered(claimId, { approve: approveUrl, reject: rejectUrl });
      const textNoMore = notice.text.replace(/^Be om mer bekreftelse: \S+\n/m, "");
      const htmlNoMore = notice.html.replace(/<a href="[^"]+"[^>]*>Be om mer bekreftelse<\/a>/, "");
      eq([stripTime(textNoMore), stripTime(htmlNoMore), notice.subject], [stripTime(two.text), stripTime(two.html), two.subject],
        "B3a.1 on: the notice = today's two-link notice plus only the third link");
    }

    // ══ B3a.1 new flag off (and not exactly "true"): two links, today's notice ══
    for (const flag of [undefined, "TRUE", "1"]) {
      if (flag === undefined) delete process.env.CLAIM_REQUEST_MORE_ENABLED; else process.env.CLAIM_REQUEST_MORE_ENABLED = flag;
      const id = agent(`b31-off-${flag ?? "unset"}`);
      const n0 = adminMails().length;
      const r = await claimVia(id);
      await flush();
      const claimId = r.body?.data?.claimId;
      eq(adminMails().length, n0 + 1, `B3a.1 off (${flag ?? "unset"}): one notice`);
      const notice = adminMails()[adminMails().length - 1];
      ok(!notice.text.includes("Be om mer bekreftelse") && !notice.html.includes("Be om mer bekreftelse"), `B3a.1 off (${flag ?? "unset"}): no third link or button`);
      eq(linkActions(claimId), ["approve", "reject"], `B3a.1 off (${flag ?? "unset"}): two link rows, as before`);
      const today = await rendered(claimId, { approve: textLink(notice, "Godkjenn"), reject: textLink(notice, "Avvis") });
      eq([stripTime(notice.text), stripTime(notice.html), notice.subject], [stripTime(today.text), stripTime(today.html), today.subject],
        `B3a.1 off (${flag ?? "unset"}): notice byte-identical to today's rendering`);
    }
    // The renderer itself: no request_more key = today's block, byte for byte.
    {
      const L = { approve: "https://rettfrabonden.com/eierkrav/handling?t=a", reject: "https://rettfrabonden.com/eierkrav/handling?t=r" };
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification("Gård x", "x", "Kari", "k@x.example.test", "grunn", undefined, L);
      await emailSvc.sendAdminClaimReviewNotification("Gård x", "x", "Kari", "k@x.example.test", "grunn", undefined, { ...L, request_more: undefined });
      const [a, b] = mails.splice(n, 2);
      eq([stripTime(a.text), stripTime(a.html)], [stripTime(b.text), stripTime(b.html)], "B3a.1: request_more undefined renders as today");
      ok(a.text.includes("Godkjenn: https://rettfrabonden.com/eierkrav/handling?t=a\nAvvis: https://rettfrabonden.com/eierkrav/handling?t=r\nLenken åpner"),
        "B3a.1: today's text block unchanged");
    }

    // ══ mint: existing callers' default unchanged ═════════════════════════
    {
      delete process.env.CLAIM_REQUEST_MORE_ENABLED;
      const ag = agent("mint-a");
      const pending = queuedClaim(ag);
      const verified = queuedClaim(agent("mint-b"), "verified");
      eq(cal.actionsForStatus("pending_review"), ["approve", "reject"], "mint: flag off → pending_review default approve + reject");
      eq(cal.actionsForStatus("verified"), ["revoke"], "mint: verified default revoke");
      const d = await mint({ claimId: pending });
      eq(d.body?.links?.map((l: any) => l.action), ["approve", "reject"], "mint: admin mint default unchanged with flag off");
      const asked = await mint({ claimId: pending, actions: ["request_more"] });
      eq([asked.status, asked.body?.error], [503, "claim_request_more_disabled"], "mint: asking for request_more with flag off → 503");
      const svcAsked = cal.createClaimActionLinks(pending, ["approve", "request_more"]);
      eq([svcAsked.ok, svcAsked.ok ? null : svcAsked.reason], [false, "action_disabled"], "mint: service refuses request_more with flag off");
      eq(linkActions(pending), ["approve", "reject"], "mint: nothing extra minted with flag off");
      process.env.CLAIM_REQUEST_MORE_ENABLED = "true";
      eq(cal.actionsForStatus("verified"), ["revoke"], "mint: flag on → verified still revoke only (B2b-1)");
      const rev = cal.createClaimActionLinks(verified, ["revoke"]);
      eq(rev.ok ? rev.links.map((l) => l.action) : rev.reason, ["revoke"], "mint: explicit revoke (B2b-1 caller) unchanged");
      const ar = cal.createClaimActionLinks(pending, ["approve", "reject"]);
      eq(ar.ok ? ar.links.map((l) => l.action) : ar.reason, ["approve", "reject"], "mint: explicit approve + reject (B1 caller) unchanged");
      const dOn = await mint({ claimId: pending });
      eq(dOn.body?.links?.map((l: any) => l.action), ["approve", "reject", "request_more"], "mint: admin mint default includes request_more only with the flag on");
      const wrong = await mint({ claimId: verified, actions: ["request_more"] });
      eq([wrong.status, wrong.body?.error], [409, "action_not_valid_for_status"], "mint: request_more on a verified claim → 409");
      db.prepare("DELETE FROM claim_action_links").run();
    }

    // ══ B3a.2 link: GET writes nothing; POST once ═════════════════════════
    process.env.CLAIM_REQUEST_MORE_ENABLED = "true";
    process.env.CLAIM_CRM_TRACKING_ENABLED = "true";
    {
      const ag = agent("b32", "Ola's <Gård>");
      const claimId = queuedClaim(ag);
      const t = mintLink(claimId, "request_more");
      const before = snapshot();
      const n0 = mails.length;
      const g = await page(t);
      eq(g.status, 200, "B3a.2: GET → 200 confirmation page");
      ok(g.text.includes("Be om mer bekreftelse") && g.text.includes('method="post"'), "B3a.2: page names the choice and has a POST form");
      ok(g.text.includes("Ola&#039;s &lt;Gård&gt;"), "B3a.2: farm name escaped");
      await page(t);
      eq(snapshot(), before, "B3a.2: GET changed nothing");
      eq(mails.length, n0, "B3a.2: GET sent nothing");

      startCapture();
      let p: Resp;
      try { p = await submit(t); } finally { stopCapture(); }
      eq(p.status, 200, "B3a.2: POST → 200");
      ok(p.text.includes("Vi har bedt om mer bekreftelse"), "B3a.2: done page");
      const sent = mails.slice(n0);
      eq(sent.length, 1, "B3a.2: exactly one mail");
      const m = sent[0];
      eq(m?.to, `kari@${ag}.example.test`, "B3a.2: to the claim's e-mail");
      eq(m?.replyTo, supportEmail, "B3a.2: Reply-To = the support address the other claim mails use");
      eq(m?.subject, SUBJECT("Ola's <Gård>"), "B3a.2: subject");
      ok(m?.text.includes(BODY("Ola's <Gård>")) && m?.text.includes("Hilsen Daniel, "), "B3a.2: body text + usual sign-off");
      ok(!/https?:\/\//.test(m?.text ?? "") && !/href=/.test(m?.html ?? ""), "B3a.2: no links in the mail");
      ok((m?.html ?? "").includes("Ola&#039;s &lt;Gård&gt;"), "B3a.2: profile name escaped in HTML");
      eq(crmKinds(claimId), ["request_more"], "B3a.2: one CRM message kind request_more in claim-<id>");
      const c = claimRow(claimId);
      eq([c.status, c.request_more_via], ["pending_review", "action_link"], "B3a.2: claim stays pending_review; source action_link recorded");
      ok(typeof c.request_more_at === "string" && c.request_more_at.length > 0, "B3a.2: request_more_at stamped");
      const lr = linkRow(claimId, "request_more");
      ok(!!lr.used_at && lr.used_result === "requested_more", "B3a.2: the link is used up, result recorded");
      ok(!logged.some((l) => l.includes(`kari@${ag}`) || l.includes(t)), "B3a.2: neither the address nor the token is logged");

      const n1 = mails.length;
      const again = await submit(t);
      eq(again.status, 409, "B3a.2: second POST → 409");
      eq(mails.length, n1, "B3a.2: no mail on the second POST");
    }

    // ══ B3a.2 flag off: existing link executes nothing, not used up ═══════
    {
      const claimId = queuedClaim(agent("b32-off"));
      const t = mintLink(claimId, "request_more");
      delete process.env.CLAIM_REQUEST_MORE_ENABLED;
      const before = snapshot();
      const n0 = mails.length;
      const g = await page(t);
      ok(g.status === 503 && g.text.includes("Valget er ikke tilgjengelig"), "B3a.2 off: GET says the choice is not available");
      const p = await submit(t);
      ok(p.status === 503 && p.text.includes("Valget er ikke tilgjengelig"), "B3a.2 off: POST says the choice is not available");
      eq(snapshot(), before, "B3a.2 off: nothing written, link not used up");
      eq(mails.length, n0, "B3a.2 off: no mail");
      process.env.CLAIM_REQUEST_MORE_ENABLED = "true";
      eq((await submit(t)).status, 200, "B3a.2 off: the same link works once the flag is on (it was not used up)");
      // An approve link is not routed through request_more.
      const other = queuedClaim(agent("b32-appr"));
      const ta = mintLink(other, "approve");
      eq((await submit(ta)).status, 200, "B3a.2: approve links behave as before");
      eq(claimRow(other).status, "verified", "B3a.2: … and approve");
    }

    // ══ B3a.2 24 h rule shared with admin; failed send via link ═══════════
    {
      const claimId = queuedClaim(agent("b32-24h"));
      eq((await requestMore({ claimId })).status, 200, "B3a.2 24h: admin request first");
      const t = mintLink(claimId, "request_more");
      const n0 = mails.length;
      const p = await submit(t);
      eq(p.status, 409, "B3a.2 24h: link within 24 h → 409");
      ok(p.text.includes("Allerede bedt om mer bekreftelse"), "B3a.2 24h: explanatory page");
      eq(mails.length, n0, "B3a.2 24h: no mail");
      eq(linkRow(claimId, "request_more").used_at, null, "B3a.2 24h: link not used up");

      const c2 = queuedClaim(agent("b32-fail"));
      const t2 = mintLink(c2, "request_more");
      failSends = true;
      let pf: Resp;
      try { pf = await submit(t2); } finally { failSends = false; }
      eq(pf.status, 502, "B3a.2 fail: failed send → 502");
      eq([linkRow(c2, "request_more").used_at, claimRow(c2).request_more_at], [null, null], "B3a.2 fail: link not used up, nothing stamped");
      eq((await submit(t2)).status, 200, "B3a.2 fail: retry with the same link succeeds");
    }

    // ══ B3a.3 admin endpoint ══════════════════════════════════════════════
    {
      const ag = agent("b33");
      const claimId = queuedClaim(ag);
      eq((await requestMore({ claimId }, {})).status, 403, "B3a.3: no X-Admin-Key → 403");
      eq((await requestMore({ claimId }, { "X-Admin-Key": "nope" })).status, 403, "B3a.3: wrong key → 403");

      delete process.env.CLAIM_REQUEST_MORE_ENABLED;
      const n0 = mails.length;
      const off = await requestMore({ claimId });
      eq([off.status, off.body], [503, { success: false, error: "claim_request_more_disabled" }], "B3a.3: flag off → 503 claim_request_more_disabled");
      eq(mails.length, n0, "B3a.3: flag off → no mail");
      process.env.CLAIM_REQUEST_MORE_ENABLED = "true";

      eq((await requestMore({})).status, 400, "B3a.3: empty body → 400");
      eq((await requestMore({ claimId: 42 })).status, 400, "B3a.3: claimId not a string → 400");
      eq((await requestMore({ claimId, note: 7 })).status, 400, "B3a.3: note not a string → 400");
      eq((await requestMore({ claimId, note: "x".repeat(1001) })).status, 400, "B3a.3: note too long → 400");
      const unknown = await requestMore({ claimId: "no-such-claim" });
      eq([unknown.status, unknown.body?.error], [404, "not_found"], "B3a.3: unknown claim → 404");
      const verified = queuedClaim(agent("b33-v"), "verified");
      const nv = await requestMore({ claimId: verified });
      eq([nv.status, nv.body?.error], [409, "not_pending_review"], "B3a.3: not pending_review → 409");
      eq(mails.length, n0, "B3a.3: no mail on refusals");

      const okr = await requestMore({ claimId, note: "Fri e-post, ingen treff" });
      eq([okr.status, okr.body], [200, { success: true, claimId, email_sent: true }], "B3a.3: 200 { success, claimId, email_sent: true }");
      eq(mails.length, n0 + 1, "B3a.3: one mail");
      eq(mails[mails.length - 1].to, `kari@${ag}.example.test`, "B3a.3: to the claimant");
      ok(!mails[mails.length - 1].text.includes("Fri e-post, ingen treff"), "B3a.3: the admin note is not mailed");
      const c = claimRow(claimId);
      eq([c.status, c.request_more_via, c.request_more_note], ["pending_review", "admin", "Fri e-post, ingen treff"], "B3a.3: claim pending_review; source admin + note recorded");
      eq(crmKinds(claimId), ["request_more"], "B3a.3: CRM message kind request_more");

      const dup = await requestMore({ claimId });
      eq([dup.status, dup.body?.error], [409, "already_requested"], "B3a.3: within 24 h → 409 already_requested");
      eq(mails.length, n0 + 1, "B3a.3: no second mail");

      db.prepare("UPDATE agent_claims SET request_more_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), claimId);
      eq((await requestMore({ claimId })).status, 200, "B3a.3: after 24 h a new request is allowed");
    }

    // ══ B3a.3 mail-send failure ═══════════════════════════════════════════
    {
      const claimId = queuedClaim(agent("b33-fail"));
      failSends = true;
      let r: Resp;
      startCapture();
      try { r = await requestMore({ claimId }); } finally { failSends = false; stopCapture(); }
      eq([r.status, r.body?.error, r.body?.email_sent], [502, "email_send_failed", false], "B3a.3 fail: send failure → 502 email_send_failed, email_sent false");
      const c = claimRow(claimId);
      eq([c.status, c.request_more_at, c.request_more_via], ["pending_review", null, null], "B3a.3 fail: no 24 h marker recorded");
      ok(!logged.some((l) => l.includes("kari@b33-fail")), "B3a.3 fail: the address is not logged");
      const retry = await requestMore({ claimId });
      eq(retry.status, 200, "B3a.3 fail: a retry is not blocked by the window");
      // A previous (older) request is restored, not cleared, on a failed send.
      const old = new Date(Date.now() - 30 * 3600_000).toISOString();
      db.prepare("UPDATE agent_claims SET request_more_at = ?, request_more_via = 'action_link' WHERE id = ?").run(old, claimId);
      failSends = true;
      try { await requestMore({ claimId }); } finally { failSends = false; }
      eq([claimRow(claimId).request_more_at, claimRow(claimId).request_more_via], [old, "action_link"], "B3a.3 fail: the earlier stamp is put back");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    Object.assign(console, origConsole);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
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
  runRfbClaimRequestMoreB3aTests({ log: true }).then((s) => {
    console.log(`\nrfb-claim-request-more-b3a: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0); // the marketplace module keeps timers open
  });
}
