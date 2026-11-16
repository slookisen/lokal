/**
 * a2a-protocol-version.test.ts — A2A dev-request F1-4: the A2A agent cards
 * declare the A2A protocol version the server actually speaks, from ONE
 * constant (services/a2a-protocol-version.ts).
 *
 * AK1, per server (RFB, Opplevagent, Finn-tannlege):
 *   1. Every card route (GET /a2a, /.well-known/agent-card.json, and the
 *      legacy /.well-known/agent.json or /agent-card.json alias) answers 200
 *      with `protocolVersion === A2A_PROTOCOL_VERSION`.
 *   2. The same server's POST /a2a answers a v0.3 `message/send` (handled,
 *      not -32601 "Method not found"), and the answer's parts carry the v0.3
 *      `kind` discriminator. No response carries a version header, so the
 *      tie between card and wire is the v0.3 method name and part shape.
 *      RFB also answers `agent/authenticatedExtendedCard`, whose result card
 *      must carry the same protocolVersion.
 *   3. Opplevagent and Finn-tannlege answer the v1.0 name `SendMessage`
 *      with -32601: they do not speak v1.0, so a card saying "1.0.0" would
 *      be wrong.
 *   4. With a signing key configured, each card's JWS signature verifies
 *      over the content that carries the new protocolVersion.
 *
 * Routers are driven directly (router.handle), as in a2a-spam-guard.test.ts.
 * Own in-memory DBs (RFB init.ts, dental/experiences db-factory), restored in
 * finally; Kartverket is stubbed (no network).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/a2a-protocol-version.test.ts
 *   2. Wired into the gate: tests/test.ts calls runA2aProtocolVersionTests().
 */

import crypto from "crypto";
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { A2A_PROTOCOL_VERSION } from "../services/a2a-protocol-version";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, method: "GET" | "POST", url: string, body?: unknown, ip = "198.51.100.77"): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
    const req: any = {
      method, url, originalUrl: url, path: url, query: {}, params: {}, headers, body, ip,
      socket: { remoteAddress: ip }, connection: { remoteAddress: ip },
      get: (name: string) => headers[name.toLowerCase()],
      header: (name: string) => headers[name.toLowerCase()],
    };
    const res: any = {
      statusCode: 200, headersSent: false, locals: {}, _headers: {} as Record<string, string>,
      setHeader(name: string, value: unknown) { this._headers[name.toLowerCase()] = String(value); return this; },
      getHeader(name: string) { return this._headers[name.toLowerCase()]; },
      header(name: string, value: unknown) { return this.setHeader(name, value); },
      set(name: string, value: unknown) { return this.setHeader(name, value); },
      removeHeader() {}, append() { return this; }, on() { return this; }, once() { return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) {
        this.headersSent = true;
        let parsed = payload;
        if (typeof payload === "string") { try { parsed = JSON.parse(payload); } catch { /* text */ } }
        resolve({ status: this.statusCode, body: parsed });
        return this;
      },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined }));
  });
}

/** Every part of a JSON-RPC result (task artifacts and/or message parts). */
function resultParts(result: any): any[] {
  const parts: any[] = [];
  for (const a of result?.artifacts ?? []) parts.push(...(a?.parts ?? []));
  for (const a of result?.task?.artifacts ?? []) parts.push(...(a?.parts ?? []));
  parts.push(...(result?.parts ?? []));
  parts.push(...(result?.message?.parts ?? []));
  parts.push(...(result?.status?.message?.parts ?? []));
  return parts;
}

/** Verifies a card's JWS signature (canonical JSON of the card without `signatures`) against the JWKS key. */
function signatureVerifies(card: any, publicKey: crypto.KeyObject): boolean {
  const { canonicalizeJCS } = require("../services/agent-card-signing") as typeof import("../services/agent-card-signing");
  const sig = card?.signatures?.[0];
  if (!sig) return false;
  const { signatures: _drop, ...unsigned } = card;
  const payloadB64 = Buffer.from(canonicalizeJCS(unsigned), "utf8").toString("base64url");
  const input = Buffer.from(`${sig.protected}.${payloadB64}`, "ascii");
  return crypto.verify(null, input, publicKey, Buffer.from(sig.signature, "base64url"));
}

export async function runA2aProtocolVersionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  assertEq(A2A_PROTOCOL_VERSION, "0.3.0", "constant: the server speaks A2A 0.3.0");

  // ── isolation: RFB DB, dental/experiences DBs, Kartverket, signing key ──
  const prevRfbDb = __peekDbForTesting();
  const rfbDb = new Database(":memory:");
  rfbDb.pragma("journal_mode = DELETE");
  __setDbForTesting(rfbDb as any);
  __initSchemaForTesting(rfbDb as any);

  const prevEnv = {
    dental: process.env.DENTAL_DB_PATH,
    exp: process.env.EXPERIENCES_DB_PATH,
    key: process.env.A2A_SIGNING_PRIVATE_KEY,
  };
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
  dbFactory.__resetDbFactoryForTesting();

  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch);
  __clearGeocodeCacheForTesting();

  const signing = require("../services/agent-card-signing") as typeof import("../services/agent-card-signing");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  process.env.A2A_SIGNING_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  signing.__resetSigningKeyForTesting();

  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* silence */ }; console.warn = () => { /* silence */ }; }

  try {
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      loadConfigsAtBoot();
    } catch { /* already loaded elsewhere */ }

    const rfbA2a = (require("./a2a") as any).default;
    const dentalA2a = (require("./dental-a2a") as any).default;
    const dentalSeo = (require("./dental-seo") as any).default;
    const expA2a = (require("./experiences-a2a") as any).default;
    const expSeo = (require("./experiences-seo") as any).default;

    const servers: Array<{
      name: string;
      cards: Array<[any, string]>;
      a2a: any;
      query: string;
      speaksV1Names: boolean;
    }> = [
      {
        name: "rfb",
        cards: [[rfbA2a, "/a2a"], [rfbA2a, "/.well-known/agent-card.json"], [rfbA2a, "/.well-known/agent.json"]],
        a2a: rfbA2a,
        query: "honning i Oslo",
        speaksV1Names: true, // aliases only; answers in the same v0.3 shapes
      },
      {
        name: "opplevagent",
        cards: [[expA2a, "/a2a"], [expSeo, "/.well-known/agent-card.json"], [expSeo, "/agent-card.json"]],
        a2a: expA2a,
        query: "opplevelser i Oslo",
        speaksV1Names: false,
      },
      {
        name: "finn-tannlege",
        cards: [[dentalA2a, "/a2a"], [dentalSeo, "/.well-known/agent-card.json"], [dentalSeo, "/agent-card.json"]],
        a2a: dentalA2a,
        query: "tannlege i Oslo",
        speaksV1Names: false,
      },
    ];

    let ipSeq = 0;
    const ip = () => `10.77.0.${++ipSeq}`;

    for (const s of servers) {
      // 1 + 4: every card route, 200, the constant, a signature over it
      for (const [router, path] of s.cards) {
        const r = await callRoute(router, "GET", path, undefined, ip());
        assertEq(r.status, 200, `${s.name} GET ${path}: 200`);
        assertEq(r.body?.protocolVersion, A2A_PROTOCOL_VERSION, `${s.name} GET ${path}: protocolVersion is A2A_PROTOCOL_VERSION`);
        assertTrue(typeof r.body?.version === "string" && r.body.version.length > 0, `${s.name} GET ${path}: the agent's own version is still there`);
        assertTrue(signatureVerifies(r.body, publicKey), `${s.name} GET ${path}: JWS signature verifies over the card with the new protocolVersion`);
      }

      // 2: the same server's /a2a answers a v0.3 message/send in v0.3 part shape
      const send = await callRoute(s.a2a, "POST", "/a2a", {
        jsonrpc: "2.0", id: `f14-${s.name}`, method: "message/send",
        params: { message: { role: "user", messageId: `m-${s.name}`, parts: [{ kind: "text", text: s.query }] } },
      }, ip());
      assertEq(send.status, 200, `${s.name} POST /a2a message/send: 200`);
      assertTrue(send.body?.error?.code !== -32601, `${s.name} POST /a2a message/send: handled (not -32601 Method not found)`);
      assertTrue(send.body?.result !== undefined && send.body?.error === undefined, `${s.name} POST /a2a message/send: a result, no error (${JSON.stringify(send.body?.error ?? null)})`);
      const parts = resultParts(send.body?.result);
      assertTrue(parts.length > 0 && parts.every((p) => typeof p?.kind === "string"),
        `${s.name} POST /a2a message/send: every answer part carries the v0.3 \`kind\` discriminator`);

      // 3: v1.0 method names
      const v1 = await callRoute(s.a2a, "POST", "/a2a", {
        jsonrpc: "2.0", id: `f14-v1-${s.name}`, method: "SendMessage",
        params: { message: { role: "user", messageId: `m1-${s.name}`, parts: [{ kind: "text", text: s.query }] } },
      }, ip());
      if (s.speaksV1Names) {
        assertTrue(v1.body?.error?.code !== -32601, `${s.name} POST /a2a SendMessage: accepted as an alias of message/send`);
      } else {
        assertEq(v1.body?.error?.code, -32601, `${s.name} POST /a2a SendMessage (A2A v1.0 name): -32601, the server does not speak v1.0`);
      }
    }

    // 2 (RFB): the extended card in a JSON-RPC answer carries the same version
    const ext = await callRoute(rfbA2a, "POST", "/a2a", { jsonrpc: "2.0", id: "f14-ext", method: "agent/authenticatedExtendedCard", params: {} }, ip());
    assertEq(ext.body?.result?.card?.protocolVersion, A2A_PROTOCOL_VERSION,
      "rfb POST /a2a agent/authenticatedExtendedCard: the answered card's protocolVersion is A2A_PROTOCOL_VERSION");
  } catch (err: any) {
    failed++;
    failures.push("a2a protocol version: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    if (prevEnv.key === undefined) delete process.env.A2A_SIGNING_PRIVATE_KEY;
    else process.env.A2A_SIGNING_PRIVATE_KEY = prevEnv.key;
    signing.__resetSigningKeyForTesting();
    if (prevEnv.dental === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevEnv.dental;
    if (prevEnv.exp === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevEnv.exp;
    try { dbFactory.__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    if (prevRfbDb) __setDbForTesting(prevRfbDb as any);
    try { rfbDb.close(); } catch { /* already closed */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runA2aProtocolVersionTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
