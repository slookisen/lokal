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
 * Food exemption (dev-request 2026-11-11-rfb-alkoholregel-bare-drikkevarer):
 * the rule stops alcoholic DRINKS, not food where alcohol is an ingredient.
 * An alcohol word in the NAME does not ban the row when the name shows it is
 * food (FOOD_HEADS): the alcohol word is the first part of a compound whose
 * last part is a food word («Rødvinspølse», «Aquavitgelé», «Konjakkpølse»),
 * or an «<alcohol>marinert/-gravet/-røkt» participle right before a food noun
 * with nothing after it but a weight («Cognacmarinert laks», «Akevittmarinert
 * gravlaks»). «<food> med/m/i <alcohol>» passes only under alternative A
 * (owner's choice D2, 2026-11-12): the name ends in a weight in g/kg right
 * after the alcohol word and nothing else («Festpølse med akevitt 280g»,
 * «Parisersnabb med konjakk 200g»), and no package/gift word stands in the
 * name, the category or the description (PACKAGE: «Julegave», «Gavepakning»,
 * «Pakketilbud», «Kombo», «Duo», «6 pk», «x6», ...). «Kirsebærgelé med
 * Cognac» without a weight, «Pølse med øl 6 pk» and «Pølse med akevitt og
 * pils» stay banned. A drinkable food («Varm
 * sjokolade med likør») is never the food side. The last part of a
 * compound decides: «Sjokoladelikør» is a liqueur. An alcohol word FIRST and
 * a food word after it is a flavoured drink («Likør Sjokolade», «Juleøl
 * Sjokolade», «Porter Ost») and stays banned. Fail-closed, the exemption is
 * off when the name or the description has a drink sign (a volume such as
 * «70 cl» / «0,5 l», «flaske», «% vol», «% alkohol» or a % figure above
 * 2.5, «prosent», «flaske» in any word), for a hot/served drink («varm»,
 * «drikk», «kopp», «serveres»), for bundles and gift packs («Gavepakke»,
 * «Julekurv», «Smaksboks», category «Gaver»), for a name with more than one
 * alcohol word, and for a drink producer unless the row has an explicit food
 * category. It never lifts an alcohol category (also free text such as
 * «Likører», «alkoholholdige drikker»), a beverages row with an alcohol word
 * or a drink producer's beverage (those checks read the text without it).
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
  "vermouth", "vermut", "cava", "pastis",
]);
// Whole tokens that look like alcohol but are goods.
// «Mjødurt» (meadowsweet) is a herb, not mead; «Sideretter» are side dishes, not cider.
const NOT_ALCOHOL_TOKENS = new Set([
  "rommegrot", "rommekolle", "romsaus", "vinaigrette", "vinegar", "vineddik", "vinbaer", "mjodurt",
  "siderett", "sideretten", "sideretter", "siderettene",
]);
// Food heads (dev-request 2026-11-11-rfb-alkoholregel-bare-drikkevarer),
// folded like the tokens (gelé→gele, syltetøy→syltetoy, pålegg→palegg,
// paté→pate). A token is food when it IS one of these (also with a plural or
// definite ending) or ENDS with one as the last part of a compound
// («Festpølse», «Kirsebærgelé», «Rødvinspølse»). See isFoodToken for the
// guards that keep drinks («Likør», «Pastis», «Juleøl», «Cognac») out.
export const FOOD_HEADS = [
  "polse", "salami", "spekepolse", "snabb", "skinke", "gele", "syltetoy", "marmelade", "sjokolade", "konfekt",
  "troffel", "trofler", "karamell", "fudge", "kake", "kjeks", "is", "saus", "sennep", "marinade", "ost", "palegg",
  "postei", "pate",
];
const FOOD_HEAD_ENDINGS = ["", "r", "er", "en", "ene", "ne"];
// Heads this short need a longer first part to count as a compound head.
const SHORT_FOOD_HEAD_LENGTH = 3;
// Tokens that end like a food head but are not food.
const NOT_FOOD_TOKENS = new Set(["pastis", "anis", "most", "kompost", "frost", "rost", "post", "kost", "best", "ister"]);
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

// The alcohol word must END the first part of a food compound (a linking
// «s»/«e» allowed): «rodvins|polse», «ol|polse», «aquavit|gele». «ciderm|ost»
// (from «Cidermost») is not «cider» + «ost».
const ALCOHOL_COMPOUND_ENDS = [...ALCOHOL_STEMS, ...ALCOHOL_WORDS, "brygg", "spritz"];
function isAlcoholPrefix(p: string): boolean {
  const ends = (x: string) => x.length > 0 && isAlcoholToken(x) && ALCOHOL_COMPOUND_ENDS.some((s) => x.endsWith(s));
  return ends(p) || ((p.endsWith("s") || p.endsWith("e")) && ends(p.slice(0, -1)));
}

/**
 * True when the folded token is a food word: a food head on its own, or a
 * compound whose LAST part is a food head. For a token that is itself an
 * alcohol token the first part must be the alcohol word («Rødvinspølse»), so
 * a drink whose name merely ends in a food head is never food. Short heads
 * («is», «ost») need a first part of at least four letters in a non-alcohol
 * compound («Vaniljeis», «Geitost»; not «Pastis», «Most»), and with
 * `strict` they count only as words of their own: «Hvitvin Solaris» is wine
 * with a grape name, not wine before an ice cream.
 */
export function isFoodToken(t: string, strict = false): boolean {
  // Musts («Eplemost», «Pæremost») are drinks, not «-ost» cheese.
  if (NOT_FOOD_TOKENS.has(t) || t.endsWith("most")) return false;
  const alcohol = isAlcoholToken(t);
  for (const h of FOOD_HEADS) {
    for (const e of FOOD_HEAD_ENDINGS) {
      const head = h + e;
      if (!t.endsWith(head)) continue;
      const prefix = t.slice(0, t.length - head.length);
      if (prefix === "") return !alcohol;
      if (alcohol) { if (isAlcoholPrefix(prefix)) return true; continue; }
      if (h.length <= SHORT_FOOD_HEAD_LENGTH ? !strict && prefix.length >= 4 : prefix.length >= 2) return true;
    }
  }
  return false;
}

// Drink signs in the name OR the description cancel the food exemption
// (fail-closed): a volume («70 cl», «0,5 l», «1 liter», «centiliter», a bare
// «liter»), a bottle (any token with «flaske»: «halvflaske», «glassflaske»),
// «% vol», «% alkohol», «alk. 40», «40 prosent» or a % figure above 2.5.
export function hasDrinkSigns(name: string, description: string): boolean {
  const text = `${name} ${description}`.toLowerCase();
  if (/(^|[^\p{L}\d])\d+(?:[.,]\d+)?\s*(?:cl|ml|dl|l|ltr|liter|litre|liters|centiliter|milliliter|desiliter)(?!\p{L})/u.test(text)) return true;
  if (tokens(text).some((t) => t.includes("flaske") || t === "fl" || t.includes("bottle") || t === "liter" || t.endsWith("liter"))) return true;
  if (/%\s*vol|vol\.?\s*%|\balc\.?\s*\d|%\s*alk|\d\s*prosent|\balk\.?\s*\d/.test(text)) return true;
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    if (parseFloat(m[1]!.replace(",", ".")) > 2.5) return true;
  }
  return false;
}

// «<food> med <alcohol>»: the alcohol word is an ingredient.
const INGREDIENT_PREPOSITIONS = new Set(["med", "m", "i"]);

// Food words that are also drinks (hot chocolate, cocoa, coffee, tea,
// toddy, punch): never the food side of «<food> med <alcohol>».
const DRINKABLE_FOOD_HEADS = ["sjokolade", "kakao", "kaffe", "te", "toddy", "punsj"];
// Alternative A: after the alcohol word of «<food> med <alcohol>» (and after
// the food noun of a participle) there is a weight in g/kg and nothing else.
// The tokens split «1,5kg» into «1» «5kg» and «200 g» into «200» «g».
const WEIGHT_TAIL = /^(\d+ )?\d+ ?(g|gr|gram|kg)$/;
function isWeightTail(tail: readonly string[]): boolean {
  return WEIGHT_TAIL.test(tail.join(" "));
}

// «<alcohol>marinert laks», «<alcohol>gravet ørret», «<alcohol>røkt ost»: a
// participle compound describing the food noun after it. Not «-lagret»
// («Sherrylagret Single Malt» is whisky).
const ALCOHOL_PARTICIPLES = [
  "marinert", "marinerte", "gravet", "gravede", "gravlagt", "gravlagte", "rokt", "rokte", "glasert", "glaserte",
  "syltet", "syltede", "flambert", "flamberte",
];
// Fish and meat nouns a participle may describe (besides FOOD_HEADS, read strictly).
const PARTICIPLE_FOOD_NOUNS = [
  "laks", "orret", "roye", "sild", "makrell", "torsk", "kveite", "filet", "kjott", "biff", "ribbe", "stek", "lammelar",
  "fenalar", "svinekam", "nakke", "bryst", "kylling", "reker",
];
function isParticipleFoodNoun(t: string): boolean {
  if (isFoodToken(t, true)) return true;
  return PARTICIPLE_FOOD_NOUNS.some((h) => t === h || (h.length >= 4 && t.length > h.length + 1 && t.endsWith(h)));
}
function alcoholParticiple(t: string): boolean {
  return ALCOHOL_PARTICIPLES.some((p) => t.length > p.length && t.endsWith(p) && isAlcoholPrefix(t.slice(0, t.length - p.length)));
}

/**
 * True when the alcohol hit at nameTokens[i] is an ingredient of a food:
 * a food compound itself («Rødvinspølse»); with `noPackage` (no package or
 * gift word in the name, category or description) also an alcohol
 * participle before a food noun with at most a weight after it
 * («Cognacmarinert laks», «Akevittmarinert gravlaks 300g»), or exactly
 * «<food> med/m/i <alcohol> <weight g/kg>» with the food word right before
 * the preposition and nothing after the alcohol word but that weight
 * («Festpølse med akevitt 280g»; not «Pølse med akevitt», «Pølse med øl
 * 6 pk», «Pølse med akevitt og pils», «Spekepølse med ost og akevitt»). The
 * food word is read strictly («Paradis», «Julefrokost» are not food) and
 * never a drinkable head («Varm sjokolade med likør»). An alcohol word
 * before a food word («Likør Sjokolade») is a flavoured drink, never an
 * ingredient. The caller has already ruled out drink signs, bundles and a
 * second alcohol word.
 */
function alcoholIsIngredient(tks: readonly string[], i: number, noPackage: boolean): boolean {
  if (isFoodToken(tks[i]!)) return true;
  if (!noPackage) return false;
  // One food item only: no «og»/«and» list anywhere in the name.
  if (tks.some((t) => t === "og" || t === "and" || t === "pluss")) return false;
  if (alcoholParticiple(tks[i]!)) {
    const noun = tks[i + 1];
    return !!noun && !isAlcoholToken(noun) && isParticipleFoodNoun(noun) &&
      (i + 2 === tks.length || isWeightTail(tks.slice(i + 2)));
  }
  if (i < 2 || !INGREDIENT_PREPOSITIONS.has(tks[i - 1]!)) return false;
  const food = tks[i - 2]!;
  if (!isFoodToken(food, true) || DRINKABLE_FOOD_HEADS.some((h) => food === h || food.endsWith(h))) return false;
  return isWeightTail(tks.slice(i + 1));
}

// Bundles and gift packs («Gavepakke», «Julekurv», «Smaksboks», «Gaver»):
// they may hold a bottle, so the food exemption is off (fail-closed).
const BUNDLE_HEADS = ["pakke", "kurv", "boks", "kasse", "sett", "eske", "kolli"];
function isBundleToken(t: string): boolean {
  // «gave» anywhere: «Gavepakke», «Julegave», «Julegaver», «Firmagave».
  if (t.includes("gave") || t.startsWith("gift") || t.startsWith("smaksprove")) return true;
  return BUNDLE_HEADS.some((h) => ["", "r", "er", "en", "ene", "ne"].some((e) => t.endsWith(h + e)));
}

// Alternative A, package/gift words (whole tokens, or the listed parts of a
// compound) that close «<food> med <alcohol>» and the participle rule when
// they stand in the name, the category or the description: bundles and
// gifts (isBundleToken), «pakning», «pakketilbud», combos, multipacks
// («6 pk», «6pk», «x6», «6x», «2 x 280g», «multipack»). «Vakuumpakning» is
// how food is packed, not a package deal. Bare «sett» is a package only in
// the name and category; in a description it is also the verb («har du
// sett»), so there only compounds count («Gavesett», «Julesett»).
const PACKAGE_WORDS = new Set([
  "pk", "pkn", "pakn", "pakning", "pakninger", "pakningen", "pack", "pak", "multipack", "multipak", "sixpack",
  "kombo", "combo", "kombinasjon", "duo", "trio", "kvartett", "bundle", "hamper", "x",
]);
function isPackageToken(t: string, inDescription = false): boolean {
  if (t.startsWith("vakuum")) return false;
  if (inDescription && t === "sett") return false;
  if (isBundleToken(t) || PACKAGE_WORDS.has(t)) return true;
  if (t.startsWith("pakke") || t.startsWith("kombo") || t.startsWith("combo")) return true;
  if (/pakning(er|en|ene)?$/.test(t) || /(kombo|combo|duo|trio|pack)$/.test(t)) return true;
  return /^\d+(pk|pkn|pak|pack|x)$/.test(t) || /^x\d+$/.test(t);
}
// Signs of a hot or served drink («Varm sjokolade med likør», «Serveres varm»).
function isServedDrinkToken(t: string): boolean {
  return t === "varm" || t === "varme" || t.startsWith("drikk") || t.startsWith("drink") || t.startsWith("kopp") ||
    t === "servering" || t === "serveres";
}

// Category words that say the row is food (besides FOOD_HEADS), used only to
// let a drink producer's food row through («Ølpølse» from a brewery, «pølser»).
const FOOD_CATEGORY_WORDS = new Set([
  "kjott", "meat", "spekemat", "charcuterie", "sausage", "sausages", "bakervarer", "bakery", "godteri", "sweets",
  "candy", "dairy", "meieri", "meieriprodukter", "desserts", "dessert",
]);

/** Free-text alcohol category: a known category, an alcohol word/stem («Likører», «Gin & likør») or «alkohol…». */
// For category tokens only the explicit lists count, not the generic
// «-ol»/«-vin» compound rules («Honning og propol»), and «alkoholfri…» is
// not alcohol («Alkoholfri drikke»).
function isAlcoholCategoryToken(t: string): boolean {
  if (NOT_ALCOHOL_TOKENS.has(t) || t.endsWith("eddik") || t.startsWith("alkoholfri")) return false;
  return ALCOHOL_CATEGORIES.has(t) || ALCOHOL_WORDS.has(t) || t.startsWith("alkohol") ||
    ALCOHOL_STEMS.some((s) => t.startsWith(s) || t.endsWith(s));
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
  // «Rogn og rom»: «rom» next to a roe word in the category is roe, not rum.
  const categoryHasRoe = categoryTokens.some((t) => isRoeToken(t));
  const alcoholCategory = categoryTokens.some((t) => !(categoryHasRoe && t === "rom") && isAlcoholCategoryToken(t));
  // Drink categories: «Drikke», «Drikker», «Drikk», «Drikkevarer», «Leskedrikker», «Varme drikker».
  const isBeverageCategory = categoryTokens.some((t) => t === "beverages" || t === "beverage" || t === "drinks" ||
    t.startsWith("drikk") || t.endsWith("drikk") || t.endsWith("drikke") || t.endsWith("drikker"));
  const drinkProducer = producerTypeTokens.some((t) => DRINK_PRODUCER_TYPES.has(t) || startsWithAny(t, ["bryggeri", "destilleri", "cideri", "sideri", "vingard", "mjoderi", "brenneri"]));

  const alcoholWordHit = (tks: string[], ingredient?: (i: number) => boolean): boolean =>
    tks.some((t, i) => {
      if (t.endsWith("rom") && tks.some((x) => isRoeToken(x))) return false;
      if (t === "spritz" && (tks[i + 1] ?? "").startsWith("kak")) return false; // «Spritz-kaker»
      return isAlcoholToken(t) && !(ingredient && ingredient(i));
    }) || bitterIsDrink(tks);
  // S1: «rosé» with its accent is the wine; plain «rose» and «Rosé-pepper» are
  // left alone (the tokens fold é to e, so this reads the raw name).
  const roseHit = /(^|[^\p{L}])rosé(?!\p{L}|-\p{L})/u.test(name.toLowerCase());
  // Food exemption (2026-11-11): only for the name check, and never with drink signs.
  // A drink producer's row needs an explicit (non-drink) food category for it.
  const foodCategory = !alcoholCategory && !isBeverageCategory &&
    categoryTokens.some((t) => FOOD_CATEGORY_WORDS.has(t) || isFoodToken(t, true));
  const foodExemptionOpen = !hasDrinkSigns(name, description) && (!drinkProducer || foodCategory) &&
    !nameTokens.some(isBundleToken) && !categoryTokens.some(isBundleToken) &&
    !textTokens.some(isServedDrinkToken) &&
    nameTokens.filter((t) => isAlcoholToken(t)).length <= 1 &&
    // a list in the name («Ost, kjeks & portvin») may hold a bottle; a decimal comma («1,5kg») is no list
    !/[,&+;]/.test(name.replace(/(\d),(\d)/g, "$1$2"));
  // Alternative A: no package or gift word anywhere for the «med» and participle rules.
  const noPackage = !nameTokens.some((t) => isPackageToken(t)) && !categoryTokens.some((t) => isPackageToken(t)) &&
    !tokens(description).some((t) => isPackageToken(t, true));
  const nameAlcoholHit = alcoholWordHit(nameTokens, foodExemptionOpen ? (i) => alcoholIsIngredient(nameTokens, i, noPackage) : undefined) || roseHit;
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
