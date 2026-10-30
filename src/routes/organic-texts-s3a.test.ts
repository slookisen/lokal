/**
 * organic-texts-s3a.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S3a (AC3.3): platform texts
 * promise no organic / Debio coverage beyond Debio's public register.
 *
 *   (the live /mcp tool descriptions in routes/mcp.ts are frozen with the
 *   ChatGPT app review — rfb-mcp-contract-freeze — and are not covered here)
 *   llms      /llms.txt drops the old finnoko cross-check sentence (NO + EN)
 *             and describes the register flow; with the flag off it states
 *             the finnoko fallback instead (rollback stays truthful).
 *   proveniens /proveniens (NO + EN) likewise, flag on and off.
 *   static    src/mcp/server.ts, the A2A card and the agent-readiness card
 *             carry no organic search example.
 *
 * Standalone: npx tsx src/routes/organic-texts-s3a.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type InvokeResult = { found: boolean; status: number; body: string };

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): InvokeResult {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get
  );
  if (!layer) return { found: false, status: 0, body: "" };
  let status = 200;
  let body = "";
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
  };
  const req: any = { lang, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, status, body };
}

const OLD_NO = "oppgir økologisk sertifisering kryssjekkes";
const OLD_EN = "claiming organic certification are additionally cross-checked";
const OLD_PROV_NO = "sjekkes for produsenter som oppgir økologisk sertifisering";
const OLD_PROV_EN = "checked for producers associated with an organic certification claim";
const REG_NO = "Debios offentlige register";
const REG_EN = "Debio's public register";

export async function runOrganicTextsS3aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    try { loadConfigsAtBoot(); } catch { /* already loaded, or dir missing */ }
  } catch { /* defaults */ }

  const prevFlag = process.env.RFB_DEBIO_REGISTER_SYNC;
  try {
    // The live /mcp tool descriptions (src/routes/mcp.ts) are not changed in
    // S3a: the RFB MCP contract is frozen while OpenAI reviews the ChatGPT app
    // (rfb-mcp-contract-freeze.test.ts); they follow with a re-submission.

    // ── static sources (stdio server, A2A card, agent-readiness) ───────────
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const stdio = src("mcp/server.ts");
    assertTrue(!stdio.includes("organic honey") && !stdio.includes("organic produce"), "mcp/server.ts: no organic search example / produce claim");
    assertTrue(!stdio.includes('"Tags: organic,'), "mcp/server.ts: organic is not offered as a plain tag");
    const a2a = src("routes/a2a.ts");
    assertTrue(!a2a.includes("Find organic farms"), "a2a card: no «Find organic farms» example");
    assertTrue(!src("routes/agent-readiness.ts").includes("organic certifications"), "agent-readiness: no «organic certifications» promise");
    assertTrue(!src("middleware/agent-discovery.ts").includes("biodynamic"), "agent-discovery: no «organic (Debio), biodynamic» coverage line");

    // ── /llms.txt and /proveniens, flag on and off ─────────────────────────
    const seoRouter = require("./seo").default as any;
    const discoveryRouter = require("./discovery").default as any;
    for (const flag of ["1", "0"] as const) {
      process.env.RFB_DEBIO_REGISTER_SYNC = flag;
      const on = flag === "1";
      const tag = on ? "register on" : "register off";

      const l = invokeGet(discoveryRouter, "/llms.txt");
      assertTrue(l.found && l.status === 200, `llms.txt (${tag}): renders 200`);
      assertTrue(!l.body.includes(OLD_NO) && !l.body.includes(OLD_EN), `llms.txt (${tag}): old finnoko cross-check sentence is gone (NO + EN)`);
      assertTrue(!l.body.includes("økologisk honning Oslo"), `llms.txt (${tag}): no organic MCP example query`);
      if (on) {
        assertTrue(l.body.includes(REG_NO) && l.body.includes(REG_EN), `llms.txt (${tag}): describes Debio's public register (NO + EN)`);
        assertTrue(l.body.includes("hele registeret hentes daglig") && l.body.includes("the whole register is fetched daily"),
          `llms.txt (${tag}): whole register, daily`);
        assertTrue(l.body.includes("Bare produsenter med et sikkert treff") && l.body.includes("Only producers with a sure match"),
          `llms.txt (${tag}): only matches are shown`);
      } else {
        assertTrue(l.body.includes("finnoko.debio.no") && l.body.includes("Bare produsenter med treff vises"),
          `llms.txt (${tag}): states the finnoko fallback honestly`);
      }

      for (const lang of ["no", "en"] as const) {
        const p = invokeGet(seoRouter, "/proveniens", lang);
        assertTrue(p.found && p.status === 200, `proveniens ${lang} (${tag}): renders 200`);
        const old = lang === "no" ? OLD_PROV_NO : OLD_PROV_EN;
        assertTrue(!p.body.includes(old), `proveniens ${lang} (${tag}): old «claim is cross-checked» Debio text is gone`);
        if (on) {
          // HTML-escaped on the page (escapeHtml: ' → &#39;).
          assertTrue(p.body.includes(lang === "no" ? REG_NO : REG_EN.replace("'", "&#39;")), `proveniens ${lang} (${tag}): Debio card names Debio's public register`);
        } else {
          assertTrue(p.body.includes("finnoko.debio.no"), `proveniens ${lang} (${tag}): Debio card states the finnoko fallback`);
        }
      }
    }

    // ── /guide-mat-ai style pages: the umbrella example is gone ────────────
    const seoSrc = src("routes/seo.ts");
    assertTrue(!seoSrc.includes("Debio-certified producer") && !seoSrc.includes("Debio-sertifiserte produsenter"),
      "seo.ts: no «Debio-certified producers» umbrella example (EN + NO)");
    assertTrue(!seoSrc.includes("certifiers (Debio)") && !seoSrc.includes("sertifiserere (Debio)"),
      "seo.ts: Debio is not listed as a certifier umbrella");
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevFlag === undefined) delete process.env.RFB_DEBIO_REGISTER_SYNC;
    else process.env.RFB_DEBIO_REGISTER_SYNC = prevFlag;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicTextsS3aTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
