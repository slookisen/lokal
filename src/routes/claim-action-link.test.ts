/**
 * claim-action-link.test.ts — dev-request 2026-10-30-rfb-eierkrav-automatisk-
 * vurdering-og-ettklikk, SLICE C4 (signerte ett-klikks-lenker for eierkrav).
 * No network, no e-mail (EMAIL_FORCE_DRY_RUN), no production DB: a fresh
 * in-memory SQLite with the real schema and the real routers (claim-action
 * admin + public, admin-agents) on an ephemeral port.
 *
 *   flag     CLAIM_ACTION_LINKS_ENABLED off → public GET/POST 404, admin 503
 *   admin    403 without key; 503 without / with a short secret; 400 bad body;
 *            404 unknown claim; default actions per status; 409 on an action
 *            that does not fit; the token is never stored
 *   C4.1     GET on a valid link writes nothing (agent_claims, agents,
 *            claim_action_links, magic_links); headers; HTML-escaped page
 *   C4.2     approve / reject / revoke each run once; second POST → 409, no
 *            new writes; approve + reject for one claim: after one is used the
 *            other → 409 and is NOT used up; approve via link = approve via
 *            admin route (same profile/claim outcome)
 *   C4.3     expired → 410; tampered signature / payload, other secret,
 *            re-signed claim B / other action on A's nonce → 404 and claim B
 *            untouched; secret missing → 503 admin, rejected (503) public
 *   admin    existing claim-review-approve / reject / revoke responses unchanged
 *
 * Standalone: npx tsx src/routes/claim-action-link.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";
import crypto from "crypto";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runClaimActionLinkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function eq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);

  const initMod = require("../database/init") as typeof import("../database/init");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "CLAIM_ACTION_LINK_SECRET", "CLAIM_ACTION_LINKS_ENABLED", "EMAIL_FORCE_DRY_RUN", "CLAIM_CRM_TRACKING_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const ADMIN_KEY = "claim-action-test-admin-key";
  const SECRET = "claim-action-test-secret-0123456789abcdef-0123456789";
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.EMAIL_FORCE_DRY_RUN = "true";
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

    const svc = require("../services/claim-action-link") as typeof import("../services/claim-action-link");

    // ── Server with the real routers ───────────────────────────────────────
    {
      const express = require("express");
      const cal = require("./claim-action-link") as typeof import("./claim-action-link");
      delete require.cache[require.resolve("./admin-agents")];
      const adminAgents = require("./admin-agents").default;
      const app = express();
      app.use(express.json());
      app.use("/", cal.default);
      app.use("/admin/agents/claim-action-links", cal.claimActionAdminRouter);
      app.use("/admin/agents", adminAgents);
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
    const MINT = "/admin/agents/claim-action-links";
    const mint = (body: unknown, headers: Record<string, string> = admin) => req("POST", MINT, { headers, body });
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") || "";
    const page = (t: string) => req("GET", `/eierkrav/handling?t=${encodeURIComponent(t)}`);
    const submit = (t: string) => req("POST", "/eierkrav/handling", { form: { t } });
    async function linksFor(claimId: string, actions?: string[]): Promise<Record<string, string>> {
      const r = await mint(actions ? { claimId, actions } : { claimId });
      if (r.status !== 200) throw new Error(`mint ${claimId} → ${r.status} ${r.text}`);
      const out: Record<string, string> = {};
      for (const l of r.body.links) out[l.action] = tokenOf(l.url);
      return out;
    }

    // ── Fixtures ───────────────────────────────────────────────────────────
    function agent(id: string, name = `Gård ${id}`): void {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, origin)
                  VALUES (?, ?, 'Testprodusent', 'test', ?, 'https://example.test', 'producer', ?, '["vegetables"]', 'discovery')`)
        .run(id, name, `registrert@${id}.example.test`, `k-${id}`);
      db.prepare("INSERT INTO agent_knowledge (agent_id, email, data_source) VALUES (?, ?, 'auto')").run(id, `post@${id}.example.test`);
    }
    let seq = 0;
    function queuedClaim(agentId: string, claimant = "Eier Navn"): string {
      const id = `cal-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES (?, ?, ?, ?, 'pending_review', 'no_known_email')`).run(id, agentId, claimant, `eier@${agentId}.example.test`);
      return id;
    }
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = () => JSON.stringify({
      agent_claims: all("agent_claims"),
      agents: all("agents"),
      agent_knowledge: all("agent_knowledge"),
      claim_action_links: all("claim_action_links"),
      magic_links: all("magic_links"),
    });
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const linkRowByClaim = (claimId: string, action: string): any =>
      db.prepare("SELECT * FROM claim_action_links WHERE claim_id = ? AND action = ? ORDER BY created_at DESC, rowid DESC").get(claimId, action);
    const profile = (id: string) => db.prepare("SELECT is_verified, claimed_at IS NOT NULL AS claimed, claimed_via, trust_score FROM agents WHERE id = ?").get(id) as any;

    agent("ag-a", "Ola's <Gård> & Sønn");
    agent("ag-b");
    const claimA = queuedClaim("ag-a", "Kari <b>Nordmann</b>");
    const claimB = queuedClaim("ag-b");

    // ══ Flag off (default) ═════════════════════════════════════════════════
    {
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;
      const m = await mint({ claimId: claimA });
      eq([m.status, m.body?.error], [503, "claim_action_links_disabled"], "flag-01: flag off → admin mint 503");
      // A real token minted directly through the service still gets 404.
      const direct = svc.createClaimActionLinks(claimA, ["approve"]);
      ok(direct.ok, "flag-02: the service itself can mint (for the next checks)");
      const t = direct.ok ? tokenOf(direct.links[0].url) : "";
      const afterMint = snapshot();
      const g = await page(t);
      eq(g.status, 404, "flag-03: flag off → GET /eierkrav/handling 404");
      const p = await submit(t);
      eq(p.status, 404, "flag-04: flag off → POST /eierkrav/handling 404");
      eq(snapshot(), afterMint, "flag-05: flag off → no writes from GET/POST");
      eq(claimRow(claimA).status, "pending_review", "flag-06: the claim is untouched");
      process.env.CLAIM_ACTION_LINKS_ENABLED = "1";
      eq((await page(t)).status, 404, "flag-07: CLAIM_ACTION_LINKS_ENABLED=1 is still off (only \"true\")");
      eq((await mint({ claimId: claimA })).status, 503, "flag-08: …admin too");
      db.prepare("DELETE FROM claim_action_links").run();
      process.env.CLAIM_ACTION_LINKS_ENABLED = "true";
      delete process.env.CLAIM_ACTION_LINK_SECRET;
    }

    // ══ Admin mint ═════════════════════════════════════════════════════════
    {
      eq((await mint({ claimId: claimA }, {})).status, 403, "admin-01: no X-Admin-Key → 403");
      eq((await mint({ claimId: claimA }, { "X-Admin-Key": "nope" })).status, 403, "admin-02: wrong X-Admin-Key → 403");
      const noSecret = await mint({ claimId: claimA });
      eq([noSecret.status, noSecret.body?.error], [503, "claim_action_secret_missing"], "admin-03 (C4.3): secret missing → 503");
      process.env.CLAIM_ACTION_LINK_SECRET = "too-short";
      eq((await mint({ claimId: claimA })).status, 503, "admin-04: secret shorter than 32 chars → 503 (fail closed)");
      eq((db.prepare("SELECT COUNT(*) AS n FROM claim_action_links").get() as any).n, 0, "admin-05: no link row without a usable secret");
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;

      eq((await mint({})).status, 400, "admin-06: empty body → 400");
      eq((await mint({ claimId: claimA, actions: ["delete"] })).status, 400, "admin-07: unknown action → 400");
      eq((await mint({ claimId: claimA, actions: "approve" })).status, 400, "admin-08: actions not an array → 400");
      eq((await mint({ claimId: 42 })).status, 400, "admin-09: claimId not a string → 400");
      const unknown = await mint({ claimId: "no-such-claim" });
      eq([unknown.status, unknown.body?.error], [404, "claim_not_found"], "admin-10: unknown claim → 404");

      const r = await mint({ claimId: claimA });
      eq(r.status, 200, "admin-11: pending claim → 200");
      eq(r.body?.links?.map((l: any) => l.action), ["approve", "reject"], "admin-12: pending_review default → approve + reject");
      ok(r.body?.links?.every((l: any) => l.url.startsWith("https://rettfrabonden.com/eierkrav/handling?t=v1.")), "admin-13: URLs point at /eierkrav/handling with a v1 token");
      const hours = (Date.parse(r.body.links[0].expires_at) - Date.now()) / 3_600_000;
      ok(hours > 71.9 && hours <= 72, "admin-14: valid 72 h");
      const rows = db.prepare("SELECT * FROM claim_action_links WHERE claim_id = ?").all(claimA) as any[];
      eq(rows.length, 2, "admin-15: one row per action");
      const tokens = r.body.links.map((l: any) => tokenOf(l.url));
      ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.nonce_hash) && row.used_at === null && row.used_result === null),
        "admin-16: rows keyed by a sha256 nonce hash, unused");
      const dump = JSON.stringify(rows);
      ok(tokens.every((t: string) => !dump.includes(t) && !dump.includes(t.split(".")[2])), "admin-17: neither the token nor its signature is stored");
      const wrong = await mint({ claimId: claimA, actions: ["revoke"] });
      eq([wrong.status, wrong.body?.error], [409, "action_not_valid_for_status"], "admin-18: revoke on a pending claim → 409");
      const only = await mint({ claimId: claimA, actions: ["reject"] });
      eq(only.body?.links?.map((l: any) => l.action), ["reject"], "admin-19: explicit actions → only those");
      db.prepare("DELETE FROM claim_action_links").run();
    }

    // ══ C4.1 GET writes nothing ════════════════════════════════════════════
    const linksA = await linksFor(claimA);
    {
      const before = snapshot();
      const g = await page(linksA.approve);
      eq(g.status, 200, "C4.1-01: GET valid link → 200");
      eq(g.headers["cache-control"], "no-store", "C4.1-02: Cache-Control: no-store");
      ok(String(g.headers["x-robots-tag"] || "").includes("noindex"), "C4.1-03: X-Robots-Tag noindex");
      eq(g.headers["referrer-policy"], "no-referrer", "C4.1-04: Referrer-Policy: no-referrer");
      ok(g.text.includes("Ola&#039;s &lt;Gård&gt; &amp; Sønn") && !g.text.includes("<Gård>"), "C4.1-05: farm name shown, HTML-escaped");
      ok(g.text.includes("Kari &lt;b&gt;Nordmann&lt;/b&gt;") && !g.text.includes("<b>Nordmann"), "C4.1-06: claimant name HTML-escaped");
      ok(g.text.includes("Godkjenne eierkravet"), "C4.1-07: the action in Norwegian");
      ok(g.text.includes('method="post" action="/eierkrav/handling"') && g.text.includes(`name="t" value="${linksA.approve}"`), "C4.1-08: POST form with the token as hidden field");
      const g2 = await page(linksA.reject);
      ok(g2.status === 200 && g2.text.includes("Avslå eierkravet"), "C4.1-09: reject page in Norwegian");
      eq(snapshot(), before, "C4.1-10: GET changed nothing in agent_claims, agents, claim_action_links, magic_links");
      await page(linksA.approve);
      eq(snapshot(), before, "C4.1-11: a repeated GET changes nothing either");
    }

    // ══ C4.2 approve once; reject of the same claim then refused, not consumed ══
    {
      const p = await submit(linksA.approve);
      eq(p.status, 200, "C4.2-01: POST approve → 200");
      ok(p.text.includes("Eierkravet er godkjent"), "C4.2-02: confirmation page");
      eq(p.headers["cache-control"], "no-store", "C4.2-03: result page no-store");
      const c = claimRow(claimA);
      eq([c.status, c.verification_method, c.claimant_email], ["verified", "manual", "eier@ag-a.example.test"], "C4.2-04: the claim is verified (approveClaimReview)");
      const prof = profile("ag-a");
      eq([prof.is_verified, prof.claimed, prof.claimed_via], [1, 1, "admin_approval"], "C4.2-05: the profile has an owner");
      ok(typeof prof.trust_score === "number", "C4.2-06: trust score recalculated");
      eq((db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = 'ag-a' AND id LIKE 'mlclaim_%'").get() as any).n, 1, "C4.2-07: the owner login link was made (same as claim-review-approve)");
      const used = linkRowByClaim(claimA, "approve");
      ok(!!used.used_at && used.used_result === "approved", "C4.2-08: the link is used, result recorded");

      const before = snapshot();
      const again = await submit(linksA.approve);
      eq(again.status, 409, "C4.2-09: second POST of the same link → 409");
      ok(again.text.includes("allerede brukt"), "C4.2-10: explanatory page");
      eq(snapshot(), before, "C4.2-11: no new writes on the second POST");

      const rej = await submit(linksA.reject);
      eq(rej.status, 409, "C4.2-12: reject link after approve → 409 (claim not pending_review)");
      ok(rej.text.includes("ikke brukt opp"), "C4.2-13: the page says the link is not used up");
      eq(snapshot(), before, "C4.2-14: no writes from the refused reject");
      eq(linkRowByClaim(claimA, "reject").used_at, null, "C4.2-15: the reject link is NOT consumed");
      eq((await page(linksA.reject)).status, 409, "C4.2-16: GET of that reject link → 409 too, no write");
      eq(snapshot(), before, "C4.2-17: …still nothing written");
    }

    // ══ C4.2 reject once; approve of the same claim then refused ═════════════
    {
      const links = await linksFor(claimB);
      const p = await submit(links.reject);
      eq(p.status, 200, "C4.2-20: POST reject → 200");
      eq(claimRow(claimB).status, "rejected", "C4.2-21: the claim is rejected");
      eq(profile("ag-b").is_verified, 0, "C4.2-22: the profile is not touched");
      eq(linkRowByClaim(claimB, "reject").used_result, "rejected", "C4.2-23: result recorded");
      const before = snapshot();
      eq((await submit(links.reject)).status, 409, "C4.2-24: second reject → 409");
      eq((await submit(links.approve)).status, 409, "C4.2-25: approve after reject → 409");
      eq(snapshot(), before, "C4.2-26: no writes");
      eq(linkRowByClaim(claimB, "approve").used_at, null, "C4.2-27: the approve link is not consumed");
      const none = await mint({ claimId: claimB });
      eq([none.status, none.body?.error], [409, "no_actions_for_status"], "admin-20: a rejected claim has no fitting action → 409");
    }

    // ══ C4.2 revoke once (claim A is verified now) ═══════════════════════════
    {
      const links = await linksFor(claimA);
      eq(Object.keys(links), ["revoke"], "admin-21: verified default → revoke only");
      const g = await page(links.revoke);
      ok(g.status === 200 && g.text.includes("Trekke tilbake eierskapet"), "C4.2-30: revoke confirmation page");
      const p = await submit(links.revoke);
      eq(p.status, 200, "C4.2-31: POST revoke → 200");
      eq(claimRow(claimA).status, "revoked", "C4.2-32: the claim is revoked");
      const prof = profile("ag-a");
      eq([prof.is_verified, prof.claimed, prof.claimed_via], [0, 0, null], "C4.2-33: the profile is back as before the approval");
      eq(linkRowByClaim(claimA, "revoke").used_result, "revoked:snapshot", "C4.2-34: result recorded");
      const before = snapshot();
      eq((await submit(links.revoke)).status, 409, "C4.2-35: second revoke → 409");
      eq(snapshot(), before, "C4.2-36: no writes");
    }

    // ══ Parity: approve via link = approve via admin route ═══════════════════
    {
      agent("ag-p1"); agent("ag-p2");
      const c1 = queuedClaim("ag-p1"); const c2 = queuedClaim("ag-p2");
      const viaAdmin = await req("POST", "/admin/agents/claim-review-approve", { headers: admin, body: { claimId: c1 } });
      eq(viaAdmin.body, { success: true, claimId: c1, agentId: "ag-p1", isVerified: true, loginLinkSent: false, sentTo: viaAdmin.body?.sentTo }, "parity-01: admin approve response shape unchanged");
      const links = await linksFor(c2, ["approve"]);
      eq((await submit(links.approve)).status, 200, "parity-02: link approve → 200");
      const strip = (agentId: string, claimId: string) => {
        const a = profile(agentId);
        const c = claimRow(claimId);
        const ml = (db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE agent_id = ?").get(agentId) as any).n;
        return { ...a, status: c.status, method: c.verification_method, snap: !!c.pre_grant_state, token: !!c.claim_token, ml };
      };
      eq(strip("ag-p2", c2), strip("ag-p1", c1), "parity-03: same profile + claim outcome via link and via admin route");
      const rj = await req("POST", "/admin/agents/claim-review-reject", { headers: admin, body: { claimId: queuedClaim("ag-p1") } });
      eq([rj.status, rj.body?.status], [200, "rejected"], "parity-04: admin reject response unchanged");
      const rv = await req("POST", "/admin/agents/claim-revoke", { headers: admin, body: { claimId: c1 } });
      eq([rv.status, rv.body?.restored, rv.body?.ownerRemains], [200, "snapshot", false], "parity-05: admin revoke response unchanged");
    }

    // ══ C4.3 expiry, tampering, cross-claim, secret ═════════════════════════
    {
      agent("ag-x"); agent("ag-y");
      const cx = queuedClaim("ag-x"); const cy = queuedClaim("ag-y");
      // Expired: minted 73 h ago.
      const old = svc.createClaimActionLinks(cx, ["approve"], { now: new Date(Date.now() - 73 * 3_600_000) });
      const expired = old.ok ? tokenOf(old.links[0].url) : "";
      let before = snapshot();
      eq((await page(expired)).status, 410, "C4.3-01: expired link GET → 410");
      eq((await submit(expired)).status, 410, "C4.3-02: expired link POST → 410");
      eq(snapshot(), before, "C4.3-03: expired → no writes, not consumed");

      const lx = await linksFor(cx, ["approve"]);
      const ly = await linksFor(cy, ["approve"]);
      before = snapshot();
      const [v, payload, sig] = lx.approve.split(".");
      const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
      eq((await submit(`${v}.${payload}.${flipped}`)).status, 404, "C4.3-04: tampered signature → 404");
      const pObj = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const sign = (secret: string, p: string) => crypto.createHmac("sha256", secret).update("rfb-claim-action:v1:" + p, "utf8").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const toB = b64({ ...pObj, c: cy });
      eq((await submit(`v1.${toB}.${sig}`)).status, 404, "C4.3-05: payload changed to claim B, old signature → 404");
      eq((await submit(`v1.${toB}.${sign(SECRET, toB)}`)).status, 404, "C4.3-06: A's nonce re-signed for claim B → 404 (row bound to claim A)");
      const asReject = b64({ ...pObj, a: "reject" });
      eq((await submit(`v1.${asReject}.${sign(SECRET, asReject)}`)).status, 404, "C4.3-07: A's nonce re-signed as another action → 404");
      const later = b64({ ...pObj, x: pObj.x + 3600 });
      eq((await submit(`v1.${later}.${sig}`)).status, 404, "C4.3-08: extended expiry, old signature → 404");
      eq((await submit(`v1.${payload}.${sign("another-secret-0123456789abcdef-012345", payload)}`)).status, 404, "C4.3-09: signed with another secret → 404");
      eq((await submit("x")).status, 404, "C4.3-10: garbage token → 404");
      eq((await submit("")).status, 404, "C4.3-11: no token → 404");
      eq((await page(`v1.${toB}.${sign(SECRET, toB)}`)).status, 404, "C4.3-12: GET of a cross-claim token → 404");
      const unknownClaim = b64({ ...pObj, c: "no-such-claim" });
      const u = await submit(`v1.${unknownClaim}.${sign(SECRET, unknownClaim)}`);
      eq(u.status, 404, "C4.3-13: unknown claim → same 404 (reveals nothing)");
      eq(u.text, (await submit("x")).text, "C4.3-14: …with the same page as a garbage token");
      eq(snapshot(), before, "C4.3-15: no writes from any rejected token");
      eq([claimRow(cx).status, claimRow(cy).status], ["pending_review", "pending_review"], "C4.3-16: claims A and B untouched");

      // Token for claim A acts only on A.
      eq((await submit(lx.approve)).status, 200, "C4.3-17: A's link → 200");
      eq([claimRow(cx).status, claimRow(cy).status], ["verified", "pending_review"], "C4.3-18: …only claim A changed");

      // Secret removed after minting → public rejected (503), admin 503.
      delete process.env.CLAIM_ACTION_LINK_SECRET;
      before = snapshot();
      eq((await page(ly.approve)).status, 503, "C4.3-19: secret missing → public GET rejected (503)");
      eq((await submit(ly.approve)).status, 503, "C4.3-20: secret missing → public POST rejected (503)");
      eq((await mint({ claimId: cy })).status, 503, "C4.3-21: secret missing → admin 503");
      eq(snapshot(), before, "C4.3-22: no writes");
      // Rotated secret → every outstanding link invalid.
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET + "-rotated";
      eq((await submit(ly.approve)).status, 404, "C4.3-23: rotated secret → old link 404");
      eq(claimRow(cy).status, "pending_review", "C4.3-24: claim B still pending");
      process.env.CLAIM_ACTION_LINK_SECRET = SECRET;
      eq((await submit(ly.approve)).status, 200, "C4.3-25: back to the original secret → the unused link still works once");
    }

    // ══ Service level: redeem twice ═════════════════════════════════════════
    {
      agent("ag-r");
      const cr = queuedClaim("ag-r");
      const lr = await linksFor(cr, ["approve"]);
      const r0 = svc.redeemClaimActionLink(lr.approve);
      eq(r0.state, "done", "race-01: first redeem → done");
      const r1 = svc.redeemClaimActionLink(lr.approve);
      eq(r1.state, "used", "race-02: second redeem → used");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
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
  runClaimActionLinkTests({ log: true }).then((s) => {
    console.log(`\nclaim-action-link: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { for (const f of s.failures) console.log(f); process.exit(1); }
  });
}
