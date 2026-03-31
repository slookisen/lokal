import { producerAgent } from "./services/producer-agent";
import { store } from "./services/store";
import { ChainPrice } from "./models";

// ─── Seed Data: Realistic Oslo Producers ───────────────────────
// These are fictional but realistic local food producers in Oslo.
// Locations are real Oslo neighborhoods. Prices reflect actual
// Norwegian market rates as of 2026.

export function seedData() {
  // ─── Producer 1: Aker Gård (Farm in Nordre Aker) ──────────
  const aker = producerAgent.register({
    name: "Aker Gård",
    type: "farm",
    description: "Familiegård med økologiske grønnsaker siden 1987",
    location: {
      lat: 59.9500,
      lng: 10.7700,
      city: "Oslo",
      district: "Nordre Aker",
      address: "Maridalsveien 232",
    },
    tags: ["organic", "seasonal", "family-run", "pesticide-free"],
    certifications: ["debio-organic"],
    deliveryOptions: ["pickup", "local-delivery"],
    maxDeliveryRadiusKm: 8,
    openingHours: [
      { day: "mon", open: "08:00", close: "16:00" },
      { day: "tue", open: "08:00", close: "16:00" },
      { day: "wed", open: "08:00", close: "16:00" },
      { day: "thu", open: "08:00", close: "16:00" },
      { day: "fri", open: "08:00", close: "16:00" },
      { day: "sat", open: "09:00", close: "14:00" },
    ],
    contactPhone: "+47 900 00 001",
  });

  const akerTomater = producerAgent.addProduct({
    producerId: aker.id,
    name: "Tomater",
    category: "vegetables",
    unit: "kg",
    isOrganic: true,
    isSeasonal: true,
    description: "Norske frilandstomater, flere sorter",
    growingMethod: "outdoor",
  });

  const akerGulrot = producerAgent.addProduct({
    producerId: aker.id,
    name: "Gulrøtter",
    category: "vegetables",
    unit: "kg",
    isOrganic: true,
    isSeasonal: true,
    growingMethod: "outdoor",
  });

  const akerUrter = producerAgent.addProduct({
    producerId: aker.id,
    name: "Friske urter (blanding)",
    category: "herbs",
    unit: "bunch",
    isOrganic: true,
    isSeasonal: true,
  });

  const akerEgg = producerAgent.addProduct({
    producerId: aker.id,
    name: "Frittgående egg",
    category: "eggs",
    unit: "box",
    isOrganic: true,
    description: "12-pakning fra frittgående høner",
  });

  // ─── Producer 2: Grønland Grønt (Shop in Grønland) ────────
  const gronland = producerAgent.register({
    name: "Grønland Grønt",
    type: "shop",
    description: "Grønnsaksbutikk med daglige leveranser fra lokale bønder",
    location: {
      lat: 59.9127,
      lng: 10.7600,
      city: "Oslo",
      district: "Grønland",
      address: "Tøyengata 12",
    },
    tags: ["daily-fresh", "local-sourced", "affordable"],
    certifications: [],
    deliveryOptions: ["pickup"],
    openingHours: [
      { day: "mon", open: "07:00", close: "19:00" },
      { day: "tue", open: "07:00", close: "19:00" },
      { day: "wed", open: "07:00", close: "19:00" },
      { day: "thu", open: "07:00", close: "19:00" },
      { day: "fri", open: "07:00", close: "19:00" },
      { day: "sat", open: "08:00", close: "17:00" },
    ],
    contactPhone: "+47 900 00 002",
  });

  const gronTomater = producerAgent.addProduct({
    producerId: gronland.id,
    name: "Tomater",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Ferske norske tomater, daglig levering",
  });

  const gronAgurk = producerAgent.addProduct({
    producerId: gronland.id,
    name: "Agurk",
    category: "vegetables",
    unit: "piece",
    isOrganic: false,
    isSeasonal: true,
  });

  const gronEpler = producerAgent.addProduct({
    producerId: gronland.id,
    name: "Norske epler",
    category: "fruits",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Blandede sorter fra Hardanger",
  });

  // ─── Producer 3: Løkka Honning (Urban garden in Grünerløkka)
  const lokka = producerAgent.register({
    name: "Løkka Honning & Urter",
    type: "garden",
    description: "Byhage på Grünerløkka med honning og urter",
    location: {
      lat: 59.9226,
      lng: 10.7580,
      city: "Oslo",
      district: "Grünerløkka",
      address: "Markveien 58b",
    },
    tags: ["urban-garden", "honey", "herbs", "sustainable"],
    certifications: [],
    deliveryOptions: ["pickup"],
    openingHours: [
      { day: "wed", open: "15:00", close: "19:00" },
      { day: "sat", open: "10:00", close: "15:00" },
    ],
    contactPhone: "+47 900 00 003",
  });

  const lokkaHonning = producerAgent.addProduct({
    producerId: lokka.id,
    name: "Lokal honning",
    category: "honey",
    unit: "piece", // jar
    isOrganic: false,
    isSeasonal: true,
    description: "Rå honning fra birøkt på Grünerløkka, 350g glass",
  });

  const lokkaBasilikum = producerAgent.addProduct({
    producerId: lokka.id,
    name: "Basilikum",
    category: "herbs",
    unit: "bunch",
    isOrganic: true,
    isSeasonal: true,
    growingMethod: "outdoor",
  });

  // ─── Producer 4: Nordre Åker Andelsgård (Cooperative) ──────
  const andel = producerAgent.register({
    name: "Nordre Åker Andelsgård",
    type: "cooperative",
    description: "Andelsjordbruk med ukentlige grønnsakskasser",
    location: {
      lat: 59.9450,
      lng: 10.7800,
      city: "Oslo",
      district: "Storo",
      address: "Sandakerveien 99",
    },
    tags: ["cooperative", "seasonal", "organic", "subscription"],
    certifications: ["debio-organic"],
    deliveryOptions: ["pickup", "local-delivery"],
    maxDeliveryRadiusKm: 5,
    openingHours: [
      { day: "thu", open: "14:00", close: "18:00" },
      { day: "sat", open: "09:00", close: "13:00" },
    ],
    contactPhone: "+47 900 00 004",
  });

  const andelPoteter = producerAgent.addProduct({
    producerId: andel.id,
    name: "Nypoteter",
    category: "vegetables",
    unit: "kg",
    isOrganic: true,
    isSeasonal: true,
    growingMethod: "outdoor",
  });

  const andelGronkaal = producerAgent.addProduct({
    producerId: andel.id,
    name: "Grønnkål",
    category: "vegetables",
    unit: "bunch",
    isOrganic: true,
    isSeasonal: true,
  });

  const andelJordbaer = producerAgent.addProduct({
    producerId: andel.id,
    name: "Jordbær",
    category: "berries",
    unit: "box",
    isOrganic: true,
    isSeasonal: true,
    description: "500g kurv, plukket for hånd",
  });

  // ─── Producer 5: Bygdøy Frukt & Bær ──────────────────────
  const bygdoy = producerAgent.register({
    name: "Bygdøy Frukt & Bær",
    type: "farm",
    description: "Fruktgård på Bygdøy med epler, plommer og bær",
    location: {
      lat: 59.9050,
      lng: 10.6850,
      city: "Oslo",
      district: "Bygdøy",
      address: "Bygdøynesveien 15",
    },
    tags: ["fruits", "berries", "traditional", "scenic"],
    certifications: ["nyt-norge"],
    deliveryOptions: ["pickup"],
    openingHours: [
      { day: "fri", open: "10:00", close: "17:00" },
      { day: "sat", open: "10:00", close: "16:00" },
      { day: "sun", open: "11:00", close: "15:00" },
    ],
  });

  const bygdoyEpler = producerAgent.addProduct({
    producerId: bygdoy.id,
    name: "Epler (Gravenstein)",
    category: "fruits",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Klassiske norske Gravenstein-epler",
  });

  const bygdoyPlommer = producerAgent.addProduct({
    producerId: bygdoy.id,
    name: "Plommer",
    category: "fruits",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
  });

  // ─── Producer 6: Nordlys Dagligvarer (Oppsal) ──────────────
  // Daniel's local shop — a neighborhood grocery with great produce
  const nordlys = producerAgent.register({
    name: "Nordlys Dagligvarer",
    type: "shop",
    description: "Nabolagsbutikk på Oppsal med ferske, rimelige grønnsaker og frukt fra lokale leverandører",
    location: {
      lat: 59.8916,
      lng: 10.8310,
      city: "Oslo",
      district: "Oppsal",
      address: "Vetlandsveien 49",
    },
    tags: ["affordable", "local-sourced", "neighborhood", "fresh-daily", "variety"],
    certifications: [],
    deliveryOptions: ["pickup", "local-delivery"],
    maxDeliveryRadiusKm: 3,
    openingHours: [
      { day: "mon", open: "08:00", close: "20:00" },
      { day: "tue", open: "08:00", close: "20:00" },
      { day: "wed", open: "08:00", close: "20:00" },
      { day: "thu", open: "08:00", close: "20:00" },
      { day: "fri", open: "08:00", close: "20:00" },
      { day: "sat", open: "09:00", close: "18:00" },
    ],
    contactPhone: "+47 900 00 006",
  });

  // Nordlys has a great variety — including specific tomato and potato types
  const nordlysCherryTomat = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Tomater (Cherry)",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Norske cherrytomater, søte og saftige",
  });

  const nordlysBifftomat = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Tomater (Bifftomat)",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Store, kjøttfulle bifftomater fra norsk drivhus",
  });

  const nordlysMandelpoteter = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Poteter (Mandel)",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Norske mandelpoteter, faste og gode til koking",
  });

  const nordlysGulloye = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Poteter (Gulløye)",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Gulløye — klassisk norsk potet, perfekt til baking og mos",
  });

  const nordlysEpler = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Epler (Summerred)",
    category: "fruits",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
    description: "Norske Summerred-epler, søte og sprø",
  });

  const nordlysAgurk = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Agurk",
    category: "vegetables",
    unit: "piece",
    isOrganic: false,
    isSeasonal: true,
  });

  const nordlysSalat = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Salat (Romaine)",
    category: "vegetables",
    unit: "piece",
    isOrganic: false,
    isSeasonal: true,
    description: "Fersk romaine-salat, sprø og perfekt til caesar",
  });

  const nordlysLok = producerAgent.addProduct({
    producerId: nordlys.id,
    name: "Løk (Rødløk)",
    category: "vegetables",
    unit: "kg",
    isOrganic: false,
    isSeasonal: true,
  });

  // ─── LIVE INVENTORY (what they have TODAY) ─────────────────
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  // Aker Gård
  producerAgent.updateInventory({
    productId: akerTomater.id, producerId: aker.id,
    quantityAvailable: 40, pricePerUnit: 35,
    harvestedAt: hoursAgo(3), availableUntilHours: 10,
  });
  producerAgent.updateInventory({
    productId: akerGulrot.id, producerId: aker.id,
    quantityAvailable: 25, pricePerUnit: 22,
    harvestedAt: hoursAgo(5), availableUntilHours: 24,
  });
  producerAgent.updateInventory({
    productId: akerUrter.id, producerId: aker.id,
    quantityAvailable: 30, pricePerUnit: 25,
    harvestedAt: hoursAgo(2), availableUntilHours: 8,
  });
  producerAgent.updateInventory({
    productId: akerEgg.id, producerId: aker.id,
    quantityAvailable: 15, pricePerUnit: 55,
    harvestedAt: hoursAgo(6), availableUntilHours: 48,
  });

  // Grønland Grønt
  producerAgent.updateInventory({
    productId: gronTomater.id, producerId: gronland.id,
    quantityAvailable: 60, pricePerUnit: 29,
    harvestedAt: hoursAgo(8), availableUntilHours: 12,
  });
  producerAgent.updateInventory({
    productId: gronAgurk.id, producerId: gronland.id,
    quantityAvailable: 40, pricePerUnit: 15,
    harvestedAt: hoursAgo(6), availableUntilHours: 12,
  });
  producerAgent.updateInventory({
    productId: gronEpler.id, producerId: gronland.id,
    quantityAvailable: 30, pricePerUnit: 32,
    harvestedAt: hoursAgo(24), availableUntilHours: 48,
  });

  // Løkka Honning
  producerAgent.updateInventory({
    productId: lokkaHonning.id, producerId: lokka.id,
    quantityAvailable: 8, pricePerUnit: 120,
    availableUntilHours: 168, // 1 week
  });
  producerAgent.updateInventory({
    productId: lokkaBasilikum.id, producerId: lokka.id,
    quantityAvailable: 20, pricePerUnit: 20,
    harvestedAt: hoursAgo(1), availableUntilHours: 6,
  });

  // Nordre Åker Andelsgård
  producerAgent.updateInventory({
    productId: andelPoteter.id, producerId: andel.id,
    quantityAvailable: 50, pricePerUnit: 18,
    harvestedAt: hoursAgo(4), availableUntilHours: 48,
  });
  producerAgent.updateInventory({
    productId: andelGronkaal.id, producerId: andel.id,
    quantityAvailable: 15, pricePerUnit: 30,
    harvestedAt: hoursAgo(3), availableUntilHours: 24,
  });
  producerAgent.updateInventory({
    productId: andelJordbaer.id, producerId: andel.id,
    quantityAvailable: 20, pricePerUnit: 60,
    harvestedAt: hoursAgo(2), availableUntilHours: 8,
  });

  // Nordlys Dagligvarer — great prices, big variety
  producerAgent.updateInventory({
    productId: nordlysCherryTomat.id, producerId: nordlys.id,
    quantityAvailable: 30, pricePerUnit: 32,
    harvestedAt: hoursAgo(10), availableUntilHours: 14,
  });
  producerAgent.updateInventory({
    productId: nordlysBifftomat.id, producerId: nordlys.id,
    quantityAvailable: 20, pricePerUnit: 38,
    harvestedAt: hoursAgo(10), availableUntilHours: 14,
  });
  producerAgent.updateInventory({
    productId: nordlysMandelpoteter.id, producerId: nordlys.id,
    quantityAvailable: 40, pricePerUnit: 24,
    harvestedAt: hoursAgo(18), availableUntilHours: 48,
  });
  producerAgent.updateInventory({
    productId: nordlysGulloye.id, producerId: nordlys.id,
    quantityAvailable: 35, pricePerUnit: 20,
    harvestedAt: hoursAgo(18), availableUntilHours: 48,
  });
  producerAgent.updateInventory({
    productId: nordlysEpler.id, producerId: nordlys.id,
    quantityAvailable: 25, pricePerUnit: 30,
    harvestedAt: hoursAgo(24), availableUntilHours: 72,
  });
  producerAgent.updateInventory({
    productId: nordlysAgurk.id, producerId: nordlys.id,
    quantityAvailable: 50, pricePerUnit: 14,
    harvestedAt: hoursAgo(8), availableUntilHours: 24,
  });
  producerAgent.updateInventory({
    productId: nordlysSalat.id, producerId: nordlys.id,
    quantityAvailable: 20, pricePerUnit: 22,
    harvestedAt: hoursAgo(6), availableUntilHours: 12,
  });
  producerAgent.updateInventory({
    productId: nordlysLok.id, producerId: nordlys.id,
    quantityAvailable: 30, pricePerUnit: 18,
    harvestedAt: hoursAgo(24), availableUntilHours: 96,
  });

  // Bygdøy Frukt & Bær
  producerAgent.updateInventory({
    productId: bygdoyEpler.id, producerId: bygdoy.id,
    quantityAvailable: 80, pricePerUnit: 28,
    harvestedAt: hoursAgo(12), availableUntilHours: 72,
  });
  producerAgent.updateInventory({
    productId: bygdoyPlommer.id, producerId: bygdoy.id,
    quantityAvailable: 25, pricePerUnit: 45,
    harvestedAt: hoursAgo(6), availableUntilHours: 24,
  });

  // ─── CHAIN PRICES (for comparison) ─────────────────────────
  // These would be scraped from Oda/Kolonial in production.
  // For MVP, hardcoded from actual Norwegian grocery prices.

  const now = new Date().toISOString();
  const chainPrices: ChainPrice[] = [
    { productName: "tomater", category: "vegetables", chain: "rema-1000", pricePerUnit: 45, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater", category: "vegetables", chain: "kiwi", pricePerUnit: 42, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater", category: "vegetables", chain: "meny", pricePerUnit: 49, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater", category: "vegetables", chain: "coop-extra", pricePerUnit: 44, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater", category: "vegetables", chain: "rema-1000", pricePerUnit: 65, unit: "kg", currency: "NOK", isOrganic: true, scrapedAt: now, source: "manual" },
    { productName: "gulrotter", category: "vegetables", chain: "rema-1000", pricePerUnit: 30, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "gulrotter", category: "vegetables", chain: "kiwi", pricePerUnit: 28, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "gulrotter", category: "vegetables", chain: "rema-1000", pricePerUnit: 45, unit: "kg", currency: "NOK", isOrganic: true, scrapedAt: now, source: "manual" },
    { productName: "agurk", category: "vegetables", chain: "rema-1000", pricePerUnit: 22, unit: "piece", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "agurk", category: "vegetables", chain: "kiwi", pricePerUnit: 20, unit: "piece", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "norske epler", category: "fruits", chain: "rema-1000", pricePerUnit: 40, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "norske epler", category: "fruits", chain: "meny", pricePerUnit: 45, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "epler (gravenstein)", category: "fruits", chain: "rema-1000", pricePerUnit: 42, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "epler (gravenstein)", category: "fruits", chain: "meny", pricePerUnit: 48, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "nypoteter", category: "vegetables", chain: "rema-1000", pricePerUnit: 30, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "nypoteter", category: "vegetables", chain: "rema-1000", pricePerUnit: 42, unit: "kg", currency: "NOK", isOrganic: true, scrapedAt: now, source: "manual" },
    { productName: "gronnkaal", category: "vegetables", chain: "meny", pricePerUnit: 40, unit: "bunch", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "jordbaer", category: "berries", chain: "rema-1000", pricePerUnit: 75, unit: "box", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "jordbaer", category: "berries", chain: "meny", pricePerUnit: 80, unit: "box", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "friske urter (blanding)", category: "herbs", chain: "rema-1000", pricePerUnit: 35, unit: "bunch", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "frittgaende egg", category: "eggs", chain: "rema-1000", pricePerUnit: 70, unit: "box", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "frittgaende egg", category: "eggs", chain: "meny", pricePerUnit: 75, unit: "box", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "lokal honning", category: "honey", chain: "meny", pricePerUnit: 140, unit: "piece", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "basilikum", category: "herbs", chain: "rema-1000", pricePerUnit: 30, unit: "bunch", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "plommer", category: "fruits", chain: "rema-1000", pricePerUnit: 60, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    // Variety-specific chain prices
    { productName: "tomater (cherry)", category: "vegetables", chain: "rema-1000", pricePerUnit: 55, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater (cherry)", category: "vegetables", chain: "kiwi", pricePerUnit: 52, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater (bifftomat)", category: "vegetables", chain: "rema-1000", pricePerUnit: 50, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "tomater (bifftomat)", category: "vegetables", chain: "meny", pricePerUnit: 55, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "poteter (mandel)", category: "vegetables", chain: "rema-1000", pricePerUnit: 35, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "poteter (mandel)", category: "vegetables", chain: "meny", pricePerUnit: 39, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "poteter (gulloye)", category: "vegetables", chain: "rema-1000", pricePerUnit: 32, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "epler (summerred)", category: "fruits", chain: "rema-1000", pricePerUnit: 40, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "epler (summerred)", category: "fruits", chain: "meny", pricePerUnit: 45, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "salat (romaine)", category: "vegetables", chain: "rema-1000", pricePerUnit: 30, unit: "piece", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
    { productName: "lok (rodlok)", category: "vegetables", chain: "rema-1000", pricePerUnit: 25, unit: "kg", currency: "NOK", isOrganic: false, scrapedAt: now, source: "manual" },
  ];

  for (const cp of chainPrices) {
    store.setChainPrice(cp.productName, cp);
  }

  console.log("\n🌱 Lokal — Seed data loaded:");
  console.log(JSON.stringify(store.getStats(), null, 2));
}
