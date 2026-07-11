/**
 * install-prompt.test.ts — unit + smoke tests for
 * src/public/install-prompt.js (the rfb host's "Add to home screen"
 * install-prompt UX).
 *
 * dev-request 2026-07-04-app-strategi-pwa, slice 3 of 3: install-prompt UX
 * (rfb host only — same scope note as manifest.test.ts's slice 1).
 *
 * Three kinds of checks:
 *   1. The script file exists and is syntactically valid JS (parseable by
 *      Node's `vm` module without throwing a SyntaxError).
 *   2. The pure `shouldShowInstallButton` guard (already-installed /
 *      standalone-mode check), exercised directly via a fake `window` with a
 *      stubbed `matchMedia` — no DOM needed.
 *   3. An HTTP smoke test: spins a throwaway express.static server (same
 *      approach as src/index.ts's own `express.static(public)` mount) and
 *      confirms `GET /install-prompt.js` returns 200 with a JS content-type.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/public/install-prompt.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runInstallPromptTests() and folds its pass/fail counts into the
 *      `npm test` summary (see manifest.test.ts for the precedent this
 *      follows).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import * as vm from "vm";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// A minimal fake `matchMedia` so the pure guard can be exercised without a
// real DOM. `standalone` controls whether `(display-mode: standalone)`
// reports as matching.
function fakeWindow(standalone: boolean): any {
  return {
    matchMedia(query: string) {
      return { matches: standalone && query.indexOf("standalone") !== -1 };
    },
  };
}

export async function runInstallPromptTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const scriptPath = join(__dirname, "install-prompt.js");

  // ── 1. file exists + is syntactically valid ──────────────────────────
  assertTrue(existsSync(scriptPath), "install-prompt.js exists on disk");

  const source = readFileSync(scriptPath, "utf8");
  try {
    new vm.Script(source, { filename: scriptPath });
    assertTrue(true, "install-prompt.js is syntactically valid JS (parses via vm.Script)");
  } catch (err) {
    assertTrue(false, `install-prompt.js is syntactically valid JS (parse error: ${err instanceof Error ? err.message : String(err)})`);
  }

  // ── 2. pure shouldShowInstallButton guard ─────────────────────────────
  // require()-ing the file itself exercises the real CommonJS export path
  // (module.exports = { shouldShowInstallButton }) rather than a re-implemented
  // copy, and is safe under plain Node because the file guards all
  // window/document access behind `typeof window === "undefined"` checks.
  delete require.cache[require.resolve("./install-prompt.js")];
  const mod = require("./install-prompt.js") as { shouldShowInstallButton: (win?: any) => boolean };

  assertTrue(typeof mod.shouldShowInstallButton === "function",
    "install-prompt.js exports a shouldShowInstallButton function");

  assertTrue(mod.shouldShowInstallButton(fakeWindow(false)) === true,
    "shouldShowInstallButton is true when NOT in standalone display-mode (button may show)");
  assertTrue(mod.shouldShowInstallButton(fakeWindow(true)) === false,
    "shouldShowInstallButton is false when already running in standalone display-mode (never show)");

  // No matchMedia at all (very old browser / odd embed) — guard fails open
  // rather than throwing, so a busted environment doesn't wedge the button
  // permanently hidden nor crash the page.
  assertTrue(mod.shouldShowInstallButton({}) === true,
    "shouldShowInstallButton fails open (true) when matchMedia is unavailable");

  // matchMedia that throws — guard still returns a boolean instead of
  // propagating the exception.
  const throwingWindow = { matchMedia() { throw new Error("boom"); } };
  assertTrue(mod.shouldShowInstallButton(throwingWindow) === true,
    "shouldShowInstallButton fails open (true) when matchMedia throws");

  // ── 3. HTTP smoke test — throwaway express.static server ─────────────
  const app = express();
  app.use(express.static(join(__dirname)));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/install-prompt.js`);
    assertTrue(res.status === 200, `GET /install-prompt.js → 200 (got ${res.status})`);
    const contentType = res.headers.get("content-type") || "";
    assertTrue(/javascript/.test(contentType),
      `GET /install-prompt.js Content-Type is JS-flavored (got "${contentType}")`);
    const body = await res.text();
    assertTrue(body.includes("beforeinstallprompt"),
      "served install-prompt.js body wires up the beforeinstallprompt listener");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runInstallPromptTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
