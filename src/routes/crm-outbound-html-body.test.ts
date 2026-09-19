/**
 * crm-outbound-html-body.test.ts — dev-request
 * 2026-09-16-crm-utgaaende-html-body-kollapser-linjeskift.
 *
 * THE BUG, observed in production. Both CRM send paths passed
 * `htmlContent: bodyHtml ?? bodyText` to emailService.sendRaw. With no
 * bodyHtml — every reply the CS routine composes — the raw plain text became
 * the text/html alternative verbatim. In HTML a newline is whitespace, so
 * every paragraph break collapsed and the recipient saw one unbroken block.
 * Daniel reported it from his own copy of the Angr Brenneri reply
 * (thread 1a0a9a04c58fceaf, 2026-09-16).
 *
 *   hb1-hb8    plainTextToEmailHtml itself: paragraphs, hard breaks,
 *              escaping, æøå, CRLF, empty input.
 *   hb9-hb16   THE ROUTES. Both /threads/:id/send and /compose, asserted on
 *              the options that would reach the transport. This suite's own
 *              crm-platform-identity.test.ts names the failure mode: a helper
 *              can be perfect while nothing calls it. hb9-hb16 are the half
 *              that would have caught this bug; the helper did not exist to
 *              be wrong.
 *
 * Every assertion here fails against the pre-fix code — that is the point.
 * `htmlContent === bodyText` (the old behaviour) has no <p> in it at all.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/routes/crm-outbound-html-body.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { plainTextToEmailHtml } from "../utils/plain-text-to-html";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmOutboundHtmlBodyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  const countP = (html: string): number => (html.match(/<p>/g) || []).length;

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ═══════════════════════════════════════════════════════════════
      // hb1-hb8 — the helper.
      // ═══════════════════════════════════════════════════════════════
      {
        const twoParas = plainTextToEmailHtml("Hei Eskil,\n\nTakk for bekreftelsen.");
        assertEq(countP(twoParas), 2,
          "hb1: a blank line between two paragraphs produces TWO <p> blocks — the collapse Daniel saw was exactly these becoming one");
        assertTrue(
          !twoParas.includes("Hei Eskil,\n\nTakk"),
          "hb2: …and the output is no longer the raw text — this is the literal pre-fix behaviour (htmlContent = bodyText), asserted as absent");

        const hardBreak = plainTextToEmailHtml("Mvh,\nDaniel Fredriksen\nOpplevagent");
        assertEq(countP(hardBreak), 1,
          "hb3: single newlines do NOT start new paragraphs — a signature block is one paragraph");
        assertEq((hardBreak.match(/<br>/g) || []).length, 2,
          "hb3b: …they become <br>, so a three-line signature still renders on three lines rather than one");

        const escaped = plainTextToEmailHtml("Bær & Brygg <post@baer.no> sa 5 > 3");
        assertTrue(escaped.includes("&amp;"), "hb4: & is escaped");
        assertTrue(escaped.includes("&lt;post@baer.no&gt;"),
          "hb4b: …and angle brackets too — unescaped, a producer's <address> is parsed as a tag and silently vanishes from the email");
        assertTrue(!/<(?!\/?(p|br)\b)/.test(escaped),
          "hb4c: …leaving no tags in the output except the <p>/<br> this function itself emits");

        const nordic = plainTextToEmailHtml("Vi har åpent på søndag.\n\nHilsen Bjørn i Kvæfjord");
        assertTrue(
          nordic.includes("åpent") && nordic.includes("søndag") && nordic.includes("Bjørn") && nordic.includes("Kvæfjord"),
          "hb5: æ, ø and å pass through VERBATIM — never entity-escaped or ASCII-folded (standing P0 rule for all customer text)");

        assertEq(plainTextToEmailHtml(""), "", "hb6: empty input yields empty output, not '<p></p>'");
        assertEq(plainTextToEmailHtml("   \n\n  \t "), "", "hb6b: …and so does whitespace-only input");

        assertEq(countP(plainTextToEmailHtml("En.\r\n\r\nTo.")), 2,
          "hb7: CRLF line endings are normalised — a body that arrived over the wire must not render as one blob just because of \\r");
        assertEq(countP(plainTextToEmailHtml("En.\n\n\n\nTo.")), 2,
          "hb8: several blank lines still separate exactly two paragraphs, not four with empties between");
      }

      // ═══════════════════════════════════════════════════════════════
      // hb9-hb16 — THE ROUTES.
      // ═══════════════════════════════════════════════════════════════
      const prevAdminKey = process.env.ADMIN_KEY;
      const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
      const key = process.env.ADMIN_KEY || "crm-html-body-test-key";
      process.env.ADMIN_KEY = key;
      process.env.ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || key;

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const svc = emailMod.emailService as any;
      const realSendRaw = svc.sendRaw.bind(svc);
      const sent: any[] = [];
      svc.sendRaw = async (o: any) => { sent.push(o); return { success: true, messageId: "stub-html-body" }; };

      try {
        const crmRoutes = require("./crm") as any;
        const router = crmRoutes.default ?? crmRoutes.router ?? crmRoutes;

        const post = async (url: string, body: any): Promise<{ status: number; body: any }> => {
          const req: any = {
            method: "POST", url, query: {}, body,
            headers: { "x-admin-key": key },
            get(n: string) { return this.headers[n.toLowerCase()]; },
          };
          let settle: () => void;
          const done = new Promise<void>((r) => { settle = r; });
          let jsonBody: any;
          const res: any = {
            statusCode: 200,
            status(c: number) { this.statusCode = c; return this; },
            json(b: any) { jsonBody = b; settle(); return this; },
          };
          router.handle(req, res, () => settle());
          await done;
          return { status: res.statusCode, body: jsonBody };
        };

        const contact = require("../services/crm-service").crmService.resolveContact("hb@example.no", null, "experiences");
        db.prepare(`INSERT INTO crm_threads (id, contact_id, subject, category, severity, vertical_id)
                    VALUES ('hb-thread','${contact.id}','Emne','innkommende','normal','experiences')`).run();

        // ── /threads/:id/send ──────────────────────────────────────
        const multiPara = "Hei Eskil,\n\nTakk for bekreftelsen.\n\nMvh,\nDaniel";

        sent.length = 0;
        const r1 = await post("/threads/hb-thread/send", {
          intent: "resend_send",
          toEmails: ["gjest@example.no"],
          subject: "Emne som betyr noe",
          bodyText: multiPara,
          createdBy: "daniel",
        });
        assertEq(r1.status, 200, `hb9: a normal multi-paragraph reply sends (got ${r1.status}, ${JSON.stringify(r1.body)})`);
        assertEq(sent.length, 1, "hb9b: …and reaches the transport exactly once");
        assertEq(countP(String(sent[0]?.htmlContent ?? "")), 3,
          "hb10: THE FIX — the html part carries one <p> per authored paragraph. Pre-fix this was the raw text with zero <p>, which is why Gmail showed one wall of text");
        assertTrue(
          sent[0]?.htmlContent !== sent[0]?.textContent,
          "hb11: …and html is no longer byte-identical to text, which is precisely what `bodyHtml ?? bodyText` used to guarantee");
        assertEq(sent[0]?.textContent, multiPara,
          "hb12: the text/plain alternative is still the author's exact bytes — it was always correct and must not be 'fixed' too");

        sent.length = 0;
        const explicitHtml = "<p>Egen HTML</p>";
        const r2 = await post("/threads/hb-thread/send", {
          intent: "resend_send",
          toEmails: ["gjest@example.no"],
          subject: "Emne med egen html",
          bodyText: multiPara,
          bodyHtml: explicitHtml,
          createdBy: "daniel",
        });
        assertEq(r2.status, 200, `hb13: a caller-supplied bodyHtml still sends (got ${r2.status})`);
        assertEq(sent[0]?.htmlContent, explicitHtml,
          "hb13b: …and is passed through UNTOUCHED — the conversion is a fallback for the no-html case, not a rewrite of every body");

        // ── /compose ───────────────────────────────────────────────
        sent.length = 0;
        const r3 = await post("/compose", {
          to: "gjest2@example.no",
          subject: "Komponert emne",
          bodyText: multiPara,
          intent: "resend_send",
          category: "innkommende",
          createdBy: "daniel",
          vertical: "rfb",
          force: true,
        });
        assertEq(r3.status, 200, `hb14: the compose path sends too (got ${r3.status}, ${JSON.stringify(r3.body)})`);
        assertEq(sent.length, 1, "hb14b: …reaching the transport once");
        assertEq(countP(String(sent[0]?.htmlContent ?? "")), 3,
          "hb15: THE FIX ON THE SECOND PATH — /compose carries every RFB autonomous reply (B1/B2/B3/B4/C); fixing only /threads/:id/send would have left the busiest lane broken");
        assertEq(sent[0]?.textContent, multiPara,
          "hb16: …with its text/plain alternative likewise untouched");
      } finally {
        svc.sendRaw = realSendRaw;
        if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
        if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
        else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      }
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmOutboundHtmlBodyTests({ log: true }).then((s) => process.exit(s.failed > 0 ? 1 : 0));
}
