/**
 * admin-owner-changes-preview.test.ts — daily «something changed on your
 * profile» owner e-mail template, admin-only preview and its unsubscribe
 * (dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-6). Oslo day
 * boundaries (winter, summer, DST change), the day's changes as the owner's
 * change log shows them (owner rows, non-allowlisted fields, no-op rows and
 * notes left out), the rendered digest, then
 * GET /admin/agents/:id/owner-changes-preview and GET/POST
 * /endring-avmeld/:token over a real express app on an ephemeral port, own
 * in-memory DB via the routes' seams. Every env var the code reads is set (or
 * cleared) explicitly and restored in finally.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { makeUnsubscribeToken } from "../services/avmeld-service";
import { makeOwnerReportUnsubToken, verifyOwnerReportUnsubToken } from "../services/owner-monthly-report";
import { makeOwnerMilestoneUnsubToken, verifyOwnerMilestoneUnsubToken } from "../services/owner-milestone-email";
import {
  OWNER_CHANGES_LIST_MAX,
  buildOwnerChangesPreview,
  defaultDigestDay,
  makeOwnerChangesUnsubToken,
  ownerChangesUnsubscribeUrl,
  parseDigestDay,
  renderOwnerChangesEmail,
  verifyOwnerChangesUnsubToken,
} from "../services/owner-changes-digest";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus } from "../owner-features/registry";
import { resolveOwnerFeature, setOwnerFeatureValue } from "../owner-features/resolve";
import changesPreviewRouter, { __setOwnerChangesPreviewDbForTesting } from "./admin-owner-changes-preview";
import rapportAvmeldRouter, { __setRapportAvmeldDbForTesting } from "./rapport-avmeld";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Fixed clock: 24 Nov 2026, 12:00 UTC (13:00 in Oslo) → default day 2026-11-23.
const NOW = Date.parse("2026-11-24T12:00:00Z");

export async function runOwnerChangesPreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const KEY = "owner-changes-preview-test-key";
  const SECRET = "owner-changes-preview-test-secret";
  setEnv("ADMIN_KEY", KEY);
  setEnv("ANALYTICS_ADMIN_KEY", undefined);
  setEnv("UNSUBSCRIBE_TOKEN_SECRET", SECRET);
  setEnv("APP_URL", "https://changes.example.test");

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const errors: string[] = [];
  const origError = console.error;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setOwnerChangesPreviewDbForTesting(db as any);
    __setRapportAvmeldDbForTesting(db as any);

    // ── Oslo days ────────────────────────────────────────────────────────
    ok(defaultDigestDay(NOW) === "2026-11-23", "day: default = yesterday in Oslo");
    ok(defaultDigestDay(Date.parse("2026-11-23T23:30:00Z")) === "2026-11-23", "day: 23:30 UTC is already the 24th in Oslo → default the 23rd");
    ok(defaultDigestDay(Date.parse("2026-11-23T22:30:00Z")) === "2026-11-22", "day: 22:30 UTC is still the 23rd in Oslo → default the 22nd");
    const winter = parseDigestDay("2026-11-23", NOW)!;
    ok(winter.fromUtc === "2026-11-22T23:00:00.000Z" && winter.toUtc === "2026-11-23T23:00:00.000Z", "day: winter (CET) window 23:00Z → 23:00Z");
    ok(winter.label === "23. november 2026", "day: Norwegian label");
    const summer = parseDigestDay("2026-07-01", NOW)!;
    ok(summer.fromUtc === "2026-06-30T22:00:00.000Z" && summer.toUtc === "2026-07-01T22:00:00.000Z", "day: summer (CEST) window 22:00Z → 22:00Z");
    const fall = parseDigestDay("2026-10-25", NOW)!;
    ok(fall.fromUtc === "2026-10-24T22:00:00.000Z" && fall.toUtc === "2026-10-25T23:00:00.000Z", "day: DST end (25 hours)");
    const spring = parseDigestDay("2026-03-29", NOW)!;
    ok(spring.fromUtc === "2026-03-28T23:00:00.000Z" && spring.toUtc === "2026-03-29T22:00:00.000Z", "day: DST start (23 hours)");
    ok(parseDigestDay("2026-11-24", NOW) !== null, "day: today accepted (partial)");
    for (const bad of ["2026-11-25", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-5", "2023-12-31", "abc", "", "2026-11-23T00:00", ["2026-11-23"], null, undefined, 20261123]) {
      ok(parseDigestDay(bad, NOW) === null, `day: ${JSON.stringify(bad)} rejected`);
    }

    // ── Data ─────────────────────────────────────────────────────────────
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active, catalog_hidden)
       VALUES (?, ?, 'test agent', 'test', 'eier@example.no', 'https://example.no', 'producer', ?, 'rfb', ?, ?, 0)`,
    );
    const agents: Array<[string, string, string | null, number]> = [
      ["ch-1", "Endring Gård", "2026-01-01T00:00:00Z", 1],
      ["ch-2", "Sommer Gård", "2026-01-01T00:00:00Z", 1],
      ["ch-zero", "Stille Gård", "2026-01-01T00:00:00Z", 1],
      ["ch-many", "Travel Gård", "2026-01-01T00:00:00Z", 1],
      ["ch-plain", "Ikke Eid", null, 1],
      ["ch-inactive", "Sovende Gård", "2026-01-01T00:00:00Z", 0],
      ["ch-xss", `<script>alert(1)</script> "Gård" & Co`, "2026-01-01T00:00:00Z", 1],
      ["ch-lock", "Låst Gård", "2026-01-01T00:00:00Z", 1],
    ];
    agents.forEach(([id, name, claimed, active], i) => insertAgent.run(id, name, `k${i}`, claimed, active));
    let auditN = 0;
    const audit = (agent: string, field: string, oldV: string | null, newV: string | null, by: string, at: string, notes: string | null = null) =>
      db.prepare(
        `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`aud-${++auditN}`, agent, field, oldV, newV, by, at, notes);

    // ch-1 on 2026-11-23 (Oslo), stored in both timestamp formats.
    audit("ch-1", "phone", "111 11 111", "222 22 222", "admin", "2026-11-23 09:15:00", "INTERN-NOTAT kundeservice ringte");
    audit("ch-1", "phone", "222 22 222", "333 33 333", "owner", "2026-11-23 10:00:00"); // the owner: left out
    audit("ch-1", "website", "https://a.no", "https://eier.no", "owner", "2026-11-23 11:00:00"); // the owner: left out
    audit("ch-1", "data_source", "brreg", "SKJULT-KILDE", "system", "2026-11-23 12:00:00"); // not in the log's table
    audit("ch-1", "merge", null, "SKJULT-MERGE", "admin", "2026-11-23 12:05:00"); // not in the log's table
    audit("ch-1", "address", "Vei 1", "Vei 1", "admin", "2026-11-23 12:10:00"); // no-op
    audit("ch-1", "email", "gammel@gard.no", "ny@gard.no", "system", "2026-11-23 13:00:00"); // values hidden
    audit("ch-1", "about", "Gammel tekst", "Ny tekst, skriv til ola@gard.no", "system", "2026-11-23T14:00:00.000Z",
      "auto.updates=fill_empty; kilde=website https://eier.no; run-1");
    // Boundaries (Oslo 23 Nov = 22 Nov 23:00Z … 23 Nov 23:00Z).
    audit("ch-1", "postal_code", "0001", "0002", "admin", "2026-11-22T23:00:00Z"); // 00:00 Oslo: in
    audit("ch-1", "postal_code", "0000", "0001", "admin", "2026-11-22 22:59:59"); // 23:59:59 on the 22nd: out
    audit("ch-1", "opening_hours", "\"Lør 10-14\"", "\"Lør 10-16\"", "admin", "2026-11-23T22:59:59Z"); // 23:59:59 Oslo: in
    audit("ch-1", "postal_code", "0002", "0003", "admin", "2026-11-23T23:00:00Z"); // 00:00 on the 24th: out
    // ch-2 on 2026-07-01 (CEST).
    audit("ch-2", "phone", "1", "2", "admin", "2026-06-30T22:30:00Z"); // 00:30 Oslo on 1 Jul: in
    audit("ch-2", "phone", "0", "1", "admin", "2026-06-30T21:59:00Z"); // 23:59 on 30 Jun: out
    audit("ch-2", "phone", "2", "3", "admin", "2026-07-01T22:30:00Z"); // 00:30 on 2 Jul: out
    // ch-zero: only the owner's own changes and technical rows.
    audit("ch-zero", "phone", "1", "2", "owner", "2026-11-23 09:00:00");
    audit("ch-zero", "data_source", "a", "b", "admin", "2026-11-23 09:00:00");
    // ch-many: more than the list shows.
    for (let i = 0; i < OWNER_CHANGES_LIST_MAX + 5; i++) {
      audit("ch-many", "phone", String(i), String(i + 1), "admin", `2026-11-23 08:${String(i).padStart(2, "0")}:00`);
    }
    for (const id of ["ch-plain", "ch-inactive", "ch-xss", "ch-lock"]) audit(id, "phone", "1", "2", "admin", "2026-11-23 09:00:00");

    // ── The day's changes ────────────────────────────────────────────────
    const build = (id: string, day?: string) =>
      buildOwnerChangesPreview(db as any, id, { nowMs: NOW, ...(day ? { day: parseDigestDay(day, NOW)! } : {}) })!;
    const p1 = build("ch-1");
    ok(p1.day.day === "2026-11-23", "build: default day = yesterday");
    const fields = p1.changes.map((c) => c.field_name).join(",");
    ok(fields === "postal_code,phone,email,about,opening_hours", `changes: others' changes, oldest first (${fields})`);
    ok(p1.changes.every((c) => c.who !== "Du"), "changes: the owner's own changes are left out");
    ok(!p1.changes.some((c) => c.field_name === "data_source" || c.field_name === "merge"), "changes: fields outside the log's table are left out");
    ok(!p1.changes.some((c) => c.field_name === "address"), "changes: a no-op row is left out");
    ok(p1.changes.filter((c) => c.field_name === "postal_code").length === 1 && p1.changes[0].new_value === "0002",
      "boundary: Oslo midnight in, the minute before and the next midnight out");
    ok(p1.changes.some((c) => c.field_name === "opening_hours"), "boundary: 23:59:59 Oslo is in");
    const phone = p1.changes.find((c) => c.field_name === "phone")!;
    ok(phone.who === "Rett fra Bonden" && phone.old_value === "111 11 111" && phone.new_value === "222 22 222", "changes: customer service → «Rett fra Bonden», values");
    const about = p1.changes.find((c) => c.field_name === "about")!;
    ok(about.who === "Automatisk fra nettsiden din", "changes: the nightly refresh → «Automatisk fra nettsiden din»");
    const p2 = build("ch-2", "2026-07-01");
    ok(p2.changes.length === 1 && p2.changes[0].new_value === "2", "boundary: summer day window (CEST)");
    ok(build("ch-2").changes.length === 0 && build("ch-2").email === null, "changes: ch-2 has nothing on the default day");

    // ── Render ───────────────────────────────────────────────────────────
    const e = p1.email!;
    ok(e.subject === "5 endringer på profilen din 23. november 2026 – Rett fra Bonden", "render: subject");
    ok(e.text.startsWith("Hei!") && e.text.includes("Dette ble endret på profilen til Endring Gård på Rett fra Bonden 23. november 2026, av andre enn deg:"),
      "render: intro with name and day");
    ok(e.text.includes("- Telefon: 111 11 111 → 222 22 222 (kl. 10:15 · Rett fra Bonden)"), "render: one readable line per change, Oslo time, who");
    ok(e.text.includes("- E-post endret (kl. 14:00 · Rett fra Bonden)"), "render: e-mail field without values");
    ok(e.text.includes("- Postnummer: 0001 → 0002 (kl. 00:00 · Rett fra Bonden)"), "render: Oslo midnight shows as 00:00");
    ok(e.text.includes("Om produsenten: Gammel tekst → Ny tekst, skriv til … (kl. 15:00 · Automatisk fra nettsiden din)"),
      "render: website refresh line, address in a value removed");
    const all = e.text + e.html + e.subject;
    ok(!all.includes("gammel@gard.no") && !all.includes("ny@gard.no") && !all.includes("ola@gard.no"), "render: no e-mail address anywhere");
    ok(!all.includes("INTERN-NOTAT") && !all.includes("SKJULT") && !all.includes("333 33 333") && !all.includes("eier.no"),
      "render: no notes, no hidden fields, no owner changes");
    const mv = "https://changes.example.test/eier/ch-1/valg#";
    ok(e.text.includes(mv) && e.html.includes(`href="${mv}`), "render: «Mine valg» link (text and HTML)");
    ok(!!p1.unsubscribeUrl && p1.unsubscribeUrl.startsWith("https://changes.example.test/endring-avmeld/"), "unsubscribe: URL on the public base");
    ok(e.text.trimEnd().endsWith(p1.unsubscribeUrl!), "unsubscribe: last line of the text");
    ok(e.html.indexOf(p1.unsubscribeUrl!) > e.html.indexOf("<hr"), "unsubscribe: in the HTML footer");
    ok(e.text.includes("Ikke send flere e-poster om endringer") && e.text.includes("Slå av e-post om endringer i «Mine valg»"), "unsubscribe: wording");
    ok(!/NaN|undefined|Infinity|null/.test(all), "render: no NaN/undefined/Infinity/null");
    const many = build("ch-many").email!;
    ok(many.subject.startsWith(`${OWNER_CHANGES_LIST_MAX + 5} endringer`) && many.text.includes("… og 5 endringer til.")
      && (many.text.match(/^- Telefon/gm) || []).length === OWNER_CHANGES_LIST_MAX, "render: long day → first 25 lines + «… og 5 endringer til»");
    ok(build("ch-plain").email!.subject.startsWith("Én endring"), "render: one change → «Én endring»");
    const bare = renderOwnerChangesEmail({ producerName: "", dayLabel: "1. januar 2026", changes: p2.changes, mineValgUrl: "https://x.test/eier/a/valg", unsubscribeUrl: null });
    ok(!!bare && bare.text.includes("profilen din") && !bare.text.includes("Ikke send flere") && !bare.html.includes("endring-avmeld"), "render: no name / no secret → no one-click line");
    ok(renderOwnerChangesEmail({ producerName: "X", dayLabel: "d", changes: [], mineValgUrl: "u", unsubscribeUrl: "v" }) === null, "render: no changes → null (nothing to send)");
    const x = build("ch-xss");
    ok(!x.email!.html.includes("<script>alert(1)") && x.email!.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;")
      && x.email!.html.includes("&quot;Gård&quot; &amp; Co"), "escape: name escaped in the HTML");

    // ── would_send ───────────────────────────────────────────────────────
    ok(p1.isOwner && p1.notifyChanges === true && p1.wouldSend && p1.wouldSendReason === "would_send_if_sending_existed", "would_send: owner, default on");
    const zero = build("ch-zero");
    ok(zero.changes.length === 0 && zero.email === null && zero.wouldSendReason === "no_changes", "zero: only own/technical changes → no digest, no_changes");
    ok(build("ch-plain").wouldSendReason === "not_owner", "would_send: not an owner");
    ok(build("ch-inactive").wouldSendReason === "inactive", "would_send: inactive");
    ok(buildOwnerChangesPreview(db as any, "nope", { nowMs: NOW }) === null, "build: unknown agent → null");

    // ── Token scope isolation ────────────────────────────────────────────
    const tokA = makeOwnerChangesUnsubToken("ch-1")!;
    ok(verifyOwnerChangesUnsubToken(tokA) === "ch-1", "token: round-trip");
    ok(verifyOwnerReportUnsubToken(tokA) === null && verifyOwnerMilestoneUnsubToken(tokA) === null, "token: changes token is neither a report nor a milestone token");
    ok(verifyOwnerChangesUnsubToken(makeOwnerReportUnsubToken("ch-1")!) === null, "token: report token is not a changes token");
    ok(verifyOwnerChangesUnsubToken(makeOwnerMilestoneUnsubToken("ch-1")!) === null, "token: milestone token is not a changes token");
    ok(verifyOwnerChangesUnsubToken(makeUnsubscribeToken("eier@example.no")!) === null, "token: /avmeld token is not a changes token");
    ok(ownerChangesUnsubscribeUrl("ch-1") === `https://changes.example.test/endring-avmeld/${tokA}`, "token: the e-mail links to /endring-avmeld");

    // ── Registry ─────────────────────────────────────────────────────────
    const registry = ownerFeatureRegistryFor("rfb");
    const entry = getOwnerFeature("notify.changes", registry);
    ok(entry.type === "switch" && entry.recipientOptOut === false, "registry: notify.changes switch with recipientOptOut false");
    ok(ownerFeatureStatus(entry) === "coming_soon" && p1.notifyChangesStatus === "coming_soon", "registry: notify.changes is coming_soon");
    ok(getOwnerFeature("notify.changes", ownerFeatureRegistryFor("gardssalg")).recipientOptOut === undefined, "registry: gårdssalg entry unchanged");
    const actor = { actor: "system" as const, detail: "endring-avmeld" };
    for (const v of [true, "off", "false", 0, null]) {
      ok(setOwnerFeatureValue("rfb", "ch-1", "notify.changes", v, actor, { db, recipientOptOut: true }).kind === "invalid_value",
        `option: value ${JSON.stringify(v)} refused (only false)`);
    }

    // ── Routes ───────────────────────────────────────────────────────────
    const app = express();
    app.use("/admin/agents/:id/owner-changes-preview", changesPreviewRouter);
    app.use("/", rapportAvmeldRouter);
    server = http.createServer(app);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", () => res()));
    const port = (server.address() as any).port;
    const call = (path: string, opt: { key?: string | null; method?: string; body?: string } = {}) =>
      new Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const headers: Record<string, string> = {};
        const key = opt.key === undefined ? KEY : opt.key;
        if (key !== null) headers["x-admin-key"] = key;
        if (opt.body !== undefined) {
          headers["content-type"] = "application/x-www-form-urlencoded";
          headers["content-length"] = String(Buffer.byteLength(opt.body));
        }
        const req = http.request({ host: "127.0.0.1", port, path, method: opt.method ?? "GET", headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: any = undefined;
            try { parsed = data ? JSON.parse(data) : undefined; } catch { parsed = undefined; }
            resolve({ status: res.statusCode || 0, body: parsed, text: data, headers: res.headers });
          });
        });
        req.on("error", reject);
        if (opt.body !== undefined) req.write(opt.body);
        req.end();
      });
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as any).n as number;
    const counts = () =>
      ["agents", "agent_knowledge_audit", "owner_feature_settings", "owner_feature_audit", "analytics_page_views", "email_bounces"]
        .map((t) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n; } catch { return -1; } })
        .join(",");
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    // Preview (the route reads the real clock; explicit past dates keep it fixed).
    const c0 = changes();
    const before = counts();
    const base = "/admin/agents/ch-1/owner-changes-preview";
    const q = "?date=2026-11-23";
    ok((await call(base + q, { key: null })).status === 403, "preview: admin key required (403)");
    ok((await call(base + q, { key: "wrong" })).status === 403, "preview: wrong key → 403");
    const unknown = await call("/admin/agents/nope/owner-changes-preview" + q);
    ok(unknown.status === 404 && unknown.body?.error === "Agent not found", "preview: unknown agent → 404");
    for (const bad of ["2026-02-30", "2026-13-01", "abc", "", "23.11.2026", "2999-01-01", "2023-12-31"]) {
      const r = await call(`${base}?date=${encodeURIComponent(bad)}`);
      ok(r.status === 400 && r.body?.error === "invalid date", `preview: date «${bad}» → 400`);
    }
    ok((await call(`${base}${q}&format=xml`)).status === 400, "preview: unknown format → 400");
    const j = await call(base + q);
    ok(j.status === 200 && j.body?.agent_id === "ch-1" && j.body?.date === "2026-11-23", "preview: JSON for the day");
    ok(Array.isArray(j.body?.changes) && j.body.changes.length === 5 && j.body.changes.every((c: any) => c.who !== "Du" && !("notes" in c)),
      "preview: JSON changes (others only, no notes)");
    ok(j.body?.window_utc?.from === "2026-11-22T23:00:00.000Z" && j.body?.window_utc?.to === "2026-11-23T23:00:00.000Z", "preview: JSON Oslo window");
    ok(typeof j.body?.subject === "string" && typeof j.body?.text === "string" && typeof j.body?.html === "string", "preview: subject/text/html");
    ok(j.body?.sending === "none" && j.body?.would_send === true && j.body?.unsubscribe?.route_live === true
      && j.body?.unsubscribe?.path === "/endring-avmeld/" && typeof j.body?.links?.unsubscribe === "string", "preview: sending none, unsubscribe live");
    ok(j.body?.notify_changes === true && j.body?.notify_changes_status === "coming_soon", "preview: notify.changes value and status");
    ok(j.headers["cache-control"] === "no-store" && j.headers["x-robots-tag"] === "noindex", "preview: no-store, noindex");
    ok(!j.text.includes("ola@gard.no") && !j.text.includes("ny@gard.no") && !j.text.includes("INTERN-NOTAT"), "preview: JSON leaks no address or note");
    const h = await call(`${base}${q}&format=html`);
    ok(h.status === 200 && String(h.headers["content-type"]).startsWith("text/html") && h.text.includes("Telefon: 111 11 111 → 222 22 222")
      && h.headers["cache-control"] === "no-store", "preview: format=html serves the e-mail HTML");
    const t = await call(`${base}${q}&format=text`);
    ok(t.status === 200 && String(t.headers["content-type"]).startsWith("text/plain") && t.text.startsWith("Hei!") && t.text.includes("/endring-avmeld/"),
      "preview: format=text serves the plain text");
    const none = await call("/admin/agents/ch-zero/owner-changes-preview" + q);
    ok(none.status === 404 && none.body?.error === "no changes" && none.body?.changes === 0 && none.body?.date === "2026-11-23",
      "preview: no changes → 404 {changes: 0}");
    ok((await call("/admin/agents/ch-zero/owner-changes-preview?date=2026-11-23&format=html")).status === 404, "preview: no changes, html → 404");
    ok((await call("/admin/agents/ch-2/owner-changes-preview?date=2026-07-01&format=text")).status === 200, "preview: summer day → 200");
    ok((await call(base, { method: "POST" })).status === 404, "preview: no POST");
    ok(!(await call("/admin/agents/ch-xss/owner-changes-preview?date=2026-11-23&format=html")).text.includes("<script>alert(1)"), "preview: html escapes the name");
    ok(changes() === c0 && counts() === before, "preview: no DB writes");

    // Unsubscribe: GET confirms only.
    const pathA = `/endring-avmeld/${tokA}`;
    const g = await call(pathA, { key: null });
    ok(g.status === 200 && g.text.includes("Ikke send flere e-poster om endringer") && /<form method="post"/.test(g.text), "unsub GET: confirmation page with a POST button");
    ok(g.headers["cache-control"] === "no-store" && g.headers["referrer-policy"] === "no-referrer" && g.text.includes("noindex"), "unsub GET: no-store, no-referrer, noindex");
    ok(!g.text.includes(tokA) && g.text.includes("https://changes.example.test/eier/ch-1/valg#"), "unsub GET: token not echoed, links «Mine valg»");
    await call(pathA, { key: null });
    ok(changes() === c0 && counts() === before, "unsub GET: no DB writes (twice)");

    // Bad tokens → the neutral 404, no write.
    const notFoundText = (await call("/endring-avmeld/garbage", { key: null })).text;
    const [payloadA, sigA] = tokA.split(".");
    const flip = (v: string) => v.slice(0, -1) + (v.endsWith("A") ? "B" : "A");
    const bad: Array<[string, string]> = [
      ["tampered signature", `${payloadA}.${flip(sigA)}`],
      ["report token", makeOwnerReportUnsubToken("ch-1")!],
      ["milestone token", makeOwnerMilestoneUnsubToken("ch-1")!],
      ["/avmeld token", makeUnsubscribeToken("eier@example.no")!],
      ["unknown agent", makeOwnerChangesUnsubToken("ch-ghost")!],
      ["garbage", "garbage"],
    ];
    for (const [label, tk] of bad) {
      const gr = await call(`/endring-avmeld/${encodeURIComponent(tk)}`, { key: null });
      const pr = await call(`/endring-avmeld/${encodeURIComponent(tk)}`, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
      ok(gr.status === 404 && pr.status === 404 && gr.text === notFoundText && pr.text === notFoundText, `unsub bad token (${label}): GET and POST → neutral 404`);
    }
    for (const other of ["/rapport-avmeld/", "/milepael-avmeld/"]) {
      const crossed = await call(`${other}${tokA}`, { key: null, method: "POST", body: "" });
      ok(crossed.status === 404, `unsub: a changes token on ${other} → 404`);
    }
    setEnv("UNSUBSCRIBE_TOKEN_SECRET", undefined);
    setEnv("ADMIN_KEY", undefined);
    try {
      const ng = await call(pathA, { key: null });
      const np = await call(pathA, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
      ok(ng.status === 404 && np.status === 404, "unsub: no secret → 404 (fail closed)");
    } finally {
      setEnv("UNSUBSCRIBE_TOKEN_SECRET", SECRET);
      setEnv("ADMIN_KEY", KEY);
    }
    ok(changes() === c0 && counts() === before, "unsub bad tokens: no DB writes");

    // POST writes notify.changes = false, one audit row.
    const audits = (id: string) =>
      db.prepare("SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const p1r = await call(pathA, { key: null, method: "POST", body: "" });
    ok(p1r.status === 200 && p1r.text.includes("Du får ikke flere e-poster om endringer") && !p1r.text.includes(tokA), "unsub POST: done page, token not echoed");
    const a1 = audits("ch-1");
    ok(a1.length === 1 && a1[0].key === "notify.changes" && a1[0].old_json === "true" && a1[0].new_json === "false"
      && a1[0].actor === "system" && a1[0].actor_detail === "endring-avmeld", "unsub POST: exactly one audit row true → false, system / endring-avmeld");
    const r1 = resolveOwnerFeature("rfb", "ch-1", "notify.changes", { db });
    ok(r1.value === false && r1.block === "coming_soon", "unsub POST: resolves to false while coming_soon");
    ok(resolveOwnerFeature("rfb", "ch-1", "notify.milestones", { db }).value === true
      && resolveOwnerFeature("rfb", "ch-1", "notify.report", { db }).value === "monthly", "unsub POST: notify.milestones and notify.report untouched");
    const p2r = await call(pathA, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
    ok(p2r.status === 200 && p2r.text === p1r.text && audits("ch-1").length === 1, "unsub POST again (one-click): idempotent, no new audit row");
    const after = build("ch-1");
    ok(after.notifyChanges === false && after.wouldSend === false && after.wouldSendReason === "notify_changes_off", "preview after unsub: notify_changes_off");
    ok(audits("ch-2").length === 0, "unsub POST: other agents untouched");

    // Admin lock → 409, nothing written.
    db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', 'ch-lock', 'notify.changes', 'true', 'admin', 1, '2026-11-01T00:00:00Z')`,
    ).run();
    const locked = await call(`/endring-avmeld/${makeOwnerChangesUnsubToken("ch-lock")!}`, { key: null, method: "POST", body: "" });
    ok(locked.status === 409 && audits("ch-lock").length === 0, "unsub admin lock: 409, nothing written");

    ok(errors.every((m) => !m.includes(tokA) && !m.includes(sigA)), "logs: the token is never logged");
  } catch (err: any) {
    s.failed++;
    s.failures.push("✗ owner-changes-preview: unexpected error: " + String(err?.stack || err));
  } finally {
    console.error = origError;
    __setOwnerChangesPreviewDbForTesting(null);
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
  runOwnerChangesPreviewTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
