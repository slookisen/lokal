/**
 * chatgpt-plugin-package.test.ts — the ChatGPT plugin packages built from
 * the two submission files must pass the final-submission limits OpenAI
 * documents (plugins/deploy/submission-errors), so a package that would be
 * refused at "Submit for review" fails here first.
 *
 *   p1-p6   both packages validate: listing limits, category, four HTTPS
 *           listing URLs, 5 positive + 3 negative cases, one streamable-http
 *           MCP server at the production /mcp URL
 *   p7-p9   mapping: publisher is the company, negative cases carry their
 *           expected answer, no demo URL unless one is passed
 *   p10     the logo files are square PNGs of at least 48 px
 *   v1-v5   the validator catches what final submission rejects
 *
 * Standalone: npx tsx src/services/chatgpt-plugin-package.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  PLUGIN_APPS, buildMcpJson, buildPluginManifest, validatePluginManifest, type SubmissionFile,
} from "./chatgpt-plugin-package";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ROOT = path.join(__dirname, "../..");

export function runChatgptPluginPackageTests(opts: { log?: boolean } = {}): TestSummary {
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
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  try {
    for (const spec of PLUGIN_APPS) {
      const submission = JSON.parse(fs.readFileSync(path.join(ROOT, spec.submissionFile), "utf8")) as SubmissionFile;
      const manifest: any = buildPluginManifest(spec, submission);
      const mcp: any = buildMcpJson(spec);
      const errors = validatePluginManifest(manifest, mcp);
      const ext = manifest.extensions["com.openai"];
      assertTrue(errors.length === 0, `p1: ${spec.name} passes the final-submission checks (${errors.join("; ") || "no errors"})`);
      assertTrue(ext.interface.displayName === submission.app_info.display_name && ext.interface.longDescription === submission.app_info.description,
        `p2: ${spec.name} listing text comes from ${spec.submissionFile}`);
      assertTrue(ext.review.test_cases.positive.length === 5 && ext.review.test_cases.negative.length === 3,
        `p3: ${spec.name} carries five positive and three negative cases`);
      assertTrue(ext.review.test_cases.positive.every((c: any, i: number) => c.prompt === submission.test_cases[i].user_prompt && c.expected_behavior === submission.test_cases[i].expected_output),
        `p4: ${spec.name} positive cases keep the submitted prompt and expected result`);
      assertTrue(JSON.stringify(Object.values(mcp.mcpServers)) === JSON.stringify([{ type: "streamable-http", url: spec.mcpUrl }]) && spec.mcpUrl === `${spec.site}/mcp`,
        `p5: ${spec.name} mcp.json declares the one production MCP server`);
      assertTrue(["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"].every((k) => ext.interface[k].startsWith(spec.site)),
        `p6: ${spec.name} listing URLs are on its own site`);
      assertTrue(ext.interface.developerName === "AGENTPLATFORM.NO AS" && manifest.author.name === "AGENTPLATFORM.NO AS",
        `p7: ${spec.name} publisher is AGENTPLATFORM.NO AS, the operator the legal pages name`);
      assertTrue(ext.review.test_cases.negative.every((c: any, i: number) => c.description.includes(`Expected: ${submission.negative_test_cases[i].expected_output}`)),
        `p8: ${spec.name} negative cases carry their expected answer in the description`);
      assertTrue(!("demo_recording_url" in ext.review) && (buildPluginManifest(spec, submission, { demoRecordingUrl: "https://youtu.be/x" }) as any).extensions["com.openai"].review.demo_recording_url === "https://youtu.be/x",
        `p9: ${spec.name} has no demo URL unless one is passed (the old videos predate the fixes)`);
      const png = fs.readFileSync(path.join(ROOT, spec.logoSource));
      const w = png.readUInt32BE(16);
      const h = png.readUInt32BE(20);
      assertTrue(png.subarray(1, 4).toString() === "PNG" && w === h && w >= 48, `p10: ${spec.name} logo is a square PNG of at least 48 px (${w}x${h})`);
    }

    const spec = PLUGIN_APPS[0];
    const submission = JSON.parse(fs.readFileSync(path.join(ROOT, spec.submissionFile), "utf8")) as SubmissionFile;
    const base = () => JSON.parse(JSON.stringify(buildPluginManifest(spec, submission)));
    const mcp = buildMcpJson(spec);
    let m = base();
    m.extensions["com.openai"].interface.displayName = "Rett fra Bonden — lokal mat fra hele Norge";
    assertTrue(validatePluginManifest(m, mcp).some((e) => e.startsWith("displayName")), "v1: a display name over 30 characters is caught");
    m = base();
    m.extensions["com.openai"].interface.category = "Food";
    assertTrue(validatePluginManifest(m, mcp).some((e) => e.startsWith("category")), "v2: a category the portal does not list is caught");
    m = base();
    m.extensions["com.openai"].review.test_cases.positive.pop();
    assertTrue(validatePluginManifest(m, mcp).some((e) => e.includes("five positive")), "v3: four positive cases are caught");
    m = base();
    m.extensions["com.openai"].interface.brandColor = "#A8E6A0";
    assertTrue(validatePluginManifest(m, mcp).some((e) => e.startsWith("brandColor")), "v4: a brand colour without 2:1 contrast on white is caught");
    assertTrue(validatePluginManifest(base(), { mcpServers: {} }).some((e) => e.startsWith("mcp.json")), "v5: a package without its MCP server is caught");
  } catch (err: any) {
    failed++;
    failures.push("chatgpt-plugin-package: unexpected error: " + String(err?.stack || err));
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const s = runChatgptPluginPackageTests({ log: true });
  console.log(`\n${s.passed} passed, ${s.failed} failed`);
  for (const f of s.failures) console.log(f);
  process.exit(s.failed > 0 ? 1 : 0);
}
