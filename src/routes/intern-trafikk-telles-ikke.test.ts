/**
 * intern-trafikk-telles-ikke.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Z (FUNN
 * rest-sok-teller-verifisering-som-oppdagelse and
 * sesjonens-a2a-prober-telt-som-ai-oppslag, P2).
 *
 * Our own verification traffic was counted as use. GET
 * /api/marketplace/search, MCP lokal_search and /sok raised the producers'
 * discovery counters (agent_metrics.times_discovered goes into trust_score)
 * on every call, where POST /a2a skips our own traffic and probes. And the
 * session lane's user agent «session-lane-verify/1.0 (read-only)» was no
 * internal marker, so its A2A checks of Finn-tannlege were AI lookups, and
 * the analytics tables (owner = isOwnerRequest) took its page views and
 * searches for a person's.
 *
 * The counters a search or a lookup raises, all in the main DB (readCounters):
 *   discoveryCount, timesDiscovered  agents.discovery_count and agent_metrics.times_discovered (RFB)
 *   timesContacted, conversations    agent_metrics.times_contacted and the countable conversations (/samtaler)
 *   interactions                     the interactions table (/api/interactions/stats, /api/live; RFB)
 *   searches                         analytics_queries rows without is_owner (search stats)
 *   pageViews, agentViews            analytics_page_views and analytics_agent_views without is_owner
 *                                    (traffic stats; the Opplevagent home counters read the page views)
 *   mcpCalls, aiLookups              analytics_mcp_calls without is_owner, and computeAiLookups()
 *                                    (AI-søk; also in the Opplevagent home counters)
 *   aiDeliveries                     profile_ai_deliveries («Med i AI-svar»), flushed on each read
 *
 *   K   the rules. «session-lane-verify» is an internal marker
 *       (internal-traffic.ts, re-exported by conversation-service.ts);
 *       isOwnerRequest() also takes internal traffic (a valid X-Admin-Key,
 *       the internal markers) and keeps its own list (curl and python
 *       scripts) as before; searchTrafficClass() is 'internal' for our own
 *       traffic (also by MCP client name), 'probe' for catalogue probes and
 *       monitors (PROBE_CLIENT_MARKERS) and for the A2A guard's probe rules,
 *       'spam' for its spam rules, else 'external'.
 *   I   every search and lookup entry of the three platforms, over real HTTP
 *       through the analytics middleware and mcp-usage-logger as index.ts
 *       mounts them: a call that is our own traffic (UA session-lane-verify,
 *       UA rfb-session-lane-verify, a valid X-Admin-Key, the owner cookie)
 *       gets the answer an external call gets and changes no counter. RFB
 *       A2A message/send keeps its one known difference: it starts
 *       conversations for external callers only (the spam guard of
 *       2026-10-04), and its answer lists them.
 *       An MCP session whose initialize.clientInfo.name is ours raises no
 *       discovery counter and no «Med i AI-svar» (the session's client name,
 *       as deliver() reads it); its tools/call rows still count in AI-søk,
 *       because mcp-usage-logger sees the client name on initialize only
 *       (FUNN in the PR).
 *   P   probes and spam (UA agentprobe, MCP client glama, a wallet address
 *       in the text) raise no discovery counter and no interactions row on
 *       any entry, and no countable conversation on RFB (also the one POST
 *       /api/marketplace/discover starts with start_conversation; GET
 *       /api/marketplace/search's is not driven here, FUNN in the PR, since
 *       its answer shows the seller's reply). A probe UA counts
 *       in no AI-søk and no «Med i AI-svar» either, as before. Two gaps in
 *       those two stay as they were (FUNN in the PR): AI-søk counts an MCP
 *       probe known by its client name only, and over MCP neither reads the
 *       tool's text. The analytics tables keep their own robot rules
 *       (client_class), unchanged here (new robot rules are G2-S1 and G2-S2).
 *   B1  external calls (an AI assistant fetching for a person, a person's
 *       browser, curl) change each counter by exactly what main did:
 *       tests/fixtures/intern-trafikk-i-z-main.json, captured with
 *       externalDeltas() below (--print) on main b25dfbce. Each entry
 *       changes at least one counter there, so I's «no change» is not empty.
 *
 * Data: own in-memory DBs (main with RFB producers, dental, experiences;
 * restored in finally), geocoding offline; the admin key is the suite's, set
 * here for a standalone run only. Three express apps on 127.0.0.1 (RFB,
 * Finn-tannlege, Opplevagent) mount the real routers behind
 * analyticsService.middleware() and mcpUsageLogger() in index.ts's order;
 * every request has its own X-Forwarded-For address, so the per-IP limiters
 * and caps never decide an answer. Node's http client,
 * never the global fetch (other blocks stub it). Tool metadata and the agent
 * cards are not touched by I-Z; their freezes are rfb-mcp-contract-freeze,
 * opplevagent-mcp-contract-freeze, dental-mcp-instructions and
 * dental-agent-card.
 *
 * Exported runInternTrafikkTellesIkkeTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/intern-trafikk-telles-ikke.test.ts [--print]
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { enterFixtures as enterRfbDb } from "./rfb-sok-ukjente-ord-bakeri-sted.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Counters ─────────────────────────────────────────────────────────────

export interface Counters {
  discoveryCount: number;
  timesDiscovered: number;
  timesContacted: number;
  conversations: number;
  interactions: number;
  searches: number;
  pageViews: number;
  agentViews: number;
  mcpCalls: number;
  aiLookups: number;
  aiDeliveries: number;
}

/** Every counter a search or lookup raises (see the header), read now. */
function readCounters(db: Database.Database): Counters {
  const { flushAiDeliveries } = require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries");
  const { computeAiLookups } = require("../services/search-stats-compute") as typeof import("../services/search-stats-compute");
  const { COUNTABLE_CONV_SQL } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
  flushAiDeliveries(db);
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number | null }).n ?? 0);
  const notOwner = "COALESCE(is_owner, 0) = 0";
  return {
    discoveryCount: n("SELECT SUM(discovery_count) AS n FROM agents"),
    timesDiscovered: n("SELECT SUM(times_discovered) AS n FROM agent_metrics"),
    timesContacted: n("SELECT SUM(times_contacted) AS n FROM agent_metrics"),
    conversations: n(`SELECT COUNT(*) AS n FROM conversations WHERE ${COUNTABLE_CONV_SQL}`),
    interactions: n("SELECT COUNT(*) AS n FROM interactions"),
    searches: n(`SELECT COUNT(*) AS n FROM analytics_queries WHERE ${notOwner}`),
    pageViews: n(`SELECT COUNT(*) AS n FROM analytics_page_views WHERE ${notOwner}`),
    agentViews: n(`SELECT COUNT(*) AS n FROM analytics_agent_views WHERE ${notOwner}`),
    mcpCalls: n(`SELECT COUNT(*) AS n FROM analytics_mcp_calls WHERE ${notOwner}`),
    aiLookups: computeAiLookups(db, 24, undefined, Date.now()).total,
    aiDeliveries: n("SELECT SUM(count) AS n FROM profile_ai_deliveries"),
  };
}

/** The counters that changed from `before` to `after`, by how much. */
function changed(before: Counters, after: Counters): Partial<Counters> {
  const out: Partial<Counters> = {};
  for (const k of Object.keys(before) as Array<keyof Counters>) {
    if (after[k] !== before[k]) out[k] = after[k] - before[k];
  }
  return out;
}

/** Response "finish" handlers (page views, usage rows, deliveries) have run. */
const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

// ─── HTTP ─────────────────────────────────────────────────────────────────

interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

let ipSeq = 0;
/** A fresh client address per request (198.18.0.0/15, benchmarking space no other suite uses). */
function freshIp(): string {
  ipSeq++;
  return `198.${18 + (Math.floor(ipSeq / 65025) % 2)}.${Math.floor(ipSeq / 255) % 255}.${1 + (ipSeq % 254)}`;
}

function send(port: number, method: "GET" | "POST", urlPath: string, headers: Record<string, string>, body?: unknown): Promise<HttpAnswer> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: urlPath, method, agent: false,
        headers: { ...headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A JSON-RPC answer: plain JSON or one SSE "data:" line (the MCP transport's negotiation). */
function rpcJson(a: HttpAnswer): any {
  if (!a.text) return undefined;
  if (String(a.headers["content-type"] || "").includes("text/event-stream")) {
    const line = a.text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    return line ? JSON.parse(line.slice("data:".length).trim()) : undefined;
  }
  try { return JSON.parse(a.text); } catch { return undefined; }
}

/** The answer with what differs per call masked: ids, timestamps, Date.now() ids, origins. */
function stable(v: unknown): string {
  return (typeof v === "string" ? v : JSON.stringify(v))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/-\d{13}\b/g, "-<now>")
    .replace(/https?:\/\/[^/"'\s<>]+/g, "<origin>");
}

// ─── Callers ──────────────────────────────────────────────────────────────

/** Who calls: the user agent, extra headers, and (MCP) initialize.clientInfo.name. */
interface Caller {
  ua: string;
  headers?: Record<string, string>;
  clientName?: string;
}

/** Our own caller, and the external caller (EXTERNAL) with the same kind of UA, whose answer it must get. */
interface InternalCaller extends Caller {
  like: string;
}

/** The admin key of a standalone run; in the suite, its own (tests/test.ts sets it once, and blocks must not change it). */
const STANDALONE_ADMIN_KEY = "i-z-standalone-admin-key";
/** The key the server checks (internal-traffic.ts), read when a request is sent. */
const currentAdminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
/** A standalone run has no admin key: set ours, and return the restore (a no-op in the suite). */
function ensureAdminKey(): () => void {
  if (currentAdminKey()) return () => {};
  process.env.ADMIN_KEY = STANDALONE_ADMIN_KEY;
  return () => { delete process.env.ADMIN_KEY; };
}
const AI_ASSISTANT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const MCP_CLIENT = "intern-trafikk-test-client";

/** External callers: B1's, and the answers I's callers must get. */
const EXTERNAL: Readonly<Record<string, Caller>> = {
  "AI assistant (ChatGPT-User)": { ua: AI_ASSISTANT_UA },
  "browser (Firefox)": { ua: BROWSER_UA },
  "curl": { ua: "curl/8.5.0" },
};

/**
 * Our own traffic: I's. The MCP tools name the AI client the UA shows in
 * their links (utm_source=chatgpt, else ai_assistant), so each caller is
 * compared with the external caller of the same kind of UA (`like`).
 */
const INTERNAL: Readonly<Record<string, InternalCaller>> = {
  "UA session-lane-verify": { ua: "session-lane-verify/1.0 (read-only)", like: "browser (Firefox)" },
  "UA rfb-session-lane-verify": { ua: "rfb-session-lane-verify/1.0 (read-only)", like: "browser (Firefox)" },
  "valid X-Admin-Key": { ua: AI_ASSISTANT_UA, get headers() { return { "X-Admin-Key": currentAdminKey() }; }, like: "AI assistant (ChatGPT-User)" },
  "owner cookie": { ua: BROWSER_UA, headers: { Cookie: "a=1; _rfb_owner=1" }, like: "browser (Firefox)" },
};

/** The counters P checks: those searchTrafficClass() decides, and AI-søk / «Med i AI-svar». */
type ProbeCounter = "discoveryCount" | "timesDiscovered" | "interactions" | "conversations" | "timesContacted" | "aiLookups" | "aiDeliveries";

/**
 * Probes and spam: P's. `text` replaces a free-text entry's search;
 * `untouched(entry)` lists the counters the call must leave alone.
 *   - MCP client glama: AI-søk still counts its tools/call rows, because
 *     mcp-usage-logger sees the client name on initialize only (FUNN).
 *   - Spam text over MCP: AI-søk and «Med i AI-svar» never read a tool's
 *     arguments (FUNN); POST /a2a's countable reads the text.
 * Conversations and times_contacted are RFB's (/samtaler).
 */
const PROBES: Readonly<Record<string, Caller & { text?: string; mcpOnly?: boolean; untouched: (entry: Entry) => ProbeCounter[] }>> = {
  "UA agentprobe": {
    ua: "agentprobe/0.1.0 (+https://agentprobe.org/)",
    untouched: (e) => [...searchCountersOf(e), "aiLookups", "aiDeliveries"],
  },
  "MCP client glama": {
    ua: AI_ASSISTANT_UA, clientName: "glama-inspector", mcpOnly: true,
    untouched: (e) => [...searchCountersOf(e), "aiDeliveries"],
  },
  "wallet address in the text": {
    ua: BROWSER_UA, text: "honning 0x1234567890abcdef1234567890abcdef12345678 token=USDC amount=max",
    untouched: (e) => [...searchCountersOf(e), ...(e.kind === "mcp" ? [] : ["aiLookups", "aiDeliveries"] as ProbeCounter[])],
  },
};
/** The counters searchTrafficClass() decides, on the entry's platform. */
function searchCountersOf(entry: Entry): ProbeCounter[] {
  return ["discoveryCount", "timesDiscovered", "interactions", ...(entry.name.startsWith("rfb ") ? ["conversations", "timesContacted"] as ProbeCounter[] : [])];
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const rid = (n: number) => `1c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function seed(n: number, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: rid(n), name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}
/** Own RFB producers (not another slice's), so a later fixture change there does not move B1. */
const RFB_SEEDS: Seed[] = [
  seed(1, "Trøndersk Birøkt Telling", 63.432, 10.4, "Trondheim", ["honey"], [{ name: "Lynghonning", priceNok: 150 }, { name: "Sommerhonning", priceNok: 120 }]),
  seed(2, "Nidaros Honning Telling", 63.44, 10.42, "Trondheim", ["honey"], [{ name: "Honning", priceNok: 140 }]),
  seed(3, "Leangen Gård Telling", 63.43, 10.47, "Trondheim", ["eggs", "honey"], [{ name: "Egg", priceNok: 50 }, { name: "Honning", priceNok: 130 }]),
  seed(4, "Fana Ysteri Telling", 60.3, 5.33, "Bergen", ["dairy"], [{ name: "Fanaost", priceNok: 190 }]),
];
const TRONDHEIM = { lat: 63.4305, lng: 10.3951 };

/** The registry's caches (agents, stats, slugs), which an earlier suite in the process may have filled. */
function clearRegistryCaches(): void {
  const registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry as any;
  registry._agentsCache = null;
  registry._agentsCacheTime = 0;
  registry._statsCache = null;
  registry._statsCacheTime = 0;
  registry._slugIdMap = null;
}

/** One search or lookup entry: its answer to `caller` (masked), optionally to another search text. */
interface Entry {
  name: string;
  kind: "mcp" | "a2a" | "api" | "page";
  /** True for an entry whose search is free text (P sends spam text to it). */
  freeText?: boolean;
  ask: (caller: Caller, text?: string) => Promise<string>;
}

interface Fixture {
  db: Database.Database;
  entries: Entry[];
  restore: () => Promise<void>;
}

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/**
 * Fresh in-memory DBs and the three apps. RFB: I-W's fixture DB with
 * RFB_SEEDS (the main DB singleton, geocoding offline, BASE_URL unset).
 * Finn-tannlege and Opplevagent: their own in-memory DBs through a fresh
 * db-factory (the module cache is swapped, as in I-X and I-Y).
 */
async function enter(): Promise<Fixture> {
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ["DENTAL_DB_PATH", "EXPERIENCES_DB_PATH", "DENTAL_QUERY_PARSER_DISABLED", "BOOKING_DISPATCH_ENABLED"]) prevEnv[k] = process.env[k];
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  delete process.env.BOOKING_DISPATCH_ENABLED;
  const restoreAdminKey = ensureAdminKey();
  const rfb = enterRfbDb(RFB_SEEDS);
  clearRegistryCaches();
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-seo"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-a2a"),
    require.resolve("./experiences-mcp"),
    require.resolve("./experiences-seo"),
    require.resolve("./opplevelser"),
  ]);
  const servers: Array<{ close: () => Promise<void> }> = [];
  const restore = async () => {
    for (const s of servers) await s.close();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    rfb.restore();
    clearRegistryCaches();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    restoreAdminKey();
  };
  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const caps = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
    caps.a2aConversationCap.reset();
    caps.a2aLookupCaps.dental.reset();
    caps.a2aLookupCaps.experiences.reset();
    (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();

    // Finn-tannlege
    const dentalStore = require("../services/dental-store") as typeof import("../services/dental-store");
    const addClinic = (row: Record<string, unknown>) => dentalStore.createDentalAgent({ telefon: "22000000", ...row } as any);
    const clinicId = addClinic({ navn: "Oslo Sentrum Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", org_nr: "912345678" });
    addClinic({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151", helfo_agreement: "true" });
    addClinic({ navn: "Bergen Tann", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003" });

    // Opplevagent
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    const providerId = expStore.createProvider({
      navn: "Nordlys Opplevelser AS", fylke: "Troms", kommune: "Tromsø",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    } as any);
    const addExperience = (title: string, extra: Record<string, unknown>) =>
      expStore.createExperience({
        title, provider_id: providerId, provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms", category: "natur",
        verification_status: "verified", confidence: "high", price_from: 500, duration_min: 90,
        indoor_outdoor: "outdoor", weather_dependent: 1, season: ["winter"], ...extra,
      } as any);
    const experienceId = addExperience("Nordlysjakt fra Tromsø", { lat: 69.65, lng: 18.95 });
    addExperience("Hvalsafari fra Tromsø", { category: "dyreliv_safari", lat: 69.66, lng: 18.96 });
    const experienceSlug = (expStore.getExperienceById(experienceId) as { slug?: string } | null)?.slug ?? "";
    const expDb = dbFactory.getDb("experiences");
    const farmShop = expStore.createProvider({
      navn: "Hardanger Sideri", fylke: "Vestland", kommune: "Ullensvang", poststed: "LOFTHUS",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    } as any);
    expDb.prepare("UPDATE experience_providers SET producer_type = 'sideri', slug = 'hardanger-sideri' WHERE id = ?").run(farmShop);

    // The apps, in index.ts's order: body parser, analytics, lang, then the routers.
    const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
    const { mcpUsageLogger } = require("../services/mcp-usage-logger") as typeof import("../services/mcp-usage-logger");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    const base = () => {
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json({ limit: "1mb" }));
      app.use(analyticsService.middleware());
      app.use(langMiddleware);
      return app;
    };

    const rfbApp = base();
    rfbApp.use("/api/marketplace", (require("./marketplace") as any).default);
    rfbApp.use("/api/marketplace/catalog", (require("./marketplace-catalog") as typeof import("./marketplace-catalog")).catalogRouter);
    rfbApp.use("/mcp", mcpUsageLogger("mcp", "rfb"), (require("./mcp") as any).default);
    rfbApp.use("/a2a", mcpUsageLogger("a2a", "rfb"));
    rfbApp.use("/", (require("./a2a") as any).default);
    rfbApp.use("/", (require("./seo") as any).default);

    /** Finn-tannlege and Opplevagent: /api/* on the shared routes, /mcp and /a2a on the vertical's, the rest its SEO router. */
    const verticalApp = (vertical: "dental" | "experiences", apiPath: string, api: any, mcpRouter: any, a2aRouter: any, seoRouter: any) => {
      const app = base();
      app.use(apiPath, api);
      app.use((req, res, next) => {
        if (req.path === "/mcp") return mcpUsageLogger("mcp", vertical)(req, res, () => mcpRouter(req, res, next));
        if (req.path === "/a2a") return mcpUsageLogger("a2a", vertical)(req, res, () => a2aRouter(req, res, next));
        return seoRouter(req, res, next);
      });
      return app;
    };
    const dentalApp = verticalApp("dental", "/api/tannlege", (require("./dental") as any).default,
      (require("./dental-mcp") as any).default, (require("./dental-a2a") as any).default, (require("./dental-seo") as any).default);
    const oaApp = verticalApp("experiences", "/api/opplevelser", (require("./opplevelser") as any).default,
      (require("./experiences-mcp") as any).default, (require("./experiences-a2a") as any).default, (require("./experiences-seo") as any).default);

    const rfbServer = await listen(rfbApp); servers.push(rfbServer);
    const dentalServer = await listen(dentalApp); servers.push(dentalServer);
    const oaServer = await listen(oaApp); servers.push(oaServer);

    const sites = {
      rfb: { port: rfbServer.port, host: "rettfrabonden.com" },
      dental: { port: dentalServer.port, host: "finn-tannlege.com" },
      oa: { port: oaServer.port, host: "opplevagent.no" },
    };
    type Site = keyof typeof sites;
    const headersFor = (site: Site, c: Caller, extra: Record<string, string> = {}) => ({
      Host: sites[site].host, "User-Agent": c.ua, "X-Forwarded-For": freshIp(), ...(c.headers ?? {}), ...extra,
    });

    /** One MCP session per call (initialize, initialized, tools/call), from one address. */
    const mcp = async (site: Site, c: Caller, tool: string, args: unknown): Promise<string> => {
      const h = headersFor(site, c, { Accept: "application/json, text/event-stream" });
      const init = await send(sites[site].port, "POST", "/mcp", h, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: c.clientName ?? MCP_CLIENT, version: "1.0.0" } },
      });
      const sid = String(init.headers["mcp-session-id"] ?? "");
      if (init.status !== 200 || !sid) return `initialize ${init.status}: ${init.text.slice(0, 200)}`;
      const withSession = { ...h, "Mcp-Session-Id": sid };
      await send(sites[site].port, "POST", "/mcp", withSession, { jsonrpc: "2.0", method: "notifications/initialized" });
      const call = await send(sites[site].port, "POST", "/mcp", withSession, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
      await settle();
      const json = rpcJson(call);
      return `${call.status} ${stable(json?.result ?? json?.error ?? call.text)}`;
    };
    /**
     * One JSON-RPC call to POST /a2a. RFB's message/send answer lists the
     * conversations it started, which it does for external callers only
     * (the spam guard): `conversations` is left out of the compared answer.
     */
    const a2a = async (site: Site, c: Caller, method: string, params: unknown): Promise<string> => {
      const r = await send(sites[site].port, "POST", "/a2a", headersFor(site, c), { jsonrpc: "2.0", id: "z", method, params });
      await settle();
      const json = rpcJson(r);
      const data = json?.result?.artifacts?.[0]?.parts?.[0]?.data;
      if (site === "rfb" && method === "message/send" && data && Array.isArray(data.conversations)) data.conversations = "<conversations>";
      return `${r.status} ${stable(json ?? r.text)}`;
    };
    /** message/send's params: one text part. */
    const say = (text: string) => ({ message: { role: "user", parts: [{ kind: "text", text }] } });
    const get = async (site: Site, c: Caller, urlPath: string): Promise<string> => {
      const r = await send(sites[site].port, "GET", urlPath, headersFor(site, c));
      await settle();
      return `${r.status} ${stable(r.text)}`;
    };
    /**
     * The RFB profile page's related producers tie-break with RANDOM()
     * (seo.ts getRelatedBy…): their cards are compared in sorted order.
     */
    const sortedRelatedCards = (page: string) => page.replace(/(<div class="rp-grid">)([\s\S]*?)(<\/div>\s*<\/section>)/g,
      (_m, open: string, cards: string, close: string) =>
        open + (cards.match(/<a [^>]*class="rp-card">[\s\S]*?<\/a>/g) ?? []).sort().join("") + close);
    const post = async (site: Site, c: Caller, urlPath: string, body: unknown): Promise<string> => {
      const r = await send(sites[site].port, "POST", urlPath, headersFor(site, c), body);
      await settle();
      return `${r.status} ${stable(r.text)}`;
    };
    const qs = (q: Record<string, string>) => "?" + new URLSearchParams(q).toString();
    const honey = rid(1);
    const near = { lat: String(TRONDHEIM.lat), lng: String(TRONDHEIM.lng) };

    const entries: Entry[] = [
      // Rett fra Bonden
      { name: "rfb mcp lokal_search", kind: "mcp", freeText: true, ask: (c, t) => mcp("rfb", c, "lokal_search", { query: t ?? "honning Trondheim", limit: 10 }) },
      { name: "rfb mcp lokal_discover", kind: "mcp", ask: (c) => mcp("rfb", c, "lokal_discover", { categories: ["honey"], ...TRONDHEIM, maxDistanceKm: 30, limit: 10 }) },
      { name: "rfb mcp lokal_info", kind: "mcp", ask: (c) => mcp("rfb", c, "lokal_info", { agentId: honey }) },
      { name: "rfb mcp lokal_find_offers", kind: "mcp", ask: (c) => mcp("rfb", c, "lokal_find_offers", { items: ["honning"], ...TRONDHEIM, radius_km: 50 }) },
      { name: "rfb a2a message/send", kind: "a2a", freeText: true, ask: (c, t) => a2a("rfb", c, "message/send", say(t ?? "honning i Trondheim")) },
      { name: "rfb a2a agent/info", kind: "a2a", ask: (c) => a2a("rfb", c, "agent/info", { agentId: honey }) },
      { name: "rfb GET /api/marketplace/search", kind: "api", freeText: true, ask: (c, t) => get("rfb", c, "/api/marketplace/search" + qs({ q: t ?? "honning Trondheim" })) },
      { name: "rfb POST /api/marketplace/discover", kind: "api", ask: (c) => post("rfb", c, "/api/marketplace/discover", { categories: ["honey"], location: TRONDHEIM, maxDistanceKm: 30 }) },
      // The opt-in conversation: its answer lists only the conversation ids.
      { name: "rfb POST /api/marketplace/discover start_conversation", kind: "api", ask: (c) => post("rfb", c, "/api/marketplace/discover", { categories: ["honey"], location: TRONDHEIM, maxDistanceKm: 30, start_conversation: true }) },
      { name: "rfb GET /api/marketplace/catalog/offers", kind: "api", ask: (c) => get("rfb", c, "/api/marketplace/catalog/offers" + qs({ q: "honning", ...near, radius_km: "50" })) },
      { name: "rfb GET /api/marketplace/agents/:id/info", kind: "api", ask: (c) => get("rfb", c, `/api/marketplace/agents/${honey}/info`) },
      { name: "rfb GET /api/marketplace/agents/:id/vcard", kind: "api", ask: (c) => get("rfb", c, `/api/marketplace/agents/${honey}/vcard`) },
      { name: "rfb GET /sok", kind: "page", freeText: true, ask: (c, t) => get("rfb", c, "/sok" + qs({ q: t ?? "honning Trondheim" })) },
      { name: "rfb GET /produsent/:slug", kind: "page", ask: async (c) => sortedRelatedCards(await get("rfb", c, "/produsent/trondersk-birokt-telling")) },
      // Finn-tannlege
      { name: "dental mcp tannlege_search", kind: "mcp", ask: (c) => mcp("dental", c, "tannlege_search", { query: "tannlege i Oslo", limit: 10 }) },
      { name: "dental mcp tannlege_info", kind: "mcp", ask: (c) => mcp("dental", c, "tannlege_info", { org_nr: "912345678" }) },
      { name: "dental a2a message/send", kind: "a2a", ask: (c) => a2a("dental", c, "message/send", say("tannlege i Oslo")) },
      { name: "dental GET /sok", kind: "page", ask: (c) => get("dental", c, "/sok" + qs({ q: "tannlege i Oslo" })) },
      { name: "dental GET /api/tannlege/agents", kind: "api", ask: (c) => get("dental", c, "/api/tannlege/agents" + qs({ q: "Oslo" })) },
      { name: "dental GET /api/tannlege/discover", kind: "api", ask: (c) => get("dental", c, "/api/tannlege/discover" + qs({ fylke: "Oslo" })) },
      { name: "dental GET /klinikk/id/:id", kind: "page", ask: (c) => get("dental", c, `/klinikk/id/${clinicId}`) },
      // Opplevagent
      { name: "oa mcp discover_experiences", kind: "mcp", ask: (c) => mcp("oa", c, "discover_experiences", { query: "nordlys Tromsø", limit: 10 }) },
      { name: "oa mcp get_experience", kind: "mcp", ask: (c) => mcp("oa", c, "get_experience", { id: experienceId }) },
      { name: "oa mcp discover_gardssalg", kind: "mcp", ask: (c) => mcp("oa", c, "discover_gardssalg", { query: "sideri" }) },
      { name: "oa a2a message/send", kind: "a2a", ask: (c) => a2a("oa", c, "message/send", say("nordlys i Tromsø")) },
      { name: "oa GET /sok", kind: "page", ask: (c) => get("oa", c, "/sok" + qs({ q: "nordlys" })) },
      { name: "oa GET /api/opplevelser/discover", kind: "api", ask: (c) => get("oa", c, "/api/opplevelser/discover" + qs({ kommune: "Tromsø" })) },
      { name: "oa GET /opplevelse/:slug", kind: "page", ask: (c) => get("oa", c, `/opplevelse/${encodeURIComponent(experienceSlug)}`) },
    ];
    return { db: rfb.db, entries, restore };
  } catch (err) {
    await restore();
    throw err;
  }
}

// ─── B1 ───────────────────────────────────────────────────────────────────

type Deltas = Record<string, Record<string, Partial<Counters>>>;

/**
 * Per entry and external caller (EXTERNAL), what one call changes in the
 * counters, on fresh fixtures. Uses only what main has, so main's deltas
 * are captured with it (--print).
 */
export async function externalDeltas(): Promise<Deltas> {
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  const fx = await enter();
  try {
    const out: Deltas = {};
    for (const entry of fx.entries) {
      for (const [label, caller] of Object.entries(EXTERNAL)) {
        const before = readCounters(fx.db);
        await entry.ask(caller);
        (out[entry.name] ??= {})[label] = changed(before, readCounters(fx.db));
      }
    }
    return out;
  } finally {
    await fx.restore();
    console.log = prevLog;
  }
}

const B1_FIXTURE = path.join(__dirname, "../../tests/fixtures/intern-trafikk-i-z-main.json");

// ─── Tests ────────────────────────────────────────────────────────────────

export async function runInternTrafikkTellesIkkeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** Two answers: the same, or where they first differ. */
  function assertSameAnswer(actual: string, expected: string, label: string): void {
    if (actual === expected) return assertTrue(true, label);
    let i = 0;
    while (actual[i] === expected[i]) i++;
    assertTrue(false,
      `${label} (differs at ${i}: expected …${expected.slice(Math.max(0, i - 60), i + 80)}…, got …${actual.slice(Math.max(0, i - 60), i + 80)}…)`);
  }

  // ══ K  the rules ═════════════════════════════════════════════════════════
  {
    const internal = require("../services/internal-traffic") as typeof import("../services/internal-traffic");
    const conversations = require("../services/conversation-service") as typeof import("../services/conversation-service");
    const analytics = require("../services/analytics-service") as typeof import("../services/analytics-service");
    const { searchTrafficClass, searchCountable } = require("../services/search-tracking") as typeof import("../services/search-tracking");
    const meta = (headers: Record<string, string>) => internal.buildRequestMeta({ headers });
    const restoreAdminKey = ensureAdminKey();
    try {
      assertTrue(conversations.isInternalTraffic === internal.isInternalTraffic && conversations.buildRequestMeta === internal.buildRequestMeta,
        "K1 conversation-service re-exports the rules of internal-traffic.ts (its importers are unchanged)");
      for (const ua of ["session-lane-verify/1.0 (read-only)", "session-lane-verify (read-only)", "Session-Lane-Verify/2.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0 Safari/537.36 session-lane-verify"]) {
        assertTrue(internal.isInternalTraffic(meta({ "user-agent": ua })), `K2 «${ua}» is our own traffic (the new marker, any case)`);
      }
      for (const ua of ["RFB-ContactVerifier/1.0", "rfb-session-lane-verify/1.0 (read-only)", "loop-dispatcher", "lokal-agent-verifier/2"]) {
        assertTrue(internal.isInternalTraffic(meta({ "user-agent": ua })), `K2 «${ua}» is still our own traffic`);
      }
      const externalUas = [AI_ASSISTANT_UA, BROWSER_UA, "curl/8.5.0", "python-requests/2.31", "node-fetch/2.6.7", "openai-mcp/1.0.0",
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "session-lane/1.0", "lane-verify", ""];
      for (const ua of externalUas) {
        assertTrue(!internal.isInternalTraffic(meta({ "user-agent": ua })), `K2 «${ua}» is still not our own traffic`);
      }

      const req = (headers: Record<string, string>) => ({ headers }) as any;
      assertTrue(analytics.isOwnerRequest(req({ "user-agent": "session-lane-verify/1.0 (read-only)" })),
        "K3 isOwnerRequest: the session lane's UA is our own traffic in the analytics tables too");
      assertTrue(analytics.isOwnerRequest(req({ "user-agent": AI_ASSISTANT_UA, "x-admin-key": currentAdminKey() })),
        "K3 isOwnerRequest: a valid X-Admin-Key is our own traffic");
      assertTrue(!analytics.isOwnerRequest(req({ "user-agent": AI_ASSISTANT_UA, "x-admin-key": "wrong-key" })),
        "K3 isOwnerRequest: a wrong X-Admin-Key is not");
      assertTrue(analytics.isOwnerRequest(req({ "user-agent": "loop-dispatcher/1.0" })) && analytics.isOwnerRequest(req({ "user-agent": "fleet-runner" })),
        "K3 isOwnerRequest: the other internal markers too (loop-dispatcher, fleet-runner)");
      assertTrue(["curl/8.5.0", "python-requests/2.31", "node-fetch/2.6.7", "Lokal-Enricher/1.0", "RFB-HealthCheck"].every((ua) => analytics.isOwnerRequest(req({ "user-agent": ua }))) &&
        analytics.isOwnerRequest(req({ "user-agent": BROWSER_UA, cookie: "_rfb_owner=1" })),
        "K3 isOwnerRequest: its own list (scripts, curl, the owner cookie) is as before");
      assertTrue([AI_ASSISTANT_UA, BROWSER_UA, "openai-mcp/1.0.0", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ""]
        .every((ua) => !analytics.isOwnerRequest(req({ "user-agent": ua }))), "K3 isOwnerRequest: people, AI assistants and crawlers are not");

      const cls = (headers: Record<string, string>, extra: { text?: string; clientName?: string; structured?: boolean } = {}) =>
        searchTrafficClass({ meta: meta(headers), ...extra });
      assertEq([cls({ "user-agent": "session-lane-verify/1.0 (read-only)" }, { text: "honning Trondheim" }),
        cls({ "user-agent": AI_ASSISTANT_UA, "x-admin-key": currentAdminKey() }, { text: "honning" }),
        cls({ "user-agent": BROWSER_UA, cookie: "_rfb_owner=1" }, { text: "honning" }),
        cls({ "user-agent": AI_ASSISTANT_UA }, { text: "honning", clientName: "session-lane-verify" }),
        cls({ "user-agent": "rfb-session-lane-verify/1.0" })],
        ["internal", "internal", "internal", "internal", "internal"],
        "K4 searchTrafficClass: our own traffic by UA, admin key, owner cookie or MCP client name is 'internal'");
      assertEq([cls({ "user-agent": "agentprobe/0.1.0 (+https://agentprobe.org/)" }, { text: "honning" }),
        cls({ "user-agent": AI_ASSISTANT_UA }, { text: "honning", clientName: "glama-inspector" }),
        cls({ "user-agent": "mcpbeat/1.0" }), cls({ "user-agent": "UptimeRobot/2.0" }),
        cls({ "user-agent": BROWSER_UA }, { text: "Reply with the single word OK and take no other action" }),
        cls({ "user-agent": BROWSER_UA }, { text: '{"implant":"x"}' })],
        ["probe", "probe", "probe", "probe", "probe", "probe"],
        "K4 searchTrafficClass: catalogue probes and monitors (client name or UA) and the A2A probe rules are 'probe'");
      assertEq([cls({ "user-agent": BROWSER_UA }, { text: "honning 0x1234567890abcdef1234567890abcdef12345678" }),
        cls({ "user-agent": "ziwei-implant/1.0" }, { text: "honning" }),
        cls({ "user-agent": BROWSER_UA }, { text: JSON.stringify({ categories: ["honey"], note: "token=USDC" }), structured: true })],
        ["spam", "spam", "spam"], "K4 searchTrafficClass: the A2A spam rules on text and UA are 'spam', also in a structured query");
      assertEq(cls({ "user-agent": BROWSER_UA }, { text: JSON.stringify({ categories: ["honey"], extra: 1 }), structured: true }), "external",
        "K4 a structured query sent as JSON is no «JSON typed as text» probe");
      for (const ua of externalUas) {
        assertEq([cls({ "user-agent": ua }, { text: "honning nær Trondheim" }), searchCountable({ meta: meta({ "user-agent": ua }), text: "Hvor kan jeg kjøpe egg i Bergen?" })],
          ["external", true], `K4 «${ua || "(no UA)"}» with an ordinary search is 'external' and counts (as before)`);
      }
      assertTrue(!searchCountable({ meta: meta({ "user-agent": "session-lane-verify/1.0 (read-only)" }), text: "honning" }) &&
        !searchCountable({ meta: meta({ "user-agent": "agentprobe/0.1.0" }) }) &&
        !searchCountable({ meta: meta({ "user-agent": BROWSER_UA }), text: "0x1234567890abcdef1234567890abcdef12345678" }),
        "K4 searchCountable is searchTrafficClass() === 'external'");
      assertEq(searchTrafficClass({ meta: {} }), "external", "K4 an empty request (no headers) is 'external', as buildRequestMeta's {}");
    } finally {
      restoreAdminKey();
    }
  }

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };
  let fx: Fixture | null = null;
  try {
    fx = await enter();
    const db = fx.db;
    const main = JSON.parse(fs.readFileSync(B1_FIXTURE, "utf8")) as { deltas: Deltas };
    assertEq(fx.entries.map((e) => e.name).sort(), Object.keys(main.deltas).sort(), "B1 setup: the fixture covers every entry driven here");
    const kinds = new Set(fx.entries.map((e) => `${e.name.split(" ")[0]} ${e.kind}`));
    assertEq(["rfb", "dental", "oa"].flatMap((p) => ["mcp", "a2a", "api", "page"].map((k) => `${p} ${k}`)).filter((k) => !kinds.has(k)), [],
      "map: every platform has MCP, A2A, REST and page entries");

    for (const entry of fx.entries) {
      // Some pages show counters (a profile's «Med i AI-svar», its AI-agent
      // lookups), which every external call raises. So each external call
      // comes right after the calls of ours that must get its answer: those
      // change nothing, so all of them see the same state.
      for (const [extLabel, extCaller] of Object.entries(EXTERNAL)) {
        // ══ I  our own traffic: no counter changes ═══════════════════════
        const internalAnswers: Record<string, string> = {};
        for (const [label, caller] of Object.entries(INTERNAL).filter(([, c]) => c.like === extLabel)) {
          const before = readCounters(db);
          internalAnswers[label] = await entry.ask(caller);
          assertEq(changed(before, readCounters(db)), {}, `I ${entry.name}, ${label}: no counter changes`);
        }
        if (entry.kind === "mcp" && extCaller.ua === AI_ASSISTANT_UA) {
          // Our own MCP client name, from an ordinary UA: deliver() and the discovery counters read it.
          const before = readCounters(db);
          internalAnswers["MCP client session-lane-verify"] = await entry.ask({ ua: AI_ASSISTANT_UA, clientName: "session-lane-verify" });
          const d = changed(before, readCounters(db));
          assertEq([d.discoveryCount ?? 0, d.timesDiscovered ?? 0, d.aiDeliveries ?? 0], [0, 0, 0],
            `I ${entry.name}, MCP client session-lane-verify: no discovery counter and no «Med i AI-svar»`);
        }

        // ══ B1  the external call: main's deltas ═════════════════════════
        const before = readCounters(db);
        const answer = await entry.ask(extCaller);
        assertEq(changed(before, readCounters(db)), main.deltas[entry.name]?.[extLabel], `B1 ${entry.name}, ${extLabel}: the counters change as on main`);
        assertTrue(/^2\d\d /.test(answer), `I setup: ${entry.name} answers ${extLabel} (${answer.slice(0, 120).replace(/\s+/g, " ")})`);

        // ══ I  …and the answer the external call gets ════════════════════
        for (const [label, internalAnswer] of Object.entries(internalAnswers)) {
          assertSameAnswer(internalAnswer, answer, `I ${entry.name}, ${label}: the answer an external call gets (${extLabel})`);
        }
      }
      assertTrue(Object.values(main.deltas[entry.name] ?? {}).some((d) => Object.keys(d).length > 0),
        `B1 ${entry.name}: an external call changes at least one counter (so I's «no change» is not empty)`);

      // ══ P  probes and spam ══════════════════════════════════════════════
      for (const [label, caller] of Object.entries(PROBES)) {
        if (caller.mcpOnly && entry.kind !== "mcp") continue;
        if (caller.text && !entry.freeText) continue;
        const before = readCounters(db);
        await entry.ask(caller, caller.text);
        const d = changed(before, readCounters(db));
        const untouched = caller.untouched(entry);
        assertEq(untouched.filter((k) => d[k] !== undefined), [], `P ${entry.name}, ${label}: leaves ${untouched.join(", ")} alone`);
      }
    }

    // The B1 deltas say what the map says each entry counts.
    const d = (entry: string) => main.deltas[entry]?.["AI assistant (ChatGPT-User)"] ?? {};
    for (const entry of ["rfb mcp lokal_search", "rfb mcp lokal_discover", "rfb GET /api/marketplace/search", "rfb POST /api/marketplace/discover", "rfb GET /sok", "rfb a2a message/send"]) {
      assertTrue((d(entry).timesDiscovered ?? 0) > 0 && (d(entry).discoveryCount ?? 0) > 0, `B1 map: ${entry} raises the discovery counters for an external caller`);
    }
    for (const entry of fx.entries.filter((e) => e.kind === "mcp")) {
      assertTrue((d(entry.name).aiLookups ?? 0) === 1 && (d(entry.name).aiDeliveries ?? 0) > 0, `B1 map: ${entry.name} is one AI lookup and «Med i AI-svar» for an external caller`);
    }
    for (const entry of fx.entries.filter((e) => e.kind === "page")) {
      assertTrue((d(entry.name).pageViews ?? 0) === 1, `B1 map: ${entry.name} is one page view for an external caller`);
    }
    for (const entry of ["rfb a2a agent/info", "rfb GET /api/marketplace/agents/:id/info", "rfb GET /api/marketplace/agents/:id/vcard"]) {
      assertTrue((d(entry).interactions ?? 0) === 1, `B1 map: ${entry} is one interactions row (a view) for an external caller`);
    }
    const started = d("rfb POST /api/marketplace/discover start_conversation");
    assertTrue((started.conversations ?? 0) > 0 && (started.timesContacted ?? 0) > 0,
      "B1 map: POST /api/marketplace/discover with start_conversation starts countable conversations for an external caller");
  } catch (err: any) {
    failed++;
    failures.push("intern-trafikk-telles-ikke: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (fx) await fx.restore();
    console.log = prevLog;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (process.argv.includes("--print")) {
    // B1's deltas for the fixture (see the header).
    externalDeltas().then((deltas) => {
      console.log(JSON.stringify({ deltas }, null, 2));
      process.exit(0);
    });
  } else {
    runInternTrafikkTellesIkkeTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      for (const f of s.failures) console.log(f);
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
