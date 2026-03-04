import { Router, type Request, type Response } from "express";
import { parse as parseYaml } from "yaml";
import { PolicyDocumentSchema } from "../../policy/schema.js";
import type { PolicyStore } from "../store.js";

export function policiesRouter(store: PolicyStore): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    try {
      let raw = req.body;

      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          raw = parseYaml(raw);
        }
      }

      const result = PolicyDocumentSchema.safeParse(raw);
      if (!result.success) {
        res.status(400).json({
          error: "Invalid policy document",
          details: result.error.issues,
        });
        return;
      }

      // Server always assigns id (and created) on upload; ignore any client-supplied id
      const doc = result.data;
      delete (doc.policy as { id?: string }).id;
      delete (doc.policy as { created?: string }).created;

      const entry = store.add(doc);
      res.status(201).json({
        id: entry.policy.id,
        name: entry.policy.name,
        description: entry.policy.description,
        created: entry.policy.created,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to parse policy",
      });
    }
  });

  router.get("/", (_req: Request, res: Response) => {
    res.json(store.list());
  });

  router.get("/:id", (req: Request, res: Response) => {
    const entry = store.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }
    res.json(entry.document);
  });

  router.delete("/:id", (req: Request, res: Response) => {
    const removed = store.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
