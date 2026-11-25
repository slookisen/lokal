/**
 * Testmiljø: no outbound connections unless allowed.
 *
 * The app has no central HTTP client: global fetch (undici), https.request and
 * nodemailer are all used directly, in dozens of files. They all end in
 * net.Socket.prototype.connect, so that is where the test environment says no.
 * A connection to this machine is always allowed; anything else needs its host
 * in TESTMILJO_ALLOW_OUTBOUND (comma-separated; a leading dot allows
 * subdomains, e.g. "api.anthropic.com,.example.no").
 *
 * The check runs on the host name as given, before any DNS lookup. DNS queries
 * themselves (dns.resolveMx and the like) are not TCP and are not blocked.
 *
 * Only ever installed from src/testmiljo/boot.ts when isTestmiljo() is true.
 */

import net from "net";

export interface OutboundAttempt {
  host: string;
  port: number | null;
  allowed: boolean;
  count: number;
  lastAt: string;
}

const attempts = new Map<string, OutboundAttempt>();

export function outboundAttempts(): OutboundAttempt[] {
  return [...attempts.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

export function resetOutboundAttempts(): void {
  attempts.clear();
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  return allow.some((entry) => (entry.startsWith(".") ? h.endsWith(entry) || h === entry.slice(1) : h === entry));
}

/** What a connect(...) call is aiming at. `null` for a pipe / unix socket. */
export function connectTarget(args: unknown[]): { host: string; port: number | null } | null {
  let first: any = args[0];
  // net.createConnection hands connect() its normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string" && first.port === undefined) return null;
    return { host: String(first.host ?? first.hostname ?? "localhost"), port: Number(first.port) || null };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return null; // connect(path)
  return { host: typeof args[1] === "string" ? (args[1] as string) : "localhost", port: Number(first) || null };
}

function record(host: string, port: number | null, allowed: boolean): boolean {
  const key = `${host}:${port ?? ""}`;
  const prev = attempts.get(key);
  attempts.set(key, { host, port, allowed, count: (prev?.count ?? 0) + 1, lastAt: new Date().toISOString() });
  return prev === undefined;
}

/**
 * Wraps net.Socket.prototype.connect. Returns the function that puts the
 * original back (used by the tests; the server never uninstalls).
 */
export function installOutboundGuard(opts: { allow: readonly string[]; log?: (message: string) => void }): () => void {
  const original = net.Socket.prototype.connect;
  const log = opts.log ?? (() => {});
  const guarded = function (this: net.Socket, ...args: any[]): net.Socket {
    const target = connectTarget(args);
    if (target && !isLoopbackHost(target.host)) {
      const allowed = hostAllowed(target.host, opts.allow);
      const first = record(target.host, target.port, allowed);
      if (!allowed) {
        if (first) log(`[testmiljo] blocked outbound connection to ${target.host}:${target.port ?? "?"} (add the host to TESTMILJO_ALLOW_OUTBOUND to allow it)`);
        const error = Object.assign(
          new Error(`testmiljø: outbound connection to ${target.host}:${target.port ?? "?"} is blocked`),
          { code: "ETESTMILJO_BLOCKED" },
        );
        process.nextTick(() => this.destroy(error));
        return this;
      }
    }
    return (original as any).apply(this, args);
  };
  net.Socket.prototype.connect = guarded as any;
  return () => {
    if (net.Socket.prototype.connect === (guarded as any)) net.Socket.prototype.connect = original;
  };
}
