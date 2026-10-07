// ─── Shared AI-crawler robots.txt policy (dental + opplevagent) ──────────────
// dev-request 2026-09-08-discovery-paritet-og-ett-katalogtall, item 2: parity
// with rettfrabonden.com's robots.txt (routes/seo.ts) — explicit allow-list for
// the AI search/assistant crawlers, Cloudflare Content-Signal
// (search=yes, ai-input=yes, ai-train=no) in every AI group, CCBot blocked.
// Per-vertical Disallow lines are repeated inside EVERY group on purpose: a
// crawler that matches a specific group ignores the `User-agent: *` rules
// entirely (the root cause of the 2026-07 GSC crawl-budget bleed).
//
// rettfrabonden.com keeps its own hand-written template in seo.ts; this helper
// serves the two verticals that were behind.

export const AI_CONTENT_SIGNAL = "Content-Signal: search=yes, ai-input=yes, ai-train=no";

/** AI search / assistant / training-opt-out crawlers that get an explicit group + Content-Signal. */
export const ROBOTS_AI_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "Claude-SearchBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "MistralAI-User",
  "meta-externalagent",
  "meta-externalfetcher",
  "cohere-ai",
] as const;

/** Classic search crawlers: explicit Allow, no Content-Signal (same as rfb). */
export const ROBOTS_SEARCH_AGENTS = ["Googlebot", "Bingbot", "DuckDuckBot"] as const;

/** Blocked outright (same as rfb). */
export const ROBOTS_BLOCKED_AGENTS = ["CCBot"] as const;

function group(agent: string, disallows: string, signal: boolean): string {
  const lines = [`User-agent: ${agent}`, "Allow: /"];
  if (disallows) lines.push(disallows);
  if (signal) lines.push(AI_CONTENT_SIGNAL);
  return lines.join("\n");
}

/**
 * All user-agent groups, separated by blank lines, no trailing newline.
 * `disallows` is the vertical's shared Disallow block ("" for none).
 */
export function buildRobotsGroups(disallows: string): string {
  const groups: string[] = [group("*", disallows, true)];
  for (const a of ROBOTS_AI_AGENTS) groups.push(group(a, disallows, true));
  for (const a of ROBOTS_SEARCH_AGENTS) groups.push(group(a, disallows, false));
  // Blocked outright; the vertical's Disallow block is still repeated (redundant, but keeps
  // the "every UA group carries the private-path disallows" invariant checkable per group).
  for (const a of ROBOTS_BLOCKED_AGENTS) groups.push(["User-agent: " + a, "Disallow: /", ...(disallows ? [disallows] : [])].join("\n"));
  return groups.join("\n\n");
}
