/**
 * contact-candidate-judge.ts — dev-request 2026-08-19-rfb-kontakt-llm-dommer
 * follow-on ("Grep 5b"): extends PR #655's backstop-classifier + LLM-judge
 * gate (classifyRfbContactCandidateDefect / judgeRfbContactCandidate /
 * gateRfbContactCandidates, src/routes/marketplace.ts — built for RFB's
 * POST /admin/homepage-provenance-batch write path only) to the four other
 * phone/email/address write paths in this codebase that were never gated:
 * gårdssalg's shared contact choke point (applyGardssalgProviderContact,
 * services/experience-store.ts), gårdssalg's autosvar-redirect email path
 * (POST /admin/gardssalg-autosvar-apply, routes/opplevelser.ts), RFB's
 * homepage contact-extraction (POST /admin/rfb-contact-extraction,
 * routes/admin-rfb-contact-extraction.ts) and RFB's Brreg contact backfill
 * (POST /admin/agents/brreg-contact-backfill, routes/admin-agents.ts).
 *
 * ONE shared implementation, not five copies of the prompt/logic:
 * marketplace.ts's own functions are LEFT UNTOUCHED (still gate RFB's
 * homepage-provenance-batch exactly as PR #655 shipped it — a background/
 * already-shipped sibling, not re-implemented here) and every one of the
 * four NEW write paths above imports THIS module instead. Placed in
 * services/ (not routes/) so both a service (experience-store.ts) and
 * several route files (opplevelser.ts, admin-rfb-contact-extraction.ts,
 * admin-agents.ts) can import it without a route-file-importing-another-
 * route-file inversion — marketplace.ts is a route module, so gårdssalg's
 * service layer could never import from it without breaking this
 * codebase's existing import direction (services -> never import routes).
 *
 * Contract (identical to judgeRfbContactCandidate/
 * classifyRfbContactCandidateDefect): fail-closed, ALWAYS. Missing
 * ANTHROPIC_API_KEY, a network failure, a non-200 response, unparseable
 * JSON, or an ambiguous/unexpected verdict token all reject the candidate —
 * NEVER a thrown error, NEVER a fabricated approval on doubt. A rejected
 * candidate is treated by every caller exactly like the underlying
 * extractor/registry lookup having found nothing: nothing is written, and
 * the rejection reason is logged.
 *
 * `fieldType` adds `"address"` — needed only by admin-agents.ts's Brreg
 * address+phone backfill (no gårdssalg/RFB email/phone path ever passes
 * it). Honesty note (same discipline as marketplace.ts's own file-header
 * comment on classifyRfbContactCandidateDefect's phone-side gap): there is
 * no known STRUCTURAL defect shape for a free-text street address the way
 * there is for a CSS hex color / Facebook App ID / favicon filename
 * mistaken for a phone/email — so classifyContactCandidateDefect's address
 * branch is honestly a no-op (always `{ defective: false }`) and the LLM
 * judge is the ONLY line of defense for an address candidate. This is not a
 * silent gap: judgeContactCandidate still fails the WHOLE candidate closed
 * on any missing-key/network/parse/ambiguous-verdict failure, exactly as it
 * does for phone/email.
 */

export type ContactCandidateFieldType = "phone" | "email" | "address";

export interface ContactCandidateDefectVerdict {
  defective: boolean;
  reason?: string;
}

/** True if `digits` contains a run of the same character repeated `minRun`
 *  or more times in a row (e.g. "23222222" — six 2's). Mirrors
 *  marketplace.ts's hasLongRepeatedDigitRun exactly — a conservative
 *  placeholder-shaped signal on an all-digit phone candidate. */
function hasLongRepeatedDigitRun(digits: string, minRun: number): boolean {
  let run = 1;
  for (let i = 1; i < digits.length; i++) {
    run = digits[i] === digits[i - 1] ? run + 1 : 1;
    if (run >= minRun) return true;
  }
  return false;
}

/** True if `digits` is a strictly sequential ascending run (e.g. "23456789")
 *  or strictly sequential descending run (e.g. "98765432"). Mirrors
 *  marketplace.ts's isSequentialDigitRun exactly. */
function isSequentialDigitRun(digits: string): boolean {
  if (digits.length < 2) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    const prev = digits.charCodeAt(i - 1) - 48;
    const curr = digits.charCodeAt(i) - 48;
    if (curr !== prev + 1) ascending = false;
    if (curr !== prev - 1) descending = false;
  }
  return ascending || descending;
}

/** Known image/icon file extensions that show up as the final segment of a
 *  `<link rel="icon" href="favicon@2x.png">`-style filename — mirrors
 *  marketplace.ts's EMAIL_ICON_EXTENSIONS exactly (same W34 breach class:
 *  a bare-regex email fallback with a TLD-shape-only check accepts "png"/
 *  "ico"/etc. as if they were a real TLD). */
const EMAIL_ICON_EXTENSIONS = new Set([
  "png", "ico", "jpg", "jpeg", "svg", "gif", "webp", "bmp",
]);

/** Local parts that are unambiguously a favicon/icon filename, not a
 *  mailbox name — mirrors marketplace.ts's RFB_CONTACT_FAVICON_LOCAL_PARTS
 *  exactly (the "favicon@2x.png"/"apple-touch-icon.png" W34 shape). */
const CONTACT_FAVICON_LOCAL_PARTS = new Set([
  "favicon", "favicon@2x", "apple-touch-icon", "apple-touch-icon-precomposed",
]);

/**
 * Cheap, free, deterministic backstop classifier — run FIRST (cost control),
 * before the LLM judge below. Catches structurally-obvious junk: a
 * partial-or-full repeated-digit run or a sequential digit run on a
 * phone candidate; a favicon-filename local part, an icon-extension
 * "domain", or an unparseable shape on an email candidate. Deliberately
 * conservative — NEVER flags a value that could plausibly be real; the LLM
 * judge (which sees the candidate together with its page/source context) is
 * the primary line of defense, this is only a backstop. `address` is
 * intentionally always `{ defective: false }` — see this file's header
 * "Honesty note".
 */
export function classifyContactCandidateDefect(
  fieldType: ContactCandidateFieldType,
  candidate: string,
): ContactCandidateDefectVerdict {
  const trimmed = (candidate ?? "").trim();
  if (!trimmed) return { defective: false };

  if (fieldType === "address") return { defective: false };

  if (fieldType === "phone") {
    // Only pure-digit candidates are in scope for these two checks — a
    // formatted value like "+47 400 12 345" is left entirely to the LLM
    // judge, same as marketplace.ts's own classifier.
    if (/^\d+$/.test(trimmed)) {
      if (hasLongRepeatedDigitRun(trimmed, 6)) {
        return { defective: true, reason: "candidate contains a long run of the same repeated digit (placeholder-shaped), not a plausible phone number" };
      }
      if (isSequentialDigitRun(trimmed)) {
        return { defective: true, reason: "candidate is a sequential ascending/descending digit run (placeholder-shaped), not a plausible phone number" };
      }
    }
    return { defective: false };
  }

  // fieldType === "email"
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) {
    return { defective: true, reason: "candidate does not parse as a real email address (missing/misplaced '@')" };
  }
  const localPart = trimmed.slice(0, atIdx).toLowerCase();
  const domain = trimmed.slice(atIdx + 1).toLowerCase();
  if (CONTACT_FAVICON_LOCAL_PARTS.has(localPart)) {
    return { defective: true, reason: "candidate's local part is a favicon/icon filename, not a mailbox name" };
  }
  if (!domain.includes(".")) {
    return { defective: true, reason: "candidate does not parse as a real email address (no domain TLD)" };
  }
  const tld = domain.split(".").pop() ?? "";
  if (EMAIL_ICON_EXTENSIONS.has(tld)) {
    return { defective: true, reason: "candidate's domain ends in an image/icon file extension (e.g. .png/.ico) — looks like a favicon filename, not an email" };
  }
  if (!/^[a-z0-9._%+-]+$/i.test(localPart) || !/^[a-z0-9.-]+$/i.test(domain)) {
    return { defective: true, reason: "candidate does not parse as a real email address" };
  }
  return { defective: false };
}

export interface ContactCandidateJudgeVerdict {
  approved: boolean;
  reason?: string;
}

const CONTACT_JUDGE_APPROVE_TOKEN = "GODKJENN";
const CONTACT_JUDGE_REJECT_TOKEN = "AVVIS";
// Same order of magnitude as marketplace.ts's RFB_CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP
// (4000) and RFB_JUDGE_CANDIDATE_CHAR_CAP (admin-agents.ts) — bounds the
// surrounding source-context text handed to the prompt, not the candidate
// itself (a short phone/email/address string).
const CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP = 4000;

function contactFieldLabel(fieldType: ContactCandidateFieldType): string {
  if (fieldType === "phone") return "telefonnummer";
  if (fieldType === "email") return "e-postadresse";
  return "adresse";
}

/**
 * Fail-closed LLM judge — mirrors judgeRfbContactCandidate's (marketplace.ts)
 * EXACT sentinel/fail-closed contract: direct fetch to
 * https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
 * claude-haiku-4-5. ANY doubt or failure — missing key, network failure,
 * non-200, unparseable JSON, a response that isn't the exact expected
 * verdict token — resolves to REJECT. Never throws, never silently
 * approves.
 */
export async function judgeContactCandidate(params: {
  fieldType: ContactCandidateFieldType;
  candidate: string;
  sourceContext: string;
  businessName: string;
}): Promise<ContactCandidateJudgeVerdict> {
  const { fieldType, candidate, sourceContext, businessName } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reason: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const fieldLabel = contactFieldLabel(fieldType);
  const cappedContext = (sourceContext || "").slice(0, CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP);
  const knownBadPatterns =
    fieldType === "address"
      ? `- En generisk plassholdertekst, forkortelse eller uttrykk (f.eks. "N/A", "Ukjent", firmanavnet gjentatt, eller kun et postnummer) tolket som gateadresse.
- En adresse som åpenbart tilhører en helt annen virksomhet/organisasjon enn "${businessName}" (f.eks. hentet fra en feil kilde-post).`
      : `- En CSS-fargekode (hex-farge, f.eks. "#3a7d44" eller en Tailwind arbitrary-value-klasse som ".bg-[#79656569]") tolket som telefonnummer.
- En Facebook App ID eller annen lang numerisk sporings-/konfigurasjons-ID fra JavaScript-kode (f.eks. et "facebookAppId"/"fbAppId"/"fb-app-id"-felt) tolket som telefonnummer.
- Et favicon- eller ikon-filnavn (f.eks. "favicon@2x.png", "apple-touch-icon.png") tolket som e-postadresse fordi filnavnet inneholder "@".
- Annen generisk sidestøy: versjonsnumre, produkt-SKUer, datoer, postnumre, org-numre, eller andre tall-/tekststrenger som tilfeldigvis matcher formatet til ${fieldLabel}, men ikke faktisk ER kontaktinformasjon for DENNE virksomheten.`;

  const prompt = `Du er en kvalitetsdommer for kontaktinformasjon. En automatisk uttrekker har funnet følgende KANDIDAT til ${fieldLabel} for virksomheten/tilbyderen "${businessName}".

Kandidat (${fieldLabel}): ${candidate}

Kildekontekst (tekst kandidaten ble funnet i/ved):
${cappedContext}

Automatisk tekstuttrekk har GJENTATTE GANGER feilaktig plukket opp følgende som om det var ekte kontaktinformasjon — vær spesielt oppmerksom på disse kjente feilkildene:
${knownBadPatterns}

Godkjenn KUN hvis kandidaten er en plausibel, ekte, SPESIFIKK ${fieldLabel} for akkurat DENNE virksomheten, gitt kildekonteksten. Ved minste tvil om at dette faktisk er ekte kontaktinformasjon — eller om det heller ser ut som en av feilkildene over — svar ${CONTACT_JUDGE_REJECT_TOKEN}.

Svar med EKSAKT ett av disse to ordene alene på første linje, etterfulgt av en kort norsk begrunnelse på én setning på neste linje:
${CONTACT_JUDGE_APPROVE_TOKEN}
<kort begrunnelse>

eller

${CONTACT_JUDGE_REJECT_TOKEN}
<kort begrunnelse>

Ved minste tvil, svar ${CONTACT_JUDGE_REJECT_TOKEN}.`;

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

  // Only the EXACT approve token approves. Anything else — the reject
  // token, an empty response, garbage, a token that merely CONTAINS the
  // approve word inside a longer sentence — is a reject. Fail-closed on any
  // ambiguity, never a silent approval.
  if (verdictToken === CONTACT_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reason: reason || "godkjent av LLM-dommer" };
  }
  if (verdictToken === CONTACT_JUDGE_REJECT_TOKEN) {
    return { approved: false, reason: reason || "avvist av LLM-dommer" };
  }
  return { approved: false, reason: "uventet/tvetydig dommersvar — avvist fail-closed" };
}

export interface ContactCandidateGateResult {
  /** The candidate, unchanged, if it cleared BOTH the backstop classifier
   *  AND the LLM judge — otherwise `null`, treated exactly like the
   *  underlying extractor/registry lookup having found nothing. */
  value: string | null;
  rejectedReason?: string;
}

/**
 * Single-field composition: a candidate must pass BOTH
 * classifyContactCandidateDefect (cheap, checked first — cost control, same
 * "cheap filter before the LLM call" posture as marketplace.ts's
 * gateRfbContactCandidates) AND judgeContactCandidate (the LLM judge, given
 * the candidate's own source context) to survive. Either rejecting reports
 * `value: null` — the caller never sees a partially-trusted value. Each of
 * this module's four call sites gates one field at a time (unlike
 * marketplace.ts's gateRfbContactCandidates, which always composes phone+
 * email together for its one call site) since the four write paths here
 * gate different field combinations (email+phone, email-only, address+
 * phone) — a caller needing more than one field calls this once per field,
 * in parallel via Promise.all, exactly as every caller in this codebase
 * does.
 */
export async function gateContactCandidate(params: {
  fieldType: ContactCandidateFieldType;
  candidate: string;
  sourceContext: string;
  businessName: string;
}): Promise<ContactCandidateGateResult> {
  const { fieldType, candidate, sourceContext, businessName } = params;
  const defect = classifyContactCandidateDefect(fieldType, candidate);
  if (defect.defective) {
    return { value: null, rejectedReason: `backstop classifier: ${defect.reason ?? "flagged defective"}` };
  }
  const verdict = await judgeContactCandidate({ fieldType, candidate, sourceContext, businessName });
  if (!verdict.approved) {
    return { value: null, rejectedReason: `LLM judge: ${verdict.reason ?? "avvist"}` };
  }
  return { value: candidate };
}
