// ─── Product-name glossary (Daniel 2026-09-03: «ja kjør ordlisten for
//     produktene også») ─────────────────────────────────────────────────────
//
// Producers write their product lists in Norwegian, and most of them write
// the same few hundred words: a 2026-09-03 sample of 526 producers (1 958
// product entries, 1 016 distinct names) had generic category words on top
// ("grønnsaker", "kjøtt", "honning", "egg" …) and then a long tail of plain
// food nouns (poteter, lammekjøtt, eplemost, fenalår …). On an English page
// those should read as English — «det er jo samme produkt».
//
// Rules, in order — see translateProductName():
//   1. Norwegian: always the producer's own text, byte for byte.
//   2. A name that is EXACTLY a category word renders as that category's
//      label (handled by the caller through catLabel; this module does not
//      know CATEGORY_MAP).
//   3. Exact phrase in PHRASES (case-insensitive, trimmed).
//   4. Word by word — ONLY when every word is known (WORDS, PHRASES, or a
//      pass-through token such as a number, "og"/"og" → "and", a parenthesis
//      group that is itself known). One unknown word → the whole name is
//      returned unchanged. A half-translated "økologisk storfekjøtt & sausages"
//      is worse than a Norwegian one.
//   5. Anything else: unchanged.
//
// Swedish gets an entry only where the session is sure; a missing sv value
// falls back to the NORWEGIAN original, never to English (no mixed pages).
//
// Add words here, not special cases in templates. Keys are lower-case
// Norwegian; values are lower-case too (capitalisation is restored from the
// input: "Kjøtt" → "Meat", "kjøtt" → "meat").

import type { Lang } from "./t";

type Entry = { en: string; sv?: string };

/** Multi-word phrases and fixed expressions (checked before word-by-word). */
export const PRODUCT_PHRASES: Record<string, Entry> = {
  "lokal mat": { en: "local food", sv: "lokal mat" },
  "kjøtt og egg": { en: "meat and eggs", sv: "kött och ägg" },
  "bakevarer og honning": { en: "baked goods and honey", sv: "bakverk och honung" },
  "brød og bakevarer": { en: "bread and baked goods", sv: "bröd och bakverk" },
  "syltetøy og hermetikk": { en: "jams and preserves", sv: "sylt och konserver" },
  "egg fra frittgående høner": { en: "free-range eggs", sv: "ägg från frigående höns" },
  "frittgående høner": { en: "free-range hens", sv: "frigående höns" },
  "kjøtt fra villsau": { en: "wild sheep meat", sv: "kött från vildfår" },
  "grønnsaker i sesong": { en: "seasonal vegetables", sv: "säsongens grönsaker" },
  "frukt og bær": { en: "fruit and berries", sv: "frukt och bär" },
  "frukt og grønt": { en: "fruit and vegetables", sv: "frukt och grönt" },
  "ost og meieriprodukter": { en: "cheese and dairy products", sv: "ost och mejeriprodukter" },
  "kjøtt og spekemat": { en: "meat and cured meats", sv: "kött och charkuterier" },
  "honning og bieprodukter": { en: "honey and bee products", sv: "honung och biprodukter" },
  "kaffe og te": { en: "coffee and tea", sv: "kaffe och te" },
  "øl og sider": { en: "beer and cider", sv: "öl och cider" },
  "saft og sirup": { en: "juice and syrup", sv: "saft och sirap" },
  "selvplukk": { en: "pick-your-own", sv: "självplock" },
  "(selvplukk)": { en: "(pick-your-own)", sv: "(självplock)" },
  "gårdsbutikk": { en: "farm shop", sv: "gårdsbutik" },
  "reko-ring": { en: "REKO ring", sv: "REKO-ring" },
};

/** Single words. Plurals/definite forms listed explicitly where they occur. */
export const PRODUCT_WORDS: Record<string, Entry> = {
  // categories as plain words (the caller maps exact category words first;
  // these cover the same words INSIDE longer names)
  grønnsaker: { en: "vegetables", sv: "grönsaker" }, grønsaker: { en: "vegetables", sv: "grönsaker" },
  frukt: { en: "fruit", sv: "frukt" }, bær: { en: "berries", sv: "bär" },
  meieri: { en: "dairy", sv: "mejeri" }, meieriprodukter: { en: "dairy products", sv: "mejeriprodukter" },
  egg: { en: "eggs", sv: "ägg" }, kjøtt: { en: "meat", sv: "kött" }, fisk: { en: "fish", sv: "fisk" },
  brød: { en: "bread", sv: "bröd" }, honning: { en: "honey", sv: "honung" }, urter: { en: "herbs", sv: "örter" },
  bakervarer: { en: "baked goods", sv: "bakverk" }, bakevarer: { en: "baked goods", sv: "bakverk" },
  bakeri: { en: "bakery", sv: "bageri" }, drikke: { en: "beverages", sv: "dryck" },
  syltetøy: { en: "jam", sv: "sylt" }, hermetikk: { en: "preserves", sv: "konserver" },
  // vegetables
  poteter: { en: "potatoes", sv: "potatis" }, potet: { en: "potato", sv: "potatis" },
  gulrot: { en: "carrot", sv: "morot" }, gulrøtter: { en: "carrots", sv: "morötter" },
  løk: { en: "onions", sv: "lök" }, purre: { en: "leek", sv: "purjolök" }, kål: { en: "cabbage", sv: "kål" },
  hodekål: { en: "cabbage", sv: "vitkål" }, blomkål: { en: "cauliflower", sv: "blomkål" },
  brokkoli: { en: "broccoli", sv: "broccoli" }, salat: { en: "lettuce", sv: "sallad" },
  tomater: { en: "tomatoes", sv: "tomater" }, tomat: { en: "tomato", sv: "tomat" },
  agurk: { en: "cucumber", sv: "gurka" }, squash: { en: "squash", sv: "squash" },
  gresskar: { en: "pumpkin", sv: "pumpa" }, rødbeter: { en: "beetroot", sv: "rödbetor" },
  kålrot: { en: "swede", sv: "kålrot" }, sellerirot: { en: "celeriac", sv: "rotselleri" },
  pastinakk: { en: "parsnip", sv: "palsternacka" }, asparges: { en: "asparagus", sv: "sparris" },
  erter: { en: "peas", sv: "ärtor" }, bønner: { en: "beans", sv: "bönor" }, mais: { en: "sweetcorn", sv: "majs" },
  spinat: { en: "spinach", sv: "spenat" }, grønnkål: { en: "kale", sv: "grönkål" },
  sesonggrønnsaker: { en: "seasonal vegetables", sv: "säsongsgrönsaker" },
  mikrogrønt: { en: "microgreens", sv: "mikrogrönt" }, sopp: { en: "mushrooms", sv: "svamp" },
  hvitløk: { en: "garlic", sv: "vitlök" }, chili: { en: "chilli", sv: "chili" },
  // fruit & berries
  epler: { en: "apples", sv: "äpplen" }, eple: { en: "apple", sv: "äpple" },
  pærer: { en: "pears", sv: "päron" }, plommer: { en: "plums", sv: "plommon" },
  kirsebær: { en: "cherries", sv: "körsbär" }, moreller: { en: "cherries", sv: "bigarråer" },
  jordbær: { en: "strawberries", sv: "jordgubbar" }, bringebær: { en: "raspberries", sv: "hallon" },
  blåbær: { en: "blueberries", sv: "blåbär" }, tyttebær: { en: "lingonberries", sv: "lingon" },
  multer: { en: "cloudberries", sv: "hjortron" }, solbær: { en: "blackcurrants", sv: "svarta vinbär" },
  rips: { en: "redcurrants", sv: "röda vinbär" }, stikkelsbær: { en: "gooseberries", sv: "krusbär" },
  tranebær: { en: "cranberries", sv: "tranbär" }, rabarbra: { en: "rhubarb", sv: "rabarber" },
  // dairy
  ost: { en: "cheese", sv: "ost" }, oster: { en: "cheeses", sv: "ostar" },
  geiteost: { en: "goat cheese", sv: "getost" }, geitost: { en: "goat cheese", sv: "getost" }, brunost: { en: "brown cheese", sv: "brunost" },
  gammelost: { en: "gammelost", sv: "gammelost" }, hvitost: { en: "white cheese", sv: "vitost" },
  yoghurt: { en: "yoghurt", sv: "yoghurt" }, smør: { en: "butter", sv: "smör" },
  rømme: { en: "sour cream", sv: "gräddfil" }, fløte: { en: "cream", sv: "grädde" },
  melk: { en: "milk", sv: "mjölk" }, geitemelk: { en: "goat milk", sv: "getmjölk" },
  kefir: { en: "kefir", sv: "kefir" }, skyr: { en: "skyr", sv: "skyr" }, iskrem: { en: "ice cream", sv: "glass" },
  is: { en: "ice cream", sv: "glass" },
  // meat
  lammekjøtt: { en: "lamb", sv: "lammkött" }, lam: { en: "lamb", sv: "lamm" },
  storfekjøtt: { en: "beef", sv: "nötkött" }, storfe: { en: "beef", sv: "nötkött" }, okse: { en: "beef", sv: "oxkött" },
  svinekjøtt: { en: "pork", sv: "fläskkött" }, gris: { en: "pork", sv: "gris" },
  kalvekjøtt: { en: "veal", sv: "kalvkött" }, kylling: { en: "chicken", sv: "kyckling" },
  kalkun: { en: "turkey", sv: "kalkon" }, and: { en: "duck", sv: "anka" }, gås: { en: "goose", sv: "gås" },
  vilt: { en: "game", sv: "vilt" }, elg: { en: "moose", sv: "älg" }, hjort: { en: "venison", sv: "hjort" },
  rein: { en: "reindeer", sv: "ren" }, reinsdyr: { en: "reindeer", sv: "ren" }, villsau: { en: "wild sheep", sv: "vildfår" },
  pølser: { en: "sausages", sv: "korv" }, pølse: { en: "sausage", sv: "korv" },
  bacon: { en: "bacon", sv: "bacon" }, skinke: { en: "ham", sv: "skinka" },
  spekemat: { en: "cured meats", sv: "charkuterier" }, spekeskinke: { en: "cured ham", sv: "lufttorkad skinka" },
  fenalår: { en: "fenalår (cured leg of lamb)", sv: "fenalår" }, pinnekjøtt: { en: "pinnekjøtt (salted lamb ribs)", sv: "pinnekjøtt" },
  lammerull: { en: "lammerull (rolled lamb)", sv: "lammrulle" }, kjøttkaker: { en: "meatballs", sv: "köttbullar" },
  kjøttdeig: { en: "minced meat", sv: "köttfärs" }, biff: { en: "steak", sv: "biff" }, pålegg: { en: "cold cuts", sv: "pålägg" },
  // fish
  laks: { en: "salmon", sv: "lax" }, ørret: { en: "trout", sv: "öring" }, fjellørret: { en: "mountain trout", sv: "fjällöring" },
  røye: { en: "Arctic char", sv: "röding" }, torsk: { en: "cod", sv: "torsk" }, sei: { en: "saithe", sv: "sej" },
  makrell: { en: "mackerel", sv: "makrill" }, peppermakrell: { en: "peppered mackerel", sv: "pepparmakrill" },
  sild: { en: "herring", sv: "sill" }, reker: { en: "prawns", sv: "räkor" }, krabbe: { en: "crab", sv: "krabba" },
  skalldyr: { en: "shellfish", sv: "skaldjur" }, sjømat: { en: "seafood", sv: "skaldjur" },
  tørrfisk: { en: "stockfish", sv: "torrfisk" }, klippfisk: { en: "clipfish", sv: "klippfisk" },
  rakfisk: { en: "rakfisk (fermented trout)", sv: "rakfisk" }, varmrøkt: { en: "hot-smoked", sv: "varmrökt" },
  kaldrøkt: { en: "cold-smoked", sv: "kallrökt" }, røkt: { en: "smoked", sv: "rökt" },
  // bakery & sweets
  boller: { en: "buns", sv: "bullar" }, kaker: { en: "cakes", sv: "kakor" }, kake: { en: "cake", sv: "kaka" },
  lefse: { en: "lefse", sv: "lefse" }, lefser: { en: "lefse", sv: "lefse" }, flatbrød: { en: "flatbread", sv: "tunnbröd" },
  knekkebrød: { en: "crispbread", sv: "knäckebröd" }, surdeigsbrød: { en: "sourdough bread", sv: "surdegsbröd" },
  vafler: { en: "waffles", sv: "våfflor" }, sjokolade: { en: "chocolate", sv: "choklad" },
  // honey & preserves
  lynghonning: { en: "heather honey", sv: "ljunghonung" }, sommerhonning: { en: "summer honey", sv: "sommarhonung" },
  skogshonning: { en: "forest honey", sv: "skogshonung" }, blomsterhonning: { en: "wildflower honey", sv: "blomhonung" },
  bivoks: { en: "beeswax", sv: "bivax" }, saft: { en: "juice", sv: "saft" }, sirup: { en: "syrup", sv: "sirap" },
  gelé: { en: "jelly", sv: "gelé" }, marmelade: { en: "marmalade", sv: "marmelad" }, chutney: { en: "chutney", sv: "chutney" },
  // drinks
  eplemost: { en: "apple juice", sv: "äppelmust" }, eplejuice: { en: "apple juice", sv: "äppeljuice" },
  most: { en: "juice", sv: "must" }, eplesider: { en: "apple cider", sv: "äppelcider" }, sider: { en: "cider", sv: "cider" },
  øl: { en: "beer", sv: "öl" }, mjød: { en: "mead", sv: "mjöd" }, akevitt: { en: "aquavit", sv: "akvavit" },
  kaffe: { en: "coffee", sv: "kaffe" }, te: { en: "tea", sv: "te" }, urtete: { en: "herbal tea", sv: "örtte" },
  // other
  blomster: { en: "flowers", sv: "blommor" }, planter: { en: "plants", sv: "plantor" },
  ull: { en: "wool", sv: "ull" }, garn: { en: "yarn", sv: "garn" }, skinn: { en: "hides", sv: "skinn" },
  mel: { en: "flour", sv: "mjöl" }, korn: { en: "grain", sv: "spannmål" }, havre: { en: "oats", sv: "havre" },
  olje: { en: "oil", sv: "olja" }, krydder: { en: "spices", sv: "kryddor" }, nøtter: { en: "nuts", sv: "nötter" },
  // gaps seen in the 2026-09-03 sample (loanwords map to themselves so the
  // word-by-word rule does not refuse a phrase that contains them)
  juice: { en: "juice", sv: "juice" },
  quinoa: { en: "quinoa", sv: "quinoa" }, catering: { en: "catering", sv: "catering" }, burgere: { en: "burgers", sv: "burgare" },
  burger: { en: "burger", sv: "burgare" }, ribbe: { en: "pork ribs", sv: "revbensspjäll" }, konfekt: { en: "confectionery", sv: "konfekt" },
  lokalmat: { en: "local food", sv: "lokal mat" }, salatost: { en: "salad cheese", sv: "salladsost" },
  kaldpresset: { en: "cold-pressed", sv: "kallpressad" }, rapsolje: { en: "rapeseed oil", sv: "rapsolja" },
  arktiske: { en: "Arctic", sv: "arktiska" }, arktisk: { en: "Arctic", sv: "arktisk" }, fjellost: { en: "mountain cheese", sv: "fjällost" },
  ramsløk: { en: "wild garlic", sv: "ramslök" }, ramsløkost: { en: "wild garlic cheese", sv: "ramslöksost" },
  kvit: { en: "white", sv: "vit" }, hvit: { en: "white", sv: "vit" }, blå: { en: "blue", sv: "blå" }, trøffel: { en: "truffle", sv: "tryffel" },
  vellagra: { en: "well-aged", sv: "vällagrad" }, vellagret: { en: "well-aged", sv: "vällagrad" }, pepparost: { en: "pepper cheese", sv: "pepparost" },
  edamer: { en: "edam", sv: "edamer" }, brisket: { en: "brisket", sv: "brisket" },
  // wine (seen live 2026-09-03: Fruktvin, Isvin)
  vin: { en: "wine", sv: "vin" }, fruktvin: { en: "fruit wine", sv: "fruktvin" }, isvin: { en: "ice wine", sv: "isvin" },
  eplevin: { en: "apple wine", sv: "äppelvin" }, plommevin: { en: "plum wine", sv: "plommonvin" }, bringebærvin: { en: "raspberry wine", sv: "hallonvin" },
  // qualifiers
  økologisk: { en: "organic", sv: "ekologisk" }, økologiske: { en: "organic", sv: "ekologiska" },
  fersk: { en: "fresh", sv: "färsk" }, ferske: { en: "fresh", sv: "färska" }, hjemmelaget: { en: "homemade", sv: "hemlagad" },
  lokal: { en: "local", sv: "lokal" }, lokale: { en: "local", sv: "lokala" }, tradisjonell: { en: "traditional", sv: "traditionell" },
  villsaukjøtt: { en: "wild sheep meat", sv: "vildfårskött" }, gårdsprodukter: { en: "farm products", sv: "gårdsprodukter" },
  delikatesser: { en: "delicacies", sv: "delikatesser" }, delikatesseskinke: { en: "delicatessen ham", sv: "delikatesskinka" },
};

/** Tokens that pass through unchanged inside a known phrase. */
const PASS_THROUGH = new Set(["&", "-", "–", "—", "/", "+", ",", "m.m.", "mm", "etc"]);
const CONNECTORS: Record<string, Entry> = { og: { en: "and", sv: "och" }, med: { en: "with", sv: "med" }, fra: { en: "from", sv: "från" }, i: { en: "in", sv: "i" }, av: { en: "of", sv: "av" } };

function pick(e: Entry | undefined, lang: Lang): string | null {
  if (!e) return null;
  if (lang === "en") return e.en;
  if (lang === "sv") return e.sv ?? null;
  return null;
}

/** Restore the input's capitalisation shape onto the translation. */
function recase(source: string, out: string): string {
  if (!source) return out;
  if (source === source.toUpperCase() && source.length > 1) return out.toUpperCase();
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) return out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

function lookupToken(tok: string, lang: Lang): string | null {
  const low = tok.toLowerCase();
  if (PASS_THROUGH.has(low) || /^[\d.,%]+$/.test(low)) return tok;
  const conn = pick(CONNECTORS[low], lang);
  if (conn) return conn;
  const w = pick(PRODUCT_WORDS[low], lang) ?? pick(PRODUCT_PHRASES[low], lang);
  return w === null ? null : recase(tok, w);
}

/**
 * Translate a product name for display in `lang`. Returns the input unchanged
 * for Norwegian, for unknown names, and for any name where a single word is
 * unknown (never half-translated).
 */
export function translateProductName(name: string, lang: Lang): string {
  if (!name || lang === "no") return name;
  const trimmed = name.trim();
  if (!trimmed) return name;
  const low = trimmed.toLowerCase();
  const phrase = pick(PRODUCT_PHRASES[low], lang) ?? pick(PRODUCT_WORDS[low], lang);
  if (phrase !== null) return recase(trimmed, phrase);

  // Word by word — every token must resolve. Parenthesised groups are
  // resolved as their own phrase ("(selvplukk)") or word by word inside.
  const tokens = trimmed.split(/\s+/);
  const out: string[] = [];
  for (const tok of tokens) {
    const m = /^(\()(.+?)(\))([,.;:]?)$/.exec(tok);
    if (m) {
      const inner = lookupToken(m[2], lang) ?? (pick(PRODUCT_PHRASES[`(${m[2].toLowerCase()})`], lang));
      if (inner === null) return name;
      out.push(`(${inner.replace(/^\(|\)$/g, "")})${m[4]}`);
      continue;
    }
    const punct = /[,.;:]$/.test(tok) ? tok.slice(-1) : "";
    const core = punct ? tok.slice(0, -1) : tok;
    const t = lookupToken(core, lang);
    if (t === null) return name;
    out.push(t + punct);
  }
  return out.join(" ");
}

/** Coverage helper for tests/reports: share of (name, count) pairs translated. */
export function glossaryCoverage(freq: Array<[string, number]>, lang: Lang, isCategoryWord: (n: string) => boolean): { translated: number; total: number; pct: number } {
  let translated = 0, total = 0;
  for (const [n, c] of freq) {
    total += c;
    if (isCategoryWord(n) || translateProductName(n, lang) !== n) translated += c;
  }
  return { translated, total, pct: total ? Math.round((translated / total) * 100) : 0 };
}

// ─── Delivery / payment terms ──────────────────────────────────────────────
// `agent_knowledge.deliveryOptions` / `paymentMethods` are FREE TEXT from the
// producer (no enum in code): "Gårdsbutikk", "Kontant", "Kort", "Vipps",
// "Butikk Verksgata 13" … Same rule as products: an exact known term renders
// in the page language, anything else stays exactly as written.
export const DELIVERY_TERMS: Record<string, Entry> = {
  "gårdsbutikk": { en: "farm shop", sv: "gårdsbutik" }, "gardsbutikk": { en: "farm shop", sv: "gårdsbutik" },
  "lokalbutikk": { en: "local shop", sv: "lokal butik" }, "butikk": { en: "shop", sv: "butik" },
  "bondens marked": { en: "farmers' market", sv: "bondens marknad" }, "reko-ring": { en: "REKO ring", sv: "REKO-ring" },
  "reko": { en: "REKO", sv: "REKO" }, "direkteleveranse": { en: "direct delivery", sv: "direktleverans" },
  "hjemlevering": { en: "home delivery", sv: "hemleverans" }, "levering": { en: "delivery", sv: "leverans" },
  "henting": { en: "pick-up", sv: "avhämtning" }, "hente selv": { en: "collect in person", sv: "hämta själv" },
  "selvplukk": { en: "pick-your-own", sv: "självplock" }, "post": { en: "mail order", sv: "post" },
  "postordre": { en: "mail order", sv: "postorder" }, "nettbutikk": { en: "online shop", sv: "webbutik" },
  "abonnement": { en: "subscription", sv: "prenumeration" }, "andelslandbruk": { en: "community-supported agriculture", sv: "andelsjordbruk" },
  "torg": { en: "market square", sv: "torg" }, "torget": { en: "the market square", sv: "torget" },
  "dagligvare": { en: "grocery stores", sv: "dagligvaruhandel" }, "restaurant": { en: "restaurants", sv: "restauranger" },
  "kontant": { en: "cash", sv: "kontant" }, "kort": { en: "card", sv: "kort" }, "bankkort": { en: "debit card", sv: "bankkort" },
  "kredittkort": { en: "credit card", sv: "kreditkort" }, "vipps": { en: "Vipps", sv: "Vipps" }, "faktura": { en: "invoice", sv: "faktura" },
  "nettbetaling": { en: "online payment", sv: "onlinebetalning" }, "bankoverføring": { en: "bank transfer", sv: "banköverföring" },
  "forskudd": { en: "prepayment", sv: "förskott" }, "swish": { en: "Swish", sv: "Swish" }, "paypal": { en: "PayPal", sv: "PayPal" },
};

/** Exact known delivery/payment term in `lang`; otherwise unchanged. Norwegian: unchanged. */
export function translateDeliveryTerm(value: string, lang: Lang): string {
  if (!value || lang === "no") return value;
  const t = pick(DELIVERY_TERMS[value.trim().toLowerCase()], lang);
  return t === null ? value : recase(value.trim(), t);
}

// ─── Reverse lookup: English query word → Norwegian search terms ───────────
// OpenAI's app reviewers test in English; the catalogue, the producers' own
// product text and `parseNaturalQuery`'s category keywords are Norwegian.
// Measured live 2026-09-05: `ost Bergen` finds Ostegården (world's best
// cheese 2018), Colonialen and Møllendal — `producers near Bergen that sell
// cheese` finds NONE of them, because "cheese" is in no keyword list, so the
// category filter is skipped entirely and the search degrades to "the ten
// nearest producers, whatever they sell". Same for milk, salmon, seafood,
// potatoes, strawberries, apples, butter … That is what the ChatGPT app
// submission was rejected on (2026-09-05, «one or more of your test cases did
// not produce correct results»).
//
// The vocabulary already exists in this file — it is what renders the English
// producer pages. This index just reads it backwards, so one glossary keeps
// serving both, and a word added for rendering improves search for free.
//
// Deliberately NOT a second hand-maintained keyword list in
// marketplace-registry.ts: that is exactly how the two drifted apart.

/** English words that are also Norwegian food words — never auto-mapped. */
const AMBIGUOUS_EN = new Set([
  // "is" = ice cream in Norwegian, the verb in English; "and" = duck in
  // Norwegian, the conjunction in English (see MEAT_KEYWORD_FALSE_FRIENDS in
  // marketplace-registry.ts); "most" = juice; "te" = tea; "biff"/"burger"/
  // "bacon"/"chutney"/"squash"/"chili"/"skyr"/"kefir"/"quinoa"/"catering"
  // are identical in both and need no mapping (excluded separately below,
  // in getReverseIndex, since that check is spelling-based rather than a
  // fixed word list).
  "is", "and", "most", "te", "of", "in", "with", "from", "a", "an",
]);

/** Conservative English morphology: the forms a reviewer actually types. */
function englishVariants(term: string): string[] {
  const t = term.toLowerCase().trim();
  if (!t) return [];
  const out = new Set<string>([t]);
  if (t.endsWith("ies")) out.add(t.slice(0, -3) + "y");       // berries → berry
  else if (t.endsWith("es")) out.add(t.slice(0, -2));          // potatoes → potato
  if (t.endsWith("s") && t.length > 3) out.add(t.slice(0, -1)); // apples → apple
  else out.add(t + "s");                                       // apple → apples
  return [...out].filter(w => w.length >= 3 && !AMBIGUOUS_EN.has(w));
}

let reverseIndex: Map<string, string[]> | null = null;

/**
 * Every generated English word-form that must never be indexed because it
 * ALSO reads as an ordinary Norwegian word this glossary already knows.
 *
 * Round 1 (2026-09-05) only skipped indexing when the (Norwegian, English)
 * PAIR itself was spelled identically (yoghurt/yoghurt, bacon/bacon). Round 2
 * found that incomplete, and round 3 found it incomplete again — in both
 * cases because `englishVariants()` GENERATES a form of an otherwise-genuine
 * translation that collides with an unrelated Norwegian word even though the
 * (no, en) pair that produced it isn't identical-spelling:
 *   - burgere → "burgers"; englishVariants("burgers") generates the singular
 *     "burger", which is itself the standalone Norwegian loanword
 *     PRODUCT_WORDS["burger"].
 *   - saft → "juice"; the base form "juice" IS the standalone Norwegian
 *     loanword PRODUCT_WORDS["juice"].
 *   - egg → "eggs"; englishVariants("eggs") singularises to "egg", which is
 *     the Norwegian word "egg" itself (PRODUCT_WORDS["egg"], a different,
 *     unrelated entry to the one that generated it).
 * Two rounds of hand-listing specific words each missed cases (round 3 found
 * a further miss, "egg", by exhaustive test rather than by hand — see
 * marketplace-search-english-queries.test.ts), so this is computed from the
 * vocabulary itself, two ways, instead of a maintained list:
 *   1. Every word-form (base AND generated variants) of any (no, en) pair
 *      that is ALREADY identical-spelling (same check as `add()` below) —
 *      catches "burger"/"burgers", "juice"/"juices", etc. in one go instead
 *      of only the exact spelling that made the PAIR identical.
 *   2. Every key that literally exists in PRODUCT_WORDS or PRODUCT_PHRASES —
 *      i.e. any string this glossary already treats as Norwegian, full stop,
 *      regardless of whether ITS OWN entry happens to be identical-spelling.
 *      This is what catches "egg": the entry that produces the colliding
 *      variant (egg→"eggs") is not itself identical-spelling, so (1) alone
 *      misses it, but "egg" is unmistakably already Norwegian vocabulary.
 * Between the two, every generated variant is checked against the glossary's
 * own Norwegian vocabulary, not against a name someone had to notice and
 * write down — closing the whole defect class, including cases no review has
 * hand-checked yet.
 */
function computeExcludedForms(): Set<string> {
  const forms = new Set<string>();
  const scan = (rec: Record<string, Entry>) => {
    for (const [no, entry] of Object.entries(rec)) {
      forms.add(no.toLowerCase()); // (2): the Norwegian key itself
      if (entry.en.toLowerCase() === no.toLowerCase()) {
        for (const v of englishVariants(entry.en)) forms.add(v); // (1): its own word-forms
      }
    }
  };
  scan(PRODUCT_WORDS);
  scan(PRODUCT_PHRASES);
  return forms;
}

/** english term → the Norwegian words that mean it (built once, lazily). */
function getReverseIndex(): Map<string, string[]> {
  if (reverseIndex) return reverseIndex;
  const idx = new Map<string, string[]>();
  const excludedForms = computeExcludedForms();
  const add = (en: string, no: string) => {
    // Identical-spelling loanwords ("yoghurt", "burger", "bacon", "skyr",
    // "kefir", "quinoa", "catering", "squash", "chutney", "juice", …) are
    // real Norwegian words that happen to be spelled exactly like their
    // English translation. They carry no cross-language mapping value: if
    // the literal word is present in the query text at all, any category
    // keyword equal to it already matches directly against `q` via
    // norwegianWordBoundary in marketplace-registry.ts — appending it again
    // through the reverse index is a no-op for matching, and only pollutes
    // norwegianTermsForEnglishQuery()'s "this looks like an English query"
    // signal. Bug (2026-09-05): a 100%-Norwegian query "and og yoghurt"
    // ("duck and yogurt") returned englishTerms=["yoghurt"] purely because
    // "yoghurt" round-trips to itself, which fired
    // suppressEnglishConjunction and silently dropped the `and` (duck)
    // keyword — and therefore the `meat` category — from a HARD filter, for
    // a query with no English in it at all. Only identical-spelling pairs
    // are skipped; genuinely different-spelling pairs (cheese→ost,
    // salmon→laks, …) are real translations and still indexed below.
    if (en.toLowerCase() === no.toLowerCase()) return;
    for (const v of englishVariants(en)) {
      // Rounds 2 & 3 (2026-09-05): a GENERATED variant of a genuine
      // translation can independently collide with the glossary's own
      // Norwegian vocabulary (burgere→"burgers" generates "burger";
      // saft→"juice" generates "juice" itself; egg→"eggs" generates "egg")
      // even though the (no, en) pair above isn't identical. Skip those the
      // same way, for the same reason — see computeExcludedForms().
      if (excludedForms.has(v)) continue;
      const cur = idx.get(v);
      if (!cur) idx.set(v, [no]);
      else if (!cur.includes(no)) cur.push(no);
    }
  };
  for (const [no, entry] of Object.entries(PRODUCT_WORDS)) {
    if (AMBIGUOUS_EN.has(no.toLowerCase())) continue; // "and" (duck), "is" (ice cream)
    add(entry.en, no);
  }
  for (const [no, entry] of Object.entries(PRODUCT_PHRASES)) add(entry.en, no);
  reverseIndex = idx;
  return idx;
}

/**
 * Norwegian search terms for the English food words in `query`.
 *
 * Returns [] for a Norwegian query (nothing matches) and for a query with no
 * food words, so the caller can append the result unconditionally. Multi-word
 * English phrases ("goat cheese", "baked goods") are matched before single
 * words, and single words are matched on a word boundary so "cheese" does not
 * fire inside "cheesecake-free".
 */
export function norwegianTermsForEnglishQuery(query: string): string[] {
  const q = (query || "").toLowerCase();
  if (!q.trim()) return [];
  const idx = getReverseIndex();
  const found = new Set<string>();

  // Phrases first — "goat cheese" must map to geitost, not just ost.
  for (const [en, nos] of idx) {
    if (!en.includes(" ")) continue;
    if (q.includes(en)) nos.forEach(n => found.add(n));
  }
  for (const word of q.split(/[^a-z0-9'-]+/)) {
    const nos = idx.get(word);
    if (nos) nos.forEach(n => found.add(n));
  }
  return [...found];
}

/**
 * True when `word` is an English food word this glossary knows.
 *
 * The producer-NAME branch in marketplace-registry.ts skips category words so
 * they cannot become name tokens, but it only knew Norwegian ones — so
 * "goat cheese farm" still built the name query "goat cheese" and fuzzy-
 * matched producer names instead of filtering on dairy.
 */
export function isEnglishFoodWord(word: string): boolean {
  const w = (word || "").toLowerCase().trim();
  if (!w) return false;
  const idx = getReverseIndex();
  if (idx.has(w)) return true;
  // A modifier that only ever appears inside a known phrase ("goat" in "goat
  // cheese") is a food word too — otherwise it survives alone as a name token.
  for (const en of idx.keys()) if (en.includes(" ") && en.split(" ").includes(w)) return true;
  return false;
}

/** Test/report helper: how many distinct English words the index covers. */
export function reverseGlossarySize(): number {
  return getReverseIndex().size;
}

// Test-only: every key currently in the reverse index, so a test can iterate
// the REAL vocabulary the code produces instead of a hand-picked word list —
// exactly the pattern that missed "burger"/"juice" across two review rounds.
// Never call from production code.
export function __peekReverseIndexKeysForTesting(): string[] {
  return [...getReverseIndex().keys()];
}
