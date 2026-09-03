/**
 * profile-translations.test.ts — dev-request
 * 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent.
 *
 * Sections:
 *   A. Pure unit tests (no DB, no network): i18n sv plumbing (flag-gated
 *      /sv prefix, sv→en→no fallback), verifyTranslationDeterministic,
 *      extractJsonObject, parseReviewVerdict/reviewAccepts, planItem, and the
 *      PUBLISH_GATE_SQL drift guard.
 *   B. Store + pipeline against a :memory: RFB db (database/init's
 *      __setDbForTesting/__initSchemaForTesting) with an injected fetchImpl
 *      that plays translator + reviewer: verified path, REVISE→retry→APPROVE,
 *      REJECT, deterministic-verify rejection, missing API key (fail-closed,
 *      row stays draft), source-change supersede, publish/unpublish/serve-flag
 *      gating, reject/requeue.
 *   C. Admin route (src/routes/admin-profile-translations.ts) via
 *      router.handle(): auth, flag-OFF no-op proof, dry-run planning, a real
 *      run with the app-level fetch seam, status, publish.
 *   D. Opplevagent source collection against a :memory: experiences db —
 *      only PUBLISHED experiences / catalog-visible providers are collected.
 *
 * Run standalone: npx tsx src/services/profile-translations.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult { status: number; body: any; }

function callRoute(
  router: any,
  opts: { url: string; method?: string; headers?: Record<string, string>; body?: any; app?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url;
    const qIndex = url.indexOf("?");
    const query: Record<string, string> = {};
    if (qIndex >= 0) {
      for (const [k, v] of new URLSearchParams(url.slice(qIndex + 1))) query[k] = v;
    }
    const req: any = {
      method: opts.method || "GET",
      url,
      originalUrl: url,
      path: qIndex >= 0 ? url.slice(0, qIndex) : url,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      app: opts.app || { get: () => undefined },
      get(name: string) { return (opts.headers || {})[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
    };
    router.handle(req, res, (err: any) => resolve({ status: err ? 500 : 404, body: { error: err ? String(err) : "unhandled" } }));
  });
}

/** Fake Anthropic endpoint: answers translator prompts and reviewer prompts
 *  from queues, recording every call. */
function makeFakeFetch(script: { translations: any[]; reviews: any[] }, log: { calls: Array<{ system: string; user: string; model: string }> }) {
  return async (_url: any, init: any): Promise<any> => {
    const body = JSON.parse(String(init?.body || "{}"));
    const system = String(body.system || "");
    const user = String(body.messages?.[0]?.content || "");
    log.calls.push({ system, user, model: body.model });
    const isReviewer = /senior .* linguist/i.test(system);
    const next = isReviewer ? script.reviews.shift() : script.translations.shift();
    if (next === undefined) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => "script exhausted" };
    }
    if (next && next.__http) {
      return { ok: false, status: next.__http, json: async () => ({}), text: async () => "err" };
    }
    const text = typeof next === "string" ? next : JSON.stringify(next);
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } }),
      text: async () => "",
    };
  };
}

export async function runProfileTranslationsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); if (log) console.log(`  ✗ ${label}`, detail ?? ""); }
  };
  const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label, { actual: a, expected: b });

  const envKeys = ["SV_LOCALE_ENABLED", "PROFILE_TRANSLATIONS_ENABLED", "PROFILE_TRANSLATIONS_SERVE_ENABLED", "OPPLEVAGENT_LANG_SWITCHER_ENABLED", "ANTHROPIC_API_KEY", "ADMIN_KEY", "EXPERIENCES_DB_PATH"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) prevEnv[k] = process.env[k];
  const restoreEnv = () => {
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  };

  const svc = require("./profile-translations") as typeof import("./profile-translations");
  const i18n = require("../i18n/t") as typeof import("../i18n/t");

  try {
    // ───────────────────────────── A. pure ─────────────────────────────
    delete process.env.SV_LOCALE_ENABLED;
    eq(i18n.detectLangFromPath("/sv/sok"), "no", "A1 /sv not recognised while SV_LOCALE_ENABLED unset");
    eq(i18n.detectLangFromPath("/en/sok"), "en", "A2 /en still recognised");
    process.env.SV_LOCALE_ENABLED = "true";
    eq(i18n.detectLangFromPath("/sv/sok"), "sv", "A3 /sv recognised with flag");
    eq(i18n.detectLangFromPath("/sv"), "sv", "A4 bare /sv recognised with flag");
    eq(i18n.detectLangFromPath("/svelvik"), "no", "A5 /svelvik is not /sv");
    delete process.env.SV_LOCALE_ENABLED;
    eq(i18n.stripLangPrefix("/sv/produsent/x"), "/produsent/x", "A6 stripLangPrefix sv");
    eq(i18n.stripLangPrefix("/en"), "/", "A7 stripLangPrefix bare en");
    eq(i18n.localizedPath("/sok", "sv"), "/sv/sok", "A8 localizedPath sv");
    eq(i18n.localizedPath("/", "sv"), "/sv", "A9 localizedPath root sv");
    eq(i18n.localizedPath("/sok", "no"), "/sok", "A10 localizedPath no unchanged");
    eq(i18n.htmlLangAttr("sv"), "sv", "A11 htmlLangAttr sv");
    eq(i18n.ogLocale("sv"), "sv_SE", "A12 ogLocale sv");
    eq(i18n.t("sv", "nav.search"), "Sök", "A13 t() sv dictionary");
    eq(i18n.t("sv", "producer.title_suffix", { city: "Oslo" }), " — Lokal matproducent i Oslo", "A14 t() sv with params");
    eq(i18n.t("en", "nav.search"), "Search", "A15 t() en unchanged");
    eq(i18n.t("no", "nav.search"), "Søk", "A16 t() no unchanged");
    eq(i18n.t("sv", "nav.lang_sv"), "Svenska", "A17 lang_sv key present");
    eq(i18n.t("sv", "does.not.exist"), "does.not.exist", "A18 unknown key returns key");
    eq(i18n.formatPrice(80, "sv"), "80 NOK", "A19 formatPrice sv");

    // PUBLISH_GATE_SQL drift guard
    const store = require("./experience-store") as typeof import("./experience-store");
    eq(svc.OPPLEVAGENT_PUBLISH_GATE_SQL, store.PUBLISH_GATE_SQL, "A20 inlined publish gate equals experience-store PUBLISH_GATE_SQL");

    // deterministic verify
    const src = "Gården ligger i Bø i Telemark. Vi selger ost og honning, åpent lørdager 10–15. Ring 91234567 eller se https://example.no/gard.";
    const good = "The farm is located in Bø in Telemark. We sell cheese and honey, open Saturdays 10–15. Call 91234567 or see https://example.no/gard.";
    const v1 = svc.verifyTranslationDeterministic(src, good, "en");
    ok(v1.ok, "A21 good translation passes deterministic verify", v1.failed);
    const v2 = svc.verifyTranslationDeterministic(src, good.replace("91234567", "91234568"), "en");
    ok(!v2.ok && v2.failed.includes("digits_preserved"), "A22 changed phone digits fail", v2.failed);
    // ordinals written with digits may be spelled out in the target language (live false positive, 2026-09-02)
    const ordSrc = "Prisbelønnet eplemost fra eplehagen i 6. generasjon. Fire sorter: Aroma og Discovery.";
    const ordEn = svc.verifyTranslationDeterministic(ordSrc, "Award-winning apple juice from our sixth-generation orchard. Four varieties: Aroma and Discovery.", "en");
    ok(ordEn.ok, "A22b spelled-out English ordinal for '6. generasjon' passes", ordEn.failed);
    const ordSv = svc.verifyTranslationDeterministic(ordSrc, "Prisbelönt äppelmust från äppelodlingen i sjätte generationen. Fyra sorter: Aroma och Discovery.", "sv");
    ok(ordSv.ok, "A22c spelled-out Swedish ordinal passes", ordSv.failed);
    const ordDigit = svc.verifyTranslationDeterministic(ordSrc, "Award-winning apple juice from our 6th-generation orchard. Four varieties: Aroma and Discovery.", "en");
    ok(ordDigit.ok, "A22d digit ordinal '6th' passes", ordDigit.failed);
    const ordWrong = svc.verifyTranslationDeterministic(ordSrc, "Award-winning apple juice from our fifth-generation orchard. Four varieties: Aroma and Discovery.", "en");
    ok(!ordWrong.ok && ordWrong.failed.includes("digits_preserved"), "A22e wrong spelled-out ordinal still fails", ordWrong.failed);
    const ordDropped = svc.verifyTranslationDeterministic(ordSrc, "Award-winning apple juice from our orchard. Four varieties: Aroma and Discovery.", "en");
    ok(!ordDropped.ok && ordDropped.failed.includes("digits_preserved"), "A22f dropped ordinal still fails", ordDropped.failed);
    const nonOrd = svc.verifyTranslationDeterministic("Åpent 6. hver dag kl 10–16, 6 sorter ost.", "Open every day 10–16, six kinds of cheese.", "en");
    ok(!nonOrd.ok && nonOrd.failed.includes("digits_preserved"), "A22g cardinal 6 spelled out is NOT tolerated", nonOrd.failed);
    ok(svc.ordinalSpelledOut("i 3. generasjon", "third generation", "3", "en") && !svc.ordinalSpelledOut("3 kuer", "third", "3", "en"), "A22h ordinalSpelledOut needs ordinal in source");
    const cent = "Lågdalsmuseet – friluftsmuseum med tømmerbygninger fra 1600-tallet";
    ok(svc.verifyTranslationDeterministic(cent, "Lågdalsmuseet – open-air museum with 17th-century log buildings", "en", { kind: "title" }).ok, "A22i 1600-tallet → 17th-century passes");
    ok(svc.verifyTranslationDeterministic(cent, "Lågdalsmuseet – open-air museum with log buildings from the 1600s", "en", { kind: "title" }).ok, "A22j 1600-tallet → the 1600s passes");
    ok(!svc.verifyTranslationDeterministic(cent, "Lågdalsmuseet – open-air museum with 16th-century log buildings", "en", { kind: "title" }).ok, "A22k wrong century fails");
    // deliberately kept Norwegian terms (translator-declared), proper-noun prefixes, names with function words
    const keptSrc = "Kari serverer hjemmelaget rømmegrøt og lefse i kafeen hver lørdag. Gården har 90 mål jord.";
    const keptOut = "Kari serves homemade rømmegrøt (sour cream porridge) and lefse in the café every Saturday. The farm has 90 mål (about 9 hectares) of land.";
    const k1 = svc.verifyTranslationDeterministic(keptSrc, keptOut, "en");
    ok(!k1.ok && k1.failed.includes("no_untranslated_norwegian"), "A24b kept dish name without declaration still fails", k1.failed);
    const k2 = svc.verifyTranslationDeterministic(keptSrc, keptOut, "en", { keptTerms: ["rømmegrøt", "mål"] });
    ok(k2.ok, "A24c declared kept terms present in source pass", k2.failed);
    const k3 = svc.verifyTranslationDeterministic(keptSrc, keptOut.replace("sour cream", "rømme"), "en", { keptTerms: ["rømmegrøt", "mål", "rømme"] });
    ok(!k3.ok && k3.failed.includes("no_untranslated_norwegian"), "A24d declared term not in source is not tolerated", k3.failed);
    const k4 = svc.verifyTranslationDeterministic(keptSrc, keptOut.replace("Saturday", "lørdag"), "en", { keptTerms: ["rømmegrøt", "mål"] });
    ok(!k4.ok && k4.failed.includes("no_untranslated_norwegian"), "A24e undeclared leak still fails alongside kept terms", k4.failed);
    const pn1 = svc.verifyTranslationDeterministic("Hvalsafari og nordlys ved Tromsø-fjordene", "Whale safari and northern lights by the Tromsø Fjords", "en", { kind: "title" });
    ok(pn1.ok, "A24f capitalised prefix of hyphenated source name (Tromsø-fjordene) passes", pn1.failed);
    const pn2 = svc.verifyTranslationDeterministic("Camping ved Jærens hvite strender", "Camping by Jæren's white beaches", "en", { kind: "title" });
    ok(pn2.ok, "A24g genitive source name (Jærens → Jæren's) passes", pn2.failed);
    const pn3 = svc.verifyTranslationDeterministic("Sommerski på Galdhøpiggen-breen", "Summer skiing on the Galdhøpiggen glacier", "en", { kind: "title" });
    ok(pn3.ok, "A24h Galdhøpiggen-breen → Galdhøpiggen passes", pn3.failed);
    const pn4 = svc.verifyTranslationDeterministic("Vi har åpent lørdager på Bø", "We are open lørdager at Bø", "en");
    ok(!pn4.ok && pn4.failed.includes("no_untranslated_norwegian"), "A24i lowercase leak is not a name prefix", pn4.failed);
    const np1 = svc.verifyTranslationDeterministic("Bondens marked i sentrum av Sogndal, Sogn og Fjordane. Del av Smak av Nordhordland-nettverket.", "Farmers' market in the centre of Sogndal, Sogn og Fjordane. Part of the Smak av Nordhordland network.", "en");
    ok(np1.ok, "A24j function words inside verbatim capitalised name phrases pass", np1.failed);
    const np3 = svc.verifyTranslationDeterministic("Del av Auk — Smaker fra Stjørdalsføret.", "Part of Auk — Smaker fra Stjørdalsføret.", "en");
    ok(np3.ok, "A24j2 'fra' inside a verbatim network name passes", np3.failed);
    const np4 = svc.verifyTranslationDeterministic("Nordlandsmuseet i Bodø viser vikingsølv.", "Nordlandsmuseet i Bodø shows Viking silver.", "en");
    ok(!np4.ok && np4.failed.includes("no_norwegian_stopwords"), "A24j3 locative 'i' between capitalised words still fails", np4.failed);
    const np2 = svc.verifyTranslationDeterministic("Bondens marked i sentrum av Sogndal, Sogn og Fjordane.", "Farmers' market in Sogndal og Sogn og Fjordane.", "en");
    ok(!np2.ok && np2.failed.includes("no_norwegian_stopwords"), "A24k 'og' outside a source name phrase still fails", np2.failed);
    const rp = svc.buildReviewerUserPrompt("rfb", { entity_type: "agent", entity_id: "x", field: "about", kind: "prose", text: keptSrc, entity_name: "Kari" } as any, "en", keptOut, ["rømmegrøt", "mål"]);
    ok(rp.includes("kept on purpose") && rp.includes("rømmegrøt, mål"), "A24l reviewer prompt lists kept terms");
    ok(!svc.buildReviewerUserPrompt("rfb", { entity_type: "agent", entity_id: "x", field: "about", kind: "prose", text: keptSrc, entity_name: "Kari" } as any, "en", keptOut, []).includes("kept on purpose"), "A24m reviewer prompt omits kept-terms line when empty");
    // multi-word kept term (scheme name) + HTML-entity sources (live 2026-09-03)
    const iptSrc = "Tveitan Gård i Siljan driver storfekjøttproduksjon og Inn på tunet-tjenester for kommunen.";
    const ipt1 = svc.verifyTranslationDeterministic(iptSrc, "Tveitan Gård in Siljan produces beef and offers Inn på tunet (farm-based care and education) services for the municipality.", "en", { keptTerms: ["inn på tunet"] });
    ok(ipt1.ok, "A24n multi-word kept term 'Inn på tunet' with gloss passes", ipt1.failed);
    const ipt2 = svc.verifyTranslationDeterministic(iptSrc, "Tveitan Gård in Siljan produces beef and offers inn på tunet services for the municipality.", "en", { keptTerms: ["inn på tunet"] });
    ok(!ipt2.ok && ipt2.failed.includes("no_untranslated_norwegian"), "A24o multi-word kept term without gloss (and not capitalised as a name) still fails", ipt2.failed);
    const si = svc.verifyTranslationDeterministic("Gårdsbutikk med ost. Åpent lørdager 10–15 hele året.", "Farm shop with cheese. Åpent lørdager 10–15 all year.", "en");
    ok(!si.ok && si.failed.includes("no_untranslated_norwegian"), "A24w sentence-initial capitalised head does not license the following word", si.failed);
    const sl = svc.verifyTranslationDeterministic("Bondens marked i Sogndal sentrum, Sogn og Fjordane/Vestland.", "Bondens marked (farmers' market) in Sogndal town centre, Sogn og Fjordane/Vestland.", "en");
    ok(sl.ok, "A24x county name followed by a slash alternative passes", sl.failed);
    const amp = svc.verifyTranslationDeterministic("Fossmoen Frukt og Cider – Vi tapper naturen på flaske.", "Fossmoen Frukt og Cider – We bottle nature.", "en", { entityName: "Fossmoen Frukt & Cider — Bjerkreim" });
    ok(amp.ok, "A24y entity name with & matches the source's og in a name phrase", amp.failed);
    const lc = svc.verifyTranslationDeterministic("Bryggeriet ligger i østre Strandvei 52 og har utsalg.", "The brewery is at Østre Strandvei 52 and has a shop.", "en");
    ok(lc.ok, "A24z two-word proper name capitalised from a lowercase source form passes", lc.failed);
    const lc2 = svc.verifyTranslationDeterministic("Vi har åpent lørdager i gårdsbutikken.", "We have Åpent Lørdager in the farm shop.", "en");
    ok(!lc2.ok && lc2.failed.includes("no_untranslated_norwegian"), "A24z2 capitalising everyday Norwegian words does not license them", lc2.failed);
    const ipt3 = svc.verifyTranslationDeterministic("Vi har åpent på lørdager.", "We are open på lørdager (Saturdays).", "en", { keptTerms: ["på lørdager"] });
    ok(!ipt3.ok, "A24p a multi-word term made only of everyday words is not tolerated", ipt3.failed);
    eq(svc.decodeHtmlEntities("Noraker G&#229;rd &amp; S&#xF8;nner &ndash; &aring;pent"), "Noraker Gård & Sønner – åpent", "A24q HTML entities decoded");
    const entSrc = "I Aurdal ligger Noraker G&#229;rd som drives i 12. generasjon. Rakfisken fra Noraker G&#229;rd er kjent.";
    const ent1 = svc.verifyTranslationDeterministic(entSrc, "Noraker Gård in Aurdal is run by the 12th generation. The rakfisk (fermented trout) from Noraker Gård is well known.", "en", { keptTerms: ["rakfisk"] });
    ok(ent1.ok, "A24r entity-encoded source verifies against decoded translation (no phantom digits)", ent1.failed);
    const hy = svc.verifyTranslationDeterministic("Vingården ligger i Snåsa og lager vin av druer dyrket i Snåsa.", "The vineyard lies in Snåsa and makes wine from Snåsa-grown grapes.", "en");
    ok(hy.ok, "A24s hyphenated compound with a preserved proper noun (Snåsa-grown) passes", hy.failed);
    const bg = svc.verifyTranslationDeterministic("Selskapet driver gårdsbutikken på Skudeneset gård i Søgne.", "The company runs the farm shop at Skudeneset gård in Søgne.", "en");
    ok(bg.ok, "A24t lowercase name part in a verbatim source bigram (Skudeneset gård) passes", bg.failed);
    const bg2 = svc.verifyTranslationDeterministic("Vi har en gammel gård i Søgne.", "We have an old gård in Søgne.", "en");
    ok(!bg2.ok && bg2.failed.includes("no_untranslated_norwegian"), "A24u lowercase common noun without a capitalised neighbour still fails", bg2.failed);
    const q = svc.verifyTranslationDeterministic("RYGR vant «Årets øl» i 2023 og 2024.", "RYGR won \"Årets øl\" (Beer of the Year) in 2023 and 2024.", "en", { keptTerms: ["årets øl"] });
    ok(q.ok, "A24v quoted multi-word kept term with gloss after the closing quote passes", q.failed);
    // review round 1 (lokal#771): kept_terms must not be a free whitelist
    const kd1 = svc.verifyTranslationDeterministic("Vi har åpent lørdager og søndager på gården.", "We are open lørdager and søndager at the farm.", "en", { keptTerms: ["lørdager", "søndager"] });
    ok(!kd1.ok && kd1.failed.includes("no_untranslated_norwegian"), "A24n denylisted weekday kept terms are refused", kd1.failed);
    const kd2 = svc.verifyTranslationDeterministic("Vi driver en økologisk gård med kyr.", "We run an økologisk (organic) gård (farm) with cows.", "en", { keptTerms: ["økologisk", "gård"] });
    ok(!kd2.ok && kd2.failed.includes("no_untranslated_norwegian"), "A24o everyday words refused even with a gloss", kd2.failed);
    const kd3 = svc.verifyTranslationDeterministic(keptSrc, keptOut.replace("rømmegrøt (sour cream porridge)", "rømmegrøt"), "en", { keptTerms: ["rømmegrøt", "mål"] });
    ok(!kd3.ok && kd3.failed.includes("no_untranslated_norwegian"), "A24p kept term without a gloss is not tolerated", kd3.failed);
    const kd4 = svc.verifyTranslationDeterministic("På gården vår i dalen lager vi tradisjonsmat etter gamle oppskrifter: spekemat, fenalår, pinnekjøtt, rømmegrøt og lefse, alt av lokale råvarer.", "On our farm in the valley we make traditional food to old recipes: spekemat (cured meats), fenalår (cured leg of lamb), pinnekjøtt (salted lamb ribs), rømmegrøt (sour cream porridge) and lefse (flatbread), all from local ingredients.", "en", { keptTerms: ["lefse", "spekemat", "fenalår", "pinnekjøtt", "rømmegrøt"] });
    ok(!kd4.ok && kd4.failed.includes("no_untranslated_norwegian"), "A24q at most four kept terms are honoured", kd4.failed);
    const kd5 = svc.verifyTranslationDeterministic("På gården vår i dalen lager vi tradisjonsmat etter gamle oppskrifter: fenalår, pinnekjøtt, rømmegrøt og lefse, alt av lokale råvarer.", "On our farm in the valley we make traditional food to old recipes: fenalår (cured leg of lamb), pinnekjøtt (salted lamb ribs), rømmegrøt (sour cream porridge) and lefse (flatbread), all from local ingredients.", "en", { keptTerms: ["fenalår", "pinnekjøtt", "rømmegrøt", "lefse"] });
    ok(kd5.ok, "A24r four glossed dish names pass", kd5.failed);
    eq(kd5.checks.find((c) => c.name === "no_untranslated_norwegian")?.detail, "kept:fenalår,pinnekjøtt,rømmegrøt,lefse", "A24s tolerated kept terms are recorded in the check detail");
    const st1 = svc.verifyTranslationDeterministic("Bestill på nett og/eller ring oss.", "Order online og/eller call us.", "en");
    ok(!st1.ok && st1.failed.includes("no_norwegian_stopwords"), "A24t 'og/eller' glued to a slash is still caught", st1.failed);
    const st2 = svc.verifyTranslationDeterministic("Vi selger kaffe, og kaker.", "We sell coffee,og cakes.", "en");
    ok(!st2.ok && st2.failed.includes("no_norwegian_stopwords"), "A24u 'og' glued to a comma is still caught", st2.failed);
    const st3 = svc.verifyTranslationDeterministic("Vi leverer til Bergen og Oslo hver uke.", "We deliver to Bergen og Oslo every week.", "en");
    ok(!st3.ok && st3.failed.includes("no_norwegian_stopwords"), "A24v coordinated place names ('Bergen og Oslo') are not a name phrase", st3.failed);
    const st4 = svc.verifyTranslationDeterministic("Kari og Ola driver gården sammen.", "Kari og Ola run the farm together.", "en");
    ok(!st4.ok && st4.failed.includes("no_norwegian_stopwords"), "A24w coordinated person names are not a name phrase", st4.failed);
    const st5 = svc.verifyTranslationDeterministic("Vi levererar till Bergen og Oslo varje vecka.", "Vi levererar till Bergen og Oslo varje vecka.", "sv", { alreadyTargetLanguage: true });
    ok(!st5.ok && st5.failed.includes("no_norwegian_stopwords"), "A24x Swedish path also rejects coordinated 'og'", st5.failed);
    const st6 = svc.verifyTranslationDeterministic("Del av Auk — Smaker fra Stjørdalsføret.", "Part of Auk — Smaker fra Stjørdalsføret.", "en");
    ok(st6.ok, "A24y membership marker licenses the network name", st6.failed);
    const st7 = svc.verifyTranslationDeterministic("Gården ligger i Møre og Romsdal.", "The farm is in Møre og Romsdal.", "en");
    ok(st7.ok, "A24z known county name passes", st7.failed);
    const pf1 = svc.verifyTranslationDeterministic("Gården ligger ved fjorden og har egen butikk.", "The Gård lies by the fjord and has its own shop.", "en");
    ok(!pf1.ok && pf1.failed.includes("no_untranslated_norwegian"), "A24aa sentence-initial common noun does not license its stem", pf1.failed);
    const pf2 = svc.verifyTranslationDeterministic("Gårdsbutikken er åpen lørdager. Velkommen!", "The Gårdsbutikk is open Saturdays. Welcome!", "en");
    ok(!pf2.ok && pf2.failed.includes("no_untranslated_norwegian"), "A24ab stem of a sentence-initial noun after a full stop is refused", pf2.failed);
    const pf3 = svc.verifyTranslationDeterministic("Vi har åpent lørdager.", "We are open Lørdag.", "en");
    ok(!pf3.ok && pf3.failed.includes("no_untranslated_norwegian"), "A24ac capitalised prefix of a lowercase source word is refused", pf3.failed);
    const pf4 = svc.verifyTranslationDeterministic("Turen går til Bøen i Telemark.", "The trip goes to Bøe in Telemark.", "en");
    ok(!pf4.ok && pf4.failed.includes("no_untranslated_norwegian"), "A24ad prefixes shorter than four characters are refused", pf4.failed);
    const cc1 = svc.verifyTranslationDeterministic("Bygninger fra 1600-tallet og 1600 meter over havet.", "Buildings from the 17th century, high above the sea.", "en");
    ok(!cc1.ok && cc1.failed.includes("digits_preserved"), "A22l a second missing occurrence of the same digits still fails", cc1.failed);
    const cc2 = svc.verifyTranslationDeterministic("Damsgård Hovedgård — 1700-tallsgods med historiske hager i Bergen", "Damsgård Hovedgård — 18th-century estate with historic gardens in Bergen", "en", { kind: "title" });
    ok(cc2.ok, "A22m '1700-tallsgods' → '18th-century' passes", cc2.failed);
    const pt1 = svc.verifyTranslationDeterministic("Museum Nord – Vesterålen og Lofoten", "Museum Nord – Vesterålen og Lofoten", "en", { kind: "title" });
    ok(pt1.ok, "A25b all-proper-noun title may be identical in English", pt1.failed);
    const pt2 = svc.verifyTranslationDeterministic("Guidet tur til Vesterålen og Lofoten", "Guidet tur til Vesterålen og Lofoten", "en", { kind: "title" });
    ok(!pt2.ok && pt2.failed.includes("not_verbatim_copy"), "A25c identical title with lowercase words still fails", pt2.failed);
    // junk sources are never planned
    ok(svc.isJunkSource("Oppdaget via brreg-nace-discovery"), "A40 pipeline metadata is junk");
    ok(svc.isJunkSource("Saltfjell Rein | lokale råvarer function setREVStartSize(e){ window.requestAnimationFrame }"), "A41 scraped JavaScript is junk");
    ok(svc.isJunkSource("AS hjem Historie Festkaker Bryllup Dåp Konfirmasjon Kontakt Welcome UTLEIE Nettbutikk hjem Historie Festkaker Bryllup Dåp"), "A42 scraped navigation menu is junk");
    ok(!svc.isJunkSource("Økologisk fjellgård i Fjellgardane, 15 km vest for Fyresdal sentrum. Elin og Tor brakte liv tilbake til gården."), "A43 a real profile text is not junk");
    ok(!svc.isJunkSource("Hardanger Cideri — Ullensvang"), "A44 a short title is not junk");
    const v3 = svc.verifyTranslationDeterministic(src, good.replace("https://example.no/gard", "https://example.com/farm"), "en");
    ok(!v3.ok && v3.failed.includes("urls_preserved"), "A23 changed URL fails", v3.failed);
    const v4 = svc.verifyTranslationDeterministic(src, good.replace("Saturdays", "lørdager"), "en");
    ok(!v4.ok && v4.failed.includes("no_untranslated_norwegian"), "A24 leftover Norwegian word fails", v4.failed);
    const v5 = svc.verifyTranslationDeterministic(src, src, "en");
    ok(!v5.ok && v5.failed.includes("not_verbatim_copy"), "A25 verbatim copy fails", v5.failed);
    const v6 = svc.verifyTranslationDeterministic("Rørosmeieriet", "Rørosmeieriet", "en", { kind: "title", alreadyTargetLanguage: true });
    ok(v6.ok, "A26 short proper-noun title identical is fine", v6.failed);
    const v7 = svc.verifyTranslationDeterministic(src, "<p>" + good + "</p>", "en");
    ok(!v7.ok && v7.failed.includes("no_markup"), "A27 markup fails", v7.failed);
    const v8 = svc.verifyTranslationDeterministic(src, "Farm.", "en");
    ok(!v8.ok && v8.failed.includes("length_ratio"), "A28 far too short fails", v8.failed);
    const svGood = "Gården ligger i Bø i Telemark. Vi säljer ost och honung, öppet lördagar 10–15. Ring 91234567 eller se https://example.no/gard.";
    const v9 = svc.verifyTranslationDeterministic(src, svGood, "sv");
    ok(v9.ok, "A29 Swedish translation with å/ä/ö passes", v9.failed);
    const v10 = svc.verifyTranslationDeterministic(src, svGood.replace("öppet lördagar", "åpent lørdager"), "sv");
    ok(!v10.ok && v10.failed.includes("no_untranslated_norwegian"), "A30 Norwegian ø-word leaks into sv fails", v10.failed);
    const v11 = svc.verifyTranslationDeterministic("Besøk oss på e-post: post@gard.no", "Contact us by e-mail: post@gard.no", "en");
    ok(v11.ok, "A31 e-mail preserved passes", v11.failed);
    const v12 = svc.verifyTranslationDeterministic("Besøk oss på e-post: post@gard.no", "Contact us by e-mail: hello@gard.no", "en");
    ok(!v12.ok && v12.failed.includes("emails_preserved"), "A32 changed e-mail fails", v12.failed);
    const v13 = svc.verifyTranslationDeterministic("Nordlandsmuseet i Bodø – vikingsølv og 10 000 års historie", "Nordlandsmuseet i Bodø – Viking silver and 10 000 years of history", "en", { kind: "title" });
    ok(!v13.ok && v13.failed.includes("no_norwegian_stopwords") && (v13.checks.find((c) => c.name === "no_norwegian_stopwords")?.detail === "i"), "A32b leaked lowercase 'i' in English fails", v13.failed);
    const v14 = svc.verifyTranslationDeterministic("Nordlandsmuseet i Bodø – vikingsølv og 10 000 års historie", "Nordlandsmuseet in Bodø – Viking silver and 10 000 years of history", "en", { kind: "title" });
    ok(v14.ok, "A32c corrected 'in' passes", v14.failed);
    const v15 = svc.verifyTranslationDeterministic("Gården ligger i Bø og selger ost.", "Gården ligger i Bø och säljer ost.", "sv");
    ok(v15.ok, "A32d Swedish with 'i' (shared word) passes", v15.failed);
    const v16 = svc.verifyTranslationDeterministic("Gården ligger i Bø og selger ost.", "Gården ligger i Bø og säljer ost.", "sv");
    ok(!v16.ok && v16.failed.includes("no_norwegian_stopwords"), "A32e Norwegian 'og' in Swedish fails", v16.failed);
    const v17 = svc.verifyTranslationDeterministic("Bakeriet Hos Mor selger brød.", "The bakery Hos Mor sells bread.", "en", { entityName: "Bakeriet Hos Mor" });
    ok(v17.ok, "A32f stopword that is part of the entity name is allowed", v17.failed);
    const v18 = svc.verifyTranslationDeterministic("Lysefjorden fjordcruise med elektrisk katamaran", "Lysefjorden fjordcruise med elektrisk katamaran", "sv", { kind: "title" });
    ok(v18.ok, "A32g identical short Swedish title (≤8 words) accepted", v18.failed);
    const v19 = svc.verifyTranslationDeterministic("Lysefjorden fjordcruise med elektrisk katamaran", "Lysefjorden fjordcruise med elektrisk katamaran", "en", { kind: "title" });
    ok(!v19.ok && v19.failed.includes("not_verbatim_copy"), "A32h identical 5-word English title still rejected", v19.failed);
    const longNo = "Vi tilbyr guidede turer på fjorden hver dag hele sommeren med erfarne guider og god plass.";
    const v20 = svc.verifyTranslationDeterministic(longNo, longNo, "sv");
    ok(!v20.ok && v20.failed.includes("not_verbatim_copy"), "A32i identical long Swedish prose (>8 words) still rejected", v20.failed);

    // JSON extraction + verdict parsing
    eq(svc.extractJsonObject('Here you go:\n```json\n{"translation":"x","already_target_language":false,"notes":""}\n```')?.translation, "x", "A33 extractJsonObject strips fences");
    eq(svc.extractJsonObject("no json here"), null, "A34 extractJsonObject null on prose");
    const rv = svc.parseReviewVerdict({ verdict: "approve", fidelity: 5, fluency: 4, issues: [{ type: "style", severity: "minor", detail: "x" }], summary: "fine" });
    ok(!!rv && rv.verdict === "APPROVE" && svc.reviewAccepts(rv), "A35 APPROVE 5/4 minor accepted");
    const rv2 = svc.parseReviewVerdict({ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [{ type: "number", severity: "major", detail: "price" }] });
    ok(!!rv2 && !svc.reviewAccepts(rv2), "A36 APPROVE with a major issue is NOT accepted");
    const rv3 = svc.parseReviewVerdict({ verdict: "APPROVE", fidelity: 3, fluency: 5, issues: [] });
    ok(!!rv3 && !svc.reviewAccepts(rv3), "A37 APPROVE with fidelity 3 is NOT accepted");
    eq(svc.parseReviewVerdict({ verdict: "MAYBE", fidelity: 5, fluency: 5 }), null, "A38 unknown verdict → null");

    // planItem
    const base: any = { source_hash: "h1", status: "verified", attempts: 1 };
    eq(svc.planItem(null, "h1").action, "new", "A39 planItem new");
    eq(svc.planItem(base, "h1").action, "skip", "A40 planItem verified same hash skip");
    eq(svc.planItem(base, "h2").action, "source_changed", "A41 planItem hash changed");
    eq(svc.planItem({ ...base, status: "rejected" }, "h1"), { action: "skip", reason: "rejected_manual_queue" }, "A42 planItem rejected skip");
    eq(svc.planItem({ ...base, status: "draft", attempts: 0 }, "h1"), { action: "retry", attempts: 0 }, "A43 planItem draft retry");
    eq(svc.planItem({ ...base, status: "draft", attempts: svc.MAX_TRANSLATION_ATTEMPTS }, "h1"), { action: "skip", reason: "max_attempts" }, "A44 planItem draft at cap skip");

    // ───────────────────────────── B. store + pipeline (rfb :memory:) ───
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevDb = initMod.__peekDbForTesting();
    const rfbDb = new Database(":memory:");
    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const hasTable = rfbDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_translations'").get();
      ok(!!hasTable, "B1 profile_translations table created by rfb initSchema");

      const insAgent = rfbDb.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insAgent.run("a1", "Solgården", "Vi selger økologiske grønnsaker og honning fra egen gård i Bø. Åpent lørdager 10–15.", "test", "a1@x.no", "https://a1.no", "producer", "k1", 1);
      insAgent.run("a2", "Inaktiv gård", "Skal ikke oversettes.", "test", "a2@x.no", "https://a2.no", "producer", "k2", 0);
      insAgent.run("a3", "Logistikk AS", "Ikke en produsent.", "test", "a3@x.no", "https://a3.no", "logistics", "k3", 1);
      rfbDb.prepare(`INSERT INTO agent_knowledge (agent_id, about) VALUES (?, ?)`).run("a1", "Solgården har vært i familiens eie siden 1952. Vi dyrker gulrøtter, poteter og bær, og har bikuber på tunet.");

      const items = svc.collectSourceItems(rfbDb as any, "rfb");
      eq(items.map((i) => `${i.entity_id}:${i.field}`), ["a1:description", "a1:about"], "B2 only active producer fields collected");

      const plan = svc.planTranslationBatch(rfbDb as any, "rfb", ["en", "sv"], 10);
      eq(plan.actionable.length, 4, "B3 2 fields × 2 langs planned");
      eq(plan.total_pairs, 4, "B4 total pairs 4");
      const planLimited = svc.planTranslationBatch(rfbDb as any, "rfb", ["en"], 1);
      eq([planLimited.actionable.length, planLimited.remaining_actionable], [1, 1], "B5 limit caps actionable and reports remaining");

      // B6: missing API key → translate_failed, stays draft, attempts 1, no fetch
      delete process.env.ANTHROPIC_API_KEY;
      const noKeyLog = { calls: [] as any[] };
      const r0 = await svc.processTranslationItem(rfbDb as any, "rfb", plan.actionable[0], "b-nokey", { fetchImpl: makeFakeFetch({ translations: [], reviews: [] }, noKeyLog) as any });
      eq([r0.outcome, r0.status, r0.attempts, noKeyLog.calls.length], ["translate_failed", "draft", 0, 0], "B6 missing key fail-closed: draft, no fetch, attempt NOT counted (infra)");
      ok(/ANTHROPIC_API_KEY/.test(r0.reason || ""), "B7 reason names the missing key");

      process.env.ANTHROPIC_API_KEY = "test-key";
      // B8: happy path — translator JSON, reviewer APPROVE → verified
      const descEn = plan.actionable.find((p) => p.item.field === "description" && p.lang === "en")!;
      const log1 = { calls: [] as any[] };
      const fake1 = makeFakeFetch({
        translations: [{ translation: "We sell organic vegetables and honey from our own farm in Bø. Open Saturdays 10–15.", already_target_language: false, notes: "" }],
        reviews: [{ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "Accurate and natural." }],
      }, log1);
      const r1 = await svc.processTranslationItem(rfbDb as any, "rfb", descEn, "b-1", { fetchImpl: fake1 as any });
      eq([r1.outcome, r1.status], ["verified", "verified"], "B8 approve+verify → verified");
      eq(log1.calls.length, 2, "B9 exactly two LLM calls (translate + review)");
      ok(/professional Norwegian-to-English translator/.test(log1.calls[0].system), "B10 first call is the translator prompt");
      ok(/senior English linguist/.test(log1.calls[1].system), "B11 second call is the reviewer prompt");
      ok(log1.calls[0].user.includes("Solgården") && log1.calls[0].user.includes("Field: description"), "B12 translator prompt carries entity name + field");
      ok(log1.calls[1].user.includes("We sell organic vegetables"), "B13 reviewer sees the translation");
      eq(log1.calls[0].model, svc.DEFAULT_TRANSLATOR_MODEL, "B14 default translator model used");
      const row1 = svc.getTranslationById(rfbDb as any, r1.id)!;
      ok(!!row1.review_json && !!row1.verify_json && !!row1.verified_at && row1.reviewed_at !== null, "B15 review/verify JSON + timestamps persisted");
      const audit1 = svc.listTranslationAudit(rfbDb as any, r1.id);
      eq(audit1.map((a: any) => a.to_status).reverse(), ["draft", "draft", "draft", "reviewed", "verified"], "B16 audit trail: collected, (nokey attempt), translated, reviewed, verified");

      // serve-flag gating
      delete process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED;
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "en"), {}, "B17 verified-but-unpublished not served");
      const pubDry = svc.publishVerified(rfbDb as any, "rfb", "en", { dryRun: true, batchId: "p0", actor: "test" });
      eq([pubDry.would_publish, pubDry.published], [1, 0], "B18 publish dry-run counts, writes nothing");
      eq(svc.getTranslationById(rfbDb as any, r1.id)!.status, "verified", "B19 still verified after dry-run");
      const pub = svc.publishVerified(rfbDb as any, "rfb", "en", { dryRun: false, batchId: "p1", actor: "test" });
      eq(pub.published, 1, "B20 publish flips verified → published");
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "en"), {}, "B21 published but SERVE flag off → not served");
      process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = "true";
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "en"), { description: "We sell organic vegetables and honey from our own farm in Bø. Open Saturdays 10–15." }, "B22 served with flag on");
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "sv"), {}, "B23 sv has nothing published");
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "no"), {}, "B24 no never served");
      const bulk = svc.getPublishedProfileTranslationsBulk(rfbDb as any, "rfb", "agent", ["a1", "a2"], "en");
      eq(bulk.get("a1")?.description?.slice(0, 7), "We sell", "B25 bulk lookup");
      const preview = svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "en", { ignoreServeFlag: true, includeVerified: true });
      ok(!!preview.description, "B26 preview ignores serve flag");
      const un = svc.unpublish(rfbDb as any, "rfb", "en", { batchId: "u1", actor: "test" });
      eq(un.unpublished, 1, "B27 unpublish");
      eq(svc.getTranslationById(rfbDb as any, r1.id)!.status, "verified", "B28 back to verified after unpublish");
      svc.publishVerified(rfbDb as any, "rfb", "en", { dryRun: false, batchId: "p2", actor: "test" });

      // B29: REVISE → second attempt → APPROVE
      const aboutEn = plan.actionable.find((p) => p.item.field === "about" && p.lang === "en")!;
      const log2 = { calls: [] as any[] };
      const fake2 = makeFakeFetch({
        translations: [
          { translation: "Solgården has been family owned since 1952. We grow carrots, potatoes and berries, and keep beehives.", already_target_language: false, notes: "" },
          { translation: "Solgården has been in the family's ownership since 1952. We grow carrots, potatoes and berries, and keep beehives in the farmyard.", already_target_language: false, notes: "" },
        ],
        reviews: [
          { verdict: "REVISE", fidelity: 3, fluency: 5, issues: [{ type: "omission", severity: "major", detail: "'på tunet' (in the farmyard) omitted" }], summary: "omission" },
          { verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" },
        ],
      }, log2);
      const r2 = await svc.processTranslationItem(rfbDb as any, "rfb", aboutEn, "b-2", { fetchImpl: fake2 as any });
      eq([r2.outcome, r2.attempts], ["verified", 2], "B29 REVISE → retry → APPROVE → verified after 2 attempts");
      eq(log2.calls.length, 4, "B30 four LLM calls for the revise round");
      ok(/reviewer rejected the previous attempt/.test(log2.calls[2].user) && /farmyard/.test(log2.calls[2].user), "B31 retry prompt carries the reviewer's issues");

      // B32: REJECT → rejected, no retry
      const descSv = plan.actionable.find((p) => p.item.field === "description" && p.lang === "sv")!;
      const log3 = { calls: [] as any[] };
      const fake3 = makeFakeFetch({
        translations: [{ translation: "Vi säljer ekologiska grönsaker och honung från vår egen gård i Bø. Öppet lördagar 10–15.", already_target_language: false, notes: "" }],
        reviews: [{ verdict: "REJECT", fidelity: 1, fluency: 5, issues: [{ type: "meaning", severity: "major", detail: "wrong" }], summary: "bad" }],
      }, log3);
      const r3 = await svc.processTranslationItem(rfbDb as any, "rfb", descSv, "b-3", { fetchImpl: fake3 as any });
      eq([r3.outcome, r3.status, log3.calls.length], ["rejected_review", "rejected", 2], "B32 REJECT → rejected, no retry");
      eq(svc.planItem(svc.getTranslationById(rfbDb as any, r3.id), descSv.hash), { action: "skip", reason: "rejected_manual_queue" }, "B33 rejected row is skipped by the planner");
      const rq = svc.requeueTranslation(rfbDb as any, r3.id, "test")!;
      eq([rq.status, rq.attempts], ["draft", 0], "B34 requeue resets to draft/0");

      // B35: reviewer approves but deterministic verify fails (digit dropped)
      const aboutSv = plan.actionable.find((p) => p.item.field === "about" && p.lang === "sv")!;
      const fake4 = makeFakeFetch({
        translations: [{ translation: "Solgården har varit i familjens ägo i många år. Vi odlar morötter, potatis och bär och har bikupor på gården.", already_target_language: false, notes: "" }],
        reviews: [{ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" }],
      }, { calls: [] });
      const r4 = await svc.processTranslationItem(rfbDb as any, "rfb", aboutSv, "b-4", { fetchImpl: fake4 as any });
      eq([r4.outcome, r4.status], ["rejected_verify", "rejected"], "B35 approve but digits (1952) dropped → rejected_verify");
      ok((r4.verify?.failed || []).includes("digits_preserved"), "B36 failed check named", r4.verify?.failed);

      // B37: manual reject of a published row
      const rej = svc.rejectTranslation(rfbDb as any, r1.id, "spot-check: awkward phrasing", "daniel")!;
      eq([rej.status, rej.published_at], ["rejected", null], "B37 manual reject unpublishes");
      eq(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "en"), {}, "B38 rejected row no longer served");
      svc.requeueTranslation(rfbDb as any, r1.id, "test");

      // B39: source change supersedes
      rfbDb.prepare(`UPDATE agents SET description = ? WHERE id = 'a1'`).run("Vi selger økologiske grønnsaker, honning og egg fra egen gård i Bø. Åpent lørdager 10–16.");
      const plan2 = svc.planTranslationBatch(rfbDb as any, "rfb", ["en"], 10);
      const changed = plan2.actionable.find((p) => p.item.field === "description");
      ok(!!changed && changed.decision.action === "source_changed", "B39 changed source detected", changed?.decision);
      const fake5 = makeFakeFetch({
        translations: [{ translation: "We sell organic vegetables, honey and eggs from our own farm in Bø. Open Saturdays 10–16.", already_target_language: false, notes: "" }],
        reviews: [{ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" }],
      }, { calls: [] });
      const r5 = await svc.processTranslationItem(rfbDb as any, "rfb", changed!, "b-5", { fetchImpl: fake5 as any });
      const row5 = svc.getTranslationById(rfbDb as any, r5.id)!;
      eq([r5.outcome, row5.id === r1.id, row5.attempts], ["verified", true, 1], "B40 same row re-translated after source change, attempts reset");
      ok((row5.prev_translated_text || "").startsWith("We sell organic vegetables and honey"), "B41 previous translation kept in prev_translated_text");
      eq(row5.source_hash, changed!.hash, "B42 new hash stored");

      const counts = svc.translationStatusCounts(rfbDb as any, "rfb");
      ok(counts.en && counts.en.verified === 2 && (counts.sv?.draft || 0) === 1 && (counts.sv?.rejected || 0) === 1, "B43 status counts", counts);
      const q = svc.listTranslationQueue(rfbDb as any, "rfb", { lang: "sv", status: "rejected" });
      eq(q.length, 1, "B44 queue filter");

      // ───────────────────────────── C. admin route ─────────────────────
      const router = (require("../routes/admin-profile-translations") as typeof import("../routes/admin-profile-translations")).default;
      const key = process.env.ADMIN_KEY || "profile-translations-test-key";
      process.env.ADMIN_KEY = key;
      const H = { "x-admin-key": key };

      const c1 = await callRoute(router, { url: "/status?platform=rfb" });
      eq(c1.status, 403, "C1 missing key → 403");
      const c2 = await callRoute(router, { url: "/status?platform=rfb", headers: { "x-admin-key": "wrong" } });
      eq(c2.status, 403, "C2 wrong key → 403");
      const c3 = await callRoute(router, { url: "/status?platform=nope", headers: H });
      eq(c3.status, 400, "C3 bad platform → 400");
      const c4 = await callRoute(router, { url: "/status?platform=rfb", headers: H });
      eq(c4.status, 200, "C4 status 200");
      ok(c4.body.source_fields_total === 2 && c4.body.counts.en.verified === 2, "C5 status counts + source fields", c4.body);
      eq(c4.body.flags.pipeline_enabled, false, "C6 flags snapshot reports pipeline off");

      // flag OFF → /run with dry_run:false is a pure no-op (no fetch, no writes)
      delete process.env.PROFILE_TRANSLATIONS_ENABLED;
      const before = rfbDb.prepare("SELECT COUNT(*) AS n FROM profile_translation_audit").get() as any;
      const offLog = { calls: [] as any[] };
      const app = { get: (k: string) => (k === "profileTranslationsFetchImpl" ? makeFakeFetch({ translations: [], reviews: [] }, offLog) : undefined) };
      const c7 = await callRoute(router, { url: "/run", method: "POST", headers: H, body: { platform: "rfb", dry_run: false }, app });
      const after = rfbDb.prepare("SELECT COUNT(*) AS n FROM profile_translation_audit").get() as any;
      eq([c7.status, c7.body.enabled, offLog.calls.length, after.n - before.n], [200, false, 0, 0], "C7 flag OFF: {enabled:false}, no fetch, no audit writes");

      // dry-run (default) plans without fetch even with the flag on
      process.env.PROFILE_TRANSLATIONS_ENABLED = "true";
      const c8 = await callRoute(router, { url: "/run", method: "POST", headers: H, body: { platform: "rfb", langs: ["sv"] }, app });
      eq([c8.status, c8.body.dry_run, offLog.calls.length], [200, true, 0], "C8 dry_run default → plan only");
      eq(c8.body.planned_count, 1, "C9 one sv item plannable (the requeued draft)");
      const c8b = await callRoute(router, { url: "/run", method: "POST", headers: H, body: { platform: "rfb", dry_run: "false" }, app });
      eq(c8b.body.dry_run, true, "C10 dry_run:\"false\" (string) is still a dry run (STRICT-FALSE)");
      const c8c = await callRoute(router, { url: "/run", method: "POST", headers: H, body: { platform: "rfb", langs: ["de"] } });
      eq(c8c.status, 400, "C11 unknown lang → 400");

      // real run through the app-level fetch seam
      const runLog = { calls: [] as any[] };
      const appRun = {
        get: (k: string) => (k === "profileTranslationsFetchImpl"
          ? makeFakeFetch({
              translations: [{ translation: "Vi säljer ekologiska grönsaker, honung och ägg från vår egen gård i Bø. Öppet lördagar 10–16.", already_target_language: false, notes: "" }],
              reviews: [{ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" }],
            }, runLog)
          : undefined),
      };
      const c12 = await callRoute(router, { url: "/run", method: "POST", headers: H, body: { platform: "rfb", langs: ["sv"], dry_run: false, limit: 5 }, app: appRun });
      eq([c12.status, c12.body.dry_run, c12.body.processed, c12.body.outcomes.verified, runLog.calls.length], [200, false, 1, 1, 2], "C12 real run: 1 item verified via app fetch seam", c12.body);
      ok(typeof c12.body.batch_id === "string" && c12.body.usage.calls === 2, "C13 batch id + usage reported");

      const c14 = await callRoute(router, { url: "/queue?platform=rfb&lang=sv&status=verified", headers: H });
      eq([c14.status, c14.body.count], [200, 1], "C14 queue lists the verified sv row");
      ok(c14.body.rows[0].review?.verdict === "APPROVE" && c14.body.rows[0].verify?.ok === true, "C15 queue rows expose review + verify JSON");
      const c16 = await callRoute(router, { url: "/publish", method: "POST", headers: H, body: { platform: "rfb", lang: "sv" } });
      eq([c16.status, c16.body.dry_run, c16.body.would_publish, c16.body.published], [200, true, 1, 0], "C16 publish default dry-run");
      const c17 = await callRoute(router, { url: "/publish", method: "POST", headers: H, body: { platform: "rfb", lang: "sv", dry_run: false } });
      eq(c17.body.published, 1, "C17 publish real");
      const c18 = await callRoute(router, { url: "/preview?platform=rfb&entity_type=agent&entity_id=a1&lang=sv", headers: H });
      ok(c18.status === 200 && c18.body.fields.some((f: any) => f.field === "description" && /honung/.test(f.published_text || "")), "C18 preview shows published sv text", c18.body);
      const c19 = await callRoute(router, { url: "/unpublish", method: "POST", headers: H, body: { platform: "rfb", lang: "sv" } });
      eq(c19.body.unpublished, 1, "C19 unpublish via route");
      const c20 = await callRoute(router, { url: "/reject", method: "POST", headers: H, body: { platform: "rfb", id: c14.body.rows[0].id, reason: "test" } });
      eq([c20.status, c20.body.status], [200, "rejected"], "C20 reject via route");
      const c21 = await callRoute(router, { url: "/requeue", method: "POST", headers: H, body: { platform: "rfb", id: c14.body.rows[0].id } });
      eq([c21.status, c21.body.status], [200, "draft"], "C21 requeue via route");
      const c22 = await callRoute(router, { url: `/audit?platform=rfb&id=${c14.body.rows[0].id}`, headers: H });
      ok(c22.status === 200 && c22.body.audit.length >= 4, "C22 audit history via route");

      // ───────────────────────────── E. session lane (collect → submit) ──
      // Pipeline flag is OFF here (deleted above) — the lane must work anyway.
      // State at this point: the sv description row is a draft (requeued in
      // B34, source changed in B38-B42), the sv about row is rejected/draft.
      const svAboutRow = svc.listTranslationQueue(rfbDb as any, "rfb", { lang: "sv" }).find((r) => r.field === "about")!;
      if (svAboutRow.status !== "draft") svc.requeueTranslation(rfbDb as any, svAboutRow.id, "test");
      const e1 = await callRoute(router, { url: "/collect?platform=rfb&langs=sv&limit=10", headers: H });
      eq(e1.status, 200, "E1 collect 200 with pipeline flag off");
      ok(e1.body.items_count === 2 && e1.body.items.every((i: any) => i.id > 0 && i.source_hash && i.lang === "sv" && i.source_text && i.kind === "prose"), "E2 two sv drafts collected with ids/hashes", e1.body.items);
      ok(String(e1.body.instructions.sv.translator_system).includes("Swedish") && String(e1.body.instructions.sv.reviewer_system).length > 100, "E3 instructions carry translator + reviewer system prompts");
      const eDesc = e1.body.items.find((i: any) => i.field === "description");
      const eAbout = e1.body.items.find((i: any) => i.field === "about");
      const goodReview = { verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" };
      const svDesc = "Vi säljer ekologiska grönsaker, honung och ägg från vår egen gård i Bø. Öppet lördagar 10–16.";
      const e4 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: svDesc }] } });
      eq(e4.status, 400, "E4 submit without review → 400");
      const beforeText = svc.getTranslationById(rfbDb as any, eDesc.id)!.translated_text;
      const e5 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, source_hash: "stale", translated_text: svDesc, review: goodReview }] } });
      eq([e5.status, e5.body.results[0].outcome, svc.getTranslationById(rfbDb as any, eDesc.id)!.translated_text], [200, "source_changed", beforeText], "E5 stale source_hash → source_changed, row untouched");
      const e6 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", actor: "test-session", items: [{ id: eDesc.id, source_hash: eDesc.source_hash, translated_text: svDesc, review: goodReview, kept_terms: [] }] } });
      eq([e6.status, e6.body.outcomes.verified, e6.body.results[0].status], [200, 1, "verified"], "E6 APPROVE + deterministic verify → verified");
      const eRow = svc.getTranslationById(rfbDb as any, eDesc.id)!;
      eq([eRow.translator_model, eRow.reviewer_model, eRow.status, eRow.attempts], ["claude-code-session", "claude-code-session-review", "verified", 1], "E7 session labels + attempt stored");
      const e8 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: "Något annat.", review: goodReview }] } });
      eq([e8.body.results[0].outcome, svc.getTranslationById(rfbDb as any, eDesc.id)!.translated_text], ["skipped_status", svDesc], "E8 verified row refuses a new submission");
      const e9 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eAbout.id, source_hash: eAbout.source_hash, translated_text: "Solgården har varit i familjens ägo i många år. Vi odlar morötter, potatis och bär och har bikupor på gården.", review: goodReview }] } });
      eq([e9.body.results[0].outcome, e9.body.results[0].status], ["rejected_verify", "rejected"], "E9 APPROVE but 1952 dropped → rejected_verify");
      ok((e9.body.results[0].verify?.failed || []).includes("digits_preserved"), "E10 failed check named in result");
      await callRoute(router, { url: "/requeue", method: "POST", headers: H, body: { platform: "rfb", id: eAbout.id } });
      const reviseReview = { verdict: "REVISE", fidelity: 3, fluency: 4, issues: [{ type: "omission", severity: "major", detail: "year 1952 missing" }], summary: "add the year" };
      const e11 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eAbout.id, translated_text: "Solgården har varit i familjens ägo länge.", review: reviseReview }] } });
      eq([e11.body.results[0].outcome, e11.body.results[0].status, e11.body.results[0].attempts], ["revise", "draft", 1], "E11 REVISE keeps the draft for a second pass");
      const e12 = await callRoute(router, { url: "/collect?platform=rfb&langs=sv", headers: H });
      const e12About = e12.body.items.find((i: any) => i.id === eAbout.id);
      ok(e12.body.items_count === 1 && e12About && /1952/.test(e12About.feedback || "") && e12About.attempts === 1, "E12 re-collect returns the REVISE feedback for the draft", e12.body.items);
      const e13 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eAbout.id, translated_text: "Solgården har varit i familjens ägo länge.", review: { verdict: "REJECT", fidelity: 1, fluency: 4, issues: [], summary: "still wrong" } }] } });
      eq([e13.body.results[0].outcome, e13.body.results[0].status], ["rejected_review", "rejected"], "E13 REJECT → rejected_review");
      eq(svc.submitSessionTranslation(rfbDb as any, "rfb", { id: 999999, translated_text: "x", review: goodReview }, { actor: "t", batchId: "b" }).outcome, "not_found", "E14 unknown id → not_found");
      eq(svc.submitSessionTranslation(rfbDb as any, "opplevagent", { id: eDesc.id, translated_text: "x", review: goodReview }, { actor: "t", batchId: "b" }).outcome, "wrong_platform", "E15 platform mismatch refused");
      const e16 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [] } });
      eq(e16.status, 400, "E16 empty items → 400");
      // ─────────────── F. sync: stale sweep, claims, auto-republish ──────
      // (dev-request 2026-09-03-oversettelse-synk-og-eierprofiler)
      const fRow = svc.getTranslationById(rfbDb as any, eDesc.id)!;
      eq(fRow.status, "verified", "F1 fixture row is verified before publish");
      const fPub = await callRoute(router, { url: "/publish", method: "POST", headers: H, body: { platform: "rfb", lang: "sv", ids: [eDesc.id], dry_run: false } });
      eq([fPub.status, fPub.body.published], [200, 1], "F2 publish via route");
      eq(Number(svc.getTranslationById(rfbDb as any, eDesc.id)!.previously_published), 1, "F3 publishing stamps previously_published");

      // nothing changed yet → sweep finds nothing stale
      const f4 = svc.sweepStaleTranslations(rfbDb as any, "rfb", { dryRun: true, batchId: "s1", actor: "t" });
      eq([f4.stale, f4.unpublished], [0, 0], "F4 unchanged source: sweep finds nothing", f4);

      // the producer edits the Norwegian description
      rfbDb.prepare("UPDATE agents SET description = ? WHERE id = ?").run("Vi selger nå også epler og plommer fra egen hage i Bø.", "a1");
      const f5 = svc.sweepStaleTranslations(rfbDb as any, "rfb", { dryRun: true, batchId: "s2", actor: "t" });
      eq([f5.stale >= 1, f5.unpublished, f5.ids.includes(eDesc.id)], [true, 0, true], "F5 dry-run detects the changed source without writing", f5);
      eq(svc.getTranslationById(rfbDb as any, eDesc.id)!.status, "published", "F6 dry-run left the row published");
      const f7 = svc.sweepStaleTranslations(rfbDb as any, "rfb", { dryRun: false, batchId: "s3", actor: "stale-sweep" });
      ok(f7.unpublished >= 1 && f7.ids.includes(eDesc.id), "F7 apply unpublishes the changed row", f7);
      const f8 = svc.getTranslationById(rfbDb as any, eDesc.id)!;
      eq([f8.status, f8.published_at, f8.translated_text, Number(f8.previously_published)], ["draft", null, null, 1], "F8 row is a draft again, published_at cleared, previously_published kept");
      ok((f8.prev_translated_text || "").startsWith("Vi säljer"), "F9 the old translation is kept as prev_translated_text", f8.prev_translated_text);
      ok(f8.source_text.includes("plommer"), "F9b the sweep carried the new Norwegian into the row", f8.source_text);
      ok(svc.getPublishedProfileTranslations(rfbDb as any, "rfb", "agent", "a1", "sv", { ignoreServeFlag: true }).description === undefined, "F10 the page no longer serves the stale translation");

      // a source that disappears entirely (producer deactivated) is unpublished too
      const f11before = svc.sweepStaleTranslations(rfbDb as any, "rfb", { dryRun: true, batchId: "s4", actor: "t" });
      rfbDb.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run("a1");
      const f11 = svc.sweepStaleTranslations(rfbDb as any, "rfb", { dryRun: true, batchId: "s5", actor: "t" });
      ok(f11.missing_source > f11before.missing_source, "F11 a vanished source counts as missing_source", { before: f11before.missing_source, after: f11.missing_source });
      rfbDb.prepare("UPDATE agents SET is_active = 1 WHERE id = ?").run("a1");

      // auto-republish policy
      delete process.env.PROFILE_TRANSLATIONS_AUTO_REPUBLISH_ENABLED;
      eq(svc.isAutoRepublishEnabled(), false, "F12 auto-republish is off by default");
      const svDesc2 = "Vi säljer nu också äpplen och plommon från vår egen trädgård i Bø.";
      const goodReview2 = { verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" };
      const f13 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: svDesc2, review: goodReview2 }] } });
      eq([f13.body.results[0].outcome, f13.body.results[0].status], ["verified", "verified"], "F13 flag off: a re-translation stops at verified");

      process.env.PROFILE_TRANSLATIONS_AUTO_REPUBLISH_ENABLED = "true";
      svc.requeueTranslation(rfbDb as any, eDesc.id, "test");
      rfbDb.prepare("UPDATE profile_translations SET previously_published = 1 WHERE id = ?").run(eDesc.id);
      const f14 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: svDesc2, review: goodReview2 }] } });
      eq([f14.body.results[0].outcome, f14.body.results[0].status], ["auto_republished", "published"], "F14 flag on + previously published + unclaimed → auto-republished");

      // a first-ever translation is never auto-published
      svc.requeueTranslation(rfbDb as any, eDesc.id, "test");
      rfbDb.prepare("UPDATE profile_translations SET previously_published = 0 WHERE id = ?").run(eDesc.id);
      const f15 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: svDesc2, review: goodReview2 }] } });
      eq([f15.body.results[0].outcome, f15.body.results[0].status], ["verified", "verified"], "F15 a first-ever translation still waits for a human");

      // an owner-claimed producer is never auto-published, even when known
      eq(svc.isEntityOwnerClaimed(rfbDb as any, "rfb", "agent", "a1"), false, "F16 a1 is not claimed yet");
      rfbDb.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, ?, ?, 'verified')").run("c1", "a1", "Eier", "eier@a1.no");
      eq(svc.isEntityOwnerClaimed(rfbDb as any, "rfb", "agent", "a1"), true, "F17 a verified claim makes the entity owner-claimed");
      svc.requeueTranslation(rfbDb as any, eDesc.id, "test");
      rfbDb.prepare("UPDATE profile_translations SET previously_published = 1 WHERE id = ?").run(eDesc.id);
      const f18 = await callRoute(router, { url: "/submit", method: "POST", headers: H, body: { platform: "rfb", items: [{ id: eDesc.id, translated_text: svDesc2, review: goodReview2 }] } });
      eq([f18.body.results[0].outcome, f18.body.results[0].status], ["verified", "verified"], "F18 owner-claimed profile is never auto-republished");
      delete process.env.PROFILE_TRANSLATIONS_AUTO_REPUBLISH_ENABLED;

      // the queue exposes claim status so the spot check can pick claimed rows
      const f19 = await callRoute(router, { url: "/queue?platform=rfb&lang=sv&limit=50", headers: H });
      const f19row = f19.body.rows.find((r: any) => r.id === eDesc.id);
      eq(f19row.owner_claimed, true, "F19 /queue reports owner_claimed");
      const f20 = await callRoute(router, { url: "/sweep-stale", method: "POST", headers: H, body: { platform: "rfb" } });
      eq([f20.status, f20.body.dry_run], [200, true], "F20 /sweep-stale defaults to dry-run (STRICT-FALSE)");
      const f21 = await callRoute(router, { url: "/status?platform=rfb", headers: H });
      eq(f21.body.flags.auto_republish_enabled, false, "F21 status reports the auto-republish flag");
      rfbDb.prepare("DELETE FROM agent_claims WHERE agent_id = ?").run("a1");

      const e17 = await callRoute(router, { url: `/audit?platform=rfb&id=${eDesc.id}`, headers: H });
      ok(e17.body.audit.some((a: any) => /collected \(session lane\)/.test(a.note || "")) && e17.body.audit.some((a: any) => /translated by session/.test(a.note || "")), "E17 audit trail names the session lane", e17.body.audit);
    } finally {
      if (prevDb) initMod.__setDbForTesting(prevDb);
      try { rfbDb.close(); } catch { /* ignore */ }
    }

    // ───────────────────────────── D. opplevagent collection ──────────
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    try {
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      ok(!!expDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profile_translations'").get(), "D1 profile_translations table created by experiences schema");
      expDb.prepare(`INSERT INTO experience_providers (id, navn, producer_type, brreg_active, about_text, visit_text, opening_hours_text, catalog_hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("p1", "Fjordbrygg", "bryggeri", 1, "Fjordbrygg er et lite håndverksbryggeri ved fjorden. Vi brygger på lokalt korn og fjellvann.", "Besøket starter med en omvisning i bryggeriet og avsluttes med smaking av fire øl.", "Fredag og lørdag 12–18", 0);
      expDb.prepare(`INSERT INTO experience_providers (id, navn, producer_type, brreg_active, about_text, catalog_hidden) VALUES (?, ?, ?, ?, ?, ?)`)
        .run("p2", "Skjult bryggeri", "bryggeri", 1, "Denne skal ikke samles inn fordi den er skjult i katalogen.", 1);
      expDb.prepare(`INSERT INTO experiences (id, provider_id, title, title_no, description, meeting_point, category, verification_status, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("e1", "p1", "Brewery tour", "Bryggeriomvisning med smaking", "Bli med på en guidet omvisning i bryggeriet, og smak fire ulike øl sammen med bryggeren.", "Oppmøte ved hovedinngangen, Fjordveien 12.", "mat", "verified", "high");
      expDb.prepare(`INSERT INTO experiences (id, provider_id, title, description, category, verification_status, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("e2", "p1", "Ikke publisert", "Denne raden er ikke verifisert og skal ikke samles inn.", "mat", "needs_review", "high");
      const items = svc.collectSourceItems(expDb, "opplevagent");
      eq(items.map((i) => `${i.entity_type}:${i.entity_id}:${i.field}`).sort(), ["experience:e1:description", "experience:e1:meeting_point", "experience:e1:title", "provider:p1:about_text", "provider:p1:opening_hours_text", "provider:p1:visit_text"].sort(), "D2 only published experience + visible provider fields collected");
      const titleItem = items.find((i) => i.field === "title")!;
      eq(titleItem.text, "Bryggeriomvisning med smaking", "D3 title source is title_no (the NO display title)");
      eq(titleItem.entity_name, "Bryggeriomvisning med smaking", "D4 entity_name for experiences is the display title");
      const scoped = svc.collectSourceItems(expDb, "opplevagent", { entityIds: ["p1"] });
      eq(scoped.length, 3, "D5 entityIds filter scopes to one provider");
      const plan = svc.planTranslationBatch(expDb, "opplevagent", ["en"], 100);
      eq(plan.actionable.length, 6, "D6 six en items planned");
      const hoursItem = plan.actionable.find((p) => p.item.field === "opening_hours_text")!;
      const fake = makeFakeFetch({
        translations: [{ translation: "Friday and Saturday 12–18", already_target_language: false, notes: "" }],
        reviews: [{ verdict: "APPROVE", fidelity: 5, fluency: 5, issues: [], summary: "ok" }],
      }, { calls: [] });
      const r = await svc.processTranslationItem(expDb, "opplevagent", hoursItem, "d-1", { fetchImpl: fake as any });
      eq(r.outcome, "verified", "D7 opening hours verified in the experiences db");
      svc.publishVerified(expDb, "opplevagent", "en", { dryRun: false, batchId: "d-p", actor: "test" });
      process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = "true";
      eq(svc.getPublishedProfileTranslations(expDb, "opplevagent", "provider", "p1", "en"), { opening_hours_text: "Friday and Saturday 12–18" }, "D8 served from the experiences db");
    } finally {
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      dbFactory.__resetDbFactoryForTesting();
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err?.message || err)}`);
    if (log) console.log("  ✗ unexpected error", err);
  } finally {
    restoreEnv();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileTranslationsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
  });
}
