/**
 * dental-seo.ts — SSR frontend for finn-tannlege.com
 *
 * PR-109: «Finn-tannlege» dental vertical
 * Host-gated via src/index.ts — only reached when req.hostname is
 * finn-tannlege.com or www.finn-tannlege.com.
 *
 * Design system: «Klinisk tillit»
 *   Primary teal  #0F766E (hover #115E59)
 *   Accent        #14B8A6
 *   Navy text     #0F2A43
 *   Section bg    #F1F5F9
 *   Helfo badge   #15803D / #DCFCE7
 *   Akutt badge   #B45309 / #FEF3C7
 *   Verified      teal
 */

import { Router, Request, Response } from "express";
import {
  listPublicDentalAgents,
  countPublicDentalAgents,
  getDentalStats,
  getAvailableSpecialties,
  getDentalAgentByOrgnr,
  getDentalAgentById,
  listPoststeder,
  listRelatedClinics,
  getDentalAgentsForSitemap,
} from "../services/dental-store";
import type { DentalAgent, PoststedRow } from "../services/dental-store";
import { getDentalAgentCard } from "../services/dental-agent-card";
import { getDentalOpenapi } from "../services/dental-openapi";
import { getTrafficStats } from "../services/traffic-stats";

const router = Router();

const DENTAL_BASE_URL =
  process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

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
const DENTAL_STATS_TTL_MS = 60_000;

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

// ─── Security: safeTelHref — build tel: href from phone field ────────────
// Strips everything except digits, +. Returns "" if result < 8 chars (no render).
function safeTelHref(telefon: string | null | undefined): string {
  if (!telefon) return "";
  const stripped = telefon.replace(/[^+\d]/g, "");
  return stripped.length >= 8 ? "tel:" + stripped : "";
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
 *  when not first word. */
export function titleCasePoststed(s: string): string {
  const SMALL = new Set(["i", "og", "på", "av", "ved", "for"]);
  return s.toLowerCase().split(" ").map((word, idx) => {
    if (idx > 0 && SMALL.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}

// ─── Poststed cache (60 s, same TTL as stats) ────────────────
let _poststedCache: { value: PoststedRow[]; expires: number } | null = null;

function getCachedPoststeder(): PoststedRow[] {
  const now = Date.now();
  if (_poststedCache && now < _poststedCache.expires) return _poststedCache.value;
  let value: PoststedRow[] = [];
  try { value = listPoststeder(1); } catch { /* db not ready */ }
  _poststedCache = { value, expires: now + DENTAL_STATS_TTL_MS };
  return value;
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

/* SPECIALTY CHIPS */
.spec-chip{display:inline-block;padding:7px 18px;border-radius:20px;background:var(--section-bg);border:1px solid var(--g200);color:var(--navy);font-size:.83rem;font-weight:500;text-decoration:none;transition:all .15s}
.spec-chip:hover{background:var(--teal-700);color:var(--white);border-color:var(--teal-700);text-decoration:none}

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
      <a href="/sok">Søk etter tannlege</a>
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
    &copy; ${new Date().getFullYear()} Finn-tannlege.com &mdash; AI-agenter: <a href="/llms.txt">llms.txt</a> &middot; API: <a href="/api/tannlege/agents">/api/tannlege</a>
  </div>
</footer>`;
}

// ─── Shell layout ─────────────────────────────────────────────

interface ShellOptions {
  title: string;
  description?: string;
  canonical?: string;
  jsonLd?: object | object[];
  ogImage?: string;
}

function dentalShell(content: string, opts: ShellOptions): string {
  const desc = opts.description || "Finn riktig tannlege i Norge. Søk etter klinikk, spesialitet, Helfo-avtale og tannlegevakt.";
  const canonical = opts.canonical || DENTAL_BASE_URL;
  const ldArr = opts.jsonLd
    ? (Array.isArray(opts.jsonLd) ? opts.jsonLd : [opts.jsonLd])
    : [];
  const ldScripts = ldArr
    .map((ld) => `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, "<\\/")}</script>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
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

// ─── Clinic card (used in /sok and /fylke) ───────────────────

function clinicCard(
  agent: DentalAgent & { id: string }
): string {
  const slug = slugifyClinic(agent.navn, agent.org_nr ?? undefined);
  const href = agent.org_nr
    ? `/klinikk/${escapeHtml(slug)}`
    : `/klinikk/id/${escapeHtml(agent.id)}`;

  const badges: string[] = [];
  if (agent.verification_status === "verified")
    badges.push(`<span class="badge badge-verified">Verifisert</span>`);
  if (agent.helfo_agreement === "true")
    badges.push(`<span class="badge badge-helfo">Helfo-avtale</span>`);
  if (agent.acute_vakt === 1)
    badges.push(`<span class="badge badge-akutt">Akuttvakt</span>`);
  if (agent.chain_brand)
    badges.push(`<span class="badge badge-chain">${escapeHtml(agent.chain_brand)}</span>`);

  const openStatus = agent.opening_hours && agent.opening_hours.length > 0
    ? (isOpenNow(agent.opening_hours)
        ? `<span class="badge badge-open">${ICON_CLOCK} Åpent nå</span>`
        : `<span class="badge badge-closed">${ICON_CLOCK} Stengt nå</span>`)
    : "";

  const specialties = (() => {
    if (!agent.available_specialties || agent.available_specialties.length === 0) return "";
    const links = agent.available_specialties.map((s) => {
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

// ─── Pagination helper ───────────────────────────────────────

function paginationHtml(
  currentPage: number,
  totalPages: number,
  baseUrl: string
): string {
  if (totalPages <= 1) return "";
  const pages: string[] = [];
  const sep = baseUrl.includes("?") ? "&" : "?";
  for (let i = 1; i <= Math.min(totalPages, 10); i++) {
    const active = i === currentPage ? " active" : "";
    pages.push(
      `<a href="${escapeHtml(baseUrl + sep + "side=" + i)}" class="page-btn${active}">${i}</a>`
    );
  }
  if (totalPages > 10) {
    pages.push(`<span class="page-btn" style="cursor:default">... ${totalPages}</span>`);
  }
  return `<nav class="pagination" aria-label="Sidebladering">${pages.join("")}</nav>`;
}

// ═══════════════════════════════════════════════════════════
// GET / — Forside
// ═══════════════════════════════════════════════════════════

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
      <a href="/sok?q=Oslo" class="chip" role="listitem">Oslo</a>
      <a href="/sok?q=Bergen" class="chip" role="listitem">Bergen</a>
      <a href="/sok?q=Trondheim" class="chip" role="listitem">Trondheim</a>
      <a href="/sok?q=Stavanger" class="chip" role="listitem">Stavanger</a>
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
      <div><div class="proof-val">${traffic.pageViews.toLocaleString("nb")}</div><div class="proof-lbl">Sidevisninger</div></div>
      <div><div class="proof-val">${traffic.uniqueVisitors.toLocaleString("nb")}</div><div class="proof-lbl">Unike besøkende</div></div>
      <div><div class="proof-val">${traffic.realHumans.toLocaleString("nb")}</div><div class="proof-lbl">Ekte mennesker</div></div>
      <div><div class="proof-val proof-val-muted">${traffic.botAndAi.toLocaleString("nb")}</div><div class="proof-lbl">Bot & AI-trafikk</div></div>
    </div>
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
    const topSteder = getCachedPoststeder().slice(0, 20);
    if (topSteder.length === 0) return "";
    const chips = topSteder.map((p) =>
      `<a href="/sted/${escapeHtml(slugifyText(p.poststed))}" class="spec-chip">${escapeHtml(titleCasePoststed(p.poststed))}</a>`
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
  const s = getTrafficStats("dental");
  res.json({
    pageViews: s.pageViews,
    uniqueVisitors: s.uniqueVisitors,
    realHumans: s.realHumans,
    botAndAi: s.botAndAi,
    aiQueries: s.aiQueries,
  });
});

router.get("/sok", (req: Request, res: Response) => {
  const PAGE_SIZE = 50;
  const q = String(req.query.q || "").trim();
  const fylke = String(req.query.fylke || "").trim();
  const spesialitet = String(req.query.spesialitet || "").trim();
  const helfo = req.query.helfo === "1";
  const akutt = req.query.akutt === "1";
  const kjede = String(req.query.kjede || "").trim();
  const sideRaw = parseInt(String(req.query.side || "1"), 10);
  const page = Number.isFinite(sideRaw) && sideRaw > 0 ? sideRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const filter: Record<string, unknown> = {};
  if (q) filter.q = q;
  if (fylke) filter.fylke = fylke;
  if (spesialitet) filter.specialty = spesialitet;
  if (helfo) filter.helfo_agreement = "true";
  if (akutt) filter.acute_vakt = 1;
  if (kjede) filter.chain_brand = kjede;

  let agents: Array<DentalAgent & { id: string }> = [];
  let total = 0;
  try {
    agents = listPublicDentalAgents(filter as any, PAGE_SIZE, offset);
    total = countPublicDentalAgents(filter as any);
  } catch { /* db not ready */ }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    <div class="clinic-list" role="list" aria-label="Søkeresultater">
      ${resultCards}
    </div>
    ${paginationHtml(page, totalPages, baseUrl)}
  </div>
</main>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dentalShell(html, {
    title: q ? `${escapeHtml(q)} — Tannlege søk` : "Søk etter tannlege — Finn-tannlege.com",
    description: `Søk blant ${total} tannlegeklinikker i Norge. Filtrer på Helfo-avtale, spesialitet og fylke.`,
    canonical: `${DENTAL_BASE_URL}/sok`,
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
  agent: DentalAgent & { id: string },
  req: Request,
  res: Response
): void {
  if (agent.verification_status === "rejected") {
    res.status(404).send(dentalShell(
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }

  const slug = slugifyClinic(agent.navn, agent.org_nr ?? undefined);
  const canonical = agent.org_nr
    ? `${DENTAL_BASE_URL}/klinikk/${slug}`
    : `${DENTAL_BASE_URL}/klinikk/id/${agent.id}`;

  // ── Header badges
  const badges: string[] = [];
  if (agent.verification_status === "verified")
    badges.push(`<span class="badge badge-verified">Verifisert</span>`);
  if (agent.helfo_agreement === "true")
    badges.push(`<span class="badge badge-helfo">Helfo-direkteoppgjør</span>`);
  if (agent.acute_vakt === 1)
    badges.push(`<span class="badge badge-akutt">Akuttvakt</span>`);
  if (agent.chain_brand)
    badges.push(`<span class="badge badge-chain">${escapeHtml(agent.chain_brand)}</span>`);

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
  if (agent.adresse) infoItems.push(`<div class="info-item"><div class="info-label">Adresse</div><div class="info-value">${escapeHtml(agent.adresse)}${agent.postnummer ? `, ${escapeHtml(agent.postnummer)}` : ""}${agent.poststed ? ` ${escapeHtml(agent.poststed)}` : ""}</div></div>`);
  { const h = safeTelHref(agent.telefon); if (h) infoItems.push(`<div class="info-item"><div class="info-label">Telefon</div><div class="info-value"><a href="${h}">${escapeHtml(agent.telefon)}</a></div></div>`); }
  { const h = safeTelHref(agent.mobil); if (h) infoItems.push(`<div class="info-item"><div class="info-label">Mobil</div><div class="info-value"><a href="${h}">${escapeHtml(agent.mobil)}</a></div></div>`); }
  if (agent.epost) infoItems.push(`<div class="info-item"><div class="info-label">E-post</div><div class="info-value"><a href="mailto:${escapeHtml(agent.epost)}">${escapeHtml(agent.epost)}</a></div></div>`);
  { const u = safeUrl(agent.hjemmeside); if (u) infoItems.push(`<div class="info-item"><div class="info-label">Hjemmeside</div><div class="info-value"><a href="${escapeHtml(u)}" rel="nofollow noopener" target="_blank">${escapeHtml(u.replace(/^https?:\/\//,""))}</a></div></div>`); }
  if (agent.org_nr) infoItems.push(`<div class="info-item"><div class="info-label">Organisasjonsnr.</div><div class="info-value">${escapeHtml(agent.org_nr)}</div></div>`);
  if (agent.registreringsdato) infoItems.push(`<div class="info-item"><div class="info-label">Registrert</div><div class="info-value">${escapeHtml(agent.registreringsdato)}</div></div>`);
  if (agent.antall_ansatte !== null && agent.antall_ansatte !== undefined) infoItems.push(`<div class="info-item"><div class="info-label">Antall ansatte</div><div class="info-value">${escapeHtml(String(agent.antall_ansatte))}</div></div>`);
  if (agent.chain_brand) infoItems.push(`<div class="info-item"><div class="info-label">Kjede</div><div class="info-value">${escapeHtml(agent.chain_brand)}</div></div>`);

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
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dentist",
    name: agent.navn,
    url: canonical,
    ...(agent.telefon ? { telephone: agent.telefon } : {}),
    ...(safeUrl(agent.hjemmeside) ? { sameAs: safeUrl(agent.hjemmeside) } : {}),
    address: {
      "@type": "PostalAddress",
      ...(agent.adresse ? { streetAddress: agent.adresse } : {}),
      ...(agent.postnummer ? { postalCode: agent.postnummer } : {}),
      ...(agent.poststed ? { addressLocality: agent.poststed } : {}),
      addressCountry: "NO",
    },
    ...(agent.lat && agent.lng
      ? { geo: { "@type": "GeoCoordinates", latitude: agent.lat, longitude: agent.lng } }
      : {}),
  };
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
  const fylkeLink = agent.fylke
    ? `<p style="margin-top:32px;font-size:.9rem"><a href="/fylke/${encodeURIComponent(agent.fylke)}">&larr; Flere tannleger i ${escapeHtml(agent.fylke)}</a></p>`
    : "";

  // ── PR-116: Related clinics (same poststed)
  let relatedSection = "";
  if (agent.poststed) {
    let related: Array<DentalAgent & { id: string }> = [];
    try { related = listRelatedClinics(agent, 6); } catch { /* db not ready */ }
    if (related.length > 0) {
      const stedSlug = slugifyText(agent.poststed);
      const titledSted = titleCasePoststed(agent.poststed);
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
  const profileBreadcrumbItems: BreadcrumbItem[] = [{ name: "Hjem", url: DENTAL_BASE_URL }];
  if (agent.fylke) profileBreadcrumbItems.push({ name: agent.fylke, url: `${DENTAL_BASE_URL}/fylke/${encodeURIComponent(agent.fylke)}` });
  if (agent.poststed) profileBreadcrumbItems.push({ name: titleCasePoststed(agent.poststed), url: `${DENTAL_BASE_URL}/sted/${slugifyText(agent.poststed)}` });
  profileBreadcrumbItems.push({ name: agent.navn, url: canonical });
  const jsonLdArr = [jsonLd, breadcrumbJsonLd(profileBreadcrumbItems)];

  // ── PR-116: unique meta description
  const metaDesc = [
    `${agent.navn} — tannlegeklinikk${agent.poststed ? ` i ${titleCasePoststed(agent.poststed)}` : ""}${agent.fylke ? `, ${agent.fylke}` : ""}.`,
    agent.helfo_agreement === "true" ? "Helfo-avtale." : "",
    agent.acute_vakt === 1 ? "Akuttvakt." : "",
    "Se åpningstider, behandlinger og kontaktinfo.",
  ].filter(Boolean).join(" ");

  const html = `
<main>
  <div class="profile-header" role="banner">
    <div class="container">
      <div class="clinic-badges" style="margin-bottom:12px">${badges.join("")}</div>
      <h1 class="profile-name">${escapeHtml(agent.navn)}</h1>
      <div class="profile-loc">${ICON_PIN} ${escapeHtml(agent.poststed || "")}${agent.fylke ? `, ${escapeHtml(agent.fylke)}` : ""}</div>
      <div class="profile-actions">${callBtn}${bookBtn}</div>
    </div>
  </div>
  <div class="container" style="padding-top:32px;padding-bottom:48px">
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
  res.send(dentalShell(html, {
    title: `${agent.navn} — Tannlegeklinikk${agent.poststed ? ` i ${titleCasePoststed(agent.poststed)}` : ""} | Finn-tannlege.com`,
    description: metaDesc,
    canonical,
    jsonLd: jsonLdArr,
  }));
}

router.get("/klinikk/id/:id", (req: Request, res: Response) => {
  const agent = getDentalAgentById(String(req.params.id));
  if (!agent) {
    res.status(404).send(dentalShell(
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }
  renderClinicProfile(agent, req, res);
});

router.get("/klinikk/:slug", (req: Request, res: Response) => {
  const parsed = parseClinicSlug(String(req.params.slug));
  if (!parsed) {
    res.status(404).send(dentalShell(
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }
  const agent = getDentalAgentByOrgnr(parsed.orgNr);
  if (!agent) {
    res.status(404).send(dentalShell(
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Klinikk ikke funnet</h3><p>Siden du leter etter finnes ikke.</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div>`,
      { title: "Ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }
  renderClinicProfile(agent, req, res);
});

// ═══════════════════════════════════════════════════════════
// GET /fylke/:fylke
// ═══════════════════════════════════════════════════════════

router.get("/fylke/:fylke", (req: Request, res: Response) => {
  const PAGE_SIZE = 50;
  const fylkeParam = String(req.params.fylke);

  let stats = { per_fylke: [] as Array<{ fylke: string; count: number }> };
  try { stats = getCachedDentalStats(); } catch { /* ok */ }

  // Case-insensitive match — canonical fylker only (PR-111)
  const matchedFylke = canonicalFylker(stats.per_fylke).find(
    (f) => f.fylke.toLowerCase() === fylkeParam.toLowerCase()
  );
  if (!matchedFylke) {
    res.status(404).send(dentalShell(
      `<div class="container"><div class="empty-state" style="padding:80px 0"><h3>Ukjent fylke</h3><p>Vi fant ikke «${escapeHtml(fylkeParam)}» i registeret.</p><a href="/#fylker" class="btn-secondary" style="margin-top:16px">Se alle fylker</a></div></div>`,
      { title: `${escapeHtml(fylkeParam)} — Fylke ikke funnet | Finn-tannlege.com` }
    ));
    return;
  }

  const sideRaw = parseInt(String(req.query.side || "1"), 10);
  const page = Number.isFinite(sideRaw) && sideRaw > 0 ? sideRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  let agents: Array<DentalAgent & { id: string }> = [];
  let total = 0;
  try {
    agents = listPublicDentalAgents({ fylke: matchedFylke.fylke }, PAGE_SIZE, offset);
    total = countPublicDentalAgents({ fylke: matchedFylke.fylke });
  } catch { /* ok */ }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const baseUrl = `/fylke/${encodeURIComponent(matchedFylke.fylke)}`;

  // JSON-LD ItemList (max 25)
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Tannleger i ${matchedFylke.fylke}`,
    url: `${DENTAL_BASE_URL}${baseUrl}`,
    numberOfItems: Math.min(total, 25),
    itemListElement: agents.slice(0, 25).map((a, i) => ({
      "@type": "ListItem",
      position: offset + i + 1,
      url: a.org_nr
        ? `${DENTAL_BASE_URL}/klinikk/${slugifyClinic(a.navn, a.org_nr)}`
        : `${DENTAL_BASE_URL}/klinikk/id/${a.id}`,
      name: a.navn,
    })),
  };

  // PR-116: Poststed chips for this fylke (≥2 clinics, max 30)
  const fylkePoststeder = getCachedPoststeder()
    .filter((p) => p.fylke && p.fylke.toLowerCase() === matchedFylke.fylke.toLowerCase() && p.count >= 2)
    .slice(0, 30);
  const poststedChips = fylkePoststeder.length > 0
    ? `<div style="margin-top:40px">
  <div class="section-title" style="font-size:1rem;margin-bottom:10px">Steder i ${escapeHtml(matchedFylke.fylke)}</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px">
    ${fylkePoststeder.map((p) => `<a href="/sted/${escapeHtml(slugifyText(p.poststed))}" class="spec-chip">${escapeHtml(titleCasePoststed(p.poststed))} <span style="font-size:.75em;opacity:.7">(${p.count})</span></a>`).join("")}
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
  res.send(dentalShell(html, {
    title: `Tannleger i ${escapeHtml(matchedFylke.fylke)} — Finn-tannlege.com`,
    description: `Oversikt over ${total} tannlegeklinikker i ${matchedFylke.fylke}. Finn klinikk med Helfo-avtale, spesialitet eller tannlegevakt.`,
    canonical: `${DENTAL_BASE_URL}${baseUrl}`,
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
    <p>Finn-tannlege.com er en uavhengig oversikt over tannlegeklinikker i Norge. Vi er ikke tilknyttet noen klinikkjede, forsikringsselskap eller bestillingsportal.</p>

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

router.get("/sitemap.xml", (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    let stats = { per_fylke: [] as Array<{ fylke: string; count: number }> };
    try { stats = getCachedDentalStats(); } catch { /* ok */ }

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    // Static pages
    const statics: Array<[string, string, string]> = [
      ["/", "daily", "1.0"],
      ["/sok", "daily", "0.9"],
      ["/hvordan-det-fungerer", "monthly", "0.7"],
      ["/om", "monthly", "0.6"],
      ["/personvern", "monthly", "0.4"],
    ];
    for (const [p, freq, pri] of statics) {
      xml += `\n  <url><loc>${DENTAL_BASE_URL}${p === "/" ? "" : p}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority><lastmod>${today}</lastmod></url>`;
    }

    // Specialty pages (PR-112)
    for (const sp of SPECIALTY_PAGES) {
      xml += `\n  <url><loc>${DENTAL_BASE_URL}/spesialitet/${sp.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${today}</lastmod></url>`;
    }

    // Fylke pages (canonical only — PR-111)
    for (const f of canonicalFylker(stats.per_fylke)) {
      xml += `\n  <url><loc>${DENTAL_BASE_URL}/fylke/${encodeURIComponent(f.fylke)}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${today}</lastmod></url>`;
    }

    // Sted pages (PR-116) — all poststeder with ≥1 clinic
    const sitemapSteder = getCachedPoststeder();
    for (const p of sitemapSteder) {
      xml += `\n  <url><loc>${DENTAL_BASE_URL}/sted/${slugifyText(p.poststed)}</loc><changefreq>weekly</changefreq><priority>0.75</priority><lastmod>${today}</lastmod></url>`;
    }

    // Clinic pages — getDentalAgentsForSitemap for lastmod support (PR-116)
    let clinicRows: Array<{ org_nr: string; navn: string; updated_at: string | null }> = [];
    try { clinicRows = getDentalAgentsForSitemap(); } catch { /* fallback to batch */ }

    if (clinicRows.length > 0) {
      for (const a of clinicRows) {
        const slug = slugifyClinic(a.navn, a.org_nr);
        const lastmod = a.updated_at ? (a.updated_at.split("T")[0] || a.updated_at) : today;
        xml += `\n  <url><loc>${DENTAL_BASE_URL}/klinikk/${slug}</loc><changefreq>monthly</changefreq><priority>0.7</priority><lastmod>${escapeHtml(lastmod)}</lastmod></url>`;
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
          xml += `\n  <url><loc>${DENTAL_BASE_URL}/klinikk/${slug}</loc><changefreq>monthly</changefreq><priority>0.7</priority><lastmod>${today}</lastmod></url>`;
        }
        batchOffset += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    xml += "\n</urlset>";
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    console.error("[dental-sitemap] error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// ═══════════════════════════════════════════════════════════
// GET /robots.txt
// ═══════════════════════════════════════════════════════════

router.get("/robots.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# finn-tannlege.com — robots.txt
# Uavhengig oversikt over tannlegeklinikker i Norge.
# AI-agenter er velkomne til å indeksere og sitere data fra denne tjenesten.

User-agent: *
Allow: /

# LLM-vennlige endepunkter
# Oversikt:      ${DENTAL_BASE_URL}/llms.txt
# API:           ${DENTAL_BASE_URL}/api/tannlege/agents

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: ${DENTAL_BASE_URL}/sitemap.xml
`);
});

// ═══════════════════════════════════════════════════════════
// GET /llms.txt
// ═══════════════════════════════════════════════════════════

router.get("/llms.txt", (_req: Request, res: Response) => {
  let stats = { total: 0 };
  try { stats = getCachedDentalStats(); } catch { /* ok */ }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`# finn-tannlege.com — LLM-oversikt

## Hva er dette?

Finn-tannlege.com er en uavhengig søketjeneste for tannlegeklinikker i Norge.
Databasen inneholder omtrent ${stats.total.toLocaleString("nb")} klinikker hentet fra
Brønnøysundregistrene, HPR og klinikkenes egne nettsider.

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

## MCP (Model Context Protocol)

HTTP Streamable MCP:  ${DENTAL_BASE_URL}/mcp
npm-pakke (stdio):    npx finn-tannlege-mcp

Tilgjengelige MCP-tools:
- tannlege_search   — søk klinikker (fritekst, fylke, spesialitet, Helfo, akutt)
- tannlege_info     — full klinikkprofil via org_nr eller id
- tannlege_stats    — aggregerte markedsstatistikker
- tannlege_akutt    — finn akuttvakt-klinikker
- tannlege_kjeder   — list alle tannlegekjeder med antall lokasjoner

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
  const updatedDate = "2026-06-04";
  const html = `
<main>
  <div class="content-page">
    <h1>Personvernerklæring</h1>
    <p style="font-size:.85rem;color:var(--g500)">Sist oppdatert: ${updatedDate}</p>

    <h2>Behandlingsansvarlig</h2>
    <p>Finn-tannlege.com er behandlingsansvarlig for personopplysninger behandlet på denne tjenesten. Kontakt oss på <a href="mailto:kontakt@finn-tannlege.com">kontakt@finn-tannlege.com</a>.</p>

    <h2>Hvilke data behandler vi?</h2>
    <p>Vi behandler <strong>utelukkende offentlig tilgjengelige virksomhetsdata</strong>:</p>
    <ul>
      <li><strong>Brønnøysundregistrene (Brreg)</strong> &mdash; foretaksnavn, organisasjonsnummer, adresse, kontaktinformasjon og næringsgruppekode for registrerte tannlegeklinikker</li>
      <li><strong>Offentlige helseregistre (HPR)</strong> &mdash; autorisasjon og spesialisttittel for helsepersonell i yrkesutøvelse (offentlig informasjon etter helsepersonelloven)</li>
      <li><strong>Klinikkenes egne offentlige nettsider</strong> &mdash; åpningstider, behandlingstilbud og presentasjonstekst</li>
    </ul>
    <p>Vi behandler <strong>ingen pasientdata</strong>, <strong>ingen helseopplysninger om enkeltpersoner</strong> og ingen sensitiv personinformasjon utover det som er offentlig tilgjengelig i kapasitet som yrkesutøver.</p>

    <h2>Navngitte personer</h2>
    <p>Tannleger og annet helsepersonell kan fremgå av profilene med navn og tittel/spesialitet. Dette er offentlig tilgjengelig informasjon knyttet til yrkesutøvelse og autorisasjon &mdash; ikke privat informasjon. Grunnlaget er at offentligheten har rett og behov for å kjenne til autorisert helsepersonells spesialkompetanse.</p>

    <h2>Behandlingsgrunnlag</h2>
    <p>Behandlingen er basert på <strong>berettiget interesse</strong>, jf. GDPR artikkel 6 (1) bokstav f. Det er et legitimt behov for at befolkningen enkelt kan finne og sammenligne tannlegeklinikker og verifisere helsepersonells autorisasjon. Behandlingen er begrenset til offentlig tilgjengelige data og medfører lav personvernrisiko.</p>

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
    <p>Vi bruker <strong>ingen sporingscookies</strong> og ingen markedsføringscookies. Tjenesten benytter kun anonym, aggregert, server-side trafikkstatistikk som ikke kan kobles til enkeltpersoner. Det lagres ingen cookies på din enhet for analyseformål.</p>

    <h2>Tredjeparter</h2>
    <p>Vi <strong>selger ikke</strong> og deler ikke personopplysninger med tredjeparter for kommersielle formål. Tjenesten driftes på Fly.io i EU-region (Frankfurt). Ingen persondata overføres til land utenfor EU/EØS-området.</p>

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
// GET /spesialitet/:slug  (PR-112)
// ═══════════════════════════════════════════════════════════

router.get("/spesialitet/:slug", (req: Request, res: Response) => {
  const slugParam = String(req.params.slug).toLowerCase();
  const sp = findSpecialtyBySlug(slugParam);
  if (!sp) {
    res.status(404).send(dentalShell(
      `<main><div class="container"><div class="empty-state" style="padding:80px 0"><h3>Spesialitet ikke funnet</h3><p>Vi kjenner ikke til spesialiteten «${escapeHtml(slugParam)}». <a href="/">Gå til forsiden</a>.</p></div></div></main>`,
      { title: "Spesialitet ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }

  const PAGE_SIZE = 50;
  let agents: Array<DentalAgent & { id: string }> = [];
  let total = 0;
  try {
    agents = listPublicDentalAgents({ specialty: sp.navn } as any, PAGE_SIZE, 0);
    total = countPublicDentalAgents({ specialty: sp.navn } as any);
  } catch { /* db not ready */ }

  const canonicalUrl = `${DENTAL_BASE_URL}/spesialitet/${sp.slug}`;
  const displayNavn = sp.navn.charAt(0).toUpperCase() + sp.navn.slice(1);

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Tannlegespesialister: ${displayNavn}`,
    url: canonicalUrl,
    numberOfItems: Math.min(total, 50),
    itemListElement: agents.slice(0, 50).map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: a.org_nr
        ? `${DENTAL_BASE_URL}/klinikk/${slugifyClinic(a.navn, a.org_nr)}`
        : `${DENTAL_BASE_URL}/klinikk/id/${a.id}`,
      name: a.navn,
    })),
  };

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
    <p class="result-meta" style="margin-bottom:20px">${total.toLocaleString("nb")} klinikker funnet</p>
    ${resultCards}
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
  res.send(dentalShell(html, {
    title: `${displayNavn} — Tannlegespesialister i Norge | Finn-tannlege.com`,
    description: `Oversikt over tannlegeklinikker med spesialitet i ${sp.navn} i Norge. ${sp.beskrivelse.split(".")[0]}.`,
    canonical: canonicalUrl,
    jsonLd: [itemList, specBreadcrumb],
  }));
});

// ═══════════════════════════════════════════════════════════
// GET /sted/:stedSlug  (PR-116 — bysider)
// ═══════════════════════════════════════════════════════════

router.get("/sted/:stedSlug", (req: Request, res: Response) => {
  const PAGE_SIZE = 50;
  const stedSlugParam = String(req.params.stedSlug).toLowerCase().trim();

  // Build poststed lookup map from cache (slug → PoststedRow)
  const poststeder = getCachedPoststeder();
  const stedMap = new Map<string, PoststedRow>();
  for (const p of poststeder) {
    // first-write-wins: keeps the highest-count row when two poststeder slug to the same value
    if (!stedMap.has(slugifyText(p.poststed))) stedMap.set(slugifyText(p.poststed), p);
  }

  const stedRow = stedMap.get(stedSlugParam);
  if (!stedRow) {
    res.status(404).send(dentalShell(
      `<main><div class="container"><div class="empty-state" style="padding:80px 0"><h3>Sted ikke funnet</h3><p>Vi fant ikke tannleger for «${escapeHtml(stedSlugParam)}».</p><a href="/" class="btn-secondary" style="margin-top:16px">Til forsiden</a></div></div></main>`,
      { title: "Sted ikke funnet — Finn-tannlege.com" }
    ));
    return;
  }

  const titledSted = titleCasePoststed(stedRow.poststed);
  const sideRaw = parseInt(String(req.query.side || "1"), 10);
  const page = Number.isFinite(sideRaw) && sideRaw > 0 ? sideRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  let agents: Array<DentalAgent & { id: string }> = [];
  let total = 0;
  try {
    agents = listPublicDentalAgents({ poststed: stedRow.poststed } as any, PAGE_SIZE, offset);
    total = countPublicDentalAgents({ poststed: stedRow.poststed } as any);
  } catch { /* db not ready */ }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canonicalUrl = `${DENTAL_BASE_URL}/sted/${stedSlugParam}`;
  const baseUrl = `/sted/${stedSlugParam}`;

  // JSON-LD ItemList
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Tannlege i ${titledSted}`,
    url: canonicalUrl,
    numberOfItems: Math.min(total, 25),
    itemListElement: agents.slice(0, 25).map((a, i) => ({
      "@type": "ListItem",
      position: offset + i + 1,
      url: a.org_nr
        ? `${DENTAL_BASE_URL}/klinikk/${slugifyClinic(a.navn, a.org_nr)}`
        : `${DENTAL_BASE_URL}/klinikk/id/${a.id}`,
      name: a.navn,
    })),
  };

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
  res.send(dentalShell(html, {
    title: `Tannlege i ${escapeHtml(titledSted)} — Finn-tannlege.com`,
    description: `Oversikt over ${total} tannlegeklinikker i ${titledSted}${stedRow.fylke ? `, ${stedRow.fylke}` : ""}. Finn klinikk med Helfo-avtale, spesialitet eller tannlegevakt.`,
    canonical: canonicalUrl,
    jsonLd: [itemList, stedBreadcrumb],
  }));
});

// ═══════════════════════════════════════════════════════════
// PR-113: A2A discovery flater (FØR catch-all)
// ═══════════════════════════════════════════════════════════

// GET /.well-known/agent-card.json — A2A Agent Card (standard well-known path)
router.get("/.well-known/agent-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalAgentCard());
});

// GET /agent-card.json — alias (some crawlers skip well-known prefix)
router.get("/agent-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalAgentCard());
});

// GET /openapi.json — OpenAPI 3.1 spec for finn-tannlege.com
router.get("/openapi.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=300");
  res.json(getDentalOpenapi());
});

// ═══════════════════════════════════════════════════════════
// Catch-all 404 — norsk side (forhindrer rfb-innhold på dental-host)
// ═══════════════════════════════════════════════════════════

router.use((_req: Request, res: Response) => {
  res.status(404).send(dentalShell(
    `<main><div class="container"><div class="empty-state" style="padding:80px 0">
      <h3>Siden finnes ikke</h3>
      <p>Vi fant ikke siden du leter etter. Prøv å søke etter tannlege, eller gå til forsiden.</p>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;flex-wrap:wrap">
        <a href="/" class="btn-secondary">Til forsiden</a>
        <a href="/sok" class="btn-primary">Søk etter tannlege</a>
      </div>
    </div></div></main>`,
    { title: "Side ikke funnet (404) — Finn-tannlege.com" }
  ));
});

export default router;
