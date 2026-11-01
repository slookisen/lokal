/**
 * rfb-claim-kravflyt.test.ts — dev-request 2026-11-01-rfb-kravflyt-tal-eiere-
 * fra-e-post, slices K1–K3 (daniel-responses/2026-11-01-live-kravflyt-forst.md).
 *
 * An owner who opens the outreach e-mail on the phone and the page somewhere
 * else could not finish the claim: the claimId lived only in one page's
 * memory, a second request was refused for 24 h with a misleading text, the
 * store came under the registration hero, and the code step spoke English.
 * Decision 11=A stands throughout: a code only ever goes to the farm's own
 * address (never to one typed here), and no unmasked address is shown.
 *
 *   (k1)  same e-mail (normalized) asking again while the code is valid →
 *         200, same claimId, code_already_sent, masked recipient, no mail, no
 *         new row (AC1); another e-mail → 429 saying a code went to the farm,
 *         when a new one can come, and the «feil e-post» box (AC1); queue
 *         rules (listed address wrong, owner meanwhile) still come first; an
 *         expired code is not resumed.
 *   (rs)  «Send koden på nytt»: the same code, once, to the same farm address,
 *         not before 10 min, not after expiry, bound to :id, counted in the
 *         platform cap, refused when the address is no longer the farm's,
 *         given back when the mail fails; the per-IP limiter is mounted (AC1).
 *   (k3)  every verifyClaim refusal is Norwegian with what to do next; a wrong
 *         code says how many tries are left (AC4); no English string is left.
 *   (ui)  selger.html (its inline script in node:vm, Map-backed localStorage)
 *         against the real handlers: the open claim is kept, the code field
 *         comes back for the same store and is cleared after verify / expiry /
 *         replacement (AC2); code_already_sent and resend on the page.
 *   (k2)  /selger?agent=<not taken over>: «Dette er min butikk» before the
 *         registration hero and «Allerede registrert?» in the HTML; «Siri» is
 *         not on the page (AC3).
 *   (mig) resend_count / resent_at are additive and idempotent.
 *
 * Exported runRfbClaimKravflytTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-claim-kravflyt.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import Database from "better-sqlite3";
import { inlineScript } from "../../tests/helpers/html-injection";
import { serializeText, jsonResponse, settle, runPage, type FetchStub, type Page } from "../../tests/helpers/fake-page";

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

const ORIGIN = "https://rettfrabonden.com";
const API = `${ORIGIN}/api/marketplace`;
const BOX_LABEL = "E-postadressen som står på profilen er feil eller utdatert";
const ENGLISH = /\b(Claim|claim|not found|Invalid|invalid|expired|Already|verification code|has expired)\b/;

export async function runRfbClaimKravflytTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // The claim limits run on their defaults; nothing is mailed to an admin.
  const LIMIT_ENV = ["CLAIM_CODE_MAX_FAILED_ATTEMPTS", "CLAIM_CODE_PROFILE_WINDOW_HOURS", "CLAIM_CODE_SENDS_PER_HOUR_MAX",
    "CLAIM_REVIEW_OPEN_PER_PROFILE_MAX", "CLAIM_REVIEW_INSERTS_PER_HOUR_MAX", "CLAIM_DOMAIN_RULE_ENABLED"] as const;
  const savedEnv: Record<string, string | undefined> = {
    ADMIN_NOTIFICATION_EMAIL: process.env.ADMIN_NOTIFICATION_EMAIL,
    NODE_ENV: process.env.NODE_ENV,
    FLY_APP_NAME: process.env.FLY_APP_NAME,
  };
  for (const k of LIMIT_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  delete process.env.ADMIN_NOTIFICATION_EMAIL;
  delete process.env.FLY_APP_NAME;

  // ── outgoing mail: a stub transporter, restored in finally ─────────────
  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: SentMail[] = [];
  let nextSend: "ok" | "throw" = "ok";
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      const mode = nextSend;
      nextSend = "ok";
      if (mode === "throw") throw new Error("SMTP unavailable (test)");
      mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text ?? "") });
      return { messageId: `stub-${mails.length}` };
    },
  };
  const codeIn = (m: SentMail | undefined): string => (m?.text.match(/\b(\d{6})\b/) ?? [])[1] ?? "";

  // ── handler harness (the rfb-claim-kjent-kontakt.test.ts pattern) ───────
  function findRoute(router: any, routePath: string, method: "get" | "post"): any {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
    return layer.route;
  }
  const handlerOf = (router: any, routePath: string, method: "get" | "post"): Function => {
    const route = findRoute(router, routePath, method);
    return route.stack[route.stack.length - 1].handle;
  };
  function makeReq(o: { params?: Record<string, string>; body?: any }): any {
    return {
      params: o.params || {}, body: o.body, query: {}, headers: {}, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : undefined; },
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
    const marketplaceRouter = require("./marketplace").default as any;
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { knowledgeService, formatClaimTime } = ks;
    const { maskEmail } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");

    const claimH = handlerOf(marketplaceRouter, "/agents/:id/claim", "post");
    const verifyH = handlerOf(marketplaceRouter, "/agents/:id/claim/verify", "post");
    const resendH = handlerOf(marketplaceRouter, "/agents/:id/claim/resend", "post");

    // ── fixtures ────────────────────────────────────────────────────────
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin)
       VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, 'discovery')`,
    );
    function agent(id: string, listed: string | null): string {
      insAgent.run(id, `Gård ${id}`, `registrert@${id}.example.test`, `https://${id}.example.test`, `key-${id}`);
      if (listed !== null) db.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run(id, listed);
      marketplaceRegistry._agentsCache = null;
      return id;
    }
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const claimsOf = (agentId: string): any[] => db.prepare("SELECT * FROM agent_claims WHERE agent_id = ? ORDER BY created_at, id").all(agentId) as any[];
    const sentRowsOf = (agentId: string): number => claimsOf(agentId).filter((c) => c.code_sent_to).length;
    const claim = (agentId: string, body: Record<string, unknown>) => invoke(claimH, makeReq({ params: { id: agentId }, body }));
    const verify = (agentId: string, claimId: unknown, code: unknown) => invoke(verifyH, makeReq({ params: { id: agentId }, body: { claimId, code } }));
    const resend = (agentId: string, claimId: unknown) => invoke(resendH, makeReq({ params: { id: agentId }, body: { claimId } }));
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const MIN = 60_000;
    const HOUR = 3_600_000;
    /** Moves a claim's send `ms` back in time (its 24 h life moves with it). */
    const sentAgo = (claimId: string, ms: number) => db.prepare("UPDATE agent_claims SET created_at = ?, expires_at = ? WHERE id = ?")
      .run(ago(ms), new Date(Date.now() - ms + 24 * HOUR).toISOString(), claimId);
    /** Frees the platform's hourly code cap for the next section. */
    const freePlatformCap = () => {
      db.prepare("UPDATE agent_claims SET created_at = ? WHERE code_sent_to IS NOT NULL AND datetime(created_at) >= datetime('now', '-1 hours')").run(ago(2 * HOUR));
      db.prepare("UPDATE agent_claims SET resent_at = ? WHERE resent_at IS NOT NULL").run(ago(2 * HOUR));
    };

    // ══ (k1) the same claimant gets the same claim back ═════════════════
    {
      agent("k1", "  Post@Gard-K1.example.test ");
      const first = await claim("k1", { name: "Ola", email: "ola@k1.example.test" });
      eq([first.status, first.body?.data?.status], [200, "code_sent"], "k1: setup — a code went to the farm");
      const id = first.body.data.claimId;
      const code = codeIn(mails[mails.length - 1]);
      const row0 = claimRow(id);
      eq(first.body.data.expiresAt, row0.expires_at, "k1: code_sent carries expiresAt (for the page's open claim)");
      eq(first.body.data.resendAvailableAt, new Date(Date.parse(row0.created_at) + 10 * MIN).toISOString(), "k1: … and when «Send koden på nytt» opens (10 min)");
      eq(first.body.data.via, "farm_email", "k1: … and which rule sent it");

      const mailsBefore = mails.length;
      const rowsBefore = claimsOf("k1").length;
      const again = await claim("k1", { name: "Ola N.", email: "  OLA@K1.example.test " });
      const masked = maskEmail("post@gard-k1.example.test");
      eq([again.status, again.body?.success, again.body?.data?.status, again.body?.data?.claimId], [200, true, "code_already_sent", id],
        "AC1: the same e-mail (normalized) within the window → 200, the same claimId, status code_already_sent");
      eq(again.body?.data?.sentTo, masked, "AC1: … the recipient masked");
      eq(again.body?.message, `Koden er alt sendt til gårdens e-post ${masked}. Skriv den inn her.`, "AC1: … with the spec's text");
      ok(!JSON.stringify(again.body).includes("post@gard-k1.example.test") && !JSON.stringify(again.body).includes(code),
        "AC1: … never the full farm address, never the code");
      eq([mails.length, claimsOf("k1").length, sentRowsOf("k1")], [mailsBefore, rowsBefore, 1], "AC1: … no new code is sent and no new row is written");
      eq(JSON.stringify(claimRow(id)), JSON.stringify(row0), "AC1: … the open claim is unchanged (same code, same expiry)");
      eq([again.body.data.expiresAt, again.body.data.resendAvailableAt], [row0.expires_at, first.body.data.resendAvailableAt], "k1: … with the same expiry and resend time");

      // A different person within the window: rule 4 stands, with the clearer text.
      const other = await claim("k1", { name: "Kari", email: "kari@annen.example.test" });
      const retryAt = Date.parse(row0.created_at) + 24 * HOUR;
      eq(other.status, 429, "AC1: another e-mail within the window → 429");
      const err = String(other.body?.error);
      ok(err.startsWith("Det er alt sendt en kode til gårdens e-post."), "AC1: … says a code has been sent to the farm's e-mail");
      ok(err.includes(`En ny kode kan sendes ${formatClaimTime(new Date(retryAt))}.`), `AC1: … says when a new code can be sent (${formatClaimTime(new Date(retryAt))})`);
      ok(err.includes(BOX_LABEL) && err.includes("manuell godkjenning"), "AC1: … and points to the «feil e-post» box for manual approval");
      ok(Math.abs(Date.parse(other.body?.data?.retryAt) - retryAt) < 1000, "AC1: … data.retryAt is the send time + 24 h");
      ok(!err.includes(masked) && !err.includes("post@gard-k1"), "AC1: … and does not show the farm address to someone else");
      ok(err.includes("skriv inn samme e-postadresse som da"), "k1: … while the code is open, the one who asked is told the same e-mail brings the code field back");
      eq([mails.length, claimsOf("k1").length], [mailsBefore, rowsBefore], "AC1: … no mail, no row");

      // The queue rules still come first: the box takes the same claimant to manual approval.
      const box = await claim("k1", { name: "Ola", email: "ola@k1.example.test", listedEmailWrong: true });
      eq([box.status, box.body?.data?.reason], [202, "listed_email_wrong"], "k1: the «feil e-post» box still queues, also for the claimant with the open code");

      // The right code still works on the resumed claim.
      const v = await verify("k1", again.body.data.claimId, code);
      eq(v.status, 200, "k1: the code from the first e-mail verifies the resumed claim");
      const owned = await claim("k1", { name: "Ola", email: "post@gard-k1.example.test" });
      eq(owned.status, 400, "k1: after verify the owner's own address is told to log in, as before");
    }
    {
      // An expired code is not resumed: 25 h later the same e-mail gets a new code.
      agent("k1-exp", "post@k1-exp.example.test");
      const r1 = await claim("k1-exp", { name: "A", email: "a@k1-exp.example.test" });
      sentAgo(r1.body.data.claimId, 25 * HOUR);
      const r2 = await claim("k1-exp", { name: "A", email: "a@k1-exp.example.test" });
      eq([r2.status, r2.body?.data?.status], [200, "code_sent"], "k1: an expired code is not resumed — after the window the same e-mail gets a new code");
      ok(r2.body.data.claimId !== r1.body.data.claimId && claimRow(r1.body.data.claimId).status === "superseded", "k1: … a new claim, the old one superseded");

      // A claim expired by 5 wrong codes is not resumed either: rule 4 holds, with the time.
      agent("k1-burn", "post@k1-burn.example.test");
      const b = await claim("k1-burn", { name: "B", email: "b@k1-burn.example.test" });
      const right = codeIn(mails[mails.length - 1]);
      const wrong = right === "999999" ? "999998" : "999999";
      let last: HandlerResult | undefined;
      for (let i = 0; i < 5; i++) last = await verify("k1-burn", b.body.data.claimId, wrong);
      const opens = formatClaimTime(new Date(Date.parse(claimRow(b.body.data.claimId).created_at) + 24 * HOUR));
      eq([last?.body?.data?.status, last?.body?.data?.attemptsLeft], ["expired", 0], "k3: the 5th wrong code → expired, 0 tries left");
      eq(last?.body?.error, `For mange feil koder. Kravet er utløpt. Du kan be om en ny kode fra butikksiden ${opens}.`,
        "k3: … says when a new code can be asked for");
      const b2 = await claim("k1-burn", { name: "B", email: "b@k1-burn.example.test" });
      eq(b2.status, 429, "k1: the same e-mail after 5 wrong codes → 429 (the expired claim is not resumed)");
      ok(String(b2.body?.error).includes(`En ny kode kan sendes ${opens}.`), "k1: … with the time the slot opens");
      ok(!String(b2.body?.error).includes("samme e-postadresse"), "k1: … and no «same e-mail» hint, since that code can no longer be taken");

      // An owner meanwhile: rule 3 (queue) before the resume.
      agent("k1-own", "post@k1-own.example.test");
      const o1 = await claim("k1-own", { name: "C", email: "c@k1-own.example.test" });
      db.prepare("UPDATE agents SET claimed_at = ?, claimed_via = 'admin' WHERE id = 'k1-own'").run(new Date().toISOString());
      const o2 = await claim("k1-own", { name: "C", email: "c@k1-own.example.test" });
      eq([o2.status, o2.body?.data?.reason], [202, "has_owner"], "k1: a profile that got an owner queues (rule 3) instead of resuming");
      eq(claimRow(o1.body.data.claimId).status, "code_sent", "k1: … the open code row is left as it is");
      freePlatformCap();
    }

    // ══ (rs) «Send koden på nytt» ═════════════════════════════════════════
    {
      const { rfbClaimRequestLimiter } = require("../middleware/security") as typeof import("../middleware/security");
      eq(findRoute(marketplaceRouter, "/agents/:id/claim/resend", "post").stack[0].handle === rfbClaimRequestLimiter, true,
        "rs: POST …/claim/resend runs the per-IP claim limiter first");

      agent("rs", "post@rs.example.test");
      agent("rs-other", "post@rs-other.example.test");
      const r = await claim("rs", { name: "Ola", email: "angriper@evil.example.test" });
      const id = r.body.data.claimId;
      const firstCode = codeIn(mails[mails.length - 1]);
      const masked = maskEmail("post@rs.example.test");

      let before = mails.length;
      const early = await resend("rs", id);
      eq([early.status, early.body?.data?.reason, mails.length], [429, "too_early", before], "AC1: resend before 10 minutes → 429, no mail");
      const opens = Date.parse(claimRow(id).created_at) + 10 * MIN;
      ok(String(early.body?.error).includes(`på nytt ${formatClaimTime(new Date(opens))}`), "rs: … says when it can be sent again");
      eq(early.body?.data?.retryAt, new Date(opens).toISOString(), "rs: … data.retryAt");

      const cross = await resend("rs-other", id);
      eq([cross.status, cross.body?.data?.reason, mails.length], [400, "not_found", before], "rs: resend under another profile's :id → not found, no mail");
      eq((await resend("rs", "")).status, 400, "rs: missing claimId → 400");
      ok(!ENGLISH.test(String(cross.body?.error)), "rs: … in Norwegian");

      sentAgo(id, 11 * MIN);
      const ok1 = await resend("rs", id);
      eq([ok1.status, ok1.body?.data?.status, ok1.body?.data?.sentTo, ok1.body?.data?.resendAvailableAt], [200, "code_sent", masked, null],
        "AC1: resend after 10 minutes → 200, masked recipient, no further resend");
      eq(mails.length, before + 1, "AC1: … exactly one mail");
      eq([mails[mails.length - 1]?.to, codeIn(mails[mails.length - 1])], ["post@rs.example.test", firstCode], "AC1: … the SAME code to the SAME farm address");
      ok(!mails.some((m) => m.to.includes("evil.example.test")), "rs: … never to the address the claimant typed");
      ok(!JSON.stringify(ok1.body).includes("post@rs.example.test") && !JSON.stringify(ok1.body).includes(firstCode), "rs: … no full address, no code in the response");
      const rowAfter = claimRow(id);
      eq([rowAfter.resend_count, !!rowAfter.resent_at, rowAfter.status, rowAfter.verification_code], [1, true, "code_sent", firstCode], "rs: resend_count 1, resent_at set, same code");

      before = mails.length;
      const twice = await resend("rs", id);
      eq([twice.status, twice.body?.data?.reason, mails.length], [429, "already_resent", before], "AC1: a second resend → 429, no mail (once only)");
      ok(String(twice.body?.error).includes(BOX_LABEL), "rs: … pointing to the «feil e-post» box");
      const resumed = await claim("rs", { name: "Ola", email: "angriper@evil.example.test" });
      eq([resumed.body?.data?.status, resumed.body?.data?.resendAvailableAt], ["code_already_sent", null], "rs: a resumed claim says the resend is used");
      eq((await verify("rs", id, firstCode)).status, 200, "rs: the code still verifies after the resend");

      // Not after expiry.
      agent("rs-exp", "post@rs-exp.example.test");
      const e = await claim("rs-exp", { name: "E", email: "e@x.example.test" });
      sentAgo(e.body.data.claimId, 24 * HOUR + MIN);
      before = mails.length;
      const late = await resend("rs-exp", e.body.data.claimId);
      eq([late.status, late.body?.data?.reason, mails.length, claimRow(e.body.data.claimId).status], [400, "expired", before, "expired"],
        "AC1: resend after the code expired → 400, no mail, the claim is expired");

      // Not when the address is no longer the farm's (changed, or an owner meanwhile).
      agent("rs-moved", "gammel@rs-moved.example.test");
      const m1 = await claim("rs-moved", { name: "M", email: "m@x.example.test" });
      sentAgo(m1.body.data.claimId, 11 * MIN);
      db.prepare("UPDATE agent_knowledge SET email = 'ny@rs-moved.example.test' WHERE agent_id = 'rs-moved'").run();
      before = mails.length;
      const moved = await resend("rs-moved", m1.body.data.claimId);
      eq([moved.status, moved.body?.data?.reason, mails.length], [409, "not_allowed", before], "rs: the farm address changed since the send → refused, nothing sent to either address");
      agent("rs-owner", "post@rs-owner.example.test");
      const o1 = await claim("rs-owner", { name: "O", email: "o@x.example.test" });
      sentAgo(o1.body.data.claimId, 11 * MIN);
      db.prepare("UPDATE agents SET claimed_at = ?, claimed_via = 'admin' WHERE id = 'rs-owner'").run(new Date().toISOString());
      eq((await resend("rs-owner", o1.body.data.claimId)).body?.data?.reason, "not_allowed", "rs: the profile got an owner meanwhile → refused (rule 3)");

      // A failed send gives the resend back.
      agent("rs-fail", "post@rs-fail.example.test");
      const f1 = await claim("rs-fail", { name: "F", email: "f@x.example.test" });
      sentAgo(f1.body.data.claimId, 11 * MIN);
      nextSend = "throw";
      const failedSend = await resend("rs-fail", f1.body.data.claimId);
      eq([failedSend.status, claimRow(f1.body.data.claimId).resend_count, claimRow(f1.body.data.claimId).resent_at], [502, 0, null], "rs: a failed resend mail → 502, the resend is given back");
      eq((await resend("rs-fail", f1.body.data.claimId)).status, 200, "rs: … so it can be tried again");
      freePlatformCap();

      // Counted in the platform cap: resends fill it, and a full cap refuses a resend.
      agent("rs-cap-src", "post@rs-cap-src.example.test");
      const cap = ks.CLAIM_CODE_SENDS_PER_HOUR_MAX;
      const insSend = db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at, code_sent_to, resend_count, resent_at)
         VALUES (?, 'rs-cap-src', 'Cap', 'cap@x.example.test', '111111', 'superseded', 'organic', ?, ?, 'post@rs-cap-src.example.test', 1, ?)`,
      );
      // Sent 2 h ago (outside the hour), each resent now: only the resends count.
      for (let i = 0; i < cap - 1; i++) insSend.run(`rs-cap-${i}`, new Date().toISOString(), ago(2 * HOUR), new Date().toISOString());
      agent("rs-cap", "post@rs-cap.example.test");
      agent("rs-cap2", "post@rs-cap2.example.test");
      const underCap = await claim("rs-cap", { name: "D", email: "d@x.example.test" });
      eq(underCap.status, 200, `rs: ${cap - 1} resends in the last hour + 1 new code = the cap → the code is sent`);
      before = mails.length;
      const overCap = await claim("rs-cap2", { name: "E", email: "e@x.example.test" });
      eq([overCap.status, mails.length], [429, before], "rs: … the next new code is refused: resends count in the platform cap");
      sentAgo(underCap.body.data.claimId, 11 * MIN); // 11 min back: resend open, the send still inside the hour
      const capResend = await resend("rs-cap", underCap.body.data.claimId);
      eq([capResend.status, capResend.body?.data?.reason, mails.length], [429, "platform", before], "rs: a resend at the platform cap → 429, no mail");
      freePlatformCap();
    }

    // ══ (dr) the domain rule (flag on): a P2 code is handed back too ═══════
    {
      const rule = require("../services/claim-domain-rule") as typeof import("../services/claim-domain-rule");
      const probed: string[] = [];
      rule.__setDomainHttpsCheckForTesting(async (d: string) => { probed.push(d); return true; });
      process.env.CLAIM_DOMAIN_RULE_ENABLED = "1";
      try {
        agent("dr", null); // no knowledge row: no farm e-mail, no website → a P2 candidate
        const p1 = await claim("dr", { name: "Ola", email: "ola@dr-gard.example.test" });
        eq([p1.status, p1.body?.data?.status, p1.body?.data?.via, mails[mails.length - 1]?.to], [200, "code_sent", "domain_code_sent", "ola@dr-gard.example.test"],
          "dr: setup — P2 sends the code to the claimant's own address");
        const before = mails.length;
        const p2 = await claim("dr", { name: "Ola", email: "Ola@DR-gard.example.test" });
        const masked = maskEmail("ola@dr-gard.example.test");
        eq([p2.status, p2.body?.data?.status, p2.body?.data?.claimId, mails.length], [200, "code_already_sent", p1.body.data.claimId, before],
          "dr: the same claimant again → the same P2 claim back (the probe still runs for its answer), no new mail");
        eq(p2.body?.message, `Koden er alt sendt til ${masked}. Skriv den inn her.`, "dr: … not called «gårdens e-post»");
        eq(probed.length, 2, "dr: … the HTTPS probe ran for the repeat");
        sentAgo(p1.body.data.claimId, 11 * MIN);
        const rsOn = await resend("dr", p1.body.data.claimId);
        eq([rsOn.status, mails[mails.length - 1]?.to], [200, "ola@dr-gard.example.test"], "dr: resend with the flag on → the same address the P2 code went to");
        agent("dr-off", null);
        const q = await claim("dr-off", { name: "Kari", email: "kari@dr-off-gard.example.test" });
        sentAgo(q.body.data.claimId, 11 * MIN);
        delete process.env.CLAIM_DOMAIN_RULE_ENABLED;
        const before2 = mails.length;
        eq([(await resend("dr-off", q.body.data.claimId)).body?.data?.reason, mails.length], ["not_allowed", before2],
          "dr: with the flag turned off, a P2 code is not resent to the claimant's address");
      } finally {
        delete process.env.CLAIM_DOMAIN_RULE_ENABLED;
        rule.__setDomainHttpsCheckForTesting(null);
      }
      freePlatformCap();
    }

    // ══ (k3) Norwegian errors with what to do next ═════════════════════════
    {
      agent("k3", "post@k3.example.test");
      agent("k3-b", "post@k3-b.example.test");
      const r = await claim("k3", { name: "A", email: "a@x.example.test" });
      const id = r.body.data.claimId;
      const code = codeIn(mails[mails.length - 1]);
      const wrong = code === "999999" ? "999998" : "999999";
      const answers: Array<[string, HandlerResult]> = [];

      for (let left = 4; left >= 1; left--) {
        const w = await verify("k3", id, wrong);
        answers.push([`wrong code (${left} left)`, w]);
        eq([w.status, w.body?.data?.status, w.body?.data?.attemptsLeft, w.body?.error],
          [400, "invalid_code", left, `Feil kode. Du har ${left} forsøk igjen. Sjekk at du bruker koden i den nyeste e-posten fra oss.`],
          `AC4: a wrong code shows the tries left (${left})`);
      }
      answers.push(["unknown claim", await verify("k3", "finnes-ikke", code)]);
      answers.push(["other profile", await verify("k3-b", id, code)]);
      eq(answers[answers.length - 1]![1].body?.data?.status, "not_found", "k3: another profile's claim → not_found");
      ok(String(answers[answers.length - 1]![1].body?.error).includes("Start på nytt fra butikksiden"), "k3: unknown claim → start again from the store page");
      const okV = await verify("k3", id, code);
      eq(okV.status, 200, "k3: the right code on the 5th try still works");
      const already = await verify("k3", id, code);
      answers.push(["verified", already]);
      eq(already.body?.data?.status, "verified", "k3: verify twice → verified");
      ok(String(already.body?.error).includes("Logg inn med e-post") && String(already.body?.error).includes("Allerede registrert?"), "k3: … says to log in by e-mail");

      // expired (time), superseded, rejected, legacy, missing fields.
      agent("k3-exp", "post@k3-exp.example.test");
      const e = await claim("k3-exp", { name: "E", email: "e@x.example.test" });
      db.prepare("UPDATE agent_claims SET expires_at = ? WHERE id = ?").run(ago(MIN), e.body.data.claimId);
      const exp = await verify("k3-exp", e.body.data.claimId, codeIn(mails[mails.length - 1]));
      answers.push(["expired", exp]);
      eq([exp.body?.data?.status, exp.body?.error], ["expired", "Koden er utløpt. Be om en ny kode fra butikksiden."], "k3: an expired code → ask for a new one");
      db.prepare("UPDATE agent_claims SET status = 'superseded' WHERE id = ?").run(e.body.data.claimId);
      const sup = await verify("k3-exp", e.body.data.claimId, "123456");
      answers.push(["superseded", sup]);
      eq(sup.body?.data?.status, "superseded", "k3: a replaced code → superseded");
      ok(String(sup.body?.error).includes("nyeste e-posten"), "k3: … says to use the newest e-mail");
      db.prepare("UPDATE agent_claims SET status = 'rejected' WHERE id = ?").run(e.body.data.claimId);
      const rej = await verify("k3-exp", e.body.data.claimId, "123456");
      answers.push(["rejected", rej]);
      eq(rej.body?.data?.status, "rejected", "k3: a rejected claim → rejected");
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, verification_code, status, source, expires_at, created_at)
         VALUES ('k3-legacy', 'k3-exp', 'Gammel', 'x@x.example.test', '123456', 'code_sent', 'organic', ?, ?)`,
      ).run(new Date(Date.now() + HOUR).toISOString(), ago(HOUR));
      const leg = await verify("k3-exp", "k3-legacy", "123456");
      answers.push(["legacy", leg]);
      eq(leg.body?.data?.status, "expired", "k3: a pre-11=A code → expired (the page drops it)");
      const noCode = await verify("k3-exp", e.body.data.claimId, "");
      answers.push(["no code", noCode]);
      eq([noCode.status, noCode.body?.error], [400, "Skriv inn den 6-sifrede koden fra e-posten."], "k3: no code → asks for the 6-digit code");
      answers.push(["no claimId", await verify("k3-exp", undefined, "123456")]);

      for (const [label, a] of answers) {
        ok(a.body?.success === false && typeof a.body?.error === "string" && !ENGLISH.test(a.body.error) && /[æøåÆØÅ]|[Kk]oden|Kravet|Feil kode|Vi finner/.test(a.body.error),
          `AC4: ${label} — Norwegian, no English text (${JSON.stringify(a.body?.error)})`);
      }
      const src = fs.readFileSync(path.join(__dirname, "..", "services", "knowledge-service.ts"), "utf8") +
        fs.readFileSync(path.join(__dirname, "marketplace.ts"), "utf8");
      for (const s of ["Claim not found", "Already verified", "Claim is ${", "Claim has expired", "Invalid verification code", "claimId og code er påkrevd"]) {
        ok(!src.includes(s), `AC4: the old string ${JSON.stringify(s)} is gone from verifyClaim and the route`);
      }
    }

    // ══ (fmt) times on the Oslo clock ══════════════════════════════════════
    {
      const now = new Date("2026-11-01T12:00:00Z");
      eq(formatClaimTime(new Date("2026-11-01T13:05:00Z"), now), "i dag kl. 14:05", "fmt: today, Oslo time (UTC+1)");
      eq(formatClaimTime(new Date("2026-11-01T23:30:00Z"), now), "i morgen kl. 00:30", "fmt: past midnight in Oslo is tomorrow");
      eq(formatClaimTime(new Date("2026-11-03T08:00:00Z"), now), "3. november kl. 09:00", "fmt: a later day by date");
      eq(formatClaimTime(new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T09:00:00Z")), "i dag kl. 12:00", "fmt: summer time (UTC+2)");
    }

    // ══ (ui) selger.html against the real handlers ══════════════════════════
    {
      const SCRIPT_FILE = "selger.html#kravflyt";
      const script = inlineScript("selger.html", "function escHtml");
      const alertBox = (type: string, html: string) => `<div class="alert alert-${type}">${html}</div>`;
      const escRef = (s: string) => serializeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      const infoFor: Record<string, { name: string; isClaimed?: boolean }> = {};
      const calls: string[] = [];
      const realApi: FetchStub = async (url: string, o?: { method?: string }) => {
        calls.push(url);
        const body = JSON.parse((o as { body?: string } | undefined)?.body ?? "{}");
        let m = url.match(/\/api\/marketplace\/agents\/([^/]+)\/info$/);
        if (m) {
          const id = decodeURIComponent(m[1]!);
          const a = infoFor[id];
          return a ? jsonResponse({ success: true, data: { agent: { id, name: a.name, city: "Voss", isClaimed: !!a.isClaimed, isVerified: false }, knowledge: {} } })
            : jsonResponse({ success: false }, 404);
        }
        m = url.match(/\/api\/marketplace\/agents\/([^/]+)\/claim(\/verify|\/resend)?$/);
        if (!url.startsWith(API) || !m) return jsonResponse({ success: false }, 404);
        const h = m[2] === "/verify" ? verifyH : m[2] === "/resend" ? resendH : claimH;
        const r = await invoke(h, makeReq({ params: { id: m[1]! }, body }));
        return jsonResponse(r.body, r.status);
      };
      /** A Map-backed localStorage that outlives one page (a second tab shares it). */
      function storage(initial: Record<string, string> = {}) {
        const map = new Map<string, string>(Object.entries(initial));
        return {
          map,
          api: { getItem: (k: string) => (map.has(k) ? map.get(k)! : null), setItem: (k: string, v: unknown) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); } },
          open: (): any => (map.has("rfb_open_claim") ? JSON.parse(map.get("rfb_open_claim")!) : null),
        };
      }
      /** A classList that keeps its classes, so show()/hide() can be read back. */
      function track(page: Page, id: string, hidden: boolean): () => boolean {
        const set = new Set<string>(hidden ? ["hidden"] : []);
        (page.el(id) as any).classList = {
          add: (c: string) => { set.add(c); }, remove: (c: string) => { set.delete(c); },
          toggle: (c: string, on?: boolean) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c); }, contains: (c: string) => set.has(c),
        };
        return () => set.has("hidden");
      }
      function open(search: string, store: ReturnType<typeof storage>) {
        const page = runPage("", realApi, { pathname: "/selger", search });
        page.context.localStorage = store.api;
        const step2Hidden = track(page, "claimStep2", true);
        const step2bHidden = track(page, "claimStep2b", true);
        vm.runInContext(script, page.context, { filename: SCRIPT_FILE });
        return { page, codeStepShown: () => !step2bHidden() && step2Hidden(), formShown: () => !step2Hidden() };
      }
      async function requestCode(p: ReturnType<typeof open>, agentId: string, email: string) {
        p.page.context.startClaimFlow(agentId, `Gård ${agentId}`);
        p.page.el("claimName").value = "Ola";
        p.page.el("claimEmail").value = email;
        p.page.el("btnRequestClaim").click();
        await settle();
      }

      // Ids in UUID form: a non-UUID agent= takes the page's legacy search path.
      const UI1 = "c1a1c1a1-0000-4000-8000-000000000001";
      const UI2 = "c1a1c1a1-0000-4000-8000-000000000002";
      const UI3 = "c1a1c1a1-0000-4000-8000-000000000003";
      const UI4 = "c1a1c1a1-0000-4000-8000-000000000004";
      // ── AC2: kept, restored in a new tab for the same store, cleared after verify ──
      agent(UI1, "post@ui1.example.test");
      infoFor[UI1] = { name: "Gård ui1" };
      const store = storage();
      const tab1 = open(`?agent=${UI1}`, store);
      await settle();
      eq(tab1.page.el("singleStore").style.display, "", "ui: setup — the store card is shown for ?agent=");
      await requestCode(tab1, UI1, "ola@ui1.example.test");
      const kept = store.open();
      const row = claimsOf(UI1)[0];
      eq(kept && [kept.agentId, kept.claimId, kept.sentTo, kept.expiresAt], [UI1, row.id, maskEmail("post@ui1.example.test"), row.expires_at],
        "AC2: the open claim is kept in localStorage (store, claimId, masked recipient, expiry)");
      ok(!JSON.stringify(kept).includes("post@ui1.example.test") && !JSON.stringify(kept).includes(row.verification_code), "AC2: … never the full address or the code");

      const tab2 = open(`?agent=${UI1}`, store);
      await settle();
      eq(tab2.codeStepShown(), true, "AC2: a new tab for the same store opens the code field at once");
      eq(tab2.page.context.claimId, row.id, "AC2: … bound to the stored claimId");
      eq(tab2.page.el("singleStore").style.display, "none", "AC2: … the store card gives way to the code step");
      eq(tab2.page.el("verifyAlert").innerHTML, alertBox("info", escRef(`Koden er alt sendt til gårdens e-post ${maskEmail("post@ui1.example.test")}. Skriv den inn her.`)),
        "AC2: … saying the code is already sent to the farm's e-mail (masked)");
      eq(calls.filter((u) => u.endsWith(`/${UI1}/claim`)).length, 1, "AC2: … without asking for a new code");

      const right = row.verification_code;
      const wrong = right === "999999" ? "999998" : "999999";
      tab2.page.el("verifyCode").value = wrong;
      tab2.page.el("btnVerifyClaim").click();
      await settle();
      ok(tab2.page.el("verifyAlert").innerHTML.includes("Du har 4 forsøk igjen"), "AC4: the page shows the tries left on a wrong code");
      eq(store.open()?.claimId, row.id, "AC2: a wrong code keeps the open claim");
      tab2.page.el("verifyCode").value = right;
      tab2.page.el("btnVerifyClaim").click();
      await settle();
      eq(claimRow(row.id).status, "verified", "AC2: the right code in the new tab verifies the claim");
      eq(store.open(), null, "AC2: … and the open claim is cleared");

      // ── cleared on expiry, kept for its own store only ──
      agent(UI2, "post@ui2.example.test");
      infoFor[UI2] = { name: "Gård ui2" };
      const expStore = storage({ rfb_open_claim: JSON.stringify({ agentId: UI2, claimId: "c-old", sentTo: "p***@x.no", expiresAt: ago(MIN), resendAvailableAt: null }) });
      const tExp = open(`?agent=${UI2}`, expStore);
      await settle();
      eq([tExp.codeStepShown(), tExp.page.el("singleStore").style.display, expStore.open()], [false, "", null],
        "AC2: an expired open claim is not restored and is cleared; the store card shows");
      const otherStore = storage({ rfb_open_claim: JSON.stringify({ agentId: UI1, claimId: "c-x", sentTo: "p***@x.no", expiresAt: new Date(Date.now() + HOUR).toISOString() }) });
      const tOther = open(`?agent=${UI2}`, otherStore);
      await settle();
      eq([tOther.codeStepShown(), otherStore.open()?.claimId], [false, "c-x"], "AC2: an open claim for another store is not shown and is kept");

      // ── a verify that finds the claim closed clears it (expired / replaced) ──
      agent(UI3, "post@ui3.example.test");
      infoFor[UI3] = { name: "Gård ui3" };
      const s3 = storage();
      const t3 = open(`?agent=${UI3}`, s3);
      await settle();
      await requestCode(t3, UI3, "ola@ui3.example.test");
      const id3 = claimsOf(UI3)[0].id;
      db.prepare("UPDATE agent_claims SET expires_at = ? WHERE id = ?").run(ago(MIN), id3);
      t3.page.el("verifyCode").value = "123456";
      t3.page.el("btnVerifyClaim").click();
      await settle();
      ok(t3.page.el("verifyAlert").innerHTML.includes("Koden er utløpt"), "AC2: a code that expired meanwhile → the Norwegian message");
      eq(s3.open(), null, "AC2: … and the open claim is cleared");

      // ── another device (empty storage): same e-mail → code_already_sent, kept there too ──
      agent(UI4, "post@ui4.example.test");
      infoFor[UI4] = { name: "Gård ui4" };
      const pc = open(`?agent=${UI4}`, storage());
      await settle();
      await requestCode(pc, UI4, "ola@ui4.example.test");
      const id4 = claimsOf(UI4)[0].id;
      const mailsBefore = mails.length;
      const phoneStore = storage();
      const phone = open(`?agent=${UI4}`, phoneStore);
      await settle();
      phone.page.el("btnSingleStoreClaim").click();
      eq(phone.formShown(), true, "ui: on the phone «Dette er min butikk» opens the form (nothing stored there)");
      await requestCode(phone, UI4, "Ola@UI4.example.test");
      eq([phone.codeStepShown(), phone.page.context.claimId, mails.length, claimsOf(UI4).length], [true, id4, mailsBefore, 1],
        "AC1/AC2: the same e-mail on another device → the code field for the same claim, no new code");
      eq(phone.page.el("verifyAlert").innerHTML, alertBox("info", escRef(`Koden er alt sendt til gårdens e-post ${maskEmail("post@ui4.example.test")}. Skriv den inn her.`)),
        "ui: … with the server's message");
      eq(phoneStore.open()?.claimId, id4, "ui: … and the claim is kept on that device too");

      // ── «Send koden på nytt» on the page ──
      sentAgo(id4, 11 * MIN);
      const resendMails = mails.length;
      phone.page.el("btnResendClaimCode").click();
      await settle();
      eq([mails.length, mails[mails.length - 1]?.to], [resendMails + 1, "post@ui4.example.test"], "ui: «Send koden på nytt» sends one mail to the farm address");
      ok(phone.page.el("verifyAlert").innerHTML.includes("Koden er sendt på nytt til gårdens e-post"), "ui: … and says so");
      eq([phone.page.el("btnResendClaimCode").style.display, phoneStore.open()?.resendAvailableAt], ["none", null], "ui: … the button goes (once only), also after a reload");
      const phone2 = open(`?agent=${UI4}`, phoneStore);
      await settle();
      eq([phone2.codeStepShown(), phone2.page.el("btnResendClaimCode").style.display], [true, "none"], "ui: a reload restores the code field without the used resend");

      // ── the search path restores too; a store with an owner now drops it ──
      const viaSearch = open("", storage({ rfb_open_claim: phoneStore.map.get("rfb_open_claim")! }));
      await settle();
      viaSearch.page.context.startClaimFlow(UI4, "Gård ui4");
      eq([viaSearch.codeStepShown(), viaSearch.page.context.claimId], [true, id4], "ui: choosing the same store from the search also brings the code field back");
      infoFor[UI4] = { name: "Gård ui4", isClaimed: true };
      const ownedStore = storage({ rfb_open_claim: phoneStore.map.get("rfb_open_claim")! });
      open(`?agent=${UI4}`, ownedStore);
      await settle();
      eq(ownedStore.open(), null, "ui: a store that has an owner now drops the open claim kept for it");
    }

    // ══ (k2) the store first; no Siri ═══════════════════════════════════════
    {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
      const at = (s: string) => html.indexOf(s);
      const button = at(">Dette er min butikk</button>");
      ok(button > 0 && button < at('class="claim-hero"'), "AC3: «Dette er min butikk» comes before the registration hero in the HTML");
      ok(button < at(">Allerede registrert?</h3>") && button < at('id="registerSection"') && button < at('id="findSection"'),
        "AC3: … and before «Allerede registrert?», the search and the registration form");
      ok(at('id="viewClaim"') < at('id="singleStore"') &&
        html.slice(at('id="viewClaim"') + 'id="viewClaim">'.length, at('id="singleStore"')).replace(/<!--[\s\S]*?-->/g, "").trim() === '<div class="card"',
        "AC3: the store card is the first element in the claim view (above the fold on a phone too)");
      ok(!html.includes("Siri"), "AC3: the word «Siri» is not on the page");
      ok(html.includes("<h1>Gjør butikken din synlig for AI</h1>") && html.includes("<p>Registrer deg på Rett fra Bonden. Det tar under 2 minutter.</p>"),
        "k2: the rest of the hero text stands");
      ok(!/ChatGPT, Claude eller Siri|finner deg automatisk/.test(html), "k2: the «… finner deg automatisk» promise is gone from the hero");
    }

    // ══ (mig) resend_count / resent_at are additive ═════════════════════════
    {
      const old = new Database(":memory:");
      initMod.__initSchemaForTesting(old);
      old.pragma("foreign_keys = OFF");
      old.exec("ALTER TABLE agent_claims DROP COLUMN resend_count");
      old.exec("ALTER TABLE agent_claims DROP COLUMN resent_at");
      old.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, code_sent_to) VALUES ('o1', 'x', 'n', 'e@x.no', 'code_sent', 'p@x.no')").run();
      initMod.__initSchemaForTesting(old);
      initMod.__initSchemaForTesting(old);
      const cols = (old.prepare("PRAGMA table_info(agent_claims)").all() as Array<{ name: string }>).map((c) => c.name);
      eq([cols.filter((c) => c === "resend_count").length, cols.filter((c) => c === "resent_at").length], [1, 1], "mig: resend_count and resent_at added once (idempotent)");
      eq(old.prepare("SELECT status, code_sent_to, resend_count, resent_at FROM agent_claims WHERE id = 'o1'").get(),
        { status: "code_sent", code_sent_to: "p@x.no", resend_count: 0, resent_at: null }, "mig: an existing row keeps its values, resend_count 0, resent_at NULL");
      old.close();
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-claim-kravflyt: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  runRfbClaimKravflytTests({ log: true }).then((r) => {
    console.log(`\nrfb-claim-kravflyt: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
