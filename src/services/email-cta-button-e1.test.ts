/**
 * email-cta-button-e1.test.ts — slice E1 of dev-request
 * 2026-10-31-rfb-utgaende-eposter-design-og-lesbarhet.
 *
 * The button in five owner mails got its colours only from a `.cta-button`
 * rule in <style>. Gmail overrides link colour, so «Logg inn nå» showed
 * Gmail-blue text on the dark green (~1.15:1). Each of the five is now a
 * bulletproof button. For every template, rendered through its real send*
 * method with sendEmail stubbed (nothing is sent):
 *
 *   a  exactly one button: a table cell with `bgcolor` = the template's green
 *      and an inline `background` of the same green;
 *   b  the <a> carries inline background, color:#ffffff, text-decoration:none,
 *      display:inline-block, padding and border-radius; the label sits in a
 *      <span style="color:#ffffff">;
 *   c  href and visible text are exactly what the old <a> rendered;
 *   d  no `cta-button` class or rule is left, no <table> inside a <p>, and
 *      the plain-text part still carries the raw link and no markup;
 *   e  white on the button green is ≥ 4.5:1 (WCAG AA), computed here — and
 *      Gmail's link blue on the old green really was the ~1.15:1 reported.
 *
 * Exported runEmailCtaButtonE1Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone:
 *   npx tsx src/services/email-cta-button-e1.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h!, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return m ? m[1]! : null;
}

function styleOf(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (attr(attrs, "style") || "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

export async function runEmailCtaButtonE1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void { assertEq(!!cond, true, label); }

  const vc = require("../config/vertical-config") as typeof import("../config/vertical-config");
  try { vc.getConfig("rfb"); } catch { vc.loadConfigsAtBoot(); }
  const { EmailService } = require("./email-service") as typeof import("./email-service");

  const prevAppUrl = process.env.APP_URL;
  const prevWarn = console.warn;
  try {
    process.env.APP_URL = "https://rettfrabonden.com";
    console.warn = () => {}; // «SMTP not configured» from the constructor
    const svc = new EmailService();
    console.warn = prevWarn;
    let captured: any = null;
    (svc as any).sendEmail = async (o: any) => { captured = o; return { success: true, messageId: "e1-stub" }; };
    const render = async (send: () => Promise<unknown>): Promise<{ to: string; html: string; text: string }> => {
      captured = null;
      await send();
      if (!captured) throw new Error("sendEmail was not called");
      return { to: captured.to, html: captured.htmlContent, text: captured.textContent };
    };

    const TO = "eier@example.com";
    const cases: Array<{
      id: string;
      send: () => Promise<unknown>;
      href: string;
      rawUrl: string;
      label: string;
      green: string;
    }> = [
      {
        id: "claim-invitation",
        send: () => svc.sendClaimInvitation("agent-e1", TO, "Ola", "Test Gård", "https://rettfrabonden.com/produsent/test-gard"),
        href: "https://rettfrabonden.com/agent/agent-e1/claim",
        rawUrl: "https://rettfrabonden.com/agent/agent-e1/claim",
        label: "Krav din agent på Rett fra Bonden",
        green: "#2d5f2e",
      },
      {
        id: "claim-confirmation",
        // K5: the button is the one-time owner-portal login, new label.
        send: () => svc.sendClaimConfirmation(TO, "Test Gård", "https://rettfrabonden.com/magic-link-verify?token=ABC&x=1", "agent-e1"),
        href: "https://rettfrabonden.com/magic-link-verify?token=ABC&amp;x=1",
        rawUrl: "https://rettfrabonden.com/magic-link-verify?token=ABC&x=1",
        label: "Logg inn i eierportalen",
        green: "#2d5f2e",
      },
      {
        id: "magic-link",
        send: () => svc.sendMagicLink(TO, "https://rettfrabonden.com/selger?magic=abc&x=1", "Test Gård"),
        href: "https://rettfrabonden.com/selger?magic=abc&amp;x=1",
        rawUrl: "https://rettfrabonden.com/selger?magic=abc&x=1",
        label: "Logg inn nå",
        green: "#2d5f2e",
      },
      {
        id: "owner-magic-link",
        send: () => svc.sendOwnerMagicLink({ to: TO, agentName: "Test Gård", verifyUrl: "https://rettfrabonden.com/magic-link-verify?token=ABC&x=1" }),
        href: "https://rettfrabonden.com/magic-link-verify?token=ABC&amp;x=1",
        rawUrl: "https://rettfrabonden.com/magic-link-verify?token=ABC&x=1",
        label: "Logg inn på eierportalen",
        green: "#2D5016",
      },
      {
        id: "gardssalg-claim-magic-link",
        send: () => svc.sendGardssalgClaimMagicLink({ to: TO, providerName: "Bryggeri Test", verifyUrl: "https://opplevagent.no/magic-link-verify?token=ABC&x=1" }),
        href: "https://opplevagent.no/magic-link-verify?token=ABC&amp;x=1",
        rawUrl: "https://opplevagent.no/magic-link-verify?token=ABC&x=1",
        label: "Logg inn på eierportalen",
        green: "#0f5a50",
      },
    ];

    for (const c of cases) {
      const mail = await render(c.send);
      const green = c.green.toLowerCase();
      assertEq(mail.to, TO, `${c.id} a-00: still sent to the same recipient`);

      // ── a: one cell button with bgcolor + inline background ─────────────
      const buttons = Array.from(mail.html.matchAll(/<td\b([^>]*)>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/td>/g));
      assertEq(buttons.length, 1, `${c.id} a-01: exactly one button cell`);
      const [, tdAttrs = "", aAttrs = "", inner = ""] = buttons[0] || [];
      assertEq((attr(tdAttrs, "bgcolor") || "").toLowerCase(), green, `${c.id} a-02: cell bgcolor is the template green`);
      assertEq((styleOf(tdAttrs).background || "").toLowerCase(), green, `${c.id} a-03: cell inline background is the template green`);

      // ── b: inline colours on the <a> and a white <span> ─────────────────
      const aStyle = styleOf(aAttrs);
      assertEq((aStyle.color || "").toLowerCase(), "#ffffff", `${c.id} b-01: <a> has inline color:#ffffff`);
      assertEq((aStyle.background || "").toLowerCase(), green, `${c.id} b-02: <a> has inline background in the template green`);
      assertEq(aStyle["text-decoration"], "none", `${c.id} b-03: <a> text-decoration:none`);
      assertEq(aStyle.display, "inline-block", `${c.id} b-04: <a> display:inline-block`);
      assertTrue(!!aStyle.padding && !!aStyle["border-radius"], `${c.id} b-05: <a> has padding and border-radius`);
      const span = /^<span\b([^>]*)>([\s\S]*)<\/span>$/.exec(inner.trim());
      assertTrue(!!span, `${c.id} b-06: the label is wrapped in a <span>`);
      assertEq((styleOf(span?.[1] || "").color || "").toLowerCase(), "#ffffff", `${c.id} b-07: the <span> is white`);

      // ── c: href and visible text unchanged ──────────────────────────────
      assertEq(attr(aAttrs, "href"), c.href, `${c.id} c-01: href is exactly the old one`);
      assertEq((span?.[2] || "").replace(/<[^>]*>/g, "").trim(), c.label, `${c.id} c-02: visible text is exactly the old one`);

      // ── d: nothing class-only left; valid nesting; text part untouched ──
      assertTrue(!mail.html.includes("cta-button"), `${c.id} d-01: no cta-button class or <style> rule left`);
      assertTrue(!/<p\b[^>]*>\s*<table/i.test(mail.html), `${c.id} d-02: no <table> inside a <p>`);
      assertTrue(mail.text.includes(c.rawUrl) && !/<[a-z]/i.test(mail.text), `${c.id} d-03: plain text has the raw link and no markup`);

      // ── e: contrast ─────────────────────────────────────────────────────
      const ratio = contrastRatio("#ffffff", green);
      assertTrue(ratio >= 4.5, `${c.id} e-01: white on ${c.green} is ${ratio.toFixed(2)}:1 (≥ 4.5:1)`);
    }

    // The arithmetic itself, and the bug it fixes.
    assertEq(contrastRatio("#ffffff", "#000000").toFixed(2), "21.00", "e-02: white on black is 21:1");
    assertEq(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00", "e-03: white on white is 1:1");
    const gmailBlue = contrastRatio("#1155cc", "#2d5f2e");
    assertTrue(gmailBlue < 1.5, `e-04: Gmail link blue #1155cc on #2d5f2e was ${gmailBlue.toFixed(2)}:1 (the reported bug)`);
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.warn = prevWarn;
    if (prevAppUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = prevAppUrl;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runEmailCtaButtonE1Tests({ log: true }).then((r) => {
    console.info(`email-cta-button-e1: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
