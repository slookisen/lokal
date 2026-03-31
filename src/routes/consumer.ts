import { Router, Request, Response } from "express";
import { matchingEngine } from "../services";

const router = Router();

// POST /api/search — Consumer agent searches for local food
// This is the PRIMARY A2A endpoint. A consumer's agent calls this.
router.post("/search", (req: Request, res: Response) => {
  try {
    const results = matchingEngine.search(req.body);
    res.json({
      success: true,
      count: results.length,
      data: results,
      message:
        results.length > 0
          ? `Fant ${results.length} lokale tilbud`
          : "Ingen treff akkurat nå. Prøv et bredere søk.",
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
