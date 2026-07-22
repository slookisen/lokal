/**
 * Consumer-identity middleware — dev-request 2026-07-13-agent-identity-usage-ledger,
 * slice 1 (L4, Daniel-authorized 2026-07-20:
 * daniel-responses/2026-07-20-go-usage-ledger-og-supply-graph.md).
 *
 * Voluntary, free, self-service API keys for AI-agent CONSUMERS of
 * rettfrabonden.com / finn-tannlege.com / opplevagent.no (MCP/A2A/REST),
 * plus an aggregate per-key usage ledger. NOT a paywall — anonymous access
 * must remain byte-for-byte identical to today. A key just grants a higher
 * rate-limit tier (see middleware/security.ts keyedMax()) and gets the
 * caller a usage record.
 *
 * THE regression-critical invariant (see
 * consumer-identity-anonymous-regression.test.ts): if `X-API-Key` is absent,
 * `consumerIdentity` calls next() immediately and does nothing else — no DB
 * read, no req/res mutation. If the header is present but doesn't match an
 * active key (unknown, malformed, revoked, or erased), it is treated
 * EXACTLY as if absent — an invalid/optional key must never become an error
 * response. Only a present + valid + active key attaches req.consumerKeyId
 * and records one aggregate ledger increment.
 *
 * Mount ONCE, globally, before the rate limiters and before every
 * MCP/A2A/REST router (src/index.ts) — same "one shared, domain-agnostic
 * middleware" pattern already used for aiCrawlerAllowlist / langMiddleware /
 * linkHeaders, so it applies uniformly across all three domains without any
 * per-vertical wiring.
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../database/init";

// ─── Key generation / hashing ──────────────────────────────────────────
// Plaintext keys are never stored — only their sha256 hash (key_hash).
// The "rfb_" prefix is purely cosmetic (greppable in a consumer's own env
// files / support tickets); it carries no meaning to the server.
export function generateApiKey(): string {
  return "rfb_" + crypto.randomBytes(32).toString("hex");
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

interface ActiveKeyRow {
  id: number;
  rate_tier: string;
}

function lookupActiveKey(keyHash: string): ActiveKeyRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, rate_tier FROM consumer_api_keys
       WHERE key_hash = ? AND revoked_at IS NULL AND deleted_at IS NULL`
    )
    .get(keyHash) as ActiveKeyRow | undefined;
}

// ─── endpoint_or_tool inference ─────────────────────────────────────────
// Aggregate-only, by design: this NEVER records call arguments/content,
// only a short label for which tool/route was hit.
//   - JSON-RPC (MCP/A2A) POST body with a `method`: use the method name,
//     except `tools/call` (MCP) whose actual tool lives in params.name.
//   - Everything else (plain REST GET/POST/...): "<METHOD> <path>".
export function endpointOrToolFor(req: Request): string {
  const body: unknown = (req as any).body;
  if (req.method === "POST" && body && typeof body === "object" && !Array.isArray(body)) {
    const method = (body as any).method;
    if (typeof method === "string" && method.length > 0) {
      if (method === "tools/call") {
        const toolName = (body as any)?.params?.name;
        if (typeof toolName === "string" && toolName.length > 0) return toolName;
      }
      return method;
    }
  }
  return `${req.method} ${req.path}`;
}

// ─── Ledger upsert-increment ────────────────────────────────────────────
// UNIQUE(key_id, endpoint_or_tool, day) on consumer_usage_ledger makes this
// an increment of the existing row, not an insert-per-call — N calls to the
// same endpoint/tool on the same day is exactly one row with call_count=N.
// Never throws: a logging failure must never surface as a request error
// (mirrors services/mcp-usage-logger.ts's insertUsageRow).
function recordUsage(keyId: number, endpointOrTool: string): void {
  try {
    const db = getDb();
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
    db.prepare(
      `INSERT INTO consumer_usage_ledger (key_id, endpoint_or_tool, day, call_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(key_id, endpoint_or_tool, day)
       DO UPDATE SET call_count = call_count + 1`
    ).run(keyId, endpointOrTool, day);
  } catch (err) {
    console.error("[consumer-identity] ledger upsert failed:", err);
  }
}

// req.consumerKeyId / req.consumerRateTier are read by:
//   - middleware/security.ts's keyedMax() (rate-limit differentiation)
//   - anything downstream wanting to know "this call came from a known key"
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      consumerKeyId?: number;
      consumerRateTier?: string;
    }
  }
}

export function consumerIdentity(req: Request, res: Response, next: NextFunction): void {
  const headerKey = req.header("X-API-Key");

  // ── Fallthrough path: absent header → do NOTHING else. ──────────────
  // No DB read, no req/res mutation, no timing side-channel beyond a single
  // header lookup. This is the byte-identical-with-today invariant.
  if (!headerKey) {
    next();
    return;
  }

  let row: ActiveKeyRow | undefined;
  try {
    row = lookupActiveKey(hashApiKey(headerKey));
  } catch (err) {
    // A DB hiccup here must never turn an optional, voluntary key into a
    // hard failure — fail open to the anonymous path, same as "not found".
    console.error("[consumer-identity] lookup failed:", err);
    next();
    return;
  }

  // Unknown / malformed / revoked / erased key → treated EXACTLY like an
  // absent header. Never an error response — this is optional identity,
  // not required auth.
  if (!row) {
    next();
    return;
  }

  req.consumerKeyId = row.id;
  req.consumerRateTier = row.rate_tier;

  // Fire-and-forget ledger write, after the response is already on its way
  // out — mirrors services/mcp-usage-logger.ts's res.on("finish") pattern so
  // logging can never delay or alter the real response.
  res.on("finish", () => {
    recordUsage(row!.id, endpointOrToolFor(req));
  });

  next();
}
