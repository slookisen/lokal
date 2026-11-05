/**
 * debio-register-s1d.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S1d: manual Debio register
 * link (POST /admin/debio/match-review/manual) + the name-tagline root cause.
 *
 *   input     auth required; missing agent_id / debio_sid / reason → 400;
 *             unknown agent → 404; unknown sid → 404; inactive agent → 409;
 *             the route is not shadowed by /match-review/:id.
 *   dry run   default (and apply:"true" is not true): nothing written; the
 *             response has the candidate built like the sync's (entity_key,
 *             status, validity, groups, org.nr.), method manual, reasons.
 *   apply     okologisk + valid certificate → verified 1 (method review,
 *             change log); karens → no badge; auto.debio off → no badge; an
 *             earlier approval for another entity is withdrawn; a rejected
 *             pair is replaced; a secondary sid of an org.nr. entity resolves
 *             to the same entity_key the sync uses.
 *   next sync the link is kept (org.nr. entity and sid-only entity), no new
 *             pending row for the agent.
 *   privacy   no Debio person name / street in any table or response.
 *   tagline   «Moe Gård — Bringebær fra Moe» vs the register's «Moe Gård»:
 *             a pending review candidate, never a status (root cause, item
 *             3); the full-name path is unchanged («Lie Gård — Lie Honning»
 *             keeps its match), a stripped-only hit never badges («Berg -
 *             Andersen bakeri og kafe» vs «Berg»).
 *
 * In-memory DB on the production schema, injected fake fetch (no network).
 * Exported runDebioRegisterS1dTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/debio-register-s1d.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-05T12:00:00.000Z");
const FUTURE = "2027-06-30";
const PAST = "2026-09-30";
// Synthetic Debio person name + street — must never be stored or returned.
const PERSON = "Qwzyrolf Personsen";
const STREET = "Hemmeligveien 93";

type Raw = Record<string, unknown>;

function fillerRows(n: number): Raw[] {
  const out: Raw[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: `Fyllvirksomhet ${i}`, clientCode: String(800000000 + i), certSid: 100000 + i, postalCode: "9990", city: "Fyllby", street: `Fyllgata ${i}`, statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] });
  }
  return out;
}

function registerRows(): Raw[] {
  return [
    ...fillerRows(2500),
    // okologisk, org.nr. entity with two sids: 6001 (valid) + 6002 (expired okologisk)
    { name: PERSON, clientCode: "931000001", certSid: 6001, postalCode: "3101", city: "Manuby", street: STREET, statusCodes: [509], validFrom: "2026-01-01", validTo: FUTURE, mainProductGroups: ["LBP", "FIO"] },
    { name: PERSON, clientCode: "931000001", certSid: 6002, postalCode: "3101", city: "Manuby", street: STREET, statusCodes: [509], validTo: PAST, mainProductGroups: ["LBP"] },
    // karens
    { name: "Overgangsbruket Zqv", clientCode: "931000003", certSid: 6003, postalCode: "3103", city: "Karby", statusCodes: [503], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // okologisk, for the auto.debio-off agent
    { name: "Avbryterbruket Zqv", clientCode: "931000004", certSid: 6004, postalCode: "3104", city: "Avby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // okologisk without an org.nr. → entity key «sid:6005»
    { name: "Utenorgnr Zqv", certSid: 6005, postalCode: "3105", city: "Sidby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["FIO"] },
    // two okologisk entries for the withdrawal case
    { name: "Forstevalg Zqv", clientCode: "931000006", certSid: 6006, postalCode: "3106", city: "Byttby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    { name: "Andrevalg Zqv", clientCode: "931000007", certSid: 6007, postalCode: "3107", city: "Byttby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // root cause: register name «Moe Gård», same postal code as our profile
    { name: "Moe Gård", clientCode: "931000008", certSid: 6008, postalCode: "3108", city: "Bærby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    // review B1 guards: «Lie Honning» (okologisk) + «Lie Gård» (karens) at 3108;
    // a separate «Berg» (okologisk) at 3110
    { name: "Lie Honning", clientCode: "931000009", certSid: 6009, postalCode: "3108", city: "Bærby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["LBP"] },
    { name: "Lie Gård", clientCode: "931000010", certSid: 6010, postalCode: "3108", city: "Bærby", statusCodes: [503], validTo: FUTURE, mainProductGroups: ["LBP"] },
    { name: "Berg", clientCode: "931000011", certSid: 6011, postalCode: "3110", city: "Bergby", statusCodes: [509], validTo: FUTURE, mainProductGroups: ["FIO"] },
  ];
}

function fakeFetch(rows: Raw[] | "fail"): typeof fetch {
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("getcertificates")) {
      if (rows === "fail") return new Response("err", { status: 503 });
      return new Response(JSON.stringify({ certificates: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("finnoko.debio.no/api/acm/companies")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

interface Seed { id: string; name: string; city: string; postal?: string; active?: number }

// Names and places chosen so the sync itself never matches them to the
// register (only the manual link does) — except m-moe, the root-cause case.
const AGENTS: Seed[] = [
  { id: "m-oko", name: "Lerketun Grønt", city: "Annenby" },
  { id: "m-karens", name: "Spireli Grønt", city: "Annenby" },
  { id: "m-off", name: "Brytertun Grønt", city: "Annenby" },
  { id: "m-sid", name: "Sidesprang Grønt", city: "Annenby" },
  { id: "m-swap", name: "Byttetun Grønt", city: "Annenby" },
  { id: "m-rejected", name: "Avvistun Grønt", city: "Annenby" },
  { id: "m-inactive", name: "Sovetun Grønt", city: "Annenby", active: 0 },
  { id: "m-moe", name: "Moe Gård — Bringebær fra Moe", city: "Bærby", postal: "3108" },
  { id: "m-lie", name: "Lie Gård — Lie Honning", city: "Bærby", postal: "3108" },
  { id: "m-berg", name: "Berg - Andersen bakeri og kafe", city: "Bergby", postal: "3110" },
];

function seed(db: Database.Database, a: Seed): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, org_nr)
     VALUES (?, ?, 'Familiegård.', 'test', ?, ?, 'producer', ?, 59.9, 10.7, ?, '["vegetables"]', '["gårdsutsalg"]', '[]', 0.7, ?, 1, 'discovery', 'rfb', 0, 0, NULL)`,
  ).run(a.id, a.name, `post@${a.id}.example.no`, `https://${a.id}.example.no`, `key-${a.id}`, a.city, a.active ?? 1);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, address, postal_code, about, products, specialties, certifications,
        verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, NULL, ?, 'Vi selger grønnsaker.', '[]', '[]', '[]', 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(a.id, `post@${a.id}.example.no`, `https://${a.id}.example.no`, a.postal ?? null);
}

export async function runDebioRegisterS1dTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };
  const assertTrue = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const sync = require("./debio-register-sync") as typeof import("./debio-register-sync");
  const client = require("./debio-register-client") as typeof import("./debio-register-client");

  // ── tagline (root cause) — pure ─────────────────────────────────────────
  assertEq(sync.nameWithoutTagline("Moe Gård — Bringebær fra Moe"), "Moe Gård", "tagline-1: em dash tagline dropped");
  assertEq(sync.nameWithoutTagline("Lindheim Gård - Testvik"), "Lindheim Gård", "tagline-2: spaced hyphen");
  assertEq(sync.nameWithoutTagline("Øvre Moe – gårdsbutikk"), "Øvre Moe", "tagline-3: en dash");
  assertEq(sync.nameWithoutTagline("Hansen-Gård"), null, "tagline-4: unspaced hyphen is part of the name");
  assertEq(sync.nameWithoutTagline("Moe Gård"), null, "tagline-5: no dash → null");
  assertEq(sync.nameWithoutTagline("— Moe"), null, "tagline-6: nothing before the dash → null");

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  const prevWarn = console.warn;
  const ENV_KEYS = ["OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "ADMIN_KEY"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  let routeMod: any = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const a of AGENTS) seed(db, a);
    process.env.OWNER_FEATURES_ENFORCE = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "rfb:m-off";
    db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', 'm-off', 'auto.debio', 'false', 'admin', 1, ?)`).run(NOW.toISOString());
    process.env.ADMIN_KEY = "s1d-admin-key";
    const ADMIN = process.env.ADMIN_KEY;

    try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
    routeMod = require("../routes/admin-debio-cross-check");
    const adminRouter = routeMod.default as any;
    routeMod.__setManualLinkFetchForTesting(fakeFetch(registerRows()));
    const layerIndex = (path: string) => (adminRouter.stack as any[]).findIndex((x: any) => x.route && x.route.path === path && x.route.methods?.post);
    assertTrue(layerIndex("/match-review/manual") >= 0 && layerIndex("/match-review/manual") < layerIndex("/match-review/:id"), "route-1: /match-review/manual registered before /match-review/:id");
    const manual = (() => {
      const l = (adminRouter.stack as any[])[layerIndex("/match-review/manual")];
      return l.route.stack[l.route.stack.length - 1].handle as Function;
    })();
    const call = (body: any, headers: any = { "x-admin-key": ADMIN }) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      Promise.resolve(manual({ headers, query: {}, params: {}, body }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
    });

    const snapshot = () => JSON.stringify([
      db.prepare("SELECT id, debio_verified, debio_verified_at FROM agents ORDER BY id").all(),
      db.prepare("SELECT * FROM agent_debio_status ORDER BY agent_id").all(),
      db.prepare("SELECT * FROM debio_match_review ORDER BY id").all(),
      db.prepare("SELECT * FROM debio_status_changes ORDER BY id").all(),
    ]);
    const state = (id: string) => db.prepare(`SELECT s.debio_status, a.debio_verified, s.debio_match_method, s.debio_sid, s.debio_cert_valid_to
      FROM agents a LEFT JOIN agent_debio_status s ON s.agent_id = a.id WHERE a.id = ?`).get(id) as any;
    const responses: string[] = [];

    // ── input ─────────────────────────────────────────────────────────────
    const before0 = snapshot();
    const noKey = await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x" }, {});
    assertEq(noKey.status, 403, "auth-1: no X-Admin-Key → 403");
    const wrongKey = await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x" }, { "x-admin-key": "nope" });
    assertEq(wrongKey.status, 403, "auth-2: wrong X-Admin-Key → 403");
    assertEq((await call({ debio_sid: "6001", reason: "x" })).status, 400, "input-1: missing agent_id → 400");
    assertEq((await call({ agent_id: "m-oko", reason: "x" })).status, 400, "input-2: missing debio_sid → 400");
    assertEq((await call({ agent_id: "m-oko", debio_sid: "6001" })).status, 400, "input-3: missing reason → 400");
    assertEq((await call({ agent_id: "m-oko", debio_sid: "6001", reason: "   " })).status, 400, "input-4: blank reason → 400");
    assertEq((await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x".repeat(501) })).status, 400, "input-5: over-long reason → 400");
    assertEq((await call({ agent_id: "m-ukjent", debio_sid: "6001", reason: "x" })).status, 404, "input-6: unknown agent_id → 404");
    const unknownSid = await call({ agent_id: "m-oko", debio_sid: "999999", reason: "x", apply: true });
    assertEq([unknownSid.status, unknownSid.body.error], [404, "debio_sid not in the register"], "input-7: unknown sid → 404");
    assertEq((await call({ agent_id: "m-inactive", debio_sid: "6001", reason: "x", apply: true })).status, 409, "input-8: inactive agent → 409");
    routeMod.__setManualLinkFetchForTesting(fakeFetch(registerRows().slice(2400)));
    const few = await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x", apply: true });
    assertTrue(few.status === 502 && /too few rows/.test(few.body.detail ?? ""), "input-9: register below the minimum rows → 502", few.body);
    routeMod.__setManualLinkFetchForTesting(fakeFetch("fail"));
    assertEq((await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x", apply: true })).status, 502, "input-10: register fetch fails → 502");
    routeMod.__setManualLinkFetchForTesting(fakeFetch(registerRows()));
    assertEq(snapshot(), before0, "input-11: rejected requests write nothing");

    // ── dry run ───────────────────────────────────────────────────────────
    const dry = await call({ agent_id: "m-oko", debio_sid: "6001", reason: "finnoko-domene, sjekket manuelt" });
    responses.push(JSON.stringify(dry.body));
    assertEq(dry.status, 200, "dry-1: 200");
    assertEq(dry.body.dry_run, true, "dry-2: dry run is the default");
    assertEq(dry.body.candidate, {
      entity_key: "931000001", debio_sid: "6001", org_nr: "931000001", status: "okologisk", cert_valid_to: FUTURE,
      product_groups: ["LBP", "FIO"], postal_code: "3101", city: "manuby", match_method: "manual", score: 1,
      reasons: ["manual: finnoko-domene, sjekket manuelt"],
    }, "dry-3: candidate built like the sync's (key, status, validity, groups, org.nr.), method manual");
    assertEq([dry.body.verified, dry.body.owner_switch_off, dry.body.replaces, dry.body.withdraws], [1, false, null, null], "dry-4: would be verified, replaces nothing");
    const dryStr = await call({ agent_id: "m-oko", debio_sid: "6001", reason: "x", apply: "true" });
    assertEq(dryStr.body.dry_run, true, "dry-5: apply \"true\" (string) is still a dry run");
    assertEq(snapshot(), before0, "dry-6: dry run writes nothing");

    // The candidate's entity_key is the one the sync's entity has.
    const fetched = await client.fetchDebioRegister({ fetchImpl: fakeFetch(registerRows()), env: {}, now: NOW });
    const ents = sync.buildEntities(fetched.rows, NOW);
    assertEq(ents.find((e) => e.sid === "6001")?.key, dry.body.candidate.entity_key, "key-1: entity_key = the sync's entity key");
    const viaSecond = await call({ agent_id: "m-oko", debio_sid: "6002", reason: "x" });
    assertEq([viaSecond.body.candidate.entity_key, viaSecond.body.candidate.debio_sid, viaSecond.body.candidate.status], ["931000001", "6001", "okologisk"],
      "key-2: a secondary (expired) sid resolves to the same entity, its canonical sid and status");

    // ── apply ─────────────────────────────────────────────────────────────
    const opts = { fetchImpl: fakeFetch(registerRows()), now: NOW };
    const oko = await sync.manualDebioLink(db, { agent_id: "m-oko", debio_sid: "6001", reason: "finnoko-domene", apply: true }, opts);
    responses.push(JSON.stringify(oko));
    assertTrue(oko.ok && oko.dry_run === false && oko.verified === 1, "apply-1: okologisk + valid certificate → verified 1", oko);
    assertEq([state("m-oko").debio_status, state("m-oko").debio_verified, state("m-oko").debio_match_method, state("m-oko").debio_sid, state("m-oko").debio_cert_valid_to],
      ["okologisk", 1, "review", "6001", FUTURE], "apply-2: agent state as an approved review");
    const rr = db.prepare("SELECT * FROM debio_match_review WHERE agent_id = 'm-oko'").all() as any[];
    assertEq(rr.map((r) => [r.entity_key, r.match_method, r.state, JSON.parse(r.reasons)]), [["931000001", "manual", "approved", ["manual: finnoko-domene"]]], "apply-3: one approved manual review row");
    const ch = db.prepare("SELECT old_verified, new_status, new_verified, reason, source FROM debio_status_changes WHERE agent_id = 'm-oko'").all() as any[];
    assertEq(ch.map((c) => [c.old_verified, c.new_status, c.new_verified, c.reason, c.source]), [[0, "okologisk", 1, "review_approved", "review"]], "apply-4: logged as a review approval");

    const karens = await sync.manualDebioLink(db, { agent_id: "m-karens", debio_sid: 6003, reason: "e-post", apply: true }, opts);
    assertTrue(karens.ok && karens.verified === 0, "karens-1: karens → no badge", karens);
    assertEq([state("m-karens").debio_status, state("m-karens").debio_verified], ["karens", 0], "karens-2: status karens, not verified");

    const off = await sync.manualDebioLink(db, { agent_id: "m-off", debio_sid: "6004", reason: "navn", apply: true }, opts);
    assertTrue(off.ok && off.verified === 0 && off.owner_switch_off === true, "off-1: auto.debio off → no badge", off);
    assertEq([state("m-off").debio_status, state("m-off").debio_verified], ["okologisk", 0], "off-2: status okologisk, not verified");

    const sidOnly = await sync.manualDebioLink(db, { agent_id: "m-sid", debio_sid: "6005", reason: "ingen org.nr.", apply: true }, opts);
    assertTrue(sidOnly.ok && sidOnly.candidate.entity_key === "sid:6005" && sidOnly.verified === 1, "sid-1: entity without org.nr. → key sid:6005, verified", sidOnly);

    // withdrawal: an earlier approval for another entity goes back to pending
    const first = await sync.manualDebioLink(db, { agent_id: "m-swap", debio_sid: "6006", reason: "først", apply: true }, opts);
    const swapDry = await sync.manualDebioLink(db, { agent_id: "m-swap", debio_sid: "6007", reason: "riktig" }, opts);
    assertTrue(swapDry.ok && swapDry.withdraws?.entity_key === "931000006" && swapDry.withdraws?.state === "approved", "swap-1: dry run names the approval it would withdraw", swapDry);
    const swap = await sync.manualDebioLink(db, { agent_id: "m-swap", debio_sid: "6007", reason: "riktig", apply: true }, opts);
    const swapRows = db.prepare("SELECT entity_key, state FROM debio_match_review WHERE agent_id = 'm-swap' ORDER BY id").all() as any[];
    assertTrue(first.ok && swap.ok, "swap-2: both links applied");
    assertEq(swapRows.map((r) => [r.entity_key, r.state]), [["931000006", "pending"], ["931000007", "approved"]], "swap-3: earlier approval withdrawn, new one approved");
    assertEq(state("m-swap").debio_sid, "6007", "swap-4: agent follows the new link");

    // a rejected pair: the manual link replaces it (same agent + entity row)
    db.prepare(`INSERT INTO debio_match_review (agent_id, entity_key, debio_sid, org_nr, status, match_method, score, reasons, state, first_seen_at, last_seen_at, decided_at)
      VALUES ('m-rejected', '931000004', '6004', '931000004', 'okologisk', 'name', 0.5, '["name_city"]', 'rejected', ?, ?, ?)`).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const rejDry = await sync.manualDebioLink(db, { agent_id: "m-rejected", debio_sid: "6004", reason: "feil avvist" }, opts);
    assertTrue(rejDry.ok && rejDry.replaces?.state === "rejected" && rejDry.replaces?.match_method === "name", "replace-1: dry run names the row it replaces", rejDry);
    const rej = await sync.manualDebioLink(db, { agent_id: "m-rejected", debio_sid: "6004", reason: "feil avvist", apply: true }, opts);
    const rejRows = db.prepare("SELECT match_method, state, reasons FROM debio_match_review WHERE agent_id = 'm-rejected'").all() as any[];
    assertTrue(rej.ok && rej.verified === 1, "replace-2: applied, verified", rej);
    assertEq(rejRows.map((r) => [r.match_method, r.state, JSON.parse(r.reasons)]), [["manual", "approved", ["manual: feil avvist"]]], "replace-3: same row, now manual + approved");

    // ── next sync keeps the links ───────────────────────────────────────────
    const r1 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(registerRows()), dryRun: false, now: new Date(NOW.getTime() + 86_400_000), skipCache: true });
    assertTrue(r1.accepted, "sync-1: accepted");
    for (const [id, sid, verified] of [["m-oko", "6001", 1], ["m-sid", "6005", 1], ["m-karens", "6003", 0], ["m-off", "6004", 0], ["m-swap", "6007", 1], ["m-rejected", "6004", 1]] as Array<[string, string, number]>) {
      const s = state(id);
      assertEq([s.debio_match_method, s.debio_sid, s.debio_verified], ["review", sid, verified], `sync-keep: ${id} keeps the manual link after a sync`);
    }
    for (const id of ["m-oko", "m-sid", "m-karens", "m-off", "m-rejected"]) {
      const rows = db.prepare("SELECT state, COUNT(*) AS n FROM debio_match_review WHERE agent_id = ? GROUP BY state ORDER BY state").all(id) as any[];
      assertEq(rows.map((r) => [r.state, r.n]), [["approved", 1]], `sync-no-new-pending: ${id} has only its approved row`);
    }
    const r2 = await sync.syncDebioRegister(db, { fetchImpl: fakeFetch(registerRows().filter((r) => r.certSid !== 6001 && r.certSid !== 6002)), dryRun: false, now: new Date(NOW.getTime() + 2 * 86_400_000), skipCache: true });
    assertEq([r2.accepted, state("m-oko").debio_status, state("m-oko").debio_verified], [true, "ingen", 0], "sync-gone: entry gone from the register → reset like any approval");

    // ── root cause: tagline in our profile name ─────────────────────────────
    const pending = (id: string) => (db.prepare("SELECT entity_key, match_method, reasons FROM debio_match_review WHERE agent_id = ? AND state = 'pending' ORDER BY id").all(id) as any[])
      .map((r) => [r.entity_key, r.match_method, JSON.parse(r.reasons)]);
    assertEq([state("m-moe").debio_status, state("m-moe").debio_verified, state("m-moe").debio_match_method], ["ingen", 0, null],
      "rootcause-1: «Moe Gård — Bringebær fra Moe» vs register «Moe Gård» — no status from a tagline-stripped hit");
    assertEq(pending("m-moe"), [["931000008", "name", ["name_tagline_postal"]]], "rootcause-2: … but a pending review candidate (name_tagline_postal)");
    assertEq([state("m-berg").debio_status, state("m-berg").debio_verified, state("m-berg").debio_match_method], ["ingen", 0, null],
      "b1-berg-1: «Berg - Andersen bakeri og kafe» vs a separate register «Berg» at the same postal code → no badge");
    assertEq(pending("m-berg"), [["931000011", "name", ["name_tagline_postal"]]], "b1-berg-2: stripped-only hit is a pending review candidate");
    assertEq([state("m-lie").debio_status, state("m-lie").debio_verified, state("m-lie").debio_match_method, state("m-lie").debio_sid], ["okologisk", 1, "name_postal", "6009"],
      "b1-lie-1: «Lie Gård — Lie Honning» keeps the full-name match to «Lie Honning» (as on main)");
    assertEq(pending("m-lie"), [], "b1-lie-2: the stripped name «Lie Gård» does not add a hit when the full name has one");

    // ── privacy ─────────────────────────────────────────────────────────────
    const leaks: string[] = [];
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((t) => t.name as string);
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map((c) => c.name as string);
      for (const c of cols) {
        const hit = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE CAST("${c}" AS TEXT) LIKE ? OR CAST("${c}" AS TEXT) LIKE ?`).get("%Qwzyrolf%", "%Hemmeligveien%") as any;
        if (hit.n > 0) leaks.push(`${t}.${c}`);
      }
    }
    assertEq(leaks, [], "privacy-1: no Debio person name or street in any table");
    assertTrue(responses.every((r) => !r.includes("Qwzyrolf") && !r.includes("Hemmeligveien")), "privacy-2: no Debio person name or street in the responses");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    try { routeMod?.__setManualLinkFetchForTesting(undefined); } catch { /* not loaded */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioRegisterS1dTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
