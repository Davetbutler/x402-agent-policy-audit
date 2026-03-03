import { v4 as uuidv4 } from "uuid";
import type {
  Policy,
  EvaluationRequest,
  EvaluationResponse,
  DenialCode,
  Decision,
  DenialInfo,
} from "./schema.js";
import type { BudgetState } from "./budget-tracker.js";

function msUntil(isoDate: string): number {
  return new Date(isoDate).getTime() - Date.now();
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "0m";
}

function deny(
  request: EvaluationRequest,
  policy: Policy,
  code: DenialCode,
  message: string,
  constraint: string,
  opts?: { limit?: number; requested?: number; suggestion?: string }
): EvaluationResponse {
  return {
    apl_version: "0.1",
    request_id: request.request_id,
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    decision: "deny" as Decision,
    denial: {
      code,
      message,
      constraint,
      limit: opts?.limit,
      requested: opts?.requested,
      suggestion: opts?.suggestion,
    },
    audit_event_id: `evt_${uuidv4().slice(0, 8)}`,
  };
}

function denyWithReason(
  request: EvaluationRequest,
  policy: Policy,
  code: DenialCode,
  message: string,
  constraint: string,
  opts?: { limit?: number; requested?: number; suggestion?: string }
): EvaluationResponse {
  return {
    apl_version: "0.1",
    request_id: request.request_id,
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    decision: "deny_with_reason" as Decision,
    denial: {
      code,
      message,
      constraint,
      limit: opts?.limit,
      requested: opts?.requested,
      suggestion: opts?.suggestion,
    },
    audit_event_id: `evt_${uuidv4().slice(0, 8)}`,
  };
}

function escalate(
  request: EvaluationRequest,
  policy: Policy,
  denial: DenialInfo
): EvaluationResponse {
  return {
    apl_version: "0.1",
    request_id: request.request_id,
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    decision: "escalate" as Decision,
    denial,
    audit_event_id: `evt_${uuidv4().slice(0, 8)}`,
  };
}

function permit(
  request: EvaluationRequest,
  policy: Policy,
  budgetState: BudgetState,
  amount: number
): EvaluationResponse {
  const remainingAfter = budgetState.remaining - amount;
  return {
    apl_version: "0.1",
    request_id: request.request_id,
    policy_id: policy.id,
    timestamp: new Date().toISOString(),
    decision: "permit" as Decision,
    result: {
      permitted: true,
      remaining_budget: remainingAfter,
      remaining_per_period: policy.budget.per_period
        ? policy.budget.per_period.amount - budgetState.periodSpent - amount
        : undefined,
      policy_expires_in: formatDuration(msUntil(policy.validity.not_after)),
    },
    audit_event_id: `evt_${uuidv4().slice(0, 8)}`,
  };
}

/**
 * Core policy evaluation. Pure function over policy + budget state + request.
 * Returns a typed decision: permit, deny, deny_with_reason, or escalate.
 */
export function evaluate(
  policy: Policy,
  budgetState: BudgetState,
  request: EvaluationRequest,
  /** Override "now" for testing */
  now?: Date
): EvaluationResponse {
  const currentTime = now ?? new Date();
  const amount = request.action.amount;

  // 1. Time validity
  if (currentTime < new Date(policy.validity.not_before)) {
    return deny(
      request,
      policy,
      "POLICY_NOT_YET_VALID",
      `Policy is not valid until ${policy.validity.not_before}`,
      "validity.not_before"
    );
  }
  if (currentTime > new Date(policy.validity.not_after)) {
    return deny(
      request,
      policy,
      "POLICY_EXPIRED",
      `Policy expired at ${policy.validity.not_after}`,
      "validity.not_after"
    );
  }

  // 2. Action type permitted?
  const matchingPerms = policy.permissions.filter(
    (p) => p.action === request.action.type
  );
  if (matchingPerms.length === 0) {
    return deny(
      request,
      policy,
      "ACTION_NOT_PERMITTED",
      `Action type "${request.action.type}" is not permitted by this policy`,
      "permissions.action"
    );
  }

  // 3. Category permitted?
  const category = request.action.recipient.category;
  const categoryAllowed = matchingPerms.some(
    (p) => p.categories.includes("*") || p.categories.includes(category)
  );
  if (!categoryAllowed) {
    const allowed = [
      ...new Set(matchingPerms.flatMap((p) => p.categories)),
    ].join(", ");
    if (policy.escalation?.on_category_mismatch === "escalate") {
      return escalate(request, policy, {
        code: "CATEGORY_NOT_PERMITTED",
        message: `Category "${category}" is not in permitted categories [${allowed}]`,
        constraint: "permissions.categories",
        suggestion: `Use one of: ${allowed}`,
      });
    }
    return deny(
      request,
      policy,
      "CATEGORY_NOT_PERMITTED",
      `Category "${category}" is not in permitted categories [${allowed}]`,
      "permissions.categories",
      { suggestion: `Use one of: ${allowed}` }
    );
  }

  // 4. Provider permitted?
  const providersAllowed = matchingPerms.some(
    (p) =>
      p.providers.includes("*") ||
      p.providers.includes(request.action.recipient.id)
  );
  if (!providersAllowed) {
    return deny(
      request,
      policy,
      "PROVIDER_NOT_PERMITTED",
      `Provider "${request.action.recipient.id}" is not permitted`,
      "permissions.providers"
    );
  }

  // 5. Per-transaction limit
  if (amount > policy.budget.per_transaction) {
    const denial: DenialInfo = {
      code: "BUDGET_PER_TX_EXCEEDED",
      message: `Transaction amount ${amount} exceeds per-transaction limit of ${policy.budget.per_transaction}`,
      constraint: "budget.per_transaction",
      limit: policy.budget.per_transaction,
      requested: amount,
      suggestion: `Reduce amount to ${policy.budget.per_transaction} or request escalation`,
    };
    if (policy.escalation?.on_budget_exceeded === "escalate") {
      return escalate(request, policy, denial);
    }
    return denyWithReason(
      request,
      policy,
      denial.code,
      denial.message,
      denial.constraint,
      denial
    );
  }

  // 6. Total budget
  if (budgetState.spent + amount > budgetState.totalBudget) {
    const denial: DenialInfo = {
      code: "BUDGET_TOTAL_EXCEEDED",
      message: `Cumulative spend would be ${budgetState.spent + amount}, exceeding total budget of ${budgetState.totalBudget}`,
      constraint: "budget.total",
      limit: budgetState.totalBudget,
      requested: amount,
      suggestion: `Reduce amount to ${budgetState.remaining} or less`,
    };
    if (policy.escalation?.on_budget_exceeded === "escalate") {
      return escalate(request, policy, denial);
    }
    return denyWithReason(
      request,
      policy,
      denial.code,
      denial.message,
      denial.constraint,
      denial
    );
  }

  // 7. Per-period budget
  if (policy.budget.per_period) {
    const periodLimit = policy.budget.per_period.amount;
    if (budgetState.periodSpent + amount > periodLimit) {
      const denial: DenialInfo = {
        code: "BUDGET_PER_PERIOD_EXCEEDED",
        message: `Period spend would be ${budgetState.periodSpent + amount}, exceeding period limit of ${periodLimit}`,
        constraint: "budget.per_period",
        limit: periodLimit,
        requested: amount,
        suggestion: `Wait for the next period or reduce amount`,
      };
      if (policy.escalation?.on_budget_exceeded === "escalate") {
        return escalate(request, policy, denial);
      }
      return denyWithReason(
        request,
        policy,
        denial.code,
        denial.message,
        denial.constraint,
        denial
      );
    }
  }

  // 8. Escalation threshold (amount above which human approval is needed)
  if (
    policy.escalation?.approval_required_above !== undefined &&
    amount > policy.escalation.approval_required_above
  ) {
    return escalate(request, policy, {
      code: "BUDGET_PER_TX_EXCEEDED",
      message: `Amount ${amount} exceeds approval threshold of ${policy.escalation.approval_required_above}`,
      constraint: "escalation.approval_required_above",
      limit: policy.escalation.approval_required_above,
      requested: amount,
      suggestion: "Awaiting principal approval",
    });
  }

  // All checks pass
  return permit(request, policy, budgetState, amount);
}
