// ─── The RFB search's filler words, and where one may still be a place ─────
//
// dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-W4 (found live
// 2026-10-18 on 7131787f, P1). NO_PRODUCT_WORDS and QUALIFIER_WORDS moved
// here, unchanged, from marketplace-registry.ts, so the geocoder
// (geocoding-service.ts extractAndGeocode) reads the same lists as the parser
// without importing the registry. Pure: static word lists and the shared
// QUERY_STOPWORDS and PLACE_PREPOSITIONS (norwegian-query.ts), no DB and no
// network.
//
// Kartverket geocodes «Finnes» as a place (62.12 N 6.55 Ø, radius 15 km), so
// «Finnes det noen bakeri som lager kransekake» and «Finnes det kransekake»
// searched a 15 km circle around a small village and found nothing, and
// «Finnes det noen bakeri med kransekake i Bærum» never reached Bærum: the
// geocoder takes the first word that resolves. A filler word is therefore no
// place, unless a place preposition stands right before it («i Finnes», «på
// Time») or it is the whole search («Finnes»). In the repo's own place data
// (the gazetteer, the postnummer register and the hardcoded cities) the
// lists hold four more: «nå» (poststed NÅ, and the city of two producers,
// which geocode() finds first), «time» (Time kommune), «feiring» (poststed
// FEIRING) and «more» (Møre in ASCII, a place word of marketplace-registry.ts
// by its own list). Kartverket knows more of them than the repo can tell.

import { PLACE_PREPOSITIONS, QUERY_STOPWORDS } from "./norwegian-query";

/**
 * Words of a food search that name no product, in addition to the shared
 * QUERY_STOPWORDS (search-intent/norwegian-query.ts: question words,
 * pronouns, request verbs, praise and time words). Review round 1 of slice
 * I-W: a word step 3c looks up only has to start a word of a product name,
 * so a filler word let in every producer whose products start with it, shown
 * as a product match: in the live catalogue (2026-10-18) «vil» («jeg vil ha
 * kransekake») starts a product name at 37 producers («Villsau…»,
 * «Villblåbær…»), «dag» at 11 («Dagssuppe»), «hjemmelaget» at 7. Pass 2 of
 * parseNaturalQuery skips them too, so they make no name search either.
 * Lower case; Norwegian (bokmål and nynorsk) and English.
 */
export const NO_PRODUCT_WORDS: ReadonlySet<string> = new Set([
  // who is searched among («produsenter i Trondheim»), and «hvem», which the shared list lacks
  "produsent", "produsenter", "matprodusent", "matprodusenter", "bonde", "bonden", "bondens",
  "bønder", "gårder", "butikker", "utsalg", "hvem",
  // buying, ordering and needing
  "kjøp", "kjøper", "kjøpes", "kjøpt", "handle", "handler", "bestill", "bestilling", "bestiller",
  "trenger", "trengs", "skaffe", "purchase", "buying",
  // delivery, pickup and the web shop
  "levering", "levere", "leverer", "leveres", "levert", "hjemlevering", "frakt", "sende", "sendes",
  "hente", "henting", "hentes", "nett", "nettet", "nettbutikk", "nettbutikken", "online", "delivery",
  "deliver", "shipping",
  // how or where it is made, and how good, not what it is («hjemmelaget kransekake»)
  "hjemmelaget", "hjemmelagd", "hjemmelagde", "hjemmelagede", "hjemmelaga", "heimelaga", "heimelaget",
  "heimelagd", "hjemmebakt", "hjemmebakte", "håndlaget", "håndlagde", "handlaga", "homemade", "handmade",
  "norsk", "norske", "norskprodusert", "norwegian", "ekte", "egen", "egne", "eget", "eige", "eigne",
  "deilig", "deilige", "nydelig", "nydelige", "kvalitet", "tradisjonell", "tradisjonelle", "tradisjonelt",
  "traditional", "authentic", "quality",
  // amounts and the word «product» itself
  "kilo", "gram", "liter", "stk", "produkt", "produktet", "vare", "matvarer", "product", "products",
  // Slice I-W2 (S4): looking for it, and who makes it. Inside a producer name
  // they made a name search of the whole question: «ser» («Hvasser») in «Jeg
  // ser etter kransekake», «lager» («Fruktlager», «Lager 11») in «Hvem lager
  // spekepølse», «make» («Ostemakeri») in «Which bakeries make kransekake».
  // «leter» ends «Fiskefileter». Slice I-W3, review round 1 (S1): «finner»,
  // which «Finnerud Gård» begins, made «Hvor finner jeg kortreist mat i
  // Oslo?» the name search «finner mat» («finne» and «finn» are skipWords).
  "ser", "leter", "lete", "søker", "finner", "lager", "lage", "lages", "produserer", "produsere",
  "make", "makes", "making",
  // «hvor får jeg tak i kransekake», «… i nærheten av Bergen»
  "tak", "nærheten",
  // Slice I-W2, review round 3 (FUNN rfb-sok-kategori-pluss-ord-etikettgrunnlag):
  // «kortreist», the platform's own word for what every producer here sells.
  // Next to a category word it ranked the one producer with it in a product
  // name first and labelled the rest «Kategoritreff: «kortreist» ikke
  // oppført» («egg kortreist»: Lofseik Gård first, the farms with eggs
  // labelled). No product name in the live catalogue (2026-10-17) starts
  // with it; one has it as a label, «Rotgrønnsaker (kortreist)». It is a
  // whole word of the producer name «Osteverkstedet — Kortreist Italiener»,
  // so Pass 2 made «kortreist kransekake» and «kortreist i Trondheim» name
  // searches for that producer alone (main too). As a filler word Pass 2
  // skips it, and alone it still makes that name search (a search of filler
  // words only is read by main's rule). «kortreiste» is in QUALIFIER_WORDS.
  "kortreist",
]);

/**
 * Slice I-W2 (S1): words for the occasion, the meal, the time of year, the
 * size, the packaging or the price of what is sought, not the product. Next
 * to a product word they only brought in producers that match them alone,
 * as product matches: in the live catalogue (2026-10-17) a product name
 * starts with «stor» at 47 producers («Storfekjøtt»), «gave» at 17, «lunsj»
 * at 17 and «selskap» at 11, and «kransekake til lunsj» gave Lillehammer
 * Bakeri («Frukost og lunsj») first. Such a word counts only when nothing
 * else in the search names a product («lunsj» alone still finds lunch). Not
 * here: «bryllup» and «konfirmasjon», which name a product («Kransekake
 * bryllup», «Bryllupskaker»). Lower case; bokmål, nynorsk and English.
 * A list, not «the word with the fewest producers is the product»: «frokost»
 * starts a product name at 4 live producers and «syltetøy» at 48, so that
 * rule would answer «syltetøy til frokost» with breakfast and no jam.
 * Review round 3: also how fresh, near, natural or wholesome it is (the
 * last group below).
 */
export const QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  // occasion
  "selskap", "selskaper", "selskapet", "gave", "gaver", "gaven", "presang", "fest", "festen", "bursdag",
  "bursdagen", "jubileum", "feiring", "anledning", "party", "gift", "gifts", "present", "birthday", "wedding",
  // holidays and the time of year («17. mai»)
  "jul", "julen", "jula", "julaften", "påske", "påsken", "påska", "mai", "sommer", "sommeren", "vinter",
  "vinteren", "høst", "høsten", "christmas", "easter", "summer", "winter", "autumn",
  // meal
  "frokost", "frukost", "lunsj", "lunch", "middag", "middagen", "kveldsmat", "brunsj", "brunch", "breakfast",
  "dinner",
  // size
  "liten", "lite", "lita", "lille", "små", "stor", "store", "stort", "større", "størst", "small", "large", "big",
  // packaging
  "boks", "bokser", "pakke", "pakker", "pakning", "eske", "esker", "pose", "poser", "box", "pack", "package",
  // price and offer
  "tilbud", "tilbudet", "rabatt", "salg", "offer", "discount",
  // Review round 3 (FUNN rfb-sok-kategori-pluss-ord-etikettgrunnlag): how
  // fresh, near, natural or wholesome it is. Next to a category word such a
  // word ranked the producers with it in a product name first and labelled
  // the rest «Kategoritreff: «…» ikke oppført» («nybakt brød»: the bakeries
  // without «Nybakt brød»). Here, not in NO_PRODUCT_WORDS: in the live
  // catalogue (2026-10-17) product names start with «nybakt» («Nybakt
  // brød», 3 producers), «frisk» («Friske urter», 2) and «naturlig»
  // («Naturlige såper», «Naturlig kosmetikk», 3), and a search of one such
  // word keeps main's answer: those products, a name search («ren», «sunn»
  // sit inside many names) or the honest no-match answer («kortreiste»,
  // «sunt»), where a NO_PRODUCT_WORDS word alone gives the standard list.
  // Not here: «rein» (reindeer, «Reinkjøtt»); «lokal», «fersk», «økologisk»,
  // «local», «fresh», «organic» and their forms, which are tag words
  // (tagMap) and never unknown words; and «kortreist», in NO_PRODUCT_WORDS.
  "nybakt", "nybakte", "frisk", "friske", "kortreiste", "gårdsprodusert", "gårdsproduserte", "småskala",
  "homegrown", "naturlig", "naturlige", "natural", "ren", "rene", "pure", "sunn", "sunne", "sunt", "healthy",
  // Slice I-W3 (FUNN rfb-sok-egenskapsord-hale): next to a category word
  // «gourmet» and «artisan» still labelled its producers «Kategoritreff:
  // «…» ikke oppført» («gourmet brød», «artisan bread»). Alone each is read
  // as before: «gourmet» names «Frøya Gourmet», and «artisan» finds
  // «Syltetøy artisan» (live catalogue 2026-10-17). Review round 1 (S2):
  // «artisanal» too, which no live producer or product name holds.
  "gourmet", "artisan", "artisanal",
]);

/**
 * Slice I-W4: common question words the lists above lack, the nynorsk forms
 * (the shared list has «kva», «kor» and «korleis»). None is a place in the
 * repo's place data. Only the place reading uses them (FILLER_WORDS): the
 * parser reads them as before, so «kven» alone still answers as on main.
 */
export const NYNORSK_QUESTION_WORDS: ReadonlySet<string> = new Set(["kven", "kvar", "kvifor", "korfor", "finst"]);

/**
 * Every filler word of the RFB search (lower case): the shared
 * QUERY_STOPWORDS, NO_PRODUCT_WORDS, QUALIFIER_WORDS and
 * NYNORSK_QUESTION_WORDS.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  ...QUERY_STOPWORDS, ...NO_PRODUCT_WORDS, ...QUALIFIER_WORDS, ...NYNORSK_QUESTION_WORDS,
]);

/**
 * True when `tokens[i]` (the lower-case words of one search, in order) is a
 * filler word that names no place where it stands: not right after a place
 * preposition (PLACE_PREPOSITIONS: «i», «på», «ved», «nær», «in», «near» …)
 * and not the whole search. See the header for why.
 */
export function isFillerNoPlaceAt(tokens: readonly string[], i: number): boolean {
  return FILLER_WORDS.has(tokens[i]) && tokens.length > 1 && !(i > 0 && PLACE_PREPOSITIONS.has(tokens[i - 1]));
}
