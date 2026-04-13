"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedKnowledge = seedKnowledge;
const init_1 = require("./database/init");
const knowledge_service_1 = require("./services/knowledge-service");
// ─── Knowledge Enrichment Seed ──────────────────────────────
// Auto-populates the agent_knowledge table for all registered agents.
//
// Strategy: We derive rich knowledge from what we already know:
//   1. Agent name reveals type (REKO, Bondens marked, Gårdsbutikk, etc.)
//   2. Categories tell us what products they likely sell
//   3. City tells us what payment methods are common locally
//   4. Description often contains specifics we can extract
//
// This is the "Google My Business" approach: auto-populate from
// public info, let owners upgrade later.
// ─── Product templates by category ─────────────────────────
const CATEGORY_PRODUCTS = {
    vegetables: [
        { name: "Poteter", category: "vegetables", seasonal: true, months: [7, 8, 9, 10], organic: false },
        { name: "Gulrøtter", category: "vegetables", seasonal: true, months: [7, 8, 9, 10], organic: false },
        { name: "Løk", category: "vegetables", seasonal: true, months: [8, 9, 10], organic: false },
        { name: "Kål", category: "vegetables", seasonal: true, months: [8, 9, 10, 11], organic: false },
        { name: "Tomater", category: "vegetables", seasonal: true, months: [7, 8, 9], organic: false },
        { name: "Salat", category: "vegetables", seasonal: true, months: [6, 7, 8, 9], organic: false },
    ],
    fruit: [
        { name: "Epler", category: "fruit", seasonal: true, months: [8, 9, 10], organic: false },
        { name: "Plommer", category: "fruit", seasonal: true, months: [8, 9], organic: false },
        { name: "Pærer", category: "fruit", seasonal: true, months: [9, 10], organic: false },
    ],
    berries: [
        { name: "Jordbær", category: "berries", seasonal: true, months: [6, 7], organic: false },
        { name: "Bringebær", category: "berries", seasonal: true, months: [7, 8], organic: false },
        { name: "Blåbær", category: "berries", seasonal: true, months: [7, 8, 9], organic: false },
    ],
    dairy: [
        { name: "Ost", category: "dairy", seasonal: false },
        { name: "Melk", category: "dairy", seasonal: false },
        { name: "Smør", category: "dairy", seasonal: false },
    ],
    eggs: [
        { name: "Frittgående egg", category: "eggs", seasonal: false },
    ],
    meat: [
        { name: "Lam", category: "meat", seasonal: true, months: [9, 10, 11, 12] },
        { name: "Storfe", category: "meat", seasonal: false },
        { name: "Svin", category: "meat", seasonal: false },
    ],
    fish: [
        { name: "Fersk fisk", category: "fish", seasonal: false },
        { name: "Røkt fisk", category: "fish", seasonal: false },
    ],
    bread: [
        { name: "Brød", category: "bread", seasonal: false },
        { name: "Bakervarer", category: "bread", seasonal: false },
    ],
    honey: [
        { name: "Lokal honning", category: "honey", seasonal: true, months: [7, 8, 9, 10] },
    ],
    herbs: [
        { name: "Friske urter", category: "herbs", seasonal: true, months: [5, 6, 7, 8, 9] },
    ],
    preserves: [
        { name: "Syltetøy", category: "preserves", seasonal: false },
        { name: "Saft", category: "preserves", seasonal: false },
    ],
};
// ─── Opening hours templates by type ──────────────────────
const OPENING_HOURS = {
    reko: [
        { day: "Varierer", open: "16:00", close: "17:00", note: "Utlevering skjer på avtalt tid og sted. Bestill via Facebook-gruppen." },
    ],
    bondens_marked: [
        { day: "saturday", open: "10:00", close: "15:00", note: "Sesongbasert — vanligvis mai til oktober. Sjekk lokale oppdateringer." },
    ],
    gardsbutikk: [
        { day: "mon", open: "10:00", close: "17:00" },
        { day: "tue", open: "10:00", close: "17:00" },
        { day: "wed", open: "10:00", close: "17:00" },
        { day: "thu", open: "10:00", close: "17:00" },
        { day: "fri", open: "10:00", close: "17:00" },
        { day: "sat", open: "10:00", close: "15:00" },
    ],
    selvbetjening: [
        { day: "Daglig", open: "06:00", close: "22:00", note: "Selvbetjent — åpent daglig. Betal med Vipps eller kontant." },
    ],
    butikk: [
        { day: "mon", open: "09:00", close: "18:00" },
        { day: "tue", open: "09:00", close: "18:00" },
        { day: "wed", open: "09:00", close: "18:00" },
        { day: "thu", open: "09:00", close: "18:00" },
        { day: "fri", open: "09:00", close: "18:00" },
        { day: "sat", open: "09:00", close: "16:00" },
    ],
};
// ─── Detect agent type from name/description ─────────────
function detectType(name, desc) {
    const n = name.toLowerCase();
    const d = desc.toLowerCase();
    if (n.includes("reko"))
        return "reko";
    if (n.includes("bondens marked") || n.includes("bondens butikk"))
        return "bondens_marked";
    if (n.includes("selvbetjen") || d.includes("self-service") || d.includes("selvbetjent") || d.includes("self-pick"))
        return "selvbetjening";
    if (n.includes("gårdsbutikk") || n.includes("gardsbutikk") || n.includes("gårdsutsalg") || n.includes("gardsutsalg") || n.includes("gårdsmat"))
        return "gardsbutikk";
    if (n.includes("ysteri") || n.includes("meieri"))
        return "gardsbutikk";
    if (n.includes("frukt") || n.includes("grønt") || n.includes("delikatesse") || n.includes("kolonial"))
        return "butikk";
    if (d.includes("farm shop") || d.includes("farmstand") || d.includes("farm") || d.includes("gård"))
        return "gardsbutikk";
    return "butikk";
}
// ─── Detect specialties from description ──────────────────
function detectSpecialties(name, desc) {
    const specialties = [];
    const text = `${name} ${desc}`.toLowerCase();
    if (text.includes("organic") || text.includes("økologisk"))
        specialties.push("Økologisk produksjon");
    if (text.includes("award") || text.includes("prisvinn"))
        specialties.push("Prisvinnende produkter");
    if (text.includes("biodynamic") || text.includes("biodynamisk"))
        specialties.push("Biodynamisk");
    if (text.includes("arctic") || text.includes("arktisk"))
        specialties.push("Arktisk mat");
    if (text.includes("cheese") || text.includes("ost") || text.includes("ysteri"))
        specialties.push("Lokal osteproduksjon");
    if (text.includes("cider") || text.includes("sider"))
        specialties.push("Cider og saft");
    if (text.includes("smoked") || text.includes("røkt") || text.includes("røgeri"))
        specialties.push("Røkt mat");
    if (text.includes("honey") || text.includes("honning"))
        specialties.push("Lokal honning");
    if (text.includes("bakery") || text.includes("bakeri") || text.includes("brød"))
        specialties.push("Hjemmebakt brød");
    if (text.includes("highland cattle") || text.includes("highland"))
        specialties.push("Highland Cattle");
    if (text.includes("goat") || text.includes("geit"))
        specialties.push("Geiteprodukter");
    return specialties;
}
// ─── Detect certifications ────────────────────────────────
function detectCertifications(desc) {
    const certs = [];
    const d = desc.toLowerCase();
    if (d.includes("organic") || d.includes("økologisk"))
        certs.push("Debio-sertifisert");
    if (d.includes("biodynamic"))
        certs.push("Demeter-sertifisert");
    return certs;
}
// ─── Get payment methods by type ─────────────────────────
function getPaymentMethods(type) {
    switch (type) {
        case "reko": return ["Vipps", "Kontant"];
        case "bondens_marked": return ["Vipps", "Kontant", "Kort"];
        case "selvbetjening": return ["Vipps", "Kontant"];
        case "gardsbutikk": return ["Vipps", "Kontant", "Kort"];
        case "butikk": return ["Kort", "Vipps", "Kontant"];
        default: return ["Vipps", "Kontant"];
    }
}
// ─── Get delivery options by type ────────────────────────
function getDeliveryOptions(type, desc) {
    const options = [];
    switch (type) {
        case "reko":
            options.push("REKO-ring utlevering", "Direktesalg");
            break;
        case "bondens_marked":
            options.push("Kjøp på markedet");
            break;
        case "selvbetjening":
            options.push("Selvbetjent henting");
            break;
        case "gardsbutikk":
            options.push("Henting i gårdsbutikk");
            break;
        case "butikk":
            options.push("Kjøp i butikk");
            break;
    }
    if (desc.toLowerCase().includes("delivery") || desc.toLowerCase().includes("levering")) {
        options.push("Lokal levering");
    }
    if (desc.toLowerCase().includes("online") || desc.toLowerCase().includes("nettbutikk")) {
        options.push("Nettbestilling");
    }
    return options;
}
// ─── Build about text ───────────────────────────────────
function buildAbout(name, desc, type, city) {
    const typeNorwegian = {
        reko: "REKO-ring",
        bondens_marked: "Bondens marked",
        gardsbutikk: "Gårdsbutikk/produsent",
        selvbetjening: "Selvbetjent utsalg",
        butikk: "Butikk",
    };
    return `${name} er en ${typeNorwegian[type] || "matprodusent"} i ${city}. ${desc}. ` +
        `Informasjonen er basert på offentlig tilgjengelige kilder og kan være utdatert. ` +
        `Kontakt selger direkte for oppdatert sortiment og priser.`;
}
// ─── Main enrichment function ───────────────────────────
function seedKnowledge() {
    const db = (0, init_1.getDb)();
    // Check if knowledge has already been seeded
    const existingCount = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
    if (existingCount > 50) {
        console.log(`   📚 Knowledge: ${existingCount} entries already exist, skipping seed`);
        return;
    }
    console.log("   📚 Enriching agent knowledge from public sources...");
    const agents = db.prepare("SELECT id, name, description, city, categories, tags FROM agents WHERE is_active = 1").all();
    const enrichments = [];
    for (const agent of agents) {
        const categories = agent.categories ? JSON.parse(agent.categories) : [];
        const tags = agent.tags ? JSON.parse(agent.tags) : [];
        const type = detectType(agent.name, agent.description);
        // Build products list from categories
        const products = [];
        for (const cat of categories) {
            const templateProducts = CATEGORY_PRODUCTS[cat];
            if (templateProducts) {
                products.push(...templateProducts.map(p => ({
                    ...p,
                    organic: tags.includes("organic") || tags.includes("økologisk"),
                })));
            }
        }
        const specialties = detectSpecialties(agent.name, agent.description);
        const certifications = detectCertifications(agent.description);
        const paymentMethods = getPaymentMethods(type);
        const deliveryOptions = getDeliveryOptions(type, agent.description);
        const openingHours = OPENING_HOURS[type] || OPENING_HOURS.butikk;
        const about = buildAbout(agent.name, agent.description, type, agent.city || "Norge");
        enrichments.push({
            agentId: agent.id,
            data: {
                openingHours,
                products,
                about,
                specialties,
                certifications,
                paymentMethods,
                deliveryOptions,
                dataSource: "auto",
                autoSources: ["lokal-registry", "rekonorge.no", "bondensmarked.no"],
            },
        });
    }
    const count = knowledge_service_1.knowledgeService.bulkEnrich(enrichments);
    console.log(`   📚 Knowledge: Enriched ${count}/${agents.length} agents`);
}
//# sourceMappingURL=seed-knowledge.js.map