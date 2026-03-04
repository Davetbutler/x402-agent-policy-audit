import { v4 as uuidv4 } from "uuid";
import { loadPolicy, type EvaluationRequest } from "../../policy/schema.js";
import { BudgetTracker } from "../../policy/budget-tracker.js";
import { evaluate } from "../../policy/engine.js";
import { AuditLogger } from "../../audit/logger.js";
import { EscalationHandler } from "../../agentkit/escalation-handler.js";
import { getScenario, listScenarios } from "../scenarios/travel-booking.js";
import {
  formatPolicySummary,
  formatStepHeader,
  formatEvalDetails,
  formatDecision,
  formatBudgetDelta,
  formatEscalationResult,
  formatSummary,
} from "../formatter.js";

export async function runScenario(
  policyPath: string,
  scenarioName: string,
  options: {
    auditPath?: string;
    escalationMode?: "auto-approve" | "auto-deny" | "prompt";
  }
): Promise<void> {
  const scenario = getScenario(scenarioName);
  if (!scenario) {
    console.error(
      `Unknown scenario: "${scenarioName}". Available: ${listScenarios().join(", ")}`
    );
    process.exit(1);
  }

  const doc = loadPolicy(policyPath);
  const policy = doc.policy;

  const auditPath = options.auditPath ?? "audit/events.jsonl";
  const audit = new AuditLogger(auditPath);
  const tracker = new BudgetTracker();
  tracker.init(policy.id, policy.budget.total);

  const escalation = new EscalationHandler(
    options.escalationMode ?? "auto-approve"
  );

  console.log(formatPolicySummary(policy));
  console.log();

  let permits = 0;
  let denials = 0;
  let escalations = 0;
  let escalationsApproved = 0;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    console.log(formatStepHeader(i + 1, step.description));

    const request: EvaluationRequest = {
      apl_version: "0.1",
      request_id: `req_${uuidv4().slice(0, 8)}`,
      policy_id: step.request.policy_id,
      timestamp: new Date().toISOString(),
      action: step.request.action,
      context: {
        wallet: policy.wallets[0],
        session_id: `sess_${uuidv4().slice(0, 6)}`,
      },
    };

    const budgetBefore = tracker.getState(policy.id);
    console.log(
      formatEvalDetails(request.action.amount, policy, budgetBefore)
    );

    const start = performance.now();
    const response = evaluate(policy, budgetBefore, request);
    const durationMs = Math.round(performance.now() - start);

    console.log(formatDecision(response));

    if (response.decision === "escalate") {
      escalations++;
      const result = await escalation.handle(policy, response);
      console.log(formatEscalationResult(result.approved));

      if (result.approved) {
        escalationsApproved++;
        // Post-approval budget guard: escalation approval doesn't override hard budget limits
        if (tracker.wouldExceedTotal(policy.id, request.action.amount)) {
          console.log(formatEscalationResult(false, "approved, but total budget would be exceeded — denied"));
          audit.emit(policy, request, response, budgetBefore, budgetBefore, durationMs);
          denials++;
        } else {
          const budgetAfter = tracker.record(policy.id, request.action.amount);
          audit.emit(
            policy,
            request,
            { ...response, decision: "permit" },
            budgetBefore,
            budgetAfter,
            durationMs
          );
          console.log(formatBudgetDelta(budgetBefore, budgetAfter));
          permits++;
        }
      } else {
        audit.emit(
          policy,
          request,
          response,
          budgetBefore,
          budgetBefore,
          durationMs
        );
        denials++;
      }
    } else if (response.decision === "permit") {
      const budgetAfter = tracker.record(policy.id, request.action.amount);
      audit.emit(
        policy,
        request,
        response,
        budgetBefore,
        budgetAfter,
        durationMs
      );
      console.log(formatBudgetDelta(budgetBefore, budgetAfter));
      permits++;
    } else {
      audit.emit(
        policy,
        request,
        response,
        budgetBefore,
        budgetBefore,
        durationMs
      );
      denials++;
    }
  }

  console.log(
    formatSummary({
      permits,
      denials,
      escalations,
      escalationsApproved,
      auditPath,
    })
  );
}
