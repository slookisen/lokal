// ─── LLM call meter — counts real judge calls inside one async scope ─────────
//
// dev-request 2026-10-10-rfb-berikelse-nattjobb (R6): the nightly RFB
// enrichment job (services/rfb-enrichment-nightly.ts) runs existing tools
// whose LLM gates live deep inside them (contact-candidate-judge.ts behind
// rfb-contact-extraction / rfb-brreg-selfsufficiency, second-line-profile-
// judge.ts behind the verifier). The spec asks for a hard per-night cap on
// LLM calls and a nightly report of how many were made and what they cost.
//
// The judges call noteLlmCall() immediately before they send a request to
// the model API. Outside a meter scope that is a no-op, so every existing
// caller is unaffected. Inside runWithLlmCallMeter() the call is counted on
// that scope's meter only (AsyncLocalStorage follows the awaits of the
// scope, including in-process route calls made from it), so concurrent work
// elsewhere in the process never inflates or drains a job's count.
//
// Observability only: nothing here can block, alter or reorder a judge call.
// The job enforces its cap BEFORE starting a row, from a per-row upper bound.

import { AsyncLocalStorage } from "async_hooks";

export interface LlmCallMeter {
  /** Requests sent to the model API inside this scope. */
  calls: number;
  /** Same count, keyed by the judge that made it. */
  bySource: Record<string, number>;
}

const storage = new AsyncLocalStorage<LlmCallMeter>();

export function createLlmCallMeter(): LlmCallMeter {
  return { calls: 0, bySource: {} };
}

/** Run `fn` with `meter` as the active meter for every await inside it. */
export function runWithLlmCallMeter<T>(meter: LlmCallMeter, fn: () => Promise<T>): Promise<T> {
  return storage.run(meter, fn);
}

/** The meter of the current async scope, or null outside one. */
export function currentLlmCallMeter(): LlmCallMeter | null {
  return storage.getStore() ?? null;
}

/**
 * Record one request to the model API. Called by the judge modules right
 * before their fetch (after their own API-key check, so a call that never
 * leaves the process is not counted). No-op outside a meter scope.
 */
export function noteLlmCall(source: string): void {
  const meter = storage.getStore();
  if (!meter) return;
  meter.calls += 1;
  meter.bySource[source] = (meter.bySource[source] ?? 0) + 1;
}
