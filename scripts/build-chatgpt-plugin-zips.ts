/**
 * Builds the ChatGPT plugin ZIPs for Rett fra Bonden and Opplevagent
 * (portable format: plugin.json + mcp.json + assets/logo.png) from the
 * submission files in the repo root. See src/services/chatgpt-plugin-package.ts.
 *
 *   npx tsx scripts/build-chatgpt-plugin-zips.ts [--out dist/chatgpt-plugins]
 *       [--demo-rettfrabonden-no <url>] [--demo-opplevagent-no <url>]
 *
 * Refuses to write a package that fails the final-submission checks.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import {
  PLUGIN_APPS, buildMcpJson, buildPluginManifest, validatePluginManifest, type SubmissionFile,
} from "../src/services/chatgpt-plugin-package";

const ROOT = path.join(__dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate, no directories, fixed 1980-01-01 timestamp so builds are reproducible). */
function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0x81a40000, 38); // external attrs: regular file, rw-r--r-- (0o100644 << 16)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const outDir = path.resolve(ROOT, arg("--out") ?? "dist/chatgpt-plugins");
fs.mkdirSync(outDir, { recursive: true });
let failed = false;

for (const spec of PLUGIN_APPS) {
  const submission = JSON.parse(fs.readFileSync(path.join(ROOT, spec.submissionFile), "utf8")) as SubmissionFile;
  const manifest = buildPluginManifest(spec, submission, { demoRecordingUrl: arg(`--demo-${spec.name}`) });
  const mcp = buildMcpJson(spec);
  const errors = validatePluginManifest(manifest, mcp);
  if (errors.length) {
    failed = true;
    console.error(`✗ ${spec.name}:\n  ${errors.join("\n  ")}`);
    continue;
  }
  const files = [
    { name: "plugin.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
    { name: "mcp.json", data: Buffer.from(JSON.stringify(mcp, null, 2) + "\n", "utf8") },
    { name: "assets/logo.png", data: fs.readFileSync(path.join(ROOT, spec.logoSource)) },
  ];
  const dir = path.join(outDir, spec.name);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.name), f.data);
  }
  const zipPath = path.join(outDir, `${spec.name}-${spec.version}.zip`);
  fs.writeFileSync(zipPath, zip(files));
  const demo = (manifest as any).extensions["com.openai"].review.demo_recording_url;
  console.log(`✓ ${path.relative(ROOT, zipPath)}${demo ? "" : "  (no demo_recording_url: add it in the dashboard or pass --demo-" + spec.name + ")"}`);
}

process.exit(failed ? 1 : 0);
