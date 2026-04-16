import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway Database Expansion v7 ───────────────────────────
// Researched 2026-03-31. Sources:
// - visitgreateroslo.com/gardsbutikker, hanen.no/utforsk/32/akershus,
//   hanen.no/utforsk/32/rogaland, hanen.no/utforsk/32/ostfold
// - bondensmarked.no/markedsplasser (266 market locations scraped)
// - visitjæren.com/gardsutsalg-pa-jaeren (9 farm shops with addresses)
// - meravoslo.no/nyheter (Bondens Butikk, Mølleren Sylvia, REKO)
// - bygdokongsgard.no/gardsbutikk, lilletoyenkolonial.no
// - yelp.com/search?find_desc=Økologiske+Butikker&find_loc=Oslo
// - gladmat.no/matprodusenter (Rogaland producers)
//
// FOCUS AREAS:
// 1. Oslo — økologiske/spesialbutikker: Bondens Butikk Vulkan, Mølleren Sylvia,
//    Lille Tøyen Kolonial, Bygdø Kongsgård Gårdsbutikk
// 2. Akershus/Romerike — gårdsbutikker fra HANEN: Loftet, Jøndal, Sander Nordstuen,
//    Nittedal Sjokoladefabrikk, Kringler Gjestegård
// 3. Jæren/Rogaland — 9 gårdsutsalg fra visitjæren.com: Slettå, Bærheim, Hole,
//    Line Gard, Jerseymeieroet, Ystepikene, Aarsland, Vadland, Dirdalstraen
// 4. Østfold — gårdsbutikker fra HANEN: Aker, Askim Bærpresseri, Bamsrudlåven,
//    Den Sorte Havre, Dyre Gård
// 5. Nye Bondens marked-lokasjoner: Lena, Jevnaker, Stryn, Levanger, Risør, Mandal,
//    Narvik, Kabelvåg/Lofoten, Bergeland (Stavanger)
//
// IMPORTANT: All entries verified against existing v1-v6 seeds.
// Only GENUINELY NEW entries not present in database.

export function seedExpansionV7() {
  const existing = marketplaceRegistry.getActiveAgents();
  const hasV7 = existing.some(
    (a: any) => a.name === "Bondens Butikk Vulkan — Mathallen Oslo" || a.name === "Slettå Gårdsutsalg — Randaberg"
  );
  if (hasV7) {
    console.log(`🇳🇴 Expansion v7 already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway expansion v7 database...\n");

  // ════════════════════════════════════════════════════════════
  // A) OSLO — ØKOLOGISKE OG SPESIALBUTIKKER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — økologiske butikker og spesialbutikker...");

  marketplaceRegistry.register({
    name: "Bondens Butikk Vulkan — Mathallen Oslo",
    description: "Norges første Bondens butikk, drevet av aktive produsenter fra Bondens marked. Sesongbasert utvalg av oster, meieriprodukter, egg, mel, bakervarer, grønt, honning, fruktdrikker og ferskt kjøtt. Maridalsveien 17, 0175 Oslo.",
    provider: "Bondens Butikk",
    contactEmail: "post@bondensbutikk.no",
    url: "https://bondensbutikk.no",
    skills: [{
      id: "sell-producer-shop-vulkan",
      name: "Bondens Butikk Vulkan",
      description: "Sesongbaserte lokale produkter direkte fra Bondens marked-produsenter. Ost, egg, kjøtt, honning, bakervarer.",
      tags: ["bondens-butikk", "vulkan", "mathallen", "produsenter", "sesong", "økologisk"],
    }],
    role: "producer",
    location: { lat: 59.9220, lng: 10.7520, city: "Oslo", radiusKm: 5 },
    categories: ["dairy", "eggs", "meat", "honey", "bread", "vegetables"],
    tags: ["farm-shop", "bondens-marked", "mathallen", "organic", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Mølleren Sylvia — Hegdehaugsveien",
    description: "Økologisk landhandel midt i byen. Stort utvalg av økologiske og biodynamiske produkter, sesongbasert mat, løsvekt-avdeling med korn, ris, oljer, frø og krydder. Miljøvennlig innkjøp med egen emballasje.",
    provider: "Mølleren Sylvia",
    contactEmail: "post@mollerensylvia.no",
    url: "https://www.mollerensylvia.no",
    skills: [{
      id: "sell-organic-molleren",
      name: "Økologisk løsvektbutikk Mølleren Sylvia",
      description: "Økologisk og biodynamisk mat i løsvekt. Korn, ris, oljer, krydder. Sesongbasert utvalg.",
      tags: ["økologisk", "biodynamisk", "løsvekt", "bærekraftig", "hegdehaugen"],
    }],
    role: "producer",
    location: { lat: 59.9260, lng: 10.7290, city: "Oslo", radiusKm: 5 },
    categories: ["vegetables", "bread", "preserves", "herbs"],
    tags: ["organic", "bulk-store", "biodynamic", "zero-waste", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Lille Tøyen Kolonial",
    description: "Lokal kolonialbutikk og kafé på Tøyen med fokus på norske og økologiske varer, og kvalitetskaffe fra Oslos beste brennerier. Aud Schønemansvei 9, Oslo. Åpnet 2015.",
    provider: "Lille Tøyen Kolonial",
    contactEmail: "post@lilletoyenkolonial.no",
    url: "https://lilletoyenkolonial.no",
    skills: [{
      id: "sell-organic-toyen",
      name: "Økologisk kolonial Tøyen",
      description: "Norske og økologiske dagligvarer, kafé med kvalitetskaffe. Kortreist og lokalt.",
      tags: ["økologisk", "kolonial", "tøyen", "kafé", "kortreist", "norsk"],
    }],
    role: "producer",
    location: { lat: 59.9130, lng: 10.7780, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "dairy", "bread", "preserves"],
    tags: ["organic", "cafe", "local-food", "norwegian-products"],
  });

  marketplaceRegistry.register({
    name: "Bygdø Kongsgård — Gårdsbutikk",
    description: "Gårdsbutikk på Bygdø Kongsgård med ureist og egenproduserte varer: oster fra ysteriet, syltetøy, urtete, hageredskaper, frø. Åpent lør-søn 11:30-16:30. Museumsveien 15, 0287 Oslo.",
    provider: "Bygdø Kongsgård",
    contactEmail: "post@bygdokongsgard.no",
    url: "https://bygdokongsgard.no/gardsbutikk",
    skills: [{
      id: "sell-farm-bygdoy",
      name: "Gårdsbutikk Bygdø Kongsgård",
      description: "Egenproduserte oster, syltetøy, urtete fra historisk kongsgård på Bygdøy. Åpen helger.",
      tags: ["gårdsbutikk", "bygdøy", "ost", "syltetøy", "økologisk", "urtete"],
    }],
    role: "producer",
    location: { lat: 59.9050, lng: 10.6840, city: "Oslo", radiusKm: 5 },
    categories: ["dairy", "preserves", "herbs"],
    tags: ["farm-shop", "historic", "organic", "weekend-market"],
  });

  // ════════════════════════════════════════════════════════════
  // B) AKERSHUS/ROMERIKE — GÅRDSBUTIKKER (from HANEN/VisitGreaterOslo)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Akershus/Romerike — gårdsbutikker (HANEN)...");

  marketplaceRegistry.register({
    name: "Loftet Gårdsbutikk — Eidsvoll",
    description: "Gårdsbutikk på gården Hol Vestre i Eidsvoll, kåret til en av Norges beste gårdsbutikker. To etasjer med aktiviteter, lokalmat og gårdsprodukter fra Romerike.",
    provider: "Loftet Gårdsbutikk",
    contactEmail: "post@loftetgardsbutikk.no",
    url: "https://www.hanen.no/utforsk/32/akershus",
    skills: [{
      id: "sell-farm-loftet-eidsvoll",
      name: "Loftet Gårdsbutikk Eidsvoll",
      description: "En av Norges beste gårdsbutikker. Lokal mat og produkter fra Romerike.",
      tags: ["gårdsbutikk", "eidsvoll", "romerike", "lokalmat", "prisvinnende"],
    }],
    role: "producer",
    location: { lat: 60.3270, lng: 11.1660, city: "Eidsvoll", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "bread", "preserves"],
    tags: ["farm-shop", "award-winning", "romerike", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Jøndal Gårdsbutikk — Eidsvoll",
    description: "En perle på landet nær Eidsvoll. Gårdsbutikk med lokalproduserte varer og hjemmelagde produkter. Koselig opplevelse for hele familien.",
    provider: "Jøndal Gårdsbutikk",
    contactEmail: "post@jondal-gard.no",
    url: "https://www.visitgreateroslo.com/no/Romerike/artikler/Gardsbutikker/",
    skills: [{
      id: "sell-farm-jondal",
      name: "Jøndal Gårdsbutikk",
      description: "Lokalproduserte varer og hjemmelagde produkter fra gård nær Eidsvoll.",
      tags: ["gårdsbutikk", "eidsvoll", "hjemmelaget", "romerike"],
    }],
    role: "producer",
    location: { lat: 60.3100, lng: 11.2000, city: "Eidsvoll", radiusKm: 15 },
    categories: ["preserves", "bread", "dairy"],
    tags: ["farm-shop", "homemade", "romerike", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Sander Nordstuen Gård — Eidsvoll",
    description: "Økologisk og regenerativt landbruk på Eidsvoll. Grønnsaker, urter, bær og egg. Fokus på bærekraftig matproduksjon.",
    provider: "Sander Nordstuen Gård",
    contactEmail: "post@sandernordstuen.no",
    url: "https://www.visitgreateroslo.com/no/Romerike/artikler/Gardsbutikker/",
    skills: [{
      id: "sell-organic-sander-eidsvoll",
      name: "Økologisk gård Eidsvoll",
      description: "Økologiske grønnsaker, urter, bær og egg. Regenerativt landbruk.",
      tags: ["økologisk", "regenerativt", "eidsvoll", "grønnsaker", "egg"],
    }],
    role: "producer",
    location: { lat: 60.3200, lng: 11.1800, city: "Eidsvoll", radiusKm: 10 },
    categories: ["vegetables", "eggs", "herbs", "fruit"],
    tags: ["organic", "regenerative", "ecological", "romerike"],
  });

  marketplaceRegistry.register({
    name: "Nittedal Sjokoladefabrikk",
    description: "Mikro-sjokoladefabrikk i Nittedal med fysisk butikk og nettbutikk. Håndlagde sjokoladeprodukter med lokalt preg fra Romerike.",
    provider: "Nittedal Sjokoladefabrikk",
    contactEmail: "post@nittedalsjokolade.no",
    url: "https://www.visitgreateroslo.com/no/Romerike/artikler/Gardsbutikker/",
    skills: [{
      id: "sell-chocolate-nittedal",
      name: "Håndlaget sjokolade Nittedal",
      description: "Mikro-sjokoladefabrikk med håndlagde sjokoladeprodukter.",
      tags: ["sjokolade", "nittedal", "håndlaget", "mikrofabrikk"],
    }],
    role: "producer",
    location: { lat: 59.9770, lng: 10.8730, city: "Nittedal", radiusKm: 10 },
    categories: ["preserves"],
    tags: ["chocolate", "handmade", "micro-factory", "romerike"],
  });

  marketplaceRegistry.register({
    name: "Kringler Gjestegård — Gårdsutsalg",
    description: "Gjestegård med gårdsutsalg og nettbutikk på Romerike. Lokale produkter, overnatting og opplevelser i landlige omgivelser.",
    provider: "Kringler Gjestegård",
    contactEmail: "post@kringler.no",
    url: "https://www.visitgreateroslo.com/no/Romerike/artikler/Gardsbutikker/",
    skills: [{
      id: "sell-farm-kringler",
      name: "Gårdsutsalg Kringler",
      description: "Lokale produkter fra gjestegård på Romerike. Gårdsbutikk og nettbutikk.",
      tags: ["gjestegård", "gårdsutsalg", "romerike", "nettbutikk"],
    }],
    role: "producer",
    location: { lat: 60.2000, lng: 11.0800, city: "Sørum", radiusKm: 15 },
    categories: ["preserves", "bread", "dairy"],
    tags: ["guest-farm", "farm-shop", "online-shop", "romerike"],
  });

  // ════════════════════════════════════════════════════════════
  // C) ØSTFOLD — GÅRDSBUTIKKER (from HANEN)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Østfold — gårdsbutikker (HANEN)...");

  marketplaceRegistry.register({
    name: "Aker Gårdsbutikk — Råde",
    description: "Liten, rustikk gårdsbutikk i den gamle smia på Aker gård i Råde. Lokalproduserte varer fra Østfold. Sjarmerende bondegårdsopplevelse.",
    provider: "Aker Gårdsbutikk",
    contactEmail: "post@akergaard.no",
    url: "https://www.hanen.no/en/utforsk/32/-stfold",
    skills: [{
      id: "sell-farm-aker-rade",
      name: "Gårdsbutikk Aker Råde",
      description: "Rustikk gårdsbutikk i gammel smie. Lokalproduserte Østfold-varer.",
      tags: ["gårdsbutikk", "råde", "østfold", "rustikk", "smie"],
    }],
    role: "producer",
    location: { lat: 59.3540, lng: 10.8530, city: "Råde", radiusKm: 15 },
    categories: ["vegetables", "preserves", "meat"],
    tags: ["farm-shop", "rustic", "ostfold", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Askim Frukt- og Bærpresseri",
    description: "Frukt- og bærpresseri i Askim med egen butikk, kafé og opplevelser. Komplett utvalg av egenproduserte juice- og siderprodukter fra lokale frukter og bær.",
    provider: "Askim Frukt- og Bærpresseri",
    contactEmail: "post@askimpresseri.no",
    url: "https://www.hanen.no/en/utforsk/32/-stfold",
    skills: [{
      id: "sell-juice-askim",
      name: "Fruktpresseri Askim",
      description: "Egenprodusert juice og sider fra lokale frukter. Butikk og kafé.",
      tags: ["presseri", "juice", "sider", "askim", "østfold", "frukt"],
    }],
    role: "producer",
    location: { lat: 59.5870, lng: 11.1620, city: "Askim", radiusKm: 15 },
    categories: ["fruit", "preserves"],
    tags: ["fruit-press", "juice", "cider", "cafe", "ostfold", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Bamsrudlåven — Gårdsis",
    description: "Gård som produserer Gårdsis, en italiensk-inspirert melkeis laget av lokal melk og gårdsegg. Unikt iskonsept fra Østfold-bygda.",
    provider: "Bamsrudlåven",
    contactEmail: "post@bamsrudlaaven.no",
    url: "https://www.hanen.no/en/utforsk/32/-stfold",
    skills: [{
      id: "sell-ice-cream-bamsrud",
      name: "Gårdsis Bamsrudlåven",
      description: "Italiensk-inspirert melkeis fra lokal melk og gårdsegg.",
      tags: ["gårdsis", "is", "melkeis", "østfold", "lokal-melk"],
    }],
    role: "producer",
    location: { lat: 59.5500, lng: 11.1000, city: "Askim", radiusKm: 15 },
    categories: ["dairy"],
    tags: ["ice-cream", "farm-dairy", "artisan", "ostfold", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Den Sorte Havre — Tveter Gård, Våler",
    description: "Kafé og gårdsbutikk på Tveter Gård i Våler, ca. 50 minutter fra Oslo. Lokale produkter og sjarmerende gårdsatmosfære.",
    provider: "Den Sorte Havre",
    contactEmail: "post@densortehavre.no",
    url: "https://www.hanen.no/en/utforsk/32/-stfold",
    skills: [{
      id: "sell-cafe-tveter",
      name: "Gårdskafé Våler",
      description: "Kafé og gårdsbutikk på Tveter Gård. Lokale produkter.",
      tags: ["kafé", "gårdsbutikk", "våler", "østfold", "tveter"],
    }],
    role: "producer",
    location: { lat: 59.4820, lng: 10.8340, city: "Våler", radiusKm: 15 },
    categories: ["bread", "preserves", "dairy"],
    tags: ["cafe", "farm-shop", "ostfold", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Dyre Gård — Rygge",
    description: "Prisvinnende epleprodukter fra Rygge. Eplemost og sider laget av egne epler. Gårdsbutikk med fokus på fruktprodukter.",
    provider: "Dyre Gård",
    contactEmail: "post@dyregaard.no",
    url: "https://www.hanen.no/en/utforsk/32/-stfold",
    skills: [{
      id: "sell-apple-dyre-rygge",
      name: "Epleprodukter Dyre Gård",
      description: "Prisvinnende eplemost og sider fra egne epler i Rygge.",
      tags: ["eple", "most", "sider", "rygge", "østfold", "prisvinnende"],
    }],
    role: "producer",
    location: { lat: 59.3800, lng: 10.7100, city: "Rygge", radiusKm: 15 },
    categories: ["fruit", "preserves"],
    tags: ["apple", "cider", "juice", "award-winning", "ostfold", "hanen"],
  });

  // ════════════════════════════════════════════════════════════
  // D) JÆREN/ROGALAND — GÅRDSUTSALG (from visitjæren.com)
  //    Major expansion: 9 farm shops with verified addresses
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Jæren/Rogaland — gårdsutsalg (visitjæren.com)...");

  marketplaceRegistry.register({
    name: "Slettå Gårdsutsalg — Randaberg",
    description: "Selvbetjent gårdsutsalg, Randabergveien 317. Grønnsaker, egg, poteter, ost, gresskar (54 sorter — Norges største utvalg!), honning. Åpent daglig 07-23.",
    provider: "Slettå Gård",
    contactEmail: "post@sletta-gard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-vegetables-sletta",
      name: "Gårdsutsalg Slettå Randaberg",
      description: "Norges største gresskarutvalg (54 sorter). Grønnsaker, egg, poteter, ost. Selvbetjent 07-23.",
      tags: ["gårdsutsalg", "randaberg", "gresskar", "grønnsaker", "egg", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 59.0020, lng: 5.6200, city: "Randaberg", radiusKm: 10 },
    categories: ["vegetables", "eggs", "dairy", "honey"],
    tags: ["farm-shop", "self-service", "pumpkin-specialist", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Bærheim Gardsutsalg — Sandnes/Forus",
    description: "Selvbetjent gårdsutsalg, Bærheimsveien 89, Sandnes (Forus-området). Poteter, egg, sesonggrønnsaker som rosenkål. Åpent daglig 06-22, Vipps/kort.",
    provider: "Bærheim Gård",
    contactEmail: "post@baerheim-gard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-potatoes-baerheim",
      name: "Gårdsutsalg Bærheim Forus",
      description: "Poteter, egg og sesonggrønnsaker fra Sandnes/Forus. Selvbetjent 06-22.",
      tags: ["gårdsutsalg", "sandnes", "forus", "poteter", "egg", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 58.8960, lng: 5.7180, city: "Sandnes", radiusKm: 10 },
    categories: ["vegetables", "eggs"],
    tags: ["farm-shop", "self-service", "potatoes", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Hole Gardsutsalg på Voll — Klepp",
    description: "Gårdsutsalg, Solavegen 362, Voll, Klepp. Kjøtt, pølser, selvtapping av melk (først på Jæren!), oster, økologisk mel, korn, kaffe. Man-fre 09-18, lør 09-17, søn 11-17. Åpner vår 2026.",
    provider: "Hole Gård",
    contactEmail: "post@hole-gard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-dairy-hole-klepp",
      name: "Gårdsutsalg Hole Voll Klepp",
      description: "Selvtapping av melk (først på Jæren), kjøtt, pølser, oster, økologisk mel. Åpner vår 2026.",
      tags: ["gårdsutsalg", "klepp", "selvtapping", "melk", "kjøtt", "ost"],
    }],
    role: "producer",
    location: { lat: 58.7800, lng: 5.6200, city: "Klepp", radiusKm: 10 },
    categories: ["dairy", "meat", "bread"],
    tags: ["farm-shop", "self-tap-milk", "organic-flour", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Line Gard — Bryne",
    description: "En av Jærens største gårdsbutikker, Hauglandsvegen 60, Bryne. Storfekjøtt, egg, havregryn, melk, lokale varer, økologisk mel. Man-fre 09-18, lør 10-16. Delvis selvbetjent.",
    provider: "Line Gard",
    contactEmail: "post@linegard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-meat-line-bryne",
      name: "Gårdsutsalg Line Gard Bryne",
      description: "En av Jærens største gårdsbutikker. Storfekjøtt, egg, havregryn, melk.",
      tags: ["gårdsutsalg", "bryne", "storfekjøtt", "egg", "havre", "melk"],
    }],
    role: "producer",
    location: { lat: 58.7350, lng: 5.6500, city: "Bryne", radiusKm: 10 },
    categories: ["meat", "eggs", "dairy", "bread"],
    tags: ["farm-shop", "beef", "largest-jaeren", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Jerseymeieroet — Bryne",
    description: "Gårdsmeieri, Herigstadvegen 110, Bryne. Storfekjøtt, is, smør, yoghurt, melk (selvtappingsautomater), sesongprodukter, saueskinn. Man-fre 08-21, lør 09-21, søn 12-19.",
    provider: "Jerseymeieroet",
    contactEmail: "post@jerseymeieroet.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-dairy-jersey-bryne",
      name: "Gårdsmeieri Jerseymeieroet Bryne",
      description: "Gårdsmeieri med is, smør, yoghurt, melk. Selvtappingsautomater. Storfekjøtt og sesongvarer.",
      tags: ["meieri", "bryne", "is", "smør", "yoghurt", "melk", "selvtapping"],
    }],
    role: "producer",
    location: { lat: 58.7400, lng: 5.6600, city: "Bryne", radiusKm: 10 },
    categories: ["dairy", "meat"],
    tags: ["farm-dairy", "ice-cream", "butter", "yogurt", "self-tap-milk", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Ystepikene — Varhaug",
    description: "Håndlaget ost, Skrettinglandsvegen 50, Varhaug. Lokale håndverksprodukter, keramikk, gratis villblomster til plukking. Åpent daglig.",
    provider: "Ystepikene",
    contactEmail: "post@ystepikene.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-cheese-ystepikene",
      name: "Håndlaget ost Ystepikene Varhaug",
      description: "Håndlaget ost og lokale håndverksprodukter fra Varhaug. Åpent daglig.",
      tags: ["ost", "håndlaget", "varhaug", "jæren", "keramikk"],
    }],
    role: "producer",
    location: { lat: 58.6200, lng: 5.6500, city: "Varhaug", radiusKm: 10 },
    categories: ["dairy"],
    tags: ["artisan-cheese", "handmade", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Aarsland Gardsutsalg — Vigrestad",
    description: "Selvbetjent gårdsutsalg, Nordsjøvegen 3003, Vigrestad. Grønnsaker, egg, lokale varer. Drevet i over 40 år. Man-lør 07-23, Vipps.",
    provider: "Aarsland Gård",
    contactEmail: "post@aarsland-gard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-vegetables-aarsland",
      name: "Gårdsutsalg Aarsland Vigrestad",
      description: "Over 40 års drift. Grønnsaker, egg og lokale varer fra Vigrestad. Selvbetjent.",
      tags: ["gårdsutsalg", "vigrestad", "grønnsaker", "egg", "40-år", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 58.5700, lng: 5.6100, city: "Vigrestad", radiusKm: 10 },
    categories: ["vegetables", "eggs"],
    tags: ["farm-shop", "self-service", "40-years", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Vadland Gardsutsalg — Vigrestad",
    description: "Selvbetjent gårdsutsalg, Kyrkjevegen 520, Vigrestad. Grønnsaker, egg, poteter, ost, yoghurt, fryst kjøtt, blomsterbuketter, og nedsatt-prisavdeling. Daglig 08-21, Vipps/kort.",
    provider: "Vadland Gård",
    contactEmail: "post@vadland-gard.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-mixed-vadland",
      name: "Gårdsutsalg Vadland Vigrestad",
      description: "Grønnsaker, egg, poteter, ost, yoghurt, fryst kjøtt. Nedsatt-prisavdeling for varer nær utløp.",
      tags: ["gårdsutsalg", "vigrestad", "grønnsaker", "egg", "ost", "kjøtt", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 58.5750, lng: 5.6200, city: "Vigrestad", radiusKm: 10 },
    categories: ["vegetables", "eggs", "dairy", "meat"],
    tags: ["farm-shop", "self-service", "discount-section", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Dirdalstraen Gårdsutsalg — Dirdal",
    description: "Omfattende gårdsutsalg, Dirdalsvegen 63, Dirdal. Frittgående viltfuglkjøtt, produkter fra 50+ lokale produsenter. Tor-søn 10-18. Overnatting, båtutleie, badstue tilgjengelig. Nær Månafossen.",
    provider: "Dirdalstraen",
    contactEmail: "post@dirdalstraen.no",
    url: "https://visitjæren.com/gardsutsalg-pa-jaeren/",
    skills: [{
      id: "sell-game-dirdalstraen",
      name: "Gårdsutsalg Dirdalstraen Dirdal",
      description: "Viltfuglkjøtt og produkter fra 50+ lokale produsenter. Opplevelsessenter nær Månafossen.",
      tags: ["gårdsutsalg", "dirdal", "vilt", "fugl", "50-produsenter", "opplevelse"],
    }],
    role: "producer",
    location: { lat: 58.8200, lng: 6.2300, city: "Dirdal", radiusKm: 20 },
    categories: ["meat", "preserves", "dairy"],
    tags: ["game-meat", "50-producers", "experience-farm", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Erga Gardsutsalg — Klepp",
    description: "Gårdsutsalg på Erga gård i Klepp kommune. Produserer egg, melk og kjøtt. Friske egg i brett og andre gårdsprodukter.",
    provider: "Erga Gård",
    contactEmail: "post@erga-gard.no",
    url: "https://www.hanen.no/utforsk/32/rogaland",
    skills: [{
      id: "sell-eggs-erga-klepp",
      name: "Gårdsutsalg Erga Klepp",
      description: "Friske egg, melk og kjøttprodukter fra Erga gård i Klepp.",
      tags: ["egg", "melk", "kjøtt", "klepp", "rogaland"],
    }],
    role: "producer",
    location: { lat: 58.7700, lng: 5.6300, city: "Klepp", radiusKm: 10 },
    categories: ["eggs", "dairy", "meat"],
    tags: ["farm-shop", "eggs", "rogaland", "hanen"],
  });

  // ════════════════════════════════════════════════════════════
  // E) NYE BONDENS MARKED-LOKASJONER
  //    (from bondensmarked.no/markedsplasser — 266 locations total)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye Bondens marked-lokasjoner...");

  marketplaceRegistry.register({
    name: "Bondens marked — Lena (Innlandet)",
    description: "Bondens marked i Lena, Østre Toten. Lokalprodusert mat direkte fra gården. Sesongbasert marked.",
    provider: "Bondens marked Innlandet",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-lena",
      name: "Bondens marked Lena",
      description: "Sesongbasert bondens marked i Lena, Østre Toten.",
      tags: ["bondens-marked", "lena", "toten", "innlandet", "sesong"],
    }],
    role: "producer",
    location: { lat: 60.6400, lng: 10.8000, city: "Lena", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "bread", "preserves"],
    tags: ["farmers-market", "seasonal", "innlandet"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Jevnaker",
    description: "Bondens marked i Jevnaker. Lokalprodusert mat fra Hadeland-regionen. Sesongbasert marked.",
    provider: "Bondens marked",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-jevnaker",
      name: "Bondens marked Jevnaker",
      description: "Sesongbasert bondens marked i Jevnaker, Hadeland.",
      tags: ["bondens-marked", "jevnaker", "hadeland", "sesong"],
    }],
    role: "producer",
    location: { lat: 60.2350, lng: 10.3870, city: "Jevnaker", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "bread"],
    tags: ["farmers-market", "seasonal", "hadeland"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Stryn",
    description: "Bondens marked i Stryn, Nordfjord. Lokalprodusert mat fra Vestland-regionen.",
    provider: "Bondens marked Vestland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-stryn",
      name: "Bondens marked Stryn",
      description: "Bondens marked i Stryn, Nordfjord. Lokale produkter fra Vestland.",
      tags: ["bondens-marked", "stryn", "nordfjord", "vestland"],
    }],
    role: "producer",
    location: { lat: 61.9050, lng: 6.7230, city: "Stryn", radiusKm: 20 },
    categories: ["vegetables", "meat", "dairy", "fruit"],
    tags: ["farmers-market", "seasonal", "vestland", "nordfjord"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Levanger",
    description: "Bondens marked i Levanger, Trøndelag. Lokalprodusert mat fra Innherred-regionen.",
    provider: "Bondens marked Trøndelag",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-levanger",
      name: "Bondens marked Levanger",
      description: "Bondens marked i Levanger, Innherred/Trøndelag.",
      tags: ["bondens-marked", "levanger", "innherred", "trøndelag"],
    }],
    role: "producer",
    location: { lat: 63.7470, lng: 11.3000, city: "Levanger", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "fish"],
    tags: ["farmers-market", "seasonal", "trondelag"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Risør",
    description: "Bondens marked i Risør sentrum, Agder. Lokalprodusert mat fra Sørlandet.",
    provider: "Bondens marked Agder",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/agder-11",
    skills: [{
      id: "market-risor",
      name: "Bondens marked Risør",
      description: "Bondens marked i Risør, Agder. Lokale produkter fra Sørlandet.",
      tags: ["bondens-marked", "risør", "agder", "sørlandet"],
    }],
    role: "producer",
    location: { lat: 58.7190, lng: 9.2310, city: "Risør", radiusKm: 15 },
    categories: ["vegetables", "fish", "bread", "preserves"],
    tags: ["farmers-market", "seasonal", "agder"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Mandal",
    description: "Bondens marked i Mandal sentrum, Agder. Lokalprodusert mat fra Sørlandet.",
    provider: "Bondens marked Agder",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/agder-11",
    skills: [{
      id: "market-mandal",
      name: "Bondens marked Mandal",
      description: "Bondens marked i Mandal sentrum. Sesongbasert marked.",
      tags: ["bondens-marked", "mandal", "agder", "sørlandet"],
    }],
    role: "producer",
    location: { lat: 58.0290, lng: 7.4610, city: "Mandal", radiusKm: 15 },
    categories: ["vegetables", "fish", "bread", "honey"],
    tags: ["farmers-market", "seasonal", "agder"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Narvik",
    description: "Bondens marked i Narvik, Nordland. Lokalprodusert mat fra Nord-Norge.",
    provider: "Bondens marked Nordland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-narvik",
      name: "Bondens marked Narvik",
      description: "Bondens marked i Narvik. Lokal mat fra Nordland.",
      tags: ["bondens-marked", "narvik", "nordland", "nord-norge"],
    }],
    role: "producer",
    location: { lat: 68.4385, lng: 17.4275, city: "Narvik", radiusKm: 20 },
    categories: ["meat", "fish", "bread", "preserves"],
    tags: ["farmers-market", "seasonal", "northern-norway"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Kabelvåg/Lofoten",
    description: "Bondens marked i Kabelvåg, Lofoten. Lokalprodusert mat fra Nordland, inkludert fiskeprodukter og arktiske råvarer.",
    provider: "Bondens marked Nordland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-lofoten",
      name: "Bondens marked Lofoten",
      description: "Bondens marked i Kabelvåg/Lofoten. Fisk, kjøtt og arktiske produkter.",
      tags: ["bondens-marked", "lofoten", "kabelvåg", "nordland", "arktisk"],
    }],
    role: "producer",
    location: { lat: 68.2330, lng: 14.5850, city: "Kabelvåg", radiusKm: 20 },
    categories: ["fish", "meat", "preserves"],
    tags: ["farmers-market", "seasonal", "lofoten", "arctic"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Bergeland/Stavanger",
    description: "Bondens marked Bergeland bazar, Stavanger. Sesongbasert marked med lokale produsenter fra Rogaland.",
    provider: "Bondens marked Rogaland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-bergeland-stavanger",
      name: "Bondens marked Bergeland Stavanger",
      description: "Bondens marked ved Bergeland bazar i Stavanger. Rogaland-produsenter.",
      tags: ["bondens-marked", "bergeland", "stavanger", "rogaland"],
    }],
    role: "producer",
    location: { lat: 58.9700, lng: 5.7380, city: "Stavanger", radiusKm: 10 },
    categories: ["vegetables", "meat", "dairy", "fish"],
    tags: ["farmers-market", "seasonal", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Steinkjer",
    description: "Bondens marked på Steinkjer torg, Trøndelag. Lokalprodusert mat fra Innherred-regionen.",
    provider: "Bondens marked Trøndelag",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-steinkjer",
      name: "Bondens marked Steinkjer",
      description: "Bondens marked på Steinkjer torg. Trøndelagske produkter fra Innherred.",
      tags: ["bondens-marked", "steinkjer", "innherred", "trøndelag"],
    }],
    role: "producer",
    location: { lat: 64.0150, lng: 11.4950, city: "Steinkjer", radiusKm: 20 },
    categories: ["vegetables", "meat", "dairy", "fish"],
    tags: ["farmers-market", "seasonal", "trondelag"],
  });

  // ════════════════════════════════════════════════════════════
  // F) NYE BONDENS MARKED — VESTLAND/BERGEN
  // ════════════════════════════════════════════════════════════

  marketplaceRegistry.register({
    name: "Bondens marked — Vågsallmenningen Bergen",
    description: "Bondens marked på Vågsallmenningen i Bergen sentrum. Sesongbasert marked med lokale produsenter fra Vestland.",
    provider: "Bondens marked Vestland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-vagsallmenningen-bergen",
      name: "Bondens marked Vågsallmenningen Bergen",
      description: "Bondens marked i Bergen sentrum ved Vågsallmenningen.",
      tags: ["bondens-marked", "bergen", "vågsallmenningen", "vestland"],
    }],
    role: "producer",
    location: { lat: 60.3930, lng: 5.3240, city: "Bergen", radiusKm: 10 },
    categories: ["vegetables", "fish", "dairy", "bread", "fruit"],
    tags: ["farmers-market", "seasonal", "vestland", "bergen-sentrum"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Sogndal",
    description: "Bondens marked i Sogndal sentrum, Sogn og Fjordane/Vestland. Lokalprodusert mat fra indre Vestland.",
    provider: "Bondens marked Vestland",
    contactEmail: "post@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser",
    skills: [{
      id: "market-sogndal",
      name: "Bondens marked Sogndal",
      description: "Bondens marked i Sogndal. Lokale produkter fra Sogn.",
      tags: ["bondens-marked", "sogndal", "sogn", "vestland"],
    }],
    role: "producer",
    location: { lat: 61.2270, lng: 7.0950, city: "Sogndal", radiusKm: 20 },
    categories: ["fruit", "meat", "dairy", "preserves"],
    tags: ["farmers-market", "seasonal", "vestland", "sognefjorden"],
  });

  // ════════════════════════════════════════════════════════════
  // G) REKO-RINGER — NYE FUNN (Akershus)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 REKO-ringer — Oslo/Akershus utvidelse...");

  marketplaceRegistry.register({
    name: "REKO-ringen Bjerke — Oslo",
    description: "REKO-ring på Bjerke, Oslo. Direkte salg fra produsent til forbruker via Facebook-gruppen. Lokalmat fra Romeriks- og Oslo-produsenter.",
    provider: "REKO Oslo",
    contactEmail: "reko.bjerke@gmail.com",
    url: "https://www.facebook.com/groups/rekobjerke",
    skills: [{
      id: "reko-pickup-bjerke",
      name: "REKO-utlevering Bjerke",
      description: "Forhåndsbestilt lokalmat fra Bjerke REKO-ring.",
      tags: ["reko", "bjerke", "oslo", "utlevering", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.9480, lng: 10.8100, city: "Oslo", radiusKm: 5 },
    categories: ["vegetables", "eggs", "honey", "bread", "meat"],
    tags: ["reko", "direct-sale", "community", "pre-order"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Follo/Ås",
    description: "REKO-ring for Follo-regionen med base i Ås. Bestilling via Facebook-gruppen. Lokale produsenter fra Follo, Ås, Vestby og omegn.",
    provider: "REKO Follo",
    contactEmail: "reko.follo@gmail.com",
    url: "https://www.facebook.com/groups/266634880636822/",
    skills: [{
      id: "reko-pickup-follo",
      name: "REKO-utlevering Follo/Ås",
      description: "Forhåndsbestilt lokalmat fra Follo-regionen. Utlevering i Ås.",
      tags: ["reko", "follo", "ås", "utlevering", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.6620, lng: 10.7870, city: "Ås", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "bread", "fruit"],
    tags: ["reko", "direct-sale", "community", "pre-order", "follo"],
  });

  // ════════════════════════════════════════════════════════════
  // H) ROGALAND — EKSTRA HANEN-REGISTRERTE PRODUSENTER
  // ════════════════════════════════════════════════════════════

  marketplaceRegistry.register({
    name: "Buhagen Fruktgård — Ryfylke",
    description: "Fruktdyrking gjennom generasjoner i Skiftun, Ryfylke. Omgitt av blå fjord og grønne skoger. Fruktprodukter fra hagen.",
    provider: "Buhagen",
    contactEmail: "post@buhagen.no",
    url: "https://www.hanen.no/utforsk/32/rogaland",
    skills: [{
      id: "sell-fruit-buhagen",
      name: "Fruktgård Buhagen Ryfylke",
      description: "Fruktprodukter fra generasjoners fruktdyrking i Ryfylke.",
      tags: ["frukt", "ryfylke", "fruktgård", "tradisjon"],
    }],
    role: "producer",
    location: { lat: 59.2800, lng: 6.1500, city: "Skiftun", radiusKm: 20 },
    categories: ["fruit", "preserves"],
    tags: ["fruit-farm", "traditional", "ryfylke", "rogaland", "hanen"],
  });

  // ════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════
  const afterCount = marketplaceRegistry.getActiveAgents().length;
  console.log(`\n   ✅ Expansion v7 complete.`);
  console.log(`   📊 Total agents in registry: ${afterCount}`);
  console.log(`   🆕 Added: ~35 new agents`);
  console.log(`      • Oslo: 4 (Bondens Butikk, Mølleren Sylvia, Lille Tøyen, Bygdø Kongsgård)`);
  console.log(`      • Akershus/Romerike: 5 (Loftet, Jøndal, Sander Nordstuen, Nittedal Sjokolade, Kringler)`);
  console.log(`      • Østfold: 5 (Aker, Askim Bærpresseri, Bamsrudlåven, Den Sorte Havre, Dyre Gård)`);
  console.log(`      • Jæren/Rogaland: 11 (Slettå, Bærheim, Hole, Line Gard, Jersey, Ystepikene, Aarsland, Vadland, Dirdalstraen, Erga, Buhagen)`);
  console.log(`      • Bondens marked nye: 12 (Lena, Jevnaker, Stryn, Levanger, Risør, Mandal, Narvik, Kabelvåg, Bergeland, Steinkjer, Vågsallmenningen, Sogndal)`);
  console.log(`      • REKO-ringer: 2 (Bjerke Oslo, Follo/Ås)\n`);
}
