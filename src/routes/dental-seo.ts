
import { Router, Request, Response } from "express";
import { createSitemapCache, resolveSitemapCacheTtlMs, logSlowSitemap } from "./sitemap-cache-util";
import {
  listPublicDentalAgents,
  countPublicDentalAgents,
  getDentalStats,
  getAvailableSpecialties,
  getDentalAgentByOrgnr,
  getDentalAgentById,
  listPoststeder,
  listRelatedClinics,
  listDentalNamesakes,
  getDentalAgentsForSitemap,
  getDentalAggregateLastmods,
  isThinDentalProfile,
} from "../services/dental-store";
import type { DentalAgent, DentalNamesake, PoststedRow, DentalAggregateLastmods, ListFilter } from "../services/dental-store";
import { getDentalAgentCard } from "../services/dental-agent-card";
import { getJWKS } from "../services/agent-card-signing";
import { getDentalOpenapi } from "../services/dental-openapi";
import { getTrafficStats, getTrafficStatsSnapshot } from "../services/traffic-stats";
import { analyticsService } from "../services/analytics-service";
import { filterQueryText } from "../services/search-tracking";
import { isDisplayablePhone } from "../services/contact-normalizer";
// dev-request 2026-10-16-utgaende-lenker-utm-eller-referrer-policy (S1): the
// clinic's own «Hjemmeside» link carries UTM; booking and directory_url links
// and the JSON-LD sameAs stay as stored.
import { addUtmParams, OUTBOUND_UTM } from "../utils/url-utm";
const CLINIC_SITE_UTM = OUTBOUND_UTM.dental.clinic_profile;
import { resolveAcuteClaim, ACUTE_ACCEPTS_LABEL } from "../services/dental-acute-claim";
import { recordAiPageDelivery } from "../services/profile-ai-deliveries";
import { aiDeliveriesTileFor } from "../services/profile-ai-deliveries-tile";
import { INDEXNOW_KEY } from "../services/indexnow-service";
// dev-request 2026-10-17-jsonld-script-escaping-felles-serialiserer: the
// shell's JSON-LD goes through the serializer that escapes < > & U+2028 U+2029.
import { jsonLdScriptTag } from "../services/safe-script-json";
import { formatRatingDisplay } from "../services/structured-data-policy";
import { agentCardUsageLogger } from "../services/mcp-usage-logger";
import { mcpProtocolDeclaration } from "../services/mcp-protocol-version";
import { safeHonestCatalogCount } from "../services/honest-count";
import { buildRobotsGroups } from "../services/robots-policy";
import { registeredMcpCapabilities, registeredMcpTools } from "../services/mcp-tool-manifest";
import { generalLimiter } from "../middleware/security";
// dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5b/5d): reuse
// the existing pure classifiers rather than reinventing name-word / host
// checks. DENTAL_NAME_WORDS is the SAME "does this name read as a dental
// clinic" word list the catalog-class classifier used to decide
// catalog_class='person_enk' in the first place. normalizeHostname is the
// hjemmeside-cleanup sweep's own URL->hostname helper.
import { DENTAL_NAME_WORDS, isPublicDentalServiceHost, DENTAL_CLINIC_CLASSES } from "../services/dental-catalog-class";
import { normalizeHostname } from "../services/dental-hjemmeside-classifier";
import { isDentalSyntheticProbeId } from "../services/dental-contamination";
import { shownDentalAgent } from "../services/dental-places-display";
import { placesDisplayPolicyEnabled } from "../services/places-display-policy";
import { planDentalSearch, MAX_POSTSTED_IN, MAX_TERM_CHARS, type DentalSearchPlan, type DentalSearchTolkning } from "../services/dental-query-parser";
import { capFreeText } from "../utils/free-text";
import { DENTAL_STATS_TTL_MS, getCachedDentalPoststeder, getDentalSearchGazetteer } from "../services/dental-search-gazetteer";
// dev-request 2026-10-17-dental-d3-rettelser (D3d punkt 2, trinn 3): the
// clinic page names its place in the official spelling, by the same lookup as
// the MCP/A2A cards.
import { officialPlaceSpelling } from "../services/search-intent/norwegian-query";
// dev-request 2026-10-17-dental-d3-rettelser (D3d): the web card's chips are
// the specialties the filter finds a clinic by, and the placeholder postnummer
// "0000" is never shown, as on the MCP/A2A cards.
import { clinicSpecialties } from "../config/dental-search-vocabulary";
import { shownPostnummer } from "../services/norway-postnummer";
// dev-request 2026-10-16-finn-tannlege-landingssider (F1-S1/F1-S2): page size,
// page-nav window and the static pages' text dates.
import { DENTAL_LANDING_CONFIG, DENTAL_STATIC_PAGE_DATES } from "../config/dental-landing";
// A2A dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as (+T1–T3):
// footer line, /kontakt facts, /personvern controller, JSON-LD parentOrganization
// and the MCP server-card vendor all come from COMPANY_INFO via these helpers.
import {
  agentCardProvider,
  companyContactBlockHtml,
  companyControllerSentenceHtml,
  companyFooterLineHtml,
  companyOperatorSentence,
  parentOrganizationJsonLd,
  toSiteLang,
} from "../services/company-legal";
// A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker (G3-S8,
// Daniel's decision 4=A): the sentence that sets Finn-tannlege.com apart from
// FINN.no is written once, in brand-entities.ts. Footer, /om, llms.txt,
// ai-plugin.json and the Organization JSON-LD print it; nowhere else names
// FINN.no (dental-finn-disambiguation.test.ts).
import { BRAND_ENTITIES } from "../config/brand-entities";

const router = Router();

// The homepage strip's AI explanation (dev-request 2026-10-13-statistikk-riktig-for-investorer, S7).
const DENTAL_AI_EXPLAIN = "AI-søk: sider en AI-assistent (ChatGPT, Claude, Perplexity …) hentet fra nettsiden i sanntid fordi noen spurte den, pluss oppslag AI-agenter gjorde i dataene våre via MCP/A2A. AI-crawlere: AI-tjenester som leser og indekserer sidene.";

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

const FINN_DISAMBIGUATION_NB = BRAND_ENTITIES.dental.disambiguation?.nb ?? "";
const FINN_DISAMBIGUATION_EN = BRAND_ENTITIES.dental.disambiguation?.en ?? "";

// PR-111: Canonical Norwegian fylker (15, post-2024 reform). The dental DB
// contains a few non-canonical fylke values ("Ukjent", "TEST", legacy names)
// from raw Brreg data and test probes. Public fylke navigation only exposes
// canonical fylker; non-canonical rows remain reachable via /sok.
const KNOWN_FYLKER = [
  "Oslo", "Akershus", "\u00d8stfold", "Buskerud", "Innlandet", "Vestfold",
  "Telemark", "Agder", "Rogaland", "Vestland", "M\u00f8re og Romsdal",
  "Tr\u00f8ndelag", "Nordland", "Troms", "Finnmark",
];
const KNOWN_FYLKER_LC = new Set(KNOWN_FYLKER.map((f) => f.toLowerCase()));
export function canonicalFylker(perFylke: Array<{ fylke: string; count: number }>): Array<{ fylke: string; count: number }> {
  return perFylke.filter((f) => KNOWN_FYLKER_LC.has((f.fylke || "").toLowerCase()));
}

// ─── Brand / Logo constants (PR-112) ────────────────────────
// Tooth SVG path — reused in nav logo, favicon, and future assets.
const TOOTH_PATH = "M18 0 C8 0 2 7 2 16 C2 23 5 26 6 32 C7 39 9 46 12 46 C15 46 14 36 18 36 C22 36 21 46 24 46 C27 46 29 39 30 32 C31 26 34 23 34 16 C34 7 28 0 18 0 Z";

// ─── Specialty pages (PR-112) ────────────────────────────────
// 7 godkjente tannlegespesialiteter i Norge (Helsedirektoratets liste).
// Slug bruker samme translittereringsprinsipper som slugifyClinic:
// ae/oe/aa for aeoaa, mellomrom/spesialtegn → bindestreker.
// Verdiene i "navn" MÅ samsvare nøyaktig med SPECIALTIES-listen under.
export interface SpecialtyPage { slug: string; navn: string; beskrivelse: string; }
export const SPECIALTY_PAGES: SpecialtyPage[] = [
  {
    slug: "kjeveortopedi",
    navn: "kjeveortopedi",
    beskrivelse: "Kjeveortopedi handler om å rette opp skjevstilte tenner og feilstilte kjever — oftest med tannregulering (bøyle), klarskinne eller andre apparater. Typiske henvisningsgrunner er trangstilte tenner, underbitt, overbitt og kjeveanomalier som påvirker tygging eller utseende.",
  },
  {
    slug: "oral-kirurgi-og-oral-medisin",
    navn: "oral kirurgi og oral medisin",
    beskrivelse: "Oral kirurgi og oral medisin dekker kirurgiske inngrep i munn og kjeve samt diagnostikk og behandling av sykdommer i munnslimhinnen. Typiske henvisningsgrunner er visdomstannfjerning med komplikasjoner, kjevecyster, beinimplantater og sår i munnen som ikke gror.",
  },
  {
    slug: "periodonti",
    navn: "periodonti",
    beskrivelse: "Periodonti er spesialiteten for tannkjøtt og det støttevevet som holder tennene på plass. Periodontitter (tannkjøttbetennelse som angriper beinvev) er den vanligste henvisningsårsaken, i tillegg til graftoperasjoner for å dekke eksponerte tannhalser.",
  },
  {
    slug: "endodonti",
    navn: "endodonti",
    beskrivelse: "Endodonti er spesialiteten for rotbehandling — behandling av pulpa (nerven) og rotkanalene inne i tannen. Typiske henvisningsgrunner er kompliserte rotbehandlinger, re-behandling av tidligere mislykkede rotfyllinger og tannrot-kirurgi (apikal kirurgi).",
  },
  {
    slug: "pedodonti",
    navn: "pedodonti",
    beskrivelse: "Pedodonti er spesialiteten for tannbehandling av barn og unge, inkludert pasienter med særlige behov. Typiske henvisninger: melketannproblemer, tannutviklingsforstyrrelser, odontofobi og behov for behandling i narkose.",
  },
  {
    slug: "oral-protetikk",
    navn: "oral protetikk",
    beskrivelse: "Oral protetikk dekker erstatning av manglende tenner og gjenoppbygging av tannsettet med proteser, kroner, broer og implantatbaserte løsninger. Typiske henvisninger: store tap av tannsubstans, komplekse rehabiliteringer og behandling av bittproblemer.",
  },
  {
    slug: "kjeve-og-ansiktsradiologi",
    navn: "kjeve- og ansiktsradiologi",
    beskrivelse: "Kjeve- og ansiktsradiologi er spesialiteten for bildediagnostikk av tenner, kjever og ansiktsskjelett ved hjelp av røntgen, CBCT og andre metoder. Typiske henvisninger: utredning av komplekse tann- og kjeveanomalier, implantatplanlegging og mistanke om svulster eller cyster.",
  },
];

// Lookup-hjelpefunksjon for spesialitet-slug
export function findSpecialtyBySlug(slug: string): SpecialtyPage | undefined {
  return SPECIALTY_PAGES.find((s) => s.slug === slug);
}

// ─── Stats TTL cache (60 s) ──────────────────────────────────
// Cache getDentalStats() results in this module. dental-store has no cache
// so API consumers always get fresh data; only SSR pages use the cache.
let _dentalStatsCache: { value: ReturnType<typeof getDentalStats>; expires: number } | null = null;

function getCachedDentalStats(): ReturnType<typeof getDentalStats> {
  const now = Date.now();
  if (_dentalStatsCache && now < _dentalStatsCache.expires) {
    return _dentalStatsCache.value;
  }
  const value = getDentalStats();
  _dentalStatsCache = { value, expires: now + DENTAL_STATS_TTL_MS };
  return value;
}

// ─── Security: HTML escape ───────────────────────────────────
function escapeHtml(text: unknown): string {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Security: safeUrl — only allow http(s) URLs from DB data ────────────
// Returns the URL unchanged if http:// or https://, otherwise "" (no link rendered).
function safeUrl(u: string | null | undefined): string {
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "";
}

// ─── dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5b) ─────
// True when `navn` reads as a dental clinic by name (same word list the
// catalog-class classifier uses for the same question) — case-insensitive
// substring match, mirrors classifyDentalCatalogEntry's own `hasAny` check.
function nameHasDentalWord(navn: string | null | undefined): boolean {
  const lower = (navn ?? "").toLowerCase();
  return DENTAL_NAME_WORDS.some((w) => lower.includes(w));
}

// True when this profile should get the sole-proprietor title template
// ("Tannlege <navn> i <by>") instead of the clinic template
// ("<navn> — Tannlegeklinikk i <by>"). Primary signal is the already-computed
// catalog_class='person_enk' (exactly this same rule, already applied by the
// classifier); the organisasjonsform+name fallback covers a row the
// classifier hasn't touched yet (catalog_class NULL) but that is, on the
// same facts, an ENK with no clinic-indicating word in its name.
function isSoleProprietorProfile(agent: DentalAgent): boolean {
  if (agent.catalog_class === "person_enk") return true;
  const form = (agent.organisasjonsform ?? "").trim().toUpperCase();
  return form === "ENK" && !nameHasDentalWord(agent.navn);
}

// dev-request 2026-10-06-dental-nedlagte-og-akuttpastander (skive C): a row the
// classifier has POSITIVELY placed outside the clinic classes (person_enk,
// lab_leverandor, holding -- everything in DENTAL_CATALOG_CLASSES except the
// clinic classes and "ukjent") is not a clinic. NULL / "ukjent" stay clinics
// (same lenient bias as DENTAL_CLINIC_CLASS_SQL). Stored class only: no
// organisasjonsform/name fallback, so this is the narrow set.
const NON_CLINIC_CLASSES = new Set(["person_enk", "lab_leverandor", "holding"]);
function isNonClinicProfile(agent: DentalAgent): boolean {
  const c = agent.catalog_class ?? null;
  return c !== null && NON_CLINIC_CLASSES.has(c) && !(DENTAL_CLINIC_CLASSES as readonly string[]).includes(c);
}

// ─── dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5d) ─────
// Label for a directory_url link — must never read as the clinic's own
// homepage (that's what `hjemmeside` is for). Reuses the county/municipal
// host list from the catalog classifier and the Facebook/fb.com domains the
// hjemmeside-cleanup sweep already treats as "social" (steg 5 of that
// dev-request explicitly named this exact follow-up).
function directoryUrlLabel(url: string): string {
  if (isPublicDentalServiceHost(url)) return "Oversikt hos fylkeskommunen";
  const host = normalizeHostname(url);
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
    return "Facebook";
  }
  return "Ekstern oversikt";
}

// ─── Security: safeTelHref — build tel: href from phone field ────────────
// wrong_contact_rate guardrail: only render a tel: link when the value reduces
// to a real 8-digit NO national number; otherwise treat it as absent.
function safeTelHref(telefon: string | null | undefined): string {
  if (!isDisplayablePhone(telefon)) return "";
  const stripped = telefon.replace(/[^+\d]/g, "");
  return "tel:" + stripped;
}

// ─── Slug helpers ────────────────────────────────────────────

export function slugifyClinic(navn: string, orgNr?: string | null): string {
  const slug = navn
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    // strip remaining diacritics (basic ASCII fold)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (orgNr && /^\d{9}$/.test(orgNr.replace(/\s/g, ""))) {
    return `${slug}--${orgNr.replace(/\s/g, "")}`;
  }
  return slug;
}

/**
 * Public profile URL for a clinic row. /klinikk/:slug only resolves when the
 * slug carries a 9-digit org.nr (parseClinicSlug -> getDentalAgentByOrgnr);
 * rows without one are served at /klinikk/id/:id. Use this everywhere a
 * profile link is built so MCP, A2A and SEO never emit a 404 URL.
 */
export function clinicProfileUrl(
  agent: { id: string; navn: string; org_nr?: string | null }
): string {
  const orgDigits = agent.org_nr ? agent.org_nr.replace(/\s/g, "") : "";
  if (/^\d{9}$/.test(orgDigits)) {
    return `${DENTAL_BASE_URL}/klinikk/${slugifyClinic(agent.navn, agent.org_nr)}`;
  }
  return `${DENTAL_BASE_URL}/klinikk/id/${agent.id}`;
}

export function parseClinicSlug(
  slug: string
): { orgNr: string } | null {
  if (!slug) return null;
  // New separator: double dash (--) between name-slug and org_nr
  const m = slug.match(/--(\d{9})$/);
  if (m) return { orgNr: m[1]! };
  // Backward-compat: single dash (old format, no live traffic yet)
  const mOld = slug.match(/-(\d{9})$/);
  if (mOld) return { orgNr: mOld[1]! };
  return null;
}

// ─── PR-116: shared text helpers ────────────────────────────

/**
 * Translitterate Norwegian text for URL slugs.
 * æ→ae, ø→oe, å→aa, mellomrom/spesialtegn → bindestrek.
 * Same rules as slugifyClinic but without the org_nr suffix.
 */
export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Title-case a DB poststed value (stored uppercase, e.g. "OSLO" → "Oslo",
 *  "MO I RANA" → "Mo i Rana"). Small Norwegian conjunctions stay lowercase
 *  when not first word. Each part of a hyphenated name is capitalised
 *  ("SØR-FRON" → "Sør-Fron", not "Sør-fron"; D3d trinn 3). */
export function titleCasePoststed(s: string): string {
  const SMALL = new Set(["i", "og", "på", "av", "ved", "for"]);
  return s.toLowerCase().split(" ").map((word, idx) => {
    if (idx > 0 && SMALL.has(word)) return word;
    return word.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
  }).join(" ");
}

/**
 * A stored poststed as the clinic page names it (dev-request
 * 2026-10-17-dental-d3-rettelser, D3d punkt 2 trinn 3): title-cased like
 * titleCasePoststed, in the official spelling where the stored value is a
 * fold of one ("Tromsoe" → "Tromsø", "Baerum" → "Bærum", "Nord Aurdal" →
 * "Nord-Aurdal"), by officialPlaceSpelling, the lookup the MCP/A2A cards use.
 * A value qualified with « i …» that is no official name as a whole gets the
 * official spelling of the place before the qualifier ("Heroey I M Og R" →
 * "Herøy i M og R"). The official spelling is taken only when it slugs like
 * the stored value: /sted groups spellings by slugifyText (D3b) and the
 * lookup goes by placeKey, so the name the page shows and its /sted/<slug>
 * link are always the same place. Anything else is title-cased as stored.
 */
export function officialPlaceLabel(stored: string): string {
  const asStored = titleCasePoststed(stored);
  const words = asStored.split(" ");
  const qualifierAt = words.indexOf("i", 1);
  const candidates: Array<[place: string, qualifier: string]> = [[stored, ""]];
  if (qualifierAt > 0) candidates.push([words.slice(0, qualifierAt).join(" "), ` ${words.slice(qualifierAt).join(" ")}`]);
  for (const [place, qualifier] of candidates) {
    const official = officialPlaceSpelling(place);
    if (!official) continue;
    const label = (official.kind === "poststed" ? titleCasePoststed(official.name) : official.name) + qualifier;
    return slugifyText(label) === slugifyText(stored) ? label : asStored;
  }
  return asStored;
}

// ─── orch-PR-20260613 finn-tannlege clinic content differentiation ──────────────
//     isPlaceholderDescription + buildClinicDescription
//     Purpose: give every clinic page a unique, fact-derived description instead
//     of the generic "Tannlegeklinikk i Oslo, Oslo." that causes near-duplicate
//     thin content and prevents indexing.

/**
 * Returns true when the stored description string is a placeholder / test
 * probe that should be treated as absent and replaced by the structured summary.
 * Recognised patterns:
 *   - obviously short or empty
 *   - matches the generic template "Tannlegeklinikk i …" (case-insensitive)
 *   - contains known test probes ("test probe", "test description", etc.)
 */
export function isPlaceholderDescription(desc: string | null | undefined): boolean {
  if (!desc || desc.trim().length < 20) return true;
  const d = desc.trim().toLowerCase();
  // Known test probe strings
  if (/test probe|test description|placeholder|lorem ipsum/i.test(d)) return true;
  // The generic template this code previously produced: "Tannlegeklinikk i <by>."
  if (/^tannlegeklinikk\s+i\s+\S/.test(d) && d.length < 60) return true;
  return false;
}

/**
 * Returns true when a locality string is valid for display.
 * Rejects: null/undefined, "Ukjent", strings starting with a country-code
 * prefix (e.g. "Se-44338 Lerum" from Brreg Swedish entity data), and
 * strings that are purely numeric or obviously non-Norwegian county names.
 */
export function isValidLocality(s: string | null | undefined): boolean {
  if (!s || s.trim().length === 0) return false;
  const t = s.trim();
  if (/^ukjent$/i.test(t)) return false;
  // Foreign poststed prefix (two-letter country code + dash + digits)
  if (/^[A-Za-z]{2}-\d/.test(t)) return false;
  return true;
}

// ─── dev-request 2026-10-17-dental-d3-rettelser (D3e): namesakes ──────────
/**
 * What tells a clinic's page apart from the page of another clinic with the
 * same name in the same place (listDentalNamesakes). Without it the two have
 * the same <title> and meta description.
 *   { place }  "<postnummer> <Poststed>", when the clinic's own postnummer is
 *              a real one (not empty, not the placeholder 0000) that none of
 *              the namesakes has; the place named by officialPlaceLabel, as
 *              everywhere else on the page (D3d trinn 3);
 *   { orgnr }  otherwise the org.nr, which no other row has;
 *   null       no namesake, or no org.nr either: the page is as before.
 * The street address is never used, because it can hold a c/o address.
 */
export type NamesakeDisambiguator = { place: string } | { orgnr: string };

/** A stored postnummer that may be shown and is four digits, trimmed; else null. */
function realPostnummer(pnr: string | null | undefined): string | null {
  const value = shownPostnummer(pnr)?.trim();
  return value && /^\d{4}$/.test(value) ? value : null;
}

export function namesakeDisambiguator(
  agent: Pick<DentalAgent, "org_nr" | "postnummer" | "poststed">,
  namesakes: ReadonlyArray<Pick<DentalNamesake, "postnummer">>
): NamesakeDisambiguator | null {
  if (namesakes.length === 0) return null;
  const own = realPostnummer(agent.postnummer);
  if (own && isValidLocality(agent.poststed) && namesakes.every((n) => realPostnummer(n.postnummer) !== own)) {
    return { place: `${own} ${officialPlaceLabel(agent.poststed!)}` };
  }
  const orgnr = agent.org_nr?.trim();
  return orgnr ? { orgnr } : null;
}

/**
 * Build a unique, natural-Norwegian clinic description from structured fields.
 * Only states facts that are present in the data; omits clauses when the field
 * is missing. Sentence structure is varied by the combination of available
 * fields so no two clinics with different data produce the same output.
 * Cap: ~155 chars for the short (meta) variant; uncapped for the full variant.
 *
 * @param agent         The DentalAgent record.
 * @param localityCount Optional number of clinics in the agent's poststed, as
 *                      /sted/<poststed> shows it (see findStedGroup). Adds a
 *                      differentiating locality clause to the short variant
 *                      when it is at least 2.
 * @param short         If true, produce a meta-description-length string (≤160 chars).
 * @param namesake      Optional (D3e): what tells the page apart from a
 *                      namesake's (namesakeDisambiguator). The opening sentence
 *                      then names the place with its postnummer, or ends with
 *                      «Org.nr N.», and the short variant never cuts it.
 */
export function buildClinicDescription(
  agent: DentalAgent,
  localityCount?: number,
  short?: boolean,
  namesake?: NamesakeDisambiguator | null
): string {
  const parts: string[] = [];

  // Locality: "i Oslo" / "i Stavanger, Rogaland" — omit malformed values;
  // the official spelling ("i Tromsø", not "i Tromsoe"; D3d trinn 3)
  const validPoststed = isValidLocality(agent.poststed) ? officialPlaceLabel(agent.poststed!) : null;
  const validFylke = isValidLocality(agent.fylke) ? agent.fylke! : null;
  // "i 0190 Oslo" on a namesake's page (D3e); { place } implies a valid poststed.
  const localityLabel = namesake && "place" in namesake ? namesake.place : validPoststed;

  const locPart = validPoststed
    ? validFylke && validFylke.toLowerCase() !== validPoststed.toLowerCase()
      ? `i ${localityLabel}, ${validFylke}`
      : `i ${localityLabel}`
    : validFylke
    ? `i ${validFylke}`
    : null;

  // Opening sentence
  const orgnrLabel = namesake && "orgnr" in namesake ? ` Org.nr ${namesake.orgnr}.` : "";
  if (locPart) {
    parts.push(`${agent.navn} er en tannlegeklinikk ${locPart}.${orgnrLabel}`);
  } else {
    parts.push(`${agent.navn} er en tannlegeklinikk.${orgnrLabel}`);
  }

  // Address
  if (!short && agent.adresse && isValidLocality(agent.poststed)) {
    const postnummer = shownPostnummer(agent.postnummer);
    parts.push(`Adresse: ${agent.adresse}, ${postnummer ? postnummer + " " : ""}${validPoststed}.`);
  }

  // Helfo
  if (agent.helfo_agreement === "true") {
    parts.push("Klinikken har Helfo-direkteoppgjørsavtale.");
  }

  // Acute
  // Skive B: «tannlegevakt» only with acute_vakt provenance; soft claim otherwise.
  const acuteClaim = resolveAcuteClaim(agent);
  if (acuteClaim === "vakt") {
    parts.push("Tilbyr tannlegevakt ved akutte smerter og skader.");
  } else if (acuteClaim === "accepts") {
    parts.push("Tar imot akuttpasienter.");
  }

  // Specialties
  const specs = agent.available_specialties?.filter(Boolean) ?? [];
  if (specs.length > 0) {
    if (specs.length === 1) {
      parts.push(`Spesialitet: ${specs[0]}.`);
    } else {
      parts.push(`Spesialiteter: ${specs.slice(0, 3).join(", ")}.`);
    }
  }

  // Treatments (short: skip; full: first few)
  if (!short) {
    const treats = agent.treatments?.filter(Boolean) ?? [];
    if (treats.length > 0) {
      parts.push(`Behandlinger inkluderer: ${treats.slice(0, 4).join(", ")}.`);
    }
  }

  // Opening hours count
  const ohDays = agent.opening_hours?.length ?? 0;
  if (ohDays > 0) {
    parts.push(`Åpent ${ohDays} dag${ohDays === 1 ? "" : "er"} i uken.`);
  }

  // Nearby clinics (only in short/meta to add differentiation). The number is
  // the /sted count itself (integrasjonstest IDX2-02, dev-request
  // 2026-10-17-integrasjonstest-oppfolging I-Q); it used to be the length of
  // a related-clinics list capped at 20, plus one, so every place with more
  // than 20 clinics read «Det finnes 21 klinikker».
  if (short && localityCount && localityCount > 1 && validPoststed) {
    parts.push(`Det finnes ${localityCount} klinikker i ${validPoststed}.`);
  }

  // Chain
  if (agent.chain_brand) {
    parts.push(`Del av ${agent.chain_brand}.`);
  }

  const full = parts.join(" ");

  if (short) {
    // Trim to ≤ 160 chars at sentence boundary
    if (full.length <= 160) return full;
    // D3e: on a namesake's page the opening sentence tells the two pages
    // apart, so it is kept whole. Only a very long name makes it longer than
    // the cut, which would leave the two descriptions alike or end on «Org.».
    if (namesake && parts[0]!.length > 157) return parts[0]!;
    let truncated = full.slice(0, 157);
    const lastDot = truncated.lastIndexOf(".");
    if (lastDot > 60) truncated = truncated.slice(0, lastDot + 1);
    else truncated = truncated.slice(0, 157) + "…";
    return truncated;
  }

  return full;
}

// ─── Poststed cache (60 s, same TTL as stats) ────────────────
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3): one shared cache
// (services/dental-search-gazetteer.ts) also feeds the search parser on /sok,
// MCP and A2A, so listPoststeder(1) still runs at most once per TTL.
function getCachedPoststeder(): PoststedRow[] {
  return getCachedDentalPoststeder(listPoststeder);
}

// ─── "Åpent nå" helper ───────────────────────────────────────

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES_NO: Record<string, string> = {
  mon: "Mandag", tue: "Tirsdag", wed: "Onsdag", thu: "Torsdag",
  fri: "Fredag", sat: "Lørdag", sun: "Søndag",
};

function isOpenNow(
  opening_hours: DentalAgent["opening_hours"]
): boolean {
  if (!opening_hours || opening_hours.length === 0) return false;
  const now = new Date();
  const dayKey = DAY_KEYS[now.getDay()];
  const entry = opening_hours.find((h) => h.day === dayKey);
  if (!entry) return false;
  const [oh, om] = entry.open.split(":").map(Number);
  const [ch, cm] = entry.close.split(":").map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const openMin = (oh ?? 0) * 60 + (om ?? 0);
  const closeMin = (ch ?? 0) * 60 + (cm ?? 0);
  // Handle overnight spans (e.g. 22:00–02:00)
  if (closeMin <= openMin) {
    return nowMin >= openMin || nowMin < closeMin;
  }
  return nowMin >= openMin && nowMin < closeMin;
}

// ─── SVG icons (inline, no emoji) ───────────────────────────

const ICON_TOOTH = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 2C7.5 2 5 3.5 5 6.5C5 9.5 6 12 6.5 14C7 16 7.5 18 10 18C12.5 18 13 16 13.5 14C14 12 15 9.5 15 6.5C15 3.5 12.5 2 10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const ICON_PIN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 1.5C5.79 1.5 4 3.29 4 5.5C4 8.38 8 14 8 14C8 14 12 8.38 12 5.5C12 3.29 10.21 1.5 8 1.5ZM8 7C7.17 7 6.5 6.33 6.5 5.5C6.5 4.67 7.17 4 8 4C8.83 4 9.5 4.67 9.5 5.5C9.5 6.33 8.83 7 8 7Z" fill="currentColor"/></svg>`;
const ICON_PHONE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v.5C2 9.3 6.7 14 12 14h.5A1.5 1.5 0 0 0 14 12.5v-1.38a1 1 0 0 0-.72-.96l-2.38-.67a1 1 0 0 0-1.08.42l-.66 1C8.07 10.32 5.68 7.93 5.09 6.84l1-.66A1 1 0 0 0 6.51 5.1L5.84 2.72A1 1 0 0 0 4.88 2H3.5Z" fill="currentColor"/></svg>`;
const ICON_CLOCK = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5V8.5L10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// ─── CSS / Layout ────────────────────────────────────────────

const DENTAL_CSS = `
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --teal-700:#0F766E;--teal-800:#115E59;--teal-400:#14B8A6;
  --navy:#0F2A43;--section-bg:#F1F5F9;
  --helfo-bg:#DCFCE7;--helfo-fg:#15803D;
  --akutt-bg:#FEF3C7;--akutt-fg:#B45309;
  --g50:#F8FAFC;--g100:#F1F5F9;--g200:#E2E8F0;--g500:#64748B;--g700:#334155;
  --white:#fff;
  --r-sm:6px;--r-md:10px;--r-lg:16px;
  --shadow-sm:0 1px 3px rgba(0,0,0,.06);--shadow-md:0 4px 12px rgba(0,0,0,.08);
}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--navy);background:var(--white);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--teal-700);text-decoration:none}
a:hover{text-decoration:underline}

/* NAV */
.nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);border-bottom:1px solid var(--g200);height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 32px}
.nav-logo{font-weight:800;font-size:1.15rem;color:var(--teal-700);display:flex;align-items:center;gap:8px;text-decoration:none!important}
.nav-logo svg{color:var(--teal-700)}
.nav-links{display:flex;gap:24px;align-items:center}
.nav-links a{font-size:.85rem;color:var(--g500);font-weight:500;text-decoration:none}
.nav-links a:hover{color:var(--teal-700)}
@media(max-width:640px){.nav-links{display:none}.nav{padding:0 16px}}

/* CONTAINER */
.container{max-width:1100px;margin:0 auto;padding:0 24px}
@media(max-width:640px){.container{padding:0 16px}}

/* HERO */
.hero{background:linear-gradient(135deg,#0F2A43 0%,#0F766E 100%);padding:72px 24px 64px;text-align:center;color:var(--white)}
.hero h1{font-size:clamp(1.8rem,4vw,2.8rem);font-weight:800;letter-spacing:-.03em;margin-bottom:16px}
.hero p{font-size:1.05rem;opacity:.85;max-width:560px;margin:0 auto 32px}
.hero-search{max-width:560px;margin:0 auto;display:flex;gap:0;border-radius:var(--r-md);overflow:hidden;box-shadow:var(--shadow-md)}
.hero-search input{flex:1;border:none;padding:14px 18px;font-size:1rem;outline:none;color:var(--navy)}
.hero-search button{background:var(--teal-700);color:var(--white);border:none;padding:0 24px;font-weight:700;font-size:.95rem;cursor:pointer}
.hero-search button:hover{background:var(--teal-800)}
.chips{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.chip{display:inline-block;padding:6px 16px;border-radius:20px;background:rgba(255,255,255,.15);color:var(--white);font-size:.83rem;font-weight:500;text-decoration:none;transition:background .15s}
.chip:hover{background:rgba(255,255,255,.25);text-decoration:none;color:var(--white)}

/* STATS BAR */
.stats-bar{background:var(--teal-700);color:var(--white);padding:20px 24px}
.stats-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;text-align:center}
@media(max-width:640px){.stats-inner{grid-template-columns:repeat(2,1fr)}}
.stat-val{font-size:1.6rem;font-weight:800;line-height:1}
.stat-lbl{font-size:.78rem;opacity:.8;margin-top:4px}

/* PROOF BAR (traffic stats) */
.proof-bar{background:var(--g100);padding:20px 24px}
.proof-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;text-align:center}
@media(max-width:640px){.proof-inner{grid-template-columns:repeat(2,1fr)}}
.proof-val{font-size:1.4rem;font-weight:800;line-height:1;color:var(--navy)}
.proof-lbl{font-size:.78rem;color:var(--g500);margin-top:4px}
.proof-val-muted{color:var(--teal-400)}
.proof-note{max-width:1100px;margin:10px auto 0;text-align:center;font-size:.72rem;color:var(--g500);line-height:1.5}

/* SECTIONS */
.section{padding:64px 0}
.section-alt{background:var(--section-bg)}
.section-title{font-size:1.55rem;font-weight:800;color:var(--navy);margin-bottom:8px;letter-spacing:-.02em}
.section-sub{color:var(--g500);font-size:.95rem;margin-bottom:32px}

/* HOW IT WORKS */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:32px}
@media(max-width:640px){.steps{grid-template-columns:1fr}}
.step{background:var(--white);border:1px solid var(--g200);border-radius:var(--r-lg);padding:28px 24px}
.step-num{width:36px;height:36px;border-radius:50%;background:var(--teal-700);color:var(--white);font-weight:800;display:flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:.95rem}
.step h3{font-size:1rem;font-weight:700;color:var(--navy);margin-bottom:6px}
.step p{font-size:.9rem;color:var(--g500);line-height:1.5}

/* HELFO BOX */
.helfo-box{background:var(--helfo-bg);border:1px solid #BBF7D0;border-radius:var(--r-lg);padding:24px 28px;margin:32px 0}
.helfo-box h3{color:var(--helfo-fg);font-size:1rem;font-weight:700;margin-bottom:8px}
.helfo-box p{color:#166534;font-size:.9rem}

/* FYLKE GRID */
.fylke-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:24px}
.fylke-card{display:block;background:var(--white);border:1px solid var(--g200);border-radius:var(--r-md);padding:16px 18px;text-decoration:none;transition:all .2s}
.fylke-card:hover{border-color:var(--teal-700);box-shadow:var(--shadow-sm);text-decoration:none}
.fylke-card-name{font-weight:600;color:var(--navy);font-size:.92rem}
.fylke-card-count{font-size:.82rem;color:var(--g500);margin-top:2px}

/* AKUTT SECTION */
.akutt-banner{background:var(--akutt-bg);border:1px solid #FDE68A;border-radius:var(--r-lg);padding:24px 28px}
.akutt-banner h3{color:var(--akutt-fg);font-size:1rem;font-weight:700;margin-bottom:8px}
.akutt-banner p{color:#92400E;font-size:.9rem}
.akutt-banner a{color:var(--akutt-fg);font-weight:600}

/* BADGES */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:600}
.badge-helfo{background:var(--helfo-bg);color:var(--helfo-fg)}
.badge-akutt{background:var(--akutt-bg);color:var(--akutt-fg)}
.badge-verified{background:#CCFBF1;color:var(--teal-700)}
.badge-chain{background:var(--g100);color:var(--g700)}
.badge-open{background:#D1FAE5;color:#065F46}
.badge-closed{background:var(--g100);color:var(--g500)}

/* SEARCH / FILTER */
.search-wrap{background:var(--section-bg);padding:28px 0;border-bottom:1px solid var(--g200)}
.filter-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-group label{font-size:.78rem;font-weight:600;color:var(--g700);text-transform:uppercase;letter-spacing:.04em}
.filter-group input,.filter-group select{padding:8px 12px;border:1px solid var(--g200);border-radius:var(--r-sm);font-size:.9rem;color:var(--navy);background:var(--white);outline:none}
.filter-group input:focus,.filter-group select:focus{border-color:var(--teal-700)}
.filter-check{display:flex;align-items:center;gap:6px;font-size:.88rem;color:var(--g700);cursor:pointer}
.filter-check input[type=checkbox]{accent-color:var(--teal-700);width:16px;height:16px}
.btn-primary{background:var(--teal-700);color:var(--white);border:none;padding:9px 22px;border-radius:var(--r-sm);font-weight:600;font-size:.9rem;cursor:pointer}
.btn-primary:hover{background:var(--teal-800)}
.btn-secondary{background:var(--white);color:var(--teal-700);border:1px solid var(--teal-700);padding:8px 18px;border-radius:var(--r-sm);font-weight:600;font-size:.9rem;cursor:pointer;text-decoration:none;display:inline-block}
.btn-secondary:hover{background:var(--g50);text-decoration:none}

/* RESULT CARDS */
.result-meta{color:var(--g500);font-size:.9rem;margin:16px 0}
.clinic-list{display:flex;flex-direction:column;gap:12px}
.clinic-card{background:var(--white);border:1px solid var(--g200);border-radius:var(--r-lg);padding:20px 24px;display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.clinic-card:hover{box-shadow:var(--shadow-sm);border-color:var(--g100)}
.clinic-main{flex:1;min-width:220px}
.clinic-name{font-size:1rem;font-weight:700;color:var(--teal-700);margin-bottom:4px}
.clinic-location{font-size:.85rem;color:var(--g500);display:flex;align-items:center;gap:4px;margin-bottom:8px}
.clinic-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.clinic-meta{font-size:.83rem;color:var(--g700);display:flex;align-items:center;gap:4px}
.clinic-side{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
@media(max-width:640px){.clinic-side{align-items:flex-start}}

/* PAGINATION */
.pagination{display:flex;gap:8px;justify-content:center;margin:32px 0;flex-wrap:wrap}
.page-btn{padding:7px 14px;border:1px solid var(--g200);border-radius:var(--r-sm);font-size:.88rem;color:var(--g700);text-decoration:none;background:var(--white)}
.page-btn:hover{border-color:var(--teal-700);color:var(--teal-700);text-decoration:none}
.page-btn.active{background:var(--teal-700);color:var(--white);border-color:var(--teal-700)}
.page-gap{padding:7px 2px;color:var(--g500)}

/* PROFILE */
.profile-header{background:linear-gradient(135deg,var(--navy) 0%,var(--teal-700) 100%);padding:40px 24px;color:var(--white)}
.profile-name{font-size:clamp(1.4rem,3vw,2rem);font-weight:800;margin-bottom:8px}
.profile-loc{font-size:.95rem;opacity:.85;display:flex;align-items:center;gap:6px;margin-bottom:16px}
.profile-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
.btn-call{background:var(--white);color:var(--teal-700);padding:10px 22px;border-radius:var(--r-sm);font-weight:700;font-size:.95rem;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn-call:hover{background:var(--g50);text-decoration:none}
.btn-book{background:var(--teal-400);color:var(--navy);padding:10px 22px;border-radius:var(--r-sm);font-weight:700;font-size:.95rem;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn-book:hover{background:#0EA5E9;text-decoration:none}
.info-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:24px}
.info-item{background:var(--section-bg);border-radius:var(--r-md);padding:14px 16px}
.info-label{font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--g500);margin-bottom:4px}
.info-value{font-size:.92rem;color:var(--navy);font-weight:500}
.section-box{background:var(--white);border:1px solid var(--g200);border-radius:var(--r-lg);padding:24px;margin-bottom:20px}
.section-box h2{font-size:1.05rem;font-weight:700;color:var(--navy);margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--g100)}
.hours-table{width:100%;border-collapse:collapse}
.hours-table td{padding:6px 0;font-size:.88rem}
.hours-table td:first-child{color:var(--g500);width:100px}
.spec-list{display:flex;flex-wrap:wrap;gap:8px}
.spec-tag{display:inline-block;padding:5px 12px;background:var(--section-bg);border-radius:20px;font-size:.82rem;color:var(--navy);font-weight:500}
.disclaimer{font-size:.78rem;color:var(--g500);margin-top:24px;padding-top:16px;border-top:1px solid var(--g200)}

/* OM / STATIC PAGES */
.content-page{max-width:760px;margin:0 auto;padding:48px 24px}
.content-page h1{font-size:1.8rem;font-weight:800;color:var(--navy);margin-bottom:12px}
.content-page h2{font-size:1.15rem;font-weight:700;color:var(--navy);margin:28px 0 10px}
.content-page p{font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:12px}
.content-page ul{padding-left:20px;margin-bottom:12px}
.content-page li{font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:4px}

/* FOOTER */
.footer{background:var(--navy);color:rgba(255,255,255,.65);padding:40px 24px;margin-top:auto}
.footer-inner{max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;gap:32px;justify-content:space-between}
.footer-col h4{color:var(--white);font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.footer-col a{display:block;color:rgba(255,255,255,.6);font-size:.85rem;margin-bottom:6px;text-decoration:none}
.footer-col a:hover{color:var(--white)}
.footer-bottom{max-width:1100px;margin:24px auto 0;padding-top:16px;border-top:1px solid rgba(255,255,255,.1);font-size:.78rem;color:rgba(255,255,255,.4)}
.footer-company{margin-top:6px}
.footer-company a{color:rgba(255,255,255,.65);text-decoration:underline}
.footer-disambiguation{margin-top:4px}

/* SPECIALTY CHIPS */
.spec-chip{display:inline-block;padding:7px 18px;border-radius:20px;background:var(--section-bg);border:1px solid var(--g200);color:var(--navy);font-size:.83rem;font-weight:500;text-decoration:none;transition:all .15s}
.spec-chip:hover{background:var(--teal-700);color:var(--white);border-color:var(--teal-700);text-decoration:none}

/* COMPANY FACTS (/kontakt) */
.co-sec{margin-top:48px;padding-top:24px;border-top:1px solid var(--g200)}
.co-sec h2{font-size:1.15rem;font-weight:700;color:var(--navy);margin-bottom:12px}
.co-facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;font-size:.92rem;margin:0}
.co-facts dt{font-weight:600;color:var(--navy)}
.co-facts dd{margin:0;color:var(--g700)}
@media(max-width:480px){.co-facts{grid-template-columns:1fr;gap:2px}.co-facts dd{margin-bottom:8px}}

/* EMPTY STATE */
.empty-state{text-align:center;padding:64px 24px}
.empty-state h3{font-size:1.2rem;font-weight:700;color:var(--navy);margin-bottom:8px}
.empty-state p{color:var(--g500);font-size:.92rem}
</style>`;

// ─── Shared nav / footer ─────────────────────────────────────

function dentalNav(): string {
  return `<nav class="nav" role="navigation" aria-label="Hovednavigasjon">
  <a href="/" class="nav-logo"><svg width="26" height="26" viewBox="0 0 72 72" aria-hidden="true"><circle cx="30" cy="30" r="24" fill="none" stroke="#0F766E" stroke-width="7"/><line x1="48" y1="48" x2="64" y2="64" stroke="#0F766E" stroke-width="9" stroke-linecap="round"/><g transform="translate(16,11) scale(0.78)"><path d="${TOOTH_PATH}" fill="#0F766E"/></g></svg> Finn-tannlege</a>
  <div class="nav-links">
    <a href="/sok">Søk</a>
    <a href="/#fylker">Fylker</a>
    <a href="/sok?akutt=1">Akutt</a>
    <a href="/om">Om</a>
    <a href="/kontakt">Kontakt</a>
  </div>
</nav>`;
}

function dentalFooter(): string {
  return `<footer class="footer" role="contentinfo">
  <div class="footer-inner">
    <div class="footer-col">
      <h4>Tjeneste</h4>
      <a href="/om">Om finn-tannlege.com</a>
      <a href="/hvordan-det-fungerer">Slik fungerer det</a>
      <a href="/personvern">Personvern</a>
      <a href="/vilkar">Vilkår</a>
      <a href="/sok">Søk etter tannlege</a>
      <a href="/kontakt">Kontakt oss</a>
    </div>
    <div class="footer-col">
      <h4>Datakilder</h4>
      <a href="https://www.brreg.no/" rel="nofollow noopener" target="_blank">Brønnøysundregistrene</a>
      <a href="https://www.helsedirektoratet.no/" rel="nofollow noopener" target="_blank">Helsedirektoratet / HPR</a>
      <a href="https://www.ntf.no/" rel="nofollow noopener" target="_blank">NTF</a>
    </div>
    <div class="footer-col">
      <h4>For agenter</h4>
      <a href="/llms.txt">llms.txt</a>
      <a href="/api/tannlege/agents">/api/tannlege</a>
      <a href="https://rettfrabonden.com" rel="noopener" target="_blank">Søsterplattform: rettfrabonden.com</a>
    </div>
  </div>
  <div class="footer-bottom">
    &copy; ${new Date().getFullYear()} Finn-tannlege.com &mdash; AI-agenter: <a href="/llms.txt">llms.txt</a> &middot; API: <a href="/api/tannlege/agents">/api/tannlege</a><br>
    En del av A2A-nettverket: <a href="https://rettfrabonden.com" rel="noopener">rettfrabonden.com</a> &middot; <a href="https://opplevagent.no" rel="noopener">opplevagent.no</a> &mdash; Bygget for både mennesker og AI-agenter
    <div class="footer-company">${companyFooterLineHtml("nb", { contactHref: "/kontakt" })}</div>
    <div class="footer-disambiguation">${escapeHtml(FINN_DISAMBIGUATION_NB)}</div>
  </div>
</footer>`;
}

// ─── Shell layout ─────────────────────────────────────────────

interface ShellOptions {
  // Plain text: dentalShell escapes it, once, for <title>, og:title and
  // twitter:title. An escaped title came out as «A&amp;amp;B» (D3b).
  title: string;
  description?: string;
  // Left out = the homepage. null = no canonical link and no og:url at all,
  // for a page that is a copy of no other page (the 404s, sendDentalNotFound).
  canonical?: string | null;
  jsonLd?: object | object[];
  ogImage?: string;
  // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5b): thin
  // profiles override the default "index, follow" robots meta with
  // "noindex,follow" — still crawled (follow) so its outbound links keep
  // being discovered, just not itself indexed/ranked.
  robots?: string;
}

function dentalShell(content: string, opts: ShellOptions): string {
  const desc = opts.description || "Finn riktig tannlege i Norge. Søk etter klinikk, spesialitet, Helfo-avtale og tannlegevakt.";
  const canonical = opts.canonical === null ? null : opts.canonical || DENTAL_BASE_URL;
  const canonicalLink = canonical ? `\n<link rel="canonical" href="${escapeHtml(canonical)}">` : "";
  const ogUrlMeta = canonical ? `\n<meta property="og:url" content="${escapeHtml(canonical)}">` : "";
  const robots = opts.robots || "index, follow, max-snippet:-1, max-image-preview:large";
  const ldArr = opts.jsonLd
    ? (Array.isArray(opts.jsonLd) ? opts.jsonLd : [opts.jsonLd])
    : [];
  const ldScripts = ldArr
    .map((ld) => jsonLdScriptTag(ld))
    .join("\n");
  // OG/Twitter share image. SVG favicon is the only platform-owned visual asset
  // we ship, so it doubles as the default share image (overridable via opts.ogImage).
  const ogImage = opts.ogImage || `${DENTAL_BASE_URL}/favicon.svg`;
  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="${escapeHtml(robots)}">${canonicalLink}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">${ogUrlMeta}
<meta property="og:type" content="website">
<meta property="og:locale" content="nb_NO">
<meta property="og:site_name" content="Finn-tannlege.com">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:alt" content="Finn-tannlege.com — uavhengig oversikt over tannleger i Norge">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(opts.title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
${ldScripts}
${DENTAL_CSS}
</head>
<body>
${dentalNav()}
${content}
${dentalFooter()}
</body>
</html>`;
}

// Every HTML 404 on finn-tannlege.com goes through here, so none of them asks
// to be indexed: "noindex, follow", like the Opplevagent and RFB 404 pages,
// instead of the shell's default "index, follow" (integrasjonstest RYS-1,
// dev-request 2026-10-17-integrasjonstest-oppfolging I-Q). Nor do they carry a
// canonical link or og:url: they used to fall back to the homepage, so every
// 404 claimed to be a copy of https://finn-tannlege.com (FUNN
// dental-404-canonical-til-forsiden, dev-request
// 2026-10-16-finn-tannlege-landingssider F1-S1).
const NOT_FOUND_ROBOTS = "noindex, follow";

function sendDentalNotFound(res: Response, content: string, opts: Omit<ShellOptions, "robots" | "canonical">): void {
  res.status(404).send(dentalShell(content, { ...opts, robots: NOT_FOUND_ROBOTS, canonical: null }));
}

// ─── Clinic card (used in /sok and /fylke) ───────────────────
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt (A4-D): the card, like the profile below, shows the clinic
// through shownDentalAgent (no phone or hours that only Google Places gives).

function clinicCard(
  stored: DentalAgent & { id: string }
): string {
  const agent = shownDentalAgent(stored);
  const slug = slugifyClinic(agent.navn, agent.org_nr ?? undefined);
  const href = agent.org_nr
    ? `/klinikk/${escapeHtml(slug)}`
    : `/klinikk/id/${escapeHtml(agent.id)}`;

  const badges: string[] = [];
  if (agent.verification_status === "verified")
    badges.push(`<span class="badge badge-verified">Verifisert</span>`);
  if (agent.helfo_agreement === "true")
    badges.push(`<span class="badge badge-helfo">Helfo-avtale</span>`);
  {
    const acute = resolveAcuteClaim(agent);
    if (acute === "vakt") badges.push(`<span class="badge badge-akutt">Akuttvakt</span>`);
    else if (acute === "accepts") badges.push(`<span class="badge badge-akutt">${ACUTE_ACCEPTS_LABEL}</span>`);
  }
  if (agent.chain_brand)
    badges.push(`<span class="badge badge-chain">${escapeHtml(agent.chain_brand)}</span>`);

  const openStatus = agent.opening_hours && agent.opening_hours.length > 0
    ? (isOpenNow(agent.opening_hours)
        ? `<span class="badge badge-open">${ICON_CLOCK} Åpent nå</span>`
        : `<span class="badge badge-closed">${ICON_CLOCK} Stengt nå</span>`)
    : "";

  const specialties = (() => {
    const names = clinicSpecialties(agent);
    if (names.length === 0) return "";
    const links = names.map((s) => {
      const sp = SPECIALTY_PAGES.find((p) => p.navn === s.toLowerCase());
      return sp
        ? `<a href="/spesialitet/${escapeHtml(sp.slug)}" class="spec-chip" style="padding:3px 10px;font-size:.75rem">${escapeHtml(s)}</a>`
        : `<span style="font-size:.8rem;color:var(--g500)">${escapeHtml(s)}</span>`;
    });
    return `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${links.join("")}</div>`;
  })();

  const _telHref = safeTelHref(agent.telefon);
  const phone = _telHref
    ? `<div class="clinic-meta">${ICON_PHONE} <a href="${_telHref}">${escapeHtml(agent.telefon)}</a></div>`
    : "";

  return `<article class="clinic-card">
  <div class="clinic-main">
    <div class="clinic-name"><a href="${href}">${escapeHtml(agent.navn)}</a></div>
    <div class="clinic-location">${ICON_PIN} ${escapeHtml(agent.poststed || "")}${agent.fylke ? `, ${escapeHtml(agent.fylke)}` : ""}</div>
    <div class="clinic-badges">
      ${badges.join("")}${openStatus}
    </div>
    ${specialties}
  </div>
  <div class="clinic-side">
    ${phone}
    <a href="${href}" class="btn-secondary" style="font-size:.82rem;padding:6px 14px">Se profil</a>
  </div>
</article>`;
}

// ─── Pagination + ItemList (shared by every dental list page) ──
// dev-request 2026-10-16-finn-tannlege-landingssider (F1-S1): /fylke, /sted
// and /spesialitet page the same way, so every clinic on them can be crawled.
// Page 1 is the bare path; page N ≥ 2 is <path>?side=N and is its own
// canonical. The facet pages (2026-10-16-finn-tannlege-fasettsider) are meant
// to use these as they are.

/** Relative URL of page `n` of the list at `baseUrl` (which may carry a query). */
export function listPageHref(baseUrl: string, n: number): string {
  const base = baseUrl.replace(/[?&]$/, "");
  if (n <= 1) return base;
  return `${base}${base.includes("?") ? "&" : "?"}side=${n}`;
}

/**
 * What page N ≥ 2 of a list adds to its <title> (« – side N») and description
 * (« Side N av M.»): it is its own canonical, so it must not repeat page 1's
 * title and description word for word. Page 1 adds nothing.
 */
export function listPageMeta(page: number, totalPages: number): { title: string; description: string } {
  return page > 1
    ? { title: ` – side ${page}`, description: ` Side ${page} av ${totalPages}.` }
    : { title: "", description: "" };
}

/**
 * The page a list request is on, for `total` rows in pages of listPageSize:
 * ?side= parsed as before; missing, invalid, below 1 or past the last page =
 * page 1.
 */
export function resolveListPage(
  side: unknown,
  total: number
): { page: number; offset: number; totalPages: number } {
  const pageSize = DENTAL_LANDING_CONFIG.listPageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const raw = parseInt(String(side || "1"), 10);
  const page = Number.isFinite(raw) && raw > 0 && raw <= totalPages ? raw : 1;
  return { page, offset: (page - 1) * pageSize, totalPages };
}

/**
 * Page nav: previous, first, the current page ± paginationWindow, last and
 * next, each a real link (rel="prev"/"next", aria-current on the current
 * page). The gap mark between non-adjacent numbers is decoration and stands
 * for no page: every page is reachable through links, and the last page is
 * linked from every page. It used to link pages 1–10 only, with «... N» as
 * plain text, so page 11 and on could not be crawled. Every list route,
 * /sok included (D3b), resolves ?side= with resolveListPage, so it never
 * asks for a page past the last one; if a caller does, the window sits at
 * the end and «Forrige» goes to the last page, never to a page that does not
 * exist.
 */
export function paginationHtml(
  currentPage: number,
  totalPages: number,
  baseUrl: string
): string {
  if (totalPages <= 1) return "";
  const win = DENTAL_LANDING_CONFIG.paginationWindow;
  const a = (n: number, label: string, attrs: string): string =>
    `<a href="${escapeHtml(listPageHref(baseUrl, n))}"${attrs}>${label}</a>`;

  const at = Math.min(currentPage, totalPages);
  const shown = new Set<number>([1, totalPages]);
  for (let n = Math.max(1, at - win); n <= Math.min(totalPages, at + win); n++) shown.add(n);
  const numbers = [...shown].sort((x, y) => x - y);

  const parts: string[] = [];
  if (currentPage > 1) parts.push(a(Math.min(currentPage - 1, totalPages), "&lsaquo; Forrige", ` class="page-btn" rel="prev"`));
  numbers.forEach((n, i) => {
    if (i > 0 && n - numbers[i - 1]! > 1) parts.push(`<span class="page-gap" aria-hidden="true">&hellip;</span>`);
    parts.push(a(n, String(n), n === currentPage ? ` class="page-btn active" aria-current="page"` : ` class="page-btn"`));
  });
  if (currentPage < totalPages) parts.push(a(currentPage + 1, "Neste &rsaquo;", ` class="page-btn" rel="next"`));
  return `<nav class="pagination" aria-label="Sidebladering">${parts.join("")}</nav>`;
}

/**
 * ItemList JSON-LD for one rendered list page: exactly the cards on it, in
 * order, positions counted on from `offset` (page 2 starts at 51). It used to
 * stop at 25 while 50 cards were rendered. Profile URLs via clinicProfileUrl,
 * no query string (UTM stays in the transport layer, lokal#1077).
 */
export function dentalItemListJsonLd(
  name: string,
  url: string,
  agents: Array<{ id: string; navn: string; org_nr?: string | null }>,
  offset: number
): object {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url,
    numberOfItems: agents.length,
    itemListElement: agents.map((a, i) => ({
      "@type": "ListItem",
      position: offset + i + 1,
      url: clinicProfileUrl(a),
      name: a.navn,
    })),
  };
}

// ═══════════════════════════════════════════════════════════
// GET / — Forside
// ═══════════════════════════════════════════════════════════

// dev-request 2026-10-16-finn-tannlege-landingssider (F1-S1): the hero chips
// (DENTAL_LANDING_CONFIG.heroPlaces) link the indexable /sted/<slug> page
// when the place has one in the cached poststed list (findStedRow, the lookup
// /sted itself uses), and /sok?q= (noindex) only when it has none.
function heroPlaceHref(place: string): string {
  const slug = slugifyText(place);
  return findStedRow(slug) ? `/sted/${slug}` : `/sok?q=${encodeURIComponent(place)}`;
}

router.get("/", (_req: Request, res: Response) => {
  let stats = { total: 0, per_fylke: [] as Array<{ fylke: string; count: number }>, helfo_count: 0, chain_count: 0, acute_count: 0, specialist_clinic_count: 0 };
  try { stats = getCachedDentalStats(); } catch { /* dental db may not be ready */ }
  const traffic = getTrafficStats("dental");

  const totalRounded = stats.total > 6000
    ? `over ${Math.floor(stats.total / 100) * 100}`
    : String(stats.total);

  const fylkerKjent = canonicalFylker(stats.per_fylke);
  const fylkeGrid = fylkerKjent.length > 0
    ? fylkerKjent
        .map(
          (f) =>
            `<a href="/fylke/${encodeURIComponent(f.fylke)}" class="fylke-card">
              <div class="fylke-card-name">${escapeHtml(f.fylke)}</div>
              <div class="fylke-card-count">${f.count} klinikker</div>
            </a>`
        )
        .join("")
    : `<p style="color:var(--g500)">Ingen fylkedata tilgjengelig ennå.</p>`;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Finn-tannlege.com",
      url: DENTAL_BASE_URL,
      description: "Norges oversikt over tannlegeklinikker — søk etter Helfo-avtale, spesialitet og åpningstid.",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${DENTAL_BASE_URL}/sok?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Finn-tannlege",
      url: DENTAL_BASE_URL,
      logo: DENTAL_BASE_URL + "/favicon.svg",
      // G3-S8; G3-S1-dental moves it into organizationJsonLd("dental").
      ...(FINN_DISAMBIGUATION_NB ? { disambiguatingDescription: FINN_DISAMBIGUATION_NB } : {}),
      // T2: the company that owns and operates finn-tannlege.com.
      parentOrganization: parentOrganizationJsonLd(),
    },
  ];

  const html = `
<main>
  <section class="hero" aria-label="Søk etter tannlege">
    <h1>Finn riktig tannlege for deg</h1>
    <p>Uavhengig oversikt over ${escapeHtml(totalRounded)} tannlegeklinikker i Norge &mdash; med informasjon om Helfo-avtale, spesialiteter og åpningstider.</p>
    <form class="hero-search" action="/sok" method="GET" role="search" aria-label="Søk etter tannlege">
      <label for="hero-q" style="position:absolute;clip:rect(0,0,0,0)">Søk etter tannlege, poststed eller by</label>
      <input id="hero-q" name="q" type="search" placeholder="Søk etter tannlege, poststed eller by..." autocomplete="off">
      <button type="submit">Søk</button>
    </form>
    <div class="chips" role="list" aria-label="Snarvei-søk">
      ${DENTAL_LANDING_CONFIG.heroPlaces.map((place) => `<a href="${escapeHtml(heroPlaceHref(place))}" class="chip" role="listitem">${escapeHtml(place)}</a>`).join("\n      ")}
      <a href="/sok?akutt=1" class="chip" role="listitem" style="background:rgba(251,191,36,.25)">Akutt</a>
    </div>
  </section>

  <div class="stats-bar" aria-label="Statistikk">
    <div class="stats-inner">
      <div><div class="stat-val">${stats.total.toLocaleString("nb")}</div><div class="stat-lbl">Klinikker registrert</div></div>
      <div><div class="stat-val">${fylkerKjent.length}</div><div class="stat-lbl">Fylker dekket</div></div>
      <div><div class="stat-val">${stats.helfo_count.toLocaleString("nb")}</div><div class="stat-lbl">Med Helfo-avtale</div></div>
      <div><div class="stat-val">${stats.specialist_clinic_count.toLocaleString("nb")}</div><div class="stat-lbl">Spesialistklinikker</div></div>
    </div>
  </div>

  <div class="proof-bar" aria-label="Trafikk">
    <div class="proof-inner">
      <div><div class="proof-val">${traffic.humanVisits.toLocaleString("nb")}</div><div class="proof-lbl">Besøk fra mennesker</div></div>
      <div><div class="proof-val">${traffic.humanViews.toLocaleString("nb")}</div><div class="proof-lbl">Sidevisninger fra mennesker</div></div>
      <div title="${DENTAL_AI_EXPLAIN}"><div class="proof-val proof-val-muted">${traffic.aiSearchTotal.toLocaleString("nb")}</div><div class="proof-lbl">AI-søk</div></div>
      <div title="${DENTAL_AI_EXPLAIN}"><div class="proof-val">${traffic.aiCrawlerViews.toLocaleString("nb")}</div><div class="proof-lbl">AI-crawlere</div></div>
    </div>
    <div class="proof-note">Sidevisninger siste ${traffic.windowDays} dager: ${traffic.pageViews.toLocaleString("nb")} = mennesker ${traffic.humanViews.toLocaleString("nb")} + AI-assistenter ${traffic.aiSearchViews.toLocaleString("nb")} + AI-crawlere ${traffic.aiCrawlerViews.toLocaleString("nb")} + andre roboter og skript ${traffic.otherBotViews.toLocaleString("nb")}. AI-søk = ${traffic.aiSearchViews.toLocaleString("nb")} sider hentet av AI-assistenter + ${traffic.aiLookups.toLocaleString("nb")} oppslag via MCP/A2A. Et besøk er en rekke sidevisninger fra én besøkende uten mer enn 30 minutters pause. ${DENTAL_AI_EXPLAIN}</div>
  </div>

  <section class="section section-alt">
    <div class="container">
      <div class="section-title">Slik fungerer det</div>
      <div class="section-sub">Tre enkle steg til riktig tannlege</div>
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <h3>Søk</h3>
          <p>Skriv inn by, poststed eller navn. Filtrer på fylke, spesialitet eller om klinikken har Helfo-avtale.</p>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <h3>Sammenlign</h3>
          <p>Se Helfo-avtale, spesialiteter, åpningstider og kontaktinformasjon for klinikkene som passer deg.</p>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <h3>Kontakt eller bestill</h3>
          <p>Ring klinikken direkte eller bruk online-booking der det finnes. Ingen mellomledd, ingen gebyrer.</p>
        </div>
      </div>

      <div class="helfo-box" role="region" aria-label="Om Helfo-direkteoppgjør">
        <h3>Hva er Helfo-avtale?</h3>
        <p>Klinikker med Helfo-direkteoppgjørsavtale sender regningen direkte til Helfo. Du betaler kun egenandelen selv &mdash; ikke full pris. Gjelder ved undersøkelse, akuttbehandling og visse tannbehandlinger som dekkes av lov om tannhelsetjenesten.</p>
      </div>
      <p style="margin-top:16px;font-size:.92rem"><a href="/hvordan-det-fungerer">Les hele guiden om hvordan Finn-tannlege fungerer &rarr;</a></p>
    </div>
  </section>

  <section class="section" id="fylker" aria-labelledby="fylker-heading">
    <div class="container">
      <div id="fylker-heading" class="section-title">Søk etter fylke</div>
      <div class="section-sub">Velg ditt fylke for en oversikt over tannlegeklinikker i ditt område.</div>
      <div class="fylke-grid" role="list" aria-label="Fylker">
        ${fylkeGrid}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="container">
      <div class="section-title">Finn spesialist</div>
      <div class="section-sub">Tannlegespesialiteter i Norge &mdash; klikk for oversikt over spesialistklinikker</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:0">
        ${SPECIALTY_PAGES.map((sp) => `<a href="/spesialitet/${escapeHtml(sp.slug)}" class="spec-chip">${escapeHtml(sp.navn.charAt(0).toUpperCase() + sp.navn.slice(1))}</a>`).join("")}
      </div>
    </div>
  </section>

  <section class="section section-alt">
    <div class="container">
      <div class="akutt-banner" role="region" aria-label="Tannlegevakt">
        <h3>Tannlegevakt og akuttbehandling</h3>
        <p>Tannlegevakttilbudet i Norge er fragmentert og varierer mye fra kommune til kommune. Mange fylker har kommunal tannlegevakt for akutte smerter og skader, men åpningstidene er begrenset. <a href="/sok?akutt=1">Se klinikker med akuttvakt-tilbud</a> &rarr;</p>
      </div>
    </div>
  </section>

  ${(() => {
    // The 20 largest /sted groups, one chip per slug (D3b).
    const topSteder = stedGroups().bySize.slice(0, 20);
    if (topSteder.length === 0) return "";
    const chips = topSteder.map((g) =>
      `<a href="/sted/${escapeHtml(slugifyText(g.row.poststed))}" class="spec-chip">${escapeHtml(titleCasePoststed(g.row.poststed))}</a>`
    ).join("");
    return `<section class="section">
    <div class="container">
      <div class="section-title">Populære steder</div>
      <div class="section-sub">Finn tannlege i din by</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:0">${chips}</div>
    </div>
  </section>`;
  })()}
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Finn-tannlege.com — Finn riktig tannlege i Norge",
    description: `Uavhengig oversikt over ${totalRounded} tannlegeklinikker i Norge. Søk etter Helfo-avtale, spesialitet og tannlegevakt.`,
    canonical: DENTAL_BASE_URL,
    jsonLd,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /sok — Søkeresultater
// ═══════════════════════════════════════════════════════════

const SPECIALTIES = [
  "kjeveortopedi",
  "oral kirurgi og oral medisin",
  "periodonti",
  "endodonti",
  "pedodonti",
  "oral protetikk",
  "kjeve- og ansiktsradiologi",
];

// ═══════════════════════════════════════════════════════════
// GET /api/traffic-stats — Public dental traffic stats
// ═══════════════════════════════════════════════════════════

router.get("/api/traffic-stats", (_req: Request, res: Response) => {
  // ready=false: the numbers are placeholder zeros while the first off-thread
  // computation after boot is still running (dev-request
  // 2026-09-19-prod-event-loop-stall-mcp-unhealthy) — do not read them as a drop.
  const { stats: s, ready } = getTrafficStatsSnapshot("dental");
  if (!ready) res.set("Cache-Control", "no-store");
  res.json({
    ready,
    pageViews: s.pageViews,
    uniqueVisitors: s.uniqueVisitors,
    // New three-bucket fields (dev-request 2026-07-21 slice A)
    realVisitors: s.realVisitors,
    humanViews: s.humanViews,
    // S5 of 2026-10-13-statistikk-riktig-for-investorer: visits by people.
    humanVisits: s.humanVisits,
    aiSearchViews: s.aiSearchViews,
    aiCrawlerViews: s.aiCrawlerViews,
    // S7 of 2026-10-13-statistikk-riktig-for-investorer: «AI-søk» = aiSearchViews
    // (pages AI assistants fetched for someone) + aiLookups (MCP/A2A); AI
    // crawlers shown on their own, the rest is otherBotViews.
    aiLookups: s.aiLookups,
    aiSearchTotal: s.aiSearchTotal,
    otherBotViews: s.otherBotViews,
    botViews: s.botViews,
    windowDays: s.windowDays,
    // Back-compat fields (old consumers)
    realHumans: s.realHumans,
    botAndAi: s.botAndAi,
    aiQueries: s.aiQueries,
  });
});

// generalLimiter on the route, like /sok in seo.ts and experiences-seo.ts
// (dev-request 2026-10-17-integrasjonstest-oppfolging, I-T revision). The
// finn-tannlege.com host gate in src/index.ts hands every non-API path to this
// router before any limiter mount, so this free-text search — a count, a page
// of rows and the specialty list per request, any ?side= — had none. Same
// shared instance and quota as the other /sok pages; dentalLimiter stays the
// /api/tannlege quota for the enrichment workers.
router.get("/sok", generalLimiter, (req: Request, res: Response) => {
  const searchStarted = Date.now();
  // Slice I-Y: at most MAX_FREE_TEXT_CHARS of `q` are read (search, log, the
  // search box), cut at a word boundary (utils/free-text.ts).
  const q = capFreeText(String(req.query.q || "").trim());
  const fylke = String(req.query.fylke || "").trim();
  const spesialitet = String(req.query.spesialitet || "").trim();
  const helfo = req.query.helfo === "1";
  const akutt = req.query.akutt === "1";
  const kjede = String(req.query.kjede || "").trim();

  // The form's own fields win over what the parser reads out of `q`
  // (dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S3).
  const explicit: Record<string, unknown> = {};
  if (fylke) explicit.fylke = fylke;
  if (spesialitet) explicit.specialty = spesialitet;
  if (helfo) explicit.helfo_agreement = "true";
  if (akutt) explicit.acute_vakt = 1; // the public store reads this as the akutt claim on the card (S2b)
  if (kjede) explicit.chain_brand = kjede;

  let agents: Array<DentalAgent & { id: string }> = [];
  let total = 0;
  let tolkning: DentalSearchTolkning | null = null;
  let filter: DentalSearchPlan["filter"] | null = null;
  try {
    const plan = planDentalSearch({
      query: q,
      explicit,
      gazetteer: () => getDentalSearchGazetteer(listPoststeder),
      count: (f) => countPublicDentalAgents(f as any),
    });
    tolkning = plan.tolkning;
    total = plan.count;
    filter = plan.filter;
  } catch { /* db not ready */ }
  // Count first, then the page, as on /fylke, /sted and /spesialitet: a
  // ?side= past the last page is page 1 (D3b). It used to have no upper
  // bound, so ?side=999 rendered «Ingen klinikker funnet — side 999 av 22».
  const { page, offset, totalPages } = resolveListPage(req.query.side, total);
  if (filter) {
    try {
      agents = listPublicDentalAgents(filter as any, DENTAL_LANDING_CONFIG.listPageSize, offset);
    } catch { /* db not ready */ }
  }

  // dev-request 2026-10-13-statistikk-riktig-for-investorer, S2: a search is
  // the first result page of a query or filter set (paging is not a new one).
  if (page === 1 && (q || Object.keys(explicit).length > 0)) {
    analyticsService.logWebSearch(req, Date.now() - searchStarted, {
      query: q || filterQueryText({ fylke, spesialitet, helfo: helfo || undefined, akutt: akutt || undefined, kjede }),
      resultCount: total,
    });
  }

  // Build query string for pagination (preserve all filters)
  const filterParams = new URLSearchParams();
  if (q) filterParams.set("q", q);
  if (fylke) filterParams.set("fylke", fylke);
  if (spesialitet) filterParams.set("spesialitet", spesialitet);
  if (helfo) filterParams.set("helfo", "1");
  if (akutt) filterParams.set("akutt", "1");
  if (kjede) filterParams.set("kjede", kjede);
  const baseUrl = "/sok?" + filterParams.toString();

  // Only offer specialties that actually have at least one clinic, so a
  // user can never pick a value that zeroes-out the result list. The
  // currently-selected value is always kept (even if it has no clinics now)
  // so the form round-trips correctly and the result count stays truthful.
  let specialtyChoices: string[] = SPECIALTIES;
  try {
    const withClinics = getAvailableSpecialties(SPECIALTIES);
    const set = new Set(withClinics);
    if (spesialitet) set.add(spesialitet);
    specialtyChoices = SPECIALTIES.filter((s) => set.has(s));
  } catch { /* db not ready — fall back to full list */ }
  const specialtyOptions = specialtyChoices
    .map(
      (s) =>
        `<option value="${escapeHtml(s)}"${spesialitet === s ? " selected" : ""}>${escapeHtml(s)}</option>`
    )
    .join("");

  const resultCards =
    agents.length > 0
      ? agents.map(clinicCard).join("")
      : `<div class="empty-state">
          <h3>Ingen klinikker funnet</h3>
          <p>Prøv å fjerne noen filtre, eller søk etter et annet sted.</p>
          <a href="/sok" class="btn-secondary" style="margin-top:16px">Nullstill søk</a>
        </div>`;

  const html = `
<main>
  <div class="search-wrap">
    <div class="container">
      <form method="GET" action="/sok" role="search" aria-label="Filtrer søk etter tannlege">
        <div class="filter-row">
          <div class="filter-group" style="flex:1;min-width:200px">
            <label for="q">Søk</label>
            <input id="q" name="q" type="search" value="${escapeHtml(q)}" placeholder="Navn eller poststed...">
          </div>
          <div class="filter-group">
            <label for="fylke">Fylke</label>
            <select id="fylke" name="fylke">
              <option value="">Alle fylker</option>
              ${(() => {
                let stats2 = { per_fylke: [] as Array<{ fylke: string; count: number }> };
                try { stats2 = getCachedDentalStats(); } catch { /* ok */ }
                return canonicalFylker(stats2.per_fylke)
                  .map((f) => `<option value="${escapeHtml(f.fylke)}"${fylke === f.fylke ? " selected" : ""}>${escapeHtml(f.fylke)} (${f.count})</option>`)
                  .join("");
              })()}
            </select>
          </div>
          <div class="filter-group">
            <label for="spesialitet">Spesialitet</label>
            <select id="spesialitet" name="spesialitet">
              <option value="">Alle spesialiteter</option>
              ${specialtyOptions}
            </select>
          </div>
          <div class="filter-group" style="flex-direction:row;align-items:flex-end;gap:16px;padding-bottom:2px">
            <label class="filter-check">
              <input type="checkbox" name="helfo" value="1"${helfo ? " checked" : ""}> Helfo-avtale
            </label>
            <label class="filter-check">
              <input type="checkbox" name="akutt" value="1"${akutt ? " checked" : ""}> Akuttvakt
            </label>
          </div>
          <div class="filter-group" style="padding-bottom:2px">
            <button type="submit" class="btn-primary">Søk</button>
          </div>
        </div>
      </form>
    </div>
  </div>

  <div class="container" style="padding-top:28px;padding-bottom:48px">
    <p class="result-meta">${total.toLocaleString("nb")} klinikker funnet${q ? ` for «${escapeHtml(q)}»` : ""}${fylke ? ` i ${escapeHtml(fylke)}` : ""} &mdash; viser side ${page} av ${totalPages}</p>
    ${tolkning && tolkning.tolket_som.length > 0
      ? `<p class="result-meta">${tolkning.fallback ? "Ingen treff med tolkningen (" + escapeHtml(tolkning.tolket_som.join(" · ")) + ") &mdash; viser treff på hele søketeksten." : "Tolket som: " + escapeHtml(tolkning.tolket_som.join(" · "))}</p>`
      : ""}
    <div class="clinic-list" role="list" aria-label="Søkeresultater">
      ${resultCards}
    </div>
    ${paginationHtml(page, totalPages, baseUrl)}
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  recordAiPageDelivery(req, res, "ai_page_list", agents.map((a) => a.id), "dental");
  res.send(dentalShell(html, {
    title: q ? `${q} — Tannlege søk` : "Søk etter tannlege — Finn-tannlege.com",
    description: `Søk blant ${total} tannlegeklinikker i Norge. Filtrer på Helfo-avtale, spesialitet og fylke.`,
    canonical: `${DENTAL_BASE_URL}/sok`,
    // noindex on every /sok variant, with or without q (dev-request
    // 2026-10-16-finn-tannlege-landingssider, F1-S1), as on rettfrabonden.com:
    // /sok?q= is an unbounded query space. follow keeps link equity flowing
    // to the clinic pages listed in the results; /sted, /fylke and
    // /spesialitet are the indexable lists.
    robots: "noindex, follow",
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /klinikk/:slug  +  GET /klinikk/id/:id
// ═══════════════════════════════════════════════════════════

// ─── PR-116: BreadcrumbList JSON-LD helper ───────────────────
interface BreadcrumbItem { name: string; url: string; }
function breadcrumbJsonLd(items: BreadcrumbItem[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

function renderClinicProfile(
  stored: DentalAgent & { id: string },
  req: Request,
  res: Response
): void {
  // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
  // treffvakt (A4-D): the page, its JSON-LD, its descriptions and its
  // thin-profile check read the values the Places display rule shows
  // (dental-places-display.ts). A hidden address, phone, website or opening
  // hours is left out as if unknown; postnummer, place, map and coordinates
  // stay (Daniel 2026-10-18T17:01Z).
  const agent = shownDentalAgent(stored);
  // dev-request 2026-10-01-dental-testrad-ut-av-offentlig-visning: the
  // synthetic schema-probe row 404s exactly like a rejected clinic, on both
  // /klinikk/id/:id and /klinikk/:slug (both render through here).
  if (agent.verification_status === "rejected" || isDentalSyntheticProbeId(agent.id)) {
    sendDentalNotFound(res,
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    );
    return;
  }

  const slug = slugifyClinic(agent.navn, agent.org_nr ?? undefined);
  const canonical = clinicProfileUrl(agent);

  // ── Header badges
  // dev-request 2026-10-06-dental-nedlagte-og-akuttpastander (skive A): a
  // permanently-closed clinic still renders (so inbound links don't 404) but
  // shows a "Nedlagt" notice, no positive badges, and noindex.
  const inactive = agent.is_inactive === 1;
  const badges: string[] = [];
  if (inactive)
    badges.push(`<span class="badge" style="background:#FEE2E2;color:#7F1D1D;border:1px solid #FECACA">Nedlagt</span>`);
  if (!inactive && agent.verification_status === "verified")
    badges.push(`<span class="badge badge-verified">Verifisert</span>`);
  if (!inactive && agent.helfo_agreement === "true")
    badges.push(`<span class="badge badge-helfo">Helfo-direkteoppgjør</span>`);
  if (!inactive) {
    const acute = resolveAcuteClaim(agent);
    if (acute === "vakt") badges.push(`<span class="badge badge-akutt">Akuttvakt</span>`);
    else if (acute === "accepts") badges.push(`<span class="badge badge-akutt">${ACUTE_ACCEPTS_LABEL}</span>`);
  }
  if (agent.chain_brand)
    badges.push(`<span class="badge badge-chain">${escapeHtml(agent.chain_brand)}</span>`);

  // ── Rating badge (Google Places)
  // The stored rating (PR-130) goes through the same policy as on RFB
  // (structured-data-policy.ts), here and in the info row below: nothing in
  // RATING_DISPLAY_MODE 'hidden', the mode since S4-A1a (dev-request
  // 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt);
  // otherwise Google named as the source and never "0 anmeldelser".
  const ratingDisplay = formatRatingDisplay({ rating: agent.rating, count: agent.rating_count, source: "google" }, "no");
  if (ratingDisplay) {
    badges.push(`<span class="badge badge-rating" style="background:#FEF9C3;color:#713F12;border:1px solid #FDE68A">${escapeHtml(ratingDisplay.text)}</span>`);
  }

  // ── Price band badge
  // rimelig=green, standard=yellow, premium=red, ukjent/null=hidden
  if ((agent as any).price_band && (agent as any).price_band !== "ukjent") {
    const pb: string = (agent as any).price_band;
    const pbStyles: Record<string, string> = {
      rimelig: "background:#DCFCE7;color:#166534;border:1px solid #BBF7D0",
      standard: "background:#FEF9C3;color:#713F12;border:1px solid #FDE68A",
      premium: "background:#FEE2E2;color:#991B1B;border:1px solid #FECACA",
    };
    const pbLabels: Record<string, string> = {
      rimelig: "💚 Rimelig",
      standard: "🟡 Standard",
      premium: "🔴 Premium",
    };
    const style = pbStyles[pb] ?? "";
    const label = pbLabels[pb] ?? pb;
    if (style) {
      badges.push(`<span class="badge badge-price-band" style="${style}">${escapeHtml(label)}</span>`);
    }
  }

  // ── Action buttons
  const _callTelHref = safeTelHref(agent.telefon);
  const callBtn = _callTelHref
    ? `<a href="${_callTelHref}" class="btn-call">${ICON_PHONE} Ring ${escapeHtml(agent.telefon)}</a>`
    : "";
  const _bookUrl = safeUrl(agent.online_booking_url);
  const bookBtn = _bookUrl
    ? `<a href="${escapeHtml(_bookUrl)}" rel="nofollow noopener" target="_blank" class="btn-book">Book time online</a>`
    : "";

  // ── Om oss
  const omOssSection = agent.om_oss
    ? `<div class="section-box"><h2>Om klinikken</h2><p style="font-size:.95rem;color:var(--g700);line-height:1.7">${escapeHtml(agent.om_oss)}</p></div>`
    : "";

  // ── Key info grid
  const infoItems: string[] = [];
  const postnummer = shownPostnummer(agent.postnummer);
  // A4-D: when the Places display rule hides the address, the postnummer and
  // place the Adresse line carried stay visible on a line of their own (Daniel
  // 17:01Z: postnummer stays). Only then: a shown address, or none stored, is
  // as before.
  if (agent.adresse) infoItems.push(`<div class="info-item"><div class="info-label">Adresse</div><div class="info-value">${escapeHtml(agent.adresse)}${postnummer ? `, ${escapeHtml(postnummer)}` : ""}${agent.poststed ? ` ${escapeHtml(agent.poststed)}` : ""}</div></div>`);
  else if (stored.adresse && (postnummer || agent.poststed)) infoItems.push(`<div class="info-item"><div class="info-label">Postnummer og sted</div><div class="info-value">${[postnummer, agent.poststed].filter(Boolean).map((v) => escapeHtml(v!)).join(" ")}</div></div>`);
  { const h = safeTelHref(agent.telefon); if (h) infoItems.push(`<div class="info-item"><div class="info-label">Telefon</div><div class="info-value"><a href="${h}">${escapeHtml(agent.telefon)}</a></div></div>`); }
  { const h = safeTelHref(agent.mobil); if (h) infoItems.push(`<div class="info-item"><div class="info-label">Mobil</div><div class="info-value"><a href="${h}">${escapeHtml(agent.mobil)}</a></div></div>`); }
  if (agent.epost) infoItems.push(`<div class="info-item"><div class="info-label">E-post</div><div class="info-value"><a href="mailto:${escapeHtml(agent.epost)}">${escapeHtml(agent.epost)}</a></div></div>`);
  { const u = safeUrl(agent.hjemmeside); if (u) infoItems.push(`<div class="info-item"><div class="info-label">Hjemmeside</div><div class="info-value"><a href="${escapeHtml(addUtmParams(u, CLINIC_SITE_UTM.source, "referral", CLINIC_SITE_UTM.campaign))}" rel="nofollow noopener" target="_blank">${escapeHtml(u.replace(/^https?:\/\//,""))}</a></div></div>`); }
  // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5d):
  // directory_url is NEVER the clinic's own homepage (that's `hjemmeside`
  // above) -- it's a county-directory listing, a Facebook page, or similar.
  // Label it accordingly so a visitor never mistakes it for the clinic's site.
  { const u = safeUrl(agent.directory_url); if (u) infoItems.push(`<div class="info-item"><div class="info-label">${escapeHtml(directoryUrlLabel(u))}</div><div class="info-value"><a href="${escapeHtml(u)}" rel="nofollow noopener" target="_blank">${escapeHtml(u.replace(/^https?:\/\//,""))}</a></div></div>`); }
  if (agent.org_nr) infoItems.push(`<div class="info-item"><div class="info-label">Organisasjonsnr.</div><div class="info-value">${escapeHtml(agent.org_nr)}</div></div>`);
  if (agent.registreringsdato) infoItems.push(`<div class="info-item"><div class="info-label">Registrert</div><div class="info-value">${escapeHtml(agent.registreringsdato)}</div></div>`);
  if (agent.antall_ansatte !== null && agent.antall_ansatte !== undefined) infoItems.push(`<div class="info-item"><div class="info-label">Antall ansatte</div><div class="info-value">${escapeHtml(String(agent.antall_ansatte))}</div></div>`);
  if (agent.chain_brand) infoItems.push(`<div class="info-item"><div class="info-label">Kjede</div><div class="info-value">${escapeHtml(agent.chain_brand)}</div></div>`);
  // Rating info item — the badge's text, under the same policy (S4-A1a)
  if (ratingDisplay) {
    infoItems.push(`<div class="info-item"><div class="info-label">Vurdering</div><div class="info-value">${escapeHtml(ratingDisplay.text)}</div></div>`);
  }
  // Price band info item — only if present and not 'ukjent'
  if ((agent as any).price_band && (agent as any).price_band !== "ukjent") {
    const pbLabels: Record<string, string> = { rimelig: "Rimelig", standard: "Standard", premium: "Premium" };
    const pbLabel = pbLabels[(agent as any).price_band] ?? (agent as any).price_band;
    infoItems.push(`<div class="info-item"><div class="info-label">Prisnivå</div><div class="info-value">${escapeHtml(pbLabel)}</div></div>`);
  }

  const keyInfoSection = infoItems.length > 0
    ? `<div class="section-box"><h2>Nøkkelinformasjon</h2><div class="info-grid">${infoItems.join("")}</div></div>`
    : "";

  // ── Opening hours
  let hoursSection = "";
  if (agent.opening_hours && agent.opening_hours.length > 0) {
    const rows = agent.opening_hours.map((h) => {
      const dayName = DAY_NAMES_NO[h.day] || h.day;
      const open = isOpenNow([h]);
      return `<tr><td>${escapeHtml(dayName)}</td><td>${escapeHtml(h.open)}–${escapeHtml(h.close)}</td><td>${open ? '<span class="badge badge-open" style="font-size:.7rem">Åpent nå</span>' : ""}</td></tr>`;
    }).join("");
    hoursSection = `<div class="section-box"><h2>Åpningstider</h2><table class="hours-table" aria-label="Åpningstider"><tbody>${rows}</tbody></table></div>`;
  }

  // ── Specialists & specialties
  let specialistSection = "";
  const specList: string[] = [];
  if (agent.specialists && agent.specialists.length > 0) {
    const specRows = agent.specialists.map(
      (s) => `<li style="font-size:.9rem;padding:4px 0">${escapeHtml(s.name)}${s.title ? ` — <span style="color:var(--g500)">${escapeHtml(s.title)}</span>` : ""}</li>`
    ).join("");
    specList.push(`<ul style="list-style:none;padding:0">${specRows}</ul>`);
  }
  if (agent.available_specialties && agent.available_specialties.length > 0) {
    const specTags = agent.available_specialties.map((s) => {
      const sp = SPECIALTY_PAGES.find((p) => p.navn === s.toLowerCase());
      return sp
        ? `<a href="/spesialitet/${escapeHtml(sp.slug)}" class="spec-tag" style="text-decoration:none;color:var(--teal-700)">${escapeHtml(s)}</a>`
        : `<span class="spec-tag">${escapeHtml(s)}</span>`;
    });
    specList.push(`<div class="spec-list" style="margin-top:12px">${specTags.join("")}</div>`);
  }
  if (specList.length > 0) {
    specialistSection = `<div class="section-box"><h2>Spesialister og spesialiteter</h2>${specList.join("")}</div>`;
  }

  // ── Treatments
  let treatmentsSection = "";
  if (agent.treatments && agent.treatments.length > 0) {
    const tags = agent.treatments.map((t) => `<a href="/sok?q=${encodeURIComponent(t)}" class="spec-tag" style="text-decoration:none;color:var(--navy)">${escapeHtml(t)}</a>`).join("");
    const subTypes = agent.treatments_subtypes
      ? Object.entries(agent.treatments_subtypes).map(([k, vs]) =>
          `<li style="font-size:.85rem;color:var(--g700)"><strong>${escapeHtml(k)}:</strong> ${(vs as string[]).map(escapeHtml).join(", ")}</li>`
        ).join("")
      : "";
    treatmentsSection = `<div class="section-box"><h2>Behandlinger</h2><div class="spec-list">${tags}</div>${subTypes ? `<ul style="margin-top:12px;padding-left:18px">${subTypes}</ul>` : ""}</div>`;
  }

  // ── Practical info
  const practicalItems: string[] = [];
  if (agent.payment_options && agent.payment_options.length > 0)
    practicalItems.push(`<div class="info-item"><div class="info-label">Betalingsmåter</div><div class="info-value">${agent.payment_options.map(escapeHtml).join(", ")}</div></div>`);
  if (agent.languages_spoken && agent.languages_spoken.length > 0)
    practicalItems.push(`<div class="info-item"><div class="info-label">Språk</div><div class="info-value">${agent.languages_spoken.map(escapeHtml).join(", ")}</div></div>`);
  if (agent.accessibility && agent.accessibility.length > 0)
    practicalItems.push(`<div class="info-item"><div class="info-label">Tilgjengelighet</div><div class="info-value">${agent.accessibility.map(escapeHtml).join(", ")}</div></div>`);
  if (agent.patient_focus && agent.patient_focus.length > 0)
    practicalItems.push(`<div class="info-item"><div class="info-label">Pasientfokus</div><div class="info-value">${agent.patient_focus.map(escapeHtml).join(", ")}</div></div>`);
  if (agent.treatment_tech && agent.treatment_tech.length > 0)
    practicalItems.push(`<div class="info-item"><div class="info-label">Teknologi</div><div class="info-value">${agent.treatment_tech.map(escapeHtml).join(", ")}</div></div>`);
  const practicalSection = practicalItems.length > 0
    ? `<div class="section-box"><h2>Praktisk informasjon</h2><div class="info-grid">${practicalItems.join("")}</div></div>`
    : "";

  // ── Map link
  const mapSection = agent.lat && agent.lng
    ? `<div class="section-box"><h2>Kart</h2><p style="font-size:.9rem"><a href="https://www.google.com/maps/search/?api=1&query=${agent.lat},${agent.lng}" rel="nofollow noopener" target="_blank">Se på Google Maps &rarr;</a></p></div>`
    : "";

  // ── JSON-LD Dentist
  // orch-PR-20260613: guard placeholder/empty om_oss; fall back to structured summary.
  const richDesc = !isPlaceholderDescription(agent.om_oss) ? agent.om_oss! : null;
  // «Det finnes N klinikker i X» (structured meta only): N is what
  // /sted/<poststed> shows — same slug group, same filter, every spelling
  // (D3b) — so a place with 978 clinics no longer reads «21» (integrasjonstest
  // IDX2-02, dev-request 2026-10-17-integrasjonstest-oppfolging I-Q). No /sted
  // page, or no DB, = 0 and the sentence is left out.
  let localityCount = 0;
  const stedGroup = !richDesc && isValidLocality(agent.poststed) ? findStedGroup(slugifyText(agent.poststed!)) : undefined;
  if (stedGroup) {
    try { localityCount = countPublicDentalAgents(stedFilter(stedGroup)); } catch { /* db not ready */ }
  }
  const clinicJsonLdDesc = richDesc ?? buildClinicDescription(agent, localityCount, false);
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dentist",
    // @id makes the node referenceable and de-dupes across pages (mirrors rfb LocalBusiness).
    "@id": `${canonical}#dentist`,
    name: agent.navn,
    description: clinicJsonLdDesc,
    url: canonical,
    // orch-PR-20260613: favicon-as-image is a quality negative for Google rich results.
    // Only emit image if a real clinic image/logo URL exists; otherwise omit the field.
    // (The ogImage on the page shell still falls back to favicon.svg for social sharing.)
    // orch-PR-20260613: no real image field in DentalAgent; image is omitted
    // rather than falling back to favicon.svg which is a quality negative.
    ...(isDisplayablePhone(agent.telefon) ? { telephone: agent.telefon } : {}),
    ...(agent.epost ? { email: agent.epost } : {}),
    ...(safeUrl(agent.hjemmeside) ? { sameAs: safeUrl(agent.hjemmeside) } : {}),
    address: {
      "@type": "PostalAddress",
      ...(agent.adresse ? { streetAddress: agent.adresse } : {}),
      ...(postnummer ? { postalCode: postnummer } : {}),
      // orch-PR-20260613: guard malformed/foreign locality values (e.g. "Se-44338 Lerum", "Ukjent")
      // D3d trinn 3: the official spelling, as in the title ("Tromsø", not "Tromsoe")
      ...(isValidLocality(agent.poststed) ? { addressLocality: officialPlaceLabel(agent.poststed!) } : {}),
      ...(isValidLocality(agent.fylke) ? { addressRegion: agent.fylke } : {}),
      addressCountry: "NO",
    },
    ...((isValidLocality(agent.poststed) || isValidLocality(agent.fylke))
      ? { areaServed: { "@type": "City", name: isValidLocality(agent.poststed) ? officialPlaceLabel(agent.poststed!) : agent.fylke } }
      : {}),
    ...(agent.lat && agent.lng
      ? { geo: { "@type": "GeoCoordinates", latitude: agent.lat, longitude: agent.lng } }
      : {}),
  };
  // medicalSpecialty — only emit fields that exist (Schema.org MedicalSpecialty as free text).
  if (agent.available_specialties && agent.available_specialties.length > 0) {
    jsonLd.medicalSpecialty = agent.available_specialties.length === 1
      ? agent.available_specialties[0]
      : agent.available_specialties;
  }
  if (agent.opening_hours && agent.opening_hours.length > 0) {
    const dayMap: Record<string, string> = {
      mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
      fri: "Friday", sat: "Saturday", sun: "Sunday",
    };
    jsonLd.openingHoursSpecification = agent.opening_hours.map((h) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: `https://schema.org/${dayMap[h.day] || h.day}`,
      opens: h.open,
      closes: h.close,
    }));
  }

  // ── Fylke back-link
  // orch-PR-20260613: only render fylke back-link for valid/canonical fylke values
  const fylkeLink = isValidLocality(agent.fylke)
    ? `<p style="margin-top:32px;font-size:.9rem"><a href="/fylke/${encodeURIComponent(agent.fylke!)}">&larr; Flere tannleger i ${escapeHtml(agent.fylke!)}</a></p>`
    : "";

  // ── PR-116: Related clinics (same poststed)
  let relatedSection = "";
  if (agent.poststed) {
    let related: Array<DentalAgent & { id: string }> = [];
    try { related = listRelatedClinics(agent, 6); } catch { /* db not ready */ }
    if (related.length > 0) {
      const stedSlug = slugifyText(agent.poststed);
      const titledSted = officialPlaceLabel(agent.poststed);
      const relatedCards = related.map(clinicCard).join("");
      relatedSection = `<div class="section-box" style="margin-top:20px">
  <h2>Flere tannleger i ${escapeHtml(titledSted)}</h2>
  <div class="clinic-list" role="list" style="margin-top:12px">${relatedCards}</div>
  <p style="margin-top:16px;font-size:.9rem">
    <a href="/sted/${escapeHtml(stedSlug)}">Se alle tannleger i ${escapeHtml(titledSted)} &rarr;</a>
    ${agent.fylke ? `&ensp;&middot;&ensp;<a href="/fylke/${encodeURIComponent(agent.fylke)}">Se alle i ${escapeHtml(agent.fylke)} &rarr;</a>` : ""}
  </p>
</div>`;
    }
  }

  // ── Updated_at disclaimer
  const updatedAt = (agent as any).updated_at;
  const disclaimer = updatedAt
    ? `<p class="disclaimer">Informasjonen er hentet fra offentlige registre og klinikkens egne sider, sist oppdatert ${escapeHtml(String(updatedAt).split("T")[0] || String(updatedAt))}. Kontakt oss på <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a> ved feil.</p>`
    : `<p class="disclaimer">Informasjonen er hentet fra Brønnøysundregistrene og offentlig tilgjengelige kilder. Kontakt oss på <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a> ved feil.</p>`;

  // ── PR-116: BreadcrumbList for profile
  // orch-PR-20260613: guard malformed locality in breadcrumb
  // D3d trinn 3: the official name; the /sted URL keeps the stored value's slug,
  // which officialPlaceLabel's name always shares.
  const profileBreadcrumbItems: BreadcrumbItem[] = [{ name: "Hjem", url: DENTAL_BASE_URL }];
  if (isValidLocality(agent.fylke)) profileBreadcrumbItems.push({ name: agent.fylke!, url: `${DENTAL_BASE_URL}/fylke/${encodeURIComponent(agent.fylke!)}` });
  if (isValidLocality(agent.poststed)) profileBreadcrumbItems.push({ name: officialPlaceLabel(agent.poststed!), url: `${DENTAL_BASE_URL}/sted/${slugifyText(agent.poststed!)}` });
  profileBreadcrumbItems.push({ name: agent.navn, url: canonical });
  // skive C: a non-clinic must not claim to be a schema.org Dentist.
  const nonClinic = isNonClinicProfile(agent);
  const jsonLdArr = nonClinic
    ? [breadcrumbJsonLd(profileBreadcrumbItems)]
    : [jsonLd, breadcrumbJsonLd(profileBreadcrumbItems)];

  // ── dev-request 2026-10-17-dental-d3-rettelser (D3e): another clinic with
  // the same name in the same place (any spelling of it) would share this
  // page's title and meta description. The title then reads «i 0190 Oslo» or
  // ends «(org.nr N)», and the meta's opening sentence says the same. H1 and
  // the JSON-LD name stay the registered name. No namesake = no change.
  let namesakes: DentalNamesake[] = [];
  try {
    const spellings = agent.poststed ? findStedGroup(slugifyText(agent.poststed))?.spellings : undefined;
    namesakes = listDentalNamesakes(agent, spellings);
  } catch { /* db not ready */ }
  const namesake = namesakeDisambiguator(agent, namesakes);

  // ── orch-PR-20260613: unique meta description
  // Use rich om_oss (when not a placeholder) or a structured-field summary.
  // This replaces the old generic template that caused near-duplicate thin content
  // on 88% of clinic pages and prevented Google from indexing them.
  const metaDesc: string = (() => {
    if (richDesc) {
      // Trim rich description to 160 chars at sentence boundary
      if (richDesc.length <= 160) return richDesc;
      let t = richDesc.slice(0, 157);
      const dot = t.lastIndexOf(".");
      return dot > 60 ? t.slice(0, dot + 1) : t + "…";
    }
    if (nonClinic) {
      return `${agent.navn}${isValidLocality(agent.poststed) ? ` i ${officialPlaceLabel(agent.poststed!)}` : ""}. Registeroppføring.`;
    }
    return buildClinicDescription(agent, localityCount, true, namesake);
  })();

  // dev-request 2026-09-02-dental-profilkvalitet-finn-tannlege (5b): a
  // profile missing ALL FOUR of address/phone/website/opening-hours gets
  // noindex + a "claim this profile" CTA instead of being indexed as-is.
  // Scaffolding only — no DB write from the CTA itself, just a mailto: link
  // a real owner can use; a future slice can turn this into a real claim flow.
  const thin = isThinDentalProfile(agent);
  const inactiveNotice = inactive
    ? `<div class="section-box" role="status" style="border:1px solid #FECACA;background:#FEF2F2">
    <p style="font-size:.95rem;margin:0;color:#7F1D1D"><strong>Nedlagt.</strong> Denne klinikken er registrert som nedlagt og tar ikke lenger imot pasienter. Informasjonen under er historisk.</p>
  </div>`
    : "";
  const thinProfileCta = thin && !inactive
    ? `<div class="section-box" style="border:1px solid #FDE68A;background:#FFFBEB">
    <p style="font-size:.95rem;margin:0;color:var(--g700)">
      Ufullstendig oppføring — er dette din klinikk?
      <a href="mailto:kontakt@finn-tannlege.com?subject=${encodeURIComponent(
        `Ufullstendig oppføring — org.nr ${agent.org_nr ?? "ukjent"}`
      )}">Send oss riktig informasjon</a>
    </p>
  </div>`
    : "";

  // (5b) Title template: an ENK/sole-proprietor row with no clinic-indicating
  // word in its name is a single dentist, not a clinic -- "Tannlege <navn> i
  // <by>" rather than the generic clinic template. Non-ENK case is
  // byte-identical to before this dev-request.
  // skive C: lab/holding get a neutral title; person_enk keeps the
  // sole-proprietor wording (display-name decision for ENK is a separate item).
  // D3e: a namesake's page names its place with the postnummer or adds the
  // org.nr, in all three templates; otherwise the place reads as before.
  // D3d trinn 3: both labels (here and in namesakeDisambiguator) name the
  // place by officialPlaceLabel, so a title never mixes «Tromsoe» and «Tromsø».
  const titlePlace = namesake && "place" in namesake ? namesake.place : agent.poststed ? officialPlaceLabel(agent.poststed) : null;
  const titleLocality = `${titlePlace ? ` i ${titlePlace}` : ""}${namesake && "orgnr" in namesake ? ` (org.nr ${namesake.orgnr})` : ""}`;
  const profileTitleCore = nonClinic && agent.catalog_class !== "person_enk"
    ? `${agent.navn}${titleLocality}`
    : isSoleProprietorProfile(agent)
    ? `Tannlege ${agent.navn}${titleLocality}`
    : `${agent.navn} — Tannlegeklinikk${titleLocality}`;

  const html = `
<main>
  <div class="profile-header" role="banner">
    <div class="container">
      <div class="clinic-badges" style="margin-bottom:12px">${badges.join("")}</div>
      <h1 class="profile-name">${escapeHtml(agent.navn)}</h1>
      <div class="profile-loc">${ICON_PIN} ${isValidLocality(agent.poststed) ? escapeHtml(officialPlaceLabel(agent.poststed!)) : ""}${isValidLocality(agent.poststed) && isValidLocality(agent.fylke) ? `, ${escapeHtml(agent.fylke!)}` : !isValidLocality(agent.poststed) && isValidLocality(agent.fylke) ? escapeHtml(agent.fylke!) : ""}</div>
      <div class="profile-actions">${callBtn}${bookBtn}</div>
    </div>
  </div>
  <div class="container" style="padding-top:32px;padding-bottom:48px">
    ${aiDeliveriesTileFor("dental", agent.id)}
    ${inactiveNotice}
    ${thinProfileCta}
    ${omOssSection}
    ${keyInfoSection}
    ${hoursSection}
    ${specialistSection}
    ${treatmentsSection}
    ${practicalSection}
    ${mapSection}
    ${relatedSection}
    ${fylkeLink}
    ${disclaimer}
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  recordAiPageDelivery(req, res, "ai_page_profile", [agent.id], "dental");
  res.send(dentalShell(html, {
    title: `${profileTitleCore} | Finn-tannlege.com`,
    description: metaDesc,
    ...(thin || inactive || nonClinic ? { robots: "noindex,follow" } : {}),
    canonical,
    jsonLd: jsonLdArr,
  }));
}

router.get("/klinikk/id/:id", (req: Request, res: Response) => {
  const agent = getDentalAgentById(String(req.params.id));
  if (!agent) {
    sendDentalNotFound(res,
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    );
    return;
  }
  renderClinicProfile(agent, req, res);
});

router.get("/klinikk/:slug", (req: Request, res: Response) => {
  const parsed = parseClinicSlug(String(req.params.slug));
  if (!parsed) {
    sendDentalNotFound(res,
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    );
    return;
  }
  const agent = getDentalAgentByOrgnr(parsed.orgNr);
  if (!agent) {
    sendDentalNotFound(res,
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    );
    return;
  }
  renderClinicProfile(agent, req, res);
});

// ═══════════════════════════════════════════════════════════
// GET /fylke/:fylke
// ═══════════════════════════════════════════════════════════

router.get("/fylke/:fylke", (req: Request, res: Response) => {
  const fylkeParam = String(req.params.fylke);

  let stats = { per_fylke: [] as Array<{ fylke: string; count: number }> };
  try { stats = getCachedDentalStats(); } catch { /* ok */ }

  // Case-insensitive match — canonical fylker only (PR-111)
  const matchedFylke = canonicalFylker(stats.per_fylke).find(
    (f) => f.fylke.toLowerCase() === fylkeParam.toLowerCase()
  );
  if (!matchedFylke) {
    sendDentalNotFound(res,
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Ukjent fylke</h3><p>Vi fant ikke «${escapeHtml(fylkeParam)}» i registeret.</p><a href="/#fylker" class="btn-secondary" style="margin-top:16px">Se alle fylker</a></div></div>`,
      { title: `${fylkeParam} — Fylke ikke funnet | Finn-tannlege.com` }
    );
    return;
  }

  // Count first, so a ?side= past the last page falls back to page 1 (F1-S1).
  let total = 0;
  try { total = countPublicDentalAgents({ fylke: matchedFylke.fylke }); } catch { /* ok */ }
  const { page, offset, totalPages } = resolveListPage(req.query.side, total);
  let agents: Array<DentalAgent & { id: string }> = [];
  try {
    agents = listPublicDentalAgents({ fylke: matchedFylke.fylke }, DENTAL_LANDING_CONFIG.listPageSize, offset);
  } catch { /* ok */ }

  const baseUrl = `/fylke/${encodeURIComponent(matchedFylke.fylke)}`;
  // Page 1 keeps the bare canonical; page N ≥ 2 is its own (F1-S1).
  const pageUrl = `${DENTAL_BASE_URL}${listPageHref(baseUrl, page)}`;
  const pageMeta = listPageMeta(page, totalPages);
  const itemList = dentalItemListJsonLd(`Tannleger i ${matchedFylke.fylke}`, pageUrl, agents, offset);

  // PR-116: Poststed chips for this fylke (≥2 clinics, max 30). One chip per
  // /sted group, with the group's count, in the fylke of its main row (D3b).
  const fylkePoststeder = stedGroups().bySize
    .filter((g) => g.row.fylke && g.row.fylke.toLowerCase() === matchedFylke.fylke.toLowerCase() && g.count >= 2)
    .slice(0, 30);
  const poststedChips = fylkePoststeder.length > 0
    ? `<div style="margin-top:40px">
  <div class="section-title" style="font-size:1rem;margin-bottom:10px">Steder i ${escapeHtml(matchedFylke.fylke)}</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">
    ${fylkePoststeder.map((g) => `<a href="/sted/${escapeHtml(slugifyText(g.row.poststed))}" class="spec-chip">${escapeHtml(titleCasePoststed(g.row.poststed))} <span style="font-size:.75em;opacity:.7">(${g.count})</span></a>`).join("")}
  </div>
</div>` : "";

  // PR-116: BreadcrumbList
  const fylkeBreadcrumb = breadcrumbJsonLd([
    { name: "Hjem", url: DENTAL_BASE_URL },
    { name: matchedFylke.fylke, url: `${DENTAL_BASE_URL}${baseUrl}` },
  ]);

  const html = `
<main>
  <div class="profile-header">
    <div class="container">
      <p style="font-size:.85rem;opacity:.7;margin-bottom:8px"><a href="/#fylker" style="color:rgba(255,255,255,.7)">&larr; Alle fylker</a></p>
      <h1 class="profile-name">Tannleger i ${escapeHtml(matchedFylke.fylke)}</h1>
      <p style="opacity:.8;font-size:.95rem">${total.toLocaleString("nb")} klinikker registrert</p>
    </div>
  </div>
  <div class="container" style="padding-top:28px;padding-bottom:48px">
    <p class="result-meta">Side ${page} av ${totalPages}</p>
    <div class="clinic-list" role="list" aria-label="Tannleger i ${escapeHtml(matchedFylke.fylke)}">
      ${agents.length > 0 ? agents.map(clinicCard).join("") : `<div class="empty-state"><h3>Ingen klinikker funnet</h3></div>`}
    </div>
    ${paginationHtml(page, totalPages, baseUrl)}
    ${poststedChips}
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  recordAiPageDelivery(req, res, "ai_page_list", agents.map((a) => a.id), "dental");
  res.send(dentalShell(html, {
    title: `Tannleger i ${matchedFylke.fylke}${pageMeta.title} — Finn-tannlege.com`,
    description: `Oversikt over ${total} tannlegeklinikker i ${matchedFylke.fylke}. Finn klinikk med Helfo-avtale, spesialitet eller tannlegevakt.${pageMeta.description}`,
    canonical: pageUrl,
    jsonLd: [itemList, fylkeBreadcrumb],
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /om
// ═══════════════════════════════════════════════════════════

router.get("/om", (_req: Request, res: Response) => {
  const html = `
<main>
  <div class="content-page">
    <h1>Om Finn-tannlege.com</h1>
    <p>Finn-tannlege.com er en uavhengig oversikt over tannlegeklinikker i Norge. Vi er ikke tilknyttet noen klinikkjede, forsikringsselskap eller bestillingsportal. ${escapeHtml(FINN_DISAMBIGUATION_NB)}</p>

    <h2>Hva vi tilbyr</h2>
    <p>Vi samler informasjon om tannlegeklinikker fra offentlig tilgjengelige kilder og gjør den søkbar og lettleselig for alle. Du kan søke på by, fylke, spesialitet, Helfo-avtale og akuttilbud.</p>

    <h2>Datakilder</h2>
    <ul>
      <li><strong>Brønnøysundregistrene</strong> — Enhetsregisteret, organisasjonsdata og kontaktinformasjon</li>
      <li><strong>Helsedirektoratet / HPR</strong> — Helsepersonellregisteret, spesialistdata</li>
      <li><strong>Den norske tannlegeforening (NTF)</strong> — Spesialistlister og fagdata</li>
      <li><strong>Klinikkenes egne nettsider</strong> — Åpningstider, behandlingstilbud og kontaktinformasjon</li>
    </ul>

    <h2>Oppdatering av klinikkprofil</h2>
    <p>Klinikker kan be om oppdatering eller fjerning av sin profil ved å sende e-post til <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a>. Vi svarer innen 5 virkedager.</p>

    <h2>Om plattformen</h2>
    <p>Finn-tannlege.com er del av A2A-agentplattformen — et system der AI-agenter jobber kontinuerlig med å hente, verifisere og oppdatere klinikkdata fra offentlige registre og åpne nettsider. Data av lavere kvalitet er tydelig merket som uverifisert.</p>

    <p>Søsterplattform: <a href="https://rettfrabonden.com" rel="noopener" target="_blank">rettfrabonden.com</a> — lokal mat direkte fra bønder i Norge.</p>
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Om Finn-tannlege.com — Uavhengig oversikt over tannleger i Norge",
    description: "Om Finn-tannlege.com: datakilder, metodikk og kontakt for klinikker som vil oppdatere sin profil.",
    canonical: `${DENTAL_BASE_URL}/om`,
  }));
});



// ═══════════════════════════════════════════════════════════
// GET /sitemap.xml
// ═══════════════════════════════════════════════════════════

function buildDentalSitemapXml(): string {
  {
    let stats = { per_fylke: [] as Array<{ fylke: string; count: number }> };
    try { stats = getCachedDentalStats(); } catch { /* ok */ }

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    // dev-request 2026-10-16-finn-tannlege-landingssider (F1-S2): <lastmod> is
    // the day a page's content last changed, not the build day. Every static,
    // specialty, fylke and sted URL used to carry today's date on every build
    // (876 of 5 189 URLs), so the signal was worthless. Aggregate pages get
    // the newest updated_at among the clinics they list; static pages the day
    // their text changed (DENTAL_STATIC_PAGE_DATES). No known day = no
    // <lastmod>. This build is cached (createSitemapCache), so the aggregate
    // queries never run per request.
    let lastmods: DentalAggregateLastmods | null = null;
    try { lastmods = getDentalAggregateLastmods({ specialties: SPECIALTY_PAGES.map((sp) => sp.navn) }); } catch { /* db not ready */ }
    const lastmodTag = (d: string | null | undefined): string => (d ? `<lastmod>${d}</lastmod>` : "");
    // One <url> in the order the sitemaps.org 0.9 XSD requires: loc, lastmod
    // (optional), changefreq, priority (dev-request
    // 2026-10-17-dental-d3-rettelser, D3b). <lastmod> used to come last,
    // which made every <url> in the file fail the schema.
    const urlTag = (loc: string, freq: string, pri: string, day?: string | null): string =>
      `<url><loc>${loc}</loc>${lastmodTag(day)}<changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;

    // Static pages. /sok is left out: it is noindex (F1-S1).
    const statics: Array<[string, string, string]> = [
      ["/", "daily", "1.0"],
      ["/hvordan-det-fungerer", "monthly", "0.7"],
      ["/om", "monthly", "0.6"],
      ["/personvern", "monthly", "0.4"],
      ["/vilkar", "monthly", "0.4"],
      ["/proveniens", "monthly", "0.5"],
    ];
    for (const [p, freq, pri] of statics) {
      const day = p === "/" ? lastmods?.all : DENTAL_STATIC_PAGE_DATES[p];
      xml += `\n  ${urlTag(`${DENTAL_BASE_URL}${p === "/" ? "" : p}`, freq, pri, day)}`;
    }

    // Specialty pages (PR-112)
    for (const sp of SPECIALTY_PAGES) {
      xml += `\n  ${urlTag(`${DENTAL_BASE_URL}/spesialitet/${sp.slug}`, "weekly", "0.8", lastmods?.forSpecialty(sp.navn))}`;
    }

    // Fylke pages (canonical only — PR-111)
    for (const f of canonicalFylker(stats.per_fylke)) {
      xml += `\n  ${urlTag(`${DENTAL_BASE_URL}/fylke/${encodeURIComponent(f.fylke)}`, "weekly", "0.8", lastmods?.forFylke(f.fylke))}`;
    }

    // Sted pages (PR-116) — all poststeder with ≥1 clinic. One URL per slug:
    // two spellings of one place ("BERGEN", "Bergen") slug alike and used to
    // be listed twice (integrasjonstest IDX-3). The /sted groups keep the
    // list's order, and the lastmod covers every spelling the page lists (D3b).
    for (const [slug, group] of stedGroups().bySlug) {
      xml += `\n  ${urlTag(`${DENTAL_BASE_URL}/sted/${slug}`, "weekly", "0.75", lastmods?.forPoststed(stedSpellings(group)))}`;
    }

    // Clinic pages — getDentalAgentsForSitemap for lastmod support (PR-116)
    let clinicRows: Array<{ org_nr: string; navn: string; updated_at: string | null }> = [];
    try { clinicRows = getDentalAgentsForSitemap(); } catch { /* fallback to batch */ }

    if (clinicRows.length > 0) {
      for (const a of clinicRows) {
        const slug = slugifyClinic(a.navn, a.org_nr);
        // W3C date (YYYY-MM-DD) like the Opplevagent and RFB sitemaps. updated_at
        // is SQLite datetime('now'), "2026-07-21 11:39:18" (space, no time zone),
        // which split("T") left whole on every /klinikk URL (integrasjonstest
        // IDX2-01, dev-request 2026-10-17-integrasjonstest-oppfolging I-Q).
        // A missing value, or one that is not a date, gives no <lastmod>
        // rather than the build day (F1-S2, D3b).
        const day = (a.updated_at || "").slice(0, 10);
        xml += `\n  ${urlTag(`${DENTAL_BASE_URL}/klinikk/${slug}`, "monthly", "0.7", /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null)}`;
      }
    } else {
      // Fallback: batch from listPublicDentalAgents
      let batchOffset = 0;
      const BATCH = 200;
      while (true) {
        let batch: Array<DentalAgent & { id: string }> = [];
        try { batch = listPublicDentalAgents({}, BATCH, batchOffset); } catch { break; }
        if (batch.length === 0) break;
        for (const a of batch) {
          if (!a.org_nr) continue;
          const slug = slugifyClinic(a.navn, a.org_nr);
          // No <lastmod> here rather than the build day (F1-S2).
          xml += `\n  ${urlTag(`${DENTAL_BASE_URL}/klinikk/${slug}`, "monthly", "0.7")}`;
        }
        batchOffset += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    xml += "\n</urlset>";
    return xml;
  }
}

// Slice C (dev-request 2026-09-29-gsc-strukturerte-data-og-5xx): short-TTL in-memory
// cache (same SITEMAP_CACHE_TTL_MS as rfb). Single domain per router -> one entry.
const dentalSitemapCache = createSitemapCache("dental", buildDentalSitemapXml);
export function getDentalSitemapXml(now?: number, build?: () => string): string {
  return dentalSitemapCache.get(now, build);
}
export function __resetDentalSitemapCacheForTesting(): void {
  dentalSitemapCache.reset();
}

router.get("/sitemap.xml", (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const xml = getDentalSitemapXml();
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", `public, max-age=${Math.floor(resolveSitemapCacheTtlMs() / 1000)}`);
    res.send(xml);
  } catch (err) {
    console.error("[dental-sitemap] error:", err);
    res.status(500).send("Error generating sitemap");
  }
  logSlowSitemap("dental", startedAt);
});

// ═══════════════════════════════════════════════════════════
// GET /<INDEXNOW_KEY>.txt — IndexNow key file
// dev-request 2026-07-04-sokemotor-indeksering-og-lenker slice 1.
// Literal path (not a :param wildcard), so it can't shadow llms.txt
// or any other .txt route — non-matching *.txt requests just fall
// through to the routes/404 handler below unaffected.
// ═══════════════════════════════════════════════════════════

router.get(`/${INDEXNOW_KEY}.txt`, (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(INDEXNOW_KEY);
});

// ═══════════════════════════════════════════════════════════
// GET /robots.txt
// ═══════════════════════════════════════════════════════════

router.get("/robots.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# finn-tannlege.com — robots.txt
# Uavhengig oversikt over tannlegeklinikker i Norge.
# AI-agenter er velkomne til å indeksere og sitere data fra denne tjenesten.
# Content-Signal: søk og AI-input er tillatt, trening av modeller er ikke (ai-train=no).

# LLM-vennlige endepunkter
# Oversikt:      ${DENTAL_BASE_URL}/llms.txt
# API:           ${DENTAL_BASE_URL}/api/tannlege/agents

${buildRobotsGroups("")}

Sitemap: ${DENTAL_BASE_URL}/sitemap.xml
`);
});

// ═══════════════════════════════════════════════════════════
// GET /llms.txt
// ═══════════════════════════════════════════════════════════

router.get("/llms.txt", (_req: Request, res: Response) => {
  // ONE catalog number (services/honest-count.ts), read live — not via the 60 s SSR stats cache.
  const stats = { total: safeHonestCatalogCount("dental") ?? 0 };

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(`# finn-tannlege.com — LLM-oversikt

<!-- generated-at: ${new Date().toISOString()} -->

## Hva er dette?

Finn-tannlege.com er en uavhengig søketjeneste for tannlegeklinikker i Norge.
Databasen inneholder omtrent ${stats.total.toLocaleString("nb")} klinikker hentet fra
Brønnøysundregistrene, HPR og klinikkenes egne nettsider.

${FINN_DISAMBIGUATION_NB}
${FINN_DISAMBIGUATION_EN}

## A2A AI-discovery

Agent Card (A2A-protokoll):   ${DENTAL_BASE_URL}/.well-known/agent-card.json
Alias:                        ${DENTAL_BASE_URL}/agent-card.json
A2A JSON-RPC 2.0 endepunkt:  ${DENTAL_BASE_URL}/a2a
OpenAPI 3.1 spec:             ${DENTAL_BASE_URL}/openapi.json

Støttede A2A JSON-RPC-metoder:
- message/send  — søk klinikker med naturlig språk eller strukturerte filtre

Eksempel (cURL):
  curl -X POST ${DENTAL_BASE_URL}/a2a \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"text":"finn tannlege med helfo-avtale i Oslo"}},"id":"1"}'

## ChatGPT Custom GPT

ChatGPT Custom GPT — Finn tannlege i Norge: https://chatgpt.com/g/g-6a21e79241cc8191a04642bda508e42b-finn-tannlege-i-norge

## MCP (Model Context Protocol)

HTTP Streamable MCP:  ${DENTAL_BASE_URL}/mcp
MCP Server Card:      ${DENTAL_BASE_URL}/.well-known/mcp/server-card.json
npm-pakke (stdio):    npx finn-tannlege-mcp

Tilgjengelige MCP-tools:
${registeredMcpTools("dental").map((t) => `- ${t.name} — ${t.description}`).join("\n")}

Claude Desktop-konfig:
  {
    "mcpServers": {
      "finn-tannlege": {
        "command": "npx",
        "args": ["finn-tannlege-mcp"]
      }
    }
  }

## REST API-endepunkt

GET ${DENTAL_BASE_URL}/api/tannlege/agents

Filterparametre (query string):
- q             fritekst — matcher navn eller poststed
- fylke         fylkesnavn (f.eks. "Oslo", "Vestland")
- specialty     spesialitet (f.eks. "endodonti", "kjeveortopedi")
- helfo         "true" — kun klinikker med Helfo-direkteoppgjørsavtale
- acute_vakt    1 — kun klinikker med akuttvakt-tilbud
- enrichment_state  "raw" | "enriched"
- limit         maks antall resultater (standard 50, maks 500)
- offset        sidebladering

Respons: JSON-array med DentalAgent-objekter.

## Profil-URL-mønster

${DENTAL_BASE_URL}/klinikk/{navn-slugified}-{9-sifret-orgnr}

Eksempel: ${DENTAL_BASE_URL}/klinikk/oslo-tannlegeklinikk-as-123456789

## Spesialitet-sider

${DENTAL_BASE_URL}/spesialitet/kjeveortopedi
${DENTAL_BASE_URL}/spesialitet/oral-kirurgi-og-oral-medisin
${DENTAL_BASE_URL}/spesialitet/periodonti
${DENTAL_BASE_URL}/spesialitet/endodonti
${DENTAL_BASE_URL}/spesialitet/pedodonti
${DENTAL_BASE_URL}/spesialitet/oral-protetikk
${DENTAL_BASE_URL}/spesialitet/kjeve-og-ansiktsradiologi

## Slik fungerer det

${DENTAL_BASE_URL}/hvordan-det-fungerer

## Lisens

Data fra Brønnøysundregistrene er CC0 (fri bruk). HPR-data er offentlig.
Klinikkdata fra nettsider gjengis som faktaoppsummering.

## Frivillig API-nøkkel (forbruker-identitet)

Helt valgfritt — alle søk-/lese-endepunktene over er allerede åpne uten nøkkel, og dette er
IKKE en pålogging eller et krav for å bruke tjenesten.

- Hent en gratis nøkkel: \`POST ${DENTAL_BASE_URL}/api/keys\` med valgfri JSON-body
  \`{ "label": "min-agent", "contact_email": "..." }\` (begge felt valgfrie). Svaret inneholder
  \`key\` — vis den KUN denne ene gangen, den kan ikke hentes igjen.
- Bruk den: send nøkkelen som \`X-API-Key\`-header på ethvert MCP-/A2A-/REST-kall.
- Fordel: kallene dine telles i en aggregert forbrukslogg (kun endepunkt/verktøynavn og dato —
  aldri innhold eller argumenter). Merk: rate-grensen på finn-tannlege.com (1000 kall per
  15 min — per MCP-økt på \`/mcp\`, ellers per IP) er IKKE høyere med nøkkel — den høyere
  rate-grensen som nøkkelen gir på enkelte andre vertikaler på plattformen er ikke koblet på
  her ennå.
- Tilbakekall/slett: \`POST ${DENTAL_BASE_URL}/api/keys/revoke\` (stanser nøkkelen, historikk
  beholdes) eller \`POST ${DENTAL_BASE_URL}/api/keys/erase\` (GDPR-sletting av label/e-post).
  Begge tar \`{ "key": "..." }\` i body, eller nøkkelen som \`X-API-Key\`-header.

Eksempel (cURL):
  curl -X POST ${DENTAL_BASE_URL}/api/keys \\
    -H "Content-Type: application/json" \\
    -d '{"label":"my-agent"}'

Voluntary — every search/read endpoint above already works with no key, and this is NOT a
login or a requirement to use the service. Get a free key via \`POST /api/keys\`
(optional \`label\`/\`contact_email\`), send it back as the \`X-API-Key\` header on any call, and
revoke/erase it any time via \`POST /api/keys/revoke\` or \`POST /api/keys/erase\`. Note: unlike
some other verticals on this platform, finn-tannlege.com's rate limit (1000 calls per 15
minutes — per MCP session on \`/mcp\`, otherwise per IP) is not yet raised by a key — the key
still gets your calls counted in the usage ledger.

## Datakvalitet og verifisering

${DENTAL_BASE_URL}/proveniens

Hvert felt i en klinikkprofil (adresse, organisasjonsnummer, spesialisttitler, m.m.) lagres med
hvilken kilde som ga oss verdien og når den sist ble bekreftet. En klinikk får «Verifisert»-
merket når en administrator har gått gjennom profilen og vurdert at navn, organisasjonsnummer og
eventuelle spesialisttitler stemmer med tilgjengelig offentlig informasjon, blant annet fra
Brønnøysundregistrene — det er en redaksjonelt satt status, ikke en fullautomatisk registersjekk.
Klinikker der denne gjennomgangen ennå ikke er gjort forblir synlige i katalogen — de skjules
ikke — men uten merket. Se ${DENTAL_BASE_URL}/proveniens for hele forklaringen.

Every field in a clinic profile (address, organisation number, specialist titles, etc.) is
stored with which source supplied that value and when it was last confirmed. A clinic earns the
"Verified" badge once an administrator has reviewed the profile and judged that its name,
organisation number and any specialist titles match publicly available information, including
from Brønnøysundregistrene — this is an editorially-set status, not a fully automated registry
check. Clinics for which this review hasn't happened yet remain fully listed — they are not
hidden — just without the badge. See ${DENTAL_BASE_URL}/proveniens for the full explanation.
`);
});

// ═══════════════════════════════════════════════════════════
// GET /favicon.svg  (PR-112)
// ═══════════════════════════════════════════════════════════

router.get("/favicon.svg", (_req: Request, res: Response) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="19.2" fill="#0F766E"/>
  <circle cx="40" cy="40" r="20" fill="none" stroke="#fff" stroke-width="6"/>
  <line x1="54" y1="54" x2="70" y2="70" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
  <g transform="translate(27,18) scale(0.72)">
    <path d="${TOOTH_PATH}" fill="#fff"/>
  </g>
</svg>`;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(svg);
});

// ═══════════════════════════════════════════════════════════
// GET /hvordan-det-fungerer  (PR-112)
// ═══════════════════════════════════════════════════════════

router.get("/hvordan-det-fungerer", (_req: Request, res: Response) => {
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Slik fungerer Finn-tannlege.com",
      url: `${DENTAL_BASE_URL}/hvordan-det-fungerer`,
      description: "Guide til pasienter, klinikker og AI-agenter om hvordan Finn-tannlege.com fungerer.",
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Hva betyr Helfo-avtale?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Klinikker med Helfo-direkteoppgjørsavtale sender regningen direkte til Helfo. Du betaler kun egenandelen — ikke full pris. Gjelder ved undersøkelse, akuttbehandling og visse tilstander som dekkes av tannhelsetjenesteloven.",
          },
        },
        {
          "@type": "Question",
          name: "Hva koster tannlege?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Tannlegepriser varierer mye i Norge. Med Helfo-direkteoppgjørsavtale betaler du kun egenandelen for stønadspliktige behandlinger. Uten Helfo-avtale betaler du full pris. Sjekk klinikkens nettside for prisliste.",
          },
        },
        {
          "@type": "Question",
          name: "Hva gjør jeg ved akutt tannverk?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Søk etter klinikker med Akuttvakt-merke på Finn-tannlege.com. Mange kommuner har kommunal tannlegevakt — ring klinikken for informasjon om åpningstider.",
          },
        },
        {
          "@type": "Question",
          name: "Hvordan oppdaterer jeg min klinikk?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Send e-post til kontakt@finn-tannlege.com med navn, organisasjonsnummer og hva som skal endres. Vi svarer innen 5 virkedager. En selvbetjeningsportal er under utvikling.",
          },
        },
      ],
    },
  ];

  const html = `
<main>
  <div class="content-page">
    <h1>Slik fungerer Finn-tannlege.com</h1>
    <p>Her forklarer vi hvordan tjenesten fungerer &mdash; for pasienter, for klinikker og for AI-agenter og utviklere.</p>

    <h2>For pasienter</h2>

    <h3 style="font-size:1rem;font-weight:700;color:var(--navy);margin:20px 0 8px">Tre steg til riktig tannlege</h3>
    <ol style="padding-left:20px;margin-bottom:16px">
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:8px"><strong>Søk</strong> &mdash; skriv inn by, poststed eller tannlegenavn i søkefeltet. Du kan filtrere på fylke, spesialitet, Helfo-avtale og akuttvakt.</li>
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:8px"><strong>Sammenlign</strong> &mdash; se Helfo-avtale, spesialiteter, åpningstider og kontaktinformasjon side om side for de klinikkene som passer deg.</li>
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:8px"><strong>Kontakt</strong> &mdash; ring klinikken direkte eller bruk online-booking der det finnes. Ingen mellomledd, ingen gebyrer fra vår side.</li>
    </ol>

    <h3 style="font-size:1rem;font-weight:700;color:var(--navy);margin:20px 0 8px">Hva betyr merkene?</h3>
    <ul style="padding-left:0;list-style:none;margin-bottom:16px">
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:10px"><span class="badge badge-verified" style="margin-right:8px">Verifisert</span> Data er kryssjekket mot offentlige registre (Brønnøysundregistrene + HPR). Klinikkens navn, organisasjonsnummer og eventuelle spesialisttitler er bekreftet.</li>
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:10px"><span class="badge badge-helfo" style="margin-right:8px">Helfo-avtale</span> Klinikken har direkteoppgjørsavtale med Helfo. Du betaler kun egenandelen for stønadspliktige behandlinger &mdash; ikke full pris.</li>
      <li style="font-size:.95rem;color:var(--g700);line-height:1.7;margin-bottom:10px"><span class="badge badge-akutt" style="margin-right:8px">Akuttvakt</span> Klinikken tilbyr akuttbehandling utenom ordinær arbeidstid. Ring alltid for å bekrefte åpningstider.</li>
    </ul>

    <h3 style="font-size:1rem;font-weight:700;color:var(--navy);margin:20px 0 8px">Helfo og tannhelsestønad</h3>
    <p>Helfo (Helseøkonomiforvaltningen) administrerer statlig stønad til visse tannbehandlinger for voksne. Det gjelder ikke alle tannbehandlinger &mdash; stønad ytes for bestemte tilstander. De viktigste stønadspunktene er:</p>
    <ul>
      <li><strong>Periodontitt</strong> &mdash; alvorlig tannkjøttbetennelse med beinresorpsjon</li>
      <li><strong>Oral kirurgi</strong> &mdash; bl.a. kjevecyster, odontoektomi og beinimplantater ved spesielle indikasjoner</li>
      <li><strong>Bittavvik og kjeveortopedi</strong> &mdash; særlig ved store kjeveanomalier</li>
      <li><strong>Tannutviklingsforstyrrelser</strong> &mdash; bl.a. amelogenesis imperfecta</li>
    </ul>
    <p style="margin-top:12px">Dette er ikke en uttømmende juridisk liste. Se <a href="https://www.helfo.no/tannlege" rel="nofollow noopener" target="_blank">helfo.no/tannlege</a> for fullstendig oversikt og vilkår.</p>

    <h3 style="font-size:1rem;font-weight:700;color:var(--navy);margin:20px 0 8px">Akutt tannverk</h3>
    <p>Tilbudet om kommunal tannlegevakt varierer mye fra kommune til kommune, og åpningstidene er som regel begrenset til kvelder og helger. Det beste rådet er å søke på klinikker med <span class="badge badge-akutt">Akuttvakt</span>-merke og ringe direkte. Mange klinikker setter av tid til akuttpasienter på kort varsel i ordinær åpningstid.</p>

    <h2>For klinikker</h2>
    <p>Finn-tannlege.com henter klinikkdata fra tre offentlige kilder:</p>
    <ul>
      <li><strong>Brønnøysundregistrene</strong> &mdash; grunnleggende foretaksopplysninger, adresse og kontaktinfo</li>
      <li><strong>Offentlige helseregistre (HPR)</strong> &mdash; autorisasjons- og spesialistopplysninger</li>
      <li><strong>Klinikkenes egne nettsider</strong> &mdash; åpningstider, behandlingstilbud og presentasjon</li>
    </ul>
    <p><strong>Oppføring er gratis.</strong> Vi tar ikke betalt for å vises i søkeresultatene.</p>
    <p>For å rette feil, oppdatere kontaktinformasjon eller be om fjerning: send e-post til <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a> med klinikkens navn og organisasjonsnummer. Vi svarer innen 5 virkedager. En selvbetjeningsportal for klinikker er under utvikling &mdash; vi varsler registrerte klinikker når den lanseres.</p>

    <h2 style="margin-top:32px;font-size:1rem;font-weight:600;color:var(--g500)">For AI-agenter og utviklere</h2>
    <p style="font-size:.9rem;color:var(--g500)">Finn-tannlege.com tilbyr maskinlesbare endepunkter:</p>
    <ul style="font-size:.9rem;color:var(--g500)">
      <li><a href="/api/tannlege/agents">/api/tannlege</a> &mdash; REST API med JSON-svar (DentalAgent-objekter)</li>
      <li><a href="/llms.txt">/llms.txt</a> &mdash; LLM-vennlig oversikt over API og datastruktur</li>
      <li><a href="/a2a">/a2a</a> &mdash; A2A JSON-RPC 2.0 endepunkt (message/send)</li>
      <li><a href="/mcp">/mcp</a> &mdash; MCP Streamable HTTP (ChatGPT, Claude Desktop, Cursor)</li>
      <li><code>npx finn-tannlege-mcp</code> &mdash; stdio MCP-pakke for lokal bruk</li>
    </ul>
    <p style="margin-top:20px">
      <a href="https://chatgpt.com/g/g-6a21e79241cc8191a04642bda508e42b-finn-tannlege-i-norge" target="_blank" rel="noopener"
         style="display:inline-block;background:var(--navy,#1a3a5c);color:#fff;padding:10px 18px;border-radius:6px;font-size:.95rem;font-weight:600;text-decoration:none">
        Pr&oslash;v v&aring;r ChatGPT-assistent: Finn tannlege i Norge &rarr;
      </a>
    </p>
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Slik fungerer det — Finn-tannlege.com",
    description: "Guide til pasienter, klinikker og utviklere: slik finner du riktig tannlege, hva Helfo-avtale og badges betyr, og hvordan klinikker kan oppdatere sin profil.",
    canonical: `${DENTAL_BASE_URL}/hvordan-det-fungerer`,
    jsonLd,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /personvern  (PR-112 — utvidet GDPR-side)
// ═══════════════════════════════════════════════════════════

router.get("/personvern", (_req: Request, res: Response) => {
  // 2026-10-13: faktarettinger (dev-request 2026-10-06-personvernerklaeringer-del-a-na-del-b-pa-t, del A);
  // visit and search statistics described (2026-10-13-statistikk-riktig-for-investorer, S2:
  // searches are now logged); operator → AGENTPLATFORM.NO AS (2026-10-08).
  const updatedDate = "2026-10-13";
  const html = `
<main>
  <div class="content-page">
    <h1>Personvernerklæring</h1>
    <p style="font-size:.85rem;color:var(--g500)">Sist oppdatert: ${updatedDate}</p>

    <h2>Behandlingsansvarlig</h2>
    <p>${companyControllerSentenceHtml("nb", { siteName: "Finn-tannlege.com", siteEmail: "kontakt@finn-tannlege.com" })}</p>

    <h2>Hvilke data behandler vi?</h2>
    <p>Katalogen bygger på <strong>offentlig tilgjengelige opplysninger</strong>. Mesteparten gjelder virksomheter, men den inneholder også opplysninger om enkeltpersoner (tannleger og annet helsepersonell, og enkeltpersonforetak):</p>
    <ul>
      <li><strong>Brønnøysundregistrene (Brreg)</strong> &mdash; foretaksnavn, organisasjonsnummer, adresse, kontaktinformasjon og næringsgruppekode for registrerte tannlegeklinikker. For enkeltpersonforetak er foretaksnavnet ofte personens eget navn.</li>
      <li><strong>Helsepersonellregisteret (HPR)</strong> &mdash; for tannleger lagrer vi <strong>navn, HPR-nummer, spesialitet(er) og kobling til klinikk</strong>, og i noen tilfeller personens eget organisasjonsnummer og bostedsfylke. Autorisasjon og spesialisttittel er offentlig informasjon etter helsepersonelloven.</li>
      <li><strong>Klinikkenes egne offentlige nettsider</strong> &mdash; åpningstider, behandlingstilbud og presentasjonstekst</li>
      <li><strong>Henvendelser via kontaktskjemaet</strong> &mdash; navn, e-postadresse, emne og melding du selv sender oss. Meldingen lagres for å behandle forespørselen din.</li>
    </ul>
    <p>Vi behandler <strong>ingen pasientdata</strong> og <strong>ingen helseopplysninger om enkeltpersoner</strong>. Opplysningene om helsepersonell gjelder utelukkende deres yrkesutøvelse og autorisasjon. Utover henvendelser du selv sender oss, lagrer vi om deg som besøker siden bare besøks- og søkestatistikken beskrevet under.</p>

    <h2>Besøks- og søkestatistikk</h2>
    <p>For å forstå hvordan tjenesten brukes, registrerer serveren &mdash; uten cookies &mdash; for hvert sidebesøk hvilken side som ble vist, hvor du kom fra (referanse-URL), tidspunktet, en saltet og forkortet hash av IP-adressen (vi lagrer aldri hele IP-adressen) og en grov klassifisering av nettleseren (for eksempel mobil, PC eller søkemotor). Når du søker på nettsiden eller via API-et, lagrer vi i tillegg søketeksten og filtrene du valgte (for eksempel fylke, spesialitet eller akutt), antall treff og den samme IP-hashen. Når en AI-assistent bruker våre MCP- eller A2A-verktøy, logger vi verktøyet, AI-klientens nettleser-/klientstreng og en saltet IP-hash.</p>
    <p>Søk lagres uten navn eller konto, og vi forsøker ikke å knytte dem til deg. Disse enkeltregistreringene slettes automatisk etter 60 dager. Før sletting summeres de til tall uten kobling til den besøkende (for eksempel antall besøk per dag og antall søk per søketekst), og bare disse tallene beholdes. Statistikken lagres i databasen hos Fly.io (se under) og deles ikke med andre.</p>

    <h2>Navngitte personer</h2>
    <p>Tannleger og annet helsepersonell kan fremgå av profilene med navn og tittel/spesialitet. Dette er offentlig tilgjengelig informasjon knyttet til yrkesutøvelse og autorisasjon &mdash; ikke privat informasjon. Grunnlaget er at offentligheten har rett og behov for å kjenne til autorisert helsepersonells spesialkompetanse.</p>

    <h2>Behandlingsgrunnlag</h2>
    <p>Behandlingen er basert på <strong>berettiget interesse</strong>, jf. GDPR artikkel 6 (1) bokstav f. Det er et legitimt behov for at befolkningen enkelt kan finne og sammenligne tannlegeklinikker og verifisere helsepersonells autorisasjon. Behandlingen er begrenset til offentlig tilgjengelige data og medfører lav personvernrisiko. Besøks- og søkestatistikken behandles også på grunnlag av berettiget interesse: å forstå hvordan tjenesten brukes og forbedre den.</p>

    <h2>Dine rettigheter</h2>
    <p>Du har rettigheter etter GDPR kapittel III, herunder:</p>
    <ul>
      <li><strong>Innsyn</strong> &mdash; be om innsyn i hvilke opplysninger vi har om deg</li>
      <li><strong>Retting</strong> &mdash; be om korrigering av feilaktige opplysninger</li>
      <li><strong>Sletting</strong> &mdash; be om sletting der vilkårene er oppfylt</li>
      <li><strong>Innsigelse</strong> &mdash; protestere mot behandling basert på berettiget interesse</li>
    </ul>
    <p>Send forespørsel til <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a>. Vi svarer innen 30 dager.</p>

    <h2>Informasjonskapsler (cookies)</h2>
    <p>Vi bruker <strong>ingen sporingscookies</strong> og ingen markedsføringscookies. Det lagres ingen cookies på din enhet for analyseformål; statistikken over regnes ut på serveren.</p>

    <h2>Tredjeparter og overføring til land utenfor EØS</h2>
    <p>Vi <strong>selger ikke</strong> personopplysninger og deler dem ikke med tredjeparter for kommersielle formål. Vi bruker følgende leverandører til driften:</p>
    <ul>
      <li><strong>Fly.io</strong> &mdash; hosting og lagring av databasen. Tjenesten kjører i Fly.ios region <strong>arn (Stockholm, Sverige)</strong>, altså innenfor EØS. Fly.io er et amerikansk selskap.</li>
      <li><strong>Cloudflare (Turnstile)</strong> &mdash; spamsjekk på kontaktskjemaet. Når du åpner kontaktsiden, lastes skriptet fra Cloudflare, og nettleserinformasjon og IP-adresse kan bli behandlet av Cloudflare, et amerikansk selskap.</li>
      <li><strong>Anthropic (API)</strong> &mdash; en språkmodell brukes til å vurdere om en oppføring i katalogen faktisk er en tannlegeklinikk. Modellen mottar opplysninger fra Brreg (foretaksnavn, næringskode, organisasjonsform og nettadresse); for enkeltpersonforetak kan foretaksnavnet være personens navn. Anthropic er et amerikansk selskap.</li>
      <li><strong>Google (Gmail) og Resend</strong> &mdash; e-postkorrespondanse, blant annet henvendelser til og svar fra kontakt@finn-tannlege.com. Begge er amerikanske selskaper.</li>
    </ul>
    <p>Bruken av Cloudflare, Anthropic, Google og Resend innebærer at personopplysninger kan bli overført til og behandlet i <strong>USA, utenfor EU/EØS</strong>. Slike overføringer krever et overføringsgrunnlag etter GDPR kapittel V. Ta kontakt på <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a> hvis du vil vite mer om grunnlaget for overføringen.</p>

    <h2>Endringer i erklæringen</h2>
    <p>Vesentlige endringer vil bli varslet på denne siden med oppdatert dato. Sist oppdatert: ${updatedDate}.</p>
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Personvern og GDPR — Finn-tannlege.com",
    description: "Personvernerklæring for Finn-tannlege.com: behandlingsansvarlig, hvilke data vi behandler, GDPR-rettigheter og informasjonskapsler.",
    canonical: `${DENTAL_BASE_URL}/personvern`,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /vilkar (+ /terms, /terms-of-service, /tos) — terms of use
//
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S5:
// new legal text, merged by Daniel only after he has read it (merge_guard
// needs_daniel). Bilingual in one page like /proveniens (NO section, then the
// EN section under #en). Every alias carries the one canonical, /vilkar.
// The operator line is companyOperatorSentence(), the FINN.no sentence is
// BRAND_ENTITIES.dental.disambiguation and the e-mail address is
// BRAND_ENTITIES.dental.supportEmail, so none of them is written here. No street
// address (company-legal.ts: /kontakt and /personvern only). The page names
// no data source of its own: /proveniens says which sources are used.
// «Sist oppdatert» is the page's sitemap text date, so the two cannot drift.
// ═══════════════════════════════════════════════════════════

router.get(["/vilkar", "/terms", "/terms-of-service", "/tos"], (_req: Request, res: Response) => {
  const updatedDate = DENTAL_STATIC_PAGE_DATES["/vilkar"];
  const email = escapeHtml(BRAND_ENTITIES.dental.supportEmail);
  const html = `
<main>
  <div class="content-page">
    <p style="text-align:right;font-size:.9rem"><a href="#en">English</a></p>
    <h1>Vilkår for bruk</h1>
    <p style="font-size:.85rem;color:var(--g500)">Sist oppdatert: ${updatedDate}</p>
    <p>Disse vilkårene gjelder for alle som bruker Finn-tannlege.com &mdash; på nettsiden, gjennom REST-API-et, MCP-serveren eller A2A-endepunktet, også når en AI-assistent eller AI-agent bruker tjenesten for deg. Ved å bruke tjenesten godtar du vilkårene.</p>
    <p>${companyOperatorSentence("nb")} ${escapeHtml(FINN_DISAMBIGUATION_NB)}</p>

    <h2>1. Hva tjenesten er</h2>
    <p>Finn-tannlege.com er en gratis, søkbar oversikt over tannlegeklinikker i Norge, med opplysninger som adresse, kontaktinformasjon, spesialiteter, Helfo-avtale og akuttilbud. Vi bestiller ikke timer og tar ikke imot betaling. Time avtaler du direkte med klinikken.</p>

    <h2>2. Ikke medisinsk rådgivning</h2>
    <p>Innholdet er generell informasjon som skal hjelpe deg å finne en klinikk. Det er ikke medisinsk eller odontologisk rådgivning, og det erstatter ikke undersøkelse, diagnose eller råd fra tannlege eller annet helsepersonell. Spørsmål om din egen tannhelse eller behandling tar du med klinikken.</p>

    <h2>3. Akutt hjelp</h2>
    <p><strong>Ved akutt fare for liv eller helse: ring 113.</strong></p>
    <p>Trenger du akutt tannbehandling når klinikken din er stengt, kontakter du legevakten på 116 117 eller tannlegevakten der du bor. At en klinikk er merket med akuttilbud her, betyr ikke at den kan ta imot deg nå. Ring klinikken før du drar dit.</p>

    <h2>4. Opplysningene i katalogen</h2>
    <p>Opplysningene er samlet inn fra offentlige registre, klinikkenes egne nettsider og andre offentlig tilgjengelige kilder, delvis automatisk og med hjelp av KI. Hvilke kilder vi bruker, og hva merkene i katalogen betyr, står på <a href="/proveniens">siden om kilder og metode</a>.</p>
    <p><strong>Opplysningene vises «som de er».</strong> De kan være utdaterte, ufullstendige eller feil, og vi garanterer ikke at de stemmer. Sjekk åpningstider, Helfo-avtale og akuttilbud med klinikken før du bestiller time eller drar dit. Rekkefølgen i søkeresultatene og merkene på profilene er ingen vurdering av kvaliteten på behandlingen.</p>

    <h2>5. Akseptabel bruk</h2>
    <ul>
      <li>Bruk nettsiden, API-et, MCP-serveren og A2A-endepunktet til å finne og sammenligne tannlegeklinikker.</li>
      <li>Bygg tjenesten inn i egne agenter og verktøy innenfor rate-grensene vi oppgir i <a href="/llms.txt">llms.txt</a>.</li>
      <li>Følg robots.txt.</li>
    </ul>

    <h2>6. Forbudt bruk</h2>
    <ul>
      <li>Å laste ned hele eller store deler av katalogen for å publisere den som et konkurrerende register uten skriftlig tillatelse.</li>
      <li>Å bruke kontaktinformasjon herfra til markedsføring, masseutsendelser eller spam til klinikker eller tannleger.</li>
      <li>Å omgå sikkerhetstiltak, rate-grenser eller tilgangskontroll.</li>
    </ul>

    <h2>7. For klinikker: retting og fjerning</h2>
    <p>Er opplysningene om en klinikk feil, kan klinikken be om at de rettes, eller at oppføringen fjernes, ved å skrive til <a href="mailto:${email}">${email}</a> eller bruke <a href="/kontakt">kontaktskjemaet</a>. Rettighetene etter personvernreglene står i <a href="/personvern">personvernerklæringen</a>.</p>

    <h2>8. Ansvar</h2>
    <p>Finn-tannlege.com er ikke part i avtaler mellom deg og klinikken, og er ikke ansvarlig for behandling, timebestilling, priser eller annet mellom deg og klinikken. Så langt loven tillater det, er vi ikke ansvarlige for tap som følge av feil, mangler eller forsinkelser i opplysningene eller i tjenesten.</p>

    <h2>9. Endringer</h2>
    <p>Vi kan endre disse vilkårene. Datoen øverst viser når de sist ble endret.</p>

    <h2>10. Gjeldende rett</h2>
    <p>Norsk rett gjelder. Tvister løses ved selskapets alminnelige verneting, med mindre ufravikelig lov gir deg rett til å bringe saken inn et annet sted.</p>

    <h2>11. Kontakt</h2>
    <p>Spørsmål om vilkårene sender du til <a href="mailto:${email}">${email}</a>. Selskapsopplysningene står på <a href="/kontakt">kontaktsiden</a>.</p>

    <hr style="margin:36px 0;border:none;border-top:1px solid var(--g100,#e5e7eb)">

    <div lang="en">
    <h1 id="en">Terms of Service</h1>
    <p style="font-size:.85rem;color:var(--g500)">Last updated: ${updatedDate}</p>
    <p>These terms apply to everyone who uses Finn-tannlege.com &mdash; on the website, through the REST API, the MCP server or the A2A endpoint, including when an AI assistant or AI agent uses the service for you. By using the service you accept these terms.</p>
    <p>${companyOperatorSentence("en")} ${escapeHtml(FINN_DISAMBIGUATION_EN)}</p>

    <h2>1. What the service is</h2>
    <p>Finn-tannlege.com is a free, searchable directory of dental clinics in Norway, with details such as address, contact information, specialties, Helfo agreement and emergency care. We do not book appointments and we do not take payments. You make appointments directly with the clinic.</p>

    <h2>2. Not medical advice</h2>
    <p>The content is general information to help you find a clinic. It is not medical or dental advice, and it does not replace an examination, diagnosis or advice from a dentist or other health professional. Take questions about your own dental health or treatment to the clinic.</p>

    <h2>3. Emergencies</h2>
    <p><strong>If life or health is in immediate danger: call 113.</strong></p>
    <p>If you need emergency dental treatment while your clinic is closed, contact the out-of-hours medical service (legevakt) on 116 117 or the emergency dental service (tannlegevakt) where you live. A clinic marked with emergency care here may still be unable to see you now. Call the clinic before you go there.</p>

    <h2>4. The information in the directory</h2>
    <p>The information is collected from public registers, the clinics' own websites and other publicly available sources, partly automatically and with the help of AI. Which sources we use, and what the badges in the directory mean, is on <a href="/proveniens">the sources and method page</a>.</p>
    <p><strong>The information is provided "as is".</strong> It may be out of date, incomplete or wrong, and we do not guarantee that it is correct. Check opening hours, Helfo agreement and emergency care with the clinic before you book or go there. The order of search results and the badges on profiles are no assessment of the quality of treatment.</p>

    <h2>5. Acceptable use</h2>
    <ul>
      <li>Use the website, the API, the MCP server and the A2A endpoint to find and compare dental clinics.</li>
      <li>Build the service into your own agents and tools within the rate limits given in <a href="/llms.txt">llms.txt</a>.</li>
      <li>Respect robots.txt.</li>
    </ul>

    <h2>6. Prohibited use</h2>
    <ul>
      <li>Downloading all or large parts of the directory to republish it as a competing register without written permission.</li>
      <li>Using contact details from here for marketing, bulk messages or spam to clinics or dentists.</li>
      <li>Circumventing security measures, rate limits or access control.</li>
    </ul>

    <h2>7. For clinics: corrections and removal</h2>
    <p>If the information about a clinic is wrong, the clinic can ask for it to be corrected, or for the listing to be removed, by writing to <a href="mailto:${email}">${email}</a> or using <a href="/kontakt">the contact form</a>. Rights under data protection law are set out in <a href="/personvern">the privacy policy</a>.</p>

    <h2>8. Liability</h2>
    <p>Finn-tannlege.com is not a party to agreements between you and the clinic, and is not responsible for treatment, appointments, prices or anything else between you and the clinic. To the extent the law allows, we are not liable for loss caused by errors, omissions or delays in the information or in the service.</p>

    <h2>9. Changes</h2>
    <p>We may change these terms. The date at the top shows when they last changed.</p>

    <h2>10. Governing law</h2>
    <p>Norwegian law applies. Disputes are resolved at the company's ordinary venue, unless mandatory law gives you the right to bring the case elsewhere.</p>

    <h2>11. Contact</h2>
    <p>Send questions about these terms to <a href="mailto:${email}">${email}</a>. The company details are on <a href="/en/kontakt">the contact page</a>.</p>
    </div>
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Vilkår for bruk — Finn-tannlege.com",
    description: "Vilkår for bruk av Finn-tannlege.com: hva tjenesten er, akutt hjelp, hvor opplysningene kommer fra, akseptabel bruk, ansvar og gjeldende rett. Også på engelsk.",
    canonical: `${DENTAL_BASE_URL}/vilkar`,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /proveniens — Slik verifiserer vi dataene våre (transparency page)
//
// Public, SSR, bilingual (NO primary, EN section in the same page — this
// file has no per-request lang switching, so we follow the sibling
// experiences-seo.ts "NO section, <hr>, EN section with #en anchor"
// convention instead of inventing new i18n plumbing here) explainer for the
// field_provenance mechanism that already backs every clinic profile (see
// dental-store.ts's mergeFieldProvenance()/field_provenance column and the
// "Verifisert" badge already described on /om and /hvordan-det-fungerer).
// Purely descriptive — no new behavior.
//
// IMPORTANT: must never claim regulatory compliance/certification of any
// kind — see tests/test.ts for the assertion guarding this.
// ═══════════════════════════════════════════════════════════

router.get("/proveniens", (_req: Request, res: Response) => {
  // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
  // treffvakt (A4-D): the Google Places item says what the display rule
  // (dental-places-display.ts) hides, while it is on; with it off the page is
  // as before.
  const placesRule = placesDisplayPolicyEnabled()
    ? {
        no: ". En adresse, et telefonnummer, åpningstider eller en nettside som bare Google Places oppgir, viser vi ikke. Vi viser verdien når en annen kilde, som klinikkens egen nettside eller Brønnøysundregistrene, oppgir det samme.",
        en: ". An address, phone number, opening hours or website that only Google Places gives is not shown. We show the value when another source, such as the clinic's own website or Brønnøysundregistrene, gives the same.",
      }
    : { no: "", en: "" };
  const html = `
<main>
  <div class="content-page">
    <h1>Slik verifiserer vi dataene våre</h1>
    <p>Finn-tannlege.com skraper ikke bare en nettside og publiserer det vi finner. Hvert felt i en klinikkprofil &mdash; adresse, organisasjonsnummer, spesialisttitler, kontaktinfo &mdash; lagres sammen med hvilken kilde som ga oss verdien og når den sist ble bekreftet. Denne siden forklarer hvordan.</p>

    <h2>Kildene vi kryssjekker mot</h2>
    <ul>
      <li><strong>Brønnøysundregistrene (Brreg)</strong> &mdash; foretaksnavn, organisasjonsnummer, registrert adresse og næringsgruppekode</li>
      <li><strong>Google Places</strong> &mdash; åpningstider og kontaktinformasjon slik de er rapportert til Google${placesRule.no}</li>
      <li><strong>Klinikkens egen nettside</strong> &mdash; behandlingstilbud, presentasjonstekst og praktisk informasjon</li>
    </ul>

    <h2>Hva "Verifisert"-merket betyr</h2>
    <p>Verifisert-merket er en redaksjonelt satt status: en administrator hos Finn-tannlege.com har gått gjennom klinikkens profil og vurdert at navn, organisasjonsnummer og eventuelle spesialisttitler stemmer med tilgjengelig offentlig informasjon, blant annet fra Brønnøysundregistrene. Statusen settes manuelt per klinikk &mdash; det er foreløpig ingen fullautomatisk, sanntids registersjekk som setter merket alene. Hvert enkelt felt i profilen lagres uansett med egen kilde og dato, uavhengig av denne overordnede statusen.</p>
    <p>Klinikker der denne gjennomgangen ennå ikke er gjort forblir synlige i katalogen &mdash; de skjules ikke &mdash; men uten merket, og sorteres lenger ned enn verifiserte klinikker i søkeresultatene. Kun klinikker markert som varig avviklet eller ugyldige oppføringer holdes utenfor det offentlige søket.</p>

    <h2>Hva vi ikke gjør</h2>
    <p>Vi gjetter ikke oss fram til fakta om en klinikk og presenterer det som bekreftet. Informasjon hentet fra en klinikks egen nettside vises som faktaoppsummering med kildehenvisning &mdash; ikke som en bekreftelse fra en offentlig myndighet.</p>

    <div style="background:var(--bg2,#f7f9fc);border-left:4px solid var(--navy,#1a3a5c);border-radius:0 10px 10px 0;padding:18px 22px;margin:24px 0">
      <p style="margin-bottom:0">Etter hvert som forventningene til åpenhet rundt KI og datagrunnlag øker i Europa, mener vi at å vise selve verifiseringsarbeidet vårt er god praksis. Denne siden beskriver hva vi faktisk gjør i dag &mdash; det er ikke en påstand om sertifisering eller samsvar med noe bestemt regelverk.</p>
    </div>

    <p>Se også <a href="/om">om Finn-tannlege.com</a> og <a href="/hvordan-det-fungerer">slik fungerer det</a>.</p>

    <hr style="margin:36px 0;border:none;border-top:1px solid var(--g100,#e5e7eb)">

    <h1 id="en">How we verify our data</h1>
    <p>Finn-tannlege.com doesn't just scrape a website and publish whatever it finds. Every field in a clinic profile &mdash; address, organisation number, specialist titles, contact info &mdash; is stored together with which source supplied that value and when it was last confirmed. This section explains how, in English.</p>

    <h2>The sources we cross-check against</h2>
    <ul>
      <li><strong>Brønnøysundregistrene (Brreg)</strong> &mdash; Norway's business register: company name, organisation number, registered address and industry code</li>
      <li><strong>Google Places</strong> &mdash; opening hours and contact info as reported to Google${placesRule.en}</li>
      <li><strong>The clinic's own website</strong> &mdash; treatment offerings, presentation text and practical information</li>
    </ul>

    <h2>What the "Verified" badge means</h2>
    <p>The "Verified" badge is an editorially-set status: an administrator at Finn-tannlege.com has reviewed the clinic's profile and judged that its name, organisation number and any specialist titles match publicly available information, including from Brønnøysundregistrene. The status is set manually per clinic &mdash; there is currently no fully automated, real-time registry check that sets the badge on its own. Each individual field in the profile is still stored with its own source and date, independent of this overall status.</p>
    <p>Clinics where this review hasn't happened yet remain fully listed in the directory &mdash; they are not hidden &mdash; just without the badge, and ranked below verified clinics in search results. Only permanently closed clinics or invalid listings are excluded from public search.</p>

    <h2>What we don't do</h2>
    <p>We don't guess facts about a clinic and present the guess as confirmed. Information pulled from a clinic's own website is shown as a factual summary with source attribution &mdash; not as confirmation from a public authority.</p>

    <p>This page describes what our verification pipeline genuinely does today; it is not a claim that we meet any particular law or regulatory standard.</p>
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: "Slik verifiserer vi dataene våre — Finn-tannlege.com",
    description: "Hvordan Finn-tannlege.com sporer kilde og dato per felt i klinikkdata, og hva 'Verifisert'-merket faktisk betyr og ikke betyr.",
    canonical: `${DENTAL_BASE_URL}/proveniens`,
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /spesialitet/:slug  (PR-112)
// ═══════════════════════════════════════════════════════════

router.get("/spesialitet/:slug", (req: Request, res: Response) => {
  const slugParam = String(req.params.slug).toLowerCase();
  const sp = findSpecialtyBySlug(slugParam);
  if (!sp) {
    sendDentalNotFound(res,
      `<main><div class="container"><div class="empty-state" style="padding:80px 0"><h3>Spesialitet ikke funnet</h3><p>Vi kjenner ikke til spesialiteten «${escapeHtml(slugParam)}». <a href="/">Gå til forsiden</a>.</p></div></div></main>`,
      { title: "Spesialitet ikke funnet — Finn-tannlege.com" }
    );
    return;
  }

  // Paged like /fylke (F1-S1): it listed the first 50 clinics only.
  let total = 0;
  try { total = countPublicDentalAgents({ specialty: sp.navn } as any); } catch { /* db not ready */ }
  const { page, offset, totalPages } = resolveListPage(req.query.side, total);
  let agents: Array<DentalAgent & { id: string }> = [];
  try {
    agents = listPublicDentalAgents({ specialty: sp.navn } as any, DENTAL_LANDING_CONFIG.listPageSize, offset);
  } catch { /* db not ready */ }

  const basePath = `/spesialitet/${sp.slug}`;
  const canonicalUrl = `${DENTAL_BASE_URL}${basePath}`;
  const pageUrl = `${DENTAL_BASE_URL}${listPageHref(basePath, page)}`;
  const pageMeta = listPageMeta(page, totalPages);
  const displayNavn = sp.navn.charAt(0).toUpperCase() + sp.navn.slice(1);

  const itemList = dentalItemListJsonLd(`Tannlegespesialister: ${displayNavn}`, pageUrl, agents, offset);

  const resultCards =
    agents.length > 0
      ? `<div class="clinic-list" role="list" aria-label="Spesialistklinikker">${agents.map(clinicCard).join("")}</div>`
      : `<div class="empty-state"><h3>Ingen spesialistklinikker funnet</h3><p>Vi har ikke registrert klinikker med denne spesialiteten ennå. Prøv å <a href="/sok?spesialitet=${encodeURIComponent(sp.navn)}">søke etter ${escapeHtml(sp.navn)}</a>.</p></div>`;

  const otherChips = SPECIALTY_PAGES
    .filter((p) => p.slug !== sp.slug)
    .map((p) => `<a href="/spesialitet/${escapeHtml(p.slug)}" class="spec-chip">${escapeHtml(p.navn.charAt(0).toUpperCase() + p.navn.slice(1))}</a>`)
    .join("");

  const html = `
<main>
  <div class="profile-header">
    <div class="container">
      <p style="font-size:.85rem;opacity:.7;margin-bottom:8px"><a href="/" style="color:rgba(255,255,255,.7)">&larr; Forsiden</a></p>
      <h1 class="profile-name">${escapeHtml(displayNavn)}</h1>
      <p style="opacity:.8;font-size:.95rem">${total.toLocaleString("nb")} spesialistklinikker registrert</p>
    </div>
  </div>
  <div class="container" style="padding-top:32px;padding-bottom:48px">
    <div class="section-box">
      <h2>Om spesialiteten</h2>
      <p style="font-size:.95rem;color:var(--g700);line-height:1.7">${escapeHtml(sp.beskrivelse)}</p>
      <p style="margin-top:12px;font-size:.9rem"><a href="/sok?spesialitet=${encodeURIComponent(sp.navn)}">Se alle klinikker med ${escapeHtml(sp.navn)} i søket &rarr;</a></p>
    </div>
    <p class="result-meta" style="margin-bottom:20px">${total.toLocaleString("nb")} klinikker funnet${totalPages > 1 ? ` &mdash; side ${page} av ${totalPages}` : ""}</p>
    ${resultCards}
    ${paginationHtml(page, totalPages, basePath)}
    <div style="margin-top:40px">
      <div class="section-title" style="font-size:1.1rem;margin-bottom:12px">Andre spesialiteter</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${otherChips}</div>
    </div>
  </div>
</main>`;

  const specBreadcrumb = breadcrumbJsonLd([
    { name: "Hjem", url: DENTAL_BASE_URL },
    { name: displayNavn, url: canonicalUrl },
  ]);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  recordAiPageDelivery(req, res, "ai_page_list", agents.map((a) => a.id), "dental");
  res.send(dentalShell(html, {
    title: `${displayNavn}${pageMeta.title} — Tannlegespesialister i Norge | Finn-tannlege.com`,
    description: `Oversikt over tannlegeklinikker med spesialitet i ${sp.navn} i Norge. ${sp.beskrivelse.split(".")[0]}.${pageMeta.description}`,
    canonical: pageUrl,
    jsonLd: [itemList, specBreadcrumb],
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /sted/:stedSlug  (PR-116 — bysider)
// ═══════════════════════════════════════════════════════════

// The place behind /sted/<slug>, from the cached poststed list. Every stored
// spelling of a place slugs alike ("BERGEN" and "Bergen" are both
// /sted/bergen), so a slug is a group (dev-request
// 2026-10-17-dental-d3-rettelser, D3b / IDX-3):
//   row        the first row with the slug. The list is ordered by count, so
//              that is the highest-count spelling; the page's title,
//              breadcrumb and fylke come from it, as before.
//   spellings  every stored spelling with the slug, most clinics first.
//   count      the clinics of all the spellings together.
// The /sted page, its sitemap lastmod, the clinic page's «Det finnes N
// klinikker i X» and the place chips on / and /fylke all read the group, so
// they name the same place and count. They used to read the row alone, so
// /sted/bergen listed 164 of Bergen's 207 clinics and /fylke/Vestland had a
// chip per spelling. Different slugs are never merged (OS is not OSLO). The
// groups are rebuilt only when the cache hands out a new list (once per TTL),
// not on every /, /fylke, /sted and /klinikk request.
export interface StedGroup {
  row: PoststedRow;
  spellings: string[];
  count: number;
}
let _stedGroups: { rows: PoststedRow[]; bySlug: Map<string, StedGroup>; bySize: StedGroup[] } | null = null;

function stedGroups(): { bySlug: Map<string, StedGroup>; bySize: StedGroup[] } {
  const rows = getCachedPoststeder();
  if (!_stedGroups || _stedGroups.rows !== rows) {
    const bySlug = new Map<string, StedGroup>();
    for (const p of rows) {
      const slug = slugifyText(p.poststed);
      const group = bySlug.get(slug);
      if (group) {
        group.spellings.push(p.poststed);
        group.count += p.count;
      } else {
        bySlug.set(slug, { row: p, spellings: [p.poststed], count: p.count });
      }
    }
    // Largest group first, for the chips; a tie keeps the list's order (sort is stable).
    const bySize = [...bySlug.values()].sort((a, b) => b.count - a.count);
    _stedGroups = { rows, bySlug, bySize };
  }
  return _stedGroups;
}

export function findStedGroup(stedSlug: string): StedGroup | undefined {
  return stedGroups().bySlug.get(stedSlug);
}

function findStedRow(stedSlug: string): PoststedRow | undefined {
  return findStedGroup(stedSlug)?.row;
}

// The spellings a /sted page lists: as many as the store's poststed_in takes,
// each within its length limit, the way the search parser builds poststed_in.
// A place with one spelling (or one usable spelling) keeps its row's.
function stedSpellings(group: StedGroup): string[] {
  const values = group.spellings.filter((v) => v.length <= MAX_TERM_CHARS).slice(0, MAX_POSTSTED_IN);
  return values.length > 1 ? values : [group.row.poststed];
}

// The store filter for a /sted page's clinics. One spelling gives the same
// { poststed } filter as before, so the SQL for such a place is unchanged.
export function stedFilter(group: StedGroup): ListFilter {
  const spellings = stedSpellings(group);
  return spellings.length > 1 ? { poststed_in: spellings } : { poststed: spellings[0]! };
}

router.get("/sted/:stedSlug", (req: Request, res: Response) => {
  const stedSlugParam = String(req.params.stedSlug).toLowerCase().trim();

  const stedGroup = findStedGroup(stedSlugParam);
  if (!stedGroup) {
    sendDentalNotFound(res,
      `<main><div class="container"><div class="empty-state" style="padding:80px 0"><h3>Sted ikke funnet</h3><p>Vi fant ikke tannleger for «${escapeHtml(stedSlugParam)}».</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div></main>`,
      { title: "Sted ikke funnet — Finn-tannlege.com" }
    );
    return;
  }

  const stedRow = stedGroup.row;
  const titledSted = titleCasePoststed(stedRow.poststed);
  // Every spelling of the place (D3b). Count first, so a ?side= past the
  // last page falls back to page 1 (F1-S1).
  const filter = stedFilter(stedGroup);
  let total = 0;
  try { total = countPublicDentalAgents(filter); } catch { /* db not ready */ }
  const { page, offset, totalPages } = resolveListPage(req.query.side, total);
  let agents: Array<DentalAgent & { id: string }> = [];
  try {
    agents = listPublicDentalAgents(filter, DENTAL_LANDING_CONFIG.listPageSize, offset);
  } catch { /* db not ready */ }

  const canonicalUrl = `${DENTAL_BASE_URL}/sted/${stedSlugParam}`;
  const baseUrl = `/sted/${stedSlugParam}`;
  // Page 1 keeps the bare canonical; page N ≥ 2 is its own (F1-S1).
  const pageUrl = `${DENTAL_BASE_URL}${listPageHref(baseUrl, page)}`;
  const pageMeta = listPageMeta(page, totalPages);

  const itemList = dentalItemListJsonLd(`Tannlege i ${titledSted}`, pageUrl, agents, offset);

  // BreadcrumbList
  const breadcrumbItems: BreadcrumbItem[] = [{ name: "Hjem", url: DENTAL_BASE_URL }];
  if (stedRow.fylke) breadcrumbItems.push({ name: stedRow.fylke, url: `${DENTAL_BASE_URL}/fylke/${encodeURIComponent(stedRow.fylke)}` });
  breadcrumbItems.push({ name: titledSted, url: canonicalUrl });
  const stedBreadcrumb = breadcrumbJsonLd(breadcrumbItems);

  const fylkeLink = stedRow.fylke
    ? `<p style="margin-top:16px;font-size:.9rem"><a href="/fylke/${encodeURIComponent(stedRow.fylke)}">&larr; Alle tannleger i ${escapeHtml(stedRow.fylke)}</a></p>`
    : `<p style="margin-top:16px;font-size:.9rem"><a href="/#fylker">&larr; Velg fylke</a></p>`;

  const resultCards = agents.length > 0
    ? agents.map(clinicCard).join("")
    : `<div class="empty-state"><h3>Ingen klinikker funnet</h3><p>Vi har ingen registrerte klinikker i ${escapeHtml(titledSted)} for øyeblikket.</p></div>`;

  const html = `
<main>
  <div class="profile-header">
    <div class="container">
      ${stedRow.fylke ? `<p style="font-size:.85rem;opacity:.7;margin-bottom:8px"><a href="/fylke/${encodeURIComponent(stedRow.fylke)}" style="color:rgba(255,255,255,.7)">&larr; ${escapeHtml(stedRow.fylke)}</a></p>` : ""}
      <h1 class="profile-name">Tannlege i ${escapeHtml(titledSted)}</h1>
      <p style="opacity:.8;font-size:.95rem">${total.toLocaleString("nb")} klinikker registrert</p>
    </div>
  </div>
  <div class="container" style="padding-top:28px;padding-bottom:48px">
    <p class="result-meta">Side ${page} av ${totalPages}</p>
    <div class="clinic-list" role="list" aria-label="Tannleger i ${escapeHtml(titledSted)}">
      ${resultCards}
    </div>
    ${paginationHtml(page, totalPages, baseUrl)}
    ${fylkeLink}
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  recordAiPageDelivery(req, res, "ai_page_list", agents.map((a) => a.id), "dental");
  res.send(dentalShell(html, {
    title: `Tannlege i ${titledSted}${pageMeta.title} — Finn-tannlege.com`,
    description: `Oversikt over ${total} tannlegeklinikker i ${titledSted}${stedRow.fylke ? `, ${stedRow.fylke}` : ""}. Finn klinikk med Helfo-avtale, spesialitet eller tannlegevakt.${pageMeta.description}`,
    canonical: pageUrl,
    // skive A: a /sted page with 0 active clinics must never be indexable.
    ...(total === 0 ? { robots: "noindex,follow" } : {}),
    jsonLd: [itemList, stedBreadcrumb],
  }));
});

// ═══════════════════════════════════════════════════════════
// PR-113: A2A discovery flater (FØR catch-all)
// ═══════════════════════════════════════════════════════════

// GET /.well-known/agent-card.json — A2A Agent Card (standard well-known path)
router.get("/.well-known/agent-card.json", agentCardUsageLogger("dental"), (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalAgentCard(safeHonestCatalogCount("dental")));
});

// GET /.well-known/jwks.json — JWKS for verifying A2A agent-card signatures
// (dev-request 2026-07-13-a2a-card-v1-signing slice 2). Same key across all
// three verticals (one Fly app serves all of them).
router.get("/.well-known/jwks.json", (_req: Request, res: Response) => {
  res.json(getJWKS());
});

// GET /.well-known/agents.txt + root alias /agents.txt — AI Agent Discovery File
// (parity with rfb discovery.ts and opplevagent experiences-seo.ts, which both
// serve the root alias; dev-request 2026-09-08-discovery-paritet-og-ett-katalogtall
// item 1). There is NO booking capability on finn-tannlege.com: none of the five
// MCP tools books anything (clinics are contacted directly), so the file must not
// claim it — the description/categories used to say "book"/"booking".
// API-base is the REST mount in index.ts (/api/tannlege, the prefix of every
// REST path in openapi.json); it said /api/tannleger, which is a 404
// (integrasjonstest MCP-02, dev-request 2026-10-17-integrasjonstest-oppfolging I-Q).
function serveDentalAgentsTxt(_req: Request, res: Response): void {
  res.header("Content-Type", "text/plain; charset=utf-8");
  res.header("Cache-Control", "public, max-age=3600");
  res.send(`# agents.txt — finn-tannlege.com
# AI Agent Discovery File
# See: https://github.com/dennj/agents.txt
User-agent: *
Allow-actions: search, read, discover, compare
Disallow-actions: modify, delete, register-without-key
Agent-card: ${DENTAL_BASE_URL}/.well-known/agent-card.json
MCP-endpoint: ${DENTAL_BASE_URL}/mcp
MCP-server-card: ${DENTAL_BASE_URL}/.well-known/mcp/server-card.json
A2A-endpoint: ${DENTAL_BASE_URL}/a2a
API-base: ${DENTAL_BASE_URL}/api/tannlege
Name: Finn-tannlege
Description: Norwegian dental practice directory — find and compare dental clinics (read-only; no online booking, contact the clinic directly)
Languages: no, en
Categories: dental, healthcare, directory, norway
Region: NO
Rate-limit: 1000 requests per 15 minutes (REST and A2A per IP, MCP per session)
Rate-limit: 500 requests per hour (admin)
Contact: https://github.com/slookisen/lokal/issues
`);
}
router.get("/.well-known/agents.txt", serveDentalAgentsTxt);
router.get("/agents.txt", serveDentalAgentsTxt);

// GET /.well-known/openai-apps-challenge — OpenAI Apps Directory domain
// verification (same literal-body pattern as rettfrabonden.com and
// opplevagent.no). The token is issued by OpenAI's Apps form for THIS domain
// and is deliberately not invented here: set DENTAL_OPENAI_APPS_CHALLENGE_TOKEN
// (Fly env) when the token is issued; until then the route answers 404 so a
// verifier never reads a wrong token.
router.get("/.well-known/openai-apps-challenge", (_req: Request, res: Response) => {
  const token = (process.env.DENTAL_OPENAI_APPS_CHALLENGE_TOKEN || "").trim();
  res.header("Content-Type", "text/plain");
  res.header("X-Content-Type-Options", "nosniff");
  if (!token) {
    res.status(404).send("openai-apps-challenge token not configured");
    return;
  }
  res.header("Cache-Control", "public, max-age=300");
  res.send(token);
});

// GET /.well-known/ai-plugin.json — ChatGPT plugin manifest (parity with rfb
// discovery.ts). OpenAI no longer loads plugins, but AI-discovery indexes still
// scan the file as a machine-readable API-contract signal and it points at the
// OpenAPI spec the Custom GPT's Actions use.
router.get("/.well-known/ai-plugin.json", (_req: Request, res: Response) => {
  const total = safeHonestCatalogCount("dental");
  res.header("Content-Type", "application/json");
  res.header("Cache-Control", "public, max-age=3600");
  res.header("X-Content-Type-Options", "nosniff");
  res.json({
    schema_version: "v1",
    name_for_human: "Finn-tannlege",
    name_for_model: "finn_tannlege",
    description_for_human:
      `Finn og sammenlign tannlegeklinikker i Norge — Helfo-avtale, spesialitet og akuttvakt. ${FINN_DISAMBIGUATION_NB}`.trim(),
    description_for_model:
      "Plugin for searching and comparing Norwegian dental clinics. " +
      (total ? `Provides access to ${total.toLocaleString("nb")} clinics ` : "Provides access to clinics ") +
      "with filters for county (fylke), specialty, Helfo direct-billing agreement and emergency-duty " +
      `(akuttvakt). Read-only: it does not book appointments — users contact the clinic directly. ${FINN_DISAMBIGUATION_EN}`.trim(),
    auth: { type: "none" },
    api: {
      type: "openapi",
      url: `${DENTAL_BASE_URL}/openapi.json`,
    },
    logo_url: `${DENTAL_BASE_URL}/favicon.svg`,
    contact_url: `${DENTAL_BASE_URL}/kontakt`,
    legal_info_url: `${DENTAL_BASE_URL}/vilkar`,
  });
});

// GET /agent-card.json — alias (some crawlers skip well-known prefix)
router.get("/agent-card.json", agentCardUsageLogger("dental"), (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalAgentCard(safeHonestCatalogCount("dental")));
});

// GET /openapi.json — OpenAPI 3.1 spec for finn-tannlege.com
router.get("/openapi.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalOpenapi());
});

// ═══════════════════════════════════════════════════════════
// MCP Server Card (SEP-1649) — dev-request 2026-07-13-mcp-2026-spec-server-card
// ═══════════════════════════════════════════════════════════
// Mirrors agent-readiness.ts's mcpServerCard() shape/field-names for
// rettfrabonden.com, but with finn-tannlege.com's own branding, endpoint,
// and MCP tools (see dental-mcp.ts's registerDentalTools).
function dentalMcpServerCard() {
  // ONE catalog number (services/honest-count.ts): same as llms.txt, agent card, /api/stats, /health.
  const stats = { total: safeHonestCatalogCount("dental") ?? 0 };
  const totalLabel = stats.total > 0 ? stats.total.toLocaleString("nb") : "thousands of";
  // Title and description as the live /mcp sends them in serverInfo (dental-mcp.ts, S4a).
  // Required lazily, as mcp-tool-manifest.ts does for `tools` below: dental-mcp imports this file.
  const { DENTAL_MCP_SERVER_TITLE, DENTAL_MCP_SERVER_DESCRIPTION } = require("./dental-mcp") as typeof import("./dental-mcp");

  return {
    // $schema deliberately omitted: the URL previously advertised here
    // (modelcontextprotocol.io/schemas/2025-11/server-card.schema.json) returns
    // 404, as does every other candidate probed on 2026-07-29 — SEP-1649 has no
    // published schema document yet. A $schema pointing at a 404 is worse than
    // none: a validating agent either errors or silently skips validation, and
    // both look like "we validated" from the outside. schemaVersion still names
    // the SEP revision this shape follows.
    schemaVersion: "2025-11",
    // Which protocol era this endpoint actually speaks — derived from the SDK,
    // never written down. See services/mcp-protocol-version.ts.
    ...mcpProtocolDeclaration(),
    name: "finn-tannlege",
    title: DENTAL_MCP_SERVER_TITLE,
    version: "0.1.0",
    description: `Search and compare ${totalLabel} Norwegian dental clinics. ${DENTAL_MCP_SERVER_DESCRIPTION}`,
    homepage: DENTAL_BASE_URL,
    repository: {
      type: "git",
      url: "https://github.com/slookisen/lokal",
    },
    documentation: `${DENTAL_BASE_URL}/llms.txt`,
    icon: `${DENTAL_BASE_URL}/favicon.svg`,
    // T3: the organisation behind the server is the company (same as the agent
    // card's provider); `name`/`title` above keep the brand.
    vendor: {
      name: agentCardProvider().organization,
      url: agentCardProvider().url,
    },
    license: "MIT",
    endpoints: [
      {
        protocol: "https+mcp",
        url: `${DENTAL_BASE_URL}/mcp`,
        description: "Remote MCP HTTP transport (Streamable HTTP). Compatible with ChatGPT connectors and remote Claude.",
      },
    ],
    transports: ["http", "streamable-http"],
    // What the live /mcp sends in initialize, read from the same registration as `tools`
    // (A2A dev-request 2026-10-17-dental-d3-rettelser, D3a): tools only, no resources or prompts.
    capabilities: registeredMcpCapabilities("dental"),
    // Generated from the tools the live /mcp server registers (services/mcp-tool-manifest.ts);
    // locked by src/routes/discovery-truth.test.ts against a real tools/list.
    tools: registeredMcpTools("dental"),
    authentication: {
      schemes: ["none"],
      description: "All MCP tools are read-only and require no authentication.",
    },
    keywords: [
      "tannlege",
      "dental",
      "tannlegeklinikk",
      "helfo",
      "akuttvakt",
      "healthcare",
      "norway",
      "norge",
      "kjeveortopedi",
    ],
    contact: {
      url: `${DENTAL_BASE_URL}/om`,
    },
    "x-finn-tannlege": {
      region: "Norway",
      totalClinics: stats.total,
      languages: ["no", "en"],
    },
  };
}

router.get("/.well-known/mcp/server-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(dentalMcpServerCard());
});

// Legacy / alternate paths (parity with agent-readiness.ts's rfb aliases)
router.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(dentalMcpServerCard());
});

router.get("/.well-known/mcp-server.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(dentalMcpServerCard());
});

router.get("/.well-known/mcp/server-cards.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  // Array wrapper form — some aggregators expect an array of cards.
  res.json([dentalMcpServerCard()]);
});

// dev-request 2026-09-16-glama-claim-well-known-finn-tannlege: Glama's HTTP-challenge
// connector claim. The token is not a secret — Glama states it's account-bound,
// contains no personal data, and is *meant* to be published at exactly this URL, so
// it lives in code like any other well-known content, not in Fly secrets.
router.get("/.well-known/glama.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json({
    "$schema": "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_8ro-LSuSmnjqfP0rV9lTbWMyXHtxKp0q",
  });
});

// ═══════════════════════════════════════════════════════════
// GET /kontakt — public contact form (finn-tannlege.com)
// ═══════════════════════════════════════════════════════════

router.get("/kontakt", (req: Request, res: Response) => {
  // The company facts (ehandelsloven § 8 / foretaksregisterloven § 7-2) follow
  // the URL language (/en/kontakt → English); the rest of the page is
  // Norwegian-only, as before.
  const coLang = toSiteLang(req.lang);
  const content = `
<main>
  <div class="container" style="max-width:640px;margin:0 auto;padding:40px 24px 80px">
    <h1 style="font-size:2rem;font-weight:800;color:var(--navy);margin-bottom:8px">Kontakt oss</h1>
    <p style="color:var(--g500);margin-bottom:32px">Spørsmål, feil i en klinikkprofil eller andre henvendelser? Vi svarer innen én virkedag.</p>

    <form id="contact-form" novalidate>
      <input type="text" name="_honey" value="" style="display:none;position:absolute;left:-9999px" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="platform" value="dental">

      <div style="margin-bottom:20px">
        <label for="cf-name" style="display:block;font-weight:600;color:var(--navy);margin-bottom:6px">Navn *</label>
        <input type="text" id="cf-name" name="name" required maxlength="100" autocomplete="name" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;color:var(--navy)">
      </div>

      <div style="margin-bottom:20px">
        <label for="cf-email" style="display:block;font-weight:600;color:var(--navy);margin-bottom:6px">E-post *</label>
        <input type="email" id="cf-email" name="email" required maxlength="254" autocomplete="email" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;color:var(--navy)">
      </div>

      <div style="margin-bottom:20px">
        <label for="cf-subject" style="display:block;font-weight:600;color:var(--navy);margin-bottom:6px">Emne</label>
        <input type="text" id="cf-subject" name="subject" maxlength="200" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;color:var(--navy)">
      </div>

      <div style="margin-bottom:20px">
        <label for="cf-message" style="display:block;font-weight:600;color:var(--navy);margin-bottom:6px">Melding *</label>
        <textarea id="cf-message" name="message" required maxlength="2000" rows="5" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;box-sizing:border-box;resize:vertical;color:var(--navy)"></textarea>
      </div>

      <p style="font-size:.82rem;color:var(--g500);margin-bottom:20px">Meldingen lagres for behandling av forespørselen din. Leses kun av oss.</p>

      <div class="cf-turnstile" data-sitekey="0x4AAAAAADr56qDaUM0XWoTF" data-theme="light" style="margin-bottom:20px"></div>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

      <button type="submit" class="btn-primary" style="display:inline-flex;align-items:center;gap:8px">Send melding</button>
    </form>

    <section class="co-sec" id="selskap"${coLang === "en" ? ' lang="en"' : ""}>
      <h2>${coLang === "en" ? "Company information" : "Selskapsinformasjon"}</h2>
      ${companyContactBlockHtml(coLang, { siteEmail: "kontakt@finn-tannlege.com", className: "co-facts" })}
    </section>
  </div>
</main>

<script>
(function(){
  var form = document.getElementById('contact-form');
  if(!form) return;
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Sender…';
    var data = Object.fromEntries(new FormData(form));
    var token = (document.querySelector('[name=cf-turnstile-response]') || {}).value || '';
    try {
      var res = await fetch('/api/contact', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(Object.assign({}, data, {cfTurnstileResponse: token}))
      });
      var json = await res.json();
      if(json.success){
        form.innerHTML = '<p style="color:var(--teal);font-size:1.1rem;font-weight:600;padding:24px 0">&#10003; Takk! Vi svarer så snart vi kan.</p>';
      } else {
        btn.disabled = false;
        btn.textContent = 'Send melding';
        alert('Noe gikk galt. Prøv igjen.');
      }
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Send melding';
      alert('Noe gikk galt. Prøv igjen.');
    }
  });
})();
</script>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    dentalShell(content, {
      title: "Kontakt oss — Finn-tannlege.com",
      description: "Ta kontakt med Finn-tannlege.com. Vi svarer på spørsmål, feil i klinikkprofiler og andre henvendelser innen én virkedag.",
      canonical: `${DENTAL_BASE_URL}/kontakt`,
    }),
  );
});

// ═══════════════════════════════════════════════════════════
// Catch-all 404 — norsk side (forhindrer rfb-innhold på dental-host)
// ═══════════════════════════════════════════════════════════

router.use((_req: Request, res: Response) => {
  sendDentalNotFound(res,
    `<main><div class="container"><div class="empty-state" style="padding:80px 0">
      <h3>Siden finnes ikke</h3>
      <p>Vi fant ikke siden du leter etter. Prøv å søke etter tannlege, eller gå til forsiden.</p>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;flex-wrap:wrap">
        <a href="/" class="btn-secondary">Til forsiden</a>
        <a href="/sok" class="btn-primary">Søk etter tannlege</a>
      </div>
    </div></div></main>`,
    { title: "Side ikke funnet (404) — Finn-tannlege.com" }
  );
});

export default router;
