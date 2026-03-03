import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { AuditEvent, AuditEventType } from "./types.js";
import type { Policy, EvaluationRequest, EvaluationResponse } from "../policy/schema.js";
import type { BudgetState } from "../policy/budget-tracker.js";

export class AuditLogger {
  private filePath: string;
  private events: AuditEvent[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  emit(
    policy: Policy,
    request: EvaluationRequest,
    response: EvaluationResponse,
    budgetBefore: BudgetState,
    budgetAfter: BudgetState,
    durationMs: number
  ): AuditEvent {
    const event: AuditEvent = {
      apl_version: "0.1",
      event_id: response.audit_event_id || `evt_${uuidv4().slice(0, 8)}`,
      event_type: this.resolveEventType(response),
      timestamp: response.timestamp,

      policy: {
        id: policy.id,
        name: policy.name,
        principal_id: policy.principal.id,
        agent_id: policy.agent.id,
        chain: policy.parent?.chain ?? [],
      },

      request: {
        request_id: request.request_id,
        action_type: request.action.type,
        amount: request.action.amount,
        currency: request.action.currency,
        recipient_id: request.action.recipient.id,
        recipient_category: request.action.recipient.category,
      },

      decision: {
        outcome: response.decision,
        denial_code: response.denial?.code ?? null,
        escalated_to:
          response.decision === "escalate"
            ? policy.escalation?.escalation_channel ?? null
            : null,
        evaluation_duration_ms: durationMs,
      },

      budget_state: {
        total_budget: budgetBefore.totalBudget,
        spent_before: budgetBefore.spent,
        spent_after: budgetAfter.spent,
        remaining: budgetAfter.remaining,
      },

      delegation_context: {
        depth: policy.parent?.chain?.length ?? 0,
        parent_policy_id: policy.parent?.policy_id ?? null,
        root_principal_id: policy.principal.id,
      },
    };

    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    return event;
  }

  emitLifecycleEvent(
    eventType: AuditEventType,
    policy: Policy,
    details?: Partial<AuditEvent>
  ): AuditEvent {
    const event: AuditEvent = {
      apl_version: "0.1",
      event_id: `evt_${uuidv4().slice(0, 8)}`,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      policy: {
        id: policy.id,
        name: policy.name,
        principal_id: policy.principal.id,
        agent_id: policy.agent.id,
        chain: policy.parent?.chain ?? [],
      },
      request: {
        request_id: "",
        action_type: "",
        amount: 0,
        currency: "",
        recipient_id: "",
        recipient_category: "",
      },
      decision: {
        outcome: eventType,
        denial_code: null,
        escalated_to: null,
        evaluation_duration_ms: 0,
      },
      budget_state: {
        total_budget: 0,
        spent_before: 0,
        spent_after: 0,
        remaining: 0,
      },
      delegation_context: {
        depth: policy.parent?.chain?.length ?? 0,
        parent_policy_id: policy.parent?.policy_id ?? null,
        root_principal_id: policy.principal.id,
      },
      ...details,
    };

    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    return event;
  }

  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  getEventsFromFile(): AuditEvent[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as AuditEvent);
  }

  /**
   * Emits a payment_settled audit event with the on-chain transaction hash.
   */
  emitPaymentSettled(policy: Policy, txHash: string): AuditEvent {
    return this.emitLifecycleEvent("payment_settled", policy, {
      settlement_tx_hash: txHash,
    });
  }

  private resolveEventType(response: EvaluationResponse): AuditEventType {
    if (response.decision === "escalate") return "escalation_requested";
    return "policy_evaluation";
  }
}
