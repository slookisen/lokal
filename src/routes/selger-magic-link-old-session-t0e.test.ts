/**
 * selger-magic-link-old-session-t0e.test.ts — slice T0e of the owner portal
 * (dev-request 2026-10-30-rfb-eierportal-bolge-0-ingen-tilgang).
 *
 * /selger?magic=<valid link> showed «Logg inn» on the first try when the
 * browser still held an old, expired lokal_session: init restored the old
 * session alongside the async magic login, and the old token's 401 landed
 * after the new login was stored — clearSession() and the lokal_agents filter
 * (by agentId) then wiped the new token, and the one-time link was spent.
 * Now:
 *
 *   a  ?magic= with an expired stored session (and lokal_agents holding the
 *      old token for the same agent): the dashboard shows on the first try;
 *      lokal_session and lokal_agents hold the NEW token; the old session is
 *      not restored alongside the link.
 *   b  ?magic= that fails: the stored session is tried after it (valid ->
 *      dashboard as before; none -> login view with the link's error).
 *   c  no ?magic=, expired stored session: login view and «utløpt» alert;
 *      only the failed token is removed (lokal_session, its lokal_agents
 *      entry), another store's entry stays.
 *   d  no ?magic=, valid stored session: restores as today.
 *   e  stale answer: a newer login replaces the token while the old token's
 *      /auth/login is out; its 401 (before or after the new answer) neither
 *      clears the new session nor shows the login view.
 *   f  saveSession keeps the lokal_agents token current before /info has
 *      named the store; clearSession(token) only drops a session holding
 *      that token; logout still clears it.
 *
 * Runs selger.html's own inline script in node:vm with the fake DOM of
 * tests/helpers/fake-page.ts, a Map-backed localStorage, history.replaceState
 * that changes location.search as a browser does, and a fetch whose answers
 * the test orders (the race needs the old token's 401 to land late).
 * Exported runSelgerMagicLinkOldSessionT0eTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/selger-magic-link-old-session-t0e.test.ts
 */

import * as vm from "vm";
import { inlineScript } from "../../tests/helpers/html-injection";
import { jsonResponse, settle, runPage, type FetchStub, type Page } from "../../tests/helpers/fake-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ORIGIN = "https://rettfrabonden.com";
const API = `${ORIGIN}/api/marketplace`;
const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const OLD = "old-claim-token";
const NEW = "new-claim-token";
const TOKEN_B = "store-b-token";
const MAGIC = "one-time-magic";
const EXPIRED = "Innloggingen din har utløpt. Vennligst logg inn på nytt.";

interface Call { url: string; method: string; body: any }

/** A promise the test resolves itself. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * The marketplace API as /selger sees it: magic-verify answers `magic`
 * (null = a spent link), /auth/login knows the tokens in `valid` (token ->
 * agentId, else 401 as marketplace.ts answers), and a login whose token is in
 * `hold` answers only once that promise resolves.
 */
function server(cfg: { magic?: { claimToken: string; agentId: string } | null; valid: Record<string, string>; hold?: Record<string, Promise<unknown>> }) {
  const calls: Call[] = [];
  const seen = new Map<string, ReturnType<typeof deferred>>();
  const loginSeen = (token: string) => {
    if (!seen.has(token)) seen.set(token, deferred());
    return seen.get(token)!;
  };
  const stub: FetchStub = async (url, opts) => {
    const o = (opts ?? {}) as { method?: string; body?: string };
    const body = o.body ? JSON.parse(o.body) : undefined;
    calls.push({ url, method: o.method ?? "GET", body });
    if (url.startsWith(`${API}/auth/magic-verify?`)) {
      return cfg.magic
        ? jsonResponse({ success: true, data: { ...cfg.magic, agentName: "Fjordgården" } })
        : jsonResponse({ success: false, error: "Ugyldig eller utløpt lenke" }, 400);
    }
    if (url === `${API}/auth/login`) {
      loginSeen(body.token).resolve();
      const hold = cfg.hold?.[body.token];
      if (hold) await hold;
      const agentId = cfg.valid[body.token];
      return agentId
        ? jsonResponse({ success: true, data: { agentId, claimantName: "Ola" } })
        : jsonResponse({ success: false, error: "Ugyldig eller utløpt token" }, 401);
    }
    const info = url.match(/\/api\/marketplace\/agents\/([^/]+)\/info$/);
    if (info) {
      const id = decodeURIComponent(info[1]!);
      return jsonResponse({ success: true, data: { agent: { id, name: id === A ? "Fjordgården" : "Butikk B" }, knowledge: {} } });
    }
    return jsonResponse({ success: false }, 404);
  };
  return {
    stub,
    calls,
    loginSeen: (token: string) => loginSeen(token).promise,
    logins: () => calls.filter((c) => c.url === `${API}/auth/login`).map((c) => c.body?.token),
    magicVerifies: () => calls.filter((c) => c.url.startsWith(`${API}/auth/magic-verify?`)).length,
  };
}

/** A Map-backed localStorage holding `initial` (values JSON-encoded as the page does). */
function fakeStorage(initial: Record<string, unknown>) {
  const m = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    api: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: unknown) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
    },
    read: (k: string): any => (m.has(k) ? JSON.parse(m.get(k)!) : null),
  };
}

/** A classList that keeps its classes, so show()/hide() can be read back. */
function trackClasses(page: Page, id: string, hidden: boolean): { hidden: () => boolean } {
  const set = new Set<string>(hidden ? ["hidden"] : []);
  (page.el(id) as any).classList = {
    add: (c: string) => { set.add(c); },
    remove: (c: string) => { set.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c); },
    contains: (c: string) => set.has(c),
  };
  return { hidden: () => set.has("hidden") };
}

/**
 * Opens /selger<search> with `stored` in localStorage: the page's own script
 * runs in a context made by runPage, with storage, history and the views'
 * classList in place before it starts (the markup shows viewClaim and hides
 * viewDashboard and btnLogout).
 */
function openSelger(search: string, stored: Record<string, unknown>, stub: FetchStub) {
  const page = runPage("", stub, { pathname: "/selger", search });
  const storage = fakeStorage(stored);
  const replaced: string[] = [];
  page.context.localStorage = storage.api;
  page.context.history = {
    replaceState: (_s: unknown, _t: unknown, url: string) => {
      replaced.push(url);
      const u = new URL(url, ORIGIN);
      page.context.location.pathname = u.pathname;
      page.context.location.search = u.search;
      page.context.location.href = u.href;
    },
  };
  const views = {
    claim: trackClasses(page, "viewClaim", false),
    dashboard: trackClasses(page, "viewDashboard", true),
    logout: trackClasses(page, "btnLogout", true),
  };
  vm.runInContext(SCRIPT, page.context, { filename: SCRIPT_FILE });
  const inPage = (code: string): any => vm.runInContext(code, page.context);
  return { page, storage, views, replaced, inPage };
}

let SCRIPT = "";
/** The page script's name in stack traces, so its own rejections can be told apart. */
const SCRIPT_FILE = "selger.html#t0e";

export async function runSelgerMagicLinkOldSessionT0eTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  // The page's async work must not reject unseen (a crash in the fake DOM
  // would otherwise pass as «nothing happened»). Only rejections from the
  // page script count; another test's stray rejection is not this test's.
  const rejections: string[] = [];
  const onRejection = (reason: unknown) => {
    const stack = String((reason as any)?.stack || reason);
    if (stack.includes(SCRIPT_FILE)) rejections.push(stack);
  };
  process.on("unhandledRejection", onRejection);

  try {
    SCRIPT = inlineScript("selger.html", "function escHtml");
    const dashboardShown = (v: ReturnType<typeof openSelger>["views"]) => ({ claim: !v.claim.hidden(), dashboard: !v.dashboard.hidden(), logout: !v.logout.hidden() });
    const DASHBOARD = { claim: false, dashboard: true, logout: true };
    const LOGIN = { claim: true, dashboard: false, logout: false };

    // ══ a: ?magic= with an expired stored session ════════════════════════
    {
      // The old token's 401 answers only after the new login was sent, as in
      // the browser on 31.10 (it then landed after the new token was stored).
      const s: ReturnType<typeof server> = server({
        magic: { claimToken: NEW, agentId: A },
        valid: { [NEW]: A },
        hold: { get [OLD]() { return s.loginSeen(NEW); } } as Record<string, Promise<unknown>>,
      });
      const { storage, views, replaced, inPage, page } = openSelger(`?magic=${MAGIC}`, {
        lokal_session: { token: OLD, agentId: A },
        lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården", addedAt: "2026-10-01T00:00:00.000Z" }],
      }, s.stub);
      await settle();
      await settle();
      assertEq(dashboardShown(views), DASHBOARD, "a: the dashboard shows on the first try");
      assertEq([inPage("state.claimToken"), inPage("state.agentId")], [NEW, A], "a: the page holds the new login");
      assertEq(storage.read("lokal_session"), { token: NEW, agentId: A }, "a: lokal_session holds the new token");
      assertEq(storage.read("lokal_agents").map((x: any) => [x.agentId, x.token, x.name]), [[A, NEW, "Fjordgården"]], "a: lokal_agents holds the new token for the agent");
      assertEq(s.magicVerifies(), 1, "a: the link is verified once");
      assertEq(s.logins(), [NEW], "a: the old stored session is not restored alongside the link");
      assertEq(page.el("claimAlert").innerHTML.includes("utløpt"), false, "a: no «utløpt» alert");
      assertEq(replaced, ["/selger"], "a: the token is taken out of the URL as before");
    }

    // ══ b: ?magic= that fails ════════════════════════════════════════════
    {
      // valid stored session: tried after the link failed -> dashboard (as before)
      const s = server({ magic: null, valid: { [OLD]: A } });
      const { storage, views, inPage, page } = openSelger(`?magic=${MAGIC}`, {
        lokal_session: { token: OLD, agentId: A },
        lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården" }],
      }, s.stub);
      await settle();
      await settle();
      assertEq(s.calls.map((c) => c.url.replace(/\?.*$/, "")).slice(0, 2), [`${API}/auth/magic-verify`, `${API}/auth/login`], "b valid: the stored session is tried after the link");
      assertEq(s.logins(), [OLD], "b valid: the stored token is checked");
      assertEq(dashboardShown(views), DASHBOARD, "b valid: the dashboard shows from the stored session");
      assertEq(inPage("state.claimToken"), OLD, "b valid: the page holds the stored session");
      assertEq(storage.read("lokal_session"), { token: OLD, agentId: A }, "b valid: lokal_session unchanged");
      assertEq(page.el("magicLinkAlert").innerHTML, '<div class="alert alert-error">Ugyldig eller utløpt lenke</div>', "b valid: the link's error is still shown");
    }
    {
      // nothing stored: login view with the link's error, no login call
      const s = server({ magic: null, valid: {} });
      const { views, page } = openSelger(`?magic=${MAGIC}`, {}, s.stub);
      await settle();
      assertEq(s.logins(), [], "b none: no /auth/login call");
      assertEq(dashboardShown(views), LOGIN, "b none: the login view stays");
      assertEq(page.el("magicLinkAlert").innerHTML, '<div class="alert alert-error">Ugyldig eller utløpt lenke</div>', "b none: the link's error is shown");
    }

    // ══ c: no ?magic=, expired stored session ════════════════════════════
    {
      const s = server({ valid: { [TOKEN_B]: B } });
      const { storage, views, inPage, page } = openSelger("", {
        lokal_session: { token: OLD, agentId: A },
        lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården" }, { agentId: B, token: TOKEN_B, name: "Butikk B" }],
      }, s.stub);
      await settle();
      assertEq(s.logins(), [OLD], "c: the stored token is checked");
      assertEq(dashboardShown(views), LOGIN, "c: the login view shows");
      assertEq(page.el("claimAlert").innerHTML, `<div class="alert alert-error">${EXPIRED}</div>`, "c: the «utløpt» alert shows");
      assertEq([inPage("state.claimToken"), inPage("state.agentId")], [null, null], "c: the page holds no login");
      assertEq(storage.read("lokal_session"), null, "c: the stale lokal_session is removed");
      assertEq(storage.read("lokal_agents").map((x: any) => [x.agentId, x.token]), [[B, TOKEN_B]], "c: only the failed token's lokal_agents entry is removed");
    }

    // ══ d: no ?magic=, valid stored session ══════════════════════════════
    {
      const s = server({ valid: { [OLD]: A } });
      const { storage, views, inPage } = openSelger("", {
        lokal_session: { token: OLD, agentId: A },
        lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården" }],
      }, s.stub);
      await settle();
      assertEq(s.logins(), [OLD], "d: the stored token is checked once");
      assertEq(dashboardShown(views), DASHBOARD, "d: the dashboard shows");
      assertEq([inPage("state.claimToken"), inPage("state.agentId"), inPage("state.agent && state.agent.name")], [OLD, A, "Fjordgården"], "d: the stored session is restored and the store loaded");
      assertEq(storage.read("lokal_session"), { token: OLD, agentId: A }, "d: lokal_session unchanged");
      assertEq(storage.read("lokal_agents").map((x: any) => [x.agentId, x.token]), [[A, OLD]], "d: lokal_agents unchanged");
    }

    // ══ e: a stale 401 for a token a newer login replaced ════════════════
    for (const order of ["old 401 first", "new answer first"] as const) {
      const oldGate = deferred();
      const newGate = deferred();
      const s = server({ valid: { [NEW]: A }, hold: { [OLD]: oldGate.promise, [NEW]: newGate.promise } });
      const { storage, views, inPage, page } = openSelger("", {
        lokal_session: { token: OLD, agentId: A },
        lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården" }],
      }, s.stub);
      await settle();
      assertEq(s.logins(), [OLD], `e ${order}: the old token's check is out`);
      // A newer login while it is out — what checkMagicLink and the code
      // verify do: set the token, save, load the dashboard.
      inPage(`state.claimToken = ${JSON.stringify(NEW)}; state.agentId = ${JSON.stringify(A)}; saveSession(); loadDashboard();`);
      await settle();
      if (order === "old 401 first") { oldGate.resolve(); await settle(); newGate.resolve(); }
      else { newGate.resolve(); await settle(); oldGate.resolve(); }
      await settle();
      await settle();
      assertEq(dashboardShown(views), DASHBOARD, `e ${order}: the dashboard stays`);
      assertEq([inPage("state.claimToken"), inPage("state.agentId")], [NEW, A], `e ${order}: the page keeps the new login`);
      assertEq(storage.read("lokal_session"), { token: NEW, agentId: A }, `e ${order}: lokal_session keeps the new token`);
      assertEq(storage.read("lokal_agents").map((x: any) => [x.agentId, x.token]), [[A, NEW]], `e ${order}: lokal_agents keeps the new token`);
      assertEq(page.el("claimAlert").innerHTML.includes("utløpt"), false, `e ${order}: no «utløpt» alert`);
    }

    // ══ f: saveSession, clearSession(token), logout ══════════════════════
    {
      const s = server({ valid: {} });
      const { storage, inPage, views, page } = openSelger("", { lokal_agents: [{ agentId: A, token: OLD, name: "Fjordgården" }] }, s.stub);
      await settle();
      inPage(`state.agent = null; state.claimToken = ${JSON.stringify(NEW)}; state.agentId = ${JSON.stringify(A)}; saveSession();`);
      assertEq(storage.read("lokal_agents").map((x: any) => [x.agentId, x.token, x.name]), [[A, NEW, "Fjordgården"]], "f saveSession: the token is updated before /info names the store; the name is kept");
      inPage(`clearSession(${JSON.stringify(OLD)});`);
      assertEq(storage.read("lokal_session"), { token: NEW, agentId: A }, "f clearSession(old token): a session with another token stays");
      inPage(`clearSession(${JSON.stringify(NEW)});`);
      assertEq(storage.read("lokal_session"), null, "f clearSession(its token): the session is removed");
      inPage("saveSession();");
      page.el("btnLogout").click();
      await settle();
      assertEq(storage.read("lokal_session"), null, "f logout: lokal_session is removed");
      assertEq(dashboardShown(views), LOGIN, "f logout: the login view shows");
    }

    assertEq(rejections, [], "no unhandled rejection from the page");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSelgerMagicLinkOldSessionT0eTests({ log: true }).then((r) => {
    console.info(`selger-magic-link-old-session-t0e: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
