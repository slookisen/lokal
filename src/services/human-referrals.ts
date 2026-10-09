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
  if (lower.includes("gptbot") || lower.includes("chatgpt") || lower.includes("oai-searchbot")) {
    return { isBot: true, clientType: "chatgpt", clientName: "ChatGPT" };
  }
  if (lower.includes("claudebot") || lower.includes("claude-user") || lower.includes("claude")) {
    return { isBot: true, clientType: "claude", clientName: "Claude" };
  }
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
// Ordering matters: Gemini/Bard live on *.google.com and ChatGPT on openai.com,
// so the AI-assistant checks MUST run before the generic google/bing checks
// below or those assistants would be miscounted as plain search.
export function classifyReferralSource(referrer: string | null | undefined): ReferralSourceClass {
  if (!referrer || !String(referrer).trim()) return { key: "direkte", label: "Direkte" };
  const ref = String(referrer).toLowerCase();

  // AI assistants first (see ordering note above).
  if (ref.includes("chat.openai.com") || ref.includes("chatgpt.com") || ref.includes("openai.com")) {
    return { key: "chatgpt", label: "ChatGPT" };
  }
  if (ref.includes("perplexity")) return { key: "perplexity", label: "Perplexity" };
  if (ref.includes("gemini.google") || ref.includes("bard.google") || ref.includes("gemini.")) {
    return { key: "gemini", label: "Gemini" };
  }
  if (ref.includes("copilot.microsoft") || ref.includes("copilot.")) {
    return { key: "copilot", label: "Copilot" };
  }

  // Search engines (human click-through from a SERP) — same tokens as inferReferrerSource.
  if (ref.includes("google")) return { key: "google", label: "Google-søk" };
  if (ref.includes("bing")) return { key: "bing", label: "Bing" };
  if (ref.includes("duckduckgo")) return { key: "duckduckgo", label: "DuckDuckGo" };

  // Social platforms — same tokens as inferReferrerSource's social bucket.
  if (ref.includes("facebook") || ref.includes("instagram") || ref.includes("linkedin") ||
      ref.includes("twitter") || ref.includes("t.co") || ref.includes("reddit") ||
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
    if (!r.referrer || !String(r.referrer).trim()) continue;        // direct visit → no journey to tell

    const sid = r.session_id ? String(r.session_id) : "";
    // Bot/crawler exclusion — reuse the canonical parseUserAgent heuristic on
    // the UA embedded in session_id (`${ipHash}:${userAgent}`). session_id is
    // used for counting/dedup ONLY and is never surfaced.
    const ua = sid.includes(":") ? sid.slice(sid.indexOf(":") + 1) : "";
    if (ua && parseUserAgent(ua).isBot) continue;

    const src = classifyReferralSource(r.referrer);
    if (src.key === "intern" || src.key === "direkte") continue;     // not an external referral

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
  "chat.openai.com", "chatgpt.com", "openai.com", "perplexity",
  "gemini.google", "bard.google", "gemini.", "copilot.microsoft", "copilot.",
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
