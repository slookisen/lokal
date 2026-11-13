// ─── Owner beta: ALL owner-facing strings (PLACEHOLDERS) ────────────────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S3 (AC8).
//
// Every owner-facing string the beta UI shows lives here, as CLEARLY MARKED
// PLACEHOLDER text — not finished copy. Text pack D (slice S4) replaces this
// module wholesale once Daniel has approved the wording verbatim
// (daniel-responses/), so nothing outside this file carries beta copy.
//
// None of it is ever shown in production while OWNER_BETA_MODE is unset/off:
// the card and badge render only in mode `offer` (beta-card.ts), so with the
// flag off the owner pages are byte-identical to today (AC1).
//
// Keep this module free of HTML and of any logic — strings only.

/**
 * The beta terms version an owner accepts on opt-in (stored in
 * owner_beta_enrollment.terms_version). Text pack D sets the real version
 * string when the terms text is approved; until then it is a placeholder.
 */
export const BETA_TERMS_VERSION = "placeholder-d-0";

/** Where the (not yet written) beta terms will live. Placeholder target. */
export const BETA_TERMS_HREF = "/beta/vilkar";

/** Per tier-registry feature key: a PLACEHOLDER display name for the card/badge list. */
export const BETA_FEATURE_PLACEHOLDER_NAMES: Record<string, string> = {
  dashboard: "[PLASSHOLDER] Oversikt-verktøy",
  mine_valg: "[PLASSHOLDER] Mine valg",
  owner_theme: "[PLASSHOLDER] Utseende",
  orders: "[PLASSHOLDER] Bestillinger",
  orderability: "[PLASSHOLDER] Bestillbare varer",
  product_import: "[PLASSHOLDER] Hent produkter fra nettsiden",
  product_import_outreach: "[PLASSHOLDER] Produkthenting – utsending",
  order_email: "[PLASSHOLDER] Bestillinger på e-post",
  unified_session: "[PLASSHOLDER] Samlet innlogging",
  stock_check: "[PLASSHOLDER] Lagersjekk",
  stock_soft_expiry: "[PLASSHOLDER] Utløp av varer",
};

/** Every visible string, all clearly marked as placeholder (AC8). */
export const BETA_TEXTS = {
  // The offer card (verified non-pilot owner, mode offer, within cap).
  offerCardTitle: "[PLASSHOLDER] Prøv de nye eierverktøyene (beta)",
  offerCardIntro:
    "[PLASSHOLDER] Dette er en midlertidig tekst. Verktøyene under testes, men virker. "
    + "Du kan slå beta av igjen når som helst. Endelig tekst kommer i tekstpakke D.",
  offerCardFeaturesLead: "[PLASSHOLDER] Dette slår du på:",
  offerTermsLabel: "[PLASSHOLDER] Jeg har lest og godtar beta-vilkårene.",
  offerTermsLinkLabel: "[PLASSHOLDER] Les beta-vilkårene",
  offerSubmit: "[PLASSHOLDER] Slå på",

  // At/over cap → register interest instead.
  interestCardTitle: "[PLASSHOLDER] Beta er fullt akkurat nå",
  interestCardIntro:
    "[PLASSHOLDER] Midlertidig tekst. Det er fullt i beta akkurat nå. "
    + "Meld interesse, så får du tilbudet igjen når det blir ledig. Ingenting slås på automatisk.",
  interestSubmit: "[PLASSHOLDER] Meld interesse",
  interestAlreadyLead:
    "[PLASSHOLDER] Du har meldt interesse. Vi gir deg beskjed når det blir ledig.",

  // The active-beta status card (badges + turn off).
  activeCardTitle: "[PLASSHOLDER] Du er med i beta",
  activeCardIntro:
    "[PLASSHOLDER] Midlertidig tekst. Disse verktøyene er på for deg fordi du er med i beta. "
    + "Slår du av, forsvinner de med en gang, men dataene dine beholdes.",
  activeCardFeaturesLead: "[PLASSHOLDER] Beta-verktøy som er på:",
  badgeLabel: "Beta",
  turnOffSubmit: "[PLASSHOLDER] Slå av beta",

  // PRG status alerts on the portal (?status=...).
  alertOn: "[PLASSHOLDER] Beta er slått på. De nye verktøyene er tilgjengelige nå.",
  alertInterest: "[PLASSHOLDER] Takk! Vi har notert interessen din. Ingenting er slått på.",
  alertInterestExists: "[PLASSHOLDER] Du har allerede meldt interesse.",
  alertOff: "[PLASSHOLDER] Beta er slått av. Verktøyene er borte, men dataene dine er beholdt.",
  alertNoChange: "[PLASSHOLDER] Ingen endring.",
  alertNotOffered: "[PLASSHOLDER] Beta kan ikke slås på akkurat nå.",
  alertTermsRequired: "[PLASSHOLDER] Du må godta beta-vilkårene for å slå på.",
  alertCapped: "[PLASSHOLDER] Det er fullt i beta akkurat nå, så vi har notert interessen din i stedet.",
  alertError: "[PLASSHOLDER] Klarte ikke å lagre. Prøv igjen.",
} as const;

export type BetaTextKey = keyof typeof BETA_TEXTS;
