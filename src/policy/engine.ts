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

  // 2. Requesting wallet allowed?
  const wallet = (request.context.wallet ?? "").trim().toLowerCase();
  const allowedWallets = policy.wallets.map((w) => w.trim().toLowerCase());
  if (!wallet || !allowedWallets.includes(wallet)) {
    return deny(
      request,
      policy,
      "WALLET_NOT_ALLOWED",
      `Wallet ${request.context.wallet ?? "(missing)"} is not in the policy's allowed wallets`,
      "policy.wallets"
    );
  }

  // 3. Action type permitted?
  if (!policy.permissions.includes(request.action.type)) {
    return deny(
      request,
      policy,
      "ACTION_NOT_PERMITTED",
      `Action type "${request.action.type}" is not permitted by this policy`,
      "permissions"
    );
  }

  // 4. Total budget
  if (budgetState.spent + amount > budgetState.totalBudget) {
    const denial: DenialInfo = {
      code: "BUDGET_TOTAL_EXCEEDED",
      message: `Cumulative spend would be ${budgetState.spent + amount}, exceeding total budget of ${budgetState.totalBudget}`,
      constraint: "budget.total",
      limit: budgetState.totalBudget,
      requested: amount,
      suggestion: `Reduce amount to ${budgetState.remaining} or less`,
    };
    return denyWithReason(
      request,
      policy,
      denial.code,
      denial.message,
      denial.constraint,
      denial
    );
  }

  // 5. Above max-without-approval threshold → escalate
  if (amount > policy.max_without_approval) {
    return escalate(request, policy, {
      code: "AMOUNT_ABOVE_APPROVAL_THRESHOLD",
      message: `Amount ${amount} exceeds max without approval (${policy.max_without_approval})`,
      constraint: "max_without_approval",
      limit: policy.max_without_approval,
      requested: amount,
      suggestion: "Awaiting principal approval",
    });
  }

  // All checks pass
  return permit(request, policy, budgetState, amount);
}
