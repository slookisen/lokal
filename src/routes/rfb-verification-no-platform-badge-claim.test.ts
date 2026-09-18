/**
 * rfb-verification-no-platform-badge-claim.test.ts — dev-request
 * 2026-09-09-om-verifisering-side-omtaler-merke-som-ikke-finnes.
 *
 * Daniel, live 2026-09-09: "Vår egen verifiseringsløype er ikke noe [vi]
 * skal vise til, da det ikke er noen offentlige krav-spec til hva som
 * kreves for å bli verifisert hos oss. Det er bedre om de som er
 * verifisert av eier, har dette merket på sine profiler." The public
 * /proveniens page and llms.txt both claimed that passing the platform's
 * own internal cross-check earns a "✓ Verified"/"✓ Verifisert" badge — that
 * badge doesn't exist; the only public badge is "Verified by owner" /
 * "Verifisert av eier" (agents.is_verified, set only by owner-claim).
 *
 * Covers: neither /proveniens (no+en) nor /llms.txt (no+en) claims a
 * platform-verification badge any more, and both still correctly describe
 * "Verified by owner" as the only badge.
 *
 * Standalone: npx tsx src/routes/rfb-verification-no-platform-badge-claim.test.ts
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

export async function runRfbVerificationNoPlatformBadgeClaimTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
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
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }
  } catch { /* config module not resolvable standalone; route falls back to defaults */ }

  const seoRouter = require("./seo").default as any;
  const discoveryRouter = require("./discovery").default as any;

  // ── /proveniens (no + en) ──────────────────────────────────────────────
  for (const lang of ["no", "en"] as const) {
    const r = invokeGet(seoRouter, "/proveniens", lang);
    assertTrue(r.found, `setup: GET /proveniens (${lang}) is registered`);
    if (!r.found) continue;
    assertTrue(r.status === 200, `proveniens (${lang}): renders 200`);
    if (lang === "no") {
      assertTrue(!r.body.includes("✓ Verifisert</span>-merke") && !/har bestått kryssjekkingen,\s*viser et/.test(r.body),
        "proveniens no: does not claim cross-checking itself shows a '✓ Verifisert' badge");
      assertTrue(r.body.includes("Verifisert av eier"),
        "proveniens no: still mentions 'Verifisert av eier' as the actual badge");
      assertTrue(/kryssjekkingen gir ikke noe merke/.test(r.body),
        "proveniens no: explicitly states cross-checking alone gives no badge");
    } else {
      assertTrue(!r.body.includes("✓ Verified</span> badge") && !/have cleared cross-source agreement show a/.test(r.body),
        "proveniens en: does not claim cross-checking itself shows a '✓ Verified' badge");
      assertTrue(r.body.includes("Verified by owner"),
        "proveniens en: still mentions 'Verified by owner' as the actual badge");
      assertTrue(/clearing cross-checking on its own does not add a badge/.test(r.body),
        "proveniens en: explicitly states cross-checking alone gives no badge");
    }
  }

  // ── /llms.txt (no + en, same file, both languages inline) ──────────────
  {
    const r = invokeGet(discoveryRouter, "/llms.txt");
    assertTrue(r.found, "setup: GET /llms.txt is registered");
    if (r.found) {
      assertTrue(r.status === 200, "llms.txt: renders 200");
      assertTrue(!r.body.includes("uten «✓ Verifisert»-merket") && !r.body.includes('without the "✓ Verified" badge'),
        "llms.txt: does not claim cross-checking itself yields a platform verification badge");
      assertTrue(r.body.includes("Verifisert av eier") && r.body.includes("Verified by owner"),
        "llms.txt: mentions 'Verifisert av eier' / 'Verified by owner' as the actual badge (both languages)");
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbVerificationNoPlatformBadgeClaimTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
