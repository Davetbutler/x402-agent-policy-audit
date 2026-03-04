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
        principal_id: "",
        agent_id: request.context.wallet ?? "",
        chain: [],
      },

      request: {
        request_id: request.request_id,
        action_type: request.action.type,
        amount: request.action.amount,
        currency: request.action.currency,
        recipient_id: request.action.recipient.id,
        recipient_category: "",
      },

      decision: {
        outcome: response.decision,
        denial_code: response.denial?.code ?? null,
        escalated_to: null,
        evaluation_duration_ms: durationMs,
      },

      budget_state: {
        total_budget: budgetBefore.totalBudget,
        spent_before: budgetBefore.spent,
        spent_after: budgetAfter.spent,
        remaining: budgetAfter.remaining,
      },

      delegation_context: {
        depth: 0,
        parent_policy_id: null,
        root_principal_id: "",
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
        principal_id: "",
        agent_id: policy.wallets[0] ?? "",
        chain: [],
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
        depth: 0,
        parent_policy_id: null,
        root_principal_id: "",
      },
      ...details,
    };

    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    return event;
  }

  /**
   * Returns all audit events. Uses the persisted file as source of truth so that
   * the webapp and API always see the full log (including events written by
   * recordSettlement in the same or another request).
   */
  getEvents(): AuditEvent[] {
    return this.getEventsFromFile();
  }

  getEventsFromFile(): AuditEvent[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as AuditEvent);
  }

  /**
   * Emits a payment_settled audit event with the on-chain transaction hash.
   * Optionally includes current budget state (e.g. from the policy's BudgetTracker).
   */
  emitPaymentSettled(
    policy: Policy,
    txHash: string,
    budgetState?: BudgetState
  ): AuditEvent {
    const budget_state = budgetState
      ? {
          total_budget: budgetState.totalBudget,
          spent_before: budgetState.spent,
          spent_after: budgetState.spent,
          remaining: budgetState.remaining,
        }
      : undefined;
    return this.emitLifecycleEvent("payment_settled", policy, {
      settlement_tx_hash: txHash,
      ...(budget_state && { budget_state }),
    });
  }

  /**
   * Emits a single payment_completed event combining evaluation (permit) and settlement.
   * Use when we have both the policy check and the on-chain tx hash.
   */
  emitPaymentCompleted(
    policy: Policy,
    request: EvaluationRequest,
    response: EvaluationResponse,
    budgetBefore: BudgetState,
    budgetAfter: BudgetState,
    durationMs: number,
    txHash: string
  ): AuditEvent {
    const event: AuditEvent = {
      apl_version: "0.1",
      event_id: response.audit_event_id || `evt_${uuidv4().slice(0, 8)}`,
      event_type: "payment_completed",
      timestamp: new Date().toISOString(),

      policy: {
        id: policy.id,
        name: policy.name,
        principal_id: "",
        agent_id: request.context.wallet ?? "",
        chain: [],
      },

      request: {
        request_id: request.request_id,
        action_type: request.action.type,
        amount: request.action.amount,
        currency: request.action.currency,
        recipient_id: request.action.recipient.id,
        recipient_category: "",
      },

      decision: {
        outcome: response.decision,
        denial_code: response.denial?.code ?? null,
        escalated_to: null,
        evaluation_duration_ms: durationMs,
      },

      budget_state: {
        total_budget: budgetBefore.totalBudget,
        spent_before: budgetBefore.spent,
        spent_after: budgetAfter.spent,
        remaining: budgetAfter.remaining,
      },

      delegation_context: {
        depth: 0,
        parent_policy_id: null,
        root_principal_id: "",
      },

      settlement_tx_hash: txHash,
    };

    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    return event;
  }

  private resolveEventType(response: EvaluationResponse): AuditEventType {
    if (response.decision === "escalate") return "escalation_requested";
    return "policy_evaluation";
  }
}
