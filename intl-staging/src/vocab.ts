// Controlled Swedish vocabularies for the structured-facts-only profiles (LIA SE
// §5: "produktkategorier, salgskanaler — som kontrollerte kategorier, ikke
// fritekst"; Daniel live 2026-10-13 «Bare fakta først»). The builder may only
// pick from these lists, so category and channel text is correct Swedish by
// construction; the judge still checks every free-text value.

export const SE_PRODUCT_CATEGORIES = [
  "kött",
  "chark",
  "fågel",
  "vilt",
  "fisk och skaldjur",
  "mejeri",
  "ost",
  "ägg",
  "grönsaker",
  "potatis",
  "frukt",
  "bär",
  "svamp",
  "honung",
  "spannmål och mjöl",
  "bröd och bakverk",
  "sylt, saft och konserver",
  "kryddor och örter",
  "must och juice",
  "öl",
  "cider",
  "vin",
  "sprit",
  "färdigrätter",
] as const;

export const SE_SALES_CHANNELS = [
  "gårdsbutik",
  "gårdsförsäljning",
  "självplock",
  "REKO-ring",
  "marknad",
  "webbshop",
  "prenumeration",
  "gårdscafé eller restaurang",
  "hemleverans",
  "via återförsäljare",
] as const;

// Certifications are only accepted with a source on the certifier's own
// register (DPIA T1/T4: "Sertifiseringer bare med treff i offisielt register").
// EU-ekologisk has no single public register host we can check mechanically
// yet, so it is deliberately absent until one is chosen.
export const SE_CERTIFICATIONS: Record<string, string[]> = {
  KRAV: ["krav.se"],
};
