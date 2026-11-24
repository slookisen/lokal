/**
 * admin-owner-milestone-preview.test.ts — milestone owner e-mail template,
 * admin-only preview and its unsubscribe (dev-request
 * 2026-10-22-rfb-mine-valg-eierbrytere, S5-5). Pure milestone selection on
 * the boundaries, cumulative views on a fixed clock (owner, AI, legacy and
 * pre-classification views left out), the rendered e-mail, then
 * GET /admin/agents/:id/owner-milestone-preview and
 * GET/POST /milepael-avmeld/:token over a real express app on an ephemeral
 * port, own in-memory DB via the routes' seams. Every env var the code reads
 * is set (or cleared) explicitly and restored in finally.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { makeUnsubscribeToken } from "../services/avmeld-service";
import { makeOwnerReportUnsubToken, verifyOwnerReportUnsubToken } from "../services/owner-monthly-report";
import {
  OWNER_MILESTONES,
  buildOwnerMilestonePreview,
  highestReachedMilestone,
  makeOwnerMilestoneUnsubToken,
  nextMilestone,
  ownerMilestoneUnsubscribeUrl,
  parseOwnerMilestone,
  renderOwnerMilestoneEmail,
  verifyOwnerMilestoneUnsubToken,
} from "../services/owner-milestone-email";
import { getOwnerFeature, ownerFeatureRegistryFor, ownerFeatureStatus } from "../owner-features/registry";
import { resolveOwnerFeature, setOwnerFeatureValue } from "../owner-features/resolve";
import milestonePreviewRouter, { __setOwnerMilestonePreviewDbForTesting } from "./admin-owner-milestone-preview";
import rapportAvmeldRouter, { __setRapportAvmeldDbForTesting } from "./rapport-avmeld";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CLAUDE_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
// Fixed clock: 24 Nov 2026, 12:00 UTC.
const NOW = Date.parse("2026-11-24T12:00:00Z");

export async function runOwnerMilestonePreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const KEY = "owner-milestone-preview-test-key";
  setEnv("ADMIN_KEY", KEY);
  setEnv("ANALYTICS_ADMIN_KEY", undefined);
  setEnv("UNSUBSCRIBE_TOKEN_SECRET", "owner-milestone-preview-test-secret");
  setEnv("APP_URL", "https://milestone.example.test");
  setEnv("ANALYTICS_ROLLUP_READ", undefined);

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const errors: string[] = [];
  const origError = console.error;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setOwnerMilestonePreviewDbForTesting(db as any);
    __setRapportAvmeldDbForTesting(db as any);

    // ── Pure selection on the boundaries ─────────────────────────────────
    ok(OWNER_MILESTONES.join(",") === "100,500,1000", "milestones: 100, 500, 1000");
    const sel: Array<[number, number | null, number | null]> = [
      [0, null, 100], [99, null, 100], [100, 100, 500], [101, 100, 500], [499, 100, 500],
      [500, 500, 1000], [999, 500, 1000], [1000, 1000, null], [5000, 1000, null],
    ];
    for (const [n, hit, next] of sel) {
      ok(highestReachedMilestone(n) === hit, `select: ${n} views → reached ${hit}`);
      ok(nextMilestone(n) === next, `select: ${n} views → next ${next}`);
    }
    for (const good of ["100", "500", "1000", 100]) ok(parseOwnerMilestone(good) !== null, `parse: ${JSON.stringify(good)} accepted`);
    for (const bad of ["", "0", "99", "200", "0100", "100.0", "-100", "1e3", "abc", "10000", ["100"], null, undefined]) {
      ok(parseOwnerMilestone(bad) === null, `parse: ${JSON.stringify(bad)} rejected`);
    }

    // ── Data ─────────────────────────────────────────────────────────────
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active, catalog_hidden)
       VALUES (?, ?, 'test agent', 'test', 'eier@example.no', 'https://example.no', 'producer', ?, 'rfb', ?, ?, 0)`,
    );
    const agents: Array<[string, string, string | null, number]> = [
      ["ms-99", "Nittini Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-100", "Hundre Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-499", "Firenittini Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-500", "Femhundre Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-1000", "Tusen Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-5000", "Femtusen Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-own", "Eiers Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-zero", "Stille Gård", "2026-01-01T00:00:00Z", 1],
      ["ms-plain", "Ikke Eid", null, 1],
      ["ms-inactive", "Sovende Gård", "2026-01-01T00:00:00Z", 0],
      ["ms-xss", `<script>alert(1)</script> "Gård" & Co`, "2026-01-01T00:00:00Z", 1],
    ];
    agents.forEach(([id, name, claimed, active], i) => insertAgent.run(id, name, `k${i}`, claimed, active));

    // Raw floor of analytics_agent_views = 2026-11-01 → days before it come from agent_view_daily.
    db.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, created_at) VALUES ('ms-own', 'Eiers Gård', '2026-11-01 08:00:00')").run();
    const daily = db.prepare("INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, ?, ?, '', ?)");
    // Totals split over two stored days so the sum is what is checked.
    const stored: Array<[string, number]> = [["ms-99", 99], ["ms-100", 100], ["ms-499", 499], ["ms-500", 500], ["ms-1000", 1000], ["ms-5000", 5000], ["ms-plain", 300], ["ms-inactive", 300], ["ms-xss", 120]];
    for (const [id, n] of stored) {
      daily.run("2026-10-05", id, "direct", n - 1);
      daily.run("2026-10-20", id, "organic", 1);
    }
    // Never counted: legacy bucket, before classification began, on/after the raw floor (raw covers those days).
    for (const id of ["ms-99", "ms-499", "ms-own"]) {
      daily.run("2026-10-06", id, "legacy_unclassified", 400);
      daily.run("2026-10-01", id, "direct", 400);
      daily.run("2026-11-03", id, "direct", 400);
    }
    // ms-own: 99 stored + raw: owner views, AI views and 0 people → 99 (no milestone).
    daily.run("2026-10-07", "ms-own", "direct", 99);
    const pv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
       VALUES (?, 'direct', 'h', ?, ?, ?, 'rfb', ?)`,
    );
    const ownPath = "/produsent/eiers-gard";
    for (let i = 0; i < 5; i++) pv.run(ownPath, `o${i}:${CHROME_UA}`, 1, 200, "2026-11-10 10:00:00"); // the owner: left out
    for (let i = 0; i < 5; i++) pv.run(ownPath, `a${i}:${CLAUDE_USER}`, 0, 200, "2026-11-11 10:00:00"); // AI assistant: not a person
    pv.run(ownPath, `e1:${CHROME_UA}`, 0, 404, "2026-11-12 10:00:00"); // error page: not a view
    pv.run(ownPath, `f1:${CHROME_UA}`, 0, 200, "2026-11-25 10:00:00"); // after «now»: not yet
    // ms-zero: one raw people's view only.
    pv.run("/produsent/stille-gard", `z1:${CHROME_UA}`, 0, 200, "2026-11-15 10:00:00");

    // ── Cumulative views + selection on real rows ────────────────────────
    const build = (id: string, milestone?: 100 | 500 | 1000) =>
      buildOwnerMilestonePreview(db as any, id, { nowMs: NOW, ...(milestone ? { milestone } : {}) })!;
    const expect: Array<[string, number, number | null]> = [
      ["ms-99", 99, null], ["ms-100", 100, 100], ["ms-499", 499, 100], ["ms-500", 500, 500], ["ms-1000", 1000, 1000], ["ms-5000", 5000, 1000],
    ];
    for (const [id, total, hit] of expect) {
      const p = build(id);
      ok(p.totalViews?.value === total, `views: ${id} cumulative total ${total} (legacy, pre-classification and post-floor stored rows out)`);
      ok(p.reachedMilestone === hit && p.milestone === hit, `views: ${id} → milestone ${hit}`);
    }
    const own = build("ms-own");
    ok(own.totalViews?.value === 99 && own.reachedMilestone === null, "own views: owner, AI, 404 and future rows excluded → 99, no milestone");
    // One more person's view lifts it over the line.
    pv.run(ownPath, `p1:${CHROME_UA}`, 0, 200, "2026-11-20 10:00:00");
    const own2 = build("ms-own");
    ok(own2.totalViews?.value === 100 && own2.reachedMilestone === 100, "own views: + one person's view → exactly 100 → milestone 100");
    const zero = build("ms-zero");
    ok(zero.totalViews?.value === 1 && zero.milestone === null && zero.email === null && zero.wouldSendReason === "no_milestone_reached",
      "zero: 1 view → no milestone, no e-mail, no_milestone_reached");
    ok(zero.totalViews?.countedFrom === null, "views: counted from the first classified day (whole range)");
    ok(build("nope" as string) === null, "build: unknown agent → null");

    // ── Render ───────────────────────────────────────────────────────────
    const p500 = build("ms-500");
    const e = p500.email!;
    ok(e.subject === "Profilen din har nådd 500 besøk – Rett fra Bonden", "render: subject");
    ok(e.text.startsWith("Hei!") && e.text.includes("Gratulerer! Profilen til Femhundre Gård på Rett fra Bonden har nå hatt 500 besøk."), "render: congratulations with name and number");
    ok(e.text.includes("Et besøk er når en person åpner profilsiden din"), "render: explains what a visit is");
    ok(e.text.includes("Dine egne besøk teller ikke"), "render: says own visits do not count");
    const mv = "https://milestone.example.test/eier/ms-500/valg#";
    ok(e.text.includes(mv) && e.html.includes(`href="${mv}`), "render: «Mine valg» link (text and HTML)");
    ok(!!p500.unsubscribeUrl && p500.unsubscribeUrl.startsWith("https://milestone.example.test/milepael-avmeld/"), "unsubscribe: URL on the public base");
    ok(e.text.trimEnd().endsWith(p500.unsubscribeUrl!), "unsubscribe: last line of the text");
    ok(e.html.indexOf(p500.unsubscribeUrl!) > e.html.indexOf("<hr"), "unsubscribe: in the HTML footer");
    ok(e.text.includes("Ikke send flere e-poster om milepæler") && e.text.includes("Slå av e-post om milepæler i «Mine valg»"), "unsubscribe: wording");
    ok(!/NaN|undefined|Infinity|null/.test(e.text + e.html), "render: no NaN/undefined/Infinity/null");
    ok(build("ms-5000").email!.subject === "Profilen din har nådd 1 000 besøk – Rett fra Bonden", "render: 1000 → «1 000», highest milestone for 5000");
    const bare = renderOwnerMilestoneEmail({ producerName: "", milestone: 100, mineValgUrl: "https://x.test/eier/a/valg", unsubscribeUrl: null });
    ok(bare.text.includes("profilen din") && !bare.text.includes("Ikke send flere") && !bare.html.includes("milepael-avmeld"), "render: no name / no secret → no one-click line");
    const x = build("ms-xss");
    ok(!x.email!.html.includes("<script>alert(1)") && x.email!.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;")
      && x.email!.html.includes("&quot;Gård&quot; &amp; Co"), "escape: name escaped in the HTML");

    // ── would_send ───────────────────────────────────────────────────────
    ok(p500.isOwner && p500.notifyMilestones === true && p500.wouldSend && p500.wouldSendReason === "would_send_if_sending_existed", "would_send: owner, default on");
    ok(build("ms-plain").wouldSendReason === "not_owner", "would_send: not an owner");
    ok(build("ms-inactive").wouldSendReason === "inactive", "would_send: inactive");
    const req1000 = build("ms-500", 1000);
    ok(req1000.milestone === 1000 && req1000.email!.subject.includes("1 000") && req1000.wouldSendReason === "milestone_not_reached",
      "would_send: requested milestone above the reached one → template shown, milestone_not_reached");
    ok(build("ms-zero", 100).email !== null && build("ms-zero", 100).wouldSendReason === "no_milestone_reached", "would_send: requested template with none reached");

    // ── Token scope isolation ────────────────────────────────────────────
    const tokA = makeOwnerMilestoneUnsubToken("ms-500")!;
    ok(verifyOwnerMilestoneUnsubToken(tokA) === "ms-500", "token: round-trip");
    ok(verifyOwnerReportUnsubToken(tokA) === null, "token: milestone token is not a report token");
    ok(verifyOwnerMilestoneUnsubToken(makeOwnerReportUnsubToken("ms-500")!) === null, "token: report token is not a milestone token");
    ok(verifyOwnerMilestoneUnsubToken(makeUnsubscribeToken("eier@example.no")!) === null, "token: /avmeld token is not a milestone token");
    ok(ownerMilestoneUnsubscribeUrl("ms-500") === `https://milestone.example.test/milepael-avmeld/${tokA}`, "token: the e-mail links to /milepael-avmeld");

    // ── Registry ─────────────────────────────────────────────────────────
    const registry = ownerFeatureRegistryFor("rfb");
    const entry = getOwnerFeature("notify.milestones", registry);
    ok(entry.type === "switch" && entry.recipientOptOut === false, "registry: notify.milestones switch with recipientOptOut false");
    ok(ownerFeatureStatus(entry) === "coming_soon" && p500.notifyMilestonesStatus === "coming_soon", "registry: notify.milestones is coming_soon");
    ok(getOwnerFeature("notify.milestones", ownerFeatureRegistryFor("gardssalg")).recipientOptOut === undefined, "registry: gårdssalg entry unchanged");
    const actor = { actor: "system" as const, detail: "milepael-avmeld" };
    for (const v of [true, "off", "false", 0, null]) {
      ok(setOwnerFeatureValue("rfb", "ms-100", "notify.milestones", v, actor, { db, recipientOptOut: true }).kind === "invalid_value",
        `option: value ${JSON.stringify(v)} refused (only false)`);
    }

    // ── Routes ───────────────────────────────────────────────────────────
    const app = express();
    app.use("/admin/agents/:id/owner-milestone-preview", milestonePreviewRouter);
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
      ["agents", "owner_feature_settings", "owner_feature_audit", "analytics_page_views", "agent_view_daily", "email_bounces"]
        .map((t) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n; } catch { return -1; } })
        .join(",");
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    // Preview.
    const c0 = changes();
    const before = counts();
    const base = "/admin/agents/ms-500/owner-milestone-preview";
    ok((await call(base, { key: null })).status === 403, "preview: admin key required (403)");
    ok((await call(base, { key: "wrong" })).status === 403, "preview: wrong key → 403");
    ok((await call("/admin/agents/nope/owner-milestone-preview")).status === 404, "preview: unknown agent → 404");
    ok((await call("/admin/agents/nope/owner-milestone-preview")).body?.error === "Agent not found", "preview: unknown agent says so");
    for (const bad of ["99", "200", "abc", "", "0100"]) {
      ok((await call(`${base}?milestone=${bad}`)).status === 400, `preview: milestone «${bad}» → 400`);
    }
    ok((await call(`${base}?format=xml`)).status === 400, "preview: unknown format → 400");
    const j = await call(base);
    ok(j.status === 200 && j.body?.agent_id === "ms-500" && j.body?.milestone === 500, "preview: JSON default = highest reached (500)");
    ok(j.body?.views?.total === 500 && j.body?.views?.reached_milestone === 500 && j.body?.views?.next_milestone === 1000, "preview: JSON views block");
    ok(typeof j.body?.subject === "string" && typeof j.body?.text === "string" && typeof j.body?.html === "string", "preview: subject/text/html");
    ok(j.body?.sending === "none" && j.body?.would_send === true && j.body?.unsubscribe?.route_live === true
      && j.body?.unsubscribe?.path === "/milepael-avmeld/" && typeof j.body?.links?.unsubscribe === "string", "preview: sending none, unsubscribe live");
    ok(j.body?.notify_milestones === true && j.body?.notify_milestones_status === "coming_soon", "preview: notify.milestones value and status");
    ok(j.headers["cache-control"] === "no-store" && j.headers["x-robots-tag"] === "noindex", "preview: no-store, noindex");
    const j100 = await call(`${base}?milestone=100`);
    ok(j100.status === 200 && j100.body?.milestone === 100 && j100.body?.subject.includes("100 besøk"), "preview: ?milestone=100 renders 100");
    const h = await call(`${base}?milestone=1000&format=html`);
    ok(h.status === 200 && String(h.headers["content-type"]).startsWith("text/html") && h.text.includes("1 000 besøk") && h.headers["cache-control"] === "no-store",
      "preview: format=html serves the e-mail HTML");
    const t = await call(`${base}?format=text`);
    ok(t.status === 200 && String(t.headers["content-type"]).startsWith("text/plain") && t.text.startsWith("Hei!") && t.text.includes("/milepael-avmeld/"),
      "preview: format=text serves the plain text");
    const none = await call("/admin/agents/ms-zero/owner-milestone-preview");
    ok(none.status === 404 && none.body?.milestone === null && none.body?.error === "no milestone reached"
      && none.body?.views?.total === 1 && none.body?.views?.next_milestone === 100, "preview: none reached → 404 {milestone:null} with the view count");
    ok((await call("/admin/agents/ms-zero/owner-milestone-preview?format=html")).status === 404, "preview: none reached, html → 404");
    ok((await call("/admin/agents/ms-zero/owner-milestone-preview?milestone=100&format=text")).status === 200, "preview: none reached, explicit milestone → 200");
    ok((await call(base, { method: "POST" })).status === 404, "preview: no POST");
    ok(!(await call("/admin/agents/ms-xss/owner-milestone-preview?format=html")).text.includes("<script>alert(1)"), "preview: html escapes the name");
    ok(changes() === c0 && counts() === before, "preview: no DB writes");

    // Unsubscribe: GET confirms only.
    const pathA = `/milepael-avmeld/${tokA}`;
    const g = await call(pathA, { key: null });
    ok(g.status === 200 && g.text.includes("Ikke send flere e-poster om milepæler") && /<form method="post"/.test(g.text), "unsub GET: confirmation page with a POST button");
    ok(g.headers["cache-control"] === "no-store" && g.headers["referrer-policy"] === "no-referrer" && g.text.includes("noindex"), "unsub GET: no-store, no-referrer, noindex");
    ok(!g.text.includes(tokA) && g.text.includes("https://milestone.example.test/eier/ms-500/valg#"), "unsub GET: token not echoed, links «Mine valg»");
    await call(pathA, { key: null });
    ok(changes() === c0 && counts() === before, "unsub GET: no DB writes (twice)");

    // Bad tokens → the neutral 404, no write.
    const notFoundText = (await call("/milepael-avmeld/garbage", { key: null })).text;
    const [payloadA, sigA] = tokA.split(".");
    const flip = (v: string) => v.slice(0, -1) + (v.endsWith("A") ? "B" : "A");
    const bad: Array<[string, string]> = [
      ["tampered signature", `${payloadA}.${flip(sigA)}`],
      ["report token", makeOwnerReportUnsubToken("ms-500")!],
      ["/avmeld token", makeUnsubscribeToken("eier@example.no")!],
      ["unknown agent", makeOwnerMilestoneUnsubToken("ms-ghost")!],
      ["garbage", "garbage"],
    ];
    for (const [label, tk] of bad) {
      const gr = await call(`/milepael-avmeld/${encodeURIComponent(tk)}`, { key: null });
      const pr = await call(`/milepael-avmeld/${encodeURIComponent(tk)}`, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
      ok(gr.status === 404 && pr.status === 404 && gr.text === notFoundText && pr.text === notFoundText, `unsub bad token (${label}): GET and POST → neutral 404`);
    }
    const crossed = await call(`/rapport-avmeld/${tokA}`, { key: null, method: "POST", body: "" });
    ok(crossed.status === 404, "unsub: a milestone token on /rapport-avmeld → 404");
    setEnv("UNSUBSCRIBE_TOKEN_SECRET", undefined);
    setEnv("ADMIN_KEY", undefined);
    try {
      const np = await call(pathA, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
      ok(np.status === 404, "unsub: no secret → 404 (fail closed)");
    } finally {
      setEnv("UNSUBSCRIBE_TOKEN_SECRET", "owner-milestone-preview-test-secret");
      setEnv("ADMIN_KEY", KEY);
    }
    ok(changes() === c0 && counts() === before, "unsub bad tokens: no DB writes");

    // POST writes notify.milestones = false, one audit row.
    const audits = (id: string) =>
      db.prepare("SELECT key, old_json, new_json, actor, actor_detail FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const p1 = await call(pathA, { key: null, method: "POST", body: "" });
    ok(p1.status === 200 && p1.text.includes("Du får ikke flere e-poster om milepæler") && !p1.text.includes(tokA), "unsub POST: done page, token not echoed");
    const a1 = audits("ms-500");
    ok(a1.length === 1 && a1[0].key === "notify.milestones" && a1[0].old_json === "true" && a1[0].new_json === "false"
      && a1[0].actor === "system" && a1[0].actor_detail === "milepael-avmeld", "unsub POST: exactly one audit row true → false, system / milepael-avmeld");
    const r1 = resolveOwnerFeature("rfb", "ms-500", "notify.milestones", { db });
    ok(r1.value === false && r1.block === "coming_soon", "unsub POST: resolves to false while coming_soon");
    ok(resolveOwnerFeature("rfb", "ms-500", "notify.report", { db }).value === "monthly", "unsub POST: notify.report untouched");
    const p2 = await call(pathA, { key: null, method: "POST", body: "List-Unsubscribe=One-Click" });
    ok(p2.status === 200 && p2.text === p1.text && audits("ms-500").length === 1, "unsub POST again (one-click): idempotent, no new audit row");
    const after = build("ms-500");
    ok(after.notifyMilestones === false && after.wouldSend === false && after.wouldSendReason === "notify_milestones_off", "preview after unsub: notify_milestones_off");
    ok(audits("ms-100").length === 0, "unsub POST: other agents untouched");

    // Admin lock → 409, nothing written.
    db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', 'ms-1000', 'notify.milestones', 'true', 'admin', 1, '2026-11-01T00:00:00Z')`,
    ).run();
    const locked = await call(`/milepael-avmeld/${makeOwnerMilestoneUnsubToken("ms-1000")!}`, { key: null, method: "POST", body: "" });
    ok(locked.status === 409 && audits("ms-1000").length === 0, "unsub admin lock: 409, nothing written");

    ok(errors.every((m) => !m.includes(tokA) && !m.includes(sigA)), "logs: the token is never logged");
  } catch (err: any) {
    s.failed++;
    s.failures.push("✗ owner-milestone-preview: unexpected error: " + String(err?.stack || err));
  } finally {
    console.error = origError;
    __setOwnerMilestonePreviewDbForTesting(null);
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
  runOwnerMilestonePreviewTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
