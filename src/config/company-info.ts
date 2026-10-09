// ─── The company behind every site this app serves ──────────────────────────
// ONE source for the legal facts about AGENTPLATFORM.NO AS, which owns and
// operates rettfrabonden.com, opplevagent.no, finn-tannlege.com and the
// company site agentplatform.no (A2A dev-requests
// 2026-10-08-agentplatform-no-paraplyside and
// 2026-10-08-juridisk-info-nettsteder-agentplatform-as, spec item 1).
//
// Facts read from Enhetsregisteret 2026-10-08:
//   https://data.brreg.no/enhetsregisteret/api/enheter/938635676
// An address change or a VAT registration is a one-line edit here.
//
// The street address is most likely Daniel's home. It is public in
// Enhetsregisteret and ehandelsloven § 8 requires it on the sites, but it
// belongs on contact and privacy pages only — never in footers or front pages.
//
// Contact email is per site: each product site keeps its own kontakt@ address;
// `email` below is the company site's.

export const COMPANY_INFO = Object.freeze({
  /** Exactly as registered (Brreg prints every name in capitals). Use in legal lines. */
  legalName: "AGENTPLATFORM.NO AS",
  /** For running text. */
  displayName: "Agentplatform.no AS",
  orgNr: "938635676",
  /** Groups of three, as written on Norwegian sites. */
  orgNrDisplay: "938 635 676",
  register: "Foretaksregisteret",
  /** Organisasjonsform and hovedkontor: required on the sites next to name and org.nr. (foretaksregisterloven). */
  organizationForm: Object.freeze({ nb: "Aksjeselskap", en: "Private limited company (AS)" }),
  headOffice: "Oslo",
  registeredDate: "2026-10-07",
  foundedDate: "2026-10-03",
  /** Not in Merverdiavgiftsregisteret: never print "MVA" after the org.nr while false. */
  vatRegistered: false,
  address: Object.freeze({
    street: "Haakon Tveters vei 66",
    postalCode: "0686",
    city: "Oslo",
    countryCode: "NO",
  }),
  website: "https://agentplatform.no",
  email: "kontakt@agentplatform.no",
  brregUrl: "https://virksomhet.brreg.no/nb/oppslag/enheter/938635676",
  /** Daglig leder and styreleder (public in Brreg). Shown on agentplatform.no (Daniel live 2026-10-09). */
  founder: Object.freeze({
    name: "Daniel Fredriksen",
    role: Object.freeze({ nb: "Gründer og daglig leder", en: "Founder and CEO" }),
    /** Profile URL, or null until Daniel confirms it — the link is rendered only when set. */
    linkedin: null as string | null,
  }),
});

export type CompanyInfo = typeof COMPANY_INFO;
