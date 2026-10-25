/**
 * The `initialize.result.serverInfo` part of the MCP contract freezes
 * (src/routes/rfb-mcp-contract-freeze.test.ts and
 * src/routes/opplevagent-mcp-contract-freeze.test.ts).
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-A2. G3-S5
 * (dev-request 2026-10-16-merkevare-entitet-og-connector-pakker) keeps the
 * RFB and Opplevagent serverInfo as it is until OpenAI has decided on the
 * apps. The freezes hashed the instructions, tools/list and the resources but
 * not serverInfo, so `icons` added to the RFB serverInfo passed them
 * (mutation M8 in the lokal#1186 review). Both freezes now pin serverInfo the
 * same way:
 *
 *   - the whole object as canonical JSON (every object's keys sorted, arrays
 *     in their order), so the hash pins the fields and their values, not the
 *     order the code writes them in;
 *   - a mismatch fails with a message that says serverInfo has changed and
 *     shows the live serverInfo;
 *   - SERVER_INFO_CHANGES are the changes the hold is about, for the negative
 *     controls.
 */

import { createHash } from "node:crypto";

/** The part name for serverInfo in both fixtures (RFB puts the PAYMENTS_ENABLED variant in front). */
export const SERVER_INFO_PART = "initialize.serverInfo";

/** What a freeze reads from the live /mcp router: the hash of every frozen part, and each serverInfo under its part name. */
export interface LiveContract {
  hashes: Record<string, string>;
  serverInfo: Record<string, unknown>;
}

type ServerInfo = Record<string, unknown>;

/** JSON with every object's keys sorted, at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v);
}

/** SHA-256 of a serverInfo's canonical JSON (of null when initialize returned none). */
export function serverInfoHash(serverInfo: unknown): string {
  return createHash("sha256").update(canonicalJson(serverInfo ?? null)).digest("hex");
}

/** Null when the serverInfo hashes to the frozen hash; otherwise the failure, which says serverInfo has changed. */
export function serverInfoFreezeFailure(serverInfo: unknown, frozenHash: string): string | null {
  const hash = serverInfoHash(serverInfo);
  if (hash === frozenHash) return null;
  return "serverInfo has changed since the contract was frozen for the OpenAI review " +
    "(G3-S5 holds it until OpenAI has decided; change the fixture only together with a planned re-submission)\n" +
    `    frozen: ${frozenHash}\n` +
    `    live:   ${hash} ${canonicalJson(serverInfo ?? null)}`;
}

/** The serverInfo changes the G3-S5 hold is about, each applied to a live serverInfo (negative controls). */
export const SERVER_INFO_CHANGES: ReadonlyArray<readonly [string, (serverInfo: ServerInfo) => ServerInfo]> = [
  ["icons added (M8)", (s) => ({ ...s, icons: [{ src: "https://example.invalid/icon-512.png", mimeType: "image/png", sizes: ["512x512"] }] })],
  ["title changed or added", (s) => ({ ...s, title: `${String(s.title ?? s.name)} (changed)` })],
  ["description changed or added", (s) => ({ ...s, description: `${String(s.description ?? s.name)} (changed)` })],
  ["websiteUrl changed or added", (s) => ({ ...s, websiteUrl: "https://example.invalid/" })],
  ["version changed", (s) => ({ ...s, version: `${String(s.version)}-changed` })],
  ["name changed", (s) => ({ ...s, name: `${String(s.name)}-changed` })],
  ["its last field removed", (s) => Object.fromEntries(Object.entries(s).slice(0, -1))],
];

/** The same value with every object's keys in reverse order, at every depth (arrays keep their order). */
export function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
  }
  return value;
}
