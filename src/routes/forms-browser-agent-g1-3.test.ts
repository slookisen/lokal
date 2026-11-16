/**
 * forms-browser-agent-g1-3.test.ts — slice G1-3 (browser-agent form check).
 *
 * The two public forms a browser-driving agent fills in for a buyer/guest:
 *   - Rett fra Bonden: the order form on /handleliste (handleliste-page.ts,
 *     rendered by the seo router; HANDLELISTE_ENABLED on)
 *   - Opplevagent: the gårdssalg visit request on /kategori/gardssalg/book/:slug
 *     (experiences-seo.ts, booking live)
 *
 *   AK1 — both pages answer 200, and every input/select/textarea in the form
 *         that is not type=hidden/submit has exactly ONE associated label
 *         (label[for=id] or a wrapping <label>).
 *   AK2 — the visible text of each form (tags + attributes stripped,
 *         whitespace collapsed) is byte-identical to origin/main before the
 *         slice: the snapshot strings below were captured from main.
 *   AK3 — the autocomplete / inputmode / aria-describedby attributes the
 *         slice added are present.
 *
 * Harness: the same synthetic router.handle() recipe as
 * handleliste-page.test.ts and
 * experiences-seo-gardssalg-booking-ikke-aktivert.test.ts (in-memory DBs).
 * Standalone: npx tsx src/routes/forms-browser-agent-g1-3.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    const [path, qs = ""] = url.split("?");
    const out: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path,
      query: Object.fromEntries(new URLSearchParams(qs)),
      params: {},
      headers: {},
      body: {},
      lang,
      langOriginalPath: path,
      ip: "198.51.100.31",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      getHeader(n: string) { return out[n.toLowerCase()]; },
      header(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      type() { return this; },
      removeHeader() {},
      append() {},
      status(code: number) { this.statusCode = code; return this; },
      send(body: unknown) { resolve({ handled: true, status: this.statusCode, body: String(body) }); return this; },
      end() { resolve({ handled: true, status: this.statusCode, body: "" }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: err ? 500 : 404, body: err ? String(err) : "" });
    });
  });
}

/** The `<form …>…</form>` slice that starts at the first match of `openTag`. */
export function extractForm(html: string, openTag: string): string {
  const start = html.indexOf(openTag);
  if (start < 0) return "";
  const end = html.indexOf("</form>", start);
  return end < 0 ? "" : html.slice(start, end + "</form>".length);
}

/** Visible text: tags (with their attributes) removed, whitespace collapsed. */
export function visibleText(formHtml: string): string {
  return formHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

interface Control { tag: string; attrs: string; id: string | null; type: string | null }

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1]! : null;
}

function controls(formHtml: string): Control[] {
  const out: Control[] = [];
  for (const m of formHtml.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    out.push({ tag: m[1]!, attrs, id: attr(attrs, "id"), type: attr(attrs, "type") });
  }
  return out;
}

/** Number of labels tied to the control at `index`: label[for=id] + wrapping <label>. */
function labelCount(formHtml: string, c: Control, index: number): number {
  let n = 0;
  if (c.id) n += Array.from(formHtml.matchAll(/<label\b([^>]*)>/g)).filter((m) => attr(m[1]!, "for") === c.id).length;
  // wrapping: the nearest <label …> opening before the control has no </label> between it and the control
  const occurrences = Array.from(formHtml.matchAll(/<(input|select|textarea)\b[^>]*>/g));
  const pos = occurrences[index]!.index!;
  const before = formHtml.slice(0, pos);
  const lastOpen = before.lastIndexOf("<label");
  const lastClose = before.lastIndexOf("</label>");
  if (lastOpen > lastClose) {
    const openAttrs = (before.slice(lastOpen).match(/^<label\b([^>]*)>/) || [])[1] ?? "";
    // a wrapping label that ALSO points elsewhere via for= does not label this control
    const f = attr(openAttrs, "for");
    if (!f) n += 1; // for=self is already counted above; for=other labels a different control
  }
  return n;
}

// ── AK2 snapshots, captured from origin/main (af480d3) before the slice ──
export const HANDLELISTE_FORM_VISIBLE_TEXT_NO = "1. Varer og sted Legg til vare Sted Finn produsenter 2. Velg produsent per vare Tilbake Videre til oppsummering 3. Oppsummering og kontakt Kontaktinfo Navn E-post Telefon Leveringsønske (valgfritt) Jeg samtykker til at navn, e-post og telefon deles med produsentene jeg bestiller direkte hos, slik at de kan svare meg. Opplysningene slettes automatisk 30 dager etter at bestillingen er avsluttet. Website Ingen betaling skjer via Rett fra Bonden. Du avtaler henting og betaling direkte med produsenten. Når du sender handlelisten, gjelder kjøpsvilkårene , inkludert reglene for avbestilling og refusjon. Tilbake Send handlelisten 4. Resultat Ny handleliste";
export const GARDSSALG_BOOK_FORM_VISIBLE_TEXT = "Dato og tid (norsk tid) Antall personer Navn E-post Telefon (valgfritt) Kommentar til produsenten (valgfritt) Reserver besøk";

export async function runFormsBrowserAgentG13Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  function checkLabels(formHtml: string, prefix: string): void {
    const cs = controls(formHtml);
    assertTrue(cs.length > 0, `${prefix}: form has controls`);
    cs.forEach((c, i) => {
      if (c.type === "hidden" || c.type === "submit") return;
      const n = labelCount(formHtml, c, i);
      assertEq(n, 1, `${prefix}: <${c.tag} id=${c.id ?? "-"}> has exactly one associated label`);
    });
  }

  // ═══════════ Rett fra Bonden: /handleliste ═══════════
  {
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevFlag = process.env.HANDLELISTE_ENABLED;
    const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
    const db = new Database(":memory:");
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.HANDLELISTE_ENABLED = "true";
      const seoRouter = require("./seo").default as any;
      const r = await callHtmlRoute(seoRouter, "/handleliste");
      assertEq(r.status, 200, "AK1 rfb: GET /handleliste -> 200");
      const form = extractForm(r.body, '<form id="hl-form"');
      assertTrue(form.length > 0, "AK1 rfb: page carries the order form #hl-form");
      checkLabels(form, "AK1 rfb");
      assertEq(visibleText(form), HANDLELISTE_FORM_VISIBLE_TEXT_NO, "AK2 rfb: visible form text byte-identical to main");
      // AK3 — attributes added in G1-3
      assertTrue(/<input type="text" id="hl-place"[^>]*\sautocomplete="address-level2"/.test(form), "AK3 rfb: #hl-place autocomplete=address-level2");
      assertTrue(/<input type="email" id="hl-email"[^>]*\sinputmode="email"/.test(form), "AK3 rfb: #hl-email inputmode=email");
      assertTrue(/<input type="tel" id="hl-phone"[^>]*\sinputmode="tel"/.test(form), "AK3 rfb: #hl-phone inputmode=tel");
      assertTrue(/<textarea id="hl-note"[^>]*\sautocomplete="off"/.test(form), "AK3 rfb: #hl-note autocomplete=off");
      assertTrue(/<button type="button" class="hl-btn primary" id="hl-submit" aria-describedby="hl-terms">/.test(form), "AK3 rfb: submit described by the terms line");
      // unchanged tokens stay
      assertTrue(/id="hl-name"[^>]*autocomplete="name"/.test(form) && /id="hl-email"[^>]*autocomplete="email"/.test(form) && /id="hl-phone"[^>]*autocomplete="tel"/.test(form), "AK3 rfb: name/email/tel tokens kept");
      assertTrue(/id="hl-website"[^>]*autocomplete="off"/.test(form), "AK3 rfb: honeypot stays autocomplete=off");
      // the client-built item rows: one label each (wrapping label; no aria-label clash added)
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      assertTrue(/mk\('input', \{ type: 'text', maxlength: '80', placeholder: C\.item_ph, 'aria-label': C\.item_label, autocomplete: 'off' \}\)/.test(page.HANDELISTE_CLIENT_SCRIPT), "AK3 rfb: client item field autocomplete=off");
      assertTrue(/mk\('input', \{ type: 'number', min: '1', max: '99', value: String\(qty \|\| 1\), 'aria-label': C\.qty_label, inputmode: 'numeric', autocomplete: 'off' \}\)/.test(page.HANDELISTE_CLIENT_SCRIPT), "AK3 rfb: client qty field inputmode=numeric autocomplete=off");
    } finally {
      if (prevFlag === undefined) delete process.env.HANDLELISTE_ENABLED; else process.env.HANDLELISTE_ENABLED = prevFlag;
      if (prevDb) initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* ignore */ }
    }
  }

  // ═══════════ Opplevagent: /kategori/gardssalg/book/:slug ═══════════
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence, claimed_at)
         VALUES
           ('gs-g13-live', 'Skjemasjekk Vingård', 'experiences', 'Vestland', 'Voss', 'Voss', 'vingård', 1, NULL, 60.63, 6.42,
            'high', 'skjemasjekk-vingard', 'raw', 'pending_verify', 'test-fixture', 'medium', '2026-08-01T09:00:00.000Z')`,
      ).run();
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/book/skjemasjekk-vingard");
      assertTrue(r.handled && r.status === 200, `AK1 opplevagent: GET /kategori/gardssalg/book/:slug -> 200 (got ${r.status})`);
      const form = extractForm(r.body, '<form class="book-form"');
      assertTrue(form.length > 0, "AK1 opplevagent: page carries the visit-request form #book-form");
      checkLabels(form, "AK1 opplevagent");
      // the date default is "now"-dependent; it lives in an attribute, so visible text is stable
      assertEq(visibleText(form), GARDSSALG_BOOK_FORM_VISIBLE_TEXT, "AK2 opplevagent: visible form text byte-identical to main");
      // AK3 — attributes added in G1-3
      assertTrue(/<input id="slot_at"[^>]*\sautocomplete="off"/.test(form), "AK3 opplevagent: slot_at autocomplete=off");
      assertTrue(/<input id="party_size"[^>]*\sinputmode="numeric"[^>]*\sautocomplete="off"/.test(form), "AK3 opplevagent: party_size inputmode=numeric autocomplete=off");
      assertTrue(/<input id="guest_email"[^>]*\sinputmode="email"/.test(form), "AK3 opplevagent: guest_email inputmode=email");
      assertTrue(/<input id="guest_phone"[^>]*\sinputmode="tel"/.test(form), "AK3 opplevagent: guest_phone inputmode=tel");
      assertTrue(/<textarea id="notes"[^>]*\sautocomplete="off"/.test(form), "AK3 opplevagent: notes autocomplete=off");
      assertTrue(form.includes('<button type="submit" aria-describedby="book-form-status">Reserver besøk</button>'), "AK3 opplevagent: submit described by the live status line");
      assertTrue(/id="guest_name"[^>]*autocomplete="name"/.test(form) && /id="guest_email"[^>]*autocomplete="email"/.test(form) && /id="guest_phone"[^>]*autocomplete="tel"/.test(form), "AK3 opplevagent: name/email/tel tokens kept");
      // server-read field names unchanged
      for (const n of ["provider_id", "slot_at", "party_size", "guest_name", "guest_email", "guest_phone", "notes"]) {
        assertTrue(form.includes(`name="${n}"`), `opplevagent: field name ${n} unchanged`);
      }
    } finally {
      restoreModuleCache();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevDispatch === undefined) delete process.env.BOOKING_DISPATCH_ENABLED; else process.env.BOOKING_DISPATCH_ENABLED = prevDispatch;
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runFormsBrowserAgentG13Tests({ log: true }).then((s) => {
    console.log(`\nforms-browser-agent-g1-3: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
