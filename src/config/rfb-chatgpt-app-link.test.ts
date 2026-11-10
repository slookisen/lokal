/**
 * rfb-chatgpt-app-link.test.ts — OpenAI retires Custom GPTs on 2026-12-11.
 *
 * Every Rett fra Bonden "ChatGPT" link must point to the RFB ChatGPT app
 * (RFB_CHATGPT_APP_URL in config/distribution-channels.ts), never to the retiring
 * RFB Custom GPT. Locks:
 *   (a) no file under src/ (.ts/.html/.js, this file excluded) carries the old RFB GPT id;
 *   (b) the rfb distribution-channel entry uses the app link;
 *   (c) the Opplevagent and Finn tannlege Custom GPT links are unchanged;
 *   (d) the homepage buttons, llms.txt line and static app.html carry the app link.
 *
 * Exported runRfbChatgptAppLinkTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/config/rfb-chatgpt-app-link.test.ts
 */
import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const SRC = path.resolve(__dirname, "..");
// Split so this file never contains the retired id as one literal.
const OLD_RFB_GPT_ID = "69dbf8593c1c8191" + "9050f8da98cd327d";
const APP_URL = "https://chatgpt.com/plugins/plugin_asdk_app_6acbf3965a9881918afbcacd99a8e157";
const OPPLEVAGENT_GPT_ID = "6a3ab590a7f081919c528a15c6765a7d";
const DENTAL_GPT_ID = "6a21e79241cc8191a04642bda508e42b";

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function runRfbChatgptAppLinkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) { passed++; if (opts.log) console.log(`  ok   ${name}`); }
    else { failed++; failures.push(`${name}${detail ? ` (${detail})` : ""}`); if (opts.log) console.log(`  FAIL ${name} ${detail}`); }
  };

  // (a)
  const self = path.resolve(__filename);
  const hits = walk(SRC, [])
    .filter((f) => path.resolve(f) !== self)
    .filter((f) => fs.readFileSync(f, "utf8").includes(OLD_RFB_GPT_ID))
    .map((f) => path.relative(SRC, f));
  check("rfb-chatgpt-a: no src/ file links the retired RFB Custom GPT", hits.length === 0, hits.join(", "));

  // (b)
  const cfg = require("./distribution-channels") as typeof import("./distribution-channels");
  check("rfb-chatgpt-b1: RFB_CHATGPT_APP_URL is the RFB ChatGPT app link", cfg.RFB_CHATGPT_APP_URL === APP_URL, cfg.RFB_CHATGPT_APP_URL);
  const rfb = cfg.distributionFor("rfb", "https://example.test/.well-known/agent-card.json");
  const chatgpt = rfb.filter((c) => c.url.startsWith("https://chatgpt.com/"));
  check(
    "rfb-chatgpt-b2: the rfb ChatGPT distribution entry uses the app link (url + install + probe)",
    chatgpt.length === 1 && chatgpt[0].url === APP_URL && chatgpt[0].install === APP_URL && chatgpt[0].probe.url === APP_URL,
    JSON.stringify(chatgpt),
  );
  check(
    "rfb-chatgpt-b3: the rfb ChatGPT entry no longer says Custom GPT",
    chatgpt.length === 1 && !/custom gpt/i.test(chatgpt[0].description) && /ChatGPT app/.test(chatgpt[0].description),
    chatgpt[0]?.description,
  );

  // (c)
  const cfgSrc = fs.readFileSync(path.join(__dirname, "distribution-channels.ts"), "utf8");
  check("rfb-chatgpt-c1: Opplevagent Custom GPT id still in distribution-channels.ts", cfgSrc.includes(OPPLEVAGENT_GPT_ID));
  check("rfb-chatgpt-c2: Finn tannlege Custom GPT id still in distribution-channels.ts", cfgSrc.includes(DENTAL_GPT_ID));
  check("rfb-chatgpt-c3: OPPLEVAGENT_CUSTOM_GPT_URL unchanged", cfg.OPPLEVAGENT_CUSTOM_GPT_URL.includes(OPPLEVAGENT_GPT_ID));
  const dental = cfg.distributionFor("dental", "https://example.test/.well-known/agent-card.json").find((c) => c.channel === "custom-gpt");
  check("rfb-chatgpt-c4: dental custom-gpt entry still points to the Finn tannlege GPT", !!dental && dental.url.includes(DENTAL_GPT_ID));

  // (d)
  const seoSrc = fs.readFileSync(path.join(SRC, "routes", "seo.ts"), "utf8");
  check(
    "rfb-chatgpt-d1: both homepage ChatGPT links in seo.ts read RFB_CHATGPT_APP_URL",
    (seoSrc.match(/href="\$\{RFB_CHATGPT_APP_URL\}"[^>]*>[^<]*ChatGPT<\/a>/g) || []).length === 2,
  );
  const discSrc = fs.readFileSync(path.join(SRC, "routes", "discovery.ts"), "utf8");
  check(
    "rfb-chatgpt-d2: llms.txt names the ChatGPT app via RFB_CHATGPT_APP_URL",
    discSrc.includes("ChatGPT app — Rett fra Bonden: ${RFB_CHATGPT_APP_URL}"),
  );
  const appHtml = fs.readFileSync(path.join(SRC, "public", "app.html"), "utf8");
  check("rfb-chatgpt-d3: static app.html links the ChatGPT app", appHtml.includes(`href="${APP_URL}"`));

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbChatgptAppLinkTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
