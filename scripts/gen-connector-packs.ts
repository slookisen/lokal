/**
 * gen-connector-packs.ts — the Claude directory packs, generated from the code.
 * A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S6.
 *
 * Writes <vertical>-connectors-prep/README.md and claude-directory/{listing,
 * portal-answers,test-instructions}.md for RFB, Opplevagent and Finn-tannlege.
 * Every fact is read, not typed (the sources are listed under "How this pack
 * is made" in renderPack()); the prose and the rows code cannot tell are in
 * PACKS. The catalog size is the floor in distribution/catalog-claims.json,
 * never a live figure, since listing text only changes by hand in the portal.
 * No clock is read: the same inputs give byte-identical files, which
 * src/routes/connector-packs-fresh.test.ts compares against.
 *
 *   npx tsx scripts/gen-connector-packs.ts                  write the packs
 *   npx tsx scripts/gen-connector-packs.ts --check          exit 1 if a pack on disk is stale
 *   npx tsx scripts/gen-connector-packs.ts --verify-floors  compare the floors with /health "catalog"
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import * as ts from "typescript";

import { BRAND_ENTITIES, type BrandEntity } from "../src/config/brand-entities";
import type { CatalogVertical } from "../src/services/honest-count";
import { registeredMcpToolDefinitions, type McpToolDefinition } from "../src/services/mcp-tool-manifest";

export const ROOT = path.resolve(__dirname, "..");
export const GENERATOR = "scripts/gen-connector-packs.ts";
export const PORTAL_URL = "https://claude.ai/directory/manage";
const PUBLISH_DOC = "https://claude.com/docs/directory/publish";
const SUBMIT_DOC = "https://claude.com/docs/connectors/building/submission";
const CHECKLIST_DOC = "https://claude.com/docs/connectors/building/review-criteria";
const DIRECTORY_TERMS = "https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms";
const DIRECTORY_POLICY = "https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy";
const DEV_REQUEST = "A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker";
/** When the portal facts above (who can submit, steps, limits) were read from the docs. */
const DOCS_READ = "2026-10-17";
/** When the hand-kept prerequisite rows were last checked. */
const RECORDED = "2026-10-17";

/** Submission order (RFB first). */
export const PACK_VERTICALS: readonly CatalogVertical[] = ["rfb", "experiences", "dental"];

/** The pack files, relative to the vertical's folder. */
export const PACK_FILES = ["README.md", "claude-directory/listing.md", "claude-directory/portal-answers.md", "claude-directory/test-instructions.md"] as const;

/** Portal Listing-step limits (submission docs). */
export const LIMITS = { name: 100, oneLiner: 200, description: 2000 } as const;

/**
 * Description wording the directory rejects as prompt injection ("describe what
 * the tool does, and don't tell Claude how to behave"). Same patterns as the
 * lint planned in A2A dev-request 2026-10-16-mcp-beskrivelser-intensjonsord-og-lint (S6).
 */
export const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /\bALWAYS (use|call)\b/i,
  /\bUSE THIS (TOOL|FOR)\b/,
  /\bMUST (use|call)\b/i,
  /\b(prefer|instead of) (other|any other) tools?\b/i,
];

/** distribution/catalog-claims.json keys its floors (and parseClaims() its claims) by noun group, not vertical id. */
export const FLOOR_KEY: Readonly<Record<CatalogVertical, string>> = { rfb: "rfb", dental: "dental", experiences: "opplevelser" };

/** serverInfo fields a client can show besides name and version (MCP Implementation). */
export const SERVER_INFO_FIELDS = ["title", "description", "websiteUrl"] as const;

/**
 * What every MCP call leaves behind, in all three verticals: the row
 * src/services/mcp-usage-logger.ts writes, pruned with the other analytics
 * after RFB_AUTO_PRUNE_DAYS (default 60, src/index.ts). As the privacy pages say.
 */
const CALL_LOG =
  "Every call is logged with the tool name, the protocol, the response time, the client's name and version, " +
  "the caller's full User-Agent string (stored as sent, not hashed) and a salted, truncated hash of the IP address " +
  "(never the full address), to see which AI clients use the service. That log is deleted automatically after 60 days.";

export type PrereqStatus = "done" | "open" | "waiting";

export interface Prerequisite {
  item: string;
  status: PrereqStatus;
  detail: string;
  owner: string;
  /** "code": computed from the code and files; "recorded": kept by hand in PACKS. */
  source: "code" | "recorded";
}

export interface PackSpec {
  /** Folder under the repo root, and the permanent listing slug. */
  dir: string;
  slug: string;
  oneLiner: string;
  /** Description paragraphs; `floor` is the formatted catalog floor ("1,500"). */
  description: (floor: string) => readonly string[];
  categories: readonly string[];
  /** Repo-relative path of the square PNG to upload; null while none exists. */
  icon: string | null;
  screenshots: ScreenshotSpec | null;
  /** The route file whose `new McpServer(...)` must send instructions and SERVER_INFO_FIELDS, and who adds them. */
  serverSetup: { routeFile: string; owner: string } | null;
  useCases: readonly string[];
  /** Where the data comes from (Data handling and first-party API answers). */
  ownApi: string;
  authRationale: string;
  /** What the tools receive and pass on, and what they store beyond CALL_LOG (null: nothing). */
  dataHandling: string;
  dataStored: string | null;
  healthData: string;
  financial: string;
  /** Every brand example prompt → the tool it usually exercises; extra prompts for tool coverage. */
  reviewerTools: Readonly<Record<string, string>>;
  extraPrompts: ReadonlyArray<{ prompt: string; tool: string }>;
  /** What each write tool really does. Every write tool must have one. */
  writeToolNotes: Readonly<Record<string, string>>;
  /** Who fixes a failing derived row, and why a description fix waits (null: nothing gates it). */
  owners: { descriptions: string; terms: string; docs: string; icon: string; screenshots: string };
  descriptionsGate: string | null;
  recordedPrerequisites: ReadonlyArray<Omit<Prerequisite, "source">>;
  caveats: readonly string[];
  /** README rows for the folder's other contents ([path, what it is]), and lines on paths that are not the directory. */
  otherContents: ReadonlyArray<readonly [string, string]>;
  notADirectoryPath: readonly string[];
}

/** MCP App carousel screenshots: the PNGs in carousel order, their prompts file, and the card templates they show. */
export interface ScreenshotSpec {
  files: readonly string[];
  prompts: string;
  templates: { module: string; exports: readonly string[] };
  /** When the PNGs were last rendered, and the md5 of the templates then (cardTemplatesMd5()). */
  rendered: { date: string; commit: string; templatesMd5: string };
  /** When and how to render them again. */
  renderAfter: string;
  renderCommand: string;
}

/** Table placeholder: no value, or nobody to act. */
const DASH = "—";

export const PACKS: Readonly<Record<CatalogVertical, PackSpec>> = {
  rfb: {
    dir: "rfb-connectors-prep",
    slug: "rett-fra-bonden",
    oneLiner: "Find Norwegian farms, farm shops and food producers by place or product, and send a pickup order straight to the producer.",
    description: (floor) => [
      `Rett fra Bonden ("Straight from the Farmer") connects you with small-scale food producers across Norway. Search more than ${floor} farms, farm shops, REKO rings, farmers' markets and cooperatives by place, product or category: cheese, meat, vegetables, honey, fish, baked goods, drinks and other farm-made food.`,
      "Results carry what you need to buy: contact details, opening hours, the products a producer lists and certifications such as Debio organic. Prices appear only where the producer has written them into the listing. You can see which networks a producer belongs to (Bondens marked, Hanen), find upcoming farmers' market days, and turn a shopping list into the nearest producers for each item.",
      "You can also put together a pickup order: build a cart and send it. Producers who have opted in to orders through the platform receive it by e-mail and confirm or decline; for the others you get their contact details instead. Nothing is paid in the conversation: you pay the producer when you collect.",
      "Useful when you travel in Norway and want local food nearby, plan a farm-shop visit, source Norwegian ingredients, or want to buy closer to the source. The catalogue covers Norway only.",
    ],
    categories: ["Shopping", "Food & drink", "Travel"],
    icon: "rfb-connectors-prep/assets/rfb-square-512.png",
    screenshots: null,
    serverSetup: null,
    useCases: [
      "Find local food near where you are in Norway, with opening hours and contact details.",
      "Look for a specific product (lamb, organic cheese, honey) in a region.",
      "Check certifications such as Debio organic before buying.",
      "Find upcoming Bondens marked farmers' market days.",
      "Turn a shopping list into the nearest producers for each item.",
      "Put together a pickup order from one or more producers.",
    ],
    ownApi: "Our own: the server reads Rett fra Bonden's own producer catalogue on the same domain. Place-name lookups can fall back to Kartverket's public place-name service.",
    authRationale: "The server serves public directory data about Norwegian food producers. There are no user accounts, so there is nothing to sign in to. The write tools build an anonymous cart and send pickup orders; they take no credentials and no payment details.",
    dataHandling: "The tools receive only what a question needs: a search term, a place, a category or coordinates, and for a pickup order the products chosen. Contact details the user gives are passed to an ordering producer only when the user consents to it (contact_consent).",
    dataStored: "A cart stores the products and producers chosen and a buyer_ref token, and is valid for 7 days. Contact details sent with an order (name, e-mail, phone, note) are stored with the cart and each order; the privacy policy says how long they are kept.",
    healthData: "No. The connector serves food-producer directory data and asks for no health information.",
    financial: "No money moves through the connector. A pickup order is a request to collect goods; the user pays the producer at pickup, outside Claude and outside this platform. No card or bank details are asked for.",
    reviewerTools: {
      "Which farms in Innlandet sell lamb?": "lokal_search",
      "What organic cheese producers are there in Norway?": "lokal_search",
      "Where can I buy reindeer meat in Finnmark?": "lokal_search",
    },
    extraPrompts: [{ prompt: "When is the next Bondens marked in Oslo?", tool: "lokal_bm_next_markets" }],
    writeToolNotes: {
      lokal_cart_create: "Creates an empty anonymous cart and returns its id and a buyer_ref token. Nothing leaves the platform.",
      lokal_cart_add_item: "Adds a product to that cart or changes its quantity (the overwrite is why it is marked destructive). Nothing leaves the platform.",
      lokal_cart_submit: "Sends a real pickup order by e-mail to each producer in the cart who has opted in to orders through the platform; for the others it returns contact details. No payment.",
    },
    owners: { descriptions: "2026-10-16-mcp-beskrivelser-intensjonsord-og-lint (S6)", terms: DASH, docs: DASH, icon: DASH, screenshots: DASH },
    descriptionsGate: "The fix waits for OpenAI's decision on the RFB ChatGPT app: tool metadata stays frozen while OpenAI reviews it (Daniel reports the decision).",
    recordedPrerequisites: [],
    caveats: [
      "Prices: most producers list products without a price, and the tools say so. Do not describe the connector as a price comparison.",
      "Prepayment: production runs with PAYMENTS_ENABLED unset, and the generator reads the tools that way. If it is switched on (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect), lokal_cart_submit's description and the financial-transactions answer change: update `productionToolDefinitions()` and `PACKS` in the generator, regenerate this pack and answer again before submitting.",
    ],
    otherContents: [["assets/rfb-square-512.png", "The icon to upload: square, full-bleed, no rounded corners (clients crop it themselves)."]],
    notADirectoryPath: [
      "Desktop extension (MCPB): the directory no longer accepts local servers packaged as MCPB. `mcp-server/lokal-mcp.mcpb` and the npm package `lokal-mcp` still work for manual install, but they are not a directory submission.",
      "ChatGPT app: a separate submission to OpenAI (repo root `chatgpt-app-submission.json`), not covered here.",
    ],
  },

  experiences: {
    dir: "opplevagent-connectors-prep",
    slug: "opplevagent",
    oneLiner: "Find things to do in Norway, from guided tours to food and nature experiences, and send a visit request to farm-sale drink producers.",
    description: (floor) => [
      `Opplevagent is a curated guide to experiences and activities in Norway. Search more than ${floor} experiences by county, category, season, weather, indoor or outdoor, group size, price and duration, or describe what you want in your own words: "what can we do in Troms in winter?" works as it is.`,
      "Every result comes from an active, Brreg-registered provider and carries location, description and, where there is one, a link to book with the provider. Opplevagent never takes payment: you book and pay with the provider.",
      "Opplevagent also covers gårdssalg: breweries, cideries, wineries, distilleries, meaderies and farm cafés that sell straight from the farm. You can find them near a place and send a visit request; it stays pending until the producer answers by e-mail, and you pay on arrival.",
      "Results can show as interactive cards: a list of experiences and a detail card for one. The catalogue covers Norway only.",
    ],
    categories: ["Travel", "Lifestyle", "Food & drink"],
    icon: "opplevagent-connectors-prep/assets/opplevagent-brand-512.png",
    screenshots: {
      files: [
        "opplevagent-connectors-prep/assets/01-experiences-list-troms.png",
        "opplevagent-connectors-prep/assets/02-experience-detail-arctic-explorer.png",
        "opplevagent-connectors-prep/assets/03-experience-detail-aurora-safari.png",
        "opplevagent-connectors-prep/assets/04-experiences-list-national-mix.png",
      ],
      prompts: "opplevagent-connectors-prep/assets/prompts.txt",
      templates: { module: "src/routes/opplevagent-widgets.ts", exports: ["EXPERIENCES_LIST_HTML", "EXPERIENCE_DETAIL_HTML"] },
      rendered: { date: "2026-09-24", commit: "e8a68a45", templatesMd5: "dd5d60567b45ad773981299969680d8b" },
      renderAfter: "After OpenAI's decision on the ChatGPT app (the cards can change in review)",
      renderCommand: "node opplevagent-connectors-prep/assets/generate-screenshots.js",
    },
    serverSetup: null,
    useCases: [
      "Plan what to do on a trip in Norway by place, season and weather.",
      "Find family-friendly or group activities within a budget.",
      "Find wildlife, outdoor, cultural and food experiences.",
      "Find breweries, cideries and other farm-sale drink producers near a place, and request a visit.",
    ],
    ownApi: "Our own: the server reads Opplevagent's own experience and gårdssalg catalogue on the same domain.",
    authRationale: "The server serves public data about experiences and farm-sale producers in Norway. There are no user accounts, so there is nothing to sign in to. The one write tool sends a visit request with the guest's own name and e-mail so the producer can answer; it takes no credentials and no payment details.",
    dataHandling: "The tools receive only what a question needs: a search text, a place, filters or coordinates. A visit request (book_gardssalg) passes the guest's name and e-mail, and an optional phone number and note, to the producer so the producer can answer.",
    dataStored: "Tool calls are also logged as agent requests: the tool, the filters and search terms sent (for a visit request, its booking reference), the AI client's name and its full User-Agent string, with no IP address; this log is not deleted automatically. A visit request stores the guest's name, e-mail, optional phone number, requested time, party size and note, and the guest gets a receipt with a status link. Visit requests are not deleted automatically; they are deleted on request, as the privacy policy describes.",
    healthData: "No. The connector serves experience and producer data and asks for no health information.",
    financial: "No money moves through the connector. Experiences are booked and paid with the provider; a gårdssalg visit is paid on arrival. No card or bank details are asked for.",
    reviewerTools: {
      "Hva kan vi finne på i Troms om vinteren?": "discover_experiences",
      "Find wildlife and animal experiences in Norway": "discover_experiences",
      "Finn gårdssalg og lokale drikkeprodusenter i Vestland": "discover_gardssalg",
    },
    extraPrompts: [{ prompt: "Hvilke kategorier med opplevelser finnes?", tool: "list_experience_categories" }],
    writeToolNotes: { book_gardssalg: "Sends a real visit request by e-mail to the producer, and a status link to the guest. It never confirms a booking: the producer answers. Only producers with live booking can be booked. No payment." },
    owners: { descriptions: "2026-10-16-mcp-beskrivelser-intensjonsord-og-lint (S7)", terms: DASH, docs: DASH, icon: DASH, screenshots: "G3-S6 of this dev-request (follow-up)" },
    descriptionsGate: "A fix waits for OpenAI's decision on the Opplevagent ChatGPT app: tool metadata stays frozen while OpenAI reviews it.",
    recordedPrerequisites: [
      { item: "Free-text search in discover_experiences (`query`)", status: "done", owner: "2026-10-16-opplevagent-mcp-fritekst-query",
        detail: "lokal#1089: the user's request goes in `query`, and a place search never returns an unfiltered all-Norway list." },
      { item: "OpenAI's decision on the Opplevagent ChatGPT app", status: "waiting", owner: "Daniel (OpenAI review)",
        detail: "Submit after it. Tool titles and first sentences (lint S7) and serverInfo title, websiteUrl and icons (G3-S5) change once OpenAI has decided, and the directory should review the final metadata. Daniel reports the decision." },
    ],
    caveats: ["book_gardssalg is a real write: a request e-mails the producer. Keep it out of demos with real producers."],
    otherContents: [
      ["assets/opplevagent-brand-512.png", "The icon to upload: Opplevagent's own mark, square, no rounded corners."],
      ["assets/0?-*.png", "MCP App carousel screenshots; the prompt for each is in `assets/prompts.txt` (see `assets/README.md`)."],
      ["chatgpt-app/", "The ChatGPT app submission. Frozen while OpenAI reviews it; not part of this pack."],
      ["claude-desktop/", "Deprecated: the MCPB desktop-extension path, kept as history."],
    ],
    notADirectoryPath: [
      "Desktop extension (MCPB): the directory no longer accepts local servers packaged as MCPB. `claude-desktop/` is kept as history only; do not submit `claude-desktop/manifest.json`.",
      "ChatGPT app: `chatgpt-app/` is a separate submission to OpenAI.",
    ],
  },

  // The dental text says no more than the service does (the independent check
  // of the directory prompt, 2026-10-19). What Helfo and emergency care mean is
  // DENTAL_MCP_INSTRUCTIONS (src/routes/dental-mcp.ts) and the /proveniens and
  // /vilkar pages; connector-packs-fresh.test.ts (k) keeps the old claims out.
  dental: {
    dir: "dental-connectors-prep",
    slug: "finn-tannlege",
    oneLiner: "Search dental clinics across Norway by place, specialty, Helfo direct billing and emergency care.",
    description: (floor) => [
      `Finn-tannlege is an independent directory of dental clinics in Norway: more than ${floor} clinics, from single-dentist practices to large clinics, in every county. It is not affiliated with any clinic chain, insurer or booking portal.`,
      "Search by place or specialty, and filter for clinics with a Helfo direct-billing agreement or emergency care. With direct billing, Helfo's share of a treatment that qualifies for support is settled with the clinic and you pay the rest; the agreement is read from the clinic's own website, not from a list kept by Helfo. Emergency care means an emergency duty (akuttvakt) with a recorded source, or a clinic that says it takes emergency patients. Every record carries the clinic's address, contact details and a profile page.",
      // The sources as src/services/dental-data-sources.ts names them (F2-S1 of
      // 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon); HPR is not one.
      // dental-sources-truth.test.ts keeps this sentence equal to that list.
      "The data comes from Brønnøysundregistrene, the clinics' own websites (AI-assisted extraction), Google Places, Kartverket and a one-time import from an online directory (May 2026).",
      "The connector is read-only and gives no dental advice. It tells you which clinics exist, what they offer and how to reach them; the clinical conversation belongs with the dentist.",
    ],
    categories: ["Health", "Reference"],
    // A copy of src/public/dental-favicon-512.png (2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S4).
    icon: "dental-connectors-prep/assets/finn-tannlege-square-512.png",
    screenshots: null,
    serverSetup: { routeFile: "src/routes/dental-mcp.ts", owner: "2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S4a)" },
    useCases: [
      "Find a dentist in a town or county.",
      "Find clinics with an emergency duty (akuttvakt) or that take emergency patients.",
      "Filter for clinics with a Helfo direct-billing agreement.",
      "Find a clinic with a specific specialty, such as orthodontics.",
      "Read one clinic's full record by organisation number.",
    ],
    ownApi: "Our own: the server reads Finn-tannlege's own clinic directory on the same domain.",
    authRationale: "The server is a public, read-only directory of Norwegian dental clinics. There are no user accounts and no write operations, so there is nothing to sign in to.",
    dataHandling: "The tools receive only search terms and filters: a place or county, a specialty, the Helfo and emergency-care flags, or a clinic's organisation number. They ask for no symptoms, patient records or identity.",
    dataStored: null,
    healthData: "No. The connector returns public business information about clinics (address, contact details, specialties, Helfo agreement, emergency care) and asks for no health information about the user.",
    financial: "No money moves through the connector. Whether a clinic has Helfo direct billing is only reported, as read automatically from the clinic's own website (not confirmed by Helfo). No card or bank details are asked for.",
    reviewerTools: {
      "Find a dentist in Bergen": "tannlege_search",
      "Which dental clinics in Oslo have a Helfo agreement?": "tannlege_search",
      "I need an emergency dentist in Rogaland": "tannlege_akutt",
    },
    extraPrompts: [{ prompt: "How many dental clinics are there in Norway, by county?", tool: "tannlege_stats" }],
    writeToolNotes: {},
    owners: {
      descriptions: "2026-10-16-tannlege-mcp-instrukser-og-klinikkort (S4a)",
      terms: "2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S5; Daniel approves the text)",
      docs: "G3-S4 of this dev-request (`/guide-tannlege-ai`)", icon: "2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S4)", screenshots: DASH,
    },
    descriptionsGate: null,
    recordedPrerequisites: [
      { item: "Natural-language search in tannlege_search (town, municipality, specialty, Helfo)", status: "done", owner: "2026-10-16-tannlege-sok-naturlig-sprak",
        detail: "lokal#1086, merged and live: the request goes in `query` as written, and `tolkning` shows how it was read. The example prompts must return clinics against production (G3-S4)." },
      { item: "Per-session rate limit on /mcp", status: "done", owner: "2026-10-16-mcp-rate-limit-dental-opplevagent-per-okt",
        detail: "lokal#1098: one quota per MCP session, so users behind one shared AI-platform IP do not share a bucket." },
      { item: "Name decision for Finn-tannlege", status: "done", owner: "Daniel",
        detail: "Daniel's decision 4=A (2026-10-17, A2A daniel-responses/2026-10-17-live-del-a-gjort-og-beslutninger-1-11.md): the name and the slug stay, and every text says the service is not affiliated with FINN.no (G3-S8). The listing description ends with that sentence. No paid PR with the name before the legal check (G3-J)." },
    ],
    caveats: [
      "tannlege_kjeder: the chain data was empty when last measured (chain_count 0 on 2026-08-24). Check tannlege_stats before showing chain comparison as a feature.",
      // A town in `fylke` goes through normaliseFylke() in the store: a town it
      // knows gives its county, any other gives nothing (dental-acute-filter.test.ts
      // M1b and M1c; connector-packs-fresh.test.ts k9 and k9b check both examples).
      "tannlege_akutt narrows by county (fylke) only: a town the server knows is read as the county it lies in, so «Bergen» lists the emergency clinics in all of Vestland. A town it does not know, such as «Sandvika», gives no results. For one town, tannlege_search reads both the place and the emergency wish from `query` (for example «emergency dentist Stavanger»), or takes `akutt: true` with the place in `query`.",
      // The advice is /vilkar section 3's (dental-seo.ts); connector-packs-fresh.test.ts k15 keeps them equal.
      "Emergency care says nothing about hours: the data has no out-of-hours times, and a clinic marked with emergency care may still be unable to see you now. Call the clinic before you go there; when it is closed, contact the out-of-hours medical service (legevakt) on 116 117 or the emergency dental service (tannlegevakt) where you live. tannlege_akutt's answer has advice on the municipal out-of-hours dental service (kommunal tannlegevakt).",
      "Place names with Ø: search did not case-fold Ø when last measured (2026-08-24). Keep Ø place names out of the reviewer prompts until lokal#1086 has landed and been checked.",
    ],
    otherContents: [["assets/finn-tannlege-square-512.png", "The icon to upload: the «Søket» mark (a tooth in a magnifier, white on teal), square, full-bleed, no rounded corners. The same file as the site's /favicon-512.png."]],
    notADirectoryPath: ["Desktop extension (MCPB): the directory no longer accepts local servers packaged as MCPB. The npm package `finn-tannlege-mcp` still works for manual install, but it is not a directory submission."],
  },
};

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface IconInfo { path: string; width: number; height: number; md5: string }

export interface PackInput {
  vertical: CatalogVertical;
  tools: readonly McpToolDefinition[];
  brand: Readonly<BrandEntity>;
  company: Readonly<BrandEntity>;
  /** Catalog floor (honest count rounded down to the hundred). */
  floor: number;
  icon: IconInfo | null;
  screenshots: readonly IconInfo[];
  /** md5 of the screenshots' card templates as they are now, and the serverSetup route file as read; null without. */
  screenshotTemplatesMd5: string | null;
  server: ServerConstruction | null;
  protocolVersions: readonly string[];
}

/** What a `new McpServer(serverInfo, options)` call sets: the serverInfo keys, and whether options set `instructions`. */
export interface ServerConstruction { info: string[]; instructions: boolean }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Size and md5 of a repo-relative PNG; throws when it is missing or not a PNG. */
export function pngInfo(rel: string): IconInfo {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${rel} is not a PNG`);
  }
  return {
    path: rel,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    md5: createHash("md5").update(buf).digest("hex"),
  };
}

/** The catalog floors, keyed by vertical id. */
export function readCatalogFloors(): Record<CatalogVertical, number> {
  const claims = JSON.parse(fs.readFileSync(path.join(ROOT, "distribution", "catalog-claims.json"), "utf8"));
  const out = {} as Record<CatalogVertical, number>;
  for (const v of PACK_VERTICALS) {
    const n = claims?.floors?.[FLOOR_KEY[v]];
    if (!Number.isInteger(n) || n <= 0) throw new Error(`distribution/catalog-claims.json has no floor for ${FLOOR_KEY[v]}`);
    out[v] = n;
  }
  return out;
}

/** md5 over the named string exports of a repo-relative module: the HTML of the card templates. */
export function cardTemplatesMd5(templates: ScreenshotSpec["templates"]): string {
  const mod = require(path.join(ROOT, templates.module)) as Record<string, unknown>;
  const h = createHash("md5");
  for (const name of templates.exports) {
    const html = mod[name];
    if (typeof html !== "string") throw new Error(`${templates.module} has no string export ${name}`);
    h.update(`${name}\0${html}\0`);
  }
  return h.digest("hex");
}

/**
 * Reads the one `new McpServer(...)` call in a route file with the TypeScript
 * parser, without running it: which serverInfo fields it sets and whether it
 * passes instructions. A property set to "", null or undefined counts as not
 * set. Throws when the file does not have exactly one such call, or when an
 * argument is not a plain object literal (G3-S5's config lookups may make it
 * one): then this function cannot tell, and must be extended rather than guess.
 */
export function readServerConstruction(rel: string, source = fs.readFileSync(path.join(ROOT, rel), "utf8")): ServerConstruction {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const calls: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "McpServer") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (calls.length !== 1) throw new Error(`${rel}: expected one new McpServer(...), found ${calls.length}`);
  const empty = (e: ts.Expression): boolean =>
    (ts.isStringLiteralLike(e) && e.text === "") || e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined");
  const keys = (arg: ts.Expression | undefined, what: string): string[] => {
    if (!arg) return [];
    if (!ts.isObjectLiteralExpression(arg)) throw new Error(`${rel}: the McpServer ${what} is not an object literal; extend readServerConstruction()`);
    return arg.properties.flatMap((p) => {
      if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        throw new Error(`${rel}: the McpServer ${what} has a spread or computed property; extend readServerConstruction()`);
      }
      return ts.isPropertyAssignment(p) && empty(p.initializer) ? [] : [p.name.text];
    });
  };
  const [info, options] = calls[0].arguments ?? [];
  return { info: keys(info, "serverInfo"), instructions: keys(options, "options").includes("instructions") };
}

/**
 * The tools as production registers them: with PAYMENTS_ENABLED unset (it
 * picks lokal_cart_submit's description), whatever the caller's environment,
 * which is restored afterwards. The CLI and the test read the same tools.
 */
export function productionToolDefinitions(vertical: CatalogVertical): McpToolDefinition[] {
  const prevPayments = process.env.PAYMENTS_ENABLED;
  delete process.env.PAYMENTS_ENABLED;
  try {
    return registeredMcpToolDefinitions(vertical);
  } finally {
    if (prevPayments !== undefined) process.env.PAYMENTS_ENABLED = prevPayments;
  }
}

export function gatherPackInput(vertical: CatalogVertical, floors = readCatalogFloors()): PackInput {
  const spec = PACKS[vertical];
  return {
    vertical,
    tools: productionToolDefinitions(vertical),
    brand: BRAND_ENTITIES[vertical],
    company: BRAND_ENTITIES.company,
    floor: floors[vertical],
    icon: spec.icon ? pngInfo(spec.icon) : null,
    screenshots: (spec.screenshots?.files ?? []).map(pngInfo),
    screenshotTemplatesMd5: spec.screenshots ? cardTemplatesMd5(spec.screenshots.templates) : null,
    server: spec.serverSetup ? readServerConstruction(spec.serverSetup.routeFile) : null,
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
  };
}

// ─── Derived facts ──────────────────────────────────────────────────────────

/** "1500" → "1,500" (no locale data involved). */
export function formatInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const isReadOnly = (t: McpToolDefinition): boolean => t.annotations.readOnlyHint === true;

/** Directive phrases in a tool description, as matched. */
export function directivePhrases(description: string): string[] {
  return DIRECTIVE_PATTERNS.map((re) => description.match(re)?.[0]).filter((m): m is string => !!m);
}

/** Tools whose annotations miss what the directory checklist requires. */
export function annotationGaps(tools: readonly McpToolDefinition[]): string[] {
  const gaps: string[] = [];
  for (const t of tools) {
    const missing: string[] = [];
    if (!t.title && !t.annotations.title) missing.push("title");
    if (typeof t.annotations.readOnlyHint !== "boolean") missing.push("readOnlyHint");
    if (!isReadOnly(t) && typeof t.annotations.destructiveHint !== "boolean") missing.push("destructiveHint");
    if (missing.length) gaps.push(`${t.name} (${missing.join(", ")})`);
  }
  return gaps;
}

export function prerequisites(spec: PackSpec, input: PackInput): Prerequisite[] {
  const { brand, tools } = input;
  const derived = (p: Omit<Prerequisite, "source">): Prerequisite => ({ ...p, source: "code" });
  const gaps = annotationGaps(tools);
  const directives = tools.map((t) => ({ name: t.name, phrases: directivePhrases(t.description) })).filter((d) => d.phrases.length > 0);
  const rows: Prerequisite[] = [
    derived({ item: "Every tool has a title and readOnlyHint/destructiveHint", status: gaps.length ? "open" : "done",
      detail: gaps.length ? `Missing: ${gaps.join("; ")}.` : `All ${tools.length} tools.`, owner: DASH }),
    derived({
      item: "Tool descriptions describe and never instruct Claude",
      status: directives.length ? (spec.descriptionsGate ? "waiting" : "open") : "done",
      detail: directives.length
        ? directives.map((d) => `\`${d.name}\`: ${d.phrases.map((p) => `«${p}»`).join(", ")}.`).join(" ") +
          (spec.descriptionsGate ? ` ${spec.descriptionsGate}` : "")
        : "No directive wording in any tool description.",
      owner: directives.length ? spec.owners.descriptions : DASH,
    }),
    derived({ item: "Privacy policy page", status: "done", detail: brand.privacyUrl, owner: DASH }),
    derived({ item: "Terms page", status: brand.termsUrl ? "done" : "open", owner: brand.termsUrl ? DASH : spec.owners.terms,
      detail: brand.termsUrl ?? "None yet (`termsUrl` is null in src/config/brand-entities.ts). The portal asks only for a privacy URL; a public terms page is still required before submission." }),
    derived({ item: "Public documentation page", status: brand.docsUrl ? "done" : "open", owner: brand.docsUrl ? DASH : spec.owners.docs,
      detail: brand.docsUrl ?? "None yet (`docsUrl` is null in src/config/brand-entities.ts). The checklist requires public documentation by the publish date." }),
    derived({
      item: "Square 512×512 PNG icon to upload",
      status: input.icon && input.icon.width === 512 && input.icon.height === 512 ? "done" : "open",
      detail: input.icon
        ? `\`${input.icon.path}\` (${input.icon.width}×${input.icon.height}, md5 \`${input.icon.md5}\`).`
        : `None yet: no icon file in \`${spec.dir}/assets/\`${brand.logoPng ? "" : ", and `logoPng` is null in src/config/brand-entities.ts"}.`,
      owner: input.icon ? DASH : spec.owners.icon,
    }),
  ];
  if (spec.screenshots) {
    const { prompts, templates, rendered, renderAfter, renderCommand } = spec.screenshots;
    const shots = input.screenshots;
    const shaped = shots.length >= 3 && shots.length <= 5 && shots.every((s) => s.width >= 1000);
    // A template change since the render means the PNGs no longer show the
    // live cards. Only the pinned md5 is printed, so further changes leave the pack as it is.
    const current = input.screenshotTemplatesMd5 === rendered.templatesMd5;
    const ok = shaped && current;
    rows.push(derived({
      item: "MCP App carousel screenshots (3–5 PNG, at least 1000 px wide, showing the live cards)",
      status: ok ? "done" : "open",
      detail: `${shots.length} PNG in \`${spec.dir}/assets/\`, widths ${shots.map((s) => s.width).join(", ")} px; prompts in \`${prompts}\`. ` +
        (current
          ? `Rendered ${rendered.date} (${rendered.commit}) from the card templates as they are now (\`${templates.module}\`, md5 \`${rendered.templatesMd5}\`).`
          : `Rendered ${rendered.date} (${rendered.commit}), but the card templates in \`${templates.module}\` have changed since ` +
            `(md5 \`${rendered.templatesMd5}\` when rendered), so the screenshots do not show the live cards. ${renderAfter}, ` +
            `render them again with \`${renderCommand}\`, check its mock data against the live tool output, then set \`rendered\` in \`PACKS\` to the new date, commit and md5 (\`cardTemplatesMd5()\`).`),
      owner: ok ? DASH : spec.owners.screenshots,
    }));
  }
  if (spec.serverSetup) {
    const server = input.server;
    if (!server) throw new Error(`pack ${input.vertical}: serverSetup is set but the input has no server construction`);
    const missing = [...(server.instructions ? [] : ["instructions"]), ...SERVER_INFO_FIELDS.filter((f) => !server.info.includes(f))];
    rows.push(derived({
      item: `MCP server instructions and serverInfo ${andList(SERVER_INFO_FIELDS)}`,
      status: missing.length ? "open" : "done",
      detail: `\`new McpServer(...)\` in \`${spec.serverSetup.routeFile}\` sets serverInfo ${server.info.map(code).join(", ") || "nothing"} ` +
        `and ${server.instructions ? "instructions" : "no instructions"}${missing.length ? `. Missing: ${missing.map(code).join(", ")}.` : "."}`,
      owner: missing.length ? spec.serverSetup.owner : DASH,
    }));
  }
  for (const p of spec.recordedPrerequisites) rows.push({ ...p, source: "recorded" });
  return rows;
}

// ─── Markdown helpers ───────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string): string => "`" + s + "`";
const fence = (s: string): string => "```\n" + s + "\n```";

/** First sentence for a table cell: like shortToolDescription(), but "e.g." and "i.e." do not end it. */
export function toolSummary(description: string, max = 220): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?(?<!\b(?:e\.g|i\.e))[.!?])(?=\s|$)/);
  const first = m ? m[1] : flat;
  return first.length <= max ? first : first.slice(0, max - 1).trimEnd() + "…";
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** "a", "a and b", "a, b and c". */
const andList = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));

const STATUS_LABEL: Record<PrereqStatus, string> = { done: "DONE", open: "OPEN", waiting: "WAITING" };

/** The readiness line. README.md has the table under it, portal-answers.md does not, so it says no «below» (S10 in the review of lokal#1178). */
function readiness(rows: readonly Prerequisite[]): string {
  const open = rows.filter((r) => r.status === "open").length;
  const waiting = rows.filter((r) => r.status === "waiting").length;
  if (!open && !waiting) return "**Ready to submit: yes.** Every prerequisite is done.";
  const parts = [open ? `${open} open` : "", waiting ? `${waiting} waiting` : ""].filter(Boolean).join(", ");
  return `**Ready to submit: no** (${parts}).`;
}

function prerequisiteTable(rows: readonly Prerequisite[]): string {
  return table(
    ["Prerequisite", "Status", "Detail", "Owner", "Source"],
    rows.map((r) => [r.item, `**${STATUS_LABEL[r.status]}**`, r.detail, r.owner, r.source === "code" ? "code" : `recorded ${RECORDED}`]),
  );
}

const generatedNote = (): string =>
  `<!-- Generated by ${GENERATOR} from the code. Do not edit by hand: change the sources and run \`npx tsx ${GENERATOR}\`. Checked by src/routes/connector-packs-fresh.test.ts. -->`;

const mcpUrl = (brand: Readonly<BrandEntity>): string => `${brand.url}/mcp`;

function toolCounts(tools: readonly McpToolDefinition[]): string {
  const ro = tools.filter(isReadOnly).length;
  const write = tools.length - ro;
  const destructive = tools.filter((t) => t.annotations.destructiveHint === true).length;
  if (!write) return `${tools.length} tools, all read-only`;
  return `${tools.length} tools: ${ro} read-only, ${write} write (${destructive} marked destructive)`;
}

function validate(spec: PackSpec, input: PackInput, name: string, description: string): void {
  const where = `pack ${input.vertical}`;
  if (name.length > LIMITS.name) throw new Error(`${where}: name is ${name.length} characters (limit ${LIMITS.name})`);
  if (spec.oneLiner.length > LIMITS.oneLiner) throw new Error(`${where}: one-liner is ${spec.oneLiner.length} characters (limit ${LIMITS.oneLiner})`);
  if (description.length > LIMITS.description) throw new Error(`${where}: description is ${description.length} characters (limit ${LIMITS.description})`);
  if (spec.categories.length < 1 || spec.categories.length > 5) throw new Error(`${where}: 1–5 categories`);
  const names = new Set(input.tools.map((t) => t.name));
  const queries = input.brand.exampleQueries;
  for (const q of queries) if (!spec.reviewerTools[q]) throw new Error(`${where}: example prompt "${q}" has no reviewerTools entry`);
  for (const [q, tool] of Object.entries(spec.reviewerTools)) {
    if (!queries.includes(q)) throw new Error(`${where}: reviewerTools prompt "${q}" is not in BRAND_ENTITIES.${input.vertical}.exampleQueries`);
    if (!names.has(tool)) throw new Error(`${where}: reviewerTools names unregistered tool ${tool}`);
  }
  for (const { tool } of spec.extraPrompts) if (!names.has(tool)) throw new Error(`${where}: extraPrompts names unregistered tool ${tool}`);
  const writeTools = input.tools.filter((t) => !isReadOnly(t)).map((t) => t.name);
  for (const t of writeTools) if (!spec.writeToolNotes[t]) throw new Error(`${where}: write tool ${t} has no writeToolNotes entry`);
  for (const t of Object.keys(spec.writeToolNotes)) {
    if (!writeTools.includes(t)) throw new Error(`${where}: writeToolNotes names ${t}, which is not a registered write tool`);
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** The four pack files for one vertical, keyed by path relative to the vertical's folder. */
export function renderPack(spec: PackSpec, input: PackInput): Record<(typeof PACK_FILES)[number], string> {
  const { brand, tools } = input;
  const name = brand.name;
  const floor = formatInt(input.floor);
  // G3-S8: a brand's disambiguation sentence (brand-entities.ts) closes the description, never leads it.
  const disambiguation = brand.disambiguation?.en;
  const paragraphs = [...spec.description(floor), ...(disambiguation ? [disambiguation] : [])];
  const description = paragraphs.join("\n\n");
  validate(spec, input, name, description);

  const rows = prerequisites(spec, input);
  const writeTools = tools.filter((t) => !isReadOnly(t));
  const readTools = tools.filter(isReadOnly);
  const prompts = [...brand.exampleQueries.map((q) => ({ prompt: q, tool: spec.reviewerTools[q] })), ...spec.extraPrompts];
  const lintRow = rows.find((r) => r.item.startsWith("Tool descriptions"))!;
  const docsRow = rows.find((r) => r.item === "Public documentation page")!;
  const shotsRow = rows.find((r) => r.item.startsWith("MCP App carousel screenshots"));
  const titleDiffs = tools.filter((t) => t.annotations.title && t.title && t.annotations.title !== t.title);
  const recordedPrs = [...new Set(spec.recordedPrerequisites.flatMap((p) => `${p.item} ${p.detail}`.match(/\blokal#\d+/g) ?? []))];

  // ── README ──
  const readme = [
    generatedNote(),
    "",
    `# ${name} — Claude directory pack`,
    "",
    `Submission pack for listing the remote MCP server ${code(mcpUrl(brand))} in the Claude connectors directory.`,
    "",
    "## Where and who",
    "",
    `- **Portal:** ${PORTAL_URL} → **Submit new** → **MCP connector**.`,
    `- **Who:** Daniel, from his own Claude Pro or Max account. Any paid plan can submit, and on Pro or Max you submit from your own account with no organization or role to set up (${PUBLISH_DOC}, read ${DOCS_READ}).`,
    `- **Order:** ${PACK_VERTICALS.map((v) => BRAND_ENTITIES[v].name).join(", then ")}.`,
    "",
    "## Prerequisites before submission",
    "",
    readiness(rows),
    "",
    prerequisiteTable(rows),
    "",
    `The directory reviews against its connector checklist: ${CHECKLIST_DOC}.`,
    "",
    `Rows with source "code" are computed when the pack is generated.` + (spec.recordedPrerequisites.length
      ? ` Rows with source "recorded" are kept by hand in ${code(GENERATOR)} (\`PACKS\`), and no test checks them against the code or GitHub` +
        (recordedPrs.length ? `: the pull requests they cite (${andList(recordedPrs)}) can be merged or closed while the row stays as it is.` : ".") +
        " Update the row there and regenerate when its status changes."
      : ""),
    "",
    "## Contents",
    "",
    table(["File", "What it is"], [
      ["`claude-directory/portal-answers.md`", "Every portal step, answered."],
      ["`claude-directory/listing.md`", "The Listing step: name, one-liner, description, categories, links, icon and slug."],
      ["`claude-directory/test-instructions.md`", "The Test & launch step: reviewer instructions and prompts."],
      ...spec.otherContents.map(([p, what]) => [code(p), what]),
    ]),
    "",
    "## How this pack is made",
    "",
    `This README and every file in \`claude-directory/\` are generated by ${code(GENERATOR)} from:`,
    "",
    "- the tools the live /mcp server registers (`registeredMcpToolDefinitions()` in src/services/mcp-tool-manifest.ts, with PAYMENTS_ENABLED unset as in production): names, titles, annotations and descriptions;",
    `- the brand entry in src/config/brand-entities.ts (\`BRAND_ENTITIES.${input.vertical}\`): name, URLs, support e-mail and example prompts${disambiguation ? ", and the sentence that ends the listing description (`disambiguation`)" : ""};`,
    "- the catalog floor in distribution/catalog-claims.json: the honest catalog count (`honestCatalogCount()`) rounded down to the hundred;",
    "- the protocol versions the MCP SDK supports (`SUPPORTED_PROTOCOL_VERSIONS` in @modelcontextprotocol/sdk), for the Connection step: an SDK upgrade can change them;",
    "- the icon and screenshot files themselves (size and md5);",
    ...(spec.screenshots ? [`- the card templates the screenshots show (${spec.screenshots.templates.exports.map(code).join(", ")} in ${spec.screenshots.templates.module}), by md5, against the md5 they were rendered from;`] : []),
    ...(spec.serverSetup ? [`- the \`new McpServer(...)\` call in ${spec.serverSetup.routeFile}, read with the TypeScript parser and not run: its serverInfo fields and whether it sends instructions;`] : []),
    "- the hand-kept prose and recorded rows in `PACKS`.",
    "",
    `src/routes/connector-packs-fresh.test.ts fails when a file here differs from what the generator writes. After a change to any of these, run \`npx tsx ${GENERATOR}\` and commit the result. \`--verify-floors\` compares the floors with the live honest counts.`,
    "",
    "## Not a directory path",
    "",
    ...spec.notADirectoryPath.map((l) => `- ${l}`),
    "",
    `Source: ${DEV_REQUEST}, G3-S6.`,
  ].join("\n");

  // ── listing.md ──
  const icon = input.icon;
  const listing = [
    generatedNote(),
    "",
    `# ${name} — listing`,
    "",
    "Paste-ready answers for the portal's **Listing** step. Character counts are computed on the exact text in each block.",
    "",
    `## Server name (limit ${LIMITS.name})`,
    "",
    fence(name),
    `${name.length} characters.`,
    "",
    `## One-liner (limit ${LIMITS.oneLiner})`,
    "",
    fence(spec.oneLiner),
    `${spec.oneLiner.length} characters.`,
    "",
    `## Description (limit ${formatInt(LIMITS.description)})`,
    "",
    fence(description),
    `${formatInt(description.length)} characters, blank lines between paragraphs included. Each paragraph is one line, so it pastes as it is.`,
    "",
    ...(disambiguation
      ? [`The last paragraph is \`BRAND_ENTITIES.${input.vertical}.disambiguation.en\` (src/config/brand-entities.ts). Keep it when the text is edited in the portal.`, ""]
      : []),
    `The catalog size is the floor in distribution/catalog-claims.json (${formatInt(input.floor)}), not a live figure: listing text is only changed by hand in the portal, and the floor stays true while the catalog grows.`,
    "",
    "## Categories (one to five)",
    "",
    ...spec.categories.map((c) => `- ${c}`),
    "",
    "Pick the closest names the portal offers.",
    "",
    "## Links and contact",
    "",
    table(["Field", "Answer"], [
      ["Documentation URL", brand.docsUrl ? code(brand.docsUrl) : "**Not yet** — see the prerequisites in ../README.md"],
      ["Privacy policy URL", code(brand.privacyUrl)],
      ["Support contact", code(brand.supportEmail)],
      ["Website", code(brand.url)],
    ]),
    "",
    "## Icon",
    "",
    icon
      ? `Upload \`${icon.path}\`: ${icon.width}×${icon.height} PNG, md5 \`${icon.md5}\`. Square and full-bleed with no rounded corners; clients crop it themselves.`
      : "**Not yet.** There is no square PNG for this brand; see the prerequisites in ../README.md.",
    "",
    ...(spec.screenshots
      ? [
          "## Carousel screenshots (MCP App)",
          "",
          `This server serves interactive cards (MCP Apps), so the listing takes 3–5 PNG screenshots at least 1000 px wide, cropped to the app response, each with its prompt (${SUBMIT_DOC}).`,
          "",
          table(["File", "Size", "md5"], input.screenshots.map((s) => [code(s.path), `${s.width}×${s.height}`, code(s.md5)])),
          "",
          `Prompts: ${code(spec.screenshots.prompts)}.`,
          "",
          ...(shotsRow?.status === "done" ? [] : ["**Not yet.** These PNGs are not ready to upload; see the screenshots row in the prerequisites in ../README.md.", ""]),
        ]
      : []),
    "## Slug — permanent once published",
    "",
    fence(spec.slug),
    "",
    "The slug cannot be changed after publication. Type it exactly.",
    "",
    "## Language",
    "",
    "The listing text is English because the directory audience is. The server answers in Norwegian and English, whichever the user writes in.",
  ].join("\n");

  // ── portal-answers.md ──
  const toolRow = (t: McpToolDefinition): string[] => [
    code(t.name),
    t.title ?? DASH,
    !t.annotations.title ? DASH : t.annotations.title === t.title ? "(same)" : t.annotations.title,
    String(t.annotations.readOnlyHint ?? DASH),
    String(t.annotations.destructiveHint ?? DASH),
    String(t.annotations.openWorldHint ?? DASH),
    toolSummary(t.description),
  ];
  const toolHeaders = ["Tool", "`title`", "`annotations.title`", "readOnlyHint", "destructiveHint", "openWorldHint", "What it does (first sentence)"];
  const lintClean = lintRow.status === "done";
  const portal = [
    generatedNote(),
    "",
    `# ${name} — portal answer sheet`,
    "",
    `Every step of the developer portal at ${PORTAL_URL} (**Submit new** → **MCP connector**), answered. Copy the fenced blocks as they are. Steps as listed in ${SUBMIT_DOC} (read ${DOCS_READ}).`,
    "",
    `Before you start: ${readiness(rows).replace(/\*\*/g, "")} See the prerequisites in ../README.md.`,
    "",
    "## 1. Connection",
    "",
    table(["Field", "Answer"], [
      ["Server URL", code(mcpUrl(brand))],
      ["Users connect to different URLs", "No"],
      ["Transport", "Streamable HTTP, with sessions"],
      ["Protocol versions (MCP SDK)", input.protocolVersions.map(code).join(", ")],
    ]),
    "",
    "The client must send `initialize` first. A request without a live session gets 404, as the MCP spec says; Claude's client does this correctly.",
    "",
    "## 2. Tools",
    "",
    `**${toolCounts(tools)}.** The portal syncs them from the server and groups them by read-only and write.`,
    "",
    `### Read-only (${readTools.length})`,
    "",
    readTools.length ? table(toolHeaders, readTools.map(toolRow)) : "None.",
    "",
    `### Write (${writeTools.length})`,
    "",
    writeTools.length ? table(toolHeaders, writeTools.map(toolRow)) : "None: no tool creates, changes or sends anything.",
    "",
    ...(writeTools.length ? ["What each write tool really does:", "", ...writeTools.map((t) => `- ${code(t.name)}: ${spec.writeToolNotes[t.name]}`), ""] : []),
    ...(titleDiffs.length
      ? [`**Two title fields.** ${titleDiffs.length} of ${tools.length} tools have an \`annotations.title\` that differs from the top-level \`title\` (${titleDiffs.map((t) => code(t.name)).join(", ")}). Both are shown above; which one a client displays depends on the client.`, ""]
      : []),
    "## 3. Listing",
    "",
    `See \`listing.md\` in this folder. Slug: ${code(spec.slug)} (permanent once published).`,
    "",
    "## 4. Use cases",
    "",
    "Primary use cases:",
    "",
    ...spec.useCases.map((u) => `- ${u}`),
    "",
    table(["Field", "Answer"], [
      ["What users need before they can connect", "Nothing: no account, plan or setup. The server is public and has no sign-in."],
      ["Reads, writes or both", writeTools.length ? `Both (${readTools.length} read-only tools, ${writeTools.length} write tools)` : "Reads only"],
    ]),
    "",
    "## 5. Company",
    "",
    table(["Field", "Answer"], [
      ["Company name", input.company.name],
      ["Website", code(input.company.url)],
      ["Primary contact for review updates", code(input.company.supportEmail)],
    ]),
    "",
    "## 6. Authentication",
    "",
    "**No authentication.** Paste if the portal asks why:",
    "",
    fence(spec.authRationale),
    "",
    "## 7. Data handling",
    "",
    table(["Question", "Answer"], [
      ["Whose API is behind the connector", spec.ownApi],
      ["Personal health data", spec.healthData],
      ["Sponsored content", "No. The tools return no ads or paid placements."],
    ]),
    "",
    "Paste if the portal asks what data the connector handles:",
    "",
    fence([spec.dataHandling, CALL_LOG, ...(spec.dataStored ? [spec.dataStored] : []),
      "There are no accounts, no login credentials and no payment data.", `Privacy policy: ${brand.privacyUrl}`].join("\n\n")),
    "",
    "## 8. Test & launch",
    "",
    table(["Field", "Answer"], [
      ["Test account", "None needed: the server has no authentication and serves public data."],
      ["Access instructions", "The paste block in `test-instructions.md` in this folder."],
      ["You ran every tool", "Before ticking: call each tool once, through MCP Inspector or as a custom connector in Claude."],
    ]),
    "",
    "## 9. Compliance",
    "",
    "Seven acknowledgments, all required. Our basis for each:",
    "",
    table(["Acknowledgment", "Basis"], [
      ["Directory guidelines", `Read the Software Directory Terms (${DIRECTORY_TERMS}) and Policy (${DIRECTORY_POLICY}). Tick when every prerequisite in ../README.md is done.`],
      ["First-party API usage", spec.ownApi],
      ["Financial transactions", spec.financial],
      ["AI media generation", "None: the connector generates no images, video or audio."],
      ["Prompt injection", lintClean
        ? `Tool descriptions say what each tool does and do not instruct Claude (checked against the directive patterns in ${GENERATOR}).`
        : `**Not yet.** ${lintRow.detail}`],
      ["Conversation data collection", "The tools take only the arguments they need. The server never asks for chat history, memory or files."],
      ["Public documentation", docsRow.status === "done" ? `${brand.docsUrl}` : `**Not yet.** ${docsRow.detail}`],
    ]),
    "",
    "## 10. Review and submit",
    "",
    "Check the summary, then submit. Status and reviewer feedback appear in the portal.",
    "",
    "## Known caveats, to state if asked",
    "",
    ...spec.caveats.map((c) => `- ${c}`),
  ].join("\n");

  // ── test-instructions.md ──
  const openWorldWrites = writeTools.filter((t) => t.annotations.openWorldHint === true);
  const localWrites = writeTools.filter((t) => t.annotations.openWorldHint !== true);
  const exercised = new Set(prompts.map((p) => p.tool));
  const pasteBlock = [
    `No account, key or setup is needed. The server is public and has no sign-in: add ${mcpUrl(brand)} as a custom connector and ask. Answers come in Norwegian or English, whichever you write in.`,
    "",
    "Try these:",
    "",
    ...prompts.map((p, i) => `${i + 1}. "${p.prompt}" (usually ${p.tool})`),
    "",
    ...(writeTools.length
      ? [...openWorldWrites.map((t) => `Please do not run ${t.name} to completion. What it does: ${spec.writeToolNotes[t.name]}`),
          ...(localWrites.length ? [`${localWrites.map((t) => t.name).join(" and ")} only change data inside this service and are safe to try.`] : [])]
      : ["Every tool is read-only: nothing you try can create, change or send anything."]),
  ].join("\n");
  const testInstructions = [
    generatedNote(),
    "",
    `# ${name} — reviewer test instructions`,
    "",
    "Paste this block into the **Test & launch** step's access instructions.",
    "",
    fence(pasteBlock),
    "",
    "## Notes for us, not for the portal",
    "",
    `- The prompts are \`BRAND_ENTITIES.${input.vertical}.exampleQueries\` (src/config/brand-entities.ts) plus ${spec.extraPrompts.length} extra for tool coverage. Change them there or in \`PACKS\`, then regenerate.`,
    `- They exercise ${exercised.size} of ${tools.length} tools (${[...exercised].map(code).join(", ")}). Claude picks the tool; "usually" is what it normally calls.`,
    ...(openWorldWrites.length ? [`- ${openWorldWrites.map((t) => code(t.name)).join(", ")} ${openWorldWrites.length === 1 ? "reaches" : "reach"} a real third party (openWorldHint true), so the block asks the reviewer not to complete ${openWorldWrites.length === 1 ? "it" : "them"}.`] : []),
  ].join("\n");

  return {
    "README.md": readme + "\n",
    "claude-directory/listing.md": listing + "\n",
    "claude-directory/portal-answers.md": portal + "\n",
    "claude-directory/test-instructions.md": testInstructions + "\n",
  };
}

/** Every pack file for every vertical, keyed by repo-relative path. */
export function renderConnectorPacks(): Map<string, string> {
  const floors = readCatalogFloors();
  const out = new Map<string, string>();
  for (const v of PACK_VERTICALS) {
    const spec = PACKS[v];
    const files = renderPack(spec, gatherPackInput(v, floors));
    for (const f of PACK_FILES) out.set(`${spec.dir}/${f}`, files[f]);
  }
  return out;
}

/** Repo-relative paths whose content under `root` differs from `rendered` or is missing; CRLF reads as LF (Windows checkouts). */
export function stalePackFiles(rendered: Map<string, string>, root = ROOT): string[] {
  const stale: string[] = [];
  for (const [rel, content] of rendered) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") !== content) stale.push(rel);
  }
  return stale;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

/** Compares the floors with the live honest counts (rettfrabonden.com /health reports all three). */
async function verifyFloors(): Promise<boolean> {
  const floors = readCatalogFloors();
  const url = `${BRAND_ENTITIES.rfb.url}/health`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const catalog = ((await res.json()) as { catalog?: Partial<Record<CatalogVertical, number | null>> }).catalog ?? {};
  let ok = true;
  for (const v of PACK_VERTICALS) {
    const live = catalog[v];
    if (typeof live !== "number") {
      console.log(`  ${v}: floor ${floors[v]}, live honest count unknown (not filled yet) — try again`);
      ok = false;
    } else if (floors[v] > live) {
      console.log(`  ${v}: floor ${floors[v]} > live honest count ${live} — the packs overclaim: lower the floor`);
      ok = false;
    } else {
      const raise = Math.floor(live / 100) * 100;
      console.log(`  ${v}: floor ${floors[v]} <= live honest count ${live}${raise > floors[v] ? ` (could be raised to ${raise})` : ""}`);
    }
  }
  console.log("A floor change goes in distribution/catalog-claims.json and src/routes/distribution-metadata.test.ts (dist-1); then regenerate.");
  return ok;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--verify-floors")) return (await verifyFloors()) ? 0 : 1;
  const rendered = renderConnectorPacks();
  const stale = stalePackFiles(rendered);
  if (args.includes("--check")) {
    for (const rel of stale) console.log(`stale: ${rel}`);
    console.log(stale.length ? `${stale.length} pack file(s) are stale: run npx tsx ${GENERATOR}` : `all ${rendered.size} pack files are fresh`);
    return stale.length ? 1 : 0;
  }
  for (const rel of stale) {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rendered.get(rel)!);
    console.log(`wrote ${rel}`);
  }
  console.log(`${stale.length} of ${rendered.size} pack files updated`);
  return 0;
}

if (require.main === module) {
  // Route modules start timers on import; exit explicitly when done.
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
