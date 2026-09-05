// ─── dental-catalog-class-judge.ts — Sonnet-sample second-pass judge ──────
//
// dev-request 2026-09-02-dental-catalog-class-triage, slice 1c ("Sonnet-
// sample over the ambiguous catalog_class cohort"). src/services/dental-
// catalog-class.ts's rule engine is deliberately conservative and known to
// sometimes rule-match "klinikk" via the company_dental_nace rule (any
// AS/DA/ANS/... with dental NACE code but no dental word in the name) on
// rows that are NOT actually dental clinics (a hearing-aid lab, an
// orthopedics supplier, etc — anything under NACE 86.230/86.221/86.220 that
// isn't dentistry). This module judges exactly that ambiguous sub-cohort
// (the caller, src/routes/admin-dental-catalog-class-sonnet-sample.ts,
// selects it) with a real model call instead of another string rule.
//
// Contract mirrors src/services/orgnr-identity-judge.ts EXACTLY: direct
// fetch to https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from
// env, model claude-haiku-4-5 (same as this codebase's other structured
// single-token classification judges — this is that same class of task, not
// a different one), Norwegian prompt, EXACT single verdict token alone on
// the model's reply's first line + a short Norwegian reason on the next
// line. Fail-closed, NEVER throws: missing key / network error / non-200 /
// unparseable JSON / unexpected-or-ambiguous token all resolve to
// {verdict_class: "ukjent", ...} — the same safe, no-op fallback the rule
// engine itself uses for "didn't match anything". A genuine model answer is
// the ONLY way to reach "not_a_clinic" or a reclassification into one of
// the five real classes; no failure path may ever produce those.
//
// This module does NOT fetch the clinic's homepage — only the hjemmeside
// URL STRING is given to the model as context, keeping this a cheap
// metadata-only judgment (the caller route decides what to do with the
// verdict; this module never touches the DB).

import type { DentalCatalogClass } from "./dental-catalog-class";

export type DentalSonnetVerdictClass = DentalCatalogClass | "not_a_clinic";

export interface DentalCatalogClassSonnetVerdict {
  verdict_class: DentalSonnetVerdictClass;
  reason: string;
}

const VALID_VERDICT_TOKENS: readonly DentalSonnetVerdictClass[] = [
  "klinikk",
  "offentlig_klinikk",
  "person_enk",
  "lab_leverandor",
  "holding",
  "not_a_clinic",
  "ukjent",
];

function isValidVerdictToken(token: string): token is DentalSonnetVerdictClass {
  return (VALID_VERDICT_TOKENS as readonly string[]).includes(token);
}

/**
 * judgeDentalCatalogClass — given a dental_agents row's Brreg-level facts
 * (navn, naeringskode, organisasjonsform, hjemmeside — the URL string only,
 * never fetched) plus the row's current rule-engine class, asks the model
 * whether that classification actually holds, or whether the row is not a
 * dental clinic at all.
 *
 * Never throws — every failure mode (missing key, network error, non-200,
 * unparseable JSON, an ambiguous/unexpected model reply) resolves to
 * `{verdict_class: "ukjent", ...}`. Callers must treat "ukjent" exactly like
 * "no verdict yet" — never a reclassification and never an exclusion.
 */
export async function judgeDentalCatalogClass(params: {
  navn: string;
  naeringskode?: string | null;
  organisasjonsform?: string | null;
  hjemmeside?: string | null;
  currentClass: DentalCatalogClass;
}): Promise<DentalCatalogClassSonnetVerdict> {
  const { navn, naeringskode, organisasjonsform, hjemmeside, currentClass } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { verdict_class: "ukjent", reason: "ANTHROPIC_API_KEY mangler — ukjent fail-closed" };
  }

  const naceText = naeringskode && naeringskode.trim() !== "" ? naeringskode.trim() : "ukjent";
  const formText = organisasjonsform && organisasjonsform.trim() !== "" ? organisasjonsform.trim() : "ukjent";
  const urlText = hjemmeside && hjemmeside.trim() !== "" ? hjemmeside.trim() : "ukjent";

  const prompt = `Du er en klassifiseringsdommer for et norsk tannlege-katalogregister (dental_agents). En regelbasert klassifiserer har allerede satt en foreløpig klasse på denne raden, men regelmotoren er bevisst konservativ og er kjent for av og til å feilklassifisere selskaper med tannlege-NACE-kode men uten tannord i navnet som "klinikk" — selv om selskapet faktisk driver med noe helt annet (f.eks. et høreapparatlaboratorium eller en ortopeditilbyder registrert under samme NACE-kode). Din jobb er å vurdere raden på nytt ut fra de rå faktaene og enten bekrefte/korrigere klassen, eller flagge at raden ikke er en tannklinikk i det hele tatt.

Rad-fakta:
Navn: "${navn}"
Næringskode (NACE): ${naceText}
Organisasjonsform: ${formText}
Hjemmeside (kun URL-streng — du skal IKKE anta innhold du ikke kan se): ${urlText}
Regelmotorens nåværende klasse: ${currentClass}

De 7 mulige svarene (svar med NØYAKTIG ett av disse ordene alene):
- klinikk: en pasientrettet tannklinikk/tannlegepraksis.
- offentlig_klinikk: en offentlig (fylkeskommunal/kommunal) tannklinikk.
- person_enk: en enkeltpersonforetak-registrering under en tannleges eget personnavn (ikke en klinikk i seg selv).
- lab_leverandor: et tanntekniker-laboratorium eller en leverandør/produsent av tannhelseutstyr.
- holding: et holding-/investerings-/eiendoms-/konsulentselskap knyttet til tannhelsebransjen, ikke en driftsklinikk.
- not_a_clinic: raden er TYDELIG IKKE tannhelserelatert i det hele tatt (f.eks. et høreapparatlaboratorium, en ortopeditilbyder, eller annen virksomhet som bare tilfeldigvis deler NACE-kode) — dette skiller seg fra "ukjent", som betyr at du er genuint usikker.
- ukjent: du er usikker og kan ikke avgjøre det trygt ut fra fakta over.

Ved minste tvil, svar ukjent — gjett ALDRI deg fram til en eksklusjon (not_a_clinic) eller en omklassifisering du ikke er sikker på.

Svar med EKSAKT ett av de 7 ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje. Eksempel:
klinikk
<kort begrunnelse>

Ved minste tvil, svar ukjent.`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { verdict_class: "ukjent", reason: "nettverksfeil under dommer-kall — ukjent fail-closed" }; // never fabricate
  }

  if (!response.ok) {
    return { verdict_class: "ukjent", reason: `dommer-API svarte status ${response.status} — ukjent fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { verdict_class: "ukjent", reason: "ikke-parsbar JSON fra dommer-API — ukjent fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { verdict_class: "ukjent", reason: "uventet svarformat fra dommer-API — ukjent fail-closed" };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toLowerCase();
  const reason = lines.slice(1).join(" ").trim();

  // Only an EXACT, recognized token produces a real verdict. Fail-closed on
  // any ambiguity, never a silent guess.
  if (isValidVerdictToken(verdictToken)) {
    return { verdict_class: verdictToken, reason: reason || "vurdert av LLM-dommer" };
  }
  return { verdict_class: "ukjent", reason: "uventet/tvetydig dommersvar — ukjent fail-closed" };
}
