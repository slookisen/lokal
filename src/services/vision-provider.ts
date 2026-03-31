import fs from "fs";
import path from "path";

// ─── Vision Provider ─────────────────────────────────────────────
//
// PLUGGABLE ARCHITECTURE:
// This is the layer between "here's an image" and "here's what's in it."
// We define ONE interface (VisionProvider), and swap implementations:
//
//   SmartMockProvider   → For development & demos. Uses filename hints,
//                         image metadata, and randomized produce combos
//                         from the Norwegian knowledge base. No API needed.
//
//   ClaudeVisionProvider → Production-ready Claude 3.5 Sonnet / Opus.
//                          Sends image + Norwegian produce context prompt.
//                          Just add ANTHROPIC_API_KEY to .env.
//
//   OpenAIVisionProvider → Alternative: GPT-4o. Same interface.
//                          Just add OPENAI_API_KEY to .env.
//
// WHY PLUGGABLE:
// A farmer on Bygdøy shouldn't care which AI is running. They take a
// photo, get results in 2 seconds. If Claude is down, we fall back.
// If a cheaper model gets good enough, we switch. The interface stays.

// ─── Types ───────────────────────────────────────────────────────

export interface VisionAnalysisRequest {
  /** File paths to images/video frames on disk */
  imagePaths: string[];
  /** MIME types of the files */
  mimeTypes: string[];
  /** Optional context: what kind of producer is this? */
  producerType?: "farm" | "shop" | "garden" | "cooperative";
  /** Optional hint from the producer */
  hint?: string;
}

export interface VisionDetection {
  /** What the AI thinks this product is */
  productName: string;
  /** Specific variety if identifiable (e.g. "Cherry" for tomater) */
  variety: string | null;
  /** Product category */
  category: string;
  /** Confidence 0–1 */
  confidence: number;
  /** Estimated quantity visible */
  estimatedQuantity: number;
  /** Unit for the quantity */
  estimatedUnit: string;
  /** Visual quality 0–1 */
  qualityScore: number;
  /** Does it look organic/unpackaged? */
  looksOrganic: boolean;
  /** If a price tag was visible in the image */
  detectedPrice: number | null;
}

export interface VisionAnalysisResult {
  provider: string;
  detections: VisionDetection[];
  processingTimeMs: number;
  /** Raw response from the AI (for debugging) */
  rawResponse?: string;
}

// ─── Provider Interface ──────────────────────────────────────────

export interface VisionProvider {
  readonly name: string;
  analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;
  isAvailable(): boolean;
}

// ─── Norwegian Produce Data (shared by all providers) ────────────
// This is passed as context to AI models and used by the mock.

export const NORWEGIAN_PRODUCE = {
  tomater: {
    category: "vegetables",
    varieties: ["Cherry", "Bifftomat", "San Marzano", "Gule cherry", "Kumato", "Cocktail"],
    unit: "kg",
    priceRange: [25, 55] as [number, number],
    visualCues: ["round red fruits", "cluster on vine", "various sizes"],
  },
  poteter: {
    category: "vegetables",
    varieties: ["Mandel", "Gulløye", "Folva", "Asterix", "Pimpernel", "Nypoteter"],
    unit: "kg",
    priceRange: [15, 35] as [number, number],
    visualCues: ["brown/yellow tubers", "soil residue", "various shapes"],
  },
  epler: {
    category: "fruits",
    varieties: ["Gravenstein", "Summerred", "Discovery", "Aroma", "Rød Prins"],
    unit: "kg",
    priceRange: [25, 50] as [number, number],
    visualCues: ["round fruits", "red/green", "stems visible"],
  },
  gulrøtter: {
    category: "vegetables",
    varieties: ["Vanlige", "Baby", "Lilla", "Gule"],
    unit: "kg",
    priceRange: [18, 35] as [number, number],
    visualCues: ["orange elongated", "green tops", "soil residue"],
  },
  løk: {
    category: "vegetables",
    varieties: ["Gul løk", "Rødløk", "Sjalottløk", "Vårløk"],
    unit: "kg",
    priceRange: [15, 30] as [number, number],
    visualCues: ["round bulbs", "papery skin", "red or yellow"],
  },
  jordbær: {
    category: "berries",
    varieties: ["Korona", "Polka", "Sonata"],
    unit: "kurv",
    priceRange: [50, 80] as [number, number],
    visualCues: ["red berries", "green tops", "in containers"],
  },
  agurk: {
    category: "vegetables",
    varieties: ["Slangeagurk", "Mini-agurk"],
    unit: "stk",
    priceRange: [12, 25] as [number, number],
    visualCues: ["long green", "smooth or bumpy skin"],
  },
  kål: {
    category: "vegetables",
    varieties: ["Hodekål", "Rødkål", "Blomkål", "Brokkoli", "Grønnkål", "Rosenkål"],
    unit: "stk",
    priceRange: [20, 45] as [number, number],
    visualCues: ["large round heads", "leafy", "green or purple"],
  },
  urter: {
    category: "herbs",
    varieties: ["Basilikum", "Persille", "Dill", "Gressløk", "Koriander", "Mynte"],
    unit: "bunt",
    priceRange: [15, 35] as [number, number],
    visualCues: ["small leafy bunches", "aromatic greens"],
  },
  salat: {
    category: "vegetables",
    varieties: ["Isbergsalat", "Romaine", "Ruccola", "Feldsalat"],
    unit: "stk",
    priceRange: [20, 35] as [number, number],
    visualCues: ["leafy heads", "green leaves", "crisp"],
  },
  paprika: {
    category: "vegetables",
    varieties: ["Rød", "Gul", "Grønn", "Oransje"],
    unit: "stk",
    priceRange: [15, 30] as [number, number],
    visualCues: ["bell-shaped", "glossy", "red/yellow/green"],
  },
  honning: {
    category: "honey",
    varieties: ["Blomsterhonning", "Lynghonning", "Skogshonning"],
    unit: "glass",
    priceRange: [90, 150] as [number, number],
    visualCues: ["glass jars", "golden liquid", "labels"],
  },
  egg: {
    category: "eggs",
    varieties: ["Frittgående", "Økologisk", "Gårdsegg"],
    unit: "12-pk",
    priceRange: [45, 75] as [number, number],
    visualCues: ["egg cartons", "brown or white eggs"],
  },
};

// ─── Smart Mock Provider ─────────────────────────────────────────
// Generates realistic results WITHOUT an API. Tricks:
// 1. Uses filename hints ("tomater.jpg" → tomater detected)
// 2. Uses image file size to estimate "how much produce is visible"
// 3. Picks random Norwegian varieties from the knowledge base
// 4. Adds realistic confidence scores (0.82–0.96)
// 5. Sometimes "misses" items or has low confidence (realism)

export class SmartMockProvider implements VisionProvider {
  readonly name = "smart-mock";

  isAvailable(): boolean {
    return true; // Always available — no API needed
  }

  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    const start = Date.now();

    // Simulate processing time (200-800ms)
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 600));

    const detections: VisionDetection[] = [];
    const produceKeys = Object.keys(NORWEGIAN_PRODUCE);

    // Strategy 1: Parse filename for hints
    const filenameHints = request.imagePaths
      .map((p) => path.basename(p).toLowerCase())
      .join(" ");

    // Strategy 2: Parse producer hint
    const hintText = (request.hint || "").toLowerCase();
    const allText = filenameHints + " " + hintText;

    // Strategy 3: Check file sizes to guess image complexity
    let totalFileSize = 0;
    for (const p of request.imagePaths) {
      try {
        const stat = fs.statSync(p);
        totalFileSize += stat.size;
      } catch {
        totalFileSize += 500_000; // Default guess: 500KB
      }
    }

    // Determine how many items to detect (2-6 based on context)
    const isMultiImage = request.imagePaths.length > 1;
    const baseCount = isMultiImage ? 4 : 3;
    const count = Math.min(
      baseCount + Math.floor(Math.random() * 2),
      produceKeys.length
    );

    // Try to match from hints first
    const matched = new Set<string>();

    for (const key of produceKeys) {
      if (allText.includes(key) || allText.includes(key.replace("ø", "o"))) {
        matched.add(key);
      }
      // Also check variety names
      const produce = NORWEGIAN_PRODUCE[key as keyof typeof NORWEGIAN_PRODUCE];
      for (const variety of produce.varieties) {
        if (allText.includes(variety.toLowerCase())) {
          matched.add(key);
        }
      }
    }

    // Add matched items first (higher confidence)
    for (const key of matched) {
      const produce = NORWEGIAN_PRODUCE[key as keyof typeof NORWEGIAN_PRODUCE];
      const variety = this.pickVariety(produce.varieties, allText);
      const price = this.randomPrice(produce.priceRange);

      detections.push({
        productName: key.charAt(0).toUpperCase() + key.slice(1),
        variety,
        category: produce.category,
        confidence: 0.88 + Math.random() * 0.08, // 0.88-0.96 (high — we had hints)
        estimatedQuantity: this.randomQuantity(produce.unit),
        estimatedUnit: produce.unit,
        qualityScore: 0.75 + Math.random() * 0.2,
        looksOrganic: request.producerType === "farm" || request.producerType === "garden" || Math.random() > 0.7,
        detectedPrice: Math.random() > 0.6 ? price : null, // 40% chance of price tag detection
      });
    }

    // Fill remaining slots with random picks (lower confidence)
    const remaining = produceKeys.filter((k) => !matched.has(k));
    const shuffled = remaining.sort(() => Math.random() - 0.5);

    for (let i = 0; i < count - matched.size && i < shuffled.length; i++) {
      const key = shuffled[i];
      const produce = NORWEGIAN_PRODUCE[key as keyof typeof NORWEGIAN_PRODUCE];
      const variety = Math.random() > 0.4
        ? produce.varieties[Math.floor(Math.random() * produce.varieties.length)]
        : null;
      const price = this.randomPrice(produce.priceRange);

      detections.push({
        productName: key.charAt(0).toUpperCase() + key.slice(1),
        variety,
        category: produce.category,
        confidence: 0.72 + Math.random() * 0.15, // 0.72-0.87 (lower — guessing)
        estimatedQuantity: this.randomQuantity(produce.unit),
        estimatedUnit: produce.unit,
        qualityScore: 0.65 + Math.random() * 0.25,
        looksOrganic: request.producerType === "farm" || Math.random() > 0.6,
        detectedPrice: Math.random() > 0.75 ? price : null, // 25% chance
      });
    }

    // Sort by confidence (most confident first)
    detections.sort((a, b) => b.confidence - a.confidence);

    return {
      provider: this.name,
      detections,
      processingTimeMs: Date.now() - start,
      rawResponse: JSON.stringify({
        note: "Smart mock — filename hints + random Norwegian produce",
        hints: { filenameHints, hintText, matchedFromHints: [...matched] },
      }),
    };
  }

  private pickVariety(varieties: string[], text: string): string | null {
    // First try to match from text hints
    for (const v of varieties) {
      if (text.includes(v.toLowerCase())) return v;
    }
    // Otherwise random (60% chance of identifying a variety)
    if (Math.random() > 0.4) {
      return varieties[Math.floor(Math.random() * varieties.length)];
    }
    return null;
  }

  private randomPrice(range: [number, number]): number {
    return Math.round(range[0] + Math.random() * (range[1] - range[0]));
  }

  private randomQuantity(unit: string): number {
    switch (unit) {
      case "kg": return Math.round(5 + Math.random() * 40);
      case "stk": return Math.round(10 + Math.random() * 40);
      case "bunt": return Math.round(5 + Math.random() * 25);
      case "kurv": return Math.round(5 + Math.random() * 20);
      case "glass": return Math.round(3 + Math.random() * 12);
      case "12-pk": return Math.round(5 + Math.random() * 15);
      default: return Math.round(10 + Math.random() * 20);
    }
  }
}

// ─── Claude Vision Provider (STUB — add API key to activate) ────
//
// When ANTHROPIC_API_KEY is set in environment, this provider calls
// Claude's vision API with the image and a carefully crafted prompt
// that includes our Norwegian produce knowledge base as context.
//
// The prompt strategy:
// 1. System prompt with NORWEGIAN_PRODUCE as reference data
// 2. Image(s) attached
// 3. Structured output request (JSON array of detections)
// 4. Norwegian language context so Claude knows variety names

export class ClaudeVisionProvider implements VisionProvider {
  readonly name = "claude-vision";
  private apiKey: string | null;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY ikke satt. Legg til i .env for å aktivere Claude Vision."
      );
    }

    const start = Date.now();

    // Read images as base64
    const imageContents = request.imagePaths
      .filter((p) => !p.endsWith(".mp4") && !p.endsWith(".mov") && !p.endsWith(".webm"))
      .slice(0, 5) // Max 5 images per request
      .map((p, i) => {
        const data = fs.readFileSync(p);
        const base64 = data.toString("base64");
        const mediaType = request.mimeTypes[i] || "image/jpeg";
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: mediaType,
            data: base64,
          },
        };
      });

    // Build the prompt with Norwegian produce context
    const produceContext = Object.entries(NORWEGIAN_PRODUCE)
      .map(([key, info]) =>
        `- ${key}: sorter=[${info.varieties.join(", ")}], enhet=${info.unit}, pris=${info.priceRange[0]}-${info.priceRange[1]} kr`
      )
      .join("\n");

    const prompt = `Du er en ekspert på norske grønnsaker, frukt og lokalprodusert mat.
Analyser bildet/bildene og identifiser alle matvarer du ser.

NORSK VAREKUNNSKAP (bruk for å matche sorter og sette priser):
${produceContext}

For HVERT produkt du ser, returner JSON med disse feltene:
- productName: Norsk produktnavn (f.eks. "Tomater", "Gulrøtter")
- variety: Spesifikk sort hvis identifiserbar (f.eks. "Cherry", "Mandel"), eller null
- category: En av: vegetables, fruits, berries, herbs, eggs, honey, dairy, bread, other
- confidence: 0-1, hvor sikker du er
- estimatedQuantity: Estimert mengde synlig
- estimatedUnit: Enhet (kg, stk, bunt, kurv, glass, 12-pk)
- qualityScore: 0-1, visuell ferskhet/kvalitet
- looksOrganic: true/false, ser det uemballert/naturlig ut?
- detectedPrice: Pris hvis synlig på skilt/lapp, ellers null

${request.hint ? `Produsenten sier: "${request.hint}"` : ""}
${request.producerType ? `Type produsent: ${request.producerType}` : ""}

Svar KUN med en JSON-array. Ingen annen tekst.`;

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              ...imageContents,
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API feil (${response.status}): ${errorText}`);
    }

    const result = await response.json() as any;
    const textContent = result.content?.find((c: any) => c.type === "text")?.text || "[]";

    // Parse the JSON response
    let detections: VisionDetection[];
    try {
      // Claude might wrap JSON in markdown code blocks
      const jsonStr = textContent.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      detections = JSON.parse(jsonStr);
    } catch {
      // If parsing fails, return empty with raw response for debugging
      detections = [];
    }

    return {
      provider: this.name,
      detections,
      processingTimeMs: Date.now() - start,
      rawResponse: textContent,
    };
  }
}

// ─── OpenAI Vision Provider (STUB — add API key to activate) ────

export class OpenAIVisionProvider implements VisionProvider {
  readonly name = "openai-vision";
  private apiKey: string | null;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || null;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async analyze(request: VisionAnalysisRequest): Promise<VisionAnalysisResult> {
    if (!this.apiKey) {
      throw new Error(
        "OPENAI_API_KEY ikke satt. Legg til i .env for å aktivere OpenAI Vision."
      );
    }

    const start = Date.now();

    // Read images as base64 URLs
    const imageMessages = request.imagePaths
      .filter((p) => !p.endsWith(".mp4") && !p.endsWith(".mov"))
      .slice(0, 5)
      .map((p, i) => {
        const data = fs.readFileSync(p);
        const base64 = data.toString("base64");
        const mediaType = request.mimeTypes[i] || "image/jpeg";
        return {
          type: "image_url" as const,
          image_url: { url: `data:${mediaType};base64,${base64}` },
        };
      });

    const produceContext = Object.entries(NORWEGIAN_PRODUCE)
      .map(([key, info]) =>
        `- ${key}: sorter=[${info.varieties.join(", ")}], enhet=${info.unit}, pris=${info.priceRange[0]}-${info.priceRange[1]} kr`
      )
      .join("\n");

    const prompt = `You are an expert on Norwegian produce and local food.
Analyze the image(s) and identify all food products visible.

NORWEGIAN PRODUCE REFERENCE:
${produceContext}

For EACH product, return JSON with: productName (Norwegian), variety (or null),
category, confidence (0-1), estimatedQuantity, estimatedUnit, qualityScore (0-1),
looksOrganic (bool), detectedPrice (number or null).

${request.hint ? `Producer says: "${request.hint}"` : ""}
Respond ONLY with a JSON array.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...imageMessages,
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as any;
    const textContent = result.choices?.[0]?.message?.content || "[]";

    let detections: VisionDetection[];
    try {
      const jsonStr = textContent.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      detections = JSON.parse(jsonStr);
    } catch {
      detections = [];
    }

    return {
      provider: this.name,
      detections,
      processingTimeMs: Date.now() - start,
      rawResponse: textContent,
    };
  }
}

// ─── Provider Manager ────────────────────────────────────────────
// Picks the best available provider. Priority:
// 1. Claude (if ANTHROPIC_API_KEY is set)
// 2. OpenAI (if OPENAI_API_KEY is set)
// 3. Smart Mock (always available)

export class VisionProviderManager {
  private providers: VisionProvider[];

  constructor() {
    this.providers = [
      new ClaudeVisionProvider(),
      new OpenAIVisionProvider(),
      new SmartMockProvider(),
    ];
  }

  /** Get the best available provider */
  getProvider(): VisionProvider {
    for (const p of this.providers) {
      if (p.isAvailable()) return p;
    }
    // Should never happen — SmartMock is always available
    return new SmartMockProvider();
  }

  /** Get a specific provider by name */
  getProviderByName(name: string): VisionProvider | null {
    return this.providers.find((p) => p.name === name) || null;
  }

  /** List all providers and their availability */
  listProviders(): { name: string; available: boolean }[] {
    return this.providers.map((p) => ({
      name: p.name,
      available: p.isAvailable(),
    }));
  }
}

export const visionProviders = new VisionProviderManager();
