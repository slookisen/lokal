/**
 * Cart item ban (F9) — dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel.
 *
 * Two kinds of catalog rows can never be put in a cart or submitted as an
 * order, because a pickup order of food is all the order flow is built and
 * licensed for:
 *
 *   - "alcohol": alcoholic drinks (spirits, beer, wine, cider and mead with
 *     alcohol). Selling them needs a licence the platform's producers have
 *     not given us, and an alcoholic drink must never be handed over on the
 *     strength of a web order.
 *   - "service": services and experiences (tour, tasting, dinner, meeting
 *     room, accommodation, ...). They are not goods for pickup; they are
 *     bookings and belong to Opplevagent.
 *
 * Fail-closed: this is a deny-list over the product name, description and
 * category plus the producer's own type. When the row looks like one of the
 * two kinds it is refused; a classifier error also refuses (the callers treat
 * a thrown error as a ban). The explicit alcohol-free marker («alkoholfri»,
 * «0%», «eplemost», «saft», ...) is the only way out, and only for the
 * alcohol kind. A known drink-producer type (brewery, cidery, distillery,
 * winery, meadery) with a beverages product needs such a marker too.
 *
 * Pure: no DB access here (the callers read the row).
 */

export type BannedItemKind = "alcohol" | "service";

export interface CartItemBanInput {
  name: string | null | undefined;
  description?: string | null;
  /** products.category */
  category?: string | null;
  /** The producer's own types: agents.categories / tags entries, lower-cased by the caller or not. */
  producerTypes?: readonly string[];
}

export interface CartItemBan {
  kind: BannedItemKind;
  reason: string;
}

/** Norwegian + English explanation, leading with a stable code like CATEGORY_LABEL_CART_ERROR. */
export const ALCOHOL_CART_ERROR =
  "alcohol_not_orderable: alkoholholdige drikker kan ikke bestilles via Rett fra Bonden. Ta kontakt med produsenten direkte. / Alcoholic drinks cannot be ordered through Rett fra Bonden. Contact the producer directly.";
export const SERVICE_CART_ERROR =
  "service_not_orderable: tjenester og opplevelser (omvisning, smaking, middag, møterom, overnatting o.l.) kan ikke bestilles som varer. Ta kontakt med produsenten direkte. / Services and experiences cannot be ordered as goods. Contact the producer directly.";
export const BAN_CHECK_FAILED_ERROR =
  "item_check_failed: varen kunne ikke kontrolleres og er derfor avvist. / The item could not be checked and was refused.";

export function banErrorText(kind: BannedItemKind): string {
  return kind === "alcohol" ? ALCOHOL_CART_ERROR : SERVICE_CART_ERROR;
}

/** Lower-case, fold diacritics that vary in spelling (å/a, ø/o, æ/ae, é/e) and split into word tokens. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/å/g, "a").replace(/ø/g, "o").replace(/æ/g, "ae")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);
}

// Alcohol matching works on folded tokens (å→a, ø→o, æ→ae). A token is
// alcohol when it STARTS or ENDS with a stem (compounds: «eplesider»,
// «hvitvin», «eplemjod», «juleol») or EQUALS a short word that would match
// far too much as a stem («gin», «ol», «vin»).
const ALCOHOL_STEMS = [
  "akevitt", "aquavit", "brennevin", "whisky", "whiskey", "vodka", "konjakk", "cognac", "brandy",
  "calvados", "likor", "liqueur", "snaps", "absint", "tequila", "mezcal", "grappa", "armagnac",
  "rodvin", "hvitvin", "rosevin", "baervin", "plommevin", "paerevin", "eplevin", "fruktvin", "dessertvin", "portvin",
  "musserende", "champagne", "prosecco", "sherry",
  "mjod", "cider", "sider", "pilsner", "juleol", "pasketo", "bokkol", "halvol", "hveteol", "lagerol", "mikrobryggeri",
  "hardcider", "seltzer",
];
const ALCOHOL_WORDS = new Set([
  "gin", "rom", "rum", "ol", "vin", "ale", "ipa", "stout", "porter", "beer", "wine", "spirits", "pils",
  "vermouth", "vermut", "cava",
]);
// Whole tokens that look like alcohol but are goods.
const NOT_ALCOHOL_TOKENS = new Set(["rommegrot", "rommekolle", "romsaus", "vinaigrette", "vinegar", "vineddik", "vinbaer"]);
// «rom» is Norwegian for fish roe as well as the spirit: a roe marker in the
// same text clears it. Without one the word is treated as alcohol (fail-closed).
const ROE_MARKERS = new Set(["rogn", "kaviar", "romkaviar", "fiskerom", "torskerom", "sildrom", "lakserom", "stromming", "lodderom", "sikrom", "lojrom", "loyrom", "krepsrom"]);
// Skive 1b, review round 2: «<fish>rom» is roe («Gjedderom», «Ørretrom», «Seirom», «Hyserom»).
const ROE_FISH_PREFIXES = [
  "torske", "torsk", "lakse", "laks", "sild", "lodde", "sik", "lojr", "loy", "gjedde", "orret", "sjoorret", "sei", "hyse",
  "kolje", "abbor", "makrell", "kveite", "steinbit", "fiske", "kreps", "krepse", "rakfisk", "rodspette", "rodrye", "rye",
  "roye", "roy", "hvitfisk", "breiflabb", "rognkjeks",
];
function isRoeToken(t: string): boolean {
  return ROE_MARKERS.has(t) || ROE_FISH_PREFIXES.some((f) => t === f + "rom");
}
// Brews that are coffee or tea, not beer.
const NOT_ALCOHOL_BREWS = new Set(["kaffebrygg", "tebrygg", "urtebrygg", "kaldbrygg", "kakaobrygg"]);

// Compounds ending in «ol» («gardsol», «hveteol») or «vin» («gardsvin»,
// «rabarbravin») are drinks. Long tokens only (not «sol», «kol», «Kevin»), and
// the few real words that end that way are listed.
const NOT_ALCOHOL_COMPOUNDS = new Set(["mentol", "sorbitol", "xylitol", "erytritol", "parasol", "kolesterol", "glyserol", "karbol", "pistol", "vitriol"]);

function isAlcoholToken(t: string): boolean {
  if (NOT_ALCOHOL_TOKENS.has(t)) return false;
  // Skive 1b (S1): vinegar is food whatever it was made from («Cidereddik»,
  // «Rødvinseddik», «Sherryeddik»).
  if (t.endsWith("eddik")) return false;
  if (ALCOHOL_WORDS.has(t)) return true;
  // S1: brews («Julebrygg», «Høstbrygg»; not «bryggekaffe» or «Kaffebrygg»)
  // and rum compounds («Krydderrom»; roe compounds are isRoeToken). Bitters
  // are decided by their position, see bitterIsDrink.
  if (t === "brygg" || (t.length >= 6 && t.endsWith("brygg") && !NOT_ALCOHOL_BREWS.has(t))) return true;
  // «-strøm» folds to «-strom» (Bergstrøm, Lindstrøm): a name, not rum.
  if (t.length >= 6 && t.endsWith("rom") && !t.endsWith("strom") && !isRoeToken(t)) return true;
  // Spritz as a word or the last part («Aperolspritz», «Spritzer»), not «Spritzkaker».
  if (t === "spritz" || t === "spritzer" || (t.length > 6 && t.endsWith("spritz"))) return true;
  for (const s of ALCOHOL_STEMS) if (t.startsWith(s) || t.endsWith(s)) return true;
  if (t.length >= 6 && t.endsWith("ol") && !NOT_ALCOHOL_COMPOUNDS.has(t)) return true;
  if (t.length >= 7 && t.endsWith("vin")) return true;
  return false;
}

// Explicit alcohol-free markers: the only way out for the alcohol kind.
function hasAlcoholFreeMarker(all: string[], raw: string): boolean {
  const lowered = raw.toLowerCase();
  if (/(^|[^0-9])0[,.]?0?\s*%/.test(lowered)) return true;
  if (/uten alkohol|non[- ]alcoholic|alcohol[- ]free/.test(lowered)) return true;
  for (const t of all) {
    if (t === "alkoholfri" || t === "alkoholfritt" || t === "alcoholfree" || t === "nonalcoholic") return true;
    if (t === "saft" || t === "juice" || t === "cordial" || t === "kombucha" || t === "mineralvann" || t === "kildevann" || t === "iste" || t === "kaffe") return true;
    // Musts and squashes: eplemost, paeremost, baermost, solbaersaft.
    if (t.length > 4 && (t.endsWith("most") || t.endsWith("saft")) && !t.endsWith("vinmost")) return true;
  }
  return false;
}

// Skive 1b (S1) markers: juice compounds («Eplejuice», «Gulrotjuice») and
// «ingen (tilsatt) alkohol». Read from the NAME only (review round 3): in a
// description they say nothing about the row («Eple Brut», a cidery's
// beverage described as «gjæret eplejuice, 7 %»), so they can never lift an
// alcohol word in the name, an alcohol category, a beverage mentioning
// alcohol or a drink producer's beverage. «Eplejuice» from a cidery passes.
function hasJuiceOrNoAddedAlcoholMarker(all: string[], raw: string): boolean {
  if (/(uten|ingen) tilsatt alkohol|ingen alkohol/.test(raw.toLowerCase())) return true;
  return all.some((t) => t.length > 5 && t.endsWith("juice"));
}

// Service / experience stems and words.
const SERVICE_STEMS = [
  "omvisning", "guidet", "guiding", "gardsbesok", "smaking", "smakskurs", "vinsmaking", "olsmaking",
  "kveldsmat", "fireretters", "treretters", "femretters", "konferanse",
  "moterom", "kurslokale", "selskapslokale", "overnatting", "overnatte", "losji", "hytteutleie", "utleie",
  "dagpakke", "workshop", "opplevelse", "aktivitet", "ridetur", "kanotur", "fisketur",
  "safari", "teambuilding", "billett",
  // Rooms to rent (skive 1b): without these the «-rom» rule below would call
  // them rum. Either way they are refused; this gives the right message.
  "selskapsrom", "festrom", "gjesterom", "hotellrom", "dobbeltrom", "enkeltrom",
];
const SERVICE_WORDS = new Set([
  "event", "kurs", "foredrag", "camping", "rom", "spa", "massasje", "middag",
  "tour", "tasting", "experience", "dinner", "accommodation", "arrangement", "booking",
]);
// Skive 1b (S1): compounds that END in a service word are services too
// («Ostesmaking», «Gårdsomvisning», «Utvandringshistorier rundtur»).
// «middag» counts only as a word of its own: «Middagspakke» and «Middagskasse
// for 4» are goods.
const SERVICE_SUFFIXES = [
  "smaking", "omvisning", "servering", "rundtur", "sykkeltur", "battur", "kanotur", "fisketur", "ridetur",
  "vandretur", "fjelltur", "skogstur", "bygdetur", "gardstur", "kajakktur",
];
// S1: weak words. A seated meal or a trip («Frokost», «Lunsj på gården»,
// «Tur») and the drink «Bitter» are banned only when the word stands for the
// whole row. Next to a real goods noun it is a modifier and the row is goods:
// «Frokost egg 12 stk», «Lunsj-baguette», «Grillpølser til tur», «Bitter
// sjokolade 70 %», «Bitter appelsinmarmelade».
const WEAK_SERVICE_WORDS = new Set(["frokost", "lunsj", "brunsj", "brunch", "tur"]);
// A weak service word FIRST and followed by a preposition is the service
// itself: «Lunsj med utsikt», «Tur til seteren», «Lunsj for to personer».
const PREPOSITIONS = new Set(["pa", "i", "med", "for", "til", "hos", "ved", "fra", "under", "over"]);
function weakServiceByPlacement(tks: readonly string[]): boolean {
  return tks.length > 1 && WEAK_SERVICE_WORDS.has(tks[0]!) && PREPOSITIONS.has(tks[1]!);
}
// Bitters (review round 2): «bitter» or a «-bitter» compound is the drink
// unless it stands right before a food it describes («Bitter sjokolade»,
// «Bitter appelsinmarmelade», «Halvbitter sjokolade»). Last, or before a
// brand, a preposition, a number or a volume, it is the drink: «Atlungstad
// Bitter», «Bitter fra gården», «Gammel bitter», «Bitter Original 70 cl».
const BITTER_FOOD_HEADS = ["sjokolade", "marmelade", "syltetoy", "salat", "kakao", "mandler", "notter"];
const BITTER_FOOD_WORDS = new Set(["te", "kaffe", "gele", "mandel"]);
function bitterIsDrink(tks: readonly string[]): boolean {
  return tks.some((t, i) => {
    if (t !== "bitter" && !(t.length >= 8 && t.endsWith("bitter"))) return false;
    const next = tks[i + 1];
    const food = !!next && (BITTER_FOOD_WORDS.has(next) || BITTER_FOOD_HEADS.some((h) => next === h || next.endsWith(h)));
    return !food;
  });
}
const FILLER_TOKENS = new Set([
  "pa", "i", "med", "og", "til", "for", "hos", "ved", "av", "en", "et", "ei", "the", "a", "an", "of", "with", "and", "at",
  "stk", "pk", "kg", "g", "l", "dl", "cl", "ml", "x", "per", "pr",
  "gard", "garden", "gardsbutikken", "tunet", "laven", "stabburet", "kafe", "kafeen", "cafe", "restaurant", "restauranten",
]);
/** True when the tokens hold a weak service word and nothing else but filler and numbers. */
function onlyWeakWord(tks: readonly string[], weak: ReadonlySet<string>): boolean {
  if (!tks.some((t) => weak.has(t))) return false;
  return tks.every((t) => weak.has(t) || FILLER_TOKENS.has(t) || /^(\d+%?|%)$/.test(t));
}
// «Lunsj/frokost/brunsj» as a SERVICE only means a seated meal; as a take-home
// goods name («Lunsjpakke») it would not be a bare token. «Rom» is ambiguous
// (room, roe, rum): see the roe markers; ambiguity is resolved fail-closed.
const SERVICE_CATEGORIES = new Set([
  "experience", "experiences", "opplevelse", "opplevelser", "service", "services", "tjeneste", "tjenester",
  "accommodation", "overnatting", "activity", "aktivitet", "aktiviteter", "tour", "tours", "event", "events",
  "booking", "dining", "restaurant", "kurs",
]);
const ALCOHOL_CATEGORIES = new Set([
  "alcohol", "alkohol", "spirits", "brennevin", "beer", "ol", "wine", "vin", "cider", "sider", "mead", "mjod",
]);
const DRINK_PRODUCER_TYPES = new Set([
  "bryggeri", "mikrobryggeri", "cideri", "sideri", "cidery", "brewery", "destilleri", "distillery", "vingard",
  "winery", "mjoderi", "meadery", "seltzeri", "brenneri",
]);

function startsWithAny(token: string, stems: readonly string[]): boolean {
  for (const s of stems) if (token.startsWith(s)) return true;
  return false;
}

/**
 * Classifies one catalog row. Returns the ban, or null when the row may be
 * ordered. Throws nothing for odd input; the callers additionally treat a
 * thrown error from here as a ban.
 */
export function classifyCartItemBan(input: CartItemBanInput): CartItemBan | null {
  const name = String(input.name ?? "");
  const description = String(input.description ?? "");
  const category = String(input.category ?? "");
  const nameTokens = tokens(name);
  const textTokens = tokens(`${name} ${description}`);
  const categoryTokens = tokens(category);
  const producerTypeTokens = (input.producerTypes ?? []).flatMap((t) => tokens(String(t)));
  const raw = `${name} ${description}`;

  // ── Services and experiences: the name or the category says so ──────────
  // Description is deliberately NOT searched for services: a farm shop's
  // description says «omvisning» on half of the profiles while the product
  // itself is cheese. The row's own name/category decide.
  const serviceCategory = categoryTokens.some((t) => SERVICE_CATEGORIES.has(t));
  const hasRoe = nameTokens.some((t) => isRoeToken(t));
  const serviceByName = nameTokens.some((t) => {
    if (t === "rom" && hasRoe) return false;
    return SERVICE_WORDS.has(t) || startsWithAny(t, SERVICE_STEMS) || SERVICE_SUFFIXES.some((s) => t.endsWith(s));
  }) || onlyWeakWord(nameTokens, WEAK_SERVICE_WORDS) || weakServiceByPlacement(nameTokens);
  if (serviceCategory || serviceByName) {
    return { kind: "service", reason: serviceCategory ? "category" : "name" };
  }

  // ── Alcohol ─────────────────────────────────────────────────────────────
  const alcoholCategory = categoryTokens.some((t) => ALCOHOL_CATEGORIES.has(t));
  const isBeverageCategory = categoryTokens.some((t) => t === "beverages" || t === "beverage" || t === "drikke" || t === "drikkevarer" || t === "drinks");
  const drinkProducer = producerTypeTokens.some((t) => DRINK_PRODUCER_TYPES.has(t) || startsWithAny(t, ["bryggeri", "destilleri", "cideri", "sideri", "vingard", "mjoderi", "brenneri"]));

  const alcoholWordHit = (tks: string[]): boolean =>
    tks.some((t, i) => {
      if (t.endsWith("rom") && tks.some((x) => isRoeToken(x))) return false;
      if (t === "spritz" && (tks[i + 1] ?? "").startsWith("kak")) return false; // «Spritz-kaker»
      return isAlcoholToken(t);
    }) || bitterIsDrink(tks);
  // S1: «rosé» with its accent is the wine; plain «rose» and «Rosé-pepper» are
  // left alone (the tokens fold é to e, so this reads the raw name).
  const roseHit = /(^|[^\p{L}])rosé(?!\p{L}|-\p{L})/u.test(name.toLowerCase());
  const nameAlcoholHit = alcoholWordHit(nameTokens) || roseHit;
  const alcoholFree = hasAlcoholFreeMarker(textTokens, raw) ||
    (!nameAlcoholHit && hasJuiceOrNoAddedAlcoholMarker(nameTokens, name));

  // The name is what the buyer orders: a hit there is alcohol unless the
  // name carries an explicit alcohol-free marker.
  if (nameAlcoholHit && !alcoholFree) return { kind: "alcohol", reason: "name" };
  if (alcoholCategory && !alcoholFree) return { kind: "alcohol", reason: "category" };
  // beverages + an alcohol word anywhere in the text (description) → alcohol.
  if (isBeverageCategory && !alcoholFree && (alcoholWordHit(textTokens) || textTokens.some((t) => t.startsWith("alkohol")))) {
    return { kind: "alcohol", reason: "beverages_alcohol_word" };
  }
  // A known drink producer's beverage is alcohol unless it says otherwise.
  if (drinkProducer && isBeverageCategory && !alcoholFree) return { kind: "alcohol", reason: "drink_producer_beverage" };
  // A drink producer's row with NO category at all and no marker: the name
  // alone decides (above); nothing more to do here.
  return null;
}
