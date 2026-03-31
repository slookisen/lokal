"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const vision_scanner_1 = require("../services/vision-scanner");
const vision_provider_1 = require("../services/vision-provider");
const store_1 = require("../services/store");
const router = (0, express_1.Router)();
// ─── Image/Video Upload Config ───────────────────────────────
// Producers snap a photo of their stall → prices & products detected.
const uploadDir = "/tmp/lokal-uploads";
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname);
        cb(null, `scan-${Date.now()}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max (video can be large)
    fileFilter: (_req, file, cb) => {
        const allowed = [
            "image/jpeg", "image/png", "image/webp", "image/heic",
            "video/mp4", "video/quicktime", "video/webm",
        ];
        cb(null, allowed.includes(file.mimetype));
    },
});
// POST /api/producers/:id/scan — Scan video/photos to update inventory
//
// THREE MODES:
// 1. Image upload → Vision provider analyzes → products created (REAL)
// 2. JSON with description → text-parsed into products (existing)
// 3. JSON with detectedItems → enriched and upserted (existing)
//
router.post("/:id/scan", upload.array("images", 10), async (req, res) => {
    try {
        const files = req.files;
        const hasFiles = files && files.length > 0;
        // ── MODE 1: Real image upload → Vision Provider ──────────
        if (hasFiles) {
            const imagePaths = files.map((f) => f.path);
            const mimeTypes = files.map((f) => f.mimetype);
            const producer = store_1.store.getProducer(req.params.id);
            // Get the best available vision provider
            const provider = vision_provider_1.visionProviders.getProvider();
            // Analyze with the vision provider
            const analysis = await provider.analyze({
                imagePaths,
                mimeTypes,
                producerType: producer?.type,
                hint: req.body.hint || req.body.description || undefined,
            });
            // Map Norwegian units to schema-valid units
            const unitMap = {
                kg: "kg", g: "g", stk: "piece", bunt: "bunch",
                kurv: "box", glass: "piece", "12-pk": "box",
                liter: "liter", pose: "bag", piece: "piece",
                bunch: "bunch", box: "box", bag: "bag",
            };
            // Convert vision detections → scanner format and upsert products
            const detectedItems = analysis.detections.map((d) => ({
                productName: d.productName,
                variety: d.variety,
                category: d.category,
                confidence: d.confidence,
                estimatedQuantity: d.estimatedQuantity,
                estimatedUnit: unitMap[d.estimatedUnit] || "kg",
                qualityScore: d.qualityScore,
                looksOrganic: d.looksOrganic,
                suggestedPricePerUnit: d.detectedPrice,
            }));
            const result = await vision_scanner_1.visionScanner.scanAndUpdate({
                producerId: req.params.id,
                detectedItems,
                frames: imagePaths,
                source: files.some((f) => f.mimetype.startsWith("video/")) ? "video" : "multi-photo",
            });
            res.json({
                success: true,
                data: result,
                visionProvider: provider.name,
                processingTimeMs: analysis.processingTimeMs,
                filesReceived: files.map((f) => ({
                    name: f.originalname,
                    size: `${(f.size / 1024).toFixed(1)}KB`,
                    type: f.mimetype,
                })),
                message: result.summary,
            });
            return;
        }
        // ── MODE 2 & 3: JSON body (description or detectedItems) ──
        const scanInput = {
            producerId: req.params.id,
            source: req.body.source || "photo",
        };
        if (req.body.description)
            scanInput.description = req.body.description;
        if (req.body.detectedItems)
            scanInput.detectedItems = req.body.detectedItems;
        const result = await vision_scanner_1.visionScanner.scanAndUpdate(scanInput);
        res.json({
            success: true,
            data: result,
            visionProvider: "text-input",
            filesReceived: [],
            message: result.summary,
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/producers/:id/quick-price — Quick price update via photo
// Producer photographs a price tag or writes a quick message
// Simpler than full scan — just updates prices for existing products
router.post("/:id/quick-price", async (req, res) => {
    try {
        const { updates } = req.body;
        // Expects: [{ productName: "Tomater (Cherry)", newPrice: 28 }, ...]
        if (!Array.isArray(updates) || updates.length === 0) {
            res.status(400).json({ success: false, error: "Send 'updates' array med produktnavn og ny pris" });
            return;
        }
        const result = await vision_scanner_1.visionScanner.quickPriceUpdate(req.params.id, updates);
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/products/varieties/:product
router.get("/varieties/:product", (req, res) => {
    const varieties = vision_scanner_1.visionScanner.getKnownVarieties(req.params.product);
    res.json({ success: true, product: req.params.product, varieties, count: varieties.length });
});
// GET /api/products/known
router.get("/known", (_req, res) => {
    const products = vision_scanner_1.visionScanner.getKnownProducts();
    res.json({ success: true, products, count: products.length });
});
// GET /api/products/vision-status — Which vision provider is active?
router.get("/vision-status", (_req, res) => {
    const active = vision_provider_1.visionProviders.getProvider();
    const all = vision_provider_1.visionProviders.listProviders();
    res.json({
        success: true,
        activeProvider: active.name,
        providers: all,
        howToActivate: {
            "claude-vision": "Set ANTHROPIC_API_KEY environment variable",
            "openai-vision": "Set OPENAI_API_KEY environment variable",
            "smart-mock": "Always available (no API key needed)",
        },
    });
});
exports.default = router;
//# sourceMappingURL=scan.js.map