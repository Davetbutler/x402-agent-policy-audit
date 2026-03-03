import chalk from "chalk";
import type { Policy, EvaluationResponse } from "../policy/schema.js";
import type { BudgetState } from "../policy/budget-tracker.js";
import type { AuditEvent } from "../audit/types.js";

function cents(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`;
}

export function formatPolicySummary(policy: Policy): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan("=== Policy loaded ==="));
  lines.push(`  policy: ${policy.name} (${chalk.dim(policy.id)})`);
  lines.push(
    `  budget: ${chalk.green(cents(policy.budget.total))} total, ${chalk.green(cents(policy.budget.per_transaction))} per tx`
  );

  const categories = [
    ...new Set(policy.permissions.flatMap((p) => p.categories)),
  ];
  lines.push(`  categories: ${categories.join(", ")}`);

  lines.push(
    `  valid: ${policy.validity.not_before.slice(0, 10)} → ${policy.validity.not_after.slice(0, 10)}`
  );

  if (policy.escalation?.approval_required_above !== undefined) {
    lines.push(
      `  escalation threshold: ${chalk.yellow(cents(policy.escalation.approval_required_above))}`
    );
  }

  lines.push(`  principal: ${chalk.dim(policy.principal.id)}`);
  lines.push(`  agent: ${policy.agent.id}`);
  return lines.join("\n");
}

export function formatStepHeader(
  stepNum: number,
  description: string
): string {
  return chalk.bold(`\n--- Step ${stepNum}: ${description} ---`);
}

export function formatEvalDetails(
  amount: number,
  category: string,
  policy: Policy,
  budgetState: BudgetState
): string {
  const lines: string[] = [];
  lines.push(
    `  ${chalk.dim("[EVAL]")} amount=${cents(amount)}, category=${category}, per_tx_limit=${cents(policy.budget.per_transaction)}, remaining=${cents(budgetState.remaining)}`
  );
  return lines.join("\n");
}

export function formatDecision(response: EvaluationResponse): string {
  const lines: string[] = [];

  switch (response.decision) {
    case "permit":
      lines.push(
        `  ${chalk.green.bold("[PERMIT]")} within budget and category`
      );
      if (response.result) {
        lines.push(
          `  ${chalk.dim("[AUDIT]")} ${response.audit_event_id} → policy_evaluation (permit)`
        );
      }
      break;

    case "deny":
    case "deny_with_reason":
      lines.push(
        `  ${chalk.red.bold("[DENY]")} ${response.denial?.code} — ${response.denial?.message}`
      );
      lines.push(
        `  ${chalk.dim("[AUDIT]")} ${response.audit_event_id} → policy_evaluation (deny)`
      );
      if (response.denial?.suggestion) {
        lines.push(
          `  ${chalk.dim("[HINT]")} ${response.denial.suggestion}`
        );
      }
      break;

    case "escalate":
      lines.push(
        `  ${chalk.yellow.bold("[ESCALATE]")} ${response.denial?.message}`
      );
      lines.push(
        `  ${chalk.dim("[AUDIT]")} ${response.audit_event_id} → escalation_requested`
      );
      break;
  }

  return lines.join("\n");
}

export function formatBudgetDelta(
  before: BudgetState,
  after: BudgetState
): string {
  return `  Budget: ${cents(before.remaining)} → ${chalk.bold(cents(after.remaining))} remaining`;
}

export function formatEscalationResult(
  approved: boolean,
  reason?: string
): string {
  if (approved) {
    return `  ${chalk.green("(approved)")} one-time approval by principal`;
  }
  return `  ${chalk.red("(denied)")} ${reason ?? "principal denied the request"}`;
}

export function formatSummary(stats: {
  permits: number;
  denials: number;
  escalations: number;
  escalationsApproved: number;
  auditPath: string;
}): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan("\n=== Scenario complete ==="));
  lines.push(
    `  Permits: ${chalk.green(String(stats.permits))}  Denials: ${chalk.red(String(stats.denials))}  Escalations: ${chalk.yellow(`${stats.escalations} (${stats.escalationsApproved} approved)`)}`
  );
  lines.push(`  Audit log: ${chalk.dim(stats.auditPath)}`);
  return lines.join("\n");
}

export function formatAuditEvent(event: AuditEvent): string {
  const lines: string[] = [];
  const outcomeColor =
    event.decision.outcome === "permit"
      ? chalk.green
      : event.decision.outcome === "escalate" ||
          event.decision.outcome === "escalation_requested"
        ? chalk.yellow
        : chalk.red;

  lines.push(
    `${chalk.dim(event.event_id)} ${chalk.dim(event.timestamp)} ${outcomeColor(event.decision.outcome)}`
  );
  lines.push(
    `  ${event.request.action_type} ${cents(event.request.amount)} → ${event.request.recipient_id} (${event.request.recipient_category})`
  );
  lines.push(
    `  budget: ${cents(event.budget_state.spent_before)} spent → ${cents(event.budget_state.spent_after)} spent (${cents(event.budget_state.remaining)} remaining)`
  );
  if (event.decision.denial_code) {
    lines.push(`  denial: ${chalk.red(event.decision.denial_code)}`);
  }
  return lines.join("\n");
}
