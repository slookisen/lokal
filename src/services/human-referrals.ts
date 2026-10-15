// ─── Human-referral strip + User-Agent heuristics: pure, no database ──
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (A2A), skive 4. These used to live in analytics-service.ts; they moved here
// unchanged so the off-thread stats worker (offthread-stats-worker.ts) can
// aggregate the /samtaler referral strip without importing database/init.
// analytics-service.ts re-exports every name, so existing imports keep working.

// ─── Helper: Parse User-Agent to detect AI agents ──────────────
// Exported (contact-tracking.ts, dev-request 2026-07-03-agent-profile-
// conversations-stats slice 1) so the new contact_clicks.is_bot column is
// stamped with the exact same bot heuristic used everywhere else in this
// file, instead of a re-implementation drifting out of sync over time.
export interface UAParseResult {
  isBot: boolean;
  clientType: "chatgpt" | "claude" | "gemini" | "a2a-agent" | "browser" | "mobile" | "unknown";
  clientName?: string;
  botSource?: string;
}

export function parseUserAgent(ua: string): UAParseResult {
  if (!ua) return { isBot: false, clientType: "unknown" };

  const lower = ua.toLowerCase();

  // AI agent detection
  // WHY: we were previously only matching "chatgpt" but OpenAI's crawler is
  // "GPTBot" and its browsing agent is "ChatGPT-User"; likewise ClaudeBot and
  // Claude-User for Anthropic. Match the full real-world fleet so agentTraffic
  // actually reflects crawler hits.
  // The BOT flag uses the exact tokens of traffic-classifier.ts (AI_SEARCH_PATTERNS / AI_CRAWLER_PATTERNS).
  // A bare "chatgpt"/"claude" substring still names the client (clientName is also read from MCP
  // client ids, e.g. "ChatGPT", "Claude Desktop") but is NOT proof of a bot: a real person's
  // app-browser UA would otherwise be stamped contact_clicks.is_bot = 1.
  // dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, punkt 9. Bot tokens stay strict: these
  // exact ones are what real fetchers send; unverified app-browser UAs are treated as people.
  if (lower.includes("gptbot") || lower.includes("chatgpt-user") || lower.includes("oai-searchbot")) {
    return { isBot: true, clientType: "chatgpt", clientName: "ChatGPT" };
  }
  if (lower.includes("chatgpt")) return { isBot: false, clientType: "chatgpt", clientName: "ChatGPT" };
  if (lower.includes("claudebot") || lower.includes("claude-user") || lower.includes("claude-web") || lower.includes("anthropic-ai")) {
    return { isBot: true, clientType: "claude", clientName: "Claude" };
  }
  if (lower.includes("claude")) return { isBot: false, clientType: "claude", clientName: "Claude" };
  if (lower.includes("gpt-4") || lower.includes("gpt-3")) return { isBot: true, clientType: "chatgpt", clientName: "GPT" };
  if (lower.includes("gemini") || lower.includes("google-extended")) return { isBot: true, clientType: "gemini", clientName: "Gemini" };
  if (lower.includes("perplexitybot") || lower.includes("perplexity")) return { isBot: true, clientType: "a2a-agent", clientName: "Perplexity", botSource: "ai_search" };
  // AI-native search engines that specifically index sites for agent
  // consumption (agentic search). NotHumanSearch launched 2026 and is now
  // a meaningful chunk of our crawl traffic — classify it so it shows up
  // in summary.agentTraffic instead of getting buried in "unknown".
  if (lower.includes("nothumansearch")) {
    return { isBot: true, clientType: "a2a-agent", clientName: "NotHumanSearch", botSource: "ai_search" };
  }
  if (lower.includes("bingbot") || lower.includes("googlebot") || lower.includes("ccbot") || lower.includes("bytespider") || lower.includes("applebot") || lower.includes("yandexbot") || lower.includes("duckduckbot")) {
    return { isBot: true, clientType: "a2a-agent", botSource: "search_engine" };
  }
  if (lower.includes("curl") || lower.includes("node") || lower.includes("python")) return { isBot: true, clientType: "a2a-agent", botSource: "api_client" };

  // Human browser detection
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return { isBot: false, clientType: "mobile" };
  }
  if (lower.includes("mozilla") || lower.includes("chrome") || lower.includes("safari")) {
    return { isBot: false, clientType: "browser" };
  }

  return { isBot: false, clientType: "unknown" };
}


// ═════════════════════════════════════════════════════════════════
// "Menneskelige besøk" strip (dev-request 2026-07-04, item 6)
// Aggregated, anonymized human-referral patterns for the PUBLIC /samtaler
// page. Hard rules (public trust page): NO IPs, NO session-stitching exposed,
// and a minimum-count threshold before any pattern is shown — under-show
// rather than expose anything identifiable.
// ═════════════════════════════════════════════════════════════════

// Minimum number of distinct visits before a referral pattern may be shown
// publicly. Exported so callers (and tests) reference the single source of truth.
export const MIN_HUMAN_REFERRAL_COUNT = 3;

export interface ReferralSourceClass {
  key: string;   // stable machine key: 'google' | 'chatgpt' | 'perplexity' | ...
  label: string; // Norwegian human label: 'Google-søk', 'ChatGPT', ...
}

// ─── Named referral-source classifier ─────────────────────────────
// Reuses the SAME domain tokens as inferReferrerSource() / parseUserAgent()
// so the public strip never drifts from the rest of analytics. Deterministic,
// pure, no guessing: an unrecognized host is "annet", no referrer is "direkte",
// own-domain navigation is "intern" (excluded from the public strip upstream).
//
// AI assistants are matched on the parsed HOST (exact or subdomain), never as a
// substring of the whole URL: "grok" would hit sylteogrokt.no, "you.com" would
// hit thankyou.com and "t.co" would hit chatgpt.com. They also run BEFORE the
// search/social checks below (Gemini/Bard live on *.google.com).

/** Keys classifyReferralSource returns for an AI assistant. */
export const AI_REFERRAL_KEYS = ["chatgpt", "claude", "perplexity", "gemini", "copilot", "mistral", "metaai", "grok", "deepseek", "you", "kagi"] as const;
export function isAiReferralKey(key: string): boolean {
  return (AI_REFERRAL_KEYS as readonly string[]).includes(key);
}

// [host, key, label] — a host matches when it equals the entry or ends with ".<entry>".
const AI_REFERRAL_HOSTS: Array<[string, string, string]> = [
  ["chat.openai.com", "chatgpt", "ChatGPT"], ["chatgpt.com", "chatgpt", "ChatGPT"], ["openai.com", "chatgpt", "ChatGPT"],
  ["claude.ai", "claude", "Claude"],
  ["perplexity.ai", "perplexity", "Perplexity"], ["perplexity.com", "perplexity", "Perplexity"],
  ["gemini.google.com", "gemini", "Gemini"], ["bard.google.com", "gemini", "Gemini"],
  ["copilot.microsoft.com", "copilot", "Copilot"], ["copilot.com", "copilot", "Copilot"],
  ["chat.mistral.ai", "mistral", "Mistral"],
  ["meta.ai", "metaai", "Meta AI"],
  ["grok.com", "grok", "Grok"],
  ["chat.deepseek.com", "deepseek", "DeepSeek"],
  ["you.com", "you", "You.com"],
];

const AI_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT", claude: "Claude", perplexity: "Perplexity", gemini: "Gemini", copilot: "Copilot",
  mistral: "Mistral", metaai: "Meta AI", grok: "Grok", deepseek: "DeepSeek", you: "You.com", kagi: "Kagi Assistant",
};

/** Lower-cased host of a referrer URL; null when it does not parse. */
function referrerHost(ref: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : `https://${ref}`).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch { return null; }
}
const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function aiKeyFromReferrer(ref: string): string | null {
  const host = referrerHost(ref);
  if (!host) return null;
  for (const [domain, key] of AI_REFERRAL_HOSTS) if (hostIs(host, domain)) return key;
  // Kagi is a search engine; only its Assistant is an AI answer.
  if (hostIs(host, "kagi.com") && /^https?:\/\/[^/]+\/assistant(?:[/?#]|$)/i.test(ref.trim())) return "kagi";
  return null;
}

// UTM fallback, whitelist ONLY (our own addAiUtmParams utm_source=<client> plus what
// ChatGPT & co. append themselves). Not agentplatform.no, not producers' own campaigns.
const AI_UTM_SOURCES: Array<[string, string]> = [
  ["chatgpt.com", "chatgpt"], ["copilot.com", "copilot"], ["perplexity", "perplexity"], ["claude", "claude"], ["gemini", "gemini"],
];

export interface AiClickInput {
  referrer?: string | null;
  /** First or any value; Express gives an array when the param appears twice (ours + ChatGPT's). */
  utm_source?: string | string[] | null;
  utm_campaign?: string | string[] | null;
}

function utmValues(v: string | string[] | null | undefined): string[] {
  return (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
}

function aiKeyFromUtmSource(v: string | string[] | null | undefined): string | null {
  // First whitelist hit wins, so an array classifies as AI regardless of order.
  for (const val of utmValues(v)) for (const [token, key] of AI_UTM_SOURCES) if (val.includes(token)) return key;
  return null;
}

/**
 * Which AI assistant a click came from, or null when it is not a click from an AI answer.
 * Pure; slice 1 of 2026-10-14-klikk-fra-ai-svar-per-profil (later slices store it per profile).
 * Our own utm_source wins over the referrer; a referrer wins over utm_campaign=ai_search alone.
 */
export function classifyAiClickSource(i: AiClickInput): "chatgpt" | "claude" | "perplexity" | "gemini" | "copilot" | "other" | null {
  const key = aiKeyFromUtmSource(i.utm_source) ?? (i.referrer ? aiKeyFromReferrer(String(i.referrer)) : null);
  if (key) return (key === "chatgpt" || key === "claude" || key === "perplexity" || key === "gemini" || key === "copilot") ? key : "other";
  if (utmValues(i.utm_campaign).includes("ai_search")) return "other";
  return null;
}

export function classifyReferralSource(
  referrer: string | null | undefined,
  utm?: { utm_source?: string | string[] | null; utm_campaign?: string | string[] | null },
): ReferralSourceClass {
  const hasRef = !!referrer && !!String(referrer).trim();
  if (!hasRef) {
    // No referrer (Referrer-Policy: no-referrer in AI apps): the UTM mark is all there is.
    const k = utm ? aiKeyFromUtmSource(utm.utm_source) : null;
    if (k) return { key: k, label: AI_LABELS[k]! };
    if (utm && utmValues(utm.utm_campaign).includes("ai_search")) return { key: "claude", label: AI_LABELS.claude! };
    return { key: "direkte", label: "Direkte" };
  }
  const ref = String(referrer).toLowerCase();

  // AI assistants first (see ordering note above).
  const ai = aiKeyFromReferrer(String(referrer).trim()) ?? (utm ? aiKeyFromUtmSource(utm.utm_source) : null);
  if (ai) return { key: ai, label: AI_LABELS[ai]! };

  // Search engines (human click-through from a SERP) — same tokens as inferReferrerSource.
  if (ref.includes("google")) return { key: "google", label: "Google-søk" };
  if (ref.includes("bing")) return { key: "bing", label: "Bing" };
  if (ref.includes("duckduckgo")) return { key: "duckduckgo", label: "DuckDuckGo" };

  // Social platforms — same tokens as inferReferrerSource's social bucket ("t.co" on the host only).
  const host = referrerHost(String(referrer).trim());
  if (ref.includes("facebook") || ref.includes("instagram") || ref.includes("linkedin") ||
      ref.includes("twitter") || (host !== null && hostIs(host, "t.co")) || ref.includes("reddit") ||
      ref.includes("tiktok") || ref.includes("bsky.app") || ref.includes("bluesky")) {
    return { key: "sosial", label: "Sosiale medier" };
  }

  // Own domains → a visitor navigating within the site, NOT an external referral.
  if (ref.includes("rettfrabonden.com") || ref.includes("finn-tannlege.com") || ref.includes("opplevagent")) {
    return { key: "intern", label: "Intern navigasjon" };
  }

  return { key: "annet", label: "Annen nettside" };
}

export interface HumanReferralRow {
  referrer: string | null | undefined;
  path: string | null | undefined;
  session_id: string | null | undefined;
  is_owner?: number | null;
  /** UTM marks of the landing (AI-click fallback when there is no referrer). */
  utm_source?: string | null;
  utm_campaign?: string | null;
}

export interface HumanReferralPattern {
  sourceKey: string;                                   // classifyReferralSource key
  sourceLabel: string;                                 // Norwegian label
  visitCount: number;                                  // distinct anonymized visits, always ≥ minCount
  producerViews: number;                               // producer-page views attributed to this source
  topProducers: Array<{ name: string; count: number }>; // named ONLY when resolvable to a real (public) agent
  otherProducerCount: number;                          // distinct additional producers → "+N andre"
}

// ─── Pure aggregation (no DB) ─────────────────────────────────────
// Extracted as a pure function so the anonymization + threshold logic is
// deterministically testable without a database. Enforces, in ONE place:
//   • internal/owner exclusion  (is_owner === 1 dropped — the page_views
//       equivalent of slice-4's conversations.is_internal)
//   • bot/crawler exclusion     (parseUserAgent on the UA embedded in
//       session_id — this strip is HUMAN visits only)
//   • direct/own-domain drop    (no external referral journey)
//   • ≥ minCount threshold      (under-show; a pattern with <minCount distinct
//       visits is SUPPRESSED entirely)
// Output carries NO IP, NO session id, NO raw UA, NO referrer URL, NO path —
// only an aggregate count, a source label, and PUBLIC producer names.
export function aggregateHumanReferrals(
  rows: HumanReferralRow[],
  opts: { minCount?: number; producerNameBySlug?: Map<string, string> } = {}
): HumanReferralPattern[] {
  const minCount = opts.minCount ?? MIN_HUMAN_REFERRAL_COUNT;
  const nameBySlug = opts.producerNameBySlug ?? new Map<string, string>();

  interface Acc { sessions: Set<string>; producerViews: number; slugCounts: Map<string, number>; label: string; }
  const groups = new Map<string, Acc>();
  let anonSeq = 0; // fallback visit id when session_id is absent (keeps counts honest, never exposed)

  for (const r of rows) {
    if (r.is_owner === 1) continue;                                  // internal/owner traffic excluded
    const utm = { utm_source: r.utm_source, utm_campaign: r.utm_campaign };
    // direct visit → no journey to tell, unless the landing carries an AI UTM mark
    if ((!r.referrer || !String(r.referrer).trim()) && classifyReferralSource(null, utm).key === "direkte") continue;

    const sid = r.session_id ? String(r.session_id) : "";
    // Bot/crawler exclusion — reuse the canonical parseUserAgent heuristic on
    // the UA embedded in session_id (`${ipHash}:${userAgent}`). session_id is
    // used for counting/dedup ONLY and is never surfaced.
    const ua = sid.includes(":") ? sid.slice(sid.indexOf(":") + 1) : "";
    if (ua && parseUserAgent(ua).isBot) continue;

    const cls = classifyReferralSource(r.referrer, utm);
    if (cls.key === "intern" || cls.key === "direkte") continue;     // not an external referral
    // All AI assistants form ONE card, so they do not fall under the minimum individually.
    const src = isAiReferralKey(cls.key) ? { key: "ai", label: "AI-assistenter" } : cls;

    let g = groups.get(src.key);
    if (!g) { g = { sessions: new Set(), producerViews: 0, slugCounts: new Map(), label: src.label }; groups.set(src.key, g); }
    g.sessions.add(sid || `__anon_${anonSeq++}`);

    const m = /^\/produsent\/([^/?#]+)/.exec(String(r.path || ""));
    if (m) {
      const slug = m[1]!.toLowerCase();
      g.producerViews++;
      g.slugCounts.set(slug, (g.slugCounts.get(slug) || 0) + 1);
    }
  }

  const out: HumanReferralPattern[] = [];
  for (const [key, g] of groups.entries()) {
    const visitCount = g.sessions.size;
    if (visitCount < minCount) continue; // ≥ minCount threshold — suppress sparse/identifiable patterns

    const ranked = [...g.slugCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topProducers: Array<{ name: string; count: number }> = [];
    let otherProducerCount = 0;
    for (const [slug, count] of ranked) {
      const name = nameBySlug.get(slug);
      if (name && topProducers.length < 2) topProducers.push({ name, count });
      else otherProducerCount++; // unresolved or beyond the top 2 → counted, never named/guessed
    }

    out.push({ sourceKey: key, sourceLabel: g.label, visitCount, producerViews: g.producerViews, topProducers, otherProducerCount });
  }
  out.sort((a, b) => b.visitCount - a.visitCount);
  return out;
}


// ─── Own-domain filter for SQL (serverheng skive 4) ───────────────
// classifyReferralSource() drops "intern" rows in aggregateHumanReferrals()
// AFTER the page-view rows were read into JS. To keep that out of the read,
// the SQL excludes the same rows: a referrer that names an own domain and none
// of the tokens the classifier tests BEFORE its own-domain branch (an own
// domain inside a Google/Bing/… URL is still "google" etc.). Kept next to the
// classifier; human-referrals.test.ts asserts SQL and classifier agree.
export const OWN_DOMAIN_REFERRER_TOKENS = ["rettfrabonden.com", "finn-tannlege.com", "opplevagent"] as const;
export const REFERRER_TOKENS_BEFORE_OWN_DOMAIN = [
  // Superset of what the classifier tests (it matches AI hosts exactly, the SQL only by substring):
  // the SQL may keep a row the classifier then calls intern, never the other way round.
  "chat.openai.com", "chatgpt.com", "openai.com", "perplexity",
  "gemini.google", "bard.google", "gemini.", "copilot.microsoft", "copilot.",
  "claude.ai", "mistral.ai", "meta.ai", "grok.com", "deepseek.com", "you.com", "kagi.com/assistant",
  "google", "bing", "duckduckgo",
  "facebook", "instagram", "linkedin", "twitter", "t.co", "reddit", "tiktok", "bsky.app", "bluesky",
] as const;

/** `AND NOT (own-domain referrer)` fragment plus its bind parameters (all values parameterised). */
export function externalReferrerSqlFilter(): { sql: string; params: string[] } {
  const own = OWN_DOMAIN_REFERRER_TOKENS.map(() => "lower(referrer) LIKE ?").join(" OR ");
  const other = REFERRER_TOKENS_BEFORE_OWN_DOMAIN.map(() => "lower(referrer) NOT LIKE ?").join(" AND ");
  return {
    sql: ` AND NOT ((${own}) AND ${other})`,
    params: [...OWN_DOMAIN_REFERRER_TOKENS, ...REFERRER_TOKENS_BEFORE_OWN_DOMAIN].map((t) => `%${t}%`),
  };
}
