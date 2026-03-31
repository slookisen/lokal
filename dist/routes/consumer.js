"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const services_1 = require("../services");
const router = (0, express_1.Router)();
// POST /api/search — Consumer agent searches for local food
// This is the PRIMARY A2A endpoint. A consumer's agent calls this.
router.post("/search", (req, res) => {
    try {
        const results = services_1.matchingEngine.search(req.body);
        res.json({
            success: true,
            count: results.length,
            data: results,
            message: results.length > 0
                ? `Fant ${results.length} lokale tilbud`
                : "Ingen treff akkurat nå. Prøv et bredere søk.",
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
exports.default = router;
//# sourceMappingURL=consumer.js.map