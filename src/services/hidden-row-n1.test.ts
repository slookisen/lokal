/**
 * hidden-row-n1.test.ts — katalog skive 6 (N1 from #1427): a catalog_hidden
 * row shows no contact information in any public answer, also not through
 * externalLinks, images or contact text inside `about`.
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
  const { redactContactText, withoutContactFields } = visibility;
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
