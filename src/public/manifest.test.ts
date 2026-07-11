/**
 * manifest.test.ts — unit tests for src/public/manifest.json (the rfb PWA
 * web app manifest).
 *
 * dev-request 2026-07-04-app-strategi-pwa, slice 1 of 3: manifest.json +
 * icons (rfb host only — dental/experiences have no brand PNG icon assets
 * yet, so they are deliberately out of scope for this slice).
 *
 * Pure file-content checks (no HTTP server, no DB) — reads the JSON off
 * disk, parses it, and asserts the required PWA fields are present and
 * well-formed.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/public/manifest.test.ts
 *   2. Wired into the gate: tests/test.ts imports runManifestTests() and
 *      folds its pass/fail counts into the `npm test` summary.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runManifestTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)})`
    );
  }

  const manifestPath = join(__dirname, "manifest.json");
  const raw = readFileSync(manifestPath, "utf8");

  let manifest: any = null;
  try {
    manifest = JSON.parse(raw);
    assertTrue(true, "manifest.json is valid JSON");
  } catch (err) {
    assertTrue(false, `manifest.json is valid JSON (parse error: ${err instanceof Error ? err.message : String(err)})`);
    return { passed, failed, failures };
  }

  assertEq(manifest.name, "Rett fra Bonden", "manifest.name is 'Rett fra Bonden'");
  assertEq(manifest.short_name, "Rett fra Bonden", "manifest.short_name is 'Rett fra Bonden'");
  assertTrue(typeof manifest.description === "string" && manifest.description.length > 0, "manifest.description is a non-empty string");
  assertEq(manifest.start_url, "/", "manifest.start_url is '/'");
  assertEq(manifest.display, "standalone", "manifest.display is 'standalone'");
  assertEq(manifest.background_color, "#ffffff", "manifest.background_color is '#ffffff'");
  assertEq(manifest.theme_color, "#2D5016", "manifest.theme_color matches the site's --forest-green brand color");

  assertTrue(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest.icons is a non-empty array");
  if (Array.isArray(manifest.icons)) {
    for (const icon of manifest.icons) {
      assertTrue(typeof icon.src === "string" && icon.src.length > 0, `icon ${JSON.stringify(icon.src)} has a non-empty src`);
      assertTrue(typeof icon.sizes === "string" && /^\d+x\d+$/.test(icon.sizes), `icon ${icon.src} has a valid sizes string (WxH)`);
      assertTrue(icon.type === "image/png", `icon ${icon.src} has type image/png`);
    }
    const srcs = manifest.icons.map((i: any) => i.src);
    assertTrue(srcs.includes("/logo-200.png"), "manifest.icons includes /logo-200.png (200x200)");
    assertTrue(srcs.includes("/logo-512.png"), "manifest.icons includes /logo-512.png (512x512)");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runManifestTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
