/**
 * Shared reader for the error body of a non-2xx LLM judge response.
 *
 * A2A dev-request 2026-11-25-dommerfeil-skal-ikke-nedgradere-verifiserte-profiler,
 * spec point 6: the judges that used to report only the status code
 * ("dommer-API svarte status 400") now also carry the API's own error text,
 * so an outage (e.g. a 400 for spent credit) can be read from the reason and
 * the log without a DB dig. Same idea as second-line-profile-judge.ts and
 * contact-candidate-judge.ts (lokal#755).
 *
 * Only the RESPONSE body is read. Request headers (the API key) are never
 * touched, logged or returned.
 *
 * The reader never throws and never hangs: a text() that throws, an abort on
 * the caller's signal, or a body that does not arrive within
 * JUDGE_ERROR_BODY_READ_TIMEOUT_MS all give JUDGE_ERROR_BODY_UNREADABLE.
 * What a judge approves is unchanged — this only adds text to a reason that
 * was already a fail-closed rejection.
 */

export const JUDGE_ERROR_BODY_MAX_CHARS = 300;
export const JUDGE_ERROR_BODY_UNREADABLE = "(kunne ikke lese respons-body)";
export const JUDGE_ERROR_BODY_READ_TIMEOUT_MS = 5_000;

type TextReadable = { text?: () => Promise<string> };

/**
 * First JUDGE_ERROR_BODY_MAX_CHARS chars of the response body, on one line
 * (every run of line breaks and the whitespace around it becomes one space).
 * Returns "" for an empty body and JUDGE_ERROR_BODY_UNREADABLE when the body
 * cannot be read.
 */
export async function readErrorBodySnippet(
  response: TextReadable,
  signal?: AbortSignal,
  timeoutMs: number = JUDGE_ERROR_BODY_READ_TIMEOUT_MS,
): Promise<string> {
  if (signal?.aborted) return JUDGE_ERROR_BODY_UNREADABLE;
  if (typeof response?.text !== "function") return JUDGE_ERROR_BODY_UNREADABLE;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("body read timeout")), timeoutMs);
      if (signal) {
        onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const raw = await Promise.race([Promise.resolve().then(() => response.text!()), stop]);
    return String(raw ?? "")
      .replace(/\s*[\r\n]+\s*/g, " ")
      .trim()
      .slice(0, JUDGE_ERROR_BODY_MAX_CHARS);
  } catch {
    return JUDGE_ERROR_BODY_UNREADABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads the error body, logs it with the status under `label`, and returns
 * the text that follows "svarte status " in the judge's reason:
 * "<status>: <snippet>", or just "<status>" when the body is empty. The
 * reason therefore still starts with "dommer-API svarte status <status>" and
 * keeps whatever suffix (e.g. "— avvist fail-closed") the call site had after
 * the status, so prefix/suffix matching on reasons keeps working.
 */
export async function describeJudgeHttpError(
  label: string,
  response: TextReadable & { status: number },
  signal?: AbortSignal,
): Promise<string> {
  const snippet = await readErrorBodySnippet(response, signal);
  console.error(`[${label}] non-ok response: status=${response.status} body=${snippet}`);
  return snippet ? `${response.status}: ${snippet}` : `${response.status}`;
}
