// ─── Brand entities: who each site is, described once ───────────────────────
// A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S1.
//
// Each brand this app serves — Rett fra Bonden, Opplevagent, Finn-tannlege —
// and the company that operates them, Agentplatform.no AS, is described HERE:
// name, URL, PNG logo, sameAs, support e-mail, docs / privacy / terms pages
// and example queries. The sites' front-page Organization JSON-LD is built
// from it (organizationJsonLd() in services/company-legal.ts); the Claude
// directory packs (G3-S6) and the MCP serverInfo (G3-S5, brandMcpIcons():
// Finn-tannlege now, RFB and Opplevagent once OpenAI has decided) read the
// same entries instead of keeping their own copies.
//
// Rules for editing:
//   - Names are the ones the sites already print. A rename is Daniel's call,
//     never a side effect of this file. Finn-tannlege keeps its name (Daniel's
//     decision 4=A, 2026-10-17) and every text sets it apart from FINN.no with
//     the one `disambiguation` sentence below (G3-S8). «FINN» or «finn.no» is
//     never an alternateName, a keyword or a sameAs.
//   - Every URL is https and answered 200 to a GET on 2026-10-17 (logos as
//     image/png), or is served by a route that ships in the same change and
//     is tested there (Finn-tannlege's logo and guide: dental-icons.test.ts,
//     dental-guide-tannlege-ai.test.ts). A page that does not exist yet is
//     null, not a guess.
//   - sameAs lists only profiles that exist. The brands have none yet; the
//     brands' own social profiles come from Daniel, one line each.
//   - Wikidata is never typed into sameAs: set `wikidataId` ("Q…") once the
//     item is published and brandSameAs() adds the item URL (A2A
//     protocols/wikidata-utkast-2026-10-17.md §9).
//   - The company's legal facts (legal name, org.nr., Brreg URL, e-mail) stay
//     in company-info.ts; the company entry reads them from there.

import type { Icon } from "@modelcontextprotocol/sdk/types.js";

import { COMPANY_INFO } from "./company-info";
import type { CatalogVertical } from "../services/honest-count";

/** A brand by its vertical id (the id registeredMcpTools() and honestCatalogCount() take), or the company. */
export type BrandKey = CatalogVertical | "company";

export interface BrandEntity {
  /** The name the site prints. */
  name: string;
  /**
   * Other names the entity goes by. A brand leads with its bare domain:
   * «rett fra bonden» is also an everyday Norwegian phrase, and the domain is
   * what tells the service apart (FUNN rett-fra-bonden-generisk-frase-forveksling).
   */
  alternateName: readonly string[];
  /** Canonical origin: https, no trailing slash. */
  url: string;
  /** Absolute URL of a square 512×512 PNG logo the site serves; null until it serves one. */
  logoPng: string | null;
  /**
   * Absolute URL of the logo's square 192×192 PNG, the small icon in the MCP
   * serverInfo (G3-S5). Null where no serverInfo reads it yet: RFB and
   * Opplevagent wait for OpenAI's decision, and the company has no MCP server.
   */
  iconPng192: string | null;
  /** https URLs of profiles of this entity that exist today. Wikidata comes from `wikidataId`, not from here. */
  sameAs: readonly string[];
  /** Wikidata item id ("Q…") once Daniel has published the item; null until then. */
  wikidataId: string | null;
  supportEmail: string;
  /** Public page on using the service from an AI assistant (MCP); null until there is one. */
  docsUrl: string | null;
  privacyUrl: string;
  termsUrl: string | null;
  /** Prompts for an AI assistant with the connector; the guide (G3-S4) and the packs (G3-S6) show them. */
  exampleQueries: readonly string[];
  /**
   * G3-S8: the sentence that tells the brand apart from a better-known name it
   * could be confused with, in Norwegian and English. Printed in the footer,
   * on /om, in the machine-readable surfaces and in the directory listing,
   * never in a heading or a main field. Only brands that need one have it.
   */
  disambiguation?: Readonly<{ nb: string; en: string }>;
}

export const WIKIDATA_ITEM_BASE = "https://www.wikidata.org/wiki/";

/** The Wikidata item URL for a Q-ID. */
export function wikidataUrl(qid: string): string {
  return `${WIKIDATA_ITEM_BASE}${qid}`;
}

/** sameAs as published: the configured profiles, then the Wikidata item when there is one. */
export function brandSameAs(entity: Pick<BrandEntity, "sameAs" | "wikidataId">): string[] {
  return entity.wikidataId ? [...entity.sameAs, wikidataUrl(entity.wikidataId)] : [...entity.sameAs];
}

/** The entry fields that name a square PNG of the brand's mark. */
type BrandPngField = "logoPng" | "iconPng192";

/**
 * An entry's square PNG fields, logo first, and the pixel size of each one's
 * file (the logo's is the 512×512 the field promises; brand-entities.test.ts
 * j1). brandMcpIcons() declares these sizes, and
 * dental-mcp-serverinfo-icons.test.ts checks that each URL serves a PNG of
 * its size.
 */
export const BRAND_PNG_ICONS: ReadonlyArray<Readonly<{ field: BrandPngField; size: number }>> = Object.freeze([
  Object.freeze({ field: "logoPng", size: 512 }),
  Object.freeze({ field: "iconPng192", size: 192 }),
]);

/**
 * serverInfo `icons` (MCP Implementation) for a brand's MCP server (G3-S5):
 * each BRAND_PNG_ICONS field the entry has, as image/png (a type every client
 * that shows icons must support) at its size. The 512 logo is icons[0], the
 * one the server card shows. Undefined while `logoPng` is null, so serverInfo
 * leaves `icons` out rather than sending an empty list, only the small icon
 * or an SVG. The list, its items and their sizes are frozen, since every
 * session of a server shares them (the SDK's Implementation type is mutable,
 * so the return type is not readonly).
 */
export function brandMcpIcons(entity: Pick<BrandEntity, BrandPngField>): Icon[] | undefined {
  if (!entity.logoPng) return undefined;
  const icons: Icon[] = [];
  for (const { field, size } of BRAND_PNG_ICONS) {
    const src = entity[field];
    if (src) icons.push({ src, mimeType: "image/png", sizes: [`${size}x${size}`] });
  }
  for (const icon of icons) {
    Object.freeze(icon.sizes);
    Object.freeze(icon);
  }
  Object.freeze(icons);
  return icons;
}

function entity(e: BrandEntity): Readonly<BrandEntity> {
  Object.freeze(e.alternateName);
  Object.freeze(e.sameAs);
  Object.freeze(e.exampleQueries);
  if (e.disambiguation) Object.freeze(e.disambiguation);
  return Object.freeze(e);
}

const RFB_URL = "https://rettfrabonden.com";
const OA_URL = "https://opplevagent.no";
const FT_URL = "https://finn-tannlege.com";
const C = COMPANY_INFO;

export const BRAND_ENTITIES: Readonly<Record<BrandKey, Readonly<BrandEntity>>> = Object.freeze({
  rfb: entity({
    name: "Rett fra Bonden",
    alternateName: ["rettfrabonden.com"],
    url: RFB_URL,
    logoPng: `${RFB_URL}/logo-512.png`,
    iconPng192: null,
    sameAs: [],
    wikidataId: null,
    supportEmail: "kontakt@rettfrabonden.com",
    docsUrl: `${RFB_URL}/guide-mat-ai`,
    privacyUrl: `${RFB_URL}/personvern`,
    termsUrl: `${RFB_URL}/vilkar`,
    // Each returned producers from live lokal_search on 2026-10-17.
    exampleQueries: [
      "Which farms in Innlandet sell lamb?",
      "What organic cheese producers are there in Norway?",
      "Where can I buy reindeer meat in Finnmark?",
    ],
  }),
  experiences: entity({
    name: "Opplevagent",
    alternateName: ["opplevagent.no"],
    url: OA_URL,
    logoPng: `${OA_URL}/favicon-512.png`,
    iconPng192: null,
    sameAs: [],
    wikidataId: null,
    supportEmail: "kontakt@opplevagent.no",
    docsUrl: `${OA_URL}/guide-opplevelser-mcp`,
    privacyUrl: `${OA_URL}/personvern`,
    termsUrl: `${OA_URL}/vilkar`,
    // The ChatGPT app's starter prompts (its positive test cases).
    exampleQueries: [
      "Hva kan vi finne på i Troms om vinteren?",
      "Find wildlife and animal experiences in Norway",
      "Finn gårdssalg og lokale drikkeprodusenter i Vestland",
    ],
  }),
  // dental-seo.ts reads `disambiguation` (G3-S8) and `exampleQueries` (the
  // guide, G3-S4) from here; its Organization moves to organizationJsonLd()
  // in G3-S1-dental. The logo is the PNG from F2-S4 and the docs page the
  // guide from G3-S4; terms stay null until F2-S5 (/vilkar) ships.
  dental: entity({
    name: "Finn-tannlege",
    alternateName: ["finn-tannlege.com"],
    url: FT_URL,
    logoPng: `${FT_URL}/favicon-512.png`,
    iconPng192: `${FT_URL}/favicon-192.png`,
    sameAs: [],
    wikidataId: null,
    supportEmail: "kontakt@finn-tannlege.com",
    docsUrl: `${FT_URL}/guide-tannlege-ai`,
    privacyUrl: `${FT_URL}/personvern`,
    termsUrl: null,
    // The reviewer prompts in dental-connectors-prep/claude-directory/test-instructions.md.
    // Also shown on /guide-tannlege-ai (G3-S4), and each must find clinics
    // through tannlege_search as written: the parser reads leftover English
    // words as name terms («care», «tonight»), so «I need emergency dental
    // care in Rogaland tonight» found none and became the third prompt below
    // (dental-guide-tannlege-ai.test.ts runs all three).
    exampleQueries: [
      "Find a dentist in Bergen",
      "Which dental clinics in Oslo have a Helfo agreement?",
      "I need an emergency dentist in Rogaland",
    ],
    // Daniel's decision 4=A (A2A daniel-responses/2026-10-17-live-del-a-gjort-og-beslutninger-1-11.md).
    // The name check (G3-J) also allows «har ingen tilknytning til FINN.no»; a
    // lawyer's wording is changed here, and only here.
    disambiguation: {
      nb: `Finn-tannlege.com er en uavhengig tjeneste fra ${C.displayName} og er ikke tilknyttet FINN.no.`,
      en: `Finn-tannlege.com is an independent service from ${C.displayName} and is not affiliated with FINN.no.`,
    },
  }),
  company: entity({
    name: C.displayName,
    alternateName: ["Agentplatform.no"],
    url: C.website,
    logoPng: `${C.website}/favicon-512.png`,
    iconPng192: null,
    sameAs: [C.brregUrl],
    wikidataId: null,
    supportEmail: C.email,
    docsUrl: null,
    privacyUrl: `${C.website}/personvern`,
    termsUrl: null,
    exampleQueries: [],
  }),
});
