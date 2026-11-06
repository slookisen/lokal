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

/**
 * G3-S5 for RFB and Opplevagent: what is wrong with a live serverInfo against
 * its BRAND_ENTITIES entry; empty when nothing is. title leads with the brand
 * name, websiteUrl is the brand URL, icons[0] is the brand's 512×512 logo as
 * image/png (the entry has no 192 icon yet, so it is the only icon).
 */
export function brandServerInfoProblems(
  serverInfo: unknown,
  brand: { name: string; url: string; logoPng: string | null },
): string[] {
  const s = (serverInfo ?? {}) as Record<string, any>;
  const problems: string[] = [];
  if (typeof s.title !== "string" || !s.title.startsWith(`${brand.name} — `)) problems.push(`title does not lead with «${brand.name} — » (${JSON.stringify(s.title)})`);
  if (s.websiteUrl !== brand.url) problems.push(`websiteUrl is not ${brand.url} (${JSON.stringify(s.websiteUrl)})`);
  const icon = Array.isArray(s.icons) ? s.icons[0] : undefined;
  if (!icon) problems.push("no icons[0]");
  else {
    if (icon.src !== brand.logoPng || !String(icon.src).endsWith(".png")) problems.push(`icons[0].src is not the brand PNG logo (${JSON.stringify(icon.src)})`);
    if (icon.mimeType !== "image/png") problems.push(`icons[0].mimeType is not image/png (${JSON.stringify(icon.mimeType)})`);
    if (JSON.stringify(icon.sizes) !== JSON.stringify(["512x512"])) problems.push(`icons[0].sizes is not ["512x512"] (${JSON.stringify(icon.sizes)})`);
  }
  return problems;
}
