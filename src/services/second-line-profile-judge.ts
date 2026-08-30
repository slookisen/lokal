/**
 * second-line-profile-judge.ts — dev-request 2026-08-23-rfb-andrelinje-
 * verifisering-lav-terskel (Fase-1, item 1.2): the whole-profile LLM judge
 * for RFB's NEW "second verification line" — the lower-bar path that is
 * only ever attempted for a producer whose FIRST line (computeKvalitetsGate
 * in lokal-agent-verifier.ts) already failed (no live website, most
 * commonly). Unlike src/services/contact-candidate-judge.ts's
 * judgeContactCandidate — which judges ONE candidate FIELD (a phone/email/
 * address/website string) against nearby source text — this judge looks at
 * the WHOLE producer profile (name, about text, products, the email under
 * consideration, and which corroborating source(s) fired) and does explicit
 * IDENTITY reasoning: does the assembled evidence actually identify THIS
 * SPECIFIC producer — not a generic description, not a different business
 * that merely shares a name stem, and not the umbrella/trade organization
 * a producer happens to be a member of? See lokal-agent-verifier.ts's
 * `computeSecondLineVerification` for the deterministic gates (NACE/Brreg
 * reuse, junk-email backstop, ≥1 accepted corroborating source) this judge
 * sits behind — this file is the LAST line, not the only one.
 *
 * Fail-closed contract — IDENTICAL to judgeContactCandidate's (see that
 * file's own header comment): missing ANTHROPIC_API_KEY, a network
 * failure, a non-200 response, unparseable JSON, or any model output that
 * isn't the EXACT approve token on its own first line -> rejected ("does
 * not pass second line"). Never throws. Never silently defaults to pass —
 * every early-return in this file is a rejection, and the one and only
 * approval path requires the model to have echoed the approve token
 * verbatim.
 *
 * Deliberately a SEPARATE module from contact-candidate-judge.ts rather
 * than an extra `fieldType` on judgeContactCandidate: that function's
 * entire contract (prompt, field label, defect classes taught) is about a
 * single SHORT candidate value plus nearby source text; this judge takes a
 * whole multi-field profile and reasons about entity identity, which is a
 * different task shape. It DOES reuse contact-candidate-judge.ts's
 * deterministic junk-email backstop directly (classifyContactCandidateDefect
 * with fieldType "email") from the caller side (lokal-agent-verifier.ts)
 * rather than re-deriving favicon-local-part / icon-extension detection
 * here — see this module's own callers for that wiring.
 */

export interface SecondLineProfileJudgeVerdict {
  approved: boolean;
  reason?: string;
}

const SECOND_LINE_JUDGE_APPROVE_TOKEN = "GODKJENN";
const SECOND_LINE_JUDGE_REJECT_TOKEN = "AVVIS";
// Same order of magnitude as contact-candidate-judge.ts's
// CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP — caps the about-text handed to the
// model, not the whole prompt.
const SECOND_LINE_JUDGE_ABOUT_CHAR_CAP = 4000;
const SECOND_LINE_JUDGE_PRODUCTS_CHAR_CAP = 1000;
// Del D (dev-request 2026-08-29-gs-second-line-kildeklasse-bredde): caps for
// the OPTIONAL caller-fetched evidence block below. This module still never
// fetches anything itself — evidence, when present, was already fetched by
// the caller (see this file's header comment) and is only rendered here.
const SECOND_LINE_JUDGE_EVIDENCE_MAX_ITEMS = 5;
const SECOND_LINE_JUDGE_EVIDENCE_EXCERPT_CHAR_CAP = 2000;

/** Human-readable Norwegian label for each accepted-source key
 *  computeSecondLineIdentitySources (lokal-agent-verifier.ts) can produce —
 *  used only to make the prompt legible, not for any matching logic. */
function sourceLabelsFor(sources: readonly string[]): string {
  const labels: Record<string, string> = {
    own_website: "produsentens egen nettside svarer (live)",
    facebook_official_page: "en offisiell Facebook-side registrert for produsenten",
    hanen_no: "en oppføring på hanen.no",
    bondensmarked_no: "en oppføring på bondensmarked.no",
    "1881_no": "en oppføring på 1881.no",
    siderklynga_no: "en oppføring på siderklynga.no",
    brreg_name_match: "et navnetreff mot Brønnøysundregistrene (Brreg)",
  };
  if (sources.length === 0) return "(ingen — skal ikke skje, dommeren kalles aldri uten minst én kilde)";
  return sources.map((s) => labels[s] ?? s).join("; ");
}

function stringifyProducts(products: unknown[]): string {
  if (!Array.isArray(products) || products.length === 0) return "(ingen produkter registrert)";
  const parts = products.map((p) => {
    if (typeof p === "string") return p;
    if (p && typeof p === "object" && "name" in (p as Record<string, unknown>)) {
      const n = (p as Record<string, unknown>).name;
      if (typeof n === "string") return n;
    }
    try {
      return JSON.stringify(p);
    } catch {
      return String(p);
    }
  });
  return parts.join(", ").slice(0, SECOND_LINE_JUDGE_PRODUCTS_CHAR_CAP);
}

/** Renders the (optional) caller-fetched evidence block for the prompt — at
 *  most SECOND_LINE_JUDGE_EVIDENCE_MAX_ITEMS items, each excerpt trimmed and
 *  capped at SECOND_LINE_JUDGE_EVIDENCE_EXCERPT_CHAR_CAP chars. Missing/empty
 *  evidence renders an explicit "nothing was fetched" fallback line rather
 *  than an empty block, so the prompt never silently implies content was
 *  checked when none was supplied — this is what keeps the no-evidence path
 *  byte-identical to today's behavior. */
function evidenceTextFor(evidence?: readonly { source_url: string; content_excerpt: string }[]): string {
  if (!evidence || evidence.length === 0) {
    return "(ingen fremlagt kildetekst — kun kildeklassen over er kjent)";
  }
  return evidence
    .slice(0, SECOND_LINE_JUDGE_EVIDENCE_MAX_ITEMS)
    .map((e) => {
      const excerpt = (e.content_excerpt || "").trim().slice(0, SECOND_LINE_JUDGE_EVIDENCE_EXCERPT_CHAR_CAP);
      return `- ${e.source_url}: "${excerpt}"`;
    })
    .join("\n");
}

/**
 * judgeSecondLineProfile — the whole-profile LLM judge behind RFB's second
 * verification line. Direct fetch to https://api.anthropic.com/v1/messages,
 * ANTHROPIC_API_KEY from env, model claude-haiku-4-5 — same call shape as
 * judgeContactCandidate. ANY doubt or failure resolves to "does not pass
 * second line"; never throws, never silently approves.
 */
export async function judgeSecondLineProfile(params: {
  businessName: string;
  city: string | null;
  about: string | null;
  products: unknown[];
  email: string;
  acceptedSources: readonly string[];
  brregName?: string | null;
  evidence?: readonly { source_url: string; content_excerpt: string }[];
}): Promise<SecondLineProfileJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reason: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const aboutCapped = (params.about || "").trim().slice(0, SECOND_LINE_JUDGE_ABOUT_CHAR_CAP);
  const productsText = stringifyProducts(params.products);
  const sourceText = sourceLabelsFor(params.acceptedSources);
  const evidenceText = evidenceTextFor(params.evidence);

  const prompt = `Du er en identitetsdommer for en norsk markedsplattform som kobler forbrukere direkte med lokale matprodusenter (Rett fra Bonden). Denne produsenten besto IKKE plattformens ordinære (førstelinje) verifisering — vanligvis fordi produsenten ikke har en egen, fungerende nettside — og vurderes nå for en LAVERE terskel ("andrelinje") som krever at du BEKREFTER at bevisene faktisk identifiserer DENNE SPESIFIKKE produsenten, ikke en generisk beskrivelse og ikke en annen virksomhet.

Produsentnavn (registrert på plattformen): ${params.businessName}
By/sted (registrert): ${params.city || "(ukjent)"}
E-post under vurdering: ${params.email}
${params.brregName ? `Navn funnet i Brønnøysundregistrene (Brreg): ${params.brregName}\n` : ""}Om-tekst / beskrivelse:
${aboutCapped || "(ingen om-tekst registrert)"}

Produkter:
${productsText}

Korroborerende kilde(r) som utløste denne vurderingen: ${sourceText}

Fremlagt kildeinnhold (hentet av kalleren fra kilden(e) over, til direkte kontroll):
${evidenceText}

Godkjenn KUN hvis ALT av følgende stemmer:
1. Om-teksten/produktene beskriver en KONKRET, spesifikk matprodusent (gård, bryggeri, ysteri, etc.) — ikke en generisk bransjebeskrivelse, en paraplyorganisasjon/bransjeforening sine mange medlemmer omtalt samlet, eller en helt annen type virksomhet.
2. Bevisene knytter navnet TYDELIG til produsentnavnet og/eller stedet ovenfor — enten navn+sted (byen/stedet stemmer med det som er beskrevet) eller navn+organisasjonsnummer (Brreg-treffet gjelder faktisk denne virksomheten, ikke bare et likelydende navn).
3. E-postadressen fremstår som en rimelig kontaktadresse for AKKURAT denne produsenten (ikke åpenbart en helt annen virksomhets eller en paraplyorganisasjons adresse).
4. Det er ingen tegn til at bevisene faktisk beskriver en ANNEN produsent som tilfeldigvis har et lignende navn eller sted.
5. Dersom kildeinnhold er fremlagt over: vurder om DET innholdet faktisk nevner/støtter denne produsenten, stedet eller organisasjonsnummeret — ikke bare at kildeklassen i seg selv utløste vurderingen.

Ved minste tvil om identiteten — eller om bevisgrunnlaget er for tynt/generisk til å faktisk bekrefte at dette er DENNE produsenten — svar ${SECOND_LINE_JUDGE_REJECT_TOKEN}.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${SECOND_LINE_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${SECOND_LINE_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${SECOND_LINE_JUDGE_REJECT_TOKEN}.`;

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
    return { approved: false, reason: "nettverksfeil under dommer-kall — avvist fail-closed" };
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

  // Only the EXACT approve token approves. Anything else — including the
  // reject token, blank output, or an ambiguous/garbled first line — is a
  // rejection. Fail-closed on any ambiguity, never a silent approval.
  if (verdictToken === SECOND_LINE_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reason: reason || "godkjent av LLM-dommer" };
  }
  if (verdictToken === SECOND_LINE_JUDGE_REJECT_TOKEN) {
    return { approved: false, reason: reason || "avvist av LLM-dommer" };
  }
  return { approved: false, reason: "uventet/tvetydig dommersvar — avvist fail-closed" };
}
