/**
 * contact-candidate-judge.ts — dev-request 2026-08-19-kursjustering-
 * drikkefunnel-llm-og-supply, "Grep 5b" (byggspec in that file): the SHARED
 * LLM-judge + deterministic-backstop gate for every contact-field writer
 * that was NOT covered by lokal#655 (dev-request 2026-08-19-rfb-kontakt-
 * llm-dommer). #655 built this exact pattern once, scoped to ONE write path
 * (`POST /admin/homepage-provenance-batch`, src/routes/marketplace.ts):
 *   classifyRfbContactCandidateDefect() -> judgeRfbContactCandidate() ->
 *   gateRfbContactCandidates().
 * Grep 5b's job is to extend that same PATTERN to four more write sites
 * (the gårdssalg layer's two choke points, RFB contact-extraction, RFB
 * Brreg backfill) WITHOUT pasting the prompt/fail-closed contract four
 * times over. This module is that one shared place — mirrors marketplace.
 * ts's contract field-for-field (same fail-closed rules, same model, same
 * "cheap backstop first, then the LLM" cost-control ordering), generalised
 * to THREE candidate field types instead of two (`address` is new — the RFB
 * Brreg-backfill route writes address+phone, not phone+email).
 *
 * Deliberately NOT re-exported from / re-exported into marketplace.ts: that
 * file's own classifyRfbContactCandidateDefect/judgeRfbContactCandidate/
 * gateRfbContactCandidates are already shipped, reviewed, and covered by
 * marketplace-rfb-contact-judge.test.ts's 849-line W34 repro suite — left
 * completely untouched here to avoid re-risking already-verified code for
 * zero behavioural gain. This module is a SEPARATE, independent
 * implementation of the same contract, placed in services/ (not routes/) so
 * every one of its four call sites — src/services/experience-store.ts,
 * src/routes/opplevelser.ts, src/routes/admin-rfb-contact-extraction.ts,
 * src/routes/admin-agents.ts — can import it without creating a
 * services-depend-on-routes cycle (marketplace.ts, a routes/ file, imports
 * FROM services/ already; nothing in services/ imports from routes/, and
 * this file preserves that direction).
 *
 * Fail-closed contract (identical to judgeRfbContactCandidate): missing
 * ANTHROPIC_API_KEY, a network failure, a non-200 response, unparseable
 * JSON, or any model output that isn't the EXACT approve token on its own
 * first line -> rejected. Never throws. The composed gate
 * (gateContactCandidates) treats a rejected candidate for a given field
 * EXACTLY like "no candidate was found" for that field — callers write
 * `null`, never a partially-trusted value.
 *
 * dev-request 2026-08-22-rfbweb-about-guard: a FOURTH field type, `website`,
 * added on top of Grep 5b's three (phone/email/address) — two write paths
 * (admin-agents-url-write.ts's `agents.url`, admin-knowledge.ts's
 * `agent_knowledge.website`) had NO extraction guard at all. Only
 * `classifyContactCandidateDefect`'s deterministic backstop is extended for
 * `website` and wired into those two routes — `judgeContactCandidate`
 * already accepts `fieldType: "website"` generically (no code change needed
 * there) and its prompt is taught the website-specific junk classes below,
 * but NEITHER of the two wired-in routes calls it: neither has the raw
 * source-page text a meaningful judgment needs (see those routes' own
 * comments for why). `gateContactCandidates`'s 3-field batch shape is
 * deliberately NOT extended to a 4th slot — both website write sites judge
 * exactly one field per call, never phone+email+address+website together,
 * so composing it into that particular batch shape would just be unused
 * surface. A future call site that DOES have real source-page text can call
 * `judgeContactCandidate({ fieldType: "website", ... })` directly.
 */

export type ContactFieldType = "phone" | "email" | "address" | "website";

export interface ContactCandidateDefectVerdict {
  defective: boolean;
  reason?: string;
}

/** Junk mailbox-filename local parts — same set as marketplace.ts's
 *  RFB_CONTACT_FAVICON_LOCAL_PARTS (W34, LOKAL Matkvartalet Hamar:
 *  "favicon@2x.png" extracted and written as though it were an email). */
const CONTACT_JUDGE_FAVICON_LOCAL_PARTS = new Set([
  "favicon", "favicon@2x", "apple-touch-icon", "apple-touch-icon-precomposed",
]);

/** Same set as marketplace.ts's EMAIL_ICON_EXTENSIONS — icon/image file
 *  extensions that satisfy a bare "2+ letters" TLD-shape check but are
 *  never a real email domain. Reused below for the WEBSITE field type's
 *  favicon-path check (same file-extension shape, applied to a URL path's
 *  final segment instead of an email domain's TLD). */
const CONTACT_JUDGE_EMAIL_ICON_EXTENSIONS = new Set([
  "png", "ico", "jpg", "jpeg", "svg", "gif", "webp", "bmp",
]);

/** dev-request 2026-08-22-rfbweb-about-guard: website-candidate junk shapes,
 *  adapted from the SAME W34 defect classes marketplace.ts's judge already
 *  teaches for phone/email (CSS-hex-color, favicon filename, App-ID
 *  substring) — mirrored here as a raw-URL-shape backstop instead of a
 *  domain-embedded-in-email shape, since `agents.url` /
 *  `agent_knowledge.website` take a whole candidate URL, not a bare domain. */

/** Bare CSS hex-color value, e.g. "#3a7d44" or "#fff". */
const WEBSITE_JUDGE_CSS_HEX_RE = /^#[0-9a-f]{3,8}$/i;
/** A Tailwind arbitrary-value class carrying a hex color, e.g.
 *  ".bg-[#79656569]" — the exact W34 shape marketplace.ts's own prompt
 *  teaches for the phone field, here misread as a URL instead of a phone
 *  number. */
const WEBSITE_JUDGE_TAILWIND_HEX_RE = /\[#[0-9a-f]{3,8}\]/i;
/** Same basenames as CONTACT_JUDGE_FAVICON_LOCAL_PARTS, reused for a URL
 *  PATH's final segment (e.g. ".../favicon.ico") instead of an email
 *  local-part. */
const WEBSITE_JUDGE_ICON_BASENAMES = CONTACT_JUDGE_FAVICON_LOCAL_PARTS;
/** App Store / Play Store listing hosts — a real, live, dotted host, so
 *  neither the missing-scheme nor the no-dot-in-host structural checks
 *  below can catch it, but never the producer's OWN homepage: it's a
 *  store's listing PAGE for their app, the "App-ID-shaped junk" class the
 *  spec calls out, adapted from a numeric App-ID substring to the host that
 *  actually carries one in a real candidate URL. */
const WEBSITE_JUDGE_APP_STORE_HOSTS = new Set([
  "apps.apple.com", "itunes.apple.com", "play.google.com",
]);

/** Registrable-ish host of a candidate website URL, lowercased, `www.`
 *  stripped, URL userinfo (`user:pass@`) discarded — same shape as
 *  admin-agents-url-write.ts's own hostOf(), reimplemented locally (not
 *  imported) so this services/ module never depends on a routes/ file, per
 *  this file's own documented layering rule (see the module header
 *  comment). "" when unparseable. */
function websiteCandidateHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  if (!m) return "";
  const authority = m[1];
  const at = authority.lastIndexOf("@");
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  return hostPart.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

/** The final path segment of a candidate URL (after the host, before any
 *  query/fragment), e.g. "https://gard.no/img/favicon.ico" -> "favicon.ico".
 *  "" when the URL has no path or is unparseable. */
function websiteCandidateLastPathSegment(url: string): string {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url.trim());
  const rawPath = m?.[1] ?? "";
  return rawPath.split("/").filter(Boolean).pop() ?? "";
}

/** True if `digits` contains a run of the same character repeated `minRun`
 *  or more times in a row — mirrors marketplace.ts's
 *  hasLongRepeatedDigitRun (same placeholder-shaped signal, same
 *  reachability rationale: every phone extractor in this codebase
 *  — extractGardssalgContactPhone, fetchBrregContact's telefon/mobil —
 *  ultimately hands this a digits-only string). */
function hasLongRepeatedDigitRun(digits: string, minRun: number): boolean {
  let run = 1;
  for (let i = 1; i < digits.length; i++) {
    run = digits[i] === digits[i - 1] ? run + 1 : 1;
    if (run >= minRun) return true;
  }
  return false;
}

/** True if `digits` is a strictly sequential ascending or descending run
 *  (e.g. "23456789") — mirrors marketplace.ts's isSequentialDigitRun. */
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

/**
 * classifyContactCandidateDefect — this module's deterministic backstop.
 * Fulfils Grep 5b's "new gårdssalg backstop classifier" requirement (spec:
 * "IKKE samme funksjon som classifyGardssalgFieldDefect()" —
 * src/services/gardssalg-quality-update.ts's classifier only ever covered
 * about_text/visit_text/opening_hours_text, per its own
 * GardssalgQualityFieldName type; contact fields need a genuinely different
 * classifier, which this is). Mirrors classifyRfbContactCandidateDefect's
 * checks exactly:
 *   - phone: a pure-digit candidate is flagged for a long repeated-digit
 *     run or a strictly sequential run (placeholder-shaped, not a
 *     plausible Norwegian phone number). A formatted/non-digit-only
 *     candidate is left entirely to the LLM judge, same as upstream.
 *   - email: favicon/icon-filename local parts and icon-extension "TLDs"
 *     are flagged; basic "does this even parse as an email" structural
 *     checks besides.
 *   - address: no independent structural signal exists for a free-text
 *     Norwegian street address the way there is for phone/email (no
 *     digit-run or filename-extension shape to check) — this is honestly
 *     a no-op here (`{ defective: false }` always) and detection is left
 *     entirely to the LLM judge, exactly as classifyRfbContactCandidateDefect
 *     already does for the phone-side CSS-hex-color/Facebook-App-ID shapes
 *     it cannot reach (see that function's own file-header comment in
 *     marketplace.ts) — a single-line-of-defense-by-design gap, not
 *     silently implied to be double-covered.
 */
export function classifyContactCandidateDefect(
  fieldType: ContactFieldType,
  candidate: string
): ContactCandidateDefectVerdict {
  const trimmed = (candidate ?? "").trim();
  if (!trimmed) return { defective: false };

  if (fieldType === "phone") {
    if (/^\d+$/.test(trimmed)) {
      if (hasLongRepeatedDigitRun(trimmed, 6)) {
        return { defective: true, reason: "candidate contains a long run of the same repeated digit (placeholder-shaped), not a plausible Norwegian phone number" };
      }
      if (isSequentialDigitRun(trimmed)) {
        return { defective: true, reason: "candidate is a sequential ascending/descending digit run (placeholder-shaped), not a plausible Norwegian phone number" };
      }
    }
    return { defective: false };
  }

  if (fieldType === "address") {
    // No independent structural backstop for free-text addresses — see the
    // doc comment above. The LLM judge is the sole line of defense here.
    return { defective: false };
  }

  if (fieldType === "website") {
    // CSS hex-color / Tailwind arbitrary-value class shape, e.g. "#3a7d44"
    // or ".bg-[#79656569]" — checked FIRST, on the raw candidate, before the
    // scheme check below (a bare hex/class string never has a scheme, but
    // giving it its own reason keeps the rejection honest about WHY, not
    // just "no scheme").
    if (WEBSITE_JUDGE_CSS_HEX_RE.test(trimmed) || WEBSITE_JUDGE_TAILWIND_HEX_RE.test(trimmed)) {
      return { defective: true, reason: "candidate is a CSS hex-color / Tailwind arbitrary-value string, not a URL" };
    }
    if (!/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) {
      return { defective: true, reason: "candidate does not parse as a URL (missing http(s) scheme, or contains whitespace)" };
    }
    const host = websiteCandidateHost(trimmed);
    if (!host || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
      return { defective: true, reason: "candidate does not parse as a URL with a real host (no domain TLD)" };
    }
    // Favicon/icon file path misread as the homepage itself — a real,
    // reachable host, but the candidate points at an icon asset, not a page.
    const lastSegment = websiteCandidateLastPathSegment(trimmed).toLowerCase();
    const dotIdx = lastSegment.lastIndexOf(".");
    if (dotIdx > 0) {
      const base = lastSegment.slice(0, dotIdx);
      const ext = lastSegment.slice(dotIdx + 1);
      if (WEBSITE_JUDGE_ICON_BASENAMES.has(base) && CONTACT_JUDGE_EMAIL_ICON_EXTENSIONS.has(ext)) {
        return { defective: true, reason: "candidate's path is a favicon/icon file, not a homepage URL" };
      }
    }
    // App Store / Play Store listing — a real, live, dotted host, never the
    // producer's own homepage.
    if (WEBSITE_JUDGE_APP_STORE_HOSTS.has(host)) {
      return { defective: true, reason: "candidate is an App Store / Play Store listing host, not the producer's own website" };
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
  if (CONTACT_JUDGE_FAVICON_LOCAL_PARTS.has(localPart)) {
    return { defective: true, reason: "candidate's local part is a favicon/icon filename, not a mailbox name" };
  }
  if (!domain.includes(".")) {
    return { defective: true, reason: "candidate does not parse as a real email address (no domain TLD)" };
  }
  const tld = domain.split(".").pop() ?? "";
  if (CONTACT_JUDGE_EMAIL_ICON_EXTENSIONS.has(tld)) {
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
// Same order of magnitude as marketplace.ts's
// RFB_CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP (4000) — caps the surrounding
// source context handed to the model, not the (short) candidate itself.
const CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP = 4000;

function fieldLabelFor(fieldType: ContactFieldType): string {
  if (fieldType === "phone") return "telefonnummer";
  if (fieldType === "address") return "adresse";
  if (fieldType === "website") return "nettside";
  return "e-postadresse";
}

/**
 * judgeContactCandidate — the shared LLM judge. Same fail-closed
 * fetch/parse contract as marketplace.ts's judgeRfbContactCandidate: direct
 * fetch to https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from
 * env, model claude-haiku-4-5. ANY doubt or failure resolves to REJECT;
 * never throws, never silently approves.
 */
export async function judgeContactCandidate(params: {
  fieldType: ContactFieldType;
  candidate: string;
  sourceContext: string;
  businessName: string;
}): Promise<ContactCandidateJudgeVerdict> {
  const { fieldType, candidate, sourceContext, businessName } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { approved: false, reason: "ANTHROPIC_API_KEY mangler — avvist fail-closed" };
  }

  const fieldLabel = fieldLabelFor(fieldType);
  const cappedContext = (sourceContext || "").slice(0, CONTACT_JUDGE_SOURCE_CONTEXT_CHAR_CAP);
  const prompt = `Du er en kvalitetsdommer for kontaktinformasjon på en norsk markedsplattform som kobler forbrukere direkte med lokale matprodusenter (gårdssalg/Rett fra Bonden). En automatisk tekstuttrekker (eller et strukturert registeroppslag) har funnet følgende KANDIDAT til ${fieldLabel} for produsenten "${businessName}".

Kandidat (${fieldLabel}): ${candidate}

Kildekontekst (der kandidaten ble funnet):
${cappedContext}

Automatisk tekstuttrekk fra nettsider har GJENTATTE GANGER feilaktig plukket opp følgende som om de var ekte kontaktinformasjon — vær spesielt oppmerksom på disse kjente feilkildene:
- En CSS-fargekode (hex-farge, f.eks. "#3a7d44" eller en Tailwind arbitrary-value-klasse som ".bg-[#79656569]") tolket som telefonnummer.
- En Facebook App ID eller annen lang numerisk sporings-/konfigurasjons-ID fra JavaScript-kode (f.eks. et "facebookAppId"/"fbAppId"/"fb-app-id"-felt) tolket som telefonnummer.
- Et favicon- eller ikon-filnavn (f.eks. "favicon@2x.png", "apple-touch-icon.png") tolket som e-postadresse fordi filnavnet inneholder "@".
- Annen generisk sidestøy: versjonsnumre, produkt-SKUer, datoer, postnumre, org-numre, eller andre tall-/tekststrenger som tilfeldigvis matcher formatet til ${fieldLabel}, men ikke faktisk ER kontaktinformasjon for DENNE produsenten.
- For adresser spesielt: en tredjeparts/paraplyorganisasjons adresse (f.eks. en bransjeforening eller et markedslag) feilaktig tilskrevet denne ENKELTPRODUSENTEN, eller en generisk plattform-/malbedrift-adresse.
- For nettsider spesielt: en favicon- eller ikon-filsti (f.eks. "https://gard.no/favicon.ico") tolket som selve hjemmesiden, eller en App Store-/Play Store-oppføring (f.eks. "apps.apple.com"/"play.google.com") tolket som produsentens EGEN nettside når det bare er butikkoppføringen for appen deres, ikke produsentens eget nettsted.

Godkjenn KUN hvis kandidaten er en plausibel, ekte, SPESIFIKK ${fieldLabel} for akkurat DENNE produsenten, gitt kildekonteksten. Ved minste tvil om at dette faktisk er ekte kontaktinformasjon — eller om det heller ser ut som en av feilkildene over — svar ${CONTACT_JUDGE_REJECT_TOKEN}.

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
    let bodySnippet = "";
    try {
      bodySnippet = (await response.text()).slice(0, 300);
    } catch {
      bodySnippet = "(kunne ikke lese respons-body)";
    }
    console.error(`[judgeContactCandidate] non-ok response: status=${response.status} body=${bodySnippet}`);
    return {
      approved: false,
      reason: `dommer-API svarte status ${response.status} — avvist fail-closed — ${bodySnippet}`,
    };
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
  if (verdictToken === CONTACT_JUDGE_APPROVE_TOKEN) {
    return { approved: true, reason: reason || "godkjent av LLM-dommer" };
  }
  if (verdictToken === CONTACT_JUDGE_REJECT_TOKEN) {
    return { approved: false, reason: reason || "avvist av LLM-dommer" };
  }
  return { approved: false, reason: "uventet/tvetydig dommersvar — avvist fail-closed" };
}

export interface ContactCandidateGateResult {
  phone: string | null;
  email: string | null;
  address: string | null;
  phoneRejectedReason?: string;
  emailRejectedReason?: string;
  addressRejectedReason?: string;
}

/**
 * gateContactCandidates — the single composed entry point every Grep 5b
 * call site uses. A candidate must pass BOTH classifyContactCandidateDefect
 * (cheap, checked first for cost control — same ordering as
 * gateRfbContactCandidates in marketplace.ts) AND judgeContactCandidate to
 * survive; either rejecting is reported back exactly like "no candidate
 * found" (null), never a partially-trusted value. All three fields are
 * optional and gated independently/concurrently — a call site only passes
 * the field(s) it actually has a candidate for (gårdssalg: phone+email;
 * RFB contact-extraction: email only; RFB Brreg-backfill: phone+address).
 */
export async function gateContactCandidates(params: {
  businessName: string;
  sourceContext: string;
  candidatePhone?: string | null;
  candidateEmail?: string | null;
  candidateAddress?: string | null;
}): Promise<ContactCandidateGateResult> {
  const { businessName, sourceContext, candidatePhone, candidateEmail, candidateAddress } = params;
  const result: ContactCandidateGateResult = { phone: null, email: null, address: null };

  async function gateOne(
    fieldType: ContactFieldType,
    candidate: string | null | undefined
  ): Promise<{ value: string | null; rejectedReason?: string }> {
    if (!candidate) return { value: null };
    const defect = classifyContactCandidateDefect(fieldType, candidate);
    if (defect.defective) {
      return { value: null, rejectedReason: `backstop classifier: ${defect.reason ?? "flagged defective"}` };
    }
    const verdict = await judgeContactCandidate({
      fieldType,
      candidate,
      sourceContext,
      businessName,
    });
    if (!verdict.approved) {
      return { value: null, rejectedReason: `LLM judge: ${verdict.reason ?? "avvist"}` };
    }
    return { value: candidate };
  }

  const [phoneOutcome, emailOutcome, addressOutcome] = await Promise.all([
    gateOne("phone", candidatePhone),
    gateOne("email", candidateEmail),
    gateOne("address", candidateAddress),
  ]);
  result.phone = phoneOutcome.value;
  if (phoneOutcome.rejectedReason) result.phoneRejectedReason = phoneOutcome.rejectedReason;
  result.email = emailOutcome.value;
  if (emailOutcome.rejectedReason) result.emailRejectedReason = emailOutcome.rejectedReason;
  result.address = addressOutcome.value;
  if (addressOutcome.rejectedReason) result.addressRejectedReason = addressOutcome.rejectedReason;

  return result;
}
