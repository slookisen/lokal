import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway Database Expansion v4 ───────────────────────────
// Researched 2026-03-31. Sources: rekonorge.no, bondensmarked.no,
// hanen.no, spiselig.info, lystgarden.no, gronnguidetrondheim.no,
// ullandhauggardsbutikk.no, gladmat.no, visitjaeren.com, aktivioslo.no
//
// IMPORTANT: Entries already in v1-v3 seeds have been excluded.
// This file only adds GENUINELY NEW entries not present elsewhere.

export function seedExpansionV4() {
  const existing = marketplaceRegistry.getActiveAgents();
  const hasV4 = existing.some(
    (a: any) => a.name === "Reindyrka Økologisk Dagligvare" || a.name === "REKO-ringen Gjøvik"
  );
  if (hasV4) {
    console.log(`🇳🇴 Expansion v4 already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway expansion v4 database...\n");

  // ════════════════════════════════════════════════════════════
  // A) OSLO — NEW GROCERY / FRUIT & VEG SHOPS
  //    (Løren, Dagligvare Storgata, Vulkan, Sagene already in v1-v3)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — nye grønnsaksbutikker...");

  marketplaceRegistry.register({
    name: "Fudi Røa",
    description: "Del av Fudi-kjeden for eksotisk og autentisk mat. Butikk på Røa Torg med bredt utvalg av internasjonale frukter, grønnsaker og dagligvarer.",
    provider: "Fudi AS",
    contactEmail: "post@fudi.no",
    url: "https://fudi.no",
    skills: [{
      id: "sell-exotic-produce",
      name: "Eksotisk frukt og grønt Røa",
      description: "Internasjonalt og eksotisk utvalg av frukt, grønnsaker og dagligvarer på Røa.",
      tags: ["eksotisk", "frukt", "grønnsaker", "røa", "internasjonalt", "autentisk"],
    }],
    role: "producer",
    location: { lat: 59.9510, lng: 10.6390, city: "Oslo", radiusKm: 4 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["international", "exotic", "røa", "chain"],
  });

  marketplaceRegistry.register({
    name: "Ercan Import — Frukt og Grønt",
    description: "Frukt, grønt og importvarer på Grønland. Bredt utvalg av tyrkiske og middelhavsimportvarer, ferske grønnsaker og urter.",
    provider: "Ercan Import",
    contactEmail: "post@ercanimport.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Gr%C3%B8nland,+Oslo",
    skills: [{
      id: "sell-produce-turkish",
      name: "Tyrkisk/Middelhavsimport frukt og grønt",
      description: "Import-frukt og grønnsaker, urter og krydder. Tyrkiske og middelhavsspesialiteter.",
      tags: ["grønnsaker", "frukt", "import", "tyrkisk", "middelhav", "grønland"],
    }],
    role: "producer",
    location: { lat: 59.9118, lng: 10.7590, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["international", "turkish", "daily-fresh", "grønland"],
  });

  marketplaceRegistry.register({
    name: "Vatan Detalj — Grønland",
    description: "Dagligvarebutikk på Grønland med stort utvalg av frukt, grønnsaker og importvarer. Konkurransedyktige priser.",
    provider: "Vatan Detalj",
    contactEmail: "post@vatandetalj.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Gr%C3%B8nland,+Oslo",
    skills: [{
      id: "sell-produce-vatan",
      name: "Frukt og grønt Vatan Grønland",
      description: "Dagligvare med frukt, grønnsaker og importvarer på Grønland.",
      tags: ["grønnsaker", "frukt", "grønland", "dagligvare", "importvarer"],
    }],
    role: "producer",
    location: { lat: 59.9120, lng: 10.7610, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "grønland", "competitive-prices"],
  });

  // ════════════════════════════════════════════════════════════
  // B) OSLO — NEW BONDENS MARKED LOCATION
  //    (Vikaterrassen, Botanisk Hage, Vinslottet already in v1-v3)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — nye Bondens marked...");

  marketplaceRegistry.register({
    name: "Bondens marked — Fornebu S",
    description: "Bondens marked på Fornebu S handlesenter. Lokale bønder selger direkte: ost, kjøtt, brød, honning, frukt, grønnsaker og mer.",
    provider: "Bondens marked Oslo og Akershus",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market-fornebu",
      name: "Bondens marked Fornebu",
      description: "Direkte fra bonden på Fornebu S. Sesongvarer, ost, kjøtt, brød, honning.",
      tags: ["bondens marked", "fornebu", "lokal", "sesong", "direkte"],
    }],
    role: "producer",
    location: { lat: 59.8940, lng: 10.6140, city: "Bærum", radiusKm: 5 },
    categories: ["vegetables", "fruit", "meat", "dairy", "honey", "bread"],
    tags: ["farmers-market", "fornebu", "seasonal", "direct-sales"],
  });

  // ════════════════════════════════════════════════════════════
  // C) OSLO — NEW REKO-RINGER
  //    (St. Hanshaugen, Ski/Follo already in v1-v3)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo-området — nye REKO-ringer...");

  marketplaceRegistry.register({
    name: "REKO-ringen Nittedal",
    description: "REKO-ring for Nittedal og omegn. Lokale bønder selger direkte til forbrukere via Facebook-gruppe.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-nittedal",
      name: "REKO-ring Nittedal",
      description: "Direktesalg fra bonde til forbruker i Nittedal og omegn.",
      tags: ["REKO", "nittedal", "direktesalg", "bonde"],
    }],
    role: "producer",
    location: { lat: 59.9770, lng: 10.8630, city: "Nittedal", radiusKm: 10 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "nittedal"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Lørenskog",
    description: "REKO-ring for Lørenskog og nærområdet. Lokale bønder og produsenter selger direkte.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-lorenskog",
      name: "REKO-ring Lørenskog",
      description: "Direktesalg fra bonde til forbruker i Lørenskog.",
      tags: ["REKO", "lørenskog", "direktesalg", "bonde"],
    }],
    role: "producer",
    location: { lat: 59.8960, lng: 10.9700, city: "Lørenskog", radiusKm: 8 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "lørenskog"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Fornebu",
    description: "REKO-ring for Fornebu-området i Bærum. Direkte handel mellom bønder og forbrukere.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-fornebu",
      name: "REKO-ring Fornebu",
      description: "Direktesalg i Fornebu-området.",
      tags: ["REKO", "fornebu", "bærum", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 59.8970, lng: 10.6100, city: "Bærum", radiusKm: 5 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "fornebu"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Asker",
    description: "REKO-ring for Asker og omegn. Lokale produsenter fra vestregionen utenfor Oslo.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-asker",
      name: "REKO-ring Asker",
      description: "Direktesalg fra bonde til forbruker i Asker og omegn.",
      tags: ["REKO", "asker", "direktesalg", "sesong"],
    }],
    role: "producer",
    location: { lat: 59.8340, lng: 10.4350, city: "Asker", radiusKm: 10 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "asker"],
  });

  // ════════════════════════════════════════════════════════════
  // D) OSLO — NEW GÅRDSBUTIKKER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo-omegn — nye gårdsbutikker...");

  marketplaceRegistry.register({
    name: "Eplegården Storsand — Asker",
    description: "Askers eneste eplepresseri og gårdsbutikk. Eplemost, juice og sesongfrukter. Lokalt produsert med fokus på norske epler.",
    provider: "Eplegården Storsand",
    contactEmail: "post@eplegardenasker.no",
    url: "https://www.hanen.no/utforsk/32/akershus",
    skills: [{
      id: "sell-apple-products",
      name: "Eplemost og frukt Asker",
      description: "Eplepresseri og gårdsbutikk med eplemost, juice og sesongfrukter.",
      tags: ["epler", "eplemost", "juice", "asker", "frukt", "gårdsbutikk"],
    }],
    role: "producer",
    location: { lat: 59.8300, lng: 10.4200, city: "Asker", radiusKm: 10 },
    categories: ["fruit", "preserves"],
    tags: ["apple-press", "farm-shop", "seasonal", "asker"],
  });

  marketplaceRegistry.register({
    name: "Finnerud Gård",
    description: "Gård med gårdsbutikk i Akershus-regionen. Lokalprodusert mat direkte fra gården.",
    provider: "Finnerud Gård",
    contactEmail: "post@finnerudgard.no",
    url: "https://www.hanen.no/utforsk/32/akershus",
    skills: [{
      id: "sell-farm-finnerud",
      name: "Gårdsmat Finnerud",
      description: "Lokalprodusert mat fra Finnerud Gård i Akershus.",
      tags: ["gårdsbutikk", "akershus", "lokal", "gård"],
    }],
    role: "producer",
    location: { lat: 59.8500, lng: 10.5000, city: "Akershus", radiusKm: 10 },
    categories: ["vegetables", "meat", "eggs", "dairy"],
    tags: ["farm-shop", "local", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Beite — Gårdsbutikken på Hvam",
    description: "Gårdsbutikk ved Hvam videregående skole i Nes, Akershus. Landbruksprodukter, kjøtt, meierivarer og grønnsaker.",
    provider: "Hvam videregående skole",
    contactEmail: "post@hvam.vgs.no",
    url: "https://www.hanen.no/utforsk/32/akershus",
    skills: [{
      id: "sell-school-farm-hvam",
      name: "Gårdsmat fra Hvam",
      description: "Landbruksprodukter fra Hvam videregående. Kjøtt, meieri og grønnsaker.",
      tags: ["gårdsbutikk", "hvam", "nes", "skole", "landbruk"],
    }],
    role: "producer",
    location: { lat: 60.1220, lng: 11.1870, city: "Nes", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "eggs"],
    tags: ["farm-shop", "school-farm", "nes", "akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // E) BERGEN — GROCERIES, FARM SHOPS & REKO
  //    (Bønes Pølsemakeri different from Bønes Gårdsmat — both valid)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Bergen — grøntbutikker, gårdsbutikker og REKO...");

  marketplaceRegistry.register({
    name: "Reindyrka Økologisk Dagligvare",
    description: "Økologisk dagligvarebutikk i Bergen sentrum, Strandgaten 21. Rikt utvalg av økologisk frukt, grønnsaker, brød, meieri, tørrvarer og kaffe.",
    provider: "Reindyrka AS",
    contactEmail: "post@reindyrka.no",
    url: "https://www.reindyrka.no/",
    skills: [{
      id: "sell-organic-groceries",
      name: "Økologisk dagligvare Bergen",
      description: "Bergens største utvalg av økologisk frukt, grønnsaker og dagligvarer.",
      tags: ["økologisk", "dagligvare", "bergen", "frukt", "grønnsaker", "brød"],
    }],
    role: "producer",
    location: { lat: 60.3930, lng: 5.3240, city: "Bergen", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "grocery", "bergen-sentrum", "eco-certified"],
  });

  marketplaceRegistry.register({
    name: "Stend Gårdsbutikk og Gartneri",
    description: "Gårdsutsalg ved Stend videregående skole i Fana, Bergen. Økologiske egg, blomster, grønnsaker og kjøtt fra lokale vestlandsprodusenter.",
    provider: "Stend vidaregåande skule",
    contactEmail: "post@stend.vgs.no",
    url: "https://www.hanen.no/utforsk/32",
    skills: [{
      id: "sell-school-farm-bergen",
      name: "Gårdsmat fra Stend",
      description: "Gårdsutsalg med økologiske egg, grønnsaker og kjøtt. Fana, Bergen.",
      tags: ["gårdsbutikk", "stend", "fana", "økologisk", "egg"],
    }],
    role: "producer",
    location: { lat: 60.2930, lng: 5.3550, city: "Bergen", radiusKm: 8 },
    categories: ["vegetables", "eggs", "meat"],
    tags: ["farm-shop", "school-farm", "organic", "fana"],
  });

  marketplaceRegistry.register({
    name: "Bønes Gårdsmat",
    description: "Lokal matprodusent i Bergen med egen gårdsbutikk på Bønes og nettbutikk. Kjøtt, grønnsaker og lokale spesialiteter.",
    provider: "Bønes Gårdsmat",
    contactEmail: "post@bonesgardsmat.no",
    url: "https://www.facebook.com/bonesgardsmat/",
    skills: [{
      id: "sell-farm-food-bønes",
      name: "Gårdsmat Bønes Bergen",
      description: "Lokalprodusert kjøtt, grønnsaker og spesialiteter fra Bønes, Bergen.",
      tags: ["gårdsmat", "bønes", "bergen", "kjøtt", "grønnsaker"],
    }],
    role: "producer",
    location: { lat: 60.3330, lng: 5.2830, city: "Bergen", radiusKm: 8 },
    categories: ["meat", "vegetables"],
    tags: ["farm-shop", "bønes", "local-specialties"],
  });

  marketplaceRegistry.register({
    name: "Løvaas Gård — Bergen",
    description: "Gård i Bergen med gårdsbutikk og lokalmatproduksjon. Grønnsaker, urter og andre gårdsprodukter.",
    provider: "Løvaas Gård",
    contactEmail: "post@lovaasgard.no",
    url: "https://www.lovaasgard.no/lokalmat",
    skills: [{
      id: "sell-farm-food-løvaas",
      name: "Gårdsmat Løvaas Bergen",
      description: "Grønnsaker, urter og gårdsprodukter fra Løvaas Gård i Bergen.",
      tags: ["gårdsmat", "løvaas", "bergen", "grønnsaker", "urter"],
    }],
    role: "producer",
    location: { lat: 60.3700, lng: 5.3500, city: "Bergen", radiusKm: 8 },
    categories: ["vegetables", "herbs"],
    tags: ["farm-shop", "løvaas", "local"],
  });

  marketplaceRegistry.register({
    name: "Bondens Grøntmarked — Fisketorget Bergen",
    description: "Bondens Grøntmarked på Fisketorget i Bergen sentrum hver lørdag. Ferske frukt og grønnsaker direkte fra lokale produsenter.",
    provider: "Bondens marked Bergen",
    contactEmail: "bergen@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "green-market-bergen",
      name: "Bondens Grøntmarked Bergen",
      description: "Fersk frukt og grønnsaker på Fisketorget i Bergen hver lørdag.",
      tags: ["bondens marked", "grøntmarked", "fisketorget", "bergen"],
    }],
    role: "producer",
    location: { lat: 60.3945, lng: 5.3250, city: "Bergen", radiusKm: 5 },
    categories: ["vegetables", "fruit"],
    tags: ["farmers-market", "green-market", "fisketorget", "saturday"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Bergen Fana",
    description: "REKO-ring for Fana-området i Bergen. Direktehandel mellom lokale bønder og forbrukere via Facebook.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-fana",
      name: "REKO-ring Bergen Fana",
      description: "Direktesalg fra bonde til forbruker i Fana, Bergen.",
      tags: ["REKO", "fana", "bergen", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 60.2900, lng: 5.3500, city: "Bergen", radiusKm: 8 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "fana"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Bergen Fyllingsdalen",
    description: "REKO-ring for Fyllingsdalen i Bergen. Bestilling og utlevering via Facebook-gruppe.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-fyllingsdalen",
      name: "REKO-ring Bergen Fyllingsdalen",
      description: "Direktesalg fra bonde til forbruker i Fyllingsdalen, Bergen.",
      tags: ["REKO", "fyllingsdalen", "bergen", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 60.3500, lng: 5.2900, city: "Bergen", radiusKm: 6 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "fyllingsdalen"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Bergen Åsane",
    description: "REKO-ring for Åsane-området nord i Bergen. Lokal mat direkte fra produsent.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-aasane",
      name: "REKO-ring Bergen Åsane",
      description: "Direktesalg fra bonde til forbruker i Åsane, Bergen.",
      tags: ["REKO", "åsane", "bergen", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 60.4660, lng: 5.3280, city: "Bergen", radiusKm: 8 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey"],
    tags: ["reko", "direct-sales", "facebook", "åsane"],
  });

  // ════════════════════════════════════════════════════════════
  // F) TRONDHEIM — NEW SHOPS
  //    (REKO Moholt/Heimdal/Byåsen already in v2 — skip those)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Trondheim — nye butikker...");

  marketplaceRegistry.register({
    name: "Etikken — Økologisk Løsvektbutikk",
    description: "Non-profit butikk i Trondheim med Norges største utvalg av varer i løsvekt. Miljøvennlige dagligvarer. Olav Tryggvasons gt. 20.",
    provider: "Etikken",
    contactEmail: "post@etikken.no",
    url: "https://www.gronnguidetrondheim.no/gronnguide/dagligvare",
    skills: [{
      id: "sell-bulk-organic",
      name: "Løsvekt og økologisk Trondheim",
      description: "Økologisk mat i løsvekt. Norges største utvalg. Trondheim sentrum.",
      tags: ["økologisk", "løsvekt", "trondheim", "non-profit", "miljøvennlig"],
    }],
    role: "producer",
    location: { lat: 63.4332, lng: 10.4012, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "fruit", "bread"],
    tags: ["organic", "bulk", "non-profit", "eco-friendly"],
  });

  marketplaceRegistry.register({
    name: "Svartlamon Samvirkelag",
    description: "Arbeidereid samvirkelag på Svartlamon, Trondheim. Lokalprodusert, miljøvennlig og etisk mat basert på frivillig arbeid.",
    provider: "Svartlamon Samvirkelag",
    contactEmail: "post@svartlamon.org",
    url: "https://www.gronnguidetrondheim.no/gronnguide/dagligvare",
    skills: [{
      id: "sell-coop-groceries",
      name: "Samvirkelag Svartlamon",
      description: "Lokalprodusert og økologisk mat fra arbeidereid samvirke på Svartlamon.",
      tags: ["samvirke", "svartlamon", "trondheim", "økologisk", "lokal"],
    }],
    role: "producer",
    location: { lat: 63.4420, lng: 10.4210, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "fruit", "bread", "dairy"],
    tags: ["cooperative", "organic", "ethical", "svartlamon"],
  });

  marketplaceRegistry.register({
    name: "Helios Trondheim",
    description: "Norges eldste merkevare for økologisk mat, siden 1969. Butikk i Prinsens gate 53, Trondheim.",
    provider: "Helios AS",
    contactEmail: "post@helios.no",
    url: "https://www.gronnguidetrondheim.no/gronnguide/dagligvare",
    skills: [{
      id: "sell-organic-helios",
      name: "Helios økologisk Trondheim",
      description: "Økologisk matbutikk i Trondheim sentrum. Norges eldste økologiske merkevare.",
      tags: ["helios", "økologisk", "trondheim", "dagligvare"],
    }],
    role: "producer",
    location: { lat: 63.4310, lng: 10.3950, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "helios", "established", "trondheim-sentrum"],
  });

  marketplaceRegistry.register({
    name: "Stokke Gård — Bondemarked Moholt",
    description: "Gårdsbutikk og bondemarked ved Moholt, Trondheim. Åpent torsdager 10-16 og fredager 08:30-16:30.",
    provider: "Stokke Gård AS",
    contactEmail: "post@stokkegard.no",
    url: "http://stokkegard.no/bondens-marked/",
    skills: [{
      id: "sell-farm-stokke",
      name: "Stokke Gård Trondheim",
      description: "Bondemarked og gårdsbutikk på Moholt. Ost, kjøtt, brød.",
      tags: ["bondemarked", "moholt", "trondheim", "ost", "kjøtt"],
    }],
    role: "producer",
    location: { lat: 63.4100, lng: 10.4300, city: "Trondheim", radiusKm: 6 },
    categories: ["dairy", "meat", "bread", "vegetables"],
    tags: ["farm-shop", "market", "moholt", "weekly"],
  });

  // ════════════════════════════════════════════════════════════
  // G) STAVANGER/ROGALAND — NEW ENTRIES
  //    (Ullandhaug and Ims already in v2 — skip those)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Stavanger/Rogaland — nye gårdsbutikker...");

  marketplaceRegistry.register({
    name: "Vårsol Gartneri — Jæren",
    description: "Gartneri og gårdsbutikk med tomater og grønnsaker fra egen produksjon samt lokale produkter fra regionen.",
    provider: "Vårsol Gartneri",
    contactEmail: "post@varsolgartneri.no",
    url: "https://gladmat.no/matprodusenter/",
    skills: [{
      id: "sell-greenhouse-produce",
      name: "Drivhus-grønnsaker Jæren",
      description: "Tomater og grønnsaker fra eget gartneri. Lokale produkter fra Jæren.",
      tags: ["gartneri", "tomater", "grønnsaker", "jæren"],
    }],
    role: "producer",
    location: { lat: 58.7600, lng: 5.5800, city: "Sandnes", radiusKm: 12 },
    categories: ["vegetables"],
    tags: ["greenhouse", "tomatoes", "jæren", "local"],
  });

  marketplaceRegistry.register({
    name: "Sunde Gårdsutsalg — Stavanger",
    description: "Gårdsutsalg i Stavanger-regionen med lokalprodusert mat. Egg, kjøtt og sesonggrønnsaker.",
    provider: "Sunde Gårdsutsalg",
    contactEmail: "post@sundegard.no",
    url: "https://www.facebook.com/Sundegaardsutsalg/",
    skills: [{
      id: "sell-farm-sunde",
      name: "Gårdsmat Sunde Stavanger",
      description: "Lokalprodusert egg, kjøtt og grønnsaker fra Sunde i Stavanger.",
      tags: ["gårdsutsalg", "sunde", "stavanger", "egg", "kjøtt"],
    }],
    role: "producer",
    location: { lat: 58.9700, lng: 5.6300, city: "Stavanger", radiusKm: 8 },
    categories: ["eggs", "meat", "vegetables"],
    tags: ["farm-shop", "sunde", "local"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Randaberg",
    description: "REKO-ring for Randaberg kommune nord for Stavanger. Lokale produsenter fra Jæren.",
    provider: "REKO Norge",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-randaberg",
      name: "REKO-ring Randaberg",
      description: "Direktesalg fra bonde til forbruker i Randaberg.",
      tags: ["REKO", "randaberg", "stavanger", "jæren"],
    }],
    role: "producer",
    location: { lat: 59.0010, lng: 5.6200, city: "Randaberg", radiusKm: 8 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs"],
    tags: ["reko", "direct-sales", "facebook", "randaberg"],
  });

  // ════════════════════════════════════════════════════════════
  // H) NYE REKO-RINGER I NYE BYER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye REKO-ringer i nye byer...");

  const newRekoRings = [
    { name: "REKO-ringen Gjøvik", city: "Gjøvik", lat: 60.7957, lng: 10.6916, radius: 15 },
    { name: "REKO-ringen Halden", city: "Halden", lat: 59.1233, lng: 11.3875, radius: 12 },
    { name: "REKO-ringen Kongsvinger", city: "Kongsvinger", lat: 60.1913, lng: 12.0015, radius: 15 },
    { name: "REKO-ringen Sogndal", city: "Sogndal", lat: 61.2297, lng: 7.0940, radius: 20 },
    { name: "REKO-ringen Røros", city: "Røros", lat: 62.5748, lng: 11.3849, radius: 20 },
    { name: "REKO-ringen Stjørdal", city: "Stjørdal", lat: 63.4697, lng: 10.9136, radius: 12 },
    { name: "REKO-ringen Florø", city: "Florø", lat: 61.5997, lng: 5.0328, radius: 15 },
    { name: "REKO-ringen Førde", city: "Førde", lat: 61.4520, lng: 5.8570, radius: 15 },
    { name: "REKO-ringen Innherred", city: "Steinkjer", lat: 64.0148, lng: 11.4950, radius: 30 },
    { name: "REKO-ringen Mandal", city: "Mandal", lat: 58.0291, lng: 7.4609, radius: 15 },
    { name: "REKO-ringen Nordfjordeid", city: "Nordfjordeid", lat: 61.9065, lng: 5.9885, radius: 20 },
    { name: "REKO-ringen Fosen", city: "Fosen", lat: 63.7450, lng: 10.2330, radius: 25 },
    { name: "REKO-ringen Namdalen", city: "Namsos", lat: 64.4663, lng: 11.4946, radius: 25 },
    { name: "REKO-ringen Surnadal og Rindal", city: "Surnadal", lat: 62.9710, lng: 8.7180, radius: 20 },
    { name: "REKO-ringen Orkland", city: "Orkanger", lat: 63.3000, lng: 9.8500, radius: 15 },
    { name: "REKO-ringen Ringerike", city: "Hønefoss", lat: 60.1670, lng: 10.2580, radius: 15 },
    { name: "REKO-ringen Holmestrand", city: "Holmestrand", lat: 59.4890, lng: 10.3140, radius: 12 },
    { name: "REKO-ringen Brønnøysund", city: "Brønnøysund", lat: 65.4710, lng: 12.2100, radius: 20 },
    { name: "REKO-ringen Fauske", city: "Fauske", lat: 67.2580, lng: 15.3920, radius: 15 },
    { name: "REKO-ringen Finnsnes", city: "Finnsnes", lat: 69.2340, lng: 17.9790, radius: 15 },
    { name: "REKO-ringen Odda", city: "Odda", lat: 60.0690, lng: 6.5470, radius: 15 },
    { name: "REKO-ringen Voss", city: "Voss", lat: 60.6290, lng: 6.4180, radius: 15 },
    { name: "REKO-ringen Dokka", city: "Dokka", lat: 60.8330, lng: 10.0660, radius: 20 },
    { name: "REKO-ringen Hadeland", city: "Gran", lat: 60.3670, lng: 10.5600, radius: 15 },
    { name: "REKO-ringen Hallingdal", city: "Gol", lat: 60.7020, lng: 8.9510, radius: 25 },
    { name: "REKO-ringen Modum/Hokksund", city: "Hokksund", lat: 59.7680, lng: 9.9100, radius: 15 },
    { name: "REKO-ringen Kragerø", city: "Kragerø", lat: 58.8720, lng: 9.4110, radius: 15 },
    { name: "REKO-ringen Porsgrunn", city: "Porsgrunn", lat: 59.1400, lng: 9.6560, radius: 10 },
    { name: "REKO-ringen Rena", city: "Rena", lat: 61.1310, lng: 11.3670, radius: 20 },
    { name: "REKO-ringen Tynset", city: "Tynset", lat: 62.2750, lng: 10.7720, radius: 20 },
    { name: "REKO-ringen Valdres", city: "Fagernes", lat: 60.9860, lng: 9.2350, radius: 25 },
    { name: "REKO-ringen Sykkylven og Stranda", city: "Sykkylven", lat: 62.3910, lng: 6.5790, radius: 15 },
    { name: "REKO-ringen Ørsta/Volda", city: "Ørsta", lat: 62.1970, lng: 6.1300, radius: 15 },
    { name: "REKO-ringen Kvinnherad", city: "Rosendal", lat: 59.9870, lng: 6.0140, radius: 20 },
    { name: "REKO-ringen Sunnhordland", city: "Stord", lat: 59.7790, lng: 5.5040, radius: 20 },
    { name: "REKO-ringen Os Bergen", city: "Os", lat: 60.1880, lng: 5.4720, radius: 12 },
    { name: "REKO-ringen Samnanger", city: "Samnanger", lat: 60.3870, lng: 5.7420, radius: 12 },
  ];

  for (const reko of newRekoRings) {
    marketplaceRegistry.register({
      name: reko.name,
      description: `REKO-ring for ${reko.city} og omegn. Direktehandel mellom lokale bønder/produsenter og forbrukere via Facebook-gruppe. Bestill på nett, hent lokalt.`,
      provider: "REKO Norge",
      contactEmail: "post@rekonorge.no",
      url: "https://www.rekonorge.no/finn-din-rekoring",
      skills: [{
        id: `reko-${reko.city.toLowerCase().replace(/[^a-z]/g, '')}`,
        name: reko.name,
        description: `Direktesalg fra bonde til forbruker i ${reko.city} og omegn.`,
        tags: ["REKO", reko.city.toLowerCase(), "direktesalg", "bonde", "lokal mat"],
      }],
      role: "producer",
      location: { lat: reko.lat, lng: reko.lng, city: reko.city, radiusKm: reko.radius },
      categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "honey", "bread"],
      tags: ["reko", "direct-sales", "facebook", reko.city.toLowerCase().replace(/[^a-zæøå]/g, '')],
    });
  }

  // ════════════════════════════════════════════════════════════
  // I) NYE BONDENS MARKED LOKASJONER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye Bondens marked lokasjoner...");

  const newBondensMarked = [
    { name: "Bondens marked — Otta", city: "Otta", lat: 61.7720, lng: 9.5370, radius: 20 },
    { name: "Bondens marked — Sandane", city: "Sandane", lat: 61.7740, lng: 6.2170, radius: 20 },
    { name: "Bondens marked — Flisa", city: "Flisa", lat: 60.6110, lng: 12.0150, radius: 15 },
    { name: "Bondens marked — Nøtterøy", city: "Nøtterøy", lat: 59.2260, lng: 10.4120, radius: 10 },
    { name: "Bondens marked — Moelv", city: "Moelv", lat: 60.9320, lng: 10.7000, radius: 15 },
    { name: "Bondens marked — Kragerø", city: "Kragerø", lat: 58.8710, lng: 9.4100, radius: 12 },
    { name: "Bondens marked — Gran", city: "Gran", lat: 60.3670, lng: 10.5600, radius: 15 },
    { name: "Bondens marked — Løten", city: "Løten", lat: 60.8150, lng: 11.3490, radius: 12 },
    { name: "Bondens marked — Brumunddal", city: "Brumunddal", lat: 60.8850, lng: 10.9350, radius: 12 },
    { name: "Bondens marked — Lyngdal", city: "Lyngdal", lat: 58.1380, lng: 7.0700, radius: 15 },
    { name: "Bondens marked — Trysil", city: "Trysil", lat: 61.3160, lng: 12.2680, radius: 20 },
    { name: "Bondens marked — Råholt", city: "Råholt", lat: 60.2940, lng: 11.1570, radius: 10 },
    { name: "Bondens marked — Øystese", city: "Øystese", lat: 60.3740, lng: 6.2020, radius: 15 },
    { name: "Bondens marked — Stavanger Øst", city: "Stavanger", lat: 58.9720, lng: 5.7500, radius: 5 },
    { name: "Bondens marked — Kongensgate Trondheim", city: "Trondheim", lat: 63.4305, lng: 10.3960, radius: 5 },
  ];

  for (const bm of newBondensMarked) {
    marketplaceRegistry.register({
      name: bm.name,
      description: `Bondens marked i ${bm.city}. Lokale bønder og produsenter selger direkte: ost, kjøtt, fisk, brød, honning, frukt, bær og grønnsaker. Sesongbasert utvalg.`,
      provider: "Bondens marked Norge",
      contactEmail: "info@bondensmarked.no",
      url: "https://bondensmarked.no/markeder",
      skills: [{
        id: `bm-${bm.city.toLowerCase().replace(/[^a-z]/g, '')}`,
        name: `Bondens marked ${bm.city}`,
        description: `Direkte fra bonden i ${bm.city}. Sesongvarer, ost, kjøtt, brød, honning, frukt og grønnsaker.`,
        tags: ["bondens marked", bm.city.toLowerCase(), "sesong", "direkte", "lokal"],
      }],
      role: "producer",
      location: { lat: bm.lat, lng: bm.lng, city: bm.city, radiusKm: bm.radius },
      categories: ["vegetables", "fruit", "meat", "dairy", "honey", "bread", "fish"],
      tags: ["farmers-market", "seasonal", "direct-sales", bm.city.toLowerCase().replace(/[^a-zæøå]/g, '')],
    });
  }

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════
  const allAgents = marketplaceRegistry.getActiveAgents();
  const cities = [...new Set(allAgents.map((a: any) => a.city).filter(Boolean))];
  const producers = allAgents.filter((a: any) => a.role === "producer");

  console.log(`\n   ✅ Expansion v4 loaded:`);
  console.log(`      ${allAgents.length} agents total (across all seeds)`);
  console.log(`      ${producers.length} producers`);
  console.log(`      ${cities.length} cities/locations`);
  console.log(`\n   New in v4:`);
  console.log(`   Oslo: 3 nye grønnsaksbutikker, 1 Bondens marked, 4 REKO-ringer, 3 gårdsbutikker`);
  console.log(`   Bergen: Reindyrka, Stend, Bønes, Løvaas, Grøntmarked, 3 REKO-ringer`);
  console.log(`   Trondheim: Etikken, Svartlamon, Helios, Stokke Gård`);
  console.log(`   Stavanger: Vårsol, Sunde, REKO Randaberg`);
  console.log(`   Nye REKO-ringer: ${newRekoRings.length} nye i ${newRekoRings.length} byer`);
  console.log(`   Nye Bondens marked: ${newBondensMarked.length} nye lokasjoner`);
  console.log();
}
