// ─── Gårdssalg product-name extractor (LLM, source-grounded) ────────────────
//
// Moved verbatim from routes/opplevelser.ts (dev-request 2026-10-15-rfb-
// generiske-produktnavn-ekte-navn-fra-nettsted) so the nightly RFB enrichment
// job (R6) can reuse it from the homepage refresh without importing that
// 36k-line route module; routes/opplevelser.ts re-exports every name, so its
// callers and tests are unchanged. Two additive changes, both inert for the
// existing callers:
//   • noteLlmCall("product-list-extractor") right before each model request
//     (llm-call-meter.ts: a no-op outside a meter scope; R6 counts it toward
//     its per-night cap);
//   • an optional third argument (GardssalgProductListOptions): R6 turns the
//     one Skive 4 retry off (at most ONE model call) and passes an abort
//     signal for its per-row deadline.

import { noteLlmCall } from "./llm-call-meter";

/** llm-call-meter source key for this extractor (R6's by_source). */
export const GARDSSALG_PRODUCT_LIST_LLM_SOURCE = "product-list-extractor";

// ─── generateGardssalgProductList (dev-request 2026-07-18-gardssalg-
//     profilkvalitet-foer-outreach, slice 5c) ────────────────────────────────
// Fill-only extraction of the drink/product names a gårdssalg provider
// actually sells, sourced ONLY from the already-fetched, already-extracted
// visible page text (sourceText — the SAME extractVisibleText(combinedHtml)
// the calling route already computed, capped like the rewrite helper — no
// new fetch/host-binding surface). Mirrors generateGardssalgAboutRewrite's
// exact never-fabricate contract: sync fetch to
// https://api.anthropic.com/v1/messages, ANTHROPIC_API_KEY from env, model
// claude-opus-4-8. Returns null — NEVER throws, NEVER fabricates — on
// missing key / network failure / non-200 / unparseable body / a response
// that isn't a valid JSON array / an empty result after validation.
//
// Grounding (Daniel's "kun kildebasert" + "ingen oppfunne produkter"): the
// prompt instructs the model to list ONLY product/drink names literally
// present in the source text, in the exact wording used there, and to
// return the literal sentinel GARDSSALG_PRODUCTS_SENTINEL when the source
// text names no products at all.
//
// Validation is enforced HERE, in code — not trusted to the prompt alone:
// the response must parse as JSON representing an array; non-string,
// empty-after-trim, or over-length (> GARDSSALG_PRODUCTS_MAX_ITEM_LEN)
// entries are silently dropped (filtering, not fabricating — never invents
// a replacement for a dropped entry); the survivors are deduped case-
// insensitively (first occurrence wins) and capped to
// GARDSSALG_PRODUCTS_MAX_ITEMS. An empty list after all of that (including
// the explicit sentinel) is null, never an empty-but-truthy array.
const GARDSSALG_PRODUCTS_SENTINEL = "INGEN_PRODUKTER_FUNNET";
/**
 * How much page text the product extractor is allowed to see.
 *
 * Raised from 6 000 to 20 000 (Daniel, live session 2026-08-15) on a measured
 * failure, not a hunch. Of the 18 rows with a verified website and no products,
 * 12 came back `sentinel_no_products` — the model saying, honestly, that the
 * text it was given named no products. Fetching Oslo Brewing's pages directly
 * showed why:
 *
 *   www.oslobrewing.no              7 406 chars   <- the FRONT PAGE alone
 *                                                    already exceeds the old cap
 *   www.oslobrewing.no/ourbeer/     7 621 chars   <- begins at char 7 406
 *   www.oslobrewing.no/products-2/  9 406 chars   <- begins at char ~15 000
 *
 * We fetched both product pages. The model never saw one character of either:
 * the cap slices from the front, and the front page's nav/concept text used the
 * whole budget. Same shape on Bryggeriet 1899, Jåttå, Svensefjøset.
 *
 * 20 000 covers every measured row's full combined text. The cost is ~4x the
 * input tokens on a Haiku call — fractions of an øre per producer — against
 * rows that are otherwise permanently stuck.
 *
 * The cap is not the only guard: gardssalgProductSourceText (routes/
 * opplevelser.ts) puts the product pages FIRST, so a site that does exceed even this still spends the
 * budget on the right pages.
 */
export const GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP = 20000;
const GARDSSALG_PRODUCTS_MAX_ITEMS = 20;

const GARDSSALG_PRODUCTS_MAX_ITEM_LEN = 60;

// dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-rader, Skive 1
// (diagnose): ADDITIVE out-param — when the caller passes a diagnosticOut
// object, this function stamps its `outcome` field with WHICH of the
// no-products paths below was taken (the function's own return value stays
// `string[] | null` either way, so no existing behavior/caller/test is
// affected by this — omitting the second argument, as every pre-existing
// call site does, reproduces the exact prior behavior byte-for-byte).
// "invalid_unparseable" covers every shape/parse failure that is NOT the
// model's own explicit "no products" sentinel (non-string text, non-JSON
// response, non-array JSON, or an array that filters down to nothing);
// "infra_failure" covers failures before the model's answer is even in hand
// (missing API key, network error, non-2xx, unparseable response body) —
// keeping these apart from "sentinel_no_products" is the whole point of this
// diagnostic pass (see the dev-request's three hypotheses).
// Which SHAPE of unparseable this was. Four code paths reach
// "invalid_unparseable" and they have four different remedies, so the bucket
// name alone has never been actionable:
//   no_text_block       — the response carried no text content block at all
//   not_json            — text came back, but JSON.parse rejected it (prose,
//                         markdown fence, or a list cut off mid-array)
//   not_array           — valid JSON, wrong shape (an object, a bare string)
//   empty_after_filter  — a real array, but every entry was dropped by the
//                         type/blank/length filter (e.g. all items longer than
//                         GARDSSALG_PRODUCTS_MAX_ITEM_LEN)
export type GardssalgProductsInvalidReason =
  | "no_text_block"
  | "not_json"
  | "not_array"
  | "empty_after_filter";

/** ~200 chars, whitespace collapsed — enough to read what came back, bounded
 *  so a diagnostic can never carry a whole page of model output. PURE. */
export function gardssalgProductsInvalidSample(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, GARDSSALG_PRODUCTS_INVALID_SAMPLE_CHARS);
}
export const GARDSSALG_PRODUCTS_INVALID_SAMPLE_CHARS = 200;

// dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-rader, Skive 5
// (2026-08-15): `outcome` alone could not explain a single one of the four
// invalid_unparseable rows the PR #608 measurement produced — the failure had
// a name and no description, so deciding whether max_tokens: 400 was cutting
// the response off required another deploy just to look. These three fields
// are what "look" needs, and they are recorded at the moment the response is
// in hand rather than reconstructed later:
//   invalid_reason — WHICH parse path failed (see the type above)
//   invalid_sample — the first ~200 chars of what the model actually returned
//   stop_reason    — the API's own stop_reason ("max_tokens" vs "end_turn"),
//                    which settles the truncation question outright instead of
//                    inferring it from a token estimate
// All three are optional and only populated on the invalid_unparseable path;
// every other outcome leaves them undefined, so no existing consumer changes.
export interface GardssalgProductsExtractionDiagnostic {
  outcome?: "products_found" | "sentinel_no_products" | "invalid_unparseable" | "infra_failure";
  invalid_reason?: GardssalgProductsInvalidReason;
  invalid_sample?: string;
  stop_reason?: string | null;
}

/**
 * Strip a markdown code fence wrapping the model's answer. PURE.
 *
 * Skive 6 (2026-08-15) — this is what `invalid_unparseable` actually WAS, on
 * every row that carried it. The Skive 5 diagnostic answered the question the
 * first live run after it deployed:
 *
 *   Hurum Bryggeri   stop_reason: "end_turn"  ```json [ "Hurums Pale Ale", …11 øl… ] ```
 *   Nordfjord Distillery  stop_reason: "end_turn"  ```json [ "Frisider eple", … ] ```
 *
 * Both answers were COMPLETE and CORRECT — `end_turn`, not `max_tokens`. The
 * extraction had worked and eleven correct beer names were thrown away because
 * `JSON.parse` will not accept three backticks. max_tokens was never the
 * problem, so it is not touched; the estimate that said it might be is now
 * moot.
 *
 * Requires BOTH fences before stripping anything: a response cut off mid-fence
 * is genuinely damaged and must stay unparseable rather than be coerced into
 * half a list. The language tag (```json) is dropped only when a newline or
 * space separates it from the payload, so a fence-less answer that merely
 * starts with a word is never mangled.
 *
 * Belt and braces, the same discipline generateGardssalgAboutRewrite already
 * uses for prose: the prompt also asks for no markdown, and this strips it
 * anyway. Neither half is trusted alone.
 */
export function gardssalgStripCodeFence(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("```") || !t.endsWith("```") || t.length < 6) return t;
  return t.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\s/, "").trim();
}

// dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-rader, Skive 4
// (retry-once on invalid_unparseable): a single API-call-and-parse attempt,
// factored out of generateGardssalgProductList so the outer function can
// invoke the EXACT SAME call/parse/filter/dedup/cap logic a second time on
// an "unparseable" first attempt, without duplicating (and risking
// diverging) that logic. Returns a discriminated result instead of stamping
// diagnosticOut directly — the outer function is the only place that knows
// whether a given attempt is the first or the (possible) retry, so it owns
// translating the final attempt's kind into diagnosticOut.outcome.
type GardssalgProductAttemptResult =
  | { kind: "products"; items: string[] }
  | { kind: "sentinel" }
  | {
      kind: "unparseable";
      reason: GardssalgProductsInvalidReason;
      sample: string;
      stop_reason: string | null;
    }
  | { kind: "infra_failure" };

async function attemptGardssalgProductExtraction(
  apiKey: string,
  prompt: string,
  signal?: AbortSignal
): Promise<GardssalgProductAttemptResult> {
  let response: Awaited<ReturnType<typeof fetch>>;
  // Counted on the caller's LLM meter (llm-call-meter.ts) right before the
  // request leaves the process — a no-op outside a meter scope, i.e. for
  // every opplevelser caller; the nightly RFB job reads it for its cap.
  noteLlmCall(GARDSSALG_PRODUCT_LIST_LLM_SOURCE);
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
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: "infra_failure" }; // network/fetch failure — never fabricate
  }

  if (!response.ok) {
    return { kind: "infra_failure" };
  }

  let result: any;
  try {
    result = await response.json();
  } catch {
    return { kind: "infra_failure" }; // unparseable JSON body — never fabricate
  }

  // Read straight off the API response, not inferred: "max_tokens" here IS the
  // proof that the answer was cut off mid-emission, and "end_turn" IS the proof
  // that it was not. Null when the field is absent or not a string.
  const stopReason = typeof result?.stop_reason === "string" ? result.stop_reason : null;

  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") {
    // No text block to sample — record the response's own shape instead, so
    // this branch is still distinguishable from an empty model answer.
    return {
      kind: "unparseable",
      reason: "no_text_block",
      sample: gardssalgProductsInvalidSample(JSON.stringify(result?.content ?? null) ?? "null"),
      stop_reason: stopReason,
    };
  }
  // `cleaned` stays the RAW answer and is what every sample below reports —
  // "what came back" must keep showing the fence, or the next reader of a
  // failing row is back to guessing. `unfenced` is what gets interpreted.
  const cleaned = text.trim();
  const unfenced = gardssalgStripCodeFence(cleaned);
  // Sentinel check runs on the unfenced text too: a fenced
  // ```INGEN_PRODUKTER_FUNNET``` is the model answering "no products"
  // correctly, and reading it as a parse failure would misfile an honest
  // answer as a defect — the exact confusion Skive 1 exists to prevent.
  if (unfenced === GARDSSALG_PRODUCTS_SENTINEL) {
    return { kind: "sentinel" }; // explicit "no products" escape
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // not valid JSON — never fabricate/guess a list from prose
    return {
      kind: "unparseable",
      reason: "not_json",
      sample: gardssalgProductsInvalidSample(cleaned),
      stop_reason: stopReason,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      kind: "unparseable",
      reason: "not_array",
      sample: gardssalgProductsInvalidSample(cleaned),
      stop_reason: stopReason,
    };
  }

  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item || item.length > GARDSSALG_PRODUCTS_MAX_ITEM_LEN) continue;
    const key = item.toLocaleLowerCase("nb-NO");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= GARDSSALG_PRODUCTS_MAX_ITEMS) break;
  }

  if (items.length === 0) {
    // A well-formed array that filtered down to nothing. Sampling `cleaned`
    // rather than the array makes the cause readable: 25 entries all longer
    // than GARDSSALG_PRODUCTS_MAX_ITEM_LEN look completely different here
    // from a literal `[]`.
    return {
      kind: "unparseable",
      reason: "empty_after_filter",
      sample: gardssalgProductsInvalidSample(cleaned),
      stop_reason: stopReason,
    };
  }
  return { kind: "products", items };
}

/**
 * Optional caller bounds. Absent (every opplevelser call site) = the exact
 * behaviour before the move: one retry on an unparseable answer, no abort.
 */
export interface GardssalgProductListOptions {
  /**
   * false = never the Skive 4 retry, so the function makes AT MOST ONE model
   * call (the nightly RFB job's per-row LLM reservation is 1). Default true.
   */
  retryOnUnparseable?: boolean;
  /** Aborts the model request (e.g. at a caller's deadline) → infra_failure. */
  signal?: AbortSignal;
}

export async function generateGardssalgProductList(
  sourceText: string,
  diagnosticOut?: GardssalgProductsExtractionDiagnostic,
  opts?: GardssalgProductListOptions
): Promise<string[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (diagnosticOut) diagnosticOut.outcome = "infra_failure";
    return null;
  }

  const cappedSource = (sourceText || "").slice(0, GARDSSALG_PRODUCTS_SOURCE_CHAR_CAP);
  const prompt = `Lag en liste over produkter/drikkevarer denne gårdsprodusenten selger, KUN basert på kildeteksten under.

Kildetekst (hentet fra produsentens egen nettside):
${cappedSource}

Bruk KUN produktnavn som faktisk står i kildeteksten, med samme ordlyd som der. Ikke finn på produkter som ikke er nevnt. Et produkt er en vare produsenten selger og som kunden får med seg — flasker, glass, pakker, varer i utsalget. Retter som serveres er IKKE produkter: selskapsmeny, cateringmeny, dagens rett, buffet og annen servering skal ALDRI med i listen, selv om rettene står navngitt i kildeteksten. Svar med EKSAKT et JSON-array av strenger, f.eks. ["Eplesider","Eplemost"], og ingenting annet — ingen markdown, ingen kodeblokk, ingen backticks rundt svaret. Hvis kildeteksten ikke nevner noen konkrete produkter, svar med nøyaktig ${GARDSSALG_PRODUCTS_SENTINEL} og ingenting annet.`;

  // dev-request 2026-08-10-produktnavn-uttrekk-blokkerer-28-rader, Skive 4:
  // ONE automatic retry (one additional API call, same cappedSource/prompt),
  // triggered ONLY when the first attempt is "unparseable" — mirrors the
  // manual retry that already, live, resolved the observed Rabalder Sideri
  // response-sampling flip-flop (2026-08-12). Hard cap of 1 retry: the loop
  // runs at most twice, never a third attempt regardless of outcome.
  // sentinel/infra_failure attempts fall straight through — exactly 1 API
  // call, unchanged from pre-Skive-4 behavior.
  let attempt = await attemptGardssalgProductExtraction(apiKey, prompt, opts?.signal);
  if (attempt.kind === "unparseable" && opts?.retryOnUnparseable !== false) {
    attempt = await attemptGardssalgProductExtraction(apiKey, prompt, opts?.signal);
  }

  switch (attempt.kind) {
    case "products":
      if (diagnosticOut) diagnosticOut.outcome = "products_found";
      return attempt.items;
    case "sentinel":
      if (diagnosticOut) diagnosticOut.outcome = "sentinel_no_products";
      return null;
    case "infra_failure":
      if (diagnosticOut) diagnosticOut.outcome = "infra_failure";
      return null;
    case "unparseable":
    default:
      if (diagnosticOut) {
        diagnosticOut.outcome = "invalid_unparseable";
        // The FINAL attempt's evidence. When the retry above fired, that is
        // the second response — the one whose failure actually produced this
        // outcome. (The `attempt.kind` guard is what makes this type-safe in
        // the `default` branch, which no known result reaches.)
        if (attempt.kind === "unparseable") {
          diagnosticOut.invalid_reason = attempt.reason;
          diagnosticOut.invalid_sample = attempt.sample;
          diagnosticOut.stop_reason = attempt.stop_reason;
        }
      }
      return null;
  }
}
