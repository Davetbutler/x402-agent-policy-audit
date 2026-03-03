/**
 * PolicyEnforcedActionProvider wraps a real AgentKit ActionProvider with APL
 * policy evaluation. Every action invocation is intercepted, evaluated against
 * the bound policy, and only forwarded if permitted.
 */

import { v4 as uuidv4 } from "uuid";
import { ActionProvider, type Action, type WalletProvider } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import type { Policy, EvaluationRequest, EvaluationResponse } from "../policy/schema.js";
import { evaluate } from "../policy/engine.js";
import { BudgetTracker, type BudgetState } from "../policy/budget-tracker.js";
import { AuditLogger } from "../audit/logger.js";
import { EscalationHandler, type EscalationMode } from "./escalation-handler.js";

// ── Policy errors ──

export class PolicyDeniedError extends Error {
  response: EvaluationResponse;

  constructor(response: EvaluationResponse) {
    const msg = response.denial
      ? `Policy denied: ${response.denial.code} — ${response.denial.message}`
      : `Policy denied action (decision: ${response.decision})`;
    super(msg);
    this.name = "PolicyDeniedError";
    this.response = response;
  }
}

export class PolicyEscalationError extends Error {
  response: EvaluationResponse;

  constructor(response: EvaluationResponse) {
    super(
      `Policy requires escalation: ${response.denial?.message ?? "approval needed"}`
    );
    this.name = "PolicyEscalationError";
    this.response = response;
  }
}

// ── Action → EvaluationRequest mapping ──

export interface ActionMapping {
  actionType: string;
  category: string;
  recipientId: string;
  amountField?: string;
  currencyField?: string;
}

const DEFAULT_ACTION_MAPPINGS: Record<string, Partial<ActionMapping>> = {
  get_wallet_details: { actionType: "search" },
  native_transfer: { actionType: "payment", amountField: "value" },
  transfer: { actionType: "payment" },
  swap: { actionType: "payment" },
  deploy_token: { actionType: "payment" },
  deploy_nft: { actionType: "payment" },
};

// ── PolicyEnforcedActionProvider ──

export interface PolicyActionProviderOptions {
  policy: Policy;
  budgetTracker: BudgetTracker;
  auditLogger: AuditLogger;
  escalationMode?: EscalationMode;
  actionMappings?: Record<string, Partial<ActionMapping>>;
}

export class PolicyEnforcedActionProvider extends ActionProvider {
  private readonly inner: ActionProvider;
  private readonly policy: Policy;
  private readonly tracker: BudgetTracker;
  private readonly audit: AuditLogger;
  private readonly escalation: EscalationHandler;
  private readonly mappings: Record<string, Partial<ActionMapping>>;

  constructor(
    inner: ActionProvider,
    options: PolicyActionProviderOptions
  ) {
    super("PolicyEnforced", [inner]);
    this.inner = inner;
    this.policy = options.policy;
    this.tracker = options.budgetTracker;
    this.audit = options.auditLogger;
    this.escalation = new EscalationHandler(
      options.escalationMode ?? "auto-deny"
    );
    this.mappings = {
      ...DEFAULT_ACTION_MAPPINGS,
      ...options.actionMappings,
    };
  }

  override getActions(walletProvider: WalletProvider): Action[] {
    const actions = this.inner.getActions(walletProvider);
    return actions.map((action) => ({
      ...action,
      invoke: async (args: unknown) => {
        return this.executeWithPolicy(action, args as Record<string, unknown>);
      },
    }));
  }

  supportsNetwork(_network: Network): boolean {
    return this.inner.supportsNetwork(_network);
  }

  private async executeWithPolicy(
    action: Action,
    args: Record<string, unknown>
  ): Promise<string> {
    const request = this.buildEvalRequest(action.name, args);
    this.tracker.init(this.policy.id, this.policy.budget.total);
    const budgetBefore = this.tracker.getState(this.policy.id);

    const start = performance.now();
    const response = evaluate(this.policy, budgetBefore, request);
    const durationMs = Math.round(performance.now() - start);

    if (response.decision === "permit") {
      const result = await action.invoke(args);
      const budgetAfter = this.tracker.record(
        this.policy.id,
        request.action.amount
      );
      this.audit.emit(
        this.policy,
        request,
        response,
        budgetBefore,
        budgetAfter,
        durationMs
      );
      return result;
    }

    if (response.decision === "escalate") {
      this.audit.emit(
        this.policy,
        request,
        response,
        budgetBefore,
        budgetBefore,
        durationMs
      );

      const escalationResult = await this.escalation.handle(
        this.policy,
        response
      );

      if (escalationResult.approved) {
        if (this.tracker.wouldExceedTotal(this.policy.id, request.action.amount)) {
          throw new PolicyDeniedError(response);
        }
        const result = await action.invoke(args);
        const budgetAfter = this.tracker.record(
          this.policy.id,
          request.action.amount
        );
        this.audit.emitLifecycleEvent("escalation_resolved", this.policy);
        return result;
      }

      throw new PolicyEscalationError(response);
    }

    this.audit.emit(
      this.policy,
      request,
      response,
      budgetBefore,
      budgetBefore,
      durationMs
    );
    throw new PolicyDeniedError(response);
  }

  private buildEvalRequest(
    actionName: string,
    args: Record<string, unknown>
  ): EvaluationRequest {
    const withoutProviderPrefix = actionName.includes("_") ? actionName.replace(/^[^_]+_/, "") : actionName;
    const mapping = this.mappings[actionName] ?? this.mappings[withoutProviderPrefix] ?? {};

    const amount = Number(
      args[mapping.amountField ?? "amount"] ?? args.value ?? 0
    );
    const currency = String(
      args[mapping.currencyField ?? "currency"] ?? this.policy.budget.currency
    );

    return {
      apl_version: "0.1",
      request_id: `req_${uuidv4().slice(0, 8)}`,
      policy_id: this.policy.id,
      timestamp: new Date().toISOString(),
      action: {
        type: mapping.actionType ?? actionName,
        amount,
        currency,
        recipient: {
          id: String(args.to ?? args.recipient ?? mapping.recipientId ?? "unknown"),
          category: String(args.category ?? mapping.category ?? "uncategorized"),
        },
      },
      context: {
        agent_id: this.policy.agent.id,
      },
    };
  }
}

// ── Convenience: wrap multiple providers ──

export function wrapWithPolicy(
  providers: ActionProvider[],
  options: PolicyActionProviderOptions
): PolicyEnforcedActionProvider[] {
  return providers.map((p) => new PolicyEnforcedActionProvider(p, options));
}
