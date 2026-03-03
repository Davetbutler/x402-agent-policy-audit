export interface BudgetState {
  policyId: string;
  totalBudget: number;
  spent: number;
  remaining: number;
  periodSpent: number;
  periodStart: string;
  transactionCount: number;
}

export class BudgetTracker {
  private state: Map<string, BudgetState> = new Map();

  init(policyId: string, totalBudget: number): void {
    if (!this.state.has(policyId)) {
      this.state.set(policyId, {
        policyId,
        totalBudget,
        spent: 0,
        remaining: totalBudget,
        periodSpent: 0,
        periodStart: new Date().toISOString(),
        transactionCount: 0,
      });
    }
  }

  getState(policyId: string): BudgetState {
    const s = this.state.get(policyId);
    if (!s) {
      throw new Error(`No budget state for policy ${policyId}`);
    }
    return { ...s };
  }

  record(policyId: string, amount: number): BudgetState {
    const s = this.state.get(policyId);
    if (!s) {
      throw new Error(`No budget state for policy ${policyId}`);
    }
    s.spent += amount;
    s.remaining = s.totalBudget - s.spent;
    s.periodSpent += amount;
    s.transactionCount += 1;
    return { ...s };
  }

  wouldExceedTotal(policyId: string, amount: number): boolean {
    const s = this.getState(policyId);
    return s.spent + amount > s.totalBudget;
  }

  wouldExceedPeriod(
    policyId: string,
    amount: number,
    periodLimit: number
  ): boolean {
    const s = this.getState(policyId);
    return s.periodSpent + amount > periodLimit;
  }

  reset(policyId: string): void {
    this.state.delete(policyId);
  }

  resetPeriod(policyId: string): void {
    const s = this.state.get(policyId);
    if (s) {
      s.periodSpent = 0;
      s.periodStart = new Date().toISOString();
    }
  }
}
