// Personnummer guard (DPIA T7: "aldri i UI, API, MCP, sitemap, logger eller
// eksport … testes automatisk (regex-test på alle utdata)").
//
// A bare digit regex is not enough: Swedish org numbers for legal persons
// (5561234567) and phone numbers (0701234567) have the same shape. A number is
// treated as a personnummer when its YYMMDD part is a real date (day 61–91 =
// samordningsnummer) AND its last digit passes the Luhn check, which every
// personnummer does. Org numbers fail the date test (month digits ≥ 20); about
// one phone number in ten passes both, so callers strip the declared business
// phone before scanning.

function luhnOk(tenDigits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = tenDigits.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function dateOk(yymmdd: string): boolean {
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return false;
  return (dd >= 1 && dd <= 31) || (dd >= 61 && dd <= 91);
}

// Separator between the date and the serial: none, hyphen/plus, any Unicode
// dash, a space, a no-break space or a dot (review 2026-10-13: «800101–1231»
// with an en dash and «800101 1231» slipped through).
const CANDIDATE_RE = /(?<!\d)(?:(19|20)?(\d{6})[-+\u2010-\u2015\u2212 \u00a0\u202f.]?(\d{4}))(?!\d)/g;

export function findPersonnummer(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const ten = m[2] + m[3];
    if (dateOk(m[2]) && luhnOk(ten)) hits.push(m[0]);
  }
  return hits;
}

export function looksLikeSwedishPersonId(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  const ten = d.length === 12 ? d.slice(2) : d;
  return ten.length === 10 && dateOk(ten.slice(0, 6)) && luhnOk(ten);
}
