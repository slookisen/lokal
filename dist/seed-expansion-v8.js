"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedExpansionV8 = seedExpansionV8;
const marketplace_registry_1 = require("./services/marketplace-registry");
// ─── Norway Database Expansion v8 ───────────────────────────
// Researched 2026-03-31. Sources:
// - hanen.no/utforsk (Akershus, Vestland, Trøndelag, Agder, Nordland)
// - visitgreateroslo.com, bestefarhuset.no, roma.no, fioriblomster.no
// - hardangerfjord.com, siderlandet.no, visitbergen.com
// - trondelag.com, visitinnherred.com, ostelandet.no
// - visitlofoten.com, visitnorway.com, bondensmarked.no
// - lillemarkens.no (Kristiansand), berbusmel.no (Bodø)
//
// FOCUS AREAS:
// 1. Oslo/Romerike — remaining farm shops: BesteFarHuset, Roma Brusfabrikk,
//    FioriBlomster, Keiser Frukt, Folvell, Rønningen, Lenas, Follo Grønt
// 2. Bergen/Hardanger — cider route: Hardangerbonden, Aga Sideri,
//    Hardanger Saft, Engevik, Myrdal, Øvre-Eide, Bøtun
// 3. Trondheim/Trøndelag — cheese dairies + markets: Lager 11, Låvbrua,
//    Dalebro, Gangstad, Grindal, Eggen, Orkladal, Munkeby, Potetrampa
// 4. Kristiansand/Agder — Austlid, Matkjelleren, Reinhartsen, Lista Lamb
// 5. Bodø/Lofoten — Berbusmel, Aalan, Lofoten Gårdsysteri, Livland,
//    Polarhagen, Aimees Farm
//
// IMPORTANT: All entries verified against existing v1-v7 seeds.
// Only GENUINELY NEW entries not present in database.
function seedExpansionV8() {
    const existing = marketplace_registry_1.marketplaceRegistry.getActiveAgents();
    const hasV8 = existing.some((a) => a.name === "BesteFarHuset — Blaker" || a.name === "Hardangerbonden — Sekse");
    if (hasV8) {
        console.log(`🇳🇴 Expansion v8 already loaded — skipping.\n`);
        return;
    }
    console.log("🇳🇴 Seeding Norway expansion v8 database...\n");
    // ════════════════════════════════════════════════════════════
    // A) OSLO/ROMERIKE — REMAINING FARM SHOPS & SPECIALTY
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Oslo/Romerike — gårdsbutikker og spesialbutikker...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "BesteFarHuset — Blaker",
        description: "Kafé i låven og gårdsbutikk i stabbur på historisk gård med over 500 års historie. Poteter, egg, sesonggrønnsaker, honning, hjemmelaget tyttebærsyltetøy og lokale leverandørprodukter. Blaker, Lillestrøm kommune. Åpent tor 14-20, søn 13-18.",
        provider: "BesteFarHuset",
        contactEmail: "post@bestefarhuset.no",
        url: "https://www.bestefarhuset.no/",
        skills: [{
                id: "sell-farm-bestefarhuset",
                name: "Gårdsbutikk BesteFarHuset Blaker",
                description: "Historisk gårdsbutikk med lokale produkter, egg, honning, grønnsaker.",
                tags: ["gårdsbutikk", "blaker", "lillestrøm", "historisk", "kafé"],
            }],
        role: "producer",
        location: { lat: 59.7120, lng: 11.2570, city: "Lillestrøm", radiusKm: 15 },
        categories: ["vegetables", "eggs", "honey", "preserves"],
        tags: ["farm-shop", "cafe", "historic", "hanen", "romerike"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Roma Mineralvannfabrikk — Lillestrøm",
        description: "Familieeid brusfabrikk og utsalgsbutikk siden 1920. Over 40.000 besøkende årlig. Produserer ~3 millioner liter brus. Butikken selger norske brusklassikere (Asina, Flux, Ginger Beer) pluss lokal mat fra hele Norge. Nesa, Lillestrøm.",
        provider: "Roma Mineralvannfabrikk",
        contactEmail: "post@roma.no",
        url: "https://roma.no/",
        skills: [{
                id: "sell-drinks-roma",
                name: "Roma Brusfabrikk Lillestrøm",
                description: "Norsk brusfabrikk med utsalg. Brus, øl og lokal mat.",
                tags: ["brus", "lillestrøm", "fabrikk", "lokal-mat", "norsk"],
            }],
        role: "producer",
        location: { lat: 59.9530, lng: 11.0530, city: "Lillestrøm", radiusKm: 10 },
        categories: ["preserves"],
        tags: ["beverage-factory", "historic", "local-food", "romerike"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "FioriBlomster — Vollen, Asker",
        description: "Økologisk blomstergård med spiselige blomster, pesticid-fritt. Selvplukk mai-september. Utsikt over Oslofjorden fra Vollen. Buss 250 Slemmestad eller hurtigbåt B20 fra Aker Brygge.",
        provider: "FioriBlomster",
        contactEmail: "post@fioriblomster.no",
        url: "https://www.fioriblomster.no/",
        skills: [{
                id: "sell-flowers-fiori",
                name: "Økologiske spiselige blomster Vollen",
                description: "Økologiske snittblomster og spiselige blomster, pesticid-fritt. Selvplukk.",
                tags: ["blomster", "økologisk", "spiselig", "vollen", "asker"],
            }],
        role: "producer",
        location: { lat: 59.7810, lng: 10.4890, city: "Asker", radiusKm: 10 },
        categories: ["herbs", "vegetables"],
        tags: ["organic", "edible-flowers", "self-pick", "hanen", "niche"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Keiser Frukt Marked — Lillestrøm",
        description: "Lillestrøms mest elskede frukt- og grønnsakbutikk i over 30 år. Stort utvalg av fersk frukt, grønnsaker, dagligvarer, blomster. Torvgata 12, Lillestrøm sentrum. 4.3/5 stjerner, 1000+ anmeldelser.",
        provider: "Keiser Frukt Marked",
        contactEmail: "post@keisermarked.no",
        url: "https://www.keisermarked.no/",
        skills: [{
                id: "sell-frukt-keiser",
                name: "Keiser Frukt og Grønt Lillestrøm",
                description: "Bredt utvalg fersk frukt, grønnsaker og dagligvarer i Lillestrøm sentrum.",
                tags: ["frukt", "grønt", "lillestrøm", "dagligvare", "sentrum"],
            }],
        role: "producer",
        location: { lat: 59.9560, lng: 11.0500, city: "Lillestrøm", radiusKm: 5 },
        categories: ["vegetables", "fruit"],
        tags: ["fruit-shop", "grocery", "established", "romerike"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Folvell Gård — Årnes",
        description: "Tradisjonell gård med nyåpnet gårdsbutikk. Jordbærsmoothie fra egne bær. Nedre Hagaveg 353, 2150 Årnes, Nes kommune.",
        provider: "Folvell Gård",
        contactEmail: "post@folvell.no",
        url: "http://www.folvell.no/",
        skills: [{
                id: "sell-farm-folvell",
                name: "Gårdsbutikk Folvell Årnes",
                description: "Gårdsprodukter og jordbærprodukter fra egen produksjon.",
                tags: ["gård", "årnes", "nes", "jordbær", "romerike"],
            }],
        role: "producer",
        location: { lat: 60.1240, lng: 11.4650, city: "Årnes", radiusKm: 15 },
        categories: ["fruit", "vegetables"],
        tags: ["farm-shop", "strawberry", "romerike", "nes"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Rønningen Gård — Skui, Bærum",
        description: "Historisk gårdstun fra 1887. Gårdsbutikk med lokale produkter, sesongmarkeder (høst og jul), besøksgård med hester, sauer, høner. 10 min fra Sandvika, 20 min fra Oslo sentrum.",
        provider: "Rønningen Gård",
        contactEmail: "post@ronningen-gard.no",
        url: "https://ronningen-gard.no/",
        skills: [{
                id: "sell-farm-ronningen",
                name: "Gårdsbutikk Rønningen Bærum",
                description: "Historisk gård med butikk, sesongmarkeder og besøksopplevelser.",
                tags: ["gård", "bærum", "skui", "historisk", "besøksgård"],
            }],
        role: "producer",
        location: { lat: 59.9090, lng: 10.5370, city: "Bærum", radiusKm: 10 },
        categories: ["vegetables", "eggs", "meat"],
        tags: ["farm-shop", "historic", "visit-farm", "seasonal-market", "baerum"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Lenas Gårdsbutikk — Algarheim",
        description: "Hjemmelagde produkter og interiørvarer. Gratis kaffe. 4.7/5 stjerner. Ødegårdsaleen 2056, Algarheim, Ullensaker kommune. Drevet av Lena Marie Hedman siden 2016.",
        provider: "Lenas Gårdsbutikk",
        contactEmail: "post@lenasgardsbutikk.no",
        url: "https://www.instagram.com/lenasgardsbutikk/",
        skills: [{
                id: "sell-farm-lenas",
                name: "Gårdsbutikk Lenas Algarheim",
                description: "Hjemmelagde produkter fra gård nær Jessheim.",
                tags: ["gårdsbutikk", "algarheim", "ullensaker", "hjemmelaget"],
            }],
        role: "producer",
        location: { lat: 60.1670, lng: 11.1430, city: "Ullensaker", radiusKm: 10 },
        categories: ["preserves", "bread"],
        tags: ["farm-shop", "homemade", "romerike", "ullensaker"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Follo Grønt — Nordre Frogn",
        description: "Kålrot- og kålprodusent med selvbetjent gårdsutsalg 'Skapet' på Garderveien. Familieeiet gård siden 1600-tallet. Nyplantet frukttrær. Drevet av Kjersti og Thorleif Dahl.",
        provider: "Follo Grønt",
        contactEmail: "post@follogront.no",
        url: "https://www.follogront.no/",
        skills: [{
                id: "sell-veg-follogront",
                name: "Follo Grønt gårdsutsalg",
                description: "Sesongbaserte grønnsaker, kålrot og kål fra Follo-gård.",
                tags: ["grønnsaker", "follo", "frogn", "kålrot", "sesong"],
            }],
        role: "producer",
        location: { lat: 59.7010, lng: 10.6200, city: "Frogn", radiusKm: 10 },
        categories: ["vegetables"],
        tags: ["farm-shop", "self-service", "follo", "traditional", "root-vegetables"],
    });
    // ════════════════════════════════════════════════════════════
    // B) BERGEN/HARDANGER — SIDERUTEN OG GÅRDSBUTIKKER
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Bergen/Hardanger — sideruten og gårdsbutikker...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Hardangerbonden — Sekse",
        description: "Eplegård og siderprodusent drevet av Ingrid og Bård Sekse. 10.000 epletrær, 90+ tonn høstet årlig. Produserer eplesider, smakssatte sidere, issider og eplejuice. Smakinger, omvisninger og gårdsbutikk i Sekse, Ullensvang.",
        provider: "Hardangerbonden",
        contactEmail: "post@hardangerbonden.no",
        url: "https://www.hardangerbonden.no/",
        skills: [{
                id: "sell-cider-hardangerbonden",
                name: "Hardangerbonden sider og eplejuice",
                description: "Eplesider, issider og eplejuice fra 10.000 epletrær i Hardanger.",
                tags: ["sider", "eple", "hardanger", "ullensvang", "siderruten"],
            }],
        role: "producer",
        location: { lat: 60.3200, lng: 6.6500, city: "Ullensvang", radiusKm: 20 },
        categories: ["fruit", "preserves"],
        tags: ["cider", "apple-farm", "hardanger", "tastings", "farm-shop"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Aga Sideri — Ullensvang",
        description: "Joar Agas siderprodusent (etablert 2018) ved Sørfjorden. En av Norges største siderprodusenter. Smakinger, omvisninger og gårdsbutikk.",
        provider: "Aga Sideri",
        contactEmail: "post@agasideri.no",
        url: "https://hardangerfjord.com/en/attractions/aga-sideri-5419293",
        skills: [{
                id: "sell-cider-aga",
                name: "Aga Sideri Hardanger",
                description: "Eplesider og juice fra Sørfjorden, Hardanger.",
                tags: ["sider", "aga", "hardanger", "sørfjorden", "siderruten"],
            }],
        role: "producer",
        location: { lat: 60.4150, lng: 6.5300, city: "Ullensvang", radiusKm: 15 },
        categories: ["fruit", "preserves"],
        tags: ["cider", "hardanger", "tastings", "farm-shop"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Hardanger Saft og Siderfabrikk — Ulvik",
        description: "Familieeid juice- og siderfabrikk på Lekve gård. Grunnlagt 2004 av Nils J. Lekve. Eplejuice, sider (tørr til halvtørr), eplebrennevin og akevitt. Kun Hardanger-epler.",
        provider: "Hardanger Saft og Siderfabrikk",
        contactEmail: "post@hardangersaft.no",
        url: "https://www.hanen.no/en/bedrift/hardanger-saft-og-siderfabrikk-as/",
        skills: [{
                id: "sell-cider-hardangersaft",
                name: "Hardanger Saft og Siderfabrikk Ulvik",
                description: "Eplejuice, sider, brennevin fra Hardanger-epler. Familiedrevet fabrikk.",
                tags: ["sider", "juice", "ulvik", "hardanger", "brennevin"],
            }],
        role: "producer",
        location: { lat: 60.5680, lng: 6.9100, city: "Ulvik", radiusKm: 20 },
        categories: ["fruit", "preserves"],
        tags: ["cider", "juice", "distillery", "hardanger", "hanen", "farm-factory"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Engevik Gaard — Sævareid, Fusa",
        description: "Historisk offisersgård fra tidlig 1700-tall ved Sævareidfjorden. Bakeri med tradisjonelt flatbrød, lefse og kaker etter gamle oppskrifter fra distriktet. Grupper etter avtale.",
        provider: "Engevik Gaard",
        contactEmail: "post@engevikgaard.no",
        url: "http://engevikgaard.no/",
        skills: [{
                id: "sell-bakery-engevik",
                name: "Tradisjonelt bakeri Engevik Fusa",
                description: "Tradisjonelt flatbrød, lefse og kaker fra historisk gård.",
                tags: ["bakeri", "flatbrød", "fusa", "tradisjonell", "historisk"],
            }],
        role: "producer",
        location: { lat: 60.1890, lng: 5.8700, city: "Fusa", radiusKm: 15 },
        categories: ["bread"],
        tags: ["bakery", "traditional", "historic", "hanen", "vestland"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Myrdal Gård Ysteri — Tysnes",
        description: "Prisbelønt ostegård drevet av Jasper og Nynke van Schaik. Geite- og kumelkost. Gårdsbutikk med ost, is, yoghurt, syltetøy, bakevarer, kjøtt. Restaurant med vedovnspizza (50 plasser). Lundegrend, Tysnes, 1,5 timer fra Bergen.",
        provider: "Myrdal Gård",
        contactEmail: "post@myrdalgard.no",
        url: "https://www.myrdalgard.no/en-gb",
        skills: [{
                id: "sell-cheese-myrdal",
                name: "Myrdal Gård ost og gårdsbutikk Tysnes",
                description: "Håndlaget geite- og kumelkost, is, yoghurt og gårdspizza.",
                tags: ["ost", "ysteri", "tysnes", "geit", "is", "restaurant"],
            }],
        role: "producer",
        location: { lat: 60.0350, lng: 5.7000, city: "Tysnes", radiusKm: 15 },
        categories: ["dairy", "bread", "preserves"],
        tags: ["cheese-dairy", "farm-shop", "restaurant", "award-winning", "vestland"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Øvre-Eide Gård — Eidsvåg, Bergen",
        description: "Familiedrevet historisk gård (1500-tallet) 5 minutter fra Bergen sentrum. Gårdsbesøk, ridning på norske hesteraser (Dølahest, Fjording). Forhåndsbestilling kreves.",
        provider: "Øvre-Eide Gård",
        contactEmail: "post@ovre-eide.no",
        url: "https://www.ovre-eide.no",
        skills: [{
                id: "visit-farm-ovre-eide",
                name: "Besøksgård Øvre-Eide Bergen",
                description: "Historisk besøksgård med ridning og dyr nær Bergen sentrum.",
                tags: ["besøksgård", "bergen", "ridning", "historisk", "hest"],
            }],
        role: "producer",
        location: { lat: 60.4250, lng: 5.3650, city: "Bergen", radiusKm: 10 },
        categories: ["meat", "eggs"],
        tags: ["visit-farm", "historic", "horseback-riding", "hanen", "bergen"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Bøtun Gård — Indre Hafslo, Luster",
        description: "Økologisk gård 240 moh. med 80+ sorter grønnsaker og blomster. Debio-sertifisert. Selvbetjent gårdsbutikk hele året. Sommerkafé. Produserer økologiske grønnsaker (juni-oktober), marmelade, syltetøy, urteoljer, pickles, fermenterte grønnsaker. Kurs i dyrking og surdeigsbaking.",
        provider: "Bøtun Gård",
        contactEmail: "post@botun.no",
        url: "https://www.hanen.no/bedrift/2694",
        skills: [{
                id: "sell-organic-botun",
                name: "Økologisk gård Bøtun Luster",
                description: "80+ grønnsaksorter, fermenterte produkter, kurs. Debio-sertifisert.",
                tags: ["økologisk", "luster", "grønnsaker", "fermentert", "debio"],
            }],
        role: "producer",
        location: { lat: 61.2050, lng: 7.2600, city: "Luster", radiusKm: 20 },
        categories: ["vegetables", "preserves", "herbs"],
        tags: ["organic", "debio", "farm-shop", "self-service", "courses", "vestland"],
    });
    // ════════════════════════════════════════════════════════════
    // C) TRONDHEIM/TRØNDELAG — YSTERIER, MARKEDER OG GÅRDSBUTIKKER
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Trondheim/Trøndelag — ysterier og gårdsbutikker...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Lager 11 Street Food — Trondheim",
        description: "Matmarked i industribygg med 8 internasjonale street food-boder drevet av innvandrerentreprenører. Gresk souvlaki, chilenske empanadas, vietnamesisk banh mi, indisk curry. QR-kodebestilling. Sluppenvegen 11, Trondheim.",
        provider: "Lager 11",
        contactEmail: "post@lager11.no",
        url: "https://lager11.no/",
        skills: [{
                id: "sell-streetfood-lager11",
                name: "Lager 11 matmarked Trondheim",
                description: "Internasjonalt street food-marked med 8 boder.",
                tags: ["matmarked", "street-food", "trondheim", "internasjonalt", "sluppen"],
            }],
        role: "producer",
        location: { lat: 63.4227, lng: 10.4048, city: "Trondheim", radiusKm: 5 },
        categories: ["vegetables", "meat", "bread"],
        tags: ["food-hall", "street-food", "multicultural", "market"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Låvbrua Gårdsbutikk — Melhus",
        description: "Gårdsbutikk på Haugen gård ved Kvål, Melhus. Skiltet fra E6. Lokal mat og gårdsprodukter. Medlem av 'Smak og Opplev Melhus' og HANEN.",
        provider: "Låvbrua / Haugen gård",
        contactEmail: "post@haugengaard.com",
        url: "https://www.haugengaard.com/",
        skills: [{
                id: "sell-farm-lavbrua",
                name: "Gårdsbutikk Låvbrua Melhus",
                description: "Lokal gårdsmat langs E6 ved Melhus.",
                tags: ["gårdsbutikk", "melhus", "trøndelag", "hanen", "e6"],
            }],
        role: "producer",
        location: { lat: 63.1889, lng: 10.4461, city: "Melhus", radiusKm: 15 },
        categories: ["vegetables", "meat", "preserves"],
        tags: ["farm-shop", "hanen", "trondelag", "melhus"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Dalebro Gård — Fosen, Trøndelag",
        description: "Gårdsbutikk med selvbetjening, åpent hele året 08-23. Selger lokale produsentprodukter fra Fosen og Trøndelag. Egne bær, grønnsaker (ferske i sesong + foredlet: juice, syltetøy, gelé).",
        provider: "Dalebro Gård",
        contactEmail: "post@dalebro.no",
        url: "https://dalebro.no/",
        skills: [{
                id: "sell-farm-dalebro",
                name: "Gårdsbutikk Dalebro Fosen",
                description: "Selvbetjent gårdsbutikk med lokale produkter fra Fosen/Trøndelag.",
                tags: ["gårdsbutikk", "fosen", "selvbetjent", "bær", "grønnsaker"],
            }],
        role: "producer",
        location: { lat: 63.8789, lng: 9.5203, city: "Fosen", radiusKm: 20 },
        categories: ["fruit", "vegetables", "preserves"],
        tags: ["farm-shop", "self-service", "fosen", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Potetrampa (Gulhuset) — Stjørdal",
        description: "Gårdsutsalg åpent daglig 06-23. Fryst brød, pizza, lasagne, fiskeprodukter, egg. Mellomriksveien 579, Stjørdal, 5 km øst ved E14.",
        provider: "Potetrampa",
        contactEmail: "post@potetrampa.no",
        url: "https://potetrampa.no/",
        skills: [{
                id: "sell-farm-potetrampa",
                name: "Potetrampa gårdsutsalg Stjørdal",
                description: "Dagligåpent gårdsutsalg med bakevarer, fisk og egg.",
                tags: ["gårdsutsalg", "stjørdal", "bakevarer", "egg", "fisk"],
            }],
        role: "producer",
        location: { lat: 63.4668, lng: 11.0065, city: "Stjørdal", radiusKm: 10 },
        categories: ["bread", "eggs", "fish"],
        tags: ["farm-shop", "self-service", "stjordal", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Vikhammer Andelsgård SA — Malvik",
        description: "Andelslandbruk grunnlagt 2016, nesten 50 medlemmer. Økologisk grønnsaksproduksjon på 11 dekar med utsikt over Trondheimsfjorden. Malvik kommune.",
        provider: "Vikhammer Andelsgård",
        contactEmail: "post@vikhammerandelsgard.no",
        url: "https://vikhammerandelsgard.no/",
        skills: [{
                id: "sell-csa-vikhammer",
                name: "Andelslandbruk Vikhammer Malvik",
                description: "Økologisk andelslandbruk med grønnsaker. Medlemsmodell.",
                tags: ["andelslandbruk", "malvik", "økologisk", "grønnsaker", "csa"],
            }],
        role: "producer",
        location: { lat: 63.3889, lng: 10.3205, city: "Malvik", radiusKm: 10 },
        categories: ["vegetables"],
        tags: ["csa", "organic", "community", "trondelag", "malvik"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Gangstad Gårdsysteri — Inderøy",
        description: "Prisbelønt gårdsysteri og kafé. Produserer Nidelven Blå — kåret til verdens beste ost 2023 (World Cheese Awards). Tredje generasjon bønder Maren og Ole Gangstad. Etablert 1998, første godkjente gårdsysteri på kumelk i Norge. Den Gylne Omvei, Inderøy.",
        provider: "Gangstad Gårdsysteri",
        contactEmail: "post@gangstad.no",
        url: "https://www.visitnorway.com/listings/gangstad-g%C3%A5rdsysteri-farm-cheese-dairy/88789/",
        skills: [{
                id: "sell-cheese-gangstad",
                name: "Gangstad Gårdsysteri Inderøy",
                description: "Verdens beste blåmuggost Nidelven Blå, gårdsysteri og kafé.",
                tags: ["ost", "blåmuggost", "inderøy", "gylne-omvei", "prisbelønt"],
            }],
        role: "producer",
        location: { lat: 63.8700, lng: 11.3200, city: "Inderøy", radiusKm: 15 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "award-winning", "golden-road", "hanen", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Grindal Ysteri — Orkdal",
        description: "Gårdsysteri på fjellgård bygget av søstre. Gullmedalje-blåmuggost 'Råblå' (servert Grüne Woche Berlin 2019). Gårdsbutikk + utvalgte utsalgssteder. Orkdalsveien 2181.",
        provider: "Grindal Ysteri",
        contactEmail: "post@grindalysteri.no",
        url: "https://www.facebook.com/grindalysteri",
        skills: [{
                id: "sell-cheese-grindal",
                name: "Grindal Ysteri Orkdal",
                description: "Håndlaget blåmuggost Råblå, gullmedaljevinner.",
                tags: ["ost", "blåmuggost", "orkdal", "gullmedalje", "fjellgård"],
            }],
        role: "producer",
        location: { lat: 62.5894, lng: 10.9843, city: "Orkdal", radiusKm: 15 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "award-winning", "mountain-farm", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Eggen Gardsysteri — Vingelen, Tolga",
        description: "Økologisk gårdsysteri etablert 2001. Direktepumping fra melketank til ostegryte. Debio-sertifisert. Oster: Eggen Fjellost, Fjellblå (gull), Fjellgo' (sølv). Gull/sølv World Cheese Awards 2017. Gårdsbutikk åpen 20. juni – 20. august.",
        provider: "Eggen Gardsysteri",
        contactEmail: "post@eggengardsysteri.no",
        url: "https://www.gaardstur.no/en/gaard/eggen-gardsysteri",
        skills: [{
                id: "sell-cheese-eggen",
                name: "Eggen Gardsysteri økologisk fjellost",
                description: "Debio-sertifisert fjellost og blåmuggost fra Vingelen.",
                tags: ["ost", "økologisk", "vingelen", "tolga", "fjellost", "debio"],
            }],
        role: "producer",
        location: { lat: 62.1894, lng: 11.5234, city: "Tolga", radiusKm: 20 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "organic", "debio", "award-winning", "mountain", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Orkladal Ysteri — Råbygda, Orkdal",
        description: "Gårdsysteri med myk vaska skorpeost, hard modnet, blå, karve- og stekeost. Nygårdsbua gårdsbutikk åpen fredager 10-17, pluss 24-timers selvbetjent butikk. Selger ost + lokale produsenter. Nygårdsveien 10, 7310 Råbygda.",
        provider: "Orkladal Ysteri",
        contactEmail: "post@orkladalysteri.no",
        url: "https://www.orkladalysteri.no/",
        skills: [{
                id: "sell-cheese-orkladal",
                name: "Orkladal Ysteri Nygårdsbua",
                description: "Håndlaget ost med selvbetjent gårdsbutikk. Myk, hard og blåmuggost.",
                tags: ["ost", "ysteri", "orkdal", "gårdsbutikk", "selvbetjent"],
            }],
        role: "producer",
        location: { lat: 63.2750, lng: 9.8600, city: "Orkdal", radiusKm: 15 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "farm-shop", "self-service", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Munkeby Kloster Ysteri — Levanger",
        description: "Moderne trappistkloser (etablert 2009). Munker produserer prisbelønt Munkeby-ost etter tradisjonell oppskrift fra morklosteret Cîteaux (Frankrike). Håndvasket daglig i 7 ukers modning. Super Gold ved World Cheese Awards 2018.",
        provider: "Munkeby Kloster",
        contactEmail: "post@munkeby.no",
        url: "https://www.visitnorway.com/listings/munkeby-monastery-ruins/200214/",
        skills: [{
                id: "sell-cheese-munkeby",
                name: "Munkeby Kloster ost Levanger",
                description: "Trappistost fra norsk kloster, Super Gold WCA 2018.",
                tags: ["ost", "kloster", "munkeby", "levanger", "trappist", "prisbelønt"],
            }],
        role: "producer",
        location: { lat: 63.8945, lng: 11.1289, city: "Levanger", radiusKm: 15 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "monastery", "award-winning", "innherred", "trondelag"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Humstad Gård — Åfjord",
        description: "Familiemelkegård med gårdsbutikk. Produserer og selger kjøttprodukter, honning, juice pluss varer fra andre lokale småbedrifter. Grupper etter avtale. Humstadveien 265, 7170 Åfjord.",
        provider: "Humstad Gård",
        contactEmail: "post@humstadgard.no",
        url: "https://humstadgard.no/",
        skills: [{
                id: "sell-farm-humstad",
                name: "Gårdsbutikk Humstad Åfjord",
                description: "Kjøttprodukter, honning og juice fra melkegård i Åfjord.",
                tags: ["gårdsbutikk", "åfjord", "kjøtt", "honning", "melkegård"],
            }],
        role: "producer",
        location: { lat: 63.8901, lng: 9.6234, city: "Åfjord", radiusKm: 15 },
        categories: ["meat", "honey", "preserves"],
        tags: ["farm-shop", "dairy-farm", "trondelag", "fosen"],
    });
    // ════════════════════════════════════════════════════════════
    // D) KRISTIANSAND/AGDER — PRODUSENTER OG MATMARKEDER
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Kristiansand/Agder — produsenter og matmarkeder...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Austlid Frilandsgartneri — Kristiansand",
        description: "Frilandsgartneriet med kafé-butikk ved Nidelva. Tove Anita og Dag Øyvind Jensen dyrker og konserverer grønnsaker, urter og bær. Prisbelønt gresskar-pickle og portulakk-pickle i 'Smaken av Norge'. Populære egg.",
        provider: "Austlid Frilandsgartneri",
        contactEmail: "post@austlid.no",
        url: "https://www.facebook.com/AustlidFrilandsgartneri",
        skills: [{
                id: "sell-farm-austlid",
                name: "Austlid Frilandsgartneri Kristiansand",
                description: "Grønnsaker, urter, bær og prisbelønte pickles fra Kristiansand.",
                tags: ["gartneri", "kristiansand", "grønnsaker", "pickles", "agder"],
            }],
        role: "producer",
        location: { lat: 58.1500, lng: 8.0000, city: "Kristiansand", radiusKm: 10 },
        categories: ["vegetables", "herbs", "eggs", "preserves"],
        tags: ["farm", "award-winning", "pickles", "organic", "agder"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Matkjelleren Lillemarkens — Kristiansand",
        description: "Matmarked i 1. etasje på Lillemarkens kjøpesenter. Over 10.000 varer: fersk sjømat, vilt, ost, spekemat, lokale produkter og lunsjretter. Markens gate 25B, Kristiansand. Åpent man-lør.",
        provider: "Matkjelleren",
        contactEmail: "post@lillemarkens.no",
        url: "https://www.lillemarkens.no/landing/matkjelleren",
        skills: [{
                id: "sell-market-matkjelleren",
                name: "Matkjelleren matmarked Kristiansand",
                description: "Matmarked med sjømat, ost, vilt og lokale produkter.",
                tags: ["matmarked", "kristiansand", "sjømat", "ost", "lokalt"],
            }],
        role: "producer",
        location: { lat: 58.1462, lng: 7.9954, city: "Kristiansand", radiusKm: 5 },
        categories: ["fish", "dairy", "meat", "preserves"],
        tags: ["food-hall", "market", "seafood", "cheese", "agder"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Reinhartsen Fiskebrygga — Kristiansand",
        description: "Etablert 1931, prisbelønt fiskerøykeri. 17 gull, 8 sølv, 5 bronsemedaljer i Norsk Sjømat-mesterskap. Varmrøkt laks og makrell har 'Matmerk' spesialmerke. Historisk plassering på Fiskebrygga.",
        provider: "Reinhartsen",
        contactEmail: "post@reinhartsen.no",
        url: "https://www.visitnorway.com/listings/reinhartsen-at-the-fish-market/86330/",
        skills: [{
                id: "sell-fish-reinhartsen",
                name: "Reinhartsen røykeri Fiskebrygga",
                description: "Prisbelønt røykfisk fra Kristiansand, etablert 1931.",
                tags: ["røykeri", "fisk", "kristiansand", "fiskebrygga", "tradisjonell"],
            }],
        role: "producer",
        location: { lat: 58.1410, lng: 7.9920, city: "Kristiansand", radiusKm: 5 },
        categories: ["fish"],
        tags: ["smokery", "award-winning", "historic", "seafood", "agder"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Lista Lamb — Agder",
        description: "Gårdsbutikk med kvalitetslam i tradisjonelle og moderne varianter. Lammekjøtt fra Lista-området.",
        provider: "Lista Lamb",
        contactEmail: "post@listalamb.no",
        url: "https://www.hanen.no/en/utforsk/32/agder",
        skills: [{
                id: "sell-meat-listalamb",
                name: "Lista Lamb lammekjøtt Agder",
                description: "Kvalitetslam fra Lista-halvøya.",
                tags: ["lam", "kjøtt", "lista", "agder", "gårdsbutikk"],
            }],
        role: "producer",
        location: { lat: 58.1100, lng: 6.7500, city: "Lista", radiusKm: 20 },
        categories: ["meat"],
        tags: ["lamb", "farm-shop", "hanen", "agder"],
    });
    // ════════════════════════════════════════════════════════════
    // E) BODØ/LOFOTEN — UTVIDELSE
    // ════════════════════════════════════════════════════════════
    console.log("   📍 Bodø/Lofoten — utvidelse...");
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Brødrene Berbusmel — Bodø",
        description: "Håndverksbakeri med kafé og delikatesse, åpnet 2018 av brødrene Ola (baker) og Lars (kokk). Fokus på lokale råvarer: svinekjøtt fra Solvold, lam fra Røst, ost fra Beiarn og Lofoten, Arktisk Salt, Lofoten-tang. To lokasjoner i Bodø sentrum.",
        provider: "Brødrene Berbusmel",
        contactEmail: "post@berbusmel.no",
        url: "https://www.berbusmel.no/",
        skills: [{
                id: "sell-bakery-berbusmel",
                name: "Brødrene Berbusmel bakeri Bodø",
                description: "Håndverksbrød, spekemat, ost og lokale delikatesser fra Nordland.",
                tags: ["bakeri", "bodø", "håndverk", "delikatesse", "lokal-mat"],
            }],
        role: "producer",
        location: { lat: 67.2804, lng: 14.4049, city: "Bodø", radiusKm: 5 },
        categories: ["bread", "meat", "dairy", "preserves"],
        tags: ["bakery", "deli", "local-sourced", "nordland", "bodo"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Aalan Gård — Bøstad, Lofoten",
        description: "Økologisk geiteostgård etablert 1951 med 200 melkegeiter. Prisbelønte oster. Gårdsbutikk med kafé (sommer). Debio-sertifisert. Lauvdalen 186, 8360 Bøstad.",
        provider: "Aalan Gård",
        contactEmail: "post@aalangard.no",
        url: "https://visitlofoten.com/en/activity/farm-experiences/aalan-farm/",
        skills: [{
                id: "sell-cheese-aalan",
                name: "Aalan Gård geiteost Lofoten",
                description: "Økologisk geiteost fra 200 melkegeiter i Lofoten.",
                tags: ["geiteost", "lofoten", "økologisk", "bøstad", "debio"],
            }],
        role: "producer",
        location: { lat: 68.2200, lng: 13.9800, city: "Bøstad", radiusKm: 15 },
        categories: ["dairy"],
        tags: ["cheese-dairy", "organic", "debio", "goat", "lofoten", "hanen"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Lofoten Gårdsysteri — Bøstad",
        description: "Økologisk gård med geiter, griser, høner. Gårdsbutikk og kafé tilknyttet osteproduksjonen. Lag-din-egen-ost-opplevelse. 3 km før Unstad fra E10. Saupstadveien 235, 8360 Bøstad. Åpent man-lør 11-17.",
        provider: "Lofoten Gårdsysteri",
        contactEmail: "post@lofoten-gardsysteri.no",
        url: "https://visitlofoten.com/en/activity/farm-experiences/lofoten-gardsysteri-farmshop-and-farmcafe/",
        skills: [{
                id: "sell-cheese-lofoten-gardsysteri",
                name: "Lofoten Gårdsysteri ost og kafé",
                description: "Økologisk hvitost, kjøtt og pølser med gårdsopplevelse i Lofoten.",
                tags: ["ost", "lofoten", "gårdsysteri", "økologisk", "opplevelse"],
            }],
        role: "producer",
        location: { lat: 68.2350, lng: 13.9500, city: "Bøstad", radiusKm: 15 },
        categories: ["dairy", "meat"],
        tags: ["cheese-dairy", "organic", "farm-experience", "lofoten"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Livland Gård — Laukvik, Lofoten",
        description: "Gård med vikingsau, restaurant, gårdsbutikk og foredlingsanlegg. Drevet av Roy Inge Eilertsen. Farm-to-table med egenprodusert lam og lokale produkter. 25 km nord for Svolvær.",
        provider: "Livland Gård",
        contactEmail: "post@livland.no",
        url: "https://www.livland.no",
        skills: [{
                id: "sell-farm-livland",
                name: "Livland Gård vikingsau Lofoten",
                description: "Vikingsaulam og lokale produkter med restaurant i Lofoten.",
                tags: ["lam", "vikingsau", "lofoten", "restaurant", "farm-to-table"],
            }],
        role: "producer",
        location: { lat: 68.3800, lng: 14.5700, city: "Laukvik", radiusKm: 15 },
        categories: ["meat"],
        tags: ["farm-shop", "restaurant", "viking-sheep", "lofoten", "farm-to-table"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Polarhagen — Leknes, Lofoten",
        description: "Vegansk, økologisk arktisk gård med 170 dekar. Bygger 180 kvm drivhus. Eier Parsa er også pizzabaker. Grønnsaker juni-oktober. FarmStay-overnatting. Pizzakvelder med gårdsomvisning. Voieveien 180, Leknes.",
        provider: "Polarhagen",
        contactEmail: "post@polarhagen.no",
        url: "https://polarhagen.no/",
        skills: [{
                id: "sell-veg-polarhagen",
                name: "Polarhagen økologisk arktisk gård Leknes",
                description: "Vegansk økologisk gård med sesonggrønnsaker og pizzakvelder.",
                tags: ["økologisk", "vegansk", "leknes", "lofoten", "arktisk"],
            }],
        role: "producer",
        location: { lat: 68.1460, lng: 13.6100, city: "Leknes", radiusKm: 10 },
        categories: ["vegetables"],
        tags: ["organic", "vegan", "arctic-farming", "lofoten", "greenhouse"],
    });
    marketplace_registry_1.marketplaceRegistry.register({
        name: "Aimees Farm — Stamsund, Lofoten",
        description: "Gård mellom Stamsund og Leknes med gressfôret skotsk høylandsfe, frittgående griser og Lofotlam (beskyttet geografisk betegnelse). Gårdsomvisning og femrettersmiddag med egne råvarer. Valbergsveien 48, 8340 Stamsund.",
        provider: "Aimees Farm",
        contactEmail: "post@aimeesfarm.no",
        url: "https://www.gettyourguide.com/lofoten-islands-l95198/lofoten-stamsund-and-leknes-aimees-farm-experience-t525046/",
        skills: [{
                id: "sell-farm-aimees",
                name: "Aimees Farm restaurant Lofoten",
                description: "Highland-fe, Lofotlam og grisekjøtt med gårdsopplevelse.",
                tags: ["gård", "lofoten", "highland", "lofotlam", "restaurant"],
            }],
        role: "producer",
        location: { lat: 68.1980, lng: 13.8200, city: "Stamsund", radiusKm: 15 },
        categories: ["meat"],
        tags: ["farm-restaurant", "highland-cattle", "lofoten", "farm-experience"],
    });
    // ════════════════════════════════════════════════════════════
    // Summary
    // ════════════════════════════════════════════════════════════
    const afterCount = marketplace_registry_1.marketplaceRegistry.getActiveAgents().length;
    console.log(`\n   ✅ Expansion v8 complete.`);
    console.log(`   📊 Total agents in registry: ${afterCount}`);
    console.log(`   🆕 Added: ~30 new agents`);
    console.log(`      • Oslo/Romerike: 8 (BesteFarHuset, Roma, Fiori, Keiser, Folvell, Rønningen, Lenas, Follo Grønt)`);
    console.log(`      • Bergen/Hardanger: 7 (Hardangerbonden, Aga Sideri, Hardanger Saft, Engevik, Myrdal, Øvre-Eide, Bøtun)`);
    console.log(`      • Trondheim/Trøndelag: 10 (Lager 11, Låvbrua, Dalebro, Potetrampa, Vikhammer, Gangstad, Grindal, Eggen, Orkladal, Munkeby, Humstad)`);
    console.log(`      • Kristiansand/Agder: 4 (Austlid, Matkjelleren, Reinhartsen, Lista Lamb)`);
    console.log(`      • Bodø/Lofoten: 6 (Berbusmel, Aalan, Lofoten Gårdsysteri, Livland, Polarhagen, Aimees)\n`);
}
//# sourceMappingURL=seed-expansion-v8.js.map