"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const services_1 = require("../services");
const router = (0, express_1.Router)();
// POST /api/producers — Register a new producer
router.post("/", (req, res) => {
    try {
        const producer = services_1.producerAgent.register(req.body);
        res.status(201).json({
            success: true,
            data: producer,
            message: `Velkommen, ${producer.name}! Din agent er aktiv.`,
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/producers/:id/products — Add a product
router.post("/:id/products", (req, res) => {
    try {
        const product = services_1.producerAgent.addProduct({
            producerId: req.params.id,
            ...req.body,
        });
        res.status(201).json({ success: true, data: product });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/producers/:id/inventory — Update live inventory
router.post("/:id/inventory", (req, res) => {
    try {
        const entry = services_1.producerAgent.updateInventory({
            producerId: req.params.id,
            ...req.body,
        });
        res.status(200).json({
            success: true,
            data: entry,
            message: "Inventar oppdatert!",
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/producers/:id — Get producer with inventory
router.get("/:id", (req, res) => {
    try {
        const data = services_1.producerAgent.getMyInventory(req.params.id);
        if (!data.producer) {
            res.status(404).json({ success: false, error: "Produsent ikke funnet" });
            return;
        }
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// POST /api/producers/:id/sold-out/:productId — Mark product as sold out
router.post("/:id/sold-out/:productId", (req, res) => {
    try {
        services_1.producerAgent.markSoldOut(req.params.productId, req.params.id);
        res.json({ success: true, message: "Merket som utsolgt" });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;
//# sourceMappingURL=producer.js.map