"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedOsloRealData = seedOsloRealData;
const marketplace_registry_1 = require("./services/marketplace-registry");
// ─── Real Oslo Local Food Database ────────────────────────────
// Researched 2026-03-30. Sources: bondensmarked.no, localfood.no,
// meravoslo.no, visitgreateroslo.com, oslo.kommune.no, yelp, google.
//
// Categories:
//   - REKO-ringer (5 in Oslo)
//   - Bondens marked produsenter (Oslo & omegn)
//   - Grønnsaksbutikker og frukt/grønt
//   - Gårdsbutikker (Oslo/Akershus)
//   - Honningprodusenter (urban birøkt)
//   - Mathallen-butikker (spesialmat)
//   - Urbant landbruk
function seedOsloRealData() {
    // Idempotent: skip if we already have agents in the database
    const existing = marketplace_registry_1.marketplaceRegistry.getActiveAgents();
    if (existing.length > 0) {
        console.log(`🏙️  Database already has ${existing.length} agents — skipping seed.\n`);
        return;
    }
    console.log("🏙️  Seeding REAL Oslo local food database...\n");
    // ════════════════════════════════════════════════════════════
    // 1. REKO-RINGER (5 active rings in Oslo)
    // ════════════════════════════════════════════════════════════
    console.log("   📍 REKO-ringer...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO Vålerenga",
        description: "REKO-ring på Vålerenga. Utlevering ved Vålerenga kirke, annenhver onsdag kl 18-19. Bestilling via Facebook-gruppen.",
        provider: "REKO Oslo",
        contactEmail: "reko.valerenga@gmail.com",
        url: "https://www.facebook.com/groups/rekovalerenga",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Vålerenga",
                description: "Forhåndsbestilt lokalmat fra flere produsenter. Henting ved Vålerenga kirke.",
                tags: ["reko", "utlevering", "vålerenga", "lokalmat", "forhåndsbestilling"],
            }],
        role: "producer",
        location: { lat: 59.9073, lng: 10.7820, city: "Oslo", radiusKm: 5 },
        categories: ["vegetables", "eggs", "honey", "bread", "meat"],
        tags: ["reko", "direct-sale", "community", "pre-order"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO Skøyen",
        description: "REKO-ring på Skøyen/Bygdøy. Utlevering ved Hageland Olsens Enke (parkering), annenhver torsdag kl 13-15.",
        provider: "REKO Oslo",
        contactEmail: "reko.skoyen@gmail.com",
        url: "https://www.facebook.com/groups/rekobygdoy",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Skøyen",
                description: "Forhåndsbestilt lokalmat. Henting ved Hageland Olsens Enke.",
                tags: ["reko", "utlevering", "skøyen", "bygdøy", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 59.9203, lng: 10.6840, city: "Oslo", radiusKm: 5 },
        categories: ["vegetables", "fruit", "mushrooms", "honey", "eggs"],
        tags: ["reko", "direct-sale", "community", "pre-order"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO Sentrum / Sukkerbiten",
        description: "REKO-ring i Oslo sentrum. Utlevering bak Operahuset ved Sukkerbiten.",
        provider: "REKO Oslo",
        contactEmail: "reko.sentrum@gmail.com",
        url: "https://www.facebook.com/groups/rekoprindsenhage",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Sentrum",
                description: "Forhåndsbestilt lokalmat. Henting ved Sukkerbiten bak Operaen.",
                tags: ["reko", "utlevering", "sentrum", "operaen", "sukkerbiten"],
            }],
        role: "producer",
        location: { lat: 59.9070, lng: 10.7530, city: "Oslo", radiusKm: 3 },
        categories: ["vegetables", "eggs", "preserves", "bread"],
        tags: ["reko", "direct-sale", "community", "central"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO Grorud",
        description: "REKO-ring på Grorud. Utlevering på Grorud-området, annenhver uke.",
        provider: "REKO Oslo",
        contactEmail: "reko.grorud@gmail.com",
        url: "https://www.facebook.com/groups/rekogrorud",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Grorud",
                description: "Forhåndsbestilt lokalmat. Henting på Grorud.",
                tags: ["reko", "utlevering", "grorud", "lokalmat"],
            }],
        role: "producer",
        location: { lat: 59.9620, lng: 10.8860, city: "Oslo", radiusKm: 5 },
        categories: ["vegetables", "eggs", "meat", "bread"],
        tags: ["reko", "direct-sale", "community", "groruddalen"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "REKO St. Hanshaugen / Mølleparken",
        description: "REKO-ring for St. Hanshaugen og Grünerløkka. Utlevering i Mølleparken, annenhver torsdag kl 16-17.",
        provider: "REKO Oslo",
        contactEmail: "reko.molleparken@gmail.com",
        url: "https://www.facebook.com/groups/2063101300483792",
        skills: [{
                id: "reko-pickup",
                name: "REKO-utlevering Mølleparken",
                description: "Forhåndsbestilt lokalmat. Henting i Mølleparken ved St. Hanshaugen.",
                tags: ["reko", "utlevering", "grünerløkka", "st.hanshaugen", "mølleparken"],
            }],
        role: "producer",
        location: { lat: 59.9260, lng: 10.7500, city: "Oslo", radiusKm: 3 },
        categories: ["honey", "mushrooms", "coffee", "bread", "vegetables"],
        tags: ["reko", "direct-sale", "community", "urban"],
    });
    // ════════════════════════════════════════════════════════════
    // 2. REKO PRODUSENTER (verified from meravoslo.no)
    // ════════════════════════════════════════════════════════════
    console.log("   🌾 REKO-produsenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Sandviken Honning",
        description: "Prisbelønt honningprodusent med fire bigårder. Gull og bronse i NM Honning. Unike smaker: lakris, peppermynte. Selger via REKO St. Hanshaugen.",
        provider: "Sandviken Honning",
        contactEmail: "post@sandvikenhonning.no",
        url: "https://sandvikenhonning.no",
        skills: [{
                id: "sell-honey",
                name: "Selg honning",
                description: "Prisbelønt norsk honning i unike smaker. Lakris, peppermynte, blomsterhonning.",
                tags: ["honning", "honey", "lakris", "peppermynte", "prisbelønt", "NM"],
            }],
        role: "producer",
        location: { lat: 59.9300, lng: 10.7500, city: "Oslo", radiusKm: 10 },
        categories: ["honey"],
        tags: ["award-winning", "artisan", "reko", "unique-flavors"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bjørnstad Skog",
        description: "Matsopp fra Ås kommune. Kantarell, steinsopp, traktkantarell, piggsopp — fersk, tørket og som kraft. Selger via REKO Skøyen.",
        provider: "Bjørnstad Skog",
        contactEmail: "post@bjornstadskog.no",
        url: "https://bjornstadskog.no",
        skills: [{
                id: "sell-mushrooms",
                name: "Selg sopp",
                description: "Ville matsopp: kantarell, steinsopp, traktkantarell, piggsopp. Fersk, tørket og kraft.",
                tags: ["sopp", "mushrooms", "kantarell", "steinsopp", "tørket", "vill"],
            }],
        role: "producer",
        location: { lat: 59.6600, lng: 10.7900, city: "Ås", radiusKm: 30 },
        categories: ["mushrooms"],
        tags: ["wild-foraged", "seasonal", "artisan", "reko"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Delås Gård",
        description: "Gård i Skjeberg med grønnsaker og egg fra frittgående høner. Selger via REKO Sentrum.",
        provider: "Delås Gård",
        contactEmail: "post@delasgard.no",
        url: "https://delasgard.no",
        skills: [{
                id: "sell-eggs-vegetables",
                name: "Selg egg og grønnsaker",
                description: "Frittgående egg og sesonggrønnsaker direkte fra gården.",
                tags: ["egg", "grønnsaker", "frittgående", "fersk", "gård"],
            }],
        role: "producer",
        location: { lat: 59.2100, lng: 11.1500, city: "Skjeberg", radiusKm: 40 },
        categories: ["eggs", "vegetables"],
        tags: ["free-range", "farm", "reko", "seasonal"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Kaffehagen",
        description: "Kaffebrenner og baker. Kaffe, bakevarer og kokosprodukter. Selger via REKO Vålerenga.",
        provider: "Kaffehagen",
        contactEmail: "hei@kaffehagen.no",
        url: "https://kaffehagen.no",
        skills: [{
                id: "sell-coffee-baked-goods",
                name: "Selg kaffe og bakevarer",
                description: "Håndristet kaffe, hjemmebakst, kokos-lime-kaker, kjeks.",
                tags: ["kaffe", "coffee", "bakevarer", "kaker", "hjemmebakst"],
            }],
        role: "producer",
        location: { lat: 59.9073, lng: 10.7820, city: "Oslo", radiusKm: 10 },
        categories: ["bread", "other"],
        tags: ["artisan", "coffee", "baked-goods", "reko"],
    });
    // ════════════════════════════════════════════════════════════
    // 3. BONDENS MARKED PRODUSENTER (Oslo & omegn — 56 totalt)
    // ════════════════════════════════════════════════════════════
    console.log("   🧑‍🌾 Bondens marked...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bondens Marked Oslo",
        description: "Lokalprodusert mat direkte fra gården. 56 produsenter i Oslo & omegn. 5 faste markedsplasser: Vinkelplassen (Majorstuen), Birkelunden (Grünerløkka), Vinslottet (Hasle), Vikaterrassen (Vika), Botanisk Hage (Tøyen).",
        provider: "Bondens Marked Oslo SA",
        contactEmail: "oslo@bondensmarked.no",
        url: "https://bondensmarked.no/lokallag/oslo-og-omegn",
        skills: [
            {
                id: "market-schedule",
                name: "Markedsdager",
                description: "Info om kommende markedsdager og hvilke produsenter som er til stede.",
                tags: ["marked", "schedule", "produsenter", "helg"],
            },
            {
                id: "browse-producers",
                name: "Finn produsenter",
                description: "Søk blant 56 produsenter etter kategori: grønnsaker, ost, kjøtt, fisk, honning, brød.",
                tags: ["produsenter", "søk", "kategori", "grønnsaker", "ost", "kjøtt", "fisk"],
            },
        ],
        role: "producer",
        location: { lat: 59.9270, lng: 10.7130, city: "Oslo", radiusKm: 5 },
        categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread", "eggs"],
        tags: ["farmers-market", "direct-sale", "weekend", "community", "56-producers"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Anitas Sjømat",
        description: "Fisk og sjømat, selger på Bondens marked Oslo. Fersk kvalitetsfisk direkte til forbruker.",
        provider: "Anitas Sjømat",
        contactEmail: "post@anitassjomat.no",
        url: "https://bondensmarked.no",
        skills: [{
                id: "sell-fish",
                name: "Selg sjømat",
                description: "Fersk fisk og sjømat direkte fra produsent.",
                tags: ["fisk", "sjømat", "fersk", "fish", "seafood"],
            }],
        role: "producer",
        location: { lat: 59.9270, lng: 10.7130, city: "Oslo", radiusKm: 15 },
        categories: ["fish"],
        tags: ["fresh", "bondens-marked", "direct-sale"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Anne Karins Snadder",
        description: "Egg, bakevarer og syltetøy. Selger på Bondens marked Oslo & omegn.",
        provider: "Anne Karins Snadder",
        contactEmail: "post@annekarinssnadder.no",
        url: "https://bondensmarked.no",
        skills: [{
                id: "sell-eggs-baked-preserves",
                name: "Selg egg, bakevarer og syltetøy",
                description: "Hjemmelagde bakevarer, egg og syltetøy/preserves.",
                tags: ["egg", "bakevarer", "syltetøy", "hjemmelaget", "preserves"],
            }],
        role: "producer",
        location: { lat: 59.9270, lng: 10.7130, city: "Oslo", radiusKm: 20 },
        categories: ["eggs", "bread", "preserves"],
        tags: ["homemade", "bondens-marked", "artisan"],
    });
    // ════════════════════════════════════════════════════════════
    // 4. GRØNNSAKSBUTIKKER & FRUKT/GRØNT I OSLO
    // ════════════════════════════════════════════════════════════
    console.log("   🥬 Grønnsaksbutikker...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Grønland Torg Frukt og Grønt",
        description: "Over 170 typer frukt og grønnsaker. En av Oslos største og mest populære frukt/grønt-butikker. Smalgangen 1, Grønland.",
        provider: "Grønland Torg Frukt og Grønt",
        contactEmail: "post@gronlandtorg.no",
        url: "https://gronlandstorg.no/gronlands-torg-frukt-og-gront/",
        skills: [{
                id: "sell-produce",
                name: "Stort utvalg frukt og grønt",
                description: "Over 170 typer frukt og grønnsaker. Rimelige priser, ferskt daglig.",
                tags: ["grønnsaker", "frukt", "stort utvalg", "rimelig", "fersk", "170 typer"],
            }],
        role: "producer",
        location: { lat: 59.9127, lng: 10.7600, city: "Oslo", radiusKm: 2 },
        categories: ["vegetables", "fruit", "herbs"],
        tags: ["budget", "daily-fresh", "large-selection", "grønland"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Dagligvare Frukt & Grønnsaker",
        description: "Frukt- og grøntbutikk på Storgata 34C. Åpen 07-22 hverdager, 08-21 søndager. Stort utvalg til gode priser.",
        provider: "Dagligvare Frukt & Grønnsaker",
        contactEmail: "post@dagligvarefrukt.no",
        url: "https://dagligvarefrukt.no",
        skills: [{
                id: "sell-produce",
                name: "Frukt og grønt",
                description: "Bredt utvalg frukt og grønnsaker. Lange åpningstider.",
                tags: ["grønnsaker", "frukt", "rimelig", "lange åpningstider"],
            }],
        role: "producer",
        location: { lat: 59.9155, lng: 10.7530, city: "Oslo", radiusKm: 2 },
        categories: ["vegetables", "fruit"],
        tags: ["budget", "daily-fresh", "long-hours", "storgata"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Vika Frukt og Grønt",
        description: "Frukt- og grøntbutikk i Vika, Oslo sentrum. Ferske varer daglig.",
        provider: "Vika Frukt og Grønt AS",
        contactEmail: "post@vikafrukt.no",
        url: "https://www.facebook.com/vika.frukt.gront.as/",
        skills: [{
                id: "sell-produce",
                name: "Frukt og grønt i Vika",
                description: "Ferskt frukt og grønt i hjertet av Oslo.",
                tags: ["grønnsaker", "frukt", "sentrum", "vika", "fersk"],
            }],
        role: "producer",
        location: { lat: 59.9130, lng: 10.7280, city: "Oslo", radiusKm: 2 },
        categories: ["vegetables", "fruit"],
        tags: ["central", "daily-fresh", "vika"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Vulkan Frukt og Grønt",
        description: "Frukt- og grøntbutikk i Mathallen på Vulkan. Kvalitetsvarer og sesongprodukter.",
        provider: "Vulkan Frukt og Grønt",
        contactEmail: "post@vulkanfrukt.no",
        url: "https://mathallenoslo.no",
        skills: [{
                id: "sell-produce",
                name: "Frukt og grønt i Mathallen",
                description: "Kvalitetsfrukt og grønnsaker i Mathallen. Sesongvarer og spesialiteter.",
                tags: ["grønnsaker", "frukt", "mathallen", "kvalitet", "sesong"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 3 },
        categories: ["vegetables", "fruit"],
        tags: ["premium", "mathallen", "seasonal", "quality"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Sagene Torg",
        description: "Lokal dagligvare og frukt/grønt-butikk på Sagene. Godt utvalg med fokus på nabolaget.",
        provider: "Sagene Torg",
        contactEmail: "post@sagenetorg.no",
        url: "https://sagenetorg.no",
        skills: [{
                id: "sell-produce",
                name: "Frukt, grønt og dagligvarer",
                description: "Lokalt utvalg av frukt, grønt og dagligvarer på Sagene.",
                tags: ["grønnsaker", "frukt", "dagligvarer", "sagene", "lokal"],
            }],
        role: "producer",
        location: { lat: 59.9375, lng: 10.7517, city: "Oslo", radiusKm: 2 },
        categories: ["vegetables", "fruit"],
        tags: ["local", "neighborhood", "sagene"],
    });
    // ════════════════════════════════════════════════════════════
    // 5. GÅRDSBUTIKKER (Oslo/Akershus — innen leveringsavstand)
    // ════════════════════════════════════════════════════════════
    console.log("   🏡 Gårdsbutikker...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Haneborg Gård (Tomtermais)",
        description: "Over 60 egenproduserte grønnsaker i gårdsbutikken. Selvplukk av mais og grønnsaker. 7 min fra Drøbak sentrum, Frogn kommune.",
        provider: "Haneborg Gård",
        contactEmail: "post@tomtermais.no",
        url: "https://tomtermais.no",
        skills: [{
                id: "sell-vegetables-selfpick",
                name: "Grønnsaker og selvplukk",
                description: "60+ egenproduserte grønnsaker, selvplukk av mais. Gårdsbutikk.",
                tags: ["grønnsaker", "mais", "selvplukk", "gårdsbutikk", "60 sorter"],
            }],
        role: "producer",
        location: { lat: 59.7200, lng: 10.6300, city: "Drøbak", radiusKm: 30 },
        categories: ["vegetables"],
        tags: ["farm-shop", "self-pick", "organic", "large-variety", "seasonal"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Rånås Gård",
        description: "Gårdsbutikk i Nes, Akershus. Jordbruk, besøksgård og gårdsutsalg med lokale produkter.",
        provider: "Rånås Gård",
        contactEmail: "post@ranasgard.no",
        url: "https://ranasgard.no",
        skills: [{
                id: "sell-farm-products",
                name: "Gårdsprodukter",
                description: "Lokale produkter fra gården: grønnsaker, egg, kjøtt og meieriprodukter.",
                tags: ["gård", "lokalt", "grønnsaker", "egg", "kjøtt"],
            }],
        role: "producer",
        location: { lat: 60.1300, lng: 11.4700, city: "Nes", radiusKm: 40 },
        categories: ["vegetables", "eggs", "meat", "dairy"],
        tags: ["farm-shop", "visitor-farm", "family-friendly"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Dystergaard",
        description: "Unik liten matprodusent i Ås. Lokale spesialiteter og gårdsmat fra Akershus.",
        provider: "Dystergaard",
        contactEmail: "post@dystergaard.no",
        url: "https://www.dystergaard.no",
        skills: [{
                id: "sell-specialty-food",
                name: "Spesialmat fra gården",
                description: "Håndlagde matprodukter og lokale spesialiteter.",
                tags: ["spesialmat", "håndlaget", "gård", "lokalt", "ås"],
            }],
        role: "producer",
        location: { lat: 59.6600, lng: 10.7900, city: "Ås", radiusKm: 25 },
        categories: ["preserves", "other"],
        tags: ["artisan", "small-batch", "farm-shop", "specialty"],
    });
    // ════════════════════════════════════════════════════════════
    // 6. HONNING & URBAN BIRØKT
    // ════════════════════════════════════════════════════════════
    console.log("   🍯 Honningprodusenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "ByBi — Oslos Urbane Birøkterlag",
        description: "Miljøorganisasjon for urban birøkt i Oslo. Kurs, honningsalg og besøk til bigårder. Produserer byhonning.",
        provider: "ByBi",
        contactEmail: "post@bybi.no",
        url: "https://bybi.no",
        skills: [{
                id: "sell-urban-honey",
                name: "Selg urban byhonning",
                description: "Honning fra urbane bikuber i Oslo. Kurs og bigårdsbesøk.",
                tags: ["honning", "urban", "birøkt", "oslo", "byhonning", "kurs"],
            }],
        role: "producer",
        location: { lat: 59.9139, lng: 10.7522, city: "Oslo", radiusKm: 10 },
        categories: ["honey"],
        tags: ["urban", "organic", "community", "education", "bee-friendly"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Overnaturlig Honning",
        description: "Urban birøkt basert i Østmarka, Oslo. To bigårder: Skrømt og Hulder. Naturlig, ubehandlet honning.",
        provider: "Overnaturlig Honning",
        contactEmail: "post@overnaturlighonning.no",
        url: "https://overnaturlighonning.no",
        skills: [{
                id: "sell-raw-honey",
                name: "Selg rå honning",
                description: "Naturlig, ubehandlet honning fra Østmarka. To unike bigårder.",
                tags: ["honning", "rå", "ubehandlet", "østmarka", "naturlig"],
            }],
        role: "producer",
        location: { lat: 59.8900, lng: 10.8500, city: "Oslo", radiusKm: 15 },
        categories: ["honey"],
        tags: ["raw", "natural", "wild", "oslo-forest"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Local Buzz (Idil Akdos)",
        description: "Byhonning fra takhage på Schweigaards gate 34, Landbrukskvartalet. Gullmedalje NM Honning 2022 (skogshonning-kategorien).",
        provider: "Local Buzz",
        contactEmail: "hei@localbuzz.no",
        url: "https://localbuzz.no",
        skills: [{
                id: "sell-rooftop-honey",
                name: "Selg takhonning",
                description: "Prisbelønt byhonning fra takhage i Oslo sentrum. Gull i NM.",
                tags: ["honning", "takhage", "urban", "prisbelønt", "gull", "NM"],
            }],
        role: "producer",
        location: { lat: 59.9100, lng: 10.7630, city: "Oslo", radiusKm: 10 },
        categories: ["honey"],
        tags: ["award-winning", "rooftop", "urban", "premium"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Vulkanbier (Alexander)",
        description: "Urban birøkt i Oslo med 9 bigårder og 30 bikuber. Honning fra hele byen.",
        provider: "Vulkanbier",
        contactEmail: "post@vulkanbier.no",
        url: "https://vulkanbier.no",
        skills: [{
                id: "sell-city-honey",
                name: "Selg byhonning",
                description: "Honning fra 9 bigårder spredt over hele Oslo. 30 bikuber totalt.",
                tags: ["honning", "urban", "oslo", "mange bigårder", "byhonning"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 10 },
        categories: ["honey"],
        tags: ["urban", "multi-apiary", "oslo-wide", "artisan"],
    });
    // ════════════════════════════════════════════════════════════
    // 7. MATHALLEN BUTIKKER (spesialmat)
    // ════════════════════════════════════════════════════════════
    console.log("   🏛️  Mathallen...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Vulkanfisk",
        description: "Ferskt fisk og sjømat i Mathallen Oslo. Kvalitetsfisk direkte fra leverandør.",
        provider: "Vulkanfisk",
        contactEmail: "post@vulkanfisk.no",
        url: "https://mathallenoslo.no",
        skills: [{
                id: "sell-fresh-fish",
                name: "Selg fersk fisk",
                description: "Kvalitetsfisk og sjømat. Fersk daglig.",
                tags: ["fisk", "sjømat", "fersk", "laks", "torsk", "reker"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
        categories: ["fish"],
        tags: ["fresh", "premium", "mathallen", "daily"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Ost & Sånt",
        description: "Ostebutikk i Mathallen. Norske og internasjonale oster. Spesialiteter og rådgivning.",
        provider: "Ost & Sånt",
        contactEmail: "post@ostogsant.no",
        url: "https://mathallenoslo.no",
        skills: [{
                id: "sell-cheese",
                name: "Selg ost",
                description: "Norske og internasjonale oster. Rådgivning og spesialiteter.",
                tags: ["ost", "cheese", "meieri", "norsk", "spesialitet"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
        categories: ["dairy"],
        tags: ["premium", "mathallen", "specialty", "cheese-expert"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Gutta på Haugen",
        description: "Norsk kjøtt og charcuteri i Mathallen. Kvalitetskjøtt fra norske gårder.",
        provider: "Gutta på Haugen",
        contactEmail: "post@guttapahaugen.no",
        url: "https://guttapahaugen.no",
        skills: [{
                id: "sell-meat",
                name: "Selg kjøtt og charcuteri",
                description: "Norsk kvalitetskjøtt, pølser, spekemat og charcuteri.",
                tags: ["kjøtt", "meat", "charcuteri", "pølser", "spekemat", "norsk"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
        categories: ["meat"],
        tags: ["premium", "mathallen", "norwegian", "charcuterie"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Annis Pølsemakeri",
        description: "Håndlagde pølser i Mathallen Oslo. Tradisjonelt håndverk, naturlige ingredienser.",
        provider: "Annis Pølsemakeri",
        contactEmail: "post@annispolse.no",
        url: "https://mathallenoslo.no",
        skills: [{
                id: "sell-sausages",
                name: "Selg pølser",
                description: "Håndlagde pølser av høy kvalitet. Tradisjonelt håndverk.",
                tags: ["pølser", "sausages", "håndlaget", "tradisjonelt"],
            }],
        role: "producer",
        location: { lat: 59.9230, lng: 10.7510, city: "Oslo", radiusKm: 5 },
        categories: ["meat"],
        tags: ["artisan", "mathallen", "handmade", "traditional"],
    });
    // ════════════════════════════════════════════════════════════
    // 8. BONDENS MARKED LOKASJONER (som egne agenter)
    // ════════════════════════════════════════════════════════════
    console.log("   🧺 Bondens marked lokasjoner...");
    const bondensMarkedLocations = [
        { name: "Bondens Marked Majorstuen (Vinkelplassen)", lat: 59.9288, lng: 10.7136, district: "Majorstuen" },
        { name: "Bondens Marked Birkelunden (Grünerløkka)", lat: 59.9243, lng: 10.7590, district: "Grünerløkka" },
        { name: "Bondens Marked Vinslottet (Hasle)", lat: 59.9290, lng: 10.7830, district: "Hasle" },
        { name: "Bondens Marked Vikaterrassen (Vika)", lat: 59.9130, lng: 10.7260, district: "Vika" },
        { name: "Bondens Marked Botanisk Hage (Tøyen)", lat: 59.9175, lng: 10.7710, district: "Tøyen" },
    ];
    for (const loc of bondensMarkedLocations) {
        marketplace_registry_1.marketplaceRegistry.register({
            name: loc.name,
            description: `Bondens marked i ${loc.district}. Lokalprodusert mat direkte fra bønder. Lørdager i sesong.`,
            provider: "Bondens Marked Oslo SA",
            contactEmail: "oslo@bondensmarked.no",
            url: "https://bondensmarked.no/markedsdager/oslo-omegn-2",
            skills: [{
                    id: "farmers-market",
                    name: "Bondens marked",
                    description: `Ukentlig marked med lokale produsenter i ${loc.district}. Grønnsaker, ost, kjøtt, fisk, brød, honning.`,
                    tags: ["bondens marked", "lokal mat", loc.district.toLowerCase(), "lørdag", "direkte salg"],
                }],
            role: "producer",
            location: { lat: loc.lat, lng: loc.lng, city: "Oslo", radiusKm: 2 },
            categories: ["vegetables", "fruit", "dairy", "meat", "fish", "honey", "bread"],
            tags: ["farmers-market", "weekend", "seasonal", "direct-sale", loc.district.toLowerCase()],
        });
    }
    // ════════════════════════════════════════════════════════════
    // 9. TJENESTE-AGENTER (logistikk, kvalitet)
    // ════════════════════════════════════════════════════════════
    console.log("   🚲 Tjenesteagenter...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Foodora Oslo",
        description: "Matlevering i Oslo. Leverer fra restauranter og dagligvare. Potensielt partnerskap for lokal mat-levering.",
        provider: "Foodora Norway AS",
        contactEmail: "partner@foodora.no",
        url: "https://www.foodora.no",
        skills: [{
                id: "food-delivery",
                name: "Matlevering",
                description: "Rask levering av mat innen Oslo. Sykkel og bil.",
                tags: ["levering", "delivery", "rask", "oslo", "sykkel"],
            }],
        role: "logistics",
        location: { lat: 59.9139, lng: 10.7522, city: "Oslo", radiusKm: 15 },
        categories: [],
        tags: ["delivery", "fast", "city-wide", "partner-potential"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Debio Sertifisering",
        description: "Offisiell kontrollinstans for økologisk produksjon i Norge. Verifiserer Debio-sertifisering for produsenter.",
        provider: "Debio",
        contactEmail: "debio@debio.no",
        url: "https://debio.no",
        skills: [{
                id: "verify-organic",
                name: "Verifiser økologisk sertifisering",
                description: "Sjekk om en produsent har gyldig Debio-sertifisering for økologisk produksjon.",
                tags: ["debio", "økologisk", "organic", "sertifisering", "verifisering"],
            }],
        role: "quality",
        location: { lat: 59.9139, lng: 10.7522, city: "Oslo" },
        categories: [],
        tags: ["certification", "organic", "official", "trust"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Mattilsynet Verifisering",
        description: "Norsk matmyndighet. Verifisering av mathygiene og mattrygghet for produsenter og butikker.",
        provider: "Mattilsynet",
        contactEmail: "postmottak@mattilsynet.no",
        url: "https://mattilsynet.no",
        skills: [{
                id: "verify-food-safety",
                name: "Verifiser mattrygghet",
                description: "Sjekk smilefjes-status og hygienekarakter for matbedrifter.",
                tags: ["mattilsynet", "hygiene", "mattrygghet", "smilefjes", "godkjent"],
            }],
        role: "quality",
        location: { lat: 59.9139, lng: 10.7522, city: "Oslo" },
        categories: [],
        tags: ["food-safety", "official", "hygiene", "government"],
    });
    // ════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════
    const stats = marketplace_registry_1.marketplaceRegistry.getStats();
    console.log(`\n   ✅ Oslo database loaded:`);
    console.log(`      ${stats.totalAgents} agents total`);
    console.log(`      ${stats.activeProducers} producers`);
    console.log(`      ${stats.cities.join(", ")}`);
    console.log(`\n   Categories: REKO-ringer (5), REKO-produsenter (4),`);
    console.log(`   Bondens marked (6+5 lokasjoner), Grønnsaksbutikker (5),`);
    console.log(`   Gårdsbutikker (3), Honning (4), Mathallen (4),`);
    console.log(`   Tjenesteagenter (3)\n`);
}
//# sourceMappingURL=seed-oslo-real.js.map