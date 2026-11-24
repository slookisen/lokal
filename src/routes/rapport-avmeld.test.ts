/**
 * rapport-avmeld.test.ts — /rapport-avmeld/:token, the monthly owner report's
 * unsubscribe (dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-4).
 * Real express app on an ephemeral port, own in-memory DB via the route's
 * seam. GET writes nothing; POST (form or RFC 8058 one-click) sets
 * notify.report = off with one audit row, idempotently, also while the entry
 * is coming_soon; forged / foreign tokens and a missing secret → 404, no
 * write; the recipientOptOut write option never writes anything but "off";
 * the report builder then answers notify_report_off. Every env var the code
 * reads is set (or cleared) explicitly and restored in finally.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { makeUnsubscribeToken } from "../services/avmeld-service";
import { makeOwnerPreviewToken } from "./owner-preview";
import {
  buildOwnerMonthlyReport,
  makeOwnerReportUnsubToken,
  ownerReportUnsubscribeUrl,
  parseReportMonth,
} from "../services/owner-monthly-report";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus, visibleOwnerFeatureOptions } from "../owner-features/registry";
import { resolveOwnerFeature, setOwnerFeatureValue } from "../owner-features/resolve";
import rapportAvmeldRouter, { __setRapportAvmeldDbForTesting } from "./rapport-avmeld";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = Date.parse("2026-11-23T12:00:00Z");

export async function runRapportAvmeldTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  setEnv("ADMIN_KEY", "rapport-avmeld-test-key");
  setEnv("ANALYTICS_ADMIN_KEY", undefined);
  setEnv("UNSUBSCRIBE_TOKEN_SECRET", "rapport-avmeld-test-secret");
  setEnv("APP_URL", "https://report.example.test");
  setEnv("PROFILE_AI_DELIVERIES_COUNTING_SINCE", "2026-09-01");
  setEnv("ANALYTICS_ROLLUP_READ", undefined);

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const errors: string[] = [];
  const origError = console.error;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setRapportAvmeldDbForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active, catalog_hidden)
       VALUES (?, ?, 'test agent', 'test', 'eier@example.no', 'https://example.no', 'producer', ?, 'rfb', ?, 1, 0)`,
    );
    insertAgent.run("ra-a", "Bakken Gård", "k1", "2026-01-01T00:00:00Z");
    insertAgent.run("ra-b", "Annen Gård", "k2", "2026-01-01T00:00:00Z");
    insertAgent.run("ra-c", "Tredje Gård", "k3", "2026-01-01T00:00:00Z");

    const registry = ownerFeatureRegistryFor("rfb");
    const entry = getOwnerFeature("notify.report", registry);
    ok(entry.recipientOptOut === "off" && visibleOwnerFeatureOptions(entry).some((o) => o.value === "off"),
      "registry: notify.report declares recipientOptOut «off», a visible option");
    ok(ownerFeatureStatus(entry) === "coming_soon", "registry: notify.report is coming_soon (the edge case this slice covers)");
    ok(registry.filter((e) => e.recipientOptOut !== undefined).map((e) => e.key).join(",") === "notify.report,notify.milestones,notify.changes",
      "registry: only notify.report, (S5-5) notify.milestones and (S5-6) notify.changes declare a recipient opt-out");

    // ── The write option (service level) ─────────────────────────────────
    const audits = (id: string) =>
      db.prepare("SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const settings = (id: string) =>
      db.prepare("SELECT key, value_json, set_by FROM owner_feature_settings WHERE subject_id = ?").all(id) as any[];
    const actor = { actor: "system" as const, detail: "rapport-avmeld" };

    // A normal write of a coming_soon key stays blocked — unchanged for every other caller.
    const plain = setOwnerFeatureValue("rfb", "ra-c", "notify.report", "off", actor, { db });
    ok(plain.kind === "blocked" && (plain as any).block === "coming_soon", "option: without it, a coming_soon key is still blocked");
    for (const v of ["monthly", "quarterly", true, false, null, "OFF", " off"]) {
      const r = setOwnerFeatureValue("rfb", "ra-c", "notify.report", v, actor, { db, recipientOptOut: true });
      ok(r.kind === "invalid_value", `option: value ${JSON.stringify(v)} is refused (only «off»)`);
    }
    const live = registry.map((e) => (e.key === "notify.report" ? { ...e, status: "live" as const } : e));
    ok(setOwnerFeatureValue("rfb", "ra-c", "notify.report", "monthly", actor, { db, registry: live, recipientOptOut: true }).kind === "invalid_value",
      "option: a non-off value is refused even with the entry live");
    ok(setOwnerFeatureValue("rfb", "ra-c", "notify.order_sms", false, actor, { db, recipientOptOut: true }).kind === "invalid_value",
      "option: an entry without recipientOptOut is refused");
    ok(setOwnerFeatureValue("rfb", "ra-c", "comms.news", false, actor, { db, recipientOptOut: true }).kind === "invalid_value",
      "option: another key's off value is refused");
    ok(audits("ra-c").length === 0 && settings("ra-c").length === 0, "option: refused calls wrote nothing");

    // ── Route ────────────────────────────────────────────────────────────
    const app = express();
    app.use("/", rapportAvmeldRouter);
    server = http.createServer(app);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as any).port;
    const call = (path: string, method = "GET", body?: string) =>
      new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (body !== undefined) {
          headers["content-type"] = "application/x-www-form-urlencoded";
          headers["content-length"] = String(Buffer.byteLength(body));
        }
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode || 0, text: data, headers: res.headers }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as any).n as number;
    const counts = () =>
      ["agents", "owner_feature_settings", "owner_feature_audit", "email_bounces", "agent_blocklist"]
        .map((t) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n; } catch { return -1; } })
        .join(",");
    // Capture error logs: the token must never be logged.
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    const tokA = makeOwnerReportUnsubToken("ra-a")!;
    ok(!!tokA && ownerReportUnsubscribeUrl("ra-a") === `https://report.example.test/rapport-avmeld/${tokA}`, "token: the report's link points at this route");
    const pathA = `/rapport-avmeld/${tokA}`;

    // GET: confirmation only, changes nothing.
    const c0 = changes();
    const before = counts();
    const g = await call(pathA);
    ok(g.status === 200 && g.text.includes("Ikke send flere rapporter") && /<form method="post"/.test(g.text), "GET: confirmation page with a POST button");
    ok(g.text.includes('lang="nb"') && g.text.includes("noindex"), "GET: bokmål page, noindex");
    ok(g.headers["cache-control"] === "no-store" && g.headers["referrer-policy"] === "no-referrer", "GET: no-store, no-referrer");
    ok(!g.text.includes(tokA) && !g.text.includes(tokA.split(".")[1]), "GET: the token is not echoed");
    ok(g.text.includes("https://report.example.test/eier/ra-a/valg#"), "GET: links to «Mine valg»");
    await call(pathA);
    ok(changes() === c0 && counts() === before, "GET: no DB writes (twice)");
    ok(resolveOwnerFeature("rfb", "ra-a", "notify.report", { db }).value === "monthly", "GET: notify.report still the default monthly");

    // Bad tokens → neutral 404, no write.
    const [payloadA, sigA] = tokA.split(".");
    const flip = (x: string) => x.slice(0, -1) + (x.endsWith("A") ? "B" : "A");
    const otherPayload = Buffer.from("ru1\nra-b").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad: Array<[string, string]> = [
      ["tampered signature", `${payloadA}.${flip(sigA)}`],
      ["other agent, old signature", `${otherPayload}.${sigA}`],
      ["/avmeld token", makeUnsubscribeToken("eier@example.no")!],
      ["preview token", makeOwnerPreviewToken("ra-a", Math.floor(NOW / 1000) + 86400 * 365 * 10)!],
      ["garbage", "garbage"],
      ["no signature", `${payloadA}.`],
    ];
    const notFoundText = (await call("/rapport-avmeld/garbage")).text;
    for (const [label, t] of bad) {
      const gr = await call(`/rapport-avmeld/${encodeURIComponent(t)}`);
      const pr = await call(`/rapport-avmeld/${encodeURIComponent(t)}`, "POST", "List-Unsubscribe=One-Click");
      ok(gr.status === 404 && pr.status === 404 && gr.text === notFoundText && pr.text === notFoundText, `bad token (${label}): GET and POST → the same neutral 404`);
    }
    const tokGhost = makeOwnerReportUnsubToken("ra-ghost")!;
    const ghostG = await call(`/rapport-avmeld/${tokGhost}`);
    const ghostP = await call(`/rapport-avmeld/${tokGhost}`, "POST", "");
    ok(ghostG.status === 404 && ghostP.status === 404 && ghostG.text === notFoundText && ghostP.text === notFoundText, "unknown agent: the same neutral 404");
    ok(changes() === c0 && counts() === before, "bad tokens / unknown agent: no DB writes");

    // No signing secret configured → fail closed.
    setEnv("UNSUBSCRIBE_TOKEN_SECRET", undefined);
    setEnv("ADMIN_KEY", undefined);
    try {
      const ng = await call(pathA);
      const np = await call(pathA, "POST", "List-Unsubscribe=One-Click");
      ok(ng.status === 404 && np.status === 404 && changes() === c0, "no secret: valid-looking token → 404, no write (fail closed)");
    } finally {
      setEnv("UNSUBSCRIBE_TOKEN_SECRET", "rapport-avmeld-test-secret");
      setEnv("ADMIN_KEY", "rapport-avmeld-test-key");
    }

    // POST (the form button): sets off + one audit row.
    const p1 = await call(pathA, "POST", "");
    ok(p1.status === 200 && p1.text.includes("Du får ikke flere rapporter"), "POST: «Du får ikke flere rapporter»");
    ok(p1.text.includes("https://report.example.test/eier/ra-a/valg#") && !p1.text.includes(tokA), "POST: links to «Mine valg», token not echoed");
    ok(p1.headers["cache-control"] === "no-store" && p1.headers["referrer-policy"] === "no-referrer", "POST: no-store, no-referrer");
    const a1 = audits("ra-a");
    ok(a1.length === 1 && a1[0].key === "notify.report" && a1[0].old_json === '"monthly"' && a1[0].new_json === '"off"'
      && a1[0].actor === "system" && a1[0].actor_detail === "rapport-avmeld", "POST: exactly one audit row monthly → off, actor system / rapport-avmeld");
    const s1 = settings("ra-a");
    ok(s1.length === 1 && s1[0].key === "notify.report" && s1[0].value_json === '"off"' && s1[0].set_by === "system", "POST: one settings row notify.report = off");
    const res1 = resolveOwnerFeature("rfb", "ra-a", "notify.report", { db });
    ok(res1.value === "off" && res1.block === "coming_soon", "POST: resolves to off while the entry stays coming_soon");

    // Second POST: idempotent.
    const p2 = await call(pathA, "POST", "");
    ok(p2.status === 200 && p2.text === p1.text, "POST again: the same page");
    ok(audits("ra-a").length === 1 && settings("ra-a").length === 1, "POST again: no new audit row, no new settings row");

    // RFC 8058 one-click body on another agent.
    const tokB = makeOwnerReportUnsubToken("ra-b")!;
    const pb = await call(`/rapport-avmeld/${tokB}`, "POST", "List-Unsubscribe=One-Click");
    ok(pb.status === 200 && pb.text.includes("Du får ikke flere rapporter"), "one-click: 200");
    ok(audits("ra-b").length === 1 && resolveOwnerFeature("rfb", "ra-b", "notify.report", { db }).value === "off", "one-click: off + one audit row");

    // Only notify.report was touched; no profile change, no outreach suppression.
    const agentsRow = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE is_active = 1 AND catalog_hidden = 0").get() as any;
    ok(agentsRow.n === 3, "POST: no profile hidden or deactivated");
    ok((db.prepare("SELECT COUNT(*) AS n FROM email_bounces").get() as any).n === 0, "POST: no outreach suppression row");
    ok((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE key != 'notify.report'").get() as any).n === 0, "POST: no other key audited");
    ok(audits("ra-c").length === 0, "POST: other agents untouched");

    // The report builder sees «off».
    const oct = parseReportMonth("2026-10", NOW)!;
    const rA = buildOwnerMonthlyReport(db as any, "ra-a", oct, { nowMs: NOW })!;
    ok(rA.notifyReport === "off" && rA.notifyReportStatus === "coming_soon" && rA.wouldSend === false && rA.wouldSendReason === "notify_report_off",
      "report: after the unsubscribe, would_send false / notify_report_off");
    const rC = buildOwnerMonthlyReport(db as any, "ra-c", oct, { nowMs: NOW })!;
    ok(rC.notifyReport === "monthly" && rC.wouldSend === true, "report: an agent that did not unsubscribe is unchanged");
    // And once the entry goes live, the stored off is the owner's value.
    const rLive = buildOwnerMonthlyReport(db as any, "ra-a", oct, { nowMs: NOW, registry: live })!;
    ok(rLive.notifyReport === "off" && rLive.wouldSendReason === "notify_report_off", "report: entry live → stored off still applies");

    // An admin lock is reported (409), not silently ignored.
    db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', 'ra-c', 'notify.report', '"monthly"', 'admin', 1, '2026-11-01T00:00:00Z')`,
    ).run();
    const locked = await call(`/rapport-avmeld/${makeOwnerReportUnsubToken("ra-c")!}`, "POST", "");
    ok(locked.status === 409 && audits("ra-c").length === 0, "admin lock: 409 page, nothing written");

    ok(errors.every((e) => !e.includes(tokA) && !e.includes(sigA) && !e.includes(tokB)), "logs: the token is never logged");
  } catch (err: any) {
    s.failed++;
    s.failures.push("✗ rapport-avmeld: unexpected error: " + String(err?.stack || err));
  } finally {
    console.error = origError;
    __setRapportAvmeldDbForTesting(null);
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
  runRapportAvmeldTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
