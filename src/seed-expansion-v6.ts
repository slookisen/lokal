import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway Database Expansion v6 ───────────────────────────
// Researched 2026-03-31. Sources: hanen.no/utforsk/32/buskerud,
// rensmak.no, gronnguidetrondheim.no, kinsarvik.no, gulesider.no,
// proff.no, fredrikstadsentrum.no, kvadraturen.no, bakklandetdelikatesse.no,
// bondensmarked.no, statsforvalteren.no (Rogaland øko-PDF)
//
// FOCUS AREAS (per slagplan "neste steg" items 5-14):
// 1. Buskerud — gårdsbutikker (from HANEN registry): Bakke Gård, Eiker Gårdsysteri, Eiker Hjort, Garden Oppheim
// 2. Buskerud/Lier — Rensmak-produsenter (Grøntbua Gilhus, Søndre Røine, Helgerud, Berles, Solberg)
// 3. Bergen — flere grønnsaksbutikker/øko i sentrum: Kinsarvik Naturkost
// 4. Trondheim — delikatessebutikker/lokal mat: Bakklandet Delikatesse, Dyrket.no
// 5. Kristiansand — økologisk butikk: Sans & Smak
// 6. Fredrikstad — Fredrikstad Frukt og Grønt
// 7. Stavanger — LOKAL matbutikk (ny kjede)
// 8. Oslo — Sagene Frukt og Grønt (separate from Sagene Torg)
// 9. Bondens marked Drammen & Hønefoss — expanded info
// 10. Drammen — Bondens marked producers (Bakken Øvre, Bøhmer, Det Gamle Røgeri)
//
// IMPORTANT: Entries already in v1-v5 seeds have been excluded.
// This file only adds GENUINELY NEW entries not present elsewhere.

export function seedExpansionV6() {
  const existing = marketplaceRegistry.getActiveAgents();
  const hasV6 = existing.some(
    (a: any) => a.name === "Kinsarvik Naturkost — Bergen Sentrum" || a.name === "Bakke Gård — Modum/Sigdal"
  );
  if (hasV6) {
    console.log(`🇳🇴 Expansion v6 already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway expansion v6 database...\n");

  // ════════════════════════════════════════════════════════════
  // A) BUSKERUD — GÅRDSBUTIKKER (from HANEN registry)
  //    (Slagplan: "Gårdsbutikker i Buskerud (fra HANEN-registeret)")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Buskerud — gårdsbutikker (HANEN)...");

  marketplaceRegistry.register({
    name: "Bakke Gård — Modum/Sigdal",
    description: "Lite gårdsbakeri på Bakke gård, på grensen mellom Modum og Sigdal kommune. Kortreist kvalitetsmat, bakevarer og lokale produkter fra Buskerud.",
    provider: "Bakke Gård",
    contactEmail: "post@bakke-gard.no",
    url: "https://www.hanen.no/bedrift/516",
    skills: [{
      id: "sell-bakery-modum",
      name: "Gårdsbakeri Modum/Sigdal",
      description: "Kortreist kvalitetsmat og bakevarer fra Buskerud. Gårdsbakeri.",
      tags: ["bakeri", "gårdsbutikk", "modum", "sigdal", "buskerud", "kortreist"],
    }],
    role: "producer",
    location: { lat: 59.8300, lng: 9.9800, city: "Modum", radiusKm: 15 },
    categories: ["bread", "preserves"],
    tags: ["farm-bakery", "buskerud", "local-food", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Eiker Gårdsysteri — Hokksund",
    description: "Gårdsysteri i Hokksund, Øvre Eiker med 60 frittgående melkekyr. Produserer velsmakende oster og selger annen lokal kvalitetsmat i gårdsbutikken.",
    provider: "Eiker Gårdsysteri",
    contactEmail: "post@eikergaardsysteri.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-cheese-eiker",
      name: "Gårdsost Hokksund",
      description: "Egenprodusert ost fra 60 frittgående kyr. Gårdsbutikk i Hokksund.",
      tags: ["ost", "gårdsysteri", "hokksund", "buskerud", "frittgående"],
    }],
    role: "producer",
    location: { lat: 59.7700, lng: 9.9100, city: "Hokksund", radiusKm: 15 },
    categories: ["dairy"],
    tags: ["farm-dairy", "cheese", "free-range", "buskerud", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Eiker Hjort — Øvre Eiker",
    description: "Gård med oppdrett av hjort, alpakka og kaniner med eget godkjent slakteri. Bærekraftige animalske produkter i gårdsbutikk.",
    provider: "Eiker Hjort",
    contactEmail: "post@eikerhjort.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-venison-eiker",
      name: "Hjortekjøtt og gårdsprodukter Eiker",
      description: "Hjortekjøtt og bærekraftige kjøttprodukter. Eget slakteri.",
      tags: ["hjort", "kjøtt", "slakteri", "buskerud", "bærekraftig"],
    }],
    role: "producer",
    location: { lat: 59.7750, lng: 9.9200, city: "Øvre Eiker", radiusKm: 15 },
    categories: ["meat"],
    tags: ["venison", "deer-farm", "own-slaughterhouse", "buskerud", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Garden Oppheim — Ål, Hallingdal",
    description: "Gård i Ål kommune, Hallingdal. Tilbyr lokalt lammekjøtt i egen gårdsbutikk. Tradisjonell fjellgård.",
    provider: "Garden Oppheim",
    contactEmail: "post@gardenoppheim.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-lamb-hallingdal",
      name: "Lammekjøtt Hallingdal",
      description: "Lokalt lammekjøtt fra fjellgård i Ål, Hallingdal.",
      tags: ["lam", "kjøtt", "hallingdal", "ål", "fjellgård"],
    }],
    role: "producer",
    location: { lat: 60.6200, lng: 8.5600, city: "Ål", radiusKm: 20 },
    categories: ["meat"],
    tags: ["lamb", "mountain-farm", "hallingdal", "buskerud", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Øvrejorde Geitegård — Hovet, Hallingdal",
    description: "Geitegård i Hovet, Hallingdal. Enkel gårdsbutikk med geitost og lokale produkter. Også åpen gård for besøk.",
    provider: "Øvrejorde",
    contactEmail: "post@ovrejorde.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-goat-products-hovet",
      name: "Geitost Hallingdal",
      description: "Geitost og lokale produkter fra geitegård i Hovet, Hallingdal.",
      tags: ["geitost", "geit", "hallingdal", "hovet", "gårdsbesøk"],
    }],
    role: "producer",
    location: { lat: 60.5800, lng: 8.3000, city: "Hol", radiusKm: 20 },
    categories: ["dairy"],
    tags: ["goat-cheese", "open-farm", "hallingdal", "buskerud", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Rueslåtten Ysteri — Hol, Hallingdal",
    description: "Lite familiedrevet ysteri i Hol kommune, Hallingdal. Småskala osteproduksjon med lokal melk.",
    provider: "Rueslåtten Ysteri",
    contactEmail: "post@rueslaattenysteri.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-cheese-hol",
      name: "Håndlaget ost Hol",
      description: "Småskala ysteri i Hol kommune. Håndlaget ost fra lokal melk.",
      tags: ["ost", "ysteri", "hol", "hallingdal", "småskala"],
    }],
    role: "producer",
    location: { lat: 60.6400, lng: 8.3500, city: "Hol", radiusKm: 20 },
    categories: ["dairy"],
    tags: ["artisan-cheese", "family-dairy", "hallingdal", "buskerud", "hanen"],
  });

  marketplaceRegistry.register({
    name: "Elins Drøm — Kongsberg",
    description: "Matprodusent startet på Saatvedtgård utenfor Kongsberg. Produserer multikorn-knekkebrød med maismel, granola, juice, gløgg, konfekt og smørbrødkaker.",
    provider: "Elins Drøm",
    contactEmail: "post@elinsdrom.no",
    url: "https://www.hanen.no/utforsk/32/buskerud",
    skills: [{
      id: "sell-artisan-baked-kongsberg",
      name: "Håndlaget mat Kongsberg",
      description: "Knekkebrød, granola, juice og konfekt fra Kongsberg. Småskala produksjon.",
      tags: ["knekkebrød", "granola", "kongsberg", "håndlaget", "konfekt"],
    }],
    role: "producer",
    location: { lat: 59.6700, lng: 9.6500, city: "Kongsberg", radiusKm: 15 },
    categories: ["bread", "preserves"],
    tags: ["artisan", "bakery", "kongsberg", "buskerud", "hanen"],
  });

  // ════════════════════════════════════════════════════════════
  // B) BUSKERUD/LIER — RENSMAK-PRODUSENTER
  //    (Individual producers from Rensmak network, not yet in DB)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Lier/Drammen — Rensmak-produsenter...");

  marketplaceRegistry.register({
    name: "Grøntbua på Gilhus Gård — Lier",
    description: "Gårdsbutikk på Gilhus Gård i Lier. Selger ferske grønnsaker, frukt og lokale produkter. Del av Rensmak-nettverket.",
    provider: "Gilhus Gård",
    contactEmail: "post@gilhusgard.no",
    url: "https://rensmak.no/",
    skills: [{
      id: "sell-vegetables-lier",
      name: "Ferske grønnsaker Lier",
      description: "Ferske grønnsaker og frukt fra Gilhus Gård i Lier. Rensmak-nettverk.",
      tags: ["grønnsaker", "frukt", "lier", "gårdsbutikk", "rensmak"],
    }],
    role: "producer",
    location: { lat: 59.7800, lng: 10.2500, city: "Lier", radiusKm: 10 },
    categories: ["vegetables", "fruit"],
    tags: ["farm-shop", "lier", "rensmak", "buskerud"],
  });

  marketplaceRegistry.register({
    name: "Søndre Røine Gård — Sylling, Lier",
    description: "Gård i Øverskogen/Sylling, Lier. Selger lammekjøtt, fenalår, pinnekjøtt og spekepølser. Del av Rensmak-nettverket.",
    provider: "Søndre Røine Gård",
    contactEmail: "post@sondreroine.no",
    url: "https://rensmak.no/",
    skills: [{
      id: "sell-lamb-lier",
      name: "Lammekjøtt og spekemat Lier",
      description: "Lammekjøtt, fenalår, pinnekjøtt og spekepølser fra Sylling.",
      tags: ["lam", "kjøtt", "fenalår", "pinnekjøtt", "lier", "spekemat"],
    }],
    role: "producer",
    location: { lat: 59.8100, lng: 10.1800, city: "Lier", radiusKm: 10 },
    categories: ["meat"],
    tags: ["lamb", "cured-meat", "lier", "rensmak", "buskerud"],
  });

  marketplaceRegistry.register({
    name: "Helgerud Gård — Lier",
    description: "Lokal bonde i Lier med Charolais storfe. Selger kjøtt i stykningsdeler direkte fra gården. Del av Rensmak-nettverket.",
    provider: "Helgerud Gård",
    contactEmail: "post@helgerudgard.no",
    url: "https://rensmak.no/",
    skills: [{
      id: "sell-beef-lier",
      name: "Storfekjøtt Lier",
      description: "Charolais storfekjøtt i stykningsdeler direkte fra gården i Lier.",
      tags: ["storfe", "kjøtt", "charolais", "lier", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 59.7900, lng: 10.2300, city: "Lier", radiusKm: 10 },
    categories: ["meat"],
    tags: ["beef", "charolais", "lier", "rensmak", "farm-direct"],
  });

  marketplaceRegistry.register({
    name: "Berles Gårdsbutikk — Svelvik, Drammen",
    description: "Mangfoldig gårdsbutikk i Svelvik med interiørartikler og produkter fra frukthagene. Del av Rensmak-nettverket.",
    provider: "Berles Gårdsbutikk",
    contactEmail: "post@berlesgard.no",
    url: "https://rensmak.no/Produsenter/berles-g-rdsbutikk.html",
    skills: [{
      id: "sell-fruit-products-svelvik",
      name: "Fruktprodukter Svelvik",
      description: "Produkter fra frukthagene i Svelvik. Gårdsbutikk med variert utvalg.",
      tags: ["frukt", "svelvik", "drammen", "gårdsbutikk", "frukthage"],
    }],
    role: "producer",
    location: { lat: 59.6000, lng: 10.3300, city: "Drammen", radiusKm: 15 },
    categories: ["fruit", "preserves"],
    tags: ["fruit-orchard", "farm-shop", "svelvik", "rensmak", "drammen"],
  });

  marketplaceRegistry.register({
    name: "Solberg Gård — Filtvet",
    description: "Gård i Filtvet med hjorteoppdrett. Selger hjortekjøtt i sesong. Del av Rensmak-nettverket.",
    provider: "Solberg Gård",
    contactEmail: "post@solberggard.no",
    url: "https://rensmak.no/",
    skills: [{
      id: "sell-venison-filtvet",
      name: "Hjortekjøtt Filtvet",
      description: "Hjortekjøtt fra Filtvet, i sesong. Rensmak-nettverk.",
      tags: ["hjort", "kjøtt", "filtvet", "sesong", "rensmak"],
    }],
    role: "producer",
    location: { lat: 59.6200, lng: 10.5800, city: "Hurum", radiusKm: 15 },
    categories: ["meat"],
    tags: ["venison", "seasonal", "filtvet", "rensmak", "buskerud"],
  });

  // ════════════════════════════════════════════════════════════
  // C) BERGEN — FLERE BUTIKKER I SENTRUM
  //    (Slagplan: "Bergen: flere grønnsaksbutikker i sentrum")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Bergen — nye butikker i sentrum...");

  marketplaceRegistry.register({
    name: "Kinsarvik Naturkost — Bergen Sentrum",
    description: "Familiebedrift etablert 1928. Bredt utvalg av økologisk og allergivennlig mat, naturlig kroppspleie, kosttilskudd. Olav Kyrres gate 47, Bergen. Åpen man-fre 08-22, lør-søn 10-20.",
    provider: "Kinsarvik Naturkost AS",
    contactEmail: "sentrum@kinsarvik.no",
    url: "https://www.kinsarvik.no/pages/kinsarvik-naturkost-sentrum",
    skills: [{
      id: "sell-organic-bergen-sentrum",
      name: "Økologisk mat Bergen sentrum",
      description: "Økologisk mat og helsekost i Bergen sentrum. Etablert 1928. 9 butikker.",
      tags: ["økologisk", "bergen", "helsekost", "naturkost", "allergivennlig"],
    }],
    role: "producer",
    location: { lat: 60.3880, lng: 5.3270, city: "Bergen", radiusKm: 5 },
    categories: ["vegetables", "fruit", "dairy", "bread"],
    tags: ["organic", "health-food", "established-1928", "bergen-sentrum", "9-stores"],
  });

  // ════════════════════════════════════════════════════════════
  // D) TRONDHEIM — DELIKATESSER OG LOKAL MAT
  //    (Slagplan: "Grønnsaksbutikker i Trondheim sentrum")
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Trondheim — lokal mat og delikatesser...");

  marketplaceRegistry.register({
    name: "Bakklandet Delikatesse — Trondheim",
    description: "Delikatessebutikk på Bakklandet i Trondheim sentrum. Nedre Bakklandet 3. Spesialisert på ost, spekemat og lokale delikatesser fra Trøndelag.",
    provider: "Bakklandet Delikatesse AS",
    contactEmail: "info@bakklandetdelikatesse.no",
    url: "https://bakklandetdelikatesse.no/",
    skills: [{
      id: "sell-deli-trondheim",
      name: "Delikatesser Bakklandet Trondheim",
      description: "Ost, spekemat og lokale delikatesser fra Trøndelag. Bakklandet.",
      tags: ["ost", "spekemat", "delikatesse", "bakklandet", "trondheim"],
    }],
    role: "producer",
    location: { lat: 63.4280, lng: 10.4020, city: "Trondheim", radiusKm: 5 },
    categories: ["dairy", "meat", "preserves"],
    tags: ["deli", "bakklandet", "trondheim", "cheese", "cured-meat"],
  });

  marketplaceRegistry.register({
    name: "Dyrket.no — lokal mat-levering",
    description: "Bondens nettbutikk. Bestill fra lokale produsenter og få levert rett hjem. Frukt, grønnsaker, meieri, fisk og tørrvarer. Leverer i Oslo og Akershus.",
    provider: "Dyrket AS",
    contactEmail: "post@dyrket.no",
    url: "https://www.dyrket.no/",
    skills: [{
      id: "deliver-local-food",
      name: "Lokal mat-levering Oslo/Akershus",
      description: "Bestill fra lokale produsenter online. Levering til døren i Oslo/Akershus.",
      tags: ["levering", "nettbutikk", "lokal mat", "oslo", "produsenter"],
    }],
    role: "logistics" as any,  // delivery service
    location: { lat: 59.9139, lng: 10.7522, city: "Oslo", radiusKm: 30 },
    categories: ["vegetables", "fruit", "dairy", "fish", "meat"],
    tags: ["delivery", "online-marketplace", "farm-direct", "oslo-akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // E) KRISTIANSAND — ØKOLOGISK BUTIKK
  //    (Slagplan: utvidelse av Kristiansand-dekning)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Kristiansand — økologisk butikk...");

  marketplaceRegistry.register({
    name: "Sans & Smak — Kristiansand",
    description: "100% økologisk dagligvarebutikk i Kristiansand sentrum. Dronningens gate 20. Lokale grønnsaker, kjøtt, egg og økologiske produkter. Tlf: 38 07 18 50.",
    provider: "Sans & Smak AS",
    contactEmail: "sansogsmak@online.no",
    url: "https://kvadraturen.no/mat-drikke/sans-smak/",
    skills: [{
      id: "sell-organic-kristiansand",
      name: "Økologisk mat Kristiansand",
      description: "100% økologisk dagligvare i Kristiansand sentrum. Grønnsaker, kjøtt, egg.",
      tags: ["økologisk", "kristiansand", "dagligvare", "grønnsaker", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.1467, lng: 7.9956, city: "Kristiansand", radiusKm: 10 },
    categories: ["vegetables", "fruit", "meat", "eggs", "dairy"],
    tags: ["organic", "100-percent-organic", "kristiansand", "sentrum"],
  });

  // ════════════════════════════════════════════════════════════
  // F) FREDRIKSTAD — FRUKT OG GRØNT
  //    (Ny butikk — Bondens marked og REKO allerede i DB)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Fredrikstad — frukt og grønt...");

  marketplaceRegistry.register({
    name: "Fredrikstad Frukt og Grønt",
    description: "Frukt- og grønnsaksbutikk i Fredrikstad sentrum. Gunnar Nilsens gate 6. Stort og ferskt utvalg av frukt og grønnsaker.",
    provider: "Fredrikstad Frukt og Grønt",
    contactEmail: "post@fredrikstadfrukt.no",
    url: "https://www.fredrikstadsentrum.no/butikker/fredrikstad-frukt-og-grnt",
    skills: [{
      id: "sell-produce-fredrikstad",
      name: "Frukt og grønt Fredrikstad",
      description: "Fersk frukt og grønnsaker i Fredrikstad sentrum. Bredt utvalg.",
      tags: ["frukt", "grønnsaker", "fredrikstad", "sentrum", "fersk"],
    }],
    role: "producer",
    location: { lat: 59.2181, lng: 10.9298, city: "Fredrikstad", radiusKm: 8 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "fredrikstad", "sentrum"],
  });

  // ════════════════════════════════════════════════════════════
  // G) OSLO — SAGENE FRUKT OG GRØNT (separate from Sagene Torg)
  //    + Dagligvare Storgata already in DB, skip
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — Sagene Frukt og Grønt...");

  marketplaceRegistry.register({
    name: "Sagene Frukt og Grønt",
    description: "Spesialistbutikk for fersk frukt og grønnsaker på Sagene. Grimstadgata 24B. Nøye utvalg av sesongens beste, både økologisk og konvensjonelt. Også iskrem. Etablert 2023.",
    provider: "Sagene Frukt og Grønt ANS",
    contactEmail: "post@sagenefrukt.no",
    url: "https://www.facebook.com/people/Sagene-Frukt-og-Gr%C3%B8nt/61566178391635/",
    skills: [{
      id: "sell-produce-sagene",
      name: "Frukt og grønt Sagene",
      description: "Sesongens beste frukt og grønnsaker på Sagene. Økologisk og konvensjonelt.",
      tags: ["frukt", "grønnsaker", "sagene", "sesong", "økologisk"],
    }],
    role: "producer",
    location: { lat: 59.9370, lng: 10.7560, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["specialist", "sagene", "seasonal", "organic-options", "established-2023"],
  });

  // ════════════════════════════════════════════════════════════
  // H) BONDENS MARKED — DRAMMEN & HØNEFOSS
  //    (Bondens marked Drammen already in DB, but individual producers not)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Drammen — Bondens marked-produsenter...");

  marketplaceRegistry.register({
    name: "Bakken Øvre Gårdsmat — Drammen/Lier",
    description: "Produsent på Bondens marked Drammen. Is (i sesong), pultost og rømme, kjøttkaker og pølser, røykt skinke fra frittgående gris, sylte og smørepålegg, kalvekjøtt om våren, gårdshamburg og egg fra frittgående høner.",
    provider: "Bakken Øvre Gårdsmat",
    contactEmail: "post@bakkenovre.no",
    url: "https://bondensmarked.no/produsenter",
    skills: [{
      id: "sell-farmfood-drammen",
      name: "Gårdsmat Drammen-område",
      description: "Bredt utvalg gårdsmat: kjøtt, egg, meieri, is. Bondens marked Drammen.",
      tags: ["gårdsmat", "drammen", "kjøtt", "egg", "is", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 59.7500, lng: 10.2000, city: "Drammen", radiusKm: 15 },
    categories: ["meat", "eggs", "dairy"],
    tags: ["bondens-marked", "drammen", "free-range", "farm-food"],
  });

  marketplaceRegistry.register({
    name: "Bøhmer Småbruk — Drammen",
    description: "Småbruk i Drammen-området. Selger egg, honning og svinekjøtt på Bondens marked Drammen.",
    provider: "Bøhmer Småbruk",
    contactEmail: "post@bohmersmaabruk.no",
    url: "https://bondensmarked.no/produsenter",
    skills: [{
      id: "sell-eggs-honey-drammen",
      name: "Egg, honning og svin Drammen",
      description: "Egg, honning og svinekjøtt fra småbruk. Bondens marked Drammen.",
      tags: ["egg", "honning", "svin", "drammen", "småbruk", "bondens marked"],
    }],
    role: "producer",
    location: { lat: 59.7400, lng: 10.2200, city: "Drammen", radiusKm: 15 },
    categories: ["eggs", "honey", "meat"],
    tags: ["small-farm", "bondens-marked", "drammen", "diverse"],
  });

  marketplaceRegistry.register({
    name: "Det Gamle Røgeri — Drammen",
    description: "Produsent av røykt og gravet kjøtt- og fiskeprodukter. Selger på Bondens marked Drammen. Tradisjonell røyking.",
    provider: "Det Gamle Røgeri",
    contactEmail: "post@detgamlerogeri.no",
    url: "https://bondensmarked.no/produsenter",
    skills: [{
      id: "sell-smoked-fish-drammen",
      name: "Røykt og gravet mat Drammen",
      description: "Tradisjonelt røykte og gravede kjøtt- og fiskeprodukter. Bondens marked Drammen.",
      tags: ["røykt", "gravet", "fisk", "kjøtt", "drammen", "tradisjonell"],
    }],
    role: "producer",
    location: { lat: 59.7440, lng: 10.2050, city: "Drammen", radiusKm: 15 },
    categories: ["fish", "meat"],
    tags: ["smoked", "cured", "traditional", "bondens-marked", "drammen"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Hønefoss",
    description: "Bondens marked i Hønefoss, Ringerike. Lokalprodusert mat fra Buskerud-bønder. Arrangeres flere lørdager gjennom sesongen.",
    provider: "Bondens Marked Hønefoss",
    contactEmail: "honefoss@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-honefoss",
      name: "Bondens marked Hønefoss",
      description: "Lokalprodusert mat fra Buskerud-bønder i Hønefoss sentrum.",
      tags: ["bondens marked", "hønefoss", "ringerike", "buskerud", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 60.1700, lng: 10.2600, city: "Hønefoss", radiusKm: 15 },
    categories: ["vegetables", "fruit", "meat", "dairy", "bread", "honey"],
    tags: ["farmers-market", "hønefoss", "ringerike", "buskerud", "seasonal"],
  });

  // ════════════════════════════════════════════════════════════
  // I) BONDENS MARKED — NYE LOKASJONER FRA bondensmarked.no
  //    (Mangler: Budor, Sundvolden, Evje, Kvinesdal, Bortelid)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye Bondens marked-lokasjoner...");

  marketplaceRegistry.register({
    name: "Bondens Marked Sundvolden",
    description: "Bondens marked på Sundvolden, Ringerike. Lokale produsenter fra Buskerud-regionen.",
    provider: "Bondens Marked Sundvolden",
    contactEmail: "sundvolden@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-sundvolden",
      name: "Bondens marked Sundvolden",
      description: "Lokal mat fra Buskerud-produsenter på Sundvolden.",
      tags: ["bondens marked", "sundvolden", "ringerike", "buskerud"],
    }],
    role: "producer",
    location: { lat: 60.1500, lng: 10.1200, city: "Sundvolden", radiusKm: 15 },
    categories: ["vegetables", "fruit", "meat", "dairy"],
    tags: ["farmers-market", "sundvolden", "ringerike"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Evje",
    description: "Bondens marked i Evje, Agder. Lokalprodusert mat fra Setesdal og Agder.",
    provider: "Bondens Marked Evje",
    contactEmail: "evje@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-evje",
      name: "Bondens marked Evje",
      description: "Lokal mat fra Setesdal og Agder-produsenter i Evje.",
      tags: ["bondens marked", "evje", "setesdal", "agder"],
    }],
    role: "producer",
    location: { lat: 58.5900, lng: 7.8100, city: "Evje", radiusKm: 20 },
    categories: ["vegetables", "fruit", "meat", "dairy", "honey"],
    tags: ["farmers-market", "evje", "setesdal", "agder"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Kvinesdal",
    description: "Bondens marked i Kvinesdal, Agder. Lokale matprodusenter fra Kvinesdal og omegn.",
    provider: "Bondens Marked Kvinesdal",
    contactEmail: "kvinesdal@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager",
    skills: [{
      id: "farmers-market-kvinesdal",
      name: "Bondens marked Kvinesdal",
      description: "Lokal mat fra produsenter i Kvinesdal og Agder.",
      tags: ["bondens marked", "kvinesdal", "agder"],
    }],
    role: "producer",
    location: { lat: 58.3100, lng: 6.9700, city: "Kvinesdal", radiusKm: 20 },
    categories: ["vegetables", "fruit", "meat", "dairy"],
    tags: ["farmers-market", "kvinesdal", "agder"],
  });

  // ════════════════════════════════════════════════════════════
  // J) REKO-RINGER — NYE BYER (mangler fra oversikten)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Nye REKO-ringer...");

  marketplaceRegistry.register({
    name: "REKO-ringen Kongsberg",
    description: "REKO-ring for Kongsberg og omegn. Direktesalg av lokal mat fra produsent til forbruker via Facebook. Forhåndsbestilling.",
    provider: "REKO Kongsberg",
    contactEmail: "reko.kongsberg@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-kongsberg",
      name: "REKO Kongsberg",
      description: "Direktesalg lokal mat i Kongsberg. Bestill via Facebook, hent på avtalt sted.",
      tags: ["reko", "kongsberg", "buskerud", "direktesalg", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.6700, lng: 9.6500, city: "Kongsberg", radiusKm: 20 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "bread", "honey"],
    tags: ["reko-ring", "kongsberg", "buskerud", "facebook-ordering"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Modum/Sigdal",
    description: "REKO-ring for Modum og Sigdal i Buskerud. Lokal mat direkte fra bønder og produsenter.",
    provider: "REKO Modum/Sigdal",
    contactEmail: "reko.modum@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-modum",
      name: "REKO Modum/Sigdal",
      description: "Direktesalg lokal mat i Modum/Sigdal. Buskerud-produsenter.",
      tags: ["reko", "modum", "sigdal", "buskerud", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 59.8300, lng: 9.9800, city: "Modum", radiusKm: 20 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "bread", "honey"],
    tags: ["reko-ring", "modum", "sigdal", "buskerud"],
  });

  marketplaceRegistry.register({
    name: "REKO-ringen Hønefoss",
    description: "REKO-ring for Hønefoss og Ringerike. Lokal mat fra Buskerud-produsenter direkte til forbruker.",
    provider: "REKO Hønefoss",
    contactEmail: "reko.honefoss@rekonorge.no",
    url: "https://www.rekonorge.no/finn-din-rekoring",
    skills: [{
      id: "reko-honefoss",
      name: "REKO Hønefoss",
      description: "Direktesalg lokal mat i Hønefoss/Ringerike. Buskerud-produsenter.",
      tags: ["reko", "hønefoss", "ringerike", "buskerud", "direktesalg"],
    }],
    role: "producer",
    location: { lat: 60.1700, lng: 10.2600, city: "Hønefoss", radiusKm: 20 },
    categories: ["vegetables", "fruit", "meat", "dairy", "eggs", "bread", "honey"],
    tags: ["reko-ring", "hønefoss", "ringerike", "buskerud"],
  });

  const newCount = marketplaceRegistry.getActiveAgents().length - existing.length;
  console.log(`\n✅ Expansion v6 complete — ${newCount} new agents added.`);
  console.log(`   Total agents now: ${marketplaceRegistry.getActiveAgents().length}\n`);
}
