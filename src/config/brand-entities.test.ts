/**
 * brand-entities.test.ts — A2A dev-request
 * 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S1 + G3-S2.
 *
 * config/brand-entities.ts describes each brand (Rett fra Bonden, Opplevagent,
 * Finn-tannlege) and the company (Agentplatform.no AS) once, and
 * organizationJsonLd() in services/company-legal.ts builds the sites'
 * Organization JSON-LD from it.
 *
 * Covers:
 *   (a) the table: exactly rfb, experiences, dental and company, frozen.
 *   (b) names are the ones the sites already print (no rename): RFB equals
 *       verticals/rfb/config.yaml display_name (what the front page used),
 *       and the agentplatform.no service list agrees with the entries.
 *   (c) URLs: https, `url` is a bare origin, logo/docs/privacy/terms live on
 *       the entry's own origin, logos are .png; pages that do not exist yet
 *       are null (dental logo/terms/docs, company terms/docs).
 *   (d) alternateName: each brand carries its bare domain — RFB
 *       «rettfrabonden.com» (FUNN rett-fra-bonden-generisk-frase-forveksling);
 *       no duplicates, nothing equal to the name.
 *   (e) support e-mail: kontakt@<domain> per brand, the company's from
 *       COMPANY_INFO.
 *   (f) sameAs: only the company's Brreg page today; never a hand-written
 *       Wikidata URL; every wikidataId is null or a well-formed Q-ID.
 *   (g) brandSameAs()/wikidataUrl(): a Q-ID becomes one extra sameAs URL
 *       (the one-line follow-up in A2A protocols/wikidata-utkast-2026-10-17.md §9);
 *       the result is a copy.
 *   (h) organizationJsonLd(): the exact RFB node; per brand: PNG logo (none
 *       for dental until F2-S4), alternateName, no empty values, no street
 *       address, no legal name or org.nr. of its own; parentOrganization is
 *       parentOrganizationJsonLd() — the same node for all three — and its
 *       sameAs holds the Brreg URL. The company node has no parent.
 *   (i) agentplatform.no front page: its Organization JSON-LD is the
 *       builder's company node plus the site's own facts; brands from the
 *       entries.
 *   (j) logo files: each served PNG is 512×512 and no two brands share bytes.
 *   (k) G3-S2: no file in opplevagent-connectors-prep/assets/ is the RFB
 *       sprout (md5 e927c311…), and the icon the ChatGPT checklist names is
 *       Opplevagent's own.
 *
 * The rendered rettfrabonden.com / opplevagent.no / finn-tannlege.com front
 * pages are checked through the real routers in
 * src/routes/company-legal-sites.test.ts (T2).
 *
 * Run standalone: npx tsx src/config/brand-entities.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { BRAND_ENTITIES, WIKIDATA_ITEM_BASE, brandSameAs, wikidataUrl, type BrandKey } from "./brand-entities";
import { COMPANY_INFO } from "./company-info";
import { organizationJsonLd, parentOrganizationJsonLd } from "../services/company-legal";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const REPO_ROOT = path.join(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
/** md5 of the RFB sprout icon (rfb-connectors-prep/assets/rfb-square-512.png, mcp-server/icon.png). */
const RFB_SPROUT_MD5 = "e927c3115d56f3c8d863f5bfbd18d2f4";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const md5 = (buf: Buffer): string => createHash("md5").update(buf).digest("hex");

/** Width × height from a PNG's IHDR, or null when the bytes are not a PNG. */
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Every string and array in a JSON value, for the "nothing empty" checks. */
function walkValues(v: unknown, visit: (x: unknown) => void): void {
  visit(v);
  if (Array.isArray(v)) v.forEach((x) => walkValues(x, visit));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => walkValues(x, visit));
}

function hasEmptyValue(v: unknown): boolean {
  let empty = false;
  walkValues(v, (x) => {
    if ((typeof x === "string" && x.trim() === "") || (Array.isArray(x) && x.length === 0) || x === null) empty = true;
  });
  return empty;
}

export function runBrandEntitiesTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const KEYS: BrandKey[] = ["rfb", "experiences", "dental", "company"];
  const BRANDS = ["rfb", "experiences", "dental"] as const;
  const E = BRAND_ENTITIES;
  const hostOf = (url: string): string => new URL(url).host;

  // ── (a) the table ───────────────────────────────────────────────────────
  assertEq(Object.keys(E), KEYS, "a1: one entry per brand (rfb, experiences, dental) and the company, no more");
  assertTrue(Object.isFrozen(E) && KEYS.every((k) => Object.isFrozen(E[k])), "a2: the table and every entry are frozen");
  assertTrue(
    KEYS.every((k) => Object.isFrozen(E[k].alternateName) && Object.isFrozen(E[k].sameAs) && Object.isFrozen(E[k].exampleQueries)),
    "a3: the lists inside each entry are frozen",
  );

  // ── (b) names unchanged ─────────────────────────────────────────────────
  assertEq(
    KEYS.map((k) => E[k].name),
    ["Rett fra Bonden", "Opplevagent", "Finn-tannlege", COMPANY_INFO.displayName],
    "b1: the names the sites already print (no rename)",
  );
  {
    const rfbYaml = yaml.load(fs.readFileSync(path.join(REPO_ROOT, "verticals", "rfb", "config.yaml"), "utf8"), { schema: yaml.JSON_SCHEMA }) as any;
    assertEq(E.rfb.name, rfbYaml?.display_name, "b2: RFB's name equals verticals/rfb/config.yaml display_name (what the front-page Organization printed before)");
  }
  {
    const { SERVICES } = require("../routes/agentplatform-site") as typeof import("../routes/agentplatform-site");
    assertEq(
      SERVICES.map((s) => [s.vertical, s.name, `https://${s.domain}`]),
      SERVICES.map((s) => [s.vertical, E[s.vertical].name, E[s.vertical].url]),
      "b3: the agentplatform.no service cards name the same brands at the same URLs",
    );
  }

  // ── (c) URLs ────────────────────────────────────────────────────────────
  for (const k of KEYS) {
    const e = E[k];
    let origin = "";
    try { origin = new URL(e.url).origin; } catch { /* reported below */ }
    assertTrue(e.url.startsWith("https://") && origin === e.url, `c1 ${k}: url is a bare https origin, no trailing slash (${e.url})`);
    const own = [e.logoPng, e.docsUrl, e.privacyUrl, e.termsUrl].filter((u): u is string => u !== null);
    assertTrue(own.every((u) => u.startsWith(`${e.url}/`) && !/\s/.test(u)), `c2 ${k}: logo, docs, privacy and terms are https pages on ${e.url}`);
    if (e.logoPng !== null) assertTrue(/\.png$/.test(e.logoPng), `c3 ${k}: the logo is a PNG (${e.logoPng})`);
  }
  assertEq(
    [E.rfb.logoPng, E.experiences.logoPng, E.company.logoPng],
    ["https://rettfrabonden.com/logo-512.png", "https://opplevagent.no/favicon-512.png", "https://agentplatform.no/favicon-512.png"],
    "c4: the logos: RFB /logo-512.png, Opplevagent /favicon-512.png, the company /favicon-512.png",
  );
  assertTrue(!KEYS.some((k) => /\.svg$/i.test(E[k].logoPng ?? "")), "c5: no entry uses an SVG as its logo (Opplevagent's Organization used /favicon.svg)");
  assertEq(
    [E.dental.logoPng, E.dental.termsUrl, E.dental.docsUrl, E.company.termsUrl, E.company.docsUrl],
    [null, null, null, null, null],
    "c6: pages that do not exist yet are null, not a guess (dental logo/terms/docs, company terms/docs)",
  );

  // ── (d) alternateName ───────────────────────────────────────────────────
  assertTrue(E.rfb.alternateName.includes("rettfrabonden.com"), "d1: RFB's alternateName holds «rettfrabonden.com» (the phrase alone is generic Norwegian)");
  for (const k of BRANDS) {
    assertEq(E[k].alternateName[0], hostOf(E[k].url), `d2 ${k}: alternateName leads with the bare domain`);
  }
  for (const k of KEYS) {
    const alts = E[k].alternateName;
    assertTrue(
      new Set(alts).size === alts.length && alts.every((a) => a.trim() !== "" && a.toLowerCase() !== E[k].name.toLowerCase()),
      `d3 ${k}: alternateName has no duplicates, no empty entry and nothing equal to the name`,
    );
  }

  // ── (e) support e-mail ──────────────────────────────────────────────────
  for (const k of BRANDS) {
    assertEq(E[k].supportEmail, `kontakt@${hostOf(E[k].url)}`, `e1 ${k}: support e-mail is the site's own kontakt@ address`);
  }
  assertEq(E.company.supportEmail, COMPANY_INFO.email, "e2: the company's e-mail comes from COMPANY_INFO");

  // ── (f) sameAs + wikidataId ─────────────────────────────────────────────
  assertEq(E.company.sameAs, [COMPANY_INFO.brregUrl], "f1: the company's sameAs is its Brreg page (from COMPANY_INFO)");
  assertTrue(BRANDS.every((k) => E[k].sameAs.length === 0), "f2: the brands list no sameAs until Daniel supplies real profiles");
  for (const k of KEYS) {
    const s = E[k].sameAs;
    assertTrue(s.every((u) => /^https:\/\/[^\s/]+\/\S*$/.test(u)) && new Set(s).size === s.length, `f3 ${k}: sameAs is https URLs without duplicates`);
    assertTrue(!s.some((u) => u.includes("wikidata.org")), `f4 ${k}: no hand-written Wikidata URL (it is derived from wikidataId)`);
    const q = E[k].wikidataId;
    assertTrue(q === null || /^Q[1-9]\d*$/.test(q), `f5 ${k}: wikidataId is null or a well-formed Q-ID (${q})`);
  }
  assertTrue(KEYS.every((k) => E[k].wikidataId === null), "f6: no Wikidata item is configured today (nothing is published)");
  assertTrue(KEYS.every((k) => E[k].exampleQueries.every((q) => q.trim() !== "")), "f7: no empty example query");
  assertTrue(BRANDS.every((k) => E[k].exampleQueries.length >= 3) && E.company.exampleQueries.length === 0, "f8: three example queries per brand; the company has no connector of its own");

  // ── (g) brandSameAs() / wikidataUrl() ───────────────────────────────────
  assertEq(WIKIDATA_ITEM_BASE, "https://www.wikidata.org/wiki/", "g1: Wikidata item URLs are https://www.wikidata.org/wiki/<Q-ID>");
  assertEq(wikidataUrl("Q42"), "https://www.wikidata.org/wiki/Q42", "g2: wikidataUrl(Q42)");
  assertEq(brandSameAs({ sameAs: [COMPANY_INFO.brregUrl], wikidataId: "Q42" }), [COMPANY_INFO.brregUrl, "https://www.wikidata.org/wiki/Q42"],
    "g3: setting a Q-ID adds exactly one sameAs URL after the configured ones");
  assertEq(brandSameAs({ sameAs: [], wikidataId: "Q7" }), ["https://www.wikidata.org/wiki/Q7"], "g4: a brand with no profiles gets the Wikidata item alone");
  assertEq(brandSameAs({ sameAs: [], wikidataId: null }), [], "g5: no Q-ID, no profiles → empty");
  {
    const out = brandSameAs(E.company);
    out.push("https://example.invalid/");
    assertEq(E.company.sameAs, [COMPANY_INFO.brregUrl], "g6: brandSameAs() returns a copy; the config is untouched");
  }

  // ── (h) organizationJsonLd() ────────────────────────────────────────────
  const parent = parentOrganizationJsonLd();
  const expectedParent = {
    "@type": "Organization",
    "@id": "https://agentplatform.no/#organization",
    name: COMPANY_INFO.displayName,
    legalName: COMPANY_INFO.legalName,
    url: "https://agentplatform.no",
    identifier: { "@type": "PropertyValue", propertyID: "Organisasjonsnummer", value: COMPANY_INFO.orgNr },
    sameAs: [COMPANY_INFO.brregUrl],
  };
  assertEq(parent, expectedParent, "h1: parentOrganizationJsonLd() is the company with sameAs: [Brreg URL]");
  assertEq(organizationJsonLd("rfb"), {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://rettfrabonden.com/#organization",
    name: "Rett fra Bonden",
    alternateName: ["rettfrabonden.com"],
    url: "https://rettfrabonden.com",
    logo: "https://rettfrabonden.com/logo-512.png",
    parentOrganization: expectedParent,
  }, "h2: the exact RFB Organization");
  for (const k of BRANDS) {
    const org = organizationJsonLd(k);
    const e = E[k];
    assertTrue(org["@type"] === "Organization" && org.name === e.name && org.url === e.url && org["@id"] === `${e.url}/#organization`, `h3 ${k}: Organization with the brand's name, url and @id`);
    assertEq(org.alternateName, e.alternateName, `h4 ${k}: alternateName from the entry`);
    if (e.logoPng) assertTrue(org.logo === e.logoPng && /\.png$/.test(String(org.logo)), `h5 ${k}: logo is the entry's PNG`);
    else assertTrue(!("logo" in org), `h5 ${k}: no logo key while the entry has no PNG (dental until F2-S4)`);
    assertEq(org.parentOrganization, parent, `h6 ${k}: parentOrganization is parentOrganizationJsonLd()`);
    assertTrue(Array.isArray((org.parentOrganization as any)?.sameAs) && (org.parentOrganization as any).sameAs.includes(COMPANY_INFO.brregUrl), `h7 ${k}: parentOrganization.sameAs holds the Brreg URL`);
    assertTrue(!("legalName" in org) && !("identifier" in org), `h8 ${k}: the brand does not claim the company's legal name or org.nr.`);
    assertTrue(!("sameAs" in org), `h9 ${k}: no empty sameAs on the brand while it has no profiles`);
    assertTrue(!hasEmptyValue(org), `h10 ${k}: no empty string, empty array or null anywhere`);
    assertTrue(!JSON.stringify(org).includes(COMPANY_INFO.address.street), `h11 ${k}: no street address`);
  }
  assertTrue(
    new Set(BRANDS.map((k) => JSON.stringify(organizationJsonLd(k).parentOrganization))).size === 1,
    "h12: parentOrganization is the same node on all three brands",
  );
  {
    const co = organizationJsonLd("company");
    assertEq(co, {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://agentplatform.no/#organization",
      name: COMPANY_INFO.displayName,
      alternateName: ["Agentplatform.no"],
      url: "https://agentplatform.no",
      logo: "https://agentplatform.no/favicon-512.png",
      sameAs: [COMPANY_INFO.brregUrl],
      legalName: COMPANY_INFO.legalName,
      identifier: expectedParent.identifier,
    }, "h13: the exact company Organization (legal name, org.nr., Brreg sameAs; no parent)");
    assertEq(co["@id"], parent["@id"], "h14: the company node and the brands' parentOrganization share one @id");
  }
  {
    // Callers extend the node (experiences-seo.ts adds a description); a
    // change to one returned node must never reach the config or the next call.
    const a = organizationJsonLd("rfb") as any;
    let threw = false;
    try {
      a.alternateName.push("x");
      a.parentOrganization.sameAs.push("https://example.invalid/");
      a.name = "changed";
    } catch { threw = true; }
    assertTrue(!threw, "h15: the returned node is the caller's own copy (lists are not the frozen config arrays)");
    assertEq(organizationJsonLd("rfb").alternateName, ["rettfrabonden.com"], "h16: … and changing it leaves the next call untouched");
    assertEq(parentOrganizationJsonLd().sameAs, [COMPANY_INFO.brregUrl], "h17: … and the company's sameAs untouched");
  }

  // ── (i) agentplatform.no front page ─────────────────────────────────────
  {
    const ap = require("../routes/agentplatform-site") as typeof import("../routes/agentplatform-site");
    const built = organizationJsonLd("company");
    for (const lang of ["nb", "en"] as const) {
      const html = ap.renderHome(lang, { rfb: 1809, experiences: 712, dental: 5446 });
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      let ld: any = null;
      try { ld = m ? JSON.parse(m[1]) : null; } catch { ld = null; }
      assertTrue(!!ld && Object.entries(built).every(([key, val]) => JSON.stringify(ld[key]) === JSON.stringify(val)), `i1 ${lang}: agentplatform.no's Organization carries every field of organizationJsonLd("company")`);
      assertTrue(!!ld && !("parentOrganization" in ld), `i2 ${lang}: the company has no parentOrganization`);
      assertEq(ld?.brand, (["rfb", "experiences", "dental"] as const).map((k) => ({ "@type": "Brand", name: E[k].name, url: E[k].url })), `i3 ${lang}: the three brands from the brand entries`);
      assertTrue(!!ld && ld.email === COMPANY_INFO.email && ld.foundingDate === COMPANY_INFO.foundedDate && !!ld.description && ld.address?.addressLocality === COMPANY_INFO.address.city && !("streetAddress" in (ld.address || {})), `i4 ${lang}: the site's own facts are kept (e-mail, founding date, description, city, no street)`);
    }
  }

  // ── (j) logo files ──────────────────────────────────────────────────────
  // The file behind each logo URL: RFB via express.static, Opplevagent via
  // experiences-seo.ts GET /favicon-512.png, the company via
  // agentplatform-site.ts GET /favicon-512.png (their route tests check 200 image/png).
  {
    const files: Array<[BrandKey, string]> = [
      ["rfb", "logo-512.png"],
      ["experiences", "opplevagent-favicon-512.png"],
      ["company", "agentplatform-icon-512.png"],
    ];
    const hashes: string[] = [];
    for (const [k, f] of files) {
      const p = path.join(PUBLIC_DIR, f);
      const buf = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
      const size = pngSize(buf);
      assertTrue(!!size && size.w === 512 && size.h === 512, `j1 ${k}: src/public/${f} is a 512×512 PNG (got ${size ? `${size.w}×${size.h}` : "not a PNG"})`);
      hashes.push(md5(buf));
    }
    assertTrue(new Set(hashes).size === hashes.length, "j2: no two entries share a logo file (each brand shows its own mark)");
    assertTrue(hashes[1] !== RFB_SPROUT_MD5 && hashes[2] !== RFB_SPROUT_MD5, "j3: neither Opplevagent's nor the company's logo is the RFB sprout icon");
  }

  // ── (k) G3-S2: the mislabelled Opplevagent connector icon ───────────────
  {
    const rfbIcon = path.join(REPO_ROOT, "rfb-connectors-prep", "assets", "rfb-square-512.png");
    assertEq(fs.existsSync(rfbIcon) ? md5(fs.readFileSync(rfbIcon)) : null, RFB_SPROUT_MD5, "k0 control: the md5 the scan looks for is the RFB connector icon's (not a vacuous scan)");
    const dir = path.join(REPO_ROOT, "opplevagent-connectors-prep", "assets");
    const names = fs.readdirSync(dir);
    assertTrue(names.length > 0, "k1 control: opplevagent-connectors-prep/assets/ is read");
    const sprout = names.filter((n) => md5(fs.readFileSync(path.join(dir, n))) === RFB_SPROUT_MD5);
    assertEq(sprout, [], `k2: no file in opplevagent-connectors-prep/assets/ has md5 ${RFB_SPROUT_MD5} (the RFB sprout)`);
    assertTrue(!names.includes("opplevagent-square-green-512.png"), "k3: opplevagent-square-green-512.png is gone");
    const brandIcon = path.join(dir, "opplevagent-brand-512.png");
    const buf = fs.existsSync(brandIcon) ? fs.readFileSync(brandIcon) : Buffer.alloc(0);
    const size = pngSize(buf);
    assertTrue(!!size && size.w === 512 && size.h === 512 && md5(buf) !== RFB_SPROUT_MD5, "k4: opplevagent-brand-512.png (the icon the ChatGPT checklist names) is a 512×512 PNG and not the sprout");
    const readme = fs.readFileSync(path.join(REPO_ROOT, "opplevagent-connectors-prep", "chatgpt-app", "README.md"), "utf8");
    assertTrue(readme.includes("../assets/opplevagent-brand-512.png") && /green one was\s+byte-identical to the RFB icon and was removed/.test(readme), "k5: the ChatGPT checklist names the brand icon and records the removal");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── brand-entities: one brand entity in config + the shared Organization builder (dev-request 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S1/G3-S2) ──");
  const r = runBrandEntitiesTests({ log: true });
  console.log(`\nbrand-entities: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  // agentplatform-site's imports may start background timers; exit explicitly.
  process.exit(0);
}
