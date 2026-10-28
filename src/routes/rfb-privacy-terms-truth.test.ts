/**
 * rfb-privacy-terms-truth.test.ts — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C2.
 *
 * Proves /personvern (src/routes/seo.ts) and /vilkar (src/routes/discovery.ts)
 * match what the code actually does, and that the old dead/stale duplicate
 * privacy page (discovery.ts's /privacy, /privacy-policy) no longer serves
 * diverging content:
 *
 *   1. /privacy and /privacy-policy now 301-redirect to /personvern instead
 *      of serving their own stale, diverging copy.
 *   2. /personvern (both NO and EN) no longer claims IP/UA hashing is
 *      "irreversible anonymisation" — it correctly says "salted hash /
 *      pseudonymisation", cross-checked against analytics-service.ts
 *      actually salting hashIP() with IP_HASH_SALT.
 *   3. /personvern discloses MCP/A2A tool-call logging storing a RAW
 *      User-Agent, cross-checked against analytics_mcp_calls' actual
 *      schema (database/init.ts) having a `user_agent` column (not just a
 *      hash) and mcp-usage-logger.ts actually writing the raw string.
 *   4. /personvern discloses that ChatGPT/Claude usage routes through
 *      OpenAI/Anthropic's own infrastructure, and that lokal_geocode calls
 *      Kartverket.
 *   5. /personvern discloses cart/order/buyer-token data and retention,
 *      cross-checked against createCart()'s real 7-day expiry and
 *      sweepExpiredCartContactData()'s real 30-day default cutoff.
 *   6. /vilkar no longer claims RFB "does not process transactions" — it
 *      accurately says RFB does not process PAYMENTS (the platform does
 *      create real orders and send order emails).
 *   7. Both pages' "Sist oppdatert"/"Last updated" date reflects this
 *      change (no longer the stale April 2026 dates).
 *   8. (Daniel live 2026-10-11 «fiks personvernsiden») /personvern no longer
 *      claims producer profiles rest on consent: profiles built from public
 *      sources are on legitimate interest, with the sources, the recipients
 *      (AI assistants), Anthropic checks/translation, Tigris backups and
 *      their real 7-day + 4-week retention, the «fjern» removal reply, the
 *      do-not-re-add list and the right to object all disclosed, each
 *      cross-checked against the code that does it.
 *
 * Standalone: npx tsx src/routes/rfb-privacy-terms-truth.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface InvokeResult {
  found: boolean;
  status: number;
  body: string;
  redirectedTo?: string;
}

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): InvokeResult {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "" };

  let status = 200;
  let body = "";
  let redirectedTo: string | undefined;
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      if (typeof codeOrUrl === "number") { status = codeOrUrl; redirectedTo = maybeUrl; }
      else { status = 302; redirectedTo = codeOrUrl; }
      return this;
    },
  };
  const req: any = { lang, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, status, body, redirectedTo };
}

export async function runRfbPrivacyTermsTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere, or dir missing in CI */ }
  } catch { /* config module not resolvable standalone; routes fall back to defaults */ }

  const seoRouter = require("./seo").default as any;
  const discoveryRouter = require("./discovery").default as any;

  // ── Ground truth pulled from the actual code, so this test fails if the
  // code and the privacy page's claims about it ever drift apart again. ────
  const dbInitSrc = fs.readFileSync(path.join(__dirname, "..", "database", "init.ts"), "utf8");
  const analyticsServiceSrc = fs.readFileSync(path.join(__dirname, "..", "services", "analytics-service.ts"), "utf8");
  const cartServiceSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cart-service.ts"), "utf8");
  const cartSweepSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cart-contact-sweep.ts"), "utf8");

  assertTrue(
    /CREATE TABLE IF NOT EXISTS analytics_mcp_calls[\s\S]{0,600}user_agent\s+TEXT/.test(dbInitSrc),
    "ground truth: analytics_mcp_calls really does have a user_agent column (raw, per its own schema comment)"
  );
  assertTrue(
    /const IP_HASH_SALT = process\.env\.IP_HASH_SALT/.test(analyticsServiceSrc) &&
      /createHash\("sha256"\)\.update\(IP_HASH_SALT\)\.update\(ip\)/.test(analyticsServiceSrc),
    "ground truth: hashIP() really is salted with IP_HASH_SALT (C2's own code fix)"
  );
  assertTrue(
    /expires_at = new Date\(Date\.now\(\) \+ 7 \* 24 \* 60 \* 60 \* 1000\)/.test(cartServiceSrc),
    "ground truth: createCart() really does set a 7-day expiry"
  );
  assertTrue(
    /cutoffDays: number = 30/.test(cartSweepSrc),
    "ground truth: sweepExpiredCartContactData() really does default to a 30-day cutoff"
  );
  const offsiteBackupSrc = fs.readFileSync(path.join(__dirname, "..", "services", "offsite-backup.ts"), "utf8");
  const outreachTemplateSrc = fs.readFileSync(path.join(__dirname, "..", "services", "rfb-outreach-template.ts"), "utf8");
  const blocklistSrc = fs.readFileSync(path.join(__dirname, "..", "services", "blocklist-service.ts"), "utf8");
  const secondLineJudgeSrc = fs.readFileSync(path.join(__dirname, "..", "services", "second-line-profile-judge.ts"), "utf8");
  assertTrue(
    /export function selectBackupsToDelete\(objects: S3Object\[\], keepDays = 7, keepWeeks = 4\)/.test(offsiteBackupSrc),
    "ground truth: offsite backups keep 7 daily + 4 weekly copies (selectBackupsToDelete defaults)"
  );
  assertTrue(
    /svarer dere bare «fjern», så tar jeg siden ned innen et døgn/.test(outreachTemplateSrc) && /https:\/\/rettfrabonden\.com\/personvern/.test(outreachTemplateSrc),
    "ground truth: the outreach e-mail links /personvern and tells producers to reply «fjern» to have the profile taken down within a day"
  );
  assertTrue(
    /CREATE TABLE IF NOT EXISTS agent_blocklist/.test(dbInitSrc) &&
      /"website_domain" \| "email" \| "email_domain" \| "name_normalized" \| "agent_id" \| "org_nr"/.test(blocklistSrc),
    "ground truth: removed producers go on agent_blocklist by website domain, e-mail, name and org.nr"
  );
  assertTrue(
    /https:\/\/api\.anthropic\.com\/v1\/messages/.test(secondLineJudgeSrc),
    "ground truth: profile checks really call Anthropic's API (second-line-profile-judge.ts)"
  );
  // Review of lokal#1039: the page must not promise more deletion than the code does.
  const dbBackupRouteSrc = fs.readFileSync(path.join(__dirname, "admin-db-backup.ts"), "utf8");
  const deactivateSrc = fs.readFileSync(path.join(__dirname, "admin-agents-deactivate.ts"), "utf8");
  const inboundEmailSrc = fs.readFileSync(path.join(__dirname, "..", "services", "inbound-email-webhook.ts"), "utf8");
  assertTrue(
    /for \(const k of selectBackupsToDelete\(objs\)\)/.test(offsiteBackupSrc),
    "ground truth: the nightly Tigris job prunes with selectBackupsToDelete's defaults (7 days + 4 weeks)"
  );
  assertTrue(
    /pruneBackups\(dir, 10, config\.filenameRe\)/.test(dbBackupRouteSrc),
    "ground truth: manual on-volume backups keep the 10 newest"
  );
  assertTrue(
    /DEFAULT_BACKUP_MAX_AGE_DAYS = 30;/.test(dbBackupRouteSrc) && /createBackupAgeSweepTick/.test(dbBackupRouteSrc) &&
      /createBackupAgeSweepTick/.test(fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8")),
    "ground truth: manual on-volume backups are deleted after at most 30 days (default age limit, nightly sweep wired in index.ts)"
  );
  assertTrue(
    /SET is_active = 0/.test(deactivateSrc) && !/DELETE FROM agents/.test(deactivateSrc),
    "ground truth: closed or wrongly registered businesses are deactivated (is_active = 0), never deleted"
  );
  const translationsSrc = fs.readFileSync(path.join(__dirname, "..", "services", "profile-translations.ts"), "utf8");
  const marketplaceSrc = fs.readFileSync(path.join(__dirname, "marketplace.ts"), "utf8");
  assertTrue(
    /DELETE FROM profile_translations/.test(translationsSrc) && /deleteAgentProfileTranslations\(db, agentId\)/.test(marketplaceSrc),
    "ground truth: permanently deleting a profile also deletes its profile_translations + audit rows (slettefrist slice B)"
  );
  assertTrue(
    /CREATE TABLE IF NOT EXISTS crm_contacts[\s\S]{0,300}agent_id TEXT REFERENCES agents\(id\) ON DELETE SET NULL/.test(dbInitSrc) &&
      /CREATE TABLE IF NOT EXISTS rfb_marketing_send_ledger/.test(dbInitSrc),
    "ground truth: CRM contacts survive profile deletion (ON DELETE SET NULL) and the send log exists"
  );
  assertTrue(
    /api\.resend\.com\/emails\/receiving/.test(inboundEmailSrc) && /process\.env\.ADMIN_EMAIL/.test(inboundEmailSrc),
    "ground truth: inbound email is received via Resend and forwarded to the admin mailbox"
  );

  // ── 1. /privacy, /privacy-policy: redirect, no more duplicate content ──
  for (const p of ["/privacy", "/privacy-policy"]) {
    const r = invokeGet(discoveryRouter, p);
    assertTrue(r.found, `setup: GET ${p} is registered on discovery.ts`);
    if (!r.found) continue;
    assertEq(r.status, 301, `${p}: 301 redirect (no longer serves its own stale privacy text)`);
    assertEq(r.redirectedTo, "/personvern", `${p}: redirects to /personvern (single source of truth)`);
  }

  // ── 2-5. /personvern content, both languages ────────────────────────────
  for (const lang of ["no", "en"] as const) {
    const r = invokeGet(seoRouter, "/personvern", lang);
    assertTrue(r.found, `setup: GET /personvern (${lang}) is registered`);
    if (!r.found) continue;
    assertEq(r.status, 200, `/personvern (${lang}): renders 200`);
    const body = r.body;

    // No more "irreversible anonymisation" overclaim.
    assertTrue(
      !/ikke-reversibel anonymisering/i.test(body) && !/irreversible anonymisation/i.test(body),
      `/personvern (${lang}): no longer claims IP/UA hashing is "irreversible anonymisation"`
    );
    // Correctly reframed as salted hash / pseudonymisation.
    assertTrue(
      lang === "no"
        ? /saltet SHA-256-hash/.test(body) && /pseudonymisering/.test(body)
        : /salted SHA-256 hash/.test(body) && /pseudonymisation/.test(body),
      `/personvern (${lang}): IP hashing correctly described as a salted hash / pseudonymisation`
    );

    // MCP/A2A tool-call logging disclosed, including the raw User-Agent.
    assertTrue(
      lang === "no"
        ? /MCP\/A2A-verktøykall/.test(body) && /User-Agent/.test(body) && /klartekst/.test(body)
        : /MCP\/A2A tool calls/.test(body) && /User-Agent/.test(body) && /as-is/.test(body),
      `/personvern (${lang}): discloses MCP/A2A tool-call logging stores the raw User-Agent`
    );

    // ChatGPT/Claude route through OpenAI/Anthropic infrastructure.
    assertTrue(
      /OpenAI/.test(body) && /Anthropic/.test(body) && (/ChatGPT/.test(body) && /Claude/.test(body)),
      `/personvern (${lang}): discloses that ChatGPT/Claude usage routes through OpenAI/Anthropic`
    );

    // Kartverket geocoding disclosed.
    assertTrue(
      /Kartverket/.test(body) && /lokal_geocode/.test(body),
      `/personvern (${lang}): discloses that lokal_geocode calls Kartverket`
    );

    // Cart/order/buyer-token data + retention disclosed, matching the real
    // 7-day cart expiry and 30-day contact-data retention.
    assertTrue(
      lang === "no"
        ? /buyer_ref/.test(body) && /7 dager/.test(body) && /30 dager/.test(body)
        : /buyer_ref/.test(body) && /7 days/.test(body) && /30 days/.test(body),
      `/personvern (${lang}): discloses cart/order/buyer-token data with the real 7-day/30-day windows`
    );
    assertTrue(
      lang === "no" ? /vi belaster aldri kort/.test(body) : /we never charge a card/.test(body),
      `/personvern (${lang}): correctly states no payment is charged for orders`
    );

    // "Last updated" no longer the stale date.
    assertTrue(
      !/16\. april 2026/.test(body) && !/16 April 2026/.test(body),
      `/personvern (${lang}): no longer shows the stale 16 April 2026 "last updated" date`
    );
    assertTrue(
      // 2026-10-09: controller changed to AGENTPLATFORM.NO AS (dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as).
      // 2026-10-11: legal basis, sources, recipients, AI, backups and the right to object (Daniel live «fiks personvernsiden»).
      lang === "no" ? /Sist oppdatert: 11\. oktober 2026/.test(body) : /Last updated: 11 October 2026/.test(body),
      `/personvern (${lang}): "last updated" date reflects this change`
    );

    // ── 8. Producer profiles: real legal basis, sources, recipients, AI, backups, objection ──
    assertTrue(
      !/Selgerprofil \(offentlig info\)/.test(body) && !/Seller profile \(public info\)/.test(body),
      `/personvern (${lang}): no longer claims producer profiles rest on consent ("Selgerprofil (offentlig info)" row gone)`
    );
    assertTrue(
      lang === "no"
        ? /<td>Produsentprofiler fra offentlige kilder<\/td><td>Berettiget interesse<\/td>/.test(body)
        : /<td>Producer profiles from public sources<\/td><td>Legitimate interest<\/td>/.test(body),
      `/personvern (${lang}): profiles built from public sources are on legitimate interest`
    );
    assertTrue(
      (lang === "no" ? /Brønnøysundregistrene/.test(body) : /Brønnøysund Register Centre/.test(body)) &&
        /Debio/.test(body) && /Google Places/.test(body),
      `/personvern (${lang}): names the public sources profiles are built from (same as /proveniens)`
    );
    assertTrue(
      lang === "no"
        ? /Hvem som får opplysningene/.test(body) && /KI-assistenter/.test(body)
        : /Who receives the data/.test(body) && /AI assistants/.test(body),
      `/personvern (${lang}): discloses recipients, including AI assistants fetching public profiles`
    );
    assertTrue(
      lang === "no" ? /<h3>KI hos Anthropic<\/h3>/.test(body) : /<h3>AI at Anthropic<\/h3>/.test(body),
      `/personvern (${lang}): discloses profile checks and translation at Anthropic`
    );
    assertTrue(
      /Tigris/.test(body) &&
        (lang === "no" ? /beholdes i 7 dager, og én kopi per uke i 4 uker til/.test(body) : /kept for 7 days, and one copy per week for 4 more weeks/.test(body)),
      `/personvern (${lang}): discloses Tigris backups with the real 7-day + 4-week retention`
    );
    assertTrue(
      lang === "no" ? /«fjern»/.test(body) && /sperreliste/.test(body) : /\u201cfjern\u201d/.test(body) && /do-not-re-add list/.test(body),
      `/personvern (${lang}): discloses the «fjern» removal reply and the do-not-re-add list`
    );
    assertTrue(
      lang === "no" ? /<strong>Protestere<\/strong>/.test(body) : /<strong>Object<\/strong>/.test(body),
      `/personvern (${lang}): states the right to object`
    );
    // Review of lokal#1039: deletion and retention claims match the code.
    assertTrue(
      !/inntil ca\. 5 uker/.test(body) && !/up to about 5 weeks/.test(body) &&
        (lang === "no" ? /de ti nyeste beholdes, og ingen kopi lever lenger enn 30 dager/.test(body) : /the ten newest are kept, and never longer than 30 days/.test(body)),
      `/personvern (${lang}): backups disclose the manual on-volume copies with the 30-day limit`
    );
    assertTrue(
      !/profilen og tilknyttet data/.test(body) && !/your profile and associated data removed/.test(body) &&
        (lang === "no" ? /<td>E-postkorrespondanse og utsendingslogg<\/td><td>Ingen automatisk sletting i dag/.test(body)
          : /<td>Email correspondence and send log<\/td><td>No automatic deletion today/.test(body)),
      `/personvern (${lang}): says e-mail correspondence and the send log are not deleted with the profile`
    );
    assertTrue(
      lang === "no" ? /skjules, men blir liggende i databasen/.test(body) : /are hidden, but stay in the database/.test(body),
      `/personvern (${lang}): closed or wrongly registered businesses are hidden, not deleted`
    );
    assertTrue(
      /Resend/.test(body) && /Gmail/.test(body),
      `/personvern (${lang}): names Resend and Gmail for sending and receiving e-mail`
    );
    assertTrue(
      lang === "no"
        ? /Oversatte utgaver av profilteksten \(engelsk og svensk\) avpubliseres, men blir liggende/.test(body)
        : /Translated versions of the profile text \(English and Swedish\) are unpublished but stay in the database/.test(body),
      `/personvern (${lang}): says translated profile text stays after the profile is deleted`
    );
    assertTrue(
      lang === "no"
        ? /<td>Hentebestillinger<\/td><td>Avtale<\/td>/.test(body)
        : /<td>Pickup orders<\/td><td>Contract<\/td>/.test(body),
      `/personvern (${lang}): pickup orders listed on contract (both languages)`
    );
    // ChatGPT app re-review 2026-10-03: lokal_cart_submit takes optional
    // buyer contact fields that reach a producer only with contact_consent.
    assertTrue(
      lang === "no"
        ? /sendes videre til en produsent bare hvis du samtykker/.test(body)
        : /passed to a producer only if you agree to share them/.test(body),
      `/personvern (${lang}): says buyer contact details reach a producer only with consent`
    );
    // ChatGPT app re-review 2026-10-03: the page said page visits had "no
    // automatic expiry" while the MCP log "followed the same 60-day window"
    // as them — contradictory, and both wrong against index.ts's daily
    // auto-prune (RFB_AUTO_PRUNE_DAYS, default 60), which rolls up and
    // deletes raw page views, searches and MCP calls.
    assertTrue(
      !/Ingen automatisk utløp/.test(body) && !/No automatic expiry/.test(body),
      `/personvern (${lang}): no longer claims page visits have no automatic expiry`
    );
    assertTrue(
      lang === "no"
        ? /Enkeltbesøk \(med pseudonymisert IP-hash\) slettes automatisk etter 60 dager/.test(body)
        : /Individual page visits \(with the pseudonymised IP hash\) are deleted automatically after 60 days/.test(body),
      `/personvern (${lang}): states the 60-day automatic deletion of raw page visits`
    );
  }

  // ── 6. /vilkar: no more "does not process transactions" overclaim ──────
  {
    const r = invokeGet(discoveryRouter, "/vilkar");
    assertTrue(r.found, "setup: GET /vilkar is registered");
    if (r.found) {
      assertEq(r.status, 200, "/vilkar: renders 200");
      assertTrue(
        !/gjennomfører ikke transaksjoner/.test(r.body) && !/does not process transactions/.test(r.body),
        "/vilkar: no longer claims the platform does not process transactions (it does create orders)"
      );
      assertTrue(
        /betalingsformidler/.test(r.body) && /payment processor/.test(r.body),
        "/vilkar: correctly narrows the claim to \"not a payment processor\" (both languages present, same page)"
      );
      assertTrue(
        !/20\. april 2026/.test(r.body) && !/20 April 2026/.test(r.body),
        "/vilkar: no longer shows the stale 20 April 2026 \"last updated\" date"
      );
      assertTrue(
        // 2026-10-09: operator changed to AGENTPLATFORM.NO AS (dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as).
        /Sist oppdatert:<\/strong> 9\. oktober 2026/.test(r.body) && /Last updated:<\/strong> 9 October 2026/.test(r.body),
        "/vilkar: \"last updated\" date reflects this change (both languages)"
      );
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbPrivacyTermsTruthTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
