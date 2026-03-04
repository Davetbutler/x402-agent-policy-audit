import { v4 as uuidv4 } from "uuid";
import { BudgetTracker } from "../policy/budget-tracker.js";
import { AuditLogger } from "../audit/logger.js";
import type { AuditEvent } from "../audit/types.js";
import type { Policy, PolicyDocument } from "../policy/schema.js";
import type { EvaluationRequest, EvaluationResponse } from "../policy/schema.js";
import type { BudgetState } from "../policy/budget-tracker.js";

export interface LastPermittedPayment {
  request: EvaluationRequest;
  response: EvaluationResponse;
  budgetBefore: BudgetState;
  budgetAfter: BudgetState;
  durationMs: number;
}

export interface PolicyEntry {
  document: PolicyDocument;
  policy: Policy;
  budgetTracker: BudgetTracker;
  auditLogger: AuditLogger;
  /** Set when a payment action is permitted; cleared when settlement is recorded. */
  lastPermittedPayment?: LastPermittedPayment;
}

export class PolicyStore {
  private entries = new Map<string, PolicyEntry>();
  private auditDir: string;

  constructor(auditDir = "audit") {
    this.auditDir = auditDir;
  }

  add(doc: PolicyDocument): PolicyEntry {
    const raw = doc.policy;
    const policyId = raw.id ?? uuidv4();
    const created = raw.created ?? new Date().toISOString();
    const policy: Policy = {
      ...raw,
      id: policyId,
      created,
    };
    const existing = this.entries.get(policyId);
    if (existing) {
      existing.document = { ...doc, policy };
      existing.policy = policy;
      return existing;
    }
    const tracker = new BudgetTracker();
    tracker.init(policy.id, policy.budget.total);
    const audit = new AuditLogger(`${this.auditDir}/${policy.id}.jsonl`);

    const document: PolicyDocument = { ...doc, policy };
    const entry: PolicyEntry = {
      document,
      policy,
      budgetTracker: tracker,
      auditLogger: audit,
    };
    this.entries.set(policyId, entry);
    return entry;
  }

  get(id: string): PolicyEntry | undefined {
    return this.entries.get(id);
  }

  list(): Array<{
    id: string;
    name: string;
    description?: string;
    wallets: string[];
    validity: { not_before: string; not_after: string };
    budget: { total: number; currency: string; max_without_approval: number };
  }> {
    return [...this.entries.values()].map((e) => ({
      id: e.policy.id,
      name: e.policy.name,
      description: e.policy.description,
      wallets: e.policy.wallets,
      validity: e.policy.validity,
      budget: {
        total: e.policy.budget.total,
        currency: e.policy.budget.currency,
        max_without_approval: e.policy.max_without_approval,
      },
    }));
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  getAudit(id: string): AuditEvent[] {
    const entry = this.entries.get(id);
    if (!entry) return [];
    return entry.auditLogger.getEvents();
  }

  /**
   * Records a payment settlement (on-chain tx hash) in the policy's audit log.
   * If a payment was recently permitted (lastPermittedPayment), emits one combined
   * payment_completed event; otherwise emits a minimal payment_settled with current budget.
   */
  recordSettlement(id: string, txHash: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    const pending = entry.lastPermittedPayment;
    if (pending) {
      entry.auditLogger.emitPaymentCompleted(
        entry.policy,
        pending.request,
        pending.response,
        pending.budgetBefore,
        pending.budgetAfter,
        pending.durationMs,
        txHash
      );
      delete entry.lastPermittedPayment;
    } else {
      const budgetState = entry.budgetTracker.getState(entry.policy.id);
      entry.auditLogger.emitPaymentSettled(entry.policy, txHash, budgetState);
    }
    return true;
  }
}
