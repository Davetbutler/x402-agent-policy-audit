import { readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { loadPolicy, type EvaluationRequest } from "../../policy/schema.js";
import { BudgetTracker } from "../../policy/budget-tracker.js";
import { evaluate } from "../../policy/engine.js";
import { AuditLogger } from "../../audit/logger.js";
import { formatDecision } from "../formatter.js";

export function evalAction(
  policyPath: string,
  actionJson: string,
  options: { auditPath?: string }
): void {
  const doc = loadPolicy(policyPath);
  const policy = doc.policy;

  const action = JSON.parse(
    actionJson.endsWith(".json")
      ? readFileSync(actionJson, "utf-8")
      : actionJson
  );

  const tracker = new BudgetTracker();
  tracker.init(policy.id, policy.budget.total);

  const request: EvaluationRequest = {
    apl_version: "0.1",
    request_id: `req_${uuidv4().slice(0, 8)}`,
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    action,
    context: {
      wallet: policy.wallets[0],
    },
  };

  const budgetBefore = tracker.getState(policy.id);
  const start = performance.now();
  const response = evaluate(policy, budgetBefore, request);
  const durationMs = Math.round(performance.now() - start);

  const budgetAfter =
    response.decision === "permit"
      ? tracker.record(policy.id, action.amount)
      : budgetBefore;

  const auditPath = options.auditPath ?? "audit/events.jsonl";
  const audit = new AuditLogger(auditPath);
  audit.emit(policy, request, response, budgetBefore, budgetAfter, durationMs);

  console.log(formatDecision(response));
  console.log(JSON.stringify(response, null, 2));
}
