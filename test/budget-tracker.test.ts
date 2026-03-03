import { describe, it, expect } from "vitest";
import { BudgetTracker } from "../src/policy/budget-tracker.js";

describe("BudgetTracker", () => {
  it("initialises with correct state", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    const s = t.getState("pol_1");
    expect(s.totalBudget).toBe(80000);
    expect(s.spent).toBe(0);
    expect(s.remaining).toBe(80000);
    expect(s.transactionCount).toBe(0);
  });

  it("records spend and updates remaining", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    const after = t.record("pol_1", 30000);
    expect(after.spent).toBe(30000);
    expect(after.remaining).toBe(50000);
    expect(after.transactionCount).toBe(1);
  });

  it("accumulates multiple transactions", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    t.record("pol_1", 20000);
    t.record("pol_1", 15000);
    const s = t.getState("pol_1");
    expect(s.spent).toBe(35000);
    expect(s.remaining).toBe(45000);
    expect(s.transactionCount).toBe(2);
  });

  it("detects total budget exceeded", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    t.record("pol_1", 75000);
    expect(t.wouldExceedTotal("pol_1", 10000)).toBe(true);
    expect(t.wouldExceedTotal("pol_1", 5000)).toBe(false);
  });

  it("detects period budget exceeded", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    t.record("pol_1", 40000);
    expect(t.wouldExceedPeriod("pol_1", 50000, 80000)).toBe(true);
    expect(t.wouldExceedPeriod("pol_1", 30000, 80000)).toBe(false);
  });

  it("resets period spend", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    t.record("pol_1", 50000);
    t.resetPeriod("pol_1");
    const s = t.getState("pol_1");
    expect(s.periodSpent).toBe(0);
    expect(s.spent).toBe(50000); // total spend unchanged
  });

  it("throws on unknown policy", () => {
    const t = new BudgetTracker();
    expect(() => t.getState("pol_unknown")).toThrow();
  });

  it("does not re-initialise existing policy", () => {
    const t = new BudgetTracker();
    t.init("pol_1", 80000);
    t.record("pol_1", 30000);
    t.init("pol_1", 80000); // second init should be a no-op
    expect(t.getState("pol_1").spent).toBe(30000);
  });
});
