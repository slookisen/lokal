import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { findPersonnummer, looksLikeSwedishPersonId } from "../src/pii";
import { countyForPostalCode, runSeImport, splitCsv } from "../src/se-import";
import { directSaleSignal } from "../src/keywords";
import { bvFile, makeTestApp, scbFile, sourcesFrom } from "./helpers";

function luhnDigit(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(nine[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
// A syntactically valid (fictitious) personnummer: 1980-01-01, serial 123.
const PNR10 = `800101123${luhnDigit("800101123")}`;
const PNR12 = `19${PNR10}`;

const AB_VG = "5561000011";
const HB_SKANE = "9696000022";
const EK_STHLM = "7696000033";
const AB_REINDEER = "5561000044";
const AB_INACTIVE = "5561000055";
const ENKLA_BOLAG = "9396000066";
const AB_IT = "5561000077";
const AB_SVIN = "5561000088";
const AB_DEREG = "5561000099";
const AB_ADBLOCK = "5561000100";
const AB_SIDE = "5561000111";

function fixtures() {
  const scb = scbFile([
    { PeOrgNr: `16${AB_VG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", Gatuadress: "Byvägen 1", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${HB_SKANE}`, JurForm: "31", FtgStat: "1", Namn: "Skånebryggarna HB", Ng1: "11050", PostNr: "21115", PostOrt: "MALMÖ", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${EK_STHLM}`, JurForm: "51", FtgStat: "1", Namn: "Odlarföreningen ek. för.", Ng1: "01130", PostNr: "11120", PostOrt: "STOCKHOLM", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_REINDEER}`, JurForm: "49", FtgStat: "1", Namn: "Renar AB", Ng1: "01481", PostNr: "98131", PostOrt: "KIRUNA", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_INACTIVE}`, JurForm: "49", FtgStat: "0", Namn: "Vilande AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${ENKLA_BOLAG}`, JurForm: "21", FtgStat: "1", Namn: "Enkelt bolag", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_IT}`, JurForm: "49", FtgStat: "1", Namn: "Kod AB", Ng1: "62010", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_SVIN}`, JurForm: "49", FtgStat: "1", Namn: "Grisgården AB", Ng1: "01460", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_DEREG}`, JurForm: "49", FtgStat: "1", Namn: "Nystart AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_ADBLOCK}`, JurForm: "41", FtgStat: "1", Namn: "Spärrad Gård AB", Ng1: "10110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "2" },
    // Target industry only as a side activity: register index yes, candidate no.
    { PeOrgNr: `16${AB_SIDE}`, JurForm: "49", FtgStat: "1", Namn: "Konsult & Odling AB", Ng1: "70220", Ng2: "01130", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    // Sole trader: the identifier is a personnummer. Must never reach the database.
    { PeOrgNr: PNR12, JurForm: "10", FtgStat: "1", Namn: "Anna Andersson", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
  ]);
  const bv = bvFile([
    { organisationsidentitet: `${AB_VG}$ORGNR-IDORG`, organisationsform: "AB-ORGFO", verksamhetsbeskrivning: "Jordbruk samt gårdsbutik med försäljning av egna produkter." },
    { organisationsidentitet: `${HB_SKANE}$ORGNR-IDORG`, organisationsform: "HB-ORGFO", verksamhetsbeskrivning: 'Bryggeri och\nservering av "öl"; även cider.' },
    { organisationsidentitet: `${AB_SVIN}$ORGNR-IDORG`, organisationsform: "AB-ORGFO", verksamhetsbeskrivning: "Svinproduktion och växtodling." },
    { organisationsidentitet: `${AB_DEREG}$ORGNR-IDORG`, organisationsform: "AB-ORGFO", avregistreringsdatum: "2019-01-01", verksamhetsbeskrivning: "Gårdsbutik och självplock." },
    { organisationsidentitet: `${AB_ADBLOCK}$ORGNR-IDORG`, organisationsform: "AB-ORGFO", verksamhetsbeskrivning: "Charkuteri och försäljning av egenproducerade varor." },
    { organisationsidentitet: `${AB_SIDE}$ORGNR-IDORG`, verksamhetsbeskrivning: "Managementkonsult samt gårdsbutik." },
    { organisationsidentitet: `${PNR12}$PERSONNR-IDORG`, organisationsform: "EF-ORGFO", verksamhetsbeskrivning: "Gårdsbutik." },
  ]);
  return { scb, bv };
}

test("keyword signal keeps the word-start anchor (svinproduktion is not vinproduktion)", () => {
  assert.equal(directSaleSignal("Svinproduktion och växtodling."), null);
  assert.deepEqual(directSaleSignal("Vinproduktion och gårdsbutik")?.b, ["dryck"]);
  assert.equal(directSaleSignal("Konsultverksamhet inom rekonstruktion"), null);
  assert.deepEqual(directSaleSignal("Försäljning via REKO-ring")?.a, ["REKO"]);
});

test("personnummer detection separates org numbers, phone numbers and personnummer", () => {
  assert.equal(looksLikeSwedishPersonId(PNR10), true);
  assert.equal(looksLikeSwedishPersonId(PNR12), true);
  assert.equal(looksLikeSwedishPersonId("5560000001"), false); // org number: month digits 60
  assert.deepEqual(findPersonnummer(`Org.nr 556100-0011, pnr ${PNR10.slice(0, 6)}-${PNR10.slice(6)}`), [`${PNR10.slice(0, 6)}-${PNR10.slice(6)}`]);
});

test("CSV splitter handles quotes, doubled quotes and open quotes", () => {
  assert.deepEqual(splitCsv('"a";"b ""c""";;d', ";"), ["a", 'b "c"', "", "d"]);
  assert.equal(splitCsv('"a;b', ";"), null);
});

test("postal code → county", () => {
  assert.equal(countyForPostalCode("411 01"), "Västra Götaland");
  assert.equal(countyForPostalCode("21115"), "Skåne");
  assert.equal(countyForPostalCode("11120"), "Stockholm");
  assert.equal(countyForPostalCode("123"), null);
});

test("import keeps only active legal persons in scope and never stores a sole trader or personnummer", async () => {
  const { scb, bv } = fixtures();
  const { db, dbFile } = makeTestApp();
  const counts = await runSeImport(db, sourcesFrom(scb, bv), { importId: "imp-1", now: () => new Date("2026-10-13T10:00:00Z") });

  const units = db.prepare("SELECT org_nr, legal_form, county, ad_block, signal FROM register_units ORDER BY org_nr").all() as any[];
  const orgs = units.map((u) => u.org_nr);
  assert.deepEqual(orgs.sort(), [AB_VG, AB_SVIN, AB_DEREG, AB_ADBLOCK, EK_STHLM, HB_SKANE, AB_SIDE].sort());
  assert.ok(!orgs.includes(AB_REINDEER), "reindeer herding as main SNI is out");
  assert.ok(!orgs.includes(AB_INACTIVE), "FtgStat 0 is out");
  assert.ok(!orgs.includes(ENKLA_BOLAG), "enkla bolag is out");
  assert.ok(!orgs.includes(AB_IT), "SNI outside 01/03/10/11 is out");
  assert.equal(counts.in_scope_units, 7);
  assert.equal(units.find((u) => u.org_nr === AB_SIDE).signal, null, "side-activity units are indexed but not candidates");

  const cands = db.prepare("SELECT candidate_id, priority FROM candidates ORDER BY priority, candidate_id").all() as any[];
  assert.deepEqual(
    cands.map((c) => [c.candidate_id, c.priority]),
    [
      [`se:${AB_VG}`, 10],
      [`se:${AB_ADBLOCK}`, 10],
      [`se:${HB_SKANE}`, 21],
    ],
  );
  const adBlock = units.find((u) => u.org_nr === AB_ADBLOCK);
  assert.equal(adBlock.ad_block, 1);
  const hb = units.find((u) => u.org_nr === HB_SKANE);
  assert.deepEqual(JSON.parse(hb.signal).b, ["dryck"], "multi-line quoted description is parsed");
  assert.equal(units.find((u) => u.org_nr === AB_DEREG).signal, null, "deregistered Bolagsverket rows are ignored");

  // No personnummer anywhere in the database files, nor the sole trader's name.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const raw = Buffer.concat([fs.readFileSync(dbFile), fs.existsSync(`${dbFile}-wal`) ? fs.readFileSync(`${dbFile}-wal`) : Buffer.alloc(0)]).toString("latin1");
  assert.ok(!raw.includes(PNR10), "personnummer must not be stored");
  assert.ok(!raw.includes("Anna Andersson"), "sole trader name must not be stored");
});

test("import fails clearly when a required column is missing", async () => {
  const { db } = makeTestApp();
  const scb = Buffer.from("PeOrgNr\tJurForm\n161234567890\t49\n", "latin1");
  await assert.rejects(runSeImport(db, sourcesFrom(scb, bvFile([])), { importId: "imp-x", now: () => new Date() }), /SCB: missing required column/);
});

test("re-import deactivates units that left the register; a truncated file does not mass-exclude", async () => {
  const { scb, bv } = fixtures();
  const { db } = makeTestApp();
  await runSeImport(db, sourcesFrom(scb, bv), { importId: "imp-1", now: () => new Date("2026-10-13T10:00:00Z") });

  // Second import without the Skåne HB and the side-activity AB (5 of 7 seen → deactivation runs).
  const scb2 = scbFile([
    { PeOrgNr: `16${AB_VG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${EK_STHLM}`, JurForm: "51", FtgStat: "1", Namn: "Odlarföreningen ek. för.", Ng1: "01130", PostNr: "11120", PostOrt: "STOCKHOLM", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_SVIN}`, JurForm: "49", FtgStat: "1", Namn: "Grisgården AB", Ng1: "01460", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_DEREG}`, JurForm: "49", FtgStat: "1", Namn: "Nystart AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" },
    { PeOrgNr: `16${AB_ADBLOCK}`, JurForm: "41", FtgStat: "1", Namn: "Spärrad Gård AB", Ng1: "10110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "2" },
  ]);
  const c2 = await runSeImport(db, sourcesFrom(scb2, bv), { importId: "imp-2", now: () => new Date("2026-10-20T10:00:00Z") });
  assert.equal(c2.deactivated_units, 2); // the Skåne HB and the side-activity AB
  const hb = db.prepare("SELECT status, status_reason FROM candidates WHERE candidate_id = ?").get(`se:${HB_SKANE}`) as any;
  assert.deepEqual(hb, { status: "excluded", status_reason: "register_inactive" });

  // Third import sees only one unit: deactivation must be skipped.
  const scb3 = scbFile([{ PeOrgNr: `16${AB_VG}`, JurForm: "49", FtgStat: "1", Namn: "Gårdens Mat AB", Ng1: "01110", PostNr: "41101", PostOrt: "GÖTEBORG", Reklamsparrtyp: "1" }]);
  const c3 = await runSeImport(db, sourcesFrom(scb3, bv), { importId: "imp-3", now: () => new Date("2026-10-27T10:00:00Z") });
  assert.ok(c3.deactivation_skipped);
  const active = (db.prepare("SELECT COUNT(*) AS n FROM register_units WHERE active = 1").get() as any).n;
  assert.equal(active, 5);
});
