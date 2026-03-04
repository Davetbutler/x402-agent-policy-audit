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
      },
    },
    context: { wallet: policy.wallets[0] },
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
    const req = makeRequest({ amount: 10000 });
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

  it("denies WALLET_NOT_ALLOWED when context.wallet is not in policy.wallets", () => {
    const tracker = freshTracker();
    const req = makeRequest();
    req.context.wallet = "0x0000000000000000000000000000000000000001";
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("deny");
    expect(res.denial?.code).toBe("WALLET_NOT_ALLOWED");
  });

  it("escalates when amount exceeds max_without_approval (AMOUNT_ABOVE_APPROVAL_THRESHOLD)", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 45000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
    expect(res.denial?.code).toBe("AMOUNT_ABOVE_APPROVAL_THRESHOLD");
  });

  it("denies BUDGET_TOTAL_EXCEEDED (deny_with_reason)", () => {
    const tracker = freshTracker();
    tracker.record(policy.id, 75000);
    const req = makeRequest({ amount: 10000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("deny_with_reason");
    expect(res.denial?.code).toBe("BUDGET_TOTAL_EXCEEDED");
  });

  it("escalates when amount exceeds max_without_approval threshold", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 36000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
  });

  it("permits amount exactly at max_without_approval threshold", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 35000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });

  it("permits search action when in permissions", () => {
    const tracker = freshTracker();
    const req = makeRequest({
      type: "search",
      amount: 0,
    });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });

  it("escalates when amount above max_without_approval", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 40000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("escalate");
  });

  it("permits when amount below max_without_approval", () => {
    const tracker = freshTracker();
    const req = makeRequest({ amount: 34000 });
    const res = evaluate(policy, tracker.getState(policy.id), req, validTime);
    expect(res.decision).toBe("permit");
  });
});
