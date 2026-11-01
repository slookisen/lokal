/**
 * rfb-claim-k5-gratulerer.test.ts — dev-request 2026-11-01-rfb-kravflyt-tal-
 * eiere-fra-e-post, slice K5 (text and login fix approved by Daniel 2026-11-01).
 *
 * The mail an owner gets when Daniel approves a claim by hand
 * (POST /admin/agents/claim-review-approve) said «Gratulerer! … Din agent er
 * klar» and carried a 15-minute /selger marketplace link. These owners were
 * often approved because the address on the profile was wrong, and the /eier
 * login (request-magic-link) only accepted agent_knowledge.email — which
 * approval never changes — so the owner portal was a dead end for them.
 *
 *   (mail)   exact subject, text and HTML of «Profilen til X er nå din»; every
 *            interpolated value escaped (a name with < > & "); the <host>/eier/
 *            <id> address from APP_URL (no scheme, trailing slash, encoded id).
 *   (appr)   approval mails ONE one-time 15-minute /magic-link-verify link for
 *            the approved address and this agent ("mlclaim_" row), masked
 *            sentTo, never the claim token, not the /selger link.
 *   (verify) the link gives a fresh 7-day session (not the mailed token) that
 *            opens /eier/:id/portal for an owner whose address differs from
 *            agent_knowledge.email — gate off and on; the link works once; an
 *            unused or expired link is no session.
 *   (login)  request-magic-link accepts the verified claimant's address
 *            (normalized) and still agent_knowledge.email; refuses an unrelated
 *            address, a pending_review / code_sent / rejected claim's address
 *            and a verified claimant of ANOTHER agent with the same 404 body.
 *   (rate)   the approval is not held by the visitor limit; its link counts
 *            toward that limit, which still holds for visitors.
 *   (owner)  an existing owner is not mailed and keeps its claim and login.
 *
 * Fresh in-memory SQLite with the real schema, an in-process server with the
 * real owner-portal and admin-agents routers, a stub transporter on the
 * emailService singleton (nothing leaves the process). Every global it touches
 * (getDb() singleton, env, transporter, require cache) is restored in finally.
 *
 * Exported runRfbClaimK5GratulererTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-k5-gratulerer.test.ts
 */

import Database from "better-sqlite3";
import * as http from "http";

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

export async function runRfbClaimK5GratulererTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["APP_URL", "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const ADMIN = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "rfb-claim-k5-standalone-key";

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  let server: http.Server | null = null;

  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.APP_URL = "https://rettfrabonden.com";
    process.env.ADMIN_KEY = ADMIN;
    emailSvc.isConfigured = true;
    emailSvc.transporter = {
      sendMail: async (m: Record<string, any>) => {
        mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? ""), html: String(m.html ?? "") });
        return { messageId: `stub-${mails.length}` };
      },
    };

    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./admin-agents")];
    const adminAgentsRouter = require("./admin-agents").default as any;
    const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
    const { maskEmail } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
    {
      const express = require("express");
      const app = express();
      app.use(express.json());
      app.use("/admin/agents", adminAgentsRouter);
      app.use("/", ownerPortal.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; text: string; json: any; location: string | undefined; setCookie: string[] };
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Resp> {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        const bodyStr = o.json !== undefined ? JSON.stringify(o.json) : undefined;
        if (bodyStr !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(bodyStr)); }
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* html */ }
            const sc = resp.headers["set-cookie"];
            resolve({ status: resp.statusCode || 0, text, json, location: resp.headers["location"] as string | undefined, setCookie: Array.isArray(sc) ? sc : sc ? [String(sc)] : [] });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const sessionFrom = (r: Resp): string => {
      for (const c of r.setCookie) {
        const m = /^rfb_owner_session=([^;]+)/.exec(c);
        if (m && m[1]) return m[1];
      }
      return "";
    };
    const approve = (claimId: string, email?: string) =>
      req("POST", "/admin/agents/claim-review-approve", { headers: { "X-Admin-Key": ADMIN }, json: email === undefined ? { claimId } : { claimId, email } });
    const requestLink = (agentId: string, email: string) => req("POST", `/api/agents/${encodeURIComponent(agentId)}/request-magic-link`, { json: { email } });
    const portal = (agentId: string, token: string, how: "cookie" | "bearer" = "cookie") =>
      req("GET", `/eier/${encodeURIComponent(agentId)}/portal`, { headers: how === "cookie" ? { Cookie: `rfb_owner_session=${token}` } : { Authorization: `Bearer ${token}` } });
    const tokenIn = (text: string): string => (text.match(/\/magic-link-verify\?token=([0-9a-f]{64})/) ?? [])[1] ?? "";
    const linkRow = (token: string): any => db.prepare("SELECT * FROM magic_links WHERE token = ?").get(token);
    const linkCount = (agentId: string): number => (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = ?").get(agentId) as { n: number }).n;
    const isExpired = (token: string): boolean =>
      (db.prepare("SELECT datetime(expires_at) <= datetime('now') AS x FROM magic_links WHERE token = ?").get(token) as { x: number } | undefined)?.x === 1;

    // ── fixtures ────────────────────────────────────────────────────────
    const NAME = `Gård <K5> & "Søn"`;
    function agent(id: string, name: string, listed: string | null, o: { claimedAt?: string } = {}): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, claimed_at)
                  VALUES (?, ?, 'Testprodusent', 'test', ?, 'https://example.test', 'producer', ?, '["vegetables"]', ?)`)
        .run(id, name, `registrert@${id}.example.test`, `k-${id}`, o.claimedAt ?? null);
      if (listed !== null) db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run(id, listed);
    }
    let claimSeq = 0;
    function claim(agentId: string, email: string, status: string, o: { reason?: string; token?: string } = {}): string {
      const id = `k5-claim-${++claimSeq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason, claim_token, claim_token_expires_at, verified_at)
                  VALUES (?, ?, 'Eier', ?, ?, ?, ?, ?, ?)`)
        .run(id, agentId, email, status, o.reason ?? null, o.token ?? null,
          o.token ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null, status === "verified" ? new Date().toISOString() : null);
      return id;
    }
    const APPROVED = "kari@k5-bekreftet.example.test";
    agent("k5-a", NAME, "post@k5-a.example.test"); // the profile's address — the wrong one
    const claimA = claim("k5-a", "kari@k5-typed.example.test", "pending_review", { reason: "listed_email_wrong" });

    // ══ (mail) the text, exactly ═════════════════════════════════════════
    {
      const svc = emailSvc as import("../services/email-service").EmailService;
      const LOGIN = "https://rettfrabonden.com/magic-link-verify?token=abc&x=<1>";
      const before = mails.length;
      await svc.sendClaimConfirmation("eier@example.test", NAME, LOGIN, "k5-a");
      const m = mails[mails.length - 1]!;
      eq(mails.length, before + 1, "mail: one mail");
      eq(m.subject, `Profilen til ${NAME} er nå din på Rett fra Bonden`, "mail: subject is the approved one");
      eq(m.text.trim(), [
        "Hei!",
        "",
        `Profilen til ${NAME} er nå koblet til deg, og du kan endre den selv når du vil.`,
        "",
        "I eierportalen kan du:",
        "- rette varer, åpningstider og kontaktinfo",
        "- se hvor ofte profilen blir vist og besøkt",
        "- velge om du vil få bestillinger fra kunder på e-post",
        "",
        "Logg inn i eierportalen:",
        LOGIN,
        "",
        "Lenken virker i 15 minutter. Senere logger du inn på rettfrabonden.com/eier/k5-a med denne e-postadressen.",
        "",
        "Har du spørsmål, svarer du bare på denne e-posten.",
        "",
        "Hilsen Daniel, Rett fra Bonden",
      ].join("\n"), "mail: the text part is exactly the approved text");

      const body = (m.html.match(/<body>([\s\S]*)<\/body>/) ?? [])[1] ?? "";
      const visible = body.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&")
        .replace(/\s+/g, " ").trim();
      eq(visible, `🌾 Rett fra Bonden Hei! Profilen til ${NAME} er nå koblet til deg, og du kan endre den selv når du vil. I eierportalen kan du: ` +
        "rette varer, åpningstider og kontaktinfo se hvor ofte profilen blir vist og besøkt velge om du vil få bestillinger fra kunder på e-post " +
        "Logg inn i eierportalen Lenken virker i 15 minutter. Senere logger du inn på rettfrabonden.com/eier/k5-a med denne e-postadressen. " +
        "Har du spørsmål, svarer du bare på denne e-posten. Hilsen Daniel, Rett fra Bonden", "mail: the HTML reads exactly the approved text");
      ok(m.html.includes("<strong>Gård &lt;K5&gt; &amp; &quot;Søn&quot;</strong>") && !m.html.includes("<K5>") && !m.html.includes(`"Søn"`),
        "mail: the name is escaped in the HTML");
      const button = /<td\b[^>]*>\s*<a href="([^"]*)"[^>]*><span style="color:#ffffff;">([^<]*)<\/span><\/a>\s*<\/td>/.exec(m.html);
      eq([button?.[1], button?.[2]], ["https://rettfrabonden.com/magic-link-verify?token=abc&amp;x=&lt;1&gt;", "Logg inn i eierportalen"],
        "mail: one button «Logg inn i eierportalen» to the login link, escaped");
      ok(m.html.includes('Senere logger du inn på <a href="https://rettfrabonden.com/eier/k5-a">rettfrabonden.com/eier/k5-a</a> med denne e-postadressen.'),
        "mail: the later login address links to APP_URL/eier/<id>");
      ok(!/Gratulerer|Din agent er klar|dashboarden|Lykke til|#bestillinger|Oppdatere informasjon/.test(m.text + m.html), "mail: nothing of the old text is left");

      // APP_URL with a trailing slash, an id that needs encoding.
      process.env.APP_URL = "https://staging.example.test/";
      await svc.sendClaimConfirmation("eier@example.test", "Gård", LOGIN, "k5 a/ø&<");
      const s = mails[mails.length - 1]!;
      ok(s.text.includes("Senere logger du inn på staging.example.test/eier/k5%20a%2F%C3%B8%26%3C med denne e-postadressen."),
        "mail: <host>/eier/<id> follows APP_URL, no scheme, no double slash, id encoded");
      ok(s.html.includes('<a href="https://staging.example.test/eier/k5%20a%2F%C3%B8%26%3C">staging.example.test/eier/k5%20a%2F%C3%B8%26%3C</a>'),
        "mail: … and links there in the HTML");
      process.env.APP_URL = "https://rettfrabonden.com";
    }

    // ══ (appr) approval mails a one-time owner-portal link ════════════════
    let mailedToken = "";
    {
      const before = mails.length;
      const a = await approve(claimA, " Kari@K5-Bekreftet.example.test ");
      eq(a.status, 200, "appr: approve → 200");
      eq([a.json?.loginLinkSent, a.json?.sentTo, a.json?.agentId], [true, maskEmail(APPROVED), "k5-a"], "appr: response shape kept — loginLinkSent, sentTo masked");
      ok(!a.text.includes(APPROVED) && !/[0-9a-f]{64}/.test(a.text), "appr: neither the full address nor a token is in the response");
      eq(mails.length, before + 1, "appr: exactly one mail");
      const m = mails[mails.length - 1]!;
      eq([m.to, m.subject], [APPROVED, `Profilen til ${NAME} er nå din på Rett fra Bonden`], "appr: to the approved address (normalized), the new subject");
      mailedToken = tokenIn(m.text);
      const row = linkRow(mailedToken);
      ok(!!row, "appr: the mailed /magic-link-verify token is a magic_links row");
      eq([String(row?.id).slice(0, 8), row?.email, row?.agent_id, row?.used], ["mlclaim_", APPROVED, "k5-a", 0],
        "appr: one-time claim link, bound to the approved address and this agent, unused");
      const lifeMs = Date.parse(row?.expires_at) - Date.parse(row?.created_at);
      ok(Math.abs(lifeMs - 15 * 60_000) < 1000, `appr: the link lives 15 minutes, as the mail says (got ${lifeMs} ms)`);
      ok(m.text.includes(`https://rettfrabonden.com/magic-link-verify?token=${mailedToken}`), "appr: the link is APP_URL/magic-link-verify?token=");
      ok(m.html.includes(`<a href="https://rettfrabonden.com/magic-link-verify?token=${mailedToken}"`), "appr: the button carries the same link");
      const claimToken = String((db.prepare("SELECT claim_token FROM agent_claims WHERE id = ?").get(claimA) as any)?.claim_token || "");
      ok(claimToken.startsWith("claim_") && !(m.text + m.html).includes(claimToken) && !(m.text + m.html).includes("claim_"), "appr: the claim token is never mailed");
      ok(!(m.text + m.html).includes("/api/marketplace/auth/m/") && !(m.text + m.html).includes("/selger"), "appr: no /selger marketplace link");
      ok(m.text.includes("rettfrabonden.com/eier/k5-a med denne e-postadressen"), "appr: names the portal address for later");
    }

    // ══ (verify) the link opens the portal, once ══════════════════════════
    let session = "";
    {
      const pre = await portal("k5-a", mailedToken, "bearer");
      eq([pre.status, pre.location], [302, "/eier/k5-a"], "verify: an unused claim link is no session");
      const v = await req("GET", `/magic-link-verify?token=${mailedToken}`);
      eq([v.status, v.location], [302, "/eier/k5-a/portal"], "verify: /magic-link-verify → 302 to the portal");
      session = sessionFrom(v);
      ok(/^[0-9a-f]{64}$/.test(session) && session !== mailedToken, "verify: the session cookie is a fresh token, not the mailed one");
      const s = linkRow(session);
      eq([String(s?.id).slice(0, 7), s?.email, s?.agent_id, s?.used], ["mlsess_", APPROVED, "k5-a", 1], "verify: a session row for the approved address and this agent");
      const sessionDays = (Date.parse(s?.expires_at) - Date.now()) / 86_400_000;
      ok(sessionDays > 6.99 && sessionDays <= 7, `verify: the session lasts 7 days, not 15 minutes (got ${sessionDays.toFixed(3)} d)`);
      eq([linkRow(mailedToken)?.used, isExpired(mailedToken)], [1, true], "verify: the mailed link is burnt (used and expired)");

      eq((db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = 'k5-a'").get() as any).email, "post@k5-a.example.test", "verify: agent_knowledge.email is still the other address");
      const p = await portal("k5-a", session);
      eq(p.status, 200, "verify: the session opens /eier/k5-a/portal (gate off)");
      ok(p.text.includes("Gård &lt;K5&gt; &amp; &quot;Søn&quot;"), "verify: … the portal of this profile");
      process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED = "1";
      eq((await portal("k5-a", session)).status, 200, "verify: … and with OWNER_VERIFIED_OWNER_GATE_ENABLED on (a verified owner)");
      ok(ownerPortal.isVerifiedOwner("k5-a", ownerPortal.verifyOwnerSession({ headers: { cookie: `rfb_owner_session=${session}` } } as any)),
        "verify: isVerifiedOwner holds for the session");
      delete process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED;
      eq(ownerPortal.sessionClaimantOwnerEmail("k5-a", { token: session }), APPROVED, "verify: the session is the claimant's own (the /selger button works for it)");

      const again = await req("GET", `/magic-link-verify?token=${mailedToken}`);
      eq([again.status, again.location, sessionFrom(again)], [302, "/?error=invalid_token", ""], "verify: the link works once — a second click opens nothing");
      eq((await portal("k5-a", mailedToken, "bearer")).status, 302, "verify: the burnt mailed token is no session (Bearer)");
      eq((await portal("k5-a", mailedToken)).status, 302, "verify: … nor as a cookie");

      // The race guard: a link another request marked used a moment ago (used =
      // 1, not yet expired — a concurrent click, or the /selger magic-link
      // verifier on the same table) opens no second session.
      const raced = ownerPortal.createOwnerLoginLink("k5-a", APPROVED, "claim_approval");
      db.prepare("UPDATE magic_links SET used = 1 WHERE token = ?").run(raced.token);
      const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE id LIKE 'mlsess_%'").get() as { n: number }).n;
      const rv = await req("GET", `/magic-link-verify?token=${raced.token}`);
      eq([rv.status, rv.location, sessionFrom(rv)], [302, "/?error=invalid_token", ""], "verify: a claim link already used elsewhere opens nothing");
      eq((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE id LIKE 'mlsess_%'").get() as { n: number }).n, sessionsBefore, "verify: … and creates no session row");
      db.prepare("DELETE FROM magic_links WHERE token = ?").run(raced.token);

      const late = ownerPortal.createOwnerLoginLink("k5-a", APPROVED, "claim_approval");
      db.prepare("UPDATE magic_links SET expires_at = ? WHERE token = ?").run(new Date(Date.now() - 1000).toISOString(), late.token);
      const lv = await req("GET", `/magic-link-verify?token=${late.token}`);
      eq([lv.status, lv.location, sessionFrom(lv)], [302, "/?error=invalid_token", ""], "verify: an expired claim link opens nothing");
      db.prepare("DELETE FROM magic_links WHERE token = ?").run(late.token);
    }

    // ══ (login) the /eier login accepts the confirmed address ═════════════
    {
      const NOT_ASSOCIATED = { success: false, error: "email_not_associated", message: "Den e-posten er ikke registrert for denne produsenten." };
      db.prepare("DELETE FROM magic_links WHERE agent_id = 'k5-a' AND id NOT LIKE 'mlsess_%'").run(); // a clean rate-limit window

      let before = mails.length;
      const c = await requestLink("k5-a", "  KARI@k5-bekreftet.example.test ");
      eq([c.status, c.json?.success], [200, true], "login: the verified claimant's address (any case, spaces) → 200");
      eq([mails.length, mails[mails.length - 1]?.to], [before + 1, APPROVED], "login: … one mail, to the confirmed address as normalized");
      ok(mails[mails.length - 1]!.subject.startsWith("Logg inn på eierportalen for "), "login: … the usual owner magic-link mail");
      const t = tokenIn(mails[mails.length - 1]!.text);
      eq([String(linkRow(t)?.id).slice(0, 3), linkRow(t)?.email, linkRow(t)?.agent_id], ["ml_", APPROVED, "k5-a"], "login: … an ordinary 7-day link for this agent");
      const v = await req("GET", `/magic-link-verify?token=${t}`);
      eq([v.status, v.location, sessionFrom(v)], [302, "/eier/k5-a/portal", t], "login: … which logs in as before (session = token)");
      eq((await portal("k5-a", t)).status, 200, "login: … into the portal");

      before = mails.length;
      const k = await requestLink("k5-a", "post@k5-a.example.test");
      eq([k.status, mails.length, mails[mails.length - 1]?.to], [200, before + 1, "post@k5-a.example.test"], "login: agent_knowledge.email still works");

      // Refused: same 404 body for each, no mail, no row.
      agent("k5-other", "Annen Gård", "post@k5-other.example.test");
      claim("k5-other", "eier@k5-other.example.test", "verified", { token: "claim_k5_other" });
      claim("k5-a", "venter@k5.example.test", "pending_review", { reason: "no_known_email" });
      claim("k5-a", "kode@k5.example.test", "code_sent");
      claim("k5-a", "avvist@k5.example.test", "rejected");
      claim("k5-a", "erstattet@k5.example.test", "superseded");
      for (const [label, addr] of [
        ["an unrelated address", "fremmed@example.test"],
        ["a pending_review claim's address", "venter@k5.example.test"],
        ["a code_sent claim's address", "kode@k5.example.test"],
        ["a rejected claim's address", "avvist@k5.example.test"],
        ["a superseded claim's address", "erstattet@k5.example.test"],
        ["a verified claimant of another agent", "eier@k5-other.example.test"],
        ["the typed (not approved) address of the approved claim", "kari@k5-typed.example.test"],
      ] as const) {
        const mBefore = mails.length;
        const rows = linkCount("k5-a");
        const r = await requestLink("k5-a", addr);
        eq([r.status, r.json], [404, NOT_ASSOCIATED], `login: ${label} → 404 email_not_associated, same body`);
        ok(mails.length === mBefore && linkCount("k5-a") === rows, `login: ${label} → no mail, no link`);
      }
      eq((await requestLink("k5-other", "eier@k5-other.example.test")).status, 200, "login: … that other agent's owner still logs in on their own profile");

      // A profile with no agent_knowledge row (no farm e-mail): its approved owner can log in.
      agent("k5-noknow", "Gård uten e-post", null);
      claim("k5-noknow", "eier@k5-noknow.example.test", "verified", { token: "claim_k5_noknow" });
      eq((await requestLink("k5-noknow", "eier@k5-noknow.example.test")).status, 200, "login: no agent_knowledge row — the verified owner's address → 200");
      eq((await requestLink("k5-noknow", "fremmed@example.test")).json, NOT_ASSOCIATED, "login: … any other address → the same 404");
    }

    // ══ (rate) the visitor limit vs the admin approval ════════════════════
    {
      const iso = new Date().toISOString();
      const insLink = db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)");
      agent("k5-b", "Gård B", "post@k5-b.example.test");
      for (let i = 0; i < 3; i++) insLink.run(`ml_k5b_${i}`, "post@k5-b.example.test", `tok-k5b-${i}`, "k5-b", iso, new Date(Date.now() + 86_400_000).toISOString());
      eq((await requestLink("k5-b", "post@k5-b.example.test")).status, 429, "rate: 3 links this hour → the visitor gets 429");
      const cb = claim("k5-b", "b@k5-b.example.test", "pending_review", { reason: "listed_email_wrong" });
      const before = mails.length;
      const a = await approve(cb, "b-bekreftet@k5-b.example.test");
      eq([a.status, a.json?.loginLinkSent, mails.length, mails[mails.length - 1]?.to], [200, true, before + 1, "b-bekreftet@k5-b.example.test"],
        "rate: Daniel's approval is not held by the visitor limit");
      eq((await requestLink("k5-b", "b-bekreftet@k5-b.example.test")).status, 429, "rate: … and the visitor limit still holds afterwards, for the new address too");

      agent("k5-c", "Gård C", "post@k5-c.example.test");
      const cc = claim("k5-c", "c@k5-c.example.test", "pending_review", { reason: "listed_email_wrong" });
      eq((await approve(cc)).json?.loginLinkSent, true, "rate: approval on a fresh profile mails the link");
      eq([(await requestLink("k5-c", "c@k5-c.example.test")).status, (await requestLink("k5-c", "post@k5-c.example.test")).status], [200, 200],
        "rate: two visitor links after the approval …");
      eq((await requestLink("k5-c", "c@k5-c.example.test")).status, 429, "rate: … then 429 — the approval's link counts as one of the 3 mails an hour");
    }

    // ══ (owner) an existing owner is not mailed ════════════════════════════
    {
      agent("k5-own", "Gård Eid", "post@k5-own.example.test", { claimedAt: "2026-05-01T08:00:00.000Z" });
      const ownerClaim = claim("k5-own", "eier@k5-own.example.test", "verified", { token: "claim_k5_own" });
      const ownerBefore = JSON.stringify(db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(ownerClaim));
      const queued = claim("k5-own", "ny@k5-own.example.test", "pending_review", { reason: "has_owner" });
      const before = mails.length;
      const a = await approve(queued, "ny-bekreftet@k5-own.example.test");
      eq([a.status, a.json?.loginLinkSent], [200, true], "owner: approving a second owner → 200, link sent");
      eq(mails.slice(before).map((m) => m.to), ["ny-bekreftet@k5-own.example.test"], "owner: only the approved address is mailed — the existing owner gets nothing");
      eq(JSON.stringify(db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(ownerClaim)), ownerBefore, "owner: the existing owner's claim is untouched");
      const mBefore = mails.length;
      eq((await requestLink("k5-own", "eier@k5-own.example.test")).status, 200, "owner: the existing owner can still log in to /eier with their address");
      eq(mails[mBefore]?.to, "eier@k5-own.example.test", "owner: … the link goes to them");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-k5-gratulerer: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  if (!process.env.EMAIL_FORCE_DRY_RUN) process.env.EMAIL_FORCE_DRY_RUN = "true";
  runRfbClaimK5GratulererTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-k5-gratulerer: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
