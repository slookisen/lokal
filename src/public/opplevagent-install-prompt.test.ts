/**
 * opplevagent-install-prompt.test.ts — unit + smoke tests for
 * src/public/opplevagent-install-prompt.js (the opplevagent.no host's
 * "Add to home screen" install-prompt UX).
 *
 * dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering, extending
 * dev-request 2026-07-04-app-strategi-pwa (previously rfb-only, PRs
 * #225/#245) to opplevagent.no. Mirrors src/public/install-prompt.test.ts's
 * structure exactly, minus the express.static HTTP smoke test — unlike
 * src/public/install-prompt.js (auto-served on rettfrabonden.com via
 * express.static), opplevagent-install-prompt.js is NOT reachable through
 * express.static at all: the opplevagent.no host-gate in src/index.ts routes
 * every non-API path into experiencesSeoRouter's explicit GET
 * /install-prompt.js route instead. That HTTP-level "actually served with
 * 200, and the served body wires up beforeinstallprompt" check lives in
 * experiences-seo-pwa.test.ts, which drives the real router.handle() rather
 * than a throwaway express.static mount.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/public/opplevagent-install-prompt.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevagentInstallPromptTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import * as vm from "vm";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeWindow(standalone: boolean): any {
  return {
    matchMedia(query: string) {
      return { matches: standalone && query.indexOf("standalone") !== -1 };
    },
  };
}

export async function runOpplevagentInstallPromptTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const scriptPath = join(__dirname, "opplevagent-install-prompt.js");

  assertTrue(existsSync(scriptPath), "opplevagent-install-prompt.js exists on disk");

  const source = readFileSync(scriptPath, "utf8");
  try {
    new vm.Script(source, { filename: scriptPath });
    assertTrue(true, "opplevagent-install-prompt.js is syntactically valid JS (parses via vm.Script)");
  } catch (err) {
    assertTrue(false, `opplevagent-install-prompt.js is syntactically valid JS (parse error: ${err instanceof Error ? err.message : String(err)})`);
  }

  // Brand colors: opplevagent's coral button, not rfb's forest green. Scoped
  // to the actual "background:#…" CSS declaration (not the whole file) so
  // this doesn't false-positive on the doc comment above, which mentions
  // rfb's #2D5016 by name for context.
  assertTrue(source.includes("background:#ff5d3b"), "opplevagent-install-prompt.js's button background is coral (#ff5d3b)");
  assertTrue(!source.includes("background:#2D5016"), "opplevagent-install-prompt.js's button background is NOT rfb's forest-green (#2D5016)");

  delete require.cache[require.resolve("./opplevagent-install-prompt.js")];
  const mod = require("./opplevagent-install-prompt.js") as { shouldShowInstallButton: (win?: any) => boolean };

  assertTrue(typeof mod.shouldShowInstallButton === "function",
    "opplevagent-install-prompt.js exports a shouldShowInstallButton function");

  assertTrue(mod.shouldShowInstallButton(fakeWindow(false)) === true,
    "shouldShowInstallButton is true when NOT in standalone display-mode (button may show)");
  assertTrue(mod.shouldShowInstallButton(fakeWindow(true)) === false,
    "shouldShowInstallButton is false when already running in standalone display-mode (never show)");

  assertTrue(mod.shouldShowInstallButton({}) === true,
    "shouldShowInstallButton fails open (true) when matchMedia is unavailable");

  const throwingWindow = { matchMedia() { throw new Error("boom"); } };
  assertTrue(mod.shouldShowInstallButton(throwingWindow) === true,
    "shouldShowInstallButton fails open (true) when matchMedia throws");

  return { passed, failed, failures };
}

if (require.main === module) {
  runOpplevagentInstallPromptTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
