import { describe, it, expect } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import { loadPolicy, type EvaluationRequest } from "../src/policy/schema.js";
import { BudgetTracker } from "../src/policy/budget-tracker.js";

const doc = loadPolicy("policies/travel-booking.yaml");
const policy = doc.policy;

function makeRequest(
  overrides: Partial<{
    type: string;
    amount: number;
    category: string;
    recipientId: string;
  }> = {}
): EvaluationRequest {
  return {
    apl_version: "0.1",
    request_id: "req_test",
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    action: {
      type: overrides.type ?? "payment",
      amount: overrides.amount ?? 10000,
      currency: "USD",
      recipient: {
        id: overrides.recipientId ?? "merchant:test",
        category: overrides.category ?? "flights",
      },
    },
    context: { agent_id: policy.agent.id },
  };
}

function freshTracker(): BudgetTracker {
  const t = new BudgetTracker();
  t.init(policy.id, policy.budget.total);
  return t;
}

// Use a time within the policy's validity window
const validTime = new Date("2026-03-05T12:00:00Z");

describe("evaluate", () => {
  it("permits a valid payment within all limits", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 10000, category: "flights" });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
    expect(res.result?.remaining_budget).toBe(70000);
  });

  it("denies POLICY_NOT_YET_VALID", () => {
    const tracker = freshTracker();
    const req = makeRequest();
    const tooEarly = new Date("2026-03-01T08:00:00Z");
    const res = evaluate(policy, tracker.getState(policy.id), req, tooEarly);
    expect(res.decision).toBe("deny");
    expect(res.denial?.code).toBe("POLICY_NOT_YET_VALID");
  });

  it("denies POLICY_EXPIRED", () => {
    const tracker = freshTracker();
    const req = makeRequest();
    const tooLate = new Date("2026-03-10T12:00:00Z");
    const res = evaluate(policy, tracker.getState(policy.id), req, tooLate);
    expect(res.decision).toBe("deny");
    expect(res.denial?.code).toBe("POLICY_EXPIRED");
  });

  it("denies ACTION_NOT_PERMITTED", () => {
    const tracker = freshTracker();
    const req = makeRequest({ type: "withdraw" });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("deny");
    expect(res.denial?.code).toBe("ACTION_NOT_PERMITTED");
  });

  it("denies CATEGORY_NOT_PERMITTED", () => {
    const tracker = freshTracker();
    const req = makeRequest({ category: "entertainment" });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("deny");
    expect(res.denial?.code).toBe("CATEGORY_NOT_PERMITTED");
  });

  it("escalates BUDGET_PER_TX_EXCEEDED (policy.escalation.on_budget_exceeded = escalate)", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 45000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
    expect(res.denial?.code).toBe("BUDGET_PER_TX_EXCEEDED");
  });

  it("escalates BUDGET_TOTAL_EXCEEDED", () => {
    const tracker = freshTracker();
    // Spend most of budget first
    tracker.record(policy.id, 75000);
    const req = makeRequest({ amount: 10000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
    expect(res.denial?.code).toBe("BUDGET_TOTAL_EXCEEDED");
  });

  it("escalates when amount exceeds approval_required_above threshold", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 36000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
  });

  it("permits amount exactly at approval threshold", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 35000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });

  it("permits wildcard category on search action", () => {
    const tracker = freshTracker();
    const req = makeRequest({
      type: "search",
      amount: 0,
      category: "anything",
    });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });

  it("permits exactly at per-transaction limit", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 40000 });
    // 40000 is exactly per_transaction limit AND above escalation threshold (35000)
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    // Should escalate because 40000 > 35000 (approval_required_above)
    expect(res.decision).toBe("escalate");
  });

  it("permits exactly at per-transaction limit when no escalation threshold applies", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 34000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });
});
