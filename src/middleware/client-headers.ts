/**
 * client-headers.ts — dev-request 2026-10-16-klient-ip-fra-fly-client-ip, trinn 3.
 *
 * With `trust proxy` = true (installClientIp owns it) Express derives
 * `req.hostname` from X-Forwarded-Host and `req.protocol` / `req.secure` from
 * X-Forwarded-Proto, and Fly's proxy does not overwrite either when a client
 * sends them. A client could therefore pick the host the host gates, vertical
 * resolution, redirects and analytics see (live repro: `X-Forwarded-Host:
 * finn-tannlege.com` to the rettfrabonden host returned the dental robots.txt).
 *
 * When active this middleware
 *   - deletes the client-supplied `x-forwarded-host`, so `req.hostname` comes
 *     from `Host`; and
 *   - sets `x-forwarded-proto` from Fly's `fly-forwarded-proto`, but only when
 *     that value is exactly `http` or `https`; otherwise it deletes
 *     `x-forwarded-proto` (req.protocol then falls back to the socket).
 *
 * Switch: CLIENT_HEADERS_NORMALIZE_DEFAULT (on), overridden on Fly by
 * CLIENT_HEADERS_NORMALIZE = on | off (case/whitespace-insensitive). An
 * unknown value is a typo: it fails safe to today's behaviour (off) and logs
 * a console.error, like CLIENT_IP_MODE. Off Fly (no FLY_APP_NAME: local dev,
 * CI, `npm test`) it is always off, byte-identical to before.
 * Rollback: `fly secrets set CLIENT_HEADERS_NORMALIZE=off`, or revert.
 *
 * Must be mounted before anything reads req.hostname / req.protocol: in
 * src/index.ts it sits directly after installClientIp (pinned by
 * client-headers.test.ts). Synchronous, never throws, calls next() once.
 */

import type { Application, NextFunction, Request, Response } from "express";

/** Trinn 3: on. Rollback: `fly secrets set CLIENT_HEADERS_NORMALIZE=off`. */
export const CLIENT_HEADERS_NORMALIZE_DEFAULT = true;

export interface ClientHeadersConfig {
  enabled: boolean;
  onFly: boolean;
  reason: "not_on_fly" | "default" | "env" | "invalid_env";
}

export function resolveClientHeadersConfig(
  env: Readonly<Record<string, string | undefined>>,
  logError: (msg: string) => void = console.error,
): ClientHeadersConfig {
  const onFly = typeof env.FLY_APP_NAME === "string" && env.FLY_APP_NAME.trim() !== "";
  if (!onFly) return { enabled: false, onFly: false, reason: "not_on_fly" };
  const raw = (env.CLIENT_HEADERS_NORMALIZE ?? "").trim().toLowerCase();
  if (raw === "") return { enabled: CLIENT_HEADERS_NORMALIZE_DEFAULT, onFly, reason: "default" };
  if (raw === "on") return { enabled: true, onFly, reason: "env" };
  if (raw === "off") return { enabled: false, onFly, reason: "env" };
  logError(`[client-headers] invalid CLIENT_HEADERS_NORMALIZE="${raw.slice(0, 32)}" (expected on|off); using off (today's behaviour)`);
  return { enabled: false, onFly, reason: "invalid_env" };
}

export function createClientHeadersMiddleware(cfg: ClientHeadersConfig) {
  return function clientHeaders(req: Request, _res: Response, next: NextFunction): void {
    if (cfg.enabled) {
      try {
        delete req.headers["x-forwarded-host"];
        const proto = req.headers["fly-forwarded-proto"];
        if (proto === "http" || proto === "https") req.headers["x-forwarded-proto"] = proto;
        else delete req.headers["x-forwarded-proto"];
      } catch {
        /* never block a request */
      }
    }
    next();
  };
}

export function installClientHeaders(
  app: Application,
  cfg: ClientHeadersConfig,
  log: (msg: string) => void = console.log,
): void {
  app.use(createClientHeadersMiddleware(cfg));
  log(`[boot] client-headers normalize=${cfg.enabled} onFly=${cfg.onFly} reason=${cfg.reason}`);
}
