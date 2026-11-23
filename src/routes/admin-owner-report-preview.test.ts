/**
 * admin-owner-report-preview.test.ts — monthly owner report e-mail template +
 * admin-only preview (dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-3).
 * Service-level render checks on a fixed clock, then
 * GET /admin/agents/:id/owner-report-preview over a real express app on an
 * ephemeral port, own in-memory DB via the route's seam. Every env var the
 * code reads is set (or cleared) explicitly and restored in finally.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { makeUnsubscribeToken, verifyUnsubscribeToken } from "../services/avmeld-service";
import { makeOwnerPreviewToken, verifyOwnerPreviewToken } from "./owner-preview";
import {
  buildOwnerMonthlyReport,
  defaultReportMonth,
  makeOwnerReportUnsubToken,
  parseReportMonth,
  renderOwnerMonthlyReport,
  verifyOwnerReportUnsubToken,
} from "../services/owner-monthly-report";
import { ownerFeatureRegistryFor } from "../owner-features/registry";
import ownerReportPreviewRouter, { __setOwnerReportPreviewDbForTesting } from "./admin-owner-report-preview";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CLAUDE_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
// Fixed clock: 23 Nov 2026, 12:00 UTC → default month 2026-10.
const NOW = Date.parse("2026-11-23T12:00:00Z");

export async function runOwnerReportPreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const s: TestSummary = { passed: 0, failed: 0, failures: [] };
  const ok = (cond: boolean, label: string) => {
    if (cond) {
      s.passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      s.failed++;
      s.failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  };

  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const KEY = "owner-report-preview-test-key";
  setEnv("ADMIN_KEY", KEY);
  setEnv("ANALYTICS_ADMIN_KEY", undefined);
  setEnv("UNSUBSCRIBE_TOKEN_SECRET", "owner-report-preview-test-secret");
  setEnv("APP_URL", "https://report.example.test");
  setEnv("PROFILE_AI_DELIVERIES_COUNTING_SINCE", "2026-09-01");
  setEnv("ANALYTICS_ROLLUP_READ", undefined);

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setOwnerReportPreviewDbForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active, catalog_hidden)
       VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', ?, 1, 0)`,
    );
    insertAgent.run("rp-a", "Bakken Gård", "k1", "2026-01-01T00:00:00Z");
    insertAgent.run("rp-zero", "Stille Gård", "k2", "2026-01-01T00:00:00Z");
    insertAgent.run("rp-xss", `<script>alert(1)</script> "Gård" & Co`, "k3", "2026-01-01T00:00:00Z");
    insertAgent.run("rp-plain", "Ikke Eid", "k4", null);
    insertAgent.run("rp-off", "Av Gård", "k5", "2026-01-01T00:00:00Z");

    // Raw floor of analytics_agent_views = 2026-10-10 → days before it come from agent_view_daily.
    db.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, created_at) VALUES ('rp-a', 'Bakken Gård', '2026-10-10 08:00:00')").run();
    const daily = db.prepare("INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, ?, ?, '', ?)");
    daily.run("2026-10-05", "rp-a", "direct", 3); // stored, in October
    daily.run("2026-10-06", "rp-a", "legacy_unclassified", 50); // legacy bucket: never counted
    daily.run("2026-10-12", "rp-a", "direct", 100); // on/after the raw floor: never counted (raw covers it)
    daily.run("2026-09-20", "rp-a", "direct", 7); // before classification began: never counted

    const pv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
       VALUES (?, 'direct', 'h', ?, ?, 200, 'rfb', ?)`,
    );
    const pathA = "/produsent/bakken-gard";
    pv.run(pathA, `s1:${CHROME_UA}`, 0, "2026-10-15 10:00:00");
    pv.run(pathA, `s1:${CHROME_UA}`, 0, "2026-10-15 10:01:00");
    pv.run(pathA, `s2:${CHROME_UA}`, 0, "2026-10-20 10:00:00");
    pv.run(pathA, `s3:${CHROME_UA}`, 0, "2026-10-31 23:59:59");
    pv.run(pathA, `s4:${CHROME_UA}`, 0, "2026-11-02 09:00:00"); // November: not October
    pv.run(pathA, `s5:${CHROME_UA}`, 1, "2026-10-16 09:00:00"); // the owner: left out
    pv.run(pathA, `s6:${CLAUDE_USER}`, 0, "2026-10-17 09:00:00"); // AI search: not a person
    pv.run(pathA, `s7:${CHROME_UA}`, 0, "2026-10-09 09:00:00"); // before the raw floor: stored part covers it

    const click = db.prepare("INSERT INTO contact_clicks (agent_id, kind, session_id, is_bot, created_at) VALUES (?, ?, ?, ?, ?)");
    click.run("rp-a", "phone", "c1", 0, "2026-10-03 10:00:00");
    click.run("rp-a", "phone", "c2", 0, "2026-10-31 22:00:00");
    click.run("rp-a", "website", "c3", 0, "2026-10-14 10:00:00");
    click.run("rp-a", "phone", "c4", 1, "2026-10-14 10:00:00"); // bot
    click.run("rp-a", "phone", "c5", 0, "2026-11-01 00:00:00"); // November
    click.run("rp-a", "email", "c6", 0, "2026-09-10 10:00:00"); // September

    const deliv = db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, 'mcp', 'claude', ?)");
    deliv.run("rfb", "rp-a", "2026-10-02", 4);
    deliv.run("rfb", "rp-a", "2026-10-30", 2);
    deliv.run("gardssalg", "rp-a", "2026-10-02", 9); // other vertical
    deliv.run("rfb", "rp-a", "2026-08-30", 9); // before counting started

    db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', 'rp-off', 'notify.report', '"off"', 'owner', 0, '2026-11-01T00:00:00Z')`,
    ).run();

    // ── Month parsing ────────────────────────────────────────────────────
    ok(defaultReportMonth(NOW) === "2026-10", "month: default = previous Oslo month");
    ok(defaultReportMonth(Date.parse("2026-12-31T23:30:00Z")) === "2026-12", "month: Oslo is already in January at 23:30 UTC 31 Dec");
    ok(defaultReportMonth(Date.parse("2027-01-15T12:00:00Z")) === "2026-12", "month: January → previous December");
    const oct = parseReportMonth("2026-10", NOW);
    ok(!!oct && oct.from === "2026-10-01" && oct.to === "2026-10-31" && oct.label === "oktober 2026", "month: 2026-10 → 1–31 Oct, «oktober 2026»");
    ok(parseReportMonth("2024-02", NOW)?.to === "2024-02-29", "month: leap February");
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "abc", "", "2026-10-01", "2019-12", "2026-12"]) {
      ok(parseReportMonth(bad, NOW) === null, `month: «${bad}» rejected`);
    }
    ok(parseReportMonth(123 as unknown, NOW) === null, "month: non-string rejected");
    ok(parseReportMonth("2026-11", NOW) !== null, "month: current month allowed (partial)");

    // ── Normal month ─────────────────────────────────────────────────────
    const r = buildOwnerMonthlyReport(db as any, "rp-a", oct!, { nowMs: NOW })!;
    ok(!!r, "build: known agent");
    ok(r.metrics.views?.value === 3 + 4, "views: 3 stored (5 Oct) + 4 raw people's views (owner, AI, Nov, pre-floor raw, legacy, post-floor stored out)");
    ok(r.metrics.views?.countedFrom === "2026-10-04", "views: counted from 4 Oct (classification start), not the whole month");
    ok(r.metrics.clicks?.value === 3 && r.metrics.clicks.byKind.phone === 2 && r.metrics.clicks.byKind.website === 1, "clicks: 3 (bot, Nov and Sep out)");
    ok(r.metrics.aiSearches?.value === 6 && r.metrics.aiSearches.countedFrom === null, "AI searches: 6 (rfb only, whole month)");
    ok(r.previous.clicks?.value === 1 && r.previous.aiSearches?.value === 0, "previous month: 1 click, 0 AI searches");
    ok(r.previous.views === null, "previous month: views have no source for September → null");
    ok(r.subject === "Profilen din i oktober 2026 – Rett fra Bonden", "render: subject");
    ok(r.text.includes("Bakken Gård") && r.text.includes("oktober 2026"), "render: name and month in the text");
    ok(r.text.includes("- Besøk på profilen: 7 (telt fra 4. oktober)"), "render: partial views line says «telt fra»");
    ok(r.text.includes("- Med i treffene til AI-assistenter: 6 (0 måneden før)"), "render: AI line compares with the previous month");
    ok(r.text.includes("- Trykk på telefon, e-post eller nettside: 3 (1 måneden før)"), "render: clicks line compares with the previous month");
    ok(r.text.includes("https://report.example.test/eier/rp-a/valg#"), "render: link to «Mine valg» (/eier/:id/valg)");
    ok(r.html.includes('href="https://report.example.test/eier/rp-a/valg#'), "render: HTML link to «Mine valg»");
    ok(!/NaN|undefined|Infinity/.test(r.text + r.html), "render: no NaN/undefined/Infinity");
    ok(r.isOwner && r.notifyReport === "monthly" && r.wouldSend === true && r.wouldSendReason === "would_send_if_sending_existed", "would_send: owner with default monthly");

    // Unsubscribe link at the bottom.
    ok(!!r.unsubscribeUrl && r.unsubscribeUrl.startsWith("https://report.example.test/rapport-avmeld/"), "unsubscribe: URL on the public base");
    const tok = r.unsubscribeUrl!.slice(r.unsubscribeUrl!.lastIndexOf("/") + 1);
    ok(r.text.trimEnd().endsWith(r.unsubscribeUrl!), "unsubscribe: last line of the text");
    const hi = r.html.indexOf(r.unsubscribeUrl!);
    ok(hi > r.html.indexOf("<hr") && r.html.indexOf("Ikke send flere rapporter") > 0, "unsubscribe: in the HTML footer");
    ok(r.text.includes("Endre hvor ofte du får rapporten"), "unsubscribe: «endre hvor ofte» link");

    // ── Token scope isolation ────────────────────────────────────────────
    ok(verifyOwnerReportUnsubToken(tok) === "rp-a", "token: round-trip");
    ok(verifyOwnerReportUnsubToken(tok.slice(0, -2) + (tok.endsWith("xx") ? "yy" : "xx")) === null, "token: tampered → invalid");
    const [, sig] = tok.split(".");
    const forged = Buffer.from("ru1\nrp-zero").toString("base64").replace(/=+$/, "");
    ok(verifyOwnerReportUnsubToken(`${forged}.${sig}`) === null, "token: other agent with old signature → invalid");
    ok(verifyUnsubscribeToken(tok) === null, "token: report token is not an /avmeld token");
    ok(verifyOwnerPreviewToken(tok).status === "invalid", "token: report token is not a preview token");
    ok(verifyOwnerReportUnsubToken(makeUnsubscribeToken("rp-a")!) === null, "token: /avmeld token is not a report token");
    ok(verifyOwnerReportUnsubToken(makeOwnerPreviewToken("rp-a", Math.floor(NOW / 1000) + 100)!) === null, "token: preview token is not a report token");
    ok(verifyOwnerReportUnsubToken("garbage") === null && verifyOwnerReportUnsubToken("") === null, "token: garbage → invalid");
    {
      const keep = { u: process.env.UNSUBSCRIBE_TOKEN_SECRET, a: process.env.ADMIN_KEY };
      delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
      delete process.env.ADMIN_KEY;
      try {
        ok(makeOwnerReportUnsubToken("rp-a") === null && verifyOwnerReportUnsubToken(tok) === null, "token: no secret → none minted, none verified (fail closed)");
        const noSecret = buildOwnerMonthlyReport(db as any, "rp-a", oct!, { nowMs: NOW })!;
        ok(noSecret.unsubscribeUrl === null && noSecret.wouldSend === false && noSecret.wouldSendReason === "no_signing_secret"
          && !noSecret.html.includes("rapport-avmeld"), "no secret: no one-click link, would_send false");
      } finally {
        process.env.UNSUBSCRIBE_TOKEN_SECRET = keep.u;
        process.env.ADMIN_KEY = keep.a;
      }
    }

    // ── Zero month ───────────────────────────────────────────────────────
    const z = buildOwnerMonthlyReport(db as any, "rp-zero", oct!, { nowMs: NOW })!;
    ok(z.metrics.clicks?.value === 0 && z.metrics.aiSearches?.value === 0 && (z.metrics.views?.value ?? 0) === 0, "zero: all numbers 0");
    ok(z.text.includes("Det var stille denne måneden"), "zero: friendly quiet-month sentence");
    ok(!/NaN|undefined|Infinity/.test(z.text + z.html), "zero: no NaN/undefined/Infinity");
    ok(z.text.includes("- Med i treffene til AI-assistenter: 0 (samme som måneden før)"), "zero: equal months say «samme som måneden før»");
    // A month with no source at all for views/AI: those lines are left out, never shown as 0.
    const old = buildOwnerMonthlyReport(db as any, "rp-a", parseReportMonth("2025-03", NOW)!, { nowMs: NOW })!;
    ok(old.metrics.views === null && old.metrics.aiSearches === null, "no source: views and AI searches null for March 2025");
    ok(!old.text.includes("Besøk på profilen") && !old.text.includes("Med i treffene"), "no source: lines omitted from the e-mail");
    ok(old.text.includes("Trykk på telefon"), "no source: clicks (kept indefinitely) still shown");
    // Pure render with no lines at all.
    const empty = renderOwnerMonthlyReport({
      producerName: "", month: oct!, metrics: { views: null, aiSearches: null, clicks: null }, previous: null,
      mineValgUrl: "https://x.test/eier/a/valg", unsubscribeUrl: null,
    });
    ok(empty.text.includes("Vi har ingen tall for denne måneden ennå") && !/NaN|undefined/.test(empty.text + empty.html), "render: no numbers → one sentence, no NaN");

    // ── HTML escaping ────────────────────────────────────────────────────
    const x = buildOwnerMonthlyReport(db as any, "rp-xss", oct!, { nowMs: NOW })!;
    ok(!x.html.includes("<script>alert(1)") && x.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "escape: <script> in the name is escaped");
    ok(x.html.includes("&quot;Gård&quot; &amp; Co") && !x.html.includes('"Gård" & Co'), "escape: quotes and ampersand escaped");
    ok(!/[\r\n]/.test(x.subject), "escape: subject has no line breaks");

    // ── would_send reasons ───────────────────────────────────────────────
    const plainR = buildOwnerMonthlyReport(db as any, "rp-plain", oct!, { nowMs: NOW })!;
    ok(plainR.wouldSend === false && plainR.wouldSendReason === "not_owner", "would_send: not an owner → false, not_owner");
    // notify.report is coming_soon today. S5-4: a stored «off» (the entry's
    // recipientOptOut) is still honoured — an unsubscribe is never ignored.
    const offToday = buildOwnerMonthlyReport(db as any, "rp-off", oct!, { nowMs: NOW })!;
    ok(offToday.notifyReportStatus === "coming_soon" && offToday.notifyReport === "off" && offToday.wouldSendReason === "notify_report_off",
      "would_send: coming_soon entry with a stored «off» → off honoured (S5-4)");
    // Any other stored value is not applied while coming_soon (the default is).
    db.prepare(`UPDATE owner_feature_settings SET value_json = '"quarterly"' WHERE subject_id = 'rp-off'`).run();
    const qToday = buildOwnerMonthlyReport(db as any, "rp-off", oct!, { nowMs: NOW })!;
    ok(qToday.notifyReport === "monthly" && qToday.wouldSend === true, "would_send: coming_soon entry with a stored «quarterly» → default monthly applies");
    db.prepare(`UPDATE owner_feature_settings SET value_json = '"off"' WHERE subject_id = 'rp-off'`).run();
    // With the entry live, the owner's «off» is honoured (information only).
    const liveRegistry = ownerFeatureRegistryFor("rfb").map((e) => (e.key === "notify.report" ? { ...e, status: "live" as const, liveFlag: undefined } : e));
    const offR = buildOwnerMonthlyReport(db as any, "rp-off", oct!, { nowMs: NOW, registry: liveRegistry })!;
    ok(offR.notifyReport === "off" && offR.wouldSend === false && offR.wouldSendReason === "notify_report_off", "would_send: notify.report=off → false, notify_report_off");
    db.prepare(`UPDATE owner_feature_settings SET value_json = '"quarterly"' WHERE subject_id = 'rp-off'`).run();
    const q = buildOwnerMonthlyReport(db as any, "rp-off", oct!, { nowMs: NOW, registry: liveRegistry })!;
    const qSep = buildOwnerMonthlyReport(db as any, "rp-off", parseReportMonth("2026-09", NOW)!, { nowMs: NOW, registry: liveRegistry })!;
    ok(q.wouldSendReason === "quarterly_not_due" && qSep.wouldSend === true, "would_send: quarterly → only for a quarter's last month");
    db.prepare(`UPDATE owner_feature_settings SET value_json = '"off"' WHERE subject_id = 'rp-off'`).run();
    ok(buildOwnerMonthlyReport(db as any, "nope", oct!, { nowMs: NOW }) === null, "build: unknown agent → null");

    // ── Route ────────────────────────────────────────────────────────────
    const app = express();
    app.use("/admin/agents/:id/owner-report-preview", ownerReportPreviewRouter);
    server = http.createServer(app);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as any).port;
    const call = (path: string, key: string | null = KEY, method = "GET") =>
      new Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (key !== null) headers["x-admin-key"] = key;
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: any = undefined;
            try { parsed = data ? JSON.parse(data) : undefined; } catch { parsed = undefined; }
            resolve({ status: res.statusCode || 0, body: parsed, text: data, headers: res.headers });
          });
        });
        req.on("error", reject);
        req.end();
      });
    const base = "/admin/agents/rp-a/owner-report-preview";
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as any).n as number;
    const counts = () =>
      ["agents", "owner_feature_settings", "owner_feature_audit", "analytics_page_views", "contact_clicks", "email_bounces", "profile_ai_deliveries"]
        .map((t) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n; } catch { return -1; } })
        .join(",");
    const before = counts();
    const c0 = changes();

    ok((await call(`${base}?month=2026-10`, null)).status === 403, "route: admin key required (403)");
    ok((await call(`${base}?month=2026-10`, "wrong")).status === 403, "route: wrong key → 403");
    ok((await call("/admin/agents/nope/owner-report-preview?month=2026-10")).status === 404, "route: unknown agent → 404");
    for (const bad of ["2026-13", "2026-1", "abc", "2099-01"]) {
      ok((await call(`${base}?month=${bad}`)).status === 400, `route: month «${bad}» → 400`);
    }
    ok((await call(`${base}?month=2026-10&format=xml`)).status === 400, "route: unknown format → 400");
    const j = await call(`${base}?month=2026-10`);
    ok(j.status === 200 && j.body?.month === "2026-10" && j.body?.agent_id === "rp-a", "route: JSON 200 for the month");
    ok(typeof j.body?.subject === "string" && typeof j.body?.text === "string" && typeof j.body?.html === "string", "route: JSON carries subject/text/html");
    ok(j.body?.metrics?.clicks?.value === 3 && j.body?.would_send === true && j.body?.sending === "none", "route: numbers, would_send, sending none");
    ok(j.body?.unsubscribe?.route_live === true && typeof j.body?.links?.unsubscribe === "string", "route: unsubscribe link + route_live true (S5-4)");
    ok(j.headers["cache-control"] === "no-store", "route: no-store");
    const d = await call(base);
    ok(d.status === 200 && d.body?.month === defaultReportMonth(), "route: default month = previous Oslo month");
    const h = await call(`${base}?month=2026-10&format=html`);
    ok(h.status === 200 && String(h.headers["content-type"]).startsWith("text/html") && h.text.includes("Bakken Gård"), "route: format=html serves the e-mail HTML");
    const t = await call(`${base}?month=2026-10&format=text`);
    ok(t.status === 200 && String(t.headers["content-type"]).startsWith("text/plain") && t.text.startsWith("Hei!"), "route: format=text serves the plain text");
    const offJ = await call("/admin/agents/rp-off/owner-report-preview?month=2026-10");
    ok(offJ.status === 200 && offJ.body?.notify_report_status === "coming_soon" && offJ.body?.notify_report === "off",
      "route: JSON reports notify.report value and its coming_soon status");
    const plainJ = await call("/admin/agents/rp-plain/owner-report-preview?month=2026-10");
    ok(plainJ.body?.would_send === false && plainJ.body?.reason === "not_owner", "route: non-owner → would_send false");
    ok((await call(`${base}?month=2026-10`, KEY, "POST")).status === 404, "route: no POST (nothing to send)");
    const xh = await call("/admin/agents/rp-xss/owner-report-preview?month=2026-10&format=html");
    ok(!xh.text.includes("<script>alert(1)"), "route: html preview escapes the name");

    ok(changes() === c0 && counts() === before, "route: no DB writes (total_changes and row counts unchanged)");
  } catch (err: any) {
    s.failed++;
    s.failures.push("✗ owner-report-preview: unexpected error: " + String(err?.stack || err));
  } finally {
    __setOwnerReportPreviewDbForTesting(null);
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    db.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return s;
}

if (require.main === module) {
  runOwnerReportPreviewTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
