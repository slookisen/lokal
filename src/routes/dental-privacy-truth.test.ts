/**
 * dental-privacy-truth.test.ts — dev-request
 * 2026-10-06-personvernerklaeringer-del-a-na-del-b-pa-t, del A.
 *
 * Proves Finn-tannlege.com's /personvern (dental-seo.ts) no longer carries the
 * published factual errors, and that each claim it makes about hosting, data
 * and vendors matches the code:
 *
 *   1. Hosting region: the page says Stockholm / arn, never Frankfurt; fly.toml
 *      has primary_region = 'arn'.
 *   2. «utelukkende virksomhetsdata» is gone: dental_persons stores personal
 *      data (navn, hpr_nr, specialties, own_orgnr, fylke_residence) and the
 *      page says so.
 *   3. «Ingen persondata overføres utenfor EU/EØS» is gone: the page names the
 *      US vendors and says personal data may be transferred to the USA. Each
 *      vendor is checked in code (Turnstile on /kontakt, Anthropic judge,
 *      Resend inbound + outgoing, Gmail admin mailbox).
 *   4. The page does not claim a specific transfer mechanism (DPF/SCC) that the
 *      code cannot prove, and does not describe itself as ehandelsloven § 8.
 *
 * Standalone: npx tsx src/routes/dental-privacy-truth.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function invokeGet(router: any, routePath: string): { found: boolean; body: string } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, body: "" };
  let body = "";
  const res: any = {
    status() { return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang: "no", params: {}, query: {}, headers: {}, get() { return undefined; } };
  layer.route.stack[layer.route.stack.length - 1].handle(req, res, () => { /* next() */ });
  return { found: true, body };
}

export async function runDentalPrivacyTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere */ }
  } catch { /* routes fall back to defaults */ }

  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");
  const flyToml = read("..", "..", "fly.toml");
  const initDental = read("..", "database", "init-dental.ts");
  const dentalSeoSrc = read("dental-seo.ts");
  const judge = read("..", "services", "dental-catalog-class-judge.ts");
  const inbound = read("..", "services", "inbound-email-webhook.ts");
  const emailSvc = read("..", "services", "email-service.ts");
  const contactSrc = read("contact.ts");

  // ── Ground truth from the code ──────────────────────────────────────────
  assertTrue(/primary_region = 'arn'/.test(flyToml), "ground truth: fly.toml primary_region is arn (Stockholm)");
  assertTrue(
    /CREATE TABLE IF NOT EXISTS dental_persons[\s\S]{0,300}navn TEXT NOT NULL[\s\S]{0,100}hpr_nr TEXT UNIQUE[\s\S]{0,100}primary_specialty[\s\S]{0,100}all_specialties[\s\S]{0,100}own_orgnr[\s\S]{0,100}fylke_residence/.test(initDental),
    "ground truth: dental_persons stores navn, hpr_nr, specialties, own_orgnr, fylke_residence"
  );
  assertTrue(
    /challenges\.cloudflare\.com\/turnstile/.test(dentalSeoSrc) && /verifyTurnstile/.test(contactSrc) && /createContactThread/.test(contactSrc),
    "ground truth: the /kontakt form loads Cloudflare Turnstile and the message is stored as a CRM thread"
  );
  assertTrue(
    /https:\/\/api\.anthropic\.com\/v1\/messages/.test(judge) && /navn, naeringskode, organisasjonsform/.test(judge),
    "ground truth: the dental catalog-class judge sends Brreg facts (navn, naeringskode, organisasjonsform, hjemmeside) to Anthropic"
  );
  assertTrue(
    /api\.resend\.com\/emails\/receiving/.test(inbound) && /@gmail\.com/.test(inbound) && /Resend verifies one domain/.test(emailSvc),
    "ground truth: e-mail goes through Resend and is forwarded to a Gmail mailbox"
  );

  // ── The page ────────────────────────────────────────────────────────────
  const router = require("./dental-seo").default as any;
  const r = invokeGet(router, "/personvern");
  assertTrue(r.found && r.body.length > 500, "GET /personvern renders");
  const html = r.body;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "-").replace(/\s+/g, " ");

  // 1. Region.
  assertTrue(!/Frankfurt/i.test(html), "no «Frankfurt» (the app runs in arn)");
  assertTrue(/arn \(Stockholm, Sverige\)/.test(text), "hosting is stated as arn (Stockholm, Sverige)");

  // 2. dental_persons.
  assertTrue(!/utelukkende (offentlig tilgjengelige )?virksomhetsdata/i.test(html), "«utelukkende virksomhetsdata» is gone");
  assertTrue(/navn, HPR-nummer, spesialitet\(er\)/.test(text), "the page says HPR data about dentists (navn, HPR-nummer, spesialitet) is stored");
  assertTrue(/enkeltpersonforetak/.test(text), "the page says sole-proprietorship names can be personal names");
  assertTrue(/\bFly\.io\b/.test(text) && /Cloudflare/.test(text) && /Anthropic/.test(text) && /Google \(Gmail\)/.test(text) && /Resend/.test(text),
    "all verified vendors are named: Fly.io, Cloudflare, Anthropic, Google (Gmail), Resend");

  // 3. Transfers.
  assertTrue(!/Ingen persondata overføres/i.test(html), "«Ingen persondata overføres utenfor EU/EØS» is gone");
  assertTrue(/overført til og behandlet i USA, utenfor EU\/EØS/.test(text), "the page says personal data may be transferred to the USA");
  assertTrue(/GDPR kapittel V/.test(text), "the page points to GDPR chapter V for the transfer basis");

  // 4. Nothing unverifiable.
  assertTrue(!/Data Privacy Framework|standardkontrakt|SCC/i.test(html), "no specific transfer mechanism is claimed (not provable from the code)");
  assertTrue(!/ehandelsloven/i.test(html), "the privacy page is not presented as ehandelsloven § 8 compliance");
  assertTrue(!/Frankfurt|Daniel Fredriksen/.test(html), "no stale Frankfurt / personal controller name");

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalPrivacyTruthTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
