import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { loadPolicy, type EvaluationRequest } from "../src/policy/schema.js";
import { BudgetTracker } from "../src/policy/budget-tracker.js";
import { evaluate } from "../src/policy/engine.js";
import { travelBookingScenario } from "../src/cli/scenarios/travel-booking.js";

const doc = loadPolicy("policies/travel-booking.yaml");
const policy = doc.policy;
const validTime = new Date("2026-03-05T12:00:00Z");

describe("travel-booking scenario (Section 7)", () => {
  it("produces correct decision sequence: permit, escalate, deny, deny", () => {
    const tracker = new BudgetTracker();
    tracker.init(policy.id, policy.budget.total);

    const decisions: string[] = [];
    const denialCodes: (string | undefined)[] = [];

    for (const step of travelBookingScenario.steps) {
      const request: EvaluationRequest = {
        apl_version: "0.1",
        request_id: `req_${uuidv4().slice(0, 8)}`,
        policy_id: step.request.policy_id,
        timestamp: new Date().toISOString(),
        action: step.request.action,
        context: { wallet: policy.wallets[0] },
      };

      const response = evaluate(
        policy,
        tracker.getState(policy.id),
        request,
        validTime
      );

      decisions.push(response.decision);
      denialCodes.push(response.denial?.code);

      // Only record spend for permits (simulating the scenario runner)
      if (response.decision === "permit") {
        tracker.record(policy.id, request.action.amount);
      }
      // For escalations that would be approved, record spend too
      if (response.decision === "escalate" && step.description.includes("Hotel")) {
        tracker.record(policy.id, request.action.amount);
      }
    }

    // Step 1: $325 flight → permit
    expect(decisions[0]).toBe("permit");
    expect(denialCodes[0]).toBeUndefined();

    // Step 2: $380 hotel → escalate (above $350 approval threshold)
    expect(decisions[1]).toBe("escalate");

    // Step 3: $200 nightclub → deny (over remaining budget: 9500 left)
    expect(decisions[2]).toBe("deny_with_reason");
    expect(denialCodes[2]).toBe("BUDGET_TOTAL_EXCEEDED");

    // Step 4: $500 flight → deny (over remaining budget)
    expect(decisions[3]).toBe("deny_with_reason");
    expect(denialCodes[3]).toBe("BUDGET_TOTAL_EXCEEDED");
  });

  it("tracks budget correctly across permitted actions", () => {
    const tracker = new BudgetTracker();
    tracker.init(policy.id, policy.budget.total);

    // Step 1: permit $325
    const req1: EvaluationRequest = {
      apl_version: "0.1",
      request_id: "req_1",
      policy_id: policy.id,
      timestamp: new Date().toISOString(),
      action: travelBookingScenario.steps[0].request.action,
      context: { wallet: policy.wallets[0] },
    };
    const res1 = evaluate(policy, tracker.getState(policy.id), req1, validTime);
    expect(res1.decision).toBe("permit");
    tracker.record(policy.id, 32500);

    const state = tracker.getState(policy.id);
    expect(state.spent).toBe(32500);
    expect(state.remaining).toBe(80000 - 32500);
  });
});
