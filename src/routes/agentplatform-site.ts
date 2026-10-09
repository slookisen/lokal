/**
 * agentplatform-site.ts — the company site for Agentplatform.no AS on
 * agentplatform.no (A2A dev-request 2026-10-08-agentplatform-no-paraplyside,
 * Daniel live 2026-10-08).
 *
 * agentplatform.no AS (org.nr 938 635 676, registered 2026-10-07) owns the
 * three services this app already runs: Rett fra Bonden (rettfrabonden.com),
 * Opplevagent (opplevagent.no) and Finn-tannlege (finn-tannlege.com). This
 * page is the umbrella over them: who the company is, and a direct way into
 * each service.
 *
 * Host-gated exactly like the finn-tannlege.com / opplevagent.no gates in
 * index.ts, with two differences that are deliberate:
 *   1. NOTHING passes through. No /api, /mcp, /a2a, /health or /.well-known
 *      from the rfb routers can answer on this host; every path is either one
 *      of the pages below or the branded 404.
 *   2. The gate is mounted BEFORE the analytics middleware and the RFB Link
 *      headers, so a visit here is never stamped vertical_id='rfb' (see
 *      analytics-service.ts getVerticalFromHost, whose default is rfb) and the
 *      page stays cookie- and tracking-free, as /personvern says. Clicks out to
 *      the services carry utm_source=agentplatform.no, which each service's own
 *      analytics already records (B4 UTM capture).
 *
 * No third-party requests: the Geist font (SIL OFL 1.1, licence next to the
 * file in src/public) and every icon are served from this host.
 */

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import * as fs from "fs";
import * as path from "path";
import { safeHonestCatalogCount, type CatalogVertical } from "../services/honest-count";
import { COMPANY_INFO } from "../config/company-info";
import { getTrafficStatsSnapshot } from "../services/traffic-stats";
import { getAgentToolCallsSnapshot } from "../services/agent-usage";

export const AGENTPLATFORM_HOSTS = new Set(["agentplatform.no", "www.agentplatform.no"]);
/**
 * Hosts that only ever redirect to the apex: www, and the Norwegian spelling
 * agentplattform.no (not registered yet, 2026-10-08 — once it is, DNS + a Fly
 * certificate are all it needs; see A2A runbooks/2026-10-08-agentplatform-no-dns-sertifikat-epost.md).
 */
export const AGENTPLATFORM_REDIRECT_HOSTS = new Set(["www.agentplatform.no", "agentplattform.no", "www.agentplattform.no"]);
export const AGENTPLATFORM_BASE_URL = "https://agentplatform.no";

// Company facts live in config/company-info.ts (shared with the product sites).
const COMPANY = COMPANY_INFO;
const ADDRESS_LINE = `${COMPANY.address.street}, ${COMPANY.address.postalCode} ${COMPANY.address.city}`;

type Lang = "nb" | "en";
type Text = Record<Lang, string>;

interface Service {
  vertical: CatalogVertical;
  name: string;
  domain: string;
  category: Text;
  description: Text;
  countLabel: Text;
  /** Short form for the hero illustration ("1 809 produsenter"). */
  shortLabel: Text;
  /** The service has an English site under /en (finn-tannlege.com does not). */
  hasEnglish: boolean;
  /** CSS custom-property suffix: --svc-<key> / --svc-<key>-ink. */
  key: string;
  /** Inline SVG; `uid` keeps gradient ids unique when a mark appears more than once on a page. */
  mark: (uid: string) => string;
}

const UTM = "utm_source=agentplatform.no&utm_medium=referral&utm_campaign=paraply";
/** Versioned (Geist 5.3.0) because it is cached for a year. */
export const FONT_URL = "/assets/geist-5.3.0-latin-wght.woff2";

export function serviceUrl(s: Pick<Service, "domain" | "hasEnglish">, lang: Lang): string {
  return `https://${s.domain}/${lang === "en" && s.hasEnglish ? "en" : ""}?${UTM}`;
}

// The three services' own app icons (their live /favicon.svg), redrawn without
// filters and with ids prefixed so they can sit inline on one page.
const RFB_MARK = (uid: string) => `<svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><defs><linearGradient id="rfb-bg-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7AB83A"/><stop offset=".55" stop-color="#5A9A2E"/><stop offset="1" stop-color="#3E7A1E"/></linearGradient></defs><rect width="1024" height="1024" rx="228" fill="url(#rfb-bg-${uid})"/><path d="M512 820C512 760 512 680 512 580" stroke="#fff" stroke-width="42" stroke-linecap="round" fill="none"/><path d="M512 580C420 620 280 560 220 380C320 360 470 430 512 580Z" fill="#fff"/><path d="M512 580C604 620 744 560 804 380C704 360 554 430 512 580Z" fill="#fff"/></svg>`;
const OA_MARK = (_uid: string) => `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" rx="17" fill="#ff5d3b"/><g transform="translate(12 13.6) scale(0.769)"><path d="M9 33 L24 11 L43 19 L31 38 Z" fill="none" stroke="#f7f4ee" stroke-width="2.4" stroke-linejoin="round" opacity="0.5"/><circle cx="9" cy="33" r="4.2" fill="#f7f4ee"/><circle cx="43" cy="19" r="4.2" fill="#f7f4ee"/><circle cx="31" cy="38" r="4.2" fill="#f7f4ee"/><path d="M24 3 C25.1 8.9 26.9 10.7 32.8 11.8 C26.9 12.9 25.1 14.7 24 20.6 C22.9 14.7 21.1 12.9 15.2 11.8 C21.1 10.7 22.9 8.9 24 3 Z" fill="#f7f4ee"/></g></svg>`;
const FT_MARK = (_uid: string) => `<svg viewBox="0 0 96 96" aria-hidden="true" focusable="false"><rect width="96" height="96" rx="19.2" fill="#0F766E"/><circle cx="40" cy="40" r="20" fill="none" stroke="#fff" stroke-width="6"/><line x1="54" y1="54" x2="70" y2="70" stroke="#fff" stroke-width="8" stroke-linecap="round"/><g transform="translate(27,18) scale(0.72)"><path d="M18 0 C8 0 2 7 2 16 C2 23 5 26 6 32 C7 39 9 46 12 46 C15 46 14 36 18 36 C22 36 21 46 24 46 C27 46 29 39 30 32 C31 26 34 23 34 16 C34 7 28 0 18 0 Z" fill="#fff"/></g></svg>`;

export const SERVICES: Service[] = [
  {
    vertical: "rfb",
    name: "Rett fra Bonden",
    domain: "rettfrabonden.com",
    hasEnglish: true,
    key: "rfb",
    category: { nb: "Lokal mat", en: "Local food" },
    description: {
      nb: "Finn gårder, gårdsbutikker og markeder som selger lokalprodusert mat direkte – med kontaktinfo, produkter og åpningstider.",
      en: "Find farms, farm shops and markets that sell local food direct – with contact details, products and opening hours.",
    },
    countLabel: { nb: "lokale matprodusenter", en: "local food producers" },
    shortLabel: { nb: "produsenter", en: "producers" },
    mark: RFB_MARK,
  },
  {
    vertical: "experiences",
    name: "Opplevagent",
    domain: "opplevagent.no",
    hasEnglish: true,
    key: "oa",
    category: { nb: "Opplevelser", en: "Experiences" },
    description: {
      nb: "Håndplukkede norske opplevelser og aktiviteter – fra hvalsafari og guidede turer til gårdssalg og matopplevelser.",
      en: "Hand-picked Norwegian experiences and activities – from whale safaris and guided tours to farm sales and food experiences.",
    },
    countLabel: { nb: "opplevelser", en: "experiences" },
    shortLabel: { nb: "opplevelser", en: "experiences" },
    mark: OA_MARK,
  },
  {
    vertical: "dental",
    name: "Finn-tannlege",
    domain: "finn-tannlege.com",
    hasEnglish: false,
    key: "ft",
    category: { nb: "Tannhelse", en: "Dental care" },
    description: {
      nb: "Uavhengig oversikt over tannlegeklinikker i hele Norge. Søk etter Helfo-avtale, spesialitet og tannlegevakt.",
      en: "An independent directory of dental clinics across Norway. Search by Helfo agreement, speciality and emergency care.",
    },
    countLabel: { nb: "tannlegeklinikker", en: "dental clinics" },
    shortLabel: { nb: "klinikker", en: "clinics" },
    mark: FT_MARK,
  },
];

// The company mark: a hub connecting three nodes in the three services' colours.
export const AGENTPLATFORM_MARK = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" rx="16" fill="#0B1B2B"/><g stroke="#ffffff" stroke-opacity=".38" stroke-width="2.2" stroke-linecap="round"><path d="M32 31 19 21M32 31 45 21M32 31v14"/><path d="M19 21h26L32 45Z" stroke-opacity=".16" fill="none"/></g><circle cx="19" cy="21" r="5.6" fill="#7AB83A"/><circle cx="45" cy="21" r="5.6" fill="#FF6A4A"/><circle cx="32" cy="45" r="5.6" fill="#2DD4BF"/><circle cx="32" cy="31" r="3.6" fill="#ffffff"/></svg>`;

export const FAVICON_SVG = AGENTPLATFORM_MARK.replace(
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">',
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
);

// ─── Small helpers ──────────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escape, then keep hyphenated "AI-…" words on one line ("AI-agenter" must not break after "AI-"). */
export function escKeep(s: string): string {
  return esc(s).replace(/\b(AI-[\p{L}]+)/gu, '<span class="nw">$1</span>');
}

/** 1809 → "1 809" with a no-break space, independent of the runtime's ICU data. */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
}

/** "Over N": round DOWN so the claim stays true (7 912 → 7 900; under 1 000 → exact). */
export function floorForClaim(n: number): number {
  return n >= 1000 ? Math.floor(n / 100) * 100 : n;
}

// ─── Live catalog counts (honest-count.ts), cached ──────────────────────────
export const COUNT_TTL_MS = 10 * 60_000;
/** A missing count (e.g. a vertical DB not ready at cold start) is retried sooner. */
export const COUNT_RETRY_MS = 30_000;
export type ServiceCounts = Record<CatalogVertical, number | null>;

export interface TrafficReading {
  realVisitors: number;
  aiCrawlerViews: number;
  windowDays: number;
}

export interface AgentCallReading {
  toolCalls: number;
  windowDays: number;
}

export interface AgentplatformDeps {
  readCount: (v: CatalogVertical) => number | null;
  /** Cached off-thread traffic stats for one service; null until they are ready. */
  readTraffic: (v: CatalogVertical) => TrafficReading | null;
  /** Cached off-thread tool-call count; null until it is ready. */
  readAgentCalls: () => AgentCallReading | null;
  now: () => number;
}

function defaultReadTraffic(v: CatalogVertical): TrafficReading | null {
  try {
    const snap = getTrafficStatsSnapshot(v);
    if (!snap.ready) return null;
    return { realVisitors: snap.stats.realVisitors, aiCrawlerViews: snap.stats.aiCrawlerViews, windowDays: snap.stats.windowDays };
  } catch {
    return null;
  }
}

function defaultReadAgentCalls(): AgentCallReading | null {
  try {
    const snap = getAgentToolCallsSnapshot();
    return snap.ready ? { toolCalls: snap.stats.toolCalls, windowDays: snap.stats.windowDays } : null;
  } catch {
    return null;
  }
}

// ─── Platform metrics for /partnere (Daniel live 2026-10-09) ─────────────────
// Every number is shown only when it is real: all three services must report
// (a sum over two of three would understate silently and is hidden instead),
// and 0 is treated as "no data", never printed.
export interface PlatformMetrics {
  catalogTotal: number | null;
  humanVisits: number | null;
  aiCrawlerViews: number | null;
  trafficWindowDays: number | null;
  agentToolCalls: number | null;
  agentWindowDays: number | null;
}

export function collectPlatformMetrics(deps: Pick<AgentplatformDeps, "readTraffic" | "readAgentCalls">, counts: ServiceCounts): PlatformMetrics {
  const verticals: CatalogVertical[] = ["rfb", "experiences", "dental"];
  const catalog = verticals.map((v) => counts[v]);
  const catalogTotal = catalog.every((n) => n != null) ? catalog.reduce((a: number, n) => a + (n as number), 0) : null;
  const traffic = verticals.map((v) => deps.readTraffic(v));
  const allTraffic = traffic.every((t) => t != null) ? (traffic as TrafficReading[]) : null;
  const humanVisits = allTraffic ? allTraffic.reduce((a, t) => a + t.realVisitors, 0) : null;
  const aiCrawlerViews = allTraffic ? allTraffic.reduce((a, t) => a + t.aiCrawlerViews, 0) : null;
  const windows = allTraffic ? new Set(allTraffic.map((t) => t.windowDays)) : null;
  const trafficWindowDays = windows && windows.size === 1 ? [...windows][0] : null;
  const agent = deps.readAgentCalls();
  const positive = (n: number | null) => (n != null && Number.isFinite(n) && n > 0 ? n : null);
  return {
    catalogTotal: positive(catalogTotal),
    humanVisits: trafficWindowDays ? positive(humanVisits) : null,
    aiCrawlerViews: trafficWindowDays ? positive(aiCrawlerViews) : null,
    trafficWindowDays,
    agentToolCalls: agent ? positive(agent.toolCalls) : null,
    agentWindowDays: agent ? agent.windowDays : null,
  };
}

/** "At least" display: 123 456 → 123 000, 5 527 → 5 500, 812 → 812 (always rounded down). */
export function floorForTile(n: number): number {
  if (n >= 10_000) return Math.floor(n / 1000) * 1000;
  if (n >= 1000) return Math.floor(n / 100) * 100;
  return n;
}

function makeCountCache(deps: AgentplatformDeps) {
  let cache: { at: number; ttl: number; counts: ServiceCounts } | null = null;
  return (): ServiceCounts => {
    const now = deps.now();
    if (!cache || now - cache.at >= cache.ttl) {
      const read = (v: CatalogVertical) => {
        const n = deps.readCount(v);
        return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
      };
      const counts = { rfb: read("rfb"), experiences: read("experiences"), dental: read("dental") };
      const anyMissing = Object.values(counts).some((n) => n == null);
      cache = { at: now, ttl: anyMissing ? COUNT_RETRY_MS : COUNT_TTL_MS, counts };
    }
    return cache.counts;
  };
}

// ─── Copy ───────────────────────────────────────────────────────────────────
const T = {
  nb: {
    htmlLang: "nb",
    ogLocale: "nb_NO",
    title: "Agentplatform.no AS – Rett fra Bonden, Opplevagent og Finn-tannlege",
    description:
      "Agentplatform.no AS står bak Rett fra Bonden, Opplevagent og Finn-tannlege – uavhengige norske tjenester for lokal mat, opplevelser og tannleger, laget for både mennesker og AI-agenter.",
    skip: "Hopp til innhold",
    navServices: "Tjenester",
    navPlatform: "Plattformen",
    navAbout: "Om oss",
    navContact: "Kontakt",
    navPartners: "Partnere",
    partnersHref: "/partnere",
    teaserKicker: "Samarbeid",
    teaserTitle: "For plattformer og bransjeaktører",
    teaserBody:
      "Representerer dere produsenter, gårder, opplevelsestilbydere eller klinikker? Vi kan gjøre tilbudene synlige for AI-assistenter – i våre tjenester, eller koblet til deres egen tjeneste etter avtale.",
    teaserCta: "Les om partnerskap",
    founderLabel: "Daglig leder",
    founderLinkedIn: "LinkedIn-profil",
    pTitle: "Partnerskap – Agentplatform.no AS",
    pDescription:
      "Samarbeid med Agentplatform.no AS: gjør produsenter, opplevelser og andre lokale tilbud synlige for AI-assistenter. Tall, samarbeidsform og kontakt.",
    pKicker: "For partnere",
    pH1: "Gjør tilbydere synlige der folk spør AI-assistenter",
    pLead:
      "Vi samarbeider med plattformer, organisasjoner og bransjeaktører som representerer lokale tilbydere. Sammen sørger vi for at tilbudene blir funnet – både av folk som søker selv, og av ChatGPT, Claude og andre assistenter som søker for dem.",
    pCta: "Ta kontakt",
    pCtaSecondary: "Se tallene",
    pMailSubject: "Samarbeid",
    pOfferKicker: "Hva vi kan tilby",
    pOfferTitle: "Tre måter å samarbeide på",
    pOffers: [
      {
        title: "Synlighet i tjenestene våre",
        body: "Tilbyderne dere representerer presenteres samlet i Rett fra Bonden, Opplevagent eller Finn-tannlege, med kontrollerte opplysninger og lenke tilbake til dere.",
      },
      {
        title: "Agent-tilgang til katalogen deres",
        body: "Vi kan gjøre katalogen deres søkbar for AI-agenter gjennom MCP og A2A, koblet til deres egen tjeneste etter avtale.",
      },
      {
        title: "Data og grensesnitt",
        body: "Strukturerte data om tilbudene gjennom grensesnittene våre, til bruk i egne tjenester etter avtale.",
      },
    ],
    pMetricsKicker: "Plattformen i tall",
    pMetricsTitle: "Bruk vi kan dokumentere",
    pMetricsLead:
      "Tallene hentes automatisk fra plattformens egen statistikk og gjelder Rett fra Bonden, Opplevagent og Finn-tannlege samlet. Besøk, sidevisninger og kall er rundet ned.",
    mCatalogLabel: "oppføringer i katalogene",
    mCatalogDef: "Aktive, publiserte oppføringer akkurat nå.",
    mHumanLabel: (d: number) => `besøk fra mennesker siste ${d} dager`,
    mHumanDef: "Økter som ikke er identifisert som roboter, crawlere eller søkemotorer.",
    mCrawlerLabel: (d: number) => `sidevisninger fra AI-crawlere siste ${d} dager`,
    mCrawlerDef: "Sidevisninger fra kjente KI-crawlere, som GPTBot og ClaudeBot.",
    mAgentLabel: (d: number) => `verktøykall fra AI-agenter siste ${d} dager`,
    mAgentDef: "Kall til verktøyene våre via MCP: søk, oppslag, handlekurv og bestilling. Oppkobling, verktøylister, egne agenter og kjente register- og overvåkingsprober er holdt utenfor.",
    pStepsKicker: "Slik samarbeider vi",
    pStepsTitle: "Fra samtale til avtale",
    pSteps: [
      { title: "Samtale", body: "Vi går gjennom hvem dere representerer og hva dere vil oppnå." },
      { title: "Pilot", body: "Et avgrenset utvalg tilbydere, der vi måler effekten før dere bestemmer dere." },
      { title: "Avtale", body: "En fast avtale tilpasset omfanget." },
    ],
    pInvKicker: "For investorer",
    pInvTitle: "Tidlig fase, åpen for de riktige partnerne",
    pInvBody:
      "Agentplatform.no AS eies i dag av gründeren og er i en tidlig fase. Vi er åpne for dialog med strategiske investorer som kan bidra med kunder, bransjetilgang eller distribusjon, og som deler målet om å gjøre lokale tilbydere synlige for AI-assistenter.",
    pInvCta: "Ta kontakt for en samtale",
    pInvMailSubject: "Investering",
    pDisclaimer: "Informasjonen på denne siden er ikke et tilbud om kjøp eller tegning av aksjer i Agentplatform.no AS.",
    pContactTitle: "La oss snakke sammen",
    pContactBody: "Fortell kort hvem dere er og hva dere ønsker å få til, så tar vi kontakt for en samtale.",
    langSwitch: "English",
    langSwitchShort: "EN",
    langSwitchHref: "/en",
    langSwitchHreflang: "en",
    heroEyebrow: "Agentplatform.no AS",
    heroTitle: "Vi kobler mennesker og AI-agenter med lokale tilbydere i hele Norge.",
    heroLead:
      "Vi står bak Rett fra Bonden, Opplevagent og Finn-tannlege – uavhengige oversikter over lokal mat, opplevelser og tannleger. Gratis å bruke på nett, og tilgjengelige direkte fra ChatGPT, Claude og andre AI-assistenter.",
    heroCtaPrimary: "Utforsk tjenestene",
    heroCtaSecondary: "Om selskapet",
    quickLabel: "Snarveier til tjenestene",
    heroFactsOver: (n: string) => `Over ${n} oppføringer`,
    heroFactsServices: "Tre tjenester",
    heroFactsOrg: `Org.nr. ${COMPANY.orgNrDisplay}`,
    servicesKicker: "Våre tjenester",
    servicesTitle: "Velg tjenesten du trenger",
    servicesLead: "Tre uavhengige oversikter, bygget på samme plattform og med de samme kravene til kvalitet.",
    visit: (name: string) => `Gå til ${name}`,
    platformKicker: "Plattformen",
    platformTitle: "Laget for måten folk leter på i dag",
    platformLead:
      "Stadig flere spør en AI-assistent i stedet for å søke selv. Tjenestene våre er laget for begge deler.",
    pillars: [
      {
        title: "Verifiserte tilbydere",
        body: "Vi sjekker tilbyderne mot Brønnøysundregistrene og tilbydernes egne nettsider, og holder oppføringene oppdatert.",
      },
      {
        title: "Åpent for AI-agenter",
        body: "Hver tjeneste har åpne grensesnitt (MCP og A2A), slik at AI-assistenter kan slå opp i oppdaterte data i stedet for å gjette.",
      },
      {
        title: "Uavhengig og gratis",
        body: "Tjenestene er gratis å bruke, og selskapet er ikke eid av noen av aktørene vi viser fram.",
      },
    ],
    devKicker: "For utviklere og AI-agenter",
    devTitle: "Koble til direkte",
    devLead: "Alle endepunktene er åpne. Detaljer, verktøy og eksempler står i hver tjenestes llms.txt.",
    devColService: "Tjeneste",
    devColMcp: "MCP-endepunkt",
    devColCard: "Agent card",
    devColDocs: "Dokumentasjon",
    aboutKicker: "Om oss",
    aboutTitle: "Et norsk teknologiselskap",
    aboutBody: [
      "Agentplatform.no AS ble stiftet i 2026 for å samle tjenestene under ett selskap. Vi utvikler programvare som gjør lokale tilbud lettere å finne – både for folk som søker selv, og for AI-assistentene de bruker.",
      "Tjenestene deler én teknisk plattform. Driften støttes av egne AI-agenter som henter inn, kontrollerer og oppdaterer data, med menneskelig godkjenning der det betyr noe.",
    ],
    factsTitle: "Selskapsinformasjon",
    factName: "Foretaksnavn",
    factOrg: "Organisasjonsnummer",
    factFounded: "Stiftet",
    factFoundedValue: "3. oktober 2026",
    factAddress: "Forretningsadresse",
    factEmail: "E-post",
    factRegister: "Registrert i",
    factRegisterValue: "Foretaksregisteret",
    factsMore: "All kontaktinformasjon",
    contactHref: "/kontakt",
    footerRegistered: "Registrert i Foretaksregisteret",
    contactPageTitle: "Kontakt og selskapsinformasjon",
    contactPageLead: "Ta kontakt med oss om tjenestene, samarbeid eller presse.",
    contactPageServicesTitle: "Gjelder det en oppføring på en av tjenestene?",
    contactPageServicesBody: "Tjenestene har egne kontaktsider der du raskest får hjelp med en oppføring:",
    factOrgLinkTitle: "Se selskapet i Brønnøysundregistrene",
    contactTitle: "Ta kontakt",
    contactBody:
      "Spørsmål om en av tjenestene, samarbeid eller presse? Send oss en e-post, så svarer vi så raskt vi kan.",
    contactNote: "Er du tilbyder og vil oppdatere en oppføring? Det gjør du enklest på tjenesten der du står oppført.",
    footerTagline: "Norske tjenester for mennesker og AI-agenter.",
    footerServices: "Tjenester",
    footerCompany: "Selskapet",
    footerPrivacy: "Personvern",
    privacyHref: "/personvern",
    homeHref: "/",
    notFoundTitle: "Siden finnes ikke",
    notFoundBody: "Adressen kan være feil, eller siden er flyttet. Herfra kommer du videre til tjenestene våre.",
    notFoundCta: "Til forsiden",
  },
  en: {
    htmlLang: "en",
    ogLocale: "en_GB",
    title: "Agentplatform.no AS – Rett fra Bonden, Opplevagent and Finn-tannlege",
    description:
      "Agentplatform.no AS is the company behind Rett fra Bonden, Opplevagent and Finn-tannlege – independent Norwegian services for local food, experiences and dental care, built for people and AI agents alike.",
    skip: "Skip to content",
    navServices: "Services",
    navPlatform: "Platform",
    navAbout: "About",
    navContact: "Contact",
    navPartners: "Partners",
    partnersHref: "/en/partners",
    teaserKicker: "Partnerships",
    teaserTitle: "For platforms and industry players",
    teaserBody:
      "Do you represent producers, farms, experience providers or clinics? We can make their offerings visible to AI assistants – in our services, or connected to your own service by agreement.",
    teaserCta: "Read about partnerships",
    founderLabel: "CEO",
    founderLinkedIn: "LinkedIn profile",
    pTitle: "Partnerships – Agentplatform.no AS",
    pDescription:
      "Partner with Agentplatform.no AS: make producers, experiences and other local offerings visible to AI assistants. Figures, ways of working and contact.",
    pKicker: "For partners",
    pH1: "Make providers visible where people ask AI assistants",
    pLead:
      "We work with platforms, organisations and industry players that represent local providers. Together we make sure their offerings are found – by people searching themselves, and by ChatGPT, Claude and other assistants searching for them.",
    pCta: "Get in touch",
    pCtaSecondary: "See the figures",
    pMailSubject: "Partnership",
    pOfferKicker: "What we offer",
    pOfferTitle: "Three ways to work together",
    pOffers: [
      {
        title: "Visibility in our services",
        body: "The providers you represent are presented together in Rett fra Bonden, Opplevagent or Finn-tannlege, with checked details and a link back to you.",
      },
      {
        title: "Agent access to your catalogue",
        body: "We can make your catalogue searchable for AI agents through MCP and A2A, connected to your own service by agreement.",
      },
      {
        title: "Data and interfaces",
        body: "Structured data about the offerings through our interfaces, for use in your own services by agreement.",
      },
    ],
    pMetricsKicker: "The platform in figures",
    pMetricsTitle: "Usage we can document",
    pMetricsLead:
      "The figures come automatically from the platform's own statistics and cover Rett fra Bonden, Opplevagent and Finn-tannlege together. Visits, page views and calls are rounded down.",
    mCatalogLabel: "listings in the directories",
    mCatalogDef: "Active, published listings right now.",
    mHumanLabel: (d: number) => `visits from people in the last ${d} days`,
    mHumanDef: "Sessions not identified as bots, crawlers or search engines.",
    mCrawlerLabel: (d: number) => `page views by AI crawlers in the last ${d} days`,
    mCrawlerDef: "Page views by known AI crawlers, such as GPTBot and ClaudeBot.",
    mAgentLabel: (d: number) => `tool calls from AI agents in the last ${d} days`,
    mAgentDef: "Calls to our tools over MCP: search, lookup, cart and ordering. Connection set-up, tool listings, our own agents and known registry and monitoring probes are excluded.",
    pStepsKicker: "How we work",
    pStepsTitle: "From conversation to agreement",
    pSteps: [
      { title: "Conversation", body: "We go through who you represent and what you want to achieve." },
      { title: "Pilot", body: "A limited set of providers, where we measure the effect before you decide." },
      { title: "Agreement", body: "A fixed agreement sized to the scope." },
    ],
    pInvKicker: "For investors",
    pInvTitle: "Early stage, open to the right partners",
    pInvBody:
      "Agentplatform.no AS is currently owned by its founder and is at an early stage. We are open to conversations with strategic investors who can contribute customers, industry access or distribution, and who share the goal of making local providers visible to AI assistants.",
    pInvCta: "Get in touch for a conversation",
    pInvMailSubject: "Investment",
    pDisclaimer: "The information on this page is not an offer to buy or subscribe for shares in Agentplatform.no AS.",
    pContactTitle: "Let's talk",
    pContactBody: "Tell us briefly who you are and what you want to achieve, and we will get back to you for a conversation.",
    langSwitch: "Norsk",
    langSwitchShort: "NO",
    langSwitchHref: "/",
    langSwitchHreflang: "nb",
    heroEyebrow: "Agentplatform.no AS",
    heroTitle: "We connect people and AI agents with local providers across Norway.",
    heroLead:
      "We run Rett fra Bonden, Opplevagent and Finn-tannlege – independent directories of local food, experiences and dental clinics. Free to use on the web, and available directly in ChatGPT, Claude and other AI assistants.",
    heroCtaPrimary: "Explore the services",
    heroCtaSecondary: "About the company",
    quickLabel: "Shortcuts to the services",
    heroFactsOver: (n: string) => `Over ${n} listings`,
    heroFactsServices: "Three services",
    heroFactsOrg: `Org. no. ${COMPANY.orgNrDisplay}`,
    servicesKicker: "Our services",
    servicesTitle: "Choose the service you need",
    servicesLead: "Three independent directories, built on one platform and held to the same quality bar.",
    visit: (name: string) => `Go to ${name}`,
    platformKicker: "The platform",
    platformTitle: "Built for how people search today",
    platformLead:
      "More and more people ask an AI assistant instead of searching themselves. Our services are built for both.",
    pillars: [
      {
        title: "Verified providers",
        body: "We check providers against the Norwegian business register and their own websites, and keep listings up to date.",
      },
      {
        title: "Open to AI agents",
        body: "Every service has open interfaces (MCP and A2A), so AI assistants can look up current data instead of guessing.",
      },
      {
        title: "Independent and free",
        body: "The services are free to use, and the company is not owned by any of the businesses we list.",
      },
    ],
    devKicker: "For developers and AI agents",
    devTitle: "Connect directly",
    devLead: "All endpoints are open. Tools, details and examples are in each service's llms.txt.",
    devColService: "Service",
    devColMcp: "MCP endpoint",
    devColCard: "Agent card",
    devColDocs: "Documentation",
    aboutKicker: "About",
    aboutTitle: "A Norwegian technology company",
    aboutBody: [
      "Agentplatform.no AS was founded in 2026 to bring the services together under one company. We build software that makes local offerings easier to find – for people searching themselves, and for the AI assistants they use.",
      "The services share one technical platform. Day-to-day operations are supported by our own AI agents that collect, check and update data, with human approval where it matters.",
    ],
    factsTitle: "Company information",
    factName: "Company name",
    factOrg: "Organisation number",
    factFounded: "Founded",
    factFoundedValue: "3 October 2026",
    factAddress: "Registered address",
    factEmail: "Email",
    factRegister: "Registered in",
    factRegisterValue: "the Register of Business Enterprises",
    factsMore: "Full contact details",
    contactHref: "/en/contact",
    footerRegistered: "Registered in the Norwegian Register of Business Enterprises",
    contactPageTitle: "Contact and company details",
    contactPageLead: "Get in touch about the services, partnerships or press.",
    contactPageServicesTitle: "Is it about a listing on one of the services?",
    contactPageServicesBody: "Each service has its own contact page, where you get help with a listing fastest:",
    factOrgLinkTitle: "View the company in the Brønnøysund Register Centre",
    contactTitle: "Get in touch",
    contactBody: "Questions about one of the services, partnerships or press? Send us an email and we will reply as soon as we can.",
    contactNote: "Are you a provider who wants to update a listing? That is easiest on the service where you are listed.",
    footerTagline: "Norwegian services for people and AI agents.",
    footerServices: "Services",
    footerCompany: "Company",
    footerPrivacy: "Privacy",
    privacyHref: "/en/privacy",
    homeHref: "/en",
    notFoundTitle: "Page not found",
    notFoundBody: "The address may be wrong, or the page has moved. You can reach our services from here.",
    notFoundCta: "Go to the front page",
  },
} as const;

// ─── Styles ─────────────────────────────────────────────────────────────────
const CSS = `
@font-face{font-family:"Geist";src:url("${FONT_URL}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{
  --bg:#f8f7f3;--bg-2:#f1efe8;--surface:#ffffff;--ink:#0b1b2b;--ink-2:#334155;--muted:#5b6474;--line:#e3e0d7;--line-2:#d6d2c6;
  --brand:#0b1b2b;--on-brand:#ffffff;--focus:#2563eb;
  --svc-rfb:#4f8f26;--svc-rfb-ink:#2d5016;--svc-rfb-tint:#eef6e7;
  --svc-oa:#ff5d3b;--svc-oa-ink:#b8381c;--svc-oa-tint:#fff0eb;
  --svc-ft:#0f766e;--svc-ft-ink:#0f665f;--svc-ft-tint:#e6f4f2;
  --band:#0b1b2b;--band-ink:#e8edf3;--band-muted:#a9b4c2;--band-line:rgba(255,255,255,.12);
  --hub-edge:transparent;
  --radius:20px;--shadow:0 1px 2px rgba(11,27,43,.05),0 8px 24px -12px rgba(11,27,43,.12);
  --shadow-hover:0 2px 4px rgba(11,27,43,.06),0 24px 48px -20px rgba(11,27,43,.28);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0a0f16;--bg-2:#0e151f;--surface:#111a26;--ink:#eef2f7;--ink-2:#c7d0db;--muted:#94a0b0;--line:#1f2a38;--line-2:#2a3747;
  --brand:#eef2f7;--on-brand:#0b1b2b;--focus:#60a5fa;
  --svc-rfb:#7ab83a;--svc-rfb-ink:#9fd36a;--svc-rfb-tint:rgba(122,184,58,.10);
  --svc-oa:#ff7a5c;--svc-oa-ink:#ff9b82;--svc-oa-tint:rgba(255,106,74,.10);
  --svc-ft:#2dd4bf;--svc-ft-ink:#5eead4;--svc-ft-tint:rgba(45,212,191,.10);
  --band:#0e151f;--band-line:rgba(255,255,255,.08);--hub-edge:rgba(255,255,255,.16);
  --shadow:0 1px 2px rgba(0,0,0,.4);--shadow-hover:0 24px 48px -20px rgba(0,0,0,.7);
  color-scheme:dark;
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:84px}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
img,svg{display:block;max-width:100%}
a{color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:6px}
.wrap{width:100%;max-width:1160px;margin:0 auto;padding:0 24px}
.skip{position:absolute;left:16px;top:-48px;z-index:100;background:var(--brand);color:var(--on-brand);padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600}
.skip:focus{top:12px}
.nw{white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* Header */
.hdr{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg) 82%,transparent);-webkit-backdrop-filter:saturate(180%) blur(14px);backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid transparent;transition:border-color .2s}
.hdr.is-solid,.hdr:has(+ main .page){border-bottom-color:var(--line)}
.hdr-in{display:flex;align-items:center;justify-content:space-between;height:68px;gap:24px}
.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);font-weight:650;font-size:19px;letter-spacing:-.02em}
.brand svg{width:32px;height:32px}
.brand span span{color:var(--muted);font-weight:500}
.nav{display:flex;align-items:center;gap:4px}
.nav a{text-decoration:none;color:var(--ink-2);font-size:15px;font-weight:500;padding:8px 12px;border-radius:10px;transition:background .15s,color .15s}
.nav a:hover{background:var(--bg-2);color:var(--ink)}
.nav .lang{margin-left:8px;border:1px solid var(--line-2);color:var(--ink);font-weight:600}
@media (max-width:760px){.nav .opt{display:none}}

/* Hero */
.hero{position:relative;overflow:hidden;padding:72px 0 48px}
.hero::before{content:"";position:absolute;inset:-20% -10% auto -10%;height:640px;z-index:-1;pointer-events:none;
  background:
    radial-gradient(42% 60% at 14% 18%,color-mix(in srgb,var(--svc-rfb) 22%,transparent),transparent 70%),
    radial-gradient(38% 55% at 52% 0%,color-mix(in srgb,var(--svc-oa) 16%,transparent),transparent 70%),
    radial-gradient(44% 62% at 88% 22%,color-mix(in srgb,var(--svc-ft) 20%,transparent),transparent 70%);
  filter:blur(8px)}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:var(--ink-2);background:color-mix(in srgb,var(--surface) 70%,transparent);border:1px solid var(--line);padding:6px 14px 6px 8px;border-radius:999px}
.eyebrow i{display:inline-flex;gap:3px}
.eyebrow i b{width:8px;height:8px;border-radius:50%;display:block}
.eyebrow i b:nth-child(1){background:var(--svc-rfb)}.eyebrow i b:nth-child(2){background:var(--svc-oa)}.eyebrow i b:nth-child(3){background:var(--svc-ft)}
.hero-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:48px;align-items:center}
@media (min-width:1080px){.hero-grid{grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr)}}
.hero-art{display:none;position:relative;width:100%;max-width:480px;aspect-ratio:1/1;justify-self:end}
@media (min-width:1080px){.hero-art{display:block}}
.hero-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.orbit{fill:none;stroke:var(--line-2);stroke-width:1;vector-effect:non-scaling-stroke;stroke-dasharray:2 6}
.orbit-2{opacity:.6}
.flow{fill:none;stroke:var(--ink-2);stroke-opacity:.35;stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-dasharray:5 7;stroke-linecap:round;animation:flow 2.4s linear 2}
.flow-2{animation-delay:-.8s}.flow-3{animation-delay:-1.6s}
@keyframes flow{to{stroke-dashoffset:-24}}
.hub{position:absolute;left:50%;top:50%;width:116px;height:116px;transform:translate(-50%,-50%);border-radius:30px;box-shadow:0 0 0 1px var(--hub-edge),0 0 0 12px color-mix(in srgb,var(--ink) 5%,transparent),0 0 0 26px color-mix(in srgb,var(--ink) 3%,transparent),0 30px 60px -24px rgba(11,27,43,.55)}
.hub svg{width:116px;height:116px}
.node{position:absolute;transform:translate(-50%,-50%);text-decoration:none;color:inherit;transition:transform .2s ease,border-color .2s;display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:10px 16px 10px 10px;box-shadow:var(--shadow-hover);white-space:nowrap}
.node:hover{transform:translate(-50%,calc(-50% - 3px));border-color:color-mix(in srgb,var(--c) 45%,var(--line))}
.node svg{width:40px;height:40px;flex:none}
.quick{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}
@media (min-width:1080px){.quick{display:none}}
.quick a{display:inline-flex;align-items:center;gap:10px;padding:8px 14px 8px 8px;border:1px solid var(--line);border-radius:14px;background:var(--surface);text-decoration:none;font-weight:600;font-size:15px;box-shadow:var(--shadow)}
.quick a:hover{border-color:color-mix(in srgb,var(--c) 45%,var(--line))}
.quick svg{width:28px;height:28px;border-radius:7px}
.node span{display:grid;line-height:1.25}
.node b{font-size:15px;font-weight:650;letter-spacing:-.01em}
.node small{font-size:13px;color:var(--ci);font-weight:550;font-variant-numeric:tabular-nums}
.hero h1{font-size:clamp(38px,5vw,60px);line-height:1.04;letter-spacing:-.035em;font-weight:650;margin:24px 0 0;max-width:19ch;text-wrap:balance}
.lead{font-size:clamp(18px,2vw,21px);line-height:1.55;color:var(--ink-2);max-width:60ch;margin:24px 0 0;text-wrap:pretty}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:36px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 24px;border-radius:14px;font-weight:600;font-size:16px;text-decoration:none;transition:transform .15s,background .15s,border-color .15s,box-shadow .15s}
.btn-primary{background:var(--brand);color:var(--on-brand);box-shadow:var(--shadow)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:var(--shadow-hover)}
.btn-ghost{border:1px solid var(--line-2);color:var(--ink);background:color-mix(in srgb,var(--surface) 60%,transparent)}
.btn-ghost:hover{border-color:var(--ink-2)}
.btn svg{width:18px;height:18px}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin:44px 0 0;padding:0;list-style:none;color:var(--muted);font-size:15px;font-weight:500}
.facts li{display:inline-flex;align-items:center;gap:8px}
.facts li::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--line-2)}

/* Sections */
section{padding:88px 0}
.kicker{font-size:13px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0}
h2{font-size:clamp(30px,4vw,46px);line-height:1.1;letter-spacing:-.03em;font-weight:650;margin:12px 0 0;text-wrap:balance}
.sec-lead{font-size:18px;color:var(--ink-2);max-width:62ch;margin:16px 0 0}
.sec-head{margin-bottom:44px}

/* Service cards */
.services{padding-top:24px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media (max-width:980px){.cards{grid-template-columns:1fr}}
.card{position:relative;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:28px;text-decoration:none;color:inherit;box-shadow:var(--shadow);transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;isolation:isolate;overflow:hidden}
.card::before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:var(--c)}
.card::after{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(120% 80% at 100% 0%,var(--t),transparent 60%);opacity:.0;transition:opacity .25s}
.card:hover,.card:focus-visible{transform:translateY(-4px);box-shadow:var(--shadow-hover);border-color:color-mix(in srgb,var(--c) 45%,var(--line))}
.card:hover::after,.card:focus-visible::after{opacity:1}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.card-mark{width:56px;height:56px;border-radius:14px;box-shadow:0 6px 16px -8px rgba(11,27,43,.35)}
.card-mark svg{width:56px;height:56px}
.chip{font-size:13px;font-weight:600;color:var(--ci);background:var(--t);border-radius:999px;padding:5px 12px}
.card h3{font-size:26px;letter-spacing:-.02em;line-height:1.2;font-weight:650;margin:24px 0 0}
.card .dom{display:block;color:var(--muted);font-size:15px;font-weight:500;margin-top:2px}
.card p{color:var(--ink-2);margin:14px 0 0;font-size:16px}
.stat{margin-top:auto;padding-top:24px}
.stat-in{border-top:1px solid var(--line);padding-top:18px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.stat strong{font-size:30px;letter-spacing:-.03em;font-weight:650;color:var(--ci);font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:15px}
.card-foot{margin-top:20px;font-weight:600}
.go{display:inline-flex;align-items:center;gap:8px;color:var(--ink)}
.go svg{width:20px;height:20px;transition:transform .2s}
.card:hover .go svg,.card:focus-visible .go svg{transform:translateX(4px)}
.svc-rfb{--c:var(--svc-rfb);--ci:var(--svc-rfb-ink);--t:var(--svc-rfb-tint)}
.svc-oa{--c:var(--svc-oa);--ci:var(--svc-oa-ink);--t:var(--svc-oa-tint)}
.svc-ft{--c:var(--svc-ft);--ci:var(--svc-ft-ink);--t:var(--svc-ft-tint)}

/* Platform band */
.band{background:var(--band);color:var(--band-ink);border-radius:32px;margin:0 16px;padding:88px 0;border:1px solid var(--band-line)}
.band .kicker{color:var(--band-muted)}
.band .sec-lead{color:var(--band-muted)}
.pillars{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:48px}
@media (max-width:980px){.pillars{grid-template-columns:1fr}}
.pillar{border:1px solid var(--band-line);border-radius:var(--radius);padding:28px;background:rgba(255,255,255,.03)}
.pillar-ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,.08)}
.pillar-ic svg{width:22px;height:22px}
.pillar h3{font-size:20px;letter-spacing:-.01em;font-weight:650;margin:20px 0 0;color:#fff}
.pillar p{margin:8px 0 0;color:var(--band-muted);font-size:16px}

/* Developer table */
.dev-table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.dev-table th,.dev-table td{text-align:left;padding:16px 20px;border-bottom:1px solid var(--line);vertical-align:middle}
.dev-table tr:last-child td{border-bottom:0}
.dev-table th{font-size:13px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:var(--bg-2)}
.dev-table td:first-child{font-weight:600;white-space:nowrap}
.dev-svc{display:inline-flex;align-items:center;gap:10px}
.dev-svc svg{width:24px;height:24px;border-radius:6px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14px;background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:3px 8px;word-break:break-all}
.dev-table a{color:var(--ink);text-underline-offset:3px;text-decoration-color:var(--line-2)}
.dev-table a:hover{text-decoration-color:var(--ink)}
@media (max-width:760px){
  .dev-table thead{display:none}
  .dev-table,.dev-table tbody,.dev-table tr,.dev-table td{display:block;width:100%}
  .dev-table tr{border-bottom:1px solid var(--line);padding:12px 0}
  .dev-table tr:last-child{border-bottom:0}
  .dev-table td{border:0;padding:6px 20px}
  .dev-table td[data-l]::before{content:attr(data-l);display:block;font-size:12px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
}

/* About */
.about{display:grid;grid-template-columns:1.2fr 1fr;gap:56px;align-items:start}
@media (max-width:980px){.about{grid-template-columns:1fr;gap:36px}}
.about p:not(.kicker){color:var(--ink-2);font-size:18px;margin:20px 0 0;max-width:60ch}
.facts-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:8px 28px;box-shadow:var(--shadow)}
.facts-card .facts-h{font-size:13px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:20px 0 4px}
.facts-card dl{margin:0}
.facts-card div{display:grid;grid-template-columns:minmax(150px,auto) 1fr;gap:16px;padding:14px 0;border-top:1px solid var(--line)}
.facts-card div:first-child{border-top:0}
.facts-card dt{color:var(--muted);font-size:15px}
.facts-card dd{margin:0;font-weight:550;font-size:15px}
.facts-card dd a{text-underline-offset:3px;text-decoration-color:var(--line-2)}
@media (max-width:480px){.facts-card div{grid-template-columns:1fr;gap:2px}}
.facts-card .facts-more{margin:0;border-top:1px solid var(--line);padding:14px 0 18px}
.facts-more a{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:15px;text-decoration:none}
.facts-more svg{width:18px;height:18px;transition:transform .2s}
.facts-more a:hover svg{transform:translateX(3px)}

/* Contact */
.contact{background:var(--surface);border:1px solid var(--line);border-radius:28px;padding:56px;display:grid;grid-template-columns:1.3fr auto;gap:32px;align-items:center;box-shadow:var(--shadow);position:relative;overflow:hidden}
.contact::before{content:"";position:absolute;right:-120px;top:-120px;width:360px;height:360px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--svc-ft) 14%,transparent),transparent);pointer-events:none}
.contact>div{min-width:0}
.contact h2{margin:0}
.contact p{color:var(--ink-2);margin:14px 0 0;max-width:56ch}
.contact .note{font-size:15px;color:var(--muted)}
@media (max-width:860px){.contact{grid-template-columns:1fr;padding:36px 28px}}
.btn-mail span{overflow-wrap:anywhere;min-width:0}
@media (max-width:400px){.contact{padding:32px 20px}.btn-mail{padding:0 16px;font-size:15px}}

/* Footer */
.ftr{border-top:1px solid var(--line);margin-top:88px;padding:56px 0 40px;color:var(--muted);font-size:15px}
.ftr-grid{display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:40px}
@media (max-width:760px){.ftr-grid{grid-template-columns:1fr 1fr}.ftr-brand{grid-column:1/-1}}
.ftr .ftr-h{color:var(--ink);font-size:14px;letter-spacing:0;font-weight:650;margin:0 0 14px}
.ftr ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.ftr a{text-decoration:none;color:var(--muted)}
.ftr a:hover{color:var(--ink)}
.ftr-brand p{margin:14px 0 0;max-width:36ch}
.ftr-base{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-top:1px solid var(--line);margin-top:44px;padding-top:24px;font-size:14px}
.ftr-base a{color:var(--muted)}

/* Text pages (privacy, 404) */
.page{padding:72px 0 24px}
.page .wrap{max-width:760px}
.page h1{overflow-wrap:break-word;hyphens:auto;font-size:clamp(28px,5vw,52px);letter-spacing:-.03em;line-height:1.08;font-weight:650;margin:12px 0 0}
.page h2{font-size:24px;letter-spacing:-.02em;margin:44px 0 0}
.page p,.page li{color:var(--ink-2)}
.page ul{padding-left:22px}
.page a{text-underline-offset:3px}
.page .updated{color:var(--muted);font-size:15px;margin-top:16px}
.nf-links{display:grid;gap:12px;margin-top:32px}
.nf-links a{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--surface);text-decoration:none;font-weight:600}
.nf-links a:hover{border-color:var(--line-2)}
.nf-links svg{width:32px;height:32px;border-radius:8px}

/* Partner teaser (front page) */
.teaser{display:flex;align-items:center;justify-content:space-between;gap:32px;flex-wrap:wrap;padding:40px 44px;border-radius:28px;text-decoration:none;color:inherit;background:linear-gradient(120deg,var(--svc-rfb-tint),var(--svc-oa-tint) 55%,var(--svc-ft-tint));border:1px solid var(--line);transition:transform .2s,box-shadow .2s}
.teaser:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
.teaser h2{margin-top:8px}
.teaser p:not(.kicker){color:var(--ink-2);max-width:62ch;margin:12px 0 0}
.teaser .go{font-weight:600;white-space:nowrap}
.teaser:hover .go svg{transform:translateX(4px)}
@media (max-width:560px){.teaser{padding:28px 22px}}
.founder{display:flex;flex-direction:column;gap:2px;margin-top:28px;padding-left:16px;border-left:3px solid var(--line-2)}
.founder strong{font-weight:650}
.founder span{color:var(--muted);font-size:15px}
.founder a{color:inherit}

/* Partner page */
.hero-sub{padding:72px 0 40px}
.hero-sub h1{font-size:clamp(34px,4.6vw,56px);max-width:20ch}
.offers{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media (max-width:980px){.offers{grid-template-columns:1fr}}
.offer{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:28px;box-shadow:var(--shadow)}
.offer-n{font-size:13px;font-weight:650;letter-spacing:.12em;color:var(--muted)}
.offer h3{font-size:21px;letter-spacing:-.01em;font-weight:650;margin:14px 0 0}
.offer p{color:var(--ink-2);margin:8px 0 0;font-size:16px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-top:44px}
@media (max-width:1080px){.metrics{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){.metrics{grid-template-columns:1fr}}
.metric{display:flex;flex-direction:column;gap:6px;padding:24px;border:1px solid var(--band-line);border-radius:var(--radius);background:rgba(255,255,255,.03)}
.metric strong{font-size:34px;letter-spacing:-.03em;font-weight:650;color:#fff;font-variant-numeric:tabular-nums}
.metric .m-label{color:var(--band-ink);font-weight:550}
.metric .m-def{color:var(--band-muted);font-size:14px;line-height:1.5}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;counter-reset:none}
@media (max-width:980px){.steps{grid-template-columns:1fr}}
.steps li{display:flex;gap:16px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px}
.step-n{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--brand);color:var(--on-brand);font-weight:650}
.steps h3{margin:4px 0 0;font-size:19px;font-weight:650}
.steps p{margin:6px 0 0;color:var(--ink-2);font-size:16px}
.invest{border:1px solid var(--line);border-radius:28px;padding:44px;background:var(--bg-2)}
.invest h2{margin-top:8px}
.invest p:not(.kicker){color:var(--ink-2);max-width:66ch;margin:14px 0 0}
.inline-cta{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--ink);text-decoration:none}
.inline-cta svg{width:18px;height:18px;transition:transform .2s}
.inline-cta:hover svg{transform:translateX(3px)}
.invest .disclaimer{font-size:14px;color:var(--muted);margin-top:24px}
@media (max-width:560px){.invest{padding:28px 22px}}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (max-width:560px){.wrap{padding:0 20px}.hero{padding:56px 0 48px}section{padding:64px 0}.band{margin:0 8px;border-radius:24px;padding:64px 0}.card{padding:24px}}
`;

const ARROW = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M4 10h11m0 0-4.5-4.5M15 10l-4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MAIL = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><rect x="2.5" y="4.5" width="15" height="11" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="m3.5 6 6.5 5 6.5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PILLAR_ICONS = [
  // shield-check
  `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 3 5 6v5.5c0 4.3 3 8.2 7 9.5 4-1.3 7-5.2 7-9.5V6l-7-3Z" stroke="#9fd36a" stroke-width="1.8" stroke-linejoin="round"/><path d="m9 12 2.2 2.2L15.5 10" stroke="#9fd36a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // nodes
  `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="6" cy="7" r="2.5" stroke="#ff9b82" stroke-width="1.8"/><circle cx="18" cy="7" r="2.5" stroke="#ff9b82" stroke-width="1.8"/><circle cx="12" cy="18" r="2.5" stroke="#ff9b82" stroke-width="1.8"/><path d="M8.3 8.3 10.7 15.8M15.7 8.3l-2.4 7.5M8.5 7h7" stroke="#ff9b82" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  // balance / open
  `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 4v16M7 20h10M5 8h14" stroke="#5eead4" stroke-width="1.8" stroke-linecap="round"/><path d="m5 8-2.5 6a2.5 2.5 0 0 0 5 0L5 8Zm14 0-2.5 6a2.5 2.5 0 0 0 5 0L19 8Z" stroke="#5eead4" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
];

// ─── Page shell ─────────────────────────────────────────────────────────────
interface ShellOpts {
  lang: Lang;
  title: string;
  description: string;
  canonicalPath: string;
  alternates: Record<Lang, string>;
  body: string;
  jsonLd?: object;
  solidHeader?: boolean;
  noindex?: boolean;
}

function header(lang: Lang, solid: boolean): string {
  const t = T[lang];
  const home = t.homeHref;
  const anchor = (id: string) => (home === "/" ? `/#${id}` : `${home}#${id}`);
  return `<header class="hdr${solid ? " is-solid" : ""}"><div class="wrap hdr-in">
<a class="brand" href="${home}" aria-label="Agentplatform.no – ${lang === "en" ? "front page" : "forsiden"}">${AGENTPLATFORM_MARK}<span>agentplatform<span>.no</span></span></a>
<nav class="nav" aria-label="${lang === "en" ? "Main" : "Hovedmeny"}">
<a class="opt" href="${anchor("tjenester")}">${t.navServices}</a>
<a class="opt" href="${anchor("plattformen")}">${t.navPlatform}</a>
<a class="opt" href="${anchor("om")}">${t.navAbout}</a>
<a class="opt" href="${t.partnersHref}">${t.navPartners}</a>
<a class="opt" href="${t.contactHref}">${t.navContact}</a>
<a class="lang" href="${t.langSwitchHref}" hreflang="${t.langSwitchHreflang}" lang="${t.langSwitchHreflang}"><span aria-hidden="true">${t.langSwitchShort}</span><span class="sr">${t.langSwitch}</span></a>
</nav></div></header>`;
}

function footer(lang: Lang): string {
  const t = T[lang];
  const year = Math.max(2026, new Date().getFullYear());
  const home = t.homeHref;
  const anchor = (id: string) => (home === "/" ? `/#${id}` : `${home}#${id}`);
  return `<footer class="ftr"><div class="wrap">
<div class="ftr-grid">
<div class="ftr-brand"><a class="brand" href="${home}">${AGENTPLATFORM_MARK}<span>agentplatform<span>.no</span></span></a><p>${t.footerTagline}</p></div>
<div><h2 class="ftr-h">${t.footerServices}</h2><ul>${SERVICES.map((s) => `<li><a href="${esc(serviceUrl(s, lang))}">${esc(s.name)}</a></li>`).join("")}</ul></div>
<div><h2 class="ftr-h">${t.footerCompany}</h2><ul><li><a href="${anchor("om")}">${t.navAbout}</a></li><li><a href="${t.partnersHref}">${t.navPartners}</a></li><li><a href="${t.contactHref}">${t.navContact}</a></li><li><a href="${t.privacyHref}">${t.footerPrivacy}</a></li><li><a href="${t.langSwitchHref}" hreflang="${t.langSwitchHreflang}" lang="${t.langSwitchHreflang}">${t.langSwitch}</a></li></ul></div>
</div>
<div class="ftr-base"><span>© ${year} <a href="${t.contactHref}">${COMPANY.legalName} · ${lang === "en" ? "Org. no." : "Org.nr."} ${COMPANY.orgNrDisplay}</a></span><span>${t.footerRegistered}</span></div>
</div></footer>`;
}

function shell(o: ShellOpts): string {
  const t = T[o.lang];
  const canonical = AGENTPLATFORM_BASE_URL + o.canonicalPath;
  const ld = o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
${o.noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${canonical}">`}
<link rel="alternate" hreflang="nb" href="${AGENTPLATFORM_BASE_URL}${o.alternates.nb}">
<link rel="alternate" hreflang="en" href="${AGENTPLATFORM_BASE_URL}${o.alternates.en}">
<link rel="alternate" hreflang="x-default" href="${AGENTPLATFORM_BASE_URL}${o.alternates.nb}">
<meta name="theme-color" content="#f8f7f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0f16" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Agentplatform.no">
<meta property="og:locale" content="${t.ogLocale}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${AGENTPLATFORM_BASE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Agentplatform.no – Rett fra Bonden, Opplevagent, Finn-tannlege">
<meta name="twitter:card" content="summary_large_image">
<style>${CSS}</style>
${ld}
</head>
<body>
<a class="skip" href="#innhold">${t.skip}</a>
${header(o.lang, !!o.solidHeader)}
<main id="innhold">
${o.body}
</main>
${footer(o.lang)}
</body>
</html>`;
}

// ─── Front page ─────────────────────────────────────────────────────────────
function organizationJsonLd(lang: Lang): object {
  const t = T[lang];
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${AGENTPLATFORM_BASE_URL}/#organization`,
    name: COMPANY.displayName,
    legalName: COMPANY.legalName,
    url: AGENTPLATFORM_BASE_URL,
    logo: `${AGENTPLATFORM_BASE_URL}/favicon-512.png`,
    image: `${AGENTPLATFORM_BASE_URL}/og.png`,
    description: t.description,
    foundingDate: COMPANY.foundedDate,
    email: COMPANY.email,
    identifier: { "@type": "PropertyValue", propertyID: "Organisasjonsnummer", value: COMPANY.orgNr },
    address: {
      "@type": "PostalAddress",
      addressLocality: COMPANY.address.city,
      addressCountry: COMPANY.address.countryCode,
    },
    sameAs: [COMPANY.brregUrl],
    founder: {
      "@type": "Person",
      name: COMPANY.founder.name,
      jobTitle: COMPANY.founder.role[lang],
      ...(COMPANY.founder.linkedin ? { sameAs: [COMPANY.founder.linkedin] } : {}),
    },
    brand: SERVICES.map((s) => ({ "@type": "Brand", name: s.name, url: `https://${s.domain}` })),
  };
}

export function renderHome(lang: Lang, counts: ServiceCounts): string {
  const t = T[lang];
  const allKnown = SERVICES.every((s) => counts[s.vertical] != null);
  const total = SERVICES.reduce((sum, s) => sum + (counts[s.vertical] ?? 0), 0);

  const heroFacts = [
    allKnown && total > 0 ? t.heroFactsOver(formatCount(floorForClaim(total))) : null,
    t.heroFactsServices,
    t.heroFactsOrg,
  ].filter(Boolean);

  const cards = SERVICES.map((s) => {
    const n = counts[s.vertical];
    const href = serviceUrl(s, lang);
    return `<a class="card svc-${s.key}" href="${esc(href)}">
<div class="card-top"><span class="card-mark">${s.mark("card")}</span><span class="chip">${esc(s.category[lang])}</span></div>
<h3>${esc(s.name)}</h3>
<span class="dom">${esc(s.domain)}</span>
<p>${esc(s.description[lang])}</p>
<div class="stat">${n != null ? `<div class="stat-in"><strong>${formatCount(n)}</strong><span>${esc(s.countLabel[lang])}</span></div>` : `<div class="stat-in"></div>`}</div>
<div class="card-foot"><span class="go">${esc(t.visit(s.name))}${ARROW}</span></div>
</a>`;
  }).join("\n");

  const pillars = t.pillars
    .map((p, i) => `<div class="pillar"><div class="pillar-ic">${PILLAR_ICONS[i]}</div><h3>${esc(p.title)}</h3><p>${esc(p.body)}</p></div>`)
    .join("");

  const devRows = SERVICES.map((s) => {
    const base = `https://${s.domain}`;
    return `<tr>
<td><span class="dev-svc">${s.mark("dev")}${esc(s.name)}</span></td>
<td data-l="${t.devColMcp}"><code>${base}/mcp</code></td>
<td data-l="${t.devColCard}"><a href="${base}/.well-known/agent-card.json">agent-card.json</a></td>
<td data-l="${t.devColDocs}"><a href="${base}/llms.txt">llms.txt</a></td>
</tr>`;
  }).join("");

  // Decorative (aria-hidden): the hub and the three services it connects. The
  // same facts are in the cards below, so nothing is lost to assistive tech.
  const NODE_POS = [
    { x: 25, y: 15 },
    { x: 77, y: 45 },
    { x: 30, y: 84 },
  ];
  const heroArt = `<div class="hero-art" aria-hidden="true">
<svg class="hero-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
<circle class="orbit" cx="50" cy="50" r="31"/><circle class="orbit orbit-2" cx="50" cy="50" r="47"/>
${NODE_POS.map((n, i) => `<path class="flow flow-${i + 1}" d="M50 50 L${n.x} ${n.y}"/>`).join("")}
</svg>
<div class="hub">${AGENTPLATFORM_MARK}</div>
${SERVICES.map((s, i) => {
  const n = counts[s.vertical];
  const sub = n != null ? `${formatCount(n)} ${s.shortLabel[lang]}` : s.category[lang];
  return `<a class="node svc-${s.key}" href="${esc(serviceUrl(s, lang))}" tabindex="-1" style="left:${NODE_POS[i].x}%;top:${NODE_POS[i].y}%">${s.mark("hero")}<span><b>${esc(s.name)}</b><small>${esc(sub)}</small></span></a>`;
}).join("")}
</div>`;

  const body = `
<section class="hero"><div class="wrap hero-grid"><div class="hero-copy">
<span class="eyebrow"><i aria-hidden="true"><b></b><b></b><b></b></i>${t.heroEyebrow}</span>
<h1>${escKeep(t.heroTitle)}</h1>
<p class="lead">${esc(t.heroLead)}</p>
<div class="ctas"><a class="btn btn-primary" href="#tjenester">${t.heroCtaPrimary}${ARROW}</a><a class="btn btn-ghost" href="#om">${t.heroCtaSecondary}</a></div>
<nav class="quick" aria-label="${t.quickLabel}">${SERVICES.map((s) => `<a class="svc-${s.key}" href="${esc(serviceUrl(s, lang))}">${s.mark("quick")}<span>${esc(s.name)}</span></a>`).join("")}</nav>
<ul class="facts">${heroFacts.map((f) => `<li>${esc(String(f))}</li>`).join("")}</ul>
</div>${heroArt}</div></section>

<section class="services" id="tjenester" aria-labelledby="tjenester-h"><div class="wrap">
<div class="sec-head"><p class="kicker">${t.servicesKicker}</p><h2 id="tjenester-h">${t.servicesTitle}</h2><p class="sec-lead">${t.servicesLead}</p></div>
<div class="cards">
${cards}
</div>
</div></section>

<section class="band" id="plattformen" aria-labelledby="plattformen-h"><div class="wrap">
<p class="kicker">${t.platformKicker}</p><h2 id="plattformen-h">${t.platformTitle}</h2><p class="sec-lead">${t.platformLead}</p>
<div class="pillars">${pillars}</div>
</div></section>

<section id="utviklere" aria-labelledby="utviklere-h"><div class="wrap">
<div class="sec-head"><p class="kicker">${t.devKicker}</p><h2 id="utviklere-h">${t.devTitle}</h2><p class="sec-lead">${t.devLead}</p></div>
<table class="dev-table">
<thead><tr><th scope="col">${t.devColService}</th><th scope="col">${t.devColMcp}</th><th scope="col">${t.devColCard}</th><th scope="col">${t.devColDocs}</th></tr></thead>
<tbody>${devRows}</tbody>
</table>
</div></section>

<section id="samarbeid" aria-labelledby="samarbeid-h" style="padding-top:0"><div class="wrap">
<a class="teaser" href="${t.partnersHref}">
<div><p class="kicker">${t.teaserKicker}</p><h2 id="samarbeid-h">${t.teaserTitle}</h2><p>${esc(t.teaserBody)}</p></div>
<span class="go">${t.teaserCta}${ARROW}</span>
</a>
</div></section>

<section id="om" aria-labelledby="om-h"><div class="wrap about">
<div><p class="kicker">${t.aboutKicker}</p><h2 id="om-h">${t.aboutTitle}</h2>${t.aboutBody.map((p) => `<p>${esc(p)}</p>`).join("")}
${founderBlock(lang)}</div>
<div class="facts-card"><h3 class="facts-h">${t.factsTitle}</h3><dl>
<div><dt>${t.factName}</dt><dd>${COMPANY.legalName}</dd></div>
<div><dt>${t.factOrg}</dt><dd><a href="${COMPANY.brregUrl}" title="${esc(t.factOrgLinkTitle)}">${COMPANY.orgNrDisplay}</a></dd></div>
<div><dt>${t.factFounded}</dt><dd>${t.factFoundedValue}</dd></div>
<div><dt>${t.founderLabel}</dt><dd>${esc(COMPANY.founder.name)}</dd></div>
<div><dt>${t.factRegister}</dt><dd>${t.factRegisterValue}</dd></div>
<div><dt>${t.factEmail}</dt><dd><a href="mailto:${COMPANY.email}">${COMPANY.email}</a></dd></div>
</dl><p class="facts-more"><a href="${t.contactHref}">${t.factsMore}${ARROW}</a></p></div>
</div></section>

<section id="kontakt" aria-labelledby="kontakt-h" style="padding-top:0"><div class="wrap">
<div class="contact">
<div><h2 id="kontakt-h">${t.contactTitle}</h2><p>${esc(t.contactBody)}</p><p class="note">${esc(t.contactNote)}</p></div>
<div><a class="btn btn-primary btn-mail" href="mailto:${COMPANY.email}">${MAIL}<span>${COMPANY.email}</span></a></div>
</div>
</div></section>`;

  return shell({
    lang,
    title: t.title,
    description: t.description,
    canonicalPath: lang === "en" ? "/en" : "/",
    alternates: { nb: "/", en: "/en" },
    body,
    jsonLd: organizationJsonLd(lang),
  });
}

function founderBlock(lang: Lang): string {
  const t = T[lang];
  const f = COMPANY.founder;
  const li = f.linkedin
    ? ` · <a href="${esc(f.linkedin)}" rel="me noopener">${t.founderLinkedIn}</a>`
    : "";
  return `<p class="founder"><strong>${esc(f.name)}</strong><span>${esc(f.role[lang])}${li}</span></p>`;
}

function mailtoHref(subject: string): string {
  return `mailto:${COMPANY.email}?subject=${encodeURIComponent(subject)}`;
}

// ─── Partners (+ a short section for investors) ─────────────────────────────
// A2A dev-request 2026-10-09-agentplatform-partnerside. Deliberately NOT on the
// page: prices, valuation, funding applications, names of prospective partners,
// and how the platform is operated. No offer of shares (see pDisclaimer).
export function renderPartners(lang: Lang, metrics: PlatformMetrics): string {
  const t = T[lang];
  const tiles: string[] = [];
  const tile = (value: string, label: string, def: string) =>
    `<div class="metric"><strong>${value}</strong><span class="m-label">${esc(label)}</span><span class="m-def">${esc(def)}</span></div>`;
  if (metrics.catalogTotal != null) tiles.push(tile(formatCount(metrics.catalogTotal), t.mCatalogLabel, t.mCatalogDef));
  if (metrics.humanVisits != null && metrics.trafficWindowDays != null)
    tiles.push(tile(`${formatCount(floorForTile(metrics.humanVisits))}+`, t.mHumanLabel(metrics.trafficWindowDays), t.mHumanDef));
  if (metrics.aiCrawlerViews != null && metrics.trafficWindowDays != null)
    tiles.push(tile(`${formatCount(floorForTile(metrics.aiCrawlerViews))}+`, t.mCrawlerLabel(metrics.trafficWindowDays), t.mCrawlerDef));
  if (metrics.agentToolCalls != null && metrics.agentWindowDays != null)
    tiles.push(tile(`${formatCount(floorForTile(metrics.agentToolCalls))}+`, t.mAgentLabel(metrics.agentWindowDays), t.mAgentDef));

  const offers = t.pOffers
    .map((o, i) => `<div class="offer"><span class="offer-n">0${i + 1}</span><h3>${esc(o.title)}</h3><p>${esc(o.body)}</p></div>`)
    .join("");
  const steps = t.pSteps
    .map((st, i) => `<li><span class="step-n">${i + 1}</span><div><h3>${esc(st.title)}</h3><p>${esc(st.body)}</p></div></li>`)
    .join("");

  const body = `
<section class="hero hero-sub"><div class="wrap">
<p class="kicker">${t.pKicker}</p>
<h1>${escKeep(t.pH1)}</h1>
<p class="lead">${esc(t.pLead)}</p>
<div class="ctas"><a class="btn btn-primary" href="${esc(mailtoHref(t.pMailSubject))}">${MAIL}${t.pCta}</a>${tiles.length ? `<a class="btn btn-ghost" href="#tall">${t.pCtaSecondary}</a>` : ""}</div>
</div></section>

<section aria-labelledby="tilbud-h" style="padding-top:24px"><div class="wrap">
<div class="sec-head"><p class="kicker">${t.pOfferKicker}</p><h2 id="tilbud-h">${t.pOfferTitle}</h2></div>
<div class="offers">${offers}</div>
</div></section>

${tiles.length ? `<section class="band" id="tall" aria-labelledby="tall-h"><div class="wrap">
<p class="kicker">${t.pMetricsKicker}</p><h2 id="tall-h">${t.pMetricsTitle}</h2><p class="sec-lead">${esc(t.pMetricsLead)}</p>
<div class="metrics">${tiles.join("")}</div>
</div></section>` : ""}

<section aria-labelledby="steg-h"><div class="wrap">
<div class="sec-head"><p class="kicker">${t.pStepsKicker}</p><h2 id="steg-h">${t.pStepsTitle}</h2></div>
<ol class="steps">${steps}</ol>
</div></section>

<section id="investorer" aria-labelledby="inv-h" style="padding-top:0"><div class="wrap">
<div class="invest">
<p class="kicker">${t.pInvKicker}</p>
<h2 id="inv-h">${t.pInvTitle}</h2>
<p>${esc(t.pInvBody)}</p>
<p><a class="inline-cta" href="${esc(mailtoHref(t.pInvMailSubject))}">${t.pInvCta}${ARROW}</a></p>
<p class="disclaimer">${esc(t.pDisclaimer)}</p>
</div>
</div></section>

<section aria-labelledby="pkontakt-h" style="padding-top:0"><div class="wrap">
<div class="contact">
<div><h2 id="pkontakt-h">${t.pContactTitle}</h2><p>${esc(t.pContactBody)}</p></div>
<div><a class="btn btn-primary btn-mail" href="${esc(mailtoHref(t.pMailSubject))}">${MAIL}<span>${COMPANY.email}</span></a></div>
</div>
</div></section>`;

  return shell({
    lang,
    title: t.pTitle,
    description: t.pDescription,
    canonicalPath: t.partnersHref,
    alternates: { nb: "/partnere", en: "/en/partners" },
    body,
  });
}

// ─── Privacy ────────────────────────────────────────────────────────────────
export function renderPrivacy(lang: Lang): string {
  const svcLinks = SERVICES.map((s) => `<li><a href="https://${s.domain}/personvern">${esc(s.name)}</a></li>`).join("");
  const nb = `
<div class="page"><div class="wrap">
<p class="kicker">Personvern</p>
<h1>Personvernerklæring for agentplatform.no</h1>
<p class="updated">Sist oppdatert 8. oktober 2026</p>
<h2>Kort fortalt</h2>
<p>Denne siden bruker ingen informasjonskapsler (cookies), ingen analyseverktøy og ikke noe innhold fra tredjeparter. Vi lagrer ikke besøksstatistikk for agentplatform.no.</p>
<h2>Behandlingsansvarlig</h2>
<p>${COMPANY.legalName}, org.nr. ${COMPANY.orgNrDisplay}, ${ADDRESS_LINE}. E-post: <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>.</p>
<h2>Hva som behandles når du besøker siden</h2>
<p>For å levere siden behandler serveren og hostingleverandøren vår (Fly.io, datasenter i Stockholm) tekniske opplysninger som IP-adresse og nettlesertype. Dette er nødvendig for å vise siden og beskytte tjenesten mot misbruk (berettiget interesse, GDPR art. 6 nr. 1 f). Opplysningene brukes ikke til å identifisere deg eller lage profiler.</p>
<p>Når du klikker deg videre til en av tjenestene våre, inneholder lenken en merking (utm_source=agentplatform.no) slik at tjenesten kan telle hvor mange som kommer herfra. Merkingen inneholder ingen opplysninger om deg.</p>
<h2>Når du sender oss e-post</h2>
<p>Hvis du kontakter oss, bruker vi navnet ditt, e-postadressen og innholdet i henvendelsen til å svare deg (GDPR art. 6 nr. 1 b og f). Vi sletter henvendelsen når den ikke lenger trengs for å følge opp saken.</p>
<h2>Tjenestene våre</h2>
<p>Rett fra Bonden, Opplevagent og Finn-tannlege har egne personvernerklæringer som gjelder når du bruker dem:</p>
<ul>${svcLinks}</ul>
<h2>Dine rettigheter</h2>
<p>Du kan be om innsyn i, retting av eller sletting av opplysninger om deg, og du kan protestere mot behandlingen. Send en e-post til <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>. Du kan også klage til <a href="https://www.datatilsynet.no/">Datatilsynet</a>.</p>
</div></div>`;
  const en = `
<div class="page"><div class="wrap">
<p class="kicker">Privacy</p>
<h1>Privacy notice for agentplatform.no</h1>
<p class="updated">Last updated 8 October 2026</p>
<h2>In short</h2>
<p>This site uses no cookies, no analytics tools and no third-party content. We do not store visitor statistics for agentplatform.no.</p>
<h2>Controller</h2>
<p>${COMPANY.legalName}, org. no. ${COMPANY.orgNrDisplay}, ${ADDRESS_LINE}, Norway. Email: <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>.</p>
<h2>What is processed when you visit</h2>
<p>To deliver the site, our server and hosting provider (Fly.io, data centre in Stockholm) process technical data such as your IP address and browser type. This is necessary to show the page and protect the service against abuse (legitimate interest, GDPR Art. 6(1)(f)). The data is not used to identify you or build profiles.</p>
<p>When you follow a link to one of our services, the link carries a tag (utm_source=agentplatform.no) so that service can count how many visitors come from here. The tag contains no information about you.</p>
<h2>When you email us</h2>
<p>If you contact us, we use your name, email address and message to reply (GDPR Art. 6(1)(b) and (f)). We delete the message once it is no longer needed to follow up.</p>
<h2>Our services</h2>
<p>Rett fra Bonden, Opplevagent and Finn-tannlege have their own privacy notices, which apply when you use them:</p>
<ul>${svcLinks}</ul>
<h2>Your rights</h2>
<p>You can ask for access to, correction of or deletion of your data, and you can object to the processing. Email <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>. You can also complain to the Norwegian Data Protection Authority (<a href="https://www.datatilsynet.no/en/">Datatilsynet</a>).</p>
</div></div>`;
  return shell({
    lang,
    title: lang === "en" ? "Privacy – Agentplatform.no AS" : "Personvern – Agentplatform.no AS",
    description:
      lang === "en"
        ? "How Agentplatform.no AS handles personal data on agentplatform.no: no cookies, no analytics, no third-party content."
        : "Slik behandler Agentplatform.no AS personopplysninger på agentplatform.no: ingen informasjonskapsler, ingen analyse og ikke noe innhold fra tredjeparter.",
    canonicalPath: lang === "en" ? "/en/privacy" : "/personvern",
    alternates: { nb: "/personvern", en: "/en/privacy" },
    body: lang === "en" ? en : nb,
    solidHeader: true,
  });
}

// ─── Contact (ehandelsloven § 8) ────────────────────────────────────────────
export function renderContact(lang: Lang): string {
  const t = T[lang];
  const svcLinks = SERVICES.map(
    (s) => `<a href="https://${s.domain}/kontakt">${s.mark("contact")}<span>${esc(s.name)}</span></a>`,
  ).join("");
  const body = `<div class="page"><div class="wrap">
<p class="kicker">${t.navContact}</p>
<h1>${t.contactPageTitle}</h1>
<p>${t.contactPageLead}</p>
<div class="ctas"><a class="btn btn-primary btn-mail" href="mailto:${COMPANY.email}">${MAIL}<span>${COMPANY.email}</span></a></div>
<div class="facts-card" style="margin-top:40px"><h2 class="facts-h">${t.factsTitle}</h2><dl>
<div><dt>${t.factName}</dt><dd>${COMPANY.legalName}</dd></div>
<div><dt>${t.factOrg}</dt><dd><a href="${COMPANY.brregUrl}" title="${esc(t.factOrgLinkTitle)}">${COMPANY.orgNrDisplay}</a></dd></div>
<div><dt>${t.factRegister}</dt><dd>${t.factRegisterValue}</dd></div>
<div><dt>${t.factAddress}</dt><dd>${ADDRESS_LINE}${lang === "en" ? ", Norway" : ""}</dd></div>
<div><dt>${t.factEmail}</dt><dd><a href="mailto:${COMPANY.email}">${COMPANY.email}</a></dd></div>
</dl></div>
<h2>${t.contactPageServicesTitle}</h2>
<p>${t.contactPageServicesBody}</p>
<div class="nf-links">${svcLinks}</div>
</div></div>`;
  return shell({
    lang,
    title: `${t.contactPageTitle} – Agentplatform.no AS`,
    description:
      lang === "en"
        ? `Contact Agentplatform.no AS (org. no. ${COMPANY.orgNrDisplay}), the company behind Rett fra Bonden, Opplevagent and Finn-tannlege.`
        : `Kontakt Agentplatform.no AS (org.nr. ${COMPANY.orgNrDisplay}), selskapet bak Rett fra Bonden, Opplevagent og Finn-tannlege.`,
    canonicalPath: t.contactHref,
    alternates: { nb: "/kontakt", en: "/en/contact" },
    body,
    solidHeader: true,
  });
}

// ─── 404 ────────────────────────────────────────────────────────────────────
export function renderNotFound(lang: Lang): string {
  const t = T[lang];
  const links = SERVICES.map(
    (s) => `<a href="${esc(serviceUrl(s, lang))}">${s.mark("nf")}<span>${esc(s.name)}</span></a>`,
  ).join("");
  const body = `<div class="page"><div class="wrap">
<p class="kicker">404</p>
<h1>${t.notFoundTitle}</h1>
<p>${t.notFoundBody}</p>
<div class="ctas"><a class="btn btn-primary" href="${t.homeHref}">${t.notFoundCta}</a></div>
<div class="nf-links">${links}</div>
</div></div>`;
  return shell({
    lang,
    title: `${t.notFoundTitle} – Agentplatform.no`,
    description: t.description,
    canonicalPath: t.homeHref,
    alternates: { nb: "/", en: "/en" },
    body,
    solidHeader: true,
    noindex: true,
  });
}

// ─── Machine surfaces ───────────────────────────────────────────────────────
export function renderLlmsTxt(counts: ServiceCounts): string {
  const line = (s: Service) => {
    const n = counts[s.vertical];
    const base = `https://${s.domain}`;
    return `## ${s.name} (${s.domain})
${s.description.en}${n != null ? ` Catalog: ${n} ${s.countLabel.en}.` : ""}
- Website: ${base}/
- MCP (Streamable HTTP): ${base}/mcp
- A2A agent card: ${base}/.well-known/agent-card.json
- Full documentation for agents: ${base}/llms.txt`;
  };
  return `# Agentplatform.no AS

> Agentplatform.no AS (org. no. ${COMPANY.orgNrDisplay}, Oslo, Norway) is the company behind three independent Norwegian directories built for people and AI agents: Rett fra Bonden (local food producers), Opplevagent (experiences and activities) and Finn-tannlege (dental clinics). Each service has its own website, MCP server and A2A agent. This site only describes the company; to search, use the services below.

${SERVICES.map(line).join("\n\n")}

## Partnerships
- Platforms, organisations and industry players that represent local providers: ${AGENTPLATFORM_BASE_URL}/en/partners

## Company
- Legal name: ${COMPANY.legalName}
- Organisation number: ${COMPANY.orgNr} (${COMPANY.brregUrl})
- Contact: ${COMPANY.email}
- Privacy: ${AGENTPLATFORM_BASE_URL}/en/privacy
`;
}

const ROBOTS_TXT = `User-agent: *
Allow: /

Sitemap: ${AGENTPLATFORM_BASE_URL}/sitemap.xml
`;

function renderSitemap(): string {
  const pages: Array<{ nb: string; en: string }> = [
    { nb: "/", en: "/en" },
    { nb: "/partnere", en: "/en/partners" },
    { nb: "/kontakt", en: "/en/contact" },
    { nb: "/personvern", en: "/en/privacy" },
  ];
  const urls = pages
    .flatMap((p) =>
      (["nb", "en"] as const).map((l) => {
        const loc = AGENTPLATFORM_BASE_URL + p[l];
        return `  <url><loc>${loc}</loc><xhtml:link rel="alternate" hreflang="nb" href="${AGENTPLATFORM_BASE_URL}${p.nb}"/><xhtml:link rel="alternate" hreflang="en" href="${AGENTPLATFORM_BASE_URL}${p.en}"/></url>`;
      }),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

// ─── Router ─────────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "..", "public");

function servePublicFile(fileName: string, contentType: string, maxAge: number) {
  let cached: Buffer | null = null; // read once, then served from memory (< 250 KB in total)
  return (_req: Request, res: Response, next: NextFunction) => {
    let data: Buffer;
    try {
      data = cached ?? (cached = fs.readFileSync(path.join(PUBLIC_DIR, fileName)));
    } catch {
      return next(); // missing on disk → branded 404, never a crash
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
    res.send(data);
  };
}

function sendHtml(res: Response, status: number, html: string, lang: Lang, maxAge = 300): void {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Language", lang === "en" ? "en" : "nb");
  res.setHeader("Cache-Control", status === 200 ? `public, max-age=${maxAge}` : "no-store");
  res.send(html);
}

export function createAgentplatformRouter(overrides: Partial<AgentplatformDeps> = {}): Router {
  const deps: AgentplatformDeps = {
    readCount: overrides.readCount ?? safeHonestCatalogCount,
    readTraffic: overrides.readTraffic ?? defaultReadTraffic,
    readAgentCalls: overrides.readAgentCalls ?? defaultReadAgentCalls,
    now: overrides.now ?? Date.now,
  };
  const getCounts = makeCountCache(deps);
  const router = Router();

  router.get("/", (_req, res) => sendHtml(res, 200, renderHome("nb", getCounts()), "nb"));
  router.get("/en", (_req, res) => sendHtml(res, 200, renderHome("en", getCounts()), "en"));
  router.get("/partnere", (_req, res) => sendHtml(res, 200, renderPartners("nb", collectPlatformMetrics(deps, getCounts())), "nb"));
  router.get("/en/partners", (_req, res) => sendHtml(res, 200, renderPartners("en", collectPlatformMetrics(deps, getCounts())), "en"));
  router.get(["/partners", "/en/partnere", "/investorer", "/investors", "/en/investors"], (req, res) =>
    res.redirect(301, req.path === "/investorer" ? "/partnere#investorer" : req.path.includes("invest") ? "/en/partners#investorer" : "/en/partners"),
  );
  router.get("/kontakt", (_req, res) => sendHtml(res, 200, renderContact("nb"), "nb", 3600));
  router.get("/en/contact", (_req, res) => sendHtml(res, 200, renderContact("en"), "en", 3600));
  router.get(["/contact", "/en/kontakt"], (_req, res) => res.redirect(301, "/en/contact"));
  router.get("/personvern", (_req, res) => sendHtml(res, 200, renderPrivacy("nb"), "nb", 3600));
  router.get("/en/privacy", (_req, res) => sendHtml(res, 200, renderPrivacy("en"), "en", 3600));
  // Common spellings people and crawlers try.
  router.get(["/privacy", "/en/personvern"], (_req, res) => res.redirect(301, "/en/privacy"));

  router.get("/robots.txt", (_req, res) => {
    res.type("text/plain; charset=utf-8").setHeader("Cache-Control", "public, max-age=3600");
    res.send(ROBOTS_TXT);
  });
  router.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml; charset=utf-8").setHeader("Cache-Control", "public, max-age=3600");
    res.send(renderSitemap());
  });
  router.get("/llms.txt", (_req, res) => {
    res.type("text/plain; charset=utf-8").setHeader("Cache-Control", "public, max-age=600");
    res.send(renderLlmsTxt(getCounts()));
  });

  router.get("/favicon.svg", (_req, res) => {
    res.type("image/svg+xml").setHeader("Cache-Control", "public, max-age=86400");
    res.send(FAVICON_SVG);
  });
  router.get("/favicon.ico", servePublicFile("agentplatform-icon-192.png", "image/png", 86400));
  router.get("/favicon-192.png", servePublicFile("agentplatform-icon-192.png", "image/png", 86400));
  router.get("/favicon-512.png", servePublicFile("agentplatform-icon-512.png", "image/png", 86400));
  router.get("/apple-touch-icon.png", servePublicFile("agentplatform-apple-touch-icon.png", "image/png", 86400));
  router.get("/og.png", servePublicFile("agentplatform-og.png", "image/png", 86400));
  router.get(
    FONT_URL,
    servePublicFile("agentplatform-geist-latin-wght.woff2", "font/woff2", 31536000),
  );

  // Everything else on this host: branded 404 (English under /en, else Norwegian).
  router.use((req, res) => {
    const lang: Lang = req.path === "/en" || req.path.startsWith("/en/") ? "en" : "nb";
    sendHtml(res, 404, renderNotFound(lang), lang);
  });

  return router;
}

/**
 * Host gate for index.ts. Requests for any other host fall straight through.
 * www.agentplatform.no and agentplattform.no → https://agentplatform.no (301).
 */
export function createAgentplatformHostGate(router: Router = createAgentplatformRouter()): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Hostnames are case-insensitive and may carry the root's trailing dot.
    const host = (req.hostname || "").toLowerCase().replace(/\.$/, "");
    if (AGENTPLATFORM_REDIRECT_HOSTS.has(host)) {
      return res.redirect(301, `${AGENTPLATFORM_BASE_URL}${req.originalUrl}`);
    }
    if (!AGENTPLATFORM_HOSTS.has(host)) return next();
    return router(req, res, next);
  };
}
