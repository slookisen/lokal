/**
 * opplevelser-gardssalg-autosvar-scan.test.ts — tests for
 * GET /admin/gardssalg-autosvar-scan (src/routes/opplevelser.ts), added for
 * dev-request 2026-08-16-opplevagent-outreach-rutine (slookisen/A2A),
 * autosvar-detection slice.
 *
 * The Monkey Brew case ("For henvendelser til Monkey Brew ber jeg deg ta
 * kontakt med jorg@monkeybrew.no — Frank har sluttet") was found and applied
 * BY HAND via POST /admin/gardssalg-set-contact-email. This route only FINDS
 * other cases like it — read-only, no writes, no call to that endpoint.
 *
 * Harness copied verbatim from
 * opplevelser-gardssalg-outreach-candidates.test.ts (fresh in-memory
 * EXPERIENCES db via db-factory, fresh in-memory RFB db injected via
 * database/init's __setDbForTesting/__initSchemaForTesting — the SAME global
 * singleton routes/opplevelser.ts's own getRfbDb() reads), adapted for this
 * route's own query params/response shape.
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) domain_match: hjemmeside host equals the candidate email's host
 *   (c) domain_mismatch: provider has a hjemmeside, but a DIFFERENT host
 *   (d) no_website_on_file: provider has no hjemmeside at all
 *   (e) email present, NO trigger phrase -> NOT flagged as a candidate
 *   (f) trigger phrase present, NO email -> NOT flagged as a candidate
 *   (g) an RFB (non-gårdssalg) contact's inbound message with the SAME
 *       phrase+email content is excluded entirely (provider_id IS NULL is
 *       never in scope) — never counted in `scanned`, never a candidate
 *   (h) nearest-email selection: two emails in one body, the one closer (by
 *       character distance) to the matched phrase wins over the farther one
 *   (i) pagination validation: `offset` without `limit` -> 400; `limit` over
 *       the route's cap -> 400
 *   (j) zero writes: re-read the experience_providers row and the
 *       crm_messages row count before/after the scan and confirm both are
 *       byte-identical — this route must never write anything anywhere
 *
 * Exported runOpplevelserGardssalgAutosvarScanTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-autosvar-scan.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = "/admin/gardssalg-autosvar-scan" + (qs ? `?${qs}` : "");
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: "/admin/gardssalg-autosvar-scan",
      query,
      headers: opts.headers || {},
      body: {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgAutosvarScanTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-autosvar-scan-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    // NOTE: deliberately does NOT clear require.cache for "../database/init"
    // — same reasoning as opplevelser-gardssalg-outreach-candidates.test.ts:
    // the module's `db` singleton must stay the SAME instance every
    // already-loaded file resolves to.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        /* already loaded by an earlier suite in the same process */
      }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fixture helpers ─────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, hjemmeside, epost, created_at)
         VALUES (@id, @navn, 'experiences', @hjemmeside, @epost, @created_at)`,
      );
      function mkProvider(p: { id: string; navn: string; hjemmeside?: string | null; epost?: string | null }): void {
        insertProvider.run({
          hjemmeside: null,
          epost: null,
          created_at: "2026-01-01 00:00:00",
          ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id);
      }

      let contactIdSeq = 0;
      // vertical defaults to 'experiences' when providerId is given (the
      // ONLY case the crm_contact_provider_id_wrong_vertical trigger allows a
      // non-NULL provider_id under), 'rfb' otherwise — mirrors an ordinary
      // RFB producer/marketing contact.
      function mkInboundMessage(o: {
        providerId: string | null;
        contactEmail: string;
        bodyText?: string | null;
        bodyHtml?: string | null;
        sentAt?: string | null;
      }): { threadId: string; messageId: string } {
        contactIdSeq++;
        const contactId = `cid-${contactIdSeq}`;
        const threadId = `tid-${contactIdSeq}`;
        const msgId = `mid-${contactIdSeq}`;
        const vertical = o.providerId ? "experiences" : "rfb";
        rfbDb
          .prepare(
            `INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, ?, ?, 'Test Contact', 'active', ?)`,
          )
          .run(contactId, o.providerId, o.contactEmail, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Re: outreach', 'new', 'innkommende', ?)`,
          )
          .run(threadId, contactId, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_messages
               (id, thread_id, direction, from_email, to_emails, subject, body_text, body_html, sent_at, delivery_status, vertical_id)
             VALUES (?, ?, 'in', ?, '["outreach@opplevagent.no"]', 'Re: outreach', ?, ?, ?, 'sent', ?)`,
          )
          .run(msgId, threadId, o.contactEmail, o.bodyText ?? null, o.bodyHtml ?? null, o.sentAt ?? null, vertical);
        return { threadId, messageId: msgId };
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { query: {} });
      assertEq(unauth.status, 403, "a: unauthenticated request -> 403");

      // ── (b) domain_match ────────────────────────────────────────────────
      mkProvider({ id: "prov-match", navn: "Monkey Brew Gård", hjemmeside: "https://monkeybrew.no", epost: "frank@monkeybrew.no" });
      mkInboundMessage({
        providerId: "prov-match",
        contactEmail: "frank@monkeybrew.no",
        bodyText: "Hei, Frank har sluttet. For henvendelser ber jeg deg ta kontakt med jorg@monkeybrew.no fremover. Mvh",
        sentAt: "2026-08-01 09:00:00",
      });

      const matchRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      assertEq(matchRes.status, 200, "b1: scan -> 200");
      const matchCandidate = (matchRes.body.candidates as any[]).find((c) => c.provider_id === "prov-match");
      assertTrue(!!matchCandidate, "b2: monkeybrew.no autosvar detected as a candidate");
      assertEq(matchCandidate?.candidate_email, "jorg@monkeybrew.no", "b3: candidate_email is the replacement address");
      assertEq(matchCandidate?.classification, "domain_match", "b4: classification is domain_match (same host as hjemmeside)");
      assertEq(matchCandidate?.matched_phrase.toLowerCase(), "ta kontakt med", "b5: matched_phrase reflects the trigger phrase found");
      assertEq(matchCandidate?.contact_email, "frank@monkeybrew.no", "b6: contact_email is the CRM contact's stored email, not the candidate one");
      assertTrue(matchRes.body.summary.domain_match >= 1, "b7: summary.domain_match reflects it");

      // ── (c) domain_mismatch ─────────────────────────────────────────────
      mkProvider({ id: "prov-mismatch", navn: "Anna Cider Gård", hjemmeside: "https://annacider.no", epost: "post@annacider.no" });
      mkInboundMessage({
        providerId: "prov-mismatch",
        contactEmail: "post@annacider.no",
        bodyText: "Vennligst henvend deg til ny-kontakt@et-helt-annet-domene.no i stedet.",
        sentAt: "2026-08-02 09:00:00",
      });

      const mismatchRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      const mismatchCandidate = (mismatchRes.body.candidates as any[]).find((c) => c.provider_id === "prov-mismatch");
      assertTrue(!!mismatchCandidate, "c1: annacider.no autosvar detected as a candidate");
      assertEq(mismatchCandidate?.candidate_email, "ny-kontakt@et-helt-annet-domene.no", "c2: candidate_email extracted correctly");
      assertEq(mismatchCandidate?.classification, "domain_mismatch", "c3: classification is domain_mismatch (different host than hjemmeside)");

      // ── (d) no_website_on_file ──────────────────────────────────────────
      mkProvider({ id: "prov-nowebsite", navn: "Ukjent Nettside Gård", hjemmeside: null, epost: "post@ukjentgard.no" });
      mkInboundMessage({
        providerId: "prov-nowebsite",
        contactEmail: "post@ukjentgard.no",
        bodyText: "Kontakt oss på ny-post@ukjentgard-erstatning.no fremover, takk.",
        sentAt: "2026-08-03 09:00:00",
      });

      const noWebsiteRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      const noWebsiteCandidate = (noWebsiteRes.body.candidates as any[]).find((c) => c.provider_id === "prov-nowebsite");
      assertTrue(!!noWebsiteCandidate, "d1: no-hjemmeside autosvar detected as a candidate");
      assertEq(noWebsiteCandidate?.classification, "no_website_on_file", "d2: classification is no_website_on_file");

      // ── (e) email present, no trigger phrase -> NOT a candidate ─────────
      mkProvider({ id: "prov-noPhrase", navn: "Ingen Frase Gård", hjemmeside: "https://ingenfrase.no", epost: "post@ingenfrase.no" });
      mkInboundMessage({
        providerId: "prov-noPhrase",
        contactEmail: "post@ingenfrase.no",
        bodyText: "Takk for eposten, du kan nå oss på post@ingenfrase.no som vanlig.",
        sentAt: "2026-08-04 09:00:00",
      });

      const noPhraseRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      assertTrue(
        !(noPhraseRes.body.candidates as any[]).some((c) => c.provider_id === "prov-noPhrase"),
        "e1: an email with no trigger phrase is NOT flagged as a candidate",
      );

      // ── (f) trigger phrase present, no email -> NOT a candidate ─────────
      mkProvider({ id: "prov-noEmail", navn: "Ingen Epost Gård", hjemmeside: "https://ingenepost.no", epost: "post@ingenepost.no" });
      mkInboundMessage({
        providerId: "prov-noEmail",
        contactEmail: "post@ingenepost.no",
        bodyText: "Du kan gjerne ta kontakt med oss igjen senere, vi svarer så fort vi kan.",
        sentAt: "2026-08-05 09:00:00",
      });

      const noEmailRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      assertTrue(
        !(noEmailRes.body.candidates as any[]).some((c) => c.provider_id === "prov-noEmail"),
        "f1: a trigger phrase with no email is NOT flagged as a candidate",
      );

      // ── (g) an RFB (non-gårdssalg) contact is excluded entirely ─────────
      mkInboundMessage({
        providerId: null,
        contactEmail: "rfb-produsent@rfb-fixture.no",
        bodyText: "For henvendelser ber jeg deg ta kontakt med erstatning@rfb-fixture.no i stedet, RFB gjelder ikke gårdssalg.",
        sentAt: "2026-08-06 09:00:00",
      });
      const rfbRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      assertTrue(
        !(rfbRes.body.candidates as any[]).some((c) => c.contact_email === "rfb-produsent@rfb-fixture.no"),
        "g1: an RFB (provider_id NULL) contact's inbound message is never a candidate",
      );

      // ── (h) nearest-email selection ──────────────────────────────────────
      mkProvider({ id: "prov-nearest", navn: "Nærmeste Epost Gård", hjemmeside: "https://naermest.no", epost: "post@naermest.no" });
      mkInboundMessage({
        providerId: "prov-nearest",
        contactEmail: "post@naermest.no",
        // gammel@far-away.no is far from the phrase; ny@naermest.no sits
        // immediately next to it and must be the one extracted.
        bodyText:
          "Vår gamle adresse gammel@far-away.no er ikke i bruk lenger. ".padEnd(120, ".") +
          " Ny kontaktperson er ny@naermest.no.",
        sentAt: "2026-08-07 09:00:00",
      });
      const nearestRes = await callRoute(opplevelserRouter, { headers: auth, query: {} });
      const nearestCandidate = (nearestRes.body.candidates as any[]).find((c) => c.provider_id === "prov-nearest");
      assertTrue(!!nearestCandidate, "h1: nearest-email fixture detected as a candidate");
      assertEq(nearestCandidate?.candidate_email, "ny@naermest.no", "h2: the email CLOSEST to the matched phrase is chosen, not the first one in the body");

      // ── (i) pagination validation ────────────────────────────────────────
      const offsetNoLimit = await callRoute(opplevelserRouter, { headers: auth, query: { offset: "1" } });
      assertEq(offsetNoLimit.status, 400, "i1: offset without limit -> 400");

      const overCap = await callRoute(opplevelserRouter, { headers: auth, query: { limit: "99999" } });
      assertEq(overCap.status, 400, "i2: limit over the route's cap -> 400");

      const badLimit = await callRoute(opplevelserRouter, { headers: auth, query: { limit: "0" } });
      assertEq(badLimit.status, 400, "i3: limit=0 -> 400 (must be a positive integer, never silently clamped)");

      const negOffset = await callRoute(opplevelserRouter, { headers: auth, query: { limit: "5", offset: "-1" } });
      assertEq(negOffset.status, 400, "i4: negative offset -> 400");

      const okPaged = await callRoute(opplevelserRouter, { headers: auth, query: { limit: "2", offset: "0" } });
      assertEq(okPaged.status, 200, "i5: valid limit/offset -> 200");
      assertEq(okPaged.body.pagination.limit, 2, "i6: pagination.limit echoes the request");
      assertEq(okPaged.body.pagination.offset, 0, "i7: pagination.offset echoes the request");
      assertTrue(okPaged.body.pagination.total >= 6, "i8: pagination.total counts the full base pool, not just this page");
      assertEq(okPaged.body.scanned, 2, "i9: scanned equals the page size, not the full pool");

      // ── (j) zero writes ──────────────────────────────────────────────────
      const providerBefore = getProviderRow("prov-match");
      const messageCountBefore = (rfbDb.prepare(`SELECT COUNT(*) AS n FROM crm_messages`).get() as any).n;
      const contactCountBefore = (rfbDb.prepare(`SELECT COUNT(*) AS n FROM crm_contacts`).get() as any).n;

      await callRoute(opplevelserRouter, { headers: auth, query: {} });
      await callRoute(opplevelserRouter, { headers: auth, query: { limit: "3", offset: "1" } });

      const providerAfter = getProviderRow("prov-match");
      const messageCountAfter = (rfbDb.prepare(`SELECT COUNT(*) AS n FROM crm_messages`).get() as any).n;
      const contactCountAfter = (rfbDb.prepare(`SELECT COUNT(*) AS n FROM crm_contacts`).get() as any).n;

      assertEq(providerAfter, providerBefore, "j1: experience_providers row byte-identical before/after the scan");
      assertEq(messageCountAfter, messageCountBefore, "j2: crm_messages row count unchanged — no INSERT");
      assertEq(contactCountAfter, contactCountBefore, "j3: crm_contacts row count unchanged — no INSERT");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-autosvar-scan: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) {
          initMod.__setDbForTesting(prevRfbDb);
        }
      } catch {
        // best-effort cleanup
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-autosvar-scan.test.ts
if (require.main === module) {
  runOpplevelserGardssalgAutosvarScanTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
