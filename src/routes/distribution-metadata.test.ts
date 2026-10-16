/**
 * distribution-metadata.test.ts — dev-request 2026-10-16-distribusjon-synk, slice G1-S1.
 *
 * Static distribution files (npm/registry metadata, READMEs, connector listings, agent
 * registry entry, custom-GPT text) are IMMUTABLE once published, so they may never claim a
 * catalog size above the conservative floor in distribution/catalog-claims.json (honest
 * count rounded down to the hundred). The test parses "<number> <noun>" claims and requires
 * number <= floor for that noun's vertical.
 *
 * Also locks: root server.json == mcp-server/server.json (byte-identical), the lokal-mcp
 * description, package.json `files` ships server.json, websiteUrl on the other registry files.
 *
 * Exported runDistributionMetadataTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/distribution-metadata.test.ts
 */
import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const ROOT = path.resolve(__dirname, "..", "..");

type Vertical = "rfb" | "dental" | "opplevelser";

// noun -> vertical whose floor applies
const NOUNS: Record<string, Vertical> = {
  clinics: "dental", clinic: "dental", klinikker: "dental", tannleger: "dental", tannlegeklinikker: "dental",
  producers: "rfb", farms: "rfb", shops: "rfb", agents: "rfb", gårder: "rfb", gårdsbutikker: "rfb",
  matprodusenter: "rfb", produsenter: "rfb", butikker: "rfb",
  experiences: "opplevelser", opplevelser: "opplevelser", activities: "opplevelser", aktiviteter: "opplevelser",
};

// Frozen under review (OpenAI): never edited, so never scanned.
export const FROZEN_UNDER_REVIEW = [
  "chatgpt-app-submission.json",
  "opplevagent-chatgpt-app-submission.json",
  "opplevagent-connectors-prep/chatgpt-app/",
];

const NUM = "(\\d{1,3}(?:[ ,.\\u00a0]\\d{3})+|\\d{3,})";
// number, optional "+", up to two filler words (adjectives like "verified"), then a known noun
function claimRegex(): RegExp {
  const nouns = Object.keys(NOUNS).join("|");
  return new RegExp(`${NUM}\\s?\\+?(?:\\s+[\\p{L}'’-]+){0,2}?\\s+(${nouns})(?![\\p{L}])`, "giu");
}

export interface Claim { value: number; noun: string; vertical: Vertical; text: string }

export function parseClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const re = claimRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = parseInt(m[1].replace(/[ ,. ]/g, ""), 10);
    const noun = m[2].toLowerCase();
    out.push({ value, noun, vertical: NOUNS[noun], text: m[0] });
  }
  return out;
}

export function violations(text: string, floors: Record<Vertical, number>): Claim[] {
  return parseClaims(text).filter((c) => c.value > floors[c.vertical]);
}

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

export function scannedFiles(): string[] {
  const rel: string[] = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (/^mcp-server/.test(d) && fs.statSync(path.join(ROOT, d)).isDirectory()) {
      for (const f of ["package.json", "server.json", "manifest.json", "README.md"]) {
        if (fs.existsSync(path.join(ROOT, d, f))) rel.push(`${d}/${f}`);
      }
    }
    if (/-connectors-prep$/.test(d)) {
      for (const f of walk(path.join(ROOT, d), [".md"])) rel.push(path.relative(ROOT, f).split(path.sep).join("/"));
    }
  }
  for (const f of ["server.json", "README.md", "a2a-registry-entry.json", "custom-gpt-instructions.md"]) rel.push(f);
  return rel.filter((f) => !FROZEN_UNDER_REVIEW.some((x) => f === x || f.startsWith(x)));
}

export async function runDistributionMetadataTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) { passed++; if (opts.log) console.log(`  ok   ${name}`); }
    else { failed++; failures.push(`${name}${detail ? " — " + detail : ""}`); if (opts.log) console.log(`  FAIL ${name} ${detail}`); }
  };
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  const claims = JSON.parse(read("distribution/catalog-claims.json"));
  const floors = claims.floors as Record<Vertical, number>;
  check("dist-1 floors are rfb 1500 / dental 5400 / opplevelser 500",
    floors.rfb === 1500 && floors.dental === 5400 && floors.opplevelser === 500, JSON.stringify(floors));

  // parser self-checks (the test must bite)
  check("dist-2 parser flags '~6,900 clinics'", violations("MCP: ~6,900 clinics with Helfo", floors).length === 1);
  check("dist-3 parser flags '1,700+ farms'", violations("1,700+ farms, shops", floors).length === 1);
  check("dist-4 parser flags 'over 1600 matprodusenter'", violations("over 1600 matprodusenter", floors).length === 1);
  check("dist-5 parser accepts floors and equal numbers",
    violations("5,400+ clinics, 1,500+ farms, 500+ experiences", floors).length === 0);

  const files = scannedFiles();
  check("dist-6 scanned set covers the listed files",
    ["mcp-server/server.json", "mcp-server/package.json", "mcp-server/manifest.json", "mcp-server-dental/README.md",
      "README.md", "a2a-registry-entry.json", "custom-gpt-instructions.md",
      "dental-connectors-prep/claude-directory/listing.md"].every((f) => files.includes(f)));
  check("dist-7 frozen OpenAI files are not scanned",
    !files.some((f) => FROZEN_UNDER_REVIEW.some((x) => f === x || f.startsWith(x))));

  let total = 0;
  for (const f of files) {
    const v = violations(read(f), floors);
    total += parseClaims(read(f)).length;
    check(`dist-claims ${f}`, v.length === 0, v.map((c) => `"${c.text}" > ${floors[c.vertical]}`).join("; "));
  }
  check("dist-8 parser found claims in the scanned set (not vacuous)", total >= 8, String(total));

  // lokal-mcp registry metadata
  const rootSj = fs.readFileSync(path.join(ROOT, "server.json"));
  const pkgSj = fs.readFileSync(path.join(ROOT, "mcp-server/server.json"));
  check("dist-9 root server.json is byte-identical to mcp-server/server.json", rootSj.equals(pkgSj));
  const sj = JSON.parse(pkgSj.toString("utf8"));
  check("dist-10 lokal-mcp description", sj.description ===
    "Norwegian local-food MCP: 1,500+ farms, shops, markets + umbrellas (Bondens marked, Hanen, REKO).", sj.description);
  check("dist-11 lokal-mcp stays 0.4.1", sj.version === "0.4.1" && JSON.parse(read("mcp-server/package.json")).version === "0.4.1");
  check("dist-12 mcp-server/package.json files ships server.json",
    (JSON.parse(read("mcp-server/package.json")).files as string[]).includes("server.json"));
  check("dist-13 dental server.json websiteUrl", JSON.parse(read("mcp-server-dental/server.json")).websiteUrl === "https://finn-tannlege.com");
  check("dist-14 opplevagent server.json websiteUrl", JSON.parse(read("mcp-server-opplevagent/server.json")).websiteUrl === "https://opplevagent.no");
  check("dist-15 dental package versions are 0.2.0 (stdio bridge, G1-S2a)",
    JSON.parse(read("mcp-server-dental/package.json")).version === "0.2.0" && JSON.parse(read("mcp-server-dental/server.json")).version === "0.2.0");

  return { passed, failed, failures };
}

if (require.main === module) {
  runDistributionMetadataTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
