/**
 * admin-crm-reply-send.test.ts — dev-request
 * 2026-11-23-crm-send-dobbeltsending-og-tydelig-kvittering, AC1.
 *
 * Incident 2026-11-23: in the admin-CRM thread view, Send → confirm() → OK,
 * and the confirm dialog came up AGAIN although the mail had gone out.
 * Root cause: the page's capture-phase `blur` listener ran dispatchAction()
 * for EVERY element with a data-action — including the Send button. The
 * dialog takes focus from the button, the button blurs, and sendReply() ran
 * a second time.
 *
 * admin-crm.html is a static page with inline JS and there is no DOM
 * harness in this suite, so — like admin-crm-compose-vertical.test.ts —
 * this reads the page source. Unlike a pure regex guard, it EXECUTES the two
 * marked blocks (`<dispatch-core>` and `<reply-send-core>`) in a vm
 * sandbox with stubbed confirm/POST, so the behaviour itself is tested:
 *
 *   d1-d4  click then blur on the Send button dispatches sendReply exactly
 *          once; blur on a notes textarea still autosaves; blur on another
 *          button (sendCompose / approveProposal) dispatches nothing.
 *   r1-r8  one press with OK = one confirm(), one POST, and a receipt
 *          «Sendt HH:MM til <mottaker>»; a second press while the first is
 *          in flight shows no dialog and makes no request; the form is locked
 *          during the request and unlocked after.
 *   r9-r12 cancel → no POST; server error → readable reason (409
 *          duplicate_send names the existing message id), unlocked, and a
 *          new press is possible again.
 *   s1-s3  the page wires sendReply through runReplySend and renders the
 *          receipt inside the thread's compose box.
 *
 * Standalone: npx tsx src/routes/admin-crm-reply-send.test.ts
 * Wired into tests/test.ts.
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function extractBlock(html: string, marker: string): string {
  const m = html.match(new RegExp(`// <${marker}>([\\s\\S]*?)// </${marker}>`));
  if (!m) throw new Error(`marker block <${marker}> not found in admin-crm.html`);
  return m[1];
}

export async function runAdminCrmReplySendTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log !== false;
  const summary: TestSummary = { passed: 0, failed: 0, failures: [] };
  const check = (name: string, cond: boolean) => {
    if (cond) {
      summary.passed++;
      if (log) console.log(`  ✓ ${name}`);
    } else {
      summary.failed++;
      summary.failures.push(name);
      if (log) console.error(`  ✗ ${name}`);
    }
  };

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin-crm.html"), "utf8");

  // ── Dispatcher: the root cause ──────────────────────────────────────
  {
    const calls: string[] = [];
    const body = { tag: "body" };
    const ctx: any = {
      document: { body },
      ACTIONS: {
        sendReply: (id: string) => calls.push(`sendReply:${id}`),
        sendCompose: () => calls.push("sendCompose"),
        approveProposal: (id: string) => calls.push(`approveProposal:${id}`),
        saveThreadNotes: (id: string) => calls.push(`saveThreadNotes:${id}`),
      },
    };
    vm.createContext(ctx);
    vm.runInContext(extractBlock(html, "dispatch-core") + "\nthis.dispatchAction = dispatchAction;", ctx);
    const el = (action: string, id = "t1") => ({ dataset: { action, id }, value: undefined, parentElement: body });
    const sendBtn = el("sendReply");

    // Exactly what the browser does: click on the button, then — when the
    // confirm() dialog opens — a blur on that same button.
    ctx.dispatchAction({ target: sendBtn }, "click");
    ctx.dispatchAction({ target: sendBtn }, "blur");
    check("d1: click + blur on the Send button dispatches sendReply exactly once (root cause of the double dialog)",
      JSON.stringify(calls) === JSON.stringify(["sendReply:t1"]));

    calls.length = 0;
    ctx.dispatchAction({ target: el("saveThreadNotes") }, "blur");
    check("d2: blur on the thread-notes textarea still autosaves", JSON.stringify(calls) === JSON.stringify(["saveThreadNotes:t1"]));

    calls.length = 0;
    ctx.dispatchAction({ target: el("sendCompose") }, "blur");
    ctx.dispatchAction({ target: el("approveProposal", "rp-1") }, "blur");
    check("d3: blur on the other send buttons (new e-mail / approve proposal) dispatches nothing", calls.length === 0);

    calls.length = 0;
    // A click on a child node (the spinner span) walks up to the button.
    ctx.dispatchAction({ target: { dataset: {}, parentElement: sendBtn } }, "click");
    check("d4: a click on a child of the Send button still dispatches sendReply once", JSON.stringify(calls) === JSON.stringify(["sendReply:t1"]));
  }

  // ── runReplySend: one press = one dialog = one POST ──────────────────
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(
    extractBlock(html, "reply-send-core") +
      "\nthis.runReplySend = runReplySend; this.formatSendReceipt = formatSendReceipt; this.describeSendError = describeSendError;",
    ctx,
  );

  function makeDeps(postImpl: (path: string, payload: any) => Promise<any>, confirmAnswer = true) {
    const rec = { confirms: 0, posts: [] as Array<{ path: string; payload: any }>, locks: 0, unlocks: 0, lockedDuringPost: false };
    let locked = false;
    const deps = {
      inFlight: new Set<string>(),
      confirm: () => { rec.confirms++; return confirmAnswer; },
      post: (p: string, payload: any) => { rec.posts.push({ path: p, payload }); rec.lockedDuringPost = locked; return postImpl(p, payload); },
      lock: () => { rec.locks++; locked = true; },
      unlock: () => { rec.unlocks++; locked = false; },
      now: () => new Date(2026, 10, 23, 17, 33, 31),
    };
    return { deps, rec };
  }
  const input = { to: "hallo@solvanggard.com", subject: "Re: Hei", body: "Takk for svar!", mode: "resend_send" };

  {
    let release: (v: any) => void = () => {};
    const { deps, rec } = makeDeps(() => new Promise((r) => { release = r; }));
    const first = ctx.runReplySend("thr-1", input, deps);
    // Second trigger while the first request is still out (a re-dispatched
    // event, a double click): must not open a dialog or POST.
    const second = await ctx.runReplySend("thr-1", input, deps);
    check("r1: a second press while the first is in flight returns 'busy'", second.status === "busy");
    check("r2: …and shows no second confirm dialog", rec.confirms === 1);
    check("r3: …and makes no second POST", rec.posts.length === 1);
    check("r4: the form is locked while the request is out", rec.lockedDuringPost === true);
    release({ success: true, internalMessageId: "msg-1" });
    const out = await first;
    check("r5: one press with OK → exactly one POST …/threads/thr-1/send", rec.posts.length === 1 && rec.posts[0].path === "/threads/thr-1/send");
    check("r6: the POST carries the reply as Daniel's resend_send",
      rec.posts[0].payload.intent === "resend_send" && rec.posts[0].payload.createdBy === "daniel" &&
      JSON.stringify(rec.posts[0].payload.toEmails) === JSON.stringify(["hallo@solvanggard.com"]) && rec.posts[0].payload.bodyText === "Takk for svar!");
    check("r7: success gives the receipt «Sendt HH:MM til <mottaker>»", out.status === "sent" && out.receipt === "Sendt 17:33 til hallo@solvanggard.com");
    check("r8: unlocked again after the answer, and the thread is no longer in flight", rec.unlocks === 1 && !deps.inFlight.has("thr-1"));
  }

  {
    const { deps, rec } = makeDeps(async () => ({ success: true }), false);
    const out = await ctx.runReplySend("thr-2", input, deps);
    check("r9: Avbryt in the dialog → no POST, no lock, nothing left in flight",
      out.status === "cancelled" && rec.posts.length === 0 && rec.locks === 0 && !deps.inFlight.has("thr-2"));
  }

  {
    const { deps, rec } = makeDeps(async () => {
      throw new Error('409: {"error":"duplicate_send","duplicateMessageId":"msg-b700d654"}');
    });
    const out = await ctx.runReplySend("thr-3", input, deps);
    check("r10: a 409 duplicate_send is shown as a readable reason naming the existing message",
      out.status === "error" && /allerede sendt/.test(out.error) && out.error.includes("msg-b700d654"));
    check("r11: on error the form is unlocked again", rec.unlocks === 1 && !deps.inFlight.has("thr-3"));
    const again = await ctx.runReplySend("thr-3", { ...input, body: "Ny tekst" }, deps);
    check("r12: after an error a new press goes through again (dialog + POST)", again.status === "error" && rec.confirms === 2 && rec.posts.length === 2);
  }

  check("r13: a 500 with an error body is shown with its reason",
    /^Ikke sendt \(500\): smtp down/.test(ctx.describeSendError(new Error('500: {"success":false,"error":"smtp down"}'))));
  check("r14: gmail_draft gets its own receipt wording",
    ctx.formatSendReceipt("gmail_draft", "a@b.no", new Date(2026, 0, 1, 9, 5)) === "Lagt i kø 09:05 som Gmail-utkast til a@b.no");

  // ── Page wiring ───────────────────────────────────────────────────────
  const sendReply = html.match(/async function sendReply\(threadId\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  check("s1: sendReply() goes through runReplySend (no direct confirm()/api() of its own)",
    /runReplySend\(threadId/.test(sendReply) && !/confirm\(`/.test(sendReply) && !/api\('\/threads\//.test(sendReply));
  check("s2: the thread compose box renders the receipt", /\$\{renderSendReceipt\(t\.id\)\}/.test(html));
  check("s3: on success the thread is re-rendered so the sent message shows in it", /await selectThread\(threadId\)/.test(sendReply));

  return summary;
}

if (require.main === module) {
  runAdminCrmReplySendTests({ log: true }).then((s) => {
    console.log(`\nadmin-crm-reply-send: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
  });
}
