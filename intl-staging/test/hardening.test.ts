// Tests added after the independent review of 2026-10-13 (CHANGES-REQUESTED):
// one test per confirmed hole and per mutation the first suite did not catch.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createApp } from "../src/app";
import { findPersonnummer, looksLikeSwedishPersonId } from "../src/pii";
import { runSeImport } from "../src/se-import";
import { optout } from "../src/store";
import { bvFile, call, makeTestApp, scbFile, sourcesFrom, withServer } from "./helpers";

const ORG = "5561000011";
const CID = `se:${ORG}`;
const SITE = "https://www.gardensmat.se";
const PAGE = `${SITE}/om-oss`;
const PAGE2 = `${SITE}/kontakt`;
const PAGE_TEXT =
  "Gårdens Mat AB – välkommen till vår gårdsbutik! Vi säljer kött och ägg från egna djur. " +
  "Öppettider: lördagar 10–14. Besöksadress: Byvägen 1, Göteborg. " +
  "Kontakt: info@gardensmat.se, tel 0701234567. KRAV-certifierad gård.";
const PNR = "800101-1231"; // fictitious: valid date + Luhn

function scbRows(extra: Array<Record<string, string>> = []) {
  return scbFile([
    { PeOrgNr: `16${ORG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", Gatuadress: "Byvägen 1", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    ...extra,
  ]);
}
const BV = bvFile([{ organisationsidentitet: `${ORG}$ORGNR-IDORG`, verksamhetsbeskrivning: "Gårdsbutik med försäljning av egna produkter." }]);

async function seeded(opts: { now?: () => Date } = {}) {
  const t = makeTestApp({ ...opts, sources: sourcesFrom(scbRows(), BV) });
  await runSeImport(t.db, sourcesFrom(scbRows(), BV), { importId: "imp-1", now: opts.now || (() => new Date()) });
  return t;
}

function draft(runId: string, over: Record<string, unknown> = {}, excerpts = [{ url: PAGE, text: PAGE_TEXT }]) {
  return {
    run_id: runId,
    outcome: "drafted",
    excerpts,
    fields: {
      display_name: { value: "Gårdens Mat", sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen till vår gårdsbutik" }] },
      website: { value: SITE, sources: [{ url: PAGE, quote: "välkommen till vår gårdsbutik" }] },
      product_categories: { value: ["kött", "ägg"], sources: [{ url: PAGE, quote: "Vi säljer kött och ägg från egna djur" }] },
      ...over,
    },
  };
}
const verdict = (runId: string, fields: string[], over: Record<string, unknown> = {}) => ({
  run_id: runId,
  verdict: "approve",
  entity_match: true,
  direct_sale_ok: true,
  language_ok: true,
  personal_data_found: false,
  field_results: Object.fromEntries(fields.map((f) => [f, "ok"])),
  reasons: "Samma enhet. Alla fält finns i källan.",
  ...over,
});
const FIELDS = ["display_name", "website", "product_categories"];
const draftPath = `/candidates/${encodeURIComponent(CID)}/draft`;

// ── personnummer ──────────────────────────────────────────────────────────

test("personnummer with any dash, space, no-break space or dot separator is found", () => {
  for (const sep of ["-", "+", "–", "—", "−", " ", " ", "."]) {
    assert.deepEqual(findPersonnummer(`pnr 800101${sep}1231 x`), [`800101${sep}1231`], JSON.stringify(sep));
  }
  assert.deepEqual(findPersonnummer("född 19800101 1231"), ["19800101 1231"]);
  assert.equal(looksLikeSwedishPersonId("8001611234".slice(0, 9) + "0"), false, "random digits do not pass Luhn by accident here");
  // samordningsnummer: day + 60
  const nine = "800161123";
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(nine[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  const samord = nine + ((10 - (sum % 10)) % 10);
  assert.equal(looksLikeSwedishPersonId(samord), true);
  assert.equal(looksLikeSwedishPersonId(`${samord.slice(0, 9)}${(Number(samord[9]) + 1) % 10}`), false, "Luhn matters");
});

test("import: each identity guard stands on its own (a personnummer with an AB JurForm is still dropped)", async () => {
  const pnr10 = PNR.replace("-", "");
  const t = makeTestApp();
  const scb = scbRows([
    { PeOrgNr: `19${pnr10}`, JurForm: "49", FtgStat: "1", Namn: "Fel Kodad AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${pnr10}`, JurForm: "49", FtgStat: "1", Namn: "Personnummer Som Orgnr AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
  ]);
  const bv = bvFile([
    { organisationsidentitet: `${ORG}$ORGNR-IDORG`, verksamhetsbeskrivning: "Gårdsbutik." },
    { organisationsidentitet: `${pnr10}$ORGNR-IDORG`, verksamhetsbeskrivning: "Gårdsbutik." },
  ]);
  await runSeImport(t.db, sourcesFrom(scb, bv), { importId: "imp-g", now: () => new Date() });
  const orgs = (t.db.prepare("SELECT org_nr FROM register_units").all() as any[]).map((r) => r.org_nr);
  assert.deepEqual(orgs, [ORG]);
  t.db.pragma("wal_checkpoint(TRUNCATE)");
  assert.ok(!fs.readFileSync(t.dbFile).toString("latin1").includes(pnr10));
});

test("import: reindeer herding is out even as a side activity; HB/KB without a signal is not stored", async () => {
  const t = makeTestApp();
  const scb = scbRows([
    { PeOrgNr: "165561000022", JurForm: "49", FtgStat: "1", Namn: "Kött och Ren AB", Ng1: "01450", Ng2: "01481", PostNr: "98131", PostOrt: "KIRUNA", Reklamsparrtyp: "1" },
    { PeOrgNr: "169696000033", JurForm: "31", FtgStat: "1", Namn: "Andersson och Son HB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
  ]);
  const c = await runSeImport(t.db, sourcesFrom(scb, BV), { importId: "imp-r", now: () => new Date() });
  const orgs = (t.db.prepare("SELECT org_nr FROM register_units").all() as any[]).map((r) => r.org_nr);
  assert.deepEqual(orgs, [ORG]);
  assert.equal(c.in_scope_units, 2, "the HB was in scope …");
  assert.equal(c.stored_units, 1, "… but not stored without a signal");
});

test("import refuses to run without the HMAC key (opt-outs must hold)", async () => {
  const t = makeTestApp();
  const app = createApp({ db: t.db, dataDir: t.dir, dbFile: t.dbFile, token: "test-token-123456", hmacKey: undefined, limits: { diskMaxPct: 101, dbMaxBytes: 2 ** 40 }, now: () => new Date(), importSources: sourcesFrom(scbRows(), BV) });
  await withServer(app, async (base) => {
    assert.equal((await call(base, "POST", "/import/se")).status, 503);
  });
});

test("opt-out blocks the next import", async () => {
  const t = await seeded();
  optout(t.db, { org_nr: ORG }, "hmac-test-key", new Date());
  const { isOptedOut } = await import("../src/store");
  const c = await runSeImport(t.db, sourcesFrom(scbRows(), BV), { importId: "imp-2", now: () => new Date(), isOptedOut: (o) => isOptedOut(t.db, o, "hmac-test-key") });
  assert.equal(c.skipped_optout, 1);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM register_units").get() as any).n, 0);
});

// ── stored text: excerpts, fetched_at, judge text, bad JSON ─────────────

test("client fetched_at is ignored; en-dash personnummer in an excerpt is redacted", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-a1", n: 1 });
    const text = `${PAGE_TEXT} Ägare 800101–1231.`;
    const r = await call(base, "POST", draftPath, { ...draft("build-a1"), excerpts: [{ url: PAGE, text, fetched_at: PNR }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.redacted_personnummer, 1);
  });
  const rows = db.prepare("SELECT text, fetched_at FROM excerpts").all() as any[];
  assert.ok(rows.every((e) => !e.text.includes("1231") && /^\d{4}-\d\d-\d\dT/.test(e.fetched_at)));
});

test("verdict: field results must be ok/unsupported/wrong for exactly the draft's fields; reasons are scanned", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-b1", n: 1 });
    const d = await call(base, "POST", draftPath, draft("build-b1"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-b1" });
    const vp = `/drafts/${d.json.draft_id}/verdict`;
    assert.equal((await call(base, "POST", vp, verdict("judge-b1", FIELDS, { field_results: { display_name: "Anna Andersson", website: "ok", product_categories: "ok" } }))).status, 400);
    assert.equal((await call(base, "POST", vp, verdict("judge-b1", [...FIELDS, "owner"]))).status, 400);
    assert.equal((await call(base, "POST", vp, verdict("judge-b1", FIELDS, { reasons: `Ägare ${PNR}` }))).status, 422);
    assert.equal((await call(base, "POST", vp, verdict("judge-b1", FIELDS, { reasons: "x".repeat(2001) }))).status, 400);
    assert.equal((await call(base, "POST", vp, verdict("judge-b1", FIELDS, { excerpt_verified: true }))).status, 200);
    const st = await call(base, "GET", "/stats");
    assert.equal(st.json.quality_last_verdicts.excerpt_verified_share, 1);
  });
});

test("malformed JSON gets a 400 without the body being logged or echoed", async () => {
  const { app } = await seeded();
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/candidates/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token-123456" },
        body: `{"run_id": "Anna Andersson ${PNR}`,
      });
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.ok(!body.includes("Anna") && !body.includes(PNR), body);
    });
  } finally {
    console.error = orig;
  }
  assert.ok(errors.every((e) => !e.includes("Anna") && !e.includes(PNR)));
});

// ── source discipline ─────────────────────────────────────────────────────

test("own-site rule: a directory page is neither a website nor a field source", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-c1", n: 1 });
    const cat = "https://www.gulasidorna.se/gardens-mat";
    const catText = "Gårdens Mat AB. Öppettider: lördagar 10–14.";
    const r0 = await call(base, "POST", draftPath, draft("build-c1", {}, [{ url: PAGE, text: PAGE_TEXT }, { url: cat, text: catText }]));
    assert.equal(r0.status, 400, "a directory page is not stored as an excerpt");
    assert.equal(r0.json.error, "excerpt_host_not_allowed");
    const r1 = await call(base, "POST", draftPath, draft("build-c1", { opening_hours: { value: "lördagar 10–14", sources: [{ url: cat, quote: "Öppettider: lördagar 10–14" }] } }));
    assert.equal(r1.status, 422);
    assert.ok(r1.json.detail.errors.some((e: string) => e.startsWith("source_host_not_allowed:opening_hours")));
    const r2 = await call(base, "POST", draftPath, draft("build-c1", { website: { value: cat, sources: [{ url: cat, quote: "Gårdens Mat AB. Öppettider" }] } }, [{ url: cat, text: catText }]));
    assert.equal(r2.status, 422);
    assert.ok(r2.json.detail.errors.includes("website_is_not_own_site"));
    const r4 = await call(base, "POST", draftPath, draft("build-c1", { website: { value: "https://se/", sources: [{ url: "https://se/", quote: "välkommen till vår gårdsbutik" }] } }));
    assert.ok(r4.status === 400 || r4.json.detail.errors.includes("bad_value:website"), "a one-label host is not a website");
    const noSite = { display_name: draft("x").fields.display_name, product_categories: draft("x").fields.product_categories };
    // Without a website no page can be stored at all …
    const r3a = await call(base, "POST", draftPath, { ...draft("build-c1"), fields: noSite });
    assert.equal(r3a.json.error, "excerpt_host_not_allowed");
    // … and the draft itself is refused for lacking one.
    const r3 = await call(base, "POST", draftPath, { ...draft("build-c1"), fields: noSite, excerpts: [] });
    assert.ok(r3.json.detail.errors.includes("missing:website"));
  });
});

test("quotes are bound to values and must not be trivially short", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-d1", n: 1 });
    const errs = async (over: Record<string, unknown>) => (await call(base, "POST", draftPath, draft("build-d1", over))).json.detail.errors as string[];
    assert.ok((await errs({ display_name: { value: "Helt Annat Namn", sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen" }] } })).includes("value_not_in_quote:display_name"));
    assert.ok((await errs({ display_name: { value: "Gårdens Mat", sources: [{ url: PAGE, quote: "och" }] } })).includes("missing_quote:display_name"));
    assert.ok((await errs({ opening_hours: { value: "lördagar 9–16", sources: [{ url: PAGE, quote: "Öppettider: lördagar 10–14" }] } })).includes("value_not_in_quote:opening_hours"));
  });
});

test("contact, register and certification rules (mutation gaps)", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-e1", n: 1 });
    const errs = async (over: Record<string, unknown>, ex?: Array<{ url: string; text: string }>) => {
      const r = await call(base, "POST", draftPath, draft("build-e1", over, ex));
      return (r.json?.detail?.errors || []) as string[];
    };
    // email must be in the quote
    assert.ok((await errs({ business_email: { value: "info@gardensmat.se", sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen" }] } })).includes("business_email_not_in_quote"));
    // website must be sourced from itself (a subdomain page is an allowed excerpt but not the site itself)
    const SHOP = "https://shop.gardensmat.se/om";
    assert.ok(
      (await errs({ website: { value: SITE, sources: [{ url: SHOP, quote: "välkommen till vår gårdsbutik" }] } }, [{ url: PAGE, text: PAGE_TEXT }, { url: SHOP, text: PAGE_TEXT }])).includes(
        "website_not_sourced_from_itself",
      ),
    );
    // register:se only for org_nr / postal_town / visit_address, and must match the register
    assert.ok((await errs({ season: { value: "maj–sep", sources: [{ url: "register:se" }] } })).includes("register_source_not_allowed:season"));
    assert.ok((await errs({ postal_town: { value: "Borås", sources: [{ url: "register:se" }] } })).includes("postal_town_register_mismatch"));
    assert.ok(
      (await errs({ visit_address: { value: { street: "Annan väg 9" }, sources: [{ url: PAGE, quote: "Besöksadress: Byvägen 1" }, { url: "register:se" }] } })).includes(
        "visit_address_register_mismatch",
      ),
    );
    assert.ok((await errs({ org_nr: { value: ORG, sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen" }] } })).includes("org_nr_must_come_from_register"));
    // certification only with a source on the certifier's register
    assert.ok(
      (await errs({ certifications: { value: ["KRAV"], sources: [{ url: PAGE, quote: "KRAV-certifierad gård" }] } })).some((e) => e.startsWith("source_host_not_allowed:certifications")),
    );
    assert.ok((await errs({ business_phone: { value: "070-999 99 99", sources: [{ url: PAGE, quote: "tel 0701234567" }] } })).includes("business_phone_not_in_quote"));
    // at most 4 pages from one site
    const many = [1, 2, 3, 4, 5].map((i) => ({ url: `${SITE}/p${i}`, text: PAGE_TEXT }));
    const r = await call(base, "POST", draftPath, draft("build-e1", {}, [{ url: PAGE, text: PAGE_TEXT }, ...many.slice(0, 4)]));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "more_than_4_pages_from_one_site");
    // Last (it succeeds and closes the lease): the declared phone, which has the
    // date+Luhn shape of a personnummer here, is not mistaken for one.
    const PHONE = "0701123457"; // 07-01-12 + Luhn: personnummer-shaped on purpose
    assert.equal(looksLikeSwedishPersonId(PHONE), true);
    const ok = await call(
      base,
      "POST",
      draftPath,
      // Value formatted differently from the page: the exemption works on digits.
      draft("build-e1", { business_phone: { value: `${PHONE.slice(0, 3)}-${PHONE.slice(3, 6)} ${PHONE.slice(6, 8)} ${PHONE.slice(8)}`, sources: [{ url: PAGE, quote: `tel ${PHONE}` }] } }, [
        { url: PAGE, text: PAGE_TEXT.replace("0701234567", PHONE) },
      ]),
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

// ── queue integrity ───────────────────────────────────────────────────────

test("judge must hold the lease; an expired judge lease cannot post", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { app } = await seeded({ now: () => clock });
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-f1", n: 1 });
    const d = await call(base, "POST", draftPath, draft("build-f1"));
    const vp = `/drafts/${d.json.draft_id}/verdict`;
    assert.equal((await call(base, "POST", vp, verdict("judge-f1", FIELDS))).status, 409, "no lease yet");
    await call(base, "POST", "/judge/lease", { run_id: "judge-f1" });
    assert.equal((await call(base, "POST", vp, verdict("judge-f2", FIELDS))).status, 409, "another judge");
    clock = new Date(clock.getTime() + 3 * 3600 * 1000);
    assert.equal((await call(base, "POST", vp, verdict("judge-f1", FIELDS))).status, 409, "lease expired");
  });
});

test("a draft for a candidate that left the register is never leased to or approved by a judge", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-g1", n: 1 });
    await call(base, "POST", draftPath, draft("build-g1"));
  });
  // Next import no longer has the unit … but sees enough others to deactivate.
  const others = Array.from({ length: 3 }, (_, i) => ({
    PeOrgNr: `16556200000${i}`,
    JurForm: "49",
    FtgStat: "1",
    Namn: `Annan Gård ${i} AB`,
    Ng1: "01110",
    PostNr: "41101",
    PostOrt: "GÖTEBORG",
    Reklamsparrtyp: "1",
  }));
  await runSeImport(db, sourcesFrom(scbFile(others), bvFile([])), { importId: "imp-2", now: () => new Date() });
  assert.equal((db.prepare("SELECT status FROM candidates WHERE candidate_id = ?").get(CID) as any).status, "excluded");
  assert.equal((db.prepare("SELECT status FROM drafts WHERE candidate_id = ?").get(CID) as any).status, "superseded");
  await withServer(app, async (base) => {
    assert.equal((await call(base, "POST", "/judge/lease", { run_id: "judge-g1" })).json.drafts.length, 0);
  });
});

test("quality brake counts only verdicts after a resume", async () => {
  const { app, db } = await seeded();
  const old = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 20; i++) {
    const id = db.prepare("INSERT INTO drafts (candidate_id, builder_run_id, language, fields_json, check_json, status, created_at) VALUES (?, 'b', 'sv', '{}', '{}', 'judged', ?)").run(CID, old).lastInsertRowid;
    db.prepare(
      "INSERT INTO verdicts (draft_id, judge_run_id, verdict, entity_match, direct_sale_ok, language_ok, personal_data_found, field_results_json, reasons, created_at) VALUES (?, 'j', 'reject', 0, 1, 1, 0, '{}', 'x', ?)",
    ).run(id, old);
  }
  await withServer(app, async (base) => {
    await call(base, "POST", "/resume");
    await call(base, "POST", "/candidates/lease", { run_id: "build-h1", n: 1 });
    const d = await call(base, "POST", draftPath, draft("build-h1"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-h1" });
    const v = await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, verdict("judge-h1", FIELDS));
    assert.equal(v.status, 200);
    assert.equal(v.json.paused, null, "old bad verdicts must not re-trip the brake");
    assert.equal(v.json.quality.n, 1);
  });
});

test("attempts cap: exhausted candidates leave the queue; search mode respects the cap and the pause", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { app, db } = await seeded({ now: () => clock });
  await withServer(app, async (base) => {
    for (let i = 0; i < 3; i++) {
      await call(base, "POST", "/candidates/lease", { run_id: `build-i${i}`, n: 1 });
      clock = new Date(clock.getTime() + 4 * 3600 * 1000);
      await call(base, "POST", "/purge");
    }
    assert.deepEqual(db.prepare("SELECT status, status_reason FROM candidates WHERE candidate_id = ?").get(CID), { status: "needs_review", status_reason: "max_attempts" });
    assert.equal((await call(base, "POST", "/candidates/from-search", { run_id: "build-i9", org_nr: ORG })).status, 409);
    await call(base, "POST", "/pause", { reason: "test" });
    assert.equal((await call(base, "POST", "/candidates/from-search", { run_id: "build-i9", org_nr: "5561000099" })).status, 423);
  });
});

test("expired excerpts are never handed to a judge, even before the purge runs", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { db } = await seeded({ now: () => clock });
  const { leaseCandidates, leaseDrafts, submitDraft } = await import("../src/store");
  leaseCandidates(db, { run_id: "build-j1", n: 1 }, clock);
  submitDraft(db, CID, draft("build-j1"), clock);
  clock = new Date(clock.getTime() + 31 * 24 * 3600 * 1000);
  const l = leaseDrafts(db, { run_id: "judge-j1" }, clock);
  assert.equal(l.drafts.length, 1);
  assert.equal(l.drafts[0].excerpts.length, 0);
});

test("register search escapes LIKE wildcards and folds Swedish case", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    assert.equal((await call(base, "GET", `/register/search?name=${encodeURIComponent("%%%")}`)).json.matches.length, 0);
    assert.equal((await call(base, "GET", `/register/search?name=${encodeURIComponent("GÅRDENS")}&town=${encodeURIComponent("Göteborg")}`)).json.matches.length, 1);
  });
});

// ── round 2 (2026-10-13) ──────────────────────────────────────────────────

test("a personnummer can never pass as the business phone", async () => {
  const { app, db } = await seeded();
  const text = `${PAGE_TEXT} Innehavare: Anna Andersson, pnr ${PNR}.`;
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-k1", n: 1 });
    for (const value of [PNR, PNR.replace("-", ""), `19${PNR.replace("-", "")}`]) {
      const r = await call(base, "POST", draftPath, draft("build-k1", { business_phone: { value, sources: [{ url: PAGE, quote: `pnr ${PNR}` }] } }, [{ url: PAGE, text }]));
      assert.equal(r.status, 422, value);
      assert.ok(r.json.detail.errors.includes("bad_value:business_phone") || r.json.detail.errors.includes("personnummer_in_fields"), value);
    }
    // A people-search page is never stored, whatever it is offered as.
    const rs = await call(base, "POST", draftPath, draft("build-k1", {}, [{ url: PAGE, text: PAGE_TEXT }, { url: "https://www.ratsit.se/x", text: "46 år, född 1 januari 1980" }]));
    assert.equal(rs.json.error, "excerpt_host_not_allowed");
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM excerpts").get() as any).n, 0);
});

test("verdict enum is enforced on its own (a reject with a free-text field result is refused)", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-l1", n: 1 });
    const d = await call(base, "POST", draftPath, draft("build-l1"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-l1" });
    const r = await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, verdict("judge-l1", FIELDS, { verdict: "reject", entity_match: false, field_results: { display_name: "Anna Andersson", website: "ok", product_categories: "ok" } }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_field_result");
  });
});

test("malformed JSON body never reaches the logs, even with util.inspect", async () => {
  const util = await import("node:util");
  const { app } = await seeded();
  const logged: string[] = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  const capture = (...a: unknown[]) => logged.push(a.map((x) => util.inspect(x, { depth: 5 })).join(" "));
  console.error = capture;
  console.log = capture;
  console.warn = capture;
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/candidates/lease`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token-123456" },
        body: `{"a": Anna ${PNR}}`,
      });
      assert.equal(res.status, 400);
      assert.ok(!(await res.text()).includes("Anna"));
    });
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(logged.every((l) => !l.includes("Anna") && !l.includes("1231")), logged.join("\n"));
});

test("judge lease and verdict both require a drafted candidate", async () => {
  const { db } = await seeded();
  const { leaseCandidates, leaseDrafts, submitDraft, submitVerdict, HttpError } = await import("../src/store");
  const now = new Date();
  leaseCandidates(db, { run_id: "build-m1", n: 1 }, now);
  const d = submitDraft(db, CID, draft("build-m1"), now);
  db.prepare("UPDATE candidates SET status = 'rejected' WHERE candidate_id = ?").run(CID);
  assert.equal(leaseDrafts(db, { run_id: "judge-m1" }, now).drafts.length, 0, "lease filter");
  db.prepare("UPDATE candidates SET status = 'drafted' WHERE candidate_id = ?").run(CID);
  assert.equal(leaseDrafts(db, { run_id: "judge-m1" }, now).drafts.length, 1);
  db.prepare("UPDATE candidates SET status = 'excluded' WHERE candidate_id = ?").run(CID);
  assert.throws(() => submitVerdict(db, d.draft_id as number, verdict("judge-m1", FIELDS), now), (e: unknown) => e instanceof HttpError && e.code === "candidate_not_drafted");
});

test("search mode refuses a candidate that used up its attempts (checked on its own)", async () => {
  const { db } = await seeded();
  const { addSearchCandidate, HttpError } = await import("../src/store");
  db.prepare("UPDATE candidates SET status = 'new', attempts = 3 WHERE candidate_id = ?").run(CID);
  assert.throws(() => addSearchCandidate(db, { run_id: "build-n1", org_nr: ORG }, new Date()), (e: unknown) => e instanceof HttpError && e.code === "max_attempts");
});

test("a draft left unjudged past the excerpt TTL is retired and the candidate requeued", async () => {
  let clock = new Date("2026-10-13T10:00:00Z");
  const { db } = await seeded({ now: () => clock });
  const { leaseCandidates, submitDraft, purge } = await import("../src/store");
  leaseCandidates(db, { run_id: "build-o1", n: 1 }, clock);
  submitDraft(db, CID, draft("build-o1"), clock);
  clock = new Date(clock.getTime() + 31 * 24 * 3600 * 1000);
  const r = purge(db, clock);
  assert.equal(r.stale_drafts, 1);
  assert.equal((db.prepare("SELECT status FROM drafts").get() as any).status, "superseded");
  assert.deepEqual(db.prepare("SELECT status, status_reason FROM candidates WHERE candidate_id = ?").get(CID), { status: "new", status_reason: "draft_expired" });
});

test("the schema carries a user_version for later migrations", async () => {
  const { db } = await seeded();
  assert.equal(db.pragma("user_version", { simple: true }), 1);
});
