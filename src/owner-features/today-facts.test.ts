/**
 * today-facts.test.ts — the facts module behind /for-produsenter and its
 * «I pilot» / «planlagt» states (A2A dev-request
 * 2026-10-22-rfb-for-produsenter-faq-side, «Endringer fra Daniel 08.11», F2a;
 * src/owner-features/today-facts.ts, src/routes/rfb-for-produsenter.ts).
 *
 * Proves:
 *   1. The module moved: rfb-for-produsenter re-exports the same function.
 *   2. The state resolver: owner mode «1» → for_alle, «pilot» + allowlist →
 *      i_pilot, off / empty allowlist → planlagt; a gate that always ANDs
 *      the allowlist is never «for_alle».
 *   3. Each function's state agrees with the per-owner predicate the code
 *      uses (an allowlisted and a non-allowlisted id, several envs).
 *   4. AC9: pilot env → every pilot function shows «I pilot»; flags off →
 *      «planlagt»; for_alle → no badge. NO and EN.
 *   5. AC10: in pilot env no sentence outside a pilot block describes
 *      «Mine valg», eierportalen, «Varer» or «Kanseller bestillingen» as
 *      available to everyone.
 *   6. AC11: the pilot invitation in #mine-valg and in the closing box, a
 *      mailto with only the subject, no promise of a place.
 *   7. Order cap follows ORDER_CAP_V2_ENABLED; cancellation text follows T12.
 *   8. AC4 still holds: FAQPage JSON-LD == visible Q/A in every state.
 *
 * Standalone: npx tsx src/owner-features/today-facts.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function runTodayFactsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const tf = require("./today-facts") as typeof import("./today-facts");
  const fp = require("../routes/rfb-for-produsenter") as typeof import("../routes/rfb-for-produsenter");
  const { PILOT_FEATURE_KEYS, PILOT_FEATURE_GATES, pilotFeatureState, ownerModeGate, currentPilotStates, currentForProdusenterFacts } = tf;
  type St = import("./today-facts").PilotState;

  // ── 1. The module moved ───────────────────────────────────────────────
  assertTrue(fp.currentForProdusenterFacts === currentForProdusenterFacts, "move: rfb-for-produsenter re-exports today-facts' currentForProdusenterFacts");
  assertTrue(JSON.stringify([...PILOT_FEATURE_KEYS]) === JSON.stringify(["mine_valg", "varer", "kanseller", "lagerpaminnelse", "myk_utlop"]), "the five pilot functions of the spec");

  const X = "pilot-x";
  const Y = "other-y";
  const FLAGS_ON = { OWNER_ORDERABILITY_PORTAL_ENABLED: "1", STOCK_CHECK_EMAIL_ENABLED: "1", STOCK_SOFT_EXPIRY_ENABLED: "1" };
  const PILOT_ENV = { ...FLAGS_ON, OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${X}` } as NodeJS.ProcessEnv;
  const OFF_ENV = {} as NodeJS.ProcessEnv;

  // ── 2. Resolver ───────────────────────────────────────────────────────
  const g = ownerModeGate("OWNER_UNIFIED_SESSION_ENABLED");
  const al = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${X}` };
  const cases: Array<[NodeJS.ProcessEnv, St, string]> = [
    [{ OWNER_UNIFIED_SESSION_ENABLED: "1", ...al } as any, "for_alle", "mode «1» → for_alle"],
    [{ OWNER_UNIFIED_SESSION_ENABLED: "true" } as any, "for_alle", "mode «true» → for_alle (no allowlist needed)"],
    [{ OWNER_UNIFIED_SESSION_ENABLED: "pilot", ...al } as any, "i_pilot", "mode «pilot» + allowlist → i_pilot"],
    [{ OWNER_UNIFIED_SESSION_ENABLED: "pilot" } as any, "planlagt", "mode «pilot», empty allowlist → planlagt"],
    [{ OWNER_UNIFIED_SESSION_ENABLED: "pilot", OWNER_FEATURES_ALLOWED_SUBJECTS: "gardssalg:abc" } as any, "planlagt", "mode «pilot», only non-RFB subjects → planlagt"],
    [{ OWNER_UNIFIED_SESSION_ENABLED: "Pilot", ...al } as any, "planlagt", "mode «Pilot» (case) → planlagt (fail closed)"],
    [{ ...al } as any, "planlagt", "flag unset → planlagt"],
  ];
  for (const [env, want, label] of cases) assertTrue(pilotFeatureState(g, env) === want, `resolver (owner-mode gate): ${label}`);
  for (const k of PILOT_FEATURE_KEYS) {
    const gate = PILOT_FEATURE_GATES[k];
    assertTrue(gate.allowlistAlways, `${k}: the code ANDs the allowlist (never «for alle» from a flag alone)`);
    for (const v of ["1", "true", "pilot"]) {
      const env = { OWNER_ORDERABILITY_PORTAL_ENABLED: v, STOCK_CHECK_EMAIL_ENABLED: v, STOCK_SOFT_EXPIRY_ENABLED: v, ...al } as any;
      assertTrue(pilotFeatureState(gate, env) !== "for_alle", `${k}: flag «${v}» + allowlist is not «for_alle»`);
    }
  }
  const pilotStates = currentPilotStates(PILOT_ENV);
  const offStates = currentPilotStates(OFF_ENV);
  for (const k of PILOT_FEATURE_KEYS) {
    assertTrue(pilotStates[k] === "i_pilot", `pilot env: ${k} → i_pilot`);
    assertTrue(offStates[k] === "planlagt", `flags off, no allowlist: ${k} → planlagt`);
  }
  const flagsOnNoList = currentPilotStates({ ...FLAGS_ON } as any);
  assertTrue(PILOT_FEATURE_KEYS.every((k) => flagsOnNoList[k] === "planlagt"), "flags «1», empty allowlist → every function planlagt (nobody has it)");
  const listNoFlags = currentPilotStates({ ...al } as any);
  assertTrue(listNoFlags.varer === "planlagt" && listNoFlags.lagerpaminnelse === "planlagt" && listNoFlags.myk_utlop === "planlagt", "allowlist, switches off → «Varer», stock reminder, soft expiry planlagt");
  assertTrue(listNoFlags.mine_valg === "i_pilot" && listNoFlags.kanseller === "i_pilot", "allowlist alone → «Mine valg» and T12 cancellation i_pilot (no env switch in their gate)");

  // ── 3. States agree with the code's own per-owner predicates ──────────
  {
    const { isSubjectAllowedForOwnerFeatures } = require("./allowlist") as typeof import("./allowlist");
    const { ownerOrderabilityPortalEnabledFor } = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
    const { t12OrderActionsActive } = require("../services/order-actions") as typeof import("../services/order-actions");
    const { isStockCheckEmailEnabled, stockCheckAllowlisted } = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
    const { stockSoftExpiryActiveFor } = require("../services/stock-soft-expiry") as typeof import("../services/stock-soft-expiry");
    const pred: Record<string, (id: string, env: NodeJS.ProcessEnv) => boolean> = {
      mine_valg: (id, env) => isSubjectAllowedForOwnerFeatures("rfb", id, env),
      varer: (id, env) => ownerOrderabilityPortalEnabledFor(id, env),
      kanseller: (id, env) => t12OrderActionsActive(id, env),
      lagerpaminnelse: (id, env) => isStockCheckEmailEnabled(env) && stockCheckAllowlisted(id, env),
      myk_utlop: (id, env) => stockSoftExpiryActiveFor(id, env),
    };
    const envs: NodeJS.ProcessEnv[] = [OFF_ENV, PILOT_ENV, { ...FLAGS_ON } as any, { ...al } as any,
      { OWNER_ORDERABILITY_PORTAL_ENABLED: "true", STOCK_CHECK_EMAIL_ENABLED: "0", STOCK_SOFT_EXPIRY_ENABLED: "pilot", ...al } as any];
    envs.forEach((env, i) => {
      for (const k of PILOT_FEATURE_KEYS) {
        const st = pilotFeatureState(PILOT_FEATURE_GATES[k], env);
        const x = pred[k](X, env);
        const y = pred[k](Y, env);
        const ok = st === "for_alle" ? (x && y) : st === "i_pilot" ? (x && !y) : (!x && !y);
        assertTrue(ok, `env #${i}: ${k} state «${st}» matches the code (allowlisted ${x}, other ${y})`);
      }
    });
  }

  // ── Render helpers ────────────────────────────────────────────────────
  const allState = (st: St) => ({ mine_valg: st, varer: st, kanseller: st, lagerpaminnelse: st, myk_utlop: st });
  const factsPilot = currentForProdusenterFacts(PILOT_ENV);
  const factsOff = currentForProdusenterFacts(OFF_ENV);
  const factsAll = { ...factsOff, pilot: allState("for_alle") };
  const render = (lang: "no" | "en", facts: any) => fp.renderForProdusenterPage(lang, `https://x${lang === "en" ? "/en" : ""}/for-produsenter`, facts);
  const blockOf = (html: string, key: string): string => {
    const m = html.match(new RegExp(`data-feature="${key}" data-state="([a-z_]+)">([\\s\\S]*?)</div>`));
    return m ? `${m[1]}|${m[2]}` : "";
  };
  const stateOf = (html: string, key: string): string => (html.match(new RegExp(`data-feature="${key}" data-state="([a-z_]+)"`)) || ["", ""])[1];

  // ── 4. AC9: the three states ──────────────────────────────────────────
  for (const lang of ["no", "en"] as const) {
    const badge = lang === "en" ? "In pilot" : "I pilot";
    const note = lang === "en" ? "We are testing this now with a few selected producers. It will become available to everyone later." : "Dette tester vi nå med noen få utvalgte produsenter. Det blir tilgjengelig for alle senere.";
    const planned = lang === "en" ? /planned/ : /planlagt/;
    const pilotHtml = render(lang, factsPilot).content;
    const offHtml = render(lang, factsOff).content;
    const allHtml = render(lang, factsAll).content;
    for (const k of PILOT_FEATURE_KEYS) {
      assertTrue((pilotHtml.match(new RegExp(`data-feature="${k}"`, "g")) || []).length === 1, `${lang}: ${k} has exactly one block`);
      const b = blockOf(pilotHtml, k);
      assertTrue(stateOf(pilotHtml, k) === "i_pilot" && b.includes(`<span class="fp-badge">${badge}</span>`) && b.includes(note), `AC9 ${lang}: owner mode «pilot» → ${k} shows «${badge}» + the note`);
      const o = blockOf(offHtml, k);
      assertTrue(stateOf(offHtml, k) === "planlagt" && planned.test(o) && !o.includes("fp-badge"), `AC9 ${lang}: flags off → ${k} described as planned, no badge`);
      const a = blockOf(allHtml, k);
      const aFirst = (a.match(/<p>([\s\S]*?)<\/p>/) || ["", ""])[1]; // «Mine valg» adds «Andre valg er planlagt» after its list
      assertTrue(stateOf(allHtml, k) === "for_alle" && !a.includes("fp-badge") && !planned.test(aFirst), `AC9 ${lang}: «for alle» → ${k} without badge, not planned`);
    }
    assertTrue(!allHtml.includes("fp-badge") && !allHtml.includes(badge) && !allHtml.includes(note), `AC9 ${lang}: «for alle» → no «${badge}» anywhere on the page`);
    assertTrue(!offHtml.includes("fp-badge") && !offHtml.includes(note), `${lang}: all planned → no pilot badge`);
  }
  // The main path for everyone comes first in #mine-valg while «Mine valg» is in pilot.
  {
    const html = render("no", factsPilot).content;
    const sec = (html.match(/<section class="fp-sec" id="mine-valg"[\s\S]*?<\/section>/) || [""])[0];
    const main = sec.indexOf("slår du bestillinger av og på når du er logget inn, under «Bestillinger»");
    assertTrue(main > 0 && main < sec.indexOf('data-feature="mine_valg"'), "#mine-valg: what applies to everyone today comes before the pilot block");
    const allSec = (render("no", factsAll).content.match(/<section class="fp-sec" id="mine-valg"[\s\S]*?<\/section>/) || [""])[0];
    assertTrue(allSec.includes("Når du har tatt over profilen, finner du «Mine valg» i eierportalen.") && allSec.includes("Dette kan du velge i dag:"), "#mine-valg «for alle»: the approved 30.10 text");
  }

  // ── 5. AC10: nothing pilot-only is called available to everyone ───────
  for (const lang of ["no", "en"] as const) {
    const page = render(lang, factsPilot);
    const outside = page.content
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<div class="fp-pilot"[\s\S]*?<p class="fp-pilot-note">[\s\S]*?<\/p>\s*<\/div>/g, " ")
      .replace(/<details class="fp-qa">[\s\S]*?<\/details>/g, " ") // the Q/A are checked from the JSON-LD below
      .replace(/<nav class="fp-menu"[\s\S]*?<\/nav>/g, " ")
      .replace(/<[^>]+>/g, " ");
    const answers = ((page.jsonLd as any).mainEntity as any[]).map((e) => `${e.name} ${e.acceptedAnswer.text}`).join(" ");
    const sentences = decode(`${outside} ${answers}`).split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean);
    const terms = lang === "en"
      ? [/«Mine valg»/, /owner portal/i, /«Varer»/, /«Kanseller bestillingen»/]
      : [/«Mine valg»/, /eierportalen/i, /«Varer»/, /«Kanseller bestillingen»/];
    const bad = sentences.filter((x) => terms.some((t) => t.test(x)) && !/pilot|planlagt|planned/i.test(x));
    assertTrue(bad.length === 0, `AC10 ${lang}: no sentence outside a pilot block describes a pilot function as available to all${bad.length ? ` — ${bad.join(" | ")}` : ""}`);
    assertTrue(sentences.some((x) => /«Flere valg»/.test(x)) && !page.content.includes("«Ta imot bestillinger» i «Mine valg»"), `AC10 ${lang}: the cancellation everyone has today («Flere valg») is the main path`);
  }
  // Every «I pilot» sentence in the Q/A really is marked.
  {
    const ans = ((render("no", factsPilot).jsonLd as any).mainEntity as any[]).map((e) => e.acceptedAnswer.text as string);
    assertTrue(ans.some((a) => a.includes("I pilot: produsentene i piloten bruker «Kanseller bestillingen» i «Mine ordrer» i stedet.")), "Q/A: T12 cancellation marked «I pilot» (T12)");
    assertTrue(ans.some((a) => a.includes("I pilot: produsentene i piloten gjør dette under «Varer» i eierportalen.")), "Q/A: «Varer» marked «I pilot» (T13)");
    const allAns = ((render("no", factsAll).jsonLd as any).mainEntity as any[]).map((e) => e.acceptedAnswer.text as string);
    assertTrue(allAns.some((a) => a.startsWith("Trykk «Kanseller bestillingen» i «Mine ordrer» eller på lenken i e-posten")) && !allAns.some((a) => a.includes("«Flere valg»")), "Q/A «for alle»: cancellation is «Kanseller bestillingen», no «Flere valg»");
    const offAns = ((render("no", factsOff).jsonLd as any).mainEntity as any[]).map((e) => e.acceptedAnswer.text as string);
    assertTrue(!offAns.some((a) => /I pilot/.test(a)), "Q/A planned: no «I pilot» sentence");
  }

  // ── 6. AC11: the invitation ───────────────────────────────────────────
  for (const lang of ["no", "en"] as const) {
    const html = render(lang, factsPilot).content;
    const invite = lang === "en"
      ? "Would you like to join the pilot? Send us an e-mail, and we will get in touch. We take in a few producers at a time."
      : "Vil du være med i piloten? Send oss en e-post, så tar vi kontakt. Vi tar inn noen få produsenter om gangen.";
    const sec = (html.match(/<section class="fp-sec" id="mine-valg"[\s\S]*?<\/section>/) || [""])[0];
    const closing = (html.match(/<aside class="fp-closing"[\s\S]*?<\/aside>/) || [""])[0];
    for (const [where, block] of [["#mine-valg", sec], ["closing box", closing]] as const) {
      const inv = (block.match(/<div class="fp-invite"[\s\S]*?<\/div>/) || [""])[0];
      assertTrue(inv.includes(`<p>${invite}</p>`), `AC11 ${lang}: the invitation is in ${where}`);
      const hrefs = [...inv.matchAll(/href="([^"]*)"/g)].map((m) => decode(m[1]));
      assertTrue(hrefs.length === 1 && hrefs[0] === "mailto:kontakt@rettfrabonden.com?subject=Pilot%20%E2%80%93%20Mine%20valg", `AC11 ${lang}: ${where} mailto carries only the subject`);
      const q = hrefs[0]?.split("?")[1] || "";
      assertTrue(q.split("&").length === 1 && decodeURIComponent(q) === "subject=Pilot – Mine valg", `AC11 ${lang}: ${where} no body/cc/personal data in the link`);
      assertTrue(!/(plass|garanti|garanter|lover|place is|guarantee|promise|you will be)/i.test(decode(inv.replace(/<[^>]+>/g, " ")).replace(/kontakt@rettfrabonden\.com/, "")), `AC11 ${lang}: ${where} promises no place`);
    }
    assertTrue(html.indexOf('data-pilot-invite="mine-valg"') > html.indexOf('id="mine-valg"') && html.indexOf('data-pilot-invite="avslutning"') > html.indexOf('id="kontakt"'), `AC11 ${lang}: the invitations sit in #mine-valg and after the last section`);
    const off = render(lang, factsOff).content;
    assertTrue(!off.includes("fp-invite") && off.includes('<aside class="fp-closing"'), `${lang}: nothing in pilot → no invitation (the closing box stays)`);
  }

  // ── 7. Order cap and T11 ──────────────────────────────────────────────
  {
    const { ownerOrderLimitLines } = require("./order-texts") as typeof import("./order-texts");
    const v2 = currentForProdusenterFacts({ ORDER_CAP_V2_ENABLED: "1" } as any);
    const v1 = currentForProdusenterFacts({} as any);
    assertTrue(v2.orderCapV2On && !v1.orderCapV2On, "facts.orderCapV2On reads ORDER_CAP_V2_ENABLED");
    const on = render("no", v2).content;
    const off = render("no", v1).content;
    assertTrue(ownerOrderLimitLines(v2.orderLimits).every((l) => on.includes(l)) && !on.includes("per døgn"), "ORDER_CAP_V2 on: the T11 rule text (order-texts.ts), no «per døgn»");
    assertTrue(off.includes(`inntil ${v1.dailyCap} bestillinger per døgn`) && !off.includes("Mange ulike kunder kan bestille fra deg samme dag."), "ORDER_CAP_V2 off: the old rule");
    const onEn = render("en", v2).content;
    assertTrue(onEn.includes(`at most ${v2.orderLimits.openPerBuyer} unanswered orders`) && onEn.includes(`more than ${v2.orderLimits.producerCeilingPerDay} orders in one day`) && !onEn.includes("up to 10 orders per day"), "ORDER_CAP_V2 on: EN mirrors the T11 rule");
    assertTrue(render("en", v1).content.includes(`up to ${v1.dailyCap} orders per day`), "ORDER_CAP_V2 off: EN old rule");
  }

  // ── 8. AC4: JSON-LD == visible Q/A in every state ─────────────────────
  for (const [name, facts] of [["pilot", factsPilot], ["off", factsOff], ["for_alle", factsAll]] as const) {
    for (const lang of ["no", "en"] as const) {
      const page = render(lang, facts);
      const ld = ((page.jsonLd as any).mainEntity as any[]).map((e) => ({ q: e.name, a: e.acceptedAnswer.text }));
      const visible = [...page.content.matchAll(/<details class="fp-qa"><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => ({ q: decode(m[1]), a: decode(m[2]) }));
      assertTrue(ld.length >= 30 && JSON.stringify(ld) === JSON.stringify(visible), `AC4 ${name} ${lang}: FAQPage JSON-LD equals the visible Q/A (${ld.length})`);
      assertTrue(!/<script>|<img/.test(page.content.replace(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/, "")), `${name} ${lang}: no unescaped markup in the rendered text`);
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runTodayFactsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
