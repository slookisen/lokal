import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway Database Expansion v5 ───────────────────────────
// Researched 2026-03-31. Sources: yelp.com, gulesider.no, 1881.no,
// proff.no, roetter.no, visitvestfold.com, hanen.no, bondensmarkedtroms.no,
// mathallentromso.no, bergensentrum.no, wolt.com, aktivioslo.no
//
// FOCUS AREAS (per slagplan "neste steg"):
// 1. Oslo — more grocery/produce shops (Frogner, Vika, St.Hanshaugen, Sagene, Nordstrand)
// 2. Oslo — økologisk/specialty shops (Røtter chain)
// 3. Tromsø — arktiske produsenter (from Bondens marked Troms list)
// 4. Bergen — sentrum grønnsaksbutikker
// 5. Vestfold — gårdsbutikker (from HANEN registry)
// 6. Tromsø — Mathallen
// 7. New cities: Alta, Flekkefjord, Notodden
//
// IMPORTANT: Entries already in v1-v4 seeds have been excluded.
// This file only adds GENUINELY NEW entries not present elsewhere.

export function seedExpansionV5() {
  const existing = marketplaceRegistry.getActiveAgents();
  const hasV5 = existing.some(
    (a: any) => a.name === "Ege Frukt & Grønt — Frogner" || a.name === "Mathallen Tromsø"
  );
  if (hasV5) {
    console.log(`🇳🇴 Expansion v5 already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway expansion v5 database...\n");

  // ════════════════════════════════════════════════════════════
  // A) OSLO — NEW GROCERY / FRUIT & VEG SHOPS
  //    (Not in v1-v4: Ege, Vika F&G, Grønlandtorg, Mevlana, Røtter)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — nye grønnsaksbutikker...");

  marketplaceRegistry.register({
    name: "Ege Frukt & Grønt — Frogner",
    description: "Populær frukt- og grønnsaksbutikk på Frogner med bredt utvalg av ferske norske og importerte grønnsaker, frukt og urter. Thomas Heftyes gate 52.",
    provider: "Ege Frukt DA",
    contactEmail: "post@egefrukt.no",
    url: "https://www.facebook.com/p/Ege-Frukt-100057210230469/",
    skills: [{
      id: "sell-produce-frogner",
      name: "Frukt og grønt Frogner",
      description: "Ferske grønnsaker, frukt, urter, pasta, oliven og fetaost. Lokalt og importert.",
      tags: ["grønnsaker", "frukt", "frogner", "fersk", "urter"],
    }],
    role: "producer",
    location: { lat: 59.9170, lng: 10.7070, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["daily-fresh", "frogner", "popular", "neighborhood"],
  });

  marketplaceRegistry.register({
    name: "Vika Frukt og Grønt",
    description: "Frukt- og grønnsaksbutikk i Vika med bredt utvalg. Huitfeldts gate 28. Åpen 11:30-22:30. Levering via Wolt og Helthjem.",
    provider: "Vika Frukt og Grønt AS",
    contactEmail: "post@vikafrukt.no",
    url: "https://www.instagram.com/vika.frukt.gront.as/",
    skills: [{
      id: "sell-produce-vika",
      name: "Frukt og grønt Vika",
      description: "Frukt, grønnsaker og dagligvarer i Vika. Lange åpningstider og levering.",
      tags: ["grønnsaker", "frukt", "vika", "levering", "dagligvare"],
    }],
    role: "producer",
    location: { lat: 59.9135, lng: 10.7280, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["delivery", "long-hours", "vika", "wolt"],
  });

  marketplaceRegistry.register({
    name: "Grønlandstorg Frukt & Grønt",
    description: "Kjent frukt- og grøntbutikk på Grønlandstorg med over 170 ulike frukt- og grønnsakstyper. Smalgangen 1. Konkurransedyktige priser.",
    provider: "Grønlandstorg Frukt & Grønt",
    contactEmail: "post@gronlandstorg.no",
    url: "https://gronlandstorg.no/gronlands-torg-frukt-og-gront/",
    skills: [{
      id: "sell-produce-gronlandstorg",
      name: "Frukt og grønt Grønlandstorg",
      description: "Over 170 typer frukt og grønnsaker. Importvarer og norske varer. Lave priser.",
      tags: ["grønnsaker", "frukt", "grønland", "mangfold", "170 typer", "rimelig"],
    }],
    role: "producer",
    location: { lat: 59.9120, lng: 10.7595, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["huge-selection", "competitive-prices", "grønland", "170-varieties"],
  });

  marketplaceRegistry.register({
    name: "Mevlana Frukt & Grønt",
    description: "Etablert frukt- og grønnsaksbutikk nær Tøyen/Grønland. Tyrkiske og norske grønnsaker, krydder, urter. I drift siden 1996.",
    provider: "Mevlana Frukt & Grønt AS",
    contactEmail: "post@mevlana.no",
    url: "https://www.instagram.com/explore/locations/1189110674605309/",
    skills: [{
      id: "sell-produce-mevlana",
      name: "Frukt og grønt Mevlana",
      description: "Tyrkisk og norsk frukt, grønnsaker og krydder nær Tøyen. Siden 1996.",
      tags: ["grønnsaker", "frukt", "tøyen", "tyrkisk", "krydder", "etablert"],
    }],
    role: "producer",
    location: { lat: 59.9135, lng: 10.7650, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["established-1996", "turkish", "tøyen", "spices"],
  });

  marketplaceRegistry.register({
    name: "Izmir Import — Frukt og Grønt",
    description: "Populær grønnsaksbutikk med import-frukt og grønnsaker. Tyrkiske, middelhavske og norske varer. Bredt utvalg og gode priser.",
    provider: "Izmir Import",
    contactEmail: "post@izmirimport.no",
    url: "https://www.yelp.com/search?cflt=markets&find_loc=Oslo",
    skills: [{
      id: "sell-produce-izmir",
      name: "Import frukt og grønt",
      description: "Tyrkisk og middelhavs import-frukt og grønnsaker. Gode priser.",
      tags: ["grønnsaker", "frukt", "import", "tyrkisk", "middelhav"],
    }],
    role: "producer",
    location: { lat: 59.9260, lng: 10.7520, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["import", "turkish", "mediterranean", "competitive-prices"],
  });

  // ════════════════════════════════════════════════════════════
  // B) OSLO — ØKOLOGISK / SPECIALTY SHOPS (Røtter chain)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — økologiske butikker (Røtter)...");

  marketplaceRegistry.register({
    name: "Røtter St. Hanshaugen",
    description: "Norges mest kjente økologiske matbutikk. Ullevålsveien 39. Åpen 365 dager i året. Stort utvalg økologisk frukt, grønnsaker, meieri, brød og tørrvarer.",
    provider: "Røtter AS",
    contactEmail: "post@roetter.no",
    url: "https://roetter.no/",
    skills: [{
      id: "sell-organic-hanshaugen",
      name: "Økologisk mat St. Hanshaugen",
      description: "Norges bredeste utvalg av økologisk mat. Frukt, grønnsaker, meieri, brød. Åpen 365 dager.",
      tags: ["økologisk", "st.hanshaugen", "frukt", "grønnsaker", "meieri", "brød"],
    }],
    role: "producer",
    location: { lat: 59.9270, lng: 10.7420, city: "Oslo", radiusKm: 4 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "st-hanshaugen", "365-days", "specialty"],
  });

  marketplaceRegistry.register({
    name: "Røtter Frogner",
    description: "Økologisk matbutikk på Frogner. Bygdøy Allé 23. Elegant utvalg av økologisk frukt, grønnsaker, meieri og bakervarer.",
    provider: "Røtter AS",
    contactEmail: "frogner@roetter.no",
    url: "https://roetter.no/",
    skills: [{
      id: "sell-organic-frogner",
      name: "Økologisk mat Frogner",
      description: "Elegant økologisk matbutikk på Frogner. Frukt, grønnsaker, meieri.",
      tags: ["økologisk", "frogner", "frukt", "grønnsaker", "elegant"],
    }],
    role: "producer",
    location: { lat: 59.9160, lng: 10.7100, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "frogner", "specialty", "premium"],
  });

  marketplaceRegistry.register({
    name: "Røtter Grünerløkka",
    description: "Økologisk matbutikk på Grünerløkka med kreativ profil. Åpnet 2019. Økologisk frukt, grønnsaker og lokal mat.",
    provider: "Røtter AS",
    contactEmail: "grunerlokka@roetter.no",
    url: "https://roetter.no/",
    skills: [{
      id: "sell-organic-grunerlokka",
      name: "Økologisk mat Grünerløkka",
      description: "Kreativ økologisk matbutikk på Grünerløkka. Lokal og økologisk mat.",
      tags: ["økologisk", "grünerløkka", "kreativ", "lokal", "frukt", "grønnsaker"],
    }],
    role: "producer",
    location: { lat: 59.9225, lng: 10.7584, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "grünerløkka", "creative", "local"],
  });

  // ════════════════════════════════════════════════════════════
  // C) TROMSØ — ARKTISKE PRODUSENTER + MATHALLEN
  //    (Slagplan: "Tromsø: flere arktiske produsenter — ca. 40 på Bondens marked, bare 5 registrert")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Tromsø — arktiske produsenter og Mathallen...");

  marketplaceRegistry.register({
    name: "Mathallen Tromsø",
    description: "Restaurant og matmarked i Tromsø sentrum. Grønnegata 58-60. Samarbeider med lokale produsenter som Finnes Gård, Halvors Tradisjonsfisk og Mack. Arktiske og kortreiste råvarer.",
    provider: "Mathallen Tromsø AS",
    contactEmail: "post@mathallentromso.no",
    url: "https://mathallentromso.no/",
    skills: [{
      id: "arctic-food-hall",
      name: "Mathallen Tromsø — arktisk mat",
      description: "Nordnorsk mat basert på kortreiste og arktiske råvarer. Lokale produsenter.",
      tags: ["mathall", "tromsø", "arktisk", "kortreist", "restaurant", "matmarked"],
    }],
    role: "producer",
    location: { lat: 69.6496, lng: 18.9560, city: "Tromsø", radiusKm: 5 },
    categories: ["meat", "fish", "vegetables", "dairy"],
    tags: ["food-hall", "arctic", "local-sourced", "restaurant"],
  });

  marketplaceRegistry.register({
    name: "Kjelkebakken Gård — Lyngen",
    description: "Gård i Lyngen med sau og lam. Selger lammekjøtt direkte via Bondens marked Troms. Arktisk lammeprodusent.",
    provider: "Kjelkebakken Gård",
    contactEmail: "post@kjelkebakkengard.no",
    url: "https://www.bondensmarkedtroms.no/produsenter/kjelkebakken-gård",
    skills: [{
      id: "sell-arctic-lamb",
      name: "Arktisk lammekjøtt fra Lyngen",
      description: "Lammekjøtt fra Lyngen. Bondens marked Troms.",
      tags: ["lam", "kjøtt", "lyngen", "arktisk", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.5700, lng: 20.2100, city: "Lyngen", radiusKm: 30 },
    categories: ["meat"],
    tags: ["arctic", "lamb", "farm", "bondens-marked-troms"],
  });

  marketplaceRegistry.register({
    name: "Myrvang Gård — honningprodusent Tromsø",
    description: "Honningprodusent som selger fra gården og på Bondens marked i Tromsø. Arktisk honning fra Nord-Norges birøktere.",
    provider: "Myrvang Gård",
    contactEmail: "post@myrvanggard.no",
    url: "https://www.bondensmarkedtroms.no/produsenter/myrvang-gård-1",
    skills: [{
      id: "sell-arctic-honey",
      name: "Arktisk honning Tromsø",
      description: "Honning fra Nord-Norge. Selges på gården og Bondens marked Tromsø.",
      tags: ["honning", "tromsø", "arktisk", "birøkt", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.6500, lng: 18.9800, city: "Tromsø", radiusKm: 10 },
    categories: ["honey"],
    tags: ["arctic", "honey", "beekeeper", "bondens-marked-troms"],
  });

  marketplaceRegistry.register({
    name: "Bomstad Gård — geiteost Lyngen",
    description: "Gård ved inngangen til Lyngsalpene med ca. 100 melkegeiter. Produserer ost av egen geitmelk. Arktisk gårdsysteri.",
    provider: "Bomstad Gård",
    contactEmail: "post@bomstadgard.no",
    url: "https://www.bondensmarkedtroms.no/",
    skills: [{
      id: "sell-goat-cheese-lyngen",
      name: "Geiteost fra Lyngsalpene",
      description: "Håndlaget geiteost fra 100 melkegeiter ved Lyngsalpene.",
      tags: ["ost", "geit", "lyngen", "arktisk", "gårdsysteri"],
    }],
    role: "producer",
    location: { lat: 69.5600, lng: 20.1800, city: "Lyngen", radiusKm: 30 },
    categories: ["dairy"],
    tags: ["arctic", "goat-cheese", "farm-dairy", "lyngsalpene"],
  });

  marketplaceRegistry.register({
    name: "Arktisk Kje",
    description: "Samarbeid mellom 34 geitebønder i Nord-Norge. Bærekraftig kjekjøttprodukt fra en ubrukt ressurs. Selges via Bondens marked Troms.",
    provider: "Arktisk Kje SA",
    contactEmail: "post@arktiskkje.no",
    url: "https://www.bondensmarkedtroms.no/",
    skills: [{
      id: "sell-kid-meat",
      name: "Arktisk kjekjøtt",
      description: "Bærekraftig kjekjøtt fra 34 geitebønder i Nord-Norge.",
      tags: ["kjekjøtt", "geit", "arktisk", "bærekraftig", "nord-norge"],
    }],
    role: "producer",
    location: { lat: 69.6500, lng: 18.9600, city: "Tromsø", radiusKm: 50 },
    categories: ["meat"],
    tags: ["arctic", "goat-kid-meat", "sustainable", "cooperative"],
  });

  marketplaceRegistry.register({
    name: "Fallvik Gård — Troms",
    description: "Gårdsprodusent i Troms som selger på Bondens marked Troms. Lokale gårdsprodukter.",
    provider: "Fallvik Gård",
    contactEmail: "post@fallvikgard.no",
    url: "https://www.bondensmarkedtroms.no/",
    skills: [{
      id: "sell-farm-products-troms",
      name: "Gårdsprodukter Troms",
      description: "Lokale gårdsprodukter fra Troms. Bondens marked.",
      tags: ["gård", "troms", "lokal mat", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.6300, lng: 18.9000, city: "Tromsø", radiusKm: 30 },
    categories: ["vegetables", "meat"],
    tags: ["arctic", "farm", "bondens-marked-troms"],
  });

  marketplaceRegistry.register({
    name: "Olabakken Gård — Tromsø",
    description: "Gårdsprodusent nær Tromsø. Selger lokale produkter via Bondens marked Troms.",
    provider: "Olabakken Gård",
    contactEmail: "post@olabakkengard.no",
    url: "https://www.bondensmarkedtroms.no/",
    skills: [{
      id: "sell-farm-products-olabakken",
      name: "Gårdsprodukter Olabakken",
      description: "Lokale gårdsprodukter fra Tromsø-området. Bondens marked.",
      tags: ["gård", "tromsø", "lokal mat", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.6700, lng: 18.9400, city: "Tromsø", radiusKm: 15 },
    categories: ["vegetables", "meat", "eggs"],
    tags: ["arctic", "farm", "bondens-marked-troms"],
  });

  marketplaceRegistry.register({
    name: "Mors Mat — Tromsø",
    description: "Lokal matprodusent i Tromsø som selger hjemmelaget mat og bakervarer på Bondens marked Troms.",
    provider: "Mors Mat",
    contactEmail: "post@morsmat.no",
    url: "https://www.bondensmarkedtroms.no/",
    skills: [{
      id: "sell-homemade-food",
      name: "Hjemmelaget mat Tromsø",
      description: "Hjemmelaget mat og bakervarer. Bondens marked Tromsø.",
      tags: ["hjemmelaget", "bakervarer", "tromsø", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 69.6500, lng: 18.9550, city: "Tromsø", radiusKm: 10 },
    categories: ["bread", "preserves"],
    tags: ["homemade", "baked-goods", "bondens-marked-troms"],
  });

  // ════════════════════════════════════════════════════════════
  // D) BERGEN — SENTRUM GRØNNSAKSBUTIKKER
  //    (Slagplan: "Grønnsaksbutikker i Bergen sentrum ... utover Reindyrka/Etikken")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Bergen — nye grønnsaksbutikker...");

  marketplaceRegistry.register({
    name: "Sætre Frukt og Grønt — Bergen",
    description: "Frukt- og grønnsaksbutikk i Bergen med bredt utvalg av asiatiske og norske dagligvarer, frukt og grønnsaker.",
    provider: "Sætre Frukt og Grønt Dagligvare AS",
    contactEmail: "post@saetrefrukt.no",
    url: "https://www.facebook.com/SaetreFruktOgGront/",
    skills: [{
      id: "sell-produce-bergen-saetre",
      name: "Frukt og grønt Bergen",
      description: "Asiatisk og norsk frukt, grønnsaker og dagligvarer i Bergen.",
      tags: ["frukt", "grønnsaker", "bergen", "asiatisk", "norsk"],
    }],
    role: "producer",
    location: { lat: 60.3700, lng: 5.3600, city: "Bergen", radiusKm: 5 },
    categories: ["vegetables", "fruit"],
    tags: ["asian", "norwegian", "daily-fresh", "bergen"],
  });

  // ════════════════════════════════════════════════════════════
  // E) VESTFOLD — GÅRDSBUTIKKER (from HANEN/visitvestfold)
  //    (Slagplan: "Gårdsbutikker i Vestfold/Telemark/Buskerud (fra HANEN-registeret)")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Vestfold — gårdsbutikker...");

  marketplaceRegistry.register({
    name: "Fat og Fe — Sandefjord",
    description: "Økologisk gårdsbutikk og kolonial i Sandefjord, Vestfold. Økologiske dagligvarer, lokal mat og hyggelig atmosfære.",
    provider: "Fat og Fe",
    contactEmail: "post@fatogfe.no",
    url: "https://www.fatogfe.no/",
    skills: [{
      id: "sell-organic-sandefjord",
      name: "Økologisk gårdsbutikk Sandefjord",
      description: "Økologisk mat og dagligvarer i Sandefjord. Lokale og økologiske produkter.",
      tags: ["økologisk", "sandefjord", "vestfold", "gårdsbutikk", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.1300, lng: 10.2200, city: "Sandefjord", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "bread", "meat"],
    tags: ["organic", "farm-shop", "vestfold", "sandefjord"],
  });

  marketplaceRegistry.register({
    name: "Krokeborg Gård — Tønsberg",
    description: "Gårdsbutikk i Undrumsdal, Tønsberg kommune. Selvbetjent butikk åpen daglig 09-21. Fersk mat fra gården.",
    provider: "Krokeborg Gård",
    contactEmail: "post@krokeborggard.no",
    url: "https://www.hanen.no/utforsk/32/vestfold",
    skills: [{
      id: "sell-farm-products-tonsberg",
      name: "Gårdsbutikk Tønsberg",
      description: "Selvbetjent gårdsbutikk i Undrumsdal. Åpen daglig 09-21.",
      tags: ["gårdsbutikk", "tønsberg", "selvbetjent", "vestfold"],
    }],
    role: "producer",
    location: { lat: 59.2900, lng: 10.3700, city: "Tønsberg", radiusKm: 10 },
    categories: ["vegetables", "eggs", "meat"],
    tags: ["farm-shop", "self-service", "daily-open", "vestfold"],
  });

  marketplaceRegistry.register({
    name: "Møyland Gårdsbutikk — Andebu",
    description: "Sentralt i Andebu, hjertet av Vestfold. Selger ferske egg fra frittgående høner og matvarer fra lokale produsenter.",
    provider: "Møyland Gårdsbutikk",
    contactEmail: "post@moylandgard.no",
    url: "https://www.hanen.no/utforsk/32/vestfold",
    skills: [{
      id: "sell-farm-eggs-andebu",
      name: "Frittgående egg og lokal mat Andebu",
      description: "Ferske egg fra frittgående høner og lokale matvarer i Vestfold.",
      tags: ["egg", "frittgående", "andebu", "vestfold", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.2400, lng: 10.2300, city: "Andebu", radiusKm: 10 },
    categories: ["eggs", "vegetables"],
    tags: ["free-range-eggs", "farm-shop", "vestfold"],
  });

  marketplaceRegistry.register({
    name: "Nordre Bergan Gård — Sandefjord",
    description: "Gård i Råstad, Sandefjord. Dyrker epler, gresskar og korn. Gårdsbutikk med lokale produkter.",
    provider: "Nordre Bergan Gård",
    contactEmail: "post@nordrebergangard.no",
    url: "https://www.visitvestfold.com/no/servering-og-uteliv/lokal-mat-fra-vestfold",
    skills: [{
      id: "sell-apples-sandefjord",
      name: "Epler og gresskar Sandefjord",
      description: "Norske epler, gresskar og korn fra gården i Sandefjord.",
      tags: ["epler", "gresskar", "korn", "sandefjord", "vestfold"],
    }],
    role: "producer",
    location: { lat: 59.1400, lng: 10.1800, city: "Sandefjord", radiusKm: 10 },
    categories: ["fruit", "vegetables"],
    tags: ["apples", "pumpkin", "grain", "farm-shop", "vestfold"],
  });

  marketplaceRegistry.register({
    name: "Søndre Grevle Gårdsbutikk",
    description: "Liten gul gårdsbutikk — hjertet av gården. Selger alt som produseres på gården pluss lokale grønnsaker og produkter fra andre småskalaprodusenter.",
    provider: "Søndre Grevle",
    contactEmail: "post@sondregrevle.no",
    url: "https://www.visitvestfold.com/no/servering-og-uteliv/lokal-mat-fra-vestfold",
    skills: [{
      id: "sell-farm-produce-grevle",
      name: "Gårdsprodukter Søndre Grevle",
      description: "Småskala gårdsprodukter og lokale grønnsaker fra Vestfold.",
      tags: ["gårdsbutikk", "vestfold", "småskala", "lokal", "grønnsaker"],
    }],
    role: "producer",
    location: { lat: 59.2000, lng: 10.2500, city: "Vestfold", radiusKm: 10 },
    categories: ["vegetables", "eggs", "preserves"],
    tags: ["small-scale", "farm-shop", "vestfold", "charming"],
  });

  marketplaceRegistry.register({
    name: "Hagvoll Gårdsbutikk — Kragerø",
    description: "Selvbetjent gårdsbutikk i Sannidal nær Kragerø. Selger meieriprodukter og ferske brune egg fra gården.",
    provider: "Hagvoll Gårdsbutikk",
    contactEmail: "post@hagvollgard.no",
    url: "https://www.hanen.no/utforsk/32/vestfold-og-telemark",
    skills: [{
      id: "sell-dairy-kragero",
      name: "Gårdsprodukter Kragerø",
      description: "Meieriprodukter og egg fra Sannidal, Kragerø. Selvbetjent gårdsbutikk.",
      tags: ["meieri", "egg", "kragerø", "sannidal", "selvbetjent"],
    }],
    role: "producer",
    location: { lat: 58.8700, lng: 9.4100, city: "Kragerø", radiusKm: 10 },
    categories: ["dairy", "eggs"],
    tags: ["farm-shop", "self-service", "telemark", "kragerø"],
  });

  // ════════════════════════════════════════════════════════════
  // F) VESTFOLD — QUALITY/DIRECTORY AGENTS
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Vestfold — regionale kataloger...");

  marketplaceRegistry.register({
    name: "Godt Lokalt Sandefjord",
    description: "Butikk i Sandefjord med bredt utvalg av lokale varer fra Vestfold og Telemark, samt delikatesser fra resten av landet.",
    provider: "Godt Lokalt AS",
    contactEmail: "post@godtlokalt.no",
    url: "https://www.godtlokalt.no/regioner/vestfoldtelemark",
    skills: [{
      id: "local-food-directory-vestfold",
      name: "Lokal mat Vestfold/Telemark",
      description: "Oversikt over lokale matvarer fra Vestfold og Telemark.",
      tags: ["lokal mat", "vestfold", "telemark", "directory", "delikatesser"],
    }],
    role: "quality",
    location: { lat: 59.1300, lng: 10.2300, city: "Sandefjord", radiusKm: 50 },
    categories: ["vegetables", "fruit", "meat", "dairy", "bread", "preserves"],
    tags: ["directory", "vestfold", "telemark", "regional"],
  });

  // ════════════════════════════════════════════════════════════
  // G) NYE REKO-RINGER (som mangler i v4)
  //    Alta, Flekkefjord, Notodden
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye byer — REKO-ringer og markeder...");

  marketplaceRegistry.register({
    name: "REKO-ringen Alta",
    description: "REKO-ring i Alta, Finnmark. Direkte handel mellom lokale bønder og forbrukere via Facebook.",
    provider: "REKO-ringen Alta",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-alta",
      name: "REKO Alta",
      description: "Lokal mat direkte fra produsenter i Alta. Facebook-basert bestilling og utlevering.",
      tags: ["reko", "alta", "finnmark", "arktisk", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 69.9689, lng: 23.2716, city: "Alta", radiusKm: 15 },
    categories: ["vegetables", "meat", "fish", "dairy", "bread"],
    tags: ["reko", "alta", "finnmark", "arctic"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Hammerfest",
    description: "REKO-ring i Hammerfest, Finnmark. Nordligste REKO-ringer i Norge. Direkte handel lokale produsenter.",
    provider: "REKO-ringen Hammerfest",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-hammerfest",
      name: "REKO Hammerfest",
      description: "Lokal mat i Hammerfest. Arktiske produsenter, fisk, kjøtt, rein.",
      tags: ["reko", "hammerfest", "finnmark", "arktisk", "nordligst"],
    }],
    role: "producer",
    location: { lat: 70.6634, lng: 23.6821, city: "Hammerfest", radiusKm: 15 },
    categories: ["meat", "fish", "dairy"],
    tags: ["reko", "hammerfest", "finnmark", "arctic", "northernmost"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Notodden",
    description: "REKO-ring i Notodden, Telemark. Lokale bønder selger direkte. Grønnsaker, kjøtt, egg, honning.",
    provider: "REKO-ringen Notodden",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-notodden",
      name: "REKO Notodden",
      description: "Lokal mat fra Telemark-produsenter. REKO-ring i Notodden.",
      tags: ["reko", "notodden", "telemark", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.5630, lng: 9.2630, city: "Notodden", radiusKm: 15 },
    categories: ["vegetables", "meat", "eggs", "honey"],
    tags: ["reko", "notodden", "telemark"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Flekkefjord",
    description: "REKO-ring i Flekkefjord, Agder. Lokale produsenter selger direkte til forbrukere.",
    provider: "REKO-ringen Flekkefjord",
    contactEmail: "post@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-flekkefjord",
      name: "REKO Flekkefjord",
      description: "Lokal mat fra Agder-produsenter i Flekkefjord.",
      tags: ["reko", "flekkefjord", "agder", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.2970, lng: 6.6620, city: "Flekkefjord", radiusKm: 15 },
    categories: ["vegetables", "meat", "fish", "dairy"],
    tags: ["reko", "flekkefjord", "agder"],
  });

  // ════════════════════════════════════════════════════════════
  // H) OSLO — BONDENS MARKED NYE LOKASJONER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — nye Bondens marked lokasjoner...");

  marketplaceRegistry.register({
    name: "Bondens marked — Vinkelplassen Majorstuen",
    description: "Bondens marked ved Vinkelplassen på Majorstuen. Fredager i sesong, 11-17. Opp til 16 produsenter med lokal mat, grønnsaker, ost, brød, honning.",
    provider: "Bondens marked Oslo og Akershus",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsplasser/vinkelplassen-majorstuen",
    skills: [{
      id: "farmers-market-majorstuen",
      name: "Bondens marked Majorstuen",
      description: "Ukentlig marked på Vinkelplassen, Majorstuen. Fredager 11-17 i sesong. 12-16 produsenter.",
      tags: ["bondens marked", "majorstuen", "fredag", "sesong", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.9300, lng: 10.7150, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "dairy", "bread", "honey", "meat"],
    tags: ["farmers-market", "majorstuen", "friday", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Bondens marked — Bærums Verk",
    description: "Bondens marked på Bærums Verk. Lokale bønder fra Akershus med sesongvarer, ost, kjøtt, grønnsaker og honning.",
    provider: "Bondens marked Oslo og Akershus",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-baerumsverk",
      name: "Bondens marked Bærums Verk",
      description: "Lokal mat fra Akershus-bønder. Sesongvarer på Bærums Verk.",
      tags: ["bondens marked", "bærum", "bærums verk", "akershus", "sesong"],
    }],
    role: "producer",
    location: { lat: 59.8900, lng: 10.5200, city: "Bærum", radiusKm: 8 },
    categories: ["vegetables", "fruit", "dairy", "bread", "honey", "meat"],
    tags: ["farmers-market", "bærum", "bærums-verk", "akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // I) OSLO — GÅRDSBUTIKKER I OSLO-NÆRT
  //    (Dyster Gård, Grini Hjemmebakeri)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo-nært — nye gårdsbutikker...");

  marketplaceRegistry.register({
    name: "Dyster Gård — Ås",
    description: "Gårdsslakteri og butikk i Ås. Åpnet 2023. Ferskt kjøtt hver torsdag og fredag. Kortreist og bærekraftig produksjon.",
    provider: "Dyster Gård",
    contactEmail: "post@dystergaard.no",
    url: "https://www.dystergaard.no/",
    skills: [{
      id: "sell-meat-as",
      name: "Ferskt kjøtt fra Ås",
      description: "Gårdsslakteri med ferskt kjøtt tor-fre. Kortreist fra Ås.",
      tags: ["kjøtt", "gårdsslakteri", "ås", "ferskt", "kortreist"],
    }],
    role: "producer",
    location: { lat: 59.6600, lng: 10.7900, city: "Ås", radiusKm: 15 },
    categories: ["meat"],
    tags: ["farm-butcher", "fresh-meat", "ås", "sustainable"],
  });

  marketplaceRegistry.register({
    name: "Grini Hjemmebakeri og Gårdsbutikk",
    description: "Hjemmebakeri og gårdsbutikk i Akershus. Brød, bakervarer og lokale gårdsprodukter.",
    provider: "Grini Hjemmebakeri",
    contactEmail: "post@grinibakeri.no",
    url: "https://www.visitgreateroslo.com/no/artikler/Gardsbutikker/",
    skills: [{
      id: "sell-bakery-grini",
      name: "Hjemmebakeri og gårdsprodukter",
      description: "Hjemmebakte brød, bakervarer og lokale gårdsprodukter.",
      tags: ["bakeri", "brød", "gårdsbutikk", "hjemmebakt", "akershus"],
    }],
    role: "producer",
    location: { lat: 59.8800, lng: 10.5500, city: "Bærum", radiusKm: 10 },
    categories: ["bread"],
    tags: ["bakery", "farm-shop", "homemade", "akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // J) TRONDHEIM — SENTRUM BUTIKKER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Trondheim — nye butikker...");

  marketplaceRegistry.register({
    name: "Bondens marked — Kongens gate Trondheim (utvidet)",
    description: "Utvidet marked på Kongens gate i Trondheim sentrum. Trønderske bønder med lokal mat. Sesongens beste fra Trøndelag.",
    provider: "Bondens marked Trøndelag",
    contactEmail: "trondelag@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-kongens-gate-extended",
      name: "Bondens marked Kongens gate utvidet",
      description: "Utvidet Bondens marked i Trondheim sentrum. Trønderske gårdsprodukter.",
      tags: ["bondens marked", "trondheim", "kongens gate", "trøndelag", "utvidet"],
    }],
    role: "producer",
    location: { lat: 63.4310, lng: 10.3950, city: "Trondheim", radiusKm: 5 },
    categories: ["vegetables", "fruit", "meat", "dairy", "bread", "fish"],
    tags: ["farmers-market", "trondheim", "expanded", "trøndelag"],
  });

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════
  const allAgents = marketplaceRegistry.getActiveAgents();
  const cities = new Set(allAgents.map((a: any) => {
    try {
      const cats = JSON.parse(a.city || "null");
      return cats;
    } catch {
      return a.city;
    }
  }).filter(Boolean));

  console.log(`\n   ✅ Expansion v5 loaded:`);
  console.log(`      ${allAgents.length} agents total (across all seeds)`);
  console.log(`      ${allAgents.filter((a: any) => a.role === "producer").length} producers`);
  console.log(`      ${cities.size} cities/locations`);
  console.log(`\n   New in v5:`);
  console.log(`   Oslo: 5 nye grønnsaksbutikker (Ege, Vika, Grønlandstorg, Mevlana, Izmir)`);
  console.log(`         3 Røtter økologisk butikker (St.Hanshaugen, Frogner, Grünerløkka)`);
  console.log(`         2 nye Bondens marked (Majorstuen/Vinkelplassen, Bærums Verk)`);
  console.log(`         2 nye gårdsbutikker (Dyster Gård Ås, Grini Bærum)`);
  console.log(`   Tromsø: 8 nye (Mathallen, Kjelkebakken, Myrvang, Bomstad, Arktisk Kje,`);
  console.log(`           Fallvik, Olabakken, Mors Mat)`);
  console.log(`   Bergen: 1 ny grønnsaksbutikk (Sætre Frukt og Grønt)`);
  console.log(`   Vestfold: 6 nye gårdsbutikker (Fat og Fe, Krokeborg, Møyland,`);
  console.log(`             Nordre Bergan, Søndre Grevle, Hagvoll)`);
  console.log(`             1 ny regional katalog (Godt Lokalt Sandefjord)`);
  console.log(`   Nye byer: Alta, Hammerfest, Notodden, Flekkefjord (REKO-ringer)`);
  console.log(`   Trondheim: 1 utvidet Bondens marked\n`);
}
