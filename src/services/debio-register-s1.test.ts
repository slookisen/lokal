/**
 * debio-register-s1.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S1: status from Debio's full
 * register (AC1.1–AC1.6).
 *
 *   normalizer  key spellings (camel/Pascal/snake, nested address, status
 *               arrays/objects, groups), null rows counted.
 *   reject      < 2500 rows → rejected, agents unchanged (last snapshot), state.
 *   match       org_nr, tags org_nr:, finnoko domain, name + postal code,
 *               street + house no. + postal code, street with another postal
 *               code in the same city; support-only signals (farm name in a
 *               company name, farm name as surname, chain, name in the same
 *               city) → review, never verified.
 *   review      GET lists without Debio names, approve sets status, reject
 *               stops the candidate; approved survives the next run.
 *   reset       AC1.4: a row that disappears / expires / turns karens is reset
 *               in the next run and logged; finnoko-only verified reset.
 *   derived     agents.debio_verified = 1 iff okologisk + valid certificate
 *               (status in agent_debio_status).
 *   stale       > 7 days without a successful sync → not shown (read time),
 *               freshness enforcement clears debio_verified + warning.
 *   owner       auto.debio off (admin lock, enforce gate) → never verified.
 *   profile     AC1.5 wording NO/EN/SV, finnoko link, unknown groups, no
 *               «✓ Debio-verifisert» anywhere; karens → no marking.
 *   flag off    scheduler flag default off; the finnoko sync leaves the S1
 *               columns NULL and works as before.
 *   privacy     no Debio person name / street in any table after a sync.
 *
 * In-memory DB on the production schema, injected fake fetch (no network).
 * Exported runDebioRegisterS1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/debio-register-s1.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-10-29T12:00:00.000Z");
const FUTURE = "2027-06-30";
const PAST = "2026-09-30";
// Synthetic, distinctive "person" names and streets — must never be stored.
const PERSON_A = "Zyxwolf Quarnstrom";
const PERSON_B = "Per Kvitlund";
const STREET_SECRET = "Børsumvn. 51";

type Raw = Record<string, unknown>;

function fillerRows(n: number): Raw[] {
  const out: Raw[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: `Fyllvirksomhet ${i}`, clientCode: String(800000000 + i), certSid: 100000 + i, postalCode: "9990", city: "Fyllby", street: `Fyllgata ${i}`, statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] });
  }
  return out;
}

/** The fixture rows, in several plausible raw spellings. */
function fixtureRows(over: { expire?: boolean; dropOrg?: boolean; karensOrg?: boolean } = {}): Raw[] {
  const rows: Raw[] = [
    // a. org.nr. (camelCase, «911 111 111»)
    ...(over.dropOrg ? [] : [{ name: "Orgtun Gard AS", clientCode: "911 111 111", certSid: 5001, postalCode: "1111", city: "Orgby", street: "Orgveien 1", statusCodes: over.karensOrg ? [502] : [509], validFrom: "2026-01-01", validTo: FUTURE, mainProductGroups: [{ code: "LBP" }, { code: "FIO" }] }]),
    // a. tags org_nr: (PascalCase, nested address, status as objects, /Date()/)
    { Name: "Tagtun Gard", ClientCode: "922222222", CertificateSid: "5002", Address: { Street: "Tagveien 2", PostalCode: "2222", City: "Tagby" }, Statuses: [{ Code: 509 }], ValidTo: `/Date(${Date.parse("2027-03-31T00:00:00Z")})/`, ProductGroups: "LBP" },
    // b. finnoko domain (snake_case)
    { name: "Solbakken Frukt", client_code: "933333333", cert_sid: 5003, postal_code: "3333", city: "Fruktby", status_code: "509", valid_to: "30.06.2027", product_groups: ["FIO"] },
    // c. name + postal code
    { name: "Lindheim Gard", clientCode: "944444444", certSid: 5004, postalCode: "7777", city: "Testvik", street: "Lindvegen 4", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // d. street + house no. + postal code — registered on a person's name
    { name: PERSON_A, clientCode: "955555555", certSid: 5005, postalCode: "1433", city: "Åsby", street: STREET_SECRET, statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // d. street + house no., differing postal code, same city
    { name: "Ola Testmann", clientCode: "966666666", certSid: 5006, postalCode: "8416", city: "Sortvik", street: "Øvre Ånstadveien 19", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // support: farm name inside a company name («X Is AS»)
    { name: "Almtun Is AS", clientCode: "977777777", certSid: 5007, postalCode: "6799", city: "Feiby", street: "Sambindingsvegen 22", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["FIO"] },
    // support: farm name as the owner's surname
    { name: PERSON_B, clientCode: "988888888", certSid: 5008, postalCode: "7598", city: "Bangby", street: "Bangveien 263", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // support: chain in the same city
    { name: "Godt Testbrod Fana AS", clientCode: "999999999", certSid: 5009, postalCode: "5999", city: "Bergby", street: "Bakerveien 9", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["FIO"] },
    // expiry (AC1.4)
    { name: "Utlopstun Gard", clientCode: "912121212", certSid: 5010, postalCode: "1212", city: "Utby", statusCodes: [509], validTo: over.expire ? PAST : FUTURE, mainProductGroups: ["LBP"] },
    // karens
    { name: "Karenstun Gard", clientCode: "913131313", certSid: 5011, postalCode: "1313", city: "Karby", statusCodes: [503], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // owner switch off
    { name: "Avtun Gard", clientCode: "914141414", certSid: 5012, postalCode: "1414", city: "Avby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // unknown product group → no «for …»
    { name: "Ukjenttun Gard", clientCode: "915151515", certSid: 5013, postalCode: "1515", city: "Ukby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["XYZ"] },
    // false-positive guards (review fix-up): never a sure match
    // shared address: one register row, two of our producers at «Vulkan 5, 0178»
    { name: "Zqxholding Vulkan AS", clientCode: "916161616", certSid: 5014, postalCode: "0178", city: "Oslo", street: "Vulkan 5", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["FIO"] },
    // gnr/bnr: the neighbour farm «Gnr 12 Bnr 3» in the same postal code
    { name: "Zqx Nabosen", clientCode: "917171717", certSid: 5015, postalCode: "2950", city: "Skammestein", street: "Gnr 12 Bnr 3", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // P.O. box: «Postboks 12, 2601» vs ours «Postboks 12, 2602», same city
    { name: "Zqx Boksesen", clientCode: "918181818", certSid: 5016, postalCode: "2601", city: "Lillehammer", street: "Postboks 12", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // P.O. box written «Pboks»: «Pboks 15, 2305» vs ours «Pboks 15, 2306», same city
    { name: "Zqx Pboksen", clientCode: "918282828", certSid: 5026, postalCode: "2305", city: "Hamar", street: "Pboks 15", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // street_city with two of ours at the same street + no. in the same city
    { name: "Zqx Kaisen", clientCode: "919191919", certSid: 5017, postalCode: "6001", city: "Kaiby", street: "Kaigata 3", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // one entity, name_postal for two of ours
    { name: "Bjørkely Gard", clientCode: "921212121", certSid: 5018, postalCode: "5555", city: "Bjørkby", street: "Bjørkevegen 2", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // one entity, name_postal for one of ours + street_postal for another
    { name: "Eiketun Gard", clientCode: "923232323", certSid: 5019, postalCode: "4444", city: "Eikby", street: "Eikeveien 7", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // uninterpretable rows (counted as rejected)
    { foo: "bar" },
    { name: "Uten id" },
  ];
  return rows;
}

const FINNOKO = [
  { partner_sid: 77, display_name: "Solbakken Frukt", website: "www.solbakkenfrukt.no", contact_mail: null, attachments: [], sales_channels: [] },
];

function fakeFetch(registerRows: Raw[] | "fail", finnoko: unknown[] = FINNOKO): typeof fetch {
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("getcertificates")) {
      if (registerRows === "fail") return new Response("err", { status: 503 });
      if (init?.method !== "POST" || init?.body !== JSON.stringify({ searchText: "" })) return new Response("bad", { status: 400 });
      return new Response(JSON.stringify({ certificates: registerRows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("finnoko.debio.no/api/acm/companies")) return new Response(JSON.stringify(finnoko), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

interface Seed { id: string; name: string; city: string; org_nr?: string; tags?: string[]; website?: string; email?: string; address?: string; postal?: string; about?: string; verified?: number }

const AGENTS: Seed[] = [
  { id: "s1-org", name: "Orgtun Gård", city: "Orgby", org_nr: "911111111" },
  { id: "s1-tag", name: "Tagtun Gård", city: "Annetsted", tags: ["gårdsutsalg", "org_nr:922222222"] },
  { id: "s1-dom", name: "Solbakken Frukt og Bær", city: "Fruktby", website: "https://www.solbakkenfrukt.no/butikk" },
  { id: "s1-name", name: "Lindheim Gård — Testvik", city: "Testvik", postal: "7777" },
  { id: "s1-street", name: "Linnetun Gård", city: "Åsby", address: "Børsumveien 51", postal: "1433", about: `Driftes av Zyxwolf og familien.` },
  { id: "s1-street-city", name: "Marthatun Gård", city: "Sortvik", address: "Øvre Ånstad vei 19", postal: "8400" },
  { id: "s1-farm-company", name: "Almtun — Feiby", city: "Feiby" },
  { id: "s1-surname", name: "Kvitlund Gård", city: "Bangby" },
  { id: "s1-chain", name: "Godt Testbrød Bergby", city: "Bergby" },
  { id: "s1-expire", name: "Utløpstun Gård", city: "Utby", org_nr: "912121212" },
  { id: "s1-karens", name: "Karenstun Gård", city: "Karby", org_nr: "913131313" },
  { id: "s1-off", name: "Avtun Gård", city: "Avby", org_nr: "914141414" },
  { id: "s1-unknown-group", name: "Ukjenttun Gård", city: "Ukby", org_nr: "915151515" },
  { id: "s1-finnoko-only", name: "Gammelverifisert Gård", city: "Gamleby", verified: 1 },
  { id: "s1-place-only", name: "Fyllby Andelslandbruk", city: "Fyllby", postal: "9990" },
  { id: "s1-shared-a", name: "Fiskehandler Vulkan", city: "Oslo", address: "Vulkan 5", postal: "0178" },
  { id: "s1-shared-b", name: "Ostebutikken", city: "Oslo", address: "Vulkan 5, 0178 Oslo", postal: "0178" },
  { id: "s1-gnr", name: "Nabotun Gård", city: "Skammestein", address: "Gnr 12 Bnr 5", postal: "2950" },
  { id: "s1-pobox", name: "Ysteriet Lillehammer", city: "Lillehammer", address: "Postboks 12, 2602 Lillehammer", postal: "2602" },
  { id: "s1-pboks", name: "Hamar Honningbu", city: "Hamar", address: "Pboks 15, 2306 Hamar", postal: "2306" },
  { id: "s1-kai-a", name: "Kaikafeen", city: "Kaiby", address: "Kaigata 3", postal: "6002" },
  { id: "s1-kai-b", name: "Røkeriet på kaia", city: "Kaiby", address: "Kaigata 3", postal: "6003" },
  { id: "s1-bjork-a", name: "Bjørkely Gård", city: "Bjørkby", postal: "5555" },
  { id: "s1-bjork-b", name: "Bjørkely Gårdsutsalg", city: "Bjørkby", postal: "5555" },
  { id: "s1-eik-name", name: "Eiketun Gård", city: "Eikby", postal: "4444" },
  { id: "s1-eik-street", name: "Bakeriet Bryggen", city: "Eikby", address: "Eikeveien 7", postal: "4444" },
];

function seed(db: Database.Database, a: Seed): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, org_nr)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9, 10.7, ?, '["vegetables"]', ?, '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, ?)`,
  ).run(a.id, a.name, "Familiegård med gårdsutsalg.", a.email ?? `post@${a.id}.example.no`, a.website ?? `https://${a.id}.example.no`,
    `key-${a.id}`, a.city, JSON.stringify(a.tags ?? ["gårdsutsalg"]), a.verified ?? 0, a.org_nr ?? null);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, address, postal_code, about, products, specialties, certifications,
        verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, '[{"name":"Gulrøtter","organic":true}]', '[]', '["Økologisk","Nyt Norge"]', 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(a.id, a.email ?? `post@${a.id}.example.no`, a.website ?? `https://${a.id}.example.no`, a.address ?? null, a.postal ?? null,
    a.about ?? "Vi selger grønnsaker fra gården.");
}

export async function runDebioRegisterS1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };
  const assertTrue = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const client = require("./debio-register-client") as typeof import("./debio-register-client");
  const approval = require("./debio-approval") as typeof import("./debio-approval");

  // ── normalizer ────────────────────────────────────────────────────────────
  const n1 = client.normalizeRegisterRow({ Name: "A", ClientCode: "NO 911 111 111 MVA", CertSid: 7, Address: { Street: "X 1", PostalCode: "123", City: "Y" }, StatusCodes: "509,502", ValidTo: "2027-01-31T00:00:00", MainProductGroups: [{ ShortName: "lbp" }, "FIO", "FIO"] });
  assertEq(n1 && { sid: n1.sid, orgNr: n1.orgNr, street: n1.street, postal: n1.postalCode, city: n1.city, codes: n1.statusCodes, status: n1.status, validTo: n1.validTo, groups: n1.productGroups },
    { sid: "7", orgNr: "911111111", street: "X 1", postal: "0123", city: "Y", codes: [509, 502], status: "okologisk", validTo: "2027-01-31", groups: ["LBP", "FIO"] },
    "norm-1: PascalCase + nested address + code string + group objects");
  const n2 = client.normalizeRegisterRow({ company_name: "B", org_nr: "922222222", status: [{ statusCode: "510" }], to_date: "31.12.2026" });
  assertEq(n2 && [n2.status, n2.validTo, n2.sid], ["karens", "2026-12-31", null], "norm-2: snake_case, karens 510, dd.mm.yyyy, no sid");
  const n3 = client.normalizeRegisterRow({ name: "C", sid: 9, productGroups: [{ code: "LBP", statusCode: 501 }] });
  assertEq(n3 && [n3.status, n3.orgNr, n3.statusCodes], ["annet", null, [501]], "norm-3: status code on a product-group object, 501 → annet");
  assertEq(client.normalizeRegisterRow({ name: "D", sid: 1, statusCodes: [5012] })?.status, "annet", "norm-4: 50xx serveringsmerket → annet");
  for (const [raw, label] of [[null, "null"], [[], "array"], ["x", "string"], [{ clientCode: "911111111" }, "no name"], [{ name: "E" }, "no org.nr. and no sid"], [{ name: "F", clientCode: "12" }, "bad org.nr., no sid"]] as Array<[unknown, string]>) {
    assertEq(client.normalizeRegisterRow(raw), null, `norm-null: ${label} → null`);
  }
  const env = client.normalizeRegisterResponse({ Data: [{ name: "G", sid: 1 }, { nope: 1 }] });
  assertEq([env.raw, env.rows.length, env.rejected], [2, 1, 1], "norm-5: envelope {Data:[…]} parsed, rejected rows counted");
  assertEq(client.normalizeRegisterResponse([{ name: "H", sid: 2 }]).rows.length, 1, "norm-6: bare array envelope");

  // ── street / tokens ───────────────────────────────────────────────────────
  const sync = require("./debio-register-sync") as typeof import("./debio-register-sync");
  assertEq(sync.parseStreet("Børsumvn. 51"), sync.parseStreet("Børsumveien 51, 1433 Ås"), "street-1: «Børsumvn.» = «Børsumveien»");
  assertEq(sync.parseStreet("Gunnarsrudsvegen 100"), sync.parseStreet("Gunnarsrudvegen 100"), "street-2: genitive s ignored");
  assertEq(sync.parseStreet("Øvre Ånstad vei 19"), sync.parseStreet("Øvre Ånstadveien 19"), "street-3: «vei» separate = joined «veien»");
  assertEq(sync.parseStreet("Fjordallé 3"), sync.parseStreet("Fjord Alle 3"), "street-4: Allé = alle");
  assertEq(sync.parseStreet("Hillevågsveien 99 B")?.no, "99b", "street-5: house letter kept");
  assertTrue(JSON.stringify(sync.parseStreet("Homme 10")) !== JSON.stringify(sync.parseStreet("Homme 8")), "street-6: another house no. differs");
  for (const a of ["Gnr 12 Bnr 5", "gnr. 12/5", "G.nr 12 B.nr 5, 2950 Skammestein", "Postboks 12", "Postboks 12, 2602 Lillehammer", "Pb. 12", "PB 12", "Boks 3", "P.O. Box 7",
    "Pboks 15", "PBoks 15", "P.boks 15", "P. boks 15", "Pboks. 15", "Pboksnr. 15", "Postboksnr. 15", "Postboks nr. 15", "Postb. 15", "Boksnr 15", "Pboks 15, 2305 Hamar"]) {
    assertEq(sync.parseStreet(a), null, `street-nonstreet: «${a}» is not a street`);
  }
  assertTrue(sync.parseStreet("Boksveien 3") !== null && sync.parseStreet("Gnrudvegen 4") !== null && sync.parseStreet("Pbveien 2") !== null && sync.parseStreet("Boksåsen 8") !== null, "street-7: streets merely starting with boks/gnr still parse");
  assertEq(sync.parseNonStreet("Gnr 12 Bnr 5"), { kind: "gnr", gnr: "12", bnr: "5" }, "nonstreet-1: gnr + bnr pair");
  assertEq(sync.parseNonStreet("gnr. 12/5"), { kind: "gnr", gnr: "12", bnr: "5" }, "nonstreet-2: «gnr. 12/5»");
  assertEq(sync.parseNonStreet("Postboks 12, 2602 Lillehammer"), { kind: "po_box", no: "12" }, "nonstreet-3: P.O. box");
  assertEq(sync.parseNonStreet("Pboks 15, 2305 Hamar"), { kind: "po_box", no: "15" }, "nonstreet-5: «Pboks 15»");
  assertEq(sync.parseNonStreet("Postboksnr. 15"), { kind: "po_box", no: "15" }, "nonstreet-6: «Postboksnr. 15»");
  assertEq(sync.parseNonStreet("P.boks 15"), { kind: "po_box", no: "15" }, "nonstreet-7: «P.boks 15»");
  assertEq(sync.parseNonStreet("Gnr. 14, bnr. 5, 2950 Skammestein"), { kind: "gnr", gnr: "14", bnr: "5" }, "nonstreet-8: bnr after a comma");
  assertEq(sync.parseNonStreet("Gnr. 14, 2950 Skammestein"), { kind: "gnr", gnr: "14", bnr: null }, "nonstreet-9: gnr alone, postal segment is not a bnr");
  assertEq(sync.parseNonStreet("Storgata 5"), null, "nonstreet-4: a street is not a non-street");
  assertEq(sync.coreTokens("Fyllby Andelslandbruk Gård", ["fyllby"]), ["andelslandbruk"], "tokens-1: place and generic words dropped");
  assertEq(sync.tokenOverlap(["bakken"], ["bakken", "ola"]), 0.5, "tokens-2: overlap uses the larger side");
  assertEq(sync.debioRegisterSyncEnabled({}), false, "flag-1: RFB_DEBIO_REGISTER_SYNC default off");
  assertEq(sync.debioRegisterSyncEnabled({ RFB_DEBIO_REGISTER_SYNC: "1" }), true, "flag-2: =1 on");

  // ── approval text ─────────────────────────────────────────────────────────
  assertEq(approval.debioApprovalText("no", '["LBP","FIO"]', "2026-10-29T04:00:00Z"), "Godkjent av Debio for økologisk landbruksproduksjon og foredling, import og omsetning — sjekket 29.10.2026", "text-no");
  assertEq(approval.debioApprovalText("en", ["LBP"], "2026-10-29"), "Approved by Debio for organic agricultural production — checked 29.10.2026", "text-en");
  assertEq(approval.debioApprovalText("sv", ["FIO"], "2026-10-29"), "Godkänd av Debio för förädling, import och handel — kontrollerad 2026-10-29", "text-sv");
  assertEq(approval.debioApprovalText("no", ["XYZ"], "2026-10-29"), "Godkjent av Debio — sjekket 29.10.2026", "text-unknown: no dangling «for —»");

  // ── DB harness ────────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  const prevWarn = console.warn;
  const ENV_KEYS = ["OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "RFB_DEBIO_REGISTER_SYNC"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null; marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0; marketplaceRegistry._statsCacheTime = 0;
  };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    clearRegistryCaches();
    for (const a of AGENTS) seed(db, a);
    // auto.debio off for s1-off: admin lock under the enforce gate.
    process.env.OWNER_FEATURES_ENFORCE = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "rfb:s1-off,rfb:s1-org";
    // The register flow below runs with the flag on; the flag-off section at the
    // end turns it off again.
    process.env.RFB_DEBIO_REGISTER_SYNC = "1";
    db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', 's1-off', 'auto.debio', 'false', 'admin', 1, ?)`).run(NOW.toISOString());

    const row = (id: string) => db.prepare(`SELECT a.id, s.debio_status, a.debio_verified, s.debio_match_method, s.debio_sid, s.debio_cert_valid_to, s.debio_product_groups, s.debio_checked_at
      FROM agents a LEFT JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.id = ?`).get(id) as any;
    const agentsSnapshot = () => JSON.stringify([
      db.prepare("SELECT id, debio_verified, debio_verified_at FROM agents ORDER BY id").all(),
      db.prepare("SELECT * FROM agent_debio_status ORDER BY agent_id").all(),
    ]);
    const FULL = () => [...fillerRows(2500), ...fixtureRows()];

    // ── reject: too few rows ────────────────────────────────────────────────
    const before = agentsSnapshot();
    const low = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(fixtureRows()), dryRun: false, now: NOW, skipCache: true });
    assertEq([low.accepted, low.normalized < 2500], [false, true], "reject-1: < 2500 normalized rows → rejected");
    assertTrue(/too few rows/.test(low.reject_reason ?? ""), "reject-2: reason recorded in the result", low.reject_reason);
    assertEq(agentsSnapshot(), before, "reject-3: agents unchanged (last snapshot kept)");
    assertTrue(/too few rows/.test(approval.readDebioRegisterState(db)?.last_reject_reason ?? ""), "reject-4: reason in debio_register_sync_state");
    const failedFetch = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch("fail"), dryRun: false, now: NOW, skipCache: true });
    assertTrue(!failedFetch.accepted && /HTTP 503/.test(failedFetch.reject_reason ?? ""), "reject-5: HTTP error → rejected", failedFetch.reject_reason);
    assertEq(agentsSnapshot(), before, "reject-6: agents unchanged after a failed fetch");

    // ── dry run writes nothing ──────────────────────────────────────────────
    const dry = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(FULL()), now: NOW, skipCache: true });
    assertEq([dry.dry_run, dry.accepted, dry.rejected_rows], [true, true, 2], "dry-1: default dry run, accepted, 2 rows rejected");
    assertEq(agentsSnapshot(), before, "dry-2: dry run writes nothing to agents");
    assertEq((db.prepare("SELECT COUNT(*) AS n FROM debio_match_review").get() as any).n, 0, "dry-3: dry run writes no review rows");
    assertTrue(dry.would_reset === 1 && dry.review_candidates >= 3, "dry-4: counts would-reset and review candidates", { reset: dry.would_reset, review: dry.review_candidates });

    // ── write run ───────────────────────────────────────────────────────────
    const r1 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(FULL()), dryRun: false, now: NOW, skipCache: true });
    assertEq([r1.accepted, r1.fetched_raw, r1.normalized], [true, 2522, 2520], "run-1: accepted with all rows counted");
    const sure: Array<[string, string]> = [
      ["s1-org", "org_nr"], ["s1-tag", "tag_org_nr"], ["s1-dom", "finnoko_domain"], ["s1-name", "name_postal"],
      ["s1-street", "street_postal"], ["s1-street-city", "street_city"],
    ];
    for (const [id, method] of sure) {
      const r = row(id);
      assertEq([r.debio_status, r.debio_verified, r.debio_match_method], ["okologisk", 1, method], `match-${method}: ${id} okologisk, verified, method ${method}`);
    }
    assertEq(JSON.parse(row("s1-org").debio_product_groups), ["LBP", "FIO"], "match-groups: product groups stored as JSON");
    assertEq([row("s1-org").debio_sid, row("s1-org").debio_cert_valid_to, row("s1-org").debio_checked_at], ["5001", FUTURE, NOW.toISOString()], "match-cols: sid, valid-to, checked_at");
    assertEq(row("s1-tag").debio_cert_valid_to, "2027-03-31", "match-tag: /Date()/ validity parsed");
    for (const id of ["s1-farm-company", "s1-surname", "s1-chain"]) {
      const r = row(id);
      assertEq([r.debio_status, r.debio_verified, r.debio_match_method], ["ingen", 0, null], `support-${id}: support signal only → not verified`);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM debio_match_review WHERE agent_id = ? AND state = 'pending'").get(id) as any).n;
      assertTrue(n >= 1, `support-${id}: candidate in match review`, n);
    }
    const reasons = (id: string) => (db.prepare("SELECT reasons FROM debio_match_review WHERE agent_id = ?").all(id) as any[]).flatMap((r) => JSON.parse(r.reasons));
    assertTrue(reasons("s1-farm-company").includes("farm_name_in_company"), "support-reason-1: farm_name_in_company", reasons("s1-farm-company"));
    assertTrue(reasons("s1-surname").includes("farm_name_as_surname"), "support-reason-2: farm_name_as_surname", reasons("s1-surname"));
    assertTrue(reasons("s1-chain").includes("chain_same_city"), "support-reason-3: chain_same_city", reasons("s1-chain"));
    // ── false-positive guards (review fix-up) ──────────────────────────────
    const pendingReasons = (id: string) => (db.prepare("SELECT reasons FROM debio_match_review WHERE agent_id = ? AND state = 'pending'").all(id) as any[]).flatMap((r) => JSON.parse(r.reasons));
    const guards: Array<[string, string, string]> = [
      ["s1-shared-a", "street_shared_address", "fp-shared: one register row at a shared address"],
      ["s1-shared-b", "street_shared_address", "fp-shared: one register row at a shared address"],
      ["s1-gnr", "gnr_other_bnr", "fp-gnr: «Gnr 12 Bnr 5» vs neighbour «Gnr 12 Bnr 3»"],
      ["s1-pobox", "po_box_same_no", "fp-pobox: «Postboks 12, 2602» vs «Postboks 12, 2601»"],
      ["s1-pboks", "po_box_same_no", "fp-pboks: «Pboks 15, 2306» vs «Pboks 15, 2305»"],
      ["s1-kai-a", "street_shared_address", "fp-unique-b: street_city, two of ours at the same street + no."],
      ["s1-kai-b", "street_shared_address", "fp-unique-b: street_city, two of ours at the same street + no."],
      ["s1-bjork-a", "name_postal_shared_entity", "fp-entity-c: one entity, name_postal for two producers"],
      ["s1-bjork-b", "name_postal_shared_entity", "fp-entity-c: one entity, name_postal for two producers"],
      ["s1-eik-name", "name_postal_shared_entity", "fp-entity-c: one entity, name_postal + street_postal"],
      ["s1-eik-street", "street_postal_shared_entity", "fp-entity-c: one entity, name_postal + street_postal"],
    ];
    for (const [id, reason, label] of guards) {
      const r = row(id);
      assertEq([r.debio_status, r.debio_verified, r.debio_match_method], ["ingen", 0, null], `${label} — ${id} not verified, no okologisk`);
      assertTrue(pendingReasons(id).includes(reason), `${label} — ${id} review row (${reason})`, pendingReasons(id));
    }
    assertEq([row("s1-street").debio_match_method, row("s1-street").debio_verified], ["street_postal", 1], "fp-unique-ok: a street unique among ours stays sure");
    assertEq([row("s1-place-only").debio_status, row("s1-place-only").debio_verified], ["ingen", 0], "place-only: a place name alone never matches");
    assertEq((db.prepare("SELECT COUNT(*) AS n FROM debio_match_review WHERE agent_id = 's1-place-only'").get() as any).n, 0, "place-only: no review candidate either");
    assertEq([row("s1-karens").debio_status, row("s1-karens").debio_verified], ["karens", 0], "derived-1: karens → not verified");
    assertEq([row("s1-off").debio_status, row("s1-off").debio_verified], ["okologisk", 0], "owner-1: auto.debio off → never verified");
    assertEq(r1.owner_switch_off, 1, "owner-2: counted");
    assertEq([row("s1-finnoko-only").debio_status, row("s1-finnoko-only").debio_verified], ["ingen", 0], "reset-1: finnoko-only verified, not in the register → reset");
    const ch = (id: string) => db.prepare("SELECT old_status, new_status, old_verified, new_verified, reason, source FROM debio_status_changes WHERE agent_id = ? ORDER BY id").all(id) as any[];
    assertEq(ch("s1-finnoko-only").map((c) => [c.old_verified, c.new_status, c.new_verified, c.reason]), [[1, "ingen", 0, "not_in_register"]], "reset-2: logged");
    assertEq(ch("s1-place-only").length, 0, "reset-3: never-checked → ingen is not logged as a change");

    // ── review API ──────────────────────────────────────────────────────────
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "s1-admin-key";
    const ADMIN = process.env.ADMIN_KEY;
    try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
    const adminRouter = require("../routes/admin-debio-cross-check").default as any;
    const handler = (path: string, method: "get" | "post") => {
      const l = (adminRouter.stack as any[]).find((x: any) => x.route && x.route.path === path && x.route.methods?.[method]);
      return l.route.stack[l.route.stack.length - 1].handle as Function;
    };
    const call = (h: Function, req: any) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      Promise.resolve(h({ headers: { "x-admin-key": ADMIN }, query: {}, params: {}, body: {}, ...req }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
    });
    const noKey = await call(handler("/match-review", "get"), { headers: {} });
    assertEq(noKey.status, 403, "review-auth: admin key required");
    const list = await call(handler("/match-review", "get"), {});
    assertTrue(list.status === 200 && list.body.count >= 3, "review-1: GET lists pending candidates", list.body?.count);
    const listText = JSON.stringify(list.body);
    assertTrue(!listText.includes(PERSON_B) && !listText.includes("Kvitlund\"") && !listText.includes("Almtun Is"), "review-2: no Debio names in the listing");
    const item = (id: string) => (list.body.items as any[]).find((i) => i.agent.id === id);
    assertTrue(!!item("s1-farm-company")?.debio?.sid && item("s1-farm-company").debio.city === "feiby", "review-3: shows Debio sid + city", item("s1-farm-company"));
    const appr = await call(handler("/match-review/:id", "post"), { params: { id: String(item("s1-farm-company").id) }, body: { action: "approve" } });
    assertEq([appr.status, appr.body.debio_status, appr.body.debio_verified], [200, "okologisk", 1], "review-4: approve sets the candidate's status");
    assertEq([row("s1-farm-company").debio_match_method, row("s1-farm-company").debio_verified], ["review", 1], "review-5: agent row from the approved candidate");
    const rej = await call(handler("/match-review/:id", "post"), { params: { id: String(item("s1-surname").id) }, body: { action: "reject" } });
    assertEq([rej.status, rej.body.state, row("s1-surname").debio_verified], [200, "rejected", 0], "review-6: reject keeps the agent unverified");
    const bad = await call(handler("/match-review/:id", "post"), { params: { id: "999999" }, body: { action: "approve" } });
    assertEq(bad.status, 404, "review-7: unknown id → 404");
    const badAction = await call(handler("/match-review/:id", "post"), { params: { id: "1" }, body: { action: "verify" } });
    assertEq(badAction.status, 400, "review-8: bad action → 400");
    const adminDry = await call(handler("/register-sync", "post"), { body: {} });
    assertTrue(adminDry.status === 200 && adminDry.body.dry_run === true, "admin-1: POST /register-sync defaults to a dry run", adminDry.body?.dry_run);

    // ── second run: AC1.4 reset + approved / rejected survive ──────────────
    const r2rows = [...fillerRows(2500), ...fixtureRows({ expire: true, dropOrg: true })];
    const r2 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(r2rows), dryRun: false, now: new Date(NOW.getTime() + 86_400_000), skipCache: true });
    assertTrue(r2.accepted, "run-2: accepted");
    assertEq([row("s1-org").debio_status, row("s1-org").debio_verified], ["ingen", 0], "reset-4: row disappeared → ingen in the next run");
    assertEq(ch("s1-org").map((c) => [c.old_status, c.new_status, c.reason]), [[null, "okologisk", "register_status"], ["okologisk", "ingen", "not_in_register"]], "reset-5: first match and disappearance logged");
    assertEq([row("s1-expire").debio_status, row("s1-expire").debio_verified], ["ingen", 0], "reset-6: certificate expired → reset");
    assertEq(ch("s1-expire").map((c) => [c.old_status, c.new_status, c.reason]).slice(-1), [["okologisk", "ingen", "expired"]], "reset-7: expiry logged");
    assertEq([row("s1-farm-company").debio_match_method, row("s1-farm-company").debio_verified], ["review", 1], "review-9: approval survives the next run");
    assertEq((db.prepare("SELECT COUNT(*) AS n FROM debio_match_review WHERE agent_id = 's1-surname' AND state = 'pending'").get() as any).n, 0, "review-10: a rejected candidate is not proposed again");
    const r3 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch([...fillerRows(2500), ...fixtureRows({ karensOrg: true })]), dryRun: false, now: new Date(NOW.getTime() + 2 * 86_400_000), skipCache: true });
    assertEq([r3.accepted, row("s1-org").debio_status, row("s1-org").debio_verified], [true, "karens", 0], "reset-8: back, but only karens → karens, not verified");
    const r4 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(FULL()), dryRun: false, now: new Date(NOW.getTime() + 3 * 86_400_000), skipCache: true });
    assertEq([r4.accepted, row("s1-org").debio_status, row("s1-org").debio_verified], [true, "okologisk", 1], "derived-2: okologisk + valid → verified again");
    const SYNC_DAY = new Date(NOW.getTime() + 3 * 86_400_000);

    // ── privacy: no Debio person name / street anywhere ─────────────────────
    const leaks: string[] = [];
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((t) => t.name as string);
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map((c) => c.name as string);
      for (const c of cols) {
        const hit = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE CAST("${c}" AS TEXT) LIKE ? OR CAST("${c}" AS TEXT) LIKE ? OR CAST("${c}" AS TEXT) LIKE ? OR CAST("${c}" AS TEXT) LIKE ?`)
          .get("%Quarnstrom%", "%Per Kvitlund%", "%Børsumvn%", "%Almtun Is%") as any;
        if (hit.n > 0) leaks.push(`${t}.${c}`);
      }
    }
    assertEq(leaks, [], "privacy-1: no Debio person name or street in any table");

    // ── stale: > 7 days ─────────────────────────────────────────────────────
    const getInfo = () => (require("./knowledge-service") as typeof import("./knowledge-service")).knowledgeService.getAgentInfo("s1-org");
    assertEq(getInfo()?.agent.debioVerified, true, "stale-0: fresh → shown");
    const later = new Date(SYNC_DAY.getTime() + 8 * 86_400_000);
    assertEq(approval.debioStatusShown(row("s1-org"), db, { now: later }), false, "stale-1: > 7 days → not shown at read time");
    assertEq(approval.debioStatusShown(row("s1-org"), db, { now: new Date(SYNC_DAY.getTime() + 6 * 86_400_000) }), true, "stale-2: 6 days → still shown");
    const f = sync.enforceDebioRegisterFreshness(db, later);
    assertTrue(f.stale && f.cleared >= 6 && /more than 7 days/.test(f.warning ?? ""), "stale-3: freshness clears debio_verified with a warning", f);
    assertEq(row("s1-org").debio_verified, 0, "stale-4: debio_verified cleared");
    const lowLater = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(fixtureRows()), dryRun: false, now: later, skipCache: true });
    assertTrue(!lowLater.accepted && lowLater.stale && lowLater.warnings.some((w) => /more than 7 days/.test(w)), "stale-5: rejected run reports the stale warning", lowLater.warnings);
    assertEq(sync.enforceDebioRegisterFreshness(db, NOW).cleared, 0, "stale-6: fresh → nothing cleared");

    // ── profile page (AC1.5) ────────────────────────────────────────────────
    await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(FULL()), dryRun: false, now: new Date(), skipCache: true });
    for (const m of ["../routes/seo"]) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
    const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
    const prodLayer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
    const produsent = prodLayer.route.stack[prodLayer.route.stack.length - 1].handle as Function;
    const page = (name: string, lang: string) => new Promise<string>((resolve) => {
      const headers: Record<string, string> = {};
      const res: any = {
        status() { return res; }, json(p: any) { resolve(JSON.stringify(p)); return res; }, send(p: any) { resolve(String(p)); return res; },
        redirect() { resolve(""); return res; }, end() { resolve(""); return res; }, header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      const req: any = {
        method: "GET", url: "/", path: "/", originalUrl: "/", params: { slug: slugify(name) }, query: {}, headers, cookies: {}, ip: "127.0.0.1",
        lang, protocol: "https", hostname: "rettfrabonden.com", get: (h: string) => (h.toLowerCase() === "host" ? "rettfrabonden.com" : undefined),
      };
      Promise.resolve(produsent(req, res, () => resolve(""))).catch((e: any) => resolve(`__error ${e}`));
    });
    const today = new Date().toISOString().slice(0, 10).split("-").reverse().join(".");
    const no = await page("Orgtun Gård", "no");
    assertTrue(no.includes(`Godkjent av Debio for økologisk landbruksproduksjon og foredling, import og omsetning — sjekket ${today}`), "profile-no-1: approval line with groups and date", no.match(/pf-debio[^\n]{0,300}/)?.[0]);
    assertTrue(no.includes(`href="https://finnoko.debio.no/?search=${encodeURIComponent("Orgtun Gård")}"`), "profile-no-2: links to Debio's search");
    assertTrue(no.includes("Debio-godkjent"), "profile-no-3: badge reads «Debio-godkjent»");
    const en = await page("Orgtun Gård", "en");
    assertTrue(en.includes(`Approved by Debio for organic agricultural production and processing, import and trade — checked ${today}`), "profile-en-1: EN wording", en.match(/pf-debio[^\n]{0,300}/)?.[0]);
    const sv = await page("Orgtun Gård", "sv");
    assertTrue(sv.includes("Godkänd av Debio för"), "profile-sv-1: SV wording", sv.match(/pf-debio[^\n]{0,300}/)?.[0]);
    const unknownGroup = await page("Ukjenttun Gård", "no");
    assertTrue(unknownGroup.includes(`Godkjent av Debio — sjekket ${today}`) && !/Godkjent av Debio for\s*—/.test(unknownGroup), "profile-unknown: no dangling «for —»");
    const karens = await page("Karenstun Gård", "no");
    assertTrue(karens.length > 0 && !karens.includes('class="pf-debio"') && !karens.includes('class="badge badge-o"'), "profile-karens: no organic marking");
    const off = await page("Avtun Gård", "no");
    assertTrue(off.length > 0 && !off.includes('class="pf-debio"') && !off.includes('class="badge badge-o"') && !off.includes("Debio-godkjent"), "profile-owner-off: no organic display");
    for (const [label, html] of [["no", no], ["en", en], ["sv", sv], ["karens", karens], ["unknown", unknownGroup]] as Array<[string, string]>) {
      assertTrue(!html.includes("Debio-verifisert") && !html.includes("Ø-merket"), `profile-${label}: never «✓ Debio-verifisert» / Ø-mark`);
    }
    const certs = getInfo()?.knowledge.certifications ?? [];
    assertEq(certs[0], "Debio-godkjent", "certs-1: certifications lead with «Debio-godkjent»");

    // ── flag off: the finnoko sync path is unchanged ────────────────────────
    delete process.env.RFB_DEBIO_REGISTER_SYNC;
    const db2 = new Database(":memory:");
    initMod.__setDbForTesting(db2 as any);
    initMod.__initSchemaForTesting(db2 as any);
    seed(db2, { id: "s1-flagoff", name: "Solbakken Frukt", city: "Fruktby", website: "https://solbakkenfrukt.no" });
    const { syncDebioVerifications } = require("./debio-verification-service") as typeof import("./debio-verification-service");
    const fin = await syncDebioVerifications({ db: db2 as any, fetchImpl: fakeFetch([]), skipCache: true, nowIso: NOW.toISOString() });
    const r0 = db2.prepare("SELECT debio_verified FROM agents WHERE id = 's1-flagoff'").get() as any;
    const s0 = (db2.prepare("SELECT COUNT(*) AS n FROM agent_debio_status").get() as any).n;
    assertEq([fin.matched, r0.debio_verified, s0], [1, 1, 0], "flagoff-1: finnoko sync as before, no S1 status rows");
    assertEq(approval.readDebioRegisterState(db2 as any), null, "flagoff-2: no register state");
    assertEq(sync.enforceDebioRegisterFreshness(db2 as any, later), { stale: false, cleared: 0, warning: null }, "flagoff-3: freshness check is a no-op without a register run");
    const info2 = (require("./knowledge-service") as typeof import("./knowledge-service")).knowledgeService.getAgentInfo("s1-flagoff");
    assertEq(info2?.agent.debioVerified, true, "flagoff-4: finnoko-verified producer still shown");
    // Note 1: with the flag on, the finnoko sync never sets debio_verified for
    // a producer the register owns (row in agent_debio_status).
    seed(db2, { id: "s1-register-owned", name: "Registereid Frukt", city: "Fruktby", website: "https://registereidfrukt.no" });
    db2.prepare("INSERT INTO agent_debio_status (agent_id, debio_status, debio_checked_at) VALUES ('s1-register-owned', 'ingen', ?)").run(NOW.toISOString());
    const FINNOKO_OWNED = [...FINNOKO, { partner_sid: 78, display_name: "Registereid Frukt", website: "registereidfrukt.no", contact_mail: null, attachments: [], sales_channels: [] }];
    const ownedRow = () => db2.prepare("SELECT debio_verified FROM agents WHERE id = 's1-register-owned'").get() as any;
    process.env.RFB_DEBIO_REGISTER_SYNC = "1";
    const fin2 = await syncDebioVerifications({ db: db2 as any, skipCache: true, nowIso: NOW.toISOString(), fetchImpl: fakeFetch([], FINNOKO_OWNED) });
    assertEq([ownedRow().debio_verified, fin2.skipped_register_owned], [0, 1], "finnoko-owned-1: flag on → register-owned agent not verified by the finnoko sync");
    assertEq((db2.prepare("SELECT debio_verified FROM agents WHERE id = 's1-flagoff'").get() as any).debio_verified, 1, "finnoko-owned-2: other agents still verified");
    // Flag off = rollback: finnoko owns every agent again, register rows and a
    // stale register state change nothing.
    delete process.env.RFB_DEBIO_REGISTER_SYNC;
    const fin3 = await syncDebioVerifications({ db: db2 as any, skipCache: true, nowIso: NOW.toISOString(), fetchImpl: fakeFetch([], FINNOKO_OWNED) });
    assertEq([ownedRow().debio_verified, fin3.skipped_register_owned], [1, 0], "rollback-1: flag off → finnoko verifies the register-owned agent as before S1");
    db2.prepare("INSERT OR REPLACE INTO debio_register_sync_state (id, last_success_at) VALUES (1, ?)").run(NOW.toISOString());
    assertEq(sync.enforceDebioRegisterFreshness(db2 as any, later), { stale: false, cleared: 0, warning: null }, "rollback-2: flag off → stale register clears nothing");
    assertEq(ownedRow().debio_verified, 1, "rollback-3: debio_verified kept");
    assertEq(approval.debioStatusShown({ id: "s1-register-owned", debio_verified: 1 }, db2 as any, { now: later }), true, "rollback-4: flag off → S0 rule on read (register row ignored)");
    const info3 = (require("./knowledge-service") as typeof import("./knowledge-service")).knowledgeService.getAgentInfo("s1-register-owned");
    assertEq(info3?.agent.debioVerified, true, "rollback-5: flag off → shown on the public surface");
    process.env.RFB_DEBIO_REGISTER_SYNC = "1";
    assertEq(approval.debioStatusShown({ id: "s1-register-owned", debio_verified: 1 }, db2 as any, { now: later }), false, "flagon-1: flag on → register row «ingen» hides it");
    const fOn = sync.enforceDebioRegisterFreshness(db2 as any, later);
    assertEq([fOn.stale, fOn.cleared, ownedRow().debio_verified], [true, 1, 0], "flagon-2: flag on → stale register clears debio_verified");
    delete process.env.RFB_DEBIO_REGISTER_SYNC;
    try { db2.close(); } catch { /* closed */ }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioRegisterS1Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
