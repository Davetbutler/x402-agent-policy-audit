import { Router, type Request, type Response } from "express";
import type { PolicyStore } from "../store.js";

export function auditRouter(store: PolicyStore): Router {
  const router = Router();

  router.get("/:id/audit", (req: Request, res: Response) => {
    const entry = store.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }
    res.json(store.getAudit(req.params.id));
  });

  return router;
}
