/**
 * hidden-row-n1.test.ts — katalog skive 6 (N1 from #1427): a catalog_hidden
 * row shows no contact information in any public answer, also not through
 * externalLinks, images or contact text inside `about`.
 *
 * Katalog skive 7 (N1–N3 from #1472): the same redaction also covers
 * description, specialties, paymentMethods, deliveryOptions and free-text
 * opening hours; e-mail and bare domains in any case; phone numbers with
 * hyphens or dots between groups; and the e-mail pattern stays linear on
 * long text without "@".
 *
 * Exported runHiddenRowN1Tests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/hidden-row-n1.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "./geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HIDDEN = "4d000000-0000-4000-8000-000000000001";
const VISIBLE = "4d000000-0000-4000-8000-000000000002";
const LINK = "https://facebook.com/skjult-gard-n1";
const IMAGE = "https://bilder.example.no/skjult-n1.jpg";
const ABOUT_RAW =
  "Vi dyrker poteter. Ring 98 76 54 32 eller +47 912 34 567, skriv til skjult@privat-n1.example.no, se www.skjult-n1.no og https://skjult-n1.example.com/butikk. Potet 30 kr/kg, 2.5 kg pose.";
const SECRETS = ["98 76 54 32", "912 34 567", "skjult@privat-n1.example.no", "skjult-n1.no", "skjult-n1.example.com", LINK, IMAGE, "facebook.com", "skjult-gard-n1", "bilder.example.no"];

// Slice 7: contact text in the other free-text fields.
const HIDDEN_FT = "4d000000-0000-4000-8000-000000000003";
const VISIBLE_FT = "4d000000-0000-4000-8000-000000000004";
const FT_DESCRIPTION = "Gard ved 0150 Oslo. Skriv beskr@fri-n3.example.no eller ring 912-34-567.";
const FT_SPECIALTIES = ["Ost — se OST-N3.NO", "Bestill på 91.23.45.67", "Eple 30 kr/kg"];
const FT_PAYMENT = ["Vipps 412.34.567", "Faktura: Post@Faktura-N3.No"];
const FT_DELIVERY = ["Henting, avtal på https://levering-n3.example.com/avtale", "Ring +47 934 56 789"];
const FT_HOURS = "Lør 10–14 fra 01.05.2026, ellers ring 0047 95-67-89-01";
const FT_SECRETS = ["beskr@fri-n3.example.no", "912-34-567", "OST-N3.NO", "91.23.45.67", "412.34.567", "Post@Faktura-N3.No",
  "Faktura-N3", "levering-n3.example.com", "934 56 789", "95-67-89-01"];

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at, origin, catalog_hidden)
    VALUES (?, ?, ?, 'test', 'x@y.example', 'https://x.example', '1.0.0', 'producer', ?,
            59.91, 10.75, 'Oslo', '["vegetables"]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?, ?)
  `);
  const rows: Array<[string, string, string, number]> = [
    [HIDDEN, "Skjult N1 Gard", "test_fixture", 1],
    [VISIBLE, "Synlig N1 Gard", "discovery", 0],
  ];
  for (const [id, name, origin, hidden] of rows) {
    agentStmt.run(id, name, `Beskrivelse av ${name}`, `key-${id}`, origin, hidden);
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, address, postal_code, phone, email, website, about, products, opening_hours, external_links, images, verification_status)
      VALUES (?, 'Veien 1', '1234', '98765432', 'a@b.example.no', 'https://a.example.no', ?, ?, ?, ?, ?, 'verified')
    `).run(id, ABOUT_RAW,
      JSON.stringify([{ name: "Testpoteter", category: "vegetables" }]),
      JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }]),
      JSON.stringify([{ type: "facebook", url: LINK }]),
      JSON.stringify([IMAGE]));
  }
  const ftRows: Array<[string, string, string, number]> = [
    [HIDDEN_FT, "Skjult N3 Gard", "test_fixture", 1],
    [VISIBLE_FT, "Synlig N3 Gard", "discovery", 0],
  ];
  for (const [id, name, origin, hidden] of ftRows) {
    agentStmt.run(id, name, FT_DESCRIPTION, `key-${id}`, origin, hidden);
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, about, products, opening_hours, specialties, payment_methods, delivery_options, verification_status)
      VALUES (?, 'Vi selger ost og eple.', ?, ?, ?, ?, ?, 'verified')
    `).run(id,
      JSON.stringify([{ name: "Gardsost", category: "dairy" }]),
      JSON.stringify(FT_HOURS),
      JSON.stringify(FT_SPECIALTIES),
      JSON.stringify(FT_PAYMENT),
      JSON.stringify(FT_DELIVERY));
  }
}

export async function runHiddenRowN1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  const leaks = (text: string): string[] => SECRETS.filter((s) => text.includes(s));

  const visibility = require("./agent-visibility") as typeof import("./agent-visibility");
  const { redactContactText, withoutContactFields, redactKnowledgeFreeText } = visibility;
  const ftLeaks = (text: string): string[] => FT_SECRETS.filter((x) => text.includes(x));
  const M = "[kontaktinfo fjernet]";

  // ── redactContactText: positive cases ──
  const pos: Array<[string, string, string]> = [
    ["e-mail", "Mail post@gard.example.no nå", `Mail ${M} nå`],
    ["e-mail with plus", "a.b+c@sub.gard.no.", `${M}.`],
    ["https url", "Se https://gard.example.com/butikk?x=1 for mer", `Se ${M} for mer`],
    ["http url", "http://gard.no", M],
    ["www url", "Besøk www.gard.no.", `Besøk ${M}.`],
    ["bare .no domain", "Se gard.no for mer", `Se ${M} for mer`],
    ["bare .com domain", "Nettside: gard.com", `Nettside: ${M}`],
    ["bare domain with path", "gard.no/butikk", M],
    ["phone plain", "Ring 98765432 i dag", `Ring ${M} i dag`],
    ["phone 3-2-3", "Ring 987 65 432", `Ring ${M}`],
    ["phone 2-2-2-2", "Ring 98 76 54 32.", `Ring ${M}.`],
    ["phone +47", "Tlf +47 98765432", `Tlf ${M}`],
    ["phone +47 grouped", "Tlf +47 98 76 54 32", `Tlf ${M}`],
    ["phone 0047", "Tlf 0047 98765432", `Tlf ${M}`],
    ["phone 47 prefix", "Tlf 47 98765432", `Tlf ${M}`],
    ["phone +4798765432", "Tlf +4798765432", `Tlf ${M}`],
  ];
  for (const [label, input, expected] of pos) assertEq(redactContactText(input), expected, `redact-pos: ${label}`);

  // ── negative cases: unchanged ──
  const neg = [
    "Poteter 30 kr/kg", "Pris kr 800", "Pris 1 200 kr", "Siden 2026 og 1999", "En pose på 2.5 kg", "Vekt 0.75 kg og 3,5 dl",
    "Vi åpner i mai. Kom gjerne.", "Hei.Takk for sist.", "Postnummer 1234 Oslo", "Egg.", "Se punkt 3.2 og 4.1.5", "Åpent 10:00-14:00",
    "Ordre 12 345 kr", "Kl. 10 til 14 hver dag.", "",
  ];
  for (const t of neg) assertEq(redactContactText(t), t, `redact-neg: ${JSON.stringify(t)} unchanged`);
  assertEq(redactContactText(undefined as any), undefined, "redact-neg: non-string passes through");

  // ── Slice 7 (N3): case-insensitive e-mail / domains, dotted and hyphenated phones ──
  const posN3: Array<[string, string, string]> = [
    ["upper-case domain", "Se GARD.NO i dag", `Se ${M} i dag`],
    ["mixed-case domain", "Se Gard.Com.", `Se ${M}.`],
    ["mixed-case e-mail", "Skriv Post@Gard.No nå", `Skriv ${M} nå`],
    ["upper-case e-mail", "POST@GARD.NO", M],
    ["upper-case www", "WWW.GARD.NO", M],
    ["phone 3-2-3 hyphens", "Ring 912-34-567", `Ring ${M}`],
    ["phone 2-2-2-2 dots", "Ring 91.23.45.67.", `Ring ${M}.`],
    ["phone 3-2-3 dots", "Ring 912.34.567 i dag", `Ring ${M} i dag`],
    ["phone 2-2-2-2 hyphens", "Ring 91-23-45-67", `Ring ${M}`],
    ["phone +47 hyphens", "Tlf +47 912-34-567", `Tlf ${M}`],
    ["phone +47- dots", "Tlf +47-91.23.45.67", `Tlf ${M}`],
    ["phone 0047 dots", "Tlf 0047 912.34.567", `Tlf ${M}`],
  ];
  for (const [label, input, expected] of posN3) assertEq(redactContactText(input), expected, `redact-n3-pos: ${label}`);
  const negN3 = [
    "Dato 01.05.2026", "Fra 01.05.2026 til 30.09.2026", "Åpent 10.00-14.00", "Åpent 10.00–14.00", "Postnummer 0150 Oslo",
    "Vekt 12.5 kg", "Pris 12.50 kr", "Pris kr 1.250,-", "Pris 1.250.000 kr", "Siden 2019-2026", "Kl. 10.00.", "Uke 12-34",
    "Dato 2026-05-01", "Tlf 12.34.567", "Ost 30 kr/kg, 2.5 kg", "Hei.Takk for sist.", "Egg.Neste uke",
    "Nummer 912-34.567", "Nummer 91.23-45.67", "Nummer 912.34.5678", "Nummer 1.912.34.567",
  ];
  for (const t of negN3) assertEq(redactContactText(t), t, `redact-n3-neg: ${JSON.stringify(t)} unchanged`);

  // ── Slice 7 (N2): the e-mail pattern is linear on long text without "@" ──
  {
    const long = "abcdefghij.".repeat(10_000).slice(0, 100_000).replace(/\./g, "x");
    const t0 = Date.now();
    const out = redactContactText(long);
    const ms = Date.now() - t0;
    assertTrue(out === long && ms < 200, `perf-1: 100k chars without "@" redacted in ${ms} ms (< 200 ms)`);
    const words = "ost og eple fra gard ".repeat(5_000);
    const t1 = Date.now();
    redactContactText(words);
    const ms1 = Date.now() - t1;
    assertTrue(ms1 < 200, `perf-2: ${words.length} chars of prose redacted in ${ms1} ms (< 200 ms)`);
  }

  // ── Slice 7 (N1): redactKnowledgeFreeText ──
  {
    const r: any = redactKnowledgeFreeText({
      description: "Ring 912-34-567", specialties: ["se GARD.NO", 7], paymentMethods: ["Vipps 91.23.45.67"],
      deliveryOptions: ["post@gard.no"], openingHours: [{ day: "sat", open: "10:00", close: "14:00", note: "ring 98765432" }, "Søn: www.gard.no"],
      about: "Ring 98765432", products: [{ name: "Ost 98765432" }], certifications: ["Debio"], deliveryRadius: 12,
    });
    assertEq(r.description, `Ring ${M}`, "rkf-1: description redacted");
    assertEq(r.specialties, [`se ${M}`, 7], "rkf-2: string entries redacted, other entries untouched");
    assertEq([r.paymentMethods, r.deliveryOptions], [[`Vipps ${M}`], [M]], "rkf-3: payment and delivery redacted");
    assertEq(r.openingHours, [{ day: "sat", open: "10:00", close: "14:00", note: `ring ${M}` }, `Søn: ${M}`], "rkf-4: opening-hours note and text entries redacted, times kept");
    assertEq([r.about, r.products, r.certifications, r.deliveryRadius], ["Ring 98765432", [{ name: "Ost 98765432" }], ["Debio"], 12], "rkf-5: fields outside the list untouched");
    assertEq(redactKnowledgeFreeText({ openingHours: "Lør 10–14, tlf 912 34 567" }), { openingHours: `Lør 10–14, tlf ${M}` }, "rkf-6: free-text opening hours redacted");
    assertEq(redactKnowledgeFreeText({ x: 1 }), { x: 1 }, "rkf-7: absent fields are not added");
    assertEq(redactKnowledgeFreeText(null), null, "rkf-8: non-object returned as is");
    const w: any = withoutContactFields({ description: "post@gard.no", specialties: ["912-34-567"] });
    assertEq([w.description, w.specialties], [M, [M]], "rkf-9: withoutContactFields redacts the free-text fields too");
  }

  // ── withoutContactFields ──
  {
    const r: any = withoutContactFields({ address: "a", postalCode: "p", phone: "1", email: "e", website: "w", about: `Ring 98765432 ok`, externalLinks: [{ url: LINK }], images: [IMAGE], products: [1] });
    assertEq([r.address, r.postalCode, r.phone, r.email, r.website], [undefined, undefined, undefined, undefined, undefined], "wcf-1: contact fields removed");
    assertEq([r.externalLinks, r.images, r.about, r.products], [[], [], `Ring ${M} ok`, [1]], "wcf-2: links and images emptied, about redacted, rest kept");
    assertEq(withoutContactFields({ x: 1 }), { x: 1, externalLinks: [], images: [] }, "wcf-3: arrays are empty arrays, never missing");
    assertEq(withoutContactFields(null), null, "wcf-4: non-object returned as is");
  }

  // ── Public surfaces ──
  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seed(db);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();

  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  const prevByIdFlag = process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;
  delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;

  try {
    const mcp = require("../routes/mcp") as typeof import("../routes/mcp");
    const tools = new Map<string, (args: any) => Promise<any>>();
    const resources = new Map<string, (uri: URL) => Promise<any>>();
    mcp.registerTools({
      registerTool(name: string, _c: any, handler: any) { tools.set(name, handler); },
      resource(name: string, _u: any, _m: any, handler: any) { resources.set(name, handler); },
      prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const infoText = async (id: string) => String((await tools.get("lokal_info")!({ agentId: id }))?.content?.[0]?.text ?? "");
    const readRes = async (id: string) => String((await resources.get("producer-detail")!(new URL(`lokal://producers/${id}`)))?.contents?.[0]?.text ?? "");

    // lokal_info
    {
      const h = await infoText(HIDDEN);
      assertTrue(h.startsWith("# Skjult N1 Gard") && h.includes("Vi dyrker poteter"), "info-1: hidden row still described (about kept)");
      assertEq(leaks(h), [], "info-2: lokal_info of the hidden row carries no link, image, e-mail, phone or URL");
      assertTrue(h.includes(M) && h.includes("30 kr/kg") && h.includes("2.5 kg"), "info-3: marker in place, price and kg amount kept");
      const v = await infoText(VISIBLE);
      assertTrue(v.includes("98 76 54 32") && v.includes("skjult@privat-n1.example.no") && v.includes("www.skjult-n1.no") && !v.includes(M),
        "info-4: visible row's about is unchanged (no redaction)");
    }
    // MCP resource
    {
      const h = await readRes(HIDDEN);
      assertEq(leaks(h), [], "res-1: resource of the hidden row carries none of the secrets");
      const hj = JSON.parse(h);
      assertEq([hj.knowledge?.externalLinks, hj.knowledge?.images], [[], []], "res-2: externalLinks and images are empty arrays");
      assertTrue(typeof hj.knowledge?.about === "string" && hj.knowledge.about.includes(M) && hj.knowledge.about.includes("30 kr/kg"), "res-3: about redacted, price kept");
      assertEq(hj.knowledge?.products?.[0]?.name, "Testpoteter", "res-4: products still shown");
      const vj = JSON.parse(await readRes(VISIBLE));
      assertEq([vj.knowledge?.images?.[0], vj.knowledge?.about], [IMAGE, ABOUT_RAW], "res-5: visible row's image and about unchanged");
    }
    // A2A agent/info
    {
      const a2aRouter = require("../routes/a2a").default as any;
      const layer = (a2aRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/a2a" && l.route.methods?.post);
      const handle = layer.route.stack[layer.route.stack.length - 1].handle;
      const call = (agentId: string) => new Promise<any>((resolve) => {
        const req: any = { method: "POST", url: "/a2a", path: "/a2a", originalUrl: "/a2a", headers: { "user-agent": "test-agent/1.0" },
          body: { jsonrpc: "2.0", method: "agent/info", params: { agentId }, id: 1 }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined };
        const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, setHeader() { return this; },
          header() { return this; }, set() { return this; }, json(b: any) { this.headersSent = true; resolve(b); return this; } };
        handle(req, res);
      });
      const hText = JSON.stringify(await call(HIDDEN));
      assertEq(leaks(hText), [], "a2a-1: A2A agent/info of the hidden row carries none of the secrets");
      assertTrue(hText.includes("Testpoteter") && hText.includes(M), "a2a-2: profile and products kept, marker in about");
      const vText = JSON.stringify(await call(VISIBLE));
      assertTrue(vText.includes(IMAGE) && vText.includes("98 76 54 32"), "a2a-3: visible row's image and about unchanged");
    }

    // ── Slice 7 (N1): contact text in the other free-text fields, three surfaces ──
    {
      const h = await infoText(HIDDEN_FT);
      assertEq(ftLeaks(h), [], "ft-info-1: lokal_info of the hidden row carries no contact text from specialties, payment, delivery or opening hours");
      assertTrue(h.includes("## Spesialiteter") && h.includes("Eple 30 kr/kg") && h.includes("01.05.2026") && h.includes(M),
        "ft-info-2: sections kept, price and date kept, marker in place");
      const v = await infoText(VISIBLE_FT);
      assertTrue(v.includes("OST-N3.NO") && v.includes("91.23.45.67") && v.includes("412.34.567") && v.includes("Post@Faktura-N3.No")
        && v.includes("levering-n3.example.com") && v.includes("934 56 789") && v.includes("95-67-89-01") && !v.includes(M),
        "ft-info-3: visible row's free-text fields unchanged");
    }
    {
      const h = await readRes(HIDDEN_FT);
      assertEq(ftLeaks(h), [], "ft-res-1: resource of the hidden row carries no contact text in any free-text field");
      const hk = JSON.parse(h).knowledge;
      assertTrue(typeof hk?.description === "string" && hk.description.includes("0150 Oslo") && hk.description.includes(M), "ft-res-2: description redacted, postal code kept");
      assertEq(hk?.specialties?.[2], "Eple 30 kr/kg", "ft-res-3: harmless specialty unchanged");
      assertTrue(typeof hk?.openingHours === "string" && hk.openingHours.includes("01.05.2026") && hk.openingHours.includes(M), "ft-res-4: free-text opening hours redacted, date kept");
      assertEq(hk?.products?.[0]?.name, "Gardsost", "ft-res-5: products unchanged");
      const vk = JSON.parse(await readRes(VISIBLE_FT)).knowledge;
      assertEq([vk?.description, vk?.specialties, vk?.paymentMethods, vk?.deliveryOptions, vk?.openingHours],
        [FT_DESCRIPTION, FT_SPECIALTIES, FT_PAYMENT, FT_DELIVERY, FT_HOURS], "ft-res-6: visible row's free-text fields byte-identical");
    }
    {
      const a2aRouter = require("../routes/a2a").default as any;
      const layer = (a2aRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/a2a" && l.route.methods?.post);
      const handle = layer.route.stack[layer.route.stack.length - 1].handle;
      const call = (agentId: string) => new Promise<any>((resolve) => {
        const req: any = { method: "POST", url: "/a2a", path: "/a2a", originalUrl: "/a2a", headers: { "user-agent": "test-agent/1.0" },
          body: { jsonrpc: "2.0", method: "agent/info", params: { agentId }, id: 1 }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined };
        const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, setHeader() { return this; },
          header() { return this; }, set() { return this; }, json(b: any) { this.headersSent = true; resolve(b); return this; } };
        handle(req, res);
      });
      const hText = JSON.stringify(await call(HIDDEN_FT));
      assertEq(ftLeaks(hText), [], "ft-a2a-1: A2A agent/info of the hidden row carries no contact text in any free-text field");
      assertTrue(hText.includes("Gardsost") && hText.includes("Eple 30 kr/kg") && hText.includes(M), "ft-a2a-2: products and harmless text kept, marker in place");
      const vText = JSON.stringify(await call(VISIBLE_FT));
      assertEq(ftLeaks(vText), FT_SECRETS, "ft-a2a-3: visible row's free-text fields unchanged");
      assertTrue(!vText.includes(M), "ft-a2a-4: no marker on the visible row");
    }
  } finally {
    console.log = prevLog;
    if (prevByIdFlag === undefined) delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;
    else process.env.OWNER_VISIBILITY_ENFORCE_BY_ID = prevByIdFlag;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runHiddenRowN1Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
