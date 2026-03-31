import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Norway Database Expansion v3 ───────────────────────────
// Researched 2026-03-31. Sources: rekonorge.no, bondensmarked.no,
// hanen.no, yelp.com, gulesider.no, lokalmatringen.no, iharstad.no,
// statsforvalteren.no, spiselig.info, bergvang.no, matrikevestfold.no,
// visitgreateroslo.com, baerumsverk.no, oslo.kommune.no
//
// This file extends the database with:
//   A) Oslo area — More grocery/fruit shops (Ege Frukt, Oppsal Torg,
//      Izmir Import, Vibes Frukt, Adamstuen Torg, Torshov Frukt)
//   B) Oslo area — More gårdsbutikker (Bergvang Asker, Sem Gård)
//   C) Oslo area — More Bondens marked locations (Asker, Kolbotn,
//      Bærums Verk, Eidsvoll, Årnes, Bogstadveien)
//   D) Arendal — REKO + Bondens marked
//   E) Larvik — REKO + Bondens marked
//   F) Sandefjord — REKO + Bondens marked
//   G) Molde — REKO
//   H) Kristiansund — REKO + Bondens marked
//   I) Narvik — REKO
//   J) Harstad — REKO
//   K) Vesterålen — REKO
//   L) REKO Horten (Vestfold)
//   M) REKO Sandvika (Bærum)

export function seedExpansionV3() {
  // Idempotent: check if v3 expansion has already run
  const existing = marketplaceRegistry.getActiveAgents();
  const hasV3 = existing.some(
    (a: any) => a.name === "REKO-ringen Arendal" || a.name === "Ege Frukt og Grønt"
  );
  if (hasV3) {
    console.log(`🇳🇴 Expansion v3 already loaded — skipping.\n`);
    return;
  }

  console.log("🇳🇴 Seeding Norway expansion v3 database...\n");

  // ════════════════════════════════════════════════════════════
  // A) OSLO — MORE GROCERY / FRUIT & VEG SHOPS
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo — flere grønnsaksbutikker...");

  marketplaceRegistry.register({
    name: "Ege Frukt og Grønt",
    description: "Frukt- og grøntbutikk på Carl Berners plass. Stort utvalg ferske frukter og grønnsaker. Godt renommé i nabolaget.",
    provider: "Ege Frukt DA",
    contactEmail: "post@egefrukt.no",
    url: "https://www.facebook.com/p/Ege-Frukt-100057210230469/",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt Carl Berner",
      description: "Bredt utvalg frukt og grønnsaker på Carl Berners plass.",
      tags: ["grønnsaker", "frukt", "carl berner", "fersk", "lokal"],
    }],
    role: "producer",
    location: { lat: 59.9270, lng: 10.7740, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "carl-berner"],
  });

  marketplaceRegistry.register({
    name: "Oppsal Torg Frukt og Grønt",
    description: "Frukt- og grøntbutikk på Oppsal Torg. Internasjonalt utvalg og lokale produkter. Godt utvalg til gode priser.",
    provider: "Oppsal Torg Frukt og Grønt",
    contactEmail: "post@oppsaltorgfrukt.no",
    url: "https://www.yelp.com/biz/oppsal-torg-frukt-og-gr%C3%B8nt-oslo",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt Oppsal",
      description: "Bredt utvalg frukt og grønnsaker på Oppsal Torg.",
      tags: ["grønnsaker", "frukt", "oppsal", "internasjonalt", "fersk"],
    }],
    role: "producer",
    location: { lat: 59.8930, lng: 10.8280, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "oppsal", "international"],
  });

  marketplaceRegistry.register({
    name: "Izmir Import — Frukt og Grønt",
    description: "Frukt, grønt og importvarer på Grønland. Bredt utvalg av friske grønnsaker, urter og krydder fra Midtøsten og Middelhavet.",
    provider: "Izmir Import",
    contactEmail: "post@izmirimport.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Gr%C3%B8nland,+Oslo",
    skills: [{
      id: "sell-produce-international",
      name: "Internasjonalt frukt og grønt",
      description: "Import-frukt og grønnsaker, urter og krydder. Midtøsten og Middelhavsmat.",
      tags: ["grønnsaker", "frukt", "import", "urter", "krydder", "grønland"],
    }],
    role: "producer",
    location: { lat: 59.9120, lng: 10.7600, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit", "herbs"],
    tags: ["international", "middle-eastern", "daily-fresh", "grønland"],
  });

  marketplaceRegistry.register({
    name: "Vibes Frukt og Grønt",
    description: "Frukt- og grøntbutikk i St. Hanshaugen-området, Oslo. Kvalitetsutvalg av ferske frukter og grønnsaker.",
    provider: "Vibes Frukt og Grønt",
    contactEmail: "post@vibesfrukt.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=St.+Hanshaugen,+Oslo",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt St. Hanshaugen",
      description: "Fersk frukt og grønnsaker i St. Hanshaugen-området.",
      tags: ["grønnsaker", "frukt", "st. hanshaugen", "fersk", "kvalitet"],
    }],
    role: "producer",
    location: { lat: 59.9290, lng: 10.7430, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "st-hanshaugen"],
  });

  marketplaceRegistry.register({
    name: "Adamstuen Torg",
    description: "Frukt- og grøntbutikk på Adamstuen nær Majorstuen. Ferske varer daglig, godt utvalg.",
    provider: "Adamstuen Torg",
    contactEmail: "post@adamstuemtorg.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Majorstuen,+Oslo",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt Adamstuen",
      description: "Fersk frukt og grønnsaker på Adamstuen nær Majorstuen.",
      tags: ["grønnsaker", "frukt", "adamstuen", "majorstuen", "fersk"],
    }],
    role: "producer",
    location: { lat: 59.9310, lng: 10.7280, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "adamstuen", "majorstuen"],
  });

  marketplaceRegistry.register({
    name: "Torshov Frukt og Grønt",
    description: "Frukt- og grøntbutikk på Torshov, Oslo. Godt utvalg og ferske produkter til nabolaget.",
    provider: "Torshov Frukt og Grønt",
    contactEmail: "post@torshovfrukt.no",
    url: "https://www.gulesider.no/frukt+og+gr%C3%B8nt+oslo+sagene/bedrifter",
    skills: [{
      id: "sell-produce",
      name: "Frukt og grønt Torshov",
      description: "Fersk frukt og grønnsaker på Torshov.",
      tags: ["grønnsaker", "frukt", "torshov", "fersk", "nabolag"],
    }],
    role: "producer",
    location: { lat: 59.9350, lng: 10.7600, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit"],
    tags: ["daily-fresh", "neighborhood", "torshov"],
  });

  marketplaceRegistry.register({
    name: "Mevlana Grønland",
    description: "Tyrkisk/internasjonal dagligvare og frukt/grønt på Grønland. Bredt utvalg av friske grønnsaker, brød, oliven og spesialvarer.",
    provider: "Mevlana",
    contactEmail: "post@mevlana.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Gr%C3%B8nland,+Oslo",
    skills: [{
      id: "sell-produce-turkish",
      name: "Tyrkisk/internasjonal mat og grønt",
      description: "Tyrkiske og internasjonale grønnsaker, brød, oliven og spesialvarer.",
      tags: ["grønnsaker", "frukt", "tyrkisk", "internasjonal", "grønland"],
    }],
    role: "producer",
    location: { lat: 59.9115, lng: 10.7590, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit", "bread"],
    tags: ["international", "turkish", "daily-fresh", "grønland", "specialty"],
  });

  marketplaceRegistry.register({
    name: "Rayan Mat — Grønland",
    description: "Dagligvarebutikk på Grønland med stort utvalg av frukt, grønnsaker og internasjonale matvarer. Gode priser.",
    provider: "Rayan Mat",
    contactEmail: "post@rayanmat.no",
    url: "https://www.yelp.com/search?find_desc=Frukt+Og+Gr%C3%B8nnsaker&find_loc=Gr%C3%B8nland,+Oslo",
    skills: [{
      id: "sell-produce-grocery",
      name: "Dagligvare og frukt/grønt",
      description: "Bredt utvalg frukt, grønnsaker og internasjonale matvarer. Gode priser.",
      tags: ["grønnsaker", "frukt", "dagligvare", "rimelig", "grønland"],
    }],
    role: "producer",
    location: { lat: 59.9125, lng: 10.7610, city: "Oslo", radiusKm: 2 },
    categories: ["vegetables", "fruit"],
    tags: ["budget", "international", "daily-fresh", "grønland"],
  });

  // ════════════════════════════════════════════════════════════
  // B) OSLO AREA — MORE GÅRDSBUTIKKER
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo-området — flere gårdsbutikker...");

  marketplaceRegistry.register({
    name: "Bergvang Gård (Asker)",
    description: "Gårdsbutikk og besøksgård ved Semsvannet i Asker. Highland cattle, alpakaer, hester, griser, bikuber. Gårdsbutikk/kafé lør-søn 10-15 hele året. Egg, kjøtt fra egne dyr, honning fra Bergvang-bier, garn fra alpakka og sau.",
    provider: "Bergvang",
    contactEmail: "post@bergvang.no",
    url: "https://bergvang.no",
    skills: [{
      id: "sell-farm-products-visit",
      name: "Gårdsprodukter og besøksgård",
      description: "Egg, kjøtt, honning, garn fra alpakaer. Gårdsbutikk og kafé. Åpent hele året lør-søn.",
      tags: ["gårdsbutikk", "besøksgård", "egg", "kjøtt", "honning", "alpakka", "asker"],
    }],
    role: "producer",
    location: { lat: 59.8350, lng: 10.4400, city: "Asker", radiusKm: 15 },
    categories: ["eggs", "meat", "honey"],
    tags: ["farm-shop", "visitor-farm", "year-round", "weekend", "asker", "family-friendly"],
  });

  marketplaceRegistry.register({
    name: "Sem Gjestegård (Asker)",
    description: "Historisk gård og gjestegård i Asker med gårdsutsalg av lokale produkter. Kurs og arrangementer.",
    provider: "Sem Gjestegård",
    contactEmail: "post@semgjestegard.no",
    url: "https://www.hanen.no/bedrift/fylke/akershus",
    skills: [{
      id: "sell-farm-products",
      name: "Gårdsprodukter Sem",
      description: "Lokale produkter fra historisk gård i Asker. Kurs og arrangementer.",
      tags: ["gård", "historisk", "asker", "lokalt", "arrangement"],
    }],
    role: "producer",
    location: { lat: 59.8350, lng: 10.4500, city: "Asker", radiusKm: 15 },
    categories: ["vegetables", "preserves"],
    tags: ["farm-shop", "historic", "asker", "events"],
  });

  // ════════════════════════════════════════════════════════════
  // C) OSLO AREA — MORE BONDENS MARKED LOCATIONS
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Oslo-omegn — flere Bondens marked lokasjoner...");

  marketplaceRegistry.register({
    name: "Bondens Marked Asker",
    description: "Bondens marked i Asker sentrum. Lokalprodusert mat fra bønder i Asker og omegn.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Asker",
      description: "Lokalprodusert mat i Asker sentrum. Grønnsaker, ost, kjøtt, honning.",
      tags: ["bondens marked", "asker", "lokal mat", "lørdag"],
    }],
    role: "producer",
    location: { lat: 59.8333, lng: 10.4350, city: "Asker", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "asker", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Kolbotn",
    description: "Bondens marked på Kolbotn torg. Lokalprodusert mat fra Follo-bønder.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Kolbotn",
      description: "Lokalprodusert mat på Kolbotn. Grønnsaker, ost, kjøtt, honning fra Follo.",
      tags: ["bondens marked", "kolbotn", "follo", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.8120, lng: 10.8010, city: "Kolbotn", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "follo", "kolbotn"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Bærums Verk",
    description: "Bondens marked på Bærums Verk. Lokalprodusert mat i sjarmerende omgivelser. Populært helgearrangement.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://baerumsverk.no/bondens-marked-2025/",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Bærums Verk",
      description: "Lokalprodusert mat på Bærums Verk. Sjarmerende marked med kvalitetsprodukter.",
      tags: ["bondens marked", "bærum", "bærums verk", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.8920, lng: 10.5100, city: "Bærum", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "bærum", "charming"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Eidsvoll",
    description: "Bondens marked i Eidsvoll. Lokalprodusert mat fra bønder i Romerike og Eidsvoll-regionen.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Eidsvoll",
      description: "Lokalprodusert mat i Eidsvoll. Romerike-bønder.",
      tags: ["bondens marked", "eidsvoll", "romerike", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 60.3268, lng: 11.2628, city: "Eidsvoll", radiusKm: 15 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "romerike", "eidsvoll"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Årnes",
    description: "Bondens marked i Årnes, Nes kommune. Lokalprodusert mat fra Romerike-bønder.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Årnes",
      description: "Lokalprodusert mat i Årnes. Romerike-bønder med kjøtt, egg, grønnsaker.",
      tags: ["bondens marked", "årnes", "nes", "romerike", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 60.1250, lng: 11.4480, city: "Årnes", radiusKm: 15 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread", "eggs"],
    tags: ["farmers-market", "weekend", "romerike", "årnes"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Bogstadveien (Oslo)",
    description: "Bondens marked på Bogstadveien i Oslo vest. Populært marked med lokalprodusert mat nær Majorstuen.",
    provider: "Bondens Marked Oslo SA",
    contactEmail: "oslo@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Bogstadveien",
      description: "Lokalprodusert mat på Bogstadveien. Populært helgemarked.",
      tags: ["bondens marked", "bogstadveien", "majorstuen", "oslo vest"],
    }],
    role: "producer",
    location: { lat: 59.9290, lng: 10.7180, city: "Oslo", radiusKm: 3 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "oslo-west", "bogstadveien", "popular"],
  });

  // ════════════════════════════════════════════════════════════
  // D) ARENDAL
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Arendal...");

  marketplaceRegistry.register({
    name: "REKO-ringen Arendal",
    description: "REKO-ring i Arendal, Agder. Lokalmat direkte fra produsent. Bestilling via Facebook, henting annenhver torsdag kl 19-19:30.",
    provider: "REKO Arendal",
    contactEmail: "reko.arendal@gmail.com",
    url: "https://www.facebook.com/groups/rekoarendal",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Arendal",
      description: "Forhåndsbestilt lokalmat fra Agder-produsenter. Henting annenhver torsdag.",
      tags: ["reko", "utlevering", "arendal", "agder", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 58.4615, lng: 8.7722, city: "Arendal", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "agder", "biweekly", "thursday"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Arendal",
    description: "Bondens marked på Torvgaten i Arendal. Lokalprodusert mat fra Agder-bønder. Sesongbasert.",
    provider: "Bondens Marked Agder",
    contactEmail: "agder@bondensmarked.no",
    url: "https://bondensmarked.no/markedsdag/2025-06-28-torvgaten-arendal-3209",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Arendal",
      description: "Lokalprodusert mat fra Agder. Grønnsaker, kjøtt, ost, honning, brød.",
      tags: ["bondens marked", "arendal", "agder", "torvgaten", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.4615, lng: 8.7722, city: "Arendal", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "agder", "seasonal"],
  });

  // ════════════════════════════════════════════════════════════
  // E) LARVIK
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Larvik...");

  marketplaceRegistry.register({
    name: "REKO-ringen Larvik",
    description: "REKO-ring i Larvik, Vestfold. Lokalmat direkte fra produsent. Forhåndsbestilling via Facebook.",
    provider: "REKO Larvik",
    contactEmail: "reko.larvik@gmail.com",
    url: "https://www.facebook.com/groups/rekolarvik",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Larvik",
      description: "Forhåndsbestilt lokalmat fra Vestfold-produsenter. Henting i Larvik.",
      tags: ["reko", "utlevering", "larvik", "vestfold", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.0530, lng: 10.0345, city: "Larvik", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "vestfold", "community"],
  });

  // ════════════════════════════════════════════════════════════
  // F) SANDEFJORD
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Sandefjord...");

  marketplaceRegistry.register({
    name: "REKO-ringen Sandefjord",
    description: "REKO-ring i Sandefjord, Vestfold. Lokalmat direkte fra produsent. Forhåndsbestilling via Facebook.",
    provider: "REKO Sandefjord",
    contactEmail: "reko.sandefjord@gmail.com",
    url: "https://www.facebook.com/groups/rekosandefjord",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Sandefjord",
      description: "Forhåndsbestilt lokalmat fra Vestfold-produsenter. Henting i Sandefjord.",
      tags: ["reko", "utlevering", "sandefjord", "vestfold", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.1318, lng: 10.2266, city: "Sandefjord", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "vestfold", "community"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Sandefjord",
    description: "Bondens marked på Sandefjord Torv. Lokalprodusert mat fra Vestfold-bønder.",
    provider: "Bondens Marked Vestfold",
    contactEmail: "vestfold@bondensmarked.no",
    url: "https://www.facebook.com/events/sandefjord-torv/bondens-marked-i-sandefjord/318804579594825/",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Sandefjord",
      description: "Lokalprodusert mat fra Vestfold. Grønnsaker, kjøtt, ost, honning.",
      tags: ["bondens marked", "sandefjord", "vestfold", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 59.1318, lng: 10.2266, city: "Sandefjord", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "vestfold", "seasonal"],
  });

  // ════════════════════════════════════════════════════════════
  // G) MOLDE
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Molde...");

  marketplaceRegistry.register({
    name: "REKO-ringen Molde",
    description: "REKO-ring i Molde, Møre og Romsdal. Lokalmat fra produsenter i Romsdal. Forhåndsbestilling via Facebook.",
    provider: "REKO Molde",
    contactEmail: "reko.molde@gmail.com",
    url: "https://www.facebook.com/groups/rekomolde",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Molde",
      description: "Forhåndsbestilt lokalmat fra Romsdal-produsenter. Henting i Molde.",
      tags: ["reko", "utlevering", "molde", "romsdal", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 62.7375, lng: 7.1591, city: "Molde", radiusKm: 20 },
    categories: ["vegetables", "eggs", "meat", "fish", "bread"],
    tags: ["reko", "direct-sale", "romsdal", "møre-og-romsdal"],
  });

  // ════════════════════════════════════════════════════════════
  // H) KRISTIANSUND
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Kristiansund...");

  marketplaceRegistry.register({
    name: "REKO-ringen Kristiansund",
    description: "REKO-ring i Kristiansund, Møre og Romsdal. Lokalmat fra produsenter i Nordmøre. Forhåndsbestilling via Facebook.",
    provider: "REKO Kristiansund",
    contactEmail: "reko.kristiansund@gmail.com",
    url: "https://www.facebook.com/groups/rekokristiansund",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Kristiansund",
      description: "Forhåndsbestilt lokalmat fra Nordmøre-produsenter. Henting i Kristiansund.",
      tags: ["reko", "utlevering", "kristiansund", "nordmøre", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 63.1103, lng: 7.7280, city: "Kristiansund", radiusKm: 20 },
    categories: ["vegetables", "eggs", "meat", "fish", "bread"],
    tags: ["reko", "direct-sale", "nordmøre", "møre-og-romsdal"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Kristiansund",
    description: "Bondens marked i Kristiansund. Lokalprodusert mat fra Nordmøre-bønder.",
    provider: "Bondens Marked Nordmøre",
    contactEmail: "nordmore@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Kristiansund",
      description: "Lokalprodusert mat fra Nordmøre. Fisk, kjøtt, grønnsaker.",
      tags: ["bondens marked", "kristiansund", "nordmøre", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 63.1103, lng: 7.7280, city: "Kristiansund", radiusKm: 15 },
    categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
    tags: ["farmers-market", "weekend", "nordmøre", "seasonal"],
  });

  // ════════════════════════════════════════════════════════════
  // I) NARVIK
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Narvik...");

  marketplaceRegistry.register({
    name: "REKO-ringen Narvik",
    description: "REKO-ring i Narvik, Nordland. Arktisk lokalmat fra produsenter i Ofoten-regionen. Forhåndsbestilling via Facebook.",
    provider: "REKO Narvik",
    contactEmail: "reko.narvik@gmail.com",
    url: "https://www.facebook.com/groups/rekonarvik",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Narvik",
      description: "Forhåndsbestilt arktisk lokalmat fra Ofoten-produsenter. Henting i Narvik.",
      tags: ["reko", "utlevering", "narvik", "ofoten", "nordland", "arktisk"],
    }],
    role: "producer",
    location: { lat: 68.4385, lng: 17.4272, city: "Narvik", radiusKm: 25 },
    categories: ["vegetables", "eggs", "meat", "fish", "bread"],
    tags: ["reko", "direct-sale", "arctic", "ofoten", "nordland"],
  });

  // ════════════════════════════════════════════════════════════
  // J) HARSTAD
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Harstad...");

  marketplaceRegistry.register({
    name: "REKO-ringen Harstad",
    description: "REKO-ring i Harstad, Troms. Startet under pandemien i 2020. Lokalmat fra produsenter i Sør-Troms. Forhåndsbestilling via Facebook.",
    provider: "REKO Harstad",
    contactEmail: "reko.harstad@gmail.com",
    url: "https://www.facebook.com/groups/rekoharstad",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Harstad",
      description: "Forhåndsbestilt lokalmat fra Sør-Troms-produsenter. Henting i Harstad.",
      tags: ["reko", "utlevering", "harstad", "troms", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 68.7984, lng: 16.5415, city: "Harstad", radiusKm: 25 },
    categories: ["vegetables", "eggs", "meat", "fish"],
    tags: ["reko", "direct-sale", "troms", "arctic", "pandemic-start"],
  });

  // ════════════════════════════════════════════════════════════
  // K) VESTERÅLEN
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Vesterålen...");

  marketplaceRegistry.register({
    name: "REKO-ringen Vesterålen",
    description: "REKO-ring i Vesterålen, Nordland. Arktisk lokalmat fra øyene. Forhåndsbestilling via Facebook.",
    provider: "REKO Vesterålen",
    contactEmail: "reko.vesteraalen@gmail.com",
    url: "https://www.facebook.com/groups/rekovesteraalen",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Vesterålen",
      description: "Forhåndsbestilt arktisk lokalmat fra Vesterålen-produsenter.",
      tags: ["reko", "utlevering", "vesterålen", "nordland", "arktisk"],
    }],
    role: "producer",
    location: { lat: 68.7500, lng: 15.4500, city: "Sortland", radiusKm: 40 },
    categories: ["vegetables", "eggs", "meat", "fish"],
    tags: ["reko", "direct-sale", "arctic", "vesterålen", "island"],
  });

  // ════════════════════════════════════════════════════════════
  // L) REKO HORTEN (Vestfold — gap)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Horten...");

  marketplaceRegistry.register({
    name: "REKO-ringen Horten",
    description: "REKO-ring i Horten, Vestfold. Lokalmat fra Vestfold-produsenter. Forhåndsbestilling via Facebook.",
    provider: "REKO Horten",
    contactEmail: "reko.horten@gmail.com",
    url: "https://www.facebook.com/groups/rekohorten",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Horten",
      description: "Forhåndsbestilt lokalmat fra Vestfold-produsenter. Henting i Horten.",
      tags: ["reko", "utlevering", "horten", "vestfold", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.4172, lng: 10.4849, city: "Horten", radiusKm: 15 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "vestfold", "community"],
  });

  // ════════════════════════════════════════════════════════════
  // M) REKO SANDVIKA (Bærum — gap)
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Sandvika...");

  marketplaceRegistry.register({
    name: "REKO-ringen Sandvika/Bærum",
    description: "REKO-ring i Sandvika, Bærum. Lokalmat fra produsenter i Asker og Bærum-regionen. Forhåndsbestilling via Facebook.",
    provider: "REKO Sandvika",
    contactEmail: "reko.sandvika@gmail.com",
    url: "https://www.facebook.com/groups/rekosandvika",
    skills: [{
      id: "reko-pickup",
      name: "REKO-utlevering Sandvika",
      description: "Forhåndsbestilt lokalmat fra Asker/Bærum-produsenter. Henting i Sandvika.",
      tags: ["reko", "utlevering", "sandvika", "bærum", "lokalmat"],
    }],
    role: "producer",
    location: { lat: 59.8872, lng: 10.5260, city: "Bærum", radiusKm: 10 },
    categories: ["vegetables", "eggs", "meat", "honey", "bread"],
    tags: ["reko", "direct-sale", "bærum", "akershus"],
  });

  // ════════════════════════════════════════════════════════════
  // N) Bondens Marked — additional cities from research
  // ════════════════════════════════════════════════════════════
  console.log("   📍 Flere Bondens marked byer...");

  marketplaceRegistry.register({
    name: "Bondens Marked Norheimsund (Hardanger)",
    description: "Bondens marked i Norheimsund, Hardanger. Lokalprodusert mat fra Hardanger-bønder. Frukt, bær, sider og tradisjonelle varer.",
    provider: "Bondens Marked Vestland",
    contactEmail: "vestland@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Norheimsund",
      description: "Lokalprodusert mat fra Hardanger. Frukt, bær, sider, kjøtt.",
      tags: ["bondens marked", "norheimsund", "hardanger", "frukt", "sider"],
    }],
    role: "producer",
    location: { lat: 60.3744, lng: 6.1436, city: "Norheimsund", radiusKm: 20 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey"],
    tags: ["farmers-market", "weekend", "hardanger", "cider", "traditional"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Grimstad",
    description: "Bondens marked i Grimstad, Agder. Lokalprodusert mat fra Agder-bønder.",
    provider: "Bondens Marked Agder",
    contactEmail: "agder@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Grimstad",
      description: "Lokalprodusert mat fra Agder. Grønnsaker, bær, kjøtt.",
      tags: ["bondens marked", "grimstad", "agder", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.3405, lng: 8.5932, city: "Grimstad", radiusKm: 10 },
    categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "agder", "seasonal"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Tvedestrand",
    description: "Bondens marked i Tvedestrand, Agder. Lokalprodusert mat fra kystbønder i Agder.",
    provider: "Bondens Marked Agder",
    contactEmail: "agder@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Tvedestrand",
      description: "Lokalprodusert mat fra Agder-kysten. Sjømat, grønnsaker.",
      tags: ["bondens marked", "tvedestrand", "agder", "kyst", "lokal mat"],
    }],
    role: "producer",
    location: { lat: 58.6188, lng: 8.9346, city: "Tvedestrand", radiusKm: 10 },
    categories: ["vegetables", "fruit", "fish", "meat", "honey"],
    tags: ["farmers-market", "weekend", "agder", "coastal"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Elverum",
    description: "Bondens marked i Elverum, Innlandet. Lokalprodusert mat fra Østerdalen-bønder.",
    provider: "Bondens Marked Innlandet",
    contactEmail: "innlandet@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Elverum",
      description: "Lokalprodusert mat fra Østerdalen. Vilt, kjøtt, grønnsaker.",
      tags: ["bondens marked", "elverum", "østerdalen", "innlandet"],
    }],
    role: "producer",
    location: { lat: 60.8818, lng: 11.5637, city: "Elverum", radiusKm: 15 },
    categories: ["vegetables", "meat", "dairy", "honey", "bread"],
    tags: ["farmers-market", "weekend", "innlandet", "østerdalen"],
  });

  marketplaceRegistry.register({
    name: "Bondens Marked Ålgård (Rogaland)",
    description: "Bondens marked i Ålgård, Gjesdal kommune. Lokalprodusert mat fra Rogaland-bønder.",
    provider: "Bondens Marked Rogaland",
    contactEmail: "rogaland@bondensmarked.no",
    url: "https://bondensmarked.no/markeder",
    skills: [{
      id: "farmers-market",
      name: "Bondens marked Ålgård",
      description: "Lokalprodusert mat fra Rogaland. Kjøtt, ost, grønnsaker.",
      tags: ["bondens marked", "ålgård", "gjesdal", "rogaland"],
    }],
    role: "producer",
    location: { lat: 58.7630, lng: 5.8500, city: "Ålgård", radiusKm: 15 },
    categories: ["vegetables", "dairy", "meat", "honey", "bread"],
    tags: ["farmers-market", "weekend", "rogaland", "gjesdal"],
  });

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════
  const stats = marketplaceRegistry.getStats();
  console.log(`\n   ✅ Expansion v3 loaded:`);
  console.log(`      ${stats.totalAgents} agents total (across all seeds)`);
  console.log(`      ${stats.activeProducers} producers`);
  console.log(`      Cities: ${stats.cities.join(", ")}`);
  console.log(`\n   New in v3:`);
  console.log(`   Oslo: 8 nye grønnsaksbutikker, 2 gårdsbutikker, 6 Bondens marked lok.`);
  console.log(`   Nye byer: Arendal, Larvik, Sandefjord, Molde, Kristiansund,`);
  console.log(`   Narvik, Harstad, Vesterålen, Horten, Sandvika/Bærum`);
  console.log(`   Flere Bondens marked: Norheimsund, Grimstad, Tvedestrand, Elverum, Ålgård\n`);
}
