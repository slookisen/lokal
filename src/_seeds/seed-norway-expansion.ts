import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway-Wide Database Expansion ──────────────────────────
// Researched 2026-03-31. Sources: rekonorge.no, bondensmarked.no,
// hanen.no, visitnorway.no, gladmat.no, mathallenoslo.no,
// visitgreateroslo.com, matarena.no, gronnguidetrondheim.no,
// statsforvalteren.no, oslo.kommune.no, yelp, tripadvisor.
//
// This file extends the Oslo database with:
//   A) Additional Oslo-area coverage (gaps from v1)
//   B) Bergen — REKO, Bondens marked, gårdsbutikker
//   C) Trondheim — REKO, Bondens marked, gårdsbutikker
//   D) Stavanger/Sandnes — REKO, Bondens marked, gårdsbutikker
//   E) Tromsø — Bondens marked Arktis, REKO, produsenter
//   F) Kristiansand — Bondens marked, REKO
//   G) Drammen — Bondens marked, REKO

export function seedNorwayExpansion() {
  // Idempotent: check if expansion has already run
  const existing = marketplaceRegistry.getActiveAgents();
  const hasExpansion = existing.some(
    (a: any) => a.name === "Bondens Marked Bergen" || a.name === "REKO-ringen Trondheim"
  );
  if (hasExpansion) {
    console.log(`🇳🇴 Norway expansion already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway-wide expansion database...\n");

  // ════════════════════════════════════════════════════════════
  // A) OSLO AREA — ADDITIONAL COVERAGE
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo area — additional entries...");

  // ── Additional fruit/veg shops ──
  marketplaceRegistry.register({
    name: "Løren Frukt og Grønt",
    description: "Frukt- og grøntbutikk på Løren, Oslo. Ferskt utvalg med lokalt fokus.",
    provider: "Løren Frukt og Grønt",
    contactEmail: "post@lorenfrukt.no",
    url: "https://www.facebook.com/lorenfruktgront/",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt Løren",
      description: "Bredt utvalg frukt og grønnsaker på Løren.",
      tags: ["grønnsaker", "frukt", "løren", "fersk", "lokal"],
    }],
    role: "producer",
    location: { lat: 59.9320, lng: 10.7930, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "løren"],
  });

  marketplaceRegistry.register({
    name: "Nordlys Dagligvarer (Oppsal)",
    description: "Dagligvare og frukt/grønt på Oppsal senter. Godt utvalg av internasjonale og lokale matvarer.",
    provider: "Nordlys Dagligvarer",
    contactEmail: "post@nordlysdagligvarer.no",
    url: "https://www.oppsalsenter.no/butikker-og-tjenester/nordlys-dagligvarer",
    skills: [{
      id: "sell-produce-groceries",
      name: "Dagligvarer og grønt",
      description: "Bredt utvalg frukt, grønt og dagligvarer. Internasjonalt sortiment.",
      tags: ["grønnsaker", "frukt", "dagligvarer", "internasjonalt", "oppsal"],
    }],
    role: "producer",
    location: { lat: 59.8930, lng: 10.8280, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["international", "neighborhood", "oppsal", "daily-fresh"],
  });

  marketplaceRegistry.register({
    name: "Asker Frukt og Grønt",
    description: "Frukt- og grøntbutikk i Asker sentrum. Asiatiske produkter og stort utvalg. Søndagsåpent.",
    provider: "Asker Frukt og Grønt",
    contactEmail: "post@askerfrukt.no",
    url: "https://www.askersentrum.info/finn-forretning/se-oversikt/item/asker-frukt-og-gront",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt i Asker",
      description: "Bredt utvalg frukt og grønnsaker. Asiatiske produkter. Søndagsåpent.",
      tags: ["grønnsaker", "frukt", "asker", "asiatisk", "søndagsåpent"],
    }],
    role: "producer",
    location: { lat: 59.8333, lng: 10.4350, city: "Asker", radiusKm: 5 },
    categories: ["vegetables", "fruit"],
    tags: ["international", "asian", "sunday-open", "asker"],
  });

  // ── Additional gårdsbutikker (Oslo/Akershus) ──
  marketplaceRegistry.register({
    name: "Øvre Ringi Gård",
    description: "Gårdsbutikk på Tanumplatået i Bærum, 2 mil vest for Oslo. Selvplukk mais i august/september. Eget eplemost.",
    provider: "Øvre Ringi Gård",
    contactEmail: "post@ovreringi.no",
    url: "https://www.visitgreateroslo.com",
    skills: [{
      id: "sell-farm-products",
      name: "Mais og eplemost fra gården",
      description: "Selvplukk mais og egenprodusert eplemost. Gårdsbutikk i Bærum.",
      tags: ["mais", "eplemost", "selvplukk", "gårdsbutikk", "bærum"],
    }],
    role: "producer",
    location: { lat: 59.8800, lng: 10.4900, city: "Bærum", radiusKm: 15 },
    categories: ["vegetables", "fruit"],
    tags: ["farm-shop", "self-pick", "cider", "seasonal", "bærum"],
  });

  marketplaceRegistry.register({
    name: "Bringebærlandet",
    description: "Bringebærgård mellom Drøbak og Ås. Salg direkte fra jordet i sesong. Produserer også bringebærvin.",
    provider: "Bringebærlandet",
    contactEmail: "post@bringebaerlandet.no",
    url: "https://bringebaerlandet.no",
    skills: [{
      id: "sell-berries",
      name: "Bringebær og bringebærvin",
      description: "Ferske bringebær direkte fra jordet. Ulike bringebærvin-varianter.",
      tags: ["bringebær", "bær", "vin", "selvplukk", "sesong"],
    }],
    role: "producer",
    location: { lat: 59.6900, lng: 10.7200, city: "Ås", radiusKm: 20 },
    categories: ["fruit"],
    tags: ["berries", "farm-shop", "wine", "seasonal", "self-pick"],
  });

  // ── Mathallen additional shops ──
  marketplaceRegistry.register({
    name: "Agrossist (Mathallen)",
    description: "Matmarked i Mathallen med økologiske grønnsaker og råvarer. Miljøvennlig utstyr og spesialvarer.",
    provider: "Agrossist",
    contactEmail: "post@agrossist.no",
    url: "https://mathallenoslo.no",
    skills: [{
      id: "sell-organic-groceries",
      name: "Økologiske grønnsaker og råvarer",
      description: "Økologiske grønnsaker, kornprodukter og miljøvennlig utstyr i Mathallen.",
      tags: ["økologisk", "grønnsaker", "råvarer", "mathallen", "organic"],
    }],
    role: "producer",
    location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
    categories: ["vegetables", "other"],
    tags: ["organic", "mathallen", "eco-friendly", "specialty"],
  });

  marketplaceRegistry.register({
    name: "Galopin (Mathallen)",
    description: "Fransk spesialbutikk i Mathallen med vinbar. Fine oster, skinker, charcuteri og andeconfit.",
    provider: "Galopin",
    contactEmail: "post@galopin.no",
    url: "https://mathallenoslo.no",
    skills: [{
      id: "sell-french-deli",
      name: "Fransk delikatesse",
      description: "Franske oster, skinker, charcuteri og vin. Vinbar på stedet.",
      tags: ["ost", "charcuteri", "fransk", "vin", "delikatesse"],
    }],
    role: "producer",
    location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
    categories: ["dairy", "meat"],
    tags: ["french", "premium", "mathallen", "wine-bar", "cheese"],
  });

  // ── Urban farming / andelslandbruk ──
  marketplaceRegistry.register({
    name: "Losæter (Urbant Landbruk)",
    description: "Oslo kommunes kompetansesenter for urbant landbruk i Bjørvika. Kornåker, bakehus (Flatbread Society), parsellhager. Gratis besøk.",
    provider: "Losæter / Oslo kommune",
    contactEmail: "losaeter@oslo.kommune.no",
    url: "https://www.oslo.kommune.no/natur-kultur-og-fritid/urbant-landbruk/",
    skills: [{
      id: "urban-farming-hub",
      name: "Urbant landbruk Bjørvika",
      description: "Kompetansesenter for dyrking og kretsløp. Bakehus, kornåker, parsellhager.",
      tags: ["urbant landbruk", "dyrking", "bjørvika", "bakehus", "korn", "parsellhage"],
    }],
    role: "producer",
    location: { lat: 59.9050, lng: 10.7600, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "bread"],
    tags: ["urban-farm", "community", "education", "free", "bakehouse"],
  });

  marketplaceRegistry.register({
    name: "Nabolagshager",
    description: "Urbant senter for dyrking og grønn innovasjon på Schweigaards gate. Takhage, kurs og workshops. Grønt nabolagsengasjement.",
    provider: "Nabolagshager",
    contactEmail: "hei@nabolagshager.no",
    url: "https://nabolagshager.no",
    skills: [{
      id: "urban-rooftop-garden",
      name: "Takhage og dyrkekurs",
      description: "Urbant dyrkesenter med takhage. Kurs i dyrking, kompostering og bærekraft.",
      tags: ["takhage", "dyrking", "kurs", "urban", "bærekraft", "kompostering"],
    }],
    role: "producer",
    location: { lat: 59.9100, lng: 10.7630, city: "Oslo", radiusKm: 5 },
    categories: ["vegetables", "herbs"],
    tags: ["urban-farm", "rooftop", "education", "community", "workshops"],
  });

  // ── Egil Jensen (engros frukt/grønt) ──
  marketplaceRegistry.register({
    name: "Egil Jensen AS",
    description: "Engrossalg av frukt og grønnsaker i Oslo. Leverer til restauranter, kantiner og butikker. Etablert leverandør.",
    provider: "Egil Jensen AS",
    contactEmail: "post@egiljensen.no",
    url: "https://egiljensen.no/",
    skills: [{
      id: "wholesale-produce",
      name: "Engros frukt og grønt",
      description: "Engroslevering av frukt og grønnsaker til bedrifter i Oslo-området.",
      tags: ["engros", "wholesale", "frukt", "grønnsaker", "levering", "bedrift"],
    }],
    role: "logistics",
    location: { lat: 59.9139, lng: 10.7522, city: "Oslo", radiusKm: 30 },
    categories: ["vegetables", "fruit"],
    tags: ["wholesale", "b2b", "delivery", "established"],
  });

  // ════════════════════════════════════════════════════════════
  // B) BERGEN
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Bergen...");

  marketplaceRegistry.register({
    name: "Bondens Marked Bergen",
    description: "Bondens marked på Fisketorget i Bergen sentrum. To lørdager i måneden i sesong. Ost, kjøtt, fisk, honning, brød, grønnsaker og bær direkte fra bønder i Vestland.",
    provider: "Bondens Marked Bergen",
    contactEmail: "bergen@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Bergen",
      description: "Lokalprodusert mat direkte fra vestlandsbønder. Ost, kjøtt, fisk, grønnsaker, honning.",
      tags: ["bondens marked", "bergen", "fisketorget", "lokal mat", "lørdag"],
    }],
    role: "producer",
    location: { lat: 60.3943, lng: 5.3259, city: "Bergen", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
    tags: ["farmers-market", "weekend", "fisketorget", "vestland"],
  });

  marketplaceRegistry.register({
    name: "REKO Fyllingsdalen — Bergen",
    description: "REKO-ring i Fyllingsdalen, Bergen. Forhåndsbestilling via Facebook. Lokale produsenter fra Vestland.",
    provider: "REKO Bergen",
    contactEmail: "reko.fyllingsdalen@gmail.com",
    url: "https://www.facebook.com/groups/rekofyllingsdalen",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Fyllingsdalen",
      description: "Forhåndsbestilt lokalmat fra vestlandsprodusenter. Henting i Fyllingsdalen.",
      tags: ["reko", "utlevering", "fyllingsdalen", "bergen", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 60.3500, lng: 5.2800, city: "Bergen", radiusKm: 10 },
    categories: ["vegetables", "eggs", "honey", "meat", "bread"],
    tags: ["reko", "direct-sale", "community", "fyllingsdalen"],
  });

  marketplaceRegistry.register({
    name: "REKO Åsane — Bergen",
    description: "REKO-ring i Åsane, Bergen. Forhåndsbestilling via Facebook. Lokale produsenter fra Vestland.",
    provider: "REKO Bergen",
    contactEmail: "reko.aasane@gmail.com",
    url: "https://www.facebook.com/groups/rekoaasane",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Åsane",
      description: "Forhåndsbestilt lokalmat. Henting i Åsane, Bergen.",
      tags: ["reko", "utlevering", "åsane", "bergen", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 60.4660, lng: 5.3260, city: "Bergen", radiusKm: 10 },
    categories: ["vegetables", "eggs", "honey", "dairy", "bread"],
    tags: ["reko", "direct-sale", "community", "åsane"],
  });

  marketplaceRegistry.register({
    name: "Sande Gardsmat",
    description: "Gårdsmatprodusent i Vestland. Selger via Bondens marked Bergen og REKO-ringer. Kjøtt, egg og grønnsaker fra egen gård.",
    provider: "Sande Gardsmat",
    contactEmail: "post@sande-gardsmat.no",
    url: "https://sande-gardsmat.no",
    skills: [{
      id: "sell-farm-food",
      name: "Gardsmat fra Vestland",
      description: "Kjøtt, egg og grønnsaker direkte fra gården. Selger på Bondens marked og REKO.",
      tags: ["gardsmat", "kjøtt", "egg", "grønnsaker", "vestland", "gård"],
    }],
    role: "producer",
    location: { lat: 60.4000, lng: 5.3000, city: "Bergen", radiusKm: 30 },
    categories: ["meat", "eggs", "vegetables"],
    tags: ["farm-direct", "bondens-marked", "reko", "vestland"],
  });

  marketplaceRegistry.register({
    name: "Fisketorget Bergen",
    description: "Bergens ikoniske fisketorg. Fersk fisk og sjømat direkte fra fiskerne. Åpent daglig i sesongen.",
    provider: "Fisketorget Bergen",
    contactEmail: "post@fisketorgetbergen.no",
    url: "https://www.visitbergen.com",
    skills: [{
      id: "sell-fresh-fish",
      name: "Fersk sjømat Bergen",
      description: "Fersk fisk, reker, krabbe og sjømat direkte fra vestlandskysten.",
      tags: ["fisk", "sjømat", "reker", "krabbe", "fersk", "fisketorget"],
    }],
    role: "producer",
    location: { lat: 60.3943, lng: 5.3259, city: "Bergen", radiusKm: 3 },
    categories: ["fish"],
    tags: ["iconic", "fresh", "daily", "tourist", "historic"],
  });

  // ════════════════════════════════════════════════════════════
  // C) TRONDHEIM
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Trondheim...");

  marketplaceRegistry.register({
    name: "Bondens Marked Trondheim",
    description: "Bondens marked i Trondheim. Over 20 år med lokal mat direkte fra trønderske bønder. Siste lørdag i måneden på Torvet.",
    provider: "Bondens Marked Trøndelag",
    contactEmail: "trondelag@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Trondheim",
      description: "Lokalprodusert mat fra trønderske bønder. Ost, kjøtt, fisk, grønnsaker, honning.",
      tags: ["bondens marked", "trondheim", "torvet", "trøndelag", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 63.4305, lng: 10.3951, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
    tags: ["farmers-market", "weekend", "20-year-tradition", "trøndelag"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Trondheim",
    description: "Verdens største REKO-ring. Forhåndsbestilling via Facebook. Hundrevis av lokale produsenter fra Trøndelag. Utlevering i Trondheim sentrum.",
    provider: "REKO Trondheim",
    contactEmail: "reko.trondheim@gmail.com",
    url: "https://www.facebook.com/groups/rekotrondheim",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Trondheim",
      description: "Forhåndsbestilt lokalmat fra trønderske produsenter. Verdens største REKO-ring.",
      tags: ["reko", "utlevering", "trondheim", "trøndelag", "lokalmat", "størst"],
    }],
    role: "producer",
    location: { lat: 63.4305, lng: 10.3951, city: "Trondheim", radiusKm: 10 },
    categories: ["vegetables", "eggs", "honey", "meat", "bread", "dairy", "fish"],
    tags: ["reko", "direct-sale", "worlds-largest", "community"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Heimdal",
    description: "REKO-ring på Heimdal, sør for Trondheim. Utlevering ved Heimdal bibliotek parkeringsplass.",
    provider: "REKO Trondheim",
    contactEmail: "reko.heimdal@gmail.com",
    url: "https://www.facebook.com/groups/rekoheimdal",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Heimdal",
      description: "Forhåndsbestilt lokalmat. Henting ved Heimdal bibliotek.",
      tags: ["reko", "utlevering", "heimdal", "trondheim", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 63.3500, lng: 10.3500, city: "Trondheim", radiusKm: 8 },
    categories: ["vegetables", "eggs", "meat", "bread"],
    tags: ["reko", "direct-sale", "heimdal", "suburban"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Byåsen",
    description: "REKO-ring på Byåsen, vest for Trondheim sentrum. Annenhver tirsdag.",
    provider: "REKO Trondheim",
    contactEmail: "reko.byasen@gmail.com",
    url: "https://www.facebook.com/groups/rekobyasen",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Byåsen",
      description: "Forhåndsbestilt lokalmat. Henting på Byåsen.",
      tags: ["reko", "utlevering", "byåsen", "trondheim", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 63.4200, lng: 10.3400, city: "Trondheim", radiusKm: 8 },
    categories: ["vegetables", "eggs", "honey", "bread"],
    tags: ["reko", "direct-sale", "byåsen", "biweekly"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Moholt",
    description: "REKO-ring på Moholt, nær NTNU studentby i Trondheim. Annenhver tirsdag.",
    provider: "REKO Trondheim",
    contactEmail: "reko.moholt@gmail.com",
    url: "https://www.facebook.com/groups/rekomoholt",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Moholt",
      description: "Forhåndsbestilt lokalmat. Henting på Moholt nær NTNU.",
      tags: ["reko", "utlevering", "moholt", "trondheim", "student"],
    }],
    role: "producer",
    location: { lat: 63.4130, lng: 10.4340, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "eggs", "bread", "dairy"],
    tags: ["reko", "direct-sale", "moholt", "student-area"],
  });

  marketplaceRegistry.register({
    name: "Trondheim Kooperativ",
    description: "Andelslag for distribusjon av økologisk og lokal mat. Drevet og eid av medlemmer. Samarbeider med bønder i Trøndelag. Levering annenhver uke.",
    provider: "Trondheim Kooperativ",
    contactEmail: "hei@trondheimkooperativ.no",
    url: "https://trondheimkooperativ.no",
    skills: [{
      id: "organic-coop",
      name: "Økologisk matkasse",
      description: "Økologiske og lokale råvarer direkte fra trønderske bønder. Medlemsbasert andelslag.",
      tags: ["økologisk", "andelslag", "matkasse", "lokal", "trøndelag", "kooperativ"],
    }],
    role: "producer",
    location: { lat: 63.4305, lng: 10.3951, city: "Trondheim", radiusKm: 15 },
    categories: ["vegetables", "fruit", "dairy", "eggs", "meat"],
    tags: ["organic", "cooperative", "member-owned", "biweekly-delivery"],
  });

  marketplaceRegistry.register({
    name: "Dype Røtter",
    description: "Grønnsakskasser fra småskala produsenter i Trøndelag. Levering via REKO-ringer på Byåsen, Heimdal og Moholt annenhver tirsdag.",
    provider: "Dype Røtter",
    contactEmail: "hei@dyperoetter.org",
    url: "https://dyperoetter.org",
    skills: [{
      id: "vegbox-subscription",
      name: "Grønnsakskasse-abonnement",
      description: "Sesongbaserte grønnsakskasser fra lokale bønder. Levering via REKO-ringer i Trondheim.",
      tags: ["grønnsakskasse", "abonnement", "sesong", "lokal", "trøndelag"],
    }],
    role: "producer",
    location: { lat: 63.4305, lng: 10.3951, city: "Trondheim", radiusKm: 15 },
    categories: ["vegetables"],
    tags: ["subscription", "vegbox", "seasonal", "small-scale", "reko-delivery"],
  });

  marketplaceRegistry.register({
    name: "Myra Gård",
    description: "Gård i Trondheim med gårdsbutikk. Selger via REKO-ringen Trondheim og Byåsen, lokale markeder og direkte fra gården.",
    provider: "Myra Gård",
    contactEmail: "post@myragard.no",
    url: "https://myragard.no",
    skills: [{
      id: "sell-farm-products",
      name: "Gårdsprodukter Myra",
      description: "Lokale produkter direkte fra gården i Trondheim.",
      tags: ["gård", "lokal", "trondheim", "reko", "gårdsbutikk"],
    }],
    role: "producer",
    location: { lat: 63.4200, lng: 10.4100, city: "Trondheim", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat"],
    tags: ["farm-shop", "reko", "local", "trøndelag"],
  });

  // ════════════════════════════════════════════════════════════
  // D) STAVANGER / SANDNES
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Stavanger/Sandnes...");

  marketplaceRegistry.register({
    name: "Bondens Marked Rogaland",
    description: "Bondens marked i Stavanger, Domkirkeplassen. Lokalprodusert mat fra rogalandsbønder. Månedlig i sesong.",
    provider: "Bondens Marked Rogaland",
    contactEmail: "rogaland@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Stavanger",
      description: "Lokalprodusert mat fra Rogaland. Ost, kjøtt, grønnsaker, bær, honning på Domkirkeplassen.",
      tags: ["bondens marked", "stavanger", "domkirkeplassen", "rogaland", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.9700, lng: 5.7331, city: "Stavanger", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "domkirkeplassen", "rogaland"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Sandnes og Stavanger",
    description: "REKO-ring for Sandnes og Stavanger-området. Forhåndsbestilling via Facebook. Lokale jærbu-produsenter.",
    provider: "REKO Rogaland",
    contactEmail: "reko.sandnes@gmail.com",
    url: "https://www.facebook.com/groups/rekosandnes",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Sandnes/Stavanger",
      description: "Forhåndsbestilt lokalmat fra jærbu-produsenter. Henting i Sandnes/Stavanger.",
      tags: ["reko", "utlevering", "sandnes", "stavanger", "jæren", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 58.8530, lng: 5.7346, city: "Sandnes", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "dairy"],
    tags: ["reko", "direct-sale", "jæren", "community"],
  });

  marketplaceRegistry.register({
    name: "Ullandhaug Gårdsbutikk",
    description: "Økologisk gårdsbutikk siden 2001. To lokaler: Ullandhaug gård og Verksgata i Stavanger sentrum. Over 15 lokale økologiske produsenter. Grønnsaker fra Ullandhaug og Byre.",
    provider: "Ullandhaug Gårdsbutikk",
    contactEmail: "post@ullandhauggardsbutikk.no",
    url: "https://www.ullandhauggardsbutikk.no",
    skills: [{
      id: "sell-organic-local",
      name: "Økologisk lokal mat",
      description: "Gårdsferske økologiske grønnsaker, lokal ost, supermat. 15+ lokale produsenter.",
      tags: ["økologisk", "organic", "grønnsaker", "ost", "gårdsbutikk", "lokal"],
    }],
    role: "producer",
    location: { lat: 58.9560, lng: 5.6950, city: "Stavanger", radiusKm: 10 },
    categories: ["vegetables", "dairy", "other"],
    tags: ["organic", "farm-shop", "since-2001", "two-locations", "15-producers"],
  });

  marketplaceRegistry.register({
    name: "Ims Gård",
    description: "Selvbetjent gårdsutsalg i Sandnes. Kjøtt fra gressfôra storfe og lam, honning, poteter og egg fra beitehøns.",
    provider: "Ims Gård",
    contactEmail: "post@imsgard.no",
    url: "https://imsgard.no",
    skills: [{
      id: "sell-grass-fed-meat",
      name: "Gressfôra kjøtt og egg",
      description: "Kjøtt fra gressfôra storfe og lam, honning, poteter, egg fra beitehøns. Selvbetjent gårdsutsalg.",
      tags: ["gressfôra", "kjøtt", "lam", "egg", "honning", "poteter", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 58.8400, lng: 5.7200, city: "Sandnes", radiusKm: 15 },
    categories: ["meat", "eggs", "honey", "vegetables"],
    tags: ["grass-fed", "self-service", "farm-shop", "jæren"],
  });

  marketplaceRegistry.register({
    name: "Sandalen Gård",
    description: "Frukt og sider fra gården i Rogaland. Epler, pærer og egenprodusert sider/most.",
    provider: "Sandalen Gård",
    contactEmail: "post@sandalengard.no",
    url: "https://sandalengard.no",
    skills: [{
      id: "sell-fruit-cider",
      name: "Frukt og sider",
      description: "Epler, pærer og egenprodusert sider direkte fra gården.",
      tags: ["frukt", "epler", "sider", "most", "pærer", "gård"],
    }],
    role: "producer",
    location: { lat: 58.9800, lng: 5.7400, city: "Stavanger", radiusKm: 20 },
    categories: ["fruit"],
    tags: ["cider", "apples", "farm-shop", "artisan", "rogaland"],
  });

  // ════════════════════════════════════════════════════════════
  // E) TROMSØ
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Tromsø...");

  marketplaceRegistry.register({
    name: "Bondens Marked Arktis (Tromsø)",
    description: "Bondens marked i Tromsø på Stortorget. Ca. 40 produsenter i Troms. Kortreist mat direkte fra arktiske produsenter.",
    provider: "Bondens Marked Troms",
    contactEmail: "troms@bondensmarked.no",
    url: "https://www.bondensmarkedtroms.no",
    skills: [
      {
        id: "farmers-market",
        name: "Bondens marked Tromsø",
        description: "Arktisk lokalmat direkte fra 40 produsenter. Ost, reinsdyrkjøtt, fisk, grønnsaker, bær.",
        tags: ["bondens marked", "tromsø", "arktisk", "stortorget", "lokal mat"],
      },
      {
        id: "arctic-producers",
        name: "Finn arktiske produsenter",
        description: "Søk blant 40 produsenter i Troms etter kategori.",
        tags: ["produsenter", "troms", "arktisk", "søk"],
      },
    ],
    role: "producer",
    location: { lat: 69.6489, lng: 18.9551, city: "Tromsø", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
    tags: ["farmers-market", "arctic", "40-producers", "stortorget"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Tromsø",
    description: "REKO-ring i Tromsø. Forhåndsbestilling via Facebook. Arktiske lokalprodusenter.",
    provider: "REKO Tromsø",
    contactEmail: "reko.tromso@gmail.com",
    url: "https://www.facebook.com/groups/rekotromso/",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Tromsø",
      description: "Forhåndsbestilt arktisk lokalmat. Henting i Tromsø.",
      tags: ["reko", "utlevering", "tromsø", "arktisk", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 69.6489, lng: 18.9551, city: "Tromsø", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "fish", "dairy"],
    tags: ["reko", "direct-sale", "arctic", "community"],
  });

  // ── Tromsø produsenter ──
  marketplaceRegistry.register({
    name: "Bomstad Gård",
    description: "Gård i Troms med lokalproduserte varer. Selger på Bondens marked Arktis og direkte fra gården.",
    provider: "Bomstad Gård",
    contactEmail: "post@bomstadgard.no",
    url: "https://www.bondensmarkedtroms.no",
    skills: [{
      id: "sell-arctic-farm-products",
      name: "Arktiske gårdsprodukter",
      description: "Lokale produkter fra arktisk gård i Troms.",
      tags: ["gård", "arktisk", "troms", "lokal", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.6000, lng: 19.0000, city: "Tromsø", radiusKm: 30 },
    categories: ["vegetables", "eggs"],
    tags: ["arctic-farm", "bondens-marked", "local"],
  });

  marketplaceRegistry.register({
    name: "Hjerttind Rein",
    description: "Reinsdyrprodusent i Troms. Reinsdyrkjøtt, tørrkjøtt og spekemat. Selger via Bondens marked Arktis.",
    provider: "Hjerttind Rein",
    contactEmail: "post@hjerttindrein.no",
    url: "https://www.bondensmarkedtroms.no",
    skills: [{
      id: "sell-reindeer-meat",
      name: "Reinsdyrprodukter",
      description: "Reinsdyrkjøtt, tørrkjøtt og spekemat fra arktisk natur.",
      tags: ["reinsdyr", "reindeer", "tørrkjøtt", "spekemat", "arktisk"],
    }],
    role: "producer",
    location: { lat: 69.5000, lng: 18.8000, city: "Tromsø", radiusKm: 50 },
    categories: ["meat"],
    tags: ["reindeer", "arctic", "traditional", "bondens-marked"],
  });

  marketplaceRegistry.register({
    name: "Eventyrsmak",
    description: "Matprodusent fra Nord-Norge. Selger på markeder i Tromsø, Narvik og Harstad. Lokale spesialiteter.",
    provider: "Eventyrsmak",
    contactEmail: "hei@eventyrsmak.no",
    url: "https://www.eventyrsmak.no",
    skills: [{
      id: "sell-northern-specialties",
      name: "Nordnorske spesialiteter",
      description: "Lokale matspesialiteter fra Nord-Norge. Selger på markeder.",
      tags: ["nordnorsk", "spesialiteter", "tromsø", "narvik", "harstad"],
    }],
    role: "producer",
    location: { lat: 69.6489, lng: 18.9551, city: "Tromsø", radiusKm: 80 },
    categories: ["preserves", "other"],
    tags: ["northern-norway", "specialty", "multi-market", "artisan"],
  });

  // ════════════════════════════════════════════════════════════
  // F) KRISTIANSAND
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Kristiansand...");

  marketplaceRegistry.register({
    name: "Bondens Marked Kristiansand",
    description: "Bondens marked i Kristiansand sentrum. Lokalprodusert mat fra Agder-bønder. Månedlig i sesong.",
    provider: "Bondens Marked Kristiansand",
    contactEmail: "kristiansand@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Kristiansand",
      description: "Lokalprodusert mat fra Agder. Grønnsaker, ost, kjøtt, honning, brød.",
      tags: ["bondens marked", "kristiansand", "agder", "lokal mat", "lørdag"],
    }],
    role: "producer",
    location: { lat: 58.1462, lng: 7.9956, city: "Kristiansand", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "agder", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Kristiansand",
    description: "REKO-ring i Kristiansand. Utlevering to ganger i måneden, torsdager. Forhåndsbestilling via Facebook.",
    provider: "REKO Kristiansand",
    contactEmail: "reko.kristiansand@gmail.com",
    url: "https://www.facebook.com/groups/rekokristiansand",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Kristiansand",
      description: "Forhåndsbestilt lokalmat fra Agder-produsenter. Henting i Kristiansand.",
      tags: ["reko", "utlevering", "kristiansand", "agder", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 58.1462, lng: 7.9956, city: "Kristiansand", radiusKm: 15 },
    categories: ["vegetables", "eggs", "honey", "meat", "bread"],
    tags: ["reko", "direct-sale", "bimonthly", "thursday"],
  });

  // ════════════════════════════════════════════════════════════
  // G) DRAMMEN
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Drammen...");

  marketplaceRegistry.register({
    name: "Bondens Marked Drammen",
    description: "Bondens marked i Drammen. Bønder fra Hallingdal, Krødsherad og Drammen-regionen. Alt fra reinsdyrhjerte til syltetøy.",
    provider: "Bondens Marked Drammen",
    contactEmail: "drammen@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Drammen",
      description: "Lokalprodusert mat fra Buskerud. Kjøtt, grønnsaker, syltetøy, honning, brød.",
      tags: ["bondens marked", "drammen", "buskerud", "hallingdal", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.7441, lng: 10.2045, city: "Drammen", radiusKm: 10 },
    categories: ["vegetables", "meat", "preserves", "honey", "bread"],
    tags: ["farmers-market", "weekend", "buskerud", "hallingdal"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Drammen",
    description: "REKO-ring i Drammen. Kortreist gårdsmat fra Buskerud-produsenter. Ukentlig utlevering.",
    provider: "REKO Drammen",
    contactEmail: "reko.drammen@gmail.com",
    url: "https://www.facebook.com/groups/rekodrammen",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Drammen",
      description: "Forhåndsbestilt lokalmat fra Buskerud-produsenter. Henting i Drammen.",
      tags: ["reko", "utlevering", "drammen", "buskerud", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.7441, lng: 10.2045, city: "Drammen", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "weekly", "buskerud"],
  });

  // ════════════════════════════════════════════════════════════
  // H) FREDRIKSTAD / SARPSBORG (Østfold)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Fredrikstad...");

  marketplaceRegistry.register({
    name: "Bondens Marked Fredrikstad",
    description: "Bondens marked i Fredrikstad / Gamlebyen. Lokalprodusert mat fra Østfold-bønder.",
    provider: "Bondens Marked Fredrikstad",
    contactEmail: "fredrikstad@bondensmarked.no",
    url: "https://bondensmarked.no",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Fredrikstad",
      description: "Lokalprodusert mat fra Østfold. Grønnsaker, kjøtt, ost, honning.",
      tags: ["bondens marked", "fredrikstad", "østfold", "gamlebyen", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.2181, lng: 10.9298, city: "Fredrikstad", radiusKm: 10 },
    categories: ["vegetables", "meat", "dairy", "honey", "bread"],
    tags: ["farmers-market", "weekend", "østfold", "gamlebyen"],
  });

  // ════════════════════════════════════════════════════════════
  // I) LILLESTRØM / ROMERIKE
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Lillestrøm...");

  marketplaceRegistry.register({
    name: "REKO-ringen Lillestrøm",
    description: "REKO-ring i Lillestrøm, Romerike. Lokale produsenter fra Akershus og omegn.",
    provider: "REKO Lillestrøm",
    contactEmail: "reko.lillestrom@gmail.com",
    url: "https://www.facebook.com/groups/rekolillestrom",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Lillestrøm",
      description: "Forhåndsbestilt lokalmat fra Romerike-produsenter.",
      tags: ["reko", "utlevering", "lillestrøm", "romerike", "akershus"],
    }],
    role: "producer",
    location: { lat: 59.9561, lng: 11.0496, city: "Lillestrøm", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "romerike", "akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // J) ADDITIONAL SERVICES (national)
  // ════════════════════════════════════════════════════════════
  console.log("   🚚 Nasjonale tjenester...");

  marketplaceRegistry.register({
    name: "Rett fra Bonden",
    description: "Nasjonal nettplattform for kjøp av lokalmat direkte fra bonden. Levering/henting over hele Norge.",
    provider: "Rett fra Bonden",
    contactEmail: "post@rettfrabonden.no",
    url: "https://www.rettfrabonden.no",
    skills: [{
      id: "online-marketplace",
      name: "Nettbutikk for lokalmat",
      description: "Kjøp lokalmat direkte fra bonden på nett. Levering/henting over hele Norge.",
      tags: ["nettbutikk", "lokalmat", "direkte", "levering", "norge"],
    }],
    role: "logistics",
    location: { lat: 59.9139, lng: 10.7522, city: "Norge", radiusKm: 1000 },
    categories: ["vegetables", "fruit", "dairy", "meat", "eggs", "honey"],
    tags: ["national", "online", "direct-from-farmer", "delivery"],
  });

  marketplaceRegistry.register({
    name: "Rensmak.no",
    description: "Nasjonal nettside som kobler forbrukere med lokale matprodusenter over hele Norge. Finn gårdsbutikker, REKO-ringer og bondens marked nær deg.",
    provider: "Rensmak",
    contactEmail: "post@rensmak.no",
    url: "https://rensmak.no",
    skills: [{
      id: "producer-directory",
      name: "Finn lokale produsenter",
      description: "Nasjonal oversikt over lokale matprodusenter, gårdsbutikker og REKO-ringer.",
      tags: ["produsenter", "oversikt", "gårdsbutikk", "reko", "bondens marked", "nasjonal"],
    }],
    role: "quality",
    location: { lat: 59.9139, lng: 10.7522, city: "Norge", radiusKm: 1000 },
    categories: [],
    tags: ["directory", "national", "producer-search", "aggregator"],
  });

  marketplaceRegistry.register({
    name: "HANEN (Bygdeturisme & gardsmat)",
    description: "Bransjeorganisasjon for bygdeturisme, gardsmat og innlandsfiske. Oversikt over gårdsbutikker og opplevelser i hele Norge.",
    provider: "HANEN",
    contactEmail: "post@hanen.no",
    url: "https://www.hanen.no",
    skills: [{
      id: "farm-directory",
      name: "Finn gårdsbutikker og opplevelser",
      description: "Nasjonal oversikt over gårdsbutikker, matopplevelser og bygdeturisme.",
      tags: ["gårdsbutikk", "bygdeturisme", "gardsmat", "opplevelse", "nasjonal"],
    }],
    role: "quality",
    location: { lat: 59.9139, lng: 10.7522, city: "Norge", radiusKm: 1000 },
    categories: [],
    tags: ["industry-org", "directory", "national", "farm-tourism"],
  });

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════
  const stats = marketplaceRegistry.getStats();
  console.log(`\n   ✅ Norway expansion loaded:`);
  console.log(`      ${stats.totalAgents} agents total (across all seeds)`);
  console.log(`      ${stats.activeProducers} producers`);
  console.log(`      Cities: ${stats.cities.join(", ")}`);
  console.log(`\n   New cities: Bergen, Trondheim, Stavanger, Sandnes,`);
  console.log(`   Tromsø, Kristiansand, Drammen, Fredrikstad, Lillestrøm\n`);
}
