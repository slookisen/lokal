/**
 * rfb-hidden-contact-omission.test.ts — Claude directory checklist
 * (2026-11-07): the hidden RFB test fixture's contact details appear in no
 * public answer.
 *
 * lokal_info passes `allowCatalogHidden` so the hidden test fixture
 * (origin='test_fixture' AND catalog_hidden=1) stays orderable by product id,
 * and so it printed the fixture's «## Kontakt» block (a real person's phone
 * and e-mail) and its vCard link. Now a catalog_hidden row (outside the admin
 * as-public view, see agent-visibility.ts) is described without them, with
 * HIDDEN_CONTACT_NOTE_NB in their place; a visible producer's answer is
 * unchanged. The same omission on the other public by-id surfaces that render
 * a hidden row's contact details: the MCP resource lokal://producers/{id},
 * A2A agent/info, the seller auto-reply of a conversation, and
 * contact_handoffs of lokal_cart_submit.
 *
 * Same duck-typed-server harness as mcp-lokal-info-and-category-labels.test.ts
 * against the real production schema in an in-memory DB.
 *
 * Exported runRfbHiddenContactOmissionTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-hidden-contact-omission.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HIDDEN = "4c000000-0000-4000-8000-000000000001";
const VISIBLE = "4c000000-0000-4000-8000-000000000002";
const CLAIM_FIXTURE = "4c000000-0000-4000-8000-000000000003";
const HIDDEN_PRODUCT = "4c000000-0000-4000-8000-0000000000a1";
const VISIBLE_PRODUCT = "4c000000-0000-4000-8000-0000000000a2";

interface Contact { address: string; postal: string; phone: string; email: string; website: string }

const CONTACT: Record<string, Contact> = {
  [HIDDEN]: { address: "Privatveien 17", postal: "1234", phone: "98765432", email: "privat.person@fixture.example.no", website: "https://privat-fixture.example.no" },
  [VISIBLE]: { address: "Gardsvegen 3", postal: "2345", phone: "91234567", email: "post@synlig-gard.example.no", website: "https://synlig-gard.example.no" },
  [CLAIM_FIXTURE]: { address: "Kravveien 9", postal: "3456", phone: "97777777", email: "krav@fixture.example.no", website: "https://krav-fixture.example.no" },
};

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at, origin, catalog_hidden)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            59.91, 10.75, 'Oslo', '["vegetables"]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?, ?)
  `);
  const rows: Array<[string, string, string, number, string, string]> = [
    [HIDDEN, "Skjult Testgard Kontakt", "test_fixture", 1, "Testpoteter", HIDDEN_PRODUCT],
    [VISIBLE, "Synlig Gard Kontakt", "discovery", 0, "Gulrøtter", VISIBLE_PRODUCT],
    [CLAIM_FIXTURE, "Kravtest Gard Kontakt", "test_claim_fixture", 1, "Kravkål", ""],
  ];
  for (const [id, name, origin, hidden, product, productId] of rows) {
    const c = CONTACT[id];
    agentStmt.run(id, name, `Beskrivelse av ${name}`, c.email, c.website, `key-${id}`, origin, hidden);
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, address, postal_code, phone, email, website, about, products, opening_hours, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')
    `).run(id, c.address, c.postal, c.phone, c.email, c.website,
      `Vi er ${name} og dyrker grønnsaker i Oslo.`,
      JSON.stringify([{ name: product, category: "vegetables" }]),
      JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }]));
    if (productId) {
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
        VALUES (?, ?, ?, ?, 30, 'kg', 'in_stock', 'admin_producer_confirmed')`).run(productId, id, product, product.toLowerCase());
    }
  }
}

export async function runRfbHiddenContactOmissionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seed(db);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404,
    json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  const prevByIdFlag = process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;

  /** Every contact string of `id` that occurs in `text`. */
  const leaked = (text: string, id: string): string[] => {
    const c = CONTACT[id];
    return [c.address, c.phone, c.email, c.website, `${id}/vcard`, "vCard", "## Kontakt"].filter((s) => text.includes(s));
  };

  try {
    const visibility = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    const { HIDDEN_CONTACT_NOTE_NB, runAsPublicView } = visibility;

    // ── Pure helpers ──────────────────────────────────────────────
    assertEq([
      visibility.contactHiddenForView({ catalog_hidden: 1, origin: "test_fixture" }),
      visibility.contactHiddenForView({ catalog_hidden: 1, origin: "test_claim_fixture" }),
      visibility.contactHiddenForView({ catalog_hidden: 0, origin: "test_fixture" }),
      visibility.contactHiddenForView({ catalog_hidden: null, origin: null }),
      visibility.contactHiddenForView(undefined),
    ], [true, true, false, false, false], "helper-1: contactHiddenForView is true for catalog_hidden rows only");
    assertEq(runAsPublicView(() => [
      visibility.contactHiddenForView({ catalog_hidden: 1, origin: "test_fixture" }),
      visibility.contactHiddenForView({ catalog_hidden: 1, origin: "test_claim_fixture" }),
    ]), [false, true], "helper-2: as-public view: the order fixture reads as public, the claim fixture stays hidden");
    assertEq([visibility.isContactHiddenAgentId(db, HIDDEN), visibility.isContactHiddenAgentId(db, VISIBLE), visibility.isContactHiddenAgentId(db, "no-such-id")],
      [true, false, false], "helper-3: isContactHiddenAgentId reads the row (unknown id = false)");
    assertEq(visibility.isContactHiddenAgentId({ prepare() { throw new Error("no such column: catalog_hidden"); } }, HIDDEN), false,
      "helper-4: a failed read is false (today's answer)");
    assertEq(visibility.withoutContactFields({ address: "a", postalCode: "p", phone: "1", email: "e", website: "w", about: "x", products: [] }),
      { about: "x", products: [], externalLinks: [], images: [] }, "helper-5: withoutContactFields drops address, postalCode, phone, email and website and empties links and images");

    const mcp = require("./mcp") as typeof import("./mcp");
    const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
    const resources = new Map<string, (uri: URL) => Promise<any>>();
    mcp.registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource(name: string, _uri: any, _meta: any, handler: any) { resources.set(name, handler); },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    for (const flag of [undefined, "1"]) {
      if (flag === undefined) delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;
      else process.env.OWNER_VISIBILITY_ENFORCE_BY_ID = flag;
      const tag = flag ? "by-id flag on" : "by-id flag off";

      // (a) lokal_info for the hidden fixture: no contact, still orderable by id.
      {
        const t = await toolText("lokal_info", { agentId: HIDDEN });
        assertTrue(t.startsWith("# Skjult Testgard Kontakt"), `info-a1 (${tag}): lokal_info still describes the hidden fixture (got: ${t.slice(0, 80)})`);
        assertEq(leaked(t, HIDDEN), [], `info-a2 (${tag}): no address, phone, e-mail, website or vCard of the hidden fixture`);
        assertTrue(t.includes(HIDDEN_PRODUCT), `info-a3 (${tag}): the catalog product id is still listed (orderable by id)`);
        assertTrue(t.includes("Testpoteter") && t.includes("## Åpningstider") && t.includes("dyrker grønnsaker"),
          `info-a4 (${tag}): products, opening hours and about are still shown`);
        assertTrue(t.includes(`\n\n${HIDDEN_CONTACT_NOTE_NB}\n`), `info-a5 (${tag}): the one note line stands where the contact block was`);
      }
      // (b) lokal_info for a visible producer: contact block and vCard as before.
      {
        const t = await toolText("lokal_info", { agentId: VISIBLE });
        const c = CONTACT[VISIBLE];
        assertTrue(t.includes(`\n## Kontakt\n📍 ${c.address}`) && t.includes(`📞 ${c.phone}`) && t.includes(`✉️ ${c.email}`) && t.includes(`🌐 ${c.website}`),
          `info-b1 (${tag}): the visible producer keeps its «## Kontakt» block`);
        assertTrue(t.includes(`🪪 [Last ned kontaktkort (vCard)](`) && t.includes(`/api/marketplace/agents/${VISIBLE}/vcard`),
          `info-b2 (${tag}): the visible producer keeps its vCard link`);
        assertTrue(!t.includes(HIDDEN_CONTACT_NOTE_NB) && t.includes(VISIBLE_PRODUCT), `info-b3 (${tag}): no note line, product id listed`);
      }
    }
    delete process.env.OWNER_VISIBILITY_ENFORCE_BY_ID;

    // The claim-test fixture (served by id on lokal_info only with the by-id flag off): no contact either.
    {
      const t = await toolText("lokal_info", { agentId: CLAIM_FIXTURE });
      assertEq(leaked(t, CLAIM_FIXTURE), [], "info-c1: the claim-test fixture shows no contact details on lokal_info");
    }

    // (c) the as-public view: the order fixture reads as public, contact included.
    {
      const t = String((await runAsPublicView(() => tools.get("lokal_info")!({ agentId: HIDDEN })))?.content?.[0]?.text ?? "");
      const c = CONTACT[HIDDEN];
      assertTrue(t.includes(`\n## Kontakt\n📍 ${c.address}`) && t.includes(`📞 ${c.phone}`) && t.includes(`/api/marketplace/agents/${HIDDEN}/vcard`),
        "info-d1: as-public view: the order fixture is shown as public, with its contact block and vCard (as on every as-public surface)");
      assertTrue(!t.includes(HIDDEN_CONTACT_NOTE_NB), "info-d2: as-public view: no note line");
      const claim = String((await runAsPublicView(() => tools.get("lokal_info")!({ agentId: CLAIM_FIXTURE })))?.content?.[0]?.text ?? "");
      assertEq(leaked(claim, CLAIM_FIXTURE), [], "info-d3: as-public view never reaches the claim-test fixture");
    }

    // MCP resource lokal://producers/{agentId} (served for any id with the by-id flag off).
    {
      const read = async (id: string) => String((await resources.get("producer-detail")!(new URL(`lokal://producers/${id}`)))?.contents?.[0]?.text ?? "");
      const h = await read(HIDDEN);
      assertEq(leaked(h, HIDDEN), [], "res-1: the MCP producer resource carries no contact details of the hidden fixture");
      const hj = JSON.parse(h);
      assertEq([hj.agent?.id, hj.knowledge?.products?.[0]?.name], [HIDDEN, "Testpoteter"], "res-2: …but the rest of the profile is still there");
      const v = JSON.parse(await read(VISIBLE));
      assertEq([v.knowledge?.phone, v.knowledge?.email, v.knowledge?.address, v.knowledge?.website],
        [CONTACT[VISIBLE].phone, CONTACT[VISIBLE].email, CONTACT[VISIBLE].address, CONTACT[VISIBLE].website],
        "res-3: a visible producer's resource keeps its contact fields");
    }

    // A2A JSON-RPC agent/info (no catalog_hidden gate of its own).
    {
      const a2aRouter = require("./a2a").default as any;
      const layer = (a2aRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/a2a" && l.route.methods?.post);
      const handle = layer.route.stack[layer.route.stack.length - 1].handle;
      const call = (agentId: string) => new Promise<any>((resolve) => {
        const req: any = { method: "POST", url: "/a2a", path: "/a2a", originalUrl: "/a2a", headers: { "user-agent": "test-agent/1.0" },
          body: { jsonrpc: "2.0", method: "agent/info", params: { agentId }, id: 1 }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined };
        const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, setHeader() { return this; },
          header() { return this; }, set() { return this; }, json(b: any) { this.headersSent = true; resolve(b); return this; } };
        handle(req, res);
      });
      const h = await call(HIDDEN);
      const hText = JSON.stringify(h);
      assertEq(leaked(hText, HIDDEN), [], "a2a-1: A2A agent/info carries no contact details of the hidden fixture");
      assertTrue(hText.includes("Testpoteter"), "a2a-2: …but still the profile and its products");
      const vText = JSON.stringify(await call(VISIBLE));
      assertTrue(vText.includes(CONTACT[VISIBLE].phone) && vText.includes(CONTACT[VISIBLE].email), "a2a-3: a visible producer keeps its contact fields");
    }

    // Seller auto-reply of a conversation (POST /api/conversations, A2A message/send).
    {
      const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
      const h = conversationService.generateSellerResponse(HIDDEN, "poteter")?.text ?? "";
      assertEq(leaked(h, HIDDEN), [], "conv-1: the seller auto-reply of the hidden fixture has no contact details");
      assertTrue(h.includes(HIDDEN_CONTACT_NOTE_NB) && !h.includes("Kontakt oss:") && !h.includes("\nKontakt:\n"), "conv-2: …the note line instead");
      const v = conversationService.generateSellerResponse(VISIBLE, "gulrøtter")?.text ?? "";
      assertTrue(v.includes("\nKontakt:\n") && v.includes(CONTACT[VISIBLE].phone) && !v.includes(HIDDEN_CONTACT_NOTE_NB), "conv-3: a visible producer's auto-reply keeps its contact block («Kontakt:», third person since 2026-11-13)");
    }

    // contact_handoffs of lokal_cart_submit (the hidden fixture not opted in to orders).
    {
      const cartFor = async (productId: string) => {
        const created = JSON.parse(await toolText("lokal_cart_create", {}));
        const cart_id = String(created?.cart_id ?? "");
        const buyer_ref = String(created?.buyer_ref ?? "");
        const added = JSON.parse(await toolText("lokal_cart_add_item", { cart_id, buyer_ref, product_id: productId, qty: 1 }));
        assertEq(added?.success, true, `cart-0: add_item by id accepted ${productId} (${JSON.stringify(added?.error ?? "")})`);
        return JSON.parse(await toolText("lokal_cart_submit", { cart_id, buyer_ref, buyer_name: "Test Kjøper", buyer_email: "kjoper@example.no", contact_consent: true }));
      };
      const h = await cartFor(HIDDEN_PRODUCT);
      const hh = (h?.contact_handoffs ?? []).find((x: any) => x.agent_id === HIDDEN);
      assertTrue(!!hh, `cart-1: the hidden fixture (not opted in) lands in contact_handoffs (${JSON.stringify(h).slice(0, 200)})`);
      assertEq([hh?.phone, hh?.email], [null, null], "cart-2: its handoff carries no phone or e-mail");
      assertEq(leaked(JSON.stringify(h), HIDDEN).filter((s) => s !== "vCard"), [], "cart-3: no contact string of the hidden fixture anywhere in the submit answer");
      assertTrue(typeof hh?.message === "string" && hh.message.includes("Testpoteter"), "cart-4: the prefilled message is still there");
      const v = await cartFor(VISIBLE_PRODUCT);
      const vh = (v?.contact_handoffs ?? []).find((x: any) => x.agent_id === VISIBLE);
      assertEq([vh?.phone, vh?.email], [CONTACT[VISIBLE].phone, CONTACT[VISIBLE].email], "cart-5: a visible producer's handoff keeps phone and e-mail");
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

// Standalone runner
if (require.main === module) {
  runRfbHiddenContactOmissionTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
