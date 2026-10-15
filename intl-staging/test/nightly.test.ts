// Changes for unattended nightly runs (dev-request 2026-10-15-se-batch-nattlig-og-daglig-test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { REGISTER_SEARCH_MAX, REGISTER_SEARCH_WINDOW_MS } from "../src/app";
import { quotePhoneDigits } from "../src/checks";
import { runSeImport } from "../src/se-import";
import { MAX_EXCERPT_CHARS } from "../src/store";
import { bvFile, call, makeTestApp, scbFile, sourcesFrom, withServer } from "./helpers";

const ORG = "5561000011";
const CID = `se:${ORG}`;
const SITE = "https://www.gardensmat.se";
const PAGE = `${SITE}/om-oss`;
const PAGE_TEXT =
  "Gårdens Mat AB – välkommen till vår gårdsbutik! Vi säljer kött och ägg från egna djur. " +
  "Öppettider: lördagar 10–14. Kontakt: info@gardensmat.se, ring +46 (0)31-123 45 67.";

async function seeded(now: () => Date = () => new Date()) {
  const scb = scbFile([
    { PeOrgNr: `16${ORG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", Gatuadress: "Byvägen 1", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
  ]);
  const bv = bvFile([{ organisationsidentitet: `${ORG}$ORGNR-IDORG`, verksamhetsbeskrivning: "Gårdsbutik med försäljning av egna produkter." }]);
  const t = makeTestApp({ now, sources: sourcesFrom(scb, bv) });
  await runSeImport(t.db, sourcesFrom(scb, bv), { importId: "imp-1", now });
  return t;
}

function draft(runId: string, text = PAGE_TEXT, phoneQuote = "ring +46 (0)31-123 45 67") {
  return {
    run_id: runId,
    outcome: "drafted",
    excerpts: [{ url: PAGE, text }],
    fields: {
      display_name: { value: "Gårdens Mat", sources: [{ url: PAGE, quote: "Gårdens Mat AB – välkommen till vår gårdsbutik" }] },
      website: { value: SITE, sources: [{ url: PAGE, quote: "välkommen till vår gårdsbutik" }] },
      business_phone: { value: "031-123 45 67", sources: [{ url: PAGE, quote: phoneQuote }] },
      sales_channels: { value: ["gårdsbutik"], sources: [{ url: PAGE, quote: "vår gårdsbutik" }] },
      org_nr: { value: ORG, sources: [{ url: "register:se" }] },
    },
  };
}

const approve = (runId: string, fields: string[]) => ({
  run_id: runId,
  verdict: "approve",
  entity_match: true,
  direct_sale_ok: true,
  language_ok: true,
  personal_data_found: false,
  field_results: Object.fromEntries(fields.map((f) => [f, "ok"])),
  reasons: "Samma enhet, alla fält finns i källan.",
});

test("quotePhoneDigits turns any +46 / 0046 inside running text into the national 0", () => {
  assert.ok(quotePhoneDigits("ring +46 (0)31-123 45 67 idag").includes("0311234567"));
  assert.ok(quotePhoneDigits("Tel: +46 70 123 45 67").includes("0701234567"));
  assert.ok(quotePhoneDigits("Tel 0046-31 123 45 67").includes("0311234567"));
  assert.ok(quotePhoneDigits("tel 031-123 45 67").includes("0311234567"));
  // A 46 that is part of another number is left alone.
  assert.equal(quotePhoneDigits("Byvägen 146, 41101 Göteborg"), "14641101");
});

test("a phone written +46 in the quote is accepted; one missing from the quote is still refused", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-n1", n: 1 });
    const missing = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n1", PAGE_TEXT, "Kontakt: info@gardensmat.se"));
    assert.equal(missing.status, 422);
    assert.ok(missing.json.detail.errors.includes("business_phone_not_in_quote"));
    const ok = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n1"));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });
});

test("an excerpt longer than the cap is refused, not silently cut", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-n2", n: 1 });
    const long = `${PAGE_TEXT} ${"Familjen har drivit gården sedan länge. ".repeat(100)}`;
    assert.ok(long.length > MAX_EXCERPT_CHARS);
    const r = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n2", long));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "excerpt_too_long");
    assert.equal(r.json.detail.max_chars, MAX_EXCERPT_CHARS);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM excerpts").get() as any).n, 0);
});

for (const verdict of ["approve", "reject", "needs_review"] as const) {
  test(`a ${verdict} verdict deletes the candidate's excerpts at once`, async () => {
    const { app, db } = await seeded();
    await withServer(app, async (base) => {
      await call(base, "POST", "/candidates/lease", { run_id: "build-n3", n: 1 });
      const d = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n3"));
      assert.equal(d.status, 200, JSON.stringify(d.json));
      assert.equal((await call(base, "GET", "/stats")).json.excerpts_stored, 1);
      const jl = await call(base, "POST", "/judge/lease", { run_id: "judge-n3", n: 5 });
      assert.equal(jl.json.drafts[0].excerpts.length, 1);
      const fields = Object.keys(draft("x").fields);
      const body =
        verdict === "approve"
          ? approve("judge-n3", fields)
          : { ...approve("judge-n3", fields), verdict, personal_data_found: verdict === "reject" };
      const v = await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, body);
      assert.equal(v.status, 200, JSON.stringify(v.json));
      assert.equal(v.json.excerpts_deleted, 1);
      assert.equal((await call(base, "GET", "/stats")).json.excerpts_stored, 0);
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM excerpts WHERE candidate_id = ?").get(CID) as any).n, 0);
    // The profile fields themselves stay.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE candidate_id = ?").get(CID) as any).n, 1);
  });
}

test("a refused verdict leaves the excerpts in place for the next judge", async () => {
  const { app, db } = await seeded();
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-n4", n: 1 });
    const d = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n4"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-n4", n: 5 });
    const bad = { ...approve("judge-n4", ["display_name"]) };
    assert.equal((await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, bad)).status, 400);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM excerpts").get() as any).n, 1);
});

test("register/search is capped per window and opens again afterwards", async () => {
  let clock = new Date("2026-10-15T22:00:00Z");
  const { app } = await seeded(() => clock);
  await withServer(app, async (base) => {
    const q = `/register/search?name=${encodeURIComponent("Gårdens")}&town=`;
    for (let i = 0; i < REGISTER_SEARCH_MAX; i++) assert.equal((await call(base, "GET", q)).status, 200);
    const over = await call(base, "GET", q);
    assert.equal(over.status, 429);
    assert.equal(over.json.error, "rate_limited");
    assert.ok(over.json.detail.retry_after_s > 0);
    clock = new Date(clock.getTime() + REGISTER_SEARCH_WINDOW_MS + 1000);
    assert.equal((await call(base, "GET", q)).status, 200);
  });
});

test("register/search needs the token like everything else", async () => {
  const { app } = await seeded();
  await withServer(app, async (base) => {
    assert.equal((await call(base, "GET", "/register/search?name=x", undefined, null)).status, 401);
  });
});

test("sample?since= only returns profiles approved after that moment", async () => {
  let clock = new Date("2026-10-15T23:00:00Z");
  const { app } = await seeded(() => clock);
  await withServer(app, async (base) => {
    await call(base, "POST", "/candidates/lease", { run_id: "build-n5", n: 1 });
    const d = await call(base, "POST", `/candidates/${encodeURIComponent(CID)}/draft`, draft("build-n5"));
    await call(base, "POST", "/judge/lease", { run_id: "judge-n5", n: 5 });
    clock = new Date("2026-10-16T01:00:00Z");
    assert.equal((await call(base, "POST", `/drafts/${d.json.draft_id}/verdict`, approve("judge-n5", Object.keys(draft("x").fields)))).status, 200);
    assert.equal((await call(base, "GET", "/sample?n=5&since=2026-10-16T00:00:00Z")).json.profiles.length, 1);
    assert.equal((await call(base, "GET", "/sample?n=5&since=2026-10-16T02:00:00Z")).json.profiles.length, 0);
    assert.equal((await call(base, "GET", "/sample?n=5")).json.profiles.length, 1);
    assert.equal((await call(base, "GET", "/sample?n=5&since=yesterday")).status, 400);
  });
});
