/**
 * rfb-about-judge.ts — the RFB about/description quality judge
 * (judgeRfbAboutCandidate) and its infra-failure test (isRfbJudgeInfraFailure),
 * moved UNCHANGED from routes/admin-agents.ts (which re-exports both) by
 * dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring
 * (skive B): routes/admin-knowledge.ts's refreshHomepageContent now runs this
 * judge before writing a homepage about text, and admin-agents.ts imports
 * admin-knowledge.ts, so importing the judge from there would be circular.
 * The only addition is an optional abort signal (4th argument) so a
 * deadline-bounded caller can cut the call short; without it the call is
 * byte-identical to before (no timeout).
 */

export interface RfbJudgeVerdict {
  approved: boolean;
  reasoning: string;
}

const RFB_JUDGE_APPROVE_TOKEN = "GODKJENN";
const RFB_JUDGE_REJECT_TOKEN = "AVVIS";
const RFB_JUDGE_CANDIDATE_CHAR_CAP = 4000;
// Every fail-closed branch's reasoning below ends in this exact literal
// suffix — isRfbJudgeInfraFailure() (used by the retro-scan's null-vs-leave
// decision) tells a genuine AVVIS verdict (real model reasoning) apart from
// an infra failure by checking for it. Mirrors
// GARDSSALG_JUDGE_INFRA_FAILURE_SUFFIX exactly (routes/opplevelser.ts).
const RFB_JUDGE_INFRA_FAILURE_SUFFIX = "avvist fail-closed";

export async function judgeRfbAboutCandidate(
  candidateText: string,
  producerName: string,
  kind: "description" | "about",
  // Optional abort signal (refreshHomepageContent bounds the call by its
  // deadline). Absent = the exact original call, with no timeout.
  io?: { signal?: AbortSignal }
): Promise<RfbJudgeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reasoning: `ANTHROPIC_API_KEY mangler — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const sectionLabel =
    kind === "description"
      ? "kort produsentbeskrivelse"
      : "utfyllende «Om produsenten»-tekst";
  const cappedCandidate = (candidateText || "").slice(0, RFB_JUDGE_CANDIDATE_CHAR_CAP);
  const prompt = `Du er en kvalitetsdommer for produsentprofiler på Rett fra Bonden, en norsk markedsplattform som kobler forbrukere direkte med lokale matprodusenter. Vurder om kandidatteksten under er egnet til å publiseres som ${sectionLabel} for produsenten "${producerName}".

Kandidattekst:
${cappedCandidate}

Godkjenn KUN hvis teksten er:
- sammenhengende, ekte norsk prosa spesifikt om DENNE produsenten (ikke en paraplyorganisasjon/bransjeforening sine mange medlemmer omtalt samlet),
- fri for lekket navigasjonsmeny-, sidetopp- eller bunntekst-innhold (lenkelister, "hjem"/"kontakt"/"meny"-navigasjon, "skip to content"/"jump to ..."-lenker, cookie-/samtykketekst, "hopp til innhold" og lignende),
- fri for åpenbart oppstykket, avkuttet eller ødelagt tekst,
- faktisk informativ om produsenten, ikke bare en generisk floskel.

Vurder ikke lengde, ikke volum — vurder KUN om teksten fremhever DENNE produsentens særegne egenskaper (produkter, sted, driftsform, historie, utmerkelser): en kort tekst som konkret navngir slikt skal godkjennes selv om den er kort, mens en lang men trekk-løs/generisk tekst skal avvises selv om den er lang. Kort-men-spesifikk = godkjenn; trekk-løs/generisk = avvis, uansett lengde.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${RFB_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${RFB_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${RFB_JUDGE_REJECT_TOKEN}.`;

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
      ...(io?.signal ? { signal: io.signal } : {}),
    });
  } catch {
    return { approved: false, reasoning: `nettverksfeil under dommer-kall — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` }; // never fabricate
  }

  if (!response.ok) {
    return { approved: false, reasoning: `dommer-API svarte status ${response.status} — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { approved: false, reasoning: `ikke-parsbar JSON fra dommer-API — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    return { approved: false, reasoning: `uventet svarformat fra dommer-API — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
  }

  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const verdictToken = (lines[0] || "").toUpperCase();
  const reasoning = lines.slice(1).join(" ").trim();

  // Only the EXACT approve token approves. Anything else — the reject
  // token, an empty response, garbage, a token that merely CONTAINS the
  // approve word inside a longer sentence — is a reject. Fail-closed on any
  // ambiguity, never a silent approval.
  if (verdictToken === RFB_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reasoning: reasoning || "godkjent av LLM-dommer" };
  }
  if (verdictToken === RFB_JUDGE_REJECT_TOKEN) {
    return { approved: false, reasoning: reasoning || "avvist av LLM-dommer" };
  }
  return { approved: false, reasoning: `uventet/tvetydig dommersvar — ${RFB_JUDGE_INFRA_FAILURE_SUFFIX}` };
}

/**
 * True iff `verdict.reasoning` is one of judgeRfbAboutCandidate's own
 * fail-closed sentinel reasons (missing key / network / non-200 /
 * unparseable JSON / unexpected shape / ambiguous verdict) rather than a
 * genuine AVVIS verdict from the model. Used by the retro-scan below, which
 * — unlike every OTHER call site of this judge — must NOT treat an infra
 * failure the same as a real rejection: for a fresh CANDIDATE, "not
 * approved" safely means "don't publish it", but for the retro-scan, "not
 * approved" would otherwise mean "null out content that's already live" — a
 * destructive action an API outage must never trigger. Mirrors
 * isJudgeInfraFailure (routes/opplevelser.ts) exactly.
 */
export function isRfbJudgeInfraFailure(verdict: RfbJudgeVerdict): boolean {
  return verdict.reasoning.endsWith(RFB_JUDGE_INFRA_FAILURE_SUFFIX);
}
