/**
 * crm-triage.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 4.
 *
 *   «CS-agentens triage utleder plattform fra videresenderens From-adresse …
 *    Ukjent/tvetydig signal → egen «utriaged»-bøtte for Daniel, ALDRI en gjetning.»
 *
 * The failure class this whole dev-request exists to stop is SILENCE: a message
 * that goes to the wrong platform, or nowhere, with nothing anywhere recording
 * that a decision was made. Steg 1-3 closed the write paths and the outbound
 * identity. Steg 4 closes the inbound decision itself, and the tests below are
 * organised around the ways that decision can be faked:
 *
 *   tr1-tr14   deriveVertical is TOTAL and REFUSES. Every input that is not
 *              exactly one platform alias returns routed:false — including the
 *              tempting ones (an opplevagent.no sender address, a
 *              rettfrabonden.com URL in the body). There is no default branch,
 *              so a mutant that adds one has to survive an explicit assertion.
 *   tr15-tr23  The bucket. Parking is idempotent per thread (the CS agent
 *              re-sends the same threadIds every cron run), a RESOLVED item is
 *              never silently reopened, and dismissal is distinguishable from
 *              assignment.
 *   tr24-tr33  POST /ingest end to end, through the real router: undecidable →
 *              202 + a row in crm_untriaged + NOTHING in the CRM. Asserted on
 *              the database, never on the response alone.
 *   tr34-tr37  The both-given case. An asserted `vertical` that disagrees with
 *              the headers must NOT win — otherwise the LLM keeps the decision
 *              through a door nobody thinks to test.
 *   tr38-tr42  Assignment replays through the ORDINARY ingest path, and the row
 *              is only marked resolved if that write actually happened.
 *   tr43-tr46  4f — the outbox payload carries vertical_id + replyTo. This is a
 *              fact about today: gmail_draft is the CS agent's default intent
 *              and carried no platform identity at all.
 *   tr47-tr50  4e — the cross-platform cooldown names the suppressing vertical
 *              instead of hiding behind a generic 429.
 *   tr51-tr54  contact.ts: a PRESENT-but-unknown platform is now 422, not a
 *              silent fall-through to host inference.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-triage.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmTriageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    // admin-outreach-candidates reads ADMIN_KEY FIRST and only then falls back
    // to ANALYTICS_ADMIN_KEY. Setting only the latter left every candidates
    // call at 403 — and two of the assertions below ("X is not in the list")
    // passed anyway, against an empty list. That is why tr55b/tr55c assert the
    // fixtures ARE candidates before anything asserts one is missing.
    const prevAdminKey2 = process.env.ADMIN_KEY;
    const prevTurnstile = process.env.SKIP_TURNSTILE;
    const db = new Database(":memory:");
    const triage = require("./crm-triage") as typeof import("./crm-triage");
    const crm = require("./crm-service") as typeof import("./crm-service");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      process.env.ANALYTICS_ADMIN_KEY = "test-admin-key";
      process.env.ADMIN_KEY = "test-admin-key";
      process.env.SKIP_TURNSTILE = "true";

      const RFB = "kontakt@rettfrabonden.com";
      const OPPLEV = "kontakt@opplevagent.no";

      // ═══════════════════════════════════════════════════════════════
      // tr1-tr14 — deriveVertical REFUSES.
      //
      // Each of these is an input where an LLM asked "which platform?" would
      // confidently answer. The point of moving the decision into code is that
      // the answer here is "I cannot tell", and that answer is representable.
      // ═══════════════════════════════════════════════════════════════
      {
        const r = triage.deriveVertical({ deliveredTo: RFB });
        assertTrue(r.routed === true && r.vertical === "rfb", "tr1: the RFB alias in Delivered-To routes to rfb");
        assertTrue(r.routed === true && r.matchedIn === "deliveredTo", "tr1b: …and reports WHICH header decided it");
      }
      {
        const r = triage.deriveVertical({ to: `Opplevagent <${OPPLEV}>` });
        assertTrue(r.routed === true && r.vertical === "experiences",
          "tr2: the opplevagent alias inside an RFC 5322 display-name form routes to experiences");
      }
      {
        const r = triage.deriveVertical({ to: ["noen@example.no", `Support <${OPPLEV}>`] });
        assertTrue(r.routed === true && r.vertical === "experiences",
          "tr3: a list where only one entry is a platform alias still decides");
      }
      {
        const r = triage.deriveVertical({ deliveredTo: "KONTAKT@Opplevagent.NO" });
        assertTrue(r.routed === true && r.vertical === "experiences",
          "tr4: matching is case-insensitive — mail servers do not preserve case and a case-sensitive map would park every second message");
      }
      {
        const r = triage.deriveVertical({ deliveredTo: [RFB, OPPLEV] });
        assertEq(r.routed, false, "tr5: BOTH aliases present → refuses rather than picking the first");
        assertTrue(!r.routed && r.code === "ambiguous_platform_addresses", "tr5b: …and says it was ambiguous, not merely unmatched");
        assertTrue(!r.routed && r.reason.includes("rfb") && r.reason.includes("experiences"),
          "tr5c: …and NAMES both candidates, so a human can decide without opening Gmail");
      }
      {
        const r = triage.deriveVertical({ to: RFB, cc: OPPLEV });
        assertEq(r.routed, false, "tr6: ambiguity across DIFFERENT headers is still ambiguity");
      }
      {
        const r = triage.deriveVertical({ deliveredTo: "da.fredriksen@gmail.com" });
        assertEq(r.routed, false, "tr7: mail delivered straight to the Gmail address matches no platform → parked");
        assertTrue(!r.routed && r.code === "no_platform_address", "tr7b: …with the no-alias code, distinct from ambiguity");
      }
      {
        const r = triage.deriveVertical({});
        assertEq(r.routed, false, "tr8: an empty signals object refuses");
        assertTrue(!r.routed && r.code === "no_signals", "tr8b: …distinguishing 'nothing was reported' from 'reported, nothing matched'");
      }
      assertEq(triage.deriveVertical(undefined).routed, false, "tr9: undefined signals refuse rather than throw");
      assertEq(triage.deriveVertical(null).routed, false, "tr10: null signals refuse rather than throw");
      {
        const r = triage.deriveVertical({ deliveredTo: ["", "   "] });
        assertTrue(!r.routed && r.code === "no_signals",
          "tr11: whitespace-only values count as no signal, not as a signal that matched nothing");
      }
      {
        // The most seductive wrong answer: the SENDER is on opplevagent.no.
        // deriveVertical is deliberately not given the From address at all, so
        // this can only park. If someone later adds a `from` field to the
        // deciding set, this assertion fails.
        const r = triage.deriveVertical({ deliveredTo: "da.fredriksen@gmail.com", to: "ola@opplevagent.no" });
        assertEq(r.routed, false,
          "tr12: a DIFFERENT opplevagent.no address is not the platform alias — only the exact alias decides");
      }
      {
        const r = triage.deriveVertical({ received: [`by mx1.improvmx.com for <${OPPLEV}>`] });
        assertTrue(!r.routed && r.code === "no_signals",
          "tr13: the Received chain is evidence, NOT authority — an alias appearing only there does not decide");
      }
      {
        const r = triage.deriveVertical({ to: `"Nordmann, Ola" <ola@example.no>, ${OPPLEV}` });
        assertTrue(r.routed === true && r.vertical === "experiences",
          "tr14: a comma inside a quoted display name does not swallow the recipient after it — a split(',') parser drops it");
      }

      // The alias table is the whole decision. Pin its exact contents: an extra
      // entry (say a wildcard, or finn-tannlege.com pointed at rfb) changes
      // routing for every future message and would otherwise land unremarked.
      {
        const table = triage.__platformAddressesForTesting();
        assertEq(Object.keys(table).length, 2, "tr14b: exactly two platform aliases are configured");
        assertEq(table[RFB], "rfb", "tr14c: …rfb");
        assertEq(table[OPPLEV], "experiences", "tr14d: …and experiences. finn-tannlege.com has NO inbound alias (steg 3), so dental cannot appear on this path at all");
      }

      // ═══════════════════════════════════════════════════════════════
      // tr15-tr23 — the bucket.
      // ═══════════════════════════════════════════════════════════════
      {
        const a = triage.parkUntriaged({
          threadId: "tr-park-1", fromEmail: "ukjent@example.no", subject: "Hei",
          snippet: "kort", reason: "no_platform_address", signals: { to: "x@y.no" }, rawPayload: { messages: [] },
        });
        assertEq(triage.countOpenUntriaged(), 1, "tr15: parking creates exactly one open item");

        const b = triage.parkUntriaged({
          threadId: "tr-park-1", fromEmail: "ukjent@example.no", subject: "Hei igjen",
          snippet: "lengre", reason: "still unroutable", signals: { to: "z@y.no" }, rawPayload: { messages: [] },
        });
        assertEq(b.id, a.id, "tr16: re-parking the SAME threadId reuses the row — CS ingest is idempotent and re-sends every threadId each cron run");
        assertEq(triage.countOpenUntriaged(), 1, "tr17: …so a permanently unroutable thread does not grow one row per tick");

        const row = triage.getUntriaged(a.id)!;
        assertEq(row.reason, "still unroutable", "tr18: re-parking REFRESHES the reason — a new reply can carry different headers");
        assertEq(row.subject, "Hei igjen", "tr18b: …and the subject");

        assertEq(triage.markUntriagedResolved(a.id, "experiences", "daniel"), true, "tr19: resolving an open item succeeds");
        assertEq(triage.countOpenUntriaged(), 0, "tr20: …and it leaves the open queue");
        assertEq(triage.markUntriagedResolved(a.id, "rfb", "daniel"), false,
          "tr21: resolving an ALREADY-resolved item is refused — a second decision must not silently overwrite the first");
        assertEq(triage.getUntriaged(a.id)!.resolved_vertical, "experiences", "tr21b: …and the original decision stands");

        const c = triage.parkUntriaged({
          threadId: "tr-park-1", fromEmail: "ukjent@example.no", subject: "Tredje",
          reason: "would reopen", signals: {}, rawPayload: {},
        });
        assertEq(c.alreadyResolved, true, "tr22: re-parking a RESOLVED thread reports it, rather than reopening it behind the human's back");
        assertEq(triage.countOpenUntriaged(), 0, "tr22b: …and the queue stays empty");
        assertEq(triage.getUntriaged(a.id)!.subject, "Hei igjen", "tr22c: …and the resolved row is not overwritten");
      }
      {
        const d = triage.parkUntriaged({
          threadId: "tr-park-dismiss", fromEmail: "spam@example.no", reason: "spam", signals: {}, rawPayload: {},
        });
        triage.markUntriagedResolved(d.id, null, "daniel: nyhetsbrev");
        const row = triage.getUntriaged(d.id)!;
        assertTrue(row.resolved_at !== null && row.resolved_vertical === null,
          "tr23: dismissed is representable and distinguishable — resolved_at set, resolved_vertical null");
        assertEq(triage.listUntriaged({ includeResolved: false }).some((r) => r.id === d.id), false,
          "tr23b: …and dismissed items leave the open queue");
      }

      // ═══════════════════════════════════════════════════════════════
      // tr24-tr42 — POST /admin/crm/ingest, through the REAL router.
      //
      // Every assertion below reads the DATABASE, not just the response.
      // A route can answer 202 while having written the row anyway.
      // ═══════════════════════════════════════════════════════════════
      const crmRoutes = require("../routes/crm") as any;
      const crmRouter = crmRoutes.default ?? crmRoutes;

      const call = async (
        method: string,
        url: string,
        body?: any,
      ): Promise<{ status: number; body: any }> => {
        const [path, qs] = url.split("?");
        const query: Record<string, string> = {};
        for (const kv of (qs ?? "").split("&").filter(Boolean)) {
          const [k, v] = kv.split("=");
          query[k] = decodeURIComponent(v ?? "");
        }
        const req: any = {
          method, url, originalUrl: url, path, query, body: body ?? {},
          headers: { "x-admin-key": "test-admin-key", host: "rettfrabonden.com" },
          get(n: string) { return this.headers[n.toLowerCase()]; },
        };
        let settle: () => void;
        const done = new Promise<void>((r) => { settle = r; });
        const res: any = {
          statusCode: 200, _body: undefined,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { this._body = b; settle(); return this; },
          send(b: any) { this._body = b; settle(); return this; },
        };
        crmRouter.handle(req, res, () => settle());
        await done;
        return { status: res.statusCode, body: res._body };
      };

      // Sanity: the harness actually reaches the handler. Without this, every
      // assertion below could be reading a 200 from the fall-through `next()`
      // — which is exactly how cv42-cv45 passed while testing nothing.
      {
        const r = await call("GET", "/untriaged");
        assertEq(r.status, 200, "tr24: the test harness genuinely reaches the router (guards every assertion below)");
        assertTrue(typeof r.body?.open === "number", "tr24b: …and gets the real handler's response shape");
      }

      const msgFixture = (id: string) => [{
        messageId: id, direction: "in" as const, fromEmail: "gjest@example.no",
        subject: "Spørsmål", snippet: "Hei, jeg lurer på", sentAt: "2026-07-29T09:00:00Z",
      }];

      // ── Undecidable: 202, parked, and NOTHING in the CRM ──────────
      {
        const openBefore = triage.countOpenUntriaged();
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-unknown", primaryFromEmail: "gjest@example.no",
          subject: "Ukjent rute", messages: msgFixture("tr-ing-unknown-m1"),
          routingSignals: { deliveredTo: "da.fredriksen@gmail.com" },
        });
        assertEq(r.status, 202, "tr25: an unroutable ingest answers 202 — accepted and recorded, but not filed");
        assertEq(r.body?.untriaged, true, "tr25b: …with the field a caller branches on");
        assertEq(triage.countOpenUntriaged(), openBefore + 1, "tr26: …and one item entered Daniel's queue");

        const thread = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get("tr-ing-unknown");
        assertEq(thread, undefined, "tr27: NO crm_threads row was written — the whole point is that it is not filed as rfb");
        const contact = db.prepare("SELECT id FROM crm_contacts WHERE email = ? AND vertical_id = 'rfb'").get("gjest@example.no");
        assertEq(contact, undefined, "tr28: …and no contact was created either. 'Nothing was written' was false once before (review B4); it is asserted here rather than claimed");
        const msg = db.prepare("SELECT id FROM crm_messages WHERE id = ?").get("tr-ing-unknown-m1");
        assertEq(msg, undefined, "tr29: …and no message");

        const parked = db.prepare("SELECT * FROM crm_untriaged WHERE thread_id = ?").get("tr-ing-unknown") as any;
        assertTrue(!!parked, "tr30: the thread IS durably recorded — parking is what makes the silence audible");
        assertTrue(String(parked?.reason).length > 10, "tr30b: …with a reason a human can act on");
        assertTrue(String(parked?.raw_payload).includes("tr-ing-unknown-m1"),
          "tr30c: …and the full payload, so assignment can replay it without going back to Gmail");
      }

      // ── Decidable: routes, and stamps what the HEADERS said ───────
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-opplev", primaryFromEmail: "kunde@example.no",
          subject: "Opplevelse", messages: msgFixture("tr-ing-opplev-m1"),
          routingSignals: { deliveredTo: `Opplevagent <${OPPLEV}>` },
        });
        assertEq(r.status, 200, "tr31: a derivable ingest goes through — the positive path is open, not merely everything refused");
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get("tr-ing-opplev") as any;
        assertEq(t?.vertical_id, "experiences", "tr32: …and the thread is stamped from the HEADERS, not from a default");
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = ?").get("tr-ing-opplev-m1") as any;
        assertEq(m?.vertical_id, "experiences", "tr33: …and so is the message");
      }

      // ── Neither field: still 400, exactly as steg 1 required ──────
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-neither", primaryFromEmail: "x@example.no", messages: msgFixture("tr-ing-neither-m1"),
        });
        assertEq(r.status, 400, "tr34: a body with NEITHER vertical NOR routingSignals is still a 400 — steg 1's guarantee survives steg 4");
        assertEq(db.prepare("SELECT id FROM crm_threads WHERE id = ?").get("tr-ing-neither"), undefined,
          "tr34b: …and writes nothing");
        assertEq(db.prepare("SELECT id FROM crm_untriaged WHERE thread_id = ?").get("tr-ing-neither"), undefined,
          "tr34c: …and does NOT park it either — a malformed call is the caller's bug, not Daniel's triage work");
      }

      // ── A mistyped signal key is a loud 400, not a silent park ────
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-typo", primaryFromEmail: "x@example.no", messages: msgFixture("tr-ing-typo-m1"),
          routingSignals: { delivered_to: RFB },
        });
        assertEq(r.status, 400, "tr35: an unknown key in routingSignals errors once, loudly — a lenient schema would park EVERY thread and look like a triage flood");
      }

      // ── Both given and disagreeing: parked, not obeyed ────────────
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-conflict", primaryFromEmail: "kunde@example.no",
          messages: msgFixture("tr-ing-conflict-m1"),
          vertical: "rfb",
          routingSignals: { deliveredTo: OPPLEV },
        });
        assertEq(r.status, 202, "tr36: an asserted vertical that CONTRADICTS the headers is parked, not obeyed");
        assertEq(db.prepare("SELECT id FROM crm_threads WHERE id = ?").get("tr-ing-conflict"), undefined,
          "tr36b: …and nothing is written under EITHER platform. The caller is an LLM; letting its assertion win hands the decision straight back");
        const parked = db.prepare("SELECT reason FROM crm_untriaged WHERE thread_id = ?").get("tr-ing-conflict") as any;
        assertTrue(String(parked?.reason).includes("rfb") && String(parked?.reason).includes("experiences"),
          "tr36c: …and the reason names both the asserted and the derived value");
      }
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-agree", primaryFromEmail: "kunde2@example.no",
          messages: msgFixture("tr-ing-agree-m1"),
          vertical: "experiences",
          routingSignals: { deliveredTo: OPPLEV },
        });
        assertEq(r.status, 200, "tr37: …but an asserted vertical that AGREES with the headers passes through");
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get("tr-ing-agree") as any;
        assertEq(t?.vertical_id, "experiences", "tr37b: …and files it");
      }

      // ── vertical only, no signals: byte-identical old behaviour ───
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-legacy", primaryFromEmail: "gammel@example.no",
          messages: msgFixture("tr-ing-legacy-m1"), vertical: "rfb",
        });
        assertEq(r.status, 200, "tr38: a pre-steg-4 caller sending only `vertical` still works unchanged");
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get("tr-ing-legacy") as any;
        assertEq(t?.vertical_id, "rfb", "tr38b: …and is filed on the platform it named");
      }

      // ── The 409 conflict now lands in the bucket ──────────────────
      {
        const r = await call("POST", "/ingest", {
          threadId: "tr-ing-legacy", primaryFromEmail: "gammel@example.no",
          messages: msgFixture("tr-ing-legacy-m2"), vertical: "experiences",
        });
        assertEq(r.status, 409, "tr39: re-ingesting a thread under a different platform is still refused with 409 (review B4)");
        const parked = db.prepare("SELECT id, reason FROM crm_untriaged WHERE thread_id = ?").get("tr-ing-legacy") as any;
        assertTrue(!!parked, "tr40: …and it NOW lands in the bucket. Before steg 4 a conflicting thread failed only in the agent's own log — invisible to Daniel");
        assertTrue(String(parked?.reason).includes("already belongs to vertical"),
          "tr40b: …carrying the conflict as its reason");
        const t = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get("tr-ing-legacy") as any;
        assertEq(t?.vertical_id, "rfb", "tr40c: …and the existing thread is untouched");
      }

      // ── Assignment replays through the ordinary ingest path ───────
      {
        const item = db.prepare("SELECT id FROM crm_untriaged WHERE thread_id = ?").get("tr-ing-unknown") as any;
        const r = await call("POST", `/untriaged/${item.id}/assign`, { vertical: "experiences", resolvedBy: "daniel" });
        assertEq(r.status, 200, "tr41: assigning an open item succeeds");

        const t = db.prepare("SELECT vertical_id, contact_id FROM crm_threads WHERE id = ?").get("tr-ing-unknown") as any;
        assertEq(t?.vertical_id, "experiences",
          "tr41b: …and the thread is now IN the CRM on the chosen platform — assignment promotes, it does not merely close a ticket");
        const m = db.prepare("SELECT vertical_id FROM crm_messages WHERE id = ?").get("tr-ing-unknown-m1") as any;
        assertEq(m?.vertical_id, "experiences", "tr41c: …with the stored payload's message replayed through the ordinary write path");
        const c = db.prepare("SELECT vertical_id FROM crm_contacts WHERE id = ?").get(t?.contact_id) as any;
        assertEq(c?.vertical_id, "experiences", "tr41d: …and its contact on the same platform");

        const row = triage.getUntriaged(item.id)!;
        assertEq(row.resolved_vertical, "experiences", "tr42: …and only THEN is the item marked resolved");
        assertEq(row.resolved_by, "daniel", "tr42b: …naming who decided");

        const again = await call("POST", `/untriaged/${item.id}/assign`, { vertical: "rfb" });
        assertEq(again.status, 409, "tr42c: assigning it a second time is refused — a resolved item is not a mutable field");
      }
      // A replay that CANNOT succeed must leave the item open.
      {
        const p = triage.parkUntriaged({
          threadId: "tr-ing-agree", // already filed as experiences by tr37
          fromEmail: "kunde2@example.no", reason: "manufactured conflict",
          signals: {}, rawPayload: { messages: [{ messageId: "tr-replayfail-m1", direction: "in", fromEmail: "kunde2@example.no" }] },
        });
        const r = await call("POST", `/untriaged/${p.id}/assign`, { vertical: "rfb" });
        assertEq(r.status, 409, "tr42d: an assignment whose replay throws is reported as a failure…");
        assertEq(triage.getUntriaged(p.id)!.resolved_at, null,
          "tr42e: …and leaves the item OPEN. Closing it on a write that never happened is the silence this whole step exists to stop");
      }

      // ═══════════════════════════════════════════════════════════════
      // tr43-tr46 — kriterium 4f: the outbox payload carries the identity.
      //
      // A fact about TODAY: gmail_draft is the CS agent's DEFAULT intent, it
      // goes out through Daniel's own Gmail (so the code cannot set From), and
      // the payload exposed neither vertical_id nor replyTo. The majority of
      // CRM replies therefore left with no platform identity at all, and the
      // funn-4 inbound discriminator was lost on the busiest path.
      // ═══════════════════════════════════════════════════════════════
      {
        const t = db.prepare("SELECT id, contact_id FROM crm_threads WHERE id = ?").get("tr-ing-opplev") as any;
        crm.crmService.enqueueOutbox({
          threadId: t.id, contactId: t.contact_id, intent: "gmail_draft",
          toEmails: ["kunde@example.no"], subject: "Svar", bodyText: "Hei!", createdBy: "claude",
          vertical: "experiences",
        });

        const r = await call("GET", "/outbox/pending?intent=gmail_draft");
        assertEq(r.status, 200, "tr43: the outbox queue answers");
        const item = (r.body?.items ?? []).find((i: any) => i.thread_id === t.id);
        assertTrue(!!item, "tr43b: …and contains the queued draft");
        assertEq(item?.vertical_id, "experiences", "tr44: the payload carries vertical_id");
        assertEq(item?.reply_to, OPPLEV,
          "tr45: …and the reply-to for that platform. This is what preserves the inbound discriminator on the gmail_draft path (funn 4)");
        assertEq(item?.from_display_name, "Opplevagent", "tr46: …and the display name");
        assertEq(item?.from_header, `"Opplevagent" <${RFB}>`,
          "tr46b: …and the full RFC 5322 From, so the agent never keeps its own copy of the mapping");
        assertEq(item?.identity_error, undefined, "tr46c: …with no identity error on a configured vertical");
      }
      {
        // An unconfigured vertical must not blank the queue for everyone else.
        db.prepare("UPDATE crm_outbox SET vertical_id = 'ukjent' WHERE thread_id = ?").run("tr-ing-opplev");
        const r = await call("GET", "/outbox/pending?intent=gmail_draft");
        const item = (r.body?.items ?? []).find((i: any) => i.thread_id === "tr-ing-opplev");
        assertTrue(typeof item?.identity_error === "string",
          "tr46d: an unconfigured vertical yields identity_error on THAT row rather than a 500 that hides the whole queue");
        db.prepare("UPDATE crm_outbox SET vertical_id = 'experiences' WHERE thread_id = ?").run("tr-ing-opplev");
      }

      // ═══════════════════════════════════════════════════════════════
      // tr47-tr50 — kriterium 4e: name the suppressing platform.
      //
      // The 60-day cooldown is cross-platform ON PURPOSE (one sender address,
      // so one sender as far as the recipient and their spam filter are
      // concerned). The cost is that overlap producers — the claim campaign's
      // best list — vanished behind a generic 429.
      // ═══════════════════════════════════════════════════════════════
      //
      // NOTE the route: the cooldown invariant lives on POST /compose, NOT on
      // /threads/:id/send. The first version of this block posted to
      // /threads/:id/send, got a clean 200, and would have "proved" the guard by
      // never reaching it. Same shape as cv42's dead route in steg 1.
      {
        const VICTIM = "overlapp@gaard.no";
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                    VALUES ('tr-agent-overlapp','Overlapp Gard','x','test',?,'https://overlapp.example.no','producer','tr-key-1',1)`).run(VICTIM);
        db.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES ('tr-agent-overlapp', ?, datetime('now','-3 days'), 'email', 'tr-osl-1', 'tr', 'experiences')`,
        ).run(VICTIM);

        const r = await call("POST", "/compose", {
          to: VICTIM, subject: "Claim", bodyText: "Hei, vil du overta profilen?",
          intent: "resend_send", createdBy: "claude", vertical: "rfb",
        });
        assertEq(r.status, 429, "tr47: the send-path cooldown still refuses — 4e reports, it does not relax the guard");
        assertEq(r.body?.suppressed_by_vertical, "experiences",
          "tr48: …and NAMES the suppressing platform. Without this the campaign sees only 'cooldown_suppressed' and cannot tell overlap producers from ordinary repeats");
        assertEq(r.body?.cross_platform, true,
          "tr49: …and flags that it was another platform, not this one");
        assertTrue(String(r.body?.reason).includes("experiences"),
          "tr50: …in the human-readable reason too, which is what ends up in the campaign log");
      }
      {
        // Same-platform suppression must NOT be reported as cross-platform —
        // otherwise the count 4e exists to produce is inflated by ordinary
        // repeats and means nothing.
        const SAME = "samme@gaard.no";
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                    VALUES ('tr-agent-samme','Samme Gard','x','test',?,'https://samme.example.no','producer','tr-key-2',1)`).run(SAME);
        db.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES ('tr-agent-samme', ?, datetime('now','-3 days'), 'email', 'tr-osl-2', 'tr', 'rfb')`,
        ).run(SAME);
        const r = await call("POST", "/compose", {
          to: SAME, subject: "Claim", bodyText: "Hei igjen",
          intent: "resend_send", createdBy: "claude", vertical: "rfb",
        });
        assertEq(r.status, 429, "tr50b: an ordinary same-platform repeat is still suppressed…");
        assertEq(r.body?.cross_platform, false,
          "tr50c: …but is NOT counted as cross-platform. A flag that is always true would report every repeat as an overlap producer");
        assertEq(r.body?.suppressed_by_vertical, "rfb", "tr50d: …and still names which platform sent it");
      }

      // ═══════════════════════════════════════════════════════════════
      // tr55-tr60 — kriterium 4e proper: THE CAMPAIGN REPORTS IT.
      //
      //   «kampanjen rapporterer «N produsenter hoppet over av kryss-plattform
      //    cooldown», med den undertrykkende vertical navngitt.
      //    Skal ikke shippes claim-kampanje uten dette.»
      //
      // The 429 above is per-send and after the fact. This is the forewarning:
      // the gate that hands the campaign its target list must say, up front,
      // which producers it is holding back and which platform is holding them.
      //
      // The fixture is deliberately a producer who IS pool-eligible and IS in
      // outreach_ready_pool — i.e. one the RFB pool correctly does NOT exclude
      // (steg 3 scoped that exclusion to vertical_id='rfb'). Without a
      // pool-eligible fixture the assertions would read "not a candidate" for
      // reasons that have nothing to do with the clause under test.
      // ═══════════════════════════════════════════════════════════════
      {
        const candRoutes = require("../routes/admin-outreach-candidates") as any;
        const candRouter = candRoutes.default ?? candRoutes;
        const getCandidates = async (qs: string): Promise<{ status: number; body: any }> => {
          const query: Record<string, string> = {};
          for (const kv of qs.split("&").filter(Boolean)) {
            const [k, v] = kv.split("=");
            query[k] = decodeURIComponent(v ?? "");
          }
          const req: any = {
            method: "GET", url: `/?${qs}`, originalUrl: `/?${qs}`, path: "/", query, body: {},
            headers: { "x-admin-key": "test-admin-key" },
            get(n: string) { return this.headers[n.toLowerCase()]; },
          };
          let settle: () => void;
          const done = new Promise<void>((r) => { settle = r; });
          const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(b: any) { this._body = b; settle(); return this; },
          };
          candRouter.handle(req, res, () => settle());
          await done;
          return { status: res.statusCode, body: res._body };
        };

        const mkEligible = (id: string, email: string) => {
          db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                      VALUES (?,?, 'x','test', ?, 'https://x.example.no','producer',?,1)`)
            .run(id, id, email, `key-${id}`);
          db.prepare(`INSERT INTO agent_knowledge (agent_id, email, verification_status, enrichment_status,
                        url_last_status, url_last_probed)
                      VALUES (?,?, 'verified','rich',200,datetime('now'))`).run(id, email);
        };
        mkEligible("tr-cand-clean", "ren@gaard.no");
        mkEligible("tr-cand-overlap", "overlapp2@gaard.no");

        // Baseline FIRST — an assertion that the fixture qualifies at all.
        // Without it, "the overlap producer is absent" would pass for any
        // reason, including a fixture that never made it into the pool.
        {
          const base = await getCandidates("mode=first&limit=500");
          assertEq(base.status, 200, "tr55: the candidates gate answers");
          const ids = (base.body?.candidates ?? []).map((c: any) => c.agent_id);
          assertTrue(ids.includes("tr-cand-clean"), "tr55b: the clean fixture IS a candidate…");
          assertTrue(ids.includes("tr-cand-overlap"),
            "tr55c: …and so is the overlap fixture BEFORE any cross-platform send — this is what makes tr57 meaningful rather than vacuous");
          assertEq(base.body?.cross_platform_cooldown?.count, 0,
            "tr56: …and nothing is reported as cross-platform-skipped yet");
        }

        // Now Opplevagent cold-mails one of them.
        db.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES ('tr-cand-overlap','overlapp2@gaard.no', datetime('now','-5 days'), 'email','tr-osl-3','tr','experiences')`,
        ).run();

        const after = await getCandidates("mode=first&limit=500");
        assertEq(after.status, 200, "tr56b: the gate still answers 200 — without this, every 'X is absent' below passes against an empty list");
        const ids = (after.body?.candidates ?? []).map((c: any) => c.agent_id);
        assertTrue(ids.includes("tr-cand-clean"),
          "tr57: the untouched producer is still a candidate — the skip is targeted, not a blanket");
        assertTrue(!ids.includes("tr-cand-overlap"),
          "tr57b: …and the overlap producer is skipped HERE, where the reason is still known, instead of failing one-by-one at the send path with the cause erased");

        const rep = after.body?.cross_platform_cooldown;
        assertEq(rep?.count, 1, "tr58: the campaign is told HOW MANY were skipped");
        assertEq(rep?.by_vertical?.experiences, 1, "tr58b: …broken down by the SUPPRESSING platform, which is the half 4e insists on");
        assertEq(rep?.producers?.[0]?.agent_id, "tr-cand-overlap", "tr59: …and named, so the campaign can act on them rather than only count them");
        assertEq(rep?.producers?.[0]?.suppressed_by_vertical, "experiences", "tr59b: …with the platform on the producer row too");
        assertEq(after.body?.suppressed_counts?.cross_platform_cooldown, 1,
          "tr59c: …and it appears in suppressed_counts alongside every other reason");

        // An RFB send must NOT be reported as cross-platform. A counter that
        // counts everything reports every ordinary repeat as an overlap
        // producer, which is worse than no counter — it looks like data.
        db.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES ('tr-cand-clean','ren@gaard.no', datetime('now','-5 days'), 'email','tr-osl-4','tr','rfb')`,
        ).run();
        const after2 = await getCandidates("mode=first&limit=500");
        assertEq(after2.status, 200, "tr59d: …and still answers 200 here too");
        assertEq(after2.body?.cross_platform_cooldown?.count, 1,
          "tr60: an RFB send does NOT increment the cross-platform count — it is the pool's own exclusion, not an overlap");
        assertTrue(!(after2.body?.candidates ?? []).map((c: any) => c.agent_id).includes("tr-cand-clean"),
          "tr60b: …though it does drop them from the pool, by the pre-existing rfb-scoped exclusion");

        // ── tr61-tr63: the same question in mode=second ─────────────
        //
        // tr60 alone does NOT pin the `vertical_id != 'rfb'` filter. Measured:
        // deleting that line left the whole suite green. mode=first reads
        // outreach_ready_pool, whose exclusion is already rfb-scoped, so an RFB
        // send removes the row before the cross-platform counter can ever see
        // it — the assertion was true for a reason that had nothing to do with
        // the clause under test.
        //
        // mode=second does not use the VIEW. There an RFB send inside the
        // window DOES reach the loop, and without the filter every ordinary
        // second-touch repeat would be reported as an overlap producer. That is
        // worse than no counter: a number 4e exists to produce, quietly wrong.
        {
          const second = await getCandidates("mode=second&limit=500");
          assertEq(second.status, 200, "tr61: the gate answers in mode=second");
          const rep2 = second.body?.cross_platform_cooldown;
          const named = (rep2?.producers ?? []).map((x: any) => x.agent_id);
          assertTrue(!named.includes("tr-cand-clean"),
            "tr62: an RFB send inside the window is NOT reported as cross-platform in mode=second — this is the assertion mode=first could not make");
          assertEq(rep2?.by_vertical?.rfb, undefined,
            "tr62b: …and 'rfb' never appears as a SUPPRESSING platform, because suppression by your own platform is not an overlap");
          assertTrue(named.includes("tr-cand-overlap"),
            "tr63: …while the genuine Opplevagent overlap IS still reported here, so tr62 is a filter and not a blanket zero");
        }

        // ── tr64-tr65: a database WITHOUT the steg-3 column ─────────
        //
        // vertical_id is migration-added, so every booted database has it. But
        // a hard dependency on it meant the SELECT threw and took the whole
        // gate down — measured: the orch-20260614 fixture, which hand-rolls a
        // minimal outreach_sent_log, turned the entire candidates endpoint into
        // a 500. In production that shape is an outreach OUTAGE (no candidates
        // at all) caused by a schema detail.
        //
        // It degrades instead — but it must not degrade QUIETLY. A `count: 0`
        // on a database that cannot answer the question reads as "no overlap
        // producers were skipped", which is the same silence 4e removes, moved
        // one level up.
        {
          db.exec("ALTER TABLE outreach_sent_log RENAME COLUMN vertical_id TO vertical_id_hidden");
          try {
            const degraded = await getCandidates("mode=first&limit=500");
            assertEq(degraded.status, 200,
              "tr64: without the steg-3 column the gate still SERVES — a missing migration must not become an outreach outage");
            assertEq(degraded.body?.cross_platform_cooldown?.unavailable, true,
              "tr65: …and says the number is UNAVAILABLE rather than reporting a confident 0 it did not measure");
          } finally {
            db.exec("ALTER TABLE outreach_sent_log RENAME COLUMN vertical_id_hidden TO vertical_id");
          }
          const restored = await getCandidates("mode=first&limit=500");
          assertEq(restored.body?.cross_platform_cooldown?.unavailable, undefined,
            "tr65b: …and the flag is absent again once the column is back, so it cannot be permanently stuck on");
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // tr51-tr54 — contact.ts: the last fail-open default.
      //
      // POST /api/contact is live on all three domains and is the only CRM
      // write path a stranger can reach. A PRESENT-but-unknown platform used to
      // fall silently through to host inference.
      // ═══════════════════════════════════════════════════════════════
      {
        const contactRoutes = require("../routes/contact") as any;
        const contactRouter = contactRoutes.default ?? contactRoutes;
        const submit = async (body: any, host: string): Promise<{ status: number; body: any }> => {
          const req: any = {
            method: "POST", url: "/contact", path: "/contact", query: {}, body,
            // express derives req.hostname from the Host header; a bare object
            // does not, and inferPlatform reads req.hostname.
            hostname: host,
            headers: { host },
            get(n: string) { return this.headers[n.toLowerCase()]; },
            ip: "203.0.113.44",
          };
          let settle: () => void;
          const done = new Promise<void>((r) => { settle = r; });
          const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(b: any) { this._body = b; settle(); return this; },
          };
          contactRouter.handle(req, res, () => settle());
          await done;
          return { status: res.statusCode, body: res._body };
        };

        const r = await submit({
          name: "Kari", email: "kari@example.no", subject: "TRIAGE-TR51",
          message: "Hei", platform: "opplevagent",
        }, "rettfrabonden.com");
        assertEq(r.status, 422,
          "tr51: a PRESENT but unknown platform is refused. 'opplevagent' is the exact string a form would plausibly send, and it used to fall through to host inference and file as rfb");
        assertEq(r.body?.error, "invalid_platform", "tr51b: …with a named error, not a generic one");
        assertEq(db.prepare("SELECT id FROM crm_threads WHERE subject LIKE '%TRIAGE-TR51%'").get(), undefined,
          "tr52: …and nothing was written");

        const r2 = await submit({
          name: "Ola", email: "ola@example.no", subject: "TRIAGE-TR53",
          message: "Hei", // platform ABSENT
        }, "opplevagent.no");
        assertEq(r2.status, 200, "tr53: an ABSENT platform still infers from the host — the plain form has never sent the field and must keep working");
        const t53 = db.prepare(
          "SELECT vertical_id FROM crm_threads WHERE subject LIKE '%TRIAGE-TR53%' ORDER BY rowid DESC LIMIT 1",
        ).get() as any;
        assertEq(t53?.vertical_id, "experiences", "tr53b: …and infers it correctly");

        const r4 = await submit({
          name: "Per", email: "per@example.no", subject: "TRIAGE-TR54",
          message: "Hei", platform: "experiences",
        }, "rettfrabonden.com");
        assertEq(r4.status, 200, "tr54: an explicit VALID platform still wins over the host…");
        const t54 = db.prepare(
          "SELECT vertical_id FROM crm_threads WHERE subject LIKE '%TRIAGE-TR54%' ORDER BY rowid DESC LIMIT 1",
        ).get() as any;
        assertEq(t54?.vertical_id, "experiences",
          "tr54b: …so the 422 above closed the unknown-value hole without breaking the deliberate cross-host case");
      }
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
      if (prevAdminKey2 === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey2;
      if (prevTurnstile === undefined) delete process.env.SKIP_TURNSTILE;
      else process.env.SKIP_TURNSTILE = prevTurnstile;
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCrmTriageTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
