/**
 * owner-ai-funnel.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-
 * profil, slice 5b: the owner portal's AI funnel «Sendt til AI» → «Klikk fra
 * AI-svar» → «Kontakt-klikk», last 60 days (owner-stats `aiFunnel`).
 *
 * Covers:
 *   (a) getOwnerStats().aiFunnel: each step counts the 60-day window (UTC
 *       days, today included) and nothing before it; only the profile's own
 *       rows (other profile, other vertical out); AI clicks per AI; bot
 *       contact clicks out; contact clicks after an AI landing per AI
 *       (unknown ai_source → other); labels «siste 60 d» / «siden <dato>».
 *   (b) zero case: a profile with nothing → all steps 0, field present.
 *   (c) read failure: a throwing profile_ai_clicks read leaves out that step
 *       only, the rest of getOwnerStats is unchanged; every step failing
 *       leaves out the field.
 *   (d) selger.html renderOwnerStats renders the three steps in order, the
 *       per-AI list only for non-zero AIs, the «minimum» help text; a missing
 *       step is not rendered; no aiFunnel → empty, card hidden.
 *   (e) GET /api/agents/:id/owner-stats: 401 without a session (unchanged
 *       gate); 200 with the owner's session, carrying aiFunnel.
 *
 * Exported runOwnerAiFunnelTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/owner-ai-funnel.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import * as http from "http";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type El = { innerHTML: string; textContent: string; hidden: boolean; classList: { add: (c: string) => void; remove: (c: string) => void } };

/** selger.html's renderOwnerStats(data) against a stub DOM; returns each element by id. */
function renderOwnerStats(data: unknown): Record<string, El> {
  const src = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
  const start = src.indexOf("function renderOwnerStats(data) {");
  if (start < 0) throw new Error("renderOwnerStats not found in selger.html");
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const els: Record<string, El> = {};
  const mk = (): El => {
    const el: El = {
      innerHTML: "", textContent: "", hidden: true,
      classList: { add: (c) => { if (c === "hidden") el.hidden = true; }, remove: (c) => { if (c === "hidden") el.hidden = false; } },
    };
    return el;
  };
  const document = {
    getElementById: (id: string) => (els[id] ??= mk()),
    querySelectorAll: () => [],
  };
  const escHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fn = new Function("document", "escHtml", "ownLabel", "SOURCE_LABELS", "CHANNEL_LABELS", "clickKindLabel",
    src.slice(start, end) + "\nreturn renderOwnerStats;");
  const render = fn(document, escHtml, (m: Record<string, string>, k: string) => m[k], {}, {}, (k: string) => k);
  render(JSON.parse(JSON.stringify(data)));
  return els;
}

export async function runOwnerAiFunnelTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const prevSince = process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
  const prevWarn = console.warn;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
    const svc = require("./owner-stats-service") as typeof import("./owner-stats-service");

    const addClick = db.prepare("INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count) VALUES (?, ?, ?, ?, ?)");
    const addDelivery = db.prepare(
      "INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const addContact = db.prepare("INSERT INTO contact_clicks (agent_id, kind, is_bot, ai_source, created_at) VALUES (?, ?, ?, ?, ?)");

    // Fixed clock: the 60-day window (today included) is 2027-01-01 … 2027-03-01.
    const now = Date.parse("2027-03-01T12:00:00Z");
    const A = "ag-funnel";
    const PATH = "/produsent/funnel-gard";

    // «Sendt til AI»
    addDelivery.run("rfb", A, "2027-01-01", "mcp", "claude", 5);      // first day in
    addDelivery.run("rfb", A, "2027-03-01", "a2a", "chatgpt", 2);     // today in
    addDelivery.run("rfb", A, "2026-12-31", "mcp", "claude", 100);    // one day before: out
    addDelivery.run("rfb", "ag-other", "2027-02-01", "mcp", "claude", 7);
    addDelivery.run("dental", A, "2027-02-01", "mcp", "claude", 9);   // other vertical
    // «Klikk fra AI-svar» (rows are people only; written by profile-ai-clicks.ts)
    addClick.run("rfb", A, "2027-01-01", "claude", 3);
    addClick.run("rfb", A, "2027-02-10", "chatgpt", 4);
    addClick.run("rfb", A, "2027-02-11", "perplexity", 1);
    addClick.run("rfb", A, "2026-12-31", "claude", 50);              // out
    addClick.run("rfb", "ag-other", "2026-11-02", "gemini", 8);       // other profile (sets the vertical's first day)
    addClick.run("dental", A, "2027-02-10", "copilot", 6);            // other vertical
    // «Kontakt-klikk»
    addContact.run(A, "phone", 0, null, "2027-01-01 00:00:01");
    addContact.run(A, "email", 0, "claude", "2027-02-10 10:00:00");
    addContact.run(A, "website", 0, "chatgpt", "2027-02-11 10:00:00");
    addContact.run(A, "website", 0, "weird-ai", "2027-02-12 10:00:00"); // unknown → other
    addContact.run(A, "phone", 1, "claude", "2027-02-12 10:00:00");     // bot: out
    addContact.run(A, "phone", 0, "claude", "2026-12-31 23:59:59");     // before the window: out
    addContact.run("ag-other", "phone", 0, "claude", "2027-02-12 10:00:00");

    // ── (a) the funnel ────────────────────────────────────────────────
    const o = svc.getOwnerStats(db as any, A, PATH, now);
    const f = o.aiFunnel!;
    assertTrue(!!f, "(a) getOwnerStats carries aiFunnel");
    assertEq(f.windowDays, 60, "(a) window is 60 days");
    assertEq(f.sentToAi?.total, 7, "(a) Sendt til AI: 60-day window only (first day + today), own profile + rfb only");
    assertEq(f.sentToAi?.label, "siste 60 d", "(a) Sendt til AI label after a full window");
    assertEq(f.aiClicks?.total, 8, "(a) Klikk fra AI-svar: 60-day window only, own profile + rfb only");
    assertEq(f.aiClicks?.byVendor, { chatgpt: 4, claude: 3, perplexity: 1, gemini: 0, copilot: 0, other: 0 }, "(a) Klikk fra AI-svar per AI");
    assertEq(f.aiClicks?.countingSince, "2026-11-02", "(a) Klikk fra AI-svar countingSince = the vertical's first day (as the public tile)");
    assertEq(f.aiClicks?.label, "siste 60 d", "(a) Klikk fra AI-svar label after a full window");
    assertEq(f.contactClicks?.total, 4, "(a) Kontakt-klikk: people only, 60-day window, own profile");
    assertEq(f.contactClicks?.fromAi.total, 3, "(a) Kontakt-klikk after an AI landing");
    assertEq(f.contactClicks?.fromAi.byVendor, { chatgpt: 1, claude: 1, perplexity: 0, gemini: 0, copilot: 0, other: 1 }, "(a) AI contact clicks per AI (unknown → other)");
    assertEq(f.contactClicks?.label, "siste 60 d", "(a) Kontakt-klikk label");
    // Existing fields unchanged in meaning.
    assertEq(o.windowDays, 60, "(a) existing windowDays unchanged");
    assertTrue(!!o.funnel && typeof o.funnel.contactClicked === "number" && !!o.aiDeliveries && !!o.year, "(a) existing funnel / aiDeliveries / year still present");

    // Partial window: «siden <dato>» for the AI contact-click subset and the deliveries.
    {
      const early = Date.parse("2026-11-20T12:00:00Z");
      const pf = svc.getOwnerAiFunnel(db as any, A, early)!;
      assertTrue(/^siden 7\. nov/.test(pf.contactClicks!.fromAi.label), `(a) AI contact clicks counted since slice 4: «siden 7. nov.» (got ${pf.contactClicks!.fromAi.label})`);
      assertTrue(/^siden 26\. okt/.test(pf.sentToAi!.label), `(a) Sendt til AI before a full window: «siden 26. okt.» (got ${pf.sentToAi!.label})`);
      assertEq(pf.contactClicks!.label, "siste 60 d", "(a) all contact clicks: whole 60 d (counted before slice 4 too)");
    }

    // ── (b) zero case ─────────────────────────────────────────────────
    {
      const z = svc.getOwnerAiFunnel(db as any, "ag-nobody", now)!;
      assertEq([z.sentToAi?.total, z.aiClicks?.total, z.contactClicks?.total, z.contactClicks?.fromAi.total], [0, 0, 0, 0], "(b) a profile with nothing: every step 0, field present");
    }

    // ── (c) read failure ──────────────────────────────────────────────
    {
      console.warn = () => undefined;
      const failing = (pattern: RegExp) => new Proxy(db, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (pattern.test(sql) && !/sqlite_master/.test(sql)) throw new Error("simulated read failure");
              return target.prepare(sql);
            };
          }
          const v = (target as any)[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const c = svc.getOwnerStats(failing(/FROM profile_ai_clicks/) as any, A, PATH, now);
      assertTrue(!!c.aiFunnel && c.aiFunnel.aiClicks === undefined, "(c) profile_ai_clicks read fails → aiClicks step left out");
      assertEq([c.aiFunnel?.sentToAi?.total, c.aiFunnel?.contactClicks?.total], [7, 4], "(c) the other steps still there");
      assertEq([c.funnel, c.contactClicksByKind, c.aiDeliveries], [o.funnel, o.contactClicksByKind, o.aiDeliveries], "(c) the rest of the owner stats unchanged");
      // The contact step fails on its grouped read (slice 4's column probe already degrades to 0 by itself).
      const all = svc.getOwnerAiFunnel(failing(/FROM profile_ai_clicks|FROM profile_ai_deliveries|GROUP BY ai_source/) as any, A, now);
      assertEq(all, undefined, "(c) every step fails → no aiFunnel");
      const contactFails = svc.getOwnerStats(failing(/GROUP BY ai_source/) as any, A, PATH, now);
      assertTrue(!!contactFails.aiFunnel && contactFails.aiFunnel.contactClicks === undefined && contactFails.aiFunnel.aiClicks?.total === 8,
        "(c) contact-click read fails → that step left out, the click step stays");
      console.warn = prevWarn;
    }

    // ── (d) selger.html renders the funnel ────────────────────────────
    {
      const els = renderOwnerStats(o);
      const html = els.statsAiFunnel.innerHTML;
      const iSent = html.indexOf('data-ai-funnel="sentToAi"');
      const iClicks = html.indexOf('data-ai-funnel="aiClicks"');
      const iContact = html.indexOf('data-ai-funnel="contactClicks"');
      assertTrue(iSent >= 0 && iClicks > iSent && iContact > iClicks, "(d) three steps in order: Sendt til AI → Klikk fra AI-svar → Kontakt-klikk");
      assertTrue(html.includes(">7</div><div class=\"stat-label\">Sendt til AI (siste 60 d)"), "(d) Sendt til AI 7 (siste 60 d)");
      assertTrue(html.includes(">8</div><div class=\"stat-label\">Klikk fra AI-svar (siste 60 d, minst)"), "(d) Klikk fra AI-svar 8, marked as a minimum");
      assertTrue(html.includes(">4</div><div class=\"stat-label\">Kontakt-klikk (siste 60 d)") && html.includes("hvorav etter klikk fra AI-svar: <strong>3</strong>"), "(d) Kontakt-klikk 4, of which 3 after an AI answer");
      const vendors = els.statsAiFunnelVendor.innerHTML;
      assertTrue(vendors.includes("ChatGPT") && vendors.includes("Claude") && vendors.includes("Perplexity"), "(d) per-AI list shows the non-zero AIs");
      assertTrue(!vendors.includes("Gemini") && !vendors.includes("Copilot") && !vendors.includes("Andre AI"), "(d) per-AI list leaves out the zero AIs");
      assertEq(els.statsAiFunnelCard.hidden, false, "(d) card shown");

      const noClicks = renderOwnerStats({ ...o, aiFunnel: { ...o.aiFunnel, aiClicks: undefined } });
      const h2 = noClicks.statsAiFunnel.innerHTML;
      assertTrue(h2.includes('data-ai-funnel="sentToAi"') && h2.includes('data-ai-funnel="contactClicks"') && !h2.includes('data-ai-funnel="aiClicks"'), "(d) a missing step is not rendered");
      assertEq(noClicks.statsAiFunnelVendor.innerHTML, "", "(d) no per-AI list without the click step");

      const none = renderOwnerStats({ ...o, aiFunnel: undefined });
      assertEq(none.statsAiFunnel.innerHTML, "", "(d) no aiFunnel → nothing rendered");
      assertEq(none.statsAiFunnelCard.hidden, true, "(d) no aiFunnel → card hidden");
      assertTrue(none.statsFunnel.innerHTML.includes("Kontakt-klikk"), "(d) the existing funnel still renders");

      const zero = renderOwnerStats({ ...o, aiFunnel: svc.getOwnerAiFunnel(db as any, "ag-nobody", now) });
      assertTrue(zero.statsAiFunnelVendor.innerHTML.includes("Ingen klikk fra AI-svar"), "(d) zero clicks → «Ingen klikk fra AI-svar registrert ennå»");

      const evil = renderOwnerStats({ ...o, aiFunnel: { ...o.aiFunnel, sentToAi: { total: "<b>x</b>", label: "<img src=x>" } } });
      assertTrue(!evil.statsAiFunnel.innerHTML.includes("<img") && !evil.statsAiFunnel.innerHTML.includes("<b>x"), "(d) labels escaped and counts coerced to numbers");

      const page = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
      assertTrue(page.includes('id="statsAiFunnelCard"') && page.includes("et <strong>minimum</strong>") && page.includes("noen klikk blir ikke med"), "(d) help text: the click number is a minimum, some clicks are missed");
      assertTrue(!page.includes("Med i AI-svar"), "(d) selger.html still never says «Med i AI-svar»");
    }

    // ── (e) the route: owner session only ─────────────────────────────
    {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, is_verified)
                  VALUES (?, 'Funnel Gard', 'Testprodusent', 'self', 'eier@funnel.no', 'https://example.no', 'producer', 'k-funnel', '["vegetables"]', 1)`).run(A);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email) VALUES (?, 'verified', 'eier@funnel.no')").run(A);
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at, verified_at)
                  VALUES ('cl-funnel', ?, 'Eier', 'eier@funnel.no', 'verified', 'claim_funnel', ?, datetime('now'))`)
        .run(A, new Date(Date.now() + 30 * 86_400_000).toISOString());
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('ml-funnel', 'eier@funnel.no', 'tok-funnel', ?, 1, ?, ?)")
        .run(A, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      const today = new Date().toISOString().slice(0, 10);
      addClick.run("rfb", A, today, "gemini", 2);

      const express = require("express");
      const ownerPortal = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      const app = express();
      app.use(express.json());
      app.use("/", ownerPortal.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
      const port = (server!.address() as any).port as number;
      const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any }>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: p, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            let json: any = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, json });
          });
        }).on("error", reject);
      });
      const anon = await get(`/api/agents/${A}/owner-stats`);
      assertEq([anon.status, anon.json?.error, anon.json?.aiFunnel], [401, "session_invalid", undefined], "(e) no session → 401, no funnel");
      const own = await get(`/api/agents/${A}/owner-stats`, { Cookie: "rfb_owner_session=tok-funnel" });
      assertEq(own.status, 200, "(e) owner session → 200");
      assertEq(own.json?.aiFunnel?.aiClicks?.byVendor?.gemini, 2, "(e) payload carries aiFunnel (today's click counted)");
      assertTrue(!!own.json?.funnel && !!own.json?.aiDeliveries, "(e) existing payload fields still present");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
  } finally {
    console.warn = prevWarn;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevSince === undefined) delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
    else process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = prevSince;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }

  if (log) console.log(`\nowner-ai-funnel: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerAiFunnelTests({ log: true }).then((r) => {
    if (r.failed) { for (const f of r.failures) console.log(f); process.exit(1); }
  });
}
