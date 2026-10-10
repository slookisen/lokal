/**
 * chatgpt-plugin-package.ts — builds the ChatGPT plugin packages (portable
 * Agent Plugins format: root plugin.json + mcp.json + assets/) for Rett fra
 * Bonden and Opplevagent from the two submission files in the repo root.
 *
 * Why (ChatGPT pre-submission check 2026-10-10): both apps were submitted
 * through OpenAI's previous app form and were never published. In today's
 * plugin portal they show "Configuration unavailable" under MCPs, Rescan is
 * disabled, and a ZIP update is refused with "Publish the existing MCP app
 * before updating its plugin ZIP" — the update flow needs a published
 * version. A new plugin uploaded from a complete ZIP (with mcp.json, which
 * the portal reads the MCP setup from) is the route that does not need
 * OpenAI support. The publisher also moves from the individual identity to
 * AGENTPLATFORM.NO AS, which the public legal pages now name.
 *
 * chatgpt-app-submission.json / opplevagent-chatgpt-app-submission.json stay
 * the single source for listing text, test cases and release notes; this
 * module only maps them onto the package fields documented at
 * developers.openai.com/plugins/deploy/submission and validates the public
 * submission limits from /plugins/deploy/submission-errors, so a package
 * that would fail final submission fails `npm test` first.
 *
 * Not packaged on purpose:
 *   - review.demo_recording_url unless a URL is passed: the old videos
 *     predate the fixes and must be re-recorded. Left out, the field stays
 *     editable in the dashboard.
 *   - review.commerce: a declaration Daniel makes in the dashboard.
 *   - .app.json / apps: ZIPs with app references cannot be submitted.
 *   - annotation justifications: no longer required (plugin guidelines).
 */

import { COMPANY_INFO } from "../config/company-info";

export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** interface.category values the portal accepts (submission-errors: plugin_category_unknown). */
export const PLUGIN_CATEGORIES = [
  "Productivity", "Creativity", "Developer Tools", "Business & Operations", "Data & Analytics",
  "Communication", "Education & Research", "Security", "Finance", "Healthcare", "Travel",
  "Entertainment", "Other",
] as const;

export interface PluginAppSpec {
  /** Package identifier. Deliberately not the old app's identity: this is uploaded as a new plugin. */
  name: string;
  version: string;
  /** Repo-root file holding app_info, test cases and release notes. */
  submissionFile: string;
  mcpServerName: string;
  mcpUrl: string;
  site: string;
  category: (typeof PLUGIN_CATEGORIES)[number];
  capabilities: string[];
  /** Starter prompts (max 3); taken from the positive test cases so they are known to work. */
  defaultPrompt: string[];
  brandColor: string;
  /** Square PNG in the repo, copied to assets/logo.png. */
  logoSource: string;
  keywords: string[];
}

export const PLUGIN_APPS: readonly PluginAppSpec[] = [
  {
    name: "rettfrabonden-no",
    version: "1.1.0",
    submissionFile: "chatgpt-app-submission.json",
    mcpServerName: "rettfrabonden",
    mcpUrl: "https://rettfrabonden.com/mcp",
    site: "https://rettfrabonden.com",
    // There is no food category; "Other" is the portal's catch-all.
    category: "Other",
    capabilities: [
      "Search Norwegian food producers by place and product",
      "Show a producer's contact details and listed products",
      "Assemble a pickup order; payment happens at pickup, never in chat",
    ],
    defaultPrompt: [
      "Where can I buy reindeer meat in Finnmark?",
      "Which farms in Innlandet sell lamb?",
      "Where can I buy stockfish in Lofoten?",
    ],
    brandColor: "#3F7F2A",
    logoSource: "src/public/logo-512.png",
    keywords: ["norway", "local food", "farm shop", "producers"],
  },
  {
    name: "opplevagent-no",
    version: "1.1.0",
    submissionFile: "opplevagent-chatgpt-app-submission.json",
    mcpServerName: "opplevagent",
    mcpUrl: "https://opplevagent.no/mcp",
    site: "https://opplevagent.no",
    category: "Travel",
    capabilities: [
      "Search Norwegian experiences by county, category, season and weather",
      "Show one experience's details and the provider's own page",
      "Find farm-sale drink producers and send a visit request",
    ],
    defaultPrompt: [
      "Hva kan vi finne på i Troms om vinteren?",
      "Find wildlife and animal experiences in Norway",
      "Finn gårdssalg og lokale drikkeprodusenter i Vestland",
    ],
    brandColor: "#047857",
    logoSource: "src/public/opplevagent-favicon-512.png",
    keywords: ["norway", "travel", "experiences", "activities"],
  },
];

interface SubmissionCase {
  description: string;
  user_prompt: string;
  tools_triggered: string | null;
  expected_output: string;
}

export interface SubmissionFile {
  app_info: { display_name: string; subtitle: string; description: string };
  test_cases: SubmissionCase[];
  negative_test_cases: SubmissionCase[];
  release_notes: string;
}

export function buildPluginManifest(
  spec: PluginAppSpec,
  submission: SubmissionFile,
  opts: { demoRecordingUrl?: string } = {},
): Record<string, unknown> {
  const info = submission.app_info;
  const review: Record<string, unknown> = {
    test_cases: {
      positive: submission.test_cases.map((c) => ({
        description: c.description,
        prompt: c.user_prompt,
        tools_triggered: c.tools_triggered ?? "",
        expected_behavior: c.expected_output,
      })),
      // The package format has no expected-behaviour field for negative
      // cases, so the expected answer travels in the description.
      negative: submission.negative_test_cases.map((c) => ({
        description: `${c.description} Expected: ${c.expected_output}`,
        prompt: c.user_prompt,
      })),
    },
  };
  if (opts.demoRecordingUrl) review.demo_recording_url = opts.demoRecordingUrl;

  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: spec.name,
    version: spec.version,
    description: info.subtitle,
    author: { name: COMPANY_INFO.legalName, email: COMPANY_INFO.email, url: COMPANY_INFO.website },
    homepage: spec.site,
    keywords: spec.keywords,
    extensions: {
      "com.openai": {
        interface: {
          displayName: info.display_name,
          shortDescription: info.subtitle,
          longDescription: info.description,
          developerName: COMPANY_INFO.legalName,
          category: spec.category,
          capabilities: spec.capabilities,
          websiteURL: spec.site,
          supportURL: `${spec.site}/kontakt`,
          privacyPolicyURL: `${spec.site}/personvern`,
          termsOfServiceURL: `${spec.site}/vilkar`,
          defaultPrompt: spec.defaultPrompt,
          brandColor: spec.brandColor,
          composerIcon: "./assets/logo.png",
          logo: "./assets/logo.png",
        },
        review,
        publication: { release_notes: submission.release_notes },
      },
    },
  };
}

export function buildMcpJson(spec: PluginAppSpec): Record<string, unknown> {
  return {
    $schema: MCP_SCHEMA_URL,
    mcpServers: { [spec.mcpServerName]: { type: "streamable-http", url: spec.mcpUrl } },
  };
}

function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const ONE_LINE = /^[^\r\n\u2028\u2029]+$/;
const HTTPS = /^https:\/\/[^\s/@]+(\/\S*)?$/;

/** Errors a final directory submission would report for this manifest; [] when it passes. */
export function validatePluginManifest(manifest: any, mcp: any): string[] {
  const errors: string[] = [];
  const ui = manifest?.extensions?.["com.openai"]?.interface ?? {};
  const review = manifest?.extensions?.["com.openai"]?.review ?? {};
  const oneLine = (v: unknown, max: number, field: string) => {
    if (typeof v !== "string" || !v.trim() || !ONE_LINE.test(v) || v.length > max) errors.push(`${field}: required, one line, at most ${max} characters`);
  };

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest?.name ?? "") || manifest.name.length > 64) errors.push("name: lowercase letters, digits and single hyphens, at most 64 characters");
  if (!/^\d+\.\d+\.\d+$/.test(manifest?.version ?? "")) errors.push("version: semantic version");
  oneLine(ui.displayName, 30, "displayName");
  oneLine(ui.shortDescription, 30, "shortDescription");
  if (typeof ui.longDescription !== "string" || !ui.longDescription.trim() || ui.longDescription.length > 4000) errors.push("longDescription: required, at most 4000 characters");
  oneLine(ui.developerName, 80, "developerName");
  if (!PLUGIN_CATEGORIES.includes(ui.category)) errors.push(`category: must be one of ${PLUGIN_CATEGORIES.join(", ")}`);
  if (!Array.isArray(ui.capabilities) || ui.capabilities.length > 20) errors.push("capabilities: at most 20");
  for (const c of ui.capabilities ?? []) oneLine(c, 120, "capability");
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (typeof ui[key] !== "string" || !HTTPS.test(ui[key]) || ui[key].length > 1024) errors.push(`${key}: required HTTPS URL for MCP review`);
  }
  const prompts: string[] = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : [];
  if (prompts.length > 3) errors.push("defaultPrompt: at most 3");
  for (const p of prompts) {
    oneLine(p, 128, "defaultPrompt");
    if (/@/.test(p)) errors.push("defaultPrompt: no @mentions");
  }
  if (new Set(prompts.map((p) => p.normalize("NFKC").replace(/\s+/g, " ").trim())).size !== prompts.length) errors.push("defaultPrompt: must be unique");
  if (ui.brandColor !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(ui.brandColor)) errors.push("brandColor: #RRGGBB");
    else if ((1.05) / (relativeLuminance(ui.brandColor) + 0.05) < 2) errors.push("brandColor: needs at least 2:1 contrast against white");
  }
  if (typeof ui.logo !== "string" || !ui.logo.startsWith("./")) errors.push("logo: ./-relative path to the primary icon");

  const positive = review?.test_cases?.positive ?? [];
  const negative = review?.test_cases?.negative ?? [];
  if (positive.length !== 5) errors.push(`review: exactly five positive test cases (got ${positive.length})`);
  if (negative.length !== 3) errors.push(`review: exactly three negative test cases (got ${negative.length})`);
  for (const c of positive) {
    if (!c.description || !c.prompt || !c.tools_triggered || !c.expected_behavior) errors.push(`positive case "${c.prompt}": description, prompt, tools_triggered and expected_behavior are required`);
    if ((c.description ?? "").length > 4000) errors.push("positive case description: at most 4000 characters");
  }
  for (const c of negative) {
    if (!c.description || !c.prompt) errors.push(`negative case "${c.prompt}": description and prompt are required`);
  }
  if ("test_credentials" in review || "reviewer_instructions" in review) errors.push("review: credentials and reviewer instructions are entered in the dashboard, never in the ZIP");

  const servers = Object.values(mcp?.mcpServers ?? {}) as any[];
  if (servers.length !== 1) errors.push("mcp.json: exactly one MCP server (plugin-level test cases need one)");
  for (const s of servers) {
    if (s?.type !== "streamable-http" || typeof s?.url !== "string" || !HTTPS.test(s.url)) errors.push("mcp.json: a streamable-http server with an HTTPS url");
  }
  return errors;
}
