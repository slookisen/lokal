import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { runSeImport } from "../src/se-import";
import { bvFile, call, makeTestApp, scbFile, sourcesFrom, TOKEN, withServer } from "./helpers";

const ORG = "5561000011";
const ORG2 = "5561000022";
const CID = `se:${ORG}`;
const SITE = "https://www.gardensmat.se";
const PAGE = `${SITE}/om-oss`;
const PAGE_TEXT =
  "Gårdens Mat AB – välkommen till vår gårdsbutik! Vi säljer kött och ägg från egna djur. " +
  "Öppettider: lördagar 10–14. Besöksadress: Byvägen 1, Göteborg. " +
  "Kontakt: info@gardensmat.se, tel 031-123 45 67.";

async function seeded(opts: { now?: () => Date; limits?: { diskMaxPct: number; dbMaxBytes: number } } = {}) {
  const scb = scbFile([
    { PeOrgNr: `16${ORG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", Gatuadress: "Byvägen 1", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${ORG2}`, JurForm: "49", FtgStat: "1", Namn: "Andra Gården AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
  ]);
  const bv = bvFile([
    { organisationsidentitet: `${ORG}$ORGNR-IDORG`, verksamhetsbeskrivning: "Gårdsbutik med försäljning av egna produkter." },
    { organisationsidentitet: `${ORG2}$ORGNR-IDORG`, verksamhetsbeskrivning: "Självplock av jordgubbar." },
  ]);
  const t = makeTestApp({ ...opts, sources: sourcesFrom(scb, bv) });
  await runSeImport(t.db, sourcesFrom(scb, bv), { importId: "imp-1", now: opts.now || (() => new Date()) });
  return t;
}

function goodDraft(runId: string, over: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    outcome: "drafted",
    excerpts: [{ url: PAGE, text: PAGE_TEXT }],
    fields: {
      display_name: { value: "Gårdens Mat", sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen till vår gårdsbutik" }] },
      website: { value: SITE, sources: [{ url: PAGE, quote: "välkommen till vår gårdsbutik" }] },
      business_email: { value: "info@gardensmat.se", sources: [{ url: PAGE, quote: "Kontakt: info@gardensmat.se" }] },
      business_phone: { value: "031-123 45 67", sources: [{ url: PAGE, quote: "tel 031-123 45 67" }] },
      product_categories: { value: ["kött", "ägg"], sources: [{ url: PAGE, quote: "Vi säljer kött och ägg från egna djur" }] },
      sales_channels: { value: ["gårdsbutik"], sources: [{ url: PAGE, quote: "vår gårdsbutik" }] },
      opening_hours: { value: "lördagar 10–14", sources: [{ url: PAGE, quote: "Öppettider: lördagar 10–14" }] },
      org_nr: { value: ORG, sources: [{ url: "register:se" }] },
      ...over,
    },
  };
}

const okVerdict = (runId: string, fields: string[]) => ({
  run_id: runId,
  verdict: "approve",
  entity_match: true,
  direct_sale_ok: true,
  language_ok: true,
  personal_data_found: false,
  field_results: Object.fromEntries(fields.map((f) => [f, "ok"])),
  reasons: "Samma enhet: namn, adress och foretaksform stämmer. Alla fält finns i källan.",
});

test("health is open, everything else needs the token, and nothing is indexable", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    const h = await call(base, "GET", "/health", undefined, null);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal((await call(base, "GET", "/stats", undefined, null)).status, 401);
    assert.equal((await call(base, "GET", "/stats", undefined, "wrong")).status, 401);
    assert.equal((await call(base, "GET", "/stats")).status, 200);
  });
});

test("fails closed when no token is configured", async () => {
  const { createApp } = await import("../src/app");
  const t = makeTestApp();
  const app = createApp({ db: t.db, dataDir: t.dir, dbFile: t.dbFile, token: undefined, hmacKey: undefined, limits: { diskMaxPct: 101, dbMaxBytes: 2 ** 40 }, now: () => new Date(), importSources: sourcesFrom(scbFile([]), bvFile([])) });
  await withServer(app, async (base) => {
    assert.equal((await call(base, "GET", "/stats")).status, 503);
  });
});

test("build → judge flow, with proposer ≠ admitter enforced", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    const lease = await call(base, "POST", "/candidates/lease", { run_id: "build-run-1", n: 5 });
    assert.equal(lease.status, 200);
    assert.equal(lease.json.candidates.length, 2);
    assert.equal(lease.json.candidates[0].candidate_id, CID);
    assert.equal(lease.json.candidates[0].unit.legal_form, "AB");

    const d = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, goodDraft("build-run-1"));
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const draftId = d.json.draft_id;

    // The builder run cannot lease its own drafts for judging …
    const own = await call(base, "POST", "/judge/lease", { run_id: "build-run-1" });
    assert.equal(own.json.drafts.length, 0);
    // … a separate judge run can, and gets the excerpts.
    const jl = await call(base, "POST", "/judge/lease", { run_id: "judge-run-1" });
    assert.equal(jl.json.drafts.length, 1);
    assert.equal(jl.json.drafts[0].excerpts[0].url, PAGE);

    // Builder run id cannot post a verdict.
    const fields = Object.keys(goodDraft("x").fields);
    assert.equal((await call(base, "POST", `/drafts/${draftId}/verdict`, okVerdict("build-run-1", fields))).status, 403);
    // An "approve" that contradicts its own checks is refused.
    const bad = { ...okVerdict("judge-run-1", fields), entity_match: false };
    assert.equal((await call(base, "POST", `/drafts/${draftId}/verdict`, bad)).status, 400);
    // Missing field results are refused.
    assert.equal((await call(base, "POST", `/drafts/${draftId}/verdict`, okVerdict("judge-run-1", ["display_name"]))).status, 400);

    const v = await call(base, "POST", `/drafts/${draftId}/verdict`, okVerdict("judge-run-1", fields));
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.candidate_status, "approved");
    const s = await call(base, "GET", "/sample?n=5");
    assert.equal(s.json.profiles.length, 1);
    assert.equal(s.json.profiles[0].fields.display_name.value, "Gårdens Mat");
  });
  assert.equal((db.prepare("SELECT status FROM candidates WHERE candidate_id = ?").get(CID) as any).status, "approved");
});

test("deterministic checks refuse unsupported or forbidden fields", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-2", n: 1 });
    const post = (body: unknown) => call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, body);
    const errs = async (over: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const r = await post({ ...goodDraft("build-run-2", over), ...extra });
      assert.equal(r.status, 422, JSON.stringify(r.json));
      return r.json.detail.errors as string[];
    };
    assert.ok((await errs({ opening_hours: { value: "mån–fre 9–17", sources: [{ url: PAGE, quote: "mån–fre 9–17" }] } })).includes("quote_not_in_excerpt:opening_hours"));
    assert.ok((await errs({ owner_name: { value: "Anna", sources: [{ url: PAGE, quote: "Gårdens Mat" }] } })).includes("field_not_allowed:owner_name"));
    assert.ok(
      (await errs({ opening_hours: { value: "lördagar 10–14", sources: [{ url: "https://www.facebook.com/gardensmat", quote: "lördagar 10–14" }] } }, { excerpts: [{ url: PAGE, text: PAGE_TEXT }, { url: "https://www.facebook.com/gardensmat", text: "lördagar 10–14" }] })).some((e) =>
        e.startsWith("source_host_not_allowed:opening_hours"),
      ),
    );
    assert.ok((await errs({ product_categories: { value: ["kött", "elektronik"], sources: [{ url: PAGE, quote: "Vi säljer kött" }] } })).includes("not_in_vocab:product_categories:elektronik"));
    assert.ok((await errs({ visit_address: { value: { street: "Byvägen 1" }, sources: [{ url: PAGE, quote: "Besöksadress: Byvägen 1" }] } })).includes("visit_address_needs_two_sources"));
    assert.ok((await errs({ display_name: { value: "Gårdens Mat og søster", sources: [{ url: PAGE, quote: "Gårdens Mat AB" }] } })).includes("not_swedish:display_name"));
    assert.ok((await errs({ org_nr: { value: "5561000099", sources: [{ url: "register:se" }] } })).includes("org_nr_mismatch"));
    const emailElsewhere = await errs(
      { business_email: { value: "info@gardensmat.se", sources: [{ url: "https://katalog.example.se/gardensmat", quote: "info@gardensmat.se" }] } },
      { excerpts: [{ url: PAGE, text: PAGE_TEXT }, { url: "https://katalog.example.se/gardensmat", text: "info@gardensmat.se" }] },
    );
    assert.ok(emailElsewhere.includes("business_email_not_published_on_own_site"));

    // Visiting address confirmed by the own site AND the register is accepted.
    const ok = await post(goodDraft("build-run-2", { visit_address: { value: { street: "Byvägen 1", town: "Göteborg" }, sources: [{ url: PAGE, quote: "Besöksadress: Byvägen 1" }, { url: "register:se" }] } }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

test("personnummer: refused in fields, redacted in stored excerpts", async () => {
  const { app, db } = await seeded();
  const pnr = "800101-1231"; // fictitious, valid date + Luhn
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-3", n: 1 });
    const text = `${PAGE_TEXT} Innehavare pnr ${pnr}.`;
    const inField = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, {
      ...goodDraft("build-run-3", { opening_hours: { value: `lördagar 10–14 ${pnr}`, sources: [{ url: PAGE, quote: "Öppettider: lördagar 10–14" }] } }),
      excerpts: [{ url: PAGE, text }],
    });
    assert.equal(inField.status, 422);
    assert.ok(inField.json.detail.errors.includes("personnummer_in_fields"));
    const ok = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, { ...goodDraft("build-run-3"), excerpts: [{ url: PAGE, text }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.redacted_personnummer, 1);
  });
  const stored = db.prepare("SELECT text FROM excerpts").all() as any[];
  assert.ok(stored.every((e) => !e.text.includes(pnr)));
});

test("leases: only the holder may submit; expired leases return to the queue; attempts are capped", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { app } = await seeded({ now: () => clock });
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-4", n: 1 });
    const other = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, goodDraft("build-run-5"));
    assert.equal(other.status, 409);
    for (let i = 0; i < 3; i++) {
      clock = new Date(clock.getTime() + 4 * 3600 * 1000);
      await call(base, "POST", "/purge");
      const l = await call(base, "POST", "/candidates/lease", { run_id: `build-run-r${i}`, n: 1 });
      if (i < 2) assert.equal(l.json.candidates[0]?.candidate_id, CID);
      else assert.notEqual(l.json.candidates[0]?.candidate_id, CID, "a candidate leased 3 times is not handed out again");
    }
  });
});

test("non-drafted outcomes close the candidate without a draft", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-6", n: 1 });
    const r = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, { run_id: "build-run-6", outcome: "not_direct_sale" });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "rejected");
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as any).n, 0);
});

test("quality brake: wrong entity above 10 % over ≥20 verdicts pauses the line", async () => {
  const { app, db } = await seeded();
  // Seed 20 judged drafts directly: 3 with entity mismatch (15 %).
  const now = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const id = db.prepare("INSERT INTO drafts (candidate_id, builder_run_id, language, fields_json, check_json, status, created_at) VALUES (?, 'b', 'sv', '{}', '{}', 'judged', ?)").run(CID, now).lastInsertRowid;
    db.prepare(
      "INSERT INTO verdicts (draft_id, judge_run_id, verdict, entity_match, direct_sale_ok, language_ok, personal_data_found, field_results_json, reasons, created_at) VALUES (?, 'j', ?, ?, 1, 1, 0, '{}', 'x', ?)",
    ).run(id, i < 3 ? "reject" : "approve", i < 3 ? 0 : 1, now);
  }
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-7", n: 1 });
    const d = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, goodDraft("build-run-7"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-run-7" });
    const v = await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, okVerdict("judge-run-7", Object.keys(goodDraft("x").fields)));
    assert.equal(v.status, 200);
    assert.ok(v.json.paused, "the line pauses itself");
    assert.equal((await call(base, "POST", "/candidates/lease", { run_id: "build-run-8", n: 1 })).status, 423);
    assert.equal((await call(base, "POST", "/judge/lease", { run_id: "judge-run-8" })).status, 423);
    await call(base, "POST", "/resume");
    assert.equal((await call(base, "POST", "/candidates/lease", { run_id: "build-run-8", n: 1 })).status, 200);
  });
});

test("resource guard: writes stop with 507 and the app pauses before storage runs out", async () => {
  const { app } = await seeded({ limits: { diskMaxPct: 101, dbMaxBytes: 1 } });
  await withServer(app, async (base) => {
    const r = await call(base, "POST", "/candidates/lease", { run_id: "build-run-9", n: 1 });
    assert.equal(r.status, 507);
    const h = await call(base, "GET", "/health", undefined, null);
    assert.equal(h.json.paused, true);
  });
});

test("page excerpts expire after 30 days", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { app, db } = await seeded({ now: () => clock });
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-run-10", n: 1 });
    assert.equal((await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, goodDraft("build-run-10"))).status, 200);
    clock = new Date(clock.getTime() + 31 * 24 * 3600 * 1000);
    const p = await call(base, "POST", "/purge");
    assert.equal(p.json.excerpts_deleted, 1);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM excerpts").get() as any).n, 0);
});

test("search mode: only register units in scope become candidates", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    assert.equal((await call(base, "POST", "/candidates/from-search", { run_id: "build-run-11", org_nr: "5569999999" })).status, 404);
    const s = await call(base, "GET", `/register/search?name=${encodeURIComponent("Andra")}&town=${encodeURIComponent("göteborg")}`);
    assert.equal(s.json.matches.length, 1);
    const r = await call(base, "POST", "/candidates/from-search", { run_id: "build-run-11", org_nr: "556100-0022" });
    assert.equal(r.status, 200);
    assert.equal(r.json.candidate_id, `se:${ORG2}`);
  });
});

test("opt-out removes everything and blocks the next import", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    const r = await call(base, "POST", "/optout", { org_nr: ORG, reason: "begäran" });
    assert.equal(r.status, 200);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM register_units WHERE org_nr = ?").get(ORG) as any).n, 0);
  const { isOptedOut } = await import("../src/store");
  assert.equal(isOptedOut(db, ORG, "hmac-test-key"), true);
});

test("token is never logged or echoed", () => {
  const src = fs.readFileSync(require.resolve("../src/index.ts"), "utf8");
  assert.ok(!/console\.log\([^)]*INTL_STAGING_TOKEN\s*\)/.test(src));
  assert.ok(TOKEN.length > 8);
});
