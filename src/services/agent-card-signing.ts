/**
 * agent-card-signing.ts — JWS signing for A2A Agent Cards + JWKS publishing.
 *
 * dev-request 2026-07-13-a2a-card-v1-signing, slice 2.
 *
 * Spec grounding (a2aproject/A2A):
 *   - AgentCard.signatures[] (field 13) is an array of AgentCardSignature:
 *     { protected: string, signature: string, header?: object }.
 *   - 8.4.1 Canonicalization: canonicalize with JSON Canonicalization Scheme
 *     (JCS, RFC 8785) before signing. The `signatures` field itself MUST be
 *     excluded from the content being signed.
 *   - 8.4.2 Signature Format: JWS per RFC 7515. Protected header MUST include
 *     `alg` (here "EdDSA", since our key is Ed25519) and `kid`.
 *
 * One Ed25519 signing key, shared across all three verticals (one Fly app
 * "lokal" serves rettfrabonden.com + finn-tannlege.com + opplevagent.no), so
 * one key ID for all of them.
 *
 * No npm crypto/JWS library is installed and none is added here — everything
 * below is built on Node's native `crypto` module only.
 */

import * as crypto from "crypto";
import type { KeyObject } from "crypto";

export const SIGNING_KEY_ID = "lokal-a2a-2026";

// ─── RFC 8785 JSON Canonicalization Scheme (JCS) — minimal implementation ──
// Sufficient for plain JSON data (strings/numbers/booleans/null/arrays/
// objects). Our card payloads never contain NaN/Infinity or numbers whose
// serialization is contentious, so we lean on JS's own JSON.stringify
// semantics for primitives (JCS does not require any extra Unicode escaping
// beyond normal JSON string rules — only object-key ordering and the absence
// of insignificant whitespace are load-bearing here).
export function canonicalizeJCS(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    // JSON.stringify(NaN/Infinity) already yields "null" via JSON semantics
    // for numbers we don't expect to encounter; nothing further to do here.
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJCS(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined) // JSON.stringify drops undefined-valued keys too
      .sort(); // JCS: object keys sorted by UTF-16 code unit order
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJCS(obj[k])}`);
    return `{${entries.join(",")}}`;
  }
  // Functions/symbols/undefined at the top level — JSON.stringify would
  // return undefined; canonicalize to "null" defensively rather than throw.
  return "null";
}

// ─── base64url (no padding) ────────────────────────────────────────────────
// Node has natively supported the 'base64url' Buffer encoding since v15.7+
// (confirmed present on this Node 22 runtime), so no hand-rolled replace()
// logic is needed.
function base64url(input: Buffer): string {
  return input.toString("base64url");
}

// ─── Signing key (memoized) ────────────────────────────────────────────────
let cachedKeyPair: { privateKey: KeyObject; publicKey: KeyObject } | null | undefined;
let warnedOnce = false;

function getSigningKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } | null {
  if (cachedKeyPair !== undefined) return cachedKeyPair;

  const pem = process.env.A2A_SIGNING_PRIVATE_KEY;
  if (!pem || !pem.trim()) {
    cachedKeyPair = null;
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "agent-card-signing: A2A_SIGNING_PRIVATE_KEY is not set — agent cards will be served unsigned."
      );
    }
    return null;
  }

  try {
    const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      cachedKeyPair = null;
      if (!warnedOnce) {
        warnedOnce = true;
        // Never log the key material itself — not even in an error message.
        console.warn(
          "agent-card-signing: A2A_SIGNING_PRIVATE_KEY is set but could not be parsed — agent cards will be served unsigned."
        );
      }
      return cachedKeyPair;
    }
    const publicKey = crypto.createPublicKey(privateKey);
    cachedKeyPair = { privateKey, publicKey };
  } catch {
    cachedKeyPair = null;
    if (!warnedOnce) {
      warnedOnce = true;
      // Never log the key material itself — not even in an error message.
      console.warn(
        "agent-card-signing: A2A_SIGNING_PRIVATE_KEY is set but could not be parsed — agent cards will be served unsigned."
      );
    }
  }
  return cachedKeyPair;
}

// Test-only: forces the next getSigningKeyPair() call to re-read the env var
// and reset the one-warning-per-process latch. Not used by any production
// call site.
export function __resetSigningKeyForTesting(): void {
  cachedKeyPair = undefined;
  warnedOnce = false;
}

/**
 * Signs `card` (as given — callers must NOT include a `signatures` key when
 * calling this) and returns the AgentCardSignature array to attach as
 * `card.signatures`. Returns [] (never throws) if no signing key is
 * configured.
 */
export function signAgentCard(card: object): Array<{ protected: string; signature: string }> {
  const keyPair = getSigningKeyPair();
  if (!keyPair) return [];

  const protectedHeader = { alg: "EdDSA", kid: SIGNING_KEY_ID };
  const protectedB64 = base64url(Buffer.from(JSON.stringify(protectedHeader), "utf8"));
  const payloadB64 = base64url(Buffer.from(canonicalizeJCS(card), "utf8"));
  const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, "ascii");
  const signature = crypto.sign(null, signingInput, keyPair.privateKey);
  const signatureB64 = base64url(signature);

  return [{ protected: protectedB64, signature: signatureB64 }];
}

/**
 * Returns the JWKS document for the platform's A2A signing key(s). Returns
 * `{ keys: [] }` (never throws) if no signing key is configured.
 */
export function getJWKS(): {
  keys: Array<{ kty: string; crv: string; x: string; kid: string; use: string; alg: string }>;
} {
  const keyPair = getSigningKeyPair();
  if (!keyPair) return { keys: [] };

  const jwk = keyPair.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return {
    keys: [
      {
        ...jwk,
        kid: SIGNING_KEY_ID,
        use: "sig",
        alg: "EdDSA",
      },
    ],
  };
}
