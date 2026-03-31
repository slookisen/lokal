import { Router, Request, Response } from "express";
import { reservationService } from "../services/reservation-service";

const router = Router();

// POST /api/reservations — Consumer agent creates a reservation
router.post("/", (req: Request, res: Response) => {
  try {
    const reservation = reservationService.create(req.body);
    res.status(201).json({
      success: true,
      data: reservation,
      message: `Reservasjon opprettet hos ${reservation.producerName}. Total: ${reservation.totalAmount} kr.${
        reservation.savingsLabel ? ` ${reservation.savingsLabel}` : ""
      }`,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/reservations/:id — Get reservation status
router.get("/:id", (req: Request, res: Response) => {
  const reservation = reservationService.get(req.params.id);
  if (!reservation) {
    res.status(404).json({ success: false, error: "Reservasjon ikke funnet" });
    return;
  }
  res.json({ success: true, data: reservation });
});

// POST /api/reservations/:id/confirm — Producer confirms
router.post("/:id/confirm", (req: Request, res: Response) => {
  try {
    const reservation = reservationService.confirm(req.params.id, req.body.note);
    res.json({ success: true, data: reservation, message: "Reservasjon bekreftet!" });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/reservations/:id/ready — Producer marks ready
router.post("/:id/ready", (req: Request, res: Response) => {
  try {
    const reservation = reservationService.markReady(req.params.id, req.body.note);
    res.json({ success: true, data: reservation, message: "Ordren er klar for henting!" });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/reservations/:id/complete — Mark as completed
router.post("/:id/complete", (req: Request, res: Response) => {
  try {
    const reservation = reservationService.complete(req.params.id);
    res.json({ success: true, data: reservation, message: "Ferdig! Takk for at du handler lokalt." });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/reservations/:id/cancel — Cancel reservation
router.post("/:id/cancel", (req: Request, res: Response) => {
  try {
    const reservation = reservationService.cancel(req.params.id, req.body.reason);
    res.json({ success: true, data: reservation, message: "Reservasjon avbrutt." });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/reservations/producer/:id — Producer's reservations
router.get("/producer/:id", (req: Request, res: Response) => {
  const reservations = reservationService.getByProducer(req.params.id);
  res.json({ success: true, count: reservations.length, data: reservations });
});

// GET /api/reservations/consumer/:id — Consumer's reservations
router.get("/consumer/:id", (req: Request, res: Response) => {
  const reservations = reservationService.getByConsumer(req.params.id);
  res.json({ success: true, count: reservations.length, data: reservations });
});

export default router;
