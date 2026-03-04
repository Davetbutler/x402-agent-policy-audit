import { Router, type Request, type Response } from "express";
import { EvaluationRequestSchema } from "../../policy/schema.js";
import { evaluate } from "../../policy/engine.js";
import type { PolicyStore } from "../store.js";

export function evaluateRouter(store: PolicyStore): Router {
  const router = Router();

  router.post("/:id/evaluate", (req: Request, res: Response) => {
    const entry = store.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Policy not found" });
      return;
    }

    const parseResult = EvaluationRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid evaluation request",
        details: parseResult.error.issues,
      });
      return;
    }

    const request = parseResult.data;
    const { policy, budgetTracker, auditLogger } = entry;

    budgetTracker.init(policy.id, policy.budget.total);
    const budgetBefore = budgetTracker.getState(policy.id);

    const start = performance.now();
    const response = evaluate(policy, budgetBefore, request);
    const durationMs = Math.round(performance.now() - start);

    let budgetAfter = budgetBefore;
    if (response.decision === "permit") {
      budgetAfter = budgetTracker.record(policy.id, request.action.amount);
    }

    const isPaymentPermit =
      response.decision === "permit" && request.action.type === "payment";
    if (isPaymentPermit) {
      entry.lastPermittedPayment = {
        request,
        response,
        budgetBefore,
        budgetAfter,
        durationMs,
      };
    } else {
      auditLogger.emit(policy, request, response, budgetBefore, budgetAfter, durationMs);
    }

    res.json(response);
  });

  return router;
}
