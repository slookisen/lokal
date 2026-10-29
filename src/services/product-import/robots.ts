// ─── robots.txt for outbound product-import fetches ─────────────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1:
// fetchPage() has no robots.txt check, and the product importer must honour
// one. Scope is deliberately this importer only — no existing fetch path
// changes behaviour.
//
// Rules (RFC 9309, the parts that matter here):
//   • the group whose User-agent matches our product token
//     (`Lokal-RFB-Scraper`, case-insensitive) applies; otherwise the `*`
//     group; otherwise everything is allowed;
//   • the longest matching Allow/Disallow path wins, Allow wins a tie;
//     `*` wildcards and a trailing `$` anchor are supported; an empty
//     `Disallow:` allows everything;
//   • a robots.txt that answers 4xx (none published) = allow everything.
//     Any other failure (5xx, timeout, DNS) is handed back to the caller as a
//     fetch failure — we never treat "could not read the rules" as "allowed".
//
// Results are cached per host for ROBOTS_CACHE_TTL_MS (~24 h).

export const PRODUCT_IMPORT_UA_TOKEN = "lokal-rfb-scraper";
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsPolicy {
  /** Rules of the group that applies to us (empty = allow all). */
  rules: RobotsRule[];
  /** Which group applied: our own token, `*`, or none. */
  matched: "ua" | "star" | "none";
}

/** Parse robots.txt text into the policy for our user-agent. PURE. */
export function parseRobotsTxt(text: string, uaToken: string = PRODUCT_IMPORT_UA_TOKEN): RobotsPolicy {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of (text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue; // empty Disallow = allow all
      current.rules.push({ allow: field === "allow", path: value });
    }
  }

  const token = uaToken.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && a.replace(/\/.*$/, "").trim() === token));
  if (own.length > 0) return { rules: own.flatMap((g) => g.rules), matched: "ua" };
  const star = groups.filter((g) => g.agents.includes("*"));
  if (star.length > 0) return { rules: star.flatMap((g) => g.rules), matched: "star" };
  return { rules: [], matched: "none" };
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp(
    "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return re.test(path);
}

/** Whether `pathWithQuery` (e.g. "/products.json?limit=250") may be fetched. PURE. */
export function isPathAllowed(policy: RobotsPolicy, pathWithQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of policy.rules) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    if (
      !best ||
      r.path.length > best.path.length ||
      (r.path.length === best.path.length && r.allow && !best.allow)
    ) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

// ── Per-host cache ──────────────────────────────────────────────────────────

const cache = new Map<string, { policy: RobotsPolicy; at: number }>();

export function getCachedRobots(host: string, now: number): RobotsPolicy | null {
  const hit = cache.get(host.toLowerCase());
  if (!hit) return null;
  if (now - hit.at > ROBOTS_CACHE_TTL_MS) {
    cache.delete(host.toLowerCase());
    return null;
  }
  return hit.policy;
}

export function setCachedRobots(host: string, policy: RobotsPolicy, now: number): void {
  cache.set(host.toLowerCase(), { policy, at: now });
}

/** Test-only. */
export function __clearRobotsCacheForTesting(): void {
  cache.clear();
}
