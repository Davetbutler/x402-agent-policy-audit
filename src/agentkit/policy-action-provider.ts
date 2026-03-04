/**
 * PolicyEnforcedActionProvider wraps a real AgentKit ActionProvider with APL
 * policy evaluation via a remote policy server. Every action invocation is
 * intercepted, evaluated against the bound policy on the server, and only
 * forwarded if permitted.
 */

import { v4 as uuidv4 } from "uuid";
import { ActionProvider, type Action, type WalletProvider } from "@coinbase/agentkit";
import type { Network } from "@coinbase/agentkit";
import type { Policy, EvaluationRequest, EvaluationResponse } from "../policy/schema.js";
import { PolicyClient } from "../client/policy-client.js";
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
  policyClient: PolicyClient;
  /** Wallet address of the agent; must be in policy.wallets. */
  walletAddress: string;
  escalationMode?: EscalationMode;
  actionMappings?: Record<string, Partial<ActionMapping>>;
}

export class PolicyEnforcedActionProvider extends ActionProvider {
  private readonly inner: ActionProvider;
  private readonly policy: Policy;
  private readonly policyClient: PolicyClient;
  private readonly walletAddress: string;
  private readonly escalation: EscalationHandler;
  private readonly mappings: Record<string, Partial<ActionMapping>>;

  constructor(
    inner: ActionProvider,
    options: PolicyActionProviderOptions
  ) {
    super("PolicyEnforced", [inner]);
    this.inner = inner;
    this.policy = options.policy;
    this.policyClient = options.policyClient;
    this.walletAddress = options.walletAddress;
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

    const response = await this.policyClient.evaluate(this.policy.id, request);

    if (response.decision === "permit") {
      const result = await action.invoke(args);
      return result;
    }

    if (response.decision === "escalate") {
      const escalationResult = await this.escalation.handle(
        this.policy,
        response
      );

      if (escalationResult.approved) {
        const result = await action.invoke(args);
        return result;
      }

      throw new PolicyEscalationError(response);
    }

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
        },
      },
      context: {
        wallet: this.walletAddress,
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
