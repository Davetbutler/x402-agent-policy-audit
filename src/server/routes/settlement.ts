import { Router, type Request, type Response } from "express";
import type { PolicyStore } from "../store.js";

export function settlementRouter(store: PolicyStore): Router {
  const router = Router();

  router.post("/:id/settlement", (req: Request, res: Response) => {
    const entry = store.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }

    const txHash =
      typeof req.body?.txHash === "string" ? req.body.txHash.trim() : "";
    if (!txHash) {
      res.status(400).json({ error: "Missing or invalid txHash in body" });
      return;
    }

    const recorded = store.recordSettlement(req.params.id, txHash);
    if (!recorded) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }

    res.status(204).end();
  });

  return router;
}
