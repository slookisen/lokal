/**
 * rfb-tredjeperson-svar.test.ts — dev-request
 * 2026-11-06-rfb-svar-til-kjoperagenter-tredje-person.
 *
 * The owner's decision: «Svar til kjøperagenter i tredje person, ikke i
 * produsentens navn». Drives the REAL code against an in-memory DB with the
 * full init.ts schema (same harness as a2a-spam-guard.test.ts):
 *
 *   R  generateSellerResponse(): the reply opens with «Automatisk svar fra
 *      Rett fra Bonden», says «Ifølge profilen til <Navn> …» and has no
 *      first-person template (vi / vår / våre / oss / jeg / «Hei fra»).
 *   O  owner-written text (curated_fields.about.by = "owner") is shown
 *      unchanged, labelled «Fra profilen til <Navn>: "…"»; scraped text is
 *      not shown, as before.
 *   L  a reply stored in the producer's name before the change reads in the
 *      third person on the public pages (thirdPersonAutoReply, transcript,
 *      /samtaler snippet), marked; the stored row is unchanged.
 *   A  POST /a2a message/send: the conversation's reply has the marker.
 *   C  GET /a2a card: the skill is «producer-profile-answer», no «negotiat»
 *      anywhere on the card (case-insensitive), no «agent-conversation».
 *   K  the old skill id «agent-conversation» is still accepted (alias) and
 *      answers as the new id does; no skill named → no `skill` key.
 *
 * Exported runRfbTredjepersonSvarTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-tredjeperson-svar.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult { status: number; body: any }

function callRoute(router: any, opts: { method?: string; url: string; body?: any; ip?: string; headers?: Record<string, string> }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers || {}) };
    const req: any = {
      method: opts.method || "POST", url: opts.url, originalUrl: opts.url, query: {}, headers, body: opts.body,
      ip: opts.ip || "127.0.0.1", get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200, locals: {},
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; }, header() { return this; }, set() { return this; }, type() { return this; },
      on() { return this; }, once() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: err ? String(err) : "no route" } }));
  });
}

/** First-person templates the platform used to answer in, in the producer's name. */
const FIRST_PERSON = /\b(vi|vår|vårt|våre|oss|jeg|meg|min|mine)\b|Hei fra/i;

const OWNER = { id: "tp-eier", name: "Eiergården Tredjeperson", city: "Oslo", lat: 59.9139, lng: 10.7522 };
const SCRAPED = { id: "tp-skrapt", name: "Skrapegården Tredjeperson", city: "Oslo", lat: 59.92, lng: 10.75 };
const OWNER_ABOUT = "Vi er en liten gård med honning og egg. Velkommen innom!";

function seed(db: Database.Database): void {
  const agent = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, 'Lokal produsent', 'test', ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, '["honey"]', '[]', '[]', '{}', '["no"]',
            0.7, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  const knowledge = db.prepare(`
    INSERT INTO agent_knowledge (agent_id, address, postal_code, phone, website, about, products, curated_fields, verification_status)
    VALUES (?, 'Gårdsvegen 1', '0150', '91234567', ?, ?, ?, ?, 'verified')
  `);
  for (const [a, about, curated] of [
    [OWNER, OWNER_ABOUT, JSON.stringify({ about: { locked_at: "2026-11-01T00:00:00Z", by: "owner" } })],
    [SCRAPED, "Vi selger honning fra egne bikuber i Oslo.", "{}"],
  ] as const) {
    agent.run(a.id, a.name, `${a.id}@example.no`, `https://${a.id}.example.no`, `key-${a.id}`, a.lat, a.lng, a.city);
    knowledge.run(a.id, `https://${a.id}.example.no`, about,
      JSON.stringify([{ name: "Honning", category: "honey", price: "150 kr" }, { name: "Egg", category: "eggs" }]), curated);
  }
}

export async function runRfbTredjepersonSvarTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const { a2aConversationCap } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
  a2aConversationCap.reset();

  try {
    const cs = require("../services/conversation-service") as typeof import("../services/conversation-service");
    const { conversationService, AUTO_REPLY_MARKER, thirdPersonAutoReply, fromProfileQuote } = cs;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    (marketplaceRegistry as any)._agentsCache = null;

    // ══ R  the reply about a producer ══════════════════════════════════
    {
      for (const [a, q] of [[SCRAPED, undefined], [SCRAPED, "honning"], [OWNER, "egg"]] as const) {
        const r = conversationService.generateSellerResponse(a.id, q);
        const text = r?.text ?? "";
        const label = `R ${a.id}${q ? ` «${q}»` : ""}`;
        assertTrue(text.startsWith(`${AUTO_REPLY_MARKER}.\n`), `${label}: opens with «${AUTO_REPLY_MARKER}»`);
        assertTrue(text.includes(`Ifølge profilen til ${a.name}`), `${label}: says «Ifølge profilen til <Navn>»`);
        // The owner's own quoted text is the only place first person may appear.
        const own = fromProfileQuote(a.name, OWNER_ABOUT);
        assertTrue(!FIRST_PERSON.test(text.replace(own, "")),
          `${label}: no first-person template (got ${JSON.stringify(text.replace(own, "").match(FIRST_PERSON)?.[0])})`);
        assertTrue(text.includes(`Se profilen til ${a.name}: `) && text.includes(`Ta kontakt med ${a.name} direkte`),
          `${label}: profile link and closing name the producer in the third person`);
        assertTrue(text.includes("\nKontakt:\n📍 "), `${label}: the contact block's header is «Kontakt:»`);
      }
      const matched = conversationService.generateSellerResponse(SCRAPED.id, "honning")!.text.split("\n").slice(0, 3);
      assertEq(matched, [`${AUTO_REPLY_MARKER}.`, `Ifølge profilen til ${SCRAPED.name} har de dette som passer søket:`, "• Honning — 150 kr"],
        "R a query: marker, third-person intro, the matching product");
      const all = conversationService.generateSellerResponse(SCRAPED.id)!.text.split("\n").slice(0, 2);
      assertEq(all, [`${AUTO_REPLY_MARKER}.`, `Ifølge profilen til ${SCRAPED.name} tilbyr de (2 produkter):`],
        "R no query: marker, third-person product overview");
    }

    // ══ O  owner-written text, unchanged and labelled ═════════════════
    {
      const owner = conversationService.generateSellerResponse(OWNER.id)!.text;
      assertTrue(owner.includes(`\nFra profilen til ${OWNER.name}: "${OWNER_ABOUT}"\n`),
        "O the owner's own text is shown unchanged, labelled «Fra profilen til <Navn>: …»");
      const scraped = conversationService.generateSellerResponse(SCRAPED.id)!.text;
      assertTrue(!scraped.includes("Fra profilen til") && !scraped.includes("bikuber"),
        "O scraped about text (not owner-written) is not shown, as before");
    }

    // ══ L  replies stored in the producer's name (before the change) ═══
    {
      const legacy = [
        "Hei fra Kjells Gård! 👋",
        "Vi har det du leter etter:",
        "• Honning — 89 kr",
        "",
        "Kontakt oss:",
        "📞 90012345",
        "",
        "🔗 Se profilen vår: https://rettfrabonden.com/produsent/kjells-gard",
        "",
        "Ta gjerne kontakt for spørsmål eller bestilling!",
      ].join("\n");
      const t = thirdPersonAutoReply(legacy, "Kjells Gård");
      assertEq(t.split("\n"), [
        `${AUTO_REPLY_MARKER}.`,
        "Ifølge profilen til Kjells Gård har de dette som passer søket:",
        "• Honning — 89 kr",
        "",
        "Kontakt:",
        "📞 90012345",
        "",
        "🔗 Se profilen til Kjells Gård: https://rettfrabonden.com/produsent/kjells-gard",
        "",
        "Ta kontakt med Kjells Gård direkte for spørsmål eller bestilling.",
      ], "L a legacy reply reads in the third person, marked");
      assertTrue(!FIRST_PERSON.test(t), "L …with no first-person template left");
      const noProducts = thirdPersonAutoReply("Hei fra Kjells Gård! 👋\n\nKontakt oss:\n📞 90012345", "Kjells Gård");
      assertEq(noProducts, `${AUTO_REPLY_MARKER}.\nIfølge profilen til Kjells Gård:\n\nKontakt:\n📞 90012345`,
        "L a legacy reply without products gets «Ifølge profilen til <Navn>:»");
      const fresh = conversationService.generateSellerResponse(SCRAPED.id)!.text;
      assertEq(thirdPersonAutoReply(fresh, SCRAPED.name), fresh, "L a new reply is returned as given (idempotent)");
      assertEq(thirdPersonAutoReply("Takk, vi ringer deg.", "X"), "Takk, vi ringer deg.", "L any other text is returned as given");

      const ui = require("./conversation-ui") as typeof import("./conversation-ui");
      const html = ui.renderTranscriptBody({
        sellerAgentName: "Kjells Gård", queryText: "honning", source: "a2a", createdAt: "2026-07-09T14:23:01.000Z",
        messages: [{ senderRole: "seller", senderAgentName: "Kjells Gård", content: legacy, messageType: "offer",
          metadata: { autoGenerated: true }, createdAt: "2026-07-09T14:23:02.000Z" }],
      });
      assertTrue(html.includes(`>${AUTO_REPLY_MARKER}</span>`), "L transcript: the reply is tagged «Automatisk svar fra Rett fra Bonden»");
      assertTrue(html.includes("Rett fra Bonden om Kjells Gård"), "L transcript: the bubble is the platform's, about the producer");
      assertTrue(!/Hei fra|Vi har det|Ta gjerne kontakt/.test(html), "L transcript: no first-person line of the stored reply is shown");
      const snippet = ui.sellerReplySnippet({ id: "x", sellerAgentName: "Kjells Gård",
        messages: [{ senderRole: "seller", content: legacy, metadata: { autoGenerated: true } }] });
      assertTrue(snippet.startsWith(`${AUTO_REPLY_MARKER}.\nIfølge profilen til Kjells Gård`), "L /samtaler snippet: third person, marked");
      assertEq(ui.sellerReplySnippet({ id: "x", messages: [{ senderRole: "seller", content: "Hei fra oss! 👋", metadata: {} }] }),
        "Hei fra oss! 👋", "L /samtaler snippet: a message that is not an auto-reply is shown as it is");
    }

    // ══ A  POST /a2a message/send ═════════════════════════════════════
    const router = require("./a2a").default;
    const a2a = require("./a2a") as typeof import("./a2a");
    let ipSeq = 0;
    const send = (params: any) => callRoute(router, {
      url: "/a2a", ip: `10.77.0.${++ipSeq}`, headers: { "user-agent": "curl/8.5.0" },
      body: { jsonrpc: "2.0", method: "message/send", params, id: "tp" },
    });
    const text = (t: string) => ({ role: "user", parts: [{ kind: "text", text: t }] });
    const dataOf = (r: RouteResult) => r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
    {
      const r = await send({ message: text("honning i Oslo") });
      const convs = dataOf(r)?.conversations || [];
      assertTrue(convs.length >= 1, `A message/send starts conversations with the matching producers (got ${convs.length})`);
      for (const c of convs) {
        const conv = conversationService.getConversation(c.conversationId)!;
        const reply = conv.messages.find((m) => m.senderRole === "seller");
        assertTrue(!!reply && reply.content.startsWith(`${AUTO_REPLY_MARKER}.`) && reply.metadata?.autoGenerated === true,
          `A ${c.sellerAgentId}: the stored reply has the marker`);
        assertTrue(!!reply && reply.content.includes(`Ifølge profilen til ${c.sellerAgentName}`) &&
          !FIRST_PERSON.test(reply.content.replace(fromProfileQuote(c.sellerAgentName, OWNER_ABOUT), "")),
          `A ${c.sellerAgentId}: third person, no first-person template`);
      }
      assertTrue(!("skill" in (dataOf(r) || {})) || dataOf(r).skill === undefined, "A no skill named → no `skill` in the answer, as before");
    }

    // ══ C  GET /a2a card ═════════════════════════════════════════════
    {
      const card = (await callRoute(router, { method: "GET", url: "/a2a" })).body;
      const ids = (card?.skills || []).map((s: any) => s.id);
      assertTrue(ids.includes(a2a.PRODUCER_ANSWER_SKILL_ID), `C the card shows the new skill «${a2a.PRODUCER_ANSWER_SKILL_ID}»`);
      assertTrue(!ids.includes("agent-conversation"), "C the card does not show the old skill id «agent-conversation»");
      assertTrue(!/negotiat/i.test(JSON.stringify(card)), "C no «negotiat» anywhere on the card (case-insensitive)");
      assertTrue(!/Start Agent Negotiation/i.test(JSON.stringify(card)), "C «Start Agent Negotiation» is gone");
      const skill = (card?.skills || []).find((s: any) => s.id === a2a.PRODUCER_ANSWER_SKILL_ID);
      assertTrue(!!skill && String(skill.description).includes(AUTO_REPLY_MARKER), "C the skill says its answers are marked");
      // (the .well-known registry card's «negotiat»-free lock is discovery-truth.test.ts card-rfb-2)
    }

    // ══ K  the old skill id as an alias ══════════════════════════════
    {
      assertEq(a2a.resolveRfbSkillId("agent-conversation"), a2a.PRODUCER_ANSWER_SKILL_ID, "K resolveRfbSkillId: the old id → the new one");
      assertEq(a2a.resolveRfbSkillId(a2a.PRODUCER_ANSWER_SKILL_ID), a2a.PRODUCER_ANSWER_SKILL_ID, "K resolveRfbSkillId: the new id stays");
      assertEq(a2a.resolveRfbSkillId(undefined), undefined, "K resolveRfbSkillId: none → undefined");
      for (const [where, params] of [
        ["params.metadata.skillId", { message: text("honning i Oslo"), metadata: { skillId: "agent-conversation" } }],
        ["message.metadata.skillId", { message: { ...text("honning i Oslo"), metadata: { skillId: "agent-conversation" } } }],
        ["params.skillId", { message: text("honning i Oslo"), skillId: "agent-conversation" }],
      ] as const) {
        const r = await send(params);
        assertEq(r.body?.result?.task?.status?.state, "completed", `K old id via ${where}: still a completed task`);
        assertEq(dataOf(r)?.skill, a2a.PRODUCER_ANSWER_SKILL_ID, `K old id via ${where}: read as «${a2a.PRODUCER_ANSWER_SKILL_ID}»`);
        assertTrue((dataOf(r)?.count ?? 0) >= 1, `K old id via ${where}: answers with producers, as the new id does`);
      }
      const r = await send({ message: text("honning i Oslo"), metadata: { skillId: a2a.PRODUCER_ANSWER_SKILL_ID } });
      assertEq(dataOf(r)?.skill, a2a.PRODUCER_ANSWER_SKILL_ID, "K the new id answers as itself");
    }
  } finally {
    console.log = prevLog;
    a2aConversationCap.reset();
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    (marketplaceRegistry as any)._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbTredjepersonSvarTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
