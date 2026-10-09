// ─── Company facts as the product sites print them ──────────────────────────
// A2A dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as (+ the
// 2026-10-09 additions T1–T3). rettfrabonden.com, opplevagent.no and
// finn-tannlege.com all render the operator through THESE helpers, so the
// wording is identical on every site and every fact comes from COMPANY_INFO.
//
// Only facts change on the legal pages: who operates the site, org.nr.,
// address, e-mail, register and VAT status. Each site keeps its own brand and
// its own contact address (`siteEmail`).
//
// The street address (likely the owner's home) belongs on /kontakt and
// /personvern only — companyFooterLineHtml() deliberately never prints it.

import { COMPANY_INFO } from "../config/company-info";

export type SiteLang = "nb" | "en";

/**
 * The sites' own language codes ("no" / "nb" / "en" / "sv" / undefined) → the
 * helpers' SiteLang. Only English gets the English wording; Norwegian and
 * Swedish pages (and anything unknown) get the Norwegian legal lines.
 */
export function toSiteLang(lang: string | null | undefined): SiteLang {
  return lang === "en" ? "en" : "nb";
}

const C = COMPANY_INFO;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addressLine(lang: SiteLang): string {
  const a = C.address;
  return `${a.street}, ${a.postalCode} ${a.city}${lang === "en" ? ", Norway" : ""}`;
}

function orgNrLabel(lang: SiteLang): string {
  return lang === "en" ? "Org. no." : "Org.nr.";
}

/**
 * T1 footer line: «En tjeneste fra AGENTPLATFORM.NO AS · Org.nr. 938 635 676».
 * The company name links to agentplatform.no, the org.nr. to the site's own
 * contact page (where the full § 8 details are). No street address.
 */
export function companyFooterLineHtml(lang: SiteLang, opts: { contactHref: string }): string {
  const lead = lang === "en" ? "A service from" : "En tjeneste fra";
  return (
    `${lead} <a href="${C.website}">${C.legalName}</a> · ` +
    `<a href="${esc(opts.contactHref)}">${orgNrLabel(lang)} ${C.orgNrDisplay}</a>`
  );
}

/** Plain-text variant of the footer line (for places that escape their own text). */
export function companyFooterLineText(lang: SiteLang): string {
  return `${lang === "en" ? "A service from" : "En tjeneste fra"} ${C.legalName} · ${orgNrLabel(lang)} ${C.orgNrDisplay}`;
}

/** VAT status sentence; never prints "MVA" after the org.nr. while not registered. */
export function companyVatStatus(lang: SiteLang): string {
  if (C.vatRegistered) return lang === "en" ? "Registered in the Norwegian VAT Register" : "Registrert i Merverdiavgiftsregisteret";
  return lang === "en" ? "Not registered in the Norwegian VAT Register" : "Ikke registrert i Merverdiavgiftsregisteret";
}

export interface CompanyFact {
  label: string;
  /** Already-escaped HTML. */
  valueHtml: string;
}

/**
 * Every fact ehandelsloven § 8 and foretaksregisterloven ask for, as
 * label/value pairs, so each site can render them in its own markup.
 */
export function companyContactFacts(lang: SiteLang, opts: { siteEmail: string }): CompanyFact[] {
  const en = lang === "en";
  return [
    { label: en ? "Company name" : "Foretaksnavn", valueHtml: C.legalName },
    { label: en ? "Organisation form" : "Organisasjonsform", valueHtml: esc(C.organizationForm[lang]) },
    { label: en ? "Head office" : "Hovedkontor", valueHtml: esc(C.headOffice) },
    { label: en ? "Business address" : "Forretningsadresse", valueHtml: esc(addressLine(lang)) },
    {
      label: en ? "Register" : "Register",
      valueHtml:
        (en ? "Register of Business Enterprises (Foretaksregisteret), org. no. " : "Registrert i Foretaksregisteret, org.nr. ") +
        `<a href="${C.brregUrl}">${C.orgNrDisplay}</a>`,
    },
    { label: en ? "VAT" : "MVA", valueHtml: esc(companyVatStatus(lang)) },
    { label: en ? "Email" : "E-post", valueHtml: `<a href="mailto:${esc(opts.siteEmail)}">${esc(opts.siteEmail)}</a>` },
    { label: en ? "Company website" : "Selskapets nettside", valueHtml: `<a href="${C.website}">agentplatform.no</a>` },
  ];
}

/** A ready-made <dl> of companyContactFacts() for sites without their own markup. */
export function companyContactBlockHtml(lang: SiteLang, opts: { siteEmail: string; className?: string }): string {
  const rows = companyContactFacts(lang, opts)
    .map((f) => `<dt>${esc(f.label)}</dt><dd>${f.valueHtml}</dd>`)
    .join("");
  return `<dl${opts.className ? ` class="${esc(opts.className)}"` : ""}>${rows}</dl>`;
}

/**
 * The data controller for a site, for /personvern:
 * «Behandlingsansvarlig for <site> er AGENTPLATFORM.NO AS (org.nr. …), <adresse>. E-post: <siteEmail>.»
 */
export function companyControllerSentenceHtml(lang: SiteLang, opts: { siteName: string; siteEmail: string }): string {
  const mail = `<a href="mailto:${esc(opts.siteEmail)}">${esc(opts.siteEmail)}</a>`;
  if (lang === "en") {
    return `The data controller for ${esc(opts.siteName)} is ${C.legalName} (org. no. ${C.orgNrDisplay}), ${esc(addressLine("en"))}. Email: ${mail}.`;
  }
  return `Behandlingsansvarlig for ${esc(opts.siteName)} er ${C.legalName} (org.nr. ${C.orgNrDisplay}), ${esc(addressLine("nb"))}. E-post: ${mail}.`;
}

/** The operator line for /vilkar and /terms: «Operatør: AGENTPLATFORM.NO AS (org.nr. …), Oslo.» */
export function companyOperatorSentence(lang: SiteLang): string {
  return lang === "en"
    ? `Operator: ${C.legalName} (org. no. ${C.orgNrDisplay}), ${C.headOffice}, Norway.`
    : `Operatør: ${C.legalName} (org.nr. ${C.orgNrDisplay}), ${C.headOffice}.`;
}

/** T2: schema.org parentOrganization for each site's Organization / WebSite JSON-LD. No street address. */
export function parentOrganizationJsonLd(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": `${C.website}/#organization`,
    name: C.displayName,
    legalName: C.legalName,
    url: C.website,
    identifier: { "@type": "PropertyValue", propertyID: "Organisasjonsnummer", value: C.orgNr },
  };
}

/** T3: A2A agent-card `provider` for all three services. The card's own `name` keeps the brand. */
export function agentCardProvider(): { organization: string; url: string } {
  return { organization: C.displayName, url: C.website };
}
