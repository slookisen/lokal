/**
 * owner-features-t7.test.ts — eierportal testrunde 1, slice T7 (punkt 1):
 * «Nyheter og tips» at the bottom, without a reflex no. Acceptance
 * criterion 3:
 *
 *   order     unanswered: no #velkommen; DOM order #statistikk < #niva <
 *             first group < #gruppe-notify < #gruppe-comms < #planlagt <
 *             #endringslogg; the question stands at the top of #gruppe-comms
 *   buttons   «Ja takk» and «Ikke nå» share one class, none is ep-btn-primary;
 *             «Nei, ikke spør meg igjen» is a quiet POST link button (≥ 44 px,
 *             token colours, visible focus, no inline style); every form has
 *             data-mv-row="gruppe-comms" and works without JavaScript (303
 *             to #gruppe-comms)
 *   later     no owner_feature_settings and no owner_feature_audit row; rests
 *             90 days; after three rounds the question is never shown again
 *   never     an explicit no with its time; the row says «Du sa nei {dato}.»
 *   yes       comms.news on, its audit row carries text_version + placement,
 *             one batch; «Angre» works (and the question is back); the row
 *             says «Du sa ja {dato}.»
 *   legacy    an owner_feature_intro row (S2b) counts as answered
 *   e-mail    no e-mail asks for consent (code search over src/)
 *   text      the consent text has a version and a hash; the hash is pinned
 *             per version here, so a changed text without a new version fails
 *   texts     group subtitles («Kontakt fra Rett fra Bonden», «Varsler til deg»),
 *             the confirmations, the row text
 *   gate      off the allowlist: 404 and nothing written; no GET writes
 *   schema    owner_feature_prompt + owner_feature_audit.text_version /
 *             placement exist; the migration is idempotent
 *
 * Not here: «with the dashboard on the question is only on Oversikt» — that
 * belongs to T15 (OWNER_DASHBOARD_ENABLED does not exist yet); the audit row's
 * `placement` is ready for it.
 *
 * Real routers + services on the production schema in an in-memory DB;
 * handlers pulled off the router stack (same harness as owner-features-s2b).
 * Exported runOwnerFeaturesT7Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-t7.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const IDS = {
  order: "t7-order",
  later: "t7-later",
  never: "t7-never",
  yes: "t7-yes",
  legacyNo: "t7-legacy-no",
  legacyYes: "t7-legacy-yes",
  row: "t7-row",
  old: "t7-old-form",
  placement: "t7-placement",
  outside: "t7-outside",
} as const;

/**
 * The consent text's hash per version. Changing any string in
 * owner-features/news-consent.ts (OWNER_NEWS_CONSENT_TEXT) requires a new
 * OWNER_NEWS_CONSENT_VERSION and a new line here — never an edit of an
 * existing line.
 */
/** comms.news registry description on origin/main — public pages read it, so T7 must not change it. */
const MAIN_NEWS_DESCRIPTION = {
  no: "Om du vil ha nyheter og tips fra Rett fra Bonden på e-post. Vi lagrer svaret ditt med tidspunkt. Vi sender ingen nyhetsbrev automatisk.",
  en: "Whether you want news and tips from Rett fra Bonden by e-mail. We store your answer with the time. We send no newsletter automatically.",
};

const PINNED_CONSENT_HASHES: Record<string, string> = {
  "2026-11-01": "7f26084be8b36e9e5aae30575f9857858ff9d3e2b936f2328b856717e3d8adfa",
};

function seedProducer(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for T7.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 0)`,
  ).run(id, `Nyhetsgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
}

/** The code without comments (a comment never sends an e-mail). */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test .ts file under src/. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts") && !ent.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export async function runOwnerFeaturesT7Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevAllow = process.env[ALLOW_ENV];
  const prevGate = process.env[GATE_ENV];

  function findRouteHandler(router: any, p: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === p && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${p}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env[GATE_ENV];
    for (const m of ["./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    const nc = require("../owner-features/news-consent") as typeof import("../owner-features/news-consent");

    const all = Object.values(IDS);
    const tokens: Record<string, string> = {};
    for (const id of all) {
      seedProducer(db, id);
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    const ALLOWED = all.filter((id) => id !== IDS.outside).map((id) => `rfb:${id}`).join(",");
    process.env[ALLOW_ENV] = ALLOWED;

    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
      angre: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/angre", "post"),
      intro: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/intro", "post"),
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
    };
    const resetCap = () => featuresMod.__resetOwnerFeaturesRateLimitForTesting();
    const page = async (id: string, query: Record<string, string> = {}) => String((await invoke(H.page, makeReq({ params: { agentId: id }, query, token: tokens[id] }))).body ?? "");
    const post = (h: Function, id: string, body: any) => invoke(h, makeReq({ params: { agentId: id }, body, token: tokens[id] }));
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    /** GET the 303 target (query part only; the fragment never reaches the server). */
    const follow = async (id: string, location: string) => {
      const q = Object.fromEntries(new URLSearchParams((location.split("?")[1] || "").split("#")[0]));
      return page(id, q);
    };
    const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
    const settingsRows = (id: string) => count("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?", id);
    const auditRows = (id: string) => count("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ?", id);
    const prompt = (id: string) => db.prepare("SELECT * FROM owner_feature_prompt WHERE subject_id = ? AND key = 'comms.news'").get(id) as any;
    const openTag = (b: string, id: string) => {
      const m = new RegExp(`<[a-z]+[^>]*\\bid="${id.replace(/[.]/g, "\\.")}"`).exec(b);
      return m ? m.index : -1;
    };
    /** The element with this id (section/li/details), up to its matching close tag (same tag name, depth-counted). */
    const elementById = (b: string, id: string): string => {
      const start = openTag(b, id);
      if (start < 0) return "";
      const tag = /^<([a-z]+)/.exec(b.slice(start))![1];
      const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
      re.lastIndex = start;
      let depth = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(b))) {
        depth += m[0].startsWith("</") ? -1 : 1;
        if (depth === 0) return b.slice(start, m.index + m[0].length);
      }
      return b.slice(start);
    };
    const question = (b: string) => {
      const i = b.indexOf(`data-news-question="1"`);
      if (i < 0) return "";
      const s = b.lastIndexOf("<div", i);
      return elementById(b.slice(0, s) + b.slice(s).replace(/^<div/, `<div id="__q"`), "__q");
    };
    const newsRow = (b: string) => elementById(b, "valg-comms.news");

    // ── Gate: off the allowlist nothing is shown or written ─────────────────
    {
      const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
      const r = await invoke(H.page, makeReq({ params: { agentId: IDS.outside }, token: tokens[IDS.outside] }));
      assertEq(r.status, 404, "gate: not on the allowlist → GET /valg 404");
      for (const answer of ["yes", "later", "never"]) {
        assertEq((await post(H.intro, IDS.outside, { answer })).status, 404, `gate: not on the allowlist → POST valg/intro (${answer}) 404`);
      }
      assertEq([prompt(IDS.outside) ?? null, settingsRows(IDS.outside), auditRows(IDS.outside)], [null, 0, 0], "gate: nothing written off the allowlist");
      const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
      assertEq(after.n, before.n, "gate: no row changed at all");
      const portalOff = String((await invoke(H.portal, makeReq({ params: { agentId: IDS.outside }, token: tokens[IDS.outside] }))).body ?? "");
      process.env[ALLOW_ENV] = "";
      const portalNone = String((await invoke(H.portal, makeReq({ params: { agentId: IDS.outside }, token: tokens[IDS.outside] }))).body ?? "");
      process.env[ALLOW_ENV] = ALLOWED;
      assertEq(portalOff, portalNone, "gate: the portal of a producer off the list is byte-identical to the allowlist being empty");
      assertTrue(!portalOff.includes("Nyheter og tips") && !portalOff.includes("/valg/intro"), "gate: no news question in the portal off the list");
    }

    // ── Order: no #velkommen, the groups and the question in place ──────────
    {
      const b = await page(IDS.order);
      assertTrue(!b.includes(`id="velkommen"`), "order: no #velkommen without an answer");
      const firstGroup = /<section class="ep-card mv-group" id="(gruppe-[a-z_]+)"/.exec(b)?.[1] ?? "";
      const ids = ["statistikk", "niva", firstGroup, "gruppe-notify", "gruppe-comms", "planlagt", "endringslogg"];
      const pos = ids.map((id) => openTag(b, id));
      assertTrue(!!firstGroup && pos.every((p) => p > 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]),
        `order: #statistikk < #niva < first group (${firstGroup}) < #gruppe-notify < #gruppe-comms < #planlagt < #endringslogg (${pos.join(",")})`);
      assertEq(firstGroup, "gruppe-visibility", "order: the first group is «Hvem kan finne deg»");
      const groupOrder = [...b.matchAll(/<section class="ep-card mv-group" id="gruppe-([a-z_]+)"/g)].map((m) => m[1]);
      const want = ["visibility", "contact", "products", "orders", "payments", "auto", "stats", "connect", "notify", "comms"].filter((g) => groupOrder.includes(g));
      assertEq(groupOrder, want, "order: groups — synlighet, kontakt, produkter, bestillinger, betaling, automatisk oppdatering, statistikk, koblinger, varsler, kontakt fra RFB");
      assertEq(groupOrder[groupOrder.length - 1], "comms", "order: «Kontakt fra Rett fra Bonden» is the last group");
      assertEq(reg.OWNER_FEATURE_GROUPS.map((g) => g.key), ["visibility", "contact", "products", "orders", "payments", "auto", "stats", "connect", "notify", "comms"], "order: OWNER_FEATURE_GROUPS in the T7 order");
      const comms = elementById(b, "gruppe-comms");
      const q = question(b);
      assertTrue(!!q && comms.includes(`data-news-question="1"`), "order: the question stands inside #gruppe-comms");
      assertTrue(comms.indexOf(`data-news-question="1"`) < comms.indexOf(`<li class="mv-item"`), "order: …at the top of the group, above its rows");
      assertEq((b.match(/data-news-question="1"/g) || []).length, 1, "order: one place at a time (the question once)");
      const beforeStats = b.slice(0, openTag(b, "niva"));
      assertTrue(!beforeStats.includes("Vil du ha nyheter og tips"), "order: never at the top of the page");

      // Texts, verbatim.
      for (const t of [
        "Vil du ha nyheter og tips på e-post?",
        "Vi forteller om nye ting du kan bruke, og gir tips om hvordan flere kunder finner deg. Vi har ikke begynt å sende nyheter ennå. Vi sender bare når vi har noe nyttig å fortelle, og du kan melde deg av når som helst.",
        "Beskjeder om bestillingene dine og viktige endringer i vilkårene får du uansett.",
        "&gt;Ja takk&lt;",
        "&gt;Ikke nå&lt;",
        "Svarer du «Ikke nå», får du ingen nyheter.",
        "Nei, ikke spør meg igjen",
      ]) {
        const plain = t.replace("&gt;", ">").replace("&lt;", "<");
        assertTrue(q.includes(plain), `texts: the question says «${plain.replace(/[<>]/g, "")}»`);
      }
      assertTrue(comms.includes("Dette er frivillig, og du kan endre det når som helst."), "texts: the subtitle under «Kontakt fra Rett fra Bonden»");
      assertTrue(elementById(b, "gruppe-notify").includes("Beskjeder som hører til noe du har slått på, for eksempel nye bestillinger. Du får dem så lenge det er på."), "texts: the subtitle under «Varsler til deg»");
      assertTrue(newsRow(b).includes("Nyheter om ting du kan bruke, og tips om hvordan flere kunder finner deg. Vi har ikke begynt å sende nyheter ennå. Du kan melde deg av når som helst."), "texts: the row text");
      const en = nc.OWNER_NEWS_CONSENT_TEXT.row.en;
      assertTrue(!!en && en !== nc.OWNER_NEWS_CONSENT_TEXT.row.no && en.includes("not started sending news yet"), "texts: the row text has an English equivalent");
      assertTrue(!newsRow(b).includes(MAIN_NEWS_DESCRIPTION.no), "texts: the allowlisted row shows the consent text, not the registry description");
      assertTrue(!/hver (uke|måned)|ukentlig|månedlig|en gang i/i.test(q + newsRow(b)), "texts: no promise of frequency");

      // Buttons.
      const btns = [...q.matchAll(/<button type="submit" class="([^"]+)">([^<]+)<\/button>/g)].map((m) => ({ cls: m[1], label: m[2] }));
      const yesB = btns.find((x) => x.label === "Ja takk");
      const laterB = btns.find((x) => x.label === "Ikke nå");
      const neverB = btns.find((x) => x.label === "Nei, ikke spør meg igjen");
      assertTrue(!!yesB && !!laterB && yesB.cls === laterB.cls, `buttons: «Ja takk» and «Ikke nå» have the same class (${yesB?.cls} / ${laterB?.cls})`);
      assertTrue(!q.includes("ep-btn-primary"), "buttons: no ep-btn-primary in the question");
      assertTrue(!!neverB && neverB.cls === "mv-linkbtn" && !neverB.cls.includes("ep-btn"), "buttons: «Nei, ikke spør meg igjen» is the quiet link button");
      assertTrue(!/\sstyle="/.test(q), "buttons: no inline style in the question");
      const css = pg.OWNER_PAGE_CSS;
      const rule = (sel: string) => (new RegExp(`${sel.replace(/[.:-]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css) || [])[1] || "";
      assertTrue(/min-height: 44px/.test(rule(".mv-linkbtn")), "buttons: the link button is ≥ 44 px tall");
      assertTrue(/color: var\(--ow-accent\)/.test(rule(".mv-linkbtn")), "buttons: link colour from the T6 tokens (ow-accent, ≥ 4.5:1 on the surface)");
      assertTrue(/outline: 3px solid var\(--ow-accent-line\)/.test(rule(".mv-linkbtn:focus-visible")), "buttons: visible focus ring on the tokens (ow-accent-line, ≥ 3:1)");
      const tok = require("../owner-ui/tokens") as typeof import("../owner-ui/tokens");
      assertTrue(tok.OWNER_CONTRAST_PAIRS.some((p) => p.fg === "ow-accent" && p.bg === "ow-surface" && p.min >= 4.5)
        && tok.OWNER_CONTRAST_PAIRS.some((p) => p.fg === "ow-accent-line" && p.bg === "ow-surface" && p.min >= 3), "buttons: the colours used are held to AA by the T6 contrast pairs");

      // Forms: plain POSTs that name the card for the script.
      const forms = [...q.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
      assertEq(forms.length, 3, "forms: three answer forms");
      assertTrue(forms.every((f) => /method="post"/.test(f[1]) && f[1].includes(`action="/eier/${IDS.order}/valg/intro"`) && f[1].includes(`data-mv-row="gruppe-comms"`)),
        "forms: method post, action …/valg/intro, data-mv-row=\"gruppe-comms\"");
      assertEq(forms.map((f) => (/name="answer" value="([a-z]+)"/.exec(f[2]) || [])[1]), ["yes", "later", "never"], "forms: answer=yes|later|never");
    }

    // ── No GET writes ───────────────────────────────────────────────────────
    {
      const dump = () => JSON.stringify(["owner_feature_prompt", "owner_feature_settings", "owner_feature_audit", "owner_feature_change_batch", "owner_feature_intro", "agents"]
        .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
      const before = dump();
      for (const q of [{}, { melding: "intro_ja", ved: "gruppe-comms" }, { melding: "intro_ikke_na", ved: "gruppe-comms" }, { melding: "intro_nei" }, { answer: "yes" }]) {
        await page(IDS.order, q as Record<string, string>);
      }
      assertTrue(dump() === before, "GET: the page writes nothing (also with ?melding= / ?answer=)");
      assertEq(prompt(IDS.order) ?? null, null, "GET: no prompt row from a page view");
    }

    // ── «Ikke nå»: no setting, no audit; rests 90 days; three rounds max ────
    resetCap();
    {
      const id = IDS.later;
      const t0 = Date.now();
      const r1 = await post(H.intro, id, { answer: "later" });
      assertEq([r1.status, loc(r1)], [303, `/eier/${id}/valg?melding=intro_ikke_na&ved=gruppe-comms#gruppe-comms`], "later: 303 to #gruppe-comms with the message");
      assertEq([settingsRows(id), auditRows(id), count("SELECT COUNT(*) AS n FROM owner_feature_change_batch WHERE subject_id = ?", id)], [0, 0, 0],
        "later: no owner_feature_settings, no owner_feature_audit, no batch row");
      const p1 = prompt(id);
      const restMs = new Date(p1?.snoozed_until).getTime() - t0;
      assertTrue(p1?.state === "later" && p1?.rounds === 1 && p1?.answered_at === null, "later: one prompt row, round 1, no «answered» time (not a no)");
      assertTrue(Math.abs(restMs - 90 * 86_400_000) < 60_000, `later: rests 90 days (${Math.round(restMs / 86_400_000)} d)`);
      assertEq(rs.resolveOwnerFeature("rfb", id, "comms.news", { db }).value, false, "later: comms.news stays off (no news)");
      const b1 = await follow(id, loc(r1));
      assertTrue(!question(b1) && elementById(b1, "gruppe-comms").includes("Greit. Vi spør igjen tidligst om tre måneder. Du kan slå det på her når du vil."),
        "later: the question is gone and the confirmation stands in #gruppe-comms");
      assertTrue(!newsRow(b1).includes("Du sa"), "later: the row says nothing about an answer");
      const resolved = () => rs.resolveOwnerFeatures("rfb", id, { db });
      const day = 86_400_000;
      assertEq(ch.readOwnerNewsState("rfb", id, resolved(), { db, now: new Date(t0 + 89 * day) }).showQuestion, false, "later: still resting after 89 days");
      assertEq(ch.readOwnerNewsState("rfb", id, resolved(), { db, now: new Date(t0 + 91 * day) }).showQuestion, true, "later: back after 90 days");
      // Rounds 2 and 3 (the rest is over: move snoozed_until into the past).
      const wake = () => db.prepare("UPDATE owner_feature_prompt SET snoozed_until = ? WHERE subject_id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
      wake();
      assertTrue(!!question(await page(id)), "later: the question is back once the rest is over (round 2)");
      await post(H.intro, id, { answer: "later" });
      assertEq(prompt(id)?.rounds, 2, "later: round 2 counted");
      wake();
      assertTrue(!!question(await page(id)), "later: round 3 shown");
      await post(H.intro, id, { answer: "later" });
      assertEq(prompt(id)?.rounds, 3, "later: round 3 counted");
      wake();
      assertTrue(!question(await page(id)), "later: after three rounds the question is not shown — even with the rest over");
      assertEq(ch.readOwnerNewsState("rfb", id, resolved(), { db, now: new Date(t0 + 3650 * day) }).showQuestion, false, "later: …never again (ten years on)");
      const r4 = await post(H.intro, id, { answer: "later" });
      assertTrue(loc(r4).includes("melding=ingen_endring") && prompt(id)?.rounds === 3, "later: a fourth «Ikke nå» is refused, nothing written");
      assertEq([settingsRows(id), auditRows(id)], [0, 0], "later: three rounds, still no setting and no audit row");
      // The row is still the place to change it.
      assertTrue(newsRow(await page(id)).includes("Slå på"), "later: the row still offers «Slå på»");
    }

    // ── «Nei, ikke spør meg igjen»: explicit no with its time ───────────────
    resetCap();
    {
      const id = IDS.never;
      const r = await post(H.intro, id, { answer: "never" });
      assertEq(loc(r), `/eier/${id}/valg?melding=intro_nei&ved=gruppe-comms#gruppe-comms`, "never: 303 to #gruppe-comms with the message");
      const p = prompt(id);
      assertTrue(p?.state === "never" && /^\d{4}-\d{2}-\d{2}T/.test(String(p?.answered_at)) && p?.actor_detail === `post@${id}.example.no`,
        "never: an explicit no with its time and the session e-mail");
      assertEq([settingsRows(id), auditRows(id)], [0, 0], "never: comms.news was off already — no setting change, no audit row");
      const b = await follow(id, loc(r));
      assertTrue(!question(b) && elementById(b, "gruppe-comms").includes("Greit. Vi spør ikke igjen. Du kan slå det på her hvis du ombestemmer deg."), "never: the confirmation in #gruppe-comms");
      const dd = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(p.answered_at));
      assertTrue(newsRow(b).includes(`Du sa nei ${dd}.`), `never: the row says «Du sa nei ${dd}.»`);
      assertTrue(!question(await page(id)), "never: the question is not shown again");
      assertEq(ch.readOwnerNewsState("rfb", id, rs.resolveOwnerFeatures("rfb", id, { db }), { db, now: new Date(Date.now() + 3650 * 86_400_000) }).showQuestion, false, "never: …ever");
    }

    // ── «Ja takk»: comms.news on, text_version + placement, «Angre» works ───
    resetCap();
    {
      const id = IDS.yes;
      const r = await post(H.intro, id, { answer: "yes" });
      assertTrue(r.status === 303 && /^\/eier\/t7-yes\/valg\?endret=\d+&melding=intro_ja#gruppe-comms$/.test(loc(r)), `yes: 303 …?endret=<n>&melding=intro_ja#gruppe-comms (${loc(r)})`);
      assertEq(rs.resolveOwnerFeature("rfb", id, "comms.news", { db }).value, true, "yes: comms.news is on");
      const a = db.prepare("SELECT key, old_json, new_json, actor, actor_detail, text_version, placement FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
      assertEq(a, [{ key: "comms.news", old_json: "false", new_json: "true", actor: "owner", actor_detail: `post@${id}.example.no`, text_version: nc.OWNER_NEWS_CONSENT_VERSION, placement: nc.OWNER_NEWS_PLACEMENT_QUESTION }],
        "yes: one audit row with text_version and placement");
      const batchId = Number((/endret=(\d+)/.exec(loc(r)) || [])[1]);
      const batch = db.prepare("SELECT kind FROM owner_feature_change_batch WHERE id = ? AND subject_id = ?").get(batchId, id) as any;
      assertEq(batch?.kind, "single", "yes: one batch (the normal audited path)");
      assertEq(prompt(id)?.state, "yes", "yes: the prompt row says yes");
      const b = await follow(id, loc(r));
      const row = newsRow(b);
      assertTrue(row.includes("Takk! Du får nyheter og tips på e-post. Du kan slå det av her når som helst.") && row.includes(">Angre<"), "yes: the confirmation stands in the row, with «Angre»");
      assertTrue(row.includes(">På<") && !question(b), "yes: the row says «På», the question is gone");
      const dd = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
      assertTrue(row.includes(`Du sa ja ${dd}.`), `yes: the row says «Du sa ja ${dd}.»`);
      // «Angre».
      const u = await post(H.angre, id, { batch: String(batchId) });
      assertTrue(u.status === 303 && /#valg-comms\.news$/.test(loc(u)), `yes: «Angre» → 303 to the row (${loc(u)})`);
      const undoBatchId = Number((/endret=(\d+)/.exec(loc(u)) || [])[1] || 0);
      assertEq(rs.resolveOwnerFeature("rfb", id, "comms.news", { db }).value, false, "yes: after «Angre» comms.news is off");
      assertEq(settingsRows(id), 0, "yes: «Angre» removes the row the answer created");
      assertEq(auditRows(id), 2, "yes: «Angre» is itself audited");
      const bu = await page(id);
      assertTrue(!!question(bu) && !newsRow(bu).includes("Du sa ja"), "yes: after «Angre» the question is back where it was");
      // The row switch (the place where the choice is changed) stamps its place.
      resetCap();
      await post(H.sett, IDS.row, { key: "comms.news", value: "true", confirmed: "1" });
      const ra = db.prepare("SELECT new_json, text_version, placement FROM owner_feature_audit WHERE subject_id = ? ORDER BY id DESC LIMIT 1").get(IDS.row) as any;
      assertEq(ra, { new_json: "true", text_version: nc.OWNER_NEWS_CONSENT_VERSION, placement: nc.OWNER_NEWS_PLACEMENT_ROW }, "yes: switched on in the row → text_version + placement mine_valg_row");
      assertTrue(!question(await page(IDS.row)), "yes: set in the row → no question");
      await post(H.sett, IDS.row, { key: "orders.enabled", value: "false", confirmed: "1" });
      const nonConsent = db.prepare("SELECT text_version, placement FROM owner_feature_audit WHERE subject_id = ? AND key <> 'comms.news'").all(IDS.row) as any[];
      assertTrue(nonConsent.every((x) => x.text_version === null && x.placement === null), "yes: a non-consent key's audit row carries no consent stamp");
      // A form from a page cached before T7 («Nei takk», answer=no) is an explicit no.
      // A bogus placement falls back to the question's place.
      resetCap();
      await post(H.intro, IDS.placement, { answer: "yes", placement: "oversikt\"><x" });
      const pa = db.prepare("SELECT placement, text_version FROM owner_feature_audit WHERE subject_id = ? AND key = 'comms.news'").get(IDS.placement) as any;
      assertEq(pa, { placement: nc.OWNER_NEWS_PLACEMENT_QUESTION, text_version: nc.OWNER_NEWS_CONSENT_VERSION }, "yes: a bogus placement value falls back to mine_valg_question");
      // ?melding=intro_ja on a batch that is not the «Ja takk» change (here: the undo of it) → the normal message.
      const nb = await page(IDS.yes, { endret: String(undoBatchId), melding: "intro_ja" });
      assertTrue(undoBatchId > 0 && nb.includes("Angret. «Nyheter og tips» er Av.") && !nb.includes(nc.OWNER_NEWS_ANSWER_TEXT.yes),
        "yes: melding=intro_ja with a batch that is not the comms.news «Ja» change shows the normal message");
      const old = await post(H.intro, IDS.old, { answer: "no" });
      assertTrue(loc(old).includes("melding=intro_nei") && prompt(IDS.old)?.state === "never", "yes: an old cached «no» answer = an explicit no");
      assertTrue(loc(await post(H.intro, IDS.order, { answer: "kanskje" })).includes("melding=ugyldig&ved=gruppe-comms#gruppe-comms") && !prompt(IDS.order),
        "yes: a junk answer → «ugyldig» at #gruppe-comms, nothing written");
    }

    // ── The gårdssalg variant shows neither the group notes nor the question ─
    {
      const resolved = rs.resolveOwnerFeatures("rfb", IDS.order, { db });
      const variant = {
        vertical: "gardssalg" as const, platformName: "Opplevagent", csEmail: "kontakt@opplevagent.no",
        pagePath: (tail: string) => `/gardssalg/x/valg${tail}`, backHref: "/gardssalg/x",
        groups: reg.OWNER_FEATURE_GROUPS, levels: ch.GARDSSALG_OWNER_LEVELS, statusKeys: [], revealKey: "orders.enabled", pauseResumeDate: false,
      };
      const body = pg.renderOwnerFeaturesPageBody({
        agent: { id: IDS.order, name: "Gard" }, resolved, level: null, showIntro: true, newsAnswer: { answer: "yes", at: "2026-10-20T10:00:00.000Z" },
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 }, variant,
      });
      assertTrue(!body.includes(`data-news-question="1"`) && !body.includes("/valg/intro"), "gårdssalg: no news question, even with showIntro");
      assertTrue(!body.includes(nc.OWNER_COMMS_GROUP_NOTE) && !body.includes(nc.OWNER_NOTIFY_GROUP_NOTE) && !body.includes(`class="mv-desc mv-group-note"`), "gårdssalg: no T7 group notes");
      assertTrue(!body.includes(nc.OWNER_NEWS_CONSENT_TEXT.row.no) && !body.includes("Du sa ja"), "gårdssalg: the news row keeps its registry text, no «Du sa ja»");
    }

    // ── Legacy owner_feature_intro rows count as answered ───────────────────
    {
      db.prepare(`INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at, actor_detail) VALUES ('rfb', ?, 'no', '2026-10-20T10:00:00.000Z', 'x')`).run(IDS.legacyNo);
      db.prepare(`INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at, actor_detail) VALUES ('rfb', ?, 'yes', '2026-10-21T10:00:00.000Z', 'x')`).run(IDS.legacyYes);
      const bn = await page(IDS.legacyNo);
      assertTrue(!question(bn) && !bn.includes(`id="velkommen"`), "legacy: an old «nei» row → no question");
      assertTrue(newsRow(bn).includes("Du sa nei 20.10.2026."), "legacy: the row says «Du sa nei 20.10.2026.»");
      const by = await page(IDS.legacyYes);
      assertTrue(!question(by), "legacy: an old «ja» row → no question");
      resetCap();
      const r = await post(H.intro, IDS.legacyNo, { answer: "yes" });
      assertTrue(loc(r).includes("melding=ingen_endring") && !prompt(IDS.legacyNo), "legacy: answering again changes nothing");
    }

    // ── No e-mail asks for consent (code search) ────────────────────────────
    {
      const root = path.resolve(__dirname, "..");
      const files = sourceFiles(root);
      const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
      const read = (f: string) => codeOnly(fs.readFileSync(f, "utf8"));
      const mentions = files.filter((f) => {
        const t = read(f);
        return /nyheter og tips/i.test(t) || t.includes("/valg/intro") || t.includes("OWNER_NEWS_CONSENT") || t.includes(nc.OWNER_NEWS_CONSENT_TEXT.question);
      }).map(rel).sort();
      const allowed = ["owner-features/changes.ts", "owner-features/news-consent.ts", "owner-features/page.ts", "owner-features/registry.ts", "routes/owner-features.ts"];
      assertTrue(mentions.every((f) => allowed.includes(f)), `e-mail: the news question lives only in the page/route/registry (${mentions.join(", ")})`);
      const mailers = files.filter((f) => /email-service|sendRaw\(|sendMail\(|nodemailer|resend/i.test(read(f)));
      const asking = mailers.filter((f) => {
        const t = read(f);
        return /nyheter og tips/i.test(t) || t.includes("/valg/intro") || t.includes("OWNER_NEWS_CONSENT") || /comms\.news/.test(t);
      }).map(rel);
      assertTrue(mailers.length > 3, `e-mail: the search sees the mail-sending modules (${mailers.length})`);
      assertEq(asking, [], "e-mail: no module that sends e-mail asks for news consent");
    }

    // ── Consent text: version + hash ────────────────────────────────────────
    {
      const v = nc.OWNER_NEWS_CONSENT_VERSION;
      const h = nc.ownerNewsConsentHash();
      assertTrue(/^[0-9a-f]{64}$/.test(h), "text: the consent text has a sha256 hash");
      assertTrue(Object.prototype.hasOwnProperty.call(PINNED_CONSENT_HASHES, v), `text: version ${v} is pinned in this test`);
      assertEq(h, PINNED_CONSENT_HASHES[v], `text: the consent text matches the hash pinned for version ${v} (changed text ⇒ new version)`);
      const changed = { ...nc.OWNER_NEWS_CONSENT_TEXT, body: nc.OWNER_NEWS_CONSENT_TEXT.body + " " };
      assertTrue(nc.ownerNewsConsentHash(changed) !== h, "text: any change to the text changes the hash");
      assertEq(reg.findOwnerFeature("comms.news")!.description, MAIN_NEWS_DESCRIPTION, "text: the registry description of comms.news is unchanged from main (public pages read it)");
      const shown = await page(IDS.order);
      assertTrue(newsRow(shown).includes(nc.OWNER_NEWS_CONSENT_TEXT.row.no), "text: the versioned row text is what the allowlisted «Mine valg» row shows");
    }

    // ── B1: the public «For produsenter» page is unchanged (no T7 text before approval) ─
    {
      const fp = require("./rfb-for-produsenter") as typeof import("./rfb-for-produsenter");
      const facts = fp.currentForProdusenterFacts();
      const no = fp.renderForProdusenterPage("no", "https://rettfrabonden.com/for-produsenter", facts);
      const en = fp.renderForProdusenterPage("en", "https://rettfrabonden.com/en/for-produsenter", facts);
      const pageText = (x: { content: string; jsonLd: object }) => x.content + JSON.stringify(x.jsonLd);
      assertTrue(no.content.includes(`<li><strong>Nyheter og tips</strong>: ${MAIN_NEWS_DESCRIPTION.no}</li>`), "for-produsenter (NO): the comms.news line is exactly as on main");
      assertTrue(en.content.includes(`<li><strong>News and tips</strong>: ${MAIN_NEWS_DESCRIPTION.en}</li>`), "for-produsenter (EN): the comms.news line is exactly as on main");
      for (const [lang, x] of [["NO", no], ["EN", en]] as const) {
        const t = pageText(x);
        assertTrue(![nc.OWNER_NEWS_CONSENT_TEXT.row.no, nc.OWNER_NEWS_CONSENT_TEXT.row.en, nc.OWNER_NEWS_CONSENT_TEXT.question, nc.OWNER_COMMS_GROUP_NOTE, nc.OWNER_NOTIFY_GROUP_NOTE].some((s) => t.includes(s)),
          `for-produsenter (${lang}): no T7 text on the public page`);
      }
    }

    // ── Schema ──────────────────────────────────────────────────────────────
    {
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>);
      assertEq(cols("owner_feature_prompt").map((c) => c.name), ["vertical", "subject_id", "key", "state", "rounds", "snoozed_until", "answered_at", "actor_detail"], "schema: owner_feature_prompt columns");
      const audit = cols("owner_feature_audit");
      assertTrue(["text_version", "placement"].every((n) => audit.some((c) => c.name === n && c.notnull === 0)), "schema: owner_feature_audit.text_version / placement, nullable");
      let threw = false;
      try { initMod.__initSchemaForTesting(db as any); } catch { threw = true; }
      assertTrue(!threw && cols("owner_feature_audit").filter((c) => c.name === "text_version").length === 1, "schema: the migration is idempotent");
      // An old database without the columns gets them.
      const old = new Database(":memory:");
      old.exec(`CREATE TABLE owner_feature_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, vertical TEXT NOT NULL, subject_id TEXT NOT NULL, key TEXT NOT NULL, old_json TEXT, new_json TEXT, actor TEXT NOT NULL, actor_detail TEXT, at TEXT NOT NULL)`);
      old.prepare(`INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, at) VALUES ('rfb', 'x', 'comms.news', 'false', 'true', 'owner', '2026-10-01T00:00:00.000Z')`).run();
      try { initMod.__initSchemaForTesting(old as any); } catch { /* other migrations on a bare db may log */ }
      const oc = (old.prepare(`PRAGMA table_info(owner_feature_audit)`).all() as Array<{ name: string }>).map((c) => c.name);
      const kept = old.prepare(`SELECT text_version, placement, new_json FROM owner_feature_audit`).get() as any;
      assertTrue(oc.includes("text_version") && oc.includes("placement") && kept?.new_json === "true" && kept.text_version === null, "schema: an existing audit table gets the nullable columns, old rows kept");
      old.close();
      initMod.__setDbForTesting(db as any);
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    if (prevAllow === undefined) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = prevAllow;
    if (prevGate === undefined) delete process.env[GATE_ENV]; else process.env[GATE_ENV] = prevGate;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesT7Tests({ log: true }).then((r) => {
    console.info(`\nowner-features-t7: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
