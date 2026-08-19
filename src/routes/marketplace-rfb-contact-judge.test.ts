/**
 * marketplace-rfb-contact-judge.test.ts — tests for dev-request
 * 2026-08-19-rfb-kontakt-llm-dommer: the LLM-judge + deterministic backstop
 * gate that now stands between extractPhone()/extractEmail() (src/routes/
 * marketplace.ts) and the write path in POST /admin/homepage-provenance-batch.
 *
 * Background: platform-alerts/2026-08-17-rfb-enrichment-spotcheck-breach.md
 * (W34) — deterministic extraction alone wrote a CSS hex color
 * (`#3a7d44`-shaped), a Facebook App ID substring, and a favicon filename
 * (`favicon@2x.png`) into agent_knowledge.phone/email as if they were real
 * contact info. Daniel's decision (dev-requests/2026-08-19-kursjustering-
 * drikkefunnel-llm-og-supply.md Grep 5): stop trusting deterministic
 * extraction for phone/email entirely — every candidate must now clear BOTH
 * classifyRfbContactCandidateDefect (pure, structural backstop) AND
 * judgeRfbContactCandidate (LLM judge, given page source context) before it
 * is write-eligible. gateRfbContactCandidates is the composed entry point
 * the route actually calls.
 *
 * Mirrors two existing conventions exactly:
 *   - opplevelser-gardssalg-opening-hours-llm.test.ts's fetch-mocking
 *     convention: globalThis.fetch stubbed, dispatching on whether the URL
 *     contains "api.anthropic.com" (LLM judge calls) vs. a page hostname
 *     (homepage HTML fetch); ANTHROPIC_API_KEY and globalThis.fetch are
 *     saved/restored around each section.
 *   - homepage-provenance-email-backfill.test.ts's route-level fixture setup
 *     for POST /admin/homepage-provenance-batch: an in-memory better-sqlite3
 *     DB injected via __setDbForTesting/__initSchemaForTesting, the router
 *     required fresh so it picks up the injected DB, and assertions read
 *     agent_knowledge columns directly rather than any per-agent response
 *     field (the route's JSON response is aggregate-only).
 *
 * Sections:
 *   A. classifyRfbContactCandidateDefect — pure, no mocks. Reproduces the
 *      email-side W34 mismatch shape (favicon filename) plus the phone-side
 *      checks that are ACTUALLY reachable through the real
 *      extractPhone -> classifyRfbContactCandidateDefect pipeline (a long
 *      repeated-digit run, a sequential ascending/descending digit run),
 *      plus normal-looking phone/email that must NOT be flagged.
 *
 *      Code-review follow-up (2026-08-19, confirmed defect, pre-merge): the
 *      phone-side checks ORIGINALLY here were "#3a7d44"/"314192535267336"
 *      hand-picked fixtures calling classifyRfbContactCandidateDefect
 *      directly — inputs that can NEVER actually reach the classifier
 *      through the real pipeline, because extractPhone() can only ever
 *      return `null` or a value already forced through normalisePhone()'s
 *      `.replace(/\D/g, "")` + exact-length-8 filter, i.e. EXACTLY 8 `\d`
 *      characters, never a hex letter/'#'/15-16-digit-length value. Those
 *      fixtures (and the two dead phone checks they exercised) are REMOVED
 *      here, not merely relabeled — see the block comment directly above
 *      classifyRfbContactCandidateDefect in marketplace.ts for the full
 *      "why", and Section E below for the honest replacement: an actual
 *      end-to-end test proving the LLM judge (not this classifier) is what
 *      catches the CSS-hex-color W34 shape for phone.
 *   B. judgeRfbContactCandidate — direct unit tests of the fail-closed
 *      fetch contract (missing key / network throw / non-200 / unparseable
 *      JSON / a clean approval).
 *   C. gateRfbContactCandidates — composition: backstop-rejected candidates
 *      never reach the LLM call at all (cost control); judge-rejected
 *      candidates that cleared the backstop still end up null.
 *   D. End-to-end via the real POST /admin/homepage-provenance-batch route:
 *      a judge-rejected phone candidate is never written to
 *      agent_knowledge.phone/field_provenance — reported exactly like "no
 *      candidate found" — while an approved candidate on the SAME run still
 *      writes normally (regression guard), and a missing ANTHROPIC_API_KEY
 *      fails the whole gate closed for a candidate that would otherwise have
 *      been written.
 *   E. End-to-end, REAL W34 CSS-hex-color shape via the real route: a page
 *      with a visible "background-color: #3a7d44"-style text block sitting
 *      near an otherwise plausible phone-shaped digit run. extractPhone()
 *      (real, unmocked) extracts the 8-digit candidate; the deterministic
 *      backstop clears it (correctly — it is 8 plain digits, not a
 *      repeated/sequential run); the mocked LLM judge is what rejects it,
 *      demonstrating the judge is the actual, reachable, verified line of
 *      defense for this attack shape on the phone side — not the backstop.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  classifyRfbContactCandidateDefect,
  judgeRfbContactCandidate,
  gateRfbContactCandidates,
} from "./marketplace";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runMarketplaceRfbContactJudgeTests(
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
    // ═══════════════════════════════════════════════════════════════════
    // Section A — classifyRfbContactCandidateDefect (pure, no mocks).
    // ═══════════════════════════════════════════════════════════════════
    try {
      // ── Reachable phone backstop check #1: long repeated-digit run ─────
      // A partial (not full-8) run of the same digit repeated >= 6 times —
      // e.g. "23222222" (six 2's). Reachable: extractPhone()'s output is
      // always exactly 8 raw digits, and this check runs on exactly that
      // shape (unlike the removed hex/App-ID checks — see the file-header
      // comment above for why those were dead code and were removed).
      const repeatedRunVerdict = classifyRfbContactCandidateDefect("phone", "23222222");
      assertEq(repeatedRunVerdict.defective, true, "a-1: 8-digit candidate with a 6+ repeated-digit run -> defective");
      assertTrue(
        /repeat/i.test(repeatedRunVerdict.reason ?? ""),
        "a-2: reason mentions the repeated-digit run",
      );
      // A short (5-in-a-row) repeat stays under the threshold -> NOT flagged.
      const shortRepeatVerdict = classifyRfbContactCandidateDefect("phone", "23222212");
      assertEq(shortRepeatVerdict.defective, false, "a-3: an 8-digit candidate with only a 5-run repeat -> NOT defective (below threshold)");

      // ── Reachable phone backstop check #2: sequential digit run ────────
      const ascendingVerdict = classifyRfbContactCandidateDefect("phone", "23456789");
      assertEq(ascendingVerdict.defective, true, "a-4: strictly ascending 8-digit run -> defective");
      assertTrue(
        /sequential/i.test(ascendingVerdict.reason ?? ""),
        "a-5: reason mentions the sequential run",
      );
      const descendingVerdict = classifyRfbContactCandidateDefect("phone", "98765432");
      assertEq(descendingVerdict.defective, true, "a-6: strictly descending 8-digit run -> also defective");

      // ── Honesty check: the CSS-hex-color and Facebook-App-ID W34 shapes
      //    are UNREACHABLE for phone through classifyRfbContactCandidateDefect
      //    (extractPhone() can never hand it a hex letter, a '#', or a
      //    15/16-digit-length value — see marketplace.ts's block comment
      //    above classifyRfbContactCandidateDefect). This classifier
      //    correctly does NOT special-case those shapes any more; Section E
      //    below proves the LLM judge is what actually catches this attack
      //    shape end-to-end. ─────────────────────────────────────────────

      // ── W34 mismatch (LOKAL Matkvartalet Hamar): favicon filename ──────
      const faviconVerdict = classifyRfbContactCandidateDefect("email", "favicon@2x.png");
      assertEq(faviconVerdict.defective, true, "a-7: 'favicon@2x.png' as an email candidate -> defective");
      assertTrue(
        /favicon|icon/i.test(faviconVerdict.reason ?? ""),
        "a-8: reason mentions favicon/icon",
      );
      const appleTouchIconVerdict = classifyRfbContactCandidateDefect("email", "apple-touch-icon@180x180.png");
      assertEq(appleTouchIconVerdict.defective, true, "a-9: another icon-filename-derived candidate -> also defective");

      // ── Normal, legitimate candidates must NOT be flagged ───────────────
      const normalPhone8 = classifyRfbContactCandidateDefect("phone", "92345678");
      assertEq(normalPhone8.defective, false, "a-10: a plain 8-digit Norwegian phone number -> NOT defective");
      const normalPhonePlus47 = classifyRfbContactCandidateDefect("phone", "+47 400 12 345");
      assertEq(normalPhonePlus47.defective, false, "a-11: a +47-prefixed phone number -> NOT defective");
      const normalEmail = classifyRfbContactCandidateDefect("email", "kontakt@gardsbutikk.no");
      assertEq(normalEmail.defective, false, "a-12: a normal-looking email -> NOT defective");

      // ── Additional email structural guards (defense-in-depth, not part of
      //    the three W34 fixtures but the same "does this even parse as an
      //    email" backstop). ──────────────────────────────────────────────
      assertEq(classifyRfbContactCandidateDefect("email", "not-an-email").defective, true, "a-13: no '@' at all -> defective");
      assertEq(classifyRfbContactCandidateDefect("email", "").defective, false, "a-14: empty candidate -> not defective (blank is fill-only's job, not this classifier's)");
    } catch (err: any) {
      failed++;
      failures.push("marketplace-rfb-contact-judge (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — judgeRfbContactCandidate direct unit tests.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        const CANDIDATE = "92345678";
        const CONTEXT = "Kontakt oss: Ring oss på 92 34 56 78 mandag til fredag.";
        const BUSINESS = "Testgard AS";

        // ── b-1: missing ANTHROPIC_API_KEY -> approved:false, fetch NEVER
        //    invoked. ──────────────────────────────────────────────────────
        delete process.env.ANTHROPIC_API_KEY;
        globalThis.fetch = (async () => {
          throw new Error("b-1: fetch must NOT be called when ANTHROPIC_API_KEY is missing");
        }) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-1: missing ANTHROPIC_API_KEY -> approved:false");
        }

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── b-2: network throw -> approved:false, not re-thrown. ───────────
        globalThis.fetch = (async () => {
          throw new Error("simulated network failure");
        }) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-2: fetch throw (network failure) -> approved:false, not re-thrown");
        }

        // ── b-3: non-200 response -> approved:false. ───────────────────────
        globalThis.fetch = (async () => ({
          ok: false, status: 500, json: async () => ({ error: "boom" }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-3: non-200 response -> approved:false");
        }

        // ── b-4: unparseable JSON body -> approved:false. ──────────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => { throw new Error("not json"); },
        })) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-4: unparseable JSON response body -> approved:false");
        }

        // ── b-5: non-array content field -> approved:false, never throws. ──
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => ({ content: { unexpected: "shape" } }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-5: non-array content field -> approved:false, not a thrown TypeError");
        }

        // ── b-6: ambiguous / garbage first line -> approved:false. ─────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hmm, maybe?" }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-6: ambiguous/non-token model output -> approved:false, fail-closed");
        }

        // ── b-7: a clean, valid candidate with supportive source context,
        //    mocked GODKJENN -> approved:true. Also asserts the request
        //    contract: endpoint, model, x-api-key header, and that the
        //    prompt teaches the model the known bad-candidate shapes. ──────
        let capturedUrl: any = null;
        let capturedInit: any = null;
        globalThis.fetch = (async (url: any, init: any) => {
          capturedUrl = url;
          capturedInit = init;
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nDette er et ekte telefonnummer for produsenten." }] }),
          };
        }) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, true, "b-7a: clean candidate + GODKJENN mock -> approved:true");
          assertEq(String(capturedUrl), "https://api.anthropic.com/v1/messages", "b-7b: calls the exact Anthropic messages endpoint");
          const body = JSON.parse(capturedInit.body);
          assertEq(body.model, "claude-haiku-4-5", "b-7c: model is claude-haiku-4-5");
          const prompt: string = body.messages[0].content;
          assertTrue(prompt.includes(BUSINESS), "b-7d: prompt includes the business name");
          assertTrue(prompt.includes(CANDIDATE), "b-7e: prompt includes the candidate value");
          assertTrue(prompt.includes(CONTEXT), "b-7f: prompt includes the source context");
          assertTrue(/hex|farge/i.test(prompt), "b-7g: prompt teaches the CSS-hex-color failure mode");
          assertTrue(/app id|facebookappid|fbappid/i.test(prompt), "b-7h: prompt teaches the Facebook App ID failure mode");
          assertTrue(/favicon/i.test(prompt), "b-7i: prompt teaches the favicon-filename failure mode");
          assertEq(capturedInit.headers["x-api-key"], "test-anthropic-key", "b-7j: x-api-key header carries ANTHROPIC_API_KEY");
        }

        // ── b-8: source context capped to a reasonable length in the prompt
        //    (not passed through unbounded). ────────────────────────────────
        {
          const hugeContext = "y".repeat(20000);
          await judgeRfbContactCandidate({
            fieldType: "email", candidate: "kontakt@gardsbutikk.no", sourceContext: hugeContext, businessName: BUSINESS,
          });
          const body = JSON.parse(capturedInit.body);
          const yRunLength = (body.messages[0].content.match(/y+/g) || [""]).sort((a: string, b: string) => b.length - a.length)[0]?.length ?? 0;
          assertTrue(yRunLength <= 4000, "b-8: source context is capped (<= 4000 chars) in the prompt, not passed through unbounded");
        }

        // ── b-9: reject-token mock -> approved:false with a reason. ─────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette ser ut som en CSS-fargekode, ikke et telefonnummer." }] }),
        })) as unknown as typeof fetch;
        {
          const v = await judgeRfbContactCandidate({
            fieldType: "phone", candidate: CANDIDATE, sourceContext: CONTEXT, businessName: BUSINESS,
          });
          assertEq(v.approved, false, "b-9a: AVVIS mock -> approved:false");
          assertTrue(!!v.reason && v.reason.length > 0, "b-9b: rejection carries a reason");
        }
      } catch (err: any) {
        failed++;
        failures.push("marketplace-rfb-contact-judge (section B): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        globalThis.fetch = prevFetch;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — gateRfbContactCandidates composition.
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      try {
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

        // ── c-1: a backstop-rejected phone candidate never reaches the LLM
        //    call at all (cost control) — fetch throws if invoked.
        //    Code-review follow-up (2026-08-19, confirmed defect): uses a
        //    sequential-digit-run candidate ("23456789"), a shape
        //    classifyRfbContactCandidateDefect can ACTUALLY reach through the
        //    real extractPhone -> gateRfbContactCandidates pipeline — NOT the
        //    old "#3a7d44" hex-shaped fixture, which extractPhone() can never
        //    produce (see the phone-side block comment in marketplace.ts
        //    above classifyRfbContactCandidateDefect, and Section A above). ──
        globalThis.fetch = (async () => {
          throw new Error("c-1: judge must NOT be called for a backstop-rejected candidate");
        }) as unknown as typeof fetch;
        {
          const g = await gateRfbContactCandidates({
            producerName: "Austrått Kaffebrenneri",
            sourceContext: "some page text",
            candidatePhone: "23456789",
            candidateEmail: null,
          });
          assertEq(g.phone, null, "c-1a: sequential-digit-run phone candidate -> gated phone is null");
          assertTrue(!!g.phoneRejectedReason && /backstop/i.test(g.phoneRejectedReason), "c-1b: rejection reason attributes this to the backstop classifier");
        }

        // ── c-2: a candidate that clears the backstop but is rejected by the
        //    LLM judge -> null, with a judge-attributed reason. ─────────────
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "AVVIS\nSer ut som sidestøy, ikke et telefonnummer for denne produsenten." }] }),
        })) as unknown as typeof fetch;
        {
          const g = await gateRfbContactCandidates({
            producerName: "Li Lynghonning",
            sourceContext: "some page text",
            candidatePhone: "92345678",
            candidateEmail: null,
          });
          assertEq(g.phone, null, "c-2a: LLM-rejected (but structurally clean) phone candidate -> gated phone is null");
          assertTrue(!!g.phoneRejectedReason && /llm judge/i.test(g.phoneRejectedReason), "c-2b: rejection reason attributes this to the LLM judge");
        }

        // ── c-3: a candidate that clears BOTH -> passed through verbatim. ──
        globalThis.fetch = (async () => ({
          ok: true, status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }] }),
        })) as unknown as typeof fetch;
        {
          const g = await gateRfbContactCandidates({
            producerName: "Testgard AS",
            sourceContext: "Ring oss på 92 34 56 78",
            candidatePhone: "92345678",
            candidateEmail: "post@testgard.no",
          });
          assertEq(g.phone, "92345678", "c-3a: candidate clearing both gates -> phone passed through");
          assertEq(g.email, "post@testgard.no", "c-3b: candidate clearing both gates -> email passed through");
          assertEq(g.phoneRejectedReason, undefined, "c-3c: no rejection reason on an approved candidate");
        }

        // ── c-4: an email backstop-rejected (favicon) while phone is null
        //    (no candidate at all) -> both null, only email carries a
        //    rejection reason, and the judge is never called for either. ──
        globalThis.fetch = (async () => {
          throw new Error("c-4: judge must NOT be called — email is backstop-rejected and phone has no candidate");
        }) as unknown as typeof fetch;
        {
          const g = await gateRfbContactCandidates({
            producerName: "LOKAL Matkvartalet Hamar",
            sourceContext: "some page text",
            candidatePhone: null,
            candidateEmail: "favicon@2x.png",
          });
          assertEq(g.phone, null, "c-4a: no phone candidate -> gated phone is null, no reason");
          assertEq(g.phoneRejectedReason, undefined, "c-4b: no phone rejection reason when there was no candidate to begin with");
          assertEq(g.email, null, "c-4c: favicon-shaped email candidate -> gated email is null");
          assertTrue(!!g.emailRejectedReason && /backstop/i.test(g.emailRejectedReason), "c-4d: email rejection reason attributes this to the backstop classifier");
        }
      } catch (err: any) {
        failed++;
        failures.push("marketplace-rfb-contact-judge (section C): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        globalThis.fetch = prevFetch;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section D — end-to-end via the real POST /admin/homepage-provenance-
    // batch route: a judge-rejected candidate is never written/persisted,
    // and the run's other, approved candidate on the SAME batch still
    // writes normally (regression guard + per-agent independence).
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevDb = initMod.getDb();
      const testKey = process.env.ADMIN_KEY || "marketplace-rfb-contact-judge-test-key";
      const prevAdminKey = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testKey;
      const prevFetch = (globalThis as any).fetch;
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

      const db = new Database(":memory:");
      try {
        initMod.__setDbForTesting(db as any);
        initMod.__initSchemaForTesting(db as any);

        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
        );
        insertAgent.run("agent-approved", "Testgard AS", "https://testgard.no", "key-1");
        insertAgent.run("agent-phone-rejected", "Mistenktgard AS", "https://mistenktgard.no", "key-2");
        insertAgent.run("agent-no-candidate", "Ingenkandidatgard AS", "https://ingenkandidatgard.no", "key-3");

        const insertKnowledge = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, about, field_provenance)
           VALUES (?, ?, NULL, NULL, NULL, 'A test farm shop', '{}')`,
        );
        insertKnowledge.run("agent-approved", "https://testgard.no");
        insertKnowledge.run("agent-phone-rejected", "https://mistenktgard.no");
        insertKnowledge.run("agent-no-candidate", "https://ingenkandidatgard.no");

        delete require.cache[require.resolve("./marketplace")];
        const marketplaceMod = require("./marketplace");
        const router = marketplaceMod.default;

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key-route";
        const anthropicPromptsSeen: string[] = [];

        (globalThis as any).fetch = async (url: string, init?: any) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            const body = init?.body ? JSON.parse(init.body) : {};
            const prompt: string = body?.messages?.[0]?.content ?? "";
            anthropicPromptsSeen.push(prompt);
            if (prompt.includes("Mistenktgard AS") && prompt.includes("Kandidat (telefonnummer)")) {
              // The judge sees this exact candidate/context and rejects it —
              // simulating the LLM catching what the backstop's conservative
              // shape check alone would miss.
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: "AVVIS\nDette matcher ikke et ekte telefonnummer for denne produsenten i kildekonteksten." }] }),
              } as any;
            }
            // Every other judge call this run (Testgard's phone+email,
            // Mistenktgard's email) is approved.
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte, spesifikk kontaktinfo for produsenten." }] }),
            } as any;
          }
          let html = "";
          if (urlStr.includes("testgard.no")) {
            html = `<html><head><title>Testgard AS</title></head><body>
              <h1>Testgard AS</h1>
              <p>Velkommen til Testgard! Ring oss på 92 34 56 78 eller send e-post.</p>
              <a href="mailto:post@testgard.no">post@testgard.no</a>
            </body></html>`;
          } else if (urlStr.includes("mistenktgard.no")) {
            html = `<html><head><title>Mistenktgard AS</title></head><body>
              <h1>Mistenktgard AS</h1>
              <p>Kontakt oss: Ring oss på 92 34 56 79 eller send e-post.</p>
              <a href="mailto:post@mistenktgard.no">post@mistenktgard.no</a>
            </body></html>`;
          } else if (urlStr.includes("ingenkandidatgard.no")) {
            html = `<html><head><title>Ingenkandidatgard AS</title></head><body>
              <h1>Ingenkandidatgard AS</h1>
              <p>Velkommen til gården vår. Ta kontakt for mer informasjon.</p>
            </body></html>`;
          }
          return { ok: true, status: 200, text: async () => html } as any;
        };

        const result = await callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body: { agentIds: ["agent-approved", "agent-phone-rejected", "agent-no-candidate"] },
        });
        assertEq(result.status, 200, "d-1: POST /admin/homepage-provenance-batch -> 200");

        // ── d-2: the approved agent's phone AND email are written normally
        //    (regression guard: the gate doesn't break the existing happy
        //    path when both the backstop and the LLM judge approve). ───────
        const rowApproved = db
          .prepare("SELECT phone, email, field_provenance FROM agent_knowledge WHERE agent_id = ?")
          .get("agent-approved") as { phone: string | null; email: string | null; field_provenance: string };
        assertEq(rowApproved.phone, "92345678", "d-2a: agent-approved: phone written (both gates approved)");
        assertEq(rowApproved.email, "post@testgard.no", "d-2b: agent-approved: email written (both gates approved)");
        const provApproved = JSON.parse(rowApproved.field_provenance);
        assertTrue(!!provApproved.phone, "d-2c: agent-approved: field_provenance carries a phone source");
        assertTrue(!!provApproved.email, "d-2d: agent-approved: field_provenance carries an email source");

        // ── d-3: the LLM-rejected phone candidate is NEVER written to the
        //    column NOR to field_provenance — reported exactly like "no
        //    candidate found" — while the SAME agent's independently-
        //    approved email still writes (per-field independence). ────────
        const rowRejected = db
          .prepare("SELECT phone, email, field_provenance FROM agent_knowledge WHERE agent_id = ?")
          .get("agent-phone-rejected") as { phone: string | null; email: string | null; field_provenance: string };
        assertEq(rowRejected.phone, null, "d-3a: agent-phone-rejected: phone column stays NULL — the rejected candidate was never written");
        const provRejected = JSON.parse(rowRejected.field_provenance);
        assertTrue(!provRejected.phone, "d-3b: agent-phone-rejected: field_provenance carries NO phone source either — treated exactly like extractPhone() finding nothing");
        assertEq(rowRejected.email, "post@mistenktgard.no", "d-3c: agent-phone-rejected: the SAME agent's independently-approved email still writes normally");

        // ── d-4: no-yield agent (no phone/email/address found on the page
        //    at all) never triggers a judge call — cost control preserved
        //    end-to-end, not just in the gateRfbContactCandidates unit
        //    tests above. ──────────────────────────────────────────────────
        assertTrue(
          !anthropicPromptsSeen.some((p) => p.includes("Ingenkandidatgard AS")),
          "d-4: no-candidate agent never triggers an Anthropic judge call",
        );

        const byField = result.body?.data?.by_field ?? {};
        assertEq(byField.phone, 1, "d-5a: by_field.phone counts only the ONE agent whose phone actually got written (agent-approved)");
        assertEq(byField.email, 2, "d-5b: by_field.email counts both agents whose email got written");
      } catch (err: any) {
        failed++;
        failures.push("marketplace-rfb-contact-judge (section D, approved+rejected): unexpected error: " + String(err?.stack || err?.message || err));
      }

      // ── d-6: missing ANTHROPIC_API_KEY end-to-end — a candidate that
      //    would otherwise pass the backstop AND be approved by the judge
      //    is still never written, because the judge fails closed the
      //    instant the key is absent; the Anthropic endpoint is never even
      //    reached. ────────────────────────────────────────────────────────
      try {
        delete process.env.ANTHROPIC_API_KEY;
        let anthropicCalledDuringKeylessRun = false;
        (globalThis as any).fetch = async (url: string) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            anthropicCalledDuringKeylessRun = true;
            throw new Error("d-6: Anthropic endpoint must never be reached with no ANTHROPIC_API_KEY");
          }
          const html = `<html><head><title>Testgard AS</title></head><body>
            <h1>Testgard AS</h1>
            <p>Velkommen til Testgard! Ring oss på 92 34 56 78 eller send e-post.</p>
            <a href="mailto:post@testgard.no">post@testgard.no</a>
          </body></html>`;
          return { ok: true, status: 200, text: async () => html } as any;
        };

        delete require.cache[require.resolve("./marketplace")];
        const marketplaceMod2 = require("./marketplace");
        const router2 = marketplaceMod2.default;

        // Reset the fixture's already-written state isn't needed — this is
        // a FRESH agent so the write, if it happened, would be unambiguous.
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
        ).run("agent-no-key", "Testgard AS", "https://testgard.no", "key-4");
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, about, field_provenance)
           VALUES (?, ?, NULL, NULL, NULL, 'A test farm shop', '{}')`,
        ).run("agent-no-key", "https://testgard.no");

        const result2 = await callRoute(router2, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body: { agentIds: ["agent-no-key"] },
        });
        assertEq(result2.status, 200, "d-6a: apply call with no ANTHROPIC_API_KEY -> still 200 (fails closed, not an error)");
        assertEq(anthropicCalledDuringKeylessRun, false, "d-6b: the Anthropic endpoint is never called when ANTHROPIC_API_KEY is absent");
        const rowNoKey = db
          .prepare("SELECT phone, email FROM agent_knowledge WHERE agent_id = ?")
          .get("agent-no-key") as { phone: string | null; email: string | null };
        assertEq(rowNoKey.phone, null, "d-6c: phone stays NULL with no ANTHROPIC_API_KEY, even though the page has a perfectly valid-looking phone");
        assertEq(rowNoKey.email, null, "d-6d: email stays NULL with no ANTHROPIC_API_KEY, even though the page has a perfectly valid-looking mailto:");
      } catch (err: any) {
        failed++;
        failures.push("marketplace-rfb-contact-judge (section D, missing key): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        (globalThis as any).fetch = prevFetch;
        initMod.__setDbForTesting(prevDb);
        if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
        delete require.cache[require.resolve("./marketplace")];
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section E — REAL end-to-end reproduction of the W34 CSS-hex-color
    // shape via the actual route, proving which component actually catches
    // it for phone.
    //
    // Code-review follow-up (2026-08-19, confirmed defect, pre-merge): the
    // PR originally claimed "two independent gates" catch the CSS-hex-color
    // W34 shape for phone, but only ever demonstrated that with a direct
    // classifyRfbContactCandidateDefect("phone", "#3a7d44") call — an input
    // that can never actually reach the classifier through the real
    // extractPhone -> gateRfbContactCandidates pipeline (extractPhone()'s
    // output is always exactly 8 raw `\d` characters; see the block comment
    // above classifyRfbContactCandidateDefect in marketplace.ts). This
    // section drives the REAL, unmocked extractPhone() with a fixture page
    // shaped like the actual breach — a visible "background-color:
    // #3a7d44"-style text block sitting near an otherwise plausible
    // phone-shaped digit run — through the REAL route, and proves:
    //   (e-1) extractPhone() genuinely extracts a candidate here (this
    //         fixture is not a no-op / doesn't silently yield nothing);
    //   (e-2) the deterministic backstop clears it (correctly — "92345678"
    //         is 8 plain digits, not a repeated/sequential run, so
    //         classifyRfbContactCandidateDefect has nothing to flag);
    //   (e-3) the mocked LLM judge is the one that rejects it, and the
    //         final route-level write is blocked exactly like "no candidate
    //         found" — i.e. for THIS attack shape, on the phone side, the
    //         LLM judge is the real, reachable, verified line of defense,
    //         not the deterministic backstop (which is honestly rescoped
    //         to a different, but genuinely reachable, class of junk —
    //         see Section A above).
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevDb = initMod.getDb();
      const testKey = process.env.ADMIN_KEY || "marketplace-rfb-contact-judge-test-key";
      const prevAdminKey = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testKey;
      const prevFetch = (globalThis as any).fetch;
      const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

      const db = new Database(":memory:");
      try {
        initMod.__setDbForTesting(db as any);
        initMod.__initSchemaForTesting(db as any);

        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
        ).run("agent-css-hex", "Fargekodegard AS", "https://fargekodegard.no", "key-e1");
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, about, field_provenance)
           VALUES (?, ?, NULL, NULL, NULL, 'A test farm shop', '{}')`,
        ).run("agent-css-hex", "https://fargekodegard.no");

        delete require.cache[require.resolve("./marketplace")];
        const marketplaceMod = require("./marketplace");
        const router = marketplaceMod.default;

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key-e";
        let judgeCalledWithPhoneCandidate: string | null = null;
        let judgeSawCssHexContext = false;

        (globalThis as any).fetch = async (url: string, init?: any) => {
          const urlStr = String(url);
          if (urlStr.includes("api.anthropic.com")) {
            const body = init?.body ? JSON.parse(init.body) : {};
            const prompt: string = body?.messages?.[0]?.content ?? "";
            if (prompt.includes("Kandidat (telefonnummer)")) {
              const m = prompt.match(/Kandidat \(telefonnummer\): (\S+)/);
              judgeCalledWithPhoneCandidate = m ? m[1] : "<unparsed>";
              // The candidate reached the judge WITH the page's CSS-hex
              // context intact in the prompt (proving the judge — not the
              // backstop — is the component with the information needed to
              // catch this).
              judgeSawCssHexContext = /background-color:\s*#3a7d44/i.test(prompt);
              return {
                ok: true, status: 200,
                json: async () => ({
                  content: [{
                    type: "text",
                    text: "AVVIS\nKandidaten ligger rett ved en CSS-fargekode (background-color) i kildeteksten og ser ut som feilaktig sidestøy, ikke et ekte telefonnummer for denne produsenten.",
                  }],
                }),
              } as any;
            }
            // Any other judge call this run (there shouldn't be one — this
            // fixture has no email candidate) is approved so a bug elsewhere
            // doesn't masquerade as this test passing.
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nOK." }] }),
            } as any;
          }
          // The real fixture page: a visible (non-<style>, non-<script>)
          // text block carrying the CSS-hex-color W34 signature immediately
          // next to a "Ring oss på <8 digits>" contact-labeled phone shape,
          // so extractPhone()'s REAL, unmocked regex + context checks (see
          // hasPhoneContext etc. in marketplace.ts) genuinely extract
          // "92345678" as a candidate.
          const html = `<html><head><title>Fargekodegard AS</title></head><body>
            <h1>Fargekodegard AS</h1>
            <p>Nettsidens fargekode er background-color: #3a7d44 for hovedmenyen.
               Kontakt oss: Ring oss på 92 34 56 78 mandag til fredag.</p>
          </body></html>`;
          return { ok: true, status: 200, text: async () => html } as any;
        };

        const result = await callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body: { agentIds: ["agent-css-hex"] },
        });
        assertEq(result.status, 200, "e-0: POST /admin/homepage-provenance-batch -> 200");

        // (e-1) extractPhone() genuinely produced a candidate from this
        // fixture, and it reached the judge — this is not a fixture that
        // silently yields nothing (which would make the rest of this test
        // vacuous).
        assertEq(judgeCalledWithPhoneCandidate, "92345678", "e-1: extractPhone() (real, unmocked) extracted \"92345678\" from the fixture and it reached judgeRfbContactCandidate");
        assertTrue(judgeSawCssHexContext, "e-1b: the judge's prompt carried the page's CSS-hex-color context (background-color: #3a7d44) alongside the candidate");

        // (e-2) the deterministic backstop did NOT reject it on its own —
        // proven indirectly: classifyRfbContactCandidateDefect is pure and
        // already unit-tested in Section A to pass plain 8-digit, non-
        // repeated/non-sequential candidates ("92345678" is neither), and
        // gateRfbContactCandidates only calls the judge at all when the
        // backstop clears first (Section C, c-1) — so judgeCalledWithPhoneCandidate
        // being set at all here is itself proof the backstop passed this
        // candidate through.
        assertEq(
          classifyRfbContactCandidateDefect("phone", "92345678").defective,
          false,
          "e-2: the backstop classifier, called directly on the same candidate, confirms it clears (defective:false) — the judge is what catches this, not the backstop",
        );

        // (e-3) the final route-level write is blocked exactly like "no
        // candidate found".
        const row = db
          .prepare("SELECT phone, field_provenance FROM agent_knowledge WHERE agent_id = ?")
          .get("agent-css-hex") as { phone: string | null; field_provenance: string };
        assertEq(row.phone, null, "e-3a: phone column stays NULL — the LLM-judge-rejected CSS-hex-adjacent candidate was never written");
        const prov = JSON.parse(row.field_provenance);
        assertTrue(!prov.phone, "e-3b: field_provenance carries no phone source either — treated exactly like extractPhone() finding nothing");
      } catch (err: any) {
        failed++;
        failures.push("marketplace-rfb-contact-judge (section E, CSS-hex-color e2e): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        (globalThis as any).fetch = prevFetch;
        initMod.__setDbForTesting(prevDb);
        if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey;
        if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
        delete require.cache[require.resolve("./marketplace")];
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMarketplaceRfbContactJudgeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
