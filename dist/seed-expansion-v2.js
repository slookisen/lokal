"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedExpansionV2 = seedExpansionV2;
const marketplace_registry_1 = require("./services/marketplace-registry");
// ─── Norway Database Expansion v2 ───────────────────────────
// Researched 2026-03-31. Sources: rekonorge.no, bondensmarked.no,
// hanen.no, visitnorway.no, matrikevestfold.no, bymoss.no,
// statsforvalteren.no, lystgarden.no, godtlokalt.no, matarena.no,
// ibodoby.no, visitgreateroslo.com, aktivioslo.no, an.no
//
// This file extends the database with:
//   A) Bodø — REKO, Bondens marked Nordland
//   B) Ålesund — REKO Ålesund/Digerneset, Bondens marked
//   C) Haugesund — REKO Haugalandet, Bondens marked
//   D) Tønsberg — REKO Vestfold, Bondens marked, gårdsbutikker
//   E) Skien/Porsgrunn — REKO Grenland, Bondens marked Telemark
//   F) Hamar — REKO Hamar, Bondens marked Innlandet
//   G) Moss — REKO Moss, lokale produsenter
//   H) Sarpsborg — REKO, gårdsbutikker Østfold
//   I) Additional Bergen producers
//   J) Additional Stavanger/Rogaland producers
//   K) Additional Oslo-area producers (Follo, Romerike)
//   L) Lillehammer — REKO, Bondens marked
//   M) Kongsberg — REKO, Bondens marked
function seedExpansionV2() {
    // Idempotent: check if v2 expansion has already run
    const existing = marketplace_registry_1.marketplaceRegistry.getActiveAgents();
    const hasV2 = existing.some((a) => a.name === "REKO-ringen Bodø" || a.name === "REKO-ringen Haugalandet");
    if (hasV2) {
        console.log(`🇳🇴 Expansion v2 already loaded — skipping.\n`);
        return;
    }
    console.log("🇳🇴 Seeding Norway expansion v2 database...\n");
    // ════════════════════════════════════════════════════════════
    // A) BODØ
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Bodø...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Bodø",
        description: "REKO-ring i Bodø med 22 gårder som leverer. Utlevering ved Plantasjen parkering, torsdager. Kjøtt, grønnsaker, brød, egg, honning og mer. Over 5800 følgere.",
        provider: "REKO Bodø",
        contactEmail: "reko.bodo@gmail.com",
        url: "https://www.facebook.com/groups/rekobodo/",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Bodø",
                description: "Forhåndsbestilt lokalmat fra 22 gårder i Nordland. Henting ved Plantasjen parkering.",
                tags: ["reko", "utlevering", "bodø", "nordland", "lokalmat", "22 gårder"],
            }],
        role: "producer",
        location: { lat: 67.2804, lng: 14.4049, city: "Bodø", radiusKm: 15 },
        categories: ["vegetables", "eggs", "meat", "honey", "bread"],
        tags: ["reko", "direct-sale", "nordland", "community", "22-farms"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Nordland (Bodø)",
        description: "Bondens marked i Bodø, Nordland. Lokalprodusert mat fra nordlandsbønder. Sesongbasert marked.",
        provider: "Bondens Marked Nordland",
        contactEmail: "nordland@bondensmarked.no",
        url: "https://www.facebook.com/BondensmarkedNordland/",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Bodø",
                description: "Lokalprodusert mat fra Nordland. Kjøtt, fisk, grønnsaker, ost, brød.",
                tags: ["bondens marked", "bodø", "nordland", "lokal mat", "sesong"],
            }],
        role: "producer",
        location: { lat: 67.2804, lng: 14.4049, city: "Bodø", radiusKm: 10 },
        categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
        tags: ["farmers-market", "weekend", "nordland", "seasonal"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Lofoten",
        description: "REKO-ring i Lofoten. Arktisk lokalmat fra fiskere og bønder i Lofoten. Forhåndsbestilling via Facebook.",
        provider: "REKO Lofoten",
        contactEmail: "reko.lofoten@gmail.com",
        url: "https://www.facebook.com/groups/rekolofoten",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Lofoten",
                description: "Forhåndsbestilt arktisk mat fra Lofoten. Tørrfisk, lam, egg.",
                tags: ["reko", "utlevering", "lofoten", "arktisk", "tørrfisk"],
            }],
        role: "producer",
        location: { lat: 68.2340, lng: 14.5636, city: "Svolvær", radiusKm: 50 },
        categories: ["fish", "meat", "eggs"],
        tags: ["reko", "arctic", "lofoten", "direct-sale", "traditional"],
    });
    // ════════════════════════════════════════════════════════════
    // B) ÅLESUND
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Ålesund...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Ålesund/Digerneset",
        description: "REKO-ring i Ålesund, Sunnmøre. Forhåndsbestilling via Facebook. Utlevering ved Digerneset. Lokale produsenter fra Møre og Romsdal.",
        provider: "REKO Ålesund",
        contactEmail: "reko.alesund@gmail.com",
        url: "https://www.facebook.com/groups/rekoalesund/",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Ålesund",
                description: "Forhåndsbestilt lokalmat fra Sunnmøre-produsenter. Henting ved Digerneset.",
                tags: ["reko", "utlevering", "ålesund", "sunnmøre", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 62.4722, lng: 6.1495, city: "Ålesund", radiusKm: 15 },
        categories: ["vegetables", "eggs", "fish", "meat", "bread"],
        tags: ["reko", "direct-sale", "sunnmøre", "community"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Ålesund",
        description: "Bondens marked på St. Olavs plass i Ålesund. Lokalprodusert mat fra produsenter i Møre og Romsdal.",
        provider: "Bondens Marked Møre og Romsdal",
        contactEmail: "moreogromsdal@bondensmarked.no",
        url: "https://bondensmarked.no",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Ålesund",
                description: "Lokalprodusert mat fra Møre og Romsdal. Fisk, kjøtt, ost, grønnsaker.",
                tags: ["bondens marked", "ålesund", "møre og romsdal", "st. olavs plass"],
            }],
        role: "producer",
        location: { lat: 62.4722, lng: 6.1495, city: "Ålesund", radiusKm: 10 },
        categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
        tags: ["farmers-market", "weekend", "møre-og-romsdal", "seasonal"],
    });
    // ════════════════════════════════════════════════════════════
    // C) HAUGESUND
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Haugesund...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Haugalandet",
        description: "REKO-ring for Haugesund og Haugalandet. Forhåndsbestilling via Facebook. Lokale produsenter fra Rogaland/Vestland-grensen. Utlevering ved Rådhusplassen.",
        provider: "REKO Haugalandet",
        contactEmail: "reko.haugalandet@gmail.com",
        url: "https://www.facebook.com/groups/489491634779966/",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Haugalandet",
                description: "Forhåndsbestilt lokalmat fra Haugalandet-produsenter. Henting ved Rådhusplassen Haugesund.",
                tags: ["reko", "utlevering", "haugesund", "haugalandet", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 59.4138, lng: 5.2680, city: "Haugesund", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "honey", "bread", "fish"],
        tags: ["reko", "direct-sale", "haugalandet", "community"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Haugen Gardsmat",
        description: "Gårdsmatprodusent på Haugalandet. Selger via Bondens marked og REKO-ringer. Kjøtt og lokale råvarer.",
        provider: "Haugen Gardsmat",
        contactEmail: "post@haugengardsmat.no",
        url: "https://www.haugengardsmat.no",
        skills: [{
                id: "sell-farm-food",
                name: "Gardsmat fra Haugalandet",
                description: "Kjøtt og lokale råvarer fra gården. Selger via Bondens marked og REKO.",
                tags: ["gardsmat", "kjøtt", "haugalandet", "gård", "reko", "bondens marked"],
            }],
        role: "producer",
        location: { lat: 59.4200, lng: 5.2800, city: "Haugesund", radiusKm: 30 },
        categories: ["meat", "vegetables"],
        tags: ["farm-direct", "bondens-marked", "reko", "haugalandet"],
    });
    // ════════════════════════════════════════════════════════════
    // D) TØNSBERG
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Tønsberg...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Tønsberg",
        description: "REKO-ring i Tønsberg, Vestfold. En av tre REKO-ringer i Vestfold. Forhåndsbestilling via Facebook. Utlevering én gang i måneden, torsdager.",
        provider: "REKO Tønsberg",
        contactEmail: "reko.tonsberg@gmail.com",
        url: "https://www.facebook.com/groups/rekotonsberg",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Tønsberg",
                description: "Forhåndsbestilt lokalmat fra Vestfold-produsenter. Henting i Tønsberg.",
                tags: ["reko", "utlevering", "tønsberg", "vestfold", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 59.2676, lng: 10.4076, city: "Tønsberg", radiusKm: 15 },
        categories: ["vegetables", "eggs", "meat", "honey", "bread"],
        tags: ["reko", "direct-sale", "vestfold", "monthly", "thursday"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Vestfold (Tønsberg)",
        description: "Bondens marked i Tønsberg. Lokalprodusert mat fra Vestfold-bønder.",
        provider: "Bondens Marked Vestfold",
        contactEmail: "vestfold@bondensmarked.no",
        url: "https://bondensmarked.no",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Tønsberg",
                description: "Lokalprodusert mat fra Vestfold. Grønnsaker, kjøtt, ost, honning, brød.",
                tags: ["bondens marked", "tønsberg", "vestfold", "lokal mat"],
            }],
        role: "producer",
        location: { lat: 59.2676, lng: 10.4076, city: "Tønsberg", radiusKm: 10 },
        categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
        tags: ["farmers-market", "weekend", "vestfold", "seasonal"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bjunegårdsdrift",
        description: "Gårdsbutikk 10 km nord for Tønsberg. Belted Galloway-storfe, skogsgris og kveg. Fokus på dyrevelferd og norskprodusert lokalmat. Selger via gårdsutsalg og REKO-ringer.",
        provider: "Bjunegårdsdrift",
        contactEmail: "post@bjunegard.no",
        url: "https://matrikevestfold.no/bjunegardsdrift/",
        skills: [{
                id: "sell-meat",
                name: "Kjøtt fra Bjunegårdsdrift",
                description: "Kjøtt fra Belted Galloway og skogsgris. Fokus på dyrevelferd.",
                tags: ["kjøtt", "storfe", "gris", "dyrevelferd", "gårdsbutikk", "vestfold"],
            }],
        role: "producer",
        location: { lat: 59.3100, lng: 10.4000, city: "Tønsberg", radiusKm: 20 },
        categories: ["meat"],
        tags: ["farm-shop", "animal-welfare", "reko", "belted-galloway"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Hem Gård",
        description: "Gårdsbutikk i Undrumsdal/Barkåker, 15 min fra Tønsberg sentrum. Gressfôra storfe, frilandsgris, egg fra gårdshøner. Selger via gårdsbutikk og REKO.",
        provider: "Hem Gård",
        contactEmail: "post@hemgard.no",
        url: "https://matrikevestfold.no/hem-gard/",
        skills: [{
                id: "sell-farm-products",
                name: "Gårdsprodukter fra Hem Gård",
                description: "Gressfôra kjøtt, frilandsgris og egg. Gårdsbutikk og REKO-utlevering.",
                tags: ["kjøtt", "egg", "gressfôra", "frilandsgris", "gårdsbutikk"],
            }],
        role: "producer",
        location: { lat: 59.3200, lng: 10.3500, city: "Tønsberg", radiusKm: 20 },
        categories: ["meat", "eggs"],
        tags: ["farm-shop", "grass-fed", "free-range", "reko", "vestfold"],
    });
    // ════════════════════════════════════════════════════════════
    // E) SKIEN / PORSGRUNN (Grenland)
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Skien/Porsgrunn...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Grenland",
        description: "REKO-ring for Skien og Porsgrunn (Grenland). 10-20 produsenter. Utlevering annenhver onsdag i Porsgrunn. Pølser, grønnsaker, honning, bakevarer, vilt, svinekjøtt.",
        provider: "REKO Grenland",
        contactEmail: "reko.grenland@gmail.com",
        url: "https://www.facebook.com/groups/rekogrenland",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Grenland",
                description: "Forhåndsbestilt lokalmat fra Telemark-produsenter. 10-20 produsenter. Henting i Porsgrunn.",
                tags: ["reko", "utlevering", "skien", "porsgrunn", "grenland", "telemark"],
            }],
        role: "producer",
        location: { lat: 59.1409, lng: 9.6568, city: "Skien", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "honey", "bread"],
        tags: ["reko", "direct-sale", "grenland", "telemark", "biweekly"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Telemark (Skien)",
        description: "Bondens marked i Skien/Telemark. Lokalprodusert mat fra Telemark-bønder. Sesongbasert.",
        provider: "Bondens Marked Telemark",
        contactEmail: "telemark@bondensmarked.no",
        url: "https://bondensmarked.no/markedsdager/telemark-8",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Skien",
                description: "Lokalprodusert mat fra Telemark. Grønnsaker, kjøtt, ost, honning.",
                tags: ["bondens marked", "skien", "telemark", "lokal mat"],
            }],
        role: "producer",
        location: { lat: 59.2097, lng: 9.6099, city: "Skien", radiusKm: 15 },
        categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
        tags: ["farmers-market", "weekend", "telemark", "seasonal"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Vest-Telemark",
        description: "REKO-ring for Vest-Telemark. Lokalmat direkte fra produsent. Bestilling via Facebook, henting i Dalen eller Åmot.",
        provider: "REKO Vest-Telemark",
        contactEmail: "reko.vesttelemark@gmail.com",
        url: "https://www.facebook.com/groups/rekovesttelemark",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Vest-Telemark",
                description: "Forhåndsbestilt lokalmat. Henting i Dalen eller Åmot, Vest-Telemark.",
                tags: ["reko", "utlevering", "vest-telemark", "dalen", "åmot"],
            }],
        role: "producer",
        location: { lat: 59.4470, lng: 8.0050, city: "Dalen", radiusKm: 40 },
        categories: ["vegetables", "meat", "honey", "bread", "dairy"],
        tags: ["reko", "direct-sale", "vest-telemark", "rural"],
    });
    // ════════════════════════════════════════════════════════════
    // F) HAMAR
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Hamar...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Hamar",
        description: "REKO-ring i Hamar, Innlandet. Kjøtt, egg, grønnsaker, ferskt brød og andre gårdsprodukter. Forhåndsbestilling via Facebook.",
        provider: "REKO Hamar",
        contactEmail: "reko.hamar@gmail.com",
        url: "https://www.facebook.com/groups/rekohamar",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Hamar",
                description: "Forhåndsbestilt lokalmat fra Hedmark-produsenter. Henting i Hamar.",
                tags: ["reko", "utlevering", "hamar", "hedmark", "innlandet", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 60.7945, lng: 11.0680, city: "Hamar", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "bread", "honey"],
        tags: ["reko", "direct-sale", "innlandet", "hedmark"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Innlandet (Hamar)",
        description: "Bondens marked i Hamar. Lokalprodusert mat fra Innlandet-bønder. Ost, kjøtt, grønnsaker og honning fra Hedmark og Oppland.",
        provider: "Bondens Marked Innlandet",
        contactEmail: "innlandet@bondensmarked.no",
        url: "https://www.facebook.com/bondensmarkedinnlandet/",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Hamar",
                description: "Lokalprodusert mat fra Innlandet. Ost, kjøtt, grønnsaker, honning.",
                tags: ["bondens marked", "hamar", "innlandet", "hedmark", "lokal mat"],
            }],
        role: "producer",
        location: { lat: 60.7945, lng: 11.0680, city: "Hamar", radiusKm: 15 },
        categories: ["vegetables", "fruit", "dairy", "meat", "honey", "bread"],
        tags: ["farmers-market", "weekend", "innlandet", "hedmark"],
    });
    // ════════════════════════════════════════════════════════════
    // G) MOSS
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Moss...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Moss",
        description: "REKO-ring i Moss, Østfold. Lokalmat helt uten mellomledd. Økologiske råvarer, grasfôret kjøtt, egg fra frilandshøner. Produsenter: Mølle Haugen, Guldkolla, Mellom Fange Gård, Norsk Urkorn, Skauen Gård, Svanekil Gård.",
        provider: "REKO Moss",
        contactEmail: "reko.moss@gmail.com",
        url: "https://www.facebook.com/groups/rekomoss",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Moss",
                description: "Forhåndsbestilt lokalmat fra Østfold-produsenter. Økologisk fokus.",
                tags: ["reko", "utlevering", "moss", "østfold", "lokalmat", "økologisk"],
            }],
        role: "producer",
        location: { lat: 59.4390, lng: 10.6577, city: "Moss", radiusKm: 15 },
        categories: ["vegetables", "eggs", "meat", "bread", "dairy"],
        tags: ["reko", "direct-sale", "østfold", "organic", "grass-fed"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Svanekil Gård",
        description: "Gård i Østfold med økologisk drift. Selger via Bondens marked og REKO-ringen Moss. Grønnsaker og korn.",
        provider: "Svanekil Gård",
        contactEmail: "post@svanekil.org",
        url: "https://svanekil.org",
        skills: [{
                id: "sell-organic-produce",
                name: "Økologiske grønnsaker og korn",
                description: "Økologisk dyrket grønnsaker og korn fra Østfold-gård.",
                tags: ["økologisk", "grønnsaker", "korn", "gård", "østfold"],
            }],
        role: "producer",
        location: { lat: 59.4500, lng: 10.7000, city: "Moss", radiusKm: 20 },
        categories: ["vegetables", "bread"],
        tags: ["organic", "farm", "reko", "bondens-marked", "østfold"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Norsk Urkorn (Trøgstad)",
        description: "Gårdsbutikk og bakeriutsalg i Trøgstad, Østfold. Økologisk korn, fersk bakst laget på eget korn. Selger via REKO-ringen Moss.",
        provider: "Norsk Urkorn",
        contactEmail: "post@norskurkorn.no",
        url: "https://norskurkorn.no",
        skills: [{
                id: "sell-grain-bakery",
                name: "Økologisk korn og bakevarer",
                description: "Økologisk korn og fersk bakst fra eget bakeri. Gårdsbutikk i Trøgstad.",
                tags: ["korn", "bakevarer", "økologisk", "bakeri", "gårdsbutikk"],
            }],
        role: "producer",
        location: { lat: 59.6400, lng: 11.3500, city: "Trøgstad", radiusKm: 30 },
        categories: ["bread"],
        tags: ["organic", "grain", "bakery", "farm-shop", "reko"],
    });
    // ════════════════════════════════════════════════════════════
    // H) SARPSBORG (more Østfold coverage)
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Sarpsborg...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Sarpsborg/Fredrikstad",
        description: "REKO-ring for Sarpsborg og Fredrikstad-området. Forhåndsbestilling via Facebook. Østfold-produsenter.",
        provider: "REKO Sarpsborg",
        contactEmail: "reko.sarpsborg@gmail.com",
        url: "https://www.facebook.com/groups/rekosarpsborg",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Sarpsborg",
                description: "Forhåndsbestilt lokalmat fra Østfold-produsenter. Henting i Sarpsborg.",
                tags: ["reko", "utlevering", "sarpsborg", "fredrikstad", "østfold"],
            }],
        role: "producer",
        location: { lat: 59.2839, lng: 11.1096, city: "Sarpsborg", radiusKm: 15 },
        categories: ["vegetables", "eggs", "meat", "bread", "honey"],
        tags: ["reko", "direct-sale", "østfold", "community"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Walle Gård (Østfold)",
        description: "Gårdsbutikk i Østfold med lokal mat. Bredt utvalg av lokalproduserte varer fra Østfold-regionen.",
        provider: "Walle Gård",
        contactEmail: "post@wallegard.no",
        url: "https://wallegard.no",
        skills: [{
                id: "sell-farm-products",
                name: "Gårdsprodukter fra Østfold",
                description: "Lokale gårdsprodukter fra Østfold. Bredt utvalg.",
                tags: ["gårdsbutikk", "østfold", "lokal mat", "gård"],
            }],
        role: "producer",
        location: { lat: 59.2900, lng: 11.1200, city: "Sarpsborg", radiusKm: 20 },
        categories: ["vegetables", "meat", "eggs", "dairy"],
        tags: ["farm-shop", "østfold", "local", "variety"],
    });
    // ════════════════════════════════════════════════════════════
    // I) ADDITIONAL BERGEN PRODUCERS
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Bergen — flere produsenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Lystgården (Bergen)",
        description: "Oversikt over lokalmat i Bergen. Formidler informasjon om lokale matprodusenter, gårdsbutikker og matmarkeder i Bergen-regionen.",
        provider: "Lystgården",
        contactEmail: "post@lystgarden.no",
        url: "https://www.lystgarden.no/lokalmat-i-bergen",
        skills: [{
                id: "local-food-directory",
                name: "Lokalmat-guide Bergen",
                description: "Oversikt over lokale matprodusenter og utsalgssteder i Bergen.",
                tags: ["lokalmat", "bergen", "guide", "produsenter", "utsalgssteder"],
            }],
        role: "quality",
        location: { lat: 60.3943, lng: 5.3259, city: "Bergen", radiusKm: 30 },
        categories: [],
        tags: ["directory", "bergen", "local-food-guide", "aggregator"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Troye Spesialgrossisten (Bergen)",
        description: "Spesialgrossist på Kokstad utenfor Bergen. Fokus på lokalmat og spesialiteter fra Vestland, samt matskatter fra resten av landet.",
        provider: "Troye Spesialgrossisten",
        contactEmail: "post@troye.no",
        url: "https://troye.no",
        skills: [{
                id: "wholesale-local-food",
                name: "Lokale spesialiteter engros",
                description: "Engros av lokalmat og spesialiteter fra Vestland. Leverer til restauranter og butikker.",
                tags: ["engros", "spesialiteter", "vestland", "lokalmat", "restaurant"],
            }],
        role: "logistics",
        location: { lat: 60.3100, lng: 5.2800, city: "Bergen", radiusKm: 40 },
        categories: ["dairy", "meat", "preserves"],
        tags: ["wholesale", "specialty", "vestland", "b2b", "kokstad"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Tysnes Gårdsysteri",
        description: "Gård, gårdsbutikk og restaurant på Tysnes, sør for Bergen. Egen osteproduksjon. Lokale råvarer.",
        provider: "Tysnes Gårdsysteri",
        contactEmail: "post@tysnesgardsysteri.no",
        url: "https://www.hanen.no/utforsk/32/vestland",
        skills: [{
                id: "sell-cheese-farm",
                name: "Ost og gårdsprodukter Tysnes",
                description: "Håndlaget ost og lokale gårdsprodukter. Gårdsbutikk og restaurant på Tysnes.",
                tags: ["ost", "cheese", "gårdsbutikk", "tysnes", "vestland", "restaurant"],
            }],
        role: "producer",
        location: { lat: 59.9900, lng: 5.5100, city: "Tysnes", radiusKm: 30 },
        categories: ["dairy", "meat"],
        tags: ["cheese-maker", "farm-shop", "restaurant", "tysnes", "vestland"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bønes Pølsemakeri (Bergen)",
        description: "Lokal pølsemaker i Bergen. Håndlagde pølser og kjøttprodukter.",
        provider: "Bønes Pølsemakeri",
        contactEmail: "post@bonespølsemakeri.no",
        url: "https://www.lystgarden.no/lokalmat-i-bergen",
        skills: [{
                id: "sell-sausages",
                name: "Håndlagde pølser Bergen",
                description: "Håndlagde pølser og kjøttprodukter fra lokal produsent i Bergen.",
                tags: ["pølser", "kjøtt", "håndlaget", "bergen", "lokal"],
            }],
        role: "producer",
        location: { lat: 60.3500, lng: 5.3100, city: "Bergen", radiusKm: 15 },
        categories: ["meat"],
        tags: ["sausage-maker", "artisan", "bergen", "handmade"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Gardsmatbutikken Øystese (Hardanger)",
        description: "Gårdsmatbutikk i Øystese, Hardanger. Bredt utvalg lokalprodusert mat: kjøtt, frukt, bær, honning og tradisjonelle bakevarer fra Hardanger.",
        provider: "Gardsmatbutikken",
        contactEmail: "post@gardsmatbutikken.no",
        url: "https://www.hanen.no/utforsk/32/vestland",
        skills: [{
                id: "sell-hardanger-products",
                name: "Gardsmat fra Hardanger",
                description: "Lokalprodusert mat fra Hardanger: kjøtt, frukt, bær, honning, bakevarer.",
                tags: ["gardsmat", "hardanger", "frukt", "bær", "honning", "kjøtt", "bakevarer"],
            }],
        role: "producer",
        location: { lat: 60.3900, lng: 6.2000, city: "Kvam", radiusKm: 30 },
        categories: ["meat", "fruit", "honey", "bread"],
        tags: ["farm-shop", "hardanger", "traditional", "variety"],
    });
    // ════════════════════════════════════════════════════════════
    // J) ADDITIONAL STAVANGER/ROGALAND PRODUCERS
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Stavanger — flere produsenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Gladmat Stavanger",
        description: "Norges største matfestival, holdes årlig i Stavanger sentrum ved Vågen. Hundrevis av lokale og nasjonale matprodusenter. Gratis inngang.",
        provider: "Gladmat AS",
        contactEmail: "post@gladmat.no",
        url: "https://www.gladmat.no",
        skills: [{
                id: "food-festival",
                name: "Gladmat matfestival",
                description: "Norges største matfestival i Stavanger. Hundrevis av produsenter. Gratis inngang.",
                tags: ["matfestival", "stavanger", "gladmat", "festival", "gratis"],
            }],
        role: "quality",
        location: { lat: 58.9700, lng: 5.7331, city: "Stavanger", radiusKm: 5 },
        categories: [],
        tags: ["festival", "annual", "stavanger", "largest", "free-entry"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Jæren",
        description: "REKO-ring for Jæren-området sør for Stavanger. Forhåndsbestilling via Facebook. Jærbu-produsenter med kjøtt, egg, grønnsaker.",
        provider: "REKO Jæren",
        contactEmail: "reko.jaeren@gmail.com",
        url: "https://www.facebook.com/groups/rekojaeren",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Jæren",
                description: "Forhåndsbestilt lokalmat fra Jæren-produsenter.",
                tags: ["reko", "utlevering", "jæren", "rogaland", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 58.7600, lng: 5.6300, city: "Bryne", radiusKm: 25 },
        categories: ["vegetables", "eggs", "meat", "dairy"],
        tags: ["reko", "direct-sale", "jæren", "rogaland"],
    });
    // ════════════════════════════════════════════════════════════
    // K) ADDITIONAL OSLO-AREA PRODUCERS
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Oslo-området — flere produsenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Tomter Mais (Romerike)",
        description: "Gårdsbutikk og selvplukk av grønnsaker på Tomter, Romerike. Mais, gresskar og andre sesonggrønnsaker. Populært sommerutfluktsmål.",
        provider: "Tomter Mais",
        contactEmail: "post@tomtermais.no",
        url: "https://tomtermais.no/",
        skills: [{
                id: "sell-seasonal-veg",
                name: "Mais og sesonggrønnsaker",
                description: "Selvplukk mais, gresskar og sesonggrønnsaker. Gårdsbutikk på Romerike.",
                tags: ["mais", "gresskar", "selvplukk", "sesong", "romerike", "gårdsbutikk"],
            }],
        role: "producer",
        location: { lat: 59.6500, lng: 10.9800, city: "Tomter", radiusKm: 25 },
        categories: ["vegetables"],
        tags: ["self-pick", "seasonal", "farm-shop", "romerike", "family-friendly"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Haugerud Gård (Regenerativt)",
        description: "Regenerativt drevet gård i Akershus. Selger via REKO-ringer. Fokus på jordhelse og bærekraftig matproduksjon.",
        provider: "Haugerud Gård",
        contactEmail: "post@haugerudregenerativ.no",
        url: "https://haugerudregenerativ.no/reko-ringen/",
        skills: [{
                id: "sell-regenerative-products",
                name: "Regenerative gårdsprodukter",
                description: "Mat fra regenerativt drevet gård. Fokus på jordhelse og bærekraft.",
                tags: ["regenerativt", "bærekraft", "gård", "reko", "jordhelse"],
            }],
        role: "producer",
        location: { lat: 59.8500, lng: 10.9000, city: "Akershus", radiusKm: 30 },
        categories: ["vegetables", "eggs", "meat"],
        tags: ["regenerative", "sustainable", "reko", "soil-health"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Virgenes Andelsgård (Vestby)",
        description: "Andelsgård i Vestby, Follo. Grønnsakkasse-abonnement med lokale, sesongbaserte grønnsaker. Andelslandbruk.",
        provider: "Virgenes Andelsgård",
        contactEmail: "post@virgenes.no",
        url: "https://www.virgenes.no",
        skills: [{
                id: "vegbox-subscription",
                name: "Grønnsakskasse Follo",
                description: "Sesongbasert grønnsakskasse fra andelsgård i Vestby. Andelslandbruk-modell.",
                tags: ["grønnsakskasse", "andelsgård", "vestby", "follo", "sesong", "abonnement"],
            }],
        role: "producer",
        location: { lat: 59.5800, lng: 10.7300, city: "Vestby", radiusKm: 25 },
        categories: ["vegetables"],
        tags: ["csa", "subscription", "follo", "seasonal", "organic"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Ski/Follo",
        description: "REKO-ring for Ski og Follo-området sør for Oslo. Lokalmat fra Follo-bønder.",
        provider: "REKO Follo",
        contactEmail: "reko.follo@gmail.com",
        url: "https://www.facebook.com/groups/rekofollo",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Ski/Follo",
                description: "Forhåndsbestilt lokalmat fra Follo-produsenter. Henting i Ski.",
                tags: ["reko", "utlevering", "ski", "follo", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 59.7200, lng: 10.8400, city: "Ski", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "bread", "honey"],
        tags: ["reko", "direct-sale", "follo", "akershus"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Jessheim/Romerike",
        description: "REKO-ring for Jessheim og øvre Romerike. Lokalmat fra Akershus-produsenter.",
        provider: "REKO Jessheim",
        contactEmail: "reko.jessheim@gmail.com",
        url: "https://www.facebook.com/groups/rekojessheim",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Jessheim",
                description: "Forhåndsbestilt lokalmat fra Romerike-produsenter. Henting i Jessheim.",
                tags: ["reko", "utlevering", "jessheim", "romerike", "akershus"],
            }],
        role: "producer",
        location: { lat: 60.1450, lng: 11.1740, city: "Jessheim", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "bread"],
        tags: ["reko", "direct-sale", "romerike", "akershus"],
    });
    // ════════════════════════════════════════════════════════════
    // L) LILLEHAMMER
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Lillehammer...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Lillehammer",
        description: "REKO-ring i Lillehammer, Innlandet. Lokalmat fra bønder i Gudbrandsdalen og Mjøs-regionen.",
        provider: "REKO Lillehammer",
        contactEmail: "reko.lillehammer@gmail.com",
        url: "https://www.facebook.com/groups/rekolillehammer",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Lillehammer",
                description: "Forhåndsbestilt lokalmat fra Gudbrandsdals-produsenter. Henting i Lillehammer.",
                tags: ["reko", "utlevering", "lillehammer", "gudbrandsdal", "innlandet"],
            }],
        role: "producer",
        location: { lat: 61.1153, lng: 10.4663, city: "Lillehammer", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "dairy", "honey", "bread"],
        tags: ["reko", "direct-sale", "gudbrandsdal", "innlandet"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Lillehammer",
        description: "Bondens marked i Lillehammer. Lokalprodusert mat fra Innlandet — Gudbrandsdalsost, spekemat, grønnsaker og bær.",
        provider: "Bondens Marked Innlandet",
        contactEmail: "innlandet@bondensmarked.no",
        url: "https://bondensmarked.no",
        skills: [{
                id: "farmers-market",
                name: "Bondens marked Lillehammer",
                description: "Lokalprodusert mat fra Innlandet. Gudbrandsdalsost, spekemat, grønnsaker, bær.",
                tags: ["bondens marked", "lillehammer", "innlandet", "gudbrandsdal"],
            }],
        role: "producer",
        location: { lat: 61.1153, lng: 10.4663, city: "Lillehammer", radiusKm: 15 },
        categories: ["vegetables", "fruit", "dairy", "meat", "honey"],
        tags: ["farmers-market", "weekend", "gudbrandsdal", "innlandet"],
    });
    // ════════════════════════════════════════════════════════════
    // M) KONGSBERG
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Kongsberg...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO-ringen Kongsberg",
        description: "REKO-ring i Kongsberg, Buskerud. Forhåndsbestilling via Facebook. Lokale produsenter fra Numedal og Kongsberg-regionen.",
        provider: "REKO Kongsberg",
        contactEmail: "reko.kongsberg@gmail.com",
        url: "https://www.facebook.com/groups/rekokongsberg",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Kongsberg",
                description: "Forhåndsbestilt lokalmat fra Numedal-produsenter. Henting i Kongsberg.",
                tags: ["reko", "utlevering", "kongsberg", "numedal", "buskerud"],
            }],
        role: "producer",
        location: { lat: 59.6631, lng: 9.6521, city: "Kongsberg", radiusKm: 20 },
        categories: ["vegetables", "eggs", "meat", "bread", "honey"],
        tags: ["reko", "direct-sale", "buskerud", "numedal"],
    });
    // ════════════════════════════════════════════════════════════
    // N) ADDITIONAL NATIONAL SERVICES
    // ════════════════════════════════════════════════════════════
    console.log("   🚚 Flere nasjonale tjenester...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Godt Lokalt (Vestland)",
        description: "Regional oversikt over lokale matprodusenter i Vestland. Bestilling av lokale smaker. Kobler forbrukere med produsenter.",
        provider: "Godt Lokalt",
        contactEmail: "post@godtlokalt.no",
        url: "https://www.godtlokalt.no/regioner/vestland",
        skills: [{
                id: "regional-directory",
                name: "Finn lokale produsenter Vestland",
                description: "Oversikt over lokale matprodusenter i Vestland-regionen.",
                tags: ["produsenter", "vestland", "lokal mat", "oversikt"],
            }],
        role: "quality",
        location: { lat: 60.3943, lng: 5.3259, city: "Bergen", radiusKm: 200 },
        categories: [],
        tags: ["directory", "vestland", "regional", "aggregator"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Matarena (Vestland)",
        description: "Bestill lokale smaker fra Vestland. Nettbasert plattform som kobler forbrukere med lokale matprodusenter i Vestland.",
        provider: "Matarena",
        contactEmail: "post@matarena.no",
        url: "https://matarena.no/lokalmatvestland/",
        skills: [{
                id: "online-local-food",
                name: "Bestill lokal mat Vestland",
                description: "Nettbasert bestilling av lokal mat fra Vestland-produsenter.",
                tags: ["bestilling", "nett", "vestland", "lokalmat", "levering"],
            }],
        role: "logistics",
        location: { lat: 60.3943, lng: 5.3259, city: "Bergen", radiusKm: 200 },
        categories: ["vegetables", "fruit", "dairy", "meat", "fish"],
        tags: ["online", "vestland", "delivery", "local-food-platform"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Matrike Vestfold",
        description: "Nettverk for lokale matprodusenter i Vestfold. Oversikt over gårdsbutikker, produsenter og utsalgssteder.",
        provider: "Matrike Vestfold",
        contactEmail: "post@matrikevestfold.no",
        url: "https://matrikevestfold.no",
        skills: [{
                id: "vestfold-producer-network",
                name: "Matnettverk Vestfold",
                description: "Nettverk av lokale matprodusenter i Vestfold. Gårdsbutikker og utsalgssteder.",
                tags: ["nettverk", "vestfold", "produsenter", "gårdsbutikk", "lokal mat"],
            }],
        role: "quality",
        location: { lat: 59.2676, lng: 10.4076, city: "Tønsberg", radiusKm: 50 },
        categories: [],
        tags: ["network", "vestfold", "directory", "producer-association"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "LocalFood.no",
        description: "Nasjonal nettbutikk for lokalmat. Kobler produsenter med forbrukere over hele Norge. Bestilling og levering/henting.",
        provider: "LocalFood AS",
        contactEmail: "post@localfood.no",
        url: "https://localfood.no",
        skills: [{
                id: "online-local-food-national",
                name: "Nettbutikk for norsk lokalmat",
                description: "Kjøp lokal mat fra norske produsenter. Nasjonal plattform med bestilling og levering.",
                tags: ["nettbutikk", "lokalmat", "nasjonal", "bestilling", "levering"],
            }],
        role: "logistics",
        location: { lat: 59.9139, lng: 10.7522, city: "Norge", radiusKm: 1000 },
        categories: ["vegetables", "fruit", "dairy", "meat", "eggs", "honey", "bread"],
        tags: ["national", "online", "marketplace", "delivery"],
    });
    // ════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════
    const stats = marketplace_registry_1.marketplaceRegistry.getStats();
    console.log(`\n   ✅ Expansion v2 loaded:`);
    console.log(`      ${stats.totalAgents} agents total (across all seeds)`);
    console.log(`      ${stats.activeProducers} producers`);
    console.log(`      Cities: ${stats.cities.join(", ")}`);
    console.log(`\n   New cities: Bodø, Ålesund, Haugesund, Tønsberg, Skien,`);
    console.log(`   Hamar, Moss, Sarpsborg, Lillehammer, Kongsberg, Lofoten`);
    console.log(`   + additional Bergen, Stavanger, Oslo-area producers\n`);
}
//# sourceMappingURL=seed-expansion-v2.js.map