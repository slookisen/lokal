/**
 * organic-owner-gate-s3c.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S3c (the owner's own text):
 * RFB_ORGANIC_CLAIM_GATE + RFB_ORGANIC_OWNER_GATE (both default off).
 *
 *   unit    dropOrganicSentences (incl. everything dropped → ""),
 *           validOwnerOrgNr (9 digits + MOD11), the flag readers.
 *   S3c.1   owner saves «Vi selger økologisk lammekjøtt. Gården ligger i
 *           Hurdal.» for an unverified producer, both flags on → stored
 *           unchanged, organic_notice: true, /eier/:id/save redirects with
 *           organic=1, the portal shows the message + the org.nr. form. Either
 *           flag off, or a verified producer → no notice, no message, portal
 *           byte-identical to flags off.
 *   S3c.2   profile page NO / EN / SV (body + JSON-LD) shows «Gården ligger i
 *           Hurdal.» without the organic sentence, also for a published EN/SV
 *           translation; verified producer, non-owner about, or flags off →
 *           unchanged.
 *   S3c.3   POST /eier/:id/org-nr: 8 digits / wrong MOD11 refused
 *           (orgnr=invalid), valid stored in agent_owner_org_nr with
 *           agents.org_nr untouched; cross-site POST and a foreign owner
 *           session refused; flags off → not handled (404). The register sync
 *           with an entity on that number → a pending debio_match_review row
 *           (match_method 'owner_org_nr'), the producer NOT okologisk/verified;
 *           a rejected pair is not re-added; owner nr = agents.org_nr → nothing
 *           new; approving the row through decideMatchReview works.
 *
 * In-memory DB on the production schema, handlers pulled off the router
 * stacks, fetch stubbed — zero network. Env vars, globalThis.fetch,
 * console.log and the getDb() singleton are restored in finally.
 *
 * Exported runOrganicOwnerGateS3cTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/organic-owner-gate-s3c.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";
import { dropOrganicSentences, containsOrganicClaim } from "../services/organic-claims";
import {
  organicOwnerGateEnabled, organicOwnerGateActive, ORGANIC_OWNER_GATE_ENV, ORGANIC_CLAIM_GATE_ENV,
} from "../services/description-quality";
import { validOwnerOrgNr } from "../services/debio-register-client";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult { status: number; body: any }

const U = "s3c-uten-status";      // no valid Debio status
const V = "s3c-med-status";       // debio_verified = 1
const N = "s3c-ikke-eier";        // about not written by the owner
const OTHER = "s3c-annen-eier";   // a foreign owner session
const NAMES: Record<string, string> = {
  [U]: "Hurdaltun Testgard",
  [V]: "Godkjenttun Testgard",
  [N]: "Rutinetun Testgard",
  [OTHER]: "Annentun Testgard",
};
const OWNER_TEXT = "Vi selger økologisk lammekjøtt. Gården ligger i Hurdal.";
const KEPT = "Gården ligger i Hurdal.";
const EN_TEXT = "We sell organic lamb. The farm is in Hurdal.";
const SV_TEXT = "Vi säljer ekologiskt lammkött. Gården ligger i Hurdal.";
const NOTICE = "Ordet økologisk kan bare vises når Debio har godkjent virksomheten. Legg inn organisasjonsnummer, så sjekker vi registeret automatisk.";
const SAVED = "Takk. Vi sjekker nummeret mot Debios register ved neste kjøring, og en person godkjenner treffet før ordet kan vises.";
const VALID_ORG = "923 609 016";   // MOD11-valid
const VALID_ORG_DIGITS = "923609016";
const NOW = new Date("2026-11-02T12:00:00.000Z");
const FUTURE = "2027-06-30";

export async function runOrganicOwnerGateS3cTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  // ── unit ──────────────────────────────────────────────────────────────────
  assertEq(dropOrganicSentences(OWNER_TEXT), KEPT, "unit-drop-1: organic sentence dropped, the rest kept");
  assertEq(dropOrganicSentences("Økologisk drift siden 1990! Vi har sau. Kom innom?"), "Vi har sau. Kom innom?", "unit-drop-2: «!» ends a sentence too; «?» kept");
  assertEq(dropOrganicSentences("Vi er Debio-sertifisert. Alt er økologisk."), "", "unit-drop-3: every sentence organic → empty");
  assertEq(dropOrganicSentences("Gårdsutsalg i Hurdal.\nAlt er økologisk\nÅpent lørdager."), "Gårdsutsalg i Hurdal.\nÅpent lørdager.", "unit-drop-4: a newline ends a sentence; lines kept");
  assertEq(dropOrganicSentences("Første avsnitt.\n\nØkologisk andre avsnitt.\n\nTredje avsnitt."), "Første avsnitt.\n\nTredje avsnitt.", "unit-drop-5: paragraph breaks kept between kept paragraphs");
  const clean = "Vi tar vare på økologisk mangfold. Sau og lam.";
  assertTrue(dropOrganicSentences(clean) === clean, "unit-drop-6: other-meaning phrase → unchanged (same string)");
  assertEq([dropOrganicSentences(""), dropOrganicSentences(undefined), dropOrganicSentences(7)], ["", "", ""], "unit-drop-7: empty / non-string → \"\"");
  assertEq(dropOrganicSentences(EN_TEXT), "The farm is in Hurdal.", "unit-drop-8: English «organic» sentence dropped");
  assertEq(dropOrganicSentences(SV_TEXT), KEPT, "unit-drop-9: Swedish «ekologiskt» sentence dropped");
  // Review fix-up: a sentence ends only at [.!?…]+ before whitespace / end; kept sentences verbatim.
  assertEq(dropOrganicSentences("Vi selger 1.5 kg lam til kr 49.90. Alt er økologisk."), "Vi selger 1.5 kg lam til kr 49.90.", "unit-drop-10: «1.5» and «kr 49.90» kept verbatim");
  assertEq(dropOrganicSentences("Vi har 1.5 tonn økologisk honning. Velkommen!"), "Velkommen!", "unit-drop-11: «1.5 tonn økologisk honning» drops the whole sentence, no «Vi har 1.» fragment");
  assertEq(dropOrganicSentences("Vi har ca. 20 kyr, f.eks. NRF. Alt er økologisk."), "Vi har ca. 20 kyr, f.eks. NRF.", "unit-drop-12: «f.eks.» mid-sentence kept verbatim");
  assertEq(dropOrganicSentences("Skriv til post@gard.no for bestilling. Alt er økologisk."), "Skriv til post@gard.no for bestilling.", "unit-drop-13: e-mail address intact");
  assertEq(dropOrganicSentences("Se https://www.gard.no/butikk.html?a=1 for mer. Alt er økologisk!"), "Se https://www.gard.no/butikk.html?a=1 for mer.", "unit-drop-14: URL intact");
  assertEq(dropOrganicSentences("Ca. 20 kyr, f.eks. økologisk melk. Vi har også sau."), "Ca. 20 kyr, f.eks. Vi har også sau.", "unit-drop-15: abbreviation before a space may end a piece — claim-free pieces verbatim, the claim piece dropped");
  assertEq(dropOrganicSentences("Hei… Alt er økologisk… Velkommen."), "Hei… Velkommen.", "unit-drop-16: «…» ends a sentence");
  for (const t of ["Vi har 1.5 tonn økologisk honning. Velkommen!", "Ca. 20 kyr, f.eks. økologisk melk. Vi har også sau.", "Økologisk.Gården ligger i Hurdal.", "Les mer på https://okologisk.example.no/ nå."]) {
    assertTrue(!containsOrganicClaim(dropOrganicSentences(t)), `unit-drop-17: never outputs a claim («${t}»)`, dropOrganicSentences(t));
  }

  assertEq(validOwnerOrgNr(VALID_ORG), VALID_ORG_DIGITS, "unit-org-1: spaces removed, MOD11 valid");
  assertEq(validOwnerOrgNr("974760673"), "974760673", "unit-org-2: another valid number");
  assertEq(validOwnerOrgNr("92360901"), null, "unit-org-3: 8 digits → invalid");
  assertEq(validOwnerOrgNr("923609017"), null, "unit-org-4: wrong check digit → invalid");
  assertEq(validOwnerOrgNr("9236090160"), null, "unit-org-5: 10 digits → invalid");
  assertEq(validOwnerOrgNr("923-609-016"), null, "unit-org-6: only spaces are stripped");
  assertEq(validOwnerOrgNr(undefined), null, "unit-org-7: missing → invalid");
  // A remainder of 1 → check digit 10 → no valid number with these 8 digits.
  {
    const w = [3, 2, 7, 6, 5, 4, 3, 2];
    let tenCase: string | null = null;
    for (let n = 10000000; n < 10000100 && !tenCase; n++) {
      const d = String(n);
      const sum = d.split("").reduce((a, c, i) => a + Number(c) * w[i], 0);
      if (11 - (sum % 11) === 10) tenCase = d;
    }
    assertTrue(!!tenCase && [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((c) => validOwnerOrgNr(`${tenCase}${c}`) === null), "unit-org-8: check digit 10 → invalid for every last digit", tenCase);
  }

  assertTrue(!organicOwnerGateEnabled({}), "flag-1: owner gate unset → off");
  assertTrue(organicOwnerGateEnabled({ [ORGANIC_OWNER_GATE_ENV]: "1" }) && organicOwnerGateEnabled({ [ORGANIC_OWNER_GATE_ENV]: "true" }), "flag-2: '1' / 'true' → on");
  assertTrue(!organicOwnerGateEnabled({ [ORGANIC_OWNER_GATE_ENV]: "0" }), "flag-3: '0' → off");
  assertTrue(!organicOwnerGateActive({ [ORGANIC_OWNER_GATE_ENV]: "1" }), "flag-4: owner gate alone → not active");
  assertTrue(!organicOwnerGateActive({ [ORGANIC_CLAIM_GATE_ENV]: "1" }), "flag-5: claim gate alone → not active");
  assertTrue(organicOwnerGateActive({ [ORGANIC_CLAIM_GATE_ENV]: "1", [ORGANIC_OWNER_GATE_ENV]: "1" }), "flag-6: both → active");

  // ── harness ───────────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = [ORGANIC_CLAIM_GATE_ENV, ORGANIC_OWNER_GATE_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "PROFILE_TRANSLATIONS_SERVE_ENABLED",
    "RFB_DEBIO_REGISTER_SYNC", "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "WRITE_GUARD_FETCH_METADATA"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const setEnv = (k: string, v: string | null) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
  const flags = (claim: boolean, owner: boolean) => { setEnv(ORGANIC_CLAIM_GATE_ENV, claim ? "1" : null); setEnv(ORGANIC_OWNER_GATE_ENV, owner ? "1" : null); };
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }

  function findHandler(router: any, path: string, method: string): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { method?: string; params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string>; lang?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.method || "POST", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body ?? {}, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc?: string) { if (typeof c === "number") status = c; settle({ __redirect: loc ?? c }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; }, clearCookie() { return res; },
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
  db.pragma("foreign_keys = OFF");

  function seed(id: string, o: { verified: boolean; about: string; ownerAbout: boolean; orgNr?: string | null }): void {
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(id);
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at, debio_verified, org_nr)
       VALUES (?, ?, '', 'test', ?, ?, 'producer', ?, 60.43, 11.06, 'Hurdal', '["meat"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?, ?)`,
    ).run(id, NAMES[id], `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.verified ? 1 : 0, o.orgNr ?? null);
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, website, phone, address, postal_code, about, products, curated_fields, verification_status, verified_second_line,
          enrichment_status, url_last_status, url_last_probed, last_verified_at, updated_at)
       VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '2090', ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z', '2026-09-01T10:00:00.000Z')`,
    ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, o.about,
      JSON.stringify([{ name: "Lammekjøtt", price: "200 kr/kg", category: "meat" }]),
      JSON.stringify(o.ownerAbout ? { about: { locked_at: "2026-09-01T10:00:00.000Z", by: "owner" } } : {}));
  }
  const tokenFor = (id: string) => `tok-s3c-${id}`;
  function session(id: string): void {
    db.prepare("INSERT OR REPLACE INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(`mlsess_${id}`, `post@${id}.example.no`, tokenFor(id), id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  }
  const aboutOf = (id: string) => (db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get(id) as any)?.about;
  const ownerOrgNrRow = (id: string) => db.prepare("SELECT owner_org_nr FROM agent_owner_org_nr WHERE agent_id = ?").get(id) as any;
  const agentOrgNr = (id: string) => (db.prepare("SELECT org_nr FROM agents WHERE id = ?").get(id) as any)?.org_nr ?? null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) setEnv(k, null);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    for (const m of ["./owner-portal", "./seo"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const portalRouter = portalMod.default as any;
    const updateProfile = findHandler(portalRouter, "/api/agents/:id/update-profile", "post");
    const portalGet = findHandler(portalRouter, "/eier/:agentId/portal", "get");
    const save = findHandler(portalRouter, "/eier/:agentId/save", "post");
    const orgNrPost = findHandler(portalRouter, "/eier/:agentId/org-nr", "post");

    const up = (id: string, body: Record<string, unknown>) => invoke(updateProfile, makeReq({ params: { id }, body, token: tokenFor(id) }));
    const portal = async (id: string, query: Record<string, string> = {}) =>
      String((await invoke(portalGet, makeReq({ method: "GET", params: { agentId: id }, query, token: tokenFor(id) }))).body ?? "");
    const postOrgNr = (id: string, orgNr: string, o: { token?: string; headers?: Record<string, string> } = {}) =>
      invoke(orgNrPost, makeReq({ params: { agentId: id }, body: { org_nr: orgNr }, token: o.token ?? tokenFor(id), headers: o.headers }));
    // /eier/:id/save forwards to update-profile with a server-side fetch: stubbed to call the handler.
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const m = /\/api\/agents\/([^/]+)\/update-profile$/.exec(u);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const r = await invoke(updateProfile, makeReq({ params: { id }, body: JSON.parse(init.body), headers: { authorization: init.headers.Authorization } }));
        return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const saveForm = (id: string, description: string) =>
      invoke(save, makeReq({ params: { agentId: id }, body: { field_description: description }, token: tokenFor(id) }));

    for (const id of [U, V, N, OTHER]) session(id);

    // ═══ S3c.1: save notice + portal message ═══════════════════════════════
    {
      // Flags off: stored unchanged, no notice, no message.
      flags(false, false);
      seed(U, { verified: false, about: "Gammel tekst om gården.", ownerAbout: false });
      let r = await up(U, { description: OWNER_TEXT });
      assertEq([r.status, r.body?.success, aboutOf(U)], [200, true, OWNER_TEXT], "s1-off-1: flags off → stored unchanged");
      assertTrue(!("organic_notice" in (r.body || {})), "s1-off-2: flags off → no organic_notice key", r.body);
      const pageOff = await portal(U);
      const pageOffQ = await portal(U, { organic: "1" });
      assertTrue(!pageOff.includes(NOTICE) && !pageOffQ.includes(NOTICE) && !pageOff.includes("ep-orgnr-form"), "s1-off-3: flags off → no message, no org.nr. form (even with organic=1)");
      // Byte-identity baseline for the portal with flags off.
      const baseline = pageOff;
      let sv = await saveForm(U, OWNER_TEXT);
      assertEq(sv.body?.__redirect, `/eier/${U}/portal?status=saved`, "s1-off-4: flags off → /save redirect unchanged");

      // One flag only: as off.
      for (const [c, o] of [[true, false], [false, true]] as const) {
        flags(c, o);
        seed(U, { verified: false, about: "Gammel tekst om gården.", ownerAbout: false });
        r = await up(U, { description: OWNER_TEXT });
        const html = await portal(U, { organic: "1" });
        assertTrue(!("organic_notice" in (r.body || {})) && !html.includes(NOTICE), `s1-one-flag: claim=${c} owner=${o} → no notice, no message`);
      }

      // Both on, unverified.
      flags(true, true);
      seed(U, { verified: false, about: "Gammel tekst om gården.", ownerAbout: false });
      r = await up(U, { description: OWNER_TEXT });
      assertEq([r.status, r.body?.success, r.body?.organic_notice, aboutOf(U)], [200, true, true, OWNER_TEXT], "s1-on-1: stored unchanged + organic_notice: true");
      const cf = JSON.parse((db.prepare("SELECT curated_fields FROM agent_knowledge WHERE agent_id = ?").get(U) as any).curated_fields);
      assertEq(cf.about?.by, "owner", "s1-on-2: curated_fields.about.by = owner (as before)");
      // Re-saving the same text (no change) still answers with the notice.
      r = await up(U, { description: OWNER_TEXT });
      assertEq([r.body?.updated_fields, r.body?.organic_notice], [[], true], "s1-on-3: unchanged organic text → notice still returned");
      r = await up(U, { phone: "+47 912 34 000" });
      assertTrue(!("organic_notice" in r.body), "s1-on-4: a save without description → no notice");
      r = await up(U, { description: "Vi tar vare på økologisk mangfold i Hurdal." });
      assertTrue(!("organic_notice" in r.body), "s1-on-5: other-meaning text → no notice");
      r = await up(U, { description: OWNER_TEXT });
      sv = await saveForm(U, OWNER_TEXT);
      assertEq(sv.body?.__redirect, `/eier/${U}/portal?status=saved&organic=1`, "s1-on-6: /save redirects with organic=1");
      sv = await saveForm(U, "Gården ligger i Hurdal og selger lam.");
      assertEq(sv.body?.__redirect, `/eier/${U}/portal?status=saved`, "s1-on-7: /save without organic text → no organic=1");
      r = await up(U, { description: OWNER_TEXT });

      let html = await portal(U);
      assertTrue(html.includes(NOTICE), "s1-on-8: portal shows the message (stored owner about with organic claim)");
      assertTrue(html.includes('id="ep-orgnr-form"') && html.includes(`action="/eier/${U}/org-nr"`) && html.includes('name="org_nr" form="ep-orgnr-form"'), "s1-on-9: org.nr. form posting to /eier/:id/org-nr");
      const desc = html.indexOf('id="field_description"');
      const note = html.indexOf(NOTICE);
      const profileEnd = html.indexOf("</form>", html.indexOf('id="ep-profile-form"'));
      assertTrue(desc > 0 && note > desc && note < profileEnd, "s1-on-10: message sits at the description field (inside the profile card)");
      assertTrue(!/<form[^>]*ep-profile-form[^]*?<form/.test(html.slice(html.indexOf('id="ep-profile-form"') - 30, profileEnd)), "s1-on-11: no form nested in the profile form");
      // organic=1 alone (about without claim) also shows it.
      seed(U, { verified: false, about: "Gården ligger i Hurdal.", ownerAbout: true });
      assertTrue(!(await portal(U)).includes(NOTICE), "s1-on-12: clean about, no organic=1 → no message");
      assertTrue((await portal(U, { organic: "1" })).includes(NOTICE), "s1-on-13: organic=1 → message");
      // Non-owner about with a claim, no organic=1 → no message (not the owner's text).
      seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: false });
      assertTrue(!(await portal(U)).includes(NOTICE), "s1-on-14: non-owner about → no message");
      // orgnr result lines, escaped stored value.
      seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true });
      html = await portal(U, { organic: "1", orgnr: "invalid" });
      assertTrue(html.includes('data-orgnr-status="invalid"') && html.includes("Organisasjonsnummeret er ikke gyldig"), "s1-on-15: orgnr=invalid → short Norwegian error");
      html = await portal(U, { organic: "1", orgnr: "saved" });
      assertTrue(html.includes(SAVED), "s1-on-16: orgnr=saved → the thank-you text");
      html = await portal(U, { organic: "1", orgnr: "<script>alert(1)</script>" });
      assertTrue(!html.includes("<script>alert(1)</script>"), "s1-on-17: unknown orgnr value is not reflected");

      // Another author holds the about lock → the save is skipped → no notice.
      seed(U, { verified: false, about: "Gammel tekst om gården.", ownerAbout: false });
      db.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?").run(JSON.stringify({ about: { locked_at: "2026-09-01T10:00:00.000Z", by: "admin" } }), U);
      r = await up(U, { description: OWNER_TEXT });
      assertEq([r.body?.skipped_fields, aboutOf(U)], [[{ field: "description", reason: "locked_by_admin" }], "Gammel tekst om gården."], "s1-lock-1: description locked by admin → skipped");
      assertTrue(!("organic_notice" in (r.body || {})), "s1-lock-2: skipped description → no organic_notice", r.body);

      // Verified producer: no notice, no message, portal as with flags off.
      seed(V, { verified: true, about: "Gammel tekst.", ownerAbout: false });
      r = await up(V, { description: OWNER_TEXT });
      assertTrue(r.body?.success === true && !("organic_notice" in r.body), "s1-ver-1: verified → no organic_notice");
      assertTrue(!(await portal(V)).includes(NOTICE) && !(await portal(V, { organic: "1" })).includes(NOTICE), "s1-ver-2: verified → no message");
      sv = await saveForm(V, OWNER_TEXT);
      assertEq(sv.body?.__redirect, `/eier/${V}/portal?status=saved`, "s1-ver-3: verified → /save without organic=1");

      // Byte-identity: flags off portal for the same state as the baseline.
      flags(false, false);
      seed(U, { verified: false, about: "Gammel tekst om gården.", ownerAbout: false });
      await up(U, { description: OWNER_TEXT });
      const again = await portal(U);
      assertEq(again.length, baseline.length, "s1-off-5: flags off → portal byte-identical across runs (length)");
    }

    // ═══ S3c.3: POST /eier/:id/org-nr ══════════════════════════════════════
    {
      flags(false, false);
      seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true, orgNr: null });
      let r = await postOrgNr(U, VALID_ORG);
      assertEq(r.body?.__next, true, "s3-off-1: flags off → not handled (falls through to 404)");
      assertEq(ownerOrgNrRow(U), undefined, "s3-off-2: nothing stored");
      flags(true, false);
      r = await postOrgNr(U, VALID_ORG);
      assertEq(r.body?.__next, true, "s3-off-3: one flag only → not handled");

      flags(true, true);
      r = await invoke(orgNrPost, makeReq({ params: { agentId: U }, body: { org_nr: VALID_ORG } }));
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${U}`], "s3-guard-1: no session → redirect to login");
      r = await postOrgNr(U, VALID_ORG, { token: tokenFor(OTHER) });
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${U}`], "s3-guard-2: a foreign owner session → refused (redirect)");
      r = await postOrgNr(U, VALID_ORG, { headers: { "sec-fetch-site": "cross-site" } });
      assertEq(r.status, 403, "s3-guard-3: cross-site POST → 403");
      r = await postOrgNr(U, VALID_ORG, { headers: { origin: "https://evil.example" } });
      assertEq(r.status, 403, "s3-guard-4: foreign Origin → 403");
      assertEq(ownerOrgNrRow(U), undefined, "s3-guard-5: nothing stored by refused requests");
      setEnv("OWNER_VERIFIED_OWNER_GATE_ENABLED", "1");
      db.prepare("UPDATE agents SET claimed_at = NULL WHERE id = ?").run(U);
      r = await postOrgNr(U, VALID_ORG);
      assertEq(r.status, 403, "s3-guard-6: verified-owner gate on, ownership not verified → 403 (as /save)");
      db.prepare("UPDATE agents SET claimed_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(U);
      setEnv("OWNER_VERIFIED_OWNER_GATE_ENABLED", null);

      r = await postOrgNr(U, "92360901");
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${U}/portal?organic=1&orgnr=invalid`], "s3-val-1: 8 digits → orgnr=invalid");
      r = await postOrgNr(U, "923609017");
      assertEq(r.body?.__redirect, `/eier/${U}/portal?organic=1&orgnr=invalid`, "s3-val-2: wrong MOD11 → orgnr=invalid");
      assertEq(ownerOrgNrRow(U), undefined, "s3-val-3: invalid numbers not stored");
      r = await postOrgNr(U, VALID_ORG);
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${U}/portal?organic=1&orgnr=saved`], "s3-val-4: valid → orgnr=saved");
      assertEq(ownerOrgNrRow(U)?.owner_org_nr, VALID_ORG_DIGITS, "s3-val-5: stored in agent_owner_org_nr (digits only)");
      assertEq(agentOrgNr(U), null, "s3-val-6: agents.org_nr untouched");
      const at = (db.prepare("SELECT owner_org_nr_at FROM agent_owner_org_nr WHERE agent_id = ?").get(U) as any)?.owner_org_nr_at;
      assertTrue(typeof at === "string" && !Number.isNaN(Date.parse(at)), "s3-val-7: owner_org_nr_at is an ISO time", at);
      const html = await portal(U, { organic: "1", orgnr: "saved" });
      assertTrue(html.includes(`value="${VALID_ORG_DIGITS}"`), "s3-val-8: portal pre-fills the stored candidate");
    }

    // ═══ S3c.3: register sync → review candidate only ══════════════════════
    {
      const sync = require("../services/debio-register-sync") as typeof import("../services/debio-register-sync");
      const regRows = [
        { name: "Hurdaltun Testgard AS", clientCode: VALID_ORG_DIGITS, certSid: 7001, postalCode: "9001", city: "Fjernby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
        { name: "Rutinetun Holding", clientCode: "974760673", certSid: 7002, postalCode: "9002", city: "Fjernby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
      ];
      const fakeFetch = (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("getcertificates")) return new Response(JSON.stringify({ certificates: regRows }), { status: 200, headers: { "content-type": "application/json" } });
        if (u.includes("finnoko.debio.no/api/acm/companies")) return new Response("[]", { status: 200 });
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const run = () => sync.syncDebioRegister(db, { fetchImpl: fakeFetch, dryRun: false, now: NOW, skipCache: true, minRows: 1 });
      const statusOf = (id: string) => db.prepare("SELECT s.debio_status, a.debio_verified, s.debio_match_method FROM agents a LEFT JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.id = ?").get(id) as any;
      const reviews = (id: string) => db.prepare("SELECT id, org_nr, match_method, state, reasons FROM debio_match_review WHERE agent_id = ? ORDER BY id").all(id) as any[];

      process.env.RFB_DEBIO_REGISTER_SYNC = "1";
      // N: owner nr equal to agents.org_nr → the existing safe org_nr match, nothing new.
      seed(N, { verified: false, about: "Gård i Hurdal.", ownerAbout: false, orgNr: "974760673" });
      db.prepare("INSERT OR REPLACE INTO agent_owner_org_nr (agent_id, owner_org_nr, owner_org_nr_at) VALUES (?, ?, ?)").run(N, "974760673", NOW.toISOString());

      // Flags off: no owner_org_nr candidate, result shape as before S3c.
      flags(false, false);
      let res = await run();
      assertTrue(res.accepted && !("owner_org_nr_candidates" in res), "sync-0a: flags off → no owner_org_nr_candidates field", Object.keys(res));
      assertEq(reviews(U).filter((x) => x.match_method === "owner_org_nr").length, 0, "sync-0b: flags off → no owner_org_nr review row");
      flags(true, false);
      res = await run();
      assertTrue(!("owner_org_nr_candidates" in res) && reviews(U).length === 0, "sync-0c: one flag only → as off");
      flags(true, true);

      res = await run();
      assertEq(res.accepted, true, "sync-1: register run accepted");
      const rv = reviews(U);
      assertEq(rv.map((x) => [x.org_nr, x.match_method, x.state]), [[VALID_ORG_DIGITS, "owner_org_nr", "pending"]], "sync-2: a pending review row with match_method owner_org_nr");
      assertTrue(String(rv[0]?.reasons || "").includes("owner_supplied"), "sync-3: reasons mention owner-supplied", rv[0]?.reasons);
      const st = statusOf(U);
      assertTrue(st.debio_status !== "okologisk" && st.debio_verified === 0 && st.debio_match_method === null, "sync-4: producer NOT okologisk / verified", st);
      assertEq(res.owner_org_nr_candidates, 1, "sync-5: owner_org_nr_candidates counted");
      assertEq(agentOrgNr(U), null, "sync-6: agents.org_nr still untouched");
      assertEq([statusOf(N).debio_match_method, reviews(N).length], ["org_nr", 0], "sync-7: owner nr = agents.org_nr → safe org_nr match as before, no review row");

      // Re-run: same row, no duplicate.
      res = await run();
      assertEq(reviews(U).length, 1, "sync-8: re-run keeps one pending row");

      // Rejected pair is not re-added.
      sync.decideMatchReview(db, reviews(U)[0].id, "reject", { now: NOW });
      res = await run();
      assertEq(reviews(U).map((x) => x.state), ["rejected"], "sync-9: rejected pair not re-added");
      assertEq(res.owner_org_nr_candidates, 0, "sync-10: no candidate counted for a rejected pair");

      // Approve path: a fresh pending row approved through decideMatchReview.
      db.prepare("DELETE FROM debio_match_review WHERE agent_id = ?").run(U);
      await run();
      const pending = reviews(U)[0];
      const dec = sync.decideMatchReview(db, pending.id, "approve", { now: NOW });
      assertEq([dec?.state, dec?.debio_status, dec?.debio_verified], ["approved", "okologisk", 1], "sync-11: approving the row → okologisk / verified via the review path");
      await run();
      assertEq([statusOf(U).debio_status, statusOf(U).debio_verified, statusOf(U).debio_match_method], ["okologisk", 1, "review"], "sync-12: the next run keeps the approved match (method review)");
      assertEq(agentOrgNr(U), null, "sync-13: agents.org_nr never written");

      // listMatchReview shows what the owner typed.
      const listed = sync.listMatchReview(db, "all").filter((x) => x.agent.id === U);
      assertTrue(listed.length > 0 && listed.every((x) => x.agent.owner_org_nr === VALID_ORG_DIGITS), "sync-14: listMatchReview carries agent.owner_org_nr", listed.map((x) => x.agent));

      // A NEW owner number removes stale PENDING owner_org_nr rows only.
      const ins = db.prepare(`INSERT INTO debio_match_review (agent_id, entity_key, org_nr, status, match_method, state, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, 'okologisk', ?, ?, ?, ?)`);
      const iso = NOW.toISOString();
      ins.run(U, "stale-pending", "911111111", "owner_org_nr", "pending", iso, iso);
      ins.run(U, "stale-rejected", "911111112", "owner_org_nr", "rejected", iso, iso);
      ins.run(U, "name-pending", "911111113", "name", "pending", iso, iso);
      ins.run(U, "same-pending", "974760673", "owner_org_nr", "pending", iso, iso);
      ins.run(OTHER, "other-pending", "911111114", "owner_org_nr", "pending", iso, iso);
      const keys = (id: string) => (db.prepare("SELECT entity_key, state FROM debio_match_review WHERE agent_id = ? ORDER BY entity_key").all(id) as any[]).map((x) => `${x.entity_key}:${x.state}`);
      const before = keys(U);
      const pr = await postOrgNr(U, "974760673");
      assertEq(pr.body?.__redirect, `/eier/${U}/portal?organic=1&orgnr=saved`, "stale-1: new number saved");
      assertEq(keys(U), before.filter((k) => k !== "stale-pending:pending"), "stale-2: only the stale pending owner_org_nr row removed (approved / rejected / other method / same number kept)");
      assertEq(keys(OTHER), ["other-pending:pending"], "stale-3: other agents untouched");
      const prBad = await postOrgNr(U, "92360901");
      assertEq([prBad.body?.__redirect, keys(U).length], [`/eier/${U}/portal?organic=1&orgnr=invalid`, before.length - 1], "stale-4: an invalid number removes nothing");
      process.env.RFB_DEBIO_REGISTER_SYNC = "";
      delete process.env.RFB_DEBIO_REGISTER_SYNC;
      db.prepare("DELETE FROM agent_debio_status").run();
      db.prepare("DELETE FROM debio_match_review").run();
      db.prepare("DELETE FROM agent_owner_org_nr").run();
    }

    // ═══ S3c.2: profile page NO / EN / SV ══════════════════════════════════
    {
      const { ensureProfileTranslationsSchema } = require("../services/profile-translations") as typeof import("../services/profile-translations");
      ensureProfileTranslationsSchema(db);
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      const clearRegistryCaches = () => {
        (marketplaceRegistry as any)._agentsCache = null; (marketplaceRegistry as any)._statsCache = null;
        (marketplaceRegistry as any)._agentsCacheTime = 0; (marketplaceRegistry as any)._statsCacheTime = 0;
      };
      const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
      const produsent = findHandler(seoRouter, "/produsent/:slug", "get");
      const page = async (id: string, lang = "no") => {
        clearRegistryCaches();
        const r = await invoke(produsent, makeReq({ method: "GET", params: { slug: slugify(NAMES[id]) }, lang }));
        return { status: r.status, html: String(r.body ?? "") };
      };
      // Related-producer cards (other producers' previews) are out of S3c's
      // scope (this producer's profile outputs only) — cut before page-wide checks.
      const own = (html: string) => html.replace(/<a [^>]*class="rp-card"[\s\S]*?<\/a>/g, "");
      const descOf = (html: string) => (html.match(/<p class="pf-desc"[^>]*>([^<]*)<\/p>/) || [])[1] ?? null;
      const ldDescriptions = (html: string) => {
        const out: string[] = [];
        for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
          const walk = (x: any) => {
            if (!x || typeof x !== "object") return;
            if (Array.isArray(x)) { x.forEach(walk); return; }
            if (typeof x.description === "string" && (x["@type"] === "LocalBusiness" || x["@type"] === "FoodEstablishment" || x["@type"] === "Organization" || x.name === NAMES[U] || x.name === NAMES[V] || x.name === NAMES[N])) out.push(x.description);
            for (const v of Object.values(x)) walk(v);
          };
          try { walk(JSON.parse(m[1])); } catch { /* not JSON */ }
        }
        return out;
      };
      const addTranslation = (id: string, lang: string, text: string) => {
        db.prepare(
          `INSERT OR REPLACE INTO profile_translations (platform, entity_type, entity_id, entity_name, field, lang, source_text, source_hash, translated_text, status, published_at)
           VALUES ('rfb', 'agent', ?, ?, 'about', ?, ?, 'h', ?, 'published', datetime('now'))`,
        ).run(id, NAMES[id], lang, OWNER_TEXT, text);
      };

      seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true });
      seed(V, { verified: true, about: OWNER_TEXT, ownerAbout: true });
      seed(N, { verified: false, about: OWNER_TEXT, ownerAbout: false });

      // Flags off: unchanged.
      flags(false, false);
      const offNo = await page(U);
      assertEq([offNo.status, descOf(offNo.html)], [200, OWNER_TEXT], "s2-off-1: flags off → full owner text in the body");
      assertTrue(ldDescriptions(offNo.html).includes(OWNER_TEXT), "s2-off-2: flags off → JSON-LD description unchanged", ldDescriptions(offNo.html));
      flags(true, false);
      assertEq(descOf((await page(U)).html), OWNER_TEXT, "s2-off-3: claim gate only → unchanged");
      flags(false, true);
      assertEq(descOf((await page(U)).html), OWNER_TEXT, "s2-off-4: owner gate only → unchanged");

      flags(true, true);
      const no = await page(U);
      assertEq([no.status, descOf(no.html)], [200, KEPT], "s2-no-1: NO body shows «Gården ligger i Hurdal.» only");
      assertTrue(!own(no.html).includes("økologisk lammekjøtt") && !containsOrganicClaim(descOf(no.html) ?? ""), "s2-no-2: NO page has no organic sentence");
      assertTrue(ldDescriptions(no.html).includes(KEPT) && ldDescriptions(no.html).every((d) => !containsOrganicClaim(d)), "s2-no-3: NO JSON-LD description filtered", ldDescriptions(no.html));
      const en = await page(U, "en");
      assertEq([en.status, descOf(en.html)], [200, KEPT], "s2-en-1: EN (no translation) shows the kept Norwegian sentence");
      assertTrue(!own(en.html).includes("økologisk lammekjøtt") && ldDescriptions(en.html).every((d) => !containsOrganicClaim(d)), "s2-en-2: EN page without the organic sentence");
      const sv = await page(U, "sv");
      assertEq([sv.status, descOf(sv.html)], [200, KEPT], "s2-sv-1: SV shows the kept sentence");

      // Published translations of the owner text are filtered too.
      setEnv("PROFILE_TRANSLATIONS_SERVE_ENABLED", "true");
      addTranslation(U, "en", EN_TEXT);
      addTranslation(U, "sv", SV_TEXT);
      const enT = await page(U, "en");
      assertEq(descOf(enT.html), "The farm is in Hurdal.", "s2-en-3: EN translation filtered");
      assertTrue(!own(enT.html).includes("organic lamb") && !own(enT.html).includes("økologisk lammekjøtt"), "s2-en-4: no «organic lamb» on the EN page");
      const svT = await page(U, "sv");
      assertEq(descOf(svT.html), KEPT, "s2-sv-2: SV translation filtered");
      assertTrue(!own(svT.html).includes("ekologiskt lammkött"), "s2-sv-3: no «ekologiskt lammkött» on the SV page");
      flags(false, false);
      assertEq(descOf((await page(U, "en")).html), EN_TEXT, "s2-off-5: flags off → EN translation unchanged");
      flags(true, true);

      // Everything organic → empty about → the existing fallback (no pf-desc).
      seed(U, { verified: false, about: "Alt vi selger er økologisk. Vi er Debio-sertifisert.", ownerAbout: true });
      db.prepare("DELETE FROM profile_translations WHERE entity_id = ?").run(U);
      const empty = await page(U);
      assertEq([empty.status, descOf(empty.html)], [200, null], "s2-empty-1: every sentence dropped → about treated as empty");
      assertTrue(!own(empty.html).includes("Alt vi selger er økologisk"), "s2-empty-2: nothing of the organic text shown");

      // Verified producer and non-owner about: unchanged.
      const ver = await page(V);
      assertEq(descOf(ver.html), OWNER_TEXT, "s2-ver-1: verified producer → text unchanged");
      assertTrue(ldDescriptions(ver.html).includes(OWNER_TEXT), "s2-ver-2: verified → JSON-LD unchanged");
      const non = await page(N);
      assertEq(descOf(non.html), OWNER_TEXT, "s2-non-1: non-owner about → unchanged (S3c touches owner text only)");
      addTranslation(N, "en", EN_TEXT);
      assertEq(descOf((await page(N, "en")).html), EN_TEXT, "s2-non-2: non-owner about → EN translation unchanged");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    globalThis.fetch = prevFetch;
    for (const k of ENV_KEYS) setEnv(k, prevEnv[k] ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (marketplaceRegistry as any)._agentsCache = null;
      (marketplaceRegistry as any)._statsCache = null;
    } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicOwnerGateS3cTests({ log: true }).then((r) => {
    console.log(`\norganic-owner-gate-s3c: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
