/**
 * a2a-traffic-classifier.ts — who is talking to POST /a2a, and does what
 * they sent deserve a public conversation?
 *
 * Background (prod, 2026-10-04): every POST /a2a message/send turned ANY text
 * into a discovery query and auto-started three seller conversations with the
 * top results. Unparseable payloads — JSON implant envelopes, wallet-drain
 * strings, Chinese «联盟» recruitment posts, agentprobe liveness checks — have
 * no food intent, so they fell through to the nationwide trust ranking and
 * the same three producers absorbed every call: ~7 900 spam conversations
 * (~66 % of all a2a), republished on /samtaler, the profile «Aktivitet» panel
 * and /api/agents/:id/stats. This module is the ONE place that decides:
 *
 *   classifyA2aTraffic()  → 'external' | 'probe' | 'spam' | 'internal'
 *   hasDiscoveryIntent()  → did the parsed query ask for anything at all?
 *   isPublicQueryTerm()   → may this query text be shown publicly?
 *   countableConvSql()    → the shared SQL predicate every public counter uses
 *
 * Deliberately import-free (pure functions + one tiny in-memory cap), so the
 * stats modules (agent-stats, profile-activity, owner-stats) can use it
 * without dragging the DB/registry graph in. 'internal' is decided by the
 * CALLER with conversation-service's existing isInternalTraffic() (the same
 * fleet/admin-key/owner-cookie rules the is_internal backfill uses) and
 * passed in as `isInternal` — it is not re-implemented here.
 *
 * The marker lists are DATA: add a row to A2A_UA_RULES / A2A_TEXT_RULES to
 * catch a new campaign; the tests in a2a-traffic-classifier.test.ts pin the
 * real payloads seen in prod plus ordinary Norwegian queries that must stay
 * 'external'.
 *
 * Generic HTTP-client UAs (Python-urllib, curl, python-requests, node-fetch)
 * are NOT spam/probe signals on their own — real buyer agents use them too
 * (same conservative stance as conversation-service.ts's internal markers).
 * The Python-urllib campaigns are caught by their payload instead, and any
 * no-intent text never creates a conversation regardless of class.
 */

export type A2aTrafficClass = "external" | "probe" | "spam" | "internal";

/** What the conversations.traffic_class column may hold. Internal-ness has ONE home: is_internal. */
export type StoredTrafficClass = "external" | "probe" | "spam";

export interface A2aTrafficRule {
  id: string;
  cls: "spam" | "probe";
  pattern: RegExp;
}

// ─── User-Agent markers ─────────────────────────────────────────────────────
export const A2A_UA_RULES: A2aTrafficRule[] = [
  { id: "ua-ziwei", cls: "spam", pattern: /ziwei/i },                 // ziwei-implant/1.0
  { id: "ua-kunlunyaochi", cls: "spam", pattern: /kunlun\s*yaochi/i },
  { id: "ua-a2a-probe", cls: "probe", pattern: /a2a-probe/i },         // a2a-probe/1.0 (research)
  { id: "ua-agentprobe", cls: "probe", pattern: /agentprobe/i },       // agentprobe/0.1.0 (+https://agentprobe.org/…)
  { id: "ua-agenstrybot", cls: "probe", pattern: /agenstrybot/i },     // registry liveness "ping"
];

// ─── Payload markers ────────────────────────────────────────────────────────
// Spam = payloads that try to recruit, implant or move money. Probe = machine
// liveness/instruction-following checks. Spam wins when both match.
export const A2A_TEXT_RULES: A2aTrafficRule[] = [
  { id: "wallet-address", cls: "spam", pattern: /\b0x[0-9a-fA-F]{40}\b/ },
  { id: "token-usdc", cls: "spam", pattern: /\btoken\s*[=:]\s*usdc\b/i },
  { id: "amount-max", cls: "spam", pattern: /\bamount\s*[=:]\s*max\b/i },
  { id: "implant-id", cls: "spam", pattern: /implant[_-]?id/i },
  { id: "ziwei", cls: "spam", pattern: /ziwei/i },
  { id: "ziwei-cjk", cls: "spam", pattern: /紫薇/ },
  { id: "recontact-verify", cls: "spam", pattern: /recontact[-_ ]verify/i },
  // «——Hermes紫薇» / «——Hermes» signature under Chinese recruitment posts.
  { id: "hermes-recruitment", cls: "spam", pattern: /^(?=[\s\S]*[㐀-鿿])[\s\S]*\bhermes\b/i },
  { id: "kunlunyaochi", cls: "spam", pattern: /kunlun\s*yaochi/i },
  { id: "wallet-recovery", cls: "spam", pattern: /\bwallet\s+recovery\b/i },
  { id: "utxo", cls: "spam", pattern: /\butxo\b/i },
  { id: "gas-sponsorship", cls: "spam", pattern: /\bgas\s+sponsorship\b/i },
  { id: "payment-rail", cls: "spam", pattern: /\bpayment\s+rail\b/i },
  { id: "reply-single-word", cls: "probe", pattern: /reply with (?:the|a|one) single word/i },
  { id: "take-no-other-action", cls: "probe", pattern: /take no other action/i },
  { id: "liveness-check", cls: "probe", pattern: /\bliveness check\b/i },
];

/**
 * Keys a real structured discovery query may carry (DiscoveryQuerySchema +
 * parseNaturalQuery's private fields). A JSON object typed as TEXT whose keys
 * are all in here is a legitimate query sent the wrong way (and legacy a2a
 * Mode-2 conversations stored JSON.stringify(message.data) as query_text), so
 * it must not be mistaken for a machine payload.
 */
const DISCOVERY_QUERY_KEYS = new Set([
  "query", "role", "categories", "tags", "skills", "drinkSubcategory", "location",
  "maxDistanceKm", "limit", "offset", "_productTerms", "_nameQuery", "_proximityIntent",
]);

function jsonObjectPayload(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(t); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed as Record<string, unknown>);
  return keys.length === 0 || keys.some((k) => !DISCOVERY_QUERY_KEYS.has(k));
}

export interface A2aTrafficInput {
  /** The message text (or, for structured calls, a JSON rendering of the data). */
  text?: string | null;
  ua?: string | null;
  /** True when the caller sent structured `message.data` — the JSON-object rule is then skipped. */
  hasStructuredData?: boolean;
  /** conversation-service isInternalTraffic(...) for this request — our own fleet / admin key / owner cookie. */
  isInternal?: boolean;
}

export interface A2aTrafficVerdict {
  cls: A2aTrafficClass;
  /** The rule that decided a non-external verdict (for admin breakdowns / tests). */
  ruleId?: string;
}

export function classifyA2aTrafficDetailed(input: A2aTrafficInput): A2aTrafficVerdict {
  if (input.isInternal) return { cls: "internal", ruleId: "internal" };
  const ua = input.ua || "";
  const text = input.text || "";
  let probe: string | undefined;
  for (const r of A2A_UA_RULES) {
    if (!r.pattern.test(ua)) continue;
    if (r.cls === "spam") return { cls: "spam", ruleId: r.id };
    probe = probe || r.id;
  }
  for (const r of A2A_TEXT_RULES) {
    if (!r.pattern.test(text)) continue;
    if (r.cls === "spam") return { cls: "spam", ruleId: r.id };
    probe = probe || r.id;
  }
  if (!probe && !input.hasStructuredData && jsonObjectPayload(text)) probe = "json-object";
  return probe ? { cls: "probe", ruleId: probe } : { cls: "external" };
}

export function classifyA2aTraffic(input: A2aTrafficInput): A2aTrafficClass {
  return classifyA2aTrafficDetailed(input).cls;
}

/** Map a verdict onto what conversations.traffic_class stores (internal lives in is_internal). */
export function toStoredTrafficClass(cls: A2aTrafficClass | undefined | null): StoredTrafficClass {
  return cls === "spam" || cls === "probe" ? cls : "external";
}

// ─── Intent ─────────────────────────────────────────────────────────────────
function nonEmpty(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : !!v;
}

/**
 * Did the (parsed or structured) query ask for anything? parseNaturalQuery
 * ALWAYS sets role:"producer", so `role` only counts for structured calls,
 * where a client deliberately built a query ("list producers").
 */
export function hasDiscoveryIntent(q: any, opts: { structured?: boolean } = {}): boolean {
  if (!q || typeof q !== "object") return false;
  if (nonEmpty(q.categories) || nonEmpty(q.tags) || nonEmpty(q.skills)) return true;
  if (nonEmpty(q._productTerms) || nonEmpty(q._nameQuery) || nonEmpty(q.drinkSubcategory)) return true;
  if (q.location && typeof q.location === "object") return true;
  return !!opts.structured && nonEmpty(q.role);
}

// ─── Public query-text allow-list ───────────────────────────────────────────
const CJK_RE = /[　-ヿ㐀-鿿가-힯豈-﫿]/;
const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ai|xyz|cn|ru|app|dev|info|biz|co|me|top|site|online|no)\b)/i;
const MACHINE_CHARS_RE = /[{}[\]<>`=;|\\]/;
const HEX_RE = /\b0x[0-9a-f]{6,}/i;
const PII_RE = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/,       // e-mail
  /(?<![\d\w])(?:\+?47[\s-]?)?[2-9]\d(?:\s?\d{2}){3}(?![\d\w])/,          // NO phone
  /\b\d{11}\b/,                                                            // fødselsnummer-shaped
];
/** Whole-text fillers that are a ping, not a food query. */
const NO_INTENT_TERMS = new Set([
  "ping", "pong", "test", "testing", "hello", "hi", "hey", "hei", "hallo", "health",
  "healthcheck", "status", "echo", "ok", "okay", "help", "hjelp",
]);

/**
 * May `raw` be shown on a public surface as "what a buyer asked"?
 * Defaults fit an aggregated top-term chip (≤40 chars, ≤6 words); the
 * «siste samtaler» card passes looser limits and `allowPii` (it redacts with
 * redactPII() before display instead of dropping).
 */
export function isPublicQueryTerm(
  raw: string | null | undefined,
  opts: { maxLen?: number; maxWords?: number; allowPii?: boolean } = {},
): boolean {
  if (typeof raw !== "string") return false;
  const t = raw.trim();
  if (t.length < 2 || t.length > (opts.maxLen ?? 40)) return false;
  if (classifyA2aTraffic({ text: t }) !== "external") return false;
  if (CJK_RE.test(t) || URL_RE.test(t) || MACHINE_CHARS_RE.test(t) || HEX_RE.test(t)) return false;
  if (/\p{Cc}/u.test(t)) return false;
  if (!opts.allowPii && PII_RE.some((re) => re.test(t))) return false;
  if (t.split(/\s+/).length > (opts.maxWords ?? 6)) return false;
  if (!/\p{L}{2,}/u.test(t) && !/^\d{4}$/.test(t)) return false; // a word, or a postal code
  if (NO_INTENT_TERMS.has(t.toLowerCase().replace(/[.!?]+$/, ""))) return false;
  return true;
}

// ─── Countable conversations ────────────────────────────────────────────────
/**
 * THE predicate for every public conversation counter/list: not our own
 * traffic, and not classified spam/probe. COALESCE keeps it correct on a row
 * written before either column existed.
 */
export const COUNTABLE_CONV_SQL = "COALESCE(is_internal,0)=0 AND COALESCE(traffic_class,'external')='external'";

/** Same predicate with a table alias, e.g. countableConvSql("c"). */
export function countableConvSql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(${p}is_internal,0)=0 AND COALESCE(${p}traffic_class,'external')='external'`;
}

// ─── Per-caller conversation cap (POST /a2a) ────────────────────────────────
/**
 * Sliding-window cap keyed by ip_hash: at most `max` conversation-creating
 * calls per `windowMs`. In-memory and bounded (oldest key evicted first —
 * Map insertion order doubles as LRU), so a key flood cannot grow it without
 * limit. Process-local on purpose: one Fly machine, and a restart only ever
 * makes the cap more lenient, never blocks a real buyer.
 */
export class SlidingWindowCap {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private maxKeys = 10_000) {}

  private live(key: string, now: number): number[] {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length === 0) this.hits.delete(key);
    return arr;
  }

  isOver(key: string, now = Date.now()): boolean {
    return this.live(key, now).length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    const arr = this.live(key, now);
    arr.push(now);
    this.hits.delete(key);
    this.hits.set(key, arr);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

/** POST /a2a: max 10 conversation-creating calls per hour per ip_hash. */
export const A2A_CONVERSATION_CAP_PER_HOUR = 10;
export const a2aConversationCap = new SlidingWindowCap(A2A_CONVERSATION_CAP_PER_HOUR, 60 * 60 * 1000);

// ─── Since-boot decision counters (admin observability) ─────────────────────
// Blocked calls no longer leave a conversation or a 'search' interaction row,
// so these counters are what keeps the spam volume visible to admins
// (GET /admin/analytics/conversations → a2aGuard).
export type A2aGuardOutcome = "conversations" | "no_results" | "no_intent" | "rate_capped" | "probe" | "spam" | "internal";
const guardSince = new Date().toISOString();
const guardCounts: Record<A2aGuardOutcome, number> = {
  conversations: 0, no_results: 0, no_intent: 0, rate_capped: 0, probe: 0, spam: 0, internal: 0,
};

export function recordA2aGuardOutcome(outcome: A2aGuardOutcome): void {
  guardCounts[outcome]++;
}

export function getA2aGuardStats(): { since: string; counts: Record<A2aGuardOutcome, number> } {
  return { since: guardSince, counts: { ...guardCounts } };
}
