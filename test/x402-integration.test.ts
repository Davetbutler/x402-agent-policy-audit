/**
 * Integration-style test: when a payment would exceed policy budget,
 * the evaluation path used by the x402 onBeforePaymentCreation hook returns deny,
 * and PolicyDeniedError would be thrown (so the inner scheme is never called).
 */

import { describe, it, expect } from "vitest";
import { loadPolicy } from "../src/policy/schema.js";
import { BudgetTracker } from "../src/policy/budget-tracker.js";
import { evaluate } from "../src/policy/engine.js";
import { PolicyDeniedError } from "../src/agentkit/policy-action-provider.js";
import type { EvaluationRequest } from "../src/policy/schema.js";

describe("x402 policy integration", () => {
  it("evaluation denies when payment would exceed remaining budget (hook would throw PolicyDeniedError)", () => {
    const doc = loadPolicy("policies/travel-booking.yaml");
    const policy = doc.policy;
    const tracker = new BudgetTracker();
    tracker.init(policy.id, policy.budget.total);
    tracker.record(policy.id, policy.budget.total);

    const request: EvaluationRequest = {
      apl_version: "0.1",
      request_id: "req_test",
      policy_id: policy.id,
      timestamp: new Date().toISOString(),
      action: {
        type: "payment",
        amount: 10000,
        currency: "USD",
        recipient: {
          id: "0x0000000000000000000000000000000000000001",
        },
      },
      context: { wallet: policy.wallets[0] },
    };

    const budgetBefore = tracker.getState(policy.id);
    const response = evaluate(policy, budgetBefore, request);

    expect(response.decision).not.toBe("permit");
    expect(response.denial?.code).toBe("BUDGET_TOTAL_EXCEEDED");

    const err = new PolicyDeniedError(response);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err.response.denial?.code).toBe("BUDGET_TOTAL_EXCEEDED");
  });
});
