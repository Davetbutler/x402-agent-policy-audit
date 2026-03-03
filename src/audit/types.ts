export type AuditEventType =
  | "policy_evaluation"
  | "policy_created"
  | "policy_revoked"
  | "policy_expired"
  | "policy_delegated"
  | "escalation_requested"
  | "escalation_resolved"
  | "escalation_timeout"
  | "budget_warning"
  | "funds_returned"
  | "payment_settled";

export interface AuditEvent {
  apl_version: string;
  event_id: string;
  event_type: AuditEventType;
  timestamp: string;
  /** On-chain settlement tx hash when event_type is payment_settled */
  settlement_tx_hash?: string;

  policy: {
    id: string;
    name: string;
    principal_id: string;
    agent_id: string;
    chain: string[];
  };

  request: {
    request_id: string;
    action_type: string;
    amount: number;
    currency: string;
    recipient_id: string;
    recipient_category: string;
  };

  decision: {
    outcome: string;
    denial_code: string | null;
    escalated_to: string | null;
    evaluation_duration_ms: number;
  };

  budget_state: {
    total_budget: number;
    spent_before: number;
    spent_after: number;
    remaining: number;
  };

  delegation_context: {
    depth: number;
    parent_policy_id: string | null;
    root_principal_id: string;
  };
}
