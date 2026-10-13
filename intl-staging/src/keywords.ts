// Direct-sale keyword signal on Bolagsverket's `verksamhetsbeskrivning`.
// Lists A (direct sale) and B (craft/processing) are copied from the phase-1
// register analysis (A2A strategic-decisions/se-dk-fase1/se-notat.md §3.4),
// including the word-start anchors added after the «svinproduktion» →
// «vinproduktion» false positive (FUNN nokkelord-uten-ordgrense).

const L = "(?<![a-zåäöéü])";
const R = "(?![a-zåäöéü])";

export const SIGNAL_A: Array<[string, RegExp]> = [
  ["gårdsbutik", /gårdsbutik|gårdsaffär|gårdshandel/],
  ["gårdsförsäljning", /gårdsförsälj/],
  ["direktförsäljning", /direktförsälj|direkt till konsument|direkt till kund|direkt till slutkonsument/],
  ["egna produkter", /försäljning av (egna|egen|egenproducerade|egenodlade|egentillverkade|gårdens)|egenproducerade|egenodlade|gårdens (egna )?produkter/],
  ["REKO", new RegExp(`${L}reko${R}|reko-ring|rekoring`)],
  ["självplock", /självplock|plocka själv|självskörd/],
  ["torg/marknad", /torghandel|torgförsälj|marknadsförsälj|försäljning på marknad|bondens marknad|bondens egen/],
  ["lokal/när", /lokalproduc|närproduc|lokalt producera|lokalt odla/],
  ["gårdscafé", /gårdscaf|gårdskaf/],
  ["nätbutik", /nätbutik|webbutik|webbshop|e-handel/],
];

export const SIGNAL_B: Array<[string, RegExp]> = [
  ["mejeri", /mejeri/],
  ["ysteri", new RegExp(`${L}(gårds)?ysteri|osttillverkning|tillverkning av ost`)],
  ["slakteri", /slakteri|gårdsslakt|styckning/],
  ["chark/rökeri", new RegExp(`charkuteri|rökeri|chark${R}`)],
  ["gårdsbageri", /gårdsbageri/],
  ["förädling", /förädl/],
  ["dryck", new RegExp(`bryggeri|musteri|${L}vin(gård|odling|produktion|tillverkning|makeri)|destilleri|cider`)],
  ["mathantverk", /mathantverk|hantverksmässig/],
];

export interface Signal {
  a: string[];
  b: string[];
}

export function directSaleSignal(description: string): Signal | null {
  const text = description.toLowerCase();
  const a = SIGNAL_A.filter(([, re]) => re.test(text)).map(([name]) => name);
  const b = SIGNAL_B.filter(([, re]) => re.test(text)).map(([name]) => name);
  return a.length || b.length ? { a, b } : null;
}
