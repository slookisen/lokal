"use strict";
/**
 * Lokal Seller Agent SDK
 *
 * Gjør det enkelt for selgere å koble seg til Lokal-nettverket.
 * Agenten registrerer seg, lytter etter forespørsler fra kjøpere,
 * og svarer automatisk basert på produktkatalog og regler.
 *
 * Bruk: npx tsx seller-agent-sdk.ts (se eksempel nederst)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SellerAgent = void 0;
const LOKAL_BASE = process.env.LOKAL_URL || 'https://rettfrabonden.com';
// =============================================
// SELLER AGENT CLASS
// =============================================
class SellerAgent {
    config;
    agentId = null;
    apiKey = null;
    isRunning = false;
    activeConversations = new Map();
    respondedConversations = new Set();
    pollTimer = null;
    constructor(config) {
        this.config = {
            autoRespond: true,
            responseDelayMs: 1000,
            pollingIntervalMs: 5000,
            maxConcurrentConversations: 10,
            ...config
        };
    }
    // ---- PUBLIC API ----
    /**
     * Start agenten: registrer → lytt etter forespørsler → svar automatisk
     */
    async start() {
        console.log(`\n🟢 Starter selger-agent: ${this.config.name}`);
        console.log(`   Produkter: ${this.config.products.length}`);
        console.log(`   By: ${this.config.city}`);
        console.log(`   Kategorier: ${this.config.categories.join(', ')}\n`);
        // Step 1: Register or re-authenticate
        await this.register();
        // Step 2: Sync product inventory
        await this.syncInventory();
        // Step 3: Send initial heartbeat
        await this.heartbeat();
        // Step 4: Start polling for conversations
        this.isRunning = true;
        this.startPolling();
        // Step 5: Heartbeat every 5 minutes
        setInterval(() => this.heartbeat(), 5 * 60 * 1000);
        console.log(`✅ Agent "${this.config.name}" er online og lytter etter kjøpere\n`);
        console.log(`   Agent ID: ${this.agentId}`);
        console.log(`   A2A Card: ${LOKAL_BASE}/agents/${this.agentId}/agent.json`);
        console.log(`   Dashboard: ${LOKAL_BASE}/api/agents/${this.agentId}/metrics\n`);
    }
    /**
     * Stopp agenten
     */
    stop() {
        this.isRunning = false;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        console.log(`\n🔴 Agent "${this.config.name}" stoppet`);
    }
    /**
     * Oppdater produkttilgjengelighet i sanntid
     */
    updateProduct(productName, updates) {
        const product = this.config.products.find(p => p.name.toLowerCase() === productName.toLowerCase());
        if (product) {
            Object.assign(product, updates);
            console.log(`📦 Oppdatert: ${product.name} — ${product.available} ${product.unit} @ ${product.pricePerUnit} kr`);
            // Sync to backend
            this.syncInventory().catch(e => console.warn('Inventory sync failed:', e.message));
        }
    }
    /**
     * Marker et produkt som utsolgt
     */
    markSoldOut(productName) {
        this.updateProduct(productName, { available: 0 });
    }
    /**
     * Hent agentens nåværende metrikker
     */
    async getMetrics() {
        if (!this.agentId)
            return null;
        const res = await fetch(`${LOKAL_BASE}/api/agents/${this.agentId}/metrics`);
        return res.json();
    }
    // ---- REGISTRATION ----
    async register() {
        // If existing credentials provided, skip registration
        if (this.config.existingAgentId && this.config.existingApiKey) {
            this.agentId = this.config.existingAgentId;
            this.apiKey = this.config.existingApiKey;
            console.log(`📝 Bruker eksisterende agent: ${this.agentId}`);
            return;
        }
        console.log('📝 Registrerer agent...');
        // Build skills array from categories — Zod requires at least 1 skill
        const skills = this.config.categories.map((cat, i) => ({
            id: `sell-${cat}-${i}`,
            name: `Selge ${cat}`,
            description: `${this.config.name} tilbyr ${cat} fra ${this.config.city}. ${this.config.description}`,
            tags: [cat, ...(this.config.tags || [])]
        }));
        // Norwegian city coordinates lookup (expandable)
        const cityCoords = {
            'oslo': { lat: 59.9139, lng: 10.7522 },
            'bergen': { lat: 60.3913, lng: 5.3221 },
            'trondheim': { lat: 63.4305, lng: 10.3951 },
            'stavanger': { lat: 58.9700, lng: 5.7331 },
            'tromsø': { lat: 69.6496, lng: 18.9560 },
            'drammen': { lat: 59.7441, lng: 10.2045 },
            'fredrikstad': { lat: 59.2181, lng: 10.9298 },
            'kristiansand': { lat: 58.1599, lng: 8.0182 },
            'bodø': { lat: 67.2804, lng: 14.4049 },
            'sandefjord': { lat: 59.1314, lng: 10.2166 },
            'ålesund': { lat: 62.4722, lng: 6.1495 },
            'tønsberg': { lat: 59.2675, lng: 10.4076 },
            'moss': { lat: 59.4330, lng: 10.6590 },
            'haugesund': { lat: 59.4138, lng: 5.2680 },
            'arendal': { lat: 58.4617, lng: 8.7726 },
            'ås': { lat: 59.6608, lng: 10.7916 },
        };
        const coords = (this.config.lat && this.config.lng)
            ? { lat: this.config.lat, lng: this.config.lng }
            : cityCoords[this.config.city.toLowerCase()] || { lat: 59.9139, lng: 10.7522 }; // default Oslo
        // Construct URL — use seller's website or fallback to Lokal agent page
        const agentUrl = this.config.website || `${LOKAL_BASE}/agents/sdk-${this.config.name.toLowerCase().replace(/\s+/g, '-')}`;
        try {
            const res = await fetch(`${LOKAL_BASE}/api/marketplace/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: this.config.name,
                    description: this.config.description,
                    provider: this.config.name, // Zod: required string
                    contactEmail: this.config.contactEmail || `agent@rettfrabonden.com`, // Zod: valid email
                    url: agentUrl, // Zod: valid URL
                    skills: skills, // Zod: min 1 skill with id/name/description/tags
                    role: 'producer',
                    categories: this.config.categories,
                    tags: this.config.tags || [],
                    location: {
                        lat: coords.lat, // Zod: required number
                        lng: coords.lng, // Zod: required number
                        city: this.config.city,
                    },
                    phone: this.config.phone,
                    website: this.config.website,
                    address: this.config.address,
                    openingHours: this.config.openingHours
                })
            });
            const data = await res.json();
            if (data.success && data.data) {
                // New API response format: { success: true, data: { id, apiKey, agentCardUrl, registeredAt } }
                this.agentId = data.data.id;
                this.apiKey = data.data.apiKey;
                console.log(`   ✅ Registrert med ID: ${this.agentId}`);
                console.log(`   🔑 API Key: ${this.apiKey?.substring(0, 8)}...`);
            }
            else if (data.id && data.apiKey) {
                // Fallback: direct fields
                this.agentId = data.id;
                this.apiKey = data.apiKey;
                console.log(`   ✅ Registrert med ID: ${this.agentId}`);
            }
            else if (data.error && data.error.includes('already')) {
                console.log('   Agent finnes allerede, søker...');
                await this.findExistingAgent();
            }
            else {
                console.log('   ⚠️ Uventet respons:', JSON.stringify(data));
                this.agentId = data.id || data.agentId || data.data?.id;
                this.apiKey = data.apiKey || data.api_key || data.data?.apiKey;
                if (!this.agentId) {
                    throw new Error(`Registrering feilet: ${JSON.stringify(data)}`);
                }
            }
        }
        catch (error) {
            console.error('   ❌ Registrering feilet:', error.message);
            throw error;
        }
    }
    async findExistingAgent() {
        const res = await fetch(`${LOKAL_BASE}/api/marketplace/search?q=${encodeURIComponent(this.config.name)}`);
        const data = await res.json();
        const results = (data.results || []).map((r) => r.agent || r);
        const match = results.find((a) => a.name === this.config.name);
        if (match) {
            this.agentId = match.id;
            console.log(`   ✅ Funnet eksisterende agent: ${this.agentId}`);
        }
    }
    // ---- INVENTORY SYNC ----
    async syncInventory() {
        if (!this.agentId || !this.apiKey)
            return;
        for (const product of this.config.products) {
            try {
                await fetch(`${LOKAL_BASE}/api/marketplace/agents/${this.agentId}/listings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': this.apiKey
                    },
                    body: JSON.stringify({
                        productName: product.name,
                        category: product.category,
                        quantity: product.available,
                        unit: product.unit,
                        pricePerUnit: product.pricePerUnit,
                        isOrganic: product.organic || false,
                        deliveryOptions: product.deliveryOptions || ['pickup'],
                        description: product.description
                    })
                });
            }
            catch (e) {
                // Listing endpoint might not exist yet — that's OK
            }
        }
    }
    // ---- HEARTBEAT ----
    async heartbeat() {
        if (!this.agentId || !this.apiKey)
            return;
        try {
            await fetch(`${LOKAL_BASE}/api/marketplace/agents/${this.agentId}/heartbeat`, {
                method: 'POST',
                headers: { 'X-API-Key': this.apiKey }
            });
        }
        catch (e) {
            // Silent fail
        }
    }
    // ---- CONVERSATION POLLING ----
    startPolling() {
        const poll = async () => {
            if (!this.isRunning || !this.agentId)
                return;
            try {
                // Fetch conversations where this agent is the seller (status: open)
                const res = await fetch(`${LOKAL_BASE}/api/conversations?sellerAgentId=${this.agentId}&status=open&limit=20`);
                if (!res.ok)
                    return;
                const data = await res.json();
                const conversations = data.conversations || data || [];
                for (const conv of conversations) {
                    // Skip if already responded
                    if (this.respondedConversations.has(conv.id))
                        continue;
                    // Skip if at max concurrent
                    if (this.activeConversations.size >= (this.config.maxConcurrentConversations || 10))
                        continue;
                    // Fetch full conversation with messages
                    const fullRes = await fetch(`${LOKAL_BASE}/api/conversations/${conv.id}`);
                    const fullConv = await fullRes.json();
                    const conversation = fullConv.conversation || fullConv;
                    // Check if we've already sent a seller message
                    const sellerMessages = (conversation.messages || []).filter((m) => m.senderRole === 'seller' && m.senderAgentId === this.agentId);
                    if (sellerMessages.length > 0) {
                        this.respondedConversations.add(conv.id);
                        continue;
                    }
                    // New conversation — handle it!
                    this.activeConversations.set(conv.id, conversation);
                    await this.handleConversation(conversation);
                }
            }
            catch (error) {
                // Conversations endpoint might not fully work yet — try A2A approach
                if (error.message.includes('404') || error.message.includes('Not Found')) {
                    // Fall back to checking via A2A tasks
                    await this.pollViaTasks();
                }
            }
        };
        // Initial poll
        poll();
        // Recurring poll
        this.pollTimer = setInterval(poll, this.config.pollingIntervalMs || 5000);
    }
    async pollViaTasks() {
        if (!this.agentId)
            return;
        try {
            const res = await fetch(`${LOKAL_BASE}/a2a`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tasks/list',
                    params: { agentId: this.agentId, status: 'submitted' },
                    id: Date.now()
                })
            });
            const data = await res.json();
            if (data.result && Array.isArray(data.result)) {
                for (const task of data.result) {
                    if (this.respondedConversations.has(task.id))
                        continue;
                    await this.handleTask(task);
                }
            }
        }
        catch (e) {
            // Silent
        }
    }
    // ---- CONVERSATION HANDLING ----
    async handleConversation(conversation) {
        const query = conversation.queryText || this.extractQuery(conversation);
        if (!query) {
            this.respondedConversations.add(conversation.id);
            return;
        }
        console.log(`\n💬 Ny forespørsel fra kjøper:`);
        console.log(`   "${query}"`);
        // Find matching products
        const matches = this.findMatchingProducts(query);
        // Generate response
        let response;
        if (this.config.onQuery) {
            // Custom handler
            response = await this.config.onQuery(query, matches, conversation);
        }
        else if (this.config.autoRespond) {
            // Auto-generate response
            response = this.generateResponse(query, matches);
        }
        else {
            console.log(`   ⏸️  Manuell modus — bruk respondToConversation() for å svare`);
            return;
        }
        // Simulate human delay
        if (this.config.responseDelayMs) {
            await new Promise(r => setTimeout(r, this.config.responseDelayMs));
        }
        // Send response
        await this.sendMessage(conversation.id, response, matches.length > 0 ? 'offer' : 'text');
        this.respondedConversations.add(conversation.id);
        this.activeConversations.delete(conversation.id);
        console.log(`   ✅ Svar sendt: "${response.substring(0, 80)}..."`);
    }
    async handleTask(task) {
        const params = task.params || {};
        const query = params.query || params.message?.parts?.[0]?.text || '';
        if (!query)
            return;
        console.log(`\n💬 A2A Task: "${query}"`);
        const matches = this.findMatchingProducts(query);
        let response;
        if (this.config.onQuery) {
            response = await this.config.onQuery(query, matches, task);
        }
        else {
            response = this.generateResponse(query, matches);
        }
        // Respond via A2A
        try {
            await fetch(`${LOKAL_BASE}/a2a`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tasks/update',
                    params: {
                        taskId: task.id,
                        status: 'completed',
                        result: {
                            agentId: this.agentId,
                            agentName: this.config.name,
                            response,
                            matchedProducts: matches.map(p => ({
                                name: p.name,
                                price: `${p.pricePerUnit} kr/${p.unit}`,
                                available: `${p.available} ${p.unit}`,
                                organic: p.organic
                            }))
                        }
                    },
                    id: Date.now()
                })
            });
        }
        catch (e) {
            // Task update endpoint might not exist yet
        }
        this.respondedConversations.add(task.id);
        console.log(`   ✅ A2A svar sendt`);
    }
    /**
     * Manuelt svar på en samtale (for manuell modus)
     */
    async respondToConversation(conversationId, message, type = 'text') {
        await this.sendMessage(conversationId, message, type);
        this.respondedConversations.add(conversationId);
        this.activeConversations.delete(conversationId);
    }
    // ---- PRODUCT MATCHING ----
    findMatchingProducts(query) {
        const q = query.toLowerCase();
        const words = q.split(/\s+/);
        return this.config.products.filter(product => {
            if (product.available <= 0)
                return false;
            const searchTexts = [
                product.name.toLowerCase(),
                product.category.toLowerCase(),
                (product.description || '').toLowerCase(),
                ...(product.keywords || []).map(k => k.toLowerCase())
            ].join(' ');
            // Check if any query word matches
            return words.some(word => {
                if (word.length < 2)
                    return false;
                return searchTexts.includes(word);
            });
        }).sort((a, b) => {
            // Prioritize: available quantity, then organic, then price
            if (a.organic && !b.organic)
                return -1;
            if (!a.organic && b.organic)
                return 1;
            return b.available - a.available;
        });
    }
    // ---- RESPONSE GENERATION ----
    generateResponse(query, matches) {
        if (matches.length === 0) {
            return `Hei! Takk for forespørselen. Dessverre har ikke ${this.config.name} dette produktet akkurat nå. ` +
                `Vi tilbyr: ${this.config.products.filter(p => p.available > 0).map(p => p.name).join(', ')}. ` +
                `Kontakt oss gjerne for mer info!`;
        }
        const productList = matches.slice(0, 3).map(p => {
            let line = `• ${p.name}: ${p.pricePerUnit} kr/${p.unit}`;
            if (p.available < 999)
                line += ` (${p.available} ${p.unit} tilgjengelig)`;
            if (p.organic)
                line += ' 🌿 Økologisk';
            if (p.description)
                line += ` — ${p.description}`;
            return line;
        }).join('\n');
        const deliveryInfo = matches[0].deliveryOptions?.length
            ? `Levering: ${matches[0].deliveryOptions.join(', ')}.`
            : '';
        const contactInfo = [
            this.config.phone ? `Telefon: ${this.config.phone}` : '',
            this.config.address ? `Adresse: ${this.config.address}` : '',
            this.config.openingHours ? `Åpent: ${this.config.openingHours}` : ''
        ].filter(Boolean).join('. ');
        return `Hei fra ${this.config.name}! Vi har det du leter etter:\n\n` +
            `${productList}\n\n` +
            `${deliveryInfo} ${contactInfo}\n` +
            `Vil du bestille? Svar med antall og ønsket leveringstidspunkt.`;
    }
    // ---- HELPERS ----
    extractQuery(conversation) {
        const messages = conversation.messages || [];
        const buyerMsg = messages.find((m) => m.senderRole === 'buyer');
        const systemMsg = messages.find((m) => m.senderRole === 'system');
        return buyerMsg?.content || systemMsg?.content || '';
    }
    async sendMessage(conversationId, content, messageType) {
        try {
            await fetch(`${LOKAL_BASE}/api/conversations/${conversationId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {})
                },
                body: JSON.stringify({
                    senderRole: 'seller',
                    senderAgentId: this.agentId,
                    content,
                    messageType
                })
            });
        }
        catch (error) {
            console.warn(`   ⚠️ Kunne ikke sende melding: ${error.message}`);
        }
    }
}
exports.SellerAgent = SellerAgent;
// =============================================
// EXAMPLE: Honning-produsent i Oslo
// =============================================
if (require.main === module || process.argv[1]?.includes('seller-agent-sdk')) {
    const agent = new SellerAgent({
        name: 'Nordre Ås Bigård',
        city: 'Oslo',
        region: 'Viken',
        description: 'Økologisk birøkter på Nordre Ås med 40 bikuber. Lynghonning, sommerhonning og honningprodukter. Debio-sertifisert siden 2019.',
        categories: ['honey'],
        tags: ['organic', 'local', 'seasonal', 'handmade'],
        contactEmail: 'post@nordreaas.no',
        phone: '+47 920 12 345',
        address: 'Nordre Ås Gård, 0891 Oslo',
        website: 'https://nordreaas.no',
        openingHours: 'Man-Fre 09-17, Lør 10-14',
        products: [
            {
                name: 'Lynghonning',
                category: 'honey',
                description: 'Ren lynghonning fra Østmarka. Kraftig smak, mørk farge.',
                pricePerUnit: 189,
                unit: 'glass (500g)',
                available: 45,
                organic: true,
                seasonal: true,
                deliveryOptions: ['pickup', 'oslo-levering'],
                keywords: ['lyng', 'honning', 'mørk', 'kraftig', 'østmarka']
            },
            {
                name: 'Sommerhonning',
                category: 'honey',
                description: 'Lys og mild sommerhonning. Blanding av kløver, løvetann og frukttrær.',
                pricePerUnit: 149,
                unit: 'glass (500g)',
                available: 120,
                organic: true,
                deliveryOptions: ['pickup', 'oslo-levering', 'post'],
                keywords: ['sommer', 'honning', 'lys', 'mild', 'kløver']
            },
            {
                name: 'Bivoks-lys',
                category: 'honey',
                description: 'Håndstøpte bivokslys. Naturlig duft.',
                pricePerUnit: 89,
                unit: 'stk',
                available: 200,
                deliveryOptions: ['pickup', 'post'],
                keywords: ['bivoks', 'lys', 'stearinlys', 'voks']
            },
            {
                name: 'Honning prøvepakke',
                category: 'honey',
                description: '3x små glass (125g) — lyng, sommer, og vår-honning.',
                pricePerUnit: 199,
                unit: 'pakke',
                available: 30,
                organic: true,
                deliveryOptions: ['pickup', 'oslo-levering', 'post'],
                keywords: ['gave', 'prøve', 'smak', 'pakke', 'set']
            }
        ],
        autoRespond: true,
        responseDelayMs: 2000,
        pollingIntervalMs: 5000,
        // Optional: custom response handler
        // onQuery: async (query, products, conv) => {
        //   return `Tilpasset svar for: ${query}`;
        // }
    });
    // Start agenten
    agent.start().catch(console.error);
    // Graceful shutdown
    process.on('SIGINT', () => {
        agent.stop();
        process.exit(0);
    });
}
//# sourceMappingURL=seller-agent-sdk.js.map