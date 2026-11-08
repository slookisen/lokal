#!/usr/bin/env node
// Builds dist/ for the production image: `node --enable-source-maps dist/index.js`.
// Run from the repo root after `tsc --noEmit` (the type check). Used by `npm run build`
// and by the Dockerfile build stage, so the build and the asset list live here only.
//
// 1. JavaScript: each file tsconfig.json compiles is transpiled on its own (no bundle)
//    with esbuild, using the options tsx uses when it runs src/ today (CommonJS,
//    target = this node version, keepNames, source maps). Why not tsc's emit: tsc
//    keeps an `import` at its position in the file, so the require() runs there.
//    src/ has ~140 imports placed after top-level code (e.g. opplevelser.ts uses
//    NON_DRINK_PRODUCER_TYPES at module level before its import further down), and
//    tsc's output stops at boot with "Cannot access ... before initialization".
//    esbuild hoists imports, as ES modules do and as tsx (the dev, test and old prod
//    runtime) does, so the output runs the same way as today. Dynamic import() is
//    lowered to require() (see `supported` below).
// 2. Runtime files that are not TypeScript, read via __dirname-relative paths or
//    require()d .json, are copied to the same place under dist/:
//      src/public/          -> dist/public/  (express.static, sendFile, public-file.ts,
//                                             experiences-seo.ts, agentplatform-site.ts)
//      src/data/*.json      -> dist/data/    (fylke-2024-migration.ts, norway-postnummer.ts,
//                                             local-orgnr-candidates.ts, dental-import-display.ts)
//      src/**/*.json        -> dist/**       (other required .json, e.g. i18n/locales/*.json)
// 3. Fails if a file the running app needs is missing.

"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

function fail(msg) {
  console.error(`build-dist: ${msg}`);
  process.exit(1);
}

// Same file set tsc compiles (tsconfig include/exclude: no tests, _seeds or sdk).
const configPath = path.join(root, "tsconfig.json");
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => fail(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
});
if (!parsed) fail("could not read tsconfig.json");
const entryPoints = parsed.fileNames.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
if (entryPoints.length === 0) fail("tsconfig.json matched no .ts files");

fs.rmSync(dist, { recursive: true, force: true });

const result = esbuild.buildSync({
  entryPoints,
  outbase: src,
  outdir: dist,
  bundle: false,
  format: "cjs",
  platform: "node",
  target: `node${process.versions.node}`,
  keepNames: true,
  // `await import("./services/x")` (41 call sites) uses extensionless relative paths.
  // tsx resolves those through its loader; plain node's ESM resolver does not
  // (ERR_MODULE_NOT_FOUND). Lowered to require(), as tsc's commonjs emit does too.
  // Every call site reads named exports, which require() returns the same way.
  supported: { "dynamic-import": false },
  sourcemap: true,
  tsconfig: configPath,
  logLevel: "warning",
});
if (result.errors.length > 0) fail(`esbuild reported ${result.errors.length} error(s)`);

// Every .json under src/ that tsconfig covers (i18n/locales, data/*.json, ...), same relative path.
// src/public is copied whole below.
const publicSrc = path.join(src, "public");
function copyJson(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (p === publicSrc || entry.name === "_seeds" || entry.name === "sdk") continue;
      copyJson(p);
    } else if (entry.name.endsWith(".json")) {
      const out = path.join(dist, path.relative(src, p));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(p, out);
    }
  }
}
copyJson(src);

// src/public -> dist/public (whole tree: the same files express.static serves under tsx today).
fs.cpSync(publicSrc, path.join(dist, "public"), { recursive: true });

const REQUIRED = [
  "index.js",
  "public/app.html",
  "data/local-orgnr-candidates.json",
  "data/kommune-fylke-2024.json",
  "data/postnummer-kommune-2026.json",
  "data/dental-import-2026-05.json",
  "i18n/locales/no.json",
  "services/offthread-stats-worker.js",
  "services/offsite-backup-worker.js",
];
const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(dist, rel)));
if (missing.length > 0) fail(`missing in dist/: ${missing.join(", ")}`);

console.log(`build-dist: ${entryPoints.length} files transpiled, runtime assets copied, required files present`);
