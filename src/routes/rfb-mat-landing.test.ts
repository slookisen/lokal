/**
 * rfb-mat-landing.test.ts — dev-request 2026-09-24-ai-sok-bli-svaret-rfb,
 * slice B6: /mat/<kategori>/<sted> produkt×sted landing pages on RFB.
 *
 * Against the real seo.ts router and sitemap builder on the production schema
 * in an in-memory DB (same harness as rfb-hidden-test-producer.test.ts):
 *   (a) flag RFB_MAT_LANDING_ENABLED off: the route falls through (404) and
 *       the sitemap has no /mat/ entry.
 *   (b) flag on: a combination with exactly MAT_LANDING_MIN_PRODUCERS (2)
 *       visible producers answers 200 with an answer-first opening, the
 *       producers linked to /produsent/<slug>, FAQPage + BreadcrumbList JSON-LD
 *       and a self canonical, and is in the sitemap; a combination with 1 does
 *       not (404, not listed) — the pair pins the threshold both ways.
 *   (c) hidden (catalog_hidden), inactive, unvetted, non-producer-role and
 *       knowledge-less unclaimed producers neither count toward the gate nor
 *       appear on the page.
 *   (d) unknown category («ost»: no such category), unknown place, /en → 404;
 *       an upper-case variant of a served page → 301 to the canonical URL.
 *   (e) producer names are HTML-escaped; no rating markup.
 *   (f) the sitemap has no duplicate <loc>, and route ⇔ sitemap agree.
 *   (g) wrong host: the dental and Opplevagent routers, which own their hosts
 *       before seo.ts is reached, answer /mat/… themselves with a 404.
 *
 * Exported runRfbMatLandingTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-mat-landing.test.ts
 */

import Database from "better-sqlite3";
import { jsonLdBlocks, offersWithoutPrice, forbiddenNodes } from "../../tests/helpers/jsonld-invariants";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type RouteResult = { handled: boolean; status: number; body: string; location: string | null };

function callRoute(router: any, url: string, opts: { lang?: string; hostname?: string } = {}): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: {},
      headers: { host: opts.hostname || "rettfrabonden.com", "user-agent": "test" },
      hostname: opts.hostname || "rettfrabonden.com",
      cookies: {},
      ip: "127.0.0.1",
      lang: opts.lang || "no",
      get(name: string) { return this.headers[String(name).toLowerCase()]; },
      header(name: string) { return this.headers[String(name).toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); return this; },
      getHeader(k: string) { return headers[k.toLowerCase()]; },
      header(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); return this; },
      set(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); return this; },
      type() { return this; },
      cookie() { return this; },
      append() { return this; },
      redirect(a: any, b?: any) {
        const code = typeof a === "number" ? a : 302;
        const loc = typeof a === "number" ? b : a;
        resolve({ handled: true, status: code, body: "", location: String(loc) });
      },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), location: null }); },
      end(body?: unknown) { resolve({ handled: true, status: statusCode, body: body == null ? "" : String(body), location: null }); },
      json(body: unknown) { resolve({ handled: true, status: statusCode, body: JSON.stringify(body), location: null }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: 404, body: err ? String(err?.stack || err) : "", location: null });
    });
  });
}

const BERGEN = { lat: 60.3913, lng: 5.3221 };
const OSLO = { lat: 59.9139, lng: 10.7522 };

interface Seed {
  id: string;
  name: string;
  categories: string[];
  city?: string;
  coord?: { lat: number; lng: number };
  isActive?: number;
  isVetted?: number;
  catalogHidden?: number;
  role?: string;
  knowledge?: boolean;
  verified?: number;
  trust?: number;
}

function seed(db: Database.Database, s: Seed): void {
  const c = s.coord ?? BERGEN;
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, is_vetted, catalog_hidden, origin, vertical_id)
     VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 'discovery', 'rfb')`,
  ).run(
    s.id, s.name, "Liten familiegård som selger egne råvarer direkte fra gården.",
    `post@${s.id}.example.no`, `https://${s.id}.example.no`, s.role ?? "producer", `key-${s.id}`,
    c.lat, c.lng, s.city ?? "Bergen", JSON.stringify(s.categories), s.trust ?? 0.7,
    s.isActive ?? 1, s.verified ?? 0, s.isVetted ?? 1, s.catalogHidden ?? 0,
  );
  if (s.knowledge !== false) {
    db.prepare(`INSERT INTO agent_knowledge (agent_id, about, updated_at) VALUES (?, ?, ?)`)
      .run(s.id, "Vi selger direkte fra gården.", "2026-10-20 10:00:00");
  }
}

const XSS_NAME = `Melkebu <script>alert(1)</script> & "Co"`;

function locs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]*)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export async function runRfbMatLandingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log === true;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (cond) passed++;
    else { failed++; failures.push(msg); if (log) console.log("  FAIL " + msg); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const { marketplaceRegistry } = require("../services/marketplace-registry") as any;
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const prevFlag = process.env.RFB_MAT_LANDING_ENABLED;
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => {}; console.warn = () => {}; }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    clearRegistryCaches();

    // Meieri i Bergen: exactly 2 visible producers + 4 that must not count.
    seed(db, { id: "mat-a", name: "Fjellost Gard", categories: ["dairy"], verified: 1, trust: 0.9 });
    seed(db, { id: "mat-b", name: XSS_NAME, categories: ["Dairy", "meat"], trust: 0.8 });
    seed(db, { id: "mat-c", name: "Skjult Meieri Test", categories: ["dairy"], catalogHidden: 1 });
    seed(db, { id: "mat-d", name: "Inaktiv Meieri Test", categories: ["dairy"], isActive: 0 });
    seed(db, { id: "mat-e", name: "Logistikk Meieri Test", categories: ["dairy"], role: "logistics" });
    seed(db, { id: "mat-f", name: "Uvettet Meieri Test", categories: ["dairy"], isVetted: 0 });
    // Slug on SITEMAP_EXCLUDED_PRODUCER_SLUGS (its /produsent page 404s): not counted, not listed.
    seed(db, { id: "mat-x", name: "Debio Sertifisering", categories: ["dairy"] });
    // Kjøtt i Bergen: 1 visible (mat-b above) + 1 unvetted → 404.
    seed(db, { id: "mat-g", name: "Uvettet Kjott Test", categories: ["meat"], isVetted: 0 });
    // Fisk i Bergen: 1 visible + 1 hidden → 404 (would be 2 if hidden counted).
    seed(db, { id: "mat-h", name: "Havfisk Bergen", categories: ["fish"] });
    seed(db, { id: "mat-i", name: "Skjult Fisk Test", categories: ["fish"], catalogHidden: 1 });
    // Honning i Bergen: 1 with knowledge + 1 unclaimed without (no producer page) → 404.
    seed(db, { id: "mat-j", name: "Honningbu Bergen", categories: ["honey"] });
    seed(db, { id: "mat-k", name: "Honning Uten Kunnskap", categories: ["honey"], knowledge: false });
    // Egg i Oslo: 3 visible.
    seed(db, { id: "mat-l", name: "Eggegarden Oslo", categories: ["eggs"], city: "Oslo", coord: OSLO });
    seed(db, { id: "mat-m", name: "Hønsehuset Oslo", categories: ["eggs"], city: "Oslo", coord: OSLO });
    seed(db, { id: "mat-n", name: "Morgenegg Oslo", categories: ["eggs", "vegetables"], city: "Oslo", coord: OSLO });
    db.prepare(`INSERT INTO agent_salgskanal (agent_id, category_slug, source) VALUES ('mat-a', 'gardsbutikk', 'manual')`).run();
    db.prepare(`INSERT INTO agent_salgskanal (agent_id, category_slug, source) VALUES ('mat-c', 'gardsbutikk', 'manual')`).run();
    clearRegistryCaches();

    delete require.cache[require.resolve("./seo")];
    const seoMod = require("./seo") as typeof import("./seo");
    const router = (seoMod as any).default;
    const svc = require("../services/rfb-mat-landing") as typeof import("../services/rfb-mat-landing");

    // ── Gate constant + predicate (mutation-sensitive) ──
    check(svc.MAT_LANDING_MIN_PRODUCERS === 2, `MIN is 2 (got ${svc.MAT_LANDING_MIN_PRODUCERS})`);
    check(svc.isMatLandingComboIndexable(1) === false, "gate: 1 producer is not indexable");
    check(svc.isMatLandingComboIndexable(2) === true, "gate: 2 producers are indexable");
    check(svc.isMatLandingComboIndexable(0) === false && svc.isMatLandingComboIndexable(NaN) === false, "gate: 0/NaN not indexable");
    check(svc.buildMatLandingFaqJsonLd({
      category: svc.matCategoryBySlug("kjott")!, placeName: "X", url: "u", producerNames: ["A"], verifiedCount: 0,
      channels: { gardsbutikk: 0, rekoRing: 0, selvplukk: 0, hjemlevering: 0 },
    }) === null, "FAQ builder returns null below the gate");
    check(svc.matCategoryBySlug("ost") === undefined, "no «ost» category (cheese is under meieri)");
    for (const c of svc.MAT_CATEGORIES) {
      check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug), `category slug ${c.slug} is lowercase ASCII`);
    }
    check(new Set(svc.MAT_CATEGORIES.map((c) => c.slug)).size === svc.MAT_CATEGORIES.length, "category slugs unique");

    // ── Norwegian: adjective agreement and V2 word order ──
    const NO_CH = { gardsbutikk: 0, rekoRing: 0, selvplukk: 0, hjemlevering: 0 };
    const firstQ = (slug: string) => {
      const ld = svc.buildMatLandingFaqJsonLd({
        category: svc.matCategoryBySlug(slug)!, placeName: "Bergen", url: "u", producerNames: ["A", "B"], verifiedCount: 0, channels: NO_CH,
      });
      return ld?.mainEntity?.[0]?.name;
    };
    check(firstQ("kjott") === "Hvor kan jeg kjøpe lokalt kjøtt i Bergen?", `kjøtt question: ${firstQ("kjott")}`);
    check(firstQ("fisk") === "Hvor kan jeg kjøpe lokal fisk i Bergen?", `fisk question: ${firstQ("fisk")}`);
    check(firstQ("gronnsaker") === "Hvor kan jeg kjøpe lokale grønnsaker i Bergen?", `grønnsaker question: ${firstQ("gronnsaker")}`);
    check(firstQ("frukt") === "Hvor kan jeg kjøpe lokal frukt i Bergen?", `frukt question: ${firstQ("frukt")}`);
    for (const c of svc.MAT_CATEGORIES) {
      check(/^lokal[et]? /.test(c.localNoun) && c.localNoun.endsWith(" " + c.noun), `${c.slug}: localNoun «${c.localNoun}» is lokal/lokale/lokalt + noun`);
    }
    const opening = (ch: typeof NO_CH, n = 3) => svc.buildMatLandingAnswerFirst({
      category: svc.matCategoryBySlug("kjott")!, placeName: "Bergen", producerNames: ["A", "B", "C", "D"].slice(0, n), channels: ch,
    });
    const o1 = opening({ ...NO_CH, gardsbutikk: 1, rekoRing: 2 });
    check(!!o1 && o1.includes(" 1 av dem har gårdsbutikk eller gårdsutsalg og 2 selger via REKO-ring. "), `V2 opening, counts 1 and 2: ${o1}`);
    const o2 = opening({ ...NO_CH, gardsbutikk: 2, selvplukk: 1, hjemlevering: 1 });
    check(!!o2 && o2.includes(" 2 av dem har gårdsbutikk eller gårdsutsalg, 1 har selvplukk og 1 leverer hjem. "), `V2 opening, three channels: ${o2}`);
    check(opening(NO_CH)!.startsWith("Kjøtt i Bergen: 3 lokale produsenter på Rett fra Bonden — A, B og C. Du handler direkte"), `opening without channels: ${opening(NO_CH)}`);
    const faq = svc.buildMatLandingFaqJsonLd({
      category: svc.matCategoryBySlug("gronnsaker")!, placeName: "Bergen", url: "u", producerNames: ["A", "B"], verifiedCount: 0,
      channels: { gardsbutikk: 1, rekoRing: 1, selvplukk: 2, hjemlevering: 0 },
    });
    const qa = new Map<string, string>((faq?.mainEntity || []).map((e: any) => [e.name, e.acceptedAnswer.text]));
    const pickupA = qa.get("Kan jeg hente grønnsaker selv hos produsenten i Bergen?");
    check(pickupA === "1 av de 2 produsentene har gårdsbutikk eller gårdsutsalg og 2 har selvplukk. Se profilsiden til hver produsent for adresse og hvordan du handler.", `pickup answer V2, no REKO: ${pickupA}`);
    const rekoA = qa.get("Kan jeg kjøpe grønnsaker via REKO-ring i Bergen?");
    check(!!rekoA && rekoA.startsWith("1 av de 2 produsentene selger via REKO-ring"), `REKO in its own question: ${rekoA}`);
    const onlyReko = svc.buildMatLandingFaqJsonLd({
      category: svc.matCategoryBySlug("gronnsaker")!, placeName: "Bergen", url: "u", producerNames: ["A", "B"], verifiedCount: 0,
      channels: { ...NO_CH, rekoRing: 2 },
    });
    check(!(onlyReko?.mainEntity || []).some((e: any) => /hente .* selv hos produsenten/.test(e.name)), "REKO alone does not produce the «hente selv hos produsenten» question");

    // ── (a) flag off ──
    delete process.env.RFB_MAT_LANDING_ENABLED;
    check(svc.isRfbMatLandingEnabled() === false, "flag default off");
    const offPage = await callRoute(router, "/mat/meieri/bergen");
    check(!offPage.handled, `flag off: /mat/meieri/bergen falls through (handled=${offPage.handled}, status=${offPage.status})`);
    seoMod.__resetSitemapCacheForTesting();
    const offXml = seoMod.buildSitemapXml();
    check(!offXml.includes("/mat/"), "flag off: sitemap has no /mat/ entries");

    // ── (b) flag on ──
    process.env.RFB_MAT_LANDING_ENABLED = "true";
    clearRegistryCaches();
    const page = await callRoute(router, "/mat/meieri/bergen");
    check(page.handled && page.status === 200, `flag on: /mat/meieri/bergen → 200 (handled=${page.handled}, status=${page.status}) ${page.handled ? "" : page.body.slice(0, 300)}`);
    const body = page.body;
    check(body.includes(`"@type":"FAQPage"`), "page has FAQPage JSON-LD");
    check(body.includes(`"@type":"BreadcrumbList"`), "page has BreadcrumbList JSON-LD");
    check(body.includes(`<link rel="canonical" href="https://rettfrabonden.com/mat/meieri/bergen">`), "self canonical");
    check(body.includes(`id="faq"`), "visible FAQ section");
    check(/Meieriprodukter i Bergen: 2 lokale produsenter på Rett fra Bonden/.test(body), "answer-first opening states product, place and count 2");
    check(body.includes("1 av dem har gårdsbutikk eller gårdsutsalg."), "pickup channel from agent_salgskanal, V2 order (hidden producer's row not counted)");
    check(!/Av dem \d|Av de \d+ produsentene \d/.test(body), "no «Av dem 1 har …» word order");
    check(body.includes("kontaktinformasjonen produsenten har gjort offentlig, står på profilsiden"), "opening hedges contact info");
    check(body.includes("Hvor kan jeg kjøpe lokale meieriprodukter i Bergen?"), "FAQ question rendered on the page");
    try {
      const blocks = jsonLdBlocks(body);
      check(blocks.length === 3, `3 JSON-LD blocks parse (got ${blocks.length})`);
      check(forbiddenNodes(blocks).length === 0, `jsonld-invariants: no forbidden nodes (${forbiddenNodes(blocks).join(", ")})`);
      check(offersWithoutPrice(blocks) === 0, "jsonld-invariants: no Offer without price");
    } catch (e: any) {
      check(false, `jsonld-invariants: ${e?.message || e}`);
    }
    check(body.includes(`href="/produsent/fjellost-gard"`), "producer A linked to /produsent/");
    check(body.includes(`href="/produsent/melkebu-script-alert-1-script-co"`), "producer B linked to /produsent/");
    check(body.includes(`href="/bergen"`), "links the place page");
    check(!body.includes(`hreflang="en"`), "no EN alternate");
    check(!/aggregateRating|ratingValue/.test(body), "no rating markup");

    // ── (c) hidden producers do not appear ──
    for (const n of ["Skjult Meieri Test", "Inaktiv Meieri Test", "Logistikk Meieri Test", "Uvettet Meieri Test", "Debio Sertifisering"]) {
      check(!body.includes(n), `${n} does not appear`);
    }

    // ── (e) escaping ──
    check(!body.includes("<script>alert(1)</script>"), "producer name script tag is escaped");
    check(body.includes("Melkebu &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;"), "producer name HTML-escaped in card");

    // ── below the gate → 404 ──
    for (const [url, why] of [
      ["/mat/kjott/bergen", "1 visible + 1 unvetted"],
      ["/mat/fisk/bergen", "1 visible + 1 catalog_hidden"],
      ["/mat/honning/bergen", "1 visible + 1 without producer page"],
      ["/mat/ost/bergen", "unknown category"],
      ["/mat/meieri/atlantis", "unknown place"],
      ["/mat/meieri/b%C3%A6rum", "non-ASCII place"],
    ] as const) {
      const r = await callRoute(router, url);
      check(!r.handled, `${url} (${why}) → 404 (handled=${r.handled}, status=${r.status})`);
    }
    const two = await callRoute(router, "/mat/egg/oslo");
    check(two.handled && two.status === 200 && two.body.includes("3 lokale produsenter"), "/mat/egg/oslo → 200 with 3 producers");

    // ── (d) variants ──
    const upper = await callRoute(router, "/mat/Meieri/Bergen");
    check(upper.status === 301 && upper.location === "/mat/meieri/bergen", `upper-case → 301 canonical (got ${upper.status} ${upper.location})`);
    const en = await callRoute(router, "/mat/meieri/bergen", { lang: "en" });
    check(!en.handled, "/en variant is not served");

    // ── owner visibility choices (OWNER_FEATURES_ENFORCE on) ──
    {
      const vis = require("../owner-features/visibility") as typeof import("../owner-features/visibility");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const prevEnforce = process.env.OWNER_FEATURES_ENFORCE;
      const prevAllow = process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e: any) =>
        e.key.startsWith("visibility.") ? { ...e, status: "live" as const } : e);
      try {
        vis.__setVisibilityRegistryForTesting(LIVE as any);
        process.env.OWNER_FEATURES_ENFORCE = "1";
        process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "rfb:mat-l,rfb:mat-m";
        const setChoice = (id: string, key: string, value: boolean) => {
          const r = rs.setOwnerFeatureValue("rfb", id, key as any, value, { actor: "owner" } as any, { db, registry: LIVE as any });
          if ((r as any).kind !== "ok") throw new Error(`setOwnerFeatureValue(${key}) → ${(r as any).kind}`);
          clearRegistryCaches();
        };
        setChoice("mat-l", "visibility.profile", false);
        const hiddenOne = await callRoute(router, "/mat/egg/oslo");
        check(hiddenOne.handled && hiddenOne.status === 200, `owner-hidden: /mat/egg/oslo still 200 with 2 (status ${hiddenOne.status})`);
        check(hiddenOne.body.includes("Egg i Oslo: 2 lokale produsenter"), "owner-hidden: profile-hidden producer not counted");
        check(!hiddenOne.body.includes("Eggegarden Oslo"), "owner-hidden: profile-hidden producer not listed");
        setChoice("mat-m", "visibility.search_engines", false);
        const below = await callRoute(router, "/mat/egg/oslo");
        check(!below.handled, "owner-hidden: search_engines-hidden producer not counted → below the gate → 404");
        seoMod.__resetSitemapCacheForTesting();
        check(!seoMod.buildSitemapXml().includes("/mat/egg/oslo"), "owner-hidden: below the gate → not in sitemap");
      } catch (e: any) {
        check(false, `owner-hidden: ${e?.stack || e}`);
      } finally {
        try { db.prepare("DELETE FROM owner_feature_settings WHERE subject_id IN ('mat-l','mat-m')").run(); } catch { /* ignore */ }
        try { db.prepare("DELETE FROM owner_profile_pause WHERE agent_id IN ('mat-l','mat-m')").run(); } catch { /* ignore */ }
        vis.__setVisibilityRegistryForTesting(null);
        if (prevEnforce === undefined) delete process.env.OWNER_FEATURES_ENFORCE; else process.env.OWNER_FEATURES_ENFORCE = prevEnforce;
        if (prevAllow === undefined) delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS; else process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = prevAllow;
        clearRegistryCaches();
      }
      const restored = await callRoute(router, "/mat/egg/oslo");
      check(restored.handled && restored.body.includes("Egg i Oslo: 3 lokale produsenter"), "owner-hidden: choices cleared → back to 3");
    }

    // ── (f) sitemap ──
    seoMod.__resetSitemapCacheForTesting();
    const xml = seoMod.buildSitemapXml();
    const all = locs(xml);
    check(all.length === new Set(all).size, `sitemap has 0 duplicate <loc> (${all.length - new Set(all).size} dups)`);
    const matLocs = all.filter((l) => l.includes("/mat/")).map((l) => l.replace("https://rettfrabonden.com", "")).sort();
    check(matLocs.includes("/mat/meieri/bergen"), "sitemap lists /mat/meieri/bergen");
    check(matLocs.includes("/mat/egg/oslo"), "sitemap lists /mat/egg/oslo");
    for (const thin of ["/mat/kjott/bergen", "/mat/fisk/bergen", "/mat/honning/bergen"]) {
      check(!matLocs.includes(thin), `sitemap does not list ${thin}`);
    }
    check(!all.some((l) => l.includes("/en/mat/")), "sitemap has no /en/mat/ URL");
    // Route ⇔ sitemap: every listed /mat URL answers 200.
    for (const p of matLocs) {
      const r = await callRoute(router, p);
      check(r.handled && r.status === 200, `sitemap-listed ${p} answers 200 (got ${r.status})`);
    }
    // Bergen producers are also on the Vestland fylke page; the fylke combo follows the same gate.
    check(matLocs.includes("/mat/meieri/vestland") === (await callRoute(router, "/mat/meieri/vestland")).handled,
      "fylke combo: sitemap and route agree");

    // ── (g) wrong host ──
    for (const mod of ["./dental-seo", "./experiences-seo"]) {
      try {
        const other = (require(mod) as any).default;
        const r = await callRoute(other, "/mat/meieri/bergen", { hostname: mod === "./dental-seo" ? "finn-tannlege.com" : "opplevagent.no" });
        check(r.handled && r.status === 404 && !r.body.includes("Fjellost Gard"),
          `${mod} answers /mat/… itself with 404 (handled=${r.handled}, status=${r.status}) — seo.ts is never reached on that host`);
      } catch (e: any) {
        check(false, `${mod}: ${e?.message || e}`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`rfb-mat-landing: unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    if (prevFlag === undefined) delete process.env.RFB_MAT_LANDING_ENABLED;
    else process.env.RFB_MAT_LANDING_ENABLED = prevFlag;
    clearRegistryCaches();
    try { (require("./seo") as any).__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbMatLandingTests({ log: true }).then((r) => {
    console.log(`\nrfb-mat-landing: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
