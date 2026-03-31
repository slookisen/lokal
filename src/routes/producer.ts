import { Router, Request, Response } from "express";
import { producerAgent } from "../services";

const router = Router();

// POST /api/producers — Register a new producer
router.post("/", (req: Request, res: Response) => {
  try {
    const producer = producerAgent.register(req.body);
    res.status(201).json({
      success: true,
      data: producer,
      message: `Velkommen, ${producer.name}! Din agent er aktiv.`,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/producers/:id/products — Add a product
router.post("/:id/products", (req: Request, res: Response) => {
  try {
    const product = producerAgent.addProduct({
      producerId: req.params.id,
      ...req.body,
    });
    res.status(201).json({ success: true, data: product });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/producers/:id/inventory — Update live inventory
router.post("/:id/inventory", (req: Request, res: Response) => {
  try {
    const entry = producerAgent.updateInventory({
      producerId: req.params.id,
      ...req.body,
    });
    res.status(200).json({
      success: true,
      data: entry,
      message: "Inventar oppdatert!",
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/producers/:id — Get producer with inventory
router.get("/:id", (req: Request, res: Response) => {
  try {
    const data = producerAgent.getMyInventory(req.params.id);
    if (!data.producer) {
      res.status(404).json({ success: false, error: "Produsent ikke funnet" });
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/producers/:id/sold-out/:productId — Mark product as sold out
router.post("/:id/sold-out/:productId", (req: Request, res: Response) => {
  try {
    producerAgent.markSoldOut(req.params.productId, req.params.id);
    res.json({ success: true, message: "Merket som utsolgt" });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
