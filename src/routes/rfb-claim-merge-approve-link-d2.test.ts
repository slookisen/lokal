/**
 * rfb-claim-merge-approve-link-d2.test.ts — dev-request 2026-10-30-rfb-
 * eierkrav-automatisk-vurdering-og-ettklikk, SLICE D2: a signed «Slå sammen
 * med <søsken> og godkjenn» button (C4 action merge_approve, behind
 * CLAIM_MERGE_APPROVE_ENABLED) in the admin notice for a queued claim.
 *
 *   D2.1  all flags on + secret: a queued claim on a profile with two
 *         siblings (one owned) → exactly one merge_approve link (the unowned
 *         sibling) besides the other links, token bound to claim + sibling,
 *         claim_action_links.duplicate_id set; no sibling → none; D1 flag off
 *         (or a sibling lookup that throws) → none, notice byte-identical to
 *         today's. Mint defaults unchanged; merge_approve never a default.
 *   D2.2  GET writes nothing and sends nothing; POST merges + approves once
 *         (duplicate inactive + merged_into, claim verified, profile owned,
 *         one login mail, link used up); second POST 409, no new writes
 *   D2.3  tampered duplicate id (payload or row) → rejected; sibling got an
 *         owner / no longer a sibling / claim not queued → 409, nothing
 *         written, link not used up; D1 flag off at POST → nothing executed;
 *         approve after merge_approve → 409 and vice versa
 *
 * No network, no production DB: a fresh in-memory SQLite with the real schema,
 * the real routers on an in-process server, the real POST /agents/:id/claim
 * handler and a stub mail transporter.
 *
 * Exported runRfbClaimMergeApproveLinkD2Tests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-merge-approve-link-d2.test.ts
 */

import Database from "better-sqlite3";
import crypto from "crypto";
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
}

export async function runRfbClaimMergeApproveLinkD2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    "CLAIM_ACTION_LINKS_ENABLED", "CLAIM_REQUEST_MORE_ENABLED", "CLAIM_MERGE_APPROVE_ENABLED", "CLAIM_CRM_TRACKING_ENABLED",
    "CLAIM_DOMAIN_RULE_ENABLED", "CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_AUTO_APPROVE_ENABLED",
    "CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_KEY = "d2-test-admin-key";
  const ADMIN_TO = "admin@plattform.example.test";
  const SECRET = "d2-merge-approve-link-test-secret-0123456789abcdef";

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

  const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
  const origFindSiblings = knowledgeService.findClaimSiblingIds;

  // ── console capture (no token or link may be logged) ───────────────────
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

  // ── marketplace claim handler harness (as in the B1 / B3a suites) ──────
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
    delete require.cache[require.resolve("./marketplace")];
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const cal = require("../services/claim-action-link") as typeof import("../services/claim-action-link");
    const cma = require("../services/claim-merge-approve") as typeof import("../services/claim-merge-approve");
    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    {
      const app = express();
      app.use(express.json());
      app.use("/", calRoutes.default);
      app.use("/admin/agents/claim-action-links", calRoutes.claimActionAdminRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; body: any; text: string; headers: http.IncomingHttpHeaders };
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
            resolve({ status: resp.statusCode || 0, body: parsed, text: raw, headers: resp.headers });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const admin = { "X-Admin-Key": ADMIN_KEY };
    const mint = (body: unknown) => req("POST", "/admin/agents/claim-action-links", { headers: admin, body });
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") || "";
    const page = (t: string) => req("GET", `/eierkrav/handling?t=${encodeURIComponent(t)}`);
    const submit = (t: string) => req("POST", "/eierkrav/handling", { form: { t } });

    // ── fixtures ──────────────────────────────────────────────────────────
    // A profile whose registered address differs from the claimant's → the
    // claim goes to the admin queue. Siblings share the org.nr.
    interface AgentOpts { name?: string; orgNr?: string | null; claimedAt?: string | null; isActive?: number; knowledge?: Record<string, string | number | null> }
    function agent(id: string, o: AgentOpts = {}): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, org_nr, claimed_at, is_active)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery', ?, ?, ?)`)
        .run(id, o.name ?? `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`,
          o.orgNr ?? null, o.claimedAt ?? null, o.isActive ?? 1);
      if (o.knowledge) {
        const cols = Object.keys(o.knowledge);
        db.prepare(`INSERT INTO agent_knowledge (agent_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`)
          .run(id, ...cols.map((c) => o.knowledge![c]));
      }
      (marketplaceRegistry as any)._agentsCache = null;
      return id;
    }
    let seq = 0;
    function queuedClaim(agentId: string, status = "pending_review"): string {
      const id = `d2-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES (?, ?, 'Kari', ?, ?, 'no_known_email')`).run(id, agentId, `kari@${agentId}.example.test`, status);
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const agentRow = (id: string): any => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    const linkRow = (claimId: string, action: string): any =>
      db.prepare("SELECT * FROM claim_action_links WHERE claim_id = ? AND action = ? ORDER BY rowid DESC").get(claimId, action);
    const linkActions = (claimId: string) =>
      (db.prepare("SELECT action FROM claim_action_links WHERE claim_id = ? ORDER BY action").all(claimId) as { action: string }[]).map((r) => r.action);
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = () => JSON.stringify({
      agents: all("agents"), agent_claims: all("agent_claims"), claim_action_links: all("claim_action_links"),
      agent_knowledge: all("agent_knowledge"), agent_knowledge_audit: all("agent_knowledge_audit"), magic_links: all("magic_links"),
    });
    const mintLink = (claimId: string, action: "approve" | "merge_approve", duplicateId?: string): string => {
      const r = cal.createClaimActionLinks(claimId, [action], duplicateId ? { duplicateId } : {});
      if (!r.ok) throw new Error(`mint ${claimId} ${action}: ${r.reason}`);
      return tokenOf(r.links[0].url);
    };
    const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payloadOf = (t: string): any => JSON.parse(Buffer.from(t.split(".")[1], "base64").toString("utf8"));
    const resign = (payload: unknown): string => {
      const p = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
      const sig = b64url(crypto.createHmac("sha256", SECRET).update("rfb-claim-action:v1:" + p, "utf8").digest());
      return `v1.${p}.${sig}`;
    };

    // Notice helpers (as in the B1 / B3a suites).
    const textLink = (m: SentMail, label: string): string => (m.text.match(new RegExp(`^${label}: (\\S+)$`, "m")) ?? [])[1] ?? "";
    const mergeLines = (m: SentMail): string[] => m.text.split("\n").filter((l) => l.startsWith("Slå sammen med "));
    const stripTime = (s: string) => s.replace(/Tidspunkt:[^\n]*/g, "Tidspunkt:").replace(/(>Tidspunkt:<\/td><td[^>]*>)[^<]*/g, "$1");
    const { CLAIM_RECOMMENDATION_LABELS } = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
    const recommendationText = (r: string | null): string | undefined =>
      r ? `${r} — ${(CLAIM_RECOMMENDATION_LABELS as Record<string, string>)[r] ?? ""}`.replace(/ — $/, "") : undefined;
    // Today's rendering of the same claim (the «Grunn» label is the notice's own).
    async function rendered(claimId: string, links: { approve: string; reject: string } | undefined, like: SentMail): Promise<SentMail> {
      const row = db.prepare(`SELECT c.agent_id, c.claimant_name, c.claimant_email, c.recommendation, a.name AS agent_name
                                FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`).get(claimId) as any;
      const reason = (like.text.match(/^Grunn: (.*)$/m) ?? [])[1] ?? "";
      const n = mails.length;
      await emailSvc.sendAdminClaimReviewNotification(row.agent_name, row.agent_id, row.claimant_name, row.claimant_email,
        reason, recommendationText(row.recommendation), links);
      return mails.splice(n, 1)[0];
    }
    const claimVia = (agentId: string) =>
      invoke(claimH, makeReq({ params: { id: agentId }, body: { name: "Kari", email: `kari@${agentId}.example.test` } }));
    async function noticeFor(agentId: string): Promise<{ claimId: string; notice: SentMail; status: number }> {
      const n0 = adminMails().length;
      const r = await claimVia(agentId);
      await flush();
      const claimId = r.body?.data?.claimId;
      eq(adminMails().length, n0 + 1, `notice for ${agentId}: exactly one admin notice`);
      return { claimId, notice: adminMails()[adminMails().length - 1], status: r.status };
    }

    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;
    process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
    process.env.CLAIM_ACTION_LINK_SECRET = SECRET;

    // ══ D2.1 all flags on: one merge_approve link for the unowned sibling ══
    {
      process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
      const surv = agent("d21-surv", { orgNr: "921000001" });
      const sib = agent("d21-sib", { orgNr: "921000001", name: "Søsken <A> & co" });
      agent("d21-owned", { orgNr: "921000001", claimedAt: "2026-09-01T00:00:00Z" });
      agent("d21-inactive", { orgNr: "921000001", isActive: 0 });
      startCapture();
      let res: { claimId: string; notice: SentMail; status: number };
      try { res = await noticeFor(surv); } finally { stopCapture(); }
      const { claimId, notice } = res;
      eq(res.status, 202, "D2.1 on: the claim is queued");
      const lines = mergeLines(notice);
      eq(lines.length, 1, "D2.1 on: exactly one merge_approve text line (owned + inactive siblings left out)");
      const mergeUrl = textLink(notice, "Slå sammen med Søsken <A> & co og godkjenn");
      ok(mergeUrl.startsWith("https://rettfrabonden.com/eierkrav/handling?t="), "D2.1 on: the line names the sibling and carries a signed link");
      const approveUrl = textLink(notice, "Godkjenn");
      const rejectUrl = textLink(notice, "Avvis");
      ok(!!approveUrl && !!rejectUrl && new Set([approveUrl, rejectUrl, mergeUrl]).size === 3, "D2.1 on: approve + reject links next to it");
      const im = cal.inspectClaimActionToken(tokenOf(mergeUrl));
      eq([im.state, im.state === "valid" ? [im.ctx.claim_id, im.ctx.action, im.ctx.duplicate_id] : null],
        ["valid", [claimId, "merge_approve", sib]], "D2.1 on: inspect → this claim, merge_approve, the unowned sibling");
      eq(payloadOf(tokenOf(mergeUrl)).d, sib, "D2.1 on: the sibling id is in the signed payload");
      eq(linkRow(claimId, "merge_approve")?.duplicate_id, sib, "D2.1 on: claim_action_links row has duplicate_id");
      eq([linkRow(claimId, "approve")?.duplicate_id, linkRow(claimId, "reject")?.duplicate_id], [null, null], "D2.1 on: other links have no duplicate_id");
      eq(linkActions(claimId), ["approve", "merge_approve", "reject"], "D2.1 on: three link rows");
      ok(notice.html.includes(`href="${mergeUrl.replace(/&/g, "&amp;")}"`) || notice.html.includes(`href="${mergeUrl}"`), "D2.1 on: HTML button links the same URL");
      ok(notice.html.includes(">Slå sammen med Søsken &lt;A&gt; &amp; co og godkjenn</a>"), "D2.1 on: HTML button with the sibling name escaped");
      ok(!notice.html.includes("Søsken <A>"), "D2.1 on: raw sibling name never in the HTML");
      eq(mails.filter((m) => m.text.includes("/eierkrav/handling")).map((m) => m.to), [ADMIN_TO], "D2.1 on: the links go only to the admin recipient");
      ok(!logged.some((l) => l.includes(tokenOf(mergeUrl)) || l.includes("/eierkrav/handling")), "D2.1 on: no token or link logged");
      // Without the merge line/button the notice is today's two-link notice.
      const two = await rendered(claimId, { approve: approveUrl, reject: rejectUrl }, notice);
      const textNo = notice.text.replace(/^Slå sammen med .*\n/m, "");
      const htmlNo = notice.html.replace(/<a href="[^"]+"[^>]*>Slå sammen med [^<]*<\/a>/, "");
      eq([stripTime(textNo), stripTime(htmlNo), notice.subject], [stripTime(two.text), stripTime(two.html), two.subject],
        "D2.1 on: the notice = today's notice plus only the merge button");
    }

    // ══ D2.1 with request_more on: all four kinds together ════════════════
    {
      process.env.CLAIM_REQUEST_MORE_ENABLED = "true";
      const surv = agent("d21-four", { orgNr: "921000004" });
      agent("d21-four-sib", { orgNr: "921000004" });
      const { claimId, notice } = await noticeFor(surv);
      eq(linkActions(claimId), ["approve", "merge_approve", "reject", "request_more"], "D2.1 four: four link rows");
      ok(/Be om mer bekreftelse: \S+\nSlå sammen med Gård d21-four-sib og godkjenn: \S+\nLenken åpner/.test(notice.text),
        "D2.1 four: merge line after «Be om mer bekreftelse», before the note");
      delete process.env.CLAIM_REQUEST_MORE_ENABLED;
    }

    // ══ D2.1 at most 3, sorted by id ══════════════════════════════════════
    {
      const surv = agent("d21-many", { orgNr: "921000005" });
      for (const s of ["e", "c", "a", "d", "b"]) agent(`d21-many-${s}`, { orgNr: "921000005" });
      eq(cma.mergeApproveCandidates(surv).map((c) => c.id), ["d21-many-a", "d21-many-b", "d21-many-c"], "D2.1 max: at most 3 candidates, sorted by id");
      const { claimId, notice } = await noticeFor(surv);
      eq(mergeLines(notice).length, 3, "D2.1 max: three merge lines in the notice");
      eq((db.prepare("SELECT duplicate_id FROM claim_action_links WHERE claim_id = ? AND action = 'merge_approve' ORDER BY rowid").all(claimId) as any[]).map((r) => r.duplicate_id),
        ["d21-many-a", "d21-many-b", "d21-many-c"], "D2.1 max: rows for the same three");
    }

    // ══ D2.1 no siblings: no merge_approve link ═══════════════════════════
    {
      const surv = agent("d21-alone", { orgNr: "921000002" });
      const { claimId, notice } = await noticeFor(surv);
      eq(mergeLines(notice).length, 0, "D2.1 alone: no merge line");
      ok(!notice.html.includes("Slå sammen"), "D2.1 alone: no merge button");
      eq(linkActions(claimId), ["approve", "reject"], "D2.1 alone: two link rows");
      const today = await rendered(claimId, { approve: textLink(notice, "Godkjenn"), reject: textLink(notice, "Avvis") }, notice);
      eq([stripTime(notice.text), stripTime(notice.html)], [stripTime(today.text), stripTime(today.html)], "D2.1 alone: notice as today");
    }

    // ══ D2.1 D1 flag off (or not exactly "true"): today's notice ══════════
    for (const flag of [undefined, "TRUE", "1"]) {
      if (flag === undefined) delete process.env.CLAIM_MERGE_APPROVE_ENABLED; else process.env.CLAIM_MERGE_APPROVE_ENABLED = flag;
      const surv = agent(`d21-off-${flag ?? "unset"}`, { orgNr: "921000003" });
      if (flag === undefined) agent("d21-off-sib", { orgNr: "921000003" });
      const { claimId, notice } = await noticeFor(surv);
      eq(mergeLines(notice).length, 0, `D2.1 off (${flag ?? "unset"}): no merge line`);
      eq(linkActions(claimId), ["approve", "reject"], `D2.1 off (${flag ?? "unset"}): two link rows, as before`);
      const today = await rendered(claimId, { approve: textLink(notice, "Godkjenn"), reject: textLink(notice, "Avvis") }, notice);
      eq([stripTime(notice.text), stripTime(notice.html), notice.subject], [stripTime(today.text), stripTime(today.html), today.subject],
        `D2.1 off (${flag ?? "unset"}): notice byte-identical to today's rendering`);
    }

    // ══ D2.1 sibling lookup throws: today's notice, nothing minted ════════
    {
      process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
      const surv = agent("d21-throw", { orgNr: "921000006" });
      agent("d21-throw-sib", { orgNr: "921000006" });
      (knowledgeService as any).findClaimSiblingIds = () => { throw new Error("boom"); };
      let res: { claimId: string; notice: SentMail; status: number };
      startCapture();
      try { res = await noticeFor(surv); } finally { (knowledgeService as any).findClaimSiblingIds = origFindSiblings; stopCapture(); }
      const { claimId, notice } = res;
      eq(linkActions(claimId), ["approve", "reject"], "D2.1 throw: no merge_approve row");
      const today = await rendered(claimId, { approve: textLink(notice, "Godkjenn"), reject: textLink(notice, "Avvis") }, notice);
      eq([stripTime(notice.text), stripTime(notice.html)], [stripTime(today.text), stripTime(today.html)], "D2.1 throw: notice byte-identical to today's");
    }

    // ══ D2.1 mint: defaults unchanged, merge_approve only with a sibling id ══
    {
      const surv = agent("d21-mint", { orgNr: "921000007" });
      const sib = agent("d21-mint-sib", { orgNr: "921000007" });
      const claimId = queuedClaim(surv);
      eq(cal.actionsForStatus("pending_review"), ["approve", "reject"], "D2.1 mint: merge flag on → default still approve + reject");
      const d = await mint({ claimId });
      eq(d.body?.links?.map((l: any) => l.action), ["approve", "reject"], "D2.1 mint: admin default never includes merge_approve");
      const asked = await mint({ claimId, actions: ["merge_approve"] });
      eq([asked.status, asked.body?.error], [400, "merge_approve_needs_duplicate"], "D2.1 mint: admin asks for merge_approve → 400");
      const svcNo = cal.createClaimActionLinks(claimId, ["merge_approve"]);
      eq(svcNo.ok ? null : svcNo.reason, "duplicate_required", "D2.1 mint: service refuses merge_approve without a sibling id");
      const svcMixed = cal.createClaimActionLinks(claimId, ["approve", "merge_approve"], { duplicateId: sib });
      eq(svcMixed.ok ? null : svcMixed.reason, "duplicate_required", "D2.1 mint: merge_approve is minted alone");
      const svcDupOnly = cal.createClaimActionLinks(claimId, ["approve"], { duplicateId: sib });
      eq(svcDupOnly.ok ? null : svcDupOnly.reason, "duplicate_required", "D2.1 mint: a sibling id without merge_approve is refused");
      delete process.env.CLAIM_MERGE_APPROVE_ENABLED;
      const off = cal.createClaimActionLinks(claimId, ["merge_approve"], { duplicateId: sib });
      eq(off.ok ? null : off.reason, "action_disabled", "D2.1 mint: D1 flag off → merge_approve not minted");
      process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
      const verified = queuedClaim(agent("d21-mint-v", { orgNr: "921000007" }), "verified");
      const wrong = cal.createClaimActionLinks(verified, ["merge_approve"], { duplicateId: sib });
      eq(wrong.ok ? null : wrong.reason, "action_not_valid_for_status", "D2.1 mint: merge_approve needs pending_review");
      eq(linkActions(claimId), ["approve", "reject"], "D2.1 mint: no merge_approve row from the refusals");
    }

    // ══ D2.2 GET writes nothing; POST merges + approves once ══════════════
    process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
    {
      const surv = agent("d22-surv", { orgNr: "922000001", name: "Ola's <Gård>", knowledge: { phone: "+47 900 00 001" } });
      const sib = agent("d22-sib", { orgNr: "922000001", name: "Søsken \"B\"", knowledge: { address: "Gardsvegen 3", postal_code: "3570", email: "post@d22-sib.example.test" } });
      const claimId = queuedClaim(surv);
      const t = mintLink(claimId, "merge_approve", sib);
      const before = snapshot();
      const n0 = mails.length;
      const g = await page(t);
      eq(g.status, 200, "D2.2: GET → 200 confirmation page");
      ok(g.text.includes("Ola&#039;s &lt;Gård&gt;") && g.text.includes("Søsken &quot;B&quot;"), "D2.2: page shows survivor + sibling, escaped");
      ok(!g.text.includes("Ola's <Gård>") && !g.text.includes("Søsken \"B\""), "D2.2: no raw names on the page");
      ok(g.text.includes("fyller bare tomme felt") && g.text.includes("deaktiverer søskenprofilen") && g.text.includes("godkjenner så eierkravet"),
        "D2.2: page explains fill-only, deactivation, then approval");
      ok(g.text.includes("Felt som blir fylt: address, postal_code, email"), "D2.2: D1 dry-run summary on the page");
      ok(g.text.includes('method="post"') && g.text.includes("Slå sammen og godkjenn"), "D2.2: POST form with the button");
      eq([g.headers["cache-control"], g.headers["x-robots-tag"], g.headers["referrer-policy"]], ["no-store", "noindex", "no-referrer"], "D2.2: C4 headers");
      await page(t);
      eq(snapshot(), before, "D2.2: GET changed nothing in agents, agent_claims, claim_action_links, audit");
      eq(mails.length, n0, "D2.2: GET sent nothing");

      startCapture();
      let p: Resp;
      try { p = await submit(t); } finally { stopCapture(); }
      eq(p.status, 200, "D2.2: POST → 200");
      ok(p.text.includes("Profilene er slått sammen og eierkravet er godkjent") && p.text.includes("Søsken &quot;B&quot;"), "D2.2: done page");
      const d = agentRow(sib);
      eq([d.is_active, d.merged_into], [0, surv], "D2.2: duplicate is_active 0 + merged_into the survivor");
      const c = claimRow(claimId);
      eq(c.status, "verified", "D2.2: claim approved");
      const a = agentRow(surv);
      eq([!!a.claimed_at, a.claimed_via], [true, "admin_approval"], "D2.2: profile owned by the claimant");
      const k = db.prepare("SELECT phone, address, postal_code, email FROM agent_knowledge WHERE agent_id = ?").get(surv) as any;
      eq([k.phone, k.address, k.postal_code, k.email], ["+47 900 00 001", "Gardsvegen 3", "3570", "post@d22-sib.example.test"], "D2.2: blank fields filled, set field kept");
      const mergeAudit = db.prepare("SELECT notes FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'merge'").get(sib) as any;
      ok(String(mergeAudit?.notes).includes("claim-merge-approve via action_link claim " + claimId), "D2.2: audit carries source action_link");
      const sent = mails.slice(n0);
      eq(sent.map((m) => m.to), [`kari@${surv}.example.test`], "D2.2: exactly one mail — the login mail to the claimant");
      const lr = linkRow(claimId, "merge_approve");
      ok(!!lr.used_at && lr.used_result === "merged_approved", "D2.2: link used up, result recorded");
      ok(logged.some((l) => l.includes("merge_approve performed") && l.includes("source action_link")), "D2.2: logged with source action_link");
      // The mail transport's own "[Email] sent" line is shared with every
      // claim mail (as in the D1 suite); this route's lines carry neither.
      ok(!logged.some((l) => l.includes(t)) && !logged.some((l) => l.startsWith("[claim-action-link]") && l.includes(`kari@${surv}`)),
        "D2.2: neither token nor claimant address in the route's log");

      const after = snapshot();
      const n1 = mails.length;
      const again = await submit(t);
      eq(again.status, 409, "D2.2: second POST → 409");
      eq(snapshot(), after, "D2.2: second POST wrote nothing");
      eq(mails.length, n1, "D2.2: no mail on the second POST");
    }

    // ══ D2.3 tampered duplicate id ════════════════════════════════════════
    {
      const surv = agent("d23-t-surv", { orgNr: "923000001" });
      const sib = agent("d23-t-sib", { orgNr: "923000001" });
      const other = agent("d23-t-other", { orgNr: "923000001" });
      const claimId = queuedClaim(surv);
      const t = mintLink(claimId, "merge_approve", sib);
      const p0 = payloadOf(t);
      const before = snapshot();
      // payload changed, old signature
      const parts = t.split(".");
      const forgedPayload = b64url(Buffer.from(JSON.stringify({ ...p0, d: other }), "utf8"));
      const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
      eq([(await page(forged)).status, (await submit(forged)).status], [404, 404], "D2.3 tamper: payload d changed (bad signature) → 404");
      // payload changed and validly signed: disagrees with the row
      const resigned = resign({ ...p0, d: other });
      eq(cal.inspectClaimActionToken(resigned).state, "invalid", "D2.3 tamper: signed d ≠ row duplicate_id → invalid");
      eq([(await page(resigned)).status, (await submit(resigned)).status], [404, 404], "D2.3 tamper: signed d ≠ row → 404 GET + POST");
      const noD = (() => { const { d: _d, ...rest } = p0; return resign(rest); })();
      eq(cal.inspectClaimActionToken(noD).state, "invalid", "D2.3 tamper: merge_approve without d → invalid");
      const approveWithD = resign({ ...p0, a: "approve" });
      eq(cal.inspectClaimActionToken(approveWithD).state, "invalid", "D2.3 tamper: d on another action → invalid");
      eq(snapshot(), before, "D2.3 tamper: nothing written by payload tampering");
      // the row changed
      db.prepare("UPDATE claim_action_links SET duplicate_id = ? WHERE claim_id = ? AND action = 'merge_approve'").run(other, claimId);
      const beforeRow = snapshot();
      eq([(await page(t)).status, (await submit(t)).status], [404, 404], "D2.3 tamper: row duplicate_id changed → 404 GET + POST");
      eq(snapshot(), beforeRow, "D2.3 tamper: nothing written, link not used up");
      eq([agentRow(other).is_active, agentRow(sib).is_active, claimRow(claimId).status], [1, 1, "pending_review"], "D2.3 tamper: no merge, no approval");
      db.prepare("UPDATE claim_action_links SET duplicate_id = ? WHERE claim_id = ? AND action = 'merge_approve'").run(sib, claimId);
      eq(cal.inspectClaimActionToken(t).state, "valid", "D2.3 tamper: the genuine link is still valid once the row is restored");
    }

    // ══ D2.3 D1 checks at POST: 409, nothing written, link not used up ════
    {
      const surv = agent("d23-c-surv", { orgNr: "923000002" });
      const sib = agent("d23-c-sib", { orgNr: "923000002", knowledge: { address: "Vegen 1", postal_code: "1234" } });
      const claimId = queuedClaim(surv);
      const t = mintLink(claimId, "merge_approve", sib);
      const n0 = mails.length;

      // sibling got an owner
      db.prepare("UPDATE agents SET claimed_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(sib);
      let before = snapshot();
      let p = await submit(t);
      ok(p.status === 409 && p.text.includes("duplicate_claimed"), "D2.3: sibling got an owner → 409 duplicate_claimed");
      eq(snapshot(), before, "D2.3: duplicate_claimed → nothing written, link not used up");
      db.prepare("UPDATE agents SET claimed_at = NULL WHERE id = ?").run(sib);

      // no longer a sibling
      db.prepare("UPDATE agents SET org_nr = '999999999' WHERE id = ?").run(sib);
      before = snapshot();
      p = await submit(t);
      ok(p.status === 409 && p.text.includes("not_a_sibling"), "D2.3: no longer a sibling → 409 not_a_sibling");
      eq(snapshot(), before, "D2.3: not_a_sibling → nothing written, link not used up");
      db.prepare("UPDATE agents SET org_nr = '923000002' WHERE id = ?").run(sib);

      // sibling inactive
      db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(sib);
      before = snapshot();
      p = await submit(t);
      ok(p.status === 409 && p.text.includes("duplicate_inactive"), "D2.3: inactive sibling → 409 duplicate_inactive");
      eq(snapshot(), before, "D2.3: duplicate_inactive → nothing written");
      db.prepare("UPDATE agents SET is_active = 1 WHERE id = ?").run(sib);

      // claim no longer queued
      db.prepare("UPDATE agent_claims SET status = 'rejected' WHERE id = ?").run(claimId);
      before = snapshot();
      eq((await page(t)).status, 409, "D2.3: claim not queued → GET 409");
      eq((await submit(t)).status, 409, "D2.3: claim not queued → POST 409");
      eq(snapshot(), before, "D2.3: not queued → nothing written, link not used up");
      db.prepare("UPDATE agent_claims SET status = 'pending_review' WHERE id = ?").run(claimId);

      // D1 flag off at POST
      delete process.env.CLAIM_MERGE_APPROVE_ENABLED;
      before = snapshot();
      const g = await page(t);
      ok(g.status === 503 && g.text.includes("Valget er ikke tilgjengelig"), "D2.3 off: GET says the choice is not available");
      const po = await submit(t);
      ok(po.status === 503 && po.text.includes("Valget er ikke tilgjengelig"), "D2.3 off: POST says the choice is not available");
      const direct = cma.redeemClaimMergeApproveLink(t);
      eq(direct.ok ? null : direct.error, "disabled", "D2.3 off: the service executes nothing");
      eq(snapshot(), before, "D2.3 off: nothing written, link not used up");
      process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
      eq(mails.length, n0, "D2.3: no mail from any refusal");

      // the C4 redeemer never runs merge_approve
      const viaC4 = cal.redeemClaimActionLink(t);
      eq(viaC4.state, "wrong_state", "D2.3: redeemClaimActionLink refuses merge_approve");
      eq(linkRow(claimId, "merge_approve").used_at, null, "D2.3: … without using it up");

      // after all refusals the same link still works once
      eq((await submit(t)).status, 200, "D2.3: the link was never used up — it works once the checks pass");
      eq([agentRow(sib).is_active, claimRow(claimId).status], [0, "verified"], "D2.3: … merged and approved");
    }

    // ══ D2.3 approve vs merge_approve on the same claim ═══════════════════
    {
      // merge_approve first, then approve → 409
      const s1 = agent("d23-x1-surv", { orgNr: "923000003" });
      const d1 = agent("d23-x1-sib", { orgNr: "923000003" });
      const c1 = queuedClaim(s1);
      const tm1 = mintLink(c1, "merge_approve", d1);
      const ta1 = mintLink(c1, "approve");
      eq((await submit(tm1)).status, 200, "D2.3 x: merge_approve first → 200");
      let before = snapshot();
      eq((await submit(ta1)).status, 409, "D2.3 x: approve after merge_approve → 409");
      eq(snapshot(), before, "D2.3 x: nothing written by the approve link");

      // approve first, then merge_approve → 409
      const s2 = agent("d23-x2-surv", { orgNr: "923000004" });
      const d2 = agent("d23-x2-sib", { orgNr: "923000004" });
      const c2 = queuedClaim(s2);
      const tm2 = mintLink(c2, "merge_approve", d2);
      const ta2 = mintLink(c2, "approve");
      eq((await submit(ta2)).status, 200, "D2.3 x: approve first → 200");
      before = snapshot();
      eq((await submit(tm2)).status, 409, "D2.3 x: merge_approve after approve → 409");
      eq(snapshot(), before, "D2.3 x: nothing written by the merge_approve link");
      eq(agentRow(d2).is_active, 1, "D2.3 x: the sibling was not merged");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    Object.assign(console, origConsole);
    (knowledgeService as any).findClaimSiblingIds = origFindSiblings;
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
  runRfbClaimMergeApproveLinkD2Tests({ log: true }).then((s) => {
    console.log(`\nrfb-claim-merge-approve-link-d2: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0); // the marketplace module keeps timers open
  });
}
