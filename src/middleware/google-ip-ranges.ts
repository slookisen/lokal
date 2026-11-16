/**
 * google-ip-ranges.ts — dev-request 2026-11-12-g1-google-klar, slice G1-2.
 *
 * Google's published outbound address ranges for MCP calls made by Google
 * (Gemini "connected apps" / Google-Agent), and a pure CIDR matcher for
 * them. Read by middleware/mcp-rate-limit.ts, and only when
 * MCP_RATE_LIMIT_GOOGLE_RANGES_ENABLED is "true": then a call from one of
 * these ranges counts in ONE shared Google bucket instead of a per-IP bucket.
 *
 * Static on purpose: nothing here fetches anything at runtime. Sources, read
 * 2026-11-15 (report: docs/2026-11-15-g1-2-skriveverktoy-og-google-ip.md):
 *
 *  1. GOOGLE_CONNECTED_APPS_CIDRS — the "Google outbound CIDR blocks" a
 *     remote MCP server should allow, listed verbatim on
 *       https://developers.google.com/connected-apps/gpc/prerequisites
 *       https://developers.google.com/connected-apps/mcp/server-optimization
 *  2. GOOGLE_USER_TRIGGERED_AGENTS_CIDRS — every prefix of
 *       https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json
 *     (creationTime 2026-11-13T15:45:59), the ranges of `Google-Agent`
 *     ("agents hosted on Google infrastructure ... act on user request"),
 *     which the connected-apps prerequisites page names as a published list
 *     to read. 136.121.40.0/21 and the 74.125.232.x/28 entries overlap list 1;
 *     overlaps are harmless.
 *
 * Deliberately NOT included: user-triggered-fetchers-google.json (504
 * prefixes for Google's other user-triggered fetchers — Feedfetcher, Site
 * Verifier, …), and goog.json (all of Google's address space, incl. Google
 * Cloud customers' egress). Google's pages say the ranges change over time;
 * refreshing this list is a code change with a new date above.
 */

import { isIPv4, isIPv6 } from "net";

export const GOOGLE_IP_RANGES_SOURCE_DATE = "2026-11-15";

export const GOOGLE_CONNECTED_APPS_CIDRS: readonly string[] = [
  "108.177.64.0/20",
  "142.250.88.0/22",
  "172.217.80.0/20",
  "192.178.20.0/22",
  "192.179.0.0/20",
  "74.125.232.0/24",
  "136.121.40.0/21",
];

export const GOOGLE_USER_TRIGGERED_AGENTS_CIDRS: readonly string[] = [
  "2001:4860:c::/124",
  "2001:4860:c::10/124",
  "2001:4860:c::20/124",
  "2001:4860:c::30/124",
  "2001:4860:c::40/124",
  "2001:4860:c::50/124",
  "2001:4860:c::60/124",
  "2001:4860:c::70/124",
  "136.121.16.0/24",
  "136.121.24.0/21",
  "136.121.40.0/21",
  "136.122.0.0/16",
  "74.125.232.0/28",
  "74.125.232.112/28",
  "74.125.232.16/28",
  "74.125.232.32/28",
  "74.125.232.48/28",
  "74.125.232.64/28",
  "74.125.232.80/28",
  "74.125.232.96/28",
];

export const GOOGLE_MCP_CIDRS: readonly string[] = [...GOOGLE_CONNECTED_APPS_CIDRS, ...GOOGLE_USER_TRIGGERED_AGENTS_CIDRS];

// ─── Pure address parsing ────────────────────────────────────────────────────
interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseIPv4(s: string): bigint | null {
  if (!isIPv4(s)) return null;
  return s.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function parseIPv6(s: string): bigint | null {
  if (!isIPv6(s)) return null;
  let text = s;
  // A dotted IPv4 tail (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) becomes
  // its two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const V4_MAPPED_PREFIX = 0xffffn << 32n; // ::ffff:0:0/96

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d, as Node reports an IPv4
// client on a dual-stack socket) is treated as the IPv4 address it carries.
export function parseIp(raw: string): ParsedIp | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.includes("%")) return null; // no zone ids
  const v4 = parseIPv4(s);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === V4_MAPPED_PREFIX >> 32n) return { version: 4, value: v6 & 0xffffffffn };
  return { version: 6, value: v6 };
}

interface ParsedCidr {
  version: 4 | 6;
  network: bigint;
  mask: bigint;
}

function parseCidr(cidr: string): ParsedCidr | null {
  if (typeof cidr !== "string") return null;
  const slash = cidr.indexOf("/");
  if (slash < 0) return null;
  const addr = cidr.slice(0, slash);
  const lenText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(lenText)) return null;
  const len = Number(lenText);
  // The CIDR's own address must be literal IPv4 or IPv6 (no mapped-form
  // reinterpretation here: a range is written in its own family).
  const v4 = parseIPv4(addr);
  const version: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 !== null ? v4 : parseIPv6(addr);
  if (value === null) return null;
  const bits = version === 4 ? 32 : 128;
  if (len > bits) return null;
  const all = (1n << BigInt(bits)) - 1n;
  const mask = len === 0 ? 0n : (all << BigInt(bits - len)) & all;
  return { version, network: value & mask, mask };
}

// True when `ip` lies inside `cidr`. IPv4 and IPv6; an IPv4-mapped IPv6
// address matches IPv4 ranges. Anything unparsable (either side) → false.
export function ipInCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip);
  const c = parseCidr(cidr);
  if (!a || !c || a.version !== c.version) return false;
  return (a.value & c.mask) === c.network;
}

// Parsed once; the request path only parses the client address.
const PARSED_GOOGLE_MCP_CIDRS: readonly ParsedCidr[] = GOOGLE_MCP_CIDRS.map((c) => {
  const p = parseCidr(c);
  if (!p) throw new Error(`google-ip-ranges: invalid CIDR ${c}`);
  return p;
});

export function isGoogleMcpIp(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const a = parseIp(ip);
  if (!a) return false;
  return PARSED_GOOGLE_MCP_CIDRS.some((c) => c.version === a.version && (a.value & c.mask) === c.network);
}
