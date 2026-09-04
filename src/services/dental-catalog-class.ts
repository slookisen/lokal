// ─── dental-catalog-class ───────────────────────────────────────────────────
// dev-request 2026-09-02-dental-catalog-class-triage (steg 1 of the
// 2026-09-02 dental pipeline review, A2A dental-enrichment-runs/
// dental-pipeline-review-2026-09-02.md).
//
// WHY: dental_agents was seeded from a Brreg sweep over NACE 86.230 + 86.221 +
// 32.500 across ALL organisational forms, so roughly a third of the 6 975
// rows are not patient-facing clinics at all: sole-proprietorship dentists
// registered under their own name (who work in somebody else's clinic),
// dental-technician labs and suppliers (32.500), holding/investment vehicles
// owned by dentists, and a batch of county-directory rows imported without
// any Brreg metadata. Every downstream consumer (claim pool, Places
// backfill, public listing, MCP/A2A discovery) treats all of them as
// clinics, which is (a) why the enrichment pipeline's wrong-entity counter
// fills up — the raw+hjemmeside pool is now almost entirely this residue —
// and (b) why the public site advertises "6 961 klinikker".
//
// This module is a PURE, rule-based classifier: given the Brreg-level facts
// already on the row (navn, naeringskode, organisasjonsform, hjemmeside) it
// returns a catalog_class plus the rule that fired. It never fetches, never
// touches the DB. The backfill endpoint (src/routes/admin-dental-catalog-
// class.ts) applies it; the claim-pool query (dental-claim-service.ts) and
// the Places auto-select (routes/dental.ts) read the stored column.
//
// Bias: when a rule is not clearly met the row stays "klinikk" or "ukjent",
// never a non-clinic class — a false "holding"/"person_enk" would hide a
// real clinic from the public site, which is the worse error. Classes:
//
//   klinikk            patient-facing clinic (default when a dental word is
//                      in the name, or an AS/DA/ANS with dental NACE and no
//                      exclusion signal)
//   offentlig_klinikk  public (fylkeskommunal/kommunal) clinic — county-
//                      directory import rows (no organisasjonsform) or a
//                      hjemmeside on a county/municipality host
//   person_enk         ENK registered under a person's own name with no
//                      dental word in it (individual dentist, not a clinic)
//   lab_leverandor     dental-technician lab / supplier / instrument maker
//                      (NACE 32.500, or lab/technician words in the name)
//   holding            holding / investment / property / consulting vehicle
//   ukjent             nothing matched — keep visible, revisit by hand
//
// The classifier is deliberately conservative and string-based; a Sonnet
// sample over `ukjent` and `klinikk`-without-dental-word is a later slice.

export type DentalCatalogClass =
  | "klinikk"
  | "offentlig_klinikk"
  | "person_enk"
  | "lab_leverandor"
  | "holding"
  | "ukjent";

export const DENTAL_CATALOG_CLASSES: readonly DentalCatalogClass[] = [
  "klinikk",
  "offentlig_klinikk",
  "person_enk",
  "lab_leverandor",
  "holding",
  "ukjent",
];

// Classes that count as a clinic for every downstream consumer (claim pool,
// Places auto-select, public listing). Exported so the SQL clauses in the
// claim service / routes and this module can never drift apart.
export const DENTAL_CLINIC_CLASSES: readonly DentalCatalogClass[] = ["klinikk", "offentlig_klinikk"];

// Rows whose catalog_class is NULL (never classified) or "ukjent" stay
// eligible everywhere — classification is additive, it only ever REMOVES
// rows that positively matched a non-clinic rule.
export const DENTAL_CLINIC_CLASS_SQL =
  "(catalog_class IS NULL OR catalog_class IN ('klinikk','offentlig_klinikk','ukjent'))";

// dev-request 2026-09-03-dental-catalog-class-public-filter (slice 1b): the
// PUBLIC-facing read surfaces (site /sok, /fylke, /sted + front-page/
// county/city counters, GET /api/tannlege/discover, the MCP server's
// tannlege_* tools, and the sitemap) still showed every row regardless of
// catalog_class -- including person_enk/lab_leverandor/holding rows the
// claim-pool (dental-claim-service.ts) and Places auto-select (routes/
// dental.ts) already learned to skip via DENTAL_CLINIC_CLASS_SQL above.
//
// This is a SEPARATE opt-in rollout knob from that claim-pool filter's
// DENTAL_CATALOG_CLASS_FILTER_DISABLED kill-switch (which is default-ON):
// the public surfaces need their own gradual, default-OFF rollout, so
// unset/falsy must stay byte-identical to pre-slice-1b behavior. Reuses
// the SAME DENTAL_CLINIC_CLASS_SQL clause (NULL/ukjent stay eligible; only
// positively-classified non-clinic rows are excluded) so the public and
// claim-pool notions of "clinic" cannot drift apart.
export function isDentalPublicCatalogClassFilterEnabled(): boolean {
  return process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER === "1";
}

export interface CatalogClassInput {
  navn: string | null | undefined;
  naeringskode?: string | null;
  organisasjonsform?: string | null;
  hjemmeside?: string | null;
}

export interface CatalogClassification {
  catalog_class: DentalCatalogClass;
  // Short machine-readable rule id — stored in catalog_class_source so a
  // reviewer can see WHY a row landed where it did without re-running.
  rule: string;
}

// Words that make a name read as a dental clinic. Substring match on the
// lower-cased name; "tann" alone catches tannlege/tannklinikk/tannhelse/
// tannregulering/tannlegesenter etc.
export const DENTAL_NAME_WORDS: readonly string[] = [
  "tann",
  "dental",
  "dent ",
  "dent.",
  "kjeve",
  "orto",
  "klinikk",
  "smil",
  "munn",
  "implant",
  "endo",
  "perio",
  "protet",
  "odont",
  "dentist",
];

// Words that mark a dental-technician lab / supplier even under NACE 86.230.
export const LAB_NAME_WORDS: readonly string[] = [
  "tannteknik",
  "tanntekn",
  "laborator",
  "dentalservice",
  "dental service",
  "dentalforum lab",
  "dental lab",
  "dental design",
  "dental supply",
];

// Words that mark a holding / investment / property / consulting vehicle.
export const HOLDING_NAME_WORDS: readonly string[] = [
  "holding",
  "invest",
  "eiendom",
  "consult",
  "kapital",
  "forvaltning",
];

// Hostnames (suffix match) of public dental-service pages — fylkeskommune /
// kommune sites that list their own clinics. A hjemmeside on one of these is
// a strong signal that the row is a public (fylkeskommunal) clinic. Also
// used by the Places website guard: such a host is never accepted as a
// clinic's OWN homepage (it is a directory page, not the clinic's site).
export const PUBLIC_DENTAL_SERVICE_HOSTS: readonly string[] = [
  "mrfylke.no",
  "agderfk.no",
  "afk.no",
  "tromsfylke.no",
  "vestlandfylke.no",
  "trondelagfylke.no",
  "web.trondelagfylke.no",
  "ffk.no",
  "nfk.no",
  "bfk.no",
  "vestfoldfylke.no",
  "telemarkfylke.no",
  "innlandetfylke.no",
  "ostfoldfylke.no",
  "rogfk.no",
  "tannhelserogaland.no",
  "tannhelsetjenesten.no",
  "oslo.kommune.no",
  "tkmidt.no",
  "tkvest.no",
  "tkost.no",
  "tknn.no",
];

function hostnameOf(url: string | null | undefined): string {
  if (!url) return "";
  let s = String(url).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/[?#].*$/, "");
  s = s.replace(/^www\./, "").replace(/:\d+$/, "");
  return s;
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** True when `url`'s host is a fylkeskommune/kommune dental-service page. */
export function isPublicDentalServiceHost(url: string | null | undefined): boolean {
  const h = hostnameOf(url);
  if (!h) return false;
  return PUBLIC_DENTAL_SERVICE_HOSTS.some((d) => hostMatches(h, d));
}

function hasAny(name: string, words: readonly string[]): boolean {
  return words.some((w) => name.includes(w));
}

/**
 * Classify one dental_agents row. Pure, never throws.
 *
 * Rule order matters — earlier rules are the more specific / more certain:
 *   1. NACE 32.500 or lab words            → lab_leverandor
 *   2. holding/invest words, no dental word → holding
 *   3. county/municipality hjemmeside       → offentlig_klinikk
 *   4. no organisasjonsform + no NACE       → offentlig_klinikk (county-
 *      directory import rows carry neither)
 *   5. ENK with no dental word              → person_enk
 *   6. any dental word in the name          → klinikk
 *   7. AS/DA/ANS/NUF/SA with dental NACE    → klinikk (company under a
 *      non-descriptive name, e.g. "A C HVOSLEF AS")
 *   8. otherwise                            → ukjent
 */
export function classifyDentalCatalogEntry(input: CatalogClassInput): CatalogClassification {
  const name = (input.navn ?? "").toLowerCase().trim();
  const nace = (input.naeringskode ?? "").trim();
  const form = (input.organisasjonsform ?? "").trim().toUpperCase();
  const dentalWord = hasAny(name, DENTAL_NAME_WORDS);

  // 1. Labs / suppliers.
  if (nace === "32.500") return { catalog_class: "lab_leverandor", rule: "nace_32500" };
  if (hasAny(name, LAB_NAME_WORDS)) return { catalog_class: "lab_leverandor", rule: "lab_name_word" };

  // 2. Holding / investment vehicles. A dental word in the name wins over a
  //    holding word ("TANNLEGE NN HOLDING AS" still gets flagged — a holding
  //    company is never the clinic — so the dental-word exemption is only
  //    for names where "invest"/"consult" is incidental, e.g. "INVESTDENT"
  //    is a real clinic brand). Rule: holding word AND (no dental word OR
  //    name ends with the holding phrase).
  if (hasAny(name, HOLDING_NAME_WORDS)) {
    const endsWithHolding = /\b(holding|invest|eiendom|kapital|forvaltning)( as| da| ans)?$/.test(name);
    if (!dentalWord || endsWithHolding) return { catalog_class: "holding", rule: "holding_name_word" };
  }

  // 3. Public clinic by hjemmeside host.
  if (isPublicDentalServiceHost(input.hjemmeside)) {
    return { catalog_class: "offentlig_klinikk", rule: "public_service_host" };
  }

  // 4. County-directory import rows (no Brreg metadata at all).
  if (!form && !nace) {
    return { catalog_class: "offentlig_klinikk", rule: "no_brreg_metadata" };
  }

  // 5. Sole proprietorship under a person's name.
  if (form === "ENK" && !dentalWord) {
    return { catalog_class: "person_enk", rule: "enk_no_dental_word" };
  }

  // 6. Dental word in the name.
  if (dentalWord) return { catalog_class: "klinikk", rule: "dental_name_word" };

  // 7. Company forms with dental NACE but a non-descriptive name.
  if (["AS", "DA", "ANS", "NUF", "SA", "ASA", "KBO", "FKF", "KF", "IKS", "STI", "FLI"].includes(form) &&
      (nace === "86.230" || nace === "86.221" || nace === "86.220")) {
    return { catalog_class: "klinikk", rule: "company_dental_nace" };
  }

  return { catalog_class: "ukjent", rule: "no_rule" };
}
