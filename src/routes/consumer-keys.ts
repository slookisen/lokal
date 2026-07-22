/**
 * consumer-keys.ts — self-service, voluntary API-key issuance/revoke/erase
 * for AI-agent CONSUMERS of the platform.
 *
 * dev-request 2026-07-13-agent-identity-usage-ledger, slice 1 (L4,
 * Daniel-authorized 2026-07-20:
 * daniel-responses/2026-07-20-go-usage-ledger-og-supply-graph.md).
 *
 * Invariant (see the dev-request's confirm-understanding section): keys are
 * FREE and VOLUNTARY forever — this is not a paywall, not a login system,
 * and never a hard-auth requirement. There is no account/session model, so
 * possession-of-the-key IS the auth for revoke/erase (same posture as e.g.
 * a magic-link token or a Stripe API secret — whoever holds the string can
 * act on it).
 *
 *   POST /api/keys          — issue a new key (rate-limited, anti-spam)
 *   POST /api/keys/revoke   — holder revokes their own key (ledger kept)
 *   POST /api/keys/erase    — GDPR right-to-erasure (PII cleared)
 *
 * revoke/erase deliberately take the key in the JSON body (or X-API-Key
 * header) rather than a URL path segment (`/api/keys/:key/...`) — a secret
 * key in a URL ends up in access logs, proxy logs, and Referer headers;
 * POST + body/header keeps it out of all three. This is a deliberate
 * deviation from the dev-request's illustrative `DELETE /api/keys/:key`
 * example, made explicitly for this reason.
 */

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { generateApiKey, hashApiKey } from "../middleware/consumer-identity";

const router = Router();

// NOTE: rate-limiting for POST /keys (consumerKeyIssuanceLimiter) is applied
// in src/index.ts via `app.post("/api/keys", consumerKeyIssuanceLimiter)`,
// mounted just before this router — the same method+exact-path limiter
// convention already used there for e.g.
// `app.delete("/api/marketplace/agents/:id", adminLimiter)`. Kept OUT of
// this router file so revoke/erase are not accidentally caught by the
// issuance-specific quota, and so this router stays a plain Express router
// with no rate-limiter internals to fake in tests.

function keyFromRequest(req: Request): string | null {
  const bodyKey = req.body && typeof req.body.key === "string" ? req.body.key.trim() : "";
  if (bodyKey) return bodyKey;
  const headerKey = req.header("X-API-Key");
  return headerKey ? headerKey.trim() : null;
}

// POST /api/keys — issue a new, free, voluntary consumer API key.
// Body (all optional): { label?: string, contact_email?: string }
// Returns the plaintext key EXACTLY ONCE — only its sha256 hash is ever
// stored (consumer_api_keys.key_hash), so it can never be retrieved again.
router.post("/keys", (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 200)
        : null;
    const contactEmail =
      typeof body.contact_email === "string" && body.contact_email.trim().length > 0
        ? body.contact_email.trim().slice(0, 320)
        : null;

    const plaintextKey = generateApiKey();
    const keyHash = hashApiKey(plaintextKey);

    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO consumer_api_keys (key_hash, label, contact_email, rate_tier)
         VALUES (?, ?, ?, 'keyed')`
      )
      .run(keyHash, label, contactEmail);

    res.status(201).json({
      success: true,
      key: plaintextKey,
      key_id: result.lastInsertRowid,
      rate_tier: "keyed",
      label,
      contact_email: contactEmail,
      message:
        "Lagre denne nøkkelen nå — den vises aldri igjen og kan ikke hentes på nytt. " +
        "Send den som X-API-Key-header for høyere rate-grense og en egen forbrukslogg. Helt frivillig og gratis.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Kunne ikke utstede nøkkel", detail: err.message });
  }
});

// POST /api/keys/revoke — holder revokes their own key. Possession of the
// key IS the auth (no login system exists). Idempotent: revoking an
// already-revoked/unknown key still returns success:true with revoked:false
// — no oracle is given for "does this key exist" beyond that boolean, since
// an invalid/optional key must never surface as an error.
// Ledger history for the key is preserved — revoke ≠ erase.
router.post("/keys/revoke", (req: Request, res: Response) => {
  const rawKey = keyFromRequest(req);
  if (!rawKey) {
    res.status(400).json({ success: false, error: "key required (body.key or X-API-Key header)" });
    return;
  }
  try {
    const db = getDb();
    const keyHash = hashApiKey(rawKey);
    const result = db
      .prepare(
        `UPDATE consumer_api_keys SET revoked_at = datetime('now')
         WHERE key_hash = ? AND revoked_at IS NULL`
      )
      .run(keyHash);
    res.json({ success: true, revoked: result.changes > 0 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Revoke failed", detail: err.message });
  }
});

// POST /api/keys/erase — GDPR right-to-erasure minimum. Nulls the PII
// columns (label, contact_email) and stamps deleted_at; also revokes the
// key (an erased key must not keep working). Does NOT hard-delete the row —
// see the long comment on consumer_api_keys in database/init.ts for why
// (the row anchors consumer_usage_ledger's aggregate history, which is no
// longer personal data once the PII columns are gone).
router.post("/keys/erase", (req: Request, res: Response) => {
  const rawKey = keyFromRequest(req);
  if (!rawKey) {
    res.status(400).json({ success: false, error: "key required (body.key or X-API-Key header)" });
    return;
  }
  try {
    const db = getDb();
    const keyHash = hashApiKey(rawKey);
    const result = db
      .prepare(
        `UPDATE consumer_api_keys
         SET label = NULL, contact_email = NULL, deleted_at = datetime('now'),
             revoked_at = COALESCE(revoked_at, datetime('now'))
         WHERE key_hash = ? AND deleted_at IS NULL`
      )
      .run(keyHash);
    res.json({ success: true, erased: result.changes > 0 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Erase failed", detail: err.message });
  }
});

export default router;
