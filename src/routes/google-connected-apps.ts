// ─── /.well-known/google-connected-apps — Google Connected Apps domain
// verification (slice G1-1) ──────────────────────────────────────────────
// Google's Connected Apps console (exposing our MCP servers to Gemini) asks
// for proof of domain ownership: its "Download token" gives a file
// google-connected-apps.json = {"verification_tokens":[...]}, which must be
// served at https://<domain>/.well-known/google-connected-apps with HTTP 200
// directly (no redirect).
//
// Behind GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED ("1" or "true"; default
// OFF → 404). Tokens come from GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS
// (the full JSON file content or a comma-separated list), and on the
// opplevagent.no host from GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS_OPPLEVAGENT
// when set, else the shared value. Missing/invalid value → 404 (never 500,
// never the env value). Answers only on rettfrabonden.com and opplevagent.no;
// any other host, method or path falls straight through (next()).
//
// Mounted in src/index.ts before the agentplatform.no / dental / opplevagent
// host gates, the static files and every router, so nothing redirects or
// 404s it first on the two hosts.

import type { Request, Response, NextFunction, RequestHandler } from "express";

export const GOOGLE_CONNECTED_APPS_PATH = "/.well-known/google-connected-apps";
export const GOOGLE_CONNECTED_APPS_FLAG = "GOOGLE_CONNECTED_APPS_VERIFICATION_ENABLED";
export const GOOGLE_CONNECTED_APPS_TOKENS_ENV = "GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS";
export const GOOGLE_CONNECTED_APPS_TOKENS_OPPLEVAGENT_ENV = "GOOGLE_CONNECTED_APPS_VERIFICATION_TOKENS_OPPLEVAGENT";

const RFB_HOST = "rettfrabonden.com";
const OPPLEVAGENT_HOST = "opplevagent.no";

// A token is one printable, non-space ASCII run of sane length. Anything else
// makes the whole value invalid (→ 404), so a malformed env never half-serves.
const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
const MAX_TOKENS = 20;

export function googleConnectedAppsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[GOOGLE_CONNECTED_APPS_FLAG];
  return v === "1" || v === "true";
}

/**
 * Parse the env value: either the downloaded file's JSON
 * ({"verification_tokens":["..."]}) or a comma-separated token list.
 * Returns null when the value is missing, empty or invalid.
 */
export function parseVerificationTokens(raw: string | undefined): string[] | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  let tokens: unknown[];
  if (s.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const list = (parsed as Record<string, unknown>).verification_tokens;
    if (!Array.isArray(list)) return null;
    tokens = list;
  } else if (s.startsWith("[")) {
    return null;
  } else {
    tokens = s.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  }

  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;
  for (const t of tokens) {
    if (typeof t !== "string" || !TOKEN_RE.test(t)) return null;
  }
  return tokens as string[];
}

/** Which of our two domains the request is for, or null for any other host. */
function siteForHost(hostname: string | undefined): "rfb" | "opplevagent" | null {
  const h = String(hostname || "").toLowerCase();
  if (h === RFB_HOST) return "rfb";
  if (h === OPPLEVAGENT_HOST) return "opplevagent";
  return null;
}

export function tokensForSite(site: "rfb" | "opplevagent", env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (site === "opplevagent") {
    const own = env[GOOGLE_CONNECTED_APPS_TOKENS_OPPLEVAGENT_ENV];
    if (typeof own === "string" && own.trim() !== "") return parseVerificationTokens(own);
  }
  return parseVerificationTokens(env[GOOGLE_CONNECTED_APPS_TOKENS_ENV]);
}

/** Middleware. Env is read per request (flag flips need no restart in tests). */
export function createGoogleConnectedAppsVerification(
  getEnv: () => NodeJS.ProcessEnv = () => process.env,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path !== GOOGLE_CONNECTED_APPS_PATH) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const site = siteForHost(req.hostname);
    if (!site) return next();

    res.setHeader("Cache-Control", "no-store");
    const env = getEnv();
    if (!googleConnectedAppsEnabled(env)) return res.status(404).type("text/plain").send("Not found");
    const tokens = tokensForSite(site, env);
    if (!tokens) return res.status(404).type("text/plain").send("Not found");
    return res.status(200).type("application/json").send(JSON.stringify({ verification_tokens: tokens }));
  };
}

export const googleConnectedAppsVerification = createGoogleConnectedAppsVerification();
