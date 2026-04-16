"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reservation_service_1 = require("../services/reservation-service");
const router = (0, express_1.Router)();
// POST /api/reservations — Consumer agent creates a reservation
router.post("/", (req, res) => {
    try {
        const reservation = reservation_service_1.reservationService.create(req.body);
        res.status(201).json({
            success: true,
            data: reservation,
            message: `Reservasjon opprettet hos ${reservation.producerName}. Total: ${reservation.totalAmount} kr.${reservation.savingsLabel ? ` ${reservation.savingsLabel}` : ""}`,
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/reservations/:id — Get reservation status
router.get("/:id", (req, res) => {
    const reservationId = req.params.id;
    const reservation = reservation_service_1.reservationService.get(reservationId);
    if (!reservation) {
        res.status(404).json({ success: false, error: "Reservasjon ikke funnet" });
        return;
    }
    res.json({ success: true, data: reservation });
});
// POST /api/reservations/:id/confirm — Producer confirms
router.post("/:id/confirm", (req, res) => {
    try {
        const reservationId = req.params.id;
        const reservation = reservation_service_1.reservationService.confirm(reservationId, req.body.note);
        res.json({ success: true, data: reservation, message: "Reservasjon bekreftet!" });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/reservations/:id/ready — Producer marks ready
router.post("/:id/ready", (req, res) => {
    try {
        const reservationId = req.params.id;
        const reservation = reservation_service_1.reservationService.markReady(reservationId, req.body.note);
        res.json({ success: true, data: reservation, message: "Ordren er klar for henting!" });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/reservations/:id/complete — Mark as completed
router.post("/:id/complete", (req, res) => {
    try {
        const reservationId = req.params.id;
        const reservation = reservation_service_1.reservationService.complete(reservationId);
        res.json({ success: true, data: reservation, message: "Ferdig! Takk for at du handler lokalt." });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// POST /api/reservations/:id/cancel — Cancel reservation
router.post("/:id/cancel", (req, res) => {
    try {
        const reservationId = req.params.id;
        const reservation = reservation_service_1.reservationService.cancel(reservationId, req.body.reason);
        res.json({ success: true, data: reservation, message: "Reservasjon avbrutt." });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// GET /api/reservations/producer/:id — Producer's reservations
router.get("/producer/:id", (req, res) => {
    const producerId = req.params.id;
    const reservations = reservation_service_1.reservationService.getByProducer(producerId);
    res.json({ success: true, count: reservations.length, data: reservations });
});
// GET /api/reservations/consumer/:id — Consumer's reservations
router.get("/consumer/:id", (req, res) => {
    const consumerId = req.params.id;
    const reservations = reservation_service_1.reservationService.getByConsumer(consumerId);
    res.json({ success: true, count: reservations.length, data: reservations });
});
exports.default = router;
//# sourceMappingURL=reservation.js.map