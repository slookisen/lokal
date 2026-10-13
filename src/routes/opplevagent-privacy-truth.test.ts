/**
 * opplevagent-privacy-truth.test.ts — dev-request
 * 2026-10-13-opplevagent-personvern-utsending.
 *
 * Proves Opplevagent's /personvern (experiences-seo.ts) truthfully covers the
 * outreach e-mail sent to providers, and that each claim matches the code:
 *
 *   1. The page mentions the outreach, the legal basis (legitimate interest,
 *      art. 6(1)(f)), the sources, the «fjern» objection reply, the
 *      do-not-contact list, the Datatilsynet complaint and the stored
 *      correspondence — in Norwegian and English.
 *   2. «fjern» HIDES the profile (catalog_hidden) — the page must say
 *      «skjules»/«hidden» and never «slettes»/«deleted» about that flow.
 *   3. The old claim that the provider e-mail is kept only until ownership is
 *      confirmed or rejected is gone.
 *   4. The privacy line the outreach e-mail links to, and the objection
 *      sentence, exist in the e-mail templates and match the page.
 *   5. Every vendor named on the page exists in the code (and the central
 *      ones are all named). OpenAI is NOT named: for Opplevagent it is only a
 *      stub in vision-provider.ts, so naming it would be an overclaim.
 *   6. Norwegian and English have the same structure (h2, li, tr counts).
 *
 * Standalone: npx tsx src/routes/opplevagent-privacy-truth.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function invokeGet(router: any, routePath: string): { found: boolean; status: number; body: string } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "" };
  let status = 200;
  let body = "";
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang: "no", params: {}, query: {}, headers: {}, get() { return undefined; } };
  layer.route.stack[layer.route.stack.length - 1].handle(req, res, () => { /* next() */ });
  return { found: true, status, body };
}

const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

export async function runOpplevagentPrivacyTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere, or dir missing in CI */ }
  } catch { /* routes fall back to defaults */ }

  const expRouter = require("./experiences-seo").default as any;
  const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");

  // ── Ground truth from the code ──────────────────────────────────────────
  const initExp = src("..", "database", "init-experiences.ts");
  const initDb = src("..", "database", "init.ts");
  const emailSvc = src("..", "services", "email-service.ts");
  const offsite = src("..", "services", "offsite-backup.ts");
  const inbound = src("..", "services", "inbound-email-webhook.ts");
  const contentJudge = src("..", "services", "experience-content-judge.ts");
  const translations = src("..", "services", "profile-translations.ts");
  const vision = src("..", "services", "vision-provider.ts");
  const opplevelser = src("opplevelser.ts");
  const dbBackupRoute = src("admin-db-backup.ts");
  const searchEnrich = src("..", "services", "search-enrich.ts");
  const geocodeWorker = src("..", "services", "experiences-geocode-worker.ts");
  const flyToml = fs.readFileSync(path.join(__dirname, "..", "..", "fly.toml"), "utf8");

  assertTrue(
    /CREATE TABLE IF NOT EXISTS experience_providers[\s\S]{0,1500}epost TEXT/.test(initExp) &&
      /CREATE TABLE IF NOT EXISTS experience_outreach_sent_log[\s\S]{0,400}recipient_email TEXT NOT NULL[\s\S]{0,200}sent_at[\s\S]{0,200}message_id/.test(initExp),
    "ground truth: provider e-mail is stored on experience_providers and every send is logged (recipient, time, message id)"
  );
  assertTrue(
    /ALTER TABLE crm_contacts ADD COLUMN provider_id/.test(initDb) && /from: crmFromHeader\("experiences"\)/.test(emailSvc),
    "ground truth: outreach is sent as the experiences CRM identity and filed against crm_contacts.provider_id"
  );
  assertTrue(
    /GARDSSALG_OUTREACH_REPLY_TO = "kontakt@opplevagent\.no"/.test(emailSvc),
    "ground truth: replies go to kontakt@opplevagent.no"
  );
  assertTrue(
    /ALTER TABLE experience_providers ADD COLUMN catalog_hidden INTEGER DEFAULT 0/.test(initExp) &&
      /gardssalg-provider-visibility/.test(initExp) && /real-producer delist/.test(initExp),
    "ground truth: delisting a real producer sets experience_providers.catalog_hidden (admin visibility lever), it is not a row delete"
  );
  assertTrue(
    /isBlocked/.test(opplevelser) && /agent_blocklist/.test(initDb),
    "ground truth: the experiences intake checks the do-not-re-add list (agent_blocklist)"
  );
  assertTrue(
    /OFFSITE_VERTICALS = \["rfb", "dental", "experiences"\]/.test(offsite) &&
      /selectBackupsToDelete\(objects: S3Object\[\], keepDays = 7, keepWeeks = 4\)/.test(offsite) &&
      /for \(const k of selectBackupsToDelete\(objs\)\)/.test(offsite),
    "ground truth: experiences.db is in the Tigris offsite backup with 7 daily + 4 weekly copies"
  );
  assertTrue(
    /pruneBackups\(dir, 10, config\.filenameRe\)/.test(dbBackupRoute) && /\?db=experiences/.test(dbBackupRoute),
    "ground truth: manual experiences.db copies on the volume keep the ten newest, no age limit"
  );
  assertTrue(
    /primary_region = 'arn'/.test(flyToml),
    "ground truth: the server runs on Fly.io in region ARN (Stockholm)"
  );
  assertTrue(
    /api\.resend\.com\/emails\/receiving/.test(inbound) && /process\.env\.ADMIN_EMAIL \|\| "[^"]*@gmail\.com"/.test(inbound),
    "ground truth: inbound e-mail comes in via Resend and is forwarded to a Gmail admin mailbox"
  );
  assertTrue(
    /connectors\.resend_domain/.test(emailSvc) && /Resend verifies one domain/.test(emailSvc),
    "ground truth: outgoing e-mail is sent through Resend (resend_domain connector; SMTP transport configured by env)"
  );
  assertTrue(
    /https:\/\/api\.anthropic\.com\/v1\/messages/.test(contentJudge) &&
      /https:\/\/api\.anthropic\.com\/v1\/messages/.test(translations) && /"opplevagent"/.test(translations),
    "ground truth: experience checks and Opplevagent profile translation call Anthropic"
  );
  assertTrue(
    /OpenAIVisionProvider[\s\S]{0,80}STUB|OpenAI Vision Provider \(STUB/.test(vision) && !/openai/i.test(opplevelser),
    "ground truth: OpenAI is only a stub (vision-provider.ts) and unused by the Opplevagent routes, so the page must not name it"
  );
  // The e-mail the page is linked from (both variants).
  const personalTpl = emailSvc.slice(emailSvc.indexOf("export function renderGardssalgOutreachPersonal"));
  const standardTpl = emailSvc.slice(emailSvc.indexOf("function buildGardssalgOutreachText"), emailSvc.indexOf("export type GardssalgOutreachTemplate"));
  for (const [name, tpl] of [["standard", standardTpl], ["personal", personalTpl]] as const) {
    assertTrue(
      /Slik behandler vi opplysningene: https:\/\/opplevagent\.no\/personvern/.test(tpl) && /svar «fjern», så fjerner jeg profilen/.test(tpl),
      `ground truth: the ${name} outreach e-mail links /personvern and says reply «fjern»`
    );
  }

  // ── Page content ────────────────────────────────────────────────────────
  const r = invokeGet(expRouter, "/personvern");
  assertTrue(r.found, "setup: GET /personvern is registered on experiences-seo.ts");
  if (!r.found) return { passed, failed, failures };
  assertTrue(r.status === 200, "/personvern renders 200");
  for (const alias of ["/privacy", "/privacy-policy"]) {
    assertTrue(invokeGet(expRouter, alias).found, `${alias} is served by the same route`);
  }

  const html = r.body;
  const split = html.indexOf('<h1 id="en">');
  assertTrue(split > 0, "setup: the page has a Norwegian part and an English part (#en)");
  const no = html.slice(0, split);
  const en = html.slice(split);

  // Strip tags for sentence-level checks.
  const text = (s: string) => s.replace(/<[^>]+>/g, "");
  const noT = text(no);
  const enT = text(en);

  // 1. Outreach, legal basis, sources, objection, blocklist, complaint, correspondence.
  assertTrue(/e-post vi sender uten at du har bedt om det/.test(noT) && /emails we send without being asked/.test(enT),
    "both parts have the outreach section");
  assertTrue(/berettiget interesse \(personvernforordningen art\. 6 nr\. 1 bokstav f\)/.test(noT) &&
    /legitimate interest \(GDPR art\. 6\(1\)\(f\)\)/.test(enT), "both parts name legitimate interest, art. 6(1)(f)");
  assertTrue(/Brønnøysundregistrene, tilbyderens egen nettside, Visit Norway \/ CBIS, Rett fra Bondens produsentregister, nettsøk \(Brave Search\) og kataloger og oppføringssider/.test(noT) &&
    /Norwegian business registry, the provider's own website, Visit Norway \/ CBIS, the Rett fra Bonden producer register, web search \(Brave Search\) and directory and listing pages/.test(enT), "both parts name the sources");
  assertTrue(/Svar «fjern» på e-posten/.test(noT) && /Reply “fjern” to the email/.test(enT),
    "both parts tell the provider to reply «fjern»");
  assertTrue(/protestere \(art\. 21\)/.test(noT) && /object at any time \(art\. 21\)/.test(enT),
    "both parts state the right to object, art. 21");
  assertTrue(/sperreliste/.test(noT) && /do-not-contact list/.test(enT), "both parts mention the do-not-contact list");
  assertTrue(/Datatilsynet/.test(noT) && /Datatilsynet/.test(enT), "both parts mention the Datatilsynet complaint right");
  assertTrue(/utsendingslogg/.test(noT) && /send log/.test(enT) && /korrespondansen/.test(noT) && /correspondence/.test(enT),
    "both parts say the send log and the correspondence are stored");
  assertTrue(/kontakt@opplevagent\.no/.test(noT) && /kontakt@opplevagent\.no/.test(enT), "deletion/objection contact address is on the page in both parts");
  assertTrue(/13\. oktober 2026/.test(noT) && /13 October 2026/.test(enT), "both parts show today's updated date, 13 October 2026");

  // 2. «fjern» hides, does not delete.
  assertTrue(/<strong>skjules<\/strong>/.test(no) && /<strong>hidden<\/strong>/.test(en), "both parts say the profile is hidden after «fjern»");
  assertTrue(/<strong>slettes ikke<\/strong>/.test(no) && /<strong>not deleted<\/strong>/.test(en),
    "both parts say the row is NOT deleted by «fjern»");
  for (const [label, t, delRe] of [["no", noT, /slettes/], ["en", enT, /\bdeleted\b/]] as const) {
    // Every sentence that mentions «fjern» (or the objection reply) must not say it is deleted,
    // except the explicit negation «slettes ikke» / «not deleted».
    const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => /fjern/i.test(s));
    const bad = sentences.filter((s) => delRe.test(s.replace(/slettes ikke|not deleted/g, "")));
    assertTrue(sentences.length > 0 && bad.length === 0,
      `(${label}) no sentence about the «fjern» flow claims deletion${bad.length ? ": " + bad[0] : ""}`);
  }
  assertTrue(!/automatisk sletting av/.test(noT) && !/automatically deleted/.test(enT) &&
    /Ingen automatisk sletting i dag/.test(noT) && /No automatic deletion today/.test(enT),
    "both parts do not promise automatic deletion (and say there is none today)");

  // Hardening: no automatic-deletion promise anywhere; ownership claim pinned; legal-basis table pinned.
  assertTrue(!/slettes automatisk/i.test(html) && !/automatically deleted/i.test(html) && !/slettes etter \d/i.test(html) && !/deleted after \d/i.test(html),
    "the page contains no 'slettes automatisk' / 'automatically deleted' promise");
  assertTrue(!/eierskap[^.]{0,80}(lagres|lagret)/i.test(html) && !/(lagres|lagret)[^.]{0,80}eierskap/i.test(html) &&
    !/(stored|kept)[^.]{0,80}ownership/i.test(html) && !/ownership[^.]{0,80}(stored|kept)/i.test(html),
    "no sentence ties storage of the provider e-mail to ownership (eierskap/ownership near lagres/stored)");
  assertTrue(/sletting gjør vi manuelt; det finnes ingen automatisk eller selvbetjent sletting/.test(noT) &&
    /we do the deletion manually; there is no automatic or self-service deletion/.test(enT), "both parts say deletion on request is manual");
  assertTrue(/som også lagrer e-postadressen du svarte fra og årsaken/.test(noT) && /also stores the email address you replied from and the reason/.test(enT),
    "both parts say the do-not-contact list stores the sender e-mail and the reason");
  for (const [label, part, rows] of [["no", no, ["E-post til tilbydere om profilen", "Tilbyderprofiler fra offentlige kilder", "Sperreliste etter «fjern»"]], ["en", en, ["Emails to providers about the profile", "Provider profiles from public sources", "Do-not-contact list after “fjern”"]]] as const) {
    const basis = label === "no" ? "Berettiget interesse" : "Legitimate interest";
    for (const row of rows) {
      assertTrue(part.includes(`<tr><td>${row}</td><td>${basis}</td></tr>`), `(${label}) legal-basis table: "${row}" is on ${basis}`);
    }
    assertTrue(!/Samtykke/.test(part) && !/<td>Consent<\/td>/.test(part), `(${label}) legal-basis table has no consent row for outreach`);
  }

  // 3. Old ownership-only claim gone.
  assertTrue(
    !/Tilbyder-henvendelser/.test(html) && !/Provider claims/.test(html) &&
      !/til eierskapet er bekreftet eller avvist/.test(html) && !/så lenge det er nødvendig for å bekrefte eierskap/.test(html) &&
      !/until ownership is confirmed or rejected/.test(html) && !/only as long as needed to confirm ownership/.test(html),
    "the old claim that the provider e-mail is kept only until ownership is confirmed/rejected is gone"
  );

  // 4. Retention matches the backup code.
  assertTrue(/beholdes i 7 dager, og én kopi per uke i 4 uker til/.test(noT) && /kept for 7 days, and one copy per week for 4 more weeks/.test(enT) &&
    /Tigris/.test(noT) && /Tigris/.test(enT), "both parts state Tigris 7 days + 4 weeks");
  assertTrue(/de ti nyeste beholdes, uten fast tidsgrense/.test(noT) && /the ten newest are kept, with no fixed time limit/.test(enT),
    "both parts state the manual on-volume copies (ten newest, no time limit)");

  // 5. Vendors: each named vendor exists in code; the central ones are all named; OpenAI is not.
  const vendors: Array<{ name: string; proof: boolean }> = [
    { name: "Fly.io", proof: /primary_region = 'arn'/.test(flyToml) },
    { name: "Tigris", proof: /Tigris/i.test(offsite) && /experiences/.test(offsite) },
    { name: "Resend", proof: /connectors\.resend_domain/.test(emailSvc) && /api\.resend\.com\/emails\/receiving/.test(inbound) },
    { name: "Google", proof: /const forwardTo = process\.env\.ADMIN_EMAIL \|\| "[^"]*@gmail\.com"/.test(inbound) && /to: forwardTo/.test(inbound) },
    { name: "Brave Search", proof: /https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search/.test(searchEnrich) && /braveSearch\(query, braveKey/.test(opplevelser) && /<kommune\/poststed>/.test(opplevelser) },
    { name: "Kartverket", proof: /KARTVERKET_ADRESSE_BASE = "https:\/\/ws\.geonorge\.no\/adresser\/v1\/sok"/.test(geocodeWorker) },
    { name: "Anthropic", proof: /api\.anthropic\.com/.test(contentJudge) && /api\.anthropic\.com/.test(translations) },
  ];
  for (const v of vendors) {
    assertTrue(v.proof, `vendor in code: ${v.name} is really used`);
    assertTrue(no.includes(v.name) && en.includes(v.name), `vendor on page: ${v.name} is named in both parts`);
  }
  assertTrue(/Gmail/.test(noT) && /Gmail/.test(enT), "both parts name Gmail (where e-mail to us is read)");
  const vendorListNo = (no.match(/Leverandører vi bruker:[\s\S]*?<\/li>/) || [""])[0];
  const vendorListEn = (en.match(/Providers we use:[\s\S]*?<\/li>/) || [""])[0];
  assertTrue(vendorListNo.length > 0 && vendorListEn.length > 0, "setup: both parts have the vendor list");
  for (const v of vendors) {
    assertTrue(vendorListNo.includes(`>${v.name}<`) && vendorListEn.includes(`>${v.name}<`),
      `vendor list: ${v.name} is in the "vendors we use" list in both parts`);
  }
  assertTrue(!/OpenAI/.test(html), "OpenAI is not named as a processor (stub only, unused for Opplevagent)");
  const namedNo = (vendorListNo.match(/<span translate="no">([^<]+)<\/span>/g) || []).map((m) => text(m));
  const namedEn = (vendorListEn.match(/<span translate="no">([^<]+)<\/span>/g) || []).map((m) => text(m));
  assertTrue(
    namedNo.every((n) => vendors.some((v) => v.name === n)) && namedEn.every((n) => vendors.some((v) => v.name === n)),
    "every vendor in the vendor list is one that is verified in code"
  );
  assertTrue(JSON.stringify(namedNo) === JSON.stringify(namedEn), "the vendor list is identical in NO and EN");

  // 6. Same structure NO / EN.
  assertTrue(count(no, /<h2>/g) === count(en, /<h2>/g) && count(no, /<h2>/g) >= 9,
    `NO and EN have the same number of h2 (${count(no, /<h2>/g)} vs ${count(en, /<h2>/g)})`);
  assertTrue(count(no, /<li>/g) === count(en, /<li>/g) && count(no, /<li>/g) >= 15,
    `NO and EN have the same number of li (${count(no, /<li>/g)} vs ${count(en, /<li>/g)})`);
  assertTrue(count(no, /<tr>/g) === count(en, /<tr>/g) && count(no, /<tr>/g) >= 10,
    `NO and EN have the same number of tr (${count(no, /<tr>/g)} vs ${count(en, /<tr>/g)})`);

  return { passed, failed, failures };
}

if (require.main === module) {
  runOpplevagentPrivacyTruthTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
