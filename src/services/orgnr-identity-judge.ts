// ─── orgnr-identity-judge.ts — org.nr identity match judge ────────────────
//
// dev-request 2026-08-23-opplevagent-drikke-selvforsyning-speiling, item 3
// ("LLM-dommer-tier for mellomkonfidens-køene", speil av RFB Grep 3 slice 2,
// PR lokal#691). RFB's website-review-judge reuses contact-candidate-judge.
// ts's shared judgeContactCandidate/classifyContactCandidateDefect pair, but
// that module's own file-header frames its job as CONTACT-field judging
// (phone/email/address/website candidates extracted from page text) — an
// org.nr registry match is a DIFFERENT judgment: does a Brreg registry hit's
// registered name+address (candidateName/candidateAddress) plausibly refer
// to the SAME real-world produsent as the provider's own display name
// (+ known kommune/poststed, when available)? The candidate reaching this
// judge is a first-token-name-overlap + postal-corroboration match, not an
// exact-name match — the failure mode this module exists to catch is a
// DIFFERENT business that happens to share a first name-token and postal
// area (the spec's own example: "Ole Hansen Gård" in one poststed vs a
// same-named but unrelated business elsewhere), so it gets its own small,
// self-contained module rather than being folded into contact-candidate-
// judge.ts's already-shipped, already-tested contract for zero behavioural
// gain (same "separate implementation, don't re-risk an already-verified
// module" rationale that file's own header states for staying independent
// of marketplace.ts's).
//
// Fail-closed contract, IDENTICAL to judgeContactCandidate's: missing
// ANTHROPIC_API_KEY, a network failure, a non-200 response, unparseable
// JSON, or any model output that isn't the EXACT GODKJENN/AVVIS token alone
// on its own first line -> rejected. Never throws. Same model
// (claude-haiku-4-5), same direct fetch to
// https://api.anthropic.com/v1/messages, same two-token response contract —
// just a different (Norwegian) prompt, because this is a different
// judgment.

export interface OrgnrIdentityJudgeVerdict {
  approved: boolean;
  reason?: string;
}

const ORGNR_JUDGE_APPROVE_TOKEN = "GODKJENN";
const ORGNR_JUDGE_REJECT_TOKEN = "AVVIS";

/**
 * judgeOrgnrIdentityMatch — given a provider's own display name (+ known
 * kommune/poststed, when the caller has them cheaply available) and a
 * Brreg-registry candidate's registered name+address, decides whether these
 * plausibly name the SAME real-world produsent.
 *
 * Never throws — every failure mode (missing key, network error, non-200,
 * unparseable JSON, an ambiguous/unexpected model reply) resolves to
 * `{approved: false, ...}`. Callers must treat a rejected verdict exactly
 * like "no match" — never a partially-trusted approval.
 */
export async function judgeOrgnrIdentityMatch(params: {
  providerName: string;
  providerKommune?: string | null;
  providerPoststed?: string | null;
  candidateName: string;
  candidateAddress?: string | null;
}): Promise<OrgnrIdentityJudgeVerdict> {
  const { providerName, providerKommune, providerPoststed, candidateName, candidateAddress } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reason: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const placeParts = [providerKommune, providerPoststed].filter(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
  const placeText = placeParts.length > 0 ? placeParts.join(" / ") : "ukjent";
  const addressText = candidateAddress && candidateAddress.trim() !== "" ? candidateAddress.trim() : "ukjent";

  const prompt = `Du er en identitetsdommer for en norsk markedsplattform som kobler forbrukere direkte med lokale matprodusenter (gårdssalg/drikkeprodusenter). Et automatisk org.nr-oppslag mot Brønnøysundregistrene (Brreg) har funnet en KANDIDAT-enhet med delvis navnetreff (kun første navneord er felles) og postal korrespondanse med produsentens kjente sted — IKKE et eksakt navnetreff. Din jobb er å avgjøre om kandidaten faktisk ER samme reelle produsent, eller en ANNEN virksomhet som tilfeldigvis deler første navneord og postområde.

Produsentens navn i vår katalog: "${providerName}"
Produsentens kjente sted (kommune/poststed): ${placeText}

Brreg-kandidatens registrerte navn: "${candidateName}"
Brreg-kandidatens registrerte adresse: ${addressText}

Vanlige feilkilder å være spesielt oppmerksom på:
- To ulike virksomheter som deler et vanlig første navneord (f.eks. et personnavn som "Ole Hansen" eller et generisk ord som "Gård"/"Bryggeri") men er reelt ulike foretak på ulike steder eller med ulik virksomhet.
- Et produktnavn eller kallenavn i katalogen (f.eks. et ølnavn eller varemerke) som ikke er produsentens juridiske navn, matchet mot en urelatert Brreg-enhet med lignende ord.
- En kandidat i en annen kommune/et annet postområde enn produsentens kjente sted, selv om navneordet stemmer.

Godkjenn KUN hvis navnet og adressen/stedet SAMLET gjør det plausibelt at dette er den SAMME reelle produsenten som "${providerName}" — ikke bare at ett ord er felles. Ved minste tvil, svar ${ORGNR_JUDGE_REJECT_TOKEN}.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${ORGNR_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${ORGNR_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${ORGNR_JUDGE_REJECT_TOKEN}.`;

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
    return { approved: false, reason: "nettverksfeil under dommer-kall — avvist fail-closed" }; // never fabricate
  }

  if (!response.ok) {
    return { approved: false, reason: `dommer-API svarte status ${response.status} — avvist fail-closed` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { approved: false, reason: "ikke-parsbar JSON fra dommer-API — avvist fail-closed" };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { approved: false, reason: "uventet svarformat fra dommer-API — avvist fail-closed" };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reason = lines.slice(1).join(" ").trim();

  // Only the EXACT approve token approves. Anything else is a reject.
  // Fail-closed on any ambiguity, never a silent approval.
  if (verdictToken === ORGNR_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reason: reason || "godkjent av LLM-dommer" };
  }
  if (verdictToken === ORGNR_JUDGE_REJECT_TOKEN) {
    return { approved: false, reason: reason || "avvist av LLM-dommer" };
  }
  return { approved: false, reason: "uventet/tvetydig dommersvar — avvist fail-closed" };
}
