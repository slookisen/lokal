import { marketplaceRegistry } from "./services/marketplace-registry";

// ─── Seed Marketplace with Example Agents ─────────────────────
// These represent the kind of agents that would register on Lokal.
// Mix of producers, logistics, and quality agents — showing the
// ecosystem that builds around the registry.

export function seedMarketplace() {
  console.log("🌱 Seeding marketplace registry...");

  // ─── Producer Agents ──────────────────────────────────────

  marketplaceRegistry.register({
    name: "Aker Gård Agent",
    description: "Økologisk gård på Nordre Aker med grønnsaker, egg og urter. Familiedrevet siden 1952.",
    provider: "Aker Gård AS",
    contactEmail: "post@akergard.no",
    url: "http://localhost:3000/agents/aker-gard",
    skills: [
      {
        id: "sell-vegetables",
        name: "Selg grønnsaker",
        description: "Tomater, poteter, gulrøtter, løk og sesongvarer",
        tags: ["grønnsaker", "tomater", "poteter", "gulrøtter", "løk", "økologisk"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "sell-eggs",
        name: "Selg egg",
        description: "Frittgående høner, dagferske egg",
        tags: ["egg", "frittgående", "fersk"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "producer",
    location: { lat: 59.9500, lng: 10.7700, city: "Oslo", radiusKm: 15 },
    categories: ["vegetables", "eggs", "herbs"],
    tags: ["organic", "seasonal", "family-run", "debio-certified"],
    languages: ["no", "en"],
  });

  marketplaceRegistry.register({
    name: "Grønland Grønt Agent",
    description: "Dagligvarebutikk på Grønland med ferskt, rimelig grønt fra lokale leverandører.",
    provider: "Grønland Grønt",
    contactEmail: "hei@gronlandgront.no",
    url: "http://localhost:3000/agents/gronland-gront",
    skills: [
      {
        id: "sell-fresh-produce",
        name: "Selg ferskvarer",
        description: "Bredt utvalg av frukt, grønt og salater til lave priser",
        tags: ["grønnsaker", "frukt", "salat", "rimelig", "fersk", "daglig"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "producer",
    location: { lat: 59.9127, lng: 10.7600, city: "Oslo", radiusKm: 5 },
    categories: ["vegetables", "fruit"],
    tags: ["budget", "daily-fresh", "local"],
    languages: ["no", "en", "ur", "ar"],
  });

  marketplaceRegistry.register({
    name: "Bygdøy Frukt & Bær Agent",
    description: "Gård på Bygdøy med epler, pærer, jordbær, bringebær og blåbær i sesong.",
    provider: "Bygdøy Frukt & Bær",
    contactEmail: "info@bygdoyfrukt.no",
    url: "http://localhost:3000/agents/bygdoy-frukt",
    skills: [
      {
        id: "sell-fruit",
        name: "Selg frukt og bær",
        description: "Norske epler, pærer og sesongbær direkte fra gården",
        tags: ["frukt", "bær", "epler", "jordbær", "blåbær", "bringebær", "sesong"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "producer",
    location: { lat: 59.9033, lng: 10.6850, city: "Oslo", radiusKm: 10 },
    categories: ["fruit", "berries"],
    tags: ["seasonal", "local", "pesticide-free"],
    languages: ["no"],
  });

  marketplaceRegistry.register({
    name: "Løkka Honning & Urter Agent",
    description: "Urban hage på Grünerløkka med honning fra egne bikuber og ferske urter.",
    provider: "Løkka Honning",
    contactEmail: "hei@lokkahonning.no",
    url: "http://localhost:3000/agents/lokka-honning",
    skills: [
      {
        id: "sell-honey",
        name: "Selg honning",
        description: "Byhonning fra Grünerløkka-bikuber, rå og ubehandlet",
        tags: ["honning", "rå", "urban", "bi"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "sell-herbs",
        name: "Selg urter",
        description: "Ferske urter: basilikum, persille, dill, mynte, timian",
        tags: ["urter", "fersk", "basilikum", "persille", "dill"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "producer",
    location: { lat: 59.9225, lng: 10.7584, city: "Oslo", radiusKm: 3 },
    categories: ["honey", "herbs"],
    tags: ["urban", "handmade", "organic", "small-batch"],
    languages: ["no", "en"],
  });

  marketplaceRegistry.register({
    name: "Nordre Åker Andelsgård Agent",
    description: "Andelsgård ved Storo. Økologiske grønnsaker med abonnementsordning.",
    provider: "Nordre Åker Andelsgård SA",
    contactEmail: "andel@nordreaker.no",
    url: "http://localhost:3000/agents/nordre-aker",
    skills: [
      {
        id: "sell-subscription-box",
        name: "Grønnsakskasse-abonnement",
        description: "Ukentlig kasse med sesonggrønnsaker direkte fra gården",
        tags: ["abonnement", "grønnsakskasse", "sesong", "økologisk"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "sell-vegetables",
        name: "Selg grønnsaker",
        description: "Økologiske grønnsaker: salat, kål, rødbeter, squash",
        tags: ["grønnsaker", "økologisk", "salat", "kål", "rødbeter"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "producer",
    location: { lat: 59.9466, lng: 10.7718, city: "Oslo", radiusKm: 8 },
    categories: ["vegetables"],
    tags: ["organic", "cooperative", "subscription", "debio-certified"],
    languages: ["no"],
  });

  // ─── Non-producer agents (showing ecosystem potential) ─────

  marketplaceRegistry.register({
    name: "Oslo Sykkelbud Agent",
    description: "Bærekraftig sykkelbud-tjeneste for lokale matleveranser i Oslo sentrum.",
    provider: "Oslo Sykkelbud AS",
    contactEmail: "levering@oslosykkelbud.no",
    url: "http://localhost:3001/agents/sykkelbud",
    skills: [
      {
        id: "local-delivery",
        name: "Lokal levering",
        description: "Sykkelbud innen 5km radius fra Oslo sentrum. 30-60 min leveringstid.",
        tags: ["levering", "delivery", "sykkel", "bærekraftig", "rask"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "logistics",
    location: { lat: 59.9139, lng: 10.7522, city: "Oslo", radiusKm: 5 },
    categories: [],
    tags: ["sustainable", "fast", "bicycle", "eco-friendly"],
    languages: ["no", "en"],
  });

  marketplaceRegistry.register({
    name: "Debio Verifikasjon Agent",
    description: "Automatisk verifisering av Debio-sertifisering for norske produsenter.",
    provider: "Debio",
    contactEmail: "api@debio.no",
    url: "http://localhost:3002/agents/debio",
    skills: [
      {
        id: "verify-organic",
        name: "Verifiser økologisk sertifisering",
        description: "Sjekk om en produsent har gyldig Debio-sertifisering",
        tags: ["verifisering", "økologisk", "debio", "sertifikat"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    role: "quality",
    location: { lat: 59.9139, lng: 10.7522, city: "Oslo" },
    categories: [],
    tags: ["certification", "organic", "trust", "verification"],
    languages: ["no", "en"],
  });

  const stats = marketplaceRegistry.getStats();
  console.log(`   ✅ ${stats.totalAgents} agents registered (${stats.activeProducers} producers)`);
  console.log(`   📍 Cities: ${stats.cities.join(", ")}\n`);
}
